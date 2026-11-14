/**
 * 聊天窗口 feat · 装配层（index）。半透明浮层（chat-overlay.js）的业务入口。
 * 数据全部走 pocketcc.chat（只读+发包，不触碰游戏任何状态与 UI）：
 *   接收：聊天 socket 的 chatpush/chatpushpm/chatdel/chatupdate（经 ctx.on.chat 订阅，pause 自动摘）→ 入环形缓冲；
 *   历史：进入频道全量拉取、滚动到顶翻页、私聊/动态房历史；
 *   发送：chat.send（@编码/引用）/chat.sharePos；本地 5s 冷却；发送即插乐观条目，真回声原位合并；
 *   快捷键：Ctrl+K 开关浮层（window 捕获阶段监听）。
 *
 * 目录化拆分（依赖方向红线：切片→context，兄弟切片互不 import）：
 *   context.js  共享可变状态 S + 常量 + bufOf/syncRoomIds + 生命周期插槽（依赖叶子）
 *   normalize.js 纯函数（报文归一/格式化）
 *   channels.js 频道/会话/侧栏/成员/玩家信息
 *   history.js  历史拉取/翻页/定位/摘要
 *   send.js     发送/@编码/分享坐标/撤回
 *   jump.js     战报/坐标跳转（叶子）
 * 切片间互相调用统一走 S.fns（各切片求值期登记）；本装配层只持有生命周期（install/run/configure/onKeydown）
 * 与 reactor.register，并以副作用 import 触发三个业务切片的登记。
 */
import { safeParse } from '../../../core/util.js';
import { storage } from '../../../core/storage.js';
import { reactor } from '../../../core/reactor.js';
import { chatApi } from '../../../core/chat.js';
import { netApi } from '../../../core/net.js';
import { ChatOverlay } from './chat-overlay.js';
import { S, log, bufOf, syncRoomIds, GEOM_KEY } from './context.js';
import { CMD_ADD_FRIEND, CMD_PLAYER_INFO, CMD_CHAT_INFO_LIST } from './constants.js';
import { familyOf, myUid, myStrUid, hhmm, locText } from './normalize.js';
import { jumpTo } from './jump.js';
// 业务切片：仅为触发其对 S.fns 的登记（本层通过 S.fns 调用其函数，不直接 import 其符号）
import './channels.js';
import './history.js';
import './send.js';

// ─────────────────────── 生命周期 ───────────────────────

/** Ctrl+K window 捕获监听（install 时装，全场景生效） */
function onKeydown(e) {
  if (!(e.ctrlKey || e.metaKey)) return;
  if (e.key !== 'k' && e.code !== 'KeyK') return;
  e.preventDefault();
  if (!S.ctxRef || !S.ctxRef.alive()) return; // 功能未激活时热键静默
  var vis = S.overlay.toggle();
  if (vis) {
    S.fns.renderActive();
    S.fns.ensureHistory(S.activeKey);
    S.fns.syncChannels();
    S.overlay.focusInput();
  }
}

/**
 * 浮层 handlers（视图动作 -> 业务）
 * @returns {object}
 */
function makeHandlers() {
  return {
    onSend: (text, atList, quote) => S.fns.doSend(text, atList, quote),
    onSharePos: (x, y) => {
      S.fns.doSharePos(x, y);
    },
    onJump: (action) => {
      jumpTo(action);
    },
    onRequestAtList: () => {
      var b = bufOf(S.activeKey);
      var speakers = [];
      var seen = new Set([myUid(), myStrUid()]);
      for (var [uid, name] of b.speakers)
        if (!seen.has(String(uid))) speakers.push({ uid: String(uid), name });
      speakers.sort((a, x) => a.name.localeCompare(x.name, 'zh'));
      var allowAll = S.activeKey === 'alliance' || S.activeKey === 'group';
      S.overlay.openAtPicker(speakers.slice(0, 50), allowAll);
      if (S.activeKey === 'alliance') {
        // 联盟频道：成员表异步到位后二次刷新候选（浮层开着时保留过滤词）
        S.fns.ensureMembers().then((ms) => {
          if (!ms.length || !S.overlay) return;
          var merged = ms.slice();
          for (var s of speakers)
            if (!merged.some((m) => String(m.uid) === String(s.uid))) merged.push(s);
          S.overlay.setAtCandidates(merged);
        });
      }
    },
    onChannelSelect: (key) => S.fns.activateKey(key),
    onSideSelect: (key) => S.fns.activateKey(key),
    onLoadOlder: () => {
      S.fns.loadOlder();
    },
    onQuote: (entry) => {
      if (S.overlay) S.overlay.setQuote(entry);
    },
    onLocateMessage: (uuid) => {
      S.fns.locateMessage(uuid);
    },
    onRevoke: (entry) => {
      S.fns.doRevoke(entry);
    },
    onNamePm: (entry) => {
      if (!entry || entry.self || !entry.uid) return;
      if (S.activeKey.indexOf('pm:') === 0) return;
      var key = 'pm:' + entry.uid;
      bufOf(key, entry.name);
      S.fns.activateKey(key);
    },
    onCheckFriend: (entry) => S.fns.checkFriend(entry),
    onNameInfo: (entry) => {
      var net = netApi;
      if (!net || !entry || !entry.uid || entry.self || !S.overlay) return;
      net
        .send(CMD_PLAYER_INFO, { uid: String(entry.uid) })
        .then((ret) => {
          var d = safeParse(ret && ret.data);
          if (!ret || !ret.ok || !d || typeof d !== 'object') {
            log.info('PlayerInfo rejected: %s', String(ret && ret.data).slice(0, 200));
            S.overlay.showInfoPop(entry.name || '玩家信息', [
              '获取失败：' +
                locText(String(ret && ret.data != null ? ret.data : '无应答')).slice(0, 40),
            ]);
            return;
          }
          S.fns.pmStoreSet(String(entry.uid), d); // 查看信息也写穿缓存（侧栏副行/头像随之更新）
          if (S.overlay && S.overlay.isVisible() && familyOf(S.activeKey) === 'pm')
            S.fns.updateSide();
          S.overlay.showInfoPop(
            S.fns.infoNick(d) || entry.name || '玩家信息',
            S.fns.infoLines(d, entry.uid),
            S.fns.resolveAvatar(d, entry),
          );
        })
        .catch((e) => {
          log.warn('PlayerInfo failed: %s', e && e.message);
          S.overlay.showInfoPop(entry.name || '玩家信息', ['查询异常']);
        });
    },
    onNameAddFriend: (entry) => {
      var net = netApi;
      if (!net || !entry || !entry.uid || entry.self) return;
      // 好友判定已由菜单侧 onCheckFriend 用 Friends Map 分流；这里是确认非好友后的发申请，服务器自拒兼做兜底
      net
        .send(CMD_ADD_FRIEND, { uid: String(entry.uid) })
        .then((ret) => {
          log.info('AddFriend resp: %s', String(ret && ret.data).slice(0, 200));
          if (S.overlay)
            S.overlay.toast(
              ret && ret.ok
                ? '好友申请已发送'
                : '加好友被拒：' + String(ret && ret.data != null ? ret.data : '').slice(0, 30),
            );
        })
        .catch((e) => {
          log.warn('AddFriend failed: %s', e && e.message);
          if (S.overlay) S.overlay.toast('加好友异常');
        });
    },
    onVisibleChange: (visible) => {
      if (!visible && S.overlay) {
        /* 隐藏仅停渲染，订阅与缓冲继续 */
      }
    },
    onGeomChange: (geom) => {
      try {
        Promise.resolve(storage.set(GEOM_KEY, geom)).catch(() => {});
      } catch (e) {}
    },
  };
}

/**
 * 安装：建浮层、挂 Ctrl+K、异步恢复几何。幂等。
 * @param {object} ctx reactor 上下文
 * @returns {boolean} 成功
 */
function install(ctx) {
  S.ctxRef = ctx;
  if (S.installed) return true;
  if (!chatApi) {
    log.warn('chat base unavailable');
    return false;
  }
  S.overlay = new ChatOverlay(makeHandlers());
  S.overlay.mount();
  S.overlay.setOpacity(S.cfg.opacity);
  syncRoomIds();
  S.fns.syncChannels();
  window.addEventListener('keydown', onKeydown, true);
  // 跨服房间随活动出现/消亡（游戏吸收 roomChatChange 后维护 chatHeads），开层时定时对账侧栏
  window.setInterval(function () {
    if (S.overlay && S.overlay.isVisible() && familyOf(S.activeKey)) {
      S.fns.syncRoomIdsCross();
      S.fns.updateSide();
    }
  }, 30000);
  S.installed = true;
  // 几何存档：读盘失败（命名空间未设等）静默用默认
  storage
    .get(GEOM_KEY)
    .then((g) => {
      if (g && S.overlay) S.overlay.setGeom(g);
    })
    .catch(() => {});
  log.info('chat window installed (Ctrl+K).');
  return true;
}

/**
 * 日期展示开关变更后：按 timeMs 重算各缓冲条目展示串并刷新当前视图（timeStr 已烘焙进条目）。
 * @returns {void}
 */
function retimeAll() {
  for (var b of S.bufs.values()) for (var e of b.list) e.timeStr = hhmm(e.timeMs, S.cfg.showDate);
  if (S.overlay && S.overlay.isVisible()) S.fns.renderActive();
}

/**
 * 配置推入：快捷栏/透明度/日期展示热更。
 * @param {object} c toModuleCfg 产物
 * @returns {void}
 */
function configure(c) {
  if (!c) return;
  if (c.quick) S.cfg.quick = c.quick;
  if (c.opacity != null) S.cfg.opacity = c.opacity;
  var dateToggled = c.showDate != null && !!c.showDate !== S.cfg.showDate;
  if (c.showDate != null) S.cfg.showDate = !!c.showDate;
  if (S.overlay) {
    S.overlay.setOpacity(S.cfg.opacity);
    S.fns.syncChannels();
  }
  if (dateToggled) retimeAll();
}

/**
 * 激活：订阅聊天推送（pause 由 ctx.on.chat 统一摘除）。
 * @param {object} ctx reactor 上下文
 * @returns {void}
 */
function run(ctx) {
  S.ctxRef = ctx;
  ctx.on.chat('push', function (p) {
    S.fns.ingest('push', p);
  });
  ctx.on.chat('pm', function (p) {
    S.fns.ingest('pm', p);
  });
  ctx.on.chat('del', function (p) {
    S.fns.onDel(p);
  });
  ctx.on.chat('update', function (p) {
    S.fns.onUpdate(p);
  });
  // CHAT_INFO_LIST(10919)：被攻击/主动攻击等系统战报消息的实时推（走主协议 bus.net.<cmd>，非聊天 socket 事件）
  ctx.on.push(CMD_CHAT_INFO_LIST, S.fns.onChatInfoList);
}

reactor.register({
  id: 'chatWindow',
  label: '聊天窗口',
  storageKey: 'pocketcc.chatWindow.config',
  symbols: ['dataCenter', 'tableManager', 'tableUtils', 'long64Bit', 'chatCommon?', 'navFly?'],
  defaults: {
    enabled: true,
    quickWorld: true,
    quickAlliance: true,
    quickPm: true,
    quickCross: true,
    quickGroup: false,
    showDate: true,
    opacity: 75,
  },
  fields: [
    { key: 'quickWorld', label: '世界', type: 'checkbox', section: '快捷切换栏' },
    { key: 'quickAlliance', label: '联盟', type: 'checkbox', section: '快捷切换栏' },
    { key: 'quickPm', label: '私聊', type: 'checkbox', section: '快捷切换栏' },
    { key: 'quickCross', label: '跨服', type: 'checkbox', section: '快捷切换栏' },
    { key: 'quickGroup', label: '群聊', type: 'checkbox', section: '快捷切换栏' },
    { key: 'showDate', label: '时间含年月日', type: 'checkbox', section: '消息显示' },
    { key: 'opacity', label: '不透明度(%)', min: 30, step: 5 },
  ],
  toModuleCfg: function (c) {
    return {
      quick: {
        world: !!c.quickWorld,
        alliance: !!c.quickAlliance,
        pm: !!c.quickPm,
        cross: !!c.quickCross,
        group: !!c.quickGroup,
      },
      showDate: !!c.showDate,
      opacity: c.opacity,
    };
  },
  install: function (ctx) {
    return install(ctx);
  },
  configure: configure,
  run: run,
  // C 档（可行性报告 §7.2）：聊天与「在哪一种场景」基本无关（跨服图里消息照样要收发），所以不声明 kinds，
  // 只按 Place 放行：基地/别人基地/大地图/征服者球体/转场。本 feat 原本无 scenes 声明（全域放行），
  // 这里是收窄：战斗演出（place=battle）期间不再喂推送，浮层停在演出前画面，回常态图由 reactor
  // resume 重新挂上订阅（订阅全在 run 里、由 ctx.on 登记，重挂幂等无泄漏）。已知代价：演出期间的
  // 新消息不会补进浮层（游戏侧聊天数据中心不受影响）。
  // 秘境例外：world 门的 kind===pab 隔离是「默认全拦」，不声明 kinds 在此档等价于被拦——
  //   秘境图内聊天窗口整 feat pause（独立世界体系的已知取舍，要在秘境聊天需显式加 kinds:['pab']）。
  places: ['base', 'world', 'base_other', 'sphere', 'transition'],
});
