// 浮动图标的坐标原语：默认位/钳制/宽松兜底 + 读盘（含旧全局键一次性认领）。
// 只依赖尺寸常量与存储层，被 index（拖拽/resize）复用。
import { createLog } from '../log.js';
import { storage } from '../storage.js';
import { ICON_SIZE, POS_KEY } from './consts.js';

/** @type {ReturnType<createLog>} 模块日志器（tag=CORE，与原 ui.js 一致） */
const logCore = createLog('CORE');

/**
 * 图标默认位置：右下角（留 24px 边距）
 * @returns {{x:number, y:number}}
 */
export function defaultPos() {
  return { x: window.innerWidth - ICON_SIZE - 24, y: window.innerHeight - ICON_SIZE - 24 };
}

/**
 * 把坐标钉回视口可见范围内
 * @param {{x:number, y:number}} pos 待钉位置
 * @returns {{x:number, y:number}}
 */
export function clampPos(pos) {
  return {
    x: Math.max(0, Math.min(pos.x, window.innerWidth - ICON_SIZE)),
    y: Math.max(0, Math.min(pos.y, window.innerHeight - ICON_SIZE)),
  };
}

/**
 * 视口变化时的宽松兜底：只保证至少露出 12px 可点，不要求整图标可见——
 * 保持与窗口左/上的边距不变，极端缩小致图标完全出屏时才拉回（区别于拖拽用的 clampPos）
 * @param {{x:number, y:number}} pos 逻辑位置
 * @returns {{x:number, y:number}}
 */
export function rescuePos(pos) {
  return {
    x: Math.max(0, Math.min(pos.x, window.innerWidth - 12)),
    y: Math.max(0, Math.min(pos.y, window.innerHeight - 12)),
  };
}

/**
 * 图标位置读盘（含旧全局键一次性认领）：新 UID 键无值且无前缀旧键有值时，视旧值为当前玩家所有，写入命名空间后删旧键。
 * 旧键是字面无前缀值，必须用 getRaw/removeRaw（否则又被自动拼上 UID 前缀，永远读不到）。
 * 每步各自兜底：storage.get 在 UID 前缀未设时是 reject（不是回 null），这里绝不能再往上抛——
 * mountUI  await 了本函数，抛出来会让后面的控件回写与事件绑定全部落空；读不到就用默认位置，本次不认领旧键。
 * @returns {Promise<{x:number, y:number}>}
 */
export async function readIconPos() {
  let pos = null;
  try {
    pos = await storage.get(POS_KEY);
  } catch (err) {
    logCore.warn('read icon pos failed (storage unavailable): %s', err && err.message);
  }
  if (!pos) {
    try {
      pos = await storage.getRaw(POS_KEY);
    } catch (err) {
      logCore.warn('read legacy icon pos failed: %s', err && err.message);
      pos = null;
    }
    if (pos) {
      // 认领失败（写盘被丢弃等）不影响本次使用：内存里照这个位置摆，下次启动再重试认领
      try {
        await storage.set(POS_KEY, pos);
        await storage.removeRaw(POS_KEY);
      } catch (err) {
        logCore.warn('adopt legacy icon pos failed, keep in-memory only: %s', err && err.message);
      }
    }
  }
  return clampPos(pos || defaultPos());
}
