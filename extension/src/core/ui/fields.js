// descriptor.fields[] → 面板行 HTML 的纯构建器族（无 DOM 绑定，只返回字符串）。
// 从 core/ui.js 迁出：cardHead / 各 *InnerHTML / buildFieldsHTML。值来自 registry.configs，转义走 dom.escAttr。
import { configs, findFeature } from '../registry.js';
import { escAttr } from './dom.js';

/** @type {string} 「0 = 无限」类数字框的占位文案（此前 3 处各写一份字面量，改文案要三处对齐） */
const PLACEHOLDER_UNLIMITED = '不限';

/**
 * 卡片标题行 HTML：折叠箭头 + 标题 + 启用 checkbox（组用 pc-gen[data-gid]，功能用 pc-en[data-id]）
 * @param {string} label 标题文本
 * @param {string} chkHTML checkbox 片段
 * @param {boolean} expandable 是否可展开（否则箭头隐藏）
 * @returns {string}
 */
export function cardHead(label, chkHTML, expandable) {
  return (
    `<div class="pc-sec-head">` +
    `<span class="pc-chev${expandable ? '' : ' invisible'}">▶</span>` +
    `<span class="pc-sec-title">${label}</span>${chkHTML}</div>`
  );
}

/**
 * 多选开关组字段（type:'multiopts'，如次元矿洞按矿种多选）内层 HTML。
 * 选项集由 fd.options 提供：数组直接用，函数则每次求值时传当前 cfg（配置表运行时动态枚举）。
 * 选中态 configs[fid][fd.key] 为 number[]（命中的 option.value 集合）。勾选/取消由 wirePanel 事件委托接。
 * fd.stack=true 时选项竖排（一行一项，长中文名不被截断）；否则按 fd.gridMin 列宽横排（缺省 72px）。
 * fd.maxSelect>0 限定最多勾选数：标题行右侧显示「已选 n/上限」，满额后未勾选项置 disabled（wire 侧另有回弹兜底）。
 * @param {number[]} selected 当前选中值数组
 * @param {object} fd 字段描述符（label / options / hint / 可选 gridMin：列最小宽 px，缺省 72 / 可选 stack / 可选 maxSelect）
 * @param {object} cfg 该功能当前配置（透传给 fd.options 函数）
 * @returns {string}
 */
export function multiOptsInnerHTML(selected, fd, cfg) {
  const opts = (typeof fd.options === 'function' ? fd.options(cfg) : fd.options) || [];
  const sel = Array.isArray(selected) ? selected : [];
  const cap = Math.max(0, Math.floor(Number(fd.maxSelect) || 0));
  // 旧存档可能已超额：满额判定用 >=，超额时已勾项仍可取消（只锁未勾的）
  const full = cap > 0 && sel.length >= cap;
  const cells = opts
    .map((o) => {
      const on = sel.indexOf(o.value) >= 0;
      const dis = full && !on ? ' disabled' : '';
      return (
        `<label class="pc-mopt${full && !on ? ' pc-moptdis' : ''}">` +
        `<input type="checkbox" class="pc-moptchk" value="${o.value}"${on ? ' checked' : ''}${dis}>` +
        `${escAttr(String(o.label))}</label>`
      );
    })
    .join('');
  const gridStyle = fd.stack
    ? 'grid-template-columns:1fr'
    : fd.gridMin
      ? `grid-template-columns:repeat(auto-fill,minmax(${+fd.gridMin || 72}px,1fr))`
      : '';
  return (
    `<div class="pc-mopstop">` +
    `<span class="pc-mopttitle">${escAttr(fd.label || '多选')}</span>` +
    `<span class="pc-moptacts">` +
    (cap > 0 ? `<span class="pc-moptcount">${sel.length}/${cap}</span>` : '') +
    `<button class="pc-moptall" type="button">全选</button>` +
    `<button class="pc-moptnone" type="button">清空</button></span>` +
    `</div>` +
    `<div class="pc-moptgrid"${gridStyle ? ` style="${gridStyle}"` : ''}>${cells || '<div class="pc-rnghint">暂无可选项</div>'}</div>` +
    (fd.hint ? `<div class="pc-rnghint">${escAttr(fd.hint)}</div>` : '')
  );
}

/**
 * 采集规则字段（type:'minerules'，次元矿洞）内层 HTML：标题行（含右上＋）+ 若干规则块。
 * 每块单行：盒子「矿种▾ + 等级▾ + 「星级」标签 + ★点选」，× 删除按钮靠右与标题行＋对齐。各维度 0 = 不限。
 * 行存在即生效（已无行级 enabled 开关，要停某条只能 × 删除）；矿种选项由 fd.options(cfg)、等级由 fd.levelOptions(cfg)、★颗数由 fd.maxStar(cfg) 提供；行增删/改值由 wirePanel 事件委托接。
 * @param {Array<{type:number,level:number,star:number}>} list 当前规则表
 * @param {object} fd 字段描述符（label / options / levelOptions / maxStar / hint）
 * @param {object} cfg 该功能当前配置（透传给 fd.options）
 * @returns {string}
 */
export function mineRulesInnerHTML(list, fd, cfg) {
  const typeOpts = (typeof fd.options === 'function' ? fd.options(cfg) : fd.options) || [];
  const lvOpts =
    (typeof fd.levelOptions === 'function' ? fd.levelOptions(cfg) : fd.levelOptions) || [];
  const maxStar = (typeof fd.maxStar === 'function' ? fd.maxStar(cfg) : fd.maxStar) || 5;
  const optsHTML = (opts, sel) =>
    opts
      .map(
        (o) =>
          `<option value="${o.value}"${Number(o.value) === sel ? ' selected' : ''}>${escAttr(String(o.label))}</option>`,
      )
      .join('');
  const rows = (Array.isArray(list) ? list : [])
    .map((r, i) => {
      const type = Number(r.type) || 0,
        lv = Number(r.level) || 0,
        star = Number(r.star) || 0;
      let stars = '';
      for (let s = 1; s <= maxStar; s++) {
        const on = s <= star;
        stars += `<span class="pc-mrstar${on ? ' on' : ''}" data-part="star" data-star="${s}" title="${s} 星；再点当前星=不限">${on ? '★' : '☆'}</span>`;
      }
      return (
        `<div class="pc-mrrow" data-idx="${i}">` +
        `<div class="pc-mrbox">` +
        `<select class="pc-mrsel pc-mrtype" data-part="type" title="矿种">${optsHTML(typeOpts, type)}</select>` +
        `<select class="pc-mrsel pc-mrlv" data-part="level" title="等级">${optsHTML(lvOpts, lv)}</select>` +
        `<span>星级</span>` +
        `<span class="pc-mrstars" title="星级；再点当前星=不限">${stars}</span>` +
        `</div>` +
        `<button class="pc-mrdel" type="button" title="删除此规则">×</button>` +
        `</div>`
      );
    })
    .join('');
  return (
    `<div class="pc-mruletop">` +
    `<span class="pc-rngtitle">${escAttr(fd.label || '采集规则')}</span>` +
    `<button class="pc-mradd" type="button" title="添加一条规则">＋</button>` +
    `</div>` +
    (rows ||
      '<div class="pc-rnghint">未添加规则 = 不采集；点＋添加的行即生效，同时会暂停总开关，配好后手动重新打开</div>') +
    (fd.hint ? `<div class="pc-rnghint">${escAttr(fd.hint)}</div>` : '')
  );
}

/**
 * 资源种类定义（值 → 下拉摘要短名 / 展开后的全名 / 说明）。雷神(family16) 无遗迹田，渲染时单独禁用。
 * 数组顺序就是下田优先级（遗迹 > 机械 > 普通），摘要拼接与展开列表都按此序，不随勾选先后变化。
 * @type {Array<{value:string,label:string,short:string,title:string}>}
 */
const FARM_KIND_DEFS = [
  {
    value: 'relic',
    short: '遗迹',
    long: '遗迹(6级)',
    title: '遗迹田：只能由「遗迹区域刷新」邮件开出，刷新后 4 小时内可采',
  },
  {
    value: 'tower',
    short: '机械',
    long: '机械田',
    title: '机械田：联盟成员建造的资源塔，需有余量（派前查驻军容量）',
  },
  {
    value: 'normal',
    short: '普通',
    long: '普通田',
    title: '普通田：1~5 级，走 906 服务端搜索，等级从高到低试',
  },
];

/**
 * 种类多选 → 下拉按钮上的摘要文案（按优先级序拼短名，一项未选回「未选」= 该行不下田）。
 * 首次渲染与勾选后就地刷新共用此函数，避免两处文案口径漂移。
 * @param {string[]} kinds 已选种类
 * @returns {string} 形如 "遗迹·机械"
 */
export function farmKindSummary(kinds) {
  const arr = Array.isArray(kinds) ? kinds : [];
  const picked = FARM_KIND_DEFS.filter((d) => arr.indexOf(d.value) >= 0);
  return picked.length ? picked.map((d) => d.short).join('·') : '未选';
}

/**
 * 资源类型多选 → 下拉按钮上的摘要文案（按 familyOptions 的**展示序**拼短名，一项未选回「未选」= 该队不下田）。
 * 摘要顺序不表达优先级：同分时的家族优先级（雷神 > 石油 = 粮食 > 金矿）真相在 priority.FAMILY_RANK，
 * 与面板展示序故意解耦，改下拉选项顺序不会偷偷改掉取田优先级。
 * @param {number[]} families 已选家族编码
 * @param {Array<{value:number,label:string,short?:string}>} options 家族下拉数据源
 * @returns {string} 形如 "金·粮·油"
 */
export function farmFamilySummary(families, options) {
  const arr = (Array.isArray(families) ? families : []).map((f) => Number(f) || 0);
  const picked = (options || []).filter((o) => arr.indexOf(Number(o.value)) >= 0);
  return picked.length ? picked.map((o) => o.short || String(o.label)).join('·') : '未选';
}

/**
 * 下田规则字段（type:'farmrules'，自动下田）内层 HTML：标题行（含右上＋）+ 若干「队伍行」。
 * **一行 = 一支队伍去匹配资源**：预设编队▾(1~16，单选、整表互斥) + 资源类型▾多选(金/粮/油/雷神)
 * + 资源种类▾多选(遗迹/机械/普通) + × 删除。
 * 两个多选控件是**下拉样式的多选**（原生 select 做不到“展开后不收起、每项带勾选框”，故自研）：
 * 按钮显示已选摘要，点开是一份浮在下方的选项列表（每项 checkbox + 文案），勾完可连着勾下一项、点列表外即收起。
 * 两处共用同一套类名与结构（.pc-frkinds[data-grp] / .pc-frkbtn / .pc-frkpop / .pc-frkin），
 * wire.js 的委托只认这套类名、靠 data-grp 分流，所以新增一个多选组不用动浮层那套管子。
 * 浮层用 Popover API（`popover` 属性）挂上去——面板/卡片/内容区都有 overflow 裁切，面板自身还带 backdrop-filter
 * （会给 fixed 子元素建 containing block），只有 top layer 能同时躲过这两层裁切；老 Chrome 不支持时自动退回
 * 流内撑开成一行（见 wire.js 的降级分支与 panel-css 的 .pc-frkinds.pc-open 撑开规则）。
 * 预设编队在整表内互斥：其它行已选用的值渲染成 disabled（本行自身仍可选），与 feat 侧 normalizeRules 的
 * 全局唯一口径对齐。雷神没有 6 级田，故**本行勾选的家族全都开不出遗迹**（只剩雷神）时遗迹选项置 disabled。
 * 行存在即生效；preset 改动与行增删整块重绘（disabled 要随之联动），family/kind 勾选只就地刷摘要
 *（两者都不影响其它行，重绘反而会把展开中的浮层关掉）。
 * @param {Array<{preset:number,families?:number[],kinds?:string[]}>} list 当前队伍规则表
 * @param {object} fd 字段描述符（label / familyOptions / presetOptions / hint）
 * @returns {string}
 */
export function farmRulesInnerHTML(list, fd) {
  const optsHTML = (opts, sel, disabled) =>
    (opts || [])
      .map((o) => {
        const v = Number(o.value);
        const dis = disabled && disabled.has(v) && v !== sel ? ' disabled' : '';
        return `<option value="${o.value}"${v === sel ? ' selected' : ''}${dis}>${escAttr(String(o.label))}</option>`;
      })
      .join('');
  /**
   * 一个多选下拉控件（资源类型 / 资源种类共用）。
   * @param {string} grp 组名（family | kind）：进容器 data-grp 与选项的 data-part，wire 靠它分流
   * @param {string} btnTitle 按钮 title（说明这组是什么、全不勾的含义）
   * @param {Array<{value:string|number,long:string,title?:string,dis?:boolean}>} defs 选项定义
   * @param {Array<string|number>} picked 该行已选值（数字/字符串混用，比较统一走 String）
   * @param {string} sum 按钮上的已选摘要
   * @returns {string}
   */
  const optCell = (grp, btnTitle, defs, picked, sum) => {
    const has = (v) => picked.map(String).indexOf(String(v)) >= 0;
    const optRows = defs
      .map((d) => {
        // 已选中的不因置灰条件被锁死（勾不动 = 取消不了），避免数据与控件打架
        const dis = !!d.dis && !has(d.value);
        return (
          `<label class="pc-frkopt${dis ? ' pc-frkoptdis' : ''}" title="${escAttr(d.title || '')}">` +
          `<input type="checkbox" class="pc-frkin" data-part="${grp}" value="${d.value}"${has(d.value) ? ' checked' : ''}${dis ? ' disabled' : ''}>` +
          `<span>${escAttr(d.long)}</span></label>`
        );
      })
      .join('');
    return (
      `<span class="pc-frkinds" data-grp="${grp}">` +
      `<button class="pc-frkbtn" type="button" title="${escAttr(btnTitle)}">` +
      `<span class="pc-frksum">${escAttr(sum)}</span>` +
      `<span class="pc-frkcaret" aria-hidden="true">▾</span></button>` +
      `<span class="pc-frkpop" popover="manual">${optRows}</span></span>`
    );
  };
  const rowsArr = Array.isArray(list) ? list : [];
  const usedPresets = new Set(rowsArr.map((r) => Number(r && r.preset) || 1));
  const famDefs = (fd.familyOptions || []).map((o) => ({
    value: Number(o.value),
    long: String(o.label),
    title: '资源类型：这支队愿意去采的家族（多选，同分时按 雷神 > 石油 = 粮食 > 金矿 挑）',
  }));
  const rows = rowsArr
    .map((r, i) => {
      const preset = Number(r && r.preset) || 1;
      const families = (Array.isArray(r && r.families) ? r.families : [])
        .map((f) => Number(f) || 0)
        .filter((f) => f > 0);
      const kinds = Array.isArray(r && r.kinds) ? r.kinds : [];
      // 雷神没有 6 级田（遗迹邮件只开得出金/粮/油）：只剩雷神时遗迹不可下，与 normalizeRules 同口径
      const relicDis = families.length > 0 && families.every((f) => f === 16);
      const kindDefs = FARM_KIND_DEFS.map((k) => ({
        value: k.value,
        long: k.long,
        title: k.title,
        dis: k.value === 'relic' && relicDis,
      }));
      return (
        `<div class="pc-frrow" data-idx="${i}">` +
        `<div class="pc-frmain">` +
        `<div class="pc-frbox">` +
        `<select class="pc-frsel" data-part="preset" title="预设编队（1~8 战斗 / 9~16 采集；整表内不可重复）">${optsHTML(
          fd.presetOptions,
          preset,
          usedPresets,
        )}</select>` +
        `<span class="pc-frdiv" aria-hidden="true"></span>` +
        optCell(
          'family',
          '资源类型（多选；全不勾 = 该队不下田）',
          famDefs,
          families,
          farmFamilySummary(families, fd.familyOptions),
        ) +
        `<span class="pc-frdiv" aria-hidden="true"></span>` +
        optCell(
          'kind',
          '资源种类（多选；全不勾 = 该队不下田）',
          kindDefs,
          kinds,
          farmKindSummary(kinds),
        ) +
        `</div>` +
        `<button class="pc-frdel" type="button" title="删除这支队伍">×</button>` +
        `</div></div>`
      );
    })
    .join('');
  return (
    `<div class="pc-fruletop">` +
    `<span class="pc-rngtitle">${escAttr(fd.label || '下田规则')}</span>` +
    `<button class="pc-fradd" type="button" title="添加一支队伍">＋</button>` +
    `</div>` +
    (rows ||
      '<div class="pc-rnghint">未添加队伍 = 不下田；点＋添加的行即生效，同时会暂停总开关，配好后手动重新打开</div>') +
    (fd.hint ? `<div class="pc-rnghint">${escAttr(fd.hint)}</div>` : '')
  );
}

/**
 * 下田时段字段（type:'timeranges'，自动下田）内层 HTML：标题行（含右上＋）+ 若干 `[ 起始 ~ 结束 × ]` 行。
 * 每行用原生 `<input type="time">` 选「时:分」，值落 configs[fid][fd.key] = [{start:'HH:MM', end:'HH:MM'}]（字符串，可跨午夜：start>end 视为越过 24:00）。
 * 任一时段命中即视为在下田时段内；行可增删，改值/增删后整块重刷（同 ranges/farmrules，走面板级事件委托）。
 * @param {Array<{start:string,end:string}>} list 当前时段表
 * @param {object} fd 字段描述符（label / hint 可选）
 * @returns {string}
 */
export function timeRangesInnerHTML(list, fd) {
  const rows = (Array.isArray(list) ? list : [])
    .map((r, i) => {
      const s = String((r && r.start) || '');
      const e = String((r && r.end) || '');
      return (
        `<div class="pc-trow" data-idx="${i}">` +
        `<input type="time" class="pc-tinp" data-part="start" value="${escAttr(s)}" title="下田时段开始时刻">` +
        `<span class="pc-tdash">~</span>` +
        `<input type="time" class="pc-tinp" data-part="end" value="${escAttr(e)}" title="下田时段结束时刻（开始>结束=跨午夜）">` +
        `<button class="pc-tdel" type="button" title="删除此时段">×</button>` +
        `</div>`
      );
    })
    .join('');
  return (
    `<div class="pc-trtop">` +
    `<span class="pc-rngtitle">${escAttr(fd.label || '下田时段')}</span>` +
    `<button class="pc-tradd" type="button" title="添加一个时段">＋</button>` +
    `</div>` +
    (rows || '<div class="pc-rnghint">无时段，点右上＋添加</div>') +
    `<div class="pc-rnghint">${escAttr(fd.hint || '仅在所列时段内下田，时段外立即撤田；开始>结束视为跨午夜')}</div>`
  );
}

/**
 * 区间规则字段（type:'ranges'）内层 HTML：列头 + 若干 `[ from ~ to ) → count ×` 行 + 标题行右侧的「＋」。
 * 列头与数据行共用 rngRow 模板（括号类格子在列头只隐藏），否则三列无法逐列对齐；行号挂在 .pc-rngrow[data-idx]，
 * 委托时靠它定位，不能用 querySelectorAll('.pc-rngrow') 的下标（会把列头行算进去，整体偏一位）。
 * @param {Array<{from:number,to:number,count:number}>} list 当前规则表
 * @param {object} fd 字段描述符（label / cols / hint 可选）
 * @returns {string}
 */
export function rangesInnerHTML(list, fd) {
  const cols = fd.cols || ['大于等于', '小于', '数值'];
  const rngRow = (cells, rowIdx) =>
    `<div class="pc-rngrow${rowIdx === undefined ? ' pc-rnghead' : ''}"` +
    (rowIdx === undefined ? '' : ` data-idx="${rowIdx}"`) +
    `>` +
    `<span class="pc-rngop">[</span>${cells[0]}` +
    `<span class="pc-rngop">~</span>${cells[1]}` +
    `<span class="pc-rngop">)</span><span class="pc-rngop">→</span>${cells[2]}` +
    `${cells[3]}</div>`;
  const rows = (Array.isArray(list) ? list : [])
    .map((r, i) =>
      rngRow(
        [
          `<input type="number" class="pc-rngn" data-part="from" min="0" step="1" value="${r.from | 0}" title="区间下界（含）">`,
          `<input type="number" class="pc-rngn" data-part="to" min="0" step="1" value="${r.to | 0}" title="区间上界（不含）；填 0 = 不封顶">`,
          `<input type="number" class="pc-rngn" data-part="count" min="0" step="1" value="${r.count | 0}" title="命中该区间的数值；填 0 = 该段不生效">`,
          `<button class="pc-rngdel" type="button" title="删除此档">×</button>`,
        ],
        i,
      ),
    )
    .join('');
  return (
    `<div class="pc-rngtop">` +
    `<span class="pc-rngtitle">${fd.label || '区间规则'}</span>` +
    `<button class="pc-rngadd" type="button" title="增加一档">＋</button>` +
    `</div>` +
    rngRow([
      `<span class="pc-rnglbl">${cols[0]}</span>`,
      `<span class="pc-rnglbl">${cols[1]}</span>`,
      `<span class="pc-rnglbl">${cols[2]}</span>`,
      `<span class="pc-rngdelcol"></span>`,
    ]) +
    (rows || '<div class="pc-rnghint">无档位，点右上＋添加</div>') +
    `<div class="pc-rnghint">${fd.hint || '先命中先生效；0 = 不封顶 / 不生效'}</div>`
  );
}

/**
 * 好友清单字段（type:'uidlist'）内层 HTML：标题行（含右上＋，达上限置 disabled）+ 若干 UID 行 + 上限 hint。
 * 每行是一个 .pc-uidwrap.pc-uli[data-idx=i]（复用城市技能 UID 控件的视觉与显示↔输入态），行尾带 × 删除；
 * 与标量 UID 行的区别：值落在 configs[fid].friends[i].{uid,name}，故行不带 data-ukey/nkey，靠 data-idx 定位。
 * 行的称呼名词由 fd.itemLabel 定制（玩家点赞缺省「好友」，奉旨出征为「执政官」）。
 * fd.itemCheck=true 时每行前置勾选框（.pc-ulichk，写回行对象 .on）：未勾行由 feat 侧自行排除，
 *   存量行无 on 视为已勾（向后兼容，缺省不改变既有行为）。
 * @param {Array<{uid:string, name:string, on?:boolean}>} list 当前好友清单
 * @param {object} fd 字段描述符（label / max / placeholder / hint / itemLabel / itemCheck 可选；itemLabel 行的称呼名词，缺省「好友」）
 * @returns {string}
 */
export function uidListInnerHTML(list, fd) {
  const arr = Array.isArray(list) ? list : [];
  const max = fd.max || 10;
  const ph = escAttr(fd.placeholder || '');
  const item = escAttr(fd.itemLabel || '好友');
  const rows = arr
    .map((it, i) => {
      const uidV = String((it && it.uid) || '');
      const nmV = String((it && it.name) || '');
      const chk = fd.itemCheck
        ? `<input type="checkbox" class="pc-ulichk" data-idx="${i}" title="勾选才入池"${it && it.on === false ? '' : ' checked'}>`
        : '';
      return (
        `<div class="pc-uidwrap pc-uli" data-idx="${i}">` +
        `<div class="pc-row">${chk}<span>${item} ${i + 1}</span>` +
        `<span class="pc-udisp" title="点击编辑 UID"><span class="pc-uedit">✎</span><span class="pc-uname">${escAttr(nmV || uidV)}</span></span>` +
        `<input type="text" class="pc-uinput" inputmode="numeric" hidden placeholder="${ph}">` +
        `<button class="pc-udel" type="button" title="删除此${item}">×</button>` +
        `</div><div class="pc-uhint" hidden></div></div>`
      );
    })
    .join('');
  return (
    `<div class="pc-ulisttop">` +
    `<span class="pc-rngtitle">${fd.label || item + '清单'}</span>` +
    `<button class="pc-ulistadd" type="button" title="添加${item}"${arr.length >= max ? ' disabled' : ''}>＋</button>` +
    `</div>` +
    (rows || `<div class="pc-rnghint">无${item}，点右上＋添加</div>`) +
    `<div class="pc-rnghint">${fd.hint || '最多 ' + max + ' 个；点＋添加，×删除'}</div>`
  );
}

/**
 * 领取优先级清单行标签：若 fd.resolve(el) 可用则解析为道具名×数量串（与面板同源）；
 * 否则直接将元素本身作为标签（池元素为道具名/itemId 时即原样显示）。
 * @param {object} fd 字段描述符（可带 resolve(el)=>[{name,id,count}]）
 * @param {string|number} el 池元素（道具名字符串，或道具 itemId）
 * @returns {string}
 */
export function sortListLabel(fd, id) {
  try {
    if (fd && typeof fd.resolve === 'function') {
      const items = fd.resolve(id);
      if (Array.isArray(items) && items.length) {
        return items
          .map(
            (it) => (it && (it.name || '#' + it.id)) + (it && it.count > 1 ? ' ×' + it.count : ''),
          )
          .join('、');
      }
    }
  } catch (e) {
    /* 符号缺失/解析异常 → 回退原值 */
  }
  return String(id);
}

/**
 * 领取优先级清单字段（type:'sortlist'）内层 HTML：标题行 + 若干 `[拖拽手柄 序号 名称]` 行 + hint。
 * 行不可增删（整池全员参与），只能整行拖拽换位，序数组下标即优先级（越靠上越优先）。
 * @param {Array<string|number>} list 当前顺序（道具名或奖励配置 id 数组）
 * @param {object} fd 字段描述符（label / hint / resolve 可选）
 * @returns {string}
 */
export function sortListInnerHTML(list, fd, offArr) {
  const arr = Array.isArray(list) ? list : [];
  const checkable = !!(fd && fd.checkable);
  const offSet = new Set(checkable && Array.isArray(offArr) ? offArr.map(String) : []);
  const rows = arr
    .map((id, i) => {
      const label = sortListLabel(fd, id);
      const isOff = checkable && offSet.has(String(id));
      const chk = checkable
        ? `<input type="checkbox" class="pc-scheck" data-sc="${escAttr(String(id))}"${isOff ? '' : ' checked'}>`
        : '';
      return (
        `<div class="pc-srow${isOff ? ' pc-srowoff' : ''}" data-skey="${escAttr(String(id))}">` +
        `<span class="pc-shandle" title="按住拖拽调整顺序">⣿</span>` +
        chk +
        `<span class="pc-srank">${i + 1}</span>` +
        `<span class="pc-sname" title="${escAttr(label)}">${escAttr(label)}</span>` +
        `</div>`
      );
    })
    .join('');
  return (
    `<div class="pc-slisttop">` +
    `<span class="pc-rngtitle">${escAttr(fd.label || '领取优先级')}</span>` +
    `<span class="pc-rnghint">拖动调整顺序</span>` +
    `</div>` +
    `<div class="pc-srows">` +
    (rows || '<div class="pc-rnghint">礼品池为空</div>') +
    `</div>` +
    `<div class="pc-rnghint">${escAttr(fd.hint || '拖动调整顺序，顺序靠前优先领取')}</div>`
  );
}

/**
 * 按拖拽序排池：order 里出现过的 id 按其下标在前（下标即优先级），其余按池原序追加在后。
 * order 为空/非数组时原样返回（旧存档未排过序 → 展示与引擎优先级均退回池序）。
 * @param {Array<{id:string|number}>} arr 池项
 * @param {Array<string>|null} order 拖拽序（id 字符串数组）
 * @returns {Array<object>} 排好序的同一批项（不新建项对象）
 */
function orderPoolItems(arr, order) {
  if (!Array.isArray(order) || !order.length || !Array.isArray(arr)) return arr;
  const idx = new Map();
  for (let i = 0; i < order.length; i++) {
    const k = String(order[i]);
    if (!idx.has(k)) idx.set(k, i); // 同一个 key 重复登记时取首个（Array#sort 稳，同下标保池序）
  }
  const hit = [];
  const miss = [];
  for (const it of arr) (idx.has(String(it.id)) ? hit : miss).push(it);
  return hit.sort((a, b) => idx.get(String(a.id)) - idx.get(String(b.id))).concat(miss);
}

/**
 * 物品清单项字段（type:'itemlist'）内层 HTML：标题行 + 若干 `[拖拽 序号] 名称 [数字(0=占位显示上限/无上限)｜钻石价][≤cap][总数量] [拾] [店]` 行 + hint。
 * 行不可增删（整池全员参与）；每行一枚主勾选 + 一个目标数量输入（全仓统一约定：0=无上限），
 *   或 `fd.costCol` 时把那个数字输入换成**只读的红色钻石价列**（抢购类清单没有「本轮买几件」这个自由度，价才是唯一需要看的数）。
 * `fd.stockText(key, item)` 存在时在价列之后多一枚**只读总数量列**（.pc-istock，如密所「全部商店该商品剩余之和」）：
 *   它是「随数据变、但不重建行」的格，故与怪物清单「已打」同一通路——挂 .pc-fval + data-istock，由 refreshTexts 就地改文本，
 *   绝不走 refreshFieldBox（那会 innerHTML 覆盖整块、把 mountItemList 绑好的拖拽/勾选监听全拆掉）。
 * 状态 cfg[fd.key] 形如 `{ [idStr]: { on: 0|1, max: number } }`，未登记的项视为默认（on=1、max=0=无上限）。
 * 池由 fd.items（数组或 fn(cfg)）提供，每项 `{id, label, cap?, pickDisabled?, channel2Disabled?}`；id 可为字符串（如 'item:41009'）避免跨池数字碰撞。
 * `fd.channel2`（`{key,label,aLabel?,title?,disabledOf?(item)}`）存在时行尾多一枚**第二渠道勾选**（class `.pc-ichk2`，回写 `state[key][ch2.key]`），
 *   用于「同一实体多渠道」的清单（如秘境持有清单：on=拾取渠道、shop=商店补货渠道，两渠道共用一个目标持有量 max）；
 *   两渠道各自可置灰：主勾选看池项 `pickDisabled`（如仅商店在售、无掉落来源的道具不可拾），第二渠道经 `ch2.disabledOf`（缺省看 `item.channel2Disabled`）；
 *   置灰的勾选渲染为未勾+禁选（存储里的陈旧值不生效也不展示）。行灰化（pc-irowoff）在可用渠道全部关时才生效。
 *   排版：[拖拽手柄][序号] [主勾选] [名称(+≤cap 角标)] [数字输入] [第二渠道勾选]（数量紧跟名称、渠道勾选居右成列）。
 * `fd.sortable`（配 fd.orderKey）时每行行首多一个拖拽手柄 + 序号，展示序按 order 排（下标即优先级，越靠前越先拾）。
 * `cap>0` 表示游戏**自身已有一道硬上限**（如秘境道具的 ITEM.para1_v1）：行内标 `≤cap`、输入框带 max/data-cap，
 *   超过 cap 的值在渲染时就回落为 cap（与 mountItemList 的 change 修正同口径）。
 * @param {Array<{id:string|number,label:string,cap?:number,pickDisabled?:boolean,channel2Disabled?:boolean,cost?:number}>|function(object):Array} items 池源
 * @param {object} state 当前配置对象（cfg[fd.key]）
 * @param {object} fd 字段描述符（label / hint / topHint / items / sortable / orderKey / channel2 / nameGrow / costCol / stockText / stockTitle / summary）
 * @param {Array<string>} [order] 拖拽序（cfg[fd.orderKey]），缺省按池原序展示
 * @param {object} [cfgForSummary] 该 feature 的整个配置对象（仅当 `fd.summary` 为 fn 时作为第三参回传，供汇总读到其他字段）
 * @param {string} [fid] 功能 id（只读格挂 data-fid 供 refreshTexts 回查 descriptor，与 huntListInnerHTML 同口径）
 * @returns {string}
 */
export function itemListInnerHTML(items, state, fd, order, cfgForSummary, fid) {
  const arr = orderPoolItems(
    typeof items === 'function' ? items() : Array.isArray(items) ? items : [],
    order,
  );
  const map = state && typeof state === 'object' ? state : {};
  const sortable = !!(fd && fd.sortable);
  const ch2 = fd && fd.channel2;
  // fd.nameGrow：名称列改为弹性填充（flex:1 1 auto）而非固定 66px——长物品名（如密所带钻石价的行）不再被截断，
  //   且各行的数字/勾选仍右对齐成列（可用宽度恒定）。缺省（秘境）保持固定 66px，行为不变。
  const nameGrow = !!(fd && fd.nameGrow);
  // fd.costCol：数字输入列换成只读钻石价列（.pc-icost 红色，值取池项 cost）；行不再有意义可填的 max，
  //   mountItemList 的 .pc-imax 委托自然落空（查不到节点），无需额外闸门。
  const costCol = !!(fd && fd.costCol);
  const stockOf = fd && typeof fd.stockText === 'function' ? fd.stockText : null;
  const stockTitle = (fd && fd.stockTitle) || '全部商店里该商品剩余可买数量之和';
  const rows = arr
    .map((it) => {
      const key = String(it.id);
      const s = map[key];
      const cap = Math.max(0, Math.floor(Number(it.cap) || 0));
      let max = s && Number.isFinite(s.max) ? s.max : 0;
      if (cap > 0 && max > cap) max = cap; // 游戏自身上限抢先：超 cap 的旧存档值直接回落展示
      const label = it.label || key;
      // 两渠道可得性：置灰=渲染未勾+禁选（陈旧存储值不展示）；行灰化只看可用渠道
      const pickOff = !!it.pickDisabled;
      const on = pickOff ? false : s ? s.on !== 0 : true;
      const ch2Off = !!(ch2 && (ch2.disabledOf ? ch2.disabledOf(it) : it.channel2Disabled));
      const ch2On = ch2 && !ch2Off && s ? Number(s[ch2.key]) === 1 : false;
      const rowOff = pickOff && !ch2 ? !on : pickOff ? !ch2On : ch2 ? !on && !ch2On : !on;
      const mainChk =
        `<label class="pc-ichklbl pc-ichkpush" title="${pickOff ? '该物品无掉落来源，不可拾取' : '是否自动拾取'}">` +
        `<input type="checkbox" class="pc-ichk" data-ik="${escAttr(key)}"${on && !pickOff ? ' checked' : ''}${pickOff ? ' disabled' : ''}>` +
        `<span>${escAttr(ch2 ? ch2.aLabel || '拾' : '')}</span></label>`;
      const ch2Chk = ch2
        ? `<label class="pc-ichklbl pc-ichklbl2" title="${escAttr(ch2.title || '')}${ch2Off ? '（该项不走此渠道）' : ''}">` +
          `<input type="checkbox" class="pc-ichk2" data-ik="${escAttr(key)}" data-iflag="${escAttr(ch2.key)}"${ch2On ? ' checked' : ''}${ch2Off ? ' disabled' : ''}>` +
          `<span>${escAttr(ch2.label)}</span></label>`
        : '';
      const numCell = costCol
        ? Number(it.cost) > 0
          ? `<span class="pc-icost" title="单件钻石价">💎${Math.floor(Number(it.cost))}</span>`
          : '<span class="pc-icost pc-icostunk" title="单件钻石价（配置表尚未加载，暂不可知）">—</span>'
        : `<input type="number" class="pc-imax" data-ik="${escAttr(key)}" min="0" step="1"` +
          (cap > 0 ? ` max="${cap}" data-cap="${cap}"` : '') +
          ` value="${max > 0 ? max : ''}" placeholder="${cap > 0 ? cap : '无上限'}"` +
          ` title="${cap > 0 ? '目标持有量，0=补/拾到上限 ' + cap + '（超出会被自动修正）' : '目标持有量，0=无上限'}">` +
          (cap > 0
            ? `<span class="pc-icap" title="游戏自身持有上限 ${cap}，填写超出会被自动修正">≤${cap}</span>`
            : '');
      // 只读总数量列（值每次渲染现取，数据变化由 refreshTexts 就地回写，见上 JSDoc）
      const stockCell = stockOf
        ? `<span class="pc-fval pc-istock" data-fid="${escAttr(String(fid || ''))}" data-fkey="${escAttr(
            String((fd && fd.key) || ''),
          )}" data-istock="${escAttr(key)}" title="${escAttr(stockTitle)}">${escAttr(
            String(stockOf(key, it) || ''),
          )}</span>`
        : '';
      return (
        `<div class="pc-irow${rowOff ? ' pc-irowoff' : ''}" data-ikey="${escAttr(key)}">` +
        (sortable ? `<span class="pc-shandle" title="按住拖拽调整拾取优先级">⣿</span>` : '') +
        `<span class="pc-iname${nameGrow ? ' pc-namegrow' : ''}" title="${escAttr(label)}">${escAttr(label)}</span>` +
        numCell +
        stockCell +
        mainChk +
        ch2Chk +
        `</div>`
      );
    })
    .join('');
  return (
    `<div class="pc-ilisttop">` +
    `<span class="pc-rngtitle">${escAttr(fd.label || '物品清单')}</span>` +
    `<span class="pc-rnghint">${escAttr(
      fd.topHint ||
        (costCol
          ? stockOf
            ? '取消勾选=不抢；红色 💎 = 单件钻石价；末列 = 全部商店剩余之和'
            : '取消勾选=不抢；红色 💎 = 单件钻石价'
          : '取消勾选=不拾；数字=背包上限，0=无上限；行内 ≤N = 游戏自身上限'),
    )}</span>` +
    `</div>` +
    `<div class="pc-irows">${rows || '<div class="pc-rnghint">池为空</div>'}</div>` +
    // fd.summary：清单页脚一行汇总（fn(items,state,cfg)→string 或静态串），带 .pc-isummary 钩子。
    //   勾选变更整块重刷 → 实时；数字输入变更不重刷（防抢焦点），由 mountItemList 只回写本页脚文本（见 widgets.js）。
    //   汇总还随外部数据（快照/额度）变的 feat 由 refreshTexts 重算：故这里钉上 data-fid/data-fkey/data-isummary 三元钩子
    //   （不带 .pc-fval——那条 CSS 会把页脚改成右对齐的小字色，与本行的 pc-rnghint 版式冲突）。
    (fd && fd.summary
      ? `<div class="pc-rnghint pc-isummary" data-fid="${escAttr(String(fid || ''))}" data-fkey="${escAttr(
          String((fd && fd.key) || ''),
        )}"${typeof fd.summary === 'function' ? ' data-isummary="1"' : ''}>${escAttr(
          typeof fd.summary === 'function' ? fd.summary(arr, map, cfgForSummary) : fd.summary,
        )}</div>`
      : '') +
    (fd.hint ? `<div class="pc-rnghint">${escAttr(fd.hint)}</div>` : '')
  );
}

/**
 * 只读信息表格字段（type:'infogrid'）内层 HTML：标题行 + 列头 + 一行一条记录的固定列栅格。
 * 用于「状态摘要类」的多行只读信息（如密所列表：归属区 / 等级 / 状态 / 倒计时）：
 *   纯展示、无控件、不写配置，行集由 fd.rows(cfg) 每次渲染现取。
 * 排版靠**单个 CSS Grid**（行包 div 用 display:contents 把格子直接挂到父栅格）：所有行共用同一套列宽，
 *   故「一个密所一行、上下严格对齐」不依赖等宽字体（CJK 与数字混排时空格填充会错位，因而不走文本对齐）。
 * `fd.columns = [{label, title?, align?('right')}]`；`fd.rows = fn(cfg) → Array<Array<string|number>>`
 *   （内层按列下标取值，缺项出空串、多出列丢弃）。
 * 刷新：容器带 data-id/data-fkey，refreshTexts 走 refreshFieldBox 整块重刷（与首次渲染同一渲染器）。
 * @param {object} val 配置里的字段值（本类型不读，行集一律来自 fd.rows）
 * @param {object} fd 字段描述符（label / columns / rows / hint）
 * @param {object} c 整个 feature 配置（回传给 fd.rows）
 * @returns {string}
 */
function infoGridInnerHTML(val, fd, c) {
  void val;
  const cols = (fd && fd.columns) || [];
  const raw = fd && typeof fd.rows === 'function' ? fd.rows(c) : [];
  const cell = (col, i, txt, head) =>
    `<span class="pc-igcell pc-igc-${i}${col.align === 'right' ? ' pc-igright' : ''}${head ? ' pc-ighead-cell' : ''}"${col.title ? ` title="${escAttr(col.title)}"` : ''}>${escAttr(txt)}</span>`;
  const head =
    `<div class="pc-igrow pc-igrowhead">` +
    cols.map((col, i) => cell(col, i, col.label || '', true)).join('') +
    `</div>`;
  const rows = (Array.isArray(raw) ? raw : [])
    .map(
      (r) =>
        `<div class="pc-igrow">` +
        cols.map((col, i) => cell(col, i, r && r[i] != null ? String(r[i]) : '', false)).join('') +
        `</div>`,
    )
    .join('');
  return (
    `<div class="pc-ilisttop">` +
    `<span class="pc-rngtitle">${escAttr((fd && fd.label) || '状态')}</span>` +
    `</div>` +
    `<div class="pc-igraph" style="grid-template-columns:repeat(${Math.max(1, cols.length)},max-content)">` +
    head +
    (rows || '<div class="pc-ignone">暂无记录</div>') +
    `</div>` +
    (fd && fd.hint ? `<div class="pc-rnghint">${escAttr(fd.hint)}</div>` : '')
  );
}

/**
 * 怪物清单字段（type:'huntlist'，自动打野）内层 HTML：每种怪一行（行集由 fd.catalog 给出，可为每次渲染实时反查游戏表的 getter），逐行可编辑。
 * 列：怪物类型（来自 fd.catalog；906 搜怪行把 groupType/pointType/搜索等级 落 title 供校对，道具开营行（openItem）标「用求救信开营」）| 方式（select，选项随该行怪而变）|
 *     攻打数量（0=不限）| 已打（今日已打数量，只读，值由 fd.todayText(key) 提供）| ☑ 参与猎杀。行序恒等于本次渲染的 fd.catalog 下标，
 *     该行身份同时钉在 data-hkey 上（目录刷新重排后，委托靠 key 而非下标回写 configs[fid][fd.key]）。等级不入清单（野怪行派发时从游戏表运行时反查最高档，levelMode='dynamic'；其余行用 catalog.level 回退值），故无等级列。
 * 值以 list（按 key 匹配）为准，缺项回落该 catalog 行默认；list 与 catalog 顺序对齐由 wire 的 align 钩子逐 key 重建保证。
 * 改值（数字/下拉/勾选）由 wirePanel 面板级委托接，无结构性变化不整块重刷；「已打」随 ui.refresh 走 refreshTexts 重算（见 panel.js）。
 * @param {Array<object>} list 当前清单（configs[fid][fd.key]，行序对齐 catalog）
 * @param {object} fd 字段描述符（label / hint / todayText:(key)=>string / catalog:Array<{key,label,groupType,pointType,level,levelMode?,openItem,defaultCount,defaultMode,modes:Array<{value,label}>}>）
 * @param {string} fid 功能 id（「已打」只读格挂 data-fid 供 refreshTexts 回查）
 * @returns {string}
 */
export function huntListInnerHTML(list, fd, fid) {
  const catalog = fd.catalog || [];
  const stored = Array.isArray(list) ? list : [];
  const byKey = {};
  for (const r of stored) if (r && r.key) byKey[r.key] = r;
  const today = typeof fd.todayText === 'function' ? fd.todayText : () => '';
  const optsHTML = (modes, sel) =>
    (modes || [])
      .map(
        (o) =>
          `<option value="${escAttr(String(o.value))}"${String(o.value) === String(sel) ? ' selected' : ''}>${escAttr(String(o.label))}</option>`,
      )
      .join('');
  const head =
    `<div class="pc-hlrow pc-hlhead">` +
    `<span class="pc-hlname">怪物类型</span>` +
    `<span class="pc-hlmode">方式</span>` +
    `<span class="pc-hlcnt">数量</span>` +
    `<span class="pc-hldone">已打</span></div>`;
  const rows = catalog
    .map((mo, i) => {
      const r = byKey[mo.key] || {};
      const count0 = Number.isFinite(r.count) ? r.count | 0 : mo.defaultCount | 0;
      const countCap = Number.isFinite(mo.maxCount) && mo.maxCount > 0 ? mo.maxCount | 0 : 0;
      const count = countCap > 0 && count0 > countCap ? countCap : count0;
      const mode = r.mode != null ? r.mode : mo.defaultMode;
      const on = r.on === undefined ? !!mo.defaultOn : !!r.on;
      const title = mo.openItem
        ? `用求救信(${mo.openItem})开营 · 无每日上限`
        : `groupType ${mo.groupType} / pointType ${mo.pointType} / 搜索等级 ${mo.levelMode === 'dynamic' ? `动态反查(回退${mo.level})` : mo.level}`;
      return (
        `<div class="pc-hlrow" data-idx="${i}" data-hkey="${escAttr(String(mo.key))}">` +
        `<span class="pc-hlname" title="${escAttr(title)}"><span class="pc-hllabel">${escAttr(String(mo.label))}</span></span>` +
        `<select class="pc-hlmode pc-hlsel" data-part="mode" title="攻打方式">${optsHTML(mo.modes, mode)}</select>` +
        `<input type="number" class="pc-hlcnt pc-hln" data-part="count" min="0"${countCap > 0 ? ` max="${countCap}"` : ''} step="1" value="${count > 0 ? count : ''}" placeholder="${PLACEHOLDER_UNLIMITED}" title="攻打数量；留空 = 不限${countCap > 0 ? `（上限 ${countCap}）` : ''}">` +
        `<span class="pc-fval pc-hlstat" data-fid="${fid}" data-fkey="${fd.key}" data-hlstat="${escAttr(String(mo.key))}" title="今日已打数量">${escAttr(String(today(mo.key) || ''))}</span>` +
        `<input type="checkbox" class="pc-hlon pc-hlchk" data-part="on"${on ? ' checked' : ''} title="勾选=纳入猎杀范围">` +
        `</div>`
      );
    })
    .join('');
  return (
    `<div class="pc-hltop">` +
    `<span class="pc-rngtitle">${escAttr(fd.label || '怪物清单')}</span>` +
    `</div>` +
    head +
    (rows || '<div class="pc-rnghint">清单为空</div>') +
    (fd.hint ? `<div class="pc-rnghint">${escAttr(fd.hint)}</div>` : '')
  );
}

/**
 * 打野预设池字段（type:'presetpool'，自动打野）内层 HTML：动态增删的单选行，每行选一个战斗预设（1..max）。
 * 每个预设只能进一次：某行选中后，其它行的下拉自动剔除该值；删行/改选即回收。派发时按行序取第一个「能出兵」的预设。
 * 值落 configs[fid][fd.key] = number[]（有序、去重）；增删行与改选均需整块重刷（要重算其它行的可选项），交互走面板级委托。
 * @param {number[]} list 当前预设池（有序 number[]）
 * @param {object} fd 字段描述符（label / hint / max 预设号上限，缺省 8）
 * @returns {string}
 */
export function presetPoolInnerHTML(list, fd) {
  const max = Math.max(1, Math.floor(Number(fd.max) || 8));
  const arr = (Array.isArray(list) ? list : []).map((v) => Number(v) | 0);
  // 除本行外其它行占用的预设值集合（本行当前值不剔除，否则选中态无法回显）
  const usedElsewhere = (idx) => {
    const s = new Set();
    for (let i = 0; i < arr.length; i++) {
      if (i !== idx && arr[i] > 0) s.add(arr[i]);
    }
    return s;
  };
  const rows = arr
    .map((v, i) => {
      const taken = usedElsewhere(i);
      let opts = '';
      for (let n = 1; n <= max; n++) {
        if (taken.has(n) && n !== v) continue; // 被别的行占用且非本行当前值 → 剔除
        opts += `<option value="${n}"${n === v ? ' selected' : ''}>战斗预设 ${n}</option>`;
      }
      if (!opts) opts = `<option value="${v}" selected>战斗预设 ${v}</option>`; // 全占用的兜底（不该发生）
      return (
        `<div class="pc-pprow" data-idx="${i}">` +
        `<span class="pc-ppslot" title="出兵顺序">#${i + 1}</span>` +
        `<select class="pc-ppsel" title="该位的战斗预设">${opts}</select>` +
        `<button class="pc-ppdel" type="button" title="移出预设池">×</button>` +
        `</div>`
      );
    })
    .join('');
  const canAdd = arr.length < max;
  return (
    `<div class="pc-pptop">` +
    `<span class="pc-rngtitle">${escAttr(fd.label || '打野预设池')}</span>` +
    `<button class="pc-ppadd" type="button" title="添加一个预设位"${canAdd ? '' : ' disabled'}>＋</button>` +
    `</div>` +
    (rows || '<div class="pc-rnghint">未添加预设 = 不出兵；点＋添加，×移除</div>') +
    (fd.hint ? `<div class="pc-rnghint">${escAttr(fd.hint)}</div>` : '')
  );
}

/**
 * 联盟集结目标紧凑表（type:'rallygrid'）内层 HTML：一行一目标的多行表 [目标名][延迟入队(秒)输入][每日上限输入][今日已打文本][启用checkbox]，
 * 替代旧的「按 section 分段 + 一字段一行」布局（旧版每个目标占 4 行 × 3 段，压成 N 行+1 列表头）。
 * 行集不要求固定长度：fd.rows 可以是 getter（联盟集结的目标目录已改为运行时反查游戏表 + 推送自学习，行会随赛季增删），
 *   每格控件身份钉在自己的 key（delay.key / limit.key / count.key / enableKey）上，不依赖行下标。
 * 列头与数据行共用同一 5 列 CSS Grid（`.pc-rghead/.pc-rgrow` 用 display:contents 让子格直挂父栅格），列宽严格对齐。
 * 行内 delay/limit 子格的 min/step/zeroUnlimited/float 元数据挂在 r.delay / r.limit 上，wire.js 数字委托须按 rows 下探（同 tripick.parts 口径）。
 * count 只读格通过 data-fkey + r.count.get(cfg) 输出，refreshTexts 亦按此路径下探。
 * @param {object} fd 字段描述符 { key, cols: string[], rows: [{ name, enableKey, delay, limit, count }] }
 * @param {object} cfg 该功能当前配置
 * @param {string} fid 功能 id
 * @returns {string}
 */
export function rallyGridInnerHTML(fd, cfg, fid) {
  const cols = fd.cols || ['', '延迟入队(秒)', '每日上限', '今日已打', ''];
  const header =
    `<div class="pc-rghead">` +
    cols
      .map(
        (c, i) =>
          `<span class="pc-rgcell pc-rgc-${i}"${c ? '' : ' aria-hidden="true"'}>${c ? escAttr(c) : '&nbsp;'}</span>`,
      )
      .join('') +
    `</div>`;
  const rows = (fd.rows || [])
    .map((r) => {
      const delay = r.delay || {};
      const limit = r.limit || {};
      const count = r.count || {};
      const delayVal = cfg[delay.key];
      const limitVal = cfg[limit.key];
      const limitEmpty = limit.zeroUnlimited && (limitVal == null || Number(limitVal) === 0);
      const countText = count.get ? String(count.get(cfg) || '') : '';
      return (
        `<div class="pc-rgrow">` +
        `<span class="pc-rgcell pc-rgc-0" title="${escAttr(r.name || '')}">${escAttr(r.name || '')}</span>` +
        `<span class="pc-rgcell pc-rgc-1"><input type="number" class="pc-rgin" data-id="${fid}" data-key="${escAttr(delay.key)}" min="${delay.min != null ? delay.min : 0}" step="${delay.step != null ? delay.step : 1}" placeholder="${escAttr(delay.placeholder || '')}" value="${delayVal == null ? '' : delayVal}" title="${escAttr(delay.title || '延迟入队(秒)')}"></span>` +
        `<span class="pc-rgcell pc-rgc-2"><input type="number" class="pc-rgin" data-id="${fid}" data-key="${escAttr(limit.key)}" min="${limit.min != null ? limit.min : 0}" step="${limit.step != null ? limit.step : 1}" placeholder="${escAttr(limit.placeholder || (limit.zeroUnlimited ? PLACEHOLDER_UNLIMITED : ''))}" value="${limitEmpty ? '' : limitVal}" title="${escAttr(limit.title || (limit.zeroUnlimited ? '留空 = 不限' : '每日上限'))}"></span>` +
        `<span class="pc-rgcell pc-rgc-3"><span class="pc-fval pc-rgcount" data-fid="${fid}" data-fkey="${escAttr(count.key)}">${countText}</span></span>` +
        `<span class="pc-rgcell pc-rgc-4"><input type="checkbox" class="pc-fchk pc-rgchk" data-id="${fid}" data-key="${escAttr(r.enableKey)}"${cfg[r.enableKey] ? ' checked' : ''} title="勾选=自动加入${escAttr(r.name || '')}集结"></span>` +
        `</div>`
      );
    })
    .join('');
  return `<div class="pc-rg" data-id="${fid}" data-fkey="${escAttr(fd.key)}">${header}${rows}</div>`;
}

/**
 * 整行容器型字段（自带卡片内一层 div + 内层 HTML）的渲染表：type → { cls 容器类, render 内层生成器 }。
 *
 * 此前这 10 个分支逐字同形（`<div class="pc-xxx" data-id data-?key>` + `?InnerHTML(c[fd.key], fd, …)`），
 * 但容器属性名各取一套（data-rkey/mkey/mrkey/frkey/trkey/hlkey/ppkey/akey/skey/ikey），导致消费侧
 * 每接一种字段就要再抄一份「找容器→找 fd→重刷」的解析器（wire.js 曾经有 7 份）。
 * 内层 HTML 统一签名 `(val, fd, c, fid)`（各自只用得上前几个），新增一类容器只加一行。
 * 属性 schema（消费侧只认这两个名字，不要再为新字段发明 data-xxxkey）：
 *   容器 = `data-id`（功能 id）+ `data-fkey`（字段 key），所以下面各委托一律走 boxTarget + findFieldDescriptor；
 *   行 = `data-idx`（数组下标，见 idxOf）。
 *   行上的例外：按 key 而非下标索引的清单（sortlist 行 data-skey / itemlist 行 data-ikey）带的是**项 key**，
 *   因为其配置形状是 map（且拖拽序以 DOM 序为准），不强行套 data-idx。行下标可由 DOM 序推导，
 *   故 sortlist 行原先只写不读的 data-sidx 已删除（schema 里不留没有消费方的第三个口径）。
 * @type {Record<string, {cls:string, render:function}>}
 */
const FIELD_BOXES = {
  ranges: { cls: 'pc-rng', render: rangesInnerHTML },
  uidlist: { cls: 'pc-ulist', render: uidListInnerHTML },
  sortlist: {
    cls: 'pc-slist',
    render: (val, fd, c) => sortListInnerHTML(val, fd, fd.checkable ? c[fd.offKey] : undefined),
  },
  multiopts: { cls: 'pc-mopts', render: multiOptsInnerHTML },
  itemlist: {
    cls: 'pc-ilist',
    render: (val, fd, c, fid) =>
      itemListInnerHTML(fd.items, val, fd, fd.orderKey ? c[fd.orderKey] : null, c, fid),
  },
  infogrid: { cls: 'pc-igraphbox', render: (val, fd, c) => infoGridInnerHTML(val, fd, c) },
  minerules: { cls: 'pc-mrule', render: mineRulesInnerHTML },
  farmrules: { cls: 'pc-frule', render: farmRulesInnerHTML },
  timeranges: { cls: 'pc-trule', render: timeRangesInnerHTML },
  huntlist: { cls: 'pc-hl', render: (val, fd, c, fid) => huntListInnerHTML(val, fd, fid) },
  presetpool: { cls: 'pc-pp', render: presetPoolInnerHTML },
};

/**
 * 整行容器字段的外壳：统一带 data-id（功能 id）与 data-fkey（字段 key），供 fieldBoxTarget 反查。
 * @param {string} cls 容器类
 * @param {string} fid 功能 id
 * @param {string} key 字段 key
 * @param {string} inner 内层 HTML
 * @returns {string}
 */
function fieldBox(cls, fid, key, inner) {
  return `<div class="${cls}" data-id="${fid}" data-fkey="${escAttr(key)}">${inner}</div>`;
}

/**
 * 按 DOM 上的控件 key（data-key / data-fkey）反查 descriptor，单点口径。
 * 顶层 fd.key 命中即返回；否则按类型下探行内子控件（子控件的 key 才是存档键，与 fd.key 不同）：
 *   tripick → parts、ctrlrow → cells、rallygrid → rows 的 delay/limit/count。
 * 此前 wire.js（数字/下拉两处）与 panel.js（refreshTexts）各抄了一份下探逻辑，新增一类子控件就要三处跟改。
 * @param {object} f descriptor（含 fields）
 * @param {string|undefined} key DOM 上带的控件 key
 * @returns {object|null} 命中的（子）描述符，未命中 null
 */
export function findFieldDescriptor(f, key) {
  if (!f || !Array.isArray(f.fields) || key == null) return null;
  const top = f.fields.find((x) => x.key === key);
  if (top) return top;
  for (const x of f.fields) {
    if (x.type === 'tripick' || x.type === 'ctrlrow') {
      const sub = (x.parts || x.cells || []).find((p) => p.key === key);
      if (sub) return sub;
    } else if (x.type === 'rallygrid') {
      for (const r of x.rows || []) {
        for (const cell of [r.delay, r.limit, r.count]) {
          if (cell && cell.key === key) return cell;
        }
      }
    }
  }
  return null;
}

/**
 * 就地重刷一个容器型字段（.pc-rng / .pc-mopts / .pc-mrule / .pc-frule / .pc-trule …）的内层 HTML：
 * 靠外壳上的 data-id + data-fkey 反查 descriptor，再按 type 走 FIELD_BOXES 渲染表，
 * 与 buildFieldsHTML 首次渲染严格同源（同一 render、同一参数顺序）。
 * 有状态的清单（uidlist/sortlist/itemlist）不走这里，由 widgets.js 的 mount* 重刷并重绑。
 * @param {Element} box 带 data-id/data-fkey 的字段容器
 * @returns {boolean} 是否刷了（功能/字段查不到、类型不在渲染表时 false）
 */
export function refreshFieldBox(box) {
  if (!box || !box.dataset) return false;
  const f = findFeature(box.dataset.id);
  if (!f) return false;
  const fd = findFieldDescriptor(f, box.dataset.fkey);
  if (!fd) return false;
  const c = configs[f.id];
  const entry = FIELD_BOXES[fd.type];
  if (!c || !entry) return false;
  box.innerHTML = entry.render(c[fd.key], fd, c, f.id);
  return true;
}

// ───────────── 内联型控件族（type → 行 HTML 生成器，无外层 fieldBox 容器） ─────────────
// 阶段六注册表化：此前这些分支逐字硬编在 buildFieldsHTML 的 fieldHTML if 阶梯里，
// 新增一类内联字段就要改中央分发。现抽成同名 *render* 模块级函数并汇入 FIELD_INLINE 注册表，
// fieldHTML 只做「先查 FIELD_BOXES（容器型）→ 再查 FIELD_INLINE（内联型）→ 未命中落数字兜底」。
// 各函数体严格继承拆分前对应分支的输出与注释口径，签名统一 (fd, c, fid)（c=configs[fid]），零行为变化。

/** 开关行（type:'checkbox'）：label 接一枚 .pc-fchk，改动即存档由 wire 事件委托接 */
function renderCheckbox(fd, c, fid) {
  return (
    `<label class="pc-row"><span>${fd.label}</span>` +
    `<input type="checkbox" class="pc-fchk" data-id="${fid}" data-key="${fd.key}" ${c[fd.key] ? 'checked' : ''}></label>`
  );
}

/** 纯说明横幅（type:'note'）：无控件、不写配置、可无 key，靠 fd.section 出分组标题作分隔，正文渲染一行 muted 说明 */
function renderNote(fd) {
  return `<div class="pc-fnote">${fd.text ? escAttr(fd.text) : ''}</div>`;
}

/** 只读惰性求值文本（type:'text'）：值来自 fd.get(cfg)，随 refreshTexts 重算；三种排版变体（inline 双列 / 多行整列 / 单行） */
function renderText(fd, c, fid) {
  const v = fd.get ? String(fd.get(c)) : '';
  if (fd.multiline && fd.inline) {
    // 同行多行变体（如卡车「今日刷新 / 今日攻击」）：标签与值同一行、值靠右 pre-line 换行，顶对齐使首行与标签齐平
    return (
      `<div class="pc-row pc-rowtop"><span>${fd.label}</span>` +
      `<span class="pc-fval pc-fvalhl" data-fid="${fid}" data-fkey="${fd.key}">${v}</span></div>`
    );
  }
  if (fd.multiline) {
    // 多行只读值（如「今日进度」一长串统计）：标签在上、值整行，pre-line 保留 \n 换行不截断
    return (
      `<div class="pc-row pc-rowcol"><span>${fd.label}</span>` +
      `<span class="pc-fval pc-fvalml" data-fid="${fid}" data-fkey="${fd.key}">${v}</span></div>`
    );
  }
  return (
    `<label class="pc-row"><span>${fd.label}</span>` +
    `<span class="pc-fval" data-fid="${fid}" data-fkey="${fd.key}">${v}</span></label>`
  );
}

/** 单下拉（type:'select'）：fd.options 支持数组与函数（开面板时现形现扫配置表），选项现值 = String(c[fd.key]) */
function renderSelect(fd, c, fid) {
  const cur = String(c[fd.key]);
  // 与 multiOptsInnerHTML 同源口径：fd.options 既可以是数组也可以是函数（开面板时现形现扫配置表）。
  //   不先判类型直接 .map 会在游戏表未就绪时抛「(fd.options || []).map is not a function」。
  const opts = (typeof fd.options === 'function' ? fd.options(c) : fd.options) || [];
  const html = opts
    .map(
      (o) =>
        `<option value="${o.value}"${String(o.value) === cur ? ' selected' : ''}>${o.label}</option>`,
    )
    .join('');
  return (
    `<label class="pc-row"><span>${fd.label}</span>` +
    `<select class="pc-fsel" data-id="${fid}" data-key="${fd.key}">${html}</select></label>`
  );
}

/** 行内多下拉（type:'tripick'，如异能兽培育「派出的兽 [属相][品种][品质]」）：一个 label 接 N 个 select，每 part 自己一个 data-key */
function renderTriPick(fd, c, fid) {
  // 行内多下拉（如异能兽培育「派出的兽 [属相][品种][品质]」）：一个 label 接 N 个 select，
  //   每个 part 自己一个 data-key（= 存档键，与 field.key 不同）；渲染走本分支，change 与 syncControls
  //   虽复用 select.pc-fsel 的同一条 DOM 陆径，但 wire.js 侧查 descriptor 须按 part.key 下探 parts。
  //   选项支持数组与函数两种形式（同 select 口径，函数在装配时求值一次）。
  const cells = (fd.parts || [])
    .map((p) => {
      const cur = String(c[p.key]);
      const opts = (typeof p.options === 'function' ? p.options(c) : p.options) || [];
      const inner = opts
        .map(
          (o) =>
            `<option value="${o.value}"${String(o.value) === cur ? ' selected' : ''}>${o.label}</option>`,
        )
        .join('');
      const title = p.title ? ` title="${escAttr(p.title)}"` : '';
      return `<select class="pc-fsel pc-ftri" data-id="${fid}" data-key="${escAttr(p.key)}"${title}>${inner}</select>`;
    })
    .join('');
  return (
    `<label class="pc-row"><span class="pc-triolab">${fd.label}</span>` +
    `<span class="pc-trio">${cells}</span></label>`
  );
}

/** 一行多控件（type:'ctrlrow'，如惧星集结「等级▾ | 方式▾ | 预设队伍▾ | 今日已打」）：一个标签接 N 个控件；fd.table=true 走表格式排版 */
function renderCtrlRow(fd, c, fid) {
  // 一行多控件（如惧星集结「等级▾ | 方式▾ | 预设队伍▾ | 今日已打」）：一个标签接 N 个控件，
  //   每个 cell 自己一个 data-key（= 存档键，与 field.key 不同，同 tripick.parts 口径）。
  //   cell.type 只区分 'text'（只读值 .pc-fval，随 refreshTexts 重算）与否（下拉 .pc-fsel）；
  //   下拉选项支持数组与函数（同 select 口径），只读值取 cell.get(cfg)。
  // fd.table=true 时走表格式排版（与自动打野怪物清单同外观：表头行说明各列 + 表头/表身分隔线），
  //   控件类改用 .pc-hlmode/.pc-hlstat 与怪物清单对齐，但 data-key/data-fkey 不变→ wire/refreshTexts 同一条 ctrlrow.cells 通路。
  const table = !!fd.table;
  const cells = (fd.cells || [])
    .map((p) => {
      const title = p.title ? ` title="${escAttr(p.title)}"` : '';
      if (p.type === 'text') {
        const v = p.get ? String(p.get(c) || '') : '';
        const cls = table ? 'pc-fval pc-hlstat' : 'pc-fval pc-ftri';
        return `<span class="${cls}"${title} data-fid="${fid}" data-fkey="${escAttr(p.key)}">${v}</span>`;
      }
      const cur = String(c[p.key]);
      const opts = (typeof p.options === 'function' ? p.options(c) : p.options) || [];
      const inner = opts
        .map(
          (o) =>
            `<option value="${o.value}"${String(o.value) === cur ? ' selected' : ''}>${o.label}</option>`,
        )
        .join('');
      const cls = table ? 'pc-fsel pc-hlmode' : 'pc-fsel pc-ftri';
      return `<select class="${cls}" data-id="${fid}" data-key="${escAttr(p.key)}"${title}>${inner}</select>`;
    })
    .join('');
  if (table) {
    const n = (fd.cells || []).length;
    const cols = `style="grid-template-columns:repeat(${n},minmax(0,1fr))"`;
    const head =
      `<div class="pc-hlrow pc-hlhead" ${cols}>` +
      (fd.cells || [])
        .map((p) => `<span class="pc-cthd">${escAttr(String(p.label || ''))}</span>`)
        .join('') +
      `</div>`;
    return (
      `<div class="pc-hl pc-ct" data-id="${fid}" data-fkey="${escAttr(fd.key)}">` +
      (fd.label
        ? `<div class="pc-hltop"><span class="pc-rngtitle">${escAttr(fd.label)}</span></div>`
        : '') +
      head +
      `<div class="pc-hlrow" ${cols}>${cells}</div>` +
      `</div>`
    );
  }
  // fd.label 缺位时不出标签格（整行宽度给控件），行名交 section 小标题承担
  return (
    `<label class="pc-row">` +
    (fd.label ? `<span class="pc-triolab">${fd.label}</span>` : '') +
    `<span class="pc-trio">${cells}</span></label>`
  );
}

/** 可编辑文本（type:'string'，如城市技能目标 UID）：按字符串存档，change 时 trim 落盘 + 热更 */
function renderString(fd, c, fid) {
  return (
    `<label class="pc-row"><span>${fd.label}</span>` +
    `<input type="text" class="pc-fstr" data-id="${fid}" data-key="${fd.key}" placeholder="${escAttr(fd.placeholder)}" value="${escAttr(c[fd.key])}"></label>`
  );
}

/** UID 复合行（type:'uid'，城市技能）：显示态「✎ 玩家名」点击转输入态，失焦用 PLAYER_INFO(630) 反查名字 */
function renderUid(fd, c, fid) {
  // UID 复合行（城市技能）：显示态「✎ 玩家名」点击转输入态，失焦用 PLAYER_INFO(630) 反查名字。
  // 名字随 UID 一起持久化(fd.nameKey)，开面板直接显缓存名、零查询；仅 UID 变了才查。失败留框+红字不提交。
  const uidV = String(c[fd.key] || '');
  const nmV = String(c[fd.nameKey] || '');
  return (
    `<div class="pc-uidwrap" data-id="${fid}" data-ukey="${fd.key}" data-nkey="${fd.nameKey}" data-ekey="${fd.enableKey}">` +
    `<div class="pc-row"><span>${fd.label}</span>` +
    `<span class="pc-udisp" title="点击编辑 UID"><span class="pc-uedit">✎</span><span class="pc-uname">${escAttr(nmV || uidV)}</span></span>` +
    `<input type="text" class="pc-uinput" inputmode="numeric" hidden placeholder="${escAttr(fd.placeholder)}">` +
    `<input type="checkbox" class="pc-fchk" data-id="${fid}" data-key="${fd.enableKey}" ${c[fd.enableKey] ? 'checked' : ''}>` +
    `</div><div class="pc-uhint" hidden></div></div>`
  );
}

/** 动作按钮（type:'button'，如卡车拦截「刷新我方战力」）：整行一个 .pc-btn，点击回调 fd.onClick(cfg)，不写配置不触发折叠 */
function renderButton(fd, c, fid) {
  return `<button class="pc-btn pc-fbtn" type="button" data-id="${fid}" data-bkey="${fd.key}">${fd.label}</button>`;
}

/**
 * 数字字段兜底渲染器（type 未命中 FIELD_BOXES / FIELD_INLINE 任一注册表时走此）：
 * fd.zeroUnlimited 时把「0=无限」做成与自动打野攻打数量同款的交互——值为 0 渲染成空输入 + placeholder「不限」，
 * 靠 wire.js 数字委托在改值时对称回写（留空↔0）。此函数同时是「未登记 type」的默认出口，保持拆分前 if 阶梯末尾兜底语义。
 */
function renderNumber(fd, c, fid) {
  // 数字字段（默认兜底分支）：fd.zeroUnlimited 时把「0=无限」做成与自动打野攻打数量同款的交互——
  // 值为 0 渲染成空输入 + placeholder「不限」，靠 wire.js 数字委托在改值时对称回写（留空↔0）。
  if (fd.zeroUnlimited) {
    const raw = c[fd.key];
    const isZero = raw == null || Number(raw) === 0;
    return (
      `<label class="pc-row"><span>${fd.label}</span>` +
      `<input type="number" data-id="${fid}" data-key="${fd.key}" min="${fd.min}" step="${fd.step}" placeholder="${escAttr(fd.placeholder || PLACEHOLDER_UNLIMITED)}" value="${isZero ? '' : raw}" title="留空 = 不限"></label>`
    );
  }
  const v = c[fd.key];
  return (
    `<label class="pc-row"><span>${fd.label}</span>` +
    `<input type="number" data-id="${fid}" data-key="${fd.key}" min="${fd.min}" step="${fd.step}" placeholder="${escAttr(fd.placeholder || '')}" value="${v == null ? '' : v}"></label>`
  );
}

/**
 * 内联型字段的渲染表：type → render(fd, c, fid)。与 FIELD_BOXES（容器型，带 fieldBox 外壳）互补，
 * 二者共同构成 buildFieldsHTML 的完整分发面。新增一类内联字段 = 加一个 render* + 本表加一行，不再改中央 if 阶梯。
 * 未列入本表的 fd.type 一律落 renderNumber 兜底（数字输入即缺省控件），与拆分前 if 阶梯末尾兜底严格一致。
 * @type {Record<string, function>}
 */
const FIELD_INLINE = {
  checkbox: renderCheckbox,
  note: renderNote,
  text: renderText,
  select: renderSelect,
  tripick: renderTriPick,
  ctrlrow: renderCtrlRow,
  string: renderString,
  uid: renderUid,
  button: renderButton,
  rallygrid: (fd, c, fid) => rallyGridInnerHTML(fd, c, fid),
};

/**
 * descriptor fields -> 行 HTML（checkbox / text 只读惰性求值 / 数字输入 / 下拉 / 一行多控件 / 区间规则）。
 * fd.section 变化时插入分组小标题（如联盟集结按战锤/惧星/难民营分段），容器带 data-id=功能 id。
 * fd.showIf(cfg) 为假时该行不占位（只在行根打 data-dep，真实显隐由 refreshFieldVisibility 切 hidden）。
 * @param {string} fid 功能 id
 * @param {object} f descriptor
 * @returns {string}
 */
export function buildFieldsHTML(fid, f) {
  const c = configs[fid];
  // 单字段 → HTML（不含分组标题）；分组标题与可折叠包裹由下方循环统一处理。
  // 阶段六注册表化：分发不再硬编 if 阶梯，而是「容器型 FIELD_BOXES → 内联型 FIELD_INLINE → 数字兜底 renderNumber」三级查表。
  const fieldHTML = (fd) => {
    const box = FIELD_BOXES[fd.type];
    if (box) return fieldBox(box.cls, fid, fd.key, box.render(c[fd.key], fd, c, fid));
    const inline = FIELD_INLINE[fd.type];
    if (inline) return inline(fd, c, fid);
    return renderNumber(fd, c, fid);
  };
  let lastSection;
  let bodyOpen = false; // 当前是否有一个可折叠子分组的 body 处于打开（待闭合）状态
  const out = [];
  for (const fd of f.fields) {
    if (fd.section && fd.section !== lastSection) {
      if (bodyOpen) {
        out.push('</div>');
        bodyOpen = false;
      } // 闭合上一个折叠体
      if (fd.secCollapsible) {
        // 可折叠子分组（如卡车拦截「拦截判定」）：标题行带箭头可点，其后字段包进 .pc-fsec-body（secCollapsed 默认收起）
        const collapsed = !!fd.secCollapsed;
        out.push(
          `<div class="pc-fsec pc-fsectoggle${collapsed ? '' : ' open'}"><span class="pc-fsecchev">▶</span><span>${fd.section}</span></div>`,
        );
        out.push(`<div class="pc-fsec-body"${collapsed ? ' hidden' : ''}>`);
        bodyOpen = true;
      } else {
        out.push(`<div class="pc-fsec" data-sec="${escAttr(fd.section)}">${fd.section}</div>`);
      }
    }
    lastSection = fd.section || null;
    const html = fieldHTML(fd);
    // 条件字段（fd.showIf(cfg)）：不改 fieldHTML 各分支，只在行根补一个 data-dep 标记（值=字段 key，
    //   data-depfid=功能 id），显隐交 refreshFieldVisibility 就地切 hidden —— 不重建 DOM，已绑好的控件事件全部存活
    out.push(
      fd.showIf
        ? html.replace(
            /<([a-zA-Z][\w-]*)/,
            `<$1 data-dep="${escAttr(fd.key)}" data-depfid="${fid}"`,
          )
        : html,
    );
  }
  if (bodyOpen) out.push('</div>');
  return out.join('');
}
