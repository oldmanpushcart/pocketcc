/**
 * pocketcc.chat —— 游戏聊天通道底座（组装薄壳）
 * 原 1345 行单 IIFE 按五面拆至 core/chat/ 目录（阶段五），本文件只做组装与对外挂接：
 * 借游戏自管的 NetChatClient 连接（auth/bind/故障转移/重连均不干预），向上暴露五个面——
 *   发包（send/sharePos/sendEmoji）→ core/chat/send.js（主协议 PostChatMsg 670，走主 socket）；
 *   读数据（proxy/history/historyRooms/olderHistory/unread/markRead/summary/pmList/aroundHistory/
 *     systemMessages）→ core/chat/proxy.js（sendProxy 隧道 + md5 签名 REST）；
 *   收信（on/off）→ core/chat/receive.js（直连聊天 socket，实例更替自愈重挂）；
 *   schema 归一（normalize/parseLink/toSysItem）→ core/chat/normalize.js（纯函数）；
 *   日志（setLog/isLogging）→ core/chat/log.js（包 sendProxy 打印出站+应答，订阅打印入站）；
 *   生命周期与连接态（install/uninstall/isConnected/status/socket/chatHeads）→ core/chat/client.js；
 *   跨文件共享状态（socket 客户端引用/订阅表/hook 现场/命令号缓存）→ core/chat/context.js（依赖叶子）。
 * 房间跟随游戏 _rooms（世界/联盟等由游戏自己 addRoom），本模块不 join/leave、不改写游戏任何状态。
 * 参照 net.js 口径：单点 hook、先跑原函数再打印、只当最外层还是自己时才还原。
 *
 * 合规：全部能力为只读查询或调用游戏原生发包，不改写游戏数据（只读+发包红线）。
 */
import { CHANNELS, Ret } from './chat/context.js';
import { install, uninstall, isConnected, status, socket, chatHeads } from './chat/client.js';
import { send, sharePos, sendEmoji } from './chat/send.js';
import {
  proxy,
  history,
  historyRooms,
  olderHistory,
  unread,
  markRead,
  summary,
  pmList,
  aroundHistory,
  systemMessages,
} from './chat/proxy.js';
import { normalize, parseLink, toSysItem } from './chat/normalize.js';
import { on, off } from './chat/receive.js';
import { setLog, isLogging } from './chat/log.js';

/**
 * chat 底座具名导出（供 reactor/feat 走 ESM import，替代 window.pocketcc.chat 全局摸取）。
 * 求值期组装完成，importer 读取时必已就绪（install 仍由各 API 懒兜底）。
 * @type {object|null}
 */
export let chatApi = null;

/** 对外接口面（键序与拆分前一致），挂到 window.pocketcc.chat */
const api = {
  install: install,
  uninstall: uninstall,
  isConnected: isConnected,
  status: status,
  socket: socket,
  send: send,
  sharePos: sharePos,
  sendEmoji: sendEmoji,
  channels: CHANNELS,
  chatHeads: chatHeads,
  proxy: proxy,
  history: history,
  historyRooms: historyRooms,
  olderHistory: olderHistory,
  unread: unread,
  markRead: markRead,
  summary: summary,
  pmList: pmList,
  aroundHistory: aroundHistory,
  systemMessages: systemMessages,
  toSysItem: toSysItem,
  normalize: normalize,
  parseLink: parseLink,
  on: on,
  off: off,
  setLog: setLog,
  isLogging: isLogging,
  Ret: Ret,
};

window.pocketcc = window.pocketcc || {};
window.pocketcc.chat = api;
chatApi = api; // 具名导出：与 window 同源，供 import { chatApi } 使用
// 扩展内不自启：无场景时机依赖，各 API 首用时懒兜底 install()
