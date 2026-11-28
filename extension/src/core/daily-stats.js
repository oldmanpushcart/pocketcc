/**
 * 当日次数统计公共原语（14 feat 日账口径定稿的下沉件）：
 *   createDailyLedger(name, opts) —— 每 feat 一本「当日日账」{date, counts, seen}，
 *   懒加载 + 跳日归零 + loaded 闸门防内存 0 覆盘 + 读回前增量补算（范式收口自
 *   auto-hunt dailyState / ally-rally dailyState，落盘单飞/看门狗不再自建——
 *   storage.data.set 已按 blob 串行队列落盘，队列尾那笔即最终值）。
 *
 * 口径（与用户定稿一致）：
 *   - 额度类 feat 读服务器权威值（含手动），不进日账；日账只服务「动作类计脚本 / 行军类计奖励到账」。
 *   - 日界：服务器秒按本地时区格式化（todayStr(serverTime)）；国服 UTC+8 与游戏日界
 *     （SystemZeroTime 0 点，GAME_DAY_RESET_OFFSET=57600）对齐；服务器时刻缺失回退本地时钟。
 *   - 邮件/到账去重：countOnce(id, key) 按 id 串去重，seen 随日账落盘（跨页重载不重计），
 *     key 可传数组（同一去重事件计多个计数器，如到账总+分类型），跳日连 seen 一并清
 *     （新的一天旧 id 不再参与去重，同 cs-hunt lastId 口径）。
 *   - 面板文案：有分母「已完成 x/y」（分子=已完成，不得用剩余量拼），无分母「今日 N 次」，
 *     纯函数 dailyText 收口；未读回前展示 '—'（不谎报 0）。
 *
 * 实证来源：dashcam store 全量扫描（.reviewtmp/daily-mail-probe*.mjs）——
 *   10264 PUSH_SINGLE_MAIL 实时推海上/领域/母舰三类奖励邮件（标题字面见各 feat）；
 *   花车拾取奖励不走 3416 邮件，走 21653 FLOAT_PARADE_REWARD_LUCKY_BAG（synType=2 增量，
 *   rewardedLuckyBags 的 key 与 8852 marchIdStr 100% 对应，可归花车类型；synType=1 全量须避开）。
 *
 * 分层：core 原语，feats 只 import 本件不互引；依赖 storage/log/bus/util/game-api 均为 core 内合法方向。
 */
import { storage } from './storage.js';
import { createLog } from './log.js';
import { bus, EVT } from './bus.js';
import { todayStr } from './util.js';
import { gameData } from './game-api.js';

/** @type {ReturnType<createLog>} 模块日志器（tag=DAILY） */
const log = createLog('DAILY');

/** @type {number} seen 去重环默认容量（单 feat 单日到账事件量级 << 此值；超出挤掉最旧，极端刷屏下最坏重计一条） */
const DEFAULT_SEEN_CAP = 256;

/**
 * 当前日账日界键：优先服务器秒（国服与游戏 0 点日界对齐），缺失回退本地时钟。
 * @returns {string} YYYY-MM-DD
 */
function dayKey() {
  var sec = gameData.serverTime();
  return sec ? todayStr(sec) : todayStr();
}

/**
 * 面板进度文案（纯函数）：有分母「已完成 x/y」，无分母「今日 N 次」。
 * 分子钳进 [0, limit]：既不为负、也不冒出「已完成 6/5」（权威值偶发超限时如实钳位）。
 * @param {number} done 已完成次数
 * @param {number} [limit] 上限；<=0/缺省 = 无分母
 * @returns {string}
 */
export function dailyText(done, limit) {
  var n = Math.max(0, Number(done) || 0);
  var l = Number(limit) || 0;
  if (l <= 0) return '今日 ' + n + ' 次';
  return '已完成 ' + Math.min(l, n) + '/' + l;
}

/**
 * @typedef {object} DailyLedger
 * @property {function():void} ensureLoaded 踢懒加载（已载则顺带跳日检查）；bump/countOnce 内部自动踢，feat 也可在 install 时预热
 * @property {function():boolean} loaded 日账是否已读回（未读回前面板应显示 '—' 而非 0）
 * @property {function(string, number=):number} bump 计一次（可带增量）；返回该 key 当前值
 * @property {function(string):number} get 读某 key 当日计数（未读回返回 0）
 * @property {function():Object<string,number>} counts 当日计数浅拷贝（面板/日志用）
 * @property {function(string, string|string[], number=):boolean} countOnce 按 id 去重计一次（邮件/到账通道用）；id 已见过返回 false 不计；key 可数组（同事件计多键）
 */

/**
 * 创建一本当日日账（模块级单例使用：feat 顶层 create 一次，跨 pause/resume 保留）。
 * @param {string} name storage.data 逻辑键（建议 'pocketcc.daily.<featId>'）
 * @param {object} [opts] 选项
 * @param {number} [opts.seenCap] seen 去重环容量；缺省 256；传 0 禁用 seen（countOnce 退化为纯内存去重不落盘）
 * @returns {DailyLedger}
 */
export function createDailyLedger(name, opts) {
  var seenCap = opts && opts.seenCap != null ? Math.max(0, opts.seenCap | 0) : DEFAULT_SEEN_CAP;
  /** @type {{date:string, counts:Object<string,number>, seen:string[]}} 内存镜像 */
  var state = { date: '', counts: Object.create(null), seen: [] };
  /** @type {Set<string>} seen 的查询索引（与 state.seen 环同步） */
  var seenSet = new Set();
  /** @type {boolean} 是否已读回（未读回前绝不落盘，防内存 0 覆盘上真值） */
  var loaded = false;
  /** @type {boolean} 在途读单飞闸门 */
  var loading = false;
  /** @type {Array<{key:string, n:number}>} 读回前已发生的 bump（读回时补算，防少计） */
  var preBumps = [];
  /** @type {Array<{id:string, key:string, n:number}>} 读回前已发生的 countOnce（读回时与盘上 seen 对账，防重计） */
  var preOnce = [];

  /** 推一次面板刷新（inlineStatus 只读行重算） */
  function pokePanel() {
    bus.emit(EVT.UI_REFRESH);
  }

  /** 跳日归零：已读回且日界键变化则清 counts/seen 并落盘（未读回不动，避免半截态）。 */
  function roll() {
    if (!loaded) return;
    var today = dayKey();
    if (state.date === today) return;
    state.date = today;
    state.counts = Object.create(null);
    state.seen = [];
    seenSet = new Set();
    persist();
  }

  /** 落盘当前快照（未读回绝不写）；串行队列保证尾笔即最终值，失败 warn 不阻断计数。 */
  function persist() {
    if (!loaded) return;
    var snapshot = {
      date: state.date,
      counts: Object.assign({}, state.counts),
      seen: state.seen.slice(),
    };
    Promise.resolve(storage.data.set(name, snapshot)).catch(function (err) {
      log.warn('%s save failed. %s', name, err && err.message);
    });
  }

  /** seen 环入册（超容量挤掉最旧） */
  function seenPush(id) {
    if (seenCap <= 0) return;
    state.seen.push(id);
    if (state.seen.length > seenCap) {
      var old = state.seen.shift();
      seenSet.delete(old);
    }
  }

  /**
   * 异步读回日账：盘值 + 读回前增量补算 + countOnce 对账。
   * 读失败不置 loaded（读不到 ≠ 盘上没数据），复位在途闸门留待下次重试。
   */
  function ensureLoaded() {
    if (loaded) {
      roll();
      return;
    }
    if (loading) return;
    loading = true;
    Promise.resolve(storage.data.get(name))
      .then(function (saved) {
        loaded = true;
        loading = false;
        var diskCounts = Object.create(null);
        var diskSeen = [];
        if (saved && typeof saved === 'object' && typeof saved.date === 'string') {
          if (saved.counts && typeof saved.counts === 'object') {
            for (var k in saved.counts) diskCounts[k] = Number(saved.counts[k]) || 0;
          }
          if (Array.isArray(saved.seen)) diskSeen = saved.seen.map(String);
        }
        var today = dayKey();
        if (saved && saved.date === today) {
          state.counts = diskCounts;
          state.seen = diskSeen.slice(-seenCap);
        } else {
          state.counts = Object.create(null);
          state.seen = [];
        }
        state.date = today;
        seenSet = new Set(state.seen);
        // 读回前增量补算（loaded 前置闸门使读回前永不写盘，内存增量必不在盘上，相加不重复）
        for (var i = 0; i < preBumps.length; i++) {
          var b = preBumps[i];
          state.counts[b.key] = (state.counts[b.key] || 0) + b.n;
        }
        // countOnce 对账：读回前已计、但盘上 seen 早已见过的 id（跨页重推）回抵，防重计
        var diskSeenSet = new Set(diskSeen);
        for (var j = 0; j < preOnce.length; j++) {
          var p = preOnce[j];
          if (diskSeenSet.has(p.id)) {
            state.counts[p.key] = Math.max(0, (state.counts[p.key] || 0) - p.n);
          }
        }
        preBumps = [];
        preOnce = [];
        persist();
        pokePanel();
      })
      .catch(function (err) {
        loading = false;
        log.warn('%s load failed, retry next. %s', name, err && err.message);
      });
  }

  /**
   * 计一次（动作类：脚本成功动作收口处调）。
   * @param {string} key 计数键（feat 内自定义，如 'coin'/'accel520001'）
   * @param {number} [n] 增量（缺省 1；<=0 忽略）
   * @returns {number} 该 key 当前当日值
   */
  function bump(key, n) {
    var inc = n == null ? 1 : Number(n) || 0;
    if (inc <= 0) return get(key);
    ensureLoaded();
    state.counts[key] = (state.counts[key] || 0) + inc;
    if (loaded) persist();
    else preBumps.push({ key: key, n: inc });
    pokePanel();
    return state.counts[key];
  }

  /**
   * 按 id 去重计一次（行军类：奖励到账通道收口处调，id=邮件 id / marchId / 箱 id）。
   * 未读回前也先计（读回时与盘上 seen 对账回抵），不丢事件。
   * @param {string} id 去重键（Int64 一律字符串）
   * @param {string|string[]} key 计数键；数组=同一去重事件计多个计数器（如到账总+分类型），读回对账逐键回抵
   * @param {number} [n] 增量（缺省 1）
   * @returns {boolean} true=首次计入；false=已见过（未计）
   */
  function countOnce(id, key, n) {
    var sid = String(id == null ? '' : id);
    if (!sid || seenSet.has(sid)) return false;
    seenSet.add(sid);
    seenPush(sid);
    var inc = n == null ? 1 : Number(n) || 0;
    if (inc > 0) {
      var keys = Array.isArray(key) ? key : [key];
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        state.counts[k] = (state.counts[k] || 0) + inc;
        if (!loaded) {
          preBumps.push({ key: k, n: inc });
          preOnce.push({ id: sid, key: k, n: inc });
        }
      }
      if (loaded) persist();
      pokePanel();
    }
    return true;
  }

  /**
   * 读某 key 当日计数（读前先踢跳日收敛：跨 0 点长驻时面板纯读也能归零，
   * 已加载时 ensureLoaded 只做一次日界比较，零额外 I/O）。
   * @param {string} key
   * @returns {number} 未读回/无此键返回 0
   */
  function get(key) {
    ensureLoaded();
    return state.counts[key] || 0;
  }

  return {
    ensureLoaded: ensureLoaded,
    loaded: function () {
      return loaded;
    },
    bump: bump,
    get: get,
    counts: function () {
      ensureLoaded();
      return Object.assign({}, state.counts);
    },
    countOnce: countOnce,
  };
}
