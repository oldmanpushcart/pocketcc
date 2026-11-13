/**
 * 字段上下文共享核（T5，架构审查候选 1 · Option A 全量收编）。
 *
 * commit 是全扩展唯一提交流管道（saveFeature + applyFeature + debug 日志），此前只在 wire.js 的
 * makeCtx 闭包里实现一份；T5 有状态清单装配（wire.wireControls）与降级补载回写（panel.syncControls）
 * 都要给 mount* 喂一个带 commit 的 ctx，故把管道下沉于此共享，两处调用方同源、不再各抄一份。
 *
 * 依赖面 = registry（configs/findFeature/saveFeature/applyFeature）+ log（createLog）+ dom（findFieldDescriptor）；
 *   不 import wire.js/panel.js/fields.js（避免 panel↔wire 循环：wire 已 import panel）。
 *   refresh/syncChecks 是事件级 ctx 的扩展（wire.js 在 baseCtx 上叠加），装配 ctx 用不到，故本核不含。
 */
import { configs, findFeature, saveFeature, applyFeature } from '../../registry.js';
import { createLog } from '../../log.js';
import { findFieldDescriptor } from '../dom.js';

/** @type {ReturnType<createLog>} 模块日志器（tag=CORE，与 wire.js 提交流日志同口径） */
const logCore = createLog('CORE');

/**
 * 构造字段上下文基座（定稿 ctx 契约的 commit 部分）：commit = save + apply + debug 日志。
 * 事件级 ctx（wire.js dispatcher）在此之上叠加 refresh / syncChecks；装配级 ctx 只用 commit。
 * @param {object} f descriptor
 * @param {object|null} fd 字段描述符（顶层；日志取其 key）
 * @param {object} c configs[fid]
 * @param {Element|null} box 字段容器（内联型为 null）
 * @param {Element|null} el 事件目标（装配态为 null）
 * @returns {object} ctx 基座 { f, fd, c, fid, box, el, commit() }
 */
export function baseCtx(f, fd, c, box, el) {
  return {
    f,
    fd,
    c,
    fid: f.id,
    box,
    el,
    commit: () => {
      saveFeature(f);
      applyFeature(f);
      logCore.debug('field commit. feature=%s;key=%s', f.id, fd ? fd.key : '');
    },
  };
}

/**
 * 从容器外壳解析装配级 ctx（供 assembleTypeModules / syncTypeModules 的 makeCtx 工厂）。
 * 有状态清单容器带 data-fkey（= 顶层 fd.key）；标量 UID 行（.pc-uidwrap）带 data-ukey（亦 = 顶层 fd.key），
 *   故按 data-fkey ?? data-ukey 反查 owning descriptor。功能/配置查不到时返回 null（调用方跳过该容器）。
 * @param {Element} box 带 data-id 的字段容器
 * @returns {object|null} ctx 基座（含 commit），无法解析时 null
 */
export function assembleCtx(box) {
  const f = findFeature(box.dataset.id);
  if (!f) return null;
  const c = configs[f.id];
  if (!c) return null;
  const key = box.dataset.fkey != null ? box.dataset.fkey : box.dataset.ukey;
  const fd = key != null ? findFieldDescriptor(f, key) : null;
  return baseCtx(f, fd, c, box, null);
}
