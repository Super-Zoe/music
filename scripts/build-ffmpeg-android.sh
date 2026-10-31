#!/usr/bin/env bash
#
# 为 Android 交叉编译 FFmpeg —— 产出一个静态可执行文件，供解码扩展使用。
#
# 产物会被命名为 libjellyfin_ffmpeg.so 放到 jniLibs/<abi>/ 下。
# 之所以用 ".so" 后缀：Android 打包原生库的目录约定只有这样才会被安装到 APK 里，
# 运行时 FFmpegDecoderModule 会把它复制到 filesDir 并 chmod 755 后当作可执行文件运行。
#
# 用法（CI 里由 .github/workflows/build-ffmpeg.yml 调用）：
#   ABI=arm64-v8a ./scripts/build-ffmpeg-android.sh
#
# 环境变量：
#   ABI                arm64-v8a | armeabi-v7a（默认 arm64-v8a）
#   API                Android API level（默认 24，与项目 minSdk 一致）
#   FFMPEG_TAG         FFmpeg tag（默认 n7.1.1）
#   ANDROID_NDK_HOME   NDK 路径
#   JOBS               并行编译数
#   OUT_DIR            产物输出根目录（默认 android/app/src/main/jniLibs）
#   SKIP_SOXR=1        跳过 libsoxr 编译
#   WITH_SOXR=1        启用 libsoxr（默认尝试，失败自动降级）
#
set -euo pipefail

ABI="${ABI:-arm64-v8a}"
API="${API:-24}"
FFMPEG_TAG="${FFMPEG_TAG:-n7.1.1}"
JOBS="${JOBS:-$(nproc 2>/dev/null || echo 2)}"
OUT_DIR="${OUT_DIR:-android/app/src/main/jniLibs}"
SKIP_SOXR="${SKIP_SOXR:-0}"
# 后面为了跑 configure 会 cd 进 FFmpeg 源码目录，一旦 OUT_DIR 是相对路径，
# 产物就会被写进源码目录里的 android/app/... 从而丢失。先归一化成绝对路径。
case "$OUT_DIR" in
  /*) ;;
  *)  OUT_DIR="$(pwd)/$OUT_DIR" ;;
esac

WORK="${WORK:-$(pwd)/.ffmpeg-build}"
PREFIX="$WORK/prefix/$ABI"
SOXR_PREFIX="$WORK/soxr-prefix/$ABI"
mkdir -p "$WORK" "$PREFIX"

# ---------------------------------------------------------------- ABI 配置
case "$ABI" in
  arm64-v8a)
    ARCH="aarch64"; CPU="armv8-a"; TRIPLE="aarch64-linux-android"
    EXTRA_OPT_FLAGS="-march=armv8-a"
    ;;
  armeabi-v7a)
    ARCH="arm"; CPU="armv7-a"; TRIPLE="armv7a-linux-androideabi"
    EXTRA_OPT_FLAGS="-march=armv7-a -mfpu=neon -mfloat-abi=softfp"
    ;;
  *)
    echo "不支持的 ABI: $ABI" >&2; exit 1 ;;
esac

# ---------------------------------------------------------------- NDK
if [ -z "${ANDROID_NDK_HOME:-}" ] || [ ! -d "${ANDROID_NDK_HOME:-}" ]; then
  for cand in \
    "${ANDROID_HOME:-}/ndk/26.1.10909125" \
    "${ANDROID_SDK_ROOT:-}/ndk/26.1.10909125" \
    "$HOME/android-sdk/ndk/26.1.10909125"; do
    [ -d "$cand" ] && ANDROID_NDK_HOME="$cand" && break
  done
fi
if [ -z "${ANDROID_NDK_HOME:-}" ] || [ ! -d "$ANDROID_NDK_HOME" ]; then
  echo "::error::找不到 NDK，请设置 ANDROID_NDK_HOME" >&2
  exit 1
fi
echo "NDK: $ANDROID_NDK_HOME"

TOOLCHAIN="$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/linux-x86_64"
export CC="$TOOLCHAIN/bin/${TRIPLE}${API}-clang"
export CXX="$TOOLCHAIN/bin/${TRIPLE}${API}-clang++"
export AR="$TOOLCHAIN/bin/llvm-ar"
export NM="$TOOLCHAIN/bin/llvm-nm"
export RANLIB="$TOOLCHAIN/bin/llvm-ranlib"
export STRIP="$TOOLCHAIN/bin/llvm-strip"
export LD="$TOOLCHAIN/bin/ld.lld"
for f in "$CC" "$AR" "$STRIP"; do
  [ -x "$f" ] || { echo "::error::缺少工具 $f" >&2; exit 1; }
done

# ---------------------------------------------------------------- libsoxr
# 供 -af aresample=resampler=soxr 使用；编译失败不影响整体，后续会自动降级
SOXR_ARGS=()
if [ "$SKIP_SOXR" != "1" ]; then
  echo "=== 编译 libsoxr ==="
  # FFmpeg configure 通过 pkg-config 找 libsoxr，所以先准备前缀与 .pc 文件
  mkdir -p "$SOXR_PREFIX/lib" "$SOXR_PREFIX/include" "$SOXR_PREFIX/lib/pkgconfig"
  if [ ! -f "$WORK/soxr/CMakeLists.txt" ]; then
    mkdir -p "$WORK/soxr"
    if curl -fsSL --max-time 180 \
        "https://codeload.github.com/chirlu/soxr/legacy.tar.gz/refs/heads/master" \
        -o "$WORK/soxr.tar.gz"; then
      tar -xzf "$WORK/soxr.tar.gz" -C "$WORK/soxr" --strip-components=1
    else
      echo "::warning::下载 soxr 源码失败，跳过 soxr"
      SKIP_SOXR=1
    fi
  fi

  if [ "$SKIP_SOXR" != "1" ]; then
    if cmake -S "$WORK/soxr" -B "$WORK/soxr-build/$ABI" \
        -DCMAKE_TOOLCHAIN_FILE="$ANDROID_NDK_HOME/build/cmake/android.toolchain.cmake" \
        -DANDROID_ABI="$ABI" -DANDROID_PLATFORM="android-$API" \
        -DANDROID_TOOLCHAIN=clang \
        -DCMAKE_BUILD_TYPE=Release \
        -DCMAKE_INSTALL_PREFIX="$SOXR_PREFIX" \
        -DBUILD_SHARED_LIBS=OFF \
        -DBUILD_TESTS=OFF -DBUILD_TESTS_NATIVE=OFF \
        -DWITH_OPENMP=OFF -DWITH_LSR_BINDINGS=OFF \
        -DWITH_DEV_TRACE=OFF \
      && cmake --build "$WORK/soxr-build/$ABI" --target install -j"$JOBS" \
      && [ -f "$SOXR_PREFIX/lib/libsoxr.a" ]; then
      cat > "$SOXR_PREFIX/lib/pkgconfig/soxr.pc" <<PC
prefix=$SOXR_PREFIX
exec_prefix=\${prefix}
libdir=\${prefix}/lib
includedir=\${prefix}/include

Name: soxr
Description: SoX Resampler library
Version: 0.1.3
Libs: -L\${libdir} -lsoxr
Cflags: -I\${includedir}
PC
      export PKG_CONFIG_PATH="$SOXR_PREFIX/lib/pkgconfig:${PKG_CONFIG_PATH:-}"
      SOXR_ARGS=(--enable-libsoxr)
      echo "libsoxr: 已启用"
    else
      echo "::warning::libsoxr 编译失败，改用 FFmpeg 内置重采样器"
    fi
  fi
fi

# ---------------------------------------------------------------- FFmpeg 源码
echo "=== 获取 FFmpeg 源码 ($FFMPEG_TAG) ==="
mkdir -p "$WORK/src"
if [ ! -d "$WORK/src/FFmpeg-$FFMPEG_TAG" ]; then
  curl -fsSL --max-time 300 \
    "https://codeload.github.com/FFmpeg/FFmpeg/legacy.tar.gz/refs/tags/$FFMPEG_TAG" \
    -o "$WORK/ffmpeg.tar.gz"
  mkdir -p "$WORK/src/FFmpeg-$FFMPEG_TAG"
  tar -xzf "$WORK/ffmpeg.tar.gz" -C "$WORK/src/FFmpeg-$FFMPEG_TAG" --strip-components=1
fi
SRC="$WORK/src/FFmpeg-$FFMPEG_TAG"
cd "$SRC"

# ---------------------------------------------------------------- configure
echo "=== configure ==="
# 只保留音频解码链路需要的组件：ALAC / APE / DSF / DFF 的解码与容器，
# 外加 ALAC remux 到 M4A 所需的 ipod muxer。
# 注意 filter graph 依赖 abuffer / abuffersink / aformat / anull 这几个内部 filter，
# 用 --disable-everything 时必须显式启用，否则 -af 会报找不到 filter。
COMMON_ARGS=(
  --prefix="$PREFIX"
  --target-os=android
  --arch="$ARCH"
  --cpu="$CPU"
  --enable-cross-compile
  --cc="$CC" --cxx="$CXX" --ar="$AR" --nm="$NM" --ranlib="$RANLIB" --strip="$STRIP"
  --disable-shared --enable-static
  --disable-doc --disable-htmlpages --disable-manpages --disable-podpages --disable-txtpages
  --disable-debug --enable-optimizations
  --disable-autodetect
  --pkg-config="$(command -v pkg-config || echo false)"
  --extra-cflags="-fPIC $EXTRA_OPT_FLAGS"
  # 静态链接 + 16KB 页对齐（Android 15+ 要求）
  --extra-ldflags="-static -Wl,-z,max-page-size=16384 -Wl,--gc-sections"
  --disable-everything
  --enable-ffmpeg
  --enable-avcodec --enable-avformat --enable-avfilter --enable-avutil --enable-swresample
  --enable-decoder=alac,ape,flac,pcm_s16le,pcm_s24le,pcm_s32le,pcm_f32le,dsd_lsbf,dsd_msbf,dsd_lsbf_planar,dsd_msbf_planar
  --enable-demuxer=ape,dsf,aiff,caf,mov,flac,wav
  --enable-muxer=ipod,flac,wav
  --enable-filter=aresample,abuffer,abuffersink,buffer,buffersink,aformat,format,anull,null,copy
  --enable-protocol=file,pipe
  --enable-bsf=null
)

if [ "${#SOXR_ARGS[@]}" -gt 0 ]; then
  COMMON_ARGS+=("${SOXR_ARGS[@]}")
fi

# shellcheck disable=SC2086
./configure "${COMMON_ARGS[@]}"

# ---------------------------------------------------------------- build
echo "=== 编译 (jobs=$JOBS) ==="
make -j"$JOBS" > /dev/null
make install > /dev/null

BIN="$PREFIX/bin/ffmpeg"
[ -f "$BIN" ] || { echo "::error::未生成 $BIN" >&2; exit 1; }

# ---------------------------------------------------------------- 检查所需能力
echo "=== 检查编译出的能力 ==="
FFMPEG_CONFIG="$BIN -hide_banner"
if command -v qemu-aarch64 >/dev/null 2>&1 && [ "$ABI" = "arm64-v8a" ]; then
  QEMU_BIN="qemu-aarch64 $BIN"
elif command -v qemu-arm >/dev/null 2>&1 && [ "$ABI" = "armeabi-v7a" ]; then
  QEMU_BIN="qemu-arm $BIN"
else
  QEMU_BIN=""
fi

if [ -n "$QEMU_BIN" ]; then
  if $QEMU_BIN -version > "$WORK/ffmpeg-version.txt" 2>&1; then
    echo "二进制可运行，版本信息："
    head -2 "$WORK/ffmpeg-version.txt"
    for want in alac ape dsf; do
      if $QEMU_BIN -hide_banner -demuxers 2>/dev/null | grep -qw "$want" \
         || $QEMU_BIN -hide_banner -decoders 2>/dev/null | grep -qw "$want"; then
        echo "  ok    $want"
      else
        echo "  MISS  $want"
      fi
    done
    $QEMU_BIN -hide_banner -L -decoders 2>/dev/null | grep -c . > /dev/null || true
  else
    echo "::warning::qemu 无法运行该二进制，跳过能力校验"
  fi
else
  echo "::warning::未安装 qemu，跳过运行校验"
fi

# ---------------------------------------------------------------- 输出
DEST="$OUT_DIR/$ABI"
mkdir -p "$DEST"
"$STRIP" --strip-all "$BIN" -o "$WORK/ffmpeg-stripped" 2>/dev/null || cp "$BIN" "$WORK/ffmpeg-stripped"
cp "$WORK/ffmpeg-stripped" "$DEST/libjellyfin_ffmpeg.so"
chmod 755 "$DEST/libjellyfin_ffmpeg.so"

SIZE=$(du -h "$DEST/libjellyfin_ffmpeg.so" | cut -f1)
SHA=$(sha256sum "$DEST/libjellyfin_ffmpeg.so" | cut -d' ' -f1)
echo ""
echo "=== 完成 ==="
echo "产物: $DEST/libjellyfin_ffmpeg.so"
echo "大小: $SIZE"
echo "sha256: $SHA"
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  echo "binary=$DEST/libjellyfin_ffmpeg.so" >> "$GITHUB_OUTPUT"
  echo "sha256=$SHA" >> "$GITHUB_OUTPUT"
  echo "size=$SIZE" >> "$GITHUB_OUTPUT"
fi
