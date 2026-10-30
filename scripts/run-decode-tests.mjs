/**
 * 运行 tests/decode 下的纯逻辑测试。
 *
 *   node scripts/run-decode-tests.mjs
 *
 * 解码模块的策略层刻意不依赖 react-native，因此可以脱离模拟器与 node_modules 验证。
 */

import { register } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(path.join(__dirname, "ts-loader.mjs")).href);

const suites = [
    "./formats.test.ts",
    "./decodePolicy.test.ts",
    "./decodeRouter.test.ts",
];

for (const s of suites) {
    await import(new URL(`../tests/decode/${s.slice(2)}`, import.meta.url).href);
}

const { runAll } = await import(
    new URL("../tests/decode/harness.ts", import.meta.url).href
);

const { failed } = await runAll();
process.exit(failed === 0 ? 0 : 1);
