/**
 * chat 内部底座 · 推送 schema 归一（core/chat/normalize.js）
 * 原 core/chat.js 的 parseLink/normalize/toSysItem 区段，阶段五逐字迁出（行为零变化）。
 * 纯函数面：只依赖 getUid 与 CHANNELS 常量，不触碰 socket/hook 共享状态。
 */
import { getUid } from '../player.js';
import { CHANNELS } from './context.js';

/**
 * 单条系统消息 infos 项 → 归一对象（游戏 createOneSysMsg 同构：uid/fu 置 "-1"，params 摊平进顶层）。
 * @param {object} e pbAckV2.data.infos 单项
 * @returns {object}
 */
export function toSysItem(e) {
  e = e || {};
  var t = {
    c: (e.channel != null ? e.channel : '') + '',
    m: e.content,
    roomId: e.roomId,
    t: e.time,
    uuid: e.uuid,
    uid: '-1',
    fu: '-1',
    isGameMsg: true,
  };
  var ps = e.params;
  if (ps && typeof ps === 'object') for (var k in ps) t[k] = ps[k];
  return t;
}

/**
 * 解析链接类消息（m 以 "link" 开头）。把 llm JSON 串解成对象并标注子类型。
 * @param {string} m 原始 m 字段
 * @param {string|object|null} llm 原始 llm 字段
 * @returns {object} {isLink, llm:object|null, linkType, emotionId}；linkType：0=位置/1=战报/2=表情/3=砍价（同 llm.t）
 */
export function parseLink(m, llm) {
  var out = { isLink: false, llm: null, linkType: null, emotionId: null };
  if (typeof m !== 'string' || m.indexOf('link') !== 0) return out;
  out.isLink = true;
  var payload = null;
  if (llm != null && llm !== '') {
    try {
      payload = typeof llm === 'string' ? JSON.parse(llm) : llm;
    } catch (e) {
      payload = null;
    }
  }
  out.llm = payload;
  if (payload && payload.t != null) {
    out.linkType = payload.t;
    if (payload.t === 2 || payload.t === 3)
      out.emotionId = payload.emotionId != null ? payload.emotionId : +m.slice(4) || null;
  } else {
    var tail = +m.slice(4);
    if (tail) {
      out.linkType = 2;
      out.emotionId = tail;
    } // 无 llm 时回退：link<id> 当表情
  }
  return out;
}

/**
 * 把聊天推送归一为可直接渲染的对象（频道 chatpush 与私聊 chatpushpm 两个 schema 字段不同构，
 * 本函数抹平差异；kind 缺省据 fu/tu 是否在场所属频道自动判别）。
 * @param {object} msg socket 推来的原始对象（chatpush 单项 / chatpushpm 单项）
 * @param {string} [kind] 'push'（频道）| 'pm'（私聊）；缺省自动
 * @returns {object|null} {kind, channel, seq, time, isSelf, from:{uid,name,face,server,lang,fUid}, to:{uid,name}|null,
 *     text, isLink, linkType, llm, emotionId, raw}；msg 非对象时返回 null
 */
export function normalize(msg, kind) {
  if (!msg || typeof msg !== 'object') return null;
  if (!kind) kind = msg.fu != null || msg.tu != null ? 'pm' : 'push';
  var myUid = String(getUid() || '');
  var out = {
    kind: kind,
    id: msg.id != null ? msg.id : null,
    channel: msg.c != null ? msg.c : kind === 'pm' ? CHANNELS.pm : null,
    seq: msg.seq != null ? msg.seq : null,
    time: msg.t != null ? +msg.t : null,
    text: msg.m != null ? msg.m : '',
    from: null,
    to: null,
    isSelf: null,
    isLink: false,
    linkType: null,
    llm: null,
    emotionId: null,
    raw: msg,
  };
  // f/fu/tu 存在 JSON 字符串形态（真机历史项与部分推送同构于 chat-window buildEntry 的 safeParse 兜底）：
  // 不解析则 from.uid 取空，下游按 UID 的白名单/回声判定会静默失效
  var asObj = function (v) {
    if (v == null) return {};
    if (typeof v === 'object') return v;
    try {
      return JSON.parse(v) || {};
    } catch (e) {
      return {};
    }
  };
  if (kind === 'pm') {
    var fu = asObj(msg.fu),
      tu = asObj(msg.tu);
    out.from = {
      uid: fu.uid != null ? String(fu.uid) : msg.uid != null ? String(msg.uid) : '',
      name: fu.n || '',
      face: fu.f != null ? fu.f : null,
      server: fu.s != null ? fu.s : null,
      lang: fu.lang,
      fUid: fu.fUid,
    };
    out.to = {
      uid:
        tu.uid != null
          ? String(tu.uid)
          : typeof msg.tu === 'string' || typeof msg.tu === 'number'
            ? String(msg.tu)
            : '',
      name: tu.n || '',
      face: tu.f != null ? tu.f : null,
    };
  } else {
    // 联盟/群聊等频道的 chatpush 实推项里没有 f 对象（实证报文）：发件人在顶层
    // uid/fu（字符串 UID），昵称在 fp（JSON 串的 username），需逐级兜底才能拿到 from.uid
    var f = asObj(msg.f);
    var fp = asObj(msg.fp);
    var uidV =
      f.uid != null
        ? String(f.uid)
        : msg.uid != null
          ? String(msg.uid)
          : typeof msg.fu === 'string' || typeof msg.fu === 'number'
            ? String(msg.fu)
            : '';
    out.from = {
      uid: uidV,
      name: msg.u || f.n || fp.username || fp.nickname || '',
      face: f.f != null ? f.f : null,
      server: f.s != null ? f.s : null,
      lang: f.lang != null ? f.lang : fp.lang,
      fUid:
        f.fUid != null
          ? f.fUid
          : msg.fu != null && uidV === String(msg.fu)
            ? String(msg.fu)
            : undefined,
    };
  }
  out.isSelf = !!myUid && out.from.uid === myUid;
  var link = parseLink(out.text, msg.llm);
  if (link.isLink) {
    out.isLink = true;
    out.linkType = link.linkType;
    out.llm = link.llm;
    out.emotionId = link.emotionId;
  }
  return out;
}
