import assert from "node:assert/strict";
import { decideDecodePlan, getDefaultPreferences } from "../../src/core/decode/decodePolicy";
import type { IDecodePreferences } from "../../src/core/decode/types";
import { test } from "./harness";

const SUITE = "解码策略决策";

const prefs: IDecodePreferences = getDefaultPreferences();

function req(url: string, extra: Parameters<typeof decideDecodePlan>[0] = { url }) {
    return { url, ...extra };
}

test(SUITE, "上游已支持格式一律 passthrough", () => {
    for (const url of [
        "/a.mp3",
        "/a.flac",
        "/a.m4a",
        "/a.ogg",
        "/a.wav",
        "https://x.com/a.mp3?sign=1",
    ]) {
        const plan = decideDecodePlan(req(url), prefs);
        assert.equal(plan.strategy, "passthrough", url);
        assert.equal(plan.ffmpegArgs.length, 0);
    }
});

test(SUITE, "APE 走转码，默认输出 FLAC", () => {
    const plan = decideDecodePlan(req("/a.ape"), prefs, { fileSize: 30 * 1024 * 1024 });
    assert.equal(plan.strategy, "transcode");
    assert.equal(plan.outputExt, ".flac");
    assert.equal(plan.outputMime, "audio/flac");
    assert.ok(plan.ffmpegArgs.includes("flac"));
    assert.equal(plan.streaming, false);
});

test(SUITE, "APE 超过阈值时改走流式", () => {
    const plan = decideDecodePlan(req("/a.ape"), prefs, {
        fileSize: prefs.streamThresholdBytes + 1,
    });
    assert.equal(plan.strategy, "stream");
    assert.equal(plan.streaming, true);
});

test(SUITE, "APE 偏好 wav 时输出 wav + pcm_s24le", () => {
    const plan = decideDecodePlan(req("/a.ape"), { ...prefs, losslessTarget: "wav" });
    assert.equal(plan.outputExt, ".wav");
    assert.ok(plan.ffmpegArgs.includes("pcm_s24le"));
});

test(SUITE, "APE 偏好 16bit 时输出 pcm_s16le", () => {
    const plan = decideDecodePlan(
        req("/a.ape"),
        { ...prefs, losslessTarget: "wav", pcmBitDepth: 16 },
    );
    assert.ok(plan.ffmpegArgs.includes("pcm_s16le"));
});

test(SUITE, "DSF 走 DSD->PCM，输出 wav 且带 soxr 重采样", () => {
    const plan = decideDecodePlan(req("/a.dsf"), prefs, { fileSize: 5 * 1024 * 1024 });
    assert.equal(plan.strategy, "transcode");
    assert.equal(plan.outputExt, ".wav");
    assert.equal(plan.profile.dsd, true);
    const args = plan.ffmpegArgs.join(" ");
    assert.ok(args.includes("aresample=resampler=soxr"), args);
    assert.ok(args.includes("pcm_s24le"));
    assert.ok(args.includes(String(prefs.dsdTargetSampleRate)));
});

test(SUITE, "DSF 大文件默认流式（不等落盘）", () => {
    const plan = decideDecodePlan(req("/a.dsf"), prefs, {
        fileSize: 300 * 1024 * 1024,
    });
    assert.equal(plan.strategy, "stream");
    assert.equal(plan.outputExt, ".wav");
});

test(SUITE, "DSF 未知大小也默认流式", () => {
    const plan = decideDecodePlan(req("/a.dff"), prefs);
    assert.equal(plan.strategy, "stream");
});

test(SUITE, "关闭流式开关后 DSF 退化为落盘转码", () => {
    const plan = decideDecodePlan(
        req("/a.dsf"),
        { ...prefs, streamingEnabled: false },
        { fileSize: 300 * 1024 * 1024 },
    );
    assert.equal(plan.strategy, "transcode");
});

test(SUITE, "网络受限时不启用流式", () => {
    const plan = decideDecodePlan(
        req("https://x/a.dsf", { networkLimited: true }),
        prefs,
        { fileSize: 300 * 1024 * 1024 },
    );
    assert.equal(plan.strategy, "transcode");
});

test(SUITE, "ALAC：独立 .alac（CAF）优先重封装为 M4A", () => {
    const plan = decideDecodePlan(req("/a.alac"), prefs, {
        capabilities: { apiLevel: 33 },
    });
    assert.equal(plan.strategy, "remux");
    assert.equal(plan.outputExt, ".m4a");
    assert.deepEqual(plan.ffmpegArgs, ["-c:a", "copy", "-f", "ipod"]);
});

test(SUITE, "ALAC：MP4 容器内 ALAC 在 API28+ 直接播放", () => {
    const plan = decideDecodePlan(
        req("/a.m4a", { probe: { codec: "alac", format: "mov,mp4,m4a" } }),
        prefs,
        { capabilities: { apiLevel: 33 } },
    );
    assert.equal(plan.strategy, "passthrough");
});

test(SUITE, "ALAC：低版本设备即使 MP4 容器也要重封装", () => {
    const plan = decideDecodePlan(
        req("/a.m4a", { probe: { codec: "alac", format: "mov,mp4,m4a" } }),
        prefs,
        { capabilities: { apiLevel: 26, alacNative: false } },
    );
    assert.equal(plan.strategy, "remux");
});

test(SUITE, "ALAC：不支持 remux 的容器走转码", () => {
    const plan = decideDecodePlan(
        req("/a.alac", { probe: { codec: "alac", format: "alac_raw" } }),
        prefs,
        { capabilities: { apiLevel: 33 } },
    );
    assert.equal(plan.strategy, "transcode");
    assert.equal(plan.outputExt, ".flac");
});

test(SUITE, "总开关关闭时所有格式都回退原生", () => {
    const off: IDecodePreferences = { ...prefs, enabled: false };
    for (const url of ["/a.ape", "/a.dsf", "/a.dff", "/a.alac"]) {
        assert.equal(decideDecodePlan(req(url), off).strategy, "passthrough", url);
    }
});

test(SUITE, "forceStrategy 生效", () => {
    assert.equal(
        decideDecodePlan(req("/a.mp3", { forceStrategy: "transcode" }), prefs).strategy,
        "transcode",
    );
});

test(SUITE, "probe 结果可以修正扩展名误判（扩展名是 aiff，实际是 ALAC/CAF）", () => {
    const plan = decideDecodePlan(
        req("/a.aiff", { probe: { codec: "alac", format: "caf" } }),
        prefs,
        { capabilities: { apiLevel: 33 } },
    );
    // 扩展名说是 AIFF，probe 说是 CAF 里的 ALAC：按 ALAC 画像处理
    assert.equal(plan.profile.ext, ".alac");
    assert.equal(plan.strategy, "remux");
    assert.equal(plan.outputExt, ".m4a");
});
