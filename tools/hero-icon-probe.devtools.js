/* pocketcc 真机探针：英雄头像/技能图标资源链（队列技能徽章二期前置）。
 * 用法：游戏页面（warh5.rivergame.net/webgame）DevTools Console 整段粘贴回车，
 * 等输出 JSON 后整块复制贴回会话。只读：只 loadRes 不发包、不改任何游戏状态。
 *
 * 源码已证（LoadManager/PathUtils 逆向）：
 *   loadSpriteFrame(path, cb) 第二参回调 → fixPicPath 剥扩展名 + UI/hero_icon→image/hero_icon 重写；
 *   英雄头像 HeroData.hero_icon getter、玩家头像走 headpic 目录（PathUtils.GetIconURL）。
 * 本探针要拿的运行时数据：
 *   ① HeroData getter 值形态（hero_icon/Icon/icon_harmony/avatar_icon）
 *   ② hero_skill 表行 icon 相关字段名与值
 *   ③ loadSpriteFrame 实际加载结果（帧 rect/纹理尺寸）
 *   ④ SpriteFrame→canvas→dataURL 原型可行性（DOM <img> 渲染的关键一步）
 */
(async () => {
  const out = { env: {}, heroIcon: [], skillRow: null, loadTry: [], dataUrl: null, err: [] };
  const R = (n) => {
    try {
      return window.__require(n);
    } catch (e) {
      out.err.push('require ' + n + ': ' + e);
      return null;
    }
  };
  const DC = R('DataCenter'),
    TB = R('TableManager'),
    LMr = R('LoadManager'),
    GD = R('GlobalData');
  // 导出信封多形态兜底（顶层静态 / .default 类 / 具名 a.LoadManager）；单路径硬编码会整段静默 skip
  const pickLM = (x) => (x && typeof x.loadSpriteFrame === 'function' ? x : null);
  const LM =
    LMr &&
    (pickLM(LMr) ||
      pickLM(LMr.default) ||
      pickLM(LMr.LoadManager) ||
      (LMr.default && pickLM(LMr.default.LoadManager)));
  out.env.require = typeof window.__require;
  out.env.hasDC = !!DC;
  out.env.hasTB = !!(TB && TB.TABLE);
  out.env.hasLM = !!LM;
  out.env.LMkeys = LMr ? Object.keys(LMr).slice(0, 12) : null; // 血缘：信封顶层成员清单
  try {
    const g = GD && GD.GLOBAL;
    out.env.ResourceUrl = g && (g.ResourceUrl || '').slice(0, 90);
  } catch (e) {
    out.err.push('GLOBAL: ' + e);
  }

  // A. HeroData getter 形态（取 3 个英雄）
  try {
    const heros = DC && DC.DATA && DC.DATA.UserData && DC.DATA.UserData.Heros;
    const keys = heros ? Object.keys(heros).slice(0, 3) : [];
    for (const k of keys) {
      const h = heros[k];
      const pick = (f) => {
        try {
          return typeof f === 'function' ? undefined : f;
        } catch (e) {
          return 'ERR:' + e;
        }
      };
      out.heroIcon.push({
        id: h && h.Id,
        name: h && h.name,
        Icon: pick(h && h.Icon),
        hero_icon: pick(h && h.hero_icon),
        icon_harmony: pick(h && h.icon_harmony),
        avatar_icon: pick(h && h.avatar_icon),
      });
    }
  } catch (e) {
    out.err.push('heroIcon: ' + e);
  }

  // B. hero_skill 表行 icon 相关字段（样本 21205/20205/20301）
  try {
    const E = (TB && TB.TableName) || {};
    const tn = E.HEROSKILL || 'hero_skill';
    const ids = ['21205', '20205', '20301'];
    const rows = [];
    for (const id of ids) {
      const t = TB.TABLE.getTableDataById(tn, id);
      if (!t) {
        rows.push({ id, miss: true });
        continue;
      }
      const iconKeys = Object.keys(t).filter((k) => /icon|img|image|res|pic|icon_id/i.test(k));
      const row = { id, keys: iconKeys };
      for (const k of iconKeys) row[k] = t[k];
      rows.push(row);
    }
    out.skillRow = rows;
  } catch (e) {
    out.err.push('skillRow: ' + e);
  }

  // C. loadSpriteFrame 试加载（游戏收口，回调第二参；探针喂 getter/表行原样值 + 拼段兜底）
  const tryLoad = (label, path) =>
    new Promise((res) => {
      let done = false;
      const fin = (v) => {
        if (!done) {
          done = true;
          res(Object.assign({ label, path }, v));
        }
      };
      try {
        if (!LM) {
          fin({ skip: 'no LM.loadSpriteFrame' });
          return;
        }
        if (!path) {
          fin({ skip: 'no path' });
          return;
        }
        LM.loadSpriteFrame(path, (sf) => {
          try {
            if (!sf) {
              fin({ miss: true });
              return;
            }
            const r = typeof sf.getRect === 'function' ? sf.getRect() : null;
            const tex = typeof sf.getTexture === 'function' ? sf.getTexture() : null;
            fin({
              rect: r && { x: r.x, y: r.y, w: r.width, h: r.height },
              texW: tex && tex.width,
              texH: tex && tex.height,
            });
          } catch (e) {
            fin({ err: String(e) });
          }
        });
        setTimeout(() => fin({ timeout: true }), 6000);
      } catch (e) {
        fin({ err: String(e) });
      }
    });

  const hi = out.heroIcon.find((x) => x.hero_icon) || out.heroIcon[0] || {};
  if (hi.hero_icon) out.loadTry.push(await tryLoad('hero-as-is', hi.hero_icon));
  const sr = (out.skillRow || []).find((r) => r.keys && r.keys.length) || null;
  if (sr) {
    for (const k of sr.keys.slice(0, 2)) {
      if (sr[k]) out.loadTry.push(await tryLoad('skill-' + k + '-as-is', sr[k]));
      out.loadTry.push(
        await tryLoad(
          'skill-' + k + '-dir',
          'image/hero_skill/' + String(sr[k]).replace(/(.*)\.[^/]+$/, '$1'),
        ),
      );
    }
  }

  // D. SpriteFrame→dataURL 原型（DOM <img> 渲染关键步；只输出前 48 字符+长度，验证可行性）
  try {
    const first = out.loadTry.find((x) => x.rect);
    if (first) {
      // 重新拿一帧绘制（tryLoad 里没存 frame 引用，这里按同路径再 load 一次——bundle 已缓存零开销）
      await new Promise((res) => {
        LM.loadSpriteFrame(first.path, (sf) => {
          try {
            if (!sf) {
              res();
              return;
            }
            const r = sf.getRect();
            const tex = sf.getTexture();
            const el = typeof tex.getHtmlElementObj === 'function' ? tex.getHtmlElementObj() : null;
            if (!el) {
              out.dataUrl = { skip: 'no html element (may be compressed tex)' };
              res();
              return;
            }
            const cv = document.createElement('canvas');
            cv.width = r.width;
            cv.height = r.height;
            const cx = cv.getContext('2d');
            cx.drawImage(el, r.x, r.y, r.width, r.height, 0, 0, r.width, r.height);
            const u = cv.toDataURL('image/png');
            out.dataUrl = { len: u.length, head: u.slice(0, 48), ok: u.startsWith('data:image') };
            res();
          } catch (e) {
            out.dataUrl = { err: String(e) };
            res();
          }
        });
        setTimeout(res, 6000);
      });
    } else out.dataUrl = { skip: 'no loaded frame to convert' };
  } catch (e) {
    out.dataUrl = { err: String(e) };
  }

  console.log('=== HERO-ICON PROBE RESULT (整块复制) ===');
  console.log(JSON.stringify(out, null, 1));
})();
