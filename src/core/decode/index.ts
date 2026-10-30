/**
 * 解码模块装配入口
 *
 * 这一层把"原生桥 + 缓存 + 偏好 + 设备能力"组装成一个可直接使用的 router。
 * 播放链路只需要：
 *
 *   import decodeManager from "@/core/decode";
 *   const result = await decodeManager.resolve({ url, fileName });
 *
 * 结果里的 url 一定是可以交给 react-native-track-player 的地址。
 */

import DeviceInfo from "react-native-device-info";
import { stat } from "react-native-fs";

import FFmpegDecoderNative, {
    isFFmpegAvailable,
} from "@/native/ffmpegDecoder";
import { errorLog, trace } from "@/utils/log";
import PersistStatus from "@/utils/persistStatus";

import { decodeCache } from "./decodeCache";
import { createDecodeRouter, isDsdSource, needsDecode } from "./decodeRouter";
import { getDefaultPreferences } from "./decodePolicy";
import type { IDecodePreferences, IProbeResult } from "./types";

/** 读取偏好（与默认值做一次浅合并，兼容后续新增字段） */
function getPrefs(): IDecodePreferences {
    const stored = PersistStatus.get("decode.prefs");
    return { ...getDefaultPreferences(), ...(stored ?? {}) };
}

/** 写入偏好 */
function setPrefs(patch: Partial<IDecodePreferences>): IDecodePreferences {
    const next = { ...getPrefs(), ...patch };
    PersistStatus.set("decode.prefs", next);
    return next;
}

/** 本地文件大小；远端 / content:// 无法直接 stat 时返回 null */
async function statSize(url: string): Promise<number | null> {
    if (!url.startsWith("file://") && !url.startsWith("/")) {
        return null;
    }
    try {
        const p = url.startsWith("file://") ? url.slice("file://".length) : url;
        const s = await stat(decodeURIComponent(p));
        return Number((s as any)?.size ?? 0) || null;
    } catch {
        return null;
    }
}

const router = createDecodeRouter({
    native: FFmpegDecoderNative,
    cache: decodeCache,
    prefs: getPrefs,
    statSize,
    isAvailable: isFFmpegAvailable,
    capabilities: {
        get apiLevel() {
            try {
                return DeviceInfo.getApiLevel();
            } catch {
                return undefined;
            }
        },
        get alacNative() {
            try {
                return DeviceInfo.getApiLevel() >= 28;
            } catch {
                return undefined;
            }
        },
    },
    log: (msg: string, extra?: any) => trace(`[decode] ${msg}`, extra ?? ""),
});

const decodeManager = {
    /** 把源地址翻译为可播放地址 */
    resolve: router.resolve,
    /** 仅探测 */
    probe: router.probe,
    /** 停止流式解码（切歌时调用，回收 ffmpeg 进程与端口） */
    stopStream: router.stopStream,
    /** 取消转码 */
    cancel: router.cancel,
    /** 缓存清理 */
    trimCache: router.trimCache,

    getPrefs,
    setPrefs,

    /** 是否需要解码扩展介入（不 probe 的轻量判定） */
    needsDecode,
    /** 是否 DSD 源 */
    isDsdSource,

    /** ffmpeg 版本，未集成时为 null */
    async getVersion(): Promise<string | null> {
        try {
            return (await FFmpegDecoderNative.getVersion()) ?? null;
        } catch (e) {
            errorLog("获取 ffmpeg 版本失败", e);
            return null;
        }
    },

    /** 解码扩展是否可用（用于设置页展示状态） */
    isAvailable: isFFmpegAvailable,

    /** 供本地音乐扫描补全元数据：平台读不出时长时用它兜底 */
    async probeDuration(url: string): Promise<number | undefined> {
        const info: IProbeResult | null = await router.probe(url);
        return info?.duration;
    },
};

export default decodeManager;
export { getDefaultPreferences };
export type { IDecodePreferences, IProbeResult };
export { needsDecode, isDsdSource };
