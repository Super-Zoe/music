/**
 * 缓存键生成
 *
 * 纯函数实现（FNV-1a 64 位），不引入 crypto 依赖，便于在 node 环境直接单测。
 * 缓存键只用于命中判断，不需要加密强度。
 */

/** FNV-1a 64bit，返回 16 进制字符串 */
export function fnv1a64(input: string): string {
    let hash = 0xcbf29ce484222325n;
    const prime = 0x100000001b3n;
    for (let i = 0; i < input.length; i++) {
        hash ^= BigInt(input.charCodeAt(i));
        hash = (hash * prime) & 0xffffffffffffffffn;
    }
    return hash.toString(16).padStart(16, "0");
}

/** 由"源地址 + 转码参数 + 目标容器"生成稳定缓存键 */
export function buildCacheKey(
    url: string,
    args: string[],
    outputExt = "",
): string {
    return fnv1a64(`${url}::${args.join(" ")}::${outputExt}`);
}

export default buildCacheKey;
