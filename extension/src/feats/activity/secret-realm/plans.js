/**
 * 异能秘境自动驾驶 · 开车方案（Plan）层——纯数据 + 纯判据，无副作用、不发包、不摸引擎。
 *
 * 三层切分（见 docs/feat-异能秘境自动驾驶-v4竞品B对齐重写.md §15）：
 *   Engine(pilot.js #tick)  机制与安全前置（时钟/#cd/mooring/#dispatch/EVADE/拒绝退避/占用/单飞/回合硬闸）——全方案共享
 *   Objectives(pilot-select) 选点纯函数（resource/beast/shop/buff/plane）——全方案复用
 *   Plan(本文件)            阶段**顺序** + 进入/退出**条件** + 区域 + 每目标参数——每方案一份
 *
 * 依赖方向：pilot.js → plans.js → pilot-select.js/constants.js。本文件是纯叶子：**只 import constants 常量名**。
 * 红线：不出现裸 pointType 数字（如需点型判据一律走 constants 的 PAB_*）；不碰 api/net/引擎；不含可变状态。
 *
 * 语义：`stages` 顺序即优先级。`matchStages` 从头试到第一个 `when(ctx)` 为真的阶段；
 *   - `terminal:true` 的阶段命中即**独占本拍**（哪怕选不到目标也不回落后续档）——对应现状
 *     收场车「只回店不再吃井」(pilot.js L2043-2050)、BOSS 开台读秒让位 (L2056-2060) 与
 *     开打拍（L2357-2364：找不到平台也发一笔 `boss-plane|none` 记账就终拍，不落日常链）。
 *   - `stopNext:true` 的阶段只在**真选到目标时**截断后续，选不到则照常顺延——enigmaB_default
 *     暂无使用者（差分回放证实开打档实为 terminal）；语义保留给 Phase C 的真方案。
 *   - 两者都不标的阶段命中只表示「先试这一档」，选不到目标由引擎顺延到 matchStages 返回的下一档
 *     ——对应现状日常 acts 循环 `if(!cand) continue` (L2107) 与开台读秒找平台 (L2367-2383)。
 */
import { PAB_BOSS_PLANE } from './constants.js';

/**
 * ctx：引擎每拍组装后喂给 `when(ctx)` 判据与目标参数的只读上下文。**字段全部由引擎预解析**，
 * 本层不做取数（保持纯、可离线测）。字段来源对照 pilot.js 现状：
 * @typedef {{
 *   snap: object,                       // {points, marches, cur, curKey, curPt}：901 原样信封 + 当前点
 *   shopWhy: string|null,               // #shopWant 结果：'exit'|'stage'|'errand'|'sausage'|'gap'|null（后三者仅喂链尾排序，不拦路）
 *   teamType: number,                   // tuning.driveTeamType（0=只拿百兽箱，不碰 BOSS）
 *   driveBoss: boolean,                 // cfg.drive.boss（BOSS 窗开着时是否自动上平台，缺省 true）
 *   bossMode: 'open'|'lead'|null,       // #bossWindow：21 开打 / 22 开台读秒 / 无
 *   onBossPlane: boolean,               // 当前正停在 BOSS 平台（curPt===PAB_BOSS_PLANE）
 *   bossSameArea: boolean,              // 当前平台与目标 BOSS 同区域（esrId 真值比较，缺证放行）
 *   bossFeeding: boolean,               // 任一 BOSS state==23（开台读秒中）→ 日常车让路
 *   marchPolicy: number,                // tuning.driveMarchPolicy（2=跟人优先）
 *   beastPolicy: number,                // tuning.driveBeastPolicy（0/1/2=打野档插入位置）
 *   relax: boolean,                     // #beastStageWant（百兽期＝安心抓宠，链形不同）
 *   beastLock: boolean,                 // #beastLockNow（开台读秒后 0~180s 禁走窗，窗内跳打野档）
 *   shouldExplore: boolean,             // 纯读：已起表且闲逛超时（起表副作用在引擎梯尾，对齐现状 L2391/2465-2468）
 *   zone: (esrId:number)=>string,       // 区域解析：返回 'normal'|'strong'|'any'（Phase C 一等；B1 enigmaB 恒 'any'）
 *   // ── §15.3 ctx 一等字段（C4 新增；enigmaB_default 的判据不消费，缺字段时 matchStages 防御性跳过）──
 *   clock: {serverMs:number, fightBeginMs:number, fightEndMs:number},  // 毫秒时钟（引擎用 serverTime 组装，不回落本地钟）
 *   until: (ts:number|null)=>number,    // 「距某绝对时刻还有多久」毫秒；ts 缺失/无效给 Infinity（判据自然不命中）
 *   events: {bigBossStart:number|null, nearestSmallBossStart:number|null}, // 开打绝对毫秒；推导口径见下（⚠ 录制未覆盖 crystal 路，D1/E1 线上验）
 *   progress: {                         // 跨帧/背包态的只读谓词集（引擎组装，方案侧纯消费）
 *     areaOpen:(zone:string)=>boolean,  //   某区域类别是否已开窗（areaByStart 纯核 + realm/timer 表）
 *     buffsMaxed:(n:number)=>boolean,   //   buffMap[1..n] 全有值＝槽满（订正：「满级」无表据，先按满槽，阈值 n 走判据参数）
 *     shopDone:()=>boolean,             //   本场购物完成（百兽箱已买）
 *     buffTried:(x:number,y:number)=>boolean // 该点已探明无 buff 位（防反复白跑；会话级，换场复位）
 *   }
 * }} Ctx */

/**
 * 阶段描述。`obj` 是目标原语名（引擎 `Objectives[obj]` 映射到 pilot-select/#pickPlane 等）；
 * `params` 是**方案语义**的参数（用名字引用 tuning，别把魔法数写死进本文件，保持 config 解耦）。
 * @typedef {{
 *   id: string, obj: string, terminal?: boolean, stopNext?: boolean,
 *   zone?: string,                       // 传给资源/拾取原语的区域过滤（缺省引擎按 'any'）
 *   params?: object,
 *   when: (c:Ctx)=>boolean
 * }} Stage */

/**
 * 内置方案：竞品B对齐（= 现状 #tick 目标梯逐字复刻）。B1 唯一在跑的方案；
 * `crystal_then_skill` 等真方案随 Phase C 的原语（pickBuffDrop/zone/progress）长出后再加。
 * 每条 `when` 后注 pilot.js 现状行号，便于对拍与评审。
 * @type {{ enigmaB_default: { label:string, stages:Stage[] } }}
 */
export const PLANS = {
  enigmaB_default: {
    label: '竞品B对齐（内置＝现状）',
    stages: [
      // ── BOSS 档（#tick L2349-2383，早于 #stageChain）：team_type>0 && driveBoss 才走 ──
      {
        id: 'bossFight',
        obj: 'bossFight', // 已停平台且同区域→发 8521 开上 BOSS 本体（打仗本身仍归 boss.js 到点层）
        terminal: true,
        when: (c) =>
          c.bossMode === 'open' && c.teamType > 0 && c.driveBoss && c.onBossPlane && c.bossSameArea, // L2352-2360
      },
      {
        id: 'bossPlaneOpen',
        obj: 'plane',
        params: { source: 'bossWindow' }, // #pickPlane(win.boss)
        // ⚠ terminal（真实报文差分回放实钉）：现状开打拍无论找没找到平台都 `#dispatch` 一笔后
        //   return（L2357-2364），找不到也不落日常链；只有 bossPlaneLead（开台读秒）才是
        //   非独占：没平台记一笔、落回日常链采井/打野（L2367-2383）。
        terminal: true,
        when: (c) => c.bossMode === 'open' && c.teamType > 0 && c.driveBoss, // L2351-2364
      },
      {
        id: 'bossPlaneLead',
        obj: 'plane',
        params: { source: 'bossWindow' },
        // 非 terminal：找不到平台且视口不忙时落回 #stageChain（L2367-2383）
        when: (c) =>
          c.bossMode === 'lead' && c.teamType > 0 && c.driveBoss && c.snap.curPt !== PAB_BOSS_PLANE, // L2367
      },

      // ── 收场/高光去店档（#stageChain L2043-2051，命中即独占、不回落采井打野）──
      {
        id: 'shopExit',
        obj: 'shop',
        terminal: true,
        params: { exit: true }, // #pickShop(…, preferNoSausage=false, exit=true)
        when: (c) => c.shopWhy === 'exit', // L2043
      },
      {
        id: 'shopStage',
        obj: 'shop',
        terminal: true,
        params: { preferNoSausage: true }, // #pickShop(…, preferNoSausage=true)
        when: (c) => c.shopWhy === 'stage', // L2043
      },

      // ── BOSS 开台读秒让路（L2056-2060，team_type>0 && state23 → 本拍不派日常车，独占）──
      {
        id: 'bossWait',
        obj: 'wait', // 引擎理解为「短睡让位」，不发 8521
        terminal: true,
        when: (c) => c.teamType > 0 && c.bossFeeding, // L2056
      },

      // ── 日常链（L2070-2119，非 terminal：逐档试，选不到即顺延下一档）──
      { id: 'follow', obj: 'follow', when: (c) => c.marchPolicy === 2 }, // L2071 acts.unshift('follow')

      // 百兽期（relax）分支（L2072-2074）
      {
        id: 'beastRelax',
        obj: 'beast',
        when: (c) => c.relax && c.beastPolicy < 2 && !c.beastLock, // L2073 + 禁走窗 L2092
      },
      { id: 'cruiseRelax', obj: 'resource', params: { yield: 'cruise' }, when: (c) => c.relax }, // L2074

      // 日常（非 relax）分支（L2075-2080）
      {
        id: 'beastEarly',
        obj: 'beast',
        when: (c) => !c.relax && c.beastPolicy === 1 && !c.beastLock, // L2076
      },
      {
        id: 'cruiseStrict',
        obj: 'resource',
        params: { yield: 'strict' }, // #strictResMinNum() + driveStrictResMaxDist(100) L2093-2094
        when: (c) => !c.relax, // L2077
      },
      {
        id: 'beastLate',
        obj: 'beast',
        when: (c) => !c.relax && c.beastPolicy === 0 && !c.beastLock, // L2078
      },
      {
        id: 'cruiseLoose',
        obj: 'resource',
        params: { yield: 'loose' }, // driveCruiseMinYield(≥0，不允许快照明确 0 件) L2097-2104
        when: (c) => !c.relax, // L2079
      },
      {
        id: 'shopTail',
        obj: 'shop',
        params: { preferByWhy: true }, // 链尾兜底：有 errand/sausage/gap 理由时按「香肠没买过」优先 L2105-2108
        when: (c) => !c.relax, // L2080
      },

      // ── 探索档（#tick L2391，日常链全空后）── ctx.shouldExplore 是纯读；「未起表先起表」
      //   的副作用在引擎梯尾补（pilot.js #runStages 尾部），时序对齐现状⑧。
      { id: 'explore', obj: 'explore', when: (c) => c.shouldExplore }, // L2391
    ],
  },

  /**
   * §15.2 水晶→技能→水晶→BOSS（C4 新增，非缺省；config.drive.drivePlan='crystal_then_skill' 才启用）。
   * ⚠ **报文订正**（先证后接）：原图「弄技能=拾带 buff 的 163 掉落」不成立——录制 2149 帧 901 实证
   *   163 明细无 buff 字段且 esrId 恒 0（不可分区）；buff 在 **173 资源点明细**（8526/21522 的 buffInfo）。
   *   故 strongSkill 用 `obj:'buff'`（pickBuffDrop 选带 buff 位的 173 井），拾取走 pickup.js 既有 8538 链。
   * ⚠ events/progress 的引擎侧推导（大/小 BOSS 不分家、按 state22 读秒窗 min 取）未经线上验证，
   *   本方案不上生产缺省路；enigmaB_default 行为与差分回放零分叉不受本文影响。
   */
  crystal_then_skill: {
    label: '水晶→技能→水晶→BOSS',
    stages: [
      // BOSS 开打且已停同区平台→上本体（与 enigmaB 同源，terminal）
      {
        id: 'bossFight',
        obj: 'bossFight',
        terminal: true,
        when: (c) =>
          c.bossMode === 'open' && c.teamType > 0 && c.driveBoss && c.onBossPlane && c.bossSameArea,
      },
      // 大BOSS 前 2min 占位（§15.2 bossOccupy）：终端独占——占位拍不落日常链，与 enigmaB 开打档同语义
      {
        id: 'bossOccupy',
        obj: 'plane',
        params: { source: 'bossWindow' },
        terminal: true,
        when: (c) =>
          c.teamType > 0 &&
          c.driveBoss &&
          c.snap.curPt !== PAB_BOSS_PLANE &&
          c.until(c.events && c.events.bigBossStart) <= 120000,
      },
      // 大BOSS 前 5min 购物且本场购物未完（百兽箱未买）；非 terminal：选不到店照常顺延
      {
        id: 'shopPrep',
        obj: 'shop',
        params: { preferNoSausage: true },
        when: (c) =>
          c.snap.curPt !== PAB_BOSS_PLANE &&
          c.until(c.events && c.events.bigBossStart) <= 300000 &&
          !(c.progress && c.progress.shopDone()),
      },
      // 强区已开窗且 buff 槽未满 3 → 冲强区弄技能（非 terminal：选不到井回普通区采矿）
      {
        id: 'strongSkill',
        obj: 'buff',
        zone: 'strong',
        when: (c) => c.progress && !c.progress.buffsMaxed(3) && c.progress.areaOpen('strong'),
      },
      // 就近小BOSS 开台读秒窗 ≤ 2min → 提前占位（非 terminal，同 enigmaB bossPlaneLead 语义：没平台落回日常）
      {
        id: 'smallGuard',
        obj: 'plane',
        params: { source: 'bossWindow' },
        when: (c) =>
          c.teamType > 0 &&
          c.driveBoss &&
          c.snap.curPt !== PAB_BOSS_PLANE &&
          c.until(c.events && c.events.nearestSmallBossStart) <= 120000,
      },
      // 兜底：普通区采水晶（zone 经引擎 ctx.zone 过滤；driveStrongRoundMin=0 时全判 'normal' 自然放行）
      {
        id: 'normalCrystal',
        obj: 'resource',
        zone: 'normal',
        params: { yield: 'cruise' },
        when: () => true,
      },
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
 * 供面板/配置列方案 id（缺省回落 enigmaB_default）。
 * @returns {string[]}
 */
export function planIds() {
  return Object.keys(PLANS);
}
