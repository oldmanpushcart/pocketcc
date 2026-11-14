// 协议注册表 · battle 域 —— 机械抽取 + 人工标注（dir/note/src 重跑保留，usages 重跑重建）。
// 生成：node scripts/protocol/extract.mjs；闸门：tests/protocol-registry.test.js（npm test）。
// 条目键 = 协议号；名字是 feat 局部别名（同名异号是局部命名，非漂移）。只链不搬：src 指 references/ 出处。
export default [
  {
    cmd: 910,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_PEACE_SHIELD',
        feat: 'auto-defense',
        file: 'feats/battle/auto-defense.js',
      },
    ],
  },
  {
    cmd: 911,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_MOVE_CITY_POSITION',
        feat: 'auto-defense',
        file: 'feats/battle/auto-defense.js',
      },
    ],
  },
  {
    cmd: 10167,
    dir: 'S2C',
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_PUSH_ATTACK_ARMIES',
        feat: 'auto-defense',
        file: 'feats/battle/auto-defense.js',
      },
    ],
  },
];
