// 统一控制台日志：[POCKETCC://<MODULE>] <message>，message 一律英文（UI 文案不在此列）。
// 三级 info/debug/warn 语义：
//   info  = 生命周期、关键动作，以及**可预期的业务拒绝**（服务器对已成形请求返回的 code≠0：限额/已满/阶段锁/目标被抢/时序竞争等正常游戏态）。
//   debug = 逐条调度细节。
//   warn  = **真异常**：抛错、发送失败/未发出（CODE_NOT_SENT）、应答畸形/不可解析、依赖或配置缺失、未知枚举首次遭遇。
//   ——即：「服务器说当前不能做」不是错误，走 info；只有「我们没能正确发出/收到/理解」才走 warn。
//
// fmt 若含 printf 占位（%s/%d/%i/%f/%%），本模块**自己完成替换**，不再依赖浏览器 console 的格式化：
//   真机踩坑——游戏页/上报链路拿到的日志里 "%s/%d" 原样残留、参数被追加在尾部（如 auto-farm/floatcar 的 warn），
//   因为原实现只做 `${prefix} ${fmt}` 拼接后把参数交给 console，而只有 DevTools 交互视图才替换占位。
//   自拼后消息自成一行完整文本，任何传输（DevTools / dashcam / 错误上报）所见一致。
// 占位不足以吃完参数时，多出来的参数（对象）原样透传给 console，保持可展开调试（net.js 的 req/push 载荷即此用法）。

/**
 * @typedef {object} Logger
 * @property {function(string, ...*):void} info 生命周期/关键动作 + 可预期业务拒绝
 * @property {function(string, ...*):void} debug 逐条调度细节
 * @property {function(string, ...*):void} warn 真异常（抛错/未发出/畸形/依赖缺失/未知枚举首遇）
 */

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
 * @returns {Logger} 三级日志器
 */
export function createLog(module) {
  const prefix = `[POCKETCC://${module}]`;
  function emit(sink, fmt, args) {
    const line = printf(fmt, args);
    if (line.rest.length) sink.call(console, `${prefix} ${line.msg}`, ...line.rest);
    else sink.call(console, `${prefix} ${line.msg}`);
  }
  return {
    info: (fmt, ...args) => emit(console.info, fmt, args),
    debug: (fmt, ...args) => emit(console.debug, fmt, args),
    warn: (fmt, ...args) => emit(console.warn, fmt, args),
  };
}
