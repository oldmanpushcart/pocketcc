/**
 * 假面舞会（2026 万圣节活动，MASK_DANCE / cityReward）运行时探针（DevTools 一次性粘贴运行）
 *
 * 目的：回填 extension/docs/feat-假面舞会.md §4 的五项运行时缺口——
 *   §1 UserData 上的「今日已领次数 / 已领实例名单」字段与 getter 名（feat 判据的权威源）；
 *   §2 mask_mystery_party 配置表整表实值（daily_limit / reward_num / cruis_times / msg_type）
 *      + 活动 38015600 的 type_para7（= 2504 DANCE_GET_LIST 的 itemId 入参）；
 *   §3 当前视口/全图里带 cityReward 的基地（instanceId / num / endTimeMilli 实时形态）；
 *   §4 【可选发包】2504 DANCE_GET_LIST 应答形状：danceList[] 是否自带坐标 + pid + received
 *      （决定 feat 能否脱离聊天卡片独立发现舞会）；
 *   §5 【可选发包】2503 DANCE_GET_REWARD 的距离闸门（远处基地是否被服务器拒 + 拒因键）。
 *
 * 运行前提：已加载 pocketcc 扩展并登录进游戏，且**假面舞会正在开启中**（盟友刚用过 260617001~005 类道具，
 *   基地头顶有宝箱）。§4/§5 需要 SEND_LIST / SEND_CLAIM 显式置 true，默认全关 = 纯只读。
 *
 * ⚠️ 副作用：§5 会真的领走一次每日名额（不可回退）。只在「今天还没领满、且愿意消耗 1 次」时开启；
 *   距离闸门也可以反向验证——先飞到一个很远的坐标（不在任何舞会附近）再跑 §5，看是否被拒。
 * 合规：只读游戏内存 + 经 pocketcc.net 公开 promise 封装发包，不调游戏 Update/Delete、不 OpenUI。
 */

/** @type {boolean} §4 是否发 2504 DANCE_GET_LIST（只读查询，无副作用，建议 true） */
const SEND_LIST = true;
/** @type {boolean} §5 是否发 2503 DANCE_GET_REWARD（会消耗一次当日名额，谨慎） */
const SEND_CLAIM = false;
/** @type {string|null} §5 指定开启者 pid（字符串，防 19 位精度截断）；null = 取 §3 扫到的第一个未领实例 */
const CLAIM_PID = null;

(function halloweenBoxProbe() {
  const TAG = '[hb-probe] ';
  const PC = window.pocketcc;
  if (!PC || !PC.game || typeof PC.game.get !== 'function') {
    console.error(TAG + 'window.pocketcc.game.get 不可用：确认已加载扩展并登录进游戏。');
    return;
  }
  const G = (n) => {
    try {
      return PC.game.get(n);
    } catch (e) {
      console.warn(TAG + 'game.get(%s) 失败', n, e);
      return null;
    }
  };
  const unwrap = (m, k) => (m && (m[k] || (m.default && m.default[k]))) || null;
  const H = (m) => console.log('%c\n===== ' + m + ' =====', 'color:#4a90d9;font-weight:bold');
  const str = (v) => {
    try {
      return typeof v === 'string' ? v : JSON.stringify(v);
    } catch (e) {
      return '<' + typeof v + '>';
    }
  };

  const DC = unwrap(G('DataCenter'), 'DATA');
  const U = DC && DC.UserData;
  if (!U) {
    console.error(TAG + 'DataCenter.DATA.UserData 不可用。');
    return;
  }
  const TM = unwrap(G('TableManager'), 'TABLE');
  const TN = unwrap(G('TableName'), 'TableName') || {};
  const L = unwrap(G('LocalManager'), 'LOCAL');
  const text = (k) => {
    if (!k || !L || typeof L.getText !== 'function') return String(k == null ? '' : k);
    try {
      return String(L.getText(String(k)) || k);
    } catch (e) {
      return String(k);
    }
  };

  // ── 1) UserData：舞会/宝箱相关的自有键与 getter（含原型链，只列命中项） ──
  H('1) UserData 上的 dance / cityReward / Receive 字段与 getter');
  const KEY_RE = /dance|cityReward|receivedInst|receiveDance/i;
  const hits = {};
  const scan = (obj, from) => {
    for (const k of Object.getOwnPropertyNames(obj)) {
      if (!KEY_RE.test(k)) continue;
      let v;
      try {
        v = U[k];
      } catch (e) {
        v = '<threw>';
      }
      hits[k] = from + ' = ' + str(v).slice(0, 300);
    }
  };
  scan(U, 'own');
  let proto = Object.getPrototypeOf(U);
  let depth = 0;
  while (proto && depth++ < 5) {
    scan(proto, 'proto#' + depth);
    proto = Object.getPrototypeOf(proto);
  }
  console.table(hits);
  if (!Object.keys(hits).length)
    console.warn(
      TAG + '没扫到任何 dance/cityReward 键 —— 登录期未全量下发，feat 须自带内存镜像（§1 缺口成立）。',
    );

  // ── 2) 配置表 mask_mystery_party 整表 + 活动 38015600 的 type_para7 ──
  H('2) mask_mystery_party 整表（daily_limit / reward_num / cruis_times）');
  const T_PARTY = TN.mask_mystery_party || TN.MASK_MYSTERY_PARTY || 'mask_mystery_party';
  const rowsOf = (t) => {
    try {
      return (TM && TM.getTableGroupArray && TM.getTableGroupArray(t)) || [];
    } catch (e) {
      console.warn(TAG + ' 读表失败 %s', t, e);
      return [];
    }
  };
  const byKey = (t, key, val) => {
    try {
      return (TM && TM.getTableByKeyFromBuffer && TM.getTableByKeyFromBuffer(t, key, val)) || [];
    } catch (e) {
      return [];
    }
  };
  const rows = rowsOf(T_PARTY);
  console.log('表名:', T_PARTY, '行数:', rows.length);
  if (rows.length) {
    console.log('首行全部字段名:', Object.keys(rows[0]));
    console.table(
      rows.map((r) => ({
        item_id: r.item_id,
        中文: text('item_name_' + r.item_id),
        daily_limit: r.daily_limit,
        reward_num: r.reward_num,
        cruis_times: r.cruis_times,
        msg_type: r.msg_type,
        share_msg_key: r.share_msg_key,
        reward_icon: r.reward_icon,
      })),
    );
  } else {
    console.warn(TAG + '表未加载（行数 0）：点开活动面板 / 舞会开启期重跑一次。');
  }
  // 道具 260617001..006 逐个反查（表键可能是 item_id 也可能是 id）
  const probeItems = [260617001, 260617002, 260617003, 260617004, 260617005, 260617006];
  const itemRows = {};
  for (const id of probeItems) {
    const one = byKey(T_PARTY, 'item_id', String(id))[0] || byKey(T_PARTY, 'id', String(id))[0];
    itemRows[id] = one ? '命中 ' + str(one).slice(0, 200) : '无行';
  }
  console.table(itemRows);

  H('2b) 活动 38015600（假面迷城）配置：type_para7 = 2504 的 itemId 入参');
  const T_ACT = TN.activity || TN.ACTIVITY || 'activity';
  const act = byKey(T_ACT, 'id', '38015600')[0] || rowsOf(T_ACT).find((r) => String(r.id) === '38015600');
  if (act) {
    const para = {};
    for (const k of Object.keys(act)) {
      if (/^type_para\d+$|^type$|^id$|^name$|^icon$/i.test(k)) para[k] = act[k];
    }
    console.log('命中活动行（节选）:', para);
    console.log('全字段名:', Object.keys(act));
    for (const k of Object.keys(act)) {
      if (/para/i.test(k)) console.log('  ', k, '=', str(act[k]).slice(0, 220));
    }
  } else {
    console.warn(TAG + 'activity 表里没找到 38015600（表名漂移或未下发），2504 入参先按 260617005 试。');
  }

  // ── 3) 当前内存地图里带 cityReward 的基地 ──
  H('3) 视口瓦片里带 cityReward 的基地（instanceId / num / endTimeMilli）');
  const nowSec = Number(DC.ServerTime) || Math.floor(Date.now() / 1000);
  const found = [];
  const NWM = G('NWorldMapData');
  const inst = NWM && (NWM.instance || (NWM.default && NWM.default.instance));
  const walk = (obj, path) => {
    if (!obj || typeof obj !== 'object') return;
    if (obj.cityReward && typeof obj.cityReward === 'object') {
      const cr = obj.cityReward;
      found.push({
        path,
        x: obj.x != null ? obj.x : obj.tileX,
        y: obj.y != null ? obj.y : obj.tileY,
        pid: obj.pid,
        itemId: cr.itemId,
        instanceId: str(cr.instanceId),
        num: cr.num,
        players: Array.isArray(cr.players) ? cr.players.length : cr.players,
        endTimeMilli: str(cr.endTimeMilli),
        剩余秒: Math.floor(Number(cr.endTimeMilli) / 1000 - nowSec),
      });
    }
  };
  try {
    const tileMgr = inst && inst.tileData ? inst.tileData : inst;
    const mapLike = tileMgr && (tileMgr.tileEntitys || tileMgr.tiles || tileMgr.pointMap || tileMgr.data);
    if (mapLike && typeof mapLike.forEach === 'function') {
      mapLike.forEach((v, k) => walk(v && v.extData ? v.extData : v, 'key=' + k));
    } else {
      console.warn(TAG + 'NWorldMapData.instance 瓦片容器结构变了，手工兜底：见 §3b。');
    }
  } catch (e) {
    console.warn(TAG + '遍历瓦片失败', e);
  }
  if (found.length) console.table(found);
  else console.log('内存图里暂无 cityReward（未在世界图 / 舞会未开启 / 容器键名漂移）——看 §3b。');

  H('3b) 本人坐标与服号（射程闸门算分用）');
  console.log({
    UID: str(U.UID),
    ServerId: U.ServerId,
    WorldCoord: str(U.WorldCoord),
    ServerTime: nowSec,
    AllianceAid: U.Alliance && U.Alliance.Aid,
  });

  // ── 4) 【可选发包】2504 DANCE_GET_LIST 应答形状 ──
  H('4) 2504 DANCE_GET_LIST（SEND_LIST=' + SEND_LIST + '）');
  const net = PC.net;
  if (!SEND_LIST) {
    console.log('已跳过（把 SEND_LIST 置 true 再跑）。');
  } else if (!net || typeof net.sendPBV2 !== 'function') {
    console.warn(TAG + 'window.pocketcc.net 不可用。');
  } else {
    const itemIds = (rows.length ? rows.map((r) => +r.item_id) : probeItems).filter(
      (v) => Number.isFinite(v),
    );
    (async () => {
      for (const itemId of itemIds) {
        try {
          const ret = await net.sendPBV2(2504, { itemId });
          const d = typeof ret.data === 'string' ? JSON.parse(ret.data) : ret.data;
          const list = (d && d.danceList) || [];
          console.log(
            TAG + '2504 itemId=%s ok=%s code=%s listLen=%d',
            itemId,
            ret.ok,
            ret.code,
            list.length,
          );
          if (list.length) {
            console.log('  首条字段名:', Object.keys(list[0]));
            console.table(
              list.slice(0, 10).map((e) => ({
                字段全量: str(e).slice(0, 260),
              })),
            );
          } else if (!ret.ok) {
            console.log('  拒因 header.d 译文:', text(ret.reason || ''), 'raw:', str(ret.data).slice(0, 200));
          }
        } catch (e) {
          console.warn(TAG + '2504 itemId=%s 抛错', itemId, e);
        }
      }
      console.log(TAG + '判读：danceList 若含 {x,y,pid,instanceId,received} → feat 可脱离聊天卡独立发现。');
      runClaim();
    })();
  }

  // ── 5) 【可选发包】2503 距离闸门 ──
  function runClaim() {
    H('5) 2503 DANCE_GET_REWARD 距离闸门（SEND_CLAIM=' + SEND_CLAIM + '）');
    if (!SEND_CLAIM) {
      console.log('已跳过（会消耗一次当日名额，确认后再置 true）。');
      return;
    }
    if (!net || typeof net.sendPBV2 !== 'function') {
      console.warn(TAG + 'window.pocketcc.net 不可用。');
      return;
    }
    let pid = CLAIM_PID;
    if (!pid && found.length) {
      const mine = found.find((f) => {
        const list = U.myReceiveDance || U.ItemCityRewardReceivedInstIds || [];
        return Array.isArray(list) ? list.indexOf(String(f.instanceId)) < 0 : true;
      });
      pid = mine && mine.pid != null ? String(mine.pid) : null;
    }
    if (!pid) {
      console.warn(TAG + '拿不到开启者 pid：手工把 CLAIM_PID 填成 §3 里的 pid（字符串）。');
      return;
    }
    const me = U.WorldCoord || {};
    const tgt = found.find((f) => String(f.pid) === pid) || {};
    console.log(
      TAG + '发起领取 pid=%s;目标=(%s,%s);我=(%s,%s);切比雪夫距离=%s',
      pid,
      tgt.x,
      tgt.y,
      me.x,
      me.y,
      tgt.x != null ? Math.max(Math.abs(tgt.x - (me.x | 0)), Math.abs(tgt.y - (me.y | 0))) : '?',
    );
    net
      .sendPBV2(2503, { targetUidStr: String(pid) })
      .then((ret) => {
        console.log(TAG + '2503 ok=%s code=%s data=%s', ret.ok, ret.code, str(ret.data).slice(0, 600));
        if (!ret.ok) {
          const raw = String(ret.data == null ? '' : ret.data).trim();
          console.log(TAG + '拒因原文=%s;译文=%s', raw, text(raw));
          console.log(TAG + '判读：被拒且译文含「距离/范围」→ 射程闸门存在；s=0 成功 → 服务端不校验距离。');
        }
      })
      .catch((e) => console.warn(TAG + '2503 抛错', e));
  }
})();
