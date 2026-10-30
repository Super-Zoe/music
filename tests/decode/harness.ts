/**
 * 极简测试框架（零依赖）
 *
 * 解码模块的核心逻辑是纯 TS，不依赖 react-native，
 * 因此可以直接用 node --experimental-strip-types 跑，无需 jest / node_modules。
 */

export interface ICase {
    suite: string;
    name: string;
    fn: () => void | Promise<void>;
}

const cases: ICase[] = [];

export function test(suite: string, name: string, fn: () => void | Promise<void>) {
    cases.push({ suite, name, fn });
}

export function getCases(): ICase[] {
    return cases;
}

export async function runAll(): Promise<{ passed: number; failed: number }> {
    let passed = 0;
    let failed = 0;
    let lastSuite = "";
    for (const c of cases) {
        if (c.suite !== lastSuite) {
            lastSuite = c.suite;
            console.log(`\n── ${c.suite} ──`);
        }
        try {
            await c.fn();
            passed++;
            console.log(`  ✓ ${c.name}`);
        } catch (e: any) {
            failed++;
            console.log(`  ✗ ${c.name}`);
            console.log(`      ${e?.message ?? e}`);
        }
    }
    console.log(`\n合计：${passed} 通过 / ${failed} 失败\n`);
    return { passed, failed };
}
