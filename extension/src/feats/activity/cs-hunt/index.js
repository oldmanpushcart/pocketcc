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
 *   游戏符号（CSHuntController / DataCenter.UID）一律经 core/game-api.js ACL（csHunt / gameData），此处不摸 game.get。
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
import { bits, csHunt } from '../../../core/game-api.js';
import { TeamEngine } from './engine-team.js';
import { SKILL_GROUP_IDS, groupName, skillGroupRep } from './skills.js';
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
 * @type {{mode:'main'|'helper', targetMemberNum:number, rolePool:Array<{uid:string,name:string}>, rejectOutsidePool:boolean, useBeaconWhenShort:boolean, presetPool:number[], skillPool:number[], luckyRewards:Object<string,number[]>}}
 *   presetPool = 单元素数组（面板单选一个预设 1~8）；skillPool = 族代表 id 的优先级序（见 skills.js SKILL_GROUPS）。
 */
var modCfg = normalize({});

/**
 * 面板 showIf 闸门：仅「主跑」模式才展开建队/凑人/拒池外这些队长专属参数（陪跑只跟队，这些不参与）。
 * @param {object} cfg 当前配置
 * @returns {boolean}
 */
function isMain(cfg) {
  return !cfg || cfg.mode !== 'helper';
}

/**
 * 角色池归一：只留合法 uid（Int64 一律字符串，禁 Number 化），去重，保留面板行序。
 * @param {*} raw uidlist 面板原值 `[{uid,name}]`
 * @returns {Array<{uid:string, name:string}>}
 */
function sanitizePool(raw) {
  var out = [];
  var arr = Array.isArray(raw) ? raw : [];
  for (var i = 0; i < arr.length; i++) {
    var it = arr[i] || {};
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
    hint: '只在「这次我最大」(rollDice) 场景使用：掷骰中奖奖励命中已勾道具且有幸运降临(18) 时先 7551 用幸运 ×2；一个都不勾=本局不用幸运（背包剩余幸运到末回合自动清空无脑用掉）',
  },
];

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
  return {
    mode: mode,
    targetMemberNum: n,
    rolePool: sanitizePool(raw.rolePool),
    rejectOutsidePool: !!raw.rejectOutsidePool,
    useBeaconWhenShort: !!raw.useBeaconWhenShort,
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
  var lines = [
    '剩余次数：' + count + '（未知显示 0）',
    '玩法开关：' + st.open,
    '玩法模式：' + (modCfg.mode === 'helper' ? '陪跑（不耗次数）' : '主跑（要奖励）'),
  ];
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
  // 7501 只读拉态（P0 闭环首步，req 体逐键 `{header:{}}`，报文实证 dashcam 20261016T191700 seq7）：
  //   发包与应答落地都在引擎里（resp 订阅已挂），装配层只负责点火强拉一次
  engine.refreshInfo(true);
  log.info(
    'started (mode=%s, 目标人数=%d, 出征预设=%j, 信标补次数=%s, 科技池=%j, 幸运池=%d 项).',
    modCfg.mode,
    modCfg.targetMemberNum,
    modCfg.presetPool,
    modCfg.useBeaconWhenShort ? '开' : '关',
    modCfg.skillPool,
    modCfg.luckyRewards.length,
  );
  cycle.kick();
}

/**
 * 接收面板配置（registry 经 toModuleCfg 推入）：整体赋值，不二次归一（归一已在 toModuleCfg 完成）。
 * @param {object} c 归一化后的模块配置
 */
function configure(c) {
  modCfg = normalize(c);
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
  offInCombat: true, // 出征由 7519 满编行军承载，战斗演出模式让位（与发射井/打野同侧）
  defaults: {
    enabled: false,
    mode: 'main',
    targetMemberNum: 5,
    rolePool: [],
    rejectOutsidePool: false,
    useBeaconWhenShort: false,
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
      hint: '只读：剩余次数由推送 21375 喂（7501 应答不含次数），队伍态由 21371/控制器快照落地',
    },
    {
      key: 'mode',
      type: 'select',
      label: '玩法模式',
      section: '组队',
      options: [
        { value: 'main', label: '主跑（要奖励·耗次数）' },
        { value: 'helper', label: '陪跑（不耗次数·无奖励）' },
      ],
      hint: '主跑：无队时可建队开车或作为要奖励队员入队（op:1）；陪跑：只跟队、不耗自己次数且拿不到奖励（op:2）',
    },
    {
      key: 'targetMemberNum',
      type: 'number',
      label: '凑够人数就发车',
      section: '组队',
      min: 2,
      step: 1,
      showIf: isMain,
      hint: '主表 max_ppl_num=5；2 人即可开完整局（下限由服务器校验）',
    },
    {
      key: 'rolePool',
      type: 'uidlist',
      label: '指定队员/队长名单',
      section: '组队',
      max: 10,
      itemLabel: '玩家',
      placeholder: '请输入玩家UID',
      hint: '队长（主跑开车）按名单审批入队申请（7523）；陪跑找队时逐个名单成员 630 取名→7530 按名搜其创建的未满队→7522 申请加入；留空=陪跑不主动找队',
    },
    {
      key: 'rejectOutsidePool',
      type: 'checkbox',
      label: '拒绝池外申请',
      section: '组队',
      showIf: isMain,
      hint: '勾选则池外申请回 7523 op:2 拒绝；不勾则忽略（留着等其他队友好）',
    },
    {
      key: 'useBeaconWhenShort',
      type: 'checkbox',
      label: '次数不足用信标补',
      section: '组队',
      hint: '勾选且背包有定位信标(47001001)时，建队前/要奖励前自动消耗 1 个补次数（通用使用物品 815）；库存不足或未勾选则照旧降级/跳过',
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
      hint: '满编出征 7519 只这一个预设组兵；该预设全在外则不发空包，等回城唤醒补派',
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
      hint: '奇妙新科技(7538) 在候选里按此顺序（越靠上越优先）取第一个可用科技入背包；全量科技均参与、仅按拖拽序定优先级（不再逐项勾选）。同类已归并（战场变换/诱敌来袭/固定增强各一项）。',
    },
    // 分隔横幅：把下方「幸运触发物品」与上方科技池在 UI 上明确切开（note 无控件、不写配置，仅靠 section 出标题 + 一行说明）
    {
      type: 'note',
      section: '幸运触发物品',
      text: '只在这次我最大(rollDice)场景下使用：掷骰中奖奖励命中下方已勾道具时，先 7551 用幸运降临(18) ×2；背包剩余的幸运到末回合按「科技使用策略」自动清空无脑用掉',
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
