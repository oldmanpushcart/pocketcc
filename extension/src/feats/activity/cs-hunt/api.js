/**
 * 夺宝奇兵（CSHunt / CrossTreasure）ACL 适配器——从 core/game-api.js 下沉（解耦试点）。
 * 活动专属符号名（CSHuntController）就近收在本地 SYM_LOCAL，共享符号（dataCenter…）与探测机器
 * 经 core/acl-engine.js 的 createAcl 取同一份引擎单例；bits/gameData/l10n 等共享能力对象经
 * sharedValue 现取（由 game-api 在模块求值尾部注册，运行期取到的是实时对象引用）。
 * 能力键 csHuntController 经 registerCaps 自注册（reactor 依 spec.symbols 校验）。
 * 合规：全部只读快照，不调游戏侧 updateXxx / sendXxx（发包由 feat 走 pocketcc.net）。
 */
import { game } from '../../../core/game.js';
import { createAcl, registerSharedValue } from '../../../core/acl-engine.js';

const { probe, ns, SYM, userData, registerCaps, sharedValue } = createAcl('CSHUNTAPI');

/** 夺宝奇兵专属符号名（活动域，不住共享 SYM 表） */
const SYM_LOCAL = {
  csHuntCtrl: 'CSHuntController', // 夺宝奇兵（跨服寻宝）控制器门面：ES 命名空间具名导出（无 .default），静态 getInstance() 由 subpack2 RealCSHuntController 接管后返回实例；同模块还导出 CSHuntPhaseType/CSHuntEventType/CSHuntEventPhaseType/CSActivityPhaseType/CSEventSkillSpeType 字符串与数值枚举
};

// ─────────────────────── 夺宝奇兵（CSHunt / CrossTreasure）只读快照 ───────────────────────

/** Int64 时间戳读侧归一为数字（epoch 毫秒 < 2^53，转 Number 安全）；Long 实例走 toNumber，其余回 Number */
function int64Num(v) {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  try {
    if (typeof v.toNumber === 'function') return v.toNumber() || 0;
  } catch (e) {}
  return Number(v) || 0;
}

/**
 * 夺宝奇兵控制器实例（CSHuntController.getInstance()）；subpack2 Real 未接管/符号缺失回 null。
 * 实证 getInstance 内部 `realCSHuntController ? (_instance || (_instance = realCSHuntController())) : null`，
 *   即玩法子包未加载时恒 null——调用方必须自己处理降级。
 * @returns {object|null}
 */
function csHuntCtrl() {
  var C = probe(SYM_LOCAL.csHuntCtrl, () => {
    var m = game.get(SYM_LOCAL.csHuntCtrl);
    var K = m && (m.CSHuntController || ns(m));
    return K && typeof K.getInstance === 'function' ? K : null;
  });
  if (!C) return null;
  try {
    return C.getInstance() || null; // 实例每次现取（接管前为 null）
  } catch (e) {
    return null;
  }
}

/**
 * 夺宝奇兵能力组（均只读，不调游戏侧 updateXxx / sendXxx 方法；发包由 feat 走 pocketcc.net 逐键对齐录制报文）：
 *   - 控制器只存「游戏已收到的服务器态」（7501/7531 应答与 21371~21383 推送写入），本层只读不镜像；
 *   - 快照里所有 64 位 id 已归一为字符串（协议层是 Long 对象、控制器侧是 19 位串，两套口径在此收口）。
 */
export const csHunt = {
  /**
   * 控制器实例在场（subpack2 已接管）。
   * @returns {boolean}
   */
  present() {
    return !!csHuntCtrl();
  },
  /**
   * 玩法开关态原始值（ctrl.open：1=组队夺宝开、3=休赛，其余为雷达/未开）；符号缺失回 0。
   * @returns {number}
   */
  openFlag() {
    var c = csHuntCtrl();
    return c ? Number(c.open) || 0 : 0;
  },
  /**
   * 「能否开新一跑」的完整闸：玩法开（isOpenCSTeamHunt）且剩余次数 > 0。
   * 真机语义：huntCount 由 7501 应答/推送 21377 写入（服务端每 10h 恢复 1 点，上限 5）。
   * 控制器实例不在场（未进过玩法子包）回 false，由调用方先拉 7501 再读。
   * @returns {boolean}
   */
  canHunt() {
    var c = csHuntCtrl();
    if (!c || typeof c.isOpenCSTeamHunt !== 'function') return false;
    try {
      return !!c.isOpenCSTeamHunt() && Number(c.huntCount) > 0;
    } catch (e) {
      return false;
    }
  },
  /**
   * 当前被掠夺行军数（csHuntCtrl().lootMarchNum）：控制器权威态，由推送 21383 HURT_MARCH_SIZE 直接写入
   *   （`lootMarchNum = marchSize`：21383 直接写 lootMarchNum）。
   *   借鉴竞对 roundFight 以 `lootMarchNum > 0` 作「正在被真人掠夺」的一手判据。#7 真实收益：它是游戏侧写的权威计数，
   *   **不被 feat 侧处置时把 #raidSize 置 0 的清零污染**，故能跨回合持续反映仍在场的掠袭（而非「漏推兜底」：
   *   lootMarchNum 本身也是由游戏侧 21383 handler 写入，漏推时两侧同失）；且 21383 有 ~40s 心跳复位 0，无陈旧 >0 长期误武装风险。
   *   符号缺失/控制器不在场/字段非数值一律回 0（调用方据此降级到 7578 侦察）。
   * @returns {number} 被掠夺行军数（0=无/未知）
   */
  lootMarchNum() {
    var c = csHuntCtrl();
    if (!c) return 0;
    try {
      return Number(c.lootMarchNum) || 0;
    } catch (e) {
      return 0;
    }
  },
  /**
   * 只读快照（面板展示/调度决策的唯一进数据）：字段缺失降级不抛错，控制器不在场回 null。
   * @returns {object|null} {open,active,huntCount,lastRecoverTimeMill,lastRound,leader,selfMarchId,team,info}
   *   - team：{id,uid(队长),cfg,status,treasureId,memberCount,memberUids,selfInTeam,selfMarchId,marchedCount,maxMemberPower,readyCount,readyUids,readyStartTimeMill,marchStartTimeMill,marchArriveTimeMill,marchReturnArriveTimeMill} 或 null
   *   - info：{treasureId,round,status,tInfo,eventInfo} —— eventInfo 为控制器 live 对象（其内 Int64 仍是 Long，用 bits.int64Str 读），无跑动中为 null
   */
  readState() {
    var c = csHuntCtrl();
    if (!c) return null;
    var bits = sharedValue('bits');
    if (!bits) return null; // 归一器插槽不可用即当快照不可用（调用方按 null 降级，不抛错）
    var t = c.team || null;
    var uid = '';
    try {
      var m = game.get(SYM.modules.dataCenter);
      uid = bits.int64Str(m && m.DATA && m.DATA.UserData ? m.DATA.UserData.UID : null);
    } catch (e) {}
    var team = null;
    var selfMarchId = '';
    if (t) {
      var members = Array.isArray(t.member) ? t.member : [];
      var memberUids = [];
      var marchedCount = 0;
      var maxMemberPower = 0; // 队内最强成员战力（预警式防御敌强门控用；竞对 onAttacking 同读 team.member[].power）
      for (var i = 0; i < members.length; i++) {
        var mu = bits.int64Str(members[i] && members[i].uid);
        memberUids.push(mu);
        var mid = bits.int64Str(members[i] && members[i].marchId);
        if (mid && mid !== '0') marchedCount++; // marchId 非零 = 该成员已派兵到集结点
        var mpw = Number(members[i] && members[i].power) || 0;
        if (mpw > maxMemberPower) maxMemberPower = mpw;
        if (mu && mu === uid) {
          selfMarchId = mid;
        }
      }
      var ready = Array.isArray(t.readyMember) ? t.readyMember : [];
      var readyUids = [];
      for (var j = 0; j < ready.length; j++) {
        var ru = ready[j];
        readyUids.push(bits.int64Str(ru && ru.uid != null ? ru.uid : ru));
      }
      team = {
        id: bits.int64Str(t.id),
        uid: bits.int64Str(t.uid),
        cfg: Number(t.cfg) || 0,
        status: Number(t.status) || 0,
        treasureId: bits.int64Str(t.treasureId),
        memberCount: memberUids.length,
        memberUids: memberUids,
        selfInTeam: memberUids.indexOf(uid) >= 0,
        selfMarchId: selfMarchId,
        marchedCount: marchedCount,
        maxMemberPower: maxMemberPower,
        readyCount: readyUids.length,
        readyUids: readyUids,
        readyStartTimeMill: int64Num(t.readyStartTimeMill),
        marchStartTimeMill: int64Num(t.marchStartTimeMill),
        marchArriveTimeMill: int64Num(t.marchArriveTimeMill),
        marchReturnArriveTimeMill: int64Num(t.marchReturnArriveTimeMill),
      };
    }
    var info = c.csHuntInfo || null;
    return {
      open: Number(c.open) || 0,
      active: !!(typeof c.isOpenCSTeamHunt === 'function' && c.isOpenCSTeamHunt()),
      huntCount: Number(c.huntCount) || 0,
      lastRecoverTimeMill: int64Num(c.lastRecoverTimeMill),
      lastRound: !!c.lastRound,
      leader: !!(team && uid && team.uid === uid),
      selfMarchId: selfMarchId,
      team: team,
      info: info
        ? {
            treasureId: bits.int64Str(info.treasureId),
            round: Number(info.round) || 0,
            status: Number(info.status) || 0,
            tInfo: info.tInfo || null,
            eventInfo: info.eventInfo || null,
          }
        : null,
    };
  },
  /**
   * NResponseId 跳段推送里的队伍结构归一（与 readState().team 同形）：供 feat 从 push/应答直读 team 时复用。
   * @param {object|null} raw PB team（可能为 null）
   * @returns {object|null}
   */
  readTeam(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var bits = sharedValue('bits');
    if (!bits) return null; // 同 readState：插槽不可用回 null 当「无从归一」，不抛错
    var uid = '';
    try {
      uid = bits.int64Str(userData() ? userData().UID : null);
    } catch (e) {}
    var members = Array.isArray(raw.member) ? raw.member : [];
    var memberUids = [];
    var marchedCount = 0;
    var selfMarchId = '';
    for (var i = 0; i < members.length; i++) {
      var mu = bits.int64Str(members[i] && members[i].uid);
      memberUids.push(mu);
      var mid = bits.int64Str(members[i] && members[i].marchId);
      if (mid && mid !== '0') marchedCount++; // marchId 非零 = 该成员已派兵到集结点
      if (mu && mu === uid) selfMarchId = mid; // 与 readState().team 同形：回填本人 marchId（页外快照判「队长自己是否已出兵」的唯一依据）
    }
    var ready = Array.isArray(raw.readyMember) ? raw.readyMember : [];
    var readyUids = [];
    for (var j = 0; j < ready.length; j++) {
      var ru = ready[j];
      readyUids.push(bits.int64Str(ru && ru.uid != null ? ru.uid : ru));
    }
    return {
      id: bits.int64Str(raw.id),
      uid: bits.int64Str(raw.uid),
      cfg: Number(raw.cfg) || 0,
      status: Number(raw.status) || 0,
      treasureId: bits.int64Str(raw.treasureId),
      memberCount: memberUids.length,
      memberUids: memberUids,
      selfInTeam: memberUids.indexOf(uid) >= 0,
      selfMarchId: selfMarchId,
      marchedCount: marchedCount,
      readyCount: readyUids.length,
      readyUids: readyUids,
      readyStartTimeMill: int64Num(raw.readyStartTimeMill),
      marchStartTimeMill: int64Num(raw.marchStartTimeMill),
      marchArriveTimeMill: int64Num(raw.marchArriveTimeMill),
      marchReturnArriveTimeMill: int64Num(raw.marchReturnArriveTimeMill),
    };
  },
  /**
   * 当前服务器毫秒时刻（与玩法 timeInfo 的 beginMill/endMill 同量纲）；serverTime 秒 ×1000，取不到回 0。
   * 时段边界是分钟级，秒级误差无影响。
   * @returns {number}
   */
  serverMs() {
    var gd = sharedValue('gameData');
    return ((gd && gd.serverTime()) || 0) * 1000;
  },
  /**
   * 从 7501 应答的 `crossTreasureInfo`（或控制器 timeInfo 同构体）解析夺宝时间表（纯查询，不读控制器）。
   *   `open`：1=组队夺宝赛季开（整天为真，非「当前时刻可开跑」）、3=休赛；`openTime[]`：每天 3 个 2h 时段的 beginMill/endMill（Int64 Long）。
   *   字段缺失/非数组一律容错回空 slots（调用方据此当「未知」，不贸然动作）。
   * @param {object|null} info crossTreasureInfo 应答体（含 open / openTime）
   * @returns {{open:number, slots:Array<{begin:number,end:number}>}|null} 无 info 回 null
   */
  parseSchedule(info) {
    if (!info || typeof info !== 'object') return null;
    var raw = Array.isArray(info.openTime) ? info.openTime : [];
    var slots = [];
    for (var i = 0; i < raw.length; i++) {
      var s = raw[i] || {};
      var begin = int64Num(s.beginMill);
      var end = int64Num(s.endMill);
      if (begin > 0 && end > 0) slots.push({ begin: begin, end: end });
    }
    return { open: Number(info.open) || 0, slots: slots };
  },
  /**
   * 判「当前服务器毫秒时刻是否落在某个每日夺宝时段内」（纯函数，不含 open 开关判定）。
   * @param {Array<{begin:number,end:number}>|null} slots parseSchedule().slots
   * @param {number} nowMs 当前服务器毫秒（csHunt.serverMs()）
   * @returns {{known:boolean, in:boolean, nextBegin:number}} known=时段数据可用；in=此刻在时段内；nextBegin=下一个未到时段的起始毫秒（无则 0）
   */
  playWindowState(slots, nowMs) {
    if (!Array.isArray(slots) || !slots.length) return { known: false, in: false, nextBegin: 0 };
    var next = 0;
    for (var i = 0; i < slots.length; i++) {
      var sl = slots[i];
      if (!sl) continue;
      if (nowMs >= sl.begin && nowMs <= sl.end) return { known: true, in: true, nextBegin: 0 };
      if (sl.begin > nowMs && (!next || sl.begin < next)) next = sl.begin;
    }
    return { known: true, in: false, nextBegin: next };
  },
  /**
   * 幸运奖励池只读枚举（面板 luckyRewards 的候选源）：本玩法可翻倍礼品 = `cross_treasure_event`
   *   各行的 **win 中奖奖励**配置 id（`78001xxx`）经 RewardController 解包后的 itemId（**不含 fail 保底、不含 grail 神器**——
   *   引擎 #tryLucky 只喂 winRewardResult、且幸运「神器除外」，列进来会是永不命中的死勾选），
   *   去重后回 `{id,name,scenes}`（名从 `item` 表解析；scenes = 该 itemId 出现的事件场景族，规范顺序 pickReward→rollDice→codeBox→defPVE）。
   * 【为何不是 cross_treasure_pool】：那张表是以 poolId 为主键的**赛季开关配置行**（min_level/achievement_open/
   *   grail_open…），根本不存礼品清单——之前误读它才导致面板幸运池恒空。事件奖励行属登录下发的客户端配置，
   *   活动未开始时也在内存，故面板可在开局前就铺出候选供勾选。表未就绪/符号缺失/无奖励一律回 []。
   * @returns {Array<{id:number, name:string, scenes:string[]}>}
   */
  readRewardPool() {
    var l = sharedValue('l10n');
    var gd = sharedValue('gameData');
    if (!l || !gd) return [];
    var rows = l.tableRows('cross_treasure_event');
    if (!Array.isArray(rows) || !rows.length) return [];
    // 奖励列名以真机 dump 定稿（docs §9）：幸运只翻倍中奖奖励，故**只取 win 列**（多备同义列容错）；
    //   fail_reward（未中奖保底）与 grail_reward（神器，幸运明确除外）引擎永不喂给 #tryLucky，列进来是死勾选，不收。
    var rewardCols = ['win_reward', 'reward', 'winReward', 'show_reward'];
    // 事件族号取百位（`Math.floor(id/100) % 10`）：eventSpecId 编码 `<套装><族><序号>`，前缀随赛季换表
    //   （1003xx/4003xx 均为 codeBox，2026-11 实测），不得硬编码 1001..1006 整段；1 pickReward/2 rollDice/3 codeBox/5 defPVE；
    //   4 pickSkill 发科技、6 nothing 空过，均不产可翻倍道具，不入池）
    var famScene = { 1: 'pickReward', 2: 'rollDice', 3: 'codeBox', 5: 'defPVE' };
    var order = ['pickReward', 'rollDice', 'codeBox', 'defPVE'];
    var byId = Object.create(null);
    var out = [];
    var push = function (id, scene) {
      id = Number(id) || 0;
      if (id <= 0) return;
      var rec = byId[id];
      if (!rec) {
        var name = '';
        try {
          var row = l.tableRow('item', id);
          name = row && row.name ? l.text(row.name) : '';
        } catch (e) {}
        rec = byId[id] = { id: id, name: name || '道具 ' + id, _set: Object.create(null) };
        out.push(rec);
      }
      if (scene) rec._set[scene] = 1;
    };
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i] || {};
      var scene = famScene[Math.floor(Number(r.id) / 100) % 10] || '';
      for (var j = 0; j < rewardCols.length; j++) {
        var rid = r[rewardCols[j]];
        if (rid == null) continue;
        // 一格可能装多个 reward id（如 '7800101|7800102'），按分隔符拆后逐个解包
        var parts = String(rid).split(/[|,;\s]+/);
        for (var p = 0; p < parts.length; p++) {
          var one = Number(parts[p]);
          if (!(one > 0)) continue;
          var items = gd.rewardItems(one);
          for (var k = 0; k < items.length; k++)
            if (items[k] && items[k].id) push(Number(items[k].id), scene);
        }
      }
    }
    for (var m = 0; m < out.length; m++) {
      var set = out[m]._set;
      var arr = [];
      for (var q = 0; q < order.length; q++) if (set[order[q]]) arr.push(order[q]);
      out[m].scenes = arr;
      delete out[m]._set;
    }
    return out;
  },
};

// ─────────────────────── 引擎回挂：能力自注册 ───────────────────────

registerCaps({
  // 夺宝奇兵：控制器类在场（实例由 subpack2 RealCSHuntController 接管后才可取，故只校验类/静态方法）
  csHuntController: () => {
    var m = game.get(SYM_LOCAL.csHuntCtrl);
    var C = m && (m.CSHuntController || ns(m));
    return !!(C && typeof C.getInstance === 'function');
  },
});

// 调试面回挂：game-api.debug.csHunt（仅供控制台/回归探针）经共享插槽现取本适配器。
registerSharedValue('csHunt', () => csHunt);
