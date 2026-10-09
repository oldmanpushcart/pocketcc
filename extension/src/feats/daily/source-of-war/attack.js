/**
 * 战争之源 —— 攻打动作（AttackFlow，一套独立动作一个文件）。
 *
 * 职责：在各刷新窗口内自动派兵攻打全服共享 PvE 世界 BOSS（世界 BOSS 二期，代号 SOW），
 *   每天定额 5 次，三形态（陆/海/空）各选预设部队（1-8）。自持 scanTimer 与当日攻打额度（storage.data 落盘、跳日归零）。
 * 与领奖链（reward.js）彻底解耦：不受领奖状态牵引；不再用 spec 级 offInCombat（那会连领奖一起暂停），
 *   改由 attackOnce 内部判 isCombat()——战斗态只跳过派兵攻打。pause 后 alive()=false 让定时器到点空转、在飞流程自然退出。
 *
 * 协议（均为旧 JSON net.send）：
 *   1) 9956（GET_BOSS_INFO_V2）{} → 应答 data 为 JSON 串需 parse：{reason,finishTime,alive,bossId,x,y,lv,costEnergy}；
 *      alive=1 才是「当前有可打 BOSS」的权威信号（非窗口期/目标已消失不为 1），reason>0 跨服战期禁止攻打。
 *   2) 902（MARCH_WORLD_POINT）{marchType:298,x,y,armyList...} → 派该预设部队攻打；载荷与「快捷攻击」同源（core/battle.js）。
 *
 * 调度（不轮询）：在场期间以回包 finishTime 为在场截止（liveUntil）每 TICK_INTERVAL 慢扫补派；
 *   另订阅本人行军 10019（USER_MARCH_INFO）只认 state===4 回城即补扫；不在场靠本地日程排睡到下一窗口起点+WARMUP_DELAY。
 *   真正攻打与否只由 9956 回包 alive 决定（fail-closed）；配置取不到退化为同节奏兜底定时，不静默停摆。
 *
 * 运行时单例（net/dataCenter/presets/alive）由 index.js 经 env 注入（引擎不反向 import index，避免循环依赖）。
 */
import { createLog } from '../../../core/log.js';
import { bus } from '../../../core/bus.js';
import { storage } from '../../../core/storage.js';
import { l10n, gameConf } from '../../../core/game-api.js';
import { isCombat } from '../../../core/mode.js';
import { Battle } from '../../../core/battle.js';
import { march } from '../../../core/march.js';
import { todayStr, safeStringify } from './util.js';

/** @type {ReturnType<createLog>} 模块日志器（tag 与领奖链一致，便于聚合阅读） */
const log = createLog('SOURCE-OF-WAR');

/** @type {number} RequestId.GET_BOSS_INFO_V2，查询当前战争之源 BOSS（旧 JSON send）→ {bossId,id,x,y,reason} */
const CMD_GET_BOSS_INFO_V2 = 9956;

/** @type {number} RequestId.MARCH_WORLD_POINT，世界地图行军；仅用于发攻前的同 cmd 在途频控（发送走 core/march.attack） */
const CMD_MARCH_WORLD_POINT = 902;

/**
 * 行军类型：ATTACK_WORLD_BOSS_V2（战争之源二期世界 BOSS）
 * 定义：NMarchType.ATTACK_WORLD_BOSS_V2 = 298（WorldMapCommon / NWorldMapMarchCommon 枚举）
 * PvE 世界 BOSS 不参与跨服攻玩家城的 marchType 漂移（march.resolve 只换 attackPlayer），故直接用固定值。
 * @type {number}
 */
const MARCH_TYPE = 298;

/** @type {number} EnergyType.Action（GameDefine：e[e.Action=1]），攻打消耗的体力类型 */
const ENERGY_ACTION = 1;

/**
 * BOSS 形态数（0陆/1海/2空），与面板三个预设选择器一一对应
 * @type {number}
 */
const FORM_COUNT = 3;

/** @type {number} DataConfig：每日刷新小时点 "h1|h2|..."（相对系统日零点的小时偏移） */
const CFG_KEY_HOURS = 82000003;

/** @type {number} DataConfig：BOSS 存在时长（秒）所在配置表字段 */
const BOSS_LIFE_FIELD = 'life_time';

/**
 * BOSS 存在时长兜底值（秒）：仅供本地窗口表排程粗估用（在场期间实际排程由 9956 回包 finishTime 驱动）。
 * 实证单波 BOSS 可长达 2 小时（id 与 finishTime 差 7200000ms）；此兜底值只在无回包 finishTime 且 BOSS 表 life_time 读不到时生效。
 * @type {number}
 */
const DEFAULT_LIFE = 60 * 30;

/** @type {number} 每天攻打总次数上限（跨所有窗口累计，打满即收工） */
const DAILY_LIMIT = 5;

/** @type {number} 窗口起点后延迟开扫（毫秒）：起始扫描错开刷新瞬间，默认 5 分钟 */
const WARMUP_DELAY = 1000 * 60 * 5;

/** @type {number} 窗口内的慢扫间隔（毫秒）：只查 9956 + 尝试补一派，默认 3 分钟 */
const TICK_INTERVAL = 1000 * 60 * 3;

/** @type {number} 回城推送补扫的最小间隔（毫秒）：合并一场行军的多条 10019 状态推送，避免 9956 突发 */
const PUSH_SCAN_MIN_GAP = 1000 * 5;

/** @type {number} 跨日重排余量（毫秒）：零点后半小时再看当日日程，避开零点数据未就绪 */
const DAY_ROLL_BUFFER = 1000 * 60 * 30;

/**
 * 攻打一次战争之源的体力消耗兜底值（最后兜底）。
 * 实证优先取 9956 应答的 costEnergy（普遍=5），其次 BOSS 表 cost_energy；两者都取不到才用此值。
 * @type {number}
 */
const DEFAULT_COST_ENERGY = 5;

/**
 * 体力不足的应答 data 键集合（字典表实证四键均=「体力不足」）。
 * 服务器攻打拒绝（应答 code≠0）里 data 命中其一即判定体力不足 → 放弃本轮、不扣当日额度。
 * @type {string[]}
 */
const ENERGY_SHORT_KEYS = ['100182', 'army_123560', 'world_130507', 'battle_121508'];

/** @type {string} storage.data 分片名：当日攻打计数持久态 */
const DAILY_STATE_NAME = 'sourceOfWar.daily';

/**
 * 攻打动作引擎：由 index.js 装配层实例化并注入 env。
 * env = { getNet, getData, getPresets, alive }（均为惰性读取，install 前返回 null 亦安全——面板读展示会显占位符）。
 */
export class AttackFlow {
  /** @param {{getNet:Function, getData:Function, getPresets:Function, alive:Function}} env */
  constructor(env) {
    this.env = env;
    /** @type {boolean} 扫描在飞闸门（含 9956 await），防并发进入 */
    this.scanning = false;
    /**
     * 当前在场 BOSS 的消失时刻（服务器秒）：由 9956 回包 finishTime 驱动。
     * now < liveUntil 表示已知 BOSS 在场，排程按 tick 慢扫而非依赖本地窗口表；无在场 BOSS 置 0。
     * @type {number}
     */
    this.liveUntil = 0;
    /** @type {number|null} 攻打链定时器（窗口睡眠 / 窗口内慢扫共用一个）；pause 后到点空转不再自重排 */
    this.scanTimer = null;
    /** @type {number} 上次因行军回城推送补扫的墙钟时刻（毫秒），用于合并突发 */
    this.lastPushScanAt = 0;
    /**
     * 当日攻打计数持久态：{ date:'YYYY-MM-DD', count:number }。
     * 读回完成前不落盘（内存 0 很可能是假象，整块写回会覆掉盘上真值），见 persistDaily。
     * @type {{date:string, count:number}}
     */
    this.dailyState = { date: '', count: 0 };
    /** @type {boolean} 持久态是否已读回 */
    this.dailyStateLoaded = false;
    // march.onHomeReturn 复播回调需绑 this（全局单点订阅、非 ctx 级）
    this.onHomeArrived = this.onHomeArrived.bind(this);
    /** @type {Function|null} march.onHomeReturn 退订句柄（防重激活重复注册） */
    this._offHomeReturn = null;
  }

  /** @returns {object} 网络底座 */ get net() {
    return this.env.getNet();
  }
  /** @returns {object} DataCenter.DATA */ get dc() {
    return this.env.getData();
  }
  /** @returns {number[]} 三形态预设队号 */ get presets() {
    return this.env.getPresets();
  }
  /** @returns {boolean} 功能是否仍在运行 */ alive() {
    return this.env.alive();
  }

  // ── 当日定额 ──────────────────────────────────────────────────────
  /**
   * 当日剩余攻打额度（未读回盘上数据前按 0 已攻打处理，最坏是多打几次，不会漏打）
   * @returns {number}
   */
  quotaLeft() {
    if (this.dailyState.date !== todayStr()) return DAILY_LIMIT; // 跳日归零（读回回调里也会整体覆写）
    return Math.max(0, DAILY_LIMIT - (this.dailyState.count | 0));
  }

  /**
   * 异步读回当日计数（每轮 run 调一次）。读失败不置 loaded：读不到 ≠ 盘上没数据，留给下次 run 重试。
   * @returns {Promise<void>}
   */
  async loadDaily() {
    try {
      var saved = await storage.data.get(DAILY_STATE_NAME);
      this.dailyStateLoaded = true;
      if (saved && typeof saved === 'object' && saved.date === todayStr()) {
        this.dailyState.date = saved.date;
        this.dailyState.count = saved.count | 0;
      } else {
        this.dailyState.date = todayStr();
        this.dailyState.count = 0;
      }
    } catch (err) {
      log.warn('daily state load failed, retry next run. %s', err && err.message);
    }
  }

  /**
   * 攻打成功后计数 +1 并落盘（写失败不阻断主流程），顺带推面板刷新今日计数
   */
  bumpDailyCount() {
    if (this.dailyState.date !== todayStr()) {
      this.dailyState.date = todayStr();
      this.dailyState.count = 0;
    }
    this.dailyState.count = (this.dailyState.count | 0) + 1;
    if (this.dailyStateLoaded) {
      Promise.resolve(
        storage.data.set(DAILY_STATE_NAME, {
          date: this.dailyState.date,
          count: this.dailyState.count,
        }),
      ).catch(function (err) {
        log.warn('daily state save failed.', err);
      });
    }
    bus.emit('ui.refresh');
  }

  /**
   * 面板展示的「今日已攻打」：N / 上限。纯展示函数，未读回时显示占位符。
   * @returns {string}
   */
  formatToday() {
    if (!this.dailyStateLoaded) return '-';
    return (this.dailyState.count | 0) + ' / ' + DAILY_LIMIT;
  }

  // ── 窗口排表 ──────────────────────────────────────────────────────
  /**
   * 当日 BOSS 刷新窗口表：起 = SystemZeroTime + 3600*小时点，止 = 起 + BOSS.life_time。
   * 口径与游戏活动面板 setupDisplay / 地图弹窗 reBuildBossTimeTable / 图标 checkBossCanAttack 三处一致。
   * life_time 各小时点可能不同（取决于该槽刷出的 bossId），这里取白名单里第一个可用 BOSS 行的值；
   * 取不到时长时按窗口无限长处理（由 9956 的「有没有 BOSS」实际兜底）。
   * @returns {Array<{start:number, end:number}>|null} 升序窗口表；配置不可用返回 null（调用方走兜底定时）
   */
  buildWindows() {
    var u = (this.dc && this.dc.UserData) || {};
    var zero = +u.SystemZeroTime || 0;
    var now = +(this.dc && this.dc.ServerTime) || 0;
    if (!zero || !now) return null;

    var raw = gameConf.dataConfig(CFG_KEY_HOURS);
    var hours = String(raw == null ? '' : raw)
      .split('|')
      .map(function (h) {
        return parseInt(h, 10);
      })
      .filter(function (h) {
        return isFinite(h);
      })
      .sort(function (a, b) {
        return a - b;
      });
    if (!hours.length) return null;

    var life = this.bossLifeSeconds();
    var windows = hours.map(function (h) {
      var start = zero + 3600 * h;
      return { start: start, end: start + life };
    });
    // 已过完的今天窗口不留（否则"下一窗口"会指向过去的槽）；全过完则由调用方推到晚点后重算
    return windows.filter(function (w) {
      return w.end > now;
    });
  }

  /**
   * BOSS 存在时长兜底值（秒）：供排程用的粗估窗口长。优先读代表 bossId 的 life_time，
   * 取不到时回退 DEFAULT_LIFE（不再返 0——返 0 会让窗口退化为零长、把今天所有槽都过滤掉，scheduleNext 无法排程）。
   * @returns {number}
   */
  bossLifeSeconds() {
    // 三个形态各有一个代表 bossId（101/201/301，活动 type_para2 白名单口径），取首个读到的 life_time
    var probes = [101, 201, 301];
    for (var i = 0; i < probes.length; i++) {
      var row = l10n.tableRow('BOSS', probes[i]);
      var life = row && Number(row[BOSS_LIFE_FIELD]);
      if (life > 0) return life;
    }
    return DEFAULT_LIFE;
  }

  /**
   * 当前时刻相对当日窗口表的位置。
   * @param {Array<{start:number, end:number}>} windows 升序窗口表
   * @param {number} now 当前服务器时间（秒）
   * @returns {{kind:string, window?:{start:number, end:number}, at?:number}}
   *   kind：'in'（窗口内，window=当前窗口）| 'wait'（窗口前，at=建议开扫时刻）| 'gone'（表内窗口都已结束）
   */
  locateWindow(windows, now) {
    var nextStart = Infinity;
    for (var i = 0; i < windows.length; i++) {
      var w = windows[i];
      if (now < w.start) {
        if (w.start < nextStart) nextStart = w.start;
      } else if (now < w.end) {
        return { kind: 'in', window: w };
      }
    }
    if (nextStart < Infinity) return { kind: 'wait', at: nextStart + WARMUP_DELAY / 1000 };
    return { kind: 'gone' };
  }

  /**
   * 排下一次攻打扫描（只管攻打，领奖由 reward.js 独立全天跑）：睡到窗口开扫点 / 窗口内慢扫 / 次日重算。
   * 额度打满或今天窗口跑完 → 睡到零点后重算。排表不可用时降级为窗口内节奏的兜底定时（宁可慢，不静默停摆）。
   * @param {number} [delayMs] 显式延迟（毫秒）；缺省据当前窗口位置推导
   */
  scheduleNext(delayMs) {
    if (!this.alive()) return;
    if (this.scanTimer) clearTimeout(this.scanTimer);
    var self = this;

    // 攻打额度打满：本链睡到次日重算（领奖链按各自节律继续，互不牵连）
    var ms;
    if (this.quotaLeft() <= 0) {
      var u0 = (this.dc && this.dc.UserData) || {};
      var nowQ = +(this.dc && this.dc.ServerTime) || 0;
      var dayEndQ = (+u0.SystemZeroTime || 0) + 86400;
      ms = Math.max(TICK_INTERVAL, (dayEndQ - nowQ) * 1000 + DAY_ROLL_BUFFER);
      log.debug('attack quota used up, next scan in %d min', Math.round(ms / 60000));
      this.scanTimer = setTimeout(
        function () {
          self.scanTimer = null;
          if (self.alive()) self.triggerScan();
        },
        Math.max(0, ms),
      );
      return;
    }

    ms = delayMs;
    if (ms == null) {
      var u = (this.dc && this.dc.UserData) || {};
      var now = +(this.dc && this.dc.ServerTime) || 0;
      if (this.liveUntil > now && now > 0) {
        // 已知当前 BOSS 在场（上次 9956 回 alive=1 且未到 finishTime）：按 tick 慢扫用满额度，
        // 不再依赖本地窗口表（其 life_time 推导不可靠，会把 2 小时长窗口误算成短窗口而睡过）。
        ms = TICK_INTERVAL;
      } else {
        var windows = this.buildWindows();
        if (!windows || !windows.length || !now) {
          ms = TICK_INTERVAL;
        } else {
          var pos = this.locateWindow(windows, now);
          if (pos.kind === 'in') {
            ms = TICK_INTERVAL;
          } else if (pos.kind === 'wait') {
            ms = Math.max(0, (pos.at - now) * 1000);
          } else {
            // 今天窗口跑完：睡到零点后（加余量）再重算——届时 SystemZeroTime 已翻新的一天
            var dayEnd = (+u.SystemZeroTime || 0) + 86400;
            ms = Math.max(TICK_INTERVAL, (dayEnd - now) * 1000 + DAY_ROLL_BUFFER);
          }
        }
      }
    }

    log.debug('next scan in %d min', Math.round(ms / 60000));
    this.scanTimer = setTimeout(
      function () {
        self.scanTimer = null;
        if (self.alive()) self.triggerScan();
      },
      Math.max(0, ms),
    );
  }

  // ── 扫描与攻打 ────────────────────────────────────────────────────
  /**
   * 扫描触发汇入口：run 点火 / 排程定时器 / 回城推送都走这里。扫描在飞时不并发进入
   */
  triggerScan() {
    if (!this.alive() || this.scanning) return;
    this.scanOnce().catch(function (err) {
      log.warn('scan threw.', err);
    });
  }

  /**
   * 行军到家复播（march.onHomeReturn，state→ARRIVED_HOME 边沿）：BOSS 行军（marchType=298）回城即补派下一次。
   * 全局单点订阅的代价：march.js 常驻 10019，feat 暂停仍会收到复播 → 回调内自判 alive 为硬约束；
   * 只认 m.type===298（其它行军回城不唤醒，免空跑）；自持 min-gap 节流（march.js 不代管）。
   * 只在场窗口（liveUntil 未到）且额度未满、无扫描在飞时才补扫；补扫仍走 scanOnce 全套闸门。
   * @param {object} m 归一化 March
   */
  onHomeArrived(m) {
    if (!this.alive() || this.scanning) return;
    if ((m && m.type | 0) !== MARCH_TYPE) return; // 只认本玩法 BOSS 行军（298）回城
    var now = +(this.dc && this.dc.ServerTime) || 0;
    if (!(now > 0 && this.liveUntil > now)) return; // 不在场窗口，不因无关行军空转
    if (this.quotaLeft() <= 0) return;
    var wall = Date.now();
    if (wall - this.lastPushScanAt < PUSH_SCAN_MIN_GAP) return;
    this.lastPushScanAt = wall;
    log.debug('boss march arrived home in live window, early re-scan.');
    this.triggerScan();
  }

  /**
   * 单轮攻打：额度/窗口判位 → 有 BOSS 且闸门放开即打一波 → 排下一次。永不 reject。
   * 不再在此搭领奖（领奖由 reward.js 独立全天链 + push 21923/21924 驱动）。
   * @returns {Promise<void>}
   */
  async scanOnce() {
    if (this.quotaLeft() <= 0) {
      if (this.alive()) this.scheduleNext();
      return;
    }

    this.scanning = true;
    var boss = null;
    try {
      boss = await this.requestBoss();
    } catch (err) {
      log.warn('request boss error.', err);
    } finally {
      this.scanning = false;
    }
    if (!this.alive()) return;

    if (boss) {
      // 回包 alive=1 且带 finishTime：记下在场截止，驱动后续排程（秒）
      this.liveUntil = boss.finishTime > 0 ? Math.floor(boss.finishTime / 1000) : this.liveUntil;
      try {
        await this.attackOnce(boss);
      } catch (err) {
        log.warn('attack flow threw.', err);
      }
    } else {
      // 无在场 BOSS（含 alive≠1）：清除在场标记，排程回到本地窗口表等下一刷新点
      this.liveUntil = 0;
      log.debug('no alive boss, wait next tick.');
    }

    if (this.alive()) this.scheduleNext();
  }

  /**
   * 查询当前战争之源 BOSS（9956，旧 JSON send，应答 data 为 JSON 串需 parse）。
   * 在场判定的权威信号是应答里的 `alive`（=1 才有可打 BOSS）：非窗口期/目标已消失时 alive 不为 1，
   * 据此拦住攻打（上一版只看 bossId 会在非窗口期拿到残留 id 误打被拒 csb_tips_012）。另需 reason<=0。
   * 每次消耗体力直接取应答 `costEnergy`（回包为准，普遍 5）；形态 type 仍从 BOSS 表读（应答无该字段）。
   * 永不 reject：闸门未放开 / 发送异常 / 无在场 BOSS 均回 null。
   * @returns {Promise<object|null>} {bossId,x,y,type,costEnergy,playerLevel,finishTime} 或 null
   */
  async requestBoss() {
    if (this.net.isSending(CMD_GET_BOSS_INFO_V2)) return null;

    var ret = await this.net.send(CMD_GET_BOSS_INFO_V2, {});
    if (!ret.ok) return null;

    // 旧 JSON 链路：ret.data 通常是 JSON 串（game 侧 JSON_PARSE(t.d)），兜底已解析对象
    var d = ret.data;
    if (typeof d === 'string') {
      try {
        d = JSON.parse(d);
      } catch (err) {
        return null;
      }
    }
    if (!d || !(d.bossId > 0)) return null;
    // 在场权威位：alive 非 1 即无可打 BOSS（含字段缺失，fail-closed）
    if (!(d.alive > 0)) {
      log.debug('boss not alive (alive=%s), skip. bossId=%d', d.alive, d.bossId);
      return null;
    }
    if (d.reason > 0) {
      log.debug('boss in KVK, banned. reason=%d', d.reason);
      return null;
    }

    // BOSS 表：仅取形态 type(0陆/1海/2空) 与 player_level；应答不带 type，取不到行无法选预设→不攻打
    var row = l10n.tableRow('BOSS', d.bossId);
    if (!row) {
      log.debug('boss row missing, skip. bossId=%d', d.bossId);
      return null;
    }

    // 体力消耗优先取应答 costEnergy（实证普遍 5），缺失/非法再退 BOSS 表、最后兜底 DEFAULT_COST_ENERGY
    var cost = Number(d.costEnergy);
    if (!(cost > 0)) cost = Number(row.cost_energy);
    if (!(cost > 0)) cost = DEFAULT_COST_ENERGY;

    return {
      bossId: d.bossId,
      x: d.x,
      y: d.y,
      type: row.type | 0,
      costEnergy: cost,
      playerLevel: Number(row.player_level) || 0,
      // 本波 BOSS 消失时刻（服务器毫秒），供排程：在场期间按 tick 慢扫、过 finishTime 再等下一窗口
      finishTime: Number(d.finishTime) || 0,
    };
  }

  /**
   * 判定一条攻打应答是否为「体力不足」拒绝。服务器拒绝码固定含义不唯一，以 data 命中的
   * 字典键为准（ENERGY_SHORT_KEYS 四键均=体力不足）。用子串匹配兼容 data 为裸键或被包裹两种形态。
   * @param {object} ret net.Ret（code≠0）
   * @returns {boolean}
   */
  isEnergyShort(ret) {
    var d = ret && ret.data;
    if (d == null) return false;
    var s = String(d);
    for (var i = 0; i < ENERGY_SHORT_KEYS.length; i++) {
      if (s.indexOf(ENERGY_SHORT_KEYS[i]) !== -1) return true;
    }
    return false;
  }

  /**
   * 攻打一波：战斗态闸门 → 剩余额度 → 形态预设（0 即该形态不攻打）→ 等级/体力/行军槽闸门 → 构造部队 → 派 902。永不 reject。
   * @param {object} boss {bossId,x,y,type,costEnergy,playerLevel}
   * @returns {Promise<void>}
   */
  async attackOnce(boss) {
    if (isCombat()) {
      log.debug('combat mode, skip attack (claim loop unaffected).');
      return;
    }
    if (this.quotaLeft() <= 0) {
      log.info('daily quota used up, skip attack.');
      return;
    }

    // 在场门禁已在 requestBoss 里以权威位 alive 完成（非在场根本不会传到这），无需再本地推窗口。

    var preset = boss.type >= 0 && boss.type < FORM_COUNT ? this.presets[boss.type] | 0 : 0;
    if (preset <= 0) {
      log.debug('form not configured, skip. bossId=%d;type=%d', boss.bossId, boss.type);
      return;
    }

    var u = (this.dc && this.dc.UserData) || {};

    // 等级门槛（不足游戏提示键 100270，这里只跳过等待升级）
    if ((u.Level | 0) < boss.playerLevel) {
      log.debug('level not enough, skip. level=%d<%d', u.Level | 0, boss.playerLevel);
      return;
    }

    // 体力门槛：不足游戏会弹购买面板（BuyEnergyPanel），脚本只放过等体力回满
    var energy;
    try {
      energy = (u.getEnergy(ENERGY_ACTION) || {}).Point || 0;
    } catch (err) {
      energy = 0;
    }
    if (energy < boss.costEnergy) {
      log.debug('energy not enough, skip. energy=%d<%d', energy, boss.costEnergy);
      return;
    }

    // 全局行军槽（core/march.canMarch，读 UserData）：无空位则本轮放过（在途行军会占位），下个 tick 再补
    if (!march.canMarch()) {
      log.debug('no free march slot, wait next tick.');
      return;
    }

    if (this.net.isSending(CMD_MARCH_WORLD_POINT)) return;

    // 预设部队 → 5 字段行军数据（armyListNew/heroList/trapList/formationV2/extraArmy），已按可派额度过滤
    var plan = new Battle().plan().preset(preset).adjust().build();
    if (!plan.armyListNew.length) {
      log.debug('preset %d has no dispatchable army, skip. bossId=%d', preset, boss.bossId);
      return;
    }

    var ret = await march.attack({
      marchType: MARCH_TYPE,
      target: { x: boss.x, y: boss.y },
      data: plan,
    });
    if (!this.alive()) return;

    if (ret.ok) {
      this.bumpDailyCount();
      log.info(
        'attack ok. bossId=%d;type=%d;preset=%d;left=%d;x=%d;y=%d',
        boss.bossId,
        boss.type,
        preset,
        this.quotaLeft(),
        boss.x,
        boss.y,
      );
    } else if (this.isEnergyShort(ret)) {
      // 服务器判定的体力不足（本地 getEnergy 值可能滞后）：放弃本轮，不扣当日额度，等体力回满后下个 tick 再试
      log.info(
        'energy insufficient (server), abandon this round. bossId=%d;code=%d;data=%s',
        boss.bossId,
        ret.code,
        ret.data,
      );
    } else {
      log.info(
        'attack rejected. bossId=%d;x=%d;y=%d;code=%d;data=%s',
        boss.bossId,
        boss.x,
        boss.y,
        ret.code,
        safeStringify(ret.data),
      );
    }
  }

  /**
   * 起攻打链：复位在场/在飞态 → 挂 march.onHomeReturn 到家唤醒 → 读回当日额度 → 首个 tick 立即跑（判位/攻打）。
   * @param {object} _ctx reactor 上下文（本链不消费）
   * @returns {Promise<void>}
   */
  async start(_ctx) {
    this.scanning = false;
    this.liveUntil = 0; // 清在场标记，首次扫描重新以 9956 回包 alive/finishTime 认定
    this.lastPushScanAt = 0;
    log.info('attack started, marchType=%d;dailyLimit=%d', MARCH_TYPE, DAILY_LIMIT);
    // BOSS 行军到家即补派下一次（全局单点 10019；先退再挂防 resume 重激活重复注册）
    if (this._offHomeReturn) this._offHomeReturn();
    this._offHomeReturn = march.onHomeReturn(this.onHomeArrived);
    await this.loadDaily();
    if (!this.alive()) return;
    if (this.quotaLeft() <= 0) {
      log.info(
        'daily attack quota already used up today (%d/%d), attack loop idle; rewards still claimed all day.',
        this.dailyState.count | 0,
        DAILY_LIMIT,
      );
    }
    // 首个 tick 立即跑一次（判位/攻打），之后由 scheduleNext 按窗口睡/慢扫
    this.scheduleNext(0);
  }
}
