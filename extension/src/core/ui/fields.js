// descriptor.fields[] → 面板行 HTML 的纯构建器族（无 DOM 绑定，只返回字符串）。
// 从 core/ui.js 迁出：cardHead / 各 *InnerHTML / buildFieldsHTML。值来自 registry.configs，转义走 dom.escAttr。
import { configs } from '../registry.js';
import { escAttr } from './dom.js';

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
        `<div class="pc-mrrow" data-midx="${i}">` +
        `<div class="pc-mrbox">` +
        `<select class="pc-mrsel pc-mrtype" data-part="type" title="矿种">${optsHTML(typeOpts, type)}</select>` +
        `<select class="pc-mrsel pc-mrlv" data-part="level" title="等级">${optsHTML(lvOpts, lv)}</select>` +
        `<span class="">星级</span>` +
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
 * 下田规则字段（type:'farmrules'，自动下田）内层 HTML：标题行（含右上＋）+ 若干田位行。
 * 每行一个盒子：田类型▾(金/粮/油/雷神) + 田等级▾(雷神上限 3 级、其余 1~6) + ☑只下机械 + 预设部队▾(1~16：1~8 战斗预设 / 9~16 采集预设) + × 删除。
 * 行存在即生效（已无行级开关）；family/level 会联动其它控件（雷神封顶 3 级、选 6 级田则禁用机械田），改动后整行重刷。
 * 选项均由 fd 提供（familyOptions/levelOptions/presetOptions）；行增删/改值由 wirePanel 事件委托接。
 * @param {Array<{family:number,level:number,mechOnly:boolean,preset:number}>} list 当前田位规则表
 * @param {object} fd 字段描述符（label / 各 Options / hint）
 * @returns {string}
 */
export function farmRulesInnerHTML(list, fd) {
  const optsHTML = (opts, sel) =>
    (opts || [])
      .map(
        (o) =>
          `<option value="${o.value}"${Number(o.value) === sel ? ' selected' : ''}>${escAttr(String(o.label))}</option>`,
      )
      .join('');
  const rows = (Array.isArray(list) ? list : [])
    .map((r, i) => {
      const fam = Number(r.family) || 7;
      const maxLv = fam === 16 ? 3 : 6; // 雷神矿田等级上限 3 级
      const lv = Math.min(maxLv, Math.max(1, Number(r.level) || 5));
      const levelOpts = (fd.levelOptions || []).filter((o) => Number(o.value) <= maxLv);
      const mechApplicable = lv < 6; // 6 级田没有机械田
      const mech = !!r.mechOnly && mechApplicable;
      return (
        `<div class="pc-frrow" data-fidx="${i}">` +
        `<div class="pc-frmain">` +
        `<div class="pc-frbox">` +
        `<select class="pc-frsel" data-part="family" title="田类型">${optsHTML(fd.familyOptions, fam)}</select>` +
        `<select class="pc-frsel" data-part="level" title="田等级（雷神上限 3 级；6 级田无机械田）">${optsHTML(levelOpts, lv)}</select>` +
        `<label class="pc-frmech${mechApplicable ? '' : ' pc-frmechdis'}" title="只下机械：勾选=只看机械田（没有则本行不下、不回退普通田）；不勾选=优先机械田、机械田没有才下普通田。6 级田没有机械田"><input type="checkbox" class="pc-frmechin" data-part="mechOnly"${mech ? ' checked' : ''}${mechApplicable ? '' : ' disabled'}><span>只下机械</span></label>` +
        `<span class="pc-frdiv" aria-hidden="true"></span>` +
        `<select class="pc-frsel" data-part="preset" title="预设部队（1~8 战斗 / 9~16 采集）">${optsHTML(fd.presetOptions, Number(r.preset) || 1)}</select>` +
        `</div>` +
        `<button class="pc-frdel" type="button" title="删除此田位">×</button>` +
        `</div></div>`
      );
    })
    .join('');
  return (
    `<div class="pc-fruletop">` +
    `<span class="pc-rngtitle">${escAttr(fd.label || '下田规则')}</span>` +
    `<button class="pc-fradd" type="button" title="添加一个田位">＋</button>` +
    `</div>` +
    (rows ||
      '<div class="pc-rnghint">未添加行 = 不下田；点＋添加的行即生效，同时会暂停总开关，配好后手动重新打开</div>') +
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
        `<div class="pc-trow" data-tidx="${i}">` +
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
 * 列头与数据行共用 rngRow 模板（括号类格子在列头只隐藏），否则三列无法逐列对齐；行号挂在 .pc-rngrow[data-ridx]，
 * 委托时靠它定位，不能用 querySelectorAll('.pc-rngrow') 的下标（会把列头行算进去，整体偏一位）。
 * @param {Array<{from:number,to:number,count:number}>} list 当前规则表
 * @param {object} fd 字段描述符（label / cols / hint 可选）
 * @returns {string}
 */
export function rangesInnerHTML(list, fd) {
  const cols = fd.cols || ['大于等于', '小于', '数值'];
  const rngRow = (cells, ridx) =>
    `<div class="pc-rngrow${ridx === undefined ? ' pc-rnghead' : ''}"` +
    (ridx === undefined ? '' : ` data-ridx="${ridx}"`) +
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
 * 每行是一个 .pc-uidwrap.pc-uli[data-uidx=i]（复用城市技能 UID 控件的视觉与显示↔输入态），行尾带 × 删除；
 * 与标量 UID 行的区别：值落在 configs[fid].friends[i].{uid,name}，故行不带 data-ukey/nkey，靠 data-uidx 定位。
 * 行的称呼名词由 fd.itemLabel 定制（玩家点赞缺省「好友」，奉旨出征为「执政官」）。
 * @param {Array<{uid:string, name:string}>} list 当前好友清单
 * @param {object} fd 字段描述符（label / max / placeholder / hint / itemLabel 可选；itemLabel 行的称呼名词，缺省「好友」）
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
      return (
        `<div class="pc-uidwrap pc-uli" data-uidx="${i}">` +
        `<div class="pc-row"><span>${item} ${i + 1}</span>` +
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
        `<div class="pc-srow${isOff ? ' pc-srowoff' : ''}" data-sidx="${i}" data-skey="${escAttr(String(id))}">` +
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
 * 物品清单项字段（type:'itemlist'）内层 HTML：标题行 + 若干 `[☑ 名称 [≤cap] [max]__]` 行 + hint。
 * 行不可增删（整池全员参与）；每行一枚 checkbox 控制该项是否参与 + 一个数字输入控制「背包持有上限」（0=不限）。
 * 状态 cfg[fd.key] 形如 `{ [idStr]: { on: 0|1, max: number } }`，未登记的项视为默认（on=1、max=0=不限）。
 * 池由 fd.items（数组或 fn(cfg)）提供，每项 `{id, label, cap?}`；id 可为字符串（如 'item:41009'）避免跨池数字碰撞。
 * `fd.sortable`（配 fd.orderKey）时每行行首多一个拖拽手柄 + 序号，展示序按 order 排（下标即优先级，越靠前越先拾）。
 * `cap>0` 表示游戏**自身已有一道硬上限**（如秘境道具的 ITEM.para1_v1）：行内标 `≤cap`、输入框带 max/data-cap，
 *   超过 cap 的值在渲染时就回落为 cap（与 mountItemList 的 change 修正同口径）。
 * @param {Array<{id:string|number,label:string,cap?:number}>|function(object):Array} items 池源
 * @param {object} state 当前配置对象（cfg[fd.key]）
 * @param {object} fd 字段描述符（label / hint / topHint / items / sortable / orderKey）
 * @param {Array<string>} [order] 拖拽序（cfg[fd.orderKey]），缺省按池原序展示
 * @returns {string}
 */
export function itemListInnerHTML(items, state, fd, order) {
  const arr = orderPoolItems(
    typeof items === 'function' ? items() : Array.isArray(items) ? items : [],
    order,
  );
  const map = state && typeof state === 'object' ? state : {};
  const sortable = !!(fd && fd.sortable);
  const rows = arr
    .map((it, i) => {
      const key = String(it.id);
      const s = map[key];
      const on = s ? s.on !== 0 : true;
      const cap = Math.max(0, Math.floor(Number(it.cap) || 0));
      let max = s && Number.isFinite(s.max) ? s.max : 0;
      if (cap > 0 && max > cap) max = cap; // 游戏自身上限抢先：超 cap 的旧存档值直接回落展示
      const label = it.label || key;
      return (
        `<div class="pc-irow${on ? '' : ' pc-irowoff'}" data-ikey="${escAttr(key)}">` +
        (sortable
          ? `<span class="pc-shandle" title="按住拖拽调整拾取优先级">⣿</span>` +
            `<span class="pc-irank">${i + 1}</span>`
          : '') +
        `<input type="checkbox" class="pc-ichk" data-ik="${escAttr(key)}"${on ? ' checked' : ''}>` +
        `<span class="pc-iname" title="${escAttr(label)}">${escAttr(label)}</span>` +
        (cap > 0
          ? `<span class="pc-icap" title="游戏自身持有上限 ${cap}，填写超出会被自动修正">≤${cap}</span>`
          : '') +
        `<input type="number" class="pc-imax" data-ik="${escAttr(key)}" min="0" step="1"` +
        (cap > 0 ? ` max="${cap}" data-cap="${cap}"` : '') +
        ` value="${max}" placeholder="${cap > 0 ? cap : '不限'}"` +
        ` title="${cap > 0 ? '背包上限，最大 ' + cap + '（0=跟随游戏上限）' : '背包上限，0=不限'}">` +
        `</div>`
      );
    })
    .join('');
  return (
    `<div class="pc-ilisttop">` +
    `<span class="pc-rngtitle">${escAttr(fd.label || '物品清单')}</span>` +
    `<span class="pc-rnghint">${escAttr(fd.topHint || '取消勾选=不拾；数字=背包上限，0=不限；行内 ≤N = 游戏自身上限')}</span>` +
    `</div>` +
    `<div class="pc-irows">${rows || '<div class="pc-rnghint">池为空</div>'}</div>` +
    (fd.hint ? `<div class="pc-rnghint">${escAttr(fd.hint)}</div>` : '')
  );
}

/**
 * 怪物清单字段（type:'huntlist'，自动打野）内层 HTML：固定行（每种怪一行、不可增删），逐行可编辑。
 * 列：怪物类型（来自 fd.catalog；906 搜怪行把 groupType/pointType/搜索等级 落 title 供校对，道具开营行（openItem）标「用求救信开营」）| 方式（select，选项随该行怪而变）|
 *     攻打数量（0=不限）| 已打（今日已打数量，只读，值由 fd.todayText(key) 提供）| ☑ 参与猎杀。行序恒等于 fd.catalog 下标，
 *     委托靠 data-hidx 定位回写 configs[fid][fd.key][hidx]。等级不入清单（固定搜该怪最高档），故无等级列。
 * 值以 list（按 key 匹配）为准，缺项回落该 catalog 行默认；list 与 catalog 顺序对齐由功能侧 defaults/归一保证（行不增删故下标稳定）。
 * 改值（数字/下拉/勾选）由 wirePanel 面板级委托接，无结构性变化不整块重刷；「已打」随 ui.refresh 走 refreshTexts 重算（见 panel.js）。
 * @param {Array<object>} list 当前清单（configs[fid][fd.key]，行序对齐 catalog）
 * @param {object} fd 字段描述符（label / hint / todayText:(key)=>string / catalog:Array<{key,label,groupType,pointType,level,openItem,defaultCount,defaultMode,modes:Array<{value,label}>}>）
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
        : `groupType ${mo.groupType} / pointType ${mo.pointType} / 搜索等级 ${mo.level}`;
      return (
        `<div class="pc-hlrow" data-hidx="${i}" data-hkey="${escAttr(String(mo.key))}">` +
        `<span class="pc-hlname" title="${escAttr(title)}"><span class="pc-hllabel">${escAttr(String(mo.label))}</span></span>` +
        `<select class="pc-hlmode pc-hlsel" data-part="mode" title="攻打方式">${optsHTML(mo.modes, mode)}</select>` +
        `<input type="number" class="pc-hlcnt pc-hln" data-part="count" min="0"${countCap > 0 ? ` max="${countCap}"` : ''} step="1" value="${count > 0 ? count : ''}" placeholder="不限" title="攻打数量；留空 = 不限${countCap > 0 ? `（上限 ${countCap}）` : ''}">` +
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
        `<div class="pc-pprow" data-pidx="${i}">` +
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
 * descriptor fields -> 行 HTML（checkbox / text 只读惰性求值 / 数字输入 / 下拉 / 区间规则）。
 * fd.section 变化时插入分组小标题（如联盟集结按战锤/惧星/难民营分段），容器带 data-id=功能 id。
 * fd.showIf(cfg) 为假时该行不占位（只在行根打 data-dep，真实显隐由 refreshFieldVisibility 切 hidden）。
 * @param {string} fid 功能 id
 * @param {object} f descriptor
 * @returns {string}
 */
export function buildFieldsHTML(fid, f) {
  const c = configs[fid];
  // 单字段 → HTML（不含分组标题）；分组标题与可折叠包裹由下方循环统一处理
  const fieldHTML = (fd) => {
    if (fd.type === 'checkbox') {
      return (
        `<label class="pc-row"><span>${fd.label}</span>` +
        `<input type="checkbox" class="pc-fchk" data-id="${fid}" data-key="${fd.key}" ${c[fd.key] ? 'checked' : ''}></label>`
      );
    }
    if (fd.type === 'text') {
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
    if (fd.type === 'select') {
      const cur = String(c[fd.key]);
      const opts = (fd.options || [])
        .map(
          (o) =>
            `<option value="${o.value}"${String(o.value) === cur ? ' selected' : ''}>${o.label}</option>`,
        )
        .join('');
      return (
        `<label class="pc-row"><span>${fd.label}</span>` +
        `<select class="pc-fsel" data-id="${fid}" data-key="${fd.key}">${opts}</select></label>`
      );
    }
    if (fd.type === 'string') {
      // 可编辑文本字段（如城市技能目标 UID）：按字符串存档，change 时 trim 落盘 + 热更
      return (
        `<label class="pc-row"><span>${fd.label}</span>` +
        `<input type="text" class="pc-fstr" data-id="${fid}" data-key="${fd.key}" placeholder="${escAttr(fd.placeholder)}" value="${escAttr(c[fd.key])}"></label>`
      );
    }
    if (fd.type === 'uid') {
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
    if (fd.type === 'ranges') {
      // 区间规则占整行（不套 pc-row）：容器带 fid/key，行内控件靠 closest('.pc-rng') 回属
      return (
        `<div class="pc-rng" data-id="${fid}" data-rkey="${fd.key}">` +
        rangesInnerHTML(c[fd.key], fd) +
        `</div>`
      );
    }
    if (fd.type === 'uidlist') {
      // 好友清单（玩家点赞）：动态增删的 UID 行，整行返回（不套 pc-row），容器带 fid/key 供 mountUidList 重绑
      return (
        `<div class="pc-ulist" data-id="${fid}" data-akey="${fd.key}">` +
        uidListInnerHTML(c[fd.key], fd) +
        `</div>`
      );
    }
    if (fd.type === 'sortlist') {
      // 领取优先级清单（遗迹奖励/卡车目标物品）：整池奖励行不可增删只能拖拽调序，容器带 fid/key 供 mountSortList 重刷+重绑
      return (
        `<div class="pc-slist" data-id="${fid}" data-skey="${fd.key}">` +
        sortListInnerHTML(c[fd.key], fd, fd.checkable ? c[fd.offKey] : undefined) +
        `</div>`
      );
    }
    if (fd.type === 'multiopts') {
      // 多选开关组（次元矿洞矿种/卡车品级）：整行返回，选项由 fd.options(cfg) 动态求值
      return (
        `<div class="pc-mopts" data-id="${fid}" data-mkey="${fd.key}">` +
        multiOptsInnerHTML(c[fd.key], fd, c) +
        `</div>`
      );
    }
    if (fd.type === 'itemlist') {
      // 物品清单（秘境拾取等）：整池行不可增删，每行 `[☑] 名称 [max]`，容器带 fid/key 供 mountItemList 重刷+重绑
      return (
        `<div class="pc-ilist" data-id="${fid}" data-ikey="${fd.key}">` +
        itemListInnerHTML(fd.items, c[fd.key], fd, fd.orderKey ? c[fd.orderKey] : null) +
        `</div>`
      );
    }
    if (fd.type === 'minerules') {
      // 采集规则（次元矿洞）：整行返回（不套 pc-row），行可增删，容器带 fid/key 供委托与重刷
      return (
        `<div class="pc-mrule" data-id="${fid}" data-mrkey="${fd.key}">` +
        mineRulesInnerHTML(c[fd.key], fd, c) +
        `</div>`
      );
    }
    if (fd.type === 'farmrules') {
      // 下田规则（自动下田）：整行返回，田位行可增删，容器带 fid/key 供委托与重刷（同 minerules）
      return (
        `<div class="pc-frule" data-id="${fid}" data-frkey="${fd.key}">` +
        farmRulesInnerHTML(c[fd.key], fd) +
        `</div>`
      );
    }
    if (fd.type === 'timeranges') {
      // 下田时段（自动下田）：整行返回，时段行可增删（原生 time 控件），容器带 fid/key 供委托与重刷（同 ranges/farmrules）
      return (
        `<div class="pc-trule" data-id="${fid}" data-trkey="${fd.key}">` +
        timeRangesInnerHTML(c[fd.key], fd) +
        `</div>`
      );
    }
    if (fd.type === 'huntlist') {
      // 怪物清单（自动打野）：固定行不可增删、逐行可编辑，容器带 fid/key 供面板级委托回写
      return (
        `<div class="pc-hl" data-id="${fid}" data-hlkey="${fd.key}">` +
        huntListInnerHTML(c[fd.key], fd, fid) +
        `</div>`
      );
    }
    if (fd.type === 'presetpool') {
      // 打野预设池（自动打野）：动态增删的单选行（跨行去重），容器带 fid/key 供委托与整块重刷
      return (
        `<div class="pc-pp" data-id="${fid}" data-ppkey="${fd.key}">` +
        presetPoolInnerHTML(c[fd.key], fd) +
        `</div>`
      );
    }
    if (fd.type === 'button') {
      // 动作按钮（如卡车拦截「刷新我方战力」）：整行一个 .pc-btn，点击回调 fd.onClick(cfg)，不写配置不触发折叠
      return `<button class="pc-btn pc-fbtn" type="button" data-id="${fid}" data-bkey="${fd.key}">${fd.label}</button>`;
    }
    // 数字字段（默认兜底分支）：fd.zeroUnlimited 时把「0=无限」做成与自动打野攻打数量同款的交互——
    // 值为 0 渲染成空输入 + placeholder「不限」，靠 wire.js 数字委托在改值时对称回写（留空↔0）。
    if (fd.zeroUnlimited) {
      const raw = c[fd.key];
      const isZero = raw == null || Number(raw) === 0;
      return (
        `<label class="pc-row"><span>${fd.label}</span>` +
        `<input type="number" data-id="${fid}" data-key="${fd.key}" min="${fd.min}" step="${fd.step}" placeholder="${escAttr(fd.placeholder || '不限')}" value="${isZero ? '' : raw}" title="留空 = 不限"></label>`
      );
    }
    return (
      `<label class="pc-row"><span>${fd.label}</span>` +
      `<input type="number" data-id="${fid}" data-key="${fd.key}" min="${fd.min}" step="${fd.step}" placeholder="${escAttr(fd.placeholder || '')}" value="${c[fd.key]}"></label>`
    );
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
