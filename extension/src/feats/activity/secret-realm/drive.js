/**
 * 自动驾驶引擎（异能秘境：统一方向盘的目的地状态机——资源点巡航 / BOSS 开台 / 商店到店 / 受击逃帐回攻）。
 *
 * 语义边界：本 feat 其余引擎全部是「到点即干活」（拾取/拍宠/治疗/攻打/石头/补货），**没人决定「下一个去哪」**；
 *   8521 MARCH_MOVE 是全仓唯一能主动挪队伍的口（verbatim RealPabController.sendToBuildingMarch），
 *   且它驱动的是**队级**那一条行军（仅队长可发，与 boss.js/warn.js 同闸）→ 自动驾驶开启时方向盘只有一把：
 *   目的地决策全部收口本引擎，warn.js 让闸（转移改由本引擎 EVADE 承担），boss.js 让闸（非 BOSS 点的攻打让位开车，
 *   到 176/177/178 后攻打仍归 boss.js）。
 *
 * 料源（诚实口径）：候选点**只取自 push 10018 视口增量快照**（所见即所驱）——10018 是「进视口才推」的增量，
 *   快照里没有某点 = 无证据，绝不凭空造坐标（901 扫描在秘境图是否受理未实证，本期不引入；镜头探测留二期）。
 *   商店点坐标只认快照里出现过的 161（constants 明写 SHOP_POINTS_SEED「坐标随图而异」，快照全无即不去）。
 *
 * 状态机（一拍一个动作；每拍开头由 marchState 闸收口：**行军中一律不重评路由**，推进只靠到达/超时两个事件）：
 *   IDLE(评估) → EVADE(受击逃就近营帐) → RETURN(威胁解除后回攻原 BOSS 点) ↘
 *            → TO(8521 在途) → WORK → 消费记账(#consumed) → IDLE
 *            → HOLD(已停 BOSS 相关点：攻打交 boss.js，本引擎不动方向盘)
 *   WORK 三档退出（按到达点 pointType 选）：
 *     · 资源 173 / 掉落 163 =「**拿空即走**」：判空有**两路料源，任一命中即走**（解决「到点前已被别人采空、
 *       之后无人再碰 → 无 CHANGE 推送」被硬控到兜底的死等）：
 *       ① 过渡路（在拾/刚有人拾）：独立订阅 21522/21532 CHANGE 事件按点记剩余空闲数，
 *          res 的 bag 空闲==0 且 buff 空闲==0、drop 的 drop 空闲==0 且 beast 空闲==0 → 拿空；
 *       ② 当前态路（到点即判，无需等采集）：读 10018 视口快照该点字段——
 *          173 `m.rTime` 为**未来刷新时刻**即该井已被抽空（报文实证三份完整录像：大量 173 首帧视口即带 rTime、
 *          且这些点我们从未采集 → rTime 是「他人已采空/刷新中」的当前态旗标，非本队采集过渡）；
 *          163 `m.iNum`==0 即无可拾条目（报文实证 (403,205) iNum 归 0 与 21532 dropFree/beastFree 归 0 同刻）。
 *          注：173 的 rTime 只覆盖 bag（buff 另计），故若 CHANGE 显示该点仍有 buffFree>0 则不据 rTime 判空。
 *       拿空后再驻留可配 settle（默认 0=立即走）；两路都探不到拿空（真满载且我们拾不完/无证据）由 driveWorkMaxMs 兜底强制离点。
 *     · 商店 161 = 固定驻留可配 driveShopDwellMs（默认 25s，到店即视作「大BOSS 前那趟商店」已办）。
 *     · BOSS 平台 176 / 其它 = 固定驻留 driveWorkDwellMs 让 boss.js 打仗（驻留满不记消费）。
 *   评估优先级：①威胁(21534 num>0) → EVADE；②回攻待办 → RETURN；③已停 BOSS 相关点 = HOLD（攻打归 boss.js）；
 *   ④state21 BOSS 窗开着而我不在 BOSS 点 → 就近 176 平台；开台预置（借鉴竞品B plane_time）：无 21 窗但某 BOSS 的
 *     state22 读秒距开启 ≤ driveBossLeadMs → 提前挪向距该 BOSS 最近的可用平台（行军要 31~44s，等 21 推到再动必烧掉开台窗）；
 *   ⑤**大BOSS 前定点商店勤务**（elapsed≥fightBegin 检查点且本场未到店 → 强制就近 161，办完不再重复）；
 *   ⑥商店补货有缺口（reactive）→ 就近 161；⑦巡航 173 资源/井 + 163 掉落箱（借鉴竞品B 评分制：档位 iNum 为收益、
 *     距当前点/最近活BOSS/最近商店的加权格距为成本，取净收益最大者；无证据点退回纯就近）。
 *   到点确认**双路**：主路 = roomBaseInfo.startPoint 与目的地一致且 ARRIVED（21521/21529 kick 后进闸复核，
 *   不依赖事件时序）；兜底 = TO 超时 driveMarchTimeoutMs（90s，实测闭环上限 44.2s 加两档余量）→ 记消费转重评。
 *   拒绝处置（与 warn.js/boss.js 同口径）：158 在途未达 = 迟到信号正常形态；157 = 已在该点 → 直接进 WORK；
 *   163 → 该目标当日不重选；其余任一 `s≠0` → rejectBackoffMs 退避重评。
 *   当前点被 PVP（瓦片 state 11/12，借鉴竞品B autoLeader 保命让闸）→ 方向盘让位原地应战、快照无证据不拦。
 *
 *   静默闸可观测（实战「一次都没动」无从定责的补丁）：停泊/在途/HOLD/非队长四道常闭闸走 #gateState 边沿日志
 *   （进入打 info、恢复打放行 info，各一次）；在途闸 isSecretSending(8521) 连续 ≥ driveMarchTimeoutMs 为真且
 *   本端已在停泊态（isCanMarch 同判据成立却仍有未答包 = NetMgrSimple._cachePacks 幽灵条目——条目只在收到同 o
 *   应答或重连清理时 splice，应答丢失即永堵）→ warn 一条并绕过闸发一笔探测包自愈（裸协议不受客户端闸约束，
 *   服务端按 158/157/ok 正常语义回执，通道随之清堵）。
 *
 * 躲避档（用户拍板）：受击（21534 num>0）→ 逃**就近未被 PVP 营帐**（174/175；快照无则驻留重扫）；
 *   威胁解除（num=0，实证「转移即消警」）且逃离点是 BOSS 相关点(176/177/178) → 回攻：优先回原平台，
 *   原平台不可用（被占/开打）则取**同区域（esrId 相同）最近可用平台**；回攻只试一次（to 相位由通用闸推进），
 *   失败即转常规重评；回攻前置 = 仍有 state21 未散场的 BOSS（窗口关了就不回头）。
 *
 * 只读+发包红线：全程只读 ACL 快照 + `sendMarch`；不调游戏 Update/Delete、不镜像态；Int64 只 toNum 读不回写。
 * 触发：单条 createCycle（电平兜底 driveScanMs）+ kick 源 21534/21529/21535/21521；10018 只写快照不 kick
 *   （3 条/秒，kick 会把兜底拍打成 3Hz，与 warn.js 同手法）；21522/21532 只写按点账、仅当命中当前 WORK 点才 kick。
 */
import { createCycle } from '../../../core/cycle.js';
import {
  CMD_MARCH_MOVE,
  PUSH_SELF_ATTACKED,
  PUSH_TILE_INFO,
  PUSH_BASE_INFO,
  PUSH_BOSS_STATE,
  PUSH_TEAM_ARRIVE,
  EVT_RES_LIBRARY_UPDATE,
  EVT_REWARD_BOX_UPDATE,
  PAB_SHOP,
  PAB_DROP,
  PAB_MONSTER,
  PAB_RESOURCE,
  PAB_COMMON_PLANE,
  PAB_TENT,
  PAB_BOSS_PLANE,
  PAB_BOSS,
  PAB_BOSS_GUARD,
  ST_BOSS_FIGHTING,
  ST_PLANE_MARCH,
  ST_PVP_READY,
  ST_PVP_FIGHTING,
  REJ_ALREADY_THERE,
  REJ_NO_MARCH_TARGET,
  CODE_NOT_SENT,
  TABLE_ITEM,
  tuning,
} from './constants.js';

/** @type {string} 持有清单行 key 的道具维度前缀（`item:{itemId}`，与 index.js/pickup.js/shop.js 同口径） */
const KEY_ITEM = 'item:';

/**
 * 需要进快照的点型（其余点型与本引擎无关；172 野怪不在本期巡航档——拍宠仍由玩家带到，见文件头评估优先级⑤）。
 * @type {Object<number,1>}
 */
const TRACKED_PT = {};
[
  PAB_SHOP,
  PAB_DROP,
  PAB_MONSTER,
  PAB_RESOURCE,
  PAB_COMMON_PLANE,
  PAB_TENT,
  PAB_BOSS_PLANE,
  PAB_BOSS,
  PAB_BOSS_GUARD,
].forEach(function (pt) {
  TRACKED_PT[pt] = 1;
});

/**
 * 点位键（与 boss.js/warn.js 同口径的本地小工具；非法坐标回 ''）。
 * @param {number} x 横号
 * @param {number} y 纵号
 * @returns {string}
 */
function tileKey(x, y) {
  const nx = Number(x);
  const ny = Number(y);
  if (!Number.isFinite(nx) || !Number.isFinite(ny)) return '';
  return Math.floor(nx) + ',' + Math.floor(ny);
}

/**
 * 两瓦片欧氏格距（任一非法回 Infinity，排序落最后、不进「就近」；与 boss.js 同一把尺子）。
 * @param {number} ax 甲横
 * @param {number} ay 甲纵
 * @param {number} bx 乙横
 * @param {number} by 乙纵
 * @returns {number}
 */
function dist(ax, ay, bx, by) {
  const dx = Number(ax) - Number(bx);
  const dy = Number(ay) - Number(by);
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return Infinity;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * protobuf Long / {_low,_high} / number / 字符串 → 数值（取不到回 0）。与 boss.js 同口径。
 * @param {*} v 数值字段原值
 * @returns {number}
 */
function toNum(v) {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
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
 * 点型是否 BOSS 相关（176 平台 / 177 大BOSS / 178 小BOSS）——受击逃离点是否值得回攻的判据。
 * @param {number} pt 瓦片 pointType
 * @returns {boolean}
 */
function isBossish(pt) {
  return pt === PAB_BOSS_PLANE || pt === PAB_BOSS || pt === PAB_BOSS_GUARD;
}

/**
 * 21522/21532 CHANGE 明细里的「剩余空闲（可拾）条目数」：带 `uid`/`playerInfo`/`hide` 的条目 = 已被领。
 * 缺列（非数组）回 0（如纯资源点无 buff 列 → 视作空、不阻塞拿空判定）。
 * @param {Array<object>|undefined} entries 明细数组（bagInfo/buffInfo/dropInfo/dropBeastInfo）
 * @returns {number}
 */
function freeCount(entries) {
  if (!Array.isArray(entries)) return 0;
  let n = 0;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!e) continue;
    if (e.uid || e.playerInfo || e.hide) continue;
    n++;
  }
  return n;
}

/**
 * 自动驾驶引擎：单条 createCycle 状态机（IDLE 评估 → TO → WORK → 消费记账）。
 */
export class DriveEngine {
  #env;
  /** @type {{kick:Function}|null} */
  #cycle = null;
  /** @type {boolean} 引擎存活位（stop 置 false 后旧 cycle 定时器到点即终止） */
  #active = false;
  /**
   * @type {Map<string,{pt:number,x:number,y:number,state:number,sET:number,isFight:number,esrId:number|null,teams:number,rTime:number,iNum:number|null,at:number}>}
   * push 10018 自建**视口快照**（LRU 上限 tuning.tileExtMax）：本引擎唯一的目的地料源。
   *   rTime（173）：井被抽空后的下次刷新时刻（toNum 毫秒，0=满载无刷新计时）；iNum（163）：剩余可拾条目数（缺列存 null）。
   */
  #tiles = new Map();
  /** @type {Map<string,number>} 消费账本：点位键 → 解禁时刻（Date.now 毫秒）；过期允许重去（资源点会刷新） */
  #consumed = new Map();
  /** @type {Object<string,1>} 撞 enigma_realm163（目标点不能行军）的点位：当日不再选 */
  #dayBlack = {};
  /** @type {boolean} 21534 存活威胁位（num>0 置真、num=0 清零；实证「转移即消警」） */
  #threat = false;
  /** @type {{x:number,y:number,pt:number,esrId:number|null}|null} 逃袭前的停泊现场（回攻档需求源） */
  #escapeFrom = null;
  /** @type {boolean} 回攻待办（威胁解除时逃离点是 BOSS 相关点 → 置位；发出回攻或重评放弃时清除） */
  #returnPending = false;
  /** @type {string} 当前目的地相位标记（''=IDLE/WORK；否则 'kind|x,y'，到达/超时事件消费它） */
  #toKind = '';
  /** @type {string} 目的地坐标键（roomBaseInfo.startPoint 复核到达用） */
  #toXY = '';
  /** @type {number} 本笔 8521 发出时刻（TO 超时判定基准） */
  #toAt = 0;
  /** @type {number} WORK 驻留截止时刻（到点时置位；0=不在驻留相位） */
  #workUntil = 0;
  /** @type {number} 冷却截止时刻（被拒退避/转移静默共用；Date.now 毫秒） */
  #cooldownUntil = 0;
  /** @type {Object<string,1>} 已打过的 info 提示键（防刷屏） */
  #told = {};
  /**
   * @type {Map<string,{kind:string,bagFree:number,buffFree:number,dropFree:number,beastFree:number,at:number}>}
   * 21522/21532 CHANGE 事件按点记的**剩余空闲数**（拿空判据料源；独立于 pickup，零耦合）。
   */
  #change = new Map();
  /** @type {string} WORK 退出模式：''=不在 WORK；'empty'=拿空即走(资源/掉落)；'dwell'=固定驻留(商店/平台/其它) */
  #workMode = '';
  /** @type {number} 资源/掉落点首次检测到拿空的时刻（settle 计时基准；0=尚未拿空） */
  #workEmptyAt = 0;
  /** @type {number} 资源/掉落点拿空兜底强制离点的截止时刻（driveWorkMaxMs 安全网；0=不启用） */
  #workDeadline = 0;
  /** @type {boolean} 大BOSS 前定点商店勤务：本场是否已完成（到店即置真） */
  #shopErrandDone = false;
  /**
   * @type {{x:number,y:number}|null} 本拍 #liveBossLead() 命中的「即将开台」BOSS 本体坐标（#nearestBossPlatform 预置档的就近锚点）
   */
  #bossLead = null;
  /** @type {number} 当前场 fightBeginTime（毫秒）；变化即视为换场、复位勤务与按点账 */
  #matchFightBegin = 0;
  /** @type {number} 通道在途闸（isSecretSending 8521）连续为真的起始时刻（0=不在途；自愈判据基准） */
  #inflightStuckSince = 0;

  /** @param {object} env 注入底座 {alive, realmActive, cfg, secret, gameConf, l10n, log} */
  constructor(env) {
    this.#env = env;
  }

  // ── 推送落地（只做记账与 kick，业务态一律重读 ACL/快照）────────────────

  /**
   * push 21534 攻击警告落地：num>0 置威胁并 kick（用户档=不做存活窗去抖）；num=0 清威胁（转移即消警实证）。
   * @param {object} ev bus `net.21534` 事件（载荷平铺在 ev.data.data）
   */
  onWarnPush(ev) {
    const d = (ev && ev.data && ev.data.data) || {};
    const num = Number(d.num) || 0;
    if (num > 0) {
      this.#threat = true;
      if (this.#cycle) this.#cycle.kick();
    } else {
      this.#threat = false;
    }
  }

  /**
   * push 21529 到达落地：**不直接信任事件**（到达的最终判据是 roomBaseInfo.startPoint 复核，见 #confirmArrive），
   *   只 kick 一拍让状态机立刻重评。
   */
  onArriveWake() {
    if (!this.#env.alive()) return;
    if (this.#cycle) this.#cycle.kick();
  }

  /**
   * push 10018 落地：只收本引擎关注的点型（TRACKED_PT），写快照、**不 kick**（3 条/秒，防拍打）。
   * @param {object} ev bus `net.10018` 事件（`ev.data = {pointInfos:[{x,y,pointType,m}]}`，平铺）
   */
  onTilePush(ev) {
    const d = ev && ev.data;
    if (!d || typeof d !== 'object') return;
    const list = Array.isArray(d.pointInfos) ? d.pointInfos : null;
    if (!list) return;
    const now = Date.now();
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (!p) continue;
      const pt = Number(p.pointType) || 0;
      if (!TRACKED_PT[pt]) continue;
      const k = tileKey(p.x, p.y);
      if (!k) continue;
      const m = p.m && typeof p.m === 'object' ? p.m : {};
      if (this.#tiles.size >= tuning.tileExtMax && !this.#tiles.has(k)) {
        const first = this.#tiles.keys().next();
        if (!first.done) this.#tiles.delete(first.value);
      }
      const esr = m.esrId == null ? null : Number(m.esrId);
      this.#tiles.set(k, {
        pt: pt,
        x: Math.floor(Number(p.x)),
        y: Math.floor(Number(p.y)),
        state: Number(m.state) || 0,
        sET: toNum(m.sET),
        isFight: Number(m.isFight) || 0,
        // 162/175 等 esrId 恒 0 的型别：0 不算区域证据（与 boss.js 同口径，防「同区域」误判）
        esrId: esr == null || Number.isNaN(esr) || esr === 0 ? null : esr,
        teams: Array.isArray(m.teams) ? m.teams.length : 0,
        // 到点判空的「当前态」两字段：173 抽空 → rTime 是未来刷新时刻；163 无可拾 → iNum==0（缺 iNum 存 null 不误判空）
        rTime: toNum(m.rTime),
        iNum: m.iNum == null ? null : Number(m.iNum) || 0,
        at: now,
      });
    }
  }

  /**
   * push 21522（EVT_RES_LIBRARY_UPDATE）资源点变动落地：按点记剩余空闲数（bag/buff）。
   *   载荷平铺 `{x,y,bagInfo,buffInfo,refreshTime}`（游戏 Handler verbatim emit）。
   * @param {object} e EventCenter 事件载荷
   */
  onResChange(e) {
    if (!e) return;
    const k = tileKey(e.x, e.y);
    if (!k) return;
    this.#change.set(k, {
      kind: 'res',
      bagFree: freeCount(e.bagInfo),
      buffFree: freeCount(e.buffInfo),
      dropFree: 0,
      beastFree: 0,
      at: Date.now(),
    });
    if (this.#workMode === 'empty' && k === this.#toXY && this.#cycle) this.#cycle.kick();
  }

  /**
   * push 21532（EVT_REWARD_BOX_UPDATE）掉落箱变动落地：按点记剩余空闲数（drop/beast）。
   *   载荷平铺 `{x,y,dropInfo,dropBeastInfo}`（dropInfo 条目取 `uid`，与 21522 同口径）。
   * @param {object} e EventCenter 事件载荷
   */
  onDropChange(e) {
    if (!e) return;
    const k = tileKey(e.x, e.y);
    if (!k) return;
    this.#change.set(k, {
      kind: 'drop',
      bagFree: 0,
      buffFree: 0,
      dropFree: freeCount(e.dropInfo),
      beastFree: freeCount(e.dropBeastInfo),
      at: Date.now(),
    });
    if (this.#workMode === 'empty' && k === this.#toXY && this.#cycle) this.#cycle.kick();
  }

  // ── 一拍调度 ────────────────────────────────────────────────────────

  /**
   * 一拍决策阶梯（顺序即优先级；一拍最多发一笔 8521）。永不 reject。
   * 择时口径与 boss.js 一致：**真发出了包 → 0（立即再跑，由在途闸接住）**；否则回本拍定的短睡或兜底。
   * @returns {number} 下拍睡眠（毫秒）
   */
  #tick() {
    const env = this.#env;
    if (!env.alive()) return 0;
    if (!env.realmActive()) return tuning.driveScanMs;
    const b = env.cfg().drive;
    if (!b || !b.enabled) return tuning.driveScanMs;
    const now = Date.now();
    if (now < this.#cooldownUntil) {
      this.#gateState('cooldown', true, 'left=' + (this.#cooldownUntil - now) + 'ms');
      return this.#cooldownUntil - now;
    }
    this.#gateState('cooldown', false, '');
    // 预置锚点每拍重算（仅 #liveBossLead 命中时重写；早退路径不留陈旧坐标）
    this.#bossLead = null;

    const base = env.secret.getRoomBaseInfo();
    if (!base || !base.startPoint) return tuning.driveScanMs;
    const S = env.secret.getNMarchState();
    const arrived = S && S.ARRIVED != null ? Number(S.ARRIVED) : 2;
    const curKey = tileKey(base.startPoint.x, base.startPoint.y);
    // 统一停泊判据（与游戏 isCanMarch=!!roomBaseInfo&&teamIsMooring 同口径；在途闸自愈与 #gateState 共用）
    const moored = Number(base.marchState) === arrived && env.secret.teamIsMooring();
    // TO 相位不重评（在途 marchState=MARCHING 属正常形态），闸日志只在方向盘评估拍打边沿
    if (!this.#toKind) this.#gateState('notarrived', !moored, 'marchState=' + base.marchState);

    // 换场复位：fightBeginTime 变化 = 新一场秘境 → 复位大BOSS 前商店勤务与按点拿空账（坐标可同位不同场）
    const fb = toNum(base.fightBeginTime);
    if (fb > 1e11 && fb !== this.#matchFightBegin) {
      this.#matchFightBegin = fb;
      this.#shopErrandDone = false;
      this.#change = new Map();
    }

    // 在途：只推进「到达复核 / 超时兜底」，绝不重评路由（行军途中发第二笔必吃 158，与 warn.js 同教训）
    if (this.#toKind) {
      if (Number(base.marchState) === arrived && curKey === this.#toXY) {
        this.#enterWork(curKey);
        // 回 0 立即再跑一拍进 WORK 评估：到点是空井可当拍即判即走，不必干等一整个 driveScanMs
        return 0;
      }
      if (now - this.#toAt > tuning.driveMarchTimeoutMs) {
        // 超时不到（目标被抢/路径阻断/事件漏拍）：记消费走人，防状态机锁死在 TO
        env.log.info('drive: goto %s 超时未到，记消费重评。reason=march_timeout', this.#toKind);
        this.#consume(this.#toXY);
        this.#clearTo();
        return tuning.driveScanMs;
      }
      return this.#toAt + tuning.driveMarchTimeoutMs - now;
    }

    // 驻留相位（WORK）：让「到点引擎」（拾取/商店/攻打/拍宠）干活，按 #workMode 退出
    if (this.#workMode) {
      const w = this.#workTick(now);
      if (!w.leave) return w.sleep;
      const wk = this.#toXY;
      const mode = this.#workMode;
      this.#toXY = '';
      this.#workMode = '';
      this.#workEmptyAt = 0;
      this.#workDeadline = 0;
      this.#workUntil = 0;
      // BOSS 平台（176）驻留满**不记消费**：攻打未完（窗未散）时走人等于把平台弃在战斗中；
      //   不收账则下一拍落入 ③ HOLD（持窗干等）或 ④（窗已散 → 重评去下一个收益点），两种都由 boss.js 自然收场
      const wt = wk ? this.#tiles.get(wk) : null;
      const bossPlane = mode === 'dwell' && wt && wt.pt === PAB_BOSS_PLANE;
      if (!bossPlane) this.#consume(wk);
    }

    // 全队动作闸：8521 驱动队级行军，仅队长可发（与 boss.js/warn.js 同闸；边沿日志：换队/接手后重新评估）
    this.#gateState('leader', !env.secret.isTeamLeader(), '');
    if (!env.secret.isTeamLeader()) return tuning.driveScanMs;
    if (!moored) return tuning.driveScanMs;
    const curPt = Number(base.pointType) || 0;
    if (this.#captureBusy()) {
      // 挪点会清空当前捕获进度（游戏要弹 enigma_realm208 确认），自动化绝不代确认
      this.#note('capturing', 'drive: 正在拍普通异能兽，等拍完再挪点。');
      return 3000;
    }
    if (env.secret.isSecretSending(CMD_MARCH_MOVE)) {
      if (!this.#inflightStuckSince) this.#inflightStuckSince = now;
      const stuck = now - this.#inflightStuckSince;
      // 幽灵条目自愈（报文侧证据：NetMgrSimple 只在收到同 o 号应答时 splice _cachePacks，应答丢失即永堵；
      //   此刻 moored 已成立 = 游戏自己判「可发」而通道仍报在途）→ 绕过闸发一笔探测包，服务端按正常语义回执、通道清堵
      if (stuck >= tuning.driveMarchTimeoutMs) {
        env.log.warn(
          'drive: 8521 通道在途标记堵塞 %ds 且已停泊（疑似幽灵条目），绕过闸发一笔探测包自愈。',
          Math.round(stuck / 1000),
        );
        this.#inflightStuckSince = 0;
        this.#dispatch('cruise', this.#nearestCruise(curKey), true);
        return this.#sleepAfterDispatch();
      }
      return 200;
    }
    this.#inflightStuckSince = 0;

    // ① 受击逃袭（最高优先级：保命先于一切收益动作）；已停在营帐/平台（174/175）时不再逃——
    //   再逃只会同档跳来跳去（warn.js「别原地打转」同理），原地等消警
    if (this.#threat) {
      if (curPt !== PAB_TENT && curPt !== PAB_COMMON_PLANE) {
        this.#dispatch('evade', this.#nearestSafeTent(curKey));
        return this.#sleepAfterDispatch();
      }
      return tuning.driveScanMs;
    }
    // ② 回攻：威胁已解除且逃离点是 BOSS 相关点（待办位由 #dispatch 真上线时消费）
    if (this.#returnPending) {
      if (!this.#hasLiveBoss()) {
        this.#returnPending = false;
        this.#escapeFrom = null;
      } else {
        this.#dispatchReturn(curKey);
        return this.#sleepAfterDispatch();
      }
    }
    // 当前点正被 PVP（瓦片 state 11/204 同口径的 11/12）→ 方向盘让位原地应战（竞品 autoLeader 同款保命闸：
    //   交战中挪队只会把部队撒在路上；快照无当前点证据 = 无证据不拦）
    const curTile = this.#tiles.get(curKey);
    const curPvp =
      !!curTile && (curTile.state === ST_PVP_READY || curTile.state === ST_PVP_FIGHTING);
    this.#gateState('curpvp', curPvp, curPvp ? '(' + curKey + ') state=' + curTile.state : '');
    if (curPvp) return tuning.driveScanMs;
    // ③ 已停 BOSS 相关点 = HOLD：攻打/投喂/石头归 boss.js，本引擎不抢它的方向盘（边沿日志：进/出各一条）
    if (isBossish(curPt)) {
      this.#gateState('hold', true, 'pt=' + curPt);
      return tuning.driveScanMs;
    }
    this.#gateState('hold', false, '');
    // ④ BOSS 窗开着而我不在 BOSS 点 → 就近开往可用 176 平台（到达后攻打自动接棒）；
    //   无 21 窗时退到开台预置档（竞品B plane_time 同款：读秒窗内提前挪，行军 31~44s 不再烧在腿上）。
    if (b.boss !== false) {
      const openNow = this.#hasLiveBoss();
      const lead = openNow ? null : this.#liveBossLead();
      if (openNow || lead) {
        this.#dispatch('boss-plane', this.#nearestBossPlatform(curKey, !openNow));
        return this.#sleepAfterDispatch();
      }
    }
    // ⑤ 大BOSS 前定点商店勤务：elapsed≥检查点且本场未到店 → 强制就近 161（未真上线则每拍重试，到店即完成）
    if (b.shopTime !== false && !this.#shopErrandDone && this.#preBossShopDue()) {
      this.#dispatch('shop', this.#nearestShop(curKey));
      return this.#sleepAfterDispatch();
    }
    // ⑥ 商店补货有缺口 → 就近到店（到店后补货归 shop.js）
    if (this.#shopGapWanted()) {
      this.#dispatch('shop', this.#nearestShop(curKey));
      return this.#sleepAfterDispatch();
    }
    // ⑦ 巡航资源/井/掉落箱（档位评分 + 加权格距，见 #nearestCruise）
    this.#dispatch('cruise', this.#nearestCruise(curKey));
    return this.#sleepAfterDispatch();
  }

  // ── 候选选择（全部只读 #tiles 快照；无证据即回 null，绝不凭空造坐标）──

  /**
   * 就近安全营帐：排除当前点，「未被 PVP」（瓦片 state ∉ {11,12}，verbatim WIPabResource 本地判据），
   *   有驻军的营帐不落（防 252 同口径的保守近似），同距取更新鲜者。
   * @param {string} curKey 当前点位键
   * @returns {{x:number,y:number}|null}
   */
  #nearestSafeTent(curKey) {
    return this.#nearestBy(
      curKey,
      function (t) {
        if (t.pt !== PAB_TENT && t.pt !== PAB_COMMON_PLANE) return false;
        if (t.state === ST_PVP_READY || t.state === ST_PVP_FIGHTING) return false;
        return t.teams === 0;
      },
      false,
    );
  }

  /**
   * 就近可用 176 平台（档闸取 NWorldPabBossPlanePopup 四段闸的保守近似）：
   *   `isFight !== 1`（217 本平台在战斗中不重派）；`teams` 空（252 的「有任一驻军就不挪」近似，无 isFriend ACL）。
   * 开台窗内（preWindow=false）：只认双态 21/22 瓦片（verbatim 旧口径）。
   * 预置档（preWindow=true，竞品B plane_time 同款）：开台前平台瓦片未必已进 21/22 证据（快照未推/state 仍 0），
   *   不强要态证据，改为**以即将开台的 BOSS 本体为就近锚**（#bossLead）选最近可用平台——离战斗点越近，
   *   21 一开 boss.js 越快接棒；读不到锚点时退回纯就近。
   * @param {string} curKey 当前点位键
   * @param {boolean} preWindow 是否预置档（无 21 窗、仅有读秒窗）
   * @returns {{x:number,y:number}|null}
   */
  #nearestBossPlatform(curKey, preWindow) {
    if (!preWindow) {
      return this.#nearestBy(
        curKey,
        function (t) {
          if (t.pt !== PAB_BOSS_PLANE) return false;
          if (t.state !== ST_BOSS_FIGHTING && t.state !== ST_PLANE_MARCH) return false;
          if (t.isFight === 1) return false;
          return t.teams === 0;
        },
        false,
      );
    }
    const lead = this.#bossLead;
    const cx = lead ? lead.x : Number(curKey.split(',')[0]);
    const cy = lead ? lead.y : Number(curKey.split(',')[1]);
    let best = null;
    let bestD = Infinity;
    this.#tiles.forEach(function (t, k) {
      if (k === curKey) return;
      if (t.pt !== PAB_BOSS_PLANE) return false;
      if (t.isFight === 1) return false;
      if (t.teams !== 0) return false;
      const d = dist(t.x, t.y, cx, cy);
      if (d < bestD || (d === bestD && best && t.at > best.at)) {
        best = t;
        bestD = d;
      }
    }, this);
    return best ? { x: best.x, y: best.y } : null;
  }

  /**
   * 回攻落点：优先**原平台**（快照里仍可用才回）；否则同区域（esrId 与逃离点相同）最近可用平台；
   *   逃离点 esrId 无证据时只试回原点（拿不到区域证据就跨区乱跳会把枪烧在 209/142 上）。
   *   候选闸与 #nearestBossPlatform 同档（双态 21/22、isFight≠1、teams 空、未拉黑）。
   *   未真上线（无候选/在途拦下）时放回待办位，下一拍重试；无平台可落才永久放弃转重评。
   * @param {string} curKey 当前点位键
   */
  #dispatchReturn(curKey) {
    const from = this.#escapeFrom;
    if (!from) {
      this.#returnPending = false;
      return;
    }
    const usable = (t) =>
      t &&
      t.pt === PAB_BOSS_PLANE &&
      (t.state === ST_BOSS_FIGHTING || t.state === ST_PLANE_MARCH) &&
      t.isFight !== 1 &&
      t.teams === 0 &&
      !this.#isBlocked(t);
    const origin = usable(this.#tiles.get(tileKey(from.x, from.y)))
      ? { x: from.x, y: from.y }
      : null;
    const cand =
      origin ||
      (from.esrId != null
        ? this.#nearestBy(
            curKey,
            function (t) {
              return (
                t.pt === PAB_BOSS_PLANE &&
                t.esrId === from.esrId &&
                (t.state === ST_BOSS_FIGHTING || t.state === ST_PLANE_MARCH) &&
                t.isFight !== 1 &&
                t.teams === 0
              );
            },
            false,
          )
        : null);
    if (!cand) {
      // 无可回落点（原点被占且无同区候选/原点 esr 无证据）：放弃回攻转常规重评，④档会另择就近平台
      this.#returnPending = false;
      this.#note('return-none', 'drive: 回攻无可落平台，转常规重评。reason=no_platform');
      return;
    }
    this.#returnPending = false;
    this.#dispatch('return', cand);
    // 未真上线（在途/坐标非法）：待办位放回，下一拍重试
    if (!this.#toKind) this.#returnPending = true;
  }

  /**
   * 就近商店点：只认快照里出现过的 161 且未被 PVP（SHOP_POINTS_SEED「坐标随图而异」→ 快照全无即不去）。
   * @param {string} curKey 当前点位键
   * @returns {{x:number,y:number}|null}
   */
  #nearestShop(curKey) {
    // 商店点解禁快一档：到店买空即 #done，短 TTL 防「同店反复短跳」，长 TTL 让刷新额度能再去
    return this.#nearestBy(
      curKey,
      function (t) {
        if (t.pt !== PAB_SHOP) return false;
        if (t.state === ST_PVP_READY || t.state === ST_PVP_FIGHTING) return false;
        return true;
      },
      false,
    );
  }

  /**
   * 巡航点选择（借鉴竞品B marchResource 的评分制，取代旧「纯就近」拍板）：
   *   173 资源/井 + 163 掉落箱，未被 PVP、未消费、未当日拉黑、非当前点；
   *   评分 = 档位收益 m.iNum（竞品同源字段；缺 iNum 的 163 条目按 0，仍能按就近去拾宠/拾物）
   *          − 距当前点格距/2 − 距最近活 BOSS 格距/5 − 距最近商店格距/6（竞品 verbatim 权重的物理含义：
   *          顺路优先——离战斗点/补给点越近的点越值得拐；除数越大权重越小）。
   *   取净收益最大者；快照全无（无证据）回 null，绝不凭空造坐标。
   * @param {string} curKey 当前点位键
   * @returns {{x:number,y:number}|null}
   */
  #nearestCruise(curKey) {
    const env = this.#env;
    const cx = Number(curKey.split(',')[0]);
    const cy = Number(curKey.split(',')[1]);
    const accept = function (t) {
      if (t.pt !== PAB_RESOURCE && t.pt !== PAB_DROP) return false;
      if (t.state === ST_PVP_READY || t.state === ST_PVP_FIGHTING) return false;
      return true;
    };
    // 成本锚点：最近活 BOSS（state21 未散场，与 #hasLiveBoss 同判据）与最近商店点（快照内 161）；取不到不计该项成本
    let bossA = null;
    const list = env.secret.getBossBaseInfo();
    if (Array.isArray(list)) {
      const nowMs = Date.now();
      for (let i = 0; i < list.length; i++) {
        const s = list[i];
        if (!s || Number(s.state) !== ST_BOSS_FIGHTING || !s.pos) continue;
        const end = toNum(s.stateEndTime);
        if (end > 1e11 && nowMs > end) continue;
        bossA = { x: Math.floor(toNum(s.pos.x)), y: Math.floor(toNum(s.pos.y)) };
        break;
      }
    }
    let shopA = null;
    let shopD = Infinity;
    this.#tiles.forEach(function (t) {
      if (t.pt !== PAB_SHOP) return;
      const d = dist(t.x, t.y, cx, cy);
      if (d < shopD) {
        shopD = d;
        shopA = t;
      }
    });
    const now = Date.now();
    let best = null;
    let bestScore = -Infinity;
    this.#tiles.forEach(function (t, k) {
      if (k === curKey) return;
      if (!accept(t)) return;
      if (this.#dayBlack[k]) return;
      if (this.#consumed.get(k) === -1) return;
      if ((this.#consumed.get(k) || 0) > now) return;
      const dCur = dist(t.x, t.y, cx, cy);
      if (!Number.isFinite(dCur)) return;
      const dBoss = bossA ? dist(t.x, t.y, bossA.x, bossA.y) : Infinity;
      const dShop = shopA ? dist(t.x, t.y, shopA.x, shopA.y) : Infinity;
      const gain = t.iNum == null ? 0 : t.iNum;
      const score = gain - dCur / 2 - (dBoss / 5 || 0) - (dShop / 6 || 0);
      if (score > bestScore || (score === bestScore && best && t.at > best.at)) {
        best = t;
        bestScore = score;
      }
    }, this);
    return best ? { x: best.x, y: best.y } : null;
  }

  /**
   * 通用就近选择：过滤点型/在位状态，排除当前点/当日拉黑；`skipConsumed=true` 时另排除消费点并顺带清陈旧账。
   * @param {string} curKey 当前点位键
   * @param {function(object):boolean} accept 点型与状态谓词
   * @param {boolean} skipConsumed 是否跳过消费账（巡航档要、店/平台/营帐档不要——店与平台看引擎自身进度，不靠本账防重）
   * @returns {{x:number,y:number}|null}
   */
  #nearestBy(curKey, accept, skipConsumed) {
    const now = Date.now();
    const cx = Number(curKey.split(',')[0]);
    const cy = Number(curKey.split(',')[1]);
    let best = null;
    let bestD = Infinity;
    this.#tiles.forEach(function (t, k) {
      if (k === curKey) return;
      if (!accept(t)) return;
      if (this.#dayBlack[k]) return;
      if (skipConsumed) {
        if (this.#consumed.get(k) === -1) return; // 当日拉黑哨兵
        if ((this.#consumed.get(k) || 0) > now) return;
      }
      const d = dist(t.x, t.y, cx, cy);
      if (d < bestD || (d === bestD && best && t.at > best.at)) {
        best = t;
        bestD = d;
      }
    }, this);
    return best ? { x: best.x, y: best.y } : null;
  }

  // ── 发包与相位推进 ──────────────────────────────────────────────────

  /**
   * 发一笔 8521 并进入 TO 相位。`cand` 为 null（快照内无候选）时**不转移也不凭空造**，只留一次性提示。
   * @param {string} kind 目的地档位标记（evade/return/boss-plane/shop/cruise）
   * @param {{x:number,y:number}|null} cand 候选点（null=无证据）
   * @param {boolean} [bypassGate] 自愈包专用：跳过 sendMarch 的客户端在途拦闸（幽灵条目堵的正是这道闸；裸协议不受它约束）
   */
  #dispatch(kind, cand, bypassGate) {
    const env = this.#env;
    if (!cand) {
      // 回攻无落点：放弃待办转常规重评；其余档位保留需求位，等快照补上再试
      if (kind === 'return') {
        this.#returnPending = false;
        this.#note('return-none', 'drive: 回攻无可落平台，转常规重评。reason=no_platform');
      } else {
        this.#note(
          'none|' + kind,
          'drive: ' + kind + ' 档在视口快照内无可用候选点，驻留重扫。reason=no_candidate',
        );
      }
      return;
    }
    // 逃袭时把停泊现场留档给回攻档（仅 BOSS 相关点会用到；非 BOSS 点置 null 防陈旧）
    if (kind === 'evade') {
      const base = env.secret.getRoomBaseInfo();
      const curPt = Number((base && base.pointType) || 0);
      const k = base && base.startPoint ? tileKey(base.startPoint.x, base.startPoint.y) : '';
      const t = (k && this.#tiles.get(k)) || null;
      this.#escapeFrom = isBossish(curPt)
        ? {
            x: Number(base.startPoint.x),
            y: Number(base.startPoint.y),
            pt: curPt,
            esrId: t ? t.esrId : null,
          }
        : null;
      this.#returnPending = isBossish(curPt);
    }
    const ret = bypassGate
      ? env.secret.sendSecret(CMD_MARCH_MOVE, { x: cand.x, y: cand.y })
      : env.secret.sendMarch(cand.x, cand.y);
    if (!ret || typeof ret.then !== 'function') {
      env.log.debug('drive: 8521 not sent (in-flight/invalid coords), retry next tick.');
      return;
    }
    this.#toKind = kind + '|(' + cand.x + ',' + cand.y + ')';
    this.#toXY = tileKey(cand.x, cand.y);
    this.#toAt = Date.now();
    // 逃袭转移后给一段静默（实测整条开车闭环 31~44s，与 warn.js warnMoveCooldownMs 同档）：
    //   防「威胁位反复置位 → 同拍向反复跳变」把行军打成抽风（应答里的短退避另走 rejectBackoffMs）
    if (kind === 'evade') this.#cooldownUntil = Date.now() + tuning.warnMoveCooldownMs;
    env.log.info('drive: goto %s reason=%s', this.#toKind, kind);
    const self = this;
    ret.then(function (r) {
      const env2 = self.#env;
      if (!env2.alive()) return;
      if (r && r.code === CODE_NOT_SENT) return; // 未上线不作任何记账，下一拍重评
      const ok = r && (r.ok === undefined ? Number(r.code) === 0 : !!r.ok);
      if (ok) return; // 上线成功：相位推进交给到达复核/超时兜底
      const rej = (r && r.reason) || '';
      if (rej === REJ_ALREADY_THERE) {
        // 已在该点：不必等行军，直接进驻留
        self.#enterWork(self.#toXY);
        return;
      }
      if (rej === REJ_NO_MARCH_TARGET) {
        self.#dayBlack[self.#toXY] = 1;
        env2.log.info('drive: (%s) 不可行军(163)，当日不再选。', self.#toXY);
        self.#clearTo();
        self.#cooldownUntil = Date.now() + tuning.rejectBackoffMs;
        return;
      }
      env2.log.info(
        'drive: goto %s 被拒 (%s)，%ds 后重评。',
        self.#toKind,
        rej || 'code ' + (r && r.code),
        Math.round(tuning.rejectBackoffMs / 1000),
      );
      self.#clearTo();
      self.#cooldownUntil = Date.now() + tuning.rejectBackoffMs;
    });
  }

  /**
   * 进入 WORK 相位（到达确认成功那一刻置位）；按到达点 pointType 选退出模式：
   *   173/163 → 'empty'（拿空即走 + driveEmptyDwellMs settle + driveWorkMaxMs 兜底）；
   *   161 → 'dwell'（driveShopDwellMs，到店即置 #shopErrandDone）；其余 → 'dwell'（driveWorkDwellMs）。
   * @param {string} key 到达点位键
   */
  #enterWork(key) {
    this.#toKind = '';
    this.#toXY = key;
    this.#toAt = 0;
    this.#workEmptyAt = 0;
    this.#workDeadline = 0;
    const env = this.#env;
    const base = env.secret.getRoomBaseInfo();
    const pt = Number((base && base.pointType) || 0);
    const d = env.cfg().drive || {};
    const now = Date.now();
    if (pt === PAB_RESOURCE || pt === PAB_DROP) {
      this.#workMode = 'empty';
      this.#workUntil = 0;
      this.#workDeadline = now + tuning.driveWorkMaxMs;
    } else if (pt === PAB_SHOP) {
      const ms = Number.isFinite(d.shopDwellMs) ? d.shopDwellMs : tuning.driveShopDwellMs;
      this.#workMode = 'dwell';
      this.#workUntil = now + ms;
      this.#shopErrandDone = true; // 到店即视作「大BOSS 前那趟商店」已办
    } else {
      this.#workMode = 'dwell';
      this.#workUntil = now + tuning.driveWorkDwellMs;
    }
    if (this.#escapeFrom && key === tileKey(this.#escapeFrom.x, this.#escapeFrom.y)) {
      this.#escapeFrom = null; // 已回到逃离现场，留档消费
    }
    env.log.info('drive: arrived %s (pt=%s)，进入 %s 相位。', key, pt, this.#workMode);
  }

  /**
   * WORK 相位一拍推进：返回本拍是否离点与未到点时的下拍睡眠。
   *   'empty'：命中 #isTileEmpty → 拿空后驻 settle 再离；未到拿空且超 #workDeadline → 兜底强制离。
   *   'dwell'：到 #workUntil 即离。
   * @param {number} now Date.now 毫秒
   * @returns {{leave:boolean,sleep:number}}
   */
  #workTick(now) {
    const env = this.#env;
    if (this.#workMode === 'empty') {
      if (this.#isTileEmpty(this.#toXY)) {
        if (!this.#workEmptyAt) this.#workEmptyAt = now;
        const d = env.cfg().drive || {};
        const settle = Number.isFinite(d.emptyDwellMs) ? d.emptyDwellMs : tuning.driveEmptyDwellMs;
        const readyAt = this.#workEmptyAt + settle;
        if (now >= readyAt) return { leave: true, sleep: 0 };
        return { leave: false, sleep: readyAt - now };
      }
      this.#workEmptyAt = 0;
      if (now >= this.#workDeadline) {
        env.log.info('drive: %s 未探到拿空、兜底上限离点。reason=empty_ceiling', this.#toXY);
        return { leave: true, sleep: 0 };
      }
      return { leave: false, sleep: Math.min(tuning.driveScanMs, this.#workDeadline - now) };
    }
    if (now < this.#workUntil) return { leave: false, sleep: this.#workUntil - now };
    return { leave: true, sleep: 0 };
  }

  /**
   * 点位是否已「拿空」（基于 #change 按点记账的剩余空闲数）：
   *   res → bagFree==0 且 buffFree==0；drop → dropFree==0 且 beastFree==0。无 CHANGE 证据回 false（不判空）。
   * @param {string} key 点位键
   * @returns {boolean}
   */
  #isTileEmpty(key) {
    if (!key) return false;
    // ① 过渡路：CHANGE 按点记账（我们在拾、或到点前有人刚拾）——item+buff（res）/ item+宠物（drop）都空才算拿空
    const c = this.#change.get(key);
    if (c) {
      if (c.kind === 'res' && c.bagFree <= 0 && c.buffFree <= 0) return true;
      if (c.kind === 'drop' && c.dropFree <= 0 && c.beastFree <= 0) return true;
    }
    // ② 当前态路：读 10018 快照，解决「到点前已被别人采空、之后无人再碰 → 无 CHANGE」的死等（报文实证三份完整录像）
    //   173 rTime 落在未来 = 井已被抽空、正在刷新冷却；但 rTime 只覆盖 bag，若 CHANGE 显示仍有 buffFree>0 则不据此判空。
    //   163 iNum<=0 = 无可拾条目（iNum 缺列存 null，绝不当作 0）。
    const t = this.#tiles.get(key);
    if (t) {
      if (t.pt === PAB_RESOURCE) return t.rTime > Date.now() && !(c && c.buffFree > 0);
      if (t.pt === PAB_DROP) return t.iNum != null && t.iNum <= 0;
    }
    return false;
  }

  /**
   * 是否到达「大BOSS 前定点商店」的触发时刻（elapsed = now − fightBeginTime ≥ driveShopPointsSec[0]）。
   * @returns {boolean} fightBegin 读不到回 false（无整场锚就不强行勤务）
   */
  #preBossShopDue() {
    const pts = tuning.driveShopPointsSec;
    const first = Array.isArray(pts) && pts.length ? Number(pts[0]) : 600;
    const fb = this.#matchFightBegin;
    if (!(fb > 1e11)) return false;
    return (Date.now() - fb) / 1000 >= first;
  }

  /** 清除 TO 相位标记（被拒/超时时；驻留相位独立由 #workUntil 承载）。 */
  #clearTo() {
    this.#toKind = '';
    this.#toXY = '';
    this.#toAt = 0;
  }

  /**
   * 记一次消费（点位解禁时刻 = now + TTL；当日拉黑的点写 -1 哨兵）。顺带清陈旧账防 Map 无界增长。
   * @param {string} key 点位键
   */
  #consume(key) {
    if (!key) return;
    const now = Date.now();
    this.#consumed.set(key, now + tuning.driveConsumedTtlMs);
    this.#consumed.forEach(function (until, k) {
      if (until !== -1 && until <= now) this.#consumed.delete(k);
    }, this);
  }

  /**
   * 点位是否被本引擎拉黑/消费（回攻档用——回攻不查消费账，但拉黑点必须绕开）。
   * @param {object} t 快照条目
   * @returns {boolean}
   */
  #isBlocked(t) {
    const k = tileKey(t.x, t.y);
    return !!this.#dayBlack[k];
  }

  /**
   * 发完一笔后的下拍睡眠：发出 → 0（由 TO 在途闸接住）；没发出 → 兜底。
   * @returns {number}
   */
  #sleepAfterDispatch() {
    return this.#toKind ? 0 : tuning.driveScanMs;
  }

  // ── 业务判据（全部只读）─────────────────────────────────────────────

  /**
   * 是否存在「可开往/可回攻」的活 BOSS：getBossBaseInfo 里有 state===21 且战斗窗口未散场
   *   （stateEndTime 是 Int64 **毫秒**，实证推翻旧「秒」口径；读不到合理毫秒值一律放行，与 boss.js #fightOver 同判据）。
   * @returns {boolean}
   */
  #hasLiveBoss() {
    const list = this.#env.secret.getBossBaseInfo();
    if (!Array.isArray(list)) return false;
    const now = Date.now();
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      if (!s || Number(s.state) !== ST_BOSS_FIGHTING) continue;
      const end = toNum(s.stateEndTime);
      if (end > 1e11 && now > end) continue; // 已散场
      return true;
    }
    return false;
  }

  /**
   * 是否有一只 BOSS 在**开台读秒窗**（state22）且距开启 ≤ tuning.driveBossLeadMs（借鉴竞品B plane_time 预置档）：
   *   state22 的 stateEndTime = 转 21 的绝对毫秒时刻（constants 21535 段实证 boss9 翻转时刻对齐）；读不到合理毫秒值
   *   不进预置档（不拿猜测的开启时刻赌行程）。命中时把本体坐标存进 #bossLead，供预置档按「距 BOSS 最近平台」择优。
   * @returns {boolean}
   */
  #liveBossLead() {
    this.#bossLead = null;
    const list = this.#env.secret.getBossBaseInfo();
    if (!Array.isArray(list)) return false;
    const now = Date.now();
    let best = Infinity;
    let bestPos = null;
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      if (!s || Number(s.state) !== ST_PLANE_MARCH) continue;
      const open = toNum(s.stateEndTime);
      if (!(open > 1e11)) continue;
      const left = open - now;
      if (left < 0 || left > tuning.driveBossLeadMs) continue;
      if (left < best && s.pos) {
        best = left;
        bestPos = { x: Math.floor(toNum(s.pos.x)), y: Math.floor(toNum(s.pos.y)) };
      }
    }
    if (!bestPos) return false;
    this.#bossLead = bestPos;
    return true;
  }

  /**
   * 是否在拍普通异能兽（verbatim boss.js #captureBusy 同判据：capturingPetPos.x>0 且非 BOSS 窗）。
   * @returns {boolean}
   */
  #captureBusy() {
    const pab = this.#env.secret.getPabController();
    const cap = pab && pab.capturingPetPos;
    if (!cap) return false;
    return toNum(cap.x) > 0 && Number(cap.boss) !== 1;
  }

  /**
   * 商店补货是否有缺口（与 shop.js 同口径的轻量预筛，**不重复 shop 的进度账**）：
   *   pickItems 任一行 `shop=1` 的 `item:{itemId}`，当前持有 getItemNumById < 目标 T
   *   （T = max>0 ? max : ITEM.para1_v1 携带上限；两者都取不到 = 无上限语义 → 按「有余量」判持有 < 上限不成立时不去）。
   *   para1_v1 读不到时该行**不算缺口**（宁可不跑也不空烧刷新币/行程——到店档由勾了店的行自身兜底）。
   * @returns {boolean}
   */
  #shopGapWanted() {
    const env = this.#env;
    const items = env.cfg().pickItems || {};
    const keys = Object.keys(items);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (k.indexOf(KEY_ITEM) !== 0) continue;
      const row = items[k];
      if (!row || Number(row.shop) !== 1) continue;
      const itemId = Number(k.slice(KEY_ITEM.length));
      if (!(itemId > 0)) continue;
      let cap = Number(row.max) || 0;
      if (cap <= 0) {
        let r = null;
        try {
          r = env.l10n.tableRow(TABLE_ITEM, itemId);
        } catch (e) {
          /* 行读不到 → 保持 null，cap 回 0，该行不算缺口 */
        }
        cap = Number(r && r.para1_v1) || 0;
      }
      if (!(cap > 0)) continue; // 无上限目标读不到 → 不算缺口
      if (env.secret.getItemNumById(itemId) < cap) return true;
    }
    return false;
  }

  /**
   * 一次性 info 提示（同 key 只提一次，防逐拍刷屏）。
   * @param {string} key 提示键
   * @param {string} msg 文本
   */
  #note(key, msg) {
    if (this.#told[key]) return;
    this.#told[key] = 1;
    this.#env.log.info(msg);
  }

  /**
   * 闸门状态边沿日志（进入/恢复各打一条 info，防「一次都没动」实战无从定责）。
   * @param {string} name 闸名
   * @param {boolean} on 本拍是否被该闸拦住
   * @param {string} detail 附注（拼进日志尾）
   */
  #gateState(name, on, detail) {
    const k = 'gate|' + name;
    const tail = detail ? ' ' + detail : '';
    if (on && !this.#told[k]) {
      this.#told[k] = 1;
      this.#env.log.info('drive: 闸[%s]拦住，方向盘不动。reason=%s%s', name, name, tail);
    } else if (!on && this.#told[k]) {
      delete this.#told[k];
      this.#env.log.info('drive: 闸[%s]放行。reason=%s%s', name, name, tail);
    }
  }

  // ── 生命周期 ────────────────────────────────────────────────────────

  /**
   * 启动：订阅 21534/10018/21529/21521/21535（退订由 reactor 托管）+ 建循环并点火。
   * @param {object} ctx reactor 上下文
   */
  start(ctx) {
    const env = this.#env;
    const self = this;
    this.#active = true;
    this.#tiles = new Map();
    this.#consumed = new Map();
    this.#dayBlack = {};
    this.#threat = false;
    this.#escapeFrom = null;
    this.#returnPending = false;
    this.#clearTo();
    this.#workUntil = 0;
    this.#workMode = '';
    this.#workEmptyAt = 0;
    this.#workDeadline = 0;
    this.#change = new Map();
    this.#shopErrandDone = false;
    this.#matchFightBegin = 0;
    this.#cooldownUntil = 0;
    this.#told = {};
    if (ctx && ctx.on && typeof ctx.on.push === 'function') {
      ctx.on.push(PUSH_SELF_ATTACKED, function (ev) {
        if (self.#active && env.realmActive()) self.onWarnPush(ev);
      });
      ctx.on.push(PUSH_TILE_INFO, function (ev) {
        if (self.#active && env.realmActive()) self.onTilePush(ev);
      });
      // 到达（21529）与现场刷新（21521）、BOSS 状态机（21535）都只作 kick：业务态一律重读
      ctx.on.push(PUSH_TEAM_ARRIVE, function () {
        if (self.#active && env.realmActive()) self.onArriveWake();
      });
      ctx.on.push(PUSH_BASE_INFO, function () {
        if (self.#active && env.realmActive()) self.onArriveWake();
      });
      ctx.on.push(PUSH_BOSS_STATE, function () {
        if (self.#active && env.realmActive()) self.#cycle && self.#cycle.kick();
      });
      // 21522/21532 CHANGE 事件（pickup 同源通道）：只写按点拿空账、命中当前 WORK 点才 kick
      if (typeof ctx.on.event === 'function') {
        ctx.on.event(EVT_RES_LIBRARY_UPDATE, function (e) {
          if (self.#active && env.realmActive()) self.onResChange(e);
        });
        ctx.on.event(EVT_REWARD_BOX_UPDATE, function (e) {
          if (self.#active && env.realmActive()) self.onDropChange(e);
        });
      }
    } else {
      env.log.warn('drive: ctx.on.push unavailable, cannot subscribe 21534/10018 (engine idle).');
    }
    this.#cycle = createCycle({
      log: env.log,
      alive: function () {
        return self.#active && env.alive();
      },
      run: function () {
        return self.#tick();
      },
      fallback: tuning.driveScanMs,
    });
    this.#cycle.kick();
    env.log.info(
      'drive engine started (evade→tent, return, boss-plane, shop, cruise; leader-only).',
    );
  }

  /** 停止：置死 #active、收循环与全部本地账（事件退订由 reactor 统一摘）。 */
  stop() {
    this.#active = false;
    this.#cycle = null;
    this.#tiles = new Map();
    this.#consumed = new Map();
    this.#dayBlack = {};
    this.#threat = false;
    this.#escapeFrom = null;
    this.#returnPending = false;
    this.#clearTo();
    this.#workUntil = 0;
    this.#workMode = '';
    this.#workEmptyAt = 0;
    this.#workDeadline = 0;
    this.#change = new Map();
  }
}
