/**
 * 聊天窗口 · 联动跳转切片（P5）。
 * 依赖方向：jump.js → { context(状态叶子), normalize(纯函数), core }，不反向 import 任何兄弟切片。
 * 导航能力在 core/game-api nav，本层只出文案与只读战报查询（MAIL_QUERY），不触碰游戏 OpenUI（红线）。
 */
import { safeParse } from '../../../core/util.js';
import { nav } from '../../../core/game-api.js';
import { netApi } from '../../../core/net.js';
import { S, log, CMD_MAIL_QUERY } from './context.js';
import { pickField } from './normalize.js';

/**
 * 跳转执行入口：按卡片 action 调 game-api 导航；技术 err 语义键映射为用户文案。
 * @param {object} action classify 产出/信息卡坐标行的 {type:'pos'|'march', ...}
 * @returns {void}
 */
export function jumpTo(action) {
  if (!action || !S.overlay) return;
  if (action.type === 'battle') {
    queryBattle(action);
    return;
  } // 战报卡：纯只读 MAIL_QUERY 查询 + 浮层展示（见下方 queryBattle）
  var r =
    action.type === 'march'
      ? nav.flyMarch(action)
      : action.type === 'pos'
        ? nav.flyTo(action)
        : { ok: false, err: 'nomarch' };
  if (r.ok) {
    S.overlay.toast(
      action.type === 'march'
        ? '跳转行军线'
        : (action.click ? '跳转并选中 ' : '定位到 ') + action.x + ',' + action.y,
    );
    return;
  }
  S.overlay.toast(
    r.err === 'unavailable'
      ? '世界地图导航不可用'
      : r.err === 'nomarch'
        ? '该卡片暂不能直接跳转'
        : '跳转异常',
  );
}

/**
 * 点战报卡（capability=query-battle）：发 MAIL_QUERY 纯只读查询，回包解析后在浮层展示详情。
 * 全程不触碰游戏 OpenUI（红线）；action.uid/mailId 由 classify 从 llm.fuid/llm.mId 提取。
 * @param {object} action {uid, mailId}
 * @returns {Promise<void>}
 */
async function queryBattle(action) {
  if (S.battleInflight || !S.overlay) return;
  var net = netApi;
  if (!net || !action || !action.uid || !action.mailId) {
    S.overlay.toast('战报暂不可查');
    return;
  }
  S.battleInflight = true;
  try {
    var ret = await net.send(CMD_MAIL_QUERY, { uid: action.uid, mailId: action.mailId });
    var resp = safeParse(ret && ret.data);
    // 游戏口径：应答 .d 是 JSON 串，parse 后取 .mail；兼容应答体直接挂 mail / 无 .d 包裹的形态
    var inner = resp && resp.d != null ? safeParse(resp.d) : resp;
    var mail = inner && inner.mail ? inner.mail : inner;
    if (!ret || !ret.ok || !mail || typeof mail !== 'object') {
      log.info(
        'mail query empty: ok=%s respKeys=%s',
        ret && ret.ok,
        resp && Object.keys(resp).join(','),
      );
      S.overlay.toast('战报暂不可查');
      return;
    }
    S.overlay.showInfoPop('战报详情', battleRows(mail));
  } catch (e) {
    log.warn('mail query failed: %s', e && e.message);
    S.overlay.toast('战报查询失败');
  } finally {
    S.battleInflight = false;
  }
}

/**
 * 战报 mail 报头 -> showInfoPop 信息行（白名单渲染，不拉 rUrl）。
 * 真机实证：MAIL_QUERY 应答仅报头（title/reportId/rUrl/rewardStatus/fromUser/rrId/fromUserInfo），
 * 战斗明细在 rUrl 指向的限时 OSS JSON 里（易过期、需另解 schema），故只排干净报头 + 一句引导，不逐条 dump 原始键。
 * @param {object} mail MAIL_QUERY 应答里的战报报头
 * @returns {Array<string|{s:string, action:object}>}
 */
function battleRows(mail) {
  var lines = [];
  if (!mail || typeof mail !== 'object') return lines;
  log.info('battle mail keys: %s', Object.keys(mail).join(','));
  var title = pickField(mail, ['title', 'reportName', 'name', 'subject']);
  if (title) lines.push('战报: ' + title);
  var rid = pickField(mail, ['reportId', 'rId']);
  if (rid) lines.push('战报编号: ' + rid);
  lines.push('完整战斗明细请在游戏内点开查看（战报正文限时有效）');
  return lines;
}
