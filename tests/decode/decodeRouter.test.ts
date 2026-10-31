import assert from "node:assert/strict";
import { MemoryCacheStore } from "../../src/core/decode/memoryCache";
import { createDecodeRouter, needsDecode } from "../../src/core/decode/decodeRouter";
import { getDefaultPreferences } from "../../src/core/decode/decodePolicy";
import type {
    IDecodePreferences,
    IFFmpegDecoderNative,
    IProbeResult,
} from "../../src/core/decode/types";
import { test } from "./harness";

const SUITE = "解码路由";

interface IRecorder {
    probe: string[];
    transcode: Array<{ url: string; args: string[]; ext: string }>;
    startStream: Array<{ url: string; args: string[]; ext: string }>;
    stopStream: string[];
    cancel: string[];
}

/** 可控的原生桥替身 */
function mockNative(options: {
    probeResult?: IProbeResult | null;
    transcodeShouldThrow?: boolean;
    /** 仅在参数依赖 soxr 时抛错，用于模拟没有编译 libsoxr 的 ffmpeg */
    transcodeThrowOnSoxr?: boolean;
    /** remux 产物自检用的 probe：下标 0 为源探测，之后为产物探测 */
    probeQueue?: Array<IProbeResult | null>;
}) {
    const rec: IRecorder = {
        probe: [],
        transcode: [],
        startStream: [],
        stopStream: [],
        cancel: [],
    };
    let probeIndex = 0;
    const native: IFFmpegDecoderNative = {
        async getVersion() {
            return "jellyfin-ffmpeg 7.1.2-5";
        },
        async probe(url: string) {
            rec.probe.push(url);
            if (options.probeQueue) {
                return options.probeQueue[Math.min(probeIndex++, options.probeQueue.length - 1)];
            }
            return options.probeResult ?? null;
        },
        async transcode(url, args, ext) {
            rec.transcode.push({ url, args, ext });
            if (options.transcodeShouldThrow) {
                throw new Error("ffmpeg crash");
            }
            if (options.transcodeThrowOnSoxr && args.some(a => a.includes("resampler=soxr"))) {
                throw new Error("Cannot find aresampler resampler=soxr");
            }
            return `/cache/out${ext}`;
        },
        async startStream(url, args, ext) {
            rec.startStream.push({ url, args, ext });
            return "http://127.0.0.1:45631/stream.wav";
        },
        async stopStream(url) {
            rec.stopStream.push(url);
        },
        async cancel(url) {
            rec.cancel.push(url);
        },
    };
    return { native, rec };
}

function buildRouter(
    m: { native: IFFmpegDecoderNative; rec: IRecorder },
    overrides: Partial<IDecodePreferences> = {},
    fileSize?: number,
    available = true,
) {
    const prefs: IDecodePreferences = { ...getDefaultPreferences(), ...overrides };
    return createDecodeRouter({
        native: m.native,
        cache: new MemoryCacheStore(),
        prefs: () => prefs,
        statSize: async () => fileSize ?? null,
        capabilities: { apiLevel: 33 },
        isAvailable: async () => available,
    });
}

test(SUITE, "mp3 直接放行，完全不触碰原生模块", async () => {
    const m = mockNative({});
    const router = buildRouter(m);
    const res = await router.resolve({ url: "/a.mp3" });
    assert.equal(res.decoded, false);
    assert.equal(res.strategy, "passthrough");
    assert.equal(res.url, "/a.mp3");
    assert.equal(m.rec.probe.length, 0);
    assert.equal(m.rec.transcode.length, 0);
});

test(SUITE, "APE 转码并返回 file:// 地址", async () => {
    const m = mockNative({});
    const router = buildRouter(m, {}, 10 * 1024 * 1024);
    const res = await router.resolve({ url: "/a.ape" });
    assert.equal(res.decoded, true);
    assert.equal(res.strategy, "transcode");
    assert.equal(res.url, "file:///cache/out.flac");
    assert.equal(m.rec.transcode.length, 1);
    assert.equal(m.rec.transcode[0].ext, ".flac");
});

test(SUITE, "转码结果进缓存，第二次命中且不再调 ffmpeg", async () => {
    const m = mockNative({});
    const router = buildRouter(m, {}, 10 * 1024 * 1024);
    const first = await router.resolve({ url: "/a.ape" });
    const second = await router.resolve({ url: "/a.ape" });
    assert.equal(first.fromCache, false);
    assert.equal(second.fromCache, true);
    assert.equal(second.url, first.url);
    assert.equal(m.rec.transcode.length, 1);
});

test(SUITE, "DSF 大文件走流式，返回本地 http 地址", async () => {
    const m = mockNative({});
    const router = buildRouter(m, {}, 300 * 1024 * 1024);
    const res = await router.resolve({ url: "/a.dsf" });
    assert.equal(res.decoded, true);
    assert.equal(res.strategy, "stream");
    assert.equal(res.url, "http://127.0.0.1:45631/stream.wav");
    assert.equal(res.cachePath, null);
    assert.equal(m.rec.startStream.length, 1);
    assert.equal(m.rec.startStream[0].ext, ".wav");
});

test(SUITE, "ALAC remux 成功时直接返回产物", async () => {
    const m = mockNative({
        // 源探测 + remux 产物自检（时长 > 0 视为可播）
        probeQueue: [{ codec: "alac", format: "caf" }, { duration: 213 }],
    });
    const router = buildRouter(m, {}, 20 * 1024 * 1024);
    const res = await router.resolve({ url: "/a.alac" });
    assert.equal(res.strategy, "remux");
    assert.equal(res.url, "file:///cache/out.m4a");
    assert.equal(m.rec.transcode.length, 1);
    assert.deepEqual(m.rec.transcode[0].args, ["-c:a", "copy", "-f", "ipod"]);
});

test(SUITE, "ALAC remux 自检失败自动回退完整转码", async () => {
    const m = mockNative({
        // 产物自检拿不到时长 -> 判定 remux 产物不可用
        probeQueue: [{ codec: "alac", format: "caf" }, { duration: 0 }],
    });
    const router = buildRouter(m, {}, 20 * 1024 * 1024);
    const res = await router.resolve({ url: "/a.alac" });
    assert.equal(res.strategy, "transcode");
    assert.equal(res.url, "file:///cache/out.flac");
    assert.equal(m.rec.transcode.length, 2);
    assert.equal(m.rec.transcode[1].ext, ".flac");
});

test(SUITE, "ffmpeg 不可用时原样返回，不阻断播放", async () => {
    const m = mockNative({});
    const router = buildRouter(m, {}, 10 * 1024 * 1024, false);
    const res = await router.resolve({ url: "/a.ape" });
    assert.equal(res.decoded, false);
    assert.equal(res.url, "/a.ape");
    assert.equal(m.rec.transcode.length, 0);
});

test(SUITE, "总开关关闭时不做任何解码", async () => {
    const m = mockNative({});
    const router = buildRouter(m, { enabled: false }, 10 * 1024 * 1024);
    const res = await router.resolve({ url: "/a.dsf" });
    assert.equal(res.decoded, false);
    assert.equal(m.rec.probe.length, 0);
});

test(SUITE, "转码抛异常时回退原始地址", async () => {
    const m = mockNative({ transcodeShouldThrow: true });
    const router = buildRouter(m, {}, 10 * 1024 * 1024);
    const res = await router.resolve({ url: "/a.ape" });
    assert.equal(res.decoded, false);
    assert.equal(res.url, "/a.ape");
});

test(SUITE, "远端 http 源同样可被解码（如 WebDAV 上的 dsf）", async () => {
    const m = mockNative({});
    const router = buildRouter(m, {}, 300 * 1024 * 1024);
    const res = await router.resolve({
        url: "https://nas.example.com/music/track.dsf?sign=abc",
    });
    assert.equal(res.decoded, true);
    assert.equal(m.rec.startStream[0].url, "https://nas.example.com/music/track.dsf?sign=abc");
});

test(SUITE, "stopStream / cancel 透传到原生", async () => {
    const m = mockNative({});
    const router = buildRouter(m);
    await router.stopStream("/a.dsf");
    await router.cancel("/a.ape");
    assert.deepEqual(m.rec.stopStream, ["/a.dsf"]);
    assert.deepEqual(m.rec.cancel, ["/a.ape"]);
});

test(SUITE, "probe 只在需要的格式上触发", async () => {
    const m = mockNative({});
    const router = buildRouter(m);
    await router.resolve({ url: "/a.flac" });
    assert.equal(m.rec.probe.length, 0);
    await router.resolve({ url: "/a.ape" });
    assert.equal(m.rec.probe.length, 1);
});

test(SUITE, "无 libsoxr 的 ffmpeg：DSD 转码失败后自动降级重试", async () => {
    const m = mockNative({ transcodeThrowOnSoxr: true });
    const router = buildRouter(m, {}, 10 * 1024 * 1024);
    const res = await router.resolve({ url: "/a.dsf" });
    assert.equal(res.decoded, true);
    assert.equal(res.strategy, "transcode");
    assert.equal(m.rec.transcode.length, 2, "应当重试一次");
    assert.ok(m.rec.transcode[0].args.join(" ").includes("resampler=soxr"));
    const retry = m.rec.transcode[1].args.join(" ");
    assert.ok(!retry.includes("resampler=soxr"), "重试不该再用 soxr");
    assert.ok(retry.includes("aresample=filter_size=64"), "应换成内置重采样器");
});

test(SUITE, "降级也无法挽救时只尝试一次并回退", async () => {
    const m = mockNative({ transcodeShouldThrow: true });
    const router = buildRouter(m, {}, 10 * 1024 * 1024);
    // APE 的参数不含 soxr，没有可降级的空间
    const res = await router.resolve({ url: "/a.ape" });
    assert.equal(res.decoded, false, "失败应回退 passthrough");
    assert.equal(m.rec.transcode.length, 1, "无法降级则不应重试");
});

test(SUITE, "带 libsoxr 的 ffmpeg 不会触发多余重试", async () => {
    const m = mockNative({});
    const router = buildRouter(m, {}, 10 * 1024 * 1024);
    const res = await router.resolve({ url: "/a.dsf" });
    assert.equal(res.decoded, true);
    assert.equal(m.rec.transcode.length, 1);
    assert.ok(m.rec.transcode[0].args.join(" ").includes("resampler=soxr"));
});

test(SUITE, "needsDecode 轻量判定", () => {
    assert.equal(needsDecode("/a.dsf"), true);
    assert.equal(needsDecode("/a.ape"), true);
    assert.equal(needsDecode("/a.alac"), true);
    assert.equal(needsDecode("/a.mp3"), false);
    assert.equal(needsDecode(""), false);
});

test(SUITE, "缓存清理按上限回收", async () => {
    const cache = new MemoryCacheStore();
    await cache.commit("a", "/cache/a", 100);
    await cache.commit("b", "/cache/b", 100);
    await cache.commit("c", "/cache/c", 100);
    assert.equal(await cache.totalSize(), 300);
    await cache.trim(150);
    assert.ok((await cache.totalSize()) <= 150);
});
