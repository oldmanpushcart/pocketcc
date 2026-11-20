/**
 * feats/activity/cs-hunt/session-mode.js —— 夺宝奇兵（CSHunt）「各场模式矩阵」纯查询。
 *
 * 定位：面板「按场次设置模式」开关（modeBySession，默认关）开时挂 3×3 矩阵（周五/周六/周日 ×
 *   第一/二/三场），每格两档 main（主跑）/ helper（陪跑）；关时矩阵隐藏且引擎完全忽略（有效模式
 *   恒=主设置 cfg.mode，与旧版逐字等价）。follow 仅作内部「未定制」标记：开启开关瞬间由
 *   seedFollowModes 播种为当时主设置（面板回写与 normalize 双路同口径），运行时不应残留。
 *   本模块把「当前服务器时刻落在周几第几场」与「该格有效模式」两处纯逻辑收口，供
 *   engine-team.js #cfg() 注入与 index.js 面板状态行共用。
 *   不发包、不摸 net/reactor/控制器，故可独立单测（同 skills.js/codebox.js 纯函数范式）。
 *
 * 场次判定**数据驱动**：不硬编码钟表时间。slots 来自 7501 应答 openTime[]（csHunt.parseSchedule，
 *   每项 {begin,end} 服务器毫秒，每天 3 个 2h 时段）；「周几」取时段 begin 的星期、「第几场」=
 *   同日时段按 begin 排序的序号。星期/日界用本地时区格式化服务器时间（todayStr 口径，与
 *   core/daily-stats「国服 UTC+8 对齐游戏日界」既定约定一致）。
 *
 * 兜底：开关关、格子=follow（未播种残留）、时段表未知/不在场次内/星期非周五六日/同日超 3 场
 *   → 沿用主设置 cfg.mode（窗外写包本就被 engine-team #gateActivity 双闸拦截，此处兜底只影响展示与决策语义）。
 */
import { todayStr } from '../../../core/util.js';

/**
 * 9 个扁平面板键（行=周五/六/日，列=第 1/2/3 场）：defaults/normalize/isMain/引擎解析共用同一份，
 *   键名即 'mode' + 星期缩写 + 场序（如 modeFri2 = 周五第二场）。
 * @type {string[]}
 */
export const SESSION_KEYS = [
  'modeFri1',
  'modeFri2',
  'modeFri3',
  'modeSat1',
  'modeSat2',
  'modeSat3',
  'modeSun1',
  'modeSun2',
  'modeSun3',
];

/** getDay() → 星期缩写（只认活动日周五/六/日；其余星期回 null 走主设置兜底） */
const DAY_BY_WEEK = { 5: 'Fri', 6: 'Sat', 0: 'Sun' };
/** 星期缩写 → 面板中文标签 */
const DAY_LABEL = { Fri: '周五', Sat: '周六', Sun: '周日' };
/** 场序（1-based）→ 中文标签 */
const NUM_LABEL = ['第一场', '第二场', '第三场'];

/**
 * 当前服务器毫秒时刻落在哪个活动场次（纯函数，不含 open 开关判定）。
 * @param {Array<{begin:number,end:number}>|null} slots csHunt.parseSchedule().slots
 * @param {number} nowMs 当前服务器毫秒（csHunt.serverMs()）
 * @returns {{day:string, index:number, label:string}|null} day='Fri'|'Sat'|'Sun'，index=1|2|3，
 *   label 如「周五·第一场」；不在任何时段/非活动星期/同日超 3 场/形态非法一律 null
 */
export function sessionAt(slots, nowMs) {
  if (!Array.isArray(slots) || !slots.length || !(nowMs > 0)) return null;
  var hit = null;
  for (var i = 0; i < slots.length; i++) {
    var sl = slots[i];
    if (sl && nowMs >= sl.begin && nowMs <= sl.end) {
      hit = sl;
      break;
    }
  }
  if (!hit || !(hit.begin > 0)) return null;
  var day = DAY_BY_WEEK[new Date(hit.begin).getDay()];
  if (!day) return null;
  // 同日时段按 begin 排序取序号（不依赖服务器下发顺序）；日界串与 todayStr 同口径
  var dayKey = todayStr(hit.begin / 1000);
  var same = [];
  for (var j = 0; j < slots.length; j++) {
    var s = slots[j];
    if (s && s.begin > 0 && todayStr(s.begin / 1000) === dayKey) same.push(s);
  }
  same.sort(function (a, b) {
    return a.begin - b.begin;
  });
  var idx = same.indexOf(hit) + 1;
  if (idx < 1 || idx > 3) return null;
  return { day: day, index: idx, label: DAY_LABEL[day] + '·' + NUM_LABEL[idx - 1] };
}

/**
 * 当前时刻的有效模式（纯函数）：开关开且命中场次且该格钉了 main/helper 时取格值，否则沿用主设置。
 *   开关关（modeBySession!==true）恒回主设置——矩阵隐藏时格子值一律不参与决策（互斥语义）。
 *   引擎在「首次见到队伍」时调一次并按 team.id 锁存（整局不漂移），无队期每拍实时解析。
 * @param {object|null} cfg 归一化模块配置（含 mode 主设置、modeBySession 开关与 9 个场次键）
 * @param {Array<{begin:number,end:number}>|null} slots 时段表
 * @param {number} nowMs 当前服务器毫秒
 * @returns {'main'|'helper'}
 */
export function resolveMode(cfg, slots, nowMs) {
  var base = cfg && cfg.mode === 'helper' ? 'helper' : 'main';
  if (!cfg || cfg.modeBySession !== true) return base;
  var s = sessionAt(slots, nowMs);
  if (!s) return base;
  var v = cfg['mode' + s.day + s.index];
  return v === 'main' || v === 'helper' ? v : base;
}

/**
 * 播种（开启「按场次设置模式」瞬间 / normalize 兜底用）：follow（未定制）格回 base，
 *   已钉 main/helper 的格原样保留——off→on 往返不抹用户定制。纯函数，不回写传入对象。
 * @param {*} raw 面板 configs 快照（读 9 键）
 * @param {'main'|'helper'} base 播种源（当时主设置）
 * @returns {Object<string,string>} 9 键 → 'main'|'helper'
 */
export function seedFollowModes(raw, base) {
  var b = base === 'helper' ? 'helper' : 'main';
  var cur = sanitizeSessionModes(raw);
  var out = {};
  for (var i = 0; i < SESSION_KEYS.length; i++) {
    var k = SESSION_KEYS[i];
    out[k] = cur[k] === 'follow' ? b : cur[k];
  }
  return out;
}

/**
 * 9 键归一（normalize 用）：非 main/helper 一律回 follow（兼容旧存档无键/非法值）。
 * @param {*} raw 面板 configs 快照
 * @returns {Object<string,string>} 9 键 → 'follow'|'main'|'helper'
 */
export function sanitizeSessionModes(raw) {
  raw = raw || {};
  var out = {};
  for (var i = 0; i < SESSION_KEYS.length; i++) {
    var k = SESSION_KEYS[i];
    var v = raw[k];
    out[k] = v === 'main' || v === 'helper' ? v : 'follow';
  }
  return out;
}

/**
 * 是否有任一场次 effective 为主跑（面板 showIf 判据：矩阵模式下全格陪跑才隐藏队长专属参数）。
 *   传 base 时 follow（未定制残留）按 base 计——与 seedFollowModes/resolveMode 兜底同口径；
 *   不传 base 时 follow 不算主跑（旧口径兼容）。
 * @param {object|null} cfg 面板配置
 * @param {'main'|'helper'} [base] 主设置兜底档（可选）
 * @returns {boolean}
 */
export function anySessionMain(cfg, base) {
  if (!cfg) return false;
  return SESSION_KEYS.some(function (k) {
    var v = cfg[k];
    if (v === 'follow' && base) v = base;
    return v === 'main';
  });
}
