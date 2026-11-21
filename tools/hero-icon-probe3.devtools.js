/**
 * 英雄图标探针 v3（游戏页 DevTools Console 整段粘贴）。
 * GL 回读上线后仍不出图，本探针把 GL 路径每一步落成实测值：① GL 上下文各候选字段
 * 实际存在性与 canvas 清单；② Texture2D 的 GL 句柄（_glID/全字段扫）；③ 自建 FBO +
 * readPixels 实跑（含非零像素统计——区分「句柄拿到但读回全黑」与「句柄都没有」）；
 * ④ 图集源图 CDN 直链挖取（texture._image 的 nativeUrl/_nativeUrl/src 多形态）；
 * ⑤ 若拿到直链，完整验证 CORS crossOrigin 加载 → toDataURL（全新备选路：绕开 GL，
 * 直链 + getRect 裁帧）。只读零发包。
 */
(async () => {
  const out = {
    frame: null,
    tex: {},
    glCands: {},
    canvases: [],
    glRead: null,
    url: {},
    cors: null,
    err: [],
  };
  const R = (n) => {
    try {
      return window.__require(n);
    } catch (e) {
      out.err.push('require ' + n);
      return null;
    }
  };
  const done = () => {
    console.log('=== HERO-ICON PROBE3 RESULT (整块复制) ===');
    console.log(JSON.stringify(out, null, 1));
  };

  const m = R('LoadManager');
  const LM = m && m.LoadManager && m.LoadManager.loadSpriteFrame ? m.LoadManager : null;
  if (!LM) {
    out.err.push('no LM');
    return done();
  }

  // 1. 拿一帧
  const sf = await new Promise((res) => {
    try {
      LM.loadSpriteFrame('image/hero_icon/hero_icon001_cn', function (e, s) {
        res(
          s && typeof s.getRect === 'function'
            ? s
            : e && typeof e.getRect === 'function'
              ? e
              : null,
        );
      });
    } catch (e) {
      out.err.push('load: ' + e);
      res(null);
    }
  });
  out.frame = {
    got: !!sf,
    rect: sf
      ? (() => {
          const r = sf.getRect();
          return { x: r.x, y: r.y, w: r.width, h: r.height };
        })()
      : null,
  };
  if (!sf) return done();
  const tex = sf.getTexture();
  out.tex = {
    ctor: tex && tex.constructor && tex.constructor.name,
    glKeys: tex
      ? Object.keys(tex)
          .filter((k) => /gl|tex/i.test(k))
          .slice(0, 12)
      : [],
    glID: !!(tex && tex._glID instanceof WebGLTexture),
    anyGLKey: (() => {
      try {
        if (!tex) return null;
        for (const k in tex) if (tex[k] instanceof WebGLTexture) return k;
      } catch (e) {}
      return null;
    })(),
    pixelW: tex && tex.getPixelWidth ? tex.getPixelWidth() : -1,
    pixelH: tex && tex.getPixelHeight ? tex.getPixelHeight() : -1,
  };

  // 2. GL 上下文候选实测
  const t = (name, fn) => {
    try {
      const v = fn();
      out.glCands[name] = v === undefined ? 'undef' : v;
    } catch (e) {
      out.glCands[name] = 'err:' + ((e && e.message) || e).slice(0, 40);
    }
  };
  t(
    'cc.game._renderContext',
    () => !!(window.cc.game._renderContext && window.cc.game._renderContext.readPixels),
  );
  t(
    'cc.game.renderer._renderContext',
    () =>
      !!(
        window.cc.game.renderer &&
        window.cc.game.renderer._renderContext &&
        window.cc.game.renderer._renderContext.readPixels
      ),
  );
  t(
    'cc.game.renderer.device._gl',
    () =>
      !!(
        window.cc.game.renderer &&
        window.cc.game.renderer.device &&
        window.cc.game.renderer.device._gl &&
        window.cc.game.renderer.device._gl.readPixels
      ),
  );
  t(
    'cc.director._renderContext',
    () => !!(window.cc.director._renderContext && window.cc.director._renderContext.readPixels),
  );
  out.canvases = [...document.querySelectorAll('canvas')].map((c, i) => ({
    i,
    w: c.width,
    h: c.height,
  }));
  t('cc.game.canvas', () => !!(window.cc.game.canvas && window.cc.game.canvas.width));
  try {
    const main = window.cc.game.canvas || document.querySelector('canvas');
    if (main) {
      out.glCands.mainCtxWebGL2 = !!main.getContext('webgl2');
      out.glCands.mainCtxWebGL1 = !!main.getContext('webgl');
    }
  } catch (e) {
    out.glCands.mainCtx = 'err:' + ((e && e.message) || e).slice(0, 40);
  }

  // 3. GL readPixels 实测（首个可用候选；readPixels 后统计非零像素数）
  try {
    const gl = [
      window.cc.game._renderContext,
      window.cc.game.renderer && window.cc.game.renderer._renderContext,
      window.cc.game.renderer &&
        window.cc.game.renderer.device &&
        window.cc.game.renderer.device._gl,
      window.cc.director && window.cc.director._renderContext,
    ].find((g) => g && typeof g.readPixels === 'function');
    if (!gl) throw new Error('no usable gl');
    const handle = tex._glID;
    if (!handle) throw new Error('no _glID');
    const w = Math.min(tex.getPixelWidth(), 2048);
    const h = Math.min(tex.getPixelHeight(), 2048);
    const prevFb = gl.getParameter(gl.FRAMEBUFFER_BINDING);
    const prevActive = gl.getParameter(gl.ACTIVE_TEXTURE);
    const prevTex = gl.getParameter(gl.TEXTURE_BINDING_2D);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, handle);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, handle, 0);
    const st = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    let nonZero = 0;
    if (st === gl.FRAMEBUFFER_COMPLETE) {
      const buf = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      for (let i = 0; i < buf.length; i += 4) {
        if (buf[i] | buf[i + 1] | buf[i + 2] | buf[i + 3]) nonZero++;
      }
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFb);
    gl.activeTexture(prevActive);
    gl.bindTexture(gl.TEXTURE_2D, prevTex);
    gl.deleteFramebuffer(fbo);
    out.glRead = {
      which: st === gl.FRAMEBUFFER_COMPLETE ? 'complete' : 'incomplete:' + st,
      w,
      h,
      nonZero,
      total: w * h,
    };
  } catch (e) {
    out.glRead = { err: String((e && e.message) || e) };
  }

  // 4. 图集源图 CDN 直链候选（绕开 GL 的备选路）
  try {
    const im = tex._image;
    out.url = {
      imageCtor: im && im.constructor && im.constructor.name,
      nativeUrl: im ? im.nativeUrl || '' : '',
      _nativeUrl: im ? im._nativeUrl || '' : '',
      src: im ? im.src || '' : '',
      bitmapUrl: im && im.url ? im.url : '',
      keys: im ? Object.keys(im).slice(0, 14) : [],
    };
  } catch (e) {
    out.url = { err: String(e) };
  }

  // 5. CORS 直链完整验证（拿到哪个 url 用哪个）
  try {
    const u0 = out.url.nativeUrl || out.url._nativeUrl || out.url.src || out.url.bitmapUrl || '';
    if (u0 && typeof u0 === 'string') {
      out.cors = await new Promise((res) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
          try {
            const cv = document.createElement('canvas');
            cv.width = img.width;
            cv.height = img.height;
            cv.getContext('2d').drawImage(img, 0, 0);
            const d = cv.toDataURL('image/png');
            res({
              ok: d.indexOf('data:image') === 0,
              len: d.length,
              w: img.width,
              h: img.height,
              head: d.slice(0, 30),
            });
          } catch (e) {
            res({ err: String((e && e.message) || e).slice(0, 60) });
          }
        };
        img.onerror = () => res({ err: 'img load fail' });
        img.src = u0;
      });
    } else out.cors = { skip: 'no url candidate' };
  } catch (e) {
    out.cors = { err: String(e) };
  }

  setTimeout(done, 300);
})();
