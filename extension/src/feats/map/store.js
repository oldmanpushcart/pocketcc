/**
 * 全局地图运行时容器 + 持久化。
 * 内存真相：Map<"vk:cellIndex", 实体>——按「视角桶 vk（采集时视角所在区）」分区（对齐游戏
 * getCellIndex(x,y,k) 含服号的存键方式，不同区同格共存不互盖），cellIndex=cellY·cols+cellX。
 * 外加 meta（尺寸/mapType + 每桶一份 {ts,done,bound} 扫描元信息）。901 的 pointList 经 scanner
 * 归一后逐点 upsert 进来，按 `v` 版本号去重（同桶同格同版本直接跳过，避免重复重建）。
 *
 * 落盘：走 storage.data（UID 命名空间、与配置分离的数据 blob）两个逻辑键——
 *   map.world.entities（紧凑并行数组）/ map.world.meta（标量元信息 + 分桶）。
 * 紧凑编码：实体拆成 x/y/t/v 等长数组（比对象数组小一个量级），4 万点约 1MB 级，unlimitedStorage 兜底。
 * 读盘时按 TTL 判新鲜度（按桶）；不新鲜只提示重扫，不清数据。
 */
import { createLog } from '../../core/log.js';
import { storage } from '../../core/storage.js';
import { SERVER } from './map-meta.js';
import { cellToIndex } from './coord.js';

/** @type {ReturnType<createLog>} 模块日志器（tag=MAPSTORE） */
const log = createLog('MAPSTORE');

/** @type {string} 实体数据逻辑键（storage.data 下） */
const ENT_KEY = 'map.world.entities';
/** @type {string} 元信息逻辑键（storage.data 下） */
const META_KEY = 'map.world.meta';

/** @type {string[]} 901 点里可能携带 itemId/level 的子对象键（按优先级） */
const SUB_KEYS = ['r', 't', 'm', 'b', 'p'];

/** 数值→数字（null/''/非有限/0 一律视为无→null）；pid/aid 均可安全走 Number（< 2^53） */
function numOrNull(v) { if (v == null || v === '') return null; const n = Number(v); return (isFinite(n) && n !== 0) ? n : null; }
/** 从子对象的 playerInfo（嵌套 JSON 串或对象）取显示名 username/nickname */
function piUser(o) {
  if (!o) return null;
  let pi = o.playerInfo;
  if (typeof pi === 'string') { try { pi = JSON.parse(pi); } catch (_) { pi = null; } }
  if (pi && typeof pi === 'object') { const n = pi.username || pi.nickname; if (n) return String(n); }
  return null;
}
/**
 * 从 901 点抽取归属身份（字段跨子对象分布，按优先级归一）：
 * ownerId←p.pid/r.ownerId/m.ownerId/t.ownerId/b.pid/m.uid；allianceId←p.aid/r.aid/m.allianceId/b.aid/t.aid；
 * power←p.power/m.power；army←p.armyPower（玩家城池兵力/军团强度）；name←playerInfo(p/b/r/t).username 或 m.ownerName。均可能为 null。
 * @param {object} p pointList 项
 * @returns {{oid:?number, aid:?number, power:?number, army:?number, name:?string}}
 */
function extractOwner(p) {
  const P = p.p, R = p.r, M = p.m, B = p.b, T = p.t;
  const oid = numOrNull(P && P.pid) || numOrNull(R && R.ownerId) || numOrNull(M && M.ownerId)
    || numOrNull(T && T.ownerId) || numOrNull(B && B.pid) || numOrNull(M && (M.uid != null ? M.uid : M.ownerUid)) || null;
  const aid = numOrNull(P && P.aid) || numOrNull(R && R.aid) || numOrNull(M && M.allianceId)
    || numOrNull(B && B.aid) || numOrNull(T && T.aid) || null;
  const power = numOrNull(P && P.power) || numOrNull(M && M.power) || null;
  const army = numOrNull(P && P.armyPower) || null; // 玩家城池兵力（军团强度，整数，可达 1e37，显示走 getLargeNumberShow 口径）
  const name = piUser(P) || piUser(B) || piUser(R) || piUser(T) || (M && M.ownerName ? String(M.ownerName) : null) || null;
  return { oid: oid, aid: aid, power: power, army: army, name: name };
}

/**
 * @typedef {object} TileEntity 单格实体（901 pointList 归一后的最小渲染集）
 * @property {number} cellIndex cellY·cols+cellX（桶内局部键，存键另加 vk 前缀）
 * @property {number} vk 视角桶：采集时视角所在区服号（跨区同格共存靠它隔开）
 * @property {number} cellX
 * @property {number} cellY
 * @property {number} pointType
 * @property {?number} itemId 子类型/资源种 id（从子对象抽取，无则 null）
 * @property {?number} bid 建筑/设施 id（资源塔类型源，从子对象抽取，无则 null）
 * @property {?number} level 等级（从子对象抽取，无则 null；部分野怪为负数编码）
 * @property {?number} shield 玩家城池护盾到期时间戳（Unix 秒，从 p.shieldTime 抽取；无盾为 null）
 * @property {?number} oid 归属玩家 pid（无主为 null；==账号 UID）
 * @property {?number} aid 归属联盟 id（未入盟/无主为 null）
 * @property {?number} power 归属战力（仅玩家城池等有部分）
 * @property {?number} army 玩家城池兵力/军团强度（从 p.armyPower 抽取；非城池为 null）
 * @property {?string} oname 归属玩家显示名
 * @property {number} v 数据版本号（同格重复扫到用于去重）
 * @property {number} [k] 点自身服号（归属判定/跳转 z 参用，跨区城飞过来时 ≠ vk）
 * @property {number} [rnd] 本轮扫描轮次号（仅运行时不落盘；块内清扫据此区分「本轮已重新确认」与陈数据）
 * @property {number} [ts] 最近一次写入时间戳 ms（仅运行时不落盘；列表排序/新点闪烁用）
 * @property {*} [id] 实体唯一 id（多格建筑归并用，>2^53 可能已在 JSON.parse 丢精度，仅尽力保留）
 */

/**
 * @typedef {object} BucketMeta 单区扫描元信息
 * @property {number} ts 最近一次落盘时间戳（ms，0=未扫）
 * @property {boolean} done 是否完成过一轮完整扫描
 * @property {{minX:number,minY:number,maxX:number,maxY:number}} bound 已扫覆盖范围（cell）
 */

/**
 * @typedef {object} MapMeta 全图元信息
 * @property {number} cols 列数（cell）
 * @property {number} rows 行数（cell）
 * @property {number} mapType 当前地图类型（地形/渲染档位判定）
 * @property {Object<string, BucketMeta>} buckets 按区服号分桶的扫描元信息（键=String(vk)）
 */

export class MapStore {
  constructor() {
    /** @type {Map<string, TileEntity>} "vk:cellIndex" -> 实体（按区分桶） */
    this.entities = new Map();
    /** @type {Map<string, {marchId:string, cellX:number, cellY:number}>} marchId -> 行军关键项（v1 仅存跳转所需） */
    this.marches = new Map();
    /** @type {MapMeta} 元信息（默认本服尺寸、未扫） */
    this.meta = {
      cols: SERVER.cols, rows: SERVER.rows, mapType: 0, buckets: {},
    };
    /** @type {boolean} 是否已成功从盘读回（未读回前不覆盖落盘，同 chat-window pmInfoDiskLoaded 语义） */
    this.diskLoaded = false;
    /** @type {boolean} 内存数据自上次落盘后是否变脏 */
    this.dirty = false;
    /** @type {Set<string>} 自上次落盘以来变过的桶键（persist 时只刷新这些桶的 ts） */
    this._dirtyBuckets = new Set();
  }

  /**
   * upsert 一条 901 归一后的实体点（game 坐标入口，内部转 cell），落入视角桶 vk。
   * @param {{x:number, y:number, pointType:number, v?:number, k?:number, id?:*}} p pointList 项（含 game x/y）
   * @param {number} [vk] 视角桶（采集时所在区）；缺省用点自身服号 p.k，都无则 0
   * @param {number} [rnd] 本轮轮次号（scanner.beginRound 发放；块内清扫的保留判据）
   * @returns {boolean} 是否发生写入（同桶同格同版本返回 false，但仍标记本轮已确认）
   */
  upsertPoint(p, vk, rnd) {
    if (!p || p.x == null || p.y == null || p.pointType == null) return false;
    // game → cell：x 奇归偶折半，y 透传（见 coord.gameToCell 同式，此处内联避免额外分配）
    const cellX = ((p.x & 1) ? p.x - 1 : p.x) / 2;
    const cellY = p.y;
    const bucket = vk != null ? vk : (p.k != null ? p.k : 0);
    const idx = cellToIndex(cellX, cellY, this.meta.cols);
    const key = bucket + ':' + idx;
    const v = p.v == null ? 0 : p.v;
    // 从子对象抽取 itemId/level/bid/shield（首个命中为准），供子类/等级筛选与详情、护盾过滤用
    let itemId = null, level = null, bid = null, shield = null;
    for (let s = 0; s < SUB_KEYS.length; s++) {
      const o = p[SUB_KEYS[s]];
      if (o && typeof o === 'object') {
        if (itemId == null && o.itemId != null) itemId = o.itemId;
        if (level == null && o.level != null) level = o.level;
        if (bid == null && o.bid != null) bid = Number(o.bid) || o.bid;
        if (shield == null && o.shieldTime != null) shield = Number(o.shieldTime) || null; // 玩家城池护盾到期时间戳（Unix 秒）
      }
    }
    const prev = this.entities.get(key);
    if (prev && prev.v === v && prev.pointType === p.pointType && prev.itemId === itemId && prev.level === level && prev.bid === bid && prev.shield === shield) {
      if (rnd != null) prev.rnd = rnd; // 同版本去重跳过，但仍算「本轮再确认」，不被块内清扫误删
      return false;
    }
    const own = extractOwner(p);
    const now = Date.now();
    this.entities.set(key, {
      cellIndex: idx, vk: bucket, cellX, cellY, pointType: p.pointType, itemId, level, bid, shield, oid: own.oid, aid: own.aid, power: own.power, army: own.army, oname: own.name, v, k: p.k, rnd, ts: now, id: p.id,
    });
    const b = this.bucketMeta(bucket).bound;
    if (cellX < b.minX) b.minX = cellX;
    if (cellY < b.minY) b.minY = cellY;
    if (cellX > b.maxX) b.maxX = cellX;
    if (cellY > b.maxY) b.maxY = cellY;
    this.dirty = true;
    this._dirtyBuckets.add(String(bucket));
    return true;
  }

  /**
   * 取（懒建）某视角桶的扫描元信息。
   * @param {number|string} vk 视角桶服号
   * @returns {BucketMeta}
   */
  bucketMeta(vk) {
    const key = String(vk);
    let b = this.meta.buckets[key];
    if (!b) {
      b = { ts: 0, done: false, bound: { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity } };
      this.meta.buckets[key] = b;
    }
    return b;
  }

  /**
   * 记录一条行军关键项（marchId 必须是字符串：64 位雪花 id，Number 会静默丢精度）。
   * @param {string} marchId
   * @param {number} cellX
   * @param {number} cellY
   */
  upsertMarch(marchId, cellX, cellY) {
    if (marchId == null) return;
    const key = String(marchId);
    if (this.marches.has(key)) return;
    this.marches.set(key, { marchId: key, cellX, cellY });
    this.dirty = true;
  }

  /** 设置地图类型（来自 game-api 探测；变化会触发底图重建判定） */
  setMapType(mapType) {
    if (mapType && mapType !== this.meta.mapType) { this.meta.mapType = mapType; this.dirty = true; }
  }

  /** 标记某视角桶本轮扫描完成 */
  markDone(vk) {
    this.bucketMeta(vk).done = true;
    this.dirty = true;
    this._dirtyBuckets.add(String(vk));
  }

  /**
   * 开启一轮新扫描：该桶轮次号 +1 并返回（本轮写入/再确认的点标此号）。
   * 块扫到时「先写新、再清块内非本轮号的老数据」——精确更新，重扫不残留迁城/采空/打败的老点。
   * @param {number|string} vk 视角桶服号
   * @returns {number} 本轮轮次号
   */
  beginRound(vk) {
    const b = this.bucketMeta(vk);
    b.round = (b.round | 0) + 1;
    this.dirty = true;
    return b.round;
  }

  /**
   * 块内清扫：删某桶中落在指定 cell 矩形内、且本轮未被重新确认（rnd !== keepRound）的实体。
   * 调用时机：该块新数据写入之后（块矩形并集=全图，逐块扫完即全桶更新完毕）。
   * 邻块重叠带回的本轮新点 rnd 相同，不会被误删。
   * @param {number} vk 视角桶服号
   * @param {number} cx0 块左上 cell x（含）
   * @param {number} cy0 块左上 cell y（含）
   * @param {number} cw 块宽（cell，右缘不含）
   * @param {number} ch 块高（cell，下缘不含）
   * @param {number} keepRound 保留的轮次号（本轮）
   * @returns {number} 清扫条数
   */
  purgeRange(vk, cx0, cy0, cw, ch, keepRound) {
    const cx1 = cx0 + cw, cy1 = cy0 + ch;
    let n = 0;
    for (const [key, e] of this.entities) {
      if (e.vk !== vk) continue;
      if (e.rnd === keepRound) continue;                 // 本轮已写/已再确认
      if (e.cellX >= cx0 && e.cellX < cx1 && e.cellY >= cy0 && e.cellY < cy1) {
        this.entities.delete(key);                        // 迭代中删 Map 条目安全
        n++;
      }
    }
    if (n) this.dirty = true;
    return n;
  }

  /**
   * 清空内存全部点位/行军与扫描元信息（尺寸保留，不动配置）。
   * @returns {void}
   */
  clear() {
    this.entities.clear();
    this.marches.clear();
    this.meta.buckets = {};
    this.dirty = false;
    this._dirtyBuckets.clear();
  }

  /**
   * 只清某个视角桶：删该桶前缀全部实体与该桶元信息（「清空点位」只清当前区）。
   * @param {number|string} vk 视角桶服号
   * @returns {number} 删除的实体数
   */
  clearBucket(vk) {
    const pfx = String(vk) + ':';
    let n = 0;
    for (const key of [...this.entities.keys()]) {
      if (key.startsWith(pfx)) { this.entities.delete(key); n++; }
    }
    delete this.meta.buckets[String(vk)];
    this._dirtyBuckets.delete(String(vk));
    this.dirty = true;
    return n;
  }

  /**
   * 清空内存 + 删除落盘数据（实体/元信息两键）。清后置 diskLoaded=true，
   * 避免同会话再 load() 把旧数据拉回内存。
   * @returns {Promise<void>}
   */
  async clearPersisted() {
    this.clear();
    this.diskLoaded = true;
    try {
      await storage.data.remove(ENT_KEY);
      await storage.data.remove(META_KEY);
      log.info('cleared all points (memory + disk).');
    } catch (err) {
      log.warn('clear persist failed: %s', err && err.message);
    }
  }

  /**
   * 实体数：传 vk 只数该桶（前缀扫描），不传/传 0 以外假值时缺省全量。
   * @param {number} [vk] 视角桶服号
   * @returns {number}
   */
  size(vk) {
    if (!vk) return this.entities.size;
    const pfx = String(vk) + ':';
    let n = 0;
    for (const key of this.entities.keys()) if (key.startsWith(pfx)) n++;
    return n;
  }

  /**
   * 取某桶某格的实体（跳转 z 参用：拿点自身服号 k）。
   * @param {number} vk 视角桶服号
   * @param {number} cellX
   * @param {number} cellY
   * @returns {TileEntity|undefined}
   */
  pointAt(vk, cellX, cellY) {
    return this.entities.get(String(vk) + ':' + cellToIndex(cellX, cellY, this.meta.cols));
  }

  /**
   * 某桶落盘数据是否新鲜（在 TTL 内）。
   * @param {number} vk 视角桶服号
   * @param {number} ttlHours 有效期小时
   * @returns {boolean}
   */
  isFresh(vk, ttlHours) {
    const b = this.meta.buckets[String(vk)];
    if (!b || !b.ts || b.ts <= 0) return false;
    return Date.now() - b.ts < (ttlHours || 24) * 3600 * 1000;
  }

  /**
   * 紧凑序列化：实体拆 x/y/t/it/lv/bd/sd/k/vk/oid/aid/pw/ap/ow/ver 等长数组（比逐对象小一个量级）。
   * fmt:7 = 含兵力 ap；fmt:6 = 含护盾到期 sd；fmt:5 = 含视角桶 vk（按区分区存储）；fmt:4 含 bid（bd）与服号 k；旧 fmt 缺项读盘时降级 null。
   * @returns {object} 可 JSON 化的紧凑对象
   */
  serialize() {
    const x = [], y = [], t = [], it = [], lv = [], bd = [], sd = [], k = [], vk = [], oid = [], aid = [], pw = [], ap = [], ow = [], ver = [];
    for (const e of this.entities.values()) {
      x.push(e.cellX); y.push(e.cellY); t.push(e.pointType); it.push(e.itemId == null ? null : e.itemId); lv.push(e.level == null ? null : e.level); ver.push(e.v);
      bd.push(e.bid == null ? null : e.bid); sd.push(e.shield == null ? null : e.shield); k.push(e.k == null ? null : e.k); vk.push(e.vk == null ? null : e.vk);
      oid.push(e.oid == null ? null : e.oid); aid.push(e.aid == null ? null : e.aid); pw.push(e.power == null ? null : e.power); ap.push(e.army == null ? null : e.army); ow.push(e.oname == null ? null : e.oname);
    }
    return { fmt: 7, cols: this.meta.cols, rows: this.meta.rows, x, y, t, it, lv, bd, sd, k, vk, oid, aid, pw, ap, ow, ver };
  }

  /**
   * 从紧凑对象还原实体到内存（覆盖现有）。兼容 fmt≤5（无 sd 列时护盾降级 null；无 vk 列时按点自身 k 归桶，k 也无则入 defaultVk 桶）。
   * @param {object} d serialize() 产物
   * @param {number} [defaultVk] 旧档无桶标时的缺省桶（业务层传本服号）
   */
  deserialize(d, defaultVk) {
    if (!d || !Array.isArray(d.x)) return;
    this.entities.clear();
    const cols = d.cols || this.meta.cols;
    const hasAttr = Array.isArray(d.it) || Array.isArray(d.lv);
    const hasOwner = Array.isArray(d.oid);
    const hasBid = Array.isArray(d.bd);
    const hasShield = Array.isArray(d.sd);
    const hasK = Array.isArray(d.k);
    const hasVk = Array.isArray(d.vk);
    for (let i = 0; i < d.x.length; i++) {
      const cellX = d.x[i], cellY = d.y[i], pointType = d.t[i], v = (d.ver ? d.ver[i] : 0);
      const itemId = hasAttr && d.it ? (d.it[i] == null ? null : d.it[i]) : null;
      const level = hasAttr && d.lv ? (d.lv[i] == null ? null : d.lv[i]) : null;
      const bid = hasBid ? (d.bd[i] == null ? null : d.bd[i]) : null;
      const shield = hasShield ? (d.sd[i] == null ? null : d.sd[i]) : null;
      const k = hasK ? (d.k[i] == null ? null : d.k[i]) : null;
      const vk = hasVk && d.vk[i] != null ? d.vk[i] : (k != null ? k : (defaultVk | 0));
      const oid = hasOwner ? (d.oid[i] == null ? null : d.oid[i]) : null;
      const aid = hasOwner ? (d.aid && d.aid[i] != null ? d.aid[i] : null) : null;
      const power = hasOwner ? (d.pw && d.pw[i] != null ? d.pw[i] : null) : null;
      const army = hasOwner && d.ap ? (d.ap[i] == null ? null : d.ap[i]) : null;   // 旧档无 ap 列→兵力降级 null（重扫后补齐）
      const oname = hasOwner ? (d.ow && d.ow[i] != null ? d.ow[i] : null) : null;
      const idx = cellToIndex(cellX, cellY, cols);
      this.entities.set(vk + ':' + idx, { cellIndex: idx, vk, cellX, cellY, pointType, itemId, level, bid, shield, k, oid, aid, power, army, oname, v });
    }
  }

  /**
   * 异步落盘（实体 + 元信息）。落盘前只刷新「变过的桶」的 ts（未动的桶保持各自新鲜度）；
   * 无变化（非脏）时跳过写盘。UID 未就绪时 storage.data.set 会丢弃写入，这里静默容忍。
   * @param {boolean} [force] 忽略脏标记强制写
   * @returns {Promise<void>}
   */
  async persist(force) {
    if (!this.dirty && !force) return;
    const now = Date.now();
    const buckets = {};
    for (const key of Object.keys(this.meta.buckets)) {
      const b = this.meta.buckets[key];
      if (this._dirtyBuckets.has(key)) b.ts = now;
      // bound 里的 Infinity 无法 JSON 化，落盘前归一为整数或 0
      buckets[key] = { ts: b.ts, done: !!b.done, round: b.round | 0, bound: isFinite(b.bound.minX) ? b.bound : { minX: 0, minY: 0, maxX: 0, maxY: 0 } };
    }
    const ent = this.serialize();
    const meta = { cols: this.meta.cols, rows: this.meta.rows, mapType: this.meta.mapType, buckets };
    try {
      await storage.data.set(META_KEY, meta);
      await storage.data.set(ENT_KEY, ent);
      this.dirty = false;
      this._dirtyBuckets.clear();
      log.info('persisted. entities=%d buckets=%d', ent.x.length, Object.keys(buckets).length);
    } catch (err) {
      log.warn('persist failed: %s', err && err.message);
    }
  }

  /**
   * 异步读盘并还原（实体 + 分桶元信息）。读回成功后置 diskLoaded。
   * fmt≤4 旧档迁移：无桶标的实体按点自身 k 归桶（k 也无则入 defaultVk）；
   * 旧顶层 {ts,done,bound} 整体迁入 defaultVk 桶。
   * 命名空间未设时 get 会 reject——此处视作「暂不可读」，保留下次重读机会（不当作空）。
   * @param {number} [defaultVk] 旧档缺省视角桶（本服号）
   * @returns {Promise<boolean>} 是否成功读回盘上数据
   */
  async load(defaultVk) {
    if (this.diskLoaded) return true;
    try {
      const meta = await storage.data.get(META_KEY);
      const ent = await storage.data.get(ENT_KEY);
      this.diskLoaded = true;
      defaultVk = defaultVk | 0;
      if (meta && typeof meta === 'object') {
        this.meta.cols = meta.cols || this.meta.cols;
        this.meta.rows = meta.rows || this.meta.rows;
        this.meta.mapType = meta.mapType || 0;
        this.meta.buckets = (meta.buckets && typeof meta.buckets === 'object') ? meta.buckets : {};
        if (!Object.keys(this.meta.buckets).length && (meta.ts || meta.done || meta.bound)) {
          const bd = meta.bound && isFinite(meta.bound.minX) ? meta.bound : { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
          this.meta.buckets[String(defaultVk)] = { ts: meta.ts || 0, done: !!meta.done, bound: bd };
        }
        // 读盘的 bound 经 JSON 后 Infinity 变 null，逐桶还原哨兵
        for (const key of Object.keys(this.meta.buckets)) {
          const b = this.meta.buckets[key];
          if (!b.bound || !isFinite(b.bound.minX)) b.bound = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
        }
      }
      if (ent) this.deserialize(ent, defaultVk);
      log.info('loaded from disk. entities=%d buckets=%d', this.entities.size, Object.keys(this.meta.buckets).length);
      return this.entities.size > 0 || Object.keys(this.meta.buckets).length > 0;
    } catch (err) {
      log.warn('load failed (namespace not ready?), will retry. %s', err && err.message);
      return false;
    }
  }

  /**
   * 记录某桶的某块已扫描（覆盖度动画/进度用）——把块 cell 矩形并入该桶 bound（maxX/maxY 为开区间右/下缘）。
   * @param {number} vk 视角桶服号
   * @param {number} cx 块左上 cell x
   * @param {number} cy 块左上 cell y
   * @param {number} cw 块宽（cell）
   * @param {number} ch 块高（cell）
   */
  touchBlock(vk, cx, cy, cw, ch) {
    const b = this.bucketMeta(vk).bound;
    if (cx < b.minX) b.minX = cx;
    if (cx + cw > b.maxX) b.maxX = cx + cw;
    if (cy < b.minY) b.minY = cy;
    if (cy + ch > b.maxY) b.maxY = cy + ch;
    this._dirtyBuckets.add(String(vk));
    this.dirty = true;
  }
}

/** @type {MapStore} 单例（扫图与渲染共享同一份运行态） */
export const mapStore = new MapStore();
