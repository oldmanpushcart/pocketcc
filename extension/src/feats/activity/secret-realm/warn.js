/**
 * 攻击警告应对引擎（异能秘境：21534 收到「有其他队盯上我」→ 按玩家选的档位处置）。
 *
 * 用户拍板的两条（本引擎据此实现）：
 *   • 触发档位 = **num>0 立即转移**（不做存活窗去抖：只要 push 21534 带来 num>0 就进入转移流程）；
 *   • 转移目的地 = **就近找 174 COMMON_PLANE / 175 TENT 营帐/平台**（发 8521 过去），不是固定安全屋（游戏无回城/撤回原语，见下）。
 *   另一档 = **抗争到底**（不发任何转移包，原地应战）——即本引擎在该档下完全不动作。
 *
 * 为什么「只能发 8521 去某瓦片」：verbatim RealPabController.sendToBuildingMarch = `checkRequestIdNoRes(8521)||sendPBV2(8521,{x,y})`，
 *   这是**全仓唯一能主动挪队伍的口**。游戏侧攻击警告面板（PabWorldUINew.updateAttackWarnState）只画红点、**没有撤离/应战按钮**，
 *   所以「立即转移/抗争到底」两选项必须我们实装。其余候选口都不对：8589 LEAVE 是整场退出、8552 REVIVE 是战败复活、8551 CALL_HELP 只是发联盟聊天。
 *
 * 为什么「营帐/平台」是合法转移落点（源码 verbatim，报文未录到该用户开到过营帐但不代表不可开）：
 *   • NWorldMapTileClickUtils：点击 `PAB_TENT / PAB_COMMON_PLANE / PAB_ALLY_HELP` → `OpenUI(NWorldPabBuildingCommonPopup)`；
 *   • NWorldPabBuildingCommonPopup.catchPetFinishPlane：`marchBtnNode.active = isTeamLeader()` → 该 popup 带「前往」行军按钮（队长可用）；
 *   • NWorldMapMarchTools：`PAB_ROOM_MOVE`（即 8521 那族行军）的行军线端点集含 `[PAB_ALLY_HELP,PAB_MONSTER,PAB_RESOURCE,PAB_COMMON_PLANE,PAB_TENT,PAB_BOSS_PLANE]`。
 *   ⚠ 报文缺口（如实标注，不阻塞落地）：全部秘境录音里 21529 arrive **从未到达过 174/175**（只到过 173/172/176/178/177/161/179），
 *     且 10018 瓦片快照里 **174 出现 0 次、175 出现 420 次** → 实际能就近落到的基本都是 175 营帐；174 只作名义候选保留。
 *
 * 料源与安全过滤（只读，不改游戏数据）：
 *   • 停靠现场 = ACL getRoomBaseInfo()（队级快照：startPoint/marchState/pointType）；只在 marchState=ARRIVED 且停在**非BOSS点**时转移
 *     （停在 176/177/178 上的警告属战斗语义，交 BOSS 档或玩家手动，本引擎绝不抢 BOSS 方向盘）；
 *   • 就近营帐取自本引擎自己维护的 10018 快照（视口增量，覆盖范围天然受限 → 快照里没有就**不转移**，绝不凭空造坐标）；
 *   • 落点优先「未被 PVP」（瓦片 `m.state ∉ {11,12}`，verbatim WIPabResource 的本地判据）与「无驻军」；同距取更空者。
 *
 * 频控与红线：只走 ACL sendMarch 发 8521；转移后 warnMoveCooldownMs(45s) 静默（实测整条开车闭环 31~44s，不到达不重评）；
 *   **仅队长可发**（8521 驱动全队那一条行军，多人房各发会互抢方向盘）；非秘境/未激活/关闭档一律长睡。Int64 无（8521 载荷是标量 {x,y}）。
 */
import { createCycle } from '../../../core/cycle.js';
import {
  PUSH_SELF_ATTACKED,
  PUSH_TILE_INFO,
  PAB_TENT,
  PAB_COMMON_PLANE,
  PAB_BOSS_PLANE,
  PAB_BOSS,
  PAB_BOSS_GUARD,
  ST_PVP_READY,
  ST_PVP_FIGHTING,
  CODE_NOT_SENT,
  tuning,
} from './constants.js';

/**
 * 点位键（与 boss.js 同口径的本地小工具；非法坐标回 ''）。
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
 * 两瓦片欧氏格距（任一非法回 Infinity，排序落最后、不进「就近」）。
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
 * 攻击警告应对引擎：push 21534/10018 驱动 + createCycle 电平兜底（事件 kick 为主，本循环负责冷却/重扫）。
 */
export class WarnEngine {
  #env;
  /** @type {{kick:Function}|null} */
  #cycle = null;
  /** @type {boolean} 存活位（stop 置 false 后旧 cycle 定时器到点即终止） */
  #active = false;
  /** @type {Map<string,{pt:number,x:number,y:number,state:number,teams:number,at:number}>} 174/175 瓦片快照 */
  #tiles = new Map();
  /** @type {boolean} 是否有待处置的 num>0 警告（事件置位、转移成功后清除） */
  #pendingWarn = false;
  /** @type {number} 冷却截止时刻（Date.now 毫秒；到点前不再发新的转移包） */
  #cooldownUntil = 0;
  /** @type {boolean} 是否有一条 8521 转移在途（防并发） */
  #marchInFlight = false;
  /** @type {Object<string,1>} 已打过的 info 提示键（防刷屏） */
  #told = {};

  /** @param {object} env 注入底座 {alive, realmActive, cfg, secret, log} */
  constructor(env) {
    this.#env = env;
  }

  /**
   * push 21534 落地：num>0 立即置位待发警告并 kick（用户档=不做存活窗去抖）。num===0 只清「待处置」里“已冷却且非新警”的陈旧态，不动在途。
   * @param {object} ev bus `net.21534` 事件（载荷平铺在 ev.data.data）
   */
  onWarnPush(ev) {
    const d = (ev && ev.data && ev.data.data) || {};
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
      if (pt !== PAB_TENT && pt !== PAB_COMMON_PLANE) continue;
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
        at: now,
      });
    }
  }

  /**
   * 一拍：警告挂起 + 冷却已过 + 停在非BOSS点(ARRIVED) + 队长 → 就近发一笔 8521 去营帐。永不 reject。
   * @returns {number} 下拍睡眠（毫秒）
   */
  #tick() {
    const env = this.#env;
    if (!env.alive()) return 0;
    if (!env.realmActive()) return tuning.warnScanMs;
    const w = env.cfg().warn;
    if (!w || !w.enabled || w.mode !== 'transfer') {
      this.#pendingWarn = false; // 「抗争到底」或关档：不动作，也不留待发警告
      return tuning.warnScanMs;
    }
    const now = Date.now();
    if (now < this.#cooldownUntil) return this.#cooldownUntil - now;
    if (!this.#pendingWarn) return tuning.warnScanMs;
    if (this.#marchInFlight) return tuning.warnScanMs;

    const base = env.secret.getRoomBaseInfo();
    if (!base || !base.startPoint) return tuning.warnScanMs;
    const S = env.secret.getNMarchState();
    const arrived = S && S.ARRIVED != null ? Number(S.ARRIVED) : 2;
    if (Number(base.marchState) !== arrived) return tuning.warnScanMs;
    if (!env.secret.teamIsMooring()) return tuning.warnScanMs;
    const curPt = Number(base.pointType) || 0;
    // 停在 BOSS 平台/本体/小BOSS 上的警告属战斗语义：交 BOSS 档或玩家手动，本引擎不抢方向盘
    if (curPt === PAB_BOSS_PLANE || curPt === PAB_BOSS || curPt === PAB_BOSS_GUARD) {
      this.#note('bosspt', 'warn: 停在 BOSS 相关点，不自动转移（战斗语义，交手动/抗争到底）。');
      return tuning.warnScanMs;
    }
    if (!env.secret.isTeamLeader()) {
      this.#note('leader', 'warn: 非队长，8521 驱动全队行军，跳过自动转移。');
      return tuning.warnScanMs;
    }

    const cx = Number(base.startPoint.x);
    const cy = Number(base.startPoint.y);
    const dst = this.#nearestSafeTent(cx, cy);
    if (!dst) {
      // 快照里没有可落地的就近营帐 → 不凭空造目标，保持待发并按 warnScanMs 重扫（视口刷新会补上快照）
      this.#note('notent', 'warn: 视口快照内暂无就近安全营帐(174/175)，暂不转移。');
      return tuning.warnScanMs;
    }
    this.#doTransfer(dst, cx, cy);
    return tuning.warnScanMs;
  }

  /**
   * 就近安全营帐：排除当前点，优先「未被 PVP(state∉{11,12})」→ 距当前点最近 → 驻军更少。全被 PVP 则回 null（不转移）。
   * @param {number} cx 当前横
   * @param {number} cy 当前纵
   * @returns {{x:number,y:number,pt:number}|null}
   */
  #nearestSafeTent(cx, cy) {
    let best = null;
    let bestD = Infinity;
    this.#tiles.forEach((t) => {
      if (t.x === cx && t.y === cy) return; // 别原地打转
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
            'warn: 受警告从 (%d,%d) 转移至营帐 (%d,%d)[%d]，冷却 %ds。',
            cx,
            cy,
            dst.x,
            dst.y,
            dst.pt,
            Math.round(tuning.warnMoveCooldownMs / 1000),
          );
        } else if (r && r.code === CODE_NOT_SENT) {
          env.log.debug('warn: 8521 未真正发出（次通道/频控），稍后重扫。');
        } else {
          // 被拒（如 158 未抵达 / 157 已在该点 / 163 不可行军）：短冷却防逐拍重发，保留待发让下次警告或重扫再试
          this.#cooldownUntil = Date.now() + tuning.rejectBackoffMs;
          env.log.info(
            'warn: 转移被拒 (%s)，%ds 后重评。',
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
    if (ctx && ctx.on && typeof ctx.on.push === 'function') {
      ctx.on.push(PUSH_SELF_ATTACKED, function (ev) {
        if (self.#active && env.realmActive()) self.onWarnPush(ev);
      });
      ctx.on.push(PUSH_TILE_INFO, function (ev) {
        if (self.#active && env.realmActive()) self.onTilePush(ev);
      });
    } else {
      env.log.warn('warn: ctx.on.push unavailable, cannot subscribe 21534/10018 (engine idle).');
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
    this.#cycle = null;
    this.#tiles = new Map();
    this.#pendingWarn = false;
    this.#marchInFlight = false;
  }
}
