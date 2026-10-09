/**
 * 战争之源（Source of War / WorldBossV2）—— feat 装配层。
 *
 * 本 feat 由「两套独立动作」构成，各持独立计时器、互不牵连（2026-10 由单文件按动作拆分，口径同 mine-cave）：
 *   ① 攻打（AttackFlow，attack.js）  ：窗口内自动派兵打世界 BOSS，每天定额 5 次，自持 scanTimer + 当日额度（落盘）。
 *   ② 领奖（RewardFlow，reward.js）  ：攻击次数奖励三箱，全天独立低频链，自持 claimTimer + 已领镜像（仅内存）。
 * 攻打与领奖是两个真正不相干的时间窗（领奖全天可领、与打不打得到 BOSS 无关），故各跑各的；本层只做：
 *   - 安装共享底座（net/dataCenter）、持有 presets、提供 env（getNet/getData/getPresets/alive）注入两引擎
 *   - 生命周期：install 取底座、configure 写 presets、run 起两引擎
 *   - reactor.register：三形态预设选择器 + 今日已打（攻打）+ 次数奖励（领奖）
 * 单一总开关（reactor enabled）驱动两引擎一起起停；不设 spec 级 offInCombat（那会连领奖一起暂停），
 *   攻打改由 attackOnce 内部判 isCombat()——战斗态只停派兵、领奖全天照跑。
 * 全部「只读+发包」：不改写游戏本地数据、不 OpenUI、不模拟点击。
 *
 * 命名与换代（详见 references/游戏逆向/战争之源模块分析报告.md）：
 *   总开关 UserData.bossV2Open（push 21922）为真时走 SOW 新链路，行军类型 NMarchType.ATTACK_WORLD_BOSS_V2 = 298，
 *   经 MARCH_WORLD_POINT(902) 派遣；旧链路（=false）用 14。本功能只在 SOW 生效时工作——非二期时 9956 无有效应答，自然空转。
 */
import { createLog } from '../../../core/log.js';
import { game } from '../../../core/game.js';
import { reactor } from '../../../core/reactor.js';
import { AttackFlow } from './attack.js';
import { RewardFlow } from './reward.js';

/** @type {ReturnType<createLog>} 装配层日志器（tag=SOURCE-OF-WAR，与两引擎一致） */
const log = createLog('SOURCE-OF-WAR');

/** @type {number} BOSS 形态数（0陆/1海/2空），与面板三个预设选择器一一对应 */
const FORM_COUNT = 3;

/**
 * 三形态各选的预设部队号：index = BOSS.type（0陆/1海/2空），value = 预设队号 1-8，0=不攻打该形态
 * @type {number[]}
 */
var presets = [0, 0, 0];

/** @type {object|null} 网络底座（promise 封装 pocketcc.net） */
var net;
/** @type {object|null} DataCenter.DATA（读 UserData 等级/体力/行军槽/系统零点/服务器时间） */
var dataCenter;
/** @type {object|null} reactor 注入的上下文；alive() 反映运行态，pause 后置否让在飞流程自然退出 */
var ctxRef = null;
/** @type {boolean} install 幂等守卫 */
var installed = false;

/**
 * 功能是否仍在运行（两引擎的定时器与在飞流程的存活判定）
 * @returns {boolean}
 */
function aliveFn() {
  return ctxRef ? ctxRef.alive() : false;
}

// ─────────── 注入两引擎的共享底座（惰性 getter，规避引擎反向 import index 的循环依赖） ───────────
const env = {
  getNet: function () {
    return net;
  },
  getData: function () {
    return dataCenter;
  },
  getPresets: function () {
    return presets;
  },
  alive: aliveFn,
};
const attack = new AttackFlow(env);
const reward = new RewardFlow(env);

// ─────────── 生命周期 ───────────
/**
 * 安装：取网络底座 + 数据中心。任一缺失即失败（reactor 不会激活）。
 * @param {object} ctx reactor 上下文
 * @returns {boolean}
 */
function install(ctx) {
  ctxRef = ctx;
  if (installed) return true;

  var missing = [];

  net = ctx.net;
  if (!net.install()) {
    missing.push('pocketcc.net');
    net = null;
  }

  var dc = game.get('DataCenter');
  dataCenter = (dc && dc.DATA) || (missing.push('DataCenter'), null);

  if (missing.length) {
    net = null;
    dataCenter = null;
    log.warn('install failed. missing=%s', missing.join(';'));
    return false;
  }

  installed = true;
  log.info('installed.');
  return true;
}

/**
 * 注入模块配置：三形态预设队号（面板选择器产出的 0-8）。非法值忽略，运行中改选下一轮扫描即生效。
 * @param {object} partial { presets: number[] }（toModuleCfg 产出）
 * @returns {number[]} 当前 presets
 */
function configure(partial) {
  if (partial && Array.isArray(partial.presets)) {
    for (var i = 0; i < FORM_COUNT; i++) {
      var v = partial.presets[i] | 0;
      presets[i] = v >= 0 && v <= 8 ? v : 0;
    }
  }
  return presets;
}

/**
 * 运行：点火两条独立链（领奖全天链 reward + 攻打窗口链 attack）。
 * pause 后 alive()=false 两条链定时器到点空转；resume 各自重排（每日额度是持久值，跨暂停有效）。
 * @param {object} ctx reactor 上下文
 * @returns {Promise<void>}
 */
async function run(ctx) {
  ctxRef = ctx;
  reward.start(ctx); // 订阅 21923/21924 + 试领一轮 + 排全天低频轮询
  await attack.start(ctx); // 订阅 10019 + 读回当日额度 + 首个 tick 立即判位/攻打
}

// ─────────── 注册 ───────────
/**
 * 向 reactor 注册本功能说明书：场景限定 Home/NWorldMap；不设 offInCombat（那会连领奖一起暂停），
 * 攻打改由 attackOnce 内部判战斗态、领奖链全天独立。
 * 面板带三形态预设选择器（各 0-8，0=不攻打该形态）+ 今日已攻打计数（攻打链）+ 次数奖励（领奖链）；
 * 窗口/定额/间隔为各引擎内置常量（attack.js DAILY_LIMIT/WARMUP_DELAY/TICK_INTERVAL、reward.js CLAIM_POLL_INTERVAL）。
 */
reactor.register({
  id: 'sourceOfWar',
  label: '战争之源',
  storageKey: 'pocketcc.feat.sourceOfWar',
  symbols: ['dataCenter', 'tableUtils', 'tableManager'],
  scenes: ['Home', 'NWorldMap'],
  defaults: {
    enabled: false,
    armyPreset: 0, // 陆军形态（BOSS.type=0）预设队号 0-8
    oceanPreset: 0, // 海军形态（BOSS.type=1）预设队号 0-8
    airPreset: 0, // 空军形态（BOSS.type=2）预设队号 0-8
  },
  fields: (function () {
    // 0-8 下拉选项：0=不攻打该形态，1-8=预设部队 N。形态名直接做行标签、不分组（pc-row 就是标签靠左+控件靠右的一行）。
    var options = [{ value: 0, label: '不攻打' }];
    for (var i = 1; i <= 8; i++) options.push({ value: i, label: '预设部队 ' + i });
    var mk = function (key, label) {
      return { key: key, label: label, type: 'select', options: options };
    };
    return [
      mk('armyPreset', '陆军形态'),
      mk('oceanPreset', '海军形态'),
      mk('airPreset', '空军形态'),
      {
        key: 'todayCount',
        label: '今日已打',
        type: 'text',
        get: function () {
          return attack.formatToday();
        },
      },
      {
        key: 'todayReward',
        label: '次数奖励',
        type: 'text',
        get: function () {
          return reward.formatRewardToday();
        },
      },
    ];
  })(),
  toModuleCfg: function (c) {
    return { presets: [c.armyPreset | 0, c.oceanPreset | 0, c.airPreset | 0] };
  },
  install: install,
  configure: configure,
  run: run,
});
