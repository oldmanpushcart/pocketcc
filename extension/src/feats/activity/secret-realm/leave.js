/**
 * 拿满自动离场引擎（异能秘境：宠物携带背包被高品质填满 → 择优带出 → 发一次整场退出）。
 *
 * 面板档位（用户拍板）：**默认关**的总开关 `autoLeaveEnabled`。离场是 `8589 LEAVE` 整场退出（非「换个点」，
 *   见 constants CMD_LEAVE_AREA 条）——一旦发出就把整队从秘境战场撤下，是全 feat 不可逆性最高的一档，故不留任何子开关、
 *   只给一个默认关的总闸，且引擎内多重 fail-safe：任一判据读不到就**不离场**，绝不拿缺证据当「拿满」。
 *
 * 借鉴竞品B enigmaSecret.judgeLeave / exitStage（verbatim），但**只取其安全骨架**、不照抄它的 team_type 分层
 *   （那是竞品自己的调度语义，我方无对应概念）：
 *   • 「拿满」= 背包里 quality≥4 的高品质宠物数 ≥ 携带背包总容量（dataConfig(3017)+PabExtraPackItemNum 增益，ACL petPackCapacity）；
 *     容量读不到（回 0）/ 宠物清单读不到（beastInfo 键不存在，回 null）→ 一律不触发（见 game-api 两条 ACL 注释）；
 *   • 「可安全离场」= 已停泊（teamIsMooring）**且非在途行军**（marchState≠MARCHING）+（战斗窗口已过 或 正停在 161 商店点）
 *     ——verbatim judgeLeave 的 `!isTeamLeader() || pointType==PAB_SHOP || ServerMSTime>=fightEndTime`，我方收紧为
 *     「停稳 + 窗口结束/在商店」，绝不在队伍行军途中或 BOSS 争夺窗里撤场；
 *   • 「择优带出」= 把高品质宠物按 quality 降序取前「容量」只的 `id`（protobuf Int64）填 8581 `{itemIds:[], uuIds:[...]}`，
 *     `ok===1` 后才发 8589 `{uid:String(UID)}`（verbatim judgeLeave）。清单为空（一场没拍到宠）→ 不发离场（本档就是为「拿满」而来）。
 *
 * 频控与红线：只走 ACL sendSecret 发 8581/8589，不碰游戏 Update/Delete、不调 pabFightQuit（离场是服务器态，游戏自刷新）；
 *   **仅队长可发**（8589 撤的是全队那一次在场，多人房各自发会互撤，与 8521/8548 同口径收 isTeamLeader 闸）；
 *   一场最多一次动作（#packDone 闩锁，成功后不再发；8581 撞「未发出」则下拍重试、绝不带着未落地的选择发 LEAVE）。
 *   Int64（fightEndTime）以 toNum 读、id 原样透传给 8581（不 Number / 不字符串化，与 protectBeasts 同形态）。
 */
import { createCycle } from '../../../core/cycle.js';
import {
  CMD_LEAVE_AREA,
  CMD_BAG_GET_SET,
  PAB_SHOP,
  TABLE_BEAST,
  CODE_NOT_SENT,
  tuning,
} from './constants.js';

/** 离场「拿满」计的高品质阈值（enigma_beast 行 quality，同 pickup.js dropPetQualityMin / 竞品 exitStage 口径 >=4） */
const QUALITY_MIN = 4;

/**
 * protobuf Long / {_low,_high} / number / 字符串 → 数值（取不到回 0）。与 boss.js/capture.js/heal.js 同口径。
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
 * 拿满自动离场引擎：createCycle 电平轮询（低频，无 push 订阅；背包/容量/现场态每拍现读 ACL 落地快照）。
 */
export class LeaveEngine {
  #env;
  /** @type {boolean} 存活位（stop 置 false 后旧 cycle 定时器到点即终止；本引擎无 push 订阅、不持 cycle 句柄，无需 kick） */
  #active = false;
  /** @type {boolean} 本场是否已完成离场动作（成功/放弃后闩死，一场最多发一次 LEAVE） */
  #packDone = false;
  /** @type {boolean} 是否有一条 8581/8589 在途（防并发） */
  #inFlight = false;

  /** @param {object} env 注入底座 {alive, realmActive, cfg, secret, gameData, l10n, log} */
  constructor(env) {
    this.#env = env;
  }

  /**
   * 一拍：总闸开 + 本场未离场 + 队长 + 容量可信 + 背包被高品质填满 + 现场可安全撤场 → 择优 8581 后 8589 离场。
   * 永不 reject；任一 fail-safe 判据不满足即按 leaveScanMs 长睡（保守：读不到就不撤场）。
   * @returns {number} 下拍睡眠（毫秒）
   */
  #tick() {
    const env = this.#env;
    if (!env.alive()) return 0;
    if (!env.realmActive()) return tuning.leaveScanMs;
    const lc = env.cfg().leave;
    if (!lc || !lc.enabled) return tuning.leaveScanMs;
    if (this.#packDone || this.#inFlight) return tuning.leaveScanMs;
    // 仅队长可发（8589 撤全队那一次在场，与 8521/8548 同口径收队长闸；多人房成员侧一律不动）
    if (!env.secret.isTeamLeader()) return tuning.leaveScanMs;

    // 容量读不到（回 0）→ 「拿满」无从判起，绝不误撤场（ACL petPackCapacity 的 fail-safe 契约）
    const cap = env.secret.petPackCapacity();
    if (!(cap > 0)) return tuning.leaveScanMs;
    // 宠物清单键不存在（回 null）→ 同上；空数组是「一场没拍到宠」，也不触发（本档是为「拿满」而来）
    const pets = env.secret.getRoomBagPets();
    if (!Array.isArray(pets)) return tuning.leaveScanMs;

    const stats = this.#packStats(pets, cap);
    if (stats.count < cap) return tuning.leaveScanMs; // 高品质未满仓 → 继续拍
    if (!stats.uuIds.length) return tuning.leaveScanMs; // 无可带出的 id（形态异常）→ 不盲发离场
    if (!this.#exitSafe()) return tuning.leaveScanMs; // 现场不宜撤场（行军中/争夺窗内）→ 等下一拍

    this.#doLeave(stats.uuIds);
    return tuning.leaveScanMs;
  }

  /**
   * 背包里高品质（quality≥QUALITY_MIN）宠物计数 + 择优带出清单（按 quality 降序取前 cap 只的 id）。
   * 读不到 enigma_beast 行/字段的条目不计入「拿满」、也不占带出名额（离场侧宁可少认满、不可误判满——与 pickup
   *   品质闸的 fail-open 反向，因为这里误判满的代价是一次不可逆的整场退出）。
   * @param {Array<{cfgId:number,id:*}>} pets getRoomBagPets 副本
   * @param {number} cap 携带背包总容量
   * @returns {{count:number, uuIds:Array<*>}} count=高品质只数；uuIds=前 cap 只的 id 原值
   */
  #packStats(pets, cap) {
    const env = this.#env;
    const ranked = [];
    for (let i = 0; i < pets.length; i++) {
      const b = pets[i];
      if (!b || b.id == null) continue;
      const row = b.cfgId ? env.l10n.tableRow(TABLE_BEAST, b.cfgId) : null;
      const q = row ? Number(row.quality) : NaN;
      if (!Number.isFinite(q) || q < QUALITY_MIN) continue; // 非高品质/读不到 → 不计满、不占名额
      ranked.push({ q: q, id: b.id });
    }
    ranked.sort(function (a, b) {
      return b.q - a.q;
    });
    const uuIds = [];
    for (let i = 0; i < ranked.length && i < cap; i++) uuIds.push(ranked[i].id);
    return { count: ranked.length, uuIds: uuIds };
  }

  /**
   * 现场是否可安全撤场（verbatim judgeLeave 收紧）：已停泊且非行军途中 +（战斗窗口已过 或 正停在 161 商店点）。
   * @returns {boolean}
   */
  #exitSafe() {
    const env = this.#env;
    const base = env.secret.getRoomBaseInfo();
    if (!base) return false;
    if (!env.secret.teamIsMooring()) return false; // 未停泊（读不到/异常闭开）→ 不撤
    const S = env.secret.getNMarchState();
    const marching = S && S.MARCHING != null ? Number(S.MARCHING) : 1;
    if (Number(base.marchState) === marching) return false; // 在途行军中 → 等落定再撤
    const end = toNum(base.fightEndTime);
    const windowOver = end > 1e11 && Date.now() >= end; // 毫秒级绝对时刻且已过 → 争夺窗散场
    const atShop = Number(base.pointType) === PAB_SHOP; // 停在商店点（verbatim judgeLeave 的安全落点）
    return windowOver || atShop;
  }

  /**
   * 发「择优带出 → 离场」链路：先 8581 `{itemIds:[], uuIds}`，`ok===1` 后才发 8589 `{uid}`；
   * 8581 未真正发出（次通道频控/超时，CODE_NOT_SENT）→ 撤销在途位下拍重试，**绝不带着未落地的选择发 LEAVE**；
   * 8581 被服务器明确拒绝（非 0 且非未发出）→ 本场放弃（#packDone 闩死），不反复撞整场退出这条不可逆口。
   * @param {Array<*>} uuIds 前 cap 只高品质宠物的 id 原值（protobuf Int64）
   */
  #doLeave(uuIds) {
    const env = this.#env;
    const self = this;
    this.#inFlight = true;
    const me = env.gameData.myUidStr();
    env.secret
      .sendSecret(CMD_BAG_GET_SET, { itemIds: [], uuIds: uuIds })
      .then(function (r) {
        if (!env.alive()) {
          self.#inFlight = false;
          return;
        }
        const code = r && r.code;
        if (code === CODE_NOT_SENT || code == null) {
          // 未上线（被频控/超时）：保留待发，下一拍重选重发（选择是可逆动作，反复设同一份不伤态）
          self.#inFlight = false;
          env.log.debug('leave: 8581 带出选择未真正发出（频控/超时），稍后重试。');
          return undefined;
        }
        if (Number(code) !== 0) {
          self.#inFlight = false;
          self.#packDone = true;
          env.log.info(
            'leave: 8581 带出选择被拒（%s），本场不再尝试自动离场。',
            (r && r.reason) || 'code ' + code,
          );
          return undefined;
        }
        return env.secret.sendSecret(CMD_LEAVE_AREA, { uid: me });
      })
      .then(function (rr) {
        self.#inFlight = false;
        if (rr === undefined) return; // 8581 未上线/被拒分支已各自处理，不进离场结算
        if (!env.alive()) return;
        const lcode = rr && rr.code;
        if (Number(lcode) === 0) {
          self.#packDone = true;
          env.log.info('leave: 拿满已择优带出并发 8589 离场（整场退出）。');
        } else if (lcode === CODE_NOT_SENT || lcode == null) {
          env.log.debug('leave: 8589 离场未真正发出（频控/超时），下一拍重试整条链路。');
        } else {
          self.#packDone = true;
          env.log.info(
            'leave: 8589 离场被拒（%s），本场不再尝试。',
            (rr && rr.reason) || 'code ' + lcode,
          );
        }
      })
      .catch(function (e) {
        self.#inFlight = false;
        env.log.warn('leave: 离场链路异常。', e);
      });
  }

  /**
   * 启动：复位一场态 + 建低频兜底循环（无 push 订阅，背包/容量每拍现读）。
   * @param {object} ctx reactor 上下文（未用，签名与其它引擎对齐）
   */
  start(ctx) {
    const env = this.#env;
    const self = this;
    this.#active = true;
    this.#packDone = false;
    this.#inFlight = false;
    createCycle({
      log: env.log,
      alive: function () {
        return self.#active && env.alive();
      },
      run: function () {
        return self.#tick();
      },
      fallback: tuning.leaveScanMs,
    });
    env.log.info(
      'leave engine started (auto-exit on full-quality pet pack; default OFF, leader-only).',
    );
  }

  /** 停止：置死 #active（cycle 到点自终）、收在途位（本引擎无 push 订阅与自建定时器需显式收）。 */
  stop() {
    this.#active = false;
    this.#inFlight = false;
  }
}
