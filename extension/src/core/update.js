// 口袋控制中心 — 升级通道（update）。
// 职责边界：本模块只做与 I/O 无关的判定（版本出口、清单解析、地址拼接、就绪来源选择、下载决策、
// 完整性计算与提示口径）；取数、落盘与定时复检由 background service worker 编排——它是扩展唯一出网口，
// 用扩展自有源 + manifest host_permissions，不受游戏页 connect-src 限制。
// 两个语义纪律（调用方共同遵守）：
//   1. 启动路径绝不阻塞网络：exec 的文本只来自 chooseReady()（本地缓存 > 包内基线），检查结果只写缓存；
//   2. 「已下载」不等于「已生效」：远程体只在启动时执行一次，运行期不热替换，提示统一为「刷新页面即生效」。
// 构建期 define 符号在 eslint.config.js 扩展段统一登记；此处一律用 typeof 兜底，便于 node 测试环境直接 import。

import { CHAN_SUFFIX, CHANNEL_NAME } from './constants.js';

/** @type {string} 构建版本号 */
const VERSION = typeof __PCC_VERSION__ === 'string' ? __PCC_VERSION__ : 'dev';
/** @type {string} 远程更新基址（含结尾斜杠；空串 = 通道未配置，dev 包即此态） */
const OSS_BASE = typeof __OSS_BASE__ === 'string' ? __OSS_BASE__ : '';
/** @type {string} 完整性 HMAC 密钥（构建期内联；空串 = 无法验签，等同通道关闭） */
const UPDATE_KEY = typeof __UPDATE_KEY__ === 'string' ? __UPDATE_KEY__ : '';
/**
 * @type {boolean} 本通道的发布身份是否带摘要：正式通道只看版本号，快照通道看「版本号@摘要前 8 位」。
 * 快照通道刻意把版本号钉在同一个号上、靠摘要推动更新，故摘要必须是与版本号正交的一维——
 * 绝不能把它塞进版本号（cmpVer 逐段 parseInt 会把非数字尾巴折叠成数字，同号判等，于是静默不更新）。
 */
const DIGEST_IDENTITY = CHANNEL_NAME !== 'release';

/** @type {string} 已下载远程体的缓存键：chrome.storage.local 顶层字面键，刻意不进 UID 命名空间（换号不丢、不重复占空间）；带通道后缀以隔离 dev/snapshot 与正式包（三套构建扩展 ID 不同、storage 本就分开，后缀只防「同一个 ID 下误读另一通道」） */
export const CACHE_KEY = `pccupd${CHAN_SUFFIX}:bundle`;
/** @type {string} 通道运行快照的持久键（检查时刻/失败计数/服务来源等，冷启动 SW 也要能读出可展示的事实） */
export const STATE_KEY = `pccupd${CHAN_SUFFIX}:state`;
/** @type {string} 升级偏好（自动检查开关/锁定版本/被吊销版本）的持久键 */
export const PREF_KEY = `pccupd${CHAN_SUFFIX}:pref`;
/** @type {string} 包内基线包路径（相对扩展根，SW 经 chrome.runtime.getURL 读取）：就是远程组产物本身，不设第二份副本 */
export const BASELINE_URL = 'dist/remote.js';
/** @type {number} 连续失败达到此数即熔断远程通道（本会话只用包内基线） */
export const FAIL_BREAKER = 3;
/** @type {number} 定时复检间隔（分钟） */
export const CHECK_INTERVAL_MIN = 240;
/** @type {number} 拉清单超时（毫秒） */
export const LATEST_TIMEOUT_MS = 1500;
/** @type {number} 下载正文超时（毫秒） */
export const BUNDLE_TIMEOUT_MS = 6000;
/** @type {number} MAIN world ↔ 后台一次往返回的最长等待（毫秒）：壳取包与面板取快照共用，超时即降级/静默，绝不让启动路径无限挂起 */
export const ASK_TIMEOUT_MS = 4000;
/** @type {number} SW 复活即检的最小间隔（毫秒）：SW 会被频繁唤醒，此闸防打爆清单地址 */
export const WAKE_MIN_INTERVAL_MS = 60000;
/** @type {string} latest.json 相对路径 */
export const LATEST_FILE = 'latest.json';
/** @type {number} 清单 versions 保留条数 */
export const KEEP_VERSIONS = 5;

/** @type {Object<string,string>} 通道状态字典（面板与日志共用同一套字面量） */
export const STATE = {
  /** 未配置基址或密钥：整条通道短路，只跑包内产物 */
  UNCONFIGURED: 'unconfigured',
  /** 空闲（上轮检查已结束） */
  IDLE: 'idle',
  /** 检查进行中 */
  CHECKING: 'checking',
  /** 已是最新，无待生效版本 */
  UPTODATE: 'uptodate',
  /** 新版已下载并验签通过，等刷新生效 */
  READY: 'ready',
  /** 最近一轮失败（网络或验签），下轮自愈 */
  FAILED: 'failed',
};

/** @returns {string} 构建版本号 */
export function revision() {
  return VERSION;
}

/** @returns {string} 远程更新基址（未配置为空串） */
export function ossBase() {
  return OSS_BASE;
}

/**
 * 通道是否可用：基址与密钥齐备才允许出网。
 * @returns {boolean}
 */
export function configured() {
  return !!OSS_BASE && !!UPDATE_KEY;
}

/**
 * 小写去空白（清单里的十六进制摘要按小写口径比对）
 * @param {unknown} v 原值
 * @returns {string}
 */
function lower(v) {
  return String(v === undefined || v === null ? '' : v)
    .trim()
    .toLowerCase();
}

/**
 * 归一为字符串（清单字段可能是数字或缺席）
 * @param {unknown} v 原值
 * @returns {string}
 */
function str(v) {
  return v === undefined || v === null ? '' : String(v).trim();
}

/**
 * 版本号比较：按点分十进制逐段比大小，缺段视 0，非法段视 0。
 * @param {string|null|undefined} a 左值
 * @param {string|null|undefined} b 右值
 * @returns {number} a<b 回 -1，a>b 回 1，相等回 0
 */
export function cmpVer(a, b) {
  const pa = String(a || '').split('.');
  const pb = String(b || '').split('.');
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const x = parseInt(pa[i], 10) || 0;
    const y = parseInt(pb[i], 10) || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** @type {number} 摘要短标签的位数（正文文件名里那段、界面展示那段与身份串都取这个数，肉眼可互相对照） */
export const SHA_TAG_LEN = 8;

/**
 * 摘要短标签：小写十六进制的前 {@link SHA_TAG_LEN} 位；缺失回空串。
 * @param {string|null|undefined} sha 正文 sha256
 * @returns {string}
 */
export function shaTag(sha) {
  return lower(sha).slice(0, SHA_TAG_LEN);
}

/**
 * 发布身份：正式通道即版本号；快照通道为 `版本号@摘要前8位`。
 * 于是同一个 1.0.0 可以有无数份正文而彼此可辨——版本号不必为每次快照递增，「你在用哪版」仍一句话可答。
 * @param {string|null|undefined} ver 版本号
 * @param {string|null|undefined} [sha] 正文 sha256
 * @returns {string} 形如 '1.4.0'（正式）或 '1.0.0@03b39054'（快照）
 */
export function identityOf(ver, sha) {
  const v = str(ver);
  if (!DIGEST_IDENTITY) return v;
  const s = shaTag(sha);
  return s ? `${v}@${s}` : v;
}

/**
 * 待生效身份：本地就绪那份与正在运行那份不是同一个发布物时，给出就绪那份的身份，否则空串。
 * 正式通道只看版本号（更高才算新版）；快照通道同版本号而摘要不同也算新版——这正是「号不动、照样更新」的判据。
 * 同号而 runningSha 未知（本会话还没交付出过文本）时不猜：宁可不提示，也不提示一句无法核对的「已就绪」。
 * @param {{runningVer?:string, runningSha?:string, readyVer?:string, readySha?:string}} p 两个本地来源
 * @returns {string} 身份串或空串
 */
export function pendingIdentity({
  runningVer = '',
  runningSha = '',
  readyVer = '',
  readySha = '',
} = {}) {
  if (!readyVer) return '';
  const d = cmpVer(readyVer, runningVer);
  if (d > 0) return identityOf(readyVer, readySha);
  if (d < 0) return '';
  if (!DIGEST_IDENTITY || !runningSha || !readySha) return '';
  return lower(readySha) !== lower(runningSha) ? identityOf(readyVer, readySha) : '';
}

/**
 * 解析更新清单：文本或对象都吃，字段缺失/类型不符时归零，不可用时回 null（绝不抛）。
 * 清单是唯一可被远端改写的面，因此只认相对 file，不接受它指定 host。
 * @param {string|object|null|undefined} raw 清单原文或已解析对象
 * @returns {{latest:string,file:string,min:string,shellMin:string,sha256:string,hmac:string,size:number,notes:string,versions:Array<{ver:string,file:string,notes:string,sha256:string,hmac:string}>}|null}
 */
export function parseLatest(raw) {
  let obj = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch (e) {
      return null;
    }
  }
  if (!obj || typeof obj !== 'object') return null;
  const latest = str(obj.latest);
  const file = str(obj.file);
  if (!latest || !file) return null;
  const versions = (Array.isArray(obj.versions) ? obj.versions : [])
    .map((v) =>
      typeof v === 'string'
        ? { ver: v, file: '', notes: '', sha256: '', hmac: '' }
        : v && typeof v === 'object'
          ? {
              ver: str(v.ver),
              file: str(v.file),
              notes: str(v.notes),
              sha256: lower(v.sha256),
              hmac: lower(v.hmac),
            }
          : null,
    )
    .filter((v) => !!v && !!v.ver);
  return {
    latest: latest,
    file: file,
    min: str(obj.min),
    shellMin: str(obj.shellMin),
    sha256: lower(obj.sha256),
    hmac: lower(obj.hmac),
    size: Number(obj.size) || 0,
    notes: str(obj.notes),
    versions: versions,
  };
}

/**
 * 拼出可下载的正文 URL：清单给的 file 只允许是相对路径，基址永远取自壳内常量。
 * 拒绝协议头、协议相对、绝对路径、上跳、反斜杠、查询串与锚点；任一命中即回空串（调用方按「无目标」处理）。
 * @param {string|null|undefined} file 清单里的相对路径
 * @param {string} [base] 基址（缺省用构建期内联值）
 * @returns {string} 完整 URL，非法则空串
 */
export function assertUrl(file, base) {
  const b = (base === undefined ? OSS_BASE : base) || '';
  const f = String(file || '').trim();
  if (!b || !f) return '';
  if (/^[a-z][a-z0-9+.-]*:/i.test(f)) return '';
  if (f.charAt(0) === '/' || /[\\?#]/.test(f) || f.indexOf('..') !== -1) return '';
  if (/[\s\x00-\x1f]/.test(f)) return '';
  return b.charAt(b.length - 1) === '/' ? b + f : b + '/' + f;
}

/**
 * 清单地址：基址永远取自壳内常量，只加一个防缓存查询串（OSS 侧对 latest.json 也配了 no-cache，双重保险）。
 * ts 由调用方给，本函数因此不取时钟、可离线单测。
 * @param {number|string} [ts] 防缓存时间戳
 * @param {string} [base] 基址（缺省用构建期内联值）
 * @returns {string} 未配置基址则空串
 */
export function latestUrl(ts, base) {
  const u = assertUrl(LATEST_FILE, base === undefined ? OSS_BASE : base);
  if (!u) return '';
  const q = ts === undefined || ts === '' ? String(Date.now()) : String(ts);
  return `${u}?_t=${q}`;
}

/**
 * 取某一版本在清单里的完整性标记：latest 用顶层标签，versions 条目用自己的；缺失即空串。
 * 只对带完整标签的版本落盘（未签名的正文一律不执行，宁可用旧版）。
 * 快照通道下同一版本号会有多份正文，`ver` 撞车无法唯一命中，故可选传 `file` 精确定位（按 file 找不着才回落到按版本）。
 * @param {ReturnType<parseLatest>|null} latest 已解析清单
 * @param {string} ver 目标版本
 * @param {string} [file] 目标正文的相对路径（快照通道按它区分同号多份）
 * @returns {{sha256:string,hmac:string}}
 */
export function tagsFor(latest, ver, file) {
  if (!latest) return { sha256: '', hmac: '' };
  const f = str(file);
  if (f) {
    if (f === latest.file) return { sha256: latest.sha256, hmac: latest.hmac };
    const byFile = latest.versions.find((v) => v.file && v.file === f);
    if (byFile) return { sha256: byFile.sha256, hmac: byFile.hmac };
  }
  if (ver === latest.latest) return { sha256: latest.sha256, hmac: latest.hmac };
  const hit = latest.versions.find((v) => v.ver === ver);
  return hit ? { sha256: hit.sha256, hmac: hit.hmac } : { sha256: '', hmac: '' };
}

/**
 * 归并清单 versions：新条目优先，同一发布身份以新为准，按版本号降序只留最近几条（旧 js 不删，仅供回滚索引）。
 * 供发布脚本生成 latest.json 使用，同时也可被客户端拿来做快照校验。
 * 去重键随通道而变：正式通道一号一份（同号以新为准），快照通道同号码的不同摘要是两份不同的发布物，都得留着。
 * @param {Array<{ver:string,file:string,notes?:string,sha256?:string,hmac?:string}>|null|undefined} prev 旧列表
 * @param {Array<{ver:string,file:string,notes?:string,sha256?:string,hmac?:string}>|null|undefined} added 新条目
 * @param {number} [keep] 保留条数
 * @returns {Array<{ver:string,file:string,notes:string,sha256:string,hmac:string}>}
 */
export function mergeVersions(prev, added, keep = KEEP_VERSIONS) {
  const out = [];
  /** 同一发布身份只留一条：正式看版本号，快照看版本号+摘要 */
  const keyOf = (v) => (DIGEST_IDENTITY ? `${str(v.ver)}|${lower(v.sha256)}` : str(v.ver));
  for (const v of (Array.isArray(added) ? added : []).concat(Array.isArray(prev) ? prev : [])) {
    if (!v || typeof v !== 'object' || !str(v.ver)) continue;
    if (out.some((x) => keyOf(x) === keyOf(v))) continue;
    out.push({
      ver: str(v.ver),
      file: str(v.file),
      notes: str(v.notes),
      sha256: lower(v.sha256),
      hmac: lower(v.hmac),
    });
  }
  // 降序只按版本号：同号的多份快照保持入列顺序（added 在前 = 刚发的排前），不拿发布时刻排序
  out.sort((a, b) => cmpVer(b.ver, a.ver));
  return out.slice(0, Math.max(0, Number(keep) || 0));
}

/**
 * 生成 latest.json：parseLatest 的生产侧对偶，两者同住本模块以守住「清单字段名单一真相」。
 * 少写或写错任一键名，客户端都会把该版本判成「无可用目标」而静默不升级，故由单测把 build↔parse 往返回路钉住。
 * 消费方是 scripts/publish-oss.mjs（构建期）；客户端不引用它，打包时被 tree-shake 掉。
 * publishedAt 只给人看，parseLatest 刻意不认它（客户端不看发布时刻，只看版本高低）。
 * @param {{latest?:string, file?:string, sha256?:string, hmac?:string, size?:number, notes?:string, min?:string, shellMin?:string, prev?:{versions?:Array<object>|null}|null, added?:Array<{ver:string, file:string, notes?:string, sha256?:string, hmac?:string}>, publishedAt?:string, keep?:number}} p 本次发布的正文与人工吊销位
 * @returns {object} 可直接 JSON.stringify 上 OSS 的清单
 */
export function makeLatest({
  latest = '',
  file = '',
  sha256 = '',
  hmac = '',
  size = 0,
  notes = '',
  min = '',
  shellMin = '',
  prev = null,
  added = [],
  publishedAt = '',
  keep = KEEP_VERSIONS,
} = {}) {
  return {
    latest: str(latest),
    min: str(min),
    shellMin: str(shellMin),
    file: str(file),
    sha256: lower(sha256),
    hmac: lower(hmac),
    size: Number(size) || 0,
    notes: str(notes),
    publishedAt: str(publishedAt),
    versions: mergeVersions(prev && prev.versions, added, keep),
  };
}

/**
 * 挑一个可下载的目标版本：latest 与 versions 里过了 min 闸、版本最高的一个。
 * 没带 file 的 versions 条目只作回滚索引：无地址即不可选（不拿主 file 张冠李戴）。
 * 同版本号的多份（快照通道常态）取先入列的那份 = 顶层 latest，即刚发的那一份正文。
 * @param {ReturnType<parseLatest>} latest 已解析清单
 * @returns {{ver:string,file:string,sha256:string,hmac:string}|null} 无可用版本回 null
 */
function resolveTarget(latest) {
  if (!latest) return null;
  /** @type {Array<{ver:string,file:string,sha256:string,hmac:string}>} */
  const cands = [
    { ver: latest.latest, file: latest.file, sha256: latest.sha256, hmac: latest.hmac },
  ].concat(latest.versions.map((v) => ({ ver: v.ver, file: v.file, sha256: v.sha256 })));
  const gated = latest.min ? cands.filter((c) => cmpVer(c.ver, latest.min) >= 0) : cands;
  let best = null;
  for (const c of gated) {
    if (!c.ver || !c.file) continue;
    if (!best || cmpVer(c.ver, best.ver) > 0) best = c;
  }
  return best;
}

/**
 * 选择启动时要执行的文本：缓存与包内基线取版本高者，都没有则回 none。
 * @param {{cached?:{ver?:string,text?:string}|null, baseline?:{ver?:string,text?:string}|null}} p 两个本地来源
 * @returns {{from:'cache'|'baseline'|'none', ver:string, text:string}}
 */
export function chooseReady({ cached, baseline } = {}) {
  const c = cached && cached.text ? cached : null;
  const b = baseline && baseline.text ? baseline : null;
  if (c && b) {
    return cmpVer(c.ver, b.ver) >= 0
      ? { from: 'cache', ver: str(c.ver), text: c.text }
      : { from: 'baseline', ver: str(b.ver), text: b.text };
  }
  if (c) return { from: 'cache', ver: str(c.ver), text: c.text };
  if (b) return { from: 'baseline', ver: str(b.ver), text: b.text };
  return { from: 'none', ver: '', text: '' };
}

/**
 * 下载决策：本次检查要不要拉包、拉哪个版本、还是被版本闸拦下。
 * 判据顺序即优先级：通道未配置 → 壳过旧（刷新无用，必须换壳）→ 清单无可用版本 → 已吊销 → 用户锁定 → 已最新 → 下载。
 * 「已最新」的判据随通道而变：正式通道只要目标版本不比本地高就算最新；
 * 快照通道同版本号还可以有不同的正文，故「不比本地高」**且**「摘要与本地就绪那份相同」才算了结——
 * 否则同一号下的新快照永不会被下载，而号不膨胀正是快照通道的设计前提。
 * @param {{readyVer?:string, readySha?:string, latest?:ReturnType<parseLatest>, shellVer?:string, locked?:boolean, blockedId?:string}} p 上下文
 *   readySha：本地就绪那份正文的摘要（快照通道靠它判断同号下是否已持有同一份）
 *   blockedId：上次执行抛错而被隔离的**发布身份**，不再重复下发（否则刷新即崩循环）
 * @returns {{action:'stay'|'download'|'block-shell'|'block-unsupported', ver:string, file:string, reason:string}}
 */
export function pickBundle({
  readyVer = '',
  readySha = '',
  latest = null,
  shellVer = '',
  locked = false,
  blockedId = '',
} = {}) {
  if (!configured()) return { action: 'stay', ver: readyVer, file: '', reason: 'unconfigured' };
  if (!latest) return { action: 'stay', ver: readyVer, file: '', reason: 'no-manifest' };
  if (latest.shellMin && cmpVer(shellVer, latest.shellMin) < 0) {
    return { action: 'block-shell', ver: latest.shellMin, file: '', reason: 'shell-outdated' };
  }
  const target = resolveTarget(latest);
  if (!target) {
    return {
      action: 'block-unsupported',
      ver: '',
      file: '',
      reason: latest.min ? 'below-min' : 'no-target',
    };
  }
  if (blockedId && identityOf(target.ver, target.sha256) === blockedId) {
    return { action: 'stay', ver: readyVer, file: '', reason: 'quarantined' };
  }
  if (locked) return { action: 'stay', ver: readyVer, file: '', reason: 'locked' };
  const d = cmpVer(target.ver, readyVer);
  if (d < 0) return { action: 'stay', ver: readyVer, file: '', reason: 'uptodate' };
  // 目标版本不比本地高：正式通道到此为止；快照通道还要问一句「本地那份就是同一正文吗」
  if (d === 0) {
    if (!DIGEST_IDENTITY) return { action: 'stay', ver: readyVer, file: '', reason: 'uptodate' };
    const want = lower(target.sha256);
    const have = lower(readySha);
    // 目标没带摘要（旧清单/仅索引条目）时不能凭猜重下，按已最新收场；有摘要且与本地不同就是新正文
    if (!want || (have && want === have)) {
      return { action: 'stay', ver: readyVer, file: '', reason: 'uptodate' };
    }
  }
  return { action: 'download', ver: target.ver, file: target.file, reason: 'newer' };
}

/**
 * 本轮是否该发起检查：手动/启动补检 force 直放；SW 复活即检受最小间隔约束（上次检查无效或在未来也放行）。
 * 偏好 autoCheck 为 false 时定时轮全部静默，只留手动入口。
 * @param {{now?:number, lastCheckedAt?:number, minIntervalMs?:number, force?:boolean, autoCheck?:boolean}} p 上下文
 * @returns {boolean}
 */
export function shouldCheck({
  now = 0,
  lastCheckedAt = 0,
  minIntervalMs = 0,
  force = false,
  autoCheck = true,
} = {}) {
  if (force) return true;
  if (!autoCheck) return false;
  const last = Number(lastCheckedAt) || 0;
  if (!last || last > now) return true;
  return now - last >= minIntervalMs;
}

/**
 * 熔断判定：连续失败次数是否已达停用远程通道的阈值。
 * @param {number|string|null|undefined} failCount 连续失败计数
 * @returns {{fails:number, tripped:boolean}}
 */
export function fuseState(failCount) {
  const n = Math.max(0, Number(failCount) || 0);
  return { fails: n, tripped: n >= FAIL_BREAKER };
}

/**
 * 推进熔断计数：成功清零，失败累加。
 * @param {number|string|null|undefined} failCount 上一轮计数
 * @param {boolean} ok 本轮是否成功
 * @returns {number} 新计数
 */
export function bumpFuse(failCount, ok) {
  return ok ? 0 : Math.max(0, Number(failCount) || 0) + 1;
}

/**
 * 是否为「清单已停止支持本机」类决策原因（壳过旧 / 低于 min / 无可用版本）。
 * 这类不是故障：刷新无用、必须换壳或换清单，故不计入熔断，UI 也不给「立即刷新」按钮。
 * @param {string} reason pickBundle 的 reason
 * @returns {boolean}
 */
export function isRevoked(reason) {
  return reason === 'shell-outdated' || reason === 'below-min' || reason === 'no-target';
}

/**
 * 是否该提示「已就绪待刷新」：确有另一份发布物已下载，且未被锁定/未被用户「稍后」掉。
 * 三个入参统一按**发布身份**说话（由 pendingIdentity 得出），本函数不再自己推版本号高低：
 * 正式通道下身份串就是版本号（行为一字不变），快照通道下同号不同摘要也算「有待生效」。
 * @param {{state?:string, pendingId?:string, locked?:boolean, dismissedId?:string}} p 上下文
 * @returns {boolean}
 */
export function shouldPromptUpdate({
  state = '',
  pendingId = '',
  locked = false,
  dismissedId = '',
} = {}) {
  if (state === STATE.UNCONFIGURED) return false;
  if (locked || !pendingId) return false;
  if (dismissedId && dismissedId === pendingId) return false;
  return true;
}

/**
 * 图标角标是否该亮：有已下载的另一份发布物、且未锁定即为真。
 * 与 shouldPromptUpdate 只差「稍后」这一维——横幅是一次性告知，玩家点了稍后就该消失；
 * 小圆点是常驻的低打扰提醒，留着不至于让已下载的新版彻底隐身。
 * @param {Parameters<typeof shouldPromptUpdate>[0]} p 同 shouldPromptUpdate（dismissedId 本判据不看）
 * @returns {boolean}
 */
export function shouldBadge({ state = '', pendingId = '', locked = false } = {}) {
  if (state === STATE.UNCONFIGURED) return false;
  return !locked && !!pendingId;
}

/**
 * 欢迎页页脚与横幅共用的就绪提示文案；无需提示时回空串（调用方据此整段不渲染）。
 * 文案里直接摆身份串：快照通道下那就是 `v1.0.0@03b39054`，玩家报障时念得出是哪一份正文。
 * @param {Parameters<typeof shouldPromptUpdate>[0]} p 同 shouldPromptUpdate
 * @returns {string}
 */
export function pendingNote(p = {}) {
  if (!shouldPromptUpdate(p)) return '';
  return `新版 v${p.pendingId} 已就绪，刷新页面即生效`;
}

/** @returns {SubtleCrypto} 平台 WebCrypto（缺失即抛，调用方按验签失败处理） */
function subtle() {
  const s = globalThis.crypto && globalThis.crypto.subtle;
  if (!s) throw new Error('crypto.subtle unavailable');
  return s;
}

/**
 * @param {string} text 正文
 * @returns {Uint8Array} UTF-8 字节
 */
function utf8(text) {
  return new TextEncoder().encode(String(text));
}

/**
 * @param {Uint8Array} bytes 摘要字节
 * @returns {string} 小写 hex
 */
function toHex(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += (bytes[i] + 0x100).toString(16).slice(1);
  return out;
}

/**
 * 正文 SHA-256（小写 hex）。构建侧用 node:crypto 的同一口径，两侧同构由单测守住。
 * @param {string} text 正文
 * @returns {Promise<string>}
 */
export async function digestHex(text) {
  const buf = await subtle().digest('SHA-256', utf8(text).buffer);
  return toHex(new Uint8Array(buf));
}

/**
 * 正文 HMAC-SHA256（小写 hex）；密钥按 UTF-8 字节参与运算，缺省取构建期内联值。
 * @param {string} text 正文
 * @param {string} [key] 密钥
 * @returns {Promise<string>}
 */
export async function hmacHex(text, key) {
  const k = key === undefined ? UPDATE_KEY : String(key);
  const c = subtle();
  const imported = await c.importKey(
    'raw',
    utf8(k).buffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await c.sign('HMAC', imported, utf8(text).buffer);
  return toHex(new Uint8Array(sig));
}

/**
 * 双验完整性：先比正文摘要，再比 HMAC。任一不符即回失败原因——这是被篡改的唯一信号，调用方须 warn 级记录。
 * @param {string} text 正文
 * @param {string} wantSha 清单给的 SHA-256
 * @param {string} wantHmac 清单给的 HMAC
 * @param {string} [key] HMAC 密钥（缺省取构建期内联值）
 * @returns {Promise<{ok:boolean, reason:string, sha256?:string}>}
 */
export async function verifyIntegrity(text, wantSha, wantHmac, key) {
  const want1 = lower(wantSha);
  const want2 = lower(wantHmac);
  if (!want1 || !want2) return { ok: false, reason: 'no-tag' };
  let sha;
  let mac;
  try {
    sha = await digestHex(text);
    mac = await hmacHex(text, key);
  } catch (e) {
    return { ok: false, reason: 'no-crypto' };
  }
  if (sha !== want1) return { ok: false, reason: 'sha-mismatch', sha256: sha };
  if (mac !== want2) return { ok: false, reason: 'hmac-mismatch', sha256: sha };
  return { ok: true, reason: '', sha256: sha };
}
