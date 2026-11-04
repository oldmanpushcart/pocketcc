import { NS } from './constants.js';
import { createLog } from './log.js';

/** @type {ReturnType<createLog>} 模块日志器（tag=STORAGE） */
const log = createLog('STORAGE');

// MAIN world 无 chrome.*，经 ISOLATED 的 bridge.js 用 postMessage 代理读写 chrome.storage.local。
// 请求-应答用自增 id 关联；监听 bridge->main 回执，resolve/reject 对应 pending。
// 模块级即挂监听（bundle 每次干净页面只评估一次，等价于原 boot.js body 内的挂载时机）。
// 配置按玩家 UID 隔离：UID 就绪后 player.js 调 setNamespace 设前缀，此后所有读写自动拼前缀；
// 前缀未设（UID 未知窗口期）写丢弃、读直接 reject——「没权限读」绝不能伪装成「盘上是空的」，
// 否则那份空快照会被 loadBlob 固化，等 UID 到位后整块写回，把该存储键下已有的真实数据覆盖清空。
/** @type {{n: number}} 请求-应答关联用的自增序号 */
const seq = { n: 0 };
/** @type {Map<string, {resolve: Function, reject: Function}>} 消息 id -> 在途请求 */
const pending = new Map();
/** @type {string|null} 键前缀（'pocketcc.u{uid}.'）；未设时写不碰存储层、读直接报错 */
let ns = null;
/**
 * 扩展上下文是否已失效（用户在 chrome://extensions 重载/更新/停用扩展后置真，MV3 下单向不可逆）。
 * 一旦置位，本实例的每笔 chrome.* 调用都会抛 'Extension context invalidated'：
 *   - 首笔撞上时在回执里识别并降级为一条 info，此后完全静默；
 *   - call() 直接短路——写丢弃、读回 undefined，且**不 reject**。
 * 不 reject 是关键：warn 刷屏来自各 feat 自己的 .catch(log.warn)，只有让它不触发才能全局收口。
 * 空快照固化在本实例无害：上下文失效后不可能再落盘，页面刷新即整份重建。
 */
let contextInvalidated = false;

/** 置位上下文失效标志并只打一条 info（幂等，重复调用不再告警） */
function markContextInvalidated() {
  if (contextInvalidated) return;
  contextInvalidated = true;
  log.info(
    'extension context invalidated: this instance belongs to a reloaded extension; all later storage writes are dropped and reads return empty without per-call errors; press Ctrl+F5 to refresh the page and re-mount.',
  );
}

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const msg = event.data;
  if (!msg || msg.__ns !== NS || msg.dir !== 'bridge->main') return;
  const entry = pending.get(msg.id);
  if (!entry) return;
  pending.delete(msg.id);
  if (msg.error) {
    // MV3 扩展重载后本实例上下文永久失效：降级为一条 info、resolve 空值，绝不 reject 免得各 feat 各自刷 warn
    if (String(msg.error).indexOf('Extension context invalidated') !== -1) {
      markContextInvalidated();
      entry.resolve(undefined);
    } else {
      entry.reject(new Error(msg.error));
    }
  } else entry.resolve(msg.result);
});

/**
 * 设置键前缀（如 'pocketcc.u123.'）；传 null 清空。仅在实际换 UID 时调用，同值重复调用会 warn。
 * 前缀真变了会一并丢掉 blob 内存缓存（缓存归属跟着命名空间走，详见函数体）。
 * @param {string|null} prefix 键前缀
 */
export function setNamespace(prefix) {
  if (prefix === ns) {
    log.warn('setNamespace: already %s', prefix);
    return;
  }
  ns = prefix;
  // blob 内存缓存的归属跟着命名空间走：换前缀必须丢掉上一位玩家（以及前缀未设期间）的快照，
  // 否则下一次整块写回会把旧快照覆写到新前缀键上。队列里在飞的那笔写入无法撤销，
  // 但换号已由 player.js 安排整页 reload 重建，实际不经过这条路。
  for (const k of Object.keys(blobs)) delete blobs[k];
  log.info('namespace: %s (blob cache dropped)', ns || '(none)');
}

/**
 * 当前键前缀（未设为 null）
 * @returns {string|null}
 */
export function getNamespace() {
  return ns;
}

/**
 * 向 bridge 发一次存储操作请求并等回执
 * raw=true：无视命名空间，直接操作传入的字面键（仅供旧全局键一次性迁移使用）。
 * @param {'get'|'set'|'remove'} op 操作类型
 * @param {string} key 字面键或命名空间内逻辑键
 * @param {*} [value] 待写入值
 * @param {boolean} [raw] 是否绕过命名空间
 * @returns {Promise<*>} 操作结果（前缀未设时写丢弃、读 reject）
 */
function call(op, key, value, raw) {
  // 上下文已失效：不再打扰 bridge（发了也必抛错），直接短路——写丢弃、读回空，且返回 resolved 以免下游 catch 刷屏
  if (contextInvalidated) return op === 'get' ? Promise.resolve(undefined) : Promise.resolve();
  let fullKey;
  if (raw) {
    fullKey = key;
  } else if (!ns) {
    // UID 未就绪：写丢弃（切号窗口期宁可丢也不串号）；读必须报错而非回 null——
    // null 与「键不存在」在调用方眼里同形，会把「还没法读」误判成「盘上没数据」。
    if (op === 'get')
      return Promise.reject(new Error(`storage get blocked: namespace not set (${key})`));
    log.warn('drop %s %s: namespace not set', op, key);
    return Promise.resolve();
  } else {
    fullKey = ns + key;
  }
  const id = `${NS}-${++seq.n}`;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    window.postMessage({ __ns: NS, dir: 'main->bridge', id, op, key: fullKey, value }, '*');
  });
}

// === 两块 JSON blob：配置 vs 数据，各占一个存储 key（UID 前缀下即两个键） ===
//   CONFIG_KEY —— 用户配置（功能开关、详细参数、组闸门、图标位置、网络/事件日志、自动重连）。
//                  面板编辑时才写；「导出配置」后续只需 getAllConfig()，与 data 完全解耦。
//   DATA_KEY   —— 运行期频繁写入的持久数据（联盟集结当日计数等）。与配置互不干扰，
//                  配置导出/清理不会误动它；数据落盘也不会覆盖配置。
// 读写模型：整块 blob 内存缓存（首次**成功**读盘时固化，见 loadBlob）；写入走 per-blob 串行队列，避免并发 read-modify-write 覆盖。
// 注意：本次重构前每个功能各自一个 UID 前缀下的字面键（如 'pocketcc.u123.pocketcc.feat.allianceRally'）
//       不再读取；开发期视作默认，重新配置一次即可。旧无前缀全局键的迁移仍走 getRaw/setRaw/removeRaw 通道。
/** @type {string} 配置 blob 存储键（功能开关/参数/组闸门/图标位置） */
const CONFIG_KEY = 'pocketcc.config';
/** @type {string} 运行期数据 blob 存储键（与配置互不干扰） */
const DATA_KEY = 'pocketcc.data';
/** @type {Object<string, object>} blobKey -> 内存缓存（仅在读盘成功后填充） */
const blobs = Object.create(null);
/** @type {Object<string, Promise>} blobKey -> 串行写队列尾（避免并发 read-modify-write 覆盖） */
const queues = Object.create(null);

/**
 * 把一个任务排进该 blob 的串行队列（无论上笔成败都放行下一笔；错误由调用方自行 catch）
 * @param {string} blobKey blob 存储键
 * @param {function():Promise<*>} task 任务
 * @returns {Promise<*>} 任务结果
 */
function enqueue(blobKey, task) {
  const prev = queues[blobKey] || Promise.resolve();
  const next = prev.then(task, task);
  // 无论成功/失败都放行下一笔；错误由调用方自行 catch
  queues[blobKey] = next.then(
    () => {},
    () => {},
  );
  return next;
}

/**
 * 首次读拉盘并缓存整个 blob（非对象回落空对象）。
 * 关键：只有真正拿到盘的应答才固化缓存。call 在命名空间未设时 reject、bridge 异常也 reject，
 * 两种「没读到」都不写缓存，留待下次调用重读——否则一份空快照一旦被缓存，
 * 后续任何一笔写都会把整块 blob 覆成只剩那一个键，等于把盘上已有数据清空。
 * @param {string} blobKey blob 存储键
 * @returns {Promise<object>} blob
 */
async function loadBlob(blobKey) {
  if (blobs[blobKey]) return blobs[blobKey];
  const v = await call('get', blobKey);
  blobs[blobKey] = v && typeof v === 'object' ? v : {};
  return blobs[blobKey];
}

/**
 * 读 blob 内一个逻辑键（命名空间未设时 reject，调用方自行兜底；不会污染内存缓存）
 * @param {string} blobKey blob 存储键
 * @param {string} name 逻辑键
 * @returns {Promise<*>}
 */
async function blobGet(blobKey, name) {
  const b = await loadBlob(blobKey);
  return b[name];
}

/**
 * 写/删 blob 内一个逻辑键（value===undefined 即删），串行落盘
 * @param {string} blobKey blob 存储键
 * @param {string} name 逻辑键
 * @param {*} value 写入值；undefined 表示删除
 * @returns {Promise<*>}
 */
async function blobSet(blobKey, name, value) {
  return enqueue(blobKey, async () => {
    if (!ns) {
      if (value !== undefined) log.warn('drop set %s/%s: namespace not set', blobKey, name);
      return;
    }
    const b = await loadBlob(blobKey);
    if (value === undefined) {
      if (name in b) delete b[name];
    } else {
      b[name] = value;
    }
    await call('set', blobKey, b);
  });
}

/**
 * 独立键读写（UID 前缀下、脱离两块 blob）：给大体量且需按需分片的业务数据用，
 * 例如全局地图按视角桶切分的实体（一个桶一个键，只读需要的那片）。
 * 与 blobGet/blobSet 的区别：
 *   ① 不进取 `blobs` 内存缓存——读回的值只归调用方持有，用完即可被 GC，不会长期常驻一份副本；
 *   ② 一次读写只碰那一个键，不会被同 blob 内其他键的数据连带拉回/整块回写（写放大与体积无关）。
 * 写/删按 key 走串行队列（队列名加 slot: 前缀，与 blob 的队列互不干扰）。
 * @param {string} name 命名空间下的逻辑键
 * @param {*} [value] 待写入值；调用 remove 时省略
 * @param {'get'|'set'|'remove'} op 操作类型
 * @returns {Promise<*>}
 */
function slot(op, name, value) {
  if (op === 'get') return call('get', name);
  return enqueue('slot:' + name, () => call(op, name, value));
}

/** 存储入口，挂到 window.pocketcc.storage（配置 blob / 数据 blob / 独立键 / 绕过前缀的 raw 通道） */
export const storage = {
  // 配置 blob 逻辑读写：key 沿用调用点原有的字面 storageKey（如 'pocketcc.feat.allianceRally'）。
  get: (key) => blobGet(CONFIG_KEY, key),
  set: (key, value) => blobSet(CONFIG_KEY, key, value),
  remove: (key) => blobSet(CONFIG_KEY, key, undefined),
  // 供后续「导出配置」使用：返回配置 blob 的浅拷贝（不含 data）。
  getAllConfig: () => loadBlob(CONFIG_KEY).then((b) => Object.assign({}, b)),
  // 数据 blob：与配置完全分离，频繁写入互不干扰。
  data: {
    get: (name) => blobGet(DATA_KEY, name),
    set: (name, value) => blobSet(DATA_KEY, name, value),
    remove: (name) => blobSet(DATA_KEY, name, undefined),
  },
  // 独立键通道（仍在 UID 前缀下）：大体量数据分键存取，不牵连共享 blob 里的其他 feat。
  slot: {
    get: (name) => slot('get', name),
    set: (name, value) => slot('set', name, value),
    remove: (name) => slot('remove', name),
  },
  // 绕过 UID 前缀 + 绕过 blob：仅 migrateLegacyKeys / 图标位置旧全局键认领用。
  getRaw: (key) => call('get', key, undefined, true),
  setRaw: (key, value) => call('set', key, value, true),
  removeRaw: (key) => call('remove', key, undefined, true),
};
