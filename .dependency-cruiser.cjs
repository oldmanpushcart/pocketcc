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
  ],
  options: {
    // 纯 JS 工程零运行期依赖：不进 node_modules，只解 src 内 import 图
    doNotFollow: { path: 'node_modules' },
  },
};
