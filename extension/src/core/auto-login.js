// 免扫码自动登录（token 缓存重放）。hook PlatformCore 的 token/登录参数入口，
// 复用上次缓存的 serverToken 免去扫码；并补登出能力（自动复用 token 后游戏默认无法主动换号）。
// 设计依据见 references/历史文档/免扫码登录技术方案.md。
// 注意：app_serverToken / app_webgameqqCode / app_loginFlowArgs / app_gameServer 是游戏自身的
// LocalStorageUtils 键，必须原样不动（不加 pocketcc. 前缀）。另注意 LocalStorageUtils 默认再给键名
// 拼一层 topwar_ 前缀（get/set/del 第三参缺省即启用），故直查 localStorage 时真键是 topwar_app_serverToken。
import { createLog } from './log.js';
import { game } from './game.js';

/** @type {ReturnType<createLog>} 免扫码登录日志器（tag=AUTO-LOGIN） */
const log = createLog('AUTO-LOGIN');

/** @type {string} 回放源逻辑键（真键 topwar_app_serverToken，前缀由 LocalStorageUtils 补） */
const REPLAY_KEY = 'app_serverToken';

/** @type {string} LocalStorageUtils 的默认前缀 */
const LS_PREFIX = 'topwar_';

/**
 * 形态校验：Base64 解得 UTF-8、逗号字段 ≥2 且索引 1（平台名）非空（与 popup 的 inspectToken 同口径）
 * @param {string} token
 * @returns {boolean}
 */
function isTokenShaped(token) {
  try {
    const fields = CryptoJS.enc.Utf8.stringify(CryptoJS.enc.Base64.parse(token)).split(',');
    return fields.length >= 2 && !!fields[1];
  } catch (e) {
    return false;
  }
}

/**
 * 收养落在别名键上的凭证：重放只认 app_serverToken，而外部导入/旧版文件可能写成
 * topwar_web_serverToken 之类的键（游戏本体从不写 serverToken 这层键，此类键无任何读者），
 * 表现为「导入成功但不自动登录」。只收养形态合法的值，避免把脏数据带进登录链路。
 * @param {object} localStore LocalStorageUtils
 * @returns {{key: string, token: string}|null} 命中时的真键名与裸 token
 */
function adoptOrphanToken(localStore) {
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith(LS_PREFIX) || !/serverToken$/i.test(key)) continue;
    if (key === LS_PREFIX + REPLAY_KEY) continue;
    let token;
    try {
      token = localStore.get(key.slice(LS_PREFIX.length));
    } catch (e) {
      continue;
    }
    if (typeof token === 'string' && isTokenShaped(token)) return { key, token };
  }
  return null;
}

/**
 * 安装免扫码登录：接管 PlatformCore 的 token/登录参数入口，重放上次缓存的 serverToken。
 * 需在进登录流程前调用（一次挂载即覆盖后续所有登录参数）。
 */
export function installAutoLogin() {
  const platformCore = game.get('PlatformCore').instance;
  const localStore = game.get('LocalStorageUtils');

  /** 游戏存 token 时同步写一份到 LocalStorageUtils，作为下次免扫码的重放源（空值不镜像，免得把重放源抹成 null） */
  const origSaveServerToken = platformCore.saveServerToken;
  platformCore.saveServerToken = function (token) {
    origSaveServerToken.call(this, token);
    if (token) localStore.set('app_serverToken', token);
  };

  /**
   * 服务器列表参数：本次无新鲜凭证且存有缓存 token 时，直接填 token/platform（必要时补 webgameqq code）；
   * 无缓存且为 webgameqq 首次登录时，把 code 存下来供以后复用
   * @param {object} param 游戏原装的登录参数（就地修改）
   */
  const origSetServerListParam = platformCore.setServerListParam;
  platformCore.setServerListParam = function (param) {
    origSetServerListParam.call(this, param);
    // 【新鲜凭证优先于缓存回放】游戏只在本次已拿到 code（app_code / 手机验证码 / QQ 弹窗回传的
    // access_token+openid）时才填 param.code，见 PlatformWebgame.setServerListParam 的 `n && t && a` 分支。
    // 此时再用缓存 token 覆写 param.token/platform，会发出“新鲜 code + 陈旧 platform”的杂交请求，
    // 平台侧对不上→ServerList 被拒→登录卡在 99%（onServerListSuccess 才是推进进度与存 token 的地方）。
    // 不矛盾于免扫码：登录成功时游戏自身的 saveServerToken 会 `del("app_code")`，下次启动 param.code 本就为空，
    // 回放照旧生效。
    if (param.code) {
      if (param.platform === 'webgameqq') localStore.set('app_webgameqqCode', param.code);
      return;
    }
    const token = localStore.get('app_serverToken');
    if (token) {
      const platform = CryptoJS.enc.Utf8.stringify(CryptoJS.enc.Base64.parse(token)).split(',')[1];
      param.token = token;
      param.platform = platform;
      if (platform === 'webgameqq') param.code = localStore.get('app_webgameqqCode');
    }
  };

  /**
   * 登录参数：从 serverInfoToken 解出平台名覆写 param.platform
   * @param {object} param 游戏原装的登录参数（就地修改）
   */
  const origSetLoginParam = platformCore.setLoginParam;
  platformCore.setLoginParam = function (param) {
    origSetLoginParam.call(this, param);
    // 游戏只在 U&&platformSID&&channel 齐时才填 serverInfoToken；缺凭证时这里解 undefined 会抛，
    // 把游戏自身的登录请求带进异常路径（首次登录/未授权档位必踩），故无值直接放行交还原逻辑。
    if (!param.serverInfoToken) return;
    try {
      param.platform = CryptoJS.enc.Utf8.stringify(
        CryptoJS.enc.Base64.parse(param.serverInfoToken),
      ).split(',')[1];
    } catch (e) {
      // 解不出也不能覆写 param.platform：留游戏原值（getLoginPfId）比猜测值可靠
      log.warn('setLoginParam: decode serverInfoToken failed, keep game platform', e);
    }
  };

  // 自动复用 token 后，游戏默认无法主动换号，这里补登出能力。
  platformCore.canUserLogout = function () {
    return true;
  };
  /** 清掉自动登录凭证并回到干净 URL（面板「登出 / 换号」调） */
  platformCore.userLogout = function () {
    if (!window.confirm('确定登出并清除自动登录凭证？')) return;
    localStore.set('app_serverToken', null);
    window.location.href = window.location.href.split('?')[0];
  };

  // 启动即重放：旧登录参数路径的 token 作兜底，取到就存；之后清掉会干扰选服的历史键。
  // 【无凭证时一律不动游戏】saveServerToken 的原始实现里有无条件的 `del("app_code")`，
  // 而 app_code 正是手机/微信登录流程存放凭证的键；cachedToken 为空时预热本身没有意义（不会写 U），
  // 只剩下这个破坏性副作用，故只有拿到缓存 token 才预热 + 清干扰键。
  let cachedToken =
    localStore.get(REPLAY_KEY) ?? localStore.get('app_loginFlowArgs')?.serverInfoToken;
  if (!cachedToken) {
    const orphan = adoptOrphanToken(localStore);
    if (orphan) {
      cachedToken = orphan.token;
      // 只记键名不记原文：用于定位「导入落到别名键」这类静默失效；预热会把它补写回规范键
      log.info('auto-login: adopted serverToken from %s (canonical key missing)', orphan.key);
    }
  }
  if (cachedToken) {
    platformCore.saveServerToken(cachedToken);
    localStore.del('app_gameServer');
    localStore.del('app_loginFlowArgs');
  } else {
    log.info('auto-login: no cached serverToken, leave game login flow untouched');
  }
}
