/**
 * 物品自动拾取引擎（异能秘境：掉落箱 + 资源点 + 增益井，仅当前到达点）。
 * 协议载荷口径见 constants.js；逐条闸门的落点在 `#pickupDrop`/`#pickupRes` 行内注释，本头只写取数与判据。
 *
 * 触发模型（**五触发源，同一套闸门**）：
 *   ① CHANGE 推送（直连 `ctx.on.push`，载荷自带 x,y 与完整明细）：21532 掉落箱、21522 资源点。
 *   ② 资源点 8526 RESOURCE_INFO **应答**（**无 x,y**）：RESOURCE_GET 只需 {rId}、RESOURCE_GET_BUFF 只需 {rId,pos}。
 *   ③ 掉落箱 8532 DROP_INFO **req↔resp 配对**（req 拿 {x,y}、resp 拿明细）：应答不带坐标而 DROP_GET 必须要 {x,y,rId}，
 *     故坐标从**发包侧**补（游戏 INFO 请求就是 `{x:tileX,y:tileY}`）；8526 的 req 也是 `{x,y}`，两类都按点位记账。
 *   ④ 到点 21529（§9.3 自愈补拉）：队伍到 173 后游戏未必推 21522/发 8526（CHANGE 只在点位数据**真的变了**时广播，
 *     面板不开也不发 INFO）→ 本引擎自补一发 8526（等价竞品 `onPabTeamMarchArrive` 的 resource 分支）。
 *   ⑤ 瓦片 10018（§9.4 本队箱发现）：视口增量里出现「163 且 `m.teamId` 与本队一致且 `iNum>0`」且去重窗未过且**是本队
 *     所在点位** → 自补一发 8532（等价竞品 `onUpdateTileInfo`；10018 ≈3 条/秒，只判不 kick）。
 *   ②③ 不可省：CHANGE 只在**点位数据真的变了**时广播，安静时段整局可以一条都没有；游戏打开点位面板时必发 INFO，该应答
 *     **不 emit 任何全局事件**（只回调刷新组件）→ 仅靠 ① 会整局睡死。配对按应答事件的 `Event.reqTime` 取「ts <= reqTime
 *     中最大的一条」，取不到才退同 cmd 的 FIFO + TTL 近似；配不到坐标的应答整条丢弃、队列溢出整窗作废——错配的后果不是
 *     漏拾而是拿错点坐标发 8533，被拒还会把能拾的 dropId 拉黑 6h。只对触发的当前点位补发 GET；主动 INFO 仅限 ④⑤ 两处、
 *     且只打本队当前点位（自发包同样占 bus 的 net.req 通道，应答回到 ②③ 的配对管道被同一套闸门消费），遍历全图仍禁。
 *
 * 面板语义：拾取（掉落箱物品/宠物、资源点 bag）与增益井 buff 都默认生效、无总开关；细化走 pickItems 行式配置——每项一个
 *   「拾」checkbox + 一个目标持有量 T（0=跟随游戏 para1_v1），条目另有 shop 标志＝商店补货渠道、与本引擎无关。buff 协议与
 *   pos 语义都不同，不进 pickItems 清单、类勾选走 buffEffects；拍宠物另在 capture.js，与此解耦。
 *
 * 节拍：次通道 `NetMgrSimple.send` 有按 cmd 的 `MsgIdSettings.cdTime` 频控，命中即 `return !1`（不上线、不报错、无应答），
 *   而门面 `TMWatchNetMgr.sendPBV2` **没有 return** → 收不到那个 false，只能靠超时感知；故候选逐条**发出即继续**（流水线），
 *   条间按 #gapMs 自适应（撞未发出→翻倍退避，连续命中→回落）。按点位记账（#gotByTile）：8526 的 bagInfo 条目**不带 uid**
 *   （keys 仅 dropId/specId/likeUids）→ 游戏侧「我已领」判据（`specId==e && uid==me`）对 INFO 载荷恒为假；故按点位记三维：
 *   发出即记 dropId/specId（未上线则撤销留下轮），成功或撞 119 才记 itemId（同道具换 specId 也拿不到）；21522 推送里带 uid
 *   的「我已领」由 #absorbMine 补记。每条 GET 前复检点位（#tileGate）：marchState ∈ {ARRIVED,GATHERING}、载荷年龄 ≤
 *   tuning.staleMaxMs、未被 158 判死、坐标级**在位核对**（`roomBaseInfo.startPoint`：ARRIVED 时 sp==tp、MARCHING sp=旧点，
 *   游戏自己也用 `startPoint.x!==tileX` 判「已在该点」）→ 堵上 marchState 抓不到的「ARRIVED 但已换点」158 场景。目标优先
 *   （抢井语义）：候选先按面板**拖拽序**（cfg.pickRank）排、同序再按「面板显式登记过」优先，且同 itemId 只留一条——多人
 *   同抢时配额先用在用户排在最前的道具上。
 *
 * 池 key（**按道具 ID 聚合**）：`item:{itemId}` 涵盖掉落箱物品与资源点产出道具（rss_station 按点位分行、同一 item 对应多个
 *   specId，逐点位列行会出大片同名项；上限本就按 `getItemNumById(itemId)` 计）；`pet:{cfgId}` 不合并；`rss:{specId}` 仅兜底。
 *
 * 三类闸门口径（源码 PabRewardBoxNode / PabResLibraryNode / PabBuffEquipNode / PabBagItem）：
 *   掉落箱 DROP_GET 8533 `{x,y,rId=dropId}`：总量 `dataConfig(3021)`（`bagGetNum+beastGetNum` 达上限即停），宠物
 *   `dataConfig(3061)` 只做 on/off（忽略 max）；已领 = `info.itemId==itemId && uid==me`；**他人已占**（条目 `uid` 非空且
 *   非我）四类通用跳过——游戏 UI 同口径显示 enigma_realm165，不过滤就是拿无效条目去撞 161「已被其他指挥官拿走」；过游戏
 *   背包上限 `checkItemNumMax(itemId)`（type==171 且 para1_v1 有值才判）与 feat 侧 `pickItems['item:'+itemId].max`；
 *   **本尊已在保护中则不领**（`roomBagInfo.protectBeasts` 含掉落项 `info.id`，与 PabBagItem 的 `isProtecting =
 *   getBagPetIsPretecting(t.id)` 同一 id 空间、Int64 `.equals` 直比，符号收在 ACL `getProtectingPetIds()`，读不到就不拦）；
 *   **品质阈值** `tuning.dropPetQualityMin`（enigma_beast 行 `quality` 低于它就不占配额，读不到一律放行）。`dataConfig(3017)`
 *   只是游戏领取选择器的格子数，与 protectBeasts 无关，不当占位上限。
 *   资源 bag RESOURCE_GET 8527 `{rId=dropId}`（无 x,y）：上限 `dataConfig(3013).split('|')[0]`=itemMax；已领 =
 *   `specId==e && uid==me`；**同点位同道具只可 1 次**（119 判重维度是**道具**而非 specId，故把我已领条目按 `.item` 归集、
 *   同点位该道具的其它 specId 也跳过）；itemId 由 enigma_secret_realm_rss_station[specId].item 映射后共用同一行面板勾选。
 *   增益 buff RESOURCE_GET_BUFF 8538 `{rId,pos}`：上限 `dataConfig(3013)[1]`=buffMax、仅队长可装；pos 依
 *   PabBuffEquipNode.initNode/PabBuffSelectItem 走 `roomBaseInfo.buffMap[1..3]`——先找同 effect_buff 已占槽（新
 *   buff_para>旧才等价替换，否则跳过，**绝不回落空槽**以保证三类不重复），无同类已装才取首个空槽。
 *
 * 共同约束：rId=dropId 原值透传（Int64 不 Number 化，仅拉黑 key 用字符串）；被拒（header.s≠0 且非「未发出」）6h 拉黑该
 *   dropId 防逐拍重发刷屏，走 info 日志不打 warn，并把 header.d（拒绝原因 loc 键，经 net.js Ret.reason 透传）的译文打出。
 *   只读+发包红线：全程 sendSecret 发 GET，不碰游戏 Update/Delete、不改本地态。
 */
import { sleep } from '../../../core/util.js';
import {
  CMD_DROP_GET,
  CMD_DROP_INFO,
  CMD_RESOURCE_GET,
  CMD_RESOURCE_GET_BUFF,
  CMD_RESOURCE_INFO,
  CFG_DROP_ITEM_MAX,
  CFG_DROP_PET_MAX,
  CFG_RES_LIMITS,
  PUSH_DROP_CHANGE,
  PUSH_RESOURCE_CHANGE,
  PUSH_TILE_INFO,
  PUSH_TEAM_ARRIVE,
  PAB_DROP,
  PAB_RESOURCE,
  TABLE_RSS_STATION,
  TABLE_BEAST,
  BUFF_SLOT_MIN,
  BUFF_SLOT_MAX,
  CODE_NOT_SENT,
  REJ_SAME_ITEM_ONCE,
  REJ_NOT_ARRIVED,
  ITEM_BUY_CURRENCY,
  ITEM_REFRESH_CURRENCY,
  ITEM_SAUSAGE,
  ST_BOSS_DEAD_END,
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
 * pickItems 行查询：给定 cfg + 池 key → 返回 `{on:boolean, max:number}`（未登记的项视为默认：on=true / max=0=无上限）。
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
 * 池 key 的拾取优先级序（面板拖拽结果 cfg.pickRank）：数越小越先拾；未排过序回 Infinity（排在所有已排序项之后）。
 * 旧存档的 pickRank 是空对象 → 所有候选同为 Infinity，比较器退化到「登记项优先」的旧行为。
 * @param {object} cfg 面板配置（含 pickRank）
 * @param {string} key 池 key
 * @returns {number}
 */
function pickRank(cfg, key) {
  const r = cfg && cfg.pickRank;
  const v = r && r[key];
  return Number.isFinite(v) ? v : Infinity;
}

/**
 * 从 21522/21532 推送事件里取出**业务体**（等价于旧 EventCenter 事件载荷）。
 * 两道状态守卫缺一不可：`ev.status` 是报文顶层 s（net.js 已归一化，可能为 null），
 *   而 `header.s` 是游戏 Handler 自己判的那一层——verbatim `if (o && o.header.s === 0) EVENT.emit(...)`，
 *   非 0 时游戏根本不发事件，我们也不能补发拍。
 * PBV2 通道的 `ev.data` 是 `{header,data}` 包装（业务体在内层）；JSON 通道是平铺的，故内层缺失时回落到外层。
 * @param {object} ev `net.<cmd>` 事件（Event 实例：{cmd,status,data,raw}）
 * @returns {object|null} 业务体；非成功包/形态异常回 null
 */
function changeBody(ev) {
  if (!ev) return null;
  const outer = ev.data;
  if (!outer) return null;
  if (ev.status != null && Number(ev.status) !== 0) return null;
  if (outer.header && Number(outer.header.s) !== 0) return null;
  return outer.data || outer;
}

/**
 * 点位明细快照：只复制本引擎实际读到的字段（dropId/specId/uid 与几个标量），脱离池化报文的复用生命周期。
 * 必要性：`Event.data` 直接包的是 `pbAckV2` 引用，而载荷要被 #pending 持到一个去抖窗口之后才消费。
 * @param {object} inner 8526 应答 / 21522 推送的点位载荷 {x?,y?,bagInfo?,buffInfo?,bagGetNum?,buffGetNum?}
 * @param {number} [x] 从 8526 **请求侧**配对来的横号（推送自带 x,y 时不传）
 * @param {number} [y] 同上横纵号
 * @returns {object} 稳定副本（可跨拍持有）
 */
function snapshotRes(inner, x, y) {
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
    x: x != null ? x : inner.x,
    y: y != null ? y : inner.y,
    bagInfo: pick(inner.bagInfo),
    buffInfo: pick(inner.buffInfo),
    bagGetNum: inner.bagGetNum,
    buffGetNum: inner.buffGetNum,
  };
}

/**
 * 掉落箱明细快照：把 8532 DROP_INFO 的应答凑成与 21532 推送同形的载荷（应答的数组键名是 `info`，推送用 `dropInfo`），
 * 并补上从**发包侧**配对来的 x,y。同样必须就地快照（应答对象是池化引用，要跨去抖窗口才消费）；
 * 下游只读 dropId / info.itemId / info.cfgId / info.id / uid，故只复制这几个字段（`info` 取浅拷贝，不持池化子对象引用；
 *   `info.id` 是 protobuf Int64，**在快照时就归成字符串**，既不留池化引用、又与 ACL 那侧的 `toString()` 同形）。
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
      // id 就地转串：两条数据源（21532 透传的对象 / 本快照的串）到下游都经 idKey 归一，比对不会因形态而失配
      out.push({
        dropId: b.dropId,
        uid: b.uid,
        info: { itemId: info.itemId, cfgId: info.cfgId, id: idKey(info.id) },
      });
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
  /** @type {{reward:{e:object,ts:number}|null, res:{e:object,ts:number}|null}} 去抖窗口内缓存的最新两类刷新载荷（带入窗时刻，供时效复检） */
  #pending = { reward: null, res: null };
  /** @type {number|null} 去抖定时器句柄 */
  #timer = null;
  /** @type {boolean} 单飞闸门：一批 GET 在飞时不并发第二批 */
  #running = false;
  /**
   * @type {{reward:{x:number,y:number,ts:number}[], res:{x:number,y:number,ts:number}[]}}
   * 两类 INFO 的**请求坐标**队列（按 reqTime 精确命中后 splice 摘除）。
   * 存这个队列是因为 8532/8526 应答都不带 x,y：DROP_GET 必须要 x,y，而 RESOURCE_GET 虽只要 rId，
   *   但本 feat 的「按点位记账 + 点位判死」需要一个稳定的点位键，只能从发包侧拿坐标。
   */
  #posQ = { reward: [], res: [] };
  /**
   * @type {Map<string,{drop:Set<string>,spec:Set<string>,item:Set<number>}>}
   * 本会话按点位（`x,y`）的**已发/已得账**：Map 保持插入序，超 tuning.tileAccMax 丢最早一个点位。
   * 存在理由见文件头「节拍与判重」：INFO 载荷不带 uid → 游戏侧已领判据失效 → 必须由本 feat 自己记账。
   */
  #gotByTile = new Map();
  /** @type {Map<string, number>} 撞过 158（小队尚未抵达目标点）的点位键 → 失效到期时刻（过期后可重试，免得回来时永久拒发） */
  #tileDead = new Map();
  /**
   * @type {number} 流水线相邻两条 GET 的当前节拍（毫秒），初值 tuning.getGapMs。
   * 撞「未真正发出」（被次通道 cdTime 频控拦下）→ 翻倍退避；连续命中 → 按 tuning.getGapStepMs 回落。
   */
  #gapMs = tuning.getGapMs;
  /**
   * @type {Map<string,number>} §9.3/§9.4 **主动补拉去重窗**（竞品 `drop_list` 等价物）：键 `r@x,y`/`d@x,y` → 静默到期（毫秒）。
   * 发前置记 now+tuning.selfFetchTtlMs；8532 应答带箱 `endTime`（Int64，毫秒）时覆盖为按箱到期静默（竞品 L25232 同维）。
   */
  #selfFetch = new Map();
  /** @type {number|null} 21529 到点补拉的延迟定时器（等 21521 先行落账后复核 startPoint，与 pilot「不信事件时序」同口径） */
  #arriveTimer = null;

  /** @param {object} env 注入底座 {alive, realmActive, cfg, secret, gameConf, gameData, l10n, log} */
  constructor(env) {
    this.#env = env;
  }

  /**
   * 启动：登记两条 CHANGE 推送订阅（21522/21532） + 两类 INFO 的应答订阅 + 两类 INFO 的请求坐标订阅（退订均由 reactor 托管）。
   * @param {object} ctx reactor 上下文（提供 on.push / on.resp / on.req）
   */
  start(ctx) {
    const self = this;
    ctx.on.push(PUSH_DROP_CHANGE, function (ev) {
      const body = changeBody(ev);
      if (body) self.#onEvent('reward', body);
    });
    ctx.on.push(PUSH_RESOURCE_CHANGE, function (ev) {
      const body = changeBody(ev);
      if (body) self.onEventRes(body);
    });
    // 触发源②：到点后玩家（或游戏自动）打开资源点面板时游戏自己发的 INFO 应答——CHANGE 推送缺位时唯一的唤醒源
    ctx.on.req(CMD_RESOURCE_INFO, function (ev) {
      self.#onInfoReq('res', ev);
    });
    ctx.on.resp(CMD_RESOURCE_INFO, function (ev) {
      self.onResourceInfoResp(ev);
    });
    // 触发源③：掉落箱 INFO 的请求带 {x,y}、应答带明细但不带坐标，两条凑齐才能发 DROP_GET
    ctx.on.req(CMD_DROP_INFO, function (ev) {
      self.#onInfoReq('reward', ev);
    });
    ctx.on.resp(CMD_DROP_INFO, function (ev) {
      self.#onDropInfoResp(ev);
    });
    // 触发源④（§9.3）：到 173 自补一发 8526（push 缺位时唯一的到点唤醒）
    ctx.on.push(PUSH_TEAM_ARRIVE, function () {
      self.#onTeamArrive();
    });
    // 触发源⑤（§9.4）：10018 视口增量里本队 163 箱 → 当前点位且未过期去重才补一发 8532（≈3 条/秒，只判不 kick）
    ctx.on.push(PUSH_TILE_INFO, function (ev) {
      self.#onTilePush(ev);
    });
    this.#env.log.info(
      'pickup engine started (CHANGE events + 8526/8532 req↔resp pair + §9.3 arrive/§9.4 tile self-fetch, current-tile only, pipelined GETs).',
    );
  }

  /** 资源点事件入口（保留公开名便于调试面手动触发；语义同 #onEvent）。 */
  onEventRes(e) {
    this.#onEvent('res', e);
  }

  /**
   * 8526 RESOURCE_INFO 应答入口：只在 `status===0` 且载荷确实带 bagInfo/buffInfo 时消费，
   * 并**就地快照**（应答对象是池化引用，不能交给去抖窗口之后的 #flush 再读）。
   * 坐标从请求侧配对（verbatim：PabResLibraryNode.requestData 发的是 `{x:tileX,y:tileY}`）；
   *   **配不到不丢弃**（与掉落箱不同）：RESOURCE_GET 只要 {rId}，丢了坐标只意味着该条不进点位账，不该拿掉唤醒能力。
   * @param {object} ev bus `net.resp.<cmd>` 事件（Event 实例：{cmd,status,data,reqTime,raw}）
   */
  onResourceInfoResp(ev) {
    if (!ev || (ev.status != null && Number(ev.status) !== 0)) return;
    const outer = ev.data || {};
    const inner = outer.data || outer;
    if (!Array.isArray(inner.bagInfo) && !Array.isArray(inner.buffInfo)) return;
    const c = this.#posMatch('res', ev);
    if (!c) this.#env.log.debug('8526 resp has no paired {x,y}; tile accounting skipped.');
    this.#onEvent('res', snapshotRes(inner, c && c.x, c && c.y));
  }

  /**
   * INFO 的**发包**入口（两类共用）：只做一件事——把这次请求的 {x,y} 入对应队列（应答里没有坐标）。
   * 载荷 data 是游戏面板就地构造的字面量（`{x:this._tileInfo.tileX,y:this._tileInfo.tileY}`），取数即走，不持引用。
   * @param {'reward'|'res'} kind 点位类别
   * @param {object} ev bus `net.req.<cmd>` 载荷 {cmd,key,data,ts}
   */
  #onInfoReq(kind, ev) {
    const d = (ev && ev.data) || {};
    const x = Number(d.x);
    const y = Number(d.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return; // 不带坐标的包不是我们要配的那族
    const q = this.#posQ[kind];
    q.push({ x: x, y: y, ts: Number(ev && ev.ts) || Date.now() });
    // 面板连点会积压：一过上限就整窗作废（此时顺序已不可信，留着半队坐标去猜就是把错点写进 GET）
    if (q.length > tuning.dropPairQueueMax) {
      const n = q.length;
      this.#posQ[kind] = [];
      this.#env.log.debug('%s req queue overflow (%d pending), pairing window discarded.', kind, n);
    }
  }

  /**
   * 从坐标队列里为本条应答定位那次发包的 {x,y}（命中即 splice 摘除，一条坐标只能配一次）。
   * 主档：reqTime 就是「本条应答那次发包」的时刻，取 ts <= reqTime 中最大的一条即该次发包本身
   *   （req 侧 ts 打在 orig.apply 之前、reqTime 打在游戏内部，恒有 reqTime >= ts，所以是单侧界而非区间）；
   * 兜底档（游戏改版取不到 reqTime）：同队列先进先出 + TTL。配不到回 null。
   * @param {'reward'|'res'} kind 点位类别
   * @param {object} ev bus `net.resp.<cmd>` 事件
   * @returns {{x:number,y:number}|null}
   */
  #posMatch(kind, ev) {
    const q = this.#posQ[kind];
    const rt = typeof ev.reqTime === 'number' ? ev.reqTime : 0;
    if (rt) {
      let hit = -1;
      for (let i = 0; i < q.length; i++) {
        if (q[i].ts > rt) continue;
        if (hit < 0 || q[i].ts > q[hit].ts) hit = i;
      }
      if (hit < 0) return null;
      return q.splice(hit, 1)[0];
    }
    const now = Date.now();
    for (let i = 0; i < q.length; i++) {
      if (now - q[i].ts <= tuning.dropPairTtlMs) return q.splice(i, 1)[0];
    }
    return null;
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
    const c = this.#posMatch('reward', ev);
    if (!c) {
      env.log.debug(
        ev.reqTime
          ? 'drop info resp has no 8532 req at or before its reqTime, ignored.'
          : 'drop info resp unmatched (no pending {x,y} from 8532 req), ignored.',
      );
      return;
    }
    // §9.4 drop_list 记账：应答带箱到期 `endTime`（Int64，毫秒）时把补拉静默窗改按箱到期（竞品 `t.endTime > ServerTime` 同维），
    //   取不到/已过期才留在 selfFetchTtlMs 兑底窗内（窗满可重拉，箱内容变化另有 21532 push 补位）。
    const et = inner.endTime != null ? Number(idKey(inner.endTime)) : NaN;
    if (Number.isFinite(et) && et > Date.now()) this.#selfFetch.set('d@' + c.x + ',' + c.y, et);
    this.#onEvent('reward', snapshotReward(inner, c.x, c.y));
  }

  /**
   * teamId 全精度比对（§9.4 归属闸，A1 避坑口径）：先 idKey 字符串口径（Int64 `.toString()` / 数字串同路），
   *   不等再退 double 比对——一侧是被抹零的 number 时，`Number(全精度串)` 与抹零 double 相等，同源比较仍成立。
   * @param {string} myKey 我的 roomBaseInfo.teamId 字符串形态（调用方 idKey 化好）
   * @param {*} other 10018 瓦片的 m.teamId
   * @returns {boolean}
   */
  #sameTeam(myKey, other) {
    if (!myKey) return false;
    const s = idKey(other);
    if (!s) return false;
    if (s === myKey) return true;
    const a = Number(myKey);
    const b = Number(s);
    return Number.isFinite(a) && a === b;
  }

  /**
   * §9.4：10018 瓦片刷新 → 发现本队的掉落箱。竞品 `onUpdateTileInfo`（L25231）判据照搬：
   *   `pointType==PAB_DROP && roomBaseInfo.teamId==m.teamId && m.iNum>0 && drop_list 未记该点未过期` → 主动 8532 拉箱。
   * 两处我方化的收窄（与竞品的有意差异，§9.4 已录）：
   *   ① 只拉「队伍当前所在点位」（#tileGate 在位核对）：竞品把远箱缓存进 mooring.drop 到点再拾，而我方 #pending
   *      是**单槽后到优先**，远点应答会顶掉当前点位刚推的 21532 载荷；且远点 GET 反正被 #tileGate 拦，拉了白刷带宽。
   *   ② 归属双闸用 teamId 全精度串比对（#sameTeam）；读不到 teamId 就一个不拉（红线：只拉本队的箱）。
   * 不 kick、不遍历；10018 载荷是平的（ev.data 直接 {pointInfos[]}，与 boss.js 同口径）。
   * @param {object} ev bus `net.10018` 事件
   */
  #onTilePush(ev) {
    const env = this.#env;
    if (!env.alive() || !env.realmActive()) return;
    const d = ev && ev.data;
    const list = d && Array.isArray(d.pointInfos) ? d.pointInfos : null;
    if (!list || !list.length) return;
    const pab = env.secret.getPabController();
    const base = pab && pab.roomBaseInfo;
    const myTeam = base && base.teamId != null ? idKey(base.teamId) : '';
    if (!myTeam) return;
    const now = Date.now();
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (!p || (Number(p.pointType) || 0) !== PAB_DROP) continue;
      const m =
        (p.m && typeof p.m === 'object' ? p.m : null) ||
        (p.extData && typeof p.extData === 'object' ? p.extData : null) ||
        null;
      if (!m || !this.#sameTeam(myTeam, m.teamId)) continue; // 归属闸：别人的箱不拉
      if (!(Number(m.iNum) > 0)) continue; // 没货不拉
      const x = Math.floor(Number(p.x));
      const y = Math.floor(Number(p.y));
      if (!(x > 0) || !(y > 0)) continue;
      const key = x + ',' + y;
      const exp = this.#selfFetch.get('d@' + key);
      if (exp != null && now < exp) continue; // drop_list 去重：箱未过期/静默窗未过不再拉
      if (!this.#tileGate(key, 0)) continue; // 只拉当前点位（收窄①）
      this.#selfFetch.set('d@' + key, now + (Number(tuning.selfFetchTtlMs) || 0)); // 先记后动：应答丢失也不在窗内重发
      env.secret.sendSecret(CMD_DROP_INFO, { x: x, y: y });
      env.log.debug(
        'pickup §9.4: own-team drop tile (%d,%d) iNum=%d → proactive 8532 fetch.',
        x,
        y,
        Number(m.iNum),
      );
    }
  }

  /**
   * §9.3：21529 到点 → 若停在 173 自补一发 8526（等价竞品 `onPabTeamMarchArrive` 的 resource 分支）。
   * 存在理由：21522 push 只在点位数据**真的变了**时广播，到点后服务器无变化、面板不开就既不推也不 INFO →
   *   被动闸的拾取会睡满整个驻留窗。补拉的应答走既有 8526 req↔resp 配对（自发包同样上线 bus 的 net.req 通道），零新协议。
   * 21529 与 21521 无时序保证：延迟一个去抖窗后再读 roomBaseInfo 复核在位（pilot「不信事件时序」同口径）。
   * 竞品到点还记 cd_time.march（驻留时长）——那是方向盘的职责（§9.1 已收进 pilot 单时钟 #cd），pickup 不越权。
   */
  #onTeamArrive() {
    const self = this;
    const env = this.#env;
    if (!env.alive() || !env.realmActive()) return;
    if (this.#arriveTimer != null) return; // 连续到点事件只排一次复核
    this.#arriveTimer = setTimeout(function () {
      self.#arriveTimer = null;
      self.#fetchResOnArrive();
    }, tuning.pickupDebounceMs);
  }

  /**
   * 到点补拉的实际动作（#onTeamArrive 延迟窗后）：仍在 173 且在位 → 发 8526；每点静默窗防 21529 连触重发。
   */
  #fetchResOnArrive() {
    const env = this.#env;
    if (!env.alive() || !env.realmActive()) return;
    const pab = env.secret.getPabController();
    const base = pab && pab.roomBaseInfo;
    if (!base || (Number(base.pointType) || 0) !== PAB_RESOURCE) return;
    const pt = base.startPoint || base.targetPoint;
    const x = Math.floor(Number(pt && pt.x));
    const y = Math.floor(Number(pt && pt.y));
    if (!(x > 0) || !(y > 0)) return;
    const key = x + ',' + y;
    if (!this.#tileGate(key, 0)) return;
    const sk = 'r@' + key;
    const now = Date.now();
    const exp = this.#selfFetch.get(sk);
    if (exp != null && now < exp) return;
    this.#selfFetch.set(sk, now + (Number(tuning.selfFetchTtlMs) || 0));
    env.secret.sendSecret(CMD_RESOURCE_INFO, { x: x, y: y });
    env.log.debug('pickup §9.3: arrived resource (%d,%d) → self 8526 fetch.', x, y);
  }

  /** 停止：撤去抖/到点补拉定时器与配对队列（事件退订由 reactor 统一摘除；在飞请求自然 settle）。 */
  stop() {
    if (this.#timer != null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    if (this.#arriveTimer != null) {
      clearTimeout(this.#arriveTimer);
      this.#arriveTimer = null;
    }
    this.#pending = { reward: null, res: null };
    this.#posQ = { reward: [], res: [] };
    this.#selfFetch = new Map();
  }

  /**
   * 事件总入口：门控通过后先吸收载荷里「uid==我」的条目进点位账，再缓存最新载荷并按去抖窗口安排一次消费。
   * 门控不过去时打一行 debug（区分 feat 未激活 / 不在秘境地图），免得下次只能靠「一个包都没发」倒推。
   * @param {'reward'|'res'} kind 点位类别
   * @param {object} e 点位业务体（21522/21532 推送的 `ev.data.data`，或 INFO 应答快照）
   */
  #onEvent(kind, e) {
    const env = this.#env;
    if (!e) return;
    if (!env.alive() || !env.realmActive()) {
      env.log.debug(
        'pickup wake ignored by gate: alive=%s realmActive=%s kind=%s.',
        env.alive(),
        env.realmActive(),
        kind,
      );
      return;
    }
    this.#absorbMine(kind, e);
    this.#pending[kind] = { e: e, ts: Date.now() };
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
    if (!env.alive() || !env.realmActive()) {
      this.#pending = { reward: null, res: null };
      return;
    }
    const p = this.#pending;
    this.#pending = { reward: null, res: null };
    this.#running = true;
    const self = this;
    const step = async function () {
      if (p.reward) await self.#pickupReward(p.reward.e, p.reward.ts);
      if (p.res) await self.#pickupRes(p.res.e, p.res.ts);
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
   * 掉落箱拾取：先把 dropInfo（物品）/dropBeastInfo（宠物）过闸门凑成候选，再走流水线发 DROP_GET。
   * 物品与宠物共享 bagGetNum+beastGetNum 总量闸门；per-item 由 cfg.pickItems 独立勾选与背包数量上限。
   * @param {object} e {x,y,dropInfo[],dropBeastInfo[],bagGetNum,beastGetNum}
   * @param {number} ts 该载荷入 #pending 的时刻（时效闸门用）
   * @returns {Promise<void>}
   */
  async #pickupReward(e, ts) {
    const env = this.#env;
    const cfg = env.cfg();
    const x = e.x;
    const y = e.y;
    const dropInfo = Array.isArray(e.dropInfo) ? e.dropInfo : [];
    const dropBeastInfo = Array.isArray(e.dropBeastInfo) ? e.dropBeastInfo : [];
    const me = env.gameData.myUidStr();
    const pab = env.secret.getPabController();
    const itemGetMax = Number(env.gameConf.dataConfig(CFG_DROP_ITEM_MAX)) || 0;
    const petMax = Number(env.gameConf.dataConfig(CFG_DROP_PET_MAX)) || 0;
    let gotCount = (Number(e.bagGetNum) || 0) + (Number(e.beastGetNum) || 0);
    const tileKey = this.#tileKey(e);

    // A. 掉落物品（先整批过闸门凑候选，再流水线发；配额不够就只造那么多）
    const cands = [];
    for (let i = 0; i < dropInfo.length; i++) {
      const it = dropInfo[i];
      if (!it || it.dropId == null) continue;
      const itemId = Number(it.info && it.info.itemId) || 0;
      if (!itemId) continue;
      const key = 'item:' + itemId;
      const row = pickRow(cfg, key);
      if (!row.on) continue; // 用户关闭该物品
      if (!this.#farmWorthy(itemId)) continue; // §9.2：货币配额已够，不再浪费拾取位（竞品 ids 过滤的 farm 侧消费）
      if (this.#blacked(it.dropId)) continue;
      if (this.#itemIdGeted(itemId, dropInfo, me)) continue; // 同点位同 itemId 已被我领（推送侧带 uid 才能判出）
      if (this.#takenByOther(it, me)) continue; // 已被队友领走（d=enigma_realm161）
      if (this.#gotLocal(tileKey, it.dropId, null, itemId)) continue; // 本 feat 已按点位发过/已得（INFO 无 uid 时的唯一判据）
      if (pab && this.#itemNumMax(pab, itemId)) continue; // 游戏 para1_v1
      if (row.max > 0 && pab && this.#roomBagNum(pab, itemId) >= row.max) continue; // feat 侧 per-item 背包上限
      cands.push({
        cmd: CMD_DROP_GET,
        req: { x: x, y: y, rId: it.dropId },
        tileKey: tileKey,
        dropId: it.dropId,
        specId: null,
        itemId: itemId,
        key: key,
        want: this.#isWanted(cfg, key),
      });
    }
    // 同 itemId 只留一条（掉落箱里同名道具多行时不占两份配额），再按面板拖拽序定先后（抢井语义）
    const tasks = this.#dedupPriority(
      cands,
      itemGetMax > 0 ? Math.max(0, itemGetMax - gotCount) : cands.length,
      cfg,
    );
    gotCount += await this.#pipe(tasks, ts);

    // B. 掉落宠物（仅 on/off；checkPetIdGeted 语义：dropBeastInfo 已含我 uid 的一条即视为满）
    const petMine = dropBeastInfo.some(function (o) {
      return o && String(o.uid) === me;
    });
    // 已在保护中的宠物 id 集（游戏 getBagPetIsPretecting 同一数据源：roomBagInfo.protectBeasts，ACL 已归成字符串）
    const protecting = env.secret.getProtectingPetIds();
    const qMin = Number(tuning.dropPetQualityMin) || 0;
    if ((petMine ? 1 : 0) < petMax) {
      const petCands = [];
      for (let j = 0; j < dropBeastInfo.length; j++) {
        const pet = dropBeastInfo[j];
        if (!pet || pet.dropId == null) continue;
        if (String(pet.uid) === me) continue;
        if (this.#takenByOther(pet, me)) continue; // 已被队友领走（d=enigma_realm161）
        if (this.#gotLocal(tileKey, pet.dropId, null, 0)) continue;
        const cfgId = Number(pet.info && pet.info.cfgId);
        // 本尊已在保护中（info.id 是 Int64，走 idKey 不拆数字）：再发一发 DROP_GET 只会撞服务器「已有该宠」类拒绝
        const pid = idKey(pet.info && pet.info.id);
        if (pid && protecting.indexOf(pid) >= 0) {
          env.log.debug(
            'pickup: pet dropId %s (cfg %d) already protecting, skip.',
            pet.dropId,
            cfgId,
          );
          continue;
        }
        if (cfgId && qMin > 0 && !this.#petQualityEnough(cfgId, qMin)) continue; // 低品质不占配额
        if (cfgId) {
          const row = pickRow(cfg, 'pet:' + cfgId);
          if (!row.on) continue;
        }
        if (this.#blacked(pet.dropId)) continue;
        petCands.push({
          cmd: CMD_DROP_GET,
          req: { x: x, y: y, rId: pet.dropId },
          tileKey: tileKey,
          dropId: pet.dropId,
          specId: null,
          itemId: 0, // 宠物不按道具维度记账（面板上是 cfgId）
          key: cfgId ? 'pet:' + cfgId : '',
          want: cfgId ? this.#isWanted(cfg, 'pet:' + cfgId) : true,
        });
      }
      // 先按优先级定序再夹配额：反过来会先砍掉尾部、把用户排在后面的项当成「配额不够」丢弃
      const petRoom = itemGetMax > 0 ? Math.max(0, itemGetMax - gotCount) : petCands.length;
      const petTasks = petCands.sort(this.#byPriority(cfg)).slice(0, petRoom);
      await this.#pipe(petTasks, ts);
    }
  }

  /**
   * 掉落宠物的品质是否达阈（enigma_beast 行的 `quality`，阈值收在 `tuning.dropPetQualityMin`）。
   * **fail-open**：读不到行、行无该字段、值非有限数 → 一律放行（阈值只用于「已知是低品质」时省配额，
   *   不能因为配置表改名把全部宠物锁死）。
   * @param {number} cfgId 物种 cfgId
   * @param {number} min 最低品质
   * @returns {boolean}
   */
  #petQualityEnough(cfgId, min) {
    const row = this.#env.l10n.tableRow(TABLE_BEAST, cfgId);
    const q = row ? Number(row.quality) : NaN;
    if (!Number.isFinite(q)) return true;
    return q >= min;
  }

  /**
   * 资源 bag 与增益井 buff 拾取：bagInfo 先整批过闸门凑候选再流水线发 RESOURCE_GET（仅 rId），
   * buffInfo 依 buffMap 首个空槽位（或同 effect_buff 替换）发 RESOURCE_GET_BUFF。
   * @param {object} e {x,y,bagInfo[],buffInfo[],bagGetNum,buffGetNum,refreshTime}
   * @param {number} ts 该载荷入 #pending 的时刻（时效闸门用）
   * @returns {Promise<void>}
   */
  async #pickupRes(e, ts) {
    const env = this.#env;
    const cfg = env.cfg();
    const bagInfo = Array.isArray(e.bagInfo) ? e.bagInfo : [];
    const buffInfo = Array.isArray(e.buffInfo) ? e.buffInfo : [];
    const me = env.gameData.myUidStr();
    const pab = env.secret.getPabController();
    const limits = String(env.gameConf.dataConfig(CFG_RES_LIMITS) || '').split('|');
    const itemMax = Number(limits[0]) || 0;
    const buffMax = Number(limits[1]) || 0;
    const tileKey = this.#tileKey(e);

    // C. 资源 bag（RESOURCE_GET req 仅 {rId}）
    // 本点位内我已领过的**道具**集合：同道具只能拿 1 次（8527 s=3 d=enigma_realm119
    // 「同一资源点内相同道具只能获取1次」），判重维度是 item 而不是 specId（同点位可多行产出同一 item）。
    // 推送（21522）带 uid 能直接判出；INFO 不带 uid，靠 #gotByTile 本 feat 自己的账补上这一刀。
    /** @type {Set<number>} */
    const mineItems = new Set();
    for (let i = 0; i < bagInfo.length; i++) {
      const b = bagInfo[i];
      if (!b || !me || String(b.uid) !== me) continue;
      const id = this.#stationItem(b.specId);
      if (id) mineItems.add(id);
    }
    const gotBag = Number(e.bagGetNum) || 0;
    const cands = [];
    for (let i = 0; i < bagInfo.length; i++) {
      const it = bagInfo[i];
      if (!it || it.dropId == null) continue;
      if (this.#blacked(it.dropId)) continue;
      if (this.#specGeted(it.specId, bagInfo, me)) continue;
      if (this.#takenByOther(it, me)) continue; // 已被队友领走（d=enigma_realm161）
      const itemId = this.#stationItem(it.specId);
      if (itemId && mineItems.has(itemId)) continue; // 同点位该道具已拿过（换个 specId 也拿不到）
      // 勾选与上限都按道具维度（面板清单已按 itemId 聚合）；映射不到道具时退回 specId 键
      const key = itemId ? 'item:' + itemId : 'rss:' + it.specId;
      const row = pickRow(cfg, key);
      if (!row.on) continue;
      if (itemId && !this.#farmWorthy(itemId)) continue; // §9.2：货币配额已够不再采（竞品 getResItem 的 `for(h=this.ids)` 同义）
      if (this.#gotLocal(tileKey, it.dropId, it.specId, itemId)) continue; // 本 feat 已按点位发过/已得
      if (itemId && pab) {
        if (this.#itemNumMax(pab, itemId)) continue;
        if (row.max > 0 && this.#roomBagNum(pab, itemId) >= row.max) continue;
      }
      cands.push({
        cmd: CMD_RESOURCE_GET,
        req: { rId: it.dropId },
        tileKey: tileKey,
        dropId: it.dropId,
        specId: it.specId,
        itemId: itemId,
        key: key,
        want: itemId ? this.#isWanted(cfg, key) : true,
      });
    }
    // 同 itemId 只留一条 + 按面板拖拽序定先后；配额 = itemMax - 本点位已领
    const tasks = this.#dedupPriority(
      cands,
      itemMax > 0 ? Math.max(0, itemMax - gotBag) : cands.length,
      cfg,
    );
    await this.#pipe(tasks, ts);

    // D. 增益井 buff（buffEffects 类勾选；RESOURCE_GET_BUFF req {rId,pos}；仅队长可装；pos 依 buffMap 同类替换或首个空槽）
    if (pab && buffInfo.length && this.#tileGate(tileKey, ts)) {
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
          env.log.warn('buff pickup skipped (isTeamLeader threw).', err);
        }
      }
    }
  }

  /**
   * 点位键（`x,y`）；坐标取不到（推送/应答都无 x,y 且配对失败）回 '' = 不进点位账、不做点位判死。
   * @param {object} e 点位载荷
   * @returns {string}
   */
  #tileKey(e) {
    const x = Number(e && e.x);
    const y = Number(e && e.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return '';
    return x + ',' + y;
  }

  /**
   * 取/建一个点位的已发已得账（三维度：dropId / specId / itemId）。点位数超 tuning.tileAccMax 按插入序丢最早一个。
   * @param {string} key 点位键
   * @returns {{drop:Set<string>, spec:Set<string>, item:Set<number>}}
   */
  #acc(key) {
    let a = this.#gotByTile.get(key);
    if (!a) {
      a = { drop: new Set(), spec: new Set(), item: new Set() };
      this.#gotByTile.set(key, a);
      while (this.#gotByTile.size > tuning.tileAccMax) {
        const oldest = this.#gotByTile.keys().next().value;
        this.#gotByTile.delete(oldest);
        this.#tileDead.delete(oldest);
      }
    }
    return a;
  }

  /**
   * rss_station[specId] → 产出道具 id（映射不到回 0）。源码口径 PabBagItem.updateResourceItem。
   * @param {number|string} specId 资源 specId
   * @returns {number}
   */
  #stationItem(specId) {
    if (specId == null) return 0;
    const st = this.#env.l10n.tableRow(TABLE_RSS_STATION, specId);
    return st ? Number(st.item) || 0 : 0;
  }

  /**
   * §9.2 farm 侧三约束（竞品 `get ids()` L24220-24228，消费在 getResItem/getDropBox 的选品循环，**不是** shopConver）：
   *   把「够买就别再刷/采」的货币从拾取候选里动态剔除（基础式的「目标数>已有 && !checkItemNumMax」我方已由
   *   pickRow/row.max + #itemNumMax/#roomBagNum 覆盖，本函数只补三条动态约束）：
   *   约束1（41009 晶块）：`crystal > base − sausage*perSausage − (买过百兽箱?boxReserve:0)` → 停采晶块；
   *   约束2（41010 刷新币）：`refresh + sausage >= driveSausageTarget` → 停采（商店不再需要刷新）；
   *   约束3（41010 刷新币）：`bossBaseInfo[0].state==30`（清台）→ 停采（竞品原文取 [0]，不扩 find）。
   * 公式底数一律走 tuning.shopReserve* 键（竞品内联字面量 12000/500/3000，本仓禁内联）；键缺失/非法 → 该约束失效。
   * 其余 itemId 不受三约束管辖直接回 true；取数失败/读不到一律 fail-open（多采无害于少采，
   *   误把晶块/刷新币锁死出拾取池的代价远大于多拾一枚货币）。
   * @param {number} itemId 拾取候选道具
   * @returns {boolean} true=仍值得采
   */
  #farmWorthy(itemId) {
    const env = this.#env;
    if (itemId !== ITEM_BUY_CURRENCY && itemId !== ITEM_REFRESH_CURRENCY) return true;
    const pab = env.secret.getPabController();
    if (!pab) return true;
    // 取数失败/非数值 → NaN，下面统一按「读不到」fail-open
    const num = function (id) {
      try {
        return Number(pab.getItemNumById(id));
      } catch (e) {
        return NaN;
      }
    };
    const crystal = num(ITEM_BUY_CURRENCY);
    const refresh = num(ITEM_REFRESH_CURRENCY);
    const sausage = num(ITEM_SAUSAGE);
    if (!Number.isFinite(crystal) || !Number.isFinite(refresh) || !Number.isFinite(sausage))
      return true;
    if (itemId === ITEM_BUY_CURRENCY) {
      const base = Number(tuning.shopReserveBaseCrystal);
      if (!Number.isFinite(base) || base <= 0) return true;
      const per = Number(tuning.shopReserveCrystalPerSausage) || 0;
      const boxReserve = Number(tuning.shopReserveCrystalBeastBox) || 0;
      // 百兽箱位经 env.shopBoxBought 惰性读 pilot 账（读不到按未买：不扣预留 → 更不易停采，保守同竞品 shops 空集）
      const boxBought = typeof env.shopBoxBought === 'function' ? !!env.shopBoxBought() : false;
      const reserve = base - sausage * per - (boxBought ? boxReserve : 0);
      return !(crystal > reserve);
    }
    const sausageTarget = Number(tuning.driveSausageTarget) || 0;
    if (sausageTarget > 0 && refresh + sausage >= sausageTarget) return false;
    try {
      const list = env.secret.getBossBaseInfo();
      if (Array.isArray(list) && list[0] && Number(list[0].state) === ST_BOSS_DEAD_END)
        return false;
    } catch (e) {
      /* 读不到 BOSS 清单 = 不构成清台，不剔 */
    }
    return true;
  }

  /**
   * 该池 key 是否被用户在面板**显式登记过**（pickItems 里有行）——拖拽序之后的次级排序依据（见 #byPriority）。
   * 未登记不等于不要（pickRow 默认 on=true），只是排在登记项之后。
   * @param {object} cfg 面板配置
   * @param {string} key 池 key
   * @returns {boolean}
   */
  #isWanted(cfg, key) {
    const m = cfg && cfg.pickItems;
    return !!(m && m[key]);
  }

  /**
   * 拾取优先级比较器：面板拖拽序（pickRank，数小者靠前）为主序，同序/同为未排序时退回「面板登记项优先」。
   * Array#sort 稳定（Chrome 110 保证），rank 与 want 都相同的候选保持服务器给的原始顺序。
   * @param {object} cfg 面板配置（含 pickRank/pickItems）
   * @returns {(a:object, b:object) => number} 比较器，作用于带 `key`/`want` 的候选
   */
  #byPriority(cfg) {
    return function (a, b) {
      // 两边都未排序时相减为 NaN（NaN 为假）→ 自动落到 want 比较，不会把顺序抹成随机
      return pickRank(cfg, a.key) - pickRank(cfg, b.key) || (b.want ? 1 : 0) - (a.want ? 1 : 0);
    };
  }

  /**
   * 候选定稿：同 itemId 只留一条（不浪费配额在不重复产出上）→ 面板拖拽序优先、登记项次序 → 夹到剩余配额。
   * itemId=0（映射不到道具、或宠物）不参与道具去重。
   * @param {object[]} cands 候选任务
   * @param {number} room 剩余配额（<=0 直接空批）
   * @param {object} cfg 面板配置（取 pickRank/pickItems）
   * @returns {object[]} 可发的任务列表
   */
  #dedupPriority(cands, room, cfg) {
    if (!(room > 0)) return [];
    const seen = new Set();
    const out = [];
    for (let i = 0; i < cands.length; i++) {
      const c = cands[i];
      if (c.itemId) {
        if (seen.has(c.itemId)) continue;
        seen.add(c.itemId);
      }
      out.push(c);
    }
    out.sort(this.#byPriority(cfg));
    return out.slice(0, room);
  }

  /**
   * 从点位刷新载荷里吸收「uid==我」的条目进点位账（21522/21532 推送与带 uid 的应答都能补上这一刀）。
   * @param {'reward'|'res'} kind 点位类别
   * @param {object} e 点位载荷
   */
  #absorbMine(kind, e) {
    const me = this.#env.gameData.myUidStr();
    if (!me) return;
    const key = this.#tileKey(e);
    if (!key) return;
    const list = kind === 'res' ? e.bagInfo : e.dropInfo;
    const arr = Array.isArray(list) ? list : [];
    const acc = this.#acc(key);
    for (let i = 0; i < arr.length; i++) {
      const b = arr[i];
      if (!b || String(b.uid) !== me) continue;
      const dk = idKey(b.dropId);
      if (dk) acc.drop.add(dk);
      if (b.specId != null) acc.spec.add(String(b.specId));
      const itemId =
        kind === 'res' ? this.#stationItem(b.specId) : Number(b.info && b.info.itemId) || 0;
      if (itemId) acc.item.add(itemId);
    }
  }

  /**
   * 本 feat 自己按点位记的账：该 dropId / specId / itemId 是否已发过或已得。
   * 任一中即计「已拿」：存在理由见文件头（INFO 不带 uid → 游戏侧已领判据失效）。
   * @param {string} tileKey 点位键（'' = 无账可用，回 false 保持旧行为）
   * @param {*} dropId rId 原值
   * @param {number|string|null} specId 资源 specId
   * @param {number} itemId 产出道具 id（0 = 不按道具维度判）
   * @returns {boolean}
   */
  #gotLocal(tileKey, dropId, specId, itemId) {
    if (!tileKey) return false;
    const a = this.#gotByTile.get(tileKey);
    if (!a) return false;
    if (dropId != null && a.drop.has(idKey(dropId))) return true;
    if (specId != null && a.spec.has(String(specId))) return true;
    if (itemId && a.item.has(itemId)) return true;
    return false;
  }

  /**
   * 发出即乐观记账（dropId/specId）：流水线里同批不会重复发同一 rId，下轮也不会重发。
   * 未上线（被频控拦/超时）时由 #unmarkSent 撤销，留下轮重试。
   * @param {object} t 任务
   */
  #markSent(t) {
    if (!t.tileKey) return;
    const a = this.#acc(t.tileKey);
    const dk = idKey(t.dropId);
    if (dk) a.drop.add(dk);
    if (t.specId != null) a.spec.add(String(t.specId));
  }

  /**
   * 撤销乐观记账（仅 dropId；specId 保留也无害，因为同一 dropId 就是同一行）。
   * @param {object} t 任务
   */
  #unmarkSent(t) {
    if (!t.tileKey) return;
    const a = this.#gotByTile.get(t.tileKey);
    if (!a) return;
    const dk = idKey(t.dropId);
    if (dk) a.drop.delete(dk);
    if (t.specId != null) a.spec.delete(String(t.specId));
  }

  /**
   * 每条 GET 前的点位复检（按陈旧明细继续发会撞 158「小队尚未抵达」）：
   *   ① 载荷年龄 ≤ tuning.staleMaxMs；② 该点位未被 158 判死（在 TTL 内）；
   *   ③ 队伍在点上：roomBaseInfo.marchState ∈ {ARRIVED, GATHERING}（服务器 158 的客户端近似）；
   *   ④ 坐标级在位：roomBaseInfo.startPoint（缺时退 targetPoint）== 本批 tileKey。
   *      以 21521 载荷为准：ARRIVED 时 sp==tp、MARCHING 时 sp=旧点 tp=目的地；
   *      游戏侧同口径判据（NWorldPabCommonPopup.marchClick）：
   *      `t && t.startPoint` 时比 `t.startPoint.x!==tileX || t.startPoint.y!==tileY`。
   *      → 能补上「marchState 仍是 ARRIVED 但已迁到另一点」这个 ③ 抓不到的 158 场景；读不到坐标则放行。
   * @param {string} tileKey 点位键（'' 时跳过判死与坐标核对）
   * @param {number} ts 载荷入 #pending 的时刻
   * @returns {boolean} true=可发
   */
  #tileGate(tileKey, ts) {
    const env = this.#env;
    const now = Date.now();
    if (ts && now - ts > tuning.staleMaxMs) {
      env.log.info(
        'pickup batch dropped: payload age %dms > %dms (stale tile).',
        now - ts,
        tuning.staleMaxMs,
      );
      return false;
    }
    if (tileKey) {
      const exp = this.#tileDead.get(tileKey);
      if (exp != null) {
        if (now < exp) return false;
        this.#tileDead.delete(tileKey);
      }
    }
    const S = env.secret.getNMarchState();
    const pab = env.secret.getPabController();
    const base = pab && pab.roomBaseInfo;
    const ms = base && typeof base.marchState === 'number' ? base.marchState : -1;
    if (S && ms >= 0) {
      const arrived =
        ms === (S.ARRIVED == null ? 2 : S.ARRIVED) ||
        ms === (S.GATHERING == null ? 5 : S.GATHERING);
      if (!arrived) {
        env.log.debug('pickup gate: marchState=%d not on tile, batch aborted.', ms);
        return false;
      }
    }
    if (tileKey && base) {
      const pt = base.startPoint || base.targetPoint;
      const px = Number(pt && pt.x);
      const py = Number(pt && pt.y);
      if (Number.isFinite(px) && Number.isFinite(py) && tileKey !== px + ',' + py) {
        env.log.debug('pickup gate: team at (%d,%d) != tile %s, batch aborted.', px, py, tileKey);
        return false;
      }
    }
    return true;
  }

  /**
   * GET 流水线：逐条**发出即继续**（不串行 await），条间按 #gapMs 自适应节拍；每条发出前复检点位闸门，
   * 失效（离点/陈旧/判死）即中止本批。全批 settle 后回成功条数（给调用方算总量闸门）。
   * @param {object[]} tasks #dedupPriority 加过工的任务列表
   * @param {number} ts 载荷入 #pending 的时刻
   * @returns {Promise<number>} ok 条数
   */
  async #pipe(tasks, ts) {
    const env = this.#env;
    if (!tasks || !tasks.length) return 0;
    const self = this;
    const jobs = [];
    for (let i = 0; i < tasks.length; i++) {
      if (!env.alive() || !env.realmActive()) break;
      if (!this.#tileGate(tasks[i].tileKey, ts)) break;
      const t = tasks[i];
      this.#markSent(t);
      jobs.push(self.#sendOne(t));
      if (i + 1 < tasks.length) await sleep(this.#gapMs);
    }
    const res = await Promise.all(jobs);
    let ok = 0;
    for (let i = 0; i < res.length; i++) if (res[i] && res[i].ok) ok++;
    env.log.debug('pickup pipeline: %d/%d sent ok, gap=%dms.', ok, jobs.length, this.#gapMs);
    return ok;
  }

  /**
   * 单条 GET 的发出与结算（不在此 await，由 #pipe 保持流水线在飞）。
   * @param {object} t 任务
   * @returns {Promise<object>} sendSecret 的 Ret
   */
  #sendOne(t) {
    const self = this;
    return this.#env.secret.sendSecret(t.cmd, t.req).then(function (ret) {
      self.#settle(t, ret);
      return ret;
    });
  }

  /**
   * 单条 GET 结算：记账、节拍退避、拉黑与点位判死全部在此分派（不抛异常控制流）。
   * @param {object} t 任务
   * @param {object} ret sendSecret 结果
   */
  #settle(t, ret) {
    const env = this.#env;
    if (ret && ret.ok) {
      if (this.#gapMs > tuning.getGapMs) {
        this.#gapMs = Math.max(tuning.getGapMs, this.#gapMs - tuning.getGapStepMs);
      }
      if (t.itemId && t.tileKey) this.#acc(t.tileKey).item.add(t.itemId);
      return;
    }
    const code = ret && ret.code;
    if (code === CODE_NOT_SENT || code == null) {
      // 没上线（次通道 cdTime 频控拦下）或超时：撤销乐观记账留下轮重试，节拍翻倍退避再试探
      this.#unmarkSent(t);
      this.#gapMs = Math.min(tuning.getGapMaxMs, Math.max(this.#gapMs * 2, tuning.getGapMs * 2));
      env.log.debug(
        'pickup GET %d not on wire (throttled/timeout), gap -> %dms.',
        t.cmd,
        this.#gapMs,
      );
      return;
    }
    const reason = ret && ret.reason ? String(ret.reason) : '';
    if (reason === REJ_NOT_ARRIVED) {
      // 服务器说我们不在点上：不拉黑 rId（回来还能拿），只判死该点位一段时间
      this.#unmarkSent(t);
      if (t.tileKey) this.#tileDead.set(t.tileKey, Date.now() + tuning.tileDeadMs);
      env.log.info(
        'pickup rejected not-arrived (%s), tile %s paused %dms.',
        reason,
        t.tileKey || '?',
        tuning.tileDeadMs,
      );
      return;
    }
    if (reason === REJ_SAME_ITEM_ONCE && t.itemId && t.tileKey) {
      // 同道具只能领 1 次：按道具维度记账，同点位其他 specId 也不再发
      this.#acc(t.tileKey).item.add(t.itemId);
    }
    this.#blackOnReject(t.dropId, ret);
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
   * §9.4 竞品对照（L25155-25190，2026-11-03 核对）：buff_para 比较内核一致（同类更强才替换，否则不装）；
   *   两处**有意分歧**保留我方口径：① 竞品写死三类白名单（buff_icon 含 enigma_speed/enigma_attack/enigma_damage），
   *     我方走面板 buffEffects 类勾选（空=不限，用户口径优先于字面量）；② 竞品把「槽里是非三类 buff」的占位也当可覆盖
   *     （`r = r || n`），我方只填空槽与同类更强替换——不覆盖用户槽里其它类别的已装 buff（安全优先）。
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
   * 推送侧 bagInfo 条目带 `uid`+`playerInfo` 即表示已被该玩家领取（8526 应答条目不带 uid，故要自己记账），游戏 UI 走 enigma_realm165「已被{0}拿走」；
   *   我们若不预先过滤，发包会撞 8527/8533 `s=3 d=enigma_realm161`「已经被其他指挥官拿走咯」（8527 应答 57 条里 17 条）。
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
