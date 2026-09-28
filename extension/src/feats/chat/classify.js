/**
 * 聊天特殊消息分类器（纯函数层，不触碰游戏运行时）。
 * 1:1 复刻 newChatInfoData.UpdateData + parseLink 判定链，把一条原始消息（推送项/历史项）
 * 归一为「语义描述子 + 联动动作」，供 chat-window 渲染分派与 P5 跳转执行器消费。
 *
 * 数值来源（均已源码实证）：
 *   ChatShareLinkType（GameDefine.js:3290-3367）、ChatShareLinkSubType（:3369-3386）、
 *   parseLink 白名单（newChatInfoData.js:1074）、UpdateData 判定链（:707-748）。
 * 与游戏口径的刻意差异：游戏对「未识别链接」整体隐藏（_isShow=false），
 *   我们输出 kind:'unknown' 占位卡而非隐藏——真机才能攒出漏网 t 值的样本。
 */

/** @type {Object<number,string>} ChatShareLinkType 数值→枚举名 */
export const LINK_TYPE = {
  [-1]: 'NONE', 0: 'POSITION', 1: 'BATTLE', 2: 'IMAGE', 3: 'BARGAIN', 4: 'TURNTABLESHARE',
  5: 'ALLIANCEMANIFESTO', 6: 'MARCH', 7: 'BEHEMOTH', 8: 'DOUBLE_LINK', 9: 'INVITE_FRIEND',
  10: 'OPEN_TREASURE', 11: 'PINGAME_LIKE', 12: 'RICHMAN_INVITE_THREE', 13: 'RELIC_PVE_HELP',
  14: 'USER_CARD', 15: 'TEAM_MATCH', 16: 'HalloweenBoss', 17: 'OPEN_CONQUEROR_RED',
  18: 'Conqueror_Bless', 19: 'App_Team', 20: 'ENDLESS_PVE_HELP', 21: 'CS_TEAM_HUNT',
  22: 'TM_WATCH', 24: 'OPEN_RANK_MATCH_RED', 25: 'HOME_PLOT_HOOK', 26: 'MINE_CAVE_ALLY_MINE',
  27: 'ACTIVITY_CHILDREN', 28: 'ACTIVITY_CHILDREN_PARK_GIFT', 29: 'TRUCK_INTERCEPT',
  30: 'ACTIVITY_FIGHT_AIRCRAFT_CARRIER', 31: 'PAB_TEAM', 32: 'PAB_WORLD_POINT',
  33: 'ENIGMA_BEAST_INFO', 34: 'ACTIVITY_COMMON', 35: 'ENIGMA_BEAST_BREED', 36: 'TEAM_DECL',
  37: 'NEWBIE_USER_CARD', 38: 'PARADE_FLOAT_MARCH_SHARE', 39: 'PARADE_FLOAT_LUCK_BAG',
  40: 'NEW_YEAR_CONCLUSION_2025', 41: 'ALLIANCE_VOTE', 42: 'TEAM_SEASON', 43: 'TRAIN_INTERCEPT',
  44: 'PAB_TRAIN', 45: 'PUZZLE_SWAP', 46: 'ADP_UNIT', 47: 'XL_CLUEITEM_EXCHANGE',
  48: 'ACTIVITY_COMMON2', 49: 'ADPRB_ATTACK', 50: 'BATTLE_BEAST_TROOP_SETTING',
  51: 'BATTLE_BEAST_MARCH', 52: 'CUSTOM_POSITION', 53: 'WASTE_LAND_SHARE',
  54: 'ATRAIN_VIP_INVITE', 55: 'OFFIC_RED_2026', 56: 'USER_RED_2026', 57: 'ATRAIN_DEFENSE_RESULT',
  58: 'AUTION_ANSWER_SHARE', 59: 'ALLIANCE_BOSS_V3_BATTLE', 60: 'GIF', 61: 'OPEN_CALL_ITEM',
  62: 'BIRTHDAY_CAKE', 63: 'REVOKE_MESSAGE', 64: 'JM_POST_SHARE', 69: 'BOSS_DAMAGE_LOG',
};

/** @type {Object<number,string>} ChatShareLinkType 数值→中文语义（渲染标题兜底用；有 s 文案时优先 s） */
export const LINK_LABEL = {
  0: '位置', 1: '战报', 2: '表情', 3: '砍价', 4: '转盘分享', 5: '联盟宣言', 6: '集结/行军',
  7: '神兽', 8: '双链接', 9: '好友邀请', 10: '开珍宝', 11: '点赞', 12: '大富翁邀请',
  13: '圣物求助', 14: '名片', 15: '组队匹配', 16: '万圣节BOSS', 17: '征服者红包', 18: '征服者祝福',
  19: '组队', 20: '无尽求助', 21: 'CS狩猎', 22: '观战', 24: '排位红包', 25: '主城剧情',
  26: '矿洞采掘', 27: '儿童节', 28: '儿童节公园礼', 29: '卡车拦截', 30: '海上夺宝', 31: 'PAB小队',
  32: 'PAB目标点', 33: '谜兽情报', 34: '活动', 35: '谜兽繁育', 36: '队伍宣言', 37: '新手名片',
  38: '花车行军', 39: '花车福袋', 40: '新年总结', 41: '联盟投票', 42: '赛季队伍', 43: '火车拦截',
  44: 'PAB火车', 45: '拼图交换', 46: 'ADP兵种', 47: '线索交换', 48: '活动', 49: 'ADPRB攻击',
  50: '战兽编队', 51: '战兽行军', 52: '自定义坐标', 53: '废土分享', 54: '火车VIP邀请',
  55: '官方红包', 56: '用户红包', 57: '火车防守战报', 58: '拍卖答题', 59: '联盟BOSS战报',
  60: '动图', 61: '召唤道具', 62: '生日蛋糕', 63: '撤回', 64: 'JM帖子', 69: 'BOSS伤害日志',
};

/** @type {Object<number,string>} ChatShareLinkSubType 数值→中文语义（位置类 st 细分目标物） */
export const SUB_LABEL = {
  0: '资源', 1: 'BOSS', 2: '集结BOSS', 3: '野怪', 4: '基地', 5: '世界遗址', 6: '战报', 7: '塔',
  8: '雪人', 9: '蛋糕', 10: '联盟矿', 11: '变形BOSS', 12: '温泉', 13: '自由技能', 14: '道具', 15: '废土建筑',
};

/** @type {number[]} parseLink 白名单（newChatInfoData.js:1074，去重后；命中即视为可识别链接） */
const WHITELIST = [
  8, 3, 4, 5, 6, 9, 10, 11, 12, 13, 20, 14, 37, 18, 15, 21, 31, 17, 16, 22, 19, 24, 25,
  33, 35, 50, 51, 61, 26, 29, 43, 54, 57, 27, 28, 32, 30, 34, 48, 36, 40, 38, 39, 44, 46,
  41, 42, 45, 47, 49, 55, 52, 53, 60, 56, 69, 59, 58, 63, 64,
];

/** @type {Set<number>} 位置类 t（含 p 坐标，可地图跳转） */
const POS_TYPES = new Set([0, 52, 29, 32, 43, 44, 30, 39]);
/** @type {Set<number>} 行军/集结类 t（含 marchId，可点行军线）。38 花车行军卡无 p 坐标、
 *  带 extra.marchId/marchType，游戏按 marchType 路由 doJumpMarch 专属分支（芯片祝福 256 →
 *  PARADE_FLOATS_GET_MARCH_INFO(8853) 查行军后置 WorldItemDropMarchHeadNode 弹层），故归行军类 */
const MARCH_TYPES = new Set([6, 51, 7, 38]);

/** @type {Object<string,string>} CHAT_CT_TYPE 值→中文标签 */
const CT_LABEL = {
  '1': '红包', '2': '图片', '3': '生日红包', '4': '金砖红包', '5': '寻人',
};

/** @type {Object<string,string>} ChatCustomSystemType 值→中文标签（GameDefine.js:4158-4164） */
export const CST_LABEL = {
  '557': '洞穴BOSS大奖', '564': '芯片祝福彩蛋', '610': '列车公告',
  '571': '红包播报', '572': '红包MVP',
};

/** 空判（对齐游戏 r.Obj.isEmpty：null/undefined/'' 视为空） */
function isEmpty(v) { return v == null || v === ''; }

/** JSON 兜底解析 */
function parse(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch (e) { return null; }
}

/**
 * 系统消息正文模板切分（UpdateData:714-730），纯解析不翻译（翻译交渲染层 getText 同键口径）。
 * \x1e 分段：2 段→第2段为键；≥3 段→第2段为键、第3段按 \x1f 拆参（每个参数本身也是语言键）。
 * 单段：含 '|' 时前段为键、后段按 ';' 拆参（参数已是实值）；否则整段即键。
 * @param {string} m 正文原文
 * @returns {{key:string, args:string[], argsAreKeys:boolean}}
 */
export function parseSysTemplate(m) {
  const r = String(m == null ? '' : m);
  const seg = r.split('\x1e');
  if (seg.length === 1) {
    const pipe = r.split('|');
    if (pipe.length === 1) return { key: r, args: [], argsAreKeys: false };
    return { key: pipe[0], args: pipe[1].split(';'), argsAreKeys: false };
  }
  if (seg.length === 2) return { key: seg[1], args: [], argsAreKeys: false };
  return { key: seg[1], args: seg[2].split('\x1f'), argsAreKeys: true };
}

/**
 * 把一条原始消息分类为语义描述子。
 * @param {object} raw 原始消息项（推送/历史）
 * @param {object} [norm] chat.normalize 产物（有则复用 llm/channel 解析结果）
 * @param {object} [opts] {translate}：translate(key,...args) 语言键翻译回调（渲染层注入，
 *   保持本模块纯函数；缺省不翻译）。链接卡 s 文案经它出标签。
 * @returns {{kind:string, t:number|null, st:number|null, typeName:string, label:string,
 *   pos:{x:number,y:number,z:number|null,subMap:number|null}|null, march:{marchId:*,marchType:*}|null,
 *   action:{type:string, [k:string]:*}|null, ct:string, hidden:boolean, llm:object|null, system:boolean}}
 */
export function classify(raw, norm, opts) {
  raw = raw || {};
  norm = norm || {};
  const tr = (opts && typeof opts.translate === 'function') ? opts.translate : null;
  const uuid = raw.fu != null ? String(raw.fu) : '';
  const deletedAt = +raw.deletedAt || 0;

  // —— 撤回卡（deletedAt>0 → REVOKE_MESSAGE，UpdateData:744-748）——
  if (deletedAt > 0) {
    return {
      kind: 'revoke', t: 63, st: null, typeName: 'REVOKE_MESSAGE', label: '撤回了一条消息',
      pos: null, march: null, action: null, ct: raw.ct || '', hidden: false, llm: null, system: false,
    };
  }

  // —— 系统/富卡片系统消息（uuid=="-1"，UpdateData:709-711；正文模板交 sys 字段）——
  if (uuid === '-1') {
    const cst = raw.cst || '';
    return {
      kind: cst ? 'custom_system' : 'system', t: null, st: null, typeName: '', label: '',
      sys: parseSysTemplate(raw.m != null ? raw.m : raw.content),
      cst: cst, cstp: parse(raw.cstp),
      pos: null, march: null, action: null, ct: raw.ct || '', hidden: false, llm: null, system: true,
    };
  }

  // —— 联盟 BOSS V3 战报走 mt 通道（_mt=="101"，UpdateData:742-743；数据源在 mtExtraData）——
  if (String(raw.mt || '') === '101') {
    const d = parse(raw.mtExtraData) || {};
    d.t = 59;
    return linkDesc(d, raw, norm, 59, tr);
  }

  // —— ct 内容类型（红包/图片/寻人，UpdateData:741；m 是语言键，本地化交渲染层）——
  const ct = raw.ct || '';
  if (ct && !isEmpty(CT_LABEL[ct])) {
    return {
      kind: 'ct', t: null, st: null, typeName: 'CT_' + ct, label: '[' + CT_LABEL[ct] + ']',
      pos: null, march: null, action: null, ct: ct, hidden: false, llm: parse(raw.llm), system: false,
    };
  }

  // —— 链接载荷 llm（parseLink:1059-1123）——
  let llm = norm.llm != null ? norm.llm : parse(raw.llm);
  if (llm && llm.linkMsg) llm = parse(llm.linkMsg) || llm;   // linkMsg 优先顶替 llm 本体
  if (!llm || isEmpty(llm.t)) {
    // 无有效链接：普通聊天（或表情裸串 link<id>，normalize 已识别为 linkType=2）
    if (norm.linkType === 2) return linkDesc({ t: 2 }, raw, norm, 2, tr);
    return {
      kind: 'chat', t: null, st: null, typeName: '', label: '', pos: null, march: null,
      action: null, ct: ct, hidden: false, llm: null, system: false,
    };
  }

  const t = +llm.t | 0;

  // 表情/动图：游戏查表把正文替换为 [表情名]（表在 TableManager，名称解析交渲染层；这里只标语义）
  if (t === 2 || t === 60) return linkDesc(llm, raw, norm, t, tr);

  // 白名单外的链接须 st&&p&&s&&icon 四字段齐全才视为可识别（parseLink:1117），否则 unknown
  if (WHITELIST.indexOf(t) < 0) {
    if (isEmpty(llm.st) || isEmpty(llm.p) || isEmpty(llm.s) || isEmpty(llm.icon)) {
      return {
        kind: 'unknown', t: t, st: llm.st != null ? +llm.st : null, typeName: LINK_TYPE[t] || ('t' + t),
        label: '[链接' + (LINK_LABEL[t] ? ' ' + LINK_LABEL[t] : ' t=' + t) + ']',
        pos: null, march: null, action: null, ct: ct, hidden: false, llm: llm, system: false,
      };
    }
  }

  // 砍价：bargain_aid 存在即归 BARGAIN（UpdateData:740，非靠 t==3）
  if (llm.bargain_aid || t === 3) return linkDesc(llm, raw, norm, 3, tr);

  return linkDesc(llm, raw, norm, t, tr);
}

/**
 * 由链接对象构造描述子 + 联动动作。
 * @param {object} llm 链接数据对象
 * @param {object} raw 原始项
 * @param {object} norm normalize 产物
 * @param {number} t 生效的 ChatShareLinkType（可能被 bargain/mt 改写）
 * @param {Function|null} tr 语言键翻译回调（可空）
 * @returns {object} 描述子
 */
function linkDesc(llm, raw, norm, t, tr) {
  const st = llm.st != null ? +llm.st : null;
  const p = llm.p && typeof llm.p === 'object' ? llm.p : null;
  // 服号提取（真机抓包实证）：跨服事件卡（t=48 等）p.z 恒为 0 假值，真实目标服在
  // extra.jumpServerId（原生 onClickArkAct 即 MOVE_TO {x,y,s:服号}，btnKey=102385 同源）；
  // 普通坐标分享才是 p:{x,y,z}（z=服号）。z<=0 一律视为无服号，游侧回退本服。
  // 子服号 sMap 对应游戏跳转参数 subMap（sendChatLinkMonster 出站实证，新图跨服换算需要）。
  const ex = typeof llm.extra === 'string' ? parse(llm.extra) : (llm.extra && typeof llm.extra === 'object' ? llm.extra : null);
  let zOf = ex && +ex.jumpServerId > 0 ? +ex.jumpServerId : null;
  if (zOf == null) {
    const zc = p && p.z != null ? +p.z : (p && p.s != null ? +p.s : (llm.sid != null ? +llm.sid : (llm.serverId != null ? +llm.serverId : null)));
    zOf = zc > 0 ? zc : null;
  }
  const subOf = llm.sMap != null ? +llm.sMap : (p && p.subMap != null ? +p.subMap : (llm.subMap != null ? +llm.subMap : null));
  const pos = p && p.x != null && p.y != null
    ? { x: +p.x | 0, y: +p.y | 0, z: zOf, subMap: subOf }
    : null;
  const march = llm.marchId != null
    ? { marchId: llm.marchId, marchType: llm.marchType != null ? +llm.marchType : null }
    : null;

  let kind = 'share';
  if (t === 0 || t === 52) kind = 'pos';
  else if (t === 1) kind = 'battle';
  else if (t === 2 || t === 60) kind = 'emoji';
  else if (t === 3) kind = 'bargain';
  else if (MARCH_TYPES.has(t) || (t === 6)) kind = 'march';

  // 联动动作：位置类优先坐标跳转，行军类点行军线；两者都带坐标时位置跳转更直观。
  // 未列类型（迷兽 33/35、废土 53 等）只要带有效坐标也放开跳转，但 click:false 只飞+标记，
  // 不模拟点地块（游戏对这类卡的原生行为未实证，防误开未知弹窗）；(0,0) 假坐标（如战报）自然排除。
  let action = null;
  if (march && !pos) action = { type: 'march', marchId: march.marchId, marchType: march.marchType };
  else if (pos && (POS_TYPES.has(t) || kind === 'pos' || kind === 'march' || t === 29 || t === 43 || t === 30))
    action = { type: 'pos', x: pos.x, y: pos.y, z: pos.z, subMap: pos.subMap, click: true };
  else if (march) action = { type: 'march', marchId: march.marchId, marchType: march.marchType };
  else if (pos && pos.x > 0 && pos.y > 0) action = { type: 'pos', x: pos.x, y: pos.y, z: pos.z, subMap: pos.subMap, click: false };

  // 标题：位置类出「目标物 坐标」→ s 文案（经 translate 翻译，查不到回原文）→ 类型名 → t 值
  let label;
  if (kind === 'pos' && pos) label = '[' + (SUB_LABEL[st] || LINK_LABEL[0]) + ' ' + pos.x + ',' + pos.y + (pos.z != null ? '@' + pos.z : '') + ']';
  else if (!isEmpty(llm.s) && typeof llm.s === 'string' && llm.s.indexOf('{') < 0) label = '[链接 ' + (tr ? tr(llm.s) : llm.s) + ']';
  else if (t === 2) label = '[表情]';
  else if (t === 60) label = '[动图]';
  else label = '[' + (LINK_LABEL[t] || LINK_TYPE[t] || ('链接 t=' + t)) + ']';

  return {
    kind, t, st, typeName: LINK_TYPE[t] || ('t' + t), label, pos, march, action,
    ct: raw.ct || '', hidden: false, llm, system: false,
  };
}
