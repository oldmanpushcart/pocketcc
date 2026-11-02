/**
 * 战争之源 feat 内部共享小工具：口径统一收口到 core/util.js，此处仅按本目录自用视角 re-export
 * （attack.js / reward.js 仍从 './util.js' 取，路径不破）。
 * todayStr 被攻打额度与领奖镜像共用于跨日失效；safeStringify 被两链的拒绝日志共用。
 */
export { todayStr, safeStringify } from '../../../core/util.js';
