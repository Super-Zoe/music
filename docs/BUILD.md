# 构建 Jellyfin FFmpeg（Android）

> **结论先行**：上游 `jellyfin/jellyfin-ffmpeg` 目前只发布 Linux / Windows / macOS 安装包，
> **没有 Android 产物**。因此 Android 端需要**自行交叉编译**，或使用第三方可信预编译包。
> 本仓库不分发任何二进制。

## 需要编译进 FFmpeg 的能力

解码扩展依赖以下组件（缺一即对应格式不可用）：

| 能力 | 配置项 | 用途 |
| --- | --- | --- |
| DSF / DFF 解复用 | `--enable-demuxer=dsf --enable-demuxer=dff` | DSD 容器 |
| DSD 解码 | `--enable-decoder=dsd_lsbf --enable-decoder=dsd_msbf`（含 planar 变体） | DSD→PCM |
| APE 解复用/解码 | `--enable-demuxer=ape --enable-decoder=ape` | Monkey's Audio |
| ALAC 解码 | `--enable-decoder=alac` | Apple Lossless |
| CAF / AIFF 解复用 | `--enable-demuxer=caf --enable-demuxer=aiff` | ALAC 常见容器 |
| soxr 重采样 | `--enable-libsoxr` | DSD→PCM 质量 |
| WAV / FLAC / IPOD 复用 | `--enable-muxer=wav --enable-muxer=flac --enable-muxer=ipod` | 输出容器 |

## 编译步骤（NDK r26+ / FFmpeg 7.x）

```bash
# 1. 取 Jellyfin 的 FFmpeg 源码与补丁集
git clone --depth 1 -b v7.1.2-5 https://github.com/jellyfin/jellyfin-ffmpeg.git
cd jellyfin-ffmpeg

# 2. 准备 soxr（或直接 --enable-libsoxr 指向已编译的静态库）
#    jellyfin 仓库的 debian/ 目录下有它用的补丁与依赖列表，可参考

# 3. Android 交叉编译（以 arm64-v8a 为例）
export NDK=$ANDROID_HOME/ndk/26.3.11579264
export API=24
export TARGET=aarch64-linux-android
export TOOLCHAIN=$NDK/toolchains/llvm/prebuilt/linux-x86_64
export CC=$TOOLCHAIN/bin/${TARGET}${API}-clang

./configure \
  --prefix=$PWD/out/arm64-v8a \
  --target-os=android --arch=aarch64 --cpu=armv8-a \
  --cc=$CC --cxx=$TOOLCHAIN/bin/${TARGET}${API}-clang++ \
  --enable-cross-compile --enable-shared=no --enable-static \
  --enable-pic \
  --disable-doc --disable-programs-other-than-ffmpeg \
  --disable-encoders --disable-muxers-other-than-wav-flac-ipod \
  --enable-libsoxr \
  --enable-demuxer=dsf --enable-demuxer=dff --enable-demuxer=ape \
  --enable-demuxer=caf --enable-demuxer=aiff \
  --enable-decoder=dsd_lsbf --enable-decoder=dsd_msbf \
  --enable-decoder=dsd_lsbf_planar --enable-decoder=dsd_msbf_planar \
  --enable-decoder=ape --enable-decoder=alac \
  --enable-muxer=wav --enable-muxer=flac --enable-muxer=ipod \
  --enable-protocol=file,pipe,http,https

make -j$(nproc) && make install
```

`armeabi-v7a` 把 `--arch=arm --cpu=armv7-a`、`TARGET=armv7a-linux-androideabi` 换掉即可。
产物通常是 `out/<abi>/bin/ffmpeg`。

### 体积优化建议

只需要音频：上面的 `--disable-encoders` / 限制 muxer 已能砍掉大部分。
典型 arm64 单 ABI 产物约 8–20MB。若 APK 体积敏感，可只保留
`arm64-v8a` + `armeabi-v7a` 两个 ABI。

## 放入工程

```bash
# 方式一：直接用编译产物
npm run fetch-ffmpeg -- --local ./out/arm64-v8a/bin/ffmpeg --abi arm64-v8a

# 方式二：把产物打成 tar.gz/zip 后按清单拉取
#   编辑 scripts/jellyfin-ffmpeg.manifest.json 填入 url + sha256
npm run fetch-ffmpeg -- --abi arm64-v8a,armeabi-v7a
```

脚本会把它放到 `android/app/src/main/jniLibs/<abi>/libjellyfin_ffmpeg.so`。

### 为什么要改名为 `lib*.so`

Android 只会把 APK 中 `lib/<abi>/` 下、**以 `lib` 开头且以 `.so` 结尾**的文件解压到
`nativeLibraryDir`。一个 ELF 可执行文件改个名并不改变它的可执行属性，
这是 Android 上分发 CLI 工具的标准做法。运行时由 `FFmpegDecoderModule.ensureBinary()`
复制到 `filesDir/jellyfin_ffmpeg` 并 `chmod 755` 后执行。

> 对应地，`android/app/build.gradle` 里设置了 `jniLibs.useLegacyPackaging = true`，
> `AndroidManifest.xml` 里 `android:extractNativeLibs="true"`，
> 确保该文件一定被解压出来而不是以压缩态留在 APK 里。

## 验证

```bash
adb shell run-as fun.upup.musicfree ls -l files/jellyfin_ffmpeg
adb shell run-as fun.upup.musicfree ./files/jellyfin_ffmpeg -version
# 期望看到 jellyfin 的版本号与 --enable-libsoxr 等配置
adb shell run-as fun.upup.musicfree ./files/jellyfin_ffmpeg -hide_banner -decoders | grep -E "dsd|ape|alac"
```

## 不编译也可以

跳过整个步骤，直接：

```bash
npm ci && npm run build-android
```

此时 `FFmpegDecoder.isAvailable()` 返回 `false`，设置页显示"未集成"，
应用行为与上游 MusicFree 完全一致（新的四种格式仍会扫描出来，但播放表现与上游相同）。

## CI 自动构建（GitHub Actions）

`.github/workflows/build-hires.yml` 会在**代码发生改动时自动构建**
`app-arm64-v8a-release.apk`：

| 触发方式 | 说明 |
| --- | --- |
| 推送到 `main` / `master` | 最常用的自动构建路径 |
| Pull Request | 合入前先验证能否构建出 APK |
| 推送 tag `v*` | 构建并额外创建 GitHub Release，附上 arm64 APK |
| 手动触发 | Actions 页面运行，可临时指定 FFmpeg 产物地址 |

纯文档改动（`**.md`、`docs/**`、`.imgs/**`、`LICENSE`、`NOTICE`）不会触发构建。
同一分支上的新推送会自动取消上一次未完成的构建，避免排队浪费时长。

**产物**：

- `music-arm64-v8a-release` —— `app-arm64-v8a-release.apk`，保留 30 天
- `music-other-abis` —— 其余 ABI 分包与 universal 包，保留 7 天

**签名**：仓库若配置了 `RELEASE_KEYSTORE_BASE64`、`RELEASE_STORE_PASSWORD`、
`RELEASE_KEY_ALIAS`、`RELEASE_KEY_PASSWORD` 四个机密，就用正式签名；
**没有配置也不会构建失败**，会现场生成一份 CI 自签密钥（`hires-ci`），
并在构建摘要里给出警告。注意这种情况下签名每次都可能变化，
只适合下载安装验证，不要用于正式发布渠道。

**让 CI 构建出带解码扩展的版本**：在仓库 Settings → Variables 里配置
`FFMPEG_ANDROID_URL`（以及可选的 `FFMPEG_ANDROID_SHA256`），
构建时会自动 `node scripts/fetch-jellyfin-ffmpeg.mjs` 拉取并放入
`android/app/src/main/jniLibs/<abi>/`。未配置则构建出的 APK 与上游功能一致。
