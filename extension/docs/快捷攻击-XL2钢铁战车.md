# 快捷攻击 · XL2 钢铁战车场景（`src/feats/battle/quick-attack/index.js` 注册表 `xl2` 条目）

**不是独立 feat**：钢铁战车（XL2 战区对决）作为「快捷攻击」面板注册表里的一个场景接入，因此与城市/野怪/遗迹
共用同一条链——预设选择、`plan().preset(n).adjust().build()`（排除在途）、**出征自动切换橙皮四相位**、
855↔902 节奏闸、限流退避重发、面板 onShow/onDisable 钩子，全部零复制。菜单里没有它的卡片。

## 1. 两个面板 = 一个 class，按面板态分流

「我方钢铁战车」与「[Sxxxx]敌方钢铁战车」是同一个 `WorldDragonKingDuelPop`（`subpack2`，点地块由
`NWorldMapTileClickUtils` 开），面板在 `onShow` 里自己算好 `_isEnemy = Number(_tileInfo.extData.childType)===ENEMY`，
`spec.branchOf` 只读这个现成结论，不重造枚举、不看坐标：

| 键              | 我方龙面板（上阵阶段 MATCH_DAY） | 敌方龙面板（进攻阶段 FIGHT_DAY） |
| --------------- | -------------------------------- | -------------------------------- |
| `1`-`8`         | 267 上阵（该预设编队）           | 268 进攻（该预设编队）           |
| `Shift`+`1`-`8` | 同单发（`noTriple`，见 §3）      | 同单发                           |

键形与其余场景完全一致（数字=预设号），**没有新增裸键**；面板关掉后这两个数字键回到原有语义。

## 2. 闸门（逐条复刻游戏，不另造规则）

`spec.gate(comp, branch)` + `attackFlow` 里的流程闸：

| 判据                                       | 游戏里的等价物                                                                                                                |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `joinBtn.node.active`（上阵分支）          | `refreshUI`：`joinBtn.node.active = !_isEnemy && state===MATCH_DAY`——开战后这个按钮根本不绘制，故进攻阶段在我方面板按键会被拦 |
| `battleBtn.node.active`（进攻分支）        | `battleBtn.node.active = _isEnemy && state===FIGHT_DAY`                                                                       |
| `battleBtn.interactable`                   | `…&& _fightStateInfo.state===EDuelFightState.FIGHT`（布防期按钮是灰的，游戏不给点）                                           |
| `_canFightNum > 0`                         | `ShowTips("xl_fight_error_04")` 且不发                                                                                        |
| 该地块无本人在途行军（`uniqueTarget`）     | `joinBattleClick` 第一道闸：`getAllMyMarches()` 比 `target_tx/ty` → `xl_fight_error_03` 且不发                                |
| 行军队列有空位 / 902 不在途 / 预设可派非空 | `startBattleWithCampMarchCheck`、`getAttackerMyArmys().length` → `100272`（这条与其余场景共用同一流程）                       |

按钮/字段取不到时按「不在场」拦（与其余闸「读不到就放行」相反：放行只会把一个游戏一定不会发的包丢给服务器），
表现为一行 `attack blocked by panel gate. key=xl2;branch=…;reason=…` 日志，不会静默失灵也不会误发。

## 3. 为什么 `Shift` 在这里不是三连

实包证明**一次按键 = 一条行军**（应答单 `marchId`，其 `armyInfoList` 9 个部队实例对应 9 个兵格），
而面板第一道闸就是「同地块已有本人行军」，所以三连的后两波必被自拦、白掉两波队列名额 ⇒ `noTriple: true`。
同地块唯一闸（`uniqueTarget`）读 `march.list({cache:true})`（856 播种 + 10019 边沿维护，稳态零网络），
读不到回空即「未知不拦」。副作用：**已上阵且那条行军仍驻在龙上时，再按数字补兵会被这条闸拦下**——这是游戏面板
自己的规则（想改阵容得先召回），日志会写明原因。

## 4. 载荷逐键对齐（真人录制）

`dashcam/store/rec/14179309129759/dashcam-rec-20261126T050256-钢铁战车.ndjson`，**seq=2147**（21:03:03.486，应答成功）：

```
键序  marchType,x,y,armyList,armyListNew,heroList,trapList,break,formation,formationV2,extraArmy
值    267, 396, 468,
      armyList === armyListNew（序列化逐字节相同，条目键 pos,armyId,armyNum）
      pos 1/2/3/11/12/13/21/22/23 → 9 格，armyNum 33×6 + 32×3（前排格容量 33、后排 32，全部发满）
      heroList [169,174,170] · trapList [] · break 0 · formation 0 · formationV2 1003 · extraArmy {}
      无 ext 键、无 activityId 键
```

这套 body 与 `core/march.js` 的 `march.attack()` 现成输出逐键相同（含 `armyList`/`armyListNew` 同数组、
`formation: 0`、不带 `ext`），**组包层一行未改**。

出兵内容走 `plan().preset(n).adjust().build()`，`adjust()` 的重算器口径即「排除已外派」：军阵走
`getAdvFormationMarchCountRemainder`、英雄走 `getHaveHeroCanMarchList()`、部队走零参数 `getAttackerMyArmys()`
（`WorldUtils.getAttackerMyArmys` 默认第二参为在途过滤位）——与面板 `joinBattleClick` 的零参数调用同口径。

## 5. 行军类型取值

`SYM.marchEnum.xl2DuelJoin = 'XL2_DRAGONKING_DUEL_JOIN_MARCH'`（267）、
`xl2DuelBattle = 'XL2_DRAGONKING_DUEL_BATTLE_MARCH'`（268），发包前经 `marchApi.typeOf` 向游戏 `MarchType` 现取，
数值仅符号漂移兜底。`marchApi.resolve` 只对 `attackPlayer`/`worldSite` 做跨服漂移换算，267/268 原值透传。
同块 `XL2_DRAGONKING_DUEL_FAKE_MARCH = 269` 是同地块上的系统假行军（录制里打到同一坐标的那条即是），**勿混**。

## 6. 未实证项

- **268 未录到**。它与 267 同出 `joinBattleClick` → `start_SH_FIRST_STAGE_DEFEND`，只换行军类型号，载荷按同构外推；
  真机首次发出后需与录制对拍。
- **「排除在途」是源码级实证，不是差集级**。录制那场兵池充足（9 格全按格容量发满），包上看不出剔没剔。
  自证法：先故意派掉一队兵再按数字，看 `attack ok … load=<兵量>` 是否比满编少。
- 面板字段名（`_isEnemy` / `joinBtn` / `battleBtn` / `_canFightNum` / `_fightStateInfo`）若随构建漂移，
  表现为「按了没反应 + 一条 gate 日志」，不会误发包。

## 7. 回归入口

```bash
node dashcam/cli.js shape --cmd 902 --dir req          # 看实发包的键集与取值
node .reviewtmp/duel-probe2-1126.mjs                   # 本场录制的 902 摘要 + 应答（探针，只读）
npm run verify:<manifest>                              # 待补：本场景的回放对拍 manifest（需真人录制）
```
