// 协议注册表 · battle 域 —— 机械抽取 + 人工标注（dir/note/src/fields 重跑保留，usages 重跑重建）。
// 生成：node scripts/protocol/extract.mjs；闸门：tests/protocol-registry.test.js（npm test）。
// 条目键 = 协议号；名字是 feat 局部别名（同名异号是局部命名，非漂移）。src 为人工标注的出处说明，渐进补充。
export default [
  {
    cmd: 910,
    dir: 'C2S',
    note: '开护盾（背包道具 isPurchase:0；拒 status=3+war_fever_003/kingdom_077）',
    src: '',
    fields: '',
    usages: [
      {
        name: 'CMD_PEACE_SHIELD',
        feat: 'auto-defense',
        file: 'feats/battle/auto-defense/constants.js',
      },
    ],
  },
  {
    cmd: 911,
    dir: 'C2S',
    note: '迁城到指定坐标（背包迁城卡，{itemId,amount:1,isPurchase:0,x,y}）',
    src: '',
    fields: '',
    usages: [
      {
        name: 'CMD_MOVE_CITY_POSITION',
        feat: 'auto-defense',
        file: 'feats/battle/auto-defense/constants.js',
      },
    ],
  },
  {
    cmd: 10167,
    dir: 'S2C',
    note: 'push 被攻击军队（来袭预警：{uid,attackState 1来袭/0结束,level,arrivalTime,marchId}）',
    src: '',
    fields: '',
    usages: [
      {
        name: 'CMD_PUSH_ATTACK_ARMIES',
        feat: 'auto-defense',
        file: 'feats/battle/auto-defense/constants.js',
      },
    ],
  },
];
