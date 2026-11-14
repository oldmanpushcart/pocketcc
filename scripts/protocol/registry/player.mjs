// 协议注册表 · player 域 —— 机械抽取 + 人工标注（dir/note/src/fields 重跑保留，usages 重跑重建）。
// 生成：node scripts/protocol/extract.mjs；闸门：tests/protocol-registry.test.js（npm test）。
// 条目键 = 协议号；名字是 feat 局部别名（同名异号是局部命名，非漂移）。只链不搬：src 指 references/ 出处。
export default [
  {
    "cmd": 102,
    "dir": "C2S",
    "note": "收取主城建筑产出（V1 send，{id:建筑实例id}）",
    "src": "",
    "usages": [
      {
        "name": "CMD_GET_ORDER",
        "feat": "auto-coin-collect",
        "file": "feats/player/auto-coin-collect.js"
      }
    ],
    "fields": ""
  },
  {
    "cmd": 151,
    "dir": "C2S",
    "note": "钻石加速本地全部在修队列",
    "src": "",
    "usages": [
      {
        "name": "CMD_ORDER_QUEUE_ING_DONE",
        "feat": "quick-repair",
        "file": "feats/player/quick-repair.js"
      }
    ],
    "fields": "req {} 全部在修 | {id} 单条（V1 send）"
  },
  {
    "cmd": 220,
    "dir": "C2S",
    "note": "本地批量修理（服务器自动优先扣免费额度）",
    "src": "",
    "usages": [
      {
        "name": "CMD_ARMY_HEAL_LIST",
        "feat": "quick-repair",
        "file": "feats/player/quick-repair.js"
      }
    ],
    "fields": "req {ids:非空字符串数组}（V1 send；服务器自动优先扣免费额度）"
  },
  {
    "cmd": 825,
    "dir": "C2S",
    "note": "领取每日补给免费计时奖励（V1 send）",
    "src": "",
    "usages": [
      {
        "name": "CMD_GET_TIME_REWARD",
        "feat": "daily-supply",
        "file": "feats/player/daily-supply.js"
      }
    ],
    "fields": ""
  },
  {
    "cmd": 927,
    "dir": "C2S",
    "note": "按 reportId 拉战报（旧 send 链路，reportStr 解析后含 battle.defender）",
    "src": "",
    "usages": [
      {
        "name": "CMD_REPORT",
        "feat": "truck-intercept",
        "file": "feats/player/truck-intercept.js"
      }
    ],
    "fields": ""
  },
  {
    "cmd": 999,
    "dir": "C2S",
    "note": "查询一支编队实际战力（旧 send 链路，ret.data 字符串需 parse）",
    "src": "",
    "usages": [
      {
        "name": "CMD_POWER",
        "feat": "truck-intercept",
        "file": "feats/player/truck-intercept.js"
      }
    ],
    "fields": ""
  },
  {
    "cmd": 1026,
    "dir": "C2S",
    "note": "查惧星当日计数（应答 d 含 thorSearchNum=今日已搜次数）",
    "src": "",
    "usages": [
      {
        "name": "CMD_GET_JION_ALL_RCTIME",
        "feat": "fear-star-rally",
        "file": "feats/player/fear-star-rally.js"
      }
    ],
    "fields": ""
  },
  {
    "cmd": 1031,
    "dir": "C2S",
    "note": "本人机械设施权威列表（{list:[塔对象]}，pid=自己 UID 字符串）",
    "src": "",
    "usages": [
      {
        "name": "CMD_GET_TOWER_LIST",
        "feat": "auto-farm",
        "file": "feats/player/auto-farm/mech-build.js"
      }
    ],
    "fields": ""
  },
  {
    "cmd": 1032,
    "dir": "C2S",
    "note": "销毁塔（{id:塔实例id 字符串}）——引擎只用它取消在建 st=2 的塔",
    "src": "",
    "usages": [
      {
        "name": "CMD_TOWER_REMOVE",
        "feat": "auto-farm",
        "file": "feats/player/auto-farm/mech-build.js"
      }
    ],
    "fields": ""
  },
  {
    "cmd": 1033,
    "dir": "C2S",
    "note": "建塔行军（V1 net.send 非 PB）",
    "src": "references/游戏逆向/战斗模块分析报告.md",
    "usages": [
      {
        "name": "CMD_MARCH_WORLD_BUILD",
        "feat": "auto-farm",
        "file": "feats/player/auto-farm/mech-build.js"
      }
    ],
    "fields": ""
  },
  {
    "cmd": 1034,
    "dir": "C2S",
    "note": "单塔详情（{id:塔实例id 字符串} 防 Int64 截断；army_size=当前驻军）",
    "src": "",
    "usages": [
      {
        "name": "CMD_GET_TOWERINFO",
        "feat": "auto-farm",
        "file": "feats/player/auto-farm/mech-build.js"
      },
      {
        "name": "CMD_GET_TOWERINFO",
        "feat": "auto-farm",
        "file": "feats/player/auto-farm/tower-scanner.js"
      }
    ],
    "fields": ""
  },
  {
    "cmd": 1193,
    "dir": "C2S",
    "note": "全量拉联盟记录（含机械田建造事件，视口无关）",
    "src": "",
    "usages": [
      {
        "name": "CMD_ALLIANCE_RECORD_DATA",
        "feat": "auto-farm",
        "file": "feats/player/auto-farm/tower-scanner.js"
      }
    ],
    "fields": ""
  },
  {
    "cmd": 1201,
    "dir": "C2S",
    "note": "创建联盟集结（ALLIANCE_Assembly_Create；机甲/惧星/战锤 feat 直发）",
    "src": "references/游戏逆向/联盟机甲模块分析报告.md",
    "usages": [
      {
        "name": "CMD_CREATE_RALLY",
        "feat": "auto-hunt",
        "file": "feats/player/auto-hunt.js"
      },
      {
        "name": "CMD_CREATE_RALLY",
        "feat": "fear-star-rally",
        "file": "feats/player/fear-star-rally.js"
      },
      {
        "name": "CMD_CREATE_RALLY",
        "feat": "radar-task",
        "file": "feats/player/radar-task.js"
      }
    ],
    "fields": "req {marchType:8,x,y,time:集结秒,armyList,armyListNew,heroList,trapList,formation,formationV2[,extraArmy]}（JSON send）"
  },
  {
    "cmd": 1387,
    "dir": "C2S",
    "note": "制药队列唯一权威读（getStrengthenMakingData，恒含 {making,unlock}）",
    "src": "",
    "usages": [
      {
        "name": "CMD_INFO",
        "feat": "potion-craft",
        "file": "feats/player/potion-craft.js"
      }
    ],
    "fields": ""
  },
  {
    "cmd": 1388,
    "dir": "C2S",
    "note": "排一条配方进制药队列（MAKE_FORMULA，{id}）",
    "src": "",
    "usages": [
      {
        "name": "CMD_MAKE",
        "feat": "potion-craft",
        "file": "feats/player/potion-craft.js"
      }
    ],
    "fields": ""
  },
  {
    "cmd": 1397,
    "dir": "C2S",
    "note": "领取已完成产物（ProductionReward，{type}，制药 lane 恒 1）",
    "src": "",
    "usages": [
      {
        "name": "CMD_CLAIM",
        "feat": "potion-craft",
        "file": "feats/player/potion-craft.js"
      }
    ],
    "fields": ""
  },
  {
    "cmd": 1426,
    "dir": "C2S",
    "note": "跨服战场医院队列权威读",
    "src": "",
    "usages": [
      {
        "name": "CMD_GET_CROSS_HOSPITAL_QUEUES",
        "feat": "quick-repair",
        "file": "feats/player/quick-repair.js"
      }
    ],
    "fields": "req {}（V1 send）→ resp {queues:[{id,st}]} st 0=待修"
  },
  {
    "cmd": 1427,
    "dir": "C2S",
    "note": "跨服/雷神修理（消耗材料）",
    "src": "",
    "usages": [
      {
        "name": "CMD_ARMY_CROSS_HEAL",
        "feat": "quick-repair",
        "file": "feats/player/quick-repair.js"
      }
    ],
    "fields": "req {ids:非空字符串数组}（V1 send，消耗材料）"
  },
  {
    "cmd": 1428,
    "dir": "C2S",
    "note": "钻石加速跨服医院队列（SPEEDUP_CROSS_HOSPITAL_QUEUE_BY_GOLD）",
    "src": "",
    "usages": [
      {
        "name": "CMD_SPEEDUP_CROSS_GOLD",
        "feat": "quick-repair",
        "file": "feats/player/quick-repair.js"
      }
    ],
    "fields": "req {} 全部 | {id} 单条（V1 send）"
  },
  {
    "cmd": 1570,
    "dir": "C2S",
    "note": "异能兽池全量（ENIGMA_BEAST_GET_INFO，req {} → infos[]）",
    "src": "",
    "usages": [
      {
        "name": "CMD_GET_INFO",
        "feat": "beast-breed",
        "file": "feats/player/beast-breed.js"
      }
    ],
    "fields": ""
  },
  {
    "cmd": 1579,
    "dir": "C2S",
    "note": "设我家主宠（ENIGMA_BEAST_BREEDING_MAIN_SET）",
    "src": "",
    "usages": [
      {
        "name": "CMD_MAIN_SET",
        "feat": "beast-breed",
        "file": "feats/player/beast-breed.js"
      }
    ],
    "fields": ""
  },
  {
    "cmd": 1580,
    "dir": "C2S",
    "note": "申请把我的兽放到 uid 家 / apply:false 撤回（{uid,id:Int64,apply}）",
    "src": "",
    "usages": [
      {
        "name": "CMD_OTHER_APPLY",
        "feat": "beast-breed",
        "file": "feats/player/beast-breed.js"
      }
    ],
    "fields": ""
  },
  {
    "cmd": 1581,
    "dir": "C2S",
    "note": "处理别人对我家的培育申请（{uid,id:Int64,agree}）",
    "src": "",
    "usages": [
      {
        "name": "CMD_OTHER_APPLY_OP",
        "feat": "beast-breed",
        "file": "feats/player/beast-breed.js"
      }
    ],
    "fields": ""
  },
  {
    "cmd": 1582,
    "dir": "C2S",
    "note": "待我处理的培育申请列表（req {} → apply[]）",
    "src": "",
    "usages": [
      {
        "name": "CMD_OTHER_APPLY_LIST",
        "feat": "beast-breed",
        "file": "feats/player/beast-breed.js"
      }
    ],
    "fields": ""
  },
  {
    "cmd": 1583,
    "dir": "C2S",
    "note": "与我相关的培育家列表（req {} → info[]）",
    "src": "",
    "usages": [
      {
        "name": "CMD_MAIN_LIST",
        "feat": "beast-breed",
        "file": "feats/player/beast-breed.js"
      }
    ],
    "fields": ""
  },
  {
    "cmd": 1584,
    "dir": "C2S",
    "note": "领取该家培育产出（{uid}）",
    "src": "",
    "usages": [
      {
        "name": "CMD_BREEDING_BORN",
        "feat": "beast-breed",
        "file": "feats/player/beast-breed.js"
      }
    ],
    "fields": ""
  },
  {
    "cmd": 1585,
    "dir": "C2S",
    "note": "可拜访培育家全量列表（req {} → visit[]）",
    "src": "",
    "usages": [
      {
        "name": "CMD_VISIT_LIST",
        "feat": "beast-breed",
        "file": "feats/player/beast-breed.js"
      }
    ],
    "fields": ""
  },
  {
    "cmd": 1587,
    "dir": "C2S",
    "note": "帮盟友加速培育（{uid}）",
    "src": "",
    "usages": [
      {
        "name": "CMD_BREEDING_HELP",
        "feat": "beast-breed",
        "file": "feats/player/beast-breed.js"
      }
    ],
    "fields": ""
  },
  {
    "cmd": 1599,
    "dir": "C2S",
    "note": "领取「帮助培育」累计奖励（req {}）",
    "src": "",
    "usages": [
      {
        "name": "CMD_HELP_BORN_REWARD",
        "feat": "beast-breed",
        "file": "feats/player/beast-breed.js"
      }
    ],
    "fields": ""
  },
  {
    "cmd": 1643,
    "dir": "C2S",
    "note": "军火库排一条材料进生产队列",
    "src": "",
    "usages": [
      {
        "name": "CMD_PRODUCE",
        "feat": "armory-material",
        "file": "feats/player/armory-material.js"
      }
    ],
    "fields": ""
  },
  {
    "cmd": 1645,
    "dir": "C2S",
    "note": "军火库收割已到期产物（恒返回权威队列 {st,wait}，启动须先读再产）",
    "src": "",
    "usages": [
      {
        "name": "CMD_PRODUCE_GET",
        "feat": "armory-material",
        "file": "feats/player/armory-material.js"
      }
    ],
    "fields": ""
  },
  {
    "cmd": 1752,
    "dir": "C2S",
    "note": "拉城市皮肤技能冷却数据（{} → d.skinSkills[]）",
    "src": "",
    "usages": [
      {
        "name": "CMD_GET_CITY_SKILL_DATA",
        "feat": "city-skill",
        "file": "feats/player/city-skill.js"
      }
    ],
    "fields": ""
  },
  {
    "cmd": 1753,
    "dir": "C2S",
    "note": "使用/赠送城市皮肤技能（{skinId,targetUid}）",
    "src": "",
    "usages": [
      {
        "name": "CMD_USE_CITY_SKILL",
        "feat": "city-skill",
        "file": "feats/player/city-skill.js"
      }
    ],
    "fields": ""
  },
  {
    "cmd": 1785,
    "dir": "C2S",
    "note": "快速修理额度权威读（GET_QUICK_REPARE_INFO，V1 send）",
    "src": "",
    "usages": [
      {
        "name": "CMD_GET_QUICK_REPARE",
        "feat": "quick-repair",
        "file": "feats/player/quick-repair.js"
      }
    ],
    "fields": "req {}（V1 send）→ resp d.{common_max,common_use,thor_max,thor_use}"
  },
  {
    "cmd": 3504,
    "dir": "C2S",
    "note": "雷达主数据全量（RadarGetInfo，{clearFinishNotify:1} 真机实证）",
    "src": "",
    "usages": [
      {
        "name": "CMD_GET_INFO",
        "feat": "radar-task",
        "file": "feats/player/radar-task.js"
      }
    ],
    "fields": "req {clearFinishNotify:1} → resp 事件三形态：day_group_events 两层嵌套 / group_events / events 扁平（事件含 id+taskId）"
  },
  {
    "cmd": 3505,
    "dir": "C2S",
    "note": "雷达认领任务（RadarStartTask，{id}，state 0→1）",
    "src": "",
    "usages": [
      {
        "name": "CMD_START_TASK",
        "feat": "radar-task",
        "file": "feats/player/radar-task.js"
      }
    ],
    "fields": "req {id:数值}（非 Int64 对象/字符串；认领时 state 必 0）→ state 0→1"
  },
  {
    "cmd": 3508,
    "dir": "C2S",
    "note": "雷达领奖（RadarGetReward，{id}，state=4 可用）",
    "src": "",
    "usages": [
      {
        "name": "CMD_GET_REWARD",
        "feat": "radar-task",
        "file": "feats/player/radar-task.js"
      }
    ],
    "fields": "req {id}（领奖时 state 必 4）"
  },
  {
    "cmd": 3515,
    "dir": "C2S",
    "note": "一键击退雷达干扰攻击（RadarDefend，req 恒空体 → {sign}）",
    "src": "",
    "usages": [
      {
        "name": "CMD_DEFEND",
        "feat": "radar-task",
        "file": "feats/player/radar-task.js"
      }
    ],
    "fields": "req 恒空体 → resp {sign}"
  },
  {
    "cmd": 3821,
    "dir": "C2S",
    "note": "给某玩家点赞（LIKE_OTHER，{uid,type,instanceIdStr}）",
    "src": "references/历史文档/玩家点赞.md",
    "usages": [
      {
        "name": "CMD_LIKE_OTHER",
        "feat": "player-like",
        "file": "feats/player/player-like.js"
      }
    ],
    "fields": ""
  },
  {
    "cmd": 4168,
    "dir": "C2S",
    "note": "收取空投建筑奖励（Get_Home_Air_Drop_Reward，旧 JSON V1，{targetId}）",
    "src": "",
    "usages": [
      {
        "name": "CMD_COLLECT",
        "feat": "secret-weapon-drop",
        "file": "feats/player/secret-weapon-drop.js"
      }
    ],
    "fields": ""
  },
  {
    "cmd": 4169,
    "dir": "C2S",
    "note": "查秘密武器特技次数/冷却（CD_SKILL_INFO，PB V1；发 4170 前的权威闸门）",
    "src": "",
    "usages": [
      {
        "name": "CMD_SKILL_INFO",
        "feat": "secret-weapon-drop",
        "file": "feats/player/secret-weapon-drop.js"
      }
    ],
    "fields": ""
  },
  {
    "cmd": 4170,
    "dir": "C2S",
    "note": "使用秘密武器特技（CD_SKILL_USE，PB V1，{header,cdSkillUse:{id,param:[x,y]}}）",
    "src": "",
    "usages": [
      {
        "name": "CMD_USE_SKILL",
        "feat": "secret-weapon-drop",
        "file": "feats/player/secret-weapon-drop.js"
      }
    ],
    "fields": ""
  },
  {
    "cmd": 5684,
    "dir": "C2S",
    "note": "集中领取态查询（TASK_RELAX_ONE_CLICK_GET_INFO，sendPBV2）",
    "src": "",
    "usages": [
      {
        "name": "CMD_INFO",
        "feat": "one-click-claim",
        "file": "feats/player/one-click-claim.js"
      }
    ],
    "fields": ""
  },
  {
    "cmd": 5685,
    "dir": "C2S",
    "note": "一键领取全部可用行（TASK_RELAX_ONE_CLICK_GET_REWARD，sendPBV2）",
    "src": "",
    "usages": [
      {
        "name": "CMD_REWARD",
        "feat": "one-click-claim",
        "file": "feats/player/one-click-claim.js"
      }
    ],
    "fields": ""
  },
  {
    "cmd": 6310,
    "dir": "C2S",
    "note": "普通无双医院权威读（AVA_ASK_HOSPITAL_DATA，请求体恒 null）",
    "src": "",
    "usages": [
      {
        "name": "CMD_AVA_ASK",
        "feat": "quick-repair",
        "file": "feats/player/quick-repair.js"
      }
    ],
    "fields": "req 体恒 null（V1 send）→ resp {list:[{id,orderId,state}]} state 0=待修 1=在修，orderId='0' 无效行"
  },
  {
    "cmd": 6311,
    "dir": "C2S",
    "note": "无双批量修待修（AVA_CURE_ALL_ARMYS_DATA，{ids}）",
    "src": "",
    "usages": [
      {
        "name": "CMD_AVA_CURE",
        "feat": "quick-repair",
        "file": "feats/player/quick-repair.js"
      }
    ],
    "fields": "req {ids:非空字符串数组}（目标 ∈ state0 集）"
  },
  {
    "cmd": 6312,
    "dir": "C2S",
    "note": "无双加速在修（AVA_SPEED_CURE，钻石/道具同一命令两种 body）",
    "src": "",
    "usages": [
      {
        "name": "CMD_AVA_SPEED",
        "feat": "quick-repair",
        "file": "feats/player/quick-repair.js"
      }
    ],
    "fields": "req {ids,useGold:0|1} 钻石 | {ids,itemId,num,useGold} 道具（目标 ∈ state0∪state1）"
  },
  {
    "cmd": 6356,
    "dir": "C2S",
    "note": "TM 战场医院权威读（TEAM_MATCH_ASK_HOSPITAL_DATA）",
    "src": "",
    "usages": [
      {
        "name": "CMD_TM_ASK",
        "feat": "quick-repair",
        "file": "feats/player/quick-repair.js"
      }
    ],
    "fields": "req 体恒 null（V1 send）→ resp {list:[{id,orderId,state}]}（TM 同 6310 族）"
  },
  {
    "cmd": 6357,
    "dir": "C2S",
    "note": "TM 批量修待修（TEAM_MATCH_CURE_ALL_ARMYS_DATA）",
    "src": "",
    "usages": [
      {
        "name": "CMD_TM_CURE",
        "feat": "quick-repair",
        "file": "feats/player/quick-repair.js"
      }
    ],
    "fields": "req {ids:非空字符串数组}（TM 同 6311 族）"
  },
  {
    "cmd": 6358,
    "dir": "C2S",
    "note": "TM 加速在修（TEAM_MATCH_SPEED_CURE）",
    "src": "",
    "usages": [
      {
        "name": "CMD_TM_SPEED",
        "feat": "quick-repair",
        "file": "feats/player/quick-repair.js"
      }
    ],
    "fields": "req {ids,useGold:0|1} | {ids,itemId,num,useGold}（TM 同 6312 族）"
  },
  {
    "cmd": 6473,
    "dir": "C2S",
    "note": "打开可拦截车队列表（ESCORT_TRUCK_LOOT_TRUCK_VIEW_OPEN）",
    "src": "references/游戏逆向/卡车争夺模块分析报告.md",
    "usages": [
      {
        "name": "CMD_OPEN",
        "feat": "truck-intercept",
        "file": "feats/player/truck-intercept.js"
      }
    ],
    "fields": ""
  },
  {
    "cmd": 6474,
    "dir": "C2S",
    "note": "刷新（重随机）可拦截列表（ESCORT_TRUCK_LOOT_TRUCK_VIEW_RELOAD）",
    "src": "references/历史文档/卡车争夺.md",
    "usages": [
      {
        "name": "CMD_RELOAD",
        "feat": "truck-intercept",
        "file": "feats/player/truck-intercept.js"
      }
    ],
    "fields": ""
  },
  {
    "cmd": 6476,
    "dir": "C2S",
    "note": "对某车队发起拦截掠夺（ESCORT_TRUCK_LOOT，核心战斗请求）",
    "src": "references/历史文档/卡车争夺.md",
    "usages": [
      {
        "name": "CMD_LOOT",
        "feat": "truck-intercept",
        "file": "feats/player/truck-intercept.js"
      }
    ],
    "fields": ""
  },
  {
    "cmd": 6486,
    "dir": "C2S",
    "note": "拉卡车拦截每日次数与刷新时间点（ESCORT_TRUCK_GET_REFRESH_INFO）",
    "src": "references/历史文档/卡车争夺.md",
    "usages": [
      {
        "name": "CMD_REFRESH",
        "feat": "truck-intercept",
        "file": "feats/player/truck-intercept.js"
      }
    ],
    "fields": ""
  },
  {
    "cmd": 7414,
    "dir": "C2S",
    "note": "盟矿列表·控制器版（OTHER_MINE_CAVE_INFO，{uid} → data.infos 完整矿条目）",
    "src": "references/游戏逆向/次元矿洞模块分析报告.md",
    "usages": [
      {
        "name": "CMD_OTHER_INFO",
        "feat": "mine-cave",
        "file": "feats/player/mine-cave/mining.js"
      }
    ],
    "fields": ""
  },
  {
    "cmd": 7415,
    "dir": "C2S",
    "note": "世界矿（WORLD_MINE_CAVE_INFO，{refresh}：0 进入拉取/1 刷新）",
    "src": "references/游戏逆向/次元矿洞模块分析报告.md",
    "usages": [
      {
        "name": "CMD_WORLD_INFO",
        "feat": "mine-cave",
        "file": "feats/player/mine-cave/steal-pack.js"
      }
    ],
    "fields": ""
  },
  {
    "cmd": 7416,
    "dir": "C2S",
    "note": "能量裂隙探测刷新全部自矿（MINE_CAVE_REFRESH，{isAll:1} → {isOk,todayRefreshNum}）",
    "src": "references/游戏逆向/次元矿洞模块分析报告.md",
    "usages": [
      {
        "name": "CMD_REFRESH",
        "feat": "mine-cave",
        "file": "feats/player/mine-cave/mining.js"
      }
    ],
    "fields": ""
  },
  {
    "cmd": 7417,
    "dir": "C2S",
    "note": "派英雄占领矿（MINE_CAVE_OCCUPY，{id,uid,heroIds}，先过 getIsHaveOccupyNum）",
    "src": "references/游戏逆向/次元矿洞模块分析报告.md",
    "usages": [
      {
        "name": "CMD_OCCUPY",
        "feat": "mine-cave",
        "file": "feats/player/mine-cave/mining.js"
      }
    ],
    "fields": ""
  },
  {
    "cmd": 7418,
    "dir": "C2S",
    "note": "帮助盟友采集（MINE_CAVE_HELP，{id,uid}，针对 canHelp=1 的 GATHERING 矿）",
    "src": "references/游戏逆向/次元矿洞模块分析报告.md",
    "usages": [
      {
        "name": "CMD_HELP",
        "feat": "mine-cave",
        "file": "feats/player/mine-cave/steal-pack.js"
      }
    ],
    "fields": ""
  },
  {
    "cmd": 7419,
    "dir": "C2S",
    "note": "偷取世界矿（MINE_CAVE_STEAL，{id,uid,serverId}；stealNum≥上限拒 mine_cave72）",
    "src": "references/游戏逆向/次元矿洞模块分析报告.md",
    "usages": [
      {
        "name": "CMD_STEAL",
        "feat": "mine-cave",
        "file": "feats/player/mine-cave/steal-pack.js"
      }
    ],
    "fields": ""
  },
  {
    "cmd": 7420,
    "dir": "C2S",
    "note": "帮盟友打包（MINE_CAVE_HELP_PACK，{id,uid} → packNum/packAllNum，目标矿 state=4）",
    "src": "references/游戏逆向/次元矿洞模块分析报告.md",
    "usages": [
      {
        "name": "CMD_HELP_PACK",
        "feat": "mine-cave",
        "file": "feats/player/mine-cave/steal-pack.js"
      }
    ],
    "fields": ""
  },
  {
    "cmd": 7421,
    "dir": "C2S",
    "note": "单矿详情（MINE_CAVE_SINGLE_INFO，{id,uid} → allGatherNum/gatherTime/usedHeroIds 等）",
    "src": "references/游戏逆向/次元矿洞模块分析报告.md",
    "usages": [
      {
        "name": "CMD_SINGLE_INFO",
        "feat": "mine-cave",
        "file": "feats/player/mine-cave/mining.js"
      }
    ],
    "fields": ""
  },
  {
    "cmd": 7422,
    "dir": "C2S",
    "note": "领取采集完成奖励（MINE_CAVE_REWARD，{id} → reward）",
    "src": "references/游戏逆向/次元矿洞模块分析报告.md",
    "usages": [
      {
        "name": "CMD_REWARD",
        "feat": "mine-cave",
        "file": "feats/player/mine-cave/mining.js"
      }
    ],
    "fields": ""
  },
  {
    "cmd": 7424,
    "dir": "C2S",
    "note": "领「他人来采」我方矿分成（MINE_CAVE_GET_OTHER_GATHER_REWARD，{pos}）",
    "src": "references/游戏逆向/次元矿洞模块分析报告.md",
    "usages": [
      {
        "name": "CMD_OTHER_GATHER_REWARD",
        "feat": "mine-cave",
        "file": "feats/player/mine-cave/mining.js"
      }
    ],
    "fields": ""
  },
  {
    "cmd": 7425,
    "dir": "C2S",
    "note": "盟友矿洞面板版（OTHER_MINE_CAVE_INFO2，{} → infos[] 含 uid/playerInfo/list[5槽]）",
    "src": "references/游戏逆向/次元矿洞模块分析报告.md",
    "usages": [
      {
        "name": "CMD_OTHER_INFO2",
        "feat": "mine-cave",
        "file": "feats/player/mine-cave/mining.js"
      }
    ],
    "fields": ""
  },
  {
    "cmd": 7427,
    "dir": "C2S",
    "note": "采集前校验（MINE_CAVE_CHECK_SHARE_GATHER，{uid,id}，isOk=1 才开面板）",
    "src": "references/游戏逆向/次元矿洞模块分析报告.md",
    "usages": [
      {
        "name": "CMD_CHECK_SHARE",
        "feat": "mine-cave",
        "file": "feats/player/mine-cave/mining.js"
      }
    ],
    "fields": ""
  },
  {
    "cmd": 7428,
    "dir": "C2S",
    "note": "自矿聚合（SELF_MINE_CAVE_INFO2，{openPanel} → selfMineInfo）",
    "src": "references/游戏逆向/次元矿洞模块分析报告.md",
    "usages": [
      {
        "name": "CMD_SELF_INFO2",
        "feat": "mine-cave",
        "file": "feats/player/mine-cave/mining.js"
      }
    ],
    "fields": ""
  },
  {
    "cmd": 7429,
    "dir": "C2S",
    "note": "领取联盟矿洞奖励（MINE_CAVE_GET_ALLIANCE_REWARD）",
    "src": "references/游戏逆向/次元矿洞模块分析报告.md",
    "usages": [
      {
        "name": "CMD_ALLIANCE_REWARD",
        "feat": "mine-cave",
        "file": "feats/player/mine-cave/mining.js"
      }
    ],
    "fields": ""
  },
  {
    "cmd": 8403,
    "dir": "C2S",
    "note": "Master 战场医院权威读（MASTER_MATCH_ASK_HOSPITAL_DATA）",
    "src": "",
    "usages": [
      {
        "name": "CMD_MASTER_ASK",
        "feat": "quick-repair",
        "file": "feats/player/quick-repair.js"
      }
    ],
    "fields": "req 体恒 null（V1 send）→ resp {list:[{id,orderId,state}]}（Master 同 6310 族）"
  },
  {
    "cmd": 8404,
    "dir": "C2S",
    "note": "Master 批量修待修（MASTER_MATCH_CURE_ALL_ARMYS_DATA）",
    "src": "",
    "usages": [
      {
        "name": "CMD_MASTER_CURE",
        "feat": "quick-repair",
        "file": "feats/player/quick-repair.js"
      }
    ],
    "fields": "req {ids:非空字符串数组}（Master 同 6311 族）"
  },
  {
    "cmd": 8405,
    "dir": "C2S",
    "note": "Master 加速在修（MASTER_MATCH_SPEED_CURE）",
    "src": "",
    "usages": [
      {
        "name": "CMD_MASTER_SPEED",
        "feat": "quick-repair",
        "file": "feats/player/quick-repair.js"
      }
    ],
    "fields": "req {ids,useGold:0|1} | {ids,itemId,num,useGold}（Master 同 6312 族）"
  },
  {
    "cmd": 9055,
    "dir": "C2S",
    "note": "Legend 战场医院权威读（TEAM_LEGEND_ASK_HOSPITAL_DATA）",
    "src": "",
    "usages": [
      {
        "name": "CMD_LEGEND_ASK",
        "feat": "quick-repair",
        "file": "feats/player/quick-repair.js"
      }
    ],
    "fields": "req 体恒 null（V1 send）→ resp {list:[{id,orderId,state}]}（Legend 同 6310 族）"
  },
  {
    "cmd": 9056,
    "dir": "C2S",
    "note": "Legend 批量修待修（TEAM_LEGEND_CURE_ALL_ARMYS_DATA）",
    "src": "",
    "usages": [
      {
        "name": "CMD_LEGEND_CURE",
        "feat": "quick-repair",
        "file": "feats/player/quick-repair.js"
      }
    ],
    "fields": "req {ids:非空字符串数组}（Legend 同 6311 族）"
  },
  {
    "cmd": 9057,
    "dir": "C2S",
    "note": "Legend 加速在修（TEAM_LEGEND_SPEED_CURE）",
    "src": "",
    "usages": [
      {
        "name": "CMD_LEGEND_SPEED",
        "feat": "quick-repair",
        "file": "feats/player/quick-repair.js"
      }
    ],
    "fields": "req {ids,useGold:0|1} | {ids,itemId,num,useGold}（Legend 同 6312 族）"
  },
  {
    "cmd": 9706,
    "dir": "C2S",
    "note": "查广告月卡各槽位当日已领态（sendPBV2）",
    "src": "",
    "usages": [
      {
        "name": "CMD_WATCH_INFO",
        "feat": "ad-diamond",
        "file": "feats/player/ad-diamond.js"
      }
    ],
    "fields": ""
  },
  {
    "cmd": 9707,
    "dir": "C2S",
    "note": "领广告月卡指定槽位一次看广告奖励（sendPBV2）",
    "src": "",
    "usages": [
      {
        "name": "CMD_WATCH_REWARD",
        "feat": "ad-diamond",
        "file": "feats/player/ad-diamond.js"
      }
    ],
    "fields": ""
  },
  {
    "cmd": 9884,
    "dir": "C2S",
    "note": "领取每日特惠免费奖励（HERO_DAILY_EXCHANGE_GET_FREE_REWARD，空载荷）",
    "src": "",
    "usages": [
      {
        "name": "CMD_GET_FREE_REWARD",
        "feat": "daily-deal",
        "file": "feats/player/daily-deal.js"
      }
    ],
    "fields": ""
  },
  {
    "cmd": 9952,
    "dir": "C2S",
    "note": "战争之源攻击次数奖励领取（{attackCount:门槛}，1/3/5 三档真机实证）",
    "src": "references/游戏逆向/战争之源模块分析报告.md",
    "usages": [
      {
        "name": "CMD_CLAIM_ATTACK_REWARD",
        "feat": "source-of-war",
        "file": "feats/player/source-of-war/reward.js"
      }
    ],
    "fields": ""
  },
  {
    "cmd": 9956,
    "dir": "C2S",
    "note": "查询当前战争之源 BOSS（旧 JSON send → {bossId,id,x,y,reason}）",
    "src": "references/游戏逆向/战争之源模块分析报告.md",
    "usages": [
      {
        "name": "CMD_GET_BOSS_INFO_V2",
        "feat": "source-of-war",
        "file": "feats/player/source-of-war/attack.js"
      }
    ],
    "fields": ""
  },
  {
    "cmd": 10120,
    "dir": "S2C",
    "note": "push 本地伤兵队列入队/改态（ORDER_QUEUES_BATCH_INFO）",
    "src": "",
    "usages": [
      {
        "name": "PUSH_ORDER_QUEUES",
        "feat": "quick-repair",
        "file": "feats/player/quick-repair.js"
      }
    ],
    "fields": "push {orderQueues:[{id,orderId,type,state}]}（只取 type=治疗且 orderId≠'0'；state 0=待修）"
  },
  {
    "cmd": 10130,
    "dir": "S2C",
    "note": "push 兽池单条变更（ENIGMA_BEAST_CHANGE，仅作唤醒）",
    "src": "",
    "usages": [
      {
        "name": "PUSH_BEAST_CHANGE",
        "feat": "beast-breed",
        "file": "feats/player/beast-breed.js"
      }
    ],
    "fields": ""
  },
  {
    "cmd": 10132,
    "dir": "S2C",
    "note": "push 整包 breedData（唤醒 + 培育每日配额唯一来源）",
    "src": "",
    "usages": [
      {
        "name": "PUSH_BREEDING_CHANGE",
        "feat": "beast-breed",
        "file": "feats/player/beast-breed.js"
      }
    ],
    "fields": ""
  },
  {
    "cmd": 10133,
    "dir": "S2C",
    "note": "push 别人家培育变更（仅作唤醒）",
    "src": "",
    "usages": [
      {
        "name": "PUSH_OTHER_BREEDING",
        "feat": "beast-breed",
        "file": "feats/player/beast-breed.js"
      }
    ],
    "fields": ""
  },
  {
    "cmd": 10182,
    "dir": "S2C",
    "note": "push 本人塔对象整份（派建即 st=2，入塔转 st=3）",
    "src": "",
    "usages": [
      {
        "name": "CMD_PUSH_TOWER",
        "feat": "auto-farm",
        "file": "feats/player/auto-farm/mech-build.js"
      }
    ],
    "fields": ""
  },
  {
    "cmd": 10264,
    "dir": "S2C",
    "note": "push 单封邮件（「遗迹区域刷新」开田信号，载荷是邮件本体）",
    "src": "",
    "usages": [
      {
        "name": "PUSH_SINGLE_MAIL",
        "feat": "auto-farm",
        "file": "feats/player/auto-farm/lvl6-scanner.js"
      }
    ],
    "fields": ""
  },
  {
    "cmd": 10452,
    "dir": "S2C",
    "note": "push 联盟记录增量（建塔/毁塔事件；1031 重拉 kick 源 + 新机械田即时并入活表）",
    "src": "",
    "usages": [
      {
        "name": "CMD_PUSH_ALLIANCE_RECORD",
        "feat": "auto-farm",
        "file": "feats/player/auto-farm/mech-build.js"
      },
      {
        "name": "PUSH_ALLIANCE_RECORD",
        "feat": "auto-farm",
        "file": "feats/player/auto-farm/tower-scanner.js"
      }
    ],
    "fields": ""
  },
  {
    "cmd": 10722,
    "dir": "S2C",
    "note": "push 制药完成（FORMULA_MAKE_COMPLETE，只当唤醒不解析载荷）",
    "src": "",
    "usages": [
      {
        "name": "PUSH_MAKE",
        "feat": "potion-craft",
        "file": "feats/player/potion-craft.js"
      }
    ],
    "fields": ""
  },
  {
    "cmd": 10802,
    "dir": "S2C",
    "note": "push 难民营坐标（用求救信开营后回推 {x,y}，落点唯一来源非 906 搜索）",
    "src": "",
    "usages": [
      {
        "name": "PUSH_FIND_REFUGEECAMP",
        "feat": "auto-hunt",
        "file": "feats/player/auto-hunt.js"
      }
    ],
    "fields": ""
  },
  {
    "cmd": 13006,
    "dir": "S2C",
    "note": "push 跨服战场医院队列入队（CSB_HOSPITAL_QUEUE_ADD）",
    "src": "",
    "usages": [
      {
        "name": "PUSH_CROSS_QUEUE_ADD",
        "feat": "quick-repair",
        "file": "feats/player/quick-repair.js"
      }
    ],
    "fields": "push {queues:[{id,st}]}（st 0=待修入队）"
  },
  {
    "cmd": 20013,
    "dir": "S2C",
    "note": "push 雷达单任务状态变化（载荷即事件对象）",
    "src": "",
    "usages": [
      {
        "name": "PUSH_STATUS_CHANGE",
        "feat": "radar-task",
        "file": "feats/player/radar-task.js"
      }
    ],
    "fields": "push 载荷即单事件对象（含 id+taskId，isTaskEvent 判据）"
  },
  {
    "cmd": 20015,
    "dir": "S2C",
    "note": "push 雷达任务池新增（{optionType,events:[]}）",
    "src": "",
    "usages": [
      {
        "name": "PUSH_ADD_ONE_TASK",
        "feat": "radar-task",
        "file": "feats/player/radar-task.js"
      }
    ],
    "fields": "push {optionType,events:[]}"
  },
  {
    "cmd": 20016,
    "dir": "S2C",
    "note": "push 雷达标量数据变化（taskPoolSurplusNum 等）",
    "src": "",
    "usages": [
      {
        "name": "PUSH_OTHER_DATA",
        "feat": "radar-task",
        "file": "feats/player/radar-task.js"
      }
    ],
    "fields": "push 标量数据（taskPoolSurplusNum 等）"
  },
  {
    "cmd": 20021,
    "dir": "S2C",
    "note": "push 雷达信号功率与干扰攻击标记（{sign,deBeginTime}；防御闸触发源之一）",
    "src": "",
    "usages": [
      {
        "name": "PUSH_SIGN",
        "feat": "radar-task",
        "file": "feats/player/radar-task.js"
      }
    ],
    "fields": "push {sign,deBeginTime}（防御闸触发源之一）"
  },
  {
    "cmd": 20025,
    "dir": "S2C",
    "note": "push 雷达环上任务状态变化（载荷即事件对象）",
    "src": "",
    "usages": [
      {
        "name": "PUSH_RING_CHANGE",
        "feat": "radar-task",
        "file": "feats/player/radar-task.js"
      }
    ],
    "fields": "push 载荷即单事件对象（环上任务，同 20013）"
  },
  {
    "cmd": 20026,
    "dir": "S2C",
    "note": "push 雷达每日链推进（{optionType,events:[]}）",
    "src": "",
    "usages": [
      {
        "name": "PUSH_DAYGROUP_CHANGE",
        "feat": "radar-task",
        "file": "feats/player/radar-task.js"
      }
    ],
    "fields": "push {optionType,events:[]}（每日链推进）"
  },
  {
    "cmd": 21203,
    "dir": "S2C",
    "note": "push 无双医院队列变化（只当唤醒，载荷不入状态）",
    "src": "",
    "usages": [
      {
        "name": "PUSH_AVA_HOSPITAL_CHANGE",
        "feat": "quick-repair",
        "file": "feats/player/quick-repair.js"
      }
    ],
    "fields": "push 只当唤醒，载荷不入状态（无双医院队列变化）"
  },
  {
    "cmd": 21211,
    "dir": "S2C",
    "note": "push TM 战场医院队列变化",
    "src": "",
    "usages": [
      {
        "name": "PUSH_TM_HOSPITAL_CHANGE",
        "feat": "quick-repair",
        "file": "feats/player/quick-repair.js"
      }
    ],
    "fields": "push 只当唤醒，载荷不入状态（TM 医院队列变化）"
  },
  {
    "cmd": 21351,
    "dir": "S2C",
    "note": "push 矿洞单矿变更全量快照（7416/7417/7419/7418/7420 后推对应单矿）",
    "src": "references/游戏逆向/次元矿洞模块分析报告.md",
    "usages": [
      {
        "name": "PUSH_MINE_CAVE_CHANGE",
        "feat": "mine-cave",
        "file": "feats/player/mine-cave/mining.js"
      }
    ],
    "fields": ""
  },
  {
    "cmd": 21465,
    "dir": "S2C",
    "note": "push Master 战场医院队列变化",
    "src": "",
    "usages": [
      {
        "name": "PUSH_MASTER_HOSPITAL_CHANGE",
        "feat": "quick-repair",
        "file": "feats/player/quick-repair.js"
      }
    ],
    "fields": "push 只当唤醒，载荷不入状态（Master 医院队列变化）"
  },
  {
    "cmd": 21551,
    "dir": "S2C",
    "note": "push 卡车拦截次数/刷新变化（结构同 6486）",
    "src": "references/游戏逆向/卡车争夺模块分析报告.md",
    "usages": [
      {
        "name": "CMD_REFRESH_PUSH",
        "feat": "truck-intercept",
        "file": "feats/player/truck-intercept.js"
      }
    ],
    "fields": ""
  },
  {
    "cmd": 21562,
    "dir": "S2C",
    "note": "push Legend 战场医院队列变化（成员名无 CAB 段但指向同族 handler）",
    "src": "",
    "usages": [
      {
        "name": "PUSH_LEGEND_HOSPITAL_CHANGE",
        "feat": "quick-repair",
        "file": "feats/player/quick-repair.js"
      }
    ],
    "fields": "push 只当唤醒，载荷不入状态（Legend 医院队列变化）"
  },
  {
    "cmd": 21923,
    "dir": "S2C",
    "note": "push 战争之源今日攻打次数更新（只 updateAttackBossCnt，不带已领列表）",
    "src": "references/游戏逆向/战争之源模块分析报告.md",
    "usages": [
      {
        "name": "PUSH_SOW_ATTACK_COUNT_UPDATE",
        "feat": "source-of-war",
        "file": "feats/player/source-of-war/reward.js"
      }
    ],
    "fields": ""
  },
  {
    "cmd": 21924,
    "dir": "S2C",
    "note": "push 战争之源每日重置/登录全量（覆写 attackCount + claimedAttackCountRewardList）",
    "src": "references/游戏逆向/战争之源模块分析报告.md",
    "usages": [
      {
        "name": "PUSH_SOW_DAY_RESET",
        "feat": "source-of-war",
        "file": "feats/player/source-of-war/reward.js"
      }
    ],
    "fields": ""
  }
];
