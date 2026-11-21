// heroIcon（acl/hero-icon.js）单测：缓存语义 + 路径换算 + 失败回退。
// 桩环境下 loadManager() 恒 null（游戏 bundle 未就绪的形态），借此覆盖「不落失败缓存、下次重探」分支。
// 浏览器全局最小桩化同 tests/core/ui/field-types.test.js 范式。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reprobe } from '../../../extension/src/core/acl-engine.js';

globalThis.window = globalThis.window || {
  addEventListener() {},
  removeEventListener() {},
  location: { href: '' },
  document: {},
};
globalThis.document = globalThis.document || {
  // canvas 感知桩：frameToDataURL 全链（getContext/drawImage/toDataURL）可跑通，
  // 使 load→err-first 回调→dataURL 落缓存用例能断言到产物
  createElement: (tag) =>
    tag === 'canvas'
      ? {
          width: 0,
          height: 0,
          getContext: () => ({ drawImage() {} }),
          toDataURL: () => 'data:image/png;base64,FAKE',
        }
      : { style: {}, setAttribute() {}, appendChild() {} },
  head: { appendChild() {} },
  body: { appendChild() {} },
  addEventListener() {},
  querySelector: () => null,
};
globalThis.chrome = globalThis.chrome || {
  runtime: { id: 'test', sendMessage() {}, getURL: (s) => s, onMessage: { addListener() {} } },
};

const { heroIcon } = await import('../../../extension/src/core/acl/hero-icon.js');

test('heroPath：Icon getter 优先（探针实证 HeroData 头像在 Icon），hero_icon 仅作兼误兜底；抛错回空串', () => {
  assert.equal(
    heroIcon.heroPath({ Icon: 'image/hero_icon/hero_icon002' }),
    'image/hero_icon/hero_icon002',
  );
  assert.equal(
    heroIcon.heroPath({ hero_icon: 'image/hero_icon/legacy' }),
    'image/hero_icon/legacy',
  );
  assert.equal(
    heroIcon.heroPath({ Icon: 'image/hero_icon/a', hero_icon: 'image/hero_icon/b' }),
    'image/hero_icon/a',
  );
  assert.equal(heroIcon.heroPath({ Icon: '' }), '');
  assert.equal(heroIcon.heroPath(null), '');
  assert.equal(
    heroIcon.heroPath({
      get Icon() {
        throw new Error('platform missing');
      },
    }),
    '',
  );
});

test('skillPath：裸名拼 image/hero_skill/ 前缀；空值回空串', () => {
  assert.equal(heroIcon.skillPath('skill_icon020'), 'image/hero_skill/skill_icon020');
  assert.equal(heroIcon.skillPath('  skill_icon020 '), 'image/hero_skill/skill_icon020');
  assert.equal(heroIcon.skillPath(''), '');
  assert.equal(heroIcon.skillPath(null), '');
});

test('load：bundle 未就绪时回调空串且不落失败缓存（二次 load 重探语义）', () => {
  let calls = 0;
  heroIcon.load('image/hero_icon/hero_icon001_cn', (url) => {
    calls++;
    assert.equal(url, '');
  });
  assert.equal(calls, 1);
  assert.equal(heroIcon.cached('image/hero_icon/hero_icon001_cn'), null); // 未落失败缓存
  heroIcon.load('image/hero_icon/hero_icon001_cn', () => calls++); // 第二次仍重探（仍回调）
  assert.equal(calls, 2);
});

test('load：空路径/非法回调直接短路', () => {
  let called = false;
  heroIcon.load('', () => (called = true));
  assert.equal(called, false);
  heroIcon.load('image/hero_skill/skill_icon020', 'not-a-fn'); // 不抛
  assert.equal(heroIcon.cached('image/hero_skill/skill_icon020'), null);
});

/** 在 __require 桩下清缓存跑一次 load（桩信封形态见 load-manager-forms.test.js） */
function withLM(env, path, onReady) {
  reprobe('LoadManager');
  globalThis.__require = () => env;
  try {
    heroIcon.load(path, onReady);
  } finally {
    delete globalThis.__require;
    reprobe('LoadManager');
  }
}

const FAKE_SF = () => ({
  getRect: () => ({ x: 0, y: 0, width: 10, height: 10 }),
  getTexture: () => ({ getHtmlElementObj: () => ({}) }),
});

test('load：err-first 双参回调（doCallbackResource 实锤 o(null,asset)）取帧转 dataURL 落缓存', () => {
  let got = null;
  withLM(
    {
      __esModule: true,
      LoadManager: {
        loadSpriteFrame(p, cb) {
          cb(null, FAKE_SF());
        },
      },
    },
    'image/hero_icon/hero_icon002',
    (url) => (got = url),
  );
  assert.equal(got, 'data:image/png;base64,FAKE'); // 不再把首参 null 当帧
  assert.equal(heroIcon.cached('image/hero_icon/hero_icon002'), 'data:image/png;base64,FAKE');
});

/**
 * 模拟真机 detached 链路：getHtmlElementObj 返回的元素传给 drawImage 即抛
 * （cc 把源图 close 成 detached ImageBitmap）；所有 canvas 桩均全功能，GL 回读路径正常出图。
 */
const DETACHED_EL = { detached: true };
function withDetachedDom(fn) {
  const prevCreate = globalThis.document.createElement;
  globalThis.document.createElement = (tag) => {
    if (tag !== 'canvas') return prevCreate.call(globalThis.document, tag);
    return {
      width: 0,
      height: 0,
      getContext: () => ({
        drawImage(src) {
          if (src === DETACHED_EL) {
            throw new Error("Failed to execute 'drawImage': The image source is detached");
          }
        },
        createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
        putImageData() {},
      }),
      toDataURL: () => 'data:image/png;base64,FAKE',
    };
  };
  try {
    return fn();
  } finally {
    globalThis.document.createElement = prevCreate;
  }
}

function makeFakeGl(handle) {
  const state = {
    0x8ca6: null, // FRAMEBUFFER_BINDING
    0xde1: null, // TEXTURE_BINDING_2D
    0x84e0: 0x84e0, // ACTIVE_TEXTURE
    0x0ba2: [0, 0, 800, 600], // VIEWPORT
    0x0d05: 4, // PACK_ALIGNMENT
  };
  const calls = [];
  return {
    calls,
    FRAMEBUFFER_BINDING: 0x8ca6,
    TEXTURE_BINDING_2D: 0xde1,
    ACTIVE_TEXTURE: 0x84e0,
    VIEWPORT: 0x0ba2,
    PACK_ALIGNMENT: 0x0d05,
    FRAMEBUFFER: 0x8d40,
    COLOR_ATTACHMENT0: 0x8ce0,
    TEXTURE0: 0x84e0,
    TEXTURE_2D: 0xde1,
    RGBA: 0x1908,
    UNSIGNED_BYTE: 0x1401,
    FRAMEBUFFER_COMPLETE: 0x8cd5,
    getParameter: (k) => state[k],
    createFramebuffer: () => ({ id: 'fbo1' }),
    bindFramebuffer: (t, f) => calls.push(['bindFb', f && f.id]),
    activeTexture: (u) => calls.push(['activeTex', u]),
    bindTexture: (t, h) => calls.push(['bindTex', h === handle]),
    framebufferTexture2D: () => {},
    checkFramebufferStatus: () => 0x8cd5,
    viewport: () => calls.push(['viewport']),
    pixelStorei: (k, v) => calls.push(['pack', v]),
    deleteFramebuffer: () => calls.push(['deleteFb']),
    readPixels: (x, y, w, h, f, t, buf) => {
      buf[0] = 255;
      buf[3] = 255; // 标记像素
    },
  };
}

function detachedSF() {
  return {
    getRect: () => ({ x: 0, y: 0, width: 8, height: 8 }),
    getTexture: () => ({
      getHtmlElementObj: () => DETACHED_EL, // 真机常态：源图 close 后 detached，drawImage 即抛
      _image: { flipY: false, premultiplyAlpha: false },
      _texture: { _glID: null, width: 16, height: 16 }, // cc 2.4：句柄在 _texture 包装层
    }),
  };
}

test('load：DOM 源 detached（真机常态）→ GL 帧缓冲回读兜底转 dataURL，GL 状态全程恢复', () => {
  globalThis.WebGLTexture = globalThis.WebGLTexture || class WebGLTexture {};
  const handle = new globalThis.WebGLTexture();
  const fakeGl = makeFakeGl(handle);
  const prevCc = globalThis.window.cc;
  const prevCanvas = globalThis.document.querySelector;
  globalThis.window.cc = { game: { _renderContext: fakeGl } };
  globalThis.document.querySelector = () => null; // gameGl 只走 cc.game._renderContext
  let got = null;
  try {
    got = withDetachedDom(() => {
      let r = null;
      withLM(
        {
          __esModule: true,
          LoadManager: {
            loadSpriteFrame(p, cb) {
              cb(null, {
                getRect: () => ({ x: 0, y: 0, width: 8, height: 8 }),
                getTexture: () => ({
                  getHtmlElementObj: () => DETACHED_EL, // DOM 路径先失败
                  _image: { flipY: false, premultiplyAlpha: false }, // flipY=false 直写不翻转
                  _texture: { _glID: handle, width: 16, height: 16 }, // cc 2.4 形态
                }),
              });
            },
          },
        },
        'image/hero_icon/hero_icon003',
        (url) => (r = url),
      );
      return r;
    });
  } finally {
    globalThis.window.cc = prevCc;
    globalThis.document.querySelector = prevCanvas;
  }
  assert.equal(got, 'data:image/png;base64,FAKE'); // GL 兜底出图
  // 状态恢复序列：恢复纹理单元/绑定 → viewport → pack → 删 FBO 收尾
  const seq = fakeGl.calls.map((c) => c[0]);
  assert.ok(seq.indexOf('deleteFb') === seq.length - 1);
  assert.ok(seq.indexOf('bindTex') > seq.indexOf('activeTex'));
  assert.ok(fakeGl.calls.some((c) => c[0] === 'bindFb' && c[1] === null)); // 恢复默认帧缓冲
  assert.equal(heroIcon.cached('image/hero_icon/hero_icon003'), 'data:image/png;base64,FAKE');
});

test('load：无 GL 环境（cc 未定义）且 DOM 路径失败 → 回空串落失败缓存', () => {
  const prevCc = globalThis.window.cc;
  const prevCanvas = globalThis.document.querySelector;
  delete globalThis.window.cc;
  globalThis.document.querySelector = () => null;
  let got = null;
  try {
    got = withDetachedDom(() => {
      let r = null;
      withLM(
        {
          __esModule: true,
          LoadManager: {
            loadSpriteFrame(p, cb) {
              cb(null, detachedSF());
            },
          },
        },
        'image/hero_icon/nogl',
        (url) => (r = url),
      );
      return r;
    });
  } finally {
    globalThis.window.cc = prevCc;
    globalThis.document.querySelector = prevCanvas;
  }
  assert.equal(got, '');
  assert.equal(heroIcon.cached('image/hero_icon/nogl'), '');
});

test('load：err-first 失败形态（err 非空 + asset null）回空串落失败缓存', () => {
  let got = null;
  withLM(
    {
      __esModule: true,
      LoadManager: {
        loadSpriteFrame(p, cb) {
          cb({ message: 'failed to load' }, null);
        },
      },
    },
    'image/hero_icon/broken',
    (url) => (got = url),
  );
  assert.equal(got, '');
  assert.equal(heroIcon.cached('image/hero_icon/broken'), '');
});

test('load：形态漂移兜底（sf-first 单参带 getRect 仍可取帧）', () => {
  let got = null;
  withLM(
    {
      __esModule: true,
      LoadManager: {
        loadSpriteFrame(p, cb) {
          cb(FAKE_SF());
        },
      },
    },
    'image/hero_skill/skill_icon031',
    (url) => (got = url),
  );
  assert.equal(got, 'data:image/png;base64,FAKE');
});

test('cached：未开始加载回 null（在途占位同形），不误报已失败', () => {
  assert.equal(heroIcon.cached('image/hero_skill/skill_icon099'), null);
});
