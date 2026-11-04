// §9.2/§9.3/§9.4（Phase C3，pickup.js）行为夹具单测：用假 env/ctx 直驱 PickupEngine 的公开入口，
// 断言「发了什么包」而非内部状态——先证后接口径，与 pilot-select 回放测互补（pickup 不在差分回放 harness 覆盖面内）。
// 说明：pickup.js 的 import 链只有 core/util.js + constants.js（零浏览器符号），无需桩化 window/chrome。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PickupEngine } from '../../extension/src/feats/activity/secret-realm/pickup.js';
import {
  CMD_DROP_GET,
  CMD_DROP_INFO,
  CMD_RESOURCE_GET,
  CMD_RESOURCE_INFO,
  PUSH_TILE_INFO,
  PUSH_TEAM_ARRIVE,
  PUSH_DROP_CHANGE,
  PUSH_RESOURCE_CHANGE,
  PAB_DROP,
  PAB_RESOURCE,
  TABLE_RSS_STATION,
  tuning,
} from '../../extension/src/feats/activity/secret-realm/constants.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 构造最小假底座：点位固定在 (10,20)（marchState=ARRIVED、startPoint 在位），teamId 用 >2^53 的 16 位串以覆盖抹零分支。
 * @param {object} over { items, bossList, shopBoxBought, base 覆写 }
 */
function makeHarness(over = {}) {
  const sent = [];
  const state = {
    items: over.items || {},
    bossList: over.bossList || [],
    base: Object.assign(
      {
        teamId: '7700000012345678',
        pointType: PAB_DROP,
        marchState: 2,
        startPoint: { x: 10, y: 20 },
        buffMap: {},
      },
      over.base || {},
    ),
  };
  const stationRows = over.stationRows || {};
  const env = {
    alive: () => true,
    realmActive: () => true,
    cfg: () => ({ pickItems: {}, buffEffects: [], drive: { enabled: true } }),
    gameData: { myUidStr: () => '999' },
    gameConf: { dataConfig: (k) => ({ 3021: 50, 3061: 3, 3013: '10|3' })[k] },
    l10n: {
      tableRow: (table, id) =>
        table === TABLE_RSS_STATION ? stationRows[String(id)] || null : null,
      text: (k) => k,
    },
    log: { info() {}, debug() {}, warn() {} },
    secret: {
      getPabController: () => ({
        roomBaseInfo: state.base,
        getItemNumById: (id) => Number(state.items[id]) || 0,
        checkItemNumMax: () => false,
        isTeamLeader: () => true,
      }),
      getNMarchState: () => ({ ARRIVED: 2, GATHERING: 5 }),
      getBossBaseInfo: () => state.bossList,
      getProtectingPetIds: () => [],
      sendSecret: (cmd, data) => {
        sent.push({ cmd, data });
        // 一律回「业务拒绝但不拉黑流程所需」的形态：记账/断言只看 sent 序列，ret 非 ok 会走 #settle，无碍
        return Promise.resolve({ ok: false, code: 161, reason: '' });
      },
    },
    shopBoxBought: 'shopBoxBought' in over ? over.shopBoxBought : () => null,
  };
  const subs = new Map();
  const ctx = {
    on: {
      push: (cmd, fn) => subs.set(cmd, fn),
      resp: (cmd, fn) => subs.set('resp.' + cmd, fn),
      req: (cmd, fn) => subs.set('req.' + cmd, fn),
    },
  };
  const engine = new PickupEngine(env);
  engine.start(ctx);
  return { engine, sent, subs, state };
}

test('§9.2 约束1：晶块(41009)已超保底 → 掉落箱候选里剔除，香肠(41011)照拾（竞品 ids 消费在 getDropBox/getResItem 侧）', async () => {
  const { subs, sent } = makeHarness({ items: { 41009: 13000, 41010: 0, 41011: 0 } });
  const body = {
    x: 10,
    y: 20,
    dropInfo: [
      { dropId: 'dCrystal', uid: null, info: { itemId: 41009 } },
      { dropId: 'dSausage', uid: null, info: { itemId: 41011 } },
    ],
    dropBeastInfo: [],
    bagGetNum: 0,
    beastGetNum: 0,
  };
  subs.get(PUSH_DROP_CHANGE)({ data: { header: { s: 0 }, data: body } });
  await sleep(tuning.pickupDebounceMs + 900);
  const gets = sent.filter((s) => s.cmd === CMD_DROP_GET).map((s) => s.data.rId);
  assert.deepEqual(gets, ['dSausage'], 'reserve=12000：13000>12000 应剔晶块，只剩香肠一笔 8533');
});

test('§9.2 约束2：刷新币(41010)+香肠 >= 目标10 → 资源点候选里剔除 41010，普通道具照采；清台([0].state=30) 同剔', async () => {
  const h = makeHarness({
    items: { 41009: 0, 41010: 10, 41011: 0 },
    base: { pointType: PAB_RESOURCE },
    stationRows: { 1001: { item: 41010 }, 1002: { item: 41001 } },
  });
  const body = {
    x: 10,
    y: 20,
    bagInfo: [
      { dropId: 'dRefresh', specId: 1001, uid: null },
      { dropId: 'dScout', specId: 1002, uid: null },
    ],
    buffInfo: [],
    bagGetNum: 0,
    buffGetNum: 0,
  };
  h.subs.get(PUSH_RESOURCE_CHANGE)({ data: { header: { s: 0 }, data: body } });
  await sleep(tuning.pickupDebounceMs + 900);
  const gets = h.sent.filter((s) => s.cmd === CMD_RESOURCE_GET).map((s) => s.data.rId);
  assert.deepEqual(gets, ['dScout'], '10+0>=10 应剔刷新币，只发 41001 一笔 8527');
});

test('§9.4 归属闸+去重：非本队/没货不拉；本队在位点只拉一发 8532；重复 10018 不再拉（drop_list 等价窗）', async () => {
  const { subs, sent } = makeHarness({ items: {} });
  const tileEv = (teamId, iNum) => ({
    data: { pointInfos: [{ pointType: PAB_DROP, x: 10, y: 20, m: { teamId, iNum } }] },
  });
  subs.get(PUSH_TILE_INFO)(tileEv('8899001122334455', 3)); // 别人的箱 → 不拉
  subs.get(PUSH_TILE_INFO)(tileEv('7700000012345678', 0)); // 本队但 iNum=0 → 不拉
  subs.get(PUSH_TILE_INFO)(tileEv('7700000012345678', 2)); // 本队有货 → 拉一发
  subs.get(PUSH_TILE_INFO)(tileEv('7700000012345678', 2)); // 去重窗内重复 → 不再拉
  const infos = sent.filter((s) => s.cmd === CMD_DROP_INFO);
  assert.equal(infos.length, 1, '只允许一发主动 8532');
  assert.deepEqual(infos[0].data, { x: 10, y: 20 });
});

test('§9.4 A1 口径：m.teamId 是被抹零的 number(17 位) 时归属闸仍成立（Number 双比兜底）', async () => {
  const { subs, sent } = makeHarness({ items: {} });
  subs.get(PUSH_TILE_INFO)({
    data: {
      pointInfos: [
        { pointType: PAB_DROP, x: 10, y: 20, m: { teamId: Number('7700000012345678'), iNum: 1 } },
      ],
    },
  });
  assert.equal(sent.filter((s) => s.cmd === CMD_DROP_INFO).length, 1);
});

test('§9.3 到点自愈：21529 到 173 → 延迟复核后自补一发 8526；静默窗内二次到点不重发', async () => {
  const { subs, sent } = makeHarness({ items: {}, base: { pointType: PAB_RESOURCE } });
  subs.get(PUSH_TEAM_ARRIVE)({});
  await sleep(tuning.pickupDebounceMs * 2 + 100);
  assert.equal(sent.filter((s) => s.cmd === CMD_RESOURCE_INFO).length, 1, '到点应补拉一发 8526');
  subs.get(PUSH_TEAM_ARRIVE)({});
  await sleep(tuning.pickupDebounceMs * 2 + 100);
  assert.equal(
    sent.filter((s) => s.cmd === CMD_RESOURCE_INFO).length,
    1,
    'selfFetchTtlMs 静默窗内不重发',
  );
});
