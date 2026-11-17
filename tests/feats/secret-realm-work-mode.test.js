// 异能秘境 WORK 相位策略离线单测（三-4：work-mode.js 纯决策层契约）。
// work-mode.js 只 import constants.js 的 PAB_* 点型常量；constants.js 末尾 re-export
// core/util.js 会触浏览器全局，故先最小桩化再动态 import（与 secret-realm-rejects.test.js 同法）。
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

const { enter, tick } =
  await import('../../extension/src/feats/activity/secret-realm/work-mode.js');
const C = await import('../../extension/src/feats/activity/secret-realm/constants.js');

/** 事实包基线：tuning 全给定，纯函数不读真实 tuning/时钟。 */
function facts(over = {}) {
  return {
    now: 100000,
    key: '10,20',
    d: {},
    t: {
      driveStayMonsterMs: 20000,
      driveWorkMaxMs: 45000,
      driveWorkDwellMs: 8000,
      driveShopDwellMs: 25000,
      driveShopUnitMs: 3000,
      driveShopExtraMs: 20000,
      driveShopStayMs: 5000,
      driveSausageTarget: 10,
      driveScanMs: 1000,
    },
    sausageHave: 0,
    shopLedgerEntry: null,
    ...over,
  };
}

test('enter 172 野怪：固定驻留 driveStayMonsterMs，不重路由', () => {
  const f = facts();
  const p = enter(C.PAB_MONSTER, f);
  assert.equal(p.workMode, 'dwell');
  assert.equal(p.workUntil, f.now + 20000);
  assert.equal(p.workDeadline, 0);
});

test('enter 173 井：empty 档无驻留地板（workUntil=0），拿不空受天花板 driveWorkMaxMs 兜底', () => {
  const f = facts();
  const p = enter(C.PAB_RESOURCE, f);
  assert.equal(p.workMode, 'empty');
  assert.equal(p.workUntil, 0); // 拿空当拍即走，旧 resDwellMs 动态地板已废
  assert.equal(p.workDeadline, f.now + 45000);
});

test('enter 163 掉落箱：empty 档无动态地板（workUntil=0），同样带天花板', () => {
  const f = facts();
  const p = enter(C.PAB_DROP, f);
  assert.equal(p.workMode, 'empty');
  assert.equal(p.workUntil, 0);
  assert.equal(p.workDeadline, f.now + 45000);
});

test('enter 161 商店：动态驻留 max(基墙, 缺口×unit) 封顶基墙+extra，副作用位齐备', () => {
  const f = facts({ sausageHave: 7 }); // 缺口 3×3000=9000 < 基墙 25000 → 取基墙
  const p = enter(C.PAB_SHOP, f);
  assert.equal(p.workMode, 'dwell');
  assert.equal(p.workUntil, f.now + 25000);
  assert.equal(p.shopErrandDone, true);
  assert.equal(p.shopLastAt, f.now);
  assert.equal(p.kickShop, true);
  assert.equal(p.shopCoolUntil, f.now + Math.max(3000, 5000));
  assert.equal(p.shopLedgerEntry.time, Math.floor(f.now / 1000)); // 秒口径
  assert.equal(p.shopLedgerEntry.visited, 1);
  // 缺口大时按件数放宽，但不得超基墙+extra 总天花板
  const big = enter(C.PAB_SHOP, facts({ sausageHave: 0 })); // 10×3000=30000 > 25000，cap=45000
  assert.equal(big.workUntil, f.now + 30000);
  const capped = enter(
    C.PAB_SHOP,
    facts({ sausageHave: 0, t: { ...facts().t, driveShopUnitMs: 9000 } }),
  ); // 90000 → cap 45000
  assert.equal(capped.workUntil, f.now + 25000 + 20000);
});

test('enter 161 商店：面板 shopDwellMs 覆盖基墙；已有账本行保留其余字段', () => {
  const f = facts({
    sausageHave: 10,
    d: { shopDwellMs: 10000 },
    shopLedgerEntry: { time: 1, sausage: 2, piece: 0, visited: 0, sausageShelf: 1 },
  });
  const p = enter(C.PAB_SHOP, f);
  assert.equal(p.workUntil, f.now + 10000);
  assert.equal(p.shopLedgerEntry.sausage, 2);
  assert.equal(p.shopLedgerEntry.sausageShelf, 1);
  assert.equal(p.shopLedgerEntry.visited, 1);
});

test('enter 其余点型（176 平台）：driveWorkDwellMs 固定驻留', () => {
  const p = enter(C.PAB_BOSS_PLANE, facts());
  assert.equal(p.workMode, 'dwell');
  assert.equal(p.workUntil, 100000 + 8000);
});

test('tick empty：isEmpty 当拍即走（无 settle 结算窗/无驻留地板，判空两路皆服务器结算后权威态）', () => {
  const f = facts({ isEmpty: true });
  const s = { workMode: 'empty', workUntil: 0, workDeadline: 145000 };
  const r = tick(C.PAB_RESOURCE, s, f);
  assert.equal(r.leave, true, '拿空当拍即走');
  assert.equal(r.sleep, 0);
  assert.equal(r.patch, undefined, '不再带 workEmptyAt 补丁');
  // 旧地板料源（workUntil 动态驻留）不再拦路：即使 workUntil 未到也当拍走
  const r2 = tick(C.PAB_RESOURCE, { ...s, workUntil: 107000 }, f);
  assert.equal(r2.leave, true);
  assert.equal(r2.sleep, 0);
});

test('tick empty：未判空 → 分段轮询；到天花板强制离点（empty_ceiling 日志）', () => {
  const f = facts({ isEmpty: false });
  const s = { workMode: 'empty', workUntil: 0, workDeadline: 145000 };
  const r1 = tick(C.PAB_RESOURCE, s, f);
  assert.equal(r1.leave, false);
  assert.equal(r1.sleep, 1000); // min(driveScanMs, 45000)
  assert.equal(r1.patch, undefined);
  const r2 = tick(C.PAB_RESOURCE, s, { ...f, now: 145000 });
  assert.equal(r2.leave, true);
  assert.match(r2.log.tpl, /reason=empty_ceiling/);
  assert.deepEqual(r2.log.args, ['10,20']);
});

test('tick BOSS：拍宠让路不赶车；bossLeaveWhy/no-window 两条提前离点', () => {
  const s = { workMode: 'dwell', workUntil: 108000, workDeadline: 0 };
  const f = facts();
  // 拍宠中：即使全图无窗也让路，分段轮询
  const r0 = tick(C.PAB_BOSS, s, { ...f, captureBusy: true, bossWin: null, bossLiveHere: false });
  assert.equal(r0.leave, false);
  assert.equal(r0.sleep, 1000); // min(driveScanMs, 8000)
  // 现场判死/投喂交接 → 提前离点
  const r1 = tick(C.PAB_BOSS, s, { ...f, bossLeaveWhy: 'tile dead' });
  assert.equal(r1.leave, true);
  assert.match(r1.log.tpl, /reason=boss_over/);
  assert.deepEqual(r1.log.args, ['10,20', 'tile dead']);
  // 全图无窗且本点无活 → 当拍离点
  const r2 = tick(C.PAB_BOSS, s, { ...f, bossWin: null, bossLiveHere: false });
  assert.equal(r2.leave, true);
  assert.match(r2.log.tpl, /reason=no-window/);
  // 有窗 → 分段轮询不睡满；驻留满 → 离点
  const r3 = tick(C.PAB_BOSS, s, { ...f, bossWin: { state: 22 } });
  assert.equal(r3.leave, false);
  assert.equal(r3.sleep, 1000);
  const r4 = tick(C.PAB_BOSS, s, { ...f, bossWin: { state: 22 }, now: 108000 });
  assert.equal(r4.leave, true);
});

test('tick 非 BOSS dwell：睡满剩余驻留（不分段），到期离点', () => {
  const s = { workMode: 'dwell', workUntil: 120000, workDeadline: 0 };
  const r1 = tick(C.PAB_MONSTER, s, facts());
  assert.equal(r1.leave, false);
  assert.equal(r1.sleep, 20000); // 一次睡满，区别于 BOSS 分段
  const r2 = tick(C.PAB_MONSTER, s, facts({ now: 120000 }));
  assert.equal(r2.leave, true);
});

test('tick 商店：缺口续留分段轮询至 ceiling；超顶强制离店；补满当拍即走', () => {
  const s = { workMode: 'dwell', workUntil: 125000, workDeadline: 0 };
  // 驻留满但香肠 7/10 → ceiling=125000+20000=145000，分段轮询
  const r1 = tick(C.PAB_SHOP, s, facts({ now: 125000, sausageHave: 7 }));
  assert.equal(r1.leave, false);
  assert.equal(r1.sleep, 1000);
  // 超顶 → 强制离店（日志带缺口与秒数）
  const r2 = tick(C.PAB_SHOP, s, facts({ now: 145000, sausageHave: 7 }));
  assert.equal(r2.leave, true);
  assert.match(r2.log.tpl, /reason=shop_extra_ceiling/);
  assert.deepEqual(r2.log.args, ['10,20', 7, 10, 20]);
  // 补满 → 不等 ceiling 当拍走
  const r3 = tick(C.PAB_SHOP, s, facts({ now: 130000, sausageHave: 10 }));
  assert.equal(r3.leave, true);
  assert.equal(r3.log, undefined);
});

test('tick 商店：shopGiveUp 止损信号 → 缺口也不续留，当拍即走（四-2）', () => {
  const s = { workMode: 'dwell', workUntil: 125000, workDeadline: 0 };
  // 驻留已截短到 now（pilot shopRefreshGiveUp 同步截短），缺口仍在但带止损信号 → 不续留
  const r = tick(C.PAB_SHOP, s, facts({ now: 125000, sausageHave: 3, shopGiveUp: true }));
  assert.equal(r.leave, true);
  assert.equal(r.sleep, 0);
  assert.equal(r.log, undefined);
});
