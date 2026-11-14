// 协议注册表 · system 域 —— 机械抽取 + 人工标注（dir/note/src 重跑保留，usages 重跑重建）。
// 生成：node scripts/protocol/extract.mjs；闸门：tests/protocol-registry.test.js（npm test）。
// 条目键 = 协议号；名字是 feat 局部别名（同名异号是局部命名，非漂移）。只链不搬：src 指 references/ 出处。
export default [
  {
    cmd: 254,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_RECALL_CHAT',
        feat: 'chat',
        file: 'feats/system/chat/context.js',
      },
    ],
  },
  {
    cmd: 501,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_ADD_FRIEND',
        feat: 'chat',
        file: 'feats/system/chat/context.js',
      },
    ],
  },
  {
    cmd: 929,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_MAIL_QUERY',
        feat: 'chat',
        file: 'feats/system/chat/context.js',
      },
    ],
  },
  {
    cmd: 1132,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_ALLIANCE_MEMBERS',
        feat: 'chat',
        file: 'feats/system/chat/context.js',
      },
    ],
  },
  {
    cmd: 10919,
    dir: null,
    note: '',
    src: '',
    usages: [
      {
        name: 'CMD_CHAT_INFO_LIST',
        feat: 'chat',
        file: 'feats/system/chat/context.js',
      },
    ],
  },
];
