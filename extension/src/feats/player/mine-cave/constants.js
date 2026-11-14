/**
 * player/mine-cave · 协议号常量（B6 就近收编：原散在 feat 实现文件的 CMD_/PUSH_ 定义 verbatim 迁入）。
 * 口径纪律：只收「服务器 ↔ 客户端契约」cmd 号；调参与面板项留在实现文件。
 * 注册表：scripts/protocol/（开发期单一真相）；改动后须重跑 npm run protocol:extract。
 */

// ── ① 挖矿：本引擎独占的协议号 / 状态枚举（无跨文件复用，故就近私有）──
export const CMD_SELF_INFO2 = 7428; // 自矿聚合（SELF_MINE_CAVE_INFO2）
export const CMD_REFRESH = 7416; // 能量裂隙探测换矿
export const CMD_OCCUPY = 7417; // 占领/下矿
export const CMD_SINGLE_INFO = 7421; // 单矿详情（布阵前置查询）
export const CMD_CHECK_SHARE = 7427; // 盟友矿可占校验
export const CMD_OTHER_INFO2 = 7425; // 盟友矿概览列表
export const CMD_OTHER_INFO = 7414; // 单个盟友矿详情
export const CMD_REWARD = 7422; // 采集/行军产出领取
export const CMD_OTHER_GATHER_REWARD = 7424; // 他人来采我的产出领取
export const CMD_ALLIANCE_REWARD = 7429; // 联盟矿洞产出领取
export const PUSH_MINE_CAVE_CHANGE = 21351; // 单矿变更推送（自矿/行军）
// ── ② 盗窃封存：本引擎独占的协议号（无跨文件复用，故就近私有）──
export const CMD_WORLD_INFO = 7415; // 裂隙矿场（refresh:0 读 / refresh:1 换矿）
export const CMD_STEAL = 7419; // 偷取
export const CMD_HELP_PACK = 7420; // 封存/帮打包
export const CMD_HELP = 7418; // 加速帮忙
