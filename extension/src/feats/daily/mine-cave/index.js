/**
 * 次元矿洞日常自动化 —— spec 装配层。
 *
 * 本 feat 由「两大功能」构成，共享同一套采集规则（矿种/等级/星级 + 勾选生效）：
 *   ① 挖矿（MiningEngine，mining.js）      ：自家矿脉 + 盟友列表，只占领/回收/探测，不封存。
 *   ② 盗窃与封存（StealEngine，steal-pack.js）：裂隙矿场，偷取/封存/加速帮忙。
 * 两者刷新预算与节奏不同，故各有独立队列/drain/定时器；本层只做：
 *   - 安装共享底座（net/data/ctx）、提供 env（ask/cfgSeg/alive/getRules/getData/inAlliance/myUid）
 *   - 解析并分发 rules 给两引擎
 *   - 生命周期：run 起两引擎、configure 变更后各自重扫
 * 单一总开关（reactor enabled）驱动两引擎一起起停。
 * 全部「只读+发包」：不改写游戏本地数据、不 OpenUI、不模拟点击。
 */
import { createLog } from '../../../core/log.js';
import { game } from '../../../core/game.js';
import { reactor } from '../../../core/reactor.js';
import { l10n, gameData, gameConf } from '../../../core/game-api.js';
import { MiningEngine } from './mining.js';
import { StealEngine } from './steal-pack.js';

const log = createLog('MINE-CAVE');

const CODE_NOT_SENT = -1; // ask 未真正发出（同号在途/发送异常）的伪码

// ─────────── 共享运行时 ───────────
var MCFG = { rules: [] };   // 采集规则：每条 {type,level,star}；行存在即生效（已无行级 enabled 草稿门）
var net, data, ctxRef = null;
var installed = false;

function aliveFn() { return ctxRef ? ctxRef.alive() : false; }

function inAlliance() {
    var a = data && data.UserData && data.UserData.Alliance;
    return !!(a && typeof a.isInAlliance === 'function' && a.isInAlliance());
}
function myUid() { var u = data && data.UserData; return u ? Number(u.UID) || 0 : 0; }

// dataConfig 分隔符实为 '|'（历史踩坑：split(',') 致额度读成 0），两者都兼容。
function cfgSeg(id, idx) {
    var raw; try { raw = gameConf.dataConfig(id); } catch (e) { raw = ''; }
    if (raw == null || raw === '') return 0;
    var p = String(raw).split(/[|,]/);
    return parseInt(p[idx], 10) || 0;
}

// 统一发包壳：同号在途则跳过，异常兜底为 CODE_NOT_SENT。
async function ask(cmd, payload, label) {
    if (net.isSending(cmd)) return net.Ret.from(CODE_NOT_SENT, null);
    try { return await net.sendPBV2(cmd, payload); } catch (err) { log.warn('%s send error.', label, err); return net.Ret.from(CODE_NOT_SENT, null); }
}

// ─────────── 注入两引擎的共享底座 ───────────
const env = {
    ask,
    cfgSeg,
    alive: aliveFn,
    getRules: () => MCFG.rules,
    getData: () => data,
    inAlliance,
    myUid,
    tuning: {
        // 跨引擎共享的领域调参（非用户设置）：hotSlots = 每日热点时段 [start,end) 小时，
        // ①盟友频率与②世界刷新权重必须同源，否则两侧口径会漂移。
        hotSlots: [[0, 1], [12, 13], [17, 18]],
    },
};
const mining = new MiningEngine(env);
const steal = new StealEngine(env);

// ─────────── 生命周期 ───────────
function install(ctx) {
    ctxRef = ctx;
    if (installed) return true;
    var missing = [];
    net = ctx.net;
    if (!net.install()) { missing.push('pocketcc.net'); net = null; }
    var dc = game.get('DataCenter'); data = (dc && dc.DATA) || null;
    if (!data) missing.push('DataCenter');
    if (missing.length) { net = null; data = null; log.warn('install failed. missing=%s', missing.join(';')); return false; }
    installed = true; log.info('installed.'); return true;
}

function configure(partial) {
    if (!partial) return MCFG;
    if (partial.rules != null) MCFG.rules = Array.isArray(partial.rules) ? partial.rules : [];
    if (installed && aliveFn()) { mining.kick(); steal.kick(); } // 规则变更：两引擎各重扫一轮以生效
    return MCFG;
}

function run(ctx) {
    ctxRef = ctx;
    mining.start(ctx);
    steal.start(ctx);
    log.info('started (mining + steal-pack).');
}

// ─────────── 注册 ───────────
reactor.register({
    id: 'mineCave',
    label: '次元矿洞',
    storageKey: 'pocketcc.feat.mineCave',
    scenes: ['Home', 'NWorldMap'],
    offInCombat: true,
    defaults: { enabled: false, rules: [] },
    fields: [
        {
            key: 'rules', label: '采集规则', type: 'minerules', section: '筛选',
            hint: '每条精确匹配：矿种（必选）+ 等级 + 星级（等级/星级可选「不限」）；不添加规则=不采，每条需勾选后才生效',
            options: function () {
                var specs = gameData.mineSpecs();
                var list = [];
                if (!specs || !specs.length) return list;
                var seen = {}, keys = [];
                for (var i = 0; i < specs.length; i++) { var t = Number(specs[i].type); if (seen[t] == null) { seen[t] = specs[i]; keys.push(t); } }
                keys.sort(function (a, b) { return a - b; });
                for (var k = 0; k < keys.length; k++) { var tt = keys[k]; list.push({ value: tt, label: l10n.text(seen[tt].name) || ('矿种' + tt) }); }
                return list;
            },
            levelOptions: function () {
                var specs = gameData.mineSpecs();
                var list = [{ value: 0, label: '不限' }];
                if (!specs || !specs.length) return list;
                var seen = {}, keys = [];
                for (var i = 0; i < specs.length; i++) { var l = Number(specs[i].level); if (l > 0 && seen[l] == null) { seen[l] = 1; keys.push(l); } }
                keys.sort(function (a, b) { return a - b; });
                for (var k = 0; k < keys.length; k++) list.push({ value: keys[k], label: keys[k] + '级' });
                return list;
            },
            maxStar: function () {
                var specs = gameData.mineSpecs(); var m = 0;
                if (specs) for (var i = 0; i < specs.length; i++) { var s = Number(specs[i].star) || 0; if (s > m) m = s; }
                return m > 0 ? m : 5;
            },
        },
    ],
    toModuleCfg: function (c) {
        var raw = Array.isArray(c.rules) ? c.rules : [];
        var rules = [];
        for (var i = 0; i < raw.length; i++) {
            var r = raw[i] || {};
            rules.push({
                type: Math.max(0, r.type | 0),
                level: Math.max(0, r.level | 0),
                star: Math.max(0, r.star | 0),
            });
        }
        return { rules: rules };
    },
    install: install,
    configure: configure,
    run: run,
});
