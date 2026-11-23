/**
 * pocketcc background service worker（MV3）
 * 两条职责：
 *   1. 代 bridge(ISOLATED) 向本地 dashcam 接收器发 POST，把录制报文与扩展日志落盘（报文只过路，写盘由 dashcam 工程负责）；
 *   2. 升级通道状态机：拉 latest.json、下远程体、验签、写全局缓存，并把状态广播给壳/远程体/面板。
 * 两件事都放这里而非 content/MAIN：service worker 用扩展自有源 + manifest host_permissions，
 * 不受游戏页 connect-src 与 https→http 混合内容限制，是绕开页面 CSP 的最干净出网口。
 * 判据全在 core/update.js（纯函数、可离线单测），本文件只做 I/O、状态持有与定时。
 * 状态机六态：unconfigured → idle → checking → uptodate | ready | failed；locked/autoCheck 为正交的用户开关位。
 */
import {
  BASELINE_URL,
  BUNDLE_TIMEOUT_MS,
  CACHE_KEY,
  CHECK_INTERVAL_MIN,
  LATEST_TIMEOUT_MS,
  PREF_KEY,
  STATE,
  STATE_KEY,
  WAKE_MIN_INTERVAL_MS,
  assertUrl,
  bumpFuse,
  chooseReady,
  configured,
  digestHex,
  fuseState,
  identityOf,
  isRevoked,
  latestUrl,
  parseLatest,
  pendingIdentity,
  pickBundle,
  shouldCheck,
  tagsFor,
  verifyIntegrity,
} from './core/update.js';

/** @type {string} 定时复检的 alarm 名（MV3 SW 会被回收，只能用 alarms，不能用 setInterval） */
const ALARM = 'pcc-update';

/** @type {{autoCheck:boolean, locked:boolean, dismissedId:string, blockedId:string}} 升级偏好（全局，冷启动 SW 也要读得到）；两个「版本号」位现在按**发布身份**记账（快照通道下同号不同摘要互不误伤） */
let pref = { autoCheck: true, locked: false, dismissedId: '', blockedId: '' };

/** @type {object} 对外快照（面板/角标/欢迎页共用；字段口径见 snapshot()） */
let snap = {
  state: STATE.IDLE,
  reason: '',
  runningVer: '',
  runningFrom: 'none',
  runningSha: '',
  readyVer: '',
  readySha: '',
  pendingId: '',
  checkedAt: 0,
  failCount: 0,
  lastErr: '',
  notes: '',
};

/** @type {boolean} 偏好与快照是否已从盘上读齐 */
let loaded = false;
/** @type {{ver:string, text:string, sha256:string, ts:number}|null} 已下载远程体的内存镜像 */
let cached = null;
/** @type {boolean} 缓存键是否已读过一次（避免每次判断都碰盘） */
let cacheLoaded = false;
/** @type {{ver:string, text:string, sha256:string}|null} 包内基线的内存镜像 */
let baseline = null;
/** @type {Promise<*>|null} 在途检查（并发去重：多个页面同时补检只跑一轮） */
let checking = null;

/**
 * 造一个带 reason 分类的错误（日志分级与 UI 文案都按 reason 走，不靠猜 message）
 * @param {string} message 描述
 * @param {string} reason 分类：network|timeout|http|no-manifest|no-tag|sha-mismatch|hmac-mismatch|no-crypto
 * @returns {Error}
 */
function fail(message, reason) {
  const e = new Error(message);
  /** @type {string} */
  e.reason = reason;
  return e;
}

/**
 * @param {unknown} e 异常
 * @returns {string} 可读原因
 */
function why(e) {
  return String((e && e.message) || e);
}

/**
 * 给 fetch 加时限并取文本；非 2xx、超时、网络错误都归一为带 reason 的 Error。
 * @param {string} url 目标地址
 * @param {number} ms 超时（毫秒）
 * @param {string} label 日志用标签
 * @returns {Promise<string>} 响应文本
 */
async function timedText(url, ms, label) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { cache: 'no-store', signal: ctrl.signal });
    if (!res.ok) throw fail(`${label} http ${res.status}`, 'http');
    return await res.text();
  } catch (e) {
    if (e && e.reason) throw e;
    if (ctrl.signal.aborted) throw fail(`${label} timeout after ${ms}ms`, 'timeout');
    throw fail(`${label}: ${why(e)}`, 'network');
  } finally {
    clearTimeout(timer);
  }
}

/** @returns {string} 扩展自身版本（= 包内基线版本，构建时与 package.json 同步） */
function shellVer() {
  return chrome.runtime.getManifest().version;
}

/**
 * 读齐偏好与快照（只真读一次）。dev 包未配置通道时状态直接归 unconfigured，不参与任何出网。
 */
async function loadOnce() {
  if (loaded) return;
  try {
    const o = await chrome.storage.local.get([PREF_KEY, STATE_KEY]);
    const p = o[PREF_KEY];
    if (p && typeof p === 'object') {
      pref = {
        autoCheck: p.autoCheck !== false,
        locked: !!p.locked,
        // 兼容读：storage 里两套键名都可能在。老键存的就是版本号，正式通道下身份串=版本号，拿来当 dismissedId/blockedId 零迁移（快照通道下顶多把那份记录当作「没点过稍后」）
        dismissedId: String(p.dismissedId || p.dismissedVer || ''),
        blockedId: String(p.blockedId || p.blockedVer || ''),
      };
    }
    const s = o[STATE_KEY];
    if (s && typeof s === 'object') {
      snap = Object.assign(snap, s, {
        checkedAt: Number(s.checkedAt) || 0,
        failCount: Math.max(0, Number(s.failCount) || 0),
      });
      // pendingVer / sha256 不是当前快照的字段（状态口径是 pendingId / runningSha / readySha），读进来即抹掉，不让废弃键长青
      delete snap.pendingVer;
      delete snap.sha256;
    }
  } catch (e) {
    console.warn('[pocketcc bg] update state load failed', e);
  }
  if (!configured()) snap.state = STATE.UNCONFIGURED;
  loaded = true;
}

/** @returns {Promise<void>} 落盘偏好 */
function savePref() {
  return chrome.storage.local.set({ [PREF_KEY]: pref }).catch(() => {});
}

/** @returns {object} 给 UI 与广播用的快照（含正交开关位） */
function snapshot() {
  return Object.assign({}, snap, {
    shellVer: shellVer(),
    autoCheck: pref.autoCheck,
    locked: pref.locked,
    dismissedId: pref.dismissedId,
    blockedId: pref.blockedId,
    fuseTripped: fuseState(snap.failCount).tripped,
    revoked: isRevoked(snap.reason),
  });
}

/**
 * 状态变更统一出口：落盘 + 广播给各 world（面板、角标、欢迎页脚据此同步）。
 * 无接收方（当前没有页面/弹窗）属正常场景，吞掉 lastError 即可。
 * @returns {object} 新快照
 */
function publish() {
  chrome.storage.local.set({ [STATE_KEY]: snap }).catch(() => {});
  try {
    chrome.runtime.sendMessage({ type: 'pcc-update-state', state: snapshot() }, () => {
      void chrome.runtime.lastError;
    });
  } catch (e) {
    // 扩展上下文失效等场景：状态已落盘，下轮自愈
  }
  return snapshot();
}

/**
 * 读已下载远程体（内存镜像优先；text 为空的半截记录按不存在处理，不得被执行）
 * @returns {Promise<{ver:string, text:string, sha256:string, ts:number}|null>}
 */
async function readCached() {
  if (cacheLoaded) return cached;
  cacheLoaded = true;
  try {
    const rec = (await chrome.storage.local.get(CACHE_KEY))[CACHE_KEY];
    cached =
      rec && rec.text
        ? {
            ver: String(rec.ver || ''),
            text: rec.text,
            sha256: String(rec.sha256 || ''),
            ts: Number(rec.ts) || 0,
          }
        : null;
  } catch (e) {
    console.warn('[pocketcc bg] bundle cache read failed', e);
    cached = null;
  }
  return cached;
}

/**
 * 读包内基线：SW 经 chrome.runtime.getURL 取自己的产物，不出网。
 * 版本取 manifest.version（与本次构建同批产出，天然一致）；摘要就地算一次后留档，
 * 供快照通道下「跑的是基线」的用户也能回答「我手上这份到底是哪一份正文」。
 * @returns {Promise<{ver:string, text:string, sha256:string}>}
 */
async function readBaseline() {
  if (baseline) return baseline;
  const res = await fetch(chrome.runtime.getURL(BASELINE_URL));
  if (!res.ok) throw fail(`baseline http ${res.status}`, 'http');
  const text = await res.text();
  if (!text) throw fail('baseline is empty', 'no-baseline');
  baseline = { ver: shellVer(), text: text, sha256: await digestHex(text) };
  return baseline;
}

/**
 * 取某个运行来源对应正文的摘要（none 回空串）。
 * @param {'cache'|'baseline'|'none'} from 来源
 * @returns {string}
 */
function shaOf(from) {
  if (from === 'cache') return (cached && cached.sha256) || '';
  if (from === 'baseline') return (baseline && baseline.sha256) || '';
  return '';
}

/**
 * 刷新的运行来源（runningVer/runningSha/runningFrom）与本地就绪版本、待生效身份三者一致。
 * 基线读不到不阻断——缓存那份照样能跑，只是降级面收窄。
 * @returns {Promise<{ready:{from:string, ver:string, text:string}, base:{ver:string, text:string, sha256:string}|null}>}
 */
async function loadLocal() {
  const c = await readCached();
  let base = null;
  try {
    base = await readBaseline();
  } catch (e) {
    snap.lastErr = why(e);
    console.warn('[pocketcc bg] baseline unreadable', e);
  }
  const ready = chooseReady({ cached: c, baseline: base });
  snap.readyVer = ready.ver;
  snap.readySha = shaOf(ready.from);
  // 待生效看「就绪那份 ≠ 正在运行那份」：正式通道即版本更高，快照通道同号但摘要不同也算
  snap.pendingId = pendingIdentity({
    runningVer: snap.runningVer,
    runningSha: snap.runningSha,
    readyVer: ready.ver,
    readySha: snap.readySha,
  });
  return { ready: ready, base: base };
}

/**
 * 回答壳的取包请求：同步返回本地已就绪的最优文本，绝不在此等网络。
 * @param {'ready'|'baseline'} prefer 取本地最优还是强制取包内基线（壳的降级路径）
 * @returns {Promise<{ver:string, from:string, text:string, state:object}>}
 */
async function serveBundle(prefer) {
  await loadOnce();
  const { ready, base } = await loadLocal();
  if (prefer === 'baseline') {
    if (!base) throw fail('baseline unreadable', 'no-baseline');
    snap.runningVer = base.ver;
    snap.runningSha = shaOf('baseline');
    snap.runningFrom = 'baseline';
    // 降级路径：明确选了基线，就别再催用户刷回那份刚抛错的缓存包
    snap.pendingId = '';
    publish();
    return { ver: base.ver, from: 'baseline', text: base.text, state: snapshot() };
  }
  if (!ready.text) throw fail('no runnable bundle', 'no-bundle');
  snap.runningVer = ready.ver;
  snap.runningSha = shaOf(ready.from);
  snap.runningFrom = ready.from;
  // 刚把某份交出去执行，它就不再是「待生效」
  snap.pendingId = '';
  publish();
  return { ver: ready.ver, from: ready.from, text: ready.text, state: snapshot() };
}

/**
 * 记一轮成功：失败计数清零、检查时刻刷新，并按是否真下载了新版落到 ready/uptodate。
 * @param {string} reason 决策原因
 */
function roundOk(reason) {
  snap.failCount = bumpFuse(snap.failCount, true);
  snap.checkedAt = Date.now();
  snap.reason = reason;
  snap.lastErr = '';
  snap.state =
    reason === 'newer' || snap.pendingId
      ? STATE.READY
      : isRevoked(reason)
        ? STATE.FAILED
        : STATE.UPTODATE;
}

/**
 * 记一轮失败：推进熔断计数，达到阈值即停用远程通道（下轮 alarms 自愈或由手动检查复活）。
 * 网络类只 info，验签类必须 warn——后者是被篡改的唯一信号。
 * @param {Error} e 带 reason 的错误
 */
function roundFail(e) {
  const reason = (e && e.reason) || 'network';
  snap.failCount = bumpFuse(snap.failCount, false);
  snap.checkedAt = Date.now();
  snap.state = STATE.FAILED;
  snap.reason = reason;
  snap.lastErr = why(e);
  const fuse = fuseState(snap.failCount);
  if (reason === 'sha-mismatch' || reason === 'hmac-mismatch' || reason === 'no-tag') {
    console.warn('[pocketcc bg] update integrity rejected (%s): %s', reason, snap.lastErr);
  } else {
    console.info('[pocketcc bg] update check failed (%s): %s', reason, snap.lastErr);
  }
  if (fuse.tripped) {
    console.warn('[pocketcc bg] update channel fused after %d consecutive failures', fuse.fails);
    snap.reason = 'fused';
  }
}

/**
 * 跑一轮检查：清单 → 决策 → 下载 → 双验 → 只写缓存（不碰正在运行的代码）。
 * @param {{force?:boolean}} [opts] force：手动检查/启动补检，绕过熔断与自动开关
 * @returns {Promise<object>} 新快照
 */
function runCheck(opts) {
  const force = !!(opts && opts.force);
  if (checking) return checking;
  checking = (async () => {
    await loadOnce();
    if (!configured()) {
      snap.state = STATE.UNCONFIGURED;
      snap.reason = 'unconfigured';
      return publish();
    }
    const fuse = fuseState(snap.failCount);
    if (fuse.tripped && !force) {
      snap.state = STATE.FAILED;
      snap.reason = 'fused';
      return publish();
    }
    snap.state = STATE.CHECKING;
    snap.reason = '';
    publish();
    try {
      const url = latestUrl(Date.now());
      if (!url) throw fail('update base not configured', 'unconfigured');
      const raw = await timedText(url, LATEST_TIMEOUT_MS, 'latest');
      const latest = parseLatest(raw);
      if (!latest) throw fail('latest.json unusable', 'no-manifest');
      const { ready } = await loadLocal();
      const d = pickBundle({
        readyVer: ready.ver,
        readySha: snap.readySha,
        latest: latest,
        shellVer: shellVer(),
        locked: pref.locked,
        blockedId: pref.blockedId,
      });
      if (d.action === 'download') {
        const fileUrl = assertUrl(d.file);
        if (!fileUrl) throw fail(`bad bundle path: ${d.file}`, 'bad-path');
        // 快照通道下同一版本号可能挂着好几份正文，故带 file 精确定位标签（按 file 找不着自动回落按版本）
        const tags = tagsFor(latest, d.ver, d.file);
        if (!tags.sha256 || !tags.hmac) throw fail(`no integrity tag for v${d.ver}`, 'no-tag');
        const text = await timedText(fileUrl, BUNDLE_TIMEOUT_MS, 'bundle');
        const v = await verifyIntegrity(text, tags.sha256, tags.hmac);
        if (!v.ok) throw fail(`verify ${v.reason}`, v.reason || 'no-crypto');
        cached = { ver: d.ver, text: text, sha256: v.sha256, ts: Date.now() };
        cacheLoaded = true;
        await chrome.storage.local.set({ [CACHE_KEY]: cached });
        snap.notes = String(latest.notes || '');
        await loadLocal();
        console.info('[pocketcc bg] remote bundle v%s ready (pending refresh)', d.ver);
        roundOk('newer');
      } else if (d.action === 'stay') {
        snap.notes = String(latest.notes || '');
        roundOk(d.reason);
      } else {
        // block-shell / block-unsupported：清单已停止支持本机，属人为吊销而非故障，不计入熔断
        snap.checkedAt = Date.now();
        snap.failCount = 0;
        snap.state = STATE.FAILED;
        snap.reason = d.reason;
        snap.lastErr = '';
      }
    } catch (e) {
      roundFail(e);
    }
    return publish();
  })().then(
    (r) => {
      checking = null;
      return r;
    },
    (e) => {
      checking = null;
      throw e;
    },
  );
  return checking;
}

/**
 * 丢弃已下载的包（用户「清除已下载包」、远程体执行抛错后的隔离都走这里）
 * @returns {Promise<void>}
 */
async function dropCache() {
  cached = null;
  cacheLoaded = true;
  await chrome.storage.local.remove(CACHE_KEY).catch(() => {});
  await loadLocal();
}

/**
 * 命令入口：面板与壳的写操作都收敛到这里，统一返回新快照。
 * @param {string} cmd 命令名
 * @param {object} args 参数
 * @returns {Promise<object>} 新快照
 */
async function runCmd(cmd, args) {
  await loadOnce();
  const a = args || {};
  if (cmd === 'state') return snapshot();
  // refresh：面板上的手动检查，一定真去拉一次清单；check：壳 exec 后的例行补检，受最小间隔与熔断约束，不把每次刷新页面都变成一次 OSS 请求
  if (cmd === 'refresh') return runCheck({ force: true });
  if (cmd === 'check') return runCheck({});
  if (cmd === 'clear') {
    await dropCache();
    snap.state = configured() ? STATE.IDLE : STATE.UNCONFIGURED;
    snap.reason = 'cleared';
    snap.pendingId = '';
    return publish();
  }
  if (cmd === 'lock' || cmd === 'unlock') {
    pref.locked = cmd === 'lock';
    await savePref();
    return publish();
  }
  if (cmd === 'auto') {
    pref.autoCheck = !!a.value;
    await savePref();
    syncAlarm();
    return publish();
  }
  if (cmd === 'dismiss') {
    // 「稍后」记的是发布身份（面板从快照 pendingId 拿到什么就回传什么，依旧走 ver 这个字段位）：
    // 快照通道下同号发了新正文，旧记录不该把新的也闷掉
    pref.dismissedId = String(a.ver || '');
    await savePref();
    return publish();
  }
  if (cmd === 'quarantine') {
    // 远程体执行抛错：把那一份隔离，避免每次刷新都撞同一个坑；同时丢缓存退包内基线
    pref.blockedId = identityOf(String(a.ver || ''), snap.runningSha);
    await savePref();
    await dropCache();
    snap.state = configured() ? STATE.FAILED : STATE.UNCONFIGURED;
    snap.reason = 'exec-failed';
    snap.lastErr = String(a.why || '');
    console.warn(
      '[pocketcc bg] %s quarantined after exec failure: %s',
      pref.blockedId,
      snap.lastErr,
    );
    return publish();
  }
  throw fail(`unknown update cmd: ${cmd}`, 'bad-cmd');
}

/** 按配置与开关位对齐 alarm：未配置或关了自动检查就不留定时器 */
function syncAlarm() {
  if (!configured() || !pref.autoCheck) {
    chrome.alarms.clear(ALARM, () => void chrome.runtime.lastError);
    return;
  }
  chrome.alarms.create(ALARM, { periodInMinutes: CHECK_INTERVAL_MIN });
}

/**
 * SW 唤醒即检：MV3 下 worker 每次复活都会跑到这里，故受最小间隔约束，防打爆清单地址。
 * @param {{force?:boolean}} [opts] force：安装/启动这类明确时机
 */
function wakeCheck(opts) {
  Promise.resolve()
    .then(() => loadOnce())
    .then(() => {
      syncAlarm();
      if (!configured()) {
        snap.state = STATE.UNCONFIGURED;
        publish();
        return undefined;
      }
      if (
        !shouldCheck({
          now: Date.now(),
          lastCheckedAt: snap.checkedAt,
          minIntervalMs: WAKE_MIN_INTERVAL_MS,
          autoCheck: pref.autoCheck,
          force: !!(opts && opts.force),
        })
      ) {
        return undefined;
      }
      return runCheck({});
    })
    .catch((e) => console.info('[pocketcc bg] wake check skipped:', why(e)));
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && (msg.type === 'dashcam-flush' || msg.type === 'dashcam-log-flush')) {
    // 异步回执：return true 保持端口；失败/无接收器回 err 仅供诊断，bridge 侧已忽略、不阻断录制。
    ingest(msg)
      .then((status) => sendResponse({ ok: status }))
      .catch((e) => sendResponse({ err: String(e) }));
    return true;
  }
  if (msg && msg.type === 'pcc-update') {
    const task =
      msg.op === 'update-bundle'
        ? serveBundle(msg.prefer)
        : runCmd(msg.cmd, { ver: msg.ver, why: msg.why, value: msg.value });
    task
      .then((data) => sendResponse({ ok: true, data: data }))
      .catch((e) => sendResponse({ ok: false, err: why(e) }));
    return true;
  }
  // 其余消息非本 worker 职责，不响应。
  return false;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm && alarm.name === ALARM) runCheck({});
});

chrome.runtime.onInstalled.addListener(() => wakeCheck({ force: true }));
chrome.runtime.onStartup.addListener(() => wakeCheck({ force: true }));

// 顶层即执行：MV3 SW 每次被消息/事件唤醒都会重跑这里，构成「唤醒即检」的第四个触发源。
wakeCheck({});

/**
 * 把一批 NDJSON 报文 POST 到转发地址，携会话元数据头供 dashcam 命名与建索引。
 * 同形复用：日志上送（dashcam-log-flush）走同一函数发 /log 端点，多带 x-run、缺省会话头落空串即可。
 * @param {{url?:string, session?:string, ndjson?:string, uid?:string, startTs?:number, note?:string, done?:boolean, run?:string}} msg
 * @returns {Promise<number>} HTTP 状态码
 */
async function ingest(msg) {
  const res = await fetch(msg.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-ndjson',
      'x-session': String(msg.session || ''),
      'x-run': String(msg.run || ''),
      'x-uid': String(msg.uid || ''),
      'x-start': String(msg.startTs || ''),
      // HTTP 头只能携 Latin-1；note 可能含中文，必须 percent 编码，dashcam 侧 decodeURIComponent。
      'x-note': encodeURIComponent(String(msg.note || '')),
      'x-done': msg.done ? '1' : '',
    },
    body: String(msg.ndjson || ''),
  });
  return res.status;
}
