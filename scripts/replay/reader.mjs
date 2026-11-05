/**
 * NDJSON 录制读取器（replay 内核 · 全 feat 共享的扫描机制）。
 *
 * 负责「怎么读」，不负责「读出来意味着什么」：
 *   - 流式逐行解析（大文件不整块进内存）、坏行静默计数；
 *   - entry 归一：dir / cmd / ts / rt / seq / name / outer / body / header / raw；
 *   - 通用抽取：写动作集合（由 handlers.isWrite 判定）+ 应答配对（resp.rt===req.ts → {s,d}）；
 *   - feat 特有的现场态重建交给 handlers.onEntry(entry, acc) 往 acc 里挂数组/Map。
 *
 * 目录(dir)实测值：'push'、'resp'、'req:send'、'req:sendPB'、'req:sendPBV2'。
 */
import { createReadStream } from 'node:fs';
import fs from 'node:fs';
import { createInterface } from 'node:readline';

/**
 * 单遍流式扫描录制。
 * @param {string} recPath 录制绝对路径
 * @param {object} handlers
 *   - isWrite?(entry) => boolean          判定是否记为一笔「写动作」
 *   - onEntry?(entry, acc) => void         feat 特有的现场态累积
 *   - respPairs?:boolean                   是否自动填充 respByReqTs（缺省 true）
 * @returns {Promise<{writes:Array,respByReqTs:Map,total:number,parseErr:number,minTs:number,maxTs:number,dirCounts:Map,acc:object}>}
 */
export async function scanNDJSON(recPath, handlers = {}) {
  if (!fs.existsSync(recPath)) throw new Error('录制不存在: ' + recPath);
  const { isWrite, onEntry, respPairs = true } = handlers;

  const writes = [];
  const respByReqTs = new Map(); // reqTs -> {s,d}
  const acc = {}; // feat 在 onEntry 里挂载自己的时间线数组/Map

  let total = 0;
  let parseErr = 0;
  let minTs = Infinity;
  let maxTs = 0;
  const dirCounts = new Map();

  const rl = createInterface({ input: createReadStream(recPath), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    total++;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      parseErr++;
      continue;
    }

    const dir = String(o.dir || '');
    const cmd = Number(o.cmd);
    const ts = Number(o.ts) || 0;
    const rt = Number(o.rt) || 0;
    if (ts) {
      if (ts < minTs) minTs = ts;
      if (ts > maxTs) maxTs = ts;
    }
    dirCounts.set(dir, (dirCounts.get(dir) || 0) + 1);

    // 业务载荷：resp/push 外层是 data:{header,data}；纯 push 也可能直接是 data 本体
    const outer = o.data;
    const body = outer && typeof outer === 'object' && 'data' in outer ? outer.data : outer;
    const header = outer && typeof outer === 'object' && outer.header ? outer.header : null;

    const entry = {
      dir,
      cmd,
      ts,
      rt,
      seq: o.seq,
      name: o.name,
      raw: o.raw,
      outer,
      body,
      header,
    };

    // 应答配对：resp.rt === 对应 req.ts；header.s=0 成功 / =3 业务拒（拒因在 header.d）
    if (respPairs && dir === 'resp' && rt && header) {
      respByReqTs.set(rt, {
        s: header.s != null ? Number(header.s) : null,
        d: header.d != null ? String(header.d) : null,
      });
    }

    // 写动作抽取：req:* 且 isWrite 命中
    if (dir.startsWith('req') && isWrite && isWrite(entry)) {
      const req = (o.raw && o.raw.data) || body || o.data || {};
      writes.push({ t: ts, cmd, name: o.name, req, seq: o.seq, rt: null });
    }

    if (onEntry) onEntry(entry, acc);
  }

  return { writes, respByReqTs, total, parseErr, minTs, maxTs, dirCounts, acc };
}

/**
 * 回溯查询：在按 ts 升序排列的快照数组里，找最近一条 ts<=T 的快照。
 * 复现「发包那一刻引擎看到的世界」的核心原语——各 feat 通用。
 * @param {Array<{ts:number}>} snapArr 已按 ts 升序
 * @param {number} T
 */
export function snapshotAt(snapArr, T) {
  let lo = 0;
  let hi = snapArr.length - 1;
  let res = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (snapArr[mid].ts <= T) {
      res = snapArr[mid];
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return res;
}
