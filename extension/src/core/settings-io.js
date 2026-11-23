// 设置备份（导出 / 导入）的判据层：文件名规范、清单信封、以及「一份外来 JSON 能不能落到配置 blob 上」
// 的取舍全部收口在本文件的纯函数里——不碰 DOM、不碰 storage（那些在 core/ui/wire.js 与 core/storage.js）。
//
// 三条口径（与用户定稿一致）：
//   1. **只导设置，不导数据**。设置 = core/storage.js 配置 blob（CONFIG_KEY）的全部内容：功能开关与详细参数、
//      菜单组闸门、图标位置、各浮窗几何。运行数据（DATA_KEY 与 storage.slot 下的分片：当日计数、扫描缓存、
//      账本…）一律不带——那些是引擎从服务器镜像出来的事实，搬到另一台机器只会以陈旧值参与决策。
//   2. 文件名 `pocketcc-<uid>-YYYYMMDD-HHMMSS.json`。大端写（年→月→日→时→分→秒）使「按名称排序」就是
//      「按时间排序」，且念得出日期；不用 Unix 时间戳（`1795745428000` 得先换算才知道是哪天）。
//      UID 进名字是为了多账号备份混在一个文件夹里也能一眼分家。
//   3. 正文带**信封**（kind / schema / uid / exportedAt / settings）而不是裸 map：导入侧必须能分辨
//      「这是设置备份」与「凭证导出 / 别家程序的 JSON」，schema 则给将来的结构变更留切分缝。
import { CHANNEL_NAME } from './constants.js';

/** @type {string} 备份件类型标识（信封的 kind 字段；改这个值等于让存量备份件读不进来） */
export const KIND = 'pocketcc.settings';

/** @type {number} 备份格式版本：只在信封结构变化时 +1，字段级新增不动它（读盘侧对未知键本就宽容） */
export const SCHEMA = 1;

/**
 * @type {string} 配置 blob 内逻辑键的字面根段，与 core/storage.js 的 CONFIG_KEY/DATA_KEY 同一写法。
 *   通道后缀在命名空间层（`pocketcc.snapshot.u123.`），**不进逻辑键**，故这里就是 `pocketcc`；
 *   也正因如此，快照通道导出的备份可以直接给正式通道导入（两档本就不共存储，靠人搬）。
 */
const KEY_ROOT = 'pocketcc';

/** @type {RegExp} 可接受的逻辑键形态：字面根段 + 可见字符，天然挡掉 `__proto__` 这类注入键 */
const KEY_OK = new RegExp(`^${KEY_ROOT}\\.[\\w.\\-]+$`);

/** @type {number} UID 进文件名时保留的最大字符数（UID 是数字，留足余量只为畸形值不撑爆路径） */
const UID_MAX = 24;

/**
 * @typedef {object} SettingsEnvelope
 * @property {string} kind 固定 KIND
 * @property {number} schema 格式版本
 * @property {string} uid 导出时的账号 UID（跨账号导入的提醒依据）
 * @property {string} exportedAt ISO 8601 导出时刻（UTC）
 * @property {{remote:string, channel:string}} from 导出方的远程体版本与发布通道（排查用，不参与判据）
 * @property {Record<string,*>} settings 配置 blob 的键值快照
 */

/**
 * 文件名里的 UID 段：只留路径安全字符，畸形/缺失值回落 `anon`
 * @param {string|number|null|undefined} uid 账号 UID
 * @returns {string}
 */
export function safeUid(uid) {
  const s = String(uid == null ? '' : uid)
    .replace(/[^0-9A-Za-z._-]/g, '_')
    .replace(/^[._-]+/, '')
    .slice(0, UID_MAX);
  return s || 'anon';
}

/**
 * 导出文件名：`pocketcc-<uid>-YYYYMMDD-HHMMSS.json`（本地时刻，与下载文件夹里的其它备份同口径排序）
 * @param {string|number|null|undefined} uid 账号 UID
 * @param {Date|number} [now] 导出时刻（缺省取当前，注入仅为可测）
 * @returns {string}
 */
export function exportFileName(uid, now = new Date()) {
  const d = now instanceof Date ? now : new Date(now);
  const p = (n) => String(n).padStart(2, '0');
  const day = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
  const time = `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `pocketcc-${safeUid(uid)}-${day}-${time}.json`;
}

/**
 * 组装信封（纯数据，不 stringify，方便调用方决定缩进）
 * @param {{uid?:string|number, settings?:Record<string,*>, remoteVer?:string, channel?:string, now?:Date|number}} p 入参
 * @returns {SettingsEnvelope}
 */
export function buildEnvelope({
  uid = '',
  settings = {},
  remoteVer = '',
  channel = CHANNEL_NAME,
  now = new Date(),
} = {}) {
  const d = now instanceof Date ? now : new Date(now);
  return {
    kind: KIND,
    schema: SCHEMA,
    uid: String(uid == null ? '' : uid),
    exportedAt: d.toISOString(),
    from: { remote: String(remoteVer || ''), channel: String(channel || '') },
    settings,
  };
}

/**
 * 是否为可承载配置的值（JSON 解析产物里除 undefined 外都算；null 也放行，语义交调用方的读盘逻辑判）
 * @param {*} v 待判值
 * @returns {boolean}
 */
function isJsonLike(v) {
  return v !== undefined;
}

/**
 * 解析一份外来文本，判它能不能当设置导入（**逐键**裁决，不因个别脏键整份报废）
 *
 * 接受两种形态：① 本程序导出的信封；② 裸 map（手搓或从别处拷的 `{"pocketcc.feat.x":{...}}`）——
 * 但它必须看得出是设置（至少有一个 `pocketcc.` 前缀的键），否则当陌生文件拒掉。
 * 拒收：非法 JSON、kind 不符、schema 比当前程序还新（宁拒不误解析）、顶层不是对象、settings 不是对象。
 * 丢弃（计入 dropped，不阻断导入）：形态不合法的键名（含 `__proto__`）、值为 undefined 的键。
 *
 * @param {string} text 文件文本
 * @returns {{ok:true, settings:Record<string,*>, dropped:string[], meta:{uid:string, exportedAt:string, schema:number}}|{ok:false, error:string}}
 *   成功给净化后的键值与元信息，失败给一句可直接摆在状态行上的中文原因
 */
export function parseSettings(text) {
  if (typeof text !== 'string' || !text.trim()) return { ok: false, error: '文件是空的' };
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: '不是合法的 JSON 文件' };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: '顶层不是设置对象，认不出这是哪份备份' };
  }
  const hasKind = Object.prototype.hasOwnProperty.call(raw, 'kind');
  let body = raw;
  /** @type {{uid:string, exportedAt:string, schema:number}} */
  const meta = { uid: '', exportedAt: '', schema: 0 };
  if (hasKind) {
    if (raw.kind !== KIND) {
      return { ok: false, error: `这不是口袋控制中心的设置备份（kind=${String(raw.kind)}）` };
    }
    const schema = typeof raw.schema === 'number' ? raw.schema : 0;
    if (schema > SCHEMA) {
      return {
        ok: false,
        error: `备份格式比当前程序新（schema ${schema}，本程序只认到 ${SCHEMA}），请先升级再导入`,
      };
    }
    if (!raw.settings || typeof raw.settings !== 'object' || Array.isArray(raw.settings)) {
      return { ok: false, error: '备份里没有 settings 内容' };
    }
    body = raw.settings;
    meta.uid = String(raw.uid == null ? '' : raw.uid);
    meta.exportedAt = String(raw.exportedAt == null ? '' : raw.exportedAt);
    meta.schema = schema;
  } else if (!Object.keys(raw).some((k) => KEY_OK.test(k))) {
    return { ok: false, error: `认不出哪一项是设置（既没有 kind，也没有 ${KEY_ROOT}.* 键）` };
  }
  /** @type {Record<string,*>} */
  const settings = {};
  /** @type {string[]} */
  const dropped = [];
  for (const k of Object.keys(body)) {
    const v = body[k];
    if (!KEY_OK.test(k) || !isJsonLike(v)) {
      dropped.push(k);
      continue;
    }
    settings[k] = v;
  }
  if (!Object.keys(settings).length) {
    return { ok: false, error: '备份里没有任何可用的设置项' };
  }
  return { ok: true, settings, dropped, meta };
}
