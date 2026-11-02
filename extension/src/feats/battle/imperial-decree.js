/**
 * 奉旨出征（reactor 说明书形态）
 *
 * 让玩家盟友（「执政官」名单内的玩家）通过聊天 @我 下旨：消息格式 `X:Y #N`——
 * X/Y 为世界坐标（game 口径，与聊天坐标卡/全局地图同系），N 为预设部队号（1 起，战斗预设）。
 * 收到旨令即向 (X,Y) 用预设 N 发 902 行军，并在原频道 @执政官复旨：
 *   成功 → 「得令」；失败 → 服务器拒因经游戏 l10n（getNetMsgText 同源）翻译成中文后回复。
 *
 * 收令通道：聊天 socket 事件 chatpush（频道）/ chatpushpm（私聊），经 ctx.on.chat 订阅、
 * pause 由 reactor 统一摘除（chat 底座直连 socket 并自愈重挂）。判定链：
 *   发送者 ∈ 执政官名单（String UID 比对，防 14 位截断）→ atData 点名本人（口径同聊天浮层
 *   mention 判据：atData.uid 含本人 UID 或 StrUid）→ 正则解 X:Y #N → uuid 幂等去重。
 *
 * 目标实体探查：旨令只给坐标，902 的 marchType 需要知道打的是什么——以 (X,Y) 为中心发 901
 * GET_WORLD_INFO（回点窗以请求点为中心 ±58/±39，恒盖住目标点），pointList 里精确匹配该点，
 * pointType → 本服基础 marchType（1 玩家城→13 / 2 野怪→5 / 4 资源田→3；世界 BOSS 经防腐层
 * march.isBoss→14、march.isBossV2→298），再走 march.resolve 做跨服战场漂移换算（同快捷攻击口径）。
 *
 * 复旨 @点名协议（定案）：m 保留字面 "@昵称"，custom.atData 并列 uid/name 名单，
 * 联盟/群聊由 chat.js defaultCustom 自动补 mentionType/mentionUidList；禁 RS 编码。
 *
 * 依赖游戏运行时只「读 + 发包」，不调任何 Update/Delete 改写本地数据（feat 合规约束）。
 * 地图 places:['base','world']（901/902 纯网络请求，口径同海上夺宝）+ kinds:['homeland','wushuang','kvk']（B 档，跨服战场图照打，
 * march.resolve 已做战场 marchType 换算）；不声明 offInCombat——
 * 旨令即战时指挥，战斗模式（F8）下必须照常生效（与快捷战斗同侧）。
 * 属「战斗设置」：单飞执行（busy 期新旨令直接回「稍候」），队列不足只拒当前令不排队。
 */
import { createLog } from '../../core/log.js';
import { safeParse } from '../../core/util.js';
import { game } from '../../core/game.js';
import { gameData, l10n, march as marchApi } from '../../core/game-api.js';
import { getUid } from '../../core/player.js';
import { reactor } from '../../core/reactor.js';
import { chatApi } from '../../core/chat.js';
import { Battle } from '../../core/battle.js';
import { march } from '../../core/march.js';
import { map, SERVER } from '../../core/map.js';

/** @type {ReturnType<createLog>} 模块日志器（tag=IMPERIAL_DECREE） */
const log = createLog('IMPERIAL_DECREE');

/** @type {number} RequestId.MARCH_WORLD_POINT：世界地图行军；仅用于发攻前的同 cmd 在途频控（发送走 core/march.attack） */
const CMD_MARCH_WORLD_POINT = 902;

/** @type {RegExp} 旨令格式 X:Y #N（方括号无要求，带了也照收）：兼容全角括号/全角冒号；
 *  X/Y 1~4 位、N 1~2 位；靠 "#数字" 作为必选锚点降低误命率 */
const DECREE_RE = /[[(\uFF08]?\s*(\d{1,4})\s*[:\uFF1A]\s*(\d{1,4})\s*[\])\uFF09]?\s*#\s*(\d{1,2})/;

/** @type {number} 预设部队号上限（与快捷战斗 1..8 对齐） */
const PRESET_MAX = 8;

/**
 * pointType → 本服基础 marchType 映射（已实证可攻打目标；BOSS 两型走运行时枚举判定）。
 * 数值口径同快捷攻击注册表：13=ATTACK_PLAYER、5=ATTACK_MONSTER、3=GATHER_RESOURCE 位。
 * @type {Object<number,number>}
 */
const ATTACK_BY_POINT_TYPE = { 1: 13, 2: 5, 4: 3 };

/** @type {{attackPlayer:number, tm:number, master:number, ava:number, teamLegend:number}} marchType 兜底数值表（同 quick-attack） */
const MARCH_FALLBACK = { attackPlayer: 13, tm: 150, master: 170, ava: 110, teamLegend: 181 };

/** @type {number} 已处理旨令 uuid 的内存上限（FIFO 淘汰，防长会话无界增长） */
const SEEN_MAX = 200;

/** @type {object|null} 网络底座（install 时取） */
var net;
/** @type {object|null} DataCenter.DATA（行军名额/ServerId） */
var dataCenter;
/** @type {object|null} reactor 上下文；alive() 反映运行态 */
var ctxRef = null;
/** @type {boolean} install 幂等守卫 */
var installed = false;
/** @type {boolean} 单飞闸门：一道旨令执行中（含 901 探查 + 902 应答）不接受新令 */
var busy = false;
/** @type {Set<string>} 已执行旨令的消息 uuid（幂等去重） */
var seenIds = new Set();
/** @type {string[]} seenIds 的插入序镜像（FIFO 淘汰用） */
var seenQueue = [];
/** @type {{consuls: Array<{uid:string, name:string}>}} 面板配置（configure 推入） */
var cfg = { consuls: [] };

/**
 * 功能是否仍在运行（在飞流程 await 回来后的存活判定）
 * @returns {boolean}
 */
function aliveFn() {
  return ctxRef ? ctxRef.alive() : false;
}

/**
 * 执政官名单 Set（String uid），每条消息到达时现建（名单最多 10 条，成本可忽略且永不过期）。
 * @returns {Set<string>}
 */
function consulSet() {
  var s = new Set();
  for (var c of cfg.consuls || []) {
    if (c && c.uid != null && c.uid !== '') s.add(String(c.uid));
  }
  return s;
}

// safeParse 已收口至 core/util.js（见顶部 import）

/**
 * 消息文本是否点名本人（atData.uid 含本人 UID 或 StrUid；元素可能是裸值或 {uid} 对象）。
 * 口径同聊天浮层 mention 判据。
 * @param {object} raw 原始消息项
 * @returns {boolean}
 */
function mentionsMe(raw) {
  var custom = safeParse(raw.custom);
  var at = custom && custom.atData;
  if (!at || !Array.isArray(at.uid)) return false;
  var myUid = String(getUid() || '');
  var myStr = gameData.strUid();
  for (var u of at.uid) {
    var su = String(u && u.uid != null ? u.uid : u);
    if ((myUid && su === myUid) || (myStr && su === myStr)) return true;
  }
  return false;
}

/**
 * 本人昵称（UserData.Name，游戏同源字段）：文本 @ 兜底用；取不到返回 ''
 * @returns {string}
 */
function myNick() {
  try {
    var u = (dataCenter && dataCenter.UserData) || null;
    return String((u && u.Name) || '');
  } catch (e) {
    return '';
  }
}

/**
 * 消息是否点名本人：优先 atData 结构化判据，其次文本内出现字面「@本人昵称」兜底
 * （实证部分频道的 EventCenter 事件层载荷不带 custom.atData，只看 atData 会漏收）。
 * @param {object} raw 原始消息项
 * @param {string} text 消息文本
 * @returns {boolean}
 */
function isMention(raw, text) {
  if (mentionsMe(raw)) return true;
  var nick = myNick();
  return !!nick && String(text || '').indexOf('@' + nick) >= 0;
}

/**
 * uuid 幂等去重：见过回 false 并记入（FIFO 淘汰到 SEEN_MAX）。
 * @param {string} id 消息 uuid
 * @returns {boolean} 是否首次见到
 */
function firstSeen(id) {
  if (seenIds.has(id)) return false;
  seenIds.add(id);
  seenQueue.push(id);
  while (seenQueue.length > SEEN_MAX) seenIds.delete(seenQueue.shift());
  return true;
}

/**
 * 收信入口（EventCenter 载荷可能单项或数组）：逐条 try，单条坏消息不拖垮批次。
 * @param {string} kind 'push' 频道 | 'pm' 私聊
 * @param {object|object[]} payload 原始消息
 */
function onMessages(kind, payload) {
  if (!aliveFn()) return;
  var chat = chatApi;
  if (!chat) return;
  var items = Array.isArray(payload) ? payload : [payload];
  for (var raw of items) {
    if (!raw || typeof raw !== 'object') continue;
    try {
      handleMsg(chat, raw, kind);
    } catch (err) {
      log.warn('handle message threw. kind=%s', kind, err);
    }
  }
}

/**
 * 单条旨令判定链：本人回声 → 执政官 → @我 → 格式 → 去重，全过才入执行。
 * @param {object} chat pocketcc.chat 底座
 * @param {object} raw 原始消息项
 * @param {string} kind 'push' | 'pm'
 */
function handleMsg(chat, raw, kind) {
  var norm = chat.normalize(raw, kind);
  if (!norm || norm.isSelf) return; // 自己的回声不接（也防复旨自触发）

  var fromUid = String((norm.from && norm.from.uid) || '');
  var text = String(raw.m != null ? raw.m : norm.text || '');
  var m = DECREE_RE.exec(text);
  var isConsul = !!fromUid && consulSet().has(fromUid);
  var mention = isMention(raw, text);
  // 留痕：来自执政官或文本形似旨令的消息，不论卡在哪个闸门都记一笔（排障用：
  // 名单 UID 对不上/没 @/全角符号格式不合，此前全部静默吞掉无从诊断）
  if (isConsul || m) {
    // 诊断面：my/str 为本人双 UID，at=消息 atData.uid 名单（mention 判据的比对双方直接可见），
    // cs=名单人数（区分「名单没配上」与「配了但 UID 不对」）
    var custom = safeParse(raw.custom);
    var at =
      custom && custom.atData && Array.isArray(custom.atData.uid)
        ? custom.atData.uid
            .map(function (u) {
              return String(u && u.uid != null ? u.uid : u);
            })
            .join(',')
        : '';
    log.info(
      'eval. from=%s(%s);consul=%s;mention=%s;format=%s;chan=%s;my=%s(%s);nick=%s;at=[%s];cs=%d;text=%s',
      (norm.from && norm.from.name) || '?',
      fromUid,
      isConsul,
      mention,
      !!m,
      norm.channel,
      String(getUid() || ''),
      gameData.strUid() || '',
      myNick(),
      at,
      consulSet().size,
      text,
    );
  }
  if (!isConsul) return; // 非执政官的消息一律无视
  if (!m) return; // 未命中 X:Y #N 格式
  if (!mention) return; // 必须 @我（atData 或文本字面 @昵称）

  var uuid = String(raw.uuid != null ? raw.uuid : norm.id != null ? norm.id : '');
  if (uuid && !firstSeen(uuid)) return; // 同一条旨令只处理一次（含拒签回信，防重复推送刷屏）

  var order = {
    x: +m[1],
    y: +m[2],
    preset: +m[3],
    uuid: uuid,
    channel: norm.channel,
    roomId: raw.roomId,
    fromUid: fromUid,
    fromName: (norm.from && norm.from.name) || '',
  };
  if (order.x > SERVER.gameXMax || order.y > SERVER.gameYMax) {
    reply(
      chat,
      order,
      '坐标 (' +
        order.x +
        ',' +
        order.y +
        ') 越界，本服地图 ' +
        SERVER.gameXMax +
        '×' +
        SERVER.gameYMax,
    );
    return;
  }
  if (order.preset < 1 || order.preset > PRESET_MAX) {
    reply(chat, order, '旨令部队号 #' + order.preset + ' 超界（仅预设 1~' + PRESET_MAX + '）');
    return;
  }

  log.info(
    'decree received. from=%s;x=%d;y=%d;preset=%d;chan=%s',
    order.fromName,
    order.x,
    order.y,
    order.preset,
    order.channel,
  );
  execFlow(order).catch(function (err) {
    log.warn('decree flow threw!', err);
  });
}

/**
 * 旨令执行流（永不 reject）：单飞闸门 → 队列闸门 → 造部队 → 901 探目标 → 902 出征 → 复旨。
 * @param {object} order 旨令 {x,y,preset,channel,roomId,fromUid,fromName}
 */
async function execFlow(order) {
  var chat = chatApi;
  if (!chat) return;
  if (busy) {
    reply(chat, order, '旨令已收到，前令行军中请稍候');
    return;
  }
  busy = true;
  try {
    await dispatch(chat, order);
  } finally {
    busy = false;
  }
}

/**
 * 单道旨令的分派。所有失败出口统一走 reply。
 * @param {object} chat pocketcc.chat 底座
 * @param {object} order 旨令
 */
async function dispatch(chat, order) {
  // 1) 行军名额闸门（口径同快捷攻击：myMarchNumMAX - myMarchNum >= 1）
  if (!march.canMarch()) {
    log.info('no free march slot, reject. x=%d;y=%d', order.x, order.y);
    reply(chat, order, '行军队列已满，无法出征');
    return;
  }

  // 2) 预设部队造行军数据（Battle 预设号 1 起，内部减 1）
  var marchData = new Battle().plan().preset(order.preset).adjust().build();
  if (!marchData.armyListNew.length) {
    log.info('preset empty, reject. preset=%d;x=%d;y=%d', order.preset, order.x, order.y);
    reply(chat, order, '预设 #' + order.preset + ' 无兵可派');
    return;
  }

  // 3) 901 探明目标实体（请求点即目标点，回点窗以它为中心恒覆盖）
  var point = await probeTarget(order.x, order.y);
  if (point === undefined) {
    reply(chat, order, '目标探查失败，请核实坐标或稍后重试');
    return;
  }
  if (point === null) {
    reply(chat, order, '目标 (' + order.x + ',' + order.y + ') 无可攻打对象');
    return;
  }

  // 4) marchType：pointType 基础值 + BOSS 两型经游戏 MarchType 枚举取名值（成员名收在 game-api SYM）+ 跨服漂移换算
  var base = ATTACK_BY_POINT_TYPE[point.pointType];
  if (base == null && marchApi.isBossV2(point.pointType))
    base = marchApi.typeOf('attackWorldBossV2', 298);
  else if (base == null && marchApi.isBoss(point.pointType))
    base = marchApi.typeOf('attackWorldBoss', 14);
  if (base == null) {
    log.info('point not attackable. x=%d;y=%d;pointType=%d', order.x, order.y, point.pointType);
    reply(chat, order, '目标 (' + order.x + ',' + order.y + ') 无可攻打对象');
    return;
  }
  var marchType = marchApi.resolve(base, MARCH_FALLBACK);

  // 5) 发 902
  if (net.isSending(CMD_MARCH_WORLD_POINT)) {
    reply(chat, order, '行军指令繁忙，请稍候重发');
    return;
  }
  var ret = await march.attack({
    marchType: marchType,
    target: { x: order.x, y: order.y },
    data: marchData,
  });
  if (!aliveFn()) return; // 已暂停：结果不再复旨（新激活补扫语义不适用旨令）

  if (ret.ok) {
    log.info(
      'decree done. x=%d;y=%d;preset=%d;marchType=%d(base=%d)',
      order.x,
      order.y,
      order.preset,
      marchType,
      base,
    );
    reply(chat, order, '得令');
  } else {
    log.info('decree rejected. x=%d;y=%d;code=%d;data=%s', order.x, order.y, ret.code, ret.data);
    reply(chat, order, failureText(ret));
  }
}

/**
 * 901 拉取目标点实体。
 * @param {number} x 目标 game x
 * @param {number} y 目标 game y
 * @returns {Promise<object|null|undefined>} 命中点位对象；查无实体 null；请求失败 undefined
 */
async function probeTarget(x, y) {
  var u = (dataCenter && dataCenter.UserData) || {};
  var r = await map.fetchWindow(net, x, y, { k: u.ServerId | 0 });
  if (!r.ok) {
    log.warn('901 probe not ok. x=%d;y=%d;code=%s', x, y, r.code);
    return undefined;
  }
  for (var p of r.points) {
    if (p && (p.x | 0) === x && (p.y | 0) === y) return p;
  }
  return null;
}

/**
 * 失败拒因 → 中文译文（服务器裸串 '<键,参数>' 走游戏 getNetMsgText 同源翻译；
 * 查不到译文/无载荷时降级带 code 的兜底文案）。
 * @param {object} ret net.Ret
 * @returns {string}
 */
function failureText(ret) {
  if (ret.code === march.NOT_SENT) return '出征失败：发送超时或未发出';
  var rawStr = String(ret.data == null ? '' : ret.data).trim();
  var zh = rawStr ? l10n.net(rawStr) : '';
  if (!zh || zh === rawStr) return '出征失败（code=' + ret.code + '）';
  return zh;
}

/**
 * 复旨：原频道 @执政官回复。m 保留字面 "@昵称"（协议定案），atData 并列名单由
 * chat.js defaultCustom 处理联盟/群聊的 mentionType/mentionUidList 附加。
 * 私聊回令带 opts.uid=执政官 UID；群聊(5)带 roomId。回信失败只 warn 不重试。
 * @param {object} chat pocketcc.chat 底座
 * @param {object} order 旨令 {channel,roomId,fromUid,fromName}
 * @param {string} conclusion 结语文案
 */
function reply(chat, order, conclusion) {
  var name = String(order.fromName || '');
  var text = (name ? '@' + name + ' ' : '') + conclusion;
  var opts = {
    c: order.channel != null ? +order.channel : 0,
  };
  if (name) opts.atData = { uid: [String(order.fromUid)], name: [name], msgId: '' }; // 昵称缺失降级纯文本，不塞空 atData
  if (opts.c === 1) opts.uid = String(order.fromUid); // 私聊：回给下令者
  if (opts.c === 5 && order.roomId) opts.group = String(order.roomId); // 群聊：动态房
  chat
    .send(text, opts)
    .then(function (ret) {
      // 频道消息 670 应答：成功 data 是 '{"success":1,...}' JSON 串，业务拒时为裸串
      var parsed = safeParse(ret && ret.data);
      if (!ret || !ret.ok || (parsed && parsed.success !== 1)) {
        log.info(
          'reply rejected. chan=%s;code=%s;data=%s',
          opts.c,
          ret && ret.code,
          ret && ret.data,
        );
      }
    })
    .catch(function (err) {
      log.warn('reply threw. chan=%s', opts.c, err);
    });
}

/**
 * 注入面板配置：consuls 执政官名单 [{uid,name}]。
 * @param {object} partial { enabled, consuls }
 * @returns {object} 当前 cfg
 */
function configure(partial) {
  if (!partial) return cfg;
  cfg.consuls = Array.isArray(partial.consuls) ? partial.consuls : [];
  return cfg;
}

/**
 * 安装：取网络底座 + 数据中心。任一缺失即失败（reactor 不会激活）。
 * @param {object} ctx reactor 上下文
 * @returns {boolean}
 */
function install(ctx) {
  ctxRef = ctx;
  if (installed) return true;

  var missing = [];

  net = ctx.net;
  if (!net || !net.install()) {
    missing.push('pocketcc.net');
    net = null;
  }

  var dc = game.get('DataCenter');
  dataCenter = (dc && dc.DATA) || null;
  if (!dataCenter) missing.push('DataCenter');

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
 * 激活：订阅聊天推送（pause 由 ctx.on.chat 统一摘除）。
 * @param {object} ctx reactor 上下文
 */
function run(ctx) {
  ctxRef = ctx;
  ctx.on.chat('push', function (p) {
    onMessages('push', p);
  });
  ctx.on.chat('pm', function (p) {
    onMessages('pm', p);
  });
  log.info('started, consuls=%d', (cfg.consuls || []).length);
}

/**
 * 向 reactor 注册本功能说明书：places:['base','world'] + kinds:['homeland','wushuang','kvk']（B 档）；战斗设置类，不声明 offInCombat
 * （旨令即战时指挥，战斗模式下照常奉旨）。
 */
reactor.register({
  id: 'imperialDecree',
  label: '奉旨出征',
  storageKey: 'pocketcc.feat.imperialDecree',
  symbols: ['dataCenter', 'marchType', 'worldUtils', 'tableManager', 'localManager'],
  // B 档（可行性报告 §7.2）：奉旨出征靠 chat @我 触发、发 902 打世界图目标，march.resolve 已做跨服战场
  // marchType 换算；故 kinds 放行本服/无双峡谷/天梯（盟决/征服者球体不在场，秘境由 world 门 kind===pab 隔离）。
  kinds: ['homeland', 'wushuang', 'kvk'],
  places: ['base', 'world'],
  defaults: {
    enabled: false,
    consuls: [],
  },
  fields: [
    {
      key: 'consuls',
      label: '执政官名单',
      itemLabel: '执政官',
      type: 'uidlist',
      max: 10,
      placeholder: '请输入玩家UID',
      hint: '仅名单内玩家 @我 发送 X:Y #N（坐标+预设号）才会奉旨出征',
    },
  ],
  // 面板值经 toModuleCfg 透传给 configure（同 player-like 口径）：漏传则运行时名单永远为空
  toModuleCfg: function (c) {
    return { consuls: c.consuls };
  },
  install: install,
  configure: configure,
  run: run,
});
