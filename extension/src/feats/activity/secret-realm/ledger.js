/**
 * secret-realm 簇内账本原语（零 import 叶子）：TtlLedger。
 *
 * 统一 pilot 七账本（marched/consumed/dayBlack/paramBlack/bossDone/change/exhausted）的
 * Map/object/Set 混用口径：一律「键 → 值」单表，过期语义收口为两条规则——
 *   • 数值 = 解禁时刻（毫秒绝对，与 Date.now 同口径）：`until <= now` 即过期；
 *     `-1` 是永久哨兵（永不过期，sweep 不碰）。
 *   • 非数值（对象载荷/标记 true）= 无 TTL，生命周期归调用方（换场 #resetMatch 整体清）。
 * 过期判定一律**惰性**（读时判 + sweep 批量清），不起定时器；模板来自旧 #paramBlocked。
 * 本原语不懂游戏业务：不读 tuning、不发日志，判据与留痕归调用方。
 */

/** 键 → 值账本（TTL 语义见文件头）。值形态：number=解禁毫秒（-1 永久）/ 其它=无 TTL 载荷。 */
export class TtlLedger {
  /** @type {Map<string,*>} */
  #m = new Map();

  /** @returns {number} 条目数（含已过期未清扫项，纯读诊断用） */
  get size() {
    return this.#m.size;
  }

  /**
   * 记一个无 TTL 标记（本场拉黑/已打过/已采完类）。
   *   存非数值哨兵 true：若存数值 1 会被 sweep 当「已过期时间戳」误清。
   * @param {string} key 键（空键忽略）
   */
  mark(key) {
    if (key) this.#m.set(key, true);
  }

  /**
   * 写一条任意值（数值=解禁毫秒，-1=永久；对象=无 TTL 载荷）。
   * @param {string} key 键（空键忽略）
   * @param {*} value 值
   */
  set(key, value) {
    if (key) this.#m.set(key, value);
  }

  /**
   * 原样取值（**不判过期**——TTL 判定归调用方，与旧各账本读口径逐位等价）。
   * @param {string} key 键
   * @returns {*} 未记账回 undefined
   */
  get(key) {
    return key ? this.#m.get(key) : undefined;
  }

  /**
   * 是否记过账（存在性，不判过期）。
   * @param {string} key 键
   * @returns {boolean}
   */
  has(key) {
    return !!key && this.#m.has(key);
  }

  /**
   * 删一条。
   * @param {string} key 键
   */
  delete(key) {
    if (key) this.#m.delete(key);
  }

  /** 整表清空（换场/停机复位用）。 */
  clear() {
    this.#m.clear();
  }

  /**
   * 键清单（插入序，含已过期未清扫项；诊断面用）。
   * @returns {string[]}
   */
  keys() {
    return Array.from(this.#m.keys());
  }

  /**
   * 遍历（Map 同序 `(value, key)`；不判过期，与旧 forEach 口径一致）。
   * @param {function(*,string):void} fn 回调
   */
  forEach(fn) {
    this.#m.forEach(fn);
  }

  /**
   * 批量清扫已过期项：仅数值且 `until <= now` 才删；-1 永久哨兵与非数值载荷不碰。
   * @param {number} now 当前毫秒
   * @returns {number} 清掉的条数
   */
  sweep(now) {
    let n = 0;
    this.#m.forEach((v, k) => {
      if (typeof v === 'number' && v !== -1 && v <= now) {
        this.#m.delete(k);
        n++;
      }
    });
    return n;
  }
}
