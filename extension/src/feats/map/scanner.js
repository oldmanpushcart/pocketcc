/**
 * 雷达扫图主控：把全图切成块、按蛇形逐块发 901、解析 pointList 入库、控节奏防限流。
 * 复用 core/drain（串行 + 条间休眠 + alive 闸门）——本器只提供 queue/process/interval/alive，
 * 节奏与单飞由 drain 兜底。红线：只发 901 拉数据（只读+发包），不改写游戏任何状态。
 *
 * 坐标口径：块矩形用 game 坐标（901 请求体 x/y/width/height 即 game 格数，见实录 §1「载荷坐标」）；
 * 蛇形推进 = 行内向东、隔行反向，逐行向南（与实录走位一致，天然减少相邻窗重叠）。
 * 服号 k：优先用调用方注入值，缺（0）则以首块应答回显的 k 兜底复用（serverId() 取不到时的自愈）。
 */
import { createLog } from '../../core/log.js';
import { createDrain } from '../../core/drain.js';
import { worldMap } from '../../core/game-api.js';
import { CMD_GET_WORLD_INFO, SERVER, SCAN_GRID } from './map-meta.js';
import { mapStore } from './store.js';

/** @type {ReturnType<createLog>} 模块日志器（tag=SCANNER） */
const log = createLog('SCANNER');

/** @type {number} 901 视口层级（高度）默认值：可被 cfg.viewLevel 覆盖（面板/工具栏 0~4 可调） */
const VIEW_LEVEL = 1;

/** @type {Array<object>} 待扫块队列（drain 逐条 shift） */
var queue = [];
/** @type {boolean} 扫描开关（drain alive 读它；stop 置否让当前循环在下一边界收手） */
var running = false;
/** @type {number} 已处理块数（进度分子） */
var doneCount = 0;
/** @type {number} 本轮总块数（进度分母） */
var totalCount = 0;
/** @type {number} 本轮生效的服务器号 k（start 时定，0 则首块应答兜底） */
var curK = 0;
/** @type {number} 本轮子服号 rid（v1 恒 0=本服主体） */
var curRid = 0;
/** @type {number} 本轮轮次号（store.beginRound 发放；块内清扫据此保留本轮已确认点） */
var curRound = 0;
/** @type {object|null} reactor ctx（取 net 底座） */
var ctxRef = null;
/** @type {object} 当前配置（start 注入，interval 热读 dwell/jitter） */
var cfg = { dwellMs: 2200, jitterMs: 500, viewLevel: VIEW_LEVEL };
/** @type {object} 生命周期钩子（onBlock/onProgress/onDone） */
var hooks = {};

/**
 * JSON.parse 兜底（901 应答 ret.data 可能是 JSON 字符串，也可能已是对象）
 * @param {*} s
 * @returns {*}
 */
function safeParse(s) {
  if (typeof s !== 'string' || !s) return s;
  try { return JSON.parse(s); } catch (e) { return s; }
}

/**
 * 扫描网格维度：定标固定格（见 map-meta.SCAN_GRID），不再按面板块尺寸均分全图。
 * 保留函数签名供旧调用点使用。
 * @returns {{nx:number, ny:number}}
 */
export function gridDims() {
  return { nx: SCAN_GRID.nx, ny: SCAN_GRID.ny };
}

/**
 * 构造块队列（定标固定格 SCAN_GRID）：每块同时携带 game 矩形（901 请求用）与 cell 矩形（渲染/高亮用）。
 * 缺省蛇形推进 = 行内向东、隔行反向，逐行向南；
 * 给定 startBlock{i,j} 则从该块**继续按蛇形顺序往下扫**：队列旋转到该块起始，
 * 扫到图尾后绕回地图开头补齐它之前的块（蛇形逐行邻接，推进天然连续）。
 * @param {{i:number,j:number}|null} [startBlock] 起扫块网格下标
 * @returns {object[]} 块数组（顺序即扫描顺序）
 */
export function buildBlockQueue(startBlock) {
  const { nx, ny, gw, gh, offY } = SCAN_GRID;
  const out = [];
  let order = 0;
  for (let j = 0; j < ny; j++) {
    for (let c = 0; c < nx; c++) {
      const i = (j & 1) ? nx - 1 - c : c;
      const gx = i * gw, gy = offY + j * gh; // 顶对齐：行网格从 y=0 起，仅末行探出图底（向外 padding，渲染层完整绘制）
      out.push({
        i, j, gx, gy, gw, gh,
        cx0: gx / 2, cy0: gy, cw: gw / 2, ch: gh, // cell 矩形（x 折半；末行 cy0+ch 可超图底，purge/touch 与图内点取交安全）
        order: order++,
      });
    }
  }
  if (startBlock && Number.isFinite(startBlock.i) && Number.isFinite(startBlock.j)) {
    const i0 = Math.max(0, Math.min(nx - 1, startBlock.i | 0));
    const j0 = Math.max(0, Math.min(ny - 1, startBlock.j | 0));
    // 蛇形队列旋转到起扫块：从它接着往下扫，图尾绕回开头补齐剩余块（总量不变，进度仍全程）
    const k = out.findIndex((blk) => blk.i === i0 && blk.j === j0);
    if (k > 0) {
      const rot = out.slice(k).concat(out.slice(0, k));
      for (let n = 0; n < rot.length; n++) rot[n].order = n;
      return rot;
    }
  }
  return out;
}

/**
 * 单块处理：发 901 → 解析入库 → 点亮钩子 → 周期落盘。永不 reject（异常吞掉，drain 继续下一块）。
 * @param {object} b 块矩形
 * @returns {Promise<void>}
 */
async function processBlock(b) {
  const net = ctxRef && ctxRef.net;
  if (!net) return;
  // 901 的 (x,y) 是「回点区中心」（实证：窗口以 (x,y) 为心、y 向 ±39.2 / x 向 ±58.4，y 向不随请求 height 放大）。
  // 网格已按该窗口定标（SCAN_GRID）：请求给格中心 + 格尺寸，回点窗恰好盖住本格（余量 0.4~2.3），不再外扩。
  const rx = Math.max(0, Math.min(SERVER.gameXMax, Math.round(b.gx + b.gw / 2)));
  const ry = Math.max(0, Math.min(SERVER.gameYMax, Math.round(b.gy + b.gh / 2)));
  const rw = Math.ceil(b.gw);
  const rh = Math.ceil(b.gh);
  const body = {
    x: rx, y: ry, k: curK, rid: curRid,
    width: rw, height: rh, marchInfo: true, viewLevel: cfg.viewLevel | 0,
  };
  let ret;
  try {
    ret = await net.send(CMD_GET_WORLD_INFO, body);
  } catch (err) {
    log.warn('block(%d,%d) send failed: %s', b.gx, b.gy, err && err.message);
    return;
  }
  if (!ret || !ret.ok) {
    log.warn('block(%d,%d) not ok. code=%s', b.gx, b.gy, ret && ret.code);
    return;
  }
  const data = safeParse(ret.data) || {};
  // 服号自愈：开局视角号取到 0 时，用应答回显的 k 补上，后续块沿用（桶标同用 curK，轮次改发）。
  // 换桶号需驻留桶内存为空才允许（retarget）——否则已入库的点会算到另一个桶键下；
  // 不允许就沿用 0 桶继续，宁可桶号不精确，也不能让本批数据被单桶驻留守卫丢弃。
  if (!curK && data.k) {
    const healK = data.k | 0;
    if (mapStore.retarget(healK)) { curK = healK; curRound = mapStore.beginRound(curK); }
  }
  const list = Array.isArray(data.pointList) ? data.pointList : [];
  let added = 0;
  for (const p of list) if (mapStore.upsertPoint(p, curK, curRound)) added++;
  // 行军仅存关键项（marchId 恒字符串，>2^53 禁 Number）
  const marches = Array.isArray(data.marchList) ? data.marchList : [];
  if (marches.length) {
    for (const m of marches) {
      if (m && m.marchId != null) mapStore.upsertMarch(String(m.marchId), (m.begin && m.begin.bx) | 0, (m.begin && m.begin.by) | 0);
    }
  }
  mapStore.touchBlock(curK, b.cx0, b.cy0, b.cw, b.ch);
  // 块内精确更新：新数据写入后，清掉本块矩形内「本轮未被重新确认」的老数据（迁城/采空/打败的残留）。
  // 邻块重叠带里本轮已扫的新点轮次号相同不会误删；块请求失败时早退，不清不写老数据保持原样。
  mapStore.purgeRange(curK, b.cx0, b.cy0, b.cw, b.ch, curRound);
  doneCount++;
  if (hooks.onBlock) { try { hooks.onBlock(b, added, doneCount, totalCount); } catch (e) { } }
  if (hooks.onProgress) { try { hooks.onProgress(doneCount, totalCount); } catch (e) { } }
  // 周期落盘：每 10 块一次（只序列化当前驻留桶，开销随桶长而非全图长）
  if (doneCount % 10 === 0) Promise.resolve(mapStore.persist()).catch(() => { });
  if (doneCount >= totalCount) finish();
}

/** 收尾：标本桶 done、落盘、触发 onDone、复位开关 */
function finish() {
  mapStore.markDone(curK);
  Promise.resolve(mapStore.persist(true)).catch(() => { });
  running = false;
  if (hooks.onDone) { try { hooks.onDone(); } catch (e) { } }
  log.info('scan round done. k=%s blocks=%d entities=%d', curK, doneCount, mapStore.size(curK));
}

/** @type {{consume:Function}} drain 消费器（queue/alive/process/interval 全部热读本模块状态） */
const drain = createDrain({
  log,
  queue: { get: () => queue },
  alive: () => running,
  process: processBlock,
  interval: () => cfg.dwellMs + Math.floor(Math.random() * Math.max(0, cfg.jitterMs | 0)),
});

/**
 * 启动一轮扫描（幂等：已在跑则忽略）。重建队列、定服号、置 running、kick drain。
 * @param {object} ctx reactor 上下文（取 net）
 * @param {object} conf {dwellMs, jitterMs, k, rid, startBlock}
 * @param {object} [hk] {onBlock, onProgress, onDone}
 * @returns {boolean} 是否真正启动
 */
export function start(ctx, conf, hk) {
  if (running) return false;
  ctxRef = ctx;
  hooks = hk || {};
  cfg = Object.assign({}, cfg, conf || {});
  curK = (conf && conf.k) || worldMap.viewServerId() || worldMap.serverId() || 0;
  curRid = (conf && conf.rid) || 0;
  curRound = mapStore.beginRound(curK);
  queue = buildBlockQueue(conf && conf.startBlock);
  totalCount = queue.length;
  doneCount = 0;
  running = true;
  log.info('scan start. blocks=%d k=%s dwell=%dms', totalCount, curK, cfg.dwellMs);
  drain.consume(); // fire-and-forget，进度经 hooks/bus 上报
  return true;
}

/**
 * 停止扫描（当前在飞请求收不回，队列清空即自然收手）。停止时补一次落盘保留已扫数据。
 * @returns {void}
 */
export function stop() {
  if (!running) return;
  running = false;
  queue = [];
  Promise.resolve(mapStore.persist(true)).catch(() => { });
  log.info('scan stopped. done=%d/%d', doneCount, totalCount);
}

/** @returns {boolean} 是否正在扫描 */
export function isRunning() { return running; }

/** @returns {{done:number, total:number, running:boolean}} 进度快照（overlay 轮询/事件用） */
export function progress() { return { done: doneCount, total: totalCount, running }; }

/** @returns {number} 本轮生效的服务器号 k（跳转时复用，0=未定） */
export function currentK() { return curK; }

/**
 * 热设视口层级（高度）：不改队列，仅影响后续块的 901 viewLevel（下一块即生效）。
 * @param {number} lv 0~4
 */
export function setViewLevel(lv) {
  cfg.viewLevel = Math.max(0, Math.min(4, lv | 0));
}
