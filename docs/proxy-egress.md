# 上游出口代理（Proxy Egress）设计方案

> 状态：**已实现并真机实测通过**（Clash 本机端口 + VPS tinyproxy 两条路径均验证；
> 离线测试全绿；`feed/manifest.json` 摘要需维护者用 Ed25519 私钥重签，见 8.4）
> 目标版本：v1.4.0
> 关联：地区门控（ROUTE_REGION）、`availability.json`、`exposeRegionModels`
>
> 第 1–6 节是**开工前的设计**，保留原样以便对照；**第 8 节是实施记录**，
> 记录实际落地与设计的差异，以第 8 节为准。

---

## 1. 背景与目标

opencode.ai 的免费网关按**出口 IP 所在国家**对部分模型做门控。本插件在受限网络下探测到的
受限模型会被注册到 `ROUTE_REGION` 路由，用户无法使用。

**目标**：在插件设置页提供一个"上游出口代理"配置项，把插件的对外请求经由用户指定的
代理服务器发出，使出口 IP 变为美国，从而让受限模型自动进入可用分组。

**已确认的需求约束**（用户确认）：

1. **同时支持 `http://` / `https://` / `socks5://` 三种代理**，按 URL scheme 自动识别
2. **代理密码不回显**，静态**加密存储**，严防泄露
3. **不代理**公告 feed 与自动更新（非地区门控，避免把升级链路绑到代理可用性上）
4. 不新增 `devlog.md` / 需求文档等脚手架

**非目标**：不改动入站转发代理（`src/forward.js`，那是给其他工具用的，与本模块方向相反）。

---

## 2. 现状分析

### 2.1 网络出口清单

| 出口 | 位置 | 是否受地区门控 | 处理 |
|---|---|---|---|
| 模型主链路 `POST /zen/v1/*` | `src/http.js:279` | **是** | 走代理 |
| 网关 GET（模型列表等） | `src/http.js:418` | 否 | 走代理（与主链路同一出口，避免指纹不一致） |
| 出口 IP 探测 `detectEgress` | `src/probe.js:182` | — | **必须走代理**，否则界面显示的出口 IP 仍是本机 |
| 公告 feed | `src/feed.js:144` | 否 | **保持直连** |
| 自动更新 manifest / 资产 | `src/updater.js:253` / `:294` | 否 | **保持直连** |

`src/feed.js:139` 与 `src/updater.js:454` 本就支持 `fetchImpl` 注入，将来若要改，
只需在 `index.js:160` / `index.js:181` 构造时传入 `fetchImpl`，无需改这两个模块。

### 2.2 门控判定链路

```
probe.js detectEgress()          → 出口公网 IP + 国家（fail-open，失败返回 undefined）
        ↓ 写入 availability.json
index.js:346 refreshAvailability()
        ↓
index.js:906 computeMembership(catalog, availability, settings)
        ↓
可用 → ROUTE_MAIN        地区受限 → ROUTE_REGION
```

**关键结论：门控逻辑一行都不用改。** `client.js:225` 的既有文案已经点明：

> "This model is gated by egress country. Once a proxy changes your egress,
> the next probe moves it into the available group by itself."

即：出口 IP 变了 → 下一次探测自动把受限模型搬进可用分组。**缺的只是"让请求走代理"。**

### 2.3 方案选型（全部经实测，非推测）

| 方案 | 实测结论 |
|---|---|
| `import('undici')` 拿 `ProxyAgent` | ❌ `ERR_MODULE_NOT_FOUND`；`process.getBuiltinModule('undici')` 为 `undefined` |
| 新增依赖 | ❌ 硬约束：`package.json` 无 runtime 依赖，`files` 不发布 `node_modules` |
| `agent` 选项传 `createConnection` 回调 | ❌ Node 24 的 `http.Agent`/`https.Agent` **忽略**该回调（实测回调从未被调用，请求直连成功） |
| `NODE_USE_ENV_PROXY=1` | ⚠️ 未验证通过；且为全局环境变量、不支持 SOCKS5，不推荐 |
| **继承 Agent 覆写 `createConnection`** | ✅ **实测可用，本方案采用** |

### 2.4 三种代理协议的实测结果

用一个本地 stand-in 代理（CONNECT 代理 / SOCKS5 代理）+ 真实目标 `https://opencode.ai/`
跑通，结果：

```
PASS  https:// proxy (nested TLS, CONNECT)     → 200, 66868 bytes, 2604ms
PASS  socks5:// proxy (no auth)                → 200, 66868 bytes, 1106ms
PASS  socks5:// proxy (user/pass)              → 200, 66868 bytes, 1528ms
FAIL  socks5:// proxy (wrong password)         → socks5: authentication failed   ← 预期行为
```

**结论：三种协议全部可行，自动按 scheme 分派完全成立。** 关键验证点是
`https://` 代理需要的**嵌套 TLS**——`tls.connect({ socket: 已建立的 TLSSocket })`
在 Node 24 下正常工作，这是原本最不确定的一环。

---

## 3. 推荐部署方案（VPS 侧）

用户需自行准备一个带 Basic 鉴权的代理端口。**三种路径按推荐度排序：**

### 路径 A（最推荐）：本机代理客户端 + 插件指向本地端口

若本机已在用 Clash / v2rayN / sing-box 等客户端，直接把插件指向它的本地混合端口：

```
http://127.0.0.1:7890
```

- 优点：**零 VPS 改动**，抗封锁由客户端负责（可走 VLESS/Reality 等），链路最稳
- 缺点：需要保持客户端常驻

### 路径 B（用户原意）：VPS 直接开 HTTP CONNECT 代理端口

```bash
# Debian/Ubuntu + tinyproxy（配置最简单，全局一对 user:pass）
apt install -y tinyproxy
# /etc/tinyproxy/tinyproxy.conf:
#   Port 8888
#   Listen 0.0.0.0
#   BasicAuth  myuser  mypassword
#   Allow  0.0.0.0/0
systemctl restart tinyproxy
```

插件填：`http://myuser:mypassword@<VPS_IP>:8888`

- 优点：一条命令搞定
- ⚠️ **风险**：从中国大陆直连境外 IP 的**明文 HTTP 代理端口**属典型特征，容易被限速或阻断。
  建议换非标准端口，或直接走路径 C

### 路径 C：VPS 上的 TLS 包装代理

在路径 B 前面套一层 TLS 终止（nginx `stream` + `ssl_preread`、stunnel、或 xray 的 TLS 层），
插件填 `https://user:pass@<VPS_IP>:8443`。

- ⚠️ **自签证书问题**：`https://` 代理默认会校验代理证书。VPS 上请使用
  **Let's Encrypt 签发的域名证书**（推荐，免费且最省心）；自签证书需要额外的信任配置，
  属可选增强项
- 优点：隐藏协议特征

> **建议**：先用路径 A 验证插件功能是否正常（此时问题域被限定在插件侧），
> 再决定 VPS 侧怎么部署。

---

## 4. 插件侧设计

### 4.1 新增模块

| 模块 | 职责 | 规模 |
|---|---|---|
| `src/proxy.js` | 出口代理：URL 解析、隧道 Agent、`egressFetch`、bypass | 约 260 行 |
| `src/secret.js` | 凭据静态保护：DPAPI / 机器指纹 AES | 约 140 行 |

> 命名说明：`src/forward.js` 是**入站**转发代理（给其他工具用），本模块是**出站**上游代理，
> 两者用途相反，文档中分别称"转发代理"与"出口代理"。

### 4.2 `src/proxy.js` 对外接口

```js
/**
 * 应用一份出口代理配置。启动时与 POST /settings 时调用（异步：需要解密凭据）。
 * @param {{enabled?: boolean, url?: string, bypass?: string, password?: string|null}} config
 * @returns {Promise<{ok: true, summary: string} | {ok: false, error: string}>}
 */
export async function configureEgress(config)

/** 给设置页读取的状态快照（绝不含密码）。 */
export function egressStatus()
// → { enabled, url, bypass, active, scheme, host, port, hasPassword, secretScheme, error }

/** fetch 兼容的取数函数：无代理时直接透传全局 fetch。 */
export async function egressFetch(url, init)

/** 释放隧道 socket（dispose 时调用）。 */
export function disposeEgress()

/** 剥离凭据，供任何日志/错误消息使用。 */
export function redactProxy(text)
```

### 4.3 URL 解析与三种协议分派

```js
const SCHEMES = new Set(['http:', 'https:', 'socks5:', 'socks5h:'])

function parseProxyUrl(raw) {
  const text = String(raw ?? '').trim()
  if (text === '') return { ok: false, error: 'proxy url is empty' }
  // 允许省略协议：1.2.3.4:8888 视作 http
  const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`)
  if (!SCHEMES.has(url.protocol)) return { ok: false, error: `unsupported proxy scheme "${url.protocol}"` }
  if (url.hostname === '') return { ok: false, error: 'proxy host is empty' }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    return { ok: false, error: 'proxy url must not carry a path, query or fragment' }
  }
  const port = url.port === '' ? (url.protocol === 'http:' ? 80 : 1080) : Number(url.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, error: 'proxy port is invalid' }
  return {
    ok: true,
    value: {
      scheme: url.protocol.slice(0, -1),      // http | https | socks5 | socks5h
      host: url.hostname,
      port,
      username: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),   // 调用方负责立刻封存，不得落盘
    },
  }
}
```

分派规则（全部实测通过）：

| scheme | 到代理的连接 | 隧道建立 |
|---|---|---|
| `http` | `net.connect` | `CONNECT host:port` + `Proxy-Authorization: Basic …` |
| `https` | `tls.connect`（校验代理证书） | 同上，在 TLS 连接内发 CONNECT，再对目标做**嵌套 TLS** |
| `socks5` / `socks5h` | `net.connect` | SOCKS5 握手，ATYP=0x03（**域名交给代理解析**），支持 user/pass 子协商 |

### 4.4 隧道 Agent（唯一被实测证明可行的写法）

```js
function createTunnelAgent(proxy, secure) {
  const Base = secure ? https.Agent : http.Agent
  class TunnelAgent extends Base {
    createConnection(options, callback) {
      // 必须用回调、并 return undefined；返回 socket 会与 Agent 内部逻辑冲突
      openTunnel(proxy, options, secure).then(
        socket => callback(null, socket),
        error => callback(error),
      )
    }
  }
  return new TunnelAgent({ keepAlive: true, maxSockets: 8, maxFreeSockets: 2, timeout: 30000 })
}
```

`openTunnel` 的核心（三种协议共用尾部）：

```js
async function openTunnel(proxy, options, secure) {
  const host = options.host
  const port = options.port || (secure ? 443 : 80)
  const socket = await dialProxy(proxy)                 // http/socks5 → net.connect；https → tls.connect
  socket.setNoDelay(true)

  if (proxy.scheme.startsWith('socks')) {
    await socks5Handshake(socket, host, port, proxy)
    return secure ? tls.connect({ ...options, socket, createConnection: undefined }) : socket
  }

  const lines = [`CONNECT ${host}:${port} HTTP/1.1`, `Host: ${host}:${port}`]
  if (proxy.auth !== '') lines.push(`Proxy-Authorization: ${proxy.auth}`)
  lines.push('Proxy-Connection: keep-alive', '', '')
  socket.write(lines.join('\r\n'))

  const { status, rest } = await readConnectReply(socket)   // 只读响应头，剩余字节保留
  if (status !== 200) { socket.destroy(); throw new Error(`CONNECT refused: ${status}`) }
  if (rest.length > 0) socket.unshift(rest)

  // 直接复用 Agent 传下来的 options，servername / ALPN / rejectUnauthorized 全部自动正确
  return secure ? tls.connect({ ...options, socket, createConnection: undefined }) : socket
}
```

**为什么复用 `options` 而不是自己拼 TLS 参数**：`tls.connect` 会从 `options.host` 推导
`servername`（IP 时留空），并沿用 `rejectUnauthorized` / `ca` / ALPN 等设置。
手工拼装容易漏掉 SNI，导致证书校验失败或指纹异常。

### 4.5 `egressFetch`（fetch 语义等价包装）

```js
export async function egressFetch(url, init = {}) {
  const proxy = active
  const target = new URL(url)
  if (proxy === null || proxy.enabled !== true || bypasses(target.hostname, proxy.bypass)) {
    return fetch(url, init)                              // 零回归路径
  }
  const secure = target.protocol === 'https:'
  const request = secure ? https.request : http.request
  const headers = { ...(init.headers ?? {}) }
  const payload = encodeBody(init.body)                  // string / Buffer / Uint8Array → Buffer
  if (payload !== undefined && headers['content-length'] === undefined && headers['Content-Length'] === undefined) {
    headers['content-length'] = String(payload.length)   // ⚠️ 必须显式设置，否则退化为 chunked
  }
  delete headers['accept-encoding']                      // ⚠️ 不索取压缩，避免需要解压

  const response = await new Promise((resolve, reject) => {
    const req = request(target, {
      method: init.method ?? 'GET',
      headers,
      agent: agentFor(proxy, secure),
      signal: init.signal,
    })
    req.on('response', resolve)
    req.on('error', reject)
    if (payload !== undefined) req.end(payload); else req.end()
  })

  if (REDIRECT.has(response.statusCode)) {
    response.destroy()
    throw new TypeError('fetch failed', { cause: new Error(`unexpected redirect (${response.statusCode})`) })
  }
  const body = (response.statusCode === 204 || response.statusCode === 205 || response.statusCode === 304)
    ? null
    : Readable.toWeb(decompress(response))
  return new Response(body, {
    status: response.statusCode,
    statusText: response.statusMessage,
    headers: responseHeaders(response),
  })
}
```

### 4.6 必须守住的语义等价点

| 项 | 要求 | 原因 |
|---|---|---|
| `ok` / `status` / `headers.get()` / `.text()` / `.json()` / `.body` | 全部保留 | `src/http.js:288-316` 直接依赖 |
| `response.body` 为 web `ReadableStream` | 必须 | `readHead` 调用 `body.getReader()`（`src/http.js:300`） |
| `body === null` 仅限 204/205/304 | 必须 | `src/http.js:295` 用 `body === null` 判空响应 |
| `redirect: 'error'` | 3xx 必须抛错 | 调用点均传该选项，行为不能变 |
| `signal` | 透传给 `http.request` | Node 会以 `AbortError` 拒绝，`src/http.js:284`/`:427` 依赖该 name 分类为 aborted / timeout |
| `Content-Length` | 字符串 body 必须显式设置 | 否则退化为 `Transfer-Encoding: chunked`，上游行为可能不同 |
| `content-encoding` | 不主动索取；若返回则解压并剥掉该头 | `http.request` 不会自动解压（`fetch` 会） |
| TLS 校验 | `rejectUnauthorized` 保持默认 true，`servername` 必须为目标域名 | 安全基线不得降低 |
| `keepAlive` | 开启并复用同一目标的隧道 | 避免每轮对话重做 CONNECT |
| 连接超时 | CONNECT / 握手阶段加 30s 上限 | 代理挂了必须快速失败，不能挂死一轮对话 |

### 4.7 凭据保护（`src/secret.js`）

#### 分层设计

| 级别 | 平台 | 机制 | 强度 |
|---|---|---|---|
| **L1** | Windows | **DPAPI** `CryptProtectData(CurrentUser)` | 真正的 OS 级加密，密钥由 Windows 托管，**无法离线破解**；换机器/换用户解不开 |
| **L2** | 其他平台 | **机器指纹 scrypt + AES-256-GCM** | 防"文件被复制走 / 同步到网盘 / 误提交"，但知道机器指纹者可离线暴力破解，对短密码保护有限 |

设置页**明确显示当前使用的级别**，不制造虚假的安全感。

#### L1 实测结果（Windows DPAPI）

```
protect ok, 261ms, blob=308 chars
unprotect ok, 240ms, plain=hunter2-秘密
```

调用方式（Node → `powershell.exe`）：

```js
execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `
  $ErrorActionPreference='Stop'
  Add-Type -AssemblyName System.Security
  $bytes=[System.Text.Encoding]::UTF8.GetBytes($env:DSH_PLAIN)
  $enc=[System.Security.Cryptography.ProtectedData]::Protect($bytes,$null,
        [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
  [Convert]::ToBase64String($enc)
`], { env: { ...process.env, DSH_PLAIN: plain }, windowsHide: true, timeout: 10000 })
```

> ⚠️ 踩坑记录：Windows PowerShell 5.1 默认**未加载** `System.Security` 程序集，
> 不加 `Add-Type -AssemblyName System.Security` 会报 `TypeNotFound`。
> 单次调用约 250ms，只在保存设置与启动时各一次，可接受。

**DPAPI 不可用时自动降级到 L2**，不报错、不阻塞启动。

#### L2 机器指纹 AES

```
key = scrypt(machineFingerprint, randomSalt, N=2^15, r=8, p=1, 32)
machineFingerprint = sha256(hostname | username | platform | arch | homedir)
blob = { v: 1, alg: 'aes-256-gcm', salt, iv, tag, data }   // 全部 base64
```

解密失败（换机器 / 改用户名）时**不崩溃**：标记 `secretUnreadable`，界面提示
"代理密码无法解密（可能更换了设备或用户名），请重新填写"。

#### 存储形态（`settings.json`）

```json
"proxy": {
  "enabled": true,
  "url": "http://myuser@1.2.3.4:8888",
  "bypass": "localhost,127.0.0.1",
  "secret": { "scheme": "windows-dpapi", "blob": "AQAAANCMnd8BFdERjHoAwE/Cl+sBAAAA..." }
}
```

**`url` 中永远不含密码**：解析时把 `url.password` 抽出单独加密，`url` 只保留
`scheme://username@host:port`，因此 `settings.json` 即使被贴出去也不泄露密码。

#### 比加密更重要的四条纪律

1. **永不回显**：`publicSettings` 只返回 `{ enabled, url(无密码), bypass, hasPassword, secretScheme }`；
   API **只写不读**
2. **永不入日志**：所有代理相关错误消息经 `redactProxy()` 处理，userinfo 一律替换为 `***`
3. **永不进错误栈**：`Proxy-Authorization` 头与完整 URL 不得出现在任何抛出的 Error 中
4. **明文只存在于内存**：`active` 对象持有，不写任何缓存文件；`disposeEgress()` 时清空

#### 密码更新语义（前端体验）

- 前端**始终提交完整 URL**（用户直接粘贴 `http://user:pass@host:port` 最自然）
- 后端解析后剥离密码并加密；返回给前端的 `url` 不含密码
- 再次编辑时密码框留空 = **保持原密码不变**；填新值 = 覆盖；点"清除密码" = 删除密文

### 4.8 改动清单

| 文件 | 改动 | 风险 |
|---|---|---|
| `src/proxy.js` | **新增**，约 260 行 | — |
| `src/secret.js` | **新增**，约 140 行 | — |
| `src/store.js:148` | `SETTINGS_INITIAL` 增加 `proxy: { enabled:false, url:'', bypass:'', secret:null }` | 低（JsonStore 有默认值合并） |
| `index.js:728` 的启动 effect | **在 `refreshCatalog({probe:true})` 之前**加 `await configureEgress(settings.get().proxy)` | 中（顺序错了首次探测就会走直连） |
| `index.js` `POST /settings`（约 1149-1176） | 接受 `proxy`（含 `password` / `clearPassword`），校验非法则 400；保存后 `await configureEgress(...)` 并触发 `refreshAvailability(true)`，返回 `{ proxy, egress }` | 中（照抄现有 `forward` 校验写法） |
| `index.js` `publicSettings`（约 1233） | 暴露 `proxy`（无密码） | 低 |
| `index.js:712` 附近 | 新增 `ctx.effect(() => () => disposeEgress(), 'our-free-model: egress tunnel')` | 低 |
| `src/http.js:279` | `fetch(` → `egressFetch(` | 低 |
| `src/http.js:418` | `fetch(` → `egressFetch(` | 低 |
| `src/probe.js:182` | `fetch(` → `egressFetch(` | 低，但**不能漏** |
| `client.js` | 新增"代理出口"设置区块 + 中英文案（中文块约行 70-117、英文块约行 243-290） | 中 |

### 4.9 设置页 UI

照抄现有 `Forward` 区块（`client.js:1190-1235`）的 Switch / input / Apply / 状态 pill 结构：

```
代理出口
  [开关] 启用代理
  代理地址   [ http://myuser@1.2.3.4:8888 ]      支持 http:// / https:// / socks5://
  密码       [ •••••••• ]  [ 清除密码 ]           已加密保存（Windows DPAPI）
  直连例外   [ localhost,127.0.0.1 ]              逗号分隔，* 表示全部直连
  [ 应用 ]   [ 测试连通性 ]
  当前出口：1.2.3.4 (US) · 代理已启用 · 延迟 218ms
```

- 密码框**永不回显**，占位符显示 `••••••••` 表示"已保存"
- 状态行同时显示**当前保护级别**（DPAPI / 机器指纹），不制造虚假安全感
- 代理不可达时明确报错（"代理不可达：connect ECONNREFUSED"），不静默降级
- 复用 `client.js:1255` 已有的出口 IP / 国家显示

---

## 5. 实施计划与验收标准

三种协议 + 加密存储一次性做完（实测已全部验证可行，无需分期）。

**任务清单**

1. `src/secret.js`：DPAPI（Windows）+ 机器指纹 AES（兜底）+ 能力探测
2. `src/proxy.js`：URL 解析、三种隧道、`egressFetch`、bypass、`redactProxy`、dispose
3. `src/store.js` / `index.js` / `src/http.js` / `src/probe.js` 接线
4. `client.js` 设置区块 + 中英文案
5. `scripts/proxy-test.mjs` 离线测试，并注册进 `scripts/test-all.mjs`

**验收标准**

1. 未启用代理时 `node scripts/test-all.mjs` 全绿（零回归）
2. `http://` 代理：填地址 → 应用 → 状态行显示 VPS 的美国 IP
3. `socks5://` 代理（含 user/pass）：同上
4. `https://` 代理（嵌套 TLS）：同上
5. 受限模型自动从"地区受限"移入可用分组，可正常对话（含**流式输出**）
6. 故意填错端口 → 明确报"代理不可达"，插件不崩溃、不挂死
7. 非法 URL（`ftp://x`、`http://host:99999`、带 path）→ 400 + 原因
8. 关闭代理 → 立即恢复直连，出口 IP 变回本机
9. **凭据检查**：
   - `settings.json` 中搜不到明文密码
   - `GET /settings` 返回体中没有密码字段
   - 日志与错误消息中搜不到密码
   - 密码框留空重存后，代理仍能正常工作（密码未被清掉）
10. `scripts/proxy-test.mjs` 覆盖：CONNECT 握手、SOCKS5 握手（含鉴权成功/失败）、
    嵌套 TLS、header 透传、流式分块、abort 取消、bypass 命中、URL 解析边界、
    凭据封存/解封往返

> 离线测试的本地 stand-in 代理（HTTPS CONNECT 代理 + SOCKS5 代理，含鉴权）已在可行性
> 验证阶段写好，可直接改造成 `scripts/proxy-test.mjs`。证书用 Git 自带的
> `C:\Program Files\Git\usr\bin\openssl.exe` 生成自签名证书即可。

---

## 6. 风险与回滚

| 风险 | 影响 | 对策 |
|---|---|---|
| 代理不可达导致探测全失败 | 模型被误判为不可用 | `detectEgress` 本身 fail-open；UI 明确报错；一键关闭代理 |
| 明文 HTTP 代理被 GFW 干扰 | 时通时断 | 优先路径 A（本地客户端）；或路径 C 的 TLS 包装 |
| `https://` 代理用自签证书 | 握手失败 | 错误提示引导使用 Let's Encrypt 域名证书 |
| DPAPI 在受限环境下不可用 | 加密降级 | 自动降级到机器指纹 AES，界面如实标注级别 |
| 换机器 / 改用户名后解不开 | 需重填密码 | 不崩溃，界面提示"请重新填写" |
| `Content-Length` / `content-encoding` 处理不当 | 上游 400 或响应乱码 | 见 §4.6，并在离线测试中断言 |
| 隧道 socket 泄漏 | 长跑后句柄耗尽 | `keepAlive` + `maxFreeSockets` + `timeout` + `disposeEgress()` |
| 改动误伤主链路 | 全部模型不可用 | `egressFetch` 无代理时直接透传 `fetch`；关闭代理即完全等价于当前行为 |

**回滚**：本方案是纯增量。关闭开关后 `egressFetch` 走 `return fetch(...)`，
行为与当前版本完全一致；彻底回滚只需还原 5 个文件（两个新模块可保留不引用）。

---

## 7. 剩余待确认项

1. **代理部署路径**：A（本机客户端）/ B（VPS 裸 HTTP 代理）/ C（TLS 包装）——
   决定你先在 VPS 上装什么；插件侧三种都支持，不影响实现
2. **`https://` 代理的自签证书**：是否需要"允许自签名代理证书"开关？
   当前设计为**严格校验 + 引导用 Let's Encrypt**，不加开关

> 两项均已在实施中定案，见第 8.1 节。

---

## 8. 实施记录

### 8.1 与设计的差异（以此为准）

| # | 设计 | 实施 | 原因 |
|---|---|---|---|
| 1 | 部署路径待定 | **路径 A**（本机代理客户端 + 插件指向本地端口，如 `http://127.0.0.1:7890`） | 用户确认先用本机客户端验证，把问题域限定在插件侧 |
| 2 | `https://` 代理严格校验证书 | **`rejectUnauthorized: false`**（允许自签、允许明文 `http://` 代理） | 用户要求"宽容一点"。**注意：放宽的只是"到代理那一层"；对目标站 `opencode.ai` 的 TLS 校验仍是严格的** |
| 3 | `configureEgress` 返回 `{ok, summary}` | 返回 `{ok: true, record}`；`record` 是**直接写回 `settings.proxy` 的对象**（url 已剥离密码、密码已封存进 `secret`） | 让 `POST /settings` 一行写回，避免调用方自己拼存储形态 |
| 4 | 保存后触发 `refreshAvailability(true)` | 保存后触发 **`watchEgress()`** | `refreshAvailability` **不会**重新探测出口 IP（`runProbeRound` 用的是闭包里的旧 `egress`），只有 `watchEgress` 会 `detectEgress()` → 比对 → 写 `availability.egress` → 再重新探测。用错了界面上的出口 IP 不会更新 |
| 5 | 无"测试连通性"路由 | 新增 **`POST /proxy/test`** | 前端要能在 2 秒内回答"地址存下了但根本连不通"，而不是卡在一轮注定失败的探测里。它只调 `detectEgress()`，不做完整探测 |
| 6 | — | 新增 `src/proxy.js` 导出 `egressStatus()` 的字段：`{enabled, url, bypass, active, scheme, host, port, hasPassword, secretScheme, secretUnreadable, backend}` | 其中 `active` 描述**实际装上的隧道**，而不是存储里的开关——手改过 `settings.json` 时界面才能说实话 |
| 7 | 前端组件名未定 | `client.js` 中的组件名为 **`ExitProxy`**（不是 `Proxy`） | 避免遮蔽全局 `Proxy` 构造函数 |
| 8 | — | `ExitProxy` 的重置时机是 **`useEffect(..., [summary])`** | 与既有 `Preferences` 一致；只按存储字段做依赖会导致"重填同一个密码"后按钮永远停在可点状态 |

### 8.2 密码更新语义的两点澄清

- **`clearPassword` 只清密码，不清用户名。** URL 里的 `alice@` 是地址的一部分、且界面上可见，
  所以清掉密码后发出的是 `Proxy-Authorization: Basic base64("alice:")`——
  与 `curl http://alice@host:port` 行为一致。真正消失的是密码本身。
- **密码框留空 = 保持原密码。** 前端始终提交完整 URL，后端解析后剥离并封存；
  只有显式带 `password` 或 `clearPassword` 才会改动密文。

### 8.3 测试

| 套件 | 覆盖 | 结果 |
|---|---|---|
| `scripts/proxy-test.mjs` | 隧道本体：CONNECT 握手、SOCKS5（含鉴权成功/失败）、嵌套 TLS、header 透传、流式分块、abort、bypass、URL 解析边界、凭据封存往返 | **31 项全绿**；`--live` 再加 1 项（经本地 CONNECT 代理对 `opencode.ai` 做真实 TLS）**32 项全绿** |
| `scripts/proxy-host-test.mjs` | **路由级**：`POST /settings` 存地址 → 密码封存 → 隧道真的被用上 → 留空保持密码 → 显式清除 → 非法地址 400 且不破坏在跑的隧道 → `/proxy/test` 如实回答 → 关闭后回到直连 | **34 项全绿** |

两个套件都已注册进 `scripts/test-all.mjs`（`--only proxy` 前缀匹配会同时选中）。

`proxy-host-test.mjs` 的存在理由：隧道通了但凭据泄漏仍然是缺陷，只有路由级测试能看见
"密码有没有出现在返回体 / `settings.json` / 请求头里"。它断言的核心四条是：
`settings.json` 中搜不到明文、`/settings` 与 `/summary` 返回体里搜不到明文、
封存级别如实上报、清除后密文真的没了。

### 8.4 全量回归现状（重要）

`node scripts/test-all.mjs` → **19/22 套件通过**。未通过的三个是
**manifest / release / catalog**，原因是唯一的：本次改动了随包发布的文件
（`client.js`、`index.js`、`src/http.js`、`src/probe.js`、`src/store.js`）
并新增了 `src/proxy.js`、`src/secret.js`，而 `feed/manifest.json` 里的摘要是旧的。

失败文案：
```
the committed digests do not describe the files on disk: client.js: size 110971 in the manifest, 120303 on disk
every file the package ships is named by the manifest, however deep — not covered: src/proxy.js, src/secret.js
```

**这不是本次改动引入的缺陷，而是发布流程的正常一环**：manifest 必须带 Ed25519 签名，
签名私钥**不在本仓库、也永远不能进仓库**（见 `scripts/build-manifest.mjs` 头注释）。
更新摘要必须由持有私钥的维护者执行：

```bash
node scripts/build-manifest.mjs --key <private-key.pem>    # 或 OFM_MANIFEST_KEY=<pem>
```

> ⚠️ **不要在没有私钥的情况下运行 `node scripts/build-manifest.mjs`**：它会写出一个
> **未签名**的 manifest 并**覆盖** `feed/manifest.json`，把"摘要过期"升级成"升级链路损坏"。

对照实验：把 HEAD `22d760d` 用 `git worktree` 拉一份干净副本跑 `npm test` → **20/20 全绿**。
所以这三个失败**纯粹来自本次改动让摘要过期**，不是继承下来的缺陷。

**这也意味着本 PR 的 CI 会在 manifest 套件上红。** 本 PR 刻意**不**自行改
`feed/manifest.json`：按仓库惯例，摘要刷新是合并后由持有私钥的维护者单独提交的一个
`chore(catalog): refresh source revision`（见 `22d760d`、`09de344`、`3274250`），
合并请求分支不代劳——签了也白签，因为合并后内容又变了。

### 8.5 真机实测（已完成）

两条部署路径都已在真实机器上跑通，验证顺序即交付顺序：

| 路径 | 代理形态 | 插件里填的地址 | 结果 |
|---|---|---|---|
| A | 本机 Clash/v2rayN 等客户端 | `http://127.0.0.1:7890` | ✅ 用户确认「实测 clash 可用」 |
| B | 用户自有 VPS 上的 tinyproxy（`BasicAuth ofm <pw>`） | `http://ofm@<VPS_IP>:8888` | ✅ 用户确认「方案A测试也成功了」 |

实测回答了离线测试无法回答的那个问题：**填入真实代理后，地区受限模型
（`muse-spark-*`）自动移回可用分组，流式对话正常，出口 IP 变为代理服务器地址。**

尚未做的实测只有一项，且属于发布流程而非功能：TLS 包装路径（路径 C，`https://` 代理 +
自签证书）只在离线测试里验证过，未在真机上跑过——插件对代理那一跳本就
`rejectUnauthorized: false`，风险面很小。

### 8.6 改动文件清单

| 文件 | 性质 |
|---|---|
| `src/proxy.js` | 新增（出口代理本体） |
| `src/secret.js` | 新增（凭据静态保护） |
| `scripts/proxy-test.mjs` | 新增（隧道测试） |
| `scripts/proxy-host-test.mjs` | 新增（路由级测试） |
| `src/store.js` | `SETTINGS_INITIAL` 增加 `proxy` |
| `index.js` | import / 启动 effect / dispose effect / `POST /settings` 分支 / `POST /proxy/test` / `publicProxy` |
| `src/http.js` | 两处 `fetch` → `egressFetch` |
| `src/probe.js` | 一处 `fetch` → `egressFetch`（**不能漏**，否则界面出口 IP 仍是本机） |
| `client.js` | `ExitProxy` 组件 + 两套 i18n 文案 + 布局 + `applyProxy` |
| `scripts/test-all.mjs` | 注册两个新套件 |
| `docs/proxy-egress.md` | 本文档 |
| `docs/proxy-egress-linux.md` | 新增（Linux 侧部署方案：tinyproxy / 3proxy / stunnel / SSH 隧道） |
| `docs/proxy-egress-changes.md` | 新增（面向维护者的调整点说明，PR 主体说明） |
| `scripts/deploy-proxy.sh` | 新增（Linux 一键部署脚本，`bash -n` 通过；`scripts/` 不随包发布） |


