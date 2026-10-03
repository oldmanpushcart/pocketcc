// 应答载荷归一化：把 net 三条链路的 Ret.data 形态差异收口成一处，feat 侧无需再各写各的 parse。
//
// 形态不对称（真机实证，floatcar 902 误报 "pickup resp shape unexpected" 的根因）：
// 1) 旧 JSON 链路 net.send：Ret.data 直取报文 ret.d，net 不做 JSON_PARSE ——
//    受理时是整包 JSON 文本（'{"marchInfo":{...}}'），被拒时是「语言键,参数」裸串（'alliance_120503,10'）。
//    ⇒ 想按对象取字段（ret.data.xxx）必须先过本模块；裸串则是唯一的拒绝线索，不能当解析失败丢掉。
// 2) PB 链路 net.sendPB / net.sendPBV2：Ret.data 已是解码后的业务对象（net 内部取了 pbAck(_V2).data），
//    直接 ret.data.xxx 天然可用，无需本模块。
// 结论：只有走 net.send 且要按对象读字段的站点需要 payloadOf；PB/push 路径已由底座归一化。

/**
 * 归一化 net.send 的应答载荷：JSON 文本 → 对象；已对象化 / 裸文案键串 / 数字 → 原样返回；空载荷 → null。
 * 对 PB(sendPB/sendPBV2) 的已解析对象是幂等的（透传），可安全用于任意链路。
 * @param {object|*} retOrData net.Ret（读其 .data）或直接是载荷本身
 * @returns {*} 业务载荷（对象或裸串）；空返回 null
 */
export function payloadOf(retOrData) {
    var d = retOrData == null
        ? null
        : (typeof retOrData === 'object' && 'code' in retOrData && 'data' in retOrData ? retOrData.data : retOrData);
    if (d == null || d === '') return null;
    if (typeof d !== 'string') return d;
    try { return JSON.parse(d); } catch (err) { return d; }
}
