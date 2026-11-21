/**
 * auto-farm 采集技能装载（skill-attach）· 录制仿真对拍 Manifest。
 *
 * 与 quick-repair / cs-hunt 同层：只声明本子引擎的协议号、现场态与闸门规则；
 * 读录制、二分回溯、应答配对、报告打印、退出码全交给 scripts/replay/ 内核。
 *
 * 运行：node scripts/replay/run.mjs --manifest auto-farm-skill [录制...] [--verbose]
 *      npm run verify:auto-farm-skill
 *
 * 校验维度（判据字典与 feat 共用 constants.js；分级纪律对齐 replay-conformance：
 * HARD 只放「跨版本恒成立」的不变量，SOFT/OBSERVATION 只报不 fail）：
 *
 *   D1 载荷形态（HARD）：897 req 键集恒 {heroId,index,itemId,isBuffSlot,skillsIndex}；
 *      898 恒 {heroId,index,isBuffSlot,skillsIndex}；1345 恒 {heroId,skillsIndex}；
 *      heroId 正数（number|十进制串）、index≥0、897 itemId>0、skillsIndex∈{1,2}。
 *      计划文本的「skillsIndex:2」是 feat 产物口径；温泰真人录制（20261121）实证 UI 操作哪组就写哪组
 *     （skillsIndex∈{1,2}），照搬会让真人对拍恒 FAIL——「feat 段恒 2」收敛进 D3 的组2 流内断言。
 *   D2 发送通道（HARD）：本族 req dir 恒 'req:send'、resp dir 恒 'resp'
 *     （V1 旧 JSON 链路，对齐 feat sendGuarded {protocol:'send'}；20261121 两段录制逐条直证）。
 *   D3 组2 流配对闸（HARD）：per heroId，每个 1345→2 必有配对 1345→1（录制收尾的还原段豁免→skip，
 *      feat 侧由 release-in-finally 保障不触此口）；组2 流（→2 未闭）内的 897/898 skillsIndex 恒 2
 *     （卸书须组2 生效，feat/真人同口径）；898 受理后同槽 1200ms 内不得再 897（防抖：
 *      跨队轮转的合法再装间隔由 marchInterval 节拍保证，秒级以上，1200ms 内再现即借还抖动）。
 *   D4 账目守恒（观察）：897 受理伴随 10401 同 itemId amount 下降（缺席且受理 = 同英雄跨组平装放行，
 *      正常——温泰 L37 直证）；898 受理伴随上升（最后注销还账；另一组还有登记不回写）。
 *      20261121 两段是纯复制/组2 卸登记段，零账变零 10401 → 样本 0 走 skip（账目扣账段在更早会话，未录制）。
 *   D5 前向完备（SOFT）：skill 勾选队伍应有 attach 流水——真人对拍没有面板规则上下文，
 *      只统计「1345→2 流收口后 120s 内出现 902 行军」的邻接计数作量级参考，恒不判负。
 *   D6 应答与 10906 确认（观察）：受理应答配对率（V1 业务码在 raw.s，0=受理、3=业务拒、拒因 data 裸串）；
 *      受理后 [reqTs, respTs+2s] 窗内同英雄 10906 到达率（实证 66~104ms、先于 resp）。
 *   D7 纯函数导出面（HARD，静态）：skill-attach.js 可在 Node 装载（与单测同款浏览器全局最小桩），
 *      纯函数层导出在册——防纯函数层被改崩后对拍照跑的假绿。
 *
 * 协议字典来源：CMD_/PUSH_ 协议号与 auto-farm feat 共用 constants.js（B6 就近收编，纯常量模块可直 import）；
 *   D3 的防抖窗/收尾豁免窗是本 manifest 的分析窗（观察口径），不是 feat 行为契约，故留本地常量。
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { scanNDJSON } from '../replay/reader.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FEAT_DIR = 'extension/src/feats/player/auto-farm';
// 协议字典：与 feat 共用同一份 constants.js（B6 就近收编，纯常量模块可直 import）
const C = await import(pathToFileURL(path.join(ROOT, FEAT_DIR, 'constants.js')).href);

const CMD_STUDY_HERO_SKILL = C.CMD_STUDY_HERO_SKILL; // 897
const CMD_FORGET_HERO_SKILL = C.CMD_FORGET_HERO_SKILL; // 898
const CMD_CHANGE_HERO_SKILLS_INDEX = C.CMD_CHANGE_HERO_SKILLS_INDEX; // 1345
const PUSH_HERO_INFO = C.PUSH_HERO_INFO; // 10906
const PUSH_TOOL = C.PUSH_TOOL; // 10401
const CMD_MARCH_WORLD_POINT = C.CMD_MARCH_WORLD_POINT; // 902（D5 上下文，不在写动作集）

/** 本子引擎的写动作（897/898/1345 全部 V1 send） */
const WRITE_CMDS = new Set([
  CMD_STUDY_HERO_SKILL,
  CMD_FORGET_HERO_SKILL,
  CMD_CHANGE_HERO_SKILLS_INDEX,
]);

/** 各写动作的载荷键集（排序后逐字比对；897/898 不带别的键、1345 两键，多键少键都算形态违例） */
const REQ_KEYS = {
  [CMD_STUDY_HERO_SKILL]: ['heroId', 'index', 'isBuffSlot', 'itemId', 'skillsIndex'].sort(),
  [CMD_FORGET_HERO_SKILL]: ['heroId', 'index', 'isBuffSlot', 'skillsIndex'].sort(),
  [CMD_CHANGE_HERO_SKILLS_INDEX]: ['heroId', 'skillsIndex'].sort(),
};

/** 分析窗（manifest 观察口径，非 feat 行为契约） */
const DEBOUNCE_MS = 1200; // D3：898 受理后同槽再 897 的「立刻」阈
const TAIL_MS = 15000; // D3：录制收尾未闭 →2 的豁免窗（还原段）
const ACK_WINDOW_MS = 2000; // D6：受理后 10906 确认窗（实证 66~104ms，取宽兜底）
const LEDGER_WINDOW_MS = 2000; // D4：897/898 受理后 10401 回写窗（实证 60ms 内）

// ── D7 纯函数导出面：skill-attach.js 装载冒烟（与 tests/feats/auto-farm-skill-attach.test.js 同款最小桩） ──
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
  runtime: { id: 'verify', sendMessage() {}, getURL: (s) => s, onMessage: { addListener() {} } },
};
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (fn, ms, ...rest) => {
  const h = realSetInterval(fn, ms, ...rest);
  if (h && typeof h.unref === 'function') h.unref(); // 不让 feat 的周期器吊住 verify 进程
  return h;
};
const SK_EXPORTS = [
  'SKILL_BOOK_FAMILIES',
  'COLLECT_BOOK_PREFIXES',
  'bookPrefix',
  'itemIdForSkill',
  'skillFamilyPrefix',
  'collectSkillWhitelist',
  'planAttach',
  'planDetachSlots',
  'skillAttach',
];
let SK = null;
let SK_ERR = null;
try {
  SK = await import(pathToFileURL(path.join(ROOT, FEAT_DIR, 'skill-attach.js')).href);
} catch (e) {
  SK_ERR = e.message;
}

/** 载荷键集（排序） */
function keysOf(o) {
  return Object.keys(o || {}).sort();
}

/** heroId 形态：正数或非空十进制串（报文实证恒 number） */
function heroIdOk(v) {
  if (typeof v === 'number') return Number.isInteger(v) && v > 0;
  return typeof v === 'string' && /^\d+$/.test(v) && Number(v) > 0;
}

/** V1 应答受理判定：业务码在 raw.s（0=受理；3=业务拒，拒因在 data 裸串） */
function respOf(respEntry) {
  if (!respEntry) return null;
  return { s: respEntry.s, data: respEntry.d, t: respEntry.t };
}
function respOk(resp) {
  return !!resp && resp.s === 0;
}

export default {
  id: 'auto-farm-skill',
  featDir: FEAT_DIR,
  engineMods: {
    // 纯常量模块可被内核 engineSmoke 直 import；skill-attach.js 依赖浏览器全局，导出面在 D7 自行冒烟
    'constants.js': [
      'CMD_STUDY_HERO_SKILL',
      'CMD_FORGET_HERO_SKILL',
      'CMD_CHANGE_HERO_SKILLS_INDEX',
      'PUSH_HERO_INFO',
      'PUSH_TOOL',
      'CMD_MARCH_WORLD_POINT',
    ],
  },
  defaultRecs: [
    // 20261121 两段真人技能操作录制（温泰）：
    // 130403 = 组1↔组2 纯切组（1345×2 + 10906×2，流未闭收尾豁免的正样本）；
    // 131733 = 决定性实验（897×5 含 equip001 双拒 + 898×3 + 1345×3，D1/D3/D4 全维度覆盖）
    'dashcam/store/rec/14179309129759/dashcam-rec-20261121T130403-英雄技能分组切换.ndjson',
    'dashcam/store/rec/14179309129759/dashcam-rec-20261121T131733-英雄技能分组切换.ndjson',
  ],

  // ── 现场态重建：单遍扫录制 ──────────────────────────────────────────────
  async buildScan(recPath) {
    /** 写视图（自建：内核 w.req 对 V1 恰好等价 entry.body，但应答必须绕开内核 header 依赖） */
    const skillReqs = []; // {t,cmd,rt,heroId,index,itemId,isBuffSlot,skillsIndex,keys}
    const respByRt = new Map(); // rt -> {t,s,d}（V1 resp 无 header，内核 respByReqTs 不适用，自建）
    /** 10906 push 时间线 {t,heroId,skillsIndex}（hero 包裹层已剥） */
    const heroPushes = [];
    /** 10401 push 时间线 {t,itemId,amount}（载荷形状按 constants.js 注记 {itemId,amount}，容错列表形态） */
    const toolPushes = [];
    /** 902 行军 req 时刻（D5 邻接上下文） */
    const marchReqs = [];
    /** dir 普查（cmd|dir -> n），供 D2 通道判据 */
    const dirCensus = new Map();
    let maxTs = 0;

    const {
      writes,
      total,
      parseErr,
      minTs,
      maxTs: kMaxTs,
      dirCounts,
    } = await scanNDJSON(recPath, {
      isWrite: (e) => WRITE_CMDS.has(e.cmd),
      onEntry: (e) => {
        const cmd = e.cmd;
        if (e.ts > maxTs) maxTs = e.ts;
        if (
          WRITE_CMDS.has(cmd) ||
          cmd === PUSH_HERO_INFO ||
          cmd === PUSH_TOOL ||
          cmd === CMD_MARCH_WORLD_POINT
        ) {
          const dk = cmd + '|' + e.dir;
          dirCensus.set(dk, (dirCensus.get(dk) || 0) + 1);
        }

        if (WRITE_CMDS.has(cmd) && e.dir.startsWith('req')) {
          const b = e.body || {};
          skillReqs.push({
            t: e.ts,
            cmd: cmd,
            rt: e.rt || 0,
            heroId: b.heroId,
            index: b.index,
            itemId: b.itemId,
            isBuffSlot: b.isBuffSlot,
            skillsIndex: b.skillsIndex,
            keys: keysOf(b),
          });
          return;
        }
        if (WRITE_CMDS.has(cmd) && e.dir === 'resp' && e.rt) {
          respByRt.set(e.rt, {
            t: e.ts,
            s: e.raw && e.raw.s != null ? Number(e.raw.s) : null,
            d: e.body,
          });
          return;
        }
        if (cmd === PUSH_HERO_INFO && e.dir === 'push') {
          const h = e.body && e.body.hero;
          if (h && Number(h.id) | 0)
            heroPushes.push({
              t: e.ts,
              heroId: Number(h.id) | 0,
              skillsIndex: h.skillsIndex | 0 || 0,
            });
          return;
        }
        if (cmd === PUSH_TOOL && e.dir === 'push') {
          const d = e.body;
          const rows = Array.isArray(d) ? d : Array.isArray(d && d.list) ? d.list : d ? [d] : [];
          for (const r of rows) {
            const iid = Number(r && (r.itemId != null ? r.itemId : r.id)) | 0;
            if (iid) toolPushes.push({ t: e.ts, itemId: iid, amount: Number(r && r.amount) || 0 });
          }
          return;
        }
        if (cmd === CMD_MARCH_WORLD_POINT && e.dir.startsWith('req')) marchReqs.push({ t: e.ts });
      },
    });

    skillReqs.sort((a, b) => a.t - b.t);
    heroPushes.sort((a, b) => a.t - b.t);
    toolPushes.sort((a, b) => a.t - b.t);
    return {
      writes, // 内核抽取（本 manifest 全部写动作即 897/898/1345 req）
      respByReqTs: new Map(), // 内核 V1 不适用（无 header），占位保持打印契约
      total,
      parseErr,
      minTs,
      maxTs: kMaxTs || maxTs,
      dirCounts,
      pairedResp: respByRt.size, // 自建配对数（V1 raw.s 口径）
      skillReqs,
      respByRt,
      heroPushes,
      toolPushes,
      marchReqs,
      dirCensus,
      maxScanTs: maxTs,
      uid: path.basename(path.dirname(recPath)),
    };
  },

  // ── 闸门判定 ──────────────────────────────────────────────────────
  runVerify(S, rep) {
    const dimD1 = 'D1 载荷形态';
    const dimD2 = 'D2 发送通道';
    const dimD3 = 'D3 组2流配对闸';
    const dimD4 = 'D4 账目守恒(观察)';
    const dimD5 = 'D5 前向完备(SOFT)';
    const dimD6 = 'D6 应答与10906确认(观察)';
    const dimD7 = 'D7 纯函数导出面';

    // ── D7 纯函数导出面（HARD，静态） ──
    {
      const samples = [];
      let pass = 0;
      let fail = 0;
      if (!SK) {
        fail++;
        samples.push('skill-attach.js 装载失败: ' + (SK_ERR || 'unknown'));
      } else {
        for (const n of SK_EXPORTS) {
          if (SK[n]) pass++;
          else {
            fail++;
            samples.push('skill-attach.js 缺导出 ' + n);
          }
        }
      }
      rep.check(
        'skill-attach.js Node 装载 + 纯函数导出在册（tests 同款全局桩）',
        dimD7,
        pass,
        fail,
        0,
        samples,
      );
    }

    // ── D1 载荷形态（HARD） ──
    {
      let pass = 0;
      let fail = 0;
      let skip = 0;
      const samples = [];
      let maxIndex = -1;
      for (const w of S.skillReqs) {
        const want = REQ_KEYS[w.cmd];
        if (!want) continue;
        if (!heroIdOk(w.heroId)) {
          fail++;
          samples.push(`t=${w.t} cmd=${w.cmd} heroId 形态违例: ${JSON.stringify(w.heroId)}`);
          continue;
        }
        if (w.keys.join(',') !== want.join(',')) {
          fail++;
          samples.push(`t=${w.t} cmd=${w.cmd} 键集违例: [${w.keys}] ≠ [${want}]`);
          continue;
        }
        if (!(w.skillsIndex === 1 || w.skillsIndex === 2)) {
          fail++;
          samples.push(`t=${w.t} cmd=${w.cmd} skillsIndex 违例: ${JSON.stringify(w.skillsIndex)}`);
          continue;
        }
        if (w.cmd === CMD_STUDY_HERO_SKILL && !(Number(w.itemId) > 0)) {
          fail++;
          samples.push(`t=${w.t} 897 itemId 违例: ${JSON.stringify(w.itemId)}`);
          continue;
        }
        // 1345 无 index/isBuffSlot 键，其后的槽位判据只适用于 897/898
        if (w.cmd === CMD_CHANGE_HERO_SKILLS_INDEX) {
          pass++;
          continue;
        }
        if (!Number.isInteger(Number(w.index)) || Number(w.index) < 0) {
          fail++;
          samples.push(`t=${w.t} cmd=${w.cmd} index 违例: ${JSON.stringify(w.index)}`);
          continue;
        }
        if (Number(w.index) > maxIndex) maxIndex = Number(w.index);
        if (typeof w.isBuffSlot !== 'boolean') {
          fail++;
          samples.push(`t=${w.t} cmd=${w.cmd} isBuffSlot 非布尔: ${JSON.stringify(w.isBuffSlot)}`);
          continue;
        }
        if (w.isBuffSlot) {
          // 真人 buff 槽操作是合法游戏行为但超出 feat v1 契约（isBuffSlot 恒 false），无法判定
          skip++;
          continue;
        }
        pass++;
      }
      samples.push(`index 上限实证: ${maxIndex}（普通槽 3 格 = 0~2）`);
      rep.check(
        '897/898/1345 键集恒定 + skillsIndex∈{1,2} + 标量值域（键集形态对照 feat send 载荷）',
        dimD1,
        pass,
        fail,
        skip,
        samples,
      );
    }

    // ── D2 发送通道（HARD） ──
    {
      let pass = 0;
      let fail = 0;
      const samples = [];
      for (const [dk, n] of S.dirCensus) {
        const [cmd, dir] = dk.split('|');
        if (WRITE_CMDS.has(Number(cmd)) && dir.startsWith('req')) {
          if (dir === 'req:send') pass += n;
          else {
            fail += n;
            samples.push(`cmd=${cmd} 出现 ${dir} ×${n}（V1 链路应为 req:send）`);
          }
        } else if (WRITE_CMDS.has(Number(cmd)) && dir === 'resp') {
          pass += n;
        }
      }
      if (!fail)
        samples.push(
          `req:send 与 resp 计量：${S.dirCensus.get(CMD_STUDY_HERO_SKILL + '|req:send') || 0}+${S.dirCensus.get(CMD_FORGET_HERO_SKILL + '|req:send') || 0}+${S.dirCensus.get(CMD_CHANGE_HERO_SKILLS_INDEX + '|req:send') || 0} req / ${S.dirCensus.get(CMD_STUDY_HERO_SKILL + '|resp') || 0}+${S.dirCensus.get(CMD_FORGET_HERO_SKILL + '|resp') || 0}+${S.dirCensus.get(CMD_CHANGE_HERO_SKILLS_INDEX + '|resp') || 0} resp`,
        );
      rep.check(
        '本族 req dir 恒 req:send、resp dir 恒 resp（V1 旧 JSON 链路）',
        dimD2,
        pass,
        fail,
        0,
        samples,
      );
    }

    // ── D3 组2 流配对闸（HARD） ──
    {
      let pass = 0;
      let fail = 0;
      let skip = 0;
      const samples = [];
      // ① per heroId 1345 流区间两遍法：先收区间（开=→2，闭=→1），再逐笔判定（终态近似会把已闭流内的
      // 笔迹漏判，两遍法才能精确拦「开流后、闭流前写组1」的矛盾态）
      const intervals = new Map(); // heroId -> Array<{openT, closeT|null}>
      for (const w of S.skillReqs) {
        if (w.cmd !== CMD_CHANGE_HERO_SKILLS_INDEX) continue;
        const hid = String(w.heroId);
        const arr = intervals.get(hid) || [];
        if (w.skillsIndex === 2) {
          const last = arr[arr.length - 1];
          if (last && last.closeT == null) {
            samples.push(`t=${w.t} hero=${hid} →2 连发（未闭再开，feat 不会；真人幂等重入）`);
            last.openT = w.t; // 以最新开流时刻为准
          } else arr.push({ openT: w.t, closeT: null });
        } else if (w.skillsIndex === 1) {
          const last = arr[arr.length - 1];
          if (last && last.closeT == null) {
            last.closeT = w.t;
            pass++; // →2 有配对 →1
          }
        }
        intervals.set(hid, arr);
      }
      for (const [hid, arr] of intervals) {
        for (const iv of arr) {
          if (iv.closeT != null) continue;
          const since = S.maxScanTs - iv.openT;
          if (since <= TAIL_MS) {
            skip++;
            samples.push(`hero=${hid} 流收尾未闭（还原段豁免，距末帧 ${since}ms ≤ ${TAIL_MS}ms）`);
          } else {
            fail++;
            samples.push(`hero=${hid} 1345→2 无配对 →1（距末帧 ${since}ms > ${TAIL_MS}ms）`);
          }
        }
      }
      // ② 组2 流内（openT ≤ t < closeT||∞）的 897/898 skillsIndex 恒 2（feat 与真人组2 操作同口径）
      let inFlow = 0;
      for (const w of S.skillReqs) {
        if (w.cmd === CMD_CHANGE_HERO_SKILLS_INDEX) continue;
        for (const iv of intervals.get(String(w.heroId)) || []) {
          if (w.t >= iv.openT && (iv.closeT == null || w.t < iv.closeT)) {
            inFlow++;
            if (w.skillsIndex !== 2) {
              fail++;
              samples.push(
                `t=${w.t} hero=${String(w.heroId)} 组2 流内 ${w.cmd} skillsIndex=${w.skillsIndex}（应恒 2）`,
              );
            }
            break;
          }
        }
      }
      if (inFlow) samples.push(`组2 流内 897/898 共 ${inFlow} 笔，skillsIndex 恒 2 已验`);
      // ③ 防抖：898 受理后同槽 DEBOUNCE_MS 内不得再 897（配对键 = req.ts：resp.rt 回指发包时刻）
      const debounceHits = [];
      for (const w of S.skillReqs) {
        if (w.cmd !== CMD_FORGET_HERO_SKILL) continue;
        const resp = respOf(S.respByRt.get(w.t));
        if (!respOk(resp)) continue;
        for (const s2 of S.skillReqs) {
          if (s2.cmd !== CMD_STUDY_HERO_SKILL) continue;
          if (String(s2.heroId) !== String(w.heroId) || Number(s2.index) !== Number(w.index))
            continue;
          if (s2.skillsIndex !== 2 || w.skillsIndex !== 2) continue;
          const gap = s2.t - resp.t;
          if (gap >= 0 && gap <= DEBOUNCE_MS) {
            debounceHits.push(
              `t=${s2.t} hero=${String(w.heroId)} slot=${s2.index} 898 受理后 ${gap}ms 再 897`,
            );
          }
        }
      }
      if (debounceHits.length) fail += debounceHits.length;
      else samples.push(`防抖窗 ${DEBOUNCE_MS}ms 内无「898 受理→同槽再 897」样本`);
      rep.check(
        'per heroId：1345→2 必有配对 →1（收尾豁免）；组2 流内 897/898 恒 2；898 后同槽防抖',
        dimD3,
        pass,
        fail,
        skip,
        samples.slice(0, 8),
      );
    }

    // ── D4 账目守恒（观察） ──
    {
      const samples = [];
      if (!S.toolPushes.length) {
        samples.push('本录制无 10401 推送（纯复制/组2 卸登记段，零账变——账目模型自证）');
        rep.check(
          '897 新登记扣账 / 平装放行；898 最后注销还账 / 另一组在册不还账',
          dimD4,
          0,
          0,
          1,
          samples,
        );
      } else {
        let deduct = 0;
        let flat = 0;
        let refund = 0;
        let noRefund = 0;
        const lastAmount = new Map(); // itemId -> 最近一次 10401 之前的 amount
        for (const w of S.skillReqs) {
          const resp = respOf(S.respByRt.get(w.t));
          if (!respOk(resp)) continue;
          if (w.cmd === CMD_STUDY_HERO_SKILL) {
            const prev = lastAmount.get(Number(w.itemId));
            let sawDrop = false;
            for (const p of S.toolPushes) {
              if (p.t < resp.t) {
                if (p.itemId === Number(w.itemId)) lastAmount.set(p.itemId, p.amount);
                continue;
              }
              if (p.t > resp.t + LEDGER_WINDOW_MS) break;
              if (p.itemId !== Number(w.itemId)) continue;
              if (prev != null && p.amount < prev) sawDrop = true;
              lastAmount.set(p.itemId, p.amount);
            }
            if (prev == null && !sawDrop)
              flat++; // 无基线无法判降幅：平装放行与样本缺失同形态
            else if (sawDrop) deduct++;
            else flat++; // 缺席且受理 = 同英雄跨组平装放行（温泰 L37 直证，正常）
          } else if (w.cmd === CMD_FORGET_HERO_SKILL) {
            // 898 不带 itemId，无法按号对账：只统计「窗内出现任一 10401 上升」的粗粒度还账率
            let sawRise = false;
            for (const p of S.toolPushes) {
              if (p.t < resp.t) continue;
              if (p.t > resp.t + LEDGER_WINDOW_MS) break;
              const prev = lastAmount.get(p.itemId);
              if (prev != null && p.amount > prev) sawRise = true;
              lastAmount.set(p.itemId, p.amount);
            }
            if (sawRise) refund++;
            else noRefund++; // 另一组还有登记不还账（正常）或录制段无账变
          }
        }
        samples.push(
          `897 受理：扣账跟随 ${deduct}、平装放行/无基线 ${flat}；898 受理：还账 ${refund}、不还账（另一组在册）${noRefund}`,
        );
        samples.push(`10401 回写窗 ${LEDGER_WINDOW_MS}ms（实证 60ms 内）；纯观察不判负`);
        rep.check(
          '897 新登记扣账 / 平装放行；898 最后注销还账 / 另一组在册不还账',
          dimD4,
          0,
          0,
          0,
          samples,
        );
      }
    }

    // ── D5 前向完备（SOFT，恒不判负） ──
    {
      const samples = [];
      let adj = 0;
      for (const m of S.marchReqs) {
        for (const w of S.skillReqs) {
          if (w.cmd !== CMD_CHANGE_HERO_SKILLS_INDEX || w.skillsIndex !== 1) continue;
          const gap = m.t - w.t;
          if (gap >= 0 && gap <= 120000) {
            adj++;
            break;
          }
        }
      }
      samples.push(
        `902 行军 ${S.marchReqs.length} 笔；其中 ${adj} 笔前 120s 内有 1345→1 收口（借还轮转的邻接量级参考）`,
      );
      samples.push(
        '真人对拍无「skill 勾选队伍」面板上下文，无法断言前向完备——feat 操作段录制后此维度自动获得样本',
      );
      rep.check('skill 勾选队伍应有 attach 流水（feat 操作段才可判）', dimD5, 0, 0, 1, samples);
    }

    // ── D6 应答与 10906 确认（观察） ──
    {
      let paired = 0;
      let respless = 0;
      let okN = 0;
      let rejectN = 0;
      let acked = 0;
      const samples = [];
      for (const w of S.skillReqs) {
        const resp = respOf(S.respByRt.get(w.t));
        if (!resp) {
          respless++;
          continue;
        }
        paired++;
        if (!respOk(resp)) {
          rejectN++;
          if (typeof resp.data === 'string')
            samples.push(
              `t=${w.t} cmd=${w.cmd} 拒因=${resp.data}（可预期业务拒绝，feat 记 info 不中断）`,
            );
          continue;
        }
        okN++;
        const hidNum = Number(w.heroId);
        const hidStr = String(w.heroId);
        const hit = S.heroPushes.some(
          (p) =>
            (p.heroId === hidNum || String(p.heroId) === hidStr) &&
            p.t >= w.t &&
            p.t <= resp.t + ACK_WINDOW_MS,
        );
        if (hit) acked++;
      }
      samples.unshift(
        `受理应答配对 ${paired}/${S.skillReqs.length}（无应答 ${respless}）；受理 ${okN} / 业务拒 ${rejectN}；受理后 ${ACK_WINDOW_MS}ms 窗内 10906 到达 ${acked}/${okN}`,
      );
      samples.push(
        '10906 确认窗实证 66~104ms 且先于 resp；缺席 = 超时兜底走本地态（feat warn 继续），不判负',
      );
      rep.check('受理应答配对率与 10906 确认到达率', dimD6, okN, 0, respless, samples);
    }
  },
};
