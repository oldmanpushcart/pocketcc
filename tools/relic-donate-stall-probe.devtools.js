/**
 * 联盟遗迹（要塞 WorldSite）捐赠「为什么没捐」诊断器（DevTools 一次性粘贴运行）
 *
 * 背景：面板日志显示科技主链正常捐赠，但遗迹链（1067）没有任何动静。
 *   feats/alliance/alliance-science.js 的 donateRelic() 有 7 道闸，其中 5 道静默
 *   （FunctionOn 闸、allianceRelic() 返回 null、池 7 空、relicBan 冷却、无 donateTarget），
 *   面板上看不出来卡在哪一道。本脚本把每道闸的现场值全部摊开。
 *
 * 逐闸对应关系（脚本段号 → feat 代码闸）：
 *   A) feat 运行态            → reactor 是否真的在跑这个 feat
 *   B) 上游闸                 → tickBody 的荣誉两闸（命中则遗迹整轮不跑）：
 *        ① honorCappedDay 无法从外部读，但若面板刷过 "honor capped by server (addPoint=0)"
 *          即已置位；脚本末尾提示回面板确认。
 *        ② sc.dailyHonor >= sc.honorCap（本地闸，直发包路径下通常恒 false）
 *   C) FunctionOn(Relic_upgrade_time) → donateRelic 首行；false 完全静默停链
 *   D) allianceRelic() 快照   → null 的原因拆解（三层）：
 *        D1 控制器符号 AllianceWorldSiteController / instance / recommendSite 是否还在（符号漂移检测）
 *        D2 UserData.getWorldSiteArrayBy 方法是否还在、Aid 是否可读
 *        D3 要塞原始数组逐项字段（Id/CurLevel/CurExp/DistrictData.upper_level_limit/relic_upgrade）
 *           ——字段名漂移会让可捐口径恒 false → donateTarget=null，这里直接看原始对象兜底
 *   E) 能量池 type=7          → point<=0 是常态（1 小时才回 1 点），看 nextRecoverSec 等多久
 *   F) 金币闸                 → coins() vs relicCostCoin
 *   G) relicBanUntil          → 外部读不到模块私有变量，但可查面板是否刷过
 *        "relic donate locked by phase ban"（跨战区锁，30 分钟静默）
 *   H) 活体探针（默认开）     → 直发 1 枚 1067 看服务端权威应答（消耗 1 点池 7 + 金币）
 *
 * 运行前提：已加载 pocketcc 扩展并登录进游戏、在主世界（MAIN world）控制台上下文。
 *   A~F 段零副作用；G 段真发 1 枚遗迹捐赠（PROBE_DONATE=false 时跳过）。
 */
(async function relicDonateProbe() {
  // ── 活体探针开关：置 true 会真发 1 枚 1067（消耗 1 点遗迹捐赠能量 + relic_coin 金币）──
  const PROBE_DONATE = false;

  const PC = window.pocketcc;
  const gd = PC && PC.gameApi && PC.gameApi.gameData;
  if (!PC || !PC.net || !gd) {
    console.error('[relic-probe] window.pocketcc.net / gameApi.gameData 不可用：确认已加载扩展并登录进游戏（主世界上下文）。');
    return;
  }

  const CMD_DONATE_RELIC = 1067; // RequestId.WORLDSITE_DONATE
  const E_RELIC = 7; // EnergyType.ALLIANCE_WORLDSITE_DONATE_GOLD_NUM
  const E_SCIENCE = 4; // EnergyType.ALLIANCE_DONATE_NUM（对照用）

  const H = (m) => console.log('%c\n===== ' + m + ' =====', 'color:#4a90d9;font-weight:bold');
  const PASS = (m) => console.log('%c✔ ' + m, 'color:#2aa198');
  const BLOCK = (m) => console.log('%c✘ ' + m, 'color:#dc3545;font-weight:bold');
  const WARN = (m) => console.log('%c⚠ ' + m, 'color:#d9822b');
  const jsonOf = (ret) => {
    let d = ret && ret.data;
    if (typeof d === 'string') {
      try {
        d = JSON.parse(d);
      } catch (e) {
        return null;
      }
    }
    return d && typeof d === 'object' ? d : null;
  };

  // ── A) feat 运行态 ──
  H('A) feat 运行态');
  let running = null;
  try {
    running = PC.reactor && PC.reactor.isRunning('allianceScience');
  } catch (e) {
    running = 'isRunning 异常: ' + e.message;
  }
  console.log('reactor.isRunning("allianceScience") =', running);
  if (running !== true) {
    BLOCK('feat 未运行（面板未启用 / 不在 Home·NWorldMap / 战斗模式暂停）。遗迹不捐是必然，先查启用与场景门控。');
    return;
  }
  PASS('feat 在跑。继续逐闸排查遗迹链。');

  // ── B) 上游闸：tickBody 的荣誉两闸（命中则科技遗迹一起停）──
  H('B) 上游荣誉闸（命中会连遗迹一起封）');
  const sc = gd.allianceScience();
  if (!sc) {
    BLOCK('allianceScience() 返回 null：不在盟或 scienceData 未填充 → tickBody 第一行就 return，遗迹链根本没机会跑。');
    return;
  }
  console.log({
    本地dailyHonor: sc.dailyHonor,
    荣誉上限honorCap: sc.honorCap,
    本地闸命中: sc.honorCap > 0 && sc.dailyHonor >= sc.honorCap,
    科技donateTarget: sc.donateTarget,
  });
  if (sc.honorCap > 0 && sc.dailyHonor >= sc.honorCap) {
    BLOCK('本地荣誉闸命中（dailyHonor>=honorCap）→ tickBody 直接 return，遗迹链整轮不跑。');
  } else {
    PASS('本地荣誉闸未命中。');
  }
  console.log(
    '另请回面板日志确认：出现过 "honor capped by server (addPoint=0). stop donating for today." 的话，' +
      'honorCappedDay 当日闸已置位（服务端权威封顶），科技+遗迹两链当天全停、需等零点——这与遗迹链自身无关。',
  );

  // ── C) FunctionOn(Relic_upgrade_time)（donateRelic 首行，false 时完全静默）──
  H('C) 功能开关闸 FunctionOn(Relic_upgrade_time)');
  const fnOn = gd.functionOn('Relic_upgrade_time');
  console.log('functionOn("Relic_upgrade_time") =', fnOn);
  if (!fnOn) {
    BLOCK('此闸为 false → donateRelic() 首行静默 return，遗迹链整条不跑（无任何日志）。' + '\n→ 对照游戏：联盟要塞面板是否已解锁/开放捐赠（可能是等级/开服天数门槛未达，或活动期外关闭）。');
  } else {
    PASS('功能开关已开。');
  }

  // ── D) allianceRelic() 返回 null 的原因拆解 ──
  H('D) allianceRelic() ACL 快照');
  const rl = gd.allianceRelic ? gd.allianceRelic() : null;
  console.log('allianceRelic() =', rl);

  // D1) 控制器符号是否还在（游戏更新后漂移是第一疑凶）
  H('D1) 符号漂移检测：AllianceWorldSiteController');
  try {
    const m = PC.game && PC.game.get ? PC.game.get('AllianceWorldSiteController') : undefined;
    const C = m && (m.AllianceWorldSiteController || (m.default && m.default.AllianceWorldSiteController));
    console.log('module loaded =', !!m, '; class found =', !!C);
    if (!C) {
      BLOCK('require("AllianceWorldSiteController") 拿不到类 → 符号漂移，allianceRelic() 恒 null，遗迹链静默停摆。');
    } else {
      const inst = (C && C._instance) || (C && C.instance);
      console.log('instance exists =', !!inst, '; typeof recommendSite =', inst && typeof inst.recommendSite, '; recommendSite =', inst && inst.recommendSite);
      if (!inst || typeof inst.recommendSite !== 'number') {
        BLOCK('instance 或 recommendSite 字段不在（改名/懒建路径变了）→ probe 校验不过，allianceRelic() 恒 null。');
      } else {
        PASS('控制器与 recommendSite 均在。');
      }
    }
  } catch (e) {
    BLOCK('require 抛错：' + e.message + '（模块名漂移或子包未加载）');
  }

  // D2) UserData.getWorldSiteArrayBy 与 Aid
  H('D2) UserData 要塞数据源');
  const dc = PC.game && PC.game.get ? PC.game.get('DataCenter') : null;
  const u = dc && dc.DATA ? dc.DATA.UserData : null;
  if (!u) {
    BLOCK('DataCenter.DATA.UserData 取不到（符号漂移），allianceRelic() 必然恒 null。');
  } else {
    console.log('typeof u.getWorldSiteArrayBy =', typeof u.getWorldSiteArrayBy);
    const aid = u.Alliance ? Number(u.Alliance.Aid) || 0 : 0;
    console.log('Alliance.Aid =', aid, aid > 0 ? '' : '（<=0：不在盟或 Aid 字段漂移 → allianceRelic() 恒 null）');
    if (typeof u.getWorldSiteArrayBy === 'function' && aid > 0) {
      try {
        const sites = u.getWorldSiteArrayBy(aid) || [];
        H('D3) 本盟要塞原始数组（逐项过 feat 同款可捐口径）');
        console.log('sites.length =', sites.length);
        if (!sites.length) WARN('本盟名下要塞为空 → 无目标可捐（新盟/被打下？）。');
        const rows = [];
        for (let i = 0; i < sites.length; i++) {
          const s = sites[i];
          const dd = s && s.DistrictData;
          const lvl = Number(s && s.CurLevel);
          const exp = Number(s && s.CurExp);
          const capLvl = dd ? Number(dd.upper_level_limit) : NaN;
          const needRaw = dd && dd.relic_upgrade ? String(dd.relic_upgrade).split('|')[lvl - 1] : undefined;
          const need = Number(needRaw) || 0;
          rows.push({
            Id: s && s.Id,
            名称: String((s && (s.SiteName || s.SiteDefaultName)) || ''),
            CurLevel: lvl,
            CurExp: exp,
            等级上限: capLvl,
            本级需求exp: need,
            relic_upgrade有值: !!(dd && dd.relic_upgrade),
            可捐: lvl < capLvl && exp < need,
          });
          if (i === 0 && s) console.log('首个要塞对象 keys =', Object.keys(s));
          if (i === 0 && dd) console.log('首个 DistrictData keys =', Object.keys(dd));
        }
        console.table(rows);
        console.log('allianceRelic().recommendSite =', rl && rl.recommendSite, '; donateTarget =', rl && rl.donateTarget, '; firstDonateable =', rl && rl.firstDonateable);
        const anyDon = rows.some((r) => r.可捐);
        if (!anyDon) {
          BLOCK('没有任何可捐要塞（全部满级或经验已满）→ donateTarget=null，feat debug 一行后静默跳过。需官员发起升级后才继续可捐。');
        } else {
          PASS('存在可捐要塞；若上面 allianceRelic() 却是 null/donateTarget 空 → ACL 口径与现场字段有出入（看 keys 里 CurLevel/CurExp/DistrictData 是否改名）。');
        }
      } catch (e) {
        BLOCK('getWorldSiteArrayBy 抛错：' + e.message);
      }
    }
  }

  // ── E) 能量池 type=7 ──
  H('E) 遗迹能量池（type=7，1 小时回 1 点）');
  const e7 = gd.energy(E_RELIC);
  const e4 = gd.energy(E_SCIENCE);
  console.table([
    e7 ? { 池: '遗迹 type=7', point: e7.point, pointMax: e7.pointMax, nextRecoverSec: e7.nextRecoverSec } : { 池: '遗迹 type=7', point: '（取不到→feat 静默 return）' },
    e4 ? { 池: '科技 type=4', point: e4.point, pointMax: e4.pointMax, nextRecoverSec: e4.nextRecoverSec } : { 池: '科技 type=4', point: '（取不到）' },
  ]);
  if (!e7) BLOCK('energy(7) 取不到 → donateRelic 静默 return。');
  else if (e7.point <= 0) WARN('遗迹池 point=0（未回点）。池 7 每 3600s 回 1 点，比科技池慢一倍——若其它闸都过，只是“还没轮到”，等回点推送即可。');
  else PASS('遗迹池有余量 point=' + e7.point + '。');

  // ── F) 金币闸 ──
  H('F) 金币 vs 遗迹单价');
  const cost = rl && rl.relicCostCoin;
  const coins = gd.coins();
  console.log({ relicCostCoin: cost, 金币余额: coins, 够不够: cost > 0 ? coins >= cost : '单价取不到(0=不拦)' });
  if (cost > 0 && coins < cost) BLOCK('金币不足 → 循环首行 debug 后 break，一单不发。');

  // ── G) relicBan 冷却提示 ──
  H('G) 阶段性禁用冷却（relicBanUntil）');
  console.log(
    '模块私有变量外部读不到。判据：面板 info 出现过 "relic donate locked by phase ban ... pause=30min"' +
      ' ⇒ 之后 30 分钟内遗迹链静默（跨战区 KVK 期间服务端整锁要塞捐赠，属正常）。resume/重启 feat 会清零该冷却。',
  );

  // ── H) 活体探针 ──
  H('H) 活体 1067 捐赠探针');
  if (!PROBE_DONATE) {
    console.log('%c[未执行] 把脚本顶部 PROBE_DONATE 改成 true 再运行，会对当前 donateTarget 真发 1 枚 1067，看服务端 code/raw 应答定位是哪道服务端闸（次数不足/跨战区/满级）。', 'color:#d9822b');
  } else {
    const target = rl && rl.donateTarget;
    if (!target) {
      WARN('无 donateTarget，探针跳过（说明卡点在目标合成，不在发包）。');
    } else if (!e7 || e7.point <= 0) {
      WARN('遗迹池 point=0，发了也会被拒「次数不足」，验不出真实语义；等回点后再跑。');
    } else {
      console.log('即将发 1067 {id:%d,type:1}；捐前池 point=%s，金币=%s', target.id, e7.point, coins);
      try {
        const ret = await PC.net.send(CMD_DONATE_RELIC, { id: target.id, type: 1 });
        console.log({ ok: ret.ok, code: ret.code, raw: ret.data, payload: jsonOf(ret) });
        const p = jsonOf(ret);
        if (p && p.curPoint != null) PASS('服务端接受，curPoint=' + p.curPoint + ' ⇒ 链路全通；若 feat 仍不捐，卡点必在上方某道静默闸（对照面板日志时间线）。');
        else WARN('应答无 curPoint ⇒ 被服务端拒，code/raw 即答案（对照 feat isExpectedReject/isRelicPhaseBan 的关键字）。');
      } catch (e) {
        console.error('[relic-probe] 探针发包异常：', e);
      }
    }
  }

  // ── 汇总 ──
  H('结论指引');
  console.log(
    '按顺序找第一个 ✘/⚠：\n' +
      '  B 命中  → 荣誉封顶（本地或服务端当日闸），两链一起停，等零点；\n' +
      '  C ✘    → FunctionOn(Relic_upgrade_time) 静默闸（最常见且面板零日志）；\n' +
      '  D1 ✘   → 游戏更新符号漂移，需要修 game-api.js 的 allianceRelic()/SYM；\n' +
      '  D3 全不可捐 → 要塞确实没目标（满级/经验满），等官员升级；\n' +
      '  E ⚠    → 只是没回点（1 小时/点），不是 bug；\n' +
      '  F ✘    → 金币不足；\n' +
      '  全绿但 feat 仍不捐 → 大概率 relicBanUntil 在冷却，重载页面或重启 feat 清冷却观察一轮。',
  );
})();
