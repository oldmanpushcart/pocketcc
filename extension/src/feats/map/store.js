/**
 * 全局地图运行时容器 + 分桶持久化（**懒加载 + 单桶驻留**）。
 * 内存真相：Map<"vk:cellIndex", 实体>——同一时刻**只驻留一个视角桶**（vk=采集时视角所在区，
 * 对齐游戏 getCellIndex(x,y,k) 含服号的存键方式，不同区同格共存不互盖），cellIndex=cellY·cols+cellX。
 * 桶的换入换出由 useBucket(vk) 唯一决定：换桶前把旧桶落盘，再从内存整批丢弃——全图数据不再常驻。
 * 901 的 pointList 经 scanner 归一后逐点 upsert 进来，按 `v` 版本号去重（同桶同格同版本直接跳过）。
 *
 * 落盘：走 storage.slot（UID 前缀下的**独立键**，刻意脱离共享的 pocketcc.data blob）——
 *   map.world.meta      索引：尺寸/mapType + 每桶 {ts,done,round,bound,count}（很小，可常读）
 *   map.world.ent.<vk>  单个视角桶的紧凑并行数组（只在需要该桶时才读/写）
 * 拆键两个理由：① 其他 feat 读写共享 blob 不再把地图全量点连带拉进内存、也不再整块回写它们；
 * ② 地图落盘只序列化当前桶，开销随桶大小增长而非全图。紧凑编码：实体拆 x/y/t/… 等长数组，
 * 比对象数组小一个量级，单桶 4 千点约 100KB 级，unlimitedStorage 兜底。
 *
 * 旧格式（共享 blob 里的 map.world.entities + map.world.meta，全量单键）在首次读索引发现
 * 「新索引不存在」时一次性分桶迁移，迁完删旧键；迁移只跑一次（新索引存在即跳过）。
 * 铁律沿用 core/storage.js 的教训：**读回未完成 ≠ 盘上没数据**——索引未 indexLoaded 前一律拒绝落盘，
 * 否则拿空内存写回会把盘上已有桶覆掉。
 */
import { createLog } from '../../core/log.js';
import { storage } from '../../core/storage.js';
import { SERVER } from './map-meta.js';
import { cellToIndex } from './coord.js';

/** @type {ReturnType<createLog>} 模块日志器（tag=MAPSTORE） */
const log = createLog('MAPSTORE');

/** @type {string} 索引独立键（storage.slot 下）：尺寸/mapType + 每桶扫描元信息与点数 */
const SLOT_META = 'map.world.meta';
/** @type {string} 单桶实体独立键前缀（后接视角桶服号） */
const SLOT_ENT_PFX = 'map.world.ent.';
/** @type {string} 旧格式：共享 data blob 内的全量实体逻辑键（仅作一次性迁移源） */
const LEGACY_ENT = 'map.world.entities';
/** @type {string} 旧格式：共享 data blob 内的元信息逻辑键（仅作一次性迁移源） */
const LEGACY_META = 'map.world.meta';

/** @type {string[]} 901 点里可能携带 itemId/level 的子对象键（按优先级） */
const SUB_KEYS = ['r', 't', 'm', 'b', 'p'];

/** 数值→数字（null/''/非有限/0 一律视为无→null）；pid/aid 均可安全走 Number（< 2^53） */
function numOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return isFinite(n) && n !== 0 ? n : null;
}
/** 从子对象的 playerInfo（嵌套 JSON 串或对象）取显示名 username/nickname */
function piUser(o) {
  if (!o) return null;
  let pi = o.playerInfo;
  if (typeof pi === 'string') {
    try {
      pi = JSON.parse(pi);
    } catch (_) {
      pi = null;
    }
  }
  if (pi && typeof pi === 'object') {
    const n = pi.username || pi.nickname;
    if (n) return String(n);
  }
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
  const P = p.p,
    R = p.r,
    M = p.m,
    B = p.b,
    T = p.t;
  const oid =
    numOrNull(P && P.pid) ||
    numOrNull(R && R.ownerId) ||
    numOrNull(M && M.ownerId) ||
    numOrNull(T && T.ownerId) ||
    numOrNull(B && B.pid) ||
    numOrNull(M && (M.uid != null ? M.uid : M.ownerUid)) ||
    null;
  const aid =
    numOrNull(P && P.aid) ||
    numOrNull(R && R.aid) ||
    numOrNull(M && M.allianceId) ||
    numOrNull(B && B.aid) ||
    numOrNull(T && T.aid) ||
    null;
  const power = numOrNull(P && P.power) || numOrNull(M && M.power) || null;
  const army = numOrNull(P && P.armyPower) || null; // 玩家城池兵力（军团强度，整数，可达 1e37，显示走 getLargeNumberShow 口径）
  const name =
    piUser(P) ||
    piUser(B) ||
    piUser(R) ||
    piUser(T) ||
    (M && M.ownerName ? String(M.ownerName) : null) ||
    null;
  return { oid: oid, aid: aid, power: power, army: army, name: name };
}

/**
 * @typedef {object} TileEntity 单格实体（901 pointList 归一后的最小渲染集）
 * @property {number} cellIndex cellY·cols+cellX（桶内局部键，存键另加 vk 前缀）
 * @property {number} vk 视角桶：采集时视角所在区服号（驻留桶的唯一归属，恒等于 MapStore.loadedVk）
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
 * @typedef {object} BucketMeta 单区扫描元信息（存在索引键里，不含实体本身）
 * @property {number} ts 最近一次落盘时间戳（ms，0=未扫）
 * @property {boolean} done 是否完成过一轮完整扫描
 * @property {number} count 该桶上次落盘时的实体数（未驻留时供面板显示「已存 N 点」，无需读实体）
 * @property {number} round 最近一轮扫描轮次号
 * @property {{minX:number,minY:number,maxX:number,maxY:number}} bound 已扫覆盖范围（cell）
 */

/**
 * @typedef {object} MapMeta 全图索引
 * @property {number} cols 列数（cell）
 * @property {number} rows 行数（cell）
 * @property {number} mapType 当前地图类型（地形/渲染档位判定）
 * @property {Object<string, BucketMeta>} buckets 按区服号分桶的扫描元信息（键=String(vk)）
 */

/** 新建一份桶元信息（bound 用 Infinity 哨兵表示「还没覆盖任何格」） */
function newBucketMeta() {
  return {
    ts: 0,
    done: false,
    count: 0,
    round: 0,
    bound: { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
  };
}

export class MapStore {
  constructor() {
    /** @type {Map<string, TileEntity>} "vk:cellIndex" -> 实体（仅驻留当前桶） */
    this.entities = new Map();
    /** @type {Map<string, {marchId:string, cellX:number, cellY:number}>} marchId -> 行军关键项（v1 仅存跳转所需，随桶驱逐） */
    this.marches = new Map();
    /** @type {MapMeta} 索引（默认本服尺寸、未扫） */
    this.meta = {
      cols: SERVER.cols,
      rows: SERVER.rows,
      mapType: 0,
      buckets: {},
    };
    /** @type {number|null} 当前驻留内存的视角桶（null=未驻留任何桶，即尚未懒加载过） */
    this.loadedVk = null;
    /** @type {boolean} 索引是否已成功读回（含旧档迁移）；未就绪前禁止落盘，见文件头铁律 */
    this.indexLoaded = false;
    /** @type {boolean} 内存数据自上次落盘后是否变脏 */
    this.dirty = false;
    /** @type {Set<string>} 自上次落盘以来变过的桶键（persist 时只刷新这些桶的 ts） */
    this._dirtyBuckets = new Set();
    /** @type {?Promise<boolean>} 索引加载在飞共享（并发 ensureIndex 只跑一次） */
    this._indexPromise = null;
    /** @type {Promise} 落盘串行链（并发 persist 各自排队再判脏，避免同一桶被重复整写） */
    this._persistChain = Promise.resolve();
    /** @type {Promise} 换桶串行链（并发 useBucket 排队，轮到时无变化即幂等早退） */
    this._useChain = Promise.resolve();
    /** @type {boolean} 串桶写入告警是否已发过（只发第一条，防逐块刷屏） */
    this._mismatchWarned = false;
  }

  // ── 索引加载与旧档迁移 ──────────────────────────────────────────────

  /**
   * 读回索引（幂等，共享在飞）。新索引不存在时尝试一次性迁移旧共享 blob 档。
   * @param {number} [defaultVk] 旧旧档（无 buckets 的顶层 ts/done/bound）归入哪个桶
   * @returns {Promise<boolean>} 是否已 indexLoaded
   */
  async ensureIndex(defaultVk) {
    if (this.indexLoaded) return true;
    if (this._indexPromise) return this._indexPromise;
    this._indexPromise = (async () => {
      let meta;
      try {
        meta = await storage.slot.get(SLOT_META);
      } catch (err) {
        // 命名空间未就绪（UID 未到）≠ 盘上没索引：留待下次重读，且绝不在此刻走迁移分支
        log.warn('index read failed (namespace not ready?), will retry. %s', err && err.message);
        this._indexPromise = null;
        return false;
      }
      if (meta && typeof meta === 'object') {
        this._applyIndex(meta, defaultVk);
        this.indexLoaded = true;
        log.info(
          'index loaded. buckets=%d cols=%d rows=%d',
          Object.keys(this.meta.buckets).length,
          this.meta.cols,
          this.meta.rows,
        );
        return true;
      }
      const res = await this._migrateLegacy();
      if (res === 'blocked') {
        this._indexPromise = null;
        return false;
      } // 迁移被 UID 挡住：不算就绪，下次重试
      this.indexLoaded = true;
      return true;
    })();
    return this._indexPromise;
  }

  /**
   * 把索引对象套进内存（还原 bound 的 Infinity 哨兵、补齐 count/round，兼容无 buckets 的旧旧档）。
   * @param {object} meta 索引产物
   * @param {number} [defaultVk] 顶层 ts/done/bound 形态时归入的桶
   */
  _applyIndex(meta, defaultVk) {
    defaultVk = defaultVk | 0;
    this.meta.cols = meta.cols || this.meta.cols;
    this.meta.rows = meta.rows || this.meta.rows;
    this.meta.mapType = meta.mapType || 0;
    this.meta.buckets = meta.buckets && typeof meta.buckets === 'object' ? meta.buckets : {};
    if (!Object.keys(this.meta.buckets).length && (meta.ts || meta.done || meta.bound)) {
      const bd = meta.bound && isFinite(meta.bound.minX) ? meta.bound : newBucketMeta().bound;
      this.meta.buckets[String(defaultVk)] = {
        ts: meta.ts || 0,
        done: !!meta.done,
        count: 0,
        round: 0,
        bound: bd,
      };
    }
    // 经 JSON 后 bound 的 Infinity 变 null，逐桶还原哨兵；缺项补默认
    for (const key of Object.keys(this.meta.buckets)) {
      const b = this.meta.buckets[key];
      if (!b || typeof b !== 'object') {
        this.meta.buckets[key] = newBucketMeta();
        continue;
      }
      if (!b.bound || !isFinite(b.bound.minX)) b.bound = newBucketMeta().bound;
      b.ts = b.ts | 0;
      b.done = !!b.done;
      b.count = b.count | 0;
      b.round = b.round | 0;
    }
  }

  /**
   * 旧格式一次性迁移：共享 data blob 里的 map.world.entities（含 vk 列的全量并行数组）+ map.world.meta
   * → 按 vk 切成 map.world.ent.<vk> 逐桶落独立键，再落索引，最后删旧 blob 键。
   * 顺序刻意如此：索引先落盘可保证本函数不被重复触发；删旧键失败只留孤儿，不影响新格式读取。
   * @returns {Promise<'migrated'|'empty'|'blocked'>}
   */
  async _migrateLegacy() {
    let legacyMeta, legacyEnt;
    try {
      legacyMeta = await storage.data.get(LEGACY_META);
      legacyEnt = await storage.data.get(LEGACY_ENT);
    } catch (err) {
      log.warn('legacy read blocked (namespace not ready?): %s', err && err.message);
      return 'blocked';
    }
    const n = legacyEnt && Array.isArray(legacyEnt.x) ? legacyEnt.x.length : 0;
    if (!n && !(legacyMeta && typeof legacyMeta === 'object')) return 'empty';
    const d = legacyEnt || null;
    // 按 vk 列分组（旧档无 vk 列时退按点自身 k，都无则 0）
    /** @type {Map<number, object>} */
    const groups = new Map();
    const COLS = [
      'x',
      'y',
      't',
      'it',
      'lv',
      'bd',
      'sd',
      'k',
      'oid',
      'aid',
      'pw',
      'ap',
      'ow',
      'ver',
    ];
    if (d) {
      const hasVk = Array.isArray(d.vk),
        hasK = Array.isArray(d.k);
      for (let i = 0; i < n; i++) {
        const vk = hasVk && d.vk[i] != null ? d.vk[i] | 0 : hasK && d.k[i] != null ? d.k[i] | 0 : 0;
        let g = groups.get(vk);
        if (!g) {
          g = { fmt: 8, cols: d.cols || this.meta.cols, rows: d.rows || this.meta.rows };
          for (const c of COLS) g[c] = Array.isArray(d[c]) ? [] : null;
          groups.set(vk, g);
        }
        for (const c of COLS) {
          const arr = g[c];
          if (arr) arr.push(d[c][i]);
        }
      }
    }
    this._applyIndex(legacyMeta && typeof legacyMeta === 'object' ? legacyMeta : {}, 0);
    // 逐桶写实体键；桶元信息补齐 count（沿用旧索引里的 ts/done/bound，若有）
    for (const [vk, g] of groups) {
      try {
        await storage.slot.set(SLOT_ENT_PFX + vk, g);
      } catch (err) {
        log.warn('legacy bucket %d write failed: %s', vk, err && err.message);
        continue;
      }
      const b = this.bucketMeta(vk);
      b.count = g.x.length;
      if (!b.ts && legacyMeta && legacyMeta.ts) b.ts = legacyMeta.ts | 0; // 旧旧档只有一个总时间戳，均摊给各桶免遭「建议重扫」
    }
    try {
      await storage.slot.set(SLOT_META, this._indexObject());
    } catch (err) {
      log.warn('legacy index write failed: %s', err && err.message);
      return 'blocked';
    }
    // 旧键清掉：共享 blob 从此不再背着地图全量点（其他 feat 的读写也随之瘦身）
    try {
      await storage.data.remove(LEGACY_ENT);
    } catch (err) {
      /* 孤儿键不影响新格式 */
    }
    try {
      await storage.data.remove(LEGACY_META);
    } catch (err) {
      /* 同上 */
    }
    log.info('legacy map data migrated. buckets=%d points=%d', groups.size, n);
    return 'migrated';
  }

  /** 当前索引的落盘形态（bound 的 Infinity 哨兵归一为 0 矩形，Infinity 无法 JSON 化） */
  _indexObject() {
    const buckets = {};
    for (const key of Object.keys(this.meta.buckets)) {
      const b = this.meta.buckets[key];
      buckets[key] = {
        ts: b.ts | 0,
        done: !!b.done,
        count: b.count | 0,
        round: b.round | 0,
        bound: isFinite(b.bound.minX) ? b.bound : { minX: 0, minY: 0, maxX: 0, maxY: 0 },
      };
    }
    return { cols: this.meta.cols, rows: this.meta.rows, mapType: this.meta.mapType, buckets };
  }

  // ── 桶的换入换出（懒加载入口）──────────────────────────────────────

  /**
   * 换入指定视角桶：索引未就绪先补读，旧驻留桶先落盘再从内存丢弃，然后只读目标桶的实体键。
   * 目标桶盘上无数据时也置为驻留（空桶承接新扫描）。并发调用排队，轮到时无变化即幂等早退。
   * @param {number} vk 视角桶服号（0=服号未知的桶）
   * @returns {Promise<boolean>} 是否从盘上读回了实体数据（false=该桶为空或索引未就绪）
   */
  useBucket(vk) {
    const target = vk | 0;
    this._useChain = this._useChain.then(
      () => this._useBucketNow(target),
      () => this._useBucketNow(target),
    );
    return this._useChain;
  }

  /** useBucket 的实际执行体（排队串行，见其注释） */
  async _useBucketNow(vk) {
    if (this.loadedVk === vk) return this.entities.size > 0;
    await this.ensureIndex(vk);
    if (!this.indexLoaded) {
      log.warn('index not ready, cannot load bucket %d', vk);
      return false;
    }
    if (this.loadedVk === vk) return this.entities.size > 0;
    if (this.loadedVk != null) {
      await this.persist(); // 旧桶脏数据先落盘（无变化则内部跳过）
      this.entities.clear(); // 再丢弃内存：全图不常驻，驻留量恒为一个桶
      this.marches.clear();
      this.loadedVk = null;
    }
    let d;
    try {
      d = await storage.slot.get(SLOT_ENT_PFX + vk);
    } catch (err) {
      log.warn('bucket %d read failed: %s', vk, err && err.message);
      return false;
    }
    this.loadedVk = vk; // 空桶也置驻留，让后续扫描可直接写入
    if (d && Array.isArray(d.x)) {
      this.deserialize(d, vk);
      log.info('bucket %d loaded. entities=%d', vk, this.entities.size);
    } else {
      log.info('bucket %d has no data on disk.', vk);
    }
    return this.entities.size > 0;
  }

  /**
   * 重定向驻留桶（仅供扫描首块「服号自愈」用：curK 从 0 改成应答回显的真实区号）。
   * 内存已有数据时拒绝——改标会让这批点串到别的桶键下。
   * @param {number} vk 目标视角桶服号
   * @returns {boolean} 是否重定向成功
   */
  retarget(vk) {
    const target = vk | 0;
    if (this.loadedVk == null) {
      this.loadedVk = target;
      return true;
    }
    if (this.loadedVk === target) return true;
    if (this.entities.size) return false;
    this.loadedVk = target;
    return true;
  }

  /** @returns {boolean} 指定桶是否已在内存 */
  isResident(vk) {
    return this.loadedVk === (vk | 0);
  }

  // ── 写入 ──────────────────────────────────────────────────────────

  /**
   * upsert 一条 901 归一后的实体点（game 坐标入口，内部转 cell），落入驻留桶。
   * @param {{x:number, y:number, pointType:number, v?:number, k?:number, id?:*}} p pointList 项（含 game x/y）
   * @param {number} [vk] 视角桶（采集时所在区）；缺省用点自身服号 p.k，都无则 0
   * @param {number} [rnd] 本轮轮次号（scanner.beginRound 发放；块内清扫的保留判据）
   * @returns {boolean} 是否发生写入（同桶同格同版本返回 false，但仍标记本轮已确认）
   */
  upsertPoint(p, vk, rnd) {
    if (!p || p.x == null || p.y == null || p.pointType == null) return false;
    // game → cell：x 奇归偶折半，y 透传（见 coord.gameToCell 同式，此处内联避免额外分配）
    const cellX = (p.x & 1 ? p.x - 1 : p.x) / 2;
    const cellY = p.y;
    const bucket = vk != null ? vk : p.k != null ? p.k : 0;
    // 单桶驻留不变量：未驻留桶的数据不在内存里，写进去会串桶。业务层扫描前已 ensureBucket，
    // 真走到这里只可能是竞态/自愈改号，未驻留时接管（loadedVk=null 说明是首轮直接写）。
    if (this.loadedVk == null) this.loadedVk = bucket;
    else if (this.loadedVk !== bucket) {
      if (!this._mismatchWarned) {
        this._mismatchWarned = true;
        log.warn(
          'point for bucket %d dropped (resident=%d): bucket not loaded.',
          bucket,
          this.loadedVk,
        );
      }
      return false;
    }
    const idx = cellToIndex(cellX, cellY, this.meta.cols);
    const key = bucket + ':' + idx;
    const v = p.v == null ? 0 : p.v;
    // 从子对象抽取 itemId/level/bid/shield（首个命中为准），供子类/等级筛选与详情、护盾过滤用
    let itemId = null,
      level = null,
      bid = null,
      shield = null;
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
    if (
      prev &&
      prev.v === v &&
      prev.pointType === p.pointType &&
      prev.itemId === itemId &&
      prev.level === level &&
      prev.bid === bid &&
      prev.shield === shield
    ) {
      if (rnd != null) prev.rnd = rnd; // 同版本去重跳过，但仍算「本轮再确认」，不被块内清扫误删
      return false;
    }
    const own = extractOwner(p);
    const now = Date.now();
    this.entities.set(key, {
      cellIndex: idx,
      vk: bucket,
      cellX,
      cellY,
      pointType: p.pointType,
      itemId,
      level,
      bid,
      shield,
      oid: own.oid,
      aid: own.aid,
      power: own.power,
      army: own.army,
      oname: own.name,
      v,
      k: p.k,
      rnd,
      ts: now,
      id: p.id,
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
    if (mapType && mapType !== this.meta.mapType) {
      this.meta.mapType = mapType;
      this.dirty = true;
    }
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
      b = newBucketMeta();
      this.meta.buckets[key] = b;
    }
    return b;
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
   * 块内清扫：删驻留桶中落在指定 cell 矩形内、且本轮未被重新确认（rnd !== keepRound）的实体。
   * 调用时机：该块新数据写入之后（块矩形并集=全图，逐块扫完即全桶更新完毕）。
   * 邻块重叠带回的本轮新点 rnd 相同，不会被误删。
   * 因内存只驻留一个桶，这里遍历的就是该桶本身——开销随桶大小而非全图增长。
   * @param {number} vk 视角桶服号
   * @param {number} cx0 块左上 cell x（含）
   * @param {number} cy0 块左上 cell y（含）
   * @param {number} cw 块宽（cell，右缘不含）
   * @param {number} ch 块高（cell，下缘不含）
   * @param {number} keepRound 保留的轮次号（本轮）
   * @returns {number} 清扫条数
   */
  purgeRange(vk, cx0, cy0, cw, ch, keepRound) {
    if (this.loadedVk !== (vk | 0)) return 0; // 非驻留桶：内存里本就没有它的数据，无可清扫
    const cx1 = cx0 + cw,
      cy1 = cy0 + ch;
    let n = 0;
    for (const [key, e] of this.entities) {
      if (e.rnd === keepRound) continue; // 本轮已写/已再确认
      if (e.cellX >= cx0 && e.cellX < cx1 && e.cellY >= cy0 && e.cellY < cy1) {
        this.entities.delete(key); // 迭代中删 Map 条目安全
        n++;
      }
    }
    if (n) this.dirty = true;
    return n;
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
    if (this.loadedVk !== (vk | 0)) return; // 非驻留桶不记覆盖度（数据也不在内存）
    const b = this.bucketMeta(vk).bound;
    if (cx < b.minX) b.minX = cx;
    if (cx + cw > b.maxX) b.maxX = cx + cw;
    if (cy < b.minY) b.minY = cy;
    if (cy + ch > b.maxY) b.maxY = cy + ch;
    this._dirtyBuckets.add(String(vk));
    this.dirty = true;
  }

  // ── 读取/查询 ─────────────────────────────────────────────────────

  /**
   * 实体数：驻留桶走内存真值，其他桶读索引里的 count（不触发任何实体读盘）。
   * @param {number} [vk] 视角桶服号；不传=当前驻留桶的内存数
   * @returns {number}
   */
  size(vk) {
    if (vk == null) return this.entities.size;
    const b = vk | 0;
    if (this.loadedVk === b) return this.entities.size;
    const m = this.meta.buckets[String(b)];
    return m ? m.count | 0 : 0;
  }

  /**
   * 取某桶某格的实体（跳转 z 参用：拿点自身服号 k）。非驻留桶返回 undefined（内存里没有）。
   * @param {number} vk 视角桶服号
   * @param {number} cellX
   * @param {number} cellY
   * @returns {TileEntity|undefined}
   */
  pointAt(vk, cellX, cellY) {
    if (this.loadedVk !== (vk | 0)) return undefined;
    return this.entities.get(vk + ':' + cellToIndex(cellX, cellY, this.meta.cols));
  }

  /**
   * 某桶落盘数据是否新鲜（在 TTL 内）。判据来自索引，无需读实体。
   * @param {number} vk 视角桶服号
   * @param {number} ttlHours 有效期小时
   * @returns {boolean}
   */
  isFresh(vk, ttlHours) {
    const b = this.meta.buckets[String(vk)];
    if (!b || !b.ts || b.ts <= 0) return false;
    return Date.now() - b.ts < (ttlHours || 24) * 3600 * 1000;
  }

  // ── 序列化 ────────────────────────────────────────────────────────

  /**
   * 紧凑序列化当前驻留桶：实体拆 x/y/t/it/lv/bd/sd/k/oid/aid/pw/ap/ow/ver 等长数组（比逐对象小一个量级）。
   * fmt:8 = 单桶档（不再存 vk 列，视角桶由存储键 map.world.ent.<vk> 承载）。
   * @returns {object} 可 JSON 化的紧凑对象
   */
  serialize() {
    const x = [],
      y = [],
      t = [],
      it = [],
      lv = [],
      bd = [],
      sd = [],
      k = [],
      oid = [],
      aid = [],
      pw = [],
      ap = [],
      ow = [],
      ver = [];
    for (const e of this.entities.values()) {
      x.push(e.cellX);
      y.push(e.cellY);
      t.push(e.pointType);
      it.push(e.itemId == null ? null : e.itemId);
      lv.push(e.level == null ? null : e.level);
      ver.push(e.v);
      bd.push(e.bid == null ? null : e.bid);
      sd.push(e.shield == null ? null : e.shield);
      k.push(e.k == null ? null : e.k);
      oid.push(e.oid == null ? null : e.oid);
      aid.push(e.aid == null ? null : e.aid);
      pw.push(e.power == null ? null : e.power);
      ap.push(e.army == null ? null : e.army);
      ow.push(e.oname == null ? null : e.oname);
    }
    return {
      fmt: 8,
      cols: this.meta.cols,
      rows: this.meta.rows,
      x,
      y,
      t,
      it,
      lv,
      bd,
      sd,
      k,
      oid,
      aid,
      pw,
      ap,
      ow,
      ver,
    };
  }

  /**
   * 从紧凑对象还原实体到内存（覆盖现有）。缺列的旧 fmt 降级 null。
   * @param {object} d serialize() 产物（或迁移期的旧全量档，此时按 vk 列只取属于本桶的行）
   * @param {number} vk 归入的视角桶服号
   */
  deserialize(d, vk) {
    if (!d || !Array.isArray(d.x)) return;
    this.entities.clear();
    const bucket = vk | 0;
    const cols = d.cols || this.meta.cols;
    const hasAttr = Array.isArray(d.it) || Array.isArray(d.lv);
    const hasOwner = Array.isArray(d.oid);
    const hasBid = Array.isArray(d.bd);
    const hasShield = Array.isArray(d.sd);
    const hasK = Array.isArray(d.k);
    const hasVk = Array.isArray(d.vk); // 仅迁移路径会出现：按桶过滤行，跳过不属于本桶的
    for (let i = 0; i < d.x.length; i++) {
      if (hasVk && (d.vk[i] | 0) !== bucket) continue;
      const cellX = d.x[i],
        cellY = d.y[i],
        pointType = d.t[i],
        v = d.ver ? d.ver[i] : 0;
      const itemId = hasAttr && d.it ? (d.it[i] == null ? null : d.it[i]) : null;
      const level = hasAttr && d.lv ? (d.lv[i] == null ? null : d.lv[i]) : null;
      const bid = hasBid ? (d.bd[i] == null ? null : d.bd[i]) : null;
      const shield = hasShield ? (d.sd[i] == null ? null : d.sd[i]) : null;
      const k = hasK ? (d.k[i] == null ? null : d.k[i]) : null;
      const oid = hasOwner ? (d.oid[i] == null ? null : d.oid[i]) : null;
      const aid = hasOwner ? (d.aid && d.aid[i] != null ? d.aid[i] : null) : null;
      const power = hasOwner ? (d.pw && d.pw[i] != null ? d.pw[i] : null) : null;
      const army = hasOwner && d.ap ? (d.ap[i] == null ? null : d.ap[i]) : null; // 旧档无 ap 列→兵力降级 null（重扫后补齐）
      const oname = hasOwner ? (d.ow && d.ow[i] != null ? d.ow[i] : null) : null;
      const idx = cellToIndex(cellX, cellY, cols);
      this.entities.set(bucket + ':' + idx, {
        cellIndex: idx,
        vk: bucket,
        cellX,
        cellY,
        pointType,
        itemId,
        level,
        bid,
        shield,
        k,
        oid,
        aid,
        power,
        army,
        oname,
        v,
      });
    }
  }

  // ── 落盘 ──────────────────────────────────────────────────────────

  /**
   * 异步落盘（排队串行）：只写当前驻留桶的实体键 + 索引键，两者都是小载荷。
   * @param {boolean} [force] 忽略脏标记强制写
   * @returns {Promise<void>}
   */
  persist(force) {
    this._persistChain = this._persistChain.then(
      () => this._persistOnce(force),
      () => this._persistOnce(force),
    );
    return this._persistChain;
  }

  /** persist 的实际执行体（轮到本次才判脏，故并发的两笔 persist 不会重复整写同一个桶） */
  async _persistOnce(force) {
    if (!this.indexLoaded) return; // 索引未读回 = 盘上情况未知，此时写回会覆掉已有桶表（见文件头铁律）
    if (!this.dirty && !force) return;
    const now = Date.now();
    for (const key of this._dirtyBuckets) {
      const b = this.meta.buckets[key];
      if (b) b.ts = now;
    }
    // 驻留桶的点数写进索引：未驻留的桶也能在面板显示「已存 N 点」，不必读实体。
    // 条件是「有数据」或「索引里本来就有这个桶」——刚被 clearBucket 删掉条目的空桶不能再建回去，
    // 否则面板会把「已清空」显示成「有数据时间」。
    if (this.loadedVk != null && (this.entities.size || this.meta.buckets[String(this.loadedVk)])) {
      this.bucketMeta(this.loadedVk).count = this.entities.size;
    }
    const vk = this.loadedVk;
    try {
      if (vk != null) await storage.slot.set(SLOT_ENT_PFX + vk, this.serialize()); // 实体先落，索引带准确 count 后落
      await storage.slot.set(SLOT_META, this._indexObject());
      this.dirty = false;
      this._dirtyBuckets.clear();
      log.info(
        'persisted. vk=%s entities=%d buckets=%d',
        vk,
        this.entities.size,
        Object.keys(this.meta.buckets).length,
      );
    } catch (err) {
      log.warn('persist failed: %s', err && err.message);
    }
  }

  // ── 清理 ──────────────────────────────────────────────────────────

  /**
   * 清空内存全部点位/行军与索引（尺寸保留，不动配置，也不碰盘）。
   * @returns {void}
   */
  clear() {
    this.entities.clear();
    this.marches.clear();
    this.meta.buckets = {};
    this.loadedVk = null;
    this.dirty = false;
    this._dirtyBuckets.clear();
  }

  /**
   * 只清某个视角桶：删该桶实体键与索引条目；若正是驻留桶则一并清内存（保持驻留以承接重扫）。
   * @param {number|string} vk 视角桶服号
   * @returns {number} 删除的内存实体数（非驻留桶返回索引里的历史 count）
   */
  clearBucket(vk) {
    const b = vk | 0;
    const key = String(b);
    const m = this.meta.buckets[key];
    let n;
    if (this.loadedVk === b) {
      n = this.entities.size;
      this.entities.clear();
      this.marches.clear();
    } else {
      n = m ? m.count | 0 : 0;
    }
    delete this.meta.buckets[key];
    this._dirtyBuckets.delete(key);
    this.dirty = true;
    Promise.resolve(storage.slot.remove(SLOT_ENT_PFX + b)).catch((err) =>
      log.warn('drop bucket %d failed: %s', b, err && err.message),
    );
    return n;
  }

  /**
   * 清空内存 + 删除全部落盘数据（索引 + 所有已知桶的实体键）。
   * 清后把 indexLoaded 打回 false，下次 useBucket 重新走一遍加载流程。
   * @returns {Promise<void>}
   */
  async clearPersisted() {
    const vks = Object.keys(this.meta.buckets);
    if (this.loadedVk != null && vks.indexOf(String(this.loadedVk)) === -1)
      vks.push(String(this.loadedVk));
    this.clear();
    try {
      for (const s of vks) await storage.slot.remove(SLOT_ENT_PFX + s);
      await storage.slot.remove(SLOT_META);
      this.indexLoaded = false;
      this._indexPromise = null;
      log.info('cleared all buckets (memory + disk). buckets=%d', vks.length);
    } catch (err) {
      log.warn('clear persist failed: %s', err && err.message);
    }
  }
}

/** @type {MapStore} 单例（扫图与渲染共享同一份运行态） */
export const mapStore = new MapStore();
