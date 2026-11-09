// 口袋控制中心 — MAIN world 反节流心跳 shim（document_start 注入，早于游戏 JS 抓取 rAF/setTimeout 引用）。
// 背景：标签页切走/最小化后「加载卡住、后台任务停摆」，实为三层独立成因，本脚本逐层接管：
// 【一】喂帧：Chrome 在隐藏页完全暂停 requestAnimationFrame，Cocos 主循环随之冻结。隐藏期改由
//   「Web Worker 心跳 + MessageChannel」驱动回调——worker 内定时器与 port 消息宏任务均不受后台节流，
//   是唯一能被隐藏页调度的计时源；可见时原样透传原生，零额外开销。
// 【二】伪装可见性：引擎自身也挂了可见性门控（CCGame 在 visibilitychange 里读 document.hidden /
//   document.webkitHidden，Creator 3.x 读 document.visibilityState），一见 hidden 就 game.pause()
//   并把「进入主城」这类阶段切换推迟到前台 resume——只喂帧不开这道门，后台永远停在加载阶段。
//   故把这几个只读属性接管为恒「可见」。浏览器真实节流不受伪装影响，必须与【一】配合才有效果。
// 【三】接管定时器：Chrome 把隐藏页的 setTimeout/setInterval 对齐到 1s、隐藏满 5 分钟后进一步降到
//   1 次/分钟（intensive throttling）。createCycle 的每拍 sleep、session 活性监视、游戏自身心跳都走
//   定时器，被压到 1/min 就等于后台自动化停摆，故隐藏期改由同一心跳按名义时刻派发。
// 两档频率：加载期 60Hz（按帧吞吐推进，低于前台即等比变慢），主城就绪后降为 idleHz 常驻（默认 10Hz）；
//   5 分钟截止的 downshiftAt 兜底——就绪闸门失灵也不会让加载期满速永跑。节拍频率跟随帧率两档
//   （常驻档 =hz、空闲低档 =IDLE_LOW_HZ，仅连续驱动 ≥2min 且无新定时器登记时落低档），
//   定时器延迟上限 = 1/节拍（默认档 ≈100ms、低档 ≈500ms；游戏心跳为 1s 粒度，均安全）。
// 策略入口：registry 的 internal 功能 keepAlive 经 applyPolicy 决定常驻还是彻底交还（面板可关）；
//   boot.js 在主城就绪闸门先 downshift 兜底（授权挂起/配置未读到也不留满速驱动），
//   该闸门迟迟不来时由 startupGuard 到点自行降档；
// 熔断：心跳在本环境不可用（CSP 拦 blob:、worker 被杀、构造成功却一个节拍都不来）时不再重建，并连带撤掉
//   可见性伪装整体回到原生行为——留着「伪装成前台却没人喂帧」比不伪装更糟：引擎以为在前景却拿不到帧，
//   又因为读不到 hidden 而不走它自己的前台恢复分支，反而彻底僵死。
// 约束：必须保持零 import（document_start 时任何 core 模块都尚未就绪，IIFE 独立成包）；
//   包装层常驻不摘（clear* 需按 id 路由回我们代管的条目，摘掉就会漏清），非驱动态一律直转原生。
(() => {
  // 幂等守卫：同 window.__pocketccBridgeInited 口径，防扩展重载后双份监听竞态
  if (window.__pocketccAntiThrottleInited) return;
  window.__pocketccAntiThrottleInited = true;

  /** @type {number} 帧率下限（Hz）：再低日常任务的帧驱动逻辑就明显迟滞 */
  const HZ_MIN = 5;
  /** @type {number} 帧率上限（Hz）：贴齐前台帧率，再高无意义（渲染不会因超 60 而加快） */
  const HZ_MAX = 60;
  /** @type {number} 加载期帧率（Hz）：与前台同速，就绪后由 downshift/applyPolicy 降下来 */
  const HZ_LOADING = 60;
  /** @type {number} 常驻档默认帧率（Hz）：够驱动引擎与 feat 逻辑，隐藏期 CPU 开销可控 */
  const HZ_IDLE = 10;
  /** @type {number} 空闲低档节拍（Hz）：连续驱动 ≥IDLE_AFTER_MS 且无新定时器登记时的驻留节拍，
   *  帧也按此频率出（逻辑减速但会话维持完好）；任何新定时器登记即恢复常驻档 */
  const IDLE_LOW_HZ = 2;
  /** @type {number} 空闲判定窗口（毫秒）：此窗口内有定时器登记就不落低档 */
  const IDLE_MS = 2 * 60 * 1000;
  /** @type {number} 加载期满速保险（毫秒）：armed 起到此截止仍未见就绪降档，startupGuard 自行收为 HZ_IDLE，
   *  防主城就绪闸门失灵导致后台按加载期 60Hz 永跑 */
  const STARTUP_GUARD_MS = 5 * 60 * 1000;
  /** @type {number} 首拍看门狗留量（毫秒）：worker「构造成功但跑不起来」不会同步抛错，靠它兜底熔断。
   *  隐藏页原生定时器最少 1s 粒度，故实际留量在秒级——真机里首拍只需 ~20ms，不会误判 */
  const BEAT_TIMEOUT_MS = 800;
  /** @type {number} shim 帧 id 起始基数：远高于原生 id 空间，避免 cancelAnimationFrame 误清原生请求 */
  const RAF_ID_BASE = 0x52414600;
  /** @type {number} shim 定时器 id 起始基数：与帧 id 段、原生 id 段都错开 */
  const TIMER_ID_BASE = 0x54494d00;

  /** @type {string} worker 源码：自驱动 tick 环，start/stop/改 interval 全由宿主消息控制（裸 setInterval 在部分内核仍被冻结）；
   *  空闲低档与启动保险降档都经宿主 applyTick 重排，无需改本源码。e.data.interval 仅作缺省兜底 */
  const WORKER_SRC =
    'var t=null;self.onmessage=function(e){' +
    'if(e.data.cmd==="start"){if(t)clearInterval(t);t=setInterval(function(){self.postMessage("t")},e.data.interval||20);}' +
    'else if(e.data.cmd==="stop"){if(t)clearInterval(t);t=null;}};';

  // ── 原生引用：包装层常驻，内部一律用这批原生句柄，避免自己调到自己 ──────────
  /** @type {function(function():void, number, ...*):number} */
  const nativeSetTimeout = window.setTimeout.bind(window);
  /** @type {function(function():void, number, ...*):number} */
  const nativeSetInterval = window.setInterval.bind(window);
  /** @type {function(number):undefined} */
  const nativeClearTimeout = window.clearTimeout.bind(window);
  /** @type {function(number):undefined} */
  const nativeClearInterval = window.clearInterval.bind(window);
  /** @type {function(function(number):void):number|undefined} 原生 rAF 原始引用（交还时按身份还原，不把 bind 壳留在页面上） */
  const rafOriginal = window.requestAnimationFrame;
  /** @type {function(number):undefined|undefined} 原生 cAF 原始引用 */
  const cancelOriginal = window.cancelAnimationFrame;
  /** @type {function(function(number):void):number} 原生 rAF 调用句柄（本 shim 自己用） */
  const nativeRaf = rafOriginal
    ? rafOriginal.bind(window)
    : function (cb) {
        return nativeSetTimeout(function () {
          cb(Date.now());
        }, 16);
      };
  /** @type {function(number):undefined} 原生 cAF 调用句柄 */
  const nativeCancel = cancelOriginal ? cancelOriginal.bind(window) : nativeClearTimeout;

  // ── 可见性伪装（第【二】层）──────────────────────────────────────────────
  /** @type {string[]} 被接管的可见性属性名（Chromium 上 accessor 定义在 Document.prototype，实例自有属性同样生效且遮蔽原型）；
   *  webkit 前缀系兼容旧引擎写法（Creator 2.x 平台层会读 document.webkitHidden / webkitVisibilityState） */
  const VISIBILITY_PROPS = ['hidden', 'webkitHidden', 'visibilityState', 'webkitVisibilityState'];
  /** @type {function():boolean|null} 接管前捕获的原生 hidden getter：伪装生效后本 shim 自己的分流靠它读真相 */
  const nativeHiddenGetter = (function () {
    const proto = window.Document && window.Document.prototype;
    const d =
      Object.getOwnPropertyDescriptor(document, 'hidden') ||
      (proto ? Object.getOwnPropertyDescriptor(proto, 'hidden') : null);
    return d && typeof d.get === 'function' ? d.get.bind(document) : null;
  })();
  /** @type {boolean} 事件镜像的真实隐藏态（原生 getter 不可用时的兜底；必须在伪装前取初值） */
  let realHiddenMirror = nativeHiddenGetter
    ? nativeHiddenGetter() === true
    : document.hidden === true;
  /** @type {Array<{key: string, desc: (PropertyDescriptor|undefined)}>} 伪装前的描述符，disarm 逐键还原 */
  const spoofBackups = [];

  /**
   * 把可见性属性接管为恒「可见」：引擎的 visibilitychange 回调里读到 hidden=false，就不会
   * game.pause() 也不再把「进入主城」推迟到前台 resume。拿不到原生 getter 时不伪装——
   * 否则本 shim 自己再也读不到真相，隐藏/可见分流会失效。
   */
  function installVisibilitySpoof() {
    if (!nativeHiddenGetter || spoofBackups.length) return;
    for (const key of VISIBILITY_PROPS) {
      /** 伪装值：hidden 系返布尔 false，visibilityState 系返字符串 'visible' */
      const val = /State$/.test(key) ? 'visible' : false;
      let desc;
      try {
        desc = Object.getOwnPropertyDescriptor(document, key);
        Object.defineProperty(document, key, {
          configurable: true,
          get: function () {
            return val;
          },
        });
        spoofBackups.push({ key: key, desc: desc });
      } catch (e) {
        // 不可配（极旧内核或已被子类化）：该键维持原状，其余键继续伪装
      }
    }
  }

  /** 还原可见性属性：装过自有属性的送回自有描述符，原本只在 prototype 上的直接 delete 让原型 accessor 透回 */
  function restoreVisibilitySpoof() {
    for (const b of spoofBackups) {
      try {
        if (b.desc) Object.defineProperty(document, b.key, b.desc);
        else delete document[b.key];
      } catch (e) {}
    }
    spoofBackups.length = 0;
  }

  /**
   * 本 shim 内部唯一可用的隐藏态读法：伪装生效后 document.hidden 恒 false，
   * 故优先走接管前捕获的原生 getter，取不到时退到事件维护的镜像位。
   * @returns {boolean} 页面真实是否处于隐藏态
   */
  function readRealHidden() {
    if (nativeHiddenGetter) {
      try {
        realHiddenMirror = nativeHiddenGetter() === true;
      } catch (e) {}
    } else {
      // 取不到原生 getter 时 installVisibilitySpoof 早退不装伪装，故 document.hidden 就是真值——
      // 这条兜底位必须自己刷新，否则隐藏页永远 startDriving 不上（或永远 stopDriving 不掉）
      realHiddenMirror = document.hidden === true;
    }
    return realHiddenMirror;
  }

  // ── 心跳与驱动态 ────────────────────────────────────────────────────────
  /** @type {boolean} shim 是否在位（帧接管 + 可见性伪装 + 可见性监听）；false 时一切直转原生 */
  let armed = false;
  /** @type {boolean} 当前是否处于「隐藏 + 在位」的驱动态 */
  let shimActive = false;
  /** @type {number} 当前常驻档帧率/节拍目标（Hz）：低档只在 applyTick 内临时下调 */
  let hz = HZ_LOADING;
  /** @type {number} worker 节拍间隔（毫秒）：初值仅供未驱动时读数，真值由 applyTick 落位 */
  let tickMs = 100;
  /** @type {number} 每几拍出一帧（常驻档恒 1；空闲低档时帧随节拍降频） */
  let frameDiv = 1;
  /** @type {number} 累计节拍计数（历史保留，供排障观察） */
  let beat = 0;
  /** @type {number} 本轮连续驱动起点（毫秒时刻）；0=未驱动 */
  let driveMs = 0;
  /** @type {number} 最近一次「驱动态定时器登记」时刻（毫秒），空闲低档判据；0=从未发生 */
  let idleStamp = 0;
  /** @type {boolean} 当前是否处于空闲低档（变化时打日志） */
  let lowGear = false;
  /** @type {Map<number, function(number):void>} 在飞的帧回调（id -> cb） */
  const pendingFrames = new Map();
  /** @type {number} 帧 id 自增游标 */
  let rafSeq = RAF_ID_BASE;
  /** @type {Worker|null} 心跳 worker（懒建：首进隐藏态才实例化） */
  let worker = null;
  /** @type {MessagePort|null} channel 主线程侧：onmessage 接节拍 */
  let port = null;
  /** @type {MessagePort|null} channel 对侧：承接 worker 节拍转发（port 本身无 port2 属性，必须单独存引用） */
  let tickPort = null;
  /** @type {boolean} 启动保险在挂：置位时 pendingFrames 首次非空且未被认领，由 onBeat 检查到点降档 */
  let guardPending = false;
  /** @type {number} 启动保险截止时刻（毫秒）：arm 时 = 装载时刻 + STARTUP_GUARD_MS */
  let downshiftAt = 0;
  /** @type {number|null} worker 脚本的 blob URL：随 retireTicker 一并 revoke，防长会话反复建退役堆积 */
  let workerUrl = null;
  /** @type {boolean} 心跳熔断位：置位即认定本环境用不了心跳，此后不再重建（见文件头「熔断」） */
  let tickerBroken = false;
  /** @type {number|undefined} 首拍看门狗的原生定时器句柄；undefined=未挂 */
  let beatWatchdog;
  /** @type {number} 挂看门狗时的 beat 快照，用于判断「首拍到底来过没有」 */
  let beatAtStart = 0;

  /** 摘掉首拍看门狗（幂等） */
  function clearBeatWatchdog() {
    if (beatWatchdog === undefined) return;
    try {
      nativeClearTimeout(beatWatchdog);
    } catch (e) {}
    beatWatchdog = undefined;
  }

  /** 退役心跳链路：terminate worker、摘端口引用、revoke blob URL（幂等） */
  function retireTicker() {
    if (worker) {
      try {
        worker.terminate();
      } catch (e) {}
    }
    worker = null;
    port = null;
    tickPort = null;
    if (workerUrl) {
      try {
        URL.revokeObjectURL(workerUrl);
      } catch (e2) {}
      workerUrl = null;
    }
  }

  /**
   * 挂首拍看门狗。针对的失效形态：CSP 对 blob: worker 通常是**异步**拒绝（构造成功、脚本取回失败），
   * 于是 worker 非 null，driving() 判真，可 onBeat 永远不来——代管条目会一直冻到下次状态切换。
   * 故用原生定时器留一个观察窗：窗口内一个节拍都没收到就熔断并整体撤防。
   * 必须用原生句柄而非代管句柄：要防的正是「代管侧没人拍」，不能再依赖它自己。
   */
  function armBeatWatchdog() {
    clearBeatWatchdog();
    beatAtStart = beat;
    beatWatchdog = nativeSetTimeout(function () {
      beatWatchdog = undefined;
      if (beat !== beatAtStart) return; // 首拍已到，心跳确实在跑
      tickerBroken = true;
      stopDriving();
      retireTicker();
      disarm();
    }, BEAT_TIMEOUT_MS);
  }

  /** 懒建「worker + MessageChannel」链路：port 消息是渲染任务宏任务，不需要用户手势也不受节流 */
  function ensureTicker() {
    if (worker || tickerBroken) return;
    try {
      workerUrl = URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' }));
      const w = new Worker(workerUrl);
      worker = w;
      const ch = new MessageChannel();
      port = ch.port1;
      tickPort = ch.port2;
      port.onmessage = onBeat;
      w.onmessage = function (e) {
        // 只认当前这只 worker：退役后迟到的消息不得再驱动节拍（tickPort 已被新链路接管）
        if (w !== worker) return;
        if (e.data === 't' && shimActive && tickPort) tickPort.postMessage(0);
      };
      w.onerror = function () {
        // 已退役（面板关保活 / 已熔断自杀）那只的迟到错误不算新证据，否则会把熔断粘住到刷新为止
        if (w !== worker) return;
        // worker 异常（如 CSP 拦截 blob:）：熔断不再重建（否则每切一次后台就白建一个 worker 并刷一条报错）。
        // 先把手里的帧与定时器全数交还原生、再整体撤防——留着代管条目却没人拍会把它锁死，
        // 留着伪装却不喂帧会让引擎连自己的前台恢复分支都走不到
        tickerBroken = true;
        stopDriving();
        retireTicker();
        disarm();
      };
    } catch (e) {
      worker = null;
      port = null;
      tickPort = null;
    }
  }

  /**
   * 是否真的在出节拍：驱动态 + worker 存活。帧与定时器的接管一律以它为准——
   * worker 建不起来（CSP/资源限制）时绝不代管，退回浏览器原生行为。
   * @returns {boolean} 心跳可用且在跑
   */
  function driving() {
    return shimActive && !!worker;
  }

  /**
   * 算出本拍应使用的节拍频率并同步给 worker。两档：
   *   常驻档 = hz（面板帧率）；空闲低档 = IDLE_LOW_HZ——仅当已过加载期（!guardPending）、连续驱动 ≥IDLE_MS、
   *   近 IDLE_MS 无任何驱动态定时器登记、且确有在飞帧时才落档（帧照此频率出，逻辑减速但会话维持完好）。
   * 定时器延迟上限 = 1/节拍（常驻档 ≈100ms、低档 ≈500ms），游戏心跳 1s 粒度，均安全。
   */
  function applyTick() {
    const now = Date.now();
    lowGear =
      !guardPending && // 加载期不落低档（会拖慢进主城）
      driveMs > 0 &&
      now - driveMs >= IDLE_MS &&
      now - idleStamp >= IDLE_MS &&
      pendingFrames.size > 0 &&
      hz > IDLE_LOW_HZ;
    const tickHz = Math.max(1, lowGear ? IDLE_LOW_HZ : hz);
    tickMs = Math.round(1000 / tickHz);
    frameDiv = Math.max(1, Math.round(tickHz / hz));
    if (worker && shimActive) worker.postMessage({ cmd: 'start', interval: tickMs });
  }

  /**
   * 启动保险：armed 起到 STARTUP_GUARD_MS 截止仍未见过任何就绪降档（downshift/applyPolicy 都会
   * 经 setHz 认领），说明主城就绪闸门失灵，自行把满速的加载期帧率收为常驻档，杜绝后台 60Hz 永跑。
   * 自检查挂在 onBeat 首行——隐藏页里原生定时器会被钳到 1s、满 5 分钟更降到 1/min，靠不住；
   * 而驱动从未启动（全程前台）时不需要保险：原生行为本来就不会过载。
   */
  function startupGuardCheck() {
    if (!guardPending) return;
    if (Date.now() < downshiftAt) return;
    guardPending = false;
    hz = HZ_IDLE;
    applyTick();
  }

  /** 每个心跳节拍：先查启动保险，再扫到期的代管定时器，最后按相位出帧（一帧里引擎会顺带跑完 scheduler）；全程零临时数组 */
  function onBeat() {
    if (!driving()) return;
    startupGuardCheck();
    sweepTimers();
    applyTick(); // 每拍重估两档：新定时器登记会立刻把低档抬回常驻档
    if (++beat % frameDiv !== 0) return;
    // 先快照 id 再逐个摘除执行：回调重入 requestAnimationFrame 时拿到新 id，
    // has+delete 只清旧条目，不会把重排的新请求误删而断掉引擎主循环（id 单调递增保证）
    const ids = []; // 仅出帧拍分配，长度=在飞帧数（个位数）；节拍频率已跟随帧率，不再每 20ms 分配
    for (const id of pendingFrames.keys()) ids.push(id);
    for (const id of ids) {
      const cb = pendingFrames.get(id);
      if (!cb) continue;
      pendingFrames.delete(id);
      try {
        cb(performance.now());
      } catch (e) {}
    }
  }

  /**
   * 包装版 rAF：隐藏且在驱动态时挂入心跳队列，否则原样透传原生。
   * @param {function(number):void} cb 帧回调
   * @returns {number} 帧请求 id（供 cancelAnimationFrame 撤销）
   */
  function rafWrapper(cb) {
    if (typeof cb !== 'function' || !driving()) return nativeRaf(cb);
    const id = rafSeq++;
    pendingFrames.set(id, cb);
    return id;
  }

  /**
   * 包装版 cAF：shim 队列内的 id 直接摘除，其余交还原生。
   * @param {number} id rAF 返回的帧请求 id
   */
  function cancelWrapper(id) {
    if (pendingFrames.has(id)) {
      pendingFrames.delete(id);
      return;
    }
    nativeCancel(id);
  }

  // ── 定时器代管（第【三】层）──────────────────────────────────────────────
  /**
   * @typedef {object} ManagedTimer
   * @property {function(...*):void} cb 回调
   * @property {Array<*>} args 透传实参（原生 setTimeout 的第 3+ 个参数语义）
   * @property {number} ms 名义间隔（interval 重排用）
   * @property {boolean} every 是否周期（setInterval）
   * @property {number} dueAt 下次应触发的本地毫秒时刻（迁移两侧都据此对齐）
   * @property {number|undefined} nativeId 已交回原生重排时的原生句柄；undefined=由心跳代管
   */
  /** @type {Map<number, ManagedTimer>} 代管中的定时器（条目自熄：timeout 触发即删，interval 被 clear 才删） */
  const timers = new Map();
  /** @type {number} 定时器 id 自增游标 */
  let timerSeq = TIMER_ID_BASE;

  /**
   * 到期派发：周期型以当前时刻起重排下一轮（落后不补偿，防追帧风暴），一次型先摘条目再执行。
   * @param {number} id shim 定时器 id
   */
  function fireTimer(id) {
    const t = timers.get(id);
    if (!t) return;
    if (t.every) t.dueAt = Date.now() + t.ms;
    else timers.delete(id);
    try {
      t.cb.apply(undefined, t.args);
    } catch (e) {}
  }

  /**
   * 把一个代管条目交给原生重排（仅用于停驱/撤防交接窗）：一次型按剩余时间，周期型按名义间隔
   * （相位偏移可接受，用 remain 起拖会与心跳侧扫描抢同一个到期点）。条目留在表里，重复停驱不重挂。
   * @param {number} id shim 定时器 id
   */
  function nativeArm(id) {
    const t = timers.get(id);
    if (!t || t.nativeId !== undefined) return;
    const remain = Math.max(0, t.dueAt - Date.now());
    t.nativeId = t.every
      ? nativeSetInterval(function () {
          fireTimer(id);
        }, t.ms)
      : nativeSetTimeout(function () {
          fireTimer(id);
        }, remain);
    t.dueAt = Date.now() + (t.every ? t.ms : remain);
  }

  /**
   * 停驱/撤防交接：把仍由心跳持有的代管条目全数交回原生重排，避免心跳停摆后迟迟不触发。
   */
  function holdTimersForHandoff() {
    for (const id of timers.keys()) nativeArm(id);
  }

  /**
   * 起驱交接（可见→隐藏）：把可见期已交原生重排的代管条目收回心跳持有，按原 dueAt 继续等心跳
   * 扫描（已过期的下一拍立即补发）。游戏 1s 心跳类 setInterval 多在可见期/加载期就登记，
   * 若不收回，它们会被浏览器 intensive throttling 压到 1/min 而致掉线——这正是本层存在的理由。
   */
  function claimTimersForShim() {
    const now = Date.now();
    for (const t of timers.values()) {
      if (t.nativeId === undefined) continue;
      try {
        if (t.every) nativeClearInterval(t.nativeId);
        else nativeClearTimeout(t.nativeId);
      } catch (e) {}
      t.nativeId = undefined;
      if (t.dueAt < now) t.dueAt = now;
    }
  }

  /**
   * 每拍扫一遍代管表，派发所有已到期条目（直接迭代 Map：一次型 fireTimer 先删条目再跑回调，
   * 周期型只改 dueAt，迭代器均不受影响；零临时数组）。表由节拍驱动，频率已跟随帧率两档。
   */
  function sweepTimers() {
    if (!timers.size) return;
    const now = Date.now();
    for (const [id, t] of timers) {
      if (t.nativeId !== undefined || t.dueAt > now) continue;
      fireTimer(id);
    }
  }

  /**
   * 登记并排一个定时器：在位期间一律登记（切隐藏时才能把可见期已排的原生定时器一并收回，
   * 兼及游戏 1s 心跳这类可见期就创建、后台若不接管就会被节流到 1/min 的关键定时器）；
   * 但只有驱动态才由心跳代管，可见期（或 worker 不可用）仍交原生跑，只记句柄与到期时刻。
   * 前台开销仅一次 Map.set（一次型触发即自熄，表不泄漏）。
   * @param {function(...*):void} cb 回调
   * @param {number} ms 延迟/间隔
   * @param {boolean} every 是否周期
   * @param {Array<*>} args 透传实参
   * @returns {number} 定时器 id（本 shim 命名空间，由 clearTimerWrapper 分流）
   */
  function armTimer(cb, ms, every, args) {
    // 不在位（后台保活已关）或回调不可代管（非函数，含字符串形式）：纯透传，不登记
    if (typeof cb !== 'function' || !armed)
      return every ? nativeSetInterval(cb, ms, ...args) : nativeSetTimeout(cb, ms, ...args);
    const id = timerSeq++;
    const d = Math.max(0, Number(ms) || 0);
    timers.set(id, { cb, args, ms: d, every, dueAt: Date.now() + d, nativeId: undefined });
    if (driving()) {
      // 驱动态下有定时器登记 = 确有活跟定时业务在跑：刷新空闲低档判据，把节拍抬回常驻档
      // （心跳类 setInterval 只在创建时计一次，不会持续刷新此位，因此纯挂机能落档）
      idleStamp = Date.now();
    } else {
      nativeArm(id);
    }
    return id;
  }

  /**
   * 包装版 setTimeout。
   * @param {function(...*):void} cb 回调
   * @param {number} ms 延迟
   * @param {...*} args 透传给回调的实参
   * @returns {number} 定时器 id
   */
  function setTimeoutWrapper(cb, ms, ...args) {
    return armTimer(cb, ms, false, args);
  }

  /**
   * 包装版 setInterval。
   * @param {function(...*):void} cb 回调
   * @param {number} ms 间隔
   * @param {...*} args 透传给回调的实参
   * @returns {number} 定时器 id
   */
  function setIntervalWrapper(cb, ms, ...args) {
    return armTimer(cb, ms, true, args);
  }

  /**
   * 包装版 clear*：代管中的 id（含已交回原生重排的）按表摘除并清掉原生句柄，其余交还原生。
   * clearTimeout/clearInterval 语义等价，故不分参。
   * @param {number} id setTimeout/setInterval 返回的 id
   */
  function clearTimerWrapper(id) {
    const t = timers.get(id);
    if (!t) {
      nativeClearTimeout(id);
      return;
    }
    if (t.nativeId !== undefined) {
      try {
        if (t.every) nativeClearInterval(t.nativeId);
        else nativeClearTimeout(t.nativeId);
      } catch (e) {}
    }
    timers.delete(id);
  }

  // ── 驱动开关与在位状态 ──────────────────────────────────────────────────
  /** 启动心跳驱动：置活跃位、建 worker、起节拍。新排定时器自此进代管；可见期已在飞的不收回
   *  （被浏览器钳拍后自然触发一次，见 armTimer 注释），引擎主循环的 rAF 则当场接管 */
  function startDriving() {
    if (tickerBroken) {
      disarm(); // 心跳在本环境已不可用：连带撤掉伪装，别搭一个「伪装在装、无人喂帧」的半架子
      return;
    }
    shimActive = true;
    driveMs = Date.now();
    ensureTicker();
    if (!worker) {
      // 构造函数同步抛错（CSP 直接拒绝）：不代管任何帧/定时器，连带撤伪装
      shimActive = false;
      driveMs = 0;
      tickerBroken = true;
      disarm();
      return;
    }
    applyTick();
    // 定时器/帧当场收回代管，不等首拍：引擎的主循环是「一帧里重排下一帧」，
    // 若延后接管，它会先把 rAF 排到一个永远不会触发的原生请求上，循环当场断掉。
    // 定时器不收回则可见期已排的心跳会一直接原生跑（到背后面被节流），故一并 claim。
    // 代价是最多 BEAT_TIMEOUT_MS（隐藏页里约 1s）的等待窗口，与浏览器自身 1s 对齐同量级，不比默认更差。
    claimTimersForShim();
    armBeatWatchdog();
  }

  /** 停止心跳驱动：帧回调交还原生、代管定时器全数原生重排（可见后立即续上，语义不丢） */
  function stopDriving() {
    shimActive = false;
    driveMs = 0;
    clearBeatWatchdog();
    if (worker) worker.postMessage({ cmd: 'stop' });
    if (pendingFrames.size) {
      const cbs = Array.from(pendingFrames.values());
      pendingFrames.clear();
      for (const cb of cbs) {
        try {
          nativeRaf(cb);
        } catch (e) {}
      }
    }
    holdTimersForHandoff();
  }

  /** 可见性变化分流（走 readRealHidden，不读已被伪装的 document.hidden）：不在位时一律停驱透传 */
  function onVisibilityChange() {
    if (readRealHidden()) {
      if (armed) startDriving();
    } else {
      stopDriving();
    }
  }

  /** 装载 shim：接管 rAF/cAF + 伪装可见性 + 挂可见性监听，布下启动保险，并按当前可见态决定是否起心跳 */
  function arm() {
    if (armed) return;
    armed = true;
    // 启动保险布防：直到被显式降档认领（setHz 里摘）或 startupGuardCheck 到点自收
    if (hz === HZ_LOADING) {
      guardPending = true;
      downshiftAt = Date.now() + STARTUP_GUARD_MS;
    }
    window.requestAnimationFrame = rafWrapper;
    window.cancelAnimationFrame = cancelWrapper;
    // 必须在游戏 JS 执行前接管（本脚本 run_at: document_start 保证这一时序）
    installVisibilitySpoof();
    document.addEventListener('visibilitychange', onVisibilityChange);
    // 装载自检：可能已处于隐藏态（后台标签新开等）
    onVisibilityChange();
  }

  /**
   * 卸载 shim（后台保活关闭时）：停心跳、交还原生 rAF/cAF、恢复真实可见性、摘可见性监听。
   * 定时器包装层常驻不摘（clear 路由需要），非驱动态本就直接透传原生。
   * 幂等：重复调用无副作用；关了之后可在面板重新打开（arm 复位）。
   */
  function disarm() {
    if (!armed) return;
    armed = false;
    stopDriving();
    retireTicker();
    document.removeEventListener('visibilitychange', onVisibilityChange);
    restoreVisibilitySpoof();
    // 按原始身份交还（不是 nativeRaf 那个 bind 壳），避免页面拿到一个伪装成 native 的 bound 函数
    if (rafOriginal && window.requestAnimationFrame === rafWrapper)
      window.requestAnimationFrame = rafOriginal;
    if (cancelOriginal && window.cancelAnimationFrame === cancelWrapper)
      window.cancelAnimationFrame = cancelOriginal;
  }

  /**
   * 钳制帧率到 HZ_MIN~HZ_MAX。
   * @param {number|undefined} v 期望帧率
   * @param {number} fallback 非法/缺省时的回落值
   * @returns {number} 钳制后的帧率
   */
  const clampHz = (v, fallback) => {
    const n = Number(v);
    if (!isFinite(n) || n <= 0) return fallback;
    return Math.max(HZ_MIN, Math.min(HZ_MAX, Math.round(n)));
  };

  // 定时器包装常驻安装（早于游戏 JS 抓取 setTimeout 引用）
  window.setTimeout = setTimeoutWrapper;
  window.setInterval = setIntervalWrapper;
  window.clearTimeout = clearTimerWrapper;
  window.clearInterval = clearTimerWrapper;
  // 初始装载：document_start 即在位，加载期按 HZ_LOADING 驱动
  arm();

  // 挂到 pocketcc 命名空间下（与 boot.js 的 window.pocketcc.event 同一风格；此脚本远早于 boot.js，
  // 故独立对象而非并入 pocketcc，boot 侧只读不建）
  window.pocketccAntiThrottle = {
    /**
     * 应用后台保活策略（registry internal 功能 keepAlive 的 apply 入口，面板改动即热更）：
     * on=true 保持在位并按 hz 常驻（未装载则补装载）；on=false 彻底交还原生行为。
     * @param {boolean} on 是否保活
     * @param {number} [hz] 隐藏期帧率（缺省 HZ_IDLE）
     */
    applyPolicy: function (on, hz) {
      if (on) {
        if (tickerBroken) return; // 本环境心跳不可用：不装伪装也不半搭架子（否则面板显示开着而实际无从自持）
        if (!armed) arm();
        window.pocketccAntiThrottle.setHz(hz === undefined ? HZ_IDLE : hz);
      } else {
        disarm();
      }
    },
    /**
     * 主城就绪兜底：加载期 60Hz 到此为止，降为常驻档（随后 keepAlive 的 apply 会精确落位）。
     * 授权挂起、配置未读到等不走 startFeatures 的路径也靠它收尾。
     */
    downshift: function () {
      if (armed) window.pocketccAntiThrottle.setHz(HZ_IDLE);
    },
    /**
     * 设定隐藏期帧率（钳制 HZ_MIN~HZ_MAX），正在驱动时立即按新频率重排节拍与出帧相位。
     * 任何显式降档（downshift/applyPolicy）都经此，故兼作启动保险的「已就绪」认领位。
     * @param {number} v 期望帧率（Hz）
     */
    setHz: function (v) {
      hz = clampHz(v, HZ_IDLE);
      // 认领启动保险：既然已收到明确的就绪帧率，就不需再到点自降
      guardPending = false;
      applyTick();
    },
    teardown: disarm,
    /**
     * 自检快照（DevTools 观察用）：在位/驱动态、真实隐藏态、帧率与节拍、空闲低档、代管数量、心跳是否已熔断。
     * @returns {{armed: boolean, driving: boolean, hidden: boolean, hz: number, tickMs: number,
     *   frameDiv: number, lowGear: boolean, guardPending: boolean, frames: number, timers: number, broken: boolean}}
     */
    status: function () {
      return {
        armed: armed,
        driving: driving(),
        hidden: readRealHidden(),
        hz: hz,
        tickMs: tickMs,
        frameDiv: frameDiv,
        lowGear: lowGear,
        guardPending: guardPending,
        frames: pendingFrames.size,
        timers: timers.size,
        broken: tickerBroken,
      };
    },
  };
})();
