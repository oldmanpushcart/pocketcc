/**
 * 城市庆典宝箱-自动领取（reactor 说明书形态）
 *
 * 玩法即「世界地图上获胜方玩家的城市挂出庆典气泡，其他指挥官可点领一份奖励」。
 * 官方 subpack/ActivityWorldCityAwardNode 是同一套数据驱动组件，被三个活动复用：
 *   1) 胜利庆典 DragonKingDuel（extra.state===3 结算后才出按钮）；
 *   2) 军事演习 JMFirstPart；
 *   3) 势力检阅 ActReviewTroops。
 * 组件判据（源码锚点）：城市 pid ∈ extra.can_receive_uid_list 且 ∉ extra.reward_received_list，
 * 且（paramData.allAwardCount>0 时）已领数未达上限；三活动挂载参数都只传 prefabPath，
 * 故当前上限恒为 0（无上限）。点击后直接 sendPBV2 9657 {activityId,targetUidStr}，无前置查询。
 *
 * 感知：全部走 core/activity-hub（841 快照 + 10912 extra 合并）；本文件不再订阅 10904/10912、
 * 不再发 841/3103——活动快照由 hub 统一维护，watch 命中三活动任一变化即 cycle.kick。
 * 领取：全部走 core/claim-runner（协议分派/在途闸门/业务拒绝退避/无进展指数退避）；
 * 本文件只提供 9657 的载荷形态与 beat 语义。
 *
 * 确认闭环（实证 dashcam-rec-20261127T235644）：9657 受理后约 2.4 秒推 10912，
 * extra.reward_received_list 追加该 uid。故「确认」以权威快照为准：
 *   a) 每拍先对账在飞确认：快照 recv 已含 → runner.confirm 清退避；
 *   b) 受理 8 秒仍未推进 → 主动 hub.refresh(aid) 一次（3103 单查，hub 自带节流/单飞）；
 *   c) 30 秒仍未推进 → runner.noProgress 指数退避，防每拍重发刷屏。
 * 不把 9657 的 ok 回执当成已领——与超值活动同一纪律。
 *
 * 触发：hub.watch 推送唤醒 + 启动首扫 + hub 周期 841（5 分钟兜底）。cycle 只负责
 * 「单飞 + 触发合并 + 下一拍间隔」，pause 后 alive()=false 自然停摆，resume 重新 attach。
 */
import { createLog } from '../../../core/log.js';
import { gameData } from '../../../core/game-api.js';
import { reactor } from '../../../core/reactor.js';
import { createCycle } from '../../../core/cycle.js';
import { activityHub } from '../../../core/activity-hub.js';
import { createClaimRunner } from '../../../core/claim-runner.js';

import {
  CITY_AWARD_UI_TYPES,
  CMD_CITY_GET_REWARD,
  SHOW_UI_TYPE_JM_FIRST_PART,
  SHOW_UI_TYPE_KING_DUEL,
  SHOW_UI_TYPE_REVIEW_TROOPS,
} from './constants.js';
import { collectTargets, countPending, isCityAwardActivity, isReceived } from './rules.js';

/** @type {ReturnType<createLog>} 模块日志器（tag=CITY-AWARD） */
const log = createLog('CITY-AWARD');

/**
 * 内置调优（面板只出启用开关，不暴露这些间隔）
 * @type {object}
 */
const cfg = {
  /** 两次 9657 的最小间隔：实录手动点 3 个城市间隔约 2.4s，留余量防限流 */
  claimGapMs: 2000,
  /** 有待领/待确认时的短拍（等 10912 回执） */
  busyTickMs: 1000,
  /** 无事可做时的长拍（hub 的 841/推送仍会主动 kick） */
  restTickMs: 5 * 60 * 1000,
  /** 受理后多久仍未见权威推进 → 主动 3103 补一次 */
  confirmRefreshMs: 8 * 1000,
  /** 受理后多久仍未见权威推进 → 记一次无进展指数退避 */
  confirmTimeoutMs: 30 * 1000,
  /** hub 周期 841 兜底档位（防推送丢失/页面刷新后状态陈旧） */
  scanIntervalMs: 5 * 60 * 1000,
};

/** @type {object|null} reactor 注入的上下文；alive() 反映运行态 */
let ctxRef = null;
/** @type {function():void|null} hub attach 的 detach */
let detachHub = null;
/** @type {function():void|null} hub watch 的退订 */
let unwatchHub = null;
/** @type {number} 本次激活已受理的领取数（面板状态行） */
let claimedSession = 0;
/** @type {number} 最近一拍算出的待领数（面板状态行） */
let pendingCount = 0;
/**
 * 在飞确认表：key=`aid:uid` → {aid,uid,at,refreshed}。
 * 9657 ok 只代表受理，权威结果看 10912 的 reward_received_list。
 * @type {Map<string,{aid:number|string,uid:string,at:number,refreshed:boolean}>}
 */
const awaiting = new Map();

/** @returns {boolean} 当前 reactor 功能是否存活 */
function aliveFn() {
  return ctxRef ? ctxRef.alive() : false;
}

/** @type {object} 领取执行器（本 feat 独立退避域；日志并入 CITY-AWARD） */
const runner = createClaimRunner({ log: log, actionGapMs: cfg.claimGapMs });
runner.register(CMD_CITY_GET_REWARD, {
  label: 'city',
  protocol: 'sendPBV2',
  body: function (item) {
    return { activityId: item.aid, targetUidStr: item.targetId };
  },
  // 退避键：活动 + 城市 uid；同城被多活动共享时各自独立（服务端按活动分别记账）
  key: function (item) {
    return String(item.aid) + ':' + String(item.targetId);
  },
});

/**
 * 单轮调和主体：先对账在飞确认，再领取当前可领城市；返回下一拍间隔。
 * @returns {Promise<number>}
 */
async function cycleRun() {
  if (!aliveFn()) return 0;
  const signal = ctxRef.signal;
  let busy = false;
  let retry = false;

  // ① 对账：受理后的权威推进（10912 合并进 hub 快照）
  for (const entry of Array.from(awaiting.values())) {
    if (!aliveFn()) return 0;
    const activity = activityHub.get(entry.aid);
    if (isReceived(activity, entry.uid)) {
      runner.confirm({ cmd: CMD_CITY_GET_REWARD, aid: entry.aid, targetId: entry.uid });
      awaiting.delete(String(entry.aid) + ':' + entry.uid);
      log.info('cmd 9657 confirmed. activityId=%s;targetUid=%s', entry.aid, entry.uid);
      continue;
    }
    const age = Date.now() - entry.at;
    if (age >= cfg.confirmRefreshMs && !entry.refreshed) {
      entry.refreshed = true;
      await activityHub.refresh(entry.aid);
      if (!aliveFn()) return 0;
      continue; // 下一拍再对账（3103 受 hub 3s 节流，不在此拍判定无进展）
    }
    if (age >= cfg.confirmTimeoutMs) {
      runner.noProgress({ cmd: CMD_CITY_GET_REWARD, aid: entry.aid, targetId: entry.uid });
      awaiting.delete(String(entry.aid) + ':' + entry.uid);
      log.warn(
        'cmd 9657 accepted but not confirmed in %dms; backoff. activityId=%s;targetUid=%s',
        age,
        entry.aid,
        entry.uid,
      );
      retry = true;
      continue;
    }
    busy = true;
  }

  // ② 领取：以 hub 当前快照为准逐个城市发 9657
  const activities = activityHub.list().filter(isCityAwardActivity);
  pendingCount = countPending(activities);
  for (let ai = 0; ai < activities.length; ai++) {
    if (!aliveFn()) return 0;
    const activity = activities[ai];
    const targets = collectTargets(activity);
    for (let ti = 0; ti < targets.length; ti++) {
      if (!aliveFn()) return 0;
      const uid = targets[ti];
      const item = { cmd: CMD_CITY_GET_REWARD, aid: activity.id, targetId: uid, signal: signal };
      const ret = await runner.claim(item);
      if (!aliveFn()) return 0;
      if (ret.status === 'ok') {
        claimedSession++;
        awaiting.set(String(activity.id) + ':' + uid, {
          aid: activity.id,
          uid: uid,
          at: Date.now(),
          refreshed: false,
        });
        busy = true;
        log.info('cmd 9657 accepted. activityId=%s;targetUid=%s', activity.id, uid);
        continue;
      }
      if (ret.status === 'rejected') {
        runner.suppress(item);
        retry = true;
        log.info(
          'cmd 9657 rejected; backoff. activityId=%s;targetUid=%s;code=%s',
          activity.id,
          uid,
          ret.code,
        );
        continue;
      }
      if (ret.status === 'suppressed') continue; // 该项退避中，跳过
      if (ret.status === 'transient') {
        log.warn(
          'cmd 9657 transient (not sent/in-flight). activityId=%s;targetUid=%s',
          activity.id,
          uid,
        );
        return cfg.busyTickMs;
      }
      return 0; // aborted/unregistered：本轮终止，交给 alive 检查
    }
  }

  if (retry) return cfg.busyTickMs;
  return busy ? cfg.busyTickMs : cfg.restTickMs;
}

/** @type {{kick: function(), pending: boolean}} 调和循环驱动器（fallback 取长拍，防异常停摆） */
const cycle = createCycle({
  log: log,
  alive: aliveFn,
  run: cycleRun,
  fallback: cfg.restTickMs,
});

/**
 * hub 订阅回调：活动 extra 变化（新城市可领/已领列表推进）只负责唤醒。
 */
function onActivityChange() {
  if (!aliveFn()) return;
  cycle.kick();
}

/**
 * 安装：只验证 net 底座可用；活动快照与领取协议均由 core 承担。
 * @param {object} ctx reactor 上下文
 * @returns {boolean}
 */
function install(ctx) {
  ctxRef = ctx;
  const net = ctx.net;
  if (!net || !net.install()) {
    log.warn('install failed: pocketcc.net unavailable.');
    return false;
  }
  log.info('installed.');
  return true;
}

/**
 * 激活：复位会话状态，attach hub（引用计数）+ watch 三活动，立即点火。
 * @param {object} ctx reactor 上下文
 */
function run(ctx) {
  ctxRef = ctx;
  claimedSession = 0;
  pendingCount = 0;
  awaiting.clear();
  runner.prune(function () {
    return false; // 每次激活清空会话退避（重新开启不应被旧拉黑压制）
  });
  if (detachHub) detachHub();
  if (unwatchHub) unwatchHub();
  detachHub = activityHub.attach({ label: 'city-award', scanIntervalMs: cfg.scanIntervalMs });
  unwatchHub = activityHub.watch(isCityAwardActivity, onActivityChange, { label: 'city-award' });
  log.info('started; watching %s.', CITY_AWARD_UI_TYPES.join('|'));
  cycle.kick();
}

/**
 * 暂停：释放 hub 引用与订阅，清在飞确认表；cycle 在 alive 检查处自然停摆。
 */
function pause() {
  if (unwatchHub) {
    unwatchHub();
    unwatchHub = null;
  }
  if (detachHub) {
    detachHub();
    detachHub = null;
  }
  awaiting.clear();
  log.info('paused.');
}

/**
 * 面板可用性：三活动任一在期即放行；控制器缺失（null）按放行处理，不误灰。
 * @returns {boolean|{ok:false,reason:string}}
 */
function available() {
  const types = [SHOW_UI_TYPE_KING_DUEL, SHOW_UI_TYPE_JM_FIRST_PART, SHOW_UI_TYPE_REVIEW_TROOPS];
  for (let i = 0; i < types.length; i++) {
    if (gameData.activityIsOpen('showUiType', types[i]) === true) return true;
  }
  return { ok: false, reason: '城市庆典宝箱活动未开启' };
}

reactor.register({
  id: 'cityAward',
  label: '城市庆典宝箱',
  storageKey: 'pocketcc.feat.cityAward',
  symbols: ['activityController'],
  places: ['base', 'world'],
  kinds: ['homeland'],
  available: available,
  offInCombat: true,
  defaults: { enabled: false },
  fields: [
    {
      key: '_cityAwardInfo',
      type: 'text',
      label: '状态',
      get: function () {
        if (awaiting.size) return '待确认 ' + awaiting.size + ' 个城市';
        if (pendingCount > 0) return '待领 ' + pendingCount + ' 个城市';
        if (claimedSession > 0) return '本次已领 ' + claimedSession + ' 个城市';
        return '暂无待领';
      },
    },
  ],
  toModuleCfg: function (c) {
    return { enabled: !!(c && c.enabled) };
  },
  install: install,
  run: run,
  pause: pause,
});
