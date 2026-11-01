/**
 * 跨 feat 复用的纯函数叶子（零依赖、无副作用）：异步 sleep、网络应答 data 归一化、send 未发出的哨兵码。
 *
 * 这三样此前被逐字复制进数十个 feat 与 core（sleep 19（feats 18 + core/defense 1；core/drain 例外——它是调度原语，按 schedule-primitives-thin 刻意保持除 log.js 外零 core 依赖，保留本地裸版）/ parseData 7（feats 5 + core/map·march 各 1，其中 map.js、armory-material.js 原为无守卫变体）/ CODE_NOT_SENT 22 处），任何口径调整
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
