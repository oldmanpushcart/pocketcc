/**
 * 英雄图标探针 v4（游戏页 DevTools Console 整段粘贴）。
 * v3 实锤：GL 上下文可用（cc.game._renderContext），但 cc 2.4 形态下 Texture2D 顶层无
 * _glID、无 getPixelWidth——句柄在 _texture（renderer 包装层）。本探针按修正后的取值
 * 链一次定稿：① tex._texture 全 keys + _glID/width/height/flipY 实测值；② 自建 FBO +
 * readPixels 实跑（非零像素统计）；③ 按 frame rect 裁剪转 dataURL **输出实样**（几 KB
 * 可整段贴回——落盘即可肉眼验收内容与方向）。只读零发包。
 */
(async () => {
  const out = { tex: {}, glRead: null, frameUrl: null, err: [] };
  const R = (n) => {
    try {
      return window.__require(n);
    } catch (e) {
      out.err.push('require ' + n);
      return null;
    }
  };
  const done = () => {
    console.log('=== HERO-ICON PROBE4 RESULT (整块复制) ===');
    console.log(JSON.stringify(out, null, 1));
  };

  const m = R('LoadManager');
  const LM = m && m.LoadManager && m.LoadManager.loadSpriteFrame ? m.LoadManager : null;
  if (!LM) {
    out.err.push('no LM');
    return done();
  }

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
  if (!sf) {
    out.err.push('no frame');
    return done();
  }
  const tex = sf.getTexture();
  const wrap = tex && tex._texture;
  out.tex = {
    wrapCtor: wrap && wrap.constructor && wrap.constructor.name,
    wrapKeys: wrap ? Object.keys(wrap).slice(0, 20) : [],
    glID: !!(wrap && wrap._glID instanceof WebGLTexture),
    width: wrap && typeof wrap.width === 'number' ? wrap.width : -1,
    height: wrap && typeof wrap.height === 'number' ? wrap.height : -1,
    texWidthProp: tex && typeof tex.width === 'number' ? tex.width : -1,
    flipY: tex && tex._image ? tex._image.flipY : 'n/a',
    premultiplyAlpha: tex && tex._image ? tex._image.premultiplyAlpha : 'n/a',
  };
  if (!out.tex.glID || out.tex.width < 1) return done();

  // GL 回读实跑（与生产实现同链路）
  try {
    const gl = window.cc.game._renderContext;
    const w = Math.min(out.tex.width, 2048);
    const h = Math.min(out.tex.height, 2048);
    const prevFb = gl.getParameter(gl.FRAMEBUFFER_BINDING);
    const prevActive = gl.getParameter(gl.ACTIVE_TEXTURE);
    const prevTex = gl.getParameter(gl.TEXTURE_BINDING_2D);
    const prevVp = gl.getParameter(gl.VIEWPORT);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, wrap._glID);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, wrap._glID, 0);
    const st = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (st !== gl.FRAMEBUFFER_COMPLETE) throw new Error('fbo incomplete: ' + st);
    gl.viewport(0, 0, w, h);
    const buf = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFb);
    gl.activeTexture(prevActive);
    gl.bindTexture(gl.TEXTURE_2D, prevTex);
    gl.viewport(prevVp[0], prevVp[1], prevVp[2], prevVp[3]);
    gl.deleteFramebuffer(fbo);
    let nonZero = 0;
    for (let i = 0; i < buf.length; i += 4) {
      if (buf[i] | buf[i + 1] | buf[i + 2] | buf[i + 3]) nonZero++;
    }
    out.glRead = { complete: true, w, h, nonZero, total: w * h };

    // buf → ImageData（flipY=false 直写 / true 翻转，与生产实现一致）→ rect 裁剪 → dataURL
    const r = sf.getRect();
    const cv = document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    const cx = cv.getContext('2d');
    const img = cx.createImageData(w, h);
    const row = w * 4;
    if (out.tex.flipY === true) {
      for (let y = 0; y < h; y++)
        img.data.set(buf.subarray((h - 1 - y) * row, (h - 1 - y) * row + row), y * row);
    } else {
      img.data.set(buf);
    }
    cx.putImageData(img, 0, 0);
    const cv2 = document.createElement('canvas');
    cv2.width = r.width;
    cv2.height = r.height;
    cv2.getContext('2d').drawImage(cv, r.x, r.y, r.width, r.height, 0, 0, r.width, r.height);
    const u = cv2.toDataURL('image/png');
    out.frameUrl = {
      ok: u.indexOf('data:image') === 0,
      len: u.length,
      rect: { x: r.x, y: r.y, w: r.width, h: r.height },
      dataURL: u,
    };
  } catch (e) {
    out.glRead = { err: String((e && e.message) || e) };
  }

  setTimeout(done, 100);
})();
