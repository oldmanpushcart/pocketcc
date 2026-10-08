/**
 * 全局地图 feat（reactor 说明书形态）：把 map 子模块编排成一个功能——
 *   overlay（浮层壳 + MapView）｜scanner（雷达扫图）｜store（运行态 + 分桶持久化）｜terrain（色块底图）。
 *
 * 交互模型：面板启用 → install 建浮层、挂 Ctrl+M 热键（**不读实体数据**）；
 *   浮层第一次打开 → 懒加载当前视角桶（只读本区那一片，落盘数据再大也不占内存）；
 *   浮层「开始扫描」→ scanner 建蛇形块队列、drain 串行发 901 逐块入库、点亮雷达块并更新进度；
 *   中途/扫完落盘（按视角桶分键，UID 命名空间下的独立键，跨浏览器刷新复用）。
 *
 * 内存纪律：store 同一时刻只驻留**一个**视角桶。视角切区时先把旧桶落盘、再从内存丢弃，
 *   然后只读入新区的桶——切区/开图都不会让全图数据累积在内存里。
 *
 * 门控：scenes:['NWorldMap']——扫图（发 901）严格 gate 在世界地图态（非地图态发 901 是否受理未实证，见方案「待验证」）；
 *   浮层本身是辅助 UI，install 不受门控、可在任意场景展示已存数据；扫描动作另用 ctx.alive() 兜一道。
 * 红线：只发 901 拉数据 + 只调游戏原生导航（nav.flyTo），不改写游戏本地数据。
 */
import { createLog } from '../../core/log.js';
import { reactor } from '../../core/reactor.js';
import { storage } from '../../core/storage.js';
import { worldMap, gameData } from '../../core/game-api.js';
import { MapOverlay } from './map-overlay.js';
import { mapStore } from './store.js';
import { getTerrainBase } from './terrain.js';
import * as scanner from './scanner.js';
import { DEFAULTS, FILTER_TREE, SERVER, SCAN_GRID, classifyPoint, playerPass } from './map-meta.js';

/** @type {ReturnType<createLog>} 模块日志器（tag=GLOBALMAP） */
const log = createLog('GLOBALMAP');

/** @type {string} 浮层几何存储键（UID 命名空间下） */
const GEOM_KEY = 'pocketcc.map.geom';

/** @type {object|null} reactor 上下文 */
var ctxRef = null;
/** @type {MapOverlay|null} 浮层实例 */
var overlay = null;
/** @type {boolean} install 幂等守卫 */
var installed = false;
/** @type {object} 模块配置（configure 推入） */
var cfg = Object.assign({}, DEFAULTS, { subs: DEFAULTS.subs.slice() });
/** @type {number} 当前视角桶服号（0=未知） */
var lastVk = 0;
/** @type {?number} 可见期视角轮询定时器（兜底：SERVER_VIEW_CHANGE 常量取不到/事件漏收） */
var pollTimer = null;
/** @type {?number} 护盾过滤激活期的实体重建定时器（每分钟重判跨档） */
var shieldTimer = null;
/** @type {?{i:number,j:number}} 起扫块（右键选中，扫描从该块环扩；null=全图蛇形） */
var startBlock = null;
/** @type {number} 列表刷新节流时戳 */
var listThrottleT = 0;
/** @type {boolean} 是否已成功懒加载过至少一次（未成功前每次开浮层都重试，UID 未到等不算成功） */
var dataBooted = false;
/** @type {number} 换桶请求世代号（加载期间又切区时，只认最后一次的结果） */
var loadSeq = 0;

/**
 * 当前视角桶：优先游戏实时视角号（盟决/观战/切区时为被看区），回退在飞扫描服号。
 * @returns {number} 0=未知
 */
function activeVk() {
  return (worldMap.viewServerId && worldMap.viewServerId()) || scanner.currentK() || 0;
}

/**
 * 该驻留哪个桶：视角区 → 本服号 → 0（与 scanner.start 的取号顺序一致，扫/读同源）。
 * @returns {number}
 */
function targetVk() {
  return activeVk() || (worldMap.serverId && worldMap.serverId()) || 0;
}

/**
 * 按桶刷新进度/状态文案（数据时间/新鲜度均为当前区口径）。
 * @param {number} vk 视角桶
 */
function refreshBucket(vk) {
  if (!overlay) return;
  const total = scanner.progress().total;
  const running = scanner.isRunning();
  const bm = mapStore.bucketMeta(vk || 0);
  const n = mapStore.size(vk || 0);
  overlay.setProgress({ done: bm.done ? (total || 0) : 0, total: total || 0, running }, `已存 ${n} 点`);
  if (running) overlay.setStatus(`扫描中 · 已存 ${n} 点`);
  else if (bm.ts) overlay.setStatus(`区 ${vk || '?'} 数据时间 ` + new Date(bm.ts).toLocaleString() + (mapStore.isFresh(vk || 0, cfg.ttlHours) ? '' : ' · 建议重扫'));
  else overlay.setStatus(vk ? '本区尚无数据，点「开始扫描」' : '尚无数据，点「开始扫描」');
}

/**
 * 应用视角桶：渲染过滤/区号徽标/筛选重放/状态刷新一体（切区与初始化共用入口）。
 * @param {number} vk 视角桶服号（0=不过滤降级）
 */
function applyView(vk) {
  lastVk = vk | 0;
  if (!overlay) return;
  if (overlay.view) {
    overlay.view.setActiveVk(lastVk || null);
    overlay.view.setClassifyCtx(classifyCtx());
    overlay.view.setFilter(new Set(cfg.subs), !!cfg.showOther);
    overlay.view.markEntitiesDirty();
  }
  overlay.setServerBadge(lastVk);
  refreshBucket(lastVk);
  refreshList();
}

/**
 * 视角切区：与当前桶不同才动作；在飞扫描先停（扫描目标已不是视角区）。
 * 切区即换桶：先切视图（徽标/状态立刻跟手），再把新区换入内存（旧桶落盘后丢弃）。
 * @param {number} k 新区服号
 */
function onViewChange(k) {
  const nk = Number(k) || 0;
  if (nk === lastVk) return;
  if (scanner.isRunning()) {
    scanner.stop();
    if (overlay) { overlay.setProgress(scanner.progress(), `已存 ${mapStore.size(nk)} 点`); overlay.toast('已切区，扫描停止'); }
  }
  applyView(nk);
  if (overlay) overlay.toast(nk ? '视角切到 区 ' + nk : '视角服号未知，维持当前已载入区的数据');
  // 服号未知（0）时不去读空桶：继续用已驻留的那片，避免画面突然打空
  if (dataBooted && nk) ensureBucket(nk);
}

/** 可见期视角轮询（2s）：面板开着时才能看见地图，此刻才需跟随 */
function startVkPoll() {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    try { const vk = activeVk(); if (vk && vk !== lastVk) onViewChange(vk); } catch (e) { }
  }, 2000);
}
/** 停轮询 */
function stopVkPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

/** 护盾过滤激活期：每分钟重建实体缓存（护盾随时间流逝跨档，否则筛出的「剩余 ≤ 阈值」会僵住不更新）。 */
function startShieldTimer() {
  if (shieldTimer) return;
  shieldTimer = setInterval(() => {
    if (!overlay || !overlay.view) return;
    overlay.view.markEntitiesDirty();
    refreshList();
  }, 60000);
}
/** 停护盾重建定时器 */
function stopShieldTimer() { if (shieldTimer) { clearInterval(shieldTimer); shieldTimer = null; } }

/**
 * 刷新右侧坐标列表（仅列表展开时工作）：当前桶实体套用与渲染层同一套图例/归属过滤，
 * 按写入时间新→旧取前 500 条推给 overlay。
 */
function refreshList() {
  if (!overlay || !overlay.isListOpen() || !overlay.view) return;
  const view = overlay.view;
  const vk = lastVk || 0;
  const subs = view.enabledSubs;
  const cx1 = classifyCtx();
  const ownerMode = view.ownerMode;
  const shieldMode = view.shieldMode;
  const shieldMs = view.shieldMs;
  const levelMin = view.levelMin;
  const now = Date.now();
  const out = [];
  let total = 0;
  for (const e of mapStore.entities.values()) {
    const evk = e.vk != null ? e.vk : (e.k != null ? e.k : 0);
    if (vk && evk !== vk) continue;
    if (!playerPass(e, { shieldMode, shieldMs, levelMin }, now)) continue; // 玩家筛选：护盾有/无+剩余上限 & 等级≥（未开启全放）
    const sub = classifyPoint(e, cx1);
    let color, label;
    if (sub) {
      if (subs && !subs.has(sub.key)) continue;
      color = sub.color; label = sub.label;
    } else {
      if (!view.showOther) continue;
      color = '#8a93a6'; label = '类型 ' + e.pointType;
    }
    if (ownerMode !== 'all') { // 与 render._rebuildEntities 同一套归属判定
      const owned = e.oid != null && e.oid !== 0;
      let cls;
      if (owned && e.oid === view.selfPid) cls = 'self';
      else if (e.aid != null && view.selfAid && e.aid === view.selfAid) cls = 'ally';
      else if (owned) cls = 'enemy';
      else cls = 'none';
      if (cls !== ownerMode) continue;
    }
    total++;
    out.push({ cx: e.cellX, cy: e.cellY, k: e.k != null ? e.k : vk, color, name: e.oname || label, sub: label, cross: !!(vk && e.k != null && e.k !== vk), ts: e.ts || 0, pt: e.pointType, shield: e.shield || 0, lv: e.level == null ? null : e.level, power: e.power == null ? null : e.power, army: e.army == null ? null : e.army });
  }
  out.sort((a, b) => b.ts - a.ts || a.cx - b.cx || a.cy - b.cy);
  overlay.renderList(out.slice(0, 500), total);
}

/** 扫描推进中的节流版（≥600ms 一次，避免逐块重建列表 DOM） */
function refreshListThrottled() {
  const now = Date.now();
  if (now - listThrottleT < 600) return;
  listThrottleT = now;
  refreshList();
}

/**
 * 细分类归属判定基准（供 view.setClassifyCtx）：本服服号用 worldMap.serverId，回退在飞扫描 currentK。
 * 均为 Number（pid/aid 不可 |0 截断）。
 * @returns {{selfPid:number, selfAid:number, selfServer:number}}
 */
function classifyCtx() {
  return { selfPid: gameData.myPid(), selfAid: gameData.myAid(), selfServer: (worldMap.serverId && worldMap.serverId()) || scanner.currentK() || 0 };
}

/** 铺色块底图（地形符号就绪后调用；缺失降级纯色，仍显实体） */
function buildTerrainBase() {
  if (!overlay) return;
  const tb = getTerrainBase();
  tb.build((cv) => { if (overlay) overlay.setTerrain(cv); });
}

/**
 * 懒加载：把指定视角桶换入内存（store 内单桶驻留——旧桶先落盘再丢弃，只读目标桶那一片），
 * 完成后应用视图。加载是异步的，用世代号丢弃「加载期间又切了区」的迟到结果。
 * @param {number} vk 视角桶服号
 * @returns {Promise<void>}
 */
function ensureBucket(vk) {
  const bvk = vk | 0;
  const seq = ++loadSeq;
  if (overlay) overlay.setStatus(`正在载入 ${bvk ? '区 ' + bvk : '本区'} 数据…`);
  return mapStore.useBucket(bvk).then(() => {
    if (seq !== loadSeq || !overlay) return;                 // 期间又切区，本次作废（最后一次会自己收尾）
    const view = overlay.view;
    if (view) {
      view.cols = mapStore.meta.cols || view.cols;           // 尺寸以索引记录为准（与扫描/网格同源）
      view.rows = mapStore.meta.rows || view.rows;
    }
    if (mapStore.indexLoaded) dataBooted = true;             // 索引就绪才算booted成功；否则下次开浮层再试
    applyView(bvk);
  }).catch((err) => {
    log.warn('bucket load failed: %s', err && err.message);
    if (seq === loadSeq && overlay) overlay.setStatus('数据载入失败（重开浮层可重试）');
  });
}

/**
 * 面板「清空全部区数据」：停扫描 → 等旧落盘写完 → 清内存与盘（索引 + 所有已知桶的实体键）
 * → 重新懒加载当前视角桶（盘上已无，得到空桶承接下次扫描）。
 * 必须先在 persist 链上排一笔空操作等它：scanner.stop() 内部也发了一笔落盘，跟删除竞态就刚刚删完又被写回。
 * @returns {Promise<void>}
 */
async function clearAllBuckets() {
  if (scanner.isRunning()) scanner.stop();
  const bk = mapStore.meta.buckets;
  const zones = Object.keys(bk).length;
  const total = Object.keys(bk).reduce((a, k) => a + (bk[k].count | 0), 0);
  await mapStore.persist();                       // 排到链尾：等 stop 那笔落盘真正写完
  await mapStore.clearPersisted();
  log.info('cleared all. zones=%d points=%d', zones, total);
  if (!overlay) return;                           // 浮层未建（功能未启用）：盘已清，无需重铺视图
  if (overlay.view) overlay.view.markEntitiesDirty();
  overlay.toast(`已清空全部区数据（${zones} 区 · ${total} 点）`);
  ensureBucket(targetVk());
}

/** 开始/重扫一轮（仅世界地图态放行） */
function startScan() {
  if (!ctxRef || !ctxRef.alive()) { overlay && overlay.toast('需在世界地图场景扫描'); return; }
  if (scanner.isRunning()) return;
  // 定标网格绑定 viewLevel=1（回点窗按该档实测标定）：开扫前强制锁回，防旧配置残留其他档位
  cfg.viewLevel = 1;
  // 桶号与驻留桶一致（targetVk 与 scanner 取号同源）：扫的就写进内存里驻留的那个桶。
  // 未驻留（懒加载未完或期间切了区）则先补加载，本次不发起——否则写会因串桶守卫被丢弃。
  const vk = targetVk();
  if (!mapStore.isResident(vk)) {
    if (overlay) { overlay.toast('本区数据载入中，请稍候再试'); }
    ensureBucket(vk);
    return;
  }
  const started = scanner.start(ctxRef, Object.assign({}, cfg, { k: vk, startBlock: startBlock || undefined }), {
    onBlock: (b, added) => {
      if (!overlay) return;
      const view = overlay.view;
      const n = mapStore.size(scanner.currentK());
      // 注意：不在此处 markEntitiesDirty——数据已入库但由扫波前跨块边线时才释放显示（render 内部驱动），避免波还没扫到数据就现身
      if (view) view.setCurrentBlock(b.cx0, b.cy0, b.cw, b.ch, b.i, b.j);
      overlay.setProgress(scanner.progress(), `已存 ${n} 点`);
      overlay.setStatus(`扫描中 · 已存 ${n} 点`);
      refreshListThrottled();
    },
    onProgress: () => { if (overlay) overlay.setProgress(scanner.progress(), `已存 ${mapStore.size(scanner.currentK())} 点`); },
    onDone: () => {
      if (!overlay) return;
      refreshBucket(scanner.currentK() || lastVk);
      overlay.toast('全图扫描完成');
      if (overlay) overlay.setStatus('扫描完成 ' + new Date().toLocaleString());
      refreshList();
    },
  });
  if (started) {
    // 激光扫掠周期与块停留同源（dwell + 半个抖动），使动效节奏贴合实际推进
    if (overlay && overlay.view) overlay.view.setDwell(cfg.dwellMs + Math.floor((cfg.jitterMs | 0) / 2));
    // 主网格同步为定标固定格（与队列同一几何源 SCAN_GRID）
    if (overlay && overlay.view) overlay.view.setGrid(SCAN_GRID);
    overlay && overlay.setProgress(scanner.progress(), '扫描中…');
  }
}

/** handlers 回调面（overlay → 业务动作） */
function makeHandlers() {
  return {
    onStartScan: startScan,
    onStopScan: () => { scanner.stop(); if (overlay) { const n = mapStore.size(scanner.currentK() || lastVk); overlay.setProgress(scanner.progress(), `已存 ${n} 点`); overlay.setStatus(`已停 · 已存 ${n} 点`); } },
    onFilterChange: (f) => {
      if (!overlay || !overlay.view || !f) return;
      // 图例筛选：细分类集合 + showOther 兜底 + 归属（注入本人身份/本服号）
      cfg.subs = Array.isArray(f.subs) ? f.subs.slice() : cfg.subs;
      cfg.showOther = !!f.showOther;
      overlay.view.setClassifyCtx(classifyCtx());
      overlay.view.setFilter(new Set(cfg.subs), cfg.showOther);
      overlay.view.setOwner(f.owner, { pid: gameData.myPid(), aid: gameData.myAid() });
      refreshList();
    },
    onShieldFilter: (mode, ms) => {
      if (!overlay || !overlay.view) return;
      // 护盾过滤（仅玩家城池）：mode='has'有盾/'none'无盾/'off'不限；ms=剩余上限（仅 has 生效）
      overlay.view.setShieldFilter(mode, ms);
      if (mode && mode !== 'off') startShieldTimer(); else stopShieldTimer();
      refreshList();
    },
    onLevelFilter: (min) => {
      if (!overlay || !overlay.view) return;
      // 玩家等级下限（仅作用于玩家城池）：min=null 不限；等级不随时间变，无需定时器
      overlay.view.setLevelFilter(min);
      refreshList();
    },
    onViewLevelChange: (lv) => {
      // 网格按 level 1 回点窗定标（SCAN_GRID），切档会破坏对齐：锁定不再生效
      if (overlay) overlay.toast('高度已固定为 1（网格按该档定标），切档已禁用');
    },
    onClearPoints: () => {
      const vk = lastVk || 0;
      const n = mapStore.clearBucket(vk);
      Promise.resolve(mapStore.persist(true)).catch(() => { });
      if (overlay && overlay.view) overlay.view.markEntitiesDirty();
      if (overlay) { overlay.toast('已清空本区点位（' + n + '）'); applyView(vk); }
    },
    onPick: (cx, cy) => {
      if (!overlay || !overlay.view) return;
      // 跳转 z 参：优先点自身服号（跨区城坐标以它家原点计），无则用当前视角桶
      const vk = lastVk || activeVk();
      const e = vk ? mapStore.pointAt(vk, cx, cy) : null;
      const k = (e && e.k) || vk || 0;
      const r = overlay.view.jumpToCell(cx, cy, k || null, null);
      if (!r.ok) overlay.toast(r.err === 'unavailable' ? '导航不可用（请先进入世界地图）' : '跳转失败');
    },
    onCellContext: (i, j) => {
      // 再右键同一块 = 取消选择；选中只影响下一次 startScan（在飞队列不变）
      if (startBlock && startBlock.i === i && startBlock.j === j) {
        startBlock = null;
        if (overlay && overlay.view) overlay.view.setStartBlock(null);
        if (overlay) overlay.toast('已取消起扫块');
        return;
      }
      startBlock = { i, j };
      if (overlay && overlay.view) overlay.view.setStartBlock(startBlock);
      if (overlay) overlay.toast(scanner.isRunning() ? `起扫块 (${i},${j}) · 下次扫描生效` : `起扫块 (${i},${j}) · 将从此块向外环扩扫描`);
    },
    onListPick: (cx, cy, k) => {
      if (!overlay || !overlay.view) return;
      const r = overlay.view.jumpToCell(cx, cy, k || null, null);
      overlay.view.recenter(cx, cy);
      overlay.toast(r.ok ? `已跳转 (${cx},${cy})` : (r.err === 'unavailable' ? '导航不可用（请先进入世界地图）' : '跳转失败'));
    },
    onVisibleChange: (visible) => {
      if (visible) {
        startVkPoll();
        if (overlay && overlay.view && overlay.view.shieldMode && overlay.view.shieldMode !== 'off') startShieldTimer();
        const vk = targetVk();
        // 首次可见才读盘（懒加载）；之后按区差异跟随，未变则只刷进度/新鲜度文案
        if (!dataBooted) ensureBucket(vk);
        else if (vk !== lastVk) onViewChange(vk);
        else refreshBucket(vk);
      } else {
        stopVkPoll(); stopShieldTimer();
        // 收起时补一笔落盘：现在只序列化当前驻留桶，是百 KB 级而不是全图，代价可忽略
        Promise.resolve(mapStore.persist()).catch(() => { });
      }
    },
    onGeomChange: (geom) => { try { Promise.resolve(storage.set(GEOM_KEY, geom)).catch(() => { }); } catch (e) { } },
  };
}

/** Ctrl+M 开关浮层（window 捕获阶段，同聊天窗教训：游戏在冒泡阶段 stopPropagation） */
function onKeydown(e) {
  if (!(e.ctrlKey || e.metaKey)) return;
  if (e.key !== 'm' && e.code !== 'KeyM') return;
  // 输入控件内不劫持（打字时 Ctrl+M 不应弹层）
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
  e.preventDefault();
  if (overlay) overlay.toggle();
}

/**
 * 安装：建浮层、挂热键、读盘铺底图、恢复几何。幂等。
 * @param {object} ctx reactor 上下文
 * @returns {boolean} 成功
 */
function install(ctx) {
  ctxRef = ctx;
  if (installed) return true;
  overlay = new MapOverlay(makeHandlers());
  // 尺寸以 SERVER（本服可扫范围 408×952）为准，与扫描/网格/底图一致；不用 worldMap.size()（202 含边境带 568）
  overlay.mount(mapStore, { cols: SERVER.cols, rows: SERVER.rows });
  overlay.setViewLevel(cfg.viewLevel);
  overlay.setSubs(cfg.subs);
  if (overlay.view) {
    overlay.view.setClassifyCtx(classifyCtx());
    overlay.view.setFilter(new Set(cfg.subs), !!cfg.showOther);
    overlay.view.setGrid(SCAN_GRID);
  }
  window.addEventListener('keydown', onKeydown, true);
  // 视角切区事件（游戏发 (k, subMap)）；常量取不到时仅靠可见期轮询兜底
  try {
    const E = ctx.game.get('EventId');
    const evName = E && E.EventId && E.EventId.SERVER_VIEW_CHANGE;
    if (evName) ctx.on.event(evName, (k) => onViewChange(k));
    else log.warn('EventId.SERVER_VIEW_CHANGE missing, rely on visible-time poll.');
  } catch (e) { log.warn('subscribe SERVER_VIEW_CHANGE failed: %s', e && e.message); }
  // 实体数据不在此读盘（懒加载：浮层首次可见才走 ensureBucket）；底图是纯程序化噪声，无数据也能铺
  buildTerrainBase();
  // 先把徽标/尺寸/过滤就位（内存空，渲染自然为空；读盘完成后 ensureBucket 会再应用一次）
  applyView(targetVk());
  // 几何存档：读盘失败（命名空间未设等）静默用默认
  storage.get(GEOM_KEY).then((g) => { if (g && overlay) overlay.setGeom(g); }).catch(() => { });
  installed = true;
  log.info('global map installed (Ctrl+M).');
  return true;
}

/**
 * 注入面板配置（configure 更新模块 cfg 并即时应用到已建浮层）。
 * @param {object} partial {enabled, dwellMs, jitterMs, ttlHours, showMarch, groups}
 * @returns {object} 当前 cfg
 */
function configure(partial) {
  if (!partial) return cfg;
  ['dwellMs', 'jitterMs', 'ttlHours'].forEach((k) => {
    if (partial[k] == null) return;
    const n = Number(partial[k]);
    if (isFinite(n) && n >= 0) cfg[k] = n | 0;
  });
  // 块尺寸不再可配：网格为定标固定格（SCAN_GRID，按 901 回点窗标定）；viewLevel 锁 1，忽略面板传入
  if (typeof partial.showMarch === 'boolean') cfg.showMarch = partial.showMarch;
  if (typeof partial.showOther === 'boolean') cfg.showOther = partial.showOther;
  if (Array.isArray(partial.subs)) cfg.subs = partial.subs.slice();
  if (Array.isArray(partial.subs) || typeof partial.showOther === 'boolean') {
    if (overlay) overlay.setSubs(cfg.subs);
    if (overlay && overlay.view) { overlay.view.setClassifyCtx(classifyCtx()); overlay.view.setFilter(new Set(cfg.subs), !!cfg.showOther); }
  }
  return cfg;
}

/**
 * 激活（进入 NWorldMap 态）：地形符号此刻可用，补铺一次底图。无周期触发器（扫图手动）。
 * @param {object} ctx
 */
function run(ctx) {
  ctxRef = ctx;
  buildTerrainBase();
}

reactor.register({
  id: 'globalMap',
  label: '全局地图',
  storageKey: 'pocketcc.globalMap.config',
  symbols: ['dataCenter', 'terrainModel?', 'eventIds?'],
  defaults: {
    enabled: DEFAULTS.enabled,
    dwellMs: DEFAULTS.dwellMs,
    jitterMs: DEFAULTS.jitterMs,
    viewLevel: DEFAULTS.viewLevel,
    ttlHours: DEFAULTS.ttlHours,
    showMarch: DEFAULTS.showMarch,
    subs: DEFAULTS.subs.slice(),
    showOther: DEFAULTS.showOther,
  },
  fields: [
    { key: 'dwellMs', label: '每块停留(毫秒)', min: 800, step: 100, section: '扫描节奏' },
    { key: 'jitterMs', label: '停留抖动(毫秒)', min: 0, step: 100, section: '扫描节奏' },
    { key: 'ttlHours', label: '数据有效期(小时)', min: 1, step: 1, section: '持久化' },
    { key: 'showMarch', label: '记录行军', type: 'checkbox', section: '持久化' },
    {
      key: 'clearAllBtn', type: 'button', section: '持久化', label: '清空全部区数据（内存 + 磁盘）',
      busyText: '清理中…', onClick: clearAllBuckets,
    },
    {
      key: 'subs', type: 'multiopts', label: '显示单位类型', section: '类型筛选',
      options: FILTER_TREE.reduce((a, c) => { for (const s of c.subs) a.push({ value: s.key, label: c.label + '·' + s.label }); return a; }, []),
    },
  ],
  toModuleCfg: function (c) {
    return {
      dwellMs: c.dwellMs, jitterMs: c.jitterMs,
      viewLevel: c.viewLevel, ttlHours: c.ttlHours, showMarch: c.showMarch, subs: c.subs, showOther: c.showOther,
    };
  },
  scenes: ['NWorldMap'],
  install: install,
  configure: configure,
  run: run,
});
