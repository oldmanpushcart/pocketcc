/**
 * 协议注册表 —— 协议知识的单一真相（开发期 module，不进运行期 bundle）。
 *
 * 背景：CMD 号 → 语义 → 方向 → 出处这条知识链原先涂抹在三处（feat 本地常量 /
 * references 逆向文档 / replay manifests），查一个协议要三处跳读，撞号与漂移无闸门。
 * 注册表把知识收进一个 deep module：对外只有查询 interface，号段归属、别名、
 * 消费者清单收进 implementation。feat 保留本地常量（零运行期改动），一致性由
 * tests/protocol-registry.test.js 闸门断言（随 npm test 跑）。
 *
 * 条目键 = 协议号（全局唯一）。名字是 feat 局部别名：同一泛化名（如 CMD_GET_INFO）
 * 在不同 feat 指向不同协议是局部命名而非语义漂移，故语义名走人工 note 标注。
 *
 * 维护：node scripts/protocol/extract.mjs 增量合并——机器字段（usages/域归属）
 * 全量重建，人工字段（dir/note/src/fields）按号保留。数据文件在 registry/ 按业务域分片，
 * 跨域共享号与 core 基础设施号归 registry/shared.mjs。
 *
 * @typedef {object} ProtoUsage
 * @property {string} name feat 局部常量名
 * @property {string} feat 玩法 id（core 侧为相对路径去扩展名）
 * @property {string} file 相对 extension/src 的定义文件（正斜杠）
 *
 * @typedef {object} ProtoEntry
 * @property {number} cmd 协议号（条目键）
 * @property {'C2S'|'S2C'|null} dir 方向（人工标注，渐进；null=未标注）
 * @property {string} note 语义名/说明（人工标注，渐进）
 * @property {string} src 逆向出处链接（人工标注，references/ 相对路径，只链不搬）
 * @property {string} fields 载荷字段典（人工标注，manifest 覆盖协议渐进；空=未标注）
 * @property {ProtoUsage[]} usages feat 局部常量用法清单（机器维护，重跑重建）
 */
import shared from './registry/shared.mjs';
import activity from './registry/activity.mjs';
import alliance from './registry/alliance.mjs';
import battle from './registry/battle.mjs';
import cq26 from './registry/cq26.mjs';
import player from './registry/player.mjs';
import system from './registry/system.mjs';

/** @type {ProtoEntry[]} 全量条目（按号升序，只读） */
const ENTRIES = Object.freeze(
  [...shared, ...activity, ...alliance, ...battle, ...cq26, ...player, ...system].sort(
    (a, b) => a.cmd - b.cmd,
  ),
);

/** @type {Map<number, ProtoEntry>} */
const BY_CMD = new Map(ENTRIES.map((e) => [e.cmd, e]));

/**
 * 全量条目（按号升序）。调用方不得修改。
 * @returns {ProtoEntry[]}
 */
export function all() {
  return ENTRIES;
}

/**
 * 按协议号查条目。
 * @param {number} cmd 协议号
 * @returns {ProtoEntry|null}
 */
export function byCmd(cmd) {
  return BY_CMD.get(cmd) ?? null;
}

/**
 * 按玩法 id 查其消费的全部协议条目。
 * @param {string} feat 玩法 id（如 'secret-realm'；core 侧如 'march'）
 * @returns {ProtoEntry[]}
 */
export function byFeat(feat) {
  return ENTRIES.filter((e) => e.usages.some((u) => u.feat === feat));
}
