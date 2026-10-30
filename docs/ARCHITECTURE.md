# 架构说明

## 总览

解码扩展以**旁路（side-car）**的方式接入，不替换任何上游组件：

```
┌──────────────────────────────────────────────────────────────┐
│  JS 层                                                        │
│                                                              │
│  TrackPlayer.play()   ── 上游逻辑，唯一插入点在 6.5 步 ──┐      │
│         │                                                 │      │
│         ▼                                                 ▼      │
│  plugin.getMediaSource()                       decodeManager.resolve()
│         │                                                 │      │
│         └──────────► source.url ──────────────────────────┘      │
│                                                              │      │
│                                            ┌────────────────┘      │
│                                            ▼                       │
│  decodeRouter ──► decideDecodePlan ──► IDecodePlan                 │
│       │                                                            │
│       ├─ passthrough ──► 原 url（零开销）                           │
│       ├─ remux ──► native.transcode(-c:a copy) ──► file:// 产物     │
│       ├─ transcode ──► native.transcode ──► file:// 产物（进缓存）   │
│       └─ stream ──► native.startStream ──► http://127.0.0.1:port   │
└───────────────────────────────┬───────────────────────────────────┘
                                │  NativeModules.FFmpegDecoder
┌───────────────────────────────▼───────────────────────────────────┐
│  Kotlin 层  fun.upup.musicfree.ffmpegDecoder.FFmpegDecoderModule   │
│                                                                   │
│   ensureBinary()  nativeLibraryDir/libjellyfin_ffmpeg.so           │
│                   → filesDir/jellyfin_ffmpeg (chmod 755)           │
│   probe()         ffmpeg -i <input>         解析 stderr            │
│   transcode()     ffmpeg -i <in> <args> <out>                     │
│   startStream()   ffmpeg -i <in> <args> pipe:1 → 本地 ServerSocket  │
└───────────────────────────────────────────────────────────────────┘
                                │
┌───────────────────────────────▼───────────────────────────────────┐
│  react-native-track-player（ExoPlayer）                            │
│  只看到 file:///*.flac、file:///*.wav 或 http://127.0.0.1/*.wav     │
└───────────────────────────────────────────────────────────────────┘
```

## 模块分层

| 层 | 文件 | 依赖 | 可单测 |
| --- | --- | --- | --- |
| 契约 | `types.ts` | 无 | ✅ |
| 事实 | `formats.ts` | 无 | ✅ |
| 决策 | `decodePolicy.ts` | 无 | ✅ |
| 路由 | `decodeRouter.ts` | 依赖注入 | ✅ |
| 缓存 | `decodeCache.ts` / `memoryCache.ts` | RNFS、MMKV | 内存实现 ✅ |
| 桥 | `src/native/ffmpegDecoder/index.ts` | react-native | ❌ |
| 装配 | `index.ts` | 以上全部 | ❌ |

**刻意的分层约束**：`formats.ts` / `decodePolicy.ts` / `decodeRouter.ts` / `cacheKey.ts` /
`memoryCache.ts` / `types.ts` **不 import 任何 react-native 模块**。
这样解码策略可以在 CI 上用 `node --experimental-strip-types` 直接验证，不需要
模拟器、不需要 `npm ci`、不需要真机。

## 播放链路数据流

1. 用户点击播放 → `TrackPlayer.play(musicItem)`
2. 插件（含内置的"本地文件插件"）返回 `IMediaSourceResult { url }`
3. `getUrlExt(url) === ".m3u8"` → 标记 hls（**上游逻辑**）
4. **6.5 新增**：`resolveDecodeSource(url)`
   - `decodeManager.resolve({ url, fileName: url })`
   - `decideDecodePlan` 结合格式画像、probe 结果、用户偏好、设备能力产出 `IDecodePlan`
   - 按策略执行：查缓存 → 转码/重封装/起流
   - 返回 `{ url, decoded, strategy, cachePath, probe }`
5. `mergeTrackSource` → `setTrackSource` → `ReactNativeTrackPlayer.play()`（**上游逻辑**）

`resolveDecodeSource` 内部还有两项资源管理：

- 切歌时若上一首是流式解码，调用 `stopStream()` 回收 ffmpeg 进程与端口；
- 任一步骤抛异常都返回原始 url，交给平台原生播放器尝试（可能失败，但绝不比上游更差）。

## 缓存

- 目录：`{pathConst.cachePath}/ffmpeg-decode/`
- 键：`FNV1a64(url + " " + args.join(" ") + " " + outputExt)`
- 索引：MMKV `Decode.CacheIndex`，记录 `{ path, size, atime }`
- 淘汰：LRU，`cacheLimitBytes` 默认 2GB，设置页手动触发或在 resolve 后异步 trim

## 为什么不直接改 ExoPlayer

ExoPlayer 的 FFmpeg 扩展（`decoder_ffmpeg`）需要以 AAR 形式编译进播放器，
而 MusicFree 用的是 `react-native-track-player`，其 Android 端已经封装好 ExoPlayer 依赖，
替换成本高且会破坏上游升级路径。
采用"ffmpeg CLI 旁路 + 产物回喂播放器"的方案：

- 对上游零侵入（只加文件、只在 play() 插一处）；
- 上游升级 react-native-track-player 时不受影响；
- 解码能力由外部二进制决定，可独立升级 FFmpeg。

代价是首次播放需要一次转码（有缓存与流式两种缓解手段）。
