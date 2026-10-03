// 面板菜单树：类别（左 TAB）→ 卡片（组 / 功能）→ 内容（子项 / 详细字段）的单一真相。
// 与 registry 的分工：descriptor（reactor.list() + INTERNAL_FEATURES）仍是字段/存储/默认值的真相，
// 本文件只决定层级归属、显示标签覆写与是否渲染详细字段。
// 节点：
//   kind:'category' 类别 = 面板左侧一个 TAB（日常设置/战斗设置/系统设置），本身不可开关；children=右栏卡片数组。
//   kind:'group'    组卡片：标题行带主闸门 checkbox，展开=子项 checkbox 列表（如日常任务）。
//   kind:'feature'  功能卡片：标题行带启用 checkbox；showFields=true 时展开 descriptor 的详细字段。
// 组开关语义（工程决策，勿改回门控方案）：组是 UI 层主闸门，不进 reactor 门控——
//   组关 → 子项功能 enabled=false 逐个 pause；组开 → 恢复各子项 intentEnabled（用户意图，组关不丢失）。
//   组的 enabled 存于 configs[group.id]（存储键由本文件声明），不进 reactor。
// 布局对应：联盟集结/快捷战斗/自动重连都是 category 下的 feature 卡片（不再多套一层 group，避免重复路径）；
//   网络日志/事件日志与自动重连在系统设置下平级。新增 feat 须挂进本树，否则不出现在面板。

/**
 * @typedef {object} MenuNode 菜单节点
 * @property {string} id 节点 id（类别/组/功能）
 * @property {string} kind 节点类型：category | group | feature | hotkeys
 * @property {string} [label] 展示标签（category/group 自带；feature 为面板标签覆写）
 * @property {MenuNode[]} [children] 子节点（category -> 卡片，group -> 子项）
 * @property {boolean} [showFields] feature 为真时面板渲染 descriptor 的详细字段
 * @property {string} [storageKey] group 的配置存储键
 * @property {boolean} [defaultEnabled] group 的默认开关态
 */

/**
 * 面板左 TAB 的类别 id -> 标签
 * @type {Object<string,string>}
 */
export const CATEGORIES = {
  daily: '日常设置',
  battle: '战斗设置',
  map: '地图设置',
  system: '系统设置',
};

/**
 * 面板菜单树根（三个类别节点）
 * @type {MenuNode[]}
 */
export const MENU = [
  {
    id: 'daily', kind: 'category', label: CATEGORIES.daily, children: [
      {
        id: 'dailyTasks', kind: 'group', label: '日常任务', defaultEnabled: true,
        storageKey: 'pocketcc.group.dailyTasks',
        // 日常任务只出 checkbox，详细参数一律用默认值/存量值（feature 卡片无 showFields）
        children: [
          { id: 'floatCar', kind: 'feature', label: '花车空投' },
          { id: 'titanBlessing', kind: 'feature', label: '泰坦祝福' },
          { id: 'allianceHelp', kind: 'feature', label: '联盟帮助' },
          { id: 'domainTreasure', kind: 'feature', label: '领域寻宝' },
          { id: 'launchSilo', kind: 'feature', label: '占领发射井' },
          { id: 'seaTreasure', kind: 'feature', label: '海上夺宝' },
          { id: 'allianceGift', kind: 'feature', label: '联盟礼物' },
          { id: 'allianceScience', kind: 'feature', label: '联盟科技' },
        ],
      },
      { id: 'allianceRally', kind: 'feature', label: '联盟集结', showFields: true },
      { id: 'sourceOfWar', kind: 'feature', label: '战争之源', showFields: true },
      { id: 'allianceBoss', kind: 'feature', label: '联盟机甲', showFields: true },
      { id: 'citySkill', kind: 'feature', label: '城市技能', showFields: true },
      { id: 'playerLike', kind: 'feature', label: '玩家点赞', showFields: true },
      { id: 'mineCave', kind: 'feature', label: '次元矿洞', showFields: true },
      { id: 'autoFarm', kind: 'feature', label: '自动下田', showFields: true },
      { id: 'relicReward', kind: 'feature', label: '遗迹奖励', showFields: true },
    ],
  },
  {
    id: 'battle', kind: 'category', label: CATEGORIES.battle, children: [
      { id: 'quickAttack', kind: 'feature', label: '快捷战斗' },
      { id: 'imperialDecree', kind: 'feature', label: '奉旨出征', showFields: true },
    ],
  },
  {
    id: 'map', kind: 'category', label: CATEGORIES.map, children: [
      { id: 'globalMap', kind: 'feature', label: '全局地图', showFields: true },
    ],
  },
  {
    id: 'system', kind: 'category', label: CATEGORIES.system, children: [
      { id: 'chatWindow', kind: 'feature', label: '聊天窗口', showFields: true },
      { id: 'reconnect', kind: 'feature', label: '自动重连', showFields: true },
      { id: 'netLog', kind: 'feature', label: '网络日志' },
      { id: 'eventLog', kind: 'feature', label: '事件日志' },
      { id: 'netRecord', kind: 'feature', label: '报文录制', showFields: true },
      // 只读信息卡：渲染 core/hotkeys.js 注册表的当前全部绑键（非 feature，不可开关、不进存储）
      { id: 'hotkeyGuide', kind: 'hotkeys', label: '快捷键一览' },
    ],
  },
];

/**
 * 递归收集一个节点下的全部功能叶子 id（group 收集其子项，feature 收集自身）
 * @param {MenuNode|{children?:MenuNode[]}} node 起始节点（可为伪节点 {children}）
 * @param {string[]} [out] 累加数组，缺省新建
 * @returns {string[]} 功能 id 列表
 */
export function collectFeatureIds(node, out) {
  out = out || [];
  if (node.kind === 'feature') out.push(node.id);
  if (node.children) for (const ch of node.children) collectFeatureIds(ch, out);
  return out;
}

/**
 * 面板上出现的全部功能 id（registry 用它兜底补默认 intent，防旧存档缺键）
 * @returns {string[]}
 */
export function allMenuItemIds() {
  return collectFeatureIds({ children: MENU }, []);
}

/**
 * 面板中「渲染了详细字段」的功能 id 集合（feature 卡片 showFields=true）。
 * 未在此集合的面板功能（日常任务各项、快捷战斗、网络/事件日志）= 只出 checkbox、详细参数不展示，
 * registry 据此决定：这些功能的详细参数不读写 local，一律用 descriptor 默认值。
 * @returns {Set<string>} 功能 id 集合
 */
export function fieldVisibleFeatureIds() {
  const set = new Set();
  const walk = (nodes) => nodes.forEach((n) => {
    if (n.kind === 'feature' && n.showFields) set.add(n.id);
    if (n.children) walk(n.children);
  });
  walk(MENU);
  return set;
}

/**
 * 全部组节点（registry 据此把组的 enabled 并入 configs 统一读盘/存档）
 * @returns {Array<{id:string, storageKey:string, defaults:{enabled:boolean}}>}
 */
export function groupConfigs() {
  const groups = [];
  const walk = (nodes) => nodes.forEach((n) => {
    if (n.kind === 'group') groups.push({ id: n.id, storageKey: n.storageKey, defaults: { enabled: !!n.defaultEnabled } });
    if (n.children) walk(n.children);
  });
  walk(MENU);
  return groups;
}
