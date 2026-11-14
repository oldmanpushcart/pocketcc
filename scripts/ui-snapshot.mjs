// 字段渲染基线快照生成器（架构审查候选 1 · 字段类型 module 化，T0 地基）。
// 遍历合成 descriptor（覆盖 22 个字段类型 + 4 张代表卡）× buildFieldsHTML，输出 HTML 到 tests/fixtures/ui-snapshots/。
// 用途：T0-T5 逐类型迁移时核对「渲染行为零变化」——迁移前生成基线入库，迁移后 --check 逐字对拍。
// 用法：
//   node scripts/ui-snapshot.mjs          生成/覆盖基线夹具（tests/fixtures/ui-snapshots/）
//   node scripts/ui-snapshot.mjs --check  生成到临时目录并与夹具逐文件比对，任一不符 exit 1
// 零 DOM 库：先最小桩化 window/document/chrome 再动态 import fields.js（同 tests/feats/secret-realm-pilot.test.js 范式，不 stub 游戏符号）。
import { mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

globalThis.window = globalThis.window || {
  addEventListener() {},
  removeEventListener() {},
  location: { href: '' },
  document: {},
};
globalThis.document = globalThis.document || {
  createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
  head: { appendChild() {} },
  body: { appendChild() {} },
  addEventListener() {},
  querySelector: () => null,
};
globalThis.chrome = globalThis.chrome || {
  runtime: { id: 'test', sendMessage() {}, getURL: (s) => s, onMessage: { addListener() {} } },
};

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const { buildFieldsHTML } = await import('../extension/src/core/ui/fields.js');
const { configs, findFeature } = await import('../extension/src/core/registry.js');

// ───────────── 合成 descriptor：每类型一条（fd 形状照真实 feat 的最小有效子集） ─────────────
// 每条 = { name 文件名, fid 功能 id, f descriptor(含 fields), cfg 该功能配置 }。
// 合成数据只为触发各渲染器的完整路径（含表头/空态/置灰/只读格），不追求业务真实；真实 feat 对拍见文末追加的真实 descriptor case。
const CASES = [
  // ── 容器型（FIELD_BOXES，11） ──
  {
    name: 'ranges',
    fid: 'snap-ranges',
    f: {
      fields: [
        {
          key: 'ranges',
          type: 'ranges',
          label: '区间规则',
          cols: ['大于等于', '小于', '数值'],
          hint: '先命中先生效',
        },
      ],
    },
    cfg: {
      ranges: [
        { from: 0, to: 100, count: 5 },
        { from: 100, to: 0, count: 0 },
      ],
    },
  },
  {
    name: 'uidlist',
    fid: 'snap-uidlist',
    f: {
      fields: [
        {
          key: 'friends',
          type: 'uidlist',
          label: '好友清单',
          max: 10,
          placeholder: '输入 UID',
          itemLabel: '好友',
          itemCheck: true,
        },
      ],
    },
    cfg: {
      friends: [
        { uid: '123', name: '张三', on: true },
        { uid: '456', name: '', on: false },
      ],
    },
  },
  {
    name: 'sortlist',
    fid: 'snap-sortlist',
    f: {
      fields: [
        { key: 'order', type: 'sortlist', label: '领取优先级', checkable: true, offKey: 'off' },
      ],
    },
    cfg: { order: ['a', 'b', 'c'], off: ['b'] },
  },
  {
    name: 'multiopts',
    fid: 'snap-multiopts',
    f: {
      fields: [
        {
          key: 'ores',
          type: 'multiopts',
          label: '矿种',
          options: [
            { value: 1, label: '金矿' },
            { value: 2, label: '粮田' },
            { value: 3, label: '油井' },
          ],
          maxSelect: 2,
        },
      ],
    },
    cfg: { ores: [1] },
  },
  {
    name: 'itemlist',
    fid: 'snap-itemlist',
    f: {
      fields: [
        {
          key: 'items',
          type: 'itemlist',
          label: '物品清单',
          items: [
            { id: 'i1', label: '道具A', cap: 10 },
            { id: 'i2', label: '道具B' },
          ],
          sortable: true,
          orderKey: 'iorder',
          head: { name: '物品', num: '上限' },
        },
      ],
    },
    cfg: { items: { i1: { on: 1, max: 5 } }, iorder: ['i2', 'i1'] },
  },
  {
    name: 'infogrid',
    fid: 'snap-infogrid',
    f: {
      fields: [
        {
          key: 'info',
          type: 'infogrid',
          label: '状态',
          columns: [{ label: '区' }, { label: '等级', align: 'right' }],
          rows: () => [
            ['1区', '5'],
            ['2区', '3'],
          ],
        },
      ],
    },
    cfg: { info: null },
  },
  {
    name: 'minerules',
    fid: 'snap-minerules',
    f: {
      fields: [
        {
          key: 'rules',
          type: 'minerules',
          label: '采集规则',
          options: [{ value: 1, label: '金矿' }],
          levelOptions: [{ value: 5, label: '5级' }],
          maxStar: 5,
        },
      ],
    },
    cfg: { rules: [{ type: 1, level: 5, star: 3 }] },
  },
  {
    name: 'farmrules',
    fid: 'snap-farmrules',
    f: {
      fields: [
        {
          key: 'frules',
          type: 'farmrules',
          label: '下田规则',
          familyOptions: [
            { value: 7, label: '金矿', short: '金' },
            { value: 16, label: '雷神', short: '雷' },
          ],
          presetOptions: [
            { value: 1, label: '预设1' },
            { value: 2, label: '预设2' },
          ],
        },
      ],
    },
    cfg: {
      frules: [
        { preset: 1, families: [7], kinds: ['tower', 'normal'] },
        { preset: 2, families: [16], kinds: [] },
      ],
    },
  },
  {
    name: 'timeranges',
    fid: 'snap-timeranges',
    f: { fields: [{ key: 'times', type: 'timeranges', label: '下田时段' }] },
    cfg: { times: [{ start: '09:00', end: '18:00' }] },
  },
  {
    name: 'huntlist',
    fid: 'snap-huntlist',
    f: {
      fields: [
        {
          key: 'hunt',
          type: 'huntlist',
          label: '怪物清单',
          todayText: () => '3',
          catalog: [
            {
              key: 'm1',
              label: '野怪',
              groupType: 1,
              pointType: 2,
              level: 5,
              defaultCount: 0,
              defaultMode: 'a',
              defaultOn: true,
              maxCount: 10,
              modes: [{ value: 'a', label: '方式A' }],
            },
          ],
        },
      ],
    },
    cfg: { hunt: [{ key: 'm1', count: 5, mode: 'a', on: true }] },
  },
  {
    name: 'presetpool',
    fid: 'snap-presetpool',
    f: { fields: [{ key: 'pool', type: 'presetpool', label: '打野预设池', max: 8 }] },
    cfg: { pool: [1, 2] },
  },
  // ── 内联型（FIELD_INLINE，10） ──
  {
    name: 'checkbox',
    fid: 'snap-checkbox',
    f: { fields: [{ key: 'flag', type: 'checkbox', label: '开关' }] },
    cfg: { flag: true },
  },
  {
    name: 'note',
    fid: 'snap-note',
    f: { fields: [{ type: 'note', text: '这是一段说明文字' }] },
    cfg: {},
  },
  {
    name: 'text',
    fid: 'snap-text',
    f: {
      fields: [
        {
          key: 'stat',
          type: 'text',
          label: '今日进度',
          multiline: true,
          get: () => '第一行\n第二行',
        },
      ],
    },
    cfg: { stat: null },
  },
  {
    name: 'select',
    fid: 'snap-select',
    f: {
      fields: [
        {
          key: 'mode',
          type: 'select',
          label: '模式',
          options: [
            { value: 'a', label: 'A' },
            { value: 'b', label: 'B' },
          ],
        },
      ],
    },
    cfg: { mode: 'a' },
  },
  {
    name: 'tripick',
    fid: 'snap-tripick',
    f: {
      fields: [
        {
          key: 'trio',
          type: 'tripick',
          label: '派出的兽',
          parts: [
            { key: 'p1', label: '属相', options: [{ value: 1, label: '鼠' }] },
            { key: 'p2', label: '品种', options: [{ value: 2, label: '种' }] },
          ],
        },
      ],
    },
    cfg: { p1: 1, p2: 2 },
  },
  {
    name: 'ctrlrow',
    fid: 'snap-ctrlrow',
    f: {
      fields: [
        {
          key: 'crow',
          type: 'ctrlrow',
          label: '等级方式',
          cells: [
            { key: 'c1', label: '等级', options: [{ value: 5, label: '5级' }] },
            { key: 'c2', type: 'text', label: '已打', get: () => '3' },
          ],
        },
      ],
    },
    cfg: { c1: 5 },
  },
  {
    name: 'string',
    fid: 'snap-string',
    f: { fields: [{ key: 'uid', type: 'string', label: '目标 UID', placeholder: '输入 UID' }] },
    cfg: { uid: '12345' },
  },
  {
    name: 'uid',
    fid: 'snap-uid',
    f: {
      fields: [
        {
          key: 'target',
          type: 'uid',
          label: '目标',
          nameKey: 'targetName',
          enableKey: 'targetOn',
          placeholder: 'UID',
        },
      ],
    },
    cfg: { target: '123', targetName: '张三', targetOn: true },
  },
  {
    name: 'button',
    fid: 'snap-button',
    f: { fields: [{ key: 'btn', type: 'button', label: '刷新战力', onClick: () => {} }] },
    cfg: {},
  },
  {
    name: 'rallygrid',
    fid: 'snap-rallygrid',
    f: {
      fields: [
        {
          key: 'rg',
          type: 'rallygrid',
          cols: ['目标', '延迟入队(秒)', '每日上限', '今日已打', ''],
          rows: [
            {
              name: '战锤',
              enableKey: 'rgOn',
              delay: { key: 'rgDelay', min: 0, step: 1 },
              limit: { key: 'rgLimit', zeroUnlimited: true },
              count: { key: 'rgCount', get: () => '2' },
            },
            {
              // 学习行：触发×删除按钮路径，与上行隐形占位槽对拍末列对齐
              name: '雷达集结怪#94',
              enableKey: 'rgOn2',
              delay: { key: 'rgDelay2', min: 0, step: 1 },
              limit: { key: 'rgLimit2', zeroUnlimited: true },
              count: { key: 'rgCount2', get: () => '0' },
              learned: true,
              itemIds: [94],
            },
          ],
        },
      ],
    },
    cfg: { rgDelay: 5, rgLimit: 0, rgOn: true, rgDelay2: 0, rgLimit2: 10, rgOn2: true },
  },
  // ── 数字兜底（type 未命中任一注册表 → renderNumber） ──
  {
    name: 'number-fallback',
    fid: 'snap-number',
    f: {
      fields: [
        { key: 'num', label: '数量', min: 0, step: 1, zeroUnlimited: true },
        { key: 'num2', label: '普通数字', min: 1, step: 1 },
      ],
    },
    cfg: { num: 0, num2: 7 },
  },
  // ───────────── 代表卡：多字段组合 + section 分组 + showIf 显隐标记 ─────────────
  {
    name: 'card-controls',
    fid: 'snap-card-controls',
    f: {
      fields: [
        { key: 'en', type: 'checkbox', label: '启用', section: '基础' },
        { type: 'note', text: '内联控件组合代表卡' },
        {
          key: 'mode',
          type: 'select',
          label: '模式',
          options: [
            { value: 'a', label: 'A' },
            { value: 'b', label: 'B' },
          ],
        },
        { key: 'cnt', label: '数量', min: 0, step: 1, showIf: (c) => c.mode === 'b' },
        { key: 'stat', type: 'text', label: '状态', get: (c) => '模式=' + c.mode },
        { key: 'who', type: 'string', label: '目标', placeholder: 'UID' },
        {
          key: 'trio',
          type: 'tripick',
          label: '三联',
          parts: [{ key: 't1', options: [{ value: 1, label: '一' }] }],
        },
        {
          key: 'crow',
          type: 'ctrlrow',
          label: '控制行',
          cells: [{ key: 'cr1', options: [{ value: 2, label: '二' }] }],
        },
        { key: 'go', type: 'button', label: '执行', onClick: () => {} },
      ],
    },
    cfg: { en: true, mode: 'b', cnt: 3, who: 'u1', t1: 1, cr1: 2 },
  },
  {
    name: 'card-containers',
    fid: 'snap-card-containers',
    f: {
      fields: [
        { key: 'ranges', type: 'ranges', label: '区间', section: '规则' },
        { key: 'ores', type: 'multiopts', label: '多选', options: [{ value: 1, label: '甲' }] },
        {
          key: 'rules',
          type: 'minerules',
          label: '采集',
          options: [{ value: 1, label: '矿' }],
          levelOptions: [{ value: 1, label: '1级' }],
          maxStar: 3,
        },
        {
          key: 'frules',
          type: 'farmrules',
          label: '下田',
          familyOptions: [{ value: 7, label: '金', short: '金' }],
          presetOptions: [{ value: 1, label: '预设1' }],
        },
        { key: 'times', type: 'timeranges', label: '时段' },
        {
          key: 'hunt',
          type: 'huntlist',
          label: '怪物',
          catalog: [
            {
              key: 'm1',
              label: '怪',
              modes: [{ value: 'a', label: 'A' }],
              defaultCount: 0,
              defaultMode: 'a',
              defaultOn: true,
            },
          ],
        },
        { key: 'pool', type: 'presetpool', label: '预设池', max: 4 },
        {
          key: 'info',
          type: 'infogrid',
          label: '信息',
          columns: [{ label: '列' }],
          rows: () => [['值']],
        },
      ],
    },
    cfg: {
      ranges: [{ from: 0, to: 10, count: 1 }],
      ores: [1],
      rules: [],
      frules: [],
      times: [],
      hunt: [],
      pool: [1],
      info: null,
    },
  },
  {
    name: 'card-lists',
    fid: 'snap-card-lists',
    f: {
      fields: [
        { key: 'friends', type: 'uidlist', label: '好友', max: 5, itemCheck: true },
        { key: 'order', type: 'sortlist', label: '优先级', checkable: true, offKey: 'off' },
        {
          key: 'items',
          type: 'itemlist',
          label: '物品',
          items: [{ id: 'x', label: '道具X', cap: 3 }],
          head: { name: '物品', num: '上限' },
        },
        {
          key: 'rg',
          type: 'rallygrid',
          rows: [
            {
              name: '目标',
              enableKey: 'rgOn',
              delay: { key: 'rgD' },
              limit: { key: 'rgL', zeroUnlimited: true },
              count: { key: 'rgC', get: () => '1' },
            },
          ],
        },
      ],
    },
    cfg: {
      friends: [{ uid: '1', name: '甲', on: true }],
      order: ['a', 'b'],
      off: [],
      items: { x: { on: 1, max: 2 } },
      rgD: 0,
      rgL: 0,
      rgOn: true,
    },
  },
  {
    name: 'card-sections',
    fid: 'snap-card-sections',
    f: {
      fields: [
        { key: 'a', type: 'checkbox', label: '甲', section: '第一组' },
        { key: 'b', label: '乙', min: 0, step: 1 },
        {
          key: 'c',
          type: 'checkbox',
          label: '丙',
          section: '折叠组',
          secCollapsible: true,
          secCollapsed: true,
        },
        { key: 'd', label: '丁', min: 0, step: 1, showIf: (c) => c.c },
        { key: 'e', type: 'checkbox', label: '戊', section: '第三组' },
      ],
    },
    cfg: { a: true, b: 1, c: false, d: 2, e: true },
  },
];

// ───────────── 真实 feat descriptor 对拍（T1+）：只提取目标类型字段单独渲染，避开同卡其他字段的游戏副作用 ─────────────
// 联盟机甲代捐档位（ranges）：import alliance-boss 注册 descriptor，提取 ranges 字段（纯函数渲染），
// 核对真实 cols/hint/section 在 module 路径下等价。不做全卡 import（text 字段 get 调游戏 API，副作用脆）。
await import('../extension/src/feats/alliance/alliance-boss/index.js');
const bossRangesFd = findFeature('allianceBoss').fields.find((x) => x.type === 'ranges');
CASES.push({
  name: 'feat-alliance-boss-ranges',
  fid: 'allianceBoss',
  f: { fields: [bossRangesFd] },
  cfg: {
    donateRules: [
      { from: 0, to: 0, count: 3 },
      { from: 0, to: 300, count: 5 },
    ],
  },
});

const FIXTURE_DIR = join(root, 'tests/fixtures/ui-snapshots');

/** 生成全部快照到 outDir，返回文件名列表（含 manifest.json）。 */
function generate(outDir) {
  mkdirSync(outDir, { recursive: true });
  const names = [];
  for (const { name, fid, f, cfg } of CASES) {
    configs[fid] = cfg;
    const html = buildFieldsHTML(fid, f);
    writeFileSync(join(outDir, name + '.html'), html);
    names.push(name + '.html');
  }
  // manifest 只记稳定清单（不含时间戳，避免对拍假阳性）
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify({ cases: names }, null, 2) + '\n');
  names.push('manifest.json');
  return names;
}

if (process.argv.includes('--check')) {
  if (!existsSync(FIXTURE_DIR)) {
    console.error('snapshot check FAILED: 基线夹具不存在，先跑 node scripts/ui-snapshot.mjs 生成');
    process.exit(1);
  }
  const tmp = join(tmpdir(), 'pc-ui-snapshot-check-' + process.pid);
  generate(tmp);
  let fail = 0;
  const expected = readdirSync(FIXTURE_DIR);
  for (const file of expected) {
    const a = readFileSync(join(FIXTURE_DIR, file), 'utf8');
    let b;
    try {
      b = readFileSync(join(tmp, file), 'utf8');
    } catch {
      console.error('MISSING  ' + file + '（本次生成缺失）');
      fail++;
      continue;
    }
    if (a !== b) {
      console.error('DIFF     ' + file);
      fail++;
    }
  }
  rmSync(tmp, { recursive: true, force: true });
  if (fail) {
    console.error(`snapshot check FAILED: ${fail} 个文件与基线不符`);
    process.exit(1);
  }
  console.log(`snapshot check OK: ${expected.length} 个文件全部与基线一致`);
} else {
  const names = generate(FIXTURE_DIR);
  console.log(`generated ${names.length} 个快照 → tests/fixtures/ui-snapshots/`);
}
// 真实 feat import 带入常驻 timer（alliance-boss 顶层 createCycle），CLI 完成即显式退出，不等事件 loop 排空
process.exit(0);
