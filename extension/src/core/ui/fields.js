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
 * 物品清单项字段（type:'itemlist'）内层 HTML：标题行 + 若干 `[☑ 名称 [≤cap] [max]__]` 行 + hint。
 * 行不可增删（整池全员参与）；每行一枚 checkbox 控制该项是否参与 + 一个数字输入控制「背包持有上限」（0=不限）。
 * 状态 cfg[fd.key] 形如 `{ [idStr]: { on: 0|1, max: number } }`，未登记的项视为默认（on=1、max=0=不限）。
 * 池由 fd.items（数组或 fn(cfg)）提供，每项 `{id, label, cap?}`；id 可为字符串（如 'item:41009'）避免跨池数字碰撞。
 * `cap>0` 表示游戏**自身已有一道硬上限**（如秘境道具的 ITEM.para1_v1）：行内标 `≤cap`、输入框带 max/data-cap，
 *   超过 cap 的值在渲染时就回落为 cap（与 mountItemList 的 change 修正同口径）。
 * @param {Array<{id:string|number,label:string,cap?:number}>|function(object):Array} items 池源
 * @param {object} state 当前配置对象（cfg[fd.key]）
 * @param {object} fd 字段描述符（label / hint / topHint / items）
 * @returns {string}
 */
export function itemListInnerHTML(items, state, fd) {
  const arr = typeof items === 'function' ? items() : Array.isArray(items) ? items : [];
  const map = state && typeof state === 'object' ? state : {};
  const rows = arr
    .map((it) => {
      const key = String(it.id);
      const s = map[key];
      const on = s ? s.on !== 0 : true;
      const cap = Math.max(0, Math.floor(Number(it.cap) || 0));
      let max = s && Number.isFinite(s.max) ? s.max : 0;
      if (cap > 0 && max > cap) max = cap; // 游戏自身上限抢先：超 cap 的旧存档值直接回落展示
      const label = it.label || key;
      return (
        `<div class="pc-irow${on ? '' : ' pc-irowoff'}" data-ikey="${escAttr(key)}">` +
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
      // 物品清单项（秘境拾取等）：整池行不可增删，每行 `[☑] 名称 [max]`，容器带 fid/key 供 mountItemList 重刷+重绑
      return (
        `<div class="pc-ilist" data-id="${fid}" data-ikey="${fd.key}">` +
        itemListInnerHTML(fd.items, c[fd.key], fd) +
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
    if (fd.type === 'button') {
      // 动作按钮（如卡车拦截「刷新我方战力」）：整行一个 .pc-btn，点击回调 fd.onClick(cfg)，不写配置不触发折叠
      return `<button class="pc-btn pc-fbtn" type="button" data-id="${fid}" data-bkey="${fd.key}">${fd.label}</button>`;
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
