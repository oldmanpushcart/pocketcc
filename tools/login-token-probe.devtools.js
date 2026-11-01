/**
 * 登录 token 提取 + 有效期判定探针（DevTools 一次性粘贴运行，需在页面主世界控制台执行）
 *
 * 背景（静态实证，见 references/历史文档/免扫码登录技术方案.md 与 auto-login.js）：
 *   游戏侧的「登录 token」有两层：
 *     ① serverToken —— PlatformCore 内存态 + localStorage['topwar_app_serverToken']，
 *        Base64( 字段0,platform,… )，是免扫码重放用的凭证（本探针的主对象）；
 *     ② 平台登录 code —— GlobalData.GLOBAL.token，每次平台登录由 e.code 回填。
 *   游戏代码里不存在任何本地「有效期」字段（PlatformCore/PlatformCommon/GlobalData 均无
 *   expire 符号；saveServerToken 只存不判期）→ 有效期由服务端判定。
 *   本探针【不向任何服务器发送凭证】，只做本地判定 + 被动观测：
 *     A. 解析路：Base64 解码 → 逗号拆字段 → 逐个字段做 epoch 秒/毫秒与 JWT exp 启发式，
 *        字段里有时间戳就直接算签发时刻/剩余期；
 *     B. 观测路：不主动发请求；只 passively hook fetch/XHR 观测【游戏自己】发出的登录流
 *        请求（serverList 等）里是否携带本凭证、应答 status 是否非 0（游戏自身重放被拒的
 *        即过期信号）。hook 只记账不改请求，卸载即还原。
 *
 * 用法：
 *   1) 整段粘贴进 DevTools Console 回车 → 自动做 A（纯只读，零副作用）；
 *   2) window.tokenProbe.report()   —— 重看结构化结果；
 *   3) window.tokenProbe.observe()  —— 装被动观测器（零外发），之后刷新/重进登录流程，
 *      游戏自己携带凭证的请求时刻与应答 status 会记进 tokenProbe.observeLog（只留指纹）；
 *   4) window.tokenProbe.finalize() —— 结合观测记录估算凭证存续时长与有效窗；
 *   5) window.tokenProbe.unobserve()—— 还原 fetch/XHR。
 *
 * 合规：零网络外发（探针自身不发任何请求）；只读 localStorage/内存；hook 只记账不改写；
 *   观测日志不落凭证原文（仅 SHA-256 指纹与前后 6 位片段）；不改游戏数据、不写存储、不 OpenUI。
 */
(function () {
  // ---------- 游戏模块软取（不依赖 pocketcc 扩展，__require 缺失时退化到 localStorage） ----------
  /**
   * @param {string} name 游戏模块名
   * @param {string} [inner] 具名导出（如 PlatformCore 模块的 .PlatformCore）
   * @returns {any|null}
   */
  function req(name, inner) {
    try {
      const m = typeof window.__require === 'function' ? window.__require(name) : null;
      if (!m) return null;
      return inner ? m[inner] || m.default || m : m;
    } catch {
      return null;
    }
  }
  const GlobalData = req('GlobalData', 'GLOBAL');
  const PlatformCore = req('PlatformCore', 'instance');
  const LocalStorageUtils = req('LocalStorageUtils');

  // ---------- Base64 解码（atob 兼容非 ASCII，优先游戏在场时的 CryptoJS） ----------
  /** @param {string} b64 @returns {string|null} 解不出 UTF-8 返回 null */
  function b64decode(b64) {
    try {
      if (window.CryptoJS && window.CryptoJS.enc && window.CryptoJS.enc.Base64) {
        return window.CryptoJS.enc.Utf8.stringify(window.CryptoJS.enc.Base64.parse(b64));
      }
    } catch { /* 落回 atob */ }
    try {
      const bin = atob(b64.replace(/-/g, '+').replace(/_/g, '/'));
      const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
      return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    } catch {
      return null;
    }
  }

  /** 读 localStorage 原始值并尽量剥掉 LocalStorageUtils 的 JSON 包装（真键 = topwar_ + 逻辑键） */
  function lsRead(logicalKey) {
    const raw = localStorage.getItem('topwar_' + logicalKey);
    if (raw == null) return null;
    try {
      const v = JSON.parse(raw);
      return typeof v === 'string' ? v : v;
    } catch {
      return raw;
    }
  }

  // ---------- 字段解析：逗号拆分 + 时间戳/JWT 启发式 ----------
  const NOW_S = Math.floor(Date.now() / 1000);
  /** 合理 epoch 区间：2015-01-01 ~ 2040-01-01（秒） */
  const S_LO = 1420070400, S_HI = 2208988800;

  /**
   * 单字段判定：epoch 秒 / epoch 毫秒 / JWT（xxx.yyy.zzz，解 exp）
   * @param {string} field
   * @returns {{kind:string, note:string, atSec:number|null}|null} 普通字符串返回 null
   */
  function classify(field) {
    const s = String(field).trim();
    if (/^\d+$/.test(s)) {
      const n = Number(s);
      if (s.length === 13 && n / 1000 >= S_LO && n / 1000 <= S_HI) {
        return { kind: 'epoch_ms', atSec: Math.floor(n / 1000), note: new Date(n).toLocaleString() };
      }
      if (s.length === 10 && n >= S_LO && n <= S_HI) {
        return { kind: 'epoch_s', atSec: n, note: new Date(n * 1000).toLocaleString() };
      }
      return null;
    }
    if (/^[\w-]+\.[\w-]+\.[\w-]*$/.test(s)) {
      try {
        const payload = JSON.parse(b64decode(s.split('.')[1]) || '');
        if (payload && (payload.exp || payload.iat || payload.nbf)) {
          const bits = [];
          if (payload.iat) bits.push('iat=' + new Date(payload.iat * 1000).toLocaleString());
          if (payload.nbf) bits.push('nbf=' + new Date(payload.nbf * 1000).toLocaleString());
          if (payload.exp) bits.push('exp=' + new Date(payload.exp * 1000).toLocaleString());
          return {
            kind: 'jwt',
            atSec: payload.exp ? Number(payload.exp) : null,
            note: bits.join(', ') + (payload.exp ? `，剩余 ${fmtDur(payload.exp - NOW_S)}` : ''),
          };
        }
      } catch { /* 不是合法 JWT，按普通字符串 */ }
    }
    return null;
  }

  /** 秒 → 人话时长（可为负） */
  function fmtDur(sec) {
    const sign = sec < 0 ? '-' : '';
    let n = Math.abs(Math.floor(sec));
    const u = [[86400, '天'], [3600, '时'], [60, '分'], [1, '秒']];
    const parts = [];
    for (const [k, name] of u) {
      if (n >= k || (parts.length && name !== '秒')) { parts.push(Math.floor(n / k) + name); n %= k; }
      if (!n) break;
    }
    return sign + (parts.join('') || '0秒');
  }

  /**
   * 解析一枚 token：Base64 → 逗号字段 → 逐字段启发式；给出有效期结论或「字段不含时间戳」
   * @param {string} value
   * @returns {{decoded:string|null, fields:Array, expiry:object}}
   */
  function parseToken(value) {
    const decoded = b64decode(value);
    const fields = [];
    const hits = [];
    if (decoded) {
      decoded.split(',').forEach((f, i) => {
        const c = classify(f);
        fields.push({
          idx: i,
          raw: f.length > 120 ? f.slice(0, 120) + `…(${f.length})` : f,
          as: c ? `${c.kind}@${c.note}` : null,
        });
        if (c && c.atSec != null) hits.push({ idx: i, ...c });
      });
    }
    let expiry;
    if (!decoded) {
      expiry = { verdict: 'NOT_BASE64', detail: 'Base64 解不出 UTF-8，可能是加密态或已损坏' };
    } else if (hits.length) {
      const expHit = hits.find((h) => h.kind === 'jwt' && h.atSec > NOW_S) || hits[hits.length - 1];
      const past = expHit.atSec <= NOW_S;
      expiry = {
        verdict: past ? 'LIKELY_EXPIRED' : 'LIKELY_VALID',
        detail: `字段[${expHit.idx}] 为 ${expHit.kind}：${new Date(expHit.atSec * 1000).toLocaleString()}，` +
          (past ? `已过期 ${fmtDur(NOW_S - expHit.atSec)}` : `剩余 ${fmtDur(expHit.atSec - NOW_S)}`) +
          '（启发式；可用 observe() 被动观测游戏自身的重放应答做校准）',
        atSec: expHit.atSec,
      };
    } else {
      expiry = {
        verdict: 'NO_TIMESTAMP_FIELD',
        detail: 'token 明文为逗号字段但不含任何 epoch/JWT 时间戳 → 客户端拿不到有效期；' +
          '凭证不外发，可用 observe() 记录游戏自身登录请求的签发时刻与应答做本地估算',
      };
    }
    return { decoded, fields, expiry };
  }

  // ---------- 采集候选 token ----------
  function collect() {
    const out = [];
    /** @param {string} source @param {string|null} value @param {string} where */
    const push = (source, value, where) => {
      if (value == null || value === '' ) {
        out.push({ source, where, present: false });
        return;
      }
      const p = parseToken(String(value));
      out.push({
        source, where, present: true,
        token: String(value),
        length: String(value).length,
        platformField: p.decoded ? p.decoded.split(',')[1] ?? null : null,
        ...p,
      });
    };
    // ① PlatformCore 内存态（游戏当前正在用的 serverToken；游戏未暴露 getter，实例上的
    //    serverToken/U 类字段名未实证，逐个候选探一下，探不到以 localStorage 缓存为准）
    let memToken = null;
    if (PlatformCore) {
      for (const k of ['getServerToken', 'serverToken', 'U', '_serverToken']) {
        try {
          const v = typeof PlatformCore[k] === 'function' ? PlatformCore[k]() : PlatformCore[k];
          if (typeof v === 'string' && v) { memToken = v; break; }
        } catch { }
      }
    }
    push('serverToken(内存)', memToken, 'PlatformCore.instance 实例字段探测（可能为空，属正常）');
    // ② localStorage 缓存（免扫码重放源；LSU 读取自带 JSON 剥壳）
    let cached;
    try { cached = LocalStorageUtils ? LocalStorageUtils.get('app_serverToken') : lsRead('app_serverToken'); } catch { cached = lsRead('app_serverToken'); }
    push('serverToken(缓存)', typeof cached === 'string' ? cached : null, "localStorage['topwar_app_serverToken']");
    // ③ 平台登录 code（GLOBAL.token）
    let code = null;
    try { code = GlobalData && GlobalData.token; } catch { }
    push('平台登录code', code, 'GlobalData.GLOBAL.token');
    // ④ loginFlowArgs.serverInfoToken（启动预填兜底源）
    try {
      const flow = LocalStorageUtils ? LocalStorageUtils.get('app_loginFlowArgs') : lsRead('app_loginFlowArgs');
      push('serverInfoToken', flow && flow.serverInfoToken, "localStorage['topwar_app_loginFlowArgs'].serverInfoToken");
    } catch { }
    // ⑤ webgameqq 附加凭证（access_token+openid，QQ 平台才有）
    let qq = null;
    try {
      qq = LocalStorageUtils ? LocalStorageUtils.get('app_webgameqqCode') : lsRead('app_webgameqqCode');
      if (typeof qq === 'string') {
        // 双重 JSON 包装是游戏实证格式，剥一层再展示
        try { qq = JSON.parse(qq); } catch { }
      }
    } catch { }
    out.push({
      source: 'webgameqqCode', where: "localStorage['topwar_app_webgameqqCode']",
      present: qq != null, value: qq,
      note: qq != null && typeof qq === 'object'
        ? `QQ 附加凭证 {access_token,openid}；access_token 若含 expires_in 字段则以该值为准` : undefined,
    });
    // ⑥ cookie 里的 session 类 token（顺带扫一眼，同源登录态常见落点）
    const cookies = document.cookie.split(';').map((c) => c.trim()).filter((c) => /token|session|auth/i.test(c));
    if (cookies.length) out.push({ source: 'cookie', where: 'document.cookie', present: true, items: cookies });
    return out;
  }

  // ---------- 被动观测器（零外发：探针不发送任何请求，只记账【游戏自己】发出的） ----------
  const observeLog = [];
  let observing = false, origFetch = null, origOpen = null, origSend = null;
  /** 登录流请求 URL 特征（游戏在这些请求里携带 token/serverInfoCode 类凭证） */
  const LOGIN_URL_RE = /serverList|appServerListServlet|getServerListForRole|frontconfigget/i;
  /** 参数名含 token 即凭证候选（token/serverInfoToken/…） */
  const TOKEN_KEY_RE = /token/i;

  /** 短指纹：只落 SHA-256 前 8 位与前后 6 位片段，观测日志不落凭证原文 */
  async function fingerprint(s) {
    try {
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
      const hex = Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
      return { hash: hex.slice(0, 8), head: s.slice(0, 6), tail: s.slice(-6) };
    } catch {
      return { hash: 'noprint', head: s.slice(0, 6), tail: s.slice(-6) };
    }
  }

  /**
   * 从一条请求 URL/参数里匹配凭证候选（键名含 token），与待测凭证比对只记指纹；
   * 同步阶段先取可同步拿到的字段（platform），指纹在微任务里补算，不阻塞游戏请求。
   */
  function scanCarried(url, rawQuery, bodyStr) {
    const params = {};
    for (const src of [rawQuery || '', bodyStr || '']) {
      for (const kv of String(src).split('&')) {
        const i = kv.indexOf('=');
        if (i > 0) {
          try { params[decodeURIComponent(kv.slice(0, i))] = decodeURIComponent(kv.slice(i + 1)); } catch { }
        }
      }
    }
    const entries = Object.entries(params).filter(([k]) => TOKEN_KEY_RE.test(k) && params[k]);
    if (!entries.length) return;
    const ts = Date.now();
    const rec = {
      ts,
      url: String(url).split('?')[0],
      carried: entries.map(([k, v]) => ({
        key: k,
        platform: (() => { const d = b64decode(v); const p = d && d.split(',')[1]; return p && p.length <= 20 ? p : null; })(),
      })),
    };
    observeLog.push(rec);
    entries.forEach(async ([k, v]) => {
      const fp = await fingerprint(v);
      const c = rec.carried.find((x) => x.key === k);
      if (c) Object.assign(c, fp);
    });
  }

  /** 应答侧只记 status 判据（不记内容），status!=0 是游戏自身重放被拒的过期信号 */
  function scanResponse(text, httpStatus, url) {
    if (!LOGIN_URL_RE.test(String(url))) return;
    let status;
    try { status = JSON.parse(text).status; } catch { }
    if (status === undefined && httpStatus < 200 && httpStatus >= 300) return;
    observeLog.push({ ts: Date.now(), url: String(url).split('?')[0], kind: 'response', httpStatus, status });
  }

  /** 装被动观测器：包一层 fetch/XHR 记录（不改请求不拦截），unobserve() 可还原 */
  function observe() {
    if (observing) return 'already observing';
    observing = true;
    origFetch = window.fetch;
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (LOGIN_URL_RE.test(url)) scanCarried(url, String(url).split('?')[1] || '', init && init.body != null ? String(init.body) : '');
      const p = origFetch.apply(this, arguments);
      if (LOGIN_URL_RE.test(url)) {
        p.then((res) => { try { res.clone().text().then((t) => scanResponse(t, res.status, url)); } catch { } }).catch(() => { });
      }
      return p;
    };
    origOpen = XMLHttpRequest.prototype.open;
    origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (m, u) { this.__tpUrl = u; return origOpen.apply(this, arguments); };
    XMLHttpRequest.prototype.send = function (body) {
      const u = this.__tpUrl || '';
      if (LOGIN_URL_RE.test(u)) {
        scanCarried(u, String(u).split('?')[1] || '', body != null ? String(body) : '');
        this.addEventListener('load', () => scanResponse(this.responseText, this.status, u));
      }
      return origSend.apply(this, arguments);
    };
    return 'observing（零外发）：只记账游戏自己发出的登录流请求；刷新/重进登录流程后回来看 tokenProbe.finalize()';
  }

  /** 还原 fetch/XHR */
  function unobserve() {
    if (!observing) return 'not observing';
    window.fetch = origFetch;
    XMLHttpRequest.prototype.open = origOpen;
    XMLHttpRequest.prototype.send = origSend;
    observing = false;
    return 'restored';
  }

  // ---------- 主流程 ----------
  const results = collect();
  const state = { results, observeLog, finalizeResult: null };

  function report() {
    const rows = [];
    for (const r of results) {
      if (r.source === 'webgameqqCode' || r.source === 'cookie') { rows.push(r); continue; }
      if (!r.present) { console.warn(`[token] ${r.source}: 未获取到（${r.where}）`); continue; }
      console.groupCollapsed(`[token] ${r.source}  len=${r.length}  platform=${r.platformField}`);
      console.log('token   :', r.token.length > 160 ? r.token.slice(0, 160) + '…' : r.token);
      console.log('decoded :', r.decoded);
      console.table(r.fields);
      console.log(`有效期  : ${r.expiry.verdict} — ${r.expiry.detail}`);
      console.groupEnd();
    }
    const main = results.find((r) => r.present && r.source.startsWith('serverToken'));
    console.log('%c结论', 'font-weight:bold', main
      ? `主凭证 ${main.source}：字段解析=${main.expiry.verdict}；客户端不存有效期字段属常态（静态实证）。凭证不外发，`
        + '有效期请用 tokenProbe.observe() 被动观测游戏自身的登录重放，再 tokenProbe.finalize() 结算。'
      : '没拿到 serverToken——当前页可能还没走完登录，或凭证被登出清理。');
    return state;
  }

  /** 结算：字段时间戳（若有）+ 被动观测记录 → 本地估算有效期；全程不发任何请求 */
  function finalize() {
    const main = results.find((r) => r.present && r.source.startsWith('serverToken'));
    if (!observeLog.length) {
      console.warn('[token] observeLog 为空：先 tokenProbe.observe() 再刷新/重进登录流程（探针自身不会发任何请求）');
    }
    const carries = observeLog.filter((e) => e.carried);
    const rejects = observeLog.filter((e) =>
      e.kind === 'response' && ((e.status !== undefined && String(e.status) !== '0') || e.httpStatus === 401 || e.httpStatus === 403));
    const issuedAt = carries.length ? Math.min(...carries.map((e) => e.ts)) : null;
    console.log('[token] 观测记录:', observeLog);
    let verdict;
    if (main && main.expiry.atSec != null) {
      const past = main.expiry.atSec <= NOW_S;
      verdict = `字段时间戳判据：${past ? '已过期 ' + fmtDur(NOW_S - main.expiry.atSec) : '剩余 ' + fmtDur(main.expiry.atSec - NOW_S)}`;
    } else if (issuedAt) {
      const aliveMs = Date.now() - issuedAt;
      verdict = rejects.length
        ? `观测到拒绝（status=${rejects[0].status ?? rejects[0].httpStatus} @ ${new Date(rejects[0].ts).toLocaleString()}）` +
          `，签发@${new Date(issuedAt).toLocaleString()} → 实测存续约 ${fmtDur(Math.floor(aliveMs / 1000))}（此为凭证被服务端接受的时长下界）`
        : `已无外发观测到签发@${new Date(issuedAt).toLocaleString()}，至今 ${fmtDur(Math.floor(aliveMs / 1000))} 未见游戏重放被拒` +
          ' → 有效期 ≥ 此值（下界估算；要拿到精确上界需等游戏自身的下一次登录重放应答）';
    } else {
      verdict = '既无字段时间戳、也无观测记录 → 无法本地判定有效期（合规约束：凭证不外发，不做主动校验）';
    }
    state.finalizeResult = { verdict, issuedAt, rejects, observeLog: observeLog.slice() };
    console.log('%c有效期结论', 'font-weight:bold', verdict);
    return state.finalizeResult;
  }

  window.tokenProbe = Object.assign(state, { report, observe, unobserve, finalize });
  report();
  console.log('[token] 后续：tokenProbe.report()（重看）/ tokenProbe.observe()（装被动观测器，零外发）/ tokenProbe.finalize()（结算观测结果）');
})();
