/**
 * player/auto-farm · 协议号常量（B6 就近收编：原散在 feat 实现文件的 CMD_/PUSH_ 定义 verbatim 迁入）。
 * 口径纪律：只收「服务器 ↔ 客户端契约」cmd 号；调参与面板项留在实现文件。
 * 注册表：scripts/protocol/（开发期单一真相）；改动后须重跑 npm run protocol:extract。
 */

/** @type {number} RequestId.MARCH_WORLD_POINT：世界地图行军（下田 902） */
export const CMD_MARCH_WORLD_POINT = 902;
/** @type {number} push PUSH_SINGLE_MAIL：单封邮件推送（「遗迹区域刷新」开田信号，载荷是邮件本体） */
export const PUSH_SINGLE_MAIL = 10264;
/** @type {number} RequestId.GET_TOWER_LIST：本人机械设施权威列表（应答 {list:[塔对象]}，pid=自己 UID 字符串） */
export const CMD_GET_TOWER_LIST = 1031;
/** @type {number} RequestId.GET_TOWERINFO：单塔/资源塔详情（{id:"塔实例id 字符串"}，防 Int64 截断；应答 army_size=当前驻军兵力） */
export const CMD_GET_TOWERINFO = 1034;
/** @type {number} RequestId.MARCH_WORLD_Build：建塔行军（V1 net.send，非 PB） */
export const CMD_MARCH_WORLD_BUILD = 1033;
/** @type {number} RequestId.TOWER_REMOVE：销毁塔（{id:"塔实例id 字符串"}，应答 {}）——本引擎只用它取消**在建**（st=2）的塔 */
export const CMD_TOWER_REMOVE = 1032;
/** @type {number} push PUSH_MY_PROFESSIONAL_TOWERS：本人塔对象整份推送（派建即 st=2，入塔转 st=3） */
export const CMD_PUSH_TOWER = 10182;
/** @type {number} push PUSH_ALLIANCE_RECORD：联盟记录增量（建塔/毁塔事件），仅作 1031 重拉 kick 源 */
export const CMD_PUSH_ALLIANCE_RECORD = 10452;
/** @type {number} RequestId.ALLIANCE_RECORD_DATA：全量拉联盟记录（含「建筑」机械田建造事件，视口无关） */
export const CMD_ALLIANCE_RECORD_DATA = 1193;
/** @type {number} push PUSH_ALLIANCE_RECORD：联盟记录增量推送（新建成机械田即时并入活表） */
export const PUSH_ALLIANCE_RECORD = 10452;
/** @type {number} RequestId.STUDY_HERO_SKILL：英雄学习技能（装书）{heroId,index,itemId,isBuffSlot,skillsIndex}；
 * 账目按 (heroId,itemId) 一份账：新登记扣账、同英雄跨组平装同款同档放行不扣账（20261121 温泰实验直证）；
 * 同英雄已有同族更高档时装低档被拒（应答 data="hero_skill_equip001" 裸串且无 10906 跟随） */
export const CMD_STUDY_HERO_SKILL = 897;
/** @type {number} RequestId.FORGET_HERO_SKILL：英雄遗忘技能（卸书，按槽位寻址不需 itemId）{heroId,index,isBuffSlot,skillsIndex}；
 * 注销最后一个登记→10401 amount+1 还账（实测 60ms 内）；另一组还有同款登记→不还账 */
export const CMD_FORGET_HERO_SKILL = 898;
/** @type {number} RequestId.ChangeHeroSkillsIndex：英雄技能组切换（纯指针零账变）{heroId,skillsIndex}；
 * 受理后 10906 在 66~74ms 即时推送镜像翻转（先于 resp）并伴随 10012 战力重算 */
export const CMD_CHANGE_HERO_SKILLS_INDEX = 1345;
/** @type {number} push PUSH_HERO_INFO：英雄数据全量推送（897/898/1345 受理后 <100ms，hero 含 firstSkills/subSkills/skillsIndex）
 * ——装配/切组的确认通道，实测 66~104ms，事件驱动替代盲等 */
export const PUSH_HERO_INFO = 10906;
/**
 * @public 协议字典出口：scripts/verify-manifests 以动态 import 读取，静态分析不可见。
 * @type {number} push PUSH_TOOL：背包物品数量推送 {itemId,amount}（897 新登记扣账 / 898 最后注销还账的回写）
 */
export const PUSH_TOOL = 10401;
