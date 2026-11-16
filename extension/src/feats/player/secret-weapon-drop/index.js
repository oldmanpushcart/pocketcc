/**
 * 秘密武器·空投支援（Secret Weapon 定时奖励，reactor 说明书形态，日常任务，单链）
 *
 * 玩法（字典表 secret_weapon_38 / item_desc55200002 实证）：秘密武器特技「空投支援」(cd_skill type==2) 是**次数（charge）型**技能——
 *   使用一次即在主城空地投下一个空投建筑，可立即领取一份随机奖励；空投次数每 cd 分钟恢复一次、最多攒 max 次。
 *   日常闭环 = 「有空投次数 → 用掉一次生成空投建筑 → 收取该建筑奖励」，次数攒满则本轮无事可做，睡到恢复点再探。
 *
 * 落点必须动态、且空地不足会失败（airdrop_002「缺少足够的3*3空地，无法使用空投支援道具」、airdrop_001「受空地数量不足影响」）：
 *   空投建筑占 3×3 格，param[x,y] 是其锚点，且每次落点随当前主城占用情况变化——**绝不能硬编码固定坐标**。
 *   落点由 airDropDomain.homeAirDropSpot(9001001)（本目录 api.js，领域 ACL 下沉）提供：**直接调游戏原生
 *   HomeMap.findValidAirDropBoxArea**（UIManager.Instance().HomeMap，与 PlayerSkillController 手动施放同一函数），
 *   原生锚视口中心三级环扫（getBuildingPosNearBy/getPosNearBy/checkNearByPos），posId 经 getMapPosByPosId 换算小格坐标。
 *   活组件离开 Home 即 cpnDestroy 置 null → world 回退 core/home-snap.js 的 onSceneEnded 克隆快照（live||homeSnap()，
 *   竞品A/B 同款，用户接受侵入性钩子）；places:['base','world']，快照未就位则 fail-closed 不发（见下「投放建箱根因演进」）。
 *   皆只读查询（不改写游戏数据、不 OpenUI、不播动画）。
 *   → 发 4170 前先拿落点：拿不到（组件与快照皆缺 / 无合法空地 / 符号缺失）就**本轮不发**、退避重试，从源头避免「投放失败」。
 *
 * 协议（抓包实证）：
 *   用次数 4170 CD_SKILL_USE，走 net.sendPB（PB V1），载荷 {header:{}, cdSkillUse:{id:2, param:[x,y]}} →
 *     应答 pbAck.cdSkillUse.skill={id, start(Long64 ms), cnt, end(Long64 ms)}：cnt 为本次用掉后的**剩余次数**，
 *     end 为下一次次数恢复时刻（Long64，_high*2^32+_low 毫秒；实录该拍 end=0 表示无可解析恢复点）。
 *   收取   4168 Get_Home_Air_Drop_Reward，走 net.send（旧 JSON V1，ret.data 为 JSON 串需自 parse），
 *     载荷 {targetId:"<空投建筑实例 id>"} → 应答 d={reward:{items:[{itemId,itemCount}],resource…}}。
 *   **targetId 不在 4170 应答里**，而由紧随其后的 push 10101 PUSH_BUILDING（buildingId=9001001=空投建筑）下发的
 *     建筑实例 id（push 项形如 {buildingId:9001001, x:4, y:66, id:"4874128440122531841"}）；收取后 push 10107 建筑消失。
 *     → 本 feat 订阅 ctx.on.push(10101) 捕获它，作为待收 targetId（Home 快路径）。
 *   **投放建箱根因演进（2026-11-15 → 11-16 三轮实证，复刻路线终结）**：
 *     ① 11-15 双探针：旧版漏第三道地形校验 checkBoxTypeLegal(point_type)，选到非地面格 (41,51) → s=0 扣次数不建箱；补地形闸。
 *     ② 11-16 双号日志：补闸后 (40,55) 三闸全过（chose pointType=1），NWorldMap 投放依旧 s=0 扣次数不建箱，
 *       回主城/重载 Buildings 全量无 9001001（服务器从未建箱）；历史 45 发无一建箱，唯一成功对照 10-07 Home (4,66) 全链路。
 *       → places 收回 ['base'] 止血，并设计 Home (40,55) 判别实验（建箱=场景拒投；不建箱=坐标仍非法）。
 *     ③ 11-16 09:26 Home 判别实验（rec 092411 + 日志）：**不建箱**——4170 param=[40,55] → resp s=0、cnt 1→0，
 *       774s 录制 10101/10109 零 9001001；投放同拍服务器恰推现存建筑 71000@(41,55) 的 10109（落点 3×3 与其冲突，
 *       复刻占用闸漏算）。场景非根因，**自研环扫复刻本身漏闸（占用/对齐口径与服务器不一致），46 发零建箱，路线废弃**。
 *     → 终态修复：api.js 改调游戏原生 findValidAirDropBoxArea（手动施放同款，服务器同口径）。
 *     ④ 11-16 world 支持（用户接受侵入性）：采竞品A/B 的 HomeSnap 镜像——core/home-snap.js 钩 HomeMap.onSceneEnded
 *       离场景前克隆组件实例，world 里 live||homeSnap() 回退原生选点；places 放宽 ['base','world']。快照冻结于离开 Home 一刻，
 *       未就位（从未进过 Home）则 fail-closed 不发。核验链：homeAirDropSpot chose（原生 posId）→ air drop used →
 *       air drop box landed(10101) → air drop collected(reward)。
 *     空投不会超时消失（实例存活约 7 个月仍可领，「服务器自动结算」被证伪）。
 *   收取兜底走 UserData.Buildings 权威快照（游戏登录全量 + 10101/10109 合并 + 10107/10117 删除维护，HomeMap.InitBuildings 的同一数据源）：
 *     seedFromBuildings() 扫描 BuildingId==9001001 的实例 id（airDropDomain.airDropInstances）灌入待收队，
 *     run() 开机 / HomeMapLoadFinish（回主城）/ 10109 快照推送三路触发，每拍头部再兜底扫一次；collected 按 id 去重，同实例不重复收。
 *   发 4170 前先查 CD_SKILL_INFO(4169) 拿服务器权威次数/冷却：可用次数 available = min(cnt + 自 start 起按 cd 分钟累计的整数枚, max)（复刻
 *     PlayerSkillController.getSkillUseEnableNum）。available>0 才发 4170；available<=0（冷却中/无次数）**直接睡到下一枚恢复点、不发**，
 *     从源头杜绝服务器回 code=3（「技能未就绪」拒绝）；不再靠盲发试错。
 *
 * 直发不回写 → 本地内存镜像：脚本发 4170/4168 不经游戏回调，不更新游戏侧技能态（游戏自身靠 10101/10107 push 维护 HomeMap 占用，
 *   我们 hook 在原生 onMessage 之后，故 HomeMap 空地判定与真实占用一致）。对策：已收 targetId 记入 collected 内存表，
 *   同实例不重复收（每次空投新实例 id，天然不冲突）；连续被拒 rejectStreak 退避。
 *
 * 调度（A 族 createCycle，触发合并 + 单飞闸门 + 绝不停摆收口 cycle；每拍先 4169 查就绪态再决定发不发 4170）：
 *   - 冷却中/无次数（available<=0）：不发 4170，睡到 nextMs 下一枚恢复点 + 缓冲（无有效恢复点则 PROBE 盲探）；
 *   - cd_skill 表符号漂移（无法判定就绪态）：保守不发，短间隔再查；
 *   - 有次数但拿不到落点（组件与快照皆缺 / 原生选点无合法空地 / 符号缺失）：本轮不发（次数未消耗），NO_SPACE_RETRY 短间隔重试；
 *   - 有次数（攒着最多 max 枚）：同一拍内按 4170 应答 cnt 连续投放直到用尽出 CD（每发间隔 DRAIN_GAP）；末发 cnt=0 后交下一拍 4169 拿精确恢复点；
 *   - 待收队列非空：收敛到收失败重试点，绝不让空投干等整轮；连续被拒退 PROBE×2。
 *
 * 合规：只读游戏数据（经 game-api ACL，含原生落点查询）+ 直发 4170(sendPB)/4168(send)，不调用游戏 Update/Delete 改写本地态、不 OpenUI、不模拟点击、不播动画。
 *   例外（用户 2026-11-16 接受）：core/home-snap.js 钩 HomeMap.onSceneEnded 克隆离场景快照以支持 world 选点——只读克隆后调原版，不改游戏数据态。
 * 不行军不参战，不设 offInCombat；生命周期由 reactor 托管：全部 ctx.on.* 订阅挂 run()（pause 统一摘除、每次激活重挂；
 *   挂 install 会在 pause→resume 后永久丢订阅——真机事故：暂停后投放的空投捕获不到、收取计数恒 0）。
 * 面板：playerBasics 组子项，启用开关 + 一行只读当日进度（inlineStatus），无可调参数（落点全自动）。
 * 当日次数口径（定稿）：动作类计脚本——4170 投放受理成功逐次 +1、4168 收取受理成功逐次 +1，
 *   core/daily-stats 日账跨页持久，面板「投放 N · 收取 M」；次数（charge）按 cd 恢复非日重置，不作分母。
 */
import { CODE_NOT_SENT, sleep, rejectText } from '../../../core/util.js';
import { createLog } from '../../../core/log.js';
import { bus, EVT } from '../../../core/bus.js';
import { bits, gameData } from '../../../core/game-api.js';
import { airDropDomain } from './api.js';
import { installHomeSnap } from '../../../core/home-snap.js';
import { item } from '../../../core/item.js';
import { reactor } from '../../../core/reactor.js';
import { createCycle } from '../../../core/cycle.js';
import { createDailyLedger } from '../../../core/daily-stats.js';

import { CMD_USE_SKILL, CMD_COLLECT, CMD_SKILL_INFO } from './constants.js';

/** @type {ReturnType<createLog>} 模块日志器（tag=SECRET-WEAPON） */
const log = createLog('SECRET-WEAPON');

/** @type {number} 空投支援特技 id（cd_skill 表 type==2 项，实录 id=2） */
const SKILL_ID_AIRDROP = 2;
/** @type {number} 空投建筑 buildingId（findValidAirDropBoxArea 入参 + push 10101 里标记本次空投的落点建筑） */
const BUILDING_ID_AIRDROP = 9001001;

/** @type {number} 无恢复点信号时的盲探间隔（毫秒）：次数按 cd 分钟恢复，低频试探即可 */
const PROBE_INTERVAL = 1000 * 60 * 20;
/** @type {number} cnt>0 时续用下一 charges 的短间隔（毫秒），留应答落地/空地刷新余量 */
const DRAIN_GAP_MS = 1000 * 3;
/** @type {number} 单拍内连续投放的次数上限（安全阀，远大于 max 攒数；防止服务器 cnt 异常导致空转） */
const DRAIN_MAX_USES = 8;
/** @type {number} 发完 4170 后等待 push 10101 落地的静置毫秒（实录 push 与应答近乎同拍，给足抖动） */
const DROP_SETTLE_MS = 800;
/** @type {number} 空投建筑恢复点（end）到点后的补探余量（毫秒），避开服务器结算时序 */
const RECOVER_BUFFER_MS = 1000 * 15;
/** @type {number} 待收队列非空时的重试收敛间隔（毫秒），别让空投干等整轮 */
const COLLECT_RETRY_MS = 1000 * 20;
/** @type {number} 空地不足/无 HomeMap 时的重试间隔（毫秒）：收取腾地或回到大本营后尽快再试 */
const NO_SPACE_RETRY_MS = 1000 * 60 * 3;
/** @type {number} 连续被服务器拒绝次数达此数则加倍退避 */
const REJECT_STREAK_MAX = 3;
/** 【受控实验 2026-11-15】自动收取总闸。true=投放后自动 4168 收取（端到端验 Home 发+收，靠 box landed/collected 日志核验）；
 *  false=保留地面箱子供人工切回主城肉眼核验。背景见头注释「投放建箱根因」「world 投放回退」。 */
const COLLECT_ENABLED = true;

/** @type {object|null} 网络底座（promise 封装 pocketcc.net） */
var net;
/** @type {object|null} reactor 上下文；alive() 反映运行态，pause 后置否让在飞流程自然退出 */
var ctxRef = null;

/** @type {Array<{id:string, ts:number}>} push 10101 捕获的空投建筑实例待收队列（最旧在前） */
var drops = [];
/** @type {Object<string,boolean>} 已收/已判定消失的实例 id（内存镜像，防同实例重复收，直发不回写补偿） */
var collected = Object.create(null);
/** @type {number} 连续被服务器拒绝次数（无次数等），达 REJECT_STREAK_MAX 加倍退避；任一成功清零 */
var rejectStreak = 0;
/** @type {number|null} 最近一次 4170 应答回读的剩余次数 cnt（仅面板态览展示） */
// eslint-disable-next-line no-unused-vars -- 面板态览预留：当前只写未读，接入展示时自然消费
var lastCnt = null;
/** @type {string} 最近一次投放使用的落点串「x,y」（仅面板态览展示） */
var lastSpot = '';

/** @type {import('../../../core/daily-stats.js').DailyLedger} 当日动作日账（drop=4170 投放 / collect=4168 收取） */
const dropLedger = createDailyLedger('pocketcc.daily.secretWeaponDrop');

/**
 * 功能是否仍在运行（cycle 与在飞流程的存活判定）
 * @returns {boolean}
 */
function aliveFn() {
  return ctxRef ? ctxRef.alive() : false;
}

// ── 小工具 ──────────────────────────────────────────────────────────────
// long64Ms 已收口到 core/acl/bits.js 的 bits.int64ToNum（时间戳量纲，经 game-api 门面取 bits）

/**
 * 旧 JSON 链路应答归一化：ret.data 通常是 JSON 串（游戏侧 JSON_PARSE(t.d)），兜底已是对象
 * @param {object} ret net.Ret
 * @returns {object|null} 解析后的业务数据；非对象返回 null
 */
function payloadOf(ret) {
  var d = ret && ret.data;
  if (typeof d === 'string') {
    try {
      d = JSON.parse(d);
    } catch (e) {
      return null;
    }
  }
  return d && typeof d === 'object' ? d : null;
}

// ── 发包 ────────────────────────────────────────────────────────────────
/**
 * 查询秘密武器空投的服务器权威次数/冷却（CD_SKILL_INFO 4169 sendPB），交 ACL 按 cd_skill 表算出可用次数。
 * 发 4170 前置闸门：available<=0（冷却中/无次数）就不得发包，否则服务器直接回 code=3 拒绝。永不 reject。
 * @returns {Promise<{ok:boolean, code:number, drift?:boolean, available:number, nextMs:number, cnt:(number|null), max:number}>}
 */
async function queryCharges() {
  var ret = await net.sendGuarded(
    CMD_SKILL_INFO,
    { header: {} },
    {
      protocol: 'sendPB',
      onError: function (err) {
        log.warn('cmd %d send threw: %s', CMD_SKILL_INFO, err && err.message);
      },
    },
  );
  if (!ret || !ret.ok)
    return {
      ok: false,
      code: ret ? ret.code : CODE_NOT_SENT,
      available: -1,
      nextMs: 0,
      cnt: null,
      max: 0,
    };
  // PB V1 业务数据在 pbAck.cdSkillInfo（net.sendPB 整体回 pbAck，无 .data 包装）
  var info = ret.data && ret.data.cdSkillInfo;
  var skills = info && info.skills;
  var skill = null;
  if (Array.isArray(skills)) {
    for (var i = 0; i < skills.length; i++) {
      if (Number(skills[i].id) === SKILL_ID_AIRDROP) {
        skill = skills[i];
        break;
      }
    }
  }
  var st = airDropDomain.cdSkillAvailability(SKILL_ID_AIRDROP, skill);
  if (!st) return { ok: false, code: 0, drift: true, available: -1, nextMs: 0, cnt: null, max: 0 }; // cd_skill 表不可用（符号漂移）
  return {
    ok: true,
    code: 0,
    available: st.available,
    nextMs: st.nextMs,
    cnt: st.cnt,
    max: st.max,
  };
}

/**
 * 用掉一次空投次数（4170 sendPB）。发前先经 ACL 拿动态落点（Home 活组件或 world 快照原生选点）：拿不到（组件与快照皆缺/无合法空地/符号缺失）即 noSpace 返回、不发包。
 * isSending 去重闸门；永不 reject。
 * @returns {Promise<{ok:boolean, noSpace?:boolean, code:number, cnt:number, recoverMs:number, data?:*, reason?:string}>} 失败时带上原始应答载荷
 */
async function useCharge() {
  var spot = airDropDomain.homeAirDropSpot(BUILDING_ID_AIRDROP);
  if (!spot) return { ok: false, noSpace: true, code: 0, cnt: 0, recoverMs: 0 };
  lastSpot = spot.x + ',' + spot.y;
  var ret = await net.sendGuarded(
    CMD_USE_SKILL,
    { header: {}, cdSkillUse: { id: SKILL_ID_AIRDROP, param: [spot.x, spot.y] } },
    {
      protocol: 'sendPB',
      onError: function (err) {
        log.warn('cmd %d send threw: %s', CMD_USE_SKILL, err && err.message);
      },
    },
  );
  if (!ret || !ret.ok)
    return {
      ok: false,
      code: ret ? ret.code : CODE_NOT_SENT,
      cnt: 0,
      recoverMs: 0,
      data: ret && ret.data,
      reason: ret && ret.reason,
    };
  // PB V1 业务数据在 pbAck 命名子字段 cdSkillUse（net.sendPB 整体回 pbAck，无 .data 包装）
  var skill = ret.data && ret.data.cdSkillUse && ret.data.cdSkillUse.skill;
  var cnt = skill ? Number(skill.cnt) || 0 : 0;
  var recoverMs = skill ? bits.int64ToNum(skill.end) : 0;
  lastCnt = cnt;
  return { ok: true, code: 0, cnt: cnt, recoverMs: recoverMs };
}

/**
 * 收取一个空投建筑奖励（4168 send JSON）。isSending 去重闸门；永不 reject。
 * @param {string} targetId 空投建筑实例 id
 * @returns {Promise<{ok:boolean, code:number, items:Array, data?:*, reason?:string}>} 失败时带上原始应答载荷
 */
async function collectOne(targetId) {
  var ret = await net.sendGuarded(
    CMD_COLLECT,
    { targetId: targetId },
    {
      onError: function (err) {
        log.warn('cmd %d send threw: %s', CMD_COLLECT, err && err.message);
      },
    },
  );
  if (!ret || !ret.ok)
    return {
      ok: false,
      code: ret ? ret.code : CODE_NOT_SENT,
      items: [],
      data: ret && ret.data,
      reason: ret && ret.reason,
    };
  var d = payloadOf(ret);
  var items = d && d.reward && Array.isArray(d.reward.items) ? d.reward.items : [];
  return { ok: true, code: 0, items: items };
}

/**
 * 清扫待收队列：逐个 4168 收取，成功/判定消失即出队并记 collected，在途留队待下次唤醒。永不 reject。
 * @returns {Promise<void>}
 */
async function collectPending() {
  if (!COLLECT_ENABLED) return; // 收取总闸（实验开关）：false 时保留箱子供人工肉眼核验（见 COLLECT_ENABLED）
  for (var i = 0; i < drops.length;) {
    if (!aliveFn()) return;
    var d = drops[i];
    if (collected[d.id]) {
      drops.splice(i, 1);
      continue;
    }
    log.debug('collect attempt. target=%s', d.id);
    var r = await collectOne(d.id);
    if (!aliveFn()) return;
    if (r.ok) {
      collected[d.id] = true;
      drops.splice(i, 1);
      dropLedger.bump('collect');
      var desc = r.items.length
        ? r.items
            .map(function (it) {
              return item.label(it.itemId) + '×' + (it.itemCount || 0);
            })
            .join(', ')
        : '无物品';
      log.info('air drop collected. target=%s; reward=%s', d.id, desc);
      bus.emit(EVT.UI_REFRESH);
    } else if (r.code === CODE_NOT_SENT) {
      i++; // 在途/超时：留队，下次唤醒或重试拍再收
    } else {
      // 非 0 码：建筑多半已被游戏侧收取/消失，判该实例终结，出队不再重试
      collected[d.id] = true;
      drops.splice(i, 1);
      log.info(
        'air drop collect rejected, treat as gone. target=%s;code=%d;data=%s',
        d.id,
        r.code,
        rejectText(r) || '-',
      );
    }
  }
}

/**
 * push 10101 处理器（Home 快路径）：捕获空投建筑实例 id 入待收队（只认 buildingId=9001001、未收过者）。
 * world 是否推此包待验（前提 B）；不推则靠 seedFromBuildings() 的 Buildings 快照兜底。
 * @param {object} ev net Event（data 已 JSON.parse）
 */
function onPushBuilding(ev) {
  var d = ev && ev.data;
  if (!d || Number(d.buildingId) !== BUILDING_ID_AIRDROP || !d.id) return;
  var id = String(d.id);
  if (collected[id]) return;
  for (var i = 0; i < drops.length; i++) {
    if (drops[i].id === id) return;
  } // 去重
  drops.push({ id: id, ts: Number(d.createTime) || 0 });
  log.info('air drop box landed. target=%s; pos=(%s,%s)', id, d.x, d.y); // 前提 B 核验点：服务器真建箱（10101 带实例 id）
  cycle.kick(); // 有新空投落地，尽快唤醒收取
}

/**
 * Buildings 权威播种：扫描 UserData.Buildings 里地面空投实例入待收队（collected + 在队双重去重）。
 * Buildings 由登录全量 + 10101/10109 合并 + 10107/10117 删除维护，是场景无关的常驻单例；
 * world 投放的空投回主城后才进里头——此扫描即「推送不带 id」场景的收取兜底。本地只读，可高频调用。
 * @returns {number} 本次新入队条数
 */
function seedFromBuildings() {
  var added = 0;
  try {
    var existing = airDropDomain.airDropInstances(BUILDING_ID_AIRDROP);
    for (var i = 0; i < existing.length; i++) {
      var iid = existing[i];
      if (!iid || collected[iid]) continue;
      var dup = false;
      for (var j = 0; j < drops.length; j++) {
        if (drops[j].id === iid) {
          dup = true;
          break;
        }
      }
      if (!dup) {
        drops.push({ id: iid, ts: 0 });
        added++;
      }
    }
    if (added) log.info('seeded %d air drop(s) from Buildings snapshot.', added);
  } catch (err) {
    log.warn('seed existing air drops failed.', err);
  }
  return added;
}

/**
 * Buildings 刷新信号（10109 批量快照推送 / HomeMapLoadFinish 主城加载完成）：游戏已把快照合并进 Buildings
 * （我方 push hook 在原生处理器之后派发），扫描播种并立即唤醒收取。不解析 push 载荷——world 里它可能是空 buildings。
 */
function onBuildingsSnapshot() {
  if (seedFromBuildings()) cycle.kick();
}

// ── 择时 ────────────────────────────────────────────────────────────────
/**
 * 睡到下一次空投次数恢复点（end 毫秒）+ 缓冲；无有效未来点返回 null。
 * @param {number} recoverMs 应答回读的恢复时刻（毫秒）
 * @returns {number|null} 相对毫秒
 */
function recoverDelay(recoverMs) {
  if (!(recoverMs > 0)) return null;
  var nowMs = gameData.serverTime() * 1000;
  var left = recoverMs - nowMs + RECOVER_BUFFER_MS;
  if (left <= 0) return null;
  return Math.min(left, 24 * 3600 * 1000); // 游戏 skill.end 为显式恢复时刻，直接睡到该点；仅 24h 硬顶防时钟异常超睡
}

// ── 主流程 ──────────────────────────────────────────────────────────────
/**
 * cycle 单轮：Buildings 兜底播种 → 清扫待收 → 查 4169 拿服务器权威次数/冷却作前置闸门 → 仅当 available>0 才发 4170（发前动态找落点）→ 静置等 push 落地再扫一轮。永不 reject。
 * @returns {Promise<number>} 下拍间隔（毫秒）；<=0 立即再跑
 */
async function cycleRun() {
  installHomeSnap(); // 幂等补装：world 激活时 HomeMap 类可能未加载（run() 那次返回 false），base↔world 不 pause/resume 无再激活，靠每拍重试；装好后仅一次布尔判断零开销
  seedFromBuildings(); // 本地只读兜底：world 投放的空投回主城才进 Buildings，不依赖推送/事件是否到达
  await collectPending();
  if (!aliveFn()) return 0;

  // 前置闸门：先查 4169 拿服务器权威次数/冷却。available<=0（冷却中/无次数）就绝不发 4170，否则服务器直接回 code=3。
  var charge = await queryCharges();
  log.debug(
    'charge query: ok=%d, code=%d, available=%d, nextMs=%d, drift=%d.',
    charge.ok ? 1 : 0,
    charge.code,
    charge.available,
    charge.nextMs || 0,
    charge.drift ? 1 : 0,
  );
  var delay;
  if (charge.drift) {
    log.warn(
      'cd_skill config unavailable (symbol drift); cannot judge readiness, skip use this round.',
    );
    delay = NO_SPACE_RETRY_MS; // 无法判定就绪态，保守不发，短间隔再查
  } else if (!charge.ok) {
    delay = charge.code === CODE_NOT_SENT ? COLLECT_RETRY_MS : PROBE_INTERVAL; // 在途/超时短间隔重来；其它异常按盲探
  } else if (charge.available <= 0) {
    lastCnt = 0;
    bus.emit(EVT.UI_REFRESH);
    var rd = recoverDelay(charge.nextMs);
    delay = rd != null ? rd : PROBE_INTERVAL; // 睡到下一枚次数恢复点（无有效恢复点则盲探）
  } else {
    // 有攒着的次数（最多 max 枚）：本拍连续投放直到次数用尽出 CD。
    // 4170 应答里 skill.cnt = 服务器给的本发用掉后剩余次数，据此续投，无需每发都重查 4169。
    lastCnt = charge.available;
    bus.emit(EVT.UI_REFRESH);
    delay = DRAIN_GAP_MS;
    var exhausted = false;
    for (var n = 0; n < DRAIN_MAX_USES && aliveFn(); n++) {
      var use = await useCharge(); // 发前动态找落点；无落点则 noSpace 不发包
      if (use.ok) {
        rejectStreak = 0;
        lastCnt = use.cnt;
        dropLedger.bump('drop');
        bus.emit(EVT.UI_REFRESH);
        log.info('air drop used. spot=(%s);remaining=%d.', lastSpot, use.cnt);
        await sleep(DROP_SETTLE_MS, ctxRef && ctxRef.signal);
        await collectPending();
        if (use.cnt <= 0) {
          exhausted = true;
          break;
        } // 这一发把次数用尽 → 出 CD
        await sleep(DRAIN_GAP_MS, ctxRef && ctxRef.signal); // 还有剩余次数，短间隔接着投
        delay = DRAIN_GAP_MS;
      } else if (use.noSpace) {
        log.debug(
          'no valid air-drop spot (game findValidAirDropBoxArea: no HomeMap live or snapshot / no legal free area / symbols missing); stop drain this round.',
        );
        delay = NO_SPACE_RETRY_MS; // 有次数但腾不出空地：未发包、次数未消耗，空地腾出后再试
        break;
      } else if (use.code === CODE_NOT_SENT) {
        log.debug('air drop use not sent (in-flight/timeout); stop drain this round.');
        delay = COLLECT_RETRY_MS; // 在途/超时：瞬态，下拍重来
        break;
      } else {
        rejectStreak++;
        log.info(
          'air drop use rejected (streak #%d). code=%d;data=%s',
          rejectStreak,
          use.code,
          rejectText(use) || '-',
        );
        delay = rejectStreak >= REJECT_STREAK_MAX ? PROBE_INTERVAL * 2 : PROBE_INTERVAL;
        break;
      }
    }
    // 次数用尽出 CD：4170 应答的 skill.end 实为 0（实录报文：cnt=0 时 end={_low:0,_high:0}），恢复时刻只在 4169 里，
    // 故本拍不据此 sleep；交下拍 4169 拿权威 end 再睡到恢复点（驱动器会打 next check at）。本拍短隔先让落地奖励（push 10101→drops）被收取。
    if (exhausted) {
      log.info(
        'air drop charges exhausted (remaining=0); next 4169 round will schedule cooldown to recovery.',
      );
      delay = DRAIN_GAP_MS;
    }
  }

  // 待收非空 → 收敛到重试点，绝不让空投干等整轮
  if (COLLECT_ENABLED && drops.length) delay = Math.min(delay, COLLECT_RETRY_MS);
  if (cycle.pending) return 0; // 本轮在飞时又有空投落地 → 立即补扫
  return Math.max(delay, 1000);
}

const cycle = createCycle({ log: log, alive: aliveFn, run: cycleRun, fallback: PROBE_INTERVAL });

/**
 * 安装：取网络底座。缺失即失败（reactor 不会激活）。
 * push/事件订阅一律挂 run()（pause 统一摘除、每次激活重挂）；install 一生只跑一次，不在此挂任何触发器。
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
 * 运行：挂订阅 → Buildings 播种 → 立即跑一轮。待收队列/退避每次点火重置（collected 保留至下次 reload，实例 id 天然不复用）。
 * 订阅必须挂这里：pause 统一摘除 ctx.on.* 触发器而 install 一生只跑一次，挂那边会在 pause→resume 后永久丢 push。
 * @param {object} ctx reactor 上下文
 */
function run(ctx) {
  ctxRef = ctx;
  installHomeSnap(); // 幂等装 onSceneEnded 克隆钩子（world 原生选点回退）；HomeMap 类未加载则 cycleRun 每拍补装
  rejectStreak = 0;
  lastCnt = null;
  lastSpot = '';
  drops = [];
  dropLedger.ensureLoaded();
  ctx.on.push(10101, onPushBuilding); // Home 快路径：单建筑推送直接带实例 id
  ctx.on.push(10109, onBuildingsSnapshot); // 批量建筑快照（含回主城/登录全量）→ 权威播种
  // 事件名是 EventId 的值（字符串 "HomeMapLoadFinish"，EventId.js:732；boot.js 主城门控已真机验证触发）。
  ctx.on.event('HomeMapLoadFinish', onBuildingsSnapshot);
  // 开机播种：开启前地面上已存的空投不会重推 10101，直接扫 Buildings 入待收队，首个 cycleRun 的 collectPending 领取。
  seedFromBuildings();
  log.info('started.');
  cycle.kick();
}

/**
 * 向 reactor 注册本功能说明书：places:['base','world'] 大本营与世界地图均可投放（2026-11-16：原生选点 + core/home-snap.js
 * 的 onSceneEnded 克隆快照支持 world，用户接受侵入性钩子，见头注释「投放建箱根因演进」；base↔world 同属允许档不 pause、
 * 订阅常驻，出本服图/战斗等才 pause 摘订阅、回来 resume 重挂播种）；不行军不参战不设战斗门控；playerBasics 组子项，启用开关 + 一行只读当日进度，无可调参数。
 */
reactor.register({
  id: 'secretWeaponDrop',
  label: '秘密武器空投',
  storageKey: 'pocketcc.feat.secretWeaponDrop',
  symbols: ['dataCenter', 'uiManager', 'homeMapUtils'],
  places: ['base', 'world'],
  kinds: ['homeland'],
  offInCombat: false,
  defaults: { enabled: false },
  fields: [
    {
      key: '_dropInfo',
      type: 'text',
      label: '今日',
      get: function () {
        if (!dropLedger.loaded()) return '—';
        return '投放 ' + dropLedger.get('drop') + ' · 收取 ' + dropLedger.get('collect');
      },
    },
  ],
  toModuleCfg: function () {
    return {};
  },
  install: install,
  run: run,
});
