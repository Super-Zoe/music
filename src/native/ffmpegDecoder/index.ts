/**
 * FFmpeg 解码器 —— RN 原生桥
 *
 * 对应 Android 侧的 fun.upup.musicfree.ffmpegDecoder.FFmpegDecoderModule.
 * 未集成原生模块（iOS / 未打入 ffmpeg / 单元测试环境）时返回空实现，
 * 由上层回退到平台原生解码，保证与上游行为一致。
 */

import { NativeModules, Platform } from "react-native";
import type {
    IFFmpegDecoderNative,
    IProbeResult,
} from "@/core/decode/types";

export interface IFFmpegDecoderNativeModule extends IFFmpegDecoderNative {
    /** ffmpeg 可执行文件是否可用 */
    isAvailable: () => Promise<boolean>;
    /** 转码任务是否已取消 */
    isCancelled: (url: string) => Promise<boolean>;
}

/** 空实现：所有能力都返回不可用，调用时抛出可识别错误 */
const unavailable: IFFmpegDecoderNativeModule = {
    async getVersion() {
        return null;
    },
    async isAvailable() {
        return false;
    },
    async isCancelled() {
        return false;
    },
    async probe() {
        return null;
    },
    async transcode() {
        throw new Error("FFmpegDecoder native module is not available");
    },
    async startStream() {
        throw new Error("FFmpegDecoder native module is not available");
    },
    async stopStream() {
        return;
    },
    async cancel() {
        return;
    },
};

const rawModule = NativeModules?.FFmpegDecoder;

/**
 * 原生模块。Android 且成功注册时为真实实现，否则为空实现。
 * 用 Proxy 包一层，避免原生端漏实现某个方法时直接 crash。
 */
function createBridge(): IFFmpegDecoderNativeModule {
    if (!rawModule) {
        return unavailable;
    }
    return new Proxy({} as IFFmpegDecoderNativeModule, {
        get(_target, prop: string) {
            const fn = (rawModule as any)[prop];
            if (typeof fn === "function") {
                return fn.bind(rawModule);
            }
            // 未实现的方法退化为不可用语义，不抛错
            return (unavailable as any)[prop];
        },
        has(_target, prop: string) {
            return prop in rawModule || prop in unavailable;
        },
    });
}

export const FFmpegDecoderNative: IFFmpegDecoderNativeModule = createBridge();

/** 快速判断：当前环境能不能用 ffmpeg */
export async function isFFmpegAvailable(): Promise<boolean> {
    if (Platform.OS !== "android") {
        return false;
    }
    try {
        return (await FFmpegDecoderNative.isAvailable()) === true;
    } catch {
        return false;
    }
}

export async function probeWithFFmpeg(url: string): Promise<IProbeResult | null> {
    try {
        return (await FFmpegDecoderNative.probe(url)) ?? null;
    } catch {
        return null;
    }
}

export default FFmpegDecoderNative;
