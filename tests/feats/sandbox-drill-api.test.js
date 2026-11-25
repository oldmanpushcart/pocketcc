// 沙盘真实 UI ACL：只验证战斗类型/真实军队/陷阱闸与准备页关闭，不构造或发送挑战协议。
import { test, beforeEach, afterEach } from 'node:test';
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

const { game } = await import('../../extension/src/core/game.js');
const { sandboxArena } = await import('../../extension/src/feats/player/sandbox-drill/api.js');

const realGameGet = game.get;
const realCc = globalThis.cc;
const ARENA = 77;
let mods;
let model;
let cur;
let mgr;
let starts;
let closes;

beforeEach(() => {
  starts = 0;
  closes = [];
  model = { attackers: [{}], attackerTraps: [] };
  cur = { Type: ARENA, otherData: { challenge: 0 } };
  mgr = {
    DataPool: {
      NBattleMain: { _components: [{ StartFight: () => starts++ }] },
      BattleMainPanel: { _components: [] },
    },
    CloseUI: (desc) => closes.push(desc),
  };
  mods = {
    BattleData: { BattleType: { ARENA_PVE_BATTLE: ARENA } },
    DataCenter: { DATA: { CurBattleData: cur } },
    NBattleModel: { instance: model },
    UIManager: { Instance: () => mgr },
    UIDataInfo: { UIDataInfo: { BattleMainPanel: { name: 'BattleMainPanel' } } },
  };
  game.get = (name) => mods[name] || null;
  globalThis.cc = {
    Event: {
      EventTouch: class {
        constructor(points, changed) {
          this.points = points;
          this.changed = changed;
        }
      },
    },
  };
});

afterEach(() => {
  game.get = realGameGet;
  globalThis.cc = realCc;
});

test('真实 ARENA_PVE_BATTLE + attackers + 无陷阱：调用原生 StartFight', () => {
  assert.deepEqual(sandboxArena.start(), { ok: true });
  assert.equal(starts, 1);
});

test('陷阱状态缺失或存在陷阱：不代替用户确认，不调用 StartFight', () => {
  delete model.attackerTraps;
  assert.deepEqual(sandboxArena.start(), { ok: false, reason: 'trap-state-unavailable' });
  model.attackerTraps = [{}];
  assert.deepEqual(sandboxArena.start(), { ok: false, reason: 'trap-confirmation-required' });
  assert.equal(starts, 0);
});

test('真实军队为空/无尽挑战/其他战斗：拒绝发起', () => {
  model.attackers = [];
  assert.deepEqual(sandboxArena.start(), { ok: false, reason: 'real-attackers-unavailable' });
  model.attackers = [{}];
  cur.otherData.challenge = 1;
  assert.deepEqual(sandboxArena.start(), { ok: false, reason: 'endless-challenge-refused' });
  cur.otherData.challenge = 0;
  cur.Type = 78;
  assert.deepEqual(sandboxArena.start(), { ok: false, reason: 'not-arena-pve-battle' });
  assert.equal(starts, 0);
});

test('closePreparation 只关闭当前沙盘准备页', () => {
  assert.deepEqual(sandboxArena.closePreparation(), { ok: true });
  assert.deepEqual(closes, [{ name: 'BattleMainPanel' }]);
  cur.Type = 78;
  assert.deepEqual(sandboxArena.closePreparation(), { ok: false, reason: 'not-arena-pve-battle' });
  assert.equal(closes.length, 1);
});
