// 异能秘境商店「低保前置闸」行为单测（系统默认行为：无开关、队长/队员同权、与自动驾驶无关）。
// 契约（用户口径）：到店先买低保（type3 传奇百兽箱碎片自选箱，2000 晶块、全场额度 1）；
//   晶块不够买低保 → 本轮商店什么都不买；买到（或全场额度尽）后才买清单其他项。
// 手法：mock env + node:test mock timers（setTimeout/setInterval/Date 全_mock，buy-gap 静默可推进），
//   经 start() 真跑 createCycle 电平循环，逐拍 tick 观察 8540/8542 发包序列与闸日志。
// 桩化口径与 secret-realm-shop-miss.test.js 相同：先最小桩 window/document/chrome 再动态 import。
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

const { ShopEngine } = await import('../../extension/src/feats/activity/secret-realm/shop.js');
const C = await import('../../extension/src/feats/activity/secret-realm/constants.js');

// 首扫延迟归零：测试里 boot 后第一拍即 INFO（真机 15s 是避玩家操作窗，离线无此冲突）
C.tuning.shopFirstDelayMs = 0;

/** 货表两行：spec19 香肠（500/件、本店额度 10）、spec20 低保（2000/件、type3 全场额度 1）。 */
const SHOP_ROWS = [
  { id: 19, type: 1, item_id: 41011, item_num: 1, cost: 500, buy_times: 10 },
  { id: 20, type: 3, item_id: 38006601, item_num: 1, cost: 2000, buy_times: 1 },
];

/**
 * mock 运行底座：bag/shelf/base 均可变（模拟服务器应答回带与换场），sent 记全部发包。
 * @param {object} [over] {bag, shelfGet20, channel, driveOn}
 * @returns {object} rig {env, sent, logs, bag, shelf, base}
 */
function mkRig(over = {}) {
  const sent = [];
  const logs = [];
  const bag = Object.assign({ 41009: 0, 41010: 10, 41011: 0, 38006601: 0 }, over.bag);
  const shelf = [
    { specId: 19, getTime: 0 },
    { specId: 20, getTime: over.shelfGet20 || 0 },
  ];
  const base = {
    startPoint: { x: 95, y: 163 },
    pointType: 161,
    marchState: 2,
    fightBeginTime: 1700000000000,
  };
  const snap = () => shelf.map((s) => ({ specId: s.specId, getTime: s.getTime }));
  const pickItems = over.channel ? { 'item:41011': { on: 1, shop: 1, max: 10 } } : {};
  const cfg = {
    pickItems: pickItems,
    shop: { enabled: !!over.channel },
    drive: { enabled: !!over.driveOn },
  };
  // 与 createLog 同口径的 printf 展开（%s/%d），否则 gate[%s] 模板不落地、断言抓不到闸名
  const push = (...a) => {
    let i = 1;
    logs.push(String(a[0]).replace(/%[sd]/g, () => String(a[i++])));
  };
  const env = {
    alive: () => true,
    realmActive: () => true,
    cfg: () => cfg,
    secret: {
      getRoomBaseInfo: () => base,
      getNMarchState: () => ({ ARRIVED: 2 }),
      teamIsMooring: () => true,
      getItemNumById: (id) => bag[id] || 0,
      isSecretSending: () => false,
      sendSecret: (cmd, data) => {
        sent.push({ cmd: cmd, data: data });
        if (cmd === C.CMD_SHOP_BUY) {
          const row = SHOP_ROWS.find((r) => r.id === Number(data.specId));
          const slot = shelf.find((s) => s.specId === Number(data.specId));
          if (row && slot) {
            slot.getTime += Number(data.num);
            bag[41009] -= row.cost * Number(data.num);
            bag[row.item_id] = (bag[row.item_id] || 0) + row.item_num * Number(data.num);
          }
        }
        if (cmd === C.CMD_SHOP_REFRESH) {
          for (const s of shelf) {
            const row = SHOP_ROWS.find((r) => r.id === s.specId);
            if (row && Number(row.type) !== 3) s.getTime = 0;
          }
        }
        return Promise.resolve({ code: 0, data: { items: snap() } });
      },
    },
    gameConf: {
      dataConfig: (k) => (k === C.CFG_SHOP_CURRENCY ? '41009|41010' : 1),
    },
    l10n: {
      tableRows: (t) => (t === C.TABLE_SHOP ? SHOP_ROWS : []),
      tableRow: (t, id) => {
        if (t === C.TABLE_SHOP) return SHOP_ROWS.find((r) => r.id === Number(id)) || null;
        if (t === C.TABLE_ITEM && Number(id) === 41011) return { type: 171, para1_v1: 10 };
        return null;
      },
    },
    log: { info: push, debug: push, warn: push, error: push },
    markShopLedger: () => {},
    shopRefreshGiveUp: () => {},
  };
  return { env: env, sent: sent, logs: logs, bag: bag, shelf: shelf, base: base };
}

/** 微任务全_flush（setImmediate 不被 mock，落在所有 .then 之后）。 */
const flush = () => new Promise((r) => setImmediate(r));

/**
 * 起引擎并跑完首拍（INFO 装载货单）；返回逐拍推进器 step(ms)。
 * @param {object} t node:test 上下文（mock timers 随测试自动复位）
 * @param {object} [over] mkRig 选项
 * @returns {Promise<object>} rig + {eng, step}
 */
async function boot(t, over) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const rig = mkRig(over);
  const eng = new ShopEngine(rig.env);
  eng.start({});
  const step = async (ms) => {
    t.mock.timers.tick(ms);
    await flush();
  };
  await step(0); // 首扫延迟 0 → 8540 INFO 发出并落地
  await flush();
  return Object.assign(rig, { eng: eng, step: step });
}

const buys = (rig) => rig.sent.filter((s) => s.cmd === C.CMD_SHOP_BUY);
const infos = (rig) => rig.sent.filter((s) => s.cmd === C.CMD_SHOP_INFO);

test('F1 队员档（drive 关/无店勾选）晶块不够低保：本轮商店什么都不买，只 INFO 不买不刷', async (t) => {
  const rig = await boot(t, { bag: { 41009: 1500 } });
  await rig.step(C.tuning.shopGapMs); // 低保闸：broke → 停购
  await rig.step(C.tuning.shopWatchMs);
  await rig.step(C.tuning.shopWatchMs);
  assert.equal(buys(rig).length, 0, '晶块 1500 < 2000：香肠买得起也不许买');
  assert.equal(rig.sent.filter((s) => s.cmd === C.CMD_SHOP_REFRESH).length, 0, '停购期不刷店');
  assert.equal(infos(rig).length, 1, '每次到店只 INFO 一次');
  assert.ok(
    rig.logs.some((s) => s.includes('gate[floor-block]') && s.includes('reason=broke')),
    '停购闸边沿日志带 reason=broke',
  );
  assert.ok(
    rig.logs.some((s) => s.includes('hold ALL other purchases')),
    '停购语义留痕（dashcam 单轨定责）',
  );
  assert.ok(rig.eng.floorStatus().startsWith('未买到'), '面板只读状态=未买到');
  rig.eng.stop();
});

test('F2 队员档晶块够低保：先买低保一笔；无店勾选/drive 关时买完即停（补货总闸仍约束其他）', async (t) => {
  const rig = await boot(t, { bag: { 41009: 2500 } });
  await rig.step(C.tuning.shopGapMs); // 低保闸 buy → 8542 spec20
  await rig.step(C.tuning.shopBuyGapMs); // 静默满 → 闸放行 → 补货总闸不过 → 长睡
  const b = buys(rig);
  assert.equal(b.length, 1, '只买低保一笔');
  assert.equal(b[0].data.specId, 20);
  assert.equal(b[0].data.num, 1, '全场额度 1 → 一笔买满');
  assert.equal(rig.bag[41009], 500, '2500-2000=500');
  assert.equal(rig.eng.floorStatus(), '本场已买到');
  rig.eng.stop();
});

test('F3 低保先于清单其他项：晶块够时 spec20 必先于 spec19（勾了店渠道的队员档）', async (t) => {
  const rig = await boot(t, { bag: { 41009: 2500 }, channel: true });
  await rig.step(C.tuning.shopGapMs); // 买低保
  await rig.step(C.tuning.shopBuyGapMs); // 放行 → 清单香肠补一笔
  await rig.step(C.tuning.shopBuyGapMs); // 余额 0 → 清单降级长睡
  const seq = buys(rig).map((s) => s.data.specId);
  assert.ok(seq.length >= 2, '低保+香肠各至少一笔');
  assert.equal(seq[0], 20, '第一笔必须是低保');
  assert.ok(seq.indexOf(19) > 0, '香肠只能在低保之后');
  rig.eng.stop();
});

test('F4 勾了店渠道但晶块不够低保：香肠（500 买得起）也停购——低保闸优先于清单勾选', async (t) => {
  const rig = await boot(t, { bag: { 41009: 1500 }, channel: true });
  await rig.step(C.tuning.shopGapMs);
  await rig.step(C.tuning.shopWatchMs);
  assert.equal(buys(rig).length, 0, '欠低保且 broke：清单勾选也不放行');
  assert.ok(rig.logs.some((s) => s.includes('reason=broke')));
  rig.eng.stop();
});

test('F5 低保已买到（跨店共享额度回带 20:1）：晶块只剩 500 也放行清单补货', async (t) => {
  const rig = await boot(t, { bag: { 41009: 500 }, channel: true, shelfGet20: 1 });
  await rig.step(C.tuning.shopGapMs); // getTime>0 → 闸放行 → 香肠一笔
  const b = buys(rig);
  assert.equal(b.length, 1);
  assert.equal(b[0].data.specId, 19, '低保已买到 → 不再买低保，直接补清单');
  assert.equal(rig.eng.floorStatus(), '本场已买到');
  rig.eng.stop();
});

test('F6 换场复位：同点停靠跨场重 INFO，低保欠位重新生效（不吃上一场 20:1 陈旧基准）', async (t) => {
  const rig = await boot(t, { bag: { 41009: 2500 } });
  await rig.step(C.tuning.shopGapMs); // 买低保
  await rig.step(C.tuning.shopBuyGapMs); // 放行 → 长睡（shopSweepMs）
  assert.equal(rig.eng.floorStatus(), '本场已买到');
  // 新一场：fightBeginTime 变化 + 服务器货单额度复位（20:0）；队伍仍停同一家店
  rig.base.fightBeginTime = 1700000099999;
  rig.shelf.find((s) => s.specId === 20).getTime = 0;
  await rig.step(C.tuning.shopSweepMs); // 换场复位 + 重 INFO
  await rig.step(C.tuning.shopGapMs); // 余额 500 < 2000 → 再次停购
  assert.equal(infos(rig).length, 2, '换场必须重 INFO 拿本场货单基准');
  assert.equal(buys(rig).length, 1, '新一场晶块不够 → 不再买任何东西');
  assert.ok(rig.eng.floorStatus().startsWith('未买到'), '「买到」位按场复位');
  rig.eng.stop();
});

test('F7 全场额度尽（20:1 且 buyTimes=1）：低保闸永久放行，不重复尝试低保', async (t) => {
  const rig = await boot(t, { bag: { 41009: 5000 }, channel: true, shelfGet20: 1 });
  await rig.step(C.tuning.shopGapMs);
  await rig.step(C.tuning.shopBuyGapMs);
  const seq = buys(rig).map((s) => s.data.specId);
  assert.ok(!seq.includes(20), '额度尽不再买低保');
  assert.ok(seq.includes(19), '放行后清单照补');
  rig.eng.stop();
});
