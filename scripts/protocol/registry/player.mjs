// 协议注册表 · player 域 —— 机械抽取 + 人工标注（dir/note/src 重跑保留，usages 重跑重建）。
// 生成：node scripts/protocol/extract.mjs；闸门：tests/protocol-registry.test.js（npm test）。
// 条目键 = 协议号；名字是 feat 局部别名（同名异号是局部命名，非漂移）。只链不搬：src 指 references/ 出处。
export default [
  {
    cmd: 102,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_GET_ORDER',
        feat: 'auto-coin-collect',
        file: 'feats/player/auto-coin-collect.js',
      },
    ],
  },
  {
    cmd: 151,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_ORDER_QUEUE_ING_DONE',
        feat: 'quick-repair',
        file: 'feats/player/quick-repair.js',
      },
    ],
  },
  {
    cmd: 220,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_ARMY_HEAL_LIST',
        feat: 'quick-repair',
        file: 'feats/player/quick-repair.js',
      },
    ],
  },
  {
    cmd: 825,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_GET_TIME_REWARD',
        feat: 'daily-supply',
        file: 'feats/player/daily-supply.js',
      },
    ],
  },
  {
    cmd: 927,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_REPORT',
        feat: 'truck-intercept',
        file: 'feats/player/truck-intercept.js',
      },
    ],
  },
  {
    cmd: 999,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_POWER',
        feat: 'truck-intercept',
        file: 'feats/player/truck-intercept.js',
      },
    ],
  },
  {
    cmd: 1026,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_GET_JION_ALL_RCTIME',
        feat: 'fear-star-rally',
        file: 'feats/player/fear-star-rally.js',
      },
    ],
  },
  {
    cmd: 1031,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_GET_TOWER_LIST',
        feat: 'auto-farm',
        file: 'feats/player/auto-farm/mech-build.js',
      },
    ],
  },
  {
    cmd: 1032,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_TOWER_REMOVE',
        feat: 'auto-farm',
        file: 'feats/player/auto-farm/mech-build.js',
      },
    ],
  },
  {
    cmd: 1033,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_MARCH_WORLD_BUILD',
        feat: 'auto-farm',
        file: 'feats/player/auto-farm/mech-build.js',
      },
    ],
  },
  {
    cmd: 1034,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_GET_TOWERINFO',
        feat: 'auto-farm',
        file: 'feats/player/auto-farm/mech-build.js',
      },
      {
        name: 'CMD_GET_TOWERINFO',
        feat: 'auto-farm',
        file: 'feats/player/auto-farm/tower-scanner.js',
      },
    ],
  },
  {
    cmd: 1193,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_ALLIANCE_RECORD_DATA',
        feat: 'auto-farm',
        file: 'feats/player/auto-farm/tower-scanner.js',
      },
    ],
  },
  {
    cmd: 1201,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_CREATE_RALLY',
        feat: 'auto-hunt',
        file: 'feats/player/auto-hunt.js',
      },
      {
        name: 'CMD_CREATE_RALLY',
        feat: 'fear-star-rally',
        file: 'feats/player/fear-star-rally.js',
      },
      {
        name: 'CMD_CREATE_RALLY',
        feat: 'radar-task',
        file: 'feats/player/radar-task.js',
      },
    ],
  },
  {
    cmd: 1387,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_INFO',
        feat: 'potion-craft',
        file: 'feats/player/potion-craft.js',
      },
    ],
  },
  {
    cmd: 1388,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_MAKE',
        feat: 'potion-craft',
        file: 'feats/player/potion-craft.js',
      },
    ],
  },
  {
    cmd: 1397,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_CLAIM',
        feat: 'potion-craft',
        file: 'feats/player/potion-craft.js',
      },
    ],
  },
  {
    cmd: 1426,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_GET_CROSS_HOSPITAL_QUEUES',
        feat: 'quick-repair',
        file: 'feats/player/quick-repair.js',
      },
    ],
  },
  {
    cmd: 1427,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_ARMY_CROSS_HEAL',
        feat: 'quick-repair',
        file: 'feats/player/quick-repair.js',
      },
    ],
  },
  {
    cmd: 1428,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_SPEEDUP_CROSS_GOLD',
        feat: 'quick-repair',
        file: 'feats/player/quick-repair.js',
      },
    ],
  },
  {
    cmd: 1570,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_GET_INFO',
        feat: 'beast-breed',
        file: 'feats/player/beast-breed.js',
      },
    ],
  },
  {
    cmd: 1579,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_MAIN_SET',
        feat: 'beast-breed',
        file: 'feats/player/beast-breed.js',
      },
    ],
  },
  {
    cmd: 1580,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_OTHER_APPLY',
        feat: 'beast-breed',
        file: 'feats/player/beast-breed.js',
      },
    ],
  },
  {
    cmd: 1581,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_OTHER_APPLY_OP',
        feat: 'beast-breed',
        file: 'feats/player/beast-breed.js',
      },
    ],
  },
  {
    cmd: 1582,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_OTHER_APPLY_LIST',
        feat: 'beast-breed',
        file: 'feats/player/beast-breed.js',
      },
    ],
  },
  {
    cmd: 1583,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_MAIN_LIST',
        feat: 'beast-breed',
        file: 'feats/player/beast-breed.js',
      },
    ],
  },
  {
    cmd: 1584,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_BREEDING_BORN',
        feat: 'beast-breed',
        file: 'feats/player/beast-breed.js',
      },
    ],
  },
  {
    cmd: 1585,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_VISIT_LIST',
        feat: 'beast-breed',
        file: 'feats/player/beast-breed.js',
      },
    ],
  },
  {
    cmd: 1587,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_BREEDING_HELP',
        feat: 'beast-breed',
        file: 'feats/player/beast-breed.js',
      },
    ],
  },
  {
    cmd: 1599,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_HELP_BORN_REWARD',
        feat: 'beast-breed',
        file: 'feats/player/beast-breed.js',
      },
    ],
  },
  {
    cmd: 1643,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_PRODUCE',
        feat: 'armory-material',
        file: 'feats/player/armory-material.js',
      },
    ],
  },
  {
    cmd: 1645,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_PRODUCE_GET',
        feat: 'armory-material',
        file: 'feats/player/armory-material.js',
      },
    ],
  },
  {
    cmd: 1752,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_GET_CITY_SKILL_DATA',
        feat: 'city-skill',
        file: 'feats/player/city-skill.js',
      },
    ],
  },
  {
    cmd: 1753,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_USE_CITY_SKILL',
        feat: 'city-skill',
        file: 'feats/player/city-skill.js',
      },
    ],
  },
  {
    cmd: 1785,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_GET_QUICK_REPARE',
        feat: 'quick-repair',
        file: 'feats/player/quick-repair.js',
      },
    ],
  },
  {
    cmd: 3000,
    dir: 'S2C',
    note: '',
    src: '',
    usages: [
      {
        name: 'PUSH_DEBOUNCE_MS',
        feat: 'mine-cave',
        file: 'feats/player/mine-cave/mining.js',
      },
    ],
  },
  {
    cmd: 3504,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_GET_INFO',
        feat: 'radar-task',
        file: 'feats/player/radar-task.js',
      },
    ],
  },
  {
    cmd: 3505,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_START_TASK',
        feat: 'radar-task',
        file: 'feats/player/radar-task.js',
      },
    ],
  },
  {
    cmd: 3508,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_GET_REWARD',
        feat: 'radar-task',
        file: 'feats/player/radar-task.js',
      },
    ],
  },
  {
    cmd: 3515,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_DEFEND',
        feat: 'radar-task',
        file: 'feats/player/radar-task.js',
      },
    ],
  },
  {
    cmd: 3821,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_LIKE_OTHER',
        feat: 'player-like',
        file: 'feats/player/player-like.js',
      },
    ],
  },
  {
    cmd: 4168,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_COLLECT',
        feat: 'secret-weapon-drop',
        file: 'feats/player/secret-weapon-drop.js',
      },
    ],
  },
  {
    cmd: 4169,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_SKILL_INFO',
        feat: 'secret-weapon-drop',
        file: 'feats/player/secret-weapon-drop.js',
      },
    ],
  },
  {
    cmd: 4170,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_USE_SKILL',
        feat: 'secret-weapon-drop',
        file: 'feats/player/secret-weapon-drop.js',
      },
    ],
  },
  {
    cmd: 5684,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_INFO',
        feat: 'one-click-claim',
        file: 'feats/player/one-click-claim.js',
      },
    ],
  },
  {
    cmd: 5685,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_REWARD',
        feat: 'one-click-claim',
        file: 'feats/player/one-click-claim.js',
      },
    ],
  },
  {
    cmd: 6310,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_AVA_ASK',
        feat: 'quick-repair',
        file: 'feats/player/quick-repair.js',
      },
    ],
  },
  {
    cmd: 6311,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_AVA_CURE',
        feat: 'quick-repair',
        file: 'feats/player/quick-repair.js',
      },
    ],
  },
  {
    cmd: 6312,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_AVA_SPEED',
        feat: 'quick-repair',
        file: 'feats/player/quick-repair.js',
      },
    ],
  },
  {
    cmd: 6356,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_TM_ASK',
        feat: 'quick-repair',
        file: 'feats/player/quick-repair.js',
      },
    ],
  },
  {
    cmd: 6357,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_TM_CURE',
        feat: 'quick-repair',
        file: 'feats/player/quick-repair.js',
      },
    ],
  },
  {
    cmd: 6358,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_TM_SPEED',
        feat: 'quick-repair',
        file: 'feats/player/quick-repair.js',
      },
    ],
  },
  {
    cmd: 6473,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_OPEN',
        feat: 'truck-intercept',
        file: 'feats/player/truck-intercept.js',
      },
    ],
  },
  {
    cmd: 6474,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_RELOAD',
        feat: 'truck-intercept',
        file: 'feats/player/truck-intercept.js',
      },
    ],
  },
  {
    cmd: 6476,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_LOOT',
        feat: 'truck-intercept',
        file: 'feats/player/truck-intercept.js',
      },
    ],
  },
  {
    cmd: 6486,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_REFRESH',
        feat: 'truck-intercept',
        file: 'feats/player/truck-intercept.js',
      },
    ],
  },
  {
    cmd: 7414,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_OTHER_INFO',
        feat: 'mine-cave',
        file: 'feats/player/mine-cave/mining.js',
      },
    ],
  },
  {
    cmd: 7415,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_WORLD_INFO',
        feat: 'mine-cave',
        file: 'feats/player/mine-cave/steal-pack.js',
      },
    ],
  },
  {
    cmd: 7416,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_REFRESH',
        feat: 'mine-cave',
        file: 'feats/player/mine-cave/mining.js',
      },
    ],
  },
  {
    cmd: 7417,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_OCCUPY',
        feat: 'mine-cave',
        file: 'feats/player/mine-cave/mining.js',
      },
    ],
  },
  {
    cmd: 7418,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_HELP',
        feat: 'mine-cave',
        file: 'feats/player/mine-cave/steal-pack.js',
      },
    ],
  },
  {
    cmd: 7419,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_STEAL',
        feat: 'mine-cave',
        file: 'feats/player/mine-cave/steal-pack.js',
      },
    ],
  },
  {
    cmd: 7420,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_HELP_PACK',
        feat: 'mine-cave',
        file: 'feats/player/mine-cave/steal-pack.js',
      },
    ],
  },
  {
    cmd: 7421,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_SINGLE_INFO',
        feat: 'mine-cave',
        file: 'feats/player/mine-cave/mining.js',
      },
    ],
  },
  {
    cmd: 7422,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_REWARD',
        feat: 'mine-cave',
        file: 'feats/player/mine-cave/mining.js',
      },
    ],
  },
  {
    cmd: 7424,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_OTHER_GATHER_REWARD',
        feat: 'mine-cave',
        file: 'feats/player/mine-cave/mining.js',
      },
    ],
  },
  {
    cmd: 7425,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_OTHER_INFO2',
        feat: 'mine-cave',
        file: 'feats/player/mine-cave/mining.js',
      },
    ],
  },
  {
    cmd: 7427,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_CHECK_SHARE',
        feat: 'mine-cave',
        file: 'feats/player/mine-cave/mining.js',
      },
    ],
  },
  {
    cmd: 7428,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_SELF_INFO2',
        feat: 'mine-cave',
        file: 'feats/player/mine-cave/mining.js',
      },
    ],
  },
  {
    cmd: 7429,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_ALLIANCE_REWARD',
        feat: 'mine-cave',
        file: 'feats/player/mine-cave/mining.js',
      },
    ],
  },
  {
    cmd: 8403,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_MASTER_ASK',
        feat: 'quick-repair',
        file: 'feats/player/quick-repair.js',
      },
    ],
  },
  {
    cmd: 8404,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_MASTER_CURE',
        feat: 'quick-repair',
        file: 'feats/player/quick-repair.js',
      },
    ],
  },
  {
    cmd: 8405,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_MASTER_SPEED',
        feat: 'quick-repair',
        file: 'feats/player/quick-repair.js',
      },
    ],
  },
  {
    cmd: 9055,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_LEGEND_ASK',
        feat: 'quick-repair',
        file: 'feats/player/quick-repair.js',
      },
    ],
  },
  {
    cmd: 9056,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_LEGEND_CURE',
        feat: 'quick-repair',
        file: 'feats/player/quick-repair.js',
      },
    ],
  },
  {
    cmd: 9057,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_LEGEND_SPEED',
        feat: 'quick-repair',
        file: 'feats/player/quick-repair.js',
      },
    ],
  },
  {
    cmd: 9706,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_WATCH_INFO',
        feat: 'ad-diamond',
        file: 'feats/player/ad-diamond.js',
      },
    ],
  },
  {
    cmd: 9707,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_WATCH_REWARD',
        feat: 'ad-diamond',
        file: 'feats/player/ad-diamond.js',
      },
    ],
  },
  {
    cmd: 9884,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_GET_FREE_REWARD',
        feat: 'daily-deal',
        file: 'feats/player/daily-deal.js',
      },
    ],
  },
  {
    cmd: 9952,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_CLAIM_ATTACK_REWARD',
        feat: 'source-of-war',
        file: 'feats/player/source-of-war/reward.js',
      },
    ],
  },
  {
    cmd: 9956,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_GET_BOSS_INFO_V2',
        feat: 'source-of-war',
        file: 'feats/player/source-of-war/attack.js',
      },
    ],
  },
  {
    cmd: 10120,
    dir: 'S2C',
    note: '',
    src: '',
    usages: [
      {
        name: 'PUSH_ORDER_QUEUES',
        feat: 'quick-repair',
        file: 'feats/player/quick-repair.js',
      },
    ],
  },
  {
    cmd: 10130,
    dir: 'S2C',
    note: '',
    src: '',
    usages: [
      {
        name: 'PUSH_BEAST_CHANGE',
        feat: 'beast-breed',
        file: 'feats/player/beast-breed.js',
      },
    ],
  },
  {
    cmd: 10132,
    dir: 'S2C',
    note: '',
    src: '',
    usages: [
      {
        name: 'PUSH_BREEDING_CHANGE',
        feat: 'beast-breed',
        file: 'feats/player/beast-breed.js',
      },
    ],
  },
  {
    cmd: 10133,
    dir: 'S2C',
    note: '',
    src: '',
    usages: [
      {
        name: 'PUSH_OTHER_BREEDING',
        feat: 'beast-breed',
        file: 'feats/player/beast-breed.js',
      },
    ],
  },
  {
    cmd: 10182,
    dir: 'S2C',
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_PUSH_TOWER',
        feat: 'auto-farm',
        file: 'feats/player/auto-farm/mech-build.js',
      },
    ],
  },
  {
    cmd: 10264,
    dir: 'S2C',
    note: '',
    src: '',
    usages: [
      {
        name: 'PUSH_SINGLE_MAIL',
        feat: 'auto-farm',
        file: 'feats/player/auto-farm/lvl6-scanner.js',
      },
    ],
  },
  {
    cmd: 10452,
    dir: 'S2C',
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_PUSH_ALLIANCE_RECORD',
        feat: 'auto-farm',
        file: 'feats/player/auto-farm/mech-build.js',
      },
      {
        name: 'PUSH_ALLIANCE_RECORD',
        feat: 'auto-farm',
        file: 'feats/player/auto-farm/tower-scanner.js',
      },
    ],
  },
  {
    cmd: 10722,
    dir: 'S2C',
    note: '',
    src: '',
    usages: [
      {
        name: 'PUSH_MAKE',
        feat: 'potion-craft',
        file: 'feats/player/potion-craft.js',
      },
    ],
  },
  {
    cmd: 10802,
    dir: 'S2C',
    note: '',
    src: '',
    usages: [
      {
        name: 'PUSH_FIND_REFUGEECAMP',
        feat: 'auto-hunt',
        file: 'feats/player/auto-hunt.js',
      },
    ],
  },
  {
    cmd: 13006,
    dir: 'S2C',
    note: '',
    src: '',
    usages: [
      {
        name: 'PUSH_CROSS_QUEUE_ADD',
        feat: 'quick-repair',
        file: 'feats/player/quick-repair.js',
      },
    ],
  },
  {
    cmd: 20013,
    dir: 'S2C',
    note: '',
    src: '',
    usages: [
      {
        name: 'PUSH_STATUS_CHANGE',
        feat: 'radar-task',
        file: 'feats/player/radar-task.js',
      },
    ],
  },
  {
    cmd: 20015,
    dir: 'S2C',
    note: '',
    src: '',
    usages: [
      {
        name: 'PUSH_ADD_ONE_TASK',
        feat: 'radar-task',
        file: 'feats/player/radar-task.js',
      },
    ],
  },
  {
    cmd: 20016,
    dir: 'S2C',
    note: '',
    src: '',
    usages: [
      {
        name: 'PUSH_OTHER_DATA',
        feat: 'radar-task',
        file: 'feats/player/radar-task.js',
      },
    ],
  },
  {
    cmd: 20021,
    dir: 'S2C',
    note: '',
    src: '',
    usages: [
      {
        name: 'PUSH_SIGN',
        feat: 'radar-task',
        file: 'feats/player/radar-task.js',
      },
    ],
  },
  {
    cmd: 20025,
    dir: 'S2C',
    note: '',
    src: '',
    usages: [
      {
        name: 'PUSH_RING_CHANGE',
        feat: 'radar-task',
        file: 'feats/player/radar-task.js',
      },
    ],
  },
  {
    cmd: 20026,
    dir: 'S2C',
    note: '',
    src: '',
    usages: [
      {
        name: 'PUSH_DAYGROUP_CHANGE',
        feat: 'radar-task',
        file: 'feats/player/radar-task.js',
      },
    ],
  },
  {
    cmd: 21203,
    dir: 'S2C',
    note: '',
    src: '',
    usages: [
      {
        name: 'PUSH_AVA_HOSPITAL_CHANGE',
        feat: 'quick-repair',
        file: 'feats/player/quick-repair.js',
      },
    ],
  },
  {
    cmd: 21211,
    dir: 'S2C',
    note: '',
    src: '',
    usages: [
      {
        name: 'PUSH_TM_HOSPITAL_CHANGE',
        feat: 'quick-repair',
        file: 'feats/player/quick-repair.js',
      },
    ],
  },
  {
    cmd: 21351,
    dir: 'S2C',
    note: '',
    src: '',
    usages: [
      {
        name: 'PUSH_MINE_CAVE_CHANGE',
        feat: 'mine-cave',
        file: 'feats/player/mine-cave/mining.js',
      },
    ],
  },
  {
    cmd: 21465,
    dir: 'S2C',
    note: '',
    src: '',
    usages: [
      {
        name: 'PUSH_MASTER_HOSPITAL_CHANGE',
        feat: 'quick-repair',
        file: 'feats/player/quick-repair.js',
      },
    ],
  },
  {
    cmd: 21551,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_REFRESH_PUSH',
        feat: 'truck-intercept',
        file: 'feats/player/truck-intercept.js',
      },
    ],
  },
  {
    cmd: 21562,
    dir: 'S2C',
    note: '',
    src: '',
    usages: [
      {
        name: 'PUSH_LEGEND_HOSPITAL_CHANGE',
        feat: 'quick-repair',
        file: 'feats/player/quick-repair.js',
      },
    ],
  },
  {
    cmd: 21923,
    dir: 'S2C',
    note: '',
    src: '',
    usages: [
      {
        name: 'PUSH_SOW_ATTACK_COUNT_UPDATE',
        feat: 'source-of-war',
        file: 'feats/player/source-of-war/reward.js',
      },
    ],
  },
  {
    cmd: 21924,
    dir: 'S2C',
    note: '',
    src: '',
    usages: [
      {
        name: 'PUSH_SOW_DAY_RESET',
        feat: 'source-of-war',
        file: 'feats/player/source-of-war/reward.js',
      },
    ],
  },
];
