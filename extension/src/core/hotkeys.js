/**
 * 键盘公共设施：输入焦点守卫 + 全局「裸键」热键注册表。
 *
 * 为什么收口成一张注册表（而非各 feat 各自 window.addEventListener、各写一遍闸门）：
 * - 快捷键不是某个 feat 的私有物，而是全局输入层：所有绑键共用同一套闸门（打字让位、Ctrl/Alt/Meta 放行、
 *   场景白名单、命中即 preventDefault+stopPropagation），改一处约定即全量生效；
 * - 全局仅一个 window 捕获监听（捕获阶段优先于游戏画布 keydown 冒泡阶段的 stopPropagation，不受焦点位置影响——
 *   沿用 F8 修复经验），按注册顺序分派，避免多个监听各跑一遍；
 * - 注册时按 key + 场景做冲突检测，防未来手抖撞键；
 * - list() 把当前全部绑定暴露给面板「快捷键一览」。
 *
 * 消费约定：handler 返回 false = 本次不消费（不拦截默认、不阻断冒泡，按键透传给游戏与后续绑定，
 * 如战斗面板快捷键「面板不在场」时让位于快捷战斗的 1-8）；其余（含无返回）= 已消费，注册表统一
 * preventDefault + stopPropagation 并停止遍历。场景门控走双层口径：scenes（scene-watcher 的 cc 场景名，
 * 旧口径，保留为兼容必要条件）× kinds/places（新口径：经 core/world/contracts.js 纯词表判定，实时态由 bus
 * world.change 镜像供给），与 reactor 的 scene/world
 * 两道门同一套判据（离开白名单场景即不触发，等价旧 feat 的 ctx.alive() 早退）。
 */
import { createLog } from './log.js';
import { bus, EVT } from './bus.js';
import { getCurrentScene } from './scene-watcher.js';
import { KIND, PLACE, kindInList, placeInList } from './world/contracts.js';

/** @type {ReturnType<createLog>} 模块日志器（tag=HOTKEY） */
const log = createLog('HOTKEY');

/**
 * 世界态本地镜像：阶段四 Tier0 隔离后，热键层不再 import 领域归一层 core/world/state.js，
 * 而是订阅 bus 的 world.change（仅四维翻转时广播）缓存最新快照，门控同步读这份镜像。
 * 镜像只持有已广播的快照对象（world-state 每次 collect 产新对象，无别名篡改风险）；门控仅读
 * kind/place，而 world.change 恰在 kind/place 翻转时必发，故镜像就绪后的 kind/place 恒与实时快照一致。
 * 注意首帧差异：镜像未就绪（null）时 fail-open，而旧实现 worldState.current() 首帧会同步现采出
 * homeland/boot 进真判定——方向不同。现网掩蔽：boot 期 getCurrentScene() 为 null，带 kinds/places
 * 的绑定均同声明 scenes 先一步拦截；若新增只声明 kinds/places 不声明 scenes 的绑定，启动早期窗口
 * 会无条件放行（bind() 已就此 warn）。
 * @type {object|null}
 */
let worldMirror = null;
bus.on(EVT.WORLD_CHANGE, function (snap) {
  worldMirror = snap;
});

// ─────────────────────── 输入焦点守卫 ───────────────────────

/**
 * 非文本类 <input> 的 type 集合：这些控件聚焦时不算「正在打字」（如按钮聚焦下按数字仍应触发热键）。
 * 反向判定比白名单稳（文本类 type 繁多：text/search/url/tel/email/password/number/date…）。
 * @type {Set<string>}
 */
const NON_TEXT_INPUT = new Set([
  'button',
  'submit',
  'reset',
  'checkbox',
  'radio',
  'image',
  'range',
  'color',
  'file',
]);

/**
 * 判定「此刻焦点是否在可文字输入元素里」，供绑键功能决定是否让位于打字。
 * 辅助浮层（控制面板、聊天窗）都挂在 Shadow DOM 内，挂在 window/document 的 keydown 拿到的 e.target
 * 会被事件重定向成 shadow host，看不到里层真正聚焦的 <textarea>/<input>；key 事件 composed:true，
 * e.composedPath()[0] 能穿透 shadow 边界拿到真实目标元素，故以此为准。
 * @param {KeyboardEvent} e 键盘事件
 * @returns {boolean} true=正在文本输入，绑键功能应跳过本次按键（热键让位给打字）
 */
export function isTypingTarget(e) {
  // 穿透 Shadow DOM：composedPath()[0] 是事件路径最内层真实目标；老环境无 API 时退化 e.target
  var t =
    (e && typeof e.composedPath === 'function' ? e.composedPath()[0] : null) || (e && e.target);
  if (!t || !t.tagName) return false;
  if (t.tagName === 'TEXTAREA') return true;
  if (t.isContentEditable) return true;
  if (t.tagName === 'INPUT') return !NON_TEXT_INPUT.has((t.type || 'text').toLowerCase());
  return false;
}

// ─────────────────────── 热键注册表 ───────────────────────

/**
 * @typedef {object} HotkeyBinding 一条热键绑定
 * @property {string} id 唯一 id（重复注册拒绝）
 * @property {function(KeyboardEvent):boolean} handler 命中且场景放行时调用；返回 false=不消费(透传)，其余=已消费
 * @property {string[]} [keys] 匹配的 event.code 列表（如 ['KeyB']、['Tab']、['Digit1'..]）；缺 match 时按其默认匹配
 * @property {function(KeyboardEvent):boolean} [match] 自定义匹配（如战斗面板 1-8/G 需正则判定），缺省用 keys
 * @property {string[]} [scenes] 场景白名单（对齐 scene-watcher 场景名）；缺省=所有场景放行
 * @property {string[]} [kinds] 世界态档/组白名单（worldState KIND 值或 'kvk'/'sphere'/'cross' 组名），
 *   与 scenes 取交集；缺省=不看档。用于「某些场景档里这个键根本没意义」（如秘境副本图内的飞回基地）
 * @property {string[]} [places] 地图白名单（worldState PLACE 值）；缺省=不看图。与 Kind 无关的 UI/输入类
 *   功能只声明本项即可（C 档口径）
 * @property {string} [label] 面板「快捷键一览」显示的功能名
 * @property {string} [display] 面板显示键名（缺省用 keys 拼接）
 * @property {string} [where] 面板显示的生效场景（人话，如「基地/大世界」）
 */

/** @type {Map<string,HotkeyBinding>} 绑定表：id -> binding（Map 保序，即分派优先级 = 注册顺序） */
const bindings = new Map();
/**
 * 展示型键位登记表：id -> {id,display,label,where}。
 * 用于「行为不在本注册表分派、由各 feat 自带监听处理」的快捷键（如 F8 模式切换、Ctrl+K/M 浮层开关——
 * 它们带修饰键或依赖 feat 生命周期，不宜纳入统一 dispatch），仅登记进「快捷键一览」供面板展示。
 * @type {Map<string,{id:string,display:string,label:string,where:string}>}
 */
const docs = new Map();
/** @type {boolean} 全局 window 捕获监听是否已挂（首次 bind 时挂一次） */
let listening = false;

/**
 * 默认匹配：主判 event.code（与大小写/Shift 无关，最稳），并对 Key<字母> 兼容 event.key 单字符兜底。
 * 绑定了自定义 match 的交给 match。
 * @param {HotkeyBinding} binding 绑定
 * @param {KeyboardEvent} e 键盘事件
 * @returns {boolean}
 */
function matchKey(binding, e) {
  if (binding.match) return binding.match(e);
  var keys = binding.keys || [];
  for (var i = 0; i < keys.length; i++) {
    var t = keys[i];
    if (e.code === t) return true;
    if (
      /^Key[A-Z]$/.test(t) &&
      typeof e.key === 'string' &&
      e.key.length === 1 &&
      e.key.toLowerCase() === t.charAt(3).toLowerCase()
    )
      return true;
  }
  return false;
}

/**
 * 场景门控：scenes 与 kinds/places 都是必要条件（未声明的那项放行）。与 reactor 的 scene/world 双门同判据
 * （谓词走 core/world/contracts.js 纯词表层），差别在兜底方向：本层是**按键级**判定，世界态拿不到
 * （镜像未就绪 / kind=unknown / place=off）时对新口径直接放行、退回旧 scenes 口径——热键没有
 * pause/resume 补偿，误判一刀就是功能凭空消失且不会自愈；reactor 侧同样判据可以放心拦（回到白名单档会自动 resume）。
 * 隐含不变量：声明 kinds/places 的绑定应同时声明 scenes（镜像就绪前的 null 窗口靠 scenes 门掩蔽，
 * 见 worldMirror 注释）；违反时启动早期对本门控无条件放行，bind() 会 warn。
 * @param {HotkeyBinding} binding 绑定
 * @returns {boolean}
 */
function bindingAllow(binding) {
  var sc = binding.scenes;
  if (sc && sc.length && sc.indexOf(getCurrentScene()) === -1) return false;
  if (!binding.kinds && !binding.places) return true;
  var st = worldMirror;
  if (!st) return true; // 镜像未就绪：fail-open（与旧首帧现采不同向，靠 scenes 门掩蔽，见 worldMirror 注释与 bind 校验）
  if (st.kind === KIND.unknown || st.place === PLACE.off) return true;
  return kindInList(binding.kinds, st.kind) && placeInList(binding.places, st.place);
}

/**
 * 全局 keydown 分派：打字/修饰键闸门 → 按注册顺序找首个「匹配且场景放行且消费」的绑定，
 * 命中即 preventDefault + stopPropagation 并停止；handler 返回 false 视为未消费，继续看后续绑定。
 * @param {KeyboardEvent} e 键盘事件
 */
function dispatch(e) {
  if (isTypingTarget(e)) return;
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  var iter = bindings.values();
  for (var step = iter.next(); !step.done; step = iter.next()) {
    var b = step.value;
    if (!matchKey(b, e) || !bindingAllow(b)) continue;
    var consumed;
    try {
      consumed = b.handler(e);
    } catch (err) {
      log.warn('handler %s threw: %s', b.id, err && err.message);
      continue;
    }
    if (consumed === false) continue; // 不消费：透传，继续看后续绑定
    e.preventDefault();
    e.stopPropagation();
    return;
  }
}

/**
 * key 维度是否可能与既有绑定撞键（自定义 match 无法可靠比对，跳过）。
 * @param {HotkeyBinding} a @param {HotkeyBinding} b
 * @returns {boolean}
 */
function keyOverlap(a, b) {
  if (a.match || b.match) return false;
  var ka = a.keys || [];
  var kb = b.keys || [];
  return ka.some(function (k) {
    return kb.indexOf(k) !== -1;
  });
}
/**
 * 场景维度是否与既有绑定重叠（任一未声明场景=全域，视为重叠）。
 * @param {HotkeyBinding} a @param {HotkeyBinding} b
 * @returns {boolean}
 */
function sceneOverlap(a, b) {
  var sa = a.scenes;
  var sb = b.scenes;
  if (!sa || !sa.length) return true;
  if (!sb || !sb.length) return true;
  return sa.some(function (s) {
    return sb.indexOf(s) !== -1;
  });
}

/**
 * 注册一条热键绑定（各 feats/system/hotkey/* 模块 import 时调用，早于任何按键）。幂等：同 id 拒绝重复。
 * 首次注册时挂全局 window 捕获监听。key+场景撞键会 warn（不阻断，方便开发期发现）。
 * @param {HotkeyBinding} binding 绑定声明
 */
export function bind(binding) {
  if (!binding || typeof binding.id !== 'string' || typeof binding.handler !== 'function') {
    log.warn('bind: invalid binding');
    return;
  }
  if (bindings.has(binding.id)) {
    log.warn('bind: duplicate id %s', binding.id);
    return;
  }
  if ((binding.kinds || binding.places) && !(binding.scenes && binding.scenes.length)) {
    log.warn(
      'bind: %s 声明了 kinds/places 但未声明 scenes，世界态镜像就绪前将无条件放行',
      binding.id,
    );
  }
  var iter = bindings.values();
  for (var step = iter.next(); !step.done; step = iter.next()) {
    var ex = step.value;
    if (keyOverlap(ex, binding) && sceneOverlap(ex, binding))
      log.warn('bind: key conflict between %s and %s', binding.id, ex.id);
  }
  bindings.set(binding.id, binding);
  if (!listening) {
    window.addEventListener('keydown', dispatch, true);
    listening = true;
  }
}

/**
 * 注销一条热键绑定（预留：目前热键常驻，不摘全局监听，只删该条）。
 * @param {string} id 绑定 id
 */
export function unbind(id) {
  bindings.delete(id);
}

/**
 * @typedef {object} HotkeyDoc 展示型键位（不参与 dispatch，仅进「快捷键一览」）
 * @property {string} id 唯一 id（与 bind 的 id 共用命名空间，避免重复展示）
 * @property {string} display 显示键名（如「F8」「Ctrl+K」）
 * @property {string} label 功能名
 * @property {string} [where] 生效范围人话描述（如「全域」）
 */

/**
 * 登记一条「展示型」键位：其按键行为由其它子系统自行监听（app 级 F8、带修饰键的浮层开关等），
 * 本注册表不分派、不拦截，仅把它并入 list() 让面板「快捷键一览」完整可见。幂等：同 id 覆盖。
 * @param {HotkeyDoc} entry 键位说明
 */
export function doc(entry) {
  if (!entry || typeof entry.id !== 'string') {
    log.warn('doc: invalid entry');
    return;
  }
  if (bindings.has(entry.id)) {
    log.warn('doc: id %s already a bound hotkey, skip', entry.id);
    return;
  }
  docs.set(entry.id, {
    id: entry.id,
    display: entry.display || entry.id,
    label: entry.label || entry.id,
    where: entry.where || '',
  });
}

/**
 * 当前全部键位（展示型在前 + 注册表分派型在后），供面板「快捷键一览」渲染。
 * group：'global'=展示型（全域/浮层开关），'game'=注册表统一分派的游戏内裸键；面板据此分组。
 * @returns {Array<{id:string, display:string, label:string, where:string, group:string}>}
 */
export function list() {
  var out = [];
  // 展示型键位置前（全域/浮层类总开关），其后接注册表统一分派的游戏裸键
  docs.forEach(function (d) {
    out.push(Object.assign({ group: 'global' }, d));
  });
  bindings.forEach(function (b) {
    out.push({
      id: b.id,
      display: b.display || (b.keys || []).join('/'),
      label: b.label || b.id,
      where: b.where || '',
      group: 'game',
    });
  });
  return out;
}
