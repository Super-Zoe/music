# jniLibs —— Jellyfin FFmpeg 预打包产物

Android 只会把 APK 中 `lib/<abi>/` 下、**以 `lib` 开头且以 `.so` 结尾**的文件解压到
`nativeLibraryDir`。因此 Jellyfin FFmpeg 的可执行文件按以下约定放置：

```
jniLibs/
├── arm64-v8a/libjellyfin_ffmpeg.so
├── armeabi-v7a/libjellyfin_ffmpeg.so
├── x86/libjellyfin_ffmpeg.so
└── x86_64/libjellyfin_ffmpeg.so
```

> 名字虽是 `.so`，内容是一个**可执行文件**（ELF executable，带 `main` 入口）。
> `FFmpegDecoderModule` 首次调用时会把它复制到 `filesDir/jellyfin_ffmpeg` 并 `chmod 755` 后执行。

## 获取产物

```bash
# 自动下载 Jellyfin 官方发布产物并校验 SHA256
node scripts/fetch-jellyfin-ffmpeg.mjs

# 指定版本 / ABI
node scripts/fetch-jellyfin-ffmpeg.mjs --version 7.0.2-1 --abi arm64-v8a
```

上游未提供目标 ABI 产物时，脚本会失败并提示按 [docs/BUILD.md](../../../docs/BUILD.md)
自行交叉编译。

## 为什么不在仓库里直接放二进制

* FFmpeg 完整构建（含 DSD / APE / ALAC 解码器）单 ABI 约 20–40MB，不适合入库；
* Jellyfin FFmpeg 以 GPL/LGPL 混合授权分发，二进制随仓库分发会带来合规负担；
* 交由构建脚本在 CI 拉取，可随时跟进上游安全更新。

因此本目录默认只保留说明文件；未放入产物时，`FFmpegDecoder.isAvailable()`
返回 `false`，应用自动回退为上游原生解码行为，不影响任何既有功能。
