// 字段类型 module 注册表 + 渲染/重刷查表 + 各类型事件级 dispatch 覆盖（架构审查候选 1 · T0 地基 → T5 终态）。
// 零 DOM 库：先最小桩化 window/document/chrome 再动态 import（同 tests/feats/secret-realm-pilot.test.js 范式）。
// 覆盖：registry API、buildFieldsHTML 分发（box/inline module + number 兜底）、refreshFieldBox（box module 重渲）、
//   各类型 module.events run 纯逻辑（T1 ranges / T2 huntlist·farmrules / T3 五容器 / T4 七内联 / T5 uid·tripick·ctrlrow·rallygrid）、
//   refreshText 钩子、findFieldOwner 路由、assembleCtx 解析、assemble/sync 编排。
// 边界：dispatcher 的 sel/on 匹配与 ctx 构造在 wire.js 内，渲染等价由 ui-snapshot 对拍证明；
//   commit()=saveFeature+applyFeature 管道收口 ctx.js baseCtx，此处以 ctx.commit 计数 spy 验证「每次提交恰调一次」契约。
// 注意：注册表是模块单例（index.js 装配即注册全 22 类型），本文件内测试按声明序串行，自定义类型用唯一 type 名避免污染。
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = globalThis.window || {
  addEventListener() {},
  removeEventListener() {},
  location: { href: '' },
  document: {},
};
globalThis.document = globalThis.document || {
  createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
  head: { appendChild() {} },
  body: { appendChild() {} },
  addEventListener() {},
  querySelector: () => null,
};
globalThis.chrome = globalThis.chrome || {
  runtime: { id: 'test', sendMessage() {}, getURL: (s) => s, onMessage: { addListener() {} } },
};

const {
  registerType,
  getTypeModule,
  hasTypeModules,
  mountTypeModules,
  assembleTypeModules,
  syncTypeModules,
} = await import('../../../extension/src/core/ui/field-types/index.js');
const { rangesType } = await import('../../../extension/src/core/ui/field-types/ranges.js');
const { huntlistType } = await import('../../../extension/src/core/ui/field-types/huntlist.js');
const { farmrulesType } = await import('../../../extension/src/core/ui/field-types/farmrules.js');
const { multioptsType } = await import('../../../extension/src/core/ui/field-types/multiopts.js');
const { minerulesType } = await import('../../../extension/src/core/ui/field-types/minerules.js');
const { timerangesType } = await import('../../../extension/src/core/ui/field-types/timeranges.js');
const { presetpoolType } = await import('../../../extension/src/core/ui/field-types/presetpool.js');
const { infogridType } = await import('../../../extension/src/core/ui/field-types/infogrid.js');
const { checkboxType } = await import('../../../extension/src/core/ui/field-types/checkbox.js');
const { numberType } = await import('../../../extension/src/core/ui/field-types/number.js');
const { selectType } = await import('../../../extension/src/core/ui/field-types/select.js');
const { stringType } = await import('../../../extension/src/core/ui/field-types/string.js');
const { buttonType } = await import('../../../extension/src/core/ui/field-types/button.js');
const { textType } = await import('../../../extension/src/core/ui/field-types/text.js');
const { noteType } = await import('../../../extension/src/core/ui/field-types/note.js');
const { uidlistType } = await import('../../../extension/src/core/ui/field-types/uidlist.js');
const { sortlistType } = await import('../../../extension/src/core/ui/field-types/sortlist.js');
const { itemlistType } = await import('../../../extension/src/core/ui/field-types/itemlist.js');
const { uidType } = await import('../../../extension/src/core/ui/field-types/uid.js');
const { tripickType } = await import('../../../extension/src/core/ui/field-types/tripick.js');
const { ctrlrowType } = await import('../../../extension/src/core/ui/field-types/ctrlrow.js');
const { rallygridType } = await import('../../../extension/src/core/ui/field-types/rallygrid.js');
const { baseCtx, assembleCtx } = await import('../../../extension/src/core/ui/field-types/ctx.js');
const { findFieldOwner } = await import('../../../extension/src/core/ui/dom.js');
const { buildFieldsHTML, refreshFieldBox } =
  await import('../../../extension/src/core/ui/fields.js');
const { configs } = await import('../../../extension/src/core/registry.js');
const { reactor } = await import('../../../extension/src/core/reactor.js');

// ───────────── registry API ─────────────
test('内置注册：ranges module 在表（T1 pilot），未命中类型返回 undefined', () => {
  assert.equal(hasTypeModules(), true);
  const mod = getTypeModule('ranges');
  assert.equal(mod, rangesType);
  assert.equal(mod.type, 'ranges');
  assert.equal(mod.kind, 'box');
  assert.equal(mod.cls, 'pc-rng');
  assert.equal(typeof mod.render, 'function');
  assert.equal(getTypeModule('no-such-type'), undefined);
});

test('registerType 拒绝缺 type/kind/render 的 module（不新增类型）', () => {
  assert.throws(() => registerType(null), /must declare/);
  assert.throws(() => registerType({ type: 'x' }), /must declare/);
  assert.throws(() => registerType({ type: 'x', kind: 'box' }), /must declare/);
  assert.throws(() => registerType({ type: 'x', kind: 'box', render: 'not-fn' }), /must declare/);
  assert.equal(getTypeModule('x'), undefined);
});

test('registerType + getTypeModule + hasTypeModules', () => {
  const mod = { type: 't-box', kind: 'box', cls: 'pc-tbox', render: () => '<i>box</i>' };
  registerType(mod);
  assert.equal(getTypeModule('t-box'), mod);
  assert.equal(hasTypeModules(), true);
});

test('同 type 重复注册即覆写', () => {
  const m1 = { type: 't-dup', kind: 'inline', render: () => '1' };
  const m2 = { type: 't-dup', kind: 'inline', render: () => '2' };
  registerType(m1);
  registerType(m2);
  assert.equal(getTypeModule('t-dup'), m2);
});

// ───────────── buildFieldsHTML 分发（module 注册表 + number 兜底） ─────────────
test('ranges 走 module 路径：pc-rng 外壳 + data-fkey + 行渲染', () => {
  configs['ft-rng'] = { rules: [{ from: 0, to: 10, count: 1 }] };
  const f = { fields: [{ key: 'rules', type: 'ranges', label: '区间' }] };
  const html = buildFieldsHTML('ft-rng', f);
  assert.match(html, /class="pc-rng"/);
  assert.match(html, /data-id="ft-rng"/);
  assert.match(html, /data-fkey="rules"/);
  assert.match(html, /pc-rngrow/);
});

test('uidlist 走 module 路径：pc-ulist 外壳 + data-fkey（T5 已注册）', () => {
  configs['ft-ulist'] = { friends: [] };
  const f = { fields: [{ key: 'friends', type: 'uidlist', label: '好友' }] };
  const html = buildFieldsHTML('ft-ulist', f);
  assert.match(html, /class="pc-ulist"/);
  assert.match(html, /data-fkey="friends"/);
});

test('已注册 box module 优先：module.render(val,fd,c,fid) + fieldBox 外壳', () => {
  registerType({
    type: 't-box2',
    kind: 'box',
    cls: 'pc-tbox2',
    render: (val, fd, c, fid) => `<b>${fid}:${fd.key}:${val}</b>`,
  });
  configs['ft-box'] = { k: 'V' };
  const f = { fields: [{ key: 'k', type: 't-box2' }] };
  assert.equal(
    buildFieldsHTML('ft-box', f),
    '<div class="pc-tbox2" data-id="ft-box" data-fkey="k"><b>ft-box:k:V</b></div>',
  );
});

test('已注册 inline module 优先：module.render 无外壳', () => {
  registerType({
    type: 't-inline',
    kind: 'inline',
    render: (val, fd, c, fid) => `<span>${fid}:${val}</span>`,
  });
  configs['ft-inline'] = { k: 7 };
  const f = { fields: [{ key: 'k', type: 't-inline' }] };
  assert.equal(buildFieldsHTML('ft-inline', f), '<span>ft-inline:7</span>');
});

test('checkbox 走 module 路径：pc-fchk（T4 已注册）', () => {
  configs['ft-chk'] = { flag: true };
  const f = { fields: [{ key: 'flag', type: 'checkbox', label: '开关' }] };
  assert.match(buildFieldsHTML('ft-chk', f), /class="pc-fchk"/);
});

test('无 type 顶层字段落 number module 兜底', () => {
  configs['ft-num'] = { n: 5 };
  const f = { fields: [{ key: 'n', label: '数量', min: 0, step: 1 }] };
  const html = buildFieldsHTML('ft-num', f);
  assert.match(html, /type="number"/);
  assert.match(html, /value="5"/);
});

// ───────────── refreshFieldBox（box module 重渲） ─────────────
test('refreshFieldBox 负路径：null / 功能未注册 → false', () => {
  assert.equal(refreshFieldBox(null), false);
  assert.equal(refreshFieldBox({ dataset: { id: 'nonexistent', fkey: 'k' } }), false);
});

test('refreshFieldBox：已注册 box module 优先重渲内层', () => {
  reactor.register({
    id: 'ft-refresh',
    label: '重刷测试',
    storageKey: 'pocketcc.ft-refresh.config',
    defaults: { k: [] },
    toModuleCfg: (cfg) => cfg,
    fields: [{ key: 'k', type: 't-box3' }],
  });
  registerType({
    type: 't-box3',
    kind: 'box',
    cls: 'pc-tbox3',
    render: (val) => `<u>${JSON.stringify(val)}</u>`,
  });
  configs['ft-refresh'] = { k: [1, 2] };
  const box = { dataset: { id: 'ft-refresh', fkey: 'k' }, innerHTML: '' };
  assert.equal(refreshFieldBox(box), true);
  assert.equal(box.innerHTML, '<u>[1,2]</u>');
});

test('refreshFieldBox：ranges 走 module 重渲内层（pc-rngrow）', () => {
  reactor.register({
    id: 'ft-refresh-rng',
    label: '区间重刷',
    storageKey: 'pocketcc.ft-refresh-rng.config',
    defaults: { rules: [] },
    toModuleCfg: (cfg) => cfg,
    fields: [{ key: 'rules', type: 'ranges', label: '区间' }],
  });
  configs['ft-refresh-rng'] = { rules: [{ from: 0, to: 5, count: 2 }] };
  const box = { dataset: { id: 'ft-refresh-rng', fkey: 'rules' }, innerHTML: '' };
  assert.equal(refreshFieldBox(box), true);
  assert.match(box.innerHTML, /pc-rngrow/);
});

test('refreshFieldBox：uidlist 走 module 重渲内层（pc-ulisttop，T5 已注册）', () => {
  reactor.register({
    id: 'ft-refresh-old',
    label: '旧表重刷',
    storageKey: 'pocketcc.ft-refresh-old.config',
    defaults: { friends: [] },
    toModuleCfg: (cfg) => cfg,
    fields: [{ key: 'friends', type: 'uidlist', label: '好友' }],
  });
  configs['ft-refresh-old'] = { friends: [] };
  const box = { dataset: { id: 'ft-refresh-old', fkey: 'friends' }, innerHTML: '' };
  assert.equal(refreshFieldBox(box), true);
  assert.match(box.innerHTML, /pc-ulisttop/);
});

// ───────────── ranges 事件级 dispatch（T1：module.events run 纯逻辑 + commit 契约） ─────────────
// 直接调 rangesType.events[i].run(e, ctx)，ctx 用最小 stub（commit/refresh 计数 spy），
// 验证迁移后的交互时序与「每次提交恰调一次 commit」契约。行号靠 data-idx（列头行无此属性，防 off-by-one）。

/** 行内数字格 stub：closest('.pc-rngrow[data-idx]') 返回带 data-idx 的行 */
function rngInput(idx, part, value) {
  return {
    value,
    dataset: { part },
    closest: (sel) => (sel === '.pc-rngrow[data-idx]' ? { dataset: { idx: String(idx) } } : null),
  };
}
/** ranges ctx stub：c/fd 真实形状，commit/refresh 为计数 spy */
function rngCtx(list) {
  const calls = { commit: 0, refresh: 0 };
  return {
    ctx: {
      c: { rules: list },
      fd: { key: 'rules' },
      commit: () => calls.commit++,
      refresh: () => calls.refresh++,
    },
    calls,
  };
}
/** 增/删按钮 stub：closest 命中自身类时返回按钮自身（带 closest，照真实 DOM 语义），run 内再区分 del/add */
function rngButton(kind, idx) {
  const btn = {
    closest: (sel) => {
      if (sel === '.pc-rngdel') return kind === 'del' ? btn : null;
      if (sel === '.pc-rngadd') return kind === 'add' ? btn : null;
      if (sel === '.pc-rngrow[data-idx]') return { dataset: { idx: String(idx) } };
      return null;
    },
  };
  return btn;
}
const evOf = (on) => rangesType.events.find((e) => e.on === on);

test('ranges events 声明：input/change/click 三路 + sel 正确', () => {
  assert.equal(rangesType.events.length, 3);
  assert.equal(evOf('input').sel, '.pc-rngn');
  assert.equal(evOf('change').sel, '.pc-rngn');
  assert.equal(evOf('click').sel, '.pc-rngdel,.pc-rngadd');
});

test('ranges input：只 mutate 内存，不 commit 不 refresh（未失焦编辑保活）', () => {
  const list = [{ from: 0, to: 10, count: 1 }];
  const { ctx, calls } = rngCtx(list);
  evOf('input').run({ target: rngInput(0, 'to', '999') }, ctx);
  assert.equal(list[0].to, 999);
  assert.equal(calls.commit, 0);
  assert.equal(calls.refresh, 0);
});

test('ranges input：非法值（NaN/负）不写内存', () => {
  const list = [{ from: 0, to: 10, count: 1 }];
  const { ctx } = rngCtx(list);
  evOf('input').run({ target: rngInput(0, 'to', 'abc') }, ctx);
  evOf('input').run({ target: rngInput(0, 'from', '-5') }, ctx);
  assert.deepEqual(list[0], { from: 0, to: 10, count: 1 });
});

test('ranges change：钳制负值归 0 + 回写输入框 + commit 恰一次', () => {
  const list = [{ from: 0, to: 10, count: 1 }];
  const { ctx, calls } = rngCtx(list);
  const inp = rngInput(0, 'count', '-7');
  evOf('change').run({ target: inp }, ctx);
  assert.equal(list[0].count, 0);
  assert.equal(inp.value, 0);
  assert.equal(calls.commit, 1);
  assert.equal(calls.refresh, 0);
});

test('ranges click 增行：接上一档上界 + refresh + commit 恰一次', () => {
  const list = [{ from: 0, to: 300, count: 3 }];
  const { ctx, calls } = rngCtx(list);
  evOf('click').run({ target: rngButton('add', 0) }, ctx);
  assert.deepEqual(list[1], { from: 300, to: 0, count: 0 });
  assert.equal(calls.refresh, 1);
  assert.equal(calls.commit, 1);
});

test('ranges click 首档增行：from 从 0 起', () => {
  const list = [];
  const { ctx } = rngCtx(list);
  evOf('click').run({ target: rngButton('add', 0) }, ctx);
  assert.deepEqual(list[0], { from: 0, to: 0, count: 0 });
});

test('ranges click 删行：按 data-idx splice + refresh + commit 恰一次', () => {
  const list = [
    { from: 0, to: 100, count: 1 },
    { from: 100, to: 200, count: 2 },
  ];
  const { ctx, calls } = rngCtx(list);
  evOf('click').run({ target: rngButton('del', 0) }, ctx);
  assert.equal(list.length, 1);
  assert.deepEqual(list[0], { from: 100, to: 200, count: 2 });
  assert.equal(calls.refresh, 1);
  assert.equal(calls.commit, 1);
});

test('ranges 行号越界：input/change 丢弃不写（防 off-by-one 末行越界）', () => {
  const list = [{ from: 0, to: 10, count: 1 }];
  const { ctx, calls } = rngCtx(list);
  evOf('input').run({ target: rngInput(5, 'to', '999') }, ctx);
  evOf('change').run({ target: rngInput(5, 'to', '999') }, ctx);
  assert.deepEqual(list[0], { from: 0, to: 10, count: 1 });
  assert.equal(calls.commit, 0);
});

test('ranges 数组初始化：c[key] 非数组时就地置 []（镜像旧 boxTarget）', () => {
  const calls = { commit: 0, refresh: 0 };
  const ctx = {
    c: {},
    fd: { key: 'rules' },
    commit: () => calls.commit++,
    refresh: () => calls.refresh++,
  };
  evOf('click').run({ target: rngButton('add', 0) }, ctx);
  assert.deepEqual(ctx.c.rules, [{ from: 0, to: 0, count: 0 }]);
});

// ───────────── huntlist 事件级 dispatch（T2：catalog 对齐 / key 反查 / 数量钳制 + commit 契约） ─────────────
// 直接调 huntlistType.events[i].run(e, ctx)。三路均 on:'change'，按 sel 区分（chk/sel/n）。
// 关键差异：alignCatalog 每次把 c[fd.key] 重建为新数组，故断言读 ctx.c.list（非传入引用）。

const HL_CATALOG = [
  {
    key: 'wolf',
    label: '狼',
    maxCount: 0,
    defaultCount: 0,
    defaultMode: 'normal',
    defaultOn: true,
  },
  {
    key: 'star',
    label: '星',
    maxCount: 10,
    defaultCount: 2,
    defaultMode: 'rally',
    defaultOn: false,
  },
];
/** huntlist ctx stub：fd.catalog 驱动行集，commit/refresh 计数 spy */
function hlCtx(stored) {
  const calls = { commit: 0, refresh: 0 };
  return {
    ctx: {
      c: { list: stored },
      fd: { key: 'list', catalog: HL_CATALOG },
      commit: () => calls.commit++,
      refresh: () => calls.refresh++,
    },
    calls,
  };
}
/** 行内控件 stub：closest('.pc-hlrow') 给 hkey（key 反查优先），closest('.pc-hlrow[data-idx]') 给 idx（回落） */
function hlEl(hkey, idx, part, props = {}) {
  return {
    dataset: { part },
    value: props.value,
    checked: props.checked,
    closest: (sel) => {
      if (sel === '.pc-hlrow') return hkey == null ? null : { dataset: { hkey } };
      if (sel === '.pc-hlrow[data-idx]') return { dataset: { idx: String(idx) } };
      return null;
    },
  };
}
const hlEv = (sel) => huntlistType.events.find((e) => e.sel === sel);

test('huntlist events 声明：三路 change（chk/sel/n）', () => {
  assert.equal(huntlistType.events.length, 3);
  assert.ok(huntlistType.events.every((e) => e.on === 'change'));
  assert.equal(hlEv('.pc-hlchk').sel, '.pc-hlchk');
  assert.equal(hlEv('.pc-hlsel').sel, '.pc-hlsel');
  assert.equal(hlEv('.pc-hln').sel, '.pc-hln');
});

test('huntlist catalog 对齐：乱序保留已存值 / 补缺行 / 剔已删行', () => {
  // 存档：star 在前（乱序）+ ghost（目录已删）+ 缺 wolf
  const stored = [
    { key: 'star', count: 5, mode: 'rally', on: true },
    { key: 'ghost', count: 9, mode: 'x', on: true },
  ];
  const { ctx, calls } = hlCtx(stored);
  hlEv('.pc-hlchk').run({ target: hlEl('wolf', 0, 'on', { checked: false }) }, ctx);
  const list = ctx.c.list;
  assert.equal(list.length, 2); // ghost 剔除
  assert.equal(list[0].key, 'wolf'); // 按 catalog 序补齐
  assert.equal(list[0].on, false); // 本次写入
  assert.deepEqual(list[1], { key: 'star', count: 5, mode: 'rally', on: true }); // 已存值保留
  assert.equal(calls.commit, 1);
});

test('huntlist key 反查：DOM 行序与 catalog 错位时按 hkey 写对行', () => {
  const stored = [
    { key: 'wolf', count: 0, mode: 'normal', on: true },
    { key: 'star', count: 2, mode: 'rally', on: false },
  ];
  const { ctx, calls } = hlCtx(stored);
  // star 的 hkey 但 data-idx=0（目录刷新重排后视觉行序错位）
  hlEv('.pc-hlsel').run({ target: hlEl('star', 0, 'mode', { value: 'siege' }) }, ctx);
  const list = ctx.c.list;
  assert.equal(list[1].mode, 'siege'); // 写到 star（key 反查）而非 idx0 的 wolf
  assert.equal(list[0].mode, 'normal');
  assert.equal(calls.commit, 1);
});

test('huntlist 数量：超该行硬上限钳位 + 回写 + commit 一次', () => {
  const { ctx, calls } = hlCtx([]);
  const el = hlEl('star', 1, 'count', { value: '99' });
  hlEv('.pc-hln').run({ target: el }, ctx);
  assert.equal(ctx.c.list[1].count, 10); // star.maxCount=10
  assert.equal(el.value, 10);
  assert.equal(calls.commit, 1);
});

test('huntlist 数量：0/负归 0 且留空回写（placeholder 不限）；无上限不钳制', () => {
  const { ctx } = hlCtx([]);
  const zero = hlEl('wolf', 0, 'count', { value: '0' });
  hlEv('.pc-hln').run({ target: zero }, ctx);
  assert.equal(ctx.c.list[0].count, 0);
  assert.equal(zero.value, ''); // 0 留空
  const neg = hlEl('wolf', 0, 'count', { value: '-3' });
  hlEv('.pc-hln').run({ target: neg }, ctx);
  assert.equal(ctx.c.list[0].count, 0);
  assert.equal(neg.value, '');
  const big = hlEl('wolf', 0, 'count', { value: '99' });
  hlEv('.pc-hln').run({ target: big }, ctx);
  assert.equal(ctx.c.list[0].count, 99); // wolf.maxCount=0 → 无上限
  assert.equal(big.value, 99);
});

test('huntlist mode：字符串键就地写回 + commit 恰一次（不 refresh）', () => {
  const { ctx, calls } = hlCtx([]);
  hlEv('.pc-hlsel').run({ target: hlEl('wolf', 0, 'mode', { value: 'rally' }) }, ctx);
  assert.equal(ctx.c.list[0].mode, 'rally');
  assert.equal(calls.commit, 1);
  assert.equal(calls.refresh, 0);
});

test('huntlist on：bool 就地写回 + commit 恰一次', () => {
  const { ctx, calls } = hlCtx([]);
  hlEv('.pc-hlchk').run({ target: hlEl('star', 1, 'on', { checked: true }) }, ctx);
  assert.equal(ctx.c.list[1].on, true);
  assert.equal(calls.commit, 1);
});

test('huntlist 越界 hkey：resolveRow 返回 null，不写不 commit', () => {
  const { ctx, calls } = hlCtx([]);
  hlEv('.pc-hln').run({ target: hlEl('nonexistent', 99, 'count', { value: '5' }) }, ctx);
  assert.equal(calls.commit, 0);
  assert.equal(ctx.c.list.length, 2); // 仅对齐，无写入
});

test('huntlist 无 catalog：不对齐，按存档原序 key 反查（防御分支）', () => {
  const calls = { commit: 0, refresh: 0 };
  const stored = [{ key: 'wolf', count: 1, mode: 'normal', on: true }];
  const ctx = {
    c: { list: stored },
    fd: { key: 'list' }, // 无 catalog
    commit: () => calls.commit++,
    refresh: () => calls.refresh++,
  };
  hlEv('.pc-hlsel').run({ target: hlEl('wolf', 0, 'mode', { value: 'rally' }) }, ctx);
  assert.equal(ctx.c.list, stored); // 未重建（同一引用）
  assert.equal(stored[0].mode, 'rally');
  assert.equal(calls.commit, 1);
});

// ───────────── farmrules 事件级 dispatch + mount 生命周期（T2：数据事件走 dispatcher / 浮层走 mount） ─────────────
// 数据事件直调 farmrulesType.events[i].run(e, ctx)；listOf 就地 mutate（不重建数组），故断言读传入 list。
// frEl.closest('.pc-frrow') 返回 null → syncRowGroupsUi 早退（数据级单测；UI 就地刷新由快照渲染等价覆盖）。
// mount 用最小 panel/document 桩验证：Popover 探测→类名、click/scroll(捕获) 注册、降级 debug。

const FR_FD = {
  key: 'frules',
  familyOptions: [
    { value: 7, label: '金矿', short: '金' },
    { value: 16, label: '雷神', short: '雷' },
  ],
  presetOptions: [
    { value: 1, label: '预设1' },
    { value: 2, label: '预设2' },
  ],
};
/** farmrules ctx stub：c 带 enabled/intentEnabled，box.closest('.pc-sec')→sec→enCb，commit/refresh/syncChecks 计数 spy */
function frCtx(list) {
  const calls = { commit: 0, refresh: 0, syncChecks: 0, syncChecksSec: null };
  const enCb = { checked: true };
  const sec = { querySelector: (sel) => (sel === '.pc-en[data-id="ft-fr"]' ? enCb : null) };
  const box = { closest: (sel) => (sel === '.pc-sec' ? sec : null) };
  return {
    ctx: {
      c: { frules: list, enabled: true, intentEnabled: true },
      fd: FR_FD,
      fid: 'ft-fr',
      box,
      commit: () => calls.commit++,
      refresh: () => calls.refresh++,
      syncChecks: (s) => {
        calls.syncChecks++;
        calls.syncChecksSec = s;
      },
    },
    calls,
    enCb,
    sec,
  };
}
/** 行内控件 stub（change 用）：closest('.pc-frrow[data-idx]') 给行号，'.pc-frrow' 返回 null 跳过 UI 刷新 */
function frEl(idx, part, props = {}) {
  return {
    dataset: { part },
    value: props.value,
    checked: props.checked,
    closest: (sel) => (sel === '.pc-frrow[data-idx]' ? { dataset: { idx: String(idx) } } : null),
  };
}
/** 增/删按钮 stub（click 用）：closest 命中自身类返回按钮自身（带 closest，照真实 DOM 语义） */
function frButton(kind, idx) {
  const btn = {
    closest: (sel) => {
      if (sel === '.pc-frdel') return kind === 'del' ? btn : null;
      if (sel === '.pc-fradd') return kind === 'add' ? btn : null;
      if (sel === '.pc-frrow[data-idx]') return { dataset: { idx: String(idx) } };
      return null;
    },
  };
  return btn;
}
const frEv = (sel) => farmrulesType.events.find((e) => e.sel === sel);

test('farmrules events 声明：change(frkin/frsel) + click(增删)，mount 为函数', () => {
  assert.equal(farmrulesType.events.length, 3);
  assert.equal(frEv('.pc-frkin').on, 'change');
  assert.equal(frEv('.pc-frsel').on, 'change');
  assert.equal(frEv('.pc-frdel,.pc-fradd').on, 'click');
  assert.equal(typeof farmrulesType.mount, 'function');
});

test('farmrules family 勾选：families 存数字 + commit 恰一次（不 refresh）', () => {
  const list = [{ preset: 1, families: [7], kinds: ['tower'] }];
  const { ctx, calls } = frCtx(list);
  frEv('.pc-frkin').run({ target: frEl(0, 'family', { value: '16', checked: true }) }, ctx);
  assert.deepEqual(list[0].families, [7, 16]);
  assert.equal(calls.commit, 1);
  assert.equal(calls.refresh, 0);
});

test('farmrules kind 勾选/取消：kinds 存字符串，取消即移除', () => {
  const list = [{ preset: 1, families: [7], kinds: ['tower'] }];
  const { ctx } = frCtx(list);
  frEv('.pc-frkin').run({ target: frEl(0, 'kind', { value: 'relic', checked: true }) }, ctx);
  assert.deepEqual(list[0].kinds, ['tower', 'relic']);
  frEv('.pc-frkin').run({ target: frEl(0, 'kind', { value: 'tower', checked: false }) }, ctx);
  assert.deepEqual(list[0].kinds, ['relic']);
});

test('farmrules 只剩雷神(16)：同步剔除已勾遗迹（数据与控件不打架）', () => {
  const list = [{ preset: 1, families: [7, 16], kinds: ['relic', 'tower'] }];
  const { ctx } = frCtx(list);
  frEv('.pc-frkin').run({ target: frEl(0, 'family', { value: '7', checked: false }) }, ctx);
  assert.deepEqual(list[0].families, [16]);
  assert.deepEqual(list[0].kinds, ['tower']); // relic 被剔除
});

test('farmrules preset 单选：写回整数 + refresh + commit 各恰一次', () => {
  const list = [{ preset: 1, families: [7], kinds: [] }];
  const { ctx, calls } = frCtx(list);
  frEv('.pc-frsel').run({ target: frEl(0, 'preset', { value: '2' }) }, ctx);
  assert.equal(list[0].preset, 2);
  assert.equal(calls.refresh, 1);
  assert.equal(calls.commit, 1);
});

test('farmrules 增行：取第一支空闲预设 + 关总开关 + 回写卡片勾选 + syncChecks', () => {
  const list = [{ preset: 1, families: [7], kinds: ['tower'] }];
  const { ctx, calls, enCb, sec } = frCtx(list);
  frEv('.pc-frdel,.pc-fradd').run({ target: frButton('add', 0) }, ctx);
  assert.deepEqual(list[1], { preset: 2, families: [7], kinds: ['tower', 'normal'] });
  assert.equal(ctx.c.enabled, false);
  assert.equal(ctx.c.intentEnabled, false);
  assert.equal(enCb.checked, false);
  assert.equal(calls.syncChecks, 1);
  assert.equal(calls.syncChecksSec, sec);
  assert.equal(calls.refresh, 1);
  assert.equal(calls.commit, 1);
});

test('farmrules 删行：按 data-idx splice + refresh + commit 各恰一次', () => {
  const list = [{ preset: 1 }, { preset: 2 }];
  const { ctx, calls } = frCtx(list);
  frEv('.pc-frdel,.pc-fradd').run({ target: frButton('del', 0) }, ctx);
  assert.equal(list.length, 1);
  assert.deepEqual(list[0], { preset: 2 });
  assert.equal(calls.refresh, 1);
  assert.equal(calls.commit, 1);
});

test('farmrules 行号越界：change 丢弃不写不 commit', () => {
  const list = [{ preset: 1, families: [7], kinds: [] }];
  const { ctx, calls } = frCtx(list);
  frEv('.pc-frsel').run({ target: frEl(5, 'preset', { value: '2' }) }, ctx);
  assert.equal(list[0].preset, 1);
  assert.equal(calls.commit, 0);
});

test('farmrules 数组初始化：c[key] 非数组时增行就地置 []（镜像旧 boxTarget）', () => {
  const calls = { commit: 0, refresh: 0, syncChecks: 0 };
  const sec = { querySelector: () => null };
  const ctx = {
    c: { enabled: true, intentEnabled: true },
    fd: { key: 'frules' },
    fid: 'ft-fr',
    box: { closest: () => sec },
    commit: () => calls.commit++,
    refresh: () => calls.refresh++,
    syncChecks: () => calls.syncChecks++,
  };
  frEv('.pc-frdel,.pc-fradd').run({ target: frButton('add', 0) }, ctx);
  assert.deepEqual(ctx.c.frules, [{ preset: 1, families: [7], kinds: ['tower', 'normal'] }]);
});

test('farmrules mount：Popover 可用 → panel 加 pc-kindpop + 注册 beforetoggle/toggle/scroll(捕获)，不手写 click', () => {
  const added = [];
  const listeners = [];
  const panel = {
    classList: { add: (c) => added.push(c) },
    addEventListener: (on, fn, opts) => listeners.push({ on, opts }),
    querySelectorAll: () => [],
  };
  const origCreate = globalThis.document.createElement;
  globalThis.document.createElement = () => ({ showPopover() {}, hidePopover() {} });
  try {
    farmrulesType.mount(panel, { debug() {} });
  } finally {
    globalThis.document.createElement = origCreate;
  }
  assert.ok(added.includes('pc-kindpop'));
  // 开/关/点外/Esc 由 popovertarget + auto light dismiss 平台代劳，不再手写点击委托
  assert.ok(!listeners.some((l) => l.on === 'click'));
  for (const on of ['beforetoggle', 'toggle', 'scroll']) {
    const l = listeners.find((x) => x.on === on);
    assert.ok(l, `missing listener: ${on}`);
    // 捕获阶段：toggle/beforetoggle 不冒泡必须捕获，scroll 抓两层；兼容 true 简写与 {capture:true}
    assert.ok(l.opts === true || (l.opts && l.opts.capture === true));
  }
});

test('farmrules mount 降级：无 Popover API → 打 debug 且不加 pc-kindpop（流内撑开）', () => {
  const added = [];
  const logs = [];
  const panel = {
    classList: { add: (c) => added.push(c) },
    addEventListener: () => {},
    querySelectorAll: () => [],
  };
  const origCreate = globalThis.document.createElement;
  globalThis.document.createElement = () => ({}); // 无 showPopover/hidePopover
  try {
    farmrulesType.mount(panel, { debug: (m) => logs.push(m) });
  } finally {
    globalThis.document.createElement = origCreate;
  }
  assert.ok(!added.includes('pc-kindpop'));
  assert.equal(logs.length, 1);
});

test('mountTypeModules：装配期对声明 mount 的类型调一次（farmrules 浮层经此装配）', () => {
  const listeners = [];
  const panel = {
    classList: { add() {} },
    addEventListener: (on) => listeners.push(on),
    querySelectorAll: () => [],
  };
  const origCreate = globalThis.document.createElement;
  globalThis.document.createElement = () => ({ showPopover() {}, hidePopover() {} });
  try {
    mountTypeModules(panel, { debug() {} });
  } finally {
    globalThis.document.createElement = origCreate;
  }
  // farmrules.mount 注册了 beforetoggle/toggle/scroll；ranges/huntlist 无 mount 不贡献监听
  assert.ok(listeners.includes('beforetoggle'));
  assert.ok(listeners.includes('toggle'));
  assert.ok(listeners.includes('scroll'));
});

// ───────────── T3 内置注册（multiopts/minerules/timeranges/presetpool/infogrid 均 box 型） ─────────────
test('T3 内置注册：5 类型均在表且为 box 型（旧 FIELD_BOXES 已删，渲染走 module）', () => {
  assert.equal(getTypeModule('multiopts'), multioptsType);
  assert.equal(getTypeModule('minerules'), minerulesType);
  assert.equal(getTypeModule('timeranges'), timerangesType);
  assert.equal(getTypeModule('presetpool'), presetpoolType);
  assert.equal(getTypeModule('infogrid'), infogridType);
  for (const m of [multioptsType, minerulesType, timerangesType, presetpoolType, infogridType])
    assert.equal(m.kind, 'box');
});

// ───────────── multiopts 事件级 dispatch（T3：满额回弹只 refresh 不 commit / 全选退化取前 N） ─────────────
// 扁平 checkbox 栅格（无行下标）：change 读 e.target.value/checked，click 靠 closest 区分全选/清空。
const MO_OPTS = [
  { value: 1, label: '金' },
  { value: 2, label: '粮' },
  { value: 3, label: '油' },
];
/** multiopts ctx stub：c.opts 为选中 number[]，fd 带 options/maxSelect，commit/refresh 计数 spy */
function moCtx(list, fd) {
  const calls = { commit: 0, refresh: 0 };
  return {
    ctx: {
      c: { opts: list },
      fd: Object.assign({ key: 'opts', options: MO_OPTS }, fd),
      commit: () => calls.commit++,
      refresh: () => calls.refresh++,
    },
    calls,
  };
}
const moChk = (value, checked) => ({ value: String(value), checked });
function moButton(kind) {
  const btn = {
    closest: (sel) => {
      if (sel === '.pc-moptall') return kind === 'all' ? btn : null;
      if (sel === '.pc-moptnone') return kind === 'none' ? btn : null;
      return null;
    },
  };
  return btn;
}
const moEv = (on) => multioptsType.events.find((e) => e.on === on);

test('multiopts events 声明：change(moptchk) + click(全选/清空)', () => {
  assert.equal(multioptsType.events.length, 2);
  assert.equal(moEv('change').sel, '.pc-moptchk');
  assert.equal(moEv('click').sel, '.pc-moptall,.pc-moptnone');
});

test('multiopts 勾选/取消（无上限）：整批重存 + commit 一次，不 refresh', () => {
  const list = [1];
  const { ctx, calls } = moCtx(list);
  moEv('change').run({ target: moChk(2, true) }, ctx);
  assert.deepEqual(list, [1, 2]);
  moEv('change').run({ target: moChk(1, false) }, ctx);
  assert.deepEqual(list, [2]);
  assert.equal(calls.commit, 2);
  assert.equal(calls.refresh, 0);
});

test('multiopts 满额回弹：已达上限再勾 → 只 refresh 不 commit，配置不变', () => {
  const list = [1, 2];
  const { ctx, calls } = moCtx(list, { maxSelect: 2 });
  moEv('change').run({ target: moChk(3, true) }, ctx);
  assert.deepEqual(list, [1, 2]); // 不静默改配置
  assert.equal(calls.refresh, 1);
  assert.equal(calls.commit, 0);
});

test('multiopts 满额仍可取消已勾：splice + refresh + commit（只锁未勾的）', () => {
  const list = [1, 2];
  const { ctx, calls } = moCtx(list, { maxSelect: 2 });
  moEv('change').run({ target: moChk(1, false) }, ctx);
  assert.deepEqual(list, [2]);
  assert.equal(calls.refresh, 1);
  assert.equal(calls.commit, 1);
});

test('multiopts 未满勾选（有上限）：push + refresh + commit 各一次', () => {
  const list = [1];
  const { ctx, calls } = moCtx(list, { maxSelect: 3 });
  moEv('change').run({ target: moChk(2, true) }, ctx);
  assert.deepEqual(list, [1, 2]);
  assert.equal(calls.refresh, 1);
  assert.equal(calls.commit, 1);
});

test('multiopts 全选：无上限取全部 / 有上限退化取前 N + refresh + commit', () => {
  const a = moCtx([]);
  moEv('click').run({ target: moButton('all') }, a.ctx);
  assert.deepEqual(a.ctx.c.opts, [1, 2, 3]);
  assert.equal(a.calls.refresh, 1);
  assert.equal(a.calls.commit, 1);
  const b = moCtx([], { maxSelect: 2 });
  moEv('click').run({ target: moButton('all') }, b.ctx);
  assert.deepEqual(b.ctx.c.opts, [1, 2]); // 取前 2
});

test('multiopts 清空：list 归零 + refresh + commit', () => {
  const list = [1, 2];
  const { ctx, calls } = moCtx(list);
  moEv('click').run({ target: moButton('none') }, ctx);
  assert.deepEqual(list, []);
  assert.equal(calls.refresh, 1);
  assert.equal(calls.commit, 1);
});

test('multiopts options 函数形式 + 数组初始化：全选现扫 cfg / c[key] 非数组就地置 []', () => {
  const calls = { commit: 0, refresh: 0 };
  const ctx = {
    c: { pool: [{ value: 5 }, { value: 6 }] }, // 无 opts 键
    fd: { key: 'opts', options: (c) => c.pool },
    commit: () => calls.commit++,
    refresh: () => calls.refresh++,
  };
  moEv('click').run({ target: moButton('all') }, ctx);
  assert.deepEqual(ctx.c.opts, [5, 6]);
});

// ───────────── minerules 事件级 dispatch（T3：change 不重刷 / ★再点=不限 / 加行关总开关） ─────────────
// 矿种/等级 change 即落盘（原生 select 自持选中态，不 refresh）；★点选/增删是结构或视觉变化，整块重刷。
const MR_FD = {
  key: 'mrules',
  options: [
    { value: 0, label: '不限' },
    { value: 1, label: '金矿' },
    { value: 2, label: '粮' },
  ],
  levelOptions: [{ value: 1 }, { value: 2 }, { value: 3 }],
  maxStar: 5,
};
/** minerules ctx stub：同 farmrules 口径（c 带 enabled/intentEnabled，box.closest('.pc-sec')→sec→enCb） */
function mrCtx(list) {
  const calls = { commit: 0, refresh: 0, syncChecks: 0, syncChecksSec: null };
  const enCb = { checked: true };
  const sec = { querySelector: (sel) => (sel === '.pc-en[data-id="ft-mr"]' ? enCb : null) };
  const box = { closest: (sel) => (sel === '.pc-sec' ? sec : null) };
  return {
    ctx: {
      c: { mrules: list, enabled: true, intentEnabled: true },
      fd: MR_FD,
      fid: 'ft-mr',
      box,
      commit: () => calls.commit++,
      refresh: () => calls.refresh++,
      syncChecks: (s) => {
        calls.syncChecks++;
        calls.syncChecksSec = s;
      },
    },
    calls,
    enCb,
    sec,
  };
}
function mrEl(idx, part, value) {
  return {
    value,
    dataset: { part },
    closest: (sel) => (sel === '.pc-mrrow[data-idx]' ? { dataset: { idx: String(idx) } } : null),
  };
}
/** ★ stub：closest('.pc-mrstar') 返回自身（带 data-star），行下标靠 .pc-mrrow[data-idx] */
function mrStar(idx, s) {
  const star = {
    dataset: { star: String(s) },
    closest: (sel) => {
      if (sel === '.pc-mrstar') return star;
      if (sel === '.pc-mrrow[data-idx]') return { dataset: { idx: String(idx) } };
      return null;
    },
  };
  return star;
}
function mrButton(kind, idx) {
  const btn = {
    closest: (sel) => {
      if (sel === '.pc-mrdel') return kind === 'del' ? btn : null;
      if (sel === '.pc-mradd') return kind === 'add' ? btn : null;
      if (sel === '.pc-mrrow[data-idx]') return { dataset: { idx: String(idx) } };
      return null;
    },
  };
  return btn;
}
const mrEv = (on) => minerulesType.events.find((e) => e.on === on);

test('minerules events 声明：change(mrsel) + click(star/增删)', () => {
  assert.equal(minerulesType.events.length, 2);
  assert.equal(mrEv('change').sel, '.pc-mrsel');
  assert.equal(mrEv('click').sel, '.pc-mrstar,.pc-mrdel,.pc-mradd');
});

test('minerules 矿种/等级 change：按 data-part 写维度 + commit 一次，不 refresh', () => {
  const list = [{ type: 0, level: 1, star: 0 }];
  const { ctx, calls } = mrCtx(list);
  mrEv('change').run({ target: mrEl(0, 'type', '2') }, ctx);
  assert.equal(list[0].type, 2);
  mrEv('change').run({ target: mrEl(0, 'level', '3') }, ctx);
  assert.equal(list[0].level, 3);
  assert.equal(calls.commit, 2);
  assert.equal(calls.refresh, 0);
});

test('minerules change 非法值归 0（parseInt||0）', () => {
  const list = [{ type: 1, level: 1, star: 0 }];
  const { ctx } = mrCtx(list);
  mrEv('change').run({ target: mrEl(0, 'type', 'abc') }, ctx);
  assert.equal(list[0].type, 0);
});

test('minerules ★点选：点亮 / 再点当前星=不限（toggle）+ refresh + commit', () => {
  const list = [{ type: 1, level: 1, star: 0 }];
  const { ctx, calls } = mrCtx(list);
  mrEv('click').run({ target: mrStar(0, 3) }, ctx);
  assert.equal(list[0].star, 3);
  mrEv('click').run({ target: mrStar(0, 3) }, ctx); // 再点当前星
  assert.equal(list[0].star, 0);
  assert.equal(calls.refresh, 2);
  assert.equal(calls.commit, 2);
});

test('minerules 增行：默认矿种=第一个真实值/等级=最高/星=最高 + 关总开关 + syncChecks', () => {
  const list = [{ type: 1, level: 1, star: 1 }];
  const { ctx, calls, enCb, sec } = mrCtx(list);
  mrEv('click').run({ target: mrButton('add', 0) }, ctx);
  assert.deepEqual(list[1], { type: 1, level: 3, star: 5 });
  assert.equal(ctx.c.enabled, false);
  assert.equal(ctx.c.intentEnabled, false);
  assert.equal(enCb.checked, false);
  assert.equal(calls.syncChecks, 1);
  assert.equal(calls.syncChecksSec, sec);
  assert.equal(calls.refresh, 1);
  assert.equal(calls.commit, 1);
});

test('minerules 删行：按 data-idx splice + refresh + commit（不关总开关）', () => {
  const list = [{ type: 1 }, { type: 2 }];
  const { ctx, calls } = mrCtx(list);
  mrEv('click').run({ target: mrButton('del', 0) }, ctx);
  assert.equal(list.length, 1);
  assert.deepEqual(list[0], { type: 2 });
  assert.equal(ctx.c.enabled, true); // 删行不暂停总开关
  assert.equal(calls.syncChecks, 0);
  assert.equal(calls.refresh, 1);
  assert.equal(calls.commit, 1);
});

test('minerules 行号越界：change 丢弃不写不 commit', () => {
  const list = [{ type: 1, level: 1, star: 0 }];
  const { ctx, calls } = mrCtx(list);
  mrEv('change').run({ target: mrEl(5, 'type', '2') }, ctx);
  assert.equal(list[0].type, 1);
  assert.equal(calls.commit, 0);
});

test('minerules 增行：options/levelOptions/maxStar 支持函数 + 数组初始化', () => {
  const calls = { commit: 0, refresh: 0, syncChecks: 0 };
  const sec = { querySelector: () => null };
  const ctx = {
    c: { enabled: true, intentEnabled: true, pool: [{ value: 9 }] }, // 无 mrules 键
    fd: {
      key: 'mrules',
      options: (c) => c.pool,
      levelOptions: () => [{ value: 4 }],
      maxStar: () => 3,
    },
    fid: 'ft-mr',
    box: { closest: () => sec },
    commit: () => calls.commit++,
    refresh: () => calls.refresh++,
    syncChecks: () => calls.syncChecks++,
  };
  mrEv('click').run({ target: mrButton('add', 0) }, ctx);
  assert.deepEqual(ctx.c.mrules, [{ type: 9, level: 4, star: 3 }]);
});

// ───────────── timeranges 事件级 dispatch（T3：input 只 mutate / change 提交不重刷 / 增行默认时段） ─────────────
function trCtx(list) {
  const calls = { commit: 0, refresh: 0 };
  return {
    ctx: {
      c: { trules: list },
      fd: { key: 'trules' },
      commit: () => calls.commit++,
      refresh: () => calls.refresh++,
    },
    calls,
  };
}
function trEl(idx, part, value) {
  return {
    value,
    dataset: { part },
    closest: (sel) => (sel === '.pc-trow[data-idx]' ? { dataset: { idx: String(idx) } } : null),
  };
}
function trButton(kind, idx) {
  const btn = {
    closest: (sel) => {
      if (sel === '.pc-tdel') return kind === 'del' ? btn : null;
      if (sel === '.pc-tradd') return kind === 'add' ? btn : null;
      if (sel === '.pc-trow[data-idx]') return { dataset: { idx: String(idx) } };
      return null;
    },
  };
  return btn;
}
const trEv = (on) => timerangesType.events.find((e) => e.on === on);

test('timeranges events 声明：input/change(tinp) + click(增删)', () => {
  assert.equal(timerangesType.events.length, 3);
  assert.equal(trEv('input').sel, '.pc-tinp');
  assert.equal(trEv('change').sel, '.pc-tinp');
  assert.equal(trEv('click').sel, '.pc-tdel,.pc-tradd');
});

test('timeranges input：只 mutate 内存（start/end），不 commit 不 refresh', () => {
  const list = [{ start: '09:00', end: '18:00' }];
  const { ctx, calls } = trCtx(list);
  trEv('input').run({ target: trEl(0, 'start', '08:30') }, ctx);
  trEv('input').run({ target: trEl(0, 'end', '20:00') }, ctx);
  assert.deepEqual(list[0], { start: '08:30', end: '20:00' });
  assert.equal(calls.commit, 0);
  assert.equal(calls.refresh, 0);
});

test('timeranges change：写回 + commit 一次，不 refresh（time 控件自持值）', () => {
  const list = [{ start: '09:00', end: '18:00' }];
  const { ctx, calls } = trCtx(list);
  trEv('change').run({ target: trEl(0, 'start', '10:00') }, ctx);
  assert.equal(list[0].start, '10:00');
  assert.equal(calls.commit, 1);
  assert.equal(calls.refresh, 0);
});

test('timeranges 增行：默认 09:00~18:00 + refresh + commit（不关总开关）', () => {
  const list = [];
  const { ctx, calls } = trCtx(list);
  trEv('click').run({ target: trButton('add', 0) }, ctx);
  assert.deepEqual(list[0], { start: '09:00', end: '18:00' });
  assert.equal(calls.refresh, 1);
  assert.equal(calls.commit, 1);
});

test('timeranges 删行 + 越界：splice / 越界 input 不写不 commit', () => {
  const list = [
    { start: '09:00', end: '18:00' },
    { start: '20:00', end: '22:00' },
  ];
  const { ctx, calls } = trCtx(list);
  trEv('click').run({ target: trButton('del', 0) }, ctx);
  assert.deepEqual(list, [{ start: '20:00', end: '22:00' }]);
  assert.equal(calls.commit, 1);
  trEv('input').run({ target: trEl(9, 'start', '01:00') }, ctx);
  assert.equal(calls.commit, 1); // 越界不新增提交
});

// ───────────── presetpool 事件级 dispatch（T3：跨行去重撞值回弹只 refresh 不 commit / 增行取空闲） ─────────────
function ppCtx(list, max) {
  const calls = { commit: 0, refresh: 0 };
  return {
    ctx: {
      c: { pp: list },
      fd: { key: 'pp', max },
      commit: () => calls.commit++,
      refresh: () => calls.refresh++,
    },
    calls,
  };
}
function ppEl(idx, value) {
  return {
    value,
    closest: (sel) => (sel === '.pc-pprow[data-idx]' ? { dataset: { idx: String(idx) } } : null),
  };
}
function ppButton(kind, idx) {
  const btn = {
    closest: (sel) => {
      if (sel === '.pc-ppdel') return kind === 'del' ? btn : null;
      if (sel === '.pc-ppadd') return kind === 'add' ? btn : null;
      if (sel === '.pc-pprow[data-idx]') return { dataset: { idx: String(idx) } };
      return null;
    },
  };
  return btn;
}
const ppEv = (on) => presetpoolType.events.find((e) => e.on === on);

test('presetpool events 声明：change(ppsel) + click(增删)', () => {
  assert.equal(presetpoolType.events.length, 2);
  assert.equal(ppEv('change').sel, '.pc-ppsel');
  assert.equal(ppEv('click').sel, '.pc-ppdel,.pc-ppadd');
});

test('presetpool 改选正常：写回 + refresh + commit 各一次', () => {
  const list = [1, 2];
  const { ctx, calls } = ppCtx(list, 8);
  ppEv('change').run({ target: ppEl(0, '3') }, ctx);
  assert.deepEqual(list, [3, 2]);
  assert.equal(calls.refresh, 1);
  assert.equal(calls.commit, 1);
});

test('presetpool 跨行去重：撞已占用值 → 只 refresh 不 commit，配置不变', () => {
  const list = [1, 2];
  const { ctx, calls } = ppCtx(list, 8);
  ppEv('change').run({ target: ppEl(0, '2') }, ctx); // 2 已被行1占用
  assert.deepEqual(list, [1, 2]);
  assert.equal(calls.refresh, 1);
  assert.equal(calls.commit, 0);
});

test('presetpool 选回本行当前值：不算去重（list[idx]===v）+ refresh + commit', () => {
  const list = [1, 2];
  const { ctx, calls } = ppCtx(list, 8);
  ppEv('change').run({ target: ppEl(0, '1') }, ctx);
  assert.deepEqual(list, [1, 2]);
  assert.equal(calls.refresh, 1);
  assert.equal(calls.commit, 1);
});

test('presetpool 增行：取第一空闲预设号 + refresh + commit', () => {
  const list = [1, 2];
  const { ctx, calls } = ppCtx(list, 8);
  ppEv('click').run({ target: ppButton('add', 0) }, ctx);
  assert.deepEqual(list, [1, 2, 3]);
  assert.equal(calls.refresh, 1);
  assert.equal(calls.commit, 1);
});

test('presetpool 增行达上限：忽略（＋已 disabled 兜底），不 refresh 不 commit', () => {
  const list = [1, 2];
  const { ctx, calls } = ppCtx(list, 2);
  ppEv('click').run({ target: ppButton('add', 0) }, ctx);
  assert.deepEqual(list, [1, 2]);
  assert.equal(calls.refresh, 0);
  assert.equal(calls.commit, 0);
});

test('presetpool 删行 + 数组初始化：splice / c[key] 非数组增行就地置 [1]', () => {
  const list = [1, 2, 3];
  const { ctx, calls } = ppCtx(list, 8);
  ppEv('click').run({ target: ppButton('del', 1) }, ctx);
  assert.deepEqual(list, [1, 3]);
  assert.equal(calls.commit, 1);
  const init = ppCtx(undefined, 8);
  init.ctx.c = {}; // 无 pp 键
  ppEv('click').run({ target: ppButton('add', 0) }, init.ctx);
  assert.deepEqual(init.ctx.c.pp, [1]);
});

// ───────────── infogrid（T3：纯只读无 events，行集来自 fd.rows(c)） ─────────────
test('infogrid 注册：box 型只读，无 events（纯展示不写配置）', () => {
  const mod = getTypeModule('infogrid');
  assert.equal(mod, infogridType);
  assert.equal(mod.cls, 'pc-igraphbox');
  assert.equal(mod.events, undefined);
  assert.equal(typeof mod.render, 'function');
});

test('infogrid render：行集来自 fd.rows(c)，固定列栅格 + 右对齐（不读 val）', () => {
  const fd = {
    label: '密所',
    columns: [{ label: '区' }, { label: '等级', align: 'right' }],
    rows: (c) => c.recs,
  };
  const html = infogridType.render(null, fd, {
    recs: [
      ['A', '3'],
      ['B', '5'],
    ],
  });
  assert.match(html, /pc-igraph/);
  assert.match(html, /grid-template-columns:repeat\(2,minmax\(0,max-content\)\)/);
  assert.match(html, /pc-igright/);
  assert.match(html, />A</);
  assert.match(html, />5</);
});

// ───────────── T4 内联无状态型（checkbox/number/select/string/button/text/note） ─────────────
// 内联型 kind:'inline'：buildFieldsHTML 走 module 路径直出 inner（无 fieldBox 外壳）；
//   events 由 wire.js dispatcher 内联路径（e.target[data-id]+data-key/bkey，仅顶层字段）分发，此处直调 run(e,stubCtx) 验纯逻辑。
//   number 兼「无 type 顶层字段」兜底；双轨守卫（wireControls 跳过 module 拥有的顶层控件）在 wire.js 闭包内，渲染等价由 ui-snapshot 对拍证明。

test('T4 注册：7 内联 module 在表，kind 均为 inline', () => {
  for (const [type, mod] of [
    ['checkbox', checkboxType],
    ['number', numberType],
    ['select', selectType],
    ['string', stringType],
    ['button', buttonType],
    ['text', textType],
    ['note', noteType],
  ]) {
    assert.equal(getTypeModule(type), mod);
    assert.equal(mod.kind, 'inline');
    assert.equal(typeof mod.render, 'function');
  }
});

test('T4 buildFieldsHTML：checkbox 走 module 直出 inner（无 fieldBox 外壳）', () => {
  configs['ft-cb'] = { on: true };
  const f = { fields: [{ key: 'on', type: 'checkbox', label: '开关' }] };
  const html = buildFieldsHTML('ft-cb', f);
  assert.match(html, /class="pc-fchk"/);
  assert.match(html, /data-id="ft-cb"/);
  assert.match(html, /data-key="on"/);
  assert.match(html, /checked/);
  assert.doesNotMatch(html, /data-fkey/); // inline 无容器外壳
});

test('T4 buildFieldsHTML：无 type 顶层字段落 number module 兜底', () => {
  configs['ft-num'] = { n: 3 };
  const f = { fields: [{ key: 'n', label: '数量', min: 0, step: 1 }] };
  const html = buildFieldsHTML('ft-num', f);
  assert.match(html, /type="number"/);
  assert.match(html, /data-key="n"/);
  assert.match(html, /value="3"/);
});

test('T4 buildFieldsHTML：显式 type:number + zeroUnlimited（0 → 留空 + 不限）', () => {
  configs['ft-zu'] = { n: 0 };
  const f = {
    fields: [{ key: 'n', type: 'number', label: '上限', min: 0, step: 1, zeroUnlimited: true }],
  };
  const html = buildFieldsHTML('ft-zu', f);
  assert.match(html, /type="number"/);
  assert.match(html, /placeholder="不限"/);
  assert.match(html, /value=""/);
});

// checkbox 事件级
function cbCtx(checked) {
  const calls = { commit: 0, refresh: 0 };
  return {
    ctx: {
      c: { on: checked },
      fd: { key: 'on' },
      commit: () => calls.commit++,
      refresh: () => calls.refresh++,
    },
    calls,
  };
}
const cbEv = (on) => checkboxType.events.find((e) => e.on === on);

test('checkbox events 声明：click(.pc-fchk) + change(.pc-fchk)', () => {
  assert.equal(checkboxType.events.length, 2);
  assert.equal(cbEv('click').sel, '.pc-fchk');
  assert.equal(cbEv('change').sel, '.pc-fchk');
});

test('checkbox change：写勾选态 + commit 一次，不 refresh', () => {
  const { ctx, calls } = cbCtx(false);
  cbEv('change').run({ target: { checked: true } }, ctx);
  assert.equal(ctx.c.on, true);
  assert.equal(calls.commit, 1);
  assert.equal(calls.refresh, 0);
});

test('checkbox click：stopPropagation（不触发卡片折叠）', () => {
  let stopped = 0;
  cbEv('click').run({ stopPropagation: () => stopped++ }, cbCtx(false).ctx);
  assert.equal(stopped, 1);
});

// number 事件级
function numCtx(fd, c, defaults) {
  const calls = { commit: 0, refresh: 0 };
  return {
    ctx: {
      c,
      fd,
      f: { defaults: defaults || {} },
      commit: () => calls.commit++,
      refresh: () => calls.refresh++,
    },
    calls,
  };
}
const numEv = () => numberType.events.find((e) => e.on === 'change');

test('number events 声明：change(input[type=number])', () => {
  assert.equal(numberType.events.length, 1);
  assert.equal(numEv().sel, 'input[type=number]');
});

test('number change：钳制到 min + 回写控件值 + commit', () => {
  const input = { value: '3' };
  const { ctx, calls } = numCtx({ key: 'n', min: 5 }, { n: 0 });
  numEv().run({ target: input }, ctx);
  assert.equal(ctx.c.n, 5);
  assert.equal(input.value, 5);
  assert.equal(calls.commit, 1);
});

test('number change：非法值回落 defaults', () => {
  const input = { value: 'abc' };
  const { ctx } = numCtx({ key: 'n', min: 0 }, { n: 0 }, { n: 7 });
  numEv().run({ target: input }, ctx);
  assert.equal(ctx.c.n, 7);
});

test('number change：zeroUnlimited 留空 → 0，控件回写留空', () => {
  const input = { value: '' };
  const { ctx, calls } = numCtx({ key: 'n', min: 0, zeroUnlimited: true }, { n: 5 });
  numEv().run({ target: input }, ctx);
  assert.equal(ctx.c.n, 0);
  assert.equal(input.value, '');
  assert.equal(calls.commit, 1);
});

test('number change：float 解析小数', () => {
  const input = { value: '2.5' };
  const { ctx } = numCtx({ key: 'n', min: 0, float: true }, { n: 0 });
  numEv().run({ target: input }, ctx);
  assert.equal(ctx.c.n, 2.5);
});

// select 事件级
function selCtx(fd, c, defaults) {
  const calls = { commit: 0, refresh: 0 };
  return {
    ctx: {
      c,
      fd,
      f: { defaults: defaults || {} },
      commit: () => calls.commit++,
      refresh: () => calls.refresh++,
    },
    calls,
  };
}
const selEv = () => selectType.events.find((e) => e.on === 'change');

test('select events 声明：change(.pc-fsel)', () => {
  assert.equal(selectType.events.length, 1);
  assert.equal(selEv().sel, '.pc-fsel');
});

test('select change：命中 option 保留原类型（字符串档不被 parseInt 成 NaN）', () => {
  const sel = { value: 'specify' };
  const fd = {
    key: 'mode',
    options: [
      { value: 'random', label: '随机' },
      { value: 'specify', label: '指定' },
    ],
  };
  const { ctx, calls } = selCtx(fd, { mode: 'random' });
  selEv().run({ target: sel }, ctx);
  assert.equal(ctx.c.mode, 'specify');
  assert.equal(sel.value, 'specify');
  assert.equal(calls.commit, 1);
});

test('select change：命中数字 option 取 number 原类型', () => {
  const sel = { value: '2' };
  const { ctx } = selCtx({ key: 'k', options: [{ value: 1 }, { value: 2 }] }, { k: 1 });
  selEv().run({ target: sel }, ctx);
  assert.equal(ctx.c.k, 2);
});

test('select change：没命中 option 走整数解析；非法值回落 defaults', () => {
  const a = { value: '9' };
  const ca = selCtx({ key: 'k', options: [{ value: 1 }] }, { k: 1 }, { k: 4 });
  selEv().run({ target: a }, ca.ctx);
  assert.equal(ca.ctx.c.k, 9);
  const b = { value: 'abc' };
  const cb = selCtx({ key: 'k', options: [{ value: 1 }] }, { k: 1 }, { k: 4 });
  selEv().run({ target: b }, cb.ctx);
  assert.equal(cb.ctx.c.k, 4);
});

test('select change：options 函数形式现扫 cfg', () => {
  const sel = { value: '6' };
  const fd = { key: 'k', options: (c) => c.pool };
  const { ctx } = selCtx(fd, { k: 5, pool: [{ value: 5 }, { value: 6 }] });
  selEv().run({ target: sel }, ctx);
  assert.equal(ctx.c.k, 6);
});

// string 事件级
const strEv = (on) => stringType.events.find((e) => e.on === on);

test('string events 声明：click(.pc-fstr) + change(.pc-fstr)', () => {
  assert.equal(stringType.events.length, 2);
  assert.equal(strEv('click').sel, '.pc-fstr');
  assert.equal(strEv('change').sel, '.pc-fstr');
});

test('string change：trim 后按字符串存档 + 回写控件 + commit', () => {
  const input = { value: '  abc  ' };
  const calls = { commit: 0 };
  const ctx = { c: { uid: '' }, fd: { key: 'uid' }, commit: () => calls.commit++ };
  strEv('change').run({ target: input }, ctx);
  assert.equal(ctx.c.uid, 'abc');
  assert.equal(input.value, 'abc');
  assert.equal(calls.commit, 1);
});

test('string click：stopPropagation', () => {
  let stopped = 0;
  strEv('click').run({ stopPropagation: () => stopped++ }, {});
  assert.equal(stopped, 1);
});

// button 事件级
const btnEv = () => buttonType.events.find((e) => e.on === 'click');
function btnStub(label) {
  const btn = {
    isConnected: true,
    disabled: false,
    textContent: label,
    closest: (sel) => (sel === '.pc-fbtn' ? btn : null),
  };
  return btn;
}

test('button events 声明：click(.pc-fbtn)', () => {
  assert.equal(buttonType.events.length, 1);
  assert.equal(btnEv().sel, '.pc-fbtn');
});

test('button click：调 onClick + busy 态 + stopPropagation，Promise 完成后复原', async () => {
  const btn = btnStub('刷新');
  let stopped = 0;
  let clicked = 0;
  const fd = {
    key: 'act',
    label: '刷新',
    busyText: '处理中',
    onClick: () => {
      clicked++;
      return Promise.resolve();
    },
  };
  btnEv().run({ target: btn, stopPropagation: () => stopped++ }, { c: {}, fd });
  assert.equal(stopped, 1);
  assert.equal(clicked, 1);
  assert.equal(btn.disabled, true);
  assert.equal(btn.textContent, '处理中');
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(btn.disabled, false);
  assert.equal(btn.textContent, '刷新');
});

test('button click：无 onClick 函数 → 早退（不进 busy 态）', () => {
  const btn = btnStub('刷新');
  btnEv().run(
    { target: btn, stopPropagation: () => {} },
    { c: {}, fd: { key: 'act', label: '刷新' } },
  );
  assert.equal(btn.disabled, false);
  assert.equal(btn.textContent, '刷新');
});

test('button click：onClick 同步抛错 → catch 复原', () => {
  const btn = btnStub('刷新');
  const fd = {
    key: 'act',
    label: '刷新',
    onClick: () => {
      throw new Error('boom');
    },
  };
  btnEv().run({ target: btn, stopPropagation: () => {} }, { c: {}, fd });
  assert.equal(btn.disabled, false);
  assert.equal(btn.textContent, '刷新');
});

// text refreshText 钩子 + note 静态
test('text：无 events，refreshText 按 fd.get 就地重算', () => {
  assert.equal(textType.events, undefined);
  const el = { textContent: 'old' };
  textType.refreshText(el, { fd: { get: (c) => c.v }, c: { v: 'new' } });
  assert.equal(el.textContent, 'new');
});

test('text refreshText：无 fd.get 不改文本', () => {
  const el = { textContent: 'keep' };
  textType.refreshText(el, { fd: {}, c: {} });
  assert.equal(el.textContent, 'keep');
});

test('note：无 events，render 输出转义说明横幅', () => {
  assert.equal(noteType.events, undefined);
  const html = noteType.render(null, { text: 'a<b>' });
  assert.match(html, /class="pc-fnote"/);
  assert.match(html, /a&lt;b&gt;/);
});

// ───────────── T5：有状态清单 + 子控件 module（注册形状 / events / refreshText / 路由 / 装配编排） ─────────────
// 直接调各 module.events[i].run(e, ctx)（commit 计数 spy），与 T1~T4 同范式。
// 子控件 handler 经 findFieldDescriptor 下探子描述符，故 ctx.f 须带真实 fields（tripick.parts / ctrlrow.cells / rallygrid.rows）。
// 真实 mount*（DOM 重）不在单测执行：渲染等价由 ui-snapshot 对拍证明，装配编排用自定义 spy module 隔离验证。

test('T5 注册：7 类型在表，kind/cls/assembleSel 形状正确', () => {
  assert.equal(getTypeModule('uidlist'), uidlistType);
  assert.equal(getTypeModule('sortlist'), sortlistType);
  assert.equal(getTypeModule('itemlist'), itemlistType);
  assert.equal(getTypeModule('uid'), uidType);
  assert.equal(getTypeModule('tripick'), tripickType);
  assert.equal(getTypeModule('ctrlrow'), ctrlrowType);
  assert.equal(getTypeModule('rallygrid'), rallygridType);
  assert.equal(uidlistType.kind, 'box');
  assert.equal(uidlistType.cls, 'pc-ulist');
  assert.equal(uidlistType.assembleSel, '.pc-ulist');
  assert.equal(sortlistType.assembleSel, '.pc-slist');
  assert.equal(itemlistType.assembleSel, '.pc-ilist');
  assert.equal(uidType.kind, 'inline');
  assert.equal(uidType.assembleSel, '.pc-uidwrap:not(.pc-uli)');
  // 子控件 inline 无 assembleSel（无闭包态，靠 dispatcher + syncControls 通用回写）
  assert.equal(tripickType.kind, 'inline');
  assert.equal(tripickType.assembleSel, undefined);
  assert.equal(ctrlrowType.assembleSel, undefined);
  assert.equal(rallygridType.assembleSel, undefined);
});

test('T5 装配钩子：三清单 assemble=sync（mount*），uid assemble/sync 分离（sync 只回显示态）', () => {
  assert.equal(uidlistType.assemble, uidlistType.sync);
  assert.equal(sortlistType.assemble, sortlistType.sync);
  assert.equal(itemlistType.assemble, itemlistType.sync);
  assert.equal(typeof uidType.assemble, 'function');
  assert.equal(typeof uidType.sync, 'function');
  assert.notEqual(uidType.assemble, uidType.sync); // assemble=bindUidScalar，sync=__pcUidRefresh，绝不重绑
});

test('sortlist 走 module：pc-slist 外壳 + 拖拽行', () => {
  configs['ft-slist'] = { order: ['a', 'b'] };
  const f = { fields: [{ key: 'order', type: 'sortlist', label: '优先级' }] };
  const html = buildFieldsHTML('ft-slist', f);
  assert.match(html, /class="pc-slist"/);
  assert.match(html, /data-fkey="order"/);
  assert.match(html, /pc-srow/);
});

test('itemlist 走 module：pc-ilist 外壳 + 池行', () => {
  configs['ft-ilist'] = { pool: {} };
  const f = {
    fields: [{ key: 'pool', type: 'itemlist', label: '物品', items: [{ id: 'x', label: 'X' }] }],
  };
  const html = buildFieldsHTML('ft-ilist', f);
  assert.match(html, /class="pc-ilist"/);
  assert.match(html, /data-fkey="pool"/);
  assert.match(html, /pc-irow/);
});

// uid 事件级（enableKey 勾选，dispatcher 内联路径经 findFieldOwner 路由）
const uidEv = (on) => uidType.events.find((e) => e.on === on);

test('uid events 声明：click(.pc-fchk) + change(.pc-fchk)', () => {
  assert.equal(uidType.events.length, 2);
  assert.equal(uidEv('click').sel, '.pc-fchk');
  assert.equal(uidEv('change').sel, '.pc-fchk');
});

test('uid click：stopPropagation（不触发卡片折叠）', () => {
  let stopped = 0;
  uidEv('click').run({ stopPropagation: () => stopped++ }, {});
  assert.equal(stopped, 1);
});

test('uid change：enableKey 写回 + commit 恰一次', () => {
  const calls = { commit: 0 };
  const ctx = { c: { en: false }, fd: { key: 'u' }, commit: () => calls.commit++ };
  uidEv('change').run({ target: { dataset: { key: 'en' }, checked: true } }, ctx);
  assert.equal(ctx.c.en, true);
  assert.equal(calls.commit, 1);
});

test('uid sync：调 __pcUidRefresh 回显示态（不重绑）；未装配不抛错', () => {
  let refreshed = 0;
  uidType.sync({ __pcUidRefresh: () => refreshed++ });
  assert.equal(refreshed, 1);
  uidType.sync({});
});

test('uid render：pc-uidwrap + data-ukey/nkey/ekey + enableKey 勾选 + 缓存名', () => {
  const fd = { key: 'u', nameKey: 'nm', enableKey: 'en', label: 'UID', placeholder: 'ph' };
  const html = uidType.render(null, fd, { u: '123', nm: '张三', en: true }, 'fid');
  assert.match(html, /class="pc-uidwrap"/);
  assert.match(html, /data-ukey="u"/);
  assert.match(html, /data-nkey="nm"/);
  assert.match(html, /data-ekey="en"/);
  assert.match(html, /<button type="button" class="pc-udisp"[^>]*aria-label="编辑目标 UID"/);
  assert.match(html, /data-key="en" aria-label="启用 UID" checked/);
  assert.match(html, /张三/);
});

// tripick 事件级（子下拉经 findFieldDescriptor 下探 parts）
function triCtx(parts, c, defaults) {
  const calls = { commit: 0 };
  return {
    ctx: {
      f: { fields: [{ key: 'tri', type: 'tripick', parts }], defaults: defaults || {} },
      fd: { key: 'tri', type: 'tripick', parts },
      c,
      commit: () => calls.commit++,
    },
    calls,
  };
}
const triEv = () => tripickType.events.find((e) => e.on === 'change');

test('tripick events 声明：change(.pc-fsel)', () => {
  assert.equal(tripickType.events.length, 1);
  assert.equal(triEv().sel, '.pc-fsel');
});

test('tripick change：下探 part 命中 option 保留原类型 + 回写控件 + commit', () => {
  const parts = [{ key: 'a', options: [{ value: 'x' }, { value: 'y' }] }];
  const { ctx, calls } = triCtx(parts, { a: 'x' });
  const sel = { value: 'y', dataset: { key: 'a' } };
  triEv().run({ target: sel }, ctx);
  assert.equal(ctx.c.a, 'y');
  assert.equal(sel.value, 'y');
  assert.equal(calls.commit, 1);
});

test('tripick change：数字 option 取 number 原类型', () => {
  const parts = [{ key: 'a', options: [{ value: 1 }, { value: 2 }] }];
  const { ctx } = triCtx(parts, { a: 1 });
  triEv().run({ target: { value: '2', dataset: { key: 'a' } } }, ctx);
  assert.equal(ctx.c.a, 2);
});

test('tripick change：没命中走整数解析；非法回落 defaults', () => {
  const parts = [{ key: 'a', options: [{ value: 1 }] }];
  const c1 = triCtx(parts, { a: 1 }, { a: 9 });
  triEv().run({ target: { value: '5', dataset: { key: 'a' } } }, c1.ctx);
  assert.equal(c1.ctx.c.a, 5);
  const c2 = triCtx(parts, { a: 1 }, { a: 9 });
  triEv().run({ target: { value: 'abc', dataset: { key: 'a' } } }, c2.ctx);
  assert.equal(c2.ctx.c.a, 9);
});

test('tripick change：options 函数形式现扫 cfg', () => {
  const parts = [{ key: 'a', options: (c) => c.pool }];
  const { ctx } = triCtx(parts, { a: 5, pool: [{ value: 5 }, { value: 6 }] });
  triEv().run({ target: { value: '6', dataset: { key: 'a' } } }, ctx);
  assert.equal(ctx.c.a, 6);
});

test('tripick change：未知子 key（findFieldDescriptor 落空）早退不 commit', () => {
  const parts = [{ key: 'a', options: [{ value: 1 }] }];
  const { ctx, calls } = triCtx(parts, { a: 1 });
  triEv().run({ target: { value: '2', dataset: { key: 'zzz' } } }, ctx);
  assert.equal(ctx.c.a, 1);
  assert.equal(calls.commit, 0);
});

// ctrlrow 事件级（子下拉经 findFieldDescriptor 下探 cells）
function crCtx(cells, c, defaults) {
  const calls = { commit: 0 };
  return {
    ctx: {
      f: { fields: [{ key: 'row', type: 'ctrlrow', cells }], defaults: defaults || {} },
      fd: { key: 'row', type: 'ctrlrow', cells },
      c,
      commit: () => calls.commit++,
    },
    calls,
  };
}
const crEv = () => ctrlrowType.events.find((e) => e.on === 'change');

test('ctrlrow events 声明：change(.pc-fsel)', () => {
  assert.equal(ctrlrowType.events.length, 1);
  assert.equal(crEv().sel, '.pc-fsel');
});

test('ctrlrow change：cell 下探 + 命中 option 原类型 + commit', () => {
  const cells = [{ key: 'lv', options: [{ value: 1 }, { value: 2 }] }];
  const { ctx, calls } = crCtx(cells, { lv: 1 });
  crEv().run({ target: { value: '2', dataset: { key: 'lv' } } }, ctx);
  assert.equal(ctx.c.lv, 2);
  assert.equal(calls.commit, 1);
});

test('ctrlrow render：非表格变体 label.pc-row + 子下拉 data-key（无容器外壳）', () => {
  const fd = {
    key: 'row',
    label: '行',
    cells: [{ key: 'lv', options: [{ value: 1, label: '一' }] }],
  };
  const html = ctrlrowType.render(null, fd, { lv: 1 }, 'fid');
  assert.match(html, /class="pc-row"/);
  assert.match(html, /data-key="lv"/);
  assert.doesNotMatch(html, /data-fkey/);
});

test('ctrlrow render：表格变体 .pc-hl.pc-ct 带 data-fkey + text 只读格', () => {
  const fd = {
    key: 'row',
    table: true,
    cells: [
      { key: 'lv', options: [{ value: 1, label: '一' }] },
      { key: 'done', type: 'text', get: () => '3' },
    ],
  };
  const html = ctrlrowType.render(null, fd, { lv: 1 }, 'fid');
  assert.match(html, /class="pc-hl pc-ct"/);
  assert.match(html, /data-fkey="row"/);
  assert.match(html, /pc-hlstat/);
  assert.match(html, /data-fkey="done"/);
});

// rallygrid 事件级（数字/勾选/删除四路，容器路径直接命中）
const rgEv = (on, sel) => rallygridType.events.find((e) => e.on === on && e.sel === sel);
const RG_ROWS = [
  {
    name: '目标',
    enableKey: 'en',
    delay: { key: 'd', min: 0 },
    limit: { key: 'l', min: 0, zeroUnlimited: true },
    count: { key: 'cnt', get: () => '5' },
  },
];
function rgCtx(rows, c, defaults) {
  const calls = { commit: 0 };
  return {
    ctx: {
      f: { fields: [{ key: 'grid', type: 'rallygrid', rows }], defaults: defaults || {} },
      fd: { key: 'grid', type: 'rallygrid', rows },
      c,
      commit: () => calls.commit++,
    },
    calls,
  };
}

test('rallygrid events 声明：rgin change / rgchk click+change / rgdel click', () => {
  assert.equal(rallygridType.events.length, 4);
  assert.equal(rgEv('change', '.pc-rgin').sel, '.pc-rgin');
  assert.equal(rgEv('click', '.pc-rgchk').sel, '.pc-rgchk');
  assert.equal(rgEv('change', '.pc-rgchk').sel, '.pc-rgchk');
  assert.equal(rgEv('click', '.pc-rgdel').sel, '.pc-rgdel');
});

test('rallygrid rgin change：delay 整数解析 + min 钳制负值 + commit', () => {
  const { ctx, calls } = rgCtx(RG_ROWS, { d: 0 });
  const inp = { value: '-3', dataset: { key: 'd' } };
  rgEv('change', '.pc-rgin').run({ target: inp }, ctx);
  assert.equal(ctx.c.d, 0);
  assert.equal(inp.value, 0);
  assert.equal(calls.commit, 1);
});

test('rallygrid rgin change：limit zeroUnlimited 留空 → 0，控件回写留空', () => {
  const { ctx, calls } = rgCtx(RG_ROWS, { l: 5 });
  const inp = { value: '', dataset: { key: 'l' } };
  rgEv('change', '.pc-rgin').run({ target: inp }, ctx);
  assert.equal(ctx.c.l, 0);
  assert.equal(inp.value, '');
  assert.equal(calls.commit, 1);
});

test('rallygrid rgin change：非法值回落 defaults', () => {
  const { ctx } = rgCtx(RG_ROWS, { d: 0 }, { d: 7 });
  rgEv('change', '.pc-rgin').run({ target: { value: 'abc', dataset: { key: 'd' } } }, ctx);
  assert.equal(ctx.c.d, 7);
});

test('rallygrid rgin change：float 解析小数', () => {
  const rows = [{ delay: { key: 'd', float: true, min: 0 } }];
  const { ctx } = rgCtx(rows, { d: 0 });
  rgEv('change', '.pc-rgin').run({ target: { value: '2.5', dataset: { key: 'd' } } }, ctx);
  assert.equal(ctx.c.d, 2.5);
});

test('rallygrid rgchk click：stopPropagation', () => {
  let stopped = 0;
  rgEv('click', '.pc-rgchk').run({ stopPropagation: () => stopped++ }, {});
  assert.equal(stopped, 1);
});

test('rallygrid rgchk change：enableKey 写回 + commit', () => {
  const calls = { commit: 0 };
  const ctx = { c: { en: false }, fd: { key: 'grid' }, commit: () => calls.commit++ };
  rgEv('change', '.pc-rgchk').run({ target: { dataset: { key: 'en' }, checked: true } }, ctx);
  assert.equal(ctx.c.en, true);
  assert.equal(calls.commit, 1);
});

test('rallygrid rgdel click：stopPropagation + blur + onDeleteRow(rowkey)', () => {
  let stopped = 0;
  let blurred = 0;
  let deleted = null;
  const del = {
    dataset: { rowkey: 'item:1' },
    blur: () => blurred++,
    closest: (sel) => (sel === '.pc-rgdel' ? del : null),
  };
  const ctx = { fd: { onDeleteRow: (k) => (deleted = k) } };
  rgEv('click', '.pc-rgdel').run({ target: del, stopPropagation: () => stopped++ }, ctx);
  assert.equal(stopped, 1);
  assert.equal(blurred, 1);
  assert.equal(deleted, 'item:1');
});

test('rallygrid rgdel click：无 onDeleteRow → 早退（仍 stopPropagation，不 blur）', () => {
  let stopped = 0;
  let blurred = 0;
  const del = {
    dataset: { rowkey: 'x' },
    blur: () => blurred++,
    closest: (sel) => (sel === '.pc-rgdel' ? del : null),
  };
  rgEv('click', '.pc-rgdel').run({ target: del, stopPropagation: () => stopped++ }, { fd: {} });
  assert.equal(stopped, 1);
  assert.equal(blurred, 0);
});

test('rallygrid render：.pc-rg 容器带 data-fkey + 行内数字/勾选/计数格', () => {
  const fd = { key: 'grid', cols: ['目标', '延迟', '上限', '已打', ''], rows: RG_ROWS };
  const html = rallygridType.render(null, fd, { d: 3, l: 0, en: true }, 'fid');
  assert.match(html, /class="pc-rg"/);
  assert.match(html, /data-fkey="grid"/);
  assert.match(html, /class="pc-rgin" data-id="fid" data-key="d"/);
  assert.match(html, /pc-rgchk/);
  assert.match(html, /pc-rgcount/);
});

// refreshText 钩子（T5：hlstat/istock/ibought 三特例从 panel.refreshTexts 收编进 module）
test('huntlist refreshText：hlstat 格按 fd.todayText(key) 就地改文本', () => {
  const el = { textContent: 'old', dataset: { hlstat: 'wolf' } };
  huntlistType.refreshText(el, { fd: { todayText: (k) => (k === 'wolf' ? '7' : '') } });
  assert.equal(el.textContent, '7');
});

test('huntlist refreshText：无 todayText / 无 hlstat → 不改', () => {
  const el = { textContent: 'keep', dataset: { hlstat: 'wolf' } };
  huntlistType.refreshText(el, { fd: {} });
  assert.equal(el.textContent, 'keep');
  const el2 = { textContent: 'keep', dataset: {} };
  huntlistType.refreshText(el2, { fd: { todayText: () => '9' } });
  assert.equal(el2.textContent, 'keep');
});

test('itemlist refreshText：istock 按 stockText / ibought 按 boughtText 就地改文本', () => {
  const stock = { textContent: 'old', dataset: { istock: 'item:1' } };
  itemlistType.refreshText(stock, { fd: { stockText: (k) => (k === 'item:1' ? '12' : '') } });
  assert.equal(stock.textContent, '12');
  const bought = { textContent: 'old', dataset: { ibought: 'item:2' } };
  itemlistType.refreshText(bought, { fd: { boughtText: () => '3' } });
  assert.equal(bought.textContent, '3');
});

test('itemlist refreshText：无对应函数 / 无行 key → 不改', () => {
  const el = { textContent: 'keep', dataset: { istock: 'x' } };
  itemlistType.refreshText(el, { fd: {} });
  assert.equal(el.textContent, 'keep');
  const el2 = { textContent: 'keep', dataset: {} };
  itemlistType.refreshText(el2, { fd: { stockText: () => '9' } });
  assert.equal(el2.textContent, 'keep');
});

// findFieldOwner：dispatcher 内联路径路由（子控件 key → owning 顶层 fd，T5 下沉 dom.js）
const OWNER_F = {
  fields: [
    { key: 'top', type: 'number' },
    { key: 'tri', type: 'tripick', parts: [{ key: 'ta' }, { key: 'tb' }] },
    { key: 'row', type: 'ctrlrow', cells: [{ key: 'ca' }] },
    {
      key: 'grid',
      type: 'rallygrid',
      rows: [
        { enableKey: 'gen', delay: { key: 'gd' }, limit: { key: 'gl' }, count: { key: 'gc' } },
      ],
    },
    { key: 'u', type: 'uid', enableKey: 'uen', nameKey: 'unm' },
  ],
};

test('findFieldOwner：顶层 key 直接返回该 fd', () => {
  assert.equal(findFieldOwner(OWNER_F, 'top'), OWNER_F.fields[0]);
});

test('findFieldOwner：tripick part / ctrlrow cell → owning 顶层 fd', () => {
  assert.equal(findFieldOwner(OWNER_F, 'ta'), OWNER_F.fields[1]);
  assert.equal(findFieldOwner(OWNER_F, 'ca'), OWNER_F.fields[2]);
});

test('findFieldOwner：rallygrid 行 enableKey/delay/limit/count → owning rallygrid fd', () => {
  const grid = OWNER_F.fields[3];
  assert.equal(findFieldOwner(OWNER_F, 'gen'), grid);
  assert.equal(findFieldOwner(OWNER_F, 'gd'), grid);
  assert.equal(findFieldOwner(OWNER_F, 'gl'), grid);
  assert.equal(findFieldOwner(OWNER_F, 'gc'), grid);
});

test('findFieldOwner：uid enableKey/nameKey → owning uid fd', () => {
  assert.equal(findFieldOwner(OWNER_F, 'uen'), OWNER_F.fields[4]);
  assert.equal(findFieldOwner(OWNER_F, 'unm'), OWNER_F.fields[4]);
});

test('findFieldOwner：未知 key / 空 f / 空 key → null', () => {
  assert.equal(findFieldOwner(OWNER_F, 'zzz'), null);
  assert.equal(findFieldOwner(null, 'top'), null);
  assert.equal(findFieldOwner({ fields: [] }, 'top'), null);
  assert.equal(findFieldOwner(OWNER_F, null), null);
});

// assembleCtx / baseCtx（ctx.js 共享核：装配级解析 + commit 管道形状）
test('assembleCtx：data-fkey 解析顶层 fd + fid/commit 在位', () => {
  reactor.register({
    id: 'ft-asm',
    label: '装配',
    storageKey: 'pocketcc.ft-asm.config',
    defaults: { friends: [] },
    toModuleCfg: (c) => c,
    fields: [{ key: 'friends', type: 'uidlist' }],
  });
  configs['ft-asm'] = { friends: [] };
  const ctx = assembleCtx({ dataset: { id: 'ft-asm', fkey: 'friends' } });
  assert.equal(ctx.f.id, 'ft-asm');
  assert.equal(ctx.fd.key, 'friends');
  assert.equal(ctx.fid, 'ft-asm');
  assert.equal(typeof ctx.commit, 'function');
});

test('assembleCtx：标量 UID 行 data-ukey 兜底（无 data-fkey）', () => {
  reactor.register({
    id: 'ft-asm-uid',
    label: 'UID装配',
    storageKey: 'pocketcc.ft-asm-uid.config',
    defaults: { u: '' },
    toModuleCfg: (c) => c,
    fields: [{ key: 'u', type: 'uid', nameKey: 'nm', enableKey: 'en' }],
  });
  configs['ft-asm-uid'] = { u: '' };
  const ctx = assembleCtx({ dataset: { id: 'ft-asm-uid', ukey: 'u' } });
  assert.equal(ctx.fd.key, 'u');
});

test('assembleCtx：功能未注册 → null（调用方跳过该容器）', () => {
  assert.equal(assembleCtx({ dataset: { id: 'nonexistent', fkey: 'k' } }), null);
});

test('baseCtx：透传 f/fd/c/fid/box/el + commit 为函数（管道收口 save+apply+log）', () => {
  const f = { id: 'ft-base' };
  const fd = { key: 'k' };
  const c = { k: 1 };
  const box = { dataset: {} };
  const el = {};
  const ctx = baseCtx(f, fd, c, box, el);
  assert.equal(ctx.f, f);
  assert.equal(ctx.fd, fd);
  assert.equal(ctx.c, c);
  assert.equal(ctx.fid, 'ft-base');
  assert.equal(ctx.box, box);
  assert.equal(ctx.el, el);
  assert.equal(typeof ctx.commit, 'function');
});

// assemble/sync 编排（index.js runAssembleHook：按 assembleSel 逐容器调钩子，makeCtx 解析失败跳过）
// 用自定义 spy module 隔离验证编排逻辑，不执行真实 mount*（DOM 重，渲染等价由快照证明）。
test('assembleTypeModules：按 assembleSel 逐容器调 assemble，makeCtx 解析失败跳过', () => {
  const seen = [];
  registerType({
    type: 't-asm',
    kind: 'box',
    cls: 'pc-tasm',
    render: () => '',
    assembleSel: '.pc-tasm',
    assemble: (box, ctx) => seen.push([box.dataset.id, ctx.fd.key]),
  });
  const root = {
    querySelectorAll: (sel) =>
      sel === '.pc-tasm' ? [{ dataset: { id: 'a' } }, { dataset: { id: 'b' } }] : [],
  };
  const makeCtx = (box) => (box.dataset.id === 'a' ? { fd: { key: 'ka' } } : null); // b 解析失败 → 跳过
  assembleTypeModules(root, makeCtx);
  assert.deepEqual(seen, [['a', 'ka']]);
});

test('syncTypeModules：按 assembleSel 逐容器调 sync（与 assemble 分离）', () => {
  const seen = [];
  registerType({
    type: 't-sync',
    kind: 'box',
    cls: 'pc-tsync',
    render: () => '',
    assembleSel: '.pc-tsync',
    assemble: () => {
      throw new Error('sync 不应调 assemble');
    },
    sync: (box) => seen.push(box.dataset.id),
  });
  const root = {
    querySelectorAll: (sel) => (sel === '.pc-tsync' ? [{ dataset: { id: 'x' } }] : []),
  };
  syncTypeModules(root, () => ({}));
  assert.deepEqual(seen, ['x']);
});

test('syncTypeModules：只声明 assemble 无 sync 的 module 被跳过', () => {
  let asm = 0;
  registerType({
    type: 't-asmonly',
    kind: 'box',
    cls: 'pc-tasmonly',
    render: () => '',
    assembleSel: '.pc-tasmonly',
    assemble: () => asm++,
  });
  const root = {
    querySelectorAll: (sel) => (sel === '.pc-tasmonly' ? [{ dataset: { id: 'z' } }] : []),
  };
  syncTypeModules(root, () => ({}));
  assert.equal(asm, 0); // 无 sync 钩子 → 不调 assemble
});
