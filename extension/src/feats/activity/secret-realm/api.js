/**
 * 异能秘境（Pab）ACL 适配器：活动域符号、秘境独立通道与只读快照口的统一出口。
 * 活动专属符号名（PabController/TMWatchNetMgr/NWorldMapMarchCommon）就近收在本地 SYM_LOCAL，
 * 共享符号（mapNewBiz/nWorldMapData/gameDefine…）与探测机器经 core/acl-engine.js 的 createAcl
 * 取同一份引擎单例（probe 缓存全工程共享，不复制状态）；gameConf 等共享能力对象经 sharedValue 现取。
 * 能力键 pabController/watchNet/mapNewBiz 经 registerCaps 自注册（reactor 依 spec.symbols 校验），
 * 秘境图判据经 registerWorldSlot('pabBattleMap') 回挂 core/world-state 信号面——core 不反向 import 本文件。
 * 合规：全部能力为只读查询或走秘境独立通道发包（只读+发包红线）。
 */
import { game } from '../../../core/game.js';
import { createAcl, registerSharedValue } from '../../../core/acl-engine.js';

const { log, probe, ns, SYM, registerCaps, registerWorldSlot, sharedValue } =
  createAcl('SECRETAPI');

/** 秘境专属符号名（活动域，不住共享 SYM 表） */
const SYM_LOCAL = {
  pabController: 'PabController', // 异能秘境（Pab）控制器门面：default=类，静态 getInstance() 由 subpack2 RealPabController 接管后返回实例（含 petCaptureOperation/getItemNumById/checkItemNumMax/roomBaseInfo/capturingInfo）
  watchNet: 'TMWatchNetMgr', // 跨服观战/秘境独立发送通道：default=类，静态 Instance 懒建单例；isPabBattleMap 时 sendPBV2 转 NetMgrSimple 独立 WebSocket（主 pocketcc.net 发不出去）
  marchCommon: 'NWorldMapMarchCommon', // 世界地图行军常量（subpack2）：模块级导出 NMarchState 枚举（MARCHING=1/ARRIVED=2/FIGHTING=12/PAB_FEED=21）
};

// ─────────────────────── 异能秘境（Pab）跨服通道与场景门控 ───────────────────────

/** @type {number} 未真正发出的伪码（与 net.CODE_NOT_SENT 同义；watch 通道无返回句柄，超时/异常均回此值） */
const SECRET_NOT_SENT = -1;
/**
 * @type {number} 秘境发包应答超时（毫秒）：与 net.js SEND_TIMEOUT_MS 同量纲，到点未 settle 即回 SECRET_NOT_SENT。
 * 取 4s：次通道 RTT 44~52ms（8527/8538/8546 的应答全在此量级）；而 `NetMgrSimple` 的
 *   `MsgIdSettings.cdTime` 频控命中时 `return !1`、**包根本不上线也不报错**，门面 `TMWatchNetMgr.sendPBV2`
 *   又是把三元表达式当语句用、没有 return（verbatim）→ 拿不到那个 false，只能靠超时感知，故超时窗取秒级。
 *   调用方语义不变：超时仍回 SECRET_NOT_SENT（未发出），不拉黑、可重试。
 */
const SECRET_TIMEOUT_MS = 4000;
/**
 * 次通道未就绪是否已经告过警（首发 warn、后续降 debug，防拾取逐拍刷屏；任一发包成功即复位）。
 * @type {boolean}
 */
var socketNotReadyWarned = false;

/**
 * NWorldMapCoreBiz 业务单例（isPabBattleMap 为其 getter）；符号缺失返回 null。
 * 只缓存单例对象，isPabBattleMap 每次现读（watchingType 随进出秘境实时变化）。
 */
function pabBiz() {
  return probe(SYM.modules.mapNewBiz, () => {
    var b = ns(game.get(SYM.modules.mapNewBiz));
    return b && 'isPabBattleMap' in b ? b : null;
  });
}

/** TMWatchNetMgr 单例（秘境/跨服观战独立发送通道）；符号缺失返回 null */
function watchNetMgr() {
  return probe(SYM_LOCAL.watchNet + '.Instance', () => {
    var C = ns(game.get(SYM_LOCAL.watchNet));
    var inst = C && C.Instance; // 静态 getter 懒建单例（引用稳定，可缓存）
    return inst && typeof inst.sendPBV2 === 'function' ? inst : null;
  });
}

/**
 * 构造与 net.Ret 同形的结果对象（code/data/reason/ok）；window.pocketcc.net 未就绪时降级为等价的普通对象。
 * @param {number} code 状态码（0=成功；SECRET_NOT_SENT=未发出/超时）
 * @param {*} data 业务数据（pbAckV2.data）
 * @param {string|null} reason 拒绝多语言键（pbAckV2.header.d，仅 code≠0 时有意义）
 * @returns {object} Ret 形结果
 */
function secretRet(code, data, reason) {
  // 此处故意摸总线而不 import netApi：活动 ACL 适配器不得反向依赖网络模块（dep-cruiser
  //   feat-acl-adapters-not-depend-on-domain-or-net 为 error，与拆分前 game-api 区段同口径），
  //   net.js 自身不 import 本模块，函数内懒取也无时序风险。
  // eslint-disable-next-line no-restricted-syntax
  var Net = window.pocketcc && window.pocketcc.net;
  var r = Net && Net.Ret ? Net.Ret.from(code, data) : { code: code, data: data, reason: null };
  if (reason != null) r.reason = reason;
  return r;
}

/**
 * 异能秘境能力组（均只读/发包，不改写游戏数据）：
 *   - 秘境协议发送走 TMWatchNetMgr 独立通道（主 pocketcc.net 在 isPabBattleMap 下发不出去），此处 promise 化并归一 Ret；
 *   - isPabBattleMap 为「是否在秘境地图」唯一真相（场景名仍是 NWorldMap，不可靠），仅作场景门控用；
 *   - getPabController 回控制器实例供上层调游戏原生动作（petCaptureOperation 等），不代跑业务；
 *   - 另有 BOSS/治疗一族**只读快照**（getRoomBaseInfo/getBossBaseInfo/getBossGuardRewardInfo/getItemNumById/isTeamLeader/teamIsMooring）：
 *     这些态全由游戏的推送与应答 Handler 写入（21521/21535/21539/21525），本层只读不镜像，不代跑业务判定。
 */
export const secretRealm = {
  /**
   * 当前是否在异能秘境地图（NWorldMapCoreBiz.isPabBattleMap getter：watchingType===PAB）。
   * 符号缺失/未就绪返回 false（宁可不进 active 档也不误判场景）。
   * @returns {boolean}
   */
  isPabBattleMap() {
    var b = pabBiz();
    return !!(b && b.isPabBattleMap);
  },
  /**
   * 异能秘境控制器实例（PabController.getInstance()）；subpack2 未接管/符号缺失返回 null。
   * getInstance 内部 `realPabController?(...):null` → 拿到的是 RealPabController 实例，
   *   roomBaseInfo / capturingInfo / capturingPetPos / petCaptureOperation 均直接可达。
   * 上层据它读 capturingPetPos（**「正在拍哪只」的唯一真相**，push 21530 写）、roomBaseInfo.marchState（行军态）、
   *   capturingInfo（8546 应答 feedInfo，仅作料源）并调原生 petCaptureOperation/getItemNumById/checkItemNumMax。
   * @returns {object|null}
   */
  getPabController() {
    var C = probe(SYM_LOCAL.pabController, () => {
      var c = ns(game.get(SYM_LOCAL.pabController));
      return c && typeof c.getInstance === 'function' ? c : null;
    });
    if (!C) return null;
    try {
      return C.getInstance() || null; // 实例每次现取（接管前为 null）
    } catch (e) {
      return null;
    }
  },
  /**
   * NMarchState 枚举对象（运行时取成员值，不硬编码数值）；subpack2 未载/符号缺失返回 null。
   *   注：**PAB_FEED(21) 不能当「在拍」判据**——21521 BASE_INFO 下推很稀（970s 会话才 58 条），
   *   整个拍宠物过程里 marchState 只给 1(MARCHING)/2(ARRIVED)，在拍真相请用 capturingPetPos。
   * @returns {object|null} {MARCHING,ARRIVED,FIGHTING,PAB_FEED,…}
   */
  getNMarchState() {
    return probe(SYM_LOCAL.marchCommon + '.NMarchState', () => {
      var m = game.get(SYM_LOCAL.marchCommon);
      var E = m && (m.NMarchState || (m.default && m.default.NMarchState));
      return E && E.PAB_FEED != null ? E : null;
    });
  },
  /**
   * 房间现场态 roomBaseInfo（push 21521 BASE_INFO 由游戏 Handler 写入）的**只读引用**；不在秘境/未下发回 null。
   * 载荷 24 键：teamId/leaderUid/marchState/startPoint/pointType/targetPoint/fightEndTime/buffMap…
   *   Int64 字段（fightEndTime/teamId/leaderUid 等）原样返回，由调用方按口径读（不在此转 Number，防 64 位精度陷阱）。
   * @returns {object|null}
   */
  getRoomBaseInfo() {
    var p = secretRealm.getPabController();
    return (p && p.roomBaseInfo) || null;
  },
  /**
   * 三个 BOSS 的状态机快照（游戏 Handler 收到 push 21535 后 `bossBaseInfo = a.stateInfo`）。
   * @returns {Array<{bossId:number,pos:{x:number,y:number},state:number,stateEndTime:*}>|null} 未下发回 null
   */
  getBossBaseInfo() {
    var p = secretRealm.getPabController();
    return (p && p.bossBaseInfo) || null;
  },
  /**
   * 小BOSS 石头点位账本快照（push 21539；**游戏侧字段名拼写就是 Gurard**，不做纠正以免与运行时符号漂移）。
   * @returns {Array<{bossId:number,rewardInfo:Array<{pos:{x:number,y:number},rewardNum:number,rewardMaxNum:number,isFight:number}>}>|null}
   */
  getBossGuardRewardInfo() {
    var p = secretRealm.getPabController();
    return (p && p.bossGurardRewardInfo) || null;
  },
  /**
   * 队伍是否停泊在位（游戏 `teamIsMooring`：`!roomBaseInfo || marchState ∈ {ARRIVED,FIGHTING,PAB_FEED}`）。
   * 注：**不在秘境（roomBaseInfo 缺失）时游戏侧回 true**，本层保留原语义；调用方要「确实在场」得自己配合
   *   getRoomBaseInfo() 非空一起判（realmActive 已是 feat 侧前置）。
   * @returns {boolean} 符号缺失回 false（闭开：不确认停泊就不发写请求）
   */
  teamIsMooring() {
    var p = secretRealm.getPabController();
    if (!p || typeof p.teamIsMooring !== 'function') return false;
    try {
      return !!p.teamIsMooring();
    } catch (e) {
      return false;
    }
  },
  /**
   * 该 cmd 是否有「已发出、未收到应答」的在途请求（走 watch 通道自带的 checkRequestIdNoRes，非主 NET）。
   * 符号缺失返回 false（不拦，宁可重发一次也不因探测不可用而永久闭开）。
   * @param {number} cmd 命令号
   * @returns {boolean}
   */
  isSecretSending(cmd) {
    var mgr = watchNetMgr();
    if (!mgr || typeof mgr.checkRequestIdNoRes !== 'function') return false;
    try {
      return !!mgr.checkRequestIdNoRes(cmd);
    } catch (e) {
      return false;
    }
  },
  /**
   * 秘境 promise 发包：包 TMWatchNetMgr.Instance.sendPBV2(cmd, data, target, cb)，cb 读 pbAckV2.header.s（0=成功）
   * 归一成 Ret{code,data,reason,ok}。与 net.sendPBV2 同形（NetMgrSimple 回调收到的是原始报文 e，形状与主 NET 一致）。
   * 永不 reject：未就绪/发送异常/超时无应答均回 Ret(code=SECRET_NOT_SENT)。
   * @param {number} cmd 命令号（秘境 85xx）
   * @param {object|null} data 载荷（逐键对齐录制/源码；Int64 按字符串透传）
   * @returns {Promise<object>} Ret 形结果
   */
  sendSecret(cmd, data) {
    var mgr = watchNetMgr();
    if (!mgr) return Promise.resolve(secretRet(SECRET_NOT_SENT, null, null));
    // 就绪预检：门面 是 `isPabBattleMap ? (this._socket&&this._isConnect&&this._isLogin&&this._socket.sendPBV2(…)) : NET.sendPBV2(…)`。
    //   两点约束：① 预检必须和路由同判据——非秘境态这条包其实走**主通道**、本来发得出去，无条件要求次通道就绪
    //     就会把成功的包拒成未发出（预检引入过的回归，此处收口）；
    //   ② 秘境态下三个 && 任一为假即既不发包也不报错（静默短路），不预检就只能白等 15s 超时才回落哨兵。
    //   isConnectStatus 是门面自带的只读判据（verbatim：`return this._socket&&this._isConnect&&this._isLogin`）。
    if (
      secretRealm.isPabBattleMap() &&
      typeof mgr.isConnectStatus === 'function' &&
      !mgr.isConnectStatus()
    ) {
      if (socketNotReadyWarned)
        log.debug('secondary socket still not ready, skip secret cmd %d.', cmd);
      else {
        socketNotReadyWarned = true;
        log.warn('secondary socket not ready (connect/login), skip secret cmd %d.', cmd);
      }
      return Promise.resolve(secretRet(SECRET_NOT_SENT, null, null));
    }
    // 走到这里说明当前路由态已确认可发包（秘境=次通道就绪已验、非秘境=主通道不受该门禁约束），即复位告警闸门：
    //   不等应答 code——否则「断线→warn→恢复→一串超时/业务拒→再次断线」会把第二次真断线默默降级成 debug
    socketNotReadyWarned = false;
    return new Promise(function (resolve) {
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        resolve(secretRet(SECRET_NOT_SENT, null, null));
      }, SECRET_TIMEOUT_MS);
      var done = function (code, d, reason) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(secretRet(code, d, reason));
      };
      try {
        mgr.sendPBV2(cmd, data || null, null, function (resp) {
          try {
            var header = (resp && resp.pbAckV2 && resp.pbAckV2.header) || {};
            var s = header.s;
            var d = resp && resp.pbAckV2 && resp.pbAckV2.data;
            done(s == null ? SECRET_NOT_SENT : s, d, s !== 0 ? header.d : null);
          } catch (e) {
            done(SECRET_NOT_SENT, null, null);
          }
        });
      } catch (e) {
        done(SECRET_NOT_SENT, null, null);
      }
    });
  },
  /**
   * 秘境房间背包余量（游戏 getItemNumById：`roomBagInfo.bagInfo`（或 `bagShareInfo`）里按 itemId 求 itemCount）。
   * @param {number|string} itemId 道具 id
   * @param {boolean} [share=false] true=读共享背包
   * @returns {number} 余量（背包未初始化/未持有回 0）
   */
  getItemNumById(itemId, share) {
    var p = secretRealm.getPabController();
    if (!p || typeof p.getItemNumById !== 'function') return 0;
    try {
      return Number(p.getItemNumById(Number(itemId), !!share)) || 0;
    } catch (e) {
      return 0;
    }
  },
  /**
   * 秘境次通道 **JSON 版**发包（`TMWatchNetMgr.Instance.send`）——与 sendSecret（PBV2）并列的第二条口子。
   *   必要性：`901 GET_WORLD_INFO` 在秘境图里走的是 JSON send，用 sendPBV2 发它拿不到 pointList。
   *   回调形如 `{s, d}`（d 是 JSON 字符串），s!==0 或超时回 null。
   * @param {number} cmd 命令号（秘境里用于 901 等 JSON 协议）
   * @param {object|null} data 载荷
   * @returns {Promise<object|null>} 解析后的应答体；未就绪/失败/超时一律 null（永不 reject）
   */
  sendSecretJson(cmd, data) {
    var mgr = watchNetMgr();
    if (!mgr || typeof mgr.send !== 'function') return Promise.resolve(null);
    return new Promise(function (resolve) {
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        resolve(null);
      }, SECRET_TIMEOUT_MS);
      var done = function (v) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(v);
      };
      try {
        mgr.send(cmd, data || null, null, function (resp) {
          try {
            if (!resp || Number(resp.s) !== 0) return done(null);
            done(typeof resp.d === 'string' ? JSON.parse(resp.d) : resp.d || null);
          } catch (e) {
            done(null);
          }
        });
      } catch (e) {
        done(null);
      }
    });
  },
  /**
   * **主动拉视口**（pilot 候选池的主数据源）。
   *   以 (cx,cy) 为中心发 901，拿回 `pointList`（每个点带 x/y/pointType/m{iNum,state,teams,esrId,rTime}）
   *   与 `marchList`（在途行军）。这是「不再依赖 10018 push 积累」的关键：push 只在镜头扫过时来，
   *   主动查才能随时拿到候选池（只靠 push 积累时 tiles.size 常年 2~3）。
   *   参数：width 20 / height 30 / viewLevel 1 / marchInfo true（覆盖 x±58 · y±39）。
   * @param {number} cx 视口中心 x
   * @param {number} cy 视口中心 y
   * @param {{width?:number,height?:number,viewLevel?:number,k?:number}} [opt]
   * @returns {Promise<{points:Array,marches:Array}|null>} 归一后的点/行军列表；未就绪/失败回 null
   */
  queryWorldView(cx, cy, opt) {
    var o = opt || {};
    var x = Number(cx);
    var y = Number(cy);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return Promise.resolve(null);
    var k = Number(o.k) || secretRealm.pabServerId() || 0;
    return secretRealm
      .sendSecretJson(901, {
        x: x,
        y: y,
        k: k,
        rid: 0,
        width: Number(o.width) || 20,
        height: Number(o.height) || 30,
        marchInfo: true,
        viewLevel: Number(o.viewLevel) || 0,
      })
      .then(function (r) {
        if (!r) return null;
        var pts = Array.isArray(r.pointList) ? r.pointList : [];
        var ms = Array.isArray(r.marchList) ? r.marchList : [];
        return {
          points: pts,
          marches: ms.map(function (m) {
            var bb = m.begin || {};
            var tt = m.target || {};
            var inf = m.info || {};
            return {
              bx: Number(bb.bx != null ? bb.bx : bb.tx) || 0,
              by: Number(bb.by != null ? bb.by : bb.ty) || 0,
              tx: Number(tt.tx != null ? tt.tx : m.target_tx) || 0,
              ty: Number(tt.ty != null ? tt.ty : m.target_ty) || 0,
              state: Number(m.state != null ? m.state : m.marchState) || 0,
              leaderUid: inf.leaderUid != null ? String(inf.leaderUid) : '',
            };
          }),
        };
      });
  },
  /**
   * 秘境图服号（901 请求体的 k）：`NWorldMapData.instance.serverData.currentServerId`，缺失回退 selfServerId。
   * @returns {number} 取不到回 0（调用方应放弃本次查询而不是拿错区发）
   */
  pabServerId() {
    var C = probe(SYM.modules.nWorldMapData + '.cls', function () {
      try {
        var m = game.get(SYM.modules.nWorldMapData);
        return (m && (m.NWorldMapData || m.default || m)) || null;
      } catch (e) {
        return null;
      }
    });
    var W = C && (C.instance || C);
    var sd = W && W.serverData;
    return Number(sd && (sd.currentServerId || sd.selfServerId)) || 0;
  },
  /**
   * 秘境增益值（游戏 `PabController.getPabBuffValueByType(type)`）：
   *   背包容量 = dataConfig(3017) + 本值（PabExtraPackItemNum），见 petPackCapacity。
   * @param {number} type BuffType 枚举值
   * @returns {number} 取不到回 0
   */
  getPabBuffValueByType(type) {
    var p = secretRealm.getPabController();
    if (!p || typeof p.getPabBuffValueByType !== 'function') return 0;
    try {
      return Number(p.getPabBuffValueByType(Number(type))) || 0;
    } catch (e) {
      return 0;
    }
  },
  /**
   * 房间背包快照 `roomBagInfo`（push 21525 写入）的**只读引用**：bagInfo 道具 / beastInfo 野兽 / protectBeasts。
   * 用于「百兽箱是否已满」「能捡几只兽」的判据。Int64 字段原样返回，不在此做 Number 转换。
   * @returns {object|null}
   */
  getRoomBagInfo() {
    var p = secretRealm.getPabController();
    return (p && p.roomBagInfo) || null;
  },
  /**
   * 正在拍宠的坐标 `capturingPetPos`（push 21530 写入）；未在拍回 null（或 x/y 非正）。
   * 驾驶层用它做「拍宠中不挪点」闸（挪点会清捕获进度）。
   * @returns {{x:number,y:number}|null}
   */
  getCapturingPetPos() {
    var p = secretRealm.getPabController();
    var v = p && p.capturingPetPos;
    if (!v) return null;
    var x = Number(v.x);
    var y = Number(v.y);
    return x > 0 && y > 0 ? { x: x, y: y } : null;
  },
  /**
   * 现在能不能发 8521（游戏 `isCanMarch = !!roomBaseInfo && teamIsMooring()`）。
   * 驾驶层用它当统一可发闸，避免自己拼判据漏项。
   * @returns {boolean}
   */
  isCanMarch() {
    return !!secretRealm.getRoomBaseInfo() && secretRealm.teamIsMooring();
  },
  /**
   * 全图行军列表归一（`NWorldMapData.instance.marches`）：选点前用它剔掉「已有己方行军指向该点」的目标。
   * 两种源形态不同（本地扁平 `target_tx/marchState`、901 嵌套 `target.tx/state`），此处统一成 `{bx,by,tx,ty,state,leaderUid}`。
   * @returns {Array<{bx:number,by:number,tx:number,ty:number,state:number,leaderUid:string}>}
   */
  getMarchList() {
    var C = probe(SYM.modules.nWorldMapData + '.cls', function () {
      try {
        var m = game.get(SYM.modules.nWorldMapData);
        return (m && (m.NWorldMapData || m.default || m)) || null;
      } catch (e) {
        return null;
      }
    });
    var W = C && (C.instance || C);
    var bag = (W && W.marches) || null;
    var out = [];
    if (!bag || typeof bag !== 'object') return out;
    var keys = Object.keys(bag);
    for (var i = 0; i < keys.length; i++) {
      var m = bag[keys[i]];
      if (!m) continue;
      var bb = m.begin || {};
      var tt = m.target || {};
      var inf = m.info || {};
      out.push({
        bx: Number(bb.bx != null ? bb.bx : m.begin_bx) || 0,
        by: Number(bb.by != null ? bb.by : m.begin_by) || 0,
        tx: Number(tt.tx != null ? tt.tx : m.target_tx) || 0,
        ty: Number(tt.ty != null ? tt.ty : m.target_ty) || 0,
        state: Number(m.state != null ? m.state : m.marchState) || 0,
        leaderUid: inf.leaderUid != null ? String(inf.leaderUid) : '',
      });
    }
    return out;
  },
  /**
   * 已在保护中的宠物 id 列表（游戏 `getBagPetIsPretecting` 的数据源：`roomBagInfo.protectBeasts`）。
   * 符号知识收口在此：那个数组的元素是 **protobuf Int64**（游戏侧靠 `.equals(e)` 比对），
   *   而上层拿到的是池化对象、且红线要求 64 位 ID 不做 Number 转换 → 统一在此按 `toString()` 归成字符串集。
   * @returns {string[]} 保护中的宠物 id（背包未初始化/符号缺失回空数组，上层据此**不拦**）
   */
  getProtectingPetIds() {
    var p = secretRealm.getPabController();
    var arr = (p && p.roomBagInfo && p.roomBagInfo.protectBeasts) || null;
    if (!Array.isArray(arr)) return [];
    var out = [];
    for (var i = 0; i < arr.length; i++) {
      var v = arr[i];
      if (v == null) continue;
      try {
        out.push(String(typeof v.toString === 'function' ? v.toString() : v));
      } catch (e) {
        /* 单个元素取不到就跳过，不能让整表读废 */
      }
    }
    return out;
  },
  /**
   * 本人是否队长（游戏 `isTeamLeader(uid=true 口径)`：`String(UserData.UID) === roomBaseInfo.leaderUid`）。
   * 两个玩法都拿它当闸：① 上临时停泊平台（176）——verbatim `NWorldPabBossPlanePopup.refreshUI` 里
   *   `marchBtn.active = isTeamLeader()`；② 攻打 BOSS（8521）——**UI 本身不查**（`NWorldPabBossPopup.refreshUI`
   *   覆盖了基类那句 `active = _isOpen && isTeamLeader() && !_haveSelfTeam`，`state===BOSS_FIGHTING` 直接置 active），
   *   但 8521 驱动的是**全队那一条**行军（roomBaseInfo 是队级快照：单一 startPoint/marchState + leaderUid），
   *   多人房各自发只会互抢方向盘，故主动收到队长。治疗不要求此闸。
   * @returns {boolean} roomBaseInfo 缺失/符号缺失回 false
   */
  isTeamLeader() {
    var p = secretRealm.getPabController();
    if (!p || typeof p.isTeamLeader !== 'function') return false;
    try {
      return !!p.isTeamLeader();
    } catch (e) {
      return false;
    }
  },
  /**
   * 秘境背包已捕获宠物清单（撤离带出/拿满判据的料源）的**只读副本**。
   * 数据源：`PabController.roomBagInfo.beastInfo`，条目取
   *   `cfgId`（enigma_beast 主键，查 quality 用）与 `id`（protobuf Int64，即 8581 BAG_GET_SET 的 `uuIds` 元素）。
   * ⚠ `beastInfo` 键**未实机确认存在**（游戏侧 roomBagInfo 常见五键里没有它）→
   *   读不到（缺字段/非数组）回 null 而非空数组，让上层能区分「清单为空」与「键不存在」，绝不拿读不到当「拿满」误离场。
   * 只读：`id` 原样透传（不做 Number/字符串化，与 protectBeasts 同一 Int64 形态，直接回填 8581 uuIds）。
   * @returns {Array<{cfgId:number,id:*}>|null} 不在秘境/背包未初始化/键缺失回 null
   */
  getRoomBagPets() {
    var p = secretRealm.getPabController();
    var bag = p && p.roomBagInfo;
    var list = bag && bag.beastInfo;
    if (!Array.isArray(list)) return null;
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var b = list[i];
      if (!b) continue;
      out.push({ cfgId: Number(b.cfgId) || 0, id: b.id });
    }
    return out;
  },
  /**
   * 宠物携带背包**总容量** = 基础格数 dataConfig(3017) + 增益 `GameDefine.BuffType.PabExtraPackItemNum` 的扩容。
   *   即 `Number(getDataConfigData(3017)) + pab.getPabBuffValueByType(GameDefine.BuffType.PabExtraPackItemNum)`。
   * 任一环取不到即** fail-safe 回 0**（调用方 leave.js 把 0 当「容量未知、不触发离场」，防把未坐实的阈值当成「拿满」误发整场退出）：
   *   3017 读不到/为 0、控制器无 getPabBuffValueByType、BuffType 枚举缺成员，都收 0。
   * @returns {number} 总容量（0 = 容量不可信，不触发离场）
   */
  petPackCapacity() {
    var conf = sharedValue('gameConf');
    var base = Number(conf && conf.dataConfig(3017)) || 0;
    if (!(base > 0)) return 0;
    var p = secretRealm.getPabController();
    if (!p || typeof p.getPabBuffValueByType !== 'function') return base;
    var GD = probe(SYM.modules.gameDefine + '.BuffType', () =>
      ns(game.get(SYM.modules.gameDefine)),
    );
    var BT = GD && (GD.BuffType || (GD.default && GD.default.BuffType));
    var extraType = BT && BT.PabExtraPackItemNum;
    if (extraType == null) return base; // 增益类型枚举取不到 → 只算基础格（少报扩容，判满偏保守）
    var extra; // 不给死初值：try 与 catch 两条路径各自赋值，旧 `= 0` 从未被读到
    try {
      extra = Number(p.getPabBuffValueByType(extraType)) || 0;
    } catch (e) {
      extra = 0;
    }
    return base + (extra > 0 ? extra : 0);
  },
  /**
   * 行军到某瓦片（秘境 8521 MARCH_MOVE，req `{x,y}`）——「上平台」与「攻打 BOSS」同一个入口。
   * 与游戏 `sendToBuildingMarch` 同口径：先查在途（`checkRequestIdNoRes`，游戏侧同一道闸）再发，
   *   故本方法**不直调游戏方法**（游戏侧那个方法除了这两个动作不写本地态，但我们走 ACL 统一通道以便超时与
   *   Ret 归一），零本地改写。注：游戏侧是 `||` 短路——在途时直接不发。
   * @param {number} x 目标瓦片横号
   * @param {number} y 目标瓦片纵号
   * @returns {Promise<object>|false} 在途被闸门拦下回 false（未发出）；否则回 sendSecret 的 Ret promise
   */
  sendMarch(x, y) {
    var nx = Number(x);
    var ny = Number(y);
    if (!Number.isFinite(nx) || !Number.isFinite(ny)) return false;
    if (secretRealm.isSecretSending(8521)) return false;
    return secretRealm.sendSecret(8521, { x: nx, y: ny });
  },
};

// ─────────────────────── 引擎回挂：能力自注册 + 世界态信号 ───────────────────────

registerCaps({
  // 异能秘境（Pab）三依赖：控制器类在场（实例由 subpack2 接管后才可取，故只校验类/静态方法）；观战通道单例 sendPBV2 在场；秘境地图门控 getter 在场
  pabController: () => {
    var C = ns(game.get(SYM_LOCAL.pabController));
    return !!(C && typeof C.getInstance === 'function');
  },
  watchNet: () => {
    var C = ns(game.get(SYM_LOCAL.watchNet));
    var inst = C && C.Instance; // 静态 getter 懒建单例（与游戏自身同路径）
    return !!(inst && typeof inst.sendPBV2 === 'function');
  },
  mapNewBiz: () => {
    var b = ns(game.get(SYM.modules.mapNewBiz)); // NWorldMapCoreBiz.default = 业务单例（isPabBattleMap 为其 getter）
    return !!(b && 'isPabBattleMap' in b);
  },
});

// 秘境图判据回挂共享世界态信号（core/world/state.js 经 game-api.worldSignals.pabBattleMap 消费，
// 注册前该信号保守回 false——秘境图只在玩法内可达，常态无误判风险）。
registerWorldSlot('pabBattleMap', () => secretRealm.isPabBattleMap());

// 调试面回挂：game-api.debug.secretRealm（仅供控制台）经共享插槽现取本适配器。
registerSharedValue('secretRealm', () => secretRealm);
