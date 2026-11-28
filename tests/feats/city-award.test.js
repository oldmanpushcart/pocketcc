// city-award 纯函数单测：可领城市判定（can − recv + 上限 + 胜利庆典结算态）。
// rules.js 只依赖 constants.js，无浏览器全局；不解 index.js（reactor 链），断言的是决策本身。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  awardUpperLimit,
  collectTargets,
  countPending,
  isCityAwardActivity,
  isReceived,
  kingDuelSettled,
} from '../../extension/src/feats/activity/city-award/rules.js';

/**
 * 造一个活动对象。
 * @param {string} showUiType 活动 showUiType
 * @param {object} extra 活动 extra
 * @param {object} [more] 额外顶层字段（paramData 等）
 * @returns {object}
 */
function act(showUiType, extra, more) {
  return Object.assign({ id: 81200412, showUiType: showUiType, extra: extra }, more || {});
}

test('三活动识别：DragonKingDuel / JMFirstPart / ActReviewTroops', function () {
  assert.equal(isCityAwardActivity(act('DragonKingDuel', {})), true);
  assert.equal(isCityAwardActivity(act('JMFirstPart', {})), true);
  assert.equal(isCityAwardActivity(act('ActReviewTroops', {})), true);
  assert.equal(isCityAwardActivity(act('SomethingElse', {})), false);
  assert.equal(isCityAwardActivity(null), false);
});

test('can − recv 差集：uid 统一字符串、去重、保序', function () {
  const a = act('JMFirstPart', {
    can_receive_uid_list: ['100', 200, '100', null, ''],
    reward_received_list: ['200'],
  });
  assert.deepEqual(collectTargets(a), ['100']);
});

test('can 为空或缺失：无可领', function () {
  assert.deepEqual(collectTargets(act('JMFirstPart', {})), []);
  assert.deepEqual(collectTargets(act('JMFirstPart', { can_receive_uid_list: [] })), []);
  assert.deepEqual(collectTargets(act('JMFirstPart', { can_receive_uid_list: null })), []);
});

test('recv 全含：无可领', function () {
  const a = act('ActReviewTroops', {
    can_receive_uid_list: ['1', '2'],
    reward_received_list: ['1', '2'],
  });
  assert.deepEqual(collectTargets(a), []);
});

test('胜利庆典：state≠3 不领', function () {
  const a = act('DragonKingDuel', {
    state: 2,
    can_receive_uid_list: ['1'],
    reward_received_list: [],
  });
  assert.equal(kingDuelSettled(a), false);
  assert.deepEqual(collectTargets(a), []);
});

test('胜利庆典：state=3 且 winSid=本服 才领', function () {
  const ok = act('DragonKingDuel', {
    state: 3,
    winSid: 4402,
    my: { sid: 4402 },
    can_receive_uid_list: ['674871690956', '684321310458'],
    reward_received_list: ['674871690956'],
  });
  assert.equal(kingDuelSettled(ok), true);
  assert.deepEqual(collectTargets(ok), ['684321310458']);
});

test('胜利庆典：本服未获胜（winSid≠my.sid）不领', function () {
  const a = act('DragonKingDuel', {
    state: 3,
    winSid: 4402,
    my: { sid: 4361 },
    can_receive_uid_list: ['1'],
    reward_received_list: [],
  });
  assert.equal(kingDuelSettled(a), false);
  assert.deepEqual(collectTargets(a), []);
});

test('胜利庆典：state/winSid/my.sid 缺失时放行（无从判定不误杀）', function () {
  const a = act('DragonKingDuel', {
    can_receive_uid_list: ['1'],
    reward_received_list: [],
  });
  assert.equal(kingDuelSettled(a), true);
  assert.deepEqual(collectTargets(a), ['1']);
});

test('allAwardCount 上限：已领达上限即停，未达按差集', function () {
  const base = {
    can_receive_uid_list: ['1', '2', '3'],
    reward_received_list: ['1', '2'],
  };
  const capped = act('JMFirstPart', base, { paramData: { allAwardCount: 2 } });
  assert.equal(awardUpperLimit(capped), 2);
  assert.deepEqual(collectTargets(capped), []);

  const room = act('JMFirstPart', base, { paramData: { allAwardCount: 3 } });
  assert.deepEqual(collectTargets(room), ['3']);

  const flat = act('JMFirstPart', base, { allAwardCount: 1 });
  assert.deepEqual(collectTargets(flat), []);

  const unlimited = act('JMFirstPart', base);
  assert.equal(awardUpperLimit(unlimited), 0);
  assert.deepEqual(collectTargets(unlimited), ['3']);
});

test('isReceived / countPending：面板与确认逻辑共用口径', function () {
  const a = act('ActReviewTroops', {
    can_receive_uid_list: ['1', '2'],
    reward_received_list: [2],
  });
  assert.equal(isReceived(a, '1'), false);
  assert.equal(isReceived(a, 2), true);
  assert.equal(isReceived(null, '1'), false);

  const b = act('JMFirstPart', {
    can_receive_uid_list: ['9'],
    reward_received_list: [],
  });
  assert.equal(countPending([a, b, act('Other', { can_receive_uid_list: ['1'] })]), 2);
  assert.equal(countPending(null), 0);
});
