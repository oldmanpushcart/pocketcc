// 卡车争夺（truck-intercept）刷新时刻表纯函数单测：cap→24 格分配（最大余数法）+ 下一格点择点 + 择时下拍出口。
// 断言的是「计划决策与运行时节拍」，不含发包形态与战果统计（后者由日志节拍对拍覆盖）。
// 回归红线一：同一格点至多消费一次。历史事故——格点数学走 serverNowMs()（秒级、与本地 setTimeout 两套口径）而休眠走本地时钟，
// 唤醒常落在格点前零点几秒；旧择点只取「不早于 now」的点，于是本轮结束后 ceil 重新命中同一格点、delay 落到亚秒级被抬到
// reloadGap 地板（地板值恰等于 doScan 的节流闸门，补刷刚好越过闸门照计 refreshUsed）→ 一个格点吃两次配额，
// 实测每格 1.34~1.71 次，cap=5000 在一个游戏日 14:15 就烧光。修法：择点带 minLeadMs 领先量，且不再有任何地板。
// 回归红线二：grid-hop 分段醒不消耗配额（否则 step > hopCap 的稀疏格每格点 2 次，默认 cap=300 即踩）。仿真走 simDay。
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

// core 链里的 session/net-guard 等模块在 import 期就挂常驻 setInterval——只对测试 harness 的定时器
// unref（否则 node --test 进程永不退出），不参与被测逻辑。
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (fn, ms, ...rest) => {
  const h = realSetInterval(fn, ms, ...rest);
  if (h && typeof h.unref === 'function') h.unref();
  return h;
};

const mod = await import('../../extension/src/feats/player/truck-intercept/index.js');
const { allocateSlots, nextGridPointAbs, planRefresh, REFRESH, REFRESH_PRESETS } = mod;

const SLOT = REFRESH.slotMs; // 3600000：一格 = 1 小时
const DAY = 86400000;
// 领先量取 cfg.reloadGap（6474 重随机最小间隔，面板不暴露）的同值；本用例集按文档值 3s 驱动。
const LEAD = 3000;
/** 单格分配便捷构造：除 slot0 外全 0（除注明外） */
function oneSlot(n, slot = 0) {
  const c = new Array(24).fill(0);
  c[slot] = n;
  return c;
}

// ── allocateSlots：Σ=cap 与占比分布 ─────────────────────────────────────
test('allocateSlots：Σ=cap 恒等（最大余数法不吞小占比格），且 cap 直接等于一天的总量', () => {
  const w = REFRESH_PRESETS.normal;
  for (const cap of [1, 60, 300, 999, 5000, 10000]) {
    const c = allocateSlots(w, cap);
    assert.equal(c.length, 24, `cap=${cap} 应出 24 格`);
    assert.equal(
      c.reduce((a, b) => a + b, 0),
      cap,
      `cap=${cap} 分配总和必须等于 cap（格等长 ⇒ 次数占比 ≡ 密度占比）`,
    );
  }
});

test('allocateSlots：正常模板 cap=300 的分布即面板 hint 的口径（热点 39 次/时 ≈1.5 分钟，深夜 4 次/时 =15 分钟）', () => {
  const c = allocateSlots(REFRESH_PRESETS.normal, 300);
  assert.equal(c[0], 39); // 热点格（w=9）→ 3600/39 ≈ 92s
  assert.equal(c[1], 39);
  assert.equal(c[2], 4); // 深夜格（w=1）→ 3600/4 = 900s = 15 分钟
  assert.equal(c[8], 17); // 上午格（w=4）→ ≈3.5 分钟
  assert.equal(c[10], 22); // 正午前后（w=5）→ ≈2.7 分钟
  assert.equal(c[12], 13); // 下午（w=3）→ ≈4.6 分钟
  assert.equal(REFRESH.capDefault, 300, '默认 cap 就是设计工作区间');
});

test('allocateSlots：cap=5000 时热点格被压到 643 次/时（间隔 5.6s，已贴近 reloadGap）——这就是凌晨两小时烧掉 1286 次配额的原因', () => {
  const c = allocateSlots(REFRESH_PRESETS.normal, 5000);
  assert.equal(c[0], 643);
  assert.equal(c[1], 643);
  assert.equal(c[2], 72); // 深夜格：计划 72 次/时
  assert.equal(c[0] + c[1], 1286, '热点两格 = 18/70 的预算，占总 cap 的 25.7%');
});

test('allocateSlots：cap<=0 / 占比全 0 / 非法权重一律全 0（当天不排刷新，而不是兜底密刷）', () => {
  const w = REFRESH_PRESETS.normal;
  assert.deepEqual(allocateSlots(w, 0), new Array(24).fill(0));
  assert.deepEqual(allocateSlots(w, -5), new Array(24).fill(0));
  assert.deepEqual(allocateSlots(new Array(24).fill(0), 300), new Array(24).fill(0));
  // 负数与非数按 0 处理，绝不出现负次数
  const dirty = allocateSlots([-9, 'x', null, undefined, 3, ...new Array(19).fill(0)], 100);
  assert.ok(dirty.every((n) => Number.isInteger(n) && n >= 0));
  assert.equal(
    dirty.reduce((a, b) => a + b, 0),
    100,
  );
});

// ── nextGridPointAbs：择点契约 ──────────────────────────────────────────
test('nextGridPointAbs：落点恒领先 now 至少 minLeadMs（回归红线——同一格点不可能被命中两次）', () => {
  const c = oneSlot(60); // 格内间隔 60s
  for (let now = -5000; now < DAY + 5000; now += 137) {
    const pt = nextGridPointAbs(now, c, 0, LEAD);
    if (pt == null) continue;
    assert.ok(pt - now >= LEAD - 1, `now=${now} 落点 ${pt} 领先不足：${pt - now}ms`);
  }
});

test('nextGridPointAbs：早醒（唤醒落在格点前 0.8s、本轮往返 0.3s）时新口径顺延下一格点；旧口径（lead=0）会重命中同一格点', () => {
  const c = oneSlot(60);
  // 事故现场还原：在 59.5s（格点 60s 之前 0.5s）排下拍——lead=0 仍指向 60000，即刚打过的那一点
  assert.equal(
    nextGridPointAbs(59500, c, 0, 0),
    60000,
    'lead=0 = 旧口径：同一格点被二次命中（随后被抬到 3s 地板补刷）',
  );
  // 修复后：要求领先 3s ⇒ 直接取下一格点，一次往返都不多
  assert.equal(nextGridPointAbs(59500, c, 0, LEAD), 120000);
});

test('nextGridPointAbs：极端密格（格内间隔 < reloadGap）改为跳点欠耗，而不是贴地板连刷', () => {
  const c = oneSlot(1200); // 3600/1200 = 3s ≤ reloadGap
  assert.equal(nextGridPointAbs(0, c, 0, LEAD), 3000);
  assert.equal(nextGridPointAbs(1000, c, 0, LEAD), 6000); // 跳掉 3000 那点：probe=4000 → k=2
  assert.equal(nextGridPointAbs(5800, c, 0, LEAD), 9000);
});

test('nextGridPointAbs：0 占比格整小时跳过；本格点位走完顺延到后面第一个有配额的格', () => {
  const c = oneSlot(10, 2); // 只有 02:00–03:00 有配额（间隔 360s）
  assert.equal(nextGridPointAbs(0, c, 0, LEAD), 2 * SLOT, '落在 0 占比格内：顺延到有配额格的首点');
  assert.equal(
    nextGridPointAbs(2 * SLOT + 10 * 360000 - 1, c, 0, LEAD),
    null,
    '本格走完且后面无配额格：null',
  );
  const c2 = [1, 1, ...new Array(22).fill(0)]; // slot0 一点（在 0），slot1 一点（在 1h）
  assert.equal(nextGridPointAbs(1000, c2, 0, LEAD), SLOT, '本格走完 ⇒ 顺延下一格首点');
});

test('nextGridPointAbs：占比全 0 / cap 归零时返回 null（调用方据此睡到日界，不空转）', () => {
  assert.equal(nextGridPointAbs(0, new Array(24).fill(0), 0, LEAD), null);
});

test('nextGridPointAbs：非零 dayStart（服务器 0 点锚定口径）下格点仍按 dayStart+i×1h 铺开', () => {
  const dayStart = 1730822400000; // 任意绝对时刻当游戏日 0 点
  const c = oneSlot(60);
  const pt = nextGridPointAbs(dayStart + 900000, c, dayStart, LEAD);
  assert.ok(pt > dayStart + 900000 + LEAD - 1);
  assert.ok(pt <= dayStart + SLOT, '落点必须仍在本格内');
  assert.equal((pt - dayStart) % (SLOT / 60), 0, '落点是格内整数倍间隔');
});

// ── planRefresh：出口契约（地板不得复活 + 分段醒不消耗配额）─────────────────
/** 运行时状态快照构造：默认只给 cap/刷新点，其余闸门按需覆盖 */
function st(over = {}) {
  return {
    refreshUsed: 0,
    cap: 100000,
    maxDaily: 0, // 0 ⇒ 跳过「成功配额耗尽」闸门（本轮只测时刻表分支）
    dailyLeft: 0,
    refreshMs: DAY, // 游戏日 0 点锚在 0，刷新点即次日 0 点
    activeRefresh: 120000,
    idleRefresh: 600000,
    flipBuffer: 20000,
    ...over,
  };
}

test('planRefresh：grid/grid-hop 出口的 delay 恒 >= 领先量（有人把 reloadGap 地板加回来不会静默过关）', () => {
  const c = allocateSlots(REFRESH_PRESETS.normal, 300);
  let hops = 0;
  for (let now = 0; now < DAY; now += 997) {
    const p = planRefresh(now, c, 0, st({ cap: 100000 }), LEAD);
    if (p.reason === 'grid' || p.reason === 'grid-hop') {
      assert.ok(p.delay >= LEAD, `now=${now} delay=${p.delay} < lead=${LEAD}`);
      assert.ok(p.point > now, 'point 必须是未来格点');
      if (p.reason === 'grid-hop') {
        assert.equal(p.delay, REFRESH.hopCap, 'grid-hop 夹到 hopCap');
        hops++;
      } else {
        assert.equal(p.point - now, p.delay, 'grid 出口 delay 就是到格点的距离');
      }
    } else {
      assert.equal(p.point, 0, '非格点出口不得留旧 point（否则 kick 会被误判成分段醒）');
    }
  }
  assert.ok(hops > 0, 'cap=300 的深夜格 step=900s > hopCap，必须走到 grid-hop 分支才测得到');
});

test('planRefresh：三个睡到日界的出口（budget / quota / day-done）各自取值正确', () => {
  const c = allocateSlots(REFRESH_PRESETS.normal, 300);
  const used = planRefresh(SLOT, c, 0, st({ cap: 100, refreshUsed: 100 }), LEAD);
  assert.equal(used.reason, 'budget');
  assert.equal(used.delay, DAY - SLOT, '触顶即睡到下一刷新点');
  assert.equal(used.point, 0);
  const quota = planRefresh(SLOT, c, 0, st({ maxDaily: 4, dailyLeft: 0, refreshMs: DAY }), LEAD);
  assert.equal(quota.reason, 'quota');
  assert.equal(quota.delay, DAY - SLOT + 20000, '配额耗尽：刷新点 + flipBuffer');
  const zero = planRefresh(SLOT, new Array(24).fill(0), 0, st(), LEAD);
  assert.equal(zero.reason, 'day-done');
  assert.ok(zero.delay > 0 && zero.point === 0, '今日无点位：睡到日界且不记格点');
  const none = planRefresh(SLOT, c, 0, st({ refreshMs: 0 }), LEAD);
  assert.equal(none.reason, 'no-refresh-point');
  assert.equal(none.delay, 120000, '未同步刷新点：退化 activeRefresh');
});

test('planRefresh：leadMs 漏传即取 cfg.reloadGap 口径，不会退化为旧择点（delay=0 会被 cycle 当成立即再跑而空转）', () => {
  const c = oneSlot(60);
  const withLead = planRefresh(59500, c, 0, st(), LEAD);
  const implicit = planRefresh(59500, c, 0, st(), undefined);
  assert.equal(implicit.point, withLead.point, '缺省领先量必须与显式传 cfg.reloadGap 同果');
  assert.ok(implicit.point > 59500 + cfgReloadGap() - 1, '不得重命中刚打过的那一点');
});

/** cfg 不导出：reloadGap 取文档值 3s（与上方 LEAD 同源） */
function cfgReloadGap() {
  return LEAD;
}

test('planRefresh：真实 epoch 日帧下 point 必须是完整绝对时刻（|0 截 Int32 会把分段醒判据搞反→每拍都出列表）', () => {
  const dayStart = 1730822400000; // 远超 Int32 上限的真实 epoch ms
  const c = allocateSlots(REFRESH_PRESETS.normal, 300);
  const now = dayStart + 2 * SLOT + 1000; // 深夜格（step=900s > hopCap）刚过完一个点位
  const p = planRefresh(now, c, dayStart, st(), LEAD);
  assert.equal(p.reason, 'grid-hop');
  assert.equal(p.delay, REFRESH.hopCap);
  assert.equal(
    p.point,
    dayStart + 2 * SLOT + REFRESH.slotMs / 4,
    `point 不得被截断/回绕（实际 ${p.point}）`,
  );
});

// ── 整天节拍仿真（运行时口径）：实测次数不得超计划 ────────────────────
/**
 * 与 cycleRun 同构的仿真：唤醒 → 若非分段醒则一次列表往返（refreshUsed++）→ 耗时 rt 后 planRefresh 排下拍。
 *   grid-hop 分段醒只重查表、不计数——即 doScan(resyncOnly) 的口径；少了这一步，旧行为会在 step > hopCap
 *   的稀疏格上每格点刷 2 次（实测默认 cap=300 时 slot2–7 各 2×、 20 点后预算被提前吃光）。
 * @param {number[]} plan allocateSlots 产物
 * @param {number} cap 预算上限（传 >计划总数即可只看形状不看触顶）
 * @param {{rt?:number, lead?:number}} [opt] rt=一轮往返耗时（实测 ~0.3s），lead=格点领先量
 * @returns {{fired:number[], total:number}}
 */
function simDay(plan, cap, { rt = 300, lead = LEAD } = {}) {
  const fired = new Array(24).fill(0);
  const s = st({ cap });
  let now = 0;
  let hopWake = false; // 首轮由 run() 的 kick 驱动，必出列表
  for (let guard = 0; guard <= cap * 4 + 64; guard++) {
    if (!hopWake) {
      fired[Math.min(23, Math.floor(now / SLOT))]++;
      s.refreshUsed++;
    }
    if (s.refreshUsed >= cap) break; // budget 出口：睡到日界
    const t = now + rt; // 本轮往返结束后才排下拍
    const p = planRefresh(t, plan, 0, s, lead);
    if (p.reason !== 'grid' && p.reason !== 'grid-hop') break; // 其余出口都是睡到日界/退化档
    now = t + p.delay;
    hopWake = p.reason === 'grid-hop';
  }
  return { fired, total: s.refreshUsed };
}

test('仿真红线（运行时节拍）：每格往返次数恒 ≤ 计划次数，低 cap / 高 cap 都不例外', () => {
  for (const cap of [60, 300, 600, 5000, 10000]) {
    const plan = allocateSlots(REFRESH_PRESETS.normal, cap);
    const { fired, total } = simDay(plan, cap);
    for (let i = 0; i < 24; i++) {
      assert.ok(
        fired[i] <= plan[i],
        `cap=${cap} slot=${i} 实际 ${fired[i]} 次 > 计划 ${plan[i]} 次（超支）`,
      );
    }
    assert.ok(total <= cap, `cap=${cap} 一天总量 ${total} 不得超过 cap`);
  }
});

test('仿真形状：预算不卡时，每个计划点位恰好一次往返（step > hopCap 的稀疏格不再 2×，尾部格也不被提前饿死）', () => {
  for (const cap of [60, 300, 600, 5000]) {
    const plan = allocateSlots(REFRESH_PRESETS.normal, cap);
    const { fired, total } = simDay(plan, cap * 2); // 预算给到 2×，专看形状
    assert.deepEqual(fired, plan, `cap=${cap} 实际铺排与计划时刻表不一致：${fired.join(',')}`);
    assert.equal(total, cap, `cap=${cap} 计划点位总数应恰为 Σ=cap`);
  }
});

test('仿真：cap 超过调度上限（格内间隔 < reloadGap）只会跳点欠耗，绝不超支——cap 再大也不会失控', () => {
  const cap = 10000; // slot0/1 间隔 2.8s < reloadGap 3s
  const plan = allocateSlots(REFRESH_PRESETS.normal, cap);
  const { fired, total } = simDay(plan, cap);
  assert.ok(total < cap, `极端密格应欠耗（实际 ${total} < 计划 ${cap}）`);
  assert.ok(fired[0] < plan[0], `热点格应发生跳点（实际 ${fired[0]} < 计划 ${plan[0]}）`);
  assert.ok(
    fired.every((n, i) => n <= plan[i]),
    '跳点只能是欠耗，不得超支',
  );
});
