// 异能秘境编队治疗「系统默认化」行为单测（无面板开关、无物品勾选、无配额上限）。
// 契约（用户口径）：进秘境即生效；掉血阈值 = 系统常量 tuning.healLossPct(10%)；
//   道具恒走游戏白名单 dataConfig(3035) 全量；一拍一件（8534 itemCount 恒 1 是协议形状），
//   循环按 healGapMs 自然续拍，直到「快照恢复到阈值以上」或「背包用光」才停。
// 手法：mock env + node:test mock timers（同 secret-realm-shop-floor.test.js 范式），
//   经 start() 真跑 createCycle 电平循环；8534 成功后 rig 模拟游戏弹层自补一条 8584（0.5~0.6s 回环）。
// 桩化口径：先最小桩 window/document/chrome 再动态 import。
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

const { HealEngine } = await import('../../extension/src/feats/activity/secret-realm/heal.js');
const C = await import('../../extension/src/feats/activity/secret-realm/constants.js');

/** 每件道具的回血量（rig 模拟服务器结算：绷带 +100 / 急救箱 +300，封顶 maxArmyPower）。 */
const HEAL_AMOUNT = { 41002: 100, 41003: 300 };

/**
 * mock 运行底座：armies/bag 可变（模拟服务器权威血量与背包余量），sent 记全部发包。
 *   cfg 恒回 {}（无 heal 键）——治疗默认生效不读面板；预筛料源 base.members[].powerInfos 随 armies 同步。
 * @param {object} [over] {armies, bag}
 * @returns {object} rig {env, sent, logs, bag, armies, handlers}
 */
function mkRig(over = {}) {
  const sent = [];
  const logs = [];
  const bag = Object.assign({ 41002: 3, 41003: 2 }, over.bag);
  const armies = (over.armies || [{ armyPower: 800, maxArmyPower: 1000 }]).map((a, i) => ({
    armyPower: a.armyPower,
    maxArmyPower: a.maxArmyPower,
    marchId: { _low: i + 1, _high: 0, _unsigned: true },
  }));
  const handlers = new Map();
  // 8584 应答投递（引擎经 ctx.on.resp 登记的 handler）：血量恒取 armies 当前态（服务器权威）
  const deliver = () => {
    const fn = handlers.get(C.CMD_MARCH_ARMY_INFO);
    if (fn) {
      fn({
        status: 0,
        data: {
          playerInfo: { uid: '111' },
          infos: armies.map((a) => ({
            armyPower: a.armyPower,
            maxArmyPower: a.maxArmyPower,
            marchId: a.marchId,
          })),
        },
      });
    }
  };
  // 与 createLog 同口径的 printf 展开（%s/%d），否则断言抓不到日志文案
  const push = (...a) => {
    let i = 1;
    logs.push(String(a[0]).replace(/%[sd]/g, () => String(a[i++])));
  };
  const env = {
    alive: () => true,
    realmActive: () => true,
    cfg: () => ({}), // 无 heal 键：系统默认行为不读面板
    secret: {
      getRoomBaseInfo: () => ({
        members: [
          {
            uid: '111',
            powerInfos: armies.map((a) => ({ power: a.armyPower, initPower: a.maxArmyPower })),
          },
        ],
      }),
      getItemNumById: (id) => bag[id] || 0,
      isSecretSending: () => false,
      sendSecret: (cmd, data) => {
        sent.push({ cmd: cmd, data: data });
        if (cmd === C.CMD_MARCH_ARMY_INFO) {
          return Promise.resolve({ code: 0 }).then(() => {
            deliver();
            return { code: 0 };
          });
        }
        if (cmd === C.CMD_BAG_USE) {
          const id = Number(data.info.itemId);
          bag[id] = Math.max(0, (bag[id] || 0) - Number(data.info.itemCount));
          const a = armies.find((x) => x.marchId._low === data.marchId._low) || armies[0];
          a.armyPower = Math.min(a.maxArmyPower, a.armyPower + (HEAL_AMOUNT[id] || 0));
          return Promise.resolve({ code: 0 }).then(() => {
            deliver(); // 游戏回环：治疗成功后弹层自补一条 8584（heal.js 头注 ⑤）
            return { code: 0, data: { ok: 1 } };
          });
        }
        return Promise.resolve({ code: 0 });
      },
    },
    gameConf: { dataConfig: (k) => (k === C.CFG_PAB_HEAL_ITEMS ? '41002|41003' : null) },
    gameData: { myUidStr: () => '111' },
    log: { info: push, debug: push, warn: push, error: push },
  };
  return { env: env, sent: sent, logs: logs, bag: bag, armies: armies, handlers: handlers };
}

/** 微任务全 flush（setImmediate 不被 mock，落在所有 .then 之后）。 */
const flush = () => new Promise((r) => setImmediate(r));

/**
 * 起引擎并跑完首拍；返回逐拍推进器 step(ms)。
 * @param {object} t node:test 上下文（mock timers 随测试自动复位）
 * @param {object} [over] mkRig 选项
 * @returns {Promise<object>} rig + {eng, step}
 */
async function boot(t, over) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const rig = mkRig(over);
  const eng = new HealEngine(rig.env);
  eng.start({ on: { resp: (cmd, fn) => rig.handlers.set(cmd, fn) } });
  const step = async (ms) => {
    t.mock.timers.tick(ms);
    await flush();
  };
  await step(0); // 首拍：预筛放行 → 8584 发出并落地快照
  await flush();
  return Object.assign(rig, { eng: eng, step: step });
}

const uses = (rig) => rig.sent.filter((s) => s.cmd === C.CMD_BAG_USE);
const infos = (rig) => rig.sent.filter((s) => s.cmd === C.CMD_MARCH_ARMY_INFO);

test('H1 默认生效：cfg 无 heal 键，伤员+有药 → 自动 8584→8534（itemCount 恒 1、marchId Int64 对象直传）', async (t) => {
  const rig = await boot(t, { armies: [{ armyPower: 800, maxArmyPower: 1000 }] });
  try {
    await rig.step(C.tuning.healGapMs);
    assert.ok(infos(rig).length >= 1, '默认生效：无需任何面板开关即拉血量快照');
    const u = uses(rig);
    assert.ok(u.length >= 1, '掉血 20% ≥ 10% 阈值 → 用道具');
    assert.equal(u[0].data.info.itemCount, 1, '一拍一件是协议形状，不是配额旋钮');
    assert.equal(typeof u[0].data.marchId, 'object', 'marchId 复用 Int64 对象本体（不 Number 化）');
    assert.equal(u[0].data.marchId._low, 1);
  } finally {
    rig.eng.stop();
  }
});

test('H2 阈值边界：9% 掉血预筛拦下（一个查询包也不发）', async (t) => {
  const rig = await boot(t, { armies: [{ armyPower: 910, maxArmyPower: 1000 }] });
  try {
    await rig.step(C.tuning.healScanMs);
    await rig.step(C.tuning.healScanMs);
    assert.equal(rig.sent.length, 0, '9% < 10%：零成本预筛拦下，8584/8534 都不发');
  } finally {
    rig.eng.stop();
  }
});

test('H2 阈值边界：10% 掉血（ratio=0.9）达阈用药，轻伤优先绷带 41002', async (t) => {
  const rig = await boot(t, { armies: [{ armyPower: 900, maxArmyPower: 1000 }] });
  try {
    await rig.step(C.tuning.healGapMs);
    const u = uses(rig);
    assert.ok(u.length >= 1, 'ratio=0.9 <= 1-0.1 达阈即伤（与预筛逐位同式，浮点边界不误判）');
    assert.equal(u[0].data.info.itemId, C.ITEM_BANDAGE, 'ratio=0.9 非重伤 → 优先绷带');
  } finally {
    rig.eng.stop();
  }
});

test('H3 多拍续用：800/1000 只剩绷带 → 连用 2 件到满血即停（无配额上限，白名单序兜底）', async (t) => {
  const rig = await boot(t, {
    armies: [{ armyPower: 800, maxArmyPower: 1000 }],
    bag: { 41002: 5, 41003: 0 },
  });
  try {
    await rig.step(C.tuning.healGapMs); // 第 1 件 800→900（恰在阈值上仍算伤员）
    assert.equal(uses(rig).length, 1);
    assert.equal(
      uses(rig)[0].data.info.itemId,
      C.ITEM_BANDAGE,
      '重伤首选 41003 缺货 → 落回白名单序',
    );
    await rig.step(C.tuning.healGapMs); // 第 2 件 900→1000
    assert.equal(uses(rig).length, 2, '逐件续拍：用到恢复至阈值以上');
    await rig.step(C.tuning.healScanMs);
    await rig.step(C.tuning.healScanMs);
    assert.equal(uses(rig).length, 2, '快照无伤员 → 长睡不再用药');
  } finally {
    rig.eng.stop();
  }
});

test('H4 背包用光停且 info 留痕：500/1000 重伤只有 1 件绷带 → 用 1 件后停（无药可用）', async (t) => {
  const rig = await boot(t, {
    armies: [{ armyPower: 500, maxArmyPower: 1000 }],
    bag: { 41002: 1, 41003: 0 },
  });
  try {
    await rig.step(C.tuning.healGapMs); // 500→600，绷带用光
    await rig.step(C.tuning.healGapMs); // 仍伤但无药 → 提示一次
    await rig.step(C.tuning.healScanMs);
    assert.equal(uses(rig).length, 1, '用光即停，不逐拍重发');
    assert.ok(
      rig.logs.some((s) => s.includes('not in pab bag')),
      '缺货 info 留痕（dashcam 单轨可辨「真没伤」与「药用完」）',
    );
  } finally {
    rig.eng.stop();
  }
});

test('H5 重伤分档：ratio<0.9 优先 41003 急救箱（白名单两药皆有货）', async (t) => {
  const rig = await boot(t, {
    armies: [{ armyPower: 800, maxArmyPower: 1000 }],
    bag: { 41002: 3, 41003: 3 },
  });
  try {
    await rig.step(C.tuning.healGapMs);
    const u = uses(rig);
    assert.ok(u.length >= 1);
    assert.equal(u[0].data.info.itemId, C.ITEM_MEDKIT, '重伤先烧急救箱（竞品 recuperate 同旨）');
  } finally {
    rig.eng.stop();
  }
});
