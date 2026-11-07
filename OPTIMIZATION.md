# 即梦反代本地优化说明（基于上游 v1.2.8，未推送、未部署）

> 状态：2026-11-07 第二轮返工完成，本地改完、`npm run build` 通过、18001 端口桩上游验证通过。
> 第一轮（2026-11-06）见下文；第二轮见文末“五、第二轮超时返工”。
> Render 上跑的仍是 fork 代码（第一轮），**本地第二轮改动不会自动同步到 Render**。
> 要上线：把改动推到 fork → Render 重新部署。
> 注意：Render 上的 `JIMENG_ACCOUNT_POOL_KEY` 环境变量不要动（改了已保存账号无法解密）；
> 新版新增的环境变量（见下）如需生效，要在 Render 的 Environment 里同样加上。

## 一、改了什么

### 1. 模型：补了 Seedream 5.0 Flash，模型列表可配置
- 新增静态模型 `jimeng-image-5.0-flash`（Seedream 5.0 Flash），
  `model_req_key = high_aes_general_v50_flash`（2026-11-06 从即梦官网
  `jimeng.jianying.com` 公开应用代码核实：`is_new_model: true`，
  model_tip“轻量化版 Seedream 5.0 Pro，更快更便宜”），
  支持分辨率 2k / 1.5k，默认 2k，积分消耗官网未公开所以没写死。
- `configs/models.json`：自定义模型文件，不用改代码就能加模型。
  格式：`{"images": [{"id","name","modelReqKey","supportedResolutions","defaultResolution","description","enabled"}], "videos": [...]}`。
  `enabled: false` 或缺 `modelReqKey` 的条目会被跳过并记警告。
- `JIMENG_EXTRA_MODELS` 环境变量：同样结构的 JSON 字符串，同 id 时覆盖文件。
- `GET /v1/models` 会返回内置 + 自定义 +（带有效鉴权时）上游动态发现的模型。

### 2. 不再静默用错模型（重要）
- 旧版：客户端传一个不存在的模型名（例如 `jimeng-image-5.0-aurora`），
  `resolveModelConfig` 会悄悄回落到 5.0 Lite 出图、按 Lite 扣积分，用户完全察觉不到。
- 新版：未知模型直接返回 `-2000 不支持的模型: xxx，可用模型请查询 /v1/models（当前可用：…）`。

### 3. 超时机制（`src/api/controllers/images.ts`）
旧版问题：提交后轮询 `/mweb/v1/get_history_by_ids` 每秒 1 次、最多 120 次；
单次轮询请求抛错（网络抖动）会直接炸掉整个生成；120 次一到就抛“图像生成超时”，
`history_record_id` 直接丢弃——即梦已扣积分、任务可能随后完成，用户也永远拿不到图；
且超时后没有任何恢复手段。

新版：
- 轮询改为按总时长控制（默认 120 秒，与旧版等价），单次查询失败只记 `poll_error`
  日志并继续等，连续失败达到上限才放弃（见环境变量）。
- 主轮询超时后先做宽限查询（默认 6 次），任务可能刚好完成。
- 仍无结果才抛新错误码 `-2011 图像生成超时`，错误里带上 `history_record_id`、
  已等待时长、上游状态、提交前后积分；**超时后绝不重新提交**（重新提交会在上游
  新建任务、再次扣积分）。
- 恢复查询接口：`GET /v1/images/generations/query?history_id=<id>`（需带鉴权），
  返回 `{history_record_id, status, status_text, fail_code, image_urls}`，
  `status_text` 为 `processing` / `succeeded` / `failed` / `not_found`。
  超时后过一会儿调这个接口，就能取回上游随后完成的图。
- 上游单次请求超时可配：`JIMENG_REQUEST_TIMEOUT_MS`（默认 45000，`core.ts`）。

环境变量（默认值即旧版行为，改完需重启服务）：
| 变量 | 默认 | 说明 |
|---|---|---|
| `JIMENG_IMAGE_POLL_TIMEOUT_MS` | 120000 | 主轮询总时长上限（毫秒） |
| `JIMENG_IMAGE_POLL_INTERVAL_MS` | 1000 | 每次状态查询间隔（毫秒） |
| `JIMENG_IMAGE_POLL_GRACE_ATTEMPTS` | 6 | 超时后的宽限查询次数 |
| `JIMENG_IMAGE_POLL_MAX_CONSECUTIVE_ERRORS` | 5 | 连续查询失败多少次后放弃 |
| `JIMENG_REQUEST_TIMEOUT_MS` | 45000 | 上游单次请求超时（毫秒） |
| `JIMENG_EXTRA_MODELS` | — | 额外模型 JSON（见上） |

### 4. 日志（`src/lib/generation-log.ts`）
- 每次生图写结构化 `[GEN] {JSON}` 行到 `logs/<日期>.log`，字段：
  `ts / event / request_id / model / model_req_key / history_id / elapsed_ms /`
  `upstream_status / fail_code / credits_before / credits_after / result_count / error`。
  事件：`submit`（已提交）/ `poll_error`（单次查询失败）/ `success` / `failed` / `timeout` / `query`（恢复查询）。
  查超时：`grep '\[GEN\]' logs/2026-11-06.log | grep timeout`。
- 完整请求体原来在 info 级全量打印，现改为 debug 级且先脱敏；
  `sanitizeForLog()` 会把 `sessionid / cookie / authorization / api_key` 等键的值
  替换为 `[REDACTED]`。结构化日志本身只用白名单字段，绝不含密钥。
- 注意：原 `logger.error()` 写文件时不带换行，相邻日志行可能粘连，不影响 grep。

## 二、模型清单（2026-11-06 核实）

### 官网截图 1 里的模型为什么反代没有
截图 1（Doubao 2.1 Pro/Lite、GLM 5.3、GLM 5.3 Flash、Deepseek V4 Pro、Qwen 3.8 Max）
是即梦 Agent/聊天模式用的**大语言模型**，不是生图模型。这个反代只做即梦的
**生图（Seedream）和视频（Seedance）**，所以那些 LLM 不在列表里是正常的，
也不是反代缺了什么——要调它们得走豆包/各模型自己的 API。

### 即梦网页端实际有的生图模型（官网应用代码核实）
| 模型 | 反代 ID | model_req_key | 分辨率 | 备注 |
|---|---|---|---|---|
| Seedream 5.0 Pro | jimeng-image-5.0-pro | high_aes_general_v50p_large | 4k/2k/1.5k | 已有，2K 约 8 积分 |
| Seedream 5.0 Lite | jimeng-image-5.0-lite | high_aes_general_v50 | 4k/2k | 已有，2K 约 3 积分 |
| Seedream 5.0 Flash | jimeng-image-5.0-flash | high_aes_general_v50_flash | 2k/1.5k | **本次新增**，积分未知 |
| Seedream 4.7 | jimeng-image-4.7 | high_aes_general_v43 | 4k/2k | 已有，2K 约 4 积分 |
| Seedream 4.6 | jimeng-image-4.6 | high_aes_general_v42 | 4k/2k | 已有 |
| Seedream 4.5 | jimeng-image-4.5 | high_aes_general_v40l | 4k/2k | 已有 |
| Seedream 4.1 | jimeng-image-4.1 | high_aes_general_v41 | 4k/2k | 已有 |
| Seedream 4.0 | jimeng-image-4.0 | high_aes_general_v40 | 4k/2k | 已有 |
| Seedream 3.1 | jimeng-image-3.1 | high_aes_general_v30l_art_fangzhou:general_v3.0_18b | 1k | 已有 |
| Seedream 3.0 | jimeng-image-3.0 | high_aes_general_v30l:general_v3.0_18b | 1k | 已有 |
| Seedream 2.0 Pro | jimeng-image-2.0-pro | high_aes_general_v20_L:general_v2.0_L | 1k | 已有 |

### 截图 2 里的其它名字
- Flux Pro/Dev/Schnell、Qwen Image：不是即梦的模型，是第三方客户端
  （Cherry Studio）里其它渠道的模型，**无法通过即梦网页 session 反代**。
- Jimeng Image Imagemax 1.0、Jimeng Image V8.2：即梦网页端没有这两个模型，
  是客户端自己的叫法，无法反代。
- Seedream 5.0 Aurora / Surge：即梦官网网页端**不存在**（官网应用代码、
  官方 Seedream 文档、上游仓库 issue 里都没有），是第三方渠道的叫法，
  没有对应的 `model_req_key`，目前无法反代。`configs/models.json` 里留了
  两条 `enabled: false` 的占位，哪天拿到真实 `model_req_key`，填上并把
  `enabled` 改成 `true` 即可用，不用改代码。
- 另外反代本身还有动态发现：带有效鉴权调 `GET /v1/models?refresh=true` 时，
  会实时拉即梦网页端的 `/mweb/v1/get_common_config`，上游新上的模型会自动出现。

## 三、本地验证（2026-11-06，端口 18001，隔离目录 /tmp/jimeng-opt-test）
- `npm run build` 通过；`npx tsc --noEmit` 在 `src/` 下无报错
  （唯一报错是 `node_modules/koa-body` 自带的类型问题，改动前就存在，与本次无关）。
- `GET /v1/models?type=image` 返回 11 个生图模型，含新增的 5.0 Flash；
  `JIMENG_EXTRA_MODELS` 环境变量加的测试模型也能出现（source=custom）。
- `POST /v1/images/generations` 不带鉴权 → `-2000` 参数错误，不崩溃。
- 传不存在的模型（如 Aurora）→ `-2000 不支持的模型…（当前可用：…）`，
  且日志里有一条 `[GEN] failed` 事件。
- 传已知模型 + 无效 token → 结构化上游错误，不崩溃，且有 `[GEN] failed` 事件
  （含 request_id、模型、耗时、错误原因）。
- `GET /v1/images/generations/query` 缺参数 → `-2000`；带无效 token → 结构化错误，不崩溃。
- **未验证（第一轮时）**：完整轮询/超时/宽限/恢复全链路——这台 VM 的出口代理会拦截
  对 `jimeng.jianying.com` 的直连请求，所以本地无法走到真正的上游提交；
  超时逻辑只做了代码级验证，需在 Render（直连网络）部署后用真实账号跑一次
  慢任务验证（建议把 `JIMENG_IMAGE_POLL_TIMEOUT_MS` 临时调小再测）。
  → 第二轮已用桩上游把这条链路在本地走通，见“五、第二轮超时返工”；
  真实上游仍需 Render 实测。

## 四、改动文件清单
- 新增：`src/lib/generation-log.ts`（结构化日志 + 脱敏）
- 新增：`configs/models.json`（自定义模型配置，Aurora/Surge 占位）
- 新增：本文件 `OPTIMIZATION.md`
- 修改：`src/api/controllers/models.ts`（Flash 静态模型、自定义模型加载、严格模型解析）
- 修改：`src/api/controllers/images.ts`（超时/宽限/恢复查询/结构化日志/调试日志脱敏）
- 修改：`src/api/routes/images.ts`（新增 `GET /v1/images/generations/query`）
- 修改：`src/api/consts/exceptions.ts`（新增 `-2011` 超时错误码）
- 修改：`src/api/controllers/core.ts`（上游请求超时改为环境变量可配）
- 未动：`data/`、`render-pool-key.txt`、Render 配置、正在跑的 8001 服务。
  注意：本地 8001 服务在本次工作开始前就已停止（日志显示 2026-11-06 15:22:28
  收到 kill 信号退出），不是本次构建造成的，也没有重启它。

## 五、第二轮超时返工（2026-11-07）：后台完成 + 去重缓存 + 重试命中缓存

### 为什么改
第一轮的机制是：超时返回 `-2011`（带 `history_record_id`），调用方稍后自己调
恢复查询接口 `GET /v1/images/generations/query` 取回结果。但应用型客户端
（例如 Cherry Studio）超时后**根本不会再调恢复接口**，所以那套机制对它们没用。
第二轮把超时处理收进反代内部：客户端什么都不用改，超时后点“重试”发来相同请求，
反代直接返回已完成的结果，不再新建任务、不重复扣积分。
第一轮的东西全部保留作兜底：`-2011` 错误（带 `history_record_id`）和恢复查询接口
还在，供 API 用户手动恢复；“未知模型静默回落 Lite”的修复保持不动；结构化 `[GEN]`
日志保持不动，新机制加了事件（见下）。

### 设计：三层超时
| 层 | 环境变量 | 默认 | 说明 |
|---|---|---|---|
| 本次 HTTP 响应等待上限 | `JIMENG_IMAGE_POLL_TIMEOUT_MS` | 120000 | 这段时间内完成就直接在本次响应里返回图；等不到就返回 `-2011`，任务继续在后台跑 |
| 后台完成总上限 | `JIMENG_IMAGE_BACKGROUND_TIMEOUT_MS` | 600000 | 后台轮询跑到这个上限才放弃，记 `background_timeout`，`historyId` 保留供下次重试重新挂接 |
| 缓存有效期 | `JIMENG_RESULT_CACHE_TTL_MS` | 1800000（30 分钟） | 已完成结果在内存里保留多久；过期后相同请求重新提交 |

另有两个上限（防内存/任务堆积）：
| 变量 | 默认 | 说明 |
|---|---|---|
| `JIMENG_RESULT_CACHE_MAX_ENTRIES` | 100 | 已完成结果最多保留条数，超了按 LRU 淘汰（进行中的任务永不淘汰） |
| `JIMENG_IMAGE_MAX_BACKGROUND_JOBS` | 20 | 同时在跑的后台任务上限，满了返回新错误码 `-2012 后台生成任务已满，请稍后重试` |

超时分层的实现位置：后台上限由 `generateImages` 的轮询 deadline 强制执行
（`pollTimeoutMs: BACKGROUND_TIMEOUT_MS`），管理器本身不另设计时器，避免两处上限打架。
`JIMENG_IMAGE_POLL_INTERVAL_MS`（默认 1000）、`JIMENG_IMAGE_POLL_GRACE_ATTEMPTS`
（默认 6）、`JIMENG_IMAGE_POLL_MAX_CONSECUTIVE_ERRORS`（默认 5）、
`JIMENG_REQUEST_TIMEOUT_MS`（默认 45000）沿用第一轮。

### 指纹与缓存（`src/lib/generation-jobs.ts`，纯模块，只依赖 `node:crypto`）
- 指纹 = SHA-256（模型 + prompt + 负提示词 + ratio + resolution + n + 精细度 +
  参考图哈希 + **账号标识**）。账号标识是 Bearer token 的 SHA-256 截断 16 位，
  **指纹必须含账号标识，否则不同账号的结果会串掉**；日志里只出现指纹前 12 位，
  原始 token 永不进日志、不进文件。
- seed **不进指纹**：seed 由服务端在提交时随机生成，第一次提交的 seed 决定结果；
  重试命中同一指纹即复用第一次的结果，这正是去重的目的。
- 参考图按输入字符串哈希（base64 即内容哈希；本地路径/URL 按字符串哈希）。
- 命中规则：
  - 已完成且在 TTL 内 → 直接返回缓存结果，不提交、不扣积分（`cache_hit`）。
  - 进行中 → 新请求加入等待同一个任务，不重复提交（`dedup_join`）。
  - 上一个任务后台超时且 `historyId` 还在 → **不重新提交**，对同一上游任务重新挂接
    轮询（`reattach`）；上游若已完成，这次就能直接拿到图。
  - 失败不缓存：失败后重试重新提交（与旧行为一致）。
- 缓存放内存（`Map`，LRU + TTL 定时清理，`setInterval` 已 `unref` 不阻止进程退出）。
  没持久化到 sqlite：Render 免费实例磁盘不持久，重启/重部署后缓存本来就会丢，
  持久化收益有限；且结果 URL 本身只有 24 小时有效期，内存 30 分钟 TTL 已够用。
- 并发安全：同一指纹的并发请求在 `getOrStart` 里原子合并，starter 只执行一次；
  等待者用 `waitFor(job, POLL_TIMEOUT_MS)` 挂在同一个 promise 上。

### 关键流程（`src/api/controllers/images.ts`）
- `generateImagesWithRetry` 改为托管包装：先解析模型（未知模型直接 `-2000`，
  不建任务、不扣积分）→ 算指纹 → `imageJobManager.getOrStart`（命中缓存/加入等待/
  重挂接/新建）→ 本次 HTTP 只等 `POLL_TIMEOUT_MS`，等到了返回结果，等不到返回
  `-2011`（任务仍在后台跑，记一条 `timeout` 事件）。
- 后台执行体沿用原有的分辨率降级重试链（积分不足自动降分辨率），但轮询跑到后台上限；
  提交成功后立即通过 `onSubmitted` 把 `historyId` 交给任务，供等待者与重挂接用。
- `pollImageHistory`（抛错版）重构成 `pollImageHistoryUntil`（返回
  `{outcome: 'done'|'timeout'|'unseen', status, failCode, itemList, polls}`），
  接受 `deadlineMs` / `queryFn`（测试注入）/ `onStatus`；`-2011` 的构造抽成
  `buildTimeoutError`（文案已更新：告诉客户端直接重试同一请求即可，不要换参数重提）。
- `timeout` 事件只在“本次 HTTP 等待上限到”时记一次；`background_timeout` 由任务管理器
  在“后台跑满上限”时记；避免同一个 `-2011` 被记两次、语义混淆。
- 新增 `[GEN]` 事件：`cache_hit` / `dedup_join` / `background_complete` /
  `background_timeout` / `background_busy`（另有 `cache_evict` 只写普通日志）。
  全部事件由管理器经 `onEvent` 统一发，wrapper 不再重复记。
- `core.ts`：上游地址改为 `JIMENG_API_BASE_URL` 环境变量可覆盖（默认官方地址，
  **仅供本地桩验证用，生产不要设置**）。

### 改动文件清单（第二轮）
- 新增：`src/lib/generation-jobs.ts`（指纹、任务管理器、去重缓存、事件）
- 新增：`tests/generation-jobs.test.cjs`（管理器单元测试，40 项，见下）
- 新增：`tests/stub-upstream.cjs`（桩上游）、`tests/run-e2e.sh`（端到端场景脚本）
- 修改：`src/api/controllers/images.ts`（`pollImageHistoryUntil`、`buildTimeoutError`、
  `generateImages` 加 opts、`generateImagesWithRetry` 重写为托管包装、事件接线）
- 修改：`src/api/controllers/core.ts`（`JIMENG_API_BASE_URL` 覆盖）
- 修改：`src/api/consts/exceptions.ts`（新增 `-2012` 后台任务已满）
- 修改：`src/lib/generation-log.ts`（新事件类型 + `fingerprint` 字段）
- 未动：`data/`、正在跑的 8001 服务（本轮工作中途一次 `pkill` 曾误杀 8001，
  已立即用 `./start.sh` 重启并验证 200 / 23 个模型；另发现 `logs/service.pid`
  是旧的僵尸 PID，与本次无关）、Render、GitHub（**未 push**）。

### 本地验证（2026-11-07，端口 18001，隔离目录 /tmp/jimeng-e2e）
- `npm run build` 通过；`npx tsc --noEmit` 在 `src/` 下无报错
  （唯一报错仍是 `node_modules/koa-body` 自带的类型问题，改动前就存在）。
  构建工具 tsup 本身不做类型检查——本次曾靠 `tsc --noEmit` 抓到 7 处
  `JobManagerEvent` 缺字段的类型错误并已修复。
- 管理器单元测试 `tests/generation-jobs.test.cjs`：**40 通过，0 失败**，
  覆盖指纹（账号隔离/参数敏感/确定性）、并发去重（starter 只调一次）、
  缓存命中、客户端先走后重试命中缓存、TTL 过期、LRU 淘汰、上限拒绝、
  失败不缓存、后台超时保留 `historyId` 可重挂接、事件发出。
  运行：`npx tsc src/lib/generation-jobs.ts --module commonjs --target es2020 --outDir /tmp/jobs-test --skipLibCheck && node tests/generation-jobs.test.cjs`。
- 桩上游端到端 `tests/run-e2e.sh`：**28 通过，0 失败**（桩模拟上游的提交/查询/
  积分/模型回落；客户端 token 均为假值 `test-session-A/B`，未调真实接口）。
  场景：`/v1/models` 23 个模型；未知模型 `-2000`；无鉴权不崩溃；
  慢完成（3 秒 < 5 秒等待）本次直接返回图；重复请求 24 毫秒命中缓存且提交数不变；
  三并发同一请求只提交 1 次、都拿 `-2011`、后台完成后重试命中缓存且提交数不变；
  客户端 2 秒断开后后台继续、重试命中缓存；不同账号同一请求分别提交（指纹含账号）；
  恢复查询接口 `succeeded` / `not_found` 正常；`[GEN]` 日志里有 `cache_hit` /
  `dedup_join` / `background_complete` / `timeout` / `submit` / `success`。
- 后台超时重挂接（单独场景）：后台上限临时设 8 秒、桩 12 秒完成——首次 `-2011`、
  日志出现 `background_timeout`、重试后对同一 `historyId` 重新挂接并返回图，
  全程只提交 1 次。
- 最终 dist 冒烟：重建后 18001 实例一次慢完成 + 一次缓存命中，提交数 1。

### 仍需在 Render 上实测（本地无法验证的部分）
- 真实上游慢任务：把新版部署到 Render 后，用真实账号调一次本身要 60 秒以上的
  慢任务——客户端应在约 120 秒（`JIMENG_IMAGE_POLL_TIMEOUT_MS` 默认值）拿到 `-2011`，
  随后重试同一请求应直接拿到图（或仍在处理中则再拿 `-2011`，不重复扣积分）。
  验证时可在 Render 环境变量里临时把 `JIMENG_IMAGE_POLL_TIMEOUT_MS` 调小（如 15000）
  以便快速看到 `-2011` → 重试命中缓存的完整链路，测完改回。
- 真实积分消耗：确认重试命中缓存时确实不再扣积分（Render 控制台看积分变化，
  或查 `[GEN]` 日志里的 `credits_before` / `credits_after`）。
- 后台超时重挂接：把 `JIMENG_IMAGE_BACKGROUND_TIMEOUT_MS` 临时调小（如 30000）
  配一个更慢的任务，验证重试走重挂接而非重新提交。
- 注意：Render 免费实例 15 分钟无访问会休眠；实例休眠/重启后内存缓存丢失，
  重试会重新提交——这是内存缓存的固有局限，见上。
