/**
 * 游戏符号防腐层（ACL）：全项目唯一允许集中「游戏 bundle 内部符号名」知识的场所——
 * 模块注册名、类/单例属性链、枚举成员名、配置表名全部收在 SYM 表。游戏改版符号漂移时
 * 只改这一个文件；上层业务（feats/*、core/ui.js）只依赖能力 API，不感知符号名。
 *
 * 耦合分层立场（解耦重构的依据）：
 *   - 线路格式知识（llm 字段、ChatShareLinkType、消息模板规则）→ feats/chat/classify.js
 *     纯函数层。属服务器↔客户端契约，变化极少，带源码锚点，不算病态耦合；
 *   - 运行时符号知识（本文件）→ 游戏 bundle 实现细节，随版本漂移。收敛于此，
 *     惰性探测 + 缓存 + 失败一次性 warn，使漂移可观测、修复单点化。
 *
 * 合规：全部能力为只读查询或调用游戏原生导航/UI 动作，不改写游戏数据（只读+发包红线）。
 */
import { game } from './game.js';
import { createLog } from './log.js';

/** @type {ReturnType<createLog>} 模块日志器（tag=GAMEAPI） */
const log = createLog('GAMEAPI');

/**
 * 符号表：所有游戏内部名字集中于此，一眼可全审。
 * @type {object}
 */
const SYM = {
  modules: {
    localManager: 'LocalManager',
    tableManager: 'TableManager',
    dataCenter: 'DataCenter',
    tableUtils: 'TableUtils',
    long64Bit: 'Long64Bit',
    chatCommon: 'chatCommon',
    platformCore: 'PlatformCore',
    mapNewBiz: 'NWorldMapCoreBiz',
    mapNewCtrl: 'NWorldMapTodoController',
    mapOldCommon: 'WorldMapCommon',
    mapOldCtrl: 'WorldMapTodoController',
  },
  /** 新图单例属性链：module[cls][inst]，枚举对象 module[goType] */
  newMap: { cls: 'NWorldMapTodoController', inst: 'instance', goType: 'NWorldMapGoType' },
  /** 旧图枚举对象属性名 */
  oldMap: { todoType: 'WorldMapToDoType' },
  /** 导航动作枚举名（按名字取值，不依赖静态数值——NWorldMapGoType 数值未落盘） */
  mapActions: { moveTo: 'MOVE_TO', tileClick: 'JUMP_TO_TILE_CLICK', marchClick: 'JUMP_TO_MARCH_CLICK' },
  /** 语义表名 → 游戏 TableName 字符串值（TableName.js 实证） */
  tables: { emotion: 'emotion', emotionNew: 'emotion_new', emojiGif: 'emoji_gif', item: 'item', building: 'building' },
};

/** @type {Map<string, *>} 惰性探测缓存（页面生命周期与游戏版本一致，缓存后无需重探） */
const probes = new Map();

/**
 * 惰性探测：首次解析并缓存，失败记一条 warn（符号漂移警报），之后零反射开销。
 * @param {string} key 缓存键（符号语义名）
 * @param {Function} resolve 解析函数，返回目标对象或 null/抛错
 * @returns {*|null}
 */
function probe(key, resolve) {
  if (probes.has(key)) return probes.get(key);
  var v = null;
  try { v = resolve() || null; } catch (e) { }
  if (!v) log.warn('probe "%s" failed —— 符号漂移（游戏更新）或功能未开，相关能力将降级', key);
  probes.set(key, v);
  return v;
}

/** LOCAL 翻译单例（LocalManager 导出 .LOCAL） */
function LOCAL() { return probe('LocalManager.LOCAL', () => { var m = game.get(SYM.modules.localManager); return (m && m.LOCAL) || null; }); }

/** TABLE 配置表单例（TableManager 导出 .TABLE） */
function TABLE() { return probe('TableManager.TABLE', () => { var m = game.get(SYM.modules.tableManager); return (m && m.TABLE) || null; }); }

/** UserData 对象引用缓存（Friends/Alliance/StrUid 为其上属性，读值仍实时） */
function userData() { return probe('DataCenter.UserData', () => { var m = game.get(SYM.modules.dataCenter); return (m && m.DATA && m.DATA.UserData) || null; }); }

// ─────────────────────── 本地化 / 配置表 ───────────────────────

export const l10n = {
  /** 翻译能力是否可用 */
  ok() { return !!LOCAL(); },
  /**
   * 语言键+参数 → 游戏当前语言文本（与游戏 getText(key,...paras) 同源；查不到回键原文）。
   * @param {string} key 语言键
   * @param {...*} paras 模板参数
   * @returns {string}
   */
  text(key) {
    var args = Array.prototype.slice.call(arguments, 1);
    var L = LOCAL();
    if (!L || typeof L.getText !== 'function') return String(key);
    try { return String(L.getText.apply(L, [String(key)].concat(args)) || '') || String(key); } catch (e) { return String(key); }
  },
  /**
   * 服务器应答 '<键,参数1|参数2>' 裸串 → 译文（getNetMsgText 同源；查不到回原文）。
   * @param {*} s 应答 data 原文
   * @returns {string}
   */
  net(s) {
    s = String(s == null ? '' : s).trim();
    if (!s) return s;
    var L = LOCAL();
    if (!L || typeof L.getNetMsgText !== 'function') return s;
    try { return String(L.getNetMsgText(s) || '') || s; } catch (e) { return s; }
  },
  /**
   * 配置表行查询（只读）。
   * @param {string} semantic 语义表名（emotion/emotionNew/emojiGif/item/building，也可直接传游戏表串）
   * @param {*} id 行 id
   * @returns {object|null}
   */
  tableRow(semantic, id) {
    var T = TABLE();
    if (!T) return null;
    try { return T.getTableDataById(SYM.tables[semantic] || semantic, String(id)) || null; } catch (e) { return null; }
  },
  /**
   * 频道号 → 游戏频道显示名（chatCommon.getChatToggleConfig 文案键 + 翻译，与游戏侧栏同源）。
   * @param {number} c 频道号
   * @returns {string|null} 取不到返回 null（调用方自定衍名兜底）
   */
  channelName(c) {
    var cm = probe(SYM.modules.chatCommon + '.getChatToggleConfig', () => {
      var m = game.get(SYM.modules.chatCommon);
      return (m && typeof m.getChatToggleConfig === 'function') ? m : null;
    });
    if (!cm) return null;
    try { return l10n.net(cm.getChatToggleConfig(+c)) || null; } catch (e) { return null; }
  },
};

// ─────────────────────── 世界地图导航 ───────────────────────

/** 跳转协调器（新旧地图双通道，首次探测后缓存句柄） */
function mapTodo() {
  return probe('mapTodo', () => {
    try { // 新图：NWorldMapCoreBiz.NWorldMapGoType + NWorldMapTodoController.instance
      var biz = game.get(SYM.modules.mapNewBiz);
      var G = biz && biz[SYM.newMap.goType];
      var cls = game.get(SYM.modules.mapNewCtrl);
      var C = cls && cls[SYM.newMap.cls];
      var inst = C && C[SYM.newMap.inst];
      if (G && inst && typeof inst.gotoWorldAndDo === 'function') return { inst: inst, G: G };
    } catch (e) { }
    try { // 旧图：WorldMapCommon.WorldMapToDoType + WorldMapTodoController.getInstance()
      var common = game.get(SYM.modules.mapOldCommon);
      var G2 = common && common[SYM.oldMap.todoType];
      var m2 = game.get(SYM.modules.mapOldCtrl);
      var i2 = m2 && (typeof m2.getInstance === 'function' ? m2.getInstance()
        : (m2.default && typeof m2.default.getInstance === 'function' ? m2.default.getInstance() : null));
      if (G2 && i2 && typeof i2.gotoWorldAndDo === 'function') return { inst: i2, G: G2 };
    } catch (e) { }
    return null;
  });
}

/**
 * 地图跳转能力。返回值统一 {ok:boolean, err?:string}，err 为技术语义键
 * （'unavailable'=协调器缺失 | 'failed'=执行异常 | 'nomarch'=该卡不支持直跳），文案归业务层。
 */
export const nav = {
  /** 导航能力是否可用 */
  ok() { return !!mapTodo(); },
  /**
   * 坐标飞行：click=true 且有 JUMP_TO_TILE_CLICK → 飞完模拟点地块（弹城市弹窗），否则 MOVE_TO 只飞+标记。
   * opts 全字段兜底 s/k/z（新图读 k||s、旧图读 z），跨服服号放 z；子服号 subMap 有值才传
   * （新图 game2displayWithServerLimit(x,y,serverId,subMap) 跨服换算需要，缺省游戏回退本服子服）。
   * @param {{x:number, y:number, z:number|null, subMap?:number|null, click:boolean}} action
   * @returns {{ok:boolean, err?:string}}
   */
  flyTo(action) {
    var t = mapTodo();
    if (!t) return { ok: false, err: 'unavailable' };
    var A = SYM.mapActions;
    var type = action.click && t.G[A.tileClick] != null ? t.G[A.tileClick] : t.G[A.moveTo];
    if (type == null) return { ok: false, err: 'unavailable' };
    var opts = { x: action.x | 0, y: action.y | 0, mark: true };
    if (action.z != null) { opts.s = action.z; opts.k = action.z; opts.z = action.z; }
    if (action.subMap != null && action.subMap > 0) opts.subMap = action.subMap;
    try { t.inst.gotoWorldAndDo(type, opts); return { ok: true }; }
    catch (e) { log.warn('flyTo(%s,%s) failed: %s', action.x, action.y, e && e.message); return { ok: false, err: 'failed' }; }
  },
  /**
   * 行军/集结飞行：JUMP_TO_MARCH_CLICK {marchId,marchType}（游戏默认分支走通用协议 GET_MARCH_INFO_FOR_JUMP）。
   * @param {{marchId:*, marchType:*}} action
   * @returns {{ok:boolean, err?:string}}
   */
  flyMarch(action) {
    var t = mapTodo();
    if (!t) return { ok: false, err: 'unavailable' };
    if (!t.G[SYM.mapActions.marchClick] || action.marchId == null) return { ok: false, err: 'nomarch' };
    try { t.inst.gotoWorldAndDo(t.G[SYM.mapActions.marchClick], { marchId: action.marchId, marchType: action.marchType }); return { ok: true }; }
    catch (e) { log.warn('flyMarch(%s) failed: %s', action.marchId, e && e.message); return { ok: false, err: 'failed' }; }
  },
};

// ─────────────────────── 玩家/游戏数据（只读） ───────────────────────

export const gameData = {
  /** 数据源是否可用 */
  ok() { return !!userData(); },
  /** 当前服务器时间（秒），实时取值不缓存；取不到返回 0 */
  serverTime() { try { return +game.get(SYM.modules.dataCenter).DATA.ServerTime || 0; } catch (e) { return 0; } },
  /** 本人 StrUid（快速登录模式下与数字 UID 不同）；取不到返回 '' */
  strUid() { var s = userData() && userData().StrUid; return (s != null && s !== '') ? String(s) : ''; },
  /** 好友 Map（登录下发 + push 维护，CheckIsMyFriend 同源）；无数据源返回 null */
  friends() {
    var fr = userData() && userData().Friends;
    return (fr && typeof fr.has === 'function' && typeof fr.keys === 'function') ? fr : null;
  },
  /** 联盟对象（Aid/MemberCount…）；不在盟/无数据源返回 null */
  alliance() { return (userData() && userData().Alliance) || null; },
};

export const gameConf = {
  /**
   * 配置数据表值（TableUtils.getDataConfigData；配置 id → 字符串/数值）。
   * @param {number} id 配置 id（如撤回时限 630061）
   * @returns {string|number} 模块不可用/未命中返回 ''
   */
  dataConfig(id) {
    var tu = probe(SYM.modules.tableUtils + '.getDataConfigData', () => {
      var m = game.get(SYM.modules.tableUtils);
      return (m && typeof m.getDataConfigData === 'function') ? m : null;
    });
    if (!tu) return '';
    try { return tu.getDataConfigData(+id) || ''; } catch (e) { return ''; }
  },
};

export const bits = {
  /**
   * 数字串 → Long64Bit.Int64（fromString）；非数字串按 Number 走 fromNumber，模块不可用回纯数字兜底。
   * @param {string|number} v 数值或数字串（如私聊 roomId=对端 uid）
   * @returns {*|number}
   */
  int64(v) {
    v = String(v == null ? '0' : v);
    var L = probe(SYM.modules.long64Bit + '.Int64', () => { var m = game.get(SYM.modules.long64Bit); return (m && m.Int64) || null; });
    if (!L) return /^\d+$/.test(v) ? Number(v) || 0 : 0;
    try { return /^\d+$/.test(v) ? L.Int64.fromString(v) : L.Int64.fromNumber(Number(v) || 0); } catch (e) { return 0; }
  },
};

export const session = {
  /** 触发游戏登出（PlatformCore.instance.userLogout）；符号缺失记 warn 静默 */
  logout() {
    var p = probe('PlatformCore.instance', () => { var m = game.get(SYM.modules.platformCore); return (m && m.instance) || null; });
    if (!p || typeof p.userLogout !== 'function') return;
    p.userLogout();
  },
};
