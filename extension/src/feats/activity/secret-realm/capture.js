/**
 * 自动拍宠物引擎（异能秘境：已在拍宠物时的节奏接管）。
 *
 * 语义：**仅自动拍**——队伍已经在拍异能兽时，接管整个拍宠物节奏直到捕获成功/失败；
 *   不负责找怪、不派兵过去、不主动开拍。全部走游戏原生动作，零 INFO 扫描。
 *   **BOSS 也算「在拍宠物」**（21530 载荷带 boss:1）：BOSS 与普通异能兽同协议同 specId 集（报文实证
 *   dashcam 20261011T203911：41.4s 的 BOSS 窗内人手发了 {specId:1}×100 + 拖拽答案 + 能量拍，
 *   只差 allFavor 1000000 vs 7000~5000）→ 同一套节奏照拍，无需为 BOSS 分叉。
 *
 * 「在拍」判据（实战 dashcam 20261011T203911 后的修正）：`pab.capturingPetPos.x > 0`（见 constants
 *   PUSH_FEED_BEAST 实证）。**旧判据 `roomBaseInfo.marchState === NMarchState.PAB_FEED(21)` 恒假**：
 *   21521 BASE_INFO 全会话只 58 条（约 17s 一条），且实测整个拍宠物过程里 marchState 只有 1(MARCHING)/
 *   2(ARRIVED)、21 仅在 t+0.00 出现过一次 → 闸门把两条路一起卡死：心动时刻 0 响应、拍拍拍 0 发包
 *   （实证 (59,163) 在拍窗 484.58s→784.60s 共 300s、约 30 条 type=2 推送，只发了人手那 1 个包）。
 *   反向校验：该会话 83/83 条 type=2 心动时刻推送全部落在 21530 划出的 7 个在拍窗口内，零误报。
 *   `capturingInfo` **只作料源不作闸门**（7 个窗口里两个 BOSS 窗的起点没有带 feedInfo 的 21524，
 *   且残留的上一只 feedInfo 会满足 nowFavor>=allFavor）→ 缺时回 EMPTY_CAP，事件照旧走推送直达。
 *   另订 21530 只做记账（onFeedBeast：换宠时清掉上一只残留的静默窗 + 打 info 对账），闸门仍每拍现读现场值。
 *
 * 节奏（源码 verbatim：RealPabController / PetCaptureTouchNodeNew / PetCaptureDragNodeNew / PabPetFeedEventPopup
 *   + 报文实证 dashcam 20261004T202430、20261011T195811、20261011T203911）：
 *   事件类动作有**两个到达通道**，推送优先、轮询兜底：
 *     push 21527 ENIGMA_SECRET_ROOM_BEAST_EVENT 载荷 `{type, specId[], endTime, points[]}` —— 游戏**不把它写进
 *       capturingInfo**（实证 RealPabController：capturingInfo 只在 21524 updateRoomPointFightingPVEInfo 与 8546
 *       应答回调两处被赋 feedInfo，而 feedInfo 里根本没有 eventType/eventEndTime）→ 只读 capturingInfo 必然
 *       晚一拍且无事件身份可用，而心动时刻窗口实测 3.2~3.4s → 直接订阅 21527，到达即发。
 *   每拍按优先级只做一个动作：
 *     ① 限时事件（轮询兜底路）**排在静默窗之前**。实证：能量爆发演出要 6.4~10.2s，而心动时刻只有 3.2s，
 *        旧实现「静默窗内一律放弃」会把整窗事件全吞掉（且限时事件只受 UI 层屏蔽，checkCaptureOperationCd
 *        仅管 specId==1，直达服务器的拖拽应答实测被接受）。
 *     ② 静默窗口内（能量爆发演出中）→ 睡到窗口结束。实证：specId=4 之后 6.4~10.2s 无下一拍
 *        （游戏侧 behave[4].time 持续演出 + PetCaptureTouchNodeNew 6s energyMaxProtectNode 保护）。
 *     ③ `selfenergy >= 3` → `petCaptureOperation(4)`：**高分值持续拍**。报文 14/14 次能量周期完全复现
 *        changeScore=390（普通拍仅 6~11），且能量归 0 —— 即「凑够 3 次小节奏触发一段时间高分值持续的拍」。
 *     ④ 推送直达（不占本拍优先级）：onBeastEvent 收到 21527 type=2/5 即发，心动时刻等不起下一拍。
 *     ⑤ 兜底：免费手拍 `petCaptureOperation(1)`（无消耗，报文主流量 6~11 分/拍，人手连点中位 222ms）。
 *        仅 specId=1 受客户端每秒限额约束（实证 checkCaptureOperationCd 首行 `!(1!=e||…)`，
 *        限额 = Number(dataConfig(630027))/秒，超限游戏静默丢弃不发包）→ 本引擎自计同一份秒账，超配额即等下一秒。
 *
 * 事件去重：④ 以 `type + ':' + endTime(毫秒)` 为身份存入 #handled 集，处理过一次即不再重发。
 *   **不在事件字段归 0 时清身份**：身份含 endTime，服务器给新事件必然给新 endTime（实证该会话每条 type=2 的
 *   endTime 均不同），清了反而会把刚处理过的那条同 endTime 事件再发一次；集半满那么按插入序丢弃最旧一条。
 *   ① 的轮询兜底只在**推送通道失联**（tuning.pushAliveMs 内一条 21527 都没来过）时启用，并用自持的 #pollSig
 *   防逐拍重发——因为 feedInfo.eventSpecId 会在同一值上连续挂十几秒，拿它做 #handled 身份会漏、不做身份会重发。
 *
 * 不做的事：不主动投喂 enigma_beast_behave 行 5/6 的道具（报文实证其分值与免费手拍同量级，却要消耗秘境背包道具）。
 *
 * 只读+发包红线：只调游戏原生 petCaptureOperation，不碰 Update/Delete，不镜像本地态（capturingInfo /
 *   capturingPetPos 均由游戏自己的推送与应答刷新，本引擎逐拍现读）。
 */
import { createCycle } from '../../../core/cycle.js';
import {
  SPEC_TAP,
  SPEC_ENERGY_USE,
  ENERGY_MAX,
  EVT_TYPE_DRAG,
  EVT_TYPE_FEED_POP,
  CFG_TAP_LIMIT_PER_SEC,
  PUSH_BEAST_EVENT,
  PUSH_FEED_BEAST,
  TABLE_BEAST_BEHAVE,
  tuning,
} from './constants.js';

/**
 * 已处理事件身份的保留条数（超出按插入序丢弃最旧，防长会话无界增长）。
 * @type {number}
 */
const HANDLED_MAX = 32;

/**
 * 在拍但游戏尚未下发 feedInfo 时的空样本（只读不回写；实证窗口起点不保证带 feedInfo）。
 * @type {object}
 */
const EMPTY_CAP = {};

/**
 * protobuf Long / {_low,_high} / number / 字符串 → 数值（取不到回 0）。
 * 时间字段解出来是毫秒，计数字段（selfenergy/nowFavor/allFavor）解出来是原值。
 * @param {*} v 数值字段原值
 * @returns {number}
 */
function toNum(v) {
  if (v == null) return 0;
  if (typeof v === 'object') {
    try {
      if (typeof v.toNumber === 'function') return Number(v.toNumber()) || 0;
    } catch (e) {
      /* 降级走 _low/_high 手算 */
    }
    const hi = Number(v._high);
    const lo = Number(v._low);
    if (Number.isFinite(hi) || Number.isFinite(lo)) {
      return (Number.isFinite(hi) ? hi : 0) * 4294967296 + (Number.isFinite(lo) ? lo >>> 0 : 0);
    }
    return 0;
  }
  return Number(v) || 0;
}

/**
 * 拍宠物引擎：单条 createCycle 电平循环，每拍按优先级执行节奏里的一个动作。
 */
export class CaptureEngine {
  #env;
  /** @type {{kick:Function, pending:boolean}|null} */
  #cycle = null;
  /** @type {boolean} 引擎存活位：stop() 置 false 后旧 cycle 的定时器到点即自然终止（pause 时 cycle 多处于睡眠、arm 的定时器不会被撤，只清引用拦不住 resume 后的孤儿循环） */
  #active = false;
  /** @type {number} 手拍秒账所属秒（与游戏 checkCaptureOperationCd 的 _touchOperateLastTime 同口径） */
  #tapSec = 0;
  /** @type {number} 当前秒内已发手拍次数 */
  #tapCount = 0;
  /** @type {Set<string>} 已响应过的捕获事件身份（`type:endTimeMs`），推送路专用，防同一事件重发 */
  #handled = new Set();
  /** @type {number} 静默窗口到期时间戳（Date.now 口径；能量爆发演出期间不发兜底拍） */
  #quietUntil = 0;
  /** @type {number} 最近一次收到 21527 推送的时刻（Date.now 口径；0=从未收到，轮询兜底据此决定退不退场） */
  #lastPushAt = 0;
  /** @type {string} 上一次轮询兜底处理过的 eventSpecId 候选串（同一候选只补发一次，防挂十几秒期间逐拍重发） */
  #pollSig = '';
  /** @type {string} 上一次 21530 报的在拍目标（`x,y[ boss]`，''=不在拍），仅用于识别换宠/收尾 */
  #petKey = '';

  /** @param {object} env 注入底座 {alive, realmActive, cfg, secret, gameData, gameConf, l10n, log} */
  constructor(env) {
    this.#env = env;
  }

  /**
   * 一拍：判定在拍后按优先级（限时事件兜底→静默窗→能量爆发→免费手拍）执行一个动作。永不 reject。
   * @returns {number} 下拍间隔（毫秒）
   */
  #tick() {
    const env = this.#env;
    if (!env.alive()) return 0;
    if (!env.realmActive()) return tuning.feedIdleMs;

    const pab = env.secret.getPabController();
    if (!pab) return tuning.feedIdleMs;

    const st = this.#feedState(pab);
    if (!st) return tuning.feedIdleMs; // 不在拍（未开拍/在行军/已结束）→ 长睡
    const cap = st.cap;

    // ① 限时事件的轮询兜底：排在静默窗之前，且只在推送通道失联时启用（能量演出 7s 窗 > 心动时刻 3.2s 窗）
    if (!this.#pushAlive()) {
      const es = Array.isArray(cap.eventSpecId) ? cap.eventSpecId : [];
      if (!es.length) this.#pollSig = '';
      else if (this.#pollEvent(es, pab)) return tuning.tapIntervalMs;
    }

    // ② 静默窗口：能量爆发演出期间游戏侧禁输入兜底拍，睡到窗口结束
    const now = Date.now();
    if (now < this.#quietUntil) return this.#quietUntil - now;

    // ③ 能量满 → 高分值持续拍（390 分/拍，报文 14/14 复现）
    if (toNum(cap.selfenergy) >= ENERGY_MAX) return this.#useEnergy(pab);

    // ⑤ 免费手拍打底（受每秒限额闸门约束）
    if (!this.#tapBudget()) return tuning.tapIntervalMs * 2; // 本秒配额用尽 → 稍等再复检
    this.#op(pab, SPEC_TAP, null);
    return tuning.tapIntervalMs;
  }

  /**
   * 在拍取样：游戏现场的 `capturingPetPos` 已置位（push 21530，结束推 {x:-1,y:-1}）时回 {cap}，否则 null。
   * 推送入口（心动时刻）与轮询入口共用这份闸门，保证两条路对「能不能拍」的判断一字不差。
   * **不拿 capturingInfo 做闸门**：窗口起点不保证有 feedInfo 下发（实证 7 个窗口里两个 BOSS 窗口的起点没有），
   *   而 capturingInfo 可能还是上一只的残留（nowFavor>=allFavor）→ 拿它当在位/未喂满判据会把新宠锁死。
   *   收尾另有权威：21530 的 {x:-1,y:-1}（实证 6 个已收窗全有）。
   * @param {object} pab PabController 实例
   * @returns {{cap:object}|null} 在拍回 {cap}（cap 恒为对象，缺 feedInfo 时是 EMPTY_CAP），不在拍回 null
   */
  #feedState(pab) {
    const pos = pab.capturingPetPos;
    const x = Number(pos && pos.x);
    const y = Number(pos && pos.y);
    if (!(x > 0) || !(y > 0)) return null; // 未置位 / 服务器已推 {x:-1,y:-1} 收尾 = 不在拍
    const cap = pab.capturingInfo;
    return { cap: cap && typeof cap === 'object' ? cap : EMPTY_CAP };
  }

  /**
   * 推送通道存活判定：窗内收到过任何一条 21527（含我们不响应的 type=3）就算活着。
   * @returns {boolean} true=通道活着，事件交推送直达，轮询兜底退场
   */
  #pushAlive() {
    return Date.now() - this.#lastPushAt < tuning.pushAliveMs;
  }

  /**
   * 在拍目标变化（push 21530）：只做两件轻事——换宠时清掉上一只残留的静默窗/轮询签名（旧实现会把新宠首拍
   *   压到能量演出窗结束后），并打一条 info 供实录对账。**在拍闸门不依赖它**（每拍现读 pab.capturingPetPos），
   *   所以这条推送丢了也不影响发包。
   * @param {object} ev bus `net.21530` 事件（载荷 {x,y[,boss]}，结束 {x:-1,y:-1}）
   */
  onFeedBeast(ev) {
    const env = this.#env;
    if (!env.alive()) return;
    const outer = (ev && ev.data) || {};
    const inner = outer.data || outer;
    const x = Number(inner.x);
    const y = Number(inner.y);
    const key = x > 0 && y > 0 ? x + ',' + y + (Number(inner.boss) === 1 ? ' boss' : '') : '';
    if (key === this.#petKey) return;
    this.#petKey = key;
    if (!key) {
      env.log.info('capture: feeding ended.');
      return;
    }
    this.#quietUntil = 0;
    this.#pollSig = '';
    env.log.info('capture: feeding %s.', key);
  }

  /**
   * 捕获事件推送入口（push 21527，载荷 `{type, specId[], endTime, points[]}`）：心动时刻窗口实测 3.2s，
   * 等不起下一拍的 capturingInfo 回写，所以到达即发。退订由 reactor 托管（ctx.on.push）。
   * @param {object} ev bus `net.21527` 事件（Event 实例：data 里再包一层业务载荷）
   */
  onBeastEvent(ev) {
    const env = this.#env;
    if (!env.alive() || !env.realmActive()) return;
    const outer = (ev && ev.data) || {};
    const inner = outer.data || outer;
    this.#lastPushAt = Date.now(); // 任何一条 21527 都证明通道活着 → 轮询兜底退场（防双发）
    const et = Number(inner.type) || 0;
    if (et !== EVT_TYPE_DRAG && et !== EVT_TYPE_FEED_POP) return; // 3=能量爆发演出，交 ③ 的 selfenergy 闸
    const es = Array.isArray(inner.specId) ? inner.specId : [];
    if (!es.length) return;
    const pab = env.secret.getPabController();
    if (!pab) return;
    if (!this.#feedState(pab)) {
      env.log.debug(
        'capture push type=%d dropped: capturingPetPos=%s (not feeding).',
        et,
        JSON.stringify(pab.capturingPetPos),
      );
      return;
    }
    this.#tryEvent(et, es, toNum(inner.endTime), 'beast push', pab);
  }

  /**
   * 轮询兜底（仅推送通道失联时走）：capturingInfo 里唯一可用的事件字段是 `eventSpecId`（无 type/endTime），
   * 单项即拖拽事件（specId 本身就是答案），多项按投喂弹窗择优；同一候选串只补发一次。
   * @param {Array<number|string>} es cap.eventSpecId 候选
   * @param {object} pab PabController 实例
   * @returns {boolean} true=这次发出了事件动作
   */
  #pollEvent(es, pab) {
    const sig = es.join(',');
    if (this.#pollSig === sig) return false; // eventSpecId 会挂十几秒，同一候选不逐拍重发
    this.#pollSig = sig;
    const spec = es.length === 1 ? Number(es[0]) || 0 : this.#bestPopSpec(es);
    if (!spec) return false;
    this.#op(pab, spec, 'poll fallback eventSpecId=[' + sig + '] (beast push silent)');
    return true;
  }

  /**
   * 捕获事件动作的推送出口（以 `type:endTime` 去重）。
   * **不受静默窗约束**：能量爆发演出 6.4~10.2s，而心动时刻只有 3.2s，在静默窗内放弃等于必丢。
   * @param {number} et 事件类型（2 心动时刻 / 5 投喂弹窗）
   * @param {Array<number|string>} es 事件候选 specId
   * @param {number} endMs 窗口结束时刻（毫秒，兼作身份一部分）
   * @param {string} from 来源标注（debug 用）
   * @param {object} pab PabController 实例
   * @returns {boolean} true=这次发出了事件动作
   */
  #tryEvent(et, es, endMs, from, pab) {
    const key = et + ':' + endMs;
    if (this.#handled.has(key)) return false;
    const spec = et === EVT_TYPE_DRAG ? Number(es[0]) || 0 : this.#bestPopSpec(es);
    if (!spec) return false;
    if (this.#handled.size >= HANDLED_MAX)
      this.#handled.delete(this.#handled.values().next().value);
    this.#handled.add(key);
    this.#op(
      pab,
      spec,
      from + ' type=' + et + (et === EVT_TYPE_DRAG ? ' (energy +1)' : ' (pick best favor)'),
    );
    return true;
  }

  /**
   * 能量满释放：发 specId=4，并按 behave[4].time（秒）设静默窗口（读不到用兜底 7s，报文实证 6.4~10.2s）。
   * @param {object} pab PabController 实例
   * @returns {number} 下拍间隔（毫秒）= 静默窗口长度
   */
  #useEnergy(pab) {
    const env = this.#env;
    const row = env.l10n.tableRow(TABLE_BEAST_BEHAVE, SPEC_ENERGY_USE);
    const durSec = row ? Number(row.time) || 0 : 0;
    const quietMs = durSec > 0 ? durSec * 1000 + 500 : tuning.energyBurstFallbackMs;
    this.#op(pab, SPEC_ENERGY_USE, 'energy burst (high-score phase)');
    this.#quietUntil = Date.now() + quietMs;
    return quietMs;
  }

  /**
   * 弹窗择优：在 eventSpecId 候选里挑 enigma_beast_behave `.favor`（"min|max"）上限最高的一项。
   * 全部读不到 favor 时回候选首项（至少不错过这次事件）。
   * @param {Array<number|string>} es 候选 specId 数组
   * @returns {number} 目标 specId
   */
  #bestPopSpec(es) {
    const env = this.#env;
    let best = Number(es[0]) || 0;
    let bestHi = -1;
    for (let i = 0; i < es.length; i++) {
      const id = Number(es[i]) || 0;
      if (!id) continue;
      const row = env.l10n.tableRow(TABLE_BEAST_BEHAVE, id);
      const parts = String((row && row.favor) || '').split('|');
      const hi = Number(parts[1] != null ? parts[1] : parts[0]) || 0;
      if (hi > bestHi) {
        bestHi = hi;
        best = id;
      }
    }
    return best;
  }

  /**
   * 手拍每秒配额账（与游戏 checkCaptureOperationCd 同语义：同一 ServerTime 秒内累计，超限即不再发）。
   * @returns {boolean} true=还有配额（并已占一格）
   */
  #tapBudget() {
    const env = this.#env;
    const sec = env.gameData.serverTime() | 0 || Math.floor(Date.now() / 1000);
    if (sec !== this.#tapSec) {
      this.#tapSec = sec;
      this.#tapCount = 0;
    }
    let limit = Number(env.gameConf.dataConfig(CFG_TAP_LIMIT_PER_SEC)) || 0;
    if (limit <= 0) limit = tuning.tapMaxPerSecFallback;
    if (this.#tapCount >= limit) return false;
    this.#tapCount++;
    return true;
  }

  /**
   * 发一拍（游戏原生动作：内部含 CD 判定 + BEAST_OPERATE 发包 + capturingInfo 回写）。
   * @param {object} pab PabController 实例
   * @param {number} specId 动作 specId
   * @param {string|null} why 非兜底动作的原因标注（打 debug 用）
   */
  #op(pab, specId, why) {
    const env = this.#env;
    if (!specId) return;
    try {
      pab.petCaptureOperation(specId);
      if (why) env.log.debug('capture: %s → specId=%d.', why, specId);
    } catch (e) {
      env.log.warn('capture: petCaptureOperation(%d) threw.', specId, e);
    }
  }

  /**
   * 启动：登记 21527 捕获事件推送 + 21530 在拍目标推送（仅记账）+ 建循环并点火。
   *   reactor 每次激活调一次（run() 前先 stopEngines() 收旧引擎，
   *   旧循环已被 #active 判死）。
   * @param {object} ctx reactor 上下文（提供 on.push；缺省时退回纯轮询兜底）
   */
  start(ctx) {
    const env = this.#env;
    const self = this;
    this.#quietUntil = 0;
    this.#handled.clear();
    this.#tapCount = 0;
    this.#pollSig = '';
    this.#petKey = '';
    this.#active = true;
    if (ctx && ctx.on && typeof ctx.on.push === 'function') {
      this.#lastPushAt = Date.now(); // 先给一个存活窗，避免开局第一拍就走兜底路
      ctx.on.push(PUSH_BEAST_EVENT, function (ev) {
        self.onBeastEvent(ev);
      });
      ctx.on.push(PUSH_FEED_BEAST, function (ev) {
        self.onFeedBeast(ev);
      });
    } else {
      this.#lastPushAt = 0; // 无推送通道 → #pushAlive() 恒假，轮询兜底立即接管
      env.log.warn(
        'beast event push unsubscribed (ctx.on.push unavailable), events fall back to capturingInfo poll.',
      );
    }
    this.#cycle = createCycle({
      log: env.log,
      alive: function () {
        return self.#active && env.alive();
      },
      run: function () {
        return self.#tick();
      },
      fallback: tuning.feedIdleMs,
    });
    this.#cycle.kick();
    env.log.info('capture engine started (tap/energy/event rhythm).');
  }

  /** 停止：置死 #active——cycle 睡眠期间的定时器不会被撤，靠引擎自带存活位在到点/重排两道 alive 检查处终止（防 pause→resume 后孤儿循环与新引擎并发）。 */
  stop() {
    this.#active = false;
    this.#cycle = null;
  }
}
