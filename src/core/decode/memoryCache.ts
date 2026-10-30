/**
 * 缓存存储的内存实现
 *
 * 单独成文件：不引入 react-native，单测可直接 import。
 */

import type { ICacheStore } from "./types";

export class MemoryCacheStore implements ICacheStore {
    private entries = new Map<string, { path: string; size: number; atime: number }>();

    async resolve(key: string, ext: string): Promise<string> {
        return `/mock-cache/${key}${ext}`;
    }

    async get(key: string): Promise<string | null> {
        const entry = this.entries.get(key);
        if (!entry) {
            return null;
        }
        entry.atime = Date.now();
        return entry.path;
    }

    async commit(key: string, path: string, size = 0): Promise<void> {
        this.entries.set(key, { path, size, atime: Date.now() });
    }

    async remove(key: string): Promise<void> {
        this.entries.delete(key);
    }

    async totalSize(): Promise<number> {
        let total = 0;
        this.entries.forEach(e => (total += e.size));
        return total;
    }

    async trim(limitBytes: number): Promise<void> {
        const sorted = [...this.entries.entries()].sort(
            (a, b) => a[1].atime - b[1].atime,
        );
        let total = await this.totalSize();
        for (const [key, entry] of sorted) {
            if (total <= limitBytes) {
                break;
            }
            this.entries.delete(key);
            total -= entry.size;
        }
    }
}

export default MemoryCacheStore;
