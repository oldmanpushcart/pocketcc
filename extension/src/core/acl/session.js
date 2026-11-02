/**
 * ACL 域切片 · 会话登出（core/acl/session.js）
 * 原 core/game-api.js 的 session 区段，按域拆分片2逐字迁出（行为零变化）。
 */
import { game } from '../game.js';
import { SYM, probe } from '../acl-engine.js';

export const session = {
  /** 触发游戏登出（PlatformCore.instance.userLogout）；符号缺失记 warn 静默 */
  logout() {
    var p = probe('PlatformCore.instance', () => {
      var m = game.get(SYM.modules.platformCore);
      return (m && m.instance) || null;
    });
    if (!p || typeof p.userLogout !== 'function') return;
    p.userLogout();
  },
};
