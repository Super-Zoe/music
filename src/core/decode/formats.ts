/**
 * 音频格式注册表
 *
 * 只描述"静态事实"：某个扩展名是什么容器、什么编码、Android 平台能不能直接放。
 * 具体"该用什么策略解"交给 decodePolicy.ts，方便单独测试。
 *
 * 纯逻辑，不依赖 react-native。
 */

import type { IAudioFormatProfile, IProbeResult } from "./types";

/** 扩展名 -> 格式画像 */
const FORMAT_TABLE: Record<string, Omit<IAudioFormatProfile, "ext">> = {
    // ---------- 本次新增支持的四种格式 ----------
    ".alac": {
        container: "CAF / MP4(M4A)",
        codec: "alac",
        lossless: true,
        dsd: false,
        // Android 9+ 的 ExoPlayer 对 MP4 内的 ALAC 有解码器，但 CAF 容器与
        // 部分 ROM 的 MediaPlayer 不支持，因此按 partial 处理：先尝试 remux。
        platformSupport: "partial",
        ffmpeg: { demuxer: "caf / mov,mp4,m4a", decoder: "alac" },
        needsFFmpeg: true,
    },
    ".ape": {
        container: "APE (Monkey's Audio)",
        codec: "ape",
        lossless: true,
        dsd: false,
        // 平台完全不支持，必须转码
        platformSupport: "none",
        ffmpeg: { demuxer: "ape", decoder: "ape" },
        needsFFmpeg: true,
    },
    ".dsf": {
        container: "DSF (Sony DSD Storage Facility)",
        codec: "dsd_lsbf",
        lossless: true,
        dsd: true,
        platformSupport: "none",
        ffmpeg: { demuxer: "dsf", decoder: "dsd_lsbf / dsd_lsbf_planar" },
        needsFFmpeg: true,
    },
    ".dff": {
        container: "DFF (Philips DSDIFF)",
        codec: "dsd_msbf",
        lossless: true,
        dsd: true,
        platformSupport: "none",
        ffmpeg: { demuxer: "dff", decoder: "dsd_msbf / dsd_msbf_planar" },
        needsFFmpeg: true,
    },

    // ---------- 上游已支持 / 顺带纳入的格式 ----------
    ".aiff": {
        container: "AIFF",
        codec: "pcm_s16be",
        lossless: true,
        dsd: false,
        platformSupport: "partial",
        ffmpeg: { demuxer: "aiff", decoder: "pcm_s16be" },
        needsFFmpeg: true,
    },
    ".aif": {
        container: "AIFF",
        codec: "pcm_s16be",
        lossless: true,
        dsd: false,
        platformSupport: "partial",
        ffmpeg: { demuxer: "aiff", decoder: "pcm_s16be" },
        needsFFmpeg: true,
    },
    ".wav": {
        container: "WAV / RF64",
        codec: "pcm_*",
        lossless: true,
        dsd: false,
        platformSupport: "full",
        ffmpeg: { demuxer: "wav", decoder: "pcm_*" },
        needsFFmpeg: false,
    },
    ".flac": {
        container: "FLAC",
        codec: "flac",
        lossless: true,
        dsd: false,
        platformSupport: "full",
        ffmpeg: { demuxer: "flac", decoder: "flac" },
        needsFFmpeg: false,
    },
    ".mp3": {
        container: "MP3",
        codec: "mp3",
        lossless: false,
        dsd: false,
        platformSupport: "full",
        ffmpeg: { demuxer: "mp3", decoder: "mp3" },
        needsFFmpeg: false,
    },
    ".m4a": {
        container: "MP4 / M4A",
        codec: "aac / alac",
        lossless: false,
        dsd: false,
        platformSupport: "full",
        ffmpeg: { demuxer: "mov,mp4,m4a", decoder: "aac / alac" },
        needsFFmpeg: false,
    },
    ".ogg": {
        container: "OGG",
        codec: "vorbis / opus",
        lossless: false,
        dsd: false,
        platformSupport: "full",
        ffmpeg: { demuxer: "ogg", decoder: "vorbis / opus" },
        needsFFmpeg: false,
    },
    ".opus": {
        container: "OGG",
        codec: "opus",
        lossless: false,
        dsd: false,
        platformSupport: "full",
        ffmpeg: { demuxer: "ogg", decoder: "opus" },
        needsFFmpeg: false,
    },
    ".aac": {
        container: "ADTS AAC",
        codec: "aac",
        lossless: false,
        dsd: false,
        platformSupport: "full",
        ffmpeg: { demuxer: "aac", decoder: "aac" },
        needsFFmpeg: false,
    },
    ".wma": {
        container: "ASF",
        codec: "wmav2",
        lossless: false,
        dsd: false,
        platformSupport: "full",
        ffmpeg: { demuxer: "asf", decoder: "wmav2" },
        needsFFmpeg: false,
    },
};

/** 未知格式（默认按平台原生处理，不干预上游行为） */
const UNKNOWN_PROFILE: Omit<IAudioFormatProfile, "ext"> = {
    container: "unknown",
    codec: "unknown",
    lossless: false,
    dsd: false,
    platformSupport: "full",
    ffmpeg: { demuxer: "unknown", decoder: "unknown" },
    needsFFmpeg: false,
};

/** 从 url / 文件名中取出归一化扩展名（小写、含点、去掉 query） */
export function normalizeExt(urlOrName?: string | null): string {
    if (!urlOrName) {
        return "";
    }
    let raw = urlOrName;
    // 去掉 query / fragment
    const qIndex = raw.indexOf("?");
    if (qIndex !== -1) {
        raw = raw.slice(0, qIndex);
    }
    const hIndex = raw.indexOf("#");
    if (hIndex !== -1) {
        raw = raw.slice(0, hIndex);
    }
    const dotIndex = raw.lastIndexOf(".");
    const slashIndex = Math.max(raw.lastIndexOf("/"), raw.lastIndexOf("\\"));
    // "." 出现在最后一个路径分隔符之前 => 不是扩展名
    if (dotIndex === -1 || dotIndex < slashIndex || dotIndex === raw.length - 1) {
        return "";
    }
    return raw.slice(dotIndex).toLowerCase();
}

/** 查询格式画像；未知扩展名返回 UNKNOWN（ext 为归一化结果或空串） */
export function getFormatProfile(ext: string): IAudioFormatProfile {
    const key = normalizeExt(ext);
    const hit = FORMAT_TABLE[key];
    return { ext: key, ...(hit ?? UNKNOWN_PROFILE) };
}

/** 本项目新增支持的扩展名（README / 设置页展示用） */
export const HIRES_EXTS = [".alac", ".ape", ".dsf", ".dff"] as const;

/** 必须依赖 ffmpeg 才能播放的扩展名 */
export const FFMPEG_REQUIRED_EXTS = Object.keys(FORMAT_TABLE)
    .filter(ext => FORMAT_TABLE[ext].needsFFmpeg)
    .sort();

/** DSD 族扩展名 */
export const DSD_EXTS = Object.keys(FORMAT_TABLE)
    .filter(ext => FORMAT_TABLE[ext].dsd)
    .sort();

/** 是否为 DSD 族（可由扩展名或 probe 结果判定） */
export function isDsd(ext?: string, probe?: IProbeResult | null): boolean {
    if (probe?.codec && /^dsd/.test(probe.codec)) {
        return true;
    }
    if (probe?.sampleRate && probe.sampleRate > 1000000) {
        // DSD64 = 2.8224MHz，远高于任何 PCM 采样率
        return true;
    }
    return getFormatProfile(ext ?? "").dsd;
}

/** 是否为 ALAC（可能藏在 .m4a 里，需要看 probe 的 codec） */
export function isAlac(ext?: string, probe?: IProbeResult | null): boolean {
    if (probe?.codec && probe.codec.toLowerCase() === "alac") {
        return true;
    }
    return normalizeExt(ext) === ".alac";
}
