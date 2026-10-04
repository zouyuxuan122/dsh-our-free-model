# 出口代理（Proxy Egress）调整点说明

## 状态与目标

- 记录日期：2026-10-04。
- 当前状态：功能已实现，离线测试全绿，**真机端到端实测通过**（本机 Clash 客户端 + 用户自有 VPS 上的 tinyproxy 两条路径）。本 PR **未**更新 `feed/manifest.json`，原因见「清单与签名」一节。
- 目标：让用户能指定一个出口代理（VPS 或本机代理客户端），使被**地区门控**的模型在换过出口后重新判定为可用。
- 适用范围：**模型请求**（`src/http.js`）与**出口 IP 探测**（`src/probe.js`）。公告 feed 与自动更新**保持直连**。
- 非目标：全局代理（不改进程环境变量、不影响同进程的其他插件）、SOCKS4、给第三方站点做代理转发、公告/升级走代理。

一句话概括改动：**新增两个模块，在三个 `fetch` 调用点换成 `egressFetch`，加一个设置分区和一个只读的状态字段。** 关闭开关时 `egressFetch` 就是全局 `fetch`，字节级零行为变化，所以既有测试套件无需改动即全绿。

## 已有事实与本次变化

改动前插件所有相关请求都走 Node 24 的全局 `fetch`，没有任何出口控制能力。而地区门控链路是：

`src/probe.js` 探测公网 IP/国家 → `index.js:360` `detectEgress()` → 写 `availability.json` → `index.js` 的 `computeMembership(...)` 按 `ROUTE_REGION` 把受限模型单独分组。

也就是说：**出口是地区判定的唯一输入**。换一个出口，受限模型的归类就会自己改变——探测与分组逻辑一行都不用改，这正是本次能做成"加一个设置项"而不是"重写门控"的原因。

本 PR 新增的三个接线点：

| 位置 | 改法 | 漏了会怎样 |
| --- | --- | --- |
| `src/http.js` 两处 `fetch` | → `egressFetch` | 模型请求仍直连，代理形同虚设 |
| `src/probe.js` `detectEgress()` | → `egressFetch` | **界面上的出口 IP 仍是本机**，用户无法判断配置是否生效 |
| `index.js` 启动 effect | 在首次 `refreshCatalog({probe:true, force:true})` **之前** `await configureEgress(...)` | 启动探测仍走直连，要等下一次探测才生效 |

`src/probe.js` 那一处最容易被漏：探测的是"网关看到的地址"，而用了代理之后网关看到的是代理的地址。不改这里，界面会一边说"已启用代理"一边显示本机 IP。

## 新增模块

### `src/proxy.js`（约 630 行）

对外接口：

```js
export const DEFAULT_BYPASS = 'localhost, 127.0.0.1, ::1'
export function redactProxy(text)                 // 日志/错误里抹掉 user:password@
export function parseProxyUrl(raw)                // → {ok, scheme, host, port, username, password} | {ok:false, error}
export function isBypassed(hostname, bypass = [])
export function splitBypass(text)
export function configureEgress(config = {})      // async；返回 {ok:true, record} | {ok:false, error}
export function egressStatus()                    // 设置页与 /summary 读的状态，永不含密码
export function disposeEgress()                   // 重配与插件 dispose 时销毁全部池化 socket
export async function egressFetch(url, init = {}) // fetch 兼容层
```

三种协议按 URL scheme 自动分派，共用一条隧道：

| 地址形态 | 隧道 |
| --- | --- |
| `http://[user:pass@]host:port` | TCP → HTTP `CONNECT` → 可选 `Proxy-Authorization: Basic` |
| `https://[user:pass@]host:port` | TLS 到代理 → 代理内 `CONNECT` → 对目标再套一层 TLS（嵌套 TLS） |
| `socks5://` / `socks5h://` | SOCKS5 握手（无认证或 user/pass 子协商）→ 目标域名以 ATYP `0x03` 交给代理解析 |
| `host:port`（无 scheme） | 按 `http://` 解读 |

`http/https/socks5/socks5h` 之外的 scheme、非法端口、路径段等一律在 `parseProxyUrl` 拒绝，最终变成 `POST /settings` 的 400。

**唯一不显然的实现细节（也是这个 PR 最值得 reviewer 看的一处）**：Node 24 **忽略** `http.request` 选项里传入的 `createConnection` 回调——它不属于 Agent API，请求会直接拨号出去、静默绕过代理。可行的写法是**继承 Agent 并覆写 `createConnection`**，且覆写必须回调并返回 `undefined`（返回 socket 会让基类认为已处理完）。这条是实测出来的，不是推断：早期用构造参数写法的实验里自定义回调从未被执行，请求却直连成功了。

`https://` 代理这一层设 `rejectUnauthorized: false`（允许自签、允许明文 `http://` 代理），**但对目标站 `opencode.ai` 的 TLS 校验仍然是严格的**——放宽的只有"到代理那一跳"。

### `src/secret.js`（约 190 行）

```js
export function secretBackend()   // 'windows-dpapi' | 'machine-aes'
export async function sealSecret(plain)
export async function openSecret(record)
```

插件唯一存储的机密是代理密码。设置文件是用户目录下的明文 JSON，密码明文写进去会跟着文件一起泄漏（备份、网盘同步、粘进 bug 报告的整个 settings 对象）。两个后端，按强度排列：

| 后端 | 机制 | 能力边界 |
| --- | --- | --- |
| `windows-dpapi` | `CryptProtectData`，`DataProtectionScope::CurrentUser` | 密文绑定 Windows 账户，离机不可解；代价是换机器要重输密码 |
| `machine-aes` | `sha256(hostname\|username\|platform\|arch\|homedir)` 派生 scrypt(N=2¹⁵,r=8,p=1) 密钥 + AES-256-GCM | 解密所需一切随文件走，只提高离线攻击成本，不使其不可能 |

明文只存在于内存：经环境变量 `OFM_SECRET_IN` 传给 PowerShell 子进程，**绝不拼进脚本文本**（防注入）。设置页会如实显示当前生效的后端，而不是暗示用的是更强的那一个。解不开时（换机器/换 Windows 账户）不崩溃，标记 `secretUnreadable` 并提示重新填写。

> 坑：Windows PowerShell 5.1 默认不加载 System.Security 程序集，不加 `Add-Type -AssemblyName System.Security` 会报
> `找不到类型 [System.Security.Cryptography.ProtectedData]。` / `FullyQualifiedErrorId : TypeNotFound`。
> 这一行已经写在 `DPAPI_PROTECT`/`DPAPI_UNPROTECT` 里。

## 存储与设置页

`src/store.js` 的 `SETTINGS_INITIAL` 新增：

```js
proxy: { enabled: false, url: '', bypass: 'localhost, 127.0.0.1, ::1', secret: null },
```

`url` **永远不含密码**：保存时剥离成 `${scheme}://${user@}${host}:${port}`，密码单独封存在 `secret`。loopback 放行是**设置项默认值**而不是隐式常量——这样设置页能如实显示排除了什么，想让 loopback 走代理的用户也能改。

密码更新语义（两处容易被理解错的地方）：

- **密码框留空 = 保持原密码。** 前端始终提交完整 URL，后端解析后剥离并封存；只有显式带 `password` 或 `clearPassword` 才动密文。
- **`clearPassword` 只清密码，不清用户名。** URL 里的 `alice@` 是地址的一部分且界面上可见，所以清掉密码后发出的是 `Proxy-Authorization: Basic base64("alice:")`，与 `curl http://alice@host:port` 一致。真正消失的是密码本身。

`index.js` 的 `POST /settings` 新增 `proxy` 分支：白名单取 `['enabled','url','bypass','password','clearPassword']`，交给 `configureEgress` 解析/封存/装隧道；它拒绝就是用户的笔误，所以返回 **400** 而不是静默忽略。保存后 `void deps.watchEgress()`——只有它会 `detectEgress()` 并写回 `availability.egress`（`refreshAvailability` 用的是闭包里的旧 `egress`，**不会**重新探测出口）。这轮探测跑在响应之后。

新增 `POST /proxy/test`：只调 `detectEgress()`，几秒内回答"地址存下了但根本连不通"，而不是让用户等一轮注定失败的完整探测。前端 `applyProxy` 的顺序是 保存 → `/proxy/test`（30s）→ 不通就 toast 返回 → `/reprobe`（600s）→ 刷新。

`publicProxy()` 决定前端可见字段：`{enabled, url, bypass, hasPassword, active, scheme, host, port, secretScheme, secretUnreadable, backend}`，**永不含 password**。其中 `active` 描述**实际装上的隧道**而不是存储里的开关——手改过 `settings.json` 时界面才能说实话（说"重启后生效"而不是撒谎）。

`client.js` 新增 `ExitProxy` 组件（不叫 `Proxy`，避免遮蔽全局 `Proxy` 构造函数），含中英文内联 i18n 文案 24 条，插在 forward 与 prefs 两个 Section 之间。

## 测试

| 套件 | 覆盖 | 结果 |
| --- | --- | --- |
| `scripts/proxy-test.mjs`（463 行） | 隧道本体：CONNECT 握手、SOCKS5（含鉴权成功/失败）、嵌套 TLS、header 透传、流式分块、abort、bypass、URL 解析边界、凭据封存往返 | **31 项全绿**；`--live` 再加 1 项（经本地 CONNECT 代理对 `opencode.ai` 做真实 TLS）**32 项全绿** |
| `scripts/proxy-host-test.mjs`（185 行） | **路由级**：起一个只允许 stand-in origin 的本地 CONNECT 代理 + 本地 HTTP origin，断言"存地址 → 密码封存 → 隧道真的被用上（`Proxy-Authorization` 正确）→ 留空保持密码 → 显式清除 → 非法地址 400 且不破坏在跑的隧道 → `/proxy/test` 如实回答 → 关闭后回到直连" | **34 项全绿** |

两个套件都已注册进 `scripts/test-all.mjs`（`--only proxy` 前缀匹配会同时选中两个）。`proxy-host-test.mjs` 的存在理由：隧道通了但凭据泄漏仍然是缺陷，只有路由级测试能看见"密码有没有出现在返回体 / `settings.json` / 请求头里"。它断言的核心四条是 `settings.json` 中搜不到明文、`/settings` 与 `/summary` 返回体里搜不到明文、封存级别如实上报、清除后密文真的没了。

**既有 20 个套件一行未改，全部仍绿**——这本身就是"关闭开关时零行为变化"的最有力证据。

## 清单与签名：本 PR 为什么不改 `feed/manifest.json`

`node scripts/test-all.mjs` 在本分支上是 **19/22**，未通过的三个是 **manifest / release / catalog**，原因唯一：本次改动了随包发布的文件（`client.js`、`index.js`、`src/http.js`、`src/probe.js`、`src/store.js`）并新增了随包发布的 `src/proxy.js`、`src/secret.js`，而 `feed/manifest.json` 里的摘要是旧的。失败文案：

```
the committed digests do not describe the files on disk: client.js: size 110971 in the manifest, 120303 on disk
every file the package ships is named by the manifest, however deep — not covered: src/proxy.js, src/secret.js
```

对照实验：把 HEAD `22d760d` 用 `git worktree` 拉一份干净副本跑 `npm test` → **20/20 全绿**。所以这三个失败纯粹来自本次改动让摘要过期，不是继承的缺陷。

本 PR **刻意不**自行改清单，原因有二：

1. **签不出来。** manifest 必须带 Ed25519 签名，签名私钥不在本仓库、也永远不能进仓库（见 `scripts/build-manifest.mjs` 头注释）。没有私钥运行该脚本会写出一个**未签名**的 manifest 并覆盖 `feed/manifest.json`，把"摘要过期"升级成"升级链路损坏"。
2. **合并后还得再签一次。** 按仓库惯例，摘要刷新是合并后由持有私钥的维护者单独提交的一个 `chore(catalog): refresh source revision`（见 `22d760d`、`09de344`、`3274250`），合并请求分支不代劳。

**给 reviewer 的提示**：本 PR 的 CI 会在 manifest 套件上红，这是预期的。合并后请执行 `node scripts/build-manifest.mjs --key <private-key.pem>`（或 `OFM_MANIFEST_KEY=<pem>`）。

## 部署侧配套（不进发布包）

`package.json` 的 `files` 不含 `docs/` 与 `scripts/`，所以下面这些不参与清单覆盖检查：

| 文件 | 用途 |
| --- | --- |
| `docs/proxy-egress.md`（约 600 行） | 完整设计 + 第 8 节实施记录（含与设计的 8 处差异、密码语义澄清、回归现状） |
| `docs/proxy-egress-linux.md`（约 420 行） | Linux 侧部署方案：tinyproxy / 3proxy / Dante / stunnel / `ssh -N -D` 隧道，含排错表与验收清单 |
| `docs/proxy-egress-changes.md` | 本文档 |
| `scripts/deploy-proxy.sh`（619 行） | Linux 一键部署脚本（`bash -n` 通过），可 `--dry-run` |

Linux 侧推荐配置（裸命令，不依赖脚本）。以 tinyproxy 为例：

```bash
sudo apt install -y tinyproxy
sudo tee /etc/tinyproxy/tinyproxy.conf >/dev/null <<'EOF'
Port 8888
Listen 0.0.0.0
Timeout 600
MaxClients 100
LogLevel Info
LogFile "/var/log/tinyproxy.log"
Allow 0.0.0.0/0
BasicAuth ofm <小写字母数字或 . _ - 组成、长度 ≥8>
ViaProxyName "tinyproxy"
DisableViaHeader Yes
EOF
sudo systemctl restart tinyproxy
```

三条来自 tinyproxy 1.11.0 源码的硬约束（`src/conf.c` 的 `ALNUM` 为 `([-a-z0-9._]+)`）：`Port` 必填否则报 `You MUST set a Port in the config file.`；写了任一 `Allow`/`Deny` 后未命中即拒；`BasicAuth` 的用户名和密码**都**只接受 `a-z0-9._`，且**没有**密码长度要求，也**没有** `BasicAuth on` 这种开关。

插件里对应填法：

```text
启用：开
代理地址：http://ofm@<VPS_IP>:8888
代理密码：<与上面 BasicAuth 相同的那个>
直连例外：localhost, 127.0.0.1, ::1
```

> 地址里**不要**写密码。用户名字段留 `ofm@`，密码走独立的密码框——它会被单独加密封存，永不回显、不进日志。

## 已知边界

1. **公告 feed 与自动升级不走代理**，是刻意的：代理故障不应该连带破坏"收到修复"的能力。
2. **换机器要重输代理密码**（DPAPI 绑定 Windows 账户），界面会明确提示，不会静默失败。
3. **TLS 包装代理路径（`https://` 代理 + 自签证书）只在离线测试里验证过**，未在真机上跑过。插件对代理那一跳本就 `rejectUnauthorized: false`，风险面很小。
4. **`clearPassword` 之后仍然保留用户名**，因此代理若只校验"有凭据"而不校验密码内容，会继续放行（见上文语义澄清）。
5. `egressFetch` 不支持 `FormData`/`ReadableStream` 请求体，只支持 string/Buffer/Uint8Array（其余类型显式抛 `TypeError`），因为插件现有调用点只用 `JSON.stringify`。
6. **清单需维护者重签**，否则应用内"检查更新"会因为摘要不符而拒绝升级（见「清单与签名」一节）。

## 文件清单

| 文件 | 性质 |
| --- | --- |
| `src/proxy.js` | 新增（出口代理本体） |
| `src/secret.js` | 新增（凭据静态保护） |
| `scripts/proxy-test.mjs` | 新增（隧道测试，31/32 断言） |
| `scripts/proxy-host-test.mjs` | 新增（路由级测试，34 断言） |
| `src/store.js` | `SETTINGS_INITIAL` 增加 `proxy` |
| `index.js` | import / 启动 effect / dispose effect / `POST /settings` 分支 / `POST /proxy/test` / `publicProxy` |
| `src/http.js` | 两处 `fetch` → `egressFetch` |
| `src/probe.js` | 一处 `fetch` → `egressFetch`（**不能漏**，否则界面出口 IP 仍是本机） |
| `client.js` | `ExitProxy` 组件 + 中英文 i18n + 布局 + `applyProxy` |
| `scripts/test-all.mjs` | 注册两个新套件 |
| `docs/proxy-egress.md` | 新增（设计 + 实施记录） |
| `docs/proxy-egress-linux.md` | 新增（Linux 侧部署） |
| `docs/proxy-egress-changes.md` | 新增（本文档） |
| `scripts/deploy-proxy.sh` | 新增（Linux 一键部署脚本） |
| `README.md` / `README_EN.md` | 设置页分区列表由「六个分区」改为「七个分区」，并新增代理出口分区条目 |

### README 更新

本次同时更新了 `README.md` 与 `README_EN.md` 里设置页分区的描述——它是用户文档，改了用户可见的设置页就该同步：

- **代理出口**——开关、代理地址、密码（不回显，留空保持原值，可清除）、直连例外；保存后自动重新探测，地区受限模型按新出口重新归类；状态行显示出口 IP/国家、代理是否生效、密码保护后端。
