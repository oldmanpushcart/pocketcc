// 超值活动一键领取离线回归：不连接服务器，锁定通用积分档/联盟 BP 的请求外形与重查闭环。
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = globalThis.window || {
  addEventListener() {},
  removeEventListener() {},
  location: { href: '', reload() {} },
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

const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (fn, ms, ...rest) => {
  const h = realSetInterval(fn, ms, ...rest);
  if (h && typeof h.unref === 'function') h.unref();
  return h;
};

const { gameData } = await import('../../extension/src/core/game-api.js');
const { MENU, collectFeatureIds } = await import('../../extension/src/core/menu.js');
const { reactor } = await import('../../extension/src/core/reactor.js');
const gift = await import('../../extension/src/feats/activity/super-value-gift/index.js');
const model = await import('../../extension/src/feats/activity/super-value-gift/model.js');
const { CODE_NOT_SENT } = await import('../../extension/src/core/util.js');

const NOW = 1794585600 + 300;
const orig = { serverTime: gameData.serverTime, inAlliance: gameData.inAlliance };

let now;
let alive;
let inAlliance;
let roundController;
let activities;
let sent;
let respond;
let onSend;

function ret(data, code = 0) {
  return { ok: code === 0, code, data, reason: code === 0 ? null : 'test rejection' };
}

function activity(id, overrides = {}) {
  return {
    id,
    showUiType: 'ActivityBakingMaster',
    begintime: NOW - 100,
    endtime: NOW + 1000,
    point: [],
    task: [],
    atarget: [],
    extra: {},
    adv: 0,
    super_adv: 0,
    ...overrides,
  };
}

function tier(pt, type = 0) {
  return { pt, type };
}

/** 执行一个专用领取用例，并锁定 841 → 专用协议 → 3103 的闭环与请求外形。 */
async function assertSpecialClaim(a, cmd, protocol, body, mutate) {
  activities = [a];
  respond = (requestCmd) => {
    if (requestCmd === 841) return ret({ alist: structuredClone(activities) });
    if (requestCmd === cmd) {
      mutate(a);
      return ret({});
    }
    if (requestCmd === 3103) return ret(structuredClone(a));
    return ret({});
  };
  assert.equal(await gift.cycleRun(), 1000);
  assert.deepEqual(sent, [
    { cmd: 841, data: {}, protocol: 'send', gate: false },
    { cmd, data: body, protocol, gate: undefined },
    { cmd: 3103, data: { id: String(a.id) }, protocol: 'send', gate: false },
  ]);
}

const fakeNet = {
  install: () => true,
  isSending: () => false,
  sendGuarded: async (cmd, data, opts) => {
    sent.push({ cmd, data, protocol: opts && opts.protocol, gate: opts && opts.gate });
    if (onSend) onSend(cmd, data);
    return respond(cmd, data);
  },
};
const fakeCtx = {
  alive: () => alive,
  get signal() {
    return roundController ? roundController.signal : null;
  },
  net: fakeNet,
  on: { push() {} },
};
gift.installForTest(fakeCtx);

beforeEach(() => {
  gameData.serverTime = () => now;
  gameData.inAlliance = () => inAlliance;
  now = NOW;
  alive = true;
  inAlliance = null;
  roundController = new AbortController();
  activities = [];
  sent = [];
  onSend = null;
  respond = (cmd, data) => {
    if (cmd === 841) return ret({ alist: structuredClone(activities) });
    if (cmd === 3103) {
      const found = activities.find((item) => String(item.id) === String(data.id));
      return ret(found ? structuredClone(found) : {});
    }
    return ret({});
  };
  gift.resetForTest();
});

afterEach(() => {
  gameData.serverTime = orig.serverTime;
  gameData.inAlliance = orig.inAlliance;
});

test('面板集成：默认关闭并挂入活动基础设置', () => {
  const ids = new Set(collectFeatureIds({ children: MENU }));
  const spec = reactor.list().find((item) => item.id === 'superValueGift');
  assert.ok(ids.has('superValueGift'));
  assert.ok(spec);
  assert.equal(spec.defaults.enabled, false);
  assert.equal(spec.offInCombat, false);
  assert.deepEqual(spec.toModuleCfg({ enabled: true }), { enabled: true });
});

test('活动开放窗口严格使用 begintime < now < endtime', () => {
  const a = activity('1');
  assert.equal(model.isActivityOpen(a, a.begintime), false);
  assert.equal(model.isActivityOpen(a, a.endtime), false);
  assert.equal(model.isActivityOpen(a, NOW), true);
  assert.equal(model.isActivityOpen(activity('', {}), NOW), false);
  assert.equal(model.isActivityOpen(activity('1', { endtime: 'bad' }), NOW), false);
  for (const id of [null, '', '   ', true, false, [], {}, -1, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(model.isActivityOpen(activity(id), NOW), false);
  }
  assert.equal(model.isActivityOpen(activity(0), NOW), true);
  for (const begintime of [null, '', false, [], {}]) {
    assert.equal(model.isActivityOpen(activity('1', { begintime }), NOW), false);
  }
  assert.equal(model.isActivityOpen(a, null), false);
});

test('积分档只取已达成分数且未领取的普通档', () => {
  const a = activity('1', {
    point: [tier(10), tier(20), tier(30, 1), tier(40, 6)],
    extra: { sc: 20, rp: [10], rap: [], receive_super_adv_point: [] },
  });
  assert.deepEqual(model.claimableScoreTiers(a), [20]);
  a.extra.rp = ['10', '20'];
  assert.deepEqual(model.claimableScoreTiers(a), []);
});

test('高级与超级高级档仅在已解锁后领取，type 6 按超级档处理', () => {
  const a = activity('1', {
    point: [tier(10, 1), tier(20, 2), tier(30, 6)],
    extra: { sc: 30, rp: [], rap: ['10'], receive_super_adv_point: [20] },
    adv: 1,
    super_adv: 1,
  });
  assert.deepEqual(model.claimableScoreTiers(a), [30]);
  a.super_adv = 0;
  assert.deepEqual(model.claimableScoreTiers(a), []);
});

test('联盟 BP 积分档在明确退盟时跳过，未知联盟态沿用 ACL 放行', () => {
  const a = activity('1', {
    showUiType: 'ActivityAllianceBP',
    point: [tier(10)],
    extra: { sc: 10 },
  });
  assert.deepEqual(model.claimableScoreTiers(a, true), [10]);
  assert.deepEqual(model.claimableScoreTiers(a, null), [10]);
  assert.deepEqual(model.claimableScoreTiers(a, false), []);
});

test('积分档拒绝布尔分数、畸形领取列表与缺失类型', () => {
  const a = activity('1', { point: [tier(10)], extra: { sc: 10 } });
  a.extra.sc = true;
  assert.deepEqual(model.claimableScoreTiers(a), []);
  a.extra.sc = 10;
  a.extra.rp = '10';
  assert.deepEqual(model.claimableScoreTiers(a), []);
  delete a.extra.rp;
  delete a.point[0].type;
  assert.deepEqual(model.claimableScoreTiers(a), []);
});

test('未知积分档类型保守跳过，重复 pt 去重', () => {
  const a = activity('1', {
    point: [tier(10, 3), tier(20, 4), tier(30, 5), tier(40), tier(40)],
    extra: { sc: 40 },
  });
  assert.deepEqual(model.claimableScoreTiers(a), [40]);
});

test('联盟 BP 只返回 state=1 任务 ID，Int64 按字符串且去重', () => {
  const a = activity('9007199254740993', {
    showUiType: 'ActivityAllianceBP',
    task: [
      { id: '9007199254740993', state: 1 },
      { id: 2, state: 1 },
      { id: '9007199254740993', state: 1 },
      { id: 3, state: 0 },
      { id: 4, state: 2 },
    ],
  });
  assert.deepEqual(model.claimableAllianceTaskIds(a, true), ['9007199254740993', '2']);
  assert.deepEqual(model.claimableAllianceTaskTargets(a, true), ['9007199254740993', 2]);
  assert.deepEqual(model.claimableAllianceTaskIds(a, null), ['9007199254740993', '2']);
  assert.deepEqual(model.claimableAllianceTaskIds(a, false), []);
  a.showUiType = 'ActivityBakingMaster';
  assert.deepEqual(model.claimableAllianceTaskIds(a), []);
});

test('通用任务投影覆盖任意分支，只取已完成任务并排除联盟 BP 批量入口', () => {
  const a = activity('9007199254740993', {
    showUiType: 'unlisted_branch_UI',
    task: [
      { id: '9007199254740993', state: 1 },
      { id: 2, state: '1' },
      { id: '9007199254740993', state: 1 },
      { id: 3, state: 0 },
      { id: 4, state: 2 },
      { id: '', state: 1 },
      { id: '   ', state: 1 },
      { id: true, state: 1 },
      { id: null, state: 1 },
      { id: {}, state: 1 },
      { id: 5, state: true },
      { id: 6, state: 1.5 },
      { id: -1, state: 1 },
      { id: Number.MAX_SAFE_INTEGER + 1, state: 1 },
    ],
  });
  assert.deepEqual(model.claimableTaskIds(a), ['9007199254740993', '2']);
  assert.deepEqual(model.claimableTaskTargets(a, 'task'), ['9007199254740993', 2]);
  assert.deepEqual(model.claimableGenericTaskIds(a), ['9007199254740993', '2']);
  assert.deepEqual(model.claimableGenericTaskTargets(a), ['9007199254740993', 2]);
  assert.deepEqual(model.claimableAllianceTaskIds(a, true), []);
  a.showUiType = 'ActivityAllianceBP';
  assert.deepEqual(model.claimableTaskIds(a), ['9007199254740993', '2']);
  assert.deepEqual(model.claimableGenericTaskIds(a), []);
  assert.deepEqual(model.claimableAllianceTaskIds(a, true), ['9007199254740993', '2']);
  a.task = {};
  assert.deepEqual(model.claimableGenericTaskIds(a), []);
});

test('通用任务合并旧版 atarget 与新版 task，保留原始 ID 类型并按字符串键去重', () => {
  const a = activity('101', {
    task: [
      { id: 11, state: 1 },
      { id: '9007199254740993', state: 1 },
    ],
    atarget: [
      { id: '11', state: 1 },
      { id: 12, state: 1 },
      { id: 13, state: 0 },
      { id: 14, state: 2 },
    ],
  });
  assert.deepEqual(model.claimableGenericTaskTargets(a), [11, '9007199254740993', 12]);
  assert.deepEqual(model.claimableGenericTaskIds(a), ['11', '9007199254740993', '12']);
  a.showUiType = 'ActivityAllianceBP';
  assert.deepEqual(model.claimableGenericTaskTargets(a), []);
  a.atarget = {};
  assert.deepEqual(model.claimableGenericTaskTargets(a), []);
});

test('应急背包只领合法未领项，按 3135 全部领取且保留 Int64 精度', () => {
  const a = activity('9007199254740993', {
    showUiType: 'activity_center_UI',
    extra: {
      0: { rewarded: false },
      1: { rewarded: true },
      2: { rewarded: 0 },
      3: {},
      metadata: { rewarded: false },
      bad: 'not-a-reward',
    },
  });
  assert.deepEqual(model.claimableSpecialRewards(a), [
    {
      key: 3135,
      cmd: 3135,
      protocol: 'send',
      body: { rewardCenterAid: '9007199254740993', rewardAid: -1 },
    },
  ]);
  a.extra[0].rewarded = true;
  a.extra[2].rewarded = true;
  assert.deepEqual(model.claimableSpecialRewards(a), []);
  a.extra = [];
  assert.deepEqual(model.claimableSpecialRewards(a), []);
});

test('弹珠循环奖励严格校验积分、联盟门槛、步长与领取上限', () => {
  const a = activity('301', {
    showUiType: 'ActivityPinballGame_NY',
    type_para9: '10|20|unused|3',
    extra: {
      score: 10,
      a_score: 140,
      has_receive_loop_num: 1,
      task_info: [{ t_a_score: 60 }, { t_a_score: 100 }],
    },
  });
  const expected = [
    {
      key: 4790,
      cmd: 4790,
      protocol: 'sendPB',
      body: {
        header: {},
        pinBallActivityGetScoreReward: { activityId: '301', index: -1 },
      },
    },
  ];
  assert.deepEqual(model.claimableSpecialRewards(a, true), expected);
  assert.deepEqual(model.claimableSpecialRewards(a, null), expected);
  assert.deepEqual(model.claimableSpecialRewards(a, false), []);
  a.extra.score = 9;
  assert.deepEqual(model.claimableSpecialRewards(a), []);
  a.extra.score = 10;
  a.extra.a_score = 99;
  assert.deepEqual(model.claimableSpecialRewards(a), []);
  a.extra.a_score = 140;
  a.extra.has_receive_loop_num = 3;
  assert.deepEqual(model.claimableSpecialRewards(a), []);
  a.extra.has_receive_loop_num = 1;
  a.type_para9 = '10|0|unused|3';
  assert.deepEqual(model.claimableSpecialRewards(a), []);
  a.type_para9 = '';
  assert.deepEqual(model.claimableSpecialRewards(a), []);
  a.type_para9 = ['10|20|unused|3'];
  assert.deepEqual(model.claimableSpecialRewards(a), []);
  a.type_para9 = '10|20|unused|3';
  a.extra.has_receive_loop_num = true;
  assert.deepEqual(model.claimableSpecialRewards(a), []);
  a.extra.has_receive_loop_num = -1;
  assert.deepEqual(model.claimableSpecialRewards(a), []);
});

test('大富翁循环奖励要求联盟、仍有可领轮次、伤害达标且未达领取上限', () => {
  const a = activity('401', {
    showUiType: 'adventure_richman_UI',
    type_para9: '100',
    act_paras: { bullet_boss_reward_limit: '10|reward|3' },
    extra: { a_boss_weak_times: 3, a_reward_num: 1, a_boss_damage: 100 },
  });
  const expected = [
    { key: 8768, cmd: 8768, protocol: 'sendPBV2', body: { activityId: '401', index: -1 } },
  ];
  assert.deepEqual(model.claimableSpecialRewards(a, true), expected);
  assert.deepEqual(model.claimableSpecialRewards(a, null), expected);
  assert.deepEqual(model.claimableSpecialRewards(a, false), []);
  a.extra.a_boss_damage = 99;
  assert.deepEqual(model.claimableSpecialRewards(a), []);
  a.extra.a_boss_damage = 100;
  a.extra.a_boss_weak_times = 2;
  assert.deepEqual(model.claimableSpecialRewards(a), []);
  a.extra.a_boss_weak_times = 5;
  a.extra.a_reward_num = 3;
  assert.deepEqual(model.claimableSpecialRewards(a), []);
  a.extra.a_reward_num = true;
  assert.deepEqual(model.claimableSpecialRewards(a), []);
  a.extra.a_reward_num = -1;
  assert.deepEqual(model.claimableSpecialRewards(a), []);
  a.extra.a_reward_num = 1;
  delete a.type_para9;
  assert.deepEqual(model.claimableSpecialRewards(a), []);
  a.type_para9 = '100';
  delete a.act_paras;
  assert.deepEqual(model.claimableSpecialRewards(a), []);
  a.act_paras = { bullet_boss_reward_limit: ['10|reward|3'] };
  assert.deepEqual(model.claimableSpecialRewards(a), []);
});

test('联盟远征循环奖励要求组队、越过末档且存在未领步数', () => {
  const a = activity('501', {
    showUiType: 'teamExpedition',
    para6: '10|20',
    type_para10: '5|reward',
    extra: { haveTeam: true, teamScore: 31, overRewardNum: 1 },
  });
  assert.deepEqual(model.claimableSpecialRewards(a), [
    { key: 8795, cmd: 8795, protocol: 'sendPBV2', body: { activityId: '501', index: -1 } },
  ]);
  a.extra.haveTeam = false;
  assert.deepEqual(model.claimableSpecialRewards(a), []);
  a.extra.haveTeam = true;
  a.extra.teamScore = 20;
  assert.deepEqual(model.claimableSpecialRewards(a), []);
  a.extra.teamScore = 31;
  a.extra.overRewardNum = 2;
  assert.deepEqual(model.claimableSpecialRewards(a), []);
  a.extra.overRewardNum = 1;
  a.type_para10 = '0|reward';
  assert.deepEqual(model.claimableSpecialRewards(a), []);
});

test('舞狮循环奖励按末档阈值、边际步数与上限判定', () => {
  const a = activity('601', {
    showUiType: 'ActivityNewYear_WS',
    type_para9: '10,1|20,2',
    type_para10: '5,reward,3',
    extra: { fireScore: 25, fireOverNum: 0 },
  });
  assert.deepEqual(model.claimableSpecialRewards(a), [
    { key: 8833, cmd: 8833, protocol: 'sendPBV2', body: { activityId: '601', index: -1 } },
  ]);
  a.extra.fireScore = 24;
  assert.deepEqual(model.claimableSpecialRewards(a), []);
  a.extra.fireScore = 25;
  a.extra.fireOverNum = 3;
  assert.deepEqual(model.claimableSpecialRewards(a), []);
  a.extra.fireOverNum = 0;
  a.type_para10 = '5,reward,bad';
  assert.deepEqual(model.claimableSpecialRewards(a), []);
});

test('未知或依赖道具的专用视图不生成任何领取计划', () => {
  const a = activity('701', {
    showUiType: 'ActivityDwarfMine',
    extra: { speed_item: 10, rewarded: false },
  });
  assert.deepEqual(model.claimableSpecialRewards(a), []);
});

test('3135 按真实按钮形态领取，3103 确认全部完成后不再发送', async () => {
  const a = activity('9007199254740993', {
    showUiType: 'activity_center_UI',
    extra: { 0: { rewarded: false }, 1: { rewarded: false } },
  });
  await assertSpecialClaim(
    a,
    3135,
    'send',
    { rewardCenterAid: '9007199254740993', rewardAid: -1 },
    (item) => {
      item.extra[0].rewarded = true;
      item.extra[1].rewarded = true;
    },
  );
  sent = [];
  await gift.cycleRun();
  assert.deepEqual(
    sent.map((entry) => entry.cmd),
    [841],
  );
});

test('4790 使用 V1 PB 嵌套请求领取弹珠循环奖励并重查', async () => {
  const a = activity('301', {
    showUiType: 'ActivityPinballGame_NY',
    type_para9: '10|20|unused|3',
    extra: {
      score: 10,
      a_score: 140,
      has_receive_loop_num: 1,
      task_info: [{ t_a_score: 100 }],
    },
  });
  await assertSpecialClaim(
    a,
    4790,
    'sendPB',
    { header: {}, pinBallActivityGetScoreReward: { activityId: '301', index: -1 } },
    (item) => item.extra.has_receive_loop_num++,
  );
});

test('8768 使用 V2 PB 领取大富翁循环奖励并重查', async () => {
  const a = activity('401', {
    showUiType: 'adventure_richman_UI',
    type_para9: '100',
    act_paras: { bullet_boss_reward_limit: '10|reward|3' },
    extra: { a_boss_weak_times: 3, a_reward_num: 1, a_boss_damage: 100 },
  });
  await assertSpecialClaim(a, 8768, 'sendPBV2', { activityId: '401', index: -1 }, (item) => {
    item.extra.a_reward_num++;
  });
});

test('8795 使用 V2 PB 领取联盟远征循环奖励并重查', async () => {
  const a = activity('501', {
    showUiType: 'teamExpedition',
    para6: '10|20',
    type_para10: '5|reward',
    extra: { haveTeam: true, teamScore: 31, overRewardNum: 1 },
  });
  await assertSpecialClaim(a, 8795, 'sendPBV2', { activityId: '501', index: -1 }, (item) => {
    item.extra.overRewardNum++;
  });
});

test('8833 使用 V2 PB 领取舞狮循环奖励并重查', async () => {
  const a = activity('601', {
    showUiType: 'ActivityNewYear_WS',
    type_para9: '10,1|20,2',
    type_para10: '5,reward,3',
    extra: { fireScore: 25, fireOverNum: 0 },
  });
  await assertSpecialClaim(a, 8833, 'sendPBV2', { activityId: '601', index: -1 }, (item) => {
    item.extra.fireOverNum++;
  });
});

test('专用领取成功但 3103 无进展时按 20/40 秒退避，不把回执当领完', async () => {
  const a = activity('701', {
    showUiType: 'activity_center_UI',
    extra: { 0: { rewarded: false } },
  });
  activities = [a];
  assert.equal(await gift.cycleRun(), 20 * 1000);
  assert.deepEqual(
    sent.map((entry) => entry.cmd),
    [841, 3135, 3103],
  );
  sent = [];
  now += 21;
  assert.equal(await gift.cycleRun(), 20 * 1000);
  assert.deepEqual(
    sent.map((entry) => entry.cmd),
    [841, 3135, 3103],
  );
  sent = [];
  now += 21;
  assert.equal(await gift.cycleRun(), 20 * 1000);
  assert.deepEqual(
    sent.map((entry) => entry.cmd),
    [841],
  );
});

test('专用领取 CODE_NOT_SENT 不重查且停止本轮后续活动', async () => {
  activities = [
    activity('701', { showUiType: 'activity_center_UI', extra: { 0: { rewarded: false } } }),
    activity('702', { showUiType: 'activity_center_UI', extra: { 0: { rewarded: false } } }),
  ];
  respond = (cmd) =>
    cmd === 841 ? ret({ alist: activities }) : cmd === 3135 ? ret(null, CODE_NOT_SENT) : ret({});
  assert.equal(await gift.cycleRun(), 20 * 1000);
  assert.deepEqual(
    sent.map((entry) => entry.cmd),
    [841, 3135],
  );
});

test('无待领、未开放或畸形活动时不发领取请求', async () => {
  activities = [
    activity('closed', { endtime: NOW - 1, point: [tier(1)], extra: { sc: 1 } }),
    activity('future', { begintime: NOW + 1, point: [tier(1)], extra: { sc: 1 } }),
    activity('empty'),
    activity('claimed', { point: [tier(1)], extra: { sc: 1, rp: [1] } }),
    activity(true, { point: [tier(1)], extra: { sc: 1 } }),
    activity({}, { point: [tier(1)], extra: { sc: 1 } }),
    activity(-1, { point: [tier(1)], extra: { sc: 1 } }),
    activity(Number.MAX_SAFE_INTEGER + 1, { point: [tier(1)], extra: { sc: 1 } }),
  ];
  assert.equal(await gift.cycleRun(), 30 * 1000);
  assert.deepEqual(sent, [{ cmd: 841, data: {}, protocol: 'send', gate: false }]);
});

test('普通积分档按 1777/{id} 领取，并用 3103 重查确认后不重复', async () => {
  const a = activity('101', { point: [tier(10), tier(20)], extra: { sc: 10 } });
  activities = [a];
  respond = (cmd) => {
    if (cmd === 841) return ret({ alist: structuredClone(activities) });
    if (cmd === 1777) {
      a.extra.rp = [10];
      return ret({ rewards: ['item'] });
    }
    if (cmd === 3103) return ret(structuredClone(a));
    return ret({});
  };
  assert.equal(await gift.cycleRun(), 1000);
  assert.deepEqual(sent, [
    { cmd: 841, data: {}, protocol: 'send', gate: false },
    { cmd: 1777, data: { id: '101' }, protocol: 'send', gate: undefined },
    { cmd: 3103, data: { id: '101' }, protocol: 'send', gate: false },
  ]);
  sent = [];
  assert.equal(await gift.cycleRun(), 30 * 1000);
  assert.deepEqual(
    sent.map((item) => item.cmd),
    [841],
  );
});

test('1777 成功但重查仍有可领档时不当场连发，20 秒后重新扫描', async () => {
  activities = [activity('101', { point: [tier(10)], extra: { sc: 10 } })];
  assert.equal(await gift.cycleRun(), 20 * 1000);
  assert.deepEqual(
    sent.map((item) => item.cmd),
    [841, 1777, 3103],
  );
  sent = [];
  now += 21;
  assert.equal(await gift.cycleRun(), 20 * 1000);
  assert.deepEqual(
    sent.map((item) => item.cmd),
    [841, 1777, 3103],
  );
});

test('3103 确认部分领取后下一轮只继续领取剩余档位', async () => {
  const a = activity('101', { point: [tier(10), tier(20)], extra: { sc: 20 } });
  activities = [a];
  respond = (cmd) => {
    if (cmd === 841) return ret({ alist: structuredClone(activities) });
    if (cmd === 1777) {
      a.extra.rp = [10];
      return ret({});
    }
    if (cmd === 3103) return ret(structuredClone(a));
    return ret({});
  };
  await gift.cycleRun();
  sent = [];
  now += 21;
  await gift.cycleRun();
  assert.deepEqual(
    sent.map((item) => item.cmd),
    [841, 1777, 3103],
  );
  assert.equal(sent.filter((item) => item.cmd === 1777).length, 1);
});

test('841/3103 兼容 JSON 字符串应答，活动 ID 保持字符串精度', async () => {
  const id = '9007199254740993';
  const a = activity(id, { point: [tier(1)], extra: { sc: 1 } });
  activities = [a];
  respond = (cmd) => {
    if (cmd === 841) return ret(JSON.stringify({ alist: [a] }));
    if (cmd === 1777) {
      a.extra.rp = [1];
      return ret(JSON.stringify({ rewards: [] }));
    }
    if (cmd === 3103) return ret(JSON.stringify(a));
    return ret({});
  };
  await gift.cycleRun();
  assert.deepEqual(sent.find((item) => item.cmd === 1777).data, { id });
  assert.deepEqual(sent.find((item) => item.cmd === 3103).data, { id });
});

test('841 缺少 alist 时告警退避，不把空成功误当无可领', async () => {
  respond = () => ret({});
  assert.equal(await gift.cycleRun(), 20 * 1000);
  assert.deepEqual(
    sent.map((item) => item.cmd),
    [841],
  );
});

test('841 CODE_NOT_SENT 短重试且不发送领取', async () => {
  respond = () => ret(null, CODE_NOT_SENT);
  assert.equal(await gift.cycleRun(), 20 * 1000);
  assert.deepEqual(
    sent.map((item) => item.cmd),
    [841],
  );
});

test('1777 CODE_NOT_SENT 停止本轮后续活动，不伪标成功', async () => {
  activities = [
    activity('1', { point: [tier(1)], extra: { sc: 1 } }),
    activity('2', { point: [tier(1)], extra: { sc: 1 } }),
  ];
  respond = (cmd) => (cmd === 1777 ? ret(null, CODE_NOT_SENT) : ret({ alist: activities }));
  assert.equal(await gift.cycleRun(), 20 * 1000);
  assert.deepEqual(
    sent.map((item) => item.cmd),
    [841, 1777],
  );
});

test('单个活动业务拒绝不阻断其它活动，且拒绝活动不做 3103', async () => {
  activities = [
    activity('1', { point: [tier(1)], extra: { sc: 1 } }),
    activity('2', { point: [tier(1)], extra: { sc: 1 } }),
  ];
  respond = (cmd, data) => {
    if (cmd === 841) return ret({ alist: activities });
    if (cmd === 1777) return data.id === '1' ? ret(null, 2001) : ret({});
    if (cmd === 3103) {
      const a = activities.find((item) => item.id === data.id);
      a.extra.rp = [1];
      return ret(a);
    }
    return ret({});
  };
  assert.equal(await gift.cycleRun(), 1000);
  assert.deepEqual(
    sent.map((item) => [item.cmd, item.data.id]),
    [
      [841, undefined],
      [1777, '1'],
      [1777, '2'],
      [3103, '2'],
    ],
  );
});

test('3103 返回错误活动 ID 时不继续该活动任务领取', async () => {
  activities = [
    activity('1', {
      showUiType: 'ActivityAllianceBP',
      point: [tier(1)],
      task: [{ id: 't1', state: 1 }],
      extra: { sc: 1 },
    }),
  ];
  respond = (cmd) => {
    if (cmd === 841) return ret({ alist: activities });
    if (cmd === 3103) return ret(activity('wrong'));
    return ret({});
  };
  assert.equal(await gift.cycleRun(), 20 * 1000);
  assert.deepEqual(
    sent.map((item) => item.cmd),
    [841, 1777, 3103],
  );
});

test('1777 重查显示活动已关闭时不再发送联盟 BP 领取', async () => {
  const a = activity('201', {
    showUiType: 'ActivityAllianceBP',
    point: [tier(1)],
    task: [{ id: 't1', state: 1 }],
    extra: { sc: 1 },
  });
  activities = [a];
  respond = (cmd) => {
    if (cmd === 841) return ret({ alist: activities });
    if (cmd === 1777) {
      a.extra.rp = [1];
      a.endtime = NOW - 1;
      return ret({});
    }
    if (cmd === 3103) return ret(a);
    return ret({});
  };
  await gift.cycleRun();
  assert.deepEqual(
    sent.map((entry) => entry.cmd),
    [841, 1777, 3103],
  );
});

test('任意分支的 task-only 活动按 842/{aid,tid} 领取并重查，不依赖 showUiType 白名单', async () => {
  const a = activity('9007199254740993', {
    showUiType: 'unlisted_branch_UI',
    task: [{ id: '9007199254740993', state: 1 }],
  });
  activities = [a];
  respond = (cmd, data) => {
    if (cmd === 841) return ret({ alist: structuredClone(activities) });
    if (cmd === 842) {
      assert.deepEqual(data, { aid: '9007199254740993', tid: '9007199254740993' });
      a.task[0].state = 2;
      return ret({ reward: [] });
    }
    if (cmd === 3103) return ret(structuredClone(a));
    return ret({});
  };
  assert.equal(await gift.cycleRun(), 1000);
  assert.deepEqual(sent, [
    { cmd: 841, data: {}, protocol: 'send', gate: false },
    {
      cmd: 842,
      data: { aid: '9007199254740993', tid: '9007199254740993' },
      protocol: 'send',
      gate: undefined,
    },
    { cmd: 3103, data: { id: '9007199254740993' }, protocol: 'send', gate: false },
  ]);
  sent = [];
  assert.equal(await gift.cycleRun(), 30 * 1000);
  assert.deepEqual(
    sent.map((item) => item.cmd),
    [841],
  );
});

test('842 保留快照中的数字 aid/tid，避免数字 ID 转字符串触发参数错误', async () => {
  const a = activity(101, { task: [{ id: 9001, state: 1 }] });
  activities = [a];
  respond = (cmd, data) => {
    if (cmd === 841) return ret({ alist: structuredClone(activities) });
    if (cmd === 842) {
      if (typeof data.aid !== 'number' || typeof data.tid !== 'number') return ret(null, 1001);
      assert.deepEqual(data, { aid: 101, tid: 9001 });
      a.task[0].state = 2;
      return ret({});
    }
    if (cmd === 3103) return ret(structuredClone(a));
    return ret({});
  };
  assert.equal(await gift.cycleRun(), 1000);
  assert.deepEqual(sent, [
    { cmd: 841, data: {}, protocol: 'send', gate: false },
    { cmd: 842, data: { aid: 101, tid: 9001 }, protocol: 'send', gate: undefined },
    { cmd: 3103, data: { id: 101 }, protocol: 'send', gate: false },
  ]);
});

test('旧版分支 atarget 中的完成任务也按 842 逐个领取', async () => {
  const a = activity('101', {
    showUiType: 'legacy_activity_UI',
    atarget: [
      { id: 21, state: 1 },
      { id: '9007199254740993', state: 1 },
    ],
  });
  activities = [a];
  respond = (cmd, data) => {
    if (cmd === 841) return ret({ alist: structuredClone(activities) });
    if (cmd === 842) {
      const target = a.atarget.find((item) => String(item.id) === String(data.tid));
      assert.ok(target);
      target.state = 2;
      return ret({});
    }
    if (cmd === 3103) return ret(structuredClone(a));
    return ret({});
  };
  assert.equal(await gift.cycleRun(), 1000);
  assert.deepEqual(
    sent.filter((item) => item.cmd === 842).map((item) => item.data),
    [
      { aid: '101', tid: 21 },
      { aid: '101', tid: '9007199254740993' },
    ],
  );
  assert.deepEqual(
    sent.map((item) => item.cmd),
    [841, 842, 3103, 842, 3103],
  );
});

test('同一分支多个已完成任务逐个领取，每次按 3103 权威剩余列表继续', async () => {
  const a = activity('101', {
    showUiType: 'another_unlisted_branch_UI',
    task: [
      { id: 't1', state: 1 },
      { id: 't2', state: 1 },
      { id: 'done', state: 2 },
      { id: 't3', state: 1 },
    ],
  });
  activities = [a];
  respond = (cmd, data) => {
    if (cmd === 841) return ret({ alist: structuredClone(activities) });
    if (cmd === 842) {
      const task = a.task.find((item) => item.id === data.tid);
      assert.ok(task);
      task.state = 2;
      return ret({});
    }
    if (cmd === 3103) return ret(structuredClone(a));
    return ret({});
  };
  assert.equal(await gift.cycleRun(), 1000);
  assert.deepEqual(
    sent.map((item) => item.cmd),
    [841, 842, 3103, 842, 3103, 842, 3103],
  );
  assert.deepEqual(
    sent.filter((item) => item.cmd === 842).map((item) => item.data),
    [
      { aid: '101', tid: 't1' },
      { aid: '101', tid: 't2' },
      { aid: '101', tid: 't3' },
    ],
  );
  sent = [];
  await gift.cycleRun();
  assert.deepEqual(
    sent.map((item) => item.cmd),
    [841],
  );
});

test('842 成功但重查无进展时按 20/40 秒退避，不连续重发同一任务', async () => {
  activities = [activity('101', { task: [{ id: 't1', state: 1 }] })];
  assert.equal(await gift.cycleRun(), 20 * 1000);
  assert.deepEqual(
    sent.map((item) => item.cmd),
    [841, 842, 3103],
  );
  sent = [];
  now += 21;
  assert.equal(await gift.cycleRun(), 20 * 1000);
  assert.deepEqual(
    sent.map((item) => item.cmd),
    [841, 842, 3103],
  );
  sent = [];
  now += 21;
  assert.equal(await gift.cycleRun(), 20 * 1000);
  assert.deepEqual(
    sent.map((item) => item.cmd),
    [841],
  );
});

test('842 回执未确认目标任务时不把其它任务减少误当本轮领取成功', async () => {
  const a = activity('101', {
    task: [
      { id: 't1', state: 1 },
      { id: 't2', state: 1 },
    ],
  });
  activities = [a];
  respond = (cmd) => {
    if (cmd === 841) return ret({ alist: structuredClone(activities) });
    if (cmd === 842) {
      a.task = a.task.filter((task) => task.id !== 't2');
      return ret({});
    }
    if (cmd === 3103) return ret(structuredClone(a));
    return ret({});
  };
  assert.equal(await gift.cycleRun(), 20 * 1000);
  assert.deepEqual(
    sent.map((item) => item.cmd),
    [841, 842, 3103],
  );
  assert.deepEqual(sent.find((item) => item.cmd === 842).data, { aid: '101', tid: 't1' });
});

test('842 业务拒绝退避 15 分钟且不阻断其它分支任务', async () => {
  activities = [
    activity('101', { task: [{ id: 't1', state: 1 }] }),
    activity('102', { task: [{ id: 't2', state: 1 }] }),
  ];
  respond = (cmd, data) => {
    if (cmd === 841) return ret({ alist: structuredClone(activities) });
    if (cmd === 842) {
      if (data.aid === '101') return ret(null, 2001);
      activities[1].task[0].state = 2;
      return ret({});
    }
    if (cmd === 3103) return ret(structuredClone(activities.find((a) => a.id === data.id)));
    return ret({});
  };
  assert.equal(await gift.cycleRun(), 1000);
  assert.deepEqual(
    sent.map((item) => [item.cmd, item.cmd === 3103 ? item.data.id : item.data.aid]),
    [
      [841, undefined],
      [842, '101'],
      [842, '102'],
      [3103, '102'],
    ],
  );
  sent = [];
  now += 21;
  await gift.cycleRun();
  assert.deepEqual(
    sent.map((item) => item.cmd),
    [841],
  );
  sent = [];
  now += 15 * 60;
  await gift.cycleRun();
  assert.ok(sent.some((item) => item.cmd === 842 && item.data.aid === '101'));
});

test('842 单任务业务拒绝只退避该任务，同活动其它任务继续领取', async () => {
  const a = activity('101', {
    task: [
      { id: 't1', state: 1 },
      { id: 't2', state: 1 },
    ],
  });
  activities = [a];
  respond = (cmd, data) => {
    if (cmd === 841) return ret({ alist: structuredClone(activities) });
    if (cmd === 842) {
      if (data.tid === 't1') return ret(null, 2001);
      a.task.find((task) => task.id === 't2').state = 2;
      return ret({});
    }
    if (cmd === 3103) return ret(structuredClone(a));
    return ret({});
  };
  assert.equal(await gift.cycleRun(), 1000);
  assert.deepEqual(
    sent.filter((item) => item.cmd === 842).map((item) => item.data.tid),
    ['t1', 't2'],
  );
  assert.deepEqual(
    sent.map((item) => item.cmd),
    [841, 842, 842, 3103],
  );
  sent = [];
  now += 21;
  await gift.cycleRun();
  assert.deepEqual(
    sent.map((item) => item.cmd),
    [841],
  );
  sent = [];
  now += 15 * 60;
  await gift.cycleRun();
  assert.ok(sent.some((item) => item.cmd === 842 && item.data.tid === 't1'));
});

test('842 无进展只退避目标任务，下一轮仍领取同活动其它任务', async () => {
  const a = activity('101', {
    task: [
      { id: 't1', state: 1 },
      { id: 't2', state: 1 },
    ],
  });
  activities = [a];
  respond = (cmd, data) => {
    if (cmd === 841) return ret({ alist: structuredClone(activities) });
    if (cmd === 842 && data.tid === 't2') a.task.find((task) => task.id === 't2').state = 2;
    if (cmd === 3103) return ret(structuredClone(a));
    return ret({});
  };
  assert.equal(await gift.cycleRun(), 20 * 1000);
  assert.deepEqual(
    sent.filter((item) => item.cmd === 842).map((item) => item.data.tid),
    ['t1'],
  );
  sent = [];
  now += 1;
  assert.equal(await gift.cycleRun(), 1000);
  assert.deepEqual(
    sent.filter((item) => item.cmd === 842).map((item) => item.data.tid),
    ['t2'],
  );
  assert.deepEqual(
    sent.map((item) => item.cmd),
    [841, 842, 3103],
  );
});

test('842 CODE_NOT_SENT 不重查、不伪标完成且停止本轮后续活动', async () => {
  activities = [
    activity('101', { task: [{ id: 't1', state: 1 }] }),
    activity('102', { task: [{ id: 't2', state: 1 }] }),
  ];
  respond = (cmd) =>
    cmd === 841 ? ret({ alist: activities }) : cmd === 842 ? ret(null, CODE_NOT_SENT) : ret({});
  assert.equal(await gift.cycleRun(), 20 * 1000);
  assert.deepEqual(
    sent.map((item) => item.cmd),
    [841, 842],
  );
});

test('1777 聚合领取后的 3103 快照若任务已完成则不再重复发送 842', async () => {
  const a = activity('101', {
    point: [tier(1)],
    task: [{ id: 't1', state: 1 }],
    extra: { sc: 1 },
  });
  activities = [a];
  respond = (cmd) => {
    if (cmd === 841) return ret({ alist: structuredClone(activities) });
    if (cmd === 1777) {
      a.extra.rp = [1];
      a.task[0].state = 2;
      return ret({});
    }
    if (cmd === 3103) return ret(structuredClone(a));
    return ret({});
  };
  assert.equal(await gift.cycleRun(), 1000);
  assert.deepEqual(
    sent.map((item) => item.cmd),
    [841, 1777, 3103],
  );
});

test('842 后 3103 活动 ID 错配时当前任务退避，下一轮不错领且不发专用奖励', async () => {
  activities = [
    activity('101', {
      showUiType: 'activity_center_UI',
      task: [
        { id: 't1', state: 1 },
        { id: 't2', state: 1 },
      ],
      extra: { 0: { rewarded: false } },
    }),
  ];
  respond = (cmd) => {
    if (cmd === 841) return ret({ alist: activities });
    if (cmd === 3103) return ret(activity('wrong'));
    return ret({});
  };
  assert.equal(await gift.cycleRun(), 20 * 1000);
  assert.deepEqual(
    sent.map((item) => item.cmd),
    [841, 842, 3103],
  );
  sent = [];
  now += 1;
  await gift.cycleRun();
  assert.deepEqual(
    sent.map((item) => item.cmd),
    [841, 842, 3103],
  );
  assert.deepEqual(sent.find((item) => item.cmd === 842).data, { aid: '101', tid: 't2' });
});

test('通用任务确认后继续领取同一分支的专用全部奖励', async () => {
  const a = activity('101', {
    showUiType: 'activity_center_UI',
    task: [{ id: 't1', state: 1 }],
    extra: { 0: { rewarded: false } },
  });
  activities = [a];
  respond = (cmd) => {
    if (cmd === 841) return ret({ alist: structuredClone(activities) });
    if (cmd === 842) a.task[0].state = 2;
    if (cmd === 3135) a.extra[0].rewarded = true;
    if (cmd === 3103) return ret(structuredClone(a));
    return ret({});
  };
  assert.equal(await gift.cycleRun(), 1000);
  assert.deepEqual(
    sent.map((item) => item.cmd),
    [841, 842, 3103, 3135, 3103],
  );
});

test('842 在飞时关闭再开启，旧轮回执不继续重查或领取下一任务', async () => {
  activities = [
    activity('101', {
      task: [
        { id: 't1', state: 1 },
        { id: 't2', state: 1 },
      ],
    }),
  ];
  const stale = roundController;
  respond = (cmd) => {
    if (cmd === 841) return ret({ alist: activities });
    if (cmd === 842) {
      alive = false;
      stale.abort();
      alive = true;
      roundController = new AbortController();
      return ret({});
    }
    return ret({});
  };
  assert.equal(await gift.cycleRun(), 0);
  assert.deepEqual(
    sent.map((item) => item.cmd),
    [841, 842],
  );
});

test('联盟 BP 仅对完成任务发 3140，重查确认后不重复', async () => {
  const a = activity('201', {
    showUiType: 'ActivityAllianceBP',
    task: [
      { id: '9007199254740993', state: 1 },
      { id: 7, state: 1 },
      { id: 't2', state: 1 },
      { id: 'done', state: 2 },
    ],
  });
  activities = [a];
  respond = (cmd) => {
    if (cmd === 841) return ret({ alist: structuredClone(activities) });
    if (cmd === 3140) {
      a.task = a.task.map((task) => (task.state === 1 ? { ...task, state: 2 } : task));
      return ret({ aid: '201', targetArr: [] });
    }
    if (cmd === 3103) return ret(structuredClone(a));
    return ret({});
  };
  assert.equal(await gift.cycleRun(), 1000);
  assert.deepEqual(sent, [
    { cmd: 841, data: {}, protocol: 'send', gate: false },
    {
      cmd: 3140,
      data: { activityId: '201', targetIds: ['9007199254740993', 7, 't2'] },
      protocol: 'send',
      gate: undefined,
    },
    { cmd: 3103, data: { id: '201' }, protocol: 'send', gate: false },
  ]);
  sent = [];
  await gift.cycleRun();
  assert.deepEqual(
    sent.map((item) => item.cmd),
    [841],
  );
});

test('1777 后按 3103 新快照领取联盟 BP 新完成任务', async () => {
  const a = activity('201', {
    showUiType: 'ActivityAllianceBP',
    point: [tier(1)],
    task: [{ id: 'old', state: 1 }],
    extra: { sc: 1 },
  });
  activities = [a];
  respond = (cmd) => {
    if (cmd === 841) return ret({ alist: [structuredClone(a)] });
    if (cmd === 1777) {
      a.extra.rp = [1];
      a.task = [{ id: 'new', state: 1 }];
      return ret({});
    }
    if (cmd === 3140) {
      a.task = [{ id: 'new', state: 2 }];
      return ret({ aid: '201', targetArr: [{ id: 'new', state: 2 }] });
    }
    if (cmd === 3103) return ret(structuredClone(a));
    return ret({});
  };
  assert.equal(await gift.cycleRun(), 1000);
  assert.deepEqual(
    sent.map((item) => item.cmd),
    [841, 1777, 3103, 3140, 3103],
  );
  assert.deepEqual(sent.find((item) => item.cmd === 3140).data, {
    activityId: '201',
    targetIds: ['new'],
  });
});

test('841 返回后已退盟时不发送联盟 BP 积分档', async () => {
  const a = activity('201', {
    showUiType: 'ActivityAllianceBP',
    point: [tier(1)],
    extra: { sc: 1 },
  });
  activities = [a];
  onSend = (cmd) => {
    if (cmd === 841) inAlliance = false;
  };
  await gift.cycleRun();
  assert.deepEqual(
    sent.map((entry) => entry.cmd),
    [841],
  );
});

test('1777 等待期间退盟后不继续发送联盟 BP 领取', async () => {
  const a = activity('201', {
    showUiType: 'ActivityAllianceBP',
    point: [tier(1)],
    task: [{ id: 't1', state: 1 }],
    extra: { sc: 1 },
  });
  activities = [a];
  respond = (cmd) => {
    if (cmd === 841) return ret({ alist: activities });
    if (cmd === 1777) {
      a.extra.rp = [1];
      inAlliance = false;
      return ret({});
    }
    if (cmd === 3103) return ret(a);
    return ret({});
  };
  await gift.cycleRun();
  assert.deepEqual(
    sent.map((entry) => entry.cmd),
    [841, 1777, 3103],
  );
});

test('3140 CODE_NOT_SENT 不重查、不伪标完成', async () => {
  activities = [
    activity('201', {
      showUiType: 'ActivityAllianceBP',
      task: [{ id: 't1', state: 1 }],
    }),
  ];
  respond = (cmd) =>
    cmd === 841 ? ret({ alist: activities }) : cmd === 3140 ? ret(null, CODE_NOT_SENT) : ret({});
  assert.equal(await gift.cycleRun(), 20 * 1000);
  assert.deepEqual(
    sent.map((item) => item.cmd),
    [841, 3140],
  );
});

test('领取在飞时 pause 不再重查或继续其它活动', async () => {
  activities = [
    activity('1', { point: [tier(1)], extra: { sc: 1 } }),
    activity('2', { point: [tier(1)], extra: { sc: 1 } }),
  ];
  respond = (cmd) => {
    if (cmd === 841) return ret({ alist: activities });
    if (cmd === 1777) {
      alive = false;
      return ret({});
    }
    return ret({});
  };
  assert.equal(await gift.cycleRun(), 0);
  assert.deepEqual(
    sent.map((item) => item.cmd),
    [841, 1777],
  );
});

test('领取在飞时关闭再开启，旧轮回执不继续重查', async () => {
  activities = [activity('1', { point: [tier(1)], extra: { sc: 1 } })];
  const stale = roundController;
  respond = (cmd) => {
    if (cmd === 841) return ret({ alist: activities });
    if (cmd === 1777) {
      alive = false;
      stale.abort();
      alive = true;
      roundController = new AbortController();
      return ret({});
    }
    return ret({});
  };
  assert.equal(await gift.cycleRun(), 0);
  assert.deepEqual(
    sent.map((item) => item.cmd),
    [841, 1777],
  );
});

test('服务器时钟不可用时不发包', async () => {
  now = 0;
  assert.equal(await gift.cycleRun(), 15 * 60 * 1000);
  assert.equal(sent.length, 0);
});

test('明确不在联盟时不请求联盟 BP 奖励，未知状态仍允许请求', async () => {
  activities = [
    activity('201', {
      showUiType: 'ActivityAllianceBP',
      task: [{ id: 't1', state: 1 }],
    }),
  ];
  inAlliance = false;
  assert.equal(await gift.cycleRun(), 30 * 1000);
  assert.deepEqual(
    sent.map((item) => item.cmd),
    [841],
  );

  sent = [];
  inAlliance = null;
  respond = (cmd) => {
    if (cmd === 841) return ret({ alist: activities });
    if (cmd === 3140) activities[0].task = [];
    if (cmd === 3103) return ret(activities[0]);
    return ret({});
  };
  assert.equal(await gift.cycleRun(), 1000);
  assert.deepEqual(
    sent.map((item) => item.cmd),
    [841, 3140, 3103],
  );
});

test('业务拒绝活动退避 15 分钟，不阻断其它活动', async () => {
  activities = [
    activity('1', { point: [tier(1)], extra: { sc: 1 } }),
    activity('2', { point: [tier(1)], extra: { sc: 1 } }),
  ];
  respond = (cmd, data) => {
    if (cmd === 841) return ret({ alist: structuredClone(activities) });
    if (cmd === 1777) {
      if (data.id === '1') return ret(null, 2001);
      activities[1].extra.rp = [1];
    }
    if (cmd === 3103) return ret(activities.find((item) => item.id === data.id));
    return ret({});
  };
  assert.equal(await gift.cycleRun(), 1000);
  sent = [];
  now += 21;
  await gift.cycleRun();
  assert.deepEqual(
    sent.map((item) => item.cmd),
    [841],
  );

  sent = [];
  now += 15 * 60;
  await gift.cycleRun();
  assert.ok(sent.some((item) => item.cmd === 1777 && item.data.id === '1'));
});

test('业务拒绝退避从拒绝到达时的服务器时钟起算，不被长轮次缩短', async () => {
  const a = activity('101', {
    point: [tier(10)],
    extra: { sc: 10 },
    endtime: NOW + 10000,
  });
  activities = [a];
  respond = (cmd) => {
    if (cmd === 841) return ret({ alist: activities });
    if (cmd === 1777) {
      now += 1000;
      return ret(null, 2001);
    }
    return ret({});
  };
  await gift.cycleRun();
  now = NOW + 901;
  sent = [];
  await gift.cycleRun();
  assert.deepEqual(
    sent.map((entry) => entry.cmd),
    [841],
  );
});

test('无进展退避从权威重查到达时的服务器时钟起算', async () => {
  const a = activity('101', {
    point: [tier(10)],
    extra: { sc: 10 },
    endtime: NOW + 10000,
  });
  activities = [a];
  respond = (cmd) => {
    if (cmd === 841) return ret({ alist: activities });
    if (cmd === 1777) {
      now += 100;
      return ret({});
    }
    if (cmd === 3103) return ret(a);
    return ret({});
  };
  await gift.cycleRun();
  now = NOW + 101;
  sent = [];
  await gift.cycleRun();
  assert.deepEqual(
    sent.map((entry) => entry.cmd),
    [841],
  );
});

test('重查无进展按 20/40 秒指数退避，权威完成后解除', async () => {
  activities = [activity('101', { point: [tier(10)], extra: { sc: 10 } })];
  await gift.cycleRun();
  sent = [];
  now += 21;
  await gift.cycleRun();
  assert.equal(sent.filter((item) => item.cmd === 1777).length, 1);
  sent = [];
  now += 21;
  await gift.cycleRun();
  assert.deepEqual(
    sent.map((item) => item.cmd),
    [841],
  );
  sent = [];
  now += 21;
  await gift.cycleRun();
  assert.equal(sent.filter((item) => item.cmd === 1777).length, 1);
  sent = [];
  now += 41;
  await gift.cycleRun();
  assert.deepEqual(
    sent.map((item) => item.cmd),
    [841],
  );

  activities[0].extra.rp = [10];
  sent = [];
  await gift.cycleRun();
  assert.deepEqual(
    sent.map((item) => item.cmd),
    [841],
  );
});

test('无进展指数退避增长到 300 秒后封顶', async () => {
  activities = [activity('101', { point: [tier(10)], extra: { sc: 10 } })];
  await gift.cycleRun();
  for (const advance of [21, 41, 81, 161, 301]) {
    now += advance;
    sent = [];
    await gift.cycleRun();
    assert.equal(sent.filter((entry) => entry.cmd === 1777).length, 1);
  }
});

test('活动从权威列表消失后清理拒绝退避', async () => {
  activities = [activity('101', { point: [tier(10)], extra: { sc: 10 } })];
  respond = (cmd) =>
    cmd === 841 ? ret({ alist: activities }) : cmd === 1777 ? ret(null, 2001) : ret({});
  await gift.cycleRun();
  activities = [];
  sent = [];
  await gift.cycleRun();
  assert.deepEqual(
    sent.map((item) => item.cmd),
    [841],
  );

  activities = [activity('101', { point: [tier(10)], extra: { sc: 10 } })];
  respond = (cmd) => {
    if (cmd === 841) return ret({ alist: activities });
    if (cmd === 1777) activities[0].extra.rp = [10];
    if (cmd === 3103) return ret(activities[0]);
    return ret({});
  };
  sent = [];
  assert.equal(await gift.cycleRun(), 1000);
  assert.ok(sent.some((item) => item.cmd === 1777));
});

test('测试复位清理会话退避，避免跨用例泄露', async () => {
  activities = [activity('101', { point: [tier(10)], extra: { sc: 10 } })];
  respond = (cmd) =>
    cmd === 841 ? ret({ alist: activities }) : cmd === 1777 ? ret(null, 2001) : ret({});
  await gift.cycleRun();
  gift.resetForTest();
  sent = [];
  await gift.cycleRun();
  assert.ok(sent.some((item) => item.cmd === 1777));
});
