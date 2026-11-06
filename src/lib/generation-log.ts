import logger from "./logger.ts";

/**
 * 生图/视频生成链路的结构化日志。
 *
 * 每个事件写成一行 JSON（前缀 [GEN]），便于 grep / jq 过滤，例如：
 *   grep '\[GEN\]' logs/2026-11-06.log | jq -s '.[] | select(.event=="timeout")'
 *
 * 字段约定（所有事件共有）：
 *   ts            ISO 时间
 *   event         submit | poll_error | success | failed | timeout | query
 *   request_id    本次客户端请求的唯一 ID（用于把一次调用的全部日志串起来）
 *   model         客户端请求的模型 ID
 *   model_req_key 实际发给上游即梦的 model_req_key
 *   history_id    上游任务记录 ID（提交成功后才有；超时后凭它可恢复查询）
 *   elapsed_ms    从提交到该事件的耗时
 *   upstream_status 上游任务状态码（20 排队/42/45 处理中/50/21 完成/30 失败）
 *   fail_code     上游失败码（有才记）
 *   credits_before / credits_after  提交前后账号积分（after 拿不到时为 null）
 *   result_count  返回的图片张数
 *   error         错误信息（有才记）
 *
 * 安全：这里只记录上面这些白名单字段，绝不记录 sessionid / Cookie /
 * Authorization / API Key。sanitizeForLog() 用于兜底脱敏任意对象。
 */

const SENSITIVE_KEY = /(sessionid|sid_tt|sid_guard|cookie|authorization|api[_-]?key|access[_-]?token|password|secret)/i;

export function sanitizeForLog(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(sanitizeForLog);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY.test(key) ? "[REDACTED]" : sanitizeForLog(item);
    }
    return out;
  }
  return value;
}

export interface GenerationLogEvent {
  event: "submit" | "poll_error" | "success" | "failed" | "timeout" | "query";
  request_id: string;
  model?: string;
  model_req_key?: string;
  history_id?: string | null;
  elapsed_ms?: number;
  upstream_status?: number | null;
  fail_code?: string | null;
  credits_before?: number | null;
  credits_after?: number | null;
  result_count?: number;
  resolution?: string;
  ratio?: string;
  n?: number;
  error?: string;
}

export function logGenerationEvent(fields: GenerationLogEvent): void {
  try {
    logger.info(`[GEN] ${JSON.stringify({ ts: new Date().toISOString(), ...fields })}`);
  } catch {
    // 日志失败绝不能影响主流程
  }
}
