/**
 * ACL 域切片 · 本地化 / 配置表（core/acl/l10n.js）
 * 原 core/game-api.js「本地化 / 配置表」区段，按域拆分计划整体逐字迁出（行为零变化）。
 * 引擎原语（TABLE/LOCAL/tableNameEnum/probe/SYM）取自 core/acl-engine.js 共享单例；
 * 本文件属 ACL 防腐层，不得 import 领域/网络模块（dep-cruiser acl 红线覆盖 core/acl/）。
 */
import { game } from '../game.js';
import { SYM, probe, LOCAL, TABLE, tableNameEnum } from '../acl-engine.js';

export const l10n = {
  /**
   * 语言键+参数 → 游戏当前语言文本（与游戏 getText(key,...paras) 同源；查不到回键原文）。
   * @param {string} key 语言键
   * @param {...*} paras 模板参数
   * @returns {string}
   */
  text(key) {
    var args = Array.prototype.slice.call(arguments, 1);
    var L = LOCAL();
    if (!L || typeof L.getText !== 'function') return String(key);
    try {
      return String(L.getText.apply(L, [String(key)].concat(args)) || '') || String(key);
    } catch (e) {
      return String(key);
    }
  },
  /**
   * 服务器应答 '<键,参数1|参数2>' 裸串 → 译文（getNetMsgText 同源；查不到回原文）。
   * @param {*} s 应答 data 原文
   * @returns {string}
   */
  net(s) {
    s = String(s == null ? '' : s).trim();
    if (!s) return s;
    var L = LOCAL();
    if (!L || typeof L.getNetMsgText !== 'function') return s;
    try {
      return String(L.getNetMsgText(s) || '') || s;
    } catch (e) {
      return s;
    }
  },
  /**
   * 配置表行查询（只读）。
   * @param {string} semantic 语义表名（emotion/emotionNew/emojiGif/item/building）、游戏 TableName 成员名（如 'BOSS'），也可直接传游戏表名串
   * @param {*} id 行 id
   * @returns {object|null}
   */
  tableRow(semantic, id) {
    var T = TABLE();
    if (!T) return null;
    // 名字解析优先级：语义别名表 → 游戏 TableName 枚举成员（BOSS→"boss"，随游戏版本自维护）→ 原样作游戏表名
    var tn = SYM.tables[semantic];
    if (!tn) {
      var E = tableNameEnum();
      tn = (E && E[semantic]) || semantic;
    }
    try {
      return T.getTableDataById(tn, String(id)) || null;
    } catch (e) {
      return null;
    }
  },
  /**
   * 配置表整表行数组（只读，getTableGroupArray）。表未就绪/符号缺失返回 []。
   * @param {string} semantic 语义表名（同 tableRow 的名字解析优先级）
   * @returns {object[]}
   */
  tableRows(semantic) {
    var T = TABLE();
    if (!T || typeof T.getTableGroupArray !== 'function') return [];
    var tn = SYM.tables[semantic];
    if (!tn) {
      var E = tableNameEnum();
      tn = (E && E[semantic]) || semantic;
    }
    try {
      return T.getTableGroupArray(tn) || [];
    } catch (e) {
      return [];
    }
  },
  /**
   * 按**任意列**取配置表首行（只读，getTableByKeyFromBuffer）。
   * 与 tableRow 的区别不是便利而是正确性：tableRow 走 getTableDataById，只认表的**主键**；
   * 而游戏侧对若干活动表是按业务列查的（实证：mask_mystery_party 全程按 `item_id` 查，
   * UserItemCityRewardBtn/Panel、ItemData.GetDes 三处一致），主键另有其列时 tableRow 恒返回 null。
   * 表未就绪/无匹配行返回 null。游戏侧比较是宽松 `!=`（数字/字符串同值即中），此处同构；
   * 内部 getTableGroup(表名) 不带精简标志时会顺手把仍是串的原始行 parseRow 完，所以「表已加载但行未解析」
   * 的首查也能拿到对象（而 getTableDataById 只解析它命中的那一行）。
   * @param {string} semantic 语义表名（同 tableRow 的名字解析优先级）
   * @param {string} field 列名（如 'item_id'）
   * @param {*} value 列值（数字或数字串）
   * @returns {object|null}
   */
  tableRowByKey(semantic, field, value) {
    var T = TABLE();
    if (!T || typeof T.getTableByKeyFromBuffer !== 'function') return null;
    var tn = SYM.tables[semantic];
    if (!tn) {
      var E = tableNameEnum();
      tn = (E && E[semantic]) || semantic;
    }
    if (value == null || value === '') return null;
    try {
      var rows = T.getTableByKeyFromBuffer(tn, field, value);
      return Array.isArray(rows) && rows.length ? rows[0] : null;
    } catch (e) {
      return null;
    }
  },
  /**
   * 频道号 → 游戏频道显示名（chatCommon.getChatToggleConfig 文案键 + 翻译，与游戏侧栏同源）。
   * @param {number} c 频道号
   * @returns {string|null} 取不到返回 null（调用方自定衍名兜底）
   */
  channelName(c) {
    var cm = probe(SYM.modules.chatCommon + '.getChatToggleConfig', () => {
      var m = game.get(SYM.modules.chatCommon);
      return m && typeof m.getChatToggleConfig === 'function' ? m : null;
    });
    if (!cm) return null;
    try {
      return l10n.net(cm.getChatToggleConfig(+c)) || null;
    } catch (e) {
      return null;
    }
  },
};
