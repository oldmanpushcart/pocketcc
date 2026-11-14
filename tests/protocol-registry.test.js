// 协议注册表一致性闸门（B1 定稿：开发期单一真相，feat 保留本地常量，零运行期改动）。
// 四条断言：
//   1) 注册表自洽：号唯一、dir 合法、usages 非空；
//   2) 代码 ⊆ 注册表：extension/src 每处 CMD_/PUSH_ 定义都能按号查到且 usages 收录该定义；
//   3) 注册表 ⊆ 代码：无陈旧 usage（常量删除/搬家后须重跑 extract 同步）；
//   4) manifests ⊆ 注册表：verify-manifests 本地数字定义按号可查、featNum 名存在于 usages。
// 失配修法：node scripts/protocol/extract.mjs 增量合并（人工标注 dir/note/src 保留）。
// 纯 node 模块直驱，无浏览器桩、不发包、不摸游戏符号。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanDefinitions, scanManifests } from '../scripts/protocol/scan.mjs';
import { all, byCmd, byFeat } from '../scripts/protocol/index.mjs';

const defs = scanDefinitions();
const entries = all();

/** 定义三元组键（name|feat|file），行号不入键（编辑漂移不影响一致性判定） */
const defKey = (d) => `${d.name}|${d.feat}|${d.file}`;
const defKeys = new Set(defs.map(defKey));

test('注册表自洽：号唯一、dir 合法、usages 非空', () => {
  assert.ok(entries.length > 0);
  assert.equal(new Set(entries.map((e) => e.cmd)).size, entries.length, '协议号重复');
  for (const e of entries) {
    assert.ok(Number.isInteger(e.cmd) && e.cmd > 0, `非法号 ${e.cmd}`);
    assert.ok(e.dir === null || e.dir === 'C2S' || e.dir === 'S2C', `${e.cmd} dir 非法: ${e.dir}`);
    assert.ok(Array.isArray(e.usages) && e.usages.length > 0, `${e.cmd} usages 为空`);
    assert.equal(typeof e.note, 'string');
    assert.equal(typeof e.src, 'string');
  }
  // 按号升序（index 契约）
  for (let i = 1; i < entries.length; i++) assert.ok(entries[i - 1].cmd < entries[i].cmd);
});

test('代码 ⊆ 注册表：每处定义按号可查且 usages 收录', () => {
  for (const d of defs) {
    const e = byCmd(d.cmd);
    assert.ok(
      e,
      `${d.file}:${d.line} ${d.name}=${d.cmd} 不在注册表，跑 node scripts/protocol/extract.mjs`,
    );
    assert.ok(
      e.usages.some((u) => defKey(u) === defKey(d)),
      `${d.file}:${d.line} ${d.name}=${d.cmd} 的 usage 未收录（搬家/改名？），跑 extract 同步`,
    );
  }
});

test('注册表 ⊆ 代码：无陈旧 usage', () => {
  for (const e of entries) {
    for (const u of e.usages) {
      assert.ok(
        defKeys.has(defKey(u)),
        `${e.cmd} 的 usage ${u.name}@${u.file} 在源码中已不存在，跑 extract 同步`,
      );
    }
  }
});

test('manifests ⊆ 注册表：本地数字定义与 featNum 名可查', () => {
  const { locals, featNums } = scanManifests();
  for (const l of locals) {
    assert.ok(byCmd(l.cmd), `manifest ${l.file} 本地定义 ${l.name}=${l.cmd} 不在注册表`);
  }
  for (const f of featNums) {
    assert.ok(
      entries.some((e) => e.usages.some((u) => u.name === f.name)),
      `manifest ${f.file} featNum('${f.name}') 在注册表 usages 中不存在`,
    );
  }
});

test('查询 interface 冒烟：byCmd / byFeat', () => {
  // 902 跨域共享号：别名收进同一条目（CMD_MARCH_WORLD_POINT | CMD_MARCH_POINT）
  const march = byCmd(902);
  assert.ok(march);
  assert.ok(march.usages.length >= 10);
  assert.ok(march.usages.some((u) => u.name === 'CMD_MARCH_WORLD_POINT'));
  assert.ok(march.usages.some((u) => u.name === 'CMD_MARCH_POINT'));
  // 秘境 8521 按 feat 可查
  assert.ok(byFeat('secret-realm').some((e) => e.cmd === 8521));
  // 10019 人工实证标注：CMD_ 前缀的推送
  assert.equal(byCmd(10019).dir, 'S2C');
  assert.equal(byCmd(999999), null);
});
