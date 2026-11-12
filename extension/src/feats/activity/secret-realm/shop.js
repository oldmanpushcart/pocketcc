/**
 * 商店补货引擎（异能秘境：**只在队伍已停靠的商店点位**补货，不主动开车过去）。
 *
 * 为什么"只在已停靠的店"（源码 NWorldMapTileClickUtils）：点开商店瓦片（161）时——
 *   `for team in tile.teams: team.teamId==roomBaseInfo.teamId ? i=true`，然后 `PAB_SHOP: i ? OpenUI(PabShopPanel) : OpenUI(NWorldPabShopPopup)`
 *   → 只有**本队停在该商店点位**（在该点驻军列表里）才进得去买货面板；而 `8542 SHOP_BUY` **不带坐标**（服务器按"你当前在哪个店"关联）。
 *   → 结论：买货必须"人在店里"。本引擎走**保守档**：队伍已被玩家开到某商店点（roomBaseInfo.pointType===161
 *   且 ARRIVED）才补货，引擎自己绝不发 8521 挪队去商店（自动开车到商店属 pilot 的路线决策，不在本引擎）。
 *
 * 链路（源码 PabShopPanel / PabShopItem）：
 *   ① `8540 SHOP_INFO {x,y}`（x,y=当前商店点坐标）→ `{items:[{specId,getTime}], readyList:[…]}`；**应答不带 x,y**。
 *      ⚠ **本查询会把本店非 type3 货位的 getTime 归零**（同店 19:1 → 再发 8540 → 19:0）→
 *      所以**每次到店只 INFO 一次**（#loadedXY 记账），之后一律以 8542/8543 应答回带的 `items` 为准更新 getTime，
 *      绝不反复 8540 把额度基准刷没。
 *   ② `8542 SHOP_BUY {specId,num}`（无坐标）→ resp 只回新 `{items}`。`num` 可 >1
 *      （游戏自己的选择器 ActivityItemNumSelect{maxCounts} 确认后就是 `emit(PabShopItemBuy, id, chosenNum)` 发一笔 num=所选数）；
 *      玩家逐次点 1 时 num 才为 1。
 *   ③ `8543 SHOP_REFRESH {x,y}` → resp 只回 `{items}`；**每次恰好扣 1 个刷新币 41010**（余量 10→…→1、共 18 次），
 *      且只把**非 type3** 货位 getTime 归零（19:1 →刷新→ 19:0，而同拍 type3 的 20 仍 20:1）。
 *      余量 < `_shopRefreshCost`（dataConfig 3029）时游戏 tips enigma_realm74 开不了口 → 本引擎同预检。
 *   ④ 货表 `enigma_secret_realm_shop` 每行字段（verbatim PabShopItem.updateShopItem）：
 *      `id(=specId) / item_id(产出道具) / item_num(每次给量) / cost(单价，用购买币 41009) / buy_times(本店额度) / type(3=跨店共享限量)`；
 *      `_lastNum = max(buy_times - getTime, 0)`，`_lastNum===0` = 售罄。⚠ 本表离线无数据 → 商品全量只能运行时 `l10n.tableRows` 枚举。
 *   ⑤ 购买预检链（verbatim PabShopItem.clickShopItem）：`t=floor(41009余额/cost)`→`t<=0` tips enigma_realm75→
 *      `checkItemNumMax(itemId)`（仅 ITEM type===171 且 para1_v1 时按 `para1_v1-现有` 夹）→`min(_lastNum,t)`→发 8542。
 *      本引擎逐条复刻，把 qty 夹到 `min(目标剩余, _lastNum, 可负担, 携带余量)`。
 *
 * 记账与停止：面板是**合并后的持有清单**（pickItems，行 key=`item:{itemId}`），条目 `shop=1` 即「商店补货」渠道勾选；
 *   目标持有量 T = `max>0 ? max : 携带上限 para1_v1`（两渠道共用同一个 T，拾取/补货谁先把背包推到 T 谁停）；
 *   引擎按 item_id 展开成该道具全部货行逐行执行（同一道具在货表多行/多店售卖）；
 *   `#bought[specId]` = 本会话各货行已购件数（**这是我们自己的进度账，不受 getTime 被刷影响**，道具目标按各行合计）。
 *   货行额度买完（`_lastNum=0`）而 T 未达即发 8543 刷新（跟随刷新币余额，耗尽即停）；type3 跨店限量不可刷。
 *   每拍只做一个动作（买 1 笔 or 刷 1 次），
 *   串行（isSecretSending + #busy 双闸）→ 全部目标满足或无可继续（缺币/缺刷新币/售罄且 type3 不可刷）即返回长睡。
 *
 * 只读+发包红线：只走 ACL sendSecret 发 8540/8542/8543，读余额用 getItemNumById，不调游戏侧 Update/Delete、不镜像态；
 *   非秘境/未停靠商店点/未激活一律长睡。Int64 无（这些协议载荷都是标量）。
 */
import { createCycle } from '../../../core/cycle.js';
import {
  CMD_SHOP_INFO,
  CMD_SHOP_BUY,
  CMD_SHOP_REFRESH,
  CFG_SHOP_CURRENCY,
  CFG_SHOP_REFRESH_COST,
  TABLE_SHOP,
  TABLE_ITEM,
  ITEM_TYPE_PAB,
  ITEM_SAUSAGE,
  ST_BOSS_DEAD_END,
  PAB_SHOP,
  REJ_RETRY,
  CODE_NOT_SENT,
  tuning,
} from './constants.js';
import { GateStateLog } from './gate-log.js';

/** @type {string} 持有清单行 key 前缀（`item:{itemId}`，与 index.js/pickup.js 同口径） */
const KEY_ITEM = 'item:';

/**
 * sendSecret 的 Ret 是否业务成功（与 heal.js 同口径：net.Ret 的 ok 是 getter，game-api 降级对象无 ok 只有 code）。
 * @param {object|null} r Ret 形结果
 * @returns {boolean}
 */
function isOk(r) {
  if (!r) return false;
  return r.ok === undefined ? Number(r.code) === 0 : !!r.ok;
}

/**
 * 商店补货引擎：单条 createCycle 电平循环（到店 INFO 一次 → 逐货位买/刷 → 目标齐即长睡）。
 */
export class ShopEngine {
  #env;
  /** @type {{kick:Function}|null} */
  #cycle = null;
  /** @type {boolean} 引擎存活位（stop 置 false 后旧 cycle 定时器到点即终止） */
  #active = false;
  /** @type {boolean} 是否有一条 85xx 在途（串行闸，配合 isSecretSending） */
  #busy = false;
  /**
   * @type {Object<number,number>} specId → getTime（最新一次 INFO/BUY/REFRESH 应答的货位已购次数）
   * 只在 #loadedXY 对应当前这次停靠时有效；每次应答整体覆盖。
   */
  #items = {};
  /**
   * @type {Object<string,number>} 各店**本场**为「刷出目标品」已发过的 8543 次数（按点键 `x,y` 记），
   *   上限取 `driveSausageRefreshMax`（现 12）。计数按店独立、不在 8540 INFO 时归零
   *   （刷店成功的应答本身就是一条 8540/8543 items）；换场由 #syncMatch 整体归零——
   *   会话级累计会让同一激活连打多场时第 2 场起预算必爆（症状同「只买到 7/10」）。
   */
  #refreshTries = {};
  /** @type {number} 上一笔 8543 发起时刻（毫秒）：#tick 用它夹出 shopRefreshGapMs 最小间隔 */
  #lastRefreshAt = 0;
  /** @type {string} #items 装载时所在的商店点坐标键（''=未装；换点或重新到店都要重 INFO 一次） */
  #loadedXY = '';
  /** @type {Object<number,number>} specId → 本会话已购件数（我们自己的进度账，权威于 getTime 做「还差多少」） */
  #bought = {};
  /** @type {Object<number,1>} 本会话已买满/无法继续而降级的 specId（不再重复尝试，防逐拍重发） */
  #done = {};
  /** @type {Object<string,1>} 已打过的 info 提示键（防刷屏） */
  #told = {};
  /** @type {Object<number,1>} 已就某 specId 的 8542 用过一次 162 重试 */
  #retriedBuy = {};
  /** @type {number} 上一笔 8542 应答落地时刻（毫秒，Date.now 口径）：#tick 用它夹出 shopBuyGapMs 静默 */
  #lastBuyEndAt = 0;
  /** @type {Object<number,number[]>|null} itemId → 货表行 id（specId）列表的惰性缓存（表是静态的，每会话建一次） */
  #specsByItem = null;
  /** @type {Array<{spec:number,itemId:number,cost:number,buyTimes:number}>|null} type3（跨店共享限量）货行清单惰性缓存 */
  #type3Specs = null;
  /** @type {GateStateLog} 静默睡过出口的门控边沿日志（不参与判定） */
  #gates;
  /** @type {string} #atShop 本拍回 null 的原因（仅诊断，由 #gates 的 detail 带出） */
  #atShopWhy = '';
  /** @type {string} 场次锚（fightBeginTime 的字符串形；''=未钉）——变化即换场，#syncMatch 用它复位按场预算 */
  #matchKey = '';

  /** @param {object} env 注入底座 {alive, realmActive, cfg, secret, gameConf, l10n, log} */
  constructor(env) {
    this.#env = env;
    this.#gates = new GateStateLog(env.log, 'shop');
  }

  /**
   * 商店货币对（dataConfig 3028 → "购买币|刷新币"，[0]=41009 异能晶块、[1]=41010 人造水晶）。
   * 运行时读，不写死；读不到回 null（本轮不动作）。
   * @returns {{buyId:number, refreshId:number}|null}
   */
  #currency() {
    const env = this.#env;
    let raw;
    try {
      raw = env.gameConf.dataConfig(CFG_SHOP_CURRENCY);
    } catch (e) {
      return null;
    }
    const parts = String(raw == null ? '' : raw).split('|');
    const buyId = Number(parts[0]) || 0;
    const refreshId = Number(parts[1]) || 0;
    if (!buyId || !refreshId) return null;
    return { buyId: buyId, refreshId: refreshId };
  }

  /**
   * 当前停靠点是否为可补货的商店点（roomBaseInfo.pointType===161 且 marchState=ARRIVED 且停泊在位）。
   * @returns {{x:number,y:number,key:string}|null} 在店回 {x,y,key}，否则 null
   */
  #atShop() {
    const env = this.#env;
    const base = env.secret.getRoomBaseInfo();
    if (!base || !base.startPoint) {
      this.#atShopWhy = 'no roomBaseInfo/startPoint';
      return null;
    }
    if (Number(base.pointType) !== PAB_SHOP) {
      this.#atShopWhy = 'pointType=' + base.pointType + ' (not 161 shop)';
      return null;
    }
    const S = env.secret.getNMarchState();
    const arrived = S && S.ARRIVED != null ? Number(S.ARRIVED) : 2;
    if (Number(base.marchState) !== arrived) {
      this.#atShopWhy = 'marchState=' + base.marchState + ' (not ' + arrived + ')';
      return null;
    }
    if (!env.secret.teamIsMooring()) {
      this.#atShopWhy = 'team not mooring';
      return null;
    }
    const x = Number(base.startPoint.x);
    const y = Number(base.startPoint.y);
    if (!(x > 0) || !(y > 0)) {
      this.#atShopWhy = 'bad coord (' + x + ',' + y + ')';
      return null;
    }
    this.#atShopWhy = '';
    return { x: x, y: y, key: x + ',' + y };
  }

  /**
   * 换场检测（fightBeginTime 变化 = 新一场秘境）：复位**按场计**的预算与进度账。
   *   引擎只在激活/挂起时重建，同一激活可连打多场；不靠本复位的话 `driveSausageRefreshMax`
   *   会跨场累计，第 2 场起「同店刷到买满」预算必爆。
   *   fightBeginTime 可能是 Int64 形态，统一转字符串比较（对象引用不参与判定）。
   * @param {object|null} base roomBaseInfo
   */
  #syncMatch(base) {
    const fb = base && base.fightBeginTime;
    const key = fb == null ? '' : String(fb);
    if (!key || key === this.#matchKey) return;
    const first = !this.#matchKey;
    this.#matchKey = key;
    this.#refreshTries = {};
    this.#bought = {};
    this.#done = {};
    this.#retriedBuy = {};
    this.#told = {};
    // 首钉静默；换场留一条 info 给单轨日志定轴（不逐拍刷屏）
    if (!first)
      this.#env.log.info('shop: new match (fightBeginTime=%s), refresh budget reset.', key);
  }

  /**
   * 一拍：判停店 → 未装货单则 INFO；否则找一个可动作货位买/刷；全都齐即长睡。永不 reject。
   * @returns {number} 下拍间隔（毫秒）
   */
  #tick() {
    const env = this.#env;
    const g = this.#gates;
    if (!env.alive()) return 0;
    if (g.edge('realm-off', !env.realmActive(), 'not in pab realm')) return tuning.shopSweepMs;
    // 换场复位先于一切业务闸：引擎长期存活跨场，不复位则刷新预算/进度账/去重表跨场累计
    this.#syncMatch(env.secret.getRoomBaseInfo());
    const sc = env.cfg().shop;
    // 总闸：
    //   ① 持有清单里任一行勾了「店」渠道（sc.enabled）→ 用户显式要求的补货；
    //   ② **自动驾驶开着（drive.enabled）** → 车会自己开到店，不买白跑一趟；自动驾驶即「替我开去商店」的
    //      意图表达，故没勾「店」渠道时也允许到店自动购买。
    const dv = env.cfg().drive;
    const autoBuy = !!(dv && dv.enabled);
    if (
      g.edge(
        'master-off',
        !(sc && sc.enabled) && !autoBuy,
        'pickItems no shop channel and drive off',
      )
    ) {
      return tuning.shopSweepMs;
    }
    const cur = this.#atShop();
    if (!cur) {
      this.#loadedXY = '';
      g.edge('docked', false, '');
      // 没停在商店点：
      //   · 自动驾驶开着 → **短轮询**：车随时可能到店，而到店只停 driveShopDwellMs（默认 25s），
      //     本引擎若睡满 shopSweepMs（10 分钟）就错过了整个驻留窗 = 用户口径「到店也不买货」；
      //   · 手动档 → 保守长睡，等玩家把队开到店里再醒（本引擎绠不主动开车）。
      //   闸名用 not-docked：实战最高危路径「到店也不买」就靠这条 + detail 定性。
      g.edge(
        'not-docked',
        true,
        this.#atShopWhy + (autoBuy ? ' (short poll)' : ' (manual, long sleep)'),
      );
      return autoBuy ? tuning.driveScanMs : tuning.shopSweepMs;
    }
    g.edge('not-docked', false, '');
    g.edge('docked', true, 'at (' + cur.x + ',' + cur.y + ')');
    if (g.edge('busy', this.#busy, 'a 8540/8542/8543 is in flight')) return tuning.shopGapMs;
    // 同一店两条 BUY 之间的额外静默（上一笔未结算形态会出 enigma_realm162，见 constants shopBuyGapMs）
    let buyGapLeft = 0;
    if (this.#lastBuyEndAt) buyGapLeft = this.#lastBuyEndAt + tuning.shopBuyGapMs - Date.now();
    if (g.edge('buy-gap', buyGapLeft > 0, buyGapLeft > 0 ? 'left=' + buyGapLeft + 'ms' : '')) {
      return buyGapLeft;
    }
    // 8543 刷店的最小间隔（250ms 节拍连着刷会一秒烧光配额，故必须留间隔）：
    //   这里**只短睡到间隔满**（不能当「本轮无动作」处理，否则 #actOnce 回 false 会睡到 shopSweepMs 而错过整个驻留窗）
    let refGapLeft = 0;
    if (this.#lastRefreshAt) {
      refGapLeft = this.#lastRefreshAt + (Number(tuning.shopRefreshGapMs) || 0) - Date.now();
    }
    if (g.edge('refresh-gap', refGapLeft > 0, refGapLeft > 0 ? 'left=' + refGapLeft + 'ms' : '')) {
      return refGapLeft;
    }

    // 首次到店（或换了店）：INFO 一次装载货单
    if (this.#loadedXY !== cur.key) {
      env.log.debug('shop: not INFOed yet at %s, send 8540 first.', cur.key);
      return this.#sendInfo(cur) ? tuning.shopGapMs : tuning.shopSweepMs;
    }
    // 选中的货位里找第一个可买/可刷的（补货项=持有清单 shop 渠道勾选，总闸 enabled 已在 #tick 夹过）
    const acted = this.#actOnce(cur);
    g.edge('acted', !acted, acted ? '' : 'nothing actionable in selected rows');
    if (acted) return tuning.shopGapMs;
    // 无可动作：本轮扫完，按 shopSweepMs 轮巡（期间队伍若离店则 #atShop 返回 null 自然停）
    //   带账目计数，事后能回答「是货单齐了还是全被降级」
    env.log.debug(
      'shop: sweep done at %s, selected=%d goodsLoaded=%d degraded=%d boughtSpecs=%d, sleep %dms.',
      cur.key,
      Object.keys(env.cfg().pickItems || {}).length,
      Object.keys(this.#items).length,
      Object.keys(this.#done).length,
      Object.keys(this.#bought).length,
      tuning.shopSweepMs,
    );
    return tuning.shopSweepMs;
  }

  /**
   * 发一条 8540 装载货单（每次到店只一次）。应答 items 覆盖 #items，并置 #loadedXY。
   * @param {{x:number,y:number,key:string}} cur 当前商店点
   * @returns {boolean} true=已发起（应答在 then 里落地）
   */
  #sendInfo(cur) {
    const env = this.#env;
    if (env.secret.isSecretSending(CMD_SHOP_INFO)) return false;
    this.#busy = true;
    const xy = cur.key;
    env.secret.sendSecret(CMD_SHOP_INFO, { x: cur.x, y: cur.y }).then((r) => {
      this.#busy = false;
      if (!env.alive()) return;
      if (isOk(r)) {
        const items = this.#parseItems(r);
        this.#items = items;
        this.#loadedXY = xy;
        // 刷店预算**不在这里归零**（根因 F：刷新应答也会回到本路，归零等于预算无限）：按店计、会话级不重置
        this.#markLedger(cur);
        env.log.debug('shop: INFO %s loaded %d goods.', xy, Object.keys(items).length);
      } else {
        env.log.debug('shop: INFO %s not ok (%s).', xy, (r && r.reason) || 'code ' + (r && r.code));
      }
    });
    return true;
  }

  /**
   * 从应答里取 items → `{specId: getTime}`。应答形：sendSecret 的 Ret.data（可能再嵌一层 data）。
   * @param {object} r Ret
   * @returns {Object<number,number>}
   */
  #parseItems(r) {
    const out = {};
    const outer = (r && r.data) || {};
    const inner = outer.data || outer;
    const arr = Array.isArray(inner.items) ? inner.items : [];
    for (let i = 0; i < arr.length; i++) {
      const it = arr[i];
      if (!it || it.specId == null) continue;
      out[Number(it.specId)] = Number(it.getTime) || 0;
    }
    return out;
  }

  /**
   * 把本店货单回写成 pilot 的店账：`sausage`/`piece` = 该货位的 `getTime`（本次服务已购次数，>0 = 已买过，
   *   存原值而不是布尔，因为选店排序要比大小），`time` = 本次服务时刻（秒）。
   *   额外记 `sausageShelf`（本货单上到底有没有香肠货位）：pilot 的 #shopAllTried 靠它区分
   *   「这家不卖」（已试尽）与「在架但还没买到」（还要再试）。
   *   pilot 拿它算 shopStage 的 gap、选店「香肠没买过」优先与 exitStage 的百兽箱判据。
   * @param {{x:number,y:number,key:string}} cur 当前商店点
   */
  #markLedger(cur) {
    const env = this.#env;
    if (!cur || !cur.key || typeof env.markShopLedger !== 'function') return;
    // 取 41011 货位的 getTime（已购次数，供选店比大小）
    let sausage = 0;
    let shelf = 0;
    const sSpecs = this.#specsOf(ITEM_SAUSAGE) || [];
    for (let i = 0; i < sSpecs.length; i++) {
      if (sSpecs[i] in this.#items) shelf = 1; // 本店货单上有香肠货位（不管买没买过）
      const t = this.#items[sSpecs[i]] || 0;
      if (t > sausage) sausage = t;
    }
    let piece = 0;
    if (this.#ensureIndex()) {
      const t3 = this.#type3Specs || [];
      for (let i = 0; i < t3.length; i++) {
        const spec = t3[i] && t3[i].spec;
        if (spec == null) continue;
        const t = this.#items[spec] || 0;
        if (t > piece) piece = t;
      }
    }
    env.markShopLedger(cur.key, {
      time: Math.floor(Date.now() / 1000),
      sausage: sausage,
      piece: piece,
      sausageShelf: shelf,
    });
  }

  /**
   * 本场是否已有 BOSS 被打死收场（任一 `bossBaseInfo[].state === ST_BOSS_DEAD_END(30)`）。
   *   对齐竞品 shopConver L25204 的 `bossBaseInfo.find(state==30)`（**任一个**而非 [0]）：
   *   清台后香肠价值下降（没 BOSS 可喂）→ 买货优先级从「香肠优先」翻成「百兽箱优先」。
   *   读不到 BOSS 列表（未下发/抛错）一律当**未清**（保守走常态香肠优先，不越权改变行为）。
   * @returns {boolean}
   */
  #bossCleared() {
    const env = this.#env;
    try {
      const list = env.secret.getBossBaseInfo();
      if (!Array.isArray(list)) return false;
      for (let i = 0; i < list.length; i++) {
        if (list[i] && Number(list[i].state) === ST_BOSS_DEAD_END) return true;
      }
    } catch (e) {
      return false;
    }
    return false;
  }

  /**
   * 找第一个「可买」或「可刷」的选中道具并发起一笔动作（一拍一个）。
   * 数据源是合并后的持有清单（pickItems）：行 key=`item:{itemId}`，条目 `shop=1` 即商店补货渠道勾选；
   *   目标持有量 T = `max>0 ? max : 携带上限 para1_v1`（无渠道上限，只有持有上限），
   *   还需补 = `max(0, T - 背包现有)`。这里展开成该道具的全部货行，
   *   逐行判定本店在售（#items）/额度/刷新；账目（#bought/#done）仍按货行 specId 记。
   * @param {{x:number,y:number,key:string}} cur 当前商店点
   * @returns {boolean} true=这一拍发出了一个包
   */
  #actOnce(cur) {
    const env = this.#env;
    const sel = env.cfg().pickItems || {};
    const keys = Object.keys(sel);
    const cur0 = this.#currency();
    if (!cur0) {
      this.#note('currency', 'shop: 3028 currency config unavailable, skip.');
      return false;
    }
    const buyBalance = env.secret.getItemNumById(cur0.buyId);
    // drive 模式下香肠(41011) 由 #grabSausage 独占补满（含 driveSausageRefreshMax 预算刷店）；
    //   通用清单不得重复处理该品目——否则 #grabSausage soldOut 不再置 done 后，本路径 L462 的裸
    //   #sendRefresh 会绕过预算把刷币刷干（手动档 #grabSausage 空转，故仅在 drive 开启时让位）。
    const driveOn = !!(env.cfg().drive && env.cfg().drive.enabled);
    // 百兽箱（type3）/香肠的**购买优先级**随 BOSS 是否已清台而翻（竞品 §9.2 shopConver L25204）：
    //   未清台 → 香肠优先（它是投喂 BOSS 的硬通货，先攒够）；已清台 → 百兽箱优先（没 BOSS 可喂，香肠价值降）。
    //   两档各自「没需求/不在架就 return false」→ 自然形成竞品 `X || Y` 的兜底语义（香肠需但不在架→刷店，不外溢到百兽箱）。
    //   ⚠ 两笔都是「一拍只发一个包」，另一档在同拍 return true 后不执行，下一拍再轮到（无买漏，仅优先级差）。
    if (this.#bossCleared()) {
      if (this.#grabType3(cur, buyBalance)) return true;
      if (this.#grabSausage(cur, buyBalance)) return true;
    } else {
      // 常态：香肠优先（受 #grabSausage 的 `drive.enabled` 子闸约束，手动档不主动补）→ 再百兽箱。
      if (this.#grabSausage(cur, buyBalance)) return true;
      if (this.#grabType3(cur, buyBalance)) return true;
    }
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (k.indexOf(KEY_ITEM) !== 0) continue;
      const e = sel[k];
      if (!e || Number(e.shop) !== 1) continue; // 只看商店补货渠道勾选
      const itemId = Number(k.slice(KEY_ITEM.length));
      if (!(itemId > 0)) continue;
      if (driveOn && itemId === ITEM_SAUSAGE) continue; // 香肠由 #grabSausage 预算化独占，见上
      const specs = this.#specsOf(itemId);
      if (!specs.length) continue;
      /** @type {number[]} 本店在售且本会话未降级的货行 */
      const live = [];
      for (let j = 0; j < specs.length; j++) {
        const spec = specs[j];
        if (this.#done[spec]) continue;
        if (!(spec in this.#items)) continue; // 本店不卖这个货位
        live.push(spec);
      }
      if (!live.length) {
        // 道具在本店无任何可动货位：只有一行且本店不卖 → 跳过留给下一店（不置 done，换店后还要买）；
        //   多行且余下全已降级 → 整行置 done（把未在售的也标掉，避免每拍重复扫描）
        if (specs.length === 1) continue;
        for (let j = 0; j < specs.length; j++) this.#done[specs[j]] = 1;
        continue;
      }
      // 目标持有量 T（max=0 跟随游戏携带上限）→ 还需补 = T - 背包现有
      const limit = this.#targetLimit(itemId, e.max);
      let targetLeft = Infinity;
      if (limit > 0) {
        const have = env.secret.getItemNumById(itemId);
        targetLeft = Math.max(0, limit - have);
        if (targetLeft <= 0) {
          for (let j = 0; j < live.length; j++) this.#done[live[j]] = 1; // 持有已达 T
          continue;
        }
      }
      if (buyBalance <= 0) {
        this.#note('broke' + itemId, 'shop: item ' + itemId + ' no buy currency, skip.');
        for (let j = 0; j < live.length; j++) this.#done[live[j]] = 1; // 缺购买币——本轮降级，下次轮巡再试
        continue;
      }
      for (let j = 0; j < live.length; j++) {
        const spec = live[j];
        const row = this.#row(spec);
        if (!row) {
          this.#done[spec] = 1;
          continue;
        }
        const cost = Number(row.cost) || 0;
        const buyTimes = Number(row.buy_times) || 0;
        const isShared = Number(row.type) === 3;
        const getTime = this.#items[spec] || 0;
        const quotaLeft = Math.max(buyTimes - getTime, 0);
        const bought = this.#bought[spec] || 0;
        // 本行还想买 = min(持有目标差额, 携带余量, 行额度+已购兜底)；无 T（非 171 且 max=0）时只看携带余量 Infinity
        const capRoom = this.#carryRoom(itemId);
        const wantMore = Math.min(targetLeft, capRoom, quotaLeft + bought);
        if (wantMore <= 0) {
          this.#done[spec] = 1; // 携带已满（T 已达）且无额度可刷空间，本行降级
          continue;
        }
        if (cost <= 0 || buyBalance < cost) {
          this.#done[spec] = 1; // 该货行买不起（缺购买币）——本行降级，试下一行
          continue;
        }
        if (quotaLeft <= 0) {
          // 该行额度买完而持有未达：发 8543 把本店全部非 type3 行归零（一次刷新币），下一拍回到本道具继续；
          //   type3 跨店限量不可刷；刷新币不足预检（与游戏 tips enigma_realm74 同口径）则整道具降级
          if (!isShared) {
            const refreshBalance = env.secret.getItemNumById(cur0.refreshId);
            const rcost = this.#refreshCost();
            if (rcost > 0 && refreshBalance >= rcost) {
              return this.#sendRefresh(cur);
            }
            this.#note(
              'refresh' + itemId,
              'shop: item ' + itemId + ' sold out but no refresh currency, stop.',
            );
            for (let m = 0; m < live.length; m++) this.#done[live[m]] = 1;
            break;
          }
          this.#done[spec] = 1; // type3 不可刷：本行降级
          continue;
        }
        // 可买：qty 夹到 min(持有/额度余量, 该行额度剩余, 可负担)（与 clickShopItem 的 min(_lastNum,t,携带余量) 同口径）
        const affordable = Math.floor(buyBalance / cost);
        const qty = Math.min(wantMore, quotaLeft, affordable);
        if (qty < 1) {
          this.#done[spec] = 1; // 算不出可买量，本行降级
          continue;
        }
        return this.#sendBuy(cur, spec, qty, limit, bought);
      }
    }
    return false;
  }

  /**
   * 惰性建货表索引（表静态，每会话一次）：`itemId → specId 列表` + `type3 行清单`。
   * 表未就绪/抛错/空表 → 返回 false 且不落缓存（下拍可重建）。
   * @returns {boolean} true=索引已可用
   */
  #ensureIndex() {
    if (this.#specsByItem) return true;
    const env = this.#env;
    let all;
    try {
      all = env.l10n.tableRows(TABLE_SHOP) || [];
    } catch (e) {
      return false;
    }
    if (!all.length) return false;
    const map = {};
    const type3 = [];
    for (let i = 0; i < all.length; i++) {
      const r = all[i];
      if (!r || r.id == null) continue;
      const spec = Number(r.id);
      const it = Number(r.item_id) || 0;
      if (!(spec > 0) || !(it > 0)) continue;
      (map[it] || (map[it] = [])).push(spec);
      if (Number(r.type) === 3) {
        type3.push({
          spec: spec,
          itemId: it,
          cost: Number(r.cost) || 0,
          buyTimes: Number(r.buy_times) || 0,
        });
      }
    }
    this.#specsByItem = map;
    this.#type3Specs = type3;
    return true;
  }

  /**
   * itemId → 货表全部行 id（specId）：惰性枚举 TABLE_SHOP 建一次缓存（表静态）。
   * 表未就绪/抛错 → 空数组且不落缓存（下拍可重建）。
   * @param {number} itemId
   * @returns {number[]}
   */
  #specsOf(itemId) {
    if (!this.#ensureIndex()) return [];
    return this.#specsByItem[itemId] || [];
  }

  /**
   * type3（跨店共享限量、整场活动限购）道具的最高优先级自动购买：本店货单里有、本会话未降级、全场额度未用尽即优先买一笔。
   *   这类道具已从持有清单面板移除（见 index.js buildPickPool），不受任何「店」勾选控制——只要商店引擎在跑就先把它拿下；
   *   type3 不可刷新，**仅**全场额度确已用尽（`buyTimes-getTime<=0`）才永久 done（B2）：
   *   「不在本店当前 8540 快照」「余额暂不够」「携带满」都是**暂时不可得**，本轮跳过、下拍/换店重试，不写永久 done。
   *   ——旧实现把「买完香肠后瞬时余额不足」也降级成本场永久 done，导致后续几家店再也不重试传奇百兽箱碎片。
   * @param {{x:number,y:number,key:string}} cur 当前商店点
   * @param {number} buyBalance 购买币余额
   * @returns {boolean} true=这一拍发出了一笔 type3 购买
   */
  #grabType3(cur, buyBalance) {
    if (!this.#ensureIndex()) return false;
    const list = this.#type3Specs || [];
    for (let i = 0; i < list.length; i++) {
      const info = list[i];
      const spec = info.spec;
      const t3tag = 'shop: type3 spec=' + spec;
      if (this.#done[spec]) continue;
      if (!(spec in this.#items)) {
        // 本店当拍 8540 快照没带出该 type3 槽：跨店固定限量，不代表本店不卖——仅本轮跳过，下次到店 INFO 重试（不写 done）。
        this.#note(
          't3-noshelf|' + spec,
          t3tag +
            ' not in current shelf snapshot, skip this round (retry next shop). note=not-on-shelf',
        );
        continue;
      }
      const getTime = this.#items[spec] || 0;
      const bought = this.#bought[spec] || 0;
      const quotaLeft = Math.max(info.buyTimes - getTime, 0);
      if (quotaLeft <= 0) {
        this.#done[spec] = 1; // type3 不可刷：全场额度确已用尽 → 永久降级
        this.#note(
          't3-quota|' + spec,
          t3tag +
            ' global quota used up (buyTimes=' +
            info.buyTimes +
            ' getTime=' +
            getTime +
            '), permanent done. note=quota-used',
        );
        continue;
      }
      if (info.cost <= 0) {
        this.#done[spec] = 1; // 货表异常（无价）：永久降级
        continue;
      }
      if (buyBalance < info.cost) {
        // 暂时买不起（如刚买完香肠余额不足 cost）：不永久降级，余额够了下拍/下次到店再买。
        this.#note(
          't3-broke|' + spec,
          t3tag +
            ' balance ' +
            buyBalance +
            ' < cost ' +
            info.cost +
            ', skip this round (retry when affordable). note=broke',
        );
        continue;
      }
      const capRoom = this.#carryRoom(info.itemId);
      const affordable = Math.floor(buyBalance / info.cost);
      const qty = Math.min(quotaLeft + bought, affordable, capRoom);
      if (qty < 1) {
        // 携带位满（碎片罕见）：本轮跳过，不写永久 done，腾出空间后可再买。
        this.#note(
          't3-carry|' + spec,
          t3tag +
            ' no carry room (capRoom=' +
            capRoom +
            '), skip this round (retry). note=carry-full',
        );
        continue;
      }
      return this.#sendBuy(cur, spec, qty, info.buyTimes, bought);
    }
    return false;
  }

  /**
   * 香肠（41011 全素香肠）的**默认补满**：目标持有量 `tuning.driveSausageTarget`(10)。
   *   只在**自动驾驶开着**时生效（手动档不篡改用户意图）：人已停在本店、背包香肠不足目标就买一笔，
   *   直到买满或本店额度耗尽。香肠是投喂 BOSS 的硬通货，故不受持有清单「店」勾选控制。
   * @param {{x:number,y:number,key:string}} cur 当前商店点
   * @param {number} buyBalance 购买币余额
   * @returns {boolean} true=这一拍发出了一笔购买
   */
  #grabSausage(cur, buyBalance) {
    const env = this.#env;
    const dv = env.cfg().drive;
    if (!dv || !dv.enabled) return false;
    const target = Number(tuning.driveSausageTarget) || 0;
    if (!(target > 0)) return false;
    const have = env.secret.getItemNumById(ITEM_SAUSAGE);
    // 进度旗标（计划 E）：单轨日志直接定责「买到几根 / 刷了几次」。#note 边沿去重，每个新 have 值只落一条
    //   （含抵达目标的最后一条），不逐拍刷屏。
    this.#note(
      'sausage-progress-' + cur.key + '-' + have,
      'shop: sausage progress ' +
        have +
        '/' +
        target +
        ' at ' +
        cur.key +
        ', refreshes used ' +
        (Number(this.#refreshTries[cur.key]) || 0),
    );
    if (have >= target) return false;
    const specs = this.#specsOf(ITEM_SAUSAGE);
    let onShelf = false;
    let soldOut = false;
    for (let i = 0; i < specs.length; i++) {
      const spec = specs[i];
      if (this.#done[spec]) continue;
      if (!(spec in this.#items)) continue; // 本店当前货单没香肠
      onShelf = true;
      const row = this.#row(spec);
      if (!row) {
        this.#done[spec] = 1;
        continue;
      }
      const cost = Number(row.cost) || 0;
      if (cost <= 0 || buyBalance < cost) {
        this.#done[spec] = 1; // 买不起——本店降级（缺购买币：刷新不改变余额，不再刷）
        continue;
      }
      const getTime = this.#items[spec] || 0;
      const quotaLeft = Math.max((Number(row.buy_times) || 0) - getTime, 0);
      if (quotaLeft <= 0) {
        // 需求 2（同店刷到买满）：本店香肠额度买完**不再永久 done**——记 soldOut，本轮若无别的可买则走 8543 刷店
        //   把 getTime 归零后继续买（受 driveSausageRefreshMax 与刷新币余额封顶，have>=target 入口闸自然停）。
        soldOut = true;
        continue;
      }
      const affordable = Math.floor(buyBalance / cost);
      const qty = Math.min(target - have, quotaLeft, affordable, this.#carryRoom(ITEM_SAUSAGE));
      if (qty < 1) {
        this.#done[spec] = 1;
        continue;
      }
      // desired 传 0（不按累计件数降级）：目标差额由入口的 have>=target 每拍复判，拿捏最准
      return this.#sendBuy(cur, spec, qty, 0, this.#bought[spec] || 0);
    }
    // 货单上**根本没香肠**，或**香肠本店额度已买完**（需求 2：同店刷到买满）：都走「刷店」（预算 driveSausageRefreshMax）
    //   ——刷新把非 type3 行 getTime 归零，下一拍即可继续买，直到 have>=target 或刷新预算/刷新币耗尽。
    if (specs.length && (!onShelf || soldOut)) return this.#refreshFor(cur, 'sausage');
    return false;
  }

  /**
   * 为目标品不在架而刷一次店。预算与封顶都在本函数：**按店计**且会话内不归零，
   *   每次刷完还受 #tick 里的 shopRefreshGapMs 夹隔；刷新币预检与游戏 tips enigma_realm74 同口径
   *   （不够就彻底放弃，不反复烧币）。
   * @param {{x:number,y:number,key:string}} cur 当前商店点
   * @param {string} what 目标品描述（日志用）
   * @returns {boolean} true=本拍发出了一笔 8543
   */
  #refreshFor(cur, what) {
    const env = this.#env;
    const max = Number(tuning.driveSausageRefreshMax) || 0;
    if (!(max > 0)) return false;
    const tries = Number(this.#refreshTries[cur.key]) || 0;
    if (tries >= max) {
      // 预算烧尽的成因有「不在架」与「本店额度买完」两种（需求 2 后不只前者），统一措辞为 short
      this.#note(
        'rmax' + cur.key,
        'shop: ' + what + ' still short at ' + cur.key + ' after ' + max + ' refreshes, give up.',
      );
      return false;
    }
    const cur0 = this.#currency();
    if (!cur0) return false;
    const rcost = this.#refreshCost();
    if (rcost > 0 && env.secret.getItemNumById(cur0.refreshId) < rcost) {
      this.#note('rcur' + cur.key, 'shop: ' + what + ' still short, no refresh currency.');
      return false;
    }
    this.#refreshTries[cur.key] = tries + 1;
    env.log.info('shop: %s short at %s, refreshing (%d/%d).', what, cur.key, tries + 1, max);
    return this.#sendRefresh(cur);
  }

  /**
   * 发一笔 8542 购买。成功则累加 #bought 并用应答 items 刷新 getTime；162 抖动重试一次；其余降级。
   * @param {{x:number,y:number,key:string}} cur 当前商店点
   * @param {number} spec specId
   * @param {number} qty 本次购买件数
   * @param {number} desired 计划总数（0=买满）
   * @param {number} bought 已购数
   * @returns {boolean}
   */
  #sendBuy(cur, spec, qty, desired, bought) {
    const env = this.#env;
    if (env.secret.isSecretSending(CMD_SHOP_BUY)) return false;
    this.#busy = true;
    env.secret.sendSecret(CMD_SHOP_BUY, { specId: spec, num: qty }).then((r) => {
      this.#busy = false;
      if (!env.alive()) return;
      if (isOk(r)) {
        this.#items = this.#parseItems(r);
        this.#lastBuyEndAt = Date.now();
        this.#bought[spec] = bought + qty;
        this.#markLedger(cur);
        env.log.info(
          'shop: bought spec %d x%d (total %d%s).',
          spec,
          qty,
          this.#bought[spec],
          desired > 0 ? '/' + desired : '',
        );
        if (desired > 0 && this.#bought[spec] >= desired) this.#done[spec] = 1;
        this.#kickSoon();
      } else if (r && r.code === CODE_NOT_SENT) {
        env.log.debug('shop: buy spec %d not sent (secondary/CD), retry later.', spec);
      } else {
        const rej = (r && r.reason) || '';
        if (rej === REJ_RETRY && !this.#retriedBuy[spec]) {
          this.#retriedBuy[spec] = 1;
          env.log.debug('shop: buy spec %d rejected %s, retry once.', spec, rej);
          this.#lastBuyEndAt = Date.now();
          this.#kickSoon();
          return;
        }
        this.#done[spec] = 1;
        env.log.info(
          'shop: buy spec %d rejected (%s), dropped.',
          spec,
          rej || 'code ' + (r && r.code),
        );
      }
    });
    return true;
  }

  /**
   * 发一次 8543 刷新（扣 1 刷新币）。成功用应答 items 刷新 getTime（非 type3 归零）→ 下一拍能继续买。
   * @param {{x:number,y:number,key:string}} cur 当前商店点
   * @returns {boolean}
   */
  #sendRefresh(cur) {
    const env = this.#env;
    if (env.secret.isSecretSending(CMD_SHOP_REFRESH)) return false;
    // 节流时间戳在**发起时**就推进（不能只在成功路径推进，否则旧值不挪会把调度压到下限）
    this.#lastRefreshAt = Date.now();
    this.#busy = true;
    env.secret.sendSecret(CMD_SHOP_REFRESH, { x: cur.x, y: cur.y }).then((r) => {
      this.#busy = false;
      if (!env.alive()) return;
      if (isOk(r)) {
        this.#items = this.#parseItems(r);
        this.#markLedger(cur);
        env.log.info('shop: refreshed %s.', cur.key);
        this.#kickSoon();
      } else {
        env.log.debug('shop: refresh not ok (%s).', (r && r.reason) || 'code ' + (r && r.code));
      }
    });
    return true;
  }

  /**
   * 单次刷新消耗（dataConfig 3029，当前值 1，但运行时读）。
   * @returns {number}
   */
  #refreshCost() {
    const env = this.#env;
    try {
      return Number(env.gameConf.dataConfig(CFG_SHOP_REFRESH_COST)) || 0;
    } catch (e) {
      return 0;
    }
  }

  /**
   * 货表行（运行时枚举表；缺表/缺行回 null）。
   * @param {number} spec specId
   * @returns {object|null}
   */
  #row(spec) {
    const env = this.#env;
    try {
      return env.l10n.tableRow(TABLE_SHOP, spec) || null;
    } catch (e) {
      return null;
    }
  }

  /**
   * 道具的游戏自身携带上限（ITEM type===171 的 para1_v1）；非 171/缺行/为 0 → 0（游戏不设限）。
   * @param {number} itemId 道具 id
   * @returns {number}
   */
  #carryCap(itemId) {
    const env = this.#env;
    let row;
    try {
      row = env.l10n.tableRow(TABLE_ITEM, itemId);
    } catch (e) {
      return 0;
    }
    if (!row || Number(row.type) !== ITEM_TYPE_PAB) return 0;
    return Math.floor(Number(row.para1_v1) || 0);
  }

  /**
   * 目标持有量 T：面板填的 max>0 直接用（已由面板夹到携带上限），max=0 跟随游戏携带上限 para1_v1；
   * 两者皆无（非 171 且未填）→ 0 = 不设持有目标（只剩行额度/携带余量自然夹住）。
   * @param {number} itemId 道具 id
   * @param {number} max 面板目标持有量（0=跟随携带上限）
   * @returns {number}
   */
  #targetLimit(itemId, max) {
    const m = Math.max(0, Math.floor(Number(max) || 0));
    return m > 0 ? m : this.#carryCap(itemId);
  }

  /**
   * 携带余量：产出道具若为 ITEM type===171 且有 para1_v1（游戏携带上限），返回 `max(0, para1_v1-现有)`；
   *   否则 Infinity（游戏不拦该 type，只有持有目标 T 约束）。与 clickShopItem 的 para1_v1 夹取同口径。
   * @param {number} itemId 产出道具 id
   * @returns {number}
   */
  #carryRoom(itemId) {
    if (!(itemId > 0)) return Infinity;
    const cap = this.#carryCap(itemId);
    if (cap <= 0) return Infinity;
    const have = this.#env.secret.getItemNumById(itemId);
    return Math.max(0, cap - have);
  }

  /** 应答落地后尽快复跑（用短延时 kick，避免 busy 未清就抢闸）。 */
  #kickSoon() {
    if (this.#cycle) this.#cycle.kick();
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
   * 启动：建循环并点火（本引擎无事件订阅——纯电平轮巡 + sendSecret promise，故不需 ctx.on.*）。
   * @param {object} _ctx reactor 上下文（本引擎不订阅事件，保留形参位与调用点对称）
   */
  start(_ctx) {
    const env = this.#env;
    const self = this;
    this.#active = true;
    this.#busy = false;
    this.#items = {};
    this.#loadedXY = '';
    this.#refreshTries = {};
    this.#matchKey = '';
    this.#lastRefreshAt = 0;
    this.#bought = {};
    this.#done = {};
    this.#told = {};
    this.#retriedBuy = {};
    this.#gates.reset();
    this.#cycle = createCycle({
      log: env.log,
      alive: function () {
        return self.#active && env.alive();
      },
      run: function () {
        return self.#tick();
      },
      fallback: tuning.shopSweepMs,
    });
    // 首次扫店延迟：太早会撞玩家自己的商店操作窗（面板也发 8540，会互刷 getTime 基准）
    setTimeout(function () {
      if (self.#active && env.alive()) self.#cycle.kick();
    }, tuning.shopFirstDelayMs);
    env.log.info('shop engine started (only restocks when parked at a shop point 161).');
  }

  /**
   * 外部唤醒（pilot 到店时调用）：让补货立刻开跑，不用等下一次电平轮询。
   *   到店那一瞬是本引擎唯一能看到「人在店里」的机会（车只停 driveShopDwellMs），所以方向盘一到店就踢一脚。
   *   幂等：未运行/无循环时静默返回。
   */
  kick() {
    if (this.#active && this.#cycle) this.#cycle.kick();
  }

  /** 停止：置死 #active、摘除 cycle 哨兵。 */
  stop() {
    this.#active = false;
    this.#gates.reset();
    if (this.#cycle) this.#cycle.dispose();
    this.#cycle = null;
    this.#items = {};
    this.#loadedXY = '';
    this.#lastBuyEndAt = 0;
    this.#lastRefreshAt = 0;
    this.#refreshTries = {};
    this.#matchKey = '';
    this.#specsByItem = null;
    this.#type3Specs = null;
  }
}

/**
 * 商店在售道具集（合并后的持有清单数据源用）：运行时枚举 `enigma_secret_realm_shop` 全表，
 * 返回 `{itemId: 1}`——只有货表在售的道具才能在持有清单里勾「商店补货」渠道（行内不置灰）。
 * 表离线无数据、只运行时可枚；表未就绪/符号缺失 → 回空对象（面板全部置灰，引擎自然不动作）。
 * @param {object} l10n ACL l10n（tableRows）
 * @returns {Object<number,1>}
 */
export function shopItemIdSet(l10n) {
  /** @type {Object<number,1>} */
  const out = {};
  let all;
  try {
    all = l10n.tableRows(TABLE_SHOP) || [];
  } catch (e) {
    return out;
  }
  for (let i = 0; i < all.length; i++) {
    const r = all[i];
    if (!r || r.id == null) continue;
    const itemId = Number(r.item_id) || 0;
    if (itemId > 0) out[itemId] = 1;
  }
  return out;
}

/**
 * type3（跨店共享限量、整场活动限购）道具集：枚举货表 `type===3` 行，返回 `{itemId:1}`——
 * 这类道具（如「传奇百兽碎片自选箱」）不进持有清单面板，由 ShopEngine 到店以最高优先级自动购买（见 #grabType3）。
 * 表离线无数据、只运行时可枚；表未就绪/符号缺失 → 回空对象。
 * @param {object} l10n ACL l10n（tableRows）
 * @returns {Object<number,1>}
 */
export function shopType3ItemIds(l10n) {
  /** @type {Object<number,1>} */
  const out = {};
  let all;
  try {
    all = l10n.tableRows(TABLE_SHOP) || [];
  } catch (e) {
    return out;
  }
  for (let i = 0; i < all.length; i++) {
    const r = all[i];
    if (!r || r.id == null) continue;
    if (Number(r.type) !== 3) continue;
    const itemId = Number(r.item_id) || 0;
    if (itemId > 0) out[itemId] = 1;
  }
  return out;
}
