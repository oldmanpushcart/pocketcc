/**
 * 自动拍宠物引擎（异能秘境 FEED 态节奏接管）。
 *
 * 语义：**仅自动拍**——队伍已停在异能兽点、已处于 FEED 态、capturingInfo 已存在时，接管整个拍宠物节奏
 *   直到捕获成功/失败；不负责找怪、不派兵过去、不主动开拍。全部走游戏原生动作，零 INFO 扫描。
 *
 * 节奏（源码 verbatim：RealPabController / PetCaptureTouchNodeNew / PetCaptureDragNodeNew / PabPetFeedEventPopup
 *   + 报文实证 dashcam 20261004T202430-异能秘境-我是队长-发车，1517 条 8546 应答）：
 *   每拍按优先级只做一个动作：
 *     ① 静默窗口内（能量爆发演出中）→ 睡到窗口结束。实证：specId=4 之后 6.4~10.2s 无下一拍
 *        （游戏侧 behave[4].time 持续演出 + PetCaptureTouchNodeNew 6s energyMaxProtectNode 保护）。
 *     ② `selfenergy >= 3` → `petCaptureOperation(4)`：**高分值持续拍**。报文 14/14 次能量周期完全复现
 *        changeScore=390（普通拍仅 6~11），且能量归 0 —— 即「凑够 3 次小节奏触发一段时间高分值持续的拍」。
 *     ③ `eventType==2`（拖拽事件，窗口 2s）→ `petCaptureOperation(eventSpecId[0])`：报文实证该拍
 *        changeScore=0 但 **selfenergy +1**，是攒能量（进而触发 ②）的主要来源。
 *     ④ `eventType==5`（投喂弹窗，选项 = eventSpecId 数组，即 enigma_beast_behave 行 7..10）→
 *        选 `favor`（"min|max"）上限最高的一项发过去：报文实证 changeScore 260 / 650 两档，择优即多拿分。
 *     ⑤ 兜底：免费手拍 `petCaptureOperation(1)`（无消耗，报文主流量 6~11 分/拍，人手连点中位 222ms）。
 *        仅 specId=1 受客户端每秒限额约束（实证 checkCaptureOperationCd 首行 `!(1!=e||…)`，
 *        限额 = Number(dataConfig(630027))/秒，超限游戏静默丢弃不发包）→ 本引擎自计同一份秒账，超配额即等下一秒。
 *
 * 事件去重：③④ 以 `eventType + ':' + eventEndTime(毫秒)` 为身份，处理过一次即不再重复发（防游戏侧
 *   eventType 残留导致逐拍重发同一事件）；eventType 归 0 时清身份，下一个新事件重新计。
 *
 * 不做的事：不主动投喂 enigma_beast_behave 行 5/6 的道具（报文实证其分值与免费手拍同量级，却要消耗秘境背包道具）。
 *
 * 只读+发包红线：只调游戏原生 petCaptureOperation，不碰 Update/Delete，不镜像本地态（capturingInfo 由游戏应答刷新）。
 */
import { createCycle } from '../../../core/cycle.js';
import {
  SPEC_TAP,
  SPEC_ENERGY_USE,
  ENERGY_MAX,
  EVT_TYPE_DRAG,
  EVT_TYPE_FEED_POP,
  CFG_TAP_LIMIT_PER_SEC,
  TABLE_BEAST_BEHAVE,
  tuning,
} from './constants.js';

/**
 * protobuf Long / {_low,_high} / number / 字符串 → 毫秒数值（取不到回 0）。
 * @param {*} v 时间字段原值
 * @returns {number} 毫秒
 */
function toMs(v) {
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
  /** @type {string} 已处理过的捕获事件身份（`eventType:eventEndTimeMs`），防同一事件逐拍重发 */
  #handledEvent = '';
  /** @type {number} 静默窗口到期时间戳（Date.now 口径；能量爆发演出期间不发包） */
  #quietUntil = 0;

  /** @param {object} env 注入底座 {alive, realmActive, cfg, secret, gameData, gameConf, l10n, log} */
  constructor(env) {
    this.#env = env;
  }

  /**
   * 一拍：判定 FEED 态后按优先级（静默→能量爆发→拖拽事件→弹窗择优→免费手拍）执行一个动作。永不 reject。
   * @returns {number} 下拍间隔（毫秒）
   */
  #tick() {
    const env = this.#env;
    if (!env.alive()) return 0;
    if (!env.realmActive() || !env.cfg().autoCapture) return tuning.feedIdleMs;

    const S = env.secret.getNMarchState();
    const pab = env.secret.getPabController();
    if (!S || !pab || S.PAB_FEED == null) return tuning.feedIdleMs;

    const base = pab.roomBaseInfo;
    const ms = base && base.marchState;
    if (ms !== S.PAB_FEED) return tuning.feedIdleMs; // 未到 FEED（未开拍/在行军/战斗）→ 长睡

    const cap = pab.capturingInfo;
    if (!cap) return tuning.feedIdleMs; // FEED 但尚未下发 capturingInfo（罕见）→ 短等复检
    const nowFavor = Number(cap.nowFavor) || 0;
    const allFavor = Number(cap.allFavor) || 0;
    if (allFavor > 0 && nowFavor >= allFavor) return tuning.feedIdleMs; // 已喂满 → 交游戏收尾

    // ① 静默窗口：能量爆发演出期间游戏侧禁输入，睡到窗口结束
    const now = Date.now();
    if (now < this.#quietUntil) return this.#quietUntil - now;

    // ② 能量满 → 高分值持续拍（390 分/拍，报文 14/14 复现）
    if ((Number(cap.selfenergy) || 0) >= ENERGY_MAX) return this.#useEnergy(pab);

    // ③④ 捕获事件（拖拽 / 投喂弹窗）：优先于普通手拍，且同一事件只发一次
    const et = Number(cap.eventType) || 0;
    const es = Array.isArray(cap.eventSpecId) ? cap.eventSpecId : [];
    if (!et) {
      this.#handledEvent = '';
    } else if (es.length) {
      const key = et + ':' + toMs(cap.eventEndTime);
      if (key !== this.#handledEvent) {
        if (et === EVT_TYPE_DRAG) {
          this.#handledEvent = key;
          this.#op(pab, Number(es[0]), 'drag event (energy +1)');
          return tuning.tapIntervalMs;
        }
        if (et === EVT_TYPE_FEED_POP) {
          const best = this.#bestPopSpec(es);
          this.#handledEvent = key;
          this.#op(pab, best, 'feed popup (pick best favor)');
          return tuning.tapIntervalMs;
        }
      }
    }

    // ⑤ 免费手拍打底（受每秒限额闸门约束）
    if (!this.#tapBudget()) return tuning.tapIntervalMs * 2; // 本秒配额用尽 → 稍等再复检
    this.#op(pab, SPEC_TAP, null);
    return tuning.tapIntervalMs;
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
   * 启动：建循环并点火。reactor 每次激活调一次（run() 前先 stopEngines() 收旧引擎，旧循环已被 #active 判死）。
   */
  start() {
    const env = this.#env;
    const self = this;
    this.#quietUntil = 0;
    this.#handledEvent = '';
    this.#tapCount = 0;
    this.#active = true;
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
