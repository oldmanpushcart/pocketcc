// 夺宝奇兵「各场模式矩阵」纯函数测试（session-mode.js）：场次判定/开关闸+有效模式解析/播种/9 键归一/showIf 判据。
// 零 DOM 依赖：session-mode.js 只 import core/util.js（零 import 叶子），node 直测无需桩化 window。
// 日期锚点：2026-11-20=周五 / 21=周六 / 22=周日 / 19=周四（本地时区构造，与 todayStr/getDay 口径自洽，不依赖运行机器时区）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SESSION_KEYS,
  sessionAt,
  resolveMode,
  sanitizeSessionModes,
  seedFollowModes,
  anySessionMain,
} from '../../extension/src/feats/activity/cs-hunt/session-mode.js';

/** 某自然日的三个 2h 时段（03–05 / 11–13 / 19–21，本地时区构造） */
function daySlots(y, m, d) {
  return [3, 11, 19].map((h) => ({
    begin: new Date(y, m, d, h, 0, 0).getTime(),
    end: new Date(y, m, d, h + 2, 0, 0).getTime(),
  }));
}
const FRI = daySlots(2026, 10, 20);
const SAT = daySlots(2026, 10, 21);
const SUN = daySlots(2026, 10, 22);
const ALL = FRI.concat(SAT, SUN);
const HOUR = 3600000;

test('SESSION_KEYS：9 键覆盖周五/六/日 × 三场', () => {
  assert.equal(SESSION_KEYS.length, 9);
  assert.deepEqual(SESSION_KEYS.slice(0, 3), ['modeFri1', 'modeFri2', 'modeFri3']);
  assert.deepEqual(SESSION_KEYS.slice(6), ['modeSun1', 'modeSun2', 'modeSun3']);
});

test('sessionAt：三天 × 三场命中，day/index/label 正确', () => {
  const days = [
    { slots: FRI, day: 'Fri', cn: '周五' },
    { slots: SAT, day: 'Sat', cn: '周六' },
    { slots: SUN, day: 'Sun', cn: '周日' },
  ];
  for (const d of days) {
    for (let i = 0; i < 3; i++) {
      const s = sessionAt(ALL, d.slots[i].begin + HOUR);
      assert.ok(s, d.cn + ' 第' + (i + 1) + '场应命中');
      assert.equal(s.day, d.day);
      assert.equal(s.index, i + 1);
      assert.equal(s.label, d.cn + '·第' + ['一', '二', '三'][i] + '场');
    }
  }
});

test('sessionAt：时段边界含端点（begin/end 当刻算场内，end+1ms 出窗）', () => {
  const s0 = FRI[0];
  assert.equal(sessionAt(ALL, s0.begin).index, 1);
  assert.equal(sessionAt(ALL, s0.end).index, 1);
  assert.equal(sessionAt(ALL, s0.end + 1), null);
});

test('sessionAt：场间空档/未开跑时刻回 null', () => {
  // 周五 07:00 落在第一场与第二场之间
  assert.equal(sessionAt(ALL, new Date(2026, 10, 20, 7, 0, 0).getTime()), null);
  // 周四（非活动日）即使构造了时段也不认
  const thu = daySlots(2026, 10, 19);
  assert.equal(sessionAt(thu, thu[0].begin + HOUR), null);
});

test('sessionAt：同日乱序下发仍按 begin 排序取序', () => {
  const shuffled = [FRI[2], FRI[0], FRI[1]];
  assert.equal(sessionAt(shuffled, FRI[0].begin + HOUR).index, 1);
  assert.equal(sessionAt(shuffled, FRI[2].begin + HOUR).index, 3);
});

test('sessionAt：同日超 3 场时第 4 场回 null（前 3 场不受影响）', () => {
  const extra = {
    begin: new Date(2026, 10, 20, 22, 0, 0).getTime(),
    end: new Date(2026, 10, 20, 23, 0, 0).getTime(),
  };
  const four = FRI.concat([extra]);
  assert.equal(sessionAt(four, extra.begin + HOUR / 2), null);
  assert.equal(sessionAt(four, FRI[1].begin + HOUR).index, 2);
});

test('sessionAt：空 slots/非法 nowMs/坏行一律 null', () => {
  assert.equal(sessionAt(null, FRI[0].begin), null);
  assert.equal(sessionAt([], FRI[0].begin), null);
  assert.equal(sessionAt(ALL, 0), null);
  assert.equal(sessionAt([null, { begin: 0, end: 0 }], FRI[0].begin), null);
});

test('resolveMode：开关开时格子钉 main/helper 覆盖主设置（两态主设置各测）', () => {
  const now = FRI[1].begin + HOUR; // 周五第二场
  for (const base of ['main', 'helper']) {
    const cfg = Object.assign({ mode: base, modeBySession: true }, sanitizeSessionModes({}));
    cfg.modeFri2 = base === 'main' ? 'helper' : 'main';
    assert.equal(resolveMode(cfg, ALL, now), base === 'main' ? 'helper' : 'main');
  }
});

test('resolveMode：开关关恒回主设置（矩阵隐藏时格子值不参与决策，互斥语义）', () => {
  const now = FRI[1].begin + HOUR;
  for (const base of ['main', 'helper']) {
    const cfg = Object.assign({ mode: base }, sanitizeSessionModes({})); // 无 modeBySession=关
    cfg.modeFri2 = base === 'main' ? 'helper' : 'main'; // 钉反档也不生效
    assert.equal(resolveMode(cfg, ALL, now), base);
    cfg.modeBySession = false;
    assert.equal(resolveMode(cfg, ALL, now), base);
  }
});

test('resolveMode：开关开时跟随格/非法值/未知时段/窗外回退主设置', () => {
  const now = FRI[1].begin + HOUR;
  const follow = Object.assign({ mode: 'helper', modeBySession: true }, sanitizeSessionModes({}));
  assert.equal(resolveMode(follow, ALL, now), 'helper'); // 全 follow → 主设置
  const bad = Object.assign({ mode: 'main', modeBySession: true }, sanitizeSessionModes({}));
  bad.modeFri2 = 'bogus';
  assert.equal(resolveMode(bad, ALL, now), 'main'); // 非法格值 → 主设置
  assert.equal(resolveMode(follow, null, now), 'helper'); // 时段表未知 → 主设置
  assert.equal(resolveMode(follow, ALL, new Date(2026, 10, 20, 7).getTime()), 'helper'); // 窗外 → 主设置
  assert.equal(resolveMode(null, ALL, now), 'main'); // 无 cfg 兜底 main
});

test('seedFollowModes：follow 格播种为 base，已钉格保留（off→on 往返不抹定制）', () => {
  const raw = Object.assign({}, sanitizeSessionModes({}), { modeFri1: 'main', modeSat3: 'helper' });
  for (const base of ['main', 'helper']) {
    const out = seedFollowModes(raw, base);
    assert.equal(Object.keys(out).length, 9);
    assert.equal(out.modeFri1, 'main'); // 已钉保留
    assert.equal(out.modeSat3, 'helper');
    assert.equal(out.modeFri2, base); // follow 播种
    assert.equal(out.modeSun3, base);
  }
  // 二次播种幂等：全 main/helper 后再播不变化
  const once = seedFollowModes(raw, 'helper');
  assert.deepEqual(seedFollowModes(once, 'main'), once);
  // 非法 base 兜底 main；null raw 全播
  assert.equal(seedFollowModes(null, 'bogus').modeFri1, 'main');
  assert.equal(seedFollowModes(null, 'helper').modeFri1, 'helper');
});

test('sanitizeSessionModes：缺省/非法回 follow，main/helper 保留，9 键齐全', () => {
  const out = sanitizeSessionModes({ modeFri1: 'main', modeSat3: 'helper', modeSun2: 'xxx' });
  assert.equal(Object.keys(out).length, 9);
  assert.equal(out.modeFri1, 'main');
  assert.equal(out.modeSat3, 'helper');
  assert.equal(out.modeSun2, 'follow');
  assert.equal(out.modeFri2, 'follow');
  assert.deepEqual(sanitizeSessionModes(null), sanitizeSessionModes({}));
});

test('anySessionMain：矩阵模式全格陪跑才假；传 base 时 follow 残留按 base 计（showIf 展开判据）', () => {
  const allFollow = Object.assign({ mode: 'helper' }, sanitizeSessionModes({}));
  assert.equal(anySessionMain(allFollow), false);
  assert.equal(anySessionMain(null), false);
  const pinned = Object.assign({}, allFollow, { modeSun3: 'main' });
  assert.equal(anySessionMain(pinned), true);
  const allHelper = Object.assign({}, allFollow);
  for (const k of SESSION_KEYS) allHelper[k] = 'helper';
  assert.equal(anySessionMain(allHelper), false);
  assert.equal(anySessionMain(allHelper, 'main'), false); // 全钉陪跑：base 也救不回
  // follow 残留（手改存档未播种）：传 base=main 按主跑计，与 resolveMode 兜底同口径
  assert.equal(anySessionMain(allFollow, 'main'), true);
  assert.equal(anySessionMain(allFollow, 'helper'), false);
});
