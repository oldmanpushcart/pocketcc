// 功能调度中枢：spec（说明书）驱动的安装/激活/暂停。一个功能的全部声明都交给 register()，
//   运行期只由两个变量决定启停：面板 enabled（registry 推 setConfig）与门控 gates（world/mode）。
//   install 只做一次（可重复的挂钩），configure 每次推配置，run 只挂触发器；暂停不卸载，
//   统一摘除 ctx.on.* 登记的触发器，在飞流程靠 ctx.alive() 自行退出。
import { createLog } from './log.js';
import { bus, EVT } from './bus.js';
import { game } from './game.js';
import { checkCap } from './game-api.js';
import { netApi } from './net.js';
import { eventApi } from './event.js';
import { chatApi } from './chat.js';

/** @type {ReturnType<createLog>} 模块日志器（tag=REACTOR） */
const log = createLog('REACTOR');

/**
 * @typedef {object} Entry 功能运行态
 * @property {object} spec 注册时提交的功能说明书
 * @property {boolean} enabled 面板是否启用
 * @property {object} cfg 最近一次推入的模块配置
 * @property {boolean} installed spec.install 是否成功（只做一次）
 * @property {boolean} running 是否处于激活态（ctx.alive 读它）
 * @property {Set<function()>} triggers ctx.on.* 登记退订函数，暂停时统一执行
 * @property {object} ctx 注入给 spec 的唯一外部接触面（makeCtx 产出）
 */

/** @type {Map<string,Entry>} 功能条目：id -> entry */
const entries = new Map();
/** @type {Map<string,{id:string, ok:function(object):boolean}>} 门控注册表；可扩展，功能未声明的字段默认放行 */
const gates = new Map();

/**
 * 是否应当运行：已安装 && 面板启用 && 所有门控放行。
 * @param {Entry} entry 功能条目
 * @returns {boolean}
 */
function shouldRun(entry) {
  if (!entry.installed || !entry.enabled) return false;
  for (const g of gates.values()) {
    if (!g.ok(entry.spec)) return false;
  }
  return true;
}

/**
 * 功能上下文：注入给 spec.install/run 的唯一外部接触面。
 * net/event/chat 懒取（install 时机可能早于底座安装）；alive 反映 entry.running，
 * on.push/on.chat/on.event 订阅自动登记到 entry.triggers，pause 时统一摘除（feat 卸载不靠自己记 off）。
 * @param {Entry} entry 功能条目
 * @returns {object} 上下文对象
 */
function makeCtx(entry) {
  return {
    id: entry.spec.id,
    /** @returns {object|null} pocketcc.net 底座（ESM 导入，无 window 依赖） */
    get net() {
      return netApi;
    },
    /** @returns {object|null} pocketcc.chat 底座（ESM 导入，无 window 依赖） */
    get chat() {
      return chatApi;
    },
    game: game,
    bus: bus,
    /**
     * 功能当前是否激活，在飞流程的 await 回来之后用它判是否继续
     * @returns {boolean}
     */
    alive: function () {
      return entry.running;
    },
    on: {
      /**
       * 订阅一条服务端推送（net.<cmd>），退订自动登记
       * @param {number} cmd 命令号
       * @param {function(object):void} handler 处理器
       * @returns {function():void} 退订函数
       */
      push: function (cmd, handler) {
        const unsub = bus.on('net.' + cmd, handler);
        entry.triggers.add(unsub);
        return unsub;
      },
      /**
       * 订阅一条服务端**应答**（net.resp.<cmd>），退订自动登记
       * 用于消费“本端（含游戏 UI 自己）刚发出去请求的回复”——这类应答不 emit 游戏全局事件。
       * raw 池化复用，Event 只包引用：要跨拍持有需自行快照字段。
       * @param {number} cmd 命令号
       * @param {function(object):void} handler 处理器
       * @returns {function():void} 退订函数
       */
      resp: function (cmd, handler) {
        const unsub = bus.on('net.resp.' + cmd, handler);
        entry.triggers.add(unsub);
        return unsub;
      },
      /**
       * 订阅一条**本端发包**（net.req.<cmd>，载荷 {cmd,key,data,ts}），退订自动登记。
       * 用途：「请求带而应答不带」的字段只能从发包侧拿（实证：秘境 8532 DROP_INFO 请求带 {x,y}，应答不带）。
       * 必须经 pocketcc.net.onReq 走——它会按需拉起发送 hook；直接 bus.on 会订到一条永不派发的空事件。
       * @param {number} cmd 命令号
       * @param {function(object):void} handler 处理器
       * @returns {function():void} 退订函数
       */
      req: function (cmd, handler) {
        const api = netApi;
        if (!api || !api.onReq) {
          log.warn('net base unavailable, req subscribe for cmd %s is a no-op', cmd);
          return function () {};
        }
        const unsub = api.onReq(cmd, handler);
        entry.triggers.add(unsub);
        return unsub;
      },
      /**
       * 订阅一个游戏事件（EventCenter），底座不可用时空订阅并告警
       * @param {string} name 事件名
       * @param {function(...*):void} handler 处理器
       * @returns {function():void} 退订函数
       */
      event: function (name, handler) {
        const event = eventApi;
        if (!event || !event.install()) {
          log.warn('event base unavailable, skip subscribe %s', name);
          return function () {};
        }
        const unsub = event.on(name, handler);
        entry.triggers.add(unsub);
        return unsub;
      },
      /**
       * 订阅一条聊天推送（chat 底座直连聊天 socket，自带实例更替重挂），退订自动登记。
       * 语义 type 与 socket 事件的映射见 core/chat.js SOCKET_MAP；载荷即 socket 实参（非池化，跨拍需自行快照）。
       * @param {string} type 语义类型：push 频道消息 | pm 私聊 | update 消息更新 | del 消息删除 | reconnect 重连成功
       * @param {function(object):void} handler 处理器（reconnect 无载荷）
       * @returns {function():void} 退订函数
       */
      chat: function (type, handler) {
        const api = chatApi;
        if (!api || !api.on) {
          log.warn('chat base unavailable, skip subscribe %s', type);
          return function () {};
        }
        const unsub = api.on(type, handler);
        entry.triggers.add(unsub);
        return unsub;
      },
    },
  };
}

/**
 * 安装前依赖自检：逐项校验 spec.symbols 声明的游戏符号（能力语义名，解析表见 core/game-api.js CAPS）。
 * 硬依赖缺失 → 返回缺失清单，调用方判安装失败；名字末尾带 '?' 的软依赖（feat 自带降级路径）
 * 缺失只记一行 debug，不阻断。
 * @param {object} spec 功能说明书
 * @returns {string[]} 缺失的硬依赖名（含未登记的能力键）
 */
function missingSymbols(spec) {
  var syms = spec.symbols;
  if (!Array.isArray(syms) || !syms.length) return [];
  var missing = [];
  for (var i = 0; i < syms.length; i++) {
    var name = String(syms[i] || '');
    if (!name || checkCap(name)) continue;
    if (/\?$/.test(name)) log.debug('soft symbol %s unavailable (degraded): %s', name, spec.id);
    else missing.push(name);
  }
  return missing;
}

/**
 * 激活：置 running，再交给 spec.run 挂触发器。幂等。
 * @param {Entry} entry 功能条目
 */
function activate(entry) {
  if (entry.running) return;
  entry.running = true;
  log.info('activate: %s', entry.spec.id);
  try {
    if (entry.spec.run) entry.spec.run(entry.ctx);
  } catch (err) {
    log.warn('run threw: %s', entry.spec.id, err);
  }
}

/**
 * 暂停：置 running（在飞流程 await 回来判 alive 自然退出）+ 摘除所有触发器。保留队列/cfg，不卸载。
 * 末尾调 per-feat 可选 pause 钩子：让 feat 释放不该跨暂停持有的共享资源（如行军名额预约）。
 * @param {Entry} entry 功能条目
 */
function pause(entry) {
  if (!entry.running) return;
  entry.running = false;
  entry.triggers.forEach(function (unsub) {
    unsub();
  });
  entry.triggers.clear();
  // per-feat pause 钩子：触发器摘除管不到 feat 自建的定时器/在飞循环/引擎实例，给它一次自我收尾的机会。
  //   跑在 running 置否之后、且异常不阻断其余条目停用（同 activate 对 run 的兜底口径）。
  try {
    if (entry.spec.pause) entry.spec.pause(entry.ctx);
  } catch (err) {
    log.warn('pause hook threw: %s', entry.spec.id, err);
  }
  log.info('pause: %s', entry.spec.id);
}

/**
 * 重算一个条目的门控：应运行则激活，否则暂停
 * @param {Entry} entry 功能条目
 */
function recompute(entry) {
  if (shouldRun(entry)) activate(entry);
  else pause(entry);
}

/**
 * 重算全部条目（场景变化/模式切换/新门控注册时调用）
 */
function recomputeAll() {
  for (const entry of entries.values()) recompute(entry);
}

// 战斗模式切换 → 重算所有功能门控（mode 门控读最新 combat 态）
bus.on(EVT.MODE_CHANGE, recomputeAll);
// 世界态翻转（Kind/Place/Phase/gen/crossMap 任一）→ 重算所有功能门控（world 门控读 world-state 快照，含秘境 kind===pab 隔离）。
// P3 第 4 刀起 scene/pab 两条旧门控退役：场景切换会翻 place、秘境进出会翻 kind，两者都由 world.change 统一驱动 recompute。
bus.on(EVT.WORLD_CHANGE, recomputeAll);

/**
 * 注册一个功能说明书。模块加载时调用（import 副作用），早于任何 setConfig。
 * spec 是一个功能的全部声明：运行时（install/configure/run/kinds/places）+ 面板 descriptor
 * （label/storageKey/defaults/fields/toModuleCfg）。面板与存储据此渲染、持久化、推配置，
 * 故 label/storageKey/defaults 为必填——缺则拒绝注册（fail fast，开发期 F5 即见 warn）。
 * toModuleCfg 也为必填（硬契约）：core/registry.js 的 applyFeature 对**每个** reactor 功能无条件经它把面板 cfg
 *   归一成运行时 cfg。无可调参数的玩法也要写 `(c) => ({ enabled: !!(c && c.enabled) })`；缺声明不阻断注册，
 *   但除 enabled 以外的面板字段会永远停在默认值（下方加载期 warn 点名）。
 * symbols：本功能依赖的游戏 bundle 符号（能力语义名，解析表见 core/game-api.js CAPS；'?' 后缀=软依赖），
 * setConfig 首次 install 前由框架统一校验，缺则不跑 install 直接记安装失败。
 * @param {object} spec { id, label, storageKey, defaults, toModuleCfg, fields?, kinds?, places?, symbols?, install?(ctx), configure?(cfg), run?(ctx), pause?(ctx) }
 *   // 配置字段演化（由 core/registry.js 消费，均可缺省）：version?:number 当前配置版本号；
 *   // migrate?:(cfg,fromVersion)=>cfg 旧版落后时的迁移纯函数；strictConfig?:boolean 读盘剔除未声明的历史残留键。
 */
function register(spec) {
  if (!spec || typeof spec.id !== 'string') {
    log.warn('register: invalid spec');
    return;
  }
  if (entries.has(spec.id)) {
    log.warn('register: duplicate id %s', spec.id);
    return;
  }
  if (typeof spec.label !== 'string' || typeof spec.storageKey !== 'string' || !spec.defaults) {
    log.warn('register: spec missing panel descriptor (label/storageKey/defaults): %s', spec.id);
    return;
  }
  // toModuleCfg 契约：registry 每次推配置都经它把面板 cfg 归一成运行时 cfg（收口点 core/registry.js moduleCfg）。
  //   缺声明不会报错（已降级为只透传开关），但除了 enabled 以外的字段就永远停在默认值——加载期就点名，
  //   不要等用户在面板翻开关时才发现（旧写法在那里抛 TypeError 且日志无痕）。
  if (typeof spec.toModuleCfg !== 'function') {
    log.warn('register: spec missing toModuleCfg (cfg keys will stay at defaults): %s', spec.id);
  }
  const entry = {
    spec: spec,
    enabled: false,
    cfg: {},
    installed: false,
    running: false,
    triggers: new Set(),
    ctx: null,
  };
  entry.ctx = makeCtx(entry);
  entries.set(spec.id, entry);
}

/**
 * 设置功能配置（面板驱动）。enabled 翻真且未装则 install；已装则 configure；随后重算门控。
 * @param {string} id
 * @param {object} cfg { enabled:boolean, ...其余透传 spec.configure }
 */
function setConfig(id, cfg) {
  const entry = entries.get(id);
  if (!entry) {
    log.warn('setConfig: unknown id %s', id);
    return;
  }
  entry.enabled = !!(cfg && cfg.enabled);
  entry.cfg = cfg || {};
  if (entry.enabled && !entry.installed) {
    var miss = missingSymbols(entry.spec);
    if (miss.length) {
      entry.installed = false;
      log.warn('install failed: %s (game symbols unresolved) missing=%s', id, miss.join(';'));
    } else {
      try {
        entry.installed = entry.spec.install ? entry.spec.install(entry.ctx) !== false : true;
      } catch (err) {
        entry.installed = false;
        log.warn('install threw: %s', id, err);
      }
      // 安装被拒（spec.install 显式返回 false）：依赖断裂致功能停摆，属真异常走 warn。
      if (!entry.installed) log.warn('install refused: %s (spec.install returned false)', id);
    }
  }
  if (entry.installed && entry.spec.configure) {
    try {
      entry.spec.configure(entry.cfg);
    } catch (err) {
      log.warn('configure threw: %s', id, err);
    }
  }
  recompute(entry);
}

/**
 * 注册一个门控。注册后立即重算（场景门控可能在功能之后到位）。
 * @param {{id:string, ok:function(object):boolean}} gate
 */
function registerGate(gate) {
  if (!gate || typeof gate.id !== 'string' || typeof gate.ok !== 'function') {
    log.warn('registerGate: invalid gate');
    return;
  }
  gates.set(gate.id, gate);
  recomputeAll();
}

/**
 * 功能是否处于激活态
 * @param {string} id 功能 id
 * @returns {boolean}
 */
function isRunning(id) {
  const entry = entries.get(id);
  return !!(entry && entry.running);
}

/**
 * 已注册说明书列表（按注册顺序，Map 保序）。registry/ui 据此渲染面板、收集存储与默认值。
 * @returns {object[]} spec 数组
 */
function list() {
  return Array.from(entries.values(), function (e) {
    return e.spec;
  });
}

/**
 * 调度中枢对外接口面（唯一导出）
 */
export const reactor = { register, setConfig, registerGate, isRunning, list };
