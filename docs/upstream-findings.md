# 免密免费网关逆向核实记录

> 结论均来自 2026-09-24 本机对 `opencode.ai` 的**直接请求实测**，不是读代码得出的推测。
> 复现脚本：`scripts/probe-*.mjs`（本仓库外）、`scripts/host-selftest.mjs`。
> 被分析的上游项目：`decolua/9router`（克隆于 `../9router`，版本 0.5.86）。

## 1. 网关是可以免密直连的

9router 把这条车道叫 `opencode`（`category: "free"`、`noAuth: true`）。凭据不是"没有"，而是一个**硬编码的公共池令牌**：

```
Authorization: Bearer public
```

这是逆向里最关键的一条事实：不存在任何注册、OAuth、机器码或 token 交换环节。`open-sse/executors/opencode.js:476` 逐字写死了它。

## 2. 光有凭据不够，必须凑齐客户端指纹

`open-sse/executors/opencode.js:462-486` 与 `open-sse/utils/opencodeFingerprint.js` 说明上游按"是否像真的桌面客户端"放行。实测确认的四件套请求头：

| 头 | 值 | 缺失后果 |
| --- | --- | --- |
| `User-Agent` | 含 `opencode/<版本>`，且版本 ≥ 1.17 | 被判定为非客户端 |
| `x-opencode-client` | `desktop` | — |
| `x-opencode-session` | `ses_` + 12 hex + 14 base62 | — |
| `x-opencode-request` | `msg_` + 同结构 | — |
| `x-opencode-project` | `global` | — |

以及**工具声明层面的指纹**：请求的 `tools` 必须包含小写的 `bash` / `glob` / `grep` / `read` 四件套，否则 `403 FreeTierError`。9router 的做法是缺哪个补哪个（补进去的是"当前不可用、禁止调用"的诱饵声明），并把调用方同名的大小写变体归一而不是重复声明。

> 对本插件的意外利好：dsh 官方工具名恰好就是 `bash` / `glob` / `grep` / `read`
> （`packages/shell/tool-bash/src/index.ts:396` 等）。所以在 dsh 里这四件套通常是**真实工具**，
> 不是诱饵，模型调用它们能真正落到执行。

## 3. 配额按 session 记账

`opencode.js:116-121` 的注释是作者踩过的坑，实测成立：**每次请求新铸 session 会迅速打爆免费额度**，表现为 429 `FreeUsageLimitError` 且 `Retry-After` 递增。正确做法是一个会话复用一条规范的 session id。

本插件用 `sha256(harness sessionId)` 派生，使同一段对话跨重启稳定映射到同一条上游 session。

## 4. 一条车道，三种线协议

| 模型族 | 路径 | 协议 |
| --- | --- | --- |
| 多数免费模型 | `/zen/v1/chat/completions` | OpenAI Chat Completions |
| `muse-spark*` | `/zen/v1/responses` | OpenAI Responses |
| `union-alpha` | `/zen/v1/messages` | Anthropic Messages |

Responses 车道有额外约束（`opencode.js:340-371`）：必须 `store:false`、必须丢弃上一轮的 `reasoning` 条目（公共池轮换账号，`encrypted_content` 换账号解不开会 400）。

## 5. 地区限制是真实存在的，而且只在请求时才暴露

`GET /zen/v1/models` 会列出全部 id，**不区分你的出口能否使用**。可用性唯一的信号是请求被拒：

```
403 {"type":"error","error":{"type":"RegionError","message":"This model is not available in your country."}}
```

本机（中国大陆出口）实测：`muse-spark-1.3-contributor-free` 与 `muse-spark-1.2-contributor-free` 全部 403 RegionError。

这直接决定了架构：**必须主动探测，并把结果当作分组依据**，而不是把能力写死在清单里。

## 6. `reasoning_effort` 在这条车道上被完全忽略

这是推翻"照抄上游参数"方案的实测结论。同一 prompt、每档 3 次采样：

| 写法 | space-bunny 推理 tokens | ling 推理 tokens |
| --- | --- | --- |
| 不设（baseline） | 209 / 317 / 337 | 1948 / 576 / 2815 |
| `reasoning_effort: minimal` | 82 / 39 / 39 | 2437 / 2362 / 1482 |
| `reasoning_effort: low` | 38 / 37 / 101 | 702 / 300 / 1550 |
| `reasoning_effort: xhigh` | 130 / 154 / 255 | 941 / 1398 / 1245 |

组内方差大于组间差异，`low` 时常比 `xhigh` 想得还多。其余方言（`thinking.budget_tokens`、`enable_thinking`、`thinking_budget`）同样无效，且**有时直接把上游打成 503**。

唯一真实生效的旋钮是 `max_tokens`：

```
baseline            reasoning ≈ 397
max_tokens = 64     reasoning ≈ 63
```

**所以：如果本插件把上游的 `reasoning_effort` 原样透传，用户在 dsh 里看到的"思考强度"就是一个空壳按钮。** 这也是 `src/effort.js` 选择"档位 → 硬性 token 预算"的原因，以及验收时必须实测单调性的原因。

## 7. 实测免费模型矩阵（本机出口，2026-09-24）

| 模型 | 结果 | 备注 |
| --- | --- | --- |
| `mimo-v2.6-flash-free` | ✅ | 接受图片输入；思考不可关闭 |
| `mimo-v2.5-free` | ✅ | 接受图片输入 |
| `space-bunny-free` | ✅ | 接受图片输入。**9router 仓库里还没有这个模型** |
| `ling-3.0-flash-fin-free` | ✅ | 拒绝图片输入（404 no endpoints） |
| `nemotron-3-ultra-free` | ✅ | 慢，23s 起 |
| `nemotron-3.5-lightning-free` | ✅ | 极慢，单次 178s |
| `muse-spark-1.3-contributor-free` | 🔒 RegionError | 需切换出口 |
| `muse-spark-1.2-contributor-free` | 🔒 RegionError | 需切换出口 |
| `deepseek-v4-flash-free` | ❌ 400 Model is unavailable | 上游池已不路由 |
| `union-alpha` | ❌ 401 ModelError | 该 id 已不被支持 |
| `jev-1.13-free` | ❌ 500 | 属 `/systemone` 车道，不是 chat |

`space-bunny-free` 的存在是"清单必须跟上游动态走"的实证依据；`deepseek-v4-flash-free` 与 `union-alpha` 的失效则是"不能把能力写死"的实证依据。

## 8. 为什么没有照抄 9router 作为运行时

9router 的 `open-sse` 是一个面向 **100+ 提供方、8 种模态、双向协议互转** 的 Next.js 网关引擎，还要带 SQLite、SAML、MITM、Monaco 面板。本插件真正需要的只是：

- 一条 base URL
- 五个请求头
- 一次 `sha256` 派生 session
- 四件套工具指纹
- 三种线协议之一的 SSE 解析

把它作为 sidecar 跑起来，代价是让用户多装一个 Node 服务 + 一个 20k 行依赖树，收益只有重复实现。因此选择**只移植 opencode 免费车道的线协议细节**（约 300 行），把 9router 降级为"能力表的上游数据源"：运行时抓它的 `providers/capabilities.js` 与 `providers/registry/opencode.js` 做能力叠加，抓不到就退回本地内置表。

## 9. dsh 侧决定了架构的三条事实

1. **模型选择器严格按 provider 路由分组**，`ModelProviderGroup` 里没有任何 group/tag/badge 字段
   （`packages/api/session-controller/src/catalog.ts:16-67`）。所以"our free model tag"唯一的实现方式
   是**注册自己的路由**，分组标题就是 `LlmProviderInfo.name`。地区受限模型能被单独分组，
   靠的是给同一个 adapter 注册第二条路由；空分组会被客户端丢弃，因此 VPN 生效时那一组自动消失。
2. **Effort 菜单是数据驱动的，没有内置白名单**（`packages/client/ui-model-selection/src/client/ModelSelect.tsx:94-112`）。
   只要 `resolveModel` 返回 `reasoning.efforts`，选择器就会出现，选中值会经
   `resolveCallConfig` 校验后进入 `GenerateOptions.reasoningEffort`。但 `efforts: []` 会让整组消失。
3. **`ctx.webServer.register()` 允许插件往应用自身的 HTTP 服务上挂命名路由**，
   且已安装插件代码在进程内、工作区沙箱之外执行（`packages/boot/plugin-manager/README.md:31`），
   所以设置页可以同源 `fetch('/api/our-free-model/…')`，转发端口也可以自己 `node:http` 监听。
   实测本机 `@dsh-external/dsh-webui` 正是这么做的（`lib/appearance.js:82`）。

## 10. 跨内核版本必须避开的坑

- **本机 DSHEAC AIO 6.9.3 跑的是 dsh 0.1.5-rc.2**，源码仓库是 0.1.7-rc.1。
  0.1.5 有 `ctx.settings.register(ns, schema)`，**0.1.7 的 `SettingsForms` 已经没有 `register`**。
  因此本插件不用任何 settings seam API，改为自己管 JSON 文件 + 自己的 HTTP 路由，两套内核行为一致。
- `registerAdapter` **不做 `instanceof LlmAdapter` 校验**（`packages/llm/llm/src/index.ts:427-448`
  只调用方法并检查 `providerInfo().id/name`），所以插件可以结构性地实现适配器而完全不 import
  `@deepseek-ai/dsh-llm`，从而不把包依赖钉在某个内核版本上。`attributionHeaders()` 只在运行期
  惰性 import，取不到时退回字面量——归因头本身仍然一定发出。
- **`providerRetryPolicy()` 的返回值被两套内核原样存下来用，不走 `resolveRetryPolicy`**
  （0.1.7 `packages/llm/llm/src/index.ts:440-441`；0.1.5-rc.2 `dsh-llm/lib/index.js:1814`）。
  退避计算 `localDelay` 读的是**顶层**的 `initialDelayMs/maxDelayMs/jitterRatio`
  （`packages/llm/llm-retry/src/index.ts:59-63`）。按 schema 把这三项嵌在 `backoff:{}` 里，
  它们会读到 `undefined`，`undefined * 2**n = NaN`，`delayMs` 成 NaN，而
  `session.append('llm/retry', …)` 对非有限数直接抛
  `carries non-JSON-serializable data`（`packages/core/session/src/index.ts:732`），整轮对话报废。
  **必须返回已经解析好的扁平对象。** 0.1.7 上看不出来，只因为那边从没真的触发过重试。
- **一次被打断的工具调用会永久毒化该会话**。工具没跑成 / 用户中止 / 内核崩溃都会留下
  `assistant.tool_calls` 没有对应结果的记录，而免费车道对它的回答是
  `400 [invalid_request_error] invalid request`——此后该会话里每一次请求都失败。
  上游实测见 `scripts/probes/dangling-tool-call.mjs`（配对成功、悬空被拒）。
  本插件在 `src/messages.js` 的 `repairToolPairing()` 里丢掉未应答的调用与无主的应答，
  三种线协议共用这一处修复。
