/**
 * CQ26 急速解冻 feat · 录制仿真对拍 Manifest（第六个消费者 / 「被动接应答→单发结算」lane 首次建基线）。
 *
 * 与 cq26-wl-beast / cq26-train 同层：只声明本 feat 的协议号、触发源与闸门规则，
 * 读录制、二分回溯、Int64 归一、应答配对、报告打印、退出码全交给 scripts/replay/。
 *
 * 运行：node scripts/replay/run.mjs --manifest cq26-ice-shake [录制...] [--verbose]
 *
 * 「仿真侧」是什么：本 feat 的全部决策就是「哪些句柄要代摇、摇哪一档、什么时候不该发」，
 *   这三条已收口成 feat 自己的纯函数 `planSubmit(idStr, ageMs)`（pump 出网前唯一的决策点）。
 *   这里把录制里 2117/2103 应答给出的**每一枚非零 miniGameId**（用 feat 自己的
 *   `readMiniGameId` 读，含 status 闸与两种 Int64 形态）按 ts 序喂回 `planSubmit`，
 *   得到的就是「feat 站在真人那一刻会发出的写集」，再与线上真人的 2129 逐条对照。
 *
 * 校验维度：
 *   触发源全覆盖（HARD）：每枚非零 miniGameId 都产出一次 2129 计划（仿真侧不漏发）；且每枚句柄
 *     在录制里都能找到同 id 的真人 2129（对照侧不漏，两侧同时成立才算「该发的都发了」）
 *   恒发最高档（HARD）：分两条——结构条（仿真侧每条计划的 `index === TIER_HIGH` 且该档位在 feat
 *     档位表内）+ 真值条（TIER_HIGH 那档在录制里的**中位总件数必严格高于其它出现过的档**，只有一档
 *     样本时记 skip，不冒充已验证）。真值条才是「2 = 最高档」的防伪牙：把 TIER_HIGH 改歪直接 FAIL
 *   同一条只发一次（HARD）：仿真侧按 miniGameId 去重后计划数不变（feat 的 inHand 去重语义）
 *   不重投契约（HARD，两侧）：feat 侧 `shouldResubmit` 只对「发送抛错」重投、被在途闸挡下不重投；
 *     录制侧真值条——同一枚 id 的第二发及以后一律没再给奖（实录 51 发里唯一那条重复撞 s=3
 *     activity_120002=「参数错误」），重复提交无收益 ⇒ 重投只会往玩家脸上弹错误
 *   奖励展示前提（HARD + OBSERVATION）：feat 侧 `rewardPanelArgs` 把非空 `rewardResult` 包成
 *     `{serverReward}`（游戏原生 CommonRewardPanel 的实参口径）、空/畸形载荷不开窗；
 *     录制侧只报量级——成功结算的 2129 有多少带非空 rewardResult（带了才看得到奖励面板），不判负
 *   载荷逐键形态（HARD）：真人 2129 的 body 键集 == feat 计划的键集（`id|index`）、`id` 为
 *     `{_low,_high}` Int64 形态、经 **feat 自己的 reader** 解回的十进制串必须落在触发源句柄集内
 *     （装箱丢精度/凭空发 id 都会在此现形——19 位雪花 id 全程不经 Number）
 *   触发时序（HARD）：每条 2129 之前必有同 id 的融冰成功应答（feat 只被动接应答、不猜 id）
 *   过期闸边界（HARD）：真人实际「应答→提交」耗时必须 ≤ `SUBMIT_EXPIRE_MS`，否则闸设得过紧，
 *     feat 会把本来摇得到的点丢掉（反向：闸若松于服务器真实窗口只会被拒，不判负）
 *   通道（HARD）：2129/2117/2103 req 恒 dir='req:sendPBV2'
 *   真人档位（SOFT）：真人可择机选中低档，与仿真只报差异不判负
 *   2103 盛宴线（无样本记 skip）：本场录制零条 2103 ⇒ 该路只有约束力、无区分度，如实标注
 *   应答与收益（OBSERVATION）：配对率、2129 code、index↔奖励项数（档位收益证据）、直接给奖那一支的
 *     items、触发→提交延迟、wastelandIndex 与坐标。
 *
 * 协议字典来源：feat 是单文件浏览器模块且**已导出**协议号/档位/纯函数（radar-task、cq26-wl-beast
 *   式「最小桩化浏览器全局后动态 import」），抽不到期望导出面直接抛错——宁可跑不起来也不手抄一份字典。
 *
 * dir/字段实测（写判据前已用 .reviewtmp/shake-probe.mjs + shake-tier-scan.mjs + shake-dup-check.mjs 探针核对，避免不可达分支）：
 *   本场 2117 `req:sendPBV2`×6（body `{wastelandIndex,x,y}`）/ `resp`×6（4 条带 `miniGameId`、2 条带
 *   `rewardResult`，`header.s` 恒 0）；2129 `req:sendPBV2`×4（body `{id:{_low,_high,_unsigned},index}`，
 *   index 恒 2）/ `resp`×4（body `{rewardResult}`）；**2103 本场零出现**（盛宴线判据自动落 skip）。
 *   内核 writes.req 走 raw.data，实测与 entry.body 逐键等值（sendPBV2 无业务槽间接，坑 5 不适用），
 *   本 manifest 仍自建写视图（submitPending）：要的是「线上真正发出的键集 + Int64 原形」，且 req↔resp 合并成一条。
 *   真人 2117 应答→2129 出网实测 2.83~4.10s（盯着指针择机），全部落在 9s 闸内。
 *   盛宴线只在 11-07 / 11-09 两场录制里出现（那两场 2103×6 / 2103×39，本场 2103 零条 ⇒ D7 自动落 skip）；
 *   多档样本（低温/中温）也只在那两场 ⇒ D2c 真值判据靠它们才有区分度。
 *   11-12 02:10 那场（第 4 条默认录制）专门用于「重复提交」：一枚句柄 + 两发 2129，
 *   第二发（+8.8s，玩家在被我们代摇掉的弹窗上补点）撞 `header.s=3 / d=activity_120002`。
 *
 * 反向自检（负控，.reviewtmp/shake-negctl.mjs 一次性）：把 TIER_HIGH 改 1、闸值压到 2s、计划多带一键、
 *   句柄读错字段、重投闸门改成「永远重投」、奖励归一改成「空载荷也开窗」六种故意破坏均能拉出 ❌ FAIL（退码 1），不是橡皮图章。
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { scanNDJSON } from '../replay/reader.mjs';
import { isInt64Obj } from '../replay/int64.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FEAT = path.join(ROOT, 'extension/src/feats/cq26/ice-shake.js');
/** 默认录制所在目录（uid 目录；uid 从录制目录名取，不钉账号） */
const REC_DIR = path.join(ROOT, 'dashcam/store/rec/11981629951662');

/**
 * 按会话起始串定位录制文件（相对 ROOT 的路径）。
 * 为什么不直接写完整文件名：dashcam server 空闲后会 finalize 改名（去掉 uid/slug、换成业务 note），
 *   钉死名字会让上一场刚定稿就把本 manifest 打成「录制不存在」。只认 `dashcam-rec-<start>` 前缀，
 *   并**优先定稿名、回落 `.part`**。
 * @param {string} start 会话起始串，如 '20261112T011559'
 * @returns {string} ROOT 相对路径
 */
function recByStart(start) {
  const want = 'dashcam-rec-' + start;
  const hits = fs
    .readdirSync(REC_DIR)
    .filter((f) => f.startsWith(want) && f.endsWith('.ndjson') && f !== 'dashcam-rec-index.ndjson');
  if (!hits.length)
    throw new Error('录制缺失：' + path.basename(REC_DIR) + '/ 里没有 ' + want + '*');
  hits.sort((a, b) => {
    const pa = a.endsWith('.part.ndjson') ? 1 : 0;
    const pb = b.endsWith('.part.ndjson') ? 1 : 0;
    return pa - pb || a.localeCompare(b);
  });
  return path.relative(ROOT, path.join(REC_DIR, hits[0])).split(path.sep).join('/');
}

// ── 最小桩化浏览器全局（feat import 期需要，判据函数体不触碰）────────────
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

// ── 协议字典 + 决策纯函数：与 feat 共用同一份，判据不另起炉灶 ────────────────
const C = await import(pathToFileURL(FEAT).href);
const {
  CMD_FIRE_NWL,
  CMD_FIRE_BWL,
  CMD_MINI_GAME,
  TIER_HIGH,
  TIER_LABELS,
  SUBMIT_EXPIRE_MS,
  MAX_TRIES,
  readMiniGameId,
  planSubmit,
  shouldResubmit,
  rewardPanelArgs,
} = C;
if (
  typeof readMiniGameId !== 'function' ||
  typeof planSubmit !== 'function' ||
  typeof shouldResubmit !== 'function' ||
  typeof rewardPanelArgs !== 'function'
) {
  throw new Error(
    'feat 导出面缺 readMiniGameId/planSubmit/shouldResubmit/rewardPanelArgs（判据字典与 feat 分叉，直接报错退出）',
  );
}
if (TIER_LABELS == null || TIER_LABELS[TIER_HIGH] == null) {
  throw new Error('TIER_HIGH=' + TIER_HIGH + ' 不在 feat 档位表内（字典自相矛盾，拒绝跑）');
}
/** 两路融冰应答（NWL 荒芜冰原 / BWL 巨熊盛宴）——本 feat 的唯一触发源 */
const FIRE_CMDS = new Set([CMD_FIRE_NWL, CMD_FIRE_BWL]);
/** 合法档位域：取自 feat 自己的档位表，不硬编码 0/1/2 */
const TIER_DOMAIN = new Set(Object.keys(TIER_LABELS).map(Number));

/**
 * 按键名升序拼串（逐键一致的判据表达成字符串相等，样本可直接肉眼比对）。
 * @param {object} o 载荷
 * @returns {string} 如 `id|index`
 */
function keysOf(o) {
  return o && typeof o === 'object' ? Object.keys(o).sort().join('|') : '';
}

/**
 * 奖励明细归一：`rewardResult.items` → `[{itemId,count}]`（非数组回空，不参与判负）。
 * @param {object|null} rr 应答里的 rewardResult
 * @returns {Array<{itemId:number,count:number}>}
 */
function itemsOf(rr) {
  const list = rr && rr.items;
  if (!Array.isArray(list)) return [];
  return list.map((i) => ({ itemId: Number(i && i.itemId), count: Number(i && i.itemCount) }));
}

/**
 * 十进制串安全比较：只用串，19 位雪花 id 绝不经 Number（内核 toNum 会掉精度）。
 * @param {Array<{idStr:string}>} rows 写视图
 * @returns {Map<string,object[]>} miniGameId 十进制串 → 该句柄的发包列表
 */
function groupById(rows) {
  const m = new Map();
  for (const r of rows) {
    if (!m.has(r.idStr)) m.set(r.idStr, []);
    m.get(r.idStr).push(r);
  }
  return m;
}

/**
 * 中位数（小样本够用，不引依赖）。
 * @param {number[]} arr 数值数组（非空）
 * @returns {number} 中位数
 */
function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
}

/**
 * 取该笔 2129 之前（**含同一毫秒**）最近的一枚同 id 触发源。
 * 为什么是 `<=` 而不是 `<`：录制时间戳是 Date.now() 的毫秒，代摇在应答落地同一拍同步出网，
 *   两侧会拿到同一个毫秒值（实证 dashcam-rec-20261112T021006…：2117 resp 与 2129 req 同为 +77.103s）；
 *   用严格 `<` 会把「零延迟代摇」误判成「没应答就凭空发」。真违例（发一个没人给过的 id）依旧抓得到：
 *   那种根本找不到同 id 应答，与取等无关。
 * @param {Array<{ts:number, idStr:string}>} triggers 触发源时间线（已按 ts 升序）
 * @param {{t:number, idStr:string}} w 一笔 2129 写视图
 * @returns {object|null} 最近的同 id 触发源，无则 null
 */
function lastTriggerBefore(triggers, w) {
  const hits = triggers.filter((t) => t.idStr === w.idStr && t.ts <= w.t);
  return hits.length ? hits[hits.length - 1] : null;
}

export default {
  id: 'cq26-ice-shake',
  // 按会话起始串解析当前文件名（finalize 会改名，见 recByStart 注释）
  defaultRecs: [
    // 主样本（用户本场录制，NWL 线）：2117×6（4 带 miniGameId、2 直接给奖）+ 2129×4（index 恒 2、与四枚句柄 1:1）
    recByStart('20261112T011559'),
    // 盛宴线 + 多档对照（BWL 2103×6 全部走小游戏，中温档 3 件 vs 高温档 5 件 ⇒ D2c 有区分度）
    recByStart('20261107T002336'),
    // 大样本（39 发 2129，低温档 1 条对照，应答→提交延迟 2.83~2.99s）：一次性/去重/覆盖的压力样本
    recByStart('20261109T205818'),
    // 重复提交样本（一枚句柄两发 2129，第二发撞 s=3）：D9b 真值条的唯一样本来源
    recByStart('20261112T021006'),
  ],

  // ── 现场态重建：单遍扫录制，触发源句柄时间线 + req↔resp 合并的 2129 写视图 ──
  async buildScan(recPath) {
    /** 触发源（带非零 miniGameId 的融冰应答）：{ts,src,idStr,bodyKeys,status}，按 ts 升序 */
    const triggers = [];
    /** 融冰应答里「直接给奖」那一支（无小游戏）：{ts,src,items} —— 只作档位收益对照 */
    const directRewards = [];
    /** 融冰发包（真人点的块）：{t,cmd,dir,bodyKeys,wa,x,y} */
    const fireReqs = [];
    /** 2129 写视图：reqTs -> {t,dir,bodyKeys,idStr,idObj,index,code,items} */
    const submitPending = new Map();

    const { writes, respByReqTs, total, parseErr, minTs, maxTs, dirCounts } = await scanNDJSON(
      recPath,
      {
        isWrite: (e) => e.cmd === CMD_MINI_GAME,
        onEntry: (e) => {
          // ① 触发源：只看 resp（`header.s` 交给 feat 自己的 reader 当闸，本 manifest 不另判）
          if (FIRE_CMDS.has(e.cmd) && e.dir === 'resp') {
            const head = e.header || (e.outer && e.outer.header) || null;
            const status = head && head.s != null ? Number(head.s) : null;
            const body = e.body || {};
            const idStr = readMiniGameId(body, status);
            if (idStr) {
              triggers.push({
                ts: e.ts,
                src: e.cmd,
                idStr: idStr,
                bodyKeys: keysOf(body),
                status: status,
              });
            } else if (body.rewardResult) {
              directRewards.push({ ts: e.ts, src: e.cmd, items: itemsOf(body.rewardResult) });
            }
            return;
          }
          // ② 融冰那一发（feat 不发，只作现场记录与通道判据）
          if (FIRE_CMDS.has(e.cmd) && e.dir.startsWith('req')) {
            const b = e.body || {};
            fireReqs.push({
              t: e.ts,
              cmd: e.cmd,
              dir: e.dir,
              bodyKeys: keysOf(b),
              wa: Number(b.wastelandIndex),
              x: Number(b.x),
              y: Number(b.y),
            });
            return;
          }
          // ③ 写视图：2129 req 建条目（id 用 feat 自己的 reader 解串），resp 按 rt 合并
          if (e.cmd === CMD_MINI_GAME && e.dir.startsWith('req')) {
            const b = e.body || {};
            submitPending.set(e.ts, {
              t: e.ts,
              dir: e.dir,
              bodyKeys: keysOf(b),
              idObj: isInt64Obj(b.id),
              idShape: b.id && typeof b.id === 'object' ? keysOf(b.id) : typeof b.id,
              // 线上 2129 的 id 与 2117 的 miniGameId 同形同值 ⇒ 复用同一份解码，分叉即现形
              idStr: readMiniGameId({ miniGameId: b.id }, 0),
              index: b.index == null ? null : Number(b.index),
              indexRawType: typeof b.index,
            });
            return;
          }
          if (e.cmd === CMD_MINI_GAME && e.dir === 'resp') {
            const rec = submitPending.get(e.rt);
            if (!rec) return;
            const head = e.header || (e.outer && e.outer.header) || null;
            rec.code = head && head.s != null ? Number(head.s) : null;
            // 拒因文案键（s=3 带 d=activity_120002，字典表：参数错误）——D9b 样本要能给用人话
            rec.codeText = head && head.d != null ? String(head.d) : null;
            rec.respKeys = keysOf(e.body || {});
            rec.items = itemsOf((e.body || {}).rewardResult);
            // 奖励面板能否开出来的前提：应答里到底有没有一个带内容的 rewardResult
            rec.rrKeys = keysOf((e.body || {}).rewardResult);
          }
        },
      },
    );

    triggers.sort((a, b) => a.ts - b.ts);
    fireReqs.sort((a, b) => a.t - b.t);
    const submits = [...submitPending.values()].sort((a, b) => a.t - b.t);
    return {
      writes,
      respByReqTs,
      total,
      parseErr,
      minTs,
      maxTs,
      dirCounts,
      pairedResp: respByReqTs.size,
      uid: path.basename(path.dirname(recPath)),
      triggers,
      directRewards,
      fireReqs,
      submits,
    };
  },

  // ── 判据 ──────────────────────────────────────────────────────────────
  runVerify(S, rep) {
    const D1 = '触发源全覆盖';
    const D2 = '仿真侧选档';
    const D3 = '一次性';
    const D4 = '载荷逐键形态';
    const D5 = '触发时序与过期闸';
    const D6 = '发送通道';
    const D7 = '盛宴线 2103';
    const D8 = '应答与收益（观察）';
    const D9 = '不重投契约';
    const D10 = '奖励展示前提';

    // D9a（HARD，不依赖样本）feat 侧重投契约：在途闸挡下的不重投，只有发送抛错才重投。
    //   与录制无关的纯函数契约，故放在「无样本闸门」之前；把 `!!sendErr &&` 抹成 `true` 必须在此 FAIL。
    {
      const gate = shouldResubmit('', 1);
      const threw = shouldResubmit('encode failed', 1);
      const capped = shouldResubmit('encode failed', MAX_TRIES);
      const bad = [];
      if (gate !== false) bad.push('被在途闸挡下（无抛错文案）却判重投：会撞 s=3「参数错误」');
      if (threw !== true) bad.push('发送抛错不重投：丢一次本可补回的代摇');
      if (capped !== false) bad.push('重投不守 MAX_TRIES=' + MAX_TRIES + '：可能逐拍刷同一枚 id');
      rep.check(
        '重投策略：在途闸挡下不重投 / 抛错重投一次 / 不越 MAX_TRIES=' + MAX_TRIES,
        D9,
        bad.length ? 0 : 1,
        bad.length,
        0,
        bad,
      );
    }

    // D10a（HARD，不依赖样本）feat 侧奖励实参契约：非空对象才开窗，且必须**原样透传**。
    //   把 `if (!Object.keys(...).length) return null` 抹成恒不返回 null，必须在此 FAIL。
    {
      const rr = { items: [{ itemId: 47007004, itemCount: 3 }], resource: {} };
      const wrapped = rewardPanelArgs(rr);
      const bad = [];
      if (!wrapped || wrapped.serverReward !== rr)
        bad.push('非空 rewardResult 没被原样包成 {serverReward}：奖励面板拿不到明细');
      for (const empty of [{}, [], null, undefined, '47007004', 0]) {
        if (rewardPanelArgs(empty) !== null)
          bad.push(
            '空/畸形载荷 ' +
              String(JSON.stringify(empty)) +
              ' 也去开窗：玩家会看到一扇空白奖励面板',
          );
      }
      rep.check(
        '奖励面板实参归一：非空对象原样透传 / 空载荷不开窗',
        D10,
        bad.length ? 0 : 1,
        bad.length,
        0,
        bad,
      );
    }

    // 仿真侧：把每枚真人拿到的句柄按「收到即提交」（pump 在同一拍出网，age≈0）喂回 feat 规则
    const plans = S.triggers.map((t) => ({
      ts: t.ts,
      src: t.src,
      handle: t.idStr,
      plan: planSubmit(t.idStr, 0),
    }));
    const submits = S.submits;
    const handles = [...new Set(S.triggers.map((t) => t.idStr))];
    const byId = groupById(submits);

    // 无样本闸门：绝不以空集冒充通过（伪 PASS 红线）
    if (!S.triggers.length) {
      if (submits.length) {
        // 线上有 2129 却读不出任何触发源 ⇒ feat 的读者与报文分叉（它认不出自己要发的东西），判负
        rep.check(
          '仿真侧读不出任何 miniGameId，线上却有 ' + submits.length + ' 发 2129（读者与报文分叉）',
          D1,
          0,
          1,
          0,
          ['feat readMiniGameId 在全部融冰应答里读空：句柄字段形态/状态闸漂移'],
        );
      } else {
        rep.check('本场无 miniGameId 触发源（无急速解冻样本），不判定', D1, 0, 0, 1, []);
      }
      rep.check('触发源读空，不判定', D2, 0, 0, 1, []);
      rep.check('触发源读空，不判定', D3, 0, 0, 1, []);
      rep.check('触发源读空（句柄集无从建立），不判定', D4, 0, 0, 1, []);
      rep.check('触发源读空，不判定', D5, 0, 0, 1, []);
      return;
    }

    // D1a（HARD）仿真侧：每枚句柄都必须产出一条计划——漏发即「该摇的点没摇」
    {
      let pass = 0;
      let fail = 0;
      const samples = [];
      for (const p of plans) {
        if (p.plan && p.plan.id === p.handle) pass++;
        else {
          fail++;
          if (samples.length < 6)
            samples.push('id=' + p.handle + ' src=' + p.src + ' 计划=' + JSON.stringify(p.plan));
        }
      }
      rep.check(
        '仿真侧：每枚非零 miniGameId 都产出一次 2129 计划（planSubmit 不漏发）',
        D1,
        pass,
        fail,
        0,
        samples,
      );
    }

    // D1b（HARD）对照侧：每枚句柄在录制里确有同 id 的 2129（真人发得出去 ⇒ 判据有真值可依）
    {
      let pass = 0;
      let fail = 0;
      const samples = [];
      for (const h of handles) {
        if ((byId.get(h) || []).length) pass++;
        else {
          fail++;
          if (samples.length < 6) samples.push('句柄无对应 2129：id=' + h);
        }
      }
      rep.check(
        '真人对照：' + handles.length + ' 枚句柄逐一都能在录制里找到同 id 的 2129',
        D1,
        pass,
        fail,
        0,
        samples,
      );
    }

    // D2（HARD）仿真侧恒发最高档：index === TIER_HIGH 且该档位合法
    {
      let pass = 0;
      let fail = 0;
      const samples = [];
      for (const p of plans) {
        const idx = p.plan ? p.plan.index : null;
        if (idx === TIER_HIGH && TIER_DOMAIN.has(idx)) pass++;
        else {
          fail++;
          if (samples.length < 6)
            samples.push('id=' + p.handle + ' index=' + idx + '（应为 ' + TIER_HIGH + '）');
        }
      }
      rep.check(
        '仿真侧：每条计划 index 恒为最高档 ' +
          TIER_HIGH +
          '（' +
          TIER_LABELS[TIER_HIGH] +
          '）且落在档位表内',
        D2,
        pass,
        fail,
        0,
        samples,
      );
    }

    // D2c（HARD、真值判据）「最高档」的最高由录制奖励定：TIER_HIGH 那档的中位总件数必严格高于
    //   本场出现过的其它档。只有一档样本时无区分度 ⇒ skip（不冒充已验证）；把 TIER_HIGH 改歪必现形
    {
      /** index -> [每发总件数]（只收已配对且 code=0 的结算） */
      const byTier = new Map();
      for (const w of submits) {
        if (w.index == null || !Number.isFinite(w.index)) continue;
        if (w.code != null && w.code !== 0) continue;
        if (!w.items || !w.items.length) continue;
        const sum = w.items.reduce((a, i) => a + (Number(i.count) || 0), 0);
        if (!Number.isFinite(sum)) continue;
        if (!byTier.has(w.index)) byTier.set(w.index, []);
        byTier.get(w.index).push(sum);
      }
      const others = [...byTier.keys()].filter((k) => k !== TIER_HIGH);
      const medText = [...byTier.entries()]
        .map(
          ([k, v]) =>
            (TIER_LABELS[k] || '档 ' + k) + ' 中位 ' + median(v) + ' 件（n=' + v.length + '）',
        )
        .join('；');
      if (!byTier.has(TIER_HIGH) || !others.length) {
        rep.check(
          '「恒发最高档」的奖励真值判据（本场只有 ' +
            byTier.size +
            ' 档结算样本，无区分度）｜' +
            (medText || '无已配对结算'),
          D2,
          0,
          0,
          1,
          [],
        );
      } else {
        const hi = median(byTier.get(TIER_HIGH));
        const maxOther = Math.max(...others.map((k) => median(byTier.get(k))));
        rep.check(
          'TIER_HIGH=' +
            TIER_HIGH +
            '（' +
            TIER_LABELS[TIER_HIGH] +
            '）的中位奖励必严格高于其它档（' +
            others.map((k) => TIER_LABELS[k] || k).join('/') +
            '）｜' +
            medText,
          D2,
          hi > maxOther ? 1 : 0,
          hi > maxOther ? 0 : 1,
          0,
          hi > maxOther ? [] : ['高档中位 ' + hi + ' 不高于其它档中位最大值 ' + maxOther],
        );
      }
    }

    // D3（HARD）同一条只发一次：按句柄去重后计划数不变（feat 的 inHand 去重语义）
    {
      const planIds = plans.filter((p) => p.plan).map((p) => p.plan.id);
      const uniq = new Set(planIds);
      const dup = planIds.filter((x, i) => planIds.indexOf(x) !== i);
      rep.check(
        '仿真侧：同一条 miniGameId 只产出一条计划（' +
          planIds.length +
          ' 条计划 ↔ ' +
          uniq.size +
          ' 枚去重句柄）',
        D3,
        dup.length === 0 && uniq.size === handles.length ? 1 : 0,
        dup.length === 0 && uniq.size === handles.length ? 0 : 1,
        0,
        dup.length ? ['重复计划 id：' + [...new Set(dup)].join(',')] : [],
      );
      // 真人侧重复只报不判负：弹窗残留 10s，人在里面补点一次就会重发同 id（服务器只认第一次）
      let human = 0;
      let humanDup = 0;
      const dsamples = [];
      for (const [id, rows] of byId) {
        human += rows.length;
        if (rows.length > 1) {
          humanDup++;
          if (dsamples.length < 3) dsamples.push('id=' + id + ' 线上 ' + rows.length + ' 次');
        }
      }
      rep.check(
        '真人对照：同 id 2129 笔数（残留弹窗里补点会重发，只报不判负）· 共 ' +
          human +
          ' 发 / ' +
          byId.size +
          ' 枚 id',
        D3,
        humanDup ? 0 : 1,
        0,
        humanDup ? humanDup : 0,
        dsamples,
      );
    }

    // D4（HARD）载荷逐键形态：真人 body 键集 == feat 计划键集；id 是 Int64 且解回串必属触发源
    {
      const planKeys = keysOf(planSubmit(handles[0], 0) || {});
      let pass = 0;
      let fail = 0;
      const samples = [];
      for (const w of submits) {
        const bad = [];
        if (w.bodyKeys !== planKeys)
          bad.push('body 键=' + w.bodyKeys + '（feat 计划键=' + planKeys + '）');
        if (!w.idObj) bad.push('id 非 {_low,_high} 形态（' + w.idShape + '）');
        if (!/^\d+$/.test(String(w.idStr))) bad.push('id 解不出十进制串');
        else if (!handles.includes(w.idStr)) bad.push('id 不在触发源句柄集内：' + w.idStr);
        if (!TIER_DOMAIN.has(w.index)) bad.push('index=' + w.index + ' 越出档位表');
        if (w.indexRawType !== 'number') bad.push('index 类型=' + w.indexRawType);
        if (bad.length) {
          fail++;
          if (samples.length < 6) samples.push('t=' + w.t + ' ' + bad.join('；'));
        } else pass++;
      }
      if (!submits.length) rep.check('本场无 2129 写样本，不判定', D4, 0, 0, 1, []);
      else if (!planKeys)
        rep.check('仿真侧连一条计划都产不出（planSubmit 异常），不判定', D4, 0, 0, 1, []);
      else
        rep.check(
          '2129 {id,index} 逐键与 feat 计划同形 + id 可解回且必属触发源（不凭空发、不丢精度）',
          D4,
          pass,
          fail,
          0,
          samples,
        );
    }

    // D5 触发时序（HARD）：每条 2129 之前必有同 id 的融冰成功应答
    {
      if (!submits.length) {
        rep.check('本场无 2129 写样本，不判定', D5, 0, 0, 1, []);
      } else {
        let pass = 0;
        let fail = 0;
        const samples = [];
        for (const w of submits) {
          const trig = lastTriggerBefore(S.triggers, w);
          if (trig) pass++;
          else {
            fail++;
            if (samples.length < 6)
              samples.push('2129 id=' + (w.idStr || '不可解') + ' 之前无同 id 融冰应答');
          }
        }
        rep.check(
          '每条 2129 之前必有同 id 的融冰应答（只被动接应答、不猜 id）',
          D5,
          pass,
          fail,
          0,
          samples,
        );
      }
    }

    // D5b（HARD）过期闸边界：真人实际耗时必须落在闸内，否则 feat 会把摇得到的点丢掉
    {
      let pass = 0;
      let fail = 0;
      let skip = 0;
      const samples = [];
      for (const w of submits) {
        const trig = lastTriggerBefore(S.triggers, w);
        if (!trig) {
          skip++; // 无触发源可依（该条已在 D5 判负），此处不重复计数
          continue;
        }
        const ageMs = w.t - trig.ts;
        const planned = planSubmit(w.idStr, ageMs);
        if (ageMs <= SUBMIT_EXPIRE_MS && planned) pass++;
        else {
          fail++;
          if (samples.length < 6)
            samples.push(
              'id=' +
                w.idStr +
                ' 真人 ' +
                (ageMs / 1000).toFixed(2) +
                's 内提交成功，闸值 ' +
                SUBMIT_EXPIRE_MS +
                'ms → feat 会漏代摇',
            );
        }
      }
      rep.check(
        '过期闸不紧于真人实际节奏（闸值 ' + SUBMIT_EXPIRE_MS + 'ms）',
        D5,
        pass,
        fail,
        skip,
        samples,
      );
    }

    // D6（HARD）通道：2129/2117/2103 req 恒 sendPBV2
    {
      let pass = 0;
      let fail = 0;
      const samples = [];
      for (const w of [...submits, ...S.fireReqs]) {
        if (w.dir === 'req:sendPBV2') pass++;
        else {
          fail++;
          if (samples.length < 6) samples.push(w.cmd + ' dir=' + w.dir);
        }
      }
      rep.check('2129 与融冰请求恒走 sendPBV2 通道', D6, pass, fail, 0, samples);
    }

    // D7（HARD，无样本记 skip）盛宴线 2103：本 feat 两路都订，本场录制只走了 NWL
    {
      const bwl = S.triggers.filter((t) => t.src === CMD_FIRE_BWL);
      if (!bwl.length) {
        rep.check(
          '本场无 ' +
            CMD_FIRE_BWL +
            '（巨熊盛宴线）触发样本，该路无从判定（' +
            CMD_FIRE_NWL +
            ' 已覆盖 ' +
            S.triggers.length +
            ' 枚）',
          D7,
          0,
          0,
          1,
          [],
        );
      } else {
        let pass = 0;
        let fail = 0;
        const samples = [];
        for (const t of bwl) {
          const planned = plans.some(
            (p) => p.src === CMD_FIRE_BWL && p.handle === t.idStr && p.plan,
          );
          const sent = (byId.get(t.idStr) || []).length > 0;
          if (planned && sent) pass++;
          else {
            fail++;
            if (samples.length < 6)
              samples.push(
                '2103 id=' +
                  t.idStr +
                  ' 仿真计划=' +
                  (planned ? '有' : '无') +
                  '｜线上 2129=' +
                  (sent ? '有' : '无'),
              );
          }
        }
        rep.check(
          '盛宴线 ' + CMD_FIRE_BWL + ' 句柄同样被代摇（覆盖 ' + pass + '/' + bwl.length + '）',
          D7,
          pass,
          fail,
          0,
          samples,
        );
      }
    }

    // D8（OBSERVATION，不判负）应答、节奏与档位收益证据
    {
      const paired = submits.filter((w) => w.code != null);
      const ages = submits
        .map((w) => {
          const trig = lastTriggerBefore(S.triggers, w);
          return trig ? (w.t - trig.ts) / 1000 : null;
        })
        .filter((x) => x != null);
      const tierDist = new Map();
      for (const w of submits) tierDist.set(w.index, (tierDist.get(w.index) || 0) + 1);
      /** 档位 → 每发奖励项数样本（取 min~max，求「高档给得多」的现场证据） */
      const itemsOfTier = new Map();
      for (const w of submits) {
        if (!w.items || !w.items.length) continue;
        if (!itemsOfTier.has(w.index)) itemsOfTier.set(w.index, []);
        itemsOfTier.get(w.index).push(w.items.length);
      }
      const tierYield = [...itemsOfTier.entries()]
        .map(([k, arr]) => {
          const lo = Math.min(...arr);
          const hi = Math.max(...arr);
          return (TIER_LABELS[k] || '档 ' + k) + ' ' + (lo === hi ? lo : lo + '~' + hi) + ' 项/发';
        })
        .join('；');
      rep.check(
        '触发源 ' +
          S.triggers.length +
          ' 枚（去重 ' +
          handles.length +
          '）｜2129 出网 ' +
          submits.length +
          ' 发、配对 ' +
          paired.length +
          ' 条｜真人档位分布 ' +
          [...tierDist.entries()]
            .map(([k, v]) => (TIER_LABELS[k] || '档 ' + k) + '×' + v)
            .join(' ') +
          '｜各档奖励 ' +
          (tierYield || '—') +
          '｜普通点直接给奖 ' +
          S.directRewards.length +
          ' 支（单项为主：' +
          (S.directRewards[0]
            ? S.directRewards[0].items.map((i) => i.itemId + '×' + i.count).join(' ')
            : '—') +
          '）' +
          (ages.length
            ? '｜应答→提交延迟 ' +
              Math.min(...ages).toFixed(2) +
              '~' +
              Math.max(...ages).toFixed(2) +
              's'
            : ''),
        D8,
        0,
        0,
        1,
        [],
      );
    }

    // D9b（HARD，无重复样本记 skip）录制侧真值：同一枚 id 的第二发及以后必须没再给奖。
    //   这是 D9a「不重投」的成立前提：若实录里出现过「重复提交又拿到奖」，就说明服务器允许重投，
    //   那 D9a 的「在途闸挡下就放弃」会白丢一次代摇，得重新设计（故此处判负而不是默许）。
    {
      const dups = [];
      for (const [idStr, arr] of byId) {
        for (let i = 1; i < arr.length; i++) dups.push({ idStr: idStr, nth: i + 1, w: arr[i] });
      }
      if (!dups.length) {
        rep.check(
          '本录无「同 id 第二发」样本，「重复提交无收益」无从判定（D9a 仍为硬契约）',
          D9,
          0,
          0,
          1,
          [],
        );
      } else {
        let pass = 0;
        let fail = 0;
        let skip = 0;
        const samples = [];
        for (const d of dups) {
          if (d.w.code == null) {
            skip++; // 应答没配对上（频控/超时），不拿缺证当作通过
            continue;
          }
          if (d.w.code !== 0) {
            pass++;
            continue;
          }
          fail++;
          if (samples.length < 6)
            samples.push(
              'id=' +
                d.idStr +
                ' 第' +
                d.nth +
                '发仍 code=0（index=' +
                d.w.index +
                '）——重投确实能拿奖',
            );
        }
        if (samples.length === 0 && pass) {
          for (const d of dups) {
            if (d.w.code != null && d.w.code !== 0 && samples.length < 4)
              samples.push(
                'id=…' +
                  String(d.idStr).slice(-6) +
                  ' 第' +
                  d.nth +
                  '发 code=' +
                  d.w.code +
                  (d.w.codeText ? ' d=' + d.w.codeText + '（字典表：参数错误）' : ''),
              );
          }
        }
        rep.check(
          '同 id 第二发及以后的 2129 一律没再给奖（重复样本 ' + dups.length + ' 发）',
          D9,
          pass,
          fail,
          skip,
          samples,
        );
      }
    }

    // D10b（OBSERVATION，不判负）录制侧量级：成功结算的 2129 有多少带非空 rewardResult。
    //   带了才谈得上「玩家能看到奖励面板」；一条都没有时如实记无法判定，不拿零样本冒充通过。
    {
      const ok = submits.filter((w) => w.code === 0);
      if (!ok.length) {
        rep.check('本录无 code=0 的 2129 应答，「奖励有没有载荷可展示」无从统计', D10, 0, 0, 1, []);
      } else {
        const withRr = ok.filter((w) => w.rrKeys);
        rep.check(
          '成功结算 ' +
            ok.length +
            ' 发里带 rewardResult 载荷 ' +
            withRr.length +
            ' 发（奖励面板可展示的前提，只报量级）',
          D10,
          0,
          0,
          1,
          ok
            .slice(0, 3)
            .map(
              (w) => 'id=…' + String(w.idStr).slice(-6) + ' rewardResult keys=' + (w.rrKeys || '—'),
            ),
        );
      }
    }
  },
};
