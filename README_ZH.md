<p align="center">
  <img src="icon.svg" alt="Our Free Model — DeepSeek Harness 免费模型插件" width="120">
</p>

<p align="center"><a href="README.md">English</a> | <strong>简体中文</strong></p>

<p align="center">
  <img alt="许可证" src="https://img.shields.io/badge/license-MIT-263146?style=flat-square">
  <img alt="零依赖" src="https://img.shields.io/badge/dependencies-zero-4b6fff?style=flat-square">
  <img alt="无构建步骤" src="https://img.shields.io/badge/build%20step-none-7da1de?style=flat-square">
  <img alt="适配内核" src="https://img.shields.io/badge/dsh-0.1.5--0.1.7-2f6f4f?style=flat-square">
  <img alt="状态" src="https://img.shields.io/badge/status-beta-f0a441?style=flat-square">
</p>

# dsh-our-free-model

> 在 DeepSeek Harness 里直接用免费模型：不注册、不填任何 API Key。
> 模型清单跟随上游刷新，可用性由**你自己这台机器的网络出口**实测得出，
> 思考强度下发的是真实预算而不是提示词，另附一个 OpenAI 兼容的本地转发端口。
>
> 纯插件挂载：不改内核、无构建步骤、零依赖。

---

## 亮点

- **装完即用，没有配置环节**——不需要账号、不需要 Key、不需要去哪个后台开配额。
- **清单跟随上游**——模型集合、上下文长度与能力每次刷新重新拉取，不是写死在插件里的一份快照。
- **能力声明诚实**——探测不出来的能力一律不显示。不会因为某张表曾经写过"支持视觉"就替模型乱标。
- **按出口判地区**——被地区限制的模型单独归到 `region-limited` 分组，而不是等你对话到一半才失败。切换网络出口后，下一次探测自动重新归类。
- **思考强度真的生效**——`Light / Balanced / Deep` 对应输出 token 预算 2 048 / 8 192 / 模型上限，且逐次调用留痕。它不是把一个 effort 字符串丢给上游然后假装有用（原因见[为什么用预算而不是 reasoning_effort](#为什么用预算而不是-reasoning_effort)）。
- **用量看板，全部留在本机**——Token 热力图、总量曲线（可看总计或单个模型）、输出速度与首字延迟逐次采样。不上传任何东西。
- **OpenAI 兼容转发端口**——本机其它工具用一个 base URL + Key 就能调用这些模型。
- **界面干净**——没有乱码，没有上游厂名字样泄漏到你的模型选择器里。

## 你会看到什么

**输入框的模型选择器**

| 分组 | 内容 |
| --- | --- |
| `Our Free Model` | 当前网络出口可直接使用的模型 |
| `Our Free Model · region-limited` | 上游对该地区不放行的模型，保留可见但单独隔离 |

**设置页 `设置 → Our Free Model`**，四个分区：

1. **模型清单**——每个模型的可用性、视觉还是纯文本、上下文窗口、最长输出、实测首字延迟，以及一次单调用基准测试按钮。
2. **用量看板**——总览计数、17 周 Token 热力图、总量曲线（Token / 请求数切换，总计与单模型切换）、速度迷你图、按模型汇总表。
3. **本地转发**——开关、监听地址与端口、复制 base URL、显示 / 复制 / 轮换 API Key，并给出一条可直接跑的 `curl` 示例。
4. **插件设置**——总开关、是否展示地区受限模型、探测间隔、默认输出上限，以及当前探测到的出口 IP 与国家。

**首次启动公告**——分 4 页（前言 / 模型清单 / 使用步骤 / 功能介绍），确认一次后不再弹，除非文案版本号被提升。

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
2. `dependencies` 里加 `"dsh-our-free-model": "1.0.0"`——写版本号，**不要写 `link:`**
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

## 实现结构

```text
index.js        Host 半身：适配器注册、清单与可用性探测、设置/用量存储、
                webServer 路由、转发端口生命周期
src/adapter.js  结构性 LlmAdapter：providerInfo、listModels、resolveModel、
                prepareCall、stream、providerRetryPolicy
src/upstream.js 网关身份：凭据、session/request id 铸造、工具指纹、按线协议选端点
src/stream.js   三种线协议解码（chat / messages / responses）归一为 harness StreamChunk，
                并做不相交的 token 计数
src/messages.js harness 消息 -> 各线协议形态，外加工具调用配对修复
src/effort.js   思考档位 -> 输出预算
src/forward.js  独立的 OpenAI 兼容监听器
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

## 验收情况

在两套内核上、Windows 环境、对真实上游实测：

| 项目 | 结果 |
| --- | --- |
| `dsh` 0.1.7-rc.1（源码构建） | 启动无报错；选择器两个分组正确；多轮工具调用完成 |
| DSHEAC AIO 6.9.3（`dsh` 0.1.5-rc.2） | 闸门 `compatible` / `PASS`；与你已装的另外 13 个第三方插件并存启动 |
| 0.1.5-rc.2 真实对话 | 本轮完成；插件自身流水记录 `origin=harness`、`effort=deep`、输出 146 token |
| 思考强度传递 | 实际服务的调用带上解析后的档位（同一会话里 `deep` 与 `balanced` 均有留痕） |
| 地区门 | 受限模型报 `REGION_BLOCKED` 并留在自己的分组 |
| 视觉输入 | 图片块被接受，模型描述正确 |
| 转发端口 | `/v1/models`、流式与非流式 `/v1/chat/completions`；无 Key 请求被拒 `401` |
| 公告 | 弹一次、4 页；**完整重启应用后不再弹** |
| 界面文案 | 无乱码；任何面向用户的位置都不出现上游厂名 |

**没验证的部分如实说明**：界面布局**没有用肉眼看过像素**。测试可用的浏览器表面视口是
0×0，截图功能不可用。布局是按结构化手段核对的——DOM 内容、计算后的 CSS 规则、
主题变量使用与响应式栅格——不是视觉确认。

## 已知边界

- **共享免费配额**。这条车道按 session 记账，短时间大量请求会撞 `429`。插件把该模型标成"已达限额"而不是隐藏，下一轮探测自动恢复。
- **个别模型上游本身很慢**。`nemotron-3.5-lightning-free` 有一次实测首字超过 30 秒。这是上游延迟，看板会如实显示。
- **能力只到探测能证明的程度**。公开清单和实测都拿不到证据的，就不标注。
- **源码是明文 JavaScript**。作为本地插件必须如此。能拿到这个目录的人就能读懂网关逻辑——请把它当成这种分发形态的固有属性，而不是"混淆一下就能解决"的问题。
- **桌面端安装需要真实目录**，原因见[安装](#安装)一节。

## 开发

```bash
node scripts/client-lint.mjs        # 浏览器半身：文案键与样式键双向覆盖、bundle 可执行
node scripts/retry-safety-test.mjs  # 交给内核的失败对象与退避策略必须可持久化
node scripts/host-selftest.mjs      # Host 半身端到端，会真实出网
```

`scripts/probes/` 是逆向过程中的一次性取证脚本——能力矩阵、地区门、
`reasoning_effort` 空操作采样、预算方言、悬空工具调用、工具名字符集规则。
其中三个跑的是本插件自己的转换器，从仓库根目录就能执行
（`node scripts/probes/pairing-repair.mjs`）；其余借助一个第三方 SSE 客户端直连上游，
模块路径写成了那个仓库的样子，所以只作为取证记录保留，不能当测试套件用。
它们都没有接进 `npm test`——本来也没有安装步骤可以接入。

需要 Node `^22.19.0 || >=24.0.0`。无安装步骤、无依赖。

## 安全与隐私

- 所有状态写在 `DSH_HOME/our-free-model/`；用量与设置只落本地，不上传任何地方。
- 转发监听默认 `127.0.0.1`，无 Key 请求一律拒绝。改监听地址是一个显式动作。
- 转发 Key 由 `crypto` 运行时生成、用 `timingSafeEqual` 比对、存在 `0600` 文件里。本仓库不含任何硬编码凭据。
- 插件只在自己的命名空间下注册 HTTP 路由并自行鉴权，不扩展任何共享设置面。
- 卸载只需移除 bundle 条目，插件不留任何补丁；它的数据目录是纯 JSON，可直接删除。

## 许可证

MIT，见 [LICENSE](LICENSE)。

本项目是独立插件，与任何模型提供方无隶属、认可或赞助关系。用它访问免费额度受各提供方
自身条款约束；在超出你自己机器的场景部署前，请先确认这些条款。
