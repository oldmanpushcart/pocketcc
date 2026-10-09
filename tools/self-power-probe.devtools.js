/**
 * 自身战力本地读法探测（DevTools 一次性粘贴运行，全程只读、零发包）
 *
 * 背景：自动防御现用一次自查 909 拿 me.power（敌我战力对比闸门）。目标是用本地缓存替代它，
 *   省掉这发 909。但工作树没有反编译源码，无法静态确认 UserData 里那个战力字段到底叫什么，
 *   故用本探针在真机把候选键扫出来，确认后再写 gameData.myPower()。
 *
 * 运行前提：已加载 pocketcc 扩展并登录进游戏，处于 MAIN world 控制台上下文（window.pocketcc 可见）。
 * 贴回：把 A/B/C 三段一起贴回即可定位。
 */
(function selfPowerProbe() {
  const PC = window.pocketcc;
  if (!PC || !PC.game) {
    console.error(
      '[self-power-probe] window.pocketcc 未就绪：确认已加载扩展、已登录、MAIN world 上下文。',
    );
    return;
  }
  const H = (m) => console.log('%c\n===== ' + m + ' =====', 'color:#4a90d9;font-weight:bold');
  // 命中「可能是战力」的键名特征（大小写不敏感）；armyPower 是兵力、power 是战力，都要看
  const RE = /pow|combat|battle|force|fight|strength|zhan|lijun|army/i;

  let DATA, U;
  try {
    DATA = PC.game.get('DataCenter').DATA;
  } catch (e) {
    console.error('取 DataCenter.DATA 失败:', e && e.message);
    return;
  }
  U = DATA && DATA.UserData;

  // 安全打印一个值：原始类型直显，字符串截断，对象只列 own keys（避免刷屏/循环引用）
  const brief = (v) => {
    if (v === null) return 'null';
    if (typeof v === 'string')
      return v.length > 48 ? 'str(' + v.length + '):' + v.slice(0, 48) + '…' : JSON.stringify(v);
    if (typeof v !== 'object') return String(v);
    let keys;
    try {
      keys = Object.keys(v);
    } catch (e) {
      keys = ['(不可枚举)'];
    }
    return (
      'obj{' +
      keys.slice(0, 12).join(',') +
      (keys.length > 12 ? '…+' + (keys.length - 12) : '') +
      '}'
    );
  };

  // ── A. UserData 直属键：全量列出 + 命中战力特征者重点打印 ────────────
  H('A. UserData 直属键');
  if (!U) {
    console.log('UserData 取不到');
    return;
  }
  const ukeys = Object.keys(U);
  console.log('共 ' + ukeys.length + ' 个 own keys');
  const uHits = [];
  ukeys.forEach((k) => {
    let v;
    try {
      v = U[k];
    } catch (e) {
      v = '(读抛出:' + e.message + ')';
    }
    const isFn = typeof v === 'function';
    if (RE.test(k)) {
      uHits.push({ k, v, isFn });
      console.log('%c[命中键名] ' + k + ' = ' + (isFn ? '(函数)' : brief(v)), 'color:#e0a800');
    }
  });
  // 命中键名是函数 → 尝试无参调用看返回是否为数字（候选 getter）
  uHits.forEach((h) => {
    if (h.isFn) {
      try {
        const r = h.v.call(U);
        console.log('  调用 ' + h.k + '() →', brief(r), r);
      } catch (e) {
        console.log('  调用 ' + h.k + '() 抛:', e && e.message);
      }
    } else {
      console.log('  ' + h.k + ' 原值 =', h.v);
    }
  });
  console.log('WorldCoord =', JSON.stringify(U.WorldCoord), '| Level =', U.Level, '| UID =', U.UID);

  // ── B. UserData 下钻一层：数值型且键名命中者（大整数/带 e+ 的 armyPower 也算） ──
  H('B. UserData 下钻一层命中');
  let depthHits = 0;
  ukeys.forEach((k) => {
    let sub;
    try {
      sub = U[k];
    } catch (e) {
      return;
    }
    if (!sub || typeof sub !== 'object') return;
    let sk;
    try {
      sk = Object.keys(sub);
    } catch (e) {
      return;
    }
    sk.forEach((s) => {
      if (!RE.test(s)) return;
      let sv;
      try {
        sv = sub[s];
      } catch (e) {
        sv = '(读抛)';
      }
      if (typeof sv === 'number' || (sv && typeof sv === 'object')) {
        console.log('  UserData.' + k + '.' + s + ' =', brief(sv), sv);
        depthHits++;
      }
    });
  });
  if (!depthHits) console.log('  （下钻一层无命中）');

  // ── C. DATA 顶层其它键 + 常见 getter 名字试探（只读，不改本地态） ──────
  H('C. DATA 顶层键 + getter 试探');
  const dkeys = Object.keys(DATA);
  console.log('DATA own keys:', dkeys.join(', '));
  dkeys.forEach((k) => {
    if (!RE.test(k)) return;
    let v;
    try {
      v = DATA[k];
    } catch (e) {
      v = '(读抛)';
    }
    console.log('%c[DATA 命中] ' + k + ' = ' + brief(v), 'color:#e0a800');
  });
  [
    'getPower',
    'GetPower',
    'power',
    'Power',
    'battlePower',
    'BattlePower',
    'totalPower',
    'combatPower',
    'fightPower',
    'getBattlePower',
  ].forEach((name) => {
    try {
      if (typeof U[name] === 'function') {
        const r = U[name].call(U);
        console.log('  U.' + name + '() →', brief(r), r);
      } else if (name in U) {
        console.log('  U.' + name + ' =', U[name]);
      }
    } catch (e) {
      console.log('  U.' + name + ' 抛:', e && e.message);
    }
  });

  console.log('%c\n贴回以上 A/B/C 三段即可确定本地战力字段/getter。', 'color:#7cb342');
})();
