/**
 * 纯说明横幅字段类型 module（type:'note'）。
 *
 * T4（架构审查候选 1）：render 迁自 fields.js renderNote。无控件、不写配置、可无 key，
 * 靠 fd.section 出分组标题作分隔，正文渲染一行 muted 说明（fd.text）。纯静态展示故无 events / refreshText。
 *
 * 依赖面 = dom.js（escAttr）；不反查 fields.js/wire.js。
 */
import { escAttr } from '../dom.js';

/**
 * 行 HTML：一行 .pc-fnote 说明（fd.text 转义后输出，缺省空）。
 * @param {*} val 配置里的字段值（本类型不读 val，正文来自 fd.text）
 * @param {object} fd 字段描述符（text / section）
 * @returns {string}
 */
function renderNote(val, fd) {
  void val;
  return `<div class="pc-fnote">${fd.text ? escAttr(fd.text) : ''}</div>`;
}

/** 纯说明横幅类型（inline，纯静态无 events；interface 形状见 index.js 头注释） */
export const noteType = {
  type: 'note',
  kind: 'inline',
  render: renderNote,
};
