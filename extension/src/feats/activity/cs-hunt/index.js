/**
 * feats/activity/cs-hunt/index.js —— 夺宝奇兵（CSHunt / CrossTreasure）feat 装配层。
 *
 * 本期落地范围（设计文档 extension/docs/feat-夺宝奇兵.md §8 分期，严格按分期不提前）：
 *   P0 只读闭环 —— 7501 拉态 + 21371~21376 推送落地 + 面板状态行；
 *   P1 队长最小闭环 —— 建队 7521 → 申请池复核 7528 → 审批 7523 → 满编出征 7519 → 召集 7527，
 *      队员/陪跑的「表态 7520 + 出征 + 应答召集」同链路复用同一引擎（角色由队伍 uid 与本人 UID 判定，非独立分支）；
 *   P2 队员/陪跑 —— 面板「玩法模式」主跑/陪跑二选一（对应游戏 help 位），无队时逐个名单成员 630 PLAYER_INFO 取名→7530 按名（likeName）搜其创建的队→7522 申请入队（不再扫 7526）；
 *      次数不足按「次数不足用信标补」经通用使用物品 815 消耗定位信标(47001001)补次数（§7-6 已由报文关闭）。
 *   P3 事件族 + P4 技能策略（引擎 engine-flow.js + scenes/*、纯函数 codebox.js/skills.js）——
 *      生命周期对齐源码 CSHuntPhaseType：探索回合（WAIT）转场串联（数据转换24→重拉背包→完美镜像22 复制先知，严格只复制先知）→ DECIDE.play 队长先知9 揭示 → DECIDE.show/剩余倒计时≤10s（timePhaseEnd 权威）先知感知选场景
 *      7532（indexDecide 1-based，全员发；7533 投票四趟皆 0 故不实现）→ EVENT 按 eventSpecId 族号分派 scenes/*：
 *      pickReward 7534 / rollDice 7535（仅主跑）、codeBox 7537（本端视图广播频道 17 + 收队友视图 merge 汇总，未知≤2 穷举兜底）、
 *      pickSkill 7538（按 cfg.skillPool 择优，无命中且有刷新23 则重洗≤2 次）、defPVE/nothing 无动作；幸运降临(18) 命中 cfg.luckyRewards 先开。
 *      **P4 全自动默认开**（无 UI 开关）：来袭保命盾/隐身/闪现、末回合清空背包、转场复制/转换/先知串联。
 *
 * 分层：index.js 只做装配（spec + createCycle + env 注入），协议常量在 constants.js，编排在 engine-team.js；
 *   游戏符号（CSHuntController / DataCenter.UID）一律经本目录 api.js（ACL 下沉试点），此处不摸 game.get。
 *
 * 生命周期：install 取网络底座并自检符号；run 起引擎 + 首发 7501 + 武装 createCycle；
 *   pause 显式收引擎（reactor 的触发器摘除管不到引擎自建的在飞 await 与配对状态，陈旧快照会在 resume 后发错写请求）。
 *
 * 世界态门控（对齐可行性报告 §7.2 的 A 档保守口径）：夺宝是跨服玩法，出征前人在本服常态图（Home/NWorldMap），
 *   跑动中镜头可能被游戏飞到目标服图（tInfo.sid），kind 归属尚无静态证据——真机复核口径：活动跑动中
 *   `pocketcc.worldState.dump()` 看 kind 若落 cross 族，则把 kinds 升为 ['homeland','cross']（A→B，同发射井报告的处置）。
 *   秘境（kind===pab）由 world 门默认全拦，本 feat 不声明 'pab' 即自然停摆，无需额外自判。
 */
import { reactor } from '../../../core/reactor.js';
import { createCycle } from '../../../core/cycle.js';
import { createLog } from '../../../core/log.js';
import { bits } from '../../../core/game-api.js';
import { csHunt } from './api.js';
import { TeamEngine, getDailyRuns, DEFAULT_WAIT_MIN } from './engine-team.js';
import { SKILL_GROUP_IDS, groupName, skillGroupRep } from './skills.js';
import {
  SESSION_KEYS,
  sanitizeSessionModes,
  seedFollowModes,
  anySessionMain,
} from './session-mode.js';
import { EVENT_TYPE, LUCKY_GIFTS } from './constants.js';

/** @type {ReturnType<createLog>} feat 日志器（tag=CSHUNT，与引擎同一命名空间） */
const log = createLog('CSHUNT');

/** @type {object|null} reactor 上下文（install/run 置入） */
var ctxRef = null;
/** @type {object|null} 网络底座（install 懒取，缺失则不激活） */
var net = null;
/** @type {boolean} install 幂等守卫 */
var installed = false;
/**
 * 组队引擎（run 建、pause 收）。必须持有引用：reactor 摘的是 ctx.on.* 登记的触发器，
 *   引擎内部的在飞 await 与编排闸（已发过 7519/7527 的 teamId 记账）只能由引擎自己的 stop() 收。
 * @type {TeamEngine|null}
 */
var engine = null;
/**
 * 面板模块配置（configure 灌入，引擎经 env.cfg() 惰性读）。
 *   modeBySession=「按场次设置模式」开关（默认关）：关=有效模式恒等 mode 主设置（矩阵隐藏且引擎忽略）；
 *   开=附 9 个场次键 modeFri1..modeSun3（'main'|'helper'，见 session-mode.js SESSION_KEYS）按场覆盖，
 *   follow 仅作未定制标记（开启瞬间播种为当时主设置）；引擎 #cfg() 按当前场次解析有效模式并按局锁存。
 * @type {{mode:'main'|'helper', modeBySession:boolean, targetMemberNum:number, waitMin:number, rolePool:Array<{uid:string,name:string}>, rejectOutsidePool:boolean, useBeaconWhenShort:boolean, dailyRuns:number, autoSwitchToHelper:boolean, presetPool:number[], skillPool:number[], luckyRewards:Object<string,number[]>}}
 *   presetPool = 单元素数组（面板单选一个预设 1~8）；skillPool = 族代表 id 的优先级序（见 skills.js SKILL_GROUPS）。
 */
var modCfg = normalize({});

/**
 * 面板 showIf 闸门：统一模式看主设置；矩阵模式看 9 格 effective（follow 残留按主设置计）——
 *   任一场次可能主跑就展开建队/凑人/拒池外这些队长专属参数（全格陪跑才隐藏）。
 * @param {object} cfg 当前配置
 * @returns {boolean}
 */
function isMain(cfg) {
  if (!cfg) return true;
  if (cfg.modeBySession) return anySessionMain(cfg, cfg.mode === 'helper' ? 'helper' : 'main');
  return cfg.mode !== 'helper';
}

/**
 * 角色池归一：只留合法 uid（Int64 一律字符串，禁 Number 化）且**已勾选**的行（行 .on===false 不入池；
 *   存量无 on 视为已勾，向后兼容），去重，保留面板行序。未勾行在归一处即被剔除，
 *   下游两条消费链（队长审批入队 poolSet / 陪跑找队 #joinTeam）同时生效。
 * @param {*} raw uidlist 面板原值 `[{uid,name,on}]`
 * @returns {Array<{uid:string, name:string}>}
 */
function sanitizePool(raw) {
  var out = [];
  var arr = Array.isArray(raw) ? raw : [];
  for (var i = 0; i < arr.length; i++) {
    var it = arr[i] || {};
    if (it.on === false) continue; // 面板勾选框（itemCheck）未勾=不入夺宝玩家池
    var uid = bits.int64Str(it.uid);
    if (!uid) continue;
    if (
      out.some(function (p) {
        return p.uid === uid;
      })
    )
      continue;
    out.push({ uid: uid, name: String(it.name || '') });
  }
  return out;
}

/**
 * sortlist → 生效有序 id 数组：按拖拽 order 序（下标即优先级）剔除 off（未勾选）项，剔非法、去重。
 *   面板 cfg[key]=order 全量、cfg[offKey]=off 未勾项；引擎只吃「已勾选且按优先级排好」的结果（幂等：二次归一不变）。
 * @param {*} order cfg[key]（拖拽序 id 数组）
 * @param {*} off cfg[offKey]（未勾选 id 数组）
 * @returns {number[]} 生效 id（保留优先级序）
 */
function activeSortlist(order, off) {
  var offSet = new Set((Array.isArray(off) ? off : []).map(String));
  var arr = Array.isArray(order) ? order : [];
  var out = [];
  for (var i = 0; i < arr.length; i++) {
    var n = Number(arr[i]);
    if (!(n > 0) || offSet.has(String(n)) || out.indexOf(n) >= 0) continue;
    out.push(n);
  }
  return out;
}

/**
 * 幸运奖励池枚举（面板 luckyRewards 候选源）：优先运行期从 cross_treasure_event 解包（活动开启时最全），
 *   表未下发/符号缺失/解不出（活动未开）则回退静态目录 LUCKY_GIFTS（报文实证），保证面板不空。
 *   每项带 scenes（该 itemId 掉落的场景族）；实时表取不到行主键致 scenes 空时，回退静态目录同 id 的 scenes。
 * @returns {Array<{id:number,name:string,scenes:string[]}>}
 */
function rewardPool() {
  var live;
  try {
    live = (csHunt.readRewardPool && csHunt.readRewardPool()) || [];
  } catch (e) {
    live = [];
  }
  if (live && live.length) {
    var stSc = Object.create(null);
    for (var si = 0; si < LUCKY_GIFTS.length; si++)
      stSc[String(LUCKY_GIFTS[si].id)] = LUCKY_GIFTS[si].scenes || [];
    return live.map(function (x) {
      return {
        id: x.id,
        name: x.name,
        scenes: x.scenes && x.scenes.length ? x.scenes : stSc[String(x.id)] || [],
      };
    });
  }
  return LUCKY_GIFTS;
}

/**
 * 某场景的幸运候选（rewardPool 里 scenes 命中该场景 key 的项）。
 * @param {string} sceneKey 场景 key（EVENT_TYPE 值）
 * @returns {Array<{id:number,name:string}>}
 */
function poolForScene(sceneKey) {
  return rewardPool().filter(function (x) {
    return (x.scenes || []).indexOf(sceneKey) >= 0;
  });
}

/**
 * multiopts 勾选值 → 合法 itemId 数组（>0 去重）。幸运物品 id 均在 32 位内，直接 Number（非 64 位 uid）。
 * @param {*} arr cfg[key] 已勾选数组
 * @returns {number[]}
 */
function activeIds(arr) {
  var a = Array.isArray(arr) ? arr : [];
  var out = [];
  for (var i = 0; i < a.length; i++) {
    var n = Number(a[i]);
    if (n > 0 && out.indexOf(n) < 0) out.push(n);
  }
  return out;
}

/**
 * 场景 key → 面板字段 key（luckyPickReward / luckyRollDice / luckyCodeBox / luckyDefPVE）。
 * @param {string} sceneKey EVENT_TYPE 值
 * @returns {string}
 */
function luckyFieldKey(sceneKey) {
  return 'lucky' + sceneKey.charAt(0).toUpperCase() + sceneKey.slice(1);
}

/**
 * 幸运池面板字段（用户口径 2026-10-17）：幸运降临只在「这次我最大」(rollDice) 场景使用，
 *   故只渲染 rollDice 一组奖励清单（不再折叠、不再列其余场景）。勾选道具 = 掷骰中奖奖励命中时先 7551 用幸运 ×2；
 *   一个都不勾 = 本局不用幸运。背包剩余幸运的溢出兜底由「科技使用策略·末回合清空」无脑用掉，不在本面板范围。
 * @type {Array<object>}
 */
var LUCKY_ROLL = EVENT_TYPE.ROLL_DICE;
var luckyFields = [
  {
    key: luckyFieldKey(LUCKY_ROLL),
    type: 'multiopts',
    label: '这次我最大',
    section: '幸运触发物品',
    stack: true,
    options: function () {
      return poolForScene(LUCKY_ROLL).map(function (x) {
        return { value: x.id, label: x.name };
      });
    },
    hint: '只在「这次我最大」场景：掷骰中奖命中已勾道具且有幸运时先用幸运×2；全不勾=本局不用（剩余幸运末回合自动用掉）。',
  },
];

/**
 * 各场模式矩阵（用户口径 2026-11-19，参考竞品B）：「按场次设置模式」开关开时显形，
 *   周五/六/日 × 第一/二/三场每格两档 main/helper（与主设置下拉互斥显隐）；开启瞬间 follow
 *   未定制格播种为当时主设置（fd.onChange 回写）。场次判定数据驱动（服务器 7501 openTime[]
 *   时段表，见 session-mode.js）；已开跑的一局沿用开局模式（引擎按 team.id 锁存）。
 * @type {Array<object>}
 */
var SESSION_TIMES = ['03:00–05:00', '11:00–13:00', '19:00–21:00'];
var SESSION_OPTIONS = [
  { value: 'main', label: '主跑' },
  { value: 'helper', label: '陪跑' },
];
var bySessionOn = function (cfg) {
  return !!(cfg && cfg.modeBySession);
};
var sessionFields = [
  {
    key: 'sessionNote',
    type: 'note',
    section: '组队',
    showIf: bySessionOn,
    text: '三列依次为第一场 03:00–05:00、第二场 11:00–13:00、第三场 19:00–21:00；场次按服务器夺宝时间表判定。每格主跑/陪跑二选一，开启本矩阵时未定制的格子已按当时主设置播种；修改立即生效，已开跑的一局沿用开局模式；不在场次内时沿用主设置兜底。',
  },
].concat(
  ['Fri', 'Sat', 'Sun'].map(function (d, r) {
    var label = ['周五', '周六', '周日'][r];
    var fd = {
      key: 'sessionMode' + d,
      type: 'ctrlrow',
      label: label,
      section: '组队',
      showIf: bySessionOn,
      cells: [1, 2, 3].map(function (i) {
        return {
          key: 'mode' + d + i,
          options: SESSION_OPTIONS,
          title: label + '第' + i + '场（' + SESSION_TIMES[i - 1] + '）',
        };
      }),
    };
    if (r === 0) fd.head = ['第一场', '第二场', '第三场']; // 列头只挂周五行，三行共用同列宽
    return fd;
  }),
);

/**
 * 出征预设归一：单个战斗预设 1~8（面板改为单选，不再弄池）。
 *   兼容旧存档：无 preset 字段时取旧 presetPool[0]。非法/缺失回 0（引擎据空 presetPool 不发兵）。
 * @param {*} raw preset 面板原值（number），或旧 presetPool 数组首项
 * @returns {number} 1~8 或 0
 */
function sanitizePreset(raw) {
  var p = Number(raw) | 0;
  return p >= 1 && p <= 8 ? p : 0;
}

/**
 * 面板配置 → 运行时配置（toModuleCfg 与 configure 共用同一份归一化，防两处口径漂移）。
 *   事件/技能全项默认自动（无布尔开关），此处只归一「玩法模式/组队/出兵/两个 sortlist」。
 * @param {object} raw 面板 configs 快照
 * @returns {object} 归一化模块配置
 */
function normalize(raw) {
  raw = raw || {};
  var mode = raw.mode === 'helper' ? 'helper' : 'main'; // 兼容旧存档：无 mode 字段一律按主跑（旧 needRewardAsMember 语义并入 mode）
  var n = Number(raw.targetMemberNum) || 0;
  if (n < 2) n = 2;
  if (n > 5) n = 5; // 主表 max_ppl_num=5（§9.1 实测），下限 2 由服务器校验（2 人可开整局，§9.3 实样）
  var wm = Number(raw.waitMin); // 竞对口径 waitmin 默认 3；显式 0=关（不超时、等人齐），非法/负值亦回默认
  if (!(wm >= 0)) wm = DEFAULT_WAIT_MIN;
  var out = {
    mode: mode,
    modeBySession: !!raw.modeBySession,
    targetMemberNum: n,
    waitMin: wm,
    rolePool: sanitizePool(raw.rolePool),
    rejectOutsidePool: !!raw.rejectOutsidePool,
    useBeaconWhenShort: !!raw.useBeaconWhenShort,
    // ⑤ 每日夺宝局数上限（借鉴竞对 setting.team.count）：0=不限；主跑每完成一局计 1、跳日归零、到上限当日停跑
    dailyRuns: Math.max(0, Number(raw.dailyRuns) || 0),
    // ⑥ 每日局数满后自动转陪跑（借鉴竞对 autoSwitchToHelp）：默认关=到上限停跑（旧口径）；开=主跑跑满当日上限后自动转陪跑找跟队
    autoSwitchToHelper: !!raw.autoSwitchToHelper,
    // 面板单选一个预设，但引擎（buildPlanFromPool）仍收数组：包成单元素保持出兵语义链路不变
    presetPool: (function () {
      var p = sanitizePreset(
        raw.preset != null ? raw.preset : Array.isArray(raw.presetPool) ? raw.presetPool[0] : 0,
      );
      return p ? [p] : [];
    })(),
    skillPool: activeSortlist(raw.skillPool, []),
    // 幸运池：用户口径只保留 rollDice 一组勾选（其余场景勾选已废弃、即便旧存档残留也不读；引擎 #tryLucky 亦只认 rollDice）
    luckyRewards: (function () {
      var m = {};
      m[EVENT_TYPE.ROLL_DICE] = activeIds(raw[luckyFieldKey(EVENT_TYPE.ROLL_DICE)]);
      return m;
    })(),
  };
  // 各场模式矩阵 9 键：开关开时 follow 未定制格播种为主设置（与面板 fd.onChange 同口径，兜底手改存档）；
  //   开关关时原样透传（保留定制记忆，引擎 resolveMode 闸门忽略）；有效模式由引擎 #cfg() 按场次解析
  return Object.assign(
    out,
    raw.modeBySession ? seedFollowModes(raw, mode) : sanitizeSessionModes(raw),
  );
}

/**
 * 面板状态行（只读，零发包）：优先控制器快照，缺席时退回引擎已落地的推送态。
 * @returns {string} 多行文本
 */
function statusText() {
  var st = csHunt.readState();
  if (!st) return '控制器未接管（未进过玩法子包），开跑后由 7501/推送驱动';
  var eng = engine && engine.snapshot();
  var team = st.team || (eng && eng.team) || null;
  var count = eng && eng.count != null ? eng.count : st.huntCount; // huntCount 唯一来源是推送 21375（7501 不带）
  var eff = eng && eng.mode ? eng.mode : modCfg.mode;
  var bySession = !!modCfg.modeBySession;
  var modeLine = bySession
    ? '玩法模式：按场次矩阵（主设置兜底：' + (modCfg.mode === 'helper' ? '陪跑' : '主跑') + '）'
    : '玩法模式：' + (modCfg.mode === 'helper' ? '陪跑（不耗次数）' : '主跑（要奖励）');
  if (bySession && eng) {
    modeLine += eng.session
      ? '｜本场 ' + eng.session.label + ' → ' + (eff === 'helper' ? '陪跑' : '主跑')
      : '｜未在场次（到点按对应格子运行）';
  }
  var lines = ['剩余次数：' + count + '（未知显示 0）', '玩法开关：' + st.open, modeLine];
  if (eff !== 'helper') {
    var ran = getDailyRuns(); // -1=当日计数尚未读回
    var lim = modCfg.dailyRuns | 0;
    lines.push(
      '今日已跑：' +
        (ran < 0 ? '?' : ran) +
        (lim > 0 ? ' / ' + lim + ' 局上限' : ' 局（未设上限）'),
    );
  }
  if (!team) return lines.join('\n') + '\n当前无队';
  lines.push(
    '队伍 ' +
      team.id +
      '：' +
      team.memberCount +
      ' 人，status=' +
      team.status +
      (st.leader ? '（我是队长）' : ''),
  );
  lines.push('成员：' + (team.memberUids || []).join(', '));
  return lines.join('\n');
}

/**
 * 装配引擎运行底座（全走 getter 惰性读实时态，引擎不反向 import 本文件以免循环依赖）。
 * @returns {object} TeamEnv
 */
function buildEnv() {
  return {
    alive: function () {
      return !!(ctxRef && ctxRef.alive());
    },
    cfg: function () {
      return modCfg;
    },
    net: function () {
      return net || (ctxRef && ctxRef.net) || null;
    },
    onWake: function () {
      cycle.kick();
    },
  };
}

/** @type {{kick: function(), pending: boolean}} 兜底调和循环（主推进靠 push，这里只补漏推） */
var cycle = null;

/**
 * 安装：取网络底座。符号自检由 reactor 依 spec.symbols 走 CAPS，此处不重复探测。
 * @param {object} ctx reactor 上下文
 * @returns {boolean}
 */
function install(ctx) {
  ctxRef = ctx;
  if (installed) return true;
  net = ctx.net;
  if (!net || !net.install()) {
    net = null;
    log.warn('install failed. pocketcc.net unavailable');
    return false;
  }
  installed = true;
  log.info('installed.');
  return true;
}

/**
 * 运行（激活）：收旧引擎 → 起新引擎 → 首发 7501 拉态 → 武装 createCycle 点火。
 *   resume 会重跑 run，故先 stop 上一轮残留（编排闸/在飞 await），避免新旧两引擎并发发同一批写请求。
 * @param {object} ctx reactor 上下文
 */
function run(ctx) {
  ctxRef = ctx;
  stopEngine();
  if (cycle) cycle.dispose();
  engine = new TeamEngine(buildEnv());
  engine.start(ctx);
  // P0 只读闭环：状态机主推送与技能/来袭推送在本期只转储留痕（动作在 P3/P4，强依赖 §7-6/§7-8 未捕项）
  ctx.on.push(21377, (ev) =>
    log.debug('push 21377 info change: %s', JSON.stringify(ev && ev.data).slice(0, 300)),
  );
  ctx.on.push(21378, (ev) =>
    log.debug('push 21378 skill take effect: %s', JSON.stringify(ev && ev.data).slice(0, 300)),
  );
  ctx.on.push(21379, () => log.debug('push 21379 reward can loot'));
  ctx.on.push(21383, (ev) =>
    log.debug('push 21383 hurt march size: %s', JSON.stringify(ev && ev.data).slice(0, 300)),
  );
  ctx.on.push(21384, () => log.debug('push 21384 reward multiple'));
  cycle = createCycle({
    log: log,
    alive: function () {
      return !!(ctxRef && ctxRef.alive());
    },
    run: function () {
      return engine ? engine.tick() : 60000;
    },
    fallback: 60000,
  });
  // 7501 只读拉态（P0 闭环首步，req 体逐键 `{header:{}}`，实录报文实证）：
  //   发包与应答落地都在引擎里（resp 订阅已挂），装配层只负责点火强拉一次
  engine.refreshInfo(true);
  log.info(
    'started (mode=%s, bySession=%s, targetMembers=%d, gatherTimeout=%dmin, marchPresets=%j, beaconRefill=%s, skillPool=%j, luckyPool(rollDice)=%s, sessionModes=%j).',
    modCfg.mode,
    modCfg.modeBySession ? 'on' : 'off',
    modCfg.targetMemberNum,
    modCfg.waitMin,
    modCfg.presetPool,
    modCfg.useBeaconWhenShort ? 'on' : 'off',
    modCfg.skillPool,
    JSON.stringify(modCfg.luckyRewards.rollDice),
    SESSION_KEYS.reduce(function (m, k) {
      m[k] = modCfg[k];
      return m;
    }, {}),
  );
  cycle.kick();
}

/**
 * 接收面板配置（registry 经 toModuleCfg 推入）：整体赋值，不二次归一（归一已在 toModuleCfg 完成）。
 * @param {object} c 归一化后的模块配置
 */
function configure(c) {
  // c 已是 registry 调 toModuleCfg(=normalize) 产出的运行时形状，直接整体接收；**绝不二次 normalize**——
  //   首轮归一已把扁平面板键 luckyRollDice 转成 luckyRewards.rollDice，再 normalize 会读不到 luckyRollDice → 幸运池重置为空，
  //   致 #tryLucky 首闸 !wl.length 静默跳过、幸运必现漏用（两场主跑实录实证；同 auto-hunt 文件头「配置链路」踩坑记录）
  if (c) modCfg = c;
}

/** 收引擎（幂等）：只清引擎自持状态，事件退订由 reactor 统一摘除。 */
function stopEngine() {
  if (!engine) return;
  const e = engine;
  engine = null;
  try {
    e.stop();
  } catch (err) {
    log.warn('engine stop threw.', err);
  }
}

/**
 * 暂停钩子（core/reactor.js 的 pause() 末尾调）：收引擎自建状态 + 停循环。
 * 不显式收就会在 resume 后拿陈旧队伍快照对已解散/已开跑的队重发写请求。
 */
function pause() {
  stopEngine();
  if (cycle) cycle.dispose();
  cycle = null;
}

reactor.register({
  id: 'csHunt',
  label: '夺宝奇兵',
  storageKey: 'pocketcc.feat.csHunt',
  // 硬依赖：玩法控制器（ACL csHunt）、UID/次数（dataCenter）、Int64 装箱（long64Bit）、
  //   预设出兵五件套（Battle().plan().preset().adjust().build() 的符号依赖，同 auto-hunt 口径）
  symbols: [
    'csHuntController',
    'dataCenter',
    'long64Bit',
    'presetMarch',
    'heroController',
    'mechaController',
    'formationAdv',
    'marchStorage',
  ],
  places: ['base', 'world'],
  kinds: ['homeland'],
  // 面板可用性：控制器不在场（未进玩法子包/活动未开）或不在开赛期（ctrl.open≠1）时整卡置灰
  available: function () {
    if (!csHunt.present()) return { ok: false, reason: '夺宝奇兵尚未开放' };
    return csHunt.openFlag() === 1 ? true : { ok: false, reason: '夺宝奇兵当前未在开赛期' };
  },
  offInCombat: true, // 出征由 7519 满编行军承载，战斗演出模式让位（与发射井/打野同侧）
  defaults: {
    enabled: false,
    mode: 'main',
    // 按场次设置模式开关（默认关=统一主设置一刀切，矩阵隐藏且引擎忽略）；旧存档无键由 registry 合并默认值补齐
    modeBySession: false,
    // 矩阵 9 格默认 follow=未定制标记（开启开关瞬间播种为当时主设置）；已定制格跨开关往返保留
    modeFri1: 'follow',
    modeFri2: 'follow',
    modeFri3: 'follow',
    modeSat1: 'follow',
    modeSat2: 'follow',
    modeSat3: 'follow',
    modeSun1: 'follow',
    modeSun2: 'follow',
    modeSun3: 'follow',
    targetMemberNum: 5,
    waitMin: DEFAULT_WAIT_MIN,
    rolePool: [],
    rejectOutsidePool: false,
    useBeaconWhenShort: false,
    dailyRuns: 0,
    autoSwitchToHelper: false,
    preset: 1,
    skillPool: SKILL_GROUP_IDS.slice(),
    // 幸运池只留 rollDice 一组勾选（键与 luckyFieldKey(rollDice) 对应）；旧 luckyPickReward/luckyCodeBox/luckyDefPVE 及全量勾选存档已废弃、不再读
    luckyRollDice: [],
  },
  fields: [
    {
      key: 'status',
      type: 'text',
      label: '当前状态',
      section: '玩法状态',
      multiline: true,
      get: statusText,
      hint: '只读：剩余次数与队伍态自动同步。',
    },
    {
      key: 'modeBySession',
      type: 'checkbox',
      label: '按场次设置模式',
      section: '组队',
      hint: '关=只用下方「玩法模式」一刀切；开=隐藏该下拉，改由矩阵按周五/六/日×三场各自指定主跑/陪跑。开启瞬间未定制的格子自动播种为当前主设置，之后各格独立记忆（关再开不抹定制）。',
      // 开启瞬间播种：follow 未定制格回写为当时主设置（commit 前 mutate，落盘+显示同源）；已钉格保留
      onChange: function (c, on) {
        if (on) Object.assign(c, seedFollowModes(c, c.mode === 'helper' ? 'helper' : 'main'));
      },
    },
    {
      key: 'mode',
      type: 'select',
      label: '玩法模式',
      section: '组队',
      showIf: function (cfg) {
        return !bySessionOn(cfg);
      },
      options: [
        { value: 'main', label: '主跑（要奖励·耗次数）' },
        { value: 'helper', label: '陪跑（不耗次数·无奖励）' },
      ],
      hint: '主跑=建队开车或入队要奖励（耗次数）；陪跑=只跟队，不耗次数、无奖励。想按场次分别指定，勾选上方「按场次设置模式」。',
    },
    ...sessionFields,
    {
      key: 'targetMemberNum',
      type: 'number',
      label: '凑够人数就发车',
      section: '组队',
      min: 2,
      step: 1,
      showIf: isMain,
      hint: '2 人即可开完整局（人数下限由服务器校验）。',
    },
    {
      key: 'waitMin',
      type: 'number',
      label: '凑人超时发车（分钟）',
      section: '组队',
      min: 0,
      step: 1,
      showIf: isMain,
      hint: '人数未凑齐但已到位成员都派兵成功时，等满本分钟数即召集出发（避免永久等待）；0=死等人数到齐。',
    },
    {
      key: 'rolePool',
      type: 'uidlist',
      label: '指定队员/队长名单',
      section: '组队',
      max: 10,
      itemLabel: '玩家',
      itemCheck: true,
      placeholder: '请输入玩家UID',
      hint: '勾选的玩家才入池：主跑按池内名单审批入队申请；陪跑只申请加入池内成员创建的未满队；全不勾=陪跑不主动找队。',
    },
    {
      key: 'rejectOutsidePool',
      type: 'checkbox',
      label: '拒绝池外申请',
      section: '组队',
      showIf: isMain,
      hint: '勾选=拒绝池外入队申请；不勾=忽略（留着等其他队友好）。',
    },
    {
      key: 'dailyRuns',
      type: 'number',
      label: '每日局数上限',
      section: '组队',
      min: 0,
      step: 1,
      showIf: isMain,
      hint: '0=不限；主跑每完成一局计 1（持久跨页、明日自动归零），到上限当日不再建队/加入，陪跑不计数不受此限',
    },
    {
      key: 'autoSwitchToHelper',
      type: 'checkbox',
      label: '满次自动转陪跑',
      section: '组队',
      showIf: (cfg) => isMain(cfg) && Number(cfg.dailyRuns) > 0,
      hint: '需「每日局数上限」>0：主跑跑满后自动转陪跑（不耗次数、不主动要奖励）继续跟队；明日归零或调高上限自动回主跑。不勾=到上限当日停跑。',
    },
    {
      key: 'useBeaconWhenShort',
      type: 'checkbox',
      label: '次数不足用信标补',
      section: '组队',
      hint: '勾选且背包有定位信标时，建队前/要奖励前自动消耗 1 个补次数；库存不足或未勾选则照旧。',
    },
    {
      key: 'preset',
      type: 'select',
      label: '出征预设',
      section: '出兵',
      options: [
        { value: 1, label: '预设 1' },
        { value: 2, label: '预设 2' },
        { value: 3, label: '预设 3' },
        { value: 4, label: '预设 4' },
        { value: 5, label: '预设 5' },
        { value: 6, label: '预设 6' },
        { value: 7, label: '预设 7' },
        { value: 8, label: '预设 8' },
      ],
      hint: '满编出征只用这一个预设组兵；预设全在外则等回城补派，不发空包。',
    },
    {
      key: 'skillPool',
      type: 'sortlist',
      label: '科技池（拖拽优先级，越靠上越优先）',
      section: '事件与科技',
      all: function () {
        return SKILL_GROUP_IDS;
      },
      resolve: function (id) {
        return [{ id: id, name: groupName(id) }];
      },
      // 旧存档迁移：把历史上散开的 28 行 specId 收敛回族代表 id（同类归并），去重保序（不再读 off，旧 skillPoolOff 自然废弃）
      migrate: function (arr) {
        var seen = Object.create(null);
        var out = [];
        for (var i = 0; i < arr.length; i++) {
          var rep = skillGroupRep(arr[i]);
          if (!rep || seen[rep]) continue;
          seen[rep] = 1;
          out.push(rep);
        }
        return out;
      },
      hint: '候选科技按拖拽序取第一个可用的入背包（越靠上越优先）；同类已归并。',
    },
    // 分隔横幅：把下方「幸运触发物品」与上方科技池在 UI 上明确切开（note 无控件、不写配置，仅靠 section 出标题 + 一行说明）
    {
      type: 'note',
      section: '幸运触发物品',
      text: '只在「这次我最大」场景：掷骰中奖命中已勾道具时先用幸运×2；剩余幸运末回合按科技策略自动用掉。',
    },
    // 幸运池只留 rollDice 一组奖励清单（不折叠）；见 luckyFields
    ...luckyFields,
  ],
  toModuleCfg: normalize,
  configure: configure,
  install: install,
  run: run,
  pause: pause,
});
