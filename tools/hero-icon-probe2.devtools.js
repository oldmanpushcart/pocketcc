/**
 * 英雄图标探针 v2（游戏页 DevTools Console 整段粘贴）。
 * v1 的 C/D 段因 LM 形态判定失败全部 skip，回调签名与 dataURL 原型至今未实测；
 * 本轮三段一次隔离：A. LM 解析（已知具名导出形态）→ B. loadSpriteFrame 实调
 * （记录回调实参形状：argc/谁有 getRect/错误消息）→ C. 帧转 dataURL 分步原型
 * （rect/tex/el/drawImage/toDataURL 每步成败）。另附 D. 游戏原生 setSpriteFrame
 * 对照（验证游戏自己的加载链路是否可用，隔离「原生加载行不行」vs「转 dataURL 行不行」）。
 * 只读零发包。
 */
(async () => {
  const out = { lm: {}, load: [], convert: [], native: null, err: [] };
  const R = (n) => {
    try {
      return window.__require(n);
    } catch (e) {
      out.err.push('require ' + n + ': ' + e);
      return null;
    }
  };

  // A. LM 多形态解析（与 ACL 候选序列同口径）
  const m = R('LoadManager');
  const LM =
    (m &&
      (m.loadSpriteFrame
        ? m
        : m.LoadManager && m.LoadManager.loadSpriteFrame
          ? m.LoadManager
          : m.default && m.default.loadSpriteFrame
            ? m.default
            : m.default && m.default.LoadManager && m.default.LoadManager.loadSpriteFrame
              ? m.default.LoadManager
              : null)) ||
    null;
  out.lm = {
    hasEnv: !!m,
    envelopeKeys: m ? Object.keys(m).slice(0, 8) : [],
    resolved: !!LM,
    hasLoadSpriteFrame: !!(LM && typeof LM.loadSpriteFrame === 'function'),
    hasSetSpriteFrame: !!(LM && typeof LM.setSpriteFrame === 'function'),
  };
  if (!out.lm.hasLoadSpriteFrame) {
    console.log('=== HERO-ICON PROBE2 RESULT (整块复制) ===');
    console.log(JSON.stringify(out, null, 1));
    return;
  }

  const desc = (v) =>
    v == null
      ? String(v)
      : typeof v === 'object'
        ? ((v.constructor && v.constructor.name) || 'obj') +
          (typeof v.getRect === 'function' ? '[getRect]' : '') +
          (typeof v.message === 'string' ? '[msg:' + String(v.message).slice(0, 50) + ']' : '')
        : typeof v;

  // B. 实调 + C. 分步转换（回调里一次完成，两图标样本）
  const probeOne = (path) => {
    try {
      const t0 = Date.now();
      LM.loadSpriteFrame(path, function () {
        const a0 = arguments[0];
        const a1 = arguments[1];
        const sf =
          a0 && typeof a0.getRect === 'function'
            ? a0
            : a1 && typeof a1.getRect === 'function'
              ? a1
              : null;
        out.load.push({
          path: path,
          argc: arguments.length,
          a0: desc(a0),
          a1: desc(a1),
          sfAt: sf === a0 ? 0 : sf === a1 ? 1 : -1,
          ms: Date.now() - t0,
        });
        if (!sf) return;
        try {
          const r = sf.getRect();
          const tex = sf.getTexture();
          const el =
            tex && typeof tex.getHtmlElementObj === 'function' ? tex.getHtmlElementObj() : null;
          const steps = {
            path: path,
            rect: r ? { w: r.width, h: r.height } : String(r),
            tex: !!tex,
            elTag: el ? el.tagName || '(canvas)' : String(el),
            elSize: el ? { w: el.width, h: el.height } : null,
          };
          if (!el || !r || !(r.width > 0)) {
            steps.fail = 'no el/rect';
            out.convert.push(steps);
            return;
          }
          const cv = document.createElement('canvas');
          cv.width = r.width;
          cv.height = r.height;
          const cx = cv.getContext('2d');
          if (!cx) {
            steps.fail = 'no 2d ctx';
            out.convert.push(steps);
            return;
          }
          cx.drawImage(el, r.x, r.y, r.width, r.height, 0, 0, r.width, r.height);
          const u = cv.toDataURL('image/png');
          steps.urlLen = u ? u.length : 0;
          steps.urlHead = u ? u.slice(0, 40) : '';
          out.convert.push(steps);
        } catch (e) {
          out.convert.push({ path: path, fail: 'convert: ' + ((e && e.message) || e) });
        }
      });
    } catch (e) {
      out.err.push('load ' + path + ': ' + e);
    }
  };
  probeOne('image/hero_icon/hero_icon001_cn');
  probeOne('image/hero_skill/skill_icon020');

  // D. 游戏原生 setSpriteFrame 对照（new cc.Sprite 交给游戏自己填，验证原生链路）
  try {
    const sp = new cc.Sprite();
    LM.setSpriteFrame('image/hero_icon/hero_icon002', sp, function () {
      out.native = {
        spriteFrameSet: !!(sp.spriteFrame && sp.spriteFrame.getRect),
        argc: arguments.length,
        a0: desc(arguments[0]),
      };
    });
  } catch (e) {
    out.native = { err: String((e && e.message) || e) };
  }

  setTimeout(() => {
    console.log('=== HERO-ICON PROBE2 RESULT (整块复制) ===');
    console.log(JSON.stringify(out, null, 1));
  }, 3000);
})();
