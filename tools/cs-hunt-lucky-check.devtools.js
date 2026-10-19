/**
 * 夺宝奇兵（CSHunt）幸运降临「漏用」现场探针（DevTools 一次性粘贴运行，MAIN world）
 *
 * 背景：实机 dashcam 20261018T105933（主跑 round6，中奖 820017 顶级催化剂、背包持有幸运 18）里，
 *   引擎未自动 7551 用幸运。代码核对把原因收窄到 `#tryLucky` 的两个静默闸门之一：
 *     (a) cfg.luckyRewards.rollDice 运行时为空（勾选没持久化到 luckyRollDice）；
 *     (b) 中奖 820017 ∉ 已勾池（面板里「顶级催化剂」存的 itemId ≠ 实际奖励 itemId 820017，名称/ID 分歧）。
 *   面板存档与奖励实际 id 都不在报文流里，本探针就地取证区分 (a)/(b)。
 *
 * 运行前提：已加载 pocketcc 扩展并登录进游戏（夺宝面板勾选过「顶级催化剂」）。只读，绝不发包、不改游戏数据。
 *
 * 数据来源（均经 window.pocketcc 公开调试面，不反向摸 feat 内部）：
 *   1) 持久化面板勾选：window.pocketcc.storage.get('pocketcc.feat.csHunt') → .luckyRollDice（number[]）；
 *   2) 运行期幸运池复刻：与 core/game-api.js csHunt.readRewardPool 同逻辑（l10n.tableRows('cross_treasure_event')
 *      的 win_reward 列 → gameData.rewardItems 展开 itemId → item 表取名），只取 rollDice 族（eventSpecId 前缀 1002）；
 *   3) 道具名解析：l10n.tableRow('item', id).name → l10n.text。
 *   对照实机中奖 itemId 820017，输出「引擎当时会不会命中」的最终判定。
 */
(async function csHuntLuckyCheck() {
  const TAG = '[cs-hunt-lucky] ';
  const PC = window.pocketcc;
  if (!PC || !PC.gameApi || !PC.gameApi.l10n || !PC.gameApi.gameData || !PC.storage) {
    console.error(TAG + 'window.pocketcc.{gameApi.l10n, gameApi.gameData, storage} 不全：确认已加载扩展并登录进游戏。');
    return;
  }
  const l10n = PC.gameApi.l10n;
  const gameData = PC.gameApi.gameData;
  const nameOf = (id) => {
    try {
      const row = l10n.tableRow('item', id);
      const nm = row && row.name ? l10n.text(row.name) : '';
      return nm || '道具 ' + id;
    } catch (e) {
      return '道具 ' + id;
    }
  };

  const AWARD_ID = 820017; // 实机 round6 winRewardResult.items[0].itemId（顶级催化剂）

  // ── 1) 面板持久化的勾选值（引擎 toModuleCfg 读的就是它）──────────────────────
  let saved = null;
  try {
    saved = await PC.storage.get('pocketcc.feat.csHunt');
  } catch (e) {
    console.error(TAG + '读持久化配置失败（命名空间未就绪？）：', e);
  }
  const rawLucky = saved && saved.luckyRollDice;
  // 复刻 feat/index.js activeIds：Number、>0、去重 → 归一后即为引擎读的 wl=cfg.luckyRewards.rollDice
  const wl = [];
  const arr = Array.isArray(rawLucky) ? rawLucky : [];
  for (let i = 0; i < arr.length; i++) {
    const n = Number(arr[i]);
    if (n > 0 && wl.indexOf(n) < 0) wl.push(n);
  }
  console.log(TAG + '===== 1) 面板持久化勾选（storage pocketcc.feat.csHunt.luckyRollDice）=====');
  console.log(TAG + '  raw luckyRollDice =', JSON.stringify(rawLucky), ' 归一 wl(rollDice) =', JSON.stringify(wl));
  console.log(TAG + '  已勾项名称：', wl.length ? wl.map((id) => id + '(' + nameOf(id) + ')').join(' , ') : '(空)');

  // ── 2) 运行期幸运池复刻（与 csHunt.readRewardPool 同逻辑，只取 rollDice 族 1002xx）──
  const rollDicePool = [];
  try {
    const rows = l10n.tableRows('cross_treasure_event') || [];
    const rewardCols = ['win_reward', 'reward', 'winReward', 'show_reward'];
    const seen = Object.create(null);
    for (const r of rows) {
      if (Math.floor(Number(r && r.id) / 100) !== 1002) continue; // 只 rollDice
      for (const col of rewardCols) {
        const rid = r && r[col];
        if (rid == null) continue;
        for (const part of String(rid).split(/[|,;\s]+/)) {
          const one = Number(part);
          if (!(one > 0)) continue;
          let items = [];
          try {
            items = gameData.rewardItems(one) || [];
          } catch (e) {}
          for (const it of items) {
            const id = Number(it && it.id);
            if (id > 0 && !seen[id]) {
              seen[id] = 1;
              rollDicePool.push({ id, fromGroup: one });
            }
          }
        }
      }
    }
  } catch (e) {
    console.warn(TAG + ' 运行期池枚举失败（表未下发/符号漂移？活动未开时正常）：', e);
  }
  console.log(TAG + '===== 2) 运行期 rollDice 可翻倍奖励池（readRewardPool 复刻）=====');
  console.log(TAG + '  rollDice 池：', rollDicePool.length ? rollDicePool.map((x) => x.id + '(' + nameOf(x.id) + ')').join(' , ') : '(空)');

  // ── 3) 实机中奖 820017 的名字解析 + 它在不在面板池/运行池 ──
  console.log(TAG + '===== 3) 实机中奖 id ' + AWARD_ID + ' 对照 =====');
  console.log(TAG + '  820017 道具名 =', nameOf(AWARD_ID));
  console.log(TAG + '  820017 ∈ 已勾 wl ?', wl.indexOf(AWARD_ID) >= 0);
  console.log(TAG + '  820017 ∈ 运行期 rollDice 池 ?', rollDicePool.some((x) => x.id === AWARD_ID));
  // 面板里那个「顶级催化剂」到底存成了哪个 id：用名称回联
  const namedPool = rollDicePool.filter((x) => nameOf(x.id).indexOf('催化剂') >= 0);
  console.log(TAG + '  运行期池中名含「催化剂」的项：', namedPool.length ? namedPool.map((x) => x.id + '(' + nameOf(x.id) + ')').join(' , ') : '(无)');

  // ── 4) 最终判定：复刻 hitWhitelist({items:[{itemId:820017}]}, wl) ──
  const hit = wl.indexOf(AWARD_ID) >= 0;
  console.log(TAG + '===== 4) 引擎当时判定（#tryLucky 关键两闸）=====');
  if (!wl.length) {
    console.log(TAG + '  判定：幸运池为空 → 引擎在 if(!wl.length) 静默跳过（原因 a：勾选未持久化到 luckyRollDice，或存到了旧键）');
  } else if (!hit) {
    console.log(TAG + '  判定：已勾 ' + JSON.stringify(wl) + ' 但不含中奖 820017 → 引擎在 hitWhitelist 静默跳过（原因 b：面板勾选项 id ≠ 实际奖励 id 820017，名称/ID 分歧）');
  } else {
    console.log(TAG + '  判定：wl 含 820017，hitWhitelist 应为 true → 引擎理应自动用幸运；若仍未用，则问题在 #usable(18)（背包陈旧/幸运被判生效中），非池匹配——需结合新加的 幸运×2跳过 日志进一步定位');
  }
})();