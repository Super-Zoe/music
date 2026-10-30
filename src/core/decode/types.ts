/**
 * 解码模块类型定义
 *
 * 这一层不依赖 react-native，保证可以被纯 node 环境单测覆盖。
 */

/** 解码策略 */
export type DecodeStrategy =
    /** 平台原生即可播放，直接把原始 url 交给播放器 */
    | "passthrough"
    /** 仅需换容器（不重新编码），例如 ALAC/CAF -> M4A */
    | "remux"
    /** 完整转码后落盘到缓存目录，再交给播放器 */
    | "transcode"
    /** 起本地 HTTP 流，边转边播（大文件 / DSD 推荐） */
    | "stream";

/** 平台（Android ExoPlayer/MediaPlayer）对某格式的原生支持程度 */
export type PlatformSupport = "full" | "partial" | "none";

/** 单个格式的静态画像 */
export interface IAudioFormatProfile {
    /** 归一化后的扩展名，含前导点，如 ".dsf" */
    ext: string;
    /** 容器名 */
    container: string;
    /** 容器中典型的音频编码 */
    codec: string;
    /** 是否无损 */
    lossless: boolean;
    /** 是否为 DSD（1bit PDM）族 */
    dsd: boolean;
    /** 平台原生支持程度 */
    platformSupport: PlatformSupport;
    /** ffmpeg 侧的能力名，用于在 probe 失败时给出可读提示 */
    ffmpeg: {
        demuxer: string;
        decoder: string;
    };
    /** 是否需要 ffmpeg 介入（platformSupport === "full" 时为 false） */
    needsFFmpeg: boolean;
}

/** ffprobe 风格的探测结果（由原生模块返回） */
export interface IProbeResult {
    /** 原始容器名，如 "dsf" / "ape" / "mov,mp4,m4a" */
    format?: string;
    /** 音频编码名，如 "alac" / "ape" / "dsd_lsbf" */
    codec?: string;
    /** 时长（秒） */
    duration?: number;
    /** 采样率（Hz），DSD 为 DSD 时钟频率（如 2822400） */
    sampleRate?: number;
    /** 声道数 */
    channels?: number;
    /** 位深，PCM 才有意义 */
    bitsPerSample?: number;
    /** 码率（bps） */
    bitrate?: number;
}

/** 解码请求 */
export interface IDecodeRequest {
    /** 本地路径（file:// 或 content://）或远端 url */
    url: string;
    /** 原始文件名，用于兜底取扩展名 */
    fileName?: string;
    /** 已探测到的信息；缺省时路由会先探测 */
    probe?: IProbeResult | null;
    /** 网络受限（如移动网络禁止播放）时禁止发起流式解码 */
    networkLimited?: boolean;
    /** 强制策略，调试用 */
    forceStrategy?: DecodeStrategy;
}

/** 解码计划：路由的产物，描述"该怎么解" */
export interface IDecodePlan {
    /** 采用的策略 */
    strategy: DecodeStrategy;
    /** 命中的格式画像 */
    profile: IAudioFormatProfile;
    /** 交给播放器的容器扩展名（含点） */
    outputExt: string;
    /** 交给播放器的 MIME */
    outputMime: string;
    /** 追加给 ffmpeg 的参数（不含 -i 与输出路径） */
    ffmpegArgs: string[];
    /** 该计划是否需要起本地流式服务 */
    streaming: boolean;
    /** 人类可读的原因，用于日志/设置页展示 */
    reason: string;
}

/** 解码结果：可直接塞进 react-native-track-player 的 Track */
export interface IDecodeResult {
    /** 播放地址 */
    url: string;
    /** 是否经过 ffmpeg 处理 */
    decoded: boolean;
    strategy: DecodeStrategy;
    /** 是否来自缓存 */
    fromCache: boolean;
    /** 转码产物路径（stream 策略下为 null） */
    cachePath: string | null;
    /** 探测信息 */
    probe: IProbeResult | null;
    /** 时长（秒），探测到才有 */
    duration?: number;
}

/** 用户偏好（对应设置页开关），可序列化 */
export interface IDecodePreferences {
    /** 总开关：关闭后所有格式走平台原生，等价于上游行为 */
    enabled: boolean;
    /** 大文件阈值（字节），超过则强制流式而不是落盘转码 */
    streamThresholdBytes: number;
    /** 流式解码总开关 */
    streamingEnabled: boolean;
    /** DSD 转 PCM 的目标采样率（Hz） */
    dsdTargetSampleRate: number;
    /** PCM 输出位深，16 或 24 */
    pcmBitDepth: 16 | 24;
    /** 非 DSD 无损源的目标容器：flac 体积小，wav 兼容性最好 */
    losslessTarget: "flac" | "wav";
    /** 转码缓存上限（字节），LRU 清理 */
    cacheLimitBytes: number;
}

/** 转码产物缓存存储抽象（实现见 decodeCache.ts / memoryCache.ts） */
export interface ICacheStore {
    /** 由 key + 扩展名得到产物落盘路径（不保证文件已存在） */
    resolve(key: string, ext: string): Promise<string>;
    /** 命中返回产物路径，未命中返回 null */
    get(key: string): Promise<string | null>;
    /** 转码成功后登记产物 */
    commit(key: string, path: string, size?: number): Promise<void>;
    remove(key: string): Promise<void>;
    totalSize(): Promise<number>;
    /** 按 LRU 清理到 limitBytes 以内 */
    trim(limitBytes: number): Promise<void>;
}

/** 原生模块能力接口（Kotlin 侧 FFmpegDecoderModule 实现） */
export interface IFFmpegDecoderNative {
    /** ffmpeg 版本字符串，未集成时返回 null */
    getVersion(): Promise<string | null>;
    /** 探测音频信息 */
    probe(url: string): Promise<IProbeResult | null>;
    /** 一次性转码到缓存目录，返回产物路径 */
    transcode(
        url: string,
        args: string[],
        outputExt: string,
        cacheKey: string,
    ): Promise<string>;
    /** 起本地流式服务，返回 http://127.0.0.1:<port>/... */
    startStream(url: string, args: string[], outputExt: string): Promise<string>;
    /** 停止流式服务 */
    stopStream(url: string): Promise<void>;
    /** 取消转码任务 */
    cancel(url: string): Promise<void>;
}
