/**
 * BOSS 攻打 + 石头拾取引擎（异能秘境：一文件两档，共用一条 createCycle，攻打优先）。
 *
 * 语义边界：本引擎只做「到点即打」与「有石头即领」——**默认形态是玩家已手动画在对应区域的临时停泊平台（176）上**，
 *   自动挪台（autoRelocate）是独立开关且默认关（风险最高，见 §闸门「挪台档」）。
 *
 * ── 攻打档（8521 MARCH_MOVE `{x,y}` = 目标 BOSS 本体坐标）──────────────────────────
 * 料源与闸门（报文实证 dashcam 20261017T210400-异能秘境-队长.ndjson；源码 verbatim
 *   references/游戏逆向/extracted/subpack2/NWorldPabBossPopup / NWorldPabCommonPopup / RealPabController）：
 *   ① 可打态：ACL `getBossBaseInfo()`（游戏 Handler 收到 push 21535 后 verbatim `bossBaseInfo = a.stateInfo`）里
 *      `state === 21`（BOSS_FIGHTING）—— NWorldPabBossPopup.refreshUI **只在这个值点亮攻击按钮**。
 *      注：设计方案 §3.1 写的 `stateEndTime(秒)` 是错的，实测是 **Int64 毫秒**（417×2^32+1243037568 = 1792244400000），
 *      且语义是「**当前阶段**结束时刻」：state22 时它等于转 21 的时刻、state21 时是战斗窗口结束（11/12 +420s、9 +600s）。
 *   ② 在位态：`roomBaseInfo.pointType === 176`（PAB_BOSS_PLANE）**且** `marchState === NMarchState.ARRIVED`。
 *      实证行军四段式（21521 共 239 条，pointType 就是**当前所在点**的类型）：
 *      `ms=1 pt=176 sp=平台 tp=BOSS` → `ms=2 pt=178 sp=tp=BOSS` → `ms=1 pt=178 sp=BOSS tp=平台` → `ms=2 pt=176 sp=tp=平台`。
 *      两小同时、一大最后：+37.6 全 22 → +1139.1 先 12 进 21（同一毫秒 11 也进 21）→ +2159.1 boss9 才进 21（11/12 同时转 28）
 *      → +2303.4 boss9 转 30。实测一轮：小BOSS 4.6~5.4s、大BOSS 8~11s；**返航由服务器自动派**（返回段无第二条 8521）。
 *   ③ 区域配对（瓦片 esrId 料源）：
 *      ⚠ **旧结论「178 小BOSS 本体瓦片 0 条、读 esrId 只对大BOSS(177) 成立」已被推翻**：push 10018 是
 *        **视口增量**，去重后 178@(230,234) 实有 664 条且带 `esrId:22 state:21`（之前只取了单帧）→
 *        177/178 本体瓦片的 esrId 都能拿到，BOSS 本体 esrId 与平台 esrId 可直接精确比对。
 *        162 石头瓦片的 `esrId` 仍**恒为 0**（不参与配对）。
 *      平台（176）：共 253 个分三桶 esrId（实证去重后 20/21/22），boss 半径内平台 esrId 与 BOSS 一致。
 *      ⚠ **平台瓦片的 `bid`/`viewId` 恒为 11，不是 bossId**（曾据此误判配对关系），bossId 一律取 21535 的 `bossId`。
 *      → 配对闸三级：① 拿到 BOSS 本体 esrId → 与当前平台 esrId 精确比对（强闸）；
 *        ② 该 bossId 已学过区域 → 按学到的 esrId 比对（强闸）；
 *        ③ 区域未知 → **同一 (平台 esrId, bossId) 只给一次试探**（无证据时只能靠撞拒绝来学）。
 *        两条例外不得烧掉试探额度：这一对**真打进过**（#areaOk）就长期放行；包**没上线**不记账。
 *        必要性：“平台 esrId 靠 push 10018 增量填、而引擎启动前玩家往往已停在 176 上”是默认使用形态
 *          → `#platformEsr()` 长期回 null；若把「成功但平台区域未知」也当成用掉了试探，就会变成
 *          **越成功越打不了**（大BOSS 177 恰恰是唯一有本体 esrId 证据、最容易落进这条分支的）。
 *      客户端攻打入口**不查 esrId、也不查 isTeamLeader**（verbatim `roomBaseInfo?.pointType === PAB_BOSS_PLANE
 *      ? super.marchClick() : ShowTips("enigma_realm141")`）→ 区域是**服务器独占判据**，本地无法预知；
 *      故被 `enigma_realm142` 拒时**只降级「(平台 esrId, bossId)」这一对**，绝不把 bossId 整体拉黑
 *      （否则换了平台的玩家就永久打不了这只）。
 *      **就近档**（排序键、非过滤闸）：实测同一只 BOSS 到**它自己区域**的平台最近 1.4~7.1 格、到**跨区域**平台
 *        最近 19.8~63.9 格（`tuning.bossNearRadius` 注有全库对账数据）→ 把近区候选排在前面，等于用「距离」
 *        这个零成本代理优先进「大概率同区域」的那一枪，把 142 试探次数压到最少（竞对脚本就是纯按距离排序）。
 *      **队长闸**（本引擎主动加，与上面那条 UI 不对称并不矛盾）：8521 驱动的是**全队那一条**行军
 *        （roomBaseInfo 实证为队级快照：单一 startPoint/marchState + leaderUid）→ 五人房各自发会互抢
 *        方向盘，并把 #rounds/#probed 各客户端各算一份的偏差放大，故成员侧不发攻打（与竞对脚本同款）。
 *   ④ 客户端闸（NWorldPabCommonPopup.marchClick verbatim，本引擎逐条复刻）：
 *      `roomBaseInfo && startPoint` 在场；目标点 ≠ 当前点（否则 `enigma_realm157` 静默）；
 *      **在拍普通宠**（`capturingPetPos.x>0 && boss!=1`）时挪点会清空当前捕获进度（游戏要弹 `enigma_realm208` 确认）
 *      → 自动化**放弃这一轮**，等拍完再打（攻打档绝不替玩家确认清进度）。
 *      ⚠ **旧口径「攻打同区域 BOSS 不受在拍闸约束」已被 dashcam 20261101T200401 推翻**：大BOSS 进入投喂/
 *        拍宠物窗（push 21530 推 `{x,y,boss:1}` + 瓦片 `state 21→23`）那一刻，**服务端拒绝对该点的攻打行军**
 *        （8521 连吃 `common_159995`），游戏侧此时也只给拍宠 UI、不给攻击按钮 → 本引擎把 `boss===1` 的在拍窗
 *        一并纳入在拍闸（拍 BOSS 期间把队伍开走同样等于丢掉己方那一窗的分数，与拍普通宠同口径）。
 *   ④-b **现场瓦片闸**（本引擎主动加）：`state===21` 这条料源是 push 21535 的快照，而 21535 **在阶段切换那一刻
 *        不推**（实证：大BOSS 21→23 时 21535 下一条要到 +39.2s 窗关闭才推 state30；小BOSS 本体瓦片 +1244.1s 已
 *        `pointType→0`（点消失），21535 的 state28 却晚 400s 才推）→ 单靠它会「越该停手越连撞」。故候选点若被
 *        push 10018 快照证明当前不是 21（含点已消失），这一拍不发（见 #liveTileBlock）。
 *   ⑤ 游戏侧「每 cmd 只允许一条在途」（verbatim `checkRequestIdNoRes(8521) || sendPBV2(8521,{x,y},…)`）
 *      → ACL `sendMarch()` 已内置该闸，回 `false` 就是「这一拍没发出去」，不作任何记账、下一拍重试。
 *
 * ── 触发源（事件驱动 + 兜底 cycle）──────────────────────────────────────────────
 *   kick：push 21535（状态机）、push 21521（行军/在位现场）、push 21539（石头账本）、
 *     push 21529 TEAM_ARRIVE（最及时的「已抵达」信号，也是 158「尚未抵达」的解除信号 → 收到即重跑被打 158 的攻打）。
 *   **push 10018 只写快照、绝不 kick**（实测 7733 条 ≈3 条/秒，kick 会把 2s 兜底拍打成 3Hz）。
 *   兜底：cycle fallback `tuning.bossScanMs`（21535 一场只推 5 条、21521 稀疏，漏拍必须能自愈）。
 *   推送载荷口径两条不同（实证）：21521/21535/21539 是 `ev.data = {header:{ts,s}, data:{…}}`（本引擎只拿它们当唤醒源，
 *   业务态一律重读 ACL 落地快照）；**10018 是平的** `ev.data = {pointInfos:[{v,x,y,k,id,pointType,m}]}`。
 *
 * ── 拒绝码处置（攻打）──
 *   ⚠ **旧口径「8521 全 s=0、零拒绝」已被 dashcam 20261018T200040 推翻**：本份 8521 共 310 次、
 *     拒绝分布 `158×80 / 163×3 / 17×2 / common_159995×1`（158 = 「小队尚未抵达」，量最大）——故 158 不再是防御性实现，
 *     而是主流程常态（行军指令发得太早、尚未 ARRIVED）。其余 142/141 仍在 19 份录音 0 命中（未观测预防性代理）。
 *   退避是这一档的第一条：任一 `s≠0` 都先进 `tuning.rejectBackoffMs`（5s）静默，141 更给
 *     `tuning.planeRefreshMs`（15s，等 push 21521 把 roomBaseInfo 刷正）——否则被拒路径会以 ≈5 条/秒重发同一条 8521。
 *   `enigma_realm158` → **小队尚未抵达**（行军态未 ARRIVED 就发攻打）→ **不烧配对试探额度、不拉黑**，
 *     只退 `tuning.rejectBackoffMs`；抵达信号以 push 21529 TEAM_ARRIVE 为准（见下「触发源」），收到即重跑。
 *   `enigma_realm142` → 该 (平台 esrId, bossId) 记 wrongArea（区域闸降级，**不拉黑 bossId**）；
 *   `enigma_realm141` → 已不在 176（被顶掉/被召回）→ 回 IDLE，等 21521 刷正；
 *   `enigma_realm157` → 目标点==当前点，正常语义 → 静默（debug），不拉黑；
 *   `enigma_realm163` → 目标点不能行军 → 该坐标拉黑 `tuning.rejectBlacklistMs`（6h）；
 *   `enigma_realm162` → 服务器抖动形态 → 该 bossId 给**一次**重试；
 *   `CODE_NOT_SENT`  → 未真正上线（次通道频控/静默短路）→ **不动配对账**（尤其不置 #probed），下一拍重试；
 *   `common_159995`  → 攻打档里**不是包形态错**（req 恒 `{x,y}` 两键，成功与被拒同形，实证 20261101T200401 的
 *     284 条 8521 里 9 条吃它：8 连在大BOSS 投喂窗 +2217~+2252.5s、1 发在小BOSS 瓦片刚消失 +1245.0s）
 *     → 语义是「该点当前不可打」→ **短拉黑该坐标** `tuning.paramBlacklistMs`（60s，覆盖实测 39.2s 的投喂窗），
 *     不烧配对试探额度（不是区域错）、不拉黑 bossId；正常路径已被 ④/④-b 两条闸挡住，走到这里说明本地闸再次失真。
 *   其它 `s≠0`       → info 一条（同一目标只提示首见，之后降 debug，防逐拍刷屏）。
 *
 * ── 石头档（8548 BOSS_GUARD_REWARD_GET `{x,y}`，**不带 bossId**）──────────────────
 * 报文实证同一会话：bossId 由服务器按坐标反推，且**不要求队伍站在石头点上**（在平台 (237,229) 领到了石头点 (230,228)）；
 *   ⚠ **石头能不能领只看账本（push 21539）给没给点，不看 BOSS 死活**（旧「死后掉落」说法无据）：
 *     实证 boss12 仍处 state21（战斗中）时 +1510.9s 已能领到它的石头 → 只要有 21539 条目就发 8548。
 *   应答 inner = `{rewardInfo:{bossId,fightTime:Int64,rewardInfo:[单点]}, rewardResult:{resource,items[…],enigmaBeast}, boxOpen, boxOpenBeast}`。
 *   **每个小BOSS 固定 5 个点位、每人每点位限领 1 次**（rewardMaxNum 只到 1；boss12 五点 =
 *   (230,228)(232,230)(229,235)(231,235)(228,230)）。重复领同点 → `s=3 d=enigma_realm60` 且应答 rewardInfo 退化成空数组。
 * 游戏侧「可领」判据两条都要（verbatim RealPabController）：`getCurIsJoinFightBossGuard` = `isFight===1`、
 *   `getCurIsCanReceiveBossGuardReward` = `pos.x===x && pos.y===y && rewardNum<rewardMaxNum`。
 * 拒绝处置：`enigma_realm60` → 该点位**永久**拉黑（领完就是领完）；`enigma_realm179`（未参战）→ 该 bossId 整组静默
 *   `tuning.stoneSkipMs`（不可恢复，但到期允许再试，防改版后变成可领时永久锁死）；`enigma_realm162` → 该点位重试一次；
 *   未真正发出 → 不动本地账，节拍按 `tuning.stoneGapMs → tuning.getGapMaxMs` 退避（与拾取侧同曲线）。
 *   应答带 `boxOpen/boxOpenBeast`（抽卡）**只记账不代答**——游戏自己 OpenUI `PabWorldCBossSucDrawCardPanel`，代答属越权。
 *
 * 只读+发包红线：全程只走 ACL 只读快照 + `sendMarch`/`sendSecret`；瓦片快照由本引擎订阅 push 10018 自建
 *   （ACL 不提供瓦片查询，游戏侧 tile getter 的调用方式未实证，不猜符号链），不调游戏侧任何 Update/Delete、
 *   不镜像血量/积分。Int64（stateEndTime/fightEndTime/fightTime）一律 `toNum` 读、不回写。
 *
 * ── 挪台档（BOSS_AUTO.relocate 恒关，无面板开关；风险最高，默认不启用）──────
 *   设计方案 §3.4 的「停泊点自动选择」：只在**本拍有 state21 的 BOSS 过不了区域闸**时启动（需求源 #blockedNow），
 *   候选 = 快照里 `pt=176 && esrId 命中目标区域（或跨区域探一台）&& state=22 && isFight!==1 && teams 空` 中
 *   **距当前位置最近**的一台，发同一条 8521（目标 = 平台坐标）。闸门与风险口径见 #tryRelocate 注释
 *   （isFriend 无 ACL → 取「有任意驻军就不挪」的更严近似；跨 esrId 才挪防 209）。
 */
import { createCycle } from '../../../core/cycle.js';
import { bits } from '../../../core/game-api.js';
import { tileKey as utilTileKey, dist as utilDist } from './util.js';
import {
  CMD_MARCH_MOVE,
  CMD_BOSS_GUARD_GET,
  PUSH_BASE_INFO,
  PUSH_BOSS_STATE,
  PUSH_BOSS_GUARD_REWARD,
  PUSH_TILE_INFO,
  PUSH_TEAM_ARRIVE,
  PAB_BOSS_PLANE,
  PAB_BOSS,
  PAB_BOSS_GUARD,
  PAB_BOSS_GUARD_REWARD,
  ST_BOSS_FIGHTING,
  ST_BOSS_FEED,
  ST_PLANE_MARCH,
  REJ_BOSS_AREA,
  REJ_NEED_PLANE,
  REJ_NOT_ARRIVED,
  REJ_ALREADY_THERE,
  REJ_NO_MARCH_TARGET,
  REJ_RETRY,
  REJ_STONE_USED_UP,
  REJ_NOT_IN_FIGHT,
  REJ_PARAM_ERROR,
  CODE_NOT_SENT,
  tuning,
} from './constants.js';

/** @type {number} 只在攻打档认的 BOSS 本体瓦片类型（177 大 / 178 小）；其余瓦片条目对本引擎无意义 */
const BOSS_TILE_TYPES = [PAB_BOSS, PAB_BOSS_GUARD];

/**
 * 点型是否 BOSS 相关（176 平台 / 177 大BOSS / 178 小BOSS）——自动驾驶开启时本引擎可否发攻打行军的判据
 *   （与 pilot.js isBossish 同口径：不在这些点上时行军权全归 drive）。
 * @param {number} pt 瓦片 pointType
 * @returns {boolean}
 */
function isBossTile(pt) {
  return pt === PAB_BOSS_PLANE || pt === PAB_BOSS || pt === PAB_BOSS_GUARD;
}

/**
 * protobuf Long / {_low,_high} / number / 字符串 → 数值（取不到回 0）。与 capture.js/heal.js 同口径。
 * @param {*} v 数值字段原值
 * @returns {number}
 */
function toNum(v) {
  return bits.int64ToNum(v);
}

/**
 * sendSecret 的 Ret 是否业务成功（收口 net.Ret 的 `ok` getter 与 game-api 降级普通对象两种口径）。
 * @param {object|null} r Ret 形结果
 * @returns {boolean}
 */
function isOk(r) {
  if (!r) return false;
  return r.ok === undefined ? Number(r.code) === 0 : !!r.ok;
}

/**
 * 点位键（瓦片快照与拉黑集都用它）。非法坐标回 ''。
 * @param {number} x 横号
 * @param {number} y 纵号
 * @returns {string} 'x,y' 或 ''
 */
function tileKey(x, y) {
  return utilTileKey(x, y);
}

/**
 * 两瓦片的欧氏格距（攻打就近档与挪台候选共用一份口径，与 `tuning.bossNearRadius` 的实证数字对齐）。
 * 任一坐标非法回 Infinity = 排到最后、不进「近区」档（不拿 NaN 参与比较，否则排序结果不确定）。
 * @param {number} ax 甲点横号
 * @param {number} ay 甲点纵号
 * @param {number} bx 乙点横号
 * @param {number} by 乙点纵号
 * @returns {number}
 */
function dist(ax, ay, bx, by) {
  return utilDist(ax, ay, bx, by);
}

/**
 * BOSS 攻打 + 石头拾取引擎（单条电平循环：先攻打档、再石头档）。
 */
export class BossEngine {
  #env;
  /** @type {{kick:Function}|null} */
  #cycle = null;
  /** @type {boolean} 引擎存活位：stop() 置 false 后 cycle 睡眠中的定时器到点即自然终止（cycle 不会撤定时器） */
  #active = false;
  /**
   * @type {Map<string,{pt:number,esrId:number|null,state:number,sET:number,isFight:number,teams:number,at:number}>}
   * push 10018 自建的**瓦片快照**（键 `x,y`，LRU 上限 tuning.tileExtMax）。ACL 无瓦片查询口，本地区域判据只能来自这里。
   */
  #tiles = new Map();
  /** @type {Object<string,number>} 已学到的「bossId → 区域 esrId」（首发成功即学到） */
  #areaLearn = {};
  /** @type {Object<string,1>} 已确认**不同区域**的 `平台esr, bossId` 对（区域闸降级，不拉黑 bossId） */
  #wrongArea = {};
  /** @type {Object<string,1>} 已给过试探机会的 `平台esr, bossId` 对（无本地证据时同键只试一次；**只有真拿到服务器判定才算用掉**） */
  #probed = {};
  /** @type {Object<string,1>} 已证实**可行**的 `平台esr, bossId` 对（该对真打进过 → 区域闸直接放行，不再占用试探） */
  #areaOk = {};
  /** @type {Object<string,number>} 目标坐标拉黑到期时刻（Date.now）：仅 enigma_realm163 写入 */
  #targetBlack = {};
  /** @type {Object<string,1>} 已提示过首见拒绝的键（攻打 `x,y|bossId`、141 `plane141|…`、挪台 `reloc|x,y`；同键之后降 debug，防刷屏） */
  #toldReject = {};
  /** @type {Object<string,1>} 已用过一次重试的 bossId（攻打档 162 只给一次机会） */
  #marchRetried = {};
  /** @type {Object<string,1>} 已给过重试的石头点位 */
  #stoneRetried = {};
  /** @type {Object<string,1>} 已领满/领过的石头点位（enigma_realm60 → 本会话永久） */
  #stoneUsed = {};
  /** @type {Object<string,number>} bossId → 整组静默到期时刻（撞 179 未参战时写入） */
  #stoneSkip = {};
  /** @type {string} 石头档在途点位键（每 cmd 单在途，未落地不再发第二条） */
  #stoneInflight = '';
  /** @type {number} 石头档当前节拍（毫秒），撞「未发出」按曲线翻倍到 tuning.getGapMaxMs */
  #stoneGap = tuning.stoneGapMs;
  /** @type {Object<string,number>} bossId → 已发动攻打轮数（BOSS_AUTO.maxRounds 恒 0=不限，打死为止） */
  #rounds = {};
  /** @type {number} 本轮返回给 cycle 的睡眠（0=还有活，立即再跑） */
  #sleep = 0;
  /** @type {boolean} 本拍是否真发出了一个包（8521/8548）——没发出就不能回 0，否则成紧密空转 */
  #didSend = false;
  /** @type {Object<string,number>} bossId → 首次见到 state===21 的时刻（排序 tie-break：先进入战斗的在先） */
  #seen21 = {};
  /** @type {number} 两枪之间的最小间隔 / 被拒退避到期时刻（Date.now）：成功写 ATTACK_COOLDOWN_MS，任一 `s≠0` 写 tuning.rejectBackoffMs（141 写 planeRefreshMs） */
  #cooldownUntil = 0;
  /** @type {number} 攻打一枪发出后的最小冷却（毫秒，内置不调面板） */
  static ATTACK_COOLDOWN_MS = 1000;
  /** @type {boolean} 是否有攻打包在飞（只用于四段式对账日志与轮数记账，防并发靠 marchState + 每 cmd 单在途闸） */
  #marchInFlight = false;
  /** @type {string} 在飞攻打的目标描述（日志用） */
  #marchTag = '';
  /**
   * @type {Array<{bossId:number,kind:number}>}
   * 本拍「state===21 但过不了区域闸」的 BOSS（挪台档的唯一需求源；#pickTarget 每次刷新，不留陈旧值）。
   */
  #blockedNow = [];

  /** @param {object} env 注入底座 {alive, realmActive, cfg, secret, log} */
  constructor(env) {
    this.#env = env;
  }

  // ── 一拍调度 ────────────────────────────────────────────────────────

  /**
   * 一拍：攻打档优先，石头档其次；返回下拍睡眠（毫秒）。
   * 择时三条：**真发出了包 → 0（立即补扫，由在飞/节拍闸门接住）**；没发出但某一档定了短睡 → 那个值；
   *   两档都无事可做 → tuning.bossScanMs 兜底（不能回 0，cycle 的 `<=0` 是立即重跑，会变紧密空转）。永不 reject。
   * @returns {number} 下拍间隔
   */
  #tick() {
    const env = this.#env;
    if (!env.alive()) return 0;
    if (!env.realmActive()) return tuning.bossScanMs;
    this.#sleep = 0;
    this.#didSend = false;
    const b = env.cfg().boss;
    if (b && b.enabled) this.#attackTick(b);
    else if (!b || !b.stone) return tuning.bossScanMs;
    if (b && b.stone && !this.#didSend) this.#stoneTick();
    if (this.#didSend) return 0;
    return this.#sleep || tuning.bossScanMs;
  }

  /**
   * 攻打档一拍：闸门全过 → 选目标 → 发一条 8521。一拍最多发一条（游戏侧每 cmd 只允许一条在途）。
   * @param {object} b 面板 boss 配置
   */
  #attackTick(b) {
    const env = this.#env;
    const now = Date.now();
    // 这一条既拦两枪最小间隔、也拦被拒退避（#handleMarchReject 写长档），且必须定 #sleep 而不能回 0
    if (now < this.#cooldownUntil) {
      this.#sleep = this.#cooldownUntil - now;
      return;
    }
    const base = env.secret.getRoomBaseInfo();
    if (!base || !base.startPoint) return; // 现场未落地（realm141 的本地近似）→ 不发
    const S = env.secret.getNMarchState();
    const arrived = S && S.ARRIVED != null ? Number(S.ARRIVED) : 2;
    if (Number(base.marchState) !== arrived) {
      env.log.debug('boss attack: marchState=%s not ARRIVED(%d).', base.marchState, arrived);
      return;
    }
    // 只有「当前所在点是 176 平台」才允许发下一次（四段式实证：在飞两段 pt 分别是旧平台与 BOSS 本体）
    if (Number(base.pointType) !== PAB_BOSS_PLANE) return;
    if (!env.secret.teamIsMooring()) return;
    // 队长闸（见文件头 §③「队长闸」）：UI 不查队长，但 8521 驱动的是全队那一条行军，成员侧不发
    if (!env.secret.isTeamLeader()) {
      env.log.debug('boss attack: not team leader (team march is leader-driven), skip.');
      return;
    }
    // 自动驾驶让闸：drive.enabled 时「开往平台/巡航/逃袭」的行军权归 drive 统一方向盘，本引擎只在队伍
    //   已停在 176/177/178 上才发攻打行军（到平台后攻打仍照旧由本引擎接管）；非 BOSS 点一律让位，
    //   避免 drive 的 TO 行军与攻打行军互抢那一条 8521 在途位（见 pilot.js 文件头）。关掉 drive 时行为不变。
    const drv = env.cfg().drive;
    if (drv && drv.enabled && !isBossTile(Number(base.pointType))) {
      env.log.debug('boss attack: drive on & not on a BOSS tile → skip (reason=drive-driving).');
      return;
    }
    if (env.secret.isSecretSending(CMD_MARCH_MOVE) || this.#marchInFlight) {
      this.#sleep = 200;
      return;
    }
    const busy = this.#captureBusy();
    if (busy) {
      env.log.debug('boss attack: busy capturing (%s), skip this round.', busy);
      return;
    }
    const target = this.#pickTarget(b);
    if (!target) {
      // 有 state21 的 BOSS 但被区域闸拦下 → 在「同区域平台」上干等没意义，只在开关打开时试一次挪台
      if (b && b.relocate && this.#blockedNow.length) this.#tryRelocate();
      return;
    }
    this.#sendAttack(target, b);
  }

  /**
   * 石头档一拍：从 21539 落地账本里取一个「可领且未拉黑」的点位，发一条 8548。
   * 不读面板子配置（石头档只受 `boss.stone` 总闸约束，那一层在 #tick 里判）。
   */
  #stoneTick() {
    const env = this.#env;
    const now = Date.now();
    if (this.#stoneInflight) {
      this.#sleep = this.#stoneGap;
      return;
    }
    if (env.secret.isSecretSending(CMD_BOSS_GUARD_GET)) {
      this.#sleep = 200;
      return;
    }
    const groups = env.secret.getBossGuardRewardInfo();
    if (!Array.isArray(groups) || !groups.length) return;
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      if (!g || g.bossId == null) continue;
      const bid = Number(g.bossId);
      const skipUntil = this.#stoneSkip[bid] || 0;
      if (now < skipUntil) continue;
      const pts = Array.isArray(g.rewardInfo) ? g.rewardInfo : [];
      for (let j = 0; j < pts.length; j++) {
        const p = pts[j];
        if (!p || !p.pos) continue;
        const x = Math.floor(toNum(p.pos.x));
        const y = Math.floor(toNum(p.pos.y));
        const k = x + ',' + y;
        // 游戏两条判据都要（verbatim getCurIsJoinFightBossGuard / getCurIsCanReceiveBossGuardReward）
        if (Number(p.isFight) !== 1) continue;
        if (!(toNum(p.rewardNum) < toNum(p.rewardMaxNum))) continue;
        if (this.#stoneUsed[k]) continue;
        this.#sendStone(bid, x, y);
        this.#sleep = this.#stoneGap;
        return;
      }
    }
  }

  // ── 目标选择与区域配对 ──────────────────────────────────────────────

  /**
   * 是否在拍异能兽/**大BOSS**（`capturingPetPos.x>0`，push 21530 写、结束推 `{x:-1,y:-1}`）。
   *   两条依据都要求攻打档让路：
   *   ① 拍**普通宠**（`boss!=1`）：verbatim NWorldPabCommonPopup.marchClick 里挪点会触发
   *     `enigma_realm208`「离开后当前异能兽捕获进度将被清空」的确认弹窗 → 自动化绝不替玩家确认；
   *   ② 拍**大BOSS**（`boss===1`，即瓦片 `state=23` 的投喂/拍宠窗）：实证 20261101T200401，该窗内
   *     对同一坐标的 8521 全部被服务端拒 `common_159995`（8 连），且把队伍开走同样丢掉己方这一窗的分。
   *   ⚠ 旧注释写的「攻打同区域的 BOSS 不走这条闸」是**未实证的推断**，已被上面那份报文推翻（见文件头 §④）。
   *   本窗不需要额外兜底：游戏侧每 10s 有自愈（瓦片 state 不是 FEED/BOSS_FEED 时把 capturingPetPos 打回
   *   `{x:-1,y:-1}`，verbatim PabWorldUINew.updateCapturingData），窗关闭后 2s 的兜底拍即恢复攻打。
   * @returns {string|null} 让路原因（`null`=可以打；debug 日志用，不再回布尔把两种语义混起来）
   */
  #captureBusy() {
    const pab = this.#env.secret.getPabController();
    const cap = pab && pab.capturingPetPos;
    if (!cap || toNum(cap.x) <= 0) return null;
    return Number(cap.boss) === 1
      ? 'BOSS feed window at (' + Math.floor(toNum(cap.x)) + ',' + Math.floor(toNum(cap.y)) + ')'
      : 'a normal pet (realm208 would clear progress)';
  }

  /**
   * 从 21535 落地态里挑一个可打目标（state===21 + 战斗窗口未过 + 石头账本未榨干（见 #stoneExhausted）+
   * 未被拉黑 + 过区域闸）。每条候选带一个 `d` = 到**当前所停平台**的欧氏格距（就近档用，见文件头 §③）。
   * @param {object} b 面板 boss 配置 {order,maxRounds}
   * @returns {{bossId:number,x:number,y:number,kind:number,d:number,platEsr:number|null}|null}
   */
  #pickTarget(b) {
    const env = this.#env;
    this.#blockedNow = [];
    const list = env.secret.getBossBaseInfo();
    if (!Array.isArray(list) || !list.length) return null;
    const ob = env.secret.getRoomBaseInfo();
    const orig = ob && (ob.startPoint || ob.targetPoint);
    const cand = [];
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      if (!s || s.pos == null) continue;
      if (Number(s.state) !== ST_BOSS_FIGHTING) continue;
      if (this.#fightOver(s)) continue;
      const bid = Number(s.bossId);
      if (!bid) continue;
      // 石头账本已榨干的小BOSS 不再开台（借鉴竞品B guard_policy=3：打完不再吃行军——178 的唯一产出就是 21539
      //   点位账（每人每点限领 1 次、固定 5 点），全组领完/不可领后再攻不产出任何东西；大BOSS 无组不过滤）。
      if (this.#stoneExhausted(bid)) {
        env.log.debug('boss attack: boss %s skipped (guard-stone ledger exhausted).', bid);
        continue;
      }
      const x = Math.floor(toNum(s.pos.x));
      const y = Math.floor(toNum(s.pos.y));
      const k = x + ',' + y;
      // 现场瓦片闸（文件头 §④-b）：10018 已证明该点不是 state21（进投喂窗/点消失）→ 不发这一枪
      const live = this.#liveTileBlock(k);
      if (live) {
        env.log.debug('boss attack: boss%d @(%s) skipped by live tile (%s).', bid, k, live);
        continue;
      }
      const exp = this.#targetBlack[k] || 0;
      if (exp) {
        if (Date.now() < exp) continue;
        delete this.#targetBlack[k];
      }
      const maxR = Math.max(0, Math.floor(Number(b.maxRounds) || 0));
      if (maxR > 0 && (this.#rounds[bid] || 0) >= maxR) continue;
      cand.push({
        bossId: bid,
        x: x,
        y: y,
        kind: this.#tileTypeAt(k),
        d: orig ? dist(x, y, orig.x, orig.y) : Infinity,
      });
    }
    if (!cand.length) return null;
    cand.sort(this.#orderCmp(b && b.order === 'boss' ? 'boss' : 'guard'));
    const platEsr = this.#platformEsr();
    for (let i = 0; i < cand.length; i++) {
      const t = cand[i];
      if (this.#areaGate(t, platEsr)) {
        t.platEsr = platEsr;
        return t;
      }
      this.#blockedNow.push({ bossId: t.bossId, kind: t.kind });
    }
    env.log.debug(
      'boss attack: no target passes area gate (platEsr=%s, candidates=%s [bossId@距当前平台格数]).',
      String(platEsr),
      cand
        .slice(0, 6)
        .map(function (x) {
          return x.bossId + '@' + (Number.isFinite(x.d) ? x.d.toFixed(1) : '?');
        })
        .join('/'),
    );
    return null;
  }

  /**
   * 目标排序比较器（同区域只允许一支队在打，故一次只挑一个）。
   * 键序：**就近档**（`tuning.bossNearRadius`，非过滤——远档仍留在队尾）→ 面板偏好 → 先进 state21 的在先 → bossId。
   * 就近档排在偏好**之前**的理由：偏好是「想先清小还是先打大」，而跨区域目标根本打不出去（142）
   *   → 先在本档内满偏好，本档空了才往远处探，而不是一路撞远处的 142。
   * 大/小BOSS 由**本体瓦片类型**判：177 大 / 178 小 / 取不到（录音里 178 一条都没有）按「未知」归先打档，
   *   避免因为缺证据就把小BOSS 拖到最后。
   * @param {'guard'|'boss'} priority 面板偏好
   * @returns {(a:object,c:object)=>number}
   */
  #orderCmp(priority) {
    const self = this;
    const near = tuning.bossNearRadius;
    return function (a, c) {
      const na = a.d <= near ? 0 : 1;
      const nc = c.d <= near ? 0 : 1;
      if (na !== nc) return na - nc;
      const pa = a.kind === PAB_BOSS ? 1 : 0;
      const pc = c.kind === PAB_BOSS ? 1 : 0;
      const va = priority === 'boss' ? pa : 1 - pa;
      const vc = priority === 'boss' ? pc : 1 - pc;
      if (va !== vc) return va - vc;
      return self.#seenAt(a.bossId) - self.#seenAt(c.bossId) || a.bossId - c.bossId;
    };
  }

  /**
   * 「该 BOSS 首次被我们看到 state===21」的时刻（跨拍记账，供排序 tie-break）。
   * @param {number} bossId BOSS id
   * @returns {number} epoch ms（没见过回 0，即最优先）
   */
  #seenAt(bossId) {
    return this.#seen21[bossId] || 0;
  }

  /**
   * 区域闸：本地判据只在「有证据」时是强闸，无证据时退化为「同一对只试探一次」。
   * 三级（详见文件头 §③）：BOSS 本体 esrId → 已学区域 → 未知即试探。
   * @param {{bossId:number,kind:number}} t 候选
   * @param {number|null} platEsr 当前所在平台的 esrId（瓦片快照取不到时 null）
   * @returns {boolean} true=允许发这一枪
   */
  #areaGate(t, platEsr) {
    const bossEsr = this.#bossEsr(t.bossId, t.kind);
    const learned = this.#areaLearn[t.bossId];
    const expect = bossEsr != null ? bossEsr : learned;
    const pair = platEsr + '|' + t.bossId;
    if (this.#wrongArea[pair]) return false;
    // 这一对已经真打进过（服务器区域判据过了）→ 直接放行。平台区域取不到（快照未覆盖当前点）是常态，
    //   不能让「第一枪成功」反而把这只 BOSS 永久锁在闸外
    if (this.#areaOk[pair]) return true;
    if (expect != null) {
      if (platEsr == null) return !this.#probed[pair]; // 平台区域未知：只能靠撞 142 来确认
      if (platEsr !== expect) return false; // 强闸：明显不同区域，不发（省一枪）
      return true;
    }
    return !this.#probed[pair]; // 区域完全未知 → 同一对只给一次试探
  }

  /**
   * 记录一次「真上线」的配对事实。`#probed` 的语义是「这一对已用掉唯一的试探机会 = 已拿到服务器判定」：
   *   被拒 → 置 #probed（探过了，别再反复探）；
   *   成功 → 只记 #areaOk（可行证据），平台 esrId 可得时顺手学给该 bossId，**不消耗试探额度**。
   * ⚠ 未上线（sendMarch 回 false / CODE_NOT_SENT）一律不进这里：没有服务器判定却记账，
   *   会把这只 BOSS 在本会话永久锁死（次通道频控 / 静默短路在秘境侧是常态）。
   * @param {{bossId:number,platEsr:number|null}} t 目标（含当前平台 esrId）
   * @param {boolean} ok 该 8521 是否被服务器接受
   */
  #noteArea(t, ok) {
    const pair = t.platEsr + '|' + t.bossId;
    if (!ok) {
      this.#probed[pair] = 1;
      return;
    }
    this.#areaOk[pair] = 1;
    if (t.platEsr != null) this.#areaLearn[t.bossId] = t.platEsr;
  }

  /**
   * 被 enigma_realm142 拒：只把「(平台 esrId, bossId)」这一对记为不同区域（区域闸降级）。
   * **不拉黑 bossId**——客户端不查 esrId、区域是服务器独占判据，换到别的平台后同一只照样能打。
   * @param {{bossId:number,platEsr:number|null}} t 目标
   */
  #markWrongArea(t) {
    this.#wrongArea[t.platEsr + '|' + t.bossId] = 1;
  }

  /**
   * 挪台档（autoRelocate，默认关）：在「被区域闸拦下」时，朝候选平台发一次 8521 挪过去。
   * 闸门全部来自 NWorldPabBossPlanePopup.refreshUI verbatim 的四段闸，但取**更严口径**（无 PabUtils.isFriend 的 ACL）：
   *   ① 候选必须是 176 平台且 `state === 22`（PALNE_MARCH，未开争夺期不挪）；
   *   ② `isFight !== 1`（本平台在战斗中不重派，游戏 tips enigma_realm217）；
   *   ③ `teams` 为空（游戏判据是任一 teams 满 PabUtils.isFriend → 252；本地拿不到 sid/aid 与好友表，
   *     故取「有任意驻军就不挪」的保守口径）；
   *   ④ `isTeamLeader()` 为真（verbatim `marchBtn.active = isTeamLeader()`，上平台仅队长可派）；
   *   ⑤ 只跳区域（跨 esrId）才挪——同区域核心平台互行军会撞 `enigma_realm209`。
   * 需求源只取本拍过不了区域闸的 BOSS（#blockedNow）；目标区域优先级：
   *   已知 bossEsr（大BOSS 本体 177 瓦片）> 未拉黑的已学区域 > 「不属于任何 wrongArea 对」的任意平台（未知区域只能探）。
   * 一拍最多发一次，并发一个与攻打同长的冷却防跳来跳去；失败不拉黑任何一侧（下一拍重评）。
   */
  #tryRelocate() {
    const env = this.#env;
    if (!env.secret.isTeamLeader()) return;
    const curKey = this.#curTileKey();
    if (!curKey) return;
    const curEsr = this.#platformEsr();
    let want = null;
    for (let i = 0; i < this.#blockedNow.length; i++) {
      const blk = this.#blockedNow[i];
      const esr = this.#bossEsr(blk.bossId, blk.kind);
      if (esr != null) {
        want = esr;
        break;
      }
      const learned = this.#areaLearn[blk.bossId];
      if (learned != null && !this.#wrongArea[learned + '|' + blk.bossId]) {
        want = learned;
        break;
      }
    }
    const cand = this.#platformCandidates(curKey, curEsr, want);
    if (!cand) {
      env.log.debug('boss relocate: no usable 176 candidate (want esr=%s).', String(want));
      return;
    }
    const ret = env.secret.sendMarch(cand.x, cand.y);
    if (!ret || typeof ret.then !== 'function') {
      env.log.debug('boss relocate: 8521 not sent (in-flight/invalid coords).');
      return;
    }
    this.#marchInFlight = true;
    this.#marchTag = 'relocate→(' + cand.x + ',' + cand.y + ')';
    this.#didSend = true;
    this.#cooldownUntil = Date.now() + BossEngine.ATTACK_COOLDOWN_MS;
    env.log.info(
      'boss relocate: plane (%s, esr=%s) has no fit target → march to (%d,%d, esr=%s).',
      curKey,
      String(curEsr),
      cand.x,
      cand.y,
      String(cand.esrId),
    );
    const self = this;
    ret.then(function (r) {
      self.#marchInFlight = false;
      if (!env.alive()) return;
      if (isOk(r) || (r && r.code === CODE_NOT_SENT)) return; // 未上线不记账，下一拍重评
      // 被拒同样先进退避：否则「发出→应答几十毫秒回→下一拍又挪一次」会打成 ≈5 条/秒的 8521 风暴
      self.#cooldownUntil = Date.now() + tuning.rejectBackoffMs;
      const rej = (r && r.reason) || '';
      if (rej === REJ_BOSS_AREA && curEsr != null) {
        // 当前平台与所有候选都不同区域且未知目标区域 → 把这一组对子记下来防反复探
        for (let i = 0; i < self.#blockedNow.length; i++) {
          self.#wrongArea[curEsr + '|' + self.#blockedNow[i].bossId] = 1;
        }
        return;
      }
      if (!self.#toldReject['reloc|' + cand.x + ',' + cand.y]) {
        self.#toldReject['reloc|' + cand.x + ',' + cand.y] = 1;
        env.log.info(
          'boss relocate: (%d,%d) rejected (%s).',
          cand.x,
          cand.y,
          rej || 'code ' + (r && r.code),
        );
      } else {
        env.log.debug(
          'boss relocate: (%d,%d) rejected again (%s).',
          cand.x,
          cand.y,
          rej || 'code ' + (r && r.code),
        );
      }
    });
  }

  /**
   * 当前所在瓦片坐标键（roomBaseInfo.startPoint，缺时退 targetPoint）。
   * @returns {string} 'x,y'（取不到回 ''）
   */
  #curTileKey() {
    const base = this.#env.secret.getRoomBaseInfo();
    const pt = base && (base.startPoint || base.targetPoint);
    return pt ? tileKey(pt.x, pt.y) : '';
  }

  /**
   * 从瓦片快照里筛可用候选平台（距当前位置最近优先）。
   * 距离度量已与攻打就近档统一为**欧氏格距** `dist()`（旧实现是曼哈顿）：`tuning.bossNearRadius` 的
   *   实证数字就是欧氏算出来的，两处共用一把尺子；但请注意这会轻微改变挪台候选的相对次序
   *   （如 (10,0) 与 (7,7)：曼哈顿同为 10、欧氏分 10 / 9.9），拿旧录音对拍时别当成 bug。
   * @param {string} curKey 当前坐标键（排除自身）
   * @param {number|null} curEsr 当前平台 esrId（同区域不挪，防 209）
   * @param {number|null} want 期望区域（null=区域未知，接受任意未被证伪的快照区域）
   * @returns {{x:number,y:number,esrId:number|null}|null}
   */
  #platformCandidates(curKey, curEsr, want) {
    const list = [];
    const cx = Number(curKey.split(',')[0]);
    const cy = Number(curKey.split(',')[1]);
    for (const [k, t] of this.#tiles) {
      if (k === curKey) continue;
      if (t.pt !== PAB_BOSS_PLANE) continue;
      if (t.esrId == null) continue; // 无区域证据的平台不能当「同区域」候选（也只能靠探，但探优先给有 esr 的）
      if (t.state !== ST_PLANE_MARCH) continue; // 未开争夺期（非 22）不挪
      if (t.isFight === 1) continue; // 217
      if (t.teams > 0) continue; // 252（保守口径）
      if (want != null) {
        if (t.esrId !== want) continue;
      } else if (curEsr != null && t.esrId === curEsr) {
        continue; // 209：同区域核心平台互行军不允许
      }
      if (this.#wrongArea[t.esrId + '|' + (this.#blockedNow[0] ? this.#blockedNow[0].bossId : 0)])
        continue;
      const p = k.split(',');
      const x = Number(p[0]);
      const y = Number(p[1]);
      list.push({ x: x, y: y, esrId: t.esrId, d: dist(x, y, cx, cy), at: t.at });
    }
    if (!list.length) return null;
    list.sort(function (a, c) {
      return a.d - c.d || c.at - a.at;
    });
    return list[0];
  }

  /**
   * BOSS 本体的区域 esrId（**只对 177 大BOSS 有证据**：录音里 178 小BOSS 瓦片 0 条、boss12 本体 m=null）。
   * @param {number} bossId BOSS id
   * @param {number} kind 本体瓦片 pointType（177/178/0=未知）
   * @returns {number|null}
   */
  #bossEsr(bossId, kind) {
    if (!BOSS_TILE_TYPES.includes(kind)) return null;
    const list = this.#env.secret.getBossBaseInfo();
    if (!Array.isArray(list)) return null;
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      if (!s || Number(s.bossId) !== bossId || !s.pos) continue;
      const t = this.#tiles.get(tileKey(s.pos.x, s.pos.y));
      return t && t.esrId != null ? t.esrId : null;
    }
    return null;
  }

  /**
   * 当前所在平台的区域 esrId（roomBaseInfo.startPoint → 瓦片快照；取不到回 null=无本地证据）。
   * @returns {number|null}
   */
  #platformEsr() {
    const base = this.#env.secret.getRoomBaseInfo();
    const pt = base && (base.startPoint || base.targetPoint);
    if (!pt) return null;
    const t = this.#tiles.get(tileKey(pt.x, pt.y));
    return t && t.esrId != null ? t.esrId : null;
  }

  /**
   * 某坐标的瓦片类型（快照里没有回 0=未知）。
   * @param {string} key 'x,y'
   * @returns {number}
   */
  #tileTypeAt(key) {
    const t = this.#tiles.get(key);
    return t ? t.pt : 0;
  }

  /**
   * 现场瓦片闸（文件头 §④-b）：候选 BOSS 点若被 push 10018 快照证明当前**不是 state21**，这一拍不发。
   *   只在证据新鲜时生效（`tuning.bossTileFreshMs`）：快照来自视口增量，队伍不动 / 未被推送覆盖的点
   *   本就没有现场证据 → 一律 fail-open 回 `null` 保持旧行为，绝不把「读不到」当「不能打」。
   * @param {string} key 'x,y' 候选 BOSS 本体坐标键
   * @returns {string|null} 拦下原因（`null`=放行；仅进 debug 日志，不影响配对账）
   */
  #liveTileBlock(key) {
    const t = this.#tiles.get(key);
    if (!t) return null;
    if (Date.now() - t.at > tuning.bossTileFreshMs) return null;
    const st = Number(t.state);
    if (st === ST_BOSS_FIGHTING) return null;
    if (!t.pt) return 'point removed (pointType=0)';
    return 'tile state=' + st + (st === ST_BOSS_FEED ? ' (BOSS feed window)' : '');
  }

  /**
   * 战斗窗口是否已过（state===21 时 `stateEndTime` = 窗口结束的**绝对毫秒**，实证 boss11/12 +420s、boss9 +600s）。
   * 游戏侧对应的 tips 是 `cab_ui_info_065`，但它写在**倒计时分支**（state!==21）里，对 state21 不构成客户端闸
   *   → 这里只作「别把枪烧在已散场的 BOSS 上」的本地保守判据；读不到值（缺字段）一律放行。
   * @param {{stateEndTime:*}} s 21535 状态条目
   * @returns {boolean}
   */
  #fightOver(s) {
    const end = toNum(s.stateEndTime);
    if (!(end > 1e11)) return false; // 不是毫秒量级的绝对时刻 → 不猜
    return Date.now() > end;
  }

  /**
   * 某 BOSS 的**石头账本是否已榨干**（攻打档的产出预筛，借鉴竞品B guard_policy=3）：
   *   21539 全量账本里该 bossId 有条目、且所有点位都满足 `rewardMaxNum>0 且 rewardNum≥rewardMaxNum` → 再攻不产出。
   *   ⚠ 与 #stoneTick 的「可领」判据**不同式**：账本初态是 `0/0`、参战后才是 `0/1F`（constants 21539 段实证），
   *   若拿 isFight/「可领」当过滤闸会把从未攻过的 BOSS 拦死；本闸只认「真领满」，另要求 rewardMaxNum>0
   *   防 `0/0` 初态被 ≥ 误判为满。**无组（大BOSS/账本未推）回 false 不过滤**，读不到账本同样回 false
   *   （fail-open，绝不拿缺证据当「领完」把 BOSS 拉死）。只读，不改写任何游戏态。
   * @param {number} bossId 21535 条目的 bossId
   * @returns {boolean}
   */
  #stoneExhausted(bossId) {
    const groups = this.#env.secret.getBossGuardRewardInfo();
    if (!Array.isArray(groups) || !groups.length) return false;
    let seen = false;
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      if (!g || Number(g.bossId) !== bossId) continue;
      seen = true;
      const pts = Array.isArray(g.rewardInfo) ? g.rewardInfo : [];
      for (let j = 0; j < pts.length; j++) {
        const p = pts[j];
        if (!p) continue;
        const max = toNum(p.rewardMaxNum);
        if (max > 0 && toNum(p.rewardNum) >= max) continue;
        return false; // 有点位未满（含 0/0 初态）→ 还有产出可挣
      }
    }
    return seen;
  }

  // ── 发包 ────────────────────────────────────────────────────────────

  /**
   * 发一条 8521 攻打（目标 = BOSS 本体坐标；报文实证 73 条 req 全部是 `{x,y}` 两键、目标直方图仅两个点）。
   * `sendMarch` 回 `false` = 游戏侧 `checkRequestIdNoRes` 拦下（在途）或坐标非法 → 不作任何记账，下一拍重试。
   * @param {{bossId:number,x:number,y:number,platEsr:number|null}} t 目标
   * @param {object} b 面板 boss 配置
   */
  #sendAttack(t, b) {
    const env = this.#env;
    const ret = env.secret.sendMarch(t.x, t.y);
    if (!ret || typeof ret.then !== 'function') {
      env.log.debug('boss attack: 8521 not sent (in-flight/invalid coords), retry next tick.');
      return;
    }
    this.#marchInFlight = true;
    this.#marchTag = 'boss' + t.bossId + '@(' + t.x + ',' + t.y + ')';
    this.#didSend = true;
    this.#rounds[t.bossId] = (this.#rounds[t.bossId] || 0) + 1;
    env.log.debug(
      'boss attack: send 8521 → %s (round %d).',
      this.#marchTag,
      this.#rounds[t.bossId],
    );
    const self = this;
    ret.then(function (r) {
      if (!env.alive()) return;
      self.#marchInFlight = false;
      if (isOk(r)) {
        self.#noteArea(t, true);
        // 实测一轮：小BOSS 4.6~5.4s、大BOSS 8~11s，节奏由 marchState 闸门本身把住 → 只留一个 1s 短冷却
        //   防「应答秒回就同拍补第二枪」，并把在飞位交还给 marchState 闸（返航期间 pt 不是 176，自然拦住）
        self.#cooldownUntil = Date.now() + BossEngine.ATTACK_COOLDOWN_MS;
        env.log.debug('boss attack: %s ok (march started).', self.#marchTag);
        return;
      }
      if (r && r.code === CODE_NOT_SENT) {
        // 没上线 = 没有服务器判定 → **不动配对账**（尤其不置 #probed，也不进退避），#marchInFlight 已在上方清掉→下一拍重试
        env.log.debug(
          'boss attack: %s not sent (secondary socket/CD), no bookkeeping.',
          self.#marchTag,
        );
        return;
      }
      self.#handleMarchReject(t, r, b);
    });
  }

  /**
   * 攻打拒绝码处置（详见文件头）。核心差异：**142 只降级区域闸、不拉黑 bossId；163 才拉黑坐标**。
   * 进入即写 `#cooldownUntil`（`tuning.rejectBackoffMs`，141 专用 `tuning.planeRefreshMs`）：
   *   被拒那一刻本地闸已不可信，不进退避就会以 ≈5 条/秒重发同一条 8521（162 的一次递归重试不走 #attackTick，
   *   因此不受该冷却影响）。
   * @param {{bossId:number,x:number,y:number,platEsr:number|null}} t 目标
   * @param {object} r Ret
   * @param {object} b 面板 boss 配置
   */
  #handleMarchReject(t, r, b) {
    const env = this.#env;
    const rej = (r && r.reason) || '';
    const tag = 'boss' + t.bossId + '@(' + t.x + ',' + t.y + ')';
    this.#cooldownUntil = Date.now() + tuning.rejectBackoffMs;
    if (rej === REJ_NOT_ARRIVED) {
      // 158 = 小队尚未抵达（行军态未 ARRIVED 就发攻打）：不是区域错、也不是目标失效，
      //   不烧配对试探额度（不 #noteArea(false)）、不拉黑坐标；只退回避，等 push 21529 TEAM_ARRIVE 解除后重跑。
      const akey = 'arrive158|' + tag;
      if (!this.#toldReject[akey]) {
        this.#toldReject[akey] = 1;
        env.log.info(
          'boss attack: %s rejected %s (team not arrived) → backoff %dms, will resume on push 21529, NOT probing/blacklisting.',
          tag,
          rej,
          tuning.rejectBackoffMs,
        );
      } else {
        env.log.debug('boss attack: %s still rejected %s (waiting 21529).', tag, rej);
      }
      return;
    }
    if (rej === REJ_BOSS_AREA) {
      this.#markWrongArea(t);
      env.log.info(
        'boss attack: %s rejected %s (platform area esr=%s != boss area) → pair demoted, boss NOT blacklisted.',
        tag,
        rej,
        String(t.platEsr),
      );
      return;
    }
    if (rej === REJ_NEED_PLANE) {
      // 141 = 服务端认为我不在 176 平台上，而本地 roomBaseInfo 只能靠 push 21521 刷正（实测一场 ≈17s 一条）
      //   → 退一个推送周期再评，期间绝不重发；首见 info 说明在等什么，之后降 debug（循环态）
      this.#cooldownUntil = Date.now() + tuning.planeRefreshMs;
      const pkey = 'plane141|' + tag;
      if (!this.#toldReject[pkey]) {
        this.#toldReject[pkey] = 1;
        env.log.info(
          'boss attack: %s rejected %s (server says not on 176 plane) → idle %dms waiting for push 21521 to refresh roomBaseInfo, NOT resending.',
          tag,
          rej,
          tuning.planeRefreshMs,
        );
      } else {
        env.log.debug('boss attack: %s still rejected %s (waiting 21521).', tag, rej);
      }
      return;
    }
    if (rej === REJ_ALREADY_THERE) {
      // 目标点==当前点：正常语义（例如已在 BOSS 上），静默处理；不拉黑也不烧试探额度
      this.#noteArea(t, true);
      env.log.debug('boss attack: %s rejected %s (already there).', tag, rej);
      return;
    }
    if (rej === REJ_NO_MARCH_TARGET) {
      this.#targetBlack[tileKey(t.x, t.y)] = Date.now() + tuning.rejectBlacklistMs;
      env.log.info('boss attack: %s rejected %s → target blacklisted.', tag, rej);
      return;
    }
    if (rej === REJ_PARAM_ERROR) {
      // common_159995 在攻打档的语义是「该点当前不可打」（见文件头§拒绝码清单），**不是包形态错**（req 恒 `{x,y}`）
      //   → 短拉黑该坐标（覆盖整窗投喂期），不烧配对试探额度（它不是区域错）、不拉黑 bossId
      this.#targetBlack[tileKey(t.x, t.y)] = Date.now() + tuning.paramBlacklistMs;
      const mkey = 'param159995|' + tag;
      if (!this.#toldReject[mkey]) {
        this.#toldReject[mkey] = 1;
        env.log.info(
          'boss attack: %s rejected %s (point not attackable now) → target blacklisted %dms, area probe NOT burned.',
          tag,
          rej,
          tuning.paramBlacklistMs,
        );
      } else {
        env.log.debug('boss attack: %s still rejected %s (waiting blacklist to expire).', tag, rej);
      }
      return;
    }
    if (rej === REJ_RETRY && !this.#marchRetried[t.bossId] && (!b || b.enabled)) {
      this.#marchRetried[t.bossId] = 1;
      env.log.debug('boss attack: %s rejected %s, retry once.', tag, rej);
      this.#sendAttack(t, b);
      return;
    }
    this.#noteArea(t, false);
    const key = t.x + ',' + t.y + '|' + t.bossId;
    if (!this.#toldReject[key]) {
      this.#toldReject[key] = 1;
      env.log.info('boss attack: %s rejected (%s).', tag, rej || 'code ' + (r && r.code));
    } else {
      env.log.debug('boss attack: %s rejected again (%s).', tag, rej || 'code ' + (r && r.code));
    }
  }

  /**
   * 发一条 8548 领石头（req 只有 `{x,y}`，**不带 bossId**，报文实证）。在途点位记账见 #stoneInflight。
   * @param {number} bossId 该点位所属 BOSS（只用于日志与 179 的组级静默）
   * @param {number} x 石头点横号
   * @param {number} y 石头点纵号
   */
  #sendStone(bossId, x, y) {
    const env = this.#env;
    const k = x + ',' + y;
    this.#stoneInflight = k;
    this.#didSend = true;
    const self = this;
    env.secret.sendSecret(CMD_BOSS_GUARD_GET, { x: x, y: y }).then(function (r) {
      if (!env.alive()) return;
      if (self.#stoneInflight === k) self.#stoneInflight = '';
      if (isOk(r)) {
        self.#stoneGap = self.#tightenGap();
        self.#stoneUsed[k] = 1; // 乐观记账：21539 全量回来前的同点重发没意义
        self.#logStoneGain(r, bossId, k);
        return;
      }
      const rej = (r && r.reason) || '';
      if (r && r.code === CODE_NOT_SENT) {
        self.#stoneGap = Math.min(tuning.getGapMaxMs, self.#stoneGap * 2);
        env.log.debug('stone: (%s) not sent (secondary socket/CD), gap→%d.', k, self.#stoneGap);
        return;
      }
      if (rej === REJ_STONE_USED_UP) {
        self.#stoneUsed[k] = 1; // 实证重复领同点即此码，且应答 rewardInfo 退化成空数组
        env.log.info('stone: (%s) rejected %s (already claimed) → dropped.', k, rej);
        return;
      }
      if (rej === REJ_NOT_IN_FIGHT) {
        self.#stoneSkip[bossId] = Date.now() + tuning.stoneSkipMs;
        env.log.info(
          'stone: boss%d group rejected %s (not in this fight) → group silent %dms.',
          bossId,
          rej,
          tuning.stoneSkipMs,
        );
        return;
      }
      if (rej === REJ_RETRY && !self.#stoneRetried[k]) {
        self.#stoneRetried[k] = 1;
        env.log.debug('stone: (%s) rejected %s, retry once.', k, rej);
        self.#sendStone(bossId, x, y);
        return;
      }
      self.#stoneUsed[k] = 1;
      env.log.info(
        'stone: (%s) rejected (%s) → dropped this session.',
        k,
        rej || 'code ' + (r && r.code),
      );
    });
  }

  /**
   * 石头收益记账：`rewardResult.items[]`（实证 `[{itemId:41021,itemCount:1}]`）逐条 info；
   *   应答若带 `boxOpen/boxOpenBeast`（抽卡）**只报条数不代答**——游戏自己开窗 PabWorldCBossSucDrawCardPanel。
   * @param {object} r Ret
   * @param {number} bossId BOSS id
   * @param {string} k 点位键
   */
  #logStoneGain(r, bossId, k) {
    const env = this.#env;
    const outer = (r && r.data) || {};
    const inner = outer.data || outer;
    const res = inner.rewardResult || {};
    const items = Array.isArray(res.items) ? res.items : [];
    const parts = [];
    for (let i = 0; i < items.length; i++) {
      parts.push(items[i].itemId + '×' + toNum(items[i].itemCount));
    }
    const box = Array.isArray(inner.boxOpen) ? inner.boxOpen.length : 0;
    const beast = Array.isArray(inner.boxOpenBeast) ? inner.boxOpenBeast.length : 0;
    env.log.info(
      'stone: boss%d (%s) got %s%s.',
      bossId,
      k,
      parts.length ? parts.join(',') : 'nothing',
      box || beast ? ' (draw card pending: box=' + box + ', beast=' + beast + ')' : '',
    );
  }

  /**
   * 连续成功时的节拍回落（与拾取侧 getGapStepMs 同曲线），下限回到 tuning.stoneGapMs。
   * @returns {number}
   */
  #tightenGap() {
    const next = this.#stoneGap - tuning.getGapStepMs;
    return next < tuning.stoneGapMs ? tuning.stoneGapMs : next;
  }

  // ── 推送落地（只读，不改游戏数据）──────────────────────────────────

  /**
   * push 10018 瓦片刷新 → 更新 #tiles 快照（**不 kick**：实测 7733 条 ≈3 条/秒，kick 会把兜底拍打成 3Hz）。
   * 载荷是**平的**（`ev.data = {pointInfos:[{v,x,y,k,id,pointType,m}]}`，与 21521/21535/21539 的
   *   `{header,data}` 两层嵌套不同）。只收本引擎认的四类瓦片（176/177/178/162）。
   * @param {object} ev bus `net.10018` 事件
   */
  onTilePush(ev) {
    const d = ev && ev.data;
    if (!d || typeof d !== 'object') return;
    const list = Array.isArray(d.pointInfos) ? d.pointInfos : null;
    if (!list) return;
    const now = Date.now();
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (!p) continue;
      const pt = Number(p.pointType) || 0;
      const k = tileKey(p.x, p.y);
      if (!k) continue;
      if (pt === 0) {
        // 点位从地图消失（实证 20261101T200401：小BOSS 本体 +1244.1s `pointType→0`，而 21535 的 state28 晚 400s 才推）
        //   → 已在快照里的点落成**负证据**条目（pt=0 / state=0），让 #liveTileBlock 拦下，
        //   而不是留着旧的 state21 证据继续放行（本来只收四类瓦片会把这条现场变更直接漏掉）
        if (this.#tiles.has(k)) {
          this.#tiles.set(k, {
            pt: 0,
            esrId: null,
            state: 0,
            sET: 0,
            isFight: 0,
            teams: 0,
            at: now,
          });
        }
        continue;
      }
      if (
        pt !== PAB_BOSS_PLANE &&
        pt !== PAB_BOSS_GUARD &&
        pt !== PAB_BOSS &&
        pt !== PAB_BOSS_GUARD_REWARD
      )
        continue;
      const m = p.m && typeof p.m === 'object' ? p.m : {};
      const esr = m.esrId == null ? null : Number(m.esrId);
      if (this.#tiles.size >= tuning.tileExtMax && !this.#tiles.has(k)) {
        const first = this.#tiles.keys().next();
        if (!first.done) this.#tiles.delete(first.value);
      }
      this.#tiles.set(k, {
        pt: pt,
        // 162 石头瓦片的 esrId 恒为 0（实证）→ 0 不算区域证据，避免拿它做「同区域」误判
        esrId: esr == null || Number.isNaN(esr) ? null : esr === 0 ? null : esr,
        state: Number(m.state) || 0,
        sET: toNum(m.sET),
        isFight: Number(m.isFight) || 0,
        teams: Array.isArray(m.teams) ? m.teams.length : 0,
        at: now,
      });
    }
  }

  /**
   * push 21535 状态机刷新：把「首次见到 state===21」的时刻记账（排序 tie-break 用）并唤醒一拍。
   * 业务态不在这里镜像——游戏 Handler 已 verbatim `bossBaseInfo = a.stateInfo`，重读 ACL 就是真相（红线）。
   * @param {object} ev bus `net.21535` 事件
   */
  onBossStatePush(ev) {
    if (!this.#env.alive()) return;
    const d = ev && ev.data;
    const inner = d && d.data ? d.data : d;
    const list = inner && Array.isArray(inner.stateInfo) ? inner.stateInfo : null;
    if (list) {
      const now = Date.now();
      for (let i = 0; i < list.length; i++) {
        const s = list[i];
        if (!s || s.bossId == null) continue;
        const bid = Number(s.bossId);
        if (Number(s.state) === ST_BOSS_FIGHTING) {
          if (!this.#seen21[bid]) this.#seen21[bid] = now;
        } else {
          delete this.#seen21[bid];
        }
      }
    }
    if (this.#cycle) this.#cycle.kick();
  }

  /**
   * push 21521 现场刷新（行军/在位）：只唤醒一拍，roomBaseInfo 一律重读 ACL。
   * 21521 实测 239 条 ≈17s 一条 + 行军状态变化时补发 → 稀疏，**不能当唯一唤醒源**（兜底走 bossScanMs）。
   */
  onSceneWake() {
    if (!this.#env.alive()) return;
    if (this.#cycle) this.#cycle.kick();
  }

  // ── 生命周期 ────────────────────────────────────────────────────────

  /**
   * 启动：登记四条订阅（退订由 reactor 托管）+ 建循环并点火。
   * @param {object} ctx reactor 上下文（提供 on.push）
   */
  start(ctx) {
    const env = this.#env;
    const self = this;
    this.#active = true;
    this.#tiles = new Map();
    this.#areaLearn = {};
    this.#wrongArea = {};
    this.#probed = {};
    this.#areaOk = {};
    this.#targetBlack = {};
    this.#toldReject = {};
    this.#marchRetried = {};
    this.#stoneRetried = {};
    this.#stoneUsed = {};
    this.#stoneSkip = {};
    this.#rounds = {};
    this.#seen21 = {};
    this.#stoneInflight = '';
    this.#stoneGap = tuning.stoneGapMs;
    this.#cooldownUntil = 0;
    this.#marchInFlight = false;
    this.#marchTag = '';
    this.#blockedNow = [];
    if (ctx && ctx.on && typeof ctx.on.push === 'function') {
      ctx.on.push(PUSH_BOSS_STATE, function (ev) {
        self.onBossStatePush(ev);
      });
      ctx.on.push(PUSH_BASE_INFO, function () {
        self.onSceneWake();
      });
      ctx.on.push(PUSH_BOSS_GUARD_REWARD, function () {
        self.onSceneWake();
      });
      // 21529 TEAM_ARRIVE：最及时的「已抵达」信号，兼 158「尚未抵达」的解除器 → 踢一拍重跑被打 158 的攻打
      ctx.on.push(PUSH_TEAM_ARRIVE, function () {
        self.onSceneWake();
      });
      // 瓦片流：只写快照、不 kick（3 条/秒）
      ctx.on.push(PUSH_TILE_INFO, function (ev) {
        if (self.#active && env.realmActive()) self.onTilePush(ev);
      });
    } else {
      env.log.warn('boss: ctx.on.push unavailable, state machine cannot be driven (engine idle).');
    }
    this.#cycle = createCycle({
      log: env.log,
      alive: function () {
        return self.#active && env.alive();
      },
      run: function () {
        return self.#tick();
      },
      fallback: tuning.bossScanMs,
    });
    this.#cycle.kick();
    env.log.info('boss engine started (21535 state21 → 8521; 21539 points → 8548).');
  }

  /**
   * 停止：置死 #active（cycle 睡眠期的定时器不会被撤，靠存活位到点终止）并清掉全部本地账——
   * resume 后拿陈旧区域/拉黑集继续发写请求属事故（红线：pause 必须显式收自建的队列）。
   */
  stop() {
    this.#active = false;
    this.#cycle = null;
    this.#tiles = new Map();
    this.#stoneInflight = '';
    this.#marchInFlight = false;
  }
}
