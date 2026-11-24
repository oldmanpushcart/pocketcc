// 协议注册表 · shared 域 —— 机械抽取 + 人工标注（dir/note/src/fields 重跑保留，usages 重跑重建）。
// 生成：node scripts/protocol/extract.mjs；闸门：tests/protocol-registry.test.js（npm test）。
// 条目键 = 协议号；名字是 feat 局部别名（同名异号是局部命名，非漂移）。src 为人工标注的出处说明，渐进补充。
export default [
  {
    cmd: 630,
    dir: 'C2S',
    note: '按 uid 查玩家基础信息（顶层 x/y 主城坐标/power/level/allianceName，视口无关 Home 可查）',
    src: '',
    fields: '',
    usages: [
      {
        name: 'CMD_PLAYER_INFO',
        feat: 'auto-defense',
        file: 'feats/battle/auto-defense/constants.js',
      },
      {
        name: 'CMD_PLAYER_INFO',
        feat: 'chat',
        file: 'feats/system/chat/constants.js',
      },
      {
        name: 'CMD_PLAYER_INFO',
        feat: 'cs-hunt',
        file: 'feats/activity/cs-hunt/constants.js',
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
    dir: 'C2S',
    note: '使用背包道具（JSON send 非 PB，{itemid,amount}；补充体力等）',
    src: '',
    fields:
      "req {itemid,amount[,param]}（JSON send；医院加速带 param='1|…'/数字串）→ resp {amount,itemId} 剩余持有；夺宝体力药仅 {amount,itemid}",
    usages: [
      {
        name: 'CMD_ITEM_USE',
        feat: 'auto-hunt',
        file: 'feats/player/auto-hunt/constants.js',
      },
      {
        name: 'CMD_ITEM_USE',
        feat: 'cs-hunt',
        file: 'feats/activity/cs-hunt/constants.js',
      },
      {
        name: 'CMD_ITEM_USE',
        feat: 'quick-repair',
        file: 'feats/player/quick-repair/constants.js',
      },
    ],
  },
  {
    cmd: 841,
    dir: 'C2S',
    note: '活动数据总查询（GET_ACTIVITY_DATA，req {}；resp {alist:[{type,id,alMonsterSiege,atarget,…}]}，type26=联盟保卫战，.id=活动 aid）',
    src: '',
    fields: 'alist',
    usages: [
      {
        name: 'CMD_GET_ACTIVITY_DATA',
        feat: 'alliance-defender',
        file: 'feats/alliance/alliance-defender/constants.js',
      },
      {
        name: 'CMD_GET_ACTIVITY_DATA',
        feat: 'titan-blessing',
        file: 'feats/activity/titan-blessing/constants.js',
      },
    ],
  },
  {
    cmd: 856,
    dir: 'C2S',
    note: '全量本人行军（视口无关 Home 亦有）——行军列表权威源',
    src: '',
    fields: '',
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
    dir: 'C2S',
    note: '视口地块拉取（客户端自报 x/y/width/height）；315/310 地块 m.specIndex/leftTimes 唯一通道',
    src: '',
    fields:
      'req {x,y,k,rid,width,height,marchInfo,viewLevel}（x,y=回点区中心，窗口硬上限≈117×78）→ resp {pointList[],iceList[]}（仅 resp 带，req:send 不带）；315/310 行 m.specIndex/leftTimes，iceList[].initSid 老家服，p.shieldTime 秒级',
    usages: [
      {
        name: 'CMD_WORLD_INFO',
        feat: 'feast',
        file: 'feats/cq26/feast/constants.js',
      },
      {
        name: 'CMD_GET_WORLD_INFO',
        feat: 'map',
        file: 'core/map.js',
      },
      {
        name: 'CMD_WORLD_INFO',
        feat: 'wl-chest',
        file: 'feats/cq26/wl-chest/constants.js',
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
    dir: 'C2S',
    note: '世界地图行军（攻打机甲 marchType=18；亦作同 cmd 在途频控判据）',
    src: '',
    fields:
      'req {marchType,x,y,armyList,armyListNew,heroList,…}（机甲 18/雷达族各型）→ resp {status,marchInfo}',
    usages: [
      {
        name: 'CMD_MARCH_WORLD_POINT',
        feat: 'alliance-boss',
        file: 'feats/alliance/alliance-boss/constants.js',
      },
      {
        name: 'CMD_MARCH_WORLD_POINT',
        feat: 'auto-defense',
        file: 'feats/battle/auto-defense/constants.js',
      },
      {
        name: 'CMD_MARCH_WORLD_POINT',
        feat: 'auto-farm',
        file: 'feats/player/auto-farm/constants.js',
      },
      {
        name: 'CMD_MARCH_WORLD_POINT',
        feat: 'auto-hunt',
        file: 'feats/player/auto-hunt/constants.js',
      },
      {
        name: 'CMD_MARCH_WORLD_POINT',
        feat: 'domain-treasure',
        file: 'feats/activity/domain-treasure/constants.js',
      },
      {
        name: 'CMD_MARCH_WORLD_POINT',
        feat: 'imperial-decree',
        file: 'feats/battle/imperial-decree/constants.js',
      },
      {
        name: 'CMD_MARCH_WORLD_POINT',
        feat: 'launch-silo',
        file: 'feats/activity/launch-silo/constants.js',
      },
      {
        name: 'CMD_MARCH_WORLD_POINT',
        feat: 'march',
        file: 'core/march.js',
      },
      {
        name: 'CMD_MARCH_WORLD_POINT',
        feat: 'mecha-treasure',
        file: 'feats/activity/mecha-treasure/constants.js',
      },
      {
        name: 'CMD_MARCH_WORLD_POINT',
        feat: 'quick-attack',
        file: 'feats/battle/quick-attack/constants.js',
      },
      {
        name: 'CMD_MARCH_POINT',
        feat: 'radar-task',
        file: 'feats/player/radar-task/constants.js',
      },
      {
        name: 'CMD_MARCH_WORLD_POINT',
        feat: 'sea-treasure',
        file: 'feats/activity/sea-treasure/constants.js',
      },
      {
        name: 'CMD_MARCH_WORLD_POINT',
        feat: 'source-of-war',
        file: 'feats/player/source-of-war/constants.js',
      },
    ],
  },
  {
    cmd: 904,
    dir: 'C2S',
    note: '撤回单条行军（{marchId}；撤回不立即释放名额，需返程 state=4）',
    src: '',
    fields: '',
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
    dir: 'C2S',
    note: '世界搜索可交互点（按 groupType/等级区间/pointType，视口无关）',
    src: '',
    fields: '',
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
    dir: 'C2S',
    note: '对一条在途行军使用加速道具（{marchId,itemId}）',
    src: '',
    fields: '',
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
    note: 'push 行军信息（state 1 行军/2 到达/12 交战；marchId 字符串，target.targetType=目标 pointType）',
    src: '',
    fields: '',
    usages: [
      {
        name: 'CMD_PUSH_MARCH_INFO',
        feat: 'alliance-defender',
        file: 'feats/alliance/alliance-defender/constants.js',
      },
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
    note: 'push 瓦片增量（315 宝箱行 + 310 巨熊宝藏行；玩家城 p.cityReward 挂 pointType=1；m.state 口径 PabFightStageState）',
    src: '',
    fields:
      'push {pointInfos[],iceList[]}（315 宝箱行+310 巨熊宝藏行；玩家城 p.cityReward 挂 pointType=1；m.state 口径 PabFightStageState；iceList[].initSid）',
    usages: [
      {
        name: 'PUSH_TILE',
        feat: 'feast',
        file: 'feats/cq26/feast/constants.js',
      },
      {
        name: 'PUSH_TILEINFO',
        feat: 'mask-dance',
        file: 'feats/activity/mask-dance/constants.js',
      },
      {
        name: 'PUSH_TILE_INFO',
        feat: 'secret-realm',
        file: 'feats/activity/secret-realm/constants.js',
      },
      {
        name: 'PUSH_TILE',
        feat: 'wl-chest',
        file: 'feats/cq26/wl-chest/constants.js',
      },
    ],
  },
  {
    cmd: 10019,
    dir: 'S2C',
    note: 'push 本人行军状态（生命周期唤醒源；到家 state=4 即补扫一轮）',
    src: '',
    fields: '',
    usages: [
      {
        name: 'CMD_USER_MARCH_INFO',
        feat: 'march',
        file: 'core/march.js',
      },
      {
        name: 'CMD_USER_MARCH_INFO',
        feat: 'mecha-treasure',
        file: 'feats/activity/mecha-treasure/constants.js',
      },
    ],
  },
  {
    cmd: 10021,
    dir: 'S2C',
    note: 'push 能量池变更（只认捐赠池 type 且点数回升时触发）',
    src: '',
    fields: 'push {type,point,reason,restoreSec}（只认捐赠池 type 且点数回升时触发）',
    usages: [
      {
        name: 'CMD_PUSH_ENERGY',
        feat: 'alliance-behemoth',
        file: 'feats/alliance/alliance-behemoth/constants.js',
      },
      {
        name: 'CMD_PUSH_ENERGY',
        feat: 'alliance-science',
        file: 'feats/alliance/alliance-science/constants.js',
      },
      {
        name: 'PUSH_ENERGY',
        feat: 'auto-hunt',
        file: 'feats/player/auto-hunt/constants.js',
      },
      {
        name: 'PUSH_ENERGY',
        feat: 'fear-star-rally',
        file: 'feats/player/fear-star-rally/constants.js',
      },
      {
        name: 'PUSH_ENERGY',
        feat: 'radar-task',
        file: 'feats/player/radar-task/constants.js',
      },
    ],
  },
  {
    cmd: 10053,
    dir: 'S2C',
    note: 'push 增量下发 danceRec/myReceiveDance、choose_hero_daily_reward 等（今日领取权威态）',
    src: '',
    fields: '',
    usages: [
      {
        name: 'PUSH_USER_DATA_COMMON',
        feat: 'daily-deal',
        file: 'feats/player/daily-deal/constants.js',
      },
      {
        name: 'PUSH_USER_DATA_COMMON',
        feat: 'mask-dance',
        file: 'feats/activity/mask-dance/constants.js',
      },
    ],
  },
  {
    cmd: 10264,
    dir: 'S2C',
    note: 'push 单封邮件（「遗迹区域刷新」开田信号，载荷是邮件本体）',
    src: '',
    fields: '',
    usages: [
      {
        name: 'PUSH_SINGLE_MAIL',
        feat: 'auto-farm',
        file: 'feats/player/auto-farm/constants.js',
      },
      {
        name: 'PUSH_SINGLE_MAIL',
        feat: 'domain-treasure',
        file: 'feats/activity/domain-treasure/constants.js',
      },
      {
        name: 'PUSH_SINGLE_MAIL',
        feat: 'mecha-treasure',
        file: 'feats/activity/mecha-treasure/constants.js',
      },
      {
        name: 'PUSH_SINGLE_MAIL',
        feat: 'sea-treasure',
        file: 'feats/activity/sea-treasure/constants.js',
      },
    ],
  },
];
