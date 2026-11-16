/**
 * 攻击警告应对引擎（异能秘境：21534 收到「有其他队盯上我」→ 按玩家选的档位处置）。
 *
 * 面板「攻击警告」两档（本引擎据此实现）：
 *   • 触发档位 = **num>0 立即转移**（不做存活窗去抖：只要 push 21534 带来 num>0 就进入转移流程）；
 *   • 转移目的地 = **就近找 174 COMMON_PLANE / 175 TENT 营帐/平台**（发 8521 过去），不是固定安全屋（游戏无回城/撤回原语，见下）。
 *   另一档 = **抗争到底**（不发任何转移包，原地应战）——即本引擎在该档下完全不动作。
 *
 * 为什么「只能发 8521 去某瓦片」：verbatim RealPabController.sendToBuildingMarch = `checkRequestIdNoRes(8521)||sendPBV2(8521,{x,y})`，
 *   这是**全仓唯一能主动挪队伍的口**。游戏侧攻击警告面板（PabWorldUINew.updateAttackWarnState）只画红点、**没有撤离/应战按钮**，
 *   所以「立即转移/抗争到底」两选项必须我们实装。其余候选口都不对：8589 LEAVE 是整场退出、8552 REVIVE 是战败复活、8551 CALL_HELP 只是发联盟聊天。
 *
 * 「营帐/平台」是合法转移落点（源码依据）：
 *   • NWorldMapTileClickUtils：点击 `PAB_TENT / PAB_COMMON_PLANE / PAB_ALLY_HELP` → `OpenUI(NWorldPabBuildingCommonPopup)`；
 *   • NWorldPabBuildingCommonPopup.catchPetFinishPlane：`marchBtnNode.active = isTeamLeader()` → 该 popup 带「前往」行军按钮（队长可用）；
 *   • NWorldMapMarchTools：`PAB_ROOM_MOVE`（即 8521 那族行军）的行军线端点集含 `[PAB_ALLY_HELP,PAB_MONSTER,PAB_RESOURCE,PAB_COMMON_PLANE,PAB_TENT,PAB_BOSS_PLANE]`。
 *   ⚠ 174/175 只作**名义候选**：21529 arrive 落在 173/172/176/178/177/161/179，不落 174/175，
 *     且 10018 瓦片快照里 **174 出现 0 次、175 出现 420 次** → 实际能就近落到的基本都是 175 营帐；174 只作名义候选保留。
 *
 * 料源与安全过滤（只读，不改游戏数据）：
 *   • 停靠现场 = ACL getRoomBaseInfo()（队级快照：startPoint/marchState/pointType）；只在 marchState=ARRIVED 且验真通过时转移；
 *     警告验真（1115 复核，与 pilot 同口径）：本点新鲜快照确证无敌方 UID → 误告（BOSS 争夺计数/到点噪声）不转移；
 *     BOSS 平台与玩家是 1 局定胜负：transfer 档验真后照常撤离（不再无条件豁免），抗争到底档本引擎完全不动作；
 *   • 就近营帐取自本引擎自己维护的 10018 快照（视口增量，覆盖范围天然受限 → 快照里没有就**不转移**，绝不凭空造坐标）；
 *   • 落点优先「未被 PVP」（瓦片 `m.state ∉ {11,12}`，verbatim WIPabResource 的本地判据）与「无驻军」；同距取更空者。
 *
 * 频控与红线：只走 ACL sendMarch 发 8521；转移后 warnMoveCooldownMs(45s) 静默（整条开车闭环 31~44s，不到达不重评）；
 *   **仅队长可发**（8521 驱动全队那一条行军，多人房各发会互抢方向盘）；非秘境/未激活/关闭档一律长睡。Int64 无（8521 载荷是标量 {x,y}）。
 */
import { createCycle } from '../../../core/cycle.js';
import { tileKey as utilTileKey, dist as utilDist } from './util.js';
import {
  PUSH_SELF_ATTACKED,
  PUSH_TILE_INFO,
  PAB_TENT,
  PAB_COMMON_PLANE,
  PAB_RESOURCE,
  PAB_MONSTER,
  PAB_BOSS_PLANE,
  PAB_BOSS,
  PAB_BOSS_GUARD,
  ST_PVP_READY,
  ST_PVP_FIGHTING,
  CODE_NOT_SENT,
  tuning,
} from './constants.js';
import { GateStateLog } from './gate-log.js';

/**
 * 点位键（与 boss.js 同口径的本地小工具；非法坐标回 ''）。
 * @param {number} x 横号
 * @param {number} y 纵号
 * @returns {string}
 */
function tileKey(x, y) {
  return utilTileKey(x, y);
}

/**
 * 两瓦片欧氏格距（任一非法回 Infinity，排序落最后、不进「就近」）。
 * @param {number} ax 甲横
 * @param {number} ay 甲纵
 * @param {number} bx 乙横
 * @param {number} by 乙纵
 * @returns {number}
 */
function dist(ax, ay, bx, by) {
  return utilDist(ax, ay, bx, by);
}

/**
 * 攻击警告应对引擎：push 21534/10018 驱动 + createCycle 电平兜底（事件 kick 为主，本循环负责冷却/重扫）。
 */
export class WarnEngine {
  #env;
  /** @type {{kick:Function}|null} */
  #cycle = null;
  /** @type {boolean} 存活位（stop 置 false 后旧 cycle 定时器到点即终止） */
  #active = false;
  /** @type {Map<string,{pt:number,x:number,y:number,state:number,teams:number,teamUids:?string[],at:number}>} 174/175/173/172 落点 + BOSS 点验真瓦片快照 */
  #tiles = new Map();
  /** @type {boolean} 是否有待处置的 num>0 警告（事件置位、转移成功后清除） */
  #pendingWarn = false;
  /** @type {number} 冷却截止时刻（Date.now 毫秒；到点前不再发新的转移包） */
  #cooldownUntil = 0;
  /** @type {boolean} 是否有一条 8521 转移在途（防并发） */
  #marchInFlight = false;
  /** @type {Object<string,1>} 已打过的 info 提示键（防刷屏） */
  #told = {};
  /** @type {GateStateLog} 静默睡过出口的门控边沿日志（不参与判定） */
  #gates;

  /** @param {object} env 注入底座 {alive, realmActive, cfg, secret, log} */
  constructor(env) {
    this.#env = env;
    this.#gates = new GateStateLog(env.log, 'warn');
  }

  /**
   * push 21534 落地：num>0 立即置位待发警告并 kick（用户档=不做存活窗去抖）。num===0 只清「待处置」里“已冷却且非新警”的陈旧态，不动在途。
   * @param {object} ev bus `net.21534` 事件（载荷平铺在 ev.data，net 已剥 pbAckV2 信封）
   */
  onWarnPush(ev) {
    const d = (ev && ev.data) || {};
    const num = Number(d.num) || 0;
    if (num > 0) {
      this.#pendingWarn = true;
      if (this.#cycle) this.#cycle.kick();
    }
  }

  /**
   * push 10018 落地：只收 174/175 营帐/平台瓦片，写进 #tiles（**不 kick**——3 条/秒，kick 会把兜底拍打成 3Hz）。
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
      // 需求 1/5：立即转移落点不再只认 174/175（录制实证车多停在 173 资源点且快照几乎不含 174/175），
      //   扩到任意可行军点 {175 营帐, 174 平台, 173 资源, 172 野怪}，走过去即脱离拉线（本引擎发的是转移行军、不打野）。
      //   BOSS 点（176/177/178）只作警告验真料（本点占用 UID），不作转移落点（见 #nearestSafeTent）。
      if (
        pt !== PAB_TENT &&
        pt !== PAB_COMMON_PLANE &&
        pt !== PAB_RESOURCE &&
        pt !== PAB_MONSTER &&
        pt !== PAB_BOSS_PLANE &&
        pt !== PAB_BOSS &&
        pt !== PAB_BOSS_GUARD
      )
        continue;
      const k = tileKey(p.x, p.y);
      if (!k) continue;
      const m = p.m && typeof p.m === 'object' ? p.m : {};
      if (this.#tiles.size >= tuning.tileExtMax && !this.#tiles.has(k)) {
        const first = this.#tiles.keys().next();
        if (!first.done) this.#tiles.delete(first.value);
      }
      this.#tiles.set(k, {
        pt: pt,
        x: Math.floor(Number(p.x)),
        y: Math.floor(Number(p.y)),
        state: Number(m.state) || 0,
        teams: Array.isArray(m.teams) ? m.teams.length : 0,
        // 占用队 UID 列表（警告验真料，1115）：无 teams 字段=null（证据不足 fail-safe）。
        teamUids: Array.isArray(m.teams)
          ? m.teams.map((t) => String((t && t.uid) || '')).filter(Boolean)
          : null,
        at: now,
      });
    }
  }

  /**
   * 一拍：警告挂起 + 冷却已过 + 停稳(ARRIVED) + 验真通过 + 队长 → 就近发一笔 8521 去营帐。永不 reject。
   * @returns {number} 下拍睡眠（毫秒）
   */
  #tick() {
    const env = this.#env;
    const g = this.#gates;
    if (!env.alive()) return 0;
    if (g.edge('realm-off', !env.realmActive(), 'not in pab realm')) return tuning.warnScanMs;
    const w = env.cfg().warn;
    if (g.edge('cfg-off', !w || !w.enabled || w.mode !== 'transfer', 'warn.mode!=transfer')) {
      this.#pendingWarn = false; // 「抗争到底」或关档：不动作，也不留待发警告
      return tuning.warnScanMs;
    }
    // 自动驾驶让闸：drive.enabled 时非 BOSS 点的受击转移由 pilot.js EVADE 承担（纯就近、与回攻状态机联动），
    //   本引擎的「BOSS 点不抢方向盘」特化失去意义 → 交出 8521 发送权；关掉自动驾驶时本引擎行为完全不变（手动开车档仍可用）。
    const drv = env.cfg().drive;
    if (drv && drv.enabled) {
      this.#pendingWarn = false;
      this.#note(
        'drive-off',
        'warn: auto-drive is on, hit-relocation is handled by the unified drive steering, this engine yields the gate.',
      );
      return tuning.warnScanMs;
    }
    const now = Date.now();
    if (
      g.edge(
        'cooldown',
        now < this.#cooldownUntil,
        'left=' + Math.max(0, this.#cooldownUntil - now) + 'ms',
      )
    )
      return this.#cooldownUntil - now;
    if (g.edge('no-pending', !this.#pendingWarn, 'no 21534 num>0 warning pending'))
      return tuning.warnScanMs;
    if (g.edge('march-inflight', this.#marchInFlight, '8521 relocate in flight'))
      return tuning.warnScanMs;

    const base = env.secret.getRoomBaseInfo();
    if (g.edge('no-base', !base || !base.startPoint, 'no roomBaseInfo/startPoint'))
      return tuning.warnScanMs;
    const S = env.secret.getNMarchState();
    const arrived = S && S.ARRIVED != null ? Number(S.ARRIVED) : 2;
    if (g.edge('not-arrived', Number(base.marchState) !== arrived, 'marchState=' + base.marchState))
      return tuning.warnScanMs;
    if (g.edge('not-mooring', !env.secret.teamIsMooring(), 'team not mooring'))
      return tuning.warnScanMs;
    // 警告验真（1115 复核，与 pilot 同口径）：本点确证无敌方 UID → 误告（BOSS 争夺计数/到点噪声），不转移。
    //   BOSS 平台与玩家是 1 局定胜负：transfer 档验真后照常撤离（不再无条件豁免）；证据不足 fail-safe 照转。
    const noFoeKey = this.#warnNoFoeHere(base);
    if (noFoeKey) {
      this.#pendingWarn = false;
      env.log.debug(
        'warn: num>0 at %s ignored: no foe uid on tile (contest/arrival noise). reason=warn_no_foe',
        noFoeKey,
      );
      return tuning.warnScanMs;
    }
    if (
      g.edge('not-leader', !env.secret.isTeamLeader(), '8521 drives whole-team march, leader only')
    )
      return tuning.warnScanMs;

    const cx = Number(base.startPoint.x);
    const cy = Number(base.startPoint.y);
    const dst = this.#nearestSafeTent(cx, cy);
    // 快照里没有可落地的就近营帐 → 不凭空造目标，保持待发并按 warnScanMs 重扫（视口刷新会补上快照）
    if (g.edge('no-tent', !dst, 'no tent candidate in viewport snapshot')) return tuning.warnScanMs;
    this.#doTransfer(dst, cx, cy);
    return tuning.warnScanMs;
  }

  /**
   * 警告验真（1115 复核，与 pilot#warnNoFoeHere 同口径）：21534 恒只有 {num} 不带 UID；
   *   本点新鲜快照（≤tuning.warnVerifyAgeMs）且带 teamUids 列表、确证无本队外 uid → 误告
   *   （BOSS 争夺计数/到点噪声）→ 回点位键；证据不足（无快照/超龄/无 uid 列表）回 null，fail-safe 按真攻击处置。
   * @param {object} base 队级快照（startPoint/members）
   * @returns {string|null} 误告时回本点键，否则 null
   */
  #warnNoFoeHere(base) {
    const env = this.#env;
    const p = base && base.startPoint;
    if (!p) return null;
    const k = tileKey(Math.floor(Number(p.x)), Math.floor(Number(p.y)));
    if (!k) return null;
    const t = this.#tiles.get(k);
    if (!t || Date.now() - (t.at || 0) > tuning.warnVerifyAgeMs) return null;
    if (!Array.isArray(t.teamUids)) return null;
    const mine = new Set();
    const me = env.gameData && env.gameData.myUidStr ? env.gameData.myUidStr() : '';
    if (me) mine.add(String(me));
    const mem = base && Array.isArray(base.members) ? base.members : [];
    for (let i = 0; i < mem.length; i++) {
      if (mem[i] && mem[i].uid != null) mine.add(String(mem[i].uid));
    }
    for (let i = 0; i < t.teamUids.length; i++) {
      if (!mine.has(t.teamUids[i])) return null;
    }
    return k;
  }

  /**
   * 就近安全营帐：排除当前点与 BOSS 点（只作验真料），优先「未被 PVP(state∉{11,12})」→ 距当前点最近 → 驻军更少。全被 PVP 则回 null（不转移）。
   * @param {number} cx 当前横
   * @param {number} cy 当前纵
   * @returns {{x:number,y:number,pt:number}|null}
   */
  #nearestSafeTent(cx, cy) {
    let best = null;
    let bestD = Infinity;
    this.#tiles.forEach((t) => {
      if (t.x === cx && t.y === cy) return; // 别原地打转
      if (t.pt === PAB_BOSS_PLANE || t.pt === PAB_BOSS || t.pt === PAB_BOSS_GUARD) return; // BOSS 点不作转移落点
      if (t.state === ST_PVP_READY || t.state === ST_PVP_FIGHTING) return; // 正被 PVP 的点不作落点
      const d = dist(t.x, t.y, cx, cy);
      if (!best || d < bestD || (d === bestD && t.teams < best.teams)) {
        best = t;
        bestD = d;
      }
    });
    return best ? { x: best.x, y: best.y, pt: best.pt } : null;
  }

  /**
   * 发一笔 8521 转移到营帐。成功→ 记 45s 冷却并清待发；被拒→ 短冷却（不重复撞同一点）并保留待发（下次警告/重扫再试）。
   * @param {{x:number,y:number,pt:number}} dst 目标营帐
   * @param {number} cx 当前横
   * @param {number} cy 当前纵
   */
  #doTransfer(dst, cx, cy) {
    const env = this.#env;
    const p = env.secret.sendMarch(dst.x, dst.y);
    if (!p) {
      // sendMarch 内部在途闸拦下（8521 已有一条未回）→ 下一拍再判
      return;
    }
    this.#marchInFlight = true;
    p.then(
      function (r) {
        this.#marchInFlight = false;
        if (!env.alive()) return;
        const ok = r && (r.ok === undefined ? Number(r.code) === 0 : !!r.ok);
        if (ok) {
          this.#cooldownUntil = Date.now() + tuning.warnMoveCooldownMs;
          this.#pendingWarn = false;
          env.log.info(
            'warn: warning relocated from (%d,%d) to tent (%d,%d)[%d], cooldown %ds.',
            cx,
            cy,
            dst.x,
            dst.y,
            dst.pt,
            Math.round(tuning.warnMoveCooldownMs / 1000),
          );
        } else if (r && r.code === CODE_NOT_SENT) {
          env.log.debug(
            'warn: 8521 not actually sent (secondary channel / rate-limited, code=%s), rescan later.',
            String(r && r.code),
          );
        } else {
          // 被拒（如 158 未抵达 / 157 已在该点 / 163 不可行军）：短冷却防逐拍重发，保留待发让下次警告或重扫再试
          this.#cooldownUntil = Date.now() + tuning.rejectBackoffMs;
          env.log.info(
            'warn: relocate rejected (%s), re-evaluate after %ds.',
            (r && r.reason) || 'code ' + (r && r.code),
            Math.round(tuning.rejectBackoffMs / 1000),
          );
        }
      }.bind(this),
    );
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
   * 启动：订阅 21534/10018（退订由 reactor 托管）+ 建兜底循环。
   * @param {object} ctx reactor 上下文
   */
  start(ctx) {
    const env = this.#env;
    const self = this;
    this.#active = true;
    this.#tiles = new Map();
    this.#pendingWarn = false;
    this.#cooldownUntil = 0;
    this.#marchInFlight = false;
    this.#told = {};
    this.#gates.reset();
    if (ctx && ctx.on && typeof ctx.on.push === 'function') {
      ctx.on.push(PUSH_SELF_ATTACKED, function (ev) {
        if (self.#active && env.realmActive()) self.onWarnPush(ev);
      });
      ctx.on.push(PUSH_TILE_INFO, function (ev) {
        if (self.#active && env.realmActive()) self.onTilePush(ev);
      });
    } else {
      // error 级：无 21534 推送 ⇒ 受击永远感知不到，整场不会自愈（core/log.js 第 1) 条）。
      env.log.error('warn: ctx.on.push unavailable, cannot subscribe 21534/10018 (engine idle).');
    }
    this.#cycle = createCycle({
      log: env.log,
      alive: function () {
        return self.#active && env.alive();
      },
      run: function () {
        return self.#tick();
      },
      fallback: tuning.warnScanMs,
    });
    env.log.info('warn engine started (transfer-to-nearest-tent on 21534 num>0; mode-gated).');
  }

  /** 停止：置死 #active、收循环与快照（事件退订由 reactor 统一摘）。 */
  stop() {
    this.#active = false;
    if (this.#cycle) this.#cycle.dispose();
    this.#cycle = null;
    this.#tiles = new Map();
    this.#pendingWarn = false;
    this.#marchInFlight = false;
  }
}
