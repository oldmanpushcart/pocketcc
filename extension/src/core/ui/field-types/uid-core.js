/**
 * UID 复合行共享核（T5，架构审查候选 1 · Option A 全量收编）。
 *
 * 标量 UID 字段（type:'uid'，uid.js）与好友清单行（type:'uidlist'，uidlist.js）同源共用本核：
 * 显示态↔输入态状态机（bindUidRow）、PLAYER_INFO(630) 反查名字（lookupPlayerName）、查无此人提示（notFoundMsg）。
 * 迁自 widgets.js（该文件 T5 退役）。两者唯一差别是值的落点（标量键 vs 清单第 idx 项），
 * 故把落点抽成 read/write/commit 三回调，其余（失焦反查、置错回弹、Esc 回退、存档热更）只留一份实现。
 *
 * 依赖面 = registry（configs/findFeature）+ net（netApi）+ dom（parseMaybe/nickFrom630）；
 *   commit 由调用方传入（收口 ctx.commit），本核不直接 saveFeature/applyFeature。
 *   不反查 fields.js/wire.js（findFieldDescriptor 已下沉 dom.js，无环）。
 */
import { configs } from '../../registry.js';
import { netApi } from '../../net.js';
import { parseMaybe, nickFrom630 } from '../dom.js';

/** @type {number} RequestId.PLAYER_INFO（同 chat-window 口径），按 uid 查玩家基础信息，应答 d.playerInfo 为内层 JSON 串 */
const CMD_PLAYER_INFO = 630;

/** @type {string} 查无此人的统一口径（文案单点，改文案不再需要全文件 grep） */
const UID_NOT_FOUND = '玩家不存在，请检查 UID';

/** @type {number} .pc-uhint 实例序号：给每条错误提示行生成稳定 id，供失败输入框 aria-describedby 回指（14 错误播报） */
let hintSeq = 0;

/**
 * 拼查无此人的提示：主文案不变，但把服务器 code / PBV2 reason key 附在后面。
 * 不能只留一句统一文案：「服务器明确拒绝」（会话失效/风控/跨服无此号）与「UID 真不存在」
 * 在面板上看起来一模一样，而 code 是把它们分开的唯一线索（也是日志分级里 info/warn 的分界）。
 * @param {number} [code] 应答码（0=服务器说查不到人，非 0=业务拒绝对应码）
 * @param {string|null} [reason] PBV2 拒绝原因的多语言 key（Ret.reason）
 * @param {string} [note] 本地可判读的补充（如「应答无法解析」）
 * @returns {string}
 */
function notFoundMsg(code, reason, note) {
  const parts = [];
  if (code !== undefined && code !== null) parts.push('code ' + code);
  if (reason) parts.push(String(reason).slice(0, 24)); // PBV2 的 l10n key 可以很长，hint 只占一行，截断保排版
  if (note) parts.push(note);
  return parts.length ? `${UID_NOT_FOUND}（${parts.join(' · ')}）` : UID_NOT_FOUND;
}

/**
 * 用 UID 查玩家名（PLAYER_INFO 630）。永不 reject；失败回 {ok:false,msg}（含格式预校，避免无谓请求）
 * @param {string} uid 玩家 UID（数字串）
 * @returns {Promise<{ok:boolean, name?:string, msg?:string}>}
 */
export async function lookupPlayerName(uid) {
  // netApi 是 net.js 的具名导出（模块级 let，装配时赋值）：比摸 window.pocketcc.net 的影子总线少一层
  // 隐式契约（core/devtools.js 已把「调试面句柄」收口到 core 代挂，生产链路不该再依赖 window 上的键）。
  const net = netApi;
  if (!net || !net.send) return { ok: false, msg: '网络未就绪' };
  if (!/^\d{4,20}$/.test(uid)) return { ok: false, msg: 'UID 格式不正确' };
  let ret;
  try {
    ret = await net.send(CMD_PLAYER_INFO, { uid });
  } catch (e) {
    return { ok: false, msg: '查询失败，请重试' };
  }
  if (!ret) return { ok: false, msg: notFoundMsg(undefined, null, '无应答') };
  if (!ret.ok) return { ok: false, msg: notFoundMsg(ret.code, ret.reason) }; // 业务拒绝：把码挂上去供区分风控/会话失效
  const d = parseMaybe(ret.data);
  // code=0 但 data 解不出对象：服务器说没人（或形状改了），不是拒绝，故只挂 code
  if (!d || typeof d !== 'object')
    return { ok: false, msg: notFoundMsg(ret.code, null, '应答无法解析') };
  return { ok: true, name: nickFrom630(d) };
}

/**
 * UID 复合行的「显示态 ↔ 输入态」状态机（标量字段与好友清单行同源，此前是两份逐字拷贝）。
 * 两者唯一差别是值的落点：前者 configs[fid] 的 ukey/nkey 标量键，后者清单第 idx 项的 {uid,name}，
 * 故把落点抽成 read/write/commit 三个回调，其余（失焦反查、置错回弹、Esc 回退、存档热更）只留一份实现。
 * @param {HTMLElement} wrap .pc-uidwrap / .pc-uli 行容器
 * @param {{read:function():{uid:string,name:string}, write:function(string,string):void, commit:function():void}} store
 *   值的读（含缓存名）/ 写 / 落盘（commit 由调用方收口 ctx.commit，自带 saveFeature+applyFeature）
 */
export function bindUidRow(wrap, store) {
  const disp = wrap.querySelector('.pc-udisp');
  const nameEl = wrap.querySelector('.pc-uname');
  const input = wrap.querySelector('.pc-uinput');
  const hint = wrap.querySelector('.pc-uhint');
  // 错误播报（3.3.1）：给 hint 挂稳定 id 并让输入框 aria-describedby 回指，failEdit 里 focus(input) 时读屏即念出当前错误
  if (hint && !hint.id) hint.id = `pc-uhint-${++hintSeq}`;
  if (hint && input) input.setAttribute('aria-describedby', hint.id);
  let lastBad = null; // 同一无效值不重复查
  let editing = false; // 输入态：显示态的刷新不能把正在编辑的框收回去

  /**
   * 回显示态并按最新值重画。
   * @param {boolean} [force] 无条件回显示态（Esc 取消、blur 收尾等「用户已离开输入框」的场合）；
   *   不带 force 时若仍在输入态则短路——syncControls 经 __pcUidRefresh 走到这里，
   *   正打字的 UID 被打断会静默丢掉未失焦的输入。
   */
  function renderDisplay(force) {
    if (!force && editing && document.activeElement === input) return;
    editing = false;
    const it = store.read();
    const v = String(it.name || it.uid || '');
    nameEl.textContent = v || input.placeholder || '未设置';
    nameEl.classList.toggle('pc-uempty', !v); // 空值显占位提示（弱化），非空显玩家名/UID
    disp.hidden = false;
    input.hidden = true;
    input.disabled = false;
    input.classList.remove('pc-uerr');
    input.removeAttribute('aria-invalid');
    hint.hidden = true;
  }
  function enterEdit() {
    editing = true;
    hint.hidden = true;
    input.value = String(store.read().uid || '');
    input.classList.remove('pc-uerr');
    input.removeAttribute('aria-invalid');
    disp.hidden = true;
    input.hidden = false;
    input.focus();
    input.select();
  }
  function failEdit(msg) {
    editing = true; // 报错不离开输入态：否则 syncControls 会连带把 hint/红框抹掉，用户看不出自己刚输了什么
    input.disabled = false;
    input.classList.add('pc-uerr');
    input.setAttribute('aria-invalid', 'true'); // 标为无效；配合 aria-describedby + 下面的 focus，错误被读屏播报
    hint.textContent = msg;
    hint.hidden = false;
    input.focus();
  }

  disp.addEventListener('click', (e) => {
    e.stopPropagation();
    enterEdit();
  });
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      input.blur();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      lastBad = null;
      renderDisplay(true); // Esc = 主动取消，强制回显示态
    }
  });
  input.addEventListener('blur', async () => {
    editing = false; // 已离开输入框：后续 renderDisplay 不再受输入态短路保护
    if (!wrap.isConnected) return; // 容器已重建，丢弃本次回写
    const it = store.read();
    const oldUid = String(it.uid || '');
    const val = input.value.trim();
    if (val === '') {
      // 清空：提交空 UID/名字，不查
      lastBad = null;
      if (oldUid || it.name) {
        store.write('', '');
        store.commit();
      }
      renderDisplay();
      return;
    }
    if (val === oldUid) {
      lastBad = null;
      renderDisplay();
      return;
    } // 未变，不查
    if (val === lastBad) {
      failEdit(hint.textContent || UID_NOT_FOUND);
      return;
    } // 同一无效值不重查
    input.disabled = true;
    nameEl.textContent = '查询中…';
    const res = await lookupPlayerName(val);
    if (!wrap.isConnected) return; // 面板已重建，丢弃回写
    if (res.ok) {
      lastBad = null;
      store.write(val, res.name || '');
      store.commit();
      renderDisplay();
    } else {
      lastBad = val;
      failEdit(res.msg || UID_NOT_FOUND);
    }
  });

  // 注意：这里必须挂**函数引用**而非调用结果（曾误写成 renderDisplay() → 句柄变 undefined，
  //   panel.syncControls 的 __pcUidRefresh 回写分支被静默短路，配置补载后标量 UID 行不刷新）。
  wrap.__pcUidRefresh = renderDisplay;
  wrap.__pcEnterEdit = enterEdit; // 清单加行后自动进编辑态（mountUidList 用）
  renderDisplay();
}

/**
 * 好友清单里的一行（.pc-uli）：值落清单第 idx 项的 {uid,name}（原地改），状态机见 bindUidRow。
 * @param {HTMLElement} wrap .pc-uli 行容器
 * @param {Array<{uid:string, name:string}>} arr 当前好友清单（原地改）
 * @param {function():void} commit 落盘热更（调用方收口 ctx.commit）
 */
export function setupUidListRow(wrap, arr, commit) {
  const idx = +wrap.dataset.idx;
  // 行可能被整块重刷后下标越界（删行/重排）：读到空行、写到空行，补回空对象保证行始终可编辑
  const item = () => arr[idx] || (arr[idx] = { uid: '', name: '' });
  bindUidRow(wrap, {
    read: item,
    write: (uid, name) => {
      const it = item();
      it.uid = uid;
      it.name = name;
    },
    commit,
  });
}

/**
 * 标量 UID 复合行（type:'uid' 的 .pc-uidwrap）的值落点：configs[fid] 的 ukey/nkey 标量键。
 * 名字随 UID 一起持久化（fd.nameKey），下次开面板直接显缓存名、零查询。状态机见 bindUidRow。
 * 供 uid.js module 的 assemble 钩子调用（commit 收口 ctx.commit）。
 * @param {HTMLElement} wrap .pc-uidwrap 容器
 * @param {function():void} commit 落盘热更（调用方收口 ctx.commit）
 */
export function bindUidScalar(wrap, commit) {
  const fid = wrap.dataset.id;
  const ukey = wrap.dataset.ukey;
  const nkey = wrap.dataset.nkey;
  bindUidRow(wrap, {
    read: () => {
      const c = configs[fid] || {};
      return { uid: String(c[ukey] || ''), name: String(c[nkey] || '') };
    },
    write: (uid, name) => {
      if (!configs[fid]) return;
      configs[fid][ukey] = uid;
      configs[fid][nkey] = name;
    },
    commit,
  });
}
