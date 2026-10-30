import assert from "node:assert/strict";
import {
    DSD_EXTS,
    FFMPEG_REQUIRED_EXTS,
    HIRES_EXTS,
    getFormatProfile,
    isAlac,
    isDsd,
    normalizeExt,
} from "../../src/core/decode/formats";
import { buildCacheKey, fnv1a64 } from "../../src/core/decode/cacheKey";
import { test } from "./harness";

const SUITE = "格式注册表";

test(SUITE, "normalizeExt 处理路径 / query / 大小写", () => {
    assert.equal(normalizeExt("file:///sdcard/Music/a.DSF"), ".dsf");
    assert.equal(normalizeExt("http://x.com/a.mp3?token=abc"), ".mp3");
    assert.equal(normalizeExt("http://x.com/a.flac#t=10"), ".flac");
    assert.equal(normalizeExt("noext"), "");
    assert.equal(normalizeExt(""), "");
    assert.equal(normalizeExt(undefined), "");
    // "a.b/c" 里的点属于目录名，不是扩展名
    assert.equal(normalizeExt("/a.b/c"), "");
});

test(SUITE, "四种目标格式都被登记且标记为需要 ffmpeg", () => {
    for (const ext of [".alac", ".ape", ".dsf", ".dff"]) {
        const profile = getFormatProfile(ext);
        assert.equal(profile.ext, ext);
        assert.equal(profile.needsFFmpeg, true, `${ext} 应需要 ffmpeg`);
        assert.equal(profile.lossless, true, `${ext} 应为无损`);
    }
    assert.deepEqual([...HIRES_EXTS].sort(), [".alac", ".ape", ".dff", ".dsf"]);
    assert.deepEqual(DSD_EXTS, [".dff", ".dsf"]);
});

test(SUITE, "DSD 判定：既看扩展名也看 probe", () => {
    assert.equal(isDsd(".dsf"), true);
    assert.equal(isDsd(".dff"), true);
    assert.equal(isDsd(".flac"), false);
    // DSD64 时钟频率 2.8224MHz，远高于任何 PCM
    assert.equal(isDsd(".flac", { sampleRate: 2822400 }), true);
    assert.equal(isDsd(".flac", { codec: "dsd_lsbf" }), true);
    assert.equal(isDsd(".flac", { sampleRate: 96000, codec: "flac" }), false);
});

test(SUITE, "ALAC 判定：藏在 m4a 里也能识别", () => {
    assert.equal(isAlac(".alac"), true);
    assert.equal(isAlac(".m4a"), false);
    assert.equal(isAlac(".m4a", { codec: "alac" }), true);
    assert.equal(isAlac(".m4a", { codec: "aac" }), false);
});

test(SUITE, "上游已支持格式不会被 ffmpeg 接管", () => {
    for (const ext of [".mp3", ".flac", ".m4a", ".ogg", ".wav"]) {
        assert.equal(getFormatProfile(ext).needsFFmpeg, false, ext);
    }
    assert.ok(!FFMPEG_REQUIRED_EXTS.includes(".mp3"));
    assert.ok(!FFMPEG_REQUIRED_EXTS.includes(".flac"));
    assert.ok(FFMPEG_REQUIRED_EXTS.includes(".ape"));
});

test(SUITE, "未知扩展名不触发解码", () => {
    const profile = getFormatProfile(".xyz");
    assert.equal(profile.needsFFmpeg, false);
    assert.equal(profile.platformSupport, "full");
});

test(SUITE, "cacheKey 稳定且区分参数", () => {
    const a = buildCacheKey("/a.dsf", ["-c:a", "flac"], ".flac");
    const b = buildCacheKey("/a.dsf", ["-c:a", "flac"], ".flac");
    const c = buildCacheKey("/a.dsf", ["-c:a", "pcm_s24le"], ".wav");
    assert.equal(a, b);
    assert.notEqual(a, c);
    assert.equal(fnv1a64(""), "cbf29ce484222325");
});
