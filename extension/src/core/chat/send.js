/**
 * chat 内部底座 · 主协议发包面（core/chat/send.js）
 * 原 core/chat.js 的 send/sharePos/sendEmoji 区段，阶段五逐字迁出（行为零变化）。
 * 发送走主 socket（netApi.send PostChatMsg 670），不碰聊天 socket 状态；
 * 命令号/StrUid/服务器秒时刻等纯 helper 驻 context.js 共用。
 */
import { getUid } from '../player.js';
import { netApi } from '../net.js';
import { CHANNELS, resolvePostCmd, serverTimeSec, getStrUid, getServerId } from './context.js';

/**
 * 拼 custom 字段（游表 newChatController.getCustomInfo 同构：时间基准 ServerTime，fUid=StrUid）。
 * 默认值对齐实发样本；opts 可透传 atData/responseData/lang/richParas/mod 等高级字段。
 * @param {string} uid 当前玩家 UID（getUid()）
 * @param {object} [opts] {mod,modPic,officialTitle,modid,atData,responseData,lang,richParas,fUid}
 * @param {number} [chan] 生效频道号（联盟/群聊 @点名时游表另拼 mentionType/mentionUidList，缺它服务器点名解析错乱）
 * @returns {string} JSON 字符串
 */
export function defaultCustom(uid, opts, chan) {
  opts = opts || {};
  var sec = serverTimeSec();
  var fUid = opts.fUid != null ? String(opts.fUid) : getStrUid() || uid || '';
  var o = {
    mod: opts.mod != null ? opts.mod : '',
    modPic: opts.modPic != null ? opts.modPic | 0 : 0,
    officialTitle: opts.officialTitle != null ? opts.officialTitle | 0 : -1,
    clientTime: String(sec) + fUid,
    responseData: opts.responseData != null ? opts.responseData : null,
    atData: opts.atData != null ? opts.atData : null,
    modid: opts.modid != null ? opts.modid | 0 : 0,
    fUid: fUid,
    fClientTime: sec,
    lang: opts.lang || 'zh_cn',
    richParas: opts.richParas || [],
  };
  // 游表 getCustomInfo:1576-1587 同口径：联盟(2)/群聊(5)带 @点名 时必附
  // mentionType=2 + mentionUidList（逗号串）——服务器靠它识别点名对象，缺了会把回声 m 拼脏
  var at = o.atData;
  if (at && at.name && at.name.length && (chan === CHANNELS.alliance || chan === CHANNELS.group)) {
    o.mentionType = 2;
    o.mentionUidList = (at.uid || []).join(',');
  }
  return JSON.stringify(o);
}

/**
 * 发文本消息（主协议 PostChatMsg，真机探得口径；
 * 应答走主 socket（status=0；ret.data 为应答字符串原文，net 不做 JSON_PARSE——成功时是
 * '{"success":1,m:...}' JSON 串需自行 parse 判 success===1，业务拒时为 '<文案键,参数>' 裸串 parse 得 null），
 * 消息回声另经聊天 socket 推回：
 * 频道消息（世界/联盟）→ chatpush，私聊 → chatpushpm，不等价于本 Promise）。
 * @param {string} text 消息文本
 * @param {object} [opts] 选项：{channel 'world'|'pm'|'alliance'（缺省 world，显式传数字 c 可越过预设）,
 *     c 频道号, uid 私聊目标 UID（channel='pm' 时必填）, group, llm, custom 字符串（传 null 用生成值）}
 * @returns {Promise<net.Ret>} 主协议应答（ret.ok && JSON.parse(ret.data).success===1 才是发送成功）
 */
export function send(text, opts) {
  var net = netApi;
  if (!net) return Promise.reject(new Error('chat.send: pocketcc.net unavailable.'));
  if (typeof text !== 'string' || !text) return Promise.reject(new Error('chat.send: empty text.'));
  opts = opts || {};
  var channel = opts.channel || 'world';
  var c = opts.c;
  if (c == null) {
    if (typeof channel === 'number') c = channel;
    else if (CHANNELS[channel] != null) c = CHANNELS[channel];
    else
      return Promise.reject(
        new Error(
          'chat.send: unknown channel ' + channel + ' (use opts.c for non-preset channels).',
        ),
      );
  }
  if (c === CHANNELS.pm && (opts.uid == null || opts.uid === '')) {
    return Promise.reject(new Error('chat.send: pm channel requires opts.uid (target UID).'));
  }
  var uid = getUid() || '';
  var pack = {
    c: c, // 频道号：世界=0、私聊=1、联盟=2，群聊=5 等见 chatCommon.CHAT_CHANNEL_TYPE
    m: text,
    uid: opts.uid != null ? String(opts.uid) : '', // 私聊目标；频道消息为空
    llm: opts.llm != null ? opts.llm : '', // 特殊消息载荷（表情/坐标等），纯文本留空
    custom: opts.custom != null ? opts.custom : defaultCustom(uid, opts, c),
    group: opts.group != null ? opts.group : '', // 群聊(5)时填 roomId，其他频道为空串
  };
  return net.send(resolvePostCmd(), pack);
}

/**
 * 发坐标分享链接（真机 2026-09-26 实证：同 PostChatMsg，m="link"，llm={t:0, st, p:{x,y,z}, ...} JSON 串）。
 * 默认按「纯坐标」形态（t=0 + st=6）：位置渲染器 NNewShareLinkPosItem 的两个 switch 都未特化 st=6，
 *   卡片只留无条件的坐标行「S:服号 X:.. Y:..」、不画任何实体图标；跳转只读 p（+ sMap）。
 * ⚠ 收侧 parseLink（newChatInfoData）对位置卡 t=0（不在特殊类型白名单）硬要求 st/p/s/icon **四者均非空**，
 *   任一为空即 break、不当链接卡→退化成纯文本 "link"。所以 icon/s 仍需非空（st=6 下不渲染，仅用于过守卫）。
 *   若要带具体实体卡（基地/资源等），由调用方显式传 st=4 + pid + 头像 icon（或 st=0/3 + 对应 icon）。
 * @param {number} x 世界坐标 x
 * @param {number} y 世界坐标 y
 * @param {object} [opts] 选项：{channel（缺省 world）, uid 私聊目标, z 服号（缺省当前服，可显式指定）,
 *     st 目标物子类型（枚举 0=RES、3=MONSTER、4=PLAYER、6=BATTLE；缺省 6=纯坐标不渲染图标）, s 展示文案（缺省 x,y）,
 *     icon 展示图标（缺省中性占位，仅过守卫）, sk 怪名语言键, sMap 子图号（缺省 0）,
 *     pid 目标玩家 UID（仅 st=4 基地卡需要）, llm 整体覆盖载荷对象}
 * @returns {Promise<net.Ret>} 主协议应答
 */
export function sharePos(x, y, opts) {
  opts = opts || {};
  var payload =
    opts.llm && typeof opts.llm === 'object'
      ? opts.llm
      : {
          t: 0, // 链接子类型：0=位置类
          // st 目标物子类型：默认 6=BATTLE —— 位置渲染器两个 switch 都未特化它，卡片只显坐标行、不画图标（纯坐标分享）；
          //   若要带实体卡（如基地）由调用方传 st=4 + pid + 头像 icon。
          st: opts.st != null ? opts.st | 0 : 6,
          p: { x: x | 0, y: y | 0, z: opts.z != null ? opts.z | 0 : getServerId() | 0 },
          sMap: opts.sMap != null ? opts.sMap | 0 : 0, // 子图/语义位：跳转读它作 subMap
          s: opts.s != null ? String(opts.s) : (x | 0) + ',' + (y | 0), // 仅用于过 parseLink 的 s 非空守卫；st=6 下不渲染
          // icon 仅用于过 parseLink「st/p/s/icon 四者非空」守卫（t=0 不在特殊白名单）；st=6 不渲染，取值不影响显示
          icon: opts.icon != null ? String(opts.icon) : 'image/mainui/player_default',
          uts: 1,
        };
  if (opts.sk != null && payload.sk == null) payload.sk = opts.sk;
  if (opts.pid != null && payload.pid == null) payload.pid = String(opts.pid);
  var rest = {};
  for (var k in opts)
    if (
      k !== 'llm' &&
      k !== 'st' &&
      k !== 's' &&
      k !== 'z' &&
      k !== 'icon' &&
      k !== 'sk' &&
      k !== 'sMap' &&
      k !== 'pid'
    )
      rest[k] = opts[k];
  return send('link', Object.assign({ llm: JSON.stringify(payload) }, rest));
}

/**
 * 发表情（源码 newChatController.sendChatEmotionInfo 口径：m="link"+emotionId，
 * llm 传空串，custom 整体被替为 {emotionId,t}（不再用默认 custom）。
 * 注：收侧回声会把表情信息回填到 llm、custom 置 null（服端行为），与本函数的出站形制不同。
 * @param {number|string} emotionId 表情 id
 * @param {object} [opts] 选项：{channel（缺省 world）, uid 私聊目标, t 表情子类型（缺省 2）}
 * @returns {Promise<net.Ret>} 主协议应答
 */
export function sendEmoji(emotionId, opts) {
  opts = opts || {};
  var id = +emotionId;
  if (!id) return Promise.reject(new Error('chat.sendEmoji: emotionId required.'));
  var custom = JSON.stringify({ emotionId: id, t: opts.t != null ? opts.t | 0 : 2 });
  var rest = {};
  for (var k in opts) if (k !== 't') rest[k] = opts[k];
  return send('link' + id, Object.assign({ llm: '', custom: custom }, rest));
}
