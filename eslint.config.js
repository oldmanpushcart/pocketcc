import js from '@eslint/js';
import globals from 'globals';

export default [
    {
        ignores: [
            'node_modules/**',
            'extension/dist/**',
            'dashcam/store/**',
            'references/**',
            '.qoder/**',
        ],
    },
    js.configs.recommended,

    // ---- 全仓规则调校（对应 pocketcc 既有工程约定）----
    {
        rules: {
            // 错误处理采用刻意的「吞异常降级」风格（扩展与 dashcam 均是），允许空 catch 块
            'no-empty': ['error', { allowEmptyCatch: true }],
            // 协议解析层故意使用 \x00/\x1e/\x1f 等控制字符作分隔符（chat-window.js、dashcam server）
            'no-control-regex': 'off',
            // 存量代码降噪：这两类先降为警告，增量代码逐步清零
            'no-unused-vars': ['warn', { args: 'after-used', caughtErrors: 'none' }],
            'no-useless-assignment': 'warn',
        },
    },

    // ---- 扩展侧：content/bridge 跑浏览器 MAIN+ISOLATED world，background 跑 MV3 service worker ----
    // __require / cc / CryptoJS 是游戏 bundle 注入 MAIN world 的全局符号（core/game.js、game-api.js、auto-login.js 裸用）
    {
        files: ['extension/**/*.js'],
        languageOptions: {
            ecmaVersion: 2024,
            sourceType: 'module',
            globals: {
                ...globals.browser,
                ...globals.webextensions,
                __require: 'readonly',
                cc: 'readonly',
                CryptoJS: 'readonly',
            },
        },
        rules: {
            // 允许 == null 惯用判空，其余要求严格相等
            'eqeqeq': ['warn', 'smart'],
            'no-console': 'off',
        },
    },

    // ---- Node 侧：dashcam 服务（ESM）与构建脚本 ----
    {
        files: ['dashcam/**/*.js', 'esbuild.config.mjs'],
        languageOptions: {
            ecmaVersion: 2024,
            sourceType: 'module',
            globals: { ...globals.node },
        },
    },

    // ---- CommonJS 脚本（*.cjs）一律 Node 环境 ----
    {
        files: ['**/*.cjs'],
        languageOptions: {
            ecmaVersion: 2024,
            sourceType: 'commonjs',
            globals: { ...globals.node },
        },
    },

    // ---- tools：粘贴到 DevTools 控制台执行的探针脚本，运行于页面 MAIN world ----
    {
        files: ['tools/**/*.js'],
        languageOptions: {
            ecmaVersion: 2024,
            sourceType: 'script',
            globals: {
                ...globals.browser,
                __require: 'readonly',
                cc: 'readonly',
                CryptoJS: 'readonly',
            },
        },
    },
];
