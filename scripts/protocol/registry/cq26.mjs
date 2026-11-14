// 协议注册表 · cq26 域 —— 机械抽取 + 人工标注（dir/note/src/fields 重跑保留，usages 重跑重建）。
// 生成：node scripts/protocol/extract.mjs；闸门：tests/protocol-registry.test.js（npm test）。
// 条目键 = 协议号；名字是 feat 局部别名（同名异号是局部命名，非漂移）。只链不搬：src 指 references/ 出处。
export default [
  {
    cmd: 2101,
    dir: 'C2S',
    note: '补读巨兽锚点 pos（BWL_INFO，只读探针窗心；融冰 2103 前置）',
    src: '',
    fields: 'req {} → resp {pos:{x,y,k}}（x/y>0 才采信）',
    usages: [
      {
        name: 'CMD_BWL_INFO',
        feat: 'ice-shake',
        file: 'feats/cq26/ice-shake.js',
      },
    ],
  },
  {
    cmd: 2103,
    dir: 'C2S',
    note: '巨熊盛宴（BWL）融冰（specIndex===0 分叉至此，resp 同形）',
    src: '',
    fields:
      'req {wastelandIndex,x,y}（BWL 融冰，specIndex===0 分叉，与 2117 同形）→ resp {miniGameId:Int64 | rewardResult}',
    usages: [
      {
        name: 'CMD_FIRE_BWL',
        feat: 'ice-shake',
        file: 'feats/cq26/ice-shake.js',
      },
    ],
  },
  {
    cmd: 2104,
    dir: 'C2S',
    note: 'BWL 奖励宝箱（315 specIndex=0，req {x,y}）',
    src: '',
    fields: 'req {x,y}（315 specIndex=0 宝箱）→ resp 看 header.s',
    usages: [
      {
        name: 'CMD_GET_CHEST',
        feat: 'feast',
        file: 'feats/cq26/feast.js',
      },
    ],
  },
  {
    cmd: 2105,
    dir: 'C2S',
    note: 'BWL 已开宝箱表（req {} → posList，只读每日一发）',
    src: '',
    fields: 'req {} → resp {posList[]} 已开宝箱表（只读每日一发）',
    usages: [
      {
        name: 'CMD_OPENED_LIST',
        feat: 'feast',
        file: 'feats/cq26/feast.js',
      },
    ],
  },
  {
    cmd: 2106,
    dir: 'C2S',
    note: '盛宴礼盒（req {pointIndex}）',
    src: '',
    fields: "req {pointIndex} → resp 空体（键集 ''；奖励走 22075 推送）",
    usages: [
      {
        name: 'CMD_GET_GIFT',
        feat: 'feast',
        file: 'feats/cq26/feast.js',
      },
    ],
  },
  {
    cmd: 2108,
    dir: 'C2S',
    note: '巨熊宝藏/旧称密礼（req {id:Int64,received:true}，无坐标跨图可领）',
    src: '',
    fields: 'req {id:Int64,received:true}（无坐标跨图可领）→ resp {rewardId}',
    usages: [
      {
        name: 'CMD_SECRET_GIFT',
        feat: 'feast',
        file: 'feats/cq26/feast.js',
      },
    ],
  },
  {
    cmd: 2111,
    dir: 'C2S',
    note: '荒芜冰原全分区快照（发现腿真相源，不依赖地图视口）',
    src: '',
    fields:
      'req {} → resp {curStage,wastelandList:[{wastelandIndex,status,wastelandType,wastelandCondition,endTime}]}（wastelandIndex=分区 showNum=317 地块 m.specIndex）',
    usages: [
      {
        name: 'CMD_WORLD_INFO',
        feat: 'wl-beast',
        file: 'feats/cq26/wl-beast.js',
      },
    ],
  },
  {
    cmd: 2114,
    dir: 'C2S',
    note: '荒芜冰原采集（315 行军；台账见 docs/acl-cq26-荒芜冰原.md §3.1）',
    src: 'extension/docs/acl-cq26-荒芜冰原.md',
    fields: '',
    usages: [
      {
        name: 'CMD_GATHER',
        feat: 'wl-mine',
        file: 'feats/cq26/wl-mine/constants.js',
      },
    ],
  },
  {
    cmd: 2115,
    dir: 'C2S',
    note: '荒芜冰原盗采（{wkid,x,y} → {rewardResult,remainStealNum}，即时结算不派兵）',
    src: '',
    fields: '',
    usages: [
      {
        name: 'CMD_STEAL',
        feat: 'wl-mine',
        file: 'feats/cq26/wl-mine/constants.js',
      },
    ],
  },
  {
    cmd: 2116,
    dir: 'C2S',
    note: '荒芜冰原协助（{wkid,x,y} → {rewardResult,remainGuardNum}，即时结算不扣 owner gNum）',
    src: '',
    fields: '',
    usages: [
      {
        name: 'CMD_HELP',
        feat: 'wl-mine',
        file: 'feats/cq26/wl-mine/constants.js',
      },
    ],
  },
  {
    cmd: 2117,
    dir: 'C2S',
    note: '荒芜冰原（NWL）融冰（resp 带 miniGameId 支是 feat 入口）',
    src: '',
    fields:
      'req {wastelandIndex,x,y}（sendPBV2）→ resp {miniGameId:Int64} 或 {rewardResult} 直接给奖，header.s 恒 0',
    usages: [
      {
        name: 'CMD_FIRE_NWL',
        feat: 'ice-shake',
        file: 'feats/cq26/ice-shake.js',
      },
    ],
  },
  {
    cmd: 2118,
    dir: 'C2S',
    note: 'NWL 开宝箱——唯一出网写动作（{wastelandIndex,x,y} 实录逐键）',
    src: '',
    fields: '',
    usages: [
      {
        name: 'CMD_GET_CHEST',
        feat: 'wl-chest',
        file: 'feats/cq26/wl-chest.js',
      },
    ],
  },
  {
    cmd: 2120,
    dir: 'C2S',
    note: 'NWL 分区锚点（{wastelandIndex}，外服必带 sid → {pos:{x,y,k}} 单点）',
    src: '',
    fields: '',
    usages: [
      {
        name: 'CMD_NWL_POS',
        feat: 'wl-mine',
        file: 'feats/cq26/wl-mine/constants.js',
      },
    ],
  },
  {
    cmd: 2121,
    dir: 'C2S',
    note: '召回 NWL 采集行军（{marchId} → {isOk}，不触发 22072）',
    src: '',
    fields: '',
    usages: [
      {
        name: 'CMD_RECALL',
        feat: 'wl-mine',
        file: 'feats/cq26/wl-mine/constants.js',
      },
    ],
  },
  {
    cmd: 2124,
    dir: 'C2S',
    note: '巨兽单点伤害读数（BEAST_SKILL_ACTIVATE_INFO，只作展示刷新）',
    src: '',
    fields: 'req {wastelandIndex} → resp {fightValue,timeIndex,selfFightValue}（只作展示刷新）',
    usages: [
      {
        name: 'CMD_INFO',
        feat: 'wl-beast',
        file: 'feats/cq26/wl-beast.js',
      },
    ],
  },
  {
    cmd: 2125,
    dir: 'C2S',
    note: '巨兽攻打——唯一写动作（BEAST_SKILL_ACTIVATE，即时结算）',
    src: '',
    fields:
      'req {wastelandIndex,troop:{armyPosList[],heroList[],formationV2,extraArmyPos}} → resp {isOk,fightValue}（即时结算）',
    usages: [
      {
        name: 'CMD_ATTACK',
        feat: 'wl-beast',
        file: 'feats/cq26/wl-beast.js',
      },
    ],
  },
  {
    cmd: 2129,
    dir: 'C2S',
    note: 'NWL 融冰小游戏——唯一出网动作（{id:Int64,index:档位} 实录逐键）',
    src: '',
    fields:
      'req {id:Int64{_low,_high,_unsigned},index:档位}（sendPBV2；id=2117 的 miniGameId 同形同值）→ resp {rewardResult:{items:[{itemId,count}]}}',
    usages: [
      {
        name: 'CMD_MINI_GAME',
        feat: 'ice-shake',
        file: 'feats/cq26/ice-shake.js',
      },
    ],
  },
  {
    cmd: 2171,
    dir: 'C2S',
    note: '巨兽盛宴本场权威快照（MONSTER_STRIKE_DEF_INFO_OPEN，req {}）',
    src: '',
    fields: '',
    usages: [
      {
        name: 'CMD_INFO',
        feat: 'mammoth',
        file: 'feats/cq26/mammoth.js',
      },
    ],
  },
  {
    cmd: 2178,
    dir: 'C2S',
    note: '巨兽盛宴批量领波次奖励（MONSTER_STRIKE_WAVE_REWARD_GAIN）',
    src: '',
    fields: '',
    usages: [
      {
        name: 'CMD_CLAIM',
        feat: 'mammoth',
        file: 'feats/cq26/mammoth.js',
      },
    ],
  },
  {
    cmd: 2201,
    dir: 'C2S',
    note: '星路全图棋盘（STAR_LAND_MAP_SINGLE_INFO，{cid,group} → {maxX,maxY,grid[]}）',
    src: '',
    fields: '',
    usages: [
      {
        name: 'CMD_MAP_SINGLE',
        feat: 'wl-mine',
        file: 'feats/cq26/wl-mine/constants.js',
      },
    ],
  },
  {
    cmd: 2212,
    dir: 'C2S',
    note: '能量补充车队补给——唯一出网动作（MONSTER_CLEANUP_ENERGY_SUPPLY，载荷恒 {}）',
    src: '',
    fields: '',
    usages: [
      {
        name: 'CMD_CLAIM',
        feat: 'energy-convoy',
        file: 'feats/cq26/energy-convoy.js',
      },
    ],
  },
  {
    cmd: 2365,
    dir: 'C2S',
    note: '读列车权威快照（SERIES_FROST_TRAIN_OPEN，req {}）',
    src: '',
    fields:
      'req {} → resp {curTrain,lastTrain}；车体 {baseInfo:{uuid:Int64,state,times:[{state,eTime}],stateEndTime},selfOn,baseRewardGet,shareRewardHaveNum}',
    usages: [
      {
        name: 'CMD_OPEN',
        feat: 'train',
        file: 'feats/cq26/train.js',
      },
    ],
  },
  {
    cmd: 2367,
    dir: 'C2S',
    note: '上车派兵（TRAIN_MARCH，{uuid,troop}，仅 state=10）',
    src: '',
    fields:
      'req {uuid:Int64,troop:{armyPosList,extraArmyPos,formationV2,heroList}}（仅 state=10；uuid 必取当前车）',
    usages: [
      {
        name: 'CMD_MARCH',
        feat: 'train',
        file: 'feats/cq26/train.js',
      },
    ],
  },
  {
    cmd: 2369,
    dir: 'C2S',
    note: '刷可掠列表 + 权威配额（TRAIN_LOOT_VIEW_RELOAD，req {}）',
    src: '',
    fields: 'req {} → resp {trains:[{uuid:Int64,…}]} + 权威配额（掠夺目标 uuid 合法来源集）',
    usages: [
      {
        name: 'CMD_LIST',
        feat: 'train',
        file: 'feats/cq26/train.js',
      },
    ],
  },
  {
    cmd: 2370,
    dir: 'C2S',
    note: '对某辆列车掠夺（TRAIN_LOOT，{uuid,troop}）',
    src: '',
    fields: 'req {uuid:Int64,troop:四键同 2367}（目标 uuid 必来自 2369 列表）',
    usages: [
      {
        name: 'CMD_LOOT',
        feat: 'train',
        file: 'feats/cq26/train.js',
      },
    ],
  },
  {
    cmd: 2373,
    dir: 'C2S',
    note: '领列车到站基础奖励（TRAIN_GET_REWARD，{uuid}，仅 state=30）',
    src: '',
    fields: 'req {uuid}（仅 state=30）→ resp {rewardResult,…}',
    usages: [
      {
        name: 'CMD_REWARD',
        feat: 'train',
        file: 'feats/cq26/train.js',
      },
    ],
  },
  {
    cmd: 2375,
    dir: 'C2S',
    note: '单车详情：防守名单 + 奖池（TRAIN_OTHER_GET_INFO，{uuid}，数 KB）',
    src: '',
    fields: 'req {uuid} → resp 防守名单+奖池（数 KB；纯面板读，feat 不发）',
    usages: [
      {
        name: 'CMD_INFO',
        feat: 'train',
        file: 'feats/cq26/train.js',
      },
    ],
  },
  {
    cmd: 2385,
    dir: 'C2S',
    note: '翻卡奖池分页（TRAIN_CARD_INFO，{uuid,pageId,needEmpty}，每页 32 卡位）',
    src: '',
    fields:
      'req {uuid,pageId,needEmpty} → resp {pageId,pageSize,allRewardNum,emptyRewardNum,selfRewardAllNum,shareRewardHaveNum,cardInfoList[]}（每页 32 卡位）',
    usages: [
      {
        name: 'CMD_CARD_LIST',
        feat: 'train',
        file: 'feats/cq26/train.js',
      },
    ],
  },
  {
    cmd: 2386,
    dir: 'C2S',
    note: '翻一张卡（TRAIN_CARD_REWARD，{uuid,index}）',
    src: '',
    fields:
      'req {uuid,index} → resp {rewardResult,cardInfo:{index,reward:{itemId}},cardInfoList,shareRewardHaveNum}',
    usages: [
      {
        name: 'CMD_CARD_FLIP',
        feat: 'train',
        file: 'feats/cq26/train.js',
      },
    ],
  },
  {
    cmd: 2441,
    dir: 'C2S',
    note: '中立城商店红包（SHOP_VIEW_OR_GET_RED_PACK，{id,get}，get=true 即领）',
    src: '',
    fields: '',
    usages: [
      {
        name: 'CMD_RED_PACK',
        feat: 'shop',
        file: 'feats/cq26/shop.js',
      },
    ],
  },
  {
    cmd: 2442,
    dir: 'C2S',
    note: '中立城商店全量快照（SHOP_GET_INFO，唯一权威读通道）',
    src: '',
    fields: '',
    usages: [
      {
        name: 'CMD_GET_INFO',
        feat: 'shop',
        file: 'feats/cq26/shop.js',
      },
    ],
  },
  {
    cmd: 2443,
    dir: 'C2S',
    note: '商店单所补查（SHOP_GET_SINGLE_INFO，带 canRevRedPack）',
    src: '',
    fields: '',
    usages: [
      {
        name: 'CMD_SINGLE',
        feat: 'shop',
        file: 'feats/cq26/shop.js',
      },
    ],
  },
  {
    cmd: 2444,
    dir: 'C2S',
    note: '商店购买（SHOP_BUY，feat 唯一写动作）',
    src: '',
    fields: '',
    usages: [
      {
        name: 'CMD_BUY',
        feat: 'shop',
        file: 'feats/cq26/shop.js',
      },
    ],
  },
  {
    cmd: 2491,
    dir: 'C2S',
    note: '考古领取——唯一出网动作（SERIES_FROST_EXCAV_CLAIM，{siteId}）',
    src: '',
    fields: '',
    usages: [
      {
        name: 'CMD_CLAIM',
        feat: 'excav',
        file: 'feats/cq26/excav.js',
      },
    ],
  },
  {
    cmd: 22001,
    dir: 'S2C',
    note: 'push 能量补充车队亮灯位（canReplenishMonsterCleanupEnergy 载体）',
    src: '',
    fields: '',
    usages: [
      {
        name: 'PUSH_SELF_INFO',
        feat: 'energy-convoy',
        file: 'feats/cq26/energy-convoy.js',
      },
    ],
  },
  {
    cmd: 22007,
    dir: 'S2C',
    note: 'push 方舟状态（arkData{status,round,maxRound,arkArmyRed,endTimeSec} 真相源）',
    src: '',
    fields: '',
    usages: [
      {
        name: 'PUSH_ARK_STATUS',
        feat: 'ark-energy',
        file: 'feats/cq26/ark-energy.js',
      },
    ],
  },
  {
    cmd: 22010,
    dir: 'S2C',
    note: 'push 印石红点（id=101 携带剩余可掠次数）',
    src: '',
    fields: '',
    usages: [
      {
        name: 'PUSH_RED_POINTS',
        feat: 'train',
        file: 'feats/cq26/train.js',
      },
    ],
  },
  {
    cmd: 22030,
    dir: 'S2C',
    note: 'push 中立城商店图标（{type:1 开市|2 红包,id}，与 status 1→2 翻转同秒）',
    src: '',
    fields: '',
    usages: [
      {
        name: 'PUSH_SHOP_ICON',
        feat: 'shop',
        file: 'feats/cq26/shop.js',
      },
    ],
  },
  {
    cmd: 22031,
    dir: 'S2C',
    note: 'push 巨兽盛宴阶段/波次跃迁广播（只作唤醒）',
    src: '',
    fields: '',
    usages: [
      {
        name: 'PUSH_DB_INFO',
        feat: 'mammoth',
        file: 'feats/cq26/mammoth.js',
      },
    ],
  },
  {
    cmd: 22032,
    dir: 'S2C',
    note: 'push 巨兽盛宴阶段机（CQ26BeastFeastPhase）',
    src: '',
    fields: 'push {feastPhase:{state,gatherTime,beginTime,endTime,displayEndTime}}（阶段机）',
    usages: [
      {
        name: 'PUSH_PHASE',
        feat: 'feast',
        file: 'feats/cq26/feast.js',
      },
      {
        name: 'PUSH_PHASE',
        feat: 'ice-shake',
        file: 'feats/cq26/ice-shake.js',
      },
    ],
  },
  {
    cmd: 22062,
    dir: 'S2C',
    note: 'push 战区宝藏开启点全量快照',
    src: '',
    fields: '',
    usages: [
      {
        name: 'PUSH_OPEN_LIST',
        feat: 'excav',
        file: 'feats/cq26/excav.js',
      },
    ],
  },
  {
    cmd: 22063,
    dir: 'S2C',
    note: 'push 本人已采集合（服务端持久）',
    src: '',
    fields: '',
    usages: [
      {
        name: 'PUSH_SELF',
        feat: 'excav',
        file: 'feats/cq26/excav.js',
      },
    ],
  },
  {
    cmd: 22064,
    dir: 'S2C',
    note: 'push 巨熊宝藏全量快照',
    src: '',
    fields: 'push {gift:[{id,pos:{x,y,k},endtime}]}（全量快照整体替换；id 走 feat reader 解串）',
    usages: [
      {
        name: 'PUSH_SECRET',
        feat: 'feast',
        file: 'feats/cq26/feast.js',
      },
    ],
  },
  {
    cmd: 22071,
    dir: 'S2C',
    note: 'push 冰原 16 分区状态全量（只做棋盘失效与唤醒，不参与判据）',
    src: '',
    fields: '',
    usages: [
      {
        name: 'PUSH_LAND_LIST',
        feat: 'wl-chest',
        file: 'feats/cq26/wl-chest.js',
      },
      {
        name: 'PUSH_LAND_LIST',
        feat: 'wl-mine',
        file: 'feats/cq26/wl-mine/constants.js',
      },
    ],
  },
  {
    cmd: 22072,
    dir: 'S2C',
    note: 'push 冰原额度唯一权威（BWL/NWL 共享 remainChestNum/todayCan…）',
    src: '',
    fields: 'push {remainChestNum,…}（BWL/NWL 共享额度唯一权威）',
    usages: [
      {
        name: 'PUSH_WL_INFO',
        feat: 'feast',
        file: 'feats/cq26/feast.js',
      },
      {
        name: 'PUSH_WL_INFO',
        feat: 'wl-chest',
        file: 'feats/cq26/wl-chest.js',
      },
      {
        name: 'PUSH_WL_INFO',
        feat: 'wl-mine',
        file: 'feats/cq26/wl-mine/constants.js',
      },
    ],
  },
  {
    cmd: 22073,
    dir: 'S2C',
    note: 'push 玩家快照（礼盒/巨熊宝藏额度）',
    src: '',
    fields:
      'push {player:{giftCount,blue,feedCount,claimedIndexList[],secretGiftCount}}（claimed 权威）',
    usages: [
      {
        name: 'PUSH_PLAYER',
        feat: 'feast',
        file: 'feats/cq26/feast.js',
      },
    ],
  },
  {
    cmd: 22075,
    dir: 'S2C',
    note: 'push 礼盒发奖明细',
    src: '',
    fields:
      'push {pointIndex,blue,claimedIndexList[]}（奖励在 rewardResult.items；claimedIndexList 同为满集权威）',
    usages: [
      {
        name: 'PUSH_GIFT_REWARD',
        feat: 'feast',
        file: 'feats/cq26/feast.js',
      },
    ],
  },
  {
    cmd: 22077,
    dir: 'S2C',
    note: 'push 未开箱全量快照（开过的点从下一份消失）',
    src: '',
    fields: '',
    usages: [
      {
        name: 'PUSH_CHEST_POS',
        feat: 'wl-chest',
        file: 'feats/cq26/wl-chest.js',
      },
    ],
  },
  {
    cmd: 22095,
    dir: 'S2C',
    note: 'push 列车发车（state→20 的边沿信号）',
    src: '',
    fields: '',
    usages: [
      {
        name: 'PUSH_TRAIN_INFO',
        feat: 'train',
        file: 'feats/cq26/train.js',
      },
    ],
  },
  {
    cmd: 22096,
    dir: 'S2C',
    note: 'push 领奖/翻卡后全量列车态（带 baseRewardGet/shareRewardHaveNum）',
    src: '',
    fields:
      'push {train:{baseInfo:{uuid,state,stateEndTime},selfOn,baseRewardGet,shareRewardHaveNum}}（只带发生变化的那一辆）',
    usages: [
      {
        name: 'PUSH_TRAIN_DATA',
        feat: 'train',
        file: 'feats/cq26/train.js',
      },
    ],
  },
];
