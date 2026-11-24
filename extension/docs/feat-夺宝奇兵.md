# 夺宝奇兵（CS-HUNT）feat 设计方案

> 依据：协议/状态机全量实证 + 本次对事件面板/技能面板/组队面板/战斗装配源码的逐行核验。
> 目标：把用户口头设计转成「决策完备、可直接开工」的 feat 方案；对每条业务断言标注**源码证据**与**待真机确认项**。

---

## 0. 源码核验结论（逐条对齐用户描述）

| 用户断言                                                        | 核验结果                                                                                              | 证据（文件 · 行为）                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 有夺宝次数，定时恢复 1 点，上限 5                               | ✅ **真机实测坐实：上限 5、恢复 10h/点**（config 驱动，代码仍不写死）                                 | `RealCSHuntController` 构造持 `huntCount`/`lastRecoverTimeMill`；推送 21375 `updateUserCrossTreasureChange` 写 `huntCount=count.toNumber()`+`lastRecoverTimeMill`；`huntCount<=0` 阻断创建/出征。次数文案 `cs_treasure8 "{0}/{1}"` 第二参取 `DATACONFIG 290004`（=上限，**真机实测 '5'，见 §9**；另 290005='36000'=恢复 10h/点亦实测——早期"离线不可读死值"口径已被真机 dump 推翻）。恢复周期为服务器推算，插件只读 `huntCount` |
| 次数不够用"定位信标"补                                          | ✅ **定位信标 = 道具 itemId `47001001`**；自动化由配置项 `useBeaconWhenShort` 承接（见 §2/§3.1/§3.2） | `CSTeamJoinPanel.onBtnClickToCreate`：`huntCount<=0` 时提示 `cs_treasure318`，再 `getItemAmount(47001001)`，>0 则开 `ItemNumUsePanel({itemId:47001001,…})` 消耗信标换次数                                                                                                                                                                                                                                                      |
| 队长必耗 1 次                                                   | ✅                                                                                                    | 创建队 `sendCreateTeam(specId)`→7521 前硬性 `huntCount>0`；服务器在成行时扣队长次数                                                                                                                                                                                                                                                                                                                                            |
| 队员可选"不需要奖励"→不耗次数（陪跑）                           | ✅ **陪跑 = 成员 `help` 布尔位；切换走 7520**                                                         | `isHelp(uid)` 读 `team.member[i].help`；`CSTeamJoinPanel.sendTeamUseItem` 发 `CROSS_TREASURE_TEAM_USE_ITEM(7520){op:要奖励?1:2}`；`onRewardToggleChange` 仅在 `huntCount>0` 才允许切"要奖励"（切陪跑不受次数限制）                                                                                                                                                                                                             |
| 组队最多 5、最少 2 才跑                                         | ✅ **主表实测 max_ppl_num=5 / min_ppl_num=2**                                                         | `updateTeamItem` 按 `cross_treasure[cfg].max_ppl_num` 渲染槽位（真机 dump 实测 5）；`min_ppl_num=2` 亦表实，服务器另校验（290003='2' 疑似同源）                                                                                                                                                                                                                                                                                |
| 场景"密码大爆炸"，密码 5 位，各玩家见一部分，需频道互报后还原   | ✅                                                                                                    | `CSHuntEventCodeBox`：`eventCodeBoxInfo.codeNum[]`，**数组长度=密码位数**（本活动=5），元素 `-1`→显示 `"?"`（本玩家不可见位）、非 `-1`=本玩家可见的正确数字位；补全未知位后 `onBtnClickOpenBox` 发 `CROSS_TREASURE_EVENT_CODE_BOX_UNLOCK(7537){crossTreasureEventCodeBoxUnlock:{treasureId,round,codeNum:[全填数组]}}`；`uidWinMap[UID]` 记本玩家是否破译成功                                                                  |
| 玩家可能输错、可重输；聚合出多组就都试一次                      | ✅（协议支持重试）                                                                                    | 7537 应答 `e4.s!==0` 时 `initPassWord()` 重置，可再次提交；插件侧对每组候选密码逐条发 7537（受单事件时间窗约束）                                                                                                                                                                                                                                                                                                               |
| 陪跑拿不到奖励、部分场景无法交互                                | ✅（已证两处，余待核）                                                                                | `CSGetTreasurePanel`/`CSHuntGetRewardPanel`：`isHelp()` 时文案转 `cs_treasure316`、`protectedBtn/_isCanSelect` 关闭；`CSHuntEventCodeBox.playOpenBoxAni` 在 `isHelp()` 时 win/fail 节点双双置灰(opacity 78)且不播奖励缩放动画。**defPVE/dice 等其余场景的陪跑不可交互清单待真机逐个确认**                                                                                                                                      |
| 部分技能仅队长用、部分仅队员用                                  | ✅ **`cross_treasure_skill.group===1` = 队伍技能，仅队长可用**                                        | `CSHuntGetSkillPanel.onBtnClickUse`：`1===group && !isTeamLeader()` → 提示 `cs_treasure280`（"队伍技能统一由队长统筹使用，可在聊天处交流使用时机"）；`teamSkillInfoList` vs `personalSkillInfoList` 分背包两栏                                                                                                                                                                                                                 |
| 先知技能在"选场景一开始"用、仅队长用                            | ✅ **名+specId 均坐实=预料先知（specId 9，type 5，group 1 队伍技能）**                                | 字典 `cs_treasure217=预料先知`，表行 `des_key_para="0                                                                                                                                                                                                                                                                                                                                                                          | 3"`/`param1=3`=预告 3 个事件，与文案「可提前查看{0}个事件内容」吻合；`type===MING_BRAND(5)` 阶段门吻合；group=1 队长专属坐实 |
| 幸运技能（=科技「幸运降临」），按奖励物品决定是否开启取最大收益 | ✅ **名+specId 均坐实=幸运降临（specId 18，type 10，group 2 个人技能）**                              | 字典 `cs_treasure222=幸运降临`，效果文案 `cs_treasure236='使用后，下一次您所获得的奖励将会变成2倍。神器除外'`——**"翻倍"是效果不是名**；生效文案 `cs_treasure331`；group=2 意味着**队员个人可用**（非队长专属）；时机口径（用户更正定稿）：rollDice 场景**掷骰前即可见奖励物品**，幸运与 pickReward 同构、动作前判定（见 §5.3）                                                                                                 |
| 复制技能可复制任一已有技能，优先复制先知                        | ✅ **COPY(type=12) 可复制任意非 COPY 技能**                                                           | `onBtnClickUse` `type===COPY`：把 `teamSkillInfoList+personalSkillInfoList` 过滤掉 `type===COPY` 自身，空则提示 `cs_treasure365`（"暂无可复制的科技"），否则开 `CSHuntSelectSkillPanel` 选目标→`sendUseSkill({param:{copySkillSpecId}})`。"优先先知"是**策略层**选择，非代码约束                                                                                                                                               |
| 玩家来袭才响应保命，需与活动怪物来袭区分                        | ✅ **玩家来袭=FIGHT 掠夺；怪物=PVE 事件**                                                             | 玩家来袭：`csHuntInfo.status===FIGHT` 携带 `fightInfo`，`lootMarchNum`（推送 21383 `HURT_MARCH_SIZE` 直写）+`lootPlayerInfos`（真人头像），掠夺成功推送 21379 `REWARD_CAN_LOOT`→`showRobSuccPanel`。怪物来袭走 `defPVE` 事件（marchType `CROSS_TREASURE_EVENT_PVE=142`、目标 `CROSS_TREASURE_EVENT_PVE_MONSTER=135`），**二者须按 status/事件类型分流，勿混**                                                                  |

**可行性硬结论（插件侧）**：

- `window.pocketcc.net` 已暴露 `sendPB / sendPBV2 / send / isSending`——7xxx PB 命令可直接调用。
- 出征 7519 走 `NET.send(RequestId.CROSS_TREASURE_TEAM_MARCH, {marchType:137, armyList, armyListNew, heroList, trapList, formation, formationV2, extraArmy})`（**满编、无 x/y**，非 sendPB、非 902）；`utils/battle.js` 的 `plan().preset().adjust().build()` 产出 5 字段 MarchData 可直接喂入，需新增一个 7519 发送动词（`march.attack` 现走 902）。

### 0.1 科技使用闸门实证（`CSHuntGetSkillPanel` · 2026-10-17 逆向定稿）

用户三条「何时能用 / 能用几次」的诉求，逐条命中游戏客户端代码——**权威判定在服务端（应答 `errorKey`），客户端只做阶段门 + 按钮置灰 + 背包/生效两栏搬运**：

**① 阶段门 `checkSkillIsCanUse(row)`（逐字）**：

- `先知(MING_BRAND=type5)`：仅 `csHuntInfo.status===EVENT && eventInfo.status==='decide'`；
- `全量刷新(REFRESH_SKILL_SELECT=type13)`：仅 `eventInfo.status==='event'` **且** 当前 `cross_treasure_event[eventSpecId].type===PICK_SKILL`；
- **其余全部科技（幸运/盾/隐身/闪现/转换/COPY…）直接 `return true`**——无阶段限制。
  → 引擎 `skills.js#canPhase` 已等价（先知仅 decide、刷新仅 event），刷新的 pickSkill 子判由场景路由（fam 1004 才进 pick-skill）天然保证。

**②「只能用一次 / 逐个用」不是计数器，是背包→生效两栏搬运**（报文实证主跑趟实录：用闪现 11）：

```
用前  team:[{10},{11}]  personal:[{18}]  pending:[]
7551  {skillSpecId:11}
用后  team:[{10}]       personal:[{18}]  pending:[{11}]   ← 11 从背包移进「生效中」，效果结算后彻底消耗
```

- 面板把 `skillPendingEffectInfoList` 渲染为「生效中」栏，**选中项来自该栏 → 使用按钮 `interactable=false` 置灰**（`updateCurSkill` 末行）。
- 故「先知一个 decide 一次」「幸运下次奖励前一次」「盾/隐身不叠同一效果」= 同一机制三种表象：用完进 pending、没牌/被置灰、生效期同一效果不重施。
- **数量 = 同一 specId 在背包栏出现几条**（平铺、**无 count 字段**）→ 引擎读态由 `Set` 改 `specIdCount`→`Map<specId,张数>`；新增 `#pending`（取自 `skillPendingEffectInfoList`）。
- 落地谓词分工：`#canUse(id)=张数>0(+队长)`（纯持有，scene 侧 ctx.canUse 用它）；`#usable(id)=#canUse && !#pending.has(id)`（自动策略/幸运/镜像/保命/末回合统一走这条，天然实现「生效中不重施、下次奖励前不重发幸运」）。

**③ 使用面板 `onBtnClickUse` 分派 → 7551 payload 形态（param 键名全部坐实）**：

| 类型                             | specId           | payload                                                                                                         |
| -------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------- |
| 默认（幸运/盾/隐身/闪现/转换等） | 18/2/26/10/11/24 | `{treasureId, skillSpecId}`                                                                                     |
| **完美镜像 COPY**                | 22               | `{skillSpecId:22, param:JSON.stringify({copySkillSpecId:目标})}` ← 键名得证（此前为推测）                       |
| **安全锁定 PRECTED_REWARD**      | 17               | 弹 `CSHuntGetRewardPanel` 选奖励 → `param:JSON.stringify({protectRewardIdArr:[id…]})`（待实现，需选奖励子面板） |
| **火线急救 RISE_PLAYER**         | 27               | 弹 `CSHuntSelectPlayerPanel` 选玩家 → `tarUid:Int64串`、param 空（待实现，需选玩家子面板）                      |
| group=1 但非队长                 | —                | 提示 `cs_treasure280`，不发                                                                                     |

> COPY 复制目标（引擎 `chooseCopyTarget`）产品口径：先知张数 `<` 剩余回合→复制先知；先知 `<` 够用且有幸运→复制幸运；无可用先知→**本轮不复制（宁可等待）**。剩余回合=`ROUND_MAX-round+1`。

### 0.2 DECIDE 选场景的轮值闸与时间窗（报文实证陪跑趟实录 · 2026-10-17 定稿）

游戏把每回合的场景选择权**轮流分给一个队员**（字段 `eventDecideInfo.uidDecide`，Int64）；非轮值者发 7532 一律拒（`s:3, d:cs_treasure371`「当前阶段不可操作」）。

10 个回合的插件发包对拍（同一跑、插件为队员非队长）：

| round | uidDecide 归属 | 插件 7532             | 应答                                                         |
| ----: | -------------- | --------------------- | ------------------------------------------------------------ |
|     1 | **我**         | ✅ 发 → 20.06s 撞上限 | **s:0**（server 抢到自决前到位）                             |
|     2 | 队友           | ❌ 盲发               | **s:3**                                                      |
|     3 | **我**         | ✅ 发 → 20.02s        | **s:0**                                                      |
|     4 | 队友           | ❌ 盲发               | **s:3**                                                      |
|     5 | **我**         | ✅ 发 → 20.03s        | **s:0**                                                      |
|     6 | 队友           | ❌ 盲发               | **s:3**                                                      |
|     7 | **我**         | ✅ 发 → 20.02s        | **s:3**（server 提前 SHOW+auto-decide idx=5，插件迟交 15ms） |
|     8 | 队友           | ❌ 盲发               | **s:3**                                                      |
|     9 | **我**         | ✅ 发 → 20.01s        | **s:0**                                                      |
|    10 | 队友           | ❌ 盲发               | **s:3**                                                      |

→ 两个真 bug：

1. **非轮值也盲发**：旧代码不看 `uidDecide`，10 回合全发；6 次被服务器 s:3 拒（浪费包 + 日志污染）。
2. **无先知就硬撞 20s**：陪跑背包没 `group=1` 先知（队长专属），`eventSpecIdList` 在 play 态恒 `[0,0,0,0,0,0]`，旧逻辑 `rev.length===0 && !overWindow → 不发`；只能等 `overWindow` 兜底发，正好卡在服务器 20s auto-decide 边界（r=7 就被抢先）。

**修正方案**（已落地 `engine-flow.js#handleDecide`）：

- **emit 前置轮值闸**：`bits.int64Str(edi.uidDecide) !== gameData.myUidStr()` 则整段 return（不发 7532、不加 `#done`）；服务器只放行轮值者。
- **play 态到下限即立选**：新增 `atFloor = elapsed >= DECIDE_MIN_MS`；分支条件放宽到 `atFloor || overWindow`——有揭示按 `chooseProphet`、无揭示按 `fallbackIndex`（全 0 时回 1）；10s 足够等队长先知揭示的 21376 落地广播，不再拖到 20s 撞窗。
- **转场串联不受轮值影响**：`#sequencingSkills` 仍在轮值闸**之前**执行（先知/复制/转换对全队受益，即使本回合不轮我选，队长开先知揭示的 3 位也进 `eventSpecIdList` 供我下回合用）。

---

## 1. 总体架构

沿用项目 feat 框架（reactor 生命周期 + createCycle + drain + push 订阅 + per-UID 存储 + 日志分级），采「**一 spec + 多动作文件**」拆分：

```
feats/activity/cs-hunt/
  spec.js          # 菜单/面板描述符、配置 schema、places 门控
  engine-team.js   # 队长/队员双角色的组队·召集·出征编排（事件驱动为主）
  engine-event.js  # 状态机 → 6 类场景分派（事件表已实证 6 个 type 族，见 §9）
  engine-event.js  # 状态机 → 6 类场景分派 + 事件侧技能（先知/幸运内联，本期未单拆 engine-skill.js 以免与事件引擎循环依赖）
  codebox.js       # 直读 codeNum 穷举未知位（纯函数，可单测；报文实证恒 1 掩码、无需频道聚合）
```

### 1.1 生命周期与门控

- `install(ctx)`：`net.install()`；`game.requireAll(['CSHuntController'])` 拿单例；校验关键符号（`CSHuntController.getInstance`、`cross_treasure` 表可读、`net.sendPB`）；缺任一回退并 `log.warn`。
- `configure`：从 spec 描述符建面板；载入 per-UID 配置（模式、人数阈值、队员池、技能优先级、幸运白名单）。
- `run(ctx)`：复位运行时状态 → 挂 push 订阅（下表）→ 主动 `CROSS_TREASURE_INFO(7501)` 拉一次 → 武装 createCycle 兜底。`pause`→`alive()=false` 自然停摆；`resume` 重新点火。
- **places 门控**：夺宝主循环在**跨服世界地图**（`tInfo.sid` 目标服），出征前在 Home/NWorldMap；scene-watcher 判定 `base/world`，跨服镜头跳转期间只读不重派。

### 1.2 驱动模型：push 唤醒为主 + createCycle 兜底

夺宝是**强状态机、推送驱动**玩法，绝不纯轮询。订阅并汇入统一 `dispatch(push)`：

| 推送                          | 用途                                         |
| ----------------------------- | -------------------------------------------- |
| 21371 TEAM_CHANGE             | 队伍状态跃迁（含 ARRIVE 清态）               |
| 21372 READY_CHANGE            | 出发召集弹窗，驱动队员 ready                 |
| 21373 MEMBER_CHANGE           | 成员增删改（维护池匹配）                     |
| 21374 APPLY_CHANGE            | 入队申请（队长按池审批）                     |
| 21376 HUNT_INFO_CHANGE        | **状态机主推送**：驱动场景分派/LOOT/FIGHT    |
| 21379 REWARD_CAN_LOOT         | 掠夺成功                                     |
| 21383 HURT_MARCH_SIZE         | `lootMarchNum` 变更（**玩家来袭信号**）      |
| 21384 REWARD_MULTIPLE         | 幸运降临生效（确认下一次奖励翻倍，神器除外） |
| 21385 GRAIL_SELF_INFO         | 圣杯自身信息（本 feat 只读）                 |
| 10912 PUSH_ONE_ACTIVITY_EXTRA | 活动 extra 变更（可选，触发 7501 重拉）      |

createCycle 兜底档：活动进行中 `active` 短间隔仅做**只读状态核对**（7501/7531）；空闲 `idle` 长间隔。所有唤醒汇入 `cycle.kick()`，一轮在飞只置 pending，结束补一次（合并多条推送）。

---

## 2. 配置面板字段（per-UID 存储）

```
mode            : 'auto'            // 角色自动判定：isTeamLeader()→队长，否则队员
targetMemberNum : 5                 // 凑够此人数队长即开车（≤ max_ppl_num，下限由服务器判）
rolePool        : [ {uid, name, prefer:'leader'|'member'|'both'} ]   // 队员池
needRewardAsMember : false          // 队员默认是否要奖励（false=陪跑，省次数；true 仅在 huntCount>0 生效）
useBeaconWhenShort : false           // 勾选：次数不足(huntCount<=0)时自动消耗定位信标(itemId 47001001)补次数；适用两处：队长建队前、队员切「要奖励」前。未勾选则照旧跳过并 info 一次
presetPool : [1]                     // 派兵来源：从游戏预设队伍选取（战斗预设段 1-8，7519 满编出征用）；按序遍历取第一个能出兵者（对齐 auto-hunt/惧星 buildPlanFromPool 语义），面板勾选取自当前预设列表
skillPriority   : [skillSpecId...]  // 技能获取/使用优先级（pickSkill 选位 + 主动使用顺序）
scenePrefer : ['rollDice','pickSkill']  // 队长 DECIDE 策略（用户口述 2026-10-16）：先知探到 rollDice（这把我最大）首选，次选 pickSkill（科技）；都没出 → 选未探测到的候选赌一把
luckyRewards        : {pickReward:[itemId…], rollDice:[…], codeBox:[…], defPVE:[…]}  // 按场景分组的幸运勾选：某场景可见奖励命中「该场景勾选项」时开「幸运降临」（下一次奖励翻倍，神器除外）；该场景一勾全无=不参与判定
luckySkillSpecId  : 18               // 「幸运降临」（type=10，group=2 个人技能）✅ 真机表定稿
prophetSkillSpecId: 9                  // 「预料先知」（type=5，group=1 队长专属）✅ 真机表定稿
defenseSkillIds : {shieldA:2, shieldB:26, stealth:10, randomMove:11}  // 保命 ✅ 真机表定稿：2=铜墙铁壁(回合盾) 26=毫发难伤(战斗盾) 10=动态隐形(60s) 11=自由闪现；**均 group=1→仅队长可用**；另：复制=22 全量刷新=23 安全锁定=17 火线急救=27 数据转换=24（整表见 §9）
useAllSkillsAtLastRound : true       // 末场景(round==round_max)清空可用技能
copyPreferProphet : true             // COPY 事件优先复制先知
autoSolveCodeBox : true              // 密码大爆炸自动求解+广播
```

> `skillPriority`/各 specId 面板提供"从当前背包 `cross_treasure_skill.name`（LOCAL 解析中文名）勾选"的辅助下拉，避免用户手填数字；specId 一经选择即存 per-UID。

---

## 3. 组队编排（engine-team.js）

### 3.1 队长（isTeamLeader()）

```
1. 无队 → 检查 huntCount>0；为 0 时按 `useBeaconWhenShort` 分支：勾选且信标(47001001)库存>0 → 消耗信标补次数（过渡期走 `ItemNumUsePanel` 链路，§7-6 实抓后改直发包；每次消耗前 info 留痕含剩余库存），等应答/推送刷新后复查；未勾选/库存空/补后仍 0 → info 一次+当日拉黑。达标才 sendCreateTeam(specId)  [7521]
2. 订阅 21374 APPLY_CHANGE：申请者在 rolePool 内 → getTeamApplyList(7528) 复核 → CROSS_TREASURE_TEAM_APPLY_OP(7523) 通过；池外 → 拒绝/忽略
3. team.member.length 达 targetMemberNum 且全员派兵到位（每成员 marchId 非零）→ CROSS_TREASURE_MARCH_START(7527){op:1} 召集出发
4. 全员 ready（21372 反馈）→ 队长自身先满编出征入队 7519（见 §3.3）
5. 订阅 21371：status→MARCHING 后进入场景主循环
```

### 3.2 队员

```
1. 无队 → 轮询 TEAM_LIST(7526)/SEARCH_TEAM_LIST(7530) 找「池内 prefer=leader/both 且未满」的队长队
2. sendTeamApply(teamId,1) [7522] 申请；等 21373 加入成功
3. 加入后按 needRewardAsMember：若要奖励且 huntCount>0 → TEAM_USE_ITEM(7520){op:1}；若要奖励但次数不足且 `useBeaconWhenShort` 勾选 → 先走信标补次数链路（同 §3.1 步骤 1），补失败则降级陪跑{op:2}加入（不浪费加入时机）；其余保持陪跑{op:2}（默认）
4. 收 21372 READY_CHANGE（队长召集）→ MARCH_START(7527){op:1} 同意（配置可自动，或按面板开关）
5. 满编出征入队 7519（见 §3.3）
```

### 3.3 满编出征（两角色共用）

```
selfMarchId = getSelfMarchId(); 已有在途且非零 → 跳过（cs_treasure63 语义）
for n of cfg.presetPool:                                   // 按序遍历预设（1-8 战斗段）
  armys = new Battle().plan().preset(n).adjust().build()   // adjust 已排除在途兵；复用 utils/battle.js
  if (!armys.armyListNew.length) continue                  // 该预设兵全在外 → 下一个
  if (armys.presetHasHeroes && !armys.heroList.length) continue  // 配了英雄但未释放 → 下一个
  break
无可用预设 → **不发空兵 7519**，info 留痕 + 等回城唤醒补派（对齐 ctx.on.push 唤醒惯例，不纯轮询）
net.send(RequestId.CROSS_TREASURE_TEAM_MARCH=7519, {
  marchType:137, armyList:armys.armyListNew, armyListNew:armys.armyListNew,
  heroList, trapList, formation, formationV2, extraArmy?
})
```

> **selfMarchId 零值守卫**（报头实证实录报文）：`bits.int64Str(Long(0,0))` 返回字符串 `'0'` 是 JS truthy，旧版误判为「已在行军」导致跳过 7519。修复后加 `&& t.selfMarchId !== '0'` 排除零值。仅非零 marchId 才代表游戏侧有在途行军。

> **队长召集出发的硬条件（用户口径）**：7527 由队长主动发起需**同时**满足①等待人数到齐（`memberCount >= targetMemberNum`）②全员完成出兵（每个成员 `marchId` 非零，即都派兵到集结点）；任一角色收到 21372 召集（或已在 ready 名单）后表态同意。旧「队长自己派完兵即召集、人数交服务端裁决」的口径已作废——它会在人未齐/队员未出兵时过早发 7527。
>
> **服务器实证（实录报文）**：真人队长在**自己尚未发 7519 派兵**时过早发 7527，被回 `code=3 d=common_159995`（约 +38.5s 失败）；直到 +133s 补发 7519 派兵后，+154.9s 再发 7527 才 `code=0` 受理。即 **7527 须待本队（含队长自身）7519 派兵落地后方可成功**——引擎 `tick` 步 4 的 `allMarched`（`marchedCount === memberCount`，其值来自 7519 经 21373/21371 回填的 marchId）闸天然满足此前置，规避了真人这个过早召集被拒。

> 与领域/海上夺宝的零部队 902 完全不同；机甲双条件、可派遣英雄、军阵在途判定沿用 `battle.js` 既有约定（同 auto-hunt 的多预设池语义）。预设选取属编队意图，存 per-UID；若队长已召集（21372）而本方无兵可派，受行军时间窗约束，错过即由服务器判定，不做本地倒计时猜测。

---

## 4. 场景主循环（engine-event.js）

按 21376 更新的 `csHuntInfo.status` 分派（对齐 `PBEnumCrossTreasureStatus` 七态）：

- `MARCHING/WAIT/END/RETURN` → 转场，无需动作，仅更新倒计时。
- `EVENT`：
  - `eventInfo.status===DECIDE`（选场景）→ **有先知先开先知（仅队长，play 态），再按 show 明文族偏好选：rollDice > pickSkill > …**（§5.2）。**报文修正**：`EVENT_DECIDE(7532){treasureId,round,indexDecide}` **每个成员都发**（陪跑趟 190507/192930 各发 5 次），`indexDecide` 是 eventSpecIdList 的 **1-based 下标**（实证 191700 round1 idx1→100201=实得 / round7 idx4→100302=实得）；`DECIDE_VOTE(7533)` **四趟皆 0，不实现**（队长独断现实模型）。
  - `eventInfo.status===EVENT` → 按 `cross_treasure_event[eventSpecId].type` 分派：
    - `pickReward` → `EVENT_PICK_REWARD(7534)`；命中 luckyItemWhitelist → 触发幸运降临科技（§5.3）。
    - `rollDice` → `ROLL_DICE(7535)`/`GIVE_UP(7536)`（按阈值）；奖励物品**掷骰前可见** → 命中 `luckyItemWhitelist` 可在掷骰前先开幸运再滚（§5.3）。
    - `codeBox` → §4.1 密码聚合求解。
    - `defPVE` → 怪物来袭 PVE（**非玩家来袭**，不触发保命技能）。
    - `pickSkill` → `EVENT_PICK_SKILL(7538){pos}` 按 `skillPriority` 选位。
    - `nothing` → 跳过。
- `FIGHT` → 掠夺战斗态；订阅 loot 变化触发保命（§5.4）。
- `LOOT` → 本人被掠夺战报；只读记录。

**loadEventNode 一致性**：游戏对乱序推送有状态校验，插件动作前须复读 `csHuntInfo.status`/`round` 与目标一致再发，避免打到过期轮次。

### 4.1 密码大爆炸（code-box.js，频道 17 汇总 + 穷举兜底）

本端直读 `eventCodeBoxInfo.codeNum[5]`，每位 `0..9` 明文或 `-1` 掩码。满编 5 人队时每位只见到 1 位（余 4 掩码），须频道 17 汇总；小队（2 人）时本端见 4 位、缺 1 位。

**流程**：

1. 本端视图 `viewToStr` 广播频道 17（每回合一次）；
2. 收队友视图 → `merge([own, ...peers])` 得汇总；
3. 汇总无未知位 → 直接提交；
4. **有未知位且等待未超 15s → 不穷举，本拍 return 等队友回复**（报头实证实录报文：旧版立即穷举首个候选填 0 导致错提）；
5. 超时 15s 后仍有未知位且 ≤2 → `solveCandidates` 穷举逐个提交（CODE_GAP 3.5s 节流）；
6. 未知 >2 → 放弃本回合。

`uidWinMap[本UID]=true` 即已中、停手。全员发（陪跑也解）。

---

## 5. 技能子系统（engine-skill.js）

背包快照来源：`SKILL_BACKPACK_OPEN(7550)`→`skillBackpack{skillPendingEffectInfoList, teamSkillInfoList, personalSkillInfoList}`，每项 `skillSpecId` 查 `cross_treasure_skill` 行读 `{group,type,close_after,name,…}`。统一发送动词 `sendUseSkill→SKILL_USE(7551){treasureId,skillSpecId,tarUid?,param?}`。

### 5.1 技能获取优先级（需求 3）

- `pickSkill` 事件：`skillSpecIdList` 与 `skillPriority` 排序对齐，发 `EVENT_PICK_SKILL(7538){pos=优先级最高项索引+1}`。
- 主动使用：按 `skillPriority` 顺序择一可用（过 `checkSkillIsCanUse` 阶段门）发 7551。
- **面板科技池 = 纯拖拽排序（无勾选）**（用户口径 2026-10-17）：`type:'sortlist'` 去 `checkable`/`offKey`，全量族代表项恒参与、只按拖拽序定优先级（越靠上越优先，取第一个可用）；旧 `skillPoolOff` 存档自然废弃。
- **陪跑引擎侧自动排除「只对领奖有意义」的科技**（`HELPER_EXCLUDE_SKILLS = 幸运降临18 + 安全锁定17`）：因陪跑拿不到奖励，两者一个翻倍奖励、一个保护奖励均无意义。排除落在 **`pickSkill` 选技（`chooseByPool` exclude + 随机兜底）** 与 **`#flushCandidates` 末回合清空** 两处（与拖拽顺序无关，主跑不受影响）。其余 group=2 个人技（固定增强/完美镜像/全量刷新/数据转换）属战斗或功能增益、与领奖无关，陪跑保留；所有 group=1 队伍技 `#canUse` 已要求 `isLeader()`，陪跑（永不为队长）本就用不了。
- **幸运降临的「溢出兜底」分三层**（用户口径 2026-10-17 定两层、2026-11-22 补中间一层，详见 §23）：幸运只在 rollDice 主动用（详见 §5.3），但背包到末回合仍有剩余（rollDice 机会不够、溢出）时，`#flushCandidates` 会把它作为普通可用科技无脑清空用掉（主跑幸运 18 不列入 `FLUSH_EXCLUDE`）。非末回合则靠有奖场景动作前提前烧 + FIGHT 相位场景无关补烧两道前置（§5.3/§23）。

### 5.2 先知 + 选场景策略（需求：选场景一开始、仅队长；策略为用户口述 2026-10-16）

- 先知触发：`eventInfo.status===DECIDE` 阶段之初，`isTeamLeader()` 且背包有先知（specId 9）→ 发 7532 决策**前**先 `sendUseSkill(9)`（`type===MING_BRAND(5)` 生效要求 `status===DECIDE`，天然吻合；`group===1` 仅队长可用）。
- **探测后的选择顺序**（配置 `scenePrefer`，默认如下）：
  1. 探测到 `rollDice`（这次我最大）→ 选它；
  2. 否则探测到 `pickSkill`（奇妙新科技）→ 选它；
  3. 都没出 → **选未被探测到的候选赌一把**（取未探测索引，多个时随机）；
  4. 兜底：已探测为 `nothing`（空冒一场险）的候选永不主动选。
- 无先知：不可探测，直接按默认位序选择（本质即赌）；不阻塞流程。
- 参数来源：探测个数读表 `param1=3`（不写死）；候选个数读主表 `event_decidable_num=6` → 先知覆盖半数，其余三个即"未探测"。候选列表载体已坐实（§9.4：`eventDecideInfo.eventSpecIdList[6]`，play 态全 0、**show 态才有明文，插件必须等 show 推送再动作**）；先知"哪 3 个被探测"的标记位仍未捕到（§7-8，需带先知复抓；过渡策略：show 明文直接按 scenePrefer 选，先知仅在探测集合不可得时作消耗项）。
- 决策时限：`event_decide_time=20s`（主表实测）——先知 7551 → 等应答 → 7532 全程必须在 20s 窗口内完成，先知使用后不等二次确认直接按探测字段出决策。

### 5.3 幸运降临取最大收益（需求 4；技能名是「幸运降临」，非「幸运x2」）

- 效果语义：`cs_treasure236='使用后，下一次您所获得的奖励将会变成2倍。神器除外'`——"翻倍"是该科技**效果**，科技本名为 **幸运降临**（`cs_treasure222`）。
- **幸运只服务 rollDice（用户口径 2026-10-17 定稿，推翻此前「四场景」模型）**：幸运降临只在「这次我最大」(rollDice) 场景主动使用，其余有奖场景（pickReward/codeBox/defPVE）**不再触发幸运**：
  - 面板 = **只渲染 rollDice 一组 `multiopts`（不再折叠、不再列其余场景）**，底层 `cfg.luckyRewards = {rollDice: itemId[]}`（normalize 只读 `luckyRollDice`，旧 `luckyPickReward/luckyCodeBox/luckyDefPVE` 即便存档残留也不读）。
  - 引擎 `#tryLucky(treasureId, sceneKey, rewardResult, label)` 首行硬闸 `if (sceneKey !== EVENT_TYPE.ROLL_DICE) return false`（单一真相，独立于面板/场景接线）；rollDice 再按 `cfg.luckyRewards.rollDice` 为空即跳过、非空看掷骰中奖奖励 ∩ 勾选。
  - 场景侧：`roll-dice.js` 保留 `tryLucky('rollDice', rdi.winRewardResult, …)`；`pick-reward.js`/`code-box.js` 删除 tryLucky 调用，`def-pve.js` 退化为无动作占位（同 `nothing.js`）。
- **溢出兜底分三层**：若一局里 rollDice 机会不足以消化背包累积的幸运（10 轮下来正好用光、甚至溢出），依次由 ① 有奖场景动作前的 `#tryLuckyOverflow`（2026-10-25）、② 非末回合 FIGHT 相位的族级溢出补烧 `DIGEST_OVERFLOW_SKILLS`（2026-11-22 纳入幸运 18，见 §23）、③ 末回合 `#flushCandidates` 无脑清空承接（幸运 18 不列入 `FLUSH_EXCLUDE`，主跑天然参与清空；陪跑三层均走 mode/HELPER_EXCLUDE 闸排除）。旧口径「例外只落在末回合清空这一条策略里」已被 §23 推翻——r9 持 2 张而 r9 不是有奖场景时，光靠末回合清不掉多余那张。
- 触发实现：读 `sendUseSkill` 后观察 21384 `REWARD_MULTIPLE_TAKE_EFFECT`（生效文案 `cs_treasure331='幸运降临科技生效，本次奖励翻倍'`）确认翻倍挂上，用 round+skillSpecId 去重避免重复触发。陪跑全程不持有幸运（幸运唯一来源 pickSkill 场景已对陪跑 `exclude=[SKILL_LUCKY]`），`#usable(18)` 天然 false，rollDice 的 `tryLucky` 对陪跑 no-op（且 roll-dice 本身 `!isMain` 早退）。
- "神器除外"落地：`grail_reward`（神器 47002001..）仅 rollDice 行携带——可见奖励为神器则**不开幸运**（翻倍无效还白耗技能）。
- **候选只取中奖奖励（win-only）**：面板 rollDice 组的候选 = 引擎喂给 `#tryLucky` 的 `eventRollDiceInfo.winRewardResult` 所能出现的 itemId。**`failRewardResult`（未中奖保底）与 `grail_reward`（神器）一律不作候选**：引擎只翻倍中奖奖励、幸运又「神器除外」，把保底/神器列进面板会是勾了永不命中的**死开关**（曾误把 rollDice 的 7 个 fail 保底项当候选，2026-10-17 报文逐字段复核后剔除）。
- **候选枚举源**：`csHunt.readRewardPool()` 现返回 `{id,name,scenes}`，只解 `cross_treasure_event` 各行的 **win 列**（不读 fail/grail），`scenes` 由事件行主键推得（`Math.floor(eventSpecId/100)`：1001 pickReward/1002 rollDice/1003 codeBox/1005 defPVE；1004 pickSkill 发科技、1006 nothing 空过不入池）；实时表取不到行主键致 scenes 空时回退静态 `LUCKY_GIFTS.scenes`（报文实证 11 趟**中奖奖励**路径，win-only）。
- **存档策略**：旧的全量 `luckyRewards`(order)/`luckyRewardsOff`、以及上一版按场景的 `luckyPickReward/luckyCodeBox/luckyDefPVE` 字段均已废弃、**不静默迁移**——`normalize` 只读 `luckyRollDice`。升级后 rollDice 组默认全不勾，用户按需重勾。

### 5.4 玩家来袭保命（需求 5）

```
来袭判定（关键区分）：
  响应：status===FIGHT && (lootMarchNum>0 或 lootPlayerInfos 非空)  —— 真人掠夺
        或推送 21383 HURT_MARCH_SIZE / 21379 REWARD_CAN_LOOT
  忽略：defPVE 事件（怪物来袭，marchType 142 / 目标 135）
动作（队长优先，team skill 由队长统筹）：
  背包内命中 defenseSkillIds → 按保命优先级：两种护盾(shieldA/shieldB) > 隐身(动态隐形) > 随机迁移(自由闪现)
  sendUseSkill(对应 specId)；一次来袭窗口每技能至多一用（specId+round 去重）
```

> **护盾有两种**（两个独立科技、各带各自 specId，不是同一护盾"x2"）：一为"下个**回合**完全抵御敌方的进攻"(`cs_treasure228`)、一为"下次**战斗**完全抵御敌方的进攻"(`cs_treasure341`)，生效文案还给出护盾科技实名 **毫发难伤**(`cs_treasure346='科技【毫发难伤】生效，该战斗被成功抵御'`)；隐身=动态隐形(`cs_treasure232`)、随机迁移=自由闪现(`cs_treasure233`)。活动内保命走活动技能 7551，**不复用**全局护盾道具路径（100132/101082 那条是基地护盾，语义不同）。

### 5.5 末场景清空技能（需求 6）

- 判定：`csHuntInfo.round === cross_treasure[cfg].round_max`（用户口径第 10 场景，实际以 config `round_max` 为准）。
- 动作：进入该 round 时，对背包内所有 `checkSkillIsCanUse` 通过的可主动使用技能（排除需特定事件门的 REFRESH_SKILL_SELECT/MING_BRAND，除非正处对应阶段）批量 `sendUseSkill`；陪跑只刷自身 personal 技能。

### 5.6 复制优先先知（需求 7）

- COPY(type=12) 事件/主动：可复制集 = `team+personal` 过滤掉 `type===COPY`。
- 选择：`copyPreferProphet && 预料先知specId ∈ 可复制集` → `param={copySkillSpecId:预料先知specId}`；否则按 `skillPriority` 取最高。

---

## 6. 日志与容错（对齐项目约定）

- `warn` 只留真异常（发包 throw、符号缺失、应答结构异常）；可预期业务拒绝（次数不足、非队长用队技、阶段门未开、密码试错）走 `info`；循环态/逐条走 `debug`。
- Int64：`treasureId`、`uid`、`tarUid` 全走字符串/Int64，禁 Number 化；`huntCount`/`lootMarchNum` 明确 `.toNumber()`。
- 在途锁：出征/召集/技能发送各按 cmd 级 `net.isSending(cmd)` 去重；跨 feat 行军名额协同沿用 `mapData.marches`/856 口径。
- 换号 reload：per-UID 命名空间隔离队员池与 specId 配置。

---

## 7. 风险与待真机确认清单（开工前需抓包/探针补全）

1. **技能 specId 映射** ✅ **已解决（§9 第三轮回填：先知=9/幸运=18/回合盾=2/战斗盾=26/隐形=10/闪现=11/复制=22/急救=27）**：~~`cross_treasure_skill` 为运行期表，离线无法枚举~~；配置辅助下拉仍建议保留（避免活动换代后 specId 漂移）。
2. **人数与场景数** ✅ **已解决（§9 主表实测）**：`max_ppl_num=5 / min_ppl_num=2 / round_max=10`；代码仍建议 config 驱动读取、不写死。~~MARCH_START 成行人数下限~~。
3. **次数恢复参数** ✅ **已解决**：上限 290004='5'、恢复间隔 290005='36000's'=10小时/点（见 §9）；插件仍只消费 `huntCount` 显示与门禁，不本地推算恢复。
4. **陪跑不可交互清单** ⚠ 半解决（§9.4）：密码场景 protocol 层**队员同样可发 7537**（陪跑趟实测 4 次命中，`uidWinMap` 记队员 win）——"陪跑不可交互"仅 UI 口径，协议层限制比 UI 宽；dice、defPVE、pickSkill 的陪跑限制仍待逐个核对。
5. **密码掩码实样** ✅ **已解决（§9.4）**：不走聊天、不解析字符——`eventInfo.eventCodeBoxInfo.codeNum[5]` 数组直读，**-1=未知位**、0-9=明文；猜错应答 `header.s=3 + d=cs_treasure281`，`phase` play→show 收敛。
6. **信标补次数发送路径**（`useBeaconWhenShort` 前置依赖）：✅ **已解决（用户口径 + 报文坐实）**：定位信标补次数**与通用使用物品无区别**——走 `NET.send(ITEM_USE=815, {itemid:47001001, amount:1})`（**JSON 通道、itemid 全小写**，非 sendPB），应答 `{itemId, amount:剩余持有量}`（实录报文实证：多趟 req:send `{"itemid":600001,"amount":1}` → resp `{"itemId":600001,"amount":2329}`）；消耗后由推送 21375 刷新 huntCount。已落地 `engine-team.#useBeacon`（库存查 `gameData.itemAmount`、20s 冷却防重复消耗）。
7. **rollDice 掷骰前奖励字段路径** ✅ **已解决（§9.4）**：`eventInfo.eventRollDiceInfo.winRewardResult` 在 `phase:"play"`（掷骰前）即明文携带物品（用户更正获报文证实）；`pickReward` 场景同构字段 `eventPickRewardInfo` 待补一实样（结构预期一致，不阻塞）。
8. **先知探测结果字段形态** ✅ **已解决（用户口径 + 陪跑趟实录坐实）**：**使用先知与使用其他科技无区别**——发 `SKILL_USE(7551){treasureId,skillSpecId:9}`；探测结果不另挂字段，而是体现为 **`eventInfo.eventDecideInfo.eventSpecIdList` 在 `phase:"play"` 态提前露出 3 个非 0 位**（param1=3，其余 3 位仍为 0），随后才到 `phase:"show"` 全量明文。实证 round10：`play[0,0,0,0,0,0]` →(先知)→ `play[0,100201,100502,0,100601,0]` → `show[全6位]`。生效推送 21378 `skillEventSpecId:9` 携 `uid`=使用者，**推送形态与谁触发无关**（陪跑能据此知队长开了先知）。→ P4 先知策略：DECIDE 之初队长 `sendUseSkill(9)`，读 play 态非 0 位即探测集合。

---

## 8. 分期落地建议

- **P0（只读闭环）**：7501 拉态 + push 订阅可视化 + 状态机/背包/技能表 dump 到 dashcam，用于坐实 §7 的 specId/config 缺口。**不发包**。
- **P1（队长最小闭环）**：建队(含信标补次数)→审批池→召集 7527→满编 7519 出征；pickReward/rollDice/nothing 简单场景自动过。
- **P2（队员/陪跑）**：入池匹配→申请→ready→陪跑/要奖励切换；满编出征复用。
- **P3（事件族）**：codeBox 密码聚合求解器 + 频道 17 广播；pickSkill 优先级。
- **P4（技能高级策略）**：预料先知决策、幸运降临、来袭保命、末场景清空、复制优先预料先知。
- 每期真机验证后再进下一期；P3/P4 强依赖 §7 确认项，勿提前。

---

## 9. 真机 dump 回填（2026-10-16，活动未开始期，cs-hunt-config-dump.devtools.js 首轮）

**已坐实**：

- `cross_treasure_event` 整表 90 行，`treasure_spec_id 1..4` 四套同构（当前控制器 `specId=1`）；事件 type 族实际为 **6 种**：`pickReward(先下手为强) / rollDice(这次我最大) / codeBox(密码大爆炸) / pickSkill(奇妙新科技) / defPVE(最后幸存者) / nothing(空冒一场险)`——用户口径“7 种场景”应是把 FIGHT（玩家来袭，非事件表行）计入，或把 codeBox 的 4 个子 id 当多种。
- **每类事件时间窗（`play_time`）**：pickReward 30s / rollDice 40s / **codeBox 60s** / pickSkill 30s / defPVE 25s；另有 `play_all_delay_time=3s`、`show_time=6s`。→ §4.1 密码求解+多组尝试的预算按 60s 窗设：广播→聚合→逐组 7537 需在此内完成。
- **轮次闸门**（直接坐实“10 场景”结构）：`pickSkill` 仅轮 1-9（第 10 轮不出）、`defPVE` 仅轮 5-10。→ §5.5 末场景清空技能时第 10 轮无新技能可拾，逻辑自洽。
- 刷新权重：pickReward 12000 / rollDice 9800 / pickSkill 9500 / codeBox 1875×4 / defPVE 667×15；`level_range="80|100"`。
- 奖励池行级化：win/fail 各自 `78001xxx` reward id；`grail_reward`（神器 47002001..47002021）仅 rollDice 行携带。→ §5.3 `luckyItemWhitelist` 应以 reward 解包后的 itemId 为键。
- 新字段（含义待真机对报文确认）：`sudden_reward_mode_weight="team|110,personal|1000"`、`sudden_reward_mode_pct="team|200,personal|400"`（突发奖励模式：队伍/个人两档权重与百分比）。
- 控制器空态可读：`huntCount=5`、`lastRecoverTimeMill=1792090800000`（=2026-10-16 03:00，恰落在下述开放时段表窗口边界）、`specId=1`、`team/csHuntInfo=null`（未开始，符合预期）。
- **DataConfig 290xxx 实值**（第二轮跑回）：`290004='5'` → **夺宝次数上限=5 ✅ 坐实**；`290005='36000'` → 恢复间隔 = 36000s = **10 小时/点 ✅ 坐实**（空到满 5 点 = 50h）；`290000='80'` 与事件表 `level_range=80|100` 吻合（参与等级门槛）；`290003='2'`（曾疑成行人数下限——已被主表实测 `min_ppl_num=2` 覆盖，实际语义仍待映射）；`290002/290006` = 时段开放表：第 5/6/7 天各三档 3:00-5:00 / 11:00-13:00 / 19:00-21:00（290006 为小时制同形态）→ **活动“未开始”由此排程决定，feat 调度应对齐这三档窗口**；`290001='7'` 疑即用户口径“7 种场景”之源（事件表实有 6 个 type 族，第 7 种口径待映射）；`290008..290012=2/20/6/20/13` 语义待映射。
- 探针脚本新增第 7 段 `copy()` 收口：一次运行把 tableFound/skillRows/mainRows/dataConfig/ctrl/beacon 打成一个 JSON 直上剪贴板，无需翻控制台分段复制。
- 道具 `47001001` 行命中，解析名 = **定位信标**（quality 5、type 150、bag_use 1）✅。

**仍缺（待活动进行中抓包）**：

1. ~~§7-4 陪跑不可交互清单、§7-5 密码聊天掩码实样~~ ✅ 已由 §9.4 报文关闭；余 §7-6 信标发包路径（四趟未点信标）、§7-8 先知探测字段（需带先知复抓）、§7-4 尾项（dice/defPVE/pickSkill 陪跑限制）。
2. 语义尾查：`290001='7'` 与事件表 6 族的差异、`290003/290008..290012`、`event_decidable_num=6` 与选场景 UI 的对应。
3. 口径错位观察：事件表 `treasure_spec_id` 跨 1..4，但主表仅 2 行（参数相同）——子表对应关系待真机进行中核对（当前控制器 specId=1，不阻塞 P0-P2）。

### 9.1 主表实测（第三轮回填，§7-2 定稿）

`cross_treasure` 仅 2 行且参数全同：`max_ppl_num=5 / min_ppl_num=2 / round_max=10` → **用户断言“2-5 人、10 场景”全部坐实**。附送时序实值：`event_decide_time=20000`（选场景 20s 窗）、`event_decidable_num=6`、`waiting_time=14000`、`battle_time=5000`、`battle_delay_time=8000`、`defend_time=25000`（FIGHT 防御窗 25s → §5.4 保命动作预算）、`reward_show=78002101/78002102`。

### 9.2 技能表整表 28 行（第三轮回填，§7-1 定稿；本轮最重大产出）

| specId | 科技名             | group  | type | 定位                                                                        |
| ------ | ------------------ | ------ | ---- | --------------------------------------------------------------------------- |
| 1      | 百战不倒           | 1 队伍 | 1    | 全队死伤兵恢复（pending 显示于 defPVE）                                     |
| 2      | 铜墙铁壁           | 1      | 2    | **回合盾**：下个回合完全抵御（des=cs_treasure228）                          |
| 3-8    | 战场变换×6         | 1      | 3    | 环境 buff 980101..980203                                                    |
| 9      | 预料先知           | 1      | 5    | **先知**：预告 3 事件，仅 DECIDE（=MING_BRAND）                             |
| 10     | 动态隐形           | 1      | 6    | **隐身**：60s 不可捕捉/不可攻击                                             |
| 11     | 自由闪现           | 1      | 7    | **随机迁移**                                                                |
| 12-16  | 诱敌来袭×5         | 1      | 8    | 被攻击增益 buff_831/930 系                                                  |
| 17     | 安全锁定           | 2 个人 | 9    | 保护奖励（=PRECTED_REWARD(9)，代码吻合）                                    |
| 18     | 幸运降临           | 2      | 10   | 下次奖励×2（神器除外）                                                      |
| 19-21  | 固定增强×3         | 2      | 11   | 属性提升                                                                    |
| 22     | 完美镜像           | 2      | 12   | **复制**（=COPY(12)，代码吻合）                                             |
| 23     | 全量刷新           | 2      | 13   | 仅 pickSkill 阶段（=REFRESH_SKILL_SELECT(13)，吻合）                        |
| 24     | 数据转换           | 2      | 14   | 随机转另一科技                                                              |
| 25     | 百战不倒(同名新型) | 1      | 15   | 新增 type=15，代码枚举未见；**面板并入 specId 1「百战不倒」一族**（见下注） |
| 26     | 毫发难伤           | 1      | 16   | **战斗盾**：抵御下次战斗（cs_treasure346 文案）；新增 type=16               |
| 27     | 火线急救           | 1      | 4    | 选玩家治疗（=RISE_PLAYER(4)，代码吻合）                                     |
| 28     | 天外守护           | 1      | 17   | 新增 type=17，预告 3（key_para 0\|3），pending defPVE                       |

> **specId 25「百战不倒」UI 归并（游戏改版核对）**：字典仅一个 `cs_treasure213=百战不倒`，无「·改」名（旧目录里的「百战不倒·改」是本地为区分两行而自造）。核对 11 趟夺宝报文的 `7538 skillSpecIdList`：specId 1（18 次）与 specId 25（12 次）**都会实际派发**，二者游戏名同为「百战不倒」但 type 不同（1 vs 15），无法断定谁取代谁 → 按用户口径在面板上**合并为一个「百战不倒」**（`skills.js` 新增 `fam` 归族键覆盖，specId 25 `fam:1` 并入代表 id=1 的族，`type` 仍留游戏实值 15；勾选该族 = 候选里出现 1 或 25 皆命中；旧存档经 `skillGroupRep(25)→1` 自动收敛去重）。

> **关键纠正（影响 §5.4 执行模型）**：两种护盾(2/26)、隐形(10)、闪现(11)、治疗(27)、守护(28)、先知(9) 全是 **group=1 队伍技能 → 仅队长可用**；而幸运降临(18)/安全锁定(17)/复制(22)/刷新(23)/转换(24)/固定增强(19-21) 是 group=2 个人技能全员可用。队员被来袭时的保命完全依赖队长统筹（与 `cs_treasure280` 文案一致）。另：`close_after=1` 全表统一；`weight` 决定 pickSkill 卡池出现率（先知/隐形/闪现=130 常见，盾类=65，变换=17，诱敌=稀有）；技能表 `round` 字段到 20，实服以主表 `round_max=10` 为准。

### 9.3 实况 dump 实样（第四轮，FIGHT 态、round 7、队长视角，tools/cs-hunt-live-dump.devtools.js）

- **Int64 同源坐实**：`csHuntInfo.treasureId === team.id`（19 位 `4886682428000821252`，Long→字符串化无损），插件全链路存字符串铁律的活样本。
- **2 人队实跑**：`team={uid:队长, cfg:1, status:3(HUNTING), member:2 人}`；`min_ppl_num=2` 从配置变成实行为——feat 的 targetMemberNum 缺省 5 但 2 人也能开完整局。
- **§7-4 首个 help 实样**：队长 `help:false`、陪跑队员 `help:true`，布尔位形态坐实；member 行**无 name 字段**（展示名需从 tInfo/字典侧取）。
- **fightInfo 实样形态比预期精简**：`{beginTime, endTime, fightWin:3, skillPendingEffectInfoList:[]}`——`lootMarchNum`/`lootPlayerInfos` **不在 fightInfo 内**（§0 该行口径待 bundle 全量 csHuntInfo 核实，应在顶层）；`fightWin=3` 枚举语义待映射。
- **防御窗实样 13s**（`endTime-beginTime=13000`）**< 主表 `defend_time=25000`** → 窗口随已进行时长递减，§5.4 保命动作预算须按实时剩余（end-now）而非配置全量计算。
- **`huntCount=3`**（起 5，跑两局各耗 1）：队长必耗次数实证。
- **交叉印证**：`fightInfo.skillPendingEffectInfoList` 即技能表 `pending_effect_show_fight_status=1`（百战不倒/盾类"待生效"挂 FIGHT 展示）的实现载体。
- 待本场景后续：控制器 own 属性无 `*skill*` 键 → 7550 背包挂在面板/另一存储侧，P0 实现时需先 `SKILL_BACKPACK_OPEN(7550)` 发包再读应答而非探属性；tap hook 已首挂，信标补次数点击后重跑可取 §7-6。

### 9.4 报文级实况（第五轮，dashcam 四趟：主跑×2/陪跑×2，含一次被玩家拦截致死）

**协议层 Int64 铁证**：所有报文中 `treasureId/team.id/member.uid/uidDecide/timePhaseEnd` 均为原生 Long 对象 `{_low,_high,_unsigned}`——**插件直发/自解析必须做 `(high>>>0)*2^32 + (low>>>0)` → 字符串**；控制器侧的 19 位字符串是游戏 doData 转的，不能指望协议层同样是字符串。

**21376 状态机全枚举实值**（status 分布 1:43/2:178/3:75/4:3/5:5/6:2）：

- `1`=等待/召集（载荷 `waitInfo{beginTime,endTime}`）；`2`=事件态（载荷 `eventInfo`，内含二级 `status:"decide"|"event"`）；`3`=FIGHT（载荷 `fightInfo`）；`4`=终局（round=10 出现）；**`6`=被掠结算**（载荷 `lootInfo.rewards[{id:Long,itemId,itemNum}]`，致死趟实样）；`5`=回城（载荷 `returnInfo`，紧随 6 之后；随后 `21371 team.status=5`）。feat 判定战败须认 6→5 链，不是 fightInfo。

**DECIDE 候选掩码模型（§7-8 关键背景）**：`eventInfo.eventDecideInfo={phase,timePhaseEnd,uidDecide:Long,eventIndexDecide,eventSpecIdList[6],voteInfo.indexVoteMap}`。进 DECIDE 先推 `phase:"play"` + `eventSpecIdList 全 0`，**1~20s 后才推 `phase:"show"` 携明文列表**（如 `[100101,100201,100201,100303,100201,100101]`，主/陪跑视角都有明文）→ **插件选场景必须等 show 推送，读到全 0 不可动作**。eventSpecId 词表实值 6 族坐实：1001xx=pickReward/1002xx=rollDice/1003xx=codeBox/1004xx=pickSkill/1005xx=defPVE/1006xx=nothing（观测到 100501-09、100301-04 等子行）。`indexVoteMap` 全程 77 次皆空 → 投票链路本批未触发，队员投票策略保持"队长独断"现实模型。

**密码大爆炸（§7-5 定稿）**：`eventCodeBoxInfo={phase,timePhaseEnd,codeNum:[5 位，-1=掩码],winRewardResult,failRewardResult,uidWinMap:{uidStr:boolean}}`；7537 请求=`{treasureId,round,codeNum[5]}`（全量提交，猜测位填数字）；猜错应答 `header:{s:3,d:"cs_treasure281"}`、猜对 `s:0` 且随后推送 `uidWinMap` 记名。fail 奖励 = win 去掉独有件（实样 win=[820015,62909×5,62910×2]/fail=[62909×5,62910×2]）。**自动化无需 OCR/聊天解析——直读 codeNum 补 -1 位**。

**rollDice 前置可见（§7-7 定稿，用户更正获实锤）**：`eventRollDiceInfo.winRewardResult` 在 **`phase:"play"`（掷骰请求发出前）** 即明文物品（实样 `{itemId:1700404,itemCount:1}`）→ 幸运判定链 7551(18)→21384(`rewardMultiple:2`+全量 `rewardResult`)→7535 完整闭环观测到。

**技能协议两处形态修正**：7551 请求=`{treasureId,skillSpecId}`（实发 10/11/18/24）；但 **21378 生效推送字段名是 `skillEventSpecId`**（观测值 5/9/10/11/18/24），且出现**无 7551 前置请求的生效**（隐形 10、先知 type5、9 号）——存在自动/队长侧代触发路径，feat 去重键须用 (uid, round, skillEventSpecId) 而非只认自己的发送。

**来袭与行军**：21383=`{treasureId,marchSize,playerInfos:{uid:JSON 字符串}}`（playerInfos 是**嵌套 JSON 串**，含昵称/头像，需二次 parse）；7578 `GET_MARCH_INFOS` 应答=`marchInfos[{uid:字符串!,level,power,maxArmyPower,armyPower,playerInfo:JSON串,heros[],armys[]}]`——来袭方完整军情可直接供 §5.4 保命决策（敌 force vs 我方驻防），**uid 在 7578 里是字符串**、在 21378/uidDecide 里是 Long，两形态并存须统一归一。

**7519 报文定稿（§3.3 直发口径）**：`{marchType:137,armyList,armyListNew(同内容),heroList:[英雄id],trapList:[],formation:0,formationV2:1003}`——**体内无 treasureId**（队伍上下文隐含）；同内容连发两条间隔 23s 均 `s:0` 成功，重复发包无害（幂等），插件重试安全。

**陪跑协议权实样（§7-4 修正）**：陪跑趟本队队长 uidDecide=`2029980631|2057`（非本人）时，本人仍发了 7537×4 且 `uidWinMap` 记入本人 win → **协议层陪跑可交互密码场景**；7520 `op:2`（不要奖励=陪跑）实发样本坐实 `{op:2}` 无需 treasureId。

---

## 10. P0+P1 落地实况（编码回填）

**代码位置**：`feats/activity/cs-hunt/{constants.js, engine-team.js, index.js}`；ACL `csHunt` 能力组（`present/openFlag/canHunt/readState/readTeam`）——原住 `core/game-api.js`，解耦试点已迁至 `feats/activity/cs-hunt/api.js`（符号 `SYM_LOCAL.csHuntCtrl='CSHuntController'` 本地收纳，`CAPS.csHuntController` 经 `registerCaps` 自注册；只验类/静态 `getInstance`，实例由 subpack2 Real 接管后才可取）；读侧归一 `bits.int64Str`（协议层 Long 对象 → 十进制字符串）经引擎 `sharedValue('bits')` 现取。面板挂在活动设置组（`menu.js` → `csHunt`）。

**已落地（P0 只读 + P1 组队闭环）**：

- 7501 点火拉态（req 逐键 `{header:{}}`）+ 兜底周期 90s 重拉（控制器未接管时 `readState()` 恒 null，这是开关态/整队的唯一补齐通道）；
- 21371~21376 推送落地为引擎本地快照（不镜像游戏数据、不调游戏 updateXxx），21377/21378/21379/21383/21384 本期只 debug 转储留痕；
- 队长链路：7521 建队 → 21374 置脏 → 7528 复核申请池 → 池内 7523 `{uid,op:1}`（池外按 `rejectOutsidePool` 回 op:2 或忽略）→ 凑够 `targetMemberNum` 且全员派兵到位发 7527 `{op:1}` 召集；
- 两角色共用：7520 `{op:1|2}` 表态 → 7519 满编出征（`NET.send`，`{marchType:137,…}` 体内无 treasureId）→ 收 21372 后 7527 同意；
- 幂等闸按 teamId 记账（`#useItemTeamId/#marchedTeamId/#marchStartTeamId`），写请求统一 `net.isSending(cmd)` 在途去重；`pause` 显式 `engine.stop()` 收编排闸，防 resume 后拿陈旧快照重发写请求。

**本轮编码新坐实的报文事实**（已回写 `constants.js` 注释）：

- **请求体业务槽名逐个从录制报文 `dir:"req:sendPB"` 行的 data 键抽出**（见 `constants.REQ_FIELD`）——V1 PB 请求体与应答同形（`{header:{}, crossTreasureXxx:{…}}`），其中 **7501/7526/7575 是纯头请求**（实发只有 `header`），发错会多出脏字段；
- **7501 应答也可带整队**（主跑趟 seq88）与 21371 同形，故引擎统一在 `ctx.on.resp(7501)` 里走同一套 `csHunt.readTeam` 归一；
- 录制里还出现过 §未登记的 cmd：`7503 / 7572(crossTreasureRewardInfo) / 7575(纯头) / 7577(crossTreasureGetFightInfos) / 7579 / 7554(crossTreasureEnvy)`，归入 P3/P4 需求时再定用途；
- **7527 一 cmd 两用**：队长凑够人发起即触发服务端 21372 召集，成员收 21372 后发同一包表态同意；且**先 7519 满编出征、后 7527 表态**（陪跑趟实测）。
- **7525 CROSS_TREASURE_TEAM_DISMISS（队长主动解散队伍，报文实证用户实抓 20261017、ts=1792181246）**：req 逐键 `{header:{}, crossTreasureTeamDismiss:{uid:<Int64 Long {_low,_high}>}}`（体内只一个 uid、无 teamId）；resp `{header:{ts, s:0}}`（s=0 即成功）。注：本 feat 当前未接入主动解散（解散仍走游戏 UI，插件不发此包），此处仅留档备用；req 内 `uid` 的确切语义（发起队长自身 vs 被解散目标）未实测，启用前需补报头核对。
- **7530 CROSS_TREASURE_SEARCH_TEAM（按玩家 uid 精确定位其所在队，报文实证用户实抓 20261017、ts=1792181365）**：req 逐键 `{header:{}, crossTreasureSearchTeam:{uid:<Int64 Long {_low,_high}>}}`（字段名是 `crossTreasureSearchTeam`，非 `searchTeam`）；应答 `header.ack=7530` 回指请求 cmd（故 dashcam 里这条应答的 cmd 字段不记 7530、要靠 `ack`/`reqTime` 配对——之前陪跑报文只 grep 到 7526 req、无 resp 即此因），`header.s=0` 即成功，队伍挂在 **`crossTreasureTeamList.team[]`**（与 7526 应答同名字段、**同 team 行结构**：`id / uid(队长) / cfg / status / members(人数) / maxMembers / applied / round / member[](成员详情 {uid,playerInfo,power,level,aTag,help,marchId}) / readyMember[] / treasureId`），**无 page/total/offset 字段** → 印证它是按 uid 命中单队、非分页列表接口。**语义（用户纠正）**：req.uid 可以是被搜玩家的 **队员 uid**（实证搜队员 `12432843882247` → 返回其所在队、队长 `uid=14179309129759`、`members=1/maxMembers=5/applied=false`），不是「只能按队长搜」。用途：陪跑指定要进某人（哪怕目标是队里的队员）时，可用 7530 按该 uid 精确定位其所在队再 7522 申请，绕开 7526 列表可能不含目标队的漏找问题；但当前 `#joinTeam` 未接入（仍只发 7526 `{header:{}}`）。

**本期刻意不做（阻塞项未解，按 §8 “勿提前”执行）**：

- ~~P3 事件族（7532~7538）与频道 17 密码聚合；P4 技能策略（7550/7551）~~ —— **已于 §10.2 落地事件族 + 先知/幸运，§10.3 补齐来袭保命/末回合清空/完美镜像（代码全实现、默认开关关闭待真机）**；频道 17 密码聚合经报文证伪为不需要（本端只见 1 掩码，直读穷举）；
- 活动时段排程（DataConfig 290002/290006 的五/六/七日 3-5/11-13/19-21 点三档）未做窗口预判，现阶段靠 `csHunt.readState().active` 与服务器拒因退避。

### 10.1 P2 队员/陪跑 + 信标补次数 + 玩法模式（本轮回填）

**玩法模式（用户直接反馈的缺口）**：面板新增 `mode` select（主跑/陪跑二选一），对应游戏 `help` 位与 7520 op：

- **主跑 main**（要奖励·耗次数）：无队 → 一律建队开车（已移除 `autoCreateTeam` 开关与「主跑关建队改找队」的回退，避免无人建队时空等「找不到夺宝小队」）；
- **陪跑 helper**（不耗次数·无奖励）：永不建队，只找队以 op:2 加入。
  旧 `needRewardAsMember` 字段删除（语义并入 mode，normalize 对无 mode 的旧存档一律按主跑回退）；`targetMemberNum/rejectOutsidePool` 均加 `showIf: isMain` 只在主跑展开。

**信标补次数（§7-6 关闭）**：新字段 `useBeaconWhenShort`，`engine-team.#useBeacon` 走 `net.send(815,{itemid:47001001,amount:1})`（JSON 通道、itemid 全小写）；先查 `gameData.itemAmount` 库存、`BEACON_COOLDOWN_MS=20s` 防重复消耗真道具；接在队长建队前与队员要奖励前两处。

**主动找队（P2）**：`engine-team.#joinTeam` 拉 7526（纯头请求）→ 按「`members<maxMembers` 未满 + `!applied` + 命中池」选首个候选 → `7522 {teamId:Long,op:1}` 申请；`JOIN_POLL_MS=25s` 节流重载荷接口，`#appliedTeamId` 防对同一队重复申请（入队/清队时重置）。申请后不轮询等审批，靠 21371/21373 落地接管。

**命中池 = 队长 uid 或 成员名双路（按名匹配改造定稿）**：陪跑指定「要进某人所在的队」，但目标未必在本联盟、且 7526 可加入队列表里 `team[].uid` **只有队长**、`team[].member[]` 成员**无独立 uid**（身份只在 `member[].playerInfo` 嵌套 JSON 串的 `username`）。故匹配口径改为：候选队命中 = 队长 `row.uid` ∈ 池 uid 集 **或** 任一成员 uid ∈ 池 uid 集（防御性） **或** 任一成员 `parse(member[].playerInfo).username` ∈ 池 name 集。池 name 优先取面板已回填的 `rolePool[].name`（`uidlist` 控件失焦时经 `net.lookupPlayer`/630 已把 uid 反查成 name 写回，见面板节）；某池项只有 uid 无名时，`#poolNameSet` 现查 `net.lookupPlayer` 补齐并记入引擎级 `#uidName` 缓存（查不到也缓存空串，`stop()` 清空），避免每拍重发。池空（uid/name 都空）→ 任意未满队（向后兼容）。**不使用 7530 按 uid 精确搜队**：本次只在客户端按 name 过滤 7526 返回集合，不引入新的按名搜队协议。

**630 PLAYER_INFO 抽为共用能力**：`core/net.js` 新增 `net.lookupPlayer(uidStr) → Promise<{uid,name,level,power,x,y,allianceName}|null>`（走 `net.send(630,{uid:String})` 非 PB、uid 上线字符串——同 auto-defense/chat-window 实证口径；应答顶层给 x/y/power，昵称在嵌套 JSON 串 `playerInfo.username`，`x/y/power` 缺失记 null 以区分合法的 0）。`auto-defense.getPlayerInfoByUid` 已委托它（保留「查无坐标/战力→视为查无」的防御语义，删除私有 630 send/parse 与随之失效的 `CMD_PLAYER_INFO`/`numOrNull`），面板 `uidlist` 与陪跑找队共用此真相。

**本轮新坐实的报文事实**：

- **先知与任何其他科技发包无区别**（§7-8 关闭）：`7551 {treasureId,skillSpecId:9}`；探测结果 = `eventDecideInfo.eventSpecIdList` 在 `phase:"play"` 态提前露 3 个非 0 位（实证陪跑趟实录 round10：`play[0,0,0,0,0,0]`→`play[0,100201,100502,0,100601,0]`→`show[全6位]`），21378 生效推送 `skillEventSpecId:9` 携 `uid`=使用者且形态与谁触发无关；
- **通用使用物品 = `815 ITEM_USE`**（JSON 通道）：req `{itemid(小写),amount}`、resp `{itemId(驼峰),amount:剩余}`；
- **7526 队伍行**：`{id:Long,uid:Long(队长),members,maxMembers,applied,cfg,power,level,playerInfo:JSON串,member:[{playerInfo:JSON串(内含 username)、无独立 uid}]}`——队员身份只在 `member[].playerInfo.username`，是「按名找队」的匹配依据（区别于队内实时态 21371/7501 的 `readTeam`，那里的 `member[]` 带 uid/marchId）。

**自查**：`npm run build` OK、`npm run lint` 0 error、`npm run arch` 无违规。**未真机验证**（当前非活动期），P2 找队/信标/模式待下次活动窗口实跑。

**面板字段（已定稿部分）**：`mode(主跑/陪跑 select) / autoCreateTeam / targetMemberNum(2-5) / rolePool(uidlist) / rejectOutsidePool / useBeaconWhenShort / presetPool(presetpool)`（除 mode/rolePool/useBeaconWhenShort/presetPool 外均 `showIf: isMain`），另加一个 `type:'text'` 只读状态行（次数/开关/模式/队伍/成员）。

### 10.2 P3 事件族 + P4 事件侧技能（本轮回填）

**新增文件**：`engine-event.js`（`EventEngine`，由 `TeamEngine` 在 `team.status≥MARCHING` 时经 `tick` 委托驱动，共享同一 `env/net/队伍快照/#sendPB` 幂等闸；不单独订阅 21376、不自建定时器）+ `codebox.js`（纯函数）。技能能力（7550/7551）内联在 `engine-event.js`，**本期未单拆 `engine-skill.js`**（与事件引擎强耦合，拆开只造循环依赖）。

**状态机分派（21376 status=2 eventInfo）**：

- **DECIDE**：play 态队长按 `useProphet` 先 7551 用先知(9)，show 态按族偏好（`SCENE_PREFER`：主跑 rollDice>pickSkill>…、陪跑 pickSkill>codeBox>…）发 **7532 indexDecide（1-based）**；**全员都发 7532**（含陪跑），7533 不实现。
- **EVENT**（按 `Math.floor(eventSpecId/100)`）：1001 pickReward→7534{pos=cfg.pickRewardPos}（仅主跑）、1002 rollDice→7535{round}（仅主跑，7536 四趟皆 0 故恒掷）、1003 codeBox→7537 穷举未知位、1004 pickSkill→7538{pos 按 cfg.skillPriority}、1005/1006 无动作。
- **幸运(18,个人)**：rollDice/pickReward 动作前读可见 `winRewardResult.items`/位 rewardResult 命中 `luckyItemWhitelist` → 先 7551 用 18 再执行。

**面板新字段（section=事件与科技）**：`autoEvent(checkbox, 默认开) / useProphet(checkbox, showIf isMain) / pickRewardPos(number 1~5, showIf isMain) / skillPriority(text specId 列表) / useLucky(checkbox) / luckyItemWhitelist(text itemId 列表, showIf useLucky)`。normalize 用 `parseIdList`（逗号/空格 → number[]）+ `clampRewardPos`(1~5)。

**幂等与生命周期**：`#done` 记 `${round}:{decide|prophet|reward|dice|skill|code|lucky}`；codeBox 用 `#codeTried[round]` 逐候选去重（`CODE_GAP_MS=3.5s` 节流）；treasureId 变更即 `#resetFor` 全清；`TeamEngine.stop()` 调 `EventEngine.reset()` 收 per-round 与背包缓存。

**本轮新坐实的报文事实**：

- **7532 每成员都发**（陪跑趟 190507/192930 各 5 次）、**7533 四趟皆 0**（§4 旧「队长发 7532/队员发 7533」口径作废）；
- **indexDecide 1-based**（191700 逐轮对齐实得 eventSpecId）；
- **req 体定稿**：7532`{treasureId,round,indexDecide}`/7534`{treasureId,round,pos}`/7535`{treasureId,round}`/7537`{treasureId,round,codeNum[5]}`/7538`{treasureId,round,pos}`/7550`{treasureId}`→`skillBackpack{personalSkillInfoList,teamSkillInfoList}`/7551`{treasureId,skillSpecId}`（copy 另带 tarUid/param）；
- **eventInfo 各族子体**：`eventCodeBoxInfo.codeNum`（恒 1 掩码）、`eventPickSkillInfo.skillSpecIdList`、`eventRollDiceInfo.winRewardResult.items[{itemId,itemCount}]`（掷前可见）、`eventPickRewardInfo.posInfoList[{pos,uid?,rewardResult?}]`；
- **奖励归属**：7534/7535 仅主跑发（陪跑不发，无奖励）；7537/7538/7551 全员发（陪跑 uidWinMap 也能置 true）。

**自查**：`npm run build` OK、`npm run lint` 0 error（cs-hunt 目录 0 告警）、`npm run arch` 无违规（105 modules）。**未真机验证**（当前非活动期）：indexDecide 族偏好调序、pickRewardPos 择优、幸运白名单 itemId、codeBox 节流节奏均待下次活动窗口实跑校准。

**P4 事件无关技能策略（§5.4~5.6）——本轮补齐（代码全实现、cfg 门控且默认关，待真机校准后启用）**：

### 10.3 P4 来袭保命 / 末回合清空 / 完美镜像（本轮回填）

**落点**：仍内联在 `engine-event.js`（新增 `#skillExtras(treasureId,status,round,cfg)`，`tick()` 每次推进都调，**与事件阶段无关**）；21383 来袭推送由 `TeamEngine.start()` 新订阅 `ctx.on.push(21383,…)` → `EventEngine.onRaid(payload)` 置 `#raidSize/#raidAt` 并唤醒（单点订阅，事件引擎不自摸 bus）。

- **来袭保命（§5.4，`useDefense` 默认关）**：`21383.marchSize>0` 且距 `#raidAt ≤ RAID_ACTIVE_MS(30s)` → 队长按 `DEFENSE_PRIORITY=[战斗盾26, 回合盾2, 隐形10, 闪现11]`（皆 group=1 队技，队员 `#canUse` 天然 false 不参与）取背包里第一个可用者发 7551；`(round,specId)` 去重、发后 `#raidSize=0` 等下一次 21383 再武装。**报文实证 194018 `marchSize:1` + `playerInfos{uidStr:JSON}` 为真人掠夺信号**；`fightInfo` 内无 loot 字段（旧 §5.4 `lootMarchNum/lootPlayerInfos` 口径作废，来袭规模只在 21383）。defPVE(1005) 不触发。
- **末回合清空（§5.5，`flushLastRound` 默认关）**：`round===cfg.roundMax`（真机 round_max=10，主表；面板可配 1~30）时逐拍用掉一个 `#flushCandidates()`（队长=team∪personal、队员=personal，剔 `FLUSH_EXCLUDE=[先知9,COPY22]`），`#sendPB` 同 cmd 在途去重故每拍一个、下拍续；池空即 `#flushedRound=round` 收尾。随机迁移类（闪现）会真动兵，故默认关。
- **完美镜像复制（§5.6，`useCopy` 默认关）**：背包有 COPY(22) 且本跑未复制 → `#copyTarget(cfg)`（`copyPreferProphet` 且先知在可复制集→9，否则按 `skillPriority` 取首个非 22）发 7551 `{skillSpecId:22, param:JSON.stringify({copySkillSpecId:target})}`。**⚠ param 键名 `copySkillSpecId` 照设计 §5.6 猜测、未经报文证实**（实录仅见 skill24 用 `transformToSkillSpecId`，COPY 从未被手动使用）；键名错会被服务器拒（走 info、无害），**真机需实抓一次 COPY 使用坐实 param/tarUid 形态**。

**面板新增（section=事件与科技）**：`useDefense(checkbox,showIf isMain) / flushLastRound(checkbox) / roundMax(number 1~30,showIf flushLastRound) / useCopy(checkbox) / copyPreferProphet(checkbox,showIf useCopy)`；defaults 全 false + roundMax 10；normalize 加 `clampRoundMax`(非法回落 10)。

**自查**：`npm run build` OK、`npm run lint` 0 error（cs-hunt 0 告警）、`npm run arch` 无违规（105 modules）、Prettier 通过。**未真机验证**：保命阈值/时效窗、末回合清空是否有害（动兵类）、COPY 的 param 键名与 tarUid 语义，均待活动窗口实跑；三项开关默认 OFF，用户勾选前不自动发包。

## 11. 场景引擎重构（engine-event.js → engine-flow.js + scenes/*，本轮回填）

**动因**：`engine-event.js` 把「生命周期编排 + 6 族事件动作 + 技能底座」全部内联，随场景增多膨胀难维护。本轮按「编排与场景分离」重构，并落地此前挂起的频道 17 聊天汇总与 UI 精简（本节覆盖 §4/§4.1/§5/§10.2/§10.3 的旧结构与结论）。

**文件结构（`feats/activity/cs-hunt/`，依赖方向 `scenes/* → constants.js/codebox.js/skills.js`、`engine-flow.js → scenes/*/skills.js`、`engine-team.js → engine-flow.js`）**：

- `engine-flow.js`（新，`FlowEngine` 取代 `EventEngine`）：只管生命周期编排——DECIDE.play 转场串联（复制22→数据转换24→队长先知9，每用一发 `#reloadBackpack` 再判下一项）、DECIDE.show/满 10s 先知感知选场景发 7532、EVENT 按 `Math.floor(eventSpecId/100)` 分派 scenes/*、横切 `#autoStrategies`（来袭保命 / 末回合清空，默认开）。技能底座（7550/7551/背包缓存/幸运/视图广播）留在此，经 `#sceneCtx()` 注入窄 `ctx`。
- `scenes/{pick-reward,roll-dice,code-box,pick-skill,def-pve,nothing}.js`（新）：每场景一文件，`export async function handle(ctx)`，**只吃注入 ctx、绝不反向 import engine-flow**（避免环）。def-pve(1005)/nothing(1006) 为 no-op 占位保持分派表完整。
- `skills.js`（新，纯）：28 行 `cross_treasure_skill` 静态目录 + `canPhase/chooseByPool/chooseCopyTarget/skillName/isTeamSkill` 纯查询，供 scenes、engine-flow、面板 resolve 共用（不发包、不读运行期背包，可独立单测）。
- `codebox.js`（扩展）：保留 `solveCandidates/nextUntried/isFullyKnown`，新增 `viewToStr/strToView/merge`（视图↔`--3-5` 字符串编解码/合并）纯函数。
- `engine-team.js`（小改）：`#eventHost→#flowHost`（增 `chat:{send,normalize}` 懒取 `window.pocketcc.chat`）、`EventEngine→FlowEngine`、`start()` 新增频道 17 `chat.on('push')→flow.onChatPush`（退订句柄存 `#chatUnsub`、`stop()` 摘除；chat 是 socket.io 独立通道、非 net bus），21383 转 `flow.onRaid`。
- `index.js`（大改 UI）：见下「UI 精简」。
- `engine-event.js`：**已删除**（逻辑全并入上述新结构）。

**⚠ codeBox 结论纠正（覆盖 §4.1 / §10.2「恒 1 掩码、无需频道聚合」）**：四趟样本均为 **2 人队**（`min_ppl_num=2`），每端恰见 4 明文 + 1 掩码，据此「废弃聚合」是过拟合。**满编 5 人（`max_ppl_num=5`）各只见 1 位、余 4 位掩码（10⁴ 组合），穷举不可行**，必须以 **频道 17 聊天汇总**为主：本端视图 `viewToStr` 每回合广播一次 → 收队友视图（`chat.normalize` + 抽 `[-0-9]{5}` token、剔 `isSelf`）→ `merge` 累积到本回合；汇总满即发 7537；仅当剩余未知位 ≤2 才 `solveCandidates` 穷举兜底（`CODE_GAP_MS=3.5s` 节流）；未知 >2 且未汇总满 → 放弃本回合（留手动）；`uidWinMap[我]===true` 停手。**房间 17 由游戏在玩法内自动 join，本端能否收发待真机确认**。

**UI 精简**：删布尔/文本开关 `autoEvent/useProphet/useLucky/luckyItemWhitelist/skillPriority/pickRewardPos/useDefense/flushLastRound/roundMax/useCopy/copyPreferProphet`（`autoEvent` 语义并入「feat 运行即全自动」，P4 三项默认开、无开关）；仅留两个 `sortlist` 用户可选项：

- `skillPool`（`checkable` + `offKey=skillPoolOff`，`all=SKILL_IDS` 全量 28、`resolve=skillName`）→ 生效值 = order 剔 off（`activeSortlist`）→ `cfg.skillPool`（勾选 + 拖拽优先级，pickSkill 选位 / COPY 择目标共用）；`defaults.skillPool=SKILL_IDS.slice()` 保证面板未开过时引擎也有全池。
- `luckyRewards`（`checkable` + `offKey=luckyRewardsOff`，`all=csHunt.readRewardPool()` 道具 id、`resolve` 出道具名）→ `cfg.luckyRewards`（幸运判定白名单）；池取自 `cross_treasure_pool`，经本轮新增 ACL 只读符号 `csHunt.readRewardPool()`（feat 不裸 `game.get`）。
- `normalize` 幂等（reactor 双调 `toModuleCfg`+`configure` 不变）；`run` 日志相应精简。

**选场景算法（先知感知，1-based indexDecide）**：`revealed` = play 态 eventSpecIdList 非 0 位；非空 → revealed 里按 [1002 rollDice,1004 pickSkill] 优先取，两者都不在 → hidden 随机（1006 nothing 永不选）；`revealed` 空 → 等 show（全 6 位明文）按 [1002,1004,1001,1003,1005] 优先、跳 1006。硬约束 `DECIDE_MIN_MS=10s`（等人用先知探测）/ `DECIDE_TIMEOUT_MS=20s`（主表 `event_decide_time`）内完成，撞上限按当前可见兜底选一个、不越窗。

**幂等与生命周期**：`#done` 记 `${round}:{decide|seq:copy|seq:transfer|seq:prophet|reward|dice|skill|code|def:*|flush:*}`；treasureId 变更 `#resetFor` 全清 per-round（含 `#peerViews/#codeBcast/#refreshCount/#enterAt`）；`TeamEngine.stop()` 调 `FlowEngine.reset()` 并摘 `#chatUnsub`，防 resume 后拿陈旧快照重发写请求。

**自查**：`npm run build` OK、`npm run lint` 0 error（cs-hunt 目录 0 告警，全仓仅 10 条未触及文件的既有告警）、`npm run arch` 无违规（**112 modules**，scenes/* 归 intra-feat 允许）、Prettier 通过。

**待真机验证（非活动期）**：COPY(22) 的 param 键名 `copySkillSpecId`（照设计猜，错则被服务器拒、走 info 无害）；频道 17 本端可收发；数据转换(24) 纯随机无 param、先知揭示位标记、10s/20s 窗口节奏、护盾/闪现自动消耗收益；幸运池 `cross_treasure_pool` 的道具列名（`readRewardPool` 已防御式扫候选列 + `rewardItems` 解包，取不到回空不致命）。

---

## 12. 面板三处精简（用户复核回调，§11 之后）

按用户实跑前三点反馈收敛，全部改在 `index.js`/`skills.js`/`game-api.js`，不动引擎链路：

1. **出征预设改单选（不再弄池）**：面板字段 `presetPool`（`presetpool` 多选）→ `preset`（`select` 单选 1~8）。`normalize` 仍向引擎输出 `presetPool` **单元素数组**（`sanitizePreset`→`[p]`），`engine-team.buildPlanFromPool` 逐字不动，语义退化为「只这一个预设组兵，全在外则不发空包」。兼容旧存档：无 `preset` 时回落 `raw.presetPool[0]`。

2. **科技同类归族（勾一类=勾全部）**：`cross_treasure_skill` 里 `战场变换`(type3, specId3-8)/`诱敌来袭`(type8,12-16)/`固定增强`(type11,19-21) 是同类多行。`skills.js` 新增 `SKILL_GROUPS`（按 `type` 归族，代表 id=族内最小 specId）、`SKILL_GROUP_IDS`、`groupMembers(repId)`、`groupName(repId)`。面板 `skillPool` 的 `all/resolve/defaults` 由 28 行 specId 改为**族代表 id**（约 17 项）；`chooseByPool`/`chooseCopyTarget` 用 `groupMembers` 把池项展开成成员再命中候选——勾选一族即族内任一 specId 出现即命中，取消一族即整族不主动选。单行科技自成一项（`groupMembers` 回 `[id]`，向后兼容裸 specId 入参）。

3. **幸运礼品池不再恒空（读错表根因）**：旧 `readRewardPool` 读 `cross_treasure_pool`——经源码核验该表是**以 poolId 为主键的赛季开关配置行**（`min_level/achievement_open/grail_open`），根本不存礼品清单，故面板幸运池永远空。改为读 `cross_treasure_event` 各行的 `win_reward/fail_reward/grail_reward` 奖励配置 id（真机 dump §9 定稿 `78001xxx`/神器 `47002xxx`），经 `gameData.rewardItems` 解包成 itemId、`item` 表出名后去重呈现。事件奖励行属登录下发的客户端配置，**活动未开始时也在内存**，故可在开局前就铺出候选供勾选（解了「先配后开」的鸡生蛋）。仍防御式扫多同义列名、解包失败即跳过、取不到回 []。

**自查**：`npm run build` OK、cs-hunt 目录 + game-api `eslint` 0 problem、`npm run arch` 无违规（112 modules）、Prettier 通过。**待真机核对**：`cross_treasure_event` 奖励列的确切列名（现扫 win/fail/grail_reward + 同义候选），不符则幸运池仍回空但不致命。

---

## 13. §12 三处收敛的返工（面板实测未生效，2026-10-17）

用户reload后实测：科技池仍列 28 行、幸运池仍「礼品池为空」。定位到 §12 的两处修复**没真正生效**，本轮补正：

1. **归并没显示 = 缺旧存档迁移**。`mountSortList` 渲染的是**已存的 `configs[fid].skillPool` 数组**（旧值＝28 个 specId），`fd.all` 只做「追加缺失项」、**从不删/收敛**。17 个族代表 id 全是旧 28 的子集 → 追加不动、旧成员行（战场变换Ⅱ…）照旧显示。
   - 修法：给 `core/ui/widgets.js` 的 `mountSortList` 加通用 **`fd.migrate(arr, cfg) → number[]`** 钩子（在 `all` 追加之前跑，就地收敛、变了才 `saveFeature+applyFeature`，幂等）。cs-hunt 的 `skillPool` 字段提供 `migrate`：用 `skills.js` 新增的 `skillGroupRep(specId)`（成员→族代表反查）把 28 行收敛成 ~17 族项并去重，同步收敛 `skillPoolOff`。

2. **幸运池为空 = 运行期枚举拿不到，需静态保底**。`cross_treasure_event` 解包在活动未开/符号缺失时回 []（面板就是空）。
   - 修法：`constants.js` 新增 **`LUCKY_GIFTS`** 静态目录（报文实证 2026-10-16 主跑/陪跑四趟真人实录 `winRewardResult`/`posInfoList.rewardResult` 去重出 27 件礼品，名取自游戏本地化字典）。`index.js` 的 `rewardPool()` 改为 **运行期枚举优先、空则回退 LUCKY_GIFTS**，保证面板不空、开局前即可勾选。

**闸门**：`npm run build` OK、cs-hunt 目录 `eslint` 0 problem（widgets.js 仅 2 条既有告警、非本次区域）、`npm run arch` 无违规（112 modules）、Prettier 通过。`fd.migrate` 是通用能力，其它 sortlist 需要收敛旧口径时可直接复用。

---

## 14. 建队/找队前先闸「活动进行中」（用户反馈，2026-10-17）

用户要求：创建队伍、搜索队伍之前，先检查活动是否正在进行中，不在活动时间就别去建队/加入。

**根因**：feat 运行位是 `places:['base','world'] kinds:['homeland']`（不门控到玩法场景），所以活动没开时引擎也在 tick。`#noTeam` 旧闸是 `if (st && !st.active)`——只在**控制器在场**（`readState()` 非 null）时才拦。而控制器（subpack2 `RealCSHuntController`）只有子包被接管才存在；不在场时 `st` 恒 null → 旧闸跳过 → 照旧发 7521 建队 / 7526 找队。

**开关态真相**：控制器 `open` 字段（`isOpenCSTeamHunt()` = `open===1`；`3`=休赛）。它由 7501 应答的 `crossTreasureInfo.open` 喂（源码 `updateHuntTimeInfo`：`e.hasOwnProperty("open")&&(this.open=e.open)`）。报文实证 dashcam 各趟 `crossTreasureInfo.open`：活动期=1、`补充体力`休赛期=3。

**修法**（全在 `engine-team.js`，不动协议）：

1. 引擎新增 `#openFlag`（活动开关态，控制器缺席时判「进行中」的唯一依据，由 7501 应答落地）。
2. `ctx.on.resp(REQ_INFO)` 处理里顺带取 `ack.open` 存 `#openFlag`，值变化即 `#wake()` 立即重评（开赛/休赛不等下一拍）。
3. `#noTeam` 三态闸：`openKnown = st ? st.active : (#openFlag!=null ? #openFlag===1 : null)`。`false`（不在活动）→ info 一次 + 长睡 `IDLE_TICK_MS`；`null`（新会话 7501 未回，未知）→ `refreshInfo(true)` 强拉 + 短睡 `ACTIVE_TICK_MS` 等应答，**不贸然建队/加入**；`true` 才进 `#tryCreate`/`#joinTeam`。控制器在场时 `st.active` 实时，活动中途结束也能被下一拍捕获。

**闸门**：`npm run build` OK、cs-hunt `eslint` 0 problem、`npm run arch` 无违规（112 modules）、Prettier 通过。

---

## 15. 第二道闸：每日夺宝时段（§14 之后，用户补充，2026-10-17）

用户指出：活动开放（§14 的 `open===1`）只是**赛季旗标，整天为真**，不等于「当前到点」。每天另有 **3 个 2h 夺宝时段**，建队/找队须落在某个时段内。

**时段真相（源码 + 报文实证）**：控制器 `getActivityTimeTips()` 的 `PALYING` 相 = `ServerMSTime` 落在 `timeInfo.openTime[i].beginMill..endMill` 之一。7501 应答 `crossTreasureInfo.openTime[]` 即这些时段（每项 `{beginMill,endMill}` 是 Int64 Long）。报文实证主跑趟实录：`openTime` 各项跨度 2h（`endMill-beginMill=7200000`）、相邻间隔 8h（`28800000`）→ 每天 3 场，数组覆盖整个 round。

**ACL 收口**（`core/game-api.js`，feat 不碰 Int64/字段名）：

- `csHunt.serverMs()`：服务器毫秒（`ServerTime` 秒 ×1000，与 `beginMill` 同量纲；时段边界分钟级，秒级误差无碍）。
- `csHunt.parseSchedule(crossTreasureInfo)` → `{open, slots:[{begin,end}]}`（`int64Num` 解 Long，缺列容错回空 slots）。
- `csHunt.playWindowState(slots, nowMs)` → `{known, in, nextBegin}`（纯函数，不含 open 判定）。

**feat 侧**（`engine-team.js`）：`#noTeam` 在 §14 的 open 闸之后叠时段闸——`#slots` 由 7501 resp 与 `#openFlag` 同批落地；`!win.known`（时段表未知）→ 强拉 7501 + 短睡；`!win.in`（未到点）→ info 一次（带「下一场约 N 分钟后」）+ 睡到下个时段（封顶 `IDLE_TICK_MS` 保持对开关变化的响应）；仅 `open===1 且 in` 才进 `#tryCreate`/`#joinTeam`。控制器在场与否都能拿到时段：`run()` 无条件 `refreshInfo(true)` 首发，且 resp 订阅会 tap 任何 7501 应答（含游戏自发的）。

**闸门**：`npm run build` OK、cs-hunt + game-api `eslint` 0 problem、`npm run arch` 无违规（112 modules）、Prettier 通过。

---

## 16. 策略完善（真机陪跑趟复盘，用户 6 点纠正，2026-10-17）

用户拒绝上一轮把 630 塞进 `core/net.js` 的做法（查询玩家昵称是业务强相关报文，不入通用网络层），并据真机陪跑趟提出 6 项纠正。四决策经对齐：① 镜像**严格只复制先知**（背包无先知则本轮不复制）；② 转场时机 = 探索回合 **数据转换(24)→重拉背包→再判复制(22)→复制先知**，先知(9) 留 DECIDE（type5 游戏强制仅 DECIDE）；③ 找队**只用 7530 按名搜**（弃 7526）；④ 630 收口在 cs-hunt feat 内私有 `#lookupName`（用户以后单独在 core 建类似 item.js 的薄底座再统一收口）。

### 16.1 四回合模型厘清（补全 §0/§4 回合语义）

一次小队出征 = `cross_treasure.round_max=10` 场，每场四回合，由 21376 `crossTreasureHuntInfoChange.status` 时序实证映射：

| 回合             | status    | 二级相位                               | 引擎动作                                     |
| ---------------- | --------- | -------------------------------------- | -------------------------------------------- |
| 探索回合         | `WAIT=1`  | —                                      | **完美镜像(22)/数据转换(24) 在此判断与使用** |
| 夺宝回合（选择） | `EVENT=2` | `eventInfo.status=decide`（play→show） | 队长先知(9) 揭示 + `uidDecide` 轮值者发 7532 |
| 夺宝回合（交互） | `EVENT=2` | `eventInfo.status=event`               | 按 eventSpecId 族号分派 scenes/*             |
| 战斗回合         | `FIGHT=3` | —                                      | 交游戏（来袭 21383 保命横切）                |

### 16.2 完美镜像 bug 根因与修法

**根因**：旧 `#copyableSet()` 对非队长排除队技 → 陪跑看不到先知(9，group=1 队技) → `chooseCopyTarget` 恒回 0 → 从不复制。真机实证实录报文：用户手动 `7551{skillSpecId:22,param:"{\"copySkillSpecId\":9}"}` 复制队技先知成功（`header.s:0` 无 errorKey，背包 `teamSkillInfoList:[{10},{9},{9}]`）——**完美镜像(22) 是 group=2 个人技，把队技作为复制目标不需队长权限**。

**修法**（`engine-flow.js`）：`#copyableSet` 去掉 `isLeader` 闸，personal ∪ team（仅排除 COPY 自身）；`chooseCopyTarget` 简化为「背包有先知即复制先知、无则本轮不复制」（`skills.js`）；转场串联从 `DECIDE.play` 移到 `tick` 的 `WAIT` 分支 `#explorationSkills`（转换→`#reloadBackpack`→再判复制，落实「转换后重判是否有值得复制的科技」），先知另拆 `#decideProphet` 留 DECIDE。`onHuntInfo` 对 `WAIT` 也 `#wake()`，`tick` 按 `status` 返回三态 cadence（EVENT/WAIT/其它）。

### 16.3 选择提前量（倒数 7s→10s）

用户要求较旧口径提前约 3s 决断。改用 21376 `eventDecideInfo.timePhaseEnd`（Int64 权威截止）算 `remaining = timePhaseEnd - csHunt.serverMs()`，`remaining ≤ DECIDE_ACT_MS(10000)` 即自主发 7532；删旧的 `DECIDE_TIMEOUT_MS` 观测常量，无 timePhaseEnd 的异常形态才退回 `elapsed ≥ DECIDE_MIN_MS`。（真机反馈仅改阈值仍常在倒数 6~7s 才发，根因是轮询粒度——见 §18.1）

### 16.4 活动闸上提到每拍（窗口结束不再空转写包）

用户指出「时间窗口结束但 feat 还在运行」。把 §14+§15 两道闸从 `#noTeam` 内联抽出为 `#gateActivity(st)`，在 `tick` 顶部**每拍**校验：无队分支、未开跑分支（等待凑人/表态/出征/召集期）都先过闸；**已开跑的一局（`status>=MARCHING`）豁免**，直接 `#flow.tick()` 让其跑完（服务端权威、一跑仅数分钟）。`#noTeam` 瘦身为纯派发（main→`#tryCreate`，helper→`#joinTeam`）。

### 16.5 陪跑主动找队（630 取名→7530 按名搜→7522 申请）

用户要求「主动挨个搜玩家池」。`#joinTeam(cfg)` 重写：遍历 `rolePool` 每个 uid（跳过自己）→ `#lookupName(net,uid)`（`net.send(630,{uid:String})`，解析 `data.playerInfo`(JSON 串).username，`#uidName` 缓存、查无记空串）→ `#sendPB(7530,{likeName:name})` 搜其创建的队 → 命中未满、未申请、`row.uid===该 uid`（同名他人跳过）的队即 `#sendPB(7522,{teamId:Long,op:1})` 申请，找到即停；整按 `#joinGap()` 节流（退避档位见 §24）。630/7530/7522 报文逐键实证陪跑趟实录（`likeName:"老陈"` 命中 `username:"书院🍁桂K老陈"` 创建的队）。**已知局限**：likeName 子串匹配，昵称含 emoji/空格时整串可能搜不到（真机手动也常剥字搜），查无即跳过下一成员。

**常量**：`CMD_PLAYER_INFO=630`（feat 内私有 const，不入 net.js）；`REQ_SEARCH_TEAM_LIST=7530/ACK_SEARCH_TEAM_LIST='crossTreasureSearchTeamList'` 已在 `constants.js`；`REQ_TEAM_LIST=7526` 保留但找队不再引用。引擎字段 `#uidName`（stop 清空）。

**闸门**：`npm run build` OK、cs-hunt `eslint` 0 error（11 全仓 warning 均他模块既有）、`npm run arch` 无违规（112 modules）、Prettier 通过。真机端到端验证留待下一个夺宝时段窗口。

### 16.6 密码视图手输解析改「数字=已知、任意非数字=未知」正则（用户纠正）

旧 `strToView` 只认 `0-9`/`-`、`onChatPush` 只 `match(/[-0-9]{5}/g)`——队友手输 `53**32`/`53??32` 因含 `*`/`?` 被判非法丢弃。用户口径：玩家输入的规律是**不确定的位用非数字表示，符号不固定但数字对应的位固定**。`codebox.js` 重写：`strToView` 逐位映射（数字→值、任意非数字→-1、含字母/汉字判噪声回 null）；新增 `parseCodeViews(text)`——以「空白、字母（含中日韩汉字）、句读标点 `，。、；：,;:` 与括号」为分隔（**不含 `? * - ×` 等可作掩码的符号**）切出定长 `CODE_LEN=5` 候选段按位解析。`engine-flow.js` `onChatPush` 改调 `parseCodeViews`。实测 `53*32`/`53?32`/`53-32` 均归一为 `[5,3,-1,3,2]`，我方广播 `21-1-` 与 `帮看下，12?45，谢谢` 亦正确切出。定长 5 过滤是刻意的对齐保护：非 5 段丢弃，避免长句数字错位污染合并视图、发错 7537。

### 16.7 全角数字与「5 位后多打掩码」的视图收取（用户反馈真机聊天截图）

真机频道 17 队友手输出现 `０３０３６`（全角数字）与 `0?????`/`???0??`（**已知位 + 五个 `?` 占位，整串 6 字符**）。全角数字本已由 `digitValue` 显式覆盖 ASCII `0-9` 与 `０-９`（不走 `Number()`/`\p{Nd}`）；真正的缺口是 §16.6 的「段长恰为 5」硬闸——密码 5 位而队友习惯把自己那一位外加 5 个占位都打出来，6 字符段被整条丢弃，**唯一那条已知数字位随之丢失**，汇总缺口变大后退化成穷举连错。

**修法**（`codebox.js` `parseCodeViews`）：段长判据由「`!== CODE_LEN` 即弃」放宽为「**≥ 5 且前 5 位之外的多余位必须全是未知（-1）**」，通过后 `slice(0, CODE_LEN)` 截齐入桶。两条不变量都保住：

- **防污染不降级**——纯数字长串（`123456`、`987654321`）尾部是已知数字而非掩码，照旧拒绝；含真实单词字母仍由 `strToView` 判噪声；纯掩码段（`??????`）因「≥1 已知数字位」校验天然出局；
- **定长 5 契约不破**——截齐是必须的：`merge` 取各视图**最大长度**，若把 6 位视图原样入桶，汇总会变 6 位、`solveCandidates` 产出 6 元素候选，7537 的 `codeNum` 就违反了定长 5 的提交契约（实测未截时首候选成 `[2,1,0,0,0,0]`）。

实测：`0?????`→`[0,-1,-1,-1,-1]`、`???0??`→`[-1,-1,-1,0,-1]`、`０?????` 同前者、`帮看下，０３０３６，谢谢`→`[[0,3,0,3,6]]`；本端 `[2,1,-1,-1,-1]` 合并后仍 5 位、首候选 `[2,1,0,0,0]`。

## 17. 出征结束的权威判定：7531 命中「小队不存在」即收口转下一轮（用户反馈，2026-10-17）

**现象**：本次小队出征结束后，`engine-flow` 仍每拍对已消亡的 `treasureId` 补拉 7531，`#sendPB` 持续打 `拉本跑详情 rejected. cmd=7531 code=3 reason=cs_treasure294`，且游戏界面一直弹「小队不存在」提示（这提示正是我们反复空拉触发服务端报错回抛的副作用）。

**拒因核对**：游戏本地化字典 → `cs_treasure294=夺宝奇兵小队不存在`。确认即「本队已不存在」的服务器权威终局信号。

**修法**（`engine-team.js`）：新增 `HUNT_OVER_REASONS=Set(['cs_treasure294'])`；`#sendPB` 在 7531 命中该终局拒因时调 `#endHunt(reason)`——记下死 `treasureId`（`#endedTreasureId`，防陈旧控制器把同一死队从 `readState().team` 回填后再次空拉）、`#flow.reset()` 停对死 id 的空拉、`#clearTeam()` 清队伍快照与全部编排闸并唤醒，下一拍即走无队分支（`#gateActivity`→建队/找队）尽快进入下一轮。`tick` 的 readState 交叉回填加 `stTid !== #endedTreasureId` 闸；`stop()` 清 `#endedTreasureId`。**分层**：`cs_treasure294` 是本玩法业务终局语义，收口在 feat 内 `#sendPB`/`#endHunt`，不上抬通用网络层。

## 18. 决断轮询精确到倒数 10s + 陪跑不选幸运降临（用户反馈，2026-10-17）

### 18.1 决断轮询精确化（真正落在倒数 10s）

§16.3 只把触发阈值改成 `remaining ≤ 10s`，但 EVENT 期 `tick` 重扫粒度是 `EVENT_TICK_MS(4000)`，`#handleDecide` 每 4s 才采一次 `remaining`——跨过 10s 线的那一拍往往已是倒数 6~8s，故真机仍见「倒数 7s 才选」。修法：`#handleDecide` 在「轮值到我且 play 未到触发阈」时返回一个**精确重扫延时** `toFire = clamp(remaining - DECIDE_ACT_MS, 300ms, EVENT_TICK_MS)`（`deadlineMs`/`elapsed` 都取自已有快照、无需额外拉包），`tick` 的 EVENT 分支采纳该延时替代固定 4s，使轮询逐拍收敛到刚跨过 10s 处即发 7532。模拟验证：20s→sleep 4s→16s→sleep 4s→12s→sleep 2s→**10.0s 触发**（留足 10s 给队友反应）。`#handleDecide` 返回类型改为 `number`（0=走常规节奏），其它早退路径（非轮值/已完成/无 list/SHOW 已发）均回 0。

### 18.2 陪跑不选幸运降临（pickSkill 7538）

幸运降临(18) 效果是下一次奖励×2，而 rollDice/pickReward 两个领奖场景已对陪跑早退（不发 7534/7535），陪跑拿到幸运无处可用。故仅在「选科技」处收口：`chooseByPool(pool, candidates, exclude)` 新增第三参 `exclude`（命中位落在排除集合即跳过、继续找下一候选）；`scenes/pick-skill.js` 对非主跑传 `exclude=[SKILL_LUCKY]`，且**兜底随机位也只在非排除位里随机**（不留空、也不误选幸运）。主跑 `exclude=[]` 行为不变。因幸运唯一来源即 pickSkill，此闸使陪跑全程不会持有幸运（`#tryLucky`/末回合清空无需改动）。

## 19. 陪跑多轮复核：决断再提前到倒数 15s + 场景判定的 push/req-resp 结合审计（用户反馈，2026-10-17，实录报文）

### 19.1 决断提前到倒数 15s

§18.1 精确轮询上线后，用 120320 陪跑多轮趟对拍（9 个轮值到我发 7532 的回合）：以 push 帧头 `header.ts`(秒) 校准客户端时钟、`remaining = timePhaseEnd(ms) − serverMs` 实测**每次发出时剩 9.2~9.5s**（目标 10s、稳定晚 ~0.6s，那 0.6s 是一拍内 `#ensureBackpack`/先知串联等 await 与发包开销）。即旧反馈的「有时 7、有时 9」已基本收敛到 9s 附近。用户新口径改为**倒数 15s 决断**（留更多时间给队友）：`DECIDE_ACT_MS 10000→15000`。因 §18.1 的精确重扫机制不变，轮询仍逐拍收敛到刚跨过 15s 处即发（20→sleep4→16→sleep1→15.0 触发），实测预计落在 ~14.4~14.5s（同样负于 ~0.6s 开销）。同步 `DECIDE_MIN_MS 10000→5000`（无 timePhaseEnd 异常形态的兜底，与 15s 口径对齐：20s 窗内剩 ~15s 即 elapsed≥5s）。代价权衡：对队长/主跑而言 15s 剩即发比 10s 更早，先知需在前几拍已揭示（实测先知一用 ~1-2s 内 eventSpecIdList 即回填，5s elapsed 内一般就绪）；若未揭示则走 `fallbackIndex` 默认位，与旧口径同构、无回退风险。

### 19.2 场景判定与报文复用（免重复拉包/免再计算）

结论：**当前场景/回合/状态的确定已由 push 驱动，无需为判定额外拉包**。`onHuntInfo` 同时接 21376 推送与 7531 应答两路，任一落地即写 `#hunt` 并在 status∈{EVENT,WAIT} 时 `#wake()`；`tick` 在 `status===EVENT` 时**不**重拉 7531（只靠 push 更新快照），故 DECIDE/EVENT 期的场景切换全走推送。可直接取用、不需再计算的 push 字段：

- `eventDecideInfo.timePhaseEnd`（绝对服务器毫秒）→ 决断倒计时直接读，不从 elapsed 推；
- `eventDecideInfo.uidDecide`（Int64）→ 轮值归属直接字符串比较，不靠 FIFO/顺序猜；
- `eventDecideInfo.eventSpecIdList`（先知揭示后已回填真实 specId）→ 场景族直接 `Math.floor(/100)` 映射，不等 7532 应答再确认；
- `eventInfo.eventSpecId` → 当前执行场景直接分派，不额外拉包；
- `eventCodeBoxInfo.codeNum[5]`(-1=未知) / `eventRollDiceInfo.winRewardResult.items`（掷前可见）/ `eventPickSkillInfo.skillSpecIdList` → 对应场景直接读。

保留的 7531 周期空拉不是冗余而是**漏推自愈**：非 EVENT（WAIT/FIGHT/回城/终局）每拍拉一次，保证错过 21376 状态转换帧时仍能推进（尤其 WAIT→DECIDE 若漏推、60s cycle fallback 才补会错过决断窗）。故本次**不改** 7531 节奏；若要进一步省网络，应以「订阅 21376 转换 + 仅在 `#hunt` 陈旧超阈时补拉」替换现「每拍固定拉」，属可靠性敏感改动、需活动窗口真机验证后再做。

## 20. 出征结束判定改用 21376 状态机 push 为主、7531 降为兜底（用户反馈，2026-10-17，实录报文）

§17 的结束判定挂在 7531 `cs_treasure294`（小队不存在）拒因上，但实证该拒因来得很晚——一局打完后 `treasureId` 仍可查（`7531` 持续 `s=0`）近 90s 才转为 `cs_treasure294`，而服务器**早就用 push 广播了终局**：`21376 status=4(END)@+986s → status=5(RETURN)@+1013s → 21371 team.status=5(ARRIVE)@+1063s → 7531 cs_treasure294@+1078s`。原代码 `#onHuntInfo` 见到 END/RETURN 只 `log.info` 不改状态，于是这 90s 里 `#team` 仍 `status≥MARCHING`、`flow.tick` 继续空拉 7531，直到迟到的 `cs_treasure294` 才由 `#endHunt` 收口——「靠一次 7531 判结束」正出于此。

**修法（push 为主、7531 兜底）**：

- `#onHuntInfo`：`status===END(4)||RETURN(5)` 且推送 `treasureId` 与当前队一致时，直接调 `#finishHunt(...)`（记 `#endedTreasureId` → `#flow.reset()` 停空拉 → `#clearTeam()` 转下一轮）。这是**主判定**，比 7531 拒因早约 90s。
- `#onTeamChange`：新增闸门——队伍 `status≥RETURNING(4)` 或 id 命中 `#endedTreasureId` 即视为结束、**不接管**；若正是当前队则走 `#finishHunt`。堵住「终局的 `21371 team.status=5`（id 仍在非 null）把旧队回填、重启 7531 空拉」这条回环。
- `#endHunt`（7531 `cs_treasure294` 路径）保留为**漏推兜底**：状态机推送丢失时才靠它收口。
- 三条路（状态机 push / 队伍 push / 7531 拒因）统一汇到 `#finishHunt(source)` 收口，日志区分来源。

**分层不变**：`cs_treasure294`/`HUNT_STATUS`/`TEAM_STATUS` 皆本玩法业务语义，收口 feat 内，不上抬 `core/net.js`。`#endedTreasureId` 防陈旧控制器回填的闸（§17）继续生效。

## 21. 科技策略三处调整：镜像复制溢出转幸运 / 末回合保留回合盾 / 来袭预警即保命（用户口径，2026-10-24）

三处均属 `engine-flow.js` 自动项策略调整，无面板开关、无协议变更。

### 21.1 完美镜像(22)：探索回合先知溢出则转复制幸运降临(18)

旧逻辑「严格只复制先知，先知溢出即 `target=0` 停手」——用户新口径：探索回合（WAIT）复制时，若**先知已溢出**（`backpackCount(先知) + round > ROUND_MAX`，剩余回合消化不完、再复制先知无用），则**改复制幸运降临**（背包持有 18 时，翻倍奖励更值），仍无幸运可复制才本轮不复制。实现于 `#explorationSkills`：`chooseCopyTarget` 仍先择先知，命中溢出分支后 `target = copyable.indexOf(SKILL_LUCKY) >= 0 ? SKILL_LUCKY : 0`，日志按目标区分「复制先知/复制幸运降临」。溢出阈值维持 `> ROUND_MAX`（比 pick-skill 的 `>=` 宽一格，因复制在 WAIT(R)、先知消费在 DECIDE(R) 属同一回合），未动。

### 21.2 末回合清空：铜墙铁壁(2) 不再排除

`FLUSH_EXCLUDE` 由 `[先知9, 刷新23, 回合盾2]` 收敛为 `[先知9, 刷新23]`。旧排除铜墙铁壁的理由是「第 10 回合用它抵御『下个回合』已无下回合=浪费」，但用户纠正：第 10 回合后**仍有「返程回合」（HUNT_STATUS.RETURN=5）可被攻击**，铜墙铁壁抵御的正是返程，故须在第 10 回合 EVENT 期用掉。铜墙铁壁是 group=1 队技，`#flushCandidates` 仅队长纳入 teamSkills，天然只队长可清。

### 21.3 来袭保命：收到 21383 预警即立即执行，删「敌强才防」战力门控 + 优先级重排

- **即时性**：`#autoStrategies` 保命分支删除 `await this.#enemyOverwhelms(treasureId)` 闸（旧「敌 max×1.3 > 我 max 才防」会把弱敌预警也吞掉、延误自保），改为**只要 `#raidSize>0` 落在时效窗内即按优先级烧一发自保技**；`#enemyOverwhelms` 方法随之删除（`#reconMarches` 仍服务 #4 侦察补武装与 #mostDamagedUid，未成死码）。保留 `isLeader()` 闸（自保技皆 group=1 队长专属）。
- **优先级重排**：`DEFENSE_PRIORITY` 由 `隐形10 > 毫发盾26 > 回合盾2 > 闪现11` 改为 **`动态隐身(10) > 自由闪现(11) > 毫发无伤(26) = 铜墙铁壁(2)`**，并 `.concat(FIGHT_BUFF_SKILLS)` 追加「其他战中增益族」作尾部兜底（无专属自保技可用时以增益顶）。注：2026-10-17 旧口径「闪现下回合才移动救不了当轮→降到盾后」被本次用户新口径覆盖（闪现回到盾前）。

**闸门**：`node --check` OK、`eslint` 0 error、`npm run build` Done、`npm run arch` 无违规（120 modules）、Prettier 通过。真机端到端验证留待下一夺宝时段窗口（尤其预警即保命是否过烧、镜像复制幸运是否被服务器接受）。

### 21.4 以日志代探针：三处关键决策/消耗均留可观测行（探针来不及，改走真机日志对账）

`#sendPB` 底层已对 7551 留痕（成功 debug `... ok`、拒因 info `... rejected. cmd=7551 code= reason=`），但「为何选此技/消耗在哪个上下文」需上层决策日志。按日志分级（关键动作走 info、循环态走 debug）补三处（tag=CSHUNT，真机直接按下列关键字捞）：

- **验证点①（过烧）**：`来袭保命·已消耗|消耗被拒 <技名>(<specId>)：round=N 来袭规模=M 预警龄=Xms`（每波一条 info，含受理结果）；无可用自保技时 `来袭保命·无可用自保技...` 走 debug（循环态不刷屏）。据此可判弱敌（来袭规模小）是否也在烧盾/闪现。
- **验证点②（镜像复制幸运）**：溢出分流 `完美镜像·先知溢出(持有P+回合R>10)→转复制幸运降临|背包无幸运，本轮不复制` + 结果行 `完美镜像·复制 幸运降临(18)|先知(9) 已接受|被拒(见 reason)`；被拒时下行 sendPB 给具体 reason，直接回答 `copySkillSpecId=18` 是否被服务器接受。
- **验证点③（回合盾末回合用掉）**：`末回合清空·已用|用被拒 <技名>(<specId>)：round=10 池剩K`，铜墙铁壁(2) 出现在此行即证实不再被排除。

## 22. 各场模式矩阵：「按场次设置模式」开关 + 周五/六/日×三场两档矩阵（用户口径，2026-11-19，参考竞品B）

活动持续周五/周六/周日三天、每天三场（03:00–05:00 / 11:00–13:00 / 19:00–21:00）。旧「玩法模式」单下拉只能全局一刀切，无法表达「周五晚固定陪跑、其余主跑」类诉求；参考竞品B设置界面引入按场矩阵。又因「无脑全局切换」与「按场定制」是正交需求，面板用**开关互斥两形态**（用户二次口径）：`modeBySession` 关=只显主设置下拉（与旧版逐字等价）；开=只显 3×3 矩阵（每格主跑/陪跑两档），另一种隐藏。

### 22.1 面板与配置

- 「按场次设置模式」checkbox（`modeBySession`，默认关）居组队段首。关：「玩法模式」下拉（main/helper）显形、矩阵隐藏且**引擎完全忽略格子值**（resolveMode 闸门）；开：下拉隐藏、矩阵显形，互斥显隐走 `fd.showIf`。
- 矩阵 9 格（`ctrlrow` 三行，周五/六/日 × 第一/二/三场，周五行带列头 `fd.head`）每格**两档** `main`/`helper`。扁平键 `modeFri1..modeFri3 / modeSat1..3 / modeSun1..3`（`session-mode.js SESSION_KEYS` 单一真相）。
- **播种**：`follow` 仅作内部「未定制」标记（defaults 全 follow）。开启开关瞬间经 checkbox 模块新增的通用 `fd.onChange(cfg, checked)` 描述符回调（commit 前 mutate，同 rallygrid `fd.onDeleteRow` 先例）调 `seedFollowModes` 把 follow 格回写为当时主设置——落盘与显示同源；已钉 main/helper 的格保留，**off→on 往返不抹定制**。`normalize` 同口径兜底（手改存档开启开关而未走面板回调时）。
- **零迁移**：旧存档 `mode` 键原样保留；`modeBySession`+9 键由 registry 读盘合并 defaults 自动补齐，无需 version/migrate 钩子。开关默认关时有效模式=主设置，与旧行为完全一致（17 份录制×608 笔写×两态主设置=1216 次判定零漂移实证）。
- `isMain`（showIf）：统一模式看主设置；矩阵模式看 9 格 effective（`anySessionMain(cfg, base)`，follow 残留按主设置计）——任一场次可能主跑就展开队长专属参数，全格陪跑才隐藏。
- 显隐工程坑：ctrlrow 带列头是双根节点，而 fields.js 的 showIf `data-dep` 只标首根（会藏头不藏身）→ 带列头时头行+数据行包进单根 div（无类名无 data-fkey，不影响 dispatcher 内联路由）；note 无 key 反查不到 → 补 `key:'sessionNote'`。

### 22.2 场次判定：数据驱动，不硬编码钟表时间

`session-mode.js`（纯函数，同 skills.js/codebox.js 范式可独立单测）：

- `sessionAt(slots, nowMs)`：slots 即引擎 `#slots`（7501 应答 `openTime[]` 经 `csHunt.parseSchedule`，每项 {begin,end} 服务器毫秒）。找含 now 的时段 →「周几」取 begin 的 `getDay()`（只认 5/6/0 → Fri/Sat/Sun）、「第几场」= 同日（`todayStr(begin/1000)` 同串）时段按 begin 排序的序号（1–3）。窗外/非活动星期/同日超 3 场/形态非法一律 null。
- 星期/日界用**本地时区格式化服务器时间**（`todayStr` 口径，与 core/daily-stats「国服 UTC+8 对齐游戏日界」既定约定一致）。
- `resolveMode(cfg, slots, nowMs)`：**开关关（`modeBySession!==true`）恒回 `cfg.mode`**；开关开且命中场次且该格钉 main/helper 取格值，否则回退主设置（follow 残留/窗外/未知时段同口径）。

### 22.3 引擎注入：单点 #cfg() + 按局锁存

- `TeamEngine.#cfg()` 是有效 mode 的**唯一注入点**：base=resolveMode；有队时按 team.id 锁存（`#modeTeamId/#modeVal`，首次见队解析一次），队伍清空解锁、无队期每拍实时解析；`#helperForced`（满次自动转陪跑）再叠其上。返回浅拷贝不改面板引用。
- **按局锁存的必要性**：一局可跨场次边界（如 12:55 开跑 13:10 结束）、跑中改面板也不得漂移——否则 flow 的 isMain/7534-7535 闸会在局中翻转。END 计数 `bumpDailyRun` 用当局锁存模式，语义正确。stop() 复位 `#modeTeamId`。
- 下游零改动：`#noTeam` 建队/找队分叉、7520 op:1/op:2 表态、每日上限闸、`engine-flow.js`（isMain/护奖/幸运/末回合陪跑排除项）全经 `#cfg()`（flow 经 `#flowHost().cfg()`）自动跟随。
- tick 顶 `#helperForced` 复位条件的「主设置陪跑」判据同步改为 resolveMode 有效 base（场次切到陪跑格时强制位正确复位）。
- `snapshot()` 增补 `session`（当前场次）与 `mode`（有效模式，与 #cfg() 同源）；面板状态行：统一模式「玩法模式：主跑（要奖励）」，矩阵模式「玩法模式：按场次矩阵（主设置兜底：主跑）｜本场 周五·第二场 → 陪跑」，未在场次时提示「到点按对应格子运行」。run() 日志追加 `bySession=on/off` 与 sessionModes 矩阵摘要；首次锁存留 info `session mode latched for team <id>: <mode> (session=<label>)`。

### 22.4 叠加顺序与兜底

有效模式 = `满次强制(helper) > 场次格覆盖(main/helper，仅开关开) > 主设置(cfg.mode)`。开关关、格子=follow（未播种残留）、时段表未知、窗外、非活动星期、同日超 3 场 → 沿用主设置（窗外写包本就被 §14/§15 双闸拦截，兜底只影响展示与决策语义）。

## 23. 幸运降临补上「场景无关」的溢出消耗路（用户口径，2026-11-22）

**口径**：技能的使用得按回合算账。幸运降临 `type=10` 落在 `SKILL_TYPE_LIMIT=9` 限窗内，**第 9 回合及之前每回合至多消化 1 张**。第 9 回合背包还持 2 张时，剩余窗只剩第 10 回合一次消耗机会——第 9 回合不烧就注定有一张带出报废，**无论第 9 回合撞上什么场景**。

**旧缺口**：溢出提前烧 `#tryLuckyOverflow` 只接在两个有奖场景（`scenes/pick-reward.js` 点宝前、`scenes/roll-dice.js` 白名单未命中）。r9 若是 pickSkill/codeBox/defPVE/nothing，整回合没有调用点；而末回合清空 `#flushCandidates` 对同一 specId 每回合只发一次 7551（`round:flush:sid` 幂等键），第 10 回合只能清掉一张 → 第二张白攒到终局。

**改法**：`DIGEST_OVERFLOW_SKILLS` 加入 `SKILL_LUCKY`（原闪现 11/百战 1、25/铁壁 2 本就以「族限窗 9 → 每回合至多消化 1 张」为判据，幸运同属该族语义，不必另开一条支路）。FIGHT 是每回合必经结算相位，故烧技与场景无关。判据与闸门全沿用既有那套，不新造：

- `held + round > ROUND_MAX`（与 `#tryLuckyOverflow`、`pick-skill` ③剪枝、镜像复制四处统一的 `>` 口径，见 §21.1 与差一教训）；
- `#canSpend`（= `#usable` 持有且非生效中 + 同族本回合去重）——所以 r9 已在 rollDice 由白名单或 `#tryLuckyOverflow` 烧过一张，FIGHT 就不会再叠烧；
- `${round}:digest:${specId}` 尝试键（每回合每 specId 至多一次，被拒不回退）；
- 陪跑 `mode==='helper'` 跳过（翻倍的是「下一次奖励」，陪跑全程无奖励可翻，与 `#tryLuckyOverflow` 同闸）。

幸运列在清单**首位**：FIGHT 窗仅 13~25s、4s 一拍，同拍还要给掠袭保命/预警式防御让路（`#autoStrategies` 在掠袭处置后非末回合直接 `return`），排末尾有整回合轮不上的风险。

**效果语义**：翻倍挂在「下一次您所获得的奖励」上，r9 FIGHT 烧的这张顺延到 r10 的奖励。若 r10 是 rollDice 且命中已勾池，`#tryLucky` 会因 `#pending` 记 `inEffect=Y` 跳过——由 r9 那张生效中的效果完成翻倍，不亏。

**已知无解边界**：中途入局直接落在第 10 回合且持 2 张（或第 9 回合持 3 张）——服务器每回合限一张，多出的那张本就无法消化；`pick-skill` ③剪枝已保证正常节奏不会攒到这个量。

**日志**：`overflow-burn: burned 幸运降临(18). round=9 held 2 + 9 > 10 (family window cannot digest the rest in remaining rounds)`，sendPB 标签 `overflow-burn`；真机按 `overflow-burn` 关键字即可核对是否补烧成功。

## 24. 陪跑找队退避：整池空转一圈升一档 5→10→15→20s 封顶（用户口径，2026-11-22）

**旧行为**：`#joinTeam` 每拍固定 5s（`JOIN_POLL_MS`），游标走完全池自然回卷，**没有圈数计数也没有降频** —— 空场期（池里没人开车）会以 5s 一发 7530 无限持续，8 人池约每 40s 重扫一遍整池。

**新口径**：以「整池走完一圈仍无可加之队」为一个升档单位，每圈 +一个 `JOIN_POLL_MS`，封顶 `JOIN_POLL_CAP_MS=20000` → **5s → 10s → 15s → 20s（此后不再增长）**。升档只在真打过 7530 且无果的链路上发生（池空 / 全无效 uid 的分支本拍不发搜索，按当前档重排、不计圈）。

**实现要点**（`engine-team.js`）：

- `#joinGap() = min(JOIN_POLL_MS × (#joinIdleRounds + 1), JOIN_POLL_CAP_MS)`，即档位 = 空转圈数 + 1；
- `#joinIdleRounds`（空转圈数）+ `#joinRoundMark`（本圈锚点下标）：游标单调前移，故「本拍搜到的下标 ≤ 锚点」等价于刚走完一圈（尾部无效项被跳过而直接回绕也能命中，不依赖 `cursor===0`）；池被编辑变短（`mark >= n`）即重新锚定，不误升档；
- **归零三处**：发出 7522 申请（已锁定目标队）、散队/换队 `#clearTeam`（新一局找队重回首档，不沿用上一局的 20s）、`stop()`；
- 顶部的节流闸改为按当前档判定，且被推送 `#wake` 早醒时返回「本档剩余」（下限 `JOIN_GAP_FLOOR_MS=300ms` 防紧循环），不再退回 `IDLE_TICK_MS=60s` 长睡 —— 否则 20s 封顶会被 60s 兜底冲淡、升档形同虚设。

**收益账**：稳态下 8 人池一圈 = 8 × 20s = 160s（旧为 40s），7530 频率降到首档的 1/4；同时保留逐成员轮转，新开车队伍最迟 160s 内会被搜到（另受 21371/21373 推送即时 `#wake` 补扫加速）。

**日志**：升档时 info 一行 `join-team: pool swept N round(s) with no joinable team, back off next search to Xs (cap 20s)`；真机按 `pool swept` 关键字即可核对退避是否按档上行。
