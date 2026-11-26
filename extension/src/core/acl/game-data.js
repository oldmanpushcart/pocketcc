/**
 * ACL 域切片 · 玩家/游戏数据只读面 + 配置数据表（core/acl/game-data.js）
 * 原 core/game-api.js 的「玩家/游戏数据」区段（一键领取常量/helper + gameData 巨对象 + gameConf），
 * 按域拆分片7迁出；原迁移区段保持行为不变，后续能力在本切片内增量扩展。l10n 经同目录 import；
 * 本切片对外导出 gameData/gameConf，由 game-api re-export 保 69 处消费方路径不破，
 * 并继续在 game-api 尾部经 registerSharedValue 挂插槽。
 */
import { game } from '../game.js';
import { SYM, probe, ns, userData, setSharedCapsProbe } from '../acl-engine.js';
import { l10n } from './l10n.js';
import { bits } from './bits.js';

// ─────────────────────── 一键领取（TaskRelax 集中领取）开启闸只读枚举 ───────────────────────

/** @type {number} DataConfig 79089：一键领取放量的 serverTransferRange 白名单（逗号分隔） */
const TASK_RELAX_RANGE_CFG = 79089;
/** @type {number} DataConfig 79092：远征行动解锁所需的最后通关任务线门槛 */
const TASK_RELAX_ADVENTURE_CFG = 79092;
/** @type {number} 远征行动建筑组 id（checkBuildingGroupExists 用，实证 TaskRelaxTool 硬编码 3800） */
const TASK_RELAX_ADVENTURE_GROUP = 3800;
/** @type {number} 金币收割机建筑 type（getBuildingByType(6)） */
const TASK_RELAX_HARVESTER_TYPE = 6;
/** @type {Object<string,number>} TaskRelaxType 枚举值（源码实证：11/21/22/31/41/42），仅记成员名→数值，游戏漂移时改此处 */
const TASK_RELAX_TYPE = {
  ISLE: 11,
  ADVENTURE_INCOME: 21,
  ADVENTURE_QUICK_BATTLE: 22,
  MECHA_TOWER: 31,
  COIN_HARVESTER_INCOME: 41,
  COIN_HARVESTER_FREE_RECEIVE: 42,
};

/**
 * 安全调用 UserData 上的一个方法（缺失/异常返回 undefined，不抛）。
 * @param {object} obj 目标对象（多为 UserData）
 * @param {string} name 方法名
 * @param {number} arg 单参数
 * @returns {*}
 */
function callNumFn(obj, name, arg) {
  if (!obj || typeof obj[name] !== 'function') return undefined;
  try {
    return obj[name](arg);
  } catch (e) {
    return undefined;
  }
}

/** BuildingGroup.Isle 枚举值（岛屿作战建筑组，运行时按成员名向 GameDefine 取；符号缺失兜底实证值 3100） */
function buildingGroupIsle() {
  var gd = probe(SYM.modules.gameDefine, () => ns(game.get(SYM.modules.gameDefine)));
  var bg = gd && gd.BuildingGroup;
  return bg && bg.Isle != null ? bg.Isle : 3100;
}

/** 重装母舰（Mecha 塔）功能是否开启：MechaTowerController.getInstance().isOpenFunc(false)（传 false 抑制 UI 弹提示，纯只读查询） */
function mechaTowerOpen() {
  try {
    var m = game.get(SYM.modules.mechaTowerCtrl);
    var cls = m && (m.MechaTowerController || (m.default && m.default.MechaTowerController));
    if (!cls || typeof cls.getInstance !== 'function') return false;
    var inst = cls.getInstance();
    return !!(inst && typeof inst.isOpenFunc === 'function' && inst.isOpenFunc(false));
  } catch (e) {
    return false;
  }
}

/**
 * 城外观（城市皮肤）显示名（只读、查表）：SKIN 表行的 name 是 loc 键（形如 skin_name_1719000），经 l10n.text 译文。
 * skinId 0 = 默认城皮（游戏侧不建行）；表行缺失/无 name/译文回落到键本身一律兜底「皮肤 <skinId>」，保证面板选项永不空标签。
 * @param {number} skinId 城外观 id
 * @returns {string} 显示名
 */
function castleFaceName(skinId) {
  if (!(skinId > 0)) return '默认城皮';
  var row = l10n.tableRow('SKIN', skinId);
  var key = row && (row.name != null ? row.name : row.Name);
  if (!key) return '皮肤 ' + skinId;
  var t = l10n.text(String(key));
  return t && t !== String(key) ? t : '皮肤 ' + skinId;
}

/**
 * 一键领取子玩法解锁只读判定（复刻 TaskRelaxTool.getIsShowQuickSweepByType 的 switch）。
 * @param {number|string} type task_relax 行的 type（TaskRelaxType 数值）
 * @returns {boolean}
 */
function taskRelaxTypeOpen(type) {
  var u = userData();
  if (!u) return false;
  var t = Number(type);
  switch (t) {
    case TASK_RELAX_TYPE.ISLE:
      return !!callNumFn(u, 'checkBuildingGroupExists', buildingGroupIsle());
    case TASK_RELAX_TYPE.ADVENTURE_INCOME:
    case TASK_RELAX_TYPE.ADVENTURE_QUICK_BATTLE: {
      if (!callNumFn(u, 'checkBuildingGroupExists', TASK_RELAX_ADVENTURE_GROUP)) return false;
      var adv = u.AdventureData;
      var last = adv ? Number(adv.LastWinMissionId) : NaN;
      // 与游戏 `Number(getDataConfigData(79092))` 的 fail-closed 对齐：门槛缺配（dataConfig 归一为 ''，
      // 游戏侧 undefined→NaN 使 last>=NaN 恒 false）时按「未达门槛」关闭，不可当 0 放行未解锁玩家。
      var thrRaw = String(gameConf.dataConfig(TASK_RELAX_ADVENTURE_CFG));
      return thrRaw !== '' && isFinite(Number(thrRaw)) && last >= Number(thrRaw);
    }
    case TASK_RELAX_TYPE.MECHA_TOWER:
      return mechaTowerOpen();
    case TASK_RELAX_TYPE.COIN_HARVESTER_INCOME:
    case TASK_RELAX_TYPE.COIN_HARVESTER_FREE_RECEIVE: {
      var b = callNumFn(u, 'getBuildingByType', TASK_RELAX_HARVESTER_TYPE);
      return !!(
        u.Harvester &&
        Number(u.Harvester.Broken) === 0 &&
        Array.isArray(b) &&
        b.length > 0 &&
        gameData.functionOn('gold_coin_harvester_ui_v1')
      );
    }
    default:
      return false;
  }
}

// coinState/mirrorOf/COIN_* 常量已迁 feats/player/auto-coin-collect/api.js（领域算法下沉，单消费方）

/**
 * 游戏日界偏移（秒）：每日 0 点刷新对应的 UTC 秒内偏移。真相来自游戏侧 DateUtils.getOffsetDaysByTime
 * 的归日式 `(t-57600)%86400`，57600=16h → 日界线落在 UTC 16:00 = 服务器本地 0:00（UTC+8）。
 * 符号/常量知识收口 ACL（只读口径）；实证服务器秒与本地 UTC+8 墙钟对齐。
 * @type {number}
 */
const GAME_DAY_RESET_OFFSET = 57600;
/** @type {number} 1970-01-01 为周四；以服务器本地日序推算周一零点 */
const EPOCH_WEEKDAY = 3;
/** @type {number} 一周秒数 */
const WEEK_SECONDS = 7 * 86400;

/**
 * @type {number} 排除捐赠的科技组 sid 10900（字典 alliance_tech_name10900=快速作战）：剩余捐赠次数走独立能量池
 * EnergyType.ALLIANCE_BUILDING_DONATE_GOLD_NUM=6，且服务端恒回 addPoint=0（只加建筑经验、不计个人每日荣誉）。
 * 能量池实测（实录报文全量 10021 归集）：pointMax=200、restoreSec=20 —— 比通用池 4（10/1800）大两个数量级、
 * 回点快 90 倍；把它混进普通科技目标会长期霸占 donateTarget（它排在 dev 列表第 8 组，前序满级即命中），
 * 把捐赠交互抬到 3 次/分钟的常驻量。用户定案（快速作战不捐）：ACL 把它从捐赠目标中整体排除——
 * 不进 donateTarget（含回退首项）、不采纳推荐位命中、不再单列 buildingTarget 披露。
 */
const SCIENCE_SID_EXCLUDE_DONATE = 10900;

/** 钻石资源号（GameDefine ResourceType.Gold=10；ResourceNameConst[10]=loc 100017=「钻石」，枚举名 Gold 具误导，玩家侧实为钻石） */
const RES_DIAMOND = 10;
/** 背包钻石道具译名模式（「钻石N」，N 即单件货值，如 钻石100×2=200；锚定全串避免误命中「幸运钻石福袋」等） */
const DIAMOND_ITEM_RE = /^钻石(\d+)$/;
/** @type {Map<number,number>|null} itemId→单件货值（ITEM 表静态配置，会话内扫一次缓存；null=尚未扫成，下次重扫） */
let diamondItemFaceCache = null;

/**
 * 扫 ITEM 表登记背包钻石道具（译名「钻石N」→ 货值 N）。纯本地读，零网络请求。
 * 表未就绪回 null（下次自愈）；表就绪但无钻石行缓存空 Map（不重扫）。
 * @returns {Map<number,number>|null}
 */
function diamondItemFaces() {
  if (diamondItemFaceCache) return diamondItemFaceCache;
  if (!l10n.tableReady()) return null;
  var rows = l10n.tableRows('ITEM');
  if (!rows || !rows.length) return null;
  var m = new Map();
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (!r || r.id == null || !r.name) continue;
    var hit = DIAMOND_ITEM_RE.exec(l10n.text(String(r.name)));
    if (hit) m.set(Number(r.id), Number(hit[1]) || 0);
  }
  diamondItemFaceCache = m;
  return m;
}

/** @type {Object<number,string>} 金融中心购物车 tabType → 游戏配置表名（ ShoppingCollectTools.getShopCollectCfg 同口径） */
const SHOPPING_CART_TABLES = {
  2: 'SHOP',
  3: 'VIP_SHOP',
  4: 'LEGIONSHOP',
  5: 'EXPEDITION_SHOP',
  6: 'ISLAND_SHOP',
  7: 'MINING',
  12: 'csb_shop',
  14: 'recovery_shop',
  16: 'behemoth_shop',
};

/**
 * 把购物车 4204 应答归一成纯规划输入；配置、货币、限购知识只留在 ACL。
 * 不调用游戏 Update/init 方法，也不暴露 UserData 私有引用。type=13 联盟商城价格/限购由
 * AllianceShopItemData 动态计算，缺少完整只读投影时 fail-closed 跳过，不能按静态价误兑。
 * @param {*} singleShopData pbAck.shoppingCarInfo.singleShopData
 * @returns {{items:Array<object>, skipped:Array<object>}|null} null=应答缺数组；items 保持游戏 Map 遍历顺序
 */
function normalizeShoppingCart(singleShopData) {
  if (!Array.isArray(singleShopData)) return null;
  var u = userData();
  if (!u || !l10n.tableReady()) return null;
  var items = [];
  var skipped = [];
  /** @type {Object<string,number>} 货币池快照；规划器按 items 顺序扣减 */
  var balances = Object.create(null);
  /** @type {Function} 读货币余额；Item 型按道具 ID，其余按 ShoppingCurrencyType */
  function balanceOf(currencyType, currencyId) {
    var key = currencyType + ':' + currencyId;
    if (balances[key] != null) return balances[key];
    var n = 0;
    if (currencyType === 1) n = Number(u.Resource && u.Resource.Gold) || 0;
    else if (currencyType === 2) n = Number(u.Resource && u.Resource.BountyMilitary) || 0;
    else if (currencyType === 3) n = Number(u.Resource && u.Resource.AdventureCoin) || 0;
    else if (currencyType === 4) n = Number(u.Resource && u.Resource.CsbRes) || 0;
    else if (currencyType === 5) n = Number(u.IslandBattleData && u.IslandBattleData.points) || 0;
    else if (currencyType === 7) n = Number(u.Resource && u.Resource.Honor) || 0;
    else if (currencyType === 6) n = Number(callNumFn(u, 'getItemAmount', currencyId)) || 0;
    balances[key] = n;
    return n;
  }
  for (var i = 0; i < singleShopData.length; i++) {
    var shop = singleShopData[i];
    var shopType = Number(shop && shop.shopType) || 0;
    var rows = shop && shop.productPurchasedData;
    if (!Array.isArray(rows)) continue;
    for (var j = 0; j < rows.length; j++) {
      var row = rows[j];
      var productId = bits.int64Str(row && row.productId);
      if (!productId) continue;
      if (shopType === 13) {
        skipped.push({
          shopType: shopType,
          productId: productId,
          reason: 'dynamic-alliance-price',
        });
        continue;
      }
      var table = SHOPPING_CART_TABLES[shopType];
      var cfg = table ? l10n.tableRow(table, productId) : null;
      if (!cfg) {
        skipped.push({ shopType: shopType, productId: productId, reason: 'shop-config-missing' });
        continue;
      }
      // ShoppingCurrencyType 与 FinancialCenterTabType 不同：2/3 都是 Gold(1)，4/5/6/12 分别为 2/3/5/4。
      var currencyType = { 2: 1, 3: 1, 4: 2, 5: 3, 6: 5, 12: 4 }[shopType] || 0;
      var currencyId = 0;
      var price = Number(cfg.price_shop) || 0;
      var limit = Number(cfg.buy_limit);
      if (shopType === 14) {
        currencyType = 6;
        var recycleCfg = l10n.tableRow('DATACONFIG', 2181903);
        currencyId = Number(recycleCfg && recycleCfg.value) || 0;
      } else if (shopType === 16) {
        currencyType = 6;
        currencyId = Number(cfg.costItemId) || 0;
        price = Number(cfg.costItemNum) || 0;
        var timeLimit = cfg.timeBuyLimit ? String(cfg.timeBuyLimit).split(',') : [];
        limit = timeLimit.length ? Number(timeLimit[1]) || 0 : Number(cfg.buy_limit) || 0;
      } else if (shopType === 7) {
        currencyType = 6;
        limit = Number(cfg.limit) > 0 ? Number(cfg.limit) : -1;
        var needs = cfg.needItem ? String(cfg.needItem).split(',') : [];
        for (var k = 0; k < needs.length; k++) {
          var pair = needs[k].split('|');
          if (pair.length === 2) {
            currencyId = Number(pair[0]) || 0;
            price = Number(pair[1]) || 0;
          }
        }
      } else if ((shopType === 2 || shopType === 3) && productId === '13') {
        // 游戏 ItemShopCollect/VipShopCollect 对 shopId=13 叠加 ShopBuyGold buff。
        var gd = probe(SYM.modules.gameDefine, () => ns(game.get(SYM.modules.gameDefine)));
        var buffType = gd && gd.BuffType && gd.BuffType.ShopBuyGold;
        var buffed = NaN;
        try {
          if (u.Buff && typeof u.Buff.getValueWithBuff === 'function')
            buffed = Number(u.Buff.getValueWithBuff(limit, buffType, true));
        } catch (e) {
          buffed = NaN;
        }
        if (!Number.isFinite(Number(buffType)) || !Number.isFinite(buffed)) {
          skipped.push({
            shopType: shopType,
            productId: productId,
            reason: 'shop-buff-unavailable',
          });
          continue;
        }
        limit = buffed;
      }
      if (!Number.isFinite(limit) && limit !== -1) {
        skipped.push({ shopType: shopType, productId: productId, reason: 'buy-limit-missing' });
        continue;
      }
      items.push({
        shopType: shopType,
        productId: productId,
        purchasedBuyNum: Number(row.purchasedBuyNum) || 0,
        chooseNum: Number(row.chooseNum) || 0,
        price: price,
        buyLimit: limit,
        currencyKey: currencyType + ':' + currencyId,
        balance: balanceOf(currencyType, currencyId),
      });
    }
  }
  return { items: items, skipped: skipped };
}

export const gameData = {
  /** 当前服务器时间（秒），实时取值不缓存；取不到返回 0 */
  serverTime() {
    try {
      return +game.get(SYM.modules.dataCenter).DATA.ServerTime || 0;
    } catch (e) {
      return 0;
    }
  },
  /**
   * 下一个「游戏日 0 点」的绝对服务器秒（日界口径见 GAME_DAY_RESET_OFFSET，源自 DateUtils）。
   * 供「按日刷新」类玩法把下次动作锤定到服务器本地 0 点之后（只读换算，不碰游戏数据）。
   * @param {number} [fromTs] 参考服务器秒（缺省取当前 ServerTime）
   * @returns {number} 下一个日界线的绝对秒；参考时间不可用（0）时返回 0
   */
  nextDailyResetTs(fromTs) {
    var t = fromTs == null ? gameData.serverTime() : Number(fromTs) || 0;
    if (!t) return 0;
    var dayStart = t - ((t - GAME_DAY_RESET_OFFSET) % 86400);
    return dayStart + 86400;
  },
  /**
   * 下一个服务器本地「周一 0 点」的绝对秒；与每日日界共用 UTC+8 偏移。
   * 1970-01-01 为周四，因此 dayIndex 减 3 后对 7 取余即距本周一的天数。
   * @param {number} [fromTs] 参考服务器秒（缺省取当前 ServerTime）
   * @returns {number} 下一个周界秒；时钟不可用返回 0
   */
  nextWeeklyResetTs(fromTs) {
    var t = fromTs == null ? gameData.serverTime() : Number(fromTs) || 0;
    if (!t) return 0;
    var dayIndex = Math.floor((t - GAME_DAY_RESET_OFFSET) / 86400);
    var sinceMonday = (((dayIndex - EPOCH_WEEKDAY) % 7) + 7) % 7;
    return (dayIndex - sinceMonday) * 86400 + GAME_DAY_RESET_OFFSET + WEEK_SECONDS;
  },
  /**
   * 军级/VIP 每日免费礼包只读状态（UserData.VipLevel/VipRewardCdTime）。
   * @returns {{level:number, cooldownTs:number}|null} level=0 是有效 VIP0；字段缺失才返回 null
   */
  vipDailyGift() {
    var u = userData();
    if (!u || u.VipLevel == null || u.VipRewardCdTime == null) return null;
    return {
      level: Number(u.VipLevel) || 0,
      cooldownTs: Number(u.VipRewardCdTime) || 0,
    };
  },
  /**
   * 购物车 4204 应答的只读规划投影（配置/限购/货币均归一为标量）。
   * @param {*} singleShopData pbAck.shoppingCarInfo.singleShopData
   * @returns {{items:Array<object>, skipped:Array<object>}|null}
   */
  shoppingCart(singleShopData) {
    return normalizeShoppingCart(singleShopData);
  },
  /**
   * 套装金币 3963 应答的免费额度只读投影。
   * @param {*} info pbAck.decorationContentShopGetInfo
   * @returns {{canGetFreeNum:number}|null} 字段缺失返回 null，0 是服务端明确无免费额度
   */
  decorationFreeGift(info) {
    if (!info || info.canGetFreeNum == null) return null;
    var n = Number(info.canGetFreeNum);
    if (!Number.isFinite(n)) return null;
    return { canGetFreeNum: Math.max(0, Math.floor(n)) };
  },
  /**
   * 计时月卡状态（只读 UserData.TimeCards；游戏 updateTimeCards 的标量投影）。
   * 月卡 UI 直接消费 cardId/endTime/nextRewardTime；ID 按字符串读，时刻按 epoch 秒归一，
   * 不把游戏私有对象或引用暴露给玩法层。未登录/数据未同步返回 []。
   * @returns {{cardId:string, endTime:number, nextRewardTime:number}[]}
   */
  timeCards() {
    var u = userData();
    var list = u && u.TimeCards;
    if (!Array.isArray(list)) return [];
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      var id = bits.int64Str(c && c.cardId);
      if (!id) continue;
      out.push({
        cardId: id,
        endTime: bits.int64ToNum(c.endTime),
        nextRewardTime: bits.int64ToNum(c.nextRewardTime),
      });
    }
    return out;
  },
  /**
   * 按 ID 查一张计时月卡（只读，timeCards 的字符串精确匹配）。
   * @param {number|string} cardId 商店档位 ID（如高级月卡 15001、广告月卡 5003）
   * @returns {{cardId:string, endTime:number, nextRewardTime:number}|null}
   */
  monthlyCard(cardId) {
    var want = bits.int64Str(cardId);
    if (!want) return null;
    var list = gameData.timeCards();
    for (var i = 0; i < list.length; i++) {
      if (list[i].cardId === want) return list[i];
    }
    return null;
  },
  /**
   * 每日悬赏任务只读投影（UserData.DailyQuests，登录下发 + 游戏侧 push 维护）。
   * 只暴露标量，不把 QuestData 私有对象/引用交给玩法层；ID 按字符串读避免 64 位精度问题。
   * @returns {{id:string, progress:number, state:number}[]}
   */
  dailyQuests() {
    var u = userData();
    var list = u && u.DailyQuests;
    if (!Array.isArray(list)) return [];
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var q = list[i];
      var id = bits.int64Str(q && q.Id);
      if (!id) continue;
      out.push({
        id: id,
        progress: Number(q && q.Num) || 0,
        state: Number(q && q.State) || 0,
      });
    }
    return out;
  },
  /**
   * 每日任务完成数（UserData.getDailyQuestFinishCount）；不可读时返回 0。
   * @returns {number}
   */
  dailyQuestFinishCount() {
    var u = userData();
    if (!u || typeof u.getDailyQuestFinishCount !== 'function') return 0;
    try {
      return Number(u.getDailyQuestFinishCount()) || 0;
    } catch (e) {
      return 0;
    }
  },
  /**
   * 每日任务宝箱状态只读投影（UserData.dailyQuestBoxStateArray，索引 0 对应 boxId=1）。
   * @returns {number[]}
   */
  dailyQuestBoxStates() {
    var u = userData();
    var list = u && u.dailyQuestBoxStateArray;
    if (!Array.isArray(list)) return [];
    var out = [];
    for (var i = 0; i < list.length; i++) out.push(Number(list[i]) || 0);
    return out;
  },
  /** 本人 StrUid（快速登录模式下与数字 UID 不同）；取不到返回 '' */
  strUid() {
    var s = userData() && userData().StrUid;
    return s != null && s !== '' ? String(s) : '';
  },
  /** 好友 Map（登录下发 + push 维护，CheckIsMyFriend 同源）；无数据源返回 null */
  friends() {
    var fr = userData() && userData().Friends;
    return fr && typeof fr.has === 'function' && typeof fr.keys === 'function' ? fr : null;
  },
  /** 联盟对象（Aid/MemberCount…）；不在盟/无数据源返回 null */
  alliance() {
    return (userData() && userData().Alliance) || null;
  },
  /**
   * 是否在联盟（只读，Alliance.isInAlliance()；游戏侧 MonthCardController.getAutoHuntMonsterList 的集结类闸门用的正是它）。
   * 三态而非布尔：符号缺失/内部抛错回 null（无从判定），调用方必须按「不判定」放行——把 null 当「不在盟」会在
   *   UserData.Alliance 子链未就绪时误停整类动作（联盟类行军/集结），那是比少一道闸更糟的回归。
   * @returns {boolean|null} true 在盟 / false 明确不在盟 / null 读不到（调用方按「无从判定」处理）
   */
  inAlliance() {
    var a = userData() && userData().Alliance;
    if (!a || typeof a.isInAlliance !== 'function') return null;
    try {
      return !!a.isInAlliance();
    } catch (e) {
      return null;
    }
  },
  /** 本人数字 pid（=UserData.UID，与世界地图 p.pid 同源，已用实录核对）；取不到返回 0 */
  myPid() {
    try {
      return Number(userData() && userData().UID) || 0;
    } catch (e) {
      return 0;
    }
  },
  /**
   * 本人 UID 原始字符串（=UserData.UID.toString()，异能秘境掉落/资源「已领」判据按 uid==UID 字符串比对，与游戏侧同口径）。
   * 相比 myPid() 的 Number 化，字符串避免 64 位 UID 超安全整数时的精度陷阱；取不到返回 ''。
   * @returns {string}
   */
  myUidStr() {
    try {
      var uid = userData() && userData().UID;
      return uid != null ? String(uid) : '';
    } catch (e) {
      return '';
    }
  },
  /**
   * 本人基地战力（=UserData.Power，游戏顶栏同源；真机探针实证 Power 为明文整数 48906307，与地图 p.power 同量纲）。
   * 取不到返回 null（而非 0）：自动防御开盾的战力闸门据 null 走「未知→最悲观」保守分支，不可把「取不到」误当「战力为 0 而判我更强」。
   * @returns {number|null}
   */
  myPower() {
    try {
      var p = userData() && userData().Power;
      return p != null && !isNaN(Number(p)) ? Number(p) : null;
    } catch (e) {
      return null;
    }
  },
  /** 本人联盟 aid（=UserData.Alliance.Aid，与地图 p.aid 同源）；未入盟/取不到返回 0 */
  myAid() {
    try {
      var a = userData() && userData().Alliance;
      return Number(a && a.Aid) || 0;
    } catch (e) {
      return 0;
    }
  },
  /**
   * 本人联盟 tag 串（=UserData.Alliance.Tag，AllianceData 构造 `this.Tag = e.basic.tag` 已核对）。
   * 用于「只与同联盟成员比对」这类判据：联盟类下发（如 1585 的 ownerAllianceTag）只带 tag 不带 aid，
   * 按 aid 比对需逐 uid 反查（回调式、代价高），故 tag 字符串比对是这类全量列表的唯一可行口径。
   * @returns {string} 未入盟/取不到返回 ''（调用方据此判「无联盟」而非「匹配任意」）
   */
  myAllianceTag() {
    try {
      var a = userData() && userData().Alliance;
      return String((a && a.Tag) || '');
    } catch (e) {
      return '';
    }
  },
  /** 本人主城/账号等级（=UserData.Level，功能 open_level 门槛判据同源）；取不到返回 0 */
  level() {
    try {
      return Number(userData() && userData().Level) || 0;
    } catch (e) {
      return 0;
    }
  },
  /**
   * 本人基地世界坐标（UserData.WorldCoord，口径同 NWorldMapUIComponent 的小地图定位）。
   * @returns {{x:number, y:number}|null} 取不到/字段不全返回 null
   */
  myWorldPos() {
    var c = userData() && userData()[SYM.dataProps.worldCoord];
    if (!c || c.x == null || c.y == null) return null;
    return { x: c.x | 0, y: c.y | 0 };
  },
  // homeAirDropSpot / airDropInstances / cdSkillAvailability 已迁 feats/player/secret-weapon-drop/api.js（领域算法下沉，单消费方）
  /**
   * 道具背包持有量（UserData.getItemAmount，只读）。机甲碎片 3200001 等都走这里。
   * @param {number} itemId 道具 id
   * @returns {number} 持有数量；数据源/方法不可用返回 0
   */
  itemAmount(itemId) {
    var u = userData();
    if (!u || typeof u.getItemAmount !== 'function') return 0;
    try {
      return Number(u.getItemAmount(+itemId)) || 0;
    } catch (e) {
      return 0;
    }
  },
  /**
   * 战争状态 Buff 的结束时刻（只读，秒）：Buff.getStateDataById(stateId).EndTime 与服务器时间比较由调用方做。
   * 自动防御用来判战争狂热（130048/130049/130132）与护盾是否在期（stateId 50001）。
   * 符号缺失/无该状态一律回 0（调用方据此判「不在该状态」——放行后仍以服务器权威拒绝为最终裁决，见 feats/battle/auto-defense）。
   * EndTime 单位实证不定时按数量级折算：>1e11 视为毫秒折回秒。
   * @param {number} stateId Buff 状态 id
   * @returns {number} 结束时刻（epoch 秒）；0=不在该状态或探测不可用
   */
  buffStateEndTime(stateId) {
    // Buff 门面是 UserData 上的 BuffPool 实例（userData().Buff），非可 require 的模块——直接 game.get('Buff') 会抛「Cannot find module」。
    // userData() 已改为实时读：切图/进战场时 UserData 被整体替换、其 .Buff 子对象一并换新，故此处绝不能再 probe 缓存该实例
    // （缓存会把首张图的 BuffPool 钉死，warFever/护盾判定读到过期 EndTime——与 selfServerId 同源的真机坑）：现读，仅校验方法在场。
    var u = userData();
    var B = u && u[SYM.dataProps.buffPool];
    if (!B || typeof B.getStateDataById !== 'function') return 0;
    try {
      var st = B.getStateDataById(+stateId);
      if (!st) return 0;
      var end = Number(st.EndTime != null ? st.EndTime : st.endTime) || 0;
      if (end <= 0) return 0;
      return end > 1e11 ? Math.floor(end / 1000) : end;
    } catch (e) {
      return 0;
    }
  },
  /**
   * 机械大师职业 buff 读数（只读）：Buff.getBuffDataById(buffId).Value。
   * 源码实证 NWorldResourcePopup（s = UserData.Buff.getBuffDataById(e); s && s.Value && canBuildTower(s.Value)）
   * ——Value 即该资源族「本人可建的完整 buildId(bid)」（如 53006 = 粮 6 级），不是布尔/等级小数。
   * 资源族 buffId：金 1101001 / 油 1101002 / 粮 1101003 / 雷神 1101072。
   * 符号缺失、无该 buff、Value 非法一律回 0（调用方按「取不到职业上限」回退经验值）。
   * @param {number} buffId 职业 buff id
   * @returns {number} Value（完整 bid）；0=取不到
   */
  buffValueById(buffId) {
    // Buff 门面是 UserData 上的 BuffPool 实例（userData().Buff），不可 require；现读不缓存（切图整体替换 UserData）
    var u = userData();
    var B = u && u[SYM.dataProps.buffPool];
    if (!B || typeof B.getBuffDataById !== 'function') return 0;
    try {
      var d = B.getBuffDataById(+buffId);
      return (d && Number(d.Value)) || 0;
    } catch (e) {
      return 0;
    }
  },
  /**
   * 某 buff 是否「已持有且有效」（Value 非 0）的**三态**只读闸：与 buffValueById 的区别是把「符号不可用」与
   * 「确实没有该 buff」分开——后者该拦，前者必须放行（把读不到当 false 会误停整类现役动作）。
   * 调用场景：联盟集结加入前的惧星前置（游戏 AllianceAssemlbyController.joinAssemlby 对 pointType 86 查 941222.Value，缺则 tips）。
   * @param {number} buffId buff id
   * @returns {boolean|null} true=持有且 Value≠0；false=明确没有；null=门面/方法不可用，无从判定
   */
  buffPresentById(buffId) {
    var u = userData();
    var B = u && u[SYM.dataProps.buffPool];
    if (!B || typeof B.getBuffDataById !== 'function') return null;
    try {
      var d = B.getBuffDataById(+buffId);
      return !!(d && Number(d.Value));
    } catch (e) {
      return null; // 查询本身抛错（游戏侧数据未就绪）同归「无从判定」
    }
  },
  /**
   * 是否处于战争狂热（禁止开盾窗口）：复刻游戏 getWarFeverState，三个狂热阶段 stateId 任一命中即真。
   * 探测不可用（Buff 符号漂移）时返回 false——放行开盾尝试，交由 910 status=3+war_fever_003 权威裁决。
   * @returns {boolean}
   */
  warFever() {
    var now = gameData.serverTime() | 0;
    if (!now) return false;
    var ids = [130048, 130049, 130132];
    for (var i = 0; i < ids.length; i++) {
      if (gameData.buffStateEndTime(ids[i]) > now) return true;
    }
    return false;
  },
  /**
   * 本人护盾是否已生效（只读，stateId 50001 的结束时刻 > 服务器时间）。探测不可用返回 false（不阻断，交由 910 裁决）。
   * @returns {boolean}
   */
  shieldActive() {
    return gameData.buffStateEndTime(50001) > (gameData.serverTime() | 0);
  },
  /**
   * 游戏权威「能否开盾」闸（只读、抑制 UI：checkShieldEnable(false)）——命中狂热/危险区/跨服限制时返回 false，一次覆盖三重判定。
   * 符号缺失返回 null（调用方降级为「不预判、直接尝试、以 910 拒绝为准」）。
   * @returns {boolean|null} true=可开 / false=不可开 / null=无从判定（符号缺失）
   */
  canShield() {
    var C = probe(SYM.modules.commonTools + '.checkShieldEnable', () => {
      var m = ns(game.get(SYM.modules.commonTools));
      return m && typeof m.checkShieldEnable === 'function' ? m : null;
    });
    if (!C) return null;
    try {
      return !!C.checkShieldEnable(false);
    } catch (e) {
      return null;
    }
  },
  /**
   * 指定世界坐标能否落城（只读，一切以游戏自身迁城判定为准，不做插件侧启发式降级）。
   * 新图优先：NWorldMapUtils.checkCanMove(x,y)（模块级函数，无需实例）；旧图回退：WorldMapController.model.checkIsPlainTile(x,y,true)（静态 model）。
   * 二者皆不可得（模块未加载/未在世界图）返回 null（→ core/defense 判「无从判定」，交上层顺延，绝不猜测）。
   * @param {number} x game x
   * @param {number} y game y
   * @returns {boolean|null} true=可落 / false=不可落 / null=无从判定
   */
  canMoveCity(x, y) {
    var A = probe(SYM.modules.nWorldMapUtils + '.checkCanMove', () => {
      try {
        var m = game.get(SYM.modules.nWorldMapUtils);
        var U = m && (m.NWorldMapUtils || m.default || m);
        if (U && typeof U.checkCanMove === 'function') return { kind: 'utils', ref: U };
      } catch (e) {}
      try {
        var c = game.get(SYM.modules.worldMapCtrl);
        var C =
          c &&
          (c.WorldMapController || (c.default && (c.default.WorldMapController || c.default)) || c);
        var model = C && C.model;
        if (model && typeof model.checkIsPlainTile === 'function')
          return { kind: 'ctrl', ref: model };
      } catch (e) {}
      return null;
    });
    if (!A) return null;
    try {
      if (A.kind === 'utils') return !!A.ref.checkCanMove(x | 0, y | 0);
      return !!A.ref.checkIsPlainTile(x | 0, y | 0, true);
    } catch (e) {
      return null;
    }
  },
  /**
   * 城外观(skinId)占地边长（格数，只读、**场景无关**）：等价游戏 CommonTools.getCitySkinSize——直接查 SKIN 配置表 .large。
   * 用现成的 l10n.tableRow('SKIN', id) 取行、读 .large，不再 probe NWorldMapUtils.getCitySkinSize（该类无此方法，宿主应为 CommonTools，且本质就是查表）。
   * 用于把 901 单锚点还原成 footprint 格集合（4 格城 large=2）；不依赖已加载 entities，远程可用。
   * @param {number|string} skinId 城外观 id（901 城点 p.skinId，或 UserData.UsingCastleFace）
   * @returns {number|null} 边长格数（1=单格，2=2×2…）；表/行不可得或 skinId 空 → null
   */
  citySkinSize(skinId) {
    if (skinId == null) return null;
    var row = l10n.tableRow('SKIN', skinId);
    if (!row) return null;
    var s = Number(row.large != null ? row.large : row.Large) || 0;
    return s >= 1 ? s | 0 : 1;
  },
  /**
   * 本人主城外观 skinId（UserData.UsingCastleFace）；迁城落点 footprint 边长 = citySkinSize(此值)。
   * @returns {number|null} 取不到返回 null
   */
  usingCastleFace() {
    var u = userData();
    return u && u.UsingCastleFace != null ? u.UsingCastleFace : null;
  },
  /**
   * 本人有效城外观（城市皮肤）清单（只读、同步、**不发包**）：逐项读 UserData.MyCastleFace，只留「仍在有效期内」的 skinId。
   * 拥有口径同游戏 PlayerSkillCastleItem（报文实证 dashcam 20261126T011550-城皮切换：854 应答 list[] 同字段）：
   * `endTime === -1`（永久）或 `endTime > ServerTime`。名称取 SKIN 表行的 loc 键（形如 skin_name_1719000）经 l10n 译文。
   * 之所以不读 854 GET_MY_CASTLE_FACE：它是面板 options 求值链上的一环（buildPanelHTML 同步跑），在这里发包等于每个页面会话无条件多发一发。
   * @returns {Array<{skinId:number, name:string, endTime:number}>} 按 skinId 升序；数据源缺失返回 []（含 skinId 0 默认城皮，若下发）
   */
  castleFaces() {
    var u = userData();
    var map = u && u[SYM.dataProps.castleFace];
    if (!map || typeof map !== 'object') return [];
    var now = gameData.serverTime() | 0;
    var out = [];
    for (var k in map) {
      var d = map[k];
      if (!d || typeof d !== 'object') continue;
      var skinId = Number(k);
      if (!isFinite(skinId) || skinId < 0) continue;
      var end = Number(d.endTime != null ? d.endTime : d.EndTime);
      if (!isFinite(end)) end = 0;
      if (!(end === -1 || (end > 0 && now > 0 && end > now))) continue;
      out.push({ skinId: skinId | 0, name: castleFaceName(skinId | 0), endTime: end });
    }
    out.sort(function (a, b) {
      return a.skinId - b.skinId;
    });
    return out;
  },
  /**
   * 联盟堡垒领地（禁迁区）原始条目只读快照：NWorldMapTerritoryModel 单例的 AllianceTerritory（随视口加载、出视口被 purge，故易失）。
   * 每条 {x,y,w,bw,owner,buildId} 为堡垒原点 + 旋转菱形宽高 + 归属联盟 aid；调用方据此推「实心禁迁区」（不依赖 AlliancePointPool 的奇偶采样，避免盲区漏判）。
   * 模型不可得（子包未载/未进世界图）返回 null（→ 交上层判「无从判定」，绝不猜测）；在场但当前为空返回 []。
   * @returns {Array<{x:number,y:number,w:number,bw:number,owner:number,buildId:number}>|null}
   */
  allianceTerritories() {
    // 缓存类、现读 instance：联盟领地模型与 NWorldMapData.instance 同族（subpack2 世界图单例），
    // 随视口加载/出视口 purge，切图/进战场时 instance 被重建——缓存 instance 会读到老家领地占用（真机坑）。
    var C = probe(SYM.modules.nWorldMapTerritoryModel + '.cls', function () {
      try {
        var m = game.get(SYM.modules.nWorldMapTerritoryModel);
        return (m && (m.NWorldMapTerritoryModel || m.default || m)) || null;
      } catch (e) {
        return null;
      }
    });
    var inst = C && (C.instance || C);
    var AT = inst && inst.AllianceTerritory;
    if (!AT) return null;
    var out = [];
    for (var k in AT) {
      var it = AT[k];
      if (it && it.x != null && it.y != null)
        out.push({
          x: it.x | 0,
          y: it.y | 0,
          w: it.w | 0,
          bw: it.bw | 0,
          owner: it.owner | 0,
          buildId: it.buildId,
        });
    }
    return out;
  },
  /** 本人子服号（UserData.subServerID）；取不到返回 0——getCellIndex/cell 空间换算用 */
  subServerId() {
    try {
      return Number(userData().subServerID) || 0;
    } catch (e) {
      return 0;
    }
  },
  /**
   * 本服是否属于 KVK（跨战区天梯）形态（GameTools.isKVK = isC4||isC8||isC8S2）。
   * **它是形态位、不是图位**（取证 GameTools）：三支全部走
   * `judgeKVK(e) = (1|UserData.eightServerType)-1 === e`（四国 8 / 八国 4 / 八国 S2 6），
   * 即「你这台整个赛季都算 KVK 阵营」，人回了原战区仍为真（与 CrossUtils 同名谓词同源，@1651/@1898）。
   * 需要「此刻真在跨服战场图上」的口径请读 worldState.crossMap()，不要拿本函数凑数。
   * 符号不可得保守返回 false（当本服处理，宁可多拦也不误迁被服务器拒）。
   * @returns {boolean}
   */
  isKVK() {
    var T = probe(SYM.modules.gameTools + '.isKVK', () => {
      try {
        var m = game.get(SYM.modules.gameTools);
        return (m && (m.default || m.GameTools || m)) || null;
      } catch (e) {
        return null;
      }
    });
    try {
      return !!(T && typeof T.isKVK === 'function' && T.isKVK());
    } catch (e) {
      return false;
    }
  },
  /**
   * 本服是否处于「战区/跨服对战态」（UserData.ServerState === GameDefine.ServerState.Fight）。
   * 迁城落点权威豁免源（实证游戏侧 WorldMapController.moveCity）：服务端「别盟堡垒领地禁迁」
   * 仅在 `(!isKVK() || !八国色号) && ServerState != Fight && owner>0 && owner!=我的Aid` 时拒绝迁入——
   * 即 ServerState==Fight（作战态）时整图放开别盟领地，与本服/KVK 图无关。符号不可得保守返回 false
   * （维持禁落，宁可不迁也不误迁）。
   * 消费方已改读 worldState.phase()（与本源同一字段、同一语义）；本函数保留作低层原语与 devtools 对照。
   * @returns {boolean} true=作战态（禁迁豁免）
   */
  serverStateIsFight() {
    try {
      var u = userData();
      var GD = probe(SYM.modules.gameDefine + '.ServerState.Fight', () =>
        ns(game.get(SYM.modules.gameDefine)),
      );
      var fight = GD && GD.ServerState && GD.ServerState.Fight;
      if (u == null || fight == null) return false;
      return u.ServerState === fight;
    } catch (e) {
      return false;
    }
  },
  /**
   * 世界格索引（NWorldMapUtils.getCellIndex(x,y,ServerId,subServerID)）：game 坐标 + 服号 + 子服 → 唯一 cell index，供 placeFlags 逐格读。符号不可得返回 null。
   * @returns {number|string|null}
   */
  mapCellIndex(x, y) {
    var U = probe(SYM.modules.nWorldMapUtils + '.getCellIndex', () => {
      try {
        var m = game.get(SYM.modules.nWorldMapUtils);
        var u = m && (m.NWorldMapUtils || m.default || m);
        return u && typeof u.getCellIndex === 'function' ? u : null;
      } catch (e) {
        return null;
      }
    });
    if (!U) return null;
    var svr = 0,
      sub = 0;
    try {
      var u = userData();
      svr = u.ServerId | 0;
      sub = u.subServerID | 0;
    } catch (e) {}
    try {
      return U.getCellIndex(x | 0, y | 0, svr, sub);
    } catch (e) {
      return null;
    }
  },
  /**
   * settle 就绪信号：以 (x,y) 为中心 `(2r+1)²` 邻域内 placeFlags 命中格数。>0 表示该区域已随视口加载进 NWorldMapData（canMoveCity 据此可信）；
   * =0 表示区域未加载（canMoveCity 会把一切当空地误放行）。placeFlags 符号不可得返回 null（与「加载后确为空」区分）。
   * @param {number} x @param {number} y @param {number} r 邻域半宽（格）
   * @returns {number|null}
   */
  mapLoadedNear(x, y, r) {
    // 缓存类、现读 instance（与 selfServerId 同一 '.cls' 缓存）：切跨服战场时 instance（含 placeFlags）会被重建，
    // 缓存 instance 会读到老家占用（与 selfServerId 同源的真机坑）。
    var C = probe(SYM.modules.nWorldMapData + '.cls', () => {
      try {
        var m = game.get(SYM.modules.nWorldMapData);
        return (m && (m.NWorldMapData || m.default || m)) || null;
      } catch (e) {
        return null;
      }
    });
    var W = C && (C.instance || C);
    var pf = W && W.placeFlags;
    if (!pf || typeof pf.has !== 'function') return null;
    r = r | 0;
    var n = 0;
    for (var dx = -r; dx <= r; dx++)
      for (var dy = -r; dy <= r; dy++) {
        var idx = this.mapCellIndex((x | 0) + dx, (y | 0) + dy);
        if (idx != null && pf.has(idx)) n++;
      }
    return n;
  },
  /**
   * 每日补给（online reward）计时奖励态只读快照（UserData.timeReward，登录/630 全量下发 + 游戏 UI 领取回调回写）。
   * 可领判据由调用方算：online_reward 表第 times+1 行的 time 与 (ServerTime - rewardTime) 比较；
   * 查不到/字段非法返回 null（游戏侧 updateTimeReward 空数据时也会置 null，语义一致）。
   * @returns {{times:number, rewardTime:number}|null}
   */
  timeReward() {
    var t = userData() && userData().timeReward;
    if (!t) return null;
    var times = Number(t.times);
    var rewardTime = Number(t.rewardTime);
    if (!(times >= 0) || !(rewardTime > 0)) return null;
    return { times: times, rewardTime: rewardTime };
  },
  /**
   * 假面舞会（MASK_DANCE / cityReward 宝箱）今日领取态只读快照。
   * 数据源：push 10053 PUSH_USER_DATA_COMMON 的 `{danceRec:{<boxItemId>:次数}, myReceiveDance:[<instanceId 字符串>]}`
   *   （实录报文实证）。
   * 口径：
   *   - `byItem` 的键是**宝箱道具 id**（如 260617005），值是该道具今日已领次数；限额是**逐道具**口径
   *     （客户端源码实证：游戏闸门写的是 `daily_limit > itemCityRewardReceivedNum[itemId]`，
   *     ItemData.GetDes 的「今日剩余领取次数」也按单个 itemId 算），跨道具 id 求和当分母会把
   *     「每种各 N 次」误压成「全族共 N 次」，导致多道具年份提前静默封顶；
   *   - `instIds` 是**已领舞会实例 id 的字符串数组**（19 位，禁 Number 化），同实例只能领一次——`cityReward.players[]`
   *     只是展示名单不含 uid，不可作幂等判据；
   *   - 登录期是否全量下发仍未实证（§4-2 已由源码解决「字段叫什么」，未解决「什么时候有」），
   *     故拿不到字段时返回 null 而非空态——调用方须回落到自己的镜像。
   * @returns {{byItem:Object<string,number>, instIds:string[]}|null} 数据源/字段不可得返回 null
   */
  maskDanceState() {
    var u = userData();
    if (!u) return null;
    // 候选名：SYM.dataProps 登记的线上键 + 客户端源码里的语义名（UserItemCityRewardBtn 读的两个 getter）。
    // 角色一律由候选表**显式声明**，不靠名字正则猜：`itemCityRewardReceivedInstIds` 里的 "Rec" 会被次数表
    // 判据命中，而数组的 typeof 也是 'object'——一旦被误归成 rec，调用方 `for in` 会拿到 19 位实例 id 串，
    // Number 化后（精度已丢，破 Int64 红线）把「今日已领次数」拉成天文数字，导致当日静默封顶永不领取。
    var roles = [
      { role: 'rec', names: ['itemCityRewardReceivedNum', SYM.dataProps.danceRec] },
      { role: 'insts', names: ['itemCityRewardReceivedInstIds', SYM.dataProps.myReceiveDance] },
    ];
    var rec = null;
    var insts = null;
    for (var r of roles) {
      for (var name of r.names) {
        var v;
        try {
          v = u[name];
        } catch (e) {
          v = null;
        }
        if (v == null || v === '') continue;
        if (r.role === 'rec') {
          if (typeof v === 'object' && !Array.isArray(v)) rec = rec || v;
        } else if (Array.isArray(v)) {
          insts = insts || v;
        }
      }
    }
    if (!rec && !insts) return null;
    var byItem = {};
    for (var k in rec || {}) {
      var n = Number(rec[k]);
      // 安全阀：「今日已领次数」的量级不可能超过 1000，越界即视为误收的脏数据直接丢弃——
      // 封顶判据宁可少计（多发一次被拒请求），也不可被拉爆成恒真（当天一座都领不到且无法归因）。
      if (Number.isFinite(n) && n >= 0 && n <= 1000) byItem[String(k)] = n;
    }
    return { byItem: byItem, instIds: (insts || []).map(String) };
  },
  /**
   * 每日特惠（hero daily deal）免费奖励领取态只读快照（UserData.heroDailyDealGiftIsReceived，
   *   游戏字段来源 choose_hero_daily_reward：登录全量下发 + push 10053 PUSH_USER_DATA_COMMON 回写）。
   * 口径与游戏 HeroDailyDealGiftShopNode.refreshFreeRewardItem 同判据：
   *   0=今日可领、1=今日已领、-1=构造默认（数据未同步/玩法未对该玩家开），拿不到 UserData 返回 null。
   * @returns {number|null}
   */
  heroDailyDealReceived() {
    var u = userData();
    if (!u) return null;
    var v = u.heroDailyDealGiftIsReceived;
    if (v == null || v === '') return null;
    var n = Number(v);
    return Number.isFinite(n) ? n : null;
  },
  /**
   * 联盟机甲本地态快照（Alliance.AllianceBossData 的 getter，游戏由 push 10435 / 1160 / 1161 应答刷新）。
   * 口径提醒：todayTime / todayFree 两字段由 updateData 的 `null != e.todayTime` 守卫单独维护，
   * 而 push 10435 的载荷里没有它们（只有 allianceBoss 一块）→ 未开面板时恒为构造默认 0，不可据此判免费。
   * state 构造默认 -1（未开启），与「本服没这套玩法/联盟未召唤」同义。
   * @returns {object|null} {state,bossId,x,y,exp,hp,endTime,summonTime,pointSid,help}；对象不可用返回 null
   */
  allianceBoss() {
    // 现读、不缓存：Alliance.AllianceBossData 是游戏由 push 10435/1160/1161 刷新的数据容器，
    // userData() 已实时化，切图/进战场时其 .Alliance 子链随之换新——probe 钉住首块会在刷新后读到过期机甲态。
    var a = userData() && userData().Alliance;
    var src = a && a[SYM.dataProps.allianceBoss];
    if (!src || typeof src.State !== 'number') return null;
    try {
      return {
        state: src.State | 0,
        bossId: src.BossId | 0,
        x: src.X | 0,
        y: src.Y | 0,
        exp: Number(src.Exp) || 0,
        hp: Number(src.Hp) || 0,
        endTime: Number(src.EndTime) || 0,
        summonTime: Number(src.SummonTime) || 0,
        pointSid: src.PointSid | 0,
        help: src.Help | 0,
      };
    } catch (e) {
      return null;
    }
  },
  /**
   * 联盟科技本地态快照（Alliance.scienceData 的只读 getter/方法，游戏由 1143 应答 / push 10430/10432 刷新）。
   * 口径：recommendId 为官员推荐项（0=无推荐）；costCoin 走游戏
   * getCostCoin()（PLAYER_LEVEL[等级].donation_gold，随等级变）；dailyHonor 为今日已获荣誉
   * （科技捐与遗迹捐共用同一计数：1067 应答 curPoint 直接写回 donateDailyHonor，抓包实证）。
   * firstDonateable：按游戏弹窗 showBtn 同款可捐口径扫的第一项（诊断用，快速作战 10900 已排除不会命中）——
   *   isLock()（ItemData 方法：sid=10400 恒 false，服务器初始化后为 true）且 !isMaxLevel()（未满级）
   *   且 isStatus()（status==0，即非研究中；研究中捐赠按钮被隐藏）；找不到返回 null。
   * donateTarget：本轮真正该捐的「普通科技」目标（出个人荣誉那条），已把可捐校验与优先级合成——
   *   推荐项（RecommendId，即 sid）必须自身通过同一 canDon 口径且不是排除项才被采纳，否则回退首个可捐的
   *   **非排除**项；两者皆无则 null（快速作战 10900 按用户定案不捐，从目标合成中整体排除）。
   *   这是对「满级/研究中的推荐项直接捐会被服务器拒」的修正，也是对「10900 霸占首项导致常驻高频捐赠」的修正。
   * honorCap：今日荣誉上限，走游戏 Alliance.getAllianceScienceScore()（内部读 DATACONFIG 16005），
   *   取不到为 0（上层据此不设此闸）。
   * @returns {object|null} {recommendId,recommendName,dailyHonor,honorCap,costCoin,firstDonateable,donateTarget,donateRecommended}；不在盟/数据未填充返回 null
   */
  allianceScience() {
    // 现读、不缓存（同 allianceBoss：游戏由 1143 应答 / push 10430/10432 刷新该容器，缓存会在刷新后读到过期科技态）
    var a = userData() && userData().Alliance;
    var src = a && a[SYM.dataProps.allianceScience];
    if (!src || !Array.isArray(src.scienceDevDataList) || typeof src.getCostCoin !== 'function')
      return null;
    try {
      // 可捐口径（弹窗 showBtn 的捐赠按钮分支）：已解锁且未满级且非研究中
      var canDon = function (it) {
        return !!(
          it &&
          typeof it.isLock === 'function' &&
          it.isLock() &&
          !it.isMaxLevel() &&
          it.isStatus()
        );
      };
      var nameOf = function (it) {
        return it && typeof it.getName === 'function' ? String(it.getName() || '') : '';
      };
      var recId = Number(src.RecommendId) || 0;
      // 一趟扫描收两个口径：任意首项（诊断）/ 首个可捐普通项（普通链回退）；排除项 10900 不参与任何口径
      var first = null;
      var firstNormal = null;
      var lists = [src.scienceDevDataList, src.scienceWarDataList];
      for (var li = 0; li < lists.length; li++) {
        var arr = lists[li] || [];
        for (var i = 0; i < arr.length; i++) {
          var it = arr[i];
          if (!canDon(it)) continue;
          var id = Number(it.sid) || 0;
          if (id === SCIENCE_SID_EXCLUDE_DONATE) continue; // 快速作战不捐（用户定案）
          if (!first) first = { scienceId: id, name: nameOf(it) };
          if (!firstNormal) firstNormal = { scienceId: id, name: nameOf(it) };
          if (first && firstNormal) break;
        }
        if (first && firstNormal) break;
      }
      // 普通链目标：推荐项须自身可捐且非排除项才采纳，否则回退首个可捐的非排除项
      var target = null,
        recommended = false,
        recName = '';
      if (recId > 0 && recId !== SCIENCE_SID_EXCLUDE_DONATE) {
        var rec = src.getScienceItemDataByGroupId(recId);
        if (canDon(rec)) {
          target = { id: recId, name: nameOf(rec) };
          recommended = true;
          recName = target.name;
        }
      }
      if (!target && firstNormal) {
        target = { id: firstNormal.scienceId, name: firstNormal.name };
      }
      var a2 = userData().Alliance;
      var cap =
        a2 && typeof a2.getAllianceScienceScore === 'function'
          ? Number(a2.getAllianceScienceScore()) || 0
          : 0;
      return {
        recommendId: recId,
        recommendName: recName,
        dailyHonor: Number(src.donateDailyHonor) || 0,
        honorCap: cap,
        costCoin: Number(src.getCostCoin()) || 0,
        firstDonateable: first,
        donateTarget: target,
        donateRecommended: recommended,
      };
    } catch (e) {
      return null;
    }
  },
  /**
   * 联盟遗迹（要塞，WorldSite）本地态快照：本盟名下要塞（getWorldSiteArrayBy 只筛 Owner.Aid==盟 id）。
   * 可捐口径同游戏红点 checkWorldSiteDonateRedPoint / 弹窗 showBtn 的捐赠分支：
   *   未满级 CurLevel < DistrictData.upper_level_limit 且经验未满 CurExp < relic_upgrade[CurLevel-1]
   *   （升级是官员独立动作，捐赠本身不看 State）。
   * donateTarget：推荐位 recommendSite（即 1070 应答 a.recommend，与 WorldSiteData.Id 同 id 空间）
   *   必须自身命中一个可捐要塞才采纳，否则回退 firstDonateable；两者皆无返回 null。
   * recommendSite 由控制器 instance 维护（登录组装链与每日零点自动发 1070 刷新，此处只读）。
   * 遗迹没有批量捐口径（游戏弹窗只有单捐按钮），故只给目标不给枚数。
   * @returns {object|null} {recommendSite,firstDonateable,relicCostCoin,donateTarget,donateRecommended}；数据源缺失返回 null
   */
  allianceRelic() {
    var src = probe('AllianceWorldSiteController.instance', () => {
      // 该模块是 ES 命名空间具名导出（exports.AllianceWorldSiteController，无 .default），
      // 不能用 ns() 解包（会把壳的 .default 为 undefined 当成解包结果）
      var m = game.get(SYM.modules.worldSiteCtrl);
      var C =
        m &&
        (m.AllianceWorldSiteController || (m.default && m.default.AllianceWorldSiteController));
      // 先读私有 _instance（零副作用）；尚未建立时才走 instance getter 懒建（与游戏自身同一路径）
      var inst = (C && C._instance) || (C && C.instance);
      return inst && typeof inst.recommendSite === 'number' ? inst : null;
    });
    var u = userData();
    if (!src || !u || !u.Alliance || typeof u.getWorldSiteArrayBy !== 'function') return null;
    try {
      var aid = Number(u.Alliance.Aid) || 0;
      if (aid <= 0) return null;
      var sites = u.getWorldSiteArrayBy(aid) || [];
      var recSite = Number(src.recommendSite) || 0;
      var first = null,
        recDonateable = false;
      for (var i = 0; i < sites.length; i++) {
        var s = sites[i];
        var dd = s && s.DistrictData;
        if (!dd || !dd.relic_upgrade) continue;
        var need = Number(String(dd.relic_upgrade).split('|')[Number(s.CurLevel) - 1]) || 0;
        if (Number(s.CurLevel) < Number(dd.upper_level_limit) && Number(s.CurExp) < need) {
          var sid = Number(s.Id) || 0;
          if (!first) first = { siteId: sid, name: String(s.SiteName || s.SiteDefaultName || '') };
          if (recSite > 0 && sid === recSite) recDonateable = true;
        }
      }
      // 两级目标：推荐位须自身可捐才采纳，否则回退首项
      var target = null,
        recommended = false;
      if (recSite > 0 && recDonateable) {
        target = { id: recSite, name: '' };
        recommended = true;
      } else if (first) {
        target = { id: first.siteId, name: first.name };
      }
      var sd = u.Alliance[SYM.dataProps.allianceScience];
      var relicCost =
        sd && typeof sd.getCostCoin === 'function' ? Number(sd.getCostCoin(true)) || 0 : 0;
      return {
        recommendSite: recSite,
        firstDonateable: first,
        relicCostCoin: relicCost,
        donateTarget: target,
        donateRecommended: recommended,
      };
    } catch (e) {
      return null;
    }
  },
  /**
   * 联盟守卫（巨兽，AllianceBehemoth）本地态快照：只读守卫养成数据，产出可捐列表供 feat 逐条判定。
   * 数据由游戏登录/联盟刷新链（UserData.getAllianceBehemothData → 7101）填充，本方法不发包、只读内存。
   * open：功能开启闸（在盟 && FunctionOn(alliance_behemoth) && UserData.behemothIsOpen）；关则不披露 items。
   * items：每项 {behemothId, level, exp, isUnlock, levelCap}，level/exp 取服务端回写的 serverData，
   *   levelCap 取 behemoth_cultivate 表行（level>=levelCap 即满级不可捐）。是否真能捐由 feat
   *   再叠加能量池 13 与升级消耗道具（behemoth_level[level].lvup_cost）判定，这里不做消耗校验。
   * donateReadyAt：入盟捐赠冷却解锁时刻（服务器秒）；> serverTime() 即仍在冷却不可捐（对齐游戏 canDonateAllianceBoss 的
   *   JoinTime+dataConfig(25009) 闸）；配缺/无冷却为 0。
   * @returns {object|null} {open:boolean, items:[{behemothId,level,exp,isUnlock,levelCap}], donateReadyAt:number}；UserData/Alliance 不可用返回 null
   */
  allianceBehemoth() {
    var u = userData();
    var a = u && u.Alliance;
    if (!u || !a || typeof a.isInAlliance !== 'function') return null;
    var inAlliance;
    try {
      inAlliance = !!a.isInAlliance();
    } catch (e) {
      inAlliance = false;
    }
    if (!inAlliance || !gameData.functionOn('alliance_behemoth') || !u.behemothIsOpen) {
      return { open: false, items: [], donateReadyAt: 0 };
    }
    // 入盟捐赠冷却解锁时刻（秒）：服务器对入盟 24h 内的守卫捐献（7102）直接 s=3 拒（d=behemoth_donation_hint1）；游戏捐献面板不预拦，
    //   故本方法暴露解锁点供 feat 发包前自闸。冷却时长口径沿用联盟入盟冷却 DATACONFIG 25009（秒，同机甲 canDonateAllianceBoss 的
    //   `JoinTime + parseInt(getDataConfigData(25009)) > ServerTime`，实证为秒口径）。
    //   配缺/JoinTime 取不到时置 0（视为无冷却，交由 feat 的应答兜底 + 慢查退避，行为不劣于改前）。
    var donateReadyAt = 0;
    try {
      var joinCdSec = parseInt(String(gameConf.dataConfig(25009)), 10) || 0;
      var joinAt = Number(a.JoinTime) || 0;
      if (joinCdSec > 0 && joinAt > 0) donateReadyAt = joinAt + joinCdSec;
    } catch (e) {
      donateReadyAt = 0;
    }
    // 现读、不缓存（同上：a=userData().Alliance 本调用内已实时取，其 behemoth 容器随 push 刷新）
    var src = a && a[SYM.dataProps.allianceBehemoth];
    if (!src || typeof src.getAllianceBehemothData !== 'function')
      return { open: true, items: [], donateReadyAt: donateReadyAt };
    try {
      var map = src.getAllianceBehemothData(); // Map<behemothId, AllianceBehemothItemData>
      var items = [];
      if (map && typeof map.forEach === 'function') {
        map.forEach(function (it) {
          var sd = it && it.serverData;
          if (!sd) return;
          items.push({
            behemothId: Number(sd.behemothId) || 0,
            level: Number(sd.level) || 0,
            exp: Number(sd.exp) || 0,
            isUnlock: !!sd.isUnlock,
            levelCap: (it.cfg && Number(it.cfg.level_cap)) || 0,
          });
        });
      }
      return { open: true, items: items, donateReadyAt: donateReadyAt };
    } catch (e) {
      return { open: true, items: [], donateReadyAt: donateReadyAt };
    }
  },
  /**
   * 功能开关位只读查询（UserData.FunctionOn(FunctionKey 字符串名)，枚举定义在 GameDefine）。
   * 典型用法：捐遗迹前查 Relic_upgrade_time（查不到/未开返回 false，宁可不捐）。
   * @param {string} key FunctionKey 成员名
   * @returns {boolean}
   */
  functionOn(key) {
    var u = userData();
    var gd = probe(SYM.modules.gameDefine, () => ns(game.get(SYM.modules.gameDefine)));
    var k = gd && gd.FunctionKey && gd.FunctionKey[key];
    if (!u || typeof u.FunctionOn !== 'function' || typeof k !== 'string' || !k) return false;
    try {
      return !!u.FunctionOn(k);
    } catch (e) {
      return false;
    }
  },
  /**
   * 功能开关位按「值串」只读查询（口径同游戏 UserData.FunctionOn(MONSTER_GROUP.switch)）。
   * 为何不用 functionOn：GameDefine.FunctionKey 的成员名与值串并不同构（实证 e.WAR_HAMMER_MONSTER="warhammer_monster"），
   *   而配置表 switch 列存的就是**值串**；拿值串走成员名查会恒得到 undefined 而误判「未开」。
   * 三态：FunctionOn 符号缺失/抛错 → 回 null（无从判定），调用方须按「放行」处理——把读不到当未开会误删现役玩法行。
   * @param {string} rawKey FunctionKey 值串（配置表 switch 列原值）；空值=该行走游戏侧的 `!d.switch` 分支、即无闸 → 回 true
   * @returns {boolean|null} true 已开 / false 明确未开 / null 无从判定
   */
  functionOnValue(rawKey) {
    var k = String(rawKey == null ? '' : rawKey).trim();
    if (!k) return true;
    var u = userData();
    if (!u || typeof u.FunctionOn !== 'function') return null;
    try {
      return !!u.FunctionOn(k);
    } catch (e) {
      return null;
    }
  },
  /**
   * 异能兽培育玩法开启闸只读查询（源码锚点 RealEnigmaBeastController 的 isOpenFunc(BeastOpenType.BREED, false)）：
   *   FunctionOn(enigma_beast_breeding) && openState ≥ BeastServerStatus.BREED —— suppressTips 传 false，纯查询不弹提示。
   * 「活动未开始/未解锁」时服务器对 1570/1582/1583/1585 干脆不回包（15s 超时），调用方据此整轮闭嘴；
   *   控制器/枚举符号缺失（subpack 未接管）一律回 false（未证实可开 = 不开，宁不发也不撞超时）。
   * @returns {boolean}
   */
  beastBreedOpen() {
    if (!gameData.functionOn('enigma_beast_breeding')) return false;
    try {
      var m = game.get(SYM.modules.enigmaBeastCtrl);
      var cls = m && (m.default || m);
      var inst = cls && typeof cls.getInstance === 'function' ? cls.getInstance() : null;
      if (!inst || typeof inst.isOpenFunc !== 'function') return false;
      var enumObj = (m && m.BeastOpenType) || (cls && cls.BeastOpenType);
      var breedType = enumObj && enumObj.BREED != null ? Number(enumObj.BREED) : 3; // 兜底实证值：BeastOpenType BREED=3
      return inst.isOpenFunc(breedType, false) === true;
    } catch (e) {
      return false;
    }
  },
  /**
   * 「一键领取 / 集中领取」(TaskRelax) 可用行只读枚举 —— 复刻游戏 TaskRelaxTool.getOpenQuickSweepList 的三级开启闸，
   *   返回空数组即代表该玩家不具备此功能（游戏主城里 bot 入口不会显示），调用方据此整功能挂起。
   * 源码锚点 TaskRelaxTool；报文实证（5684 INFO / 5685 REWARD）。
   *   开启闸（全部只读，不发包、不改写本地数据）：
   *     ① 账号总闸 FunctionOn(task_relax_claim_all)；
   *     ② 服务器灰度闸 serverTransferRange 命中 DataConfig 79089 白名单（缺配=未放量）；
   *     ③ 逐 task_relax 行：Level>=row.level 且该行玩法已解锁（taskRelaxTypeOpen 同口径）。
   * @returns {Array<{id:number,type:number,level:number,order:number}>} 可用行（按 order 升序）；空=功能未开启
   */
  taskRelaxOpenRows() {
    var u = userData();
    if (!u) return [];
    if (!gameData.functionOn('task_relax_claim_all')) return [];
    // 服务器灰度闸：serverTransferRange 必须在 DataConfig 79089 白名单内（缺配 → 空串 split 不含 range → 功能未放量）
    var wl = String(gameConf.dataConfig(TASK_RELAX_RANGE_CFG) || '');
    if (
      wl.split(',').indexOf(String(u.serverTransferRange == null ? '' : u.serverTransferRange)) < 0
    ) {
      return [];
    }
    var rows = l10n.tableRows('task_relax');
    var lv = gameData.level();
    var out = [];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (lv >= Number(r.level) && taskRelaxTypeOpen(r.type)) out.push(r);
    }
    out.sort(function (a, b) {
      return (Number(a.order) || 0) - (Number(b.order) || 0);
    });
    return out;
  },
  /**
   * 能量池快照（UserData.getEnergy(EnergyType数值)，EnergyData 的 Point getter 实时折算自然恢复）。
   * 联盟捐赠次数池实证（抓包）：type=4，pointMax=10，restoreSec=1800（每 30 分钟回 1 点）。
   * @param {number} type EnergyType 数值（如 4=ALLIANCE_DONATE_NUM）
   * @returns {object|null} {point,pointMax,nextRecoverSec}；数据源缺失返回 null
   */
  energy(type) {
    var u = userData();
    if (!u || typeof u.getEnergy !== 'function') return null;
    var e;
    try {
      e = u.getEnergy(+type);
    } catch (err) {
      return null;
    }
    if (!e) return null;
    return {
      point: Number(e.Point) || 0,
      pointMax: Number(e.PointMax) || 0,
      nextRecoverSec: Number(e.NextPointRecoverTime) || 0,
    };
  },
  /** 金币余额（UserData.Resource.Coin）；数据源缺失返回 0 */
  coins() {
    var r = userData() && userData().Resource;
    return r ? Number(r.Coin) || 0 : 0;
  },
  /**
   * 资源余额（UserData.Resource.getResource(resId)，只读）——机械制药配方成本 `resources` 列的口径
   *   （源码锚点 ProductingData.checkItemCanMake：`Resource.getResource(resId) < count` 即缺料）。
   * 与 coins() 的区别是三态语义：这里「读不到」必须与「读到了 0」分开——把读不到当缺料会永久跳过有效配方。
   * 三态：Resource/getResource 不可用或抛错 → null（无从判定，调用方按「放行」处理，最终以服务器拒绝为裁决）；
   *   读数非法或负 → 0。
   * @param {number|string} resId 资源 id
   * @returns {number|null} 余额；null=无从判定
   */
  resourceAmount(resId) {
    var r = userData() && userData().Resource;
    if (!r || typeof r.getResource !== 'function') return null;
    var v;
    try {
      v = r.getResource(+resId);
    } catch (e) {
      return null;
    }
    var n = Number(v);
    return isFinite(n) && n >= 0 ? n : 0;
  },
  /**
   * 钻石总量（纯本地只读，零网络请求）：当前余额（ResourceType.Gold=10）
   *   + 背包「钻石N」道具 Σ 单件货值×持有量（getItemAmount）。
   * 三态：余额读不到 → total=null（UI 显 —，不拿 0 冒充）；背包部分表未就绪/读不到按 0（余额仍如实展示）。
   * @returns {{base:number|null, bag:number, total:number|null}} base=当前余额，bag=背包道具货值，total=两者之和
   */
  diamondTotal() {
    var base = gameData.resourceAmount(RES_DIAMOND);
    var bag = 0;
    var faces = diamondItemFaces();
    if (faces) {
      faces.forEach(function (face, id) {
        bag += face * gameData.itemAmount(id);
      });
    }
    return { base: base, bag: bag, total: base == null ? null : base + bag };
  },
  /**
   * 制药 lane 的已解锁配方 id 清单（读游戏本地缓存 `UserData.ProductingData.getProductData(true).UnlockList`，只读）。
   * 源码锚点 ProductingData：`_PotionData.UnlockList` 返回 `_unlock`，而 `_unlock` 只在收到 1387 应答
   *   （`CommonTools.getProductionFactoryData` → `UpdateProductingData`）时被覆写；该方法**只挂在游戏工厂面板的
   *   `onShow`** 上，故本项在玩家没开过游戏内工厂面板时为空——空数组不等于「未解锁任何配方」，
   *   调用方需自行拿自己的 1387 读数或发起一次探测。
   * 纪律：不调用 `getProductionFactoryData()`（那是发包），只读它写下的缓存。
   * @returns {number[]} 已解锁配方 id（非法项剔除）；符号缺失/抛错 → []
   */
  potionUnlockList() {
    var pd = userData() && userData().ProductingData;
    if (!pd || typeof pd.getProductData !== 'function') return [];
    var data;
    try {
      data = pd.getProductData(true); // true=制药 lane（false 为制造 lane）
    } catch (e) {
      return [];
    }
    var list = data && data.UnlockList;
    if (!Array.isArray(list)) return [];
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var id = Number(list[i]) || 0;
      if (id > 0 && out.indexOf(id) < 0) out.push(id);
    }
    return out;
  },
  /**
   * 次元矿洞矿种规格表（mine_cave）全量行，惰性缓存（配置表页面生命周期内不变）。
   * 行字段实证：`id`(specId)、`type`(矿种)、`level`(矿等级)、`star`(稀有度)、`name`(语言键)、
   * `model`(矿图标)、`hero_color`/`hero_star`/`hero_level`(占领英雄需求串 `数量,门槛|…`)。
   * @returns {Array<{id:number,type:number,level:number,star:number,name:string,model:string,
   *   hero_color:string,hero_star:string,hero_level:string}>} 表未就绪返回 []
   */
  mineSpecs() {
    return (
      probe('mine_cave.specs', () => {
        var rows = l10n.tableRows('mineCave');
        return rows && rows.length ? rows : null;
      }) || []
    );
  },
  /**
   * 单个矿种规格行（按 specId 查，走 mineSpecs 缓存）；查不到返回 null。
   * @param {number|string} specId simpleInfo.specId
   * @returns {object|null}
   */
  mineSpec(specId) {
    var rows = gameData.mineSpecs();
    var sid = Number(specId);
    for (var i = 0; i < rows.length; i++) if (Number(rows[i].id) === sid) return rows[i];
    return null;
  },
  /**
   * 矿洞槽位配置行（mine_cave_level 按 pos 查）：`is_ally`(1=只能分享给盟友采)、`player_level`(解锁门槛)。
   * @param {number|string} pos simpleInfo.pos（1..5）
   * @returns {object|null} 缺行返回 null
   */
  mineSlotPos(pos) {
    return l10n.tableRow('mineCaveLevel', pos);
  },
  /**
   * 矿洞交互配置行（mine_cave_interaction）：id="3" 的 `help_accept` = 单矿可被偷次数上限（报告 §4.2 实证）。
   * @param {number|string} id 交互行 id
   * @returns {object|null}
   */
  mineInteraction(id) {
    return l10n.tableRow('mineCaveInteraction', id);
  },
  /**
   * 可用英雄池（占领矿洞派兵用）：UserData.Heros 中在场且未过期的英雄，对齐游戏
   * HeroController.getHaveHeroList 口径（Is_show===1 且非 ExpireTime 过期）。只读，不改动源。
   * @returns {Array<{id:number,level:number,star:number,quality:number}>} 数据源缺失返回 []
   */
  heroPool() {
    var u = userData();
    var heros = u && u.Heros;
    if (!heros) return [];
    var now = 0;
    try {
      now = +game.get(SYM.modules.dataCenter).DATA.ServerTime || 0;
    } catch (e) {}
    var out = [];
    for (var k in heros) {
      var h = heros[k];
      if (!h || Number(h.Is_show) !== 1) continue;
      if (h.TryOut && Number(h.ExpireTime) > 0 && Number(h.ExpireTime) < now) continue;
      out.push({
        id: Number(h.Id != null ? h.Id : k) || 0,
        level: Number(h.Level) || 0,
        star: Number(h.Star) || 0,
        quality: Number(h.Quality) || 0,
      });
    }
    return out;
  },

  // ─────────────────────── 遗迹奖励领取（只读，供 feats/alliance/relic-reward/index.js） ───────────────────────
  /**
   * 奖励配置 id → 道具清单（只读，经 RewardController.Instance.getRewardsArrById 实时解析，与游戏面板同源）。
   * RewardController 是 ES 命名空间具名导出（exports.RewardController=类，无 .default），故不能 ns() 解包；
   * Instance 是类上的静态单例访问器，getRewardsArrById 为其实例方法。符号缺失/解析失败返回 []。
   * @param {number|string} rewardId 奖励配置 id（如 8301745，即 1825 应答 select[] 里的值）
   * @returns {Array<{type:number,id:number,count:number,name:string}>} 道具清单；不可用返回 []
   */
  rewardItems(rewardId) {
    var C = probe(SYM.modules.rewardCtrl, function () {
      var m = game.get(SYM.modules.rewardCtrl);
      var K = m && (m.RewardController || (m.default && m.default.RewardController));
      return K && K.Instance && typeof K.Instance.getRewardsArrById === 'function' ? K : null;
    });
    if (!C || !C.Instance) return [];
    try {
      var arr = C.Instance.getRewardsArrById(Number(rewardId));
      return Array.isArray(arr) ? arr : [];
    } catch (e) {
      return [];
    }
  },
  /**
   * 本盟指定等级/功能的道具遗迹候选快照（全程零发包，只读合成）。
   * 遗迹清单权威源：UserData.getWorldSiteArrayBy(盟 id)（只筛 Owner.Aid==盟 id，地图/登录时填充，始终可用）；
   * 按 DistrictData.stronghold_level==level && DistrictData.function==funType 过滤（2 级道具= level 2、funType 4=ITEM）。
   * 窗口态（select/have/joinTime/endTime/cfgId）来自 AllianceWorldSiteController.instance.myItemSiteData[wonderId]——
   *   该表仅由游戏自身的 1070/1825 应答填充（脚本直发不经游戏回调、不回写它），故可能缺省/陈旧；缺条目时
   *   select/have 为 undefined、ready=false，调用方（feat）须自行发 1825 拿权威值再判。
   * ready 口径同游戏红点 getItemWorldSiteRed：sp_fortress_item[cfgId].choose_num - have.length > 0 且
   *   ServerTime - joinTime > join_time（入盟冷却）且 otherToday != 1。
   * @param {number} level 要塞等级（2 = 道具遗迹本功能关注）
   * @param {number} funType WorldSiteFunType 数值（4 = ITEM 道具）
   * @returns {Array<{wonderId:number,cfgId:number,name:string,chooseNum:number,joinSec:number,select:Array<number>|undefined,have:Array<number>|undefined,joinTime:number,endTime:number,ready:boolean,leftTimes:number}>}
   */
  relicRewardSites(level, funType) {
    var u = userData();
    if (!u || typeof u.getWorldSiteArrayBy !== 'function') return [];
    var aid = Number(u.Alliance && u.Alliance.Aid) || 0;
    if (aid <= 0) return [];
    var inst = probe('AllianceWorldSiteController.itemInst', function () {
      var m = game.get(SYM.modules.worldSiteCtrl);
      var C =
        m &&
        (m.AllianceWorldSiteController || (m.default && m.default.AllianceWorldSiteController));
      var it = (C && C._instance) || (C && C.instance);
      return it && it.myItemSiteData ? it : null;
    });
    var mine = (inst && inst.myItemSiteData) || {};
    var now = gameData.serverTime();
    var out = [];
    var sites;
    try {
      sites = u.getWorldSiteArrayBy(aid) || [];
    } catch (e) {
      return [];
    }
    for (var i = 0; i < sites.length; i++) {
      var s = sites[i];
      var dd = s && s.DistrictData;
      if (!dd || Number(dd.stronghold_level) !== level || Number(dd.function) !== funType) continue;
      var wonderId = Number(s.Id) || 0;
      if (!wonderId) continue;
      var d = mine[wonderId];
      var cfgId = d ? Number(d.id) || 0 : 0;
      var row = cfgId ? l10n.tableRow('sp_fortress_item', cfgId) : null;
      var chooseNum = row ? Number(row.choose_num) || 0 : 0;
      var joinSec = row ? Number(row.join_time) || 0 : 0;
      var have = d && Array.isArray(d.have) ? d.have : undefined;
      var left = row && have ? chooseNum - have.length : 0;
      var ready =
        !!(row && have && d) &&
        Number(d.otherToday) !== 1 &&
        left > 0 &&
        now - Number(d.joinTime || 0) > joinSec;
      out.push({
        wonderId: wonderId,
        cfgId: cfgId,
        name: String((s && (s.SiteName || s.SiteDefaultName)) || ''),
        chooseNum: chooseNum,
        joinSec: joinSec,
        select: d && Array.isArray(d.select) ? d.select : undefined,
        have: have,
        joinTime: d ? Number(d.joinTime) || 0 : 0,
        endTime: d ? Number(d.endTime) || 0 : 0,
        ready: ready,
        leftTimes: left > 0 ? left : 0,
      });
    }
    return out;
  },
  /**
   * 本人行军名额快照（UserData.myMarchNum 已用 / myMarchNumMAX 上限，服务端跨场景同步、比 mapData.marches 可靠）。
   * 只读、无副作用；数据源缺失回 {used:0,max:0}（上层 freeSlots 据此算 0，不主动拦）。
   * @returns {{used:number, max:number}}
   */
  marchCount() {
    var u = userData();
    if (!u) return { used: 0, max: 0 };
    return { used: Number(u.myMarchNum) || 0, max: Number(u.myMarchNumMAX) || 0 };
  },

  // ── CQ26 印石清剿 ──────────────────────────────────────────────────────
  // 探针实证访问链：CQ26Controller.getInstance() → ctrl; ctrl.clearBossData → cbd
  // getResistance 在 ctrl 上，其余相位/等级/首杀在 cbd 上（需传 lineId）

  /** @returns {object|null} {ctrl, cbd} 控制器实例对；符号漂移时返回 null */
  _cq26() {
    var ctrl = probe('CQ26Controller.inst', () => {
      var m = ns(game.get('CQ26Controller'));
      var C = m && (m.CQ26Controller || m.default);
      return C && C.getInstance ? C.getInstance() : C && C.Instance;
    });
    if (!ctrl) return null;
    var cbd = ctrl.clearBossData || null;
    return { ctrl, cbd };
  },
  /**
   * CQ26 活动是否开启。
   * @returns {boolean}
   */
  cq26IsOpen() {
    var p = this._cq26();
    return !!(p && p.ctrl && p.ctrl.isOpen && p.ctrl.isOpen());
  },

  // ── CQ26 印石·能量补充车队（白须怪清理 CB 线，icon = CQ26CBWorldUIEnergyIcon）──────
  // 世界地图左侧「胶囊+金箭头」icon 的显隐判据（源码 CQ26CBWorldUIEnergyIcon.updateIconShow 逐字）：
  //   isOpen() && OriginServerId===ServerId && clearBossData.canSendWorldEnergy()。
  // canSendWorldEnergy() 返回 _canReplenishMonsterEnergy，由 push 22001 SERIES_FROST_SELF_INFO 的
  //   canReplenishMonsterCleanupEnergy 字段经 updateSelfInfo 写入（领完后服务端立刻推 false 关灯）。
  // 只读投影：本区段只读 cbd 的状态标志，绝不调用其任何 send*/update* 方法（只读+发包红线）。

  /**
   * 能量补充车队 icon 是否「可领取」的内存投影（与玩家眼睛严格同源，零发包）。
   * @returns {boolean|null} true=icon 亮可领；false=icon 灭；**null=符号漂移/cbd 未就绪（无从判定，
   *   调用方须降级为「只信 22001 push」的缓存，不得当 false 而永久不领）**
   */
  cq26EnergySupplyReady() {
    var p = this._cq26();
    var cbd = p && p.cbd;
    if (!cbd || typeof cbd.canSendWorldEnergy !== 'function') return null;
    try {
      return !!cbd.canSendWorldEnergy();
    } catch (_) {
      return null;
    }
  },

  // ── CQ26 雪原列车（印石专列，塔 id=4 = CQ26TOWERID.TRANSPORT）──────────────
  // 探针实证访问链：CQ26Controller.getInstance() → ctrl.transportData（CQ26TransportData 单例）
  // 列车权威时刻只在 2365 应答的 curTrain/lastTrain.baseInfo.times 里（顶层 data.times 实测恒为 []），
  // 故本域不提供「时刻」类 ACL：feat 自己发 2365 取权威，这里只收口「游戏符号知识」两件事——
  // 塔是否已激活（前置闸门）与游戏侧缓存快照（面板展示兜底）。

  /** @returns {object|null} {ctrl, td} 专列塔控制器/数据侧；符号漂移或未建数据回 null */
  _cq26Transport() {
    var p = this._cq26();
    if (!p || !p.ctrl || !p.ctrl.transportData) return null;
    return { ctrl: p.ctrl, td: p.ctrl.transportData };
  },
  /**
   * 专列塔是否已激活（游戏侧 isTowerActivated 口径：预热阶段看 status===COMPLETED，
   * 否则看 progressPercent>=100）。未激活时列车面板入口本身进不去，2365/2367 属无谓请求，
   * 供 feat 作前置闸门；控制器不可用回 false（fail-closed，宁可不发也不撞未知态）。
   * @param {number} [towerId] 塔 id，缺省 4（专列塔）
   * @returns {boolean}
   */
  cq26TransportTowerReady(towerId) {
    var p = this._cq26Transport();
    if (!p || !p.ctrl.isTowerActivated) return false;
    var id = towerId == null ? 4 : Number(towerId) || 4;
    try {
      return !!p.ctrl.isTowerActivated(id);
    } catch (_) {
      return false;
    }
  },
  /**
   * 游戏侧缓存的 2365 快照**投影**（transportData.mainData；列车面板从未打开过时为 null）。
   * 返回新造的标量对象而非游戏对象图：把「只能同帧读」的池化约束变成结构性保证，
   *   避免调用方顺手 await 或把它存进模块态后读到被池复用后的错值（与 feat 侧 readSnapshot 同一口径）。
   * **不得作 feat 判据**（缓存可能是上一窗口的陈旧值），仅供面板展示兜底与离线对照。
   * @returns {{state:number,selfOn:number,userNumber:number,stateEndTime:number,lootNum:number,allLootNum:number,baseRewardGet:number,shareHave:number}|null}
   */
  cq26TrainMainData() {
    var p = this._cq26Transport();
    var md = p && p.td ? p.td.mainData : null;
    if (!md || typeof md !== 'object') return null;
    var ct = md.curTrain || null;
    var bi = (ct && ct.baseInfo) || {};
    // 结算字段属于「主体车」：00:00 后 curTrain 已是今日新车，昨日那辆的结算窗开到 12:00（与 feat 侧 readSnapshot 同一口径）
    var lt = md.lastTrain || null;
    var sl = lt && lt.baseInfo ? lt : ct;
    return {
      state: Number(bi.state) || 0,
      selfOn: Number(ct && ct.selfOn) || 0,
      userNumber: Number(ct && ct.userNumber) || 0,
      stateEndTime: Number(bi.stateEndTime) || 0,
      lootNum: Number(md.lootNum) || 0,
      allLootNum: Number(md.allLootNum) || 0,
      // 结算窗两个闸（报文实证 2365/22096 同名标量字段）：baseRewardGet=1 代表基础奖励已领，
      //   shareHave 是本人**剩余**可翻卡次数（实测每日 3）。
      baseRewardGet: Number(sl && sl.baseRewardGet) || 0,
      shareHave: Number(sl && sl.shareRewardHaveNum) || 0,
    };
  },

  // ── CQ26 战区宝藏（中立城挖掘点 EXCAV：地图实体 311 / marchType 332）────────────
  // 符号实证（CQ26NeutralController）：单例持三个私有数组态——
  //   _excavOpenSiteList（push 22062 全量灌入）/ _claimedSiteIds（push 22063 全量灌入，
  //   服务端持久、跨刷新仍在）/ _selfInfo.mSid（本服服号，来自 push 22001）。
  // 世界地图快捷按钮（NWorldUIActBtnSetting.checkCQ26NeutralExcavShow）的显隐判据就是
  //   getFirstOpenEnableSite() != null，纯客户端推导、零发包 —— 故本域把同一判据投影成标量，
  //   供 feat 做「与玩家眼睛严格一致」的候选源（漏收 22062 时也能自愈）。
  // 全部为只读投影，不改写任何游戏状态（只读+发包红线）。

  /** @returns {object|null} CQ26NeutralController 单例；子包未加载或符号漂移回 null（不缓存失败，下一拍自愈重探） */
  _cq26Neutral() {
    // **只缓存类、每次现取单例**（同 mechaTowerOpen / beastBreedOpen 口径）：
    //   probe 命中即永久返回缓存值，而 ResetGame.purgeData() 里会 `He.default.getInstance().purge()`
    // （实证 ResetGame，He=CQ26NeutralController；purge 内 `t.instance=null`）。
    //   缓存实例的话，跨服/重置流程后 ACL 会一直读那个僵尸对象——返回的是**非 null 陈旧数组**，
    //   于是 feat 侧「投影优先」的分支永占上风，22062 推送缓存这条回落通道被结构性屏蔽（只能刷页自愈）。
    var C = probe('CQ26NeutralController.ctor', () => {
      // 命名形状与 CQ26Controller 相反：本模块**只有 default 导出**（实证 `a.default=E`，无 `a.CQ26NeutralController=`）。
      //   故先查**裸模块**的命名导出、再把 ns() 解包结果当候选：写成 ns(m).CQ26NeutralController || ns(m).default
      //   会两次解包拿到 undefined（类上没有 default），投影会静默恒返 null 而退成「只信 22062」。
      var m = game.get('CQ26NeutralController');
      if (!m) return null;
      return m.CQ26NeutralController || ns(m) || null;
    });
    if (!C) return null;
    try {
      return (C.getInstance ? C.getInstance() : C.Instance) || null;
    } catch (_) {
      return null;
    }
  },
  /**
   * 战区宝藏可发掘点的**标量投影**（读游戏内存，零发包；对齐 22062 载荷字段）。
   * 刻意返回新建普通对象而非游戏对象图：池化/引用外泄是「同帧取值」红线，投影即结构性保证。
   * @returns {Array<{siteId:string,cityId:number,cfgId:number,ownerSid:number,endTime:number,x:number,y:number,k:number,claimed:boolean,ownServer:boolean}>|null}
   *   符号不可用回 null（调用方须降级为「只信 push 通道」，不得当成「没有点」）
   */
  cq26ExcavSites() {
    var inst = this._cq26Neutral();
    var list = inst && inst._excavOpenSiteList;
    if (!Array.isArray(list)) return null;
    var claimed = Array.isArray(inst._claimedSiteIds) ? inst._claimedSiteIds : [];
    var ownSid = (inst._selfInfo && Number(inst._selfInfo.mSid)) || 0;
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var s = list[i] || {};
      var pos = s.pos || {};
      var siteId = s.siteId == null ? '' : String(s.siteId);
      if (!siteId) continue;
      out.push({
        siteId: siteId,
        cityId: Number(s.cityId) || 0,
        // 22062 行里叫 cityConfigId（而地图 901 地块的 m 里叫 cityCfgId），两个名字不能混用
        cfgId: Number(s.cityConfigId != null ? s.cityConfigId : s.cityCfgId) || 0,
        ownerSid: Number(s.ownerSid) || 0,
        endTime: Number(s.endTime) || 0,
        x: Number(pos.x) || 0,
        y: Number(pos.y) || 0,
        k: Number(pos.k) || 0,
        claimed: claimed.indexOf(siteId) >= 0,
        ownServer: ownSid > 0 && Number(s.ownerSid) === ownSid,
      });
    }
    return out;
  },
  /**
   * 游戏侧「宝藏 icon 是否亮着」的权威判据（直接调 getFirstOpenEnableSite，方法名比私有字段抗漂移）。
   * 方法不可用/符号缺失回 null = 未知（**不得**当作 false 用于决策，只作面板展示与交叉校验）。
   * @returns {boolean|null}
   */
  cq26ExcavIconOn() {
    var inst = this._cq26Neutral();
    if (!inst || typeof inst.getFirstOpenEnableSite !== 'function') return null;
    try {
      return !!inst.getFirstOpenEnableSite();
    } catch (_) {
      return null;
    }
  },

  // ── CQ26 印石·中立城商店（霜之密所 CNC Shop：2441~2447 / push 22030）──────────────
  // 货架行来自 ConquerorSession.getTableName(conqueror_2025_cnc_shop) 的**替换后**表名——CQ26 开启时
  // 游戏把它换成 series_frost_cnc_shop（实证 ConquerorSession.initReplaceMap，只换这一张表，
  //   cnc_city_level 两期共用故不换），本投影直用替换后的语义名，因此**只在 CQ26 期有数据**。
  // 行字段实证（CQ25CNCShopItem.onDataChange/onClickBuy 的取值链）：
  //   id / item_id / item_num / need_gold / need_score / buy_limit（本人限买） / buy_limit_all（全服共享库存） / order（显示序）。

  /**
   * 密所货架配置行的**标量投影**：cfgId → 闸门所需字段（纯读配置表，零发包、不改写游戏态）。
   * 刻意返回新造对象而非游戏行：行对象属表缓存、跨帧引用外泄是红线（同 cq26TrainMainData 口径）。
   * `level` 一列**表上并不存在**（逐字核对过 CQ25CNCShopItem/CQ25CNCShopMainNode 的全部取值），
   *   保留此键恒为 0 只为不误导后续读者；城档高低序在 feat 侧按 cityLevelId 现查 cnc_city_level.level。
   * @returns {Object<string,{itemId:number,num:number,gold:number,score:number,limit:number,limitAll:number,order:number,level:number}>|null}
   *   表不可读/无行回 **null**（区分于 `{}`：调用方须按「闸门不可判定」fail-closed，不得当成「没有货」）
   */
  cq26ShopRows() {
    var rows = l10n.tableRows('series_frost_cnc_shop');
    if (!rows || !rows.length) return null;
    var out = {};
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i] || {};
      var cfgId = Number(r.id);
      if (!(cfgId > 0)) continue;
      out[String(cfgId)] = {
        itemId: Number(r.item_id) || 0,
        num: Number(r.item_num) || 0,
        gold: Number(r.need_gold) || 0,
        score: Number(r.need_score) || 0,
        // 本人限购与全服共享库存是两个独立闸：前者按 selfBuyCnt、后者按 buyCnt（售罄口径），不可合并
        limit: Number(r.buy_limit) || 0,
        limitAll: Number(r.buy_limit_all) || 0,
        order: Number(r.order) || 0,
        level: Number(r.level) || 0,
      };
    }
    return Object.keys(out).length ? out : null;
  },

  // ── CQ26 印石·荒芜冰原「星路大地图身份三元组」（NWL 2201 请求参数 + 本服/外服判据的真相源）──
  // 探针实证访问链：CQ26Controller.getInstance()（复用 _cq26() 已得的 ctrl）→
  //   ctrl.selfInfo（push 22001 SERIES_FROST_SELF_INFO 写入，RealCQ26Controller.updateSelfInfo 逐字 `this.selfInfo=e`）、
  //   ctrl.status（updateStatusData 逐字 `this.status=e`；构造默认 `{cid:0,round:0,…}` 即「状态推送尚未达」哨兵值）。
  // 本区段只投影「身份/请求参数」三个符号，**不**投影 2201 应答载荷（grid/wastelandInfo/regions 全是协议字段，feat 直接解析即可；
  //   见 docs/acl-cq26-荒芜冰原.md §5 第四条：身份三元组只收符号、不收数据）。
  // 只读+发包红线：绝不调 `ctrl.mapData.requestData`（那是发包、且会把游戏自己维护的粘滞 `mapData.group` 写坏）。
  // 本人 StrUid 直接用已有 gameData.strUid()，此处**不**新增签名。

  /**
   * 本服在本次星路活动里的分组号与抗性等级（2201 请求 `group` 参数 + canSteal/canHelp 的抗性判据基准）。
   * **每拍现读、不得缓存 group**：`selfInfo.group` 会因 `isRegroupRound` 每轮重排（源码 updateStatusData），
   *   `_cq26()` 缓存的是控制器单例本身，这里每次读其**当前** `selfInfo` 字段，故随推送自愈。
   * 刻意返回新建标量对象、不外泄游戏 `selfInfo` 引用（池化/跨帧红线，同 cq26TrainMainData 口径）。
   * @returns {{group:number, resistanceLevel:number}|null} `selfInfo` 未推达（ctrl 不可用或 selfInfo 缺失）回 **null**
   *   （调用方须 fail-closed 停整腿：null ≠ group 0，拿 0 去发 2201 会指错组）
   */
  cq26StarLandSelf() {
    var p = this._cq26();
    var si = p && p.ctrl ? p.ctrl.selfInfo : null;
    if (!si || typeof si !== 'object') return null;
    return {
      group: Number(si.group) || 0,
      // 逐字源码 getResistance()：`(this.selfInfo?.resistanceLevel) || 0`
      resistanceLevel: Number(si.resistanceLevel) || 0,
    };
  },
  /**
   * 星路活动状态（2201 请求 `cid` 参数 + 盗采窗 `stealBeginTime`/`stealEndTime` 时刻基准）。
   * @returns {{cid:number, round:number, status:number, beginTime:number, endTime:number, stealBeginTime:number, stealEndTime:number}|null}
   *   ctrl 不可用、status 非对象，或 `cid<=0`（构造默认 0 = 状态推送尚未达，拿 0 发不出合法 2201）一律回 **null**（调用方停整腿，不得把 0 当有效副本号）
   */
  cq26StarLandStatus() {
    var p = this._cq26();
    var st = p && p.ctrl ? p.ctrl.status : null;
    if (!st || typeof st !== 'object' || !(Number(st.cid) > 0)) return null;
    return {
      cid: Number(st.cid) || 0,
      round: Number(st.round) || 0,
      status: Number(st.status) || 0,
      beginTime: Number(st.beginTime) || 0,
      endTime: Number(st.endTime) || 0,
      stealBeginTime: Number(st.stealBeginTime) || 0,
      stealEndTime: Number(st.stealEndTime) || 0,
    };
  },
  /**
   * **老家服号**（`UserData.OriginServerId`；源码实证 MsgDisableRuleManager/PabUtils 用它判「本服 vs 跨服」）。
   * 与 901 `m.initSid` / 2201 `mSid` 比较的唯一基准。与 `core/acl/world.js` 的 `selfServerId()`（本图所在服，
   *   登录回包 currk 建立）**不是同一个东西**：跨服进冰原房间时两者不等，而 canSteal/canHelp 用的就是 OriginServerId
   *   —— 拿错则三腿谓词全错（见 docs/acl-cq26-荒芜冰原.md 坑 11）。
   * @returns {number|null} 取不到/非正回 **null**（不得当 0：0 会把所有外服点误判成「本服」，盗采腿全退成协助腿）
   */
  cq26OriginServerId() {
    var u = userData();
    var sid = u && u.OriginServerId;
    return sid != null && Number(sid) > 0 ? Number(sid) : null;
  },

  // ── CQ26 印石·荒芜冰原「额度/分区/配置」只读投影（NWL 22071/22072 快照 + 52000xxx 配置）──
  // 探针实证访问链：CQ26Controller.getInstance() → ctrl.wasteLandData（RealCQ26Controller 构造里
  //   `this.wasteLandData = new CQ26WasteLandData()`，**无条件构造**，故 ctrl 在场即 wld 在场）。
  //   wld.wlInfo ← push 22072（onNWLInfoPush 逐字 `this.wlInfo = e`，登录握手前的初值恒为 null）；
  //   wld.wlList / wlListMap ← push 22071（onNWlListPush 逐字 `this.wlList = e` 后按 wastelandIndex 建 map）。
  // 额度唯一权威就是这份快照：每个写动作（2115/2116）同秒都伴随一份 22072（实录），
  //   游戏自己四个 getter（getRemainStealNum/getRemainHelpNum/getTodayCanGatherTime/getIsGathering）也直读它，
  //   ⇒ feat **零本地记账**。三态纪律：`wlInfo == null` 一律回 null（「还没收到快照」≠「额度用光」），
  //   只有整份快照在场时，个别键缺失才按 0（与游戏 getter 的 `||0` 同构，方向是 fail-closed）。
  // 只读+发包红线：本区段绝不调用 wld 的任何 send*/Update*/Delete* 方法，也不写 wlListMap。

  /**
   * 荒芜冰原数据侧探针（复用 `_cq26()` 已缓存的控制器单例）。
   * `_cq26()` 缓存的是 CQ26Controller 实例本身 —— 该类**无 purge**（与 CQ26NeutralController 相反，
   *   后者被 ResetGame.purgeData() 摘除、缓存即成僵尸），故缓存实例无害；`wasteLandData` 每次现读，
   *   其上的 wlInfo/wlList 随推送整体替换，无需重建视图。
   * @returns {{ctrl:object, wld:object}|null} 符号漂移/子包未加载回 null
   */
  _cq26WasteLand() {
    var p = this._cq26();
    var wld = p && p.ctrl ? p.ctrl.wasteLandData : null;
    if (!wld || typeof wld !== 'object') return null;
    return { ctrl: p.ctrl, wld: wld };
  },
  /**
   * 荒芜冰原额度/阶段快照（22072 push 的游戏内存投影）。
   * @returns {{todayCanGatherTime:number, remainStealNum:number, remainHelpNum:number, remainChestNum:number,
   *            chestDailyLimit:number, isGathering:boolean, curStage:number|null,
   *            curStageEndTime:number|null, elecPower:number}|null}
   *   **快照未达（wlInfo==null）回 null** —— 调用方须本拍跳过该腿并 debug，绝不把 null 当 0 而永久静默；
   *   快照在场时额度类键缺失按 0（同游戏 getter 的 `||0`，方向是 fail-closed 不动作）；
   *   唯独 `curStage` / `curStageEndTime` 缺键回 null（枚举无 0，折成 0 会被读成「已结束」而全停）
   */
  cq26WlInfo() {
    var p = this._cq26WasteLand();
    var wi = p ? p.wld.wlInfo : null;
    if (!wi || typeof wi !== 'object') return null;
    return {
      todayCanGatherTime: Number(wi.todayCanGatherTime) || 0,
      remainStealNum: Number(wi.remainStealNum) || 0,
      remainHelpNum: Number(wi.remainHelpNum) || 0,
      remainChestNum: Math.max(0, Number(wi.remainChestNum) || 0),
      // 逐字源码 getChestDailyLimit()：`Math.max(0, +getDataConfigData(52000426) || 0)`
      chestDailyLimit: Math.max(0, Number(gameConf.dataConfig(52000426)) || 0),
      isGathering: wi.isGathering === 1,
      // 枚举 CQ26WLStatus 没有 0，而游戏 onNWLInfoPush 是**整体替换** wlInfo（`this.wlInfo = e`）：
      //   推送缺 curStage 键时 `||0` 会被读成「已结束」，故缺键一律回 null（无从判定）。
      curStage: wi.curStage == null ? null : Number(wi.curStage),
      curStageEndTime: wi.curStageEndTime == null ? null : Number(wi.curStageEndTime),
      elecPower: Number(wi.elecPower) || 0,
    };
  },
  /**
   * 16 个分区状态全量（22071 push 的 `wastelandList` 投影，逐条新建对象、不外泄报文孪生体）。
   * @returns {Array<{index:number, status:number, type:number, condition:number, endTime:number}>|null}
   *   快照未达（wlList==null 或列表为空）回 **null**（= 未知，调用方不得当成「没有分区」）
   */
  cq26WlLands() {
    var p = this._cq26WasteLand();
    var list = p && p.wld.wlList ? p.wld.wlList.wastelandList : null;
    if (!Array.isArray(list) || !list.length) return null;
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var r = list[i] || {};
      out.push({
        index: Number(r.wastelandIndex) || 0,
        status: Number(r.status) || 0,
        type: Number(r.wastelandType) || 0,
        condition: Number(r.wastelandCondition) || 0,
        endTime: Number(r.endTime) || 0,
      });
    }
    return out;
  },
  /**
   * 单分区快取（本服侧 `checkWlOpening` 的同源判据：status===4 才可动，游戏侧严格比 OPENING）。
   * 走游戏自己维护的 `wlListMap`（以 wastelandIndex 为键），O(1)。
   * @param {number} index 分区号（= 2114 的 wastelandIndex = 901 m.specIndex）
   * @returns {{index:number, status:number, type:number, opening:boolean}|null} 快照未达/该 index 无行回 **null**
   */
  cq26WlLand(index) {
    var p = this._cq26WasteLand();
    var map = p ? p.wld.wlListMap : null;
    var idx = Number(index) || 0;
    var r = map && map[idx];
    if (!r || typeof r !== 'object') return null;
    var status = Number(r.status) || 0;
    return {
      index: idx,
      status: status,
      type: Number(r.wastelandType) || 0,
      // CQ26WLLandStatus.OPENING = 4（源码 CQ26Common 枚举，实测 checkWlOpening 只认这一个值）
      opening: status === 4,
    };
  },
  /**
   * 遗失之箱点位快照（push 22077 `NWL_WASTELAND_CHEST_POS_PUSH` 的游戏内存投影）。
   * 读**私有字段本体** `_WlBossRwardPBDataPos` 而不是同名 getter：getter 逐字写作
   *   `this._WlBossRwardPBDataPos || []`，于是「快照尚未达（构造默认 `null`）」与「快照在场且为空
   *   （本人已把当日快照里的点开完）」在 getter 出口塌成同一个 `[]` —— 后者是「本轮无事」的正常态、
   *   前者是「未知」，feat 必须分得开（把未知读成空集 = 当天再不动作）。
   * 私有字段名漂移（读到 `undefined`，与显式 `null` 不是一回事）时才回落 getter，
   *   而 getter 给出的 `[]` 在这条路上无法归因 ⇒ 一律回 null，让调用方走自己订阅 22077 的标量副本。
   * 只读+发包红线：本投影只读数组、绝不触碰 wld 的 sendGetOpenedChestList/getOpenedChestSta（后者未 loaded
   *   时**顺手发一条 2119** 并返回 true，是 UI 的保守策略，自动化照抄会永久漏开第一个宝箱）。
   * @returns {Array<{x:number,y:number,k:number}>|null} 快照未达/符号不可用回 **null**；`[]` = 快照在场且无未开点
   */
  cq26WlChestPos() {
    var p = this._cq26WasteLand();
    if (!p) return null;
    var raw = p.wld._WlBossRwardPBDataPos;
    if (raw === undefined) {
      raw = p.wld.wlBossRewardPos;
      // getter 路径上 `[]` 既可能是「未达」也可能是「已开完」，不可归因 ⇒ 当未知处理
      if (!Array.isArray(raw) || !raw.length) return null;
    } else if (raw === null) {
      return null;
    } else if (!Array.isArray(raw)) {
      return null;
    }
    var out = [];
    for (var i = 0; i < raw.length; i++) {
      var r = raw[i] || {};
      // 报文实证 22077 行**只有** x/y/k 三键（无 wastelandIndex）：k=房间号，与分区号不是 1:1
      //   （实证：`2120{9}` 的锚点 k 与同房间 315 地块的 `m.specIndex=11` 不等）⇒ 分区号只能取地块 `m.specIndex`，
      //   由 feats/cq26/wl-chest/index.js 经 901/10018 嗅探与定向单窗查询获得，本投影只如实给出三键。
      out.push({ x: Number(r.x) || 0, y: Number(r.y) || 0, k: Number(r.k) || 0 });
    }
    return out;
  },
  /**
   * 荒芜冰原配置读数（`TableUtils.getDataConfigData`，52000363/364/367/372/426 之类）。
   * 分隔符实为 `'|'`（源码 getMiniGameRewardMultipliers 用 `split(/[|,]/)`，历史踩坑是 split(',')
   *   把多段值整串 parseInt 成首段之外的小值），故取首段并按 `|`、`,` 双分符兼容。
   * @param {number} id 配置号
   * @returns {number|null} 模块不可读/缺配/非数值一律 **null**（调用方 fail-closed：谓词无法求值时停整腿，
   *   不得用硬编码秒数兜底 —— 尤其 52000367「单次采集成熟秒」无法从报文反推）
   */
  cq26WlConf(id) {
    var raw;
    try {
      raw = gameConf.dataConfig(id);
    } catch (e) {
      return null;
    }
    if (raw == null || raw === '') return null;
    var n = Number(String(raw).split(/[|,]/)[0]);
    return isFinite(n) ? n : null;
  },
  /**
   * 采集点资源投影（RESOURCE 表，主键 = 901 `m.itemId`）。
   * 源码锚点 `CQ26WLWorldGatherPop.onShow`：`TABLE.getTableDataById(TableName.RESOURCE, String(extData.itemId||0))`。
   * 之所以需要它：`m` 块**不带** `gatherSpeed`（游戏弹窗读 `extData.gatherSpeed` 时仍以
   *   `Math.floor(3600 * cfg.gather_speed)` 兜底），采集腿按速率择优必须回表。
   * @param {number|string} itemId 点的 `m.itemId`
   * @returns {{itemId:number, level:number, gatherSpeed:number, resourceType:number}|null} 表不可读/无行回 null
   */
  cq26WlResource(itemId) {
    var id = Number(itemId) || 0;
    if (!id) return null;
    // 刻意不返回行对象本体（表缓存跨帧引用外泄红线），只投影用到的四列
    var r = l10n.tableRow('RESOURCE', id);
    if (!r) return null;
    return {
      itemId: id,
      level: Number(r.level) || 0,
      // 游戏弹窗口径：gather_speed 是「每小时速率」的分数形态，×3600 取整
      gatherSpeed: Math.floor(3600 * (Number(r.gather_speed) || 0)),
      resourceType: Number(r.resource_type) || 0,
    };
  },

  // ── CQ26 印石·巨兽盛宴（BWL 线，push 22032 阶段机 + 22073 玩家快照）──────────────
  // 探针实证访问链：CQ26Controller.getInstance()（复用 `_cq26()`）→ ctrl.beastData
  //   （RealCQ26Controller 构造逐字 `this.beastData = new CQ26BeastData()`，**无条件构造**，故 ctrl 在场即 bd 在场）。
  //   bd.feastPhase ← push 22032（CQ26Response Handler 逐字 `beastData.feastPhase = o.feastPhase`，构造初值 null）；
  //   bd.myFeastInfo ← push 22073（updateMyBattleBeastFeastInfo 逐字 `this._myFeastInfo = e.player`）；
  //   bd.bwlPos ← resp 2101（requestBattleBeastMainInfo 逐字 `i.pos && (t._bwlPos = i.pos)`）。
  // 只读+发包红线：本区段只读 bd/techData 的标量投影，绝不调用其任何 send*/update*/request* 方法。

  /**
   * 巨兽盛宴数据侧探针（复用 `_cq26()` 已缓存的控制器单例；CQ26Controller 无 purge，缓存实例无害，
   *   同 `_cq26WasteLand` 口径；beastData 每次现读，其上的快照随推送整体替换）。
   * @returns {{ctrl:object, bd:object}|null} 符号漂移/子包未加载回 null
   */
  _cq26Beast() {
    var p = this._cq26();
    var bd = p && p.ctrl ? p.ctrl.beastData : null;
    if (!bd || typeof bd !== 'object') return null;
    return { ctrl: p.ctrl, bd: bd };
  },
  /**
   * 盛宴阶段快照（push 22032 的游戏内存投影；阶段机 CQ26BeastFeastPhase NONE=0/GATHER=1/FEED=2/SHOW=3/END=4）。
   * 刻意返回新建标量对象、不外泄游戏 feastPhase 引用（池化/跨帧红线，同 cq26TrainMainData 口径）。
   * @returns {{state:number,gatherTime:number,beginTime:number,endTime:number,displayEndTime:number}|null}
   *   **快照未达（feastPhase==null）回 null** —— 调用方须本拍跳过并 debug，绝不把 null 当 NONE 而永久静默；
   *   快照在场时 state 缺键按 0（=NONE，各阶段闸都不认，方向 fail-closed）
   */
  cq26FeastPhase() {
    var p = this._cq26Beast();
    var fp = p ? p.bd.feastPhase : null;
    if (!fp || typeof fp !== 'object') return null;
    return {
      state: Number(fp.state) || 0,
      // 时间戳量纲（<2^53），裸数字/Long 形态统一走 bits 兜底（同 cq26ArkState.endTimeSec 口径）
      gatherTime: bits.int64ToNum(fp.gatherTime),
      beginTime: bits.int64ToNum(fp.beginTime),
      endTime: bits.int64ToNum(fp.endTime),
      displayEndTime: bits.int64ToNum(fp.displayEndTime),
    };
  },
  /**
   * 盛宴玩家快照（push 22073 `player` 的游戏内存投影：礼盒/密礼额度与已领列表）。
   * @returns {{giftCount:number,blue:number,feedCount:number,claimedIndexList:number[],secretGiftCount:number}|null}
   *   快照未达（myFeastInfo==null）回 **null**（调用方本拍跳过）；快照在场时缺键按 0/空表
   *   （同游戏 hasGetBattleBeastGiftBox 的 `claimedIndexList?.includes ?? false` 口径）
   */
  cq26FeastPlayer() {
    var p = this._cq26Beast();
    var mi = p ? p.bd.myFeastInfo : null;
    if (!mi || typeof mi !== 'object') return null;
    var list = Array.isArray(mi.claimedIndexList) ? mi.claimedIndexList : [];
    return {
      giftCount: Number(mi.giftCount) || 0,
      blue: Number(mi.blue) || 0,
      feedCount: Number(mi.feedCount) || 0,
      claimedIndexList: list.map(function (v) {
        return Number(v) || 0;
      }),
      secretGiftCount: Number(mi.secretGiftCount) || 0,
    };
  },
  /**
   * 巨兽（BWL）锚点坐标（resp 2101 `pos` 的游戏内存投影；定向 901 窗心与 2101 补读用）。
   * @returns {{x:number,y:number,k:number}|null} 未达/坐标非正回 **null**（调用方须先补读一发 2101，不得拿 0 窗心发包）
   */
  cq26BwlPos() {
    var p = this._cq26Beast();
    var pos = p ? p.bd.bwlPos : null;
    if (!pos || typeof pos !== 'object') return null;
    var x = Number(pos.x) || 0;
    var y = Number(pos.y) || 0;
    if (!(x > 0) || !(y > 0)) return null;
    return { x: x, y: y, k: Number(pos.k) || 0 };
  },
  /**
   * 个人科技派系（`techData.getFaction()` 只读投影；源码逐字 `this._faction || CQ26TechFaction.NONE`）。
   * 礼盒腿前置闸：NONE=0 = 未加入派系（游戏此时弹派系选择面板，自动化不代选）。
   * @returns {number|null} 0=NONE 未加入；正数=派系枚举；符号不可用回 **null**（未知≠未加入，调用方本拍跳过）
   */
  cq26Faction() {
    var p = this._cq26();
    var td = p && p.ctrl ? p.ctrl.techData : null;
    if (!td || typeof td.getFaction !== 'function') return null;
    try {
      var f = td.getFaction();
      return f == null ? null : Number(f) || 0;
    } catch (_) {
      return null;
    }
  },
  /**
   * 冰原/盛宴配置**全段**读数（`TableUtils.getDataConfigData` 按 `|`/`,` 拆成数值数组）。
   * 与 cq26WlConf（只取首段）的差异：52000359 是**逐冰等级火种消耗数组**，只取首段会把高等级冰
   *   全按 1 级消耗求值 ⇒ 预算闸失守。任一段非数值即整体回 null（fail-closed，宁停腿不猜）。
   * @param {number} id 配置号
   * @returns {number[]|null} 模块不可读/缺配/任一段非数值回 **null**（调用方停整腿）
   */
  cq26WlConfList(id) {
    var raw;
    try {
      raw = gameConf.dataConfig(id);
    } catch (e) {
      return null;
    }
    if (raw == null || raw === '') return null;
    var parts = String(raw).split(/[|,]/);
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var n = Number(parts[i]);
      if (!isFinite(n)) return null;
      out.push(n);
    }
    return out.length ? out : null;
  },

  // ── CQ26 印石·猛犸突袭（防守 BOSS 线，塔 id=2 = CQ26TOWERID.DEFENSE_BOSS）──────
  // 探针实证访问链：CQ26Controller.getInstance()（复用 `_cq26()`）→ ctrl.info（应答 22002
  //   SERIES_FROST_INIT 的 initInfoData → updateInfoData 逐字 `this.info = e.info`；push 22031 的
  //   updateTempInfo 只增量合并 `e.towerInfoList`，故整份 info 一旦达即持续可读）。
  // 只读+发包红线：本区段只读 info/配置表，绝不调 ctrl / defenseBossData 的任何 send*/update* 方法。

  /**
   * 猛犸突袭 BOSS 落点（游戏侧派兵按钮 `getTowerPos(CQ26TOWERID.DEFENSE_BOSS)` 的只读投影，零发包）。
   * 源码锚点 CQ26DBTroopsInfoPanel.onFightClick 与 RealCQ26Controller.getTowerInfo/getTowerPos 逐字同构：
   *   遍历 `info.towerInfoList` 取 `towerId` 命中条目的 `pos`。
   * 报文实证 dashcam-rec-2026110*-印石-我的日常.ndjson：22002 应答
   *   `towerInfoList[{towerId:2,sfBid:1002,pos:{x:378,y:478}}]`，与同场 902（marchType=308）派兵的
   *   `x:378,y:478` 完全吻合 —— 坐标可纯报文/纯内存取得，无需摸 UI。
   * @param {number} [towerId] 塔 id，缺省 2（防守 BOSS 塔）
   * @returns {{x:number,y:number}|null} 控制器/info/towerInfoList 不可用、无该塔、或 pos 非正一律回
   *   **null**（调用方 fail-closed 不派兵：坐标 0 发 902 只会撞未知拒绝并白占队列）
   */
  cq26DbTowerPos(towerId) {
    var p = this._cq26();
    var info = p && p.ctrl ? p.ctrl.info : null;
    var list = info ? info.towerInfoList : null;
    if (!Array.isArray(list)) return null;
    var id = towerId == null ? 2 : Number(towerId) || 2;
    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      if (!t || Number(t.towerId) !== id) continue;
      var pos = t.pos;
      if (!pos || typeof pos !== 'object') return null;
      var x = Number(pos.x) || 0;
      var y = Number(pos.y) || 0;
      // 刻意新建标量对象、不外泄游戏 pos 引用（池化/跨帧红线，同 cq26StarLandSelf 口径）
      return x > 0 && y > 0 ? { x: x, y: y } : null;
    }
    return null;
  },
  /**
   * 猛犸突袭「波次奖励」配置行投影（`series_frost_monsterReward`，只取 id/wave 两列）。
   * 源码锚点 CQ26DBMainRewardCell.sendToGetReward 逐字：整表遍历，`wave>0 && wave<=selfServerDefWave &&
   *   selfGainWaveRewardSpecIdList.indexOf(id)<0` 者入 2178 的 `waveRewardSpecIdList`（一次打包全领，
   *   报文实证 dashcam 11-08 21:52 一条 2178 领走 [3001..3007]）。
   * @returns {Array<{id:number,wave:number}>|null} 表不可读/空表/全行 wave<=0 回 **null**
   *   （调用方 fail-closed 不领奖：拿不到门槛就凑不出 id 列表，硬发只会撞服务器拒绝）
   */
  cq26DbWaveRewardRows() {
    var rows = l10n.tableRows('series_frost_monsterReward');
    if (!rows || !rows.length) return null;
    var out = [];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i] || {};
      var id = Number(r.id) || 0;
      var wave = Number(r.wave) || 0;
      // 游戏循环里的 `wave > 0` 是硬闸（initScoreReward 同样只渲染 wave>0 的行），非正门槛行不存在奖励
      if (!(id > 0) || !(wave > 0)) continue;
      out.push({ id: id, wave: wave });
    }
    return out.length ? out : null;
  },

  // ── CQ26 印石·保卫能量（方舟试炼 ARK_TRIAL，塔 id=3 = CQ26TOWERID.ARK）──────
  // 探针实证访问链：CQ26Controller.getInstance()（复用 `_cq26()`）→ ctrl.arkData。
  //   源码 CQ26ArkData.updateData 逐字 `this.data = e.arkData; this.cid = e.cid` —— 内存本体就是
  //   最近一帧 22007 push 的副本（游戏网络层代收），本投影只作 feat 中途启用时的「引导快照」。
  // 只读+发包红线：只读 arkData.data/cid 标量，绝不调其任何 send*/update* 方法。

  /**
   * 方舟试炼运行时状态投影（零发包；数据源与 22007 push 同源）。
   * 报文实证 dashcam-rec-20261111T041102-印石-我的日常.ndjson：22007 push
   *   `{cid:2, towerId:3, arkData:{status:2, beginTimeSec, endTimeSec, round:0, maxRound:20, arkArmyRed:true, cfgId:2}}`。
   * @returns {{cid:number,status:number,round:number,maxRound:number,armyRed:boolean,endTimeSec:number}|null}
   *   控制器/arkData/data 不可用回 **null**（调用方只认自订 push；两路皆空不得派 902-306 写请求，
   *   绝不拿臆测阶段状态发兵）
   */
  cq26ArkState() {
    var p = this._cq26();
    var ad = p && p.ctrl ? p.ctrl.arkData : null;
    var d = ad ? ad.data : null;
    if (!d || typeof d !== 'object') return null;
    // 刻意新建标量对象、不外泄游戏 data 引用（池化/跨帧红线，同 cq26DbTowerPos 口径）
    return {
      cid: Number(ad.cid) || 0,
      status: Number(d.status) || 0,
      round: Number(d.round) || 0,
      maxRound: Number(d.maxRound) || 0,
      armyRed: !!d.arkArmyRed,
      // endTimeSec 报文/内存可能是裸数字或 Long 形态，统一走 bits 兜底（时间戳量纲，值域 <2^53）
      endTimeSec: bits.int64ToNum(d.endTimeSec),
    };
  },

  // coinState 快照能力已迁 feats/player/auto-coin-collect/api.js（领域算法下沉，单消费方）
};

// cq26NeutralCtrl 住在共享区段：经引擎插槽注册给 CAPS.cq26NeutralCtrl（引擎不反向 import 本文件），
//   供 feats/cq26/excav/index.js 在安装期自检该控制器单例是否在场（拿不到则降级为「只信 22062/22063 推送」）。
setSharedCapsProbe('cq26NeutralCtrl', () => gameData._cq26Neutral());
// 荒芜冰原数据侧（遗失之箱/采集/巨兽共同依赖的 wasteLandData 单例）：同为软依赖能力键，
//   取不到只让 feat 降级为「只信自订 push 的标量副本」，不阻断安装（feat 声明 'cq26WasteLand?'）。
setSharedCapsProbe('cq26WasteLand', () => gameData._cq26WasteLand());
// 能量补充车队数据侧（clearBossData.canSendWorldEnergy 的宿主）：同为软依赖能力键（feat 声明
//   'cq26ClearBoss?'），取不到只让 feat 降级为「只信 22001 push 的标量」，不阻断安装（同 cq26WasteLand 口径）。
setSharedCapsProbe('cq26ClearBoss', () => {
  var p = gameData._cq26();
  var cbd = p && p.cbd;
  return cbd && typeof cbd.canSendWorldEnergy === 'function' ? cbd : null;
});

// ─────────────────────── 战斗预设 / 头像 → core/acl/{battle-preset,avatar}.js（片4，见文件头 import 与 re-export） ───────────────────────

export const gameConf = {
  /**
   * 配置数据表值（TableUtils.getDataConfigData；配置 id → 字符串/数值）。
   * @param {number} id 配置 id（如撤回时限 630061）
   * @returns {string|number} 模块不可用/未命中返回 ''
   */
  dataConfig(id) {
    var tu = probe(SYM.modules.tableUtils + '.getDataConfigData', () => {
      // TableUtils 为 TS 转译的 ES 命名空间（getDataConfigData 挂在 .default 下），用 ns 解包，
      // 否则取到的是命名空间壳、方法恒 undefined → 探测失败、DataConfig 读取降级（实测踩过）。
      var m = ns(game.get(SYM.modules.tableUtils));
      return m && typeof m.getDataConfigData === 'function' ? m : null;
    });
    if (!tu) return '';
    try {
      return tu.getDataConfigData(+id) || '';
    } catch (e) {
      return '';
    }
  },
};
