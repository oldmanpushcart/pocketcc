# 假面舞会（maskDance）基地宝箱自动领取

> 面板位置：**活动设置 → 基础设置 → 假面舞会**（只出启用开关，无选项）
> 状态：**协议已实证（领取链路 + 派对分享卡 + 跨服基地领取）+ 运行时缺口待探针坐实**
> 报文实证：2026 万圣节活动真人实录（`dashcam-rec-20261124T231252-我的日常`：跨服基地坐标卡侦查链路；
> `dashcam-rec-20261125T002604-我的日常`：跨服 2503 真实到账与逐道具日限对账）
> 探针：`tools/halloween-box-probe.devtools.js`

## 1. 玩法口径（游戏文案原文）

- 活动族：**假面迷城 / 假面宝藏**（2026 万圣节，活动 id `38015600`，`desc=halloween_video_026`）。
- 道具族（`item_name_26061700x`，同挂配置表 `mask_mystery_party`）：
  | itemId    | 名称                   | 获取途径                         |
  | --------- | ---------------------- | -------------------------------- |
  | 260617001 | 假面舞会               | 假面宝藏活动（击败假面士兵）     |
  | 260617002 | 假面-藏宝图            | 打造泰坦装备概率                 |
  | 260617003 | 假面-机甲              | 芯片超频概率                     |
  | 260617004 | 假面-复合资源          | 采集资源概率                     |
  | 260617005 | （本次实录的宝箱载体） | 活动积分档位奖励 `type=1 pt=200` |
  | 260617006 | 领取后到账的抽奖券     | 2503 应答 `rewardResult.items`   |
- 关键文案（`mask_mystery_lottery_026/027`）：
  > 「使用该道具可开启一次假面舞会。开启舞会的指挥官可获得一份开启奖励，同时**本盟指挥官可前往参加舞会领取奖励**！」
  > 「假面舞会在**开启者的基地**举办，本联盟所有指挥官可前往领取该奖励！」
  > 道具描述：「**今日剩余可领奖次数：{0}**」→ 每日限额，用户口径 **20 次/天**（藏宝图 / 机甲 / 复合资源各算各的）。

所以「宝箱」不是新道具，而是 **MASK_DANCE（假面舞会）族的 `cityReward` 机制**：盟友在自己基地开一次舞会，
全盟每人可以去点一次宝箱领奖。

> **2026 万圣节「派对」与「假面舞会」是同一套逻辑、同一张表、同一个 2503**（客户端源码实证）：
> 两者都走 `UserItemCityRewardBtn/Panel` + `mask_mystery_party` + `NRequestIdV2.DANCE_GET_REWARD`，
> 差异只在道具行的 `item_id / share_msg_key / msg_type / daily_limit / reward_num / cruis_times`。
> 因此 feat **不按道具号写死任何参数**，一律以 `mask_mystery_party` 行值为准。
>
> **每日限额是「逐道具」口径**，不是全族共享：客户端闸门写的是
> `mask_mystery_party[itemId].daily_limit > UserData.itemCityRewardReceivedNum[itemId]`，
> 道具描述里的「今日剩余可领奖次数」也按单个 itemId 算（`UserItemCityRewardBtn` 回调、`ItemData.GetDes` 一致）。
> 旧文档「跨所有舞会实例共享」的表述有误，已按源码订正——把各道具求和去比单个 `daily_limit`，
> 会在多道具年份（如 260617005 与 260617006 并存）提前静默封顶。

## 2. 协议族（NRequestIdV2 2501~2504 段，实证 + 枚举）

| cmd      | 枚举名                        | 载荷                                   | 用途                 | 实证              |
| -------- | ----------------------------- | -------------------------------------- | -------------------- | ----------------- |
| 2501     | `MASK_DANCE_DRAW_DRAW`        | 待探针                                 | 舞会抽奖             | 仅枚举            |
| 2502     | `MASK_DANCE_DRAW_GET_HISTORY` | 待探针                                 | 抽奖历史             | 仅枚举            |
| **2503** | **`DANCE_GET_REWARD`**        | `{targetUidStr:"<开启者 pid 字符串>"}` | **领奖（核心动作）** | ✅ 报文 line 2332 |
| **2504** | **`DANCE_GET_LIST`**          | `{itemId:<宝箱道具 id>}`               | **全量舞会列表查询** | ✅ 客户端源码     |

PB 名映射（`PBMsgSetting`）：`2503:{req:"PBReqDanceGetReward",ack:"PBAckDanceGetReward"}`、
`2504:{req:"PBReqDanceGetList",ack:"PBAckDanceGetList"}` → 两条都走 `sendPBV2`（主通道）。

### 2.1 领取闭环（报文逐键实证）

```
req:sendPBV2 2503 DANCE_GET_REWARD  {"targetUidStr":"863595288866"}
resp         2503                    {header:{ts,s:0}, data:{rewardResult:{items:[{itemId:260617006,itemCount:1}], resource:{…全 0}}}}
push 10402 PUSH_ITEMS                {items:[{itemId:260617006,amount:1}]}
push 10053 PUSH_USER_DATA_COMMON     {danceRec:{"260617005":1}, myReceiveDance:["4909640309826248704"]}
push 10018 PUSH_TILEINFO             该城 p.cityReward.num 由 26 → 27
```

- `danceRec`：**按宝箱道具 id 计的今日已领次数**（`{"260617005":1}`）——**逐道具**限额的权威分子，
  不能跨 id 求和后去比单个 `daily_limit`。
- `myReceiveDance`：**今日已领过的舞会实例 id 字符串数组**（幂等判据，同一实例只能领一次）。
- 两者在 `UserData` 上的落地字段名已由源码坐实：`itemCityRewardReceivedNum` / `itemCityRewardReceivedInstIds`；
  登录期是否全量下发仍**未实证**（缺口 §4-2 剩项）。

**第二例（dashcam-rec-20261125T002604，7 笔领取全部发生在别的服）**：

```
req:sendPBV2 2503  {"targetUidStr":"7746199587372"}      // pid 由 901 按坐标反查，卡面本身不带 pid
resp 2503          {rewardResult:{items:[{itemId:260604017,itemCount:1}], resource:{…全 0}}}
push 10053         {danceRec:{"260617002":5,"260617003":1,"260617004":1}, myReceiveDance:[…7 个实例 id]}
```

| 载体道具  | 名称          | 到账物    |
| --------- | ------------- | --------- |
| 260617002 | 假面-藏宝图   | 260604017 |
| 260617003 | 假面-机甲     | 260604018 |
| 260617004 | 假面-复合资源 | 260604019 |

- **到账物随载体道具分条**（上一例的 260617006 对应的是另一个载体号），所以记账/面板只认 `items[]` 不作判据。
- `danceRec` / `myReceiveDance` 的**下发时机已实证**：每次 2503 受理后立即随 10053 下发，且 `danceRec` 逐道具值
  与 feat 日志 `box claimed … today=N/20` **逐条相等**（7/7）→ 限额分子主路是服务器权威值，本地镜像只补“推送未到/重装后”的空窗。
- 同份报文里 **10018 视口推送零条 `cityReward`**（36 条命中全来自 901）→ 宝箱城都在视口外时，聊天卡 + 跨服 901 是唯一发现通道。

### 2.2 cityReward 载体（瓦片通道，`901` / `10018` 的 `pointType=1` 玩家城 `p` 内）

```json
"cityReward": {
  "itemId": 260617005,
  "instanceId": "4909640309826248704",
  "num": 27,
  "players": [ { "frameId": 4, "playerInfo": "{…username…}" }, … ],
  "endTimeMilli": 1793464766642
}
```

- `instanceId`：**字符串**（19 位，超安全整数，禁止 Number 化）。
- `num`：**不可当领取闸门**。旧记录本字段读作「本场已被领总次数」（`num=26/27/33`），但
  dashcam-rec-20261124T231252 里同一实例（`4944408023060814345`）在 63s 内 `num` 从 **482 跳到 740**，
  而客户端 `refreshUI` 拿它去比的 `reward_num` 是按钮上的小量级数字——两者不同量级，
  说明 `num` 至少是跨服/跨时段的累计口径。客户端自己只用它渲染文案（`e<=0` 则销毁按钮），
  竞对B 的领取链**完全不查 `reward_num`**——所以下游一律交服务器裁决（被拒即当日拉黑）。
- `players[]`：**只是最近领取者的展示名单（无 uid）**，不能用来判「我领没领」，判据只有 `myReceiveDance`；
  实录里它也可以是空数组（`players: []`）而宝箱照样可领。
- `endTimeMilli`：舞会到期毫秒。实录两例：`1793464766642` / `1793464825113`，客户端 `cpnUpdate1000MS` 每秒比对、
  到期销毁按钮 → **舞会有效期约 30 分钟**（领取时刻 1793462979 距到期约 1787s）。

### 2.3 分享卡（聊天通道）——**两条发卡路径，只有一条带 pid**

**A. 坐标分享卡**（`PostChatMsg(670)` `m="link"`，实录 line 3326）：

```json
{
  "t": 0,
  "st": 4,
  "p": { "x": 352, "y": 474, "z": 4336 },
  "s": "100级 [CMSY]🏝️木木",
  "icon": "…",
  "pid": "863595288866",
  "uts": 1
}
```

- `t=0 POSITION` / `st=4 基地`，**`pid` 正是 2503 的 `targetUidStr`**，`p.{x,y,z}` 是基地坐标（z=服号）。

**B. 活动分享卡（= 用户截图里那条「快来参加 XX 正在举办的万圣节派对!」）**：
`t=48 ACTIVITY_COMMON2`，由 `newChatController.sendChatLinkActCommon2(e,t,o,a,i,r,n)` 编码成
`llm = {t:48, icon:o, s:a, p:i, extra:r, actt:n}` —— **该函数根本不写 `pid`**（渲染端 `NNewShareCommonItem2`
也只读 `icon / s / p.x / p.y / extra.*`，「前往」只按坐标跳转）：

```json
{
  "t": 48,
  "icon": "m/UserItemCityReward/images/<msg_banner>",
  "s": "<share_msg_key>",
  "p": { "x": 352, "y": 474 },
  "extra": {
    "btnKey": "102385",
    "aid": 0,
    "expireTime": 1793464766,
    "contentParams": ["<开启者显示名>"],
    "jumpServerId": 4336
  },
  "actt": "<msg_type>"
}
```

客户端发这条卡的入口有两个，**都不带 pid**（源码实证）：

| 入口                                                      | 频道 args[0] | `p` 来源                           | `expireTime`               | `jumpServerId`            |
| --------------------------------------------------------- | ------------ | ---------------------------------- | -------------------------- | ------------------------- |
| `UserItemCityRewardPanel.shareCtrl`（未领玩家点「分享」） | `"1"`        | 分享者自己的 `UserData.WorldCoord` | `ServerTime + cruis_times` | `UserData.OriginServerId` |
| `UserItemCityRewardBtn.awardClick` 已领分支（领过再分享） | `"2"`        | 舞会所在瓦片 `tileX/tileY`         | `endTimeMilli/1000`        | `extData.w`               |

> **这就是本轮「派对卡没触发领取」的根因**：旧实现把 `llm.pid` 当入队前置条件，而 t=48 卡结构上就没有
> pid；又因为远处的城不在 10018 视口推送范围内（10018 只覆盖当前视口），一次性聊天卡往往是唯一发现源
> → 候选根本进不来。现按「pid 可选、缺失时由 901 按坐标反查 `p.pid`」处理（竞对B 同口径：卡片只当坐标用）。

- 实录里 `c=0`（**世界频道**）与玩法口径的「联盟频道」不一致：分享者可以把卡片转发到任意频道，
  因此 feat **不按频道白名单过滤**（见 §5）。
- `p.z` 在 t=48 卡上恒为 `cc.v2` 的 0 假值，**真实服号只在 `extra.jumpServerId`**（与仓内
  `feats/system/chat/classify.js` 的取号口径同源）；本 feat 按 `jumpServerId → p.z → p.s` 取首个 >0。

## 3. 客户端源码实证（2026-11-01 更新后的 `UserItemCityReward*`）

```js
// UserItemCityRewardBtn.init：配置表按 **item_id 列**查，不是按主键
this._itemParamCfg = TABLE.getTableByKeyFromBuffer(TableName.mask_mystery_party, "item_id", cityReward.itemId)[0];
// 分享视觉参数：shareCfg[itemId] 存在则用，否则兜底 shareCfg[1]（本版 shareCfg 只定义了 [1]
//   → 假面舞会与万圣节派对共用同一套卡片样式，进一步坐实「同一套逻辑」）
// 本地冷却（非领取闸门）：ServerTime - ACT_JM_SHARE<pid> > cruis_times 时才显示按钮
// refreshUI：`reward_num - cityReward.num` 算作「本场共享剩余名额」，<=0 直接销毁按钮
//   （仅渲染：2026-11-24 实录证伪了 `num` 是「本场已领次数」的假设，本 feat 不把该差值当发包闸门）
// setIcon：itemCityRewardReceivedInstIds.indexOf(String(instanceId)) > -1 → 换「已领」图
// 已领该实例 → 点击变成「再分享」
if (UserData.itemCityRewardReceivedInstIds.indexOf(String(cityReward.instanceId)) > -1) { sendChatLinkActCommon2(…); return; }
// 未领 → 直接发 2503，不派行军
if (!NET.checkRequestIdNoRes(NRequestIdV2.DANCE_GET_REWARD))
  NET.sendPBV2(NRequestIdV2.DANCE_GET_REWARD, { targetUidStr: String(tileEntity.extData.pid) }, this, cb);
// 领取成功回调里的面板文案：daily_limit - itemCityRewardReceivedNum[itemId]（**单个 itemId**）
```

四条硬结论：

1. **领取是纯发包**（点头顶宝箱 → 2503），**不派 902 行军**。实录里 117 条 `marchType:321` 的行军是
   其他玩家「前往舞会」的图面行军，与本端领奖无关。
2. **射程闸门未在任何发包判据里出现**，但客户端只在「视口里能看到那座城」时才渲染按钮 →
   服务端是否校验距离 **待探针实测**（缺口 §4-1）。
3. 幂等判据是 `instanceId` 字符串（`myReceiveDance`），**不是坐标、不是 pid**。
4. **读 `mask_mystery_party` 必须按 `item_id` 列扫表**（Btn/Panel 与 `ItemData.GetDes` 三处一致，全部走
   `getTableByKeyFromBuffer`）。而 `TableManager.getTableDataById` 只认表的**主键**——主键另有其列时
   恒返回 null。旧实现走 `l10n.tableRow(…)`（=主键查法），导致：未知道具（如派对新号）被白名单闸
   误拦、`daily_limit`/`reward_num` 静默兜底。已新增 `l10n.tableRowByKey(semantic, field, value)` 收口
   这一能力（差异不是便利而是正确性），并在 `SYM.tables` 登记 `maskMysteryParty: 'mask_mystery_party'`。

## 4. 运行时缺口（探针负责坐实）

| #   | 缺口                                                                                                      | 状态                                                                                                                                                                                                |
| --- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 2503 是否有距离闸门（远处基地能否领）                                                                     | 待探针 §4（若拒则拿到拒因键）                                                                                                                                                                       |
| 2   | 登录期 `10053` 是否全量下发 `danceRec`/`myReceiveDance`；`UserData` 上的 getter 名                        | **字段名已由源码解决**；领取后即时下发**已由实录坐实**（§2.1 第二例），登录期是否全量仍待探针 §1 §3                                                                                                 |
| 3   | `2504 DANCE_GET_LIST` 应答形状：`danceList[]` 是否含 `instanceId`/坐标/`pid`/`received`/`expireTimeMilli` | 待探针 §5                                                                                                                                                                                           |
| 4   | `mask_mystery_party` 整表：`item_id`/`daily_limit`/`reward_num`/`cruis_times`/`msg_type` **实值**         | **列名已由源码坐实**（feat 直接按这些列读），行实值与派对新道具号仍待探针 §2                                                                                                                        |
| 5   | 活动 `38015600` 的 `type_para7`（= 2504 请求的 itemId）                                                   | 待探针 §2                                                                                                                                                                                           |
| 6   | 基地在**别的服**时 2503 会不会被服务端拒                                                                  | **已解决（dashcam-rec-20261125T002604）**：目标服为 2656/4255/4053/3912/3228 等跨服基地的 7 笔 2503 **全部受理并到账**（`rewardResult.items` 非空、无一条被拒）；现策略不变（照发，被拒即当日拉黑） |

> 表行实值拿不到的原因：配置表数据不在分包 JS 里（资源目录只有 `manifest.json`，行数据是
> 运行时加载的表资源），所以只能从源码拿到**列名与用法**，拿不到**具体数字**。feat 已设成「表就绪则全自动
> 适配来年换皮号，表未就绪则兜底 20 次/天（用户口径）+ 已知道具族」，不依赖人工回填。

## 5. feat 实现（`feats/activity/mask-dance/index.js`）

**双输入通道 → 一条候选队列 → 逐条排空**：

- 通道 A（推送驱动，零成本）：`ctx.on.chat('push')` 命中 `t=0`（基地 `st=4`）或 `t=48` 活动卡且带 `p.x/p.y`
  的卡片 → 候选 `{key,pid,x,y,sid,exp,src:'chat'}`。**`pid` 不是入队前置条件**（t=48 卡结构上就没有），
  缺失时置空串、由 901 按坐标反查；入队前先按 `extra.expireTime`（两条发卡入口都是绝对秒截止点）
  丢弃过期卡，省一次 901；`expireTime` 同时存进候选的 `exp`，供闸门 2 的探针短路判「是不是同一场」。
  去重键：有 pid 用 pid，无 pid 只能用坐标 `x:y`。
- 通道 B（推送驱动，零成本）：`ctx.on.push(10018)` 遍历 `pointInfos[]`，`pointType=1` 且 `p.cityReward` 在场即候选
  （宝箱道具 id 白名单**经 `mask_mystery_party` 表按 `item_id` 核验后**才登记，覆盖来年换皮号；已领与当日拉黑的实例在此
  就地拦掉——10018 是约 3 条/秒的视口增量流，漏拦会让同一座城反复入队换走无谓的 901）。
- 两条通道都只喂候选，**静默期零发包**；`createCycle` 只负责排空队列与日切复位（有候选 20s、空队列 5min）。
- `2504` 未接入常规循环（形状未实证，缺口 §4-3），只由探针承接；实证后它可作「全量舞会 + 今日剩余次数」的权威源。
- 领取执行：候选 → `901 fetchWindow(x,y,{k:目标服号, viewLevel:0, width:20, height:30})` 定位该城，拿权威
  `cityReward` 快照**与 `p.pid`** → 闸门链 → `2503 {targetUidStr:pid}` → 记账。
  - **`viewLevel` 强制取 0（全量点）**而非 `fetchWindow` 默认的 1：`viewLevel≥1` 服务器按层级聚合精简，
    可能把目标城聚掉（实证：游戏自己视口的 901 请求体即 `viewLevel:0`）。
  - **按坐标反查 pid 已用两份实录坐实**：卡片 `p:{x:352,y:474}` 与那边 10018 点位的
    `x=352 y=474 pointType=1 pid=863595288866 itemId=260617005` **逐等**；
    dashcam-rec-20261124T231252 卡面 `S:4301 X:456 Y:420` 与那边 901 点位 `x=456 y=420 k=4301 pid=15346158112973`
    **逐等** —— 所以「坐标→城→pid」反查可行。
  - 认城口径（**pid 优先、坐标兜底**）：先按 pid 认；**pid 在窗内未命中则回落按 `x/y` 相等认**，pid 从点 `p.pid` 反查
    （经 `bits.int64Str` 归一，JSON 里它是数字）。旧口径「有 pid 就只认 pid」在**转发别人基地坐标卡**时失效——
    卡面 pid 不肯定向于城主人，会恒落 `absent`、重试 3 次后永久漏领。
    **反查不到 pid 就不发包**（无地址可寻，不能盲发 2503）。
- **跨服卡照查**（旧版「直接跳过」已被实录证伪）：卡面服号（`extra.jumpServerId → p.z → p.s`）>0 时
  **直接当 901 的 `k`**，与本服不同时只记一条 debug。实证：本服 `k=4402` 语境下发
  `{x:456,y:420,k:4301,viewLevel:0}` 完整换回了 4301 那座城及其 `cityReward`（游戏自己点跳卡就是这条请求）；
  竞对B 同口径（卡片 `z` → `getTile serverId` → 901 `k`）。旧版担心的「在本服同坐标领到一座无关的城」
  只在 `k` 拿错时发生，这里 `k` 就是卡面声明的服号。

**闸门（fail-closed，按实际执行顺序）**：

1. 本服服号 `worldMap.serverId()` 拿不到（≤ 0，UserData 未就绪）→ 回填重试（901 的 `k=0` 只会换回空应答）。
   目标服号取 `卡面 sid > 0 ? sid : own`——跨服卡不在此拦（见上「跨服卡照查」）。
2. **重复卡探针短路**（`probeMemo`：`目标服:坐标 → {inst,endSec}`，上界 200、跨日清空）：上一轮 901 已查到那场舞会，
   而它**仍在自己窗口内且已定局**（已领或当日拉黑）时直接跳过这次 901——拉黑键是 `instanceId`、只有查完才拿得到，
   旧版因此为每张重复卡白送一次探针（实录：一天 62 次探针只覆盖 27 个唯一目标）。放行条件从严：
   无记档、记档那场已过 `endTimeMilli`（同一座城可再开新一场）、卡面 `expireTime` 与记档末点不等（那是另一场）、
   或记档实例尚未定局——**任一取不到就照常探针**，宁可多查一次也不漏领（命中记 debug）。
3. 901 定位分档回填（见下）；反查不到 `pid` → 不发包（无地址可寻，不能盲发 2503）。
4. **道具白名单（两条通道对称）**：`cityReward.itemId` 必须属于舞会族（已知族命中，或在 `mask_mystery_party`
   表按 `item_id` 有行）；非舞会载体一律不发 2503——聊天路径绕过了通道 B 的预筛，这道闸是它对外的唯一防线。
5. `myReceiveDance` 含该 `instanceId` → 跳过并当日拉黑（同实例只领一次）；实例已在当日拉黑名单 → 跳过。
   两条出口各记一行 debug（带 `inst`/`pid`/坐标/`k`），保证「发了 901 但没领」在日志里可归因。
6. `cityReward.endTimeMilli/1000 <= serverTime()` → 跳过并当日拉黑该实例。
7. **逐道具日限**（取代旧的全局合计判据）：`claimedByItem(itemId) >= daily_limit(itemId)` → 跳过并当日拉黑。
   分子取「权威 `itemCityRewardReceivedNum[itemId]` 与本地镜像」的**较大者**（两者描述同一件事，相加会翻倍误封顶）；
   分母读 `mask_mystery_party[itemId].daily_limit`（无行/字段为空则兜底 20，用户口径：藏宝图/机甲/复合资源各 20 次/天）。
   来源每道具每天各记一行：读到表值记 debug，读不到记一次性 warn（`src=no-row|empty-field`）——实录里全天分母恒 `/20`
   且 `party seats` 零命中，此前无法区分「表给的就是 20」与「兜底撑起的 20」。与游戏闸门同判据（源码 §3）。
8. **本场共享名额 `reward_num - num` 只记 debug、不再当闸门**（旧版把它当跳过条件，已被实录证伪）：同一实例
   63s 内 `num` 482→740，与 `reward_num` 不同量级，拿它当闸门会把每场舞会都误锁（把不存在的规则写进判据）。
   名额真用完由服务器拒 2503，走下面「一个实例最多撞一次墙」的当日拉黑。
9. 2503 在途（`net.isSending(2503)`）→ 回填本候选等下一拍，不就地丢弃。
10. **不做本地射程闸门**：服务端是否校距离未实证，索性交服务器裁决；真超距收到业务拒即当日拉黑该舞会实例，
    **一个实例最多撞一次墙**，不会逐拍重发刷日志（探针 §4 一旦证实「远处不能领」，再考虑把闸门加回来）。

cycle 的长睡判据是「**全族皆满**」（`allItemsCapped`：每一个能读到 `daily_limit` 的道具都已撞顶）——
逐道具口径下「某个道具撞顶」推不出「这个箱子不能领」；一条限额都读不到（表未就绪）时返回 false，
宁可继续巡检也不误睡掉整天。

**901 失败分三档**（`probe` 请求未成功 / `absent` 窗内既无该 pid 也无该坐标的城 / `no-reward` 城在场但不带 `cityReward`），
只有前两档回填重试（同候选封顶 3 次、隔 20s）：候选已出队，而 901 抖动若不回填，对「唯一发现源是一次性
聊天卡」的候选等于永久漏领；`no-reward` 是当日确定结论也是噪声卡的常态，重试只会把无效 901 的成本放大。
噪声卡因此仍只花一次地图查询，**不会发出 2503**。

**记账镜像**：直发 2503 不回写游戏本地态（红线：竞对B 会 `itemCityRewardReceivedInstIds.push(…)` 改写本地数据，
我们不效仿），故 `todayByItem`/`mirrorInstIds` 走内存 + `storage.data` 镜像
（键 `maskDance.mirror`，存档带 `date`、跨日失效，**读回完成后才允许落盘**）。权威值与本地态是**并入**而非覆盖：
`ctx.on.push(10053)` 里 `myReceiveDance` 按并集合并（下发口径记的是增量，实录只有单元素样本无法证伪，
覆盖式赋值会把先前记下的已领 id 全冲掉）；存档回灌同样取 `max` / 并集（读盘窗口里可能已有权威推送落到内存）。
旧版存档只有全局 `claims`（无法归到具体道具），逐道具口径下**主动丢弃**：多领的代价是一次被服务端拒的
2503，比把限额拍扁成全局导致整天不领可接受得多。`claimedCount()`（逐道具取较大后求和）**只供日志**，
不得用作封顶判据。
游戏侧态经 `game-api.js` 新增的 `gameData.maskDanceState()` 只读快照收口（ACL，feat 不裸读符号）；
该方法的角色由候选表**显式声明**（不靠名字正则）并给计数加了量级安全阀，因为
`itemCityRewardReceivedInstIds` 里的 "Rec" 会被次数表判据误命中、而数组的 `typeof` 也是 `object`；
一旦把 id 数组当成次数表，19 位实例 id 被 Number 化（精度已丢）会把「今日已领」拉成天文数字，
导致当日静默封顶且与「额度用尽」表现完全一致、无法归因。

**面板**：无选项（对齐「每日补给/海上夺宝」的日常形态：`fields: []` + `defaults:{enabled:false}`），参数全内置：
每日上限按道具直读 `mask_mystery_party.daily_limit`（表未就绪兜底 20）、宝箱道具 id 用假面迷城已知族 + 运行期经
`mask_mystery_party` 表核验后学习、频道不做硬白名单（实录卡片 `c=0` 发在世界频道）。

**生命周期**：`places:['base','world']`、`kinds:['homeland']`、`offInCombat:true`（不派兵但占网络，战斗期让位）；
`install` 先做 **ACL 硬依赖自检**（`HARD_DEPS`：`gameData.serverTime/maskDanceState`、`worldMap.serverId`、
`l10n.tableRowByKey`、`bits.int64Str`、`map.fetchWindow`，外加 `net.sendPBV2/isSending`），
拿不到就直拒安装——把成员挂错对象（实证过：误写 `gameData.serverId()`，而该函数在 `worldMap` 上）
eslint 看不出，运行期却是「每一拍 cycle 抛 TypeError、只在 warn 里一闪而过」，面板上看得到启用但实际一条包都不发；
其余不变：`run` 挂订阅 + 读回镜像后才 kick，且**镜像读回前 `enqueue` 直接拒收候选**
（否则推送侧的即时 kick 会绕过该保护，拿 `todayByItem={}` 半截态去判限额）；`pause` 清候选队列并作废镜像读回标记
（cycle 到点自判 `alive()` 终止，不重建定时器）。

## 6. 变更记录

- 2026-11-25（**真机 A/B 复核 + 探针浪费/日志盲区修复**，出处 dashcam-rec-20261125T002604 与扩展日志 20261125）：
  - 跨服照查在真机生效：旧代码段（00:01–00:19）10 张跨服卡全部 `card points to another server, out of reach`、**0 领取**；
    00:19:58 新代码装载后 00:20:32 起 71 候选 → **25 笔 `box claimed`**（藏宝图 17/20、机甲 3/20、复合资源 5/20），
    全天 0 warn / 0 error；`today=N/20` 与服务器 `danceRec` 逐条相等，00:33:52 重装后 `mirror merged. claims=13` 自愈合并。
  - 新增**探针短路** `probeMemo`（闸门 2）与 `PROBE_MEMO_MAX=200`；候选新增 `exp`（卡面 `extra.expireTime`）。
  - `claimOne` 两个静默 `return`（实例已拉黑 / 已领）补上 debug 出口日志，对齐「每个 skip 出口必带决策上下文」
    ——旧版 71 候选/25 领取，其余 40 余笔在日志里完全看不出原因。
  - `dailyLimitOf` 新增限额来源日志（`table` 走 debug，`no-row`/`empty-field` 走一次性 warn），用于销掉缺口 §4-4 的歧义。
  - 缺口 §4-6（跨服 2503）**已销**：7 笔跨服领取全部受理并到账。

- 2026-11-24（**跨服坐标卡漏领修复**：三条旧假设由「dashcam-rec-20261124T231252 实录 + `UserItemCityRewardBtn`
  源码 + 竞对B」交叉定谳）：
  - **根因 A（致命）**：`claimOne` 把「卡面服号 ≠ `worldMap.serverId()`」的候选直接跳过。实录证明游戏自己在
    本服 `k=4402` 语境下发 `{x:456,y:420,k:4301,viewLevel:0,width:19,height:33}` 完整换回了 4301 那座城及其
    `cityReward`（`itemId=260617002` 藏宝图、`instanceId=4944408023060814345`）——用户看到「偶尔能领到」正是
    这条路径。现按卡面服号照查（`dst = cand.sid > 0 ? cand.sid : own`），跨服只记一条 debug。
  - **根因 B**：认城只按卡面 `pid`。用户场景是**转发别人的基地坐标卡**，卡面分享人的 pid 不等于城主人
    （实录目标城 `pid=15346158112973`），会恒落 `absent`、重试 3 次后永久漏领。现改「pid 优先、坐标兜底」，
    pid 从命中点位的 `p.pid` 经 `bits.int64Str` 反查。
  - **根因 C**：`reward_num - cityReward.num <= 0` 被当成「名额已被领完」的闸门。同一实例 63s 内 `num`
    482→740，与 `reward_num` 量级不符 → 该判据会把每场舞会都误锁（把不存在的规则写进判据）。
    降为 debug advisory，名额交服务器裁决。
  - 探针窗新增 `PROBE_WINDOW = 20×30`（对齐游戏跳图的 19×33 与竞对B 的 20×30，默认 20×20 纵向偏窄会掉城）；
    `DAILY_LIMIT_FALLBACK` 由 10 改 **20**（用户口径：藏宝图/机甲/复合资源各 20 次/天）。
  - 本份录制 4751 行里 **无 2503 / 无 2504 发包**（用户只跳图查看），且 14 条 10053 逐条核过均未下发
    `danceRec`/`myReceiveDance` → 缺口 §4-2 仍在，本地镜像记账不可省。

- 2026-11-15（**「1 领记 2」竞态修复**：dashcam 实录坐实 10053 权威推送先于 2503 应答到达
  （push `claims=1` 在前、`box claimed today=2` 在后 2ms）——应答续体无条件 `+1` 把已含本实例的镜像翻倍，
  而 push/面板均 `max(权威, 镜像)` 只升不降，脏值当日锁定并落盘。修复：应答记账改**按实例幂等**
  （实例已在册 = 推送先记过账，不补计数）；新增 `sanitizeMirror` 自洽闸（sum(byItem) > insts 数即脏账，
  丢计数保名单，交权威重建），loadMirror 与 onUserDataPush 合并后各跑一次，存量脏账重启/推送即自愈。

- 2026-11-01（真机报错修复）：`claimOne` 误调 `gameData.serverId()`——该函数挂在 `worldMap` 上，不是 `gameData`，
  导致「cycle run threw. TypeError: gameData.serverId is not a function」每一拍抛错（本 feat 从领取链启动起就
  一条包都没发）。改 `worldMap.serverId()`，并补两项：本服服号 ≤0（UserData 未就绪）时按「可翻转失败」回填重试
  （901 的 `k=0` 只会换回空应答）；`install` 加 ACL 硬依赖自检，让这类「成员挂错对象」在 install 期就 fail fast。

- 2026-11-01（**万圣节派对分享卡未触发修复**：三条根因均由「源码 + 竞对B + 实录」交叉定谳）：
  - **根因 A（致命）**：`onChatMsg` 把 `llm.pid` 当入队前置条件，而活动分享卡（`t=48`，
    `sendChatLinkActCommon2` 两个入口实证都不写 pid）结构上就没有 pid；远处的城又不在 10018 视口
    推送范围内 → 一次性聊天卡往往是唯一发现源 → 候选根本进不来。现改为「pid 可选 + 901 按坐标反查 pid」
    （实录坐实卡片坐标与点位坐标逐等），并把探针 `viewLevel` 从 1 改为 0（游戏自己视口的 901 即 `viewLevel:0`，
    防聚合把目标城聚掉）；卡面服号按 `jumpServerId → p.z → p.s` 取首个 >0，跨服卡直接跳过。
  - **根因 B（上一轮修复引入的回归）**：白名单/限额核验走 `l10n.tableRow`（= `getTableDataById`，只认主键），
    而游戏对 `mask_mystery_party` 全程按 `item_id` 扫表 → 未知道具（派对新号）恒判假被拦、`daily_limit`/
    `reward_num` 静默兜底。ACL 新增 `l10n.tableRowByKey` 并登记 `maskMysteryParty: 'mask_mystery_party'`。
  - **根因 C**：日限额按「全局求和 vs 单个 `daily_limit`」比较，源码定谳应为**逐道具**口径
    （`daily_limit > itemCityRewardReceivedNum[itemId]`，竞对B 同判据）→ 多道具年份提前静默封顶。
    改 `claimedByItem`/`dailyLimitOf`/`itemCapped` 三个逐道具函数，长睡改 `allItemsCapped`，
    `claimedCount()` 降为只供日志；旧版全局 `claims` 存档主动丢弃。
  - 竞对B 快照交叉印证：卡片只当坐标用 → `getTile` 拿 `extData.cityReward` →
    过期/逐道具 `daily_limit`/`itemCityRewardReceivedInstIds` 三闸 → `asendPBV2(2503,{targetUidStr})`；
    它会给 `itemCityRewardReceivedInstIds.push(…)` 改写本地数据，我们仍只读不回写。
  - build / lint(0 err) / arch / test(17) / prettier 全绿。

- 2026-11-01（代码审查后修复）：`maskDanceState()` 的字段角色改由候选表显式声明 + 计数量级安全阀
  （原名字正则会把 `…ReceivedInstIds` 数组误归成次数表 → 19 位 id 被 Number 化 → 当日静默封顶）；
  道具白名单补齐到聊天路径（与瓦片路径对称）；宝箱 id 的学习改经 `mask_mystery_party` 表核验；
  通道 B 补查当日拉黑名单（避免被拒实例反复入队换走 901）；901 失败改分三档并只对可翻转的两档回填重试；
  `myReceiveDance` 与存档回灌均改为并入（并集 / `max`）；镜像读回前 `enqueue` 拒收候选。

- 2026-11-01（定稿）：改名 **假面舞会**，挂到 **活动设置 → 基础设置** 并去掉面板选项（`fields: []`，只留启用开关）；
  每日上限改读配置表 `daily_limit`（兜底 10），**取消本地射程闸门**（交服务器裁决 + 当日拉黑）。
- 2026-11-01（实现回填）：候选通道改为 **push 10018 + 聊天卡双推送喂队列**（`2504` 不进常规循环，交探针实证）；
  不按频道白名单过滤（实录卡片 `c=0` 世界频道）；
  镜像落盘改走 `storage.data`（键 `maskDance.mirror`）并加「读回后才允许写」闸门；
  面板挂 `core/menu.js` 活动设置 + `content.entry.js` import，build/lint/arch/test 全绿。
- 2026-11-01：报文 + 客户端源码实证 2503/2504/`cityReward`/`myReceiveDance` 全链路；落地 feat 与探针，
  §4 五项缺口待真机探针回填。
