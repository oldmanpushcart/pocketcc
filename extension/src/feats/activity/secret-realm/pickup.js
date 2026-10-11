/**
 * 物品自动拾取引擎（异能秘境：掉落箱 + 资源点 + 增益井，仅当前到达点）。
 *
 * 触发模型（**三触发源，同一套闸门**）：
 *   ① EventCenter 事件（由 **CHANGE 推送** emit，载荷自带 x,y 与完整明细）：
 *     - 21532 ENIGMA_SECRET_ROOM_DROP_CHANGE → PabRoomRewardBoxDataUpdate，载荷 {x,y,dropInfo,dropBeastInfo,bagGetNum,beastGetNum}
 *     - 21522 ENIGMA_SECRET_ROOM_RESOURCE_CHANGE → PabRoomResLibraryDataUpdate，载荷 {x,y,bagInfo,buffInfo,bagGetNum,buffGetNum,refreshTime}
 *   ② 资源点：**8526 RESOURCE_INFO 应答**（`ctx.on.resp(8526)`；core/net.js 原先只把推送派到 bus
 *     （`dispatch` 仅在 t===undefined 时跑，应答的 t=_.reqTime），现已按 dir 分命名空间补上 `net.resp.<cmd>`）：
 *     载荷 inner = {bagInfo,buffInfo,refreshTime,bagGetNum,buffGetNum}，**无 x,y**——但 RESOURCE_GET 只需 {rId}、
 *     RESOURCE_GET_BUFF 只需 {rId,pos}，所以不缺坐标也能直接消费。
 *   ③ 掉落箱：**8532 DROP_INFO 的 req↔resp 配对**（`ctx.on.req(8532)` 拿 {x,y} + `ctx.on.resp(8532)` 拿明细）：
 *     应答 inner = {info,dropBeastInfo,endTime,playerInfo,bagGetNum,beastGetNum}（数组键名是 `info` 而非推送用的
 *     `dropInfo`）且**不带坐标**，而 DROP_GET 必须要 {x,y,rId}（实证 PabRewardBoxNode
 *     `sendPBV2(ENIGMA_SECRET_ROOM_DROP_GET,{x:this._tileInfo.tileX,y:this._tileInfo.tileY,rId:e.getUuid()})`）
 *     → 坐标只能从**发包侧**补：游戏 INFO 的请求就是 `{x:this._tileInfo.tileX,y:this._tileInfo.tileY}`（源码与报文双实证）。
 *   为什么必须有 ②③：CHANGE 推送只在**点位数据真的变了**（有人拾取/刷新）时广播，实测安静时段整局 0 条；
 *     而游戏自己在我们打开点位面板时必发 INFO（`PabResLibraryNode.requestData` / `PabRewardBoxNode`），该应答
 *     **不 emit 任何全局事件**（只回调刷新组件），故仅靠 ① 会整局睡死。
 *     报文实证：dashcam 20261010T211420-异能秘境-队长 两次到点都有 21529 TEAM_ARRIVE → 8526 应答
 *     （bagInfo 10/9 条全空闲、bagGetNum=0）却零条 21522 → 引擎未醒、一个 8527 没发；
 *     dashcam 20261004T202430-异能秘境-我是队长-发车 共 9 条 8532/8533 应答，INFO 应答总在 21532 推送后 1~2s 到，
 *     而开局 seq=31 那一条前面**没有任何推送先行**（只靠 ① 就永久错过）。
 *   配对精度：应答事件带 Event.reqTime（= 该应答**那条请求的发出时刻**，游戏按应答的 e.o 在 _requestPacks 里
 *     反查后 verbatim `onMessage(e,…,d.reqTime)` 递进 core/net.js），所以按「ts <= reqTime 中最大的一条」精确取坐标，
 *     不依赖先后顺序；reqTime 取不到时（游戏改版）才退回同 cmd 的 FIFO + TTL 近似。配不到坐标的应答整条丢弃（宁缺不错），
 *     队列溢出则整窗作废——因为错配的后果不是「漏拾」而是拿错点坐标去发 8533，被拒后还会把本来能拾的 dropId 拉黑 6h。
 *   我们只在触发到来时按同口径闸门复刻判定，对「当前刷新的这一个点位」补发 GET 包——绝不主动发 INFO、不遍历全图。
 *
 * 面板语义（本期改造）：
 *   - 三大拾取（掉落箱物品/宠物、资源点 bag）合并为一个 autoPickup 大开关；细化通过 pickItems 行式配置：
 *       每项一个 checkbox（on/off 是否拾取）+ 一个数字（秘境背包数量上限，0=跟随游戏 para1_v1，不额外限）。
 *   - 增益井 buff 单独走 autoBuff（协议不同、pos 语义不同），不参与 pickItems 清单。
 *   - 拍宠物另在 capture.js，与此解耦。
 *
 * 池 key 命名（**按道具 ID 聚合**）：`item:{itemId}` 同时涵盖掉落箱物品与资源点产出道具
 *   （实证 dump：rss_station 按点位分行，item=41001 有 44 个 specId、item=41009 有 5 个，逐点位列行会出大片同名项；
 *   且数量上限本就按 `getItemNumById(itemId)` 计）；`pet:{cfgId}` 掉落箱宠物（不合并）。
 *   `rss:{specId}` 仅作兜底（specId 映射不到产出道具时）。
 *
 * 闸门（源码 verbatim：PabRewardBoxNode / PabResLibraryNode / PabBuffEquipNode / PabBagItem）：
 *   掉落箱（DROP_GET 8533，req {x,y,rId=dropId}）：
 *     - 已领判据 checkItemIdGeted(itemId)：dropInfo 里 `info.itemId==itemId && uid==me` → 跳过；
 *     - **他人已占判据（四类通用）**：条目 `uid` 非空且非我 → 已被队友领走，跳过。实证 8527 应答 57 条里 17 条
 *       `s=3 d=enigma_realm161`「已经被其他指挥官拿走咯」；bagInfo 5287 条里 3032 条带非零 uid、其中仅 110 条是我
 *       → 不过滤就是拿 96% 的无效条目去撞拒绝（游戏 UI 同口径显示 enigma_realm165「已被{0}拿走」，见 PabBagItem.onItemClick）；
 *     - 总量上限 `_itemGetMax=Number(dataConfig(3021))`，已领数 `bagGetNum+beastGetNum` 达上限即停；
 *     - 游戏背包上限 checkItemNumMax(itemId)（仅 type==171 且 para1_v1 有值时判）为真 → 跳过；
 *     - **feat 侧 per-item max**：cfg.pickItems['item:'+itemId].max（>0 生效）且 `pab.getItemNumById(itemId)` >= max → 跳过；
 *     - **feat 侧 per-item off**：cfg.pickItems['item:'+itemId].on===0 → 跳过；
 *     - 宠物 dropBeastInfo 同走 DROP_GET，上限键 dataConfig(3061)；pet 只做 on/off（无数量概念，忽略 max）。
 *   资源 bag（RESOURCE_GET 8527，req {rId=dropId}，**无 x,y**）：
 *     - 上限 dataConfig(3013).split('|')[0]=itemMax；`bagGetNum>=itemMax` 停；
 *     - 已领 checkItemIdGeted(specId)：bagInfo 里 `specId==e && uid==me` → 跳过；
 *     - **同点位同道具只可 1 次**：把我已领的条目按 `.item` 归成集合，同点位内该道具的其它 specId 也跳过
 *       （实证 8527 `s=3 d=enigma_realm119`「同一资源点内相同道具只能获取1次」—— 判重维度是**道具**而不是 specId）；
 *     - itemId 由 enigma_secret_realm_rss_station[specId].item 映射，映射后**与该道具共用同一行面板勾选**（过 checkItemNumMax + per-item max）。
 *   增益 buff（RESOURCE_GET_BUFF 8538，req {rId,pos}）：
 *     - `buffGetNum>=buffMax`（3013 的 [1]）停；仅队长可装（isTeamLeader）；
 *     - 类勾选 cfg.buffEffects（effect_buff 数组，默认三类，空=不限）：不属所选类 → 不拾；
 *     - **pos 依 PabBuffEquipNode.initNode + PabBuffSelectItem 语义**：`roomBaseInfo.buffMap[1..3]`，
 *       先找同 effect_buff 已占槽（新 buff_para>旧 → 等价替换；否则直接跳过，**绝不回落空槽**→保证三类不重复），
 *       无同类已装时才取首个空槽；全满且无更强 → 跳过。
 *
 * 共同约束：rId=dropId 原值透传（Int64 不 Number 化，仅拉黑 key 用字符串）；被拒（header.s≠0，非「未发出」）6h 拉黑该 dropId
 *   防逐拍重发刷屏；被拒走 info 日志不打 warn，且把 header.d（拒绝原因 loc 键，经 net.js Ret.reason 透传）的译文一并打出。只读+发包红线：全程 sendSecret 发 GET，不碰游戏 Update/Delete、不改本地态。
 */
import {
  CMD_DROP_GET,
  CMD_DROP_INFO,
  CMD_RESOURCE_GET,
  CMD_RESOURCE_GET_BUFF,
  CMD_RESOURCE_INFO,
  CFG_DROP_ITEM_MAX,
  CFG_DROP_PET_MAX,
  CFG_RES_LIMITS,
  EVT_REWARD_BOX_UPDATE,
  EVT_RES_LIBRARY_UPDATE,
  TABLE_RSS_STATION,
  BUFF_SLOT_MIN,
  BUFF_SLOT_MAX,
  CODE_NOT_SENT,
  tuning,
} from './constants.js';

/**
 * Int64 感知的稳定字符串键（dropId 可能是 Int64 对象或数字串）：优先 .toString()，退 String()。
 * @param {*} v dropId 原值
 * @returns {string}
 */
function idKey(v) {
  if (v == null) return '';
  if (typeof v === 'object' && typeof v.toString === 'function') return v.toString();
  return String(v);
}

/**
 * pickItems 行查询：给定 cfg + 池 key → 返回 `{on:boolean, max:number}`（未登记的项视为默认：on=true / max=0=不限）。
 * @param {object} cfg 面板配置（含 pickItems 对象）
 * @param {string} key 池 key（'item:xxx' / 'rss:xxx' / 'pet:xxx'）
 * @returns {{on:boolean, max:number}}
 */
function pickRow(cfg, key) {
  const m = cfg && cfg.pickItems;
  const e = m && m[key];
  if (!e) return { on: true, max: 0 };
  return { on: Number(e.on) !== 0, max: Math.max(0, Number(e.max) || 0) };
}

/**
 * 点位明细快照：只复制本引擎实际读到的字段（dropId/specId/uid 与几个标量），脱离池化报文的复用生命周期。
 * 必要性：`Event.data` 直接包的是 `pbAckV2` 引用，而载荷要被 #pending 持到一个去抖窗口之后才消费。
 * @param {object} inner 8526 应答 / 21522 推送的点位载荷 {x?,y?,bagInfo?,buffInfo?,bagGetNum?,buffGetNum?}
 * @returns {object} 稳定副本（可跨拍持有）
 */
function snapshotRes(inner) {
  const pick = function (arr) {
    const out = [];
    if (!Array.isArray(arr)) return out;
    for (let i = 0; i < arr.length; i++) {
      const b = arr[i];
      if (!b) continue;
      out.push({ dropId: b.dropId, specId: b.specId, uid: b.uid });
    }
    return out;
  };
  return {
    x: inner.x,
    y: inner.y,
    bagInfo: pick(inner.bagInfo),
    buffInfo: pick(inner.buffInfo),
    bagGetNum: inner.bagGetNum,
    buffGetNum: inner.buffGetNum,
  };
}

/**
 * 掉落箱明细快照：把 8532 DROP_INFO 的应答凑成与 21532 推送同形的载荷（应答的数组键名是 `info`，推送用 `dropInfo`），
 * 并补上从**发包侧**配对来的 x,y。同样必须就地快照（应答对象是池化引用，要跨去抖窗口才消费）；
 * 下游只读 dropId / info.itemId / info.cfgId / uid，故只复制这几个字段（`info` 取浅拷贝，不持池化子对象引用）。
 * @param {object} inner 8532 应答 {info[],dropBeastInfo[],bagGetNum,beastGetNum,endTime}
 * @param {number} x 配对到的点位横号
 * @param {number} y 配对到的点位纵号
 * @returns {object} 可跨拍持有的稳定副本
 */
function snapshotReward(inner, x, y) {
  const pick = function (arr) {
    const out = [];
    if (!Array.isArray(arr)) return out;
    for (let i = 0; i < arr.length; i++) {
      const b = arr[i];
      if (!b || b.dropId == null) continue;
      const info = b.info || {};
      out.push({ dropId: b.dropId, uid: b.uid, info: { itemId: info.itemId, cfgId: info.cfgId } });
    }
    return out;
  };
  return {
    x: x,
    y: y,
    dropInfo: pick(inner.info),
    dropBeastInfo: pick(inner.dropBeastInfo),
    bagGetNum: inner.bagGetNum,
    beastGetNum: inner.beastGetNum,
  };
}

/**
 * 拾取引擎：事件订阅 + 去抖合并 + 单飞消费（无周期循环，纯被动响应点位刷新事件）。
 */
export class PickupEngine {
  #env;
  /** @type {Map<string, number>} 被拒 dropId（字符串键）→ 拉黑到期时间戳 */
  #blacklist = new Map();
  /** @type {{reward:object|null, res:object|null}} 去抖窗口内缓存的最新两类刷新载荷 */
  #pending = { reward: null, res: null };
  /** @type {number|null} 去抖定时器句柄 */
  #timer = null;
  /** @type {boolean} 单飞闸门：一批 GET 在飞时不并发第二批 */
  #running = false;
  /**
   * @type {{x:number,y:number,ts:number}[]} 掉落箱 DROP_INFO 的**请求坐标**队列（按 reqTime 精确命中后 splice 摘除）。
   * 存这个队列是因为 8532 应答不带 x,y，而 DROP_GET 必须要 x,y。
   */
  #dropReqQ = [];

  /** @param {object} env 注入底座 {alive, realmActive, cfg, secret, gameConf, gameData, l10n, log} */
  constructor(env) {
    this.#env = env;
  }

  /**
   * 启动：登记两个点位刷新事件订阅 + 一个 8526 应答订阅（退订均由 reactor 托管）。
   * @param {object} ctx reactor 上下文（提供 on.event / on.resp）
   */
  start(ctx) {
    const self = this;
    ctx.on.event(EVT_REWARD_BOX_UPDATE, function (e) {
      self.#onEvent('reward', e);
    });
    ctx.on.event(EVT_RES_LIBRARY_UPDATE, function (e) {
      self.onEventRes(e);
    });
    // 触发源②：到点后玩家（或游戏自动）打开资源点面板时游戏自己发的 INFO 应答——CHANGE 推送缺位时唯一的唤醒源
    ctx.on.resp(CMD_RESOURCE_INFO, function (ev) {
      self.onResourceInfoResp(ev);
    });
    // 触发源③：掉落箱 INFO 的请求带 {x,y}、应答带明细但不带坐标，两条凑齐才能发 DROP_GET
    ctx.on.req(CMD_DROP_INFO, function (ev) {
      self.#onDropInfoReq(ev);
    });
    ctx.on.resp(CMD_DROP_INFO, function (ev) {
      self.#onDropInfoResp(ev);
    });
    this.#env.log.info(
      'pickup engine started (CHANGE events + 8526 resp + 8532 req/resp pair, current-tile only).',
    );
  }

  /** 资源点事件入口（保留公开名便于调试面手动触发；语义同 #onEvent）。 */
  onEventRes(e) {
    this.#onEvent('res', e);
  }

  /**
   * 8526 RESOURCE_INFO 应答入口：只在 `status===0` 且载荷确实带 bagInfo/buffInfo 时消费，
   * 并**就地快照**（应答对象是池化引用，不能交给去抖窗口之后的 #flush 再读）。
   * @param {object} ev bus `net.resp.<cmd>` 事件（Event 实例：{cmd,status,data,raw}）
   */
  onResourceInfoResp(ev) {
    if (!ev || (ev.status != null && Number(ev.status) !== 0)) return;
    const outer = ev.data || {};
    const inner = outer.data || outer;
    if (!Array.isArray(inner.bagInfo) && !Array.isArray(inner.buffInfo)) return;
    this.#onEvent('res', snapshotRes(inner));
  }

  /**
   * 掉落箱 INFO 的**发包**入口：只于一件事——把这次请求的 {x,y} 入队（应答里没有坐标）。
   * 载荷 data 是游戏面板就地构造的字面量（`{x:this._tileInfo.tileX,y:this._tileInfo.tileY}`），取数即走，不持引用。
   * @param {object} ev bus `net.req.<cmd>` 载荷 {cmd,key,data,ts}
   */
  #onDropInfoReq(ev) {
    const d = (ev && ev.data) || {};
    const x = Number(d.x);
    const y = Number(d.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return; // 不带坐标的包不是我们要配的那族
    const q = this.#dropReqQ;
    q.push({ x: x, y: y, ts: Number(ev && ev.ts) || Date.now() });
    // 面板连点会积压：一过上限就整窗作废（此时顺序已不可信，留着半队坐标去猜就是把错点写进 DROP_GET）
    if (q.length > tuning.dropPairQueueMax) {
      const n = q.length;
      this.#dropReqQ = [];
      this.#env.log.debug('drop req queue overflow (%d pending), pairing window discarded.', n);
    }
  }

  /**
   * 掉落箱 INFO 的**应答**入口：先从队列里定位那条请求的 {x,y}，凑成与 21532 推送同形的载荷喂同一套闸门。
   * 配不到坐标（本 feat 启动前就发出的包、或超出兜底窗）就整条丢弃——DROP_GET 必须要 {x,y}，宁缺不错。
   * @param {object} ev bus `net.resp.<cmd>` 事件（Event 实例：{cmd,status,data,reqTime,raw}）
   */
  #onDropInfoResp(ev) {
    const env = this.#env;
    if (!ev || (ev.status != null && Number(ev.status) !== 0)) return;
    const outer = ev.data || {};
    const inner = outer.data || outer;
    if (!Array.isArray(inner.info) && !Array.isArray(inner.dropBeastInfo)) return;
    const q = this.#dropReqQ;
    const rt = typeof ev.reqTime === 'number' ? ev.reqTime : 0;
    let hit = -1;
    if (rt) {
      // 精确档：reqTime 就是「本条应答那次发包」的时刻，取 ts <= reqTime 中最大的一条即该次发包本身
      //   （req 侧 ts 打在 orig.apply 之前、reqTime 打在游戏内部，恒有 reqTime >= ts，所以是单侧界而非区间）
      for (let i = 0; i < q.length; i++) {
        if (q[i].ts > rt) continue;
        if (hit < 0 || q[i].ts > q[hit].ts) hit = i;
      }
      if (hit < 0) {
        env.log.debug('drop info resp has no 8532 req at or before its reqTime, ignored.');
        return;
      }
    } else {
      // 兜底档（游戏改版取不到 reqTime 时）：同 cmd 先进先出 + TTL，配不到就整条丢弃
      const now = Date.now();
      for (let i = 0; i < q.length; i++) {
        if (now - q[i].ts <= tuning.dropPairTtlMs) {
          hit = i;
          break;
        }
      }
      if (hit < 0) {
        env.log.debug('drop info resp unmatched (no pending {x,y} from 8532 req), ignored.');
        return;
      }
    }
    const c = q.splice(hit, 1)[0];
    this.#onEvent('reward', snapshotReward(inner, c.x, c.y));
  }

  /** 停止：撤去抖定时器与配对队列（事件退订由 reactor 统一摘除；在飞请求自然 settle）。 */
  stop() {
    if (this.#timer != null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    this.#pending = { reward: null, res: null };
    this.#dropReqQ = [];
  }

  /**
   * 事件总入口：门控通过后缓存最新载荷并按去抖窗口安排一次消费。
   * 门控不过去时打一行 debug（区分 feat 未激活 / 不在秘境地图 / 拾取开关全关），免得下次只能靠「一个包都没发」倒推。
   * @param {'reward'|'res'} kind 点位类别
   * @param {object} e 事件载荷
   */
  #onEvent(kind, e) {
    const env = this.#env;
    if (!e) return;
    if (!env.alive() || !env.realmActive() || !this.#anyPickup()) {
      env.log.debug(
        'pickup wake ignored by gate: alive=%s realmActive=%s anyPickup=%s kind=%s.',
        env.alive(),
        env.realmActive(),
        this.#anyPickup(),
        kind,
      );
      return;
    }
    this.#pending[kind] = e;
    if (this.#timer == null) {
      const self = this;
      this.#timer = setTimeout(function () {
        self.#timer = null;
        self.#flush();
      }, tuning.pickupDebounceMs);
    }
  }

  /**
   * 消费去抖窗口内缓存的两类载荷；单飞闸门，结束后若窗口又攒了新载荷则再排一轮。
   */
  #flush() {
    const env = this.#env;
    if (this.#running) return;
    if (!env.alive() || !env.realmActive() || !this.#anyPickup()) {
      this.#pending = { reward: null, res: null };
      return;
    }
    const p = this.#pending;
    this.#pending = { reward: null, res: null };
    this.#running = true;
    const self = this;
    const step = async function () {
      if (p.reward) await self.#pickupReward(p.reward);
      if (p.res) await self.#pickupRes(p.res);
    };
    step()
      .catch(function (e) {
        env.log.warn('pickup flush error.', e);
      })
      .then(function () {
        self.#running = false;
        if (self.#pending.reward || self.#pending.res) {
          if (self.#timer == null) {
            self.#timer = setTimeout(function () {
              self.#timer = null;
              self.#flush();
            }, tuning.pickupDebounceMs);
          }
        }
      });
  }

  /**
   * 拾取大开关（物品合并：掉落箱物品+宠物+资源点 bag）或增益井 buff 任一开启才调度消费。
   * 拍宠物不在此列（走 capture.js 独立 cycle）。
   * @returns {boolean}
   */
  #anyPickup() {
    const c = this.#env.cfg();
    return !!(c.autoPickup || c.autoBuff);
  }

  /**
   * 掉落箱拾取（受大开关 autoPickup 控制）：逐条 dropInfo（物品）与 dropBeastInfo（宠物）复刻闸门后发 DROP_GET。
   * 物品与宠物共享 bagGetNum+beastGetNum 总量闸门；per-item 由 cfg.pickItems 独立勾选与背包数量上限。
   * @param {object} e {x,y,dropInfo[],dropBeastInfo[],bagGetNum,beastGetNum}
   * @returns {Promise<void>}
   */
  async #pickupReward(e) {
    const env = this.#env;
    const cfg = env.cfg();
    if (!cfg.autoPickup) return;
    const x = e.x;
    const y = e.y;
    const dropInfo = Array.isArray(e.dropInfo) ? e.dropInfo : [];
    const dropBeastInfo = Array.isArray(e.dropBeastInfo) ? e.dropBeastInfo : [];
    const me = env.gameData.myUidStr();
    const pab = env.secret.getPabController();
    const itemGetMax = Number(env.gameConf.dataConfig(CFG_DROP_ITEM_MAX)) || 0;
    const petMax = Number(env.gameConf.dataConfig(CFG_DROP_PET_MAX)) || 0;
    let gotCount = (Number(e.bagGetNum) || 0) + (Number(e.beastGetNum) || 0);

    // A. 掉落物品（逐条 await 会跨拍：feat 一旦 pause/离场即停摆，不拿陈旧快照继续发写请求）
    for (let i = 0; i < dropInfo.length; i++) {
      if (!env.alive()) return;
      if (gotCount >= itemGetMax) break;
      const it = dropInfo[i];
      if (!it || it.dropId == null) continue;
      const itemId = Number(it.info && it.info.itemId);
      if (!itemId) continue;
      const row = pickRow(cfg, 'item:' + itemId);
      if (!row.on) continue; // 用户关闭该物品
      if (this.#blacked(it.dropId)) continue;
      if (this.#itemIdGeted(itemId, dropInfo, me)) continue; // 同点位同 itemId 已被我领
      if (this.#takenByOther(it, me)) continue; // 已被队友领走（d=enigma_realm161）
      if (pab && this.#itemNumMax(pab, itemId)) continue; // 游戏 para1_v1
      if (row.max > 0 && pab && this.#roomBagNum(pab, itemId) >= row.max) continue; // feat 侧 per-item 背包上限
      const ret = await env.secret.sendSecret(CMD_DROP_GET, { x: x, y: y, rId: it.dropId });
      if (ret && ret.ok) gotCount++;
      else this.#blackOnReject(it.dropId, ret);
    }

    // B. 掉落宠物（仅 on/off；checkPetIdGeted 语义：dropBeastInfo 已含我 uid 的一条即视为满）
    const petMine = dropBeastInfo.some(function (o) {
      return o && String(o.uid) === me;
    });
    if ((petMine ? 1 : 0) < petMax) {
      for (let j = 0; j < dropBeastInfo.length; j++) {
        if (!env.alive()) return;
        if (gotCount >= itemGetMax) break;
        const pet = dropBeastInfo[j];
        if (!pet || pet.dropId == null) continue;
        if (String(pet.uid) === me) continue;
        if (this.#takenByOther(pet, me)) continue; // 已被队友领走（d=enigma_realm161）
        const cfgId = Number(pet.info && pet.info.cfgId);
        if (cfgId) {
          const row = pickRow(cfg, 'pet:' + cfgId);
          if (!row.on) continue;
        }
        if (this.#blacked(pet.dropId)) continue;
        const ret = await env.secret.sendSecret(CMD_DROP_GET, { x: x, y: y, rId: pet.dropId });
        if (ret && ret.ok) gotCount++;
        else this.#blackOnReject(pet.dropId, ret);
      }
    }
  }

  /**
   * 资源 bag 与增益井 buff 拾取：bagInfo 逐条发 RESOURCE_GET（仅 rId），buffInfo 依 buffMap 首个空槽位（或同 effect_buff 替换）发 RESOURCE_GET_BUFF。
   * @param {object} e {x,y,bagInfo[],buffInfo[],bagGetNum,buffGetNum,refreshTime}
   * @returns {Promise<void>}
   */
  async #pickupRes(e) {
    const env = this.#env;
    const cfg = env.cfg();
    const bagInfo = Array.isArray(e.bagInfo) ? e.bagInfo : [];
    const buffInfo = Array.isArray(e.buffInfo) ? e.buffInfo : [];
    const me = env.gameData.myUidStr();
    const pab = env.secret.getPabController();
    const limits = String(env.gameConf.dataConfig(CFG_RES_LIMITS) || '').split('|');
    const itemMax = Number(limits[0]) || 0;
    const buffMax = Number(limits[1]) || 0;

    // C. 资源 bag（走 autoPickup 大开关；RESOURCE_GET req 仅 {rId}）
    if (cfg.autoPickup) {
      // 本点位内我已领过的**道具**集合：同道具只能拿 1 次（实证 8527 s=3 d=enigma_realm119
      // 「同一资源点内相同道具只能获取1次」），判重维度是 item 而不是 specId（同点位可多行产出同一 item）。
      /** @type {Set<number>} */
      const mineItems = new Set();
      for (let i = 0; i < bagInfo.length; i++) {
        const b = bagInfo[i];
        if (!b || !me || String(b.uid) !== me) continue;
        const st = env.l10n.tableRow(TABLE_RSS_STATION, b.specId);
        const id = st ? Number(st.item) || 0 : 0;
        if (id) mineItems.add(id);
      }
      let gotBag = Number(e.bagGetNum) || 0;
      for (let i = 0; i < bagInfo.length; i++) {
        if (!env.alive()) return;
        if (gotBag >= itemMax) break;
        const it = bagInfo[i];
        if (!it || it.dropId == null) continue;
        if (this.#blacked(it.dropId)) continue;
        if (this.#specGeted(it.specId, bagInfo, me)) continue;
        if (this.#takenByOther(it, me)) continue; // 已被队友领走（d=enigma_realm161）
        const station = env.l10n.tableRow(TABLE_RSS_STATION, it.specId);
        const itemId = station ? Number(station.item) || 0 : 0;
        if (itemId && mineItems.has(itemId)) continue; // 同点位该道具已拿过（换个 specId 也拿不到）
        // 勾选与上限都按道具维度（面板清单已按 itemId 聚合）；映射不到道具时退回 specId 键
        const row = pickRow(cfg, itemId ? 'item:' + itemId : 'rss:' + it.specId);
        if (!row.on) continue;
        if (itemId && pab) {
          if (this.#itemNumMax(pab, itemId)) continue;
          if (row.max > 0 && this.#roomBagNum(pab, itemId) >= row.max) continue;
        }
        const ret = await env.secret.sendSecret(CMD_RESOURCE_GET, { rId: it.dropId });
        if (ret && ret.ok) gotBag++;
        else this.#blackOnReject(it.dropId, ret);
      }
    }

    // D. 增益井 buff（autoBuff 开关 + buffEffects 类勾选；RESOURCE_GET_BUFF req {rId,pos}；仅队长可装；pos 依 buffMap 同类替换或首个空槽）
    if (cfg.autoBuff && pab && buffInfo.length) {
      const gotBuff = Number(e.buffGetNum) || 0;
      if (gotBuff < buffMax) {
        const want = Array.isArray(cfg.buffEffects) ? cfg.buffEffects : [];
        try {
          if (pab.isTeamLeader()) {
            for (let k = 0; k < buffInfo.length; k++) {
              if (!env.alive()) return;
              const b = buffInfo[k];
              if (!b || b.dropId == null) continue;
              if (me && String(b.uid) === me) continue; // 已装备到我槽位（若带 uid）
              if (this.#takenByOther(b, me)) continue; // 已被队友装走（d=enigma_realm161）
              if (this.#blacked(b.dropId)) continue;
              // 用户只勾了部分增益类（空数组=不限）：不属所选类 → 不拾
              if (want.length) {
                const srow = env.l10n.tableRow(TABLE_RSS_STATION, b.specId);
                const eff = srow ? Number(srow.effect_buff) || 0 : 0;
                if (!eff || want.indexOf(eff) < 0) continue;
              }
              const pos = this.#pickBuffPos(b.specId, pab);
              if (!pos) continue; // 无空槽且无更强替换 → 跳过
              const ret = await env.secret.sendSecret(CMD_RESOURCE_GET_BUFF, {
                rId: b.dropId,
                pos: pos,
              });
              if (!(ret && ret.ok)) this.#blackOnReject(b.dropId, ret);
              // 一轮只装一枚：装备成功后 buffMap 需等 push 更新，避免同拍重发同一槽位
              break;
            }
          }
        } catch (err) {
          env.log.info('buff pickup skipped (isTeamLeader threw).', err);
        }
      }
    }
  }

  /**
   * 同 itemId 是否已被我领过（dropInfo 里 info.itemId==itemId && uid==me，对齐 PabRewardBoxNode.checkItemIdGeted）。
   * @param {number} itemId 目标 itemId
   * @param {object[]} list dropInfo
   * @param {string} me 我的 UID 字符串
   * @returns {boolean}
   */
  #itemIdGeted(itemId, list, me) {
    if (!me) return false;
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      const id = a && a.info && Number(a.info.itemId);
      if (id && id === itemId && String(a.uid) === me) return true;
    }
    return false;
  }

  /**
   * 同 specId 是否已被我领（bagInfo 里 specId==e && uid==me，对齐 PabResLibraryNode.checkItemIdGeted）。
   * @param {number|string} specId 资源 specId
   * @param {object[]} list bagInfo
   * @param {string} me 我的 UID 字符串
   * @returns {boolean}
   */
  #specGeted(specId, list, me) {
    if (!me || specId == null) return false;
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (a && String(a.specId) === String(specId) && String(a.uid) === me) return true;
    }
    return false;
  }

  /**
   * 游戏侧背包上限判定（原生 checkItemNumMax，仅 type==171 且 para1_v1 有值时判 getItemNumById >= para1_v1，
   * 其余 type 直接放行）。面板对这类道具标 ≤para1_v1 并把用户填的 max 夹到该值。异常按「未达上限」放行。
   * @param {object} pab PabController 实例
   * @param {number} itemId 物品 id
   * @returns {boolean} true=背包已满应跳过
   */
  #itemNumMax(pab, itemId) {
    if (!itemId) return false;
    try {
      return !!pab.checkItemNumMax(itemId, false);
    } catch (e) {
      return false;
    }
  }

  /**
   * 秘境个人背包（roomBagInfo.bagInfo）当前数量（getItemNumById 默认 t=false → 读 bagInfo）。异常/缺方法回 0。
   * @param {object} pab PabController 实例
   * @param {number} itemId 物品 id
   * @returns {number}
   */
  #roomBagNum(pab, itemId) {
    if (!itemId) return 0;
    try {
      return Number(pab.getItemNumById(itemId)) || 0;
    } catch (e) {
      return 0;
    }
  }

  /**
   * buff 装备槽位选择（PabBuffEquipNode.initNode + PabBuffSelectItem._replaceEnable 语义复刻）：
   *   1) 先找同 effect_buff 已占的槽：新 buff_para > 旧 → 回该 pos（等价替换更强）；**否则直接回 0**
   *      ——游戏里 r>0 时只会停在该槽（initNode 命中同 effect 即 break），绝不回落空槽，
   *      不这么处理就会把同类增益装到两个槽上（用户要求的「三个不能重复」）；
   *   2) 无同类已装 → 取首个空槽（buffMap[pos]=0/未定义）；
   *   3) 都无 → 回 0，调用方跳过装备。
   * @param {number|string} newSpecId 新 buff 对应的 rss_station specId
   * @param {object} pab PabController 实例
   * @returns {number} 1..3 表示目标 pos；0 表示跳过
   */
  #pickBuffPos(newSpecId, pab) {
    const env = this.#env;
    let bm;
    try {
      bm = pab.roomBaseInfo && pab.roomBaseInfo.buffMap;
    } catch (e) {
      bm = null;
    }
    if (!bm) return BUFF_SLOT_MIN; // 无 buffMap 视为未装，走首槽
    const newRow = env.l10n.tableRow(TABLE_RSS_STATION, newSpecId);
    const newEffect = newRow ? Number(newRow.effect_buff) || 0 : 0;
    const newPara = newRow ? Number(newRow.buff_para) || 0 : 0;
    if (newEffect) {
      for (let p = BUFF_SLOT_MIN; p <= BUFF_SLOT_MAX; p++) {
        const curSpecId = Number(bm[p]) || 0;
        if (!curSpecId) continue;
        const curRow = env.l10n.tableRow(TABLE_RSS_STATION, curSpecId);
        if (curRow && Number(curRow.effect_buff) === newEffect) {
          // 同类已占：更强才替换（同 PabBuffSelectItem `_replaceEnable = new.buff_para > old.buff_para`），否则不装
          return newPara > (Number(curRow.buff_para) || 0) ? p : 0;
        }
      }
    }
    for (let p = BUFF_SLOT_MIN; p <= BUFF_SLOT_MAX; p++) {
      if (!(Number(bm[p]) || 0)) return p;
    }
    return 0;
  }

  /**
   * dropId 是否在拉黑期内（顺带清过期项）。
   * @param {*} dropId 原值
   * @returns {boolean}
   */
  #blacked(dropId) {
    const k = idKey(dropId);
    if (!k) return false;
    const exp = this.#blacklist.get(k);
    if (exp == null) return false;
    if (Date.now() >= exp) {
      this.#blacklist.delete(k);
      return false;
    }
    return true;
  }

  /**
   * 该掉落条目是否已被**别人**占走（dropInfo / dropBeastInfo / bagInfo / buffInfo 四类通用）。
   * 实证：bagInfo 条目带 `uid`+`playerInfo` 即表示已被该玩家领取，游戏 UI 走 enigma_realm165「已被{0}拿走」；
   *   我们若不预先过滤，发包会撞 8527/8533 `s=3 d=enigma_realm161`「已经被其他指挥官拿走咯」（实测 17/57 条）。
   * @param {object} entry 掉落条目（uid 可能缺省 / 0 / Int64 字符串）
   * @param {string} me 我的 UID 字符串
   * @returns {boolean} true=已被他人领取，应跳过
   */
  #takenByOther(entry, me) {
    const u = entry ? entry.uid : null;
    if (u == null) return false;
    const s = String(u);
    if (!s || s === '0') return false;
    return !me || s !== me;
  }

  /**
   * 服务器真·拒绝（header.s≠0，非「未发出」）→ 6h 拉黑；未发出/超时（CODE_NOT_SENT）不拉黑，留下轮自然重试。
   * 日志带 header.d（经 Ret.reason 透传）的中文译文，区分「已被别人拿走」/「同道具只能拿1次」/「不是队长」等。
   * @param {*} dropId 原值
   * @param {object} ret sendSecret 结果
   */
  #blackOnReject(dropId, ret) {
    const code = ret && ret.code;
    if (code === CODE_NOT_SENT || code == null) return;
    const k = idKey(dropId);
    if (!k) return;
    this.#blacklist.set(k, Date.now() + tuning.rejectBlacklistMs);
    const key = ret.reason ? String(ret.reason) : '';
    let why = key;
    if (key) {
      try {
        const t = this.#env.l10n.text(key);
        if (t && t !== key) why = key + '(' + t + ')';
      } catch (e) {
        /* 译文取不到就只打键 */
      }
    }
    this.#env.log.info(
      'pickup rejected dropId=%s code=%s%s, blacklisted 6h.',
      k,
      code,
      why ? ' reason=' + why : '',
    );
  }
}
