import { createHash } from "node:crypto";

/**
 * 生图后台任务管理：后台完成 + 指纹去重 + 结果缓存。
 *
 * 为什么需要它（上一轮机制的问题）：
 * 上一轮超时后返回 -2011 错误带 history_record_id，并提供恢复查询接口，
 * 指望调用方超时后自己再来查。但应用型客户端（例如 Cherry Studio）超时后
 * 根本不会再调恢复接口，所以那套机制对它们没用。本模块把超时处理收进反代
 * 内部：提交后轮询在后台独立进行，不随客户端 HTTP 连接断开而停止；结果按
 * 请求指纹缓存；客户端超时后点“重试”发来相同请求时，命中缓存或加入等待中
 * 的同一个任务，不再新建任务、不再重复扣积分。
 *
 * 本模块是纯逻辑，不依赖应用的 logger / 数据库 / 上游客户端，便于独立测试。
 * 事件通过 onEvent 回调交出去，由调用方写进结构化 [GEN] 日志。
 */

// ---------------------------------------------------------------------------
// 指纹
// ---------------------------------------------------------------------------

export interface ImageFingerprintInput {
  /** 客户端请求的模型 ID（例如 jimeng-image-5.0-lite） */
  model: string;
  /** 提示词原文 */
  prompt: string;
  negativePrompt?: string;
  ratio?: string;
  resolution?: string;
  n?: number;
  sampleStrength?: number;
  /** 参考图输入的哈希（顺序与上传顺序一致；base64 即内容哈希，本地路径/URL 按字符串哈希） */
  referenceHashes?: string[];
  /** 账号标识：refreshToken 的 sha256 截断，绝不是 token 本身 */
  accountHash: string;
}

/** 对一段输入字符串算 sha256（参考图指纹用；base64 字符串即内容哈希）。 */
export function hashReferenceInput(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * 账号标识：对 refreshToken 做单向哈希后截断。不同账号一定不同指纹，
 * 同一账号同一请求一定相同指纹；哈希值无法还原出 token。
 */
export function hashAccountToken(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

/**
 * 请求指纹：模型 + 提示词 + 负提示词 + 比例 + 分辨率 + 张数 + 精细度 +
 * 参考图哈希 + 账号标识。
 *
 * seed 不参与指纹：seed 由服务端在提交时随机生成，第一次提交的 seed 决定
 * 结果；重试命中同一指纹即复用第一次的结果，这正是去重的目的。
 */
export function computeImageFingerprint(input: ImageFingerprintInput): string {
  const canonical = {
    model: input.model,
    prompt: input.prompt,
    negativePrompt: input.negativePrompt ?? "",
    ratio: input.ratio ?? "1:1",
    resolution: input.resolution ?? "2k",
    n: input.n ?? 1,
    sampleStrength: input.sampleStrength ?? 0.5,
    refs: input.referenceHashes ?? [],
    account: input.accountHash,
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

// ---------------------------------------------------------------------------
// 任务与结果
// ---------------------------------------------------------------------------

export type JobOutcomeStatus = "succeeded" | "failed" | "background_timeout";

export interface JobOutcome {
  status: JobOutcomeStatus;
  urls?: string[];
  /** 失败时抛出的原始错误（failed 时由调用方重新抛出，保持原有错误行为） */
  error?: unknown;
  errorMessage?: string;
  historyId?: string | null;
  model?: string;
  modelReqKey?: string;
  creditsBefore?: number | null;
  creditsAfter?: number | null;
  elapsedMs?: number;
}

export type JobStatus = "running" | "succeeded" | "failed" | "background_timeout";

export interface GenerationJob {
  fingerprint: string;
  status: JobStatus;
  historyId: string | null;
  model?: string;
  modelReqKey?: string;
  creditsBefore?: number | null;
  creditsAfter?: number | null;
  /** 轮询最后一次见到的上游状态码（供超时日志用；未知时为 null） */
  lastStatus?: number | null;
  /** 发起这个任务的客户端请求 ID（供后台完成类日志串联用） */
  requestId?: string;
  createdAt: number;
  startedAt: number;
  completedAt: number | null;
  lastAccessedAt: number;
  /** 有多少个等待者已经等到本次 HTTP 上限先走了（>0 说明结果是在后台完成的） */
  timedOutWaiters: number;
  outcome: JobOutcome | null;
  promise: Promise<JobOutcome>;
  /** starter 在上游提交成功后立即调用，让等待者能拿到 historyId */
  setHistoryId: (id: string) => void;
}

export type JobManagerEventType =
  | "cache_hit"
  | "dedup_join"
  | "background_complete"
  | "background_timeout"
  | "background_busy"
  | "cache_evict";

export interface JobManagerEvent {
  type: JobManagerEventType;
  fingerprint: string;
  requestId?: string;
  historyId?: string | null;
  model?: string;
  modelReqKey?: string;
  elapsedMs?: number;
  resultCount?: number;
  error?: string;
  /** 轮询最后一次见到的上游状态码（background_complete / background_timeout） */
  upstreamStatus?: number | null;
  creditsBefore?: number | null;
  creditsAfter?: number | null;
  /** cache_evict 的淘汰原因（例如 max_entries / ttl_expired） */
  reason?: string;
}

export interface GetOrStartResult {
  job: GenerationJob | null;
  /** new=新建任务 join=加入进行中的任务 cache=命中缓存 reattach=对旧任务重新挂接 */
  hit: "new" | "join" | "cache" | "reattach";
  /** 后台任务已满时为 'busy'，此时 job 为 null，调用方不得提交 */
  rejected?: "busy";
}

export interface JobManagerOptions {
  /** 完成结果的缓存有效期（毫秒），默认 1800000（30 分钟） */
  cacheTtlMs?: number;
  /** 完成结果最多保留条数（LRU 淘汰），默认 100 */
  maxCacheEntries?: number;
  /** 同时在跑的后台任务上限，默认 20 */
  maxBackgroundJobs?: number;
  /** 缓存清理间隔（毫秒），默认 60000；传 0 关闭定时清理 */
  sweepIntervalMs?: number;
  /** 时间来源（测试注入），默认 Date.now */
  now?: () => number;
  /** 事件回调（调用方接到后写结构化日志）；默认不做任何事 */
  onEvent?: (event: JobManagerEvent) => void;
}

function numEnv(name: string, def: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : def;
}

/** 从环境变量读后台任务配置（生产单例用；测试请直接传参构造）。
 * 注意：后台完成总上限 JIMENG_IMAGE_BACKGROUND_TIMEOUT_MS 不在这里读——
 * 它由调用方（images.ts 的 generateImages 轮询 deadline）强制执行，
 * 管理器只负责去重/缓存/等待，不再另设一个计时器，避免两处上限打架。 */
export function readJobManagerEnvConfig(): JobManagerOptions {
  return {
    cacheTtlMs: numEnv("JIMENG_RESULT_CACHE_TTL_MS", 1_800_000),
    maxCacheEntries: numEnv("JIMENG_RESULT_CACHE_MAX_ENTRIES", 100),
    maxBackgroundJobs: numEnv("JIMENG_IMAGE_MAX_BACKGROUND_JOBS", 20),
  };
}

export class GenerationJobManager {
  private readonly cacheTtlMs: number;
  private readonly maxCacheEntries: number;
  private readonly maxBackgroundJobs: number;
  private readonly now: () => number;
  onEvent: (event: JobManagerEvent) => void;

  private readonly jobs = new Map<string, GenerationJob>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: JobManagerOptions = {}) {
    this.cacheTtlMs = options.cacheTtlMs ?? 1_800_000;
    this.maxCacheEntries = options.maxCacheEntries ?? 100;
    this.maxBackgroundJobs = options.maxBackgroundJobs ?? 20;
    this.now = options.now ?? Date.now;
    this.onEvent = options.onEvent ?? (() => {});
    const sweepIntervalMs = options.sweepIntervalMs ?? 60_000;
    if (sweepIntervalMs > 0) {
      this.sweepTimer = setInterval(() => {
        try {
          this.prune();
        } catch {
          // 清理失败绝不能影响主流程
        }
      }, sweepIntervalMs);
      // 不阻止进程退出（测试里尤其重要）
      (this.sweepTimer as any)?.unref?.();
    }
  }

  /** 停止定时清理（测试结束或服务关闭时调用）。 */
  destroy(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  get size(): number {
    return this.jobs.size;
  }

  get runningCount(): number {
    let count = 0;
    for (const job of this.jobs.values()) {
      if (job.status === "running") count++;
    }
    return count;
  }

  /** 看一眼某个指纹的任务（不更新 LRU；返回前先清过期项）。 */
  peek(fingerprint: string): GenerationJob | undefined {
    this.prune();
    return this.jobs.get(fingerprint);
  }

  /**
   * 取任务或新建任务。
   *
   * - 已完成且在 TTL 内 → 命中缓存，starter 不会被调用。
   * - 进行中 → 加入等待，starter 不会被调用。
   * - 上一个任务后台超时（且 historyId 还在）→ 删掉旧记录，用调用方传入的
   *   starter 新建任务（调用方决定是重新提交还是对旧 historyId 重新挂接）。
   * - 后台任务已满 → { job: null, rejected: 'busy' }，调用方不得提交。
   */
  getOrStart(
    fingerprint: string,
    starter: (job: GenerationJob) => Promise<JobOutcome>,
    meta: { requestId?: string; model?: string } = {}
  ): GetOrStartResult {
    this.prune();
    const existing = this.jobs.get(fingerprint);
    if (existing) {
      if (existing.status === "running") {
        this.touch(existing);
        this.emit({
          type: "dedup_join",
          fingerprint,
          requestId: meta.requestId,
          historyId: existing.historyId,
          model: meta.model ?? existing.model,
          modelReqKey: existing.modelReqKey,
        });
        return { job: existing, hit: "join" };
      }
      if (existing.status === "succeeded") {
        this.touch(existing);
        this.emit({
          type: "cache_hit",
          fingerprint,
          requestId: meta.requestId,
          historyId: existing.historyId,
          model: meta.model ?? existing.model,
          modelReqKey: existing.modelReqKey,
          elapsedMs: existing.completedAt ? existing.completedAt - existing.startedAt : undefined,
          resultCount: existing.outcome?.urls?.filter(Boolean).length,
        });
        return { job: existing, hit: "cache" };
      }
      if (existing.status === "background_timeout") {
        // 旧任务已放弃，但 historyId 还在：调用方传入的 starter 决定是
        // 重新提交还是对旧 historyId 重新挂接。后台已满时先不要删旧记录，
        // 否则 historyId 丢了，之后重试只能重新提交（重复扣积分）。
        if (this.runningCount >= this.maxBackgroundJobs) {
          this.emit({
            type: "background_busy",
            fingerprint,
            requestId: meta.requestId,
            model: meta.model,
          });
          return { job: null, hit: "reattach", rejected: "busy" };
        }
        this.jobs.delete(fingerprint);
        const job = this.createJob(fingerprint, starter, meta);
        return { job, hit: "reattach" };
      }
      // failed 不应残留（完成时已删）；防御性删除后按新建走
      this.jobs.delete(fingerprint);
    }
    if (this.runningCount >= this.maxBackgroundJobs) {
      this.emit({
        type: "background_busy",
        fingerprint,
        requestId: meta.requestId,
        model: meta.model,
      });
      return { job: null, hit: "new", rejected: "busy" };
    }
    const job = this.createJob(fingerprint, starter, meta);
    return { job, hit: "new" };
  }

  /**
   * 等一个任务，带本次 HTTP 响应的等待上限。
   * 超时返回 { timedOut: true }，任务本身继续在后台跑；调用方应返回 -2011，
   * 客户端重试同一请求时会命中缓存或再次加入等待。
   */
  async waitFor(
    job: GenerationJob,
    timeoutMs: number
  ): Promise<{ timedOut: boolean; outcome: JobOutcome | null }> {
    this.touch(job);
    if (job.status !== "running") {
      return { timedOut: false, outcome: job.outcome };
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race([
        job.promise,
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), timeoutMs);
        }),
      ]);
      if (outcome === null) {
        job.timedOutWaiters++;
        return { timedOut: true, outcome: null };
      }
      return { timedOut: false, outcome };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** 清掉过期的完成/后台超时记录（进行中的任务永不清）。 */
  prune(): void {
    const now = this.now();
    for (const [fingerprint, job] of this.jobs) {
      if (
        job.status !== "running" &&
        job.completedAt !== null &&
        now - job.completedAt > this.cacheTtlMs
      ) {
        this.jobs.delete(fingerprint);
      }
    }
  }

  private touch(job: GenerationJob): void {
    job.lastAccessedAt = this.now();
    // Map 按插入顺序排 LRU：删掉重插即移到队尾
    this.jobs.delete(job.fingerprint);
    this.jobs.set(job.fingerprint, job);
  }

  private emit(event: JobManagerEvent): void {
    try {
      this.onEvent(event);
    } catch {
      // 事件回调失败绝不能影响主流程
    }
  }

  private createJob(
    fingerprint: string,
    starter: (job: GenerationJob) => Promise<JobOutcome>,
    meta: { requestId?: string; model?: string }
  ): GenerationJob {
    const now = this.now();
    const job: GenerationJob = {
      fingerprint,
      status: "running",
      historyId: null,
      model: meta.model,
      requestId: meta.requestId,
      createdAt: now,
      startedAt: now,
      completedAt: null,
      lastAccessedAt: now,
      timedOutWaiters: 0,
      outcome: null,
      promise: null as unknown as Promise<JobOutcome>,
      setHistoryId: (id: string) => {
        job.historyId = id;
      },
    };
    this.jobs.set(fingerprint, job);
    job.promise = (async (): Promise<JobOutcome> => {
      try {
        const outcome = await starter(job);
        return this.complete(job, outcome);
      } catch (error) {
        return this.complete(job, {
          status: "failed",
          error,
          errorMessage: error instanceof Error ? error.message : String(error),
          historyId: job.historyId,
        });
      }
    })();
    // starter 的错误都已转成 outcome；再挂一个空 catch 兜底，绝不允许
    // 未处理的 rejection 把进程拖垮。
    job.promise.catch(() => {});
    return job;
  }

  private complete(job: GenerationJob, outcome: JobOutcome): JobOutcome {
    job.status = outcome.status;
    job.completedAt = this.now();
    job.outcome = outcome;
    if (outcome.historyId) job.historyId = outcome.historyId;
    if (outcome.model) job.model = outcome.model;
    if (outcome.modelReqKey) job.modelReqKey = outcome.modelReqKey;
    if (outcome.creditsBefore != null) job.creditsBefore = outcome.creditsBefore;
    if (outcome.creditsAfter != null) job.creditsAfter = outcome.creditsAfter;
    job.lastAccessedAt = this.now();

    if (outcome.status === "failed") {
      // 失败不缓存：重试应重新提交（与旧行为一致）
      this.jobs.delete(job.fingerprint);
      return outcome;
    }
    if (outcome.status === "succeeded" && job.timedOutWaiters > 0) {
      // 有等待者已经先拿了 -2011 走掉，这个结果是在后台完成的：
      // 它们重试同一请求时会命中缓存。
      this.emit({
        type: "background_complete",
        fingerprint: job.fingerprint,
        requestId: job.requestId,
        historyId: job.historyId,
        model: job.model,
        modelReqKey: job.modelReqKey,
        elapsedMs: job.completedAt - job.startedAt,
        resultCount: outcome.urls?.filter(Boolean).length,
        upstreamStatus: job.lastStatus ?? null,
        creditsBefore: job.creditsBefore ?? null,
        creditsAfter: job.creditsAfter ?? null,
      });
    }
    if (outcome.status === "background_timeout") {
      this.emit({
        type: "background_timeout",
        fingerprint: job.fingerprint,
        requestId: job.requestId,
        historyId: job.historyId,
        model: job.model,
        modelReqKey: job.modelReqKey,
        elapsedMs: job.completedAt - job.startedAt,
        error: outcome.errorMessage,
        upstreamStatus: job.lastStatus ?? null,
        creditsBefore: job.creditsBefore ?? null,
        creditsAfter: job.creditsAfter ?? null,
      });
    }
    this.evictIfNeeded();
    return outcome;
  }

  /** 只淘汰已完成的缓存条目（进行中的任务永不淘汰），按 LRU 顺序。 */
  private evictIfNeeded(): void {
    const completed = [...this.jobs.values()].filter((job) => job.status === "succeeded");
    if (completed.length <= this.maxCacheEntries) return;
    completed.sort((a, b) => a.lastAccessedAt - b.lastAccessedAt);
    const excess = completed.length - this.maxCacheEntries;
    for (let i = 0; i < excess; i++) {
      const victim = completed[i];
      this.jobs.delete(victim.fingerprint);
      this.emit({
        type: "cache_evict",
        fingerprint: victim.fingerprint,
        historyId: victim.historyId,
        model: victim.model,
        reason: "max_entries",
      });
    }
  }
}

/** 生产单例（环境变量配置；images.ts 在模块加载时把 onEvent 接到结构化日志）。 */
export const imageJobManager = new GenerationJobManager(readJobManagerEnvConfig());
