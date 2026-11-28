/**
 * activity-hub — 活动感知总线（共享快照 + 推送合并 + 权威重查）
 *
 * 收口跨 feat 重复了 5-6 遍的管道：841 全量快照、10904/10912 推送反查、3103 单活动重查、
 * 「活动变化 → 唤醒本玩法」的订阅分发。业务语义（showUiType 匹配、可领判据、红点门控）
 * 一律留在 feat，经 watch(match, onChange) 注入——core 不认识任何活动常量。
 *
 * 生命周期：引用计数。首个 attach 启动（一次 841 + 订阅 net.10904/10912），最后一个 detach
 * 停止并退订、清空快照，回到零网络零内存。周期 841 由订阅者声明的 scanIntervalMs 取最小
 * 非零值驱动；没人声明就只在启动扫一次，后续靠推送与 refresh 单查。
 *
 * 数据源优先级：841（权威全量）> 10912（增量 extra）> 3103（单活动权威）。
 * 10912 先于 841 到达时 extra 暂存 pendingExtras，等 841 合并；快照无该活动则 3103 单查。
 *
 * 铁律：只读订阅推送，不拦截/不改写其它监听者收到的载荷；订阅者回调逐个 try/catch 隔离；
 * 每次 841 整表替换快照，不保留已结束活动。设计取舍与迁移台账见 docs/core/activity-hub.md。
 */
import { bus } from './bus.js';
import { netApi } from './net.js';
import { createLog } from './log.js';
import { parseData } from './util.js';

/** @type {number} GET_ACTIVITY_DATA：V1 send，{} → {alist:活动对象[]} */
const CMD_GET_ACTIVITY_DATA = 841;
/** @type {number} ACTIVITY_GET_SINGLE_INFO：V1 send，{id} → 单个活动对象 */
const CMD_GET_ACTIVITY_SINGLE_INFO = 3103;
/** @type {number} PUSH_ONE_ACTIVITY：整活动推送（含 id/type/extra） */
const CMD_PUSH_ONE_ACTIVITY = 10904;
/** @type {number} PUSH_ONE_ACTIVITY_EXTRA：活动 extra 推送（{aid, extra}） */
const CMD_PUSH_ONE_ACTIVITY_EXTRA = 10912;
/** @type {number} 两次 841 的最小间隔（防订阅者并发 requestScan 刷屏） */
const SCAN_MIN_GAP_MS = 2000;
/** @type {number} 同一活动两次 3103 的最小间隔（多活动同时推送时削峰） */
const REFRESH_MIN_GAP_MS = 3000;

/**
 * 活动 id 归一为索引键：841 的 id 与 10912 的 aid 可能 number/string 混用，
 * 统一 String；空值返回空串（调用方丢弃）。
 * @param {*} v 活动 id
 * @returns {string}
 */
function idKey(v) {
  return v == null ? '' : String(v);
}

/**
 * 从活动对象取 id（兼容 10904 载荷的 id/aid 两种键）。
 * @param {object} a 活动对象
 * @returns {string}
 */
function idOf(a) {
  if (!a || typeof a !== 'object') return '';
  return idKey(a.id != null ? a.id : a.aid);
}

/**
 * 合并两次 extra（浅合并，后者覆盖同键）：10912 带 worldUIRed=0 这类归零字段时
 * 覆盖旧值，同时保留推送未携带的旧字段。
 * @param {object|undefined} prev 旧 extra
 * @param {object|undefined} next 新 extra
 * @returns {object|undefined}
 */
function mergeExtra(prev, next) {
  if (!next || typeof next !== 'object') return prev;
  if (!prev || typeof prev !== 'object') return next;
  return Object.assign({}, prev, next);
}

/**
 * 创建活动感知总线（依赖可注入，便于单测）。
 * @param {object} [o] 选项
 * @param {object} [o.bus] 事件总线（默认 core/bus.js 单例）
 * @param {function():object|null} [o.getNet] net 底座取值器（活绑定，默认 netApi）
 * @param {object} [o.log] logger（默认 createLog('ACTIVITY-HUB')）
 * @returns {object} hub 实例
 */
export function createActivityHub(o) {
  o = o || {};
  const log = o.log || createLog('ACTIVITY-HUB');
  const getBus =
    o.getBus ||
    function () {
      return bus;
    };
  const getNet =
    o.getNet ||
    function () {
      return netApi;
    };
  const scanMinGapMs = Number(o.scanMinGapMs) >= 0 ? Number(o.scanMinGapMs) : SCAN_MIN_GAP_MS;
  const refreshMinGapMs =
    Number(o.refreshMinGapMs) >= 0 ? Number(o.refreshMinGapMs) : REFRESH_MIN_GAP_MS;

  /** @type {Map<string,object>} 活动快照（String(id) -> 活动对象） */
  let snapshot = new Map();
  /** @type {Map<string,object>} 10912 先于快照到达的 extra（等 841 合并） */
  let pendingExtras = new Map();
  /** @type {Set<{match:Function,onChange:Function,label:string}>} 订阅者 */
  const subs = new Set();
  /** @type {Map<object,{label:string,scanIntervalMs:number}>} 引用计数 token -> 声明 */
  const refs = new Map();
  /** @type {Function[]} 推送退订句柄 */
  let unsubs = [];
  /** @type {boolean} 是否已启动 */
  let started = false;
  /** @type {number|null} 周期扫描句柄 */
  let scanTimer = null;
  /** @type {number} 当前周期（0=无周期） */
  let scanEveryMs = 0;
  /** @type {number} 上次 841 发起时刻 */
  let lastScanAt = 0;
  /** @type {Promise<boolean>|null} 在飞 841（单飞） */
  let scanning = null;
  /** @type {Map<string,Promise<{activity:object|null,fresh:boolean}>>} 在飞 3103（按活动单飞） */
  const refreshing = new Map();
  /** @type {Map<string,number>} 各活动上次 3103 时刻 */
  const lastRefreshAt = new Map();
  /** @type {number} 生命周期代际：stop/restart 后旧应答不得写入新快照 */
  let generation = 0;

  /**
   * 活动变化分发：只回调 match 命中的订阅者；单个订阅者抛错不拖垮其它订阅者。
   * @param {object} activity 合并后的活动对象
   * @param {string} reason 变化来源（scan/push-activity/push-extra/refresh/watch）
   */
  function notify(activity, reason) {
    if (!activity) return;
    const list = Array.from(subs);
    for (let i = 0; i < list.length; i++) {
      const sub = list[i];
      try {
        if (!sub.match || !sub.match(activity)) continue;
        sub.onChange(activity, reason);
      } catch (err) {
        log.warn(
          'subscriber failed. label=%s;activityId=%s;reason=%s;err=%s',
          sub.label,
          idOf(activity) || '-',
          reason,
          (err && err.message) || String(err),
        );
      }
    }
  }

  /**
   * 把一个活动对象并入快照并分发（10904 / 3103 共用）。
   * @param {object} activity 活动对象
   * @param {string} reason 变化来源
   * @returns {object|null} 合并后的活动
   */
  function mergeActivity(activity, reason) {
    const key = idOf(activity);
    if (!key) {
      log.debug('activity ignored: missing id. reason=%s', reason);
      return null;
    }
    const extra = pendingExtras.get(key);
    if (extra) {
      activity.extra = mergeExtra(activity.extra, extra);
      pendingExtras.delete(key);
    }
    snapshot.set(key, activity);
    notify(activity, reason);
    return activity;
  }

  /**
   * 841 全量扫描：整表替换快照，合并 pendingExtras，按 match 分发。
   * 节流 + 单飞；失败保留旧快照（不抛错）。
   * @returns {Promise<boolean>} true=本轮拿到了合法 alist
   */
  async function scan() {
    if (!started) return false;
    if (scanning) return scanning;
    const now = Date.now();
    if (now - lastScanAt < scanMinGapMs) return false;
    const net = getNet();
    if (!net || typeof net.sendGuarded !== 'function') {
      log.debug('scan skipped: net not ready.');
      return false;
    }
    lastScanAt = now;
    const myGen = generation;
    const p = (async function () {
      let ret;
      try {
        ret = await net.sendGuarded(
          CMD_GET_ACTIVITY_DATA,
          {},
          {
            protocol: 'send',
            gate: false,
            onError: function (err) {
              log.warn('cmd 841 threw: %s', (err && err.message) || String(err));
            },
          },
        );
      } catch (err) {
        log.warn('cmd 841 threw outside net guard: %s', (err && err.message) || String(err));
        return false;
      }
      if (!ret || !ret.ok) {
        if (ret && ret.code === -1) {
          log.warn('cmd 841 not sent. code=%s', ret.code);
        } else {
          log.info(
            'cmd 841 rejected. code=%s;reason=%s',
            ret ? ret.code : '?',
            (ret && ret.reason) || '-',
          );
        }
        return false;
      }
      const data = parseData(ret.data);
      const alist =
        data && typeof data === 'object' && Array.isArray(data.alist) ? data.alist : null;
      if (!alist) {
        log.warn('cmd 841 ack missing alist.');
        return false;
      }
      if (myGen !== generation) return false;
      const next = new Map();
      for (let i = 0; i < alist.length; i++) {
        const a = alist[i];
        const key = idOf(a);
        if (!key) continue;
        // 841 的 extra 是裁剪版（实证：81200412 的 can_receive_uid_list/reward_received_list
        // 只在 10912 里），周期性整表替换前先与旧 extra 浅合并，避免把增量字段洗掉。
        const prev = snapshot.get(key);
        const merged = mergeExtra(prev && prev.extra, a.extra);
        if (merged) a.extra = merged;
        const extra = pendingExtras.get(key);
        if (extra) {
          a.extra = mergeExtra(a.extra, extra);
          pendingExtras.delete(key);
        }
        next.set(key, a);
      }
      snapshot = next;
      log.debug(
        'cmd 841 snapshot replaced. activities=%d;pending=%d',
        snapshot.size,
        pendingExtras.size,
      );
      for (const a of snapshot.values()) notify(a, 'scan');
      return true;
    })();
    scanning = p;
    p.finally(function () {
      if (scanning === p) scanning = null;
    });
    return p;
  }

  /**
   * 3103 单活动权威重查：按活动单飞 + 每活动最小间隔；失败返回当前快照（可能 null）。
   * force 用于「领取受理后立即确认」：跳过最小间隔节流，但仍受单飞约束（在飞时复用同一请求）。
   * @param {string|number} aid 活动 id
   * @param {object} [opts] 选项
   * @param {boolean} [opts.force] true=跳过最小间隔节流
   * @returns {Promise<object|null>} 权威活动对象
   */
  function refresh(aid, opts) {
    return refreshEx(aid, opts).then(function (result) {
      return result.activity;
    });
  }

  /**
   * 3103 单活动权威重查（带元信息）：fresh=false 表示本轮没拿到可信的权威应答
   * （未启动/被节流/net 未就绪/被拒/畸形/id 错配/代际失效），activity 为当前快照；
   * fresh=true 表示 3103 应答已合并进快照（即使内容恰好未变化）。领取链路据此区分
   * 「验证失败（下轮重试）」与「验证成功但无进展（指数退避）」。
   * @param {string|number} aid 活动 id
   * @param {object} [opts] 选项
   * @param {boolean} [opts.force] true=跳过最小间隔节流
   * @returns {Promise<{activity:object|null,fresh:boolean}>}
   */
  function refreshEx(aid, opts) {
    const key = idKey(aid);
    if (!key) return Promise.resolve({ activity: null, fresh: false });
    if (refreshing.has(key)) return refreshing.get(key);
    const force = !!(opts && opts.force);
    const now = Date.now();
    if (!force && now - (lastRefreshAt.get(key) || 0) < refreshMinGapMs) {
      return Promise.resolve({ activity: snapshot.get(key) || null, fresh: false });
    }
    const net = getNet();
    if (!net || typeof net.sendGuarded !== 'function') {
      log.debug('refresh skipped: net not ready. activityId=%s', key);
      return Promise.resolve({ activity: snapshot.get(key) || null, fresh: false });
    }
    lastRefreshAt.set(key, now);
    const myGen = generation;
    const p = (async function () {
      let ret;
      try {
        ret = await net.sendGuarded(
          CMD_GET_ACTIVITY_SINGLE_INFO,
          { id: aid },
          {
            protocol: 'send',
            gate: false,
            onError: function (err) {
              log.debug(
                'cmd 3103 threw. activityId=%s;err=%s',
                key,
                (err && err.message) || String(err),
              );
            },
          },
        );
      } catch (err) {
        log.debug(
          'cmd 3103 threw outside net guard. activityId=%s;err=%s',
          key,
          (err && err.message) || String(err),
        );
        return { activity: snapshot.get(key) || null, fresh: false };
      }
      if (!ret || !ret.ok) {
        log.debug('cmd 3103 not confirmed. activityId=%s;code=%s', key, ret ? ret.code : '?');
        return { activity: snapshot.get(key) || null, fresh: false };
      }
      const data = parseData(ret.data);
      if (myGen !== generation) return { activity: null, fresh: false };
      if (!data || typeof data !== 'object' || Array.isArray(data) || idOf(data) !== key) {
        log.warn('cmd 3103 ack malformed or id mismatch. requestedId=%s', key);
        return { activity: snapshot.get(key) || null, fresh: false };
      }
      const merged = mergeActivity(data, 'refresh');
      return { activity: merged, fresh: merged != null };
    })();
    refreshing.set(key, p);
    p.finally(function () {
      if (refreshing.get(key) === p) refreshing.delete(key);
    });
    return p;
  }

  /**
   * 推送入口：10904 合并整活动；10912 合并 extra，快照缺失则 3103 补齐。
   * @param {string} type 事件名（net.10904 / net.10912）
   * @param {object} ev net 事件（data 为业务体）
   */
  function onBusEvent(type, ev) {
    if (!started) return;
    if (type !== 'net.' + CMD_PUSH_ONE_ACTIVITY && type !== 'net.' + CMD_PUSH_ONE_ACTIVITY_EXTRA) {
      return;
    }
    const data = ev && ev.data;
    if (!data || typeof data !== 'object') return;
    const aid = idOf(data);
    if (!aid) {
      log.debug('push ignored: missing id. type=%s', type);
      return;
    }
    if (type === 'net.' + CMD_PUSH_ONE_ACTIVITY) {
      const activity = data.activity && typeof data.activity === 'object' ? data.activity : data;
      mergeActivity(activity, 'push-activity');
      return;
    }
    const extra = data.extra;
    if (!extra || typeof extra !== 'object') {
      log.debug('push extra ignored: malformed. activityId=%s', aid);
      return;
    }
    const existing = snapshot.get(aid);
    if (existing) {
      existing.extra = mergeExtra(existing.extra, extra);
      notify(existing, 'push-extra');
      return;
    }
    pendingExtras.set(aid, mergeExtra(pendingExtras.get(aid), extra));
    log.debug('push extra pending until snapshot knows activity. activityId=%s', aid);
    refresh(aid);
  }

  /**
   * 取引用计数里最小的非零扫描档位。
   * @returns {number} 毫秒；0=无周期
   */
  function pickScanEvery() {
    let min = 0;
    for (const ref of refs.values()) {
      const ms = Number(ref.scanIntervalMs) || 0;
      if (ms > 0 && (min === 0 || ms < min)) min = ms;
    }
    return min;
  }

  /**
   * 按当前订阅档位重建周期定时器。
   */
  function retune() {
    const every = pickScanEvery();
    if (every === scanEveryMs) return;
    if (scanTimer != null) {
      clearInterval(scanTimer);
      scanTimer = null;
    }
    scanEveryMs = every;
    if (every > 0 && started) {
      scanTimer = setInterval(function () {
        scan();
      }, every);
    }
  }

  /**
   * 启动：订阅两条活动推送，立即扫一次 841。
   */
  function start() {
    if (started) return;
    started = true;
    const b = getBus();
    if (!b || typeof b.on !== 'function') {
      log.warn('start degraded: bus unavailable.');
    } else {
      unsubs.push(
        b.on('net.' + CMD_PUSH_ONE_ACTIVITY, function (ev) {
          onBusEvent('net.' + CMD_PUSH_ONE_ACTIVITY, ev);
        }),
      );
      unsubs.push(
        b.on('net.' + CMD_PUSH_ONE_ACTIVITY_EXTRA, function (ev) {
          onBusEvent('net.' + CMD_PUSH_ONE_ACTIVITY_EXTRA, ev);
        }),
      );
    }
    retune();
    log.info('started. refs=%d;scanEvery=%dms', refs.size, scanEveryMs);
    scan();
  }

  /**
   * 停止：退订、停周期、清空快照与 pending。
   */
  function stop() {
    if (!started) return;
    started = false;
    generation++;
    for (let i = 0; i < unsubs.length; i++) {
      try {
        unsubs[i]();
      } catch (err) {
        // 退订失败不影响其余清理
      }
    }
    unsubs = [];
    scanning = null;
    if (scanTimer != null) {
      clearInterval(scanTimer);
      scanTimer = null;
    }
    scanEveryMs = 0;
    snapshot = new Map();
    pendingExtras = new Map();
    lastScanAt = 0;
    lastRefreshAt.clear();
    log.info('stopped; snapshot cleared.');
  }

  /**
   * 声明一个消费者（引用计数）。首个启动、最后一个停止。
   * @param {object} [opts] 选项
   * @param {string} [opts.label] 日志标识（feat id）
   * @param {number} [opts.scanIntervalMs] 周期 841 档位；0/缺省=不声明
   * @returns {function():void} detach（幂等）
   */
  function attach(opts) {
    opts = opts || {};
    const token = {};
    refs.set(token, {
      label: opts.label || 'anonymous',
      scanIntervalMs: Number(opts.scanIntervalMs) || 0,
    });
    if (!started) {
      start();
    } else {
      retune();
      log.info('attached. label=%s;refs=%d', opts.label || 'anonymous', refs.size);
    }
    return function () {
      if (!refs.delete(token)) return;
      if (refs.size === 0) stop();
      else retune();
    };
  }

  /**
   * 订阅活动变化：match 由 feat 提供（core 不认识活动常量）；注册时对当前快照
   * 已命中的活动立即回调一次（reason='watch'），保证启动顺序不影响首扫。
   * @param {function(object):boolean} match 活动匹配函数
   * @param {function(object,string):void} onChange 命中回调（activity, reason）
   * @param {object} [opts] 选项
   * @param {string} [opts.label] 日志标识（feat id）
   * @returns {function():void} 退订（幂等）
   */
  function watch(match, onChange, opts) {
    opts = opts || {};
    if (typeof match !== 'function' || typeof onChange !== 'function') {
      log.warn('watch rejected: match/onChange must be functions.');
      return function () {};
    }
    const sub = { match: match, onChange: onChange, label: opts.label || 'anonymous' };
    subs.add(sub);
    for (const a of snapshot.values()) {
      try {
        if (match(a)) onChange(a, 'watch');
      } catch (err) {
        log.warn(
          'subscriber failed on watch. label=%s;activityId=%s;err=%s',
          sub.label,
          idOf(a) || '-',
          (err && err.message) || String(err),
        );
      }
    }
    return function () {
      subs.delete(sub);
    };
  }

  /**
   * 取单个活动（String(id) 索引）。
   * @param {string|number} aid 活动 id
   * @returns {object|undefined}
   */
  function get(aid) {
    return snapshot.get(idKey(aid));
  }

  /**
   * 取全量快照副本。
   * @returns {object[]}
   */
  function list() {
    return Array.from(snapshot.values());
  }

  /**
   * 按 type 取首个活动。
   * @param {number} type 活动 type
   * @returns {object|undefined}
   */
  function getByType(type) {
    for (const a of snapshot.values()) {
      if (a && a.type === type) return a;
    }
    return undefined;
  }

  /**
   * 按 showUiType 取首个活动（匹配逻辑由调用方传入值，core 不内置枚举）。
   * @param {string} uiType showUiType
   * @returns {object|undefined}
   */
  function getByUiType(uiType) {
    for (const a of snapshot.values()) {
      if (a && a.showUiType === uiType) return a;
    }
    return undefined;
  }

  /**
   * 请求立即 841（受 2s 最小间隔约束）；不等待结果。
   * @returns {Promise<boolean>} 本轮是否真正发起（节流/未启动时 false）
   */
  function requestScan() {
    return scan();
  }

  /**
   * 更新某订阅者声明的周期 841 档位，并按新档立即重调周期定时器。
   * 只改本订阅者自己的声明：实际周期仍取全部订阅者的最小非零值，空闲退避类需求
   * （feat 连续多轮无待领后放宽自己的档位）不得到别人的扫描节奏。
   * 按 label 匹配，同名多条一并更新（本项目内 feat label 唯一）。
   * @param {string} label 订阅者标识
   * @param {number} ms 新档位（0=不声明周期）
   * @returns {number} 命中并更新的引用数（0=无此 label，调用方按未生效处理）
   */
  function tune(label, ms) {
    if (!label) return 0;
    let hit = 0;
    for (const ref of refs.values()) {
      if (ref.label !== label) continue;
      ref.scanIntervalMs = Number(ms) || 0;
      hit++;
    }
    if (hit) retune();
    return hit;
  }

  /**
   * 调试统计。
   * @returns {{refs:number,subs:number,activities:number,pending:number,lastScanAt:number,scanning:boolean,scanEveryMs:number}}
   */
  function stats() {
    return {
      refs: refs.size,
      subs: subs.size,
      activities: snapshot.size,
      pending: pendingExtras.size,
      lastScanAt: lastScanAt,
      scanning: !!scanning,
      scanEveryMs: scanEveryMs,
    };
  }

  return {
    attach: attach,
    watch: watch,
    get: get,
    list: list,
    getByType: getByType,
    getByUiType: getByUiType,
    refresh: refresh,
    refreshEx: refreshEx,
    scan: scan,
    requestScan: requestScan,
    tune: tune,
    stats: stats,
  };
}

/** @type {object} 全局单例（真实 bus/netApi；feat 直接 import 使用） */
export const activityHub = createActivityHub({});
