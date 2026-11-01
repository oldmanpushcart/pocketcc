// dependency-cruiser —— pocketcc 分层架构闸门
// 把 pocketcc-extension skill 里的分层红线（依赖方向 feats→core 不可逆、feats 之间不互相 import）
// 从文档约定变成可执行检查：npm run arch
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: '循环依赖会让 reactor 装配顺序不可控',
      from: {},
      to: { circular: true },
    },
    {
      name: 'core-not-depend-on-feats',
      severity: 'error',
      comment: '依赖方向铁律：core 不得反向依赖 feats（当前基线为 0，守住）',
      from: { path: '^extension/src/core/' },
      to: { path: '^extension/src/feats/' },
    },
    {
      name: 'feat-not-depend-on-other-feat',
      severity: 'error',
      comment:
        '玩法之间不得互相 import，优先下沉 core 或走事件总线（当前基线为 0：地图共享真相已下沉 core/map.js，无跨玩法豁免）',
      from: { path: '^extension/src/feats/([^/]+)/' },
      to: {
        path: '^extension/src/feats/',
        // $1 = 发起方自己的玩法目录，同目录内部引用不算跨玩法
        pathNot: ['^extension/src/feats/$1/'],
      },
    },
    {
      name: 'no-external-runtime-deps',
      severity: 'error',
      comment:
        '扩展与 dashcam 运行期零第三方依赖（构建期 esbuild/eslint 等在 devDependencies，不在此路径）',
      from: { path: '^extension/src/' },
      to: { dependencyTypes: ['npm', 'npm-no-pkg', 'npm-unknown'] },
    },
    // ── 以下为 core 内部逻辑分层（把文件头注释里的边界约定升级为可执行闸门，当前基线均已成立）──
    {
      name: 'ui-only-boot-and-self',
      severity: 'error',
      comment:
        '面板 UI 框架（core/ui/）只由 boot.js 装配、仅 ui 目录内部互引；玩法不得 import core/ui（各自 overlay 自带样式）',
      from: {
        path: '^extension/src/',
        pathNot: ['^extension/src/core/ui/', '^extension/src/boot.js'],
      },
      to: { path: '^extension/src/core/ui/' },
    },
    {
      name: 'acl-not-depend-on-domain-or-net',
      severity: 'error',
      comment:
        'ACL 防腐层 core/game-api.js 只向下解游戏符号，不得反向依赖领域/网络模块（march/battle/map/defense/item/world-state/net/chat）',
      from: { path: '^extension/src/core/game-api.js$' },
      to: {
        path: '^extension/src/core/(march|battle|map|defense|item|world-state|chat|net|net-.*)\\.js$',
      },
    },
    {
      name: 'schedule-primitives-thin',
      severity: 'error',
      comment:
        '调度原语 cycle.js/drain.js 保持薄契约：除 log.js 外不得依赖其它 core 模块（退避/冷却/DSL 一律留给调用方）',
      from: { path: '^extension/src/core/(cycle|drain)\\.js$' },
      to: { path: '^extension/src/core/', pathNot: ['^extension/src/core/log\\.js$'] },
    },
  ],
  options: {
    // 纯 JS 工程零运行期依赖：不进 node_modules，只解 src 内 import 图
    doNotFollow: { path: 'node_modules' },
  },
};
