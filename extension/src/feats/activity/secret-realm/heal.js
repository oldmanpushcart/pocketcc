/**
 * 编队治疗引擎（异能秘境：对**受伤军队**使用秘境背包里的治疗道具）。
 *
 * 语义：只在「已拉到本编队血量快照、且某支军队掉血达到阈值、且秘境背包里还有白名单道具」时动作；
 *   不做找怪/派兵/攻打，与 pickup.js（拾取）、capture.js（拍宠物）解耦。
 *
 * 链路（源码 NWorldPabTeamSelfPopup / NWorldPabTeamSelfItem）：
 *   ① `8584 ENIGMA_SECRET_ROOM_MARCH_ARMY_INFO {uid}` —— req 是 `{uid:"<UID 字符串>"}`，
 *      **uid 必须是字符串**（19 位 UID Number 化会踩精度陷阱）。应答 `{playerInfo, infos:[…]}`，每条军队：
 *      `{armyPower, maxArmyPower, power, marchId:{_low,_high,_unsigned}, heros[], armys[]}`。
 *      源码 NWorldPabTeamSelfPopup.updateView：`sendPBV2(8584,{uid:this._uid})`，
 *      且道具按钮**只在本人（`_uid===String(UserData.UID)`）时绘制** → 非本人的军队游戏根本不给治疗口。
 *   ② 受伤判据 = 源码 progress 口径 `armyPower / maxArmyPower`（NWorldPabTeamSelfItem.updateUI），
 *      本引擎在其上加面板阈值：`1 - armyPower/maxArmyPower >= healThreshold/100`。
 *   ③ 道具白名单**不硬编码**：源码 `getDataConfigData(3035).split('|')`，逐个
 *      `getItemNumById(id) > 0` 才画按钮（本 feat 用到的是 41002 急救绷带 / 41003 全科医疗包）。
 *      v4.1 起按**伤情分档选药**（竞品 recuperate L25042 同旨）：`ratio<0.9` 重伤优先 41003（急救箱），
 *      否则优先 41002（绷带）；首选不在白名单/缺货/被拉黑则落回勾选（3035）常规序，档位只在白名单内生效。
 *   ④ `8534 ENIGMA_SECRET_ROOM_BAG_USE {info:{itemId,itemCount:1}, marchId}` —— 源码
 *      NWorldPabTeamSelfItem.useItem；**`itemCount` 恒为 1**（游戏是逐件点击语义），
 *      **`marchId` 直接复用 8584 应答里那个 Int64 对象本体**（不 Number 化、不转字符串、不 Int64.fromString）。
 *      应答 `{ok:1, beforePower, afterPower}` → 游戏侧 emit UPDATE_PAB_USE_ITEM_ADD_LIFE → 弹层自己再发一条 8584。
 *   ⑤ 回环：8584 与 8534 严格交替，8534 成功后 0.5~0.6s 必有一条 8584 → 节拍 tuning.healGapMs=600
 *   与之一致；本引擎不镜像血量，治疗后的新血一律以重新拉到的快照为准（红线）。
 *
 * 一拍只做一个动作（与游戏逐件点击同口径），且**一拍最多发一次 8584**：
 *   快照新鲜 → 决策并用掉一件道具（返回 healGapMs）；
 *   快照过期/缺场 → **先过一遍零成本预筛**（见下）才发 8584 拉新快照（返回 healGapMs，应答到达即 kick 复跑）；
 *   无伤 / 无道具 / 未激活 → 返回 healScanMs 长睡（没伤就不该频着拉全编队血量）。
 *   成功用掉一件后把快照标记为「早于本次动作」→ 下一拍自动去重拉新血，既不猜血量也不与游戏自补的那条 8584 撞车。
 *
 * 零成本预筛（#mayNeedHeal）：8584 是个「拉全编队血量」的查询包，而 push 21521
 *   已把每支军队的 `{power, initPower}` 送到本地（`roomBaseInfo.members[].powerInfos[]`，一对「初始/当前」）
 *   → 先用面板阈值扫一眼，确认无伤就**一个查询包也不发**。
 *   预筛只做「拦明显无伤」这一件事，不拿它决定给哪支军队用道具（那仍以 8584 的权威快照为准，红线），
 *   且任何证据缺失（找不到我 / 无 powerInfos / 算不出比值）一律放行。
 *
 * 拒绝码处置（sendSecret 已把 `pbAckV2.header.d` 归一成 Ret.reason，feat 侧不摸 raw）：
 *   - enigma_realm162「异常操作，请再次尝试」= 服务器抖动形态（重试即过）
 *     → 该 itemId 允许**一次**重试，不拉黑；
 *   - 其它任何拒绝（道具不可用/服务器限制）→ 该 itemId 会话内拉黑：游戏侧只有 `getItemNumById>0` 才给按钮，
 *     「有货却被拒」不是靠重试能解的，逐拍重发只会刷同一批失败包（与拾取侧「被拒目标拉黑」同范式）。
 *
 * 只读+发包红线：全程只走 ACL 的只读快照 + sendSecret，不调游戏侧 Update/Delete、不镜像本地态。
 */
import { createCycle } from '../../../core/cycle.js';
import { bits } from '../../../core/game-api.js';
import {
  CMD_MARCH_ARMY_INFO,
  CMD_BAG_USE,
  CFG_PAB_HEAL_ITEMS,
  ITEM_BANDAGE,
  ITEM_MEDKIT,
  REJ_RETRY,
  CODE_NOT_SENT,
  tuning,
} from './constants.js';

/**
 * protobuf Long / {_low,_high} / number / 字符串 → 数值（取不到回 0）。与 capture.js 同口径。
 * @param {*} v 数值字段原值
 * @returns {number}
 */
function toNum(v) {
  return bits.int64ToNum(v);
}

/**
 * sendSecret 的 Ret 是否业务成功。主路径回的是 net.Ret 实例（`ok` 是 getter），
 *   而 game-api 在 `window.pocketcc.net` 未就绪时会降级为等价的普通对象（没带 `ok`）
 *   → 两条口径在此收口，不把降级误读成失败。
 * @param {object|null} r Ret 形结果
 * @returns {boolean}
 */
function isOk(r) {
  if (!r) return false;
  return r.ok === undefined ? Number(r.code) === 0 : !!r.ok;
}

/**
 * marchId 的跨拍安全副本：保留原型与自有字段（_low/_high/_unsigned 或 Long 的内部字段）。
 * 必要性：应答对象是**池化复用**的（core/net.js 明文「报文对象会被池化复用，别在它上面挂属性」），
 *   而快照要活到下一拍才消费；8534 又必须把该字段原样回传（游戏侧就是直传 8584 应答里那个 Int64），
 *   故既不能拆成数字（精度陷阱）、也不能转字符串（服务器要的是 Int64 型），只能拿同原型的副本。
 *   原型上带方法（toNumber/toString 等）→ 编码器能照常处理；Object.assign 不取原型方法，恰好只拷数据字段。
 * @param {*} v 8584 应答里的 marchId 原值
 * @returns {*} 同原型的浅副本（原始类型原样回）
 */
function cloneId(v) {
  if (v == null || typeof v !== 'object') return v;
  try {
    return Object.assign(Object.create(Object.getPrototypeOf(v)), v);
  } catch (e) {
    return v; // 原型取不到（异常形状）→ 宁可拿引用也不能发不出包
  }
}

/**
 * dataConfig(3035) → 治疗道具白名单（源码 `getDataConfigData(3035).split('|')`）。
 * dataConfig 回的是原始串（形如 "41002|41003"）；只留正整数、去重保序，
 *   读不到（配置未就绪/键缺失）回空数组 → 引擎按「游戏白名单不可用」降级不用道具。
 * **导出给装配层的面板选项构建复用**（同一拆法两处共存必然漂移，与 buildModuleCfg 共用归一化同理）。
 * @param {*} raw gameConf.dataConfig(3035) 原值
 * @returns {number[]}
 */
export function parseHealWhitelist(raw) {
  const s = String(raw == null ? '' : raw);
  const out = [];
  for (const part of s.split('|')) {
    const id = Number(part.trim());
    if (Number.isInteger(id) && id > 0 && out.indexOf(id) < 0) out.push(id);
  }
  return out;
}

/**
 * 编队治疗引擎：单条 createCycle 电平循环（8584 拉快照 → 判伤 → 8534 用一件道具）。
 */
export class HealEngine {
  #env;
  /** @type {{kick:Function}|null} */
  #cycle = null;
  /** @type {boolean} 引擎存活位：stop() 置 false 后旧 cycle 的定时器到点即自然终止（cycle 睡眠中的定时器不会被撤） */
  #active = false;
  /**
   * @type {{uid:string,at:number,armies:Array<{armyPower:number,maxArmyPower:number,marchId:*,idx:number}>}|null}
   * 8584 应答的**就地快照**（应答对象是池化引用，跨拍不能持原对象；marchId 也不例外，按 cloneId 留同原型副本）。
   */
  #snap = null;
  /** @type {number} 最近一次「发出治疗包」（不论成败）的时刻（Date.now）；快照早于它即视为陈旧（血量可能已变） */
  #usedAt = 0;
  /** @type {Object<string,1>} 本会话被拒过的道具 id（除 162 抖动外一律拉黑，防逐拍重发同一批失败包） */
  #rejected = {};
  /** @type {Object<string,1>} 已用过一次重试的道具 id（162 只给一次机会） */
  #retried = {};
  /** @type {Object<string,1>} 已就「背包里没有该道具」打过 info 的 id（换一次余量才重新提示一次，防刷屏） */
  #toldEmpty = {};
  /** @type {number} 本拍已发出的 8534 条数（一拍一件，与游戏逐件点击同口径） */
  #sentThisTick = 0;

  /** @param {object} env 注入底座 {alive, realmActive, cfg, secret, gameConf, l10n, log} */
  constructor(env) {
    this.#env = env;
  }

  /**
   * 一拍：判定 → 用一件道具 / 拉一次快照 / 长睡。永不 reject。
   * @returns {number} 下拍间隔（毫秒）
   */
  #tick() {
    const env = this.#env;
    if (!env.alive()) return 0;
    if (!env.realmActive()) return tuning.healScanMs;
    const h = env.cfg().heal;
    if (!h || !h.enabled) return tuning.healScanMs;

    this.#sentThisTick = 0;
    if (this.#snapFresh()) {
      if (this.#healOne(h)) return tuning.healGapMs;
      return tuning.healScanMs;
    }
    // 快照缺场/过期 → 拉一次（一拍只发一次 INFO；游戏弹层自补的那条 8584 由 resp 订阅照收）
    if (env.secret.isSecretSending(CMD_MARCH_ARMY_INFO)) return tuning.healGapMs;
    if (!this.#mayNeedHeal(h)) {
      env.log.debug('heal: prescan says nobody wounded (21521 powerInfos), skip 8584.');
      return tuning.healScanMs;
    }
    env.secret.sendSecret(CMD_MARCH_ARMY_INFO, { uid: this.#uid() });
    return tuning.healGapMs;
  }

  /**
   * 零成本预筛：只回答「值不值得为拉血量发一个 8584」，**不参与「给哪支军队用道具」的决策**。
   * 料源：push 21521 落地的 `roomBaseInfo.members[].powerInfos[]`（每条一个 `{power, initPower}`，
   *   与 8584 的 `armyPower/maxArmyPower` 同为一个「当前/初始」比值口径）。
   * 阈值直接用面板 `threshold`（掉血百分比）：`1 - power/initPower >= threshold/100` 即算「有伤员」，
   *   与 #healOne 对 8584 快照的判据逐位同式（预筛与权威路不一致会在阈值边界上互相矛盾）。
   *   本引擎只一档（直接吃面板 `threshold`）：拆两档只会让面板多一个旋钮，而预筛本来就不影响
   *   最终用哪一件（那由 #healOne 按白名单顺序定）。
   * 三条 fail-open（宁可多发一次查询，也不把治疗闸死）：members 缺失/找不到我 / 该 member 无 powerInfos
   *   / 数组里一条都算不出比值。
   * 代价（写清不藏着）：21521 一场 239 条 ≈17s 一条 → 刚掉下去的血最长要等一条推送才进得了门；
   *   而本引擎节拍本就是 healScanMs 4s 一轮、一件一件用，治疗不是秒级需求，故可接受。
   * @param {object} h 面板 heal 配置 {threshold}
   * @returns {boolean} true=有伤员或无证据（放行，发 8584）；false=确认无伤（不发）
   */
  #mayNeedHeal(h) {
    const env = this.#env;
    const base = env.secret.getRoomBaseInfo();
    const members = base && base.members;
    if (!Array.isArray(members) || !members.length) return true;
    const me = this.#uid();
    let mine = null;
    for (let i = 0; i < members.length; i++) {
      const m = members[i];
      if (m && String(m.uid) === me) {
        mine = m;
        break;
      }
    }
    const infos = mine && mine.powerInfos;
    if (!Array.isArray(infos) || !infos.length) return true;
    const need = Math.min(100, Math.max(0, Number(h.threshold) || 0)) / 100;
    let judged = 0;
    for (let j = 0; j < infos.length; j++) {
      const p = infos[j];
      const init = toNum(p && p.initPower);
      if (!(init > 0)) continue;
      judged++;
      // 与 #healOne 逐位同式（`1 - ratio >= need` 即伤员）：写成 `ratio <= 1 - need` 在阈值边界上两者可能判反
      if (1 - toNum(p.power) / init >= need) return true;
    }
    return judged === 0; // 一条比值都算不出来 = 无证据 → 放行
  }

  /**
   * 本人 UID（**字符串**口径，= `UserData.UID`）。
   * @returns {string}
   */
  #uid() {
    return this.#env.gameData.myUidStr();
  }

  /**
   * 快照可用性：存在、uid 是本人、且年龄不过期。
   * 过期口径两条：`at` 距今 > tuning.healStaleMs（血量被战斗实时改掉），或 `at` 早于最近一次成功治疗（该条血量已作废）。
   * @returns {boolean}
   */
  #snapFresh() {
    const s = this.#snap;
    if (!s || !s.armies.length) return false;
    if (s.uid !== this.#uid()) return false;
    if (s.at < this.#usedAt) return false;
    return Date.now() - s.at <= tuning.healStaleMs;
  }

  /**
   * 8584 应答入口（`ctx.on.resp`）：`status===0` 且 uid 是本人时**就地快照**，到达即 kick 循环（不等下一拍）。
   * 游戏弹层打开/治疗成功后也会发这条（0.5~0.6s 回环）→ 一并当料源用，不区分谁发起。
   * @param {object} ev bus `net.resp.8584` 事件（Event 实例：{cmd,status,data,raw,ts}）
   */
  onArmyInfoResp(ev) {
    const env = this.#env;
    if (!env.alive()) return;
    if (!ev || (ev.status != null && Number(ev.status) !== 0)) return;
    const outer = ev.data || {};
    const inner = outer.data || outer;
    const pi = inner.playerInfo || {};
    const uid = this.#uid();
    if (!uid) return;
    // playerInfo 不带 uid 时不拦（只记录 uid 为 ''，快照照建）——闸门要求的是「发的是我的 uid」
    const got = pi.uid == null ? '' : String(pi.uid);
    if (got && got !== uid) {
      env.log.debug('heal: 8584 resp is for uid %s (not mine), ignored.', got);
      return;
    }
    const list = Array.isArray(inner.infos) ? inner.infos : [];
    const armies = [];
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (!a || a.marchId == null) continue;
      armies.push({
        idx: i + 1, // 与游戏面板的 teamIndexLbl（r+1）同口径，便于对账
        armyPower: toNum(a.armyPower),
        maxArmyPower: toNum(a.maxArmyPower),
        marchId: cloneId(a.marchId),
      });
    }
    if (!armies.length) return;
    this.#snap = { uid: uid, at: Date.now(), armies: armies };
    if (this.#cycle) this.#cycle.kick();
  }

  /**
   * 治疗候选（按面板阈值筛最受伤的一支）。
   * @param {object} h 面板 heal 配置 {threshold,maxPerTick}
   * @returns {object|null} 军队快照条目
   */
  #pickWounded(h) {
    const need = Math.min(100, Math.max(0, Number(h.threshold) || 0)) / 100;
    let worst = null;
    let worstRatio = 1;
    const armies = this.#snap ? this.#snap.armies : [];
    for (let i = 0; i < armies.length; i++) {
      const a = armies[i];
      const max = a.maxArmyPower;
      if (!(max > 0)) continue; // 满血口径不明（无上限）→ 不猜
      const ratio = a.armyPower / max;
      if (1 - ratio < need) continue;
      if (ratio < worstRatio) {
        worstRatio = ratio;
        worst = a;
      }
    }
    return worst;
  }

  /**
   * 按「伤情分档优先（竞品 recuperate L25042）+勾选序（空=游戏 3035 白名单序）」挑第一件**背包有货且未被本会话拉黑**的道具。
   *   重伤（`armyPower/maxArmyPower < 0.9`）先试 41003 急救箱，其余先试 41002 绷带；
   *   首选不在白名单/缺货/被拉黑 → 落回勾选（3035）常规序（保守：不因为分档把可用药拦在门外；
   *   副作用是白名单序把 41003 排前时，轻伤也可能花掉急救箱，与竞品双档 fallback 略有出入，属取舍）。
   * @param {object} h 面板 heal 配置 {items}
   * @param {object|null} army 受伤军队快照（{armyPower,maxArmyPower}；缺=不分档，走常规序）
   * @returns {number} itemId（0=没有可用道具）
   */
  #pickItem(h, army) {
    const env = this.#env;
    let ids = Array.isArray(h.items) ? h.items.filter(Number.isInteger) : [];
    if (!ids.length) ids = parseHealWhitelist(env.gameConf.dataConfig(CFG_PAB_HEAL_ITEMS));
    const has = function (id) {
      for (let i = 0; i < ids.length; i++) if (ids[i] === id) return true;
      return false;
    };
    const usable = function (id) {
      return has(id) && !this.#rejected[id] && env.secret.getItemNumById(id) > 0;
    }.bind(this);
    // 伤情分档：只有重伤才值得先烧贵的急救箱（对齐竞品 ratio<0.9 档）
    let pref = 0;
    if (army && army.maxArmyPower > 0) {
      const ratio = army.armyPower / army.maxArmyPower;
      pref = ratio < 0.9 ? ITEM_MEDKIT : ITEM_BANDAGE;
    }
    if (pref && usable(pref)) {
      // 余量重新出现 → 解除「已提示过缺货」，让下一次真缺货还能再提示一次
      delete this.#toldEmpty[pref];
      return pref;
    }
    const empty = [];
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      if (this.#rejected[id]) continue;
      const num = env.secret.getItemNumById(id);
      if (num > 0) {
        // 余量重新出现 → 解除「已提示过缺货」，让下一次真缺货还能再提示一次
        delete this.#toldEmpty[id];
        return id;
      }
      empty.push(id);
    }
    // 全都在背包里取不到 → 只提示一次（余量随 21525 BAG_INFO 变，故 #toldEmpty 只在「重新有货」时才解除，
    //   不在收到新快照时复位——快照每 4s 就来一条，复位等于逐拍刷屏）
    for (let i = 0; i < empty.length; i++) {
      if (this.#toldEmpty[empty[i]]) continue;
      this.#toldEmpty[empty[i]] = 1;
      env.log.info('heal: item %d not in pab bag, skip.', empty[i]);
    }
    return 0;
  }

  /**
   * 治疗一拍里的一次动作：找受伤军队 → 选道具 → 发 8534（一发一件）。
   * @param {object} h 面板 heal 配置
   * @returns {boolean} true=这次真发出了一个治疗包
   */
  #healOne(h) {
    const maxPer = Math.max(1, Number(h.maxPerTick) || 1);
    if (this.#sentThisTick >= maxPer) return false;
    const army = this.#pickWounded(h);
    if (!army) return false;
    const itemId = this.#pickItem(h, army);
    if (!itemId) return false;
    this.#sendUse(army, itemId);
    this.#sentThisTick++;
    // 血量账不在本地镜像：把快照标脏（下一拍重拉），同时接住游戏成功后自补的那条 8584（0.5~0.6s）
    this.#usedAt = Date.now();
    return true;
  }

  /**
   * 发一件治疗道具（`8534 {info:{itemId,itemCount:1}, marchId}`；marchId 是 8584 应答里的 Int64 对象本体）。
   * 失败分三档：未真正发出（不拉黑、下拍重试）/ enigma_realm162 抖动（给**一次**重试）/ 其余一律本会话拉黑该道具。
   * @param {object} army 军队快照条目 {idx,armyPower,maxArmyPower,marchId}
   * @param {number} itemId 道具 id
   */
  #sendUse(army, itemId) {
    const env = this.#env;
    const max = army.maxArmyPower;
    const deficit = max > 0 ? Math.round((1 - army.armyPower / max) * 100) : 0;
    env.secret
      .sendSecret(CMD_BAG_USE, { info: { itemId: itemId, itemCount: 1 }, marchId: army.marchId })
      .then((r) => {
        if (!env.alive()) return;
        if (isOk(r)) {
          env.log.debug('heal: army#%d %d%% → item %d ok.', army.idx, deficit, itemId);
          return;
        }
        if (r && r.code === CODE_NOT_SENT) {
          // 未真正发出（次通道 cdTime 频控 / 门面静默短路）：不是业务拒绝，不拉黑，下一拍重试
          env.log.debug('heal: item %d not sent (secondary socket/CD), retry later.', itemId);
          return;
        }
        const rej = (r && r.reason) || '';
        if (rej === REJ_RETRY && !this.#retried[itemId]) {
          this.#retried[itemId] = 1;
          env.log.debug('heal: item %d rejected %s, retry once.', itemId, rej);
          this.#sendUse(army, itemId);
          return;
        }
        this.#rejected[itemId] = 1;
        env.log.info(
          'heal: item %d rejected (%s), dropped this session.',
          itemId,
          rej || 'code ' + (r && r.code),
        );
      });
  }

  /**
   * 启动：登记 8584 应答订阅（退订由 reactor 托管）+ 建循环并点火。
   * @param {object} ctx reactor 上下文（提供 on.resp）
   */
  start(ctx) {
    const env = this.#env;
    const self = this;
    this.#active = true;
    this.#snap = null;
    this.#usedAt = 0;
    this.#sentThisTick = 0;
    this.#rejected = {};
    this.#retried = {};
    this.#toldEmpty = {};
    if (ctx && ctx.on && typeof ctx.on.resp === 'function') {
      ctx.on.resp(CMD_MARCH_ARMY_INFO, function (ev) {
        self.onArmyInfoResp(ev);
      });
    } else {
      env.log.warn('heal: ctx.on.resp unavailable, army info cannot be captured (engine idle).');
    }
    this.#cycle = createCycle({
      log: env.log,
      alive: function () {
        return self.#active && env.alive();
      },
      run: function () {
        return self.#tick();
      },
      fallback: tuning.healScanMs,
    });
    this.#cycle.kick();
    env.log.info('heal engine started (8584 snapshot → 8534 one item per tick).');
  }

  /** 停止：置死 #active——cycle 睡眠期间的定时器不会被撤，靠引擎自带存活位在到点/重排两道 alive 检查处终止（防 pause→resume 后孤儿循环）。 */
  stop() {
    this.#active = false;
    this.#cycle = null;
    this.#snap = null;
  }
}
