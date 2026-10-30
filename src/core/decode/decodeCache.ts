/**
 * 转码产物缓存
 *
 * 转码结果落在应用缓存目录下的 ffmpeg-decode/，索引存 MMKV。
 * 索引记 path / size / atime：命中即复用，避免重复转码；
 * 超过用户设定的上限时按 LRU 清理。
 */

import pathConst from "@/constants/pathConst";
import { safeParse } from "@/utils/jsonUtil";
import { errorLog, trace } from "@/utils/log";
import getOrCreateMMKV from "@/utils/getOrCreateMMKV";
import { exists, mkdir, stat, unlink } from "react-native-fs";
import { buildCacheKey } from "./cacheKey";
import type { ICacheStore } from "./types";

export { buildCacheKey };
export { MemoryCacheStore } from "./memoryCache";

interface ICacheEntry {
    path: string;
    size: number;
    /** 最后访问时间，LRU 依据 */
    atime: number;
}

const CACHE_DIR = `${pathConst.cachePath}ffmpeg-decode/`;

const indexStore = () => getOrCreateMMKV("Decode.CacheIndex", true);

function readIndex(): Record<string, ICacheEntry> {
    const raw = indexStore().getString("index");
    if (!raw) {
        return {};
    }
    return (safeParse(raw) as Record<string, ICacheEntry>) ?? {};
}

function writeIndex(index: Record<string, ICacheEntry>) {
    indexStore().set("index", JSON.stringify(index));
}

let cacheDirReady: Promise<string> | null = null;

function ensureCacheDir(): Promise<string> {
    if (!cacheDirReady) {
        cacheDirReady = (async () => {
            if (!(await exists(CACHE_DIR))) {
                await mkdir(CACHE_DIR);
            }
            return CACHE_DIR;
        })();
    }
    return cacheDirReady;
}

async function safeStatSize(path: string): Promise<number> {
    try {
        const s = await stat(path);
        return Number((s as any)?.size ?? 0);
    } catch {
        return 0;
    }
}

class FileCacheStore implements ICacheStore {
    async resolve(key: string, ext: string): Promise<string> {
        await ensureCacheDir();
        return `${CACHE_DIR}${key}${ext}`;
    }

    async get(key: string): Promise<string | null> {
        try {
            const index = readIndex();
            const entry = index[key];
            if (!entry) {
                return null;
            }
            if (!(await exists(entry.path))) {
                delete index[key];
                writeIndex(index);
                return null;
            }
            entry.atime = Date.now();
            writeIndex(index);
            return entry.path;
        } catch (e) {
            errorLog("读取解码缓存失败", e);
            return null;
        }
    }

    async commit(key: string, path: string, size = 0): Promise<void> {
        const index = readIndex();
        index[key] = {
            path,
            size: size || (await safeStatSize(path)),
            atime: Date.now(),
        };
        writeIndex(index);
    }

    async remove(key: string): Promise<void> {
        const index = readIndex();
        const entry = index[key];
        if (!entry) {
            return;
        }
        try {
            if (await exists(entry.path)) {
                await unlink(entry.path);
            }
        } catch (e) {
            errorLog("删除解码缓存失败", e);
        }
        delete index[key];
        writeIndex(index);
    }

    async totalSize(): Promise<number> {
        const index = readIndex();
        return Object.values(index).reduce((sum, e) => sum + (e?.size ?? 0), 0);
    }

    async trim(limitBytes: number): Promise<void> {
        const index = readIndex();
        const entries = Object.entries(index)
            .filter(([, e]) => !!e?.path)
            .sort((a, b) => (a[1].atime ?? 0) - (b[1].atime ?? 0));
        let total = entries.reduce((sum, [, e]) => sum + (e?.size ?? 0), 0);
        if (total <= limitBytes) {
            return;
        }
        const removed: string[] = [];
        for (const [key, entry] of entries) {
            if (total <= limitBytes) {
                break;
            }
            removed.push(key);
            total -= entry.size ?? 0;
        }
        for (const key of removed) {
            await this.remove(key);
        }
        trace("解码缓存已清理", { removed: removed.length, total });
    }
}

export const decodeCache: ICacheStore = new FileCacheStore();

export default decodeCache;
