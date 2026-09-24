<p align="center">
  <img src="icon.svg" alt="Our Free Model — DeepSeek Harness 免费模型插件" width="120">
</p>

<p align="center"><strong>简体中文</strong> | <a href="README_EN.md">English</a></p>

<p align="center">
  <img alt="许可证" src="https://img.shields.io/badge/license-MIT-263146?style=flat-square">
  <img alt="零依赖" src="https://img.shields.io/badge/dependencies-zero-4b6fff?style=flat-square">
  <img alt="无构建步骤" src="https://img.shields.io/badge/build%20step-none-7da1de?style=flat-square">
  <img alt="适配内核" src="https://img.shields.io/badge/dsh-0.1.5--0.1.7--rc.2-2f6f4f?style=flat-square">
  <img alt="状态" src="https://img.shields.io/badge/status-beta-f0a441?style=flat-square">
</p>

# dsh-our-free-model

> 你只需在 dsh 里装上这个插件，无需登录、注册、填 API Key 或任何其它操作，
> 就能用上包括 Muse Spark 1.3、MiMo V2.6 在内的前沿模型——完全免费，不限量。
>
> *All you do is install this plugin in dsh: no login, no sign-up, no API key, nothing
> else. The frontier models are just there — Muse Spark 1.3, MiMo V2.6 and the rest.
> Free, with no usage cap.*
>
> 模型清单跟随上游刷新，可用性由**你自己这台机器的网络出口**实测得出，
> 思考强度下发的是真实预算而不是提示词，另附一个 OpenAI 兼容的本地转发端口。
>
> 纯插件挂载：不改内核、无构建步骤、零依赖。

---

## 亮点

- **装完即用，没有配置环节**——不需要账号、不需要 Key、不需要去哪个后台开配额。
- **清单跟随上游**——模型集合、上下文长度与能力每次刷新重新拉取，不是写死在插件里的一份快照。
- **所有模型保持可达**——探测失败或暂时不可用的模型不再从选择器消失；只有地区门拦截的模型单独归到 `region-limited` 分组。
- **公告中心 + 实时推送**——仓库主人在仓库里编辑一份 JSON 并推送，所有安装最迟在一个轮询周期内收到；内容是白名单约束下的 HTML，支持图文排版；`urgent` 级别直接全屏弹窗；可选系统级通知。
- **应用内升级**——设置页一键升级：下载 → SHA-256 校验 → 备份 → 原子替换 → 校验回读 → 热重载，任一步失败自动回滚到上一个版本。
- **热重载**——升级与代码更新即时生效，不需要重启应用；也可在设置页手动触发，或开启文件监视自动重载。
- **思考强度真的生效**——`Light / Balanced / Deep` 对应输出 token 预算 2 048 / 8 192 / 模型上限，且逐次调用留痕。它不是把一个 effort 字符串丢给上游然后假装有用（原因见[为什么用预算而不是 reasoning_effort](#为什么用预算而不是-reasoning_effort)）。
- **用量看板，全部留在本机**——Token 热力图、总量曲线（可看总计或单个模型）、输出速度与首字延迟逐次采样。不上传任何东西。
- **OpenAI 兼容转发端口**——本机其它工具用一个 base URL + Key 就能调用这些模型。
- **接口有鉴权围栏**——插件的 HTTP 路由优先级高于内核 `/api`，因此自带与内核一致的信任检查（优先复用 composition 的 connection 服务，缺失时退回结构化围栏）。

## 你会看到什么

**输入框的模型选择器**

| 分组 | 内容 |
| --- | --- |
| `Our Free Model` | 当前网络出口可直接使用的模型 |
| `Our Free Model · region-limited` | 上游对该地区不放行的模型，保留可见但单独隔离 |

**设置页 `设置 → Our Free Model`**，六个分区：

1. **模型清单**——每个模型的可用性、视觉还是纯文本、上下文窗口、最长输出、实测首字延迟，以及一次单调用基准测试按钮。
2. **公告中心**——仓库主人推送的公告流：未读计数、紧急徽章、单条/全部已读、检查新公告按钮、系统通知开关。公告正文按白名单渲染 HTML。
3. **用量看板**——总览计数、17 周 Token 热力图、总量曲线（Token / 请求数切换，总计与单模型切换）、速度迷你图、按模型汇总表。
4. **本地转发**——开关、监听地址与端口、复制 base URL、显示 / 复制 / 轮换 API Key，并给出一条可直接跑的 `curl` 示例。
5. **插件设置**——总开关、是否展示地区受限模型、探测间隔、默认输出上限，以及当前探测到的出口 IP 与国家。
6. **插件升级**——当前/最新版本、检查更新、一键升级（含进度与失败原因）、最近一次升级历史、热重载按钮与文件监视开关。

**首次启动公告**——分 5 页（前言 / 模型清单 / 使用步骤 / 功能介绍 / 公告与升级），确认一次后不再弹，除非文案版本号被提升。

## 安装

### 命令行（纯 `dsh web`）

```bash
dsh plugin --profile web add /绝对路径/dsh-our-free-model
```

装完重启一次应用。`--profile` 填你实际使用的那个。

### DSHEAC AIO / 桌面端：先看这段

桌面端在拉起 web 服务之前会跑一道 profile 闸门。它的扫描器**只**放行 dsh 自己在
`.dsh-module-fallback` 下生成的链接；profile 目录树里出现**任何其它符号链接或目录
junction，应用会直接拒绝启动**，报：

```text
PROFILE_UPGRADE_REQUIRED: offline dependency migration is not yet available
```

所以桌面端**不要用 `link:` 依赖安装，也不要建 junction**。请用应用内的插件管理器，
或者放一个真实目录。

手工以真实目录安装，在 `<DSH_HOME>/profiles/<profile>/` 下做三件事：

1. 把发布文件**复制**进 `node_modules/dsh-our-free-model/`
   （`index.js`、`client.js`、`src/`、`locale/`、`icon.svg`、`cordis.patch.yml`、`package.json`）
2. `dependencies` 里加 `"dsh-our-free-model": "1.1.2"`——写版本号，**不要写 `link:`**
3. `dsh.profile.bundles` 末尾追加 `"dsh-our-free-model"`

> **不要**再往 `cordis.patch.yml` 里加条目。被 `dsh.profile.bundles` 引用的包，它自带的
> patch 层会自动生效；两处都注册会报 `duplicate loader entry id: our-free-model`。

### 启动桌面端前先自检

不要盲试，直接调用桌面端自己的闸门代码：

```bash
node -e "
const g = require('<APP_ROOT>/sidecar/dist/lib/profile-upgrade.js');
const app = '<APP_ROOT>', profile = '<DSH_HOME>/profiles/<profile>';
console.log(g.planProfileUpgrade(app, profile));
g.assertProfileStartup(app, profile);
console.log('startup gate: PASS');
"
```

期望看到 `status: 'compatible'`、`mismatches` 为空数组，然后 `PASS`。
只想确认 bundle 组合是否正确、不启动界面：

```bash
DSH_HOME=<DSH_HOME> dsh --profile <profile> --dump-config | grep our-free-model
```

应当只出现**一个** `id: our-free-model`。

## 使用说明

**选模型**：打开输入框的模型选择器，选 `Our Free Model` 分组下的任意模型。选择按会话持久。

**调思考强度**：同一菜单里的 `Effort`，三档 `Light / Balanced / Deep`。档位越高，思考占用的
输出预算越多；上限是**强制下发**的，所以差异可测量，不是装饰。

**给其它本地工具用**：`设置 → Our Free Model → 本地转发`，启用后复制 base URL 并生成 Key。支持：

```text
GET  /v1/models
POST /v1/chat/completions     流式与非流式
POST /v1/responses
```

**重新核对地区**：点"重新探测可用性"，会按当前出口重跑探测。开/关 VPN 后再点一次，
地区受限模型会在两个分组之间自动迁移。

**接收公告**：一切自动。仓库主人推送新公告后，运行中的插件在一个轮询周期内（默认
30 分钟，也可在公告中心点"检查新公告"立即拉取）收到通知：普通公告弹 toast，
`urgent` 级别直接全屏弹窗，两者都会出现在公告中心并保留未读标记。想同时收到
系统级通知，在公告中心点"开启系统通知"。

**升级插件**：`设置 → Our Free Model → 插件升级` → 检查更新 → 立即升级。全过程
在应用内完成（下载 → 校验 → 备份 → 替换 → 热重载），不需要重新安装，也不需要
重启应用。升级失败会自动恢复上一个版本并给出原因。

## 给仓库主人：如何推送公告与发布更新

一切通过插件仓库根目录下的 `feed/` 目录完成，推送即发布：

**推送公告**：编辑 [`feed/announcements.json`](feed/announcements.json)，往
`announcements` 数组加一条：

```json
{
  "id": "2026-10-01-something",        // 全局唯一，出现过的 id 不会重复提醒
  "title": "一句话标题",
  "level": "info",                     // info | update | warn | urgent
  "pinned": false,                     // 可选，置顶
  "createdAt": "2026-10-01T00:00:00Z",
  "expiresAt": "2026-10-15T00:00:00Z", // 可选，过期自动消失
  "link": { "url": "https://…", "label": "查看详情" },  // 可选
  "html": "<p>正文，<strong>支持受限白名单的 HTML</strong></p>"
}
```

`urgent` 会触发全屏弹窗。正文 HTML 由客户端白名单渲染器解析——脚本、事件属性、
`javascript:` URL、iframe 等一律被丢弃（测试见 `scripts/sanitize-test.mjs`），
所以仓库被篡改也不会变成代码执行。

**发布新版本**：改完代码后——

```bash
# 1. 修改 package.json 的 version
# 2. 重新生成清单（把每个发布文件的字节数与 SHA-256 写进 feed/manifest.json）
node scripts/build-manifest.mjs
# 3. 提交并推送
```

已安装的插件会按 `updateCheckHours`（默认 6 小时）自动发现新版本并推送通知；
用户确认后下载、校验、备份、替换、热重载全部在应用内完成。清单会校验每个文件的
SHA-256，并在安装前重新拉取一次，避免用陈旧清单校验新文件。

**关于源顺序与网络现实**：插件按 `jsDelivr → raw.githubusercontent(main) → (master)`
的顺序拉取，全部失败时降级到上一次的缓存并如实标注错误。jsDelivr 优先是因为
raw.githubusercontent 在部分网络（实测本机 CN 出口 + Watt Toolkit 类加速工具）会被
本地反代劫持——git push 正常但 raw 对新文件返回假 404；jsDelivr 的边缘节点直连可达，
请求自动附带分钟级 cache-buster，不会被 CDN 长缓存拖住新鲜度。

两个发布者须知：
1. **jsDelivr 对新仓库的首次收录有延迟**（几分钟到数小时不等，创建 Release 会触发
   收录）；收录完成前，新推送的公告/更新会暂时拉取不到（客户端显示缓存并标注
   源不可达）。收录只发生一次，之后 `@main` 的更新经由 cache-buster 准实时可达。
2. 可用 `https://purge.jsdelivr.net/gh/<仓库>@main/<路径>` 手动刷新 jsDelivr 缓存。
   用 `feedUrl` 设置可把源指向任意 URL（含 `{repo}` 占位符），本地测试时指向一个
   静态文件服务器即可。

## 实现结构

```text
index.js        Host 半身：适配器注册、清单与可用性探测、设置/用量存储、
                webServer 路由、转发端口生命周期、公告/升级/热重载接线
src/adapter.js  结构性 LlmAdapter：providerInfo、listModels、resolveModel、
                prepareCall、stream、providerRetryPolicy
src/upstream.js 网关身份：凭据、session/request id 铸造、工具指纹、按线协议选端点
src/stream.js   三种线协议解码（chat / messages / responses）归一为 harness StreamChunk，
                并做不相交的 token 计数
src/messages.js harness 消息 -> 各线协议形态，外加工具调用配对修复
src/effort.js   思考档位 -> 输出预算
src/forward.js  独立的 OpenAI 兼容监听器
src/trust.js    插件路由的请求信任围栏（connection 服务桥 + 结构化围栏）
src/push.js     SSE 推送枢纽：公告到达、更新可用、升级完成
src/feed.js     远程公告 feed：多源拉取、校验、缓存、到达检测
src/updater.js  应用内升级：清单校验、SHA-256 分级校验、备份、原子替换、回滚
src/reload.js   自热重载：镜像内核 HMR 的缓存清除 + 重导入 + 重注册 + 回滚序列
client.js       浏览器半身：手写 ModuleLoader bundle，无构建步骤
```

几个值得知道的架构决定：

- **一个适配器，两条 provider 路由**。harness 的模型选择器严格按 provider 路由分组，
  而清单的线格式里根本没有 group / tag / badge 字段。所以要出现独立的 `region-limited`
  标题，唯一办法就是再注册一条路由；又因为客户端会丢弃空分组，一旦地区不再限制，
  两个分组会自动合并成一个。
- **结构性实现适配器，不 import `@deepseek-ai/dsh-llm`**。内核从不检查 `instanceof`，
  所以鸭子类型即可。这让插件不把依赖钉死在某个内核版本上，也是同一份代码能同时跑
  0.1.5 与 0.1.7 的原因。
- **自己的 JSON 存储，而不是 settings seam**。settings 注册 API 在两版内核间不一致；
  私有 JSON 存储行为一致，并且转发 Key 落在一个 `0600` 文件里，不进入任何共享设置文档。

### 为什么用预算，而不是 `reasoning_effort`

实测过：在这条车道上把 reasoning-effort 字符串发给上游是**空操作**——三个不同名义档位
反复采样，思考 token 数量在统计上无法区分。做一个不起作用的控件比不做更糟，
所以思考强度实现为**硬性输出 token 上限**，它确实会约束——留痕的思考 token 随档位单调上升。

### 两个真实浪费过调试时间的内核行为

都记在 [`docs/upstream-findings.md`](docs/upstream-findings.md) 里；这里摘出来是因为任何写
provider 插件的人都会踩：

1. **`providerRetryPolicy()` 被原样存下来用**。两版内核都不解析它，而退避调度器读的是
   **顶层**的 `initialDelayMs / maxDelayMs / jitterRatio`。把这三项嵌在 `backoff:{}` 里，
   它们读到 `undefined`，于是 `undefined * 2ⁿ = NaN`，而持久会话日志直接拒绝非有限数——
   一个本可恢复的瞬时故障就变成整轮对话报废。要返回**已解析好的扁平策略**。
2. **一次被打断的工具调用会永久毒化该会话**。没有对应结果的工具调用重放时上游回
   `400 invalid_request_error`，此后该会话里**每一次**请求都失败。本插件在发送前修复配对，
   三种线协议共用同一处修复。

### 为什么速度那一栏会显示 `—`

早先的版本给一条实际只有 ~40 tok/s 的车道报出过 2 941 tok/s。问题不在网关——直连
读包的探针显示 64 个帧跨了 5.6 秒，是实打实的增量投递——而在分子分母量的不是同一段
时间：一次调用计费 422 个输出 token，其中 291 个是**一个帧都没流出来**的 reasoning，
它们早在第一个可见 token 之前就生成完了，可窗口的起点正是那个 token。拿整段
completion 去除答案文本落地的几秒钟，不叫解码速度。

所以现在只有"装得下分子的那段时间"才允许出速率：`windowTokens()` 把没流出来的
reasoning token 从分子里剔掉，`decodeWindow()` 拒掉短到没法计时的窗口和快得不真实的
速率，看板和模型表都改成 `Σtoken / Σ秒` 而不是把每次的速率再取平均——曾经有一个 1 ms
的窗口把 26 次调用的均值抬了三个数量级。于是答案挤在一两个大帧里落地的模型，就是
没有可测的输出速度，它显示 `—`。

## 验收情况

在两套内核上、Windows 环境、对真实上游实测；本轮（v1.1.2）的全部新能力都做了
**实际操作验证**，包括浏览器与 DSHEAC AIO 桌面窗口内的逐项点击：

| 项目 | 结果 |
| --- | --- |
| `dsh` 0.1.7-rc.1（源码构建） | 启动无报错；选择器两个分组正确；多轮工具调用完成 |
| `dsh` 0.1.5-rc.2（DSHEAC AIO 6.9.3 内核） | 启动无报错；与已装的其它第三方插件并存 |
| EAC 启动闸门 | 安装时与**应用内升级之后**各跑一次：`compatible` / `PASS` |
| 模型可调用性 | 10 个清单模型全部可达（含探测失败/暂不可用者）；real chat、多轮工具、视觉输入在两套内核通过 |
| 真实 harness 对话 | dsh web 与 AIO 桌面端各自完成一轮真实对话并收到回复 |
| 公告 feed | 本地"仓库服务器"上推送新公告 → 运行中的两端在一个轮询周期内到达 |
| 公告中心 UI | 4 条公告渲染（粗体/代码/链接/列表）、紧急红色徽章、未读点、单条/全部已读 |
| 紧急公告 | `urgent` 推送触发全屏弹窗，"知道了"即写入已确认状态 |
| Toast + 系统通知 | 新公告实时 toast；桌面端 `window.Notification` 通道存在（WebView2 权限策略拒绝授权时 UI 如实提示） |
| 应用内升级 | dsh web 与 AIO 桌面端各完成一次 1.1.0 → 1.1.2 升级：23 文件下载、SHA-256 校验、备份、替换、热重载；升级后 `/meta` 立即报新版本 |
| 升级安全性 | 哈希不匹配 → staging 丢弃、已装包不动、历史记录失败；升级产物通过 EAC 闸门并完整重启加载 |
| 热重载 | 按钮、API 两种入口；ESM 缓存清除 + 重注册 + 回滚序列；`generation` 递增、客户端经 localStorage 提示一次 |
| 客户端 bundle 热更 | 替换 `client.js` 后浏览器端由内核 client-hmr 自动重载（实测两次） |
| 信任围栏 | 非 loopback Host / 跨站 `sec-fetch-site` / 异源 `Origin` 一律 403；无 cookie 回环请求 401（与内核 `/api` 一致） |
| SSE 推送 | `hello`/`announcements`/`update`/`upgraded` 事件实测；热重载后自动重连 |
| 思考强度传递 | light/balanced/deep 三档实测：reasoning 2048（被预算截断）/ 3386 / 3522，输出单调上升 |
| 地区门 | 受限模型报 `REGION_BLOCKED` 并留在自己的分组 |
| 转发端口 | `/v1/models`、流式与非流式 `/v1/chat/completions`；无 Key 请求被拒 `401` |
| 界面文案 | 无乱码；任何面向用户的位置都不出现上游厂名 |

**没验证的部分如实说明**：OS 级通知的**最终视觉呈现**没有逐像素确认——AIO
桌面端的 WebView2 权限策略拒绝了 `Notification.requestPermission()`（插件的
Tauri 通知通道存在，纯浏览器路径可用，被拒时设置页如实显示"需要在系统/浏览器
设置里手动恢复"）；AIO 对内置插件有报告式的静态启发扫描（`TROJAN_EXFIL_ENV`
对 `src/upstream.js` 的 env+URL 邻近模式会记一条报告日志），属报告不动文件。

## 已知边界

- **"不限量"指的是没有额度这套东西**：不充值、不按 token 计费、没有套餐和用量面板。但这条车道按 session 记速率，短时间内打满会回 `429`。插件把该模型标成"已达限额"而不是隐藏，下一轮探测自动恢复。
- **个别模型上游本身很慢**。`nemotron-3.5-lightning-free` 有一次实测首字超过 30 秒。这是上游延迟，看板会如实显示。
- **输出速度有时会显示 `—`**。答案只落在一两个大帧里、或者思考过程根本不流式返回的模型，没有值得相除的时间窗。看板宁可空着，也不会把"想的时间"算成"写的速度"。
- **能力只到探测能证明的程度**。公开清单和实测都拿不到证据的，就不标注。
- **源码是明文 JavaScript**。作为本地插件必须如此。能拿到这个目录的人就能读懂网关逻辑——请把它当成这种分发形态的固有属性，而不是"混淆一下就能解决"的问题。
- **桌面端安装需要真实目录**，原因见[安装](#安装)一节。
- **升级与热重载的信任边界**：应用内升级信任的是插件仓库本身——能推送仓库的人能推送任意代码，这与"安装一个插件更新"的信任模型相同。文件层面的完整性由 SHA-256 清单保障，代码层面的安全由客户端的白名单 HTML 渲染器与宿主的插件隔离承担。
- **DSHEAC AIO 的 WebView2 权限策略可能拒绝通知授权**（本机实测 `denied`）。被拒时公告中心的开关会如实提示；纯浏览器访问 dsh web 不受影响。
- **插件接口的鉴权取决于 composition**：挂了 connection 服务的 composition（dsh web、AIO 桌面端）下与内核 `/api` 同级（需要应用自己的 cookie/token）；没有 connection 服务的极简 composition 退回到结构化围栏（loopback + 同源检查），本机其它进程仍可访问——与内核在同类 composition 下的行为一致。

## 开发

```bash
node scripts/client-lint.mjs        # 浏览器半身：文案键与样式键双向覆盖、bundle 可执行
node scripts/retry-safety-test.mjs  # 交给内核的失败对象与退避策略必须可持久化
node scripts/speed-stat-test.mjs    # 没有任何一次调用能被平均成假的 tok/s
node scripts/sanitize-test.mjs      # 公告 HTML 白名单渲染器：XSS 语料必须全部被丢弃
node scripts/trust-test.mjs         # 插件路由的请求信任围栏
node scripts/feed-test.mjs          # 公告 feed：解析、故障转移、缓存、到达检测（本地 HTTP 服务器）
node scripts/updater-test.mjs       # 应用内升级：清单校验、SHA-256、备份/回滚（本地 HTTP 服务器）
node scripts/host-selftest.mjs      # Host 半身端到端，会真实出网
node scripts/build-manifest.mjs     # 发布：重新生成 feed/manifest.json（发布文件哈希清单）
```

`scripts/probes/` 是逆向过程中的一次性取证脚本——能力矩阵、地区门、
`reasoning_effort` 空操作采样、预算方言、悬空工具调用、工具名字符集规则、
原始读包时刻（`batch-delivery`）、逐帧到达与 usage 对照（`decode-window`）。
其中五个跑的是本插件自己的代码，从仓库根目录就能执行
（`node scripts/probes/pairing-repair.mjs`）；其余借助一个第三方 SSE 客户端直连上游，
模块路径写成了那个仓库的样子，所以只作为取证记录保留，不能当测试套件用。
它们都没有接进 `npm test`——本来也没有安装步骤可以接入。

需要 Node `^22.19.0 || >=24.0.0`。无安装步骤、无依赖。

## 安全与隐私

- 所有状态写在 `DSH_HOME/our-free-model/`；用量与设置只落本地，不上传任何地方。
- 转发监听默认 `127.0.0.1`，无 Key 请求一律拒绝。改监听地址是一个显式动作。
- 转发 Key 由 `crypto` 运行时生成、用 `timingSafeEqual` 比对、存在 `0600` 文件里。本仓库不含任何硬编码凭据。
- 插件的 HTTP 路由带**请求信任围栏**（v1.1 起修复）：插件的 `/api/our-free-model` 前缀在 webServer 的最长前缀分发下优先于内核 `/api`，曾绕过内核鉴权。现在每个请求先走 composition 的 `connection` 服务准入（与内核 `/api` 完全同级的 cookie/token 校验）；connection 缺席的 composition 退回结构化围栏——loopback Host、拒绝跨站 `sec-fetch-site`、`Origin`/`Referer` 必须与 Host 同源同端口。实测：异源 Host/Origin 403，无 cookie 回环请求 401。
- **公告 HTML 在客户端经严格白名单渲染**：`scripts/sanitize-test.mjs` 用 XSS 语料（脚本注入、事件属性、`javascript:`/`data:` URL、iframe/svg/form、样式注入、畸形标签）验证全部丢弃；不经过任何 `innerHTML` sink。公告源的 `feedUrl` 可被用户改指向任意 URL，因此渲染器按不可信输入对待。
- **应用内升级的完整性链**：清单校验（semver、路径逃逸、哈希格式）→ 下载逐文件 SHA-256 + 字节数 → staging 回读校验 → 安装后回读校验 → 任一步失败恢复备份；安装前强制重新拉取清单，杜绝陈旧清单。升级信任根是插件仓库本身（与安装插件更新相同），文件与代码边界见[已知边界](#已知边界)。
- 卸载只需移除 bundle 条目，插件不留任何补丁；它的数据目录是纯 JSON，可直接删除。

## 许可证

MIT，见 [LICENSE](LICENSE)。

本项目是独立插件，与任何模型提供方无隶属、认可或赞助关系。用它访问免费额度受各提供方
自身条款约束；在超出你自己机器的场景部署前，请先确认这些条款。
