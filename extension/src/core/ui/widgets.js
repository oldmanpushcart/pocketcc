// 有状态的动态控件装配：UID 复合行 / 好友清单 / 领取优先级清单（拖拽）与 UID→玩家名反查。
// 从 core/ui.js 迁出。这些函数直接操作 DOM、读写 configs 并触发 saveFeature/applyFeature，
// 由 panel.syncControls 与 wire.wirePanel 复用；纯 HTML 构建部分留在 fields.js。
import { configs, findFeature, saveFeature, applyFeature } from '../registry.js';
import { parseMaybe, nickFrom630 } from './dom.js';
import { uidListInnerHTML, sortListInnerHTML, itemListInnerHTML } from './fields.js';

/** @type {number} RequestId.PLAYER_INFO（同 chat-window 口径），按 uid 查玩家基础信息，应答 d.playerInfo 为内层 JSON 串 */
const CMD_PLAYER_INFO = 630;

/**
 * 用 UID 查玩家名（PLAYER_INFO 630）。永不 reject；失败回 {ok:false,msg}（含格式预校，避免无谓请求）
 * @param {string} uid 玩家 UID（数字串）
 * @returns {Promise<{ok:boolean, name?:string, msg?:string}>}
 */
async function lookupPlayerName(uid) {
  const net = window.pocketcc && window.pocketcc.net;
  if (!net || !net.send) return { ok: false, msg: '网络未就绪' };
  if (!/^\d{4,20}$/.test(uid)) return { ok: false, msg: 'UID 格式不正确' };
  let ret;
  try {
    ret = await net.send(CMD_PLAYER_INFO, { uid });
  } catch (e) {
    return { ok: false, msg: '查询失败，请重试' };
  }
  if (!ret || !ret.ok) return { ok: false, msg: '玩家不存在（查询被拒）' };
  const d = parseMaybe(ret.data);
  if (!d || typeof d !== 'object') return { ok: false, msg: '玩家不存在' };
  return { ok: true, name: nickFrom630(d) };
}

/**
 * 装配好友清单容器（.pc-ulist）：为每个 UID 行绑显示态↔输入态状态机（失焦反查名字，写入 friends[idx]），
 * 并接＋/×（结构性改动 → 整块重刷 + 重绑）。configs[fid][key] 若仍是 descriptor defaults 本体先浅拷，
 * 避免就地 push/splice 污染 defaults（同 ranges 的坑）。
 * @param {HTMLElement} box .pc-ulist 容器
 */
export function mountUidList(box) {
  const fid = box.dataset.id;
  const f = findFeature(fid);
  if (!f) return;
  const fd = f.fields.find((x) => x.key === box.dataset.akey);
  if (!fd) return;
  const c = configs[fid];
  if (!Array.isArray(c[fd.key])) c[fd.key] = [];
  if (c[fd.key] === f.defaults[fd.key]) c[fd.key] = c[fd.key].map((it) => ({ ...it }));
  const arr = c[fd.key];
  const max = fd.max || 10;

  const rerender = () => {
    box.innerHTML = uidListInnerHTML(arr, fd);
    mountUidList(box);
  };

  // ＋ / ×：结构性改动后整块重刷（索引会变，故重绑而非逐控件）
  const add = box.querySelector('.pc-ulistadd');
  if (add)
    add.addEventListener('click', (e) => {
      e.stopPropagation();
      if (arr.length >= max) return;
      arr.push({ uid: '', name: '' });
      rerender();
      const rows = box.querySelectorAll('.pc-uli');
      const last = rows[rows.length - 1];
      if (last && last.__pcEnterEdit) last.__pcEnterEdit();
      saveFeature(f);
      applyFeature(f);
    });
  box.querySelectorAll('.pc-udel').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const i = +btn.closest('.pc-uli').dataset.uidx;
      if (i >= 0 && i < arr.length) arr.splice(i, 1);
      rerender();
      saveFeature(f);
      applyFeature(f);
    });
  });

  // 每行 UID 控件：复用 setupUidField 的状态机，但读写 friends[idx].{uid,name}
  box.querySelectorAll('.pc-uli').forEach((wrap) => setupUidListRow(wrap, f, arr));
}

/**
 * 装配一个 UID 复合行（.pc-uidwrap）：显示态↔输入态切换 + 失焦反查名字 + 成功才提交。
 * 名字随 UID 写入 configs[fd.nameKey]（持久化），下次开面板直接显缓存名、零查询。
 * @param {HTMLElement} wrap .pc-uidwrap 容器
 */
export function setupUidField(wrap) {
  const fid = wrap.dataset.id;
  const ukey = wrap.dataset.ukey;
  const nkey = wrap.dataset.nkey;
  const disp = wrap.querySelector('.pc-udisp');
  const nameEl = wrap.querySelector('.pc-uname');
  const input = wrap.querySelector('.pc-uinput');
  const hint = wrap.querySelector('.pc-uhint');
  const cur = () => configs[fid] || {};
  let lastBad = null; // 同一无效值不重复查

  function renderDisplay() {
    const c = cur();
    const v = String(c[nkey] || c[ukey] || '');
    nameEl.textContent = v || input.placeholder || '未设置';
    nameEl.classList.toggle('pc-uempty', !v); // 空值显占位提示（弱化），非空显玩家名/UID
    disp.hidden = false;
    input.hidden = true;
    input.disabled = false;
    input.classList.remove('pc-uerr');
    hint.hidden = true;
  }
  function enterEdit() {
    hint.hidden = true;
    input.value = String(cur()[ukey] || '');
    input.classList.remove('pc-uerr');
    disp.hidden = true;
    input.hidden = false;
    input.focus();
    input.select();
  }
  function failEdit(msg) {
    input.disabled = false;
    input.classList.add('pc-uerr');
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
      renderDisplay();
    }
  });
  input.addEventListener('blur', async () => {
    const c = cur();
    const f = findFeature(fid);
    const oldUid = String(c[ukey] || '');
    const val = input.value.trim();
    if (val === '') {
      // 清空：提交空 UID/名字，不查
      lastBad = null;
      if (oldUid || c[nkey]) {
        c[ukey] = '';
        c[nkey] = '';
        if (f) {
          saveFeature(f);
          applyFeature(f);
        }
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
      failEdit(hint.textContent || '玩家不存在，请检查 UID');
      return;
    } // 同一无效值不重查
    input.disabled = true;
    nameEl.textContent = '查询中…';
    const res = await lookupPlayerName(val);
    if (!wrap.isConnected) return; // 面板已重建，丢弃回写
    if (res.ok) {
      lastBad = null;
      c[ukey] = val;
      c[nkey] = res.name || '';
      if (f) {
        saveFeature(f);
        applyFeature(f);
      }
      renderDisplay();
    } else {
      lastBad = val;
      failEdit(res.msg || '玩家不存在，请检查 UID');
    }
  });

  wrap.__pcUidRefresh = renderDisplay();
  renderDisplay();
}

/**
 * 好友清单里的一行（.pc-uli）：显示态↔输入态 + 失焦用 PLAYER_INFO(630) 反查名字，成功才提交。
 * 与 setupUidField 同逻辑，差别只在值落在数组项 item.uid/item.name（而非 configs 的标量键）。
 * @param {HTMLElement} wrap .pc-uli 行容器
 * @param {object} f descriptor（saveFeature/applyFeature 用）
 * @param {Array<{uid:string, name:string}>} arr 当前好友清单（原地改）
 */
function setupUidListRow(wrap, f, arr) {
  const idx = +wrap.dataset.uidx;
  const disp = wrap.querySelector('.pc-udisp');
  const nameEl = wrap.querySelector('.pc-uname');
  const input = wrap.querySelector('.pc-uinput');
  const hint = wrap.querySelector('.pc-uhint');
  const item = () => arr[idx] || (arr[idx] = { uid: '', name: '' });
  let lastBad = null;

  function renderDisplay() {
    const it = item();
    const v = String(it.name || it.uid || '');
    nameEl.textContent = v || input.placeholder || '未设置';
    nameEl.classList.toggle('pc-uempty', !v);
    disp.hidden = false;
    input.hidden = true;
    input.disabled = false;
    input.classList.remove('pc-uerr');
    hint.hidden = true;
  }
  function enterEdit() {
    hint.hidden = true;
    input.value = String(item().uid || '');
    input.classList.remove('pc-uerr');
    disp.hidden = true;
    input.hidden = false;
    input.focus();
    input.select();
  }
  function failEdit(msg) {
    input.disabled = false;
    input.classList.add('pc-uerr');
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
      renderDisplay();
    }
  });
  input.addEventListener('blur', async () => {
    if (!wrap.isConnected) return; // 容器已重刷，丢弃
    const it = item();
    const oldUid = String(it.uid || '');
    const val = input.value.trim();
    if (val === '') {
      // 清空：提交空 UID/名字，不查
      lastBad = null;
      if (oldUid || it.name) {
        it.uid = '';
        it.name = '';
        saveFeature(f);
        applyFeature(f);
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
      failEdit(hint.textContent || '玩家不存在，请检查 UID');
      return;
    }
    input.disabled = true;
    nameEl.textContent = '查询中…';
    const res = await lookupPlayerName(val);
    if (!wrap.isConnected) return; // 面板已重刷，丢弃回写
    if (res.ok) {
      lastBad = null;
      it.uid = val;
      it.name = res.name || '';
      saveFeature(f);
      applyFeature(f);
      renderDisplay();
    } else {
      lastBad = val;
      failEdit(res.msg || '玩家不存在，请检查 UID');
    }
  });

  wrap.__pcUidRefresh = renderDisplay;
  wrap.__pcEnterEdit = enterEdit;
  renderDisplay();
}

/**
 * 装配领取优先级清单容器（.pc-slist）：整行 pointer 拖拽交换 order 位（已去掉 ↑/↓ 按钮）。
 * 拖拽中就地移动真实行节点、只刷序号；move/up 监听挂 window（指针移出面板也不丢），并对 box.__pcSDragging
 * 置位以让 refreshTexts 期间的整块重刷跳过（防 ui.refresh 打断拖拽）；松手才按 DOM 顺序回写 arr → 重刷 + 重绑 + 持久化热更。
 * configs[fid][key] 若仍是 descriptor defaults 本体先浅拷，避免就地交换污染 defaults。
 * @param {HTMLElement} box .pc-slist 容器
 */
export function mountSortList(box) {
  const fid = box.dataset.id;
  const f = findFeature(fid);
  if (!f) return;
  const fd = f.fields.find((x) => x.key === box.dataset.skey);
  if (!fd) return;
  if (box.__pcSDragging) return; // 拖拽进行中：跳过重刷，避免 ui.refresh 摧毁被拖行
  const c = configs[fid];
  if (!Array.isArray(c[fd.key]))
    c[fd.key] = Array.isArray(f.defaults[fd.key]) ? f.defaults[fd.key].slice() : [];
  else if (c[fd.key] === f.defaults[fd.key]) c[fd.key] = c[fd.key].slice();
  const arr = c[fd.key];
  // 可选全量源 fd.all（数组或 fn(cfg)）：把全量里当前 order 数组缺失的项追加到末尾——
  //   解决「功能新增了可排序项、但老用户存档的 order 不含它 → 面板这一行不显示」。
  //   未声明 fd.all 的 sortlist（遗迹奖励/卡车）保持原样，向后兼容。
  if (fd.all != null) {
    const full = typeof fd.all === 'function' ? fd.all(c) : fd.all;
    if (Array.isArray(full)) {
      for (let ai = 0; ai < full.length; ai++) {
        if (arr.indexOf(full[ai]) < 0) arr.push(full[ai]);
      }
    }
  }
  if (fd.checkable && (!Array.isArray(c[fd.offKey]) || c[fd.offKey] === f.defaults[fd.offKey])) {
    c[fd.offKey] = Array.isArray(f.defaults[fd.offKey]) ? f.defaults[fd.offKey].slice() : [];
  }
  const offArr = () => (fd.checkable ? c[fd.offKey] : undefined);
  const valByStr = new Map();
  arr.forEach((v) => valByStr.set(String(v), v));

  const rowsWrap = () => box.querySelector('.pc-srows');
  const rowEls = () => Array.prototype.slice.call(box.querySelectorAll('.pc-srows .pc-srow'));

  // 拖拽中就地更新序号（不整块重刷，保住被拖的行节点）
  const refreshRanks = () => {
    rowEls().forEach((r, i) => {
      const rk = r.querySelector('.pc-srank');
      if (rk) rk.textContent = i + 1;
    });
  };
  // 松手收尾：按当前 DOM 顺序回写 arr → 清拖拽标志 → 重刷 + 重绑 → 持久化热更（configure 即重建优先级 Map，下一轮生效）
  const commitFromDom = () => {
    const order = rowEls().map((r) => {
      const k = r.dataset.skey;
      return valByStr.has(k) ? valByStr.get(k) : isFinite(+k) ? +k : k;
    });
    arr.length = 0;
    order.forEach((v) => arr.push(v));
    box.__pcSDragging = false;
    box.innerHTML = sortListInnerHTML(arr, fd, offArr());
    bind();
    saveFeature(f);
    applyFeature(f);
  };

  const onRowDown = (e) => {
    if (e.target && e.target.classList && e.target.classList.contains('pc-scheck')) return; // 勾选框点击不触发起拖拽
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const row = e.currentTarget;
    const wrap = rowsWrap();
    if (!wrap) return;
    e.preventDefault();
    box.__pcSDragging = true;
    const pid = e.pointerId,
      startY = e.clientY;
    let moved = false;
    try {
      row.setPointerCapture(pid);
    } catch (err) {
      /* 不支持则靠 window 冒泡兑底 */
    }
    const onMove = (ev) => {
      if (!moved) {
        if (Math.abs(ev.clientY - startY) < 4) return;
        moved = true;
        row.classList.add('pc-sdragging');
        wrap.classList.add('pc-sgrabbing');
      }
      ev.preventDefault();
      const others = rowEls().filter((r) => r !== row);
      let placed = false;
      for (const r of others) {
        const rect = r.getBoundingClientRect();
        if (ev.clientY < rect.top + rect.height / 2) {
          wrap.insertBefore(row, r);
          placed = true;
          break;
        }
      }
      if (!placed) wrap.appendChild(row);
      refreshRanks();
    };
    const onUp = () => {
      try {
        row.releasePointerCapture(pid);
      } catch (err) {
        /* ignore */
      }
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      row.classList.remove('pc-sdragging');
      wrap.classList.remove('pc-sgrabbing');
      if (moved) commitFromDom();
      else box.__pcSDragging = false;
    };
    // 监听挂 window：即使指针移出面板/落到游戏画布，move/up 仍持续送达（比只挂 row 稳）
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  const bind = () => {
    box
      .querySelectorAll('.pc-srows .pc-srow')
      .forEach((row) => row.addEventListener('pointerdown', onRowDown));
    // checkable 行首勾选框：切换该物品是否参与匹配（off 集按 itemId 存，与拖拽 order 解耦），改动即重刷 + 存档 + 热更
    if (fd.checkable) {
      box.querySelectorAll('.pc-srows .pc-scheck').forEach((chk) => {
        chk.addEventListener('click', (e) => e.stopPropagation());
        chk.addEventListener('change', () => {
          const idStr = chk.dataset.sc;
          const off = c[fd.offKey];
          const at = off.map(String).indexOf(idStr);
          if (chk.checked) {
            if (at !== -1) off.splice(at, 1);
          } else if (at === -1) {
            off.push(isFinite(+idStr) ? +idStr : idStr);
          }
          box.innerHTML = sortListInnerHTML(arr, fd, off);
          bind();
          saveFeature(f);
          applyFeature(f);
        });
      });
    }
  };

  box.innerHTML = sortListInnerHTML(arr, fd, offArr());
  bind();
}

/**
 * 装配物品清单容器（.pc-ilist）：行不可增删，每行一枚 checkbox + 一个数字输入。
 * 状态形状：`cfg[fd.key] = { [idStr]: { on: 0|1, max: number } }`，未登记的项默认 on=1/max=0（不限）。
 * 池项带 `cap`（游戏自身硬上限）时，输入超出 cap 会被自动修正为 cap 并回写框内值。
 * 首次写入前浅拷一层，避免就地 push 污染 descriptor defaults。checkbox 改动重刷整块（行高量可取）；
 * number 改动不重刷，避免抢用户正在输入的框。两者都走 saveFeature + applyFeature 热更。
 * @param {HTMLElement} box .pc-ilist 容器
 */
export function mountItemList(box) {
  const fid = box.dataset.id;
  const f = findFeature(fid);
  if (!f) return;
  const fd = f.fields.find((x) => x.key === box.dataset.ikey);
  if (!fd) return;
  const c = configs[fid];
  if (!c[fd.key] || typeof c[fd.key] !== 'object' || Array.isArray(c[fd.key])) {
    c[fd.key] = Object.assign({}, (f.defaults && f.defaults[fd.key]) || {});
  } else if (c[fd.key] === f.defaults[fd.key]) {
    // 首次改动先一层浅拷（内层条目也拷），避免就地写污染 defaults
    const copy = {};
    for (const k of Object.keys(c[fd.key])) copy[k] = Object.assign({}, c[fd.key][k]);
    c[fd.key] = copy;
  }
  const state = c[fd.key];
  const items = typeof fd.items === 'function' ? fd.items(c) : fd.items || [];

  const ensureEntry = (key) => {
    if (!state[key]) state[key] = { on: 1, max: 0 };
    return state[key];
  };

  const rerender = () => {
    box.innerHTML = itemListInnerHTML(items, state, fd);
    bind();
  };

  const bind = () => {
    box.querySelectorAll('.pc-ichk').forEach((chk) => {
      chk.addEventListener('change', () => {
        const k = chk.dataset.ik;
        const e = ensureEntry(k);
        e.on = chk.checked ? 1 : 0;
        rerender();
        saveFeature(f);
        applyFeature(f);
      });
    });
    box.querySelectorAll('.pc-imax').forEach((num) => {
      num.addEventListener('change', () => {
        const k = num.dataset.ik;
        const e = ensureEntry(k);
        let v = Math.max(0, Math.floor(Number(num.value) || 0));
        const cap = Math.max(0, Math.floor(Number(num.dataset.cap) || 0));
        if (cap > 0 && v > cap) v = cap; // 游戏自身上限抢先：超出直接修正为上限
        num.value = v;
        e.max = v;
        // 不重刷，避免抢用户当前输入框；需高亮 off 行时可手动失焦后看下一刷新周期
        saveFeature(f);
        applyFeature(f);
      });
    });
  };

  rerender();
}
