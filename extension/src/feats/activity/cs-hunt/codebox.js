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
 *   `strToView(s)`→视图数组：**数字位=已知、任意标点/符号或 x/o 字母=未知占位（-1）**——不枚举掩码符，凡「非数字、
 *   非分隔符」皆视作未知位（真机队友手输的未知位符号五花八门：`?`/`*`/`-`/`×`/`□`/`x`/`o`…，穷举白名单必漏）；
 *   含真实单词字母（x/o 之外）即判噪声丢弃，避免把英文词误读成视图；
 *   `parseCodeViews(text)`→以「空白/汉字/emoji/成对句读标点」切出定长 5 且≥1 数字位的码体段为候选视图；
 *   `merge([[2,-1,..],[-1,1,..]])`→逐位取已知。内部统一用 `-1` 表示未知。
 */

/** @type {number} 单轮最多生成的候选数（未知位 >3 时截断，防 10^n 组合打爆事件窗口） */
const MAX_CANDIDATES = 1000;
/** @type {number} 密码视图位数（codeNum 定长，与真机 5 位对齐） */
const CODE_LEN = 5;
/**
 * @type {RegExp} 码体**分隔符**（u 标志）：空白、汉字（`\p{Script=Han}`）、emoji（`\p{Extended_Pictographic}`），
 *   以及几乎不会被队友当作「单格未知掩码」的成对/句读标点（半角与全角的括号、书名号、引号、逗号、分号、冒号、
 *   斜杠、竖线等）。**刻意不含** `? ？ * ＊ - _ ＿ ~ × ○ ·` 等常作未知位占位的符号——它们留在码体内按「非数字即未知」解析。
 *   思路是「枚举分隔符（小而稳定）而非枚举掩码符（无穷无尽）」：任何未预见的手输符号都自动归为未知位，不再丢视图。
 */
const CODE_SEP_RE =
  /[\s\p{Script=Han}\p{Extended_Pictographic}，。、；：（）〔〕《》〈〉【】［］｛｝“”‘’()[\]{}<>,;:|"\\/]/u;
/** @type {RegExp} 可作未知占位的字母（x/o 两族，人类填「空格」的通用写法）；其余文字字母视为噪声。 */
const MASK_LETTER_RE = /[xXoO]/;
/** @type {RegExp} 任意标点或符号（`\p{P}`/`\p{S}`）——一律视作未知掩码位，无需枚举具体符号。 */
const SYMBOL_RE = /[\p{P}\p{S}]/u;

/**
 * 单字符数字值：ASCII `0-9` 与全角 `０-９` 归一为 0..9，其余回 -1（非可识别数字）。
 *   不用 `Number(ch)` 也不用 `\p{Nd}`——前者不认全角、后者含阿拉伯-印度数字等本场景不会出现的字符且无法直接取值。
 * @param {string} ch 单个字符
 * @returns {number} 0..9 或 -1
 */
function digitValue(ch) {
  var c = ch.charCodeAt(0);
  if (c >= 48 && c <= 57) return c - 48; // ASCII 0-9
  if (c >= 0xff10 && c <= 0xff19) return c - 0xff10; // 全角 ０-９
  return -1;
}

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
 * 聊天串 → 视图数组（**数字位=已知 0..9、任意标点/符号或 x/o 字母=未知 -1**）。
 *   不枚举掩码符：凡「非数字」的字符，只要属于标点/符号（{@link SYMBOL_RE}）或 x/o 占位字母（{@link MASK_LETTER_RE}）
 *   即视作未知位；出现其它文字字母（英文单词、其它语系）即判整串为噪声回 null，避免把 "c00lk" 之类误读成视图。
 *   要求至少含 1 个已知数字位（队友至少知道自己那一位），否则回 null。调用方 parseCodeViews 已先切出定长段。
 * @param {string} s 待解析串
 * @returns {Array<number>|null} 视图数组或 null（非法）
 */
export function strToView(s) {
  s = String(s == null ? '' : s);
  if (!s.length) return null;
  var out = [];
  var hasDigit = false;
  for (var i = 0; i < s.length; i++) {
    var ch = s.charAt(i);
    var dv = digitValue(ch);
    if (dv >= 0) {
      out.push(dv); // 数字=已知（ASCII/全角均经 digitValue 归一为 0..9）
      hasDigit = true;
    } else if (MASK_LETTER_RE.test(ch) || SYMBOL_RE.test(ch)) {
      out.push(-1); // 标点/符号掩码 或 x/o 字母占位 = 未知
    } else {
      return null; // 其它文字字母=噪声，整串判非法
    }
  }
  return hasDigit ? out : null; // 纯掩码（无任何已知位）不是有效视图
}

/**
 * 从一条聊天文本提取 5 位密码视图（队友手输/我方广播均适用）：以 {@link CODE_SEP_RE}（空白/汉字/emoji/成对句读标点）
 *   切分，取长度恰为 {@link CODE_LEN} 的码体段交 {@link strToView} 按位解析（其内含「≥1 已知数字位」校验）。
 *   **为何要求定长 5**：每个数字的「位置」只有在完整的 5 格框架里才可对齐——队友各报自己那一位，位数不足或超长的段
 *   无法定位，宁弃勿猜。`95185`/`9----`/`xxxx5`/`???8?`/`□□□□5` 等价可切；纯掩码段与含真实单词的段自然丢弃。
 * @param {string} text 聊天原文
 * @returns {Array<Array<number>>} 视图数组列表（可能为空）
 */
export function parseCodeViews(text) {
  var s = String(text == null ? '' : text);
  var out = [];
  var segs = s.split(CODE_SEP_RE); // split 会按正则所有匹配处切开（无需 /g），且不留 lastIndex 残留
  for (var i = 0; i < segs.length; i++) {
    if (segs[i].length !== CODE_LEN) continue; // 定长 5 才能对齐每一位数字的位置
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
