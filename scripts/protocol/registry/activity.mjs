// 协议注册表 · activity 域 —— 机械抽取 + 人工标注（dir/note/src/fields 重跑保留，usages 重跑重建）。
// 生成：node scripts/protocol/extract.mjs；闸门：tests/protocol-registry.test.js（npm test）。
// 条目键 = 协议号；名字是 feat 局部别名（同名异号是局部命名，非漂移）。src 为人工标注的出处说明，渐进补充。
export default [
  {
    cmd: 1055,
    dir: 'C2S',
    note: '占领发射井活动信息 + 4 井归属（JSON send，{}）',
    src: '',
    fields: '',
    usages: [
      {
        name: 'CMD_GET_GUN_FIGHT_INFO',
        feat: 'launch-silo',
        file: 'feats/activity/launch-silo/constants.js',
      },
    ],
  },
  {
    cmd: 1057,
    dir: 'C2S',
    note: '发射井个人积分与已领档位（JSON send，{}）',
    src: '',
    fields: '',
    usages: [
      {
        name: 'CMD_GET_GUN_FIGHT_USER_INFO',
        feat: 'launch-silo',
        file: 'feats/activity/launch-silo/constants.js',
      },
    ],
  },
  {
    cmd: 1058,
    dir: 'C2S',
    note: '领取发射井某档位积分奖励（JSON send，{score:num}）',
    src: '',
    fields: '',
    usages: [
      {
        name: 'CMD_GET_GUN_FIGHT_USER_REWARD',
        feat: 'launch-silo',
        file: 'feats/activity/launch-silo/constants.js',
      },
    ],
  },
  {
    cmd: 2503,
    dir: 'C2S',
    note: '领取某场假面舞会的基地宝箱（DANCE_GET_REWARD，sendPBV2）',
    src: '',
    fields: '',
    usages: [
      {
        name: 'CMD_DANCE_GET_REWARD',
        feat: 'mask-dance',
        file: 'feats/activity/mask-dance/constants.js',
      },
    ],
  },
  {
    cmd: 2507,
    dir: 'C2S',
    note: '宝藏幸运机抽一台（摇摇机孪生号，与 9628 同形；resultId>0 即中，奖励直接到账无后续领奖）',
    src: '',
    fields: 'req {activityId,instanceIdStr} → resp {resultId,reward{items[{itemId,itemCount}]}}',
    usages: [
      {
        name: 'CMD_EXCAVATE_TIGER_DRAW',
        feat: 'aureole-slot',
        file: 'feats/activity/aureole-slot/constants.js',
      },
    ],
  },
  {
    cmd: 2509,
    dir: 'C2S',
    note: '宝藏幸运机世界页机器列表（摇摇机孪生号，与 9630 同形）',
    src: '',
    fields:
      'req {activityId} → resp {worldList:[{instanceIdStr,expireTimeMilli:Int64(毫秒),triggerUser{uid,playerInfo,serverId,frameId},x,y}]}',
    usages: [
      {
        name: 'CMD_EXCAVATE_WORLD_LIST',
        feat: 'aureole-slot',
        file: 'feats/activity/aureole-slot/constants.js',
      },
    ],
  },
  {
    cmd: 3756,
    dir: 'C2S',
    note: '查询当前可攻打世界 boss（海上夺宝，{activityId} → {bossInfos}）',
    src: '',
    fields: '',
    usages: [
      {
        name: 'CMD_QUERY_WORLD_BOSS',
        feat: 'sea-treasure',
        file: 'feats/activity/sea-treasure/constants.js',
      },
    ],
  },
  {
    cmd: 8521,
    dir: 'C2S',
    note: '秘境行军移动（被拒是常态：158 小队尚未抵达/163 目标点不能行军/17 战场即将封闭）',
    src: '',
    fields: 'req {x,y} 整数（teamIsMooring 串行；拒 158/163/17 是常态）',
    usages: [
      {
        name: 'CMD_MARCH_MOVE',
        feat: 'secret-realm',
        file: 'feats/activity/secret-realm/constants.js',
      },
    ],
  },
  {
    cmd: 8522,
    dir: 'C2S',
    note: '秘境单点驻军详情（{x,y}；8522→8521 同点配对是人工点流复刻）',
    src: '',
    fields: '',
    usages: [
      {
        name: 'CMD_POINT_INFO',
        feat: 'secret-realm',
        file: 'feats/activity/secret-realm/constants.js',
      },
    ],
  },
  {
    cmd: 8526,
    dir: 'C2S',
    note: '秘境资源点明细（{x,y} → bagInfo[]/buffInfo[]/bagGetNum/buffGetNum/refreshTime）',
    src: '',
    fields: 'req {x,y} → resp {bagInfo[],buffInfo[],bagGetNum,buffGetNum,refreshTime}',
    usages: [
      {
        name: 'CMD_RESOURCE_INFO',
        feat: 'secret-realm',
        file: 'feats/activity/secret-realm/constants.js',
      },
    ],
  },
  {
    cmd: 8527,
    dir: 'C2S',
    note: '领一个资源 bag（{rId}，无 x,y）',
    src: '',
    fields: 'req {rId:十进制字符串}（无 x,y）',
    usages: [
      {
        name: 'CMD_RESOURCE_GET',
        feat: 'secret-realm',
        file: 'feats/activity/secret-realm/constants.js',
      },
    ],
  },
  {
    cmd: 8532,
    dir: 'C2S',
    note: '秘境遗落之箱查询',
    src: '',
    fields: 'req {x,y} 整数（遗落之箱查询）',
    usages: [
      {
        name: 'CMD_DROP_INFO',
        feat: 'secret-realm',
        file: 'feats/activity/secret-realm/constants.js',
      },
    ],
  },
  {
    cmd: 8533,
    dir: 'C2S',
    note: '领取一个掉落项/宠物（{x,y,rId}，rId=dropId 字符串）',
    src: '',
    fields: 'req {x,y,rId:十进制字符串}（rId=dropId）',
    usages: [
      {
        name: 'CMD_DROP_GET',
        feat: 'secret-realm',
        file: 'feats/activity/secret-realm/constants.js',
      },
    ],
  },
  {
    cmd: 8534,
    dir: 'C2S',
    note: '使用秘境背包道具（{info:{itemId,itemCount},marchId}）——编队治疗动作口',
    src: '',
    fields: '',
    usages: [
      {
        name: 'CMD_BAG_USE',
        feat: 'secret-realm',
        file: 'feats/activity/secret-realm/constants.js',
      },
    ],
  },
  {
    cmd: 8535,
    dir: 'C2S',
    note: '共享背包版道具使用（治疗只用私有背包，本键留档）',
    src: '',
    fields: '',
    usages: [
      {
        name: 'CMD_SHARE_BAG_USE',
        feat: 'secret-realm',
        file: 'feats/activity/secret-realm/constants.js',
      },
    ],
  },
  {
    cmd: 8536,
    dir: 'C2S',
    note: '秘境兽点信息（侦察前无 beastId，侦察后带 beastId 可查 quality）',
    src: '',
    fields: 'req {x,y} → resp {beastType,pveId[,beastId]}（侦察前无 beastId，侦察后带）',
    usages: [
      {
        name: 'CMD_BEAST_INFO',
        feat: 'secret-realm',
        file: 'feats/activity/secret-realm/constants.js',
      },
    ],
  },
  {
    cmd: 8537,
    dir: 'C2S',
    note: '全地形勘察车侦察（耗 41001 道具；先 8536 免费预检再花道具）',
    src: '',
    fields: 'req {x,y}（耗 41001 道具）→ resp 比 8536 多 beastId',
    usages: [
      {
        name: 'CMD_BEAST_SCOUT',
        feat: 'secret-realm',
        file: 'feats/activity/secret-realm/constants.js',
      },
    ],
  },
  {
    cmd: 8538,
    dir: 'C2S',
    note: '领一个增益 buff（异能井，{rId,pos}）',
    src: '',
    fields: 'req {rId:十进制字符串,pos}（异能井增益，仅队长）',
    usages: [
      {
        name: 'CMD_RESOURCE_GET_BUFF',
        feat: 'secret-realm',
        file: 'feats/activity/secret-realm/constants.js',
      },
    ],
  },
  {
    cmd: 8540,
    dir: 'C2S',
    note: '秘境商店查询（应答不带 x,y；会把非 type3 货位 getTime 归零，增量须以本次应答为基准）',
    src: '',
    fields:
      'req {x,y} → resp 不带 x,y（点位身份从 req 侧取，按 reqTime 配对）；会把非 type3 货位 getTime 归零',
    usages: [
      {
        name: 'CMD_SHOP_INFO',
        feat: 'secret-realm',
        file: 'feats/activity/secret-realm/constants.js',
      },
    ],
  },
  {
    cmd: 8541,
    dir: 'C2S',
    note: '商店「我已就绪」勾选（{x,y,ready:0|1}，与补货无关）',
    src: '',
    fields: '',
    usages: [
      {
        name: 'CMD_SHOP_READY_CHANGE',
        feat: 'secret-realm',
        file: 'feats/activity/secret-realm/constants.js',
      },
    ],
  },
  {
    cmd: 8542,
    dir: 'C2S',
    note: '秘境商店买一件（{specId,num} 无坐标，商店身份服务器自持）',
    src: '',
    fields: 'req {specId,num} 整数（无坐标，商店身份服务器自持）→ resp {items}',
    usages: [
      {
        name: 'CMD_SHOP_BUY',
        feat: 'secret-realm',
        file: 'feats/activity/secret-realm/constants.js',
      },
    ],
  },
  {
    cmd: 8543,
    dir: 'C2S',
    note: '秘境商店刷新（扣 1 个 41010 人造水晶，只归零非 type3 货位 getTime）',
    src: '',
    fields: 'req {x,y}（扣 1 个 41010 人造水晶，只归零非 type3 货位 getTime）',
    usages: [
      {
        name: 'CMD_SHOP_REFRESH',
        feat: 'secret-realm',
        file: 'feats/activity/secret-realm/constants.js',
      },
    ],
  },
  {
    cmd: 8544,
    dir: 'C2S',
    note: '秘境 BOSS 伤害榜（游戏侧每 5s 拉一次；成员名漏下划线非笔误）',
    src: '',
    fields: '',
    usages: [
      {
        name: 'CMD_BOSS_RANK',
        feat: 'secret-realm',
        file: 'feats/activity/secret-realm/constants.js',
      },
    ],
  },
  {
    cmd: 8546,
    dir: 'C2S',
    note: '拍宠物投喂一拍（{specId}；feat 走原生 petCaptureOperation 不直发，留档）',
    src: '',
    fields:
      'req {specId} 整数（1=免费手拍；5|6=投喂道具档）→ resp {feedInfo:{allFavor},changeScore}',
    usages: [
      {
        name: 'CMD_BEAST_OPERATE',
        feat: 'secret-realm',
        file: 'feats/activity/secret-realm/constants.js',
      },
    ],
  },
  {
    cmd: 8547,
    dir: 'C2S',
    note: '小 BOSS 石头奖励主动查询口（客户端 0 调用方，账本全靠 push 21539；只登记不接入）',
    src: '',
    fields: '',
    usages: [
      {
        name: 'CMD_BOSS_GUARD_REWARD_INFO',
        feat: 'secret-realm',
        file: 'feats/activity/secret-realm/constants.js',
      },
    ],
  },
  {
    cmd: 8548,
    dir: 'C2S',
    note: '领石头（不要求队伍站在石头点位上；拒绝码只有 enigma_realm 族，无 158）',
    src: '',
    fields:
      'req {x,y}（不带 bossId，不要求队伍站在石头点上）→ resp {rewardResult[,boxOpen,boxOpenBeast]}；拒 enigma_realm60/179/162',
    usages: [
      {
        name: 'CMD_BOSS_GUARD_GET',
        feat: 'secret-realm',
        file: 'feats/activity/secret-realm/constants.js',
      },
    ],
  },
  {
    cmd: 8549,
    dir: 'C2S',
    note: '「谁在打我」只读查询（{uid:String} → fightTeams[]/waitTeams[]；不能当攻击警告判据）',
    src: '',
    fields: '',
    usages: [
      {
        name: 'CMD_ATTACK_SELF_TEAM',
        feat: 'secret-realm',
        file: 'feats/activity/secret-realm/constants.js',
      },
    ],
  },
  {
    cmd: 8551,
    dir: 'C2S',
    note: '秘境求援（{uid:String} → {x,y}；非战斗动作，应答坐标拼联盟频道链接消息）',
    src: '',
    fields: '',
    usages: [
      {
        name: 'CMD_CALL_HELP',
        feat: 'secret-realm',
        file: 'feats/activity/secret-realm/constants.js',
      },
    ],
  },
  {
    cmd: 8552,
    dir: 'C2S',
    note: '秘境战败复活（自动驾驶代答判据 deadType==1 && dataConfig(3056)>reviveNum）',
    src: '',
    fields: '',
    usages: [
      {
        name: 'CMD_REVIVE',
        feat: 'secret-realm',
        file: 'feats/activity/secret-realm/constants.js',
      },
    ],
  },
  {
    cmd: 8581,
    dir: 'C2S',
    note: '撤离带出选择（配合 21521 roomBagInfo.backItemIds/backBeasts；线路形态仅源码级依据）',
    src: '',
    fields: 'req {uuIds:Int64对象[],itemIds:[]}（撤离带出选择；线路形态仅源码级依据）',
    usages: [
      {
        name: 'CMD_BAG_GET_SET',
        feat: 'secret-realm',
        file: 'feats/activity/secret-realm/constants.js',
      },
    ],
  },
  {
    cmd: 8584,
    dir: 'C2S',
    note: '拉编队各支军队血量（{uid:字符串} → infos[].armyPower/maxArmyPower/marchId:Int64）',
    src: '',
    fields: '',
    usages: [
      {
        name: 'CMD_MARCH_ARMY_INFO',
        feat: 'secret-realm',
        file: 'feats/activity/secret-realm/constants.js',
      },
    ],
  },
  {
    cmd: 8589,
    dir: 'C2S',
    note: '退出 BOSS 战区（{uid:UID+""}，ok===1 后游戏 pabFightQuit()）',
    src: '',
    fields: 'req {uid:本人UID} → resp ok===1 后游戏 pabFightQuit()',
    usages: [
      {
        name: 'CMD_LEAVE_AREA',
        feat: 'secret-realm',
        file: 'feats/activity/secret-realm/constants.js',
      },
    ],
  },
  {
    cmd: 8623,
    dir: 'C2S',
    note: '夺宝矿脉列表查询（应答 data.otherKuangList，gatherStatus 标可挖状态）',
    src: '',
    fields: '',
    usages: [
      {
        name: 'CMD_GET_KUANG_LIST',
        feat: 'domain-treasure',
        file: 'feats/activity/domain-treasure/constants.js',
      },
    ],
  },
  {
    cmd: 8802,
    dir: 'C2S',
    note: '查询使徒列表（PINK_MECHA_MONSTER_LIST，{aid,type}）',
    src: '',
    fields: '',
    usages: [
      {
        name: 'CMD_MONSTER_LIST',
        feat: 'mecha-treasure',
        file: 'feats/activity/mecha-treasure/constants.js',
      },
    ],
  },
  {
    cmd: 8852,
    dir: 'C2S',
    note: '芯片空投可领箱全局查询（{queryType:1,marchType:dropType[,marchIdStr]} → {x,y} 非瓦片通路）',
    src: '',
    fields: '',
    usages: [
      {
        name: 'CMD_FLOAT_PARADE_QUERY_CAN_REWARD_BAG',
        feat: 'floatcar',
        file: 'feats/activity/floatcar/constants.js',
      },
    ],
  },
  {
    cmd: 9595,
    dir: 'C2S',
    note: '英雄装备许愿找箱（HERO_EQUIP_WISH_FIND_BOX，{activityId} → {serverId,x,y} 真机验证）',
    src: '',
    fields: '',
    usages: [
      {
        name: 'CMD_HERO_EQUIP_WISH_FIND_BOX',
        feat: 'titan-blessing',
        file: 'feats/activity/titan-blessing/constants.js',
      },
    ],
  },
  {
    cmd: 9628,
    dir: 'C2S',
    note: '情报摇摇机抽一台（本 feat 唯一出网动作；实测 resultId=8 → 稀有技能宝箱 2540002 ×1）',
    src: '',
    fields: 'req {activityId,instanceIdStr} → resp {resultId,reward{items[{itemId,itemCount}]}}',
    usages: [
      {
        name: 'CMD_AUREOLE_DRAW',
        feat: 'aureole-slot',
        file: 'feats/activity/aureole-slot/constants.js',
      },
    ],
  },
  {
    cmd: 9630,
    dir: 'C2S',
    note: '情报摇摇机世界页机器列表（只下发同分组；孪生号 2509）',
    src: '',
    fields:
      'req {activityId} → resp {worldList:[{instanceIdStr,expireTimeMilli:Int64(毫秒),triggerUser{uid,playerInfo,serverId,frameId},x,y}]}',
    usages: [
      {
        name: 'CMD_AUREOLE_WORLD_LIST',
        feat: 'aureole-slot',
        file: 'feats/activity/aureole-slot/constants.js',
      },
    ],
  },
  {
    cmd: 10029,
    dir: 'S2C',
    note: 'push 发射井个人积分/已领档位刷新',
    src: '',
    fields: '',
    usages: [
      {
        name: 'PUSH_GUN_FIGHT_REWARD_INFO',
        feat: 'launch-silo',
        file: 'feats/activity/launch-silo/constants.js',
      },
    ],
  },
  {
    cmd: 10904,
    dir: 'S2C',
    note: 'push 整条活动（PUSH_ONE_ACTIVITY，载荷含 type/extra/id）',
    src: '',
    fields: '',
    usages: [
      {
        name: 'CMD_PUSH_ONE_ACTIVITY',
        feat: 'titan-blessing',
        file: 'feats/activity/titan-blessing/constants.js',
      },
    ],
  },
  {
    cmd: 10912,
    dir: 'S2C',
    note: 'push 活动 extra 更新（{aid,extra}；新矿脉诞生时推它）',
    src: '',
    fields: '',
    usages: [
      {
        name: 'CMD_PUSH_ONE_ACTIVITY_EXTRA',
        feat: 'aureole-slot',
        file: 'feats/activity/aureole-slot/constants.js',
      },
      {
        name: 'CMD_PUSH_ONE_ACTIVITY_EXTRA',
        feat: 'domain-treasure',
        file: 'feats/activity/domain-treasure/constants.js',
      },
      {
        name: 'CMD_PUSH_ONE_ACTIVITY_EXTRA',
        feat: 'mecha-treasure',
        file: 'feats/activity/mecha-treasure/constants.js',
      },
      {
        name: 'CMD_PUSH_ONE_ACTIVITY_EXTRA',
        feat: 'sea-treasure',
        file: 'feats/activity/sea-treasure/constants.js',
      },
    ],
  },
  {
    cmd: 11017,
    dir: 'S2C',
    note: 'push 发射井单井归属/占领增量',
    src: '',
    fields: '',
    usages: [
      {
        name: 'PUSH_GUN_FIGHT_INFO',
        feat: 'launch-silo',
        file: 'feats/activity/launch-silo/constants.js',
      },
    ],
  },
  {
    cmd: 13226,
    dir: 'S2C',
    note: 'push 泰坦祝福新箱广播（{uid,playerInfo,x,y,endTime}；EventId 别名 TitanBlessTreasureRefresh）',
    src: '',
    fields: '',
    usages: [
      {
        name: 'CMD_PUSH_GIFT',
        feat: 'titan-blessing',
        file: 'feats/activity/titan-blessing/constants.js',
      },
    ],
  },
  {
    cmd: 13227,
    dir: 'S2C',
    note: 'push 泰坦祝福本人领取到账（{reward,uuid}）',
    src: '',
    fields: '',
    usages: [
      {
        name: 'CMD_PUSH_REWARD_GET',
        feat: 'titan-blessing',
        file: 'feats/activity/titan-blessing/constants.js',
      },
    ],
  },
  {
    cmd: 13228,
    dir: 'S2C',
    note: 'push 泰坦祝福箱子消失（{uuid}）',
    src: '',
    fields: '',
    usages: [
      {
        name: 'CMD_PUSH_GIFT_CLEAR',
        feat: 'titan-blessing',
        file: 'feats/activity/titan-blessing/constants.js',
      },
    ],
  },
  {
    cmd: 21371,
    dir: 'S2C',
    note: 'push 夺宝队伍整体变更（含 ARRIVE 清态）',
    src: '',
    fields: 'push {crossTreasureTeamChange:{team:{uid,…}}}（队伍整体变更，含 ARRIVE 清态）',
    usages: [
      {
        name: 'PUSH_TEAM_CHANGE',
        feat: 'cs-hunt',
        file: 'feats/activity/cs-hunt/constants.js',
      },
    ],
  },
  {
    cmd: 21372,
    dir: 'S2C',
    note: 'push 夺宝出发召集（{teamId:Long,readyMember:Long[],readyStartTimeMill:Long}）',
    src: '',
    fields:
      'push {crossTreasureTeamReadyChange:{teamId:Long,readyMember:Long[],readyStartTimeMill:Long}}（存在即召集时刻）',
    usages: [
      {
        name: 'PUSH_READY_CHANGE',
        feat: 'cs-hunt',
        file: 'feats/activity/cs-hunt/constants.js',
      },
    ],
  },
  {
    cmd: 21373,
    dir: 'S2C',
    note: 'push 夺宝成员增删改（{teamId,type,member:{uid,playerInfo,power,level,aTag,help,marchId}}）',
    src: '',
    fields: '',
    usages: [
      {
        name: 'PUSH_MEMBER_CHANGE',
        feat: 'cs-hunt',
        file: 'feats/activity/cs-hunt/constants.js',
      },
    ],
  },
  {
    cmd: 21374,
    dir: 'S2C',
    note: 'push 夺宝入队申请变更（{teamId,uid,op,apply}）',
    src: '',
    fields: '',
    usages: [
      {
        name: 'PUSH_APPLY_CHANGE',
        feat: 'cs-hunt',
        file: 'feats/activity/cs-hunt/constants.js',
      },
    ],
  },
  {
    cmd: 21375,
    dir: 'S2C',
    note: 'push 本人夺宝次数变更（huntCount 唯一来源，{count:Long,lastRecoverTimeMill:Long,mark}）',
    src: '',
    fields: '',
    usages: [
      {
        name: 'PUSH_USER_CHANGE',
        feat: 'cs-hunt',
        file: 'feats/activity/cs-hunt/constants.js',
      },
    ],
  },
  {
    cmd: 21376,
    dir: 'S2C',
    note: 'push 夺宝状态机主推送（round/status/eventInfo/waitInfo/fightInfo/lootInfo/returnInfo）',
    src: '',
    fields:
      'push {crossTreasureHuntInfoChange:{treasureId,status,round,eventInfo:{eventSpecId,status,eventDecideInfo:{phase,uidDecide}},waitInfo,fightInfo,lootInfo,returnInfo}}（状态机主推送）',
    usages: [
      {
        name: 'PUSH_HUNT_INFO_CHANGE',
        feat: 'cs-hunt',
        file: 'feats/activity/cs-hunt/constants.js',
      },
    ],
  },
  {
    cmd: 21377,
    dir: 'S2C',
    note: 'push 夺宝活动信息变更',
    src: '',
    fields: '',
    usages: [
      {
        name: 'PUSH_INFO_CHANGE',
        feat: 'cs-hunt',
        file: 'feats/activity/cs-hunt/constants.js',
      },
    ],
  },
  {
    cmd: 21378,
    dir: 'S2C',
    note: 'push 夺宝科技生效（字段名 skillEventSpecId；存在无 7551 前置的自动生效）',
    src: '',
    fields: '',
    usages: [
      {
        name: 'PUSH_SKILL_TAKE_EFFECT',
        feat: 'cs-hunt',
        file: 'feats/activity/cs-hunt/constants.js',
      },
    ],
  },
  {
    cmd: 21379,
    dir: 'S2C',
    note: 'push 夺宝掠夺成功（可领奖励）',
    src: '',
    fields: '',
    usages: [
      {
        name: 'PUSH_REWARD_CAN_LOOT',
        feat: 'cs-hunt',
        file: 'feats/activity/cs-hunt/constants.js',
      },
    ],
  },
  {
    cmd: 21383,
    dir: 'S2C',
    note: 'push 夺宝玩家来袭规模（{treasureId,marchSize,playerInfos:JSON 串需二次 parse}）',
    src: '',
    fields: '',
    usages: [
      {
        name: 'PUSH_HURT_MARCH_SIZE',
        feat: 'cs-hunt',
        file: 'feats/activity/cs-hunt/constants.js',
      },
    ],
  },
  {
    cmd: 21384,
    dir: 'S2C',
    note: 'push 夺宝幸运降临生效（奖励翻倍，神器除外）',
    src: '',
    fields: '',
    usages: [
      {
        name: 'PUSH_REWARD_MULTIPLE',
        feat: 'cs-hunt',
        file: 'feats/activity/cs-hunt/constants.js',
      },
    ],
  },
  {
    cmd: 21521,
    dir: 'S2C',
    note: 'push 秘境房间基础信息（约 17s 一条 + 行军状态变化补发；marchState 与瓦片 PabFightStageState 两套枚举勿互用）',
    src: '',
    fields:
      'push {info:roomBaseInfo}（或扁平；startPoint/marchState/pointType；约 17s 一条+行军变状态补发；marchState 2=ARRIVED，与瓦片枚举勿互用）',
    usages: [
      {
        name: 'PUSH_BASE_INFO',
        feat: 'secret-realm',
        file: 'feats/activity/secret-realm/constants.js',
      },
    ],
  },
  {
    cmd: 21522,
    dir: 'S2C',
    note: 'push 秘境资源点变更（谁已领过只能从推送拿；业务体在 ev.data.data）',
    src: '',
    fields: '',
    usages: [
      {
        name: 'PUSH_RESOURCE_CHANGE',
        feat: 'secret-realm',
        file: 'feats/activity/secret-realm/constants.js',
      },
    ],
  },
  {
    cmd: 21523,
    dir: 'S2C',
    note: 'push 秘境单点战斗信息（PVP/PVE 面板料源，按 cellIndex 键控）',
    src: '',
    fields: '',
    usages: [
      {
        name: 'PUSH_POINT_FIGHTING_INFO',
        feat: 'secret-realm',
        file: 'feats/activity/secret-realm/constants.js',
      },
    ],
  },
  {
    cmd: 21525,
    dir: 'S2C',
    note: 'push 秘境房间背包刷新（治疗余量随它变）',
    src: '',
    fields: 'push {bagInfo:[{itemId,itemCount}]}（房间背包，治疗余量随它变）',
    usages: [
      {
        name: 'PUSH_BAG_INFO',
        feat: 'secret-realm',
        file: 'feats/activity/secret-realm/constants.js',
      },
    ],
  },
  {
    cmd: 21527,
    dir: 'S2C',
    note: 'push 秘境兽事件（无 eventType/eventEndTime；只作轮询兜底候选来源）',
    src: '',
    fields: '',
    usages: [
      {
        name: 'PUSH_BEAST_EVENT',
        feat: 'secret-realm',
        file: 'feats/activity/secret-realm/constants.js',
      },
    ],
  },
  {
    cmd: 21529,
    dir: 'S2C',
    note: 'push 秘境队伍到达（{x,y,pointType}；8521→10007→8522→21529 时序链）',
    src: '',
    fields: '',
    usages: [
      {
        name: 'PUSH_TEAM_ARRIVE',
        feat: 'secret-realm',
        file: 'feats/activity/secret-realm/constants.js',
      },
    ],
  },
  {
    cmd: 21530,
    dir: 'S2C',
    note: 'push 秘境拍宠物进度（只用于识别换宠/收尾，闸门直读游戏现场 capturingPetPos）',
    src: '',
    fields: 'push {x,y,boss:0|1}（capturingPetPos 写；闸门直读游戏现场）',
    usages: [
      {
        name: 'PUSH_FEED_BEAST',
        feat: 'secret-realm',
        file: 'feats/activity/secret-realm/constants.js',
      },
    ],
  },
  {
    cmd: 21532,
    dir: 'S2C',
    note: 'push 秘境掉落箱变动（{x,y,dropInfo[],beastGetNum,bagGetNum}；业务体在 ev.data.data）',
    src: '',
    fields: '',
    usages: [
      {
        name: 'PUSH_DROP_CHANGE',
        feat: 'secret-realm',
        file: 'feats/activity/secret-realm/constants.js',
      },
    ],
  },
  {
    cmd: 21534,
    dir: 'S2C',
    note: 'push 秘境被攻击预警计数（{num}；纯展示无撤离按钮，转移即消警）',
    src: '',
    fields: '',
    usages: [
      {
        name: 'PUSH_SELF_ATTACKED',
        feat: 'secret-realm',
        file: 'feats/activity/secret-realm/constants.js',
      },
    ],
  },
  {
    cmd: 21535,
    dir: 'S2C',
    note: 'push 秘境 BOSS 状态（稀疏只作 kick 源；state21=战斗窗口结束）',
    src: '',
    fields:
      'push {stateInfo:[{bossId,pos:{x,y,k,rid},state,stateEndTime秒}]}（或扁平数组；整表替换，稀疏只作 kick 源）',
    usages: [
      {
        name: 'PUSH_BOSS_STATE',
        feat: 'secret-realm',
        file: 'feats/activity/secret-realm/constants.js',
      },
    ],
  },
  {
    cmd: 21536,
    dir: 'S2C',
    note: 'push 拍宠物时被他人攻击（游戏侧无消费者；只登记，计数只看 21534）',
    src: '',
    fields: '',
    usages: [
      {
        name: 'PUSH_OTHER_ATTACK_ON_FEED',
        feat: 'secret-realm',
        file: 'feats/activity/secret-realm/constants.js',
      },
    ],
  },
  {
    cmd: 21539,
    dir: 'S2C',
    note: 'push 小 BOSS 石头账本（rewardNum<rewardMaxNum && isFight===1 才可领，不以 BOSS 死亡为前置）',
    src: '',
    fields:
      'push {rewardInfo:[{bossId,fightTime:Int64,rewardInfo:[{pos:{x,y,k,rid},rewardNum,rewardMaxNum,isFight}×5]}]}（每次全量；可领=isFight===1 && rewardNum<rewardMaxNum）',
    usages: [
      {
        name: 'PUSH_BOSS_GUARD_REWARD',
        feat: 'secret-realm',
        file: 'feats/activity/secret-realm/constants.js',
      },
    ],
  },
  {
    cmd: 21540,
    dir: 'S2C',
    note: 'push BOSS 投喂他人视图（只登记留档，链路未接入）',
    src: '',
    fields: '',
    usages: [
      {
        name: 'PUSH_BOSS_FEED_VIEW',
        feat: 'secret-realm',
        file: 'feats/activity/secret-realm/constants.js',
      },
    ],
  },
  {
    cmd: 21653,
    dir: null,
    note: '',
    src: '',
    fields: '',
    usages: [
      {
        name: 'CMD_FLOAT_PARADE_REWARD_LUCKY_BAG',
        feat: 'floatcar',
        file: 'feats/activity/floatcar/constants.js',
      },
    ],
  },
];
