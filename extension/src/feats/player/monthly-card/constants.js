/** @type {number} RequestId.GET_TIMECARD_REWARD（V1 send，游戏月卡领取按钮同款） */
export const CMD_GET_TIMECARD_REWARD = 750;

/** @type {number} RequestId.GET_AD_MONTH_CARD_WATCH_INFO（PBV2，读取广告奖励每日进度） */
export const CMD_GET_AD_MONTH_CARD_WATCH_INFO = 9706;

/** @type {number} RequestId.GET_ALL_AD_MONTH_CARD_REWARD（PBV2，一次领取全部 ready 奖励） */
export const CMD_GET_ALL_AD_MONTH_CARD_REWARD = 9708;

/**
 * @type {number} 至尊月卡商店档位（公开客户端 ExchangeController.MONTHLYCARD_SHIT_ID_NEW）。
 * 同一张卡同时承载每日礼包与广告 x2 特权，两个子链共用此 cardId。
 */
export const CARD_ID_MONTHLY = 5003;
