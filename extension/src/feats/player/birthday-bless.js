/**
 * 生日祝福（生日红包自动领取 + 送祝福，reactor 说明书形态，日常任务，边沿触发单链）
 *
 * 玩法：有玩家过生日时会在聊天频道（世界/联盟/任意频道）发一条生日红包消息（ct=3
 *   BIRTHDAY_RED_PACKET，正文是语言键 happy_birthday_test_087「今天是我的生日，快来和我分享蛋糕吧！」）。
 *   点红包 = 开红包信息，服务器在首次打开时直接把一份蛋糕（钻石）发给领取者；每日领取有上限
 *   （grabCountMaxDaily，实证 10）。本功能监听聊天推送，自动开红包领钻石，并顺手送上一句祝福。
 *
 * 触发源（只认聊天 ct=3，不订阅专属 push）：
 *   生日提醒确有专属 push 11079 BIRTHDAY_RED_PACKET_REMINDER（ResponseRegister 实证），但载荷
 *   reminderInfoList[{chatRoomKey,chatUuid,specId}] 只带聊天消息 uuid 与物品 specId，**不带红包 id**，
 *   游戏拿它只做底部气泡跳转（NNewChatBubbleBirthdayRedPacket.onClickAtBubble）；真正可动作的
 *   种子是聊天消息 ctExtraData.id，故本功能直订聊天 socket push（ctx.on.chat，任意频道都收）。
 *   11077 BIRTHDAY_INIT / 11078 BIRTHDAY_CELEBRATE 是「自己的生日」设置/庆祝推送，与本功能无关。
 *
 * 协议（报文实证 dashcam dashcam-rec-20261114T100916-印石-我的日常.ndjson）：
 *   3567 NRequestIdV2.BIRTHDAY_RED_PACKET_INFO_OPEN，sendPBV2，req {id:Int64}（红包 id，来自
 *   ctExtraData.id 字符串装箱）→ resp {redPacketInfo:{id,year,specId,totalAmount,totalCount,uid,
 *   playerInfo,grabRecordList[{uid,playerInfo,amount,timeGrab}],timeExpire(Int64 毫秒),bless},
 *   grabCountDaily,grabCountMaxDaily,rewardResult?}。**首次可领时打开即领**：resp 直接带
 *   rewardResult{resource:{gold:95}}（gold=钻石，与 ad-diamond 9707 同源），且 grabRecordList
 *   已含自己；再开同一红包 resp 无 rewardResult（实录两次 3567 对照）。
 *   3565 NRequestIdV2.BIRTHDAY_BLESS，sendPBV2，req {year,uid:Int64}（寿星 uid）→ resp
 *   {uid,year,blessingCount}（「您是第 N 位祝福的指挥官」happy_birthday_text_019；报文实证
 *   dashcam 会话 20261114T114000：3567 后 7.6s 手点祝福按钮，blessingCount=21）。
 *   游戏源码 RealBirthdayController.sendBenediction 同款；祝福按钮闸门（BirthdayBenedictionView）：
 *   未过期 && 寿星非自己 && bless!==1。祝福纯社交计数，无奖励，不占每日领取额度。
 *
 * 闸门判据（对齐竞对 birthdayBless + 游戏客户端）：
 *   - 当日领取数 >= grabCountMaxDaily → 整包跳过（额度以 3567 应答为权威，本地镜像日切清零）；
 *   - ctExtraData.grabCount >= totalCount → 红包已被抢光，跳过；
 *   - 同一红包 id 去重（聊天 update/重连补收会重复推同一条）；
 *   - 自己发的红包（fu==本端 uid）跳过；寿星是自己时只开不祝福。
 *
 * 调度：边沿触发（聊天 push 驱动），无周期扫描，不套 createCycle。多包串行 drain（3567 同 cmd
 *   在途闸门会拒第二发），CODE_NOT_SENT 延迟 3s 重试至多 3 次；业务拒绝不重试。
 *
 * 合规：只读游戏数据（经 game-api ACL）+ 直发 3567/3565，不 OpenUI、不回写本地态。
 *   日常任务形态：面板只出启用开关（playerBasics 组），无字段无配置。
 *   不行军不参战，offInCombat:false。生命周期由 reactor 托管，pause 摘订阅后 alive()=false 自然停摆。
 */
import { CODE_NOT_SENT, rejectText, safeParse } from '../../core/util.js';
import { createLog } from '../../core/log.js';
import { bits, gameData } from '../../core/game-api.js';
import { getUid } from '../../core/player.js';
import { reactor } from '../../core/reactor.js';

/** @type {ReturnType<createLog>} 模块日志器（tag=BIRTHDAY-BLESS） */
const log = createLog('BIRTHDAY-BLESS');

/** @type {number} NRequestIdV2.BIRTHDAY_RED_PACKET_INFO_OPEN，开生日红包（首次可领时打开即领） */
const CMD_INFO_OPEN = 3567;

/** @type {number} NRequestIdV2.BIRTHDAY_BLESS，给寿星送祝福（纯社交计数，无奖励） */
const CMD_BLESS = 3565;

/** @type {string} CHAT_CT_TYPE.BIRTHDAY_RED_PACKET（chatCommon.js），生日红包消息内容类型 */
const CT_BIRTHDAY = '3';

/** @type {number} 每日领取上限缺省值（权威值以 3567 应答 grabCountMaxDaily 为准） */
const DEFAULT_MAX_DAILY = 10;

/** @type {number} CODE_NOT_SENT 重试间隔（毫秒） */
const RETRY_DELAY_MS = 3000;

/** @type {number} CODE_NOT_SENT 最大重试次数（超过放弃该包，打 warn） */
const MAX_RETRY = 3;

/** @type {number} 去重表容量上界（超出按插入序淘汰最旧，生日红包低频足够） */
const SEEN_CAP = 512;

/** @type {object|null} 网络底座（promise 封装 pocketcc.net） */
var net;

/** @type {object|null} reactor 上下文；alive() 反映运行态 */
var ctxRef = null;

/** @type {number} run 世代号：pause→resume 后旧 drain 循环凭此收手，不跨世代处理 */
var runSeq = 0;

/** @type {boolean} drain 串行标志（同一时刻只处理一个包，避开 3567 在途闸门） */
var busy = false;

/** @type {Array<{id:string, attempt:number}>} 待处理红包队列（FIFO） */
var queue = [];

/** @type {Map<string,number>} 已处理红包 id 去重表（插入序，容量上界 SEEN_CAP） */
var seen = new Map();

/** @type {{day:string, grabbed:number, max:number}} 当日领取镜像（grabbed/max 以 3567 应答为权威，日切清零） */
var daily = { day: '', grabbed: 0, max: DEFAULT_MAX_DAILY };

/**
 * 功能是否仍在运行（drain 与在飞流程的存活判定）
 * @returns {boolean}
 */
function aliveFn() {
  return ctxRef ? ctxRef.alive() : false;
}

/** 本地日切检查：跨天清零当日领取计数（额度上限保留上次权威值）。 */
function rollDaily() {
  var day = new Date().toDateString();
  if (daily.day !== day) daily = { day: day, grabbed: 0, max: daily.max || DEFAULT_MAX_DAILY };
}

/**
 * 直发一条 PBV2 并归一化，永不 reject：同 cmd 在途回落 CODE_NOT_SENT 哨兵。
 * @param {number} cmd 命令号
 * @param {object} body 载荷
 * @returns {Promise<object>} Ret {code,data,ok}
 */
async function send(cmd, body) {
  return net.sendGuarded(cmd, body, {
    protocol: 'sendPBV2',
    onError: function (err) {
      log.warn('cmd %d send threw: %s', cmd, err && err.message);
    },
  });
}

// ── 聊天入口 ──────────────────────────────────────────────────────────
/**
 * chatpush 入口：同步过滤 ct=3 生日红包 + 前置闸门 + 入队。永不 throw。
 * 频道不限（世界/联盟/任意房间）：红包消息在哪个频道发，就在哪个频道的 push 里收。
 * @param {object} msg chatpush 载荷（单项对象，socket 实参原样）
 */
function onChatPush(msg) {
  if (!aliveFn() || !msg || typeof msg !== 'object') return;
  if (String(msg.ct || '') !== CT_BIRTHDAY) return;

  var extra = safeParse(msg.ctExtraData);
  var id = extra && extra.id != null ? String(extra.id) : '';
  if (!id) {
    log.warn('ct=3 birthday packet without id, skip. channel=%s', msg.c);
    return;
  }

  // 自己发的红包（自己的生日分享）不领
  var myUid = getUid();
  if (myUid && msg.fu != null && String(msg.fu) === myUid) {
    log.debug('own birthday packet skipped. id=%s', id);
    return;
  }

  rollDaily();
  if (daily.grabbed >= daily.max) {
    log.debug('daily grab cap reached, skip. id=%s;daily=%d/%d', id, daily.grabbed, daily.max);
    return;
  }
  var grabbed = Number(extra.grabCount) || 0;
  var total = Number(extra.totalCount) || 0;
  if (total > 0 && grabbed >= total) {
    log.debug('packet already empty, skip. id=%s;grab=%d/%d', id, grabbed, total);
    return;
  }
  if (seen.has(id)) {
    log.debug('packet already handled, skip. id=%s', id);
    return;
  }
  seen.set(id, 1);
  if (seen.size > SEEN_CAP) seen.delete(seen.keys().next().value);

  queue.push({ id: id, attempt: 0 });
  drain();
}

// ── 串行处理 ──────────────────────────────────────────────────────────
/** 串行 drain：同一时刻只开一个红包；run 世代变更或 pause 即收手。收尾只清自己世代的 busy，避免旧循环误清新 drain。 */
async function drain() {
  if (busy) return;
  busy = true;
  var seq = runSeq;
  while (queue.length && aliveFn() && seq === runSeq) {
    var item = queue.shift();
    try {
      await processPacket(item, seq);
    } catch (err) {
      log.warn('process packet threw. id=%s;err=%s', item.id, err && err.message);
    }
  }
  if (seq === runSeq) busy = false;
}

/**
 * 处理一个红包：3567 开（首次可领即领）→ 按应答更新当日额度 → 满足闸门则 3565 送祝福。
 * @param {{id:string, attempt:number}} item 队列项
 * @param {number} seq 当前 run 世代号（await 后校验，跨世代即收手）
 */
async function processPacket(item, seq) {
  rollDaily();
  if (daily.grabbed >= daily.max) {
    log.debug('daily grab cap reached, drop. id=%s;daily=%d/%d', item.id, daily.grabbed, daily.max);
    return;
  }

  var ret = await send(CMD_INFO_OPEN, { id: bits.int64(item.id) });
  if (!aliveFn() || seq !== runSeq) return;

  if (ret.code === CODE_NOT_SENT) {
    if (item.attempt + 1 < MAX_RETRY) {
      log.debug('cmd 3567 in flight, retry later. id=%s;attempt=%d', item.id, item.attempt + 1);
      ctxRef.setTimeout(function () {
        if (!aliveFn() || seq !== runSeq) return;
        queue.push({ id: item.id, attempt: item.attempt + 1 });
        drain();
      }, RETRY_DELAY_MS);
    } else {
      log.warn('cmd 3567 not sent after %d attempts, drop. id=%s', MAX_RETRY, item.id);
    }
    return;
  }
  if (!ret.ok) {
    log.info('cmd 3567 rejected. id=%s;code=%s;data=%s', item.id, ret.code, rejectText(ret) || '-');
    return;
  }

  var d = ret.data;
  var rp = d && d.redPacketInfo;
  if (!rp) {
    log.warn('cmd 3567 resp without redPacketInfo. id=%s', item.id);
    return;
  }

  // 当日额度以应答为权威（含游戏 UI 侧自己领掉的份额）
  daily.grabbed = Number(d.grabCountDaily) || 0;
  daily.max = Number(d.grabCountMaxDaily) || daily.max;

  var ownerUid = bits.int64Str(rp.uid);
  var expireSec = bits.int64ToNum(rp.timeExpire) / 1000;
  var expired = expireSec > 0 && expireSec <= gameData.serverTime();
  var rw = d.rewardResult;
  if (rw) {
    var gold = rw.resource ? Number(rw.resource.gold) || 0 : 0;
    log.info(
      'birthday packet grabbed. id=%s;owner=%s;gold=%d;daily=%d/%d',
      item.id,
      ownerUid,
      gold,
      daily.grabbed,
      daily.max,
    );
  } else {
    var list = rp.grabRecordList || [];
    var myUid = getUid();
    var selfGrabbed = list.some(function (g) {
      return bits.int64Str(g && g.uid) === myUid;
    });
    log.debug(
      'no reward on open. id=%s;selfGrabbed=%s;expired=%s;full=%s',
      item.id,
      selfGrabbed,
      expired,
      list.length >= (Number(rp.totalCount) || 0),
    );
  }

  // 祝福闸门（BirthdayBenedictionView 同款）：未过期 && 寿星非自己 && 未祝福过
  var myUid2 = getUid();
  if (rp.bless === 1 || expired || !ownerUid || ownerUid === myUid2) {
    log.debug(
      'blessing skipped. id=%s;bless=%s;expired=%s;self=%s',
      item.id,
      rp.bless,
      expired,
      ownerUid === myUid2,
    );
    return;
  }
  var blessRet = await send(CMD_BLESS, { year: rp.year, uid: bits.int64(ownerUid) });
  if (!aliveFn() || seq !== runSeq) return;
  if (blessRet.ok) {
    var cnt = blessRet.data ? blessRet.data.blessingCount : null;
    log.info('birthday blessing sent. owner=%s;year=%s;blessingCount=%s', ownerUid, rp.year, cnt);
  } else if (blessRet.code === CODE_NOT_SENT) {
    log.warn('cmd 3565 not sent. owner=%s;year=%s', ownerUid, rp.year);
  } else {
    log.info(
      'cmd 3565 rejected. owner=%s;code=%s;data=%s',
      ownerUid,
      blessRet.code,
      rejectText(blessRet) || '-',
    );
  }
}

// ── 生命周期 ──────────────────────────────────────────────────────────
/**
 * 安装：取网络底座。缺失即失败（reactor 不会激活）。
 * @param {object} ctx reactor 上下文
 * @returns {boolean}
 */
function install(ctx) {
  ctxRef = ctx;
  net = ctx.net;
  if (!net || !net.install()) {
    log.warn('install failed: pocketcc.net unavailable');
    net = null;
    return false;
  }
  log.info('installed.');
  return true;
}

/**
 * 运行：升世代号 + 清陈旧队列 → 挂聊天 push 订阅（任意频道）。
 * 去重表与当日额度镜像跨 pause/resume 保留（同日重复推不重领）。
 * @param {object} ctx reactor 上下文
 */
function run(ctx) {
  ctxRef = ctx;
  runSeq++;
  queue = [];
  busy = false;
  ctx.on.chat('push', onChatPush);
  log.info('started. watching chat ct=3 birthday packets.');
}

/**
 * 向 reactor 注册本功能说明书：地图限定 base/world（Home/NWorldMap）；不行军不参战故不设战斗门控；
 * 日常任务形态——面板只出启用开关，无字段无配置（额度/过期/抢光均为内置判据）。
 */
reactor.register({
  id: 'birthdayBless',
  label: '生日祝福',
  storageKey: 'pocketcc.feat.birthdayBless',
  symbols: ['dataCenter', 'long64Bit'],
  places: ['base', 'world'],
  kinds: ['homeland'],
  offInCombat: false,
  defaults: { enabled: false },
  fields: [],
  toModuleCfg: function () {
    return {};
  },
  install: install,
  run: run,
});
