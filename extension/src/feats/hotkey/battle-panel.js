/**
 * 战斗面板快捷键（热键注册表形态）
 *
 * 出征编队面板（BattlePanel，动态加载的 ea_prefab/battle/BattlePanelNew，挂在 NBattleMain.ui 下）在场时，
 * 用键盘快捷键点击面板上的原生按钮（等价用户点击，不改写游戏数据）：
 *   [1]-[8]  点击 presetList 的第 1~8 个预设队伍按钮；
 *   [G]      点击 BattlePanel.button 出征按钮。
 * 面板节点路径（相对场景根）：
 *   NWorldMap/UICanvas/PopLayer/NBattleMain/ui/BattlePanel[/Bottom/New Layout/presetList/<i>] [/button]
 *
 * 「仅面板在场才生效」用面板节点 activeInHierarchy 实时判定（面板是动态 prefab，hook 其组件类不稳）：
 * 面板不在场 / 目标节点缺失时 handler 返回 false（不消费），按键透传给游戏与「快捷战斗」(quick-attack，
 * 目标弹窗上用 1-8 直发 902)——注册表 window 捕获先于 quick-attack 的 document 捕获，命中面板消费即拦截。
 *
 * 打字让位 / 修饰键放行 / 场景门控（scenes:['NWorldMap']，对齐旧 ctx.alive() 早退）/ preventDefault 由
 * core/hotkeys.js 注册表统一处理；本文件只声明「绑定（含自定义 match 解 1-8/G）+ 动作」。
 * 属「战斗辅助」，战斗模式下照常生效（热键层不受 mode 门控）。
 */
import { createLog } from '../../core/log.js';
import { bind } from '../../core/hotkeys.js';

/** @type {ReturnType<createLog>} 模块日志器（tag=BATTLE_HOTKEY） */
const log = createLog('BATTLE_HOTKEY');

/** @type {string[]} 场景根到 BattlePanel 的段名链 */
const PANEL_PATH = ['NWorldMap', 'UICanvas', 'PopLayer', 'NBattleMain', 'ui', 'BattlePanel'];
/** @type {string[]} BattlePanel 下预设列表容器的段名链（末级子节点按索引取） */
const PRESET_LIST_PATH = ['Bottom', 'New Layout', 'presetList'];
/** @type {string[]} BattlePanel 下出征按钮节点名 */
const DISPATCH_PATH = ['button'];

/**
 * 按段名链从根节点向下解析子节点：具名段用 getChildByName，纯数字段用 children[+n] 索引取。
 * 任一段缺失即返回 null（不抛错）。
 * @param {object} root 起始节点（cc.Node）
 * @param {Array<string|number>} segments 段名链
 * @returns {object|null} 目标节点或 null
 */
function resolveNode(root, segments) {
    var node = root;
    for (var i = 0; i < segments.length; i++) {
        if (!node) return null;
        var seg = String(segments[i]);
        if (/^\d+$/.test(seg)) {
            var kids = node.children;
            node = (kids && kids[+seg]) || null;
        } else {
            node = (node.getChildByName && node.getChildByName(seg)) || null;
        }
    }
    return node || null;
}

/**
 * 取在场且激活的 BattlePanel 节点；面板未加载/未激活返回 null。
 * 场景根（cc.director.getScene()）本身的 name 即 "NWorldMap"（scene-watcher 门控同源），
 * 故用户路径的 "cc.Scene.NWorldMap" 里 cc.Scene 是引擎根对象、NWorldMap 是场景节点：
 * 若首段等于场景名则从场景子级续解（去掉首段），否则整条按子节点解析（兜底场景内确有同名子节点）。
 * @returns {object|null}
 */
function activePanel() {
    var scene = cc.director.getScene();
    if (!scene) return null;
    var segs = (scene.name === PANEL_PATH[0]) ? PANEL_PATH.slice(1) : PANEL_PATH;
    var panel = resolveNode(scene, segs);
    if (!panel) panel = resolveNode(scene, PANEL_PATH);
    if (!panel || panel.activeInHierarchy === false) return null;
    return panel;
}

/**
 * 精确定位一个 cc.Button：先看节点自身，再看名为 "normal" 的子节点（预设 cell 本身无 Button，
 * 「使用该预设」的 Button 挂在 cell.normal 上）。绝不无脑递归整棵子树——presetList 里每个 cell 还带着
 * BtnSave/BtnReplace/BtnSetting 等编辑按钮（均 cc.Button），DFS 取首个会误点到它们（弹保存/替换/设置框）。
 * @param {object} node 起始节点
 * @returns {object|null} cc.Button 组件或 null
 */
function findButton(node) {
    if (!node || !node.getComponent || !cc.Button) return null;
    var btn = node.getComponent(cc.Button);
    if (btn) return btn;
    var normal = node.getChildByName && node.getChildByName('normal');
    if (normal) {
        btn = normal.getComponent(cc.Button);
        if (btn) return btn;
    }
    return null;
}

/**
 * 触发一个 cc 按钮节点（等价点击）：找到 Button 后逐条派发编辑器绑定的 clickEvents（以数组 params
 * 走引擎 emit，见 fireClickEvent），再 node.emit('click', btn) 覆盖 addClickEventListener 注册的回调
 * （引擎 Button 点击时也正是这么发）。只要找到 Button 就视为已触发（返回 true）。
 * @param {object} node 按钮所在节点（或其容器）
 * @returns {boolean} 是否找到并触发了 Button 组件
 */
function clickNode(node) {
    var btn = findButton(node);
    if (!btn) return false;
    var bnode = btn.node || node;
    var evs = btn.clickEvents;
    if (evs && evs.length) {
        for (var i = 0; i < evs.length; i++) fireClickEvent(evs[i], bnode, i);
    }
    try { bnode.emit('click', btn); } catch (e) { log.debug('emit click failed', e); }
    return true;
}

/**
 * 派发一条 cc.Component.EventHandler。
 * 引擎 emit(params) 内部执行 handler.apply(target组件, params)——params 必须是【数组】（每个元素对应 handler
 * 的一个形参）；传对象会被当成空参数，handler 收到 e=undefined（此前报错 "reading 'target' of undefined" 的根因）。
 * 真实点击时 Button 传入的 params[0] 是 click/touch 事件，其 target = Button 所在节点（预设 cell 的 normal 子节点），
 * 故 handler 里 parseInt(e.target.parent.name) 才能取到 cell 序号（normal 的父节点即名为 "0".."7" 的预设 cell）。
 * 因此合成事件必须以 senderNode（Button 所在节点）作 target，绝不能用 ce.target（那是绑定的控制器节点）。
 * @param {object} ce clickEvent（cc.Component.EventHandler）
 * @param {object} senderNode Button 所在节点（作合成事件的 target）
 * @param {number} i 序号（日志）
 * @returns {boolean} 是否成功触发绑定 handler
 */
function fireClickEvent(ce, senderNode, i) {
    var evt = { type: 'click', target: senderNode, getCurrentTarget: function () { return senderNode; } };
    // 首选：以数组走引擎 emit（与真实点击同一条内部路径，组件解析交给引擎，最稳）
    try {
        ce.emit([evt, ce.customEventData]);
        return true;
    } catch (e) { log.debug('clickEvents[%d] array emit failed', i, e); }
    // 兜底：emit 异常时按绑定字段直调 handler（同样以 senderNode 作事件 target）
    try {
        var tnode = ce.target, cname = ce.component, hname = ce.handler;
        if (tnode && cname && hname) {
            var comp = (typeof cname === 'string') ? tnode.getComponent(cname) : cname;
            if (comp && typeof comp[hname] === 'function') {
                comp[hname].call(comp, evt, ce.customEventData);
                return true;
            }
        }
    } catch (e) { log.debug('clickEvents[%d] direct call failed', i, e); }
    return false;
}

/**
 * 解析按键 → { digit:1..8|null, dispatch:boolean }。以 event.code 为主（与 Shift/大小写无关，最稳），
 * event.key 兜底。数字键与快捷战斗同号，但只有本功能命中在场面板时才会处理（见 handler 的面板闸门）。
 * @param {KeyboardEvent} e
 * @returns {{digit:number|null, dispatch:boolean}}
 */
function readHotkey(e) {
    var digit = null;
    var dispatch = false;
    var m = typeof e.code === 'string' && /^Digit([1-8])$/.exec(e.code);
    if (m) digit = parseInt(m[1], 10);
    else if (e.key >= '1' && e.key <= '8') digit = e.key.charCodeAt(0) - 48;
    if (e.code === 'KeyG' || e.key === 'g' || e.key === 'G') dispatch = true;
    return { digit: digit, dispatch: dispatch };
}

/**
 * 自定义匹配：本功能认领 1-8 数字键与 G 键（正则判定，含 code/key 兜底）。
 * @param {KeyboardEvent} e
 * @returns {boolean}
 */
function match(e) {
    if (typeof e.code === 'string' && /^Digit[1-8]$/.test(e.code)) return true;
    if (typeof e.key === 'string' && e.key >= '1' && e.key <= '8') return true;
    return e.code === 'KeyG' || e.key === 'g' || e.key === 'G';
}

/**
 * 分派：解热键 → 面板在场闸门 → 定位目标节点 → 点击。
 * 面板不在场 / 目标节点缺失返回 false（不消费，透传给游戏与快捷战斗）；命中并触发返回 true。
 * @param {KeyboardEvent} e 键盘事件
 * @returns {boolean} 是否消费本次按键
 */
function handler(e) {
    var hk = readHotkey(e);
    if (hk.digit == null && !hk.dispatch) return false;

    var panel = activePanel();
    if (!panel) return false;  // 面板不在场：不消费事件，透传给游戏与快捷战斗

    var target = hk.dispatch
        ? resolveNode(panel, DISPATCH_PATH)
        : (function () {
            var list = resolveNode(panel, PRESET_LIST_PATH);
            return list ? resolveNode(list, [hk.digit - 1]) : null;
        })();
    if (!target) {
        log.debug('hotkey hit but node missing. digit=%s;dispatch=%s', hk.digit, hk.dispatch);
        return false;
    }

    if (!clickNode(target)) log.warn('target has no cc.Button (self or .normal). digit=%s;dispatch=%s', hk.digit, hk.dispatch);
    else log.debug('battle panel hotkey fired. digit=%s;dispatch=%s', hk.digit, hk.dispatch);
    return true;
}

bind({
    id: 'battlePanelHotkeys',
    // keys 仅作展示/说明用途；实际匹配走下面的自定义 match（1-8 数字键 + G）
    keys: ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'KeyG'],
    match: match,
    display: '1-8/G',
    label: '战斗面板 预设/出征',
    where: '大世界',
    scenes: ['NWorldMap'],
    handler: handler,
});
