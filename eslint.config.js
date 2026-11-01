import js from '@eslint/js';
import globals from 'globals';
import prettier from 'eslint-config-prettier/flat';
import sonarjs from 'eslint-plugin-sonarjs';

export default [
  {
    ignores: [
      'node_modules/**',
      'extension/dist/**',
      'release/**',
      'dashcam/store/**',
      'references/**',
      '.qoder/**',
      // 非交付物、独立工程边界，从产品门禁中显式排除（降噪，与 .prettierignore 对齐）：
      //   tools/          —— 粘贴到 DevTools 控制台执行的一次性逆向探针脚本，不入扩展产物；
      //   warroom/        —— 独立 Node 分析子工程（自带 package.json + node_modules），各有工具链；
      //   .reviewtmp/     —— 本地评审/迁移草稿目录（已 .gitignore），内容多为产物快照与一次性脚本。
      'tools/**',
      'warroom/**',
      '.reviewtmp/**',
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
      // 存量代码降噪：这两类先降为警告，增量代码逐步清零；`_` 前缀参数表示契约需要但本实现故意不用
      'no-unused-vars': [
        'warn',
        { args: 'after-used', caughtErrors: 'none', argsIgnorePattern: '^_' },
      ],
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
        // 构建期 define 注入的授权常量（core/net-guard.js 统一收口，其余模块不直接引用）
        __LICENSE_HASH__: 'readonly',
        __LICENSE_SALT__: 'readonly',
        __LICENSE_FRIEND__: 'readonly',
        __PCC_VERSION__: 'readonly',
        // dev 调试探针编译期闸门（content.entry.js 引用，release 构建为 false）
        __DEVTOOLS__: 'readonly',
      },
    },
    rules: {
      // 允许 == null 惯用判空，其余要求严格相等
      eqeqeq: ['warn', 'smart'],
    },
  },

  // ---- Node 侧：dashcam 服务（ESM）与构建脚本 ----
  {
    files: ['dashcam/**/*.js', 'esbuild.config.mjs', 'scripts/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },

  // ---- 玩法层架构红线：禁止直接摸 window.pocketcc.*（绕过 dependency-cruiser 依赖图的影子总线）----
  // net/event/chat 一律走 reactor ctx（ctx.net/ctx.event/ctx.chat）或 import { netApi/chatApi } from core；
  // 其余跨玩法能力下沉 core。window.pocketccAntiThrottle 是另一个全局（反节流句柄），属性名不同故不受限。
  {
    files: ['extension/src/feats/**/*.js'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'MemberExpression[object.name="window"][property.name="pocketcc"], MemberExpression[object.name="globalThis"][property.name="pocketcc"]',
          message:
            '玩法层禁止直接摸 window.pocketcc.*（影子依赖，dep-cruiser 看不见）：net/event/chat 走 reactor ctx 或 import { netApi/eventApi/chatApi } from core，其余能力下沉 core。',
        },
      ],
    },
  },

  // ---- sonarjs 精选：只取对单人项目信噪比高的几条，覆盖重复/坏味道（不取整套 recommended：长函数密集易刷屏）----
  {
    files: ['extension/**/*.js', 'dashcam/**/*.js'],
    plugins: { sonarjs },
    rules: {
      'sonarjs/no-identical-functions': 'warn', // 函数体相同→该抽公共
      'sonarjs/no-duplicate-string': ['warn', { threshold: 4 }], // 同字面量≥4次→该提取常量
      'sonarjs/prefer-immediate-return': 'warn',
      // no-inverted-boolean-check 不启用：!(a<b)↔a>=b 属纯风格偏好，非质量问题，开启会刷 ~24 条噪声淹没信号
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

  // ---- tests：node:test 单测（驱动 extension/src 纯逻辑原语），跑在 Node ESM 环境 ----
  {
    files: ['tests/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },

  // ---- 必须居末：关闭与 Prettier 格式化冲突的风格规则（本仓自设规则均为防错类，不受影响）----
  prettier,
];
