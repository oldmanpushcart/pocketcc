// 协议注册表 · shared 域 —— 机械抽取 + 人工标注（dir/note/src 重跑保留，usages 重跑重建）。
// 生成：node scripts/protocol/extract.mjs；闸门：tests/protocol-registry.test.js（npm test）。
// 条目键 = 协议号；名字是 feat 局部别名（同名异号是局部命名，非漂移）。只链不搬：src 指 references/ 出处。
export default [
  {
    cmd: 630,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_PLAYER_INFO',
        feat: 'auto-defense',
        file: 'feats/battle/auto-defense.js',
      },
      {
        name: 'CMD_PLAYER_INFO',
        feat: 'chat',
        file: 'feats/system/chat/context.js',
      },
      {
        name: 'CMD_PLAYER_INFO',
        feat: 'cs-hunt',
        file: 'feats/activity/cs-hunt/engine-team.js',
      },
      {
        name: 'CMD_PLAYER_INFO',
        feat: 'ui/field-types/uid-core',
        file: 'core/ui/field-types/uid-core.js',
      },
    ],
  },
  {
    cmd: 815,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_ITEM_USE',
        feat: 'auto-hunt',
        file: 'feats/player/auto-hunt.js',
      },
      {
        name: 'CMD_ITEM_USE',
        feat: 'cs-hunt',
        file: 'feats/activity/cs-hunt/constants.js',
      },
      {
        name: 'CMD_ITEM_USE',
        feat: 'quick-repair',
        file: 'feats/player/quick-repair.js',
      },
    ],
  },
  {
    cmd: 856,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_GET_ALL_MY_MARCH_INFO',
        feat: 'march',
        file: 'core/march.js',
      },
    ],
  },
  {
    cmd: 901,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_WORLD_INFO',
        feat: 'feast',
        file: 'feats/cq26/feast.js',
      },
      {
        name: 'CMD_GET_WORLD_INFO',
        feat: 'map',
        file: 'core/map.js',
      },
      {
        name: 'CMD_WORLD_INFO',
        feat: 'wl-chest',
        file: 'feats/cq26/wl-chest.js',
      },
      {
        name: 'CMD_WORLD_INFO',
        feat: 'wl-mine',
        file: 'feats/cq26/wl-mine/constants.js',
      },
    ],
  },
  {
    cmd: 902,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_MARCH_WORLD_POINT',
        feat: 'alliance-boss',
        file: 'feats/alliance/alliance-boss.js',
      },
      {
        name: 'CMD_MARCH_WORLD_POINT',
        feat: 'auto-defense',
        file: 'feats/battle/auto-defense.js',
      },
      {
        name: 'CMD_MARCH_WORLD_POINT',
        feat: 'auto-farm',
        file: 'feats/player/auto-farm/index.js',
      },
      {
        name: 'CMD_MARCH_WORLD_POINT',
        feat: 'auto-hunt',
        file: 'feats/player/auto-hunt.js',
      },
      {
        name: 'CMD_MARCH_WORLD_POINT',
        feat: 'domain-treasure',
        file: 'feats/activity/domain-treasure.js',
      },
      {
        name: 'CMD_MARCH_WORLD_POINT',
        feat: 'imperial-decree',
        file: 'feats/battle/imperial-decree.js',
      },
      {
        name: 'CMD_MARCH_WORLD_POINT',
        feat: 'launch-silo',
        file: 'feats/activity/launch-silo.js',
      },
      {
        name: 'CMD_MARCH_WORLD_POINT',
        feat: 'march',
        file: 'core/march.js',
      },
      {
        name: 'CMD_MARCH_WORLD_POINT',
        feat: 'mecha-treasure',
        file: 'feats/activity/mecha-treasure.js',
      },
      {
        name: 'CMD_MARCH_WORLD_POINT',
        feat: 'quick-attack',
        file: 'feats/battle/quick-attack.js',
      },
      {
        name: 'CMD_MARCH_POINT',
        feat: 'radar-task',
        file: 'feats/player/radar-task.js',
      },
      {
        name: 'CMD_MARCH_WORLD_POINT',
        feat: 'sea-treasure',
        file: 'feats/activity/sea-treasure.js',
      },
      {
        name: 'CMD_MARCH_WORLD_POINT',
        feat: 'source-of-war',
        file: 'feats/player/source-of-war/attack.js',
      },
    ],
  },
  {
    cmd: 904,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_RECALL_MARCH',
        feat: 'march',
        file: 'core/march.js',
      },
    ],
  },
  {
    cmd: 906,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_WORLD_SEARCH',
        feat: 'map',
        file: 'core/map.js',
      },
    ],
  },
  {
    cmd: 920,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_MARCH_SPEED_UP',
        feat: 'march',
        file: 'core/march.js',
      },
    ],
  },
  {
    cmd: 10007,
    dir: 'S2C',
    note: '',
    src: '',
    usages: [
      {
        name: 'PUSH_MARCH_INFO',
        feat: 'secret-realm',
        file: 'feats/activity/secret-realm/constants.js',
      },
      {
        name: 'PUSH_MARCH',
        feat: 'wl-mine',
        file: 'feats/cq26/wl-mine/constants.js',
      },
    ],
  },
  {
    cmd: 10018,
    dir: 'S2C',
    note: '',
    src: '',
    usages: [
      {
        name: 'PUSH_TILE',
        feat: 'feast',
        file: 'feats/cq26/feast.js',
      },
      {
        name: 'PUSH_TILEINFO',
        feat: 'mask-dance',
        file: 'feats/activity/mask-dance.js',
      },
      {
        name: 'PUSH_TILE_INFO',
        feat: 'secret-realm',
        file: 'feats/activity/secret-realm/constants.js',
      },
      {
        name: 'PUSH_TILE',
        feat: 'wl-chest',
        file: 'feats/cq26/wl-chest.js',
      },
    ],
  },
  {
    cmd: 10019,
    dir: 'S2C',
    note: '我方行军信息推送（全行军状态都推；CMD_ 前缀但是推送，启发式识别不了，人工实证标注）',
    src: '',
    usages: [
      {
        name: 'CMD_USER_MARCH_INFO',
        feat: 'march',
        file: 'core/march.js',
      },
      {
        name: 'CMD_USER_MARCH_INFO',
        feat: 'mecha-treasure',
        file: 'feats/activity/mecha-treasure.js',
      },
    ],
  },
  {
    cmd: 10021,
    dir: 'S2C',
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_PUSH_ENERGY',
        feat: 'alliance-behemoth',
        file: 'feats/alliance/alliance-behemoth.js',
      },
      {
        name: 'CMD_PUSH_ENERGY',
        feat: 'alliance-science',
        file: 'feats/alliance/alliance-science.js',
      },
      {
        name: 'PUSH_ENERGY',
        feat: 'auto-hunt',
        file: 'feats/player/auto-hunt.js',
      },
      {
        name: 'PUSH_ENERGY',
        feat: 'fear-star-rally',
        file: 'feats/player/fear-star-rally.js',
      },
      {
        name: 'PUSH_ENERGY',
        feat: 'radar-task',
        file: 'feats/player/radar-task.js',
      },
    ],
  },
];
