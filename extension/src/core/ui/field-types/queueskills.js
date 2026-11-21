/**
 * 队列技能只读区块字段类型（type:'queueskills'，自动下田）。
 * 只读 box + 可折叠懒读取：render 只输出收起骨架（不调 fd.get——收起态零读取零图标加载）；
 * assemble 钩子绑头部点击，展开时才经 ctx.fd.get(ctx.c) 现算数据渲染 body（每次展开都重算，
 * 数据恒新鲜——装配轮转后再展开看到的就是最新快照），并逐占位 img 走 core/acl/hero-icon.js
 * 补真图。展开态记在模块级 Map（fid→open），卡 rebuild（UI_REFRESH）后恢复展开不打断阅读，
 * 恢复时 body 重渲（同样走 fd.get 拿新鲜数据）。收起态在 rebuild 后回到收起骨架。
 * 数据流：feat 侧 queueSkillData（预设分节 → 英雄 → 结构化技能清单）；core/ui 不反查 feat，
 * 数据一律经 ctx.fd.get 进来。
 * 渲染形态（body）：每条下田规则一个分节（「预设N · 家族」+ 未启用标记），节内逐英雄一行——
 * 英雄头像（无边框满铺 + 等级角标深底白字，星级类 s5/s4/s3 仅语义标记不着色，名字 hover title 展示，
 * bundle 图加载中回退首字占位）+ 技能徽章链（图标即徽章：无边框 +
 * 等级角标深底白字，稀有度类 rare/plain/act 仅语义标记，名称/稀有度/等级 hover title 展示）。
 * 图标接线：body 渲染只输出占位 img（data-iconload=bundle 路径，hidden），fillIcons 逐个
 * 异步转 dataURL 就地补 src；失败保持 hidden 露文字占位（徽章形态不塌）。
 * 兼容：旧档快照无结构化 items 时该英雄降级为 str 文本行（icon 由 feat 侧渲染期兜底）；
 * 英雄集未就绪显示占位。
 * 刷新：box 型不走 refreshTexts（只读无事件），feat 侧装配完成后 emit UI_REFRESH{rebuild}
 * 重绘本卡（core/ui/index.js 监听 → panel.rerenderFeatureCard；面板关着记 pendingRebuild）。
 *
 * 依赖面 = dom.js（escAttr）+ acl/hero-icon.js（core 内部互引，不反查 fields/wire/feat 模块）。
 */
import { escAttr } from '../dom.js';
import { heroIcon } from '../../acl/hero-icon.js';

/** @type {Map<string, boolean>} 展开态记忆（fid → open）：卡 rebuild 后恢复展开不打断阅读 */
const openState = new Map();

/** 技能徽章：图标即徽章（无边框满铺 + 右下等级角标深底白字，名称/稀有度/等级 hover title 展示，
 *  rare/plain/act 类仅作语义标记不着色）；无图标回退 lv 文字 */
function badgeHTML(it) {
  const tag = it.tag || '';
  const mod = tag === '稀' ? ' rare' : tag === '普' ? ' plain' : tag === '主动' ? ' act' : '';
  const lv = it.level | 0;
  const title = it.name + (tag ? '[' + tag + ']' : '') + ' lv' + lv;
  const ico = it.icon
    ? `<span class="pc-fqicowrap">` +
      `<img class="pc-fqico" alt="" hidden data-iconload="${escAttr(it.icon)}">` +
      (lv > 0 ? `<span class="pc-fqicolv">${lv}</span>` : '') +
      `</span>`
    : lv > 0
      ? `<span class="pc-fqsklv">lv${lv}</span>`
      : '';
  return `<span class="pc-fqskill${mod}" title="${escAttr(title)}">${ico}</span>`;
}

/** 英雄行：头像（无边框满铺 + 右下等级角标深底白字，名字/编号移入 title hover 展示）+ 技能徽章链；items 缺失降级 str 文本行（旧档兼容） */
function heroHTML(h) {
  const hid = h.hid | 0;
  const lv = h.level | 0;
  const name = h.name || '英雄' + hid;
  // 星级语义类（star=HeroData._star，queueSkillData 现读）：s5/s4/s3 仅供识别，不参与着色
  const smod =
    (h.star | 0) >= 5 ? ' s5' : (h.star | 0) === 4 ? ' s4' : (h.star | 0) === 3 ? ' s3' : '';
  // 头像：bundle 图加载中回退首字占位（fillIcons 成功切图/失败留占位字）；名字不占版面，
  // hover 头像 title 展示「名字 · LvN #编号」（原生 tooltip，键盘无障碍读屏同源）
  const av =
    `<span class="pc-fqavwrap${smod}" title="${escAttr(name + (lv > 0 ? ' · Lv' + lv : '') + ' #' + hid)}">` +
    (h.icon ? `<img class="pc-fqav" alt="" hidden data-iconload="${escAttr(h.icon)}">` : '') +
    `<span class="pc-fqavph">${escAttr(name.slice(0, 1))}</span>` +
    (lv > 0 ? `<span class="pc-fqlv">${lv}</span>` : '') +
    `</span>`;
  const chip = `<span class="pc-fqhero">${av}</span>`;
  if (!Array.isArray(h.items)) {
    return (
      `<div class="pc-fqrow">` +
      chip +
      `<span class="pc-fqlegacy">${escAttr(h.str || '暂无装配记录')}</span>` +
      `</div>`
    );
  }
  const badges = h.items.length ? h.items.map(badgeHTML).join('') : '';
  return (
    `<div class="pc-fqrow">` +
    chip +
    (badges || `<span class="pc-fqnone">组2 无技能</span>`) +
    `</div>`
  );
}

/**
 * body 内层 HTML：逐规则分节（节头「预设N · 家族」+ 未启用标记），节内逐英雄行。
 * 数据经 fd.get(cfg) 现算——只在展开时被调（懒读取，恒新鲜）。
 * @param {object} fd 字段描述符（label / hint / get）
 * @param {object} cfg 该功能当前配置（透传给 fd.get）
 * @returns {string}
 */
function bodyHTML(fd, cfg) {
  const data = typeof fd.get === 'function' ? fd.get(cfg) : null;
  const secs = Array.isArray(data)
    ? data
        .map(function (s) {
          const off = s.skill ? '' : `<span class="pc-fqoff">未启用技能装配</span>`;
          const rows = s.heroes.length
            ? s.heroes.map(heroHTML).join('')
            : `<div class="pc-fqrow"><span class="pc-fqnone">英雄集未就绪，稍后刷新</span></div>`;
          return (
            `<div class="pc-fqgrp">` +
            `<div class="pc-fqsec">${escAttr('预设' + (s.preset | 0) + (s.fam ? ' · ' + s.fam : ''))}${off}</div>` +
            rows +
            `</div>`
          );
        })
        .join('')
    : '';
  return (
    (secs || `<div class="pc-fqrow"><span class="pc-fqnone">无下田规则行</span></div>`) +
    (fd.hint ? `<div class="pc-rnghint">${escAttr(fd.hint)}</div>` : '')
  );
}

/** 占位 img 补真图（fire-and-forget；成功就地把 dataURL 塞 src，失败保持 hidden 露文字/首字占位） */
function fillIcons(scope) {
  scope.querySelectorAll('img[data-iconload]').forEach(function (el) {
    const path = el.dataset.iconload || '';
    el.removeAttribute('data-iconload'); // 防重复装配重复 load（同路径二次装配走缓存零开销）
    heroIcon.load(path, function (url) {
      if (url) {
        el.src = url;
        el.hidden = false; // 成功切真图（英雄头像的首字占位由 CSS 兄弟选择器隐藏）
      }
      // 失败：img 保持 hidden，文字徽章/首字占位照旧（不塌）
    });
  });
}

/** 展开 body：重渲（fd.get 现算，数据恒新鲜）+ 补图标 + 记展开态 */
function expandBody(box, ctx) {
  const head = box.querySelector('.pc-fqhead');
  const body = box.querySelector('.pc-fqbody');
  if (!head || !body) return;
  body.hidden = false;
  head.classList.add('open');
  head.setAttribute('aria-expanded', 'true');
  body.innerHTML = bodyHTML(ctx.fd, ctx.c);
  fillIcons(body);
  openState.set(ctx.fid, true);
}

/** 收起 body（渲染结果保留在 DOM，下次展开重渲覆盖）+ 记收起态 */
function collapseBody(box, fid) {
  const head = box.querySelector('.pc-fqhead');
  const body = box.querySelector('.pc-fqbody');
  if (!head || !body) return;
  body.hidden = true;
  head.classList.remove('open');
  head.setAttribute('aria-expanded', 'false');
  openState.set(fid, false);
}

/**
 * 收起态骨架 render：不调 fd.get（收起零读取零图标加载）；头部不带队伍数——数量要 fd.get
 * 才知道，违背懒读取诉求，副提示只写数据性质。外壳 div（.pc-fqsk + data-id/data-fkey）由
 * fieldBox 提供，此处只出内部节点。
 * @param {*} val cfg[fd.key]（恒 undefined，忽略）
 * @param {object} fd 字段描述符（label / hint）
 * @returns {string}
 */
function queueSkillsShellHTML(val, fd) {
  return (
    `<div class="pc-fqhead" role="button" tabindex="0" aria-expanded="false">` +
    `<span class="pc-fqchev" aria-hidden="true">▶</span>` +
    `<span class="pc-fqheadtxt">${escAttr(fd.label || '队列技能')}</span>` +
    `<span class="pc-fqsub">出发瞬间快照 · 点击展开</span>` +
    `</div>` +
    `<div class="pc-fqbody" hidden></div>`
  );
}

/** 队列技能类型（收起骨架 + 懒渲染装配；interface 形状见 index.js 头注释） */
export const queueskillsType = {
  type: 'queueskills',
  kind: 'box',
  cls: 'pc-fqsk',
  render: queueSkillsShellHTML,
  // 装配：assembleTypeModules 走 assembleSel 找到外壳（fieldBox 带 cls），绑头部交互 +
  // 按展开态记忆恢复（rebuild 后展开态恢复时 body 重渲拿新鲜数据 + 补图标）
  assembleSel: '.pc-fqsk',
  assemble(box, ctx) {
    const head = box.querySelector('.pc-fqhead');
    const body = box.querySelector('.pc-fqbody');
    if (!head || !body) return; // 桩环境/异常 DOM：静默跳过
    head.addEventListener('click', function () {
      if (body.hidden) expandBody(box, ctx);
      else collapseBody(box, ctx.fid);
    });
    head.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        head.click(); // 键盘可达（.pc-fsectoggle 同款约定）
      }
    });
    if (openState.get(ctx.fid)) expandBody(box, ctx);
  },
};
