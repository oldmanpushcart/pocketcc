// 扩展弹出页（工具栏 action popup）——登录凭证导入/导出的唯一入口。
// 为什么放 popup：菜单面板要主城就绪 mountUI 后可见（boot.js 时序），而「导入凭证」恰恰发生在
// 尚未登录时（换机/清缓存/新浏览器），popup 入口不受登录态约束，随时可点。
// 数据流：
//   游戏 token 只存在于游戏页 localStorage（真键 topwar_ 前缀，游戏 LocalStorageUtils 所写，
//   键名不硬编码——凡 topwar_*_serverToken 一律纳入，web/app 变体通吃）；
//   popup 经 chrome.scripting 注函数到游戏 tab 的 MAIN world 读写（注入函数自包含、不 import 本包符号）；
//   导入写完 tabs.reload → 页面重载 → boot 的 installAutoLogin 同步重放，闭环无需额外生效路径。
// 合规红线（与 net-guard 口径一致）：凭证 = 账号登录权限，只做本地文件读写与剪贴板，零网络外发；
//   token 原文不进任何日志/状态文案（只展示平台名与前后片段掩码）。
// 文件格式即用户定稿的扁平 JSON：{"topwar_app_serverToken":"<base64 token>"}。
// 键名必须落在回放源上：auto-login 只读 app_serverToken（真键 topwar_app_serverToken），
// 别名键（如 topwar_web_serverToken）写入后无人读取，表现为「导入成功但不自动登录」，故导入侧统一归一。

/** @type {string} 游戏页匹配模式（与 manifest content_scripts 同源；仅作 chrome.tabs.query 的 URL 过滤兜底） */
const GAME_URL_PATTERN = 'https://warh5.rivergame.net/*';

/** @type {string} 回放源真键：auto-login 经 LocalStorageUtils.get('app_serverToken') 读它，改这里等于断开重放 */
const REPLAY_KEY = 'topwar_app_serverToken';

/** 形似凭证键：可带 topwar_ 前缀与平台段（app_/web_/…），如 topwar_web_serverToken */
const TOKEN_KEY_RE = /^(?:topwar_)?(?:[a-z]+_)?serverToken$/i;

/**
 * 注入入口（MAIN world 执行）：凭证读写共用一个自包含函数（靠 toString 注入，引不到模块级符号，
 * 故读写合一而不是拆两个函数——拆开会把剥壳逻辑复制两份）。
 * 壳处理：游戏 LocalStorageUtils 落盘时自己包一层 JSON 字符串，localStorage 里读到的是带引号的
 * `"ND…"`；导出必须是裸 token（定稿格式 {"topwar_app_serverToken":"ND…"}），故读剥一层；
 * 写回时再包回这层壳（游戏侧格式）。写侧不再兼容带引号的入参——导入只接受裸 token。
 * @param {'read'|'write'} mode read=采集全部凭证；write=按 entries 写入
 * @param {Record<string, string>} [entries] write 模式的键值（裸 token）
 * @returns {Record<string, string>|string[]} read 返回键→裸 token；write 返回实际写入的键列表
 */
function tokenStoreMain(mode, entries) {
  if (mode === 'read') {
    var out = {};
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (!k || !/^topwar_.+_serverToken$/.test(k)) continue;
      var v = localStorage.getItem(k);
      if (!v) continue;
      // 剥一层 JSON 字符串壳（仅当 parse 结果确实是字符串），不误伤非 JSON 落盘的键
      try {
        var inner = JSON.parse(v);
        out[k] = typeof inner === 'string' ? inner : v;
      } catch (e) {
        out[k] = v;
      }
    }
    return out;
  }
  var written = [];
  for (var key in entries) {
    localStorage.setItem(key, JSON.stringify(entries[key]));
    written.push(key);
  }
  return written;
}

/**
 * 判断一个 tab 的 URL 是否游戏页
 * @param {string|undefined} url tab URL（activeTab 授权下才可读）
 * @returns {boolean}
 */
function isGameUrl(url) {
  return !!url && url.startsWith('https://warh5.rivergame.net/');
}

/**
 * 找可操作的游戏 tab。
 * 首选「当前窗口的活动 tab」：manifest 用 activeTab 授权，点图标那一刻恰好覆盖该 tab（URL 与注入权都有）；
 * 退一步按 URL 过滤查全窗口（需 host/tabs 权限，activeTab 下可能查不到，故 try 兜住）。
 * @returns {Promise<chrome.Tabs.Tab|null>}
 */
async function findGameTab() {
  try {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (active && isGameUrl(active.url || active.pendingUrl)) return active;
  } catch (e) {
    // activeTab 未授权等：落到下一路
  }
  try {
    const tabs = await chrome.tabs.query({ url: GAME_URL_PATTERN });
    if (!tabs.length) return null;
    return tabs.find((t) => t.status === 'complete') || tabs[0];
  } catch (e) {
    return null;
  }
}

/**
 * 在游戏 tab 的 MAIN world 注入执行一个自包含函数
 * @param {number} tabId 目标 tab
 * @param {Function} func 注入函数（不得引用本包闭包符号）
 * @param {unknown[]} [args] 注入参数（可序列化值）
 * @returns {Promise<unknown>} 函数返回值
 */
async function inject(tabId, func, args) {
  const [r] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func,
    args: args || [],
  });
  return r && r.result;
}

/**
 * Base64 解码 token 做格式校验并取平台名（token 明文为逗号字段：字段0,platform,…，见 auto-login.js）
 * 入参必须是裸 token：带引号/已包壳的串直接判不合法（不再做兼容纠正）。
 * @param {string} token base64 串
 * @returns {{ok: boolean, platform: string|null, hint: string}} ok=形态合法；hint 供展示
 */
function inspectToken(token) {
  try {
    const raw = String(token).trim();
    const decoded = decodeURIComponent(
      Array.from(
        atob(raw.replace(/-/g, '+').replace(/_/g, '/')),
        (c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0'),
      ).join(''),
    );
    const fields = decoded.split(',');
    if (fields.length < 2 || !fields[1]) {
      return { ok: false, platform: null, hint: '解码后无 platform 字段' };
    }
    return { ok: true, platform: fields[1], hint: '' };
  } catch (e) {
    return { ok: false, platform: null, hint: 'Base64 解不出 UTF-8' };
  }
}

/**
 * 校验一份导入对象：必须是纯对象、值全为非空字符串、且至少一枚 token 形态合法。
 * 凭证键一律归一到 REPLAY_KEY（回放源），否则写进别名键等于静默失效。
 * @param {unknown} obj 解析后的 JSON
 * @returns {{entries: Record<string, string>, bad: string[], good: string[], renamed: string[]}}
 * @throws {Error} 结构完全不合法时
 */
function validateImport(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error(`格式不符：应为 {"${REPLAY_KEY}":"…"} 扁平 JSON 对象`);
  }
  const entries = {};
  const bad = [];
  const good = [];
  const renamed = [];
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v !== 'string' || !v.trim()) {
      bad.push(k + '(值非字符串/为空)');
      continue;
    }
    const token = v.trim();
    const insp = inspectToken(token);
    if (!insp.ok) {
      bad.push(k + '(' + insp.hint + ')');
      continue;
    }
    const target = TOKEN_KEY_RE.test(k) ? REPLAY_KEY : k;
    if (target !== k) renamed.push(k + '→' + target);
    entries[target] = token;
    if (!good.includes(target)) good.push(target);
  }
  if (!good.length) throw new Error('没有一枚形态合法的 token：' + (bad.join('、') || '输入为空'));
  return { entries, bad, good, renamed };
}

/** 生成导出文件名（不含 token 信息，只用时间戳） */
function exportFileName() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `pocketcc-credentials-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.json`;
}

/**
 * 保存文本：文件对话框 → 剪贴板 → 回填到粘贴框（三级退化，任何一级都可能因环境/手势失效）
 * @param {string} text 文件内容
 * @returns {Promise<'file'|'clipboard'|'textarea'>} 实际落点
 */
async function saveText(text) {
  if (self.showSaveFilePicker) {
    try {
      const h = await self.showSaveFilePicker({
        suggestedName: exportFileName(),
        types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }],
      });
      const w = await h.createWritable();
      await w.write(text);
      await w.close();
      return 'file';
    } catch (e) {
      // 用户主动取消：不再静默换落点（会造成「到底存哪了」的困惑），原样上抛由调用方提示
      if (e && e.name === 'AbortError') throw e;
      // 其余异常（手势过期/环境不支持）才继续退化
    }
  }
  try {
    await navigator.clipboard.writeText(text);
    return 'clipboard';
  } catch (e) {
    // 剪贴板也被拒（无手势）：把原文回填到粘贴框，让用户自己复制，绝不静默丢内容
    document.getElementById('paste').value = text;
    return 'textarea';
  }
}

/** @param {string} msg 展示到状态行 @param {boolean} [warn] 未就绪/异常态转警色（同面板 .pc-world.warn 口径） */
function setStatus(msg, warn) {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.className = 'status' + (warn ? ' warn' : '');
}

/**
 * 展示操作结果（token 只报键名与平台名，不落原文）
 * @param {string} msg 文案
 * @param {boolean} ok 成功态着色
 */
function showResult(msg, ok) {
  const el = document.getElementById('result');
  el.textContent = msg;
  el.className = 'result ' + (ok ? 'ok' : 'err');
}

/** 导出主流程：读游戏 tab 凭证 → 格式化 → 本地保存 */
async function doExport() {
  showResult('', true);
  const tab = await findGameTab();
  if (!tab) {
    showResult('没找到已打开的游戏页（warh5.rivergame.net），请先打开游戏页再导出。', false);
    return;
  }
  let tokens;
  try {
    tokens = await inject(tab.id, tokenStoreMain, ['read']);
  } catch (e) {
    showResult('注入失败（页面可能正在加载或扩展刚更新）：' + String(e.message || e), false);
    return;
  }
  if (!tokens || !Object.keys(tokens).length) {
    showResult(
      '游戏页 localStorage 里没有 topwar_*_serverToken 登录凭证——需先在游戏里完成一次登录。',
      false,
    );
    return;
  }
  const text = JSON.stringify(tokens, null, 2);
  try {
    const where = await saveText(text);
    const how =
      where === 'file'
        ? '到所选文件。'
        : where === 'clipboard'
          ? '到剪贴板（当前环境不支持文件保存对话框）。'
          : '到下方粘贴框（文件与剪贴板都不可用，请手动复制保存）。';
    showResult(
      `已导出 ${Object.keys(tokens).length} 枚凭证（${Object.keys(tokens).join('、')}）${how}`,
      true,
    );
  } catch (e) {
    if (e && e.name === 'AbortError') showResult('已取消保存。', false);
    else showResult('保存失败：' + String(e.message || e), false);
  }
}

/**
 * 导入主流程：解析文本 → 校验 → 写入游戏 tab → 刷新页面触发重放
 * @param {string} text 凭证 JSON 文本
 */
async function doImport(text) {
  showResult('', true);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    showResult('JSON 解析失败：' + String(e.message || e), false);
    return;
  }
  let v;
  try {
    v = validateImport(parsed);
  } catch (e) {
    showResult(String(e.message || e), false);
    return;
  }
  const tab = await findGameTab();
  if (!tab) {
    showResult(
      '没找到已打开的游戏页（warh5.rivergame.net）——导入需至少开一个游戏页（不用登录）。',
      false,
    );
    return;
  }
  try {
    await inject(tab.id, tokenStoreMain, ['write', v.entries]);
  } catch (e) {
    showResult('写入失败（页面可能正在加载或扩展刚更新）：' + String(e.message || e), false);
    return;
  }
  const platforms = [...new Set(v.good.map((k) => inspectToken(v.entries[k]).platform))].join('/');
  showResult(
    `已写入 ${v.good.length} 枚凭证（${v.good.join('、')}，平台 ${platforms}）` +
      (v.renamed.length ? `；键名已归一：${v.renamed.join('、')}` : '') +
      (v.bad.length ? `；跳过 ${v.bad.length} 枚不合法：${v.bad.join('、')}` : '') +
      '。2 秒后刷新游戏页，由免扫码链路自动重放登录…',
    true,
  );
  setTimeout(() => {
    chrome.tabs.reload(tab.id);
  }, 2000);
}

/** popup 打开时探测一次当前凭证状态（只报键名/平台/掩码片段） */
async function probeStatus() {
  const tab = await findGameTab();
  if (!tab) {
    setStatus('未打开游戏页。导出/导入前请先打开 warh5.rivergame.net（不用登录）。', true);
    return;
  }
  try {
    const tokens = await inject(tab.id, tokenStoreMain, ['read']);
    const keys = tokens ? Object.keys(tokens) : [];
    if (!keys.length) {
      setStatus('游戏页已打开，暂无登录凭证（先正常登录一次即可导出）。', true);
      return;
    }
    const bits = keys.map((k) => {
      const insp = inspectToken(tokens[k]);
      const masked = tokens[k].slice(0, 6) + '…' + tokens[k].slice(-4);
      return `${k}${insp.ok ? `（平台 ${insp.platform}）` : '（形态异常）'} ${masked}`;
    });
    setStatus('当前凭证：' + bits.join('；'));
  } catch (e) {
    setStatus('游戏页已打开，但注入探测失败（稍后重试）：' + String(e.message || e), true);
  }
}

// 事件绑定一律先做：前面的定位/探测任何一步抛错，都不能让整页按钮变成哑巴。
document.getElementById('btn-export-file').addEventListener('click', () => {
  doExport().catch((e) => showResult('导出异常：' + String(e && e.message), false));
});
document.getElementById('btn-export-copy').addEventListener('click', async () => {
  showResult('', true);
  const tab = await findGameTab();
  if (!tab) {
    showResult('没找到已打开的游戏页。', false);
    return;
  }
  try {
    const tokens = await inject(tab.id, tokenStoreMain, ['read']);
    if (!tokens || !Object.keys(tokens).length) {
      showResult('游戏页暂无登录凭证。', false);
      return;
    }
    await navigator.clipboard.writeText(JSON.stringify(tokens, null, 2));
    showResult('凭证 JSON 已复制到剪贴板（勿转发他人）。', true);
  } catch (e) {
    showResult('复制失败：' + String(e.message || e), false);
  }
});
document.getElementById('btn-import-paste').addEventListener('click', async () => {
  const text = document.getElementById('paste').value;
  if (!text.trim()) {
    showResult('粘贴框为空。', false);
    return;
  }
  await doImport(text);
});

// 拖放导入：把凭证 JSON 文件从资源管理器拖进虚线框，读出文本自动填入粘贴框。
// 为什么用拖拽而不是 <input type=file> / showOpenFilePicker：原生文件对话框会抢走焦点，
// 导致 action popup 被销毁、await 后续永不执行（旧「选择文件…」按钮「选了没反应」的根因）；
// 拖拽不弹任何原生窗，popup 全程存活，读完即可回填。
const dropEl = document.getElementById('drop');
const pasteEl = document.getElementById('paste');
/** @param {boolean} on 拖拽悬停时高亮虚线框 */
const hiDrop = (on) => dropEl.classList.toggle('over', on);
dropEl.addEventListener('dragenter', (e) => {
  e.preventDefault();
  hiDrop(true);
});
dropEl.addEventListener('dragover', (e) => {
  e.preventDefault();
  hiDrop(true);
});
dropEl.addEventListener('dragleave', (e) => {
  e.preventDefault();
  hiDrop(false);
});
dropEl.addEventListener('drop', async (e) => {
  e.preventDefault();
  hiDrop(false);
  const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (!f) {
    showResult('没拖到文件。', false);
    return;
  }
  let text;
  try {
    text = await f.text();
  } catch (err) {
    showResult('读取文件失败：' + String(err && err.message), false);
    return;
  }
  pasteEl.value = text;
  showResult('已把文件「' + f.name + '」载入粘贴框，点「导入粘贴内容」完成写入。', true);
});

document.getElementById('foot').textContent =
  `pocketcc v${chrome.runtime.getManifest().version} · 凭证仅本地读写，零外发`;
probeStatus().catch(() => {});
