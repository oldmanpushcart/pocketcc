/**
 * 联盟集结-自动加入（reactor 说明书形态）
 *
 * 事件驱动，无轮询：服务器推 12003（PUSH_ALLIANCE_Assembly_Created）
 *   → 按 itemId 识别集结目标（战锤 44 / 惧星 9100）
 *   → 启用 + 有余位 + 全局行军未满 → 延迟后以最小部队发 1204 加入。
 *
 * 行军闸门（同竞对 canMarch 口径）：UserData.myMarchNumMAX - myMarchNum >= 1。
 * 去重：pendingTeamIds 防同一集结重复加入。过期检查：expireTime 已过的集结直接跳过。
 * 每目标可配每日参与上限（0=无限），跨日自动清零，持久化到 pocketcc.feat.allianceRally.daily。
 * 延迟期内 reactor pause → alive=false → 到点自然放弃；信号包络只存标量。
 */
import { createLog } from '../../core/log.js';
import { game } from '../../core/game.js';
import { reactor } from '../../core/reactor.js';
import { storage } from '../../core/storage.js';
import { bus } from '../../core/bus.js';
import { Battle } from '../../core/battle.js';
import { march } from '../../core/march.js';

/** @type {ReturnType<createLog>} 模块日志器（tag=ALLIANCE_RALLY） */
const log = createLog('ALLIANCE_RALLY');

/** @type {number} ResponseId.PUSH_ALLIANCE_Assembly_Created，联盟集结创建推送 */
const CMD_PUSH_ASSEMBLY_CREATED = 12003;

/** @type {number} RequestId.ALLIANCE_Assembly_Join，加入集结请求 */
const CMD_ASSEMBLY_JOIN = 1204;

/** @type {number} MarchType.ALLIANCE_RALLY_BATTLE，集结主行军类型（12003 载荷 marchType 须等于它） */
const MARCH_TYPE_RALLY = 8;

/** @type {number} MarchType.ALLIANCE_RALLY_ASSEMBLY，加入集结请求的 marchType */
const MARCH_TYPE_JOIN = 9;

/**
 * 集结目标注册表：12003 载荷 itemId -> 目标定义。
 * key 与面板配置字段前缀一致（xxxEnabled / xxxDelaySec / xxxDailyLimit），label 仅日志用。
 * @type {Object<string,{key:string, label:string}>}
 */
const RALLY_TARGETS = {
  44: { key: 'warHammer', label: '战锤' }, // 战锤4000，pointType=12
  9100: { key: 'fearStar', label: '惧星' }, // 惧星，pointType=86
  12: { key: 'refugeeCamp', label: '难民营' }, // 难民营，pointType=18
};

/** @type {number} 非服务器返回的哨兵 code：发送异常时用，与真实 s 码区分开 */
const CODE_NOT_SENT = -1;

/** @type {string} 当日参与计数持久态的数据 blob 逻辑名（与配置分离：频繁写入走 storage.data，面板导出/导入只涉及配置）*/
const DAILY_STATE_NAME = 'allianceRally.daily';

/**
 * @type {number} 落盘单飞闸门的看门狗超时（毫秒）。storage.data.set 要等 bridge 回执才落定，
 * 回执丢失（如自动重连刷新页面那段间隙 bridge 尚未注入）会让 Promise 永不 settle，
 * 闸门卡死就等于本次会话再也不落盘——超时后强制复位，后续修改照常重试。
 */
const SAVE_STUCK_MS = 10000;

/** @type {object|null} 网络底座（promise 封装 pocketcc.net） */
var net;
/** @type {object|null} DataCenter.DATA（行军上限/自发集结/过期时间） */
var dataCenter;

/** @type {object|null} reactor 注入的上下文；alive() 反映运行态，pause 后置否让延迟到点的加入自然放弃 */
var ctxRef = null;

/**
 * 可调配置：targets[key] = { enabled:boolean, joinDelayMs:number, dailyLimit:number(0=无限) }
 * @type {object}
 */
var cfg = {
  targets: {
    warHammer: { enabled: true, joinDelayMs: 0, dailyLimit: 0 },
    fearStar: { enabled: true, joinDelayMs: 0, dailyLimit: 0 },
    refugeeCamp: { enabled: true, joinDelayMs: 0, dailyLimit: 0 },
  },
};

/**
 * 当日参与计数持久态：{ date:'YYYY-MM-DD', counts:{ <key>:number } }。
 * 懒加载：首次 alive 时从 storage.get 读回；install 后的 push 处理会先确保已加载。
 * 跳日自动归零（今日 != state.date 时重置 counts）。
 * @type {{date:string, counts:Object<string,number>}}
 */
var dailyState = { date: '', counts: {} };
/** @type {boolean} 持久态是否已读回（未读回前计数按 0 处理，且不允许落盘，见 persistDaily） */
var dailyStateLoaded = false;
/** @type {boolean} 是否有一笔写入在飞（单飞合并，不叠加排队） */
var dailyStateSaving = false;
/** @type {number} 落盘世代号：看门狗复位闸门后，迟到的旧回执不得再去动新一轮的闸门 */
var saveSeq = 0;
/**
 * 今日已播报过「达每日上限」的目标集（键 `date|key`）：每目标每天只 info 一次、之后静默，
 * 避免打满后每次集结 push 都刷一行。内存态，日期拼进键里故跨天自然失效。
 * @type {Set<string>}
 */
var limitAnnounced = new Set();

/** @type {Set<string>} 已安排加入（定时在飞 / 请求在途）的 teamId 集合，防同一条集结重复加入 */
var pendingTeamIds = new Set();

/** @type {boolean} install 幂等守卫 */
var installed = false;

/**
 * 功能是否仍在运行（延迟与在飞流程的存活判定）
 * @returns {boolean}
 */
function aliveFn() {
  return ctxRef ? ctxRef.alive() : false;
}

/**
 * 注入面板配置（秒→毫秒在 registry.toModuleCfg 完成）
 * @param {object} partial {targets:{<key>:{enabled,joinDelayMs,dailyLimit}}}
 * @returns {object} 当前 cfg
 */
function configure(partial) {
  if (!partial) return cfg;
  var targets = partial.targets;
  if (!targets) return cfg;
  Object.keys(cfg.targets).forEach(function (key) {
    var t = targets[key];
    if (!t) return;
    if (typeof t.enabled === 'boolean') cfg.targets[key].enabled = t.enabled;
    if (typeof t.joinDelayMs === 'number' && t.joinDelayMs >= 0)
      cfg.targets[key].joinDelayMs = t.joinDelayMs;
    if (typeof t.dailyLimit === 'number' && t.dailyLimit >= 0)
      cfg.targets[key].dailyLimit = t.dailyLimit;
  });
  return cfg;
}

/**
 * 12003 推送入口：同步过滤 + 抽取纯值 + 安排延迟加入。
 * @param {object} ev net.on 事件 {cmd, status, data, ord, ts, raw}
 */
function onAssemblyCreated(ev) {
  if (!aliveFn()) return;

  var d = ev && ev.data;
  if (!d || !d.teamId || d.marchType !== MARCH_TYPE_RALLY) return;

  var target = RALLY_TARGETS[d.itemId];
  if (!target) return;

  var tcfg = cfg.targets[target.key];
  if (!tcfg || !tcfg.enabled) return;

  // 首读失败过（如 UID 前缀未设的登录窗口期）就借这次推送再试一次，否则本次会话只能永远跑内存值
  if (!dailyStateLoaded) ensureDailyLoaded();

  var teamId = String(d.teamId);

  if (isOwnRally(d)) return;

  // 余位检查
  if ((d.rallyCapacity | 0) - (d.rallySize | 0) < 1) {
    log.info('rally full, skip. target=%s;teamId=%s', target.label, teamId);
    return;
  }

  // 全局行军闸门（core/march.canMarch）
  if (!march.canMarch()) {
    log.info('no free march slot, skip. target=%s;teamId=%s', target.label, teamId);
    return;
  }

  // 每日参与上限闸门（dailyLimit=0 意味无限）
  if (isDailyLimitReached(target.key)) {
    // 已达上限是预期的空闲态：每目标每天只在首次命中时播报一行（生命周期），之后 push 静默返回，不刷日志
    var announceKey = dailyState.date + '|' + target.key;
    if (!limitAnnounced.has(announceKey)) {
      limitAnnounced.add(announceKey);
      log.info(
        'daily limit reached, going idle today. target=%s;count=%d/%d (further skips muted)',
        target.label,
        dailyState.counts[target.key] | 0,
        tcfg.dailyLimit,
      );
    }
    return;
  }

  if (pendingTeamIds.has(teamId)) return;
  pendingTeamIds.add(teamId);

  log.info(
    'rally push. target=%s;teamId=%s;leader=%s;delay=%dms',
    target.label,
    teamId,
    d.leaderName,
    tcfg.joinDelayMs,
  );
  scheduleJoin(target.key, teamId, tcfg.joinDelayMs, d.expireTime);
}

/**
 * 是否自己发起的集结（leaderUid 等于自己 UID 则不自己打自己）
 * @param {object} d 12003 载荷
 * @returns {boolean}
 */
function isOwnRally(d) {
  var uid = dataCenter.UserData && dataCenter.UserData.UID;
  return uid != null && String(d.leaderUid) === String(uid);
}

/**
 * 今日日期字符串 YYYY-MM-DD（当地时区，与面板展示一致）
 * @returns {string}
 */
function todayStr() {
  var d = new Date();
  var m = d.getMonth() + 1;
  var day = d.getDate();
  return d.getFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day);
}

/**
 * 跳日自动归零：当前日期与持久态不同则重置 counts，保留结构，并落盘。
 * 未读回盘上数据前不动内存 date：此时 date='' 必然≠today，照跑会把内存日期抢先改成今天、
 * 却不落盘（persistDaily 有 loaded 闸门），留下 date/counts 不一致的半截状态；
 * 读回回调里日期会整体覆盖并重试跳日，这里直接跳过即可。
 */
function rollDateIfNeeded() {
  if (!dailyStateLoaded) return;
  var today = todayStr();
  if (dailyState.date !== today) {
    dailyState.date = today;
    dailyState.counts = {};
    persistDaily();
  }
}

/**
 * 异步加载持久化的当日计数（首调完成前，同步闸门会默认当作 0 处理；面板重多推送下不致命，
 * 真机需严格的话可额外挂一个 dailyStateLoaded 闸门，目前接受这个短窗口）。
 * 读失败不置 loaded：读不到 ≠ 盘上没数据（storage.data.get 在 UID 前缀未设时是 reject），
 * 保留下次 run()/推送重试的机会；未 loaded 期间 persistDaily 会挡住写盘，不会拿内存全 0 覆掉盘上真值。
 */
function ensureDailyLoaded() {
  if (dailyStateLoaded) {
    rollDateIfNeeded();
    return;
  }
  Promise.resolve(storage.data.get(DAILY_STATE_NAME))
    .then(function (saved) {
      dailyStateLoaded = true;
      if (saved && typeof saved === 'object' && typeof saved.date === 'string') {
        dailyState.date = saved.date;
        dailyState.counts = saved.counts && typeof saved.counts === 'object' ? saved.counts : {};
      }
      rollDateIfNeeded();
      // 读回完成把面板上的 '-' 占位刷成真实计数（ui.refresh 仅在面板打开时扫 DOM，开销可忽略）
      bus.emit('ui.refresh');
    })
    .catch(function (err) {
      log.warn('daily state load failed, will retry on next run/push. %s', err && err.message);
      rollDateIfNeeded();
    });
}

/**
 * 当前目标今日参与是否已抵达上限（dailyLimit=0 直接放行）
 * @param {string} key 目标 key
 * @returns {boolean}
 */
function isDailyLimitReached(key) {
  var limit = cfg.targets[key] && cfg.targets[key].dailyLimit;
  if (!limit || limit <= 0) return false;
  rollDateIfNeeded();
  return (dailyState.counts[key] | 0) >= limit;
}

/**
 * 当前面板展示的“今日已参与”文本：N / limit（limit=0 时显示 ∞）。
 * 纯展示函数：不再调 rollDateIfNeeded——首次渲染（mountUI→get）早于异步读盘完成，
 * 旧实现在 UI 路径上触发日期改写+落盘尝试，弹出误报的 skip-save warn。
 * 未读回时借这次渲染补发一次加载，并显示占位符（计数读回后随面板下次刷新更新）。
 * @param {string} key 目标 key
 * @param {number} limit 每日上限
 * @returns {string}
 */
function formatToday(key, limit) {
  if (!dailyStateLoaded) {
    ensureDailyLoaded();
    return '-';
  }
  var n = dailyState.counts[key] | 0;
  limit = limit | 0;
  return limit > 0 ? n + ' / ' + limit : n + ' / ∞';
}

/**
 * 成功加入一条后计数 +1 并异步持久化（写入失败不阻断主流程），顺带推面板刷新
 * @param {string} key 目标 key
 */
function bumpDailyCount(key) {
  rollDateIfNeeded();
  dailyState.counts[key] = (dailyState.counts[key] | 0) + 1;
  persistDaily();
  bus.emit('ui.refresh');
}

/**
 * 保存 daily state（单飞：上一次未写完时不叠加，后续修改会合并到下一笔写入）。两道保险：
 *   1) 未成功读回盘上数据前绝不写盘——内存这份 counts 很可能是全 0，整块写回会把盘上真值覆掉；
 *   2) 单飞闸门带看门狗——写入靠 bridge 回执落定，回执丢失会让闸门永久卡死（之后再也不落盘），
 *      超时强制复位，后续修改照常重试。
 */
function persistDaily() {
  if (dailyStateSaving) return;
  if (!dailyStateLoaded) {
    log.warn(
      'skip daily state save: disk state not loaded yet (in-memory counts are not authoritative).',
    );
    return;
  }
  dailyStateSaving = true;
  var seq = ++saveSeq;
  var snapshot = { date: dailyState.date, counts: Object.assign({}, dailyState.counts) };
  var watchdog = setTimeout(function () {
    log.warn('daily state save pending over %dms, reset latch.', SAVE_STUCK_MS);
    releaseSaveLatch(seq);
  }, SAVE_STUCK_MS);
  Promise.resolve(storage.data.set(DAILY_STATE_NAME, snapshot))
    .catch(function (err) {
      log.warn('daily state save failed.', err);
    })
    .then(function () {
      clearTimeout(watchdog);
      releaseSaveLatch(seq);
    });
}

/**
 * 释放落盘单飞闸门（带世代校验）：看门狗已复位且被新一轮接管后，迟到的旧回执不得再去动新那笔的闸门。
 * @param {number} seq 本次写入的世代号
 */
function releaseSaveLatch(seq) {
  if (seq !== saveSeq) return;
  dailyStateSaving = false;
}

/**
 * 延迟入队：joinDelayMs 后执行加入。0 也走 setTimeout，让同步栈先落地。
 * @param {string} key 目标 key
 * @param {string} teamId 集结队伍 id
 * @param {number} delayMs 延迟毫秒
 * @param {number} expireTime 集结过期时间戳（秒）
 */
function scheduleJoin(key, teamId, delayMs, expireTime) {
  setTimeout(
    function () {
      joinFlow(key, teamId, expireTime).catch(function (err) {
        log.warn('join flow threw!', err);
      });
    },
    Math.max(0, delayMs | 0),
  );
}

/**
 * 单次加入流程：过期检查 → 行军检查 → 最小部队 → 发 1204。永不 reject。
 * @param {string} key 目标 key
 * @param {string} teamId 集结队伍 id
 * @param {number} expireTime 集结过期时间戳（秒）
 * @returns {Promise<void>}
 */
async function joinFlow(key, teamId, expireTime) {
  try {
    if (!aliveFn()) return;

    // 过期检查：集结已开始（expireTime 已过）则放弃
    if (expireTime && Date.now() / 1000 > expireTime) {
      log.info('rally expired, abandon. target=%s;teamId=%s', key, teamId);
      return;
    }

    // 行军闸门复查
    if (!march.canMarch()) {
      log.info('no march slot (recheck), abandon. target=%s;teamId=%s', key, teamId);
      return;
    }

    var marchData = new Battle().plan().minimal().build();
    if (!marchData.armyListNew.length) {
      log.info('no army available, abandon. target=%s;teamId=%s', key, teamId);
      return;
    }

    // 发送前复查每日上限（延迟期间可能上一刚刚发成一条，同目标计数会变）
    if (isDailyLimitReached(key)) {
      log.info('daily limit reached (recheck), abandon. target=%s;teamId=%s', key, teamId);
      return;
    }

    var ret = await sendJoin(teamId, marchData);
    if (ret.ok) {
      bumpDailyCount(key);
      log.info(
        'join ok. target=%s;teamId=%s;armyId=%d;today=%d',
        key,
        teamId,
        marchData.armyListNew[0].armyId,
        dailyState.counts[key] | 0,
      );
    } else {
      // 加入被拒（目标已满/已过期/不可加入等 code=3）属预期业务态，非错误：降为 info（真实网络失败另由 sendJoin 的 join send error warn 兜底）
      log.info('join rejected. target=%s;teamId=%s;code=%d', key, teamId, ret.code);
    }
  } finally {
    pendingTeamIds.delete(teamId);
  }
}

/**
 * 发送 1204 加入集结。永不 reject。
 * @param {string} teamId 集结队伍 id
 * @param {object} marchData Battle 产出的 MarchData
 * @returns {Promise<Ret>} code=1204 状态码
 */
async function sendJoin(teamId, marchData) {
  try {
    return await net.send(CMD_ASSEMBLY_JOIN, {
      marchType: MARCH_TYPE_JOIN,
      teamId: teamId,
      armyList: marchData.armyListNew,
      armyListNew: marchData.armyListNew,
      heroList: marchData.heroList,
      trapList: marchData.trapList,
      formation: 0,
      formationV2: marchData.formationV2,
    });
  } catch (err) {
    log.warn('join send error. teamId=%s', teamId, err);
    return net.Ret.from(CODE_NOT_SENT, null);
  }
}

/**
 * 安装：网络 + 数据中心。
 * @param {object} ctx reactor 上下文
 * @returns {boolean}
 */
function install(ctx) {
  ctxRef = ctx;
  if (installed) return true;

  var missing = [];

  net = ctx.net;
  if (!net.install()) {
    missing.push('pocketcc.net');
    net = null;
  }

  var mods = game.requireAll(['DataCenter']);

  dataCenter = (mods.DataCenter && mods.DataCenter.DATA) || missing.push('DataCenter');

  if (missing.length) {
    net = null;
    dataCenter = null;
    log.warn('install failed. missing=%s', missing.join(';'));
    return false;
  }

  installed = true;
  log.info('installed.');
  return true;
}

/**
 * 运行：挂 12003 监听。
 * @param {object} ctx reactor 上下文
 */
function run(ctx) {
  ctxRef = ctx;
  pendingTeamIds.clear();
  ensureDailyLoaded();
  ctx.on.push(CMD_PUSH_ASSEMBLY_CREATED, onAssemblyCreated);
  log.info('started, listening push=%d.', CMD_PUSH_ASSEMBLY_CREATED);
}

/**
 * 向 reactor 注册本功能说明书：places 限定 base/world（Home/NWorldMap），战斗模式暂停；面板按目标分段带今日计数。
 */
reactor.register({
  id: 'allianceRally',
  label: '联盟集结',
  storageKey: 'pocketcc.feat.allianceRally',
  symbols: ['dataCenter'],
  places: ['base', 'world'],
  kinds: ['homeland'],
  offInCombat: true,
  defaults: {
    enabled: false,
    warHammerEnabled: true,
    warHammerDelaySec: 0,
    warHammerDailyLimit: 0,
    fearStarEnabled: true,
    fearStarDelaySec: 0,
    fearStarDailyLimit: 0,
    refugeeCampEnabled: true,
    refugeeCampDelaySec: 0,
    refugeeCampDailyLimit: 0,
  },
  fields: [
    { key: 'warHammerEnabled', label: '自动加入', type: 'checkbox', section: '战锤' },
    { key: 'warHammerDelaySec', label: '延迟入队(秒)', min: 0, step: 1, section: '战锤' },
    {
      key: 'warHammerDailyLimit',
      label: '每日上限',
      min: 0,
      step: 1,
      zeroUnlimited: true,
      section: '战锤',
    },
    {
      key: 'warHammerTodayCount',
      label: '今日已参与',
      type: 'text',
      section: '战锤',
      get: function (c) {
        return formatToday('warHammer', c && c.warHammerDailyLimit);
      },
    },
    { key: 'fearStarEnabled', label: '自动加入', type: 'checkbox', section: '惧星' },
    { key: 'fearStarDelaySec', label: '延迟入队(秒)', min: 0, step: 1, section: '惧星' },
    {
      key: 'fearStarDailyLimit',
      label: '每日上限',
      min: 0,
      step: 1,
      zeroUnlimited: true,
      section: '惧星',
    },
    {
      key: 'fearStarTodayCount',
      label: '今日已参与',
      type: 'text',
      section: '惧星',
      get: function (c) {
        return formatToday('fearStar', c && c.fearStarDailyLimit);
      },
    },
    { key: 'refugeeCampEnabled', label: '自动加入', type: 'checkbox', section: '难民营' },
    { key: 'refugeeCampDelaySec', label: '延迟入队(秒)', min: 0, step: 1, section: '难民营' },
    {
      key: 'refugeeCampDailyLimit',
      label: '每日上限',
      min: 0,
      step: 1,
      zeroUnlimited: true,
      section: '难民营',
    },
    {
      key: 'refugeeCampTodayCount',
      label: '今日已参与',
      type: 'text',
      section: '难民营',
      get: function (c) {
        return formatToday('refugeeCamp', c && c.refugeeCampDailyLimit);
      },
    },
  ],
  toModuleCfg: function (c) {
    return {
      targets: {
        warHammer: {
          enabled: !!c.warHammerEnabled,
          joinDelayMs: c.warHammerDelaySec * 1000,
          dailyLimit: c.warHammerDailyLimit | 0,
        },
        fearStar: {
          enabled: !!c.fearStarEnabled,
          joinDelayMs: c.fearStarDelaySec * 1000,
          dailyLimit: c.fearStarDailyLimit | 0,
        },
        refugeeCamp: {
          enabled: !!c.refugeeCampEnabled,
          joinDelayMs: c.refugeeCampDelaySec * 1000,
          dailyLimit: c.refugeeCampDailyLimit | 0,
        },
      },
    };
  },
  install: install,
  configure: configure,
  run: run,
});
