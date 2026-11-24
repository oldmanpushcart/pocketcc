// 协议注册表 · system 域 —— 机械抽取 + 人工标注（dir/note/src/fields 重跑保留，usages 重跑重建）。
// 生成：node scripts/protocol/extract.mjs；闸门：tests/protocol-registry.test.js（npm test）。
// 条目键 = 协议号；名字是 feat 局部别名（同名异号是局部命名，非漂移）。src 为人工标注的出处说明，渐进补充。
export default [
  {
    cmd: 254,
    dir: 'C2S',
    note: '撤回自己消息（sendPBV2 {roomId,uuid,channel,toUid}，时限配置 630061 默认 60s）',
    src: '',
    fields: '',
    usages: [
      {
        name: 'CMD_RECALL_CHAT',
        feat: 'chat',
        file: 'feats/system/chat/constants.js',
      },
    ],
  },
  {
    cmd: 501,
    dir: 'C2S',
    note: '发起好友申请（{uid} 尽力口径，真机待验）',
    src: '',
    fields: '',
    usages: [
      {
        name: 'CMD_ADD_FRIEND',
        feat: 'chat',
        file: 'feats/system/chat/constants.js',
      },
    ],
  },
  {
    cmd: 929,
    dir: 'C2S',
    note: '查战报邮件详情（{uid,mailId} 只读，应答 .d 串再 parse 取 .mail）',
    src: '',
    fields: '',
    usages: [
      {
        name: 'CMD_MAIL_QUERY',
        feat: 'chat',
        file: 'feats/system/chat/constants.js',
      },
    ],
  },
  {
    cmd: 1132,
    dir: 'C2S',
    note: '联盟成员列表只读查询（应答 schema 未实证，尽力解析+日志定稿）',
    src: '',
    fields: '',
    usages: [
      {
        name: 'CMD_ALLIANCE_MEMBERS',
        feat: 'chat',
        file: 'feats/system/chat/constants.js',
      },
    ],
  },
  {
    cmd: 10919,
    dir: 'S2C',
    note: 'push 系统战报类聊天消息（被攻击/主动攻击等；infos[] 与聊天气泡同形）',
    src: '',
    fields: '',
    usages: [
      {
        name: 'CMD_CHAT_INFO_LIST',
        feat: 'chat',
        file: 'feats/system/chat/constants.js',
      },
    ],
  },
];
