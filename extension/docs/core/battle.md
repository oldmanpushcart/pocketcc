# battle.js — 行军发包载荷构造

> 源码：[`src/core/battle.js`](../../src/core/battle.js)　·　日志 tag：`[POCKETCC://BATTLE]`

## 1. 职责与边界

**管什么**：只造数据——从游戏运行时（PresetMarchController / UserData / HeroController / MechaController / FightFormationAdvController）读取预设部队、英雄、军阵信息，构造出发起行军（`MARCH_WORLD_POINT` 902 等）所需的请求字段。

**不管什么**：不发起行军、不发送请求、不关心目标点/坐标/行军指令——那些是 feat 层与 `net.js` 的事。

**对外契约**：产出的 MarchData 固定 6 字段（5 个请求字段 + 1 个调用方辅助标记）：

```js
{
  armyListNew: [{ pos, armyId, armyNum, heroCap?, skinId? }, ...],  // pos 为战斗位编码，见 §5
  heroList:    [heroId, ...],      // 纯数字数组，不是 {heroId} 对象数组
  trapList:    [],                 // 预设不含陷阱，恒空
  formationV2: number,             // 军阵代码，0 = 无
  extraArmy:   { armyId, armyNum } | {},   // 补位格部队
  presetHasHeroes: boolean,        // 预设是否原本配了英雄（非请求字段，见 §6）
}
```

依赖游戏运行时模块全部经 `core/game.js` 薄封装软获取；缺失即返回 null / 0，各入口自行兜底（降级策略见 §5）。

## 2. 设计思路与取舍

### 2.1 每格上阵数交回游戏重算器，不自己写公式

预设里的 `Num` 是**保存那一刻**的上限快照；真实上限由 `Buff(BattleArmyAddNum) 聚合 + 英雄统率加成 + 等级格子数 + 当前可派兵池` 共同决定，且兵池是**逐格消耗**的（同一份预设实测：兵全在家可派 250，部分在外则 126 且尾部两格拿不满）。这种分配任何手写公式都复现不出来，所以首选路径是调游戏自带的 `checkPreMarchExtraList`（经 `game-api.js` 的 `battlePreset.recalc` 防腐层）。

两条实证约束决定了接入细节（证据：`references/游戏逆向/extracted/subpack2/RealMarchStorageController__RealMarchStorageController.js`）：

- 重算器语义是「发满」（给 1 支也补到格上限）→ 结果与预设 `Num` **取小**，保住「预设故意少摆」的语义；
- 重算器**就地改写**传入对象 → 只喂自建副本，绝不传 PresetMarchData 本体。

### 2.2 默认不校准 + `.adjust()` 显式校准（极性决策）

业务上派兵分三个场景（这三个名称是本项目归纳的，游戏无对应概念）：

| 场景 | 诉求 | 底层语义 |
|---|---|---|
| **快速派兵** | 最低成本占位/凑数，不查额度 | 取最低级可派兵 1 支，不走重算 |
| **普通派兵** | 真出征，不能把在外的兵重复派 | `recalc(entry, checkMarch=true)` |
| **活动派兵** | 快照战斗不占真实行军池（如卡车掠夺），但要真实容量 | `recalc(entry, checkMarch=false)` |

据此把默认极性定为**不校准**：`.preset(n).build()` 是不触发重算器的快速路径（满编原样），需要校准必须显式 `.adjust()`。理由：三场景里只有两个需要重算器，且校准是有语义代价的选择（选池口径），显式比默认诚实；调用点读链即知道数据从哪来。

> ⚠️ 极性翻转是破坏性变更：翻转前所有 `.preset(n).build()` 都是「过滤+重算+排除在途」，翻转后静默退化为满编 raw。落地此变更时，**所有普通派兵调用点已同步补 `.adjust()` 保持行为不变**（见 §8）。后来者给新 feat 造数据时，先想清楚属于三场景中哪一个，再决定要不要 `adjust`。

### 2.3 否决的方案：正交布尔链 `.excludeMarched()/.adjustPosNum()`

曾考虑把两个轴做成独立链式布尔。否决理由：

1. **组合爆炸无合法语义**——「排除在途但不校准容量」「校准容量但不清在途名额」这类组合调用者不会真用，却要在类型/文档上防呆；
2. **顺序陷阱**——布尔链的生效与否依赖调用顺序（先 `excludeMarched` 后 `preset` 会丢），source 枚举 + 单修饰符则无此问题；
3. **minimal 源无处安放**——minimal 不涉及容量重算，正交布尔会给它造出假旋钮。

最终形态：`plan()` 持有一个 **raw 数据完备集**（`#data`：`armyInfo`（grid pos、未编码）/`heroIds`/`formationV2`/`extraRaw`）与一个**校准意图**（`#recalc`）。`preset()`/`minimal()` 是对这同一个完备集的**覆盖式互斥装载**（换一份整份来源，不是增量叠加），`adjust()` 只记意图、延迟到 `build()` 单点投影时才执行——从结构上消除了布尔链的顺序陷阱，也让「装载」与「投影」职责分明。`adjust` 仅对 `preset` 源有意义（`minimal` 只发 1 支最低级兵、不查额度也不重算，叠加 `adjust` 静默无作用）。

### 2.4 「容量校准」与「排除在途」是可分的两个轴（源码实证，曾被误判）

读游戏源码前曾误以为「逐格重算 num 必然排除在途」，二者是同一计算不可分割的输出。源码证伪：`checkPreMarchExtraList` 里

- **容量计算 `getMaxCoutByPos` 恒做**，与 `checkMarch` 无关；
- **`checkMarch` 只切换三处「池」的来源**：

| 维度 | `checkMarch: true`（排除在途） | `checkMarch: false`（不排除） |
|---|---|---|
| 兵池 | `getAttackerMyArmys()` 在家可派 | `getAttackerMyArmys(false,false)` 全部持有 |
| 英雄 | `getHaveHeroCanMarchList()` 可派遣 | `getHeroAll()` 全体 |
| 军阵名额 | `getAdvFormationMarchCountRemainder()` 剩余 | `getAdvFormationMarchCountMax()` 满额 |
| 机甲 | 仅 `state===CanFight` 计入 | 非可战斗机甲也计入 |

这正是三场景能同时成立「普通/活动都 adjust 校准、只差排不排除」的底层依据。

### 2.5 满编快照的身份：默认不校准路径，不是活动派兵的正解

「满编原样、不 filter 不重算」不是一条独立 API，而是 `build()` 在**未 `adjust`** 时的默认投影（`projectRaw`）——即 `plan().preset(n).build()`。它常被误当成「活动派兵」，但活动派兵的正解是 `plan().preset(n).adjust({ignoreMarched:true}).build()`（**仍做容量校准**，只是不排除在途）；两者的差别在于要不要重算每格容量。卡车 `probeSelf` 取 999 战力评估分母走的是 `plan().preset(presetIdx).build()`（满编、不重算），那是「与出征载荷同源」的刻意选择，不是活动派兵调用点（见 §6-5）。历史上它曾以函数式 `buildPresetRaw` 暴露，现已收敛进链式。

## 3. API 契约

### 3.1 MarchPlan 链式构造（feat 层主入口）

```js
class MarchPlan {
  preset(index = 1, type?)   // 选预设队伍。index 外部 1 起（内部减 1）；
                             // type: 0 战斗（默认）/ 1 采集 / true 等价 1
  minimal()                  // 选最低级可派遣部队为源（0 英雄/0 军阵/0 陷阱，1 支放 pos1）
  adjust(opts?)              // 显式开启校准。opts = { ignoreMarched?: boolean }
                             //   缺省            → 排除在途（普通派兵）
                             //   ignoreMarched:true → 不排除（活动派兵，映射 checkMarch=false）
  build()                    // 产出 MarchData（§1 契约），任何失败路径收敛为派空
}
new Battle().plan()          // 创建 MarchPlan
```

**默认值与极性**：不调 `adjust()` → `#recalc=null` 不校准（`build()` 走满编原样）；调了 `adjust()` 不传参 → `excludeMarched=true` 排除在途；`adjust({ignoreMarched:true})` → `excludeMarched=false`。`ignoreMarched` 只在 `adjust` 之后才有意义；`adjust` 只记意图，实际重算延迟到 `build()`（避免与装载顺序打架）。

**索引基差**：链式 `preset()` 对外 1 起（内部自动减 1 转成 PresetMarchController 的 0 起 index）；历史上函数式 `buildPresetRaw` 需调用方手动 `index - 1`，是经典 off-by-one 源——该函数式入口现已收敛进链式（见 §3.2）。

### 3.2 函数式 API（已移除）

对外只剩 `Battle` 类一条入口，`export const battle` 已整体删除：
- `buildPresetRaw`（函数式满编快照）→ 用 `plan().preset(n).build()`（不调 `adjust` 即满编原样）；
- `toBattlePos` / `liveRecalcOk` → 代码层从无 feat 消费，只是控制台调试面，连同 `window.pocketcc.battle` 注入一并删除（`toBattlePos` 仍作模块内私有函数供投影编码用）；
- 更早的 `query` 只读查询面 → 需戳 `getAvailableArmyNum` 等值时直接用游戏符号（`pocketcc.game.get('DataCenter').DATA.UserData`）。

### 3.3 组合矩阵（全集）

| 链式调用 | 行为 | 场景 |
|---|---|---|
| `plan().minimal().build()` | 最低级 1 支，不查额度 | 快速派兵 |
| `plan().minimal().adjust()...build()` | 与 `minimal().build()` 等价——adjust 对 minimal 无意义（不查额度也不重算） | 无差别（不应这么写） |
| `plan().preset(n).build()` | 预设满编原样，不 filter 不重算 | 快照/原样发包 |
| `plan().preset(n).adjust().build()` | 重算容量 + 排除在途 | **普通派兵** |
| `plan().preset(n).adjust({ignoreMarched:true}).build()` | 重算容量 + 全量池不排除 | **活动派兵**（卡车掠夺等） |
| `plan().build()` | 未指定来源 → 派空 | 防御态 |

## 4. 场景用法

```js
import { Battle } from '../../core/battle.js';

// 1) 快速派兵：占位凑数、低成本试探——不碰重算器，发 1 支最低级兵
const fast = new Battle().plan().minimal().build();

// 2) 普通派兵：真实出征（战争之源/联盟 BOSS/奉旨出征/自动下田/快捷攻击…）
//    兵按在家可派池钳制、英雄按可派遣名单截断、军阵名额扣减、逐格容量重算
const normal = new Battle().plan().preset(order.preset).adjust().build();
net.sendPBV2(902, { armyListNew: normal.armyListNew, heroList: normal.heroList, /* ... */ });

// 3) 活动派兵：卡车掠夺这类快照战斗——目标不消耗真实行军池，
//    在途兵照常计入载荷，但每格容量走真实重算
const event = new Battle().plan().preset(presetIdx).adjust({ ignoreMarched: true }).build();

// 哨兵：任何路径失败都收敛为派空而非 null，发送前查部队数即可
if (!troop.armyListNew.length) return;   // 无兵可派 / 预设不存在 / 资格校验后已全外派
```

英雄释放时机类的「暂不可派」判断不靠本模块重试——`presetHasHeroes` 给调用方区分「预设故意无英雄」与「英雄尚未释放」（见 §6-2）。

## 5. 数据流与降级

```
plan() 持有 raw 完备集 #data（armyInfo[grid pos]/heroIds/formationV2/extraRaw）+ 校准意图 #recalc
── 装载（覆盖式互斥，二选一）──
  .preset(n)  → loadPreset：读 PresetMarchController.getPreMarchByIndex(n-1, type)，原样入集（grid pos，未编码不重算不过滤）
  .minimal()  → loadMinimal：UserData.userArmyForEach 挑 Normal&&CanBattle 中最低级 1 支放 grid0
  .adjust(o)  → 只记 #recalc={excludeMarched}，不动数据（延迟到 build，避免顺序陷阱）
── build() 单点投影 ──
  #data 为 null（未选源 / 读失败）          → emptyMarchData() 派空
  source==minimal 或 无 #recalc             → projectRaw()：满编原样，此时才 toBattlePos 编码
  preset + #recalc，battlePreset.ok()       → recalcData()：整份交重算器（checkMarch=excludeMarched），结果与预设 Num 取小、按 pos 找回原条目带回 skinId/heroCap
        └ 排除口径下本地兜：军阵在途置 0（重算器不纠正非法/在途军阵）
  preset + #recalc，重算不可用              → excludeMarched ? filterFallback()（手写过滤，容量用预设 Num） : projectRaw()（满编降级）
```

完备集内部一律存**编码前的 grid pos**，战斗位 `toBattlePos` 统一在投影时做——避免重算器（要 grid pos）与请求字段（要编码 pos）口径打架。

**降级矩阵**（触发条件：`battlePreset.ok()` 为 false 或 `recalc` 返回 null——符号漂移 / subpack2 未接管）：

| 调用口径 | 降级行为 | 与首选路径的语义差 |
|---|---|---|
| `preset().adjust()`（普通） | 手写 `filterArmys/filterHeroIds` + 军阵在途置 0 | **排除在途仍在，容量校准丢失**（用预设 Num） |
| `preset().adjust({ignoreMarched:true})`（活动） | 退回 `buildPresetRaw` 满编 | 容量校准丢失（不排除本就非 filter） |
| `preset()` / `minimal()`（不校准） | 无降级可言（本就不依赖符号） | — |

## 6. 坑与边界

1. **索引基差**：`plan().preset(1)` 是 1 起的队伍号，内部自动减 1 转成游戏 0 起 index。历史上函数式 `battle.buildPresetRaw(0, 0)` 需卡车 `probeSelf` 手动 `presetIdx - 1`；该函数式入口已收敛进链式，调用点不再手减。
2. **`presetHasHeroes` 不是请求字段**：10019 回城后英雄的释放推送可能晚于兵池刷新，此时普通派兵会得到 `heroList:[]`。调用方用 `troop.presetHasHeroes && !troop.heroList.length` 识别「英雄尚未释放」，选择等待而非发出无英雄弱旅。
3. **minimal 故意不看是否在外**：`findLowestLevelAvailableArmy` 只按 `Normal && CanBattle` 选、不查在途额度，选出的 1 支可能恰已全派在外——快速派兵本就接受这一点（发出去由服务器按额度拒绝）。曾为它写的 `adjustMinimal` 排空补偿（`minimal().adjust()`）因属过度设计已移除，`adjust` 从此只对 `preset` 源有意义。
4. **重算器不纠正非法/在途军阵**：实证乱填 formationV2 会原样保留，故排除口径下本地再兜一层 `isFormationMarching → 置 0`；活动口径（ignoreMarched）**不兜**，军阵名额直接由池来源（满额 vs 剩余）决定。
5. **卡车 probeSelf 的同源分母**：999 战力评估的输入（`plan().preset(presetIdx).build()` 满编快照，不 `adjust` 不重算）必须与掠夺出征载荷、面板展示数值同源，否则战力预估与实际不符。truck 的 `buildTroop` 现在走 `plan().preset(idx).adjust().build()`（普通派兵口径）——掠夺若实为快照战斗，两者存在「分母满编 / 载荷已排除」的口径张力；如需统一，改 `buildTroop` 为 `adjust({ignoreMarched:true})` 即可（probeSelf 保留满编 raw 作分母不受影响）。此处按目标语义单独决策，别顺手改。
6. **默认不校准 ≠ 安全**：`.preset(n).build()` 满编直发，兵全在途时会重复派已在外的兵（服务器侧按 armyId 额度拒绝或半接受）。除非目标不占真实行军池或有意发快照，否则普通出征一律 `adjust()`。
7. **`recalc` 是本地同步调用**，不是网络请求。「快速派兵省开销」省的是游戏重算器的聚合计算与运行时依赖面，不是 RTT——别按网络语义给它加超时/重试。

## 7. 调试面

battle.js 不再挂 `window.pocketcc.battle`（旧 `buildPresetRaw`/`liveRecalcOk`/`toBattlePos` 三个调试入口已随 `export const battle` 一并删除）。要在控制台验证造数，临时 `import { Battle }` 后组链 `new Battle().plan()...build()`，或直接在 feat 代码里跑。

日志 `[POCKETCC://BATTLE]`：`preset#N(type=T) live-recalc -> X/Y slots, hero=H, formationV2=F, extra=E` 一行可对照面板。

## 8. 变更记录

| 日期 | 变更 |
|---|---|
| 2026-10-05 | **删除函数式导出面 `export const battle`**：满编快照 truck `probeSelf` 迁到 `new Battle().plan().preset(presetIdx).build()`（与原 `buildPresetRaw(presetIdx-1,0)` 等价，去掉手动 `-1`；读失败由 `null` 变 `emptyMarchData()`，被调用点 `!raw.armyListNew.length` 守卫一并吃掉）；`toBattlePos`/`liveRecalcOk` 无 feat 消费仅调试用，连同 `buildPresetRaw` 与 `window.pocketcc.battle` 注入一起删除（`toBattlePos` 降为模块内私有）。对外只剩 `Battle` 类。构建通过（content.js 851.5kb）。 |
| 2026-10-05 | **改为「raw 数据完备集 + 单点投影」模型**：`MarchPlan` 从「`#source`/`#adjust` flag + `build()` 四路分派 + 多个独立 builder」重构为持有 `#data`（完备集，存编码前 grid pos）+ `#recalc`（校准意图）；`preset()`/`minimal()` 变覆盖式装载（`loadPreset`/`loadMinimal`），`build()` 单点投影（`projectRaw`/`recalcData`/`filterFallback`），`toBattlePos` 编码统一推迟到投影时做；`adjust()` 改为只记意图、延迟到 `build` 执行（防顺序陷阱）。删除函数式入口 `buildFromPreset`/`buildMinimal`（收敛进 `MarchPlan`），`battle` 仅留 `toBattlePos`/`buildPresetRaw`/`liveRecalcOk`。行为不变，`Battle`+`plan` 链公开契约不变，9 个 feat 调用点零改动；同步 content.entry.js 调试注释。 |
| 2026-10-05 | **去除过度设计**：删 `adjustMinimal` 函数与 `minimal().adjust()` 组合（为「最低级 1 支恰全在外则排空」这个边角场景单独养一个绕的函数不值）；`adjust` 从此只对 `preset` 有意义（对 minimal 静默无作用）。minimal 只发最低级 1 支、不查额度（快速派兵语义）。 |
| 2026-10-05 | **原地瘦身（不改行为）**：删无消费者的 `query` 聚合面、`getTotalArmyNum`、`MECHA_STATE` 枚举（塌成 `MECHA_CAN_FIGHT=3`）与 `battle` 导出的 `PRESET_TYPE`；`isFormationMarching` 内联掉 `formationCtl`；抽 `readPreset` 消除 `buildFromPreset`/`buildPresetRaw` 重复的预设读取头；头注释与 `recalcFromPreset`/`MarchPlan`/`Battle` 的多段设计注释压缩并指向本文档（代码 629→约 510 行）。外部契约（`Battle` + `battle.buildPresetRaw`）不变，9 个 feat 调用点零改动。 |
| 2026-10-05 | **三场景 API 落地（未提交，工作区）**：`MarchPlan` 默认极性翻为「不校准」，新增 `adjust(opts)`（`{ignoreMarched:true}` → `checkMarch=false`）；`build()` 四态分派（minimal / minimal×adjust / preset raw / preset+adjust）；`recalcFromPreset`/`buildFromPreset` 透传 `excludeMarched`；新增 `adjustMinimal`；`buildPresetRaw` 补齐 `trapList/presetHasHeroes` 统一 MarchData 形态；降级按口径拆分（活动降级=满编 raw）。同步给全部普通派兵调用点补 `.adjust()` 保持行为不变：truck-intercept `buildTroop`、source-of-war/attack、alliance-boss、imperial-decree、auto-farm、quick-attack。 |
| 2026-10-03 | `a04e874` Phase3：`utils/battle.js` → `core/battle.js`。 |
| 更早 | 引入实时重算器首选路径（`recalcFromPreset`）、`liveRecalcOk`、`buildPresetRaw`（卡车快照场景）、`buildMinimal` 动态选最低级兵（移除硬编码 `MINIMAL_ARMY_ID`）、链式 `MarchPlan`。 |
