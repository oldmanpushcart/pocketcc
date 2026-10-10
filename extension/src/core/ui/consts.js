// core/ui 共享常量：图标直径、面板宽度、图标位置存储键。
// 唯一切分缝之上层——被 panel-css / icon-pos / index 复用，本身无依赖。

/** @type {number} 浮动图标直径（px） */
export const ICON_SIZE = 44;
/** @type {number} 面板宽度（px，定位时用于算左右边界）；左 TAB 栏固定 88px，余量给右侧内容列，避免长标签/数值区拥挤换行 */
export const PANEL_W = 520;
/** @type {string} 图标位置存储键（属 UID 命名空间） */
export const POS_KEY = 'pocketcc.ui.iconPos';
