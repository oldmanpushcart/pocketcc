/**
 * 次元矿洞 · 采集规则匹配（①挖矿 / ②盗窃封存 共享，无状态）。
 * rules 显式传参：调用方各自传入当前生效规则集（env.getRules()）。
 */
import { gameData } from '../../../core/game-api.js';

// 行存在即生效（面板已移除行级 enabled 勾选）：过滤掉空项，返回全部规则。
export function activeRules(rules) {
  var out = [];
  if (!rules) return out;
  for (var i = 0; i < rules.length; i++) if (rules[i]) out.push(rules[i]);
  return out;
}

// 某矿种规格是否命中「任一规则」。无规则 = 不采（返回 false）。
// type/level/star 各维度 0 = 该维度不限；非 0 必须精确相等。口径同游戏 MineCaveHomeMineItem。
export function matchSpec(specId, rules) {
  var spec = gameData.mineSpec(specId);
  if (!spec) return false;
  var active = activeRules(rules);
  if (!active.length) return false;
  var type = Number(spec.type) || 0;
  var lv = Number(spec.level) || 0;
  var st = Number(spec.star) || 0;
  for (var i = 0; i < active.length; i++) {
    var r = active[i];
    if (r.type > 0 && r.type !== type) continue;
    if (r.level > 0 && r.level !== lv) continue;
    if (r.star > 0 && r.star !== st) continue;
    return true;
  }
  return false;
}

// 矿种规格的星级（候选排序用）；无规格返回 0。
export function specStar(specId) {
  var spec = gameData.mineSpec(specId);
  return spec ? Number(spec.star) || 0 : 0;
}
