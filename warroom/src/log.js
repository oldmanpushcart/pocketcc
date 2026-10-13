// Structured console logger, mirrors extension/src/core/log.js semantics.
// Levels: info = lifecycle & key actions; debug = per-item detail; warn = real anomalies.
// Messages are English; printf-style %s/%d/%i/%f/%% are substituted here (not by console)
// so output is stable regardless of the host console's formatting support.

/**
 * @typedef {{ info:(t:string,...a:any[])=>void, debug:(t:string,...a:any[])=>void, warn:(t:string,...a:any[])=>void }} Logger
 */

/**
 * Replace %s/%d/%i/%f/%% in `tpl` with leading args; leftover args are passed through.
 * @param {string} tpl
 * @param {any[]} args
 * @returns {{ text: string, rest: any[] }}
 */
function fmt(tpl, args) {
  let i = 0;
  const text = String(tpl).replace(/%[sdifj%]/g, (tok) => {
    if (tok === '%%') return '%';
    if (i >= args.length) return tok; // keep placeholder if args run out
    const v = args[i++];
    if (tok === '%d' || tok === '%f') return String(Number(v));
    if (tok === '%i') return String(parseInt(String(v), 10));
    if (tok === '%j') return JSON.stringify(v);
    return typeof v === 'object' ? JSON.stringify(v) : String(v);
  });
  return { text, rest: args.slice(i) };
}

/**
 * @param {string} module uppercase module tag, e.g. 'FETCH'
 * @returns {Logger}
 */
export function createLog(module) {
  const prefix = `[WARROOM://${module}]`;
  const emit = (method, tpl, args) => {
    const { text, rest } = fmt(tpl, args);
    if (rest.length) console[method](prefix, text, ...rest);
    else console[method](prefix, text);
  };
  const debugOn = process.env.WARROOM_DEBUG === '1';
  return {
    info: (tpl, ...a) => emit('log', tpl, a),
    debug: (tpl, ...a) => {
      if (debugOn) emit('log', tpl, a);
    },
    warn: (tpl, ...a) => emit('warn', tpl, a),
  };
}
