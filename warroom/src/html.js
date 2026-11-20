import Database from 'better-sqlite3';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { currentDictVersion } from './dict.js';
import { makeCtx } from './html/ctx.js';
import { makeUi } from './html/ui.js';
import { BASE_CSS, makeShell } from './html/shell.js';
import { makeSummary } from './html/summary.js';
import { makeRound } from './html/round.js';
import { makeData } from './html/data.js';

// 渲染单场战报的工作台 HTML（基本信息 / 伤害汇总 / 回合伤害 三 TAB）：只读 warroom.db → 写出 analysis/<reportId>.html，返回写出路径。
// 不依赖入参 R 以外的全局：db/version/here 均在本函数作，支持批量逐个调用。
export function renderReportHtml(R) {
  const here = dirname(fileURLToPath(import.meta.url));
  const db = new Database(resolve(here, '../data/warroom.db'), { readonly: true });
  const version = currentDictVersion(db);

  // ── 分层：字典上下文（ctx.js）/ 取数归因（data.js）/ 渲染原语（ui.js）──
  const ctx = makeCtx(db, version);
  const { fmt, esc } = ctx;
  const ui = makeUi(ctx);
  const shell = makeShell();

  // ── 取数与归因层（见 html/data.js）：本文件只做视图拼装 ──
  const data = makeData(ctx, R);
  const { rep, march, A, battleMs, D } = data;

  // ── 伤害汇总 TAB（overview + damage）+ 基本信息 TAB（增益对比 + 属性模块构成）──
  const summaryMod = makeSummary(ctx, data, ui, shell);
  // ── 回合 TAB（round.js：一级 rd TAB 组 · 总览 + 逐回合五段）──
  // 复用汇总页的九宫格版面（gridHtml），在格内追加逐回合剩余战力。
  const roundMod = makeRound(ctx, data, ui, shell, {
    gridHtml: summaryMod.gridHtml,
    formAtt: A.form,
    formDef: D.form,
  });

  const workbench = shell.topNav({
    info: summaryMod.basic(),
    home: summaryMod.damage(),
    round: roundMod.round(),
  });

  // 战力条按双方之和归一成相对占比（恒铺满；长度即占比）。总战力为 0 时回落成等分。
  const pwAtt = march.att_battle_power_val || 0;
  const pwDef = march.def_battle_power_val || 0;
  const pwTot = pwAtt + pwDef;
  const flexAtt = pwTot ? pwAtt / pwTot : 1;
  const flexDef = pwTot ? pwDef / pwTot : 1;

  const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>战报 ${R}</title><style>
${BASE_CSS}
${shell.css()}
</style></head><body><div class="wrap">

<div class="banner">
  <div class="side-h"><span class="nm attc">${esc(A.info.username || '攻方')}</span><span class="mut">${esc(A.career)}</span></div>
  <div style="text-align:center"><div class="vs">⚔</div><div class="verdict ${rep.result === 1 ? 'v-att' : rep.result === 2 ? 'v-def' : ''}">${rep.result === 1 ? '攻方胜' : rep.result === 2 ? '守方胜' : '平局/未知'}</div></div>
  <div class="side-h" style="align-items:flex-end"><span class="nm defc">${esc(D.info.username || '守方')}</span><span class="mut">${esc(D.career)}</span></div>
</div>
<div class="pwr"><span class="attc">${esc(march.att_battle_power || fmt(march.att_battle_power_val))}</span><span class="pwrbar" style="flex:${flexAtt};background:var(--att)"></span><span class="mut">战力</span><span class="pwrbar" style="flex:${flexDef};background:var(--def)"></span><span class="defc">${esc(march.def_battle_power || fmt(march.def_battle_power_val))}</span></div>
<div class="note">fight_type=${rep.fight_type} · 超轮 att=${march.att_over_round ?? '-'}/def=${march.def_over_round ?? '-'} · 时长≈${(battleMs / 1000).toFixed(1)}s（最大结算拍）</div>


${workbench}

<div class="note" style="text-align:center;margin:20px 0">warroom 单场战报事实样张 · ${R} · 纯客观数据，解读留 P4</div>
</div></body></html>`;

  mkdirSync(resolve(here, '../analysis'), { recursive: true });
  const out = join(resolve(here, '../analysis'), R + '.html');
  writeFileSync(out, html, 'utf8');
  db.close();
  return out;
}
