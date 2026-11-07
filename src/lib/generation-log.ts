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
 *                 | cache_hit | dedup_join | background_complete
 *                 | background_timeout | background_busy
 *   request_id    本次客户端请求的唯一 ID（用于把一次调用的全部日志串起来）
 *   model         客户端请求的模型 ID
 *   model_req_key 实际发给上游即梦的 model_req_key
 *   history_id    上游任务记录 ID（提交成功后才有；超时后凭它可恢复查询）
 *   fingerprint   请求指纹前 12 位（cache_hit / dedup_join 等去重事件用；
 *                 指纹是模型+提示词+参数+账号标识的 sha256，不可反推出原文）
 *   elapsed_ms    从提交到该事件的耗时
 *   upstream_status 上游任务状态码（20 排队/42/45 处理中/50/21 完成/30 失败）
 *   fail_code     上游失败码（有才记）
 *   credits_before / credits_after  提交前后账号积分（after 拿不到时为 null）
 *   result_count  返回的图片张数
 *   error         错误信息（有才记）
 *
 * 事件语义（第二轮：后台完成 + 去重缓存）：
 *   timeout            本次 HTTP 等待上限到了，任务仍在后台跑，客户端拿到 -2011；
 *                      重试同一请求会命中缓存或加入等待，不会重复扣积分。
 *   background_complete 任务在后台完成了（此前已有等待者先拿了 -2011 走掉）；
 *                      重试同一请求即命中缓存。
 *   background_timeout 后台跑满总上限仍无结果，任务被放弃（historyId 保留，
 *                      下一次相同请求会尝试重新挂接而不是重新提交）。
 *   cache_hit          相同请求命中缓存，直接返回已完成的结果，未提交新任务。
 *   dedup_join         相同请求加入进行中的同一个任务，未重复提交。
 *   background_busy    后台任务已满，本次请求被拒绝（未提交、未扣积分）。
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
  event:
    | "submit"
    | "poll_error"
    | "success"
    | "failed"
    | "timeout"
    | "query"
    | "cache_hit"
    | "dedup_join"
    | "background_complete"
    | "background_timeout"
    | "background_busy";
  request_id: string;
  model?: string;
  model_req_key?: string;
  history_id?: string | null;
  fingerprint?: string;
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
