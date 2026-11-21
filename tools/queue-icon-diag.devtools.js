/**
 * 队列技能图标「留白」取证探针 v6（不依赖扩展构建产物，控制台整段粘贴即可）。
 *
 * 用法：面板展开「队列技能」→ 游戏页 DevTools Console 整段粘贴运行 → 把输出的 JSON 全部贴回。
 *
 * 判读口径（每条 samples 是 9 个 RGBA 采样：左上/右上/左下/右下/上中/下中/左中/右中/中心）：
 * - 四角与边中点 = 255,255,255,255（不透明白）而中心是内容色 → 留白是不透明白像素、trim 未生效
 *   （页面还在跑旧脚本：chrome://extensions 重载 + Ctrl+F5 两步都要做）
 * - 四角与边中点 = x,x,x,0（透明）→ 留白是透明像素、trim 未生效（同上）
 * - 四角/边中点已是内容色（非白非透明）→ trim 已生效，剩余留白是图标美术设计自带的圆角间隙，
 *   属视觉层问题（改 CSS：缩框/去白底衬），不该再动回读管线
 * - natural 宽高比明显偏离 1:1 且与 rect 不符 → 帧裁剪坐标形态问题，另行分析
 */
(() => {
  // 面板挂在 #pocketcc-host 的 open shadow root 里（core/ui/index.js mountUI），document 直查不到
  const host = document.getElementById('pocketcc-host');
  const root = host && host.shadowRoot;
  if (!root) {
    console.log('[diag6] 没找到 #pocketcc-host.shadowRoot（面板未挂载？）');
    return;
  }
  const all = [...root.querySelectorAll('.pc-fqico')];
  const imgs = all.filter((i) => i.src.startsWith('data:'));
  if (!imgs.length) {
    console.log(
      '[diag6] 页面上没有已出图的 .pc-fqico（共扫到 ' +
        all.length +
        ' 个占位，先展开队列技能面板再运行）',
    );
    return;
  }
  const cv = document.createElement('canvas');
  const cx = cv.getContext('2d', { willReadFrequently: true });
  const out = [];
  let pending = Math.min(imgs.length, 8);
  const finish = () => {
    if (pending === 0) console.log(JSON.stringify(out, null, 1));
  };
  imgs.slice(0, 8).forEach((im, i) => {
    const image = new Image();
    image.onload = () => {
      try {
        const W = image.width;
        const H = image.height;
        cv.width = W;
        cv.height = H;
        cx.clearRect(0, 0, W, H);
        cx.drawImage(image, 0, 0);
        const px = (x, y) => [...cx.getImageData(x, y, 1, 1).data].join(',');
        out.push({
          i,
          natural: W + 'x' + H,
          srcLen: im.src.length,
          samples: {
            tl: px(0, 0),
            tr: px(W - 1, 0),
            bl: px(0, H - 1),
            br: px(W - 1, H - 1),
            tm: px(W >> 1, 0),
            bm: px(W >> 1, H - 1),
            lm: px(0, H >> 1),
            rm: px(W - 1, H >> 1),
            c: px(W >> 1, H >> 1),
          },
        });
      } catch (e) {
        out.push({ i, err: String(e && e.message ? e.message : e) });
      }
      pending--;
      finish();
    };
    image.onerror = () => {
      out.push({ i, err: 'img load failed' });
      pending--;
      finish();
    };
    image.src = im.src;
  });
  setTimeout(() => {
    if (pending > 0) console.log('[diag6] 超时（部分图未 onload）', JSON.stringify(out, null, 1));
  }, 4000);
})();
