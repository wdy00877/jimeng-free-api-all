# 即梦反代本地优化说明（基于上游 v1.2.8，未推送、未部署）

> 状态：2026-11-06 本地改完、`npm run build` 通过、18001 端口验证通过。
> Render 上跑的仍是上游公开仓库原版代码，**本地改动不会自动同步到 Render**。
> 要上线：fork 到自己的 GitHub 账号 → 把改动推到 fork → Render 改指 fork 仓库重新部署。
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
- **未验证**：完整轮询/超时/宽限/恢复全链路——这台 VM 的出口代理会拦截
  对 `jimeng.jianying.com` 的直连请求，所以本地无法走到真正的上游提交；
  超时逻辑只做了代码级验证，需在 Render（直连网络）部署后用真实账号跑一次
  慢任务验证（建议把 `JIMENG_IMAGE_POLL_TIMEOUT_MS` 临时调小再测）。

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
