# 解码策略详解

## 四种策略

| 策略 | 含义 | 触发条件 | 输出 |
| --- | --- | --- | --- |
| `passthrough` | 不介入，直接给播放器 | 平台原生支持 / 用户关闭扩展 / ffmpeg 不可用 / 任何异常 | 原 url |
| `remux` | 只换容器，不重新编码 | ALAC 且平台不支持当前容器 | `.m4a` |
| `transcode` | 完整转码后落盘 | APE、AIFF、不可 remux 的 ALAC、小体积 DSD | `.flac` / `.wav` |
| `stream` | 本地 HTTP 边转边播 | 大文件（> 阈值）或 DSD 且启用流式 | `http://127.0.0.1:<port>/stream.wav` |

## 决策表

判定顺序（`decideDecodePlan`）：

1. `prefs.enabled === false` → `passthrough`
2. 指定 `forceStrategy` → 直接用它（调试用）
3. `platformSupport === "full"` 且格式不需要 ffmpeg → `passthrough`
4. probe/扩展名判定为 DSD → `stream`（大文件或未知大小）或 `transcode`
5. ALAC：
   - 平台支持（API ≥ 28 且容器是 MP4/M4A）→ `passthrough`
   - 否则若容器可 remux（MP4 / M4A / MOV / CAF）→ `remux`
   - 否则 → `transcode`
6. 其余无损源（APE / AIFF）→ `transcode`，目标由 `losslessTarget` 决定

## 各格式的实际 ffmpeg 命令

（由 `decodePolicy.ts` 生成参数，Kotlin 侧拼接 `-hide_banner -nostdin -loglevel error -y -i <in>`）

**APE → FLAC**
```bash
ffmpeg -i input.ape -c:a flac -compression_level 0 -f flac out.flac
```
> `-compression_level 0`：转码速度优先。解码 APE 的耗远大于 FLAC 压缩收益。

**DSF/DFF → PCM WAV**
```bash
ffmpeg -i input.dsf \
  -af aresample=resampler=soxr:precision=28:dither_method=shibata \
  -ar 88200 -c:a pcm_s24le -f wav out.wav
```
> DSD 是 1bit/2.8224MHz 的 PDM 流，必须先经重采样降为 PCM。
> soxr + shibata 抖动整形能把量化噪声推到人耳不敏感的频段。
> 目标采样率与位深可在设置页调整（默认 24bit / 88.2kHz）。

**ALAC remux**
```bash
ffmpeg -i input.alac -c:a copy -f ipod out.m4a
```
> 无损、极快（只写容器头）。产物会被 `probe` 自检：拿不到时长就判定失败，
> 自动退化为完整转码——这条回退路径有单测覆盖。

**流式**
```bash
ffmpeg -i input.dsf <same args> pipe:1
```
stdout 由 Kotlin 侧通过 chunked HTTP 推给 ExoPlayer，端口随机、`127.0.0.1` 单连接。

## 设备能力的影响

ALAC 是唯一依赖设备的格式：

| 设备 | 容器 | 结果 |
| --- | --- | --- |
| API ≥ 28 | MP4 / M4A | 原生播放，不打扰 ffmpeg |
| API ≥ 28 | CAF / AIFF | remux → M4A |
| API < 28 | 任意 | remux → M4A（平台解码器不可用） |

`IDeviceCapabilities.apiLevel` 由 `react-native-device-info` 提供，缺省按 28 处理。

## 缓存与流式的选择

```
fileSize > streamThresholdBytes(80MB) 且 streamingEnabled 且 非移动网络受限
    → stream
否则
    → transcode
```

DSD 文件通常 150MB–1GB+，实测全量转码要几十秒到数分钟，
因此 DSF/DFF 在"文件大小未知"时也默认走流式。

## 失败与回退

| 失败点 | 行为 |
| --- | --- |
| ffmpeg 未打包 | `isAvailable()` 返回 false → 全程 passthrough |
| probe 失败 | 按扩展名画像决策，允许 remux 乐观尝试 |
| remux 产物自检失败 | 自动改为 transcode |
| transcode 抛异常 | 返回原 url，交给平台播放器（可能失败，但等同上游表现） |
| 原生模块方法缺失 | RN 桥用 Proxy 兜底，返回"不可用"语义而非 crash |

## 参数如何调

设置页（基本设置 → 解码扩展）→ `decodeManager.setPrefs()` → `PersistStatus("decode.prefs")`：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `streamingEnabled` | `true` | 是否允许本地流式 |
| `streamThresholdBytes` | 80MB | 超过就流式 |
| `dsdTargetSampleRate` | 88200 | DSD→PCM 目标采样率 |
| `pcmBitDepth` | 24 | PCM 位深 |
| `losslessTarget` | `flac` | APE/AIFF 转码目标 |
| `cacheLimitBytes` | 2GB | 转码缓存上限 |
