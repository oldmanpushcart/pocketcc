// pocketcc 两个 world（MAIN / ISOLATED）之间 postMessage 协议的命名空间，兼「发布通道」的实例命名收口。
// NS 两边必须同值，否则 storage 代理静默失效；故集中一处，content.js 与 bridge.js 各自打包内联。
//
// 通道（channel）是**版本号之外的独立维度**：dev / snapshot / release 三套构建的 manifest.key 不同
// ⇒ 扩展 ID 不同 ⇒ 可以同时装在一个浏览器里。凡是「按扩展实例命名」的符号都必须带通道后缀，
// 否则同名协议（__ns）与同名存储键会在同一个游戏页上互相串台——那等于同一个账号跑了两套自动化。
// 正式通道刻意留空后缀：存量用户的键名与协议一字不变，零迁移。

/** @type {'dev'|'snapshot'|'release'} 构建期注入的通道名；未注入时按 release 处理（宁可不加后缀，也不把正式包当 dev） */
const CHANNEL =
  typeof __PCC_CHANNEL__ === 'string' && __PCC_CHANNEL__ ? __PCC_CHANNEL__ : 'release';

/** @type {string} 通道后缀：正式为空串，其余为 `.dev` / `.snapshot` */
export const CHAN_SUFFIX = CHANNEL === 'release' ? '' : `.${CHANNEL}`;

/** @type {string} 本次构建的发布通道名（面板/欢迎页展示用，取值 dev | snapshot | release） */
export const CHANNEL_NAME = CHANNEL;

/** @type {string} 协议命名空间标识（消息体 __ns 字段） */
export const NS = `pocketcc${CHAN_SUFFIX}`;

/** @type {string} 存储键前缀的根段（core/player.js 在其后接 `u{uid}.` 组成完整命名空间） */
export const STORAGE_ROOT = `pocketcc${CHAN_SUFFIX}`;
