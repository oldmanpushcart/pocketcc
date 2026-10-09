/**
 * pocketcc background service worker（MV3）
 * 唯一职责：代 bridge(ISOLATED) 向本地 dashcam 接收器发 POST，把录制报文落盘。
 * 放这里而非 content/MAIN 发：service worker 用扩展自有源 + manifest host_permissions，
 * 不受游戏页 connect-src 与 https→http 混合内容限制，是绕开页面 CSP 落盘 localhost 的最干净通道。
 * 不引存储、不建定时器；报文只过路，写盘由 dashcam 工程负责。
 */

/**
 * 把一批 NDJSON 报文 POST 到转发地址，携会话元数据头供 dashcam 命名与建索引。
 * @param {{url?:string, session?:string, ndjson?:string, uid?:string, startTs?:number, note?:string, done?:boolean}} msg
 * @returns {Promise<number>} HTTP 状态码
 */
async function ingest(msg) {
  const res = await fetch(msg.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-ndjson',
      'x-session': String(msg.session || ''),
      'x-uid': String(msg.uid || ''),
      'x-start': String(msg.startTs || ''),
      // HTTP 头只能携 Latin-1；note 可能含中文，必须 percent 编码，dashcam 侧 decodeURIComponent。
      'x-note': encodeURIComponent(String(msg.note || '')),
      'x-done': msg.done ? '1' : '',
    },
    body: String(msg.ndjson || ''),
  });
  return res.status;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'dashcam-flush') {
    // 异步回执：return true 保持端口；失败/无接收器回 err 仅供诊断，bridge 侧已忽略、不阻断录制。
    ingest(msg)
      .then((status) => sendResponse({ ok: status }))
      .catch((e) => sendResponse({ err: String(e) }));
    return true;
  }
  // 其余消息非本 worker 职责，不响应。
  return false;
});
