// ══ extension 日志规范（开发者契约，分级判据按顺序走）══════════════════
// 统一控制台日志：[POCKETCC://<MODULE>] <message>。
//      · message 模板一律英文（UI 文案不在此列）；例外：经 %s 代入的游戏字典中文名（技能名/提示键等
//        运行时数据值）视为数据不是模板，保留不改。
//
// ── 1) warn = 真异常：「我们没能正确发出/收到/理解」或「依赖断裂致引擎/流程停摆」
//      · catch 到的抛错（threw / load failed / persist failed / save failed / write failed）
//      · 发送失败或未发出（CODE_NOT_SENT、socket/桥接发送异常）
//      · 应答畸形、不可解析、int64 精度疑虑首次遭遇
//      · 游戏符号/表行/订阅通道（ctx.on.push/resp）不可用（install failed、engine idle）
//      · 未知枚举首次遭遇
// ── 2) info = 生命周期 + 可预期业务拒绝：「服务器说当前不能做」
//      · 启动/停止/安装/关键动作完成
//      · 服务器对已成形请求返回 code≠0：限额/已满/阶段锁/目标被抢/时序竞争/活动未开
//        （必带 code，并以 `data=%s` 带上应答载荷文案——用 core/util.js 的 rejectText(ret)：
//         优先 PBV2 多语言键 ret.reason，否则 safeStringify(ret.data)；被拒态 data 常是关键错误文案，只打 code 无法定位病因）
// ── 3) debug = 调度细节 + 循环态不可动作（随资源回收自愈的跳过：no free slot、材料不足、门控不过、退避中）
//
// ── debug 故障可诊断条款 ──
//      · debug 不吞真异常：凡属第 1) 条的故障线索一律 warn，不得为降噪把抛错/写盘失败压在 debug。
//      · 每个 skip/abort/reject/return 出口必有日志（debug 起步，高频循环靠节流或 log-collect 折叠），
//        且必带决策上下文：cmd 号、code、坐标(x,y)、目标/队伍 ID、状态枚举值——
//        保证 dashcam 日志流（minLvl=debug）单轨即可还原引擎「为什么没动」。
//      · warn 消息须含可 grep 的定位前缀（协议号/模块动作名），供 dashcam-rec-analysis 直接过滤。
//
// ── 硬约束 ──
//      · 判据是 code 而非 cmd；「服务器拒绝」与「CODE_NOT_SENT」分离处理。
//      · 业务代码禁止裸 console.*；登记例外：bridge.js（MV3 service worker 无法复用 MAIN logger）、
//        core/devtools.js（交互式诊断脚本）、core/net.js L513 附近调试 dump、core/chat/log.js（chat 包内收发开关，允许中文）。
//      · 录制基础设施自身日志必须 createLog(tag,{quiet:true}) 防自录回声。
//
// fmt 若含 printf 占位（%s/%d/%i/%f/%%），本模块**自己完成替换**，不再依赖浏览器 console 的格式化：
//   真机踩坑——游戏页/上报链路拿到的日志里 "%s/%d" 原样残留、参数被追加在尾部（如 auto-farm/floatcar 的 warn），
//   因为原实现只做 `${prefix} ${fmt}` 拼接后把参数交给 console，而只有 DevTools 交互视图才替换占位。
//   自拼后消息自成一行完整文本，任何传输（DevTools / dashcam / 错误上报）所见一致。
// 占位不足以吃完参数时，多出来的参数（对象）原样透传给 console，保持可展开调试（net.js 的 req/push 载荷即此用法）。

/**
 * @typedef {object} Logger
 * @property {function(string, ...*):void} info 生命周期/关键动作 + 可预期业务拒绝（带 code/reason）
 * @property {function(string, ...*):void} debug 调度细节 + 循环态不可动作（skip/abort 出口必带决策上下文）
 * @property {function(string, ...*):void} warn 真异常（抛错/未发出/畸形/依赖断裂停摆/未知枚举首遇）
 */

// ── 外运 sink（dashcam 日志上送的唯一 tee 点）───────────────────────
// 约定见 setSink：同步、极薄（push 即返）、失败静默；关开关 = setSink(null) 摘钩，
// hot path 回落到一次判空。未占位消费的尾参（rest）原样引用交出，
// 由消费侧（log-collect）**当帧串化并截断**——rest 可能是本拍共享的池化对象，延迟序列化会采到改写后的脏数据。
/** @type {(function({ts:number,lvl:string,mod:string,msg:string,rest:Array}):void)|null} */
let sink = null;

/**
 * 安装/摘除日志外运钩子（供 core/log-collect.js 使用，业务代码不要碰）。
 * sink 收到 {ts, lvl, mod, msg, rest}，同步调用：只允许 push 进内存缓冲，
 * 绝不做网络/磁盘 IO；sink 抛错一律吞掉，不影响 console 输出。
 * @param {function(object):void|null} fn 钩子；传 null/非函数即摘除
 */
export function setSink(fn) {
  sink = typeof fn === 'function' ? fn : null;
}

/** %s 的取值串化：字符串原样、对象 JSON、其余 String()；失败降级 String，绝不抛 */
function stringify(v) {
  if (v == null) return String(v);
  if (typeof v === 'string') return v;
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v);
    } catch (e) {
      return String(v);
    }
  }
  return String(v);
}

/**
 * 把 printf 占位就地替换进 fmt；参数不足则保留未替换的占位；返回未被消费的尾参。
 * @param {string} fmt 含 %s/%d/%i/%f/%% 的模板（无占位则原样）
 * @param {Array} args 位置参数
 * @returns {{msg:string, rest:Array}} 替换后的整行文本 + 仍要交给 console 的尾参
 */
function printf(fmt, args) {
  if (typeof fmt !== 'string') return { msg: stringify(fmt), rest: args };
  if (!args.length || fmt.indexOf('%') === -1) return { msg: fmt, rest: args };
  var i = 0;
  var msg = fmt.replace(/%([sdif%])/g, function (tok, t) {
    if (t === '%') return '%'; // %% → 字面 %，不-consuming 参数
    if (i >= args.length) return tok; // 参数不够：占位原样留着
    var a = args[i++];
    if (t === 's') return stringify(a);
    var n = t === 'f' ? parseFloat(a) : parseInt(a, 10);
    return Number.isNaN(n) ? 'NaN' : String(n);
  });
  return { msg: msg, rest: args.slice(i) };
}

/**
 * 创建一个带模块标记的日志器
 * @param {string} module 模块标记（如 NET / BUS），输出为 [POCKETCC://<module>]
 * @param {{quiet?:boolean}} [opts] quiet=true：只进 console 不进 sink——录制基础设施自身的日志
 *   必须豁免（flush 时记的 debug 若再进缓冲，会形成自录回声）
 * @returns {Logger} 三级日志器
 */
export function createLog(module, opts) {
  const prefix = `[POCKETCC://${module}]`;
  const quiet = !!(opts && opts.quiet);
  function emit(lvl, sinkFn, fmt, args) {
    const line = printf(fmt, args);
    if (line.rest.length) sinkFn.call(console, `${prefix} ${line.msg}`, ...line.rest);
    else sinkFn.call(console, `${prefix} ${line.msg}`);
    if (sink && !quiet) {
      try {
        sink({ ts: Date.now(), lvl, mod: module, msg: line.msg, rest: line.rest });
      } catch (e) {
        /* 外运失败不打扰 console（此处再 log 会递归，静默即可） */
      }
    }
  }
  return {
    info: (fmt, ...args) => emit('info', console.info, fmt, args),
    debug: (fmt, ...args) => emit('debug', console.debug, fmt, args),
    warn: (fmt, ...args) => emit('warn', console.warn, fmt, args),
  };
}
