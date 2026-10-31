/**
 * 解码路由
 *
 * 职责：把一个"可能播不了"的音源地址，翻译成一个"播放器一定能播"的地址。
 *
 * 流程：
 *   1. decideDecodePlan 得到策略
 *   2. passthrough -> 原样返回（与上游行为完全一致）
 *   3. remux / transcode -> 查缓存，未命中则调原生端转码，产物登记进缓存
 *   4. remux 产物自检失败 -> 自动回退为完整转码
 *   5. stream -> 起本地 HTTP 流，返回 http://127.0.0.1:<port>/...
 *   6. 任何环节失败 -> 回退 passthrough，绝不阻塞原有播放链路
 *
 * 依赖全部注入，纯逻辑可单测。
 */

import { buildCacheKey } from "./cacheKey";
import {
    decideDecodePlan,
    downgradeResamplerArgs,
    getDefaultPreferences,
} from "./decodePolicy";
import type { IDeviceCapabilities } from "./decodePolicy";
import { getFormatProfile, isAlac, isDsd, normalizeExt } from "./formats";
import type {
    DecodeStrategy,
    ICacheStore,
    IDecodePlan,
    IDecodePreferences,
    IDecodeRequest,
    IDecodeResult,
    IFFmpegDecoderNative,
    IProbeResult,
} from "./types";

export interface IDecodeRouterDeps {
    /** 原生桥 */
    native: IFFmpegDecoderNative;
    /** 缓存 */
    cache: ICacheStore;
    /** 偏好读取（延迟求值，便于设置页实时生效） */
    prefs: () => IDecodePreferences;
    /** 取文件大小，用于判定是否走流式；失败返回 null */
    statSize?: (url: string) => Promise<number | null>;
    /** 设备能力 */
    capabilities?: IDeviceCapabilities;
    /** ffmpeg 可用性（延迟求值） */
    isAvailable?: () => Promise<boolean>;
    /** 日志 */
    log?: (msg: string, extra?: any) => void;
}

export interface IDecodeRouter {
    resolve(request: IDecodeRequest): Promise<IDecodeResult>;
    /** 仅探测，不做转码 */
    probe(url: string): Promise<IProbeResult | null>;
    /** 停止某个源的流式解码 */
    stopStream(url: string): Promise<void>;
    /** 取消某个源的转码 */
    cancel(url: string): Promise<void>;
    /** 清理缓存到上限以内 */
    trimCache(): Promise<void>;
}

function noop() {
    /* noop */
}

export function createDecodeRouter(deps: IDecodeRouterDeps): IDecodeRouter {
    const {
        native,
        cache,
        prefs,
        statSize,
        capabilities,
        isAvailable,
        log = noop,
    } = deps;

    async function resolvePlan(request: IDecodeRequest): Promise<IDecodePlan> {
        const ext = normalizeExt(request.fileName ?? request.url);
        const profile = getFormatProfile(ext);
        // 只有"可能需要 ffmpeg"的格式才值得付出 stat / probe 的开销
        const needProbe = profile.needsFFmpeg || isAlac(ext, request.probe);
        let probe = request.probe ?? null;
        let fileSize: number | undefined;

        if (needProbe) {
            if (!probe) {
                try {
                    probe = (await native.probe(request.url)) ?? null;
                } catch (e) {
                    log("probe 失败", e);
                }
            }
            if (statSize) {
                try {
                    const size = await statSize(request.url);
                    if (typeof size === "number") {
                        fileSize = size;
                    }
                } catch {
                    /* ignore */
                }
            }
        }

        return decideDecodePlan(
            { ...request, probe },
            prefs(),
            { fileSize, capabilities },
        );
    }

    async function runTranscode(
        request: IDecodeRequest,
        plan: IDecodePlan,
    ): Promise<IDecodeResult> {
        const key = buildCacheKey(request.url, plan.ffmpegArgs, plan.outputExt);
        const hit = await cache.get(key);
        if (hit) {
            log("解码缓存命中", { key, path: hit });
            return {
                url: `file://${hit}`,
                decoded: true,
                strategy: plan.strategy,
                fromCache: true,
                cachePath: hit,
                probe: request.probe ?? null,
            };
        }
        const target = await cache.resolve(key, plan.outputExt);
        const out = await transcodeWithFallback(
            request.url,
            plan.ffmpegArgs,
            plan.outputExt,
            target,
        );
        await cache.commit(key, out, 0);
        return {
            url: out.startsWith("file://") ? out : `file://${out}`,
            decoded: true,
            strategy: plan.strategy,
            fromCache: false,
            cachePath: out,
            probe: request.probe ?? null,
        };
    }

    async function runStream(
        request: IDecodeRequest,
        plan: IDecodePlan,
    ): Promise<IDecodeResult> {
        const url = await native.startStream(
            request.url,
            plan.ffmpegArgs,
            plan.outputExt,
        );
        return {
            url,
            decoded: true,
            strategy: "stream",
            fromCache: false,
            cachePath: null,
            probe: request.probe ?? null,
        };
    }

    /**
     * 转码，并在失败时做一次降级重试。
     *
     * 自建的 Android FFmpeg 未必带 libsoxr，`aresample=resampler=soxr` 会报错；
     * 此时换成内置重采样器再试一次，避免 DSD 因为一个可选依赖完全无法播放。
     */
    async function transcodeWithFallback(
        url: string,
        args: string[],
        outputExt: string,
        target: string,
    ): Promise<string> {
        try {
            return await native.transcode(url, args, outputExt, target);
        } catch (e) {
            const fallback = downgradeResamplerArgs(args);
            if (!fallback) {
                throw e;
            }
            log("转码失败，降级为内置重采样器重试", {
                error: String(e),
                from: args.join(" "),
                to: fallback.join(" "),
            });
            return await native.transcode(url, fallback, outputExt, target);
        }
    }

    /** remux 产物自检：能被 probe 出时长即认为可播 */
    async function verifyRemux(path: string | null): Promise<boolean> {
        if (!path) {
            return false;
        }
        try {
            const info = await native.probe(path);
            return !!info && (info.duration ?? 0) > 0;
        } catch {
            return false;
        }
    }

    return {
        async resolve(request: IDecodeRequest): Promise<IDecodeResult> {
            const preference = prefs();
            const passthrough: IDecodeResult = {
                url: request.url,
                decoded: false,
                strategy: "passthrough",
                fromCache: false,
                cachePath: null,
                probe: request.probe ?? null,
            };

            if (!preference.enabled) {
                return passthrough;
            }
            if (isAvailable) {
                try {
                    if (!(await isAvailable())) {
                        log("ffmpeg 不可用，回退原生解码");
                        return passthrough;
                    }
                } catch {
                    return passthrough;
                }
            }

            let plan: IDecodePlan;
            try {
                plan = await resolvePlan(request);
            } catch (e) {
                log("解码决策失败", e);
                return passthrough;
            }

            if (plan.strategy === "passthrough") {
                return passthrough;
            }

            log("解码计划", {
                url: request.url,
                strategy: plan.strategy,
                args: plan.ffmpegArgs,
                reason: plan.reason,
            });

            try {
                if (plan.strategy === "stream") {
                    return await runStream(request, plan);
                }
                const result = await runTranscode(request, plan);
                // remux 产物自检：平台仍解不了就退化为完整转码
                if (plan.strategy === "remux") {
                    const ok = await verifyRemux(result.cachePath);
                    if (!ok) {
                        log("remux 产物自检失败，回退完整转码", result.cachePath);
                        const fallback = decideDecodePlan(
                            { ...request, probe: request.probe ?? null, forceStrategy: "transcode" },
                            preference,
                            { capabilities },
                        );
                        return await runTranscode(request, fallback);
                    }
                }
                return result;
            } catch (e) {
                log("解码失败，回退原生播放", e);
                return passthrough;
            }
        },

        async probe(url: string): Promise<IProbeResult | null> {
            if (!prefs().enabled) {
                return null;
            }
            try {
                return (await native.probe(url)) ?? null;
            } catch (e) {
                log("probe 失败", e);
                return null;
            }
        },

        async stopStream(url: string): Promise<void> {
            try {
                await native.stopStream(url);
            } catch (e) {
                log("停止流式解码失败", e);
            }
        },

        async cancel(url: string): Promise<void> {
            try {
                await native.cancel(url);
            } catch (e) {
                log("取消转码失败", e);
            }
        },

        async trimCache(): Promise<void> {
            try {
                await cache.trim(prefs().cacheLimitBytes);
            } catch (e) {
                log("清理解码缓存失败", e);
            }
        },
    };
}

/**
 * 判断某个地址"是否需要解码扩展介入"。
 * 供本地音乐扫描、设置页等做轻量判定（不 probe）。
 */
export function needsDecode(urlOrName?: string | null): boolean {
    const ext = normalizeExt(urlOrName);
    if (!ext) {
        return false;
    }
    return getFormatProfile(ext).needsFFmpeg;
}

/** 是否为 DSD 源（供 UI 展示 DSD 标记） */
export function isDsdSource(
    urlOrName?: string | null,
    probe?: IProbeResult | null,
): boolean {
    return isDsd(normalizeExt(urlOrName), probe);
}

export { getDefaultPreferences };
export type { DecodeStrategy };
