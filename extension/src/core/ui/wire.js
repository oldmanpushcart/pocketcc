// 面板事件绑定：wirePanel 把 TAB 切换 / 卡片折叠 / 组主闸门级联 / 功能开关 / 各类字段改值 / 登出 / 战斗模式
// 统一挂到面板根。动态可增删行的字段（ranges/multiopts/minerules/farmrules）走面板级事件委托。
// 从 core/ui.js 迁出。骨架渲染在 panel.js，有状态控件装配在 field-types 各 module（assemble 钩子），纯 HTML 在 fields.js。
import { createLog } from '../log.js';
import { session } from '../game-api.js';
import {
  configs,
  findFeature,
  saveFeature,
  saveGroup,
  applyFeature,
  reloadConfigsAndApply,
} from '../registry.js';
import { storage } from '../storage.js';
import { getUid } from '../player.js';
import { revision } from '../update.js';
import { CHANNEL_NAME } from '../constants.js';
import { buildEnvelope, exportFileName, parseSettings } from '../settings-io.js';
import { collectFeatureIds } from '../menu.js';
import { isCombat, setCombatMode } from '../mode.js';
import { updateCmd, updateSnapshot } from '../update-client.js';
import {
  findMenuNode,
  syncFeatureChecks,
  refreshTexts,
  refreshFieldVisibility,
  activateTab,
} from './panel.js';
import { refreshFieldBox } from './fields.js';
import { findFieldDescriptor, findFieldOwner } from './dom.js';
import { baseCtx, assembleCtx } from './field-types/ctx.js';
import {
  getTypeModule,
  hasTypeModules,
  mountTypeModules,
  assembleTypeModules,
} from './field-types/index.js';

/** @type {ReturnType<createLog>} 模块日志器（tag=CORE，与原 ui.js 一致） */
const logCore = createLog('CORE');

/**
 * 构造事件级字段上下文（定稿 ctx 契约）：baseCtx（commit 收口 save+apply+log）+ refresh + syncChecks。
 * 不暴露 panel 根：syncChecks 由调用方传 sec（模块内 el.closest('.pc-sec') 自取）。
 * T5 移模块级：与装配级 assembleCtx（ctx.js）共用同一 commit 管道，dispatcher 两路均调本工厂。
 * @param {object} f descriptor
 * @param {object} fd 字段描述符（顶层 owner）
 * @param {object} c configs[fid]
 * @param {Element|null} box 字段容器（内联型 null）
 * @param {Element} el 事件目标
 */
const makeCtx = (f, fd, c, box, el) => ({
  ...baseCtx(f, fd, c, box, el),
  refresh: () => {
    if (box) refreshFieldBox(box); // 内联型无容器 box（null）：refresh 缺省 no-op，各内联 module 自写控件值
  },
  syncChecks: (sec) => syncFeatureChecks(sec),
});

/**
 * 给面板绑定交互：TAB 切换 / 卡片折叠 / 组主闸门级联 / 功能开关（以上面板chrome）+ 卡内字段控件（wireControls）
 *   + 容器型字段的面板级委托（wireContainerFields）。
 * 所有改动即存档（saveFeature/saveGroup）并实时编排（applyFeature）。
 * @param {Element} panel 面板根元素
 */
export function wirePanel(panel) {
  // TAB 切换：只换右栏 pane 的可见性，切换后刷一次只读 text 字段（与活动闸门回退同走 activateTab）。
  // 带 gate 的类别在活动未开启时被 panel.js refreshTabGates 置 disabled，原生不再派发 click，这里无需再判。
  panel.querySelectorAll('.pc-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      activateTab(panel, tab.dataset.tab);
    });
  });

  // TAB 方向键导航（APG tabs）：上下/左右换选、Home/End 跳首尾，只在未禁用的 TAB 间循环（配合 activateTab 的漫游 tabindex）
  const tabbar = panel.querySelector('.pc-tabbar');
  if (tabbar) {
    tabbar.addEventListener('keydown', (e) => {
      const tabs = [...panel.querySelectorAll('.pc-tab')].filter((t) => !t.disabled);
      if (!tabs.length) return;
      const cur = tabs.findIndex((t) => t.classList.contains('active'));
      let next;
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight')
        next = (cur + 1 + tabs.length) % tabs.length;
      else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft')
        next = (cur - 1 + tabs.length) % tabs.length;
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = tabs.length - 1;
      else return;
      e.preventDefault();
      activateTab(panel, tabs[next].dataset.tab);
      tabs[next].focus();
    });
  }

  // 卡片折叠：点标题按钮展开/收起（仅带 body 的卡片可折叠）；标题已做成 button，键盘 Enter/Space 天然可触发。
  panel.querySelectorAll('.pc-sec-toggle').forEach((btn) => {
    btn.addEventListener('click', () => {
      const sec = btn.closest('.pc-sec');
      const body = sec.querySelector('.pc-sec-body');
      if (!body) return; // 无展开内容的卡片（快捷战斗/日志）不折叠
      const open = body.hidden;
      body.hidden = !open;
      sec.classList.toggle('open', open);
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) refreshTexts(body);
    });
  });

  // 可折叠子分组（.pc-fsectoggle）：点标题行展开/收起紧随其后的 .pc-fsec-body；默认收起的组展开时补刷只读文本。
  // 用面板级委托（子分组体随卡重建而重生，直接绑会失效）。
  panel.addEventListener('click', (e) => {
    const head = e.target.closest ? e.target.closest('.pc-fsectoggle') : null;
    if (!head) return;
    const body = head.nextElementSibling;
    if (!body || !body.classList || !body.classList.contains('pc-fsec-body')) return;
    const open = body.hidden;
    body.hidden = !open;
    head.classList.toggle('open', open);
    head.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) refreshTexts(body);
  });

  // 组主闸门：关→子项全部 enabled=false；开→恢复各子项 intentEnabled（用户意图，组关不丢失）。
  // 组自身 enabled 单独存档（menu.js 声明的组键）；不新增 reactor 门控，级联后逐个 save+apply。
  panel.querySelectorAll('.pc-gen').forEach((cb) => {
    cb.addEventListener('click', (e) => e.stopPropagation());
    cb.addEventListener('change', () => {
      const gid = cb.dataset.gid;
      const gc = configs[gid];
      if (!gc) {
        logCore.warn('group config missing: %s', gid);
        return;
      }
      gc.enabled = cb.checked;
      saveGroup(gid);
      const node = findMenuNode(gid);
      const ids = node ? collectFeatureIds(node) : [];
      for (const fid of ids) {
        const f = findFeature(fid);
        const c = configs[fid];
        if (!f || !c) continue;
        c.enabled = cb.checked ? !!c.intentEnabled : false;
        saveFeature(f);
        applyFeature(f);
      }
      const sec = cb.closest('.pc-sec');
      if (sec) syncFeatureChecks(sec);
      logCore.info(
        `group ${gid} ${cb.checked ? 'enabled' : 'disabled'} (cascade ${ids.length} features)`,
      );
    });
  });

  // 功能启用开关（功能卡片 checkbox / 组内子项 checkbox）：同步 intentEnabled（意图）+ enabled（生效态）。
  panel.querySelectorAll('.pc-en').forEach((cb) => {
    cb.addEventListener('click', (e) => e.stopPropagation());
    cb.addEventListener('change', () => {
      const f = findFeature(cb.dataset.id);
      if (!f || !configs[f.id]) {
        logCore.warn('feature not registered: %s', cb.dataset.id);
        return;
      }
      configs[f.id].enabled = cb.checked;
      configs[f.id].intentEnabled = cb.checked;
      saveFeature(f);
      applyFeature(f);
      logCore.info(`feature ${f.id} ${cb.checked ? 'enabled' : 'disabled'}`);
    });
  });

  // 卡内字段控件的逐元素绑定抽成 wireControls：卡片 body 会被 rerenderFeatureCard 整块换掉（联盟集结/自动打野的行集随目录浮动），
  //   换出来的新控件若不重走一遍绑定就一个监听都没有——表现是「照常可点、看着像勾上了，值却不落盘也不生效」（面板级委托只管容器型字段）。
  wireControls(panel);
  wireContainerFields(panel);

  // 升级通道的手动入口（横幅三按钮 + 系统 tab 两按钮一开关）。
  // 必须走面板级委派：横幅每次状态广播整块换 innerHTML、升级区卡体就地重绘，直接绑上去的监听会跟着 DOM 一起没了。
  wireUpdate(panel);
  // 设置备份（导出/导入）：同走面板级委派，卡体不随卡重建，但状态行要现查不缓存（见 wireSettings 注释）。
  wireSettings(panel);
}

/**
 * 升级提示的交互绑定（命令一律转后台，新快照经广播回流再重画，本处不直接改任何读数）。
 * @param {Element} panel 面板根元素
 */
function wireUpdate(panel) {
  const pick = (e, sel) => (e.target && e.target.closest ? e.target.closest(sel) : null);

  panel.addEventListener('click', (e) => {
    const el = pick(e, '.pc-upd-go,.pc-upd-later,.pc-upd-lock,#pc-upd-check,#pc-upd-clear');
    if (!el) return;
    // 立即刷新：运行期永不热替换远程体（会打断在途行军与 reactor 态），刷新是唯一生效途径
    if (el.classList.contains('pc-upd-go')) {
      window.location.reload();
      return;
    }
    // 稍后 = 本会话不再弹横幅（不清包、不锁定）；记的是发布身份，故下轮检到同号码的新正文仍会再提
    if (el.classList.contains('pc-upd-later')) {
      const s = updateSnapshot() || {};
      updateCmd('dismiss', { ver: String(s.pendingId || '') });
      return;
    }
    if (el.classList.contains('pc-upd-lock')) {
      updateCmd('lock');
      return;
    }
    if (el.id === 'pc-upd-check') {
      updateCmd('refresh');
      return;
    }
    if (el.id === 'pc-upd-clear') {
      // 丢的就是已下载的新版包（不动当前运行），但不刷新就再下一遍，故先二次确认
      if (window.confirm('确认清除已下载的新版包？下次检查更新会重新下载。')) updateCmd('clear');
    }
  });

  // 自动检查开关：只改偏好并落盘，定时闹钟由后台同步（关掉即不再自动出网）
  panel.addEventListener('change', (e) => {
    const el = pick(e, '.pc-upd-auto');
    if (el) updateCmd('auto', { value: !!el.checked });
  });
}

/**
 * 触发一次页面内下载（「导出设置」用）：blob + `<a download>`。
 * 为什么不走 chrome.downloads：那要在**壳侧**加权限与消息通道，为一个导出功能改壳文件等于让所有人重新加载扩展；
 * 为什么不走 showSaveFilePicker（popup.js 导出凭证走的就是它）：系统保存框会让玩家改名甚至改了后缀，
 *   而「文件名可预期、按名称排序就是按时间排序」正是这个功能要给的保证，宁可直落下载文件夹。
 * @param {string} name 文件名
 * @param {string} text 文件内容
 */
function saveTextFile(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 立刻 revoke 会让部分浏览器来不及取走文件，留一拍再回收
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/**
 * 「设置备份」卡交互：导出=读配置 blob → 套信封 → 页面内下载；导入=选文件 → 纯函数校验 → 二次确认
 *   → 整块写回配置 blob → 重读盘并全量重推（即时生效，不必刷页）。
 * 全部发生在 MAIN 侧，不动壳；判据（命名、信封、逐键取舍）一律在 core/settings-io.js，本处只做 I/O 与播报。
 * 元素一律现查不缓存：面板整块重建（mountUI 重挂）后旧引用会指向孤儿节点，现查最多得到 null 而不报错。
 * @param {Element} panel 面板根元素
 */
function wireSettings(panel) {
  /**
   * 写状态行（bad=true 转红）；元素不在（系统 pane 未构建）就当无事发生，导/导入的日志仍会落盘
   * @param {string} text 文案
   * @param {boolean} [bad] 是否失败态
   */
  const setStatus = (text, bad) => {
    const el = panel.querySelector('[data-cfg-status]');
    if (!el) return;
    el.textContent = text;
    if (bad) el.setAttribute('data-cfg-err', '1');
    else el.removeAttribute('data-cfg-err');
  };

  /**
   * 异常统一落到状态行 + 一行 warn（界面只说一句人话，堆栈留给日志）
   * @param {string} head 动作口径（导出失败/导入失败）
   * @param {string} what 日志定位用英文名
   * @param {*} err 异常
   */
  const report = (head, what, err) => {
    const msg = (err && err.message) || String(err);
    setStatus(`${head}：${msg}`, true);
    logCore.warn('%s failed: %s', what, msg);
  };

  /** 导出：取不到 UID 就先拦下（命名空间未设时读盘会 reject，那串英文异常不该上界面） */
  const doExport = async () => {
    const uid = getUid();
    if (uid == null) {
      setStatus('还没取到账号 ID（游戏未登录？），暂无设置可导出', true);
      return;
    }
    setStatus('正在整理设置…');
    const settings = await storage.getAllConfig();
    const name = exportFileName(uid);
    const env = buildEnvelope({
      uid,
      settings,
      remoteVer: revision(),
      channel: CHANNEL_NAME,
    });
    saveTextFile(name, JSON.stringify(env, null, 2));
    const n = Object.keys(settings).length;
    setStatus(`已导出 ${n} 项设置：${name}`);
    logCore.info('settings exported: %s (items=%d)', name, n);
  };

  /**
   * 导入：一句拒绝文案直接上状态行（parsed.error 已是人话），确认后才落盘
   * @param {File} file 选中的备份件
   * @returns {Promise<void>}
   */
  const doImport = async (file) => {
    const parsed = parseSettings(await file.text());
    if (!parsed.ok) {
      setStatus(parsed.error, true);
      logCore.warn('settings import rejected: %s (%s)', parsed.error, file.name);
      return;
    }
    const items = Object.keys(parsed.settings).length;
    const cur = getUid();
    const cross =
      parsed.meta.uid && cur != null && String(parsed.meta.uid) !== String(cur)
        ? `；这份备份来自账号 ${parsed.meta.uid}，当前是 ${cur}`
        : '';
    const when = parsed.meta.exportedAt ? `（备份于 ${parsed.meta.exportedAt.slice(0, 10)}）` : '';
    // 导入会盖掉当前账号的同名项，属破坏性动作，与登出/清包同口径先二次确认；Shadow DOM 内 showModal 不可用，用原生 confirm
    if (
      !window.confirm(`确认导入 ${items} 项设置${when}？同名项会覆盖当前账号的对应设置${cross}。`)
    ) {
      setStatus('已取消，未改动任何设置');
      return;
    }
    const res = await storage.mergeConfig(parsed.settings);
    await reloadConfigsAndApply('settings imported');
    // 两类没落盘的项合并播报：dropped 是键名形态不合法（含注入键），rejected 是 blob 自身的保留键
    const skipped = res.rejected.length + parsed.dropped.length;
    const skip = skipped ? `，忽略 ${skipped} 项非设置键` : '';
    setStatus(`已导入 ${res.applied.length} 项设置，即时生效${skip}`);
    logCore.info(
      'settings imported from %s: items=%d dropped=%d rejected=%d',
      file.name,
      res.applied.length,
      parsed.dropped.length,
      res.rejected.length,
    );
  };

  panel.addEventListener('click', (e) => {
    const el =
      e.target && e.target.closest ? e.target.closest('#pc-cfg-export,#pc-cfg-import') : null;
    if (!el) return;
    if (el.id === 'pc-cfg-export') {
      doExport().catch((err) => report('导出失败', 'settings export', err));
      return;
    }
    const file = panel.querySelector('.pc-cfg-file');
    if (!file) return;
    file.value = ''; // 清掉上一次的选择：否则连选同一个文件不再触发 change
    file.click();
  });

  // 文件选择器的 change 会冒泡到面板根，与字段控件的委托互不干扰（本件无 data-id/data-fkey）
  panel.addEventListener('change', (e) => {
    const el = e.target && e.target.closest ? e.target.closest('.pc-cfg-file') : null;
    if (!el) return;
    const file = el.files && el.files[0];
    if (!file) return;
    setStatus('正在读取备份…');
    doImport(file).catch((err) => report('导入失败', 'settings import', err));
  });
}

/**
 * 绑定卡片 body 内的有状态字段控件：UID 复合行状态机 + 各类清单装配（拖拽/勾选/行状态机有闭包态）。
 * 与 wirePanel 分开导出，正是为了让「卡重建后重新装配」成为可能（调用方见 rerenderFeatureCard 的 rewire 参数）。
 * 对同一批元素重复调用是有害的（双监听 = 一次改动存两遍、应用两遍），所以只对 innerHTML 新替换出来的元素调用。
 * T5 终态：无状态控件（checkbox/number/select/string/button/text/note）与子控件（uid/tripick/ctrlrow/rallygrid）
 *   全由 dispatcher 两路委托（容器 closest('[data-fkey]') / 内联 findFieldOwner），本函数只余有状态清单装配，
 *   经注册表 assembleTypeModules 逐 module 调 assemble（widgets.js 退役，旧 checkbox/number/select 逐元素 handler 全删）。
 * @param {Element} root 绑定范围：整面板（首次装配）或刚重建的某个 .pc-sec-body
 */
export function wireControls(root) {
  // 有状态清单（uidlist/sortlist/itemlist）+ 标量 UID 行：注册表驱动装配（assemble 钩子 = mount*/bindUidScalar）。
  //   commit 收口 ctx.commit（save+apply+log），assembleCtx 从容器 data-fkey/data-ukey 解析 owning descriptor。
  assembleTypeModules(root, assembleCtx);
}

/**
 * 容器型字段的面板级事件委托（ranges/multiopts/minerules/farmrules/huntlist/…）、登出与战斗模式总开关的绑定。
 * 这些挂在面板根上，卡体重建不影响委托生效，故无需随卡重新装配。
 * @param {Element} panel 面板根元素
 */
function wireContainerFields(panel) {
  panel.querySelector('#pc-logout').addEventListener('click', () => {
    // 破坏性动作（退出账号、停全部自动化）先二次确认；Shadow DOM 内 showModal 不可用，用原生 confirm（键盘可达、阻断）
    if (window.confirm('确认登出 / 换号？将退出当前账号返回登录界面，所有自动化随之停止。')) {
      session.logout(); // 游戏登出（PlatformCore 符号收口于 core/game-api.js 防腐层）
    }
  });

  // 容器型字段的公共解析（boxTarget / idxOf）已随 T1~T3 迁移退役：各类型 module 自持 listOf / rowIdx / resolveRow
  // （镜像同一 data-id/data-fkey + data-idx schema），dispatcher 统一走 closest('[data-fkey]') 反查，不再需要旧解析器对。

  // ── 字段类型 module 分发（架构审查候选 1，T5 终态：全 22 类型收编） ──
  // 两路解析（决策记录 §3.4）：容器 closest('[data-fkey]')（box 型 + rallygrid/ctrlrow-table 自带容器）；
  //   内联 e.target[data-id]+(data-key??data-bkey) → findFieldOwner 反查 owning 顶层 fd（T5：子控件路由到 owning module）。
  // makeCtx 已移模块级（baseCtx + refresh + syncChecks），与装配级 assembleCtx 共用 ctx.js 的 commit 管道。
  /**
   * 按 fd.type 把事件分发给类型 module：容器 closest('[data-fkey]') → 反查 descriptor → 查 module → 匹配 events 声明。
   * @param {Event} e 面板级事件
   * @param {string} on 事件名（input/change/click）
   * @returns {boolean} 是否命中并执行了 module handler
   */
  const dispatchToModule = (e, on) => {
    if (!hasTypeModules()) return false; // 空表短路：零 DOM 开销
    const el = e.target;
    if (!el || !el.closest) return false;
    // 容器路径（box 型）：closest('[data-fkey]') → 反查 descriptor → 查 module → 匹配 events 声明
    const box = el.closest('[data-fkey]');
    if (box) {
      const f = findFeature(box.dataset.id);
      if (!f) return false;
      const fd = findFieldDescriptor(f, box.dataset.fkey);
      if (!fd) return false;
      const mod = getTypeModule(fd.type);
      if (!mod || !Array.isArray(mod.events)) return false;
      const c = configs[f.id];
      if (!c) return false;
      const handler = mod.events.find((ev) => ev.on === on && el.closest(ev.sel));
      if (!handler) return false;
      handler.run(e, makeCtx(f, fd, c, box, el));
      return true;
    }
    // 内联路径（inline 型，T4/T5）：e.target[data-id] + (data-key ?? data-bkey) → findFieldOwner 反查 owning 顶层 fd。
    //   T5：子控件（tripick.parts / ctrlrow.cells / uid.enableKey，data-key ≠ 顶层 fd.key、无 data-fkey 容器）
    //   经 findFieldOwner 路由到 owning module（ctx.fd = 顶层），handler 自经 findFieldDescriptor 下探子描述符。
    //   rallygrid / ctrlrow-table 自带 data-fkey 容器 → 上方容器路径已接，不落到这里。
    const id = el.dataset && el.dataset.id;
    if (!id) return false;
    const f = findFeature(id);
    if (!f) return false;
    const key = el.dataset.key != null ? el.dataset.key : el.dataset.bkey;
    if (key == null) return false;
    const owner = findFieldOwner(f, key);
    if (!owner) return false;
    const mod = getTypeModule(owner.type || 'number'); // 顶层无 type → number 兜底（决策记录 §3.2）
    if (!mod || !Array.isArray(mod.events)) return false;
    const c = configs[f.id];
    if (!c) return false;
    const handler = mod.events.find((ev) => ev.on === on && el.closest(ev.sel));
    if (!handler) return false;
    handler.run(e, makeCtx(f, owner, c, null, el)); // 内联无容器 box：refresh 缺省 no-op
    return true;
  };
  panel.addEventListener('input', (e) => dispatchToModule(e, 'input'));
  panel.addEventListener('change', (e) => dispatchToModule(e, 'change'));
  panel.addEventListener('click', (e) => dispatchToModule(e, 'click'));
  // 类型 module 的面板级生命周期装配（mount 钩子，如 farmrules 浮层）：一次性，与逐事件 dispatcher 分离。
  mountTypeModules(panel, logCore);

  // ranges 已迁 field-types/ranges.js（T1）：input/change/click 三路委托由上方 dispatchToModule 按 fd.type 分发。

  // multiopts 已迁 field-types/multiopts.js（T3）：勾选 change（满额回弹只 refresh 不提交）+ 全选/清空 click
  // 由上方 dispatchToModule 按 fd.type 分发；options 运行时枚举、maxSelect 上限退化取前 N 均随 module 自持。

  // minerules 已迁 field-types/minerules.js（T3）：矿种/等级 change（不重刷）+ ★点选/增删 click 由 dispatchToModule
  // 按 fd.type 分发；加行关总开关改走 ctx.box.closest('.pc-sec') + ctx.syncChecks（不取 panel 根，同 farmrules）。

  // farmrules 已迁 field-types/farmrules.js（T2）：family/kind/preset change + 增删 click 三路数据事件由上方
  // dispatchToModule 按 fd.type 分发；浮层面板级生命周期（探测/类名/定位/scroll 捕获/点外收起）由 module.mount 自持，
  // 经 mountTypeModules(panel, logCore) 装配。加行关总开关改走 ctx.box.closest('.pc-sec') + ctx.syncChecks（不取 panel 根）。

  // timeranges 已迁 field-types/timeranges.js（T3）：input 只 mutate（防未 blur 编辑被整块重绘吞掉）+ change 提交
  // + 增删 click 由 dispatchToModule 按 fd.type 分发；time 控件靠专属类 .pc-tinp 命中（通用处理器自动跳过）。

  // huntlist 已迁 field-types/huntlist.js（T2）：catalog 对齐/key 反查/三路 change 由 module 自持，
  //   dispatch 按 fd.type 分发，旧 .pc-hl:not(.pc-ct) 类名撞车 hack 随之退役（ctrlrow 走旧路径不受影响）。

  // presetpool 已迁 field-types/presetpool.js（T3）：改选 change（跨行去重撞值回弹只 refresh 不提交）+ 增删 click
  // 由 dispatchToModule 按 fd.type 分发；改选/增删整块重刷以重算其它行可选项均随 module 自持。

  // rallygrid 自学习行×删除已迁 field-types/rallygrid.js（T5）：click .pc-rgdel 经容器路径分发，
  //   onDeleteRow 回调 + blur 闸门随 module 自持（旧面板级 .pc-rgdel 委托整段退役）。

  // 战斗模式总开关：翻态即广播 mode.change（reactor 重算门控、图标换态）。不持久化，默认日常。
  const combatCb = panel.querySelector('#pc-combat');
  combatCb.checked = isCombat();
  combatCb.addEventListener('change', () => {
    setCombatMode(combatCb.checked);
  });

  // 条件字段显隐（fd.showIf）：任何字段改动都可能翻动别的字段（如「目标模式」从随机切到指定要收起联盟/离线阈值）。
  // 挂面板级 change 委托兜住全部控件类型：change 会冒泡，且各控件自己的监听在 target 阶段已跑完
  // saveFeature/applyFeature，到这里 configs 必定是新值；只切 hidden 不重建，所以重复触发代价可忽。
  panel.addEventListener('change', () => refreshFieldVisibility(panel));
}
