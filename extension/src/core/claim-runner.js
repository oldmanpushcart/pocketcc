/**
 * claim-runner — 活动领取执行器（协议分派 + 节奏 + 退避 + 结果分类）
 *
 * 收口跨 feat 重复的「领取动作管线」：ACTION_GAP 节奏、在途闸门、业务拒绝固定退避、
 * 无进展指数退避、成功后的权威确认清退避。协议号、参数形态、可领判据全部由 feat 注册的
 * handler 提供——runner 不认识任何活动常量。
 *
 * 与 activity-hub 的分工：hub 管「领什么」（活动快照与变化），runner 管「怎么发、被拒后怎么办」。
 * 与 createCycle 的分工：cycle 管「下一拍睡多久」，runner 只管单次领取动作，不拥有调度。
 *
 * 退避键默认 `${cmd}:${aid}:${targetId}`；feat 可用 handler.key(item) 自定义。
 * 时间基准用本地 Date.now()：退避是本地节流，服务端时间漂移不影响量级。
 */
import { netApi } from './net.js';
import { createLog } from './log.js';
import { sleep } from './util.js';

/** @type {number} 与 core/util.js 的 CODE_NOT_SENT 同值；保持薄依赖不引入 util 常量 */
const CODE_NOT_SENT = -1;

/**
 * 创建领取执行器（每 feat 一个实例：退避状态按 feat 隔离，日志可注入 feat 的 logger）。
 * @param {object} [o] 选项
 * @param {function():object|null} [o.getNet] net 底座取值器（活绑定，默认 netApi）
 * @param {object} [o.log] logger（默认 createLog('CLAIM-RUNNER')）
 * @param {number} [o.actionGapMs] 两次领取最小间隔（默认 1500ms）
 * @param {number} [o.businessBackoffMs] 业务拒绝固定退避（默认 15 分钟）
 * @param {number} [o.noProgressBaseMs] 无进展指数退避基数（默认 20s）
 * @param {number} [o.noProgressMaxMs] 无进展指数退避上限（默认 5 分钟）
 * @param {function():number} [o.now] 时间源（默认 Date.now，单测注入）
 * @returns {object} runner 实例
 */
export function createClaimRunner(o) {
  o = o || {};
  const log = o.log || createLog('CLAIM-RUNNER');
  const getNet =
    o.getNet ||
    function () {
      return netApi;
    };
  const actionGapMs = Number(o.actionGapMs) >= 0 ? Number(o.actionGapMs) : 1500;
  const businessBackoffMs =
    Number(o.businessBackoffMs) >= 0 ? Number(o.businessBackoffMs) : 15 * 60 * 1000;
  const noProgressBaseMs = Number(o.noProgressBaseMs) >= 0 ? Number(o.noProgressBaseMs) : 20 * 1000;
  const noProgressMaxMs =
    Number(o.noProgressMaxMs) >= 0 ? Number(o.noProgressMaxMs) : 5 * 60 * 1000;
  const now = typeof o.now === 'function' ? o.now : Date.now;

  /** @type {Map<number,{protocol:string,body:Function,key:Function,label:string}>} 协议 handler */
  const handlers = new Map();
  /** @type {Map<string,{until:number,streak:number}>} 退避表（key -> 到期时刻/连败轮次） */
  const cooldowns = new Map();
  /** @type {number} 上次领取发起时刻（ACTION_GAP 用） */
  let lastClaimAt = 0;

  /**
   * 退避键：handler 可覆盖；默认 cmd:aid:targetId。
   * @param {object} item 领取项
   * @param {object} handler 协议 handler
   * @returns {string}
   */
  function keyOf(item, handler) {
    if (handler && typeof handler.key === 'function') return String(handler.key(item));
    return (
      String(item.cmd) + ':' + String(item.aid) + ':' + (item.targetId == null ? '' : item.targetId)
    );
  }

  /**
   * 注册协议 handler。
   * @param {number} cmd 协议号
   * @param {object} handler 处理器
   * @param {'send'|'sendPB'|'sendPBV2'} [handler.protocol] 发送通道（默认 send）
   * @param {function(object):object} [handler.body] 由领取项生成载荷（默认 item.body || {}）
   * @param {function(object):string} [handler.key] 自定义退避键
   * @param {string} [handler.label] 日志标识（协议语义）
   */
  function register(cmd, handler) {
    if (!cmd || !handler || typeof handler !== 'object') {
      log.warn('register rejected: cmd=%s', cmd);
      return;
    }
    handlers.set(Number(cmd), {
      protocol: handler.protocol || 'send',
      body:
        typeof handler.body === 'function'
          ? handler.body
          : function (item) {
              return item.body || {};
            },
      key: typeof handler.key === 'function' ? handler.key : null,
      label: handler.label || 'claim',
    });
  }

  /**
   * 检查领取项是否处于退避中（不等待）。
   * @param {object} item 领取项
   * @returns {boolean}
   */
  function isSuppressed(item) {
    const handler = handlers.get(Number(item.cmd));
    if (!handler) return false;
    const entry = cooldowns.get(keyOf(item, handler));
    if (!entry || entry.until <= now()) return false;
    log.debug(
      'claim suppressed. cmd=%s;key=%s;retryAfter=%dms',
      item.cmd,
      keyOf(item, handler),
      entry.until - now(),
    );
    return true;
  }

  /**
   * 执行一次领取。
   * @param {object} item 领取项：{cmd, aid, targetId?, body?, signal?, label?}
   * @returns {Promise<{status:'ok'|'rejected'|'transient'|'suppressed'|'unregistered'|'aborted',ret:object|null,code:number}>}
   */
  async function claim(item) {
    item = item || {};
    const cmd = Number(item.cmd);
    const handler = handlers.get(cmd);
    if (!handler) {
      log.warn('claim rejected: protocol not registered. cmd=%s', item.cmd);
      return { status: 'unregistered', ret: null, code: -2 };
    }
    if (isSuppressed(item)) return { status: 'suppressed', ret: null, code: -3 };
    if (item.signal && item.signal.aborted) return { status: 'aborted', ret: null, code: -4 };

    const gap = actionGapMs - (now() - lastClaimAt);
    if (gap > 0) {
      await sleep(gap, item.signal || null);
      if (item.signal && item.signal.aborted) return { status: 'aborted', ret: null, code: -4 };
    }
    const net = getNet();
    if (!net || typeof net.sendGuarded !== 'function') {
      log.debug('claim skipped: net not ready. cmd=%s', cmd);
      return { status: 'transient', ret: null, code: CODE_NOT_SENT };
    }
    lastClaimAt = now();
    let ret;
    try {
      ret = await net.sendGuarded(cmd, handler.body(item), {
        protocol: handler.protocol,
        gate: true,
        onError: function (err) {
          log.warn('cmd %s %s threw: %s', cmd, handler.label, (err && err.message) || String(err));
        },
      });
    } catch (err) {
      log.warn(
        'cmd %s %s threw outside net guard: %s',
        cmd,
        handler.label,
        (err && err.message) || String(err),
      );
      return { status: 'transient', ret: null, code: CODE_NOT_SENT };
    }
    if (!ret || !ret.ok) {
      if (ret && ret.code === CODE_NOT_SENT) {
        log.warn(
          'cmd %s %s transient (not sent/in-flight). key=%s',
          cmd,
          handler.label,
          keyOf(item, handler),
        );
        return { status: 'transient', ret: ret || null, code: CODE_NOT_SENT };
      }
      log.info(
        'cmd %s %s rejected. key=%s;code=%s;reason=%s',
        cmd,
        handler.label,
        keyOf(item, handler),
        ret ? ret.code : '?',
        (ret && ret.reason) || '-',
      );
      return { status: 'rejected', ret: ret || null, code: ret ? ret.code : -5 };
    }
    log.debug('cmd %s %s accepted. key=%s', cmd, handler.label, keyOf(item, handler));
    return { status: 'ok', ret: ret, code: ret.code };
  }

  /**
   * 权威确认推进后清退避。
   * @param {object} item 领取项
   */
  function confirm(item) {
    const handler = handlers.get(Number(item && item.cmd));
    if (!handler) return;
    cooldowns.delete(keyOf(item, handler));
  }

  /**
   * 业务拒绝：固定退避（默认 15 分钟），连败轮次清零。
   * @param {object} item 领取项
   */
  function suppress(item) {
    const handler = handlers.get(Number(item && item.cmd));
    if (!handler) return;
    cooldowns.set(keyOf(item, handler), { until: now() + businessBackoffMs, streak: 0 });
  }

  /**
   * 已受理但权威状态未推进：指数退避（基数 × 2^(streak-1)，封顶 max）。
   * @param {object} item 领取项
   */
  function noProgress(item) {
    const handler = handlers.get(Number(item && item.cmd));
    if (!handler) return;
    const key = keyOf(item, handler);
    const prev = cooldowns.get(key);
    const streak = prev ? prev.streak + 1 : 1;
    const delay = Math.min(noProgressBaseMs * 2 ** (streak - 1), noProgressMaxMs);
    cooldowns.set(key, { until: now() + delay, streak: streak });
    log.debug('claim no-progress backoff. key=%s;streak=%d;delay=%dms', key, streak, delay);
  }

  /**
   * 全量清空退避表与节奏时间戳：feat 每次 activate 复位、测试用例间隔离用。
   * 与 prune 的区别：prune 按业务存活裁剪，reset 是「回到刚创建状态」。
   */
  function reset() {
    cooldowns.clear();
    lastClaimAt = 0;
  }

  /**
   * 清理退避表：keep(key, entry) 返回 false 的条目删除。
   * @param {function(string,object):boolean} keep 保留判定
   */
  function prune(keep) {
    if (typeof keep !== 'function') return;
    for (const key of cooldowns.keys()) {
      const entry = cooldowns.get(key);
      if (!keep(key, entry)) cooldowns.delete(key);
    }
  }

  /**
   * 调试统计。
   * @returns {{handlers:number,cooldowns:number,lastClaimAt:number}}
   */
  function stats() {
    return { handlers: handlers.size, cooldowns: cooldowns.size, lastClaimAt: lastClaimAt };
  }

  return {
    register: register,
    claim: claim,
    confirm: confirm,
    suppress: suppress,
    noProgress: noProgress,
    isSuppressed: isSuppressed,
    reset: reset,
    prune: prune,
    stats: stats,
  };
}
