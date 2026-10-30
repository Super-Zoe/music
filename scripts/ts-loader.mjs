/**
 * Node ESM loader：让 node 能解析无扩展名的相对 import（RN/Metro 风格）。
 * 配合 `--experimental-strip-types` 直接运行 TS 测试，无需 babel / jest / node_modules。
 */

export async function resolve(specifier, context, nextResolve) {
    const isRelative =
        specifier.startsWith("./") ||
        specifier.startsWith("../") ||
        specifier.startsWith("/");

    if (!isRelative) {
        return nextResolve(specifier, context);
    }

    const candidates = [specifier, `${specifier}.ts`, `${specifier}.tsx`, `${specifier}/index.ts`];
    let lastError;
    for (const candidate of candidates) {
        try {
            return await nextResolve(candidate, context);
        } catch (e) {
            lastError = e;
        }
    }
    throw lastError;
}
