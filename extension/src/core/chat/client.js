/**
 * chat 内部底座 · 生命周期与连接态（core/chat/client.js）
 * 原 core/chat.js 的 install/uninstall/isConnected/status/socket/chatHeads 区段，
 * 阶段五逐字迁出（行为零变化）。本文件负责把 receive 的 socket 包装钩子与 log 的还原
 * 经 setInstallerHooks 回填给 context（引用方向 client→receive/log→context，client 是目录装配根，
 * 无人在求值期反向 import client 的运行逻辑——proxy 借 status 是调用期取用，模块求值不触发）。
 */
import { game } from '../game.js';
import {
  ctx,
  ensure,
  installCore,
  uninstallCore,
  setInstallerHooks,
  roomsSnapshot,
} from './context.js';
import {
  hookConnect,
  unhookConnect,
  hookIo,
  unhookIo,
  dropAllSubs,
  stopRebindTimer,
} from './receive.js';
import { setLog } from './log.js';

/**
 * 安装：取 NetChatClient 单例并校验关键方法在场。模块在页面加载期即注册，无场景时机依赖；
 * 各 API 首用时懒兜底 install（同 event.on 模式），boot.js 不显式调用。
 * @returns {boolean} 安装成功
 */
export function install() {
  return installCore();
}

/**
 * 卸载：摘日志 hook、退订日志期订阅、清引用（最后防线；调用方自发退订走 on 返回的 unsubscribe）。
 * @returns {boolean} 卸载成功
 */
export function uninstall() {
  return uninstallCore();
}

/**
 * 聊天 socket 是否已连接（委托游戏 IsValid()：socket 在场且 _netIsValid）
 * @returns {boolean}
 */
export function isConnected() {
  if (!ensure()) return false;
  return !!ctx.client.IsValid();
}

/**
 * 连接状态只读快照（DevTools 排查用：connected / 当前 socketIp / 游戏已加入的房间列表）
 * @returns {object} {connected:boolean, socketIp:string, rooms:string[]}；rooms 为拷贝，不共享游戏数组引用
 */
export function status() {
  if (!ensure())
    return { connected: false, socketIp: '', rooms: [], error: 'NetChatClient missing' };
  return roomsSnapshot();
}

/**
 * 底层 socket.io 对象逃生口（调试用；勿在其上自行常驻 on() 监听——socket 实例会被游戏整只替换
 * （connectSocket / 故障转移 / PAB 心跳重建），丢了没人替你重挂；收消息一律走 on()，它自带重挂自愈）
 * @returns {object|null} 未连接/模块缺失返回 null
 */
export function socket() {
  if (!ensure()) return null;
  try {
    return ctx.client.socket ? ctx.client.socket() : null;
  } catch (e) {
    return null;
  }
}

/**
 * 只读枚举游戏频道会话列表（newChatController.Instance.getAllChatList()：摊平 _chatList，
 * 与游戏 UI 当前选中频道无关；条目形如 {Channel, Id, Name}，这里拷出脱引用）。
 * 用途：动态频道（群聊 5 等）的进房是惰性的——玩家没在游戏里打开过该频道时，服务器还没
 * push roomChatChange/NetChatClient 未 addRoom，收不到推信也学不到 roomId（群聊发送的
 * group 字段必填，chatCommon.dataSameWithGroupSpecial=[5]），从频道头列表兜底发现。
 * 注：读 Instance 静态 getter 在游戏侧会懒初始化聊天控制器（登录流程本就会创建，幂等）。
 * @returns {Array<{channel:number, id:string, name:string}>} 未初始化/异常返回空数组
 */
export function chatHeads() {
  try {
    var m = game.get('newChatController');
    var cls = m && m.newChatController;
    var inst = cls && cls.Instance;
    if (!inst || typeof inst.getAllChatList !== 'function') return [];
    var list = inst.getAllChatList() || [];
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var it = list[i];
      if (!it) continue;
      out.push({
        channel: Number(it.Channel),
        id: String(it.Id || ''),
        name: String(it.Name || ''),
      });
    }
    return out;
  } catch (e) {
    return [];
  }
}

// 生命周期插槽回填：installCore 成功后补挂 socket 包装；uninstallCore 前按拆分前顺序对称还原。
setInstallerHooks({
  install: function () {
    hookConnect();
    hookIo();
  },
  uninstall: function () {
    if (ctx.logEnabled) setLog(false);
    stopRebindTimer();
    dropAllSubs();
    unhookConnect();
    unhookIo();
  },
});
