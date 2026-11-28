// 跨服登录态归类契约（真机实证 2026-11-28：盟决 7631 换服重连后 mapType 仍是本服图变体 202，
// CrossUtils.setMapTmxData 无 crossType=7 分支 → 旧逻辑把敌对战服误判成 homeland/crossMap=false）。
// 纪律：换服重连型跨服只能靠 ServerId vs OriginServerId 识别；未认出的形态落 unknown，不许冒充本服。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { worldSignals } from '../../extension/src/core/acl/world.js';
import { worldState } from '../../extension/src/core/world/state.js';
import { reprobe } from '../../extension/src/core/acl-engine.js';

/** 真机 dump 字段值（2026-11-28 盟决敌对区 4397） */
const REAL_PUSH = {
  ServerId: 4397,
  OriginServerId: 4402,
  ServerState: 1, // Donate
};

/**
 * 挂 __require 桩跑一次，并清掉所有相关 probe 缓存。
 * @param {{user?:object, crossType?:number, mapType?:number, c4?:boolean}} opt 可变信号
 * @returns {object} worldState 快照
 */
function withStub(opt) {
  const user = Object.assign({}, REAL_PUSH, opt.user || {});
  const crossType = opt.crossType == null ? 7 : opt.crossType;
  const mapType = opt.mapType == null ? 202 : opt.mapType;
  const c4 = !!opt.c4;
  const cross = {
    isTMServer: () => false,
    isMasterMatch: () => false,
    isTeamLegendServer: () => false,
    isNewCAB: () => false,
    isEniNeutralMatch: () => false,
    isCQ25NeutralMatch: () => false,
    isC4: () => c4,
    isC8: () => false,
    isC8S2: () => false,
    isInAnyServer: () => false,
    isPABServer: () => false,
    isPabFighting: () => false,
    getIsCabMap: () => false,
    crossType,
    _tmServerType: crossType === 7 ? 7 : 0,
  };
  const modules = {
    DataCenter: { DATA: { UserData: user } },
    CrossUtils: { __esModule: true, default: cross },
    NWorldMapCoreBiz: {
      __esModule: true,
      default: { mapType, watchingType: 0 },
      NWorldMapType: {
        1: 'world',
        12: 'adp_war',
        201: 'world_NTerrain',
        202: 'world_NTerrain_border',
      },
      WatchingBattleType: { 0: 'NONE' },
    },
    GameDefine: { ServerState: { 0: 'Normal', 1: 'Donate', 2: 'Ready', 3: 'Fight' } },
  };
  reprobe();
  globalThis.__require = (name) => modules[name] || null;
  try {
    return worldState.refresh();
  } finally {
    delete globalThis.__require;
    reprobe();
  }
}

test('盟决换服重连（4397/4402, crossType=7, mapType=202）：归 adp_war 且 crossMap=true', () => {
  const st = withStub({});
  assert.equal(st.raw.serverId, 4397);
  assert.equal(st.raw.originServerId, 4402);
  assert.equal(st.raw.crossLogin, true);
  assert.equal(st.raw.crossType, 7);
  assert.equal(st.kind, 'adp_war');
  assert.equal(st.reason, 'cross-login-adp');
  assert.equal(st.crossMap, true);
  assert.equal(st.ready, true);
});

test('跨服登录但形态号未知（crossType=11）：落 unknown 保守档，不冒充 homeland', () => {
  const st = withStub({ crossType: 11 });
  assert.equal(st.kind, 'unknown');
  assert.equal(st.reason, 'cross-login-type-11');
  assert.equal(st.crossMap, true);
  // unknown 不在 homeland 白名单 → homeland-only feat 由门控自动 pause
  assert.equal(worldState.matchesKind(['homeland'], 'unknown'), false);
});

test('本服常态（ServerId=OriginServerId, crossType=-1, mapType=202）：仍归 homeland 且 crossMap=false', () => {
  const st = withStub({
    user: { ServerId: 4402, OriginServerId: 4402 },
    crossType: -1,
  });
  assert.equal(st.raw.crossLogin, false);
  assert.equal(st.kind, 'homeland');
  assert.equal(st.reason, 'maptype-world_NTerrain_border');
  assert.equal(st.crossMap, false);
});

test('天梯 KVK（crossType 为空、eightServerType 置位）：谓词链先命中 kvk，不被 crossLogin 分支劫持', () => {
  // 登录包不带 crossType 时 eightServerType=server_type（4/8/6 折算）；此处以 isC4 桩代八国谓词命中
  const st = withStub({ crossType: -1, c4: true, mapType: 4 });
  assert.equal(st.raw.crossLogin, true); // 迁入跨服图后 currk 可能变目标服
  assert.equal(st.raw.crossType, -1); // 但登录包没有形态号
  assert.equal(st.kind, 'kvk_c4');
  assert.equal(st.reason, 'cross-c4'); // 不是 cross-login-adp / cross-login-type-*
  assert.equal(st.crossMap, true);
});

test('worldSignals：userData 实时读，跨服登录判据不依赖 mapType', () => {
  const modules = {
    DataCenter: { DATA: { UserData: { ServerId: 4397, OriginServerId: 4402, ServerState: 1 } } },
    CrossUtils: {
      __esModule: true,
      default: { isTMServer: () => true, crossType: 7, _tmServerType: 7 },
    },
  };
  reprobe();
  globalThis.__require = (name) => modules[name] || null;
  try {
    assert.equal(worldSignals.serverId(), 4397);
    assert.equal(worldSignals.originServerId(), 4402);
    assert.equal(worldSignals.crossLogin(), true);
    assert.equal(worldSignals.crossType(), 7);
  } finally {
    delete globalThis.__require;
    reprobe();
  }
});
