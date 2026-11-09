// ══ 闸门边沿日志（secret-realm 簇内共享，零依赖叶子）═══════════════════
// 用途：引擎的「静默睡过」出口（总闸不过 / 不在现场 / 冷却中 / 无料可动）本身不该逐拍刷屏，
//   但事后必须在日志里留下「这一拍是被哪个闸拦住的」——否则上送日志里只有一段空白，
//   无法区分「没启动」「条件不满足」「在冷却」。
// 语义完全复刻 pilot.js 的 `#gateState`（边沿触发 info，同闸只记进入/恢复各一条），
//   抽出来供其余引擎复用，避免每个引擎各写一份去重表。
// 纪律：
//   · 只打日志，不参与任何判定、不改任何 return 值与睡眠时长。
//   · 零依赖：不 import core，也不 import 簇内其它模块（与 util.js 同层的叶子）。
//     不放进 util.js——那边是纯函数集合，本文件是带状态的类，混在一起会稀释各自的职责。
//   · message 一律英文（core/log.js 契约）；闸名是英文标识，detail 允许带坐标/ID 等决策上下文。

/**
 * 闸门状态边沿记录器。
 * 用法：`const gates = new GateStateLog(env.log, 'shop')` → 每拍对每个闸调 `edge(name, blocked, detail)`。
 */
export class GateStateLog {
  /**
   * @param {object} log createLog 产物（只用 .info）
   * @param {string} tag 引擎名前缀（如 `shop`/`heal`），消息统一为 `<tag>: gate[...] ...`
   */
  constructor(log, tag) {
    /** @type {object} 日志器 */
    this._log = log;
    /** @type {string} 引擎名前缀 */
    this._tag = tag || '';
    /** @type {Object<string,1>} 当前处于 blocked 边沿的闸名（缺省=未拦或已恢复） */
    this._on = {};
  }

  /**
   * 上报一个闸的本拍状态；只在跳变时落一条 info。
   * @param {string} name 闸名（英文短标识，供 --grep 直接命中）
   * @param {boolean} blocked 本拍是否被拦
   * @param {string} [detail] 决策上下文（marchState / 坐标 / 余量等），只在边沿出现
   * @returns {boolean} 本拍是否处于 blocked（便于调用侧串接早退）
   */
  edge(name, blocked, detail) {
    const tail = detail ? ' ' + detail : '';
    if (blocked && !this._on[name]) {
      this._on[name] = 1;
      this._log.info('%s: gate[%s] blocked, skip this tick.%s', this._tag, name, tail);
    } else if (!blocked && this._on[name]) {
      delete this._on[name];
      this._log.info('%s: gate[%s] passed.%s', this._tag, name, tail);
    }
    return !!blocked;
  }

  /** 清空边沿状态（stop()/换场时调，防止跨会话把上一次的 blocked 当成前值）。 */
  reset() {
    this._on = {};
  }
}
