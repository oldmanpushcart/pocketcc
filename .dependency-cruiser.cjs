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
      comment:
        '依赖方向铁律：core 不得反向依赖 feats（解耦试点 re-export 薄壳已收回，基线重新为 0，守住）',
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
        'ACL 防腐层（core/acl/ 域切片 + core/game-api.js 组装薄壳 + core/acl-engine.js 引擎核）只向下解游戏符号，' +
        '不得反向依赖领域/网络模块（march/battle/map/defense/item/world/state/net/chat）',
      from: { path: '^extension/src/core/(game-api|acl-engine)[.]js$|^extension/src/core/acl/' },
      to: {
        path: '^extension/src/core/(march|battle|map|defense|item|world/state|chat|net|net-.*)[.]js$',
      },
    },
    {
      name: 'feat-acl-adapters-not-depend-on-domain-or-net',
      severity: 'error',
      comment:
        '下沉到 feats 的活动 ACL 适配器（secret-realm/cs-hunt 的 api.js）同样不得 import 领域/网络模块：' +
        'net.Ret 归一等只经 window.pocketcc 运行期懒取（与拆分前 game-api 区段同口径），保持防腐层纯度',
      from: {
        path: '^extension/src/feats/activity/(secret-realm|cs-hunt)/api[.]js$',
      },
      to: {
        path: '^extension/src/core/(march|battle|map|defense|item|world/state|chat|net|net-.*)[.]js$',
      },
    },
    {
      name: 'schedule-primitives-thin',
      severity: 'error',
      comment:
        '调度原语 cycle.js/drain.js/snapshot-pool.js 与上下文工厂 feat-ctx.js 保持薄契约：除 log.js 外不得依赖其它 core 模块' +
        '（退避/冷却/DSL 一律留给调用方；feat-ctx 依赖全经 deps 注入，零 import）',
      from: { path: '^extension/src/core/(cycle|drain|snapshot-pool|feat-ctx)\\.js$' },
      to: { path: '^extension/src/core/', pathNot: ['^extension/src/core/log\\.js$'] },
    },
    {
      name: 'tier0-not-depend-on-domain',
      severity: 'error',
      comment:
        '阶段四 Tier0/1 领域隔离：基建层（bus/reactor/registry/hotkeys）不得 import 真领域归一层' +
        '（world/state/march/battle/map/defense/item）——热键门控改读 world/contracts 纯词表 + bus world.change 镜像；' +
        'acl 产物（game-api/acl/）、net/chat/scene-watcher 等基建按本口径豁免',
      from: { path: '^extension/src/core/(bus|reactor|registry|hotkeys)[.]js$' },
      to: { path: '^extension/src/core/(world/state|march|battle|map|defense|item)[.]js$' },
    },
  ],
  options: {
    // 纯 JS 工程零运行期依赖：不进 node_modules，只解 src 内 import 图
    doNotFollow: { path: 'node_modules' },
    // 图规模机器提醒不在本配置里（本版 schema 不收 maxNodes）：由 scripts/arch-size-guard.mjs
    // 在 npm run arch 尾部把守——节点数超 500 输出 warning（不阻断），提醒「该拆了」
  },
};
