/**
 * ACL 域切片 · 邮件只读缓存 / 原生拉取（core/acl/mail.js）
 * 原 core/game-api.js 的 mail 区段（含 mailManager/mailGroupValue helper），
 * 按域拆分片3逐字迁出（行为零变化）。全部只读，不改写邮件状态。
 */
import { game } from '../game.js';
import { SYM, probe } from '../acl-engine.js';

// ─────────────────────── 邮件（只读缓存 / 原生拉取） ───────────────────────

/**
 * 邮件管理器（MailData.mailManager = NMailModel 实例）：由 subpack/SubpackMain 载入时挂上，
 * 早于它探测会拿不到——probe 失败不缓存，下次调用自愈重探。
 * @returns {object|null}
 */
function mailManager() {
  return probe('MailData.mailManager', () => {
    var m = game.get(SYM.modules.mailData);
    var mm = m && m.mailManager;
    return mm && typeof mm.getGroupMails === 'function' ? mm : null;
  });
}

/**
 * 展示分组语义名 → MailShowGroupType 数值。
 * ❗当前运行时实证 MailShowGroupType 成员名用 `t_` 前缀（t_alliance=1 / t_active=2 / t_system=3 / t_battle=4 / t_collect=5 /
 *   t_battle_pve=6 / t_store=7，另有 NULL=-1），并非早期误记的 `type_owner=1`（那是另一个枚举）。为不再因前缀漂移而静默失效，
 *   这里按「去掉 t_/type_ 前缀后的基名」不区分大小写匹配成员，且只认正数分组值（跳过 NULL 与 TS 反查的数字键）。
 * @param {string} name 分组语义基名（如 'alliance'/'system'，不带前缀）
 * @returns {number} 枚举值，未命中 0
 */
function mailGroupValue(name) {
  var m = game.get(SYM.modules.mailData);
  var E = m && m.MailShowGroupType;
  if (!E || !name) return 0;
  var want = String(name).toLowerCase();
  for (var k in E) {
    var v = E[k];
    if (typeof v !== 'number' || v <= 0) continue; // 只认成员键（数字反查键的值是字符串；NULL=-1 不算分组）
    if (k.replace(/^t(ype)?_/i, '').toLowerCase() === want) return v;
  }
  return 0;
}

/**
 * 邮件只读能力：读游戏内存缓存（group/all，零发包）与走游戏原生 933 MAIL_nGetGroupList 拉取（load）。
 * 不调任何 Delete/Read/Favorite 类改写方法（只读+发包红线）；load 也只是拉列表进游戏缓存，与玩家点开邮件面板同源。
 */
export const mail = {
  /**
   * 邮件管理器（mailManager）是否已就绪：mailManager 由 SubpackMain.main()（subpack 载入）挂上，
   * 晚于核心与部分 feat 的 run 时机。纯读探测（复用 mailManager 的 probe 缓存），供调用方在未就绪时延后重试，
   * 而非把「此刻读不到缓存」误当成永久能力缺失。
   * @returns {boolean} mailManager 在场且可 getGroupMails 则为 true
   */
  ready() {
    return !!mailManager();
  },
  /**
   * 某展示分组的邮件列表（游戏缓存，纯读）。分组实证：DATACONFIG 130157 把 mailType 归组（'1|9' ⇒ 分组值 1=t_alliance 含 mailType 9），
   * 故「遗迹区域刷新」（mailType 9）在 t_alliance(=1) 组里。
   * @param {string} name 分组语义基名（'alliance'/'system'/'store'…，不带 t_/type_ 前缀）
   * @returns {object[]} 邮件数组（{title,content,sendTime,mailType,…}），符号/分组缺失回 []
   */
  group(name) {
    var g = mailGroupValue(name);
    var mm = mailManager();
    if (!g || !mm) return [];
    try {
      var list = mm.getGroupMails(g);
      return Array.isArray(list) ? list : [];
    } catch (e) {
      return [];
    }
  },
  /**
   * 全部分组邮件扁平去重（按 mailId，sendTime 降序）：免调用方逐组点名，也免赌「某邮件在哪组」。
   * @returns {object[]}
   */
  all() {
    var mm = mailManager();
    if (!mm) return [];
    var m = game.get(SYM.modules.mailData);
    var E = (m && m.MailShowGroupType) || null;
    var out = [];
    var seen = new Set();
    var groups = new Set();
    // 按枚举「成员键→正数分组值」收集全部展示分组（当前实证 t_alliance=1..t_store=7）：不依赖成员名前缀，
    //   也自然跳过 TS 反查的数字键（其值为字符串）与 NULL=-1。
    if (E) {
      for (var key in E) {
        var gv = E[key];
        if (typeof gv === 'number' && gv > 0) groups.add(gv);
      }
    }
    groups.forEach(function (v) {
      var list;
      try {
        list = mm.getGroupMails(v);
      } catch (e) {
        return;
      }
      if (!Array.isArray(list)) return;
      for (var i = 0; i < list.length; i++) {
        var mail0 = list[i];
        if (!mail0) continue;
        var id = String(mail0.mailId == null ? mail0.id || '' : mail0.mailId);
        if (id) {
          if (seen.has(id)) return;
          seen.add(id);
        }
        out.push(mail0);
      }
    });
    out.sort(function (a, b) {
      return (Number(b && b.sendTime) || 0) - (Number(a && a.sendTime) || 0);
    });
    return out;
  },
  /**
   * 拉某分组邮件进游戏缓存（原生 NMailModel.loadGroupMails → 933，首页翻页请求）。
   * 永不 reject：符号缺失/抛错/超时无回调一律回 false，调用方自行降级。
   * @param {string} name 分组语义名
   * @param {number} [timeoutMs] 回调超时（默认 10s，游戏回调在其内部 setTimeout 里投递）
   * @returns {Promise<boolean>} 是否拉到（回调已达）
   */
  load(name, timeoutMs) {
    var g = mailGroupValue(name);
    var mm = mailManager();
    if (!g || !mm || typeof mm.loadGroupMails !== 'function') return Promise.resolve(false);
    return new Promise(function (resolve) {
      var done = false;
      var finish = function (ok) {
        if (done) return;
        done = true;
        resolve(ok);
      };
      var timer = setTimeout(function () {
        finish(false);
      }, timeoutMs || 10000);
      try {
        mm.loadGroupMails(g, {
          callback: function () {
            clearTimeout(timer);
            finish(true);
          },
        });
      } catch (e) {
        clearTimeout(timer);
        finish(false);
      }
    });
  },
};
