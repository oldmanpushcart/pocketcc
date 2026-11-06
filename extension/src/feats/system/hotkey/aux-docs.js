/**
 * 展示型快捷键登记（不在此分派，仅并入面板「快捷键一览」）
 *
 * 这三个键的按键行为由各子系统自带监听处理，不适合纳入 core/hotkeys.js 的统一 dispatch：
 * - F8      日常 ↔ 战斗模式切换：app 级，监听在 core/ui.js mountUI（window 捕获，全域常开）；
 * - Ctrl+K  聊天浮层开关：feat 级，监听在 feats/system/chat/index.js（onKeydown；依赖该功能激活）；
 * - Ctrl+M  全局地图浮层开关：feat 级，监听在 feats/system/map/global-map.js。
 * - Ctrl+G  镜头跳转浮层开关：feat 级，监听在 feats/system/map/quick-jump.js（依赖该功能激活）。
 * 它们或带修饰键（注册表 dispatch 对 Ctrl/Alt/Meta 直接放行不处理），或依赖 feat 生命周期，
 * 故只在此用 hotkeys.doc() 登记键位说明，让「快捷键一览」完整可见；改动上述任一实现时同步更新此处。
 */
import { doc } from '../../../core/hotkeys.js';

doc({ id: 'toggleCombat', display: 'F8', label: '日常 ↔ 战斗模式', where: '全域' });
doc({ id: 'chatOverlay', display: 'Ctrl+K', label: '聊天浮层开关', where: '全域' });
doc({ id: 'mapOverlay', display: 'Ctrl+M', label: '全局地图浮层开关', where: '全域' });
doc({ id: 'jumpOverlay', display: 'Ctrl+G', label: '镜头跳转浮层开关', where: '全域' });
