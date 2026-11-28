// aureole-slot（摇摇机）纯函数单测：两套皮共用的选台/闸门决策。
// 断言的是「抽哪台、什么顺序、要不要抽、面板显什么」，不含发包形态与定时器。
// feat 模块 import 链会触到浏览器全局（reactor/storage/bus），故先最小桩化
// window/document/chrome，再动态 import 取导出纯函数（同 cq26-excav 口径）。
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

// core 链里的 session 等模块在 import 期就挂常驻 setInterval——只对测试 harness 的定时器
// unref（否则 node --test 进程永不退出），不参与被测逻辑。
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (fn, ms, ...rest) => {
  const h = realSetInterval(fn, ms, ...rest);
  if (h && typeof h.unref === 'function') h.unref();
  return h;
};

const mod = await import('../../extension/src/feats/activity/aureole-slot/index.js');
const {
  slotCap,
  drawKey,
  pickDrawables,
  slotTodayCount,
  slotRedDotOpen,
  isSlotActivity,
  scanFamily,
} = mod;
const { SLOT_FAMILIES } =
  await import('../../extension/src/feats/activity/aureole-slot/constants.js');
const { dailyText } = await import('../../extension/src/core/daily-stats.js');
const { reactor } = await import('../../extension/src/core/reactor.js');

const AUREOLE = SLOT_FAMILIES.find((f) => f.showUiType === 'ActAureole');
const TIGER = SLOT_FAMILIES.find((f) => f.showUiType === 'ActivityExcavate');

// ── 实录 fixture（dashcam-rec-20261127T001318-城皮自动切换，全场唯一一台机器）──
/** 实录 type_para1：[0]=21600 存活秒、[2]=1 每台上限、[4]=260113080 发现者大奖 */
const TYPE_PARA1 = '21600|999|1|1|260113080';
/** expireTimeMilli {_low:435005007,_high:418} = 1795731334735 毫秒 */
const EXPIRE_MS = 1795731334735;
const EXPIRE_SEC = 1795731334;
const RECORDED = {
  instanceIdStr: '1',
  expireTimeMilli: { _low: 435005007, _high: 418 },
  triggerUser: { uid: 14179309129759, playerInfo: {}, serverId: 3828, frameId: 0 },
  x: 512,
  y: 388,
};
/** 抽前 serverTime（expire − 创建 = 21585s，与 type_para1[0]=21600 印证） */
const NOW_FRESH = 1795709809;
/** 已踩过期线（1795731334 ≤ 1795731300 + 60 安全余量） */
const NOW_STALE = 1795731300;

/** 摇摇机活动实例（默认 extra 已就位、无任何已抽记录） */
function aureole(extra) {
  return { id: 260824104, showUiType: 'ActAureole', type_para1: TYPE_PARA1, extra: extra || {} };
}
/** 幸运机活动实例：type_para1 故意与 para6 不同（[2]=7 vs 1），用于断言「只读 para6」 */
function tiger(extra, para6) {
  return {
    id: 260113099,
    showUiType: 'ActivityExcavate',
    type_para1: '21600|999|7|1|0',
    para6: para6 === undefined ? '21600|999|1|1|0' : para6,
    extra: extra || {},
  };
}

test('① 每台上限：cap 取活动字段 [2]，buildDrawNumMap 达上限即剔除（实录抽后态）', () => {
  assert.equal(slotCap(aureole(), AUREOLE), 1, 'type_para1[2]=1');
  assert.equal(
    slotCap(aureole(), TIGER),
    1,
    '摇摇机活动无 para6 → 畸形回 1（宁可少抽也不放开上限）',
  );

  assert.equal(pickDrawables(aureole(), AUREOLE, [RECORDED], NOW_FRESH, null).length, 1);

  // 实录抽后态：extra.buildDrawNumMap={"1":1} → 服务端权威已抽满，0 候选
  const drew = aureole({ buildDrawNumMap: { 1: 1 } });
  assert.equal(pickDrawables(drew, AUREOLE, [RECORDED], NOW_FRESH, null).length, 0);

  // 字段缺失/畸形一律回 1
  assert.equal(slotCap({}, AUREOLE), 1);
  assert.equal(slotCap({ type_para1: '' }, AUREOLE), 1);

  // 排序照抄游戏列表：remain 降序优先，同余量再按 expireAt 升序（先抽快过期的）
  const far = { instanceIdStr: '1', expireTimeMilli: EXPIRE_MS + 3600000 };
  const near = { instanceIdStr: '3', expireTimeMilli: EXPIRE_MS };
  const cap3 = {
    id: 1,
    showUiType: 'ActAureole',
    type_para1: '21600|999|3|1|0',
    extra: { buildDrawNumMap: { 2: 2 } },
  };
  const picked = pickDrawables(
    cap3,
    AUREOLE,
    [far, { instanceIdStr: '2', expireTimeMilli: EXPIRE_MS }, near],
    NOW_FRESH,
    null,
  );
  assert.deepEqual(
    picked.map((p) => p.instanceIdStr),
    ['3', '1', '2'],
    'remain 3 的两台先抽 near，再 far，最后是只剩 1 次的 #2',
  );
});

test('② 过期闸：Int64 高低位拼装 + SAFE_REMAIN_SEC 余量', () => {
  const got = pickDrawables(aureole(), AUREOLE, [RECORDED], NOW_FRESH, null);
  assert.equal(got.length, 1);
  assert.equal(got[0].expireAt, EXPIRE_MS, '({_high:418}<<32)+_low = 1795731334735 毫秒');

  // 距过期不足 60s → 剔除（踩线发出去只会撞「机器已消失」）
  assert.equal(pickDrawables(aureole(), AUREOLE, [RECORDED], NOW_STALE, null).length, 0);
  assert.equal(NOW_STALE + 60 >= EXPIRE_SEC, true, 'fixture 自检：确实落在安全余量内');

  // expireTimeMilli 读不出（=0）时不因过期剔除，也不因影子键误屏蔽
  const noExpire = pickDrawables(aureole(), AUREOLE, [{ instanceIdStr: '7' }], NOW_STALE, null);
  assert.equal(noExpire.length, 1);
  assert.equal(noExpire[0].expireAt, 0);
});

test('③ 影子集复合键：showUiType#instanceId@expireSec，同 id 不同到期/跨皮互不屏蔽', () => {
  assert.equal(drawKey(AUREOLE, '1', EXPIRE_MS), 'ActAureole#1@' + EXPIRE_SEC);

  const blocked = drawKey(AUREOLE, '1', EXPIRE_MS);
  const shadow = { isBlocked: (k) => k === blocked };
  assert.equal(pickDrawables(aureole(), AUREOLE, [RECORDED], NOW_FRESH, shadow).length, 0);

  // 同一 instanceIdStr、新一台机器（expire 不同）→ 不同键，不被旧机器的拉黑误屏蔽
  const nextMachine = { ...RECORDED, expireTimeMilli: { _low: 435005007, _high: 419 } };
  const still = pickDrawables(aureole(), AUREOLE, [nextMachine], NOW_FRESH, shadow);
  assert.equal(still.length, 1);
  assert.notEqual(still[0].key, blocked);

  // 跨皮同 instanceId：两套皮的 instanceId 各自独立计数，互不屏蔽
  const tigerGot = pickDrawables(tiger(), TIGER, [RECORDED], NOW_FRESH, shadow);
  assert.equal(tigerGot.length, 1, '幸运机不受摇摇机拉黑影响');
  assert.equal(tigerGot[0].key, 'ActivityExcavate#1@' + EXPIRE_SEC);
});

test('④ 红点闸短路：worldUIRed/worldRed 皆 0 时一发世界列表都不发', async () => {
  assert.equal(slotRedDotOpen(undefined), false);
  assert.equal(slotRedDotOpen({ worldUIRed: 0, worldRed: 0 }), false);
  assert.equal(slotRedDotOpen({ worldUIRed: 0, worldRed: 1 }), true);
  assert.equal(slotRedDotOpen({ worldUIRed: 1, buildDrawNumMap: { 1: 1 } }), true);

  const calls = [];
  const fakeNet = {
    isSending: () => false,
    sendPBV2: (cmd, payload) => {
      calls.push({ cmd, payload });
      return Promise.resolve({ ok: true, data: { worldList: [RECORDED] } });
    },
  };
  const host = {
    net: fakeNet,
    nowSec: NOW_FRESH,
    alive: () => true,
    shadow: { isBlocked: () => false },
  };

  // 实录抽完同一台后 worldUIRed/worldRed 同时归 0 → 整轮不产生请求
  const quiet = await scanFamily(AUREOLE, aureole({ worldUIRed: 0, worldRed: 0 }), host);
  assert.deepEqual(quiet, []);
  assert.equal(calls.length, 0, '红点闸必须排在世界列表请求之前');

  // 对照：红点亮了才发，且载荷只有 activityId 一键
  const hot = await scanFamily(AUREOLE, aureole({ worldUIRed: 1 }), host);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 9630);
  assert.deepEqual(calls[0].payload, { activityId: 260824104 });
  assert.equal(hot.length, 1);
  assert.equal(hot[0].item.instanceIdStr, '1');

  // 在途闸：游戏面板正在拉同一 cmd → 本轮跳过，同样不发请求
  const busy = await scanFamily(AUREOLE, aureole({ worldUIRed: 1 }), {
    ...host,
    net: { ...fakeNet, isSending: () => true },
  });
  assert.deepEqual(busy, []);
  assert.equal(calls.length, 1, '在途期间零新增请求');
});

test('⑤ 孪生支路：cap 只读 para6（不读 type_para1）；para6 缺位=整条不入选', () => {
  const act = tiger(); // para6[2]=1、type_para1[2]=7
  assert.equal(slotCap(act, TIGER), 1, '幸运机读 para6[2]');
  assert.equal(slotCap(act, AUREOLE), 7, '同一活动按摇摇机口径才读 type_para1[2]');

  // 抽过 1 次即满：若误读 type_para1[2]=7 则 remain=6 仍会入选
  const drew = pickDrawables(
    tiger({ buildDrawNumMap: { 1: 1 } }),
    TIGER,
    [RECORDED],
    NOW_FRESH,
    null,
  );
  assert.equal(drew.length, 0, 'cap 取错字段就会漏这条');

  // para6 是摇摇机支路开关：缺省/空串 → 本期印石挖掘挂的是传说宝藏，整条不入选
  assert.equal(isSlotActivity(TIGER, { id: 1, showUiType: 'ActivityExcavate' }, null), false);
  assert.equal(isSlotActivity(TIGER, tiger(undefined, ''), null), false);
  assert.equal(isSlotActivity(TIGER, act, null), true);
  // showUiType 不匹配 → 不入选（活动开启时才入选）
  assert.equal(isSlotActivity(TIGER, aureole(), null), false);
  assert.equal(isSlotActivity(AUREOLE, aureole(), null), true, '摇摇机无 requireField');
  assert.equal(
    isSlotActivity(AUREOLE, aureole(), () => false),
    false,
    '活动未开启不入选',
  );

  // 两套皮各自的号段镜像
  assert.deepEqual(
    SLOT_FAMILIES.map((f) => [f.showUiType, f.worldListCmd, f.drawCmd, f.capField]),
    [
      ['ActAureole', 9630, 9628, 'type_para1'],
      ['ActivityExcavate', 2509, 2507, 'para6'],
    ],
  );
});

test('⑥ 状态行：只显「今日 N 次」，两套皮求和，两者皆无显 —', () => {
  const unloaded = { loaded: () => false, get: () => 0 };
  assert.equal(
    slotTodayCount(
      [
        { fam: AUREOLE, activity: aureole({ buildDrawNumToday: 2 }) },
        { fam: TIGER, activity: tiger({ buildDrawNumToday: 1 }) },
      ],
      unloaded,
    ),
    3,
    '两套皮各读各自 extra 再求和',
  );

  // extra 未读回 + 日账未 loaded → null（面板 '—'，不拿 0 冒充进度）
  assert.equal(slotTodayCount([{ fam: AUREOLE, activity: aureole() }], unloaded), null);
  assert.equal(slotTodayCount([], unloaded), null);
  assert.equal(slotTodayCount(null, unloaded), null);

  // 回落本地日账（键=showUiType），服务器有值时优先服务器
  const ledger = {
    loaded: () => true,
    get: (k) => (k === 'ActAureole' ? 5 : 0),
  };
  assert.equal(slotTodayCount([{ fam: AUREOLE, activity: aureole() }], ledger), 5);
  assert.equal(
    slotTodayCount([{ fam: AUREOLE, activity: aureole({ buildDrawNumToday: 1 }) }], ledger),
    1,
  );

  // 面板形态：无分母走 dailyText 的「今日 N 次」，且状态行必须是 fields 首位（inlineStatus 取第一条 text）
  assert.equal(dailyText(3), '今日 3 次');
  const spec = reactor.list().find((s) => s.id === 'aureoleSlot');
  assert.ok(spec, 'feat 已向 reactor 注册');
  assert.equal(spec.label, '摇摇机');
  assert.equal(spec.storageKey, 'pocketcc.feat.aureoleSlot');
  assert.equal(spec.defaults.enabled, false);
  assert.equal(spec.fields.length, 1, '只一条状态行，不带「可抽/无可抽」后缀');
  assert.equal(spec.fields[0].type, 'text');
  assert.equal(spec.fields[0].key, '_drawInfo');
  // 未安装（hub 快照为空）时字段读回 '—'，不抛
  assert.equal(spec.fields[0].get(), '—');
});
