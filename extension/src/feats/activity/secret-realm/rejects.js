/**
 * secret-realm 8521 拒码处置**共享真相表**（三-3：pilot 行军档 / boss 攻打档共用一套码义）。
 *
 * 分层口径：表只声明「该码是什么、各引擎该怎么处置」（拉黑表/TTL/清相位/退避/副作用/日志模板），
 *   「怎么执行」归各引擎的解释器（pilot.#applyReject / boss.#handleMarchReject）——
 *   两引擎的相位与账本不同，动作不可互搬，但**码义与处置参数只此一份**，改码只改本表。
 *
 * 共享语义（两引擎同口径）：
 *   • 157 已在该点 = 到达；158 在途未到 = 瞬态（不拉黑）；
 *   • 159995 该点当前不可打 = 阶段态，短黑 `tuning.paramBlacklistMs`(60s)，窗过自然恢复，
 *     绝不走 6h 长黑（那是 163 的永久错语义）、绝不拉黑 BOSS 本体（权威坐标）。
 * 刻意差异（历史报文定稿，不可强行统一）：
 *   • 163：pilot 派发前已预付 marched 60s 冷却（不拉黑）；boss 攻打拉黑坐标 rejectBlacklistMs(6h)。
 *   • 142：pilot 只黑平台（boss-plane 档）；boss 只降级配对、不黑 bossId。
 *   • 141：pilot 黑平台换下一块；boss 等 push 21521 刷正 roomBaseInfo，退避 planeRefreshMs(15s)。
 *   • 17：pilot 子串匹配（reason 可能带前缀）且本场停手；boss 攻打链未登记 → 走兜底。
 *
 * 日志模板逐字保留旧文案（dashcam 日志流 grep 契约）；占位符参数用 token 声明，
 *   由各引擎解释器解析（pilot: xy/kind/rej/codeOrRej/marchedSec/paramSec/backoffSec；
 *   boss: tag/rej/codeOrRej/platEsr/rejectBackoffMs/planeRefreshMs/paramBlacklistMs）。
 * `edge` 非空 = 首见 info/再次 debug 的边沿模式（键 = edge + '|' + tag）。
 */
import {
  REJ_BATTLEFIELD_CLOSING,
  REJ_ALREADY_THERE,
  REJ_NOT_ARRIVED,
  REJ_POINT_NOT_EXIST,
  REJ_NO_MARCH_TARGET,
  REJ_SAME_AREA_PLANE,
  REJ_NEED_PLANE,
  REJ_BOSS_AREA,
  REJ_PLANE_TAKEN,
  REJ_PARAM_ERROR,
  REJ_RETRY,
} from './constants.js';

/**
 * @typedef {object} RejectLogSpec
 * @property {'info'|'debug'|'note'} lvl note=一次性提示（pilot #told 边沿；key/keyPrefix 定键）
 * @property {string} tpl printf 模板（逐字保留旧文案）
 * @property {string} [again] 边沿模式的「再次」模板（lvl 降 debug）
 * @property {string} [edge] boss 边沿键前缀（'arrive158' 等；空=每次同档输出）
 * @property {string} [key] pilot note 的固定键（如 'realm-closed'）
 * @property {string} [keyPrefix] pilot note 的键前缀（拼 toXY，如 'param-error|'）
 * @property {string[]} [args] token 清单（按模板占位符顺序）
 */

/**
 * @typedef {object} RejectRule
 * @property {string} code 拒码常量（REJ_*）
 * @property {string} name 语义名（日志/测试/诊断用）
 * @property {'exact'|'contains'} match reason 匹配方式（仅 17 用 contains）
 * @property {object} [pilot] 行军档处置（缺省=该引擎走兜底）
 * @property {object} [boss] 攻打档处置（缺省=该引擎走兜底）
 */

/** @type {Object<string,RejectRule>} 拒码 → 处置（键即 code；插入序即匹配序） */
export const REJECT_RULES = {
  [REJ_BATTLEFIELD_CLOSING]: {
    code: REJ_BATTLEFIELD_CLOSING,
    name: 'realm-closing',
    match: 'contains',
    pilot: {
      stopMatch: true,
      clearTo: true,
      log: {
        lvl: 'note',
        key: 'realm-closed',
        tpl:
          'pilot: realm entered closing phase (server returned ' +
          REJ_BATTLEFIELD_CLOSING +
          ' "battlefield closing soon"), all marches rejected, this match stops driving. reason=realm_closed',
      },
    },
  },
  [REJ_ALREADY_THERE]: {
    code: REJ_ALREADY_THERE,
    name: 'already-there',
    match: 'exact',
    pilot: { enterWork: true },
    boss: {
      area: 'ok',
      log: {
        lvl: 'debug',
        tpl: 'boss attack: %s rejected %s (already there).',
        args: ['tag', 'rej'],
      },
    },
  },
  [REJ_NOT_ARRIVED]: {
    code: REJ_NOT_ARRIVED,
    name: 'in-flight',
    match: 'exact',
    // pilot：不记退避、不改相位，下一拍自然重评；boss：入口退避已写，只留痕等 21529
    pilot: { keepPhase: true },
    boss: {
      keepPhase: true,
      log: {
        lvl: 'info',
        edge: 'arrive158',
        tpl: 'boss attack: %s rejected %s (team not arrived) → backoff %dms, will resume on push 21529, NOT probing/blacklisting.',
        again: 'boss attack: %s still rejected %s (waiting 21529).',
        args: ['tag', 'rej', 'rejectBackoffMs'],
      },
    },
  },
  [REJ_POINT_NOT_EXIST]: {
    code: REJ_POINT_NOT_EXIST,
    name: 'point-gone',
    match: 'exact',
    pilot: {
      // BOSS 本体坐标来自权威态，撞 159 不代表「BOSS 不存在」→ 只黑平台/巡航点
      black: 'day',
      unlessTag: 'boss',
      dropShop: true,
      clearTo: true,
      backoff: 'rejectBackoffMs',
      log: {
        lvl: 'info',
        tpl: 'pilot: (%s) target point not exist (159), blacklisted for this match.',
        args: ['xy'],
      },
    },
  },
  [REJ_NO_MARCH_TARGET]: {
    code: REJ_NO_MARCH_TARGET,
    name: 'no-march',
    match: 'exact',
    // pilot：marched 已在派发前预付 60s，不再拉黑；boss：目标点不能行军=永久错，长黑
    pilot: {
      clearTo: true,
      backoff: 'rejectBackoffMs',
      log: {
        lvl: 'info',
        tpl: 'pilot: (%s) cannot march (163), no re-pick for %ds.',
        args: ['xy', 'marchedSec'],
      },
    },
    boss: {
      black: 'target',
      ttl: 'rejectBlacklistMs',
      log: {
        lvl: 'info',
        tpl: 'boss attack: %s rejected %s → target blacklisted.',
        args: ['tag', 'rej'],
      },
    },
  },
  [REJ_SAME_AREA_PLANE]: {
    code: REJ_SAME_AREA_PLANE,
    name: 'same-area',
    match: 'exact',
    // 拒绝取决于本队当前停泊位（真机实证挪位后同点可成功）→ 与 163 同档不拉黑
    pilot: {
      clearTo: true,
      backoff: 'rejectBackoffMs',
      log: {
        lvl: 'info',
        tpl: 'pilot: (%s) same-area platform move forbidden (209), no re-pick for %ds (not blacklisted, may turn favorable after moving).',
        args: ['xy', 'marchedSec'],
      },
    },
  },
  [REJ_NEED_PLANE]: {
    code: REJ_NEED_PLANE,
    name: 'need-plane',
    match: 'exact',
    pilot: {
      black: 'day',
      onlyTag: 'boss-plane', // 必须与 pilot.js KIND_BOSS_PLANE 同值
      clearTo: true,
      backoff: 'rejectBackoffMs',
      log: {
        lvl: 'info',
        tpl: 'pilot: (%s) platform unavailable (%s), blacklist this platform for this match, pick another.',
        args: ['xy', 'rej'],
      },
    },
    boss: {
      backoff: 'planeRefreshMs',
      log: {
        lvl: 'info',
        edge: 'plane141',
        tpl: 'boss attack: %s rejected %s (server says not on 176 plane) → idle %dms waiting for push 21521 to refresh roomBaseInfo, NOT resending.',
        again: 'boss attack: %s still rejected %s (waiting 21521).',
        args: ['tag', 'rej', 'planeRefreshMs'],
      },
    },
  },
  [REJ_BOSS_AREA]: {
    code: REJ_BOSS_AREA,
    name: 'wrong-area',
    match: 'exact',
    pilot: {
      black: 'day',
      onlyTag: 'boss-plane',
      clearTo: true,
      backoff: 'rejectBackoffMs',
      log: {
        lvl: 'info',
        tpl: 'pilot: (%s) platform unavailable (%s), blacklist this platform for this match, pick another.',
        args: ['xy', 'rej'],
      },
    },
    boss: {
      area: 'demote',
      log: {
        lvl: 'info',
        tpl: 'boss attack: %s rejected %s (platform area esr=%s != boss area) → pair demoted, boss NOT blacklisted.',
        args: ['tag', 'rej', 'platEsr'],
      },
    },
  },
  [REJ_PLANE_TAKEN]: {
    code: REJ_PLANE_TAKEN,
    name: 'plane-taken',
    match: 'exact',
    pilot: {
      black: 'day',
      onlyTag: 'boss-plane',
      clearTo: true,
      backoff: 'rejectBackoffMs',
      log: {
        lvl: 'info',
        tpl: 'pilot: (%s) platform unavailable (%s), blacklist this platform for this match, pick another.',
        args: ['xy', 'rej'],
      },
    },
  },
  [REJ_PARAM_ERROR]: {
    code: REJ_PARAM_ERROR,
    name: 'param-error',
    match: 'exact',
    // 共享真相：阶段态短黑 paramBlacklistMs(60s)，两引擎同 TTL；不黑 BOSS 本体、不烧区域试探
    pilot: {
      black: 'param',
      clearReturn: true, // toTag==='return' 时清回攻待办（否则每 5s 重敲 return|同点死循环）
      refreshBoss: true, // 触发 21535 主动复拉（限速），让 BOSS 阶段态尽快转正
      clearTo: true,
      backoff: 'rejectBackoffMs',
      log: {
        lvl: 'note',
        keyPrefix: 'param-error|',
        tpl: 'pilot: (%s) target not attackable now (159995), short-blacklist %ds, switch target. reason=param_error',
        args: ['xy', 'paramSec'],
      },
    },
    boss: {
      black: 'target',
      ttl: 'paramBlacklistMs',
      log: {
        lvl: 'info',
        edge: 'param159995',
        tpl: 'boss attack: %s rejected %s (point not attackable now) → target blacklisted %dms, area probe NOT burned.',
        again: 'boss attack: %s still rejected %s (waiting blacklist to expire).',
        args: ['tag', 'rej', 'paramBlacklistMs'],
      },
    },
  },
  [REJ_RETRY]: {
    code: REJ_RETRY,
    name: 'retry-once',
    match: 'exact',
    boss: {
      retryOnce: true,
      log: { lvl: 'debug', tpl: 'boss attack: %s rejected %s, retry once.', args: ['tag', 'rej'] },
    },
  },
};

/**
 * reason → 命中规则（contains 档按子串、其余全等；未登记回 null → 调用方走兜底）。
 * @param {string} rej 服务端 reason（REJ_* 形态）
 * @returns {RejectRule|null}
 */
export function matchReject(rej) {
  const s = String(rej || '');
  const rules = Object.values(REJECT_RULES);
  for (let i = 0; i < rules.length; i++) {
    const ru = rules[i];
    if (ru.match === 'contains' ? s.indexOf(ru.code) >= 0 : s === ru.code) return ru;
  }
  return null;
}
