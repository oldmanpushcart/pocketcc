/**
 * pocketcc.feats.player.secretWeaponDropApi
 * 秘密武器空投支援领域 ACL（落点计算 / 地面实例 / cd_skill 次数）—— 原住 core/game-api.js
 * 的 gameData 三个方法，因单一消费方（本目录 feat）且属「复刻游戏算法」的领域知识，按解耦试点模式下沉。
 * 引擎机器经 core/acl-engine.js 的 createAcl 取共享单例；l10n/gameData 共享对象经
 * sharedValue 运行期现取（不静态 import game-api，防 core⇄feats 循环）。
 * 纪律：只读游戏数据，零发包零写接口；符号缺失一律返回 null/[] 保守降级。
 */
import { game } from '../../../core/game.js';
import { createAcl, sharedValue } from '../../../core/acl-engine.js';
import { homeSnap } from '../../../core/home-snap.js';

const { ns, SYM, userData, log } = createAcl('AIRDROPDOM');

/** 秘密武器空投支援领域只读面（feat 经 import { airDropDomain } from '../secret-weapon-drop/api.js' 消费） */
export const airDropDomain = {
  /**
   * 空投支援合法落点（只读）：直接调游戏原生 HomeMap.findValidAirDropBoxArea(buildingId)（UIManager.Instance().HomeMap，
   *   与 PlayerSkillController.useSkill 手动施放、竞品A/B 同一选点函数），返回 posId 经 HomeMapUtils.getMapPosByPosId 换算小格坐标。
   *   竞品A/B 同款 world 支持：core/home-snap.js 钩 HomeMap.onSceneEnded 离场景前克隆组件成快照，本 ACL 取 live||homeSnap()
   *   （Home 用活组件、world 用快照）；选点链自包含在实例上不读 UIManager 门面，故无需改门面（比竞品少一步侵入）。
   *   原生锚视口中心，三级判定：getBuildingPosNearBy（建筑对齐环扫）→ getPosNearBy（通用环扫）→ checkNearByPos
   *   （边界 / checkInLagCache / checkHomeBoxLegal / checkBoxLegal 分支 / checkBoxTypeLegal），尺寸取 BUILDING 表
   *   width/height/point_type——与服务器同口径，选出的点即游戏自己会投的点。
   *   **自研环扫复刻已废弃（2026-11-16 Home 判别实验实锤）**：复刻三道闸全过的 (40,55) 在 Home 投放依旧 s=0 扣次数
   *   不建箱（rec 092411：4170 param=[40,55] → cnt 1→0，774s 内 10101/10109 零 9001001）；投放同拍服务器恰推
   *   现存建筑 71000@(41,55) 的 10109——落点 3×3 footprint 与其冲突，复刻占用闸漏算（历史 46 发无一建箱）。
   *   游戏原生选点是唯一验真路径（10-07 手动 (4,66) 全链路成功）。
   *   活组件离开 Home 即 cpnDestroy 置 null → world 回退快照；快照未就位（从未进过 Home）/组件与快照皆缺/函数缺失/
   *   返回 -1（无合法空地）一律 null → 本轮不发（fail-closed，绝不盲投烧次数）。
   *   皆只读查询（不改写游戏数据、不 OpenUI、不播动画）。
   * @param {number} buildingId 待投放建筑 id（空投建筑=9001001）
   * @returns {{x:number, y:number, posId:number}|null} 合法空位锚点（主城小格坐标，即 4170 param 口径）；组件不在/无空地返回 null（→ 本轮不发）
   */
  homeAirDropSpot(buildingId) {
    try {
      var UM = ns(game.get(SYM.modules.uiManager));
      var live = UM && typeof UM.Instance === 'function' ? UM.Instance().HomeMap : null;
      // Home 用活组件；world 活组件已 cpnDestroy → 回退 onSceneEnded 克隆快照（core/home-snap.js，侵入性钩子用户已接受）
      var hm = live || homeSnap();
      if (!hm || typeof hm.findValidAirDropBoxArea !== 'function') {
        log.warn(
          'homeAirDropSpot: no HomeMap (not in Home / no snapshot yet / symbol drift) → skip drop this round. buildingId=%d',
          buildingId,
        );
        return null;
      }
      var HU = ns(game.get(SYM.modules.homeMapUtils));
      if (!HU || typeof HU.getMapPosByPosId !== 'function') {
        log.warn('homeAirDropSpot: HomeMapUtils.getMapPosByPosId missing → skip drop this round.');
        return null;
      }
      var posId = hm.findValidAirDropBoxArea(buildingId);
      if (!(posId > 0)) {
        // -1=无合法空地（游戏同款提示 secret_weapon_53）；未发包、次数未消耗，空地腾出后再试
        log.debug(
          'homeAirDropSpot: game findValidAirDropBoxArea returned %d (no legal free area). buildingId=%d',
          posId,
          buildingId,
        );
        return null;
      }
      var mp = HU.getMapPosByPosId(posId);
      if (!mp || mp.x == null || mp.y == null) {
        log.warn(
          'homeAirDropSpot: posId=%d unreadable via getMapPosByPosId → skip drop this round.',
          posId,
        );
        return null;
      }
      log.debug(
        'homeAirDropSpot: chose (%d,%d) via game findValidAirDropBoxArea. posId=%d',
        mp.x,
        mp.y,
        posId,
      );
      return { x: mp.x, y: mp.y, posId: posId };
    } catch (e) {
      log.warn(
        'homeAirDropSpot threw: %s —— landing computation threw mid-way and was swallowed, skip sending this round',
        e && (e.stack || e.message),
      );
      return null;
    }
  },
  /**
   * 地面上现存的空投建筑实例 id 列表（只读遍历 UserData.Buildings，BuildingId==buildingId 者）。
   * 用于开启 feat 前已落地、不会再重推 10101 的空投播种待收（随后由 4168 按实例 id 领取）。
   * @param {number} buildingId 空投建筑 buildingId（9001001）
   * @returns {string[]} 实例 id 字符串数组（4168 targetId 口径）；无数据/符号缺失返回 []
   */
  airDropInstances(buildingId) {
    try {
      var list = userData() && userData().Buildings;
      var out = [];
      if (!Array.isArray(list)) return out;
      // 64 位实例 id 超过 JS 安全整数：优先取字符串/protobuf Long.toString()，否则由 {_low,_high}/{low,high} 用 BigInt 精确还原
      var toIdStr = function (raw) {
        if (raw == null) return '';
        if (typeof raw === 'string') return /^\d+$/.test(raw) ? raw : '';
        if (typeof raw === 'object') {
          if (typeof raw.toString === 'function') {
            var s = String(raw.toString());
            if (/^\d+$/.test(s)) return s;
          }
          var lo = raw._low != null ? raw._low : raw.low,
            hi = raw._high != null ? raw._high : raw.high;
          if (lo != null && hi != null && typeof BigInt !== 'undefined') {
            lo = Number(lo);
            hi = Number(hi);
            if (lo < 0) lo += 4294967296;
            return (BigInt(hi) * (BigInt(1) << BigInt(32)) + BigInt(lo)).toString();
          }
        }
        if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0) return String(raw);
        return '';
      };
      for (var i = 0; i < list.length; i++) {
        var b = list[i];
        if (!b || Number(b.BuildingId) !== buildingId) continue;
        var id = toIdStr(b.Id != null ? b.Id : b.id);
        if (id) out.push(id);
      }
      return out;
    } catch (e) {
      log.warn('airDropInstances threw: %s', e && (e.message || e));
      return [];
    }
  },
  /**
   * 秘密武器 cd_skill 次数/冷却可用性（只读复刻 PlayerSkillController.getSkillUseEnableNum/getSkillCdTime 的 type==2 口径）。
   * 数据来自 CD_SKILL_INFO(4169) 应答里 id 对应的那条技能状态（start/end 为 protobuf Long），账号从未用过则传 null。
   * @param {number} skillId cd_skill 表 id（空投支援=2）
   * @param {object|null} skill 该技能当前状态 {id,start,cnt,end}；无则 null
   * @returns {{type:number, available:number, nextMs:number, max:number, cd:number, cnt:(number|null)}|null}
   *   available=此刻可用次数（≥1 才能发 4170）；nextMs=下一枚次数恢复的**绝对毫秒时刻**（已满则 0）；配置缺失（符号漂移）返回 null。
   */
  cdSkillAvailability(skillId, skill) {
    try {
      var l = sharedValue('l10n');
      var gd = sharedValue('gameData');
      if (!l || !gd) return null;
      var cfg = l.tableRow('cd_skill', skillId);
      if (!cfg) return null;
      var type = Number(cfg.type) | 0;
      var cd = Number(cfg.cd) || 0; // 每枚次数恢复间隔（分钟）
      var max = Number(cfg.max) || 0; // 次数上限
      var serverSec = gd.serverTime() | 0;
      var bits = sharedValue('bits');
      var msOf = function (v) {
        // protobuf Long / {_low,_high} / number → 毫秒（已收口到 ACL bits.int64ToNum，此处仅委托）
        return bits ? bits.int64ToNum(v) : 0;
      };
      if (type === 2) {
        // 次数型（空投支援）：可用 = min(cnt + 自 start 起已恢复的整数枚, max)
        if (!skill) return { type: type, available: max, nextMs: 0, max: max, cd: cd, cnt: null }; // 从未用过 = 满次数
        var cnt = Number(skill.cnt) || 0;
        var startSec = Math.floor(msOf(skill.start) / 1000);
        var accr = cd > 0 ? Math.floor((serverSec - startSec) / (60 * cd)) : 0;
        if (accr < 0) accr = 0;
        var avail = Math.min(cnt + accr, max);
        var nextMs = avail >= max ? 0 : (startSec + (accr + 1) * 60 * cd) * 1000; // 下一枚恢复的绝对毫秒
        return { type: type, available: avail, nextMs: nextMs, max: max, cd: cd, cnt: cnt };
      }
      // type1/type3：单次冷却型，end（绝对毫秒）过了即可用一次
      if (!skill) return { type: type, available: 1, nextMs: 0, max: 1, cd: cd, cnt: null };
      var endMs = msOf(skill.end);
      return {
        type: type,
        available: Math.floor(endMs / 1000) < serverSec ? 1 : 0,
        nextMs: endMs,
        max: 1,
        cd: cd,
        cnt: null,
      };
    } catch (e) {
      return null;
    }
  },
};
