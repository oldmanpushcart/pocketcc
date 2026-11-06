/**
 * 聊天窗口 · 纯函数层（零可变状态、零副作用，可独立单测）。
 * 本文件不引用 context 可变状态 S——需要 cfg 的值一律通过参数注入（如 hhmm/buildEntry 的 showDate）。
 * 允许读取的外部只读输入：core 原语（game-api/chat/player/util）、classify、context 常量（AT_ALL_TOKEN/AT_ALL_LABEL/RS/CHAN_DEFS/KEY_BY_C）。
 */
import { safeParse } from '../../../core/util.js';
import { l10n, gameData } from '../../../core/game-api.js';
import { getUid } from '../../../core/player.js';
import { chatApi } from '../../../core/chat.js';
import { AT_ALL_TOKEN, AT_ALL_LABEL, RS, CHAN_DEFS, KEY_BY_C } from './context.js';
import { classify, CST_LABEL } from './classify.js';

// ─────────── 文案 / 配置表查表 ───────────

/**
 * 服务器文案键 → 游戏当前语言文本
 * @param {*} s
 * @returns {string}
 */
export function locText(s) {
  return l10n.net(s);
}

/**
 * 语言键+参数 → 游戏当前语言文本
 * @param {string} key
 * @param {...*} paras
 * @returns {string}
 */
export function locGetText(...paras) {
  return l10n.text.apply(null, paras);
}

/**
 * 配置表行查询
 * @param {string} semantic
 * @param {*} id
 * @returns {object|null}
 */
export function tableRow(semantic, id) {
  return l10n.tableRow(semantic, id);
}

/** 空判（对齐游戏 r.Obj.isEmpty） */
export function isEm(v) {
  return v == null || v === '';
}

// ─────────── 频道工具 ───────────

/** 动态房频道判定 */
export function isDynamicRoomChan(c) {
  return c !== 0 && c !== 1 && c !== 2 && c !== 5;
}

/** 频道号 → 会话键前缀 */
export function chanKeyOf(c) {
  return KEY_BY_C[c] || 'c' + c;
}

/** 会话键 → 频道号 */
export function chanOfKey(key) {
  var p = key.slice(0, key.indexOf(':'));
  var d = CHAN_DEFS.find((x) => x.key === p);
  if (d) return d.c;
  if (p.charAt(0) === 'c' && /^\d+$/.test(p.slice(1))) return +p.slice(1);
  return null;
}

/** 侧栏兜底名 */
export function chanLabelOfKey(key) {
  var p = key.slice(0, key.indexOf(':'));
  var d = CHAN_DEFS.find((x) => x.key === p);
  if (d) return d.label;
  var n = p.charAt(0) === 'c' ? p.slice(1) : p;
  var t = l10n.channelName(+n);
  if (t) return t;
  return '频道' + n;
}

/** 会话家族归属 */
export function familyOf(key) {
  if (key === 'pm' || key.indexOf('pm:') === 0) return 'pm';
  if (key === 'cross') return 'cross';
  if (key.indexOf(':') > 0) {
    var c = chanOfKey(key);
    if (c != null && isDynamicRoomChan(c)) return 'cross';
  }
  return null;
}

// ─────────── UID / 时间 ───────────

/** @returns {string} 本人数字 UID */
export function myUid() {
  return String(getUid() || '');
}

/** @returns {string} 本人 StrUid */
export function myStrUid() {
  return gameData.strUid() || myUid();
}

/**
 * 时间归一（秒/毫秒统一成毫秒）
 * @param {number|null} t
 * @param {number|null} ms
 * @returns {number}
 */
export function toMs(t, ms) {
  var v = ms != null ? +ms : t != null ? +t : Date.now();
  if (v < 1e11) v *= 1000;
  return v;
}

/**
 * 时间展示串（showDate 必传，由调用方注入 S.cfg.showDate；本函数不读 cfg，也不设默认值——
 * 与 buildEntry 同一纪律：漏传必须显形为无日期格式，而非静默回退成带日期）
 * @param {number} ms
 * @param {boolean} showDate
 * @returns {string}
 */
export function hhmm(ms, showDate) {
  var d = new Date(ms);
  var p = (n) => (n < 10 ? '0' : '') + n;
  var hms = p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  return showDate
    ? d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + hms
    : hms;
}

// ─────────── 富文本剥离 / 片段处理 ───────────

/**
 * 剥离 Cocos 富文本标签，仅保留可见文本
 * @param {string} s
 * @returns {string}
 */
export function stripRich(s) {
  return String(s == null ? '' : s)
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(
      /<\/?(?:color|c|b|i|u|font|outline|shadow|link|on|img|image|sprite|quad)\b[^>]*>/gi,
      '',
    )
    .replace(/<\/?[a-z][^>]*>/gi, '')
    .replace(/[\u001e\u001f]/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/**
 * 对渲染片段逐个剔富文本
 * @param {object[]} segs
 * @returns {object[]}
 */
export function sanitizeSegments(segs) {
  for (var i = 0; i < segs.length; i++) {
    var sg = segs[i];
    if (sg && typeof sg.s === 'string' && /[<>\u001e\u001f]/.test(sg.s)) {
      var c = Object.assign({}, sg);
      c.s = stripRich(sg.s);
      segs[i] = c;
    }
  }
  return segs;
}

/** @type {RegExp} 坐标链接化匹配 */
const COORD_LINK_RE = /[（(]\s*(\d{1,4})\s*[,，]\s*(\d{1,4})\s*[)）]/g;

/**
 * 把文本片段里 (x,y) 坐标替换成可点击跳转链接
 * @param {object[]} segs
 * @returns {object[]}
 */
export function linkifyCoords(segs) {
  var out = null;
  for (var i = 0; i < segs.length; i++) {
    var sg = segs[i];
    var isText =
      sg &&
      sg.type === 'text' &&
      typeof sg.s === 'string' &&
      (sg.s.indexOf('(') >= 0 || sg.s.indexOf('（') >= 0);
    if (!isText) {
      if (out) out.push(sg);
      continue;
    }
    var re = new RegExp(COORD_LINK_RE.source, 'g');
    var last = 0;
    var m;
    var hit = false;
    while ((m = re.exec(sg.s)) !== null) {
      var x = +m[1];
      var y = +m[2];
      if (x === 0 && y === 0) continue;
      if (!out) out = segs.slice(0, i);
      hit = true;
      if (m.index > last) out.push({ type: 'text', s: sg.s.slice(last, m.index) });
      out.push({
        type: 'chip',
        s: m[0],
        action: { type: 'pos', x: x, y: y, z: null, subMap: null, click: false },
        jumpHint: x + ',' + y,
      });
      last = re.lastIndex;
    }
    if (hit) {
      if (last < sg.s.length) out.push({ type: 'text', s: sg.s.slice(last) });
    } else if (out) out.push(sg);
  }
  return out || segs;
}

/**
 * 从 chat proxy 应答提取消息数组
 * @param {object} ret
 * @returns {object[]}
 */
export function historyList(ret) {
  var d = ret && ret.data;
  if (!d || typeof d !== 'object') return [];
  var l = d.list != null ? d.list : d.data && typeof d.data === 'object' ? d.data.list : null;
  return Array.isArray(l) ? l : [];
}

// ─────────── 系统消息 / 表情 / 表态 解码 ───────────

/**
 * P3 系统消息模板 → 译文 segments
 * @param {{key:string,args:string[],argsAreKeys:boolean}|null} sys
 * @param {object|null} atData
 * @returns {object[]}
 */
export function decodeSystemText(sys, atData) {
  if (!sys || isEm(sys.key)) return [];
  var args = sys.args || [];
  if (sys.argsAreKeys)
    args = args.map(function (a) {
      return locGetText(a);
    });
  return decodeAtCodes(locGetText.apply(null, [sys.key].concat(args)), atData);
}

/**
 * P4 表情/动图卡标题
 * @param {object} cls
 * @param {object} norm
 * @returns {string}
 */
export function emojiLabel(cls, norm) {
  var llm = cls.llm || {};
  if (cls.t === 60) {
    var g = isEm(llm.emotionGIFId) ? null : tableRow('emojiGif', llm.emotionGIFId);
    return g ? '[' + locGetText(g.name) + ']' : cls.label;
  }
  if (!isEm(llm.customEmotionId)) return locGetText('emoji_upload_tips_07');
  if (!isEm(llm.emotionId) || !isEm(llm.iconID)) {
    var r1 = tableRow('emotionNew', !isEm(llm.emotionId) ? llm.emotionId : llm.iconID);
    if (r1) return '[' + locGetText(r1.name) + ']';
  }
  var icons = !isEm(llm.iconIDs)
    ? llm.iconIDs
    : !isEm(llm.iconID)
      ? llm.iconID
      : norm && !isEm(norm.emotionId)
        ? norm.emotionId
        : null;
  if (icons == null) return cls.label;
  var s = '';
  String(icons)
    .split('|')
    .forEach(function (h) {
      var r2 = tableRow('emotion', h);
      s += r2 ? '[' + locGetText(r2.name) + ']' : '[表情]';
    });
  return s || cls.label;
}

/** @type {Object<string,string>} reactionType→中文标签 */
const REACT_LABEL = { like: '点赞' };

/**
 * P4 消息表态 → 尾部 chip
 * @param {Array|undefined} list
 * @returns {object[]}
 */
export function reactionsSegments(list) {
  if (!Array.isArray(list)) return [];
  var parts = [];
  for (var r of list) {
    var n = (r && +r.count) || 0;
    if (n <= 0) continue;
    parts.push(
      '[' +
        (REACT_LABEL[r.reactionType] || String(r.reactionType || '?')) +
        ' ×' +
        (n > 99 ? '99+' : n) +
        ']',
    );
  }
  return parts.length ? [{ type: 'chip', s: parts.join(' ') }] : [];
}

/**
 * P4 富文本标签 → 展示文本
 * @param {number} ty
 * @param {string} id
 * @returns {string|null}
 */
export function richTagText(ty, id) {
  var row =
    ty === 0
      ? tableRow('emotionNew', id)
      : ty === 1
        ? tableRow('item', id)
        : ty === 2
          ? tableRow('building', id)
          : null;
  if (!row) return null;
  var nm = locGetText(row.name);
  return ty === 0 ? '[' + nm + ']' : ty === 1 ? '#' + nm + '#' : '{' + nm + '}';
}

/**
 * P4 内联富文本片段解析
 * @param {string} text
 * @param {string[]|undefined} richParas
 * @param {object|null} atData
 * @returns {object[]}
 */
export function richSplit(text, richParas, atData) {
  if (!/\uf8f8|\[\d+:\d+\]/.test(text)) return decodeAtCodes(text, atData);
  var out = [];
  var qi = 0;
  var last = 0;
  var m;
  var re = /\uf8f8|\[(\d+):(\d+)\]/g;
  var pushText = function (s) {
    if (s) out = out.concat(decodeAtCodes(s, atData));
  };
  while ((m = re.exec(text)) !== null) {
    pushText(text.slice(last, m.index));
    var ty, id;
    if (m[0] === '\uf8f8') {
      var pr = String((richParas && richParas[qi++]) || '').split(',');
      if (pr.length !== 2 || isEm(pr[1])) {
        last = re.lastIndex;
        continue;
      }
      ty = +pr[0];
      id = pr[1];
    } else {
      ty = +m[1];
      id = m[2];
    }
    var txt = richTagText(ty, id);
    pushText(txt != null ? txt : m[0] === '\uf8f8' ? '' : '[' + ty + ':' + id + ']');
    last = re.lastIndex;
  }
  pushText(text.slice(last));
  return out;
}

// ─────────── @ 解码 ───────────

/**
 * 还原 @ 编码：RS序号RS → atData.name 对应昵称
 * @param {string} text
 * @param {object|null} atData
 * @returns {object[]}
 */
export function decodeAtCodes(text, atData) {
  var names =
    atData && Array.isArray(atData.name) && atData.name.length
      ? atData.name
          .map(function (nm) {
            return (
              '@' +
              String(nm)
                .split(AT_ALL_TOKEN)
                .join('@' + AT_ALL_LABEL)
            );
          })
          .filter(function (t) {
            return t.length > 1;
          })
      : [];
  var segs = [];
  var pushPlain = function (s) {
    if (s) segs = segs.concat(splitLiteralAt(s, names));
  };
  var re = new RegExp(RS + '(\\d+)' + RS, 'g');
  var last = 0;
  var m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) pushPlain(text.slice(last, m.index));
    var nm = atData && atData.name ? atData.name[+m[1]] : null;
    segs.push({
      type: 'at',
      s: '@' + (nm != null ? String(nm).replace(AT_ALL_TOKEN, AT_ALL_LABEL) : '?'),
    });
    last = re.lastIndex;
  }
  if (last < text.length) pushPlain(text.slice(last));
  return segs.length ? segs : [{ type: 'text', s: text }];
}

/**
 * 按昵称名单把字面 "@昵称" 切成 at 高亮段
 * @param {string} s
 * @param {string[]} names
 * @returns {object[]}
 */
export function splitLiteralAt(s, names) {
  if (!names.length || s.indexOf('@') < 0) return [{ type: 'text', s: s }];
  var sorted = names.slice().sort(function (a, b) {
    return b.length - a.length;
  });
  var out = [];
  var buf = '';
  var i = 0;
  while (i < s.length) {
    if (s[i] === '@') {
      var hit = null;
      for (var k = 0; k < sorted.length; k++) {
        if (s.startsWith(sorted[k], i)) {
          hit = sorted[k];
          break;
        }
      }
      if (hit) {
        if (buf) {
          out.push({ type: 'text', s: buf });
          buf = '';
        }
        out.push({ type: 'at', s: hit });
        i += hit.length;
        continue;
      }
    }
    buf += s[i];
    i++;
  }
  if (buf) out.push({ type: 'text', s: buf });
  return out.length ? out : [{ type: 'text', s: s }];
}

// ─────────── 缓冲插入（有序） ───────────

/**
 * 从条目里按候选键序取字段值；值为对象时拆 Int64 {low,high}/{uid} 包裹形态（成员表 uid 字段结构未实证）。
 * @param {object} it 条目
 * @param {string[]} keys 候选字段名
 * @returns {string} 取不到的值返回空串
 */
export function pickField(it, keys) {
  for (var k of keys) {
    var v = it[k];
    if (v == null || v === '') continue;
    if (typeof v === 'object') v = v.uid != null ? v.uid : v.low;
    if (v != null && v !== '') return String(v);
  }
  return '';
}

/**
 * 按 timeMs 升序插入缓冲（二分定位）
 * @param {object} b 缓冲对象
 * @param {object} entry
 * @returns {boolean} true=追尾
 */
export function insertOrdered(b, entry) {
  var list = b.list;
  if (!list.length || entry.timeMs >= list[list.length - 1].timeMs) {
    list.push(entry);
    b.ids.add(entry.id);
    return true;
  }
  var lo = 0;
  var hi = list.length;
  while (lo < hi) {
    var mid = (lo + hi) >> 1;
    if (list[mid].timeMs <= entry.timeMs) lo = mid + 1;
    else hi = mid;
  }
  list.splice(lo, 0, entry);
  b.ids.add(entry.id);
  return false;
}

// ─────────── 条目构建（原始消息 → 可渲染 entry） ───────────

/**
 * 把一条原始消息（推送项或历史项）预处理成 overlay 可渲染 entry。
 * schema 差异（fu 字符串/对象、u/n/fp 名字位置）在这里全部抹平。
 * showDate 由调用方从 cfg 注入（本函数不读可变状态）。
 * @param {object} raw socket/历史原始项
 * @param {string} kind 'push'|'pm'
 * @param {boolean} showDate 时间展示是否带日期（来自 cfg.showDate）
 * @returns {{entry:object, key:string, self:boolean, otherUid:string}} entry + 归属缓冲键 + 是否本人
 */
export function buildEntry(raw, kind, showDate) {
  var chat = chatApi;
  var norm = chat.normalize(raw, kind);
  var custom = safeParse(raw.custom) || {};
  var atData = custom.atData || null;
  var responseData = custom.responseData || null;
  var fp = safeParse(raw.fp) || {};
  var f = safeParse(raw.f) || {};
  var uid = String(
    (norm.from && norm.from.uid) ||
      raw.uid ||
      (typeof raw.fu === 'object' ? raw.fu.uid : raw.fu) ||
      '',
  );
  var name = (norm.from && norm.from.name) || raw.u || raw.n || fp.username || f.n || '';
  if (!name) name = uid ? '玩家' + uid.slice(-4) : '?';
  if (uid === '-1') name = ''; // 系统消息（fu/uid=="-1"）无发送者昵称，正文模板即全部
  var self = !!uid && (uid === myUid() || uid === myStrUid());

  // 正文：历史项可能只有 content 无 m（游戏侧预处理口径），这里同源兼容；@编码还原 + 链接转 chip
  var text = String(
    norm.text != null && norm.text !== '' ? norm.text : raw.content != null ? raw.content : '',
  )
    .split(AT_ALL_TOKEN)
    .join('@' + AT_ALL_LABEL);
  var cls = classify(raw, norm, { translate: locGetText });
  var segments;
  if (cls.kind === 'system' || cls.kind === 'custom_system') {
    // P3：正文是语言键模板（\x1e/\x1f/|/; 规则，UpdateData:714-730），走游戏 getText 同键翻译；
    // 富卡片系统消息（cst∈ChatCustomSystemType）前置卡型 chip
    segments = decodeSystemText(cls.sys, atData);
    if (cls.kind === 'custom_system' && CST_LABEL[cls.cst])
      segments = [{ type: 'chip', s: '[' + CST_LABEL[cls.cst] + ']' }].concat(segments);
  } else if (cls.kind === 'ct') {
    // ct 内容（红包/图片/寻人）：游戏展示文本为 getText(m)（UpdateData:732），chip 标类型 + 正文译文
    segments = [{ type: 'chip', s: cls.label }].concat(
      text ? decodeAtCodes(locGetText(text), atData) : [],
    );
  } else if (cls.kind !== 'chat') {
    segments = linkSegments(cls, norm);
  } else if (kind === 'pm' && /^(\d+)\s*,\s*(\d+)$/.test(text)) {
    var mm = /^(\d+)\s*,\s*(\d+)$/.exec(text);
    segments = [
      {
        type: 'chip',
        s: '[位置 ' + mm[1] + ',' + mm[2] + ']',
        action: { type: 'pos', x: +mm[1], y: +mm[2], z: null, click: false },
        jumpHint: mm[1] + ',' + mm[2],
      },
    ];
  } else {
    segments = richSplit(text, custom.richParas, atData); // P4：内联表情/道具/建筑富文本 + @还原
  }
  // P4：消息表态（reactions=[{reactionType,count}]，>99 显示 99+，chatupdate 原位合并后自动重算）
  segments = segments.concat(reactionsSegments(raw.reactions));
  segments = sanitizeSegments(segments); // 剔服务器富文本标签（<color=…></c> 等）与控制符，防漏进纯文本浮层
  segments = linkifyCoords(segments); // 输出文本里的 (x,y) 坐标 → 可点击跳转链接（仅飞图+标记、默认本服）
  var plain = segments.map((s) => s.s).join('');

  // 会话键
  var key;
  if (kind === 'pm') {
    var tu =
      typeof raw.tu === 'object' ? String((raw.tu && raw.tu.uid) || '') : String(raw.tu || '');
    var other = self ? tu : uid;
    key = 'pm:' + (other || 'unknown');
  } else if (raw.roomId && isDynamicRoomChan(+norm.channel)) {
    key = chanKeyOf(+norm.channel) + ':' + String(raw.roomId); // 跨服/活动动态房：一房一会话
  } else {
    key = KEY_BY_C[norm.channel != null ? +norm.channel : -1] || 'c' + norm.channel;
  }

  // 被 @ 判据：atData 点名本人，或文本含 @全体成员（弱高亮）
  var mention = false;
  if (!self && atData && atData.uid) {
    for (var u of atData.uid) {
      var su = String(u && u.uid != null ? u.uid : u);
      if (su === myUid() || su === myStrUid()) {
        mention = true;
        break;
      }
    }
  }
  if (!self && text.indexOf('@' + AT_ALL_LABEL) >= 0) mention = true;

  var entry = {
    id: raw.uuid != null ? String(raw.uuid) : norm.id != null ? String(norm.id) : 'x' + Date.now(),
    uid,
    timeMs: toMs(raw.t != null ? raw.t : norm.time, raw.time),
    timeStr: hhmm(toMs(raw.t != null ? raw.t : norm.time, raw.time), showDate),
    name: self ? '我' : name,
    self,
    mention,
    pmDir: null,
    segments,
    plain,
    quote: responseData
      ? {
          name: String(responseData.name || ''),
          msg: String(responseData.msg || ''),
          id: responseData.uuid || responseData.msgId || null,
        }
      : null,
    raw, // 保留原始项供 chatupdate 原位合并后重新 buildEntry/classify（生命周期 P2）
  };
  return {
    entry,
    key,
    self,
    otherUid:
      kind === 'pm' && self ? String((typeof raw.tu === 'object' ? raw.tu.uid : raw.tu) || '') : '',
  };
}

/**
 * 链接/特殊消息 classify 描述子 -> 渲染 chip 片段（带 action 则可跳转、否则可复制）。
 * @param {object} cls classify() 产物
 * @param {object} norm normalize 产物（裸串 link<id> 表情回退查 emotionId）
 * @returns {object[]} segments
 */
export function linkSegments(cls, norm) {
  // 撤回卡：置灰纯文本，无交互
  if (cls.kind === 'revoke') return [{ type: 'chip', s: cls.label || '[已撤回]' }];
  var label = cls.kind === 'emoji' ? emojiLabel(cls, norm) : cls.label;
  var hint = '';
  if (cls.action && cls.action.type === 'pos')
    hint = cls.action.x + ',' + cls.action.y + ' 跳转地图';
  else if (cls.action && cls.action.type === 'march') hint = '跳转行军线';
  else if (cls.action && cls.action.type === 'battle') hint = '查看战报详情';
  return [{ type: 'chip', s: label, action: cls.action || null, jumpHint: hint || label }];
}
