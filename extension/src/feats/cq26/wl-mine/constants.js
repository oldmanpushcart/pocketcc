/**
 * CQ26 荒芜冰原矿区 · 协议号与内置常量（feats/cq26/wl-mine/constants.js）
 *
 * 口径纪律：本文件只收「服务器 ↔ 客户端契约」（cmd 号、枚举值、配置号）与「内置调参」两类，
 *   面板可调项一律不在此处（见 index.js 的 buildDefaults / buildFields）。
 * 证据：docs/acl-cq26-荒芜冰原.md §3.1 协议台账 + docs/feat-荒芜冰原-采集.md §1/§3。
 */

// ── 写动作 ────────────────────────────────────────────────────────────
/** SERIES_FROST_NWL_COLLECT 采集派兵：req `{wastelandIndex, x, y}`（`wastelandIndex` 传点的 `m.specIndex`），resp `{isOk}` */
export const CMD_GATHER = 2114;
/** SERIES_FROST_NWL_STEAL 盗采：req `{wkid, x, y}`，resp `{rewardResult, remainStealNum}`，即时结算不派兵 */
export const CMD_STEAL = 2115;
/** SERIES_FROST_NWL_GUARD 协助：req `{wkid, x, y}`，resp `{rewardResult, remainGuardNum}`，即时结算不派兵、不扣 owner gNum */
export const CMD_HELP = 2116;
/** SERIES_FROST_NWL_COLLECT_RECALL 召回采集行军：req `{marchId}`，resp `{isOk}`；不触发 22072 */
export const CMD_RECALL = 2121;

// ── 只读查询 ──────────────────────────────────────────────────────────
/** SERIES_FROST_STAR_LAND_MAP_SINGLE_INFO 星路全图棋盘：req `{cid, group}`，resp `{maxX, maxY, group, grid[]}`，一次给全 612 region 的 `mSid` */
export const CMD_MAP_SINGLE = 2201;
/** SERIES_FROST_NWL_POS 分区锚点：req `{wastelandIndex}`（外服必带 `sid`=归属服），resp `{pos:{x,y,k}}` 单点 */
export const CMD_NWL_POS = 2120;
/** GET_WORLD_INFO 地图窗口（经 core/map.js fetchWindow）：唯一能拿到 316 点 `m` 块（initSid/ownerId/gNum/oNum/名单）的通道 */
export const CMD_WORLD_INFO = 901;

// ── 推送 ──────────────────────────────────────────────────────────────
/** push NWL_INFO_PUSH：额度唯一权威（`todayCanGatherTime/remainStealNum/remainHelpNum/isGathering`），每个点写入同秒下发 */
export const PUSH_WL_INFO = 22072;
/** push NWL_LIST_PUSH：16 分区状态全量（不含归属服），只做棋盘失效与唤醒 */
export const PUSH_LAND_LIST = 22071;
/** push ResponseId.MARCH_INFO：行军状态变更（`state===4` 即回城，采集腿下一轮的唤醒源） */
export const PUSH_MARCH = 10007;

// ── 实体 / 配置号 ─────────────────────────────────────────────────────
/** NWorldMapEntityType 冰原采集点 = 316（与遗失之箱 315 地块不同源） */
export const POINT_TYPE_RESOURCE = 316;
/** dataConfig 52000364：单点 `stealUidList + protectUidList` 合计上限（跨档，读不到即盗采/协助腿 fail-closed） */
export const CONF_QUOTA = 52000364;
/** dataConfig 52000367：单次采集成熟秒（安全期时长，实测 7200）；值无法从报文反推，禁止硬编码兜底 */
export const CONF_MATURITY = 52000367;
/** MarchType.CQ26_WASTELAND_GATHER = 315（采集行军类型；与 315 宝箱地块同数不同源，不得互推） */
export const MARCH_TYPE_GATHER = 315;
/** CQ26WLLandType.GATHER = 3（采集线分区；一个分区只有一种玩法） */
export const LAND_TYPE_GATHER = 3;
/**
 * 2201 `grid[].type` 的「荒芜地块」枚举值 = 3（源码 `CQ26MapData.updateData` 的 `case 3: i.wastelandInfo`）。
 * 与上面的 `LAND_TYPE_GATHER`（`region.wastelandType`）**数值相同但不同轴**：前者是棋盘格类型、后者是分区玩法类型，
 *   两轴都要判（只按 grid.type 粗筛会把 type1/2/5 的分区一起收进来）。
 */
export const GRID_TYPE_WASTELAND = 3;
/** CQ26WLLandStatus.OPENING = 4（游戏侧 checkWlOpening 只认这一个值） */
export const LAND_STATUS_OPENING = 4;
/** CQ26WLLandStatus.OPENED = 5（实测外服可盗点大量落在 5，盗采腿纳入） */
export const LAND_STATUS_OPENED = 5;
/**
 * CQ26WLStatus.CAN_OPEN = 1（赛季阶段「开荒中」，唯一允许开分区 / 派兵的阶段）。
 * 面板文案逐字锚点 `CQ26WLOpenMain.updateStageTime`；写判据锚点 `CQ26WLOpenGatherComponent`
 *   （重开按钮 `interactable = curStage===CAN_OPEN`）。
 */
export const WL_STAGE_CAN_OPEN = 1;
/** CQ26WLStatus.NOT_OPEN = 2（面板「等待下次开荒」+ 倒计时；实录期间 316 点零有主、零写动作） */
export const WL_STAGE_NOT_OPEN = 2;
/** CQ26WLStatus.ENDED = 3（已结束，面板不再显示倒计时；本活动循环不再自动开启） */
export const WL_STAGE_ENDED = 3;

// ── 内置常量（不上面板）──────────────────────────────────────────────
/** 2201 棋盘骨架刷新周期（毫秒）：外部开分区无 push，纯轮询；22071 到达时提前失效 */
export const BOARD_REFRESH_MS = 300 * 1000;
/** 安全期撤回余量（秒）：在 `marchArrive + 成熟秒 - 本值` 发 2121，给网络延迟与 cycle 抖动留缓冲 */
export const RECALL_MARGIN_SEC = 60;
/** stealCycle 单拍最多精扫几个分区（每区 1×2120 + 2×901 ≈ 3 只读，3×3=9 封顶） */
export const MAX_ZONES_PER_TICK = 3;
/** 分区精扫结果缓存有效期（毫秒），同时是「该区无可偷点」黑名单时长 */
export const ZONE_MEMO_TTL_MS = 300 * 1000;
/** 召回后等待 10007 回城的兜底上限（秒）：超此仍未见 state=4 就当已回城，回到 IDLE 由额度闸重新收敛，绝不允许永久停在 RECALLING */
export const RECALL_TIMEOUT_SEC = 30 * 60;
/** 分区精扫窗参数：逐值照实录 `viewLevel=2, width=75, height=120`（一帧有效覆盖 ≈192×160 tiles） */
export const SCAN_VIEW_LEVEL = 2;
/** 精扫窗宽（相机渲染参数，非服务器回窗上限） */
export const SCAN_WIDTH = 75;
/** 精扫窗高 */
export const SCAN_HEIGHT = 120;
/** 精扫第二窗的 y 偏移：单帧只在 y 方向漏底部约 34 tiles，`居中 + y-60` 两帧即 100% 覆盖（x 方向偏移实测零新增） */
export const SCAN_Y_OFFSET = 60;
/** marchId 解析探针窗（以派兵点为窗心，行军线段穿窗即下发，故在途行军必在表内） */
export const MARCH_PROBE_WH = 10;
/** marchId 解析探针的视口层级（1 = 常规视口档，够用且载荷远小于 level 0） */
export const MARCH_PROBE_VIEW_LEVEL = 1;
/** 满额采集日额度（秒）：`todayCanGatherTime` 满值 57600 = 16h，面板进度分母的种子 */
export const DAILY_GATHER_SEC = 57600;
/** 盗采日额度分母种子（实录 22072 `remainStealNum` 满值 3；该推送不带上限字段，故只做「观测到的最大值」自校正） */
export const STEAL_DAILY_MAX = 3;
/** 协助日额度分母种子（同上，实测满值 3） */
export const HELP_DAILY_MAX = 3;
/** 雷神矿脉 itemId（矿种白名单选项） */
export const ITEM_THOR_MINE = 4501;
/** 矿山 itemId（矿种白名单选项） */
export const ITEM_MINE = 4502;
/** 即时腿两条写动作之间的最小间隔（毫秒）：同 mine-cave/excav 的串行节奏 */
export const ACT_GAP_MS = 800;
/** 同一点连续被拒达此次数即当日拉黑（防逐拍重发刷屏） */
export const MAX_REJECT = 3;
/** 单次被拒后的冷却（毫秒）：时序竞争类拒绝留自愈窗口，不直接拉黑 */
export const REJECT_COOL_MS = 5 * 60 * 1000;
/** 2121 连续被拒达此次数即放弃本轮（回 IDLE 交给额度 / isGathering 闸收敛）：召回走的是 3s 档，不设上限就是「注定失败的发券」逐拍重发 */
export const RECALL_FAIL_MAX = 3;
/** 单次召回失败后的退避（毫秒）：退避期内 `advance` 不再出网，也不重发探针 */
export const RECALL_FAIL_BACKOFF_MS = 60 * 1000;
/** 「服务器在采、本机状态机不知情」时主动认领在途 315 行军的尝试间隔（毫秒）：认领要现扫分区，不能逐拍扫 */
export const CLAIM_GAP_MS = 5 * 60 * 1000;
/**
 * 认领连续失败多久即把 `isGathering` 判为陈旧值（毫秒）。该标志只由 22072 刷新，而 22072 仅在点写入与
 *   采集行军到家两个时刻下发（2121 召回不触发），故 reload / 手操召回 / 分区翻 OPENED 之后它会长期停在 1；
 *   不设上限就是把采集腿锁死到下一次点写入（实录一次自锁 1h48m，最坏是当天剩余额度整段作废）。
 */
export const CLAIM_STALE_MAX_MS = 15 * 60 * 1000;
/** 判定陈旧后「试探性派兵」的初始间隔（毫秒）：真有一趟在外面时 2114 会被 `isOk:0` 拒（不扣额度、不丢产出），但节奏必须自带退避 */
export const PROBE_GAP_MS = 10 * 60 * 1000;
/** 试探性派兵连续被拒后的间隔上限（毫秒）：指数退避的天花板，防「11-08 那种 64 发废券风暴」复发 */
export const PROBE_GAP_MAX_MS = 60 * 60 * 1000;
/** 尾轮最少可采秒数：剩余额度低于此就不派了（零头本来就只有几分钟，不值得占一趟行军队列） */
export const TAIL_MIN_SEC = 600;
