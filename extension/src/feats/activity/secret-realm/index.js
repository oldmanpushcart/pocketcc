/**
 * 异能秘境 feat（reactor id:'secretRealm'，活动设置分组）装配层。
 *
 * 定位：本期只做 3 个「队伍停靠态、无战斗语义」的自动化，且**只在异能秘境地图内生效**。
 *   三大能力均**默认生效、无独立开关**（面板不留存其开关配置，feat 本身 enabled 为总闸）：
 *   1. 物品自动拾取：掉落箱物品 / 掉落箱宠物 / 资源点 bag 三类合并，
 *      面板用 itemlist 逐行勾选 + 秘境背包持有上限（0=跟随游戏 para1_v1，>0 额外限）；
 *      **清单按道具 ID 聚合**（实证 dump：rss_station 按点位分行，item=41001 有 44 个 specId、item=41009 有 5 个，
 *      逐点位列行会出大片同名项；而 max 本就按 getItemNumById(itemId) 计）；
 *      行名来源：`item:` 取 ITEM 表 `.name`（rss_station 行无名字，只 `.item` 指向产出道具），
 *      `pet:` 取 `enigma_beast_type[cfg.type].name1`（enigma_beast 行亦无 name 字段）；
 *      行首可拖拽排序（pickOrder）：**下标即拾取优先级**，同点位配额不够时先给靠前的项（一群人就抢的场景）；
 *   2. 增益井 buff（选项 buffEffects）：仅队长可装；三个槽位按 effect_buff 分类不重复
 *      （实证表内共 6 类，默认只拿三类：全部单位攻击加成 9200001 / 伤害加深 9200004 / 野外行军速度提高 9200006），
 *      同类只在更强时等价替换；面板选项默认已勾这三类，全不勾=不限；
 *   3. 自动拍宠物：已在拍异能兽/**BOSS**（push 21530 置位 capturingPetPos，BOSS 带 boss:1）
 *      后接管整个拍节奏——免费手拍打底、心动时刻（push 21527 type=2，窗口实测 3.2s）到达即拍、
 *      能量攒满 3 格放高分持续拍（报文实证 390 分/拍）、投喂弹窗择优；不负责找怪、不派兵、不自费消耗投喂道具。
 *
 * 秘境是「独立活动/独立地图/独立战斗体系/独立背包」的隔离世界：
 *   - 场景名沿用 NWorldMap，但 watchingType===PAB（isPabBattleMap）才是真正的进入标志；
 *   - 独立背包 roomBagInfo：与玩家主背包 UserData.bagInfo 无关，通过 ENIGMA_SECRET_ROOM_BAG_INFO push 同步；
 *   - 独立协议通道：req 走 TMWatchNetMgr.sendPBV2 → NetMgrSimple WebSocket，resp 回主 NetReciver；
 *   - **秘境隔离**：core/scene-watcher.js 的 world 门对 kind===pab 特殊收口——秘境图内除显式声明 kinds:['pab'] 的本 feat 外，
 *     一律 pause（原 core/pab-watcher.js 的全局规避门控已 P3 第 4 刀并入世界态，见报告 §7.4）；
 *     本 feat 无需自己声明 offInCombat；日常/战斗类 feat 也不用逐个声明，统一由 world 门的秘境隔离收口。
 *
 * 面板门控（引擎内复检 realmActive()）：
 *   - reactor 世界态门控 kinds:['pab'] + places:['world']（秘境共用主世界场景名 NWorldMap）；
 *   - 真正闸门 realmActive()：scene.name()==='NWorldMap' && secretRealm.isPabBattleMap()；
 *   - 引擎内部每拍/每事件都复检 realmActive()，非秘境即长睡/直接跳过。
 *
 * 分层：仿 mine-cave 目录化，index.js 装配 + capture.js/pickup.js 两引擎 + constants.js 私货；feats 间不互 import。
 */
import { reactor } from '../../../core/reactor.js';
import { createLog } from '../../../core/log.js';
import { scene, gameData, gameConf, l10n, secretRealm } from '../../../core/game-api.js';
import { CaptureEngine } from './capture.js';
import { PickupEngine } from './pickup.js';
import {
  TABLE_ITEM,
  TABLE_RSS_STATION,
  TABLE_BEAST,
  TABLE_BEAST_TYPE,
  TABLE_EFFECT_BUFF,
  ITEM_TYPE_PAB,
  DEFAULT_BUFF_EFFECTS,
  BUFF_SLOT_MAX,
} from './constants.js';

/** @type {ReturnType<createLog>} feat 日志器（tag=SECRETM，沿用 createLog 大写模块名规范） */
const log = createLog('SECRETM');

/** @type {object|null} reactor 上下文（install/run 时置入） */
var ctxRef = null;
/**
 * 当前激活态的两个引擎实例（run 建、pause 停）。必须持有引用，否则引擎的 `stop()` 在全仓无调用方：
 *   reactor pause 只摘 ctx.on.* 登记的触发器，管不到引擎自建的 #timer / 在飞 await 循环，
 *   不存引用就会让「暂停前的陈旧快照」在 resume 后被旧引擎继续发成写请求。
 * @type {{pickup:object|null, capture:object|null}}
 */
var engines = { pickup: null, capture: null };
/**
 * 面板模块配置（configure 推入，引擎惰性读）：物品拾取/增益井/拍宠物三大能力均默认生效、无开关，这里只剩可配置的子项——
 *   pickItems=itemlist 状态对象 `{ [idStr]: {on:0|1, max:number} }`，idStr 前缀 `item:`（道具维度，含资源点产出）/`pet:`；
 *   pickOrder=拖拽得到的池 key 序（下标即优先级，未排过序为空数组）；pickRank=它的反查表 `{key: idx}`（引擎用）；
 *   buffEffects=要拿的增益类（effect_buff 数组，默认三类；空=不限即六类全要）。
 * @type {{pickItems:Object<string,{on:number,max:number}>, pickOrder:string[], pickRank:Object<string,number>, buffEffects:number[]}}
 */
var modCfg = {
  pickItems: {},
  pickOrder: [],
  pickRank: {},
  buffEffects: DEFAULT_BUFF_EFFECTS.slice(),
};

/**
 * 是否在异能秘境地图（真正场景闸门）：主世界场景名 NWorldMap 且 watchingType===PAB（isPabBattleMap）。
 * @returns {boolean}
 */
function realmActive() {
  return scene.name() === 'NWorldMap' && secretRealm.isPabBattleMap();
}

/**
 * 从配置表行取一个可展示的中文名：优先 `.name`（loc 键）→ `l10n.text()` 翻译；回退 `#id`。
 * @param {object} row 表行
 * @param {string|number} id 主键（用于回退展示）
 * @returns {string}
 */
function rowLabel(row, id) {
  const raw = row && (row.name || row.itemName || row.desc);
  if (raw) {
    try {
      const t = l10n.text(String(raw));
      if (t && t !== String(raw)) return t;
    } catch (e) {
      /* 翻译失败降级到原键 */
    }
    return String(raw);
  }
  return '#' + id;
}

/**
 * itemlist 状态对象的道具维度键前缀（`item:{itemId}`）；与 pickRow 查表口径一致。
 * @type {string}
 */
const KEY_ITEM = 'item:';

/**
 * itemId → 道具中文名（ITEM 表 `.name` loc 键 → 译文）；行缺失回 `#item:{id}`。
 * 资源点行本身无名字，名字来自它产出的道具（实证 PabBagItem.updateResourceItem：`getTableDataById(rss_station, specId)` → `.item` → 画该道具图标）。
 * @param {number|string} itemId 道具 id
 * @returns {string}
 */
function itemLabel(itemId) {
  const row = itemId ? l10n.tableRow(TABLE_ITEM, itemId) : null;
  return row ? rowLabel(row, itemId) : '#' + KEY_ITEM + itemId;
}

/**
 * ITEM 行 → 游戏自身的持有上限。实证 RealPabController.checkItemNumMax：
 * 只有 `type===171 && para1_v1` 的道具会被游戏按 `getItemNumById >= para1_v1` 拦住（弹 enigma_item_max_001），
 * 其余 type 直接返回 undefined → 游戏不拦，只有用户填的 max 起作用。
 * @param {object|null} row ITEM 表行
 * @returns {number} 上限（0 = 游戏不设限）
 */
function capOfItemRow(row) {
  if (!row || Number(row.type) !== ITEM_TYPE_PAB) return 0;
  return Math.max(0, Math.floor(Number(row.para1_v1) || 0));
}

/**
 * itemId → 游戏自身上限（面板重刷不重复查表；只缓存查到行的结果，表未就绪下次重查）。
 * @param {number|string} itemId 道具 id
 * @returns {number} 上限（0 = 游戏不设限）
 */
const _itemCap = {};
function itemCap(itemId) {
  const k = String(itemId);
  if (_itemCap[k] != null) return _itemCap[k];
  let row;
  try {
    row = l10n.tableRow(TABLE_ITEM, itemId);
  } catch (e) {
    /* 表未就绪 → 本轮不缓存 */
    return 0;
  }
  if (!row) return 0;
  _itemCap[k] = capOfItemRow(row);
  return _itemCap[k];
}

/**
 * 异能兽 cfgId → 物种中文名（实证 EnigmaBeastResCfg.getTypeCommonName：`enigma_beast_type[cfg.type].name1` 再过 getText）。
 * 物种名按 type 缓存（全表枚举时同一物种多品质行很多，避免逐行查表）。
 * @type {Object<number,string>}
 */
const _beastTypeName = {};

/**
 * 异能兽 cfgId → 显示名（取不到回 `#pet:{cfgId}`）。
 * @param {object} row enigma_beast 行
 * @param {number|string} cfgId 配置 id
 * @returns {string}
 */
function beastLabel(row, cfgId) {
  const type = row ? Number(row.type) : 0;
  if (!type) return '#pet:' + cfgId;
  if (!_beastTypeName[type]) {
    const trow = l10n.tableRow(TABLE_BEAST_TYPE, type);
    const key = trow && (trow.name1 || trow.name_type);
    if (key) {
      const t = l10n.text(String(key));
      _beastTypeName[type] = t && t !== String(key) ? t : String(key);
    } else {
      _beastTypeName[type] = '';
    }
  }
  return _beastTypeName[type] || '#pet:' + cfgId;
}

/**
 * 增益 buff 选项列表（面板 multiopts 数据源）：枚举 rss_station 里 `effect_buff != 0` 的行，
 * 按 effect_buff 去重成「增益类」（实证秘境三类：行军加速/伤害加深/攻击增强），类名取
 *   `EFFECTBUFF[effect_buff].string` 的 loc 译文（同 PabBuffItem.updateBuffNode）。
 * @returns {Array<{value:number,label:string}>}
 */
function buildBuffOptions() {
  const out = [];
  const seen = {};
  try {
    const rows = l10n.tableRows(TABLE_RSS_STATION) || [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const eff = r ? Number(r.effect_buff) || 0 : 0;
      if (!eff || seen[eff]) continue;
      seen[eff] = 1;
      let label = '增益#' + eff;
      const erow = l10n.tableRow(TABLE_EFFECT_BUFF, eff);
      const key = erow && erow.string;
      if (key) {
        const t = l10n.text(String(key));
        label = t && t !== String(key) ? t : String(key);
      }
      out.push({ value: eff, label: label });
    }
  } catch (e) {
    /* 表未就绪 → 空选项（面板不显示可勾项，引擎按「不限」跑） */
  }
  return out;
}

/**
 * 构建物品拾取面板的完整池（itemlist 数据源）。**按道具 ID 聚合**，两类来源合成一行：
 *   - `item:{itemId}` = ITEM 表 `type===171` 行（掉落箱物品，实证全表只 2 行）
 *     ∪ enigma_secret_realm_rss_station 非 buff 行的 `.item`（资源点产出道具，实证 type 为 33/166/167 等）。
 *     实证 dump：rss_station 按点位分行，同一道具对应几十行（item=41001 有 44 个 specId、item=41009 有 5 个），
 *     逐 specId 列行会出大量同名项；而数量上限本就按 `getItemNumById(itemId)` 计→ 只有道具维度语义正确。
 *   - `pet:{cfgId}`   = enigma_beast 全表（掉落箱宠物，本期不合并）。
 * buff 类不在此清单（走增益井 buffEffects 拾取链路，pos 语义不同）。
 * `cap` = 该道具的游戏自身上限（见 capOfItemRow）：面板行内标 `≤N`，超出 N 的填写值会被自动修正。
 * 表未就绪/符号缺失时 try/catch 兜住，回空数组——面板显示「池为空」但不致命。
 * @returns {Array<{id:string,label:string,cap:number}>}
 */
function buildPickPool() {
  const rows = [];
  /** @type {Object<string,1>} 已登记的道具行（防两类来源重复、防多点位重复） */
  const seen = {};
  try {
    const itemRows = l10n.tableRows(TABLE_ITEM) || [];
    for (let i = 0; i < itemRows.length; i++) {
      const r = itemRows[i];
      if (r && Number(r.type) === ITEM_TYPE_PAB && r.id != null) {
        seen[KEY_ITEM + r.id] = 1;
        rows.push({ id: KEY_ITEM + r.id, label: rowLabel(r, r.id), cap: capOfItemRow(r) });
      }
    }
  } catch (e) {
    /* 表未就绪 → 跳过 */
  }
  try {
    const rssRows = l10n.tableRows(TABLE_RSS_STATION) || [];
    for (let i = 0; i < rssRows.length; i++) {
      const r = rssRows[i];
      if (!r || r.id == null) continue;
      if (Number(r.effect_buff) !== 0) continue; // buff 类走增益井 buffEffects 链路，不入拾取清单
      // rss_station 行无名字字段（实证 PabBagItem.updateResourceItem 只读 .item/.item_num）→ 名字取它产出的道具，并按该道具合并成一行
      const itemId = Number(r.item) || 0;
      if (!itemId || seen[KEY_ITEM + itemId]) continue;
      seen[KEY_ITEM + itemId] = 1;
      rows.push({ id: KEY_ITEM + itemId, label: itemLabel(itemId), cap: itemCap(itemId) });
    }
  } catch (e) {
    /* 同上 */
  }
  try {
    const beastRows = l10n.tableRows(TABLE_BEAST) || [];
    for (let i = 0; i < beastRows.length; i++) {
      const r = beastRows[i];
      if (!r || r.cfgId == null) continue;
      rows.push({ id: 'pet:' + r.cfgId, label: beastLabel(r, r.cfgId) });
    }
  } catch (e) {
    /* 同上 */
  }
  return rows;
}

/**
 * 装配注入两引擎的运行底座（全走 getter 惰性读实时态，引擎不反向 import 本文件避免循环依赖）。
 * 引擎自己 import 的 constants（tuning/specId/表名）不经 env 透。
 * @returns {object} env
 */
function buildEnv() {
  return {
    alive: function () {
      return !!(ctxRef && ctxRef.alive());
    },
    realmActive: realmActive,
    cfg: function () {
      return modCfg;
    },
    secret: secretRealm,
    gameData: gameData,
    gameConf: gameConf,
    l10n: l10n,
    log: log,
  };
}

/**
 * 安装：置上下文。游戏符号（pabController/watchNet/mapNewBiz/dataCenter）由 reactor 依 spec.symbols
 *   经 CAPS 统一自检，此处不再重复探测；缺符号时 reactor 不会跑到 install。引擎在 run（激活）时按最新 env 构建。
 * @param {object} ctx reactor 上下文
 * @returns {boolean}
 */
function install(ctx) {
  ctxRef = ctx;
  log.info('installed.');
  return true;
}

/**
 * pickItems 归一化：保留对象本体、丢弃非法键/值；on 归 0/1、max 归 >=0 整数；空/缺省回 {}。
 * `item:{itemId}` 键额外把 max 夹到游戏自身上限（para1_v1）——旧存档里超出上限的值会被修正，
 * 与面板输入框的自动修正同口径（pet 键无上限概念，不动）。
 * @param {*} raw registry 传入的原值
 * @returns {Object<string,{on:number,max:number}>}
 */
function sanitizePickItems(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const keys = Object.keys(raw);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const e = raw[k];
    if (!e || typeof e !== 'object') continue;
    const on = Number(e.on) === 0 ? 0 : 1;
    let max = Math.max(0, Math.floor(Number(e.max) || 0));
    if (max > 0 && k.indexOf(KEY_ITEM) === 0) {
      const cap = itemCap(k.slice(KEY_ITEM.length));
      if (cap > 0 && max > cap) max = cap;
    }
    if (on === 1 && max === 0) continue; // 默认态（on 且不限）不落盘，保持存档精简
    out[k] = { on: on, max: max };
  }
  return out;
}

/**
 * buffEffects 归一化：只留正整数 effect_buff id，去重；非数组→ []（[]=不限，六类全要）。
 * 传 max 时照面板同口径截断（旧存档超额时只留前 max 类，与槽位数对齐）。
 * @param {*} raw registry 传入的原值
 * @param {number} [max] 最多保留类数（缺省不截）
 * @returns {number[]}
 */
function sanitizeBuffEffects(raw, max) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const v = Number(raw[i]) || 0;
    if (v > 0 && out.indexOf(v) < 0) out.push(v);
  }
  const cap = Math.max(0, Math.floor(Number(max) || 0));
  return cap > 0 ? out.slice(0, cap) : out;
}

/**
 * pickOrder 归一化：只留非空字符串项、去重（以首次出现为准），再剔除**当前池里已不存在**的残留 id。
 * 池为空时不动原值：表未就绪/符号缺失只是这一次读不到池，把用户拖出来的排序账清掉是事故不是归一化。
 * @param {*} raw registry 传入的原值
 * @returns {string[]} 池 key 数组（下标即拾取优先级）
 */
function sanitizePickOrder(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (let i = 0; i < raw.length; i++) {
    const k = raw[i];
    if (typeof k !== 'string' || !k || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  if (!out.length) return out;
  const pool = buildPickPool();
  if (!pool.length) return out; // 表未就绪 → 原样保留
  const live = new Set(
    pool.map(function (p) {
      return String(p && p.id);
    }),
  );
  return out.filter(function (k) {
    return live.has(k);
  });
}

/**
 * 面板配置 → 模块配置（toModuleCfg 与 configure 共用同一份归一化，防两处口径漂移）。
 * 物品拾取/增益井/拍宠物无开关（恒生效），故只归一可配置子项 pickItems / pickOrder / buffEffects。
 * `pickRank` 由 pickOrder 预先摊平成 `{池 key: 下标}`：拾取排序每批候选都要查序，不在热路径上做 indexOf。
 * @param {object} c 面板原配置
 * @returns {{pickItems:object, pickOrder:string[], pickRank:Object<string,number>, buffEffects:number[]}}
 */
function buildModuleCfg(c) {
  const order = sanitizePickOrder(c && c.pickOrder);
  const rank = {};
  for (let i = 0; i < order.length; i++) if (rank[order[i]] == null) rank[order[i]] = i;
  return {
    pickItems: sanitizePickItems(c && c.pickItems),
    pickOrder: order,
    pickRank: rank,
    buffEffects: sanitizeBuffEffects(c && c.buffEffects, BUFF_SLOT_MAX),
  };
}

/**
 * 接收面板配置（registry 经 toModuleCfg 推入）：itemlist 状态对象 + 拖拽优先级序 + 增益类勾选（三大能力恒生效，无开关）。早于 run。
 * @param {object} c { pickItems, pickOrder, buffEffects }
 */
function configure(c) {
  modCfg = buildModuleCfg(c);
}

/**
 * 收掉两个引擎（幂等）：只清各自的定时器与待发队列，事件退订仍由 reactor 统一摘除。
 * 停用异常只告警不阻断（下一个引擎照收），且引用一律置 null，免得脏实例被当成还活着。
 */
function stopEngines() {
  for (const k of ['pickup', 'capture']) {
    const e = engines[k];
    if (!e) continue;
    engines[k] = null;
    try {
      if (typeof e.stop === 'function') e.stop();
    } catch (err) {
      log.warn('%s engine stop threw.', k, err);
    }
  }
}

/**
 * 暂停钩子（core/reactor.js 的 pause() 末尾调）：引擎自建的定时器/队列不在 ctx.on.* 托管范围内，只能这里显式收。
 */
function pause() {
  stopEngines();
}

/**
 * 运行（激活）：起两引擎。拾取靠事件订阅（退订由 reactor 托管），拍宠物靠 createCycle 电平轮询；
 *   二者内部各自复检 realmActive()/alive()，非秘境或未激活即空转长睡。resume 重跑 run 时引擎 start 幂等。
 * @param {object} ctx reactor 上下文
 */
function run(ctx) {
  ctxRef = ctx;
  // resume 会重跑 run：先把上一轮可能残留的引擎收掉（定时器/配对队列），避免新旧两引擎并发发同一批 GET
  stopEngines();
  const env = buildEnv();
  engines.pickup = new PickupEngine(env);
  engines.pickup.start(ctx);
  engines.capture = new CaptureEngine(env);
  // 传 ctx：拍宠物要订阅 push 21527（心动时刻窗口实测 3.2s，等不起下一拍的 capturingInfo 回写）
  engines.capture.start(ctx);
  log.info(
    'started (item overrides=%d, buff classes=%d).',
    Object.keys(modCfg.pickItems).length,
    modCfg.buffEffects.length,
  );
}

reactor.register({
  id: 'secretRealm',
  label: '异能秘境',
  storageKey: 'pocketcc.feat.secretRealm',
  symbols: ['pabController', 'watchNet', 'mapNewBiz', 'dataCenter'],
  // 秘境隔离（P3 第 4 刀，原 core/pab-watcher.js 并入 world-state）：kind===pab 时 world 门只放行 kinds 显式含 'pab' 的 feat，
  // 故本 feat 声明 kinds:['pab']——非秘境即 pause，进秘境自动 resume（引擎内 realmActive() 再复检一次，双保险）。
  kinds: ['pab'],
  places: ['world'], // 秘境共用主世界场景名 NWorldMap
  // 不声明 offInCombat：本 feat 是停靠态拾取/拍宠物，无战斗语义；秘境地图内其它 feat 由 world 门的 kind===pab 隔离统一规避
  defaults: {
    enabled: false,
    pickItems: {},
    pickOrder: [],
    buffEffects: DEFAULT_BUFF_EFFECTS.slice(),
  },
  fields: [
    {
      key: 'pickItems',
      type: 'itemlist',
      label: '拾取清单',
      section: '物品拾取',
      sortable: true,
      orderKey: 'pickOrder',
      topHint: '可拖拽排序，越靠前越先拾；勾选行=是否拾取，数字=秘境背包上限（0=跟随游戏上限）',
      items: buildPickPool,
      hint: '默认生效：当前刷新点位内掉落箱物品/宠物、资源点 bag 逐项 GET（受游戏 para1_v1、dataConfig 3021/3013/3061 总量上限）',
    },
    {
      key: 'buffEffects',
      type: 'multiopts',
      label: '增益选项',
      section: '增益井 buff',
      stack: true,
      maxSelect: BUFF_SLOT_MAX,
      options: buildBuffOptions,
      hint: '默认生效（空=不限即六类全要）；仅队长可装，三个槽位不重复同类（同 effect_buff 只在更强时等价替换），每轮最多装一枚',
    },
  ],
  toModuleCfg: buildModuleCfg,
  configure: configure,
  install: install,
  run: run,
  pause: pause,
});
