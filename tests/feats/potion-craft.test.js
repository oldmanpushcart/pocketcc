// potion-craft（机械制药）纯函数单测：1387 应答解析 / 单选目标的可制作判定（职业·科技·材料）/ 择时。
// 全部断言的是「计划决策」，不发包、不摸游戏符号——feat 模块 import 链会触到浏览器全局，
// 故先最小桩化 window/document/chrome，再动态 import 取导出纯函数（同 auto-farm-mech-build 口径）。
import { test } from 'node:test';
import assert from 'node:assert/strict';

// ── 浏览器全局最小桩（模块加载期需要，函数体不触碰）─────────────────────
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

// core 链里的 session/player/scene-watcher 等模块在 import 期就挂常驻 setInterval（浏览器里常驻、
// Node 里会把测试进程拖到永不退出）——只对测试 harness 的定时器 unref，不参与被测逻辑。
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (fn, ms, ...rest) => {
  const h = realSetInterval(fn, ms, ...rest);
  if (h && typeof h.unref === 'function') h.unref();
  return h;
};

const mod = await import('../../extension/src/feats/player/potion-craft.js');
const {
  readQueue,
  isExpired,
  nextDelayMs,
  checkTarget,
  joinFormulaLabel,
  buildFormulaOptions,
  INTERNAL,
} = mod;
const { idlePollMs, dueBufferMs, minWakeMs } = INTERNAL.timing;

// ── 数据桩：traps_and_potions 行 + 资源/道具读数 ──────────────────────
/** @param {object} over 覆盖列 @returns {object} 一行配方（默认资源 1|10、道具 100|1） */
const row = (over) => Object.assign({ id: 1, resources: '1|10', needItem: '100|1' }, over || {});

/**
 * checkTarget 夹具：把三份数据源做成闭包（缺什么补什么默认值）。
 * @param {{rows?:object, res?:Function, items?:Function}} o rows:{id:行|null}、res:(id)=>n|null、items:{id:n}
 */
function fixture(o) {
  const rows = o && o.rows;
  const res = o && o.res;
  const items = (o && o.items) || {};
  return [
    (id) => (rows ? (rows[id] ?? null) : row({ id })),
    res || (() => 999999),
    (itemId) => (itemId in items ? items[itemId] : 999999),
  ];
}

// ── joinFormulaLabel：选项标签去重（字典实证配方名与产物名同源，旧拼法把同名写两遍）──

test('joinFormulaLabel：同名（含互为子串）只留一个名，不再「A · A」', () => {
  // trapName_90001 与 item_name1600041 译出来都是「等级1腐蚀粘液」
  assert.equal(joinFormulaLabel('等级1腐蚀粘液', '等级1腐蚀粘液'), '等级1腐蚀粘液');
  assert.equal(joinFormulaLabel('等级1腐蚀粘液', '腐蚀粘液'), '等级1腐蚀粘液');
  assert.equal(joinFormulaLabel('等级1腐蚀粘液', ''), '等级1腐蚀粘液'); // 产物行取不到：不尾追分隔符
});

test('joinFormulaLabel：产物名带出额外信息才尾追；配方名缺失时退回产物名', () => {
  assert.equal(joinFormulaLabel('电磁飞弹', '电磁飞弹图纸 ×2'), '电磁飞弹 · 电磁飞弹图纸 ×2');
  assert.equal(joinFormulaLabel('', '等级1强化机油'), '等级1强化机油');
  assert.equal(joinFormulaLabel(null, undefined), '');
});

test('joinFormulaLabel：产物名只多一个数量段时仍算重名（否则回到 A · B 噪声）', () => {
  assert.equal(joinFormulaLabel('等级1腐蚀粘液', '腐蚀粘液 ×2'), '等级1腐蚀粘液');
  assert.equal(joinFormulaLabel('等级1腐蚀粘液', '等级1腐蚀粘液 ×10'), '等级1腐蚀粘液');
});

// ── buildFormulaOptions：下拉组装（只列真清单 / 两种空态分开写 / 存档项不丢）──
const lab = (id) => 'P' + id;

test('buildFormulaOptions：有清单时逐条列出，不插提示项', () => {
  const opts = buildFormulaOptions([10003, 90001], 0, false, lab, () => '');
  assert.deepEqual(
    opts.map((o) => o.value),
    [0, 10003, 90001],
  );
  assert.equal(opts[1].label, 'P10003');
});

test('buildFormulaOptions：没读到清单与「服务器确认无配方」是两种写法（不把无从判定当否定结论）', () => {
  const unknown = buildFormulaOptions([], 0, false, lab, () => '');
  assert.equal(unknown.length, 2);
  assert.match(unknown[1].label, /读取可生产清单/);
  const none = buildFormulaOptions([], 0, true, lab, () => '');
  assert.match(none[1].label, /无可生产配方/);
});

test('buildFormulaOptions：存档目标不在清单里→尾追且标「未解锁」；无清单时不假标', () => {
  const marked = buildFormulaOptions([10003], 90001, false, lab, () => '');
  assert.deepEqual(
    marked.map((o) => o.label),
    ['未选择（只领已完成的，不排产）', 'P10003', 'P90001（未解锁）'],
  );
  const blind = buildFormulaOptions([], 90001, false, lab, () => '');
  assert.equal(blind[2].label, 'P90001'); // 无清单=无从判定，不打「未解锁」
});

test('buildFormulaOptions：markOf 只给清单内项打标（缺料），且不 mutate 入参清单', () => {
  const ul = [10003, 90001];
  const opts = buildFormulaOptions(ul, 0, false, lab, (id) => (id === 10003 ? '（缺料）' : ''));
  assert.equal(opts[1].label, 'P10003（缺料）');
  assert.equal(opts[2].label, 'P90001');
  assert.deepEqual(ul, [10003, 90001]);
});

// ── readQueue：1387 应答 → 队列态 ────────────────────────────────
test('readQueue：空闲态（making 四字段全 0，报文实证形态）判 idle，不判在产', () => {
  const q = readQueue({
    making: { st: 0, id: 0, state: 0, et: 0 },
    unlock: [10003, 90001, 11001],
  });
  assert.equal(q.ok, true);
  assert.equal(q.idle, true);
  assert.equal(q.producing, false);
  assert.equal(q.claimable, false);
  assert.deepEqual(q.unlock, [10003, 90001, 11001]);
});

test('readQueue：making 缺失 / 非 object / 载荷为空 → ok=false（无从判定，调用方不得当空闲）', () => {
  for (const payload of [null, undefined, 'x', {}, { unlock: [1] }, { making: 'x' }]) {
    const q = readQueue(payload);
    assert.equal(q.ok, false, 'payload=' + JSON.stringify(payload));
  }
});

test('readQueue：在产态 {id,et} 齐全 → producing；state=1 → 领取优先（claimable 与 producing 并存）', () => {
  const making = { st: 1794046716, id: 90001, state: 0, et: 1794219516 };
  const q = readQueue({ making, unlock: [90001] });
  assert.equal(q.ok, true);
  assert.equal(q.producing, true);
  assert.equal(q.idle, false);
  assert.equal(q.claimable, false);
  assert.equal(q.et - q.st, 172800); // 实测 48h 队列
  const done = readQueue({ making: { ...making, state: 1 } });
  assert.equal(done.claimable, true);
  assert.equal(done.producing, true); // state=1 时队列位仍占着，领完才腾
});

test('readQueue：1398 式空 making({}) 也判 ok（对象在场、字段缺省为 0）；unlock 剔非正数并按首现去重', () => {
  const q = readQueue({ making: {}, unlock: ['90001', 90001, 0, -5, 'x', 11001] });
  assert.equal(q.ok, true);
  assert.equal(q.idle, true);
  assert.deepEqual(q.unlock, [90001, 11001]);
});

test('isExpired：et<=now 才算到期；et 不可信（0/缺失）与 now 缺失一律判未到期', () => {
  assert.equal(isExpired({ et: 1000 }, 1000), true);
  assert.equal(isExpired({ et: 1000 }, 999), false);
  assert.equal(isExpired({ et: 0 }, 1000), false);
  assert.equal(isExpired({ et: 1000 }, 0), false);
});

// ── checkTarget：单选目标 + 职业/科技/材料三限判定 ────────────────────
test('checkTarget：目标已解锁且材料齐 → ok=true，id 即用户单选的那一个', () => {
  const [getRow, getRes, getItem] = fixture({});
  const r = checkTarget([1, 2, 3], 3, getRow, getRes, getItem);
  assert.equal(r.ok, true);
  assert.equal(r.id, 3);
  assert.equal(r.gap, null);
});

test('checkTarget：用户未选择（0/缺失/负数）→ 不排产，gap.reason=unselected', () => {
  const [getRow, getRes, getItem] = fixture({});
  for (const sel of [0, undefined, null, -5, '']) {
    const r = checkTarget([1, 2], sel, getRow, getRes, getItem);
    assert.equal(r.ok, false, 'sel=' + sel);
    assert.equal(r.gap.reason, 'unselected');
  }
});

test('checkTarget：unlock 为空（非机械大师 / 未点制药天赋）→ 整轮无目标，gap.reason=profession', () => {
  const [getRow, getRes, getItem] = fixture({});
  const r = checkTarget([], 1, getRow, getRes, getItem);
  assert.equal(r.id, 0);
  assert.equal(r.gap.reason, 'profession');
});

test('checkTarget：目标不在 unlock 里 → 科技限制拦下（gap.reason=locked，带反查到的职业名）', () => {
  const [getRow, getRes, getItem] = fixture({});
  const r = checkTarget([1, 2], 99, getRow, getRes, getItem, (id) => '机械大师#' + id);
  assert.equal(r.ok, false);
  assert.equal(r.gap.reason, 'locked');
  assert.equal(r.gap.id, 99);
  assert.equal(r.gap.career, '机械大师#99');
});

test('checkTarget：一次只做一个——选中目标缺料时原地等，绝不改做另一个做得动的配方', () => {
  const [getRow, getRes, getItem] = fixture({
    rows: { 1: row({ id: 1, resources: '7|100' }), 2: row({ id: 2, resources: '7|5' }) },
    res: (id) => (id === 7 ? 50 : 0), // 50：1 号（需要 100）不够，2 号（需要 5）够
  });
  const r = checkTarget([1, 2], 1, getRow, getRes, getItem);
  assert.equal(r.ok, false);
  assert.equal(r.id, 0);
  assert.deepEqual(r.gap, { id: 1, reason: 'resource', resId: 7, need: 100, have: 50 });
});

test('checkTarget：needItem 多段缺任一项即不可作（材料限制）', () => {
  const [getRow, , getItem] = fixture({
    rows: { 1: row({ id: 1, needItem: '100|2,101|3' }) },
    items: { 101: 2 }, // 101 差 1 个
  });
  const r = checkTarget([1], 1, getRow, () => 999, getItem);
  assert.equal(r.ok, false);
  assert.deepEqual(r.gap, { id: 1, reason: 'item', itemId: 101, need: 3, have: 2 });
});

test('checkTarget：resourceAmount 回 null（无从判定）按放行，最终以服务器拒绝为裁决', () => {
  const [getRow, , getItem] = fixture({ rows: { 1: row({ id: 1, resources: '7|100000' }) } });
  assert.equal(checkTarget([1], 1, getRow, () => null, getItem).ok, true);
});

test('checkTarget：needItem 空串/形态不符段只跳过不判死（镜像面板起跑闸，红点闸会把这些行永久躺平）', () => {
  const [getRow, getRes, getItem] = fixture({
    rows: {
      1: row({ id: 1, needItem: '' }),
      2: row({ id: 2, needItem: 'garbage,100|1' }),
      3: row({ id: 3, resources: '' }),
    },
  });
  assert.equal(checkTarget([1, 2, 3], 1, getRow, getRes, getItem).ok, true);
  assert.equal(checkTarget([1, 2, 3], 2, getRow, getRes, getItem).ok, true);
  assert.equal(checkTarget([1, 2, 3], 3, getRow, getRes, getItem).ok, true); // resources 形态不符 → 不拦
});

test('checkTarget：表行读不到（配置表未就绪）不排产，也不误报缺料', () => {
  const [, getRes, getItem] = fixture({});
  const r = checkTarget([1], 1, () => null, getRes, getItem);
  assert.equal(r.ok, false);
  assert.equal(r.id, 0);
  assert.equal(r.gap.reason, 'row');
  assert.equal(r.gap.id, 1);
});

// ── nextDelayMs：择时 ────────────────────────────────────────────────
test('nextDelayMs：在产且 et 未到 → 睡到 et + 到期缓冲', () => {
  const q = readQueue({ making: { st: 1000, id: 90001, state: 0, et: 2000 } });
  assert.equal(nextDelayMs(q, 1500), 500 * 1000 + dueBufferMs);
});

test('nextDelayMs：state===1 → 0（领完立刻再跑一轮去排产，不等兜底）', () => {
  const q = readQueue({ making: { st: 1000, id: 90001, state: 1, et: 2000 } });
  assert.equal(nextDelayMs(q, 1500), 0);
});

test('nextDelayMs：应答畸形 → 兜底间隔；空闲 → 兜底间隔；到期未领走 → 最小唤醒', () => {
  assert.equal(nextDelayMs(readQueue(null), 1500), idlePollMs);
  assert.equal(
    nextDelayMs(readQueue({ making: { st: 0, id: 0, state: 0, et: 0 } }), 1500),
    idlePollMs,
  );
  const expired = readQueue({ making: { st: 1000, id: 90001, state: 0, et: 1000 } });
  assert.equal(nextDelayMs(expired, 2000), minWakeMs);
});

test('nextDelayMs：服务器时刻不可信（now=0）时不拿 0 去算睡眠，退兜底间隔', () => {
  const q = readQueue({ making: { st: 1000, id: 90001, state: 0, et: 9e12 } });
  assert.equal(nextDelayMs(q, 0), idlePollMs);
});

test('INTERNAL：制药 lane ProductType 恒 1（源码 ProductData.UpdateData 对 isPotion 硬置），不取 getProductingData 合并视图', () => {
  assert.equal(INTERNAL.cmd.productType, 1);
  assert.equal(INTERNAL.cmd.info, 1387);
  assert.equal(INTERNAL.cmd.make, 1388);
  assert.equal(INTERNAL.cmd.claim, 1397);
  assert.equal(INTERNAL.cmd.push, 10722);
});
