/**
 * 遗迹田（6 级田）扫描器 —— 邮件驱动的锚点扫图 + 候选池持久化
 *
 * 为什么必须邮件驱动：6 级田不是定时刷新，而是联盟成员「刷新王者遗迹（资源遗迹）」时由服务器在两个
 * 固定锚点 (408,308)/(408,648) 周围批量开出无主 6 级田（真机 914/914 条 pointType 恒 38、r.aid=刷新盟）。
 * 扫一圈是 5 窗高危 901，不能轮扫，只能等信号；信号 = push PUSH_SINGLE_MAIL(10264) 标题「遗迹区域刷新」。
 *
 * 有效期 4 小时：实证田 expireTime ≈ 刷新邮件 sendTime + 14400s，过期即无主消失，
 * 故只处理 serverTime − sendTime < L6_MAIL_FRESH_SEC 的邮件，池内条目按自带 expireTime 老化。
 *
 * 去重键 = 邮件本身（mailKey）：`mailId`（缺省回 `t<sendTime>_<family>`）。同一封刷新邮件被轮询与推送
 * 多次检测只扫一次；scanned 表记 {at, anchor, family, hits}，兼作「这封扫过、命中几个」的诊断凭据。
 * 用邮件而非锚点做键，是因为同一锚点在 4 小时内可被刷新多次，锚点键会把第二批田当成「已扫」漏掉。
 *
 * 扫图口径照抄竞品B refreshRelicResources：5 窗（窗心 x∓60 / y−40,+40 四块 + (x−60, y+120)），
 * 窗 60×90、viewLevel1、窗间串行 L6_SCAN_GAP_MS。家族闸：邮件正文写明「资源类型为 农田/油田/金矿」，
 * 该家族未被勾选则整锚点不扫（省 5 窗高危 901）；文案不认识时 fail-open 照扫（家族真值以扫回点为准）。
 *
 * 池条目录 storage.slot('autoFarm.lvl6')，形状 {v, scanned, pool}：跨刷新页保留，免重扫高危 901。
 * 派兵前对候选做中心定点 901 复验（pointType38 & 本盟 & ownerId='0'），复验不过即移出池——持久化的「空闲」可能早已被抢。
 * ⚠️ 复验的免探窗只认 probedAt（派前单点复验时刻），**不认 ts**（普查快照时刻）：5 窗普查一次刷进上百点，
 * 若也给它背书，就成了「扫图后 10 分钟内派兵一律不侦查」——真机撞过：21:00:45 普查入池、21:06:06 才补派，
 * 中间田早被别队占了，连吃 4 发 902 被拒（why=100488 已有人驻扎），每发还把一个好点误钉 30 分钟。
 */
import { gameData, l10n, mail, worldMap } from '../../../core/game-api.js';
import { parseData, sleep } from '../../../core/util.js';
import { createLog } from '../../../core/log.js';
import { storage } from '../../../core/storage.js';
import { map } from '../../../core/map.js';

/** @type {ReturnType<typeof createLog>} 模块日志器（tag=AUTO-FARM） */
const log = createLog('AUTO-FARM');

/** @type {number} push PUSH_SINGLE_MAIL：单封邮件推送（「遗迹区域刷新」开田信号，载荷是邮件本体） */
const PUSH_SINGLE_MAIL = 10264;
/** @type {number} 901 pointType=38 要塞/遗迹资源点（王者遗迹刷新出的 6 级田，r 载荷带 itemId） */
const POINT_TYPE_FORTRESS_RES = 38;
/** @type {Array<{x:number,y:number}>} 两个王者遗迹锚点（刷新邮件正文坐标必落此二者之一） */
const RELIC_ANCHORS = [
  { x: 408, y: 308 },
  { x: 408, y: 648 },
];
/** @type {{w:number,h:number}} 扫图窗口尺寸（901 请求体 width/height，竞品B 口径 60×90） */
const WIN = { w: 60, h: 90 };
/**
 * @type {Array<{dx:number,dy:number}>} 锚点周围 5 窗窗心偏移（照抄竞品B：上下两排 x∓60 共四块 + 一块 (x−60, y+120)）。
 * 窗 60×90 对应 x∈[−90,+90]、y∈[−85,+165]，覆盖遗迹刷新辐射带。
 */
const WINDOWS = [
  { dx: -60, dy: -40 },
  { dx: 60, dy: -40 },
  { dx: -60, dy: 40 },
  { dx: 60, dy: 40 },
  { dx: -60, dy: 120 },
];
/** @type {number} 刷新邮件有效期（秒）：田 expireTime ≈ sendTime+14400，超期邮件扫了也白扫 */
const MAIL_FRESH_SEC = 4 * 3600;
/** @type {number} 同一封邮件扫图整轮失败的重试上限（防网络持续异常时无限重发 5 窗高危请求） */
const SCAN_RETRY_MAX = 2;
/** @type {number} 派前复验的免探窗（毫秒）：只有单点 901 复验过才算数，普查入池不算（见文件头 ⚠️） */
const REPROBE_MS = 60 * 1000;
/** @type {number} 候选点被 902 拒后的解禁时长（毫秒）：田下次刷新会复活，到期自动解禁 */
const BLOCK_MS = 30 * 60 * 1000;
/** @type {number} 单轮取田最多派前复验探针数（防一拍连发多枚 901） */
const PROBE_CAP = 2;
/** @type {number} 5 窗扫图请求之间的串行间隔（毫秒，免瞬时并发对服务器加压） */
const SCAN_GAP_MS = 2 * 1000;
/** @type {number} 无待扫邮件时扫图 cycle 的邮件列表轮询兜底节拍（毫秒）：读邮件廉价，自愈漏推 */
const MAIL_POLL_MS = 60 * 1000;
/** @type {number} scanned 去重表保留时长（毫秒）：超过即忘，防去重表无限增长 */
const SCANNED_KEEP_MS = 24 * 3600 * 1000;
/** @type {string} 候选池独立存储键（storage.slot 下、UID 前缀隔离，与账本 blob 互不牵连写放大） */
const STORE_KEY = 'autoFarm.lvl6';
/**
 * @type {number} 存储结构版本：不符整份丢弃。
 * v1 把 resource_type 当面板家族恒等编号（实际 5=石油、7=粮食，标签整体错位）；
 * v2 修正家族但仍用「锚点」做去重键（同锚点 4h 内二次刷新会被当已扫漏掉）；
 * v3 起去重键改邮件 mailKey、scanned 值改对象 → 旧档一律作废重扫重建。
 */
const STORE_VER = 3;
/** @type {string} 6 级田开田邮件标题（国服中文实证文案；竞品B 同口径字面比较） */
const MAIL_TITLE = '遗迹区域刷新';
/**
 * RESOURCE 表 resource_type（游戏 ResourceType 枚举）→ 本 feat 面板资源家族编码（面板码 = floor(RESOURCE.id/100)）。
 * ❗两套编号不同源、**不是恒等**：resource_type 真值 1=Coin(金) / 5=Oila(石油) / 7=Soil(粮食) / 20=ThorElements(雷神)；
 *   报文实证 index.2dd40.js 战斗图标分支直接拿该字段比枚举，GameDefine.ResourceNameConst 亦证 5→「石油」、7→「粮食」。
 * 6 级田的 r.itemId（1514/1515…）不是 groupType id，floor(id/100)=15 会拒掉全部真田 → 家族只认 resource_type 再换算。
 * @type {Object<number,number>}
 */
const RES_TYPE_TO_FAMILY = { 1: 7, 5: 1, 7: 5, 20: 16 };
/**
 * 刷新邮件正文「资源类型为 X」的中文文案 → 面板资源家族编码（报文实证 农田=粮(5)/油田=油(1)；
 * 金矿=金(7) 按 RESOURCE 名称推断，雷神(16) 田上限 3 级、6 级刷新不出现故不收）。
 * @type {Object<string,number>}
 */
const MAIL_TYPE_TO_FAMILY = { 农田: 5, 油田: 1, 金矿: 7 };

/** @type {object|null} 网络底座（promise 封装 pocketcc.net） */
var net = null;
/** @type {function():boolean} 运行态闸门 */
var aliveFn = function () {
  return false;
};

/**
 * 候选池：坐标键 "x,y" → {x,y,family,level:6,ownerId,expireTime,ts(墙上毫秒),probedAt(墙上毫秒),blockedUntil(墙上毫秒)}。
 * ts = 最后一次从报文看到它的时刻（只供老化/展示）；probedAt = 最后一次派前单点复验的时刻（只供免探窗）。
 * @type {Map<string, object>}
 */
var pool = new Map();
/** @type {Object<string, {at:number, anchor:string, family:number, hits:number}>} mailKey → 已扫记录 */
var scanned = {};
/**
 * 待扫邮件：mailKey → {anchor:'x,y', family, sendTime}。
 * @type {Map<string, {anchor:string, family:number, sendTime:number}>}
 */
var pending = new Map();
/** @type {Object<string, number>} mailKey → 整轮失败重试次数 */
var retry = {};
/** @type {boolean} 是否已从盘回填（读盘只做一次） */
var loaded = false;
/** @type {boolean} 是否已成功拉过一次 alliance 邮件首页（单次会话只拉一次） */
var mailLoaded = false;

/**
 * 901 单点 → 候选条目（判据收敛单函数，便于真机校准）：
 * pointType 必为 38（真机 914/914 条无主 6 级田全部 pointType=38）；
 * 家族/等级取 RESOURCE[itemId] 行：family = resource_type 经 RES_TYPE_TO_FAMILY 换算、level = row.level 必须 6；
 * 同盟闸：r.aid 须为本盟（无主田也带 aid，本盟遗迹刷出的田才轮得到本盟采）；
 * ownerId '0'/空=无主可直采，非空则记 expireTime（服务器秒，到期即空出）。
 * @param {object} p 901 pointList 单点
 * @returns {{family:number,level:number,ownerId:string,expireTime:number}|null}
 */
function pointEntry(p) {
  if (!p) return null;
  if ((p.pointType | 0) !== POINT_TYPE_FORTRESS_RES) return null;
  var r = p.r;
  if (!r) return null;
  var itemId = Number(r.itemId) || 0;
  if (!itemId) return null;
  var row = l10n.tableRow('RESOURCE', String(itemId));
  if (!row) return null;
  var fam = RES_TYPE_TO_FAMILY[Number(row.resource_type)] || 0;
  if (!fam) return null;
  if ((Number(row.level) || 0) !== 6) return null;
  var myAid = gameData.myAid();
  if (myAid && Number(r.aid) !== myAid) return null; // 非本盟遗迹刷出的田（myAid 读不到时不拦，保守口径同机械田）
  return {
    family: fam,
    level: 6,
    ownerId: r.ownerId == null ? '0' : String(r.ownerId),
    expireTime: Number(r.expireTime) || 0,
  };
}

/**
 * 单窗应答 → 并入候选池：命中点刷新 ownerId/expireTime/ts（被抢或到期交这里闭环）；
 * blockedUntil 保留既有拉黑时刻（刚被拒的点不因重新扫到就立刻再试）。
 * @param {object[]} points fetchWindow 归一化 pointList
 * @returns {number} 本窗命中的 6 级田数
 */
function ingestPoints(points) {
  var wall = Date.now();
  var hits = 0;
  for (var i = 0; i < points.length; i++) {
    var p = points[i];
    if (!p || p.x == null || p.y == null) continue;
    var e = pointEntry(p);
    if (!e) continue;
    var key = (p.x | 0) + ',' + (p.y | 0);
    var old = pool.get(key);
    pool.set(key, {
      x: p.x | 0,
      y: p.y | 0,
      family: e.family,
      level: 6,
      ownerId: e.ownerId,
      expireTime: e.expireTime,
      ts: wall,
      blockedUntil: old ? old.blockedUntil : 0,
      // 普查只证明「这一刻报文里它无主」，不替派兵背书：ownerId 与上次一致时延续既有复验有效期，
      // 一旦变化（被抢/空出）立刻作废，下一次 pick 必发单点 901
      probedAt: old && String(old.ownerId) === String(e.ownerId) ? old.probedAt || 0 : 0,
    });
    hits++;
  }
  return hits;
}

/**
 * 池老化：田的权威消失时刻就是自带的 expireTime（服务器秒）——到点即田消失，直接从池里忘；
 * 无 expireTime 的条目（报文缺字段）按刷新有效期 MAIL_FRESH_SEC 墙上兜底老化，免陈旧候选长期占位。
 */
function prunePool() {
  var srv = gameData.serverTime() || 0;
  var wall = Date.now();
  pool.forEach(function (e, key) {
    if (e.expireTime) {
      if (srv && srv >= e.expireTime) pool.delete(key);
      return;
    }
    if (wall - (e.ts || 0) > MAIL_FRESH_SEC * 1000) pool.delete(key);
  });
}

/** 去重表老化：只留 SCANNED_KEEP_MS 内的记录（4h 有效期外的邮件本就不会再入队）。 */
function pruneScanned() {
  var wall = Date.now();
  for (var k in scanned) {
    if (!Object.prototype.hasOwnProperty.call(scanned, k)) continue;
    if (wall - ((scanned[k] && scanned[k].at) || 0) > SCANNED_KEEP_MS) delete scanned[k];
  }
}

/**
 * 池 + 去重表落盘（fire-and-forget）：{v, scanned, pool}。失败仅 debug（内存池仍是本轮扫图真相）。
 */
function persist() {
  var arr = [];
  pool.forEach(function (e) {
    arr.push(e);
  });
  Promise.resolve(storage.slot.set(STORE_KEY, { v: STORE_VER, scanned: scanned, pool: arr })).catch(
    function (err) {
      log.debug('persist lvl6 failed. %s', err && err.message);
    },
  );
}

/**
 * 从盘回填池与去重表（run 时一次）：版本不符整份丢弃（连同去重表，使待扫闸重扫重建）；
 * 回填后立即 prunePool 剔过期。读失败/无数据都不覆盖内存（读不到≠空）。
 * @returns {Promise<void>}
 */
function load() {
  if (loaded) return Promise.resolve();
  loaded = true;
  return Promise.resolve(storage.slot.get(STORE_KEY))
    .then(function (saved) {
      if (!saved || typeof saved !== 'object' || saved.v !== STORE_VER) return;
      if (Array.isArray(saved.pool)) {
        for (var i = 0; i < saved.pool.length; i++) {
          var e = saved.pool[i];
          if (e && e.x != null && e.y != null) pool.set((e.x | 0) + ',' + (e.y | 0), e);
        }
      }
      if (saved.scanned && typeof saved.scanned === 'object') {
        for (var kk in saved.scanned) {
          if (Object.prototype.hasOwnProperty.call(saved.scanned, kk))
            scanned[kk] = saved.scanned[kk];
        }
      }
      pruneScanned();
      prunePool();
      log.info(
        'relic store restored from disk. pool=%d scanned=%d',
        pool.size,
        Object.keys(scanned).length,
      );
    })
    .catch(function (err) {
      log.debug('load lvl6 store failed. %s', err && err.message);
    });
}

/**
 * 邮件唯一键：优先 mailId（mail.all() 已按 mailId 去重），缺省回退「刷新时刻 + 家族」
 * （同一时刻同一家族不可能刷两次，够唯一）。
 * @param {object} m 邮件对象
 * @param {number} sendTime 刷新时刻（服务器秒）
 * @param {number} family 邮件正文解析出的家族（0=未知）
 * @returns {string}
 */
function mailKey(m, sendTime, family) {
  var id = m && m.mailId != null ? String(m.mailId) : m && m.id != null ? String(m.id) : '';
  if (id) return id;
  return 't' + (sendTime | 0) + '_' + (family | 0);
}

/**
 * 邮件 → 遗迹刷新信号（报文实证 push 10264 的 ev.data 就是邮件本体：title/content/sendTime 平铺；
 * content 形如「书院✨小北对坐标(408,308)的王者遗迹-资源遗迹进行了刷新操作，此次刷新资源类型为农田。」）。
 * 标题字面匹配 + 正文坐标落在 RELIC_ANCHORS 之一 + 刷新距今 < MAIL_FRESH_SEC。
 * 括号/逗号兼容全半角（同游戏邮件坐标识别口径）。不落在已知锚点的刷新一律不扫（限住扫图爆炸半径）。
 * @param {object} m 邮件对象 {title,content,sendTime}
 * @returns {{key:string, anchor:string, x:number, y:number, sendTime:number, family:number}|null}
 */
function parseRelicMail(m) {
  if (!m || m.title !== MAIL_TITLE) return null;
  var st = Number(m.sendTime) || 0;
  var now = gameData.serverTime() || 0;
  if (!st || (now && now - st >= MAIL_FRESH_SEC)) return null; // 过期刷新：田早已消失，扫了也白扫
  var content = String(m.content || '');
  var mt = content.match(/坐标[（(](\d+)[，,](\d+)[)）]/);
  if (!mt) return null;
  var x = Number(mt[1]) | 0;
  var y = Number(mt[2]) | 0;
  var tm = content.match(/资源类型为\s*([^\s。]+)。/);
  var fam = tm && MAIL_TYPE_TO_FAMILY[tm[1]] != null ? MAIL_TYPE_TO_FAMILY[tm[1]] : 0;
  for (var i = 0; i < RELIC_ANCHORS.length; i++) {
    var a = RELIC_ANCHORS[i];
    if (a.x === x && a.y === y) {
      return {
        key: mailKey(m, st, fam),
        anchor: x + ',' + y,
        x: x,
        y: y,
        sendTime: st,
        family: fam,
      };
    }
  }
  return null;
}

/**
 * 记待扫邮件（以 mailKey 去重：同封邮件被推送/轮询多次检测也只入队一次）。
 * @param {object} r parseRelicMail 命中结果
 * @returns {boolean} 是否新入队（false = 已扫过或已在队列）
 */
function markPending(r) {
  if (scanned[r.key]) return false;
  if (pending.has(r.key)) return false;
  pending.set(r.key, { anchor: r.anchor, family: r.family, sendTime: r.sendTime });
  return true;
}

/**
 * 一批邮件里拣出刷新信号并记待扫（纯读，不改游戏数据）。
 * @param {object[]} list 邮件数组
 * @returns {number} 新入队数
 */
function scanMails(list) {
  if (!Array.isArray(list)) return 0;
  var n = 0;
  for (var i = 0; i < list.length; i++) {
    var r = parseRelicMail(list[i]);
    if (r && markPending(r)) n++;
  }
  if (n) log.info('relic refresh mails queued=%d', n);
  return n;
}

/**
 * 10264 PUSH_SINGLE_MAIL：单封邮件推送 → 命中即记待扫。
 * 保留容错：先 parseData 拆可能串化的业务体，再探 d.mail / d.data.mail / d。
 * @param {object} ev net 推送事件（载荷在 ev.data）
 * @returns {boolean} 是否新入队（供调用方决定是否 kick 扫图 cycle）
 */
function onMailPush(ev) {
  var d = parseData(ev && ev.data);
  if (!d || typeof d !== 'object') return false;
  var m = d.mail || (d.data && d.data.mail) || d;
  var r = parseRelicMail(m);
  if (!r) return false;
  if (!markPending(r)) return false;
  log.info('relic refresh mail push. mail=%s anchor=%s sendTime=%d', r.key, r.anchor, r.sendTime);
  return true;
}

/**
 * 扫图 cycle 主体（独立于派兵 cycle）：
 * ① 无遗迹家族勾选 / 邮件系统未就绪 → 直接睡轮询节拍（不发任何 901、不读邮件）；
 * ② 把邮件列表近期刷新喂进 mailKey 去重闸（与 10264 推送同源，重复检测不会重复扫），
 *    缓存空且从未成功 load 过时显式拉一次 alliance 首页（与玩家点开邮箱同源、零副作用）；
 * ③ 消费**一封**待扫邮件：家族闸不过则记已扫跳过；否则串行发 5 窗 901（窗间 sleep SCAN_GAP_MS），
 *    命中点入池、随即 prunePool + persist。整轮窗全失败 → 回退去重、退回待扫集重试（封顶 SCAN_RETRY_MAX）。
 * @param {Set<number>} wanted 当前面板勾选的遗迹家族集合（空集 = 无遗迹行，不扫）
 * @returns {Promise<number>} 下拍间隔：仍有待扫→0（立即续扫下一封）；否则 MAIL_POLL_MS
 */
async function scanPass(wanted) {
  if (!wanted || !wanted.size) return MAIL_POLL_MS;
  if (!mail.ready()) return MAIL_POLL_MS; // 邮件 subpack 未就绪：下拍自然重探
  if (!scanMails(mail.all())) {
    // 缓存里一条刷新都没有：面板从未开过时缓存为空，显式拉一次 alliance 首页进游戏缓存再扫第二遍
    if (!mailLoaded) {
      mailLoaded = !!(await mail.load('alliance'));
      if (mailLoaded && aliveFn()) scanMails(mail.all());
    }
  }
  if (!aliveFn()) return MAIL_POLL_MS;
  pruneScanned();
  if (!pending.size) return MAIL_POLL_MS;

  // 一拍一邮件消费（邮件间靠 return 0 续跑，便于暂停逐封复查 alive）
  var key = null;
  pending.forEach(function (v, k) {
    if (key === null) key = k;
  });
  var entry = pending.get(key);
  pending.delete(key);

  // 家族闸：邮件标了具体家族但未勾选 → 记已扫、整锚点不扫（省 5 窗高危 901）；family=0（未知文案）照扫
  if (entry.family > 0 && !wanted.has(entry.family)) {
    scanned[key] = { at: Date.now(), anchor: entry.anchor, family: entry.family, hits: 0 };
    persist();
    log.debug('relic scan skipped (family=%d not selected). mail=%s', entry.family, key);
    return pending.size ? 0 : MAIL_POLL_MS;
  }

  var pos = entry.anchor.split(',');
  var ax = Number(pos[0]) | 0;
  var ay = Number(pos[1]) | 0;
  var k = worldMap.serverId();
  var hits = 0;
  var failed = 0;
  for (var wi = 0; wi < WINDOWS.length; wi++) {
    if (!aliveFn()) break;
    var w = WINDOWS[wi];
    var r = await map.fetchWindow(net, ax + w.dx, ay + w.dy, {
      k: k,
      width: WIN.w,
      height: WIN.h,
      viewLevel: 1,
      marchInfo: false, // 靠 856 taken + 派前复验 + 被拒解禁，不需要 marchList 这层
    });
    if (r.ok) hits += ingestPoints(r.points);
    else failed++; // 单窗失败不致命：田低频，下次刷新邮件再扫自愈
    if (wi < WINDOWS.length - 1) await sleep(SCAN_GAP_MS); // 窗间串行，免瞬时并发对服务器加压
  }
  prunePool();
  scanned[key] = { at: Date.now(), anchor: entry.anchor, family: entry.family, hits: hits };
  persist();
  log.info(
    'relic scan mail=%s anchor=%s windows=%d failed=%d lvl6=%d pool=%d',
    key,
    entry.anchor,
    WINDOWS.length,
    failed,
    hits,
    pool.size,
  );
  // 整轮窗全失败（网络抖动/切场景）→ 回退去重、退回待扫集重试；任何一窗成功即清零
  if (failed === WINDOWS.length) {
    var tries = retry[key] || 0;
    if (tries < SCAN_RETRY_MAX) {
      retry[key] = tries + 1;
      delete scanned[key];
      pending.set(key, entry);
      log.debug('relic scan all windows failed, re-queued. mail=%s tries=%d', key, tries + 1);
    } else {
      delete retry[key];
    }
  } else {
    delete retry[key];
  }
  return pending.size ? 0 : MAIL_POLL_MS;
}

/**
 * 派前单点复验：中心定点 901 确认该点仍是 pointEntry 口径的 6 级田。
 * 命中即刷新条目 ownerId/expireTime/ts；已非 6 级田 → 移出池。永不 reject。
 * @param {object} e 候选池条目
 * @returns {Promise<{status:'ok'|'gone'|'error', ownerId?:string, expireTime?:number}>}
 */
function probePoint(e) {
  var key = e.x + ',' + e.y;
  return map
    .fetchWindow(net, e.x, e.y, { k: worldMap.serverId() })
    .then(function (r) {
      if (!r.ok) return { status: 'error' };
      for (var i = 0; i < r.points.length; i++) {
        var p = r.points[i];
        if (!p || (p.x | 0) !== e.x || (p.y | 0) !== e.y) continue;
        var ent = pointEntry(p);
        if (!ent) {
          pool.delete(key);
          return { status: 'gone' };
        }
        var old = pool.get(key);
        pool.set(key, {
          x: e.x,
          y: e.y,
          family: ent.family,
          level: 6,
          ownerId: ent.ownerId,
          expireTime: ent.expireTime,
          ts: Date.now(),
          blockedUntil: old ? old.blockedUntil : 0,
          probedAt: Date.now(), // 单点复验：这条就是「刚刚亲眼看过」的凭据，免探窗只认它
        });
        return { status: 'ok', ownerId: ent.ownerId, expireTime: ent.expireTime };
      }
      pool.delete(key);
      return { status: 'gone' };
    })
    .catch(function () {
      return { status: 'error' };
    });
}

/**
 * 该坐标是否还有「可下」的遗迹候选（升级判定用的廉价窥视，零发包）。
 * @param {number} family 资源家族编码
 * @param {Set<string>} taken 本轮已占用/已派点键
 * @param {function(string):boolean} [isBlocked] 坐标黑名单判定
 * @returns {number} 有可下候选回 6（遗迹田等级恒 6），否则 0
 */
function peek(family, taken, isBlocked) {
  var wall = Date.now();
  var srv = gameData.serverTime() || 0;
  var found = 0;
  pool.forEach(function (e, key) {
    if (found || e.family !== family) return;
    if (e.blockedUntil > wall) return;
    if (taken && taken.has(key)) return;
    if (isBlocked && isBlocked(key)) return;
    if (e.ownerId !== '0') return;
    if (e.expireTime && srv && srv >= e.expireTime) return;
    found = 6;
  });
  return found;
}

/**
 * 为一行遗迹田从候选池取点：排序「无主优先 → expireTime 升序（同批田共享到期时刻，先拿将消失的）→ 距本城最近」；
 * 距上次派前复验超 REPROBE_MS 的候选，发单点 901 复验仍无主才返回（本轮探针上限 PROBE_CAP）；被抢/已毁即跳过换下一候选。
 * @param {number} family 资源家族编码
 * @param {Set<string>} taken 本轮已占用/已派点键
 * @param {function(string):boolean} [isBlocked] 坐标黑名单判定
 * @returns {Promise<{x:number,y:number,level:number,family:number}|null>}
 */
async function pick(family, taken, isBlocked) {
  var my = gameData.myWorldPos();
  var wall = Date.now();
  var srv = gameData.serverTime() || 0;
  var cands = [];
  pool.forEach(function (e, key) {
    if (e.family !== family) return;
    if (e.blockedUntil > wall) return;
    if (taken && taken.has(key)) return;
    if (isBlocked && isBlocked(key)) return;
    if (e.expireTime && srv && srv >= e.expireTime) return;
    var d = my ? Math.abs(e.x - my.x) + Math.abs(e.y - my.y) : 0;
    cands.push({ e: e, free: e.ownerId === '0', d: d });
  });
  cands.sort(function (a, b) {
    return (
      (a.free ? 0 : 1) - (b.free ? 0 : 1) ||
      (a.e.expireTime || 0) - (b.e.expireTime || 0) ||
      a.d - b.d
    );
  });
  var probed = 0;
  for (var i = 0; i < cands.length; i++) {
    var e = cands[i].e;
    if (e.ownerId !== '0') break; // 有序：首个被占即其后全被占，到期时刻交精准唤醒，不再看下去
    if (wall - (e.probedAt || 0) >= REPROBE_MS) {
      if (probed >= PROBE_CAP) break; // 本轮探针额度用尽，缺位留 active 档下拍续
      probed++;
      var pr = await probePoint(e);
      if (!aliveFn()) return null;
      if (pr.status === 'gone') continue;
      if (pr.status === 'error') return null; // 网络未知：本行本轮不派、不拉黑，下拍重试
      if (pr.ownerId !== '0') continue; // 被抢：条目已刷新为占用态+到期时刻，换下一候选
    }
    return { x: e.x, y: e.y, level: 6, family: e.family };
  }
  return null;
}

/**
 * 902 被拒后把该坐标记入解禁表（田下次刷新会复活，到期自动解禁；异于普通/机械田的 run 期硬拉黑）。
 * @param {number} x 坐标 x
 * @param {number} y 坐标 y
 * @param {number} [ms] 解禁时长（毫秒），缺省 BLOCK_MS
 */
function block(x, y, ms) {
  var key = (x | 0) + ',' + (y | 0);
  var e = pool.get(key);
  if (!e) return;
  var wall = Date.now();
  var until = wall + (Number(ms) || BLOCK_MS);
  // 已知这块田的权威到期时刻（报文实证：被占时 expireTime = 对方采完/田消失的服务器秒）就按它提前解禁：
  // 固定 30 分钟会把「几分钟就空出来的田」白钉大半，而遗迹田本就 4 小时才刷一批（取 min，无到期时刻仍走缺省）
  var srv = gameData.serverTime() || 0;
  if (e.expireTime && srv && e.expireTime > srv) {
    var untilExpire = wall + (e.expireTime - srv) * 1000;
    if (untilExpire < until) until = untilExpire;
  }
  e.blockedUntil = until;
  persist();
}

/** @param {string} key "x,y" @returns {boolean} 该坐标是否在遗迹池（用于判断在途田是否为遗迹田） */
function has(key) {
  return pool.has(key);
}

/** @param {string} key "x,y" @returns {object|undefined} 池条目（用于反查在途田的家族/等级） */
function entryAt(key) {
  return pool.get(key);
}

/** @returns {number} 池规模（诊断用） */
function size() {
  return pool.size;
}

/** @returns {number} 待扫邮件数（诊断用） */
function pendingCount() {
  return pending.size;
}

/**
 * 按家族体检池（诊断「只下粮不下油」这类取不到点的根因分流）：统计该家族 matched/free/owned/blocked 计数。
 * matched=0 说明扫图根本没把该家族田入池（家族映射/入池判据问题）；matched>0 而 free=0 说明有田但全被占。
 * @param {number} family 面板家族码
 * @returns {string} 供日志的分解串
 */
function describe(family) {
  var wall = Date.now();
  var total = 0;
  var matched = 0;
  var free = 0;
  var owned = 0;
  var blocked = 0;
  pool.forEach(function (e) {
    total++;
    if (e.family !== family) return;
    matched++;
    if (e.blockedUntil > wall) {
      blocked++;
      return;
    }
    if (e.ownerId === '0') free++;
    else owned++;
  });
  return (
    'pool=' +
    total +
    ' fam=' +
    family +
    ' matched=' +
    matched +
    ' free=' +
    free +
    ' owned=' +
    owned +
    ' blocked=' +
    blocked
  );
}

/**
 * 安装：绑定网络底座与运行态闸门。
 * @param {{net:object, alive:function():boolean}} o
 */
function install(o) {
  net = o.net;
  aliveFn = o.alive;
}

/** run 复位：清空内存池/去重表/待扫队列（盘上数据由 load() 重新回填） */
function reset() {
  pool = new Map();
  scanned = {};
  pending = new Map();
  retry = {};
  loaded = false;
  mailLoaded = false;
}

/** 遗迹田扫描器单例 */
export const relic = {
  CMD_PUSH_MAIL: PUSH_SINGLE_MAIL,
  MAIL_POLL_MS,
  install,
  reset,
  load,
  persist,
  prunePool,
  pruneScanned,
  scanPass,
  scanMails,
  onMailPush,
  pick,
  peek,
  block,
  has,
  entryAt,
  size,
  pendingCount,
  describe,
};
