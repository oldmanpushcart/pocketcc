// 署名欢迎浮层（welcome）：主城就绪后展示的独立告知弹窗。
// 独立 Shadow DOM host（与面板同款双向样式隔离，防游戏 CSS 污染/CSS 类名碰撞），极高 z-index 盖过游戏。
// 非模态：不拦游戏交互、不做启动闸门——功能与面板由 boot.js 照常拉起，点不点「进入使用」都不影响使用。
// 页脚摆版本号（快照通道另挂正文摘要前 8 位与通道名）；确有待生效版本时再追加一句「新版已就绪，刷新即生效」。
import { identityOf, pendingNote, revision } from '../update.js';
import { CHANNEL_NAME } from '../constants.js';
import { updateSnapshot } from '../update-client.js';
import { escAttr } from './dom.js';

/**
 * 浮层样式（自成一体，不依赖 PANEL_CSS）。
 * 注：以模板字符串内联是 MV3 + Shadow DOM 场景的常规做法（外部 .css 需走 web_accessible_resources，
 *   反而把文件对外暴露）；代价是 Prettier/stylelint 不覆盖此段，改动时靠人工核对类名唯一性。
 */
const CSS = `
:host { all: initial; }
.pcw-pop {
  position: fixed; inset: 0; z-index: 2147483646;
  display: flex; align-items: center; justify-content: center;
  font-family: "Microsoft YaHei", "PingFang SC", sans-serif;
  /* 整层不吃事件：只有卡片本身可点，空白处的点击/滚轮都落到下层游戏页 */
  pointer-events: none;
}
.pcw-card {
  pointer-events: auto; position: relative;
  width: 420px; max-width: 92vw; box-sizing: border-box;
  padding: 26px 28px 18px; border-radius: 12px;
  background: linear-gradient(160deg, #1c2433, #12161f);
  border: 1px solid #3a4a63; box-shadow: 0 12px 48px rgba(0, 0, 0, 0.6);
  color: #d7dee9; text-align: center;
}
.pcw-close {
  position: absolute; top: 6px; right: 8px; width: 24px; height: 24px;
  border: 0; border-radius: 6px; cursor: pointer; background: transparent;
  font-size: 16px; line-height: 1; color: #b4c0d1;
}
@media (hover:hover){.pcw-close:hover { background: rgba(255, 255, 255, 0.1); color: #e8eef7; }}
.pcw-title { font-size: 17px; font-weight: 700; margin-bottom: 12px; color: #f0d9a0; }
.pcw-sign { font-size: 15px; font-weight: 700; line-height: 1.8; margin-bottom: 14px; color: #e8eef7; }
.pcw-sign .pcw-name { color: #7ecbff; }
/* 开发者名与标题同金色：蓝色给「万恶秃为首」，金色给「晚风」，与卡片唯一的金色标题呼应 */
.pcw-sign .pcw-author { color: #f0d9a0; }
.pcw-decls {
  font-size: 12px; line-height: 1.9; color: #b4c0d1;
  border-top: 1px dashed #3a4a63; margin-top: 6px; padding-top: 10px; text-align: left;
}
.pcw-btn {
  margin-top: 14px; padding: 8px 34px; border: 0; border-radius: 8px; cursor: pointer;
  font-size: 14px; font-weight: 700; color: #10151f;
  background: linear-gradient(180deg, #8fd7ff, #5eb3e8);
}
@media (hover:hover){.pcw-btn:hover { filter: brightness(1.08); }}
.pcw-foot { margin-top: 12px; font-size: 11px; color: #b4c0d1; }
`;

/**
 * 构造升级提示口径（与面板横幅同源）：有待生效版本才回那句，否则空串。
 * @param {object|null} snap 后台快照
 * @returns {string}
 */
function readyNote(snap) {
  if (!snap) return '';
  return pendingNote({
    state: snap.state,
    pendingId: snap.pendingId,
    locked: snap.locked,
    dismissedId: snap.dismissedId,
  });
}

/**
 * 卡片 HTML（纯渲染，真机与快照夹具共用一份）。
 * @param {object|null} [snap] 升级通道快照；仅在有高于正在运行版本的已下载包时页脚追加那句
 * @returns {string}
 */
export function welcomeCardHTML(snap) {
  // 版本号与提示文案都来自外部（构建期 define / 后台清单 notes），按不可信输入同口径转义后再进 innerHTML
  const note = readyNote(snap || null);
  // 非正式通道在页脚版本号后挂一个通道名，让“这是快照包”在真机上一眼可辨；正式版不添字
  const chan = CHANNEL_NAME === 'release' ? '' : ` · ${escAttr(CHANNEL_NAME)}`;
  // 快照通道靠摘要而非版本号区分正文，故页脚那串版本号就得答得出“是哪一份”：身份串自带摘要前 8 位（正式通道下即纯版本号）
  const ident = identityOf(revision(), snap && snap.runningSha);
  const foot = `pocketcc v${escAttr(ident)}${chan}` + (note ? ` · ${escAttr(note)}` : '');
  return (
    '<div class="pcw-card" role="dialog" aria-labelledby="pcw-title">' +
    '<button class="pcw-close" type="button" aria-label="关闭" title="关闭">&times;</button>' +
    '<div class="pcw-title" id="pcw-title">口袋控制中心</div>' +
    '<div class="pcw-sign">由<span class="pcw-name">「万恶秃为首」</span>的<span class="pcw-author">晚风</span>开发并免费分享</div>' +
    '<div class="pcw-decls">' +
    '本插件仅供技术学习与交流，不涉及任何商业用途，终身免费。<br>' +
    '请勿用于商业用途，或据此向任何人付费售卖。<br>' +
    '自动化操作存在被游戏运营方限制的风险，请自行权衡后使用。' +
    '</div>' +
    '<button class="pcw-btn" type="button">进入使用</button>' +
    `<div class="pcw-foot">${foot}</div>` +
    '</div>'
  );
}

/**
 * 弹出署名欢迎浮层（纯告知：不拦截游戏交互，也不参与启动编排）。
 * @returns {void} 已在场则跳过（幂等）
 */
export function showWelcome() {
  if (document.getElementById('pocketcc-welcome-host')) return;
  const host = document.createElement('div');
  host.id = 'pocketcc-welcome-host';
  host.style.cssText = 'all:initial;';
  const root = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = CSS;
  root.appendChild(style);

  const pop = document.createElement('div');
  pop.className = 'pcw-pop';
  pop.innerHTML = welcomeCardHTML(updateSnapshot());
  root.appendChild(pop);
  document.body.appendChild(host);

  // 两个出口都是「关掉弹窗」这一件事：主按钮给读完告知的人，右上角 × 给想直接干活的人。
  // 不做焦点抢占、不做背景 inert——弹窗浮在游戏之上，但游戏始终可玩。
  const close = () => host.remove();
  pop.querySelector('.pcw-btn').addEventListener('click', close);
  pop.querySelector('.pcw-close').addEventListener('click', close);
}
