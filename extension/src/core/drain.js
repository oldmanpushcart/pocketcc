/**
 * 串行消费器：把 queue 里的项逐条 process，条与条之间休眠 interval()。
 * 同一时刻只允许一个消费循环（consuming 闸门）；队列空则不空等。
 * alive() 是退出闸门：置否后当前循环在下一个边界自然收手（已发出的请求收不回）。
 * 单条 process 抛错由本器兜住，不中断整轮消费。
 *
 * @param {object} o
 * @param {object} o.log createLog 实例
 * @param {{get:function():Array}} o.queue 队列访问器（热读，pause 不清空由此体现）
 * @param {function():boolean} o.alive 是否继续消费
 * @param {function(*):Promise<void>} o.process 单条处理，收到 shift 出来的队列项
 * @param {function():number} o.interval 条间休眠毫秒（热读，运行中改即下一轮生效）
 * @returns {{consume:function():Promise<void>}}
 */
export function createDrain(o) {
  /** @type {Logger} 调用方传入的日志器 */
  const log = o.log;
  /** @type {boolean} 消费闸门：同一时刻只允许一个 consume 循环 */
  let consuming = false;

  /**
   * 休眠
   * @param {number} ms 毫秒
   * @returns {Promise<void>}
   */
  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  /**
   * 消费循环：队列非空且 alive 则逐条 process，条间休眠；重入直接返回
   * @returns {Promise<void>}
   */
  async function consume() {
    if (consuming) return;
    consuming = true;
    try {
      while (o.queue.get().length && o.alive()) {
        const item = o.queue.get().shift();
        try {
          await o.process(item);
        } catch (err) {
          log.warn('drain item threw!', err);
        }
        if (o.queue.get().length && o.alive()) {
          await sleep(o.interval());
        }
      }
    } finally {
      consuming = false;
    }
  }

  /** @returns {{consume: function(): Promise<void>}} 消费入口 */
  return { consume: consume };
}
