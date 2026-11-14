/**
 * WORK 相位按点型策略（三-4：从 pilot.#enterWork/#workTick 抽出的纯决策层，离线可测）。
 *
 * 四种点型策略（与旧 if 分支逐位等价）：
 *   • 172 野怪 → monster：固定驻留 driveStayMonsterMs，等拍宠/交战结算；
 *   • 173 井 / 163 掉落箱 → resource：拿空即走（三路判空由 pilot 喂 isEmpty），
 *     地板 = max(拿空结算窗, 动态驻留 #resDwellMs)，天花板 driveWorkMaxMs；
 *   • 161 商店 → shop：动态驻留 max(基墙, 缺口×driveShopUnitMs) 封顶 基墙+driveShopExtraMs，
 *     驻留满后缺口未补再续留至多 driveShopExtraMs（分段轮询，补满当拍即走）；
 *   • 其余（176/177/178/174…）→ dwell：driveWorkDwellMs；BOSS 相关点加三条提前离点判据
 *     （现场瓦片判死/投喂交接、全图无窗且本点无活、拍宠让路），分段轮询不睡满。
 *
 * 分层口径：本文件**纯函数**——不读 tuning/env/时钟，全部事实由调用方经 `f` 喂入；
 *   返回「状态补丁」（enter）或「离点决策 + 待落日志」（tick），副作用（kickShop/复拉 21535/
 *   账本写入/日志输出）归 pilot 执行。改驻留判据只改这里，pilot 不再有点型 if 链。
 */
import {
  PAB_SHOP,
  PAB_MONSTER,
  PAB_RESOURCE,
  PAB_DROP,
  PAB_BOSS,
  PAB_BOSS_GUARD,
  PAB_BOSS_PLANE,
} from './constants.js';

/**
 * 点型是否 BOSS 相关（与 pilot.isBossish 同口径；本文件自带一份避免反向 import pilot）。
 * @param {number} pt 点型
 * @returns {boolean}
 */
function bossish(pt) {
  return pt === PAB_BOSS || pt === PAB_BOSS_GUARD || pt === PAB_BOSS_PLANE;
}

/**
 * 173 井的最短驻留地板（原 pilot.#resDwellMs 纯读搬迁）：
 *   「未拿件数」优先取 21522 按点记账的空位数（bagFree+buffFree），没记账就用快照 iNum 兜底；
 *   动态值 = 件数×driveResStayPerBagMs + driveResStayBaseMs，driveResStayMaxMs 作保底（取大），
 *   最终以 driveWorkMaxMs 为天花板。
 * @param {object|null} change 该点 21522 记账（{bagFree,buffFree}；无则 null）
 * @param {object|null} tile 该点快照（{iNum}；无则 null）
 * @param {object} t tuning 事实 {driveResStayPerBagMs,driveResStayBaseMs,driveResStayMaxMs,driveWorkMaxMs}
 * @returns {number} 毫秒（0=不加下限）
 */
export function resDwellMs(change, tile, t) {
  let n = 0;
  if (change) n = Math.max(0, (Number(change.bagFree) || 0) + (Number(change.buffFree) || 0));
  if (!n) {
    n = tile && tile.iNum != null ? Math.max(0, Number(tile.iNum) || 0) : 0;
  }
  const dyn = n * (Number(t.driveResStayPerBagMs) || 0) + (Number(t.driveResStayBaseMs) || 0);
  const cap = Number(t.driveResStayMaxMs) || 0;
  const ms = cap > 0 ? Math.max(cap, dyn) : dyn;
  return Math.max(0, Math.min(t.driveWorkMaxMs, ms));
}

/**
 * 到点进驻留：按点型算状态补丁（pilot Object.assign 到引擎字段；shop 档另带账本/冷却副作用位）。
 * @param {number} pt 到达点型（pilot 已锁存 #workPt）
 * @param {object} f 事实包：
 *   now 毫秒；key 点位键；d 面板 drive 配置；t tuning；
 *   change/tile 该点记账与快照（resource 地板用）；
 *   sausageHave/sausageTarget 香肠持有与目标（shop 动态驻留用）；
 *   shopLedgerEntry 该店现有账本行（无则 null）
 * @returns {object} 补丁：必含 workMode/workUntil/workEmptyAt/workDeadline；
 *   shop 档附 shopErrandDone/shopLastAt/shopCoolUntil/shopLedgerEntry/kickShop
 */
export function enter(pt, f) {
  const now = f.now;
  const t = f.t;
  const d = f.d || {};
  const patch = { workMode: 'dwell', workUntil: 0, workEmptyAt: 0, workDeadline: 0 };
  if (pt === PAB_MONSTER) {
    // 到 172 后本拍不重路由，等拍宠/交战把点数结算完
    patch.workUntil = now + (Number(t.driveStayMonsterMs) || 0);
  } else if (pt === PAB_RESOURCE || pt === PAB_DROP) {
    patch.workMode = 'empty';
    patch.workUntil = pt === PAB_RESOURCE ? resDwellMs(f.change, f.tile, t) : 0;
    patch.workDeadline = now + t.driveWorkMaxMs;
  } else if (pt === PAB_SHOP) {
    // 驻留时长按缺口动态放宽：`max(基墙, 待补件数 × driveShopUnitMs)`。
    //   香肠 buy_times=1、一根一刷，买满 10 根需 ≈9 刷——固定 25s 盖不住（实证只买到 7 根）。
    const baseMs = Number.isFinite(d.shopDwellMs) ? d.shopDwellMs : t.driveShopDwellMs;
    const need = Math.max(0, (Number(t.driveSausageTarget) || 0) - (f.sausageHave || 0));
    // 动态驻留套总天花板 `基墙 + driveShopExtraMs`：target 被配大时不致线性失控久停
    const ms = Math.min(
      Math.max(baseMs, need * (Number(t.driveShopUnitMs) || 0)),
      baseMs + (Number(t.driveShopExtraMs) || 0),
    );
    patch.workUntil = now + ms;
    patch.shopErrandDone = true;
    patch.shopLastAt = now;
    // 账本：到店就记 time（秒）+ visited=1（真到店，锚点建账播的初值不算）
    const led = f.shopLedgerEntry || { time: 0, sausage: 0, piece: 0, visited: 0, sausageShelf: 0 };
    led.time = Math.floor(now / 1000);
    led.visited = 1;
    patch.shopLedgerEntry = led;
    // 去重窗 + 路由锁：到店后 driveShopStayMs 内整条链不重评，取 max(3000, driveShopStayMs)
    patch.shopCoolUntil = now + Math.max(3000, Number(t.driveShopStayMs) || 0);
    // 到店第一件事：把商店引擎从 10 分钟轮巡里叫醒（不叫醒就是「到店也不买货」）
    patch.kickShop = true;
  } else {
    patch.workUntil = now + t.driveWorkDwellMs;
  }
  return patch;
}

/**
 * WORK 相位一拍推进（纯决策）：返回离点决策与待落日志，副作用归 pilot。
 * @param {number} pt 锁存点型（#workPt）
 * @param {object} s 相位状态 {workMode,workUntil,workEmptyAt,workDeadline}
 * @param {object} f 事实包：
 *   now 毫秒；key 点位键；d 面板 drive 配置；t tuning；
 *   isEmpty 三路判空结果（empty 档）；
 *   captureBusy/bossLeaveWhy/bossWin/bossLiveHere（BOSS 档提前离点判据，pilot 预先算好）；
 *   sausageHave/sausageTarget（shop 缺口续留）；shopGiveUp（刷店止损信号，四-2：true 时缺口也不续留）
 * @returns {{leave:boolean,sleep:number,patch?:object,log?:{tpl:string,args:Array}}}
 */
export function tick(pt, s, f) {
  const now = f.now;
  const t = f.t;
  if (s.workMode === 'empty') {
    if (f.isEmpty) {
      const emptyAt = s.workEmptyAt || now;
      const d = f.d || {};
      const settle = Number.isFinite(d.emptyDwellMs) ? d.emptyDwellMs : t.driveEmptyDwellMs;
      // 动态驻留作**地板**：拿空了也至少给 8527/8538 把这一批结算完
      const readyAt = Math.max(emptyAt + settle, s.workUntil || 0);
      const patch = s.workEmptyAt ? undefined : { workEmptyAt: emptyAt };
      if (now >= readyAt) return { leave: true, sleep: 0, patch: patch };
      return { leave: false, sleep: readyAt - now, patch: patch };
    }
    const patch = s.workEmptyAt ? { workEmptyAt: 0 } : undefined;
    if (now >= s.workDeadline) {
      return {
        leave: true,
        sleep: 0,
        patch: patch,
        log: {
          tpl: 'pilot: %s scouted empty, hit fallback ceiling, leave point. reason=empty_ceiling',
          args: [f.key],
        },
      };
    }
    return { leave: false, sleep: Math.min(t.driveScanMs, s.workDeadline - now), patch: patch };
  }
  // dwell 相位：BOSS 点提前离点（不等满驻留）——现场瓦片判死或投喂窗且无石头可领
  if (bossish(pt)) {
    if (!f.captureBusy) {
      // 拍宠中不赶车（同威胁块的让路语义）；其余先判提前离点两条
      if (f.bossLeaveWhy) {
        return {
          leave: true,
          sleep: 0,
          log: {
            tpl: 'pilot: boss point %s %s, leave early before dwell ceiling. reason=boss_over',
            args: [f.key, f.bossLeaveWhy],
          },
        };
      }
      // 平台无窗即时出口（B1-3）：全图判不出任何 BOSS 窗且本点无活 → 当拍离点。
      //   ⚠ 只判 win=null：win 为别区 open 时不能据此赶车；win=null 也不等于本点无事可做
      //   （投喂窗 state23/被顺延的 state22 由 bossLiveHere 兜闸）。
      if (!f.bossWin && !f.bossLiveHere) {
        return {
          leave: true,
          sleep: 0,
          log: {
            tpl: 'pilot: boss point %s has no open BOSS window, leave now (no dwell wait). reason=no-window',
            args: [f.key],
          },
        };
      }
    }
    // 分段轮询而非一次睡满：21535 阶段切换不推、10018 到达也不 kick，睡满驻留窗就没人来判「提前离点」
    if (s.workUntil && now < s.workUntil) {
      return { leave: false, sleep: Math.min(t.driveScanMs, s.workUntil - now) };
    }
  } else if (s.workUntil && now < s.workUntil) {
    return { leave: false, sleep: s.workUntil - now };
  }
  // 商店缺口续留：到点但香肠仍未补满 → 最多再延 driveShopExtraMs 后强制离店（仍受三重永动闸约束）；
  //   shopGiveUp（四-2 刷店连续未命中止损）时不续留，当拍即走（pilot 已同步截短 workUntil）
  if (pt === PAB_SHOP) {
    const target = Number(t.driveSausageTarget) || 0;
    const have = f.sausageHave || 0;
    if (have < target && !f.shopGiveUp) {
      const extra = Number(t.driveShopExtraMs) || 0;
      const ceiling = (s.workUntil || now) + extra;
      // 同 BOSS 窗：分段轮询，补满当拍即可离店，不空等到 ceiling
      if (now < ceiling) {
        return { leave: false, sleep: Math.min(t.driveScanMs, ceiling - now) };
      }
      return {
        leave: true,
        sleep: 0,
        log: {
          tpl: 'pilot: shop %s sausage still short (%d/%d) after extra %ds, force leave. reason=shop_extra_ceiling',
          args: [f.key, have, target, Math.round(extra / 1000)],
        },
      };
    }
  }
  return { leave: true, sleep: 0 };
}
