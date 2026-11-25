// legacy sendPB 发送 seam 回归：完整 pbAck 归一、header.d 拒因、false 门禁立即回落 CODE_NOT_SENT。
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = globalThis.window || {
  addEventListener() {},
  removeEventListener() {},
  location: { href: '' },
};
let transport;
let calls;
const receiver = { onMessage() {} };
const modules = {
  NetMgr: { NET: null },
  NetReciver: { getInstance: () => receiver },
};
globalThis.__require = (name) => modules[name] || null;
const { netApi } = await import('../../extension/src/core/net.js');

beforeEach(() => {
  calls = [];
  transport = {
    _heartbeatCode: 0,
    checkRequestIdNoRes: () => false,
    sendPB(cmd, data, target, cb) {
      calls.push({ cmd, data });
      cb({ pbAck: { header: { s: 0 }, shoppingCarBuy: { reward: {} } } });
      return true;
    },
  };
  modules.NetMgr.NET = transport;
  receiver.onMessage = function () {};
  assert.equal(netApi.install(), true);
});

afterEach(() => {
  netApi.uninstall();
});

test('sendPB 成功：data 保留完整 pbAck，不错误剥成 V2 data', async () => {
  const ret = await netApi.sendPB(4204, { header: {} });
  assert.equal(ret.ok, true);
  assert.deepEqual(ret.data.shoppingCarBuy, { reward: {} });
  assert.deepEqual(calls, [{ cmd: 4204, data: { header: {} } }]);
});

test('sendPB 拒绝：code 与 header.d reason 均保留', async () => {
  transport.sendPB = (cmd, data, target, cb) => {
    cb({ pbAck: { header: { s: 2001, d: 'not_ready' }, shoppingCarBuy: null } });
    return true;
  };
  const ret = await netApi.sendPB(4203, {});
  assert.equal(ret.ok, false);
  assert.equal(ret.code, 2001);
  assert.equal(ret.reason, 'not_ready');
});

test('sendPB 门禁返回 false：立即 reject，不等待永不来的应答', async () => {
  transport.sendPB = () => false;
  await assert.rejects(netApi.sendPB(4203, {}), /SendPB \[4203\] failed/);
});

test('sendGuarded(sendPB) 门禁 false：归一 CODE_NOT_SENT 并触发 onError', async () => {
  transport.sendPB = () => false;
  let errors = 0;
  const ret = await netApi.sendGuarded(
    4203,
    {},
    {
      protocol: 'sendPB',
      onError() {
        errors++;
      },
    },
  );
  assert.equal(ret.ok, false);
  assert.equal(ret.code, -1);
  assert.equal(errors, 1);
});
