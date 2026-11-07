import _ from "lodash";

import APIException from "@/lib/exceptions/APIException.ts";
import EX from "@/api/consts/exceptions.ts";
import util from "@/lib/util.ts";
import { getCredit, receiveCredit, request, uploadFile } from "./core.ts";
import logger from "@/lib/logger.ts";
import { logGenerationEvent, sanitizeForLog } from "@/lib/generation-log.ts";
import {
  computeImageFingerprint,
  hashAccountToken,
  hashReferenceInput,
  imageJobManager,
  type GenerationJob,
  type JobOutcome,
} from "@/lib/generation-jobs.ts";
import { JimengModelConfig, resolveImageModelConfig } from "./models.ts";

const DEFAULT_ASSISTANT_ID = 513695;
export const DEFAULT_MODEL = "jimeng-image-5.0-lite";
const DRAFT_VERSION = "3.3.20";
// 生图轮询超时配置（均可用环境变量覆盖，改完需重启服务）：
// JIMENG_IMAGE_POLL_TIMEOUT_MS          主轮询总时长上限，默认 120000（120 秒，与旧版 120 次轮询等价）
// JIMENG_IMAGE_POLL_INTERVAL_MS         每次状态查询间隔，默认 1000
// JIMENG_IMAGE_POLL_GRACE_ATTEMPTS      主轮询超时后的宽限查询次数，默认 6（任务可能刚好完成）
// JIMENG_IMAGE_POLL_MAX_CONSECUTIVE_ERRORS  连续查询失败多少次后放弃等待，默认 5
const POLL_TIMEOUT_MS = Number(process.env.JIMENG_IMAGE_POLL_TIMEOUT_MS || 120_000);
const POLL_INTERVAL_MS = Number(process.env.JIMENG_IMAGE_POLL_INTERVAL_MS || 1000);
const POLL_GRACE_ATTEMPTS = Number(process.env.JIMENG_IMAGE_POLL_GRACE_ATTEMPTS || 6);
const POLL_MAX_CONSECUTIVE_ERRORS = Number(
  process.env.JIMENG_IMAGE_POLL_MAX_CONSECUTIVE_ERRORS || 5
);
// 后台完成总上限：提交后即使客户端 HTTP 连接断开（例如 Cherry Studio
// 60 秒超时），后台轮询也继续到这个上限（默认 600 秒），结果进缓存；
// 客户端重试同一请求时命中缓存，不再新建任务、不再重复扣积分。
// 改完需重启服务；不要小于 JIMENG_IMAGE_POLL_TIMEOUT_MS。
const BACKGROUND_TIMEOUT_MS = Number(
  process.env.JIMENG_IMAGE_BACKGROUND_TIMEOUT_MS || 600_000
);

// 后台任务的生命周期事件 → 结构化 [GEN] 日志。
// 全部事件（cache_hit / dedup_join / background_complete /
// background_timeout / background_busy / cache_evict）都由管理器经 onEvent
// 统一发，wrapper 不再重复记，避免同一事件出现两条日志。
imageJobManager.onEvent = (event) => {
  const fingerprint = event.fingerprint?.slice(0, 12);
  switch (event.type) {
    case "cache_hit":
    case "dedup_join":
      // 命中缓存 / 加入等待中的同一任务：由管理器统一记，避免 wrapper 重复记
      logGenerationEvent({
        event: event.type,
        request_id: event.requestId || util.uuid(),
        model: event.model,
        model_req_key: event.modelReqKey,
        history_id: event.historyId,
        fingerprint,
        elapsed_ms: event.elapsedMs,
        result_count: event.resultCount,
      });
      break;
    case "background_busy":
      logGenerationEvent({
        event: "background_busy",
        request_id: event.requestId || util.uuid(),
        model: event.model,
        fingerprint,
        error: "background job limit reached",
      });
      break;
    case "background_complete":
      logGenerationEvent({
        event: "background_complete",
        request_id: event.requestId || util.uuid(),
        model: event.model,
        model_req_key: event.modelReqKey,
        history_id: event.historyId,
        fingerprint,
        elapsed_ms: event.elapsedMs,
        upstream_status: event.upstreamStatus,
        credits_before: event.creditsBefore,
        credits_after: event.creditsAfter,
        result_count: event.resultCount,
      });
      break;
    case "background_timeout":
      logGenerationEvent({
        event: "background_timeout",
        request_id: event.requestId || util.uuid(),
        model: event.model,
        model_req_key: event.modelReqKey,
        history_id: event.historyId,
        fingerprint,
        elapsed_ms: event.elapsedMs,
        upstream_status: event.upstreamStatus,
        credits_before: event.creditsBefore,
        credits_after: event.creditsAfter,
        error: "background poll timeout",
      });
      break;
    case "cache_evict":
      logger.info(
        `🗑️ [缓存] 淘汰指纹 ${event.fingerprint.slice(0, 12)}…（原因：${event.reason}）`
      );
      break;
  }
};
// Draft content version matching the official web client payload (the
// request-level da_version stays 3.3.20). The payload is kept field-for-field
// aligned with what jimeng.jianying.com sends; the decisive field is
// `abilities.gen_option`, which Jimeng ignores when placed on the component.
const DRAFT_CONTENT_VERSION = "3.0.2";
const WEB_VERSION = "7.5.0";
const MIN_VERSION = "3.0.2";

const MODEL_MAP = {
  "jimeng-image-5.0-pro": "high_aes_general_v50p_large",
  "jimeng-image-5.0-lite": "high_aes_general_v50",
  "jimeng-image-5.0-flash": "high_aes_general_v50_flash",
  "jimeng-image-4.7": "high_aes_general_v43",
  "jimeng-image-4.6": "high_aes_general_v42",
  "jimeng-image-4.5": "high_aes_general_v40l",
  "jimeng-image-4.1": "high_aes_general_v41",
  "jimeng-image-4.0": "high_aes_general_v40",
  "jimeng-image-3.1": "high_aes_general_v30l_art_fangzhou:general_v3.0_18b",
  "jimeng-image-3.0": "high_aes_general_v30l:general_v3.0_18b",
  "jimeng-image-2.0-pro": "high_aes_general_v20_L:general_v2.0_L",
};

function isHighResImageModel(modelName: string, modelConfig?: JimengModelConfig) {
  if (modelConfig) return modelConfig.supportedResolutions.includes("2k");
  return [
    "jimeng-image-5.0-lite",
    "jimeng-image-5.0-flash",
    "jimeng-image-4.7",
    "jimeng-image-4.6",
    "jimeng-image-4.5",
    "jimeng-image-4.1",
    "jimeng-image-4.0",
  ].includes(modelName);
}

function getImageResolutionLevels(modelName: string) {
  if (modelName === "jimeng-image-2.0-pro") return ["1k"];
  if (modelName === "jimeng-image-5.0-pro") return ["4k", "2k", "1.5k"];
  if (modelName === "jimeng-image-5.0-flash") return ["2k", "1.5k"];
  if (isHighResImageModel(modelName)) return ["4k", "2k"];
  return ["1k"];
}

function getImageResolutionFallbacks(
  modelName: string,
  requestedResolution?: string,
  modelConfig?: JimengModelConfig
) {
  const defaultResolution =
    modelConfig?.defaultResolution || (isHighResImageModel(modelName) ? "2k" : "1k");
  const supportedResolutions =
    modelConfig?.supportedResolutions?.length
      ? modelConfig.supportedResolutions
      : getImageResolutionLevels(modelName);
  const startResolution = supportedResolutions.includes(requestedResolution || "")
    ? requestedResolution
    : defaultResolution;
  const startIndex = Math.max(
    0,
    supportedResolutions.indexOf(startResolution || defaultResolution)
  );
  return supportedResolutions.slice(startIndex);
}

// 即梦支持的图片比例映射
// image_ratio 值: 0=21:9, 1=16:9, 2=3:2, 3=4:3, 8=1:1, 4=3:4, 5=2:3, 6=9:16
const ASPECT_RATIOS = [
  "21:9",
  "16:9",
  "3:2",
  "4:3",
  "1:1",
  "3:4",
  "2:3",
  "9:16",
];

// 比例对应的 image_ratio 值
const RATIO_VALUES: Record<string, number> = {
  "21:9": 0,
  "16:9": 1,
  "3:2": 2,
  "4:3": 3,
  "1:1": 8,
  "3:4": 4,
  "2:3": 5,
  "9:16": 6,
};

// 1K 分辨率尺寸 (3.x 模型)
const DIMENSIONS_1K: Record<string, { width: number; height: number }> = {
  "21:9": { width: 2016, height: 846 },
  "16:9": { width: 1664, height: 936 },
  "3:2": { width: 1584, height: 1056 },
  "4:3": { width: 1472, height: 1104 },
  "1:1": { width: 1328, height: 1328 },
  "3:4": { width: 1104, height: 1472 },
  "2:3": { width: 1056, height: 1584 },
  "9:16": { width: 936, height: 1664 },
};

// 2K 分辨率尺寸 (4.x 模型)
const DIMENSIONS_2K: Record<string, { width: number; height: number }> = {
  "21:9": { width: 3024, height: 1296 },
  "16:9": { width: 2560, height: 1440 },
  "3:2": { width: 2496, height: 1664 },
  "4:3": { width: 2304, height: 1728 },
  "1:1": { width: 2048, height: 2048 },
  "3:4": { width: 1728, height: 2304 },
  "2:3": { width: 1664, height: 2496 },
  "9:16": { width: 1440, height: 2560 },
};

const DIMENSIONS_1_5K: Record<string, { width: number; height: number }> = {
  "21:9": { width: 2268, height: 972 },
  "16:9": { width: 1920, height: 1080 },
  "3:2": { width: 1872, height: 1248 },
  "4:3": { width: 1728, height: 1296 },
  "1:1": { width: 1536, height: 1536 },
  "3:4": { width: 1296, height: 1728 },
  "2:3": { width: 1248, height: 1872 },
  "9:16": { width: 1080, height: 1920 },
};

const DIMENSIONS_4K: Record<string, { width: number; height: number }> = {
  "21:9": { width: 6197, height: 2656 },
  "16:9": { width: 5404, height: 3040 },
  "3:2": { width: 4992, height: 3328 },
  "4:3": { width: 4693, height: 3520 },
  "1:1": { width: 4096, height: 4096 },
  "3:4": { width: 3520, height: 4693 },
  "2:3": { width: 3328, height: 4992 },
  "9:16": { width: 3040, height: 5404 },
};

/**
 * 从提示词中检测图片比例
 * 支持格式: 16:9, 16：9, 比例16:9, 横屏, 竖屏 等
 * 返回比例字符串，如 "16:9"
 */
function detectAspectRatioKey(prompt: string): string | null {
  // 正则匹配比例格式 (支持中英文冒号)
  const ratioRegex = /(\d+)\s*[:：]\s*(\d+)/g;
  const matches = [...prompt.matchAll(ratioRegex)];

  for (const match of matches) {
    const key = `${match[1]}:${match[2]}`;
    if (ASPECT_RATIOS.includes(key)) {
      logger.info(`📐 [比例检测] 从提示词检测到比例: ${key}`);
      return key;
    }
  }

  // 支持中文关键词
  if (/横屏|横版|宽屏/.test(prompt)) {
    logger.info(`📐 [比例检测] 检测到横屏关键词 → 16:9`);
    return "16:9";
  }
  if (/竖屏|竖版|手机/.test(prompt)) {
    logger.info(`📐 [比例检测] 检测到竖屏关键词 → 9:16`);
    return "9:16";
  }
  if (/方形|正方/.test(prompt)) {
    logger.info(`📐 [比例检测] 检测到方形关键词 → 1:1`);
    return "1:1";
  }

  return null;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 查询一次上游任务状态（get_history_by_ids）。
 * 返回 null 表示上游查不到这条记录；其它情况返回 {status, failCode, itemList}。
 * 供轮询和恢复查询接口共用。
 */
export async function queryImageHistory(
  historyId: string,
  refreshToken: string
): Promise<{ status: number; failCode?: string; itemList: any[] } | null> {
  const result = await request(
    "post",
    "/mweb/v1/get_history_by_ids",
    refreshToken,
    {
      data: {
        history_ids: [historyId],
        image_info: {
          width: 2048,
          height: 2048,
          format: "webp",
          image_scene_list: [
            {
              scene: "smart_crop",
              width: 360,
              height: 360,
              uniq_key: "smart_crop-w:360-h:360",
              format: "webp",
            },
            {
              scene: "smart_crop",
              width: 480,
              height: 480,
              uniq_key: "smart_crop-w:480-h:480",
              format: "webp",
            },
            {
              scene: "smart_crop",
              width: 720,
              height: 720,
              uniq_key: "smart_crop-w:720-h:720",
              format: "webp",
            },
            {
              scene: "smart_crop",
              width: 720,
              height: 480,
              uniq_key: "smart_crop-w:720-h:480",
              format: "webp",
            },
            {
              scene: "smart_crop",
              width: 360,
              height: 240,
              uniq_key: "smart_crop-w:360-h:240",
              format: "webp",
            },
            {
              scene: "smart_crop",
              width: 240,
              height: 320,
              uniq_key: "smart_crop-w:240-h:320",
              format: "webp",
            },
            {
              scene: "smart_crop",
              width: 480,
              height: 640,
              uniq_key: "smart_crop-w:480-h:640",
              format: "webp",
            },
            {
              scene: "normal",
              width: 2400,
              height: 2400,
              uniq_key: "2400",
              format: "webp",
            },
            {
              scene: "normal",
              width: 1080,
              height: 1080,
              uniq_key: "1080",
              format: "webp",
            },
            {
              scene: "normal",
              width: 720,
              height: 720,
              uniq_key: "720",
              format: "webp",
            },
            {
              scene: "normal",
              width: 480,
              height: 480,
              uniq_key: "480",
              format: "webp",
            },
            {
              scene: "normal",
              width: 360,
              height: 360,
              uniq_key: "360",
              format: "webp",
            },
          ],
        },
        http_common_info: {
          aid: Number(DEFAULT_ASSISTANT_ID),
        },
      },
    }
  );
  if (!result[historyId]) return null;
  return {
    status: result[historyId].status,
    failCode: result[historyId].fail_code,
    itemList: result[historyId].item_list || [],
  };
}

export function extractImageUrls(itemList: any[], n: number): (string | null)[] {
  return itemList
    .map((item) => {
      if (!item?.image?.large_images?.[0]?.image_url)
        return item?.common_attr?.cover_url || null;
      return item.image.large_images[0].image_url;
    })
    .slice(0, n);
}

/** 尽力而为查一次积分，失败返回 null（绝不能影响主流程）。 */
async function fetchCreditsSafe(refreshToken: string): Promise<number | null> {
  try {
    const { totalCredit } = await getCredit(refreshToken);
    return totalCredit;
  } catch {
    return null;
  }
}

/**
 * 轮询上游任务直到完成/失败，或达到给定的总时长上限。
 *
 * 与上一轮的区别：上一轮这个函数到时直接抛 -2011，调用方只能放弃；
 * 现在它只返回结果对象，由调用方决定：前台等待（本次 HTTP）超时时返回
 * -2011 但任务继续；后台跑满上限时记 background_timeout，historyId 保留
 * 供下一次相同请求重新挂接。单次查询失败的容错逻辑保持不变（只记
 * poll_error 并继续等，连续失败到上限才放弃；超时后先做宽限查询）。
 */
export interface PollOutcome {
  /** done=终态（成功/失败）或已有结果 timeout=到上限仍在处理 unseen=上游一直查不到记录 */
  outcome: "done" | "timeout" | "unseen";
  status: number;
  failCode?: string;
  itemList: any[];
  polls: number;
}

async function pollImageHistoryUntil(
  historyId: string,
  refreshToken: string,
  ctx: {
    requestId: string;
    modelName: string;
    modelReqKey: string;
    creditsBefore: number | null;
    startedAt: number;
  },
  opts: {
    /** 本次轮询的总时长上限（毫秒） */
    deadlineMs: number;
    /** 查询函数（默认查上游；测试可注入桩函数） */
    queryFn?: typeof queryImageHistory;
    /** 每次查到新状态时回调（供调用方更新任务的 lastStatus） */
    onStatus?: (status: number, resultCount: number) => void;
  }
): Promise<PollOutcome> {
  const query = opts.queryFn ?? queryImageHistory;
  // 状态码说明：
  // 20 = 初始提交/队列中
  // 42 = 处理中（jimeng-4.5 新状态）
  // 45 = 处理中（jimeng-4.5 中间状态）
  // 50 = 完成/有结果（jimeng-4.5）
  // 21 = 生成成功（旧版本）
  // 30 = 生成失败
  const PROCESSING_STATES = [20, 42, 45];
  const deadline = Date.now() + opts.deadlineMs;
  let status = 20;
  let failCode: string | undefined;
  let itemList: any[] = [];
  let everSeen = false;
  let consecutiveErrors = 0;
  let polls = 0;

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    polls++;
    let result: Awaited<ReturnType<typeof queryImageHistory>>;
    try {
      result = await query(historyId, refreshToken);
    } catch (error) {
      consecutiveErrors++;
      logGenerationEvent({
        event: "poll_error",
        request_id: ctx.requestId,
        model: ctx.modelName,
        model_req_key: ctx.modelReqKey,
        history_id: historyId,
        elapsed_ms: Date.now() - ctx.startedAt,
        upstream_status: status,
        error: error.message,
      });
      logger.warn(
        `⏳ [轮询] 第${polls}次查询失败（连续${consecutiveErrors}次）：${error.message}，继续等待上游任务`
      );
      if (consecutiveErrors >= POLL_MAX_CONSECUTIVE_ERRORS) break;
      continue;
    }
    consecutiveErrors = 0;
    if (!result) {
      consecutiveErrors++;
      logger.warn(`⏳ [轮询] 第${polls}次查询：上游记录暂不可见，继续等待`);
      if (consecutiveErrors >= POLL_MAX_CONSECUTIVE_ERRORS) break;
      continue;
    }
    everSeen = true;
    status = result.status;
    failCode = result.failCode;
    itemList = result.itemList;
    opts.onStatus?.(status, itemList?.length || 0);
    if (polls % 5 === 0 || itemList?.length > 0) {
      logger.info(`⏳ [轮询] 第${polls}次 | 状态码: ${status} | 结果数: ${itemList?.length || 0}`);
    }
    if (!PROCESSING_STATES.includes(status) || (itemList && itemList.length > 0)) break;
  }

  // 宽限期：主轮询超时后不立刻丢弃，再查几次（任务可能刚好完成）
  if (PROCESSING_STATES.includes(status) && (!itemList || itemList.length === 0)) {
    for (let grace = 1; grace <= POLL_GRACE_ATTEMPTS; grace++) {
      await sleep(POLL_INTERVAL_MS);
      try {
        const result = await query(historyId, refreshToken);
        if (!result) continue;
        everSeen = true;
        status = result.status;
        failCode = result.failCode;
        itemList = result.itemList;
        opts.onStatus?.(status, itemList?.length || 0);
        logger.info(
          `⏳ [宽限查询] 第${grace}/${POLL_GRACE_ATTEMPTS}次 | 状态码: ${status} | 结果数: ${itemList?.length || 0}`
        );
        if (!PROCESSING_STATES.includes(status) || (itemList && itemList.length > 0)) break;
      } catch (error) {
        logger.warn(`⏳ [宽限查询] 第${grace}次失败：${error.message}`);
      }
    }
  }

  if (!everSeen) {
    return { outcome: "unseen", status, failCode, itemList, polls };
  }
  if (PROCESSING_STATES.includes(status) && (!itemList || itemList.length === 0)) {
    return { outcome: "timeout", status, failCode, itemList, polls };
  }
  return { outcome: "done", status, failCode, itemList, polls };
}

/**
 * 构造 -2011 超时错误（保留上一轮的错误码与 history_record_id）。
 *
 * 语义变了：以前是“任务丢了，只能凭 ID 自己查”；现在任务仍在后台跑，
 * 客户端直接重试同一请求（相同模型/提示词/参数）即可命中缓存或加入等待，
 * 不会新建任务、不重复扣积分；恢复查询接口仍保留给 API 用户兜底。
 */
function buildTimeoutError(opts: {
  requestId: string;
  modelName: string;
  modelReqKey?: string;
  historyId: string | null;
  elapsedMs: number;
  upstreamStatus?: number | null;
  creditsBefore?: number | null;
  creditsAfter?: number | null;
}): APIException {
  const seconds = Math.round(opts.elapsedMs / 1000);
  const historyPart = opts.historyId
    ? `上游任务 ${opts.historyId} 仍在后台继续处理，即梦可能已扣积分。请直接重试同一请求（相同模型/提示词/参数），反代会返回已完成的结果而不再重复扣积分；也可凭记录ID查询结果：GET /v1/images/generations/query?history_id=${opts.historyId}`
    : `任务仍在后台继续处理，即梦可能已扣积分。请稍后重试同一请求（相同模型/提示词/参数），反代会返回已完成的结果而不再重复扣积分`;
  return new APIException(
    EX.API_IMAGE_GENERATION_TIMEOUT,
    `图像生成超时（已等待 ${seconds} 秒）：${historyPart}。不要换参数重复提交，否则会新建任务再次扣积分`
  ).setData({
    history_record_id: opts.historyId,
    model: opts.modelName,
    model_req_key: opts.modelReqKey,
    elapsed_ms: opts.elapsedMs,
    upstream_status: opts.upstreamStatus ?? null,
    credits_before: opts.creditsBefore ?? null,
    credits_after: opts.creditsAfter ?? null,
  });
}

export function getModel(model: string) {
  return MODEL_MAP[model] || MODEL_MAP[DEFAULT_MODEL];
}

export async function generateImages(
  _model: string,
  prompt: string,
  {
    ratio = "1:1",
    resolution = "2k",
    sampleStrength = 0.5,
    negativePrompt = "",
    filePath,
    filePaths = [],
    n = 1,
  }: {
    ratio?: string;
    resolution?: string;
    sampleStrength?: number;
    negativePrompt?: string;
    filePath?: string; // 向后兼容的单张参考图路径
    filePaths?: string[]; // 参考图路径，支持本地/网络/base64
    n?: number; // 生成张数 (1-8)
  },
  refreshToken: string,
  opts?: {
    /** 本次轮询的总时长上限（毫秒）。默认 120000（前台行为）；后台任务传 BACKGROUND_TIMEOUT_MS */
    pollTimeoutMs?: number;
    /** 上游提交成功后立即回调（让后台任务尽早拿到 historyId 供等待者用） */
    onSubmitted?: (info: {
      historyId: string;
      creditsBefore: number | null;
      modelReqKey: string;
      modelName: string;
    }) => void;
    /** 每次查到新状态时回调（供后台任务更新 lastStatus） */
    onStatus?: (status: number, resultCount: number) => void;
  }
) {
  // 本次请求的唯一 ID + 计时起点：结构化日志用它把提交/轮询/超时/成功串起来
  const requestId = util.uuid();
  const startedAt = Date.now();
  // 供 catch 记结构化失败日志用（在 try 外声明，避免 TDZ）
  let modelReqKeyForLog: string | undefined;
  let creditsBeforeForLog: number | null = null;
  let historyId: string | null = null;
  let lastStatus: number | null = null;
  let lastFailCode: string | null = null;
  let terminalLogged = false;
  try {
  const referenceImagePaths = [...new Set(
    [filePath, ...filePaths].filter(
      (value): value is string => typeof value === "string" && value.trim().length > 0
    )
  )];
  const hasReferenceImages = referenceImagePaths.length > 0;
  const uploadIDs: string[] = [];

  // 如果有参考图，逐张上传并保留顺序，供上游的多图参考字段使用。
  if (hasReferenceImages) {
    logger.info(`🖼️ [参考图] 检测到 ${referenceImagePaths.length} 张参考图 → 混合模式`);
    for (const [index, referenceImagePath] of referenceImagePaths.entries()) {
      const fileDesc = referenceImagePath.startsWith("data:")
        ? `base64图片(${referenceImagePath.length}字符)`
        : referenceImagePath.substring(0, 80);
      try {
        const uploadResult = await uploadFile(refreshToken, referenceImagePath);
        uploadIDs.push(uploadResult.image_uri);
        logger.info(`✅ [参考图] 第 ${index + 1} 张上传成功: ${fileDesc}`);
      } catch (error) {
        logger.error(`❌ [参考图] 第 ${index + 1} 张上传失败: ${error.message}`);
        throw new APIException(
          EX.API_REQUEST_FAILED,
          `第 ${index + 1} 张参考图上传失败: ${error.message}`
        );
      }
    }
  }

  // 使用用户选择的模型（混合模式不再强制3.0）
  const modelName = _model;
  const modelConfig = await resolveImageModelConfig(modelName, refreshToken);
  const model = modelConfig.modelReqKey || getModel(modelName);
  modelReqKeyForLog = model;

  // 解析分辨率和比例
  let resolutionType = resolution.toLowerCase(); // 用户指定优先

  if (!modelConfig.supportedResolutions.includes(resolutionType)) {
    resolutionType = modelConfig.defaultResolution;
    if (resolution !== resolutionType) {
      logger.warn(`⚠️ [分辨率] ${modelName} 不支持 ${resolution}，已自动调整为 ${resolutionType}`);
    }
  }

  const dimensionMap =
    resolutionType === "4k"
      ? DIMENSIONS_4K
      : resolutionType === "1.5k"
      ? DIMENSIONS_1_5K
      : resolutionType === "2k"
      ? DIMENSIONS_2K
      : DIMENSIONS_1K;

  // 从提示词中检测比例
  const detectedRatioKey = detectAspectRatioKey(prompt);
  // 如果用户传了 valid ratio (in map) 则使用，否则使用 detector 或默认 1:1
  // 这里逻辑：如果 ratio 是默认 "1:1" 且 detectedRatioKey 存在，则使用 detected。否则优先使用 ratio 参数。
  // 注意：如果用户显式传了 "1:1" 我们可能无法区分是默认还是显式。
  // 但通常 API 调用者会传 ratio。如果 prompt 里有，我们假设 prompt 优先级较高？不，参数优先级通常更高。
  // 但是 detectAspectRatioKey 用意是方便用户只通过 prompt 控制。
  // 假设：如果 ratio 是 "custom" (API gateways sometimes send "custom"), treat as unset.
  // 这里简化：如果 ratio 参数在 RATIO_VALUES 中且不是 detect 出来的（这里无法区分），直接用。
  // 妥协：优先使用 ratio 参数，除非 ratio 是 "custom" 或者空。

  let validRatio = ratio;
  if (!RATIO_VALUES.hasOwnProperty(validRatio)) {
    validRatio = "1:1";
  }

  // 如果 prompt 里检测到且 ratio 是默认 "1:1" (可能是未传)，则覆盖。
  // 这里的风险是用户真的想 1:1 但 prompt 里有 "16:9"。
  // 鉴于这是一个 "Chat" driven API often，prompt detection is feature.
  if (detectedRatioKey && validRatio === "1:1") {
    validRatio = detectedRatioKey;
  }

  const imageRatio = RATIO_VALUES[validRatio];
  const dimensions = dimensionMap[validRatio];
  const finalWidth = dimensions.width;
  const finalHeight = dimensions.height;

  logger.info(`\n🎨 ════════════════════ 图像生成任务 ════════════════════`);
  logger.info(`   📦 模型: ${modelName}`);
  logger.info(`   🔗 映射: ${model}`);
  logger.info(`   📏 尺寸: ${finalWidth}x${finalHeight} (${validRatio})`);
  logger.info(`   🔍 分辨率: ${resolutionType.toUpperCase()} | 精细度: ${sampleStrength}`);
  logger.info(`   🎯 模式: ${hasReferenceImages ? `混合(${uploadIDs.length} 张参考图)` : "文生图"}`);
  logger.info(`   🖼️ 请求张数: ${n}`);
  logger.info(`═══════════════════════════════════════════════════════════\n`);

  const { totalCredit } = await getCredit(refreshToken);
  const creditsBefore = totalCredit;
  creditsBeforeForLog = creditsBefore;
  if (totalCredit <= 0) await receiveCredit(refreshToken);

  const componentId = util.uuid();

  // 构建 abilities 对象
  let abilities: Record<string, any>;

  if (uploadIDs.length > 0) {
    // 混合模式 abilities
    abilities = {
      type: "",
      id: util.uuid(),
      blend: {
        type: "",
        id: util.uuid(),
        min_features: [],
        core_param: {
          type: "",
          id: util.uuid(),
          model,
          prompt: prompt + "##",
          sample_strength: sampleStrength,
          image_ratio: imageRatio,
          large_image_info: {
            type: "",
            id: util.uuid(),
            height: finalHeight,
            width: finalWidth,
            resolution_type: resolutionType,
          },
        },
        ability_list: [
          {
            type: "",
            id: util.uuid(),
            name: "byte_edit",
            image_uri_list: uploadIDs,
            image_list: uploadIDs.map((uploadID) => ({
                type: "image",
                id: util.uuid(),
                source_from: "upload",
                platform_type: 1,
                name: "",
                image_uri: uploadID,
                width: 0,
                height: 0,
                format: "",
                uri: uploadID,
            })),
            strength: 0.5,
          },
        ],
        history_option: {
          type: "",
          id: util.uuid(),
        },
        prompt_placeholder_info_list: [
          {
            type: "",
            id: util.uuid(),
            ability_index: 0,
          },
        ],
        postedit_param: {
          type: "",
          id: util.uuid(),
          generate_type: 0,
        },
      },
      gen_option: {
        type: "",
        id: util.uuid(),
        gen_count: n,
        generate_all: false,
      },
    };
  } else {
    // 普通生成模式 abilities
    abilities = {
      type: "",
      id: util.uuid(),
      generate: {
        type: "",
        id: util.uuid(),
        core_param: {
          type: "",
          id: util.uuid(),
          model,
          prompt,
          negative_prompt: negativePrompt,
          seed: Math.floor(Math.random() * 100000000) + 2500000000,
          sample_strength: sampleStrength,
          image_ratio: imageRatio,
          large_image_info: {
            type: "",
            id: util.uuid(),
            height: finalHeight,
            width: finalWidth,
            resolution_type: resolutionType,
          },
          generate_type: 0,
        },
        history_option: {
          type: "",
          id: util.uuid(),
        },
      },
      gen_option: {
        type: "",
        id: util.uuid(),
        gen_count: n,
        generate_all: false,
      },
    };
  }

  const submitId = util.uuid();
  
  // 构建请求数据
  const requestData = {
    extend: {
      root_model: model,
    },
    submit_id: submitId,
    metrics_extra: hasReferenceImages
      ? undefined
      : JSON.stringify({
          promptSource: "custom",
          generateCount: n,
          enterFrom: "click",
          sceneOptions: JSON.stringify([
            {
              type: "image",
              scene: "ImageBasicGenerate",
              modelReqKey: model,
              resolutionType: resolutionType,
              abilityList: [],
              benefitCount: n,
              reportParams: {
                enterSource: "generate",
                vipSource: "generate",
                extraVipFunctionKey: `${model}-${resolutionType}`,
                useVipFunctionDetailsReporterHoc: true,
              },
            },
          ]),
          isBoxSelect: false,
          isCutout: false,
          generateId: submitId,
          isRegenerate: false,
        }),
    draft_content: JSON.stringify({
      type: "draft",
      id: util.uuid(),
      min_version: MIN_VERSION,
      min_features: [],
      is_from_tsn: true,
      version: DRAFT_CONTENT_VERSION,
      main_component_id: componentId,
      component_list: [
        {
          type: "image_base_component",
          id: componentId,
          min_version: MIN_VERSION,
          metadata: {
            type: "",
            id: util.uuid(),
            created_platform: 3,
            created_platform_version: "",
            created_time_in_ms: String(Date.now()),
            created_did: "",
          },
          generate_type: hasReferenceImages ? "blend" : "generate",
          aigc_mode: "workbench",
          gen_type: 1,
          abilities,
        },
      ],
    }),
    http_common_info: {
      aid: Number(DEFAULT_ASSISTANT_ID),
    },
  };
  
  // 完整请求数据只记 debug 级，且先脱敏；info 级只留结构化 [GEN] 事件，
  // 避免日志里塞满大段 JSON
  logger.debug(`📤 [请求数据] ${JSON.stringify(sanitizeForLog(requestData))}`);

    const { aigc_data } = await request(
      "post",
      "/mweb/v1/aigc_draft/generate",
      refreshToken,
      {
        params: {
          da_version: DRAFT_VERSION,
          web_component_open_flag: 1,
          web_version: WEB_VERSION,
        },
        data: requestData,
      }
    );
    historyId = aigc_data.history_record_id;
    if (!historyId)
      throw new APIException(EX.API_IMAGE_GENERATION_FAILED, "记录ID不存在");

    // 提交成功立刻把 historyId 交给后台任务：哪怕这次 HTTP 请求随后超时，
    // 等待者也能凭它拿到 -2011 里的记录 ID，重试时还能重新挂接。
    opts?.onSubmitted?.({
      historyId,
      creditsBefore,
      modelReqKey: model,
      modelName,
    });

    logGenerationEvent({
      event: "submit",
      request_id: requestId,
      model: modelName,
      model_req_key: model,
      history_id: historyId,
      elapsed_ms: Date.now() - startedAt,
      credits_before: creditsBefore,
      resolution: resolutionType,
      ratio: validRatio,
      n,
    });

    // 轮询到后台上限（默认 600 秒）或终态为止；超时不由这里定论，
    // 由调用方（后台任务）转成 background_timeout outcome。
    // 注意：这里的 -2011 不再记 timeout 事件——timeout 事件由
    // generateImagesWithRetry 在“本次 HTTP 等待上限到”时记，
    // background_timeout 事件由任务管理器在“后台跑满上限”时记，
    // 避免同一个 -2011 被记两次、语义混淆。
    const poll = await pollImageHistoryUntil(
      historyId,
      refreshToken,
      {
        requestId,
        modelName,
        modelReqKey: model,
        creditsBefore,
        startedAt,
      },
      {
        deadlineMs: opts?.pollTimeoutMs ?? POLL_TIMEOUT_MS,
        onStatus: opts?.onStatus,
      }
    );
    if (poll.outcome === "unseen") {
      throw new APIException(EX.API_IMAGE_GENERATION_FAILED, "记录不存在");
    }
    if (poll.outcome === "timeout") {
      throw buildTimeoutError({
        requestId,
        modelName,
        modelReqKey: model,
        historyId,
        elapsedMs: Date.now() - startedAt,
        upstreamStatus: poll.status,
        creditsBefore,
        creditsAfter: await fetchCreditsSafe(refreshToken),
      });
    }
    const { status, failCode, itemList } = poll;
    lastStatus = status;
    lastFailCode = failCode || null;

    // 状态码说明（见 pollImageHistoryUntil）：
    // 20 排队 / 42、45 处理中 / 50、21 完成 / 30 失败
    const FAIL_STATE = 30;
    if (status === FAIL_STATE) {
      const creditsAfter = await fetchCreditsSafe(refreshToken);
      logGenerationEvent({
        event: "failed",
        request_id: requestId,
        model: modelName,
        model_req_key: model,
        history_id: historyId,
        elapsed_ms: Date.now() - startedAt,
        upstream_status: status,
        fail_code: failCode,
        credits_before: creditsBefore,
        credits_after: creditsAfter,
        error: `upstream fail_code=${failCode}`,
      });
      terminalLogged = true;
      if (failCode === "2038") throw new APIException(EX.API_CONTENT_FILTERED);
      else throw new APIException(EX.API_IMAGE_GENERATION_FAILED);
    }
    if (itemList.length > n) {
      logger.warn(`⚠️ [生成张数] 请求 ${n} 张，上游实际返回 ${itemList.length} 张，请检查即梦积分消耗及请求数据`);
    }
    const urls = extractImageUrls(itemList, n);
    const creditsAfter = await fetchCreditsSafe(refreshToken);
    logGenerationEvent({
      event: "success",
      request_id: requestId,
      model: modelName,
      model_req_key: model,
      history_id: historyId,
      elapsed_ms: Date.now() - startedAt,
      upstream_status: status,
      credits_before: creditsBefore,
      credits_after: creditsAfter,
      result_count: urls.filter(Boolean).length,
    });
    return urls;
  } catch (error) {
    // 超时错误已在 pollImageHistory 内记过 timeout 事件；失败终态已在上面
    // 记过 failed 事件；其余错误（提交失败等）在这里记一条 failed
    const isTimeout =
      error instanceof APIException && error.compare(EX.API_IMAGE_GENERATION_TIMEOUT);
    if (!terminalLogged && !isTimeout) {
      logGenerationEvent({
        event: "failed",
        request_id: requestId,
        model: _model,
        model_req_key: modelReqKeyForLog,
        history_id: historyId,
        elapsed_ms: Date.now() - startedAt,
        upstream_status: lastStatus,
        fail_code: lastFailCode,
        credits_before: creditsBeforeForLog,
        error: error.message,
      });
    }
    throw error;
  }
}

/**
 * 带自动降级重试的图像生成（后台完成 + 指纹去重 + 结果缓存的入口）。
 *
 * 为什么这样包一层：应用型客户端（例如 Cherry Studio）超时后不会再调
 * 恢复查询接口，所以超时处理必须放在反代内部——提交后轮询在后台独立跑，
 * 不随本次 HTTP 连接断开而停止；结果按请求指纹缓存；客户端超时后重试
 * 同一请求时，命中缓存或加入等待中的同一个任务，不再新建任务、不重复扣积分。
 *
 * 流程：
 * 1. 先解析模型（未知模型直接报 -2000，不建任务、不扣积分）。
 * 2. 按请求参数 + 账号标识算指纹，查后台任务表：
 *    - 命中缓存 → 直接返回已完成的结果；
 *    - 进行中 → 加入等待同一个任务；
 *    - 上一个任务后台超时且 historyId 还在 → 对同一上游任务重新挂接轮询；
 *    - 全新 → 提交新任务（后台跑到 BACKGROUND_TIMEOUT_MS）。
 * 3. 本次 HTTP 只等 POLL_TIMEOUT_MS：等到了就返回结果；等不到就返回 -2011，
 *    任务仍在后台跑，客户端重试同一请求即可拿到结果。
 * 4. 积分不足时沿用旧行为：自动降分辨率重试。
 */
export async function generateImagesWithRetry(
  _model: string,
  prompt: string,
  options: {
    ratio?: string;
    resolution?: string;
    sampleStrength?: number;
    negativePrompt?: string;
    filePath?: string;
    filePaths?: string[];
    n?: number;
  },
  refreshToken: string
): Promise<string[]> {
  const retryRequestId = util.uuid();
  const retryStartedAt = Date.now();
  let modelConfig;
  try {
    modelConfig = await resolveImageModelConfig(_model, refreshToken);
  } catch (error) {
    // 模型名本身非法（例如客户端下拉里的 Aurora/Surge）：在进生成流程前就
    // 报错，这里补一条结构化失败日志，否则这次调用在日志里完全没有痕迹
    logGenerationEvent({
      event: "failed",
      request_id: retryRequestId,
      model: _model,
      elapsed_ms: Date.now() - retryStartedAt,
      error: error.message,
    });
    throw error;
  }
  const resolutionLevels = getImageResolutionFallbacks(
    _model,
    options.resolution,
    modelConfig
  );

  // 指纹：归一化后的请求参数 + 账号标识。
  // seed 不参与指纹：seed 由服务端在提交时随机生成，第一次提交的 seed 决定
  // 结果；重试命中同一指纹即复用第一次的结果，这正是去重的目的。
  // 参考图按输入字符串哈希（base64 即内容哈希；本地路径/URL 按字符串哈希）。
  const referenceInputs = [
    ...new Set(
      [options.filePath, ...(options.filePaths || [])].filter(
        (value): value is string => typeof value === "string" && value.trim().length > 0
      )
    ),
  ];
  const fingerprint = computeImageFingerprint({
    model: _model,
    prompt,
    negativePrompt: options.negativePrompt ?? "",
    ratio: options.ratio ?? "1:1",
    resolution: options.resolution ?? "2k",
    n: options.n ?? 1,
    sampleStrength: options.sampleStrength ?? 0.5,
    referenceHashes: referenceInputs.map(hashReferenceInput),
    accountHash: hashAccountToken(refreshToken),
  });

  // 后台任务的执行体：沿用原有的分辨率降级重试链，但轮询跑到后台上限，
  // 与本次 HTTP 等待解耦；所有错误都转成 outcome，由任务管理器收尾。
  const runChain = async (job: GenerationJob): Promise<JobOutcome> => {
    let currentResIndex = 0;
    while (currentResIndex < resolutionLevels.length) {
      try {
        const currentOptions = {
          ...options,
          resolution: resolutionLevels[currentResIndex],
        };
        logger.info(`尝试生成图像，分辨率: ${currentOptions.resolution}`);
        const urls = await generateImages(_model, prompt, currentOptions, refreshToken, {
          pollTimeoutMs: BACKGROUND_TIMEOUT_MS,
          onSubmitted: (info) => {
            job.setHistoryId(info.historyId);
            job.model = info.modelName;
            job.modelReqKey = info.modelReqKey;
            job.creditsBefore = info.creditsBefore;
          },
          onStatus: (status) => {
            job.lastStatus = status;
          },
        });
        return {
          status: "succeeded",
          urls,
          historyId: job.historyId,
          model: job.model,
          modelReqKey: job.modelReqKey,
          creditsBefore: job.creditsBefore,
          elapsedMs: Date.now() - job.startedAt,
        };
      } catch (error) {
        // 后台轮询跑满上限：不抛给调用方，转成 background_timeout outcome；
        // 任务管理器会记 background_timeout 事件，historyId 保留供重挂接。
        const isTimeout =
          error instanceof APIException &&
          error.compare(EX.API_IMAGE_GENERATION_TIMEOUT);
        if (isTimeout) {
          return {
            status: "background_timeout",
            historyId: job.historyId,
            model: job.model,
            modelReqKey: job.modelReqKey,
            creditsBefore: job.creditsBefore,
            creditsAfter: await fetchCreditsSafe(refreshToken),
            elapsedMs: Date.now() - job.startedAt,
            errorMessage: error.message,
          };
        }
        // 检查是否为积分不足错误 (fail_code 2039/1006 或包含积分不足关键词)
        const isInsufficientCredits =
          error.code === EX.API_IMAGE_GENERATION_INSUFFICIENT_POINTS[0] ||
          (error.message &&
            (error.message.includes("积分不足") ||
              error.message.includes("2039") ||
              error.message.includes("1006")));

        if (isInsufficientCredits && currentResIndex < resolutionLevels.length - 1) {
          currentResIndex++;
          logger.warn(
            `积分不足，自动降级到 ${resolutionLevels[currentResIndex]} 分辨率重试...`
          );
          continue;
        }

        // 已是最低分辨率仍然积分不足
        if (isInsufficientCredits) {
          const insufficientError = new APIException(
            EX.API_IMAGE_GENERATION_INSUFFICIENT_POINTS,
            "积分不足，已自动降至最低画质仍然不足，请前往即梦官网 https://jimeng.jianying.com 充值积分"
          );
          return {
            status: "failed",
            error: insufficientError,
            errorMessage: insufficientError.message,
            historyId: job.historyId,
          };
        }

        // 其他错误直接转成失败 outcome
        return {
          status: "failed",
          error,
          errorMessage: error instanceof Error ? error.message : String(error),
          historyId: job.historyId,
        };
      }
    }
    return {
      status: "failed",
      errorMessage: "图像生成失败",
      historyId: job.historyId,
    };
  };

  // 超时后重挂接：同一指纹的上一个任务已在后台跑满上限，但 historyId 还在，
  // 不要重新提交（会新建任务、再次扣积分），改为对同一上游任务重新开始
  // 后台轮询；上游若已完成，这次就能直接拿到图。
  const existingJob = imageJobManager.peek(fingerprint);
  let starter: (job: GenerationJob) => Promise<JobOutcome> = runChain;
  if (existingJob?.status === "background_timeout" && existingJob.historyId) {
    const historyId = existingJob.historyId;
    const reattachModelReqKey = existingJob.modelReqKey;
    starter = async (job) => {
      job.setHistoryId(historyId);
      job.model = existingJob.model;
      job.modelReqKey = reattachModelReqKey;
      job.creditsBefore = existingJob.creditsBefore;
      const poll = await pollImageHistoryUntil(
        historyId,
        refreshToken,
        {
          requestId: retryRequestId,
          modelName: _model,
          modelReqKey: reattachModelReqKey || "",
          creditsBefore: existingJob.creditsBefore ?? null,
          startedAt: job.startedAt,
        },
        {
          deadlineMs: BACKGROUND_TIMEOUT_MS,
          onStatus: (status) => {
            job.lastStatus = status;
          },
        }
      );
      if (poll.outcome === "unseen") {
        return { status: "failed", errorMessage: "记录不存在", historyId };
      }
      if (poll.outcome === "timeout") {
        return {
          status: "background_timeout",
          historyId,
          model: job.model,
          modelReqKey: job.modelReqKey,
          creditsBefore: job.creditsBefore,
          creditsAfter: await fetchCreditsSafe(refreshToken),
          elapsedMs: Date.now() - job.startedAt,
          errorMessage: "background poll timeout",
        };
      }
      if (poll.status === 30) {
        if (poll.failCode === "2038") {
          const filteredError = new APIException(EX.API_CONTENT_FILTERED);
          return {
            status: "failed",
            error: filteredError,
            errorMessage: filteredError.message,
            historyId,
          };
        }
        return {
          status: "failed",
          errorMessage: `upstream fail_code=${poll.failCode}`,
          historyId,
        };
      }
      const urls = extractImageUrls(poll.itemList, options.n ?? 1);
      const creditsAfter = await fetchCreditsSafe(refreshToken);
      logGenerationEvent({
        event: "success",
        request_id: retryRequestId,
        model: _model,
        model_req_key: reattachModelReqKey,
        history_id: historyId,
        elapsed_ms: Date.now() - job.startedAt,
        upstream_status: poll.status,
        credits_before: existingJob.creditsBefore ?? null,
        credits_after: creditsAfter,
        result_count: urls.filter(Boolean).length,
      });
      return {
        status: "succeeded",
        urls,
        historyId,
        model: job.model,
        modelReqKey: job.modelReqKey,
        creditsBefore: job.creditsBefore,
        creditsAfter,
        elapsedMs: Date.now() - job.startedAt,
      };
    };
  }

  const started = imageJobManager.getOrStart(fingerprint, starter, {
    requestId: retryRequestId,
    model: _model,
  });
  // cache_hit / dedup_join / background_busy 事件由任务管理器经 onEvent
  // 统一记进结构化日志（见文件顶部接线），这里不再重复记。
  if (started.rejected === "busy") {
    throw new APIException(
      EX.API_IMAGE_GENERATION_BUSY,
      "后台生成任务已满，请稍后重试"
    );
  }
  const job = started.job!;
  if (started.hit === "cache") {
    // 命中缓存：直接返回已完成的结果，未提交新任务、未扣积分
    return job.outcome!.urls!;
  }
  if (started.hit === "reattach") {
    logger.info(
      `🔁 [去重] 指纹 ${fingerprint.slice(0, 12)}… 上一个后台任务已超时，重新挂接上游任务 ${job.historyId} 继续等（不重新提交、不重复扣积分）`
    );
  }

  // 本次 HTTP 只等 POLL_TIMEOUT_MS；等不到就返回 -2011，任务仍在后台跑。
  const { timedOut, outcome } = await imageJobManager.waitFor(job, POLL_TIMEOUT_MS);
  if (!timedOut && outcome) {
    if (outcome.status === "succeeded") return outcome.urls!;
    if (outcome.status === "failed") {
      throw (
        outcome.error ??
        new APIException(EX.API_IMAGE_GENERATION_FAILED, outcome.errorMessage || "图像生成失败")
      );
    }
    // 后台跑满上限仍无结果（等待者恰好等到了这一刻）
    throw buildTimeoutError({
      requestId: retryRequestId,
      modelName: _model,
      modelReqKey: job.modelReqKey,
      historyId: outcome.historyId ?? job.historyId,
      elapsedMs: Date.now() - retryStartedAt,
      upstreamStatus: job.lastStatus ?? null,
      creditsBefore: job.creditsBefore ?? null,
      creditsAfter: outcome.creditsAfter ?? null,
    });
  }

  // 本次等待上限到了：记一条 timeout 事件，返回 -2011；任务继续在后台跑，
  // 客户端重试同一请求时会命中缓存或加入等待。
  const creditsAfter = await fetchCreditsSafe(refreshToken);
  logGenerationEvent({
    event: "timeout",
    request_id: retryRequestId,
    model: _model,
    model_req_key: job.modelReqKey,
    history_id: job.historyId,
    elapsed_ms: Date.now() - retryStartedAt,
    upstream_status: job.lastStatus ?? null,
    credits_before: job.creditsBefore ?? null,
    credits_after: creditsAfter,
    error: "client wait timeout",
  });
  throw buildTimeoutError({
    requestId: retryRequestId,
    modelName: _model,
    modelReqKey: job.modelReqKey,
    historyId: job.historyId,
    elapsedMs: Date.now() - retryStartedAt,
    upstreamStatus: job.lastStatus ?? null,
    creditsBefore: job.creditsBefore ?? null,
    creditsAfter,
  });
}

export default {
  generateImages,
  generateImagesWithRetry,
};
