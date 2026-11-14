// 协议注册表 · alliance 域 —— 机械抽取 + 人工标注（dir/note/src/fields 重跑保留，usages 重跑重建）。
// 生成：node scripts/protocol/extract.mjs；闸门：tests/protocol-registry.test.js（npm test）。
// 条目键 = 协议号；名字是 feat 局部别名（同名异号是局部命名，非漂移）。只链不搬：src 指 references/ 出处。
export default [
  {
    "cmd": 1067,
    "dir": "C2S",
    "note": "捐赠遗迹/要塞（WORLDSITE_DONATE，{id,type}，无批量字段）",
    "src": "",
    "usages": [
      {
        "name": "CMD_DONATE_RELIC",
        "feat": "alliance-science",
        "file": "feats/alliance/alliance-science.js"
      }
    ],
    "fields": ""
  },
  {
    "cmd": 1139,
    "dir": "C2S",
    "note": "发起联盟帮助申请（{type:4,itemId,helpNum}）",
    "src": "",
    "usages": [
      {
        "name": "CMD_ALLIANCE_HELP_APPLY",
        "feat": "alliance-help",
        "file": "feats/alliance/alliance-help.js"
      }
    ],
    "fields": ""
  },
  {
    "cmd": 1141,
    "dir": "C2S",
    "note": "领取联盟帮助奖励（{type:在途申请.Type,qid:\"0\"}）",
    "src": "",
    "usages": [
      {
        "name": "CMD_ALLIANCE_HELP_RECEIVE",
        "feat": "alliance-help",
        "file": "feats/alliance/alliance-help.js"
      }
    ],
    "fields": ""
  },
  {
    "cmd": 1144,
    "dir": "C2S",
    "note": "捐赠联盟科技（源码拼写即 ALLIANCE_DOANTE_SCIENCE）",
    "src": "references/历史文档/联盟科技.md",
    "usages": [
      {
        "name": "CMD_DONATE",
        "feat": "alliance-science",
        "file": "feats/alliance/alliance-science.js"
      }
    ],
    "fields": ""
  },
  {
    "cmd": 1160,
    "dir": "C2S",
    "note": "主动查联盟机甲全量信息（ALLIANCE_BOSS_GET_INFO）",
    "src": "references/历史文档/联盟机甲.md",
    "usages": [
      {
        "name": "CMD_GET_INFO",
        "feat": "alliance-boss",
        "file": "feats/alliance/alliance-boss.js"
      }
    ],
    "fields": ""
  },
  {
    "cmd": 1161,
    "dir": "C2S",
    "note": "捐献机甲碎片（count:0 为每日免费一枚）",
    "src": "references/历史文档/联盟机甲.md",
    "usages": [
      {
        "name": "CMD_DONATE",
        "feat": "alliance-boss",
        "file": "feats/alliance/alliance-boss.js"
      }
    ],
    "fields": ""
  },
  {
    "cmd": 1177,
    "dir": "C2S",
    "note": "一键领取某类联盟礼物（{type}）",
    "src": "references/历史文档/联盟礼物.md",
    "usages": [
      {
        "name": "CMD_RECEIVE_GIFT_ALL",
        "feat": "alliance-gift",
        "file": "feats/alliance/alliance-gift.js"
      }
    ],
    "fields": ""
  },
  {
    "cmd": 1178,
    "dir": "C2S",
    "note": "领 1 箱联盟珍藏礼物（{}）",
    "src": "",
    "usages": [
      {
        "name": "CMD_RECEIVE_GIFT_BIG",
        "feat": "alliance-gift",
        "file": "feats/alliance/alliance-gift.js"
      }
    ],
    "fields": ""
  },
  {
    "cmd": 1195,
    "dir": "C2S",
    "note": "一键帮助全部盟友（{type:4}）",
    "src": "",
    "usages": [
      {
        "name": "CMD_HELP_ALL_ALLIANCE_MEMBERS",
        "feat": "alliance-help",
        "file": "feats/alliance/alliance-help.js"
      }
    ],
    "fields": ""
  },
  {
    "cmd": 1204,
    "dir": "C2S",
    "note": "加入集结（ALLIANCE_Assembly_Join）",
    "src": "references/历史文档/联盟集结.md",
    "usages": [
      {
        "name": "CMD_ASSEMBLY_JOIN",
        "feat": "alliance-rally",
        "file": "feats/alliance/alliance-rally.js"
      }
    ],
    "fields": ""
  },
  {
    "cmd": 1825,
    "dir": "C2S",
    "note": "查询遗迹本轮候选/已领（GET_FORTRESS_CHOOSE_ITEM_REWARD_DATA，{wonderId}）",
    "src": "",
    "usages": [
      {
        "name": "CMD_QUERY",
        "feat": "relic-reward",
        "file": "feats/alliance/relic-reward.js"
      }
    ],
    "fields": ""
  },
  {
    "cmd": 1826,
    "dir": "C2S",
    "note": "领取一枚遗迹选定候选（FORTRESS_CHOOSE_ITEM_REWARD，{wonderId,index}）",
    "src": "",
    "usages": [
      {
        "name": "CMD_CLAIM",
        "feat": "relic-reward",
        "file": "feats/alliance/relic-reward.js"
      }
    ],
    "fields": ""
  },
  {
    "cmd": 7102,
    "dir": "C2S",
    "note": "联盟巨兽等级捐献（ALLIANCE_BEHEMOTH_DONATE，type LEVEL）",
    "src": "",
    "usages": [
      {
        "name": "CMD_DONATE",
        "feat": "alliance-behemoth",
        "file": "feats/alliance/alliance-behemoth.js"
      }
    ],
    "fields": ""
  },
  {
    "cmd": 10435,
    "dir": "S2C",
    "note": "push 联盟机甲状态（游戏自己已刷新本地数据）",
    "src": "references/历史文档/联盟机甲.md",
    "usages": [
      {
        "name": "CMD_PUSH_ALLIANCE_BOSS",
        "feat": "alliance-boss",
        "file": "feats/alliance/alliance-boss.js"
      }
    ],
    "fields": ""
  },
  {
    "cmd": 10442,
    "dir": "S2C",
    "note": "push 联盟礼物信息更新（仅作唤醒源，不读载荷）",
    "src": "",
    "usages": [
      {
        "name": "CMD_PUSH_ALLIANCE_GIFT_INFO",
        "feat": "alliance-gift",
        "file": "feats/alliance/alliance-gift.js"
      }
    ],
    "fields": ""
  },
  {
    "cmd": 10446,
    "dir": "S2C",
    "note": "push 自助帮助列表（自己的帮助被盟友帮助后，游戏 UpdateSelfHelpList）",
    "src": "",
    "usages": [
      {
        "name": "PUSH_ALLIANCE_SELF_HELP",
        "feat": "alliance-help",
        "file": "feats/alliance/alliance-help.js"
      }
    ],
    "fields": ""
  },
  {
    "cmd": 10453,
    "dir": "S2C",
    "note": "push 联盟帮助数据整表重取（UpdateAllianceHelpData 重建列表/计数）",
    "src": "",
    "usages": [
      {
        "name": "PUSH_ALLIANCE_HELP_REGET",
        "feat": "alliance-help",
        "file": "feats/alliance/alliance-help.js"
      }
    ],
    "fields": ""
  },
  {
    "cmd": 12003,
    "dir": "S2C",
    "note": "push 联盟集结创建（快照池 offer 的触发源）",
    "src": "references/历史文档/联盟集结.md",
    "usages": [
      {
        "name": "CMD_PUSH_ASSEMBLY_CREATED",
        "feat": "alliance-rally",
        "file": "feats/alliance/alliance-rally.js"
      }
    ],
    "fields": ""
  }
];
