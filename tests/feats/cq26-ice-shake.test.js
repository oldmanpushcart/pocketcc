// cq26-ice-shake（CQ26 开荒摇一摇自动选最高档）纯函数单测：
//   miniGameId 句柄读取（两种 Int64 形态 + 直接给奖那一支 + 被拒应答）、提交计划（过期闸与选档）、
//   重投判定（在途闸挡下的不重投）、奖励面板实参归一、档位展示名。
// 全部断言不发包、不摸游戏符号——feat 模块 import 链会触到浏览器全局，
// 故先最小桩化 window/document/chrome，再动态 import 取导出纯函数（同 cq26-excav 口径）。
import { test } from 'node:test';
import assert from 'node:assert/strict';

// ── 浏览器全局最小桩（模块加载期需要，函数体不触碰）─────────────────────
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

// core 链里的 session/player/scene-watcher 等模块在 import 期就挂常驻 setInterval——只对测试
// harness 的定时器 unref，不参与被测逻辑。
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (fn, ms, ...rest) => {
  const h = realSetInterval(fn, ms, ...rest);
  if (h && typeof h.unref === 'function') h.unref();
  return h;
};

const mod = await import('../../extension/src/feats/cq26/ice-shake.js');
const {
  readMiniGameId,
  tierText,
  planSubmit,
  shouldResubmit,
  rewardPanelArgs,
  TIER_HIGH,
  SUBMIT_EXPIRE_MS,
  MAX_TRIES,
} = mod;

// 实录 fixtures：本场 rec 11981629951662 / dashcam-rec-20261112T011559…-1794417359392 里
// 2117 应答给出的四枚 miniGameId（`{_low,_high}` 是报文序列化形态，等价裸 POJO 输入），
// 十进制串由 BigInt 无精度拼装独立算出（19 位雪花 id，绝不经 Number）。
const RECORDED = [
  { lo: -1155667960, hi: 1146845447, dec: '4925663691570800648' },
  { lo: 522053634, hi: 1146845483, dec: '4925663843572377602' },
  { lo: 488499207, hi: 1146845513, dec: '4925663972387842055' },
  { lo: -635574271, hi: 1146845531, dec: '4925664052868147201' },
];

test('裸 {_low,_high} 形态：四枚实录句柄逐枚解出十进制串（负 _low 补回 2^32）', () => {
  for (const r of RECORDED) {
    const body = { isOk: 1, miniGameId: { _low: r.lo, _high: r.hi, _unsigned: false } };
    assert.equal(readMiniGameId(body, 0), r.dec, `low=${r.lo} high=${r.hi}`);
  }
});

test('Long 实例形态（自带 toString/toNumber）走 int64Str，与 POJO 形态同串', () => {
  const r = RECORDED[0];
  const longLike = {
    toString: () => r.dec,
    toNumber: () => Number(r.dec),
  };
  assert.equal(readMiniGameId({ isOk: 1, miniGameId: longLike }, 0), r.dec);
});

test('字符串句柄原样收下（服务器偶发以十进制串下发）', () => {
  assert.equal(readMiniGameId({ miniGameId: RECORDED[2].dec }, 0), RECORDED[2].dec);
});

test('直接给奖那一支（只有 rewardResult、无 miniGameId）读成空串', () => {
  const body = { isOk: 1, rewardResult: { items: [{ itemId: 62909, itemCount: 1 }] } };
  assert.equal(readMiniGameId(body, 0), '');
});

test('句柄为 0（数字/串/全零高低位三种形态）一律视为无小游戏', () => {
  assert.equal(readMiniGameId({ miniGameId: 0 }, 0), '');
  assert.equal(readMiniGameId({ miniGameId: '0' }, 0), '');
  assert.equal(readMiniGameId({ miniGameId: { _low: 0, _high: 0, _unsigned: false } }, 0), '');
});

test('应答被拒（status≠0）时不代摇，哪怕载荷里挂着句柄', () => {
  const body = { miniGameId: { _low: RECORDED[0].lo, _high: RECORDED[0].hi } };
  assert.equal(readMiniGameId(body, 1), '');
  assert.equal(readMiniGameId(body, 500), '');
  // status 缺省（取不到）时不作为拒绝判据
  assert.equal(readMiniGameId(body), RECORDED[0].dec);
});

test('形态异常载荷不抛异常、回空串', () => {
  assert.equal(readMiniGameId(null, 0), '');
  assert.equal(readMiniGameId(undefined, 0), '');
  assert.equal(readMiniGameId('text payload', 0), '');
  assert.equal(readMiniGameId(0, 0), '');
  assert.equal(readMiniGameId({ miniGameId: { _low: 1, _high: -1 } }, 0), ''); // 拼出负数，非合法句柄
  assert.equal(readMiniGameId({ miniGameId: {} }, 0), '');
});

test('档位展示名：0/1/2 = 低温/中温/高温，未知号回退「档 n」', () => {
  assert.equal(tierText(0), '低温档');
  assert.equal(tierText(1), '中温档');
  assert.equal(tierText(2), '高温档');
  assert.equal(tierText('2'), '高温档');
  assert.equal(tierText(5), '档 5');
  assert.equal(tierText(NaN), '档 NaN');
});

test('提交计划：合法句柄且窗内→只两键且恒发高温档（id 保持十进制串，不预先装箱）', () => {
  const p = planSubmit(RECORDED[0].dec, 0);
  assert.deepEqual(Object.keys(p).sort(), ['id', 'index']);
  assert.equal(p.id, RECORDED[0].dec);
  assert.equal(p.index, TIER_HIGH);
  assert.equal(TIER_HIGH, 2, '高温档就是本 feat 恒发的那一档');
});

test('提交计划：过期边界按闸值取闭区间（= SUBMIT_EXPIRE_MS 仍发，再 +1ms 不发）', () => {
  assert.ok(planSubmit(RECORDED[1].dec, SUBMIT_EXPIRE_MS), '边界上应仍可提交');
  assert.equal(planSubmit(RECORDED[1].dec, SUBMIT_EXPIRE_MS + 1), null);
  assert.equal(planSubmit(RECORDED[1].dec, 9001), null);
});

test('提交计划：不合法句柄（非纯数字/空/0/负数/带小数/null）一律不发', () => {
  for (const bad of [
    '',
    ' 4925663691570800648',
    '492566369157080064a',
    '1.5',
    '-1',
    '0',
    null,
    undefined,
    NaN,
  ]) {
    assert.equal(planSubmit(bad, 0), null, 'bad=' + JSON.stringify(bad));
  }
});

test('提交计划：耗时不可信（负数/NaN）不发（时钟回跳或调用方传错）', () => {
  assert.equal(planSubmit(RECORDED[2].dec, -1), null);
  assert.equal(planSubmit(RECORDED[2].dec, NaN), null);
  assert.equal(planSubmit(RECORDED[2].dec, undefined), null);
});

// 报文实证 dashcam rec 11981629951662 / dashcam-rec-20261112T021006…-1794420606597：
//   同一枚 id 的第二发 2129 撞回 header.s=3 / d=activity_120002（字典表：参数错误），
//   而 NetMgr 对外层 s===3 无条件 ShowTips ⇒ 重投不给奖只在玩家脸上弹错误。
test('重投判定：被在途闸挡下（无抛错文案）绝不重投', () => {
  assert.equal(shouldResubmit('', 1), false);
  assert.equal(shouldResubmit('', 0), false);
  assert.equal(shouldResubmit(undefined, 1), false);
  assert.equal(shouldResubmit(null, 1), false);
});

test('重投判定：发送本身抛错才重试，且不越过 MAX_TRIES 上限', () => {
  assert.equal(shouldResubmit('encode failed', 1), true);
  assert.equal(shouldResubmit('boom', MAX_TRIES - 1), true);
  assert.equal(shouldResubmit('boom', MAX_TRIES), false);
  assert.equal(shouldResubmit('boom', 99), false);
  assert.ok(MAX_TRIES >= 2, '至少给抛错一次重投机会');
});

// 游戏原生成功回调那句 OpenUI(CommonRewardPanel,{serverReward:o.rewardResult}) 的实参口径：
//   应答里 rewardResult 是 `{items,resource}` 对象，原样透传；没有载荷时不开空窗。
test('奖励面板实参：只把非空对象包成 {serverReward}', () => {
  const rr = { items: [{ itemId: 47007004, itemCount: 3 }], resource: {} };
  assert.deepEqual(rewardPanelArgs(rr), { serverReward: rr });
  assert.equal(rewardPanelArgs({}), null);
  assert.equal(rewardPanelArgs([]), null);
  assert.equal(rewardPanelArgs(null), null);
  assert.equal(rewardPanelArgs(undefined), null);
  assert.equal(rewardPanelArgs('47007004'), null);
});
