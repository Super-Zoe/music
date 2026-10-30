/**
 * 解码策略决策
 *
 * 输入：格式画像 + probe 结果 + 用户偏好 + 设备能力
 * 输出：一条可执行的 IDecodePlan（策略 / ffmpeg 参数 / 输出容器 / MIME）
 *
 * 纯逻辑，不依赖 react-native，可单测。
 */

import {
    getFormatProfile,
    isAlac,
    isDsd,
    normalizeExt,
} from "./formats";
import type {
    DecodeStrategy,
    IAudioFormatProfile,
    IDecodePlan,
    IDecodePreferences,
    IDecodeRequest,
    IProbeResult,
} from "./types";

/** 设备能力：用于判断"平台原生到底能不能放" */
export interface IDeviceCapabilities {
    /** Android API Level，缺省按 28 处理 */
    apiLevel?: number;
    /** 设备是否原生支持 ALAC 解码（ExoPlayer 在 API 28+ 支持 MP4 内 ALAC） */
    alacNative?: boolean;
}

/** 默认偏好，与设置页的默认值保持一致 */
export function getDefaultPreferences(): IDecodePreferences {
    return {
        enabled: true,
        // 超过 80MB 走流式，避免长时间等待落盘
        streamThresholdBytes: 80 * 1024 * 1024,
        streamingEnabled: true,
        // DSD64 = 2822400Hz，降采样到 88.2kHz 保留 2 倍带宽；DSD128 等同样落到该值
        dsdTargetSampleRate: 88200,
        pcmBitDepth: 24,
        losslessTarget: "flac",
        cacheLimitBytes: 2 * 1024 * 1024 * 1024,
    };
}

const MIME_MAP: Record<string, string> = {
    ".wav": "audio/wav",
    ".flac": "audio/flac",
    ".m4a": "audio/mp4",
};

function pcmCodec(bitDepth: 16 | 24): string {
    return bitDepth === 24 ? "pcm_s24le" : "pcm_s16le";
}

/**
 * 设备对该格式的真实支持程度。
 * ALAC 是唯一同时依赖 API Level 与容器的格式：
 * 平台只认 MP4/M4A 容器里的 ALAC，CAF / AIFF 里的 ALAC 无论哪个版本都不支持。
 */
function resolvePlatformSupport(
    profile: IAudioFormatProfile,
    ext: string,
    capabilities: IDeviceCapabilities,
    probe: IProbeResult | null,
): IAudioFormatProfile["platformSupport"] {
    if (profile.ext !== ".alac") {
        return profile.platformSupport;
    }
    const apiLevel = capabilities.apiLevel ?? 28;
    const alacNative =
        capabilities.alacNative !== undefined
            ? capabilities.alacNative
            : apiLevel >= 28;
    if (!alacNative) {
        return "partial";
    }
    const format = (probe?.format ?? "").toLowerCase();
    const mp4Container = format
        ? /mp4|m4a|mov/.test(format)
        : ext === ".m4a" || ext === ".mp4";
    return mp4Container ? "full" : "partial";
}

/** DSD -> PCM 的转码参数 */
function dsdArgs(prefs: IDecodePreferences): string[] {
    return [
        // DSD 走 soxr 重采样，抖动整形降低量化噪声
        "-af",
        `aresample=resampler=soxr:precision=28:dither_method=shibata`,
        "-ar",
        String(prefs.dsdTargetSampleRate),
        "-c:a",
        pcmCodec(prefs.pcmBitDepth),
        "-f",
        "wav",
    ];
}

/** 非 DSD 无损源（APE / AIFF）的转码参数 */
function losslessArgs(
    prefs: IDecodePreferences,
    outputExt: string,
): string[] {
    if (outputExt === ".wav") {
        return ["-c:a", pcmCodec(prefs.pcmBitDepth), "-f", "wav"];
    }
    // FLAC：压缩等级 0，转码速度优先（解码耗时远大于体积收益）
    return ["-c:a", "flac", "-compression_level", "0", "-f", "flac"];
}

/**
 * 决策入口。
 *
 * @param request 解码请求（含 url、可选的 probe 结果）
 * @param prefs 用户偏好
 * @param options.fileSize 文件字节数，用于判定是否走流式
 * @param options.capabilities 设备能力
 */
export function decideDecodePlan(
    request: IDecodeRequest,
    prefs: IDecodePreferences = getDefaultPreferences(),
    options: {
        fileSize?: number;
        capabilities?: IDeviceCapabilities;
    } = {},
): IDecodePlan {
    const fileName = request.fileName ?? request.url;
    const ext = normalizeExt(fileName);
    const probe = request.probe ?? null;
    const fileSize = options.fileSize ?? 0;
    const capabilities = options.capabilities ?? {};

    // 扩展名可能骗人（.m4a 里装 ALAC），以 probe 结果修正画像
    let profile = getFormatProfile(ext);
    if (isAlac(ext, probe) && profile.ext !== ".alac") {
        profile = getFormatProfile(".alac");
    }
    const support = resolvePlatformSupport(profile, ext, capabilities, probe);

    // 1. 总开关关闭：完全保持上游行为
    if (!prefs.enabled) {
        return plan("passthrough", profile, ext, [], `解码扩展已关闭，回退平台原生解码`);
    }

    // 2. 强制策略优先于一切自动判定（调试 / 设置页手动指定）
    if (request.forceStrategy) {
        return buildPlanByStrategy(
            request.forceStrategy,
            profile,
            prefs,
            `强制策略 ${request.forceStrategy}`,
        );
    }

    // 3. 平台完全支持且不是隐藏的 ALAC
    if (support === "full" && !profile.needsFFmpeg) {
        return plan(
            "passthrough",
            profile,
            ext,
            [],
            `${ext || "该格式"} 平台原生支持，无需 ffmpeg`,
        );
    }

    // 4. 流式解码：移动网络受限时不额外起长连接下载任务
    const canStream = prefs.streamingEnabled && !request.networkLimited;

    const dsd = isDsd(ext, probe);

    // 5. DSD：平台永远不支持，必须解码；文件通常很大，默认流式
    if (dsd) {
        const strategy: DecodeStrategy =
            canStream && (fileSize === 0 || fileSize > prefs.streamThresholdBytes)
                ? "stream"
                : "transcode";
        return {
            ...buildPlanByStrategy(strategy, profile, prefs, ""),
            reason: `${profile.container} 为 DSD 源，平台无解码器，${strategy === "stream" ? "边转边播" : "转码为 PCM 后播放"}`,
        };
    }

    // 6. ALAC：优先 remux（无损且极快），失败由 decodeRouter 回退到 transcode
    if (profile.ext === ".alac") {
        if (support === "partial") {
            const remuxable = canRemuxToMp4(probe);
            if (remuxable) {
                return {
                    strategy: "remux",
                    profile,
                    outputExt: ".m4a",
                    outputMime: MIME_MAP[".m4a"],
                    ffmpegArgs: ["-c:a", "copy", "-f", "ipod"],
                    streaming: false,
                    reason: "ALAC 平台支持不完整，重封装为 M4A 后交给原生解码器",
                };
            }
            const strategy: DecodeStrategy =
                canStream && fileSize > prefs.streamThresholdBytes
                    ? "stream"
                    : "transcode";
            return {
                ...buildPlanByStrategy(strategy, profile, prefs, ""),
                reason: `ALAC 无法无损重封装（容器 ${profile.container}），${strategy === "stream" ? "边转边播" : "转码后播放"}`,
            };
        }
        return plan("passthrough", profile, ext, [], "设备原生支持 ALAC，直接播放");
    }

    // 7. APE / AIFF 等平台不支持或有损兼容的无损源
    const outputExt = prefs.losslessTarget === "wav" ? ".wav" : ".flac";
    const strategy: DecodeStrategy =
        canStream && fileSize > prefs.streamThresholdBytes ? "stream" : "transcode";
    return {
        strategy,
        profile,
        outputExt,
        outputMime: MIME_MAP[outputExt],
        ffmpegArgs: losslessArgs(prefs, outputExt),
        streaming: strategy === "stream",
        reason: `${profile.codec} 平台无解码器，转码为 ${outputExt} 后播放`,
    };
}

/** 按策略名构造计划（DSD 强制输出 wav） */
function buildPlanByStrategy(
    strategy: DecodeStrategy,
    profile: IAudioFormatProfile,
    prefs: IDecodePreferences,
    reason: string,
): IDecodePlan {
    if (strategy === "passthrough") {
        return plan("passthrough", profile, profile.ext, [], reason || "直接播放");
    }
    if (strategy === "remux") {
        return {
            strategy: "remux",
            profile,
            outputExt: ".m4a",
            outputMime: MIME_MAP[".m4a"],
            ffmpegArgs: ["-c:a", "copy", "-f", "ipod"],
            streaming: false,
            reason: reason || "重封装为 M4A",
        };
    }
    const outputExt = profile.dsd
        ? ".wav"
        : prefs.losslessTarget === "wav"
            ? ".wav"
            : ".flac";
    return {
        strategy,
        profile,
        outputExt,
        outputMime: MIME_MAP[outputExt],
        ffmpegArgs: profile.dsd
            ? dsdArgs(prefs)
            : losslessArgs(prefs, outputExt),
        streaming: strategy === "stream",
        reason: reason || `转码为 ${outputExt}`,
    };
}

function plan(
    strategy: DecodeStrategy,
    profile: IAudioFormatProfile,
    ext: string,
    ffmpegArgs: string[],
    reason: string,
): IDecodePlan {
    return {
        strategy,
        profile,
        outputExt: ext || profile.ext,
        outputMime: MIME_MAP[ext] ?? MIME_MAP[profile.ext] ?? "audio/*",
        ffmpegArgs,
        streaming: strategy === "stream",
        reason,
    };
}

/** ALAC 能否无损重封装进 MP4：CAF/MP4 里的 ALAC 都可以，纯裸流不行 */
function canRemuxToMp4(probe: IProbeResult | null): boolean {
    if (!probe) {
        // 没有 probe 结果时按扩展名乐观尝试，失败再由路由回退
        return true;
    }
    const fmt = (probe.format ?? "").toLowerCase();
    if (!fmt) {
        return true;
    }
    return fmt.includes("mp4") || fmt.includes("m4a") || fmt.includes("caf") || fmt.includes("mov");
}
