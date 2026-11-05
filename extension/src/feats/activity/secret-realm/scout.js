/**
 * 侦察囤情报引擎（异能秘境：花 41001 全地形勘察车把野怪点（172）的异能兽品质探明并就地囤积）。
 *
 * 定位：**只侦察囤情报、不派兵**——本 feat 不会主动开车去野怪点（拍宠仍由玩家带到，见 index.js 第 3 条
 *   与 pilot.js 文件头「172 不在巡航档」），故本引擎不改变任何行车/攻打行为，只把「哪个野怪点是哪只兽、什么品质」这份
 *   情报攒进内存缓存（供面板展示与后续择点派兵复用）。面板开关 `scoutEnabled` **v4.1 起缺省开**——本缓存是
 *   打野档品质闸（pilot.js #pickBeast 的 qualityFor）的唯一料源，关掉后未知品质恒按 2 处理、被
 *   driveBeastMinQuality=4 筛光，打野整档哑火（竞品 scoutBeast 挂主调度 %9 默认在跑，同口径）；侦察会真消耗背包勘察车道具，护栏见下。
 *
 * 侦察链路（只取侦察、不接派兵择点）：
 *   • 链路 = 先 8536 BEAST_INFO **免费预检**（req `{x,y}`），应答带 `beastId` 即「已侦察」→ 直接囤结果、**不花道具**
 *     （8536 在侦察前回 `{beastType,pveId}` 无 beastId、侦察后回 `{…,beastId:39}`）；
 *     应答无 `beastId` 才 8537 BEAST_SCOUT（req `{x,y}`，扣 1 个 41001，回 `{beastType,pveId,beastId}`）；
 *   • 品质 = `enigma_beast[beastId].quality`（与 leave.js/pickup.js 同一张表同一读法，读不到行则 quality 存 null、仍囤 beastId）；
 *   • 不用 esrId 轮次时间闸（enigma_secret_realm_timer.start）：172 瓦片 esrId 恒 15、无逐点差异
 *     （见 constants PAB 段），拿它做闸只会误拦；改用「state=0 空闲 + 无驻军 + 未被别队号召」的点位态判据。
 *
 * 消耗护栏（41001 是稀缺品：非商店货、只能从野怪点产出拾取，见 constants ITEM_SCOUT_TOOL 条）：
 *   • **先 8536 后 8537**：能白嫖已侦察结果就绝不动道具；
 *   • 花道具前查 `getItemNumById(41001) > tuning.scoutItemReserve`（余量闸）+ 距上次花道具 ≥ `scoutGapMs`（速率闸）；
 *   • 只探**就近**（距当前停泊点欧氏序）且未在本缓存的野生点，一场缓存去重、不重复烧道具；
 *   • 8536 全局间隔 `scoutInfoGapMs` 防撞次通道频控，查到未侦察的点 `scoutReQueryMs` 后才重查（兼顾新生野怪）。
 *
 * 红线与频控：只走 ACL sendSecret 发 8536/8537，不碰游戏 Update/Delete、不调游戏侧 spyon 方法；侦察用的是**本人私有背包**
 *   的勘察车（getItemNumById 读 roomBagInfo），**非队级动作**→ 不要求队长（与 8521/8548/8589 那族「驱动全队」的写请求不同）；
 *   非秘境 / 未激活 / 关闭档一律长睡。Int64（fightEndTime/fightBeginTime/teamId）以 toNum 读。
 */
import { createCycle } from '../../../core/cycle.js';
import { bits } from '../../../core/game-api.js';
import { tileKey as utilTileKey, dist as utilDist } from './util.js';
import {
  CMD_BEAST_INFO,
  CMD_BEAST_SCOUT,
  PUSH_TILE_INFO,
  PAB_MONSTER,
  TABLE_BEAST,
  ITEM_SCOUT_TOOL,
  CODE_NOT_SENT,
  tuning,
} from './constants.js';

/**
 * 点位键（与 warn.js/pilot.js 同口径的本地小工具；非法坐标回 ''）。
 * @param {number} x 横号
 * @param {number} y 纵号
 * @returns {string}
 */
function tileKey(x, y) {
  return utilTileKey(x, y);
}

/**
 * 两瓦片欧氏格距（任一非法回 Infinity，排序落最后、不进「就近」；与 warn.js/boss.js 同一把尺子）。
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
 * protobuf Long / {_low,_high} / number / 字符串 → 数值（取不到回 0）。与 boss.js/leave.js 同口径。
 * @param {*} v 数值字段原值
 * @returns {number}
 */
function toNum(v) {
  return bits.int64ToNum(v);
}

/**
 * 侦察囤情报引擎：push 10018 建 172 野生点快照（不 kick）+ createCycle 电平兜底（冷却/重扫到点重评）。
 */
export class ScoutEngine {
  #env;
  /** @type {boolean} 存活位（stop 置 false 后旧 cycle 定时器到点即终止；本引擎靠 scan 兜底重评、不 kick，故不持 cycle 句柄） */
  #active = false;
  /**
   * @type {Map<string,{x:number,y:number,teams:number,callTId:number,at:number}>}
   * 172 野生点快照（只留 state=0 空闲且未在本缓存的点；LRU 上限 tuning.tileExtMax；push 10018 写、不 kick）
   */
  #tiles = new Map();
  /**
   * @type {Map<string,{beastId:number,quality:number|null,scouted:boolean,at:number}>}
   * 侦察情报缓存：点位键 → 结果。scouted=true 表示已拿到 beastId（不再重探）；false 表示查过但场上无兽/未侦察（冷却后重查）。
   */
  #scout = new Map();
  /** @type {number} 当前场 fightBeginTime（毫秒）；变化即视为换场、清侦察缓存。 */
  #matchBegin = 0;
  /** @type {number} 上次花道具 8537 的时刻（Date.now 毫秒；scoutGapMs 速率闸基准） */
  #lastScoutAt = 0;
  /** @type {number} 上次发 8536 的时刻（Date.now 毫秒；scoutInfoGapMs 全局间隔基准） */
  #lastInfoAt = 0;
  /** @type {number} 上次 41001 余量不足提示的时刻（Date.now 毫秒；防刷屏） */
  #lastToldAt = 0;
  /** @type {boolean} 是否有一条 8536 在途（异步链防并发） */
  #infoInFlight = false;
  /** @type {boolean} 是否有一条 8537 在途（异步链防并发） */
  #scoutInFlight = false;

  /** @param {object} env 注入底座 {alive, realmActive, cfg, secret, gameData, l10n, log} */
  constructor(env) {
    this.#env = env;
  }

  /**
   * push 10018 落地：只收 172 野怪点里「空闲无驻军」的野生候选（state≠0 的正在被拍/交战的点、以及已在本缓存的点都不进快照）。
   *   **不 kick**——10018 是视口增量、3 条/秒，kick 会把兜底拍打成 3Hz（与 warn.js/pilot.js 同手法）。
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
      if ((Number(p.pointType) || 0) !== PAB_MONSTER) continue;
      const m = p.m && typeof p.m === 'object' ? p.m : {};
      if ((Number(m.state) || 0) !== 0) continue; // 非空闲（在拍/交战/已清场）→ 不是可侦察的野生候选
      const k = tileKey(p.x, p.y);
      if (!k) continue;
      if (this.#scout.has(k)) continue; // 已囤过情报的点不再进候选（缓存去重，防重复烧道具）
      if (this.#tiles.size >= tuning.tileExtMax && !this.#tiles.has(k)) {
        const first = this.#tiles.keys().next();
        if (!first.done) this.#tiles.delete(first.value);
      }
      this.#tiles.set(k, {
        x: Math.floor(Number(p.x)),
        y: Math.floor(Number(p.y)),
        teams: Array.isArray(m.teams) ? m.teams.length : 0,
        callTId: toNum(m.callTId),
        at: now,
      });
    }
  }

  /**
   * 一拍：总闸开 + 秘境在场 → 就近取一个野生候选，先 8536 免费预检、无 beastId 且道具/冷却允许才 8537 花道具侦察。
   * 永不 reject；任一护栏不满足即按对应冷却或 scoutScanMs 长睡（保守：读不到现场 / 道具不足 / 冷却未到都不花道具）。
   * @returns {number} 下拍睡眠（毫秒）
   */
  #tick() {
    const env = this.#env;
    if (!env.alive()) return 0;
    if (!env.realmActive()) return tuning.scoutScanMs;
    const sc = env.cfg().scout;
    if (!sc || !sc.enabled) return tuning.scoutScanMs;
    if (this.#infoInFlight || this.#scoutInFlight) return 500; // 有一条异步链在途 → 极短退避等其落地
    const base = env.secret.getRoomBaseInfo();
    if (!base || !base.startPoint) return tuning.scoutScanMs; // 读不到停泊现场 → 无「就近」锚点，不凭空探
    // 换场复位：fightBeginTime 变化 = 新一场秘境 → 清缓存（坐标可同位不同场，旧情报不作数、也允许重烧道具铺）
    const fb = toNum(base.fightBeginTime);
    if (fb > 1e11 && fb !== this.#matchBegin) {
      this.#matchBegin = fb;
      this.#scout = new Map();
    }

    const S = env.secret.getNMarchState();
    const arrived = S && S.ARRIVED != null ? Number(S.ARRIVED) : 2;
    if (Number(base.marchState) !== arrived) return tuning.scoutScanMs; // 在途行军、视野/坐标在动 → 不打扰

    const teamId = toNum(base.teamId);
    const now = Date.now();
    // 就近候选序：距当前停泊点欧氏升序；剔除已被别队号召（callTId 非 0 且非本队）、有驻军、本场已缓存（含冷却未到）的点
    const cands = [];
    for (const t of this.#tiles.values()) {
      if (t.teams > 0) continue;
      if (t.callTId && t.callTId !== teamId) continue;
      const rec = this.#scout.get(tileKey(t.x, t.y));
      if (rec && (rec.scouted || now - rec.at < tuning.scoutReQueryMs)) continue;
      cands.push({
        k: tileKey(t.x, t.y),
        x: t.x,
        y: t.y,
        d: dist(t.x, t.y, base.startPoint.x, base.startPoint.y),
      });
    }
    cands.sort(function (a, b) {
      return a.d - b.d;
    });
    if (!cands.length) return tuning.scoutScanMs;
    const target = cands[0];

    // 速率闸：距上次花道具未到 scoutGapMs → 本拍不烧道具，退回 8536 免费预检（囤已侦察结果不耗道具、不受本闸约束）
    const canSpend = now - this.#lastScoutAt >= tuning.scoutGapMs;
    if (canSpend && this.#haveScoutTool(now)) {
      this.#lastScoutAt = now;
      this.#doScout(target);
      return 0;
    }
    // 无道具 / 未过速率闸 → 只做 8536 免费预检；也受 8536 全局间隔约束
    if (now - this.#lastInfoAt < tuning.scoutInfoGapMs) {
      return Math.min(tuning.scoutInfoGapMs - (now - this.#lastInfoAt), tuning.scoutScanMs);
    }
    this.#lastInfoAt = now;
    this.#doInfo(target);
    return 0;
  }

  /**
   * 41001 余量闸（带防刷屏提示）：`getItemNumById(ITEM_SCOUT_TOOL) > tuning.scoutItemReserve` 才可花道具侦察。
   * 余量读不到（回 0）按「不足」处理（闭开：不确定就不烧道具）。不足时每 ≤60s 才打一条 debug，不逐拍刷。
   * @param {number} now Date.now 毫秒
   * @returns {boolean} true=可花道具侦察
   */
  #haveScoutTool(now) {
    const env = this.#env;
    const have = env.secret.getItemNumById(ITEM_SCOUT_TOOL);
    if (have > tuning.scoutItemReserve) return true;
    if (now - this.#lastToldAt > 60000) {
      this.#lastToldAt = now;
      env.log.debug(
        'scout: scout-tool(%d) stock %d <= reserve %d, skip paid scout (fall back to 8536 free pre-check).',
        ITEM_SCOUT_TOOL,
        have,
        tuning.scoutItemReserve,
      );
    }
    return false;
  }

  /**
   * 发 8536 免费预检：应答带 beastId → 直接囤「已侦察」情报（**不花道具**）；无 beastId → 记「查过未侦察」，
   *   冷却后重查（或下一拍过速率闸时由 #doScout 花道具探）。永不 reject。
   * @param {{k:string,x:number,y:number}} target 候选点
   */
  #doInfo(target) {
    const env = this.#env;
    const self = this;
    this.#infoInFlight = true;
    env.secret
      .sendSecret(CMD_BEAST_INFO, { x: target.x, y: target.y })
      .then(function (r) {
        if (!env.alive() || !env.realmActive()) return;
        const code = r && r.code;
        if (code === CODE_NOT_SENT || code == null) return; // 未上线（频控/超时）→ 不记账，冷却到点自然重评
        const d = (r && r.data) || {};
        const beastId = Number(d.beastId) || 0;
        if (beastId > 0) {
          self.#record(target.k, beastId, true);
          env.log.info(
            'scout: 8536 %s already scouted -> beastId=%d (quality=%s, no item consumed).',
            target.k,
            beastId,
            String(self.#quality(beastId)),
          );
        } else {
          self.#record(target.k, 0, false); // 场上无兽或尚未侦察 → 记「查过」，scoutReQueryMs 后重查
        }
      })
      .catch(function (e) {
        env.log.warn('scout: 8536 pre-check threw.', e);
      })
      .then(function () {
        self.#infoInFlight = false;
      });
  }

  /**
   * 发 8537 花道具侦察（扣 1 个 41001）：应答带 beastId → 囤「已侦察」情报。未上线/被拒只降级不重试同点（下一拍重选候选）。
   *   永不 reject。
   * @param {{k:string,x:number,y:number}} target 候选点
   */
  #doScout(target) {
    const env = this.#env;
    const self = this;
    this.#scoutInFlight = true;
    env.secret
      .sendSecret(CMD_BEAST_SCOUT, { x: target.x, y: target.y })
      .then(function (r) {
        if (!env.alive() || !env.realmActive()) return;
        const code = r && r.code;
        if (code === CODE_NOT_SENT || code == null) {
          env.log.debug(
            'scout: 8537 not actually sent (rate-limited/timeout, code=%s), discard this tick.',
            String(code),
          );
          return;
        }
        if (Number(code) !== 0) {
          // 服务器明确拒（非「未上线」）：该点当前不可侦察 → 记「查过」进 scoutReQueryMs 长冷却，不逐拍重烧道具撞同一堵
          self.#record(target.k, 0, false);
          env.log.info(
            'scout: 8537 scout rejected (%s), re-evaluate this point after cooldown.',
            (r && r.reason) || 'code ' + code,
          );
          return;
        }
        const d = (r && r.data) || {};
        const beastId = Number(d.beastId) || 0;
        if (beastId > 0) {
          self.#record(target.k, beastId, true);
          env.log.info(
            'scout: 8537 %s scout succeeded -> beastId=%d (quality=%s, consumed 1 scout-tool).',
            target.k,
            beastId,
            String(self.#quality(beastId)),
          );
        } else {
          self.#record(target.k, 0, false); // 侦察了但场上无兽 → 记「查过」，冷却后重查
        }
      })
      .catch(function (e) {
        env.log.warn('scout: 8537 scout threw.', e);
      })
      .then(function () {
        self.#scoutInFlight = false;
      });
  }

  /**
   * beastId → enigma_beast 行 quality（与 leave.js/pickup.js 同表同读法）；行/字段读不到回 null（仍囤 beastId，不把未知当低品质）。
   * @param {number} beastId enigma_beast 主键
   * @returns {number|null} 品质（null=读不到）
   */
  #quality(beastId) {
    if (!beastId) return null;
    const row = this.#env.l10n.tableRow(TABLE_BEAST, beastId);
    const q = row ? Number(row.quality) : NaN;
    return Number.isFinite(q) ? q : null;
  }

  /**
   * 对外只读口：某个 172 点位的**已侦察宠物品质**（供 pilot 的打野档按品质择目标，
   *   口径即 `EnigmaBeastController.getScoutInfo(x,y).beastId → enigma_beast.quality`）。
   *   没囤过情报/未侦察成功 → 回 null（调用方按「未知 = 不去」处置）。
   * @param {number} x 横号
   * @param {number} y 纵号
   * @returns {number|null} 品质
   */
  qualityAt(x, y) {
    const k = tileKey(x, y);
    if (!k) return null;
    const rec = this.#scout.get(k);
    if (!rec || !rec.scouted) return null;
    return Number.isFinite(rec.quality) ? rec.quality : null;
  }

  /**
   * 写情报缓存（LRU 上限 tileExtMax，溢出丢最早一项）。scouted=true 是终态（拿到 beastId、不再重探）；
   *   false 记「查过但场上无兽/未侦察」，靠 at + scoutReQueryMs 冷却后重查。
   * @param {string} k 点位键
   * @param {number} beastId enigma_beast 主键（0=无兽/未知）
   * @param {boolean} scouted 是否已侦察到具体兽
   */
  #record(k, beastId, scouted) {
    if (this.#scout.size >= tuning.tileExtMax && !this.#scout.has(k)) {
      const first = this.#scout.keys().next();
      if (!first.done) this.#scout.delete(first.value);
    }
    this.#scout.set(k, {
      beastId: beastId,
      quality: this.#quality(beastId),
      scouted: scouted,
      at: Date.now(),
    });
  }

  /**
   * 启动：订阅 10018（退订由 reactor 托管）+ 建兜底循环 + 复位一场态。
   * @param {object} ctx reactor 上下文
   */
  start(ctx) {
    const env = this.#env;
    const self = this;
    this.#active = true;
    this.#tiles = new Map();
    this.#scout = new Map();
    this.#matchBegin = 0;
    this.#lastScoutAt = 0;
    this.#lastInfoAt = 0;
    this.#lastToldAt = 0;
    this.#infoInFlight = false;
    this.#scoutInFlight = false;
    if (ctx && ctx.on && typeof ctx.on.push === 'function') {
      ctx.on.push(PUSH_TILE_INFO, function (ev) {
        if (self.#active && env.realmActive()) self.onTilePush(ev);
      });
    } else {
      env.log.warn('scout: ctx.on.push unavailable, cannot subscribe 10018 (engine idle).');
    }
    createCycle({
      log: env.log,
      alive: function () {
        return self.#active && env.alive();
      },
      run: function () {
        return self.#tick();
      },
      fallback: tuning.scoutScanMs,
    });
    env.log.info(
      'scout engine started (hoard beast quality via 8536/8537; default OFF, consumes 41001).',
    );
  }

  /** 停止：置死 #active、收快照与在途位（cycle 靠 #active 到点自终；事件退订由 reactor 统一摘）。 */
  stop() {
    this.#active = false;
    this.#tiles = new Map();
    this.#infoInFlight = false;
    this.#scoutInFlight = false;
  }
}
