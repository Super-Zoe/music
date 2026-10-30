#!/usr/bin/env node
/**
 * 拉取 Jellyfin FFmpeg 产物并放置到 android/app/src/main/jniLibs/<abi>/libjellyfin_ffmpeg.so
 *
 * 用法：
 *   node scripts/fetch-jellyfin-ffmpeg.mjs                      # 按 manifest / 上游 release 自动解析
 *   node scripts/fetch-jellyfin-ffmpeg.mjs --abi arm64-v8a      # 只拉指定 ABI
 *   node scripts/fetch-jellyfin-ffmpeg.mjs --url <tarball> --sha256 <hex> --abi arm64-v8a
 *   node scripts/fetch-jellyfin-ffmpeg.mjs --local ./ffmpeg     # 直接使用本地已编译好的可执行文件
 *
 * 说明：
 *   上游 jellyfin/jellyfin-ffmpeg 目前只发布 Linux/Windows/macOS 的安装包，
 *   **不提供 Android 产物**。脚本会先尝试上游 release，找不到 Android 资产时
 *   直接给出交叉编译指引（docs/BUILD.md），不会静默下载不匹配平台的二进制。
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const JNI_DIR = path.join(ROOT, "android/app/src/main/jniLibs");
const MANIFEST = path.join(__dirname, "jellyfin-ffmpeg.manifest.json");

const ALL_ABIS = ["arm64-v8a", "armeabi-v7a", "x86", "x86_64"];
const UPSTREAM_REPO = "jellyfin/jellyfin-ffmpeg";

function parseArgs(argv) {
    const args = {
        abis: null,
        url: null,
        sha256: null,
        local: null,
        version: null,
        force: false,
        help: false,
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        switch (a) {
            case "--abi":
            case "--abis":
                args.abis = (argv[++i] ?? "").split(",").map(s => s.trim()).filter(Boolean);
                break;
            case "--url":
                args.url = argv[++i] ?? null;
                break;
            case "--sha256":
                args.sha256 = argv[++i] ?? null;
                break;
            case "--local":
                args.local = argv[++i] ?? null;
                break;
            case "--version":
                args.version = argv[++i] ?? null;
                break;
            case "--force":
                args.force = true;
                break;
            case "-h":
            case "--help":
                args.help = true;
                break;
            default:
                throw new Error(`未知参数: ${a}`);
        }
    }
    return args;
}

function log(msg) {
    console.log(`[ffmpeg] ${msg}`);
}

function fail(msg) {
    console.error(`[ffmpeg] ✗ ${msg}`);
    process.exit(1);
}

function sha256File(file) {
    const h = createHash("sha256");
    h.update(fs.readFileSync(file));
    return h.digest("hex");
}

/** 解包：优先用系统 tar（bsdtar 同时支持 zip），失败回退 python zipfile */
function extract(archive, destDir) {
    fs.mkdirSync(destDir, { recursive: true });
    try {
        execFileSync("tar", ["-xf", archive, "-C", destDir], { stdio: "ignore" });
        return;
    } catch {
        /* 继续尝试 python */
    }
    try {
        execFileSync(process.platform === "win32" ? "python" : "python3", [
            "-m", "zipfile", "-e", archive, destDir,
        ], { stdio: "ignore" });
    } catch (e) {
        throw new Error(`解包失败（tar 与 zipfile 均不可用）: ${archive}`);
    }
}

/** 递归找出可执行文件 */
function findExecutable(dir) {
    const stack = [dir];
    while (stack.length) {
        const cur = stack.pop();
        for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
            const full = path.join(cur, entry.name);
            if (entry.isDirectory()) {
                stack.push(full);
                continue;
            }
            if (/^(ffmpeg|jellyfin[-_]ffmpeg.*)$/.test(entry.name)) {
                return full;
            }
        }
    }
    return null;
}

function install(localBinary, abi) {
    const targetDir = path.join(JNI_DIR, abi);
    const target = path.join(targetDir, "libjellyfin_ffmpeg.so");
    fs.mkdirSync(targetDir, { recursive: true });
    fs.copyFileSync(localBinary, target);
    log(`✓ ${abi} -> ${path.relative(ROOT, target)} (${(fs.statSync(target).size / 1024 / 1024).toFixed(1)} MB)`);
}

function resolveFromManifest(abi) {
    if (!fs.existsSync(MANIFEST)) {
        return null;
    }
    const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
    const entry = manifest?.abis?.[abi];
    if (entry?.url) {
        return { url: entry.url, sha256: entry.sha256 || null, version: manifest.version };
    }
    return null;
}

async function resolveFromUpstream(abi, version) {
    const api = version
        ? `https://api.github.com/repos/${UPSTREAM_REPO}/releases/tags/v${version}`
        : `https://api.github.com/repos/${UPSTREAM_REPO}/releases/latest`;
    const res = await fetch(api, {
        headers: { Accept: "application/vnd.github+json", "User-Agent": "MusicFree-HiRes" },
    });
    if (!res.ok) {
        throw new Error(`查询上游 release 失败：HTTP ${res.status}`);
    }
    const json = await res.json();
    const assets = json?.assets ?? [];
    const abiTokens = {
        "arm64-v8a": ["android", "arm64", "aarch64"],
        "armeabi-v7a": ["android", "armv7", "armhf", "armeabi"],
        "x86": ["android", "i686", "x86"],
        "x86_64": ["android", "x86_64", "amd64"],
    }[abi] ?? [];
    const hit = assets.find(a =>
        abiTokens.every(t => a.name.toLowerCase().includes(t)),
    );
    return { release: json, asset: hit ?? null };
}

async function download(url, dest) {
    log(`下载 ${url}`);
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) {
        throw new Error(`下载失败：HTTP ${res.status}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(dest, buf);
    return dest;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        console.log(fs.readFileSync(path.join(__dirname, "fetch-jellyfin-ffmpeg.mjs"), "utf8")
            .split("*/")[0].replace(/^\/\*!?/, ""));
        return;
    }

    const abis = args.abis ?? ALL_ABIS;
    for (const abi of abis) {
        if (!ALL_ABIS.includes(abi)) {
            fail(`不支持的 ABI: ${abi}（可选 ${ALL_ABIS.join(", ")}）`);
        }
    }

    // 1. 直接使用本地可执行文件
    if (args.local) {
        const bin = path.resolve(args.local);
        if (!fs.existsSync(bin)) {
            fail(`本地文件不存在: ${bin}`);
        }
        for (const abi of abis) {
            install(bin, abi);
        }
        return;
    }

    for (const abi of abis) {
        const target = path.join(JNI_DIR, abi, "libjellyfin_ffmpeg.so");
        if (fs.existsSync(target) && !args.force) {
            log(`${abi} 已存在，跳过（如需覆盖加 --force）`);
            continue;
        }

        // 2. 命令行显式指定
        let source = args.url
            ? { url: args.url, sha256: args.sha256, version: args.version }
            : resolveFromManifest(abi);

        // 3. 上游 release
        if (!source?.url) {
            const up = await resolveFromUpstream(abi, args.version ?? source?.version ?? null);
            if (up?.asset) {
                source = { url: up.asset.browser_download_url, sha256: null, version: up.release.tag_name };
            } else {
                fail(
                    `上游 ${UPSTREAM_REPO} 未提供 ${abi} 的 Android 产物。\n` +
                    `        请任选其一：\n` +
                    `        1) 按 docs/BUILD.md 用 NDK 交叉编译 Jellyfin FFmpeg，然后\n` +
                    `           node scripts/fetch-jellyfin-ffmpeg.mjs --local <产物路径> --abi ${abi}\n` +
                    `        2) 在 scripts/jellyfin-ffmpeg.manifest.json 填入可用的 url + sha256\n` +
                    `        3) 直接传 --url <压缩包地址> --sha256 <校验值>`,
                );
            }
        }

        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jf-ffmpeg-"));
        const archive = path.join(tmp, path.basename(new URL(source.url).pathname) || "download.bin");
        await download(source.url, archive);

        if (source.sha256) {
            const actual = sha256File(archive);
            if (actual !== source.sha256.toLowerCase()) {
                fail(`SHA256 校验失败\n  期望 ${source.sha256}\n  实际 ${actual}`);
            }
            log("✓ SHA256 校验通过");
        } else {
            log("⚠ 未提供 SHA256，跳过校验");
        }

        const extracted = path.join(tmp, "out");
        extract(archive, extracted);
        const bin = findExecutable(extracted) ?? (fs.existsSync(archive) && !/\.(zip|tar|gz|tgz|xz)$/i.test(archive) ? archive : null);
        if (!bin) {
            fail(`压缩包中未找到 ffmpeg 可执行文件: ${source.url}`);
        }
        install(bin, abi);
        fs.rmSync(tmp, { recursive: true, force: true });
    }

    log("完成。构建 APK 前请确认 android/app/build.gradle 中 abi splits 与已下载产物一致。");
}

main().catch(e => fail(e?.stack ?? String(e)));
