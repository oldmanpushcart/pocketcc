// 免扫码自动登录（token 缓存重放）。hook PlatformCore 的 token/登录参数入口，
// 复用上次缓存的 serverToken 免去扫码；并补登出能力（自动复用 token 后游戏默认无法主动换号）。
// 设计依据见 references/免扫码登录技术方案.md。
// 注意：app_serverToken / app_webgameqqCode / app_loginFlowArgs / app_gameServer 是游戏自身的
// LocalStorageUtils 键，必须原样不动（不加 pocketcc. 前缀）。
import { game } from './game.js';

/**
 * 安装免扫码登录：接管 PlatformCore 的 token/登录参数入口，重放上次缓存的 serverToken。
 * 需在进登录流程前调用（一次挂载即覆盖后续所有登录参数）。
 */
export function installAutoLogin() {
  const platformCore = game.get('PlatformCore').instance;
  const localStore = game.get('LocalStorageUtils');

  /** 游戏存 token 时同步写一份到 LocalStorageUtils，作为下次免扫码的重放源 */
  const origSaveServerToken = platformCore.saveServerToken;
  platformCore.saveServerToken = function (token) {
    origSaveServerToken.call(this, token);
    localStore.set('app_serverToken', token);
  };

  /**
   * 服务器列表参数：有缓存 token 则直接填 token/platform（必要时补 webgameqq code）；
   * 无缓存且为 webgameqq 首次登录时，把 code 存下来供以后复用
   * @param {object} param 游戏原装的登录参数（就地修改）
   */
  const origSetServerListParam = platformCore.setServerListParam;
  platformCore.setServerListParam = function (param) {
    origSetServerListParam.call(this, param);
    const token = localStore.get('app_serverToken');
    if (token) {
      const platform = CryptoJS.enc.Utf8.stringify(CryptoJS.enc.Base64.parse(token)).split(',')[1];
      param.token = token;
      param.platform = platform;
      if (param.platform === 'webgameqq') param.code = localStore.get('app_webgameqqCode');
    } else if (param.platform === 'webgameqq' && param.code) {
      localStore.set('app_webgameqqCode', param.code);
    }
  };

  /**
   * 登录参数：从 serverInfoToken 解出平台名覆写 param.platform
   * @param {object} param 游戏原装的登录参数（就地修改）
   */
  const origSetLoginParam = platformCore.setLoginParam;
  platformCore.setLoginParam = function (param) {
    origSetLoginParam.call(this, param);
    const platform = CryptoJS.enc.Utf8.stringify(CryptoJS.enc.Base64.parse(param.serverInfoToken)).split(',')[1];
    param.platform = platform;
  };

  // 自动复用 token 后，游戏默认无法主动换号，这里补登出能力。
  platformCore.canUserLogout = function () { return true; };
  /** 清掉自动登录凭证并回到干净 URL（面板「登出 / 换号」调） */
  platformCore.userLogout = function () {
    if (!window.confirm('确定登出并清除自动登录凭证？')) return;
    localStore.set('app_serverToken', null);
    window.location.href = window.location.href.split('?')[0];
  };

  // 启动即重放：旧登录参数路径的 token 作兜底，取到就存；之后清掉会干扰选服的历史键。
  const cachedToken = localStore.get('app_serverToken') ?? localStore.get('app_loginFlowArgs')?.serverInfoToken;
  platformCore.saveServerToken(cachedToken);
  localStore.del('app_gameServer');
  localStore.del('app_loginFlowArgs');
}
