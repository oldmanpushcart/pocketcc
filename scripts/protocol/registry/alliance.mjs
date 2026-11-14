// 协议注册表 · alliance 域 —— 机械抽取 + 人工标注（dir/note/src 重跑保留，usages 重跑重建）。
// 生成：node scripts/protocol/extract.mjs；闸门：tests/protocol-registry.test.js（npm test）。
// 条目键 = 协议号；名字是 feat 局部别名（同名异号是局部命名，非漂移）。只链不搬：src 指 references/ 出处。
export default [
  {
    cmd: 1067,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_DONATE_RELIC',
        feat: 'alliance-science',
        file: 'feats/alliance/alliance-science.js',
      },
    ],
  },
  {
    cmd: 1139,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_ALLIANCE_HELP_APPLY',
        feat: 'alliance-help',
        file: 'feats/alliance/alliance-help.js',
      },
    ],
  },
  {
    cmd: 1141,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_ALLIANCE_HELP_RECEIVE',
        feat: 'alliance-help',
        file: 'feats/alliance/alliance-help.js',
      },
    ],
  },
  {
    cmd: 1144,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_DONATE',
        feat: 'alliance-science',
        file: 'feats/alliance/alliance-science.js',
      },
    ],
  },
  {
    cmd: 1160,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_GET_INFO',
        feat: 'alliance-boss',
        file: 'feats/alliance/alliance-boss.js',
      },
    ],
  },
  {
    cmd: 1161,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_DONATE',
        feat: 'alliance-boss',
        file: 'feats/alliance/alliance-boss.js',
      },
    ],
  },
  {
    cmd: 1177,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_RECEIVE_GIFT_ALL',
        feat: 'alliance-gift',
        file: 'feats/alliance/alliance-gift.js',
      },
    ],
  },
  {
    cmd: 1178,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_RECEIVE_GIFT_BIG',
        feat: 'alliance-gift',
        file: 'feats/alliance/alliance-gift.js',
      },
    ],
  },
  {
    cmd: 1195,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_HELP_ALL_ALLIANCE_MEMBERS',
        feat: 'alliance-help',
        file: 'feats/alliance/alliance-help.js',
      },
    ],
  },
  {
    cmd: 1204,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_ASSEMBLY_JOIN',
        feat: 'alliance-rally',
        file: 'feats/alliance/alliance-rally.js',
      },
    ],
  },
  {
    cmd: 1825,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_QUERY',
        feat: 'relic-reward',
        file: 'feats/alliance/relic-reward.js',
      },
    ],
  },
  {
    cmd: 1826,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_CLAIM',
        feat: 'relic-reward',
        file: 'feats/alliance/relic-reward.js',
      },
    ],
  },
  {
    cmd: 7102,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_DONATE',
        feat: 'alliance-behemoth',
        file: 'feats/alliance/alliance-behemoth.js',
      },
    ],
  },
  {
    cmd: 10435,
    dir: 'S2C',
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_PUSH_ALLIANCE_BOSS',
        feat: 'alliance-boss',
        file: 'feats/alliance/alliance-boss.js',
      },
    ],
  },
  {
    cmd: 10442,
    dir: 'S2C',
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_PUSH_ALLIANCE_GIFT_INFO',
        feat: 'alliance-gift',
        file: 'feats/alliance/alliance-gift.js',
      },
    ],
  },
  {
    cmd: 10446,
    dir: 'S2C',
    note: '',
    src: '',
    usages: [
      {
        name: 'PUSH_ALLIANCE_SELF_HELP',
        feat: 'alliance-help',
        file: 'feats/alliance/alliance-help.js',
      },
    ],
  },
  {
    cmd: 10453,
    dir: 'S2C',
    note: '',
    src: '',
    usages: [
      {
        name: 'PUSH_ALLIANCE_HELP_REGET',
        feat: 'alliance-help',
        file: 'feats/alliance/alliance-help.js',
      },
    ],
  },
  {
    cmd: 12003,
    dir: 'S2C',
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_PUSH_ASSEMBLY_CREATED',
        feat: 'alliance-rally',
        file: 'feats/alliance/alliance-rally.js',
      },
    ],
  },
];
