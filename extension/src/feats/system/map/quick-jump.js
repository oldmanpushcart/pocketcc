/**
 * 快速镜头切换 feat（浮窗 + reactor 说明书形态）：一个小浮窗，粘贴/输入一个或多个坐标即把游戏镜头飞过去。
 *
 * 交互模型：面板启用 → install 建浮层、挂 Ctrl+G 热键；浮层打开 → 顶部多行输入框接收坐标文本，
 *   回车 / 点「跳转」→ 解析所有行 → 记录列表置顶，并把镜头飞到第一条；点列表任意行再次飞行。
 *
 * 支持的坐标格式（用户给出的五种，解析器对全部兼容，并容忍多余空格与全角分隔符）：
 *   格式1  S4251 343,471      区号 S 前缀 + 逗号坐标
 *   格式2  343,471@4251       逗号坐标 + @区号后缀
 *   格式3  343:471@4251       冒号坐标 + @区号后缀
 *   格式4  343:471            冒号坐标（无区）
 *   格式5  343,471            逗号坐标（无区）
 *   区号（4251）是目标区服：带上则跨区跳转（nav.flyTo 传 z=server），只给坐标不传区则 z=null，
 *   游戏 MOVE_TO 分支回退 UserData.ServerId —— 即「默认跳本区」（同 feats/system/hotkey/fly-home.js 兜底口径）。
 *
 * 坐标口径：这里的 343,471 是游戏内显示的世界 tile 坐标（= 服务器 tileX/tileY，nav.flyTo 直接吃它，
 *   同聊天浮层 (x,y) 坐标链接化那条路径），不是全局地图 feat 的紧凑 cell 号，无需 cellToGame 换算。
 *
 * 门控：places:['world'] + kinds:['homeland'] —— 浮层是辅助 UI，install 不受门控（任意场景可开关展示、
 *   读写记录）；跨场景跳转由游戏 gotoWorldAndDo 自行进入世界地图，本 feat 不额外拦。
 * 红线：只调用游戏原生导航 nav.flyTo（只读 + 导航）与原生气泡聊天 sharePos（只发包 670），
 *   不改写游戏本地数据；历史/几何走 UID 隔离存储。
 *
 * 分享（单条/批量）：调 core/chat 的 chatApi.sharePos(x,y,{channel,z}) 发游戏原生坐标链接（m="link"+llm，
 *   统一发文字卡形态 st:5（systemFont 组，能正常渲染中文标题）+ s=备注 + icon=坐标语义图标（image/NChat/chat_v3_share_icon_pos5），
 *   卡片即「坐标图标 + 文字说明 + 自动的 S:区号 X/Y 行」；行内无 `#备注` 时用默认文字「坐标分享」；别的玩家点击均可跳转；
 *   目的频道做成下拉：固定项 = 世界(world)/联盟(alliance)，动态项从游戏频道头 chatHeads() 发现
 *   （跨服3/KVK6/无双/盟决等活动房，发送只带 c 不带 roomId、由服务器路由到已 join 房；群聊5 需 group=roomId）。
 *   多条时逐条发送、每条间隔 1s（世界频道按等级有发送 CD，
 *   data_config 20210613，真机 500ms 已被流控）；发送期间由 overlay.setSharing 锁按钮，pause 钩子置 shareAbort 中断在飞循环。
 */
import { sleep } from '../../../core/util.js';
import { createLog } from '../../../core/log.js';
import { reactor } from '../../../core/reactor.js';
import { storage } from '../../../core/storage.js';
import { chatApi } from '../../../core/chat.js';
import { nav, worldMap } from '../../../core/game-api.js';
import { JumpOverlay } from './jump-overlay.js';

/** @type {ReturnType<createLog>} 模块日志器（tag=QUICKJUMP） */
const log = createLog('QUICKJUMP');

/** @type {string} 浮层几何存储键（UID 命名空间下） */
const GEOM_KEY = 'pocketcc.quickJump.geom';
/** @type {string} 跳转历史记录存储键（UID 命名空间下） */
const HIST_KEY = 'pocketcc.quickJump.hist';

/** @type {number} 批量分享逐条发送间隔（毫秒；世界频道按等级有发送 CD data_config 20210613，真机 500ms 会被流控，定 1s） */
const SHARE_INTERVAL_MS = 1000;
/** @type {Object<string,string>} 固定频道 key → 中文名（下拉前置项；动态项名取游戏频道头） */
const CHANNEL_LABEL = { world: '世界', alliance: '联盟' };
/** @type {Array<{key:string,label:string}>} 分享频道下拉的固定项（构造时交 overlay） */
const FIXED_CHANNELS = [
  { key: 'world', label: '世界' },
  { key: 'alliance', label: '联盟' },
];
/** @type {Array<number>} 不进动态列表的频道：世界0/私聊1/联盟2（前两者固定项已覆盖，私聊不适用） */
const DYN_SKIP_CHANNELS = [0, 1, 2];
/** @type {number} 分享位置卡子类型：5=WORLDSITE（systemFont 组，能正常渲染中文标题） */
const SHARE_ST_WITH_NOTE = 5;
/** @type {string} 行内未写 `#备注` 时分享卡的默认标题文字 */
const SHARE_DEFAULT_NOTE = '坐标分享';
/** @type {string} 带备注分享时的坐标语义图标（游戏自带「分享坐标」图标，NChat 聊天图集，位置卡可加载） */
const SHARE_COORD_ICON = 'image/NChat/chat_v3_share_icon_pos5';

/** @type {object} 模块默认配置（面板描述符 defaults） */
const DEFAULTS = {
  enabled: false,
  /** @type {boolean} 跳转后是否模拟点地块（弹城市弹窗）；关=只飞镜头打标记 */
  clickOpen: false,
  /** @type {number} 历史记录最多保留条数 */
  histMax: 100,
};

/** @type {JumpOverlay|null} 浮层实例 */
var overlay = null;
/** @type {boolean} install 幂等守卫 */
var installed = false;
/** @type {object} 模块配置（configure 推入） */
var cfg = Object.assign({}, DEFAULTS);
/** @type {Array<{x:number,y:number,server:?number,ts:number}>} 历史记录（新→旧，含刚解析跳转的项） */
var history = [];
/** @type {boolean} 历史是否已从盘加载就绪（未就绪前不覆写落盘，防用空数组盖掉真实历史） */
var histLoaded = false;
/** @type {boolean} 批量分享在飞（防重入） */
var sharing = false;
/** @type {boolean} 分享中断标志（pause 时置真，循环下个检查点退出） */
var shareAbort = false;

/**
 * 解析一行坐标文本为用户给出的五种格式之一，并可带一段 `#文字说明` 备注（供分享时作卡片标题）。
 * 对多余空格、全角逗号/冒号、大小写 S 前缀、全角 ＃ 均容忍；解析失败返回 null（调用方跳过该行）。
 * @param {string} line 一行文本
 * @returns {?{x:number,y:number,server:?number,note:?string}} {x,y 世界坐标, server 目标区服（无则 null=跳本区）, note 备注文字（无则 null）}
 */
function parseLine(line) {
  var s = String(line == null ? '' : line).trim();
  if (!s) return null;
  // 归一全角分隔符与括号，去掉多余空白
  s = s
    .replace(/[，、]/g, ',')
    .replace(/[：]/g, ':')
    .replace(/＃/g, '#')
    .replace(/[（）()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // 先摘出 `#` 之后的备注（分享时作卡片标题文字），坐标部分继续解析
  var note = '';
  var hi = s.indexOf('#');
  if (hi >= 0) {
    note = s.slice(hi + 1).trim();
    s = s.slice(0, hi).trim();
  }
  var server = null;
  // 格式1：区号 S 前缀（S4251 343,471 / S4251,343,471）——取走前缀与其后分隔符
  var mp = s.match(/^s\s*(\d{1,6})[\s,:-]*/i);
  if (mp) {
    server = parseInt(mp[1], 10);
    s = s.slice(mp[0].length);
  } else {
    // 格式2/3：@区号后缀（343,471@4251 / 343:471@4251）
    var ma = s.match(/@\s*(\d{1,6})\s*$/);
    if (ma) {
      server = parseInt(ma[1], 10);
      s = s.slice(0, ma.index);
    }
  }
  // 坐标：两个整数以 , : ; 或空格分隔（格式4/5 无区，落到这里）
  var mc = s.match(/(\d{1,5})\s*[,:;]\s*(\d{1,5})/) || s.match(/(\d{1,5})\s+(\d{1,5})/);
  if (!mc) return null;
  var x = parseInt(mc[1], 10);
  var y = parseInt(mc[2], 10);
  if (!isFinite(x) || !isFinite(y) || x < 0 || y < 0) return null;
  return { x: x, y: y, server: server, note: note || null };
}

/**
 * 解析多行文本 → 去重后的目标列表（保持输入顺序）。
 * @param {string} text 可能多行的坐标文本（行内可带 `#备注`）
 * @returns {Array<{x:number,y:number,server:?number,note:?string}>}
 */
function parseAll(text) {
  var lines = String(text == null ? '' : text).split(/\r?\n/);
  var seen = Object.create(null);
  var out = [];
  for (var i = 0; i < lines.length; i++) {
    var p = parseLine(lines[i]);
    if (!p) continue;
    var key = p.x + ',' + p.y + '@' + (p.server == null ? '' : p.server);
    if (seen[key]) continue;
    seen[key] = 1;
    out.push(p);
  }
  return out;
}

/** 历史记录去重键（同坐标同区只留最新一条）。 */
function histKey(it) {
  return it.x + ',' + it.y + '@' + (it.server == null ? '' : it.server);
}

/** 本服服号（供列表「本区」标签与跨区判定）；取不到返回 0。 */
function selfServer() {
  try {
    return (worldMap.serverId && worldMap.serverId()) || 0;
  } catch (e) {
    return 0;
  }
}

/** 把当前 history 铺到浮层（附本服号供渲染跨区标签，携 note 供行内展示与分享）。 */
function paint() {
  if (!overlay) return;
  var sk = selfServer();
  overlay.renderItems(
    history.map(function (it) {
      return {
        x: it.x,
        y: it.y,
        server: it.server,
        note: it.note || null,
        selfServer: sk || null,
      };
    }),
  );
}

/**
 * 落盘历史记录（histLoaded 前置守卫：未从盘读回前绝不写，防用初始空数组覆盖真实历史）。
 */
function persistHistory() {
  if (!histLoaded) return;
  try {
    Promise.resolve(storage.set(HIST_KEY, history)).catch(function () {});
  } catch (e) {}
}

/**
 * 把一组解析结果并入历史（置顶、按坐标去重、按 histMax 截断）并重绘/落盘。
 * @param {Array<{x:number,y:number,server:?number,note:?string}>} items
 */
function mergeHistory(items) {
  var seen = Object.create(null);
  var next = [];
  for (var i = 0; i < items.length; i++) {
    var it = {
      x: items[i].x,
      y: items[i].y,
      server: items[i].server,
      note: items[i].note || null,
      ts: Date.now(),
    };
    seen[histKey(it)] = 1;
    next.push(it);
  }
  for (var j = 0; j < history.length; j++) {
    var old = history[j];
    if (!seen[histKey(old)]) {
      seen[histKey(old)] = 1;
      next.push(old);
    }
  }
  var max = cfg.histMax > 0 ? cfg.histMax : DEFAULTS.histMax;
  history = next.slice(0, max);
  paint();
  persistHistory();
}

/**
 * 执行一次镜头跳转（nav.flyTo，只读 + 原生导航）。server 为空则 z=null → 游戏回退本服。
 * @param {{x:number,y:number,server:?number}} item 目标
 */
function doJump(item) {
  if (!item) return;
  var r = nav.flyTo({
    x: item.x,
    y: item.y,
    z: item.server != null ? item.server : null,
    subMap: null,
    click: !!cfg.clickOpen,
  });
  if (!overlay) return;
  if (r.ok) {
    overlay.markActive(item.x, item.y, item.server != null ? item.server : null);
    overlay.toast(
      '已飞向 (' +
        item.x +
        ',' +
        item.y +
        ')' +
        (item.server != null ? ' · 区 ' + item.server : ' · 本区'),
    );
  } else
    overlay.toast(
      r.err === 'unavailable' ? '导航不可用（请先进入世界地图）' : '跳转失败（坐标或区号有误）',
    );
}

/**
 * 判定一条 chat 发送（PostChatMsg 670）是否业务成功。口径同 chat.send 文档：
 *   ret.ok && JSON.parse(ret.data).success===1；业务拒时 data 为 '<文案键,参数>' 裸串，parse 得 null → 假。
 * @param {?{ok:boolean,data:*}} ret net.Ret
 * @returns {boolean}
 */
function chatSendOk(ret) {
  if (!ret || !ret.ok) return false;
  var d = ret.data;
  if (typeof d === 'string') {
    try {
      d = JSON.parse(d);
    } catch (e) {
      return false;
    }
  }
  return !!(d && d.success === 1);
}

/**
 * 把下拉频道 key 映射成 chat.sharePos 的发送参数底座（口径同 chat-window.sendTarget）。
 * 固定项 'world'/'alliance' 直透 core CHANNELS；动态项 'c<N>:<roomId>' → {c:N}（群聊5 另带 group）。
 * @param {string} key 下拉选中项的 key
 * @returns {?object} 发送参数底座；key 非法返回 null
 */
function channelOpts(key) {
  if (key === 'world' || key === 'alliance') return { channel: key };
  var m = /^c(\d+):(.+)$/.exec(String(key == null ? '' : key));
  if (!m) return null;
  var c = +m[1];
  var opts = { c: c };
  if (c === 5) opts.group = m[2]; // 群聊房发送必填 group=roomId（chatCommon.dataSameWithGroupSpecial=[5]）
  return opts;
}

/**
 * 从游戏频道头（chat.chatHeads，只读）发现可分享的动态频道：跨服/KVK/无双/盟决等活动房。
 * 同频道多房只列一项（发送不带 roomId、服务器路由到已 join 房，多项反而歧义）；群聊 5 例外必须带房号。
 * @returns {Array<{key:string,label:string}>}
 */
function dynChannels() {
  var chat = chatApi;
  if (!chat || typeof chat.chatHeads !== 'function') return [];
  var out = [];
  var seen = Object.create(null);
  try {
    for (var h of chat.chatHeads()) {
      if (!h || h.id == null) continue;
      var c = +h.channel;
      if (!isFinite(c) || DYN_SKIP_CHANNELS.indexOf(c) >= 0) continue;
      var key = c === 5 ? 'c5:' + String(h.id) : 'c' + c + ':room';
      if (seen[key]) continue;
      seen[key] = 1;
      out.push({ key: key, label: (h.name || '频道' + c) + (c === 5 ? '·群' : '') });
    }
  } catch (e) {}
  return out;
}

/** 刷新下拉的动态频道项（打开浮层时调；chatHeads 懒发现，活动房随开随现）。 */
function refreshDynChannels() {
  if (!overlay) return;
  try {
    overlay.refreshChannels(dynChannels());
  } catch (e) {}
}

/**
 * 批量/单条分享：逐条把坐标以游戏原生链接发到目的频道（别的玩家可点击跳转），每条间隔 1s。
 * 统一发文字卡（st=5 + 坐标图标）：卡片标题 = 行内 `#备注`，未写则用默认文字「坐标分享」。
 * 单条分享 = 只传一条的批量（overlay 页脚两路都走这里）。在飞置 sharing 防重入，shareAbort 可中断。
 * @param {string} channelKey 下拉选中项 key：'world'|'alliance'|'c<N>:<roomId>'（见 channelOpts）
 * @param {Array<{x:number,y:number,server:?number,note:?string}>} items 待分享项
 * @returns {Promise<void>}
 */
async function doShare(channelKey, items) {
  if (sharing) return;
  var chat = chatApi;
  if (!chat || typeof chat.sharePos !== 'function') {
    if (overlay) overlay.toast('聊天通道不可用');
    return;
  }
  var chOpts = channelOpts(channelKey);
  if (!chOpts) {
    if (overlay) overlay.toast('频道不可用，请重新选择');
    return;
  }
  if (!items || !items.length) return;
  sharing = true;
  shareAbort = false;
  if (overlay) overlay.setSharing(true);
  var ok = 0;
  var fail = 0;
  for (var i = 0; i < items.length; i++) {
    if (shareAbort) break;
    var it = items[i];
    try {
      // z 缺省传 null → sharePos 内部回退当前服；带区号则跨区分享（目标准确落该区）；频道参数由 chOpts 底座给出
      var opts = Object.assign({}, chOpts, { z: it.server != null ? it.server : null });
      // 统一发文字卡：st=5（systemFont 组，能正常渲染中文标题）+ 坐标语义图标，标题=行内备注（缺省「坐标分享」）。
      opts.s = it.note || SHARE_DEFAULT_NOTE;
      opts.st = SHARE_ST_WITH_NOTE;
      opts.icon = SHARE_COORD_ICON;
      var ret = await chat.sharePos(it.x, it.y, opts);
      if (chatSendOk(ret)) ok++;
      else fail++;
    } catch (e) {
      fail++;
    }
    if (shareAbort) break;
    if (i < items.length - 1) await sleep(SHARE_INTERVAL_MS);
  }
  sharing = false;
  var chLabel = CHANNEL_LABEL[channelKey] || channelKey;
  if (overlay) {
    overlay.setSharing(false);
    overlay.exitShareMode();
    overlay.toast(
      shareAbort
        ? '分享已中断（已发 ' + ok + ' 条）'
        : '已分享 ' + ok + ' 条到' + chLabel + (fail ? '（失败 ' + fail + '）' : ''),
    );
  }
  log.info('batch share → %s: ok=%d fail=%d abort=%s', channelKey, ok, fail, shareAbort);
}

/** handlers 回调面（overlay → 业务动作） */
function makeHandlers() {
  return {
    onSubmit: function (text) {
      var items = parseAll(text);
      if (!items.length) {
        if (overlay) overlay.toast('未识别到有效坐标');
        return;
      }
      mergeHistory(items);
      doJump(items[0]); // 飞第一条；其余已铺入列表供点选
      if (overlay) overlay.clearInput();
    },
    onPick: function (item) {
      doJump(item);
    },
    onClearHistory: function () {
      history = [];
      paint();
      persistHistory();
      if (overlay) overlay.toast('已清空跳转记录');
    },
    onSendShare: function (channelKey, items) {
      doShare(channelKey, items);
    },
    onDelete: function (items) {
      if (!items || !items.length) {
        if (overlay) overlay.toast('未选择要删除的记录');
        return;
      }
      var drop = Object.create(null);
      for (var i = 0; i < items.length; i++) drop[histKey(items[i])] = 1;
      var before = history.length;
      history = history.filter(function (it) {
        return !drop[histKey(it)];
      });
      var removed = before - history.length;
      if (overlay) overlay.exitShareMode(); // 先退多选态，避免重绘后残留勾选
      paint();
      persistHistory();
      if (overlay) overlay.toast('已删除 ' + removed + ' 条记录');
    },
    onVisibleChange: function (visible) {
      if (visible && overlay) {
        var sk = selfServer();
        overlay.setSelfServer(sk);
        refreshDynChannels(); // 活动/跨服房随开随现：每次打开浮层重扫一遍频道头
        paint();
      }
    },
    onGeomChange: function (geom) {
      try {
        Promise.resolve(storage.set(GEOM_KEY, geom)).catch(function () {});
      } catch (e) {}
    },
  };
}

/** Ctrl+G 开关浮层（window 捕获阶段，同全局地图/聊天窗教训：游戏在冒泡阶段 stopPropagation） */
function onKeydown(e) {
  if (!(e.ctrlKey || e.metaKey)) return;
  if (e.key !== 'g' && e.code !== 'KeyG') return;
  // 输入控件内不劫持（打字时 Ctrl+G 不应弹层；但在本浮窗输入框内 Ctrl+G 收起是合理切换）
  e.preventDefault();
  if (overlay) overlay.toggle();
}

/**
 * 安装：建浮层、挂热键、恢复几何与历史。幂等。（不依赖 reactor ctx：跳转全由 UI 触发，无周期门控）
 * @returns {boolean} 成功
 */
function install() {
  if (installed) return true;
  overlay = new JumpOverlay(makeHandlers(), { channels: FIXED_CHANNELS });
  overlay.mount();
  window.addEventListener('keydown', onKeydown, true);
  overlay.setSelfServer(selfServer());
  // 几何存档：读盘失败（命名空间未设等）静默用默认
  storage
    .get(GEOM_KEY)
    .then(function (g) {
      if (g && overlay) overlay.setGeom(g);
    })
    .catch(function () {});
  // 历史存档：读回后覆写内存并置 histLoaded（读失败/命名空间未设 → 空历史，仍可正常写）
  storage
    .get(HIST_KEY)
    .then(function (h) {
      history = Array.isArray(h) ? h : [];
      histLoaded = true;
      paint();
    })
    .catch(function () {
      histLoaded = true;
    });
  installed = true;
  log.info('quick jump installed (Ctrl+G).');
  return true;
}

/**
 * 注入面板配置（configure 更新模块 cfg 并即时应用到已建浮层）。
 * @param {object} partial {clickOpen, histMax}
 * @returns {object} 当前 cfg
 */
function configure(partial) {
  if (!partial) return cfg;
  if (typeof partial.clickOpen === 'boolean') cfg.clickOpen = partial.clickOpen;
  if (partial.histMax != null) {
    var n = Number(partial.histMax);
    if (isFinite(n) && n > 0) cfg.histMax = n | 0;
  }
  return cfg;
}

/**
 * 激活：此刻游戏符号就绪，刷新一次本服徽标（历史已在 install 读回）。无周期触发器（纯手动）。
 */
function run() {
  if (overlay && overlay.isVisible()) {
    overlay.setSelfServer(selfServer());
    paint();
  }
}

reactor.register({
  id: 'quickJump',
  kinds: ['homeland'],
  label: '镜头跳转',
  storageKey: 'pocketcc.quickJump.config',
  // 软依赖：浮窗是辅助 UI，跳转协调器未就绪时仍应能安装（doJump 已有 'unavailable' toast 兜底）
  symbols: ['navFly?'],
  defaults: {
    enabled: DEFAULTS.enabled,
    clickOpen: DEFAULTS.clickOpen,
    histMax: DEFAULTS.histMax,
  },
  fields: [
    {
      key: 'clickOpen',
      label: '跳转后弹出城市弹窗',
      type: 'checkbox',
      section: '跳转行为',
    },
    { key: 'histMax', label: '历史保留条数', type: 'number', min: 10, step: 10, section: '记录' },
  ],
  toModuleCfg: function (c) {
    return { clickOpen: c.clickOpen, histMax: c.histMax };
  },
  places: ['world'],
  install: install,
  configure: configure,
  run: run,
  // 门控下线（离开 world/homeland）：中断在飞批量分享循环，避免拿陈旧上下文继续发 670
  pause: function () {
    if (sharing) shareAbort = true;
  },
});
