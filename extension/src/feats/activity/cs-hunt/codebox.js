/**
 * feats/activity/cs-hunt/codebox.js —— 「密码大爆炸」(codeBox, eventSpecId 1003xx) 求解纯函数。
 *
 * 数据模型（报文实证 dashcam 20261016T190507/191700/192930/194018，§9.4/§4.1 关闭）：
 *   `eventCodeBoxInfo.codeNum[5]`：本端直读，每位是 `0..9` 明文或 `-1`（掩码）。
 *   四趟 6 个样本**均为 2 人队、恒「4 明文 + 1 掩码」**（[2,1,7,1,-1] / [-1,1,2,1,9] / …）——
 *   源码 CSHuntEventCodeBox 坐实：`codeNum` 每位 `-1` 渲染成 `?`，客户端只见自己那一层视图，填满 5 位才发 7537，
 *   **游戏内无跨玩家聚合**（填满靠玩家口头在频道 17 互报）。故满编 5 人队各只见 1 位、余下 4 位为掩码（10^4 组合），
 *   穷举不可行——**必须以聊天汇总为主路**（本端视图发频道 17、收队友视图 merge），穷举仅作未知位≤2 的兜底。
 *
 * 提交契约：`7537 {treasureId, round, codeNum[5]}` 全量提交（已知位保持原值，未知位填汇总/猜测数字）。
 *   猜错可继续提交（服务端不锁，靠 play/show 阶段计时），命中即 `uidWinMap[我的uid]=true`。
 *
 * 视图编解码（聊天汇总用，纯函数无网络）：`viewToStr([2,1,-1,-1,-1])`→5 位定长串 `"21---"`（我方广播用 `-`）；
 *   `strToView(s)`→视图数组：**数字位=已知、任意非数字符号=未知占位（-1）**——真机队友手输时不确定的位用非数字表示，
 *   符号不固定（`53**32`/`53??32`/`53--32` 等价，但数字对应的位固定，见 dashcam 队友频道 17 手输）；
 *   `parseCodeViews(text)`→从一条聊天文本按「数字/符号为码体、空白与字母/汉字为分隔」正则切出定长 5 位候选视图；
 *   `merge([[2,-1,..],[-1,1,..]])`→逐位取已知。内部统一用 `-1` 表示未知。
 */

/** @type {number} 单轮最多生成的候选数（未知位 >3 时截断，防 10^n 组合打爆事件窗口） */
const MAX_CANDIDATES = 1000;
/** @type {number} 密码视图位数（codeNum 定长，与真机 5 位对齐） */
const CODE_LEN = 5;

/**
 * codeNum 是否已全明文（无 -1）。全明文的密码无需穷举，直接提交唯一候选。
 * @param {Array<number>} codeNum 5 位数组（0..9 或 -1）
 * @returns {boolean}
 */
export function isFullyKnown(codeNum) {
  if (!Array.isArray(codeNum)) return false;
  for (var i = 0; i < codeNum.length; i++) if (Number(codeNum[i]) < 0) return false;
  return true;
}

/**
 * 由 codeNum 生成待提交候选列表（按未知位先后、数字 0..9 升序做笛卡尔积）。
 * 已知位固定为原值，未知位逐一代入 0..9。候选数超过 {@link MAX_CANDIDATES} 即截断。
 * @param {Array<number>} codeNum 5 位数组（0..9 或 -1）
 * @returns {Array<Array<number>>} 候选全量数组列表（每个长度同 codeNum）；非法输入返回 []
 */
export function solveCandidates(codeNum) {
  if (!Array.isArray(codeNum) || !codeNum.length) return [];
  var base = codeNum.map(function (d) {
    return Number(d);
  });
  var unknown = [];
  for (var i = 0; i < base.length; i++) if (base[i] < 0) unknown.push(i);
  var out = [];
  if (!unknown.length) return [base]; // 全明文：唯一候选即原样提交
  var total = Math.pow(10, unknown.length);
  for (var n = 0; n < total && out.length < MAX_CANDIDATES; n++) {
    var cand = base.slice();
    var rem = n;
    for (var u = unknown.length - 1; u >= 0; u--) {
      cand[unknown[u]] = rem % 10;
      rem = (rem / 10) | 0;
    }
    out.push(cand);
  }
  return out;
}

/**
 * 从候选列表里取第一个「本轮尚未试过」的候选（用于逐次提交、命中即止）。
 * @param {Array<Array<number>>} candidates {@link solveCandidates} 产物
 * @param {Set<string>} triedKeySet 本轮已提交过的候选键集合（`join('')` 形态）
 * @returns {{cand:Array<number>|null, key:string}} 下一个候选及其键；无新候选时 cand=null
 */
export function nextUntried(candidates, triedKeySet) {
  for (var i = 0; i < candidates.length; i++) {
    var key = candidates[i].join('');
    if (!triedKeySet.has(key)) return { cand: candidates[i], key: key };
  }
  return { cand: null, key: '' };
}

/**
 * 本端视图 → 聊天串（每位 `0..9` 明文、`-1`（未知）→ `'-'`）。如 `[2,1,-1,1,-1]`→`"21-1-"`。
 * @param {Array<number>} codeNum 5 位数组（0..9 或 -1）
 * @returns {string} 定长串；非数组回 ''
 */
export function viewToStr(codeNum) {
  if (!Array.isArray(codeNum)) return '';
  var s = '';
  for (var i = 0; i < codeNum.length; i++) {
    var d = Number(codeNum[i]);
    s += d < 0 ? '-' : String(d);
  }
  return s;
}

/**
 * 聊天串 → 视图数组（**数字位=已知 0..9、任意非数字符号=未知 -1**）。
 *   真机队友手输不确定的位用非数字表示，符号不固定（`?`/`*`/`-`/`×`/`＿`…），但数字对应的位固定——故不校验具体符号、
 *   只按「非数字即未知」逐位映射（调用方 parseCodeViews 已先按位定长切好）。跳过空白；含字母/汉字即判噪声回 null（非纯视图）。
 * @param {string} s 待解析串
 * @returns {Array<number>|null} 视图数组或 null（非法）
 */
export function strToView(s) {
  s = String(s == null ? '' : s);
  if (!s.length) return null;
  if (/[\p{L}]/u.test(s)) return null; // 含字母/汉字即非纯视图（噪声），丢弃
  var out = [];
  for (var i = 0; i < s.length; i++) {
    var ch = s.charAt(i);
    if (ch >= '0' && ch <= '9')
      out.push(ch.charCodeAt(0) - 48); // 数字=已知
    else if (/\s/.test(ch))
      continue; // 空白=分隔，跳过
    else out.push(-1); // 其余任意非数字=未知占位（符号不限）
  }
  return out.length ? out : null;
}

/**
 * 从一条聊天文本提取 5 位密码视图（队友手输/我方广播均适用）：以「空白、字母（含中日韩汉字）、句子标点」为分隔
 *   切出「数字+掩码符号」候选段，段长恰为 {@link CODE_LEN} 者交 {@link strToView} 按位解析。
 *   分隔标点只取句读（，。、；：,;: 与括号），**不含 `? * - ×` 等可作未知占位的符号**（它们当掩码保留）。
 *   数字位固定、未知位用任意非数字符号（`53**32`/`53??32`/`53--32` 等价）。噪声段（长度不符/含字母）自然丢弃。
 * @param {string} text 聊天原文
 * @returns {Array<Array<number>>} 视图数组列表（可能为空）
 */
export function parseCodeViews(text) {
  var s = String(text == null ? '' : text);
  var out = [];
  var segs = s.split(/[\s\p{L}，、。；：“”‘’（）〔〕《》【】,;:(){}<>]+/u);
  for (var i = 0; i < segs.length; i++) {
    if (segs[i].length !== CODE_LEN) continue;
    var v = strToView(segs[i]);
    if (v && v.length === CODE_LEN) out.push(v);
  }
  return out;
}

/**
 * 多份视图逐位合并：每位取「任一份已知」的数字（冲突取先见的已知位，队友各见互斥位、实践中不冲突）。
 * 长度取各份最大值与 5 的较大者，缺位以 -1 补齐。用于把本端视图 + 频道 17 收到的队友视图汇成本回合完整视图。
 * @param {Array<Array<number>>} views 视图数组的数组
 * @returns {Array<number>} 合并后的视图（-1=仍未知）
 */
export function merge(views) {
  var arr = Array.isArray(views) ? views : [];
  var len = CODE_LEN;
  for (var i = 0; i < arr.length; i++) {
    if (Array.isArray(arr[i]) && arr[i].length > len) len = arr[i].length;
  }
  var out = [];
  for (var p = 0; p < len; p++) out.push(-1);
  for (var v = 0; v < arr.length; v++) {
    var view = arr[v];
    if (!Array.isArray(view)) continue;
    for (var k = 0; k < view.length; k++) {
      var d = Number(view[k]);
      if (out[k] < 0 && d >= 0) out[k] = d;
    }
  }
  return out;
}
