/**
 * 跨 feat 复用的纯函数叶子（零 import）：异步 sleep、网络应答 data 归一化、send 未发出的哨兵码、今日日期串、拒绝载荷安全序列化、JSON 安全解析、HTML 转义、服务器秒时刻归一。
 *
 * 这几样此前被逐字复制进数十个 feat 与 core（sleep 19（feats 18 + core/defense 1；core/drain 例外——它是调度原语，按 schedule-primitives-thin 刻意保持除 log.js 外零 core 依赖，保留本地裸版）/ parseData 7（feats 5 + core/map·march 各 1，其中 map.js、armory-material.js 原为无守卫变体）/ CODE_NOT_SENT 22 处 / todayStr 13（11 本地时钟 + 2 以服务器时刻为基准，收口后用可选 epochSec 参保语义）/ safeStringify 3（另 mecha-treasure 因 null→'' 口径不同保留本地）/ safeParse 4（scanner 为「非字符串原样返回」变体保留本地）/ esc 2（jump/map；另 chat-overlay 严格版拆为 escStrict=esc+补 '，与主型共用内核）/ serverTimeSec 2（floatcar/titan-blessing，收为传参版），任何口径调整
 * 都要改一片、极易漏改造成 feat 间行为漂移。收口到此单一真相后，改一处即全仓生效。
 * 本模块刻意保持零 import 的叶子属性，不牵入 net/game 依赖图（feats→core 方向由 dep-cruiser 保证）。
 */

/**
 * 网络 send/ask 未真正发出（同号在途 / 发送异常 / 游戏侧 `return!1`）时回落的伪码。
 * 与业务拒绝码（服务器返回 code≠0）语义分离：这是「我们没能发出去」，属 warn 级归因；
 * 异步缓存场景切勿用它覆写有效值（详见「CODE_NOT_SENT 陷阱」）。
 * @type {number}
 */
export const CODE_NOT_SENT = -1;

/**
 * 等待毫秒（负值/NaN 经 `|0` 与 `Math.max` 钳到 0）。
 * 边界：`ms` ≥ 2^31 毫秒（≈24.8 天）或 `Infinity` 经 `|0` 回绕为 ≤0 亦钳到 0（立即 resolve）；
 * 小数毫秒向下截断。调用方实参均为毫秒级常量/小整数，此边界不可达。
 * @param {number} ms 时长（毫秒）
 * @returns {Promise<void>}
 */
export function sleep(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, Math.max(0, ms | 0));
  });
}

/**
 * 应答 data 归一化：旧 JSON 链路 data 常为字符串（game 侧 JSON_PARSE(t.d)），兜底已解析对象。
 * @param {*} d net.Ret.data
 * @returns {object|null} 解析后的对象；空/解析失败返回 null
 */
export function parseData(d) {
  if (d == null) return null;
  if (typeof d === 'object') return d;
  if (typeof d === 'string') {
    try {
      return JSON.parse(d);
    } catch (err) {
      return null;
    }
  }
  return null;
}

/**
 * 当地时区「今日」日期串 YYYY-MM-DD（跨日失效判据，与面板展示一致）。
 * 此前被逐字复制进 13 个 feat（多数为本地时钟，少数以服务器权威时刻为基准）。
 * @param {number} [epochSec] 显式传入则以该 epoch 秒为基准（如 data.ServerTime / gameData.serverTime()）；
 *   缺省（未传参）走本地时钟。边界：显式传 0（服务器时刻缺失的 `||0` 兑底）→ 1970-01-01，与旧口径一致；仅 `== null` 才回本地。
 * @returns {string}
 */
export function todayStr(epochSec) {
  var d = new Date(epochSec == null ? Date.now() : epochSec * 1000);
  var m = d.getMonth() + 1,
    day = d.getDate();
  return d.getFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day);
}

/**
 * 安全序列化拒绝载荷：PB 应答的 data/reason 是对象时 `String()` 会退化成 `[object Object]` 丢失拒绝原因。
 * null/undefined 回 `String(v)`（"null"/"undefined"，保留归因信息）；基本类型直转；其余 JSON，异常回 `String(v)`。永不抛。
 * @param {*} v ret.data / ret.reason
 * @returns {string}
 */
export function safeStringify(v) {
  if (v == null) return String(v);
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    return JSON.stringify(v);
  } catch (err) {
    return String(v);
  }
}

/**
 * 安全 JSON 解析守卫：null/空串→null；已是对象原样透传；字符串解析失败回 null，永不抛。
 * 此前被逐字复制进 4 个 feat（auto-defense/imperial-decree/mask-dance/chat-window）。
 * 边界：map/scanner.js 是「非字符串原样返回入参」的变体（失败回 `s` 而非 null），口径不同保留本地。
 * @param {*} s 待解析的 JSON 字符串 / 已解析对象 / 空值
 * @returns {*|null} 解析结果；空值或解析失败返回 null
 */
export function safeParse(s) {
  if (s == null || s === '') return null;
  if (typeof s === 'object') return s;
  try {
    return JSON.parse(s);
  } catch (err) {
    return null;
  }
}

/**
 * HTML 文本/属性转义（& < > " 四字符）：null/undefined→空串。防用户内容注入 innerHTML/属性。
 * 此前 jump-overlay/map-overlay 各内联同型实现，与 core/ui/dom.js 的 escAttr 输出全同（feats 受 ui-only-boot-and-self 锁不能 import core/ui，故归此）。
 * 边界：chat-overlay 的 esc 额外逃 `'`（属性注入更严的超集），口径不同保留本地。
 * @param {*} s
 * @returns {string}
 */
export function esc(s) {
  return String(s == null ? '' : s).replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c],
  );
}

/**
 * HTML 转义严格版：在 `esc`（& < > "）基础上再逃 `'`→`&#39;`，用于单引号包裹的属性/内联事件场景。
 * 实现为 `esc(s).replace(/'/g, '&#39;')`：`'` 最后统一转、其新引入的 `&` 不再二次转义，与逐链式转 5 字符逐字节全同（离线实测证）。
 * 此前 chat-overlay 内联此 5 字符链式版；拆分后与主型 `esc` 共用 4 字符内核（两函数关系，非重复）。
 * @param {*} s
 * @returns {string}
 */
export function escStrict(s) {
  return esc(s).replace(/'/g, '&#39;');
}

/**
 * 服务器权威时刻（epoch 秒）；缺失/0 回落本地时钟 `Date.now() / 1000`。
 * 此前 floatcar / titan-blessing 各内联同型实现（闭包各自的数据中心），收口后由调用方传入 ServerTime。
 * 边界：`serverTime` 为 0/null/undefined 或其他假值（`+serverTime` 为 0）→ 回本地；与旧口径一致。
 * @param {number|string|null} [serverTime] 服务器秒级时间戳（如 dataCenter.ServerTime）
 * @returns {number} epoch 秒
 */
export function serverTimeSec(serverTime) {
  if (serverTime != null && +serverTime) return +serverTime;
  return Date.now() / 1000;
}
