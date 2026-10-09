/**
 * 快捷攻击（reactor 说明书形态）
 *
 * 世界地图打开目标面板时，用键盘快捷键对面板目标发起行军（902 MARCH_WORLD_POINT）：
 *   [1]-[8]      以对应预设编队单次攻击；
 *   Shift+[1]-[8] 三连：第 1 发该预设，随后 2 发最小出征（Battle.plan().minimal()），次间固定间隔 TRIPLE_INTERVAL_MS。
 *
 * 目标区/坐标来自「方案2」：拦截面板 prototype.onShow，游戏原逻辑填好 this[spec.field]（tileInfo）后，
 * 我们读它拷成纯标量存进 activePanel。面板消失（prototype.onDisable）即清空 activePanel 并摘键盘监听。
 *
 * 监听生命周期（机制B）：键盘事件只能挂 document（cc.Node 收不到 DOM keydown），故
 *   onShow（面板出现）→ 覆盖式挂 document keydown；onDisable（面板消失）→ 摘除。一次只展示一个面板，
 *   activePanel 单引用即可；onKeyDown 再复查 comp.isValid && node.activeInHierarchy 兜底防漏触发误发。
 *
 * 依赖游戏运行时只「读 + 发包」，不调任何 Update/Delete 改写类方法（遵守 feat 只读+发包约束）。
 * 场景门控限 NWorldMap。属「战斗设置」：快捷战斗只在目标面板开着时按快捷键才发一波，是战斗时的手动辅助，
 * 故不声明 offInCombat（与日常行军自动化相反：战斗模式下仍照常生效）。挂钩对称可还原，功能停用即摘净。
 *
 * marchType 跨服漂移（无双峡谷等跨服战场实测）：注册表里存的是「本服基础值」，发包前经
 * core/game-api.js 的 march.resolve() 按当前战场换算（游戏原生 WorldUtils.dealMarchTypeWithSpecialMarch
 * 优先，符号漂移时降级本地兜底表 MARCH_FALLBACK）——跨服服下直接拿 13 打玩家城会被服务器拒。
 */
import { createLog } from '../../core/log.js';
import { game } from '../../core/game.js';
import { march as marchApi } from '../../core/game-api.js';
import { reactor } from '../../core/reactor.js';
import { isTypingTarget } from '../../core/hotkeys.js';
import { Battle } from '../../core/battle.js';
import { march } from '../../core/march.js';

/**
 * 可攻击面板注册表（可扩展的唯一入口）：新增一个可攻击面板 = 往此数组追加一条 spec，
 * 快捷键分派 / 面板 onShow-onDisable 钩子 / 发包 / 三连逻辑全部零改动。
 * spec: { key 场景标识, label 日志展示, cls 面板类（game.get(cls).default）,
 *         field onShow 后 tileInfo 落在组件上的字段名,
 *         marchTypes.attack 本服基础 NMarchType（发包前由 marchApi.resolve 做跨服漂移换算）,
 *         marchTypes.attackV2 可选：同面板二期实体（按 tileInfo.type 分流）的行军类型（兜底值）,
 *         marchMembers 可选：行军类型以游戏 MarchType 枚举成员名为权威源（marchApi.typeOf 运行时取名，
 *           成员名收在 core/game-api.js SYM.marchEnum），marchTypes 数值仅作符号漂移兜底 }
 * NMarchType 见 extracted/Script/WorldMapCommon__WorldMapCommon.js 的 MarchType 枚举。
 * @type {Array<{key:string, label:string, cls:string, field:string, marchTypes:{attack:number, attackV2?:number}, marchMembers?:{attack:string, attackV2?:string}}>}
 */
const QUICK_ATTACK_TARGETS = [
  {
    key: 'city',
    label: '城市',
    cls: 'NWorldCityPopup',
    field: 'tileInfo',
    marchTypes: { attack: 13 },
  }, // ATTACK_PLAYER（跨服战场经 resolve 漂移到 150/170/110/181）
  {
    key: 'monster',
    label: '野怪',
    cls: 'NWorldMapEnemy',
    field: 'tileInfo',
    marchTypes: { attack: 5 },
  }, // ATTACK_MONSTER
  {
    key: 'nMonster',
    label: '新野怪',
    cls: 'NWorldMapNEnemy',
    field: '_tileInfo',
    marchTypes: { attack: 5 },
  }, // ATTACK_MONSTER
  {
    key: 'mine',
    label: '矿点',
    cls: 'NWorldResourcePopup',
    field: 'tileInfo',
    marchTypes: { attack: 3 },
  }, // GATHER_RESOURCE 位
  // 世界 BOSS：普通=ATTACK_WORLDBOSS(14)；BOSS_V2 实体=ATTACK_WORLD_BOSS_V2(298)，行军类型走游戏枚举成员名，
  // 口径同游戏 WorldBossDetailPanel._onClickAttackBtn（tileInfo.type===WorldMapEntityType.BOSS_V2）。
  {
    key: 'boss',
    label: '世界BOSS',
    cls: 'WorldBossDetailPanel',
    field: 'tileInfo',
    marchTypes: { attack: 14, attackV2: 298 },
    marchMembers: { attack: 'attackWorldBoss', attackV2: 'attackWorldBossV2' },
  },
];

/**
 * marchType 兜底数值表：只在游戏枚举/判定器符号漂移时兜底（主路径向游戏运行时取名值）。
 * 数值出处：WorldMapCommon.MarchType + WorldUtils.dealMarchTypeWithSpecialMarch 优先级链 AVA→TM→MASTER→TEAM_LEGEND。
 * @type {{attackPlayer:number, tm:number, master:number, ava:number, teamLegend:number}}
 */
const MARCH_FALLBACK = { attackPlayer: 13, tm: 150, master: 170, ava: 110, teamLegend: 181 };

/** @type {number} 三连次间间隔（毫秒，内置常量，不在面板配置） */
const TRIPLE_INTERVAL_MS = 1000;

/**
 * 生成模块 cfg：全部为内置常量——各场景默认启用、行军类型取自注册表，三连间隔用 TRIPLE_INTERVAL_MS。
 * 不从面板读取（面板只出 enabled 一个开关）。
 * @returns {object} { tripleIntervalMs, targets: { <key>: { enabled, marchTypes } } }
 */
function buildModuleCfg() {
  var targets = {};
  QUICK_ATTACK_TARGETS.forEach(function (spec) {
    targets[spec.key] = {
      enabled: true,
      marchTypes: { attack: spec.marchTypes.attack, attackV2: spec.marchTypes.attackV2 },
    };
  });
  return { tripleIntervalMs: TRIPLE_INTERVAL_MS, targets: targets };
}

/** @type {ReturnType<createLog>} 模块日志器（tag=QUICK_ATTACK） */
const log = createLog('QUICK_ATTACK');

/** @type {number} RequestId.MARCH_WORLD_POINT：世界地图行军；仅用于发攻前的同 cmd 在途频控（发送走 core/march.attack） */
const CMD_MARCH_WORLD_POINT = 902;

/** @type {object|null} 网络底座（install 时取） */
var net;
/** @type {object|null} DataCenter.DATA（提供行军上限） */
var dataCenter;

/** @type {object|null} reactor 注入的上下文；alive() 反映运行态，pause 后置否让在飞三连自然中断 */
var ctxRef = null;

/**
 * 模块内部配置：{ tripleIntervalMs:number, targets:{ <key>:{ enabled:boolean, marchTypes:{ attack:number } } } }
 * 初值即内置常量（见本文件 buildModuleCfg）；面板只出启用开关，不覆盖这些值。
 * @type {object}
 */
var cfg = buildModuleCfg();

/** @type {Object<string,object|null>} spec.cls -> 解析到的面板类（install 时填充；解析失败为 null，跳过该场景不阻断其它） */
var classOf = {};

/** @type {Map<string,Array<function():void>>} spec.cls -> 该面板当前已挂的还原函数数组（onShow/onDisable）；非空即已 hook */
var hooks = new Map();

/** @type {{spec:object, comp:object, target:object}|null} 当前在场面板；一次只展示一个，故单引用 */
var activePanel = null;

/** @type {boolean} document keydown 是否已挂（attachKey/detachKey 维护，保证全局最多一个） */
var keyListening = false;

/** @type {boolean} install 幂等守卫 */
var installed = false;

/**
 * 功能是否仍在运行（在飞流程的 await 回来后的存活判定）
 * @returns {boolean}
 */
function aliveFn() {
  return ctxRef ? ctxRef.alive() : false;
}

// ── 键盘监听挂/摘 ──────────────────────────────────────────────────────
/**
 * 挂 document keydown 捕获监听（幂等：已挂则直接返回）
 */
function attachKey() {
  if (keyListening) return;
  document.addEventListener('keydown', onKeyDown, true);
  keyListening = true;
}

/**
 * 摘 document keydown 监听（幂等）
 */
function detachKey() {
  if (!keyListening) return;
  document.removeEventListener('keydown', onKeyDown, true);
  keyListening = false;
}

// ── 面板 onShow / onDisable 包装（拦在面板自己身上）─────────────────────
/**
 * 面板出现：让游戏原 onShow 先跑（填好 tileInfo），再把目标登记进 activePanel 并挂 keydown。
 * 覆盖式：先摘上一个（一次只展示一个面板，新面板直接替换旧的）。
 * @param {object} spec 场景定义
 * @param {object} comp 面板组件实例（this）
 */
function onPanelShow(spec, comp) {
  if (!aliveFn()) return;
  var t = cfg.targets[spec.key];
  if (!t || !t.enabled) return;

  var tile = comp[spec.field];
  if (!tile || tile.tileX == null || tile.tileY == null) {
    log.debug('panel shown without tile coords, skip. key=%s', spec.key);
    return;
  }

  detachKey();
  activePanel = {
    spec: spec,
    comp: comp,
    target: {
      x: tile.tileX | 0,
      y: tile.tileY | 0,
      serverId: tile.serverId,
      subMap: tile.subMap,
      // 地块实体类型原值（boss 场景靠它区分普通/BOSS_V2，换算见 resolveMarchType）
      entityType: tile.type,
    },
  };
  attachKey();
  log.debug('panel active. key=%s;x=%d;y=%d', spec.key, activePanel.target.x, activePanel.target.y);
}

/**
 * 面板消失：若消失的正是当前 activePanel 的面板，清空并摘 keydown。
 * @param {object} comp 面板组件实例（this）
 */
function onPanelDisable(comp) {
  if (activePanel && activePanel.comp === comp) {
    detachKey();
    activePanel = null;
  }
}

/**
 * 用一个原型方法包装：实例属性遮蔽原型，仅当最外层还是自己时才还原。
 * @param {object} proto 目标 prototype
 * @param {string} name 方法名 onShow/onDisable
 * @param {function(...):void} after 原方法执行完后回调（收 this 与实参数组）
 * @returns {function} 还原函数
 */
function wrapProto(proto, name, after) {
  var hadOwn = Object.prototype.hasOwnProperty.call(proto, name);
  var orig = hadOwn ? proto[name] : typeof proto[name] === 'function' ? proto[name] : null;
  var wrapper = function () {
    var ret;
    if (orig) ret = orig.apply(this, arguments);
    try {
      after(this, arguments);
    } catch (err) {
      log.warn('%s wrapper threw.', name, err);
    }
    return ret;
  };
  proto[name] = wrapper;
  return function () {
    if (proto[name] === wrapper) {
      if (hadOwn) proto[name] = orig;
      else delete proto[name];
    }
  };
}

/**
 * 挂一个场景的面板钩子（幂等：已 hook 的 cls 跳过）。
 * @param {object} spec 场景定义
 */
function hookSpec(spec) {
  if (hooks.has(spec.cls)) return;
  var Klass = classOf[spec.cls];
  if (!Klass || !Klass.prototype) {
    log.warn('panel class unavailable, skip hook. cls=%s', spec.cls);
    return;
  }
  var proto = Klass.prototype;
  var restores = [
    wrapProto(proto, 'onShow', function (self) {
      onPanelShow(spec, self);
    }),
    wrapProto(proto, 'onDisable', function (self) {
      onPanelDisable(self);
    }),
  ];
  hooks.set(spec.cls, restores);
}

/**
 * 摘掉全部面板钩子 + 键盘监听 + activePanel（功能停用时）。
 */
function unhookAll() {
  hooks.forEach(function (restores) {
    restores.forEach(function (r) {
      r();
    });
  });
  hooks.clear();
  detachKey();
  activePanel = null;
}

// ── 键盘分派 ───────────────────────────────────────────────────────────
/**
 * 解析按键 → { digit:1..8|null, triple:boolean }。以 event.code 为主（与 Shift 无关，最稳），
 * event.key 数字/符号兜底。ctrl/alt/meta 组合、以及「正在输入框打字」（core/hotkeys isTypingTarget，
 * 已穿透 Shadow DOM 取真实焦点元素）一律忽略，热键让位给打字。
 * @param {KeyboardEvent} e
 * @returns {{digit:number|null, triple:boolean}}
 */
function readHotkey(e) {
  if (isTypingTarget(e)) return { digit: null, triple: false };
  if (e.ctrlKey || e.altKey || e.metaKey) return { digit: null, triple: false };

  var digit = 0;
  var m = typeof e.code === 'string' && /^Digit([1-8])$/.exec(e.code);
  if (m) {
    digit = parseInt(m[1], 10);
  } else {
    var k = e.key;
    if (k >= '1' && k <= '8') digit = k.charCodeAt(0) - 48;
    else {
      var symbols = { '!': 1, '@': 2, '#': 3, $: 4, '%': 5, '^': 6, '&': 7, '*': 8 };
      if (symbols[k]) digit = symbols[k];
    }
  }
  return { digit: digit || null, triple: !!e.shiftKey };
}

/**
 * keydown 分派：校验在场面板 -> 解热键 -> 组装单次/三连计划 -> 交给 attackFlow。
 * @param {KeyboardEvent} e 键盘事件
 */
function onKeyDown(e) {
  if (!aliveFn() || !activePanel) return;

  // 兜底：onDisable 漏触发时（切场景/对象池复用未 destroy），面板实际已不在场则直接放弃并收摊
  var comp = activePanel.comp;
  var node = comp && comp.node;
  if (!comp || comp.isValid === false || (node && node.activeInHierarchy === false)) {
    detachKey();
    activePanel = null;
    return;
  }

  var hk = readHotkey(e);
  if (!hk.digit) return;

  var t = cfg.targets[activePanel.spec.key];
  if (!t || !t.enabled) return;

  e.preventDefault();
  e.stopPropagation();

  var planList = [{ kind: 'preset', index: hk.digit }];
  if (hk.triple) {
    planList.push({ kind: 'minimal' }, { kind: 'minimal' });
  }

  attackFlow(activePanel.spec, activePanel.target, planList).catch(function (err) {
    log.warn('attack flow threw!', err);
  });
}

/**
 * 一串行军流程：串行逐发、同步等待回包，永不 reject。每发前复查闸门（存活/行军槽/902 在途/兵量），
 * 发空兵或被拒即中止后续（不派空兵打世界目标）；本发回包后 sleep(tripleIntervalMs) 再发下一发。
 * @param {object} spec 场景定义
 * @param {object} target {x,y,entityType}
 * @param {object[]} planList 逐项 {kind:'preset'|'minimal', index?}
 */
async function attackFlow(spec, target, planList) {
  var base = (cfg.targets[spec.key] && cfg.targets[spec.key].marchTypes.attack) | 0;
  if (!base) {
    log.warn('no marchType configured, abort. key=%s', spec.key);
    return;
  }
  var marchType = resolveMarchType(spec, target);

  for (var i = 0; i < planList.length; i++) {
    if (!aliveFn()) return;

    if (!march.canMarch()) {
      log.info('no free march slot, abort. key=%s;step=%d', spec.key, i + 1);
      return;
    }
    if (net.isSending(CMD_MARCH_WORLD_POINT)) {
      log.info('902 in flight, abort. key=%s;step=%d', spec.key, i + 1);
      return;
    }

    var step = planList[i];
    var plan = new Battle().plan();
    if (step.kind === 'preset') plan.preset(step.index).adjust();
    else plan.minimal();
    var marchData = plan.build();

    if (!marchData.armyListNew.length) {
      log.warn('no army to dispatch, abort. key=%s;step=%d;kind=%s', spec.key, i + 1, step.kind);
      return;
    }

    var ret = await march.attack({ marchType: marchType, target: target, data: marchData });
    if (!aliveFn()) return;

    if (ret.ok) {
      log.info(
        'attack ok. key=%s;step=%d/%d;marchType=%d(base=%d);x=%d;y=%d',
        spec.key,
        i + 1,
        planList.length,
        marchType,
        base,
        target.x,
        target.y,
      );
    } else {
      log.info(
        'attack rejected, abort combo. key=%s;step=%d;code=%d;marchType=%d;base=%d;flags=%s;data=%s',
        spec.key,
        i + 1,
        ret.code,
        marchType,
        base,
        JSON.stringify(marchApi.flags()),
        ret.data,
      );
      return;
    }

    if (i < planList.length - 1) {
      await sleep(cfg.tripleIntervalMs);
    }
  }
}

/**
 * 本次出征的 marchType：先按地块实体类型分流（boss 二期），再做跨服战场漂移换算。
 * @param {object} spec 场景定义
 * @param {object} target {x,y,entityType}
 * @returns {number}
 */
function resolveMarchType(spec, target) {
  var t = (cfg.targets[spec.key] && cfg.targets[spec.key].marchTypes) || {};
  var v2 = !!(t.attackV2 && marchApi.isBossV2(target.entityType));
  var base;
  if (spec.marchMembers && spec.marchMembers.attack) {
    // 注册表声明了枚举成员名的场景（世界 BOSS 两型）：以游戏 MarchType 运行时值为权威源，marchTypes 数值仅漂移兜底
    base =
      v2 && spec.marchMembers.attackV2
        ? marchApi.typeOf(spec.marchMembers.attackV2, t.attackV2 | 0)
        : marchApi.typeOf(spec.marchMembers.attack, t.attack | 0);
  } else {
    base = t.attack | 0;
    if (v2) base = t.attackV2 | 0;
  }
  var resolved = marchApi.resolve(base, MARCH_FALLBACK);
  if (resolved !== base)
    log.info(
      'marchType 漂移. key=%s;base=%d->%d;flags=%s',
      spec.key,
      base,
      resolved,
      JSON.stringify(marchApi.flags()),
    );
  return resolved;
}

/**
 * 等待毫秒（负值钳到 0）
 * @param {number} ms 时长
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, Math.max(0, ms | 0));
  });
}

/**
 * 注入模块配置（toModuleCfg 产出的是内置常量，非面板可调项：面板仅出 enabled 开关）。
 * enabled=false 时顺带摘净钩子（reactor 稍后会 pause；此处保证停用不留常驻包装）。
 * @param {object} partial { enabled, tripleIntervalMs, targets:{ <key>:{enabled,marchTypes} } }
 * @returns {object} 当前 cfg
 */
function configure(partial) {
  if (!partial) return cfg;
  if (typeof partial.tripleIntervalMs === 'number' && partial.tripleIntervalMs >= 0) {
    cfg.tripleIntervalMs = partial.tripleIntervalMs;
  }
  var targets = partial.targets;
  if (targets) {
    QUICK_ATTACK_TARGETS.forEach(function (spec) {
      var t = targets[spec.key];
      if (!t) return;
      var cur =
        cfg.targets[spec.key] ||
        (cfg.targets[spec.key] = {
          enabled: true,
          marchTypes: { attack: spec.marchTypes.attack, attackV2: spec.marchTypes.attackV2 },
        });
      if (typeof t.enabled === 'boolean') cur.enabled = t.enabled;
      if (t.marchTypes && typeof t.marchTypes.attack === 'number' && t.marchTypes.attack > 0) {
        cur.marchTypes.attack = t.marchTypes.attack;
      }
    });
  }
  if (partial.enabled === false) unhookAll();
  return cfg;
}

/**
 * 安装：取网络 + 数据中心，解析各场景面板类（缺类仅记日志，不阻断其它场景）。
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

  dataCenter = game.get('DataCenter');
  dataCenter = (dataCenter && dataCenter.DATA) || (missing.push('DataCenter'), null);

  QUICK_ATTACK_TARGETS.forEach(function (spec) {
    var mod = game.get(spec.cls);
    classOf[spec.cls] = (mod && mod.default) || null;
    if (!classOf[spec.cls]) log.warn('panel class not found. cls=%s', spec.cls);
  });

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
 * 运行：复位监听态后按注册表挂面板钩子（不直接挂 keydown——keydown 由面板 onShow 触发时才挂）。
 * @param {object} ctx reactor 上下文
 */
function run(ctx) {
  ctxRef = ctx;
  activePanel = null;
  detachKey();
  QUICK_ATTACK_TARGETS.forEach(hookSpec);
  log.info('started, hooks=%d; battlefield=%s', hooks.size, JSON.stringify(marchApi.flags()));
}

/**
 * 向 reactor 注册本功能说明书：场景限定 NWorldMap，不声明 offInCombat（战斗设置本就是战斗时的手动辅助）。
 */
reactor.register({
  id: 'quickAttack',
  label: '快捷攻击',
  storageKey: 'pocketcc.feat.quickAttack',
  symbols: [
    'dataCenter',
    'marchType',
    'worldUtils',
    'presetMarch',
    'heroController',
    'mechaController',
    'formationAdv',
    'marchStorage',
  ],
  scenes: ['NWorldMap'],
  // 战斗设置类：不声明 offInCombat，战斗模式下依然生效（快捷战斗本就是战斗时的手动辅）
  defaults: { enabled: false },
  fields: [],
  toModuleCfg: buildModuleCfg,
  install: install,
  configure: configure,
  run: run,
});
