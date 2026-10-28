// 特征存储 + 运行时编排。功能 descriptor 的单一真相在各功能模块的 reactor.register（经 reactor.list() 收集）；
// internal 特例（不经 reactor）descriptor 留在下方 INTERNAL_FEATURES：reconnect 由 session hook 直读 configs.reconnect；
// keepAlive 由 apply 回调驱动 window.pocketccAntiThrottle（后台保活档位）；
// netLog / eventLog 分别由 apply 回调驱动 net.setLog / event.setLog（两个互不相干的独立开关，各自存储）。
// 面板层级（类别→组→子项）由 core/menu.js 声明，descriptor 只管字段/存储/默认值；
// 启用勾选即 configs[id].enabled（组闸门级联出的 enabled 变化也走同一真相字段，reactor 无感知）。
// configs 是 id→合并后配置对象（identity 稳定，session hook / 面板实时读它），在 loadAllConfigs() 里填充——
// 那时所有模块已求值、reactor.list() 完整；所有消费者（session hook / ui / startFeatures）都在 loadAllConfigs 之后才读 configs。
// 配置按 UID 隔离（player.js 设存储前缀）；换号（UID 变化）由 player.js 触发整页 reload 重建，本模块不再做 in-place 切号重载。
import { createLog } from './log.js';
import { storage } from './storage.js';
import { bus } from './bus.js';
import { reactor } from './reactor.js';
import { hasNamespace, getUid as playerGetUid } from './player.js';
import { groupConfigs, allMenuItemIds, fieldVisibleFeatureIds } from './menu.js';

/** @type {ReturnType<createLog>} 模块日志器（tag=REGISTRY） */
const log = createLog('REGISTRY');

/**
 * 不经 reactor 的 internal 功能：无独立模块，descriptor 在此声明。reconnect 排面板最前。
 * @type {Array<{id:string, label:string, storageKey:string, internal:true, defaults:object, fields:object[], apply?:function(object):void}>}
 */
const INTERNAL_FEATURES = [
  {
    id: 'reconnect',
    label: '自动重连',
    storageKey: 'pocketcc.reconnect.config',
    internal: true,
    defaults: { enabled: true, intervalSec: 30, connectTimeoutSec: 60 },
    fields: [
      { key: 'intervalSec', label: '重连间隔(秒)', min: 5, step: 5 },
      { key: 'connectTimeoutSec', label: '连接超时(秒)', min: 10, step: 10 },
    ],
  },
  {
    // 后台保活：主城就绪后不交还反节流心跳，隐藏标签里继续按 idleHz 驱动引擎帧与定时器（可见性伪装一并保持）。
    // 关掉则回到浏览器默认行为：隐藏页 rAF 停摆、定时器被节流到 1s（满 5 分钟后 1/min），
    //   createCycle 每拍 sleep 与游戏侧心跳都会被拖到分钟级——后台挂自动化靠这一档。
    // 句柄由 anti-throttle.js（document_start 入口）自挂 window.pocketccAntiThrottle。
    id: 'keepAlive',
    label: '后台保活',
    storageKey: 'pocketcc.keepAlive.config',
    internal: true,
    defaults: { enabled: true, idleHz: 10 },
    // 帧率上限由 shim 侧 clampHz 收口（通用数字字段只输出/钳制 min，max 属性在面板上不起作用），故把区间写进标签自说明
    fields: [{ key: 'idleHz', type: 'number', label: '后台帧率(Hz) 5~60', min: 5, step: 5 }],
    apply: (cfg) => {
      const at = window.pocketccAntiThrottle;
      if (!at) return;
      at.applyPolicy(!!(cfg && cfg.enabled), cfg ? cfg.idleHz : undefined);
    },
  },
  {
    // 网络日志：internal 功能，enabled 即 net 模块的 log 开关。无独立模块/无可调参数，
    // 翻动启用勾选 → applyFeature 调 apply → net.setLog。net 句柄由 net.js 自挂 window.pocketcc.net。
    id: 'netLog',
    label: '网络日志',
    storageKey: 'pocketcc.netLog.config',
    internal: true,
    defaults: { enabled: false },
    fields: [],
    apply: (cfg) => {
      const net = window.pocketcc && window.pocketcc.net;
      if (net && net.setLog) net.setLog(!!(cfg && cfg.enabled));
    },
  },
  {
    // 事件日志：与网络日志平行的独立开关（不同存储键、不同模块），开一个不影响另一个。
    // enabled → event.setLog：开启期间包 EVENT.emit 打印全量游戏事件（黑名单过滤），关闭即摘。
    // 句柄由 event.js 自挂 window.pocketcc.event。
    id: 'eventLog',
    label: '事件日志',
    storageKey: 'pocketcc.eventLog.config',
    internal: true,
    defaults: { enabled: false },
    fields: [],
    apply: (cfg) => {
      const event = window.pocketcc && window.pocketcc.event;
      if (event && event.setLog) event.setLog(!!(cfg && cfg.enabled));
    },
  },
  {
    // 报文录制（黑匣子）：internal 功能，enabled 即 net-collect 录制器的开关。开启→start(cfg) 注册
    // net.stream 全量录制并按 flushSec 落盘；关闭→stop() 解除采集（hot path 回到零开销）。
    // 转发地址/落盘间隔随 UID 持久化；句柄由 net-collect.js 自挂 window.pocketcc.netCollect。
    id: 'netRecord',
    label: '报文录制',
    storageKey: 'pocketcc.netRecord.config',
    internal: true,
    defaults: { enabled: false, ingestUrl: 'http://127.0.0.1:7391/ingest', flushSec: 2, note: '' },
    fields: [
      {
        key: 'ingestUrl',
        type: 'string',
        label: '转发地址',
        placeholder: 'http://127.0.0.1:7391/ingest',
      },
      { key: 'flushSec', type: 'number', label: '落盘间隔(秒)', min: 1, step: 1 },
      { key: 'note', type: 'string', label: '本次标签', placeholder: '如：芯片祝福STEP2（可空）' },
    ],
    apply: (cfg) => {
      const rc = window.pocketcc && window.pocketcc.netCollect;
      if (!rc) return;
      if (cfg && cfg.enabled) rc.start(cfg);
      else rc.stop();
    },
  },
];

/**
 * 全部面板条目：internal 特例在前，其余按 reactor 注册顺序（= content.entry 的 feat import 顺序）。
 * @returns {object[]} descriptor 数组
 */
export function features() {
  return INTERNAL_FEATURES.concat(reactor.list());
}

/**
 * 按 id 查 descriptor
 * @param {string} id 功能 id
 * @returns {object|undefined}
 */
export const findFeature = (id) => features().find((f) => f.id === id);

/** id -> 合并后的配置对象。loadAllConfigs 填充；此前为空（无消费者在填充前读它）。 */
export const configs = {};

/**
 * 菜单组（目前仅日常任务）：非功能，descriptor 由 core/menu.js 声明；
 * 与功能共用 configs 存储槽与读盘流程，组的 enabled 只在 UI 层翻转子项，不进 reactor。
 * @type {Array<{id:string, storageKey:string, defaults:object}>}
 */
const GROUPS = groupConfigs();

/**
 * 面板里出现、但不渲染详细字段的功能（如 6 个日常任务、快捷战斗）：详细参数用默认值、
 * 不读写 local——只持久化 enabled/intentEnabled 两个开关态。内存里 configs[f.id] 仍带全量 defaults，
 * 运行期 toModuleCfg 照常取到默认值。面板渲染了字段的功能（联盟集结/自动重连）不在此列，全量持久化。
 * @type {Set<string>} 面板里渲染了详细字段的功能 id
 */
const FIELD_VISIBLE = fieldVisibleFeatureIds();
/** @type {Set<string>} 面板菜单树里的全部功能 id */
const MENU_IDS = new Set(allMenuItemIds());

/**
 * 是否“上面板但只出开关、不渲染详细字段”的功能
 * @param {object} f descriptor
 * @returns {boolean}
 */
function isDetailHiddenFeature(f) {
  return MENU_IDS.has(f.id) && !FIELD_VISIBLE.has(f.id);
}

/** @type {boolean} 本次读盘是否因 UID 未到位而走了降级（后续 player.ready 需补载） */
let loadedDegraded = false;

/**
 * 全部读回并合并进 configs（原地覆写，保持对象 identity）。
 * 前提：UID 已就绪、存储已设命名空间；否则（waitUid 降级的登录卡死场景）跳过读盘，
 * configs 直接回退 defaults，保证自动重连仍可用。
 * @param {{preLogin?: boolean}} [opts] preLogin=true 表示调用方判定本次降级发生在登录页/启动场景
 *   （用户还没扫码，UID 本就不可能存在）——属可预期常态，降级日志走 info；
 *   缺省 false，即“已在游戏内却读不到 UID”，按 log.js 约定算真异常，走 warn。
 * @returns {Promise<void>}
 */
export async function loadAllConfigs(opts) {
  const preLogin = !!(opts && opts.preLogin);
  if (!hasNamespace()) {
    loadedDegraded = true;
    // 同一条降级按场景分级别：登录页等 UID 是常态（info），游戏内等不到才是异常（warn）
    (preLogin ? log.info : log.warn)(
      'storage namespace not set, configs fall back to defaults%s',
      preLogin ? ' (still on login scene, uid not yet available)' : '',
    );
    for (const f of features().concat(GROUPS)) {
      const c = configs[f.id] || (configs[f.id] = {});
      for (const k of Object.keys(c)) delete c[k];
      Object.assign(c, f.defaults);
    }
    backfillIntents();
    return;
  }
  for (const f of features().concat(GROUPS)) {
    let saved;
    try {
      saved = await storage.get(f.storageKey);
    } catch (e) {
      saved = null;
    }
    const c = configs[f.id] || (configs[f.id] = {});
    for (const k of Object.keys(c)) delete c[k]; // 原地覆写：新旧键集可能不同
    if (isDetailHiddenFeature(f)) {
      // 只认开关态，详细参数一律回默认（同时清掉重构前遗留的历史存量详细值）。
      Object.assign(c, f.defaults);
      if (saved) {
        if ('enabled' in saved) c.enabled = saved.enabled;
        if ('intentEnabled' in saved) c.intentEnabled = saved.intentEnabled;
      }
    } else {
      Object.assign(c, f.defaults, saved || {});
    }
  }
  backfillIntents();
  loadedDegraded = false;
}

/**
 * intentEnabled（子项用户意图，组闸门恢复用，见 menu.js）：旧存档无此键，读盘后按 enabled 补一次。
 * 只在面板菜单树声明的功能上补，内部消费方（session 直读 configs.reconnect 等）不受影响。
 */
function backfillIntents() {
  const ids = allMenuItemIds();
  for (const id of ids) {
    const c = configs[id];
    if (c && c.intentEnabled === undefined) c.intentEnabled = !!c.enabled;
  }
}

/**
 * 旧全局键一次性迁移（仅首个 UID 确定时）：把无前缀时代的配置并入该 UID 命名空间后删除旧键。
 * 关键：旧键是无前缀的字面值，必须用 storage.getRaw/removeRaw 绕过命名空间才能读到/删对；
 * 若该 UID 已有配置则跳过（UID 专属值优先，绝不因迁移覆盖/清掉现有数据）。必须在 loadAllConfigs 之前执行。
 * @param {string|null} uid 当前 UID
 * @returns {Promise<void>}
 */
export async function migrateLegacyKeys(uid) {
  if (uid == null) return;
  let moved = 0;
  for (const f of features()) {
    let existing;
    try {
      existing = await storage.get(f.storageKey);
    } catch (e) {
      existing = null;
    } // 命名空间读
    if (existing) continue;
    let legacy;
    try {
      legacy = await storage.getRaw(f.storageKey);
    } catch (e) {
      legacy = null;
    } // 原始无前缀读
    if (!legacy) continue;
    try {
      await storage.set(f.storageKey, { ...f.defaults, ...legacy });
    } catch (e) {
      continue;
    }
    try {
      await storage.removeRaw(f.storageKey);
    } catch (e) {
      /* 删失败仅残留一个孤儿旧键，不影响读取 */
    }
    moved++;
  }
  if (moved) log.info('legacy config keys migrated to uid=%s (count=%d)', uid, moved);
}

/**
 * 落盘一个功能的配置
 * @param {object} f descriptor
 * @returns {Promise<*>}
 */
export function saveFeature(f) {
  return storage.set(f.storageKey, persistable(f, configs[f.id]));
}

/**
 * 落盘视图：详细参数不展示的功能只存开关态，其余全量存。
 * @param {object} f descriptor
 * @param {object} c 内存配置
 * @returns {object} 待写入的配置对象
 */
function persistable(f, c) {
  if (!c) return c;
  if (!isDetailHiddenFeature(f)) return c;
  const out = { enabled: !!c.enabled };
  if ('intentEnabled' in c) out.intentEnabled = !!c.intentEnabled;
  return out;
}

/**
 * 落盘一个菜单组的配置（组 descriptor 由 menu.js 声明，ui 翻组开关时调用）
 * @param {string} id 组 id
 * @returns {Promise<*>}
 */
export function saveGroup(id) {
  const g = GROUPS.find((x) => x.id === id);
  return g ? storage.set(g.storageKey, configs[g.id]) : Promise.resolve();
}

/**
 * 按当前配置驱动一个功能的运行时。
 *   internal：有 apply 回调的（netLog / eventLog）调之驱动对应 core 模块；无 apply 的（自动重连）由 session hook 直读 configs.reconnect。
 *   其余功能：把 {enabled, ...toModuleCfg(秒→毫秒)} 推给 reactor.setConfig，由门控决定起停。
 * @param {object} f descriptor
 */
export function applyFeature(f) {
  const cfg = configs[f.id];
  if (f.internal) {
    if (f.apply) f.apply(cfg);
    return;
  }
  reactor.setConfig(f.id, Object.assign({ enabled: cfg.enabled }, f.toModuleCfg(cfg)));
}

/**
 * 场景就绪后：装网络/事件底座，再按配置启动各功能
 */
export function startFeatures() {
  const net = window.pocketcc && window.pocketcc.net;
  if (net && net.install) net.install();
  const event = window.pocketcc && window.pocketcc.event;
  if (event && event.install) event.install();
  for (const f of features()) {
    // internal 有 apply 的执行一次以恢复持久化态（如网络/事件日志开关），须在两个底座 install 之后；
    // 其余功能仅在启用时推配置起停。
    if (f.internal) {
      if (f.apply) applyFeature(f);
    } else if (configs[f.id].enabled) applyFeature(f);
  }
}

// ─────────────────────── 热切号（不刷新型换号）编排 ───────────────────────
/**
 * 降级补载：UID 迟列时先以默认配置跑着，ready 后补读盘并按真实配置全量重推（含未启用的，以纠偏先跑时偏错的启用态）。
 * UID 切换（换号）已改为整页 reload（见 player.js），故本函数仅服务降级补载。
 * @param {string} reason 触发缘由（日志）
 * @returns {Promise<void>}
 */
async function reloadForPlayer(reason) {
  log.info('%s, reloading configs for uid', reason);
  await loadAllConfigs(); // 存储层已按 UID 设前缀
  for (const f of features()) {
    if (f.internal) {
      if (f.apply) applyFeature(f);
    } else
      reactor.setConfig(
        f.id,
        Object.assign({ enabled: configs[f.id].enabled }, f.toModuleCfg(configs[f.id])),
      );
  }
  // configs 已刷新为新 UID 的值后再通知 UI 重同步控件（否则 UI 在 loadAllConfigs 完成前抢跑会读到旧值）。
  bus.emit('player.configs-reloaded', { uid: playerGetUid() });
  bus.emit('ui.refresh');
}

// 降级自愈：启动时 UID 未到位（waitUid 超时）则以默认配置跑着，ready 后补读盘并按真实配置重推。
// 正常路径不触发（loadAllConfigs 已带盘数据，degraded 为 false）。不跑 migrateLegacyKeys，
// 接受这种罕见路径下旧全局键不迁移。
bus.on('player.ready', () => {
  if (loadedDegraded) reloadForPlayer('player ready after degraded start');
});
