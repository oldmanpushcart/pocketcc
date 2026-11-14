/**
 * createSnapshotPool — 快照池（D 原语：键控去重 + TTL + wake.at + 一次性消耗）
 *
 * 适用：边沿推送即事实、无重放读通道的 feat（12003 集结创建这类）——每条推送是一份独立快照，
 *   错过即丢失，绝不能套 createCycle 的「下轮重读补回」合并语义（归类文档 C/D 族红线）。
 *   推送过闸后把快照入池，延迟到点一次性消耗；同键重复推送拒入，过期快照惰性剔除。
 *
 * 本模块只兜四件跨 feat 共同的不变量：
 *   1) 键控去重：同键在池期间再 offer 一律拒入（返 false），不替换载荷、不续命 TTL——
 *      池内快照以首次入池为准，重复推送不得重置唤醒时刻；
 *   2) TTL 惰性过期：expireAt 已过的快照 offer 拒入、到点剔除，不挂后台扫子（池规模小，
 *      offer/wake/reschedule 三个触点顺带清即可）；
 *   3) wake.at 托管唤醒：每条目一个 ctx.setTimeout（reactor pause 统一清），到点先复查 TTL
 *      再一次性出池调 onWake(key, payload)；wakeAt 缺省/已过 → 0ms 立即（让同步栈先落地）；
 *   4) 一次性消耗：onWake 调用前条目已出池，抛错也出池（warn 兜底）——「已处理」不可回滚，
 *      重试与否是调用方业务，池不拥有重试。
 *
 * 契约刻意单薄（同 cycle/drain 的薄契约纪律，arch 规则 schedule-primitives-thin）：
 *   入池前的业务闸门（家族/行军/配额…）、到点后的动作编排、每日计数全归调用方；
 *   不含优先级堆 / 批量弹出 / 流程 DSL——多实例各自计时的复杂排程是 createEventHeap（C）的活。
 *
 * pause/resume 语义：pause 时 reactor 清光托管定时器，池条目保留（TTL 自然作废过期者）；
 *   resume 后由调用方在 run() 里调 reschedule() 把未过期条目重新排唤醒（wakeAt 已过 → 立即）。
 *   与 titan/floatcar「pause 保留、恢复续跑」同口径。
 *
 * @param {object} o
 * @param {function():boolean} o.alive 运行态闸门（通常接 reactor ctx.alive）；false 时 offer/reschedule 拒动
 * @param {function():object|null} o.ctx reactor ctx 访问器（热读）；null 或定时器托管失败（返回 -1）时 offer 拒入
 * @param {function(string, *):void|Promise<void>} o.onWake 到点消耗回调，收到 (key, payload)；抛错由本器兜住
 * @param {object} [o.log] logger（缺省 createLog('SNAPSHOT_POOL')）
 * @returns {{offer:function(string,*,{wakeAt?:number,expireAt?:number}):boolean, reschedule:function():void, size:function():number, has:function(string):boolean}}
 */
import { createLog } from './log.js';

/**
 * 创建一个快照池。
 * @param {object} o 见模块头 JSDoc
 * @returns {object} {offer, reschedule, size, has}
 */
export function createSnapshotPool(o) {
  const log = o.log || createLog('SNAPSHOT_POOL');
  const alive = o.alive;
  const getCtx = o.ctx;
  const onWake = o.onWake;
  /** @type {Map<string,{payload:*,wakeAt:number,expireAt:number,timer:number}>} 池条目（键控，timer=托管句柄） */
  const entries = new Map();

  /**
   * 排一个条目的唤醒（先清旧句柄防重复排程；到点先复查 TTL 再一次性出池消耗）。
   * @param {string} key 条目键
   * @param {object} e 池条目
   */
  function arm(key, e) {
    const ctx = getCtx();
    if (e.timer != null) ctx.clearTimeout(e.timer);
    const delay = Math.max(0, (e.wakeAt || 0) - Date.now());
    e.timer = ctx.setTimeout(function () {
      e.timer = null;
      if (!alive()) return; // pause 竞态双保险（托管定时器正常已被 pause 清光）
      entries.delete(key); // 一次性消耗：先出池再回调，抛错也不回池
      if (e.expireAt > 0 && Date.now() >= e.expireAt) return; // 延迟期内过期：静默剔除（动作日志归调用方）
      try {
        const r = onWake(key, e.payload);
        if (r && typeof r.catch === 'function') {
          r.catch(function (err) {
            log.warn('snapshot pool onWake threw!', err);
          });
        }
      } catch (err) {
        log.warn('snapshot pool onWake threw!', err);
      }
    }, delay);
  }

  return {
    /**
     * 入池一份快照：同键拒入不续命 / expireAt 已过拒入 / 非运行态或无 ctx 拒入。
     * @param {string} key 去重键（如集结 teamId）
     * @param {*} payload 快照载荷（原样透传给 onWake，池不解读）
     * @param {{wakeAt?:number, expireAt?:number}} [t] wakeAt=唤醒时刻（Date.now() 基准 ms，缺省立即）；expireAt=过期时刻（ms，0/缺省=不过期）
     * @returns {boolean} 是否入池成功
     */
    offer: function (key, payload, t) {
      if (!alive()) return false;
      const ctx = getCtx();
      if (!ctx) return false;
      if (entries.has(key)) return false;
      const wakeAt = t && Number.isFinite(t.wakeAt) ? t.wakeAt : 0;
      const expireAt = t && Number.isFinite(t.expireAt) ? t.expireAt : 0;
      if (expireAt > 0 && Date.now() >= expireAt) return false;
      const e = { payload: payload, wakeAt: wakeAt, expireAt: expireAt, timer: null };
      entries.set(key, e);
      arm(key, e);
      if (e.timer === -1) {
        // 托管失败（ctx 非激活）：不得留无唤醒的孤儿条目
        entries.delete(key);
        return false;
      }
      return true;
    },
    /**
     * 重排全部未过期条目的唤醒（resume 后由 run() 调）：过期者剔除，wakeAt 已过 → 立即。
     * pause 已清光的旧句柄 clearTimeout 静默 no-op，重排安全。
     */
    reschedule: function () {
      if (!alive()) return;
      const ctx = getCtx();
      if (!ctx) return;
      const now = Date.now();
      entries.forEach(function (e, key) {
        if (e.expireAt > 0 && now >= e.expireAt) {
          entries.delete(key);
          return;
        }
        arm(key, e);
      });
    },
    /** @returns {number} 池内条目数（诊断面） */
    size: function () {
      return entries.size;
    },
    /**
     * 键是否在池（诊断面；不做惰性过期判定，过期剔除只发生在 offer/wake/reschedule 触点）
     * @param {string} key 去重键
     * @returns {boolean}
     */
    has: function (key) {
      return entries.has(key);
    },
  };
}
