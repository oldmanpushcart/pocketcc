/**
 * 秘密武器·空投支援（Secret Weapon 定时奖励，reactor 说明书形态，日常任务，单链）
 *
 * 玩法（字典表 secret_weapon_38 / item_desc55200002 实证）：秘密武器特技「空投支援」(cd_skill type==2) 是**次数（charge）型**技能——
 *   使用一次即在主城空地投下一个空投建筑，可立即领取一份随机奖励；空投次数每 cd 分钟恢复一次、最多攒 max 次。
 *   日常闭环 = 「有空投次数 → 用掉一次生成空投建筑 → 收取该建筑奖励」，次数攒满则本轮无事可做，睡到恢复点再探。
 *
 * 落点必须动态、且空地不足会失败（airdrop_002「缺少足够的3*3空地，无法使用空投支援道具」、airdrop_001「受空地数量不足影响」）：
 *   空投建筑占 3×3 格，param[x,y] 是其锚点，且每次落点随当前主城占用情况变化——**绝不能硬编码固定坐标**。
 *   落点由 gameData.homeAirDropSpot(9001001)（game-api ACL）提供，**场景无关**：不依赖游戏 HomeMap 组件（它离开 Home 即被
 *   cpnDestroy 置 null），而是用三份常驻/静态数据复刻 findValidAirDropBoxArea 的判定——
 *     占用：DataCenter.UserData.Buildings（HomeMap.InitBuildings 的同一数据源）footprint，等距格由游戏自身 getMapPosList 生成；
 *     合法性：HomeMapUtils.checkHomeBoxLegal（静态表 HomeMapTileBlockTypeTable）；空投尺寸：BUILDING 表 9001001 行。
 *   原版把种子锚在视口中心再螺旋外扩，本实现改锚主城网格中心由近及远扫，优先落在早期已解锁的核心地块。
 *   皆只读查询（不改写游戏数据、不 OpenUI、不播动画）。
 *   → 发 4170 前先拿落点：拿不到（核心区空地不足 / 符号缺失）就**本轮不发**、退避重试，从源头避免「投放失败」。
 *
 * 协议（抓包实证 20261007T121130-秘密武器-收取奖励.ndjson，有效闭环 seq 4-24）：
 *   用次数 4170 CD_SKILL_USE，走 net.sendPB（PB V1），载荷 {header:{}, cdSkillUse:{id:2, param:[x,y]}} →
 *     应答 pbAck.cdSkillUse.skill={id, start(Long64 ms), cnt, end(Long64 ms)}：cnt 为本次用掉后的**剩余次数**，
 *     end 为下一次次数恢复时刻（Long64，_high*2^32+_low 毫秒；实录该拍 end=0 表示无可解析恢复点）。
 *   收取   4168 Get_Home_Air_Drop_Reward，走 net.send（旧 JSON V1，ret.data 为 JSON 串需自 parse），
 *     载荷 {targetId:"<空投建筑实例 id>"} → 应答 d={reward:{items:[{itemId,itemCount}],resource…}}。
 *   **targetId 不在 4170 应答里**，而由紧随其后的 push 10101 PUSH_BUILDING（buildingId=9001001=空投建筑）下发的
 *     建筑实例 id（seq 7：{buildingId:9001001, x:4, y:66, id:"4874128440122531841"}）；收取后 seq 21 push 10107 建筑消失。
 *     → 本 feat 必须订阅 ctx.on.push(10101) 捕获它，作为待收 targetId。
 *     → 开机播种（默认逻辑）：开启前地面上已存的空投不会重推 10101，故 run() 直接从 UserData.Buildings（BuildingId==9001001）
 *       扫描其实例 id（gameData.airDropInstances）灌入待收队，首个 cycleRun 的 collectPending 即领取，collected 按 id 去重。
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
 *   - 有次数但拿不到落点（核心区空地不足 / 落点符号缺失）：本轮不发（次数未消耗），NO_SPACE_RETRY 短间隔重试；
 *   - 有次数（攒着最多 max 枚）：同一拍内按 4170 应答 cnt 连续投放直到用尽出 CD（每发间隔 DRAIN_GAP）；末发 cnt=0 后交下一拍 4169 拿精确恢复点；
 *   - 待收队列非空：收敛到收失败重试点，绝不让空投干等整轮；连续被拒退 PROBE×2。
 *
 * 合规：只读游戏数据（经 game-api ACL，含场景无关的落点查询）+ 直发 4170(sendPB)/4168(send)，不调用游戏 Update/Delete 改写本地态、不 OpenUI、不模拟点击、不播动画。
 * 不行军不参战，不设 offInCombat；生命周期由 reactor 托管，pause 摘 push 订阅、resume 重 kick。
 * 面板：独立 feature 卡片（showFields），只出一个只读态览（待收数 / 上次剩余次数 / 上次落点），无可调参数（落点全自动）。
 */
import { createLog } from '../../core/log.js';
import { bus } from '../../core/bus.js';
import { gameData } from '../../core/game-api.js';
import { item } from '../../core/item.js';
import { reactor } from '../../core/reactor.js';
import { createCycle } from '../../core/cycle.js';

/** @type {ReturnType<createLog>} 模块日志器（tag=SECRET-WEAPON） */
const log = createLog('SECRET-WEAPON');

/** @type {number} RequestId.CD_SKILL_USE，使用秘密武器特技（PB V1），载荷 {header,cdSkillUse:{id,param:[x,y]}} */
const CMD_USE_SKILL = 4170;
/** @type {number} RequestId.Get_Home_Air_Drop_Reward，收取空投建筑奖励（旧 JSON V1），载荷 {targetId} */
const CMD_COLLECT = 4168;
/** @type {number} RequestId.CD_SKILL_INFO，查询秘密武器特技次数/冷却（PB V1），载荷 {header:{}} → pbAck.cdSkillInfo.skills[]={id,start,cnt,end}。发 4170 前的权威闸门 */
const CMD_SKILL_INFO = 4169;

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
const DROP_SETTLE_MS = 1000 * 800;
/** @type {number} 空投建筑恢复点（end）到点后的补探余量（毫秒），避开服务器结算时序 */
const RECOVER_BUFFER_MS = 1000 * 15;
/** @type {number} 待收队列非空时的重试收敛间隔（毫秒），别让空投干等整轮 */
const COLLECT_RETRY_MS = 1000 * 20;
/** @type {number} 空地不足/无 HomeMap 时的重试间隔（毫秒）：收取腾地或回到大本营后尽快再试 */
const NO_SPACE_RETRY_MS = 1000 * 60 * 3;
/** @type {number} 连续被服务器拒绝次数达此数则加倍退避 */
const REJECT_STREAK_MAX = 3;
/** @type {number} 非服务器返回的哨兵 code（在途频控/发送异常，与真实 s 码区分，不当无次数退避） */
const CODE_NOT_SENT = -1;

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

/**
 * 功能是否仍在运行（cycle 与在飞流程的存活判定）
 * @returns {boolean}
 */
function aliveFn() {
  return ctxRef ? ctxRef.alive() : false;
}

// ── 小工具 ──────────────────────────────────────────────────────────────
/**
 * Long64（{_low,_high}）→ 毫秒数值；PB V1 时间戳按无符号高低位拼装（实证 start _high=417/_low=335025395 → ~2.7h 前的 ms 时刻）
 * @param {object} o 可能是 {low,high} 也可能是 {_low,_high}
 * @returns {number} 毫秒；无效返回 0
 */
function long64Ms(o) {
  if (!o || typeof o !== 'object') return 0;
  var lo = Number(o._low != null ? o._low : o.low);
  var hi = Number(o._high != null ? o._high : o.high);
  if (!isFinite(lo) || !isFinite(hi)) return 0;
  if (lo < 0) lo += 4294967296; // _low 若为有符号负值补回无符号
  return hi * 4294967296 + lo;
}

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

/**
 * 等待毫秒（裸 sleep，pause 语义由循环内 aliveFn() 检查承担）
 * @param {number} ms 毫秒
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, Math.max(0, ms | 0));
  });
}

// ── 发包 ────────────────────────────────────────────────────────────────
/**
 * 查询秘密武器空投的服务器权威次数/冷却（CD_SKILL_INFO 4169 sendPB），交 ACL 按 cd_skill 表算出可用次数。
 * 发 4170 前置闸门：available<=0（冷却中/无次数）就不得发包，否则服务器直接回 code=3 拒绝。永不 reject。
 * @returns {Promise<{ok:boolean, code:number, drift?:boolean, available:number, nextMs:number, cnt:(number|null), max:number}>}
 */
async function queryCharges() {
  if (net.isSending(CMD_SKILL_INFO))
    return { ok: false, code: CODE_NOT_SENT, available: -1, nextMs: 0, cnt: null, max: 0 };
  var ret;
  try {
    ret = await net.sendPB(CMD_SKILL_INFO, { header: {} });
  } catch (err) {
    log.debug('cmd %d send failed: %s', CMD_SKILL_INFO, err && err.message);
    return { ok: false, code: CODE_NOT_SENT, available: -1, nextMs: 0, cnt: null, max: 0 };
  }
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
  var st = gameData.cdSkillAvailability(SKILL_ID_AIRDROP, skill);
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
 * 用掉一次空投次数（4170 sendPB）。发前先经 ACL 拿动态落点（场景无关）：拿不到（核心区空地不足/符号缺失）即 noSpace 返回、不发包。
 * isSending 去重闸门；永不 reject。
 * @returns {Promise<{ok:boolean, noSpace?:boolean, code:number, cnt:number, recoverMs:number}>}
 */
async function useCharge() {
  var spot = gameData.homeAirDropSpot(BUILDING_ID_AIRDROP);
  if (!spot) return { ok: false, noSpace: true, code: 0, cnt: 0, recoverMs: 0 };
  lastSpot = spot.x + ',' + spot.y;
  if (net.isSending(CMD_USE_SKILL)) return { ok: false, code: CODE_NOT_SENT, cnt: 0, recoverMs: 0 };
  var ret;
  try {
    ret = await net.sendPB(CMD_USE_SKILL, {
      header: {},
      cdSkillUse: { id: SKILL_ID_AIRDROP, param: [spot.x, spot.y] },
    });
  } catch (err) {
    log.debug('cmd %d send failed: %s', CMD_USE_SKILL, err && err.message);
    return { ok: false, code: CODE_NOT_SENT, cnt: 0, recoverMs: 0 };
  }
  if (!ret || !ret.ok)
    return { ok: false, code: ret ? ret.code : CODE_NOT_SENT, cnt: 0, recoverMs: 0 };
  // PB V1 业务数据在 pbAck 命名子字段 cdSkillUse（net.sendPB 整体回 pbAck，无 .data 包装）
  var skill = ret.data && ret.data.cdSkillUse && ret.data.cdSkillUse.skill;
  var cnt = skill ? Number(skill.cnt) || 0 : 0;
  var recoverMs = skill ? long64Ms(skill.end) : 0;
  lastCnt = cnt;
  return { ok: true, code: 0, cnt: cnt, recoverMs: recoverMs };
}

/**
 * 收取一个空投建筑奖励（4168 send JSON）。isSending 去重闸门；永不 reject。
 * @param {string} targetId 空投建筑实例 id
 * @returns {Promise<{ok:boolean, code:number, items:Array}>}
 */
async function collectOne(targetId) {
  if (net.isSending(CMD_COLLECT)) return { ok: false, code: CODE_NOT_SENT, items: [] };
  var ret;
  try {
    ret = await net.send(CMD_COLLECT, { targetId: targetId });
  } catch (err) {
    log.debug('cmd %d send failed: %s', CMD_COLLECT, err && err.message);
    return { ok: false, code: CODE_NOT_SENT, items: [] };
  }
  if (!ret || !ret.ok) return { ok: false, code: ret ? ret.code : CODE_NOT_SENT, items: [] };
  var d = payloadOf(ret);
  var items = d && d.reward && Array.isArray(d.reward.items) ? d.reward.items : [];
  return { ok: true, code: 0, items: items };
}

/**
 * 清扫待收队列：逐个 4168 收取，成功/判定消失即出队并记 collected，在途留队待下次唤醒。永不 reject。
 * @returns {Promise<void>}
 */
async function collectPending() {
  for (var i = 0; i < drops.length;) {
    if (!aliveFn()) return;
    var d = drops[i];
    if (collected[d.id]) {
      drops.splice(i, 1);
      continue;
    }
    var r = await collectOne(d.id);
    if (!aliveFn()) return;
    if (r.ok) {
      collected[d.id] = true;
      drops.splice(i, 1);
      var desc = r.items.length
        ? r.items
            .map(function (it) {
              return item.label(it.itemId) + '×' + (it.itemCount || 0);
            })
            .join(', ')
        : '无物品';
      log.info('air drop collected. target=%s; reward=%s', d.id, desc);
      bus.emit('ui.refresh');
    } else if (r.code === CODE_NOT_SENT) {
      i++; // 在途/超时：留队，下次唤醒或重试拍再收
    } else {
      // 非 0 码：建筑多半已被游戏侧收取/消失，判该实例终结，出队不再重试
      collected[d.id] = true;
      drops.splice(i, 1);
      log.info('air drop collect rejected, treat as gone. target=%s;code=%d', d.id, r.code);
    }
  }
}

/**
 * push 10101 处理器：捕获空投建筑实例 id 入待收队（只认 buildingId=9001001、未收过者）。
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
  cycle.kick(); // 有新空投落地，尽快唤醒收取
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
 * cycle 单轮：先清扫待收 → 查 4169 拿服务器权威次数/冷却作前置闸门 → 仅当 available>0 才发 4170（发前动态找落点）→ 静置等 push 落地再扫一轮。永不 reject。
 * @returns {Promise<number>} 下拍间隔（毫秒）；<=0 立即再跑
 */
async function cycleRun() {
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
    log.debug(
      'cd_skill config unavailable (symbol drift); cannot judge readiness, skip use this round.',
    );
    delay = NO_SPACE_RETRY_MS; // 无法判定就绪态，保守不发，短间隔再查
  } else if (!charge.ok) {
    delay = charge.code === CODE_NOT_SENT ? COLLECT_RETRY_MS : PROBE_INTERVAL; // 在途/超时短间隔重来；其它异常按盲探
  } else if (charge.available <= 0) {
    lastCnt = 0;
    bus.emit('ui.refresh');
    var rd = recoverDelay(charge.nextMs);
    delay = rd != null ? rd : PROBE_INTERVAL; // 睡到下一枚次数恢复点（无有效恢复点则盲探）
  } else {
    // 有攒着的次数（最多 max 枚）：本拍连续投放直到次数用尽出 CD。
    // 4170 应答里 skill.cnt = 服务器给的本发用掉后剩余次数，据此续投，无需每发都重查 4169。
    lastCnt = charge.available;
    bus.emit('ui.refresh');
    delay = DRAIN_GAP_MS;
    var exhausted = false;
    for (var n = 0; n < DRAIN_MAX_USES && aliveFn(); n++) {
      var use = await useCharge(); // 发前动态找落点；无落点则 noSpace 不发包
      if (use.ok) {
        rejectStreak = 0;
        lastCnt = use.cnt;
        bus.emit('ui.refresh');
        log.info('air drop used. spot=(%s);remaining=%d.', lastSpot, use.cnt);
        await sleep(DROP_SETTLE_MS);
        await collectPending();
        if (use.cnt <= 0) {
          exhausted = true;
          break;
        } // 这一发把次数用尽 → 出 CD
        await sleep(DRAIN_GAP_MS); // 还有剩余次数，短间隔接着投
        delay = DRAIN_GAP_MS;
      } else if (use.noSpace) {
        log.debug(
          'no valid air-drop spot in core land (footprint comes from BUILDING table; or placement symbols absent); stop drain this round.',
        );
        delay = NO_SPACE_RETRY_MS; // 有次数但腾不出空地：未发包、次数未消耗，空地腾出后再试
        break;
      } else if (use.code === CODE_NOT_SENT) {
        log.debug('air drop use not sent (in-flight/timeout); stop drain this round.');
        delay = COLLECT_RETRY_MS; // 在途/超时：瞬态，下拍重来
        break;
      } else {
        rejectStreak++;
        log.info('air drop use rejected (streak #%d). code=%d', rejectStreak, use.code);
        delay = rejectStreak >= REJECT_STREAK_MAX ? PROBE_INTERVAL * 2 : PROBE_INTERVAL;
        break;
      }
    }
    // 次数用尽出 CD：4170 应答的 skill.end 实为 0（实录 seq12：cnt=0 时 end={_low:0,_high:0}），恢复时刻只在 4169 里，
    // 故本拍不据此 sleep；交下拍 4169 拿权威 end 再睡到恢复点（驱动器会打 next check at）。本拍短隔先让落地奖励（push 10101→drops）被收取。
    if (exhausted) {
      log.info(
        'air drop charges exhausted (remaining=0); next 4169 round will schedule cooldown to recovery.',
      );
      delay = DRAIN_GAP_MS;
    }
  }

  // 待收非空 → 收敛到重试点，绝不让空投干等整轮
  if (drops.length) delay = Math.min(delay, COLLECT_RETRY_MS);
  if (cycle.pending) return 0; // 本轮在飞时又有空投落地 → 立即补扫
  return Math.max(delay, 1000);
}

const cycle = createCycle({ log: log, alive: aliveFn, run: cycleRun, fallback: PROBE_INTERVAL });

/**
 * 安装：取网络底座并挂 push 订阅。缺失即失败（reactor 不会激活）。
 * push 10101 经 ctx.on.push 登记，pause 由 reactor 统一摘除。
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
  ctx.on.push(10101, onPushBuilding);
  log.info('installed.');
  return true;
}

/**
 * 运行：复位在飞态 → 立即跑一轮。待收队列/退避每次点火重置（collected 保留至下次 reload，实例 id 天然不复用）。
 * @param {object} ctx reactor 上下文
 */
function run(ctx) {
  ctxRef = ctx;
  rejectStreak = 0;
  lastCnt = null;
  lastSpot = '';
  drops = [];
  // 开机播种（默认逻辑，无需开关）：开启前地面上已存在的空投不会重推 10101，故直接从 UserData.Buildings 扫描入待收队，
  // 随后首个 cycleRun 的 collectPending 逐个发 4168 领取（collected 内存表跨 run 保留，按实例 id 天然去重）。
  try {
    var existing = gameData.airDropInstances(BUILDING_ID_AIRDROP);
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
      if (!dup) drops.push({ id: iid, ts: 0 });
    }
    if (drops.length) log.info('seeded %d existing air drop(s) on ground.', drops.length);
  } catch (err) {
    log.warn('seed existing air drops failed.', err);
  }
  log.info('started.');
  cycle.kick();
}

/**
 * 向 reactor 注册本功能说明书：场景 ['Home','NWorldMap']（落点查询已场景无关，两个主场景均可跑）；
 * 不行军不参战不设战斗门控；作为「日常任务」组的子项只出一个启用 checkbox，无详细面板、无可调参数。
 */
reactor.register({
  id: 'secretWeaponDrop',
  label: '秘密武器空投',
  storageKey: 'pocketcc.feat.secretWeaponDrop',
  symbols: ['dataCenter', 'homeMapUtils', 'homeMapCommon', 'gameDefine', 'tableManager'],
  scenes: ['Home', 'NWorldMap'],
  offInCombat: false,
  defaults: { enabled: false },
  toModuleCfg: function () {
    return {};
  },
  install: install,
  run: run,
});
