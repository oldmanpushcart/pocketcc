// reportId -> OSS URL. Rule (verified): the first 4 digits of the id form a
// shard directory, then the full id as the json filename.
//   4878890640079697925 -> prod/4878/4878890640079697925.json

/**
 * @param {string} reportId  full 64-bit id as string
 * @param {{ baseUrl:string, pathTemplate:string }} oss
 * @returns {string}
 */
export function buildReportUrl(reportId, oss) {
  const id = String(reportId).trim();
  if (!/^\d{4,}$/.test(id)) throw new Error(`invalid reportId: ${reportId}`);
  const prefix4 = id.slice(0, 4);
  const path = oss.pathTemplate.replace('{prefix4}', prefix4).replace('{reportId}', id);
  return oss.baseUrl.replace(/\/+$/, '') + path;
}

/**
 * Relative on-disk path for the raw report, sharded by prefix4.
 * Stored relative to rawDir so the db stays portable across machines.
 * @param {string} reportId
 * @returns {string} e.g. "4878/4878890640079697925.json"
 */
export function rawRelPath(reportId) {
  const id = String(reportId).trim();
  return `${id.slice(0, 4)}/${id}.json`;
}
