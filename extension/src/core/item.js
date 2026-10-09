/**
 * core/item.js —— 物品查询/标识工具层（薄，非协议聚合层）
 *
 * 定位（铁律）：
 *   - 只收口「查询与标识物品」的跨 feat 重复：背包持有量、itemId→中文名解析、奖励配置 id→主道具 itemId。
 *   - 不做「使用物品」的聚合：各 feat 消耗道具是专属服务器契约（920 加速 / 1139 联盟帮助申请 / 机甲捐赠 / 1826 遗迹领取…），
 *     语义互不相干，强行统一会退化成 if-cmd 大杂烩。发送动词留在各 feat（或 march.js 那样的协议就近模块）。
 *   - 命名空间三态铁律（教训「道具标识符混淆陷阱」）：loc 键 ≠ itemId ≠ 中文显示名。rewardItems()[0].name 是【未翻译 loc 键】，
 *     身份匹配一律用 .id（真实 itemId，number），展示才过 l10n.text 或查本模块登记表。
 *   - 与各 feat 内置道具常量（如 march 的 520001/520002、boss 的 3200001）解耦：那些是发协议就近常量，不归本模块；
 *     各 feat 的业务候选池（L2_ITEM_POOL / TRUCK_ITEM_POOL）属业务门，也留在 feat，本模块只提供通用查询/标识。
 *
 * 依赖：只读 game-api 的 gameData.itemAmount / gameData.rewardItems / l10n.text；不发包、不碰游戏写接口、无加载期副作用。
 */
import { gameData, l10n } from './game-api.js';

/**
 * itemId → 中文道具名登记表（面板/日志展示用；getRewardsArrById().name 是未翻译 loc 键，不能直接展示，故静态登记）。
 * 缺登记项由 label() 回退 l10n.text(rawName) 或 '道具 <id>'，不致命。
 * @type {Object<number,string>}
 */
const ITEM_NAMES = {
  // 遗迹 2 级道具池（relic-reward）
  600002: '大体力药剂',
  3300001: '金币砰砰宝箱',
  500001: '训练加速1小时',
  2300002: '紫色万能碎片',
  2560001: '技能抽卡券',
  1700013: '3级强化部件宝箱',
  323001: '核心建筑设计图',
  3610009: '科技道具自选箱',
  1600029: '职业道具自选宝箱',
  1700402: '绿色材料随机箱',
  99910001: '元素反应器零件',
  99910101: '元素宝箱',
  2800000: '军阵通用手册',
  // 卡车争夺奖励池（truck-intercept；1600029 与遗迹池同名，已在上登记）
  820016: '高级催化剂',
  69359: '中级重装芯片宝箱',
  2300003: '橙色万能碎片',
};

/**
 * 背包持有量（唯一入口，经 gameData.itemAmount 的 try/catch + Number 强转，读不到回 0）。
 * @param {number|string} itemId 道具 id
 * @returns {number} 持有数量；数据源/方法不可用返回 0
 */
function amount(itemId) {
  return gameData.itemAmount(itemId);
}

/**
 * itemId → 中文展示名：登记表 → l10n.text(rawName 未翻译 loc 键) → '道具 <id>' 三级回退，永不抛异常。
 * @param {number|string} itemId 道具 id
 * @param {string} [rawName] 该道具的 rewardItems().name（未翻译 loc 键），缺登记时兜底翻译用
 * @returns {string}
 */
function label(itemId, rawName) {
  var id = Number(itemId);
  if (ITEM_NAMES[id]) return ITEM_NAMES[id];
  if (rawName) {
    var t = l10n.text(rawName);
    if (t && t !== String(rawName)) return t;
  }
  return '道具 ' + id;
}

/**
 * 奖励配置 id → 主道具 {itemId, rawName}（封装 gameData.rewardItems()[0]，杜绝拿 .name 当 itemId）。
 * 解析失败回 {itemId:0, rawName:''}（调用方据此判「池外不领」等）。
 * @param {number|string} rewardId 奖励配置 id（如遗迹 1825 应答 select[] 里的值）
 * @returns {{itemId:number, rawName:string}}
 */
function fromReward(rewardId) {
  var items = gameData.rewardItems(rewardId);
  var it = items && items.length ? items[0] : null;
  return {
    itemId: it ? Number(it.id) || 0 : 0,
    rawName: it && it.name ? String(it.name) : '',
  };
}

/**
 * sortlist 面板字段的 resolve 复用：itemId → [{id,name}]；登记表无此 id 回 null（面板据此不展示该选项）。
 * @param {number|string} itemId 道具 id
 * @returns {Array<{id:number,name:string}>|null}
 */
function sortResolve(itemId) {
  var id = Number(itemId);
  var nm = ITEM_NAMES[id];
  return nm ? [{ id: id, name: nm }] : null;
}

/** 物品查询/标识工具单例 */
export const item = {
  ITEM_NAMES,
  amount,
  label,
  fromReward,
  sortResolve,
};
