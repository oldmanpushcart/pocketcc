// 渲染层·一级页薄壳：把版面块按主轴归入三个一级 TAB。
// 伤害汇总 TAB（home.js）：overview（战果简介）→ damage（伤害构成·主轴）。
// 基本信息 TAB：阵型位置（home.formationPanel）→ 静态编配（attrs.staticConfig：英雄/机甲/军阵）
//   → 增益对比（attrs.buffCompare：首卡为按属性大类累加）→ 属性模块构成（attrs.attrModules）。
// 只做编排、不产版面。
import { makeHome } from './home.js';
import { makeParts } from './parts.js';
import { makeAttrs } from './attrs.js';
/**
 * @param {ReturnType<import('./ctx.js').makeCtx>} ctx 字典上下文
 * @param {ReturnType<import('./data.js').makeData>} data 单场取数
 * @param {ReturnType<import('./ui.js').makeUi>} ui 渲染原语
 * @param {ReturnType<import('./shell.js').makeShell>} shell TAB 外壳（dmg/br/hy/fm 各组显示规则）
 */
export function makeSummary(ctx, data, ui, shell) {
  const home = makeHome(ctx, data, ui, shell);
  const parts = makeParts(ctx, data, ui, shell);
  const attrs = makeAttrs(ctx, data, ui, parts);
  const damage = () => home.overview() + home.damage();
  const basic = () =>
    home.formationPanel() + attrs.staticConfig() + attrs.buffCompare() + attrs.attrModules();
  // gridHtml 外露：回合 TAB 复用同一套九宫格版面，只在格内追加逐回合剩余战力。
  return { damage, basic, gridHtml: home.gridHtml };
}
