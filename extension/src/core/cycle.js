/**
 * createCycle — 电平调和循环驱动器（A 原语）
 *
 * 适用：有「可重放权威读通道」的 feat——错过一次触发，下一轮全量重读仍是真相，故可把多次外部刺激
 *   合并为「再补扫一轮」而不丢信息（如 856 全量行军、901 点位、8623/3756 列表）。反之，边沿推送即事实、
 *   错过即丢失的场景（titan-blessing）绝不能用本原语，应走 createDrain。
 *
 * 本模块只兜四件跨 feat 共同的不变量：
 *   1) 单飞闸门 running：同一时刻至多一个调和轮在飞；
 *   2) 触发合并 pending：在飞期间的外部 kick 只置位一次，本轮结束后由调用方 run() 读 cycle.pending 自行决定是否立即补扫；
 *   3) 绝不停摆：每轮结束（正常返回 / 抛错）都按 run() 返回的 delay 择时重排；pause（alive()=false）自然终止，
 *      即便 run 抛异常也按 fallback 重排（消除「早退忘重排 → 永久停摆」这类隐患）；
 *   4) 看门狗兜孤儿链：alive 时链条既不在飞也不在排程（如 pause/在飞轮 return 0 交错后 resume 未经 run() 重 kick），
 *      或排程超过唤醒点+宽限仍未醒（浏览器丢 timer），由模块级 60s 扫子 warn + 自愈补扫。
 *      真机实证（20261019 每日补给 0 点停摆）：isRunning=true 但链条死且零日志，off→on 重跑 run() 即复活。
 *
 * 契约刻意单薄——不含退避曲线 / 冷却 / 时段表 / 流程 DSL，「下一拍睡多久」的决策全归调用方：
 *   run():     async () => number  执行一轮，返回「下一次兜底扫描的间隔（毫秒）」。<=0 表示立即再跑一轮，>0 表示睡这么久。
 *   alive:     () => boolean       运行态闸门（通常接 reactor ctx.alive）；false 即不启动、睡醒也不再重排。
 *   fallback:  number              run 抛错时的兜底重排间隔（毫秒），防异常导致停摆或紧密空转。
 *   log:       logger（缺省 createLog('CYCLE')）
 * 返回：{ kick, pending, wakeAt, inFlight } —— kick() 是外部触发汇入口（启动 / 回城唤醒 / 配置变更 / 兜底定时都调它），
 *   在飞时自动合并；pending 为只读属性，供 run() 判断「本轮在飞期间是否有新触发」；
 *   wakeAt/inFlight 为只读诊断面（下次唤醒的 Date.now() 时刻 / 是否轮在飞），供探针读排程活性。
 *
 * 可观测性：每轮真正排下次（delay>0）时，驱动器统一打印一行 `next check at [yyyy-MM-dd HH:mm:ss] (after N sec)`，
 *   让「长静默期」自证仍在排程而非假死；调用方无需各自再打择时日志（delay<=0 立即补扫不打印）。
 */
import { createLog } from './log.js';

/** @type {number} 单拍排程硬顶（毫秒）：纯防御 setTimeout 溢出（>~24.8 天即 2^31ms 回绕）与异常超长值；正常 feat 已各自封顶，命中即等价 */
var MAX_ARM_MS = 24 * 3600 * 1000;

/** @type {number} 看门狗扫子间隔（毫秒）：只诊断与兜孤儿，不参与正常择时，粗粒度即可 */
var SWEEP_MS = 60 * 1000;

/** @type {number} 排程唤醒宽限（毫秒）：超过 wakeAt 这么久仍未醒（且不在飞）判为丢 timer，自愈补扫 */
var WAKE_GRACE_MS = 2 * 60 * 1000;

/** @type {number} 单轮在飞告警阈（毫秒）：超只 warn 不干预（单飞闸门神圣；net 层自带 15s 发送超时，正常轮不会命中） */
var STUCK_WARN_MS = 3 * 60 * 1000;

/**
 * 活例登记表：看门狗扫子遍历用。通过 createCycle 返回的 dispose() 可主动解除登记；
 * 未 dispose 的条目在页面存活期内常驻（feat 数量有限、页面级生命周期，泄漏可接受）。
 * @type {Set<function():void>}
 */
var sentinels = new Set();

/** @type {object|null} 模块级扫子定时器（首个 createCycle 时懒挂，页面存活期常驻，开销 O(cycle 数)/分钟） */
var sweeper = null;

/**
 * 懒启看门狗：周期性跑全部哨兵；单个哨兵异常不得阻断其余条目（各自 try/catch）。
 */
function ensureSweeper() {
  if (sweeper) return;
  sweeper = setInterval(function () {
    sentinels.forEach(function (check) {
      try {
        check();
      } catch (e) {
        /* 哨兵内部已自带兜底日志，这里只防一个 feat 异常拖垮整扫 */
      }
    });
  }, SWEEP_MS);
}

/**
 * 把「距今 ms 毫秒」换成补零的本地墙上时刻展示串（yyyy-MM-dd HH:mm:ss）；仅用于日志，基准取墙上钟不受游戏服务器钟影响。
 * @param {number} ms 距今毫秒数
 * @returns {string}
 */
function fmtAt(ms) {
  var d = new Date(Date.now() + ms);
  function p(n) {
    return (n < 10 ? '0' : '') + n;
  }
  return (
    d.getFullYear() +
    '-' +
    p(d.getMonth() + 1) +
    '-' +
    p(d.getDate()) +
    ' ' +
    p(d.getHours()) +
    ':' +
    p(d.getMinutes()) +
    ':' +
    p(d.getSeconds())
  );
}

/**
 * 创建一个调和循环驱动器。
 * @param {{run: () => Promise<number>, alive: () => boolean, fallback: number, log?: object}} o
 * @returns {{kick: () => void, dispose: () => void, readonly pending: boolean, readonly wakeAt: number, readonly inFlight: boolean}}
 */
export function createCycle(o) {
  const log = o.log || createLog('CYCLE');
  const run = o.run;
  const alive = o.alive;
  const fallback = o.fallback;
  let running = false;
  let pending = false;
  let timer = null;
  /** @type {number} 排程唤醒时刻（Date.now() 基准，0=未排程）；看门狗判「过了 wakeAt+宽限仍未醒」用 */
  let wakeAt = 0;
  /** @type {number} 本轮在飞起始时刻（0=不在飞）；超 STUCK_WARN_MS 只告警不干预 */
  let execSince = 0;
  /** @type {boolean} 卡飞告警去重（每轮只告一次，轮结束后复位） */
  let stuckWarned = false;

  function clearTimer() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    wakeAt = 0;
  }

  /** 睡 delay 毫秒后择机起一轮；睡期间可能 pause，故到点仍要复查 alive。 */
  function arm(delay) {
    clearTimer();
    if (!alive()) return;
    var d = Math.max(0, delay);
    wakeAt = Date.now() + d;
    timer = setTimeout(function () {
      timer = null;
      wakeAt = 0;
      if (alive()) exec();
    }, d);
  }

  /** 外部触发汇入口：非在飞则立即起一轮，在飞则置 pending（本轮结束后由 run() 决定补扫）。 */
  function kick() {
    if (!alive()) return;
    if (running) {
      pending = true;
      return;
    }
    exec();
  }

  /** 单轮外壳：置在飞 → 跑 run → 按返回的 delay 重排。任何抛错都落到 fallback，绝不因一次异常停摆。 */
  async function exec() {
    running = true;
    pending = false;
    execSince = Date.now();
    stuckWarned = false;
    clearTimer();
    let delay;
    try {
      delay = await run();
    } catch (err) {
      log.warn('cycle run threw.', err);
      delay = fallback;
    }
    running = false;
    execSince = 0;
    if (!alive()) return;
    if (typeof delay !== 'number' || !isFinite(delay)) delay = fallback;
    if (delay <= 0) {
      exec();
      return;
    }
    if (delay > MAX_ARM_MS) delay = MAX_ARM_MS;
    log.info('next check at [%s] (after %d sec).', fmtAt(delay), Math.round(delay / 1000));
    arm(delay);
  }

  // 看门狗哨兵：只在 alive 时动作（pause 后链自然终止由 reactor resume 走 run() 重 kick，不属孤儿）。
  //   本检查跑在独立宏任务里，exec 同步段（置 running/排 timer）不可被切断，无窗口误判。
  ensureSweeper();
  /** @type {function():void} 哨兵引用，dispose 时用于从 Set 删除 */
  const sentinel = function check() {
    if (!alive()) return;
    if (running) {
      if (!stuckWarned && execSince && Date.now() - execSince > STUCK_WARN_MS) {
        stuckWarned = true;
        log.warn(
          'round in flight %ds, run() may be hanging (no intervention).',
          Math.round((Date.now() - execSince) / 1000),
        );
      }
      return;
    }
    if (timer) {
      if (wakeAt && Date.now() > wakeAt + WAKE_GRACE_MS) {
        log.warn(
          'scheduled wake missed (was %s), self-heal kick.',
          new Date(wakeAt).toLocaleString(),
        );
        clearTimer();
        exec();
      }
      return;
    }
    // alive、不在飞、也没排程：链条成孤儿（真机：pause/return 0 交错后标志与链脱节），补扫一轮自证判据
    log.warn('cycle orphaned while alive, self-heal kick.');
    exec();
  };
  sentinels.add(sentinel);

  return {
    kick: kick,
    /**
     * 释放本 cycle 占用的看门狗资源：摘除哨兵 + 清除待飞 timer。
     * 调用后 cycle 不可再用（无状态保护，调用方自行确保不再 kick）。
     * 典型场景：feat run() 重建 cycle 前先 dispose 旧实例。
     */
    dispose: function () {
      clearTimer();
      sentinels.delete(sentinel);
    },
    get pending() {
      return pending;
    },
    get wakeAt() {
      return wakeAt;
    },
    get inFlight() {
      return running;
    },
  };
}
