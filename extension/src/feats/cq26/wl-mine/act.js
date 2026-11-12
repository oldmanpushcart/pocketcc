/**
 * CQ26 荒芜冰原矿区 · 写动作管道（feats/cq26/wl-mine/act.js）
 *
 * 本模块是整个 feat **唯一**发写请求的地方（只读在 survey.js），这样「只读+发包」红线
 *   与「四态归一（成功 / 业务拒绝 / 未出网 / 应答畸形）」的口径只有一个收口点。
 *
 * 载荷形态**逐键照源码与实录**，不加不减（红线：不靠猜）：
 *   2114 → `{wastelandIndex: p.specIndex, x, y}`  实证 `{9,682,384}`/`{9,716,436}` —— 注意 `wastelandIndex`
 *         取的是**点的 `m.specIndex`**、不是 2201 的 `showNum`（两者实测相等，但真相源只有地块那一份，
 *         见 docs/acl-cq26-荒芜冰原.md 坑 14 的三条反证）；源码逐字 `CQ26WLWorldGatherPop.sendCollect(specIndex, tileX, tileY)`
 *         （上游 click 处理器先校 `tileX/tileY/specIndex` 三者非 null 才发，缺 specIndex 直接 return，等价本层 canGather 的 `no-spec-index` 闸）。
 *   2115 → `{wkid: p.k, x, y}`  实证 `{14003212,101,343}`；源码 `CQ26WLWorldResourceBubble` 盗采分支。
 *   2116 → `{wkid: p.k, x, y}`  实证 `{14002112,639,279}`；同源码协助分支。
 *   2121 → `{marchId: Int64}`    源码 `CQ26WasteLandData` 召回分支逐字 `{marchId: Int64.fromString(e)}`，
 *         即入参本来就是十进制字符串再装箱；本模块同样走 `bits.int64(str)`，装箱失败**绝不降级成 Number**
 *         （19 位雪花 id 走 Number 会末位丢精度 → 服务器「找不到行军」）。
 *
 * 永不 reject：`net.sendGuarded(..., {protocol:'sendPBV2'})` 未出网回 `CODE_NOT_SENT`，
 *   本层再把它归一成 `{ok:false, sent:false}`；调用方据 `sent` 决定占不占「拒绝计数」（未出网不该拉黑目标）。
 *
 * 额度权威在 22072（`gameData.cq26WlInfo()`）：2115/2116 应答里虽也带 `remainStealNum/remainGuardNum`，
 *   但本层**只把它回吐给调用方做日志**，绝不落地记账（ACL 坑 3）。
 */
import { createLog } from '../../../core/log.js';
import { bits } from '../../../core/game-api.js';
import { CODE_NOT_SENT, rejectText } from '../../../core/util.js';
import { CMD_GATHER, CMD_HELP, CMD_RECALL, CMD_STEAL } from './constants.js';

/** @type {ReturnType<createLog>} */
const log = createLog('CQ26-MINE-ACT');

/** Int64 装箱不可用时的判据门槛：超过此位数的数字串绝不允许走 Number 兜底（2^53 ≈ 9.007e15，16 位起有风险）。 */
const INT64_SAFE_DIGITS = 15;

/**
 * 统一写动作管线（四个 cmd 同一条路）。
 * @param {object} net 已安装 net
 * @param {number} cmd 命令号
 * @param {object} body 逐键照实录的载荷
 * @param {string} tag 日志语境标识（不参与编码）
 * @returns {Promise<{ok:boolean, sent:boolean, code:*, data:object|null, reason:string, label:string}>}
 */
async function sendWrite(net, cmd, body, tag) {
  if (!net) {
    return {
      ok: false,
      sent: false,
      code: CODE_NOT_SENT,
      data: null,
      reason: 'no-net',
      label: tag,
    };
  }
  var threw = '';
  var ret = await net.sendGuarded(cmd, body, {
    protocol: 'sendPBV2',
    onError: function (err) {
      threw = (err && err.message) || String(err);
    },
  });
  var notSent = !ret || ret.code === CODE_NOT_SENT;
  return {
    ok: !notSent && !!(ret && ret.ok),
    sent: !notSent,
    code: ret ? ret.code : CODE_NOT_SENT,
    data: (ret && ret.data) || null,
    reason: notSent ? threw || 'not sent' : rejectText(ret),
    label: tag,
  };
}

/**
 * 采集派兵（2114）。
 * @param {object} net 已安装 net
 * @param {object} point 已过 canGather 的归一点（`specIndex` 必须非空，legs.js 已挡）
 * @returns {Promise<object>} sendWrite 归一结果
 */
export function dispatchGather(net, point) {
  return sendWrite(
    net,
    CMD_GATHER,
    { wastelandIndex: Number(point.specIndex) | 0, x: Number(point.x) | 0, y: Number(point.y) | 0 },
    'gather(' + point.x + ',' + point.y + ')',
  );
}

/**
 * 盗采（2115，即时结算、不派兵）。
 * @param {object} net 已安装 net
 * @param {object} point 已过 canSteal 的归一点（`k` = 房间 wkid）
 * @returns {Promise<object>} sendWrite 归一结果
 */
export function doSteal(net, point) {
  return sendWrite(
    net,
    CMD_STEAL,
    { wkid: Number(point.k) | 0, x: Number(point.x) | 0, y: Number(point.y) | 0 },
    'steal(' + point.x + ',' + point.y + ')',
  );
}

/**
 * 协助（2116，即时结算、不扣 owner 的 gNum）。
 * @param {object} net 已安装 net
 * @param {object} point 已过 canHelp 的归一点
 * @returns {Promise<object>} sendWrite 归一结果
 */
export function doHelp(net, point) {
  return sendWrite(
    net,
    CMD_HELP,
    { wkid: Number(point.k) | 0, x: Number(point.x) | 0, y: Number(point.y) | 0 },
    'help(' + point.x + ',' + point.y + ')',
  );
}

/**
 * 召回采集行军（2121）：到账由服务器在这一发之后自行结算（10264 采集报告邮件 + 10001），本层不校验。
 * @param {object} net 已安装 net
 * @param {string} marchIdStr 十进制字符串形态的 marchId（march-loop.js 解析所得）
 * @returns {Promise<object>} sendWrite 归一结果；装箱不可行时 `{ok:false, sent:false, reason:'int64-unbox'}` 且**不出网**
 */
export function doRecall(net, marchIdStr) {
  var s = String(marchIdStr == null ? '' : marchIdStr);
  if (!/^\d+$/.test(s)) {
    log.warn('%d recall skipped: marchId is not a decimal string. raw=%s', CMD_RECALL, s);
    return Promise.resolve({
      ok: false,
      sent: false,
      code: CODE_NOT_SENT,
      data: null,
      reason: 'bad-marchId',
      label: 'recall(' + s + ')',
    });
  }
  var boxed = bits.int64(s);
  if (typeof boxed !== 'object' && s.length > INT64_SAFE_DIGITS) {
    // 装箱失败（符号漂移）⇒ 宁可这一拍不召回，也绝不发一个丢精度的数过去（发出去就是「找不到行军」的假成功）
    log.warn('%d recall blocked: Int64 boxing unavailable (digits=%d).', CMD_RECALL, s.length);
    return Promise.resolve({
      ok: false,
      sent: false,
      code: CODE_NOT_SENT,
      data: null,
      reason: 'int64-unbox',
      label: 'recall(' + s + ')',
    });
  }
  return sendWrite(net, CMD_RECALL, { marchId: boxed }, 'recall(' + s + ')');
}

/**
 * 应答形状核对（只出日志，不当额度源）：2115/2116 缺 `rewardResult` 属畸形应答，warn 一次由调用方决定本拍是否停腿。
 * @param {object} res sendWrite 归一结果
 * @returns {{reward:object|null, quotaKey:string, quota:number|null, malformed:boolean}}
 */
export function readReward(res) {
  var d = (res && res.data) || {};
  var reward = d.rewardResult && typeof d.rewardResult === 'object' ? d.rewardResult : null;
  var quota = null;
  var quotaKey = '';
  if (d.remainStealNum != null) {
    quotaKey = 'remainStealNum';
    quota = Number(d.remainStealNum) || 0;
  } else if (d.remainGuardNum != null) {
    quotaKey = 'remainGuardNum';
    quota = Number(d.remainGuardNum) || 0;
  }
  return {
    reward: reward,
    quotaKey: quotaKey,
    quota: quota,
    malformed: !!(res && res.ok) && !reward,
  };
}
