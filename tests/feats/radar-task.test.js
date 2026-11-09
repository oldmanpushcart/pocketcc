// radarTask（雷达任务）纯函数单测：配置归一 + 账本摊平 + taskId→type 反查降级 + type×state 分派 + 候选排序/闸门决策 + 体力闸与回体择时 + 干扰攻击击退闸。
// 断言的是「计划决策」，不含择时曲线与发包形态（后者由 replay 对拍覆盖）。
// feat 模块 import 链会触到浏览器全局（reactor/storage/bus），故先最小桩化 window/document/chrome，再动态 import 取导出纯函数。
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

const mod = await import('../../extension/src/feats/player/radar-task.js');
const {
  normalize,
  applyEventTo,
  isTaskEvent,
  resolveType,
  actionFor,
  candCmp,
  pickCandidate,
  stallStep,
  staminaGate,
  energyWakeMs,
  defenseGate,
  normalizeDeBeginTime,
  TYPE_ACTIONS,
  TASK_TYPES,
  UNSUPPORTED_TYPES,
  ST_FINISH,
  CMD_DEFEND,
  SIGN_MAX,
  cfg,
  RALLY_WAIT_TIME,
} = mod;

test('normalize：四开关缺省视为 true（旧存档缺键不误关），preset 取整钳 [0,8]、非法值归 0=不派兵；minStamina 取整钳非负并钳上界', () => {
  const d = normalize({});
  assert.equal(d.doDaily, true);
  assert.equal(d.doEvents, true);
  assert.equal(d.doMarch, true);
  assert.equal(d.doDefend, true);
  assert.equal(d.preset, 0);

  assert.deepEqual(normalize({ doDaily: false, doEvents: false, doMarch: false, preset: '5' }), {
    doDaily: false,
    doEvents: false,
    doMarch: false,
    doDefend: true,
    preset: 5,
    minStamina: 0,
  });
  // 雷达防御开关与其余三者同构：只有显式 false 才关（缺键/null/0 等一律视为开，旧存档不会误关）
  assert.equal(normalize({ doDefend: false }).doDefend, false);
  assert.equal(normalize({ doDefend: true }).doDefend, true);
  assert.equal(normalize({ doDefend: null }).doDefend, true);
  // 越界/非数一律 0（防把非法值当预设号发给 Battle）
  assert.equal(normalize({ preset: 9 }).preset, 0);
  assert.equal(normalize({ preset: 0 }).preset, 0);
  assert.equal(normalize({ preset: 'abc' }).preset, 0);
  assert.equal(normalize({ preset: -3 }).preset, 0);
  assert.equal(normalize({ preset: 3.7 }).preset, 3);
  // 体力下限：非数/负数归 0（由体力闸再抬到至少 1 点），小数取整
  assert.equal(normalize({ minStamina: '12' }).minStamina, 12);
  assert.equal(normalize({ minStamina: -5 }).minStamina, 0);
  assert.equal(normalize({ minStamina: 'abc' }).minStamina, 0);
  assert.equal(normalize({ minStamina: 9.9 }).minStamina, 9);
  // 上界钳：配到「池子永远攒不满」的极端值当配错处理（面板 number 不渲染 fd.max，只能靠归一钳）
  assert.equal(
    normalize({ minStamina: 1e6 }).minStamina,
    normalize({ minStamina: 100 }).minStamina,
  );
  // 钳完的值不得大于实测体力池上限 pointMax=275（否则体力闸永不放行）
  assert.ok(normalize({ minStamina: 1e6 }).minStamina <= 275);
});

test('applyEventTo：只 upsert 报文带来的字段，state 缺省不动；id/taskId 缺一不入账', () => {
  const map = new Map();
  applyEventTo(map, {
    id: 1234567890123,
    taskId: 10004,
    state: 0,
    day_group_id: 19,
    radar_group_type: 3,
  });
  const t = map.get('1234567890123');
  assert.equal(t.taskId, 10004);
  assert.equal(t.state, 0);
  assert.equal(t.dayGroupId, 19);
  assert.equal(t.groupType, 3);
  assert.equal(t.x, 0);

  // 仅推 state：坐标不被清零（增量推送常只带少数字段）
  applyEventTo(map, { id: 1234567890123, taskId: 10004, state: 2, x: 233, y: 108 });
  assert.equal(t.state, 2);
  assert.equal(t.x, 233);
  applyEventTo(map, { id: 1234567890123, taskId: 10004 });
  assert.equal(t.state, 2);
  assert.equal(t.y, 108);

  applyEventTo(map, { taskId: 1 }); // 无 id
  applyEventTo(map, { id: 9 }); // 无 taskId
  applyEventTo(map, null);
  assert.equal(map.size, 1);
});

test('resolveType：查表键 = 事件实例 id（radar_event 按 id 索引，taskId 同号是不同物）', () => {
  // 撞号样本（实证 _log/15596140531952/20261106T03）：实例 id 行的权威 type=202 集结，
  // 而「同号的 taskId 行」type=205 零部队援助——按 taskId 查会把据点任务派成援助，服务器 code=3。
  const rows = {
    880001: { type: 202, quality: 5 }, // 实例行（正确键）
    10001: { type: 205, quality: 1 }, // 错键（taskId）才会命中的槽位行
    880002: { type: '203' }, // quality 缺省 → 0；type 串数兼容
  };
  const tableRow = (table, id) => {
    assert.equal(table, 'radar_event');
    return rows[String(id)] || null;
  };
  // 表命中优先于经验表（TASK_TYPES[10001] 同为 202，用 quality=5 证明取的是实例行而非兜底/错键行）
  assert.deepEqual(resolveType({ id: 880001, taskId: 10001 }, tableRow, true), {
    type: 202,
    quality: 5,
  });
  assert.deepEqual(resolveType({ id: '880002', taskId: 10005 }, tableRow, true), {
    type: 203,
    quality: 0,
  });
  // 查表函数抛错（符号链断）不破，降级为「未知」而不是猜
  assert.deepEqual(
    resolveType(
      { id: 880001, taskId: 10001 },
      () => {
        throw new Error('table not ready');
      },
      true,
    ),
    { type: 0, quality: 0 },
  );
  // fail-closed：表可读但该槽位无行 → type=0，绝不退回 taskId 猜动作（少做一个任务 < 发一个错包）
  assert.deepEqual(resolveType({ id: 999999, taskId: 10001 }, tableRow, true), {
    type: 0,
    quality: 0,
  });
  // 仅「读数面整体不可用」(tableReady=false，游戏 bundle 未就绪) 才按 taskId 走录制经验表兜底
  assert.deepEqual(resolveType({ id: 880001, taskId: 10001 }, null, false), {
    type: 202,
    quality: 0,
  });
  // 兜底轴里表行仍然优先（880001 命中→202）；无行时才按 taskId 取经验表（40001=211）
  assert.equal(resolveType({ id: 880001, taskId: 40001 }, tableRow, false).type, 202);
  assert.equal(resolveType({ id: 777777, taskId: 40001 }, tableRow, false).type, 211);
  assert.deepEqual(resolveType({ id: 880001, taskId: 99999 }, null, false), {
    type: 0,
    quality: 0,
  });
  // 缺省 tableReady 视为就绪（不自动兜底）；条目缺 id 也不查表
  assert.deepEqual(resolveType({ id: 999999, taskId: 10001 }, null), { type: 0, quality: 0 });
  assert.deepEqual(resolveType({ taskId: 10001 }, tableRow, true), { type: 0, quality: 0 });
});

test('actionFor：type×state 分派表与录制实证一致（201/202/203/205 在 state=1，211/208 在 state=3）', () => {
  // state=0 一律先认领，与类型无关
  assert.deepEqual(actionFor({ state: 0, taskId: 10004 }, 201), { act: 'start' });
  assert.deepEqual(actionFor({ state: 0, taskId: 40001 }, 211), { act: 'start' });

  assert.deepEqual(actionFor({ state: 1, taskId: 10004 }, 201), {
    act: 'attack',
    marchType: 62,
    needsTroops: true,
  });
  assert.deepEqual(actionFor({ state: 1, taskId: 10002 }, 202), {
    act: 'rally',
    needsTroops: true,
  });
  assert.deepEqual(actionFor({ state: 1, taskId: 10005 }, 203), { act: 'zero', marchType: 64 });
  assert.deepEqual(actionFor({ state: 1, taskId: 10003 }, 205), { act: 'zero', marchType: 67 });
  assert.deepEqual(actionFor({ state: 3, taskId: 40001 }, 211), { act: 'zero', marchType: 200 });
  assert.deepEqual(actionFor({ state: 3, taskId: 4178 }, 208), { act: 'unsupported' });

  // v1 明确不做、游戏侧确实存在的类型（204 据点零部队/206 剪线/207 密码/209 倒计时）→ unsupported，绝不猜 body
  for (const ty of [204, 206, 207, 209]) {
    assert.deepEqual(actionFor({ state: 1, taskId: 777 }, ty), { act: 'unsupported' });
    assert.equal(
      actionFor({ state: 0, taskId: 777 }, ty).act,
      'start',
      'state=0 先认领，与类型无关',
    );
  }
  assert.deepEqual(
    [...UNSUPPORTED_TYPES].sort((a, b) => a - b),
    [204, 206, 207, 209],
  );

  // 状态不匹配 → 本拍无可做（等推送推进）
  assert.equal(actionFor({ state: 2, taskId: 10004 }, 201), null);
  assert.equal(actionFor({ state: 4, taskId: 10004 }, 201), null);
  assert.equal(actionFor({ state: 1, taskId: 40001 }, 211), null); // 211 要 state=3
  assert.equal(actionFor({ state: 3, taskId: 10004 }, 201), null);
  // 未知 type / 已知但表外 type → null
  assert.equal(actionFor({ state: 1, taskId: 99999 }, 0), null);
  assert.equal(actionFor({ state: 1, taskId: 99999 }, 999), null);
  // 分派表自身的 fromState 契约（防后续改动错位）
  assert.equal(TYPE_ACTIONS[201].fromState, 1);
  assert.equal(TYPE_ACTIONS[211].fromState, 3);
  assert.equal(ST_FINISH, 4);
});

test('candCmp：day_group 降序（三连环优先）→ quality 降序 → id 升序（确定性）', () => {
  const a = { dayGroupId: 0, quality: 5, id: '1' };
  const b = { dayGroupId: 19, quality: 1, id: '2' };
  assert.ok(candCmp(a, b) > 0, 'day_group 任务排在普通任务之前');
  // quality 降序：低质作 a 参时应排到高质之后（>0）
  assert.ok(
    candCmp({ dayGroupId: 0, quality: 3, id: '1' }, { dayGroupId: 0, quality: 5, id: '0' }) > 0,
  );
  // 同组同质按 id 升序，保证决策可重复
  assert.ok(
    candCmp({ dayGroupId: 19, quality: 4, id: '10' }, { dayGroupId: 19, quality: 4, id: '9' }) < 0,
  );
  assert.equal(candCmp(a, a), 0);
  // 三连环链序：day_group_id 大的先做（21→22→20 的解锁链按此序推进）
  const chain = [
    { dayGroupId: 20, quality: 0, id: 'c' },
    { dayGroupId: 21, quality: 0, id: 'a' },
    { dayGroupId: 22, quality: 0, id: 'b' },
  ].sort(candCmp);
  assert.deepEqual(
    chain.map((x) => x.dayGroupId),
    [22, 21, 20],
  );
});

/** 造账本条目（缺字段与 applyEventTo 同默认值） */
function task(o) {
  return {
    id: '0',
    taskId: 0,
    state: 1,
    x: 0,
    y: 0,
    dayGroupId: 0,
    groupType: 1,
    endTime: 0,
    ...o,
  };
}

test('pickCandidate：状态/开关/类型三重筛选 + 闸门归因 + 单飞锁持有者跳过', () => {
  const full = { doDaily: true, doEvents: true, doMarch: true, preset: 3 };
  const resolve = (t) => ({ type: TASK_TYPES[t.taskId] || 0, quality: 0 });
  const all = [
    task({ id: 'fin', taskId: 10004, state: ST_FINISH }), // 已完成：不该再被执行
    task({ id: 'run', taskId: 10004, state: 2 }), // 行军中：非可推进态
    task({ id: 'daily', taskId: 10003, state: 0, dayGroupId: 19, groupType: 3 }),
    task({ id: 'ev', taskId: 10004, state: 1 }),
  ];

  // 三连环（day_group）压过普通任务；state=0 走 start
  let dec = pickCandidate(all, full, resolve, null);
  assert.equal(dec.pick.task.id, 'daily');
  assert.equal(dec.pick.act.act, 'start');
  assert.equal(dec.gated, false);
  assert.equal(dec.unknown, false);

  // 传给 resolve 的是账本条目本体（含实例 id）——查表键契约的调用侧地基；只收到 taskId 会退化成错键查表
  const seenIds = [];
  pickCandidate(
    all,
    full,
    (t) => {
      seenIds.push(t.id);
      return { type: 201, quality: 0 };
    },
    null,
  );
  assert.ok(seenIds.length > 0 && seenIds.every((x) => typeof x === 'string'));
  assert.deepEqual([...new Set(seenIds)].sort(), ['daily', 'ev'].sort());

  // doDaily 关 → 跳过三连环，选普通任务（带兵单打）
  dec = pickCandidate(all, { ...full, doDaily: false }, resolve, null);
  assert.equal(dec.pick.task.id, 'ev');
  assert.equal(dec.pick.type, 201);

  // doEvents 关 → 只剩三连环
  dec = pickCandidate(all, { ...full, doEvents: false }, resolve, null);
  assert.equal(dec.pick.task.id, 'daily');

  // 单飞锁持有者跳过（一次只执行一个任务）
  dec = pickCandidate(all, full, resolve, 'daily');
  assert.equal(dec.pick.task.id, 'ev');

  // doMarch 关：带兵型不做，零部队型仍做（state=0 的 start 不派兵，仍可选）
  dec = pickCandidate(all, { ...full, doMarch: false }, resolve, null);
  assert.equal(dec.pick.task.id, 'daily');

  // 派兵型只剩带兵任务且未配预设 → gated 归因（no-preset），不静默 idle
  const onlyMarch = [task({ id: 'ev', taskId: 10004, state: 1 })];
  dec = pickCandidate(
    onlyMarch,
    { doDaily: true, doEvents: true, doMarch: true, preset: 0 },
    resolve,
    null,
  );
  assert.equal(dec.pick, null);
  assert.equal(dec.gated, true);

  // 未知类型：置 unknown 供调用侧 latch warn，不当 idle 静默
  const unknown = [task({ id: 'u', taskId: 88888, state: 1 })];
  dec = pickCandidate(unknown, full, () => ({ type: 0, quality: 0 }), null);
  assert.equal(dec.pick, null);
  assert.equal(dec.unknown, true);
  assert.equal(dec.gated, false);

  // v1 不支持的 208：既不选中，也回交给 unsupported 清单（调用侧靠它做当日 latch 告警，不静默丢）
  dec = pickCandidate(
    [task({ id: 's', taskId: 4178, state: 3 })],
    full,
    () => ({ type: 208, quality: 0 }),
    null,
  );
  assert.equal(dec.pick, null);
  assert.equal(dec.unknown, false);
  assert.deepEqual(
    dec.unsupported.map((x) => x.id),
    ['s'],
  );

  // 208 与可做任务并存：选中可做的，208 仍进清单（告警不阻塞推进）
  dec = pickCandidate(
    [
      task({ id: 's', taskId: 4178, state: 3 }),
      task({ id: 'daily', taskId: 10003, state: 0, dayGroupId: 19 }),
    ],
    full,
    resolve,
    null,
  );
  assert.equal(dec.pick.task.id, 'daily');
  assert.equal(dec.unsupported.length, 0, '10003 解析为 205（零部队），不入 unsupported');
});

test('pickCandidate：211 求援在 state=3 才可选（state=1 时等游戏推进），零部队不受 preset 闸门', () => {
  const resolve = (t) => ({ type: TASK_TYPES[t.taskId] || 0, quality: 0 });
  const help = [task({ id: 'h', taskId: 40001, state: 1 })];
  assert.equal(
    pickCandidate(help, { doDaily: true, doEvents: true, doMarch: true, preset: 0 }, resolve, null)
      .pick,
    null,
  );
  const picked = pickCandidate(
    [task({ id: 'h', taskId: 40001, state: 3 })],
    { doDaily: true, doEvents: true, doMarch: false, preset: 0 },
    resolve,
    null,
  ).pick;
  assert.equal(picked.task.id, 'h');
  assert.deepEqual(picked.act, { act: 'zero', marchType: 200 });
});

test('staminaGate：体力低于下限即暂停；面板配 0 也强制至少 1 点（耗尽必停不可误关）；镜像读不到走 mirror', () => {
  // 实测最贵一档 8 点：不足则停，恰好足则放行
  assert.deepEqual(staminaGate(7, 8), { ok: false, need: 8, reason: 'below' });
  assert.deepEqual(staminaGate(8, 8), { ok: true, need: 8, reason: 'ok' });
  assert.equal(staminaGate(275, 8).ok, true);

  // 用户口径「体力耗尽则暂停」：即使面板填 0，0 体力也不放行
  assert.deepEqual(staminaGate(0, 0), { ok: false, need: 1, reason: 'below' });
  assert.deepEqual(staminaGate(1, 0), { ok: true, need: 1, reason: 'ok' });
  assert.equal(staminaGate(0, -3).need, 1, '负下限同样被抬到 1');

  // UserData 镜像未就绪（不在基地/世界图、符号未上）：不判成「体力不足」，交由调用侧短档重判
  assert.equal(staminaGate(null, 8).reason, 'mirror');
  assert.equal(staminaGate(NaN, 8).reason, 'mirror');
  assert.equal(staminaGate(undefined, 8).ok, false);
});

test('energyWakeMs：睡到回体点且带缓冲；异常秒数钳上下限；任何入参都不返回 0（不留紧循环）', () => {
  // 录制实测 restoreSec=360（6 分钟回 1 点）：必须超过回点本身、但不无限追平
  const w = energyWakeMs(360);
  assert.ok(w > 360000 && w <= 360000 + 60000, 'wake=' + w);

  // 下限钳：极小值与趋于 0 的正值同一结果（避免刚回体就反复抢拍）
  assert.equal(energyWakeMs(1), energyWakeMs(0.001));
  assert.ok(energyWakeMs(1) >= 1000);

  // 上限钳：异常超大值不会把下拍推到天涯（至少周期内重判）
  assert.equal(energyWakeMs(999999), energyWakeMs(9999999));
  assert.ok(energyWakeMs(999999) <= 1000 * 60 * 60);

  // 不可用（缺字段/0/负/NaN）：回退到 active 档，且始终为正
  for (const bad of [0, -5, NaN, undefined, null, '']) {
    assert.ok(energyWakeMs(bad) > 0, 'input=' + String(bad));
  }
});

test('isTaskEvent：20013/20025 的裸事件形态必须识别（录制实证样本），数组集合与纯标量 blob 不算', () => {
  // 真实样本：dashcam 20261106T002310 里的 20013 状态变化推送（完成待领）
  const bare = {
    num: 0,
    day_group_id: 0,
    helpTimes: 0,
    posIndex: 3,
    helpStatus: 1,
    group_id: 0,
    extData: { p: '' },
    x: 0,
    radar_group_type: 1,
    y: 0,
    taskReviceState: 0,
    id: 1099047,
    endTime: 1793924679,
    state: 4,
    taskId: 4178,
  };
  assert.ok(isTaskEvent(bare), '20013 裸事件必须入账');

  // 20026/20015 是集合载荷（携 events 数组），即使顶层多带 id/taskId 也不得当单条事件（否则会漏整数组）
  assert.ok(!isTaskEvent({ events: [bare], optionType: 1 }), 'events 集合不是单条事件');
  assert.ok(!isTaskEvent({ id: 1, taskId: 2, events: [] }), '顶层带 events 时走数组摊平');

  // 20016 杂项标量 blob：无 id/taskId
  assert.ok(
    !isTaskEvent({
      centerX: 100,
      currFinishNum: 1200,
      taskPoolSurplusNum: 18,
      scaned: 1,
      sign: 0,
    }),
    '标量 blob 不是事件',
  );

  // 缺 id 或缺 taskId 都不能入账（applyEventTo 的同一条守卫）
  assert.ok(!isTaskEvent({ taskId: 4178, state: 4 }));
  assert.ok(!isTaskEvent({ id: 1099047, state: 4 }));
  assert.ok(!isTaskEvent(null));
  assert.ok(!isTaskEvent([bare]), '数组本体不是单条事件');
});

test('pickCandidate：当日拉黑的实例不再被选中，也不被归因成 no-preset', () => {
  const mk = (id, dayGroupId) => ({
    id,
    taskId: 10003,
    state: 1,
    x: 1,
    y: 1,
    dayGroupId,
    groupType: 1,
    endTime: 0,
  });
  const all = [mk('blacked', 5), mk('fresh', 4)];
  const mcfg = { doDaily: true, doEvents: true, doMarch: false, preset: 0 };
  const resolve = (t) => (t.taskId === 10003 ? { type: 205, quality: 0 } : { type: 0, quality: 0 });

  // 不传黑名单：day_group_id 降序应选中 'blacked'（复现当时它恒排最前卡住全局的形态）
  assert.equal(pickCandidate(all, mcfg, resolve, null).pick.id, 'blacked');

  // 传拉黑集合：改选下一条，且计数可归因； gated 不被误置（否则日志会说 no-preset）
  const dec = pickCandidate(all, mcfg, resolve, null, new Set(['blacked']));
  assert.equal(dec.pick.id, 'fresh');
  assert.equal(dec.blacklisted, 1);
  assert.equal(dec.gated, false);

  // 全部拉黑 → 无候选（不能回退到被拉黑那条）
  const none = pickCandidate(all, mcfg, resolve, null, new Set(['blacked', 'fresh']));
  assert.equal(none.pick, null);
  assert.equal(none.blacklisted, 2);
});

test('normalizeDeBeginTime：秒级 epoch 不走 `|0`（超 Int32 不截断）；非正/非有限一律归 0=无攻击', () => {
  // 报文实证值（dashcam 20261106T002310 唯一一笔触发：20021 {sign:4, deBeginTime:1793896015}）
  assert.equal(normalizeDeBeginTime(1793896015), 1793896015);
  // 线上传的是十进制串时同样可用
  assert.equal(normalizeDeBeginTime('1793896015'), 1793896015);
  assert.equal(normalizeDeBeginTime(1793896015.9), 1793896015, '小数取 floor');

  // 截断陷阱钉死：一旦有人把归一改回 `|0`，超 Int32 的时刻会变成负数→闸永不放行且零日志线索
  const beyond = 2 ** 31 + 5;
  assert.equal(normalizeDeBeginTime(beyond), beyond);
  assert.notEqual(normalizeDeBeginTime(beyond), beyond | 0);
  assert.ok((beyond | 0) < 0, '基线：`|0` 对该值确实会截成负数');

  // 0/负数/NaN/空值一律归 0（服务器把 deBeginTime 推回 0 即本次攻击已自清理）
  for (const bad of [0, -5, NaN, Infinity, -Infinity, null, undefined, '', 'abc', {}]) {
    assert.equal(normalizeDeBeginTime(bad), 0, 'input=' + String(bad));
  }
});

test('defenseGate：八分支逐条钉住（开关/触发/幂等/满格/拒阈/读数/战力）+ fail-closed 优先级', () => {
  assert.equal(CMD_DEFEND, 3515, '协议号锁死：RequestId.RadarDefend');
  assert.equal(SIGN_MAX, 5, '满格值锁死：radar_help_4017 击退即顶满');

  const g = (o) => defenseGate({ ...gateBase(), ...o });

  // 基线：真人录制那一刻的态（开关开、有触发、sign=4 未满、幂等未记、战力达标）
  assert.deepEqual(g(), { fire: true, reason: 'fire' });
  // 与竞品 B `server-js.js:19892` 的口径差异：它另加 `radarSignNum <= 3` 是给 3517 免费增强留位；
  //   本 feat 不做 3517，sign=4 仍应放行（击退本身就把功率顶满，早做晚做都是净收益）
  assert.equal(g({ sign: 4 }).fire, true);

  assert.deepEqual(g({ open: false }), { fire: false, reason: 'off' });
  assert.deepEqual(g({ deBeginTime: 0 }), { fire: false, reason: 'no-trigger' });
  assert.deepEqual(g({ deBeginTime: -1 }), { fire: false, reason: 'no-trigger' });
  assert.deepEqual(g({ deBeginTime: NaN }), { fire: false, reason: 'no-trigger' });
  // 幂等：同一触发时刻只受理一次（扩展重载后由落盘的 handled 接续）
  assert.deepEqual(g({ handled: 1793896015 }), { fire: false, reason: 'handled' });
  // 已满格：无攻击可打，也不得白撞一笔
  assert.deepEqual(g({ sign: 5 }), { fire: false, reason: 'full' });
  assert.deepEqual(g({ sign: 6 }), { fire: false, reason: 'full' });
  // 连续被拒达阈即锁死该次触发（干扰攻击每日至多 1 次，反复撞日限只会刷日志）
  assert.deepEqual(g({ rejects: 2, limit: 2 }), { fire: false, reason: 'reject-limit' });
  assert.equal(g({ rejects: 1, limit: 2 }).fire, true, '未达阈仍重试一次');

  // fail-closed：战力或门槛读不到一律不发（代价低于反复撞服务器）
  for (const pw of [null, undefined, 0, -1, NaN]) {
    assert.deepEqual(
      g({ power: pw }),
      { fire: false, reason: 'no-reading' },
      'power=' + String(pw),
    );
  }
  for (const need of [null, undefined, 0, -3, NaN]) {
    assert.deepEqual(
      g({ needPower: need }),
      { fire: false, reason: 'no-reading' },
      'needPower=' + String(need),
    );
  }
  // 战力不足门槛：游戏 RadarDefPop 会把按钮置灰，我方同样不做
  assert.deepEqual(g({ power: 89999, needPower: 90000 }), { fire: false, reason: 'weak' });
  assert.deepEqual(
    g({ power: 90000, needPower: 90000 }),
    { fire: true, reason: 'fire' },
    '等于门槛即达标',
  );

  // 短路次序：开关在一切之前；幂等先于满格/拒阈/读数（避开用无效读数抢占归因）
  assert.equal(g({ open: false, deBeginTime: 0 }).reason, 'off');
  assert.equal(g({ deBeginTime: 0, sign: 9 }).reason, 'no-trigger');
  assert.equal(g({ handled: 1793896015, sign: 9 }).reason, 'handled');
  assert.equal(g({ sign: 9, power: null }).reason, 'full');
  assert.equal(g({ rejects: 2, power: null }).reason, 'reject-limit');
  // 快照字段缺失（调用侧漏传）不得抛穿 cycle
  assert.doesNotThrow(() => defenseGate({}));
  assert.equal(defenseGate({}).reason, 'off');
});

/** 造防御闸快照（缺省即「可击退」基线，用例只覆写要验证的那一格） */
function gateBase() {
  return {
    open: true,
    deBeginTime: 1793896015,
    sign: 4,
    maxSign: SIGN_MAX,
    handled: 0,
    rejects: 0,
    limit: 2,
    power: 100000,
    needPower: 90000,
  };
}

// ── 停滞止损（与 20261107T005129 同型：s=0 受理、集结窗到期被原地解散、任务态 2→1 回滚）──────
// 实证：同一条 taskId=10002/id=3147 在 639s 内被 1201 重派 4 次（行军态序列恒 8→4，从未出发），
// 而 9 条 state=0 的普通任务 0 笔 3505、0 笔 3508，日志整场 reason=exec。

test('stallStep：只有 rollback 计停滞；达 dispatchStallLimit 即当日让位；finish/gone 一律清零', () => {
  assert.deepEqual(stallStep('rollback', 0, 2), { n: 1, yielded: false });
  assert.deepEqual(stallStep('rollback', 1, 2), { n: 2, yielded: true });
  // 达成/消失不算停滞（不能把昨天的失败累加到今天已成功的那条上）
  for (const kind of ['finish', 'gone']) {
    assert.deepEqual(stallStep(kind, 5, 2), { n: 0, yielded: false }, 'kind=' + kind);
  }
  // 阈可收紧：limit=1 时首次 rollback 即让位（feat 内不额外硬编码「再加一次」）
  assert.deepEqual(stallStep('rollback', 0, 1), { n: 1, yielded: true });
  // 脏入参不抛穿 cycle
  assert.deepEqual(stallStep('rollback', undefined, 2), { n: 1, yielded: false });
  assert.deepEqual(stallStep(undefined, 1, 2), { n: 0, yielded: false });
});

test('cfg：停滞止损与在途择时三键的口径锁死（沉降窗短于集结窗、首拍对拍=窗+缓冲、两类止损同阈）', () => {
  const winMs = RALLY_WAIT_TIME * 1000;
  assert.ok(
    cfg.dispatchSettleMs < winMs,
    '沉降窗必须远短于集结窗，否则窗内解散要等到下一个调拍才看得见',
  );
  assert.equal(cfg.execPollMs, winMs + 30000, '首次对拍 = 集结窗 + 30s 缓冲');
  assert.ok(
    cfg.execPollMs < cfg.execResyncMs,
    '窗到期即醒要早于低频档（固定 240s 正是「久久不执行」的一半成因）',
  );
  assert.equal(
    cfg.dispatchStallLimit,
    cfg.rejectRetryLimit,
    '「受理但停滞」与「服务器拒」同为「留一次自然重试」口径',
  );
});

test('candCmp：stalls 为首键（停滞过的往后靠）；无 stalls 字段时与旧口径完全一致', () => {
  const g19 = { dayGroupId: 19, quality: 4, id: '3147' };
  const g0 = { dayGroupId: 0, quality: 0, id: '1001' };
  // 旧口径基线：三连环位（day_group_id 最大）恒排最前——正是它饿死了其余 9 条
  assert.ok(candCmp(g19, g0) < 0);
  assert.ok(candCmp(g0, g19) > 0);
  // 停滞一次后必须让位
  const arr = [{ ...g19, stalls: 1 }, g0].sort(candCmp);
  assert.equal(arr[0].id, '1001', 'g19 停滞后普通任务顶上');
  // 停滞次数相同时回到旧口径（day_group → quality → id）
  assert.ok(candCmp({ ...g19, stalls: 2 }, { ...g0, stalls: 2 }) < 0);
  // 领奖排序等不带 stalls 的调用方不得因本键改变行为
  const claim = [
    { dayGroupId: 0, quality: 0, id: 'a' },
    { dayGroupId: 5, quality: 0, id: 'b' },
  ];
  assert.deepEqual(
    claim.sort(candCmp).map((x) => x.id),
    ['b', 'a'],
  );
});

test('pickCandidate：opts.stalls 注入降权键，刚解散的三连环位不再顶在最前', () => {
  const mk = (id, taskId, dayGroupId, state) => ({
    id,
    taskId,
    state,
    x: 395,
    y: 517,
    dayGroupId,
    groupType: dayGroupId ? 3 : 1,
    endTime: 0,
  });
  const all = [mk('3147', 10002, 19, 1), mk('1001', 10003, 0, 0)];
  const mcfg = { doDaily: true, doEvents: true, doMarch: true, preset: 3 };
  const resolve = (t) =>
    t.taskId === 10002
      ? { type: 202, quality: 4 }
      : t.taskId === 10003
        ? { type: 205, quality: 0 }
        : { type: 0, quality: 0 };

  // 无停滞记录：三连环集结位在前（与录制里它被反复选中一致）
  assert.equal(pickCandidate(all, mcfg, resolve, null, null, { stalls: {} }).pick.id, '3147');
  // 记 1 次停滞：让位给待认领的普通任务（本例同时验证 opts 缺省等价无降权）
  assert.equal(pickCandidate(all, mcfg, resolve, null).pick.id, '3147');
  assert.equal(
    pickCandidate(all, mcfg, resolve, null, null, { stalls: { 3147: 1 } }).pick.id,
    '1001',
  );
  // 达阈后走让位集合（调用侧把 reject + stall 两类合并传入）：跳过且不误归因 no-preset
  const dec = pickCandidate(all, mcfg, resolve, null, new Set(['3147']));
  assert.equal(dec.pick.id, '1001');
  assert.equal(dec.blacklisted, 1);
  assert.equal(dec.gated, false);
});

test('pickCandidate：onlyStart（exec 在途档）只放行认领，占兵型不参评也不误置 gated', () => {
  const mk = (id, taskId, dayGroupId, state) => ({
    id,
    taskId,
    state,
    x: 1,
    y: 1,
    dayGroupId,
    groupType: dayGroupId ? 3 : 1,
    endTime: 0,
  });
  // 'a' 集结位（已认领、需兵）；'b' 普通任务待认领；'c' 零部队型已认领
  const all = [mk('a', 10002, 19, 1), mk('b', 10003, 0, 0), mk('c', 10003, 0, 1)];
  const resolve = (t) =>
    t.taskId === 10002
      ? { type: 202, quality: 4 }
      : t.taskId === 10003
        ? { type: 205, quality: 0 }
        : { type: 0, quality: 0 };
  // preset=0 的闸门形状（execKey 置为不在池里的持有者，避开与单飞锁自身的跳过混淆）
  const noPreset = { doDaily: true, doEvents: true, doMarch: true, preset: 0 };
  const base = pickCandidate(all, noPreset, resolve, 'x');
  assert.equal(base.gated, true, '不带 onlyStart 时占兵候选被 preset 闸挡住→gated');
  assert.equal(base.pick.id, 'b', 'a 被 preset 闸拦下后，选中同质里 id 最小的待认领项');

  const inFlight = pickCandidate(all, noPreset, resolve, 'x', null, { onlyStart: true });
  assert.equal(inFlight.gated, false, '在途档不该把占兵候选计成 no-preset');
  assert.equal(inFlight.pick.id, 'b');
  assert.deepEqual(inFlight.pick.act, { act: 'start' });

  // 池里无可认领项（全已在手）→ 在途档选不出任何东西，调用侧保持静默
  const none = pickCandidate([mk('c', 10003, 0, 1)], noPreset, resolve, 'x', null, {
    onlyStart: true,
  });
  assert.equal(none.pick, null);
  assert.equal(none.gated, false);
});
