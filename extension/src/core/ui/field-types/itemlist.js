/**
 * 物品清单字段类型 module（type:'itemlist'，秘境拾取 / 矿区盗采 / 密所抢购）。
 *
 * T5（架构审查候选 1 · Option A 全量收编）：render 迁自 fields.js itemListInnerHTML（连同 orderPoolItems helper），
 * 有状态装配迁自 widgets.js mountItemList（该文件 T5 退役）。整行拖拽走共享 row-drag.attachRowDrag。
 * 勾选/数字/拖拽有闭包态，保留 mount* 直接绑定（决策 §3.4 / §8）；save/apply 收口 ctx.commit。
 * 只读格（istock 总数量 / ibought 已抢）经 refreshText 钩子就地改文本（panel.refreshTexts 硬编分支 T5 退役）。
 * assemble（首次装配 / 卡重建重绑）与 sync（降级补载回写）同源 mountItemList（入口即整块重刷 + 重绑）。
 *
 * 依赖面 = dom（escAttr/findFieldDescriptor）+ row-drag（attachRowDrag）+ registry（configs/findFeature）+ ctx。
 */
import { escAttr, findFieldDescriptor } from '../dom.js';
import { configs, findFeature } from '../../registry.js';
import { attachRowDrag, attachRowMove } from './row-drag.js';

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
 *   或 `fd.costCol` 时把那个数字输入换成**只读的红色钻石价列**；`fd.maxCol` 可让数字输入与价列**共存**
 *   （抢购类的「本期总上限」分配旋钮，如密所逐商品 cap）。
 * `fd.boughtText(key, item)` 存在时在输入列之前多一枚**只读已抢列**（.pc-ibought，如密所「该商品本期已抢购次数」），
 *   与 `fd.stockText` 同一通路——挂 .pc-fval + data-ibought，由 refreshTexts 就地改文本，绝不整块重刷。
 * `fd.stockText(key, item)` 存在时在输入列之后多一枚**只读总数量列**（.pc-istock，如密所「全部商店该商品剩余之和」）：
 *   它是「随数据变、但不重建行」的格，故与怪物清单「已打」同一通路——挂 .pc-fval + data-istock，由 refreshTexts 就地改文本，
 *   绝不走 refreshFieldBox（那会 innerHTML 覆盖整块、把 mountItemList 绑好的拖拽/勾选监听全拆掉）。
 * 状态 cfg[fd.key] 形如 `{ [idStr]: { on: 0|1, [numKey]: number } }`，未登记的项视为默认（on=1、数值=0；
 *   `fd.defaultOff` 时默认 on=0=不勾，供白名单「全不勾=不过滤/全领」语义）。`fd.hideNumCol` 隐藏数字输入列（只勾选、无数量语义）。
 *   数值列的键由 `fd.numKey` 指定（缺省 'max'=目标持有量/上限；矿区盗采/协助用 'min'=最低量门槛），
 *   列标题/占位/悬停用 `fd.numTitle`/`fd.numPlaceholder`/`head.num`（各自回退旧的 maxTitle/maxPlaceholder/head.max）。
 * 池由 fd.items（数组或 fn(cfg)）提供，每项 `{id, label, cap?, pickDisabled?, channel2Disabled?}`；id 可为字符串（如 'item:41009'）避免跨池数字碰撞。
 * `fd.channel2`（`{key,label,aLabel?,title?,disabledOf?(item)}`）存在时行尾多一枚**第二渠道勾选**（class `.pc-ichk2`，回写 `state[key][ch2.key]`），
 *   用于「同一实体多渠道」的清单（如秘境持有清单：on=拾取渠道、shop=商店补货渠道，两渠道共用一个目标持有量 max）；
 *   两渠道各自可置灰：主勾选看池项 `pickDisabled`（如仅商店在售、无掉落来源的道具不可拾），第二渠道经 `ch2.disabledOf`（缺省看 `item.channel2Disabled`）；
 *   置灰的勾选渲染为未勾+禁选（存储里的陈旧值不生效也不展示）。行灰化（pc-irowoff）在可用渠道全部关时才生效。
 *   排版：[拖拽手柄][序号] [主勾选] [名称(+≤cap 角标)] [数字输入] [第二渠道勾选]（数量紧跟名称、渠道勾选居右成列）。
 * `fd.sortable`（配 fd.orderKey）时每行行首多一个拖拽手柄 + 序号，展示序按 order 排（下标即优先级，越靠前越先拾）。
 * `fd.chkTitle` 定制主勾选的 title（缺省「是否自动拾取」；非拾取用途的清单——如矿区盗采/协助——必须覆盖，避免误导）。
 * `cap>0` 表示游戏**自身已有一道硬上限**（如秘境道具的 ITEM.para1_v1）：行内标 `≤cap`、输入框带 max/data-cap，
 *   超过 cap 的值在渲染时就回落为 cap（与 mountItemList 的 change 修正同口径）。
 * @param {Array<{id:string|number,label:string,cap?:number,pickDisabled?:boolean,channel2Disabled?:boolean,cost?:number}>|function(object):Array} items 池源
 * @param {object} state 当前配置对象（cfg[fd.key]）
 * @param {object} fd 字段描述符（label / hint / topHint / head / items / sortable / orderKey / channel2 / nameGrow / costCol / maxCol / numKey / numTitle / numPlaceholder / maxTitle / maxPlaceholder / chkTitle / boughtText / boughtTitle / stockText / stockTitle / summary）
 * @param {Array<string>} [order] 拖拽序（cfg[fd.orderKey]），缺省按池原序展示
 * @param {object} [cfgForSummary] 该 feature 的整个配置对象（仅当 `fd.summary` 为 fn 时作为第三参回传，供汇总读到其他字段）
 * @param {string} [fid] 功能 id（只读格挂 data-fid 供 refreshTexts 回查 descriptor，与 huntListInnerHTML 同口径）
 * @returns {string}
 */
function itemListInnerHTML(items, state, fd, order, cfgForSummary, fid) {
  const arr = orderPoolItems(
    typeof items === 'function' ? items() : Array.isArray(items) ? items : [],
    order,
  );
  const map = state && typeof state === 'object' ? state : {};
  const sortable = !!(fd && fd.sortable);
  const ch2 = fd && fd.channel2;
  // fd.nameGrow：名称列改为弹性填充（flex:1 1 auto）而非固定 66px——长物品名（如密所带钻石价的行）不再被截断，
  //   且各行的数字/勾选仍对齐成列（价左对齐、数量居中；可用宽度恒定）。缺省（秘境）保持固定 66px，行为不变。
  const nameGrow = !!(fd && fd.nameGrow);
  // fd.costCol：数字输入列换成只读钻石价列（.pc-icost 红色，值取池项 cost）；fd.maxCol 时输入列复活与价列共存
  //   （.pc-imax 委托照旧生效）；缺省 maxCol 时行内无输入节点，委托自然落空，无需额外闸门。
  const costCol = !!(fd && fd.costCol);
  const maxCol = !!(fd && fd.maxCol);
  // fd.defaultOff：未登记项默认**不勾**（on=0）而非默认勾（on=1）——白名单类「全不勾=全领/不过滤」语义用；
  //   缺省 false 保持既有清单（秘境/矿区/密所）默认全勾行为不变。
  const defaultOff = !!(fd && fd.defaultOff);
  // fd.hideNumCol：隐藏数字输入列（白名单只勾选、无目标数量语义时用）；与 costCol/maxCol 正交，缺省 false 行为不变。
  const hideNumCol = !!(fd && fd.hideNumCol);
  // 数值列的键（缺省 'max'）：矿区盗采/协助用 'min' 表「最低量门槛」，与持有量/上限语义区分
  const numKey = (fd && fd.numKey) || 'max';
  const boughtOf = fd && typeof fd.boughtText === 'function' ? fd.boughtText : null;
  const boughtTitle = (fd && fd.boughtTitle) || '该商品本期已抢购次数';
  const stockOf = fd && typeof fd.stockText === 'function' ? fd.stockText : null;
  const stockTitle = (fd && fd.stockTitle) || '全部商店里该商品剩余可买数量之和';
  const total = arr.length;
  const rows = arr
    .map((it, idx) => {
      const key = String(it.id);
      const s = map[key];
      const cap = Math.max(0, Math.floor(Number(it.cap) || 0));
      let num = s && Number.isFinite(s[numKey]) ? s[numKey] : 0;
      if (cap > 0 && num > cap) num = cap; // 游戏自身上限抢先：超 cap 的旧存档值直接回落展示
      const label = it.label || key;
      // 两渠道可得性：置灰=渲染未勾+禁选（陈旧存储值不展示）；行灰化只看可用渠道
      const pickOff = !!it.pickDisabled;
      const on = pickOff ? false : s ? s.on !== 0 : !defaultOff;
      const ch2Off = !!(ch2 && (ch2.disabledOf ? ch2.disabledOf(it) : it.channel2Disabled));
      const ch2On = ch2 && !ch2Off && s ? Number(s[ch2.key]) === 1 : false;
      const rowOff = pickOff && !ch2 ? !on : pickOff ? !ch2On : ch2 ? !on && !ch2On : !on;
      const mainChk =
        `<label class="pc-ichklbl pc-ichkpush" title="${pickOff ? '该物品无掉落来源，不可拾取' : escAttr((fd && fd.chkTitle) || '是否自动拾取')}">` +
        `<input type="checkbox" class="pc-ichk" data-ik="${escAttr(key)}"${on && !pickOff ? ' checked' : ''}${pickOff ? ' disabled' : ''}>` +
        `<span>${escAttr(ch2 ? ch2.aLabel || '拾' : '')}</span></label>`;
      const ch2Chk = ch2
        ? `<label class="pc-ichklbl pc-ichklbl2" title="${escAttr(ch2.title || '')}${ch2Off ? '（该项不走此渠道）' : ''}">` +
          `<input type="checkbox" class="pc-ichk2" data-ik="${escAttr(key)}" data-iflag="${escAttr(ch2.key)}"${ch2On ? ' checked' : ''}${ch2Off ? ' disabled' : ''}>` +
          `<span>${escAttr(ch2.label)}</span></label>`
        : '';
      // 价列纯红数字、不带图标（2026-11-12 用户决策：💎 emoji 染不红、◆ 亦弃），红色本身即钻石语义
      const costCell = costCol
        ? Number(it.cost) > 0
          ? `<span class="pc-icost" title="单件钻石价">${Math.floor(Number(it.cost))}</span>`
          : '<span class="pc-icost pc-icostunk" title="单件钻石价（配置表尚未加载，暂不可知）">—</span>'
        : '';
      const inputCell =
        (!costCol || maxCol) && !hideNumCol
          ? `<input type="number" class="pc-imax${maxCol ? ' pc-imaxcap' : ''}" data-ik="${escAttr(key)}" min="0" step="1"` +
            (cap > 0 ? ` max="${cap}" data-cap="${cap}"` : '') +
            ` value="${num > 0 ? num : ''}" placeholder="${cap > 0 ? cap : (fd && (fd.numPlaceholder || fd.maxPlaceholder)) || '无上限'}"` +
            ` title="${escAttr(
              (fd && (fd.numTitle || fd.maxTitle)) ||
                (cap > 0
                  ? '目标持有量，0=补/拾到上限 ' + cap + '（超出会被自动修正）'
                  : '目标持有量，0=无上限'),
            )}">` +
            (cap > 0
              ? `<span class="pc-icap" title="游戏自身持有上限 ${cap}，填写超出会被自动修正">≤${cap}</span>`
              : '')
          : '';
      // 只读已抢列（值每次渲染现取，数据变化由 refreshTexts 就地回写，与 stockText 同通路）
      const boughtCell = boughtOf
        ? `<span class="pc-fval pc-ibought" data-fid="${escAttr(String(fid || ''))}" data-fkey="${escAttr(
            String((fd && fd.key) || ''),
          )}" data-ibought="${escAttr(key)}" title="${escAttr(boughtTitle)}">${escAttr(
            String(boughtOf(key, it) || ''),
          )}</span>`
        : '';
      // 只读总数量列（值每次渲染现取，数据变化由 refreshTexts 就地回写，见上 JSDoc）
      const stockCell = stockOf
        ? `<span class="pc-fval pc-istock" data-fid="${escAttr(String(fid || ''))}" data-fkey="${escAttr(
            String((fd && fd.key) || ''),
          )}" data-istock="${escAttr(key)}" title="${escAttr(stockTitle)}">${escAttr(
            String(stockOf(key, it) || ''),
          )}</span>`
        : '';
      // ↑↓ 按钮（仅可排序清单）：拖拽之外的单指针/键盘等价替代（2.5.7）；首行无上、末行无下
      const mv = sortable
        ? `<span class="pc-rmvgrp">` +
          `<button type="button" class="pc-rmv pc-rmv-up" aria-label="上移「${escAttr(label)}」"${idx === 0 ? ' disabled' : ''}>↑</button>` +
          `<button type="button" class="pc-rmv pc-rmv-down" aria-label="下移「${escAttr(label)}」"${idx === total - 1 ? ' disabled' : ''}>↓</button>` +
          `</span>`
        : '';
      return (
        `<div class="pc-irow${rowOff ? ' pc-irowoff' : ''}" data-ikey="${escAttr(key)}">` +
        (sortable ? `<span class="pc-shandle" title="按住拖拽调整拾取优先级">⣿</span>` : '') +
        `<span class="pc-iname${nameGrow ? ' pc-namegrow' : ''}" title="${escAttr(label)}">${escAttr(label)}</span>` +
        costCell +
        boughtCell +
        inputCell +
        stockCell +
        mainChk +
        ch2Chk +
        mv +
        `</div>`
      );
    })
    .join('');
  // fd.head：表头行（{name,cost,bought,max,stock} 各列文案，缺省有默认词；二渠道列直接用 ch2.label；勾选列/↑↓列只占位不出标题）。
  //   与数据行共用 .pc-irow 骨架 + 逐列同类名 → 像素级对齐（ranges 表头同款教训：另写一套列宽必错位）；
  //   放在 .pc-irows 外：renderRows 整块重画只换数据行不抹表头；不挂 data-ikey/data-ibought 钩子，拖拽/刷新逻辑不认它
  const head = fd && fd.head;
  const headHtml = head
    ? `<div class="pc-irow pc-ihead">` +
      (sortable ? '<span class="pc-shandle"></span>' : '') +
      `<span class="pc-iname${nameGrow ? ' pc-namegrow' : ''}">${escAttr(head.name || '物品')}</span>` +
      (costCol ? `<span class="pc-icost">${escAttr(head.cost || '单价')}</span>` : '') +
      (boughtOf
        ? `<span class="pc-fval pc-ibought" title="${escAttr(boughtTitle)}">${escAttr(head.bought || '已抢')}</span>`
        : '') +
      ((!costCol || maxCol) && !hideNumCol
        ? `<span class="pc-imax${maxCol ? ' pc-imaxcap' : ''}" title="${escAttr((fd && (fd.numTitle || fd.maxTitle)) || '')}">${escAttr(head.num || head.max || '上限')}</span>`
        : '') +
      (stockOf
        ? `<span class="pc-fval pc-istock" title="${escAttr(stockTitle)}">${escAttr(head.stock || '剩余')}</span>`
        : '') +
      // 勾选列占位须与数据行 label 同宽（隐藏 checkbox + 同款 span 文案），不出表头词——
      //   否则名称 flex 列在表头/数据行差几 px，后面所有固定列跟着错位
      `<span class="pc-ichklbl pc-ichkpush"><input type="checkbox" class="pc-ichk" disabled style="visibility:hidden"><span>${escAttr(ch2 ? ch2.aLabel || '拾' : '')}</span></span>` +
      (ch2
        ? `<span class="pc-ichklbl pc-ichklbl2"><input type="checkbox" class="pc-ichk2" disabled style="visibility:hidden"><span>${escAttr(ch2.label)}</span></span>`
        : '') +
      // ↑↓ 列占位须与数据行 .pc-rmvgrp 同宽（两枚同款隐藏按钮）：否则名称 flex 列在表头
      //   宽出整组按钮宽，后面所有固定列跟着右移错位（勾选列占位同款教训）；表头在 .pc-irows 外，不会被拖拽/移动绑定认作行内按钮
      (sortable
        ? `<span class="pc-rmvgrp"><button type="button" class="pc-rmv" disabled style="visibility:hidden">↑</button><button type="button" class="pc-rmv" disabled style="visibility:hidden">↓</button></span>`
        : '') +
      `</div>`
    : '';
  return (
    `<div class="pc-ilisttop">` +
    `<span class="pc-rngtitle">${escAttr(fd.label || '物品清单')}</span>` +
    `<span class="pc-rnghint">${escAttr(
      fd.topHint ||
        (costCol
          ? stockOf
            ? '取消勾选=不抢；红色数字 = 单件钻石价；末列 = 全部商店剩余之和'
            : '取消勾选=不抢；红色数字 = 单件钻石价'
          : hideNumCol
            ? '取消勾选=不拾'
            : '取消勾选=不拾；数字=背包上限，0=无上限；行内 ≤N = 游戏自身上限'),
    )}</span>` +
    `</div>` +
    headHtml +
    `<div class="pc-irows">${rows || '<div class="pc-rnghint">池为空</div>'}</div>` +
    // fd.summary：清单页脚一行汇总（fn(items,state,cfg)→string 或静态串），带 .pc-isummary 钩子。
    //   勾选变更整块重刷 → 实时；数字输入变更不重刷（防抢焦点），由 mountItemList 只回写本页脚文本（见 refreshSummary）。
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
 * 装配物品清单容器（.pc-ilist）：行不可增删，每行一枚 checkbox + 一个数字输入；`fd.sortable` 时行首多一个拖拽手柄。
 * `fd.costCol` 时那个数字输入换成只读钻石价列（.pc-icost）：下方 .pc-imax 委托自然查不到节点，无需额外闸门；
 *   `fd.maxCol` 可让输入与价列共存（委托照旧生效，如密所「本期总上限」旋钮）。
 * 状态形状：`cfg[fd.key] = { [idStr]: { on: 0|1, [numKey]: number, [channel2.key]?: 0|1 } }`，未登记的项默认 on=1/数值=0；
 *   数值键由 `fd.numKey` 指定（缺省 'max'=目标持有量；矿区盗采/协助用 'min'=最低量门槛）。
 * `fd.channel2` 存在时行内多一枚第二渠道勾选（.pc-ichk2，回写 `state[key][ch2.key]`，如秘境持有清单的 shop 渠道）。
 * 拖拽序：`cfg[fd.orderKey] = string[]`（池 key 的优先级序，下标即优先级），只由拖拽写入（写全量 DOM 序）；
 *   旧存档无此数组 = 未排过序，面板按池原序展示，引擎也不按序优先（见 feats/activity/secret-realm/pickup.js）。
 * 池项带 `cap`（游戏自身硬上限）时，输入超出 cap 会被自动修正为 cap 并回写框内值。
 * 首次写入前浅拷两层（见下）：内层条目仍与 defaults 共享，registry 的一层克隆到这里不够。checkbox 改动重刷整块（行高量可取）；
 * number 改动不重刷，避免抢用户正在输入的框（但页脚 fd.summary 会就地回写文本）。两者都走 ctx.commit 热更。
 * @param {HTMLElement} box .pc-ilist 容器
 * @param {object} ctx 字段上下文（commit 收口 save+apply+log）
 */
function mountItemList(box, ctx) {
  const fid = box.dataset.id;
  const f = findFeature(fid);
  if (!f) return;
  const fd = findFieldDescriptor(f, box.dataset.fkey);
  if (!fd) return;
  if (box.__pcRowDrag) return; // 拖拽进行中：跳过重刷，避免 ui.refresh 摧毁被拖行
  const c = configs[fid];
  const commit = () => ctx.commit();
  // 状态形状是两层（{[idStr]:{on,[numKey],…}}）：registry 读盘只克隆**一层**（内层条目仍与 defaults 同引用），
  //   故此处自己做两层拷贝。不再用「与 defaults 同引用」作判据——那个判据在 defaults 为空 {} 时正好失效，
  //   而空 defaults + 有内层结构的 descriptor 恰恰是本分支要防的形状。容器每次重建都重拷一次，代价可忽。
  if (!c[fd.key] || typeof c[fd.key] !== 'object' || Array.isArray(c[fd.key])) {
    c[fd.key] = Object.assign({}, (f.defaults && f.defaults[fd.key]) || {});
  }
  const copy = {};
  for (const k of Object.keys(c[fd.key])) copy[k] = Object.assign({}, c[fd.key][k]);
  c[fd.key] = copy;
  const state = c[fd.key];
  const items = typeof fd.items === 'function' ? fd.items(c) : fd.items || [];
  const okey = fd.orderKey;
  if (okey && !Array.isArray(c[okey])) {
    c[okey] = Array.isArray(f.defaults && f.defaults[okey]) ? f.defaults[okey].slice() : [];
  }
  const order = okey ? c[okey] : null;
  // 数值列的键（缺省 'max'）：与 itemListInnerHTML 同口径，矿区盗采/协助用 'min'
  const numKey = (fd && fd.numKey) || 'max';
  // 未登记项的默认勾选态：与 itemListInnerHTML 同口径（fd.defaultOff 时默认不勾）
  const defaultOff = !!(fd && fd.defaultOff);

  const ensureEntry = (key) => {
    if (!state[key]) state[key] = { on: defaultOff ? 0 : 1, [numKey]: 0 };
    return state[key];
  };

  const rerender = () => {
    // fid 必须透传：只读格（boughtText/stockText）与页脚汇总靠 data-fid 被 refreshTexts 回查，
    //   丢了它勾选重刷后这些格就永远不再随数据刷新（首渲染走 module render 有 fid，两条通路必须同口径）
    box.innerHTML = itemListInnerHTML(items, state, fd, order, c, fid);
    bind();
  };

  // 页脚汇总（fd.summary）就地回写：number 改动走的是「不重刷」分支（防抢输入框焦点），
  //   若不单独回写就会停留旧值（直到下一次整块重刷），故只改这一个节点的文本，不碰行 DOM。
  const refreshSummary = () => {
    if (!fd || !fd.summary) return;
    const foot = box.querySelector('.pc-isummary');
    if (!foot) return;
    foot.textContent =
      typeof fd.summary === 'function' ? fd.summary(items, state, c) : String(fd.summary);
  };

  // 拖拽收尾：按当前 DOM 序回写 order（全量池 key，顺带把已从池中消失的残留项清掉）→ 重刷 + 存档 + 热更
  const commitFromDom = (els) => {
    const next = els.map((r) => r.dataset.ikey);
    order.length = 0;
    next.forEach((k) => order.push(k));
    rerender();
    commit();
  };
  const bindDrag = okey
    ? attachRowDrag({
        box: box,
        rowSel: '.pc-irows .pc-irow',
        wrapSel: '.pc-irows',
        rankSel: '.pc-irank',
        handleSel: '.pc-shandle', // 行内有输入框：只从拖拽手柄起拖，不抢输入框焦点/选字
        skipCls: ['pc-ichk', 'pc-ichk2', 'pc-imax', 'pc-rmv'],
        commit: commitFromDom,
      })
    : function () {};
  const bindMove = okey
    ? attachRowMove({
        box: box,
        rowSel: '.pc-irows .pc-irow',
        wrapSel: '.pc-irows',
        upSel: '.pc-rmv-up',
        downSel: '.pc-rmv-down',
        commit: commitFromDom,
      })
    : function () {};

  const bind = () => {
    bindDrag();
    bindMove();
    box.querySelectorAll('.pc-ichk').forEach((chk) => {
      chk.addEventListener('change', () => {
        const k = chk.dataset.ik;
        const e = ensureEntry(k);
        e.on = chk.checked ? 1 : 0;
        rerender();
        commit();
      });
    });
    // 第二渠道勾选（如商店补货 shop）：回写 state[key][ch2.key]，与 on 一样整块重刷以更新行高亮
    box.querySelectorAll('.pc-ichk2').forEach((chk) => {
      chk.addEventListener('change', () => {
        const k = chk.dataset.ik;
        const flag = chk.dataset.iflag || 'shop';
        const e = ensureEntry(k);
        e[flag] = chk.checked ? 1 : 0;
        rerender();
        commit();
      });
    });
    box.querySelectorAll('.pc-imax').forEach((num) => {
      num.addEventListener('change', () => {
        const k = num.dataset.ik;
        const e = ensureEntry(k);
        let v = Math.max(0, Math.floor(Number(num.value) || 0));
        const cap = Math.max(0, Math.floor(Number(num.dataset.cap) || 0));
        if (cap > 0 && v > cap) v = cap; // 游戏自身上限抢先：超出直接修正为上限
        num.value = v > 0 ? v : ''; // 0 回写为空→露出占位（无上限/游戏持有上限），与渲染同口径
        e[numKey] = v;
        // 不重刷，避免抢用户当前输入框；但页脚汇总要跟着改数走（见 refreshSummary）
        refreshSummary();
        commit();
      });
    });
  };

  rerender();
}

/**
 * 只读格就地改文本（panel.refreshTexts 的 .pc-fval 通路）：物品清单「总数量」（.pc-istock ← fd.stockText(key)）
 * 与「已抢」（.pc-ibought ← fd.boughtText(key)）。值随数据变、行结构不变，绝不整块重刷（拖拽/勾选监听绑在行节点上）。
 * @param {Element} el .pc-fval 只读格（带 data-istock / data-ibought 行 key）
 * @param {object} ctx 字段上下文（fd = itemlist 顶层描述符）
 */
function refreshItemText(el, ctx) {
  const fd = ctx.fd;
  let next;
  if (el.dataset.istock != null) {
    if (typeof fd.stockText !== 'function') return;
    next = String(fd.stockText(el.dataset.istock) || '');
  } else if (el.dataset.ibought != null) {
    if (typeof fd.boughtText !== 'function') return;
    next = String(fd.boughtText(el.dataset.ibought) || '');
  } else {
    return;
  }
  if (el.textContent !== next) el.textContent = next;
}

/** 物品清单类型（box 容器，有状态装配 assemble/sync 同源 mountItemList + 只读格 refreshText；interface 形状见 index.js 头注释） */
export const itemlistType = {
  type: 'itemlist',
  kind: 'box',
  cls: 'pc-ilist',
  render: (val, fd, c, fid) =>
    itemListInnerHTML(fd.items, val, fd, fd.orderKey ? c[fd.orderKey] : null, c, fid),
  assembleSel: '.pc-ilist',
  assemble: mountItemList,
  sync: mountItemList,
  refreshText: refreshItemText,
};
