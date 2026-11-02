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

const { ns, SYM, userData, log } = createAcl('AIRDROPDOM');

/** 秘密武器空投支援领域只读面（feat 经 import { airDropDomain } from '../secret-weapon-drop/api.js' 消费） */
export const airDropDomain = {
  /**
   * 空投支援合法落点（只读、**场景无关**）：复刻游戏 HomeMap.findValidAirDropBoxArea 的落点判定，但不依赖 HomeMap 场景组件
   *   （该组件离开 Home 即被 cpnDestroy 置 null）。原版三块数据的权威来源均可在任意场景只读获取：
   *     · 地形/可投放合法性：HomeMapUtils.checkHomeBoxLegal（静态表 HomeMapTileBlockTypeTable，任何场景可调）；
   *     · 建筑占用：DataCenter.UserData.Buildings（正是 HomeMap.InitBuildings 的数据源、服务器推送的常驻单例），
   *       footprint 复用游戏自身的等距展开函数 HomeMapUtils.getMapPosList（与 checkHomeBoxLegal 内部同一生成器，零口径漂移）；
   *     · 空投 footprint：BUILDING 表 buildingId 行的 width/height（缺省 3×3）。
   *   原版把搜索种子锚在「当前视口中心」（必然已解锁疆域）再螺旋外扩；本实现把扫描锚定在主城网格中心、按距中心由近及远，
   *   等价地优先落在玩家早期即解锁的核心地块，规避「静态表合法但疆域未解锁」的外围格被服务器拒。
   *   占用采保守口径：把 UserData.Buildings 里每个建筑的 footprint 全计为占位（含游戏侧本不计占位的地面装饰/地板）——
   *   保守只会少选几格、绝不会选到与真建筑重叠的非法格（服务器端也忽略地面装饰，避开地面格是其合法子集），故无需精确复刻 IsGround 判据。
   * @param {number} buildingId 待投放建筑 id（空投建筑=9001001）
   * @returns {{x:number, y:number, posId:number}|null} 合法空位锚点（主城小格坐标，即 4170 param 口径）；符号缺失/无空地/无建筑数据返回 null（→ 本轮不发）
   */
  homeAirDropSpot(buildingId) {
    try {
      var HU = ns(game.get(SYM.modules.homeMapUtils));
      if (
        !HU ||
        typeof HU.getMapPosList !== 'function' ||
        typeof HU.checkHomeBoxLegal !== 'function' ||
        typeof HU.getMapPosByPosId !== 'function' ||
        typeof HU.getPosIdByMapPos !== 'function'
      ) {
        log.debug(
          'homeAirDropSpot: HomeMapUtils 符号缺失（getMapPosList/checkHomeBoxLegal/…）→ 无法定位落点',
        );
        return null;
      }
      var GD = game.get(SYM.modules.gameDefine);
      var BI_BUILD = GD && GD.BaseItemType && GD.BaseItemType.Building; // 必为真值：传错 checkHomeBoxLegal 会跳过地形判定
      if (BI_BUILD == null) {
        log.debug('homeAirDropSpot: GameDefine.BaseItemType.Building 缺失 → 无法定位落点');
        return null;
      }
      var l = sharedValue('l10n');
      var air = l && l.tableRow('building', buildingId);
      var airW = air && air.width > 0 ? air.width | 0 : 3;
      var airH = air && air.height > 0 ? air.height | 0 : 3;
      var HCM = ns(game.get(SYM.modules.homeMapCommon));
      var WC = (HCM && HCM.WidthCount) || 84,
        HC = (HCM && HCM.HeightCount) || 104;
      // 占用格集合：所有建筑 footprint（getMapPosList 与游戏内部同一等距生成器，口径一致）
      var occ = Object.create(null);
      var list = userData() && userData().Buildings;
      if (Array.isArray(list)) {
        for (var k = 0; k < list.length; k++) {
          var b = list[k];
          if (!b || b.Pos == null) continue;
          var cfg = l && l.tableRow('building', b.BuildingId);
          if (!cfg) continue;
          var mp = HU.getMapPosByPosId(b.Pos);
          if (!mp || mp.x == null || mp.y == null) continue;
          var cells = HU.getMapPosList(mp.x, mp.y, cfg.width | 0 || 1, cfg.height | 0 || 1);
          for (var j = 0; j < cells.length; j++) {
            if (cells[j] !== -1) occ[cells[j]] = 1;
          }
        }
      }
      // 由主城网格中心向外（切比雪夫环）扫第一个「地形合法 + 空投 footprint 全空」的锚点；限环数待在核心已解锁区，宁可本轮不发也不赌外围
      var cx = WC >> 1,
        cy = HC >> 1,
        R = Math.min(WC, HC) >> 1;
      for (var r = 0; r <= R; r++) {
        for (var dx = -r; dx <= r; dx++) {
          for (var dy = -r; dy <= r; dy++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue; // 只走本环边框，避免重扫内圈
            var x = cx + dx,
              y = cy + dy;
            if (x < 0 || y < 0 || x >= WC || y >= HC) continue;
            var pid = HU.getPosIdByMapPos(x, y);
            if (occ[pid]) continue; // 快速淘汰：锚点格已被占
            if (!HU.checkHomeBoxLegal(x, y, airW, airH, BI_BUILD, buildingId, -1)) continue; // 地形/可投放合法性
            var ac = HU.getMapPosList(x, y, airW, airH),
              free = true;
            for (var q = 0; q < ac.length; q++) {
              if (ac[q] === -1 || occ[ac[q]]) {
                free = false;
                break;
              }
            }
            if (free) return { x: x, y: y, posId: pid };
          }
        }
      }
      log.debug(
        'homeAirDropSpot: 核心区半径 %d 环内无合法空位（BUILDING 表 %s→ footprint=%dx%d, 网格=%dx%d, 占用格数=%d）',
        R,
        air ? 'OK' : 'MISSING',
        airW,
        airH,
        WC,
        HC,
        Object.keys(occ).length,
      );
      return null; // 核心区内无合法空位（空地不足）
    } catch (e) {
      log.debug(
        'homeAirDropSpot threw: %s —— 落点计算中途抛错被吞，本轮不发',
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
      log.debug('airDropInstances threw: %s', e && (e.message || e));
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
      var msOf = function (v) {
        // protobuf Long / {_low,_high} / number → 毫秒
        if (!v) return 0;
        if (typeof v === 'number') return v;
        if (typeof v.toNumber === 'function') {
          try {
            return v.toNumber();
          } catch (e) {
            return 0;
          }
        }
        var lo = v._low != null ? v._low : v.low,
          hi = v._high != null ? v._high : v.high;
        if (lo == null || hi == null) return 0;
        lo = Number(lo);
        hi = Number(hi);
        if (lo < 0) lo += 4294967296;
        return hi * 4294967296 + lo;
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
