/**
 * ACL 域切片 · 英雄/技能图标 dataURL 加载（core/acl/hero-icon.js）
 *
 * bundle 内 SpriteFrame（image/hero_icon/<n>、image/hero_skill/<n>）DOM 面板拿不到单帧：
 * 走游戏 LoadManager.loadSpriteFrame(path, cb)（回调第二参，fixPicPath 自动剥扩展名）转 dataURL 供 <img>。
 * 转换双路径：① DOM 源（texture.getHtmlElementObj → 2d canvas 按 rect 裁剪）——探针 v2 实证
 * cc 引擎把图集源图以 ImageBitmap 上传 GPU 后释放（drawImage 报 "The image source is detached"），
 * 此路径在真机恒不可用；② GL 帧缓冲回读（自建 FBO 绑该纹理 → readPixels → 按行翻转 →
 * putImageData → rect 裁剪）——项目已验证的成熟方案（世界地图小地图抓取同款，绕开 detached），
 * 状态存取全程保存/恢复不破坏引擎渲染。
 * 真机探针实证（tools/hero-icon-probe2.devtools.js，20261121）：loadSpriteFrame err-first 双参
 * 回调 21ms 即拿到帧（CCClass[getRect] 在第二参），加载链路完全通，断点只在源图 detached。
 *
 * 缓存语义：path → dataURL（成功）/ ''（失败，落缓存——图标名不随会话变，重试无意义）/
 *   null（在途占位）。bundle 未就绪（loadManager() 未探到）不落失败缓存，下次 load 重探自愈。
 * 零发包、纯资源读；任何失败回调 ''，调用方回退文字徽章/首字占位。
 */
import { loadManager } from '../acl-engine.js';

/** @type {Object<string,string|null>} path → dataURL(''=失败) / null=在途占位 */
var cache = Object.create(null);
/** @type {Object<string,Function[]>} 在途回调队列 */
var waiters = Object.create(null);

/**
 * 收束一次加载：落/清缓存并放行全部在途回调（回调抛错吞掉，互不影响）。
 * @param {string} path bundle 资源路径
 * @param {string} url dataURL 或 ''（失败）
 * @param {boolean} keep false=不落缓存（bundle 未就绪，留待下次 load 重探）
 */
function settle(path, url, keep) {
  var ws = waiters[path];
  delete waiters[path];
  if (keep) cache[path] = url;
  else delete cache[path];
  if (ws) {
    for (var i = 0; i < ws.length; i++) {
      try {
        ws[i](url);
      } catch (e) {}
    }
  }
}

/**
 * 帧画布 → 边缘背景色 trim 后的 dataURL（dom/GL 两路共用）：图集帧 rect 常比实际画面大一圈，
 * 空隙可能是不透明白底（alpha 全满，纯 alpha-trim 裁不掉）也可能透明——帧四角采样估边缘背景色，
 * 内容 = 不透明且与背景色差超阈值的像素；bbox 小于整帧时二次裁剪到内容区。四角全透明退化为
 * 纯 alpha trim；全被判背景/getImageData 不可用（桩环境）时按原帧出图。
 */
function trimCanvasToDataURL(cv, w, h) {
  try {
    var cx = cv.getContext('2d');
    if (!cx) return '';
    var td = cx.getImageData(0, 0, w, h).data;
    var sr = 0,
      sg = 0,
      sb = 0,
      sn = 0;
    var cs = [0, (w - 1) * 4, (h - 1) * w * 4, ((h - 1) * w + w - 1) * 4];
    for (var ci = 0; ci < 4; ci++) {
      var co = cs[ci];
      if (td[co + 3] > 8) {
        sr += td[co];
        sg += td[co + 1];
        sb += td[co + 2];
        sn++;
      }
    }
    var minX = w,
      minY = h,
      maxX = -1,
      maxY = -1;
    for (var ty = 0; ty < h; ty++) {
      for (var tx = 0; tx < w; tx++) {
        var po = (ty * w + tx) * 4;
        if (td[po + 3] <= 8) continue; // 透明像素非内容
        if (sn > 0) {
          var dr = td[po] - sr / sn;
          var dg = td[po + 1] - sg / sn;
          var db = td[po + 2] - sb / sn;
          if (dr * dr + dg * dg + db * db <= 3600) continue; // 与边缘背景同色（≤60 欧氏）非内容
        }
        if (tx < minX) minX = tx;
        if (tx > maxX) maxX = tx;
        if (ty < minY) minY = ty;
        if (ty > maxY) maxY = ty;
      }
    }
    if (maxX >= 0 && (maxX - minX + 1 < w || maxY - minY + 1 < h)) {
      var bw = maxX - minX + 1;
      var bh = maxY - minY + 1;
      var cv3 = document.createElement('canvas');
      cv3.width = bw;
      cv3.height = bh;
      var cx3 = cv3.getContext('2d');
      if (cx3) {
        cx3.drawImage(cv, minX, minY, bw, bh, 0, 0, bw, bh);
        var u3 = cv3.toDataURL('image/png');
        if (u3.indexOf('data:image') === 0) return u3;
      }
    }
  } catch (e) {}
  var u = cv.toDataURL('image/png');
  return u.indexOf('data:image') === 0 ? u : '';
}

/**
 * ① DOM 源路径：texture.getHtmlElementObj → 离屏 canvas（帧 rect）→ dataURL。
 * 任一步失败回 ''（真机探针 v2：cc 把源图 close 成 detached ImageBitmap，此路径恒失败，
 * 保留作引擎改版回退与 node 桩测试路径）。
 */
function domFrameToDataURL(sf) {
  try {
    var r = sf.getRect();
    var tex = sf.getTexture();
    var el = tex && typeof tex.getHtmlElementObj === 'function' ? tex.getHtmlElementObj() : null;
    if (!el || !r || !(r.width > 0) || !(r.height > 0)) return '';
    var cv = document.createElement('canvas');
    cv.width = r.width;
    cv.height = r.height;
    var cx = cv.getContext('2d');
    if (!cx) return '';
    cx.drawImage(el, r.x, r.y, r.width, r.height, 0, 0, r.width, r.height);
    return trimCanvasToDataURL(cv, r.width, r.height);
  } catch (e) {
    return ''; // detached ImageBitmap（真机常态）等：交 GL 回读
  }
}

/**
 * cc Texture2D 的 GL 句柄（探针 v3 实锤 cc 2.4 形态）：顶层无 _glID，真句柄在 _texture
 * （renderer 包装层）的 _glID；字段名漂移时对外层/包装层逐字段扫 WebGLTexture 实例兜底。
 */
function glTextureOf(tex) {
  if (!tex || typeof WebGLTexture === 'undefined') return null; // node 桩环境无 WebGLTexture 全局
  var wrap = null;
  try {
    wrap = tex._texture; // 2.4 renderer 包装层（探针 v3 glKeys 实锤）
  } catch (e) {}
  if (tex._glID instanceof WebGLTexture) return tex._glID;
  if (wrap && wrap._glID instanceof WebGLTexture) return wrap._glID;
  var scan = (obj) => {
    for (var k in obj) {
      try {
        if (obj[k] instanceof WebGLTexture) return obj[k];
      } catch (e) {}
    }
    return null;
  };
  return scan(tex) || (wrap ? scan(wrap) : null);
}

/** 图集尺寸：2.4 无 getPixelWidth（探针 v3 实锤 -1），走 .width/.height 属性链（顶层 → renderer 包装层） */
function texSize(tex) {
  var wrap = null;
  try {
    wrap = tex && tex._texture;
  } catch (e) {}
  var pick = (o, k) => {
    if (!o) return 0;
    if (typeof o[k] === 'number' && o[k] > 0) return o[k] | 0;
    if (typeof o['get' + k[0].toUpperCase() + k.slice(1)] === 'function') {
      var v = o['get' + k[0].toUpperCase() + k.slice(1)]();
      if (typeof v === 'number' && v > 0) return v | 0;
    }
    return 0;
  };
  return {
    w: pick(tex, 'width') || pick(wrap, 'width'),
    h: pick(tex, 'height') || pick(wrap, 'height'),
  };
}

/** 游戏 WebGL 上下文：多候选字段链（cc 2.x 渲染器/设备/导演持有的 _renderContext/_gl）+ 主 canvas getContext（webgl2 优先——webgl2 canvas 上 'webgl' 返回 null，反之亦然；同 canvas 同类型返回同一上下文） */
function gameGl() {
  try {
    var g = window.cc;
    var cand = [];
    if (g && g.game) {
      cand.push(g.game._renderContext);
      if (g.game.renderer) cand.push(g.game.renderer._renderContext);
      if (g.game.renderer && g.game.renderer.device) cand.push(g.game.renderer.device._gl);
    }
    if (g && g.director) cand.push(g.director._renderContext);
    for (var i = 0; i < cand.length; i++) {
      if (cand[i] && typeof cand[i].readPixels === 'function') return cand[i];
    }
  } catch (e) {}
  try {
    var cv = (window.cc && cc.game && cc.game.canvas) || document.querySelector('canvas');
    if (cv) {
      return (
        cv.getContext('webgl2') || cv.getContext('webgl') || cv.getContext('experimental-webgl')
      );
    }
  } catch (e) {}
  return null;
}

/**
 * ② GL 帧缓冲回读：自建 FBO 绑该纹理 → readPixels 整图集 → 按行翻转（readPixels 左下原点）→
 * putImageData → 按 frame rect 裁剪 → dataURL。全程保存/恢复 GL 状态（FRAMEBUFFER_BINDING /
 * TEXTURE_BINDING_2D / ACTIVE_TEXTURE / VIEWPORT / PACK_ALIGNMENT）不破坏引擎渲染。
 * @param {object} sf SpriteFrame
 * @returns {string} dataURL；任何失败回 ''
 */
function glFrameToDataURL(sf) {
  var tex = null;
  try {
    tex = sf.getTexture();
  } catch (e) {
    return '';
  }
  var handle = glTextureOf(tex);
  if (!handle) return '';
  var size = texSize(tex);
  var w = size.w;
  var h = size.h;
  if (!(w > 0) || !(h > 0) || w * h > 16 * 1024 * 1024) return ''; // 超大图集保护
  var gl = gameGl();
  if (!gl) return '';
  var fbo = null;
  var prevFbo = null;
  var prevTex = null;
  var prevActive = null;
  var prevVp = null;
  var prevPack = null;
  var done = false;
  try {
    prevFbo = gl.getParameter(gl.FRAMEBUFFER_BINDING);
    prevTex = gl.getParameter(gl.TEXTURE_BINDING_2D);
    prevActive = gl.getParameter(gl.ACTIVE_TEXTURE);
    prevVp = gl.getParameter(gl.VIEWPORT);
    try {
      prevPack = gl.getParameter(gl.PACK_ALIGNMENT);
    } catch (e) {}
    fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, handle);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, handle, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE) {
      gl.viewport(0, 0, w, h);
      try {
        gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
      } catch (e) {}
      var buf = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      done = true;
    }
  } catch (e) {
    done = false;
  }
  // 无论成败先恢复引擎状态
  try {
    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFbo);
    if (prevActive != null) gl.activeTexture(prevActive);
    if (prevTex != null) gl.bindTexture(gl.TEXTURE_2D, prevTex);
    if (prevVp) gl.viewport(prevVp[0], prevVp[1], prevVp[2], prevVp[3]);
    if (prevPack != null) gl.pixelStorei(gl.PACK_ALIGNMENT, prevPack);
    if (fbo) gl.deleteFramebuffer(fbo);
  } catch (e) {}
  if (!done) return '';
  // buf → ImageData：flipY=false 时 GPU 纹理 v=0 行 = 上传数据首行 = CPU 顶行，buf 第 0 行
  // （readPixels 左下原点）即顶行，直写即可；flipY=true 时已反相，需按行翻转（探针 v4 实样定案）
  var flipY = false;
  try {
    flipY = !!(tex._image && tex._image.flipY);
  } catch (e) {}
  try {
    var r = sf.getRect();
    if (!r || !(r.width > 0) || !(r.height > 0)) return '';
    var cv = document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    var cx = cv.getContext('2d');
    if (!cx) return '';
    var img = cx.createImageData(w, h);
    var row = w * 4;
    if (flipY) {
      for (var y = 0; y < h; y++) {
        var src = (h - 1 - y) * row;
        img.data.set(buf.subarray(src, src + row), y * row);
      }
    } else {
      img.data.set(buf);
    }
    cx.putImageData(img, 0, 0);
    var cv2 = document.createElement('canvas');
    cv2.width = r.width;
    cv2.height = r.height;
    var cx2 = cv2.getContext('2d');
    if (!cx2) return '';
    cx2.drawImage(cv, r.x, r.y, r.width, r.height, 0, 0, r.width, r.height);
    return trimCanvasToDataURL(cv2, r.width, r.height);
  } catch (e) {
    return '';
  }
}

/** SpriteFrame → dataURL：先试 DOM 源（最便宜），'' 再走 GL 帧缓冲回读（detached 真机常态） */
function frameToDataURL(sf) {
  var u = domFrameToDataURL(sf);
  if (u) return u;
  return glFrameToDataURL(sf);
}

export const heroIcon = {
  /**
   * 英雄头像 bundle 路径（HeroData 上是 Icon getter，探针实证返回 image/hero_icon/ 完整路径、
   * 地区变体已在 getter 内处理；hero_icon 是 bond UI 数据对象的字段非 HeroData，仅作兼误兜底）。
   * @param {object|null} h HeroData
   * @returns {string}
   */
  heroPath(h) {
    try {
      var p = h && (h.Icon || h.hero_icon);
      return typeof p === 'string' ? p : '';
    } catch (e) {
      return '';
    }
  },

  /**
   * 技能图标 bundle 路径：hero_skill.skill_icon 是裸名 → 拼 image/hero_skill/ 前缀（探针实证）。
   * @param {string} rawIcon 表行 skill_icon 原值
   * @returns {string}
   */
  skillPath(rawIcon) {
    var v = String(rawIcon == null ? '' : rawIcon).trim();
    return v ? 'image/hero_skill/' + v : '';
  },

  /**
   * 同步取缓存：已就绪回 dataURL（''=已失败），在途/未开始回 null。
   * @param {string} path bundle 资源路径
   * @returns {string|null}
   */
  cached(path) {
    var p = String(path == null ? '' : path);
    return p && Object.prototype.hasOwnProperty.call(cache, p) ? cache[p] : null;
  },

  /**
   * 异步加载（fire-and-forget）：完成/失败回调 onReady(dataURL)；失败/不可加载回 ''。
   * 在途重入只挂回调不重复加载；bundle 未就绪本次回调 '' 且不落缓存（下次 load 自愈重探）。
   * @param {string} path bundle 资源路径
   * @param {(url:string)=>void} onReady
   */
  load(path, onReady) {
    var p = String(path == null ? '' : path);
    if (!p || typeof onReady !== 'function') return;
    if (waiters[p]) {
      waiters[p].push(onReady); // 在途：只挂回调
      return;
    }
    if (Object.prototype.hasOwnProperty.call(cache, p)) {
      onReady(cache[p]); // 已终态（成功 dataURL / 失败 ''）直接放行
      return;
    }
    cache[p] = null; // 占位在途（finish 时被终态覆写）
    waiters[p] = [onReady];
    var L = loadManager();
    if (!L) {
      settle(p, '', false); // bundle 未就绪：不落失败缓存，下次 load 重探
      return;
    }
    try {
      // 游戏收口 doCallbackResource 是 err-first 双参：失败 o(err,null) / 成功 o(null,asset)
      // （LoadManager 源码实锤）；特征兜底防形态漂移——谁有 getRect 谁是帧
      L.loadSpriteFrame(p, function (err, sf) {
        var frame =
          sf && typeof sf.getRect === 'function'
            ? sf
            : err && typeof err.getRect === 'function'
              ? err
              : null;
        settle(p, frame ? frameToDataURL(frame) : '', true);
      });
    } catch (e) {
      settle(p, '', true); // 收口本身抛错：真失败，落缓存
    }
  },
};
