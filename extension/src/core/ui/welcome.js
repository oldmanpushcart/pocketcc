// 准入问候浮层（welcome）：授权包在游戏主城就绪、账号比对完成后展示的模态欢迎页。
// 独立 Shadow DOM host（与面板同款双向样式隔离，防游戏 CSS 污染/CSS 类名碰撞），极高 z-index 盖过游戏。
// 两态：'ok' 绿色核验通过 + 「进入使用」按钮（按钮 resolve 启动编排等待的 promise）；
//       'fail' 红色核验失败（不回显账号），模态不可关闭——此时功能链未被拉起，界面仅作明确告知。
import { peerName, revision } from '../net-guard.js';
import { escAttr } from './dom.js';

/**
 * 浮层样式（自成一体，不依赖 PANEL_CSS）。
 * 注：以模板字符串内联是 MV3 + Shadow DOM 场景的常规做法（外部 .css 需走 web_accessible_resources，
 *   反而把文件对外暴露）；代价是 Prettier/stylelint 不覆盖此段，改动时靠人工核对类名唯一性。
 */
const CSS = `
:host { all: initial; }
.pcw-mask {
  position: fixed; inset: 0; z-index: 2147483646;
  background: rgba(8, 10, 14, 0.72);
  display: flex; align-items: center; justify-content: center;
  font-family: "Microsoft YaHei", "PingFang SC", sans-serif;
}
.pcw-card {
  width: 420px; max-width: 92vw; box-sizing: border-box;
  padding: 26px 28px 18px; border-radius: 12px;
  background: linear-gradient(160deg, #1c2433, #12161f);
  border: 1px solid #3a4a63; box-shadow: 0 12px 48px rgba(0, 0, 0, 0.6);
  color: #d7dee9; text-align: center;
}
.pcw-title { font-size: 17px; font-weight: 700; margin-bottom: 14px; color: #f0d9a0; }
.pcw-gift { font-size: 14px; line-height: 1.9; margin-bottom: 14px; }
.pcw-gift .pcw-name { color: #7ecbff; font-weight: 700; }
.pcw-gift .pcw-uid { color: #b4c0d1; font-size: 12px; }
.pcw-verdict { font-size: 15px; font-weight: 700; margin: 10px 0 14px; }
.pcw-verdict.ok { color: #59d17c; }
.pcw-verdict.fail { color: #ff6b6b; }
.pcw-decls {
  font-size: 12px; line-height: 1.8; color: #b4c0d1;
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
 * 账号打码展示：前 4 后 2 保留、中间省略（防截图对号入座）
 * @param {string|null|undefined} uid 运行期账号标识
 * @returns {string}
 */
function maskUid(uid) {
  const s = String(uid || '');
  if (s.length <= 6) return s;
  return `${s.slice(0, 4)}……${s.slice(-2)}`;
}

/**
 * @param {boolean} pass 是否放行
 * @param {string|null|undefined} uid 运行期账号标识（失败态不回显）
 * @returns {string} 卡片 HTML
 */
function cardHTML(pass, uid) {
  // 昵称来自打包参数 --friend（scripts/package-friend.mjs 可外部调用），与 UID 一样按不可信输入处理：
  //   本函数结果直接进 innerHTML，不转义则带 `<` 的名字会破版，被有意构造即成 MAIN world 注入点。
  const name = escAttr(peerName());
  // 打码后的 UID 与昵称同口径处理：maskUid 对短账号（≤6 位）是原样返回的，不能假定它一定是数字
  const uidShown = escAttr(maskUid(uid));
  const gift = pass
    ? `万恶秃为首的晚风赠予他风情万种的朋友` +
      `<span class="pcw-name">「${name}」</span><span class="pcw-uid">（UID：${uidShown}）</span>使用`
    : '万恶秃为首的晚风的心意已送达，但来客身份与这份馈赠不相符';
  const verdict = pass
    ? '<div class="pcw-verdict ok">核验通过</div>'
    : '<div class="pcw-verdict fail">核验失败</div>';
  const btn = pass ? '<button class="pcw-btn" type="button">进入使用</button>' : '';
  return (
    '<div class="pcw-card" role="dialog" aria-modal="true" aria-labelledby="pcw-title">' +
    '<div class="pcw-title" id="pcw-title">口袋控制中心</div>' +
    `<div class="pcw-gift">${gift}</div>` +
    verdict +
    '<div class="pcw-decls">' +
    '本插件仅供技术学习与交流，不涉及任何商业用途，终身免费。<br>' +
    '本授权仅限特定游戏账号（UID）使用，请勿转发给任何第三人，亦勿用于其他游戏账号。' +
    (pass ? '' : '<br>当前账号未获授权，功能已全部停用。') +
    '</div>' +
    btn +
    `<div class="pcw-foot">pocketcc v${revision()} · 赠予「${name}」</div>` +
    '</div>'
  );
}

/**
 * 弹出准入问候浮层。
 * @param {'ok'|'fail'} mode 展示态
 * @param {string|null|undefined} uid 运行期账号标识
 * @returns {Promise<void>} 'ok' 态点「进入使用」resolve；'fail' 态不可关闭（永不 resolve）
 */
export function showWelcome(mode, uid) {
  const pass = mode === 'ok';
  if (document.getElementById('pocketcc-welcome-host')) {
    return pass ? Promise.resolve() : new Promise(() => {});
  }
  return new Promise((resolve) => {
    const host = document.createElement('div');
    host.id = 'pocketcc-welcome-host';
    host.style.cssText = 'all:initial;';
    const root = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = CSS;
    root.appendChild(style);

    const mask = document.createElement('div');
    mask.className = 'pcw-mask';
    mask.innerHTML = cardHTML(pass, uid);
    root.appendChild(mask);
    document.body.appendChild(host);

    // 遮罩吞掉游戏侧交互（fail 态物理挡住页面点击，ok 态在放行前也不响应游戏）。
    // 用冒泡阶段而非捕获：捕获期在祖先层 stopPropagation 会先于按钮目标层触发、吞掉「进入使用」点击；
    // 冒泡期则按钮先处理，再于 mask 拦停事件外泄到下层游戏页。
    const swallow = (e) => {
      // 拦停冒泡到下层游戏页（遮罩已全屏覆盖，命中测试本不会点穿；此处再挡 document/window 级监听）。
      e.stopPropagation();
      // 仅对遮罩空白处 preventDefault（防拖拽/选中等副作用）；卡片内不 preventDefault，
      // 以免 pointerdown 被 preventDefault 后抑制「进入使用」的后续 click。
      if (e.target === mask) e.preventDefault();
    };
    mask.addEventListener('pointerdown', swallow);
    mask.addEventListener('click', swallow);

    // 模态语义：背景兄弟节点 inert（键盘/读屏不能穿透遮罩），焦点移入对话框；
    // ok 态 Esc 等价「进入使用」，fail 态故意不可关闭（仅聚焦卡片供读屏播报）。
    const inerted = [];
    for (const el of document.body.children) {
      if (el !== host && !el.inert) {
        el.inert = true;
        inerted.push(el);
      }
    }
    const restore = () => {
      for (const el of inerted) el.inert = false;
    };

    if (pass) {
      const btn = root.querySelector('.pcw-btn');
      const close = () => {
        host.remove();
        restore();
        resolve();
      };
      btn.addEventListener('click', close);
      mask.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') close();
      });
      btn.focus();
    } else {
      const card = root.querySelector('.pcw-card');
      card.tabIndex = -1;
      card.focus();
    }
  });
}
