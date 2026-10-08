// 纯数据规则，供工作台与回归测试共用。
export function evidenceStatus(evidence, revision) {
  if (!revision || evidence.revision !== revision) return "stale";
  return evidence.exit_code === 0 && !evidence.cancelled && !evidence.timed_out ? "passed" : "failed";
}
export function manualStatus(criterion, revision) {
  if (!criterion.manual_accepted) return "pending";
  return revision && criterion.accepted_revision === revision ? "accepted" : "stale";
}
export function fitEvidence(records) {
  // 保留状态与命令；旧输出超出预算时缩短，避免相册和日志挤满项目状态。
  let remaining = 450 * 1024;
  return records.slice(-80).reverse().map((record) => {
    const output = String(record.output || "");
    let fitted = output.slice(-16000);
    while (new TextEncoder().encode(fitted).length > remaining) fitted = fitted.slice(Math.ceil(fitted.length / 4));
    remaining -= new TextEncoder().encode(fitted).length;
    return { ...record, output: fitted, output_truncated: !!record.output_truncated || fitted.length < output.length };
  }).reverse();
}
export function imageBytes(attachment) {
  const url = attachment?.data_url;
  if (typeof url !== "string" || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(url)) return Infinity;
  const base64 = url.slice(url.indexOf(",") + 1);
  if (base64.length % 4 !== 0) return Infinity;
  return base64.length / 4 * 3 - (base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0);
}
