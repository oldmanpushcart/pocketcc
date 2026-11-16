// net-observe（net 观测面工厂）契约单测：deps 全注入，零浏览器桩直驱（feat-ctx 同款习语）。
// 覆盖 Event 归一化、cmd 名表（枚举首见者胜 + PB 兜底）、日志支路、collecting 环形槽/builder 守卫/json()、
// stream 常开订阅、心跳滤除、热路径不变量（filter 只接免费数据、昂贵操作后置、单拍共享 Event）、
// 双口径闸门（recording 长度口径 vs active 非 null 口径）与 reset 清场。
// hook 装配/摘挂的集成语义仍归 net.js（wantSendHooks 经 observe.active() 驱动），此处只钉观测面契约。
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createObserve, Event } from '../../extension/src/core/net-observe.js';

/**
 * 假 deps：game.get 查注入模块表、log 三级录数组、isInstalled 可运行时翻转、syncSendHooks 计次
 * @param {object} [opts] 选项
 * @param {object} [opts.modules] game.get 的模块表（名表/PB 兜底用）
 * @param {boolean} [opts.installed] 初始安装态（缺省 true）
 * @param {number[]} [opts.hb] 心跳号集合初始成员
 * @returns {{deps:object, infos:Array, warns:Array, debugs:Array, calls:object, state:object}}
 */
function makeDeps(opts) {
  opts = opts || {};
  const modules = opts.modules || {};
  const infos = [];
  const warns = [];
  const debugs = [];
  const calls = { sync: 0 };
  const state = { installed: opts.installed !== false };
  const deps = {
    game: {
      get(name) {
        return modules[name] !== undefined ? modules[name] : null;
      },
    },
    log: {
      info(...a) {
        infos.push(a);
      },
      debug(...a) {
        debugs.push(a);
      },
      warn(...a) {
        warns.push(a);
      },
    },
    isInstalled() {
      return state.installed;
    },
    hbCodes: new Set(opts.hb || []),
    syncSendHooks() {
      calls.sync++;
    },
  };
  return { deps, infos, warns, debugs, calls, state };
}

/** 名表模块样例：RequestId 枚举 + NResponseId 嵌套导出 + ProtoBufBiz 兜底 */
const NAME_MODULES_FIX = {
  RequestId: { SEND_FOO: 100, 100: 'SEND_FOO', SEND_BAR: 101, 101: 'SEND_BAR' },
  ResponseId: { SEND_FOO_DUP: 100, 100: 'SEND_FOO_DUP', RESP_BAZ: 102, 102: 'RESP_BAZ' },
  NResponseId: { NResponseId: { PUSH_QUX: 200, 200: 'PUSH_QUX' } },
};

// ── Event 归一化 ─────────────────────────────────────────────────────
test('Event：d 字符串 JSON.parse，status/ord/reqTime/raw 口径', () => {
  const raw = { c: 100, s: 0, o: 7, d: '{"x":1}' };
  const ev = new Event(raw, 1234);
  assert.equal(ev.cmd, 100);
  assert.equal(ev.status, 0);
  assert.deepEqual(ev.data, { x: 1 });
  assert.equal(ev.ord, '7');
  assert.equal(ev.reqTime, 1234);
  assert.equal(ev.raw, raw, 'raw 只包引用（池化对象）');
  assert.ok(typeof ev.ts === 'number');
});

test('Event：载荷优先级 d > pbAck > pbAckV2.data > p，status 兜底链', () => {
  assert.deepEqual(new Event({ c: 1, pbAck: { header: { s: 3 }, a: 1 } }).data, {
    header: { s: 3 },
    a: 1,
  });
  const v2 = new Event({ c: 1, pbAckV2: { header: { s: 4 }, data: { b: 2 } } });
  assert.equal(v2.status, 4);
  assert.deepEqual(v2.data, { b: 2 }, 'pbAckV2 剥信封到内层业务体（与 Ret 同口径）');
  assert.equal(
    new Event({ c: 1, pbAckV2: { header: { s: 0 } } }).data,
    null,
    'pbAckV2 无 data → null',
  );
  assert.deepEqual(new Event({ c: 1, p: '{"y":2}' }).data, { y: 2 });
  assert.equal(new Event({ c: 1 }).data, null);
  assert.equal(new Event({ c: 1 }).status, null);
  // d 解析失败原样返回；ord 缺失为 null；reqTime 非数字为 null
  assert.equal(new Event({ c: 1, d: '{bad' }).data, '{bad');
  assert.equal(new Event({ c: 1 }).ord, null);
  assert.equal(new Event({ c: 1 }, 'nope').reqTime, null);
});

// ── cmd 名表 ─────────────────────────────────────────────────────────
test('nameOf：枚举表首见者胜 + 嵌套导出下钻 + 未知返回 null', () => {
  const { deps } = makeDeps({ modules: NAME_MODULES_FIX });
  const ob = createObserve(deps);
  assert.equal(ob.nameOf(100), 'SEND_FOO', 'RequestId 先扫，抢在 ResponseId 前');
  assert.equal(ob.nameOf(102), 'RESP_BAZ');
  assert.equal(ob.nameOf(200), 'PUSH_QUX', 'NResponseId 嵌套一层 exports 下钻');
  assert.equal(ob.nameOf(999), null);
  assert.equal(ob.nameOf(null), null);
  assert.equal(ob.nameOf(undefined), null);
});

test('nameOf：PB 兜底 getReqName，探测一次缓存、未知 cmd 不反复试', () => {
  let tries = 0;
  const modules = {
    ProtoBufBiz: {
      ProtoBufBiz: {
        instance: {
          getReqName(cmd) {
            tries++;
            return cmd === 300 ? 'PB_REQ' : null;
          },
        },
      },
    },
  };
  const { deps } = makeDeps({ modules });
  const ob = createObserve(deps);
  assert.equal(ob.nameOf(300), 'PB_REQ');
  assert.equal(ob.nameOf(300), 'PB_REQ', '命中回写名表，不再走兜底');
  assert.equal(tries, 1);
  assert.equal(ob.nameOf(301), null);
  assert.equal(ob.nameOf(301), null, 'pbTried 记住失败，不反复调 getReqName');
  assert.equal(tries, 2);
});

test('ensureNames：懒建一次（setLog 口径），game.get 缺失模块自动跳过', () => {
  const { deps, debugs } = makeDeps({ modules: { RequestId: { A: 1 } } });
  const ob = createObserve(deps);
  ob.ensureNames();
  ob.ensureNames();
  assert.equal(debugs.length, 1, '名表只建一次');
  assert.equal(ob.nameOf(1), 'A');
});

// ── 日志支路 ─────────────────────────────────────────────────────────
test('logReq/logInbound：push 与 resp 两种口径，名字未知落 <unknown>', () => {
  const { deps, infos } = makeDeps({ modules: NAME_MODULES_FIX });
  const ob = createObserve(deps);
  ob.logReq('sendPBV2', 100, { x: 1 });
  assert.equal(infos[0][0], 'req  %s %s(%d)');
  assert.equal(infos[0][1], 'sendPBV2');
  assert.equal(infos[0][2], 'SEND_FOO');
  ob.logInbound(undefined, new Event({ c: 200, s: 0, d: '{}' }));
  assert.equal(infos[1][0], 'push %s(%d)%s');
  assert.equal(infos[1][1], 'PUSH_QUX');
  ob.logInbound(1234, new Event({ c: 999, s: 5 }));
  assert.equal(infos[2][0], 'resp %s(%d) status=%s');
  assert.equal(infos[2][1], '<unknown>');
  assert.equal(infos[2][3], 5);
});

// ── collecting：builder 守卫与登记 ───────────────────────────────────
test('collecting：builder 一次性守卫，filter/tap 类型校验', () => {
  const { deps } = makeDeps();
  const ob = createObserve(deps);
  const b = ob.collecting();
  assert.throws(() => b.filter('nope'), /filter requires a function/);
  assert.throws(() => b.tap(42), /tap requires a function/);
  const stop = b.collect();
  assert.throws(() => b.collect(), /already started/);
  assert.throws(() => b.capacity(5), /already started/);
  stop();
});

test('collecting：未安装时 collect 返回空数组 no-op，不登记不 sync', () => {
  const { deps, warns, calls } = makeDeps({ installed: false });
  const ob = createObserve(deps);
  const stop = ob.collecting().collect();
  const r1 = stop();
  assert.deepEqual(r1, []);
  assert.equal(stop(), r1, '幂等同一数组');
  assert.equal(calls.sync, 0);
  assert.equal(ob.recording(), false);
  assert.ok(warns.some((a) => String(a[0]).includes('not installed')));
});

test('collecting：capacity 非法回落缺省并告警', () => {
  const { deps, warns } = makeDeps();
  const ob = createObserve(deps);
  const stop = ob.collecting().capacity(-3).collect();
  assert.ok(warns.some((a) => String(a[0]).includes('capacity')));
  stop();
});

// ── collecting：环形槽与导出 ─────────────────────────────────────────
test('collecting：环形槽绕圈覆盖最旧，stop 导出时序正确（最旧→最新）', () => {
  const { deps } = makeDeps();
  const ob = createObserve(deps);
  const stop = ob.collecting().capacity(3).collect();
  for (let i = 1; i <= 5; i++) ob.recordSend('send', i, { i });
  const out = stop();
  assert.deepEqual(
    out.map((e) => e.cmd),
    [3, 4, 5],
    '容量 3 只留最近三条且时序正确',
  );
  assert.equal(stop(), out, 'stop 幂等返回同一数组');
});

test('collecting：stop 后空数组仍算 hook 需求（active 非 null 口径），recording 长度闸已关', () => {
  const { deps, calls } = makeDeps();
  const ob = createObserve(deps);
  assert.equal(ob.recording(), false);
  assert.equal(ob.active(), false);
  const stop = ob.collecting().collect();
  assert.equal(ob.recording(), true);
  assert.equal(ob.active(), true);
  assert.ok(calls.sync >= 1, 'collect 登记触发 syncSendHooks');
  stop();
  assert.equal(ob.recording(), false, '无订阅者，热路径闸关');
  assert.equal(ob.active(), true, '空数组也算需求，避免采集空档期误摘 hook');
  ob.reset();
  assert.equal(ob.active(), false, 'reset 后才真正归零');
});

test('collecting：json() 隐藏方法——非枚举、合法 JSON、条目单行', () => {
  const { deps } = makeDeps();
  const ob = createObserve(deps);
  const stop = ob.collecting().collect();
  ob.recordSend('send', 1, { a: 1 });
  ob.recordInbound({ c: 2, d: '{"b":2}' }, undefined);
  const out = stop();
  assert.equal(Object.keys(out).length, 2, 'json 不可枚举');
  const text = out.json();
  const parsed = JSON.parse(text);
  assert.equal(parsed.length, 2);
  assert.equal(text.split('\n').length, 4, '外壳两行 + 每条目单行');
});

// ── 热路径不变量 ─────────────────────────────────────────────────────
test('热路径：filter 只接免费 (dir,cmd)，全拒时不做快照/不构造 Event', () => {
  const { deps } = makeDeps();
  const ob = createObserve(deps);
  const seen = [];
  const stop = ob
    .collecting()
    .filter((dir, cmd) => {
      seen.push([dir, cmd]);
      return false;
    })
    .collect();
  // d 挂访问计数 getter：无订阅者通过时绝不应被读（JSON.parse 昂贵操作后置）
  let reads = 0;
  const e = { c: 100 };
  Object.defineProperty(e, 'd', {
    get() {
      reads++;
      return '{"x":1}';
    },
  });
  ob.recordInbound(e, undefined);
  ob.recordSend('send', 100, { x: 1 });
  assert.deepEqual(seen, [
    ['push', 100],
    ['req', 100],
  ]);
  assert.equal(reads, 0, 'filter 全拒 → 不读载荷');
  assert.deepEqual(stop(), []);
});

test('热路径：心跳号在 recordSend/recordInbound 首行无条件滤除', () => {
  const { deps } = makeDeps({ hb: [6385] });
  const ob = createObserve(deps);
  const taps = [];
  const stop = ob
    .collecting()
    .tap((en) => taps.push(en))
    .collect();
  ob.recordSend('sendPBV2', 6385, {});
  ob.recordInbound({ c: 6385, d: '{}' }, 123);
  ob.recordSend('sendPBV2', 100, {});
  assert.deepEqual(
    taps.map((t) => t.cmd),
    [100],
  );
  stop();
});

test('热路径：单拍共享 Event 复用，recordInbound 不重复归一化', () => {
  const { deps } = makeDeps();
  const ob = createObserve(deps);
  const stop = ob.collecting().collect();
  const ev = new Event({ c: 100, d: '{"x":1}' }, 555);
  ob.recordInbound({ c: 100, d: '{"x":1}' }, 555, ev);
  const out = stop();
  assert.equal(out[0].data, ev.data, '复用同一 Event 的 data 引用');
  assert.equal(out[0].rt, 555, 'resp 条目带发包时刻');
  assert.equal(out[0].dir, 'resp');
});

test('热路径：快照隔离——池化报文/发送载荷事后改写不影响已采条目', () => {
  const { deps } = makeDeps();
  const ob = createObserve(deps);
  const stop = ob.collecting().collect();
  const payload = { n: 1 };
  ob.recordSend('send', 100, payload);
  payload.n = 999;
  const pbAck = { v: 1 };
  const e = { c: 101, pbAck };
  ob.recordInbound(e, undefined);
  pbAck.v = 999; // 池化复用改写
  e.c = -1;
  const out = stop();
  assert.equal(out[0].data.n, 1, 'req 载荷已快照');
  assert.equal(out[0].raw.data.n, 1);
  assert.equal(out[0].raw.api, 'send');
  assert.equal(out[1].raw.pbAck.v, 1, '对象值字段深拷');
  assert.equal(out[1].raw.c, 101, '原始值字段留引用但值已定');
  assert.equal(out[1].data.v, 999, 'data 是 Event 活引用（同拍读完口径），只有 raw 是快照');
});

test('filter/tap 异常：视为拒绝/观测失败，各告警一次，不阻断采集', () => {
  const { deps, warns } = makeDeps();
  const ob = createObserve(deps);
  const stop = ob
    .collecting()
    .filter(() => {
      throw new Error('boom-filter');
    })
    .collect();
  ob.recordSend('send', 1, {});
  ob.recordSend('send', 2, {});
  assert.deepEqual(stop(), [], '抛异常 filter 视为不通过');
  const stop2 = ob
    .collecting()
    .tap(() => {
      throw new Error('boom-tap');
    })
    .collect();
  ob.recordSend('send', 3, {});
  ob.recordSend('send', 4, {});
  const out2 = stop2();
  assert.equal(out2.length, 2, 'tap 抛异常不影响入环');
  const filterWarns = warns.filter((a) => String(a[0]).includes('filter error'));
  const tapWarns = warns.filter((a) => String(a[0]).includes('tap error'));
  assert.equal(filterWarns.length, 1, 'filter 告警一次');
  assert.equal(tapWarns.length, 1, 'tap 告警一次');
});

test('collecting：多 filter 短路 AND，tap 入环后回调且条目共享只读', () => {
  const { deps } = makeDeps({ modules: NAME_MODULES_FIX });
  const ob = createObserve(deps);
  const taps = [];
  const stop = ob
    .collecting()
    .filter((dir) => dir === 'req')
    .filter((dir, cmd) => cmd === 100)
    .tap((en) => taps.push(en))
    .collect();
  ob.recordSend('send', 100, { ok: 1 });
  ob.recordSend('send', 101, {});
  ob.recordInbound({ c: 100, d: '{}' }, undefined);
  const out = stop();
  assert.equal(out.length, 1);
  assert.equal(taps.length, 1);
  assert.equal(taps[0], out[0], 'tap 所见即库存（同一引用）');
  assert.equal(out[0].name, 'SEND_FOO', '条目带名表名字');
  assert.equal(out[0].dir, 'req:send');
  assert.ok(out[0].seq >= 1);
});

test('collecting：.log() 预设走 console 彩色 tap（录制基础设施豁免）', () => {
  const { deps } = makeDeps();
  const ob = createObserve(deps);
  const logged = [];
  const m = mock.method(console, 'log', (...a) => logged.push(a));
  try {
    const stop = ob.collecting().log().collect();
    ob.recordSend('sendPBV2', 100, { x: 1 });
    stop();
  } finally {
    m.mock.restore();
  }
  assert.equal(logged.length, 1);
  assert.ok(String(logged[0][0]).includes('%c'), '双色胶囊格式');
});

// ── stream：常开流式订阅 ─────────────────────────────────────────────
test('stream：tap 必填（已安装）、未安装拒绝、unstream 幂等、isStreaming 口径', () => {
  const { deps, warns } = makeDeps({ installed: false });
  const ob = createObserve(deps);
  const noop = ob
    .stream()
    .tap(() => {})
    .start();
  assert.equal(noop(), false);
  assert.ok(warns.some((a) => String(a[0]).includes('not installed')));
  assert.equal(ob.isStreaming(), false);
  // 已安装时 tap 必填（未安装短路在前，不触此校验）
  const ok = makeDeps();
  const ob2 = createObserve(ok.deps);
  assert.throws(() => ob2.stream().start(), /tap is required/);
});

test('stream：命中即 tap 不写环，req/resp/push 三向都喂，unstream 后停', () => {
  const { deps, calls } = makeDeps();
  const ob = createObserve(deps);
  const taps = [];
  const unstream = ob
    .stream()
    .filter((dir, cmd) => cmd !== 999)
    .tap((en) => taps.push(en))
    .start();
  assert.equal(ob.isStreaming(), true);
  assert.equal(ob.recording(), true, '流式订阅者同样驱动热路径闸');
  assert.ok(calls.sync >= 1);
  ob.recordSend('send', 100, { a: 1 });
  ob.recordInbound({ c: 101, d: '{}' }, 777);
  ob.recordInbound({ c: 102, d: '{}' }, undefined);
  ob.recordSend('send', 999, {});
  assert.deepEqual(
    taps.map((t) => t.dir),
    ['req:send', 'resp', 'push'],
  );
  assert.equal(taps[1].rt, 777);
  assert.equal(unstream(), true);
  assert.equal(unstream(), false, '幂等');
  assert.equal(ob.isStreaming(), false);
  ob.recordSend('send', 100, {});
  assert.equal(taps.length, 3, 'unstream 后不再喂');
});

test('stream 与 collecting 并存：同一条包两路各自命中，seq 全局递增', () => {
  const { deps } = makeDeps();
  const ob = createObserve(deps);
  const taps = [];
  const unstream = ob
    .stream()
    .tap((en) => taps.push(en))
    .start();
  const stop = ob.collecting().collect();
  ob.recordSend('send', 100, {});
  const out = stop();
  unstream();
  assert.equal(out.length, 1);
  assert.equal(taps.length, 1);
  assert.equal(out[0], taps[0], '同一条包共享同一 entry（不可变，多订阅者安全）');
  assert.equal(out[0].seq, taps[0].seq, '全局序号每包一个，两路共享');
});

// ── reset 清场 ───────────────────────────────────────────────────────
test('reset：采集器逐个 stop（返回已采条目），流清空，双闸归零', () => {
  const { deps } = makeDeps();
  const ob = createObserve(deps);
  const taps = [];
  const stop = ob.collecting().collect();
  ob.stream()
    .tap((en) => taps.push(en))
    .start();
  ob.recordSend('send', 100, {});
  ob.reset();
  assert.equal(ob.active(), false);
  assert.equal(ob.recording(), false);
  assert.equal(ob.isStreaming(), false);
  const out = stop();
  assert.equal(out.length, 1, 'reset 时 stop 仍返回已采到的条目');
  ob.recordSend('send', 101, {});
  assert.equal(taps.length, 1, '流已清，不再喂');
});

test('reset 后再 collect/stream 可重新登记（net-collect 重装口径）', () => {
  const { deps } = makeDeps();
  const ob = createObserve(deps);
  ob.collecting().collect();
  ob.reset();
  const taps = [];
  const stop = ob
    .collecting()
    .tap((en) => taps.push(en))
    .collect();
  ob.recordSend('send', 100, {});
  assert.equal(taps.length, 1);
  assert.equal(stop().length, 1);
});
