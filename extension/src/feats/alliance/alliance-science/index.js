/**
 * 联盟捐赠-金币自动捐赠（科技 + 遗迹双链路，reactor 说明书形态，日常任务）
 *
 * 联盟日常收益循环：成员向「官员推荐的科技/遗迹」捐金币 → 攒经验与个人荣誉
 * （addPoint，计入每日荣誉 donateDailyHonor）→ 经验满后由有权限的官员发起研究（本功能不做）。
 * 本功能只做一件事：有可捐目标时把两条链路的捐赠次数能量用掉——自然恢复的额度不用就是白丢。
 * 按用户定案不做钻石捐赠（两条链路的 type=2 都不碰）：价目阶梯/随机，非日常必要支出。
 *
 * 两条捐赠链（协议不同、能量池不同）：
 *   科技主链：1144 ALLIANCE_DOANTE_SCIENCE {scienceId,type:1,num}，能量池 4（10 点/30 分钟回 1），出个人荣誉；
 *     num 仅支持 1 或 10 → 本功能固定逐枚发 num=1（一 tick 内循环至多 SCIENCE_LOOP_MAX_PER_TICK 枚），不打包余量（任意 num 会被服务端判参数错误 alliance_120515）；
 *   遗迹（要塞 WorldSite）：1067 WORLDSITE_DONATE {id,type:1}，能量池 7
 *     （ALLIANCE_WORLDSITE_DONATE_GOLD_NUM，报文实测 pointMax=10、restoreSec=3600），
 *     游戏弹窗只有单捐按钮、无批量口径 → 一次一枚，tick 内循环 + RELIC_GAP_MS 间距把当轮点数花光；
 *     单价 = scienceData.getCostCoin(true)（PLAYER_LEVEL.relic_coin），前置 FunctionOn(Relic_upgrade_time)。
 *   荣誉计数科技主链与遗迹链共用（1067 应答 curPoint 直接写回 donateDailyHonor，报文实证），所以只设一道闸。
 *
 * 捐赠目标策略（用户定案；目标全在 ACL 里合成，见 gameData.allianceScience/allianceRelic 的 donateTarget）：
 *   1. 优先捐推荐项：科技 scienceData.RecommendId（push 10430 刷新）；
 *      遗迹 AllianceWorldSiteController.instance.recommendSite（1070 应答，登录组装链与每日零点自动刷）；
 *   2. 无推荐时回退第一个可捐赠项（科技按弹窗 showBtn 口径、遗迹按红点口径，均在 ACL 里判）；
 *   3. **快速作战（sid 10900）按用户定案不捐**：它排在 dev 列表第 8 组，一旦被当普通目标就会长期霸占捐赠
 *      （20 秒回 1 点、永远捐不完、服务端恒回 addPoint=0 不出荣誉）；排除口径收口在 ACL
 *      （game-api.js SCIENCE_SID_EXCLUDE_DONATE），本 feat 不再比 sid 值、也不再有建筑补捐链。
 *   **关键修正**：推荐项本身也必须处于可捐态（未满级、非研究中/经验未满）才会被采纳——
 *   满级或研究中的推荐项直接捐会被服务器拒（实证：1067 code=3「已经到达最大等级」），此时自动回退首项。
 *
 * 荣誉到顶必停（用户定案：不披露、不配置）：dailyHonor ≥ honorCap（游戏
 *   Alliance.getAllianceScienceScore()，内部 DATACONFIG 16005）即当日收手等零点重置——
 *   游戏自己两个弹窗都在此条件下弹「荣誉已满」确认框，超限捐不产生荣誉，没必要赌。
 *
 * 触发（只靠回点驱动，不拿 push 当轮询）：
 *   - run 点火即查一轮（加载时多半已错过推送，本地态直接可用）；
 *   - push 10021 PUSH_ENERGY 只认 type∈{4,7} **且只在点数回升时**唤醒：报文实证每回 1 点推一次；
 *     但每捐一次也会把 point 往下扣并同样推一条 10021（reason=alliance_donate/WONDER_DONATE_*），
 *     一次捐光会连推多条递减——故按方向过滤（只认 pt>prev），否则会形成“捐→被推→再捐”的请求风暴；
 *     10021 只在在线时推，离线错过由精准定时器兜底；
 *   - **不再订阅 10430/10432 做唤醒**：列表/荣誉变更不新增捐赠额度（额度只靠回点产生），
 *     订阅它们只会在繁忙联盟里被他人捐赠刷屏、反复拉起整轮 tick 徒增请求；
 *   - 能量有余但金币不足/连续被拒 → BUSY 档慢等；两池全空 → 按较早回点唤醒；
 *   - 无可捐目标/荣誉到顶/不在盟 → IDLE 档巡检（自然等零点重置与官员上新推荐）。
 *
 * 日志口径：单枚捐赠细节走 debug，整轮聚合成一条 info（逐枚 info 曾在大池下每 2.5 秒刷 10 条，真机刷屏）。
 *
 * 合规：全程只读游戏数据（经 game-api ACL）+ 直发 1144/1067，不调用游戏的 Update* 改写本地态；
 *   不做研究发起（1145 需 UpScience 权限）与秒完成（1146/1068 花钻石）。
 *   日常任务形态：面板出启用开关 + 一行只读今日捐赠次数（inlineStatus），无可调配置（toModuleCfg 返回空）。
 *   当日次数口径（定稿）：动作类计脚本——1144/1067 受理成功逐枚计（直发不回写游戏本地态，
 *   权威 donateDailyHonor 不被脚本捐包刷新，故不走额度读权威）；能量池回点制无固定日限，无分母。
 *
 * 生命周期由 reactor 托管：install/run 两钩子（日常任务无配置可推），places 限 base/world（Home/NWorldMap），战斗模式暂停；
 *   调度交给 core/cycle.js：单飞闸门、推触合并、异常 fallback 重排均内置；pause 后 alive()=false 让 cycle 自然停摆。
 */
import { sleep } from '../../../core/util.js';
import { createLog } from '../../../core/log.js';
import { l10n, gameData } from '../../../core/game-api.js';
import { reactor } from '../../../core/reactor.js';
import { createCycle } from '../../../core/cycle.js';
import { createDailyLedger } from '../../../core/daily-stats.js';

import { CMD_DONATE, CMD_DONATE_RELIC, CMD_PUSH_ENERGY } from './constants.js';

/** @type {ReturnType<createLog>} 模块日志器（tag=ALLIANCE-SCIENCE） */
const log = createLog('ALLIANCE-SCIENCE');

/** @type {number} EnergyType.ALLIANCE_DONATE_NUM（GameDefine），科技金币捐赠次数能量池（报文实证 pointMax=10、restoreSec=1800） */
const ENERGY_DONATE = 4;

/** @type {number} EnergyType.ALLIANCE_WORLDSITE_DONATE_GOLD_NUM，遗迹金币捐赠次数能量池（报文实证 pointMax=10、restoreSec=3600） */
const ENERGY_RELIC = 7;

/** @type {number} 科技池自然恢复周期（秒，抓包实证 restoreSec=1800）；getter 没给出回点秒数时的兜底 */
const SCIENCE_RECOVER_SEC = 1800;

/** @type {number} 遗迹池自然恢复周期（秒，抓包实证 restoreSec=3600）；同上兜底 */
const RELIC_RECOVER_SEC = 3600;

/** @type {number} 遗迹链「阶段性全局禁用」（跨战区 KVK 等）识别后的静默冷却（毫秒）：期内不再发 1067，避免每 tick 撞墙刷 warn；到点或 resume 后自然重试一枚 */
const RELIC_BAN_COOLDOWN_MS = 1000 * 60 * 30;

/** @type {number} 遗迹单捐链的枚间隔（毫秒）：同 cmd 频控的安全间距（抓包实证 40ms 也能吞下，保守取 600） */
const RELIC_GAP_MS = 600;

/** @type {number} 科技单捐链的枚间隔（毫秒）：num 固定 1、逐枚发，同 cmd 频控的安全间距 */
const SCIENCE_DONATE_GAP_MS = 600;

/**
 * @type {number} 科技/遗迹单 tick 的连捐枚数上限（二次防御）：通用池 4 / 遗迹池 7 本就 pointMax≈10，
 * 但一次性捕获的 energy.point 无界（真机曾在建筑池 6 上单轮冲出上百枚），故把单次突发锁到 10 枚；
 * 未捐完的余量靠 donated→CHAIN_GAP_MS 复查自然续捐，既不会一次刷屏上百条，也不影响把能量花光。
 */
const SCIENCE_LOOP_MAX_PER_TICK = 10;

/** @type {number} 本轮捐成功后短隔复查（毫秒）：金币不足/池未花光时续捐 */
const CHAIN_GAP_MS = 2500;

/** @type {number} 能量有余但金币不足/连续被拒时的慢查间隔（毫秒） */
const BUSY_TICK_MS = 1000 * 60 * 5;

/** @type {number} 无事可干（无可捐目标/荣誉到顶/不在盟）时的巡检间隔（毫秒） */
const IDLE_TICK_MS = 1000 * 60 * 15;

/** @type {number} 回点唤醒的抖动余量（毫秒），避开服务器结算时序 */
const RECOVER_BUFFER_MS = 1000 * 10;

/** @type {object|null} 网络底座（promise 封装 pocketcc.net） */
var net;

/** @type {object|null} reactor 注入的上下文；alive() 反映运行态，pause 后置否让在飞流程自然退出 */
var ctxRef = null;

/** @type {number} 连续被服务器拒绝次数，达 3 次后退到巡检档；成功即清零 */
var rejectStreak = 0;

/** @type {number} 遗迹链阶段性禁用（跨战区等）静默截止戳（Date.now 口径）；0=无冷却。独立于 rejectStreak，避免污染科技排程 */
var relicBanUntil = 0;

/** @type {object} 各能量池上次观测到的点数（type→point），用于只认“点数回升”的恢复推送、忽略捐赠消耗回执推送 */
var lastEnergyPoint = {};

/**
 * @type {string} 荣誉已封顶的本地日期戳（dayKey 口径）；命中当天则科技/遗迹两链当日停捐。
 * 之所以自己记：我们只发包、不走游戏应答处理，游戏侧 donateDailyHonor 不会被我们的捐包刷新，
 * sc.dailyHonor>=sc.honorCap 这道闸在直发路径下形同虚设——一旦荣誉封顶，捐包仍会被服务端接但
 * addPoint=0（荣誉不再增长、纯浪费）。封顶信号只认「主链/遗迹链应答 addPoint==0」这一服务端事实，
 * 命中即记当日并停捐，跨零点自动失效（快速作战 10900 已被 ACL 排除，不再有恒回 addPoint=0
 * 的建筑补捐链误封两链的隐患）。
 */
var honorCappedDay = '';

/**
 * 今日捐赠次数日账（动作类计脚本：1144/1067 受理成功逐枚计）。
 * 键 science/relic 分指科技主链与遗迹链；能量池回点制无固定日限，无分母。
 * @type {import('../../../core/daily-stats.js').DailyLedger}
 */
const dailyLedger = createDailyLedger('pocketcc.daily.allianceScience');

/**
 * 本地日键（年-月-日），用于 honorCappedDay 的“当日停捐、次日自然解禁”判定。
 * @returns {string}
 */
function dayKey() {
  var d = new Date();
  return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
}

/**
 * 功能是否仍在运行（定时器与在飞流程的存活判定）
 * @returns {boolean}
 */
function aliveFn() {
  return ctxRef ? ctxRef.alive() : false;
}

// ── 排程 ──────────────────────────────────────────────────────────────
/**
 * 下一拍择时：刚捐过短隔续查 > 任一池有余量慢查 > 两池回点精准唤醒 → 巡检档。返回值交给 cycle 排下次。
 * 输入只有主链池 4 与遗迹池 7（快速作战的建筑池 6 按用户定案不捐，不进择时）。
 * @param {object} [snap] 本轮 {donated, sciEnergy, relEnergy} 判定结果（缺省按闲档）
 * @returns {number} 毫秒
 */
function nextTickDelay(snap) {
  var ms;
  var pools = [];
  if (snap) {
    if (snap.sciEnergy) pools.push({ e: snap.sciEnergy, fallbackSec: SCIENCE_RECOVER_SEC });
    if (snap.relEnergy) pools.push({ e: snap.relEnergy, fallbackSec: RELIC_RECOVER_SEC });
  }
  if (snap && snap.donated) ms = CHAIN_GAP_MS;
  else if (pools.some((x) => x.e.point > 0)) ms = rejectStreak >= 3 ? IDLE_TICK_MS : BUSY_TICK_MS;
  else if (pools.length) {
    // 两池都空：按较早的回点唤醒；getter 没给秒数的池按各自整周期兜底，防 0 延迟热循环
    ms =
      Math.min.apply(
        null,
        pools.map((x) => (x.e.nextRecoverSec > 0 ? x.e.nextRecoverSec : x.fallbackSec) * 1000),
      ) + RECOVER_BUFFER_MS;
  } else ms = rejectStreak >= 3 ? IDLE_TICK_MS * 2 : IDLE_TICK_MS;
  // 回点唤醒封顶到巡检档倍数，避免超长定时器（离线错过 push 10021 也由它自愈）
  if (ms > IDLE_TICK_MS * 8) ms = IDLE_TICK_MS * 8;
  // 择时日志不在此打：next-check 排程行已由 createCycle 驱动器集中输出（feat 侧重复打会翻倍刷屏）
  return ms;
}

/**
 * cycle 单轮：跑一次 tickBody → 按 snap 择下拍。
 * 在飞期间攒下的推触（cycle.pending）不再走 0 延迟补扫：收到推触也至少留一个捐链复查档的间距，
 * 否则“捐→被推→再捐”可以背靠背重开整轮 10 枚突发，把 SCIENCE_DONATE_GAP_MS 间距保护旁路掉
 * （真机日志见过两批之间只隔 52ms 且无排程行）。
 */
async function cycleRun() {
  var snap = await tickBody();
  if (!aliveFn()) return 0;
  var delay = nextTickDelay(snap || undefined);
  // 有推触就尽快醒（封顶到 CHAIN_GAP），没推触完全按择时睡
  if (cycle.pending && delay > CHAIN_GAP_MS) delay = CHAIN_GAP_MS;
  return delay;
}

const cycle = createCycle({ log: log, alive: aliveFn, run: cycleRun, fallback: IDLE_TICK_MS });

// ── 发包 ──────────────────────────────────────────────────────────────
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
    } catch (err) {
      return null;
    }
  }
  return d && typeof d === 'object' ? d : null;
}

/**
 * 捐赠一次科技（1144，type 固定 1 金币）。永不 reject。
 * @param {number} scienceId 目标科技组 id（推荐项或回退首项）
 * @param {number} num 枚数，游戏金币捐赠仅支持 1 或 10；本功能固定逐枚发 1
 * @returns {Promise<{ok:boolean, code:number, data:*, payload:object|null}>} 归一化结果
 */
async function sendDonate(scienceId, num) {
  return sendRaw(CMD_DONATE, { scienceId: scienceId, type: 1, num: num });
}

/**
 * 捐赠一次遗迹（1067，type 固定 1 金币，单枚）。永不 reject。
 * @param {number} siteId 遗迹（要塞）id
 * @returns {Promise<{ok:boolean, code:number, data:*, payload:object|null}>} 归一化结果
 */
async function sendDonateRelic(siteId) {
  return sendRaw(CMD_DONATE_RELIC, { id: siteId, type: 1 });
}

/**
 * 直发一条旧 JSON 捐赠请求并归一化应答
 * @param {number} cmd 命令号
 * @param {object} body 载荷
 * @returns {Promise<{ok:boolean, code:number, data:*, payload:object|null}>}
 */
async function sendRaw(cmd, body) {
  var ret = await net.sendGuarded(cmd, body, {
    onError: function (err) {
      log.warn('cmd %d send threw: %s', cmd, err && err.message);
    },
  });
  return { ok: ret.ok, code: ret.code, data: ret.data, payload: payloadOf(ret) };
}

// ── 主流程 ────────────────────────────────────────────────────────────
/**
 * 单轮主体：本地数据 → 荣誉闸 → 科技主链 → 遗迹链。
 * @returns {Promise<object|null>} 排程线索 {donated, sciEnergy, relEnergy}；数据不可用返回 null（走闲档）
 */
async function tickBody() {
  var sc = gameData.allianceScience();
  if (!sc) {
    log.debug('science data unavailable (not in alliance?)');
    return null;
  }

  // 荣誉当日已封顶（上一轮从主链应答 addPoint==0 实测）：科技/遗迹两链都靠同一荣誉计数，直接停捐到次日。
  // 返回 null 走巡检档（不发包），避免每 tick 拿大池反复连捐刷屏。
  if (honorCappedDay && honorCappedDay === dayKey()) {
    log.debug('donate honor capped today (server addPoint=0), skip until reset.');
    return null;
  }

  // 荣誉到顶必停（用户定案的硬闸，不配置）：两条链路共用此计数，取不到上限则不设此闸
  if (sc.honorCap > 0 && sc.dailyHonor >= sc.honorCap) {
    log.debug('daily honor capped (%d/%d), skip today.', sc.dailyHonor, sc.honorCap);
    return {
      donated: false,
      sciEnergy: gameData.energy(ENERGY_DONATE),
      relEnergy: gameData.energy(ENERGY_RELIC),
    };
  }

  var donated = false;
  var sci = await donateLoop({
    tag: 'science',
    target: sc.donateTarget
      ? {
          id: sc.donateTarget.id,
          name: sc.donateTarget.name,
          recommended: sc.donateRecommended,
        }
      : null,
    poolType: ENERGY_DONATE,
    cost: sc.costCoin,
    honorCapSignal: true,
  }).catch(function (err) {
    log.warn('science donate threw.', err);
    return null;
  });
  if (sci && sci.capped) {
    // 服务端权威封顶信号（主链一枚 addPoint==0）：两链共用同一荣誉计数，当日一起收手等零点重置
    honorCappedDay = dayKey();
    log.info('science: honor capped by server (addPoint=0). stop donating for today.');
  }
  if (sci && sci.donated) donated = true;
  if (!aliveFn()) return null;

  var rel = await donateRelic().catch(function (err) {
    log.warn('relic donate threw.', err);
    return null;
  });
  if (rel && rel.donated) donated = true;
  if (!aliveFn()) return null;

  return { donated: donated, sciEnergy: sci && sci.energy, relEnergy: rel && rel.energy };
}

/**
 * 逐枚 num=1 连捐的一轮内部循环（科技主链专用）。
 * num 固定 1 而非「余量打包」：游戏金币捐赠 num 仅支持 1 或 10，任意 point 值当 num 发会被服务端判参数错误（alliance_120515）。
 * 逐枚发对齐游戏连捐（onClickDonateCoinBtn 循环 donateScience(sid,1)）；任一枚被拒/金币不足即收手交下轮。
 * 日志：单枚走 debug，整轮只聚合一条 info（大池逐枚 info 会每 2.5 秒刷 10 条，真机刷屏）。
 * @param {{tag:string, target:{id:number,name:string,recommended:boolean}|null, poolType:number, cost:number, honorCapSignal:boolean}} o
 *   tag=日志链路名；honorCapSignal=true 时把服务端 addPoint==0 当作当日荣誉封顶信号（只主链该这么做，
 *   避免其它链路历史上恒回 0 的应答误封两链整天）
 * @returns {Promise<{donated:boolean, energy:object|null, capped:boolean}>} energy 为该链所用池的（捐后）快照
 */
async function donateLoop(o) {
  // 目标由 ACL 合成：推荐项非自身可捐（满级/研究中）则已自动回退到首个可捐项，这里不再盲信推荐位
  if (!o.target) {
    log.debug(
      '%s: no donateable target (recommend capped/upgrading or none unlocked), skip.',
      o.tag,
    );
    return { donated: false, energy: gameData.energy(o.poolType), capped: false };
  }
  var target = o.target;
  var energy = gameData.energy(o.poolType);
  if (!energy) return { donated: false, energy: null, capped: false };
  if (energy.point <= 0) return { donated: false, energy: energy, capped: false };

  var cost = o.cost;
  var done = 0;
  var sumExp = 0;
  var sumHonor = 0;
  var crits = 0;
  var capped = false;
  // 单 tick 突发锁到 SCIENCE_LOOP_MAX_PER_TICK 枚；未捐完靠 donated→CHAIN_GAP 复查续捐
  var loopMax = Math.min(energy.point, SCIENCE_LOOP_MAX_PER_TICK);
  for (var i = 0; i < loopMax; i++) {
    if (!aliveFn()) break;
    if (cost > 0 && gameData.coins() < cost) {
      log.debug('%s: coin not enough. cost=%d;coins=%d', o.tag, cost, gameData.coins());
      break;
    }
    var res = await sendDonate(target.id, 1); // num 固定 1（合法批量值）
    if (!aliveFn()) break;
    if (res.ok && res.payload && res.payload.sid != null) {
      rejectStreak = 0;
      done++;
      var addPt = Number(res.payload.addPoint) || 0;
      sumExp += Number(res.payload.addExp) || 0;
      sumHonor += addPt;
      if (res.payload.crit) crits++;
      log.debug(
        '%s donate #%d ok. sid=%d;addExp=%s;honor(+)%s;crit=%s',
        o.tag,
        done,
        target.id,
        res.payload.addExp,
        addPt,
        !!res.payload.crit,
      );
      // 服务端回 addPoint==0：今日荣誉已封顶（正常捐一枚 addPoint=50），再捐只烧金币不出荣誉。
      // 跳出循环交上层记当日封顶，从根上消除「大池逐枚连捐 + 荣誉门失效」的无效发包。
      if (o.honorCapSignal && addPt === 0) {
        capped = true;
        break;
      }
    } else {
      // 服务器拒绝带字典键载荷（'<键,参数>' 格式），l10n.net 翻成人话便于定位是哪道闸没过
      rejectStreak++;
      var smsg = l10n.net(res.data);
      if (isExpectedReject(res)) {
        // 次数不足/荣誉已满/跨战区等「当前本就不能做」的可预期拒绝：降级 info，不占 ⚠️ 面板；退避与回点唤醒不变
        log.info(
          '%s donate skipped (expected). sid=%d;num=1;code=%d;msg=%s',
          o.tag,
          target.id,
          res.code,
          smsg,
        );
      } else {
        log.info(
          '%s donate rejected (streak #%d). sid=%d;num=1;code=%d;msg=%s',
          o.tag,
          rejectStreak,
          target.id,
          res.code,
          smsg,
        );
      }
      break; // 任一枚被拒即收手，交下轮/排程
    }
    if (i < loopMax - 1) await sleep(SCIENCE_DONATE_GAP_MS, ctxRef && ctxRef.signal);
  }
  if (done > 0) {
    dailyLedger.bump('science', done);
    log.info(
      '%s donate ok. sid=%d(%s);x%d;addExp+%d;honor+%d;crit=%d',
      o.tag,
      target.id,
      target.recommended ? 'recommended' : 'first-in-order',
      done,
      sumExp,
      sumHonor,
      crits,
    );
  }
  return {
    donated: done > 0,
    energy: done > 0 ? gameData.energy(o.poolType) || energy : energy,
    capped: capped,
  };
}

/**
 * 判定一条遗迹被拒应答是否属于「阶段性全局禁用」——典型是跨战区（KVK）期间要塞（WorldSite）捐赠被服务端整锁。
 * 与「目标级/参数级」拒绝区分：前者重试无意义，应静默冷却而非计入 rejectStreak、逐 tick 刷 warn。
 * 判据：优先看裸键前缀（'<键,参数>' 的键含 cross_server/cross_zone），译文兜底（zh 玩家）。
 * @param {object} res sendRaw 归一化结果 {code,data,...}
 * @returns {boolean}
 */
function isRelicPhaseBan(res) {
  var raw = res && res.data;
  if (raw == null) return false;
  var key = String(raw).split(',')[0].trim();
  if (key.indexOf('cross_server') >= 0 || key.indexOf('cross_zone') >= 0) return true;
  var zh = l10n.net(raw);
  return zh.indexOf('跨战区') >= 0 || zh.indexOf('跨服') >= 0;
}

/**
 * 判定一条被拒应答是否属于「可预期的游戏态拒绝」——次数不足 / 荣誉已满 / 已达上限 / 跨战区等，
 * 即「当前本就不能做」而非插件发错。这类降级为 info，不占面板 ⚠️ 问题位；未知拒绝仍按 warn 暴露。
 * 判据：裸键前缀含 cross_server/cross_zone，或译文含相应关键字（zh 玩家口径）。
 * @param {object} res sendRaw 归一化结果 {code,data,...}
 * @returns {boolean}
 */
function isExpectedReject(res) {
  var raw = res && res.data;
  if (raw == null) return false;
  var key = String(raw).split(',')[0].trim();
  if (key.indexOf('cross_server') >= 0 || key.indexOf('cross_zone') >= 0) return true;
  var zh = l10n.net(raw);
  return (
    zh.indexOf('跨战区') >= 0 ||
    zh.indexOf('跨服') >= 0 ||
    zh.indexOf('次数不足') >= 0 ||
    zh.indexOf('荣誉已满') >= 0 ||
    zh.indexOf('已达上限') >= 0 ||
    zh.indexOf('达到上限') >= 0
  );
}

/**
 * 遗迹链：FunctionOn 闸 → 能量池 7 → 选目标（推荐优先/回退首项）→ 单捐循环把当轮点数花光。
 * 遗迹无批量口径（游戏弹窗只有单捐），故逐枚发；任一枚失败即收手，交下轮/排程重试。
 * 日志与科技链同口径：单枚走 debug，整轮聚合一条 info（honor 取服务端权威的末枚 curPoint）。
 * @returns {Promise<{donated:boolean, energy:object|null}>}
 */
async function donateRelic() {
  if (!gameData.functionOn('Relic_upgrade_time')) return { donated: false, energy: null };
  var rl = gameData.allianceRelic();
  if (!rl) return { donated: false, energy: null };
  var energy = gameData.energy(ENERGY_RELIC);
  if (!energy) return { donated: false, energy: null };
  if (energy.point <= 0) return { donated: false, energy: energy };
  // 阶段性全局禁用（如跨战区）静默期内：直接跳过、不发包，避免每 tick 重复撞墙刷日志
  if (relicBanUntil && Date.now() < relicBanUntil) return { donated: false, energy: energy };

  // 目标由 ACL 合成：推荐位要塞非自身可捐（满级/经验已满）则已自动回退首个可捐要塞
  if (!rl.donateTarget) {
    log.debug('relic: no donateable site (recommend capped/full or none), skip.');
    return { donated: false, energy: energy };
  }
  var target = {
    id: rl.donateTarget.id,
    name: rl.donateTarget.name,
    recommended: rl.donateRecommended,
  };

  var cost = rl.relicCostCoin;
  var done = 0;
  var crits = 0;
  var lastHonor = 0;
  for (var i = 0; i < energy.point; i++) {
    if (!aliveFn()) break;
    if (cost > 0 && gameData.coins() < cost) {
      log.debug('relic: coin not enough. cost=%d;coins=%d', cost, gameData.coins());
      break;
    }
    var res = await sendDonateRelic(target.id);
    if (!aliveFn()) break;
    if (!(res.ok && res.payload && res.payload.curPoint != null)) {
      // 跨战区等阶段性全局禁用：重试无意义，独立静默冷却并降级为 info，不计入 rejectStreak（免得污染科技排程/两链互相掩盖）
      if (isRelicPhaseBan(res)) {
        relicBanUntil = Date.now() + RELIC_BAN_COOLDOWN_MS;
        log.info(
          'relic donate locked by phase ban. site=%d;code=%d;msg=%s;pause=%dmin',
          target.id,
          res.code,
          l10n.net(res.data),
          RELIC_BAN_COOLDOWN_MS / 60000,
        );
        break;
      }
      rejectStreak++;
      var rmsg = l10n.net(res.data);
      if (isExpectedReject(res)) {
        log.info(
          'relic donate skipped (expected). site=%d;code=%d;msg=%s',
          target.id,
          res.code,
          rmsg,
        );
      } else {
        log.info(
          'relic donate rejected (streak #%d). site=%d;code=%d;msg=%s',
          rejectStreak,
          target.id,
          res.code,
          rmsg,
        );
      }
      break;
    }
    rejectStreak = 0;
    done++;
    lastHonor = Number(res.payload.curPoint) || 0;
    if (res.payload.crit) crits++;
    log.debug(
      'relic donate #%d ok. site=%d;honor=%s;crit=%s',
      done,
      target.id,
      res.payload.curPoint,
      !!res.payload.crit,
    );
    if (i < energy.point - 1) await sleep(RELIC_GAP_MS, ctxRef && ctxRef.signal);
  }
  if (done > 0) {
    dailyLedger.bump('relic', done);
    log.info(
      'relic donate ok. site=%d(%s);x%d;honor=%d;crit=%d',
      target.id,
      target.recommended ? 'recommended' : 'first-in-order',
      done,
      lastHonor,
      crits,
    );
  }
  return { donated: done > 0, energy: done > 0 ? gameData.energy(ENERGY_RELIC) || energy : energy };
}

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
 * 运行：复位在飞态 → 订阅 push 10021（只认回升）唤醒 → 立即查一轮。
 * pause 后 alive()=false，定时器与在飞流程自然退出；resume 重新订阅并再查一轮。
 * @param {object} ctx reactor 上下文
 */
function run(ctx) {
  ctxRef = ctx;
  rejectStreak = 0;
  relicBanUntil = 0;
  dailyLedger.ensureLoaded();
  log.info('started.');

  // 以当前点数作为基准：自家捐赠带来的 point 递减推送会因“非回升”被过滤，不再触捐
  lastEnergyPoint = {};
  var e4 = gameData.energy(ENERGY_DONATE);
  if (e4) lastEnergyPoint[ENERGY_DONATE] = e4.point;
  var e7 = gameData.energy(ENERGY_RELIC);
  if (e7) lastEnergyPoint[ENERGY_RELIC] = e7.point;

  // 能量池推送 10021：只在点数“回升”（自然回点）时唤醒捐赠。
  // 报文实证：每捐一次会把 point 往下扣并同样推一条 10021（reason=alliance_donate/WONDER_DONATE_*），
  // 一次捐光 10 点会连推 10 条递减——若不看方向逐条 cycle.kick，就是“捐→被推→再捐”的自我反馈风暴。
  // 捐赠额度只能靠回点产生，10430/10432（列表/荣誉变更）不新增额度，故不再订阅它们做轮询。
  // 快速作战（sid 10900）的建筑池 6 不订阅也不捐（用户定案）：目标排除口径收口在 ACL，本 feat 不再比 sid 值。
  ctx.on.push(CMD_PUSH_ENERGY, function (ev) {
    var d = ev && ev.data;
    if (!d || (d.type !== ENERGY_DONATE && d.type !== ENERGY_RELIC)) return;
    var type = d.type;
    var pt = Number(d.point) || 0;
    var prev = lastEnergyPoint[type];
    lastEnergyPoint[type] = pt;
    if (prev != null && pt <= prev) return; // 持平/下降：非回升（多为消耗回执），忽略
    log.debug('push 10021 energy type=%s recovered (%s→%s), tick.', type, prev, pt);
    cycle.kick();
  });

  cycle.kick(); // 首个 tick 立即跑：加载时多半已错过推送，本地态直接可用
}

/**
 * 向 reactor 注册本功能说明书：地图限定 base/world（Home/NWorldMap），战斗模式暂停；
 * 日常任务形态——面板出启用开关 + 一行只读今日捐赠次数（inlineStatus；荣誉到顶必停、只做金币捐、
 * 目标两级均为内置口径）；能量池 id / 恢复周期 / 单捐间距等均为本文件内置常量。
 */
reactor.register({
  id: 'allianceScience',
  label: '联盟科技',
  storageKey: 'pocketcc.feat.allianceScience',
  symbols: ['dataCenter', 'worldSite', 'gameDefine', 'tableManager'],
  places: ['base', 'world'],
  kinds: ['homeland'],
  offInCombat: true,
  defaults: { enabled: false },
  fields: [
    {
      key: '_donateInfo',
      type: 'text',
      label: '今日',
      get: function () {
        if (!dailyLedger.loaded()) return '—';
        var s = dailyLedger.get('science');
        var r = dailyLedger.get('relic');
        return '今日 ' + (s + r) + ' 次 · 科' + s + '/遗' + r;
      },
    },
  ],
  toModuleCfg: function () {
    return {};
  },
  install: install,
  run: run,
});
