/**
 * 次元矿洞 · ② 盗窃与封存引擎（StealEngine）
 *
 * 职责：只在「裂隙矿场」(7415) 里——偷取(7419) / 封存(7420) / 加速帮忙(7418)。
 *   - 检测(读池 refresh:0)与刷新(换矿 refresh:1)解耦：
 *       刷新按冷热权重把每日预算(≈30)均铺到 20:00；检测按事件(刷新点/矿就绪/兜底 5min)驱动。
 *   - 偷/封/加速都依「已勾选规则」过滤目标；无规则则不换矿（不白耗每日预算），仍可免费读池观测。
 * 有自己的队列/drain/定时器/刷新预算，与 ① 挖矿完全独立。
 * 注：盟友矿「帮忙封存」已按需求取消，封存只发生在裂隙矿场，故 packLeft 名额专属于本引擎。
 */
import { CODE_NOT_SENT, todayStr } from '../../../core/util.js';
import { createLog } from '../../../core/log.js';
import { createDrain } from '../../../core/drain.js';
import { gameData } from '../../../core/game-api.js';
import { storage } from '../../../core/storage.js';
import { idKey, int64ToNum, rejectText } from './util.js';
import { activeRules, matchSpec, specStar } from './match.js';

const log = createLog('MINE-CAVE/STEAL');

/** @type {string} 当日「偷取线已处理矿」拉黑持久数据键（storage.data blob 内逻辑名，按自然日落盘）*/
const STEAL_BLOCKED_NAME = 'mineCave.stealBlocked';

// ── ② 盗窃封存：本引擎独占的协议号（无跨文件复用，故就近私有）──
const CMD_WORLD_INFO = 7415; // 裂隙矿场（refresh:0 读 / refresh:1 换矿）
const CMD_STEAL = 7419; // 偷取
const CMD_HELP_PACK = 7420; // 封存/帮打包
const CMD_HELP = 7418; // 加速帮忙
const ACTION_GAP_MS = 1200; // drain 相邻两次动作的最小间隔（本引擎发送节奏，与 ① 各自独立）

// ── ② 专属调度阈值 ──
const WORLD_HOURS_END = 20; // 每日刷新须在 20:00 前用完；间隔按剩余次数+冷热权重分配到此时刻
const WORLD_MIN_REFRESH_GAP_MS = 60_000; // 动态刷新节流下限，避免临近截止时密集触发频控
const WORLD_HOT_W = 2.5; // 热点时段每小时刷新权重（更密）
const WORLD_COLD_W = 1.41; // 冷时段每小时刷新权重
const WORLD_CHECK_MAX_MS = 300_000; // 无待办事件时，检测最迟每 5min 一次（兜底捕捉矿池变化）
const WORLD_TARGET_JITTER_MS = 15_000; // 矿就绪时刻后延迟一点再检测，避免边界未刷新
const WORLD_READ_MIN_GAP_MS = 60_000; // 世界池最小读取间隔
const STEAL_BLOCKED_LOAD_RETRY_MS = 4_000; // 偷取拉黑读盘看门狗：刷新间隙 bridge 未注入会让 get 永不 settle，
//   超此时间放开闸门重开一笔读（player-like/alliance-rally 同款）
const STEAL_GATE_RETRY_MS = 1_500; // 拉黑集未读回时，不出偷取任务后的快速重试间隔（远小于常规扫描节奏）
const STEAL_BLOCKED_LOAD_GRACE_MS = 20_000; // fail-open 宽限：读盘持续失败超此时间照常出偷取任务，宁重撞 code=3 也不让功能哑火

/**
 * ② 盗窃与封存引擎：只在裂隙矿场(7415) 偷取/封存/加速帮忙。
 * 拥有独立的队列 / drain / 定时器 / 世界刷新预算，与 ① 挖矿解耦。
 * （盟友矿“帮忙封存”已按需求取消，封存只发生在裂隙，故 packLeft 名额专属本引擎。）
 */
export class StealEngine {
  #env;

  #queue = [];
  #scanning = false;
  #consuming = false;
  #scanPending = false;
  #scanTimer = null;

  #lastWorldTs = 0;
  #worldBudgetTotal = 0;
  #worldCanRefreshLeft = 0; // 服务器剩余可刷新次数（权威硬停）
  #nextWorldRefreshAt = 0; // 下次「换矿刷新」时刻（冷热加权均分到 20:00）
  #nextWorldCheckAt = 0; // 下次「检测读池」时刻（综合刷新点/矿就绪/兜底）
  #worldEndTs = 0; // 当日裂隙活动结束时刻（日界/额度重置参考）
  #stealDoneNum = 0;
  #stealMaxNum = 0;
  #packDoneNum = 0;
  #packMaxNum = 0;
  #packLeft = 0;
  #stealBlockedToday = new Set(); // 当日拉黑按动作维度分离：偷取线独占，避免 pack 误伤同矿的 steal（反之亦然）
  #packBlockedToday = new Set(); // 封存线独占
  //   偷取线拉黑按自然日持久化到 storage.data：7415 列表的 stealNum/canSteal 是换矿前快照、不反映
  //   「别人实时偷光」，同一批陈旧可偷死矿会在每次 reload 后被重复排队、重复撞 code=3(mine_cave72)。
  //   落盘后跨 reload 不再重试；refresh:1 换矿后矿 id 变、旧 key 自然失效，不会误伤新矿。
  #stealBlockedLoaded = false; // 盘上拉黑是否已读回（未读回前不落盘，避免拿内存空集覆写真值）
  #stealBlockedDay = ''; // 内存拉黑集归属的自然日（todayStr 口径，跨日清空重载）
  #stealBlockedLoading = false; // 读盘是否在飞（配合看门狗避免每轮扫描叠加 pending）
  #stealBlockedLoadAt = 0; // 本笔读盘发起时刻（超 RETRY_MS 未 settle 则视为丢回执、重开）
  #stealBlockedFirstLoadAt = 0; // 首次发起读盘的时刻（fail-open 宽限计时起点）
  #stealGateWait = false; // 本轮因拉黑集未读回而暂不出偷取任务→下轮用短间隔快速重试
  #drain;

  /** @param {import('./mining.js').MineEngineEnv} env 共享运行环境 */
  constructor(env) {
    this.#env = env;
    this.#drain = createDrain({
      log: log,
      queue: { get: () => this.#queue },
      alive: () => this.#env.alive(),
      process: (t) => this.#execTask(t),
      interval: () => ACTION_GAP_MS,
    });
  }

  // ─────────── 生命周期 ───────────
  /**
   * 启动引擎：重置状态并触发首轮扫描（世界刷新靠自身预算定时器，不订阅推送）。
   * @param {*} _ctx reactor 运行上下文（本引擎不消费）
   */
  start(_ctx) {
    this.#reset();
    log.info('steal-pack started.');
    this.#loadStealBlocked(); // 异步读回当日已处理矿拉黑（读回前用内存集照常运行，短窗口可接受）
    this.#triggerScan();
  }

  #reset() {
    if (this.#scanTimer) {
      clearTimeout(this.#scanTimer);
      this.#scanTimer = null;
    }
    this.#scanning = false;
    this.#consuming = false;
    this.#scanPending = false;
    this.#queue = [];
    this.#stealBlockedToday.clear();
    this.#packBlockedToday.clear();
    this.#stealBlockedLoaded = false;
    this.#stealBlockedDay = ''; // 重启需重新读盘（start 会调 #loadStealBlocked 重填）
    this.#stealBlockedLoading = false;
    this.#stealBlockedLoadAt = 0;
    this.#stealBlockedFirstLoadAt = 0;
    this.#stealGateWait = false;
    this.#lastWorldTs = 0;
    this.#worldBudgetTotal = 0;
    this.#worldCanRefreshLeft = 0;
    this.#nextWorldRefreshAt = 0;
    this.#nextWorldCheckAt = 0; // 归零→启动先 refresh:0 读 canRefreshNum 重建计划
    this.#worldEndTs = 0;
    this.#stealDoneNum = 0;
    this.#stealMaxNum = 0;
    this.#packDoneNum = 0;
    this.#packMaxNum = 0;
    this.#packLeft = 0;
  }

  kick() {
    if (this.#env.alive()) this.#triggerScan();
  }

  // ─────────── 规则匹配包装 ───────────
  #match(specId) {
    return matchSpec(specId, this.#env.getRules());
  }
  #activeRuleCount() {
    return activeRules(this.#env.getRules()).length;
  }

  // ─────────── 当日偷取拉黑持久化（按自然日，跨 reload 不再重试同一批死矿） ───────────
  /**
   * 异步读回当日已处理偷取矿拉黑（单飞）。读失败不置 loaded：
   *   storage.data.get 在 UID 前缀未设时是 reject，保留下次重载机会；未 loaded 前 #persistStealBlocked 不写盘，
   *   避免拿尚不齐的内存集覆掉盘上真值。日期不符今日则丢弃旧集（自然日已换）。
   * @returns {void}
   */
  #loadStealBlocked() {
    if (this.#stealBlockedLoaded) return;
    // 在飞且未超时：不叠加；超时未 settle（丢回执）：放开闸门重开一笔。合并是 Set 幂等，
    //   多个回执迟到先后落地只会并集、不会互斥，故无需世代号。
    if (
      this.#stealBlockedLoading &&
      Date.now() - this.#stealBlockedLoadAt < STEAL_BLOCKED_LOAD_RETRY_MS
    )
      return;
    var today = todayStr();
    this.#stealBlockedDay = today;
    this.#stealBlockedLoading = true;
    this.#stealBlockedLoadAt = Date.now();
    if (!this.#stealBlockedFirstLoadAt) this.#stealBlockedFirstLoadAt = Date.now();
    Promise.resolve(storage.data.get(STEAL_BLOCKED_NAME))
      .then((saved) => {
        this.#stealBlockedLoading = false;
        this.#stealBlockedLoaded = true;
        if (
          saved &&
          typeof saved === 'object' &&
          saved.date === today &&
          Array.isArray(saved.keys)
        ) {
          for (var i = 0; i < saved.keys.length; i++) this.#stealBlockedToday.add(saved.keys[i]);
        }
        // 读回前若已有 add（首轮竞态）则内存集⊇盘：补落一次，否则这批 key 会随 reload 丢失
        this.#persistStealBlocked();
      })
      .catch(() => {
        this.#stealBlockedLoading = false; /* UID 未就绪等：不置 loaded，下次扫描重试 */
      });
  }

  /**
   * 将当前偷取拉黑集落盘（fire-and-forget，写失败不阻断主流程）。
   * 仅 loaded 后才写（否则可能拿不完整内存集覆盘）；跨日收敛由 #rollStealDay 在扫描开头统一做。
   * @returns {void}
   */
  #persistStealBlocked() {
    if (!this.#stealBlockedLoaded) return;
    Promise.resolve(
      storage.data.set(STEAL_BLOCKED_NAME, {
        date: this.#stealBlockedDay,
        keys: Array.from(this.#stealBlockedToday),
      }),
    ).catch((err) => {
      log.warn('steal blocked persist failed.', err);
    });
  }

  /**
   * 自然日跨日收敛：引擎跨过午夜长驻时，旧一天的拉黑 key 无意义且会撞新一天合法偷取——
   * 一旦 todayStr 变了就清内存集、置 loaded=false 并重读盘（新一天盘上为空则自然得到空集）。
   * 放在 #worldTasks 开头、任何 add 之前调用，避免误清刚加入的 key。
   * @returns {void}
   */
  #rollStealDay() {
    var today = todayStr();
    if (this.#stealBlockedDay && this.#stealBlockedDay !== today) {
      this.#stealBlockedToday.clear();
      this.#stealBlockedLoaded = false;
      this.#stealBlockedDay = today;
      this.#loadStealBlocked();
    }
  }

  // ─────────── 世界刷新/检测调度（冷热加权铺到 20:00；检测事件驱动） ───────────
  #worldHourWeight(h) {
    var slots = this.#env.tuning.hotSlots;
    for (var i = 0; i < slots.length; i++) {
      if (h >= slots[i][0] && h < slots[i][1]) return WORLD_HOT_W;
    }
    return WORLD_COLD_W;
  }
  #todayHourTs(ts, h) {
    var d = new Date(ts);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, 0, 0, 0).getTime();
  }
  #worldWeightBetween(t0, t1) {
    var sum = 0,
      cur = t0;
    while (cur < t1) {
      var h = new Date(cur).getHours();
      var segEnd = Math.min(this.#todayHourTs(cur, h + 1), t1);
      sum += ((segEnd - cur) / 3_600_000) * this.#worldHourWeight(h);
      cur = segEnd;
    }
    return sum;
  }
  #worldTimeToWeight(t0, target, endTs) {
    var cur = t0,
      acc = 0;
    while (acc < target) {
      var h = new Date(cur).getHours();
      var w = this.#worldHourWeight(h);
      var segEnd = Math.min(this.#todayHourTs(cur, h + 1), endTs);
      var avail = ((segEnd - cur) / 3_600_000) * w;
      if (acc + avail >= target) return cur - t0 + ((target - acc) / w) * 3_600_000;
      acc += avail;
      cur = segEnd;
      if (cur >= endTs) return Infinity;
    }
    return cur - t0;
  }
  // 下次刷新时刻：剩余权重/剩余次数=单次权重，再按当前起的小时密度换算成时间。每轮刷新后重算。
  #planWorldRefresh(now) {
    var end = this.#todayHourTs(now, WORLD_HOURS_END);
    if (end <= now || this.#worldCanRefreshLeft <= 0) {
      this.#nextWorldRefreshAt = Infinity;
      return;
    }
    var perRefresh = this.#worldWeightBetween(now, end) / this.#worldCanRefreshLeft;
    var delay = this.#worldTimeToWeight(now, perRefresh, end);
    this.#nextWorldRefreshAt =
      delay === Infinity ? Infinity : now + Math.max(WORLD_MIN_REFRESH_GAP_MS, delay);
  }
  // 下次检测时刻：取「下次刷新 / 最近的矿就绪时刻+抖动 / 兜底上限」三者最早。
  #planWorldCheck(now, world) {
    var next = Math.min(this.#nextWorldRefreshAt, now + WORLD_CHECK_MAX_MS);
    if (world && world.infos) {
      for (var i = 0; i < world.infos.length; i++) {
        var si = (world.infos[i] || {}).simpleInfo || {};
        var ge = int64ToNum(si.gatherEndTime);
        if (ge > now && ge + WORLD_TARGET_JITTER_MS < next) next = ge + WORLD_TARGET_JITTER_MS;
      }
    }
    this.#nextWorldCheckAt = next;
  }
  // 偷/封双满 → 换矿已无收益，停止刷新的依据。
  #worldRefreshBenefit() {
    return !(
      this.#stealMaxNum > 0 &&
      this.#stealDoneNum >= this.#stealMaxNum &&
      this.#packMaxNum > 0 &&
      this.#packDoneNum >= this.#packMaxNum
    );
  }

  // ─────────── 调度器（仅世界：检测点 + 最小读间隔，无盟友/自矿） ───────────
  #nextWakeDelay() {
    var now = Date.now();
    var worldWake = Math.max(this.#nextWorldCheckAt, this.#lastWorldTs + WORLD_READ_MIN_GAP_MS);
    var min = worldWake <= now ? 1000 : worldWake - now;
    if (this.#worldEndTs > 0 && this.#worldEndTs > now) min = Math.min(min, this.#worldEndTs - now);
    min = Math.min(min, 300_000); // 保底 5min
    return Math.max(5000, min);
  }
  #scheduleScan(delay) {
    if (!this.#env.alive()) return;
    if (this.#scanTimer) clearTimeout(this.#scanTimer);
    var d = Math.max(0, delay);
    if (this.#worldEndTs > 0) {
      var toEnd = this.#worldEndTs - Date.now();
      if (toEnd > 0 && toEnd < d) d = Math.max(15000, toEnd);
    }
    this.#scanTimer = setTimeout(() => {
      this.#scanTimer = null;
      if (this.#env.alive()) this.#triggerScan();
    }, d);
  }
  #triggerScan() {
    if (!this.#env.alive()) return;
    if (this.#scanning || this.#consuming) {
      this.#scanPending = true;
      return;
    }
    this.#doScan().catch((err) => {
      log.warn('scan threw.', err);
      this.#afterRound();
    });
  }
  #afterRound() {
    if (!this.#env.alive()) return;
    if (this.#scanPending) {
      this.#scanPending = false;
      this.#triggerScan();
      return;
    }
    if (this.#stealGateWait) {
      this.#stealGateWait = false;
      // 清读池节流戳，保证短间隔重试这一轮能真正重读 7415 补上偷取任务（而非等下次检测点、最坏 5min）
      this.#lastWorldTs = 0;
      this.#nextWorldCheckAt = 0;
      this.#scheduleScan(STEAL_GATE_RETRY_MS);
      return;
    }
    this.#scheduleScan(this.#nextWakeDelay());
  }

  // ─────────── 主扫描 ───────────
  async #doScan() {
    this.#scanning = true;
    this.#queue = [];
    try {
      if (this.#env.getData() && this.#env.inAlliance()) {
        // 每轮扫描都驱一次读盘（未 loaded 且非在飞/已超看门狗才会真正重开）：修刷新间隙 bridge 未就绪致
        //   首次读永不 settle、loaded 永久卡 false → 整局不落盘的死角。
        if (!this.#stealBlockedLoaded) this.#loadStealBlocked();
        // 过当日世界结束点：矿池整体换新（新 id），重置刷新/检测计划等下轮读池重建预算。
        //   pack 拉黑非持久、随世界日清；steal 拉黑按自然日收敛（#rollStealDay），不在此清，
        //   否则 reload 后会重新重试同一批陈旧可偷死矿（旧 key 对新池矿是无害死键）。
        if (this.#worldEndTs && Date.now() > this.#worldEndTs) {
          this.#packBlockedToday.clear();
          this.#worldEndTs = 0;
          this.#nextWorldRefreshAt = 0;
          this.#nextWorldCheckAt = 0;
        }
        var now = Date.now();
        var tasks = [];
        if (now >= this.#nextWorldCheckAt && now - this.#lastWorldTs >= WORLD_READ_MIN_GAP_MS) {
          // 无已勾选规则=不采，不发换矿刷新(refresh:1 耗每日预算)；仍走 refresh:0 免费读维持 canRefreshNum 观测
          var doRefresh =
            this.#activeRuleCount() > 0 &&
            this.#worldCanRefreshLeft > 0 &&
            now >= this.#nextWorldRefreshAt &&
            this.#worldRefreshBenefit();
          var world = await this.#fetchWorldInfo(doRefresh);
          if (world && this.#env.alive()) {
            this.#lastWorldTs = Date.now();
            this.#worldTasks(world, tasks);
            var n2 = Date.now();
            this.#planWorldRefresh(n2); // 依服务器回传 canRefreshNum 重排下次刷新
            this.#planWorldCheck(n2, world); // 综合刷新点/矿就绪/兜底重排下次检测
          }
        }
        this.#queue = tasks;
      }
    } catch (err) {
      log.warn('scan error.', err);
      this.#queue = [];
    } finally {
      this.#scanning = false;
    }

    if (!this.#env.alive()) return;
    this.#consuming = true;
    this.#drain.consume().then(
      () => {
        this.#consuming = false;
        this.#afterRound();
      },
      (err) => {
        this.#consuming = false;
        log.warn('consume threw.', err);
        this.#afterRound();
      },
    );
  }

  // ─────────── 数据拉取 ───────────
  async #fetchWorldInfo(refresh) {
    var ret = await this.#env.ask(
      CMD_WORLD_INFO,
      { refresh: refresh ? 1 : 0 },
      refresh ? 'world-refresh' : 'world-info',
    );
    if (ret.ok && ret.data) {
      this.#updateWorldSnap(ret.data);
      return ret.data;
    }
    return null;
  }

  // 依服务器回传复位偷/封/刷新日额与当日结束点（每次读池权威刷新）。
  #updateWorldSnap(world) {
    this.#stealDoneNum = Number(world.stealNum) || 0;
    this.#stealMaxNum = Number(world.stealAllNum) || 0;
    this.#packDoneNum = Number(world.packNum) || 0;
    this.#packMaxNum = Number(world.packAllNum) || 0;
    this.#worldBudgetTotal = this.#env.cfgSeg(1062, 0); // 每日总预算（常量口径）
    this.#worldCanRefreshLeft =
      world.canRefreshNum != null && !isNaN(Number(world.canRefreshNum))
        ? Math.max(0, Number(world.canRefreshNum))
        : this.#worldBudgetTotal;
    this.#packLeft = this.#packMaxNum > 0 ? Math.max(0, this.#packMaxNum - this.#packDoneNum) : 0;
    var endMs = int64ToNum(world.endTime);
    this.#worldEndTs = endMs > 1e11 ? endMs : endMs * 1000;
  }

  // ─────────── 任务生成 ───────────
  #minePerStealCap() {
    var row = gameData.mineInteraction(3);
    var v = row ? Number(row.help_accept) : 0;
    return v > 0 ? v : Infinity;
  }

  #worldTasks(world, tasks) {
    this.#rollStealDay(); // 自然日跨日收敛（任何 add/过滤前），避免拿旧一天拉黑误拦新一天合法偷取
    var infos = world.infos || [];
    var stealMax = Number(world.stealAllNum) || 0;
    var stealDone = Number(world.stealNum) || 0;
    var perMineCap = this.#minePerStealCap();
    var stealLine = [];
    for (var i = 0; i < infos.length; i++) {
      var e = infos[i],
        si = e.simpleInfo || {};
      if (si.id == null) continue;
      var uid = e.ownerUid != null ? e.ownerUid : e.uid != null ? e.uid : 0;
      var specOk = this.#match(si.specId);
      var key = idKey(si.id) + '|' + uid;
      var eStealNum = Number(e.stealNum) || 0;
      // 单矿已被偷次数：表可用时直接过滤已偷满的矿；表取不到(Infinity)时保留候选，靠下面的排序让空矿沉底被名额截断
      var notFull = eStealNum < perMineCap;
      if (specOk && Number(si.canSteal) === 1 && notFull && !this.#stealBlockedToday.has(key)) {
        stealLine.push({
          k: 'steal',
          id: si.id,
          uid: uid,
          serverId: e.serverId,
          specId: si.specId,
          stealNum: eStealNum,
        });
      }
      if (
        specOk &&
        Number(si.canPack) === 1 &&
        notFull &&
        this.#packLeft > 0 &&
        !this.#packBlockedToday.has(key)
      ) {
        tasks.push({ k: 'pack', id: si.id, uid: uid });
        this.#packLeft--;
      }
      if (Number(si.canHelp) === 1) tasks.push({ k: 'help', id: si.id, uid: uid });
    }
    // 剩余容量大者优先（stealNum 升序）再高星：已偷光的矿自然沉底被当日名额截断，不再吃光名额饿死可偷矿
    // 拉黑集未知（读盘未回且未过 fail-open 宽限）：本轮不出偷取任务、置快速重试标记，
    //   避免 reload 首轮赶在读盘前把已知死矿重排、再撞一次 code=3（pack/help 已在上面入队，不受影响）。
    var blockedKnown =
      this.#stealBlockedLoaded ||
      (this.#stealBlockedFirstLoadAt &&
        Date.now() - this.#stealBlockedFirstLoadAt > STEAL_BLOCKED_LOAD_GRACE_MS);
    if (!blockedKnown) {
      if (stealLine.length) this.#stealGateWait = true;
      return;
    }
    stealLine.sort(function (a, b) {
      return a.stealNum - b.stealNum || specStar(b.specId) - specStar(a.specId);
    });
    for (var s = 0; s < stealLine.length && stealDone < stealMax; s++) {
      tasks.push(stealLine[s]);
      stealDone++;
    }
  }

  // ─────────── 执行器 ───────────
  async #execTask(task) {
    switch (task.k) {
      case 'steal':
        await this.#execSteal(task);
        break;
      case 'pack':
        await this.#execPack(task);
        break;
      case 'help':
        await this.#execHelp(task);
        break;
    }
  }

  async #execSteal(task) {
    var ret = await this.#env.ask(
      CMD_STEAL,
      { id: task.id, uid: task.uid, serverId: task.serverId },
      'steal',
    );
    // 未真正发出（同号在途/发送异常 CODE_NOT_SENT）不拉黑：矿没被碰过，下轮重试。
    if (ret.code === CODE_NOT_SENT) {
      log.debug('steal not sent (in-flight), retry next round. id=%s', idKey(task.id));
      return;
    }
    // 业务规则：每个裂隙矿自己只能偷 1 次（下次刷新可能再遇到），无论成败当日都拉黑不再偷（只拉黑偷取线）。
    //   成功（已捣一份）与 code=3（mine_cave72：已被别人偷光/已偷过）同样归“今日不该再碰”，
    //   故两者都拉黑并落盘，跨 reload 不再重试同一批死矿。
    this.#stealBlockedToday.add(idKey(task.id) + '|' + task.uid);
    this.#persistStealBlocked();
    if (ret.ok) {
      log.info('steal ok. id=%s', idKey(task.id));
    }
    // 被拒多为良性（今日已偷/被偷满，服务器回 code=3+全零体），无诊断价值 → 降 debug 不打载荷。
    else {
      log.debug(
        'steal rejected code=%d (already stolen / full), skip. id=%s',
        ret.code,
        idKey(task.id),
      );
    }
  }
  async #execPack(task) {
    var ret = await this.#env.ask(CMD_HELP_PACK, { id: task.id, uid: task.uid }, 'pack');
    if (ret.ok) {
      log.debug('pack ok. id=%s', idKey(task.id));
    } else {
      this.#packBlockedToday.add(idKey(task.id) + '|' + task.uid);
      log.info('pack rejected. code=%d;msg=%s', ret.code, rejectText(ret.data));
    }
  }
  async #execHelp(task) {
    var ret = await this.#env.ask(CMD_HELP, { id: task.id, uid: task.uid }, 'help');
    log.debug(ret.ok ? 'help ok.' : 'help rejected. code=%d;data=%s', ret.code, rejectText(ret.data));
  }
}
