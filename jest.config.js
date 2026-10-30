module.exports = {
    preset: 'react-native',
    // tests/decode 是纯逻辑测试，由 `npm run test:decode` 直接用 node 跑，
    // 不需要 react-native preset 的运行时环境，这里排除避免重复执行。
    testPathIgnorePatterns: ['/node_modules/', '<rootDir>/tests/decode/'],
};
