/**
 * 异能秘境 feat（reactor id:'secretRealm'，活动设置分组）装配层。
 *
 * 定位：本期只做「队伍停靠态、无战斗语义」的自动化（除治疗），且**只在异能秘境地图内生效**。
 *   拾取/增益井/拍宠物/BOSS 攻打+投喂+石头诸能力**默认生效、无独立开关**（面板不留存其开关配置，feat 本身 enabled 为总闸）；
 *   唯编队治疗属「会消耗背包道具」一类，保留独立开关且**默认关**：
 *   1. 物品自动拾取：掉落箱物品 / 掉落箱宠物 / 资源点 bag 三类合并，
 *      面板用 itemlist 逐行勾选 + 秘境背包持有上限（全仓统一约定：0=无上限；>0 时另受游戏 para1_v1 夹取）；
 *      **清单按道具 ID 聚合**（实证 dump：rss_station 按点位分行，item=41001 有 44 个 specId、item=41009 有 5 个，
 *      逐点位列行会出大片同名项；而 max 本就按 getItemNumById(itemId) 计）；
 *      **持有清单是两渠道共用的主清单**：每行一个目标持有量 T，行内「拾」「店」两枚勾选是把它推向 T 的两个渠道
 *      （商店补货并入本清单的 shop 标志，不再另列商品清单——物品只有持有上限，没有渠道上限）；
 *      行名来源：`item:` 取 ITEM 表 `.name`（rss_station 行无名字，只 `.item` 指向产出道具），
 *      `pet:` 取 `enigma_beast_type[cfg.type].name1`（enigma_beast 行亦无 name 字段）；
 *      行首可拖拽排序（pickOrder）：**下标即拾取优先级**，同点位配额不够时先给靠前的项（一群人就抢的场景）；
 *   2. 增益井 buff（选项 buffEffects）：仅队长可装；三个槽位按 effect_buff 分类不重复
 *      （实证表内共 6 类，默认只拿三类：全部单位攻击加成 9200001 / 伤害加深 9200004 / 野外行军速度提高 9200006），
 *      同类只在更强时等价替换；面板选项默认已勾这三类，全不勾=不限；
 *   3. 自动拍宠物：已在拍异能兽/**BOSS**（push 21530 置位 capturingPetPos，BOSS 带 boss:1）
 *      后接管整个拍节奏——免费手拍打底、拖拽事件（push 21527 type=2，窗口只有 2.0s）到达即拍、
 *      能量攒满 3 格放高分持续拍（报文实证 390 分/拍）、心动时刻（type=5 投喂弹窗）择优投喂后**立刻关掉弹窗**
 *      （不关则它会倒数归零再替玩家随机投一票）；不负责找怪、不派兵，也不自费投喂道具（**只有大BOSS 窗例外**，见第 6 条）。
 *   4. 编队治疗（healEnabled，默认关）：对受伤军队使用秘境背包里的治疗道具——白名单取 dataConfig(3035)
 *      （实证 41002 急救绷带 / 41003 全科医疗包），受伤判据取 8584 应答的 armyPower/maxArmyPower，
 *      一拍一件、marchId 直接复用应答里的 Int64 对象（报文实证 8584↔8534 严格交替）。
 *   5. BOSS 攻打 + 石头拾取（**无面板开关**，恒生效；用户反馈：次序/轮次/队长都是游戏规则或无意义项）：push 21535 里 `state===21` 且自己停在**同区域** 176 平台时
 *      发 8521 打 BOSS（一轮小BOSS 4.6~5.4s、大BOSS 8~11s，返航由服务器自动派）；石头档读 21539 账本逐点发 8548（恒领）。
 *      大小BOSS 时间错开、不同现，故不设攻打次序、轮次无限（打死为止）；**仅队长可发**（游戏规则，8521 驱动的是全队那一条行军，引擎内 isTeamLeader 已闸）；
 *      攻打目标**先打距当前平台最近的一档**（就近是同区域的强代理，避开 142）；auto-relocate（自动挪台）恒关（风险最高）。
 *      区域配对是**服务器独占判据**（客户端不查 esrId），本地只能靠「试探 + 撞 enigma_realm142 降级该(平台,BOSS) 对」
 *      学习——故被 142 拒时**不拉黑 bossId**（换了平台同一只照样能打），详见 boss.js 文件头。
 *   6. 大BOSS 拍宠投喂（**无面板开关**，恒投；必选环节）：拍宠物引擎在 `capturingPetPos.boss===1` 的窗里投
 *      behave 行 5/6 的道具（8546 `{specId}`，与游戏同一个入口）——大BOSS 要 allFavor=1000000，
 *      光靠免费手拍（实测 6~11 分/拍）拍不满；普通异能兽窗不投，详见 capture.js 文件头。
 *   7. 商店补货（**无独立开关**）：补货项 = 条目 shop=1 的道具，另有两类固定规则（自动驾驶开着时生效）：
 *      type3 跨店限量箱恒优先买（#grabType3）、香肠 41011 恒补到 10（#grabSausage）；
 *      总闸 = 「持有清单任一行勾了店」或「自动驾驶开着」（车会把队开到店，不买白跑一趟）。
 *      **只在队伍已停靠商店点（161、marchState=ARRIVED）时**才补货——买货必须“人在店里”（verbatim NWorldMapTileClickUtils：
 *      本队在驻军列表才开 PabShopPanel；8542 SHOP_BUY 不带坐标），故本引擎绝不主动开车，只负责“人在店里时买”；
 *      到店那一刻由 pilot 踢一脚（kickShop）叫醒本引擎（否则它会睡满 10 分钟轮巡）。到店先 8540 拉货单（**每次到店只 INFO 一次**，因 8540 重查会把本店非 type3 货位 getTime 归零），
 *      再按道具展开货行逐项 8542 买；货行额度买完（`_lastNum=0`）而 T 未达时发 8543 刷新（每次扣 1 个 41010 人造水晶，dataConfig 3029 预检，
 *      余额耗尽即停）；type3 跨店限量不可刷，且**已从面板清单移除**（如「传奇百兽碎片自选箱」，整场活动限购）——
 *      到店由引擎**默认最高优先级自动购买**（先于任何勾选补货项，无需「店」勾选），见 shop.js #grabType3。货表运行时枚举 `enigma_secret_realm_shop`（该表离线无数据），详见 shop.js 文件头。
 *   8. 攻击警告应对（warnEnabled，默认关）：push 21534 num>0（有其它队盯上我）时按玩家选的档处置—
 *      **立即转移**（默认）= 发 8521 去就近 175 营帐/174 平台（取 10018 快照里未被 PVP 的最近一个，快照无则不凭空造）；
 *      **抗争到底** = 不发任何转移包。全仓唯一能挪队的口就是 8521（游戏警告面板无撤离按钮）；仅队长可发、仅在停在非BOSS点才动，见 warn.js 文件头。
 *   9. 自动驾驶（driveEnabled，默认关）：其余引擎全是「到点即干活」，本引擎是唯一的**方向盘**——决定「下一个去哪」。
 *      **v3 领航员**：三源数据（表格商店锚点 + 服务器权威 BOSS 坐标 + 901 主动拉视口）+ 四层（数据/阶段/动作/到点）；
 *      优先级：受击逃帐→回攻→BOSS 档（21 开打 / 22 读秒窗上平台）→商店档（缺香肠/勤务/轮巡）→资源巡航→探索；
 *      到点：161 驻留让 shop.js 买货（并 kickShop 叫醒它）、173/163 拿空即走、176/177 交给 boss.js。
 *      开启时 warn.js 让出转移、boss.js 让出非 BOSS 点的攻打行军（两处让闸）；仅队长可发 8521，见 pilot.js 文件头。
 *   10. 拿满自动离场（autoLeaveEnabled，默认关）：借鉴竞品B judgeLeave——宠物携带背包（dataConfig 3017+扩容增益）被高品质（quality≥4）填满时，
 *      把前「容量」只按品质降序选定带出（8581 BAG_GET_SET）后发一次整场退出（8589 LEAVE）。**整场退出不可逆**，故仅队长可发、
 *      只在停稳非行军且（争夺窗已过或在 161 商店点）才撤、容量/背包清单读不到一律不触发、一场最多一次，见 leave.js 文件头。
 *   11. 侦察囤情报（scoutEnabled，默认关）：借鉴竞品B scoutBeast 的**侦察链路**（不接它的派兵择点）——对 10018 快照里的就近野生点（172）
 *      先 8536 BEAST_INFO 免费预检（应答带 beastId 即「已侦察」，直接囤、不花道具），无 beastId 且道具/冷却允许才 8537 BEAST_SCOUT（扣 1 个 41001）；
 *      品质取 enigma_beast[beastId].quality 攒进内存缓存。**只囤情报不改变任何行车/攻打行为**（172 不在巡航档），消耗稀缺勘察车故默认关，见 scout.js 文件头。
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
 * 分层：仿 mine-cave 目录化，index.js 装配 + capture.js/pickup.js/heal.js/boss.js/shop.js/warn.js/pilot.js/leave.js/scout.js 九引擎 + constants.js 私货；feats 间不互 import。
 */
import { reactor } from '../../../core/reactor.js';
import { createLog } from '../../../core/log.js';
import { exposeDebug } from '../../../core/devtools.js';
import { scene, gameData, gameConf, l10n, secretRealm, ui } from '../../../core/game-api.js';
import { CaptureEngine } from './capture.js';
import { PickupEngine } from './pickup.js';
import { HealEngine, parseHealWhitelist } from './heal.js';
import { BossEngine } from './boss.js';
import { ShopEngine, shopItemIdSet, shopType3ItemIds } from './shop.js';
import { WarnEngine } from './warn.js';
import { PilotEngine } from './pilot.js';
import { LeaveEngine } from './leave.js';
import { ScoutEngine } from './scout.js';
import {
  TABLE_ITEM,
  TABLE_RSS_STATION,
  TABLE_BEAST,
  TABLE_BEAST_TYPE,
  TABLE_EFFECT_BUFF,
  ITEM_TYPE_PAB,
  DEFAULT_BUFF_EFFECTS,
  BUFF_SLOT_MAX,
  QUALITY_HIGH,
  CFG_PAB_HEAL_ITEMS,
} from './constants.js';

/** @type {ReturnType<createLog>} feat 日志器（tag=SECRETM，沿用 createLog 大写模块名规范） */
const log = createLog('SECRETM');

/** @type {object|null} reactor 上下文（install/run 时置入） */
var ctxRef = null;
/**
 * 当前激活的九个引擎实例（run 建、pause 停）。必须持有引用，否则引擎的 `stop()` 在全仓无调用方：
 *   reactor pause 只摘 ctx.on.* 登记的触发器，管不到引擎自建的 #timer / 在飞 await 循环，
 *   不存引用就会让「暂停前的陈旧快照」在 resume 后被旧引擎继续发成写请求。
 * @type {{pickup:object|null, capture:object|null, heal:object|null, boss:object|null, shop:object|null, warn:object|null, drive:object|null, leave:object|null, scout:object|null}}
 */
var engines = {
  pickup: null,
  capture: null,
  heal: null,
  boss: null,
  shop: null,
  warn: null,
  drive: null,
  leave: null,
  scout: null,
};
/**
 * 面板模块配置（configure 推入，引擎惰性读）：物品拾取/增益井/拍宠物三大能力默认生效、无独立开关，这里只剩可配置的子项——
 *   pickItems=itemlist 状态对象 `{ [idStr]: {on:0|1, shop?:0|1, max:number} }`，idStr 前缀 `item:`（道具维度，含资源点产出）/`pet:`；
 *     on=拾取渠道、shop=商店补货渠道（仅货表在售道具可勾）、max=两渠道共用的目标持有量 T；
 *   pickOrder=拖拽得到的池 key 序（下标即优先级，未排过序为空数组）；pickRank=它的反查表 `{key: idx}`（引擎用）；
 *   buffEffects=要拿的增益类（effect_buff 数组，默认三类；空=不限即六类全要）；
 *   heal=编队治疗 {enabled,threshold,maxPerTick,items[]}（items 空=跟随游戏 dataConfig(3035) 白名单序）；
 *   boss=BOSS 攻打固定档 BOSS_AUTO（无面板开关，用户反馈：次序/轮次/投喂/队长要么是游戏规则（仅队长可发，引擎内 isTeamLeader 已闸）、要么无意义）：攻打/投喂/石头恒开、轮次无限、就近、relocate 恒关（不自动挪台）；
 *   shop=商店补货派生总闸 {enabled}（enabled 非用户勾选，而是 pickItems 是否存在 shop=1 项的派生态；且**只在队伍已停靠 161 商店点时**补货，见 shop.js）；
 *   warn=攻击警告应对 {enabled,mode}（mode='transfer' 立即转移（默认）/'stand' 抗争到底；默认关，自动挪队风险最高，见 warn.js；自动驾驶开启时本引擎让出转移、交 pilot.js EVADE 接管）；
 *   drive=自动驾驶 {enabled,boss,shopTime,revive,shopDwellMs,emptyDwellMs}（enabled=面板 driveEnabled 总闸（默关）；boss=driveBoss 子闸——BOSS 窗开着时是否自动开往 176 平台，缺省 true；shopTime=大BOSS 前定点商店勤务开关（缺省 true）；revive=driveRevive 子闸——战败(deadType==1)且本场次数未用尽时是否代答 8552 复活，缺省 true；shopDwellMs=到店驻留毫秒（面板秒×1000，默认 25000）；emptyDwellMs=资源/掉落拿空后 settle 毫秒（默认 0=立即走），见 pilot.js）。
 *   leave=拿满自动离场 {enabled}（enabled=面板 autoLeaveEnabled 总闸（默关）；无子开关，离场为不可逆的整场退出，见 leave.js）。
 *   scout=侦察囤情报 {enabled}（enabled=面板 scoutEnabled 总闸（默关）；只囤情报不派兵，花 41001 侦察野怪点品质，见 scout.js）。
 * @type {{pickItems:Object<string,{on:number,max:number,shop?:number}>, pickOrder:string[], pickRank:Object<string,number>, buffEffects:number[], heal:object, boss:object, shop:{enabled:boolean}, warn:{enabled:boolean,mode:string}, drive:{enabled:boolean,boss:boolean,shopTime:boolean,revive:boolean,shopDwellMs:number,emptyDwellMs:number}}}
 */
/**
 * BOSS 攻打固定档（面板不再给开关）：用户反馈「攻打次序/轮次/投喂/队长」要么是游戏规则（仅队长可发，boss.js 内 isTeamLeader 已闸）、
 *   要么无意义（大小BOSS 时间错开、不同现，无需选次序；轮次无限、打死为止）。故攻打/投喂/石头恒开，relocate（自动挪台，风险最高）恒关。
 *   order 保留 'guard' 仅因 boss.js #orderCmp 需要一个合法值——大小既错开，次序实际不影响选目标。
 * @type {{enabled:boolean,order:string,maxRounds:number,stone:boolean,relocate:boolean,feed:boolean}}
 */
const BOSS_AUTO = Object.freeze({
  enabled: true,
  order: 'guard',
  maxRounds: 0,
  stone: true,
  relocate: false,
  feed: true,
});

var modCfg = {
  pickItems: {},
  pickOrder: [],
  pickRank: {},
  buffEffects: DEFAULT_BUFF_EFFECTS.slice(),
  heal: { enabled: false, threshold: 10, maxPerTick: 1, items: [] },
  boss: BOSS_AUTO,
  shop: { enabled: false },
  warn: { enabled: false, mode: 'transfer' },
  drive: { enabled: false, boss: true, shopTime: true, shopDwellMs: 25000, emptyDwellMs: 0 },
  leave: { enabled: false },
  scout: { enabled: false },
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
 * 治疗道具选项（面板 multiopts 数据源）：直接拆游戏自己的白名单 `dataConfig(3035)`（源码 verbatim
 *   NWorldPabTeamSelfItem.updateUseItem 就是 `split('|')` 逐件画按钮），行名取 ITEM 表 `.name` 译文。
 * 拆法复用 heal.js 导出的 parseHealWhitelist（面板与引擎两处各拆一次必漂移）。
 * 配置未就绪或该键缺失 → 回空选项（引擎会退回直读同一 dataConfig，不依赖面板选项表）。
 * @returns {Array<{value:number,label:string}>}
 */
function buildHealOptions() {
  let ids = [];
  try {
    ids = parseHealWhitelist(gameConf.dataConfig(CFG_PAB_HEAL_ITEMS));
  } catch (e) {
    /* 配置未就绪 → 空选项（面板不显示可勾项，引擎按游戏白名单跑） */
  }
  return ids.map(function (id) {
    return { value: id, label: itemLabel(id) };
  });
}

/**
 * 构建物品拾取面板的完整池（itemlist 数据源）。**按道具 ID 聚合**，两类来源合成一行：
 *   - `item:{itemId}` = ITEM 表 `type===171` 行（掉落箱物品，实证全表只 2 行）
 *     ∪ enigma_secret_realm_rss_station 非 buff 行的 `.item`（资源点产出道具，实证 type 为 33/166/167 等）。
 *     实证 dump：rss_station 按点位分行，同一道具对应几十行（item=41001 有 44 个 specId、item=41009 有 5 个），
 *     逐 specId 列行会出大量同名项；而数量上限本就按 `getItemNumById(itemId)` 计→ 只有道具维度语义正确。
 *   - `pet:{cfgId}`   = enigma_beast 全表（掉落箱宠物，本期不合并）。
 *   两渠道可得性：`shopSellable` = 该道具在货表 enigma_secret_realm_shop 在售（shopItemIdSet 运行时枚举），不在售/表未就绪时「店」勾选置灰；
 *   `pickDisabled` = 该道具无任何掉落/资源点来源（仅商店在售，如各档异能诱饵/秘境护盾）时「拾」勾选置灰；`pet:` 行恒 channel2Disabled（宠物不经商店售卖）。
 * 表未就绪/符号缺失时 try/catch 兜住，回空数组——面板显示「池为空」但不致命。
 * @returns {Array<{id:string,label:string,cap:number,shopSellable?:boolean,pickDisabled?:boolean,channel2Disabled?:boolean}>}
 */
function buildPickPool() {
  const rows = [];
  /** @type {Object<string,1>} 已登记的道具行（防两类来源重复、防多点位重复） */
  const seen = {};
  // 商店在售集（货表离线无数据，只运行时可枚；表未就绪回空对象 → 全部置灰，面板下次重刷自然恢复）
  const shopSet = shopItemIdSet(l10n);
  // type3（跨店共享限量、整场活动限购，如「传奇百兽碎片自选箱」）道具：从面板清单移除，改由商店引擎到店默认最高优先级自动买（见 shop.js #grabType3）
  const t3Set = shopType3ItemIds(l10n);
  try {
    const itemRows = l10n.tableRows(TABLE_ITEM) || [];
    for (let i = 0; i < itemRows.length; i++) {
      const r = itemRows[i];
      if (r && Number(r.type) === ITEM_TYPE_PAB && r.id != null && !t3Set[Number(r.id)]) {
        seen[KEY_ITEM + r.id] = 1;
        rows.push({
          id: KEY_ITEM + r.id,
          label: rowLabel(r, r.id),
          cap: capOfItemRow(r),
          shopSellable: shopSet[Number(r.id)] === 1,
        });
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
      if (!itemId || t3Set[itemId] || seen[KEY_ITEM + itemId]) continue;
      seen[KEY_ITEM + itemId] = 1;
      rows.push({
        id: KEY_ITEM + itemId,
        label: itemLabel(itemId),
        cap: itemCap(itemId),
        shopSellable: shopSet[itemId] === 1,
      });
    }
  } catch (e) {
    /* 同上 */
  }
  // 仅商店在售、无任何掉落/资源点来源的道具（如各档异能诱饵、秘境护盾）：
  //   必须补进持有清单才能勾「店」补货；无拾取来源 → pickDisabled（「拾」置灰）。
  //   type3（跨店共享限量、整场活动限购）已在上面被排除——它们不进面板，改由商店引擎默认自动买。
  for (const itemIdStr of Object.keys(shopSet)) {
    const itemId = Number(itemIdStr) || 0;
    if (!(itemId > 0) || t3Set[itemId] || seen[KEY_ITEM + itemId]) continue;
    seen[KEY_ITEM + itemId] = 1;
    rows.push({
      id: KEY_ITEM + itemId,
      label: itemLabel(itemId),
      cap: itemCap(itemId),
      shopSellable: true,
      pickDisabled: true,
    });
  }
  try {
    const beastRows = l10n.tableRows(TABLE_BEAST) || [];
    for (let i = 0; i < beastRows.length; i++) {
      const r = beastRows[i];
      if (!r || r.cfgId == null) continue;
      rows.push({ id: 'pet:' + r.cfgId, label: beastLabel(r, r.cfgId), channel2Disabled: true });
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
    // 心动时刻（投喂弹窗）投完要原生收窗，不留给弹窗自己的倒数归零再随机投一票
    ui: ui,
    log: log,
    // 方向盘→商店引擎的「催买」口：pilot 到达 161 时踢一脚。商店引擎平时睡满 shopSweepMs(10min)，
    //   而队伍到店只停 driveShopDwellMs(25s)——不叫醒就是「到店也不买货」。
    //   惰性取 engines.shop（env 在 run() 里先于引擎构造，故只能闭包读模块级引用）。
    kickShop: function () {
      const e = engines.shop;
      if (e && typeof e.kick === 'function') e.kick();
    },
    // 商店引擎→方向盘的账本口（G7）：8540/8542/8543 应答后回写本店 `time/sausage/piece`。
    //   pilot 的 shopStage 节拍、选店「香肠没买过」优先、exitStage 的百兽箱判据全靠这本账
    //   （竞品在 onPabRoomShopDataUpdate 里直接写 state.shops，同一个口子）。
    markShopLedger: function (key, patch) {
      const e = engines.drive;
      if (e && typeof e.markShopLedger === 'function') e.markShopLedger(key, patch);
    },
    // 打野档的品质闸（G2）：读 scout.js 的侦察账；未侦察回 null（pilot 按竞品口径当品质 2）。
    scoutQuality: function (x, y) {
      const e = engines.scout;
      return e && typeof e.qualityAt === 'function' ? e.qualityAt(x, y) : null;
    },
    // 收场判据的「背包拿满」（G7 exitStage 第三级）：高品质只数 ≥ 携带容量。
    //   两侧读不到（容量回 0 / 清单键缺失）一律回 false——宁可不收场，不可误收场。
    petPackFull: petPackIsFull,
    // 方向盘→离场引擎的「该收场」口径口（G7）：leave.js 直读 pilot 的 exitStage 三级判据（百兽箱 piece →
    //   加 BOSS 已死 → 加背包拿满，末尾 fightEndTime 兜底），而不是自己再维护一套阈值。
    driveExitStage: function () {
      const e = engines.drive;
      return e && typeof e.exitStageWant === 'function' ? !!e.exitStageWant() : false;
    },
  };
}

/**
 * 秘境宠物携带背包是否已被高品质（`QUALITY_HIGH` 及以上）填满。
 *   verbatim 竞品B `exitStage` 的 `r`：`roomBagInfo.beastInfo` 按 `enigma_beast.quality >= 4` 计数，
 *   与 `dataConfig(3017) + PabExtraPackItemNum` 比较。
 * @returns {boolean}
 */
function petPackIsFull() {
  const cap = secretRealm.petPackCapacity();
  if (!(cap > 0)) return false;
  const pets = secretRealm.getRoomBagPets();
  if (!Array.isArray(pets)) return false;
  let n = 0;
  for (let i = 0; i < pets.length; i++) {
    const b = pets[i];
    if (!b || !b.cfgId) continue;
    let row;
    try {
      row = l10n.tableRow(TABLE_BEAST, b.cfgId);
    } catch (e) {
      row = null;
    }
    const q = row ? Number(row.quality) : NaN;
    if (Number.isFinite(q) && q >= QUALITY_HIGH) n++;
  }
  return n >= cap;
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
 * pickItems 归一化：保留对象本体、丢弃非法键/值；on 归 0/1、shop 归 0/1、max 归 >=0 整数（0=补/拾到携带上限）；空/缺省回 {}。
 * `item:{itemId}` 键额外把 max 夹到游戏自身上限（para1_v1）——旧存档里超出上限的值会被修正，
 * 与面板输入框的自动修正同口径（pet 键无上限概念，不动；pet 键也不长 shop 标志）。
 * @param {*} raw registry 传入的原值
 * @returns {Object<string,{on:number,max:number,shop:number}>}
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
    const shop = Number(e.shop) === 1 ? 1 : 0;
    let max = Math.max(0, Math.floor(Number(e.max) || 0));
    if (max > 0 && k.indexOf(KEY_ITEM) === 0) {
      const cap = itemCap(k.slice(KEY_ITEM.length));
      if (cap > 0 && max > cap) max = cap;
    }
    if (on === 1 && max === 0 && shop === 0) continue; // 默认态（拾取开、无目标、不补货）不落盘，保持存档精简
    out[k] = { on: on, max: max, shop: shop };
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
 * 面板的平铺 heal 字段（healEnabled/healThreshold/healMaxPerTick/healItems）→ 引擎用的嵌套对象。
 * 面板字段必须是标量/数组（registry 按 fd.key 直写 cfg[key]），故引擎侧的 `{heal:{…}}` 在此拼装。
 * @param {object} c 面板原配置
 * @returns {{enabled:boolean,threshold:number,maxPerTick:number,items:number[]}}
 */
function pickHealRaw(c) {
  return {
    enabled: c && c.healEnabled === true,
    threshold: c && c.healThreshold,
    maxPerTick: c && c.healMaxPerTick,
    items: c && c.healItems,
  };
}

/**
 * heal 归一化：只留引擎需要的四个字段并夹到合法区间（面板脏值/旧存档缺字段都不致引擎拿到 NaN）。
 * `items` 只留正整数且去重；**空数组 = 跟随游戏 dataConfig(3035) 白名单序**（不是「不治疗」，那是 enabled）。
 * @param {*} raw 面板原值
 * @returns {{enabled:boolean,threshold:number,maxPerTick:number,items:number[]}}
 */
function sanitizeHeal(raw) {
  const e = raw && typeof raw === 'object' ? raw : {};
  const items = Array.isArray(e.items)
    ? e.items.map(Number).filter((n) => Number.isInteger(n) && n > 0)
    : [];
  return {
    enabled: e.enabled === true,
    threshold: Math.min(100, Math.max(0, Math.floor(Number(e.threshold) || 0))),
    maxPerTick: Math.min(8, Math.max(1, Math.floor(Number(e.maxPerTick) || 1))),
    items: [...new Set(items)],
  };
}

/**
 * 面板的平铺拿满离场字段（autoLeaveEnabled）→ 引擎用的嵌套对象。
 * @param {object} c 面板原配置
 * @returns {{enabled:boolean}}
 */
function pickLeaveRaw(c) {
  return { enabled: c && c.autoLeaveEnabled === true };
}

/**
 * leave 归一化：只认 enabled 一个布尔（离场是不可逆的整场退出，故不留任何子开关，只一个默认关的总闸）。
 * @param {*} raw pickLeaveRaw 产物
 * @returns {{enabled:boolean}}
 */
function sanitizeLeave(raw) {
  const e = raw && typeof raw === 'object' ? raw : {};
  return { enabled: e.enabled === true };
}

/**
 * 面板的平铺侦察字段（scoutEnabled）→ 引擎用的嵌套对象。
 * @param {object} c 面板原配置
 * @returns {{enabled:boolean}}
 */
function pickScoutRaw(c) {
  return { enabled: c && c.scoutEnabled === true };
}

/**
 * scout 归一化：只认 enabled 一个布尔（侦察会消耗稀缺勘察车道具，故不留子开关，只一个默认关的总闸；速率/预留护栏走 tuning）。
 * @param {*} raw pickScoutRaw 产物
 * @returns {{enabled:boolean}}
 */
function sanitizeScout(raw) {
  const e = raw && typeof raw === 'object' ? raw : {};
  return { enabled: e.enabled === true };
}

/**
 * 商店补货总闸（自动）：持有清单里只要勾了任一行的「店」渠道（条目 shop=1）即视为开启补货，
 * 不再单独设一个 shopEnabled 勾选（用户反馈：补货应是清单勾选的自然结果，无需额外激活）。
 * @param {Object<string,{shop?:number}>} pickItems sanitizePickItems 产物
 * @returns {boolean}
 */
function shopRestockWanted(pickItems) {
  const keys = Object.keys(pickItems || {});
  for (let i = 0; i < keys.length; i++) {
    if (keys[i].indexOf(KEY_ITEM) === 0 && Number(pickItems[keys[i]].shop) === 1) return true;
  }
  return false;
}

/**
 * 面板的平铺攻击警告字段（warnEnabled/warnMode）→ 引擎用的嵌套对象。
 * @param {object} c 面板原配置
 * @returns {{enabled:boolean,mode:*}}
 */
function pickWarnRaw(c) {
  return {
    enabled: c && c.warnEnabled === true,
    mode: c && c.warnMode,
  };
}

/**
 * warn 归一化：enabled 归布尔；mode 只认 'transfer'（立即转移，默认）/'stand'（抗争到底），其余一律回落 'transfer'。
 * @param {*} raw pickWarnRaw 产物
 * @returns {{enabled:boolean,mode:string}}
 */
function sanitizeWarn(raw) {
  const e = raw && typeof raw === 'object' ? raw : {};
  return { enabled: e.enabled === true, mode: e.mode === 'stand' ? 'stand' : 'transfer' };
}

/**
 * 面板的平铺自动驾驶字段 → 引擎用的嵌套对象（秒字段保留原值，sanitizeDrive 负责编毫秒）。
 * @param {object} c 面板原配置
 * @returns {{enabled:boolean,boss:boolean,shopTime:boolean,revive:boolean,shopDwellSec:number,emptyDwellSec:number}}
 */
function pickDriveRaw(c) {
  return {
    enabled: c && c.driveEnabled === true,
    boss: !(c && c.driveBoss === false),
    shopTime: !(c && c.driveShopTime === false),
    revive: !(c && c.driveRevive === false),
    shopDwellSec: c && c.driveShopDwell != null ? c.driveShopDwell : 25,
    emptyDwellSec: c && c.driveEmptyDwell != null ? c.driveEmptyDwell : 0,
  };
}

/**
 * drive 归一化：enabled/boss/shopTime/revive 归布尔（boss/shopTime/revive 缺省 true）；秒→毫秒并夹 [0,300s]（非法回默认 25s/0s）。
 * @param {*} raw pickDriveRaw 产物
 * @returns {{enabled:boolean,boss:boolean,shopTime:boolean,revive:boolean,shopDwellMs:number,emptyDwellMs:number}}
 */
function sanitizeDrive(raw) {
  const e = raw && typeof raw === 'object' ? raw : {};
  let sd = Number(e.shopDwellSec);
  if (!Number.isFinite(sd)) sd = 25;
  if (sd < 0) sd = 0;
  else if (sd > 300) sd = 300;
  let ed = Number(e.emptyDwellSec);
  if (!Number.isFinite(ed)) ed = 0;
  else if (ed > 300) ed = 300;
  return {
    enabled: e.enabled === true,
    boss: e.boss !== false,
    shopTime: e.shopTime !== false,
    revive: e.revive !== false,
    shopDwellMs: sd * 1000,
    emptyDwellMs: ed * 1000,
  };
}

/**
 * 面板配置 → 模块配置（registry 侧 toModuleCfg 的**唯一**归一化入口；configure 直接整体接收本函数产物，
 *   绝不再调一次，否则嵌套产物会被当成面板平铺配置二次归一，见 configure 的踩坑注释）。
 * 物品拾取/增益井/拍宠物无开关（恒生效），故只归一可配置子项 pickItems / pickOrder / buffEffects / heal / boss / shop / warn。
 * `pickRank` 由 pickOrder 预先摊平成 `{池 key: 下标}`：拾取排序每批候选都要查序，不在热路径上做 indexOf。
 * @param {object} c 面板原配置
 * @returns {{pickItems:object, pickOrder:string[], pickRank:Object<string,number>, buffEffects:number[], heal:object, boss:object, shop:object}}
 */
function buildModuleCfg(c) {
  const order = sanitizePickOrder(c && c.pickOrder);
  const rank = {};
  for (let i = 0; i < order.length; i++) if (rank[order[i]] == null) rank[order[i]] = i;
  const pickItems = sanitizePickItems(c && c.pickItems);
  return {
    pickItems: pickItems,
    pickOrder: order,
    pickRank: rank,
    buffEffects: sanitizeBuffEffects(c && c.buffEffects, BUFF_SLOT_MAX),
    heal: sanitizeHeal(pickHealRaw(c)),
    boss: BOSS_AUTO,
    // 商店无独立开关：只要持有清单里有任一行勾了「店」渠道就自动补货（enabled 为派生态，供 shop.js #tick 读）
    shop: { enabled: shopRestockWanted(pickItems) },
    warn: sanitizeWarn(pickWarnRaw(c)),
    drive: sanitizeDrive(pickDriveRaw(c)),
    leave: sanitizeLeave(pickLeaveRaw(c)),
    scout: sanitizeScout(pickScoutRaw(c)),
  };
}

/**
 * 接收模块配置（registry 经 toModuleCfg 推入）：持有清单状态对象（含 shop 渠道标志）+ 拖拽优先级序 + 增益类勾选 + 治疗/BOSS/商店/警告子配置。
 * @param {object} c 归一化后的模块配置（buildModuleCfg 产物），不是面板平铺配置
 */
function configure(c) {
  // c 已是 registry 调 toModuleCfg(=buildModuleCfg) 产出的运行时形状，直接整体接收；**绝不二次归一**——
  //   二次 buildModuleCfg 会用面板平铺键（driveEnabled/healEnabled/warnEnabled/autoLeaveEnabled/scoutEnabled）
  //   去读嵌套产物，一律读不到 → drive/heal/warn/leave/scout 五个开关被强制回落 false（pickItems/buffEffects/
  //   pickOrder 因两种形态同构而侥幸存活，故拾取一直正常，仅「开关型」能力全哑）。
  //   实证 20261031：storage driveEnabled=true，而 modCfg.drive.enabled=false，drive #tick 每拍停在 cfg-off，
  //   停靠 (393,45) 全程 0 笔 8521；同 cs-hunt/index.js configure 的踩坑记录。
  if (c) modCfg = c;
}

/**
 * 收掉五个引擎（幂等）：只清各自的定时器与待发队列，事件退订仍由 reactor 统一摘除。
 * 停用异常只告警不阻断（下一个引擎照收），且引用一律置 null，免得脏实例被当成还活着。
 */
function stopEngines() {
  for (const k of [
    'pickup',
    'capture',
    'heal',
    'boss',
    'shop',
    'warn',
    'drive',
    'leave',
    'scout',
  ]) {
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
 * 运行（激活）：起七引擎。拾取靠事件订阅（退订由 reactor 托管），拍宠物/治疗/BOSS/商店/警告/自动驾驶靠 createCycle 电平循环；
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
  // 传 ctx：拍宠物要订阅 push 21527（拖拽窗口只有 2.0s，等不起下一拍的 capturingInfo 回写）
  engines.capture.start(ctx);
  // 传 ctx：治疗要订阅 8584 应答（血量只能从应答拿，一拍内同步等不到它）；面板 heal.enabled 默关，未勾即长睡
  engines.heal = new HealEngine(env);
  engines.heal.start(ctx);
  // 传 ctx：BOSS 攻打要订阅 21535/21521（状态机与在位现场）+ 10018（平台 esrId 快照，只写不 kick）
  engines.boss = new BossEngine(env);
  engines.boss.start(ctx);
  // 不传 ctx：商店补货是纯电平轮巡（sendSecret promise，无 push 订阅）；无独立开关，持有清单任一行勾了「店」渠道即自动跑（sc.enabled 为派生态），否则长睡；
  //   且只在队伍已停靠 161 商店点时补货（引擎绝不主动开车，见 shop.js 文件头）
  engines.shop = new ShopEngine(env);
  engines.shop.start(ctx);
  // 警告引擎订阅 21534/10018（需 ctx）：纯事件 kick + 兑底重扫；面板 warn.enabled 默关，未勾即长睡；
  //   「立即转移」只在停在非BOSS点且队长时发 8521 去就近营帐（不抢 BOSS 方向盘，见 warn.js）
  engines.warn = new WarnEngine(env);
  engines.warn.start(ctx);
  // 自动驾驶引擎（driveEnabled，默关）：**v3 领航员**——商店坐标读表锚点、BOSS 坐标读服务器权威态、
  //   候选池靠 901 主动拉视口（不再等 10018 镜头推送）；受击逃帐/回攻/上平台/到店买货/资源巡航统一方向盘（仅队长发 8521）；
  //   开启时 warn.js 让出转移、boss.js 让出非 BOSS 点的攻打行军（两处让闸），见 pilot.js 文件头
  engines.drive = new PilotEngine(env);
  engines.drive.start(ctx);
  // 调试面（core 代挂，游玩层不直接摸 window.pocketcc；release 构建 __DEVTOOLS__=false 时为空操作）：
  //   方向盘的三类料源（表锚点商店 / BOSS 权威坐标 / 901 视口）与闸门/相位在外部完全不可见，
  //   实战「一次都没动」时无法区分没启动 / 无候选 / 某闸常闭，故把实例开放给控制台只读：
  //   `pocketcc.secretRealmDrive.debugState()`。
  exposeDebug('secretRealmDrive', engines.drive);
  // 拿满自动离场引擎（autoLeaveEnabled，默关）：宠物背包被高品质填满时择优带出（8581）+ 整场退出（8589）；
  //   纯电平轮询无 push 订阅，仅队长可发、多重 fail-safe（容量/背包读不到即不撤），一场最多一次，见 leave.js 文件头
  engines.leave = new LeaveEngine(env);
  engines.leave.start(ctx);
  // 侦察囤情报引擎（scoutEnabled，默关）：对 10018 快照里就近野生点（172）先 8536 免费预检、无 beastId 且道具/冷却允许才 8537 花 41001 侦察；
  //   品质攒进内存缓存、不改变任何行车/攻打行为（172 不在巡航档）；订阅 10018 需 ctx，仅本人背包动作不要求队长，见 scout.js 文件头
  engines.scout = new ScoutEngine(env);
  engines.scout.start(ctx);
  log.info(
    'started (item overrides=%d, buff classes=%d, heal=%s, boss=%s/%s, stone=%s, shop=%s, warn=%s/%s, drive=%s/%s, leave=%s, scout=%s).',
    Object.keys(modCfg.pickItems).length,
    modCfg.buffEffects.length,
    modCfg.heal.enabled ? 'on' : 'off',
    modCfg.boss.enabled ? 'on' : 'off',
    modCfg.boss.order,
    modCfg.boss.stone ? 'on' : 'off',
    modCfg.shop.enabled ? 'on' : 'off',
    modCfg.warn.enabled ? 'on' : 'off',
    modCfg.warn.mode,
    modCfg.drive.enabled ? 'on' : 'off',
    modCfg.drive.boss ? 'boss' : 'cruise',
    modCfg.leave.enabled ? 'on' : 'off',
    modCfg.scout.enabled ? 'on' : 'off',
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
    healEnabled: false,
    healThreshold: 10,
    healMaxPerTick: 1,
    healItems: [],
    warnEnabled: false,
    warnMode: 'transfer',
    driveEnabled: false,
    driveBoss: true,
    driveShopTime: true,
    driveRevive: true,
    driveShopDwell: 25,
    driveEmptyDwell: 0,
    autoLeaveEnabled: false,
    scoutEnabled: false,
  },
  fields: [
    {
      key: 'pickItems',
      type: 'itemlist',
      label: '持有清单',
      section: '物品持有',
      sortable: true,
      orderKey: 'pickOrder',
      // 两渠道共用一个目标持有量 T（行内数字）：拾取勾 on、商店补货勾 shop（channel2）——
      //   物品只有持有上限，没有渠道上限；旧版独立的「补货清单」已并入本清单的 shop 标志。
      channel2: {
        key: 'shop',
        label: '商店',
        aLabel: '拾取',
        title:
          '勾选=商店补货渠道（自动生效，无需另开总闸）：队伍停在商店点（161、已到达）时自动买到此行目标持有量；货行额度买完而目标未达时自动发 8543 刷新（需人造水晶 41010 够，不足即停）；仅货表在售道具可勾，type3 全场限量不可刷',
        disabledOf: function (it) {
          return !!it.channel2Disabled || it.shopSellable === false;
        },
      },
      topHint:
        '可拖拽排序，越靠前越先拾；拾取/商店=两个渠道勾选，数字=目标持有量（0=补/拾到携带上限）',
      items: buildPickPool,
      hint: '拾取默认生效：当前刷新点位内掉落箱物品/宠物、资源点 bag 逐项 GET（受游戏 para1_v1、dataConfig 3021/3013/3061 总量上限）；「商店」勾选=商店补货渠道（同一个目标持有量，买/拾谁先到谁停），勾上任一项即自动开启补货（仅在队伍已停靠商店点时生效，引擎不主动开车）；无掉落来源的仅商店道具「拾取」置灰，不经商店售卖的道具（如异能晶块/人造水晶等货币、宠物）「商店」置灰',
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
    {
      key: 'healEnabled',
      type: 'checkbox',
      label: '开启编队治疗',
      section: '编队治疗',
      hint: '对受伤军队使用治疗道具（消耗秘境背包，故默认关）：8584 拉血量 → 8534 一件一件用',
    },
    {
      key: 'healThreshold',
      type: 'number',
      label: '掉血阈值(%)',
      section: '编队治疗',
      min: 0,
      step: 1,
      hint: '某支军队掉血达此百分比才用道具（与游戏血条同口径 armyPower/maxArmyPower）',
    },
    {
      key: 'healMaxPerTick',
      type: 'number',
      label: '每轮最多用(件)',
      section: '编队治疗',
      min: 1,
      step: 1,
      hint: '一拍只发一件（与游戏逐件点击同口径），多拍累加；本值限单拍上限，防一次把背包打空',
    },
    {
      key: 'healItems',
      type: 'multiopts',
      label: '治疗道具',
      section: '编队治疗',
      stack: true,
      options: buildHealOptions,
      hint: '选项 = 游戏自己的白名单 dataConfig(3035)（实证 41002 急救绷带 / 41003 全科医疗包）；空=按该白名单顺序逐件用',
    },
    {
      key: 'warnEnabled',
      type: 'checkbox',
      label: '开启攻击警告应对',
      section: '攻击警告',
      hint: '默认关（自动挪队风险最高）：push 21534 num>0（有其他队盯上我）时按下方选项处置；游戏警告面板只画红点、无撤离/应战按钮，故两选项均我们实装',
    },
    {
      key: 'warnMode',
      type: 'select',
      label: '警告处置方式',
      section: '攻击警告',
      options: [
        { value: 'transfer', label: '立即转移（默认）' },
        { value: 'stand', label: '抗争到底' },
      ],
      hint: '立即转移=发 8521 去就近 175 营帐/174 平台（只取 10018 视口快照里未被 PVP 的最近一个；快照里无则不凭空造目标）；仅队长可发、仅在停在非BOSS点(marchState=ARRIVED)才动，转移后 45s 静默。抗争到底=不发任何转移包，原地应战',
    },
    {
      key: 'driveEnabled',
      type: 'checkbox',
      label: '自动驾驶（自动开往资源点/BOSS/商店）',
      section: '自动驾驶',
      hint: '默认关（主动挪队伍是全 feat 风险最高的动作族，不同于「到点即干活」的默认生效三件套）：开启后由统一方向盘决定下一个去哪——受击（21534 num>0）逃就近营帐且威胁解除后自动回攻原 BOSS 平台、BOSS 窗（state21 开打 / state22 读秒最后 60s）自动上 176 平台、商店档（缺香肠 41011<10 / 大BOSS 前勤务 / 每 5min 轮巡）开车到 161 店点、空闲巡航 173 资源/163 掉落箱、长期无货朝未探索方向开一段换视野。数据源=表格商店坐标+服务器 BOSS 权威坐标+901 主动拉视口（不再依赖 10018 镜头推送）。开启时接管 warn.js 的转移与 boss.js 非 BOSS 点的攻打行军（到平台后攻打仍归 boss.js）；仅队长可发 8521',
    },
    {
      key: 'driveBoss',
      type: 'checkbox',
      label: 'BOSS 窗口自动开往平台',
      section: '自动驾驶',
      showIf: function (cfg) {
        return !!(cfg && cfg.driveEnabled);
      },
      hint: '开启后：存在 state=21 且战斗窗未散场的 BOSS 而本队不在 BOSS 点时，就近开往可用 176 平台（到达后攻打自动接棒 boss.js）；关则只巡航资源/商店、不为 BOSS 挪台',
    },
    {
      key: 'driveRevive',
      type: 'checkbox',
      label: '战败自动复活(8552)',
      section: '自动驾驶',
      showIf: function (cfg) {
        return !!(cfg && cfg.driveEnabled);
      },
      hint: '默认开（与竞品B同逻辑）：21521 推送里 `deadType==1` 且本场已复活次数 < 上限（dataConfig 3056）时，代答一次 8552 `{uid}` 原地复活，避免整场因一次战败停摆。上限读不到/为 0 → 一律不复活（宁不复活也不盲烧次数）；两次复活最短间隔 driveReviveGapMs。关掉则战败只挂诊断、由人自行点复活面板',
    },
    {
      key: 'driveShopTime',
      type: 'checkbox',
      label: '大BOSS 前定点商店勤务',
      section: '自动驾驶',
      showIf: function (cfg) {
        return !!(cfg && cfg.driveEnabled);
      },
      hint: '默认开：整场约 55min，大BOSS 在 +40min 开打（报文实证 fightBeginTime 偏移）、小BOSS +23min。开启后在 +10/15/20min（相对整场开始）任一时刻若本场还没去过商店，强制开车去就近 161 店点补一趟投喂料（到店即视作完成、本场不再重复；未到点/无候选每拍重试）。关掉则回到「仅补货有缺口时才去店」',
    },
    {
      key: 'driveShopDwell',
      type: 'number',
      label: '商店驻留(秒)',
      section: '自动驾驶',
      min: 0,
      step: 1,
      showIf: function (cfg) {
        return !!(cfg && cfg.driveEnabled);
      },
      hint: '到 161 店点后驻留多久让 shop.js 逐行补货，驻留满即离店（默认 25s）。定时勤务与补货缺口两档共用本值',
    },
    {
      key: 'driveEmptyDwell',
      type: 'number',
      label: '资源/掉落拿空后再驻留(秒)',
      section: '自动驾驶',
      min: 0,
      step: 1,
      showIf: function (cfg) {
        return !!(cfg && cfg.driveEnabled);
      },
      hint: '资源点(173)/掉落箱(163)改为「拿空即走」：物品拾取+BUFF拾取（或物品+宠物）都空后，再多驻留本秒数才挪队（0=立即走，默认 0）。等不到拿空由内部 45s 安全上限兜底，不会死守',
    },
    {
      key: 'autoLeaveEnabled',
      type: 'checkbox',
      label: '拿满自动离场',
      section: '拿满自动离场',
      hint: '默认关（8589 是整场退出、不可逆，是全 feat 风险最高的一档）：开启后当宠物携带背包被高品质（quality≥4）填满时，把最好的若干只选定带出（8581）后发一次离场（8589）。仅队长可发，且只在队伍已停稳、不在行军途中、且（争夺窗已过或正停在 161 商店点）时才撤；容量/背包清单读不到一律不触发（宁可不撤，绝不误判拿满）。本场最多撤一次',
    },
    {
      key: 'scoutEnabled',
      type: 'checkbox',
      label: '侦察野怪点品质',
      section: '侦察囤情报',
      hint: '默认关（侦察会消耗背包里稀缺的全地形勘察车 41001，非商店货、只能从野怪点产出拾取）：开启后只对当前视口快照里的就近野生点（172）动手——先 8536 免费预检（若该点已被侦察过，直接囤结果、不花道具），拿不到品质才发 8537 花 1 个勘察车侦察，把 beastId→品质攒进内存缓存。**只囤情报、不会为它派兵/挪队**（野怪点不在巡航档），且两次花道具之间有速率间隔、道具不足即自动改走免费预检。情报仅供面板展示与后续拓点参考',
    },
  ],
  toModuleCfg: buildModuleCfg,
  configure: configure,
  install: install,
  run: run,
  pause: pause,
});
