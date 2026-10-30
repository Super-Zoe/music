# 与上游的同步策略

## 基线

- 上游：<https://github.com/maotoumao/MusicFree>
- 版本：`1.0.0-beta.4`
- 本项目版本：`1.0.0-beta.4-hires.1`

## 改动清单

### 新增文件（不与上游冲突）

```
src/core/decode/{types,formats,decodePolicy,decodeRouter,decodeCache,memoryCache,cacheKey,index}.ts
src/native/ffmpegDecoder/index.ts
src/pages/setting/settingTypes/decoderSetting.tsx
android/app/src/main/java/fun/upup/musicfree/ffmpegDecoder/{FFmpegDecoderModule,FFmpegDecoderPackage}.kt
android/app/src/main/jniLibs/README.md
scripts/{fetch-jellyfin-ffmpeg.mjs,run-decode-tests.mjs,ts-loader.mjs,jellyfin-ffmpeg.manifest.json}
tests/decode/*
docs/*
.github/workflows/{decode-tests,build-hires}.yml
```

### 修改的上游文件（共 9 处，均有注释标记）

| 文件 | 改动 | 冲突风险 |
| --- | --- | --- |
| `src/core/trackPlayer/index.ts` | 新增 `import decodeManager`、字段 `lastDecodedUrl`、方法 `resolveDecodeSource()` / `releaseDecodeResources()`，`play()` 中插入 6.5 步 | 中（上游常改这里） |
| `src/constants/commonConst.ts` | `supportLocalMediaType` 增加 5 个扩展名 | 低 |
| `src/core/pluginManager/plugin.ts` | `import decodeManager`；`importMusicItem` 增加 probe 兜底 | 低 |
| `src/core/localMusicSheet.ts` | 新增 `fillDurationWithFFmpeg()` 及调用 | 低 |
| `src/utils/persistStatus.ts` | `IPersistStatus` 增加 `"decode.prefs"` | 低 |
| `src/pages/setting/settingTypes/basicSetting.tsx` | 新增 import + 一个 section | 中 |
| `src/core/i18n/languages/*.json` | 三语各新增 16 个 key | 中（若上游也改同一区域） |
| `android/app/src/main/java/.../MainApplication.kt` | + `add(FFmpegDecoderPackage())` | 低 |
| `android/app/build.gradle` | + `packagingOptions { jniLibs.useLegacyPackaging = true }` | 低 |
| `android/app/src/main/AndroidManifest.xml` | + 8 个 intent-filter | 低 |
| `package.json` | name / version / scripts / repository / upstream | 低 |
| `jest.config.js` | + `testPathIgnorePatterns` | 低 |
| `.gitignore` | `!scripts/`、忽略 jniLibs 产物 | 低 |

所有插入处都以 `解码扩展` / `Decode extension` 注释开头，`git log -S "解码扩展"` 可全部列出。

## 同步步骤

```bash
git remote add upstream https://github.com/maotoumao/MusicFree.git
git fetch upstream
git merge upstream/dev        # 或对应分支
```

冲突只会落在上表"中/高"风险的几个文件。解决原则：

1. **保留上游的新逻辑**，把我们的插入块整体搬到对应位置（插入块是自包含的，不依赖上下文变量命名，
   除了 `play()` 里的 `source` 与 `this.isCurrentMusic`——这两个是上游稳定 API）；
2. 如果上游重写了 `play()`，只需在新流程里"插件返回音源之后、`setTrackSource` 之前"重新插入
   那 8 行，语义不变；
3. 合并后务必跑 `npm run test:decode`，策略层的单测不依赖 RN，能快速暴露契约变化。

## 兼容性保证

- **数据格式**：歌单、历史、配置、备份文件的序列化结构未改动，上游与本版本的备份可互相导入。
  新增的 `decode.prefs` 是独立 key，上游版本读不到就走默认值，不会破坏导入。
- **插件协议**：`IPluginDefine` 未改，上游插件可直接安装使用；本版本也不产出上游装不了的插件。
- **降级**：把 `decode.prefs.enabled` 设为 `false`，或直接不打包 FFmpeg，
  运行路径即等价于上游。
- **npm 依赖**：未新增任何依赖，`package-lock.json` 与上游保持可 diff 状态。
