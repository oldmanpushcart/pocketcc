/**
 * 异能秘境自动驾驶 · 开车方案（Plan）层——纯数据 + 纯判据，无副作用、不发包、不摸引擎。
 *
 * 三层切分（见 docs/feat-异能秘境自动驾驶-v4竞品B对齐重写.md §15）：
 *   Engine(pilot.js #tick)  机制与安全前置（时钟/#cd/mooring/#dispatch/EVADE/拒绝退避/占用/单飞/回合硬闸）——方案共享
 *   Objectives(pilot-select) 选点纯函数（resource/beast/shop/buff/plane）——方案复用
 *   Plan(本文件)            阶段**顺序** + 进入/退出**条件** + 每目标参数——每方案一份
 *
 * 依赖方向：pilot.js → plans.js → pilot-select.js/constants.js。本文件是纯叶子：**只 import constants 常量名**。
 * 红线：不出现裸 pointType 数字（如需点型判据一律走 constants 的 PAB_*）；不碰 api/net/引擎；不含可变状态。
 *
 * 方案↔引擎契约（防「方案侧一行、引擎侧 40 行」的边界穿透）：
 *   1. `CTX_KEYS`——方案可读的 ctx 字段**封闭集**。方案需新字段必须同步修 CTX_KEYS + pilot.js #buildCtx，
 *      禁止只改 #buildCtx 不加清单（启动期 validatePlan 会卡）。
 *   2. `OBJECTIVES`——引擎 #objective switch 已实现的目标原语名清单。方案 stage.obj 写错/未实现 → 启动期抛。
 *   3. `params`——**方案私有阈值留在 stage.params**（例：某方案的“前 30s 回店”阈值写 `params:{leadMs:30000}`），
 *      不往 constants.tuning 里塞方案专用字段；constants.tuning 只存跨方案共享参数。
 *   4. **解释器效果属性**（三-5 下沉）——链标记/空候选处置/探索副作用等原 pilot.#runStages 的
 *      id/obj 硬编码特判，一律声明为 stage 属性、由解释器通用消费（引擎不得再按阶段 id 特判）：
 *      `chain`（日常链标记）/`emptyShopMark`（terminal 店档空候选记到店+scan 短睡）/
 *      `emptyNote`（空候选边沿日志 {key,msg}）/`explore`（探索发车副作用）/`tailShopLog`（链尾去店 info）。
 *      validatePlan 同步卡属性形状与适用档位。
 *
 * 语义：`stages` 顺序即优先级。`matchStages` 从头试到第一个 `when(ctx)` 为真的阶段；
 *   - `terminal:true` 的阶段命中即**独占本拍**（哪怕选不到目标也不回落后续档）——对应现状
 *     收场车「只回店不再吃井」(pilot.js L2043-2050)、BOSS 开台读秒让位 (L2056-2060) 与
 *     开打拍（L2357-2364：找不到平台也发一笔 `boss-plane|none` 记账就终拍，不落日常链）。
 *   - `stopNext:true` 的阶段只在**真选到目标时**截断后续，选不到则照常顺延——默认方案暂无使用者
 *     （差分回放证实开打档实为 terminal）；语义保留给未来的真方案。
 *   - 两者都不标的阶段命中只表示「先试这一档」，选不到目标由引擎顺延到 matchStages 返回的下一档
 *     ——对应现状日常 acts 循环 `if(!cand) continue` (L2107) 与开台读秒找平台 (L2367-2383)。
 */
import { PAB_BOSS_PLANE } from './constants.js';

/**
 * ctx：引擎每拍组装后喂给 `when(ctx)` 判据与目标参数的只读上下文。**字段全部由引擎预解析**，
 * 本层不做取数（保持纯、可离线测）。字段来源对照 pilot.js 现状；下方 `CTX_KEYS` 是本 typedef 的运行时投影。
 * @typedef {{
 *   snap: object,                       // {points, marches, cur, curKey, curPt}：901 原样信封 + 当前点
 *   shopWhy: string|null,               // #shopWant 结果：'exit'|'stage'|'errand'|'sausage'|'gap'|null（后三者仅喂链尾排序，不拦路）
 *   teamType: number,                   // tuning.driveTeamType（0=只拿百兽箱，不碰 BOSS）
 *   bossMode: 'open'|'lead'|null,       // #bossWindow：21 开打 / 22 开台读秒 / 无
 *   onBossPlane: boolean,               // 当前正停在 BOSS 平台（curPt===PAB_BOSS_PLANE）
 *   bossSameArea: boolean,              // 当前平台与目标 BOSS 同区域（esrId 真值比较，缺证放行）
 *   bossFeeding: boolean,               // 任一 BOSS state==23（开台读秒中）→ 日常车让路
 *   marchPolicy: number,                // tuning.driveMarchPolicy（2=跟人优先）
 *   beastPolicy: number,                // tuning.driveBeastPolicy（0/1/2=打野档插入位置）
 *   beastOff: boolean,                  // 面板 drivePetLevel=0（不抓宠）派生（true=完全不打野，短路打野三档，等价 beastPolicy=2）
 *   relax: boolean,                     // #beastStageWant（百兽期＝安心抓宠，链形不同）
 *   beastLock: boolean,                 // #beastLockNow（开台读秒后 0~180s 禁走窗，窗内跳打野档）
 *   shouldExplore: boolean              // 纯读：已起表且闲逛超时（起表副作用在引擎梯尾，对齐现状 L2391/2465-2468）
 * }} Ctx */

/**
 * 方案↔引擎契约之一：ctx 字段**封闭集**。与上方 `Ctx` typedef 一字对应。
 * 新字段＝新契约：同步修本清单 + pilot.js #buildCtx，启动期 validatePlan 会卡住未同步的修改。
 * @type {readonly string[]}
 */
export const CTX_KEYS = Object.freeze([
  'snap',
  'shopWhy',
  'teamType',
  'bossMode',
  'onBossPlane',
  'bossSameArea',
  'bossFeeding',
  'marchPolicy',
  'beastPolicy',
  'beastOff',
  'relax',
  'beastLock',
  'shouldExplore',
]);

/**
 * 方案↔引擎契约之二：引擎 `#objective` switch 已实现的目标原语名清单（与 pilot.js #objective 一字对应）。
 * 方案 stage.obj 写错、或引擎删了 case 没同步本清单 → 启动期抛（防「选不到点静默顺延」的难排障。
 * @type {readonly string[]}
 */
export const OBJECTIVES = Object.freeze([
  'bossFight',
  'plane',
  'shop',
  'follow',
  'beast',
  'resource',
  'explore',
  'wait',
]);

/**
 * 阶段描述。`obj` 是目标原语名（引擎 `Objectives[obj]` 映射到 pilot-select/#pickPlane 等）；
 * `params` 是**方案语义**的参数（用名字引用 tuning，别把魔法数写死进本文件，保持 config 解耦）。
 * @typedef {{
 *   id: string, obj: string, terminal?: boolean, stopNext?: boolean,
 *   chain?: boolean,          // 日常链成员：首个命中档落 stage='cruise'/'beast-stage'（relax 时）+ why
 *   emptyShopMark?: boolean,  // terminal 店档专属：空候选也记 #shopLastAt=now 防重评，睡眠取 driveScanMs
 *   emptyNote?: {key:string,msg:string}, // 空候选时落一条 #note 边沿 info（如开台读秒无平台）
 *   explore?: boolean,        // 探索档发车副作用：起/重置闲逛计时 + 方向轮转 + stage/branch + idle_explore 边沿日志
 *   tailShopLog?: boolean,    // 链尾店档命中且有去店理由时落 chain-tail go-shop info
 *   params?: object,
 *   when: (c:Ctx)=>boolean
 * }} Stage */

/**
 * 内置方案：竞品B对齐（= 现状 #tick 目标梯逐字复刻），也是唯一在跑的方案。
 * 每条 `when` 后注 pilot.js 现状行号，便于对拍与评审。
 * 顶层旗标：`shopErrand`（大BOSS 前定点商店勤务，缺省 true；pilot #shopWant errand 档读当前方案旗标，
 *   未来方案不含即不做勤务）；BOSS 窗上平台不再设子闸——方案含 BOSS 档即代表「上平台」，不含即不上。
 * @type {{ default: { label:string, shopErrand?:boolean, stages:Stage[] } }}
 */
export const PLANS = {
  default: {
    label: '默认方案',
    shopErrand: true,
    stages: [
      // ── BOSS 档（#tick L2349-2383，早于 #stageChain）：team_type>0 才走；方案含本组档即代表上平台 ──
      {
        id: 'bossFight',
        obj: 'bossFight', // 已停平台且同区域→发 8521 开上 BOSS 本体（打仗本身仍归 boss.js 到点层）
        terminal: true,
        when: (c) => c.bossMode === 'open' && c.teamType > 0 && c.onBossPlane && c.bossSameArea, // L2352-2360
      },
      {
        id: 'bossPlaneOpen',
        obj: 'plane',
        params: { source: 'bossWindow' }, // #pickPlane(win.boss)
        // ⚠ terminal（真实报文差分回放实钉）：现状开打拍无论找没找到平台都 `#dispatch` 一笔后
        //   return（L2357-2364），找不到也不落日常链；只有 bossPlaneLead（开台读秒）才是
        //   非独占：没平台记一笔、落回日常链采井/打野（L2367-2383）。
        terminal: true,
        when: (c) => c.bossMode === 'open' && c.teamType > 0, // L2351-2364
      },
      {
        id: 'bossPlaneLead',
        obj: 'plane',
        params: { source: 'bossWindow' },
        // 非 terminal：找不到平台且视口不忙时落回 #stageChain（L2367-2383）；
        //   空候选记一笔边沿 info（串行模型下 901 已 await 完，选不到就是真没有，不等在途）
        emptyNote: {
          key: 'no-plane',
          msg: 'pilot: no usable platform found within BOSS open-countdown window (viewport lacks 176/174 or all occupied), give up boarding this tick. reason=no_plane',
        },
        when: (c) => c.bossMode === 'lead' && c.teamType > 0 && c.snap.curPt !== PAB_BOSS_PLANE, // L2367
      },

      // ── 收场/高光去店档（#stageChain L2043-2051，命中即独占、不回落采井打野）──
      {
        id: 'shopExit',
        obj: 'shop',
        terminal: true,
        emptyShopMark: true, // 选不到店也不回落采井打野，只记防重评（L2043-2051）
        params: { exit: true }, // 窄筛 pickShop（preferNoSausage=false，收场只拿货）
        when: (c) => c.shopWhy === 'exit', // L2043
      },
      {
        id: 'shopStage',
        obj: 'shop',
        terminal: true,
        emptyShopMark: true, // 同 shopExit：空候选记防重评 + scan 短睡
        params: { preferNoSausage: true }, // 窄筛 pickShop（preferNoSausage=true）
        // BOSS 优先闸（1115 问题6）：BOSS 窗活跃（open/lead）或投喂窗（state23，此时 bossMode=null）
        //   → shopStage 不命中，让位 boss 链/bossWait；治「从 BOSS 平台径直去商店」（terminal 独占本拍）。
        when: (c) => c.shopWhy === 'stage' && !(c.teamType > 0 && (!!c.bossMode || c.bossFeeding)), // L2043
      },

      // ── BOSS 开台读秒让路（L2056-2060，team_type>0 && state23 → 本拍不派日常车，独占）──
      {
        id: 'bossWait',
        obj: 'wait', // 引擎理解为「短睡让位」，不发 8521
        terminal: true,
        when: (c) => c.teamType > 0 && c.bossFeeding, // L2056
      },

      // ── 日常链（L2070-2119，非 terminal：逐档试，选不到即顺延下一档）──
      { id: 'follow', obj: 'follow', chain: true, when: (c) => c.marchPolicy === 2 }, // L2071 acts.unshift('follow')

      // 百兽期（relax）分支（L2072-2074）
      {
        id: 'beastRelax',
        obj: 'beast',
        chain: true,
        when: (c) => c.relax && c.beastPolicy < 2 && !c.beastOff && !c.beastLock, // L2073 + 禁走窗 L2092 + 总闸短路
      },
      {
        id: 'cruiseRelax',
        obj: 'resource',
        chain: true,
        params: { yield: 'cruise' },
        when: (c) => c.relax,
      }, // L2074

      // 日常（非 relax）分支（L2075-2080）
      {
        id: 'beastEarly',
        obj: 'beast',
        chain: true,
        when: (c) => !c.relax && c.beastPolicy === 1 && !c.beastOff && !c.beastLock, // L2076 + 总闸短路
      },
      {
        id: 'cruiseStrict',
        obj: 'resource',
        chain: true,
        params: { yield: 'strict' }, // #strictResMinNum() + driveStrictResMaxDist(100) L2093-2094
        when: (c) => !c.relax, // L2077
      },
      {
        id: 'beastLate',
        obj: 'beast',
        chain: true,
        when: (c) => !c.relax && c.beastPolicy === 0 && !c.beastOff && !c.beastLock, // L2078 + 总闸短路
      },
      {
        id: 'cruiseLoose',
        obj: 'resource',
        chain: true,
        params: { yield: 'loose' }, // driveCruiseMinYield(≥0，不允许快照明确 0 件) L2097-2104
        when: (c) => !c.relax, // L2079
      },
      {
        id: 'shopTail',
        obj: 'shop',
        chain: true,
        tailShopLog: true, // 命中且有去店理由时落 chain-tail go-shop info（不抢采井/打野）
        params: { preferByWhy: true }, // 链尾兜底：有 errand/sausage/gap 理由时按「香肠没买过」优先 L2105-2108
        when: (c) => !c.relax, // L2080
      },

      // ── 探索档（#tick L2391，日常链全空后）── ctx.shouldExplore 是纯读；「未起表先起表」
      //   的副作用在引擎梯尾补（pilot.js #runStages 尾部），时序对齐现状⑧。
      { id: 'explore', obj: 'explore', chain: true, explore: true, when: (c) => c.shouldExplore }, // L2391
    ],
  },
};

/**
 * 纯解释器核：按优先级返回本拍**要依次尝试**的阶段列表——从头到第一个 `when` 真者，
 * 遇到 `terminal`/`stopNext` 命中即把它收进列表并截断（前者＝无论实不空都独占本拍；
 * 后者＝只在真选到目标时独占、空则由引擎继续往下走）；两者皆无的命中档则继续
 * 收集后续可能档（供引擎「选不到目标就顺延」）。引擎遍历返回列表逐个跑 `Objectives[obj]`，
 * 第一个真给出目标的即 `#dispatch` 并停；terminal 首位无论有无目标都独占。
 * @param {{stages:Stage[]}} plan
 * @param {Ctx} ctx
 * @returns {Stage[]} 依优先级排好的候选阶段（可能为空＝本拍目标层无动作）
 */
export function matchStages(plan, ctx) {
  const out = [];
  const stages = (plan && plan.stages) || [];
  for (let i = 0; i < stages.length; i++) {
    const s = stages[i];
    let hit;
    try {
      hit = !!s.when(ctx);
    } catch {
      hit = false; // 判据防御：ctx 缺字段不炸链
    }
    if (!hit) continue;
    out.push(s);
    if (s.terminal || s.stopNext) break; // 独占本拍/命中即停，截断后续
  }
  return out;
}

/**
 * 供面板/配置列方案 id（当前只有 'default' 一个方案，保留 API 以备将来扩展）。
 * @returns {string[]}
 */
export function planIds() {
  return Object.keys(PLANS);
}

/**
 * 方案↔引擎契约校验器。不抛异常，返回违例列表，由调用方决定“启动期直接抵”还是“测试里断言”。
 * 自“剥除 crystal_then_skill”后新增，专治「方案侧一行、引擎侧 40 行」的边界穿透。
 *
 * 检查项：
 *   1. `stage.obj` 必在 `OBJECTIVES`——防引擎 switch 缺 case，运行期“选不到点静默顺延”。
 *   2. `terminal` 阶段 id 必在 `stageDiagKeys`——防引擎 STAGE_DIAG 没登记，命中拍 `#stage=undefined`，
 *      probe 对拍丢分支。例外：`obj==='wait'` 走 cand.wait 专用分支，不经 STAGE_DIAG。
 *   3. `id`/`obj` 存在且类型正确；`id` 全局唯一。
 *   4. `when` 为函数（方案层当前保留箭头函数判据；未来如降级为 DSL 会新加一项）。
 *   5. 解释器效果属性形状与适用档（三-5）：`emptyShopMark` 只许 terminal 店档；`tailShopLog`
 *      只许非 terminal 店档；`explore` 只许 obj=explore；`emptyNote` 必带字符串 key/msg；`chain` 必为布尔。
 *   6. 顶层旗标 `shopErrand`（若声明）必为布尔（大BOSS 前定点勤务开关，pilot #shopWant 读）。
 *
 * @param {{stages?:Stage[]}} plan 待验方案（PLANS[id]）
 * @param {string[]} stageDiagKeys 引擎 STAGE_DIAG 当前登记的阶段 id 清单（pilot.js 传 Object.keys(STAGE_DIAG)）
 * @returns {string[]} 违例列表（空数组＝无违例）
 */
export function validatePlan(plan, stageDiagKeys) {
  const errs = [];
  const stages = (plan && plan.stages) || [];
  const diag = Array.isArray(stageDiagKeys) ? stageDiagKeys : [];
  if (plan && plan.shopErrand !== undefined && typeof plan.shopErrand !== 'boolean') {
    errs.push('plan.shopErrand 非布尔');
  }
  const seen = new Set();
  for (let i = 0; i < stages.length; i++) {
    const s = stages[i];
    if (!s || typeof s !== 'object') {
      errs.push('stage[' + i + '] 非对象');
      continue;
    }
    const tag = 'stage[' + i + ']' + (s.id ? ' #' + s.id : '');
    if (typeof s.id !== 'string' || !s.id) errs.push(tag + ' 缺 id');
    if (typeof s.obj !== 'string' || !s.obj) errs.push(tag + ' 缺 obj');
    if (typeof s.when !== 'function') errs.push(tag + ' when 非函数');
    if (s.id) {
      if (seen.has(s.id)) errs.push(tag + ' id 重复');
      seen.add(s.id);
    }
    if (s.obj && !OBJECTIVES.includes(s.obj)) {
      errs.push(
        tag + ' obj=' + s.obj + ' 不在 OBJECTIVES 清单（引擎 #objective 无此 case、或清单未同步）',
      );
    }
    if (s.terminal && s.obj !== 'wait' && s.id && !diag.includes(s.id)) {
      errs.push(tag + ' terminal 档未登记到 STAGE_DIAG（引擎无法为它提供诊断档位名）');
    }
    // 解释器效果属性（三-5）：形状与适用档校验，防「属性写错档 → 引擎静默不生效」
    if (s.chain !== undefined && typeof s.chain !== 'boolean') errs.push(tag + ' chain 非布尔');
    if (s.emptyShopMark && !(s.terminal && s.obj === 'shop')) {
      errs.push(tag + ' emptyShopMark 只适用于 terminal 店档');
    }
    if (s.tailShopLog && !(s.obj === 'shop' && !s.terminal)) {
      errs.push(tag + ' tailShopLog 只适用于非 terminal 店档');
    }
    if (s.explore && s.obj !== 'explore') errs.push(tag + ' explore 属性只适用于 obj=explore');
    if (s.emptyNote) {
      const en = s.emptyNote;
      if (!en || typeof en.key !== 'string' || !en.key || typeof en.msg !== 'string' || !en.msg) {
        errs.push(tag + ' emptyNote 需 {key,msg} 非空字符串');
      }
    }
  }
  return errs;
}

/**
 * ctx 字段集校验器：引擎 #buildCtx 产出的 keys 必与 `CTX_KEYS` 一字对应（多/少都算验失败）。
 * 调用方：dev 模式下 #runStages 首拍跑一次；测试层每次 #buildCtx 产物都可跑。
 * @param {object} ctx #buildCtx 的返回值
 * @returns {string[]} 违例列表（空＝无违例）
 */
export function validateCtxKeys(ctx) {
  const errs = [];
  if (!ctx || typeof ctx !== 'object') return ['ctx 非对象'];
  const got = Object.keys(ctx);
  for (const k of got) if (!CTX_KEYS.includes(k)) errs.push('ctx 包含未声明字段：' + k);
  for (const k of CTX_KEYS) if (!got.includes(k)) errs.push('ctx 缺声明字段：' + k);
  return errs;
}
