// 渲染层·外壳：CSS 令牌 + 零 JS TAB 生成器 + 一级/二级/三级导航骨架。
// TAB 切换一律走 `input[type=radio]` + `:checked ~` 兄弟选择器（产物内零 JavaScript）：
// 每组 TAB 的 DOM 与它的显示规则同源于 tabs()，不手写 nth-child 枚举（三级嵌套下会指数膨胀）。

/** 全页基础样式（含 :root 攻红守蓝令牌）；TAB 显示规则不在此，由 makeShell().css() 生成。 */
export const BASE_CSS = `
/* 色纪律：攻方一律 --att(红)、守方一律 --def(蓝)；中性语义走 --mut/--txt/--line，
   不得拿第三种主色表达阵营（军种标签 .b陆军/.b海军/.b空军 是军种语义，与阵营色位不混用）。*/
:root{--bg:#0f1420;--card:#171e2e;--line:#26324b;--txt:#dfe7f3;--mut:#7d8aa3;--att:#ff5b6a;--def:#4aa3ff}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--txt);font:14px/1.5 "Segoe UI","Microsoft YaHei",sans-serif}
.wrap{max-width:1080px;margin:0 auto;padding:20px}
.banner{background:linear-gradient(135deg,#1b2740,#141a2a);border:1px solid var(--line);border-radius:14px;padding:18px 22px;display:flex;justify-content:space-between;align-items:center}
.vs{font-size:26px;font-weight:800}
/* 胜负字按胜方取阵营色，平局保持中性 */
.verdict{font-size:15px;font-weight:700;color:var(--txt)}
.verdict.v-att{color:var(--att)}.verdict.v-def{color:var(--def)}
.attc{color:var(--att)}.defc{color:var(--def)}
/* 模块内「攻方 / 守方」小标题统一走 .side-tag + 阵营色，禁止内联 style 颜色 */
.side-tag{font-weight:700;font-size:12px;margin:6px 0 4px}
.side-h{display:flex;flex-direction:column;gap:2px}.side-h .nm{font-weight:700;font-size:16px}
/* 首页战果：一句话摘要 + 横向 KPI 徽章行（徽章内部仍走 cmpRow 的 att|label|def 结构） */
.vline{font-size:13px;color:var(--txt);background:#0e1524;border:1px solid var(--line);border-radius:8px;padding:8px 12px;margin-bottom:12px}
.kpis{display:flex;flex-wrap:wrap;gap:10px}
.kpis>.cmp{flex:1 1 122px;grid-template-columns:1fr;justify-items:center;gap:2px;padding:8px 6px;border-bottom:none;background:#0f1626;border:1px solid var(--line);border-radius:10px}
.kpis>.cmp .cl{padding:2px 0}
.pwr{display:flex;align-items:center;gap:8px;margin-top:10px}.pwrbar{height:10px;border-radius:6px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;margin-top:16px;padding:16px 18px}
.card h2{margin:0 0 12px;font-size:15px;color:var(--mut);letter-spacing:1px}
/* 时间×空间 阶段分区（模块标题不参与阵营语义） */
.phase{margin-top:26px}
.phasehd{position:relative;z-index:1;margin:0 0 12px;padding:10px 16px;font-size:18px;font-weight:800;color:#fff;background:linear-gradient(135deg,#22304d,#141a2a);border:1px solid var(--line);border-left:4px solid var(--line);border-radius:12px;display:flex;flex-direction:column;gap:2px}
.phasehd .phsub{font-size:12px;font-weight:400;color:var(--mut);letter-spacing:.3px}
/* D4：chapter 大章节外壳已删（与一级导航重复），模块内直接铺 .card；以下均为卡层原语 */
.opsum{font-size:12px;font-weight:400;letter-spacing:0;color:var(--txt);background:#0e1524;border:1px solid var(--line);border-radius:6px;padding:1px 8px;margin-left:6px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:18px}
.cmp{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;padding:5px 0;border-bottom:1px dashed var(--line)}
.cmp .cl{color:var(--mut);padding:0 14px;font-size:13px}.cmp .cn{font-weight:700;text-align:center}
.heroes{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0}
.heroes.v{flex-direction:column}
.heroes.v .hero{width:100%;flex:0 0 auto}
.hero{background:#0e1524;border:1px solid var(--line);border-radius:8px;padding:6px 10px;min-width:110px}
.bar{display:grid;grid-template-columns:130px 1fr 56px;align-items:center;gap:8px;margin:4px 0}
.bk{font-size:12px;color:var(--mut);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bf{height:12px;border-radius:6px;background:linear-gradient(90deg,#8a3b46,#ff5b6a)}
.bf.d{background:linear-gradient(90deg,#3b6ea5,#4aa3ff)}
.bv{font-size:12px;text-align:right}
.rbc{height:12px;background:#232d42;overflow:hidden;display:flex}
.rbc .bf{height:100%}
table{width:100%;border-collapse:collapse;font-size:13px}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}
.cell{background:#0e1524;border:1px solid var(--line);border-radius:8px;padding:8px;min-height:62px}
.cell.empty{opacity:.35}.cpos{font-size:10px;color:var(--mut)}.cname{font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cmeta{font-size:11px;color:var(--mut);margin-top:4px}.dead{color:var(--mut)}
.btag{font-size:10px;padding:0 5px;border-radius:4px;background:#1a2236;color:#9aa7bd;border-left:2px solid transparent;line-height:1.6}.b陆军{border-left-color:#5a8a5a}.b海军{border-left-color:#5a86b0}.b空军{border-left-color:#a8955a}
.mat{margin-top:4px}.mat th{background:#0e1524;padding:6px;text-align:center;font-size:12px;color:var(--mut)}.mat td{border:1px solid var(--line);text-align:center;padding:6px}
.mat .an{text-align:left;color:var(--txt)}.mat .mv{font-variant-numeric:tabular-nums}
.mat .desc{font-size:11px;color:var(--mut);text-align:left;word-break:break-word;line-height:1.5}
/* 军阵专精 3×3 矩阵：金黄映衬沿用首页九宫格 .cell.mas 的色位（专精语义，非阵营语义） */
.mat.fmg td{width:33%;vertical-align:top;text-align:left}
.fmg .mp{font-size:10px;color:var(--mut)}
.fmg .msk{color:#e6c35c;font-weight:700}
.fmg .mbg{font-size:11px;color:var(--mut);line-height:1.5}
.fmg td.mas{background:#241d0e;box-shadow:inset 0 0 0 1px #e6c35c}
.mut{color:var(--mut)}.note{font-size:11px;color:var(--mut);margin-top:6px}
/* 回合模块数据边界列表（做不出的三件事 · 附实测判据） */
.bound{margin:8px 0 0;padding-left:18px}.bound li{margin:6px 0;font-size:12px;color:var(--mut);line-height:1.65}.bound li b{color:var(--txt)}
code{font-family:ui-monospace,Consolas,monospace;font-size:11px;color:#9fb3d0}
.hero{min-width:210px;max-width:100%;flex:1 1 210px}
.hlbl{color:var(--mut);margin-right:5px}
.chips{display:flex;flex-wrap:wrap;gap:4px;flex:1}
.chip{display:inline-flex;align-items:center;gap:3px;font-size:11px;line-height:1;padding:3px 7px;border-radius:6px;border:1px solid var(--line);background:#0e1524;white-space:nowrap}
.chip b{font-weight:700;color:var(--txt)}
.chip.aw{border-color:#5a4a2a;background:#241d0e}.chip.aw b{color:#e6c35c}
.chip.sk{border-color:#2a4a6a;background:#0e1a24}.chip.sk b{color:#6bb3e6}
.chip.tal{border-color:#3a5a2a;background:#12200e}.chip.tal b{color:#8fce7a}
.chip.sci{border-color:#4a3a6a;background:#181224}.chip.sci b{color:#b79ce6}
.chip.eqp{border-color:#3a4256;background:#141a28}.chip.eqp b{color:#c3cede}
.chip .stn{font-style:normal;font-size:10px;margin-left:3px;padding:0 4px;border-radius:4px;line-height:1.6;background:#2a2150;color:#c1a6ff}
.chip .rq{font-style:normal;font-size:10px;margin-left:2px;padding:0 4px;border-radius:4px;line-height:1.5}
.rq.rar{background:#2a2150;color:#c1a6ff}.rq.nor{background:#1b2740;color:#7d8aa3}
/* 对比行（攻左红/守右蓝，共用标尺） */
.vr{display:grid;grid-template-columns:72px 1fr 210px 1fr 72px;align-items:center;gap:8px;margin:4px 0}
.vrn{display:grid;grid-template-columns:1fr 72px;align-items:center;column-gap:4px;min-width:0;font-size:12px;color:var(--txt)}
.vrn .nm{font-weight:400;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.35;text-align:center}
.vrh{height:12px;background:#1a2336;display:flex;overflow:hidden}
.vrh.l{justify-content:flex-end;border-radius:6px 0 0 6px}
.vrh.r{justify-content:flex-start;border-radius:0 6px 6px 0}
.vrbar{height:100%}
.vrbar.a{background:linear-gradient(90deg,#8a3b46,#ff5b6a)}
.vrbar.d{background:linear-gradient(90deg,#4aa3ff,#2f6da5)}
.vrbar.dim{opacity:.4}
.vrv{font-size:12px;font-weight:700;font-variant-numeric:tabular-nums;white-space:nowrap}
.vrv.l{text-align:right}
.vrv.r{text-align:left}
.vrv.mut{font-weight:400}
.dlt{grid-column:2;justify-self:start;color:var(--mut);font-size:10px;font-weight:400;white-space:nowrap}
/* 增益生效矩阵：时机列表头 */
.mtkh{font-size:11px;font-weight:600;color:var(--mut);margin:9px 0 2px;padding-bottom:2px;border-bottom:1px solid var(--line);letter-spacing:.5px}
.mtkh.dyn{color:#9a8a4a}
.dynhint{font-size:11px;margin:2px 0 6px;line-height:1.5}
/* 魔石等级/品质 */
.chip .stn b{font-weight:700;margin-left:2px}
.chip .stn.q1{background:#1b2740;color:#8aa0bd}
.chip .stn.q2{background:#2a2150;color:#c1a6ff}
.chip .stn.q3{background:#3a2a12;color:#e6c35c}
.fsci{display:flex;align-items:flex-start;gap:6px;margin:6px 0 2px}
.cell.mas{border-color:#e6c35c;box-shadow:inset 0 0 0 1px #e6c35c,0 0 10px #e6c35c33}
.mtag{font-size:10px;color:#e6c35c;background:#241d0e;border:1px solid #5a4a2a;border-radius:4px;padding:0 5px}
.crow{display:flex;justify-content:space-between;align-items:center;gap:4px}
.cbar{height:5px;border-radius:3px;background:#232d42;overflow:hidden;margin-top:5px}
.calive{display:block;height:100%}
.g-att .calive{background:linear-gradient(90deg,#ff6b76,#a83f4a)}
.g-def .calive{background:linear-gradient(90deg,#6bb0ff,#2f6da5)}
.cstat{display:flex;justify-content:space-between;font-size:11px;margin-top:4px}
.g-att .cstat .ok{color:var(--att)}.g-def .cstat .ok{color:var(--def)}
.cstat .dead{color:var(--mut)}
.casbar{display:flex;height:10px;border-radius:5px;overflow:hidden;background:#0e1524;margin:6px 0 4px}
.casbar .cb{display:block;height:100%}
.cas-att .cb.sv{background:#ff6b76}.cas-att .cb.wd{background:#b57a55}.cas-att .cb.dd{background:#6e3a44}
.cas-def .cb.sv{background:#6bb0ff}.cas-def .cb.wd{background:#4f7ba8}.cas-def .cb.dd{background:#2c4a68}
.caslegend{display:flex;gap:12px;font-size:11px;margin-bottom:6px}
.cas-att .caslegend .ok{color:#ff6b76}.cas-att .caslegend .wdl{color:#c08a5a}.cas-att .caslegend .dead{color:#9a7070}
.cas-def .caslegend .ok{color:#6bb0ff}.cas-def .caslegend .wdl{color:#6a8fb5}.cas-def .caslegend .dead{color:#6a7a8a}
.tabs>input{display:none}
.tabs>label{display:inline-block;padding:3px 12px;border-radius:8px;background:#0e1524;border:1px solid var(--line);color:var(--mut);cursor:pointer;font-size:12px;margin:0 6px 6px 0}
.tabs>input:checked+label{color:#fff;background:#26324b;border-color:#3b6ea5}
.tpane{background:#0e1524;border:1px solid var(--line);border-radius:8px;padding:6px 12px}
/* 回合×空间 热力表 */
.hxwrap{overflow-x:auto}
/* 宽表横向滚动容器（列数多到一行摆不下时用，不绑死某种表） */
.tscroll{overflow-x:auto}
.hx{border-collapse:collapse;width:100%;font-size:11px;font-variant-numeric:tabular-nums}
.hx th,.hx td{border:1px solid var(--line);padding:3px 5px;text-align:center;white-space:nowrap}
.hx th{background:#0e1524;color:var(--mut);font-weight:600}
.hx .rk{position:sticky;left:0;background:#141a2a;text-align:left;z-index:1;font-weight:600;max-width:170px;overflow:hidden;text-overflow:ellipsis}
.hx tfoot td{background:#0e1524;color:var(--txt);font-weight:700}
.hcell{padding:2px !important}
.ha,.hd{display:block;min-width:38px;padding:1px 4px;border-radius:3px;margin:1px auto;color:#fff;line-height:1.5}
.rkt{color:var(--mut)}
/* 回合内结算拍轴：列=拍（tl 1.2s 定拍）、行=造成/释放/增益活动，格内上攻下守 */
.tk th{min-width:58px}
.tk td.hcell{vertical-align:top;padding:2px 3px}
.tk .tza{min-height:14px;margin:1px 0}
.tk .tza+.tza{border-top:1px dotted var(--line)}
.tk .tza.att .tkc{background:rgba(255,91,106,.26)}
.tk .tza.def .tkc{background:rgba(74,163,255,.26)}
.tk .tkc{display:block;white-space:normal;word-break:break-all;text-align:left;font-size:10px;line-height:1.45;padding:1px 4px;margin:1px 0;border-radius:3px;color:#fff;min-width:0}
/* 顶部阵型位置面板（静态 · 随页面滚动、不钉固） */
.formbar{margin:14px 0 6px;padding:10px 14px;background:linear-gradient(135deg,#1b2740,#141a2a);border:1px solid var(--line);border-radius:12px}
.rnavhd{font-weight:700;font-size:13px;margin-bottom:6px}
.formlayout{display:grid;grid-template-columns:1fr 1fr;gap:16px}
/* 逐回合兵力：走势并排柱（每回合攻/守两柱，高按对局起始双方总量归一）+ 九宫格格内剩余战力条 */
.ftrend{display:flex;gap:26px;align-items:flex-end;height:150px;padding:8px 6px 0;overflow-x:auto}
.fcol{flex:0 0 auto;display:flex;flex-direction:column;align-items:center;gap:4px;width:64px}
.fbarwrap{display:flex;gap:3px;align-items:flex-end;height:118px;width:100%}
.fbar{flex:1;min-height:2px;border-radius:3px 3px 0 0}
.fbar.a{background:linear-gradient(180deg,#ff6b76,#a83f4a)}
.fbar.d{background:linear-gradient(180deg,#6bb0ff,#2f6da5)}
.fx{font-size:10px;color:var(--mut)}
.fpow{font-size:10px;color:var(--mut);margin-top:4px;line-height:1.35}
.fpbar{display:block;height:4px;border-radius:2px;background:#232d42;overflow:hidden;margin-top:2px}
.fpbar>span{display:block;height:100%}
.g-att .fpbar>span{background:linear-gradient(90deg,#ff6b76,#a83f4a)}
.g-def .fpbar>span{background:linear-gradient(90deg,#6bb0ff,#2f6da5)}
/* 章内钻取明细：一律展开、无收起 */
.dnode{margin:8px 0;padding:6px 10px;background:#0e1524;border:1px solid var(--line);border-radius:8px}
.dnode-t{font-size:12px;color:var(--mut);font-weight:600;letter-spacing:.3px;margin-bottom:2px}
.dx{margin:4px 0 8px}
.dnode.fgrp{background:transparent;border:none;border-top:1px dashed var(--line);border-radius:0;padding:6px 0;margin:6px 0}
.dnode.fgrp .dnode-t{color:var(--txt);text-align:center}
/* 逐件/明细折叠层（默认收起） */
.dnode.dfold>summary.dnode-t{cursor:pointer;list-style:none;position:relative;padding-right:58px}
.dnode.dfold>summary.dnode-t::-webkit-details-marker{display:none}
.dnode.dfold>summary.dnode-t::after{content:'▸ 展开';position:absolute;right:2px;top:0;font-size:11px;font-weight:400;color:var(--mut)}
.dnode.dfold[open]>summary.dnode-t::after{content:'▾ 收起'}
.dnode.dfold:not([open])>.dx{display:none}
.erow{display:grid;grid-template-columns:1fr 210px 1fr;align-items:start;gap:10px;padding:5px 0;border-top:1px solid var(--line)}
.erow:first-child{border-top:none}
.epos{grid-column:2;text-align:center;font-weight:700;font-size:11px;color:var(--txt);padding-top:2px}
.ec{min-width:0}
.ec.a{text-align:right}
.ec.d{text-align:left}
.ecb{font-size:12px;line-height:1.5}
.ecb .chip{margin:0 2px}
.ecbf{font-size:11px;color:var(--mut);line-height:1.5;margin-top:1px}
.ecbf b{color:var(--txt);font-weight:600}
.slv{font-style:normal;color:var(--mut);font-size:11px;margin-left:4px}
.mi{background:#0e1524;border:1px solid var(--line);border-radius:8px;padding:8px 10px;margin:6px 0}
.mihd{font-weight:700;font-size:13px;margin-bottom:4px}
.mic{display:flex;align-items:flex-start;gap:6px;margin:3px 0;font-size:12px}
.mic>.hlbl{flex:0 0 40px;color:var(--mut);padding-top:2px}
.chiplist{flex:1;min-width:0}
.mineline{margin:2px 0;font-size:12px;color:var(--txt);word-break:break-word}
.mineline b{font-weight:700}.mineline i{font-style:normal;color:var(--mut);font-size:11px;margin-left:2px}
.chip .src{font-style:normal;font-size:10px;color:var(--mut);margin-left:4px;opacity:.8}
/* 一级/二级导航：TAB 显示规则由 shell.tabs() 生成，这里只给外观（一级：基本信息 / 伤害汇总 / 回合伤害）*/
.mnav{margin-top:18px}
.mnav>label{font-size:15px;font-weight:700;padding:8px 26px;margin:0 8px 12px 0;border-radius:10px;background:#131a2b}
.snav>label{font-size:13px;font-weight:600;padding:6px 18px;margin:0 6px 10px 0}
.w-mv>.pc,.w-hy>.pc,.w-fm>.pc{padding:2px 0 6px}
`;

/**
 * 三级导航的 TAB 组定义（id 前缀固定，产物门禁按此校验 radio 数 == pane 数）。
 * items: [key, 文案]。
 */
export const NAV = {
  mv: {
    name: 'mv',
    items: [
      ['info', '基本信息'],
      ['home', '伤害汇总'],
      ['round', '回合伤害'],
    ],
  },
  hy: {
    name: 'hy',
    items: [
      ['skill', '技能'],
      ['talent', '天赋'],
      ['awaken', '觉醒'],
      ['titan', '泰坦'],
    ],
  },
  fm: {
    name: 'fm',
    items: [
      ['mastery', '专精'],
      ['science', '科技'],
      ['lvq', '等级品质'],
    ],
  },
};

/**
 * TAB 组与模块外壳工厂。每次渲染新建一个实例（规则收集不跨场、不跨次调用残留）。
 */
export function makeShell() {
  const rules = [];

  /**
   * 通用 TAB 组：radio + label 与 pane 容器同级，`:checked ~` 只按 id 命中，与顺序无关。
   * @param {string} name input[name]，全页唯一（'mv' / 'hy' / 'fm' / 'tab-dmg' / 'tab-br' …）
   * @param {Array<{key:string,label:string,body:string}>} items 各 TAB
   * @param {{checked?:string,cls?:string,paneCls?:string}} [opts] cls=外壳类、paneCls=每个面板附加类
   * @returns {string} TAB 组 HTML
   */
  const tabs = (name, items, opts = {}) => {
    const { checked = items.length ? items[0].key : null, cls = '', paneCls = '' } = opts;
    const head = items
      .map(
        (it) =>
          `<input type="radio" name="${name}" id="${name}-${it.key}"${it.key === checked ? ' checked' : ''}>` +
          `<label for="${name}-${it.key}">${it.label}</label>`,
      )
      .join('');
    const panes = items
      .map(
        (it) =>
          `<div class="pc ${name}-p-${it.key}${paneCls ? ' ' + paneCls : ''}">${it.body}</div>`,
      )
      .join('');
    rules.push(`.w-${name}>.pc{display:none}`);
    for (const it of items)
      rules.push(`#${name}-${it.key}:checked~.w-${name}>.${name}-p-${it.key}{display:block}`);
    return `<div class="tabs${cls ? ' ' + cls : ''}">${head}<div class="w-${name}">${panes}</div></div>`;
  };

  /** 一级导航外壳：banner 常驻在上，三模块（基本信息 / 伤害汇总 / 回合伤害）走 'mv' TAB 组。 */
  const topNav = (bodies, checked = 'info') =>
    tabs(
      'mv',
      NAV.mv.items.map(([key, label]) => ({ key, label, body: bodies[key] || '' })),
      { cls: 'mnav', checked },
    );

  /** 已收集的 TAB 显示规则，供 <style> 末段追加。 */
  const css = () => rules.join('\n');

  return { tabs, topNav, css };
}
