/**
 * 自动拍宠物引擎（异能秘境：已在拍宠物时的节奏接管）。
 *
 * 语义：**仅自动拍**——队伍已经在拍异能兽时，接管整个拍宠物节奏直到捕获成功/失败；
 *   不负责找怪、不派兵过去、不主动开拍，全部走游戏原生动作，零 INFO 扫描。
 *   **BOSS 也算「在拍宠物」**（21530 载荷带 boss:1）：BOSS 与普通异能兽同协议同 specId 集，
 *   只差 allFavor（大BOSS 1000000 vs 普通宠 7000~5000）→ 同一套节奏照拍，不为 BOSS 分叉。
 *
 * 「在拍」判据：`pab.capturingPetPos.x > 0`（push 21530 PUSH_FEED_BEAST，见 constants）。
 *   `roomBaseInfo.marchState === NMarchState.PAB_FEED(21)` **不能当闸**：21521 约 17s 才一条，
 *   且拍宠全程 marchState 只有 1(MARCHING)/2(ARRIVED) → 靠它会卡死全部三条路。
 *   反向校验：type=2 拖拽推送全部落在 21530 划出的在拍窗口内，零误报。
 *   `capturingInfo` **只作料源不作闸门**（BOSS 窗起点不一定带 feedInfo，且残留的上一只 feedInfo 会满足
 *   nowFavor>=allFavor）→ 缺时回 EMPTY_CAP，事件照旧走推送直达。
 *   另订 21530 只做记账（onFeedBeast：换宠清残留静默窗 + 打 info 对账），闸门每拍现读现场值。
 *
 * 节奏（源码：RealPabController / PetCaptureTouchNodeNew / PetCaptureDragNodeNew / PabPetFeedEventPopup）：
 *   事件类动作有**两个到达通道**，推送优先、轮询兜底：
 *     push 21527 ENIGMA_SECRET_ROOM_BEAST_EVENT 载荷 `{type, specId[], endTime, points[]}`。游戏**不把它写进
 *       capturingInfo**（feedInfo 里没有 eventType/eventEndTime）→ 只读 capturingInfo 必然晚一拍且无事件身份可用，
 *       而拖拽窗口只有 2.0s → 直接订阅 21527，到达即发。
 *   每拍按优先级只做一个动作：
 *     ① 限时事件（轮询兜底路）**排在静默窗之前**：能量爆发演出要 6.4~10.2s 而拖拽窗只有 2.0s，
 *        静默窗内一律放弃会吞掉整窗事件；限时事件只受 UI 层屏蔽（checkCaptureOperationCd 仅管 specId==1），
 *        直达服务器的拖拽应答会被接受。
 *     ② 静默窗口内（能量爆发演出中）→ 睡到窗口结束（behave[4].time 持续演出 + energyMaxProtectNode 6s 保护）。
 *     ③ `selfenergy >= 3` → `petCaptureOperation(4)`：**高分值持续拍**（能量周期内 changeScore=390，普通拍仅
 *        6~11，且能量归 0）——即「凑够 3 次小节奏触发一段时间高分值持续的拍」。
 *     ④ 推送直达（不占本拍优先级）：onBeastEvent 收到 21527 type=2/5 即发，拖拽 2.0s 窗等不起下一拍；
 *        心动时刻（type=5 投喂弹窗）投完还要**立刻关掉游戏弹窗**——不关则它会按自己的倒数归零再替玩家
 *        随机投一票（见 #closeFeedPop 注）。
 *     ⑤ 兜底：免费手拍 `petCaptureOperation(1)`（无消耗，6~11 分/拍，人手连点中位 222ms）。
 *        仅 specId=1 受客户端每秒限额约束（`checkCaptureOperationCd` 首行 `!(1!=e||…)`，限额 =
 *        Number(dataConfig(630027))/秒，超限游戏静默丢弃不发包）→ 本引擎自计同一份秒账，超配额即等下一秒。
 *
 * 事件去重：④ 以 `type + ':' + endTime(毫秒)` 为身份存入 #handled 集，处理过一次即不再重发（心动时刻命中去重时
 *   仍会再收一次窗，防重复下发把弹窗又开了一遍）。**不在事件字段归 0 时清身份**：身份含 endTime，服务器给新事件
 *   必然给新 endTime，清了反而会把刚处理过的那条同 endTime 事件再发一次；集半满时按插入序丢弃最旧一条。
 *   ① 的轮询兜底只在**推送通道失联**（tuning.pushAliveMs 内一条 21527 都没来过）时启用，并用自持的 #pollSig
 *   防逐拍重发——feedInfo.eventSpecId 会在同一值上连续挂十几秒，拿它做 #handled 身份会漏、不做身份会重发。
 *
 * 大BOSS 环节的投喂（BOSS_AUTO.feed 恒开、无面板开关；必选环节）：`capturingPetPos.boss===1` 时才投，选物与发包
 *   完全照游戏自己的链路（见 #feedBossItem）——手拍 changeScore 只有 6~11，而大BOSS 要 allFavor=1000000，
 *   不投道具根本拍不动。普通异能兽窗不投（7000~5000 分靠手拍+能量拍就能填，白耗道具）。
 *   `boss===1` 是**精确**闸而非近似：只有大BOSS 窗带这个字段（窗内 allFavor 恒为 1000000），高分普通宠也不带
 *   （protobuf 缺省即 0）→ 不会把道具错投给普通宠或小BOSS。
 *
 * 只读+发包红线：只调游戏原生 petCaptureOperation，另多一个原生收窗动作（UIManager.CloseUI，与面板自己
 *   close() 同源、只销毁窗口实例，不碰 Update/Delete、不镜像本地态——capturingInfo / capturingPetPos
 *   均由游戏自己的推送与应答刷新，本引擎逐拍现读）。不走 UI 层驱动（`cc.find` 节点路径、写
 *   `_touchProgressAdd`、直调 onTouchBegin/dragTargetSuccess/onItemFeedClick 会改写本地态且随改版失效）；
 *   投喂判据取「有道具就投、投首个可用的」，发包走协议层。
 */
import { createCycle } from '../../../core/cycle.js';
import { bits } from '../../../core/game-api.js';
import {
  SPEC_TAP,
  SPEC_ENERGY_USE,
  SPEC_FEED_FIRST,
  SPEC_FEED_COUNT,
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
 * 在拍但游戏尚未下发 feedInfo 时的空样本（只读不回写；窗口起点不保证带 feedInfo）。
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
  return bits.int64ToNum(v);
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
  /** @type {number} 下一次允许投喂道具的时刻（Date.now；兼作「没货时也别逐拍翻表」的轻退避） */
  #nextFeedAt = 0;
  /** @type {boolean} 本只宠已就「两个投喂格都没货」打过 info（换宠/重新开始才重置，防刷屏） */
  #toldNoFeed = false;
  /** @type {number} 最近一次观测到「在拍」的时刻（Date.now；不在拍边沿 info 用它算 idle 时长） */
  #lastFeedAt = 0;
  /** @type {boolean} 本轮「不在拍」已打过 info（重新在拍后复位，保证只在进入不拍的边沿打一条） */
  #notFeedLogged = false;
  /** @type {boolean} 本次静默窗已打过 debug（同窗内不重复，出窗复位） */
  #quietLogged = false;
  /** @type {number} 上一次打「手拍配额耗尽」debug 的秒（同一秒只打一条，防刷屏） */
  #quotaToldSec = 0;

  /** @param {object} env 注入底座 {alive, realmActive, cfg, secret, gameData, gameConf, l10n, ui, log} */
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
    if (!st) {
      // 不在拍（未开拍/在行军/已结束）：只在进入不拍的边沿打一条 info，pass 侧由 onFeedBeast 的在拍 info 承担。
      if (!this.#notFeedLogged) {
        this.#notFeedLogged = true;
        const idle = this.#lastFeedAt ? Date.now() - this.#lastFeedAt : 0;
        env.log.info(
          'capture: not feeding (capturingPetPos=%s), idle %dms.',
          JSON.stringify(pab.capturingPetPos),
          idle,
        );
      }
      return tuning.feedIdleMs; // 长睡
    }
    this.#notFeedLogged = false;
    this.#lastFeedAt = Date.now();
    const cap = st.cap;

    // ① 限时事件的轮询兜底：排在静默窗之前，且只在推送通道失联时启用（能量演出 7s 窗 > 拖拽 2.0s 窗）
    if (!this.#pushAlive()) {
      const es = Array.isArray(cap.eventSpecId) ? cap.eventSpecId : [];
      if (!es.length) this.#pollSig = '';
      else if (this.#pollEvent(es, pab)) return tuning.tapIntervalMs;
    }

    // ② 静默窗口：能量爆发演出期间游戏侧禁输入兜底拍，睡到窗口结束（首次命中打一条 debug，同窗不重复）
    const now = Date.now();
    if (now < this.#quietUntil) {
      if (!this.#quietLogged) {
        this.#quietLogged = true;
        env.log.debug('capture: quiet until +%dms (energy burst).', this.#quietUntil - now);
      }
      return this.#quietUntil - now;
    }
    this.#quietLogged = false;

    // ③ 能量满 → 高分值持续拍（390 分/拍，报文 14/14 复现）
    if (toNum(cap.selfenergy) >= ENERGY_MAX) return this.#useEnergy(pab);

    // ③′ 大BOSS 窗的投喂道具（BOSS_AUTO.feed 恒开，无面板开关）：排在手拍之前，投完照常回正常节拍继续拍
    if (st.boss) {
      const bb = env.cfg().boss;
      if (bb && bb.feed && this.#feedBossItem(pab)) return tuning.tapIntervalMs;
    }

    // ⑤ 免费手拍打底（受每秒限额闸门约束）
    if (!this.#tapBudget()) return tuning.tapIntervalMs * 2; // 本秒配额用尽 → 稍等再复检
    this.#op(pab, SPEC_TAP, null);
    return tuning.tapIntervalMs;
  }

  /**
   * 在拍取样：游戏现场的 `capturingPetPos` 已置位（push 21530，结束推 {x:-1,y:-1}）时回 {cap,boss}，否则 null。
   * 推送入口（拖拽/心动时刻）与轮询入口共用这份闸门，保证两条路对「能不能拍」的判断一字不差。
   * **不拿 capturingInfo 做闸门**：窗口起点不保证有 feedInfo 下发（7 个窗口里两个 BOSS 窗口的起点没有），
   *   而 capturingInfo 可能还是上一只的残留（nowFavor>=allFavor）→ 拿它当在位/未喂满判据会把新宠锁死。
   *   收尾另有权威：21530 的 {x:-1,y:-1}（6 个已收窗全有）。
   * @param {object} pab PabController 实例
   * @returns {{cap:object,boss:boolean}|null} 在拍回 {cap,boss}（cap 恒为对象，缺 feedInfo 时是 EMPTY_CAP；
   *   boss=这一只在拍的是**大BOSS**（allFavor=1000000、21530 载荷 `boss:1`）而非普通宠，不在拍回 null
   */
  #feedState(pab) {
    const pos = pab.capturingPetPos;
    const x = Number(pos && pos.x);
    const y = Number(pos && pos.y);
    if (!(x > 0) || !(y > 0)) return null; // 未置位 / 服务器已推 {x:-1,y:-1} 收尾 = 不在拍
    const cap = pab.capturingInfo;
    return {
      cap: cap && typeof cap === 'object' ? cap : EMPTY_CAP,
      boss: Number(pos.boss) === 1,
    };
  }

  /**
   * 大BOSS 环节投喂道具（8546 specId 5/6）。
   * 选物与发包均源码 PabPetCaptureNodeNew：`init` 用 `behave[t+5].item` 填 `_captureItemIds`（t=0/1），
   *   `onItemFeedClick` → 首个 `getItemNumById(itemId)>0` 的格子 → `petCaptureOperation(t+5)`；
   *   而 `RealPabController.petCaptureOperation(e)` 的载荷**只有 `{specId:e}`**（不带 x/y/bossId），
   *   且 `checkCaptureOperationCd` 首行只拦 specId===1 → 投喂不受每秒限额约束（#tapBudget 不占用它那一格）。
   * 为什么要投：大BOSS `allFavor=1000000`，免费手拍 changeScore 只 6~11 → 光靠手拍不可能拍满。
   * 节流 `tuning.bossFeedGapMs` 取 200：人手连续投 10 件落在 2.5s 内、单件间隔 100~600ms、每件
   *   changeScore=400（道具身份闭环：8542{specId:19}×10 → 21525 里 41011+10 → 8546{specId:5}×10）。
   * **成功口径不以 favor 达标为判据**（大BOSS 窗一般拍不满）：投喂只在道具在场时逐格尽力投，
   *   缺料即交商店补货（见 index.js shop 档），不追求拍满。
   * @param {object} pab PabController 实例
   * @returns {boolean} true=这一拍投出了一件
   */
  #feedBossItem(pab) {
    const env = this.#env;
    const now = Date.now();
    if (now < this.#nextFeedAt) return false;
    // B3 投喂窗内预检（仅降频的**软闸门**，非在位闸门）：feedInfo 尚未就绪（cap=EMPTY_CAP 全 0，窗口起点不保证带）
    //   或本只已拍满（nowFavor>=allFavor）时发 8546 易撞服务端 s=3（异常操作）——跳过并按 bossFeedRejectMs 轻退避。
    //   ⚠ 不违背本模块「capturingInfo 只作料源不作闸门」契约：真·在位闸门仍由 #feedState(capturingPetPos) 保证、
    //     免费手拍⑤路不受影响；换宠时 onFeedBeast 已把 #nextFeedAt=0，故上一只残留满值最多只把新宠首件投喂延后
    //     ≤bossFeedRejectMs，不会锁死。
    const cap = pab.capturingInfo;
    const allFavor = cap ? toNum(cap.allFavor) : 0;
    const nowFavor = cap ? toNum(cap.nowFavor) : 0;
    if (!(allFavor > 0) || nowFavor >= allFavor) {
      this.#nextFeedAt = now + (Number(tuning.bossFeedRejectMs) || tuning.bossFeedGapMs);
      return false;
    }
    for (let t = 0; t < SPEC_FEED_COUNT; t++) {
      const spec = SPEC_FEED_FIRST + t;
      const row = env.l10n.tableRow(TABLE_BEAST_BEHAVE, spec);
      const itemId = row ? Number(row.item) : 0;
      if (!itemId || env.secret.getItemNumById(itemId) <= 0) continue;
      this.#nextFeedAt = now + tuning.bossFeedGapMs;
      this.#toldNoFeed = false;
      const favor = row && row.favor != null ? String(row.favor) : '?';
      this.#op(
        pab,
        spec,
        'boss feed item ' + itemId + ' (behave ' + spec + ', favor=' + favor + ')',
      );
      return true;
    }
    // 两格都没货：不再逐拍翻表（下一个节流点复检），并把「缺道具」只说一次
    this.#nextFeedAt = now + tuning.bossFeedGapMs;
    if (!this.#toldNoFeed) {
      this.#toldNoFeed = true;
      env.log.info(
        'boss feed skipped: neither behave %d/%d item is in the secret bag (needs manual restock).',
        SPEC_FEED_FIRST,
        SPEC_FEED_FIRST + SPEC_FEED_COUNT - 1,
      );
    }
    return false;
  }

  /**
   * 推送通道存活判定：窗内收到过任何一条 21527（含我们不响应的 type=3）就算活着。
   * @returns {boolean} true=通道活着，事件交推送直达，轮询兜底退场
   */
  #pushAlive() {
    return Date.now() - this.#lastPushAt < tuning.pushAliveMs;
  }

  /**
   * 在拍目标变化（push 21530）：只做两件轻事——换宠时清掉上一只残留的静默窗/轮询签名，并打一条 info 对账。
   * **在拍闸门不依赖它**（每拍现读 pab.capturingPetPos），
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
    this.#nextFeedAt = 0; // 换一只就重新允许投一次（上一只的节流点不该压住新一只的首件）
    this.#toldNoFeed = false;
    env.log.info('capture: feeding %s.', key);
  }

  /**
   * 捕获事件推送入口（push 21527，载荷 `{type, specId[], endTime, points[]}`）：拖拽窗口只有 2.0s
   * （源码 `ClientTime+2e3`，报文 349/349 条一致，见 EVT_TYPE_DRAG 注），等不起下一拍的 capturingInfo 回写，
   * 所以到达即发。退订由 reactor 托管（ctx.on.push）。
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
   * 单项即拖拽事件（specId 本身就是答案），多项按心动时刻弹窗择优；同一候选串只补发一次。
   * @param {Array<number|string>} es cap.eventSpecId 候选
   * @param {object} pab PabController 实例
   * @returns {boolean} true=这次发出了事件动作
   */
  #pollEvent(es, pab) {
    const sig = es.join(',');
    if (this.#pollSig === sig) return false; // eventSpecId 会挂十几秒，同一候选不逐拍重发
    this.#pollSig = sig;
    const pop = es.length > 1; // 多项 = 心动时刻投喂弹窗（单项 = 拖拽答案）
    const spec = pop ? this.#bestPopSpec(es) : Number(es[0]) || 0;
    if (!spec) return false;
    this.#op(pab, spec, 'poll fallback eventSpecId=[' + sig + '] (beast push silent)');
    if (pop) this.#closeFeedPop('poll fallback');
    return true;
  }

  /**
   * 捕获事件动作的推送出口（以 `type:endTime` 去重）。
   * **不受静默窗约束**：能量爆发演出 6.4~10.2s，而拖拽只有 2.0s，在静默窗内放弃等于必丢。
   * @param {number} et 事件类型（2 拖拽 / 5 心动时刻投喂弹窗）
   * @param {Array<number|string>} es 事件候选 specId
   * @param {number} endMs 窗口结束时刻（毫秒，兼作身份一部分）
   * @param {string} from 来源标注（debug 用）
   * @param {object} pab PabController 实例
   * @returns {boolean} true=这次发出了事件动作
   */
  #tryEvent(et, es, endMs, from, pab) {
    const key = et + ':' + endMs;
    if (this.#handled.has(key)) {
      // 同一事件重复下发：票已投过不再重发，但心动时刻的弹窗可能又被开了一次 → 照旧收窗，别留它倒数补投
      if (et === EVT_TYPE_FEED_POP) this.#closeFeedPop(from + ' dup');
      return false;
    }
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
    // 心动时刻：投完就把游戏弹窗收掉，否则它倒数到自己的终点会再替玩家随机投一票（见 #closeFeedPop 注）
    if (et === EVT_TYPE_FEED_POP) this.#closeFeedPop(from);
    return true;
  }

  /**
   * 心动时刻（投喂弹窗 PabPetFeedEventPopup）收尾：我方已替游戏把这一票投出去，但弹窗并不知情——
   *   源码 `onShow` 里 `_endTime = ServerFloatTime + _moveTime`（`_moveTime = behave[specId[0]].time`），
   *   `cpnUpdate` 每帧刷 `labTime`，归零即自动 `onFeedClick()` → 再发一发 `petCaptureOperation(7 + 落点下标)`
   *   并 close()。弹窗的补发会在其后 5~19s 再投一票、多数仍被服务器接受 → 白耗投喂道具，
   *   玩家侧观感就是「拖到十几秒超时才做出选择」；发完立刻走原生 CloseUI 收窗即切断补发。
   * 只关窗口、不改业务态（等价于玩家自己点投喂后的原生关闭链路），失败静默降级——不影响已发出的这一票。
   * @param {string} from 触发来源标注（debug 用）
   */
  #closeFeedPop(from) {
    const env = this.#env;
    const u = env.ui;
    if (!u || typeof u.close !== 'function') return;
    const r = u.close('pabFeedPopup');
    if (r && r.ok) env.log.debug('capture: feed popup closed (%s).', from);
    else env.log.debug('capture: feed popup not closed: %s (%s).', (r && r.err) || 'unknown', from);
  }

  /**
   * 能量满释放：发 specId=4，并按 behave[4].time（秒）设静默窗口（读不到用兜底 7s，该窗口 6.4~10.2s）。
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
   * **心动时刻候选恒为 `[7,8,9,10]`**（21527 type=5）：推送里的 `specId[]` 就是候选值本身，
   *   游戏弹窗补发的是 `7 + 落点下标`（同值域）→ 本函数直取候选值发包即为正确形态。
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
    if (this.#tapCount >= limit) {
      if (this.#quotaToldSec !== sec) {
        this.#quotaToldSec = sec;
        env.log.debug(
          'capture: tap quota exhausted limit=%d used=%d sec=%d, wait next second.',
          limit,
          this.#tapCount,
          sec,
        );
      }
      return false;
    }
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
      if (why) {
        const ci = pab.capturingInfo || {};
        env.log.debug(
          'capture: %s → specId=%d favor=%d/%d.',
          why,
          specId,
          toNum(ci.nowFavor),
          toNum(ci.allFavor),
        );
      }
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
    this.#nextFeedAt = 0;
    this.#toldNoFeed = false;
    this.#notFeedLogged = false;
    this.#quietLogged = false;
    this.#quotaToldSec = 0;
    this.#lastFeedAt = Date.now();
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

  /** 停止：置死 #active、摘除 cycle 哨兵。 */
  stop() {
    this.#active = false;
    if (this.#cycle) this.#cycle.dispose();
    this.#cycle = null;
  }
}
