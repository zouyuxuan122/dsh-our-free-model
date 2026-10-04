# 代理出口 · Linux 部署方法

配合 `docs/proxy-egress.md`（设计与实施记录）。这份文档只讲一件事：**在 Linux 上把代理跑起来，然后让插件连上去**。

> **本文档的验证状态**：插件侧的每一处行为（scheme 分派、错误文案、密码语义、重新探测）都来自本仓库代码和离线测试，已实测。**代理服务端（tinyproxy / Dante / 3proxy / stunnel）的配置我无法在这台机器上真跑**，其中 tinyproxy 的认证语法与服务号编号我查了上游源码确认（并据此修正过一次），其余请以"启动报错信息"为准——这些程序配置写错时都会立刻在 `systemctl status` / stderr 里报出来，不会静默跑歪。

插件这一侧不需要你做任何配置改动。代理地址填进设置页的「代理出口 → 代理地址」即可，协议由 URL 的 scheme 自动判断：

| 插件里填 | 含义 | 默认端口 |
| --- | --- | --- |
| `http://host:port` | 明文 HTTP CONNECT 代理 | 8080 |
| `https://host:port` | 先 TLS 连代理，再 CONNECT，再对目标做第二次 TLS | 443 |
| `socks5://host:port` | SOCKS5（也接受 `socks5h://`，域名交给代理解析） | 1080 |
| `host:port`（无 scheme） | 按 `http://` 处理 | 8080 |

用户名/密码有三种写法，效果相同：

```
http://user:pass@host:8080          密码写在地址里，提交后自动拆分并加密
http://user@host:8080               用户名在地址里，密码填在「代理密码」框
http://host:8080                    两个都填在「代理密码」框？不行——用户名只能写在地址里
```

> 用户名只能写进地址。密码框留空 = 保留已保存的密码；点「清除密码」只删密码，**保留用户名**（和 `curl http://alice@host:port` 一样会发 `Basic base64("alice:")`）。

---

## 0. 先决定部署形态

| 你的情况 | 方案 | 插件里填 |
| --- | --- | --- |
| 有一台境外 VPS | 方案 A 或 B | 方案 A：`http://VPS_IP:8888`；方案 B：`socks5://VPS_IP:1080` |
| 有一台境外 VPS，但想让代理本身走 TLS | 方案 C | `https://proxy.example.com:8443` |
| 只有一台国内机器，想临时借用境外出口 | 方案 D（SSH 反向隧道） | `http://127.0.0.1:8888`（**推荐先试这个**） |
| 没有任何境外机器 | 买一台最便宜的，或用方案 A 的免费额度 | — |
| 只想确认插件代码没问题 | 不需要代理 | 跑「8. 不装任何东西的离线自检」 |

**建议顺序：先做方案 D**（5 分钟、零配置、不开公网端口、密码全程加密），确认功能通了再决定要不要花钱买 VPS 做方案 A。

## 0.5 一键脚本 `scripts/deploy-proxy.sh`

如果你只是想**快点跑起来**，不用读下面的方案 A/B/C，仓库里有一个现成的部署脚本：

```bash
sudo bash deploy-proxy.sh
```

它做的事就是方案 A 的全部内容，外加自检：装 tinyproxy → 写带 user:pass 的配置和 systemd 单元 → 启动 → `curl` 真的走一遍代理访问 `opencode.ai` → 打印插件里该填的地址和密码。

| 参数 | 含义 |
| --- | --- |
| `--engine tinyproxy\|3proxy` | 选代理软件，默认 `tinyproxy`；`3proxy` 会同时开 HTTP 和 SOCKS5 两个端口 |
| `--port N` | HTTP 代理端口，默认 `8888` |
| `--socks-port N` | SOCKS5 端口，仅 `--engine 3proxy` 有效，默认 `1080` |
| `--tls-port N` | TLS 包装端口，仅 `--tls` 有效，默认 `8443` |
| `--user NAME` / `--pass PASS` | 代理用户名（默认 `ofm`）与密码（默认随机生成 16 位十六进制） |
| `--listen ADDR` / `--allow-cidr CIDR` | 监听地址（默认 `0.0.0.0`）与来源网段白名单（默认 `0.0.0.0/0`） |
| `--tls` | 额外用 stunnel 把 HTTP 端口包一层 TLS，插件里就能填 `https://` 开头的地址 |
| `--dry-run` | 只打印将要执行的命令和配置内容，不做任何改动 |
| `--uninstall` | 停掉并删除本脚本部署的服务与配置 |

几个要注意的行为：

- **不带 `--pass` 时会复用旧密码。** 脚本先从已有的 `/etc/tinyproxy/tinyproxy.conf` 或 `/etc/3proxy/3proxy.cfg` 里把凭据读回来，这样重复执行不会把插件里已经保存的密码顶掉。想换密码就显式传 `--pass`。
- **密码只接受 `a-z A-Z 0-9 . _ -` 且至少 8 位。** 原因是 tinyproxy 的 `BasicAuth` 解析器只认 `[-a-z0-9._]+`（源码里 `conf-tokens.c` 的 `ALNUM` 宏），脚本提前拦截并给出替代示例，而不是让你部署完才发现 tinyproxy 起不来。
- **凭据会落到 `/root/ofm-proxy-credentials.txt`（权限 600）**，方便你回头查。
- **重复执行会先备份**：`/etc/tinyproxy/tinyproxy.conf.bak`、`/etc/3proxy/3proxy.cfg.bak`。
- 脚本**不会**替你开云厂商的安全组，这一步要自己去控制台做。

手动部署（方案 A/B/C）和排错对照表在下面几节，脚本装完想调参数时对照着看即可。

**怎么读这份文档**：
1. **部署形态** → 本节。
2. **代理跑在哪** → 方案 A（HTTP CONNECT）／B（SOCKS5）／C（TLS 包装）／D（SSH 隧道）。
3. **凭据怎么写** → 开头「用户名/密码有三种写法」。
4. **填进插件** → 「7. 逐步验证与验收清单」第 2 步的表格。
5. **出错怎么办** → 「6. 常见错误 → 原因 → 解决办法」（左列是插件逐字抛出的错误文案）。
6. **只想验代码** → 「8. 不装任何东西的离线自检」。

---

## 方案 D · SSH 端口转发（**先做这个**）

前提：你在境外有一台能被 SSH 登录的机器（VPS、朋友的电脑、云主机都行）。

### D1 · 走远端 tinyproxy

先在远端按「方案 A」装好 tinyproxy，并让它**只监听 127.0.0.1**（方案 A 的默认配置就是这样）。然后在**你的电脑**上：

```bash
ssh -N -T -o ServerAliveInterval=30 -o ExitOnForwardFailure=yes \
    -R 127.0.0.1:8888:127.0.0.1:8888  vps-user@your-vps-host
```

这条命令在你本地开一个 `127.0.0.1:8888` 监听，插件发过来的 CONNECT 请求经 SSH 加密后送到 VPS 的 `127.0.0.1:8888`。插件填：

```
http://127.0.0.1:8888
```

好处：VPS 不暴露任何公网端口，不用配 user/pass（认证由 SSH 密钥负责），代理流量全程 SSH 加密。

### D2 · 走 SSH 自带的 SOCKS5（**服务端零配置**）

OpenSSH 自带动态 SOCKS5 转发，远端**什么都不用装**：

```bash
ssh -N -T -o ServerAliveInterval=30 -o ExitOnForwardFailure=yes \
    -D 127.0.0.1:1080  vps-user@your-vps-host
```

插件填 `socks5://127.0.0.1:1080`。这是 D1 之外的另一个零配置选择：`-D` 建立的是 SOCKS5 服务端，不需要远端有 tinyproxy 或 Dante。

### D3 · 走远端自建的 SOCKS5

如果你已经在远端按「方案 B」跑好了 SOCKS5 并监听 `127.0.0.1:1080`：

```bash
ssh -N -T -o ServerAliveInterval=30 -o ExitOnForwardFailure=yes \
    -R 127.0.0.1:1080:127.0.0.1:1080  vps-user@your-vps-host
```

插件填 `socks5://127.0.0.1:1080`。D2 和 D3 插件里填的东西一样，区别只是端口由谁提供。

### 验收

先在**你的电脑**上确认隧道通：

```bash
# D1（HTTP CONNECT）
curl -s -x http://127.0.0.1:8888 https://ipinfo.io/json
# D2/D3（SOCKS5）
curl -s -x socks5h://127.0.0.1:1080 https://ipinfo.io/json
#   → 都是 {"ip":"<境外IP>","country":"US",...}
```

连不上时按这个顺序查：`ExitOnForwardFailure=yes` 会在端口绑定失败时直接报错；隧道通了但 curl 报 407/403，那才是远端 `Allow`/`BasicAuth` 的问题；curl 完全正常但插件不通，回到「7. 逐步验证与验收清单」。

---

## 方案 A · tinyproxy（HTTP CONNECT，最简单）

### 安装

```bash
# Debian / Ubuntu
sudo apt update && sudo apt install -y tinyproxy

# CentOS / RHEL / Rocky
sudo dnf install -y tinyproxy

# Alpine
sudo apk add tinyproxy
```

### 配置 `/etc/tinyproxy/tinyproxy.conf`

```ini
# 必须监听回环还是 0.0.0.0，取决于你是否走方案 D
Listen 127.0.0.1
Port 8888

# 允许谁来用你的代理（后面再收紧）
Allow 127.0.0.1
# 走公网时改成你自己的出口 IP：Allow 203.0.113.10

# ── 认证：见下方"两个版本的认证写法" ──
# 新版（1.10+）：一行一个账号
# BasicAuth proxyuser 换成你自己的强密码
# BasicAuthRealm our-free-model

# 不要日志里出现密码
LogLevel Info
LogFile "/var/log/tinyproxy/tinyproxy.log"
Syslog Off
PidFile "/run/tinyproxy/tinyproxy.pid"

# tinyproxy 默认会加 Via 头，对 opencode.ai 无影响；要关就取消注释
# DisableViaHeader Yes
```

#### 两个版本的认证写法（别抄错）

tinyproxy 1.10 前后配置语法变过，**写错的话 tinyproxy 会拒绝启动**（`Syntax error on line N`）：

| 版本 | 写法 |
| --- | --- |
| **1.10 及更新**（当前 master） | 每行一个账号：`BasicAuth <用户名> <密码>`，可选 `BasicAuthRealm <名称>` |
| **1.8.x 及更旧** | 开关 + 账号分开写：`BasicAuth on` / `BasicAuthUser <用户名>` / `BasicAuthPass <密码>` |

先确认你的版本：

```bash
tinyproxy -v
dpkg -l tinyproxy | tail -1     # Debian/Ubuntu
```

`BasicAuth on` 报语法错 = 你的版本太新，该用一行式；反过来报"用户名为空"就是版本太老。**没有**"密码至少 6 位"这种限制——tinyproxy 只是把 `用户名:密码` 做 base64（上限约 256 字节），所以密码长短纯属你自己的安全选择，插件这边不限制。

**tinyproxy 的坑**：

1. **`Allow` 决定谁能连**。只写 `Allow 127.0.0.1` 时公网来的一律拒绝，表现是"连上了但 CONNECT 被 403"。
2. **不能用 tinyproxy 做 SOCKS5**。它只做 HTTP CONNECT（这也是方案 A 搭配方案 B 的原因）。
3. **`Port` 必须显式设置**，tinyproxy 没有默认值，缺了直接拒绝启动（`You MUST set a Port in the config file`）。

### 启动

```bash
sudo systemctl enable --now tinyproxy
sudo systemctl status tinyproxy --no-pager
ss -tlnp | grep 8888          # 确认在监听
```

### 验收（在**客户端机器**上跑，不是 VPS）

```bash
# 明文 HTTP CONNECT，无认证
curl -s -x http://your-vps-host:8888 https://ipinfo.io/json
#   → 期望 {"ip":"<境外IP>","country":"US", ...}

# 明文 HTTP CONNECT，带认证
curl -s -x http://proxyuser:YOURPASS@your-vps-host:8888 https://ipinfo.io/json
```

curl 报什么就是什么问题：

- `407 Proxy Authentication Required` → 用户名/密码错，或 `BasicAuth` 那几行没生效（先查版本语法）。
- `403` → `Allow` 里没有你的来源 IP。
- `curl: (5) Could not resolve proxy` / `(7) Failed to connect` → 地址或端口写错，或云安全组没放行。
- 成功但 `country` 还是 `CN` → 你连的其实不是这台 VPS（或者 `Allow` 太宽，被别人用了）。

---

## 方案 B · 3proxy / Dante（SOCKS5）

SOCKS5 的优势：能穿透更多网络环境；域名可由代理解析（本插件用 ATYP 3，等价 `socks5h`，本地不做 DNS，避免 DNS 污染）。

### B1 · Dante（`dante-server`，推荐，发行版自带）

```bash
# Debian / Ubuntu
sudo apt install -y dante-server
```

`/etc/danted.conf`：

```
# 监听
listenport = 1080
# 监听地址：走方案 D 就 127.0.0.1；直接暴露改成 0.0.0.0
listenaddress = 127.0.0.1

# 认证方式：2 = 需用户名密码
socksmethod = 2
user.privilegedgroup = nobody

clientmethod = 2
client pass {
    from: 127.0.0.1/32
    to: 0.0.0.0/0
    log: connect disconnect error
    method: username
}

# 允许的目标（去掉注释即全放行；这里先只放行 HTTPS，减少被滥用）
socks block {
    from: 127.0.0.0/8
    to: 0.0.0.0/0
    command: connect
    protocol: tcp
    # port: 0-65535
    # 只放 HTTPS 的话：port: 443
}

# 若要限制"只有你的 IP 能用"，在 client pass 里把 from 改成你的公网 IP/32
```

> Dante 的配置语法容易踩坑，最常见的是**忘记写 `user.privilegedgroup`** 导致报错。`clientmethod = 2` 才是"要求用户名密码"，写 `1` 是无认证。

启动：

```bash
sudo systemctl enable --now dante-server
# Debian 上服务名可能叫 socks5-proxy 或 dante；用下面这句找出来
systemctl list-units --type=service | grep -Ei 'dante|socks'
ss -tlnp | grep 1080
```

### B2 · 3proxy（一个进程同时开 HTTP 和 SOCKS）

> ⚠️ **这一节的服务号请先核对你的版本**，3proxy 的服务号在不同版本间有过变化。3proxy 启动时会立刻打印配置错误，所以最快的方式是"照抄下面的配置 → 跑 `sudo 3proxy -c /etc/3proxy.cfg` → 看它打印什么"。核对不到就跳过 B2，用 B1（Dante）或 D2（SSH 自带 SOCKS5）。

```bash
# Debian / Ubuntu
sudo apt install -y 3proxy
# RHEL / Rocky：sudo dnf install -y 3proxy
# 没有包时从源码装：https://github.com/3proxy/3proxy
```

`/etc/3proxy.cfg`：

```
# 谁能连这台机器。走方案 D 时只有回环会来，保持 127.0.0.1；
# 直接对外暴露时改成你的客户端公网 IP，例如 203.0.0.10
allow 127.0.0.1

# 账号
users login:YOURUSERNAME pass:YOURPASSWORD

# 日志（目录要存在，见下面的启动步骤）
flog /var/log/3proxy/3proxy.log

# 服务：<服务号> <地址族> <监听地址> <端口>
#   -1  = HTTP proxy（接受 CONNECT）
#   -2  = SOCKS4/5
#   需认证的 SOCKS 服务号请以本机 3proxy 文档为准（历史版本用 -31）
-1 IP 127.0.0.1 8080
-2 IP 127.0.0.1 1080
```

启动（3proxy 没有 systemd unit 时直接跑）：

```bash
sudo mkdir -p /var/log/3proxy
sudo 3proxy -c /etc/3proxy.cfg -D
ss -tlnp | grep -E '8080|1080'
sudo systemctl enable --now 3proxy   # 发行版带 unit 时才需要
```

**3proxy 的坑**：

1. **服务号写错时，症状很像"协议不对"**。8080 上挂 `-1` 才是 HTTP CONNECT；对一个挂着 SOCKS 的端口填 `http://`，插件会报 `代理在应答 CONNECT 之前关闭了连接`。
2. **`users` 行只对"要认证"的服务号生效**。若服务号是无认证的 SOCKS，密码根本不会被检查。
3. **对公网暴露必须有认证**。无认证 + `allow 0.0.0.0` 就是开放代理，几小时内会被扫到并导致 VPS 被封 IP。

### 验收（在客户端跑）

```bash
# 无认证 SOCKS5
curl -s -x socks5h://your-vps-host:1080 https://ipinfo.io/json

# 带认证 SOCKS5
curl -s -x socks5h://YOURUSERNAME:YOURPASSWORD@your-vps-host:1080 https://ipinfo.io/json
#   → {"ip":"<境外IP>","country":"US",...}
```

**`socks5://` vs `socks5h://`**：前者由 curl 本地解析域名再把 IP 给代理（可能被污染），后者把域名一起交给代理解析。插件内部一律用 ATYP 3 交给代理，行为等价 `socks5h`，所以 curl 验收时也写 `socks5h://` 以便对齐。

---

## 方案 C · TLS 包装代理（`https://` scheme，最不容易被掐断）

把一个明文 HTTP CONNECT 代理用 TLS 包起来，插件侧填 `https://...`（先 TLS 连代理 → CONNECT → 对目标再 TLS）。

明文代理直连境外 IP 有被限速或掐断的风险，所以这是长期部署时更稳的形态。

### 步骤

1. **VPS 上准备一个域名**（如 `proxy.example.com`）解析到 VPS IP。
2. **tinyproxy 只监听回环**（`Listen 127.0.0.1` + `Port 8888`，见方案 A 的配置）。
3. **用 stunnel 在最前面包一层 TLS**：监听 8443，转发到 `127.0.0.1:8888`。

```bash
sudo apt install -y stunnel4    # Debian/Ubuntu
# RHEL/Rocky: sudo dnf install -y stunnel
```

`/etc/stunnel/conf.d/proxy.conf`：

```ini
; stunnel5 用 /etc/stunnel/stunnel.conf，stunnel4 用 /etc/stunnel/stunnel.conf
; 服务名 [proxy] → 插件里填 https://proxy.example.com:8443

[proxy]
accept  = 0.0.0.0:8443
connect = 127.0.0.1:8888

; ── 证书 ──
cert = /etc/letsencrypt/live/proxy.example.com/fullchain.pem
key  = /etc/letsencrypt/live/proxy.example.com/privkey.pem
```

**证书**：正式环境用 Let's Encrypt（推荐）：

```bash
sudo apt install -y certbot
sudo systemctl stop tinyproxy            # certbot --standalone 要占 80/443
sudo certbot certonly --standalone -d proxy.example.com
sudo systemctl start tinyproxy
# 得到 /etc/letsencrypt/live/proxy.example.com/{fullchain,privkey}.pem
```

**务必用 `fullchain.pem`，不能用 `cert.pem`**。少了中间证书时，curl 会报证书错误（插件不会，因为它对代理层宽容——但别的客户端会）。

**自签证书**也可以，插件照常工作：

```bash
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
    -keyout /etc/stunnel/proxy.key -out /etc/stunnel/proxy.crt \
    -subj "/CN=proxy.example.com"
# stunnel 里改成 cert = /etc/stunnel/proxy.crt / key = /etc/stunnel/proxy.key
chmod 600 /etc/stunnel/proxy.key
```

启动与验收：

```bash
sudo systemctl enable --now stunnel4
ss -tlnp | grep 8443

# ① 验隧道本体（自签时加 -k）
curl -s -x https://proxy.example.com:8443 https://ipinfo.io/json
#   → {"ip":"<境外IP>","country":"US",...}
```

**区分两类失败**：

- **curl 报证书错误**，插件却正常 → 证书链问题（最常见是指了 `cert.pem` 而非 `fullchain.pem`），只影响 curl。
- **插件报 `与目标站建立 TLS 超时` 或 `代理拒绝 CONNECT（状态码 4xx）`** → stunnel 到 tinyproxy 的转发链断了，或 tinyproxy 的 `Allow` 没放行 `127.0.0.1` 以外的来源。查 `journalctl -u stunnel4`。

---

## 4. 证书校验的两层，不要搞混

本插件**故意**对"代理层 TLS"宽容（`rejectUnauthorized: false`），这样自签证书的 stunnel 也能直接用；**但对目标站（`opencode.ai` 等）保持严格校验**。

| 场景 | 插件 | curl |
| --- | --- | --- |
| 自签代理证书 | ✅ 通过 | ❌ 报证书错误（加 `-k` 才能过） |
| 正规证书但缺中间证书 | ✅ 通过 | ❌ 报证书错误 |
| 目标站证书有问题 | ❌ 报错 | ❌ 报错 |

第二条刻意如此：代理层是**你自己的机器**，证书问题不构成中间人风险；而目标站是第三方，校验必须严格。遇到目标站证书错误请不要试图放宽。

---

## 5. 端口与安全

| 端口 | 用途 | 建议 |
| --- | --- | --- |
| 8888 | tinyproxy 明文 CONNECT | 走方案 D 就只绑 `127.0.0.1`；对外暴露必须 `Allow 你的IP` + `BasicAuth` |
| 8443 | stunnel TLS 包装 | 同上；对外暴露时确保云安全组只放行你的 IP |
| 1080 | SOCKS5 | 对外暴露必须有用户名密码，否则就是开放代理 |

**安全建议**：

1. **永远不要开"无认证 + 0.0.0.0"**。这是典型的开放代理，几小时内会被扫到并用来做坏事，你的 VPS 会被封 IP。
2. **方案 D（SSH 隧道）完全不暴露端口**，是最安全的形态，也最适合先验证功能。
3. 代理服务端的密码请用强密码；插件侧只是把它加密存起来（DPAPI / AES-256-GCM），并不能弥补弱密码。
4. 云厂商安全组同样要收紧——只放行你自己的公网 IP，或者只放行 22（走方案 D 时连代理端口都不用开）。

---

## 6. 常见错误 → 原因 → 解决办法

下表左列是插件实际会抛出的错误文案（**逐字**摘自 `src/proxy.js`），右列是对应原因。

| 插件报错（实际文案） | 原因 | 怎么修 |
| --- | --- | --- |
| `connect ECONNREFUSED <host>:<port>` | 代理端口没人监听 / 防火墙拦了 | 在代理机上 `ss -tlnp \| grep <port>` 确认；检查云厂商安全组 |
| `connect ETIMEDOUT <host>:<port>` | 被墙/被云安全组丢包（明文代理直连境外常见） | 换方案 C（TLS 包装）或方案 D（SSH） |
| `代理在应答 CONNECT 之前关闭了连接` | 代理没在那个端口上跑（比如 1080 上其实挂着 SOCKS5） | 用方案 B 的 3proxy 别把服务类型写错；`ss -tlnp` 对一下 |
| `代理拒绝 CONNECT（状态码 403）` | tinyproxy 的 `Allow` 没包含你的来源 IP | 把 `Allow` 加上你的公网 IP（`curl https://api.ipify.org` 查） |
| `代理拒绝 CONNECT（状态码 407）` | 需要认证但没给对 user/pass | 用户名写进地址（`http://user:pass@host:port`）；确认 tinyproxy 的 `BasicAuth` 语法与你的版本匹配（见方案 A） |
| `代理拒绝 CONNECT（状态码 400）` | 代理要求 SOCKS5 但你填了 `http://` | 改 scheme：`socks5://host:port` |
| `代理在应答 CONNECT 之前关闭了连接` / `代理返回的 CONNECT 响应过大` | stunnel 没在跑 / 证书配置错 / 后端 tinyproxy 挂了 | `journalctl -u stunnel4` 看日志；确认 `connect = 127.0.0.1:8888` 后面有服务 |
| `连接代理超时（30000ms）` | 代理不响应 CONNECT（挂着但没在代理） | 在代理机上直接自测：`curl -x http://127.0.0.1:8888 https://ipinfo.io/json` |
| `SOCKS5 代理要求用户名密码，但代理地址里没有填写` | 代理要认证，地址/密码框都没给 | 地址写 `socks5://user@host:1080`，密码填「代理密码」框 |
| `SOCKS5 认证失败，请检查代理用户名与密码` | user/pass 写错 | 检查大小写；SOCKS5 user/pass 子协商标准只支持 ≤255 字节 |
| `SOCKS5 代理拒绝连接：host unreachable` | 代理自己出不了网 / 目标被它拦 | 在代理机上 `curl https://ipinfo.io/json` 直连试试 |
| `与目标站建立 TLS 超时` | 代理通了但对目标的第二次 TLS 没成 | 通常是 stunnel 转发链断了；看 stunnel 日志 |
| `SOCKS5 代理返回了非预期的版本号` | 那端口不是 SOCKS5（挂了 HTTP 代理） | scheme 填错，改 `socks5://` |
| `egressFetch: refused a 302 redirect` | 目标站发了个 3xx（正常，插件拒绝 3xx） | 无需处理；这是设计（等同原 `redirect:'error'`） |

---

## 7. 逐步验证与验收清单

### 第 0 步：先在代理机本机自测

**这一步能砍掉 90% 的排错。** 在代理机（或通过方案 D 连到代理机的回环）上：

```bash
# tinyproxy (方案 A)
curl -s -x http://127.0.0.1:8888 https://ipinfo.io/json
# → 期望 {"ip":"<境外IP>","country":"US"}

# 3proxy SOCKS5 (方案 B2)
curl -s -x socks5h://127.0.0.1:1080 https://ipinfo.io/json
# → 期望 {"ip":"<境外IP>","country":"US"}
```

如果这一步在**代理机本机**都不通，问题 100% 在代理服务器（配置/出网），跟插件无关。

### 第 1 步：在客户端用 curl 走插件的地址

```bash
# 客户端（你的电脑）
curl -s -x http://127.0.0.1:8888 https://ipinfo.io/json
#   （方案 D：本地监听 8888 转发到远端；或方案 A：直连 VPS 的 8888）
```

### 第 2 步：填进插件

设置 → Our Free Model / 免费模型 → 「代理出口」区块：

| 字段 | 方案 D（SSH 隧道） | 方案 A（tinyproxy 直连） | 方案 B（SOCKS5 直连） |
| --- | --- | --- | --- |
| 启用 | 开 | 开 | 开 |
| 代理地址 | `http://127.0.0.1:8888`（或 D2/D3 的 `socks5://127.0.0.1:1080`） | `http://proxyuser@VPS_IP:8888` | `socks5://proxyuser@VPS_IP:1080` |
| 代理密码 | 留空（走 SSH 不用代理账号） | 填代理密码 | 填代理密码 |
| 直连例外 | 保持默认 | 保持默认 | 保持默认 |

- **用户名只能写进地址**（它要在界面上可见），密码填在「代理密码」框；也可以把 `user:pass@` 一起写进地址，插件会自动拆分并把密码加密封存。
- 密码框留空 = 保留已保存的密码（第一次填过之后就是这样）。
- 填 `http://proxyuser:VPS_PASSWORD@VPS_IP:8888` 一次填完也可以，密码同样会被加密，不会明文留在设置文件里。
- 点「应用」：插件先测连通性（`POST /proxy/test`），通了再重新探测全部模型（`POST /reprobe`）；不通会弹提示并停下，不会重探测。

### 第 3 步：确认结果

设置页「代理出口」区块底部的状态行会显示：

- **当前出口**：`35.79.55.120 (US)` 之类。IP 变成代理的、括号里是国家 → 成功。
- **密码保护**：`Windows DPAPI（当前用户）` → 密码已封存。

模型列表里，地区受限的 `muse-spark-*` 会从「Our Free Model · 地区受限」分组移到普通分组（因为网关不再返回 `RegionError`）。这一点不需要你手动操作，改完出口插件自动重新归类。

### 第 4 步：验收清单

```bash
# 1. 插件侧出口正确（读插件自己的数据文件，最直接）
cat ~/.dsh/our-free-model/availability.json | grep -A3 '"egress"'
#   Windows PowerShell: Get-Content "$env:USERPROFILE\.dsh\our-free-model\availability.json" -Raw

# 2. 全部模型不再是 unknown（说明探测通过代理成功了）
#    期望每个 state 是 available / regionBlocked / quota，而不是 unknown
#    unknown + "connect ECONNREFUSED 127.0.0.1:7890" = 代理没连上

# 3. 密码确实没明文落盘
grep -c 'YOURPASS' ~/.dsh/our-free-model/settings.json
#   → 0
```

**如果第 1 步显示的 IP 变成了代理的、但第 2 步有大量 `unknown`**：说明出口探测通了、模型请求没通。检查 bypass 列表——默认 `localhost, 127.0.0.1, ::1` 不会影响 `opencode.ai`，但如果你自己加了 `*` 就全直连了。

---

## 8. 不装任何东西的离线自检

如果你只想确认**插件本身的代理代码**没问题（不关心出口在哪），仓库里有两个离线测试，都不需要外部代理服务器：

```bash
cd /path/to/dsh-our-free-model
node scripts/proxy-test.mjs          # 31 项：隧道、鉴权、bypass、Response 流式语义、错误文案
node scripts/proxy-host-test.mjs     # 34 项：路由级（起本地 stand-in 代理 + origin）
node scripts/proxy-test.mjs --live   # 32 项：上面 31 项 + 真连 https://opencode.ai
```

`proxy-test.mjs` 与 `proxy-host-test.mjs` 都会自己起一个本地代理 stand-in 来测三种协议（HTTP CONNECT / https 嵌套 TLS / SOCKS5），**所以它们本身就是"除 Clash 之外的一种测试方式"**——不需要你在外面有任何机器。两者已在 Windows 本机实测通过（2026-10-04：`proxy-test: OK`、`proxy-host-test: OK`）。

只有 `--live` 那一条需要外网：它用起好的本地 CONNECT 代理真连 `https://opencode.ai/`，验证嵌套 TLS + 流式响应在你当前网络下真的通。

---

## 9. 相关文件

| 文件 | 内容 |
| --- | --- |
| `docs/proxy-egress.md` | 设计与实施记录（为什么这么实现、测试矩阵、改动清单） |
| `docs/proxy-egress-linux.md` | 本文：Linux 部署方法 |
| `scripts/deploy-proxy.sh` | 一键部署脚本（tinyproxy / 3proxy + 可选 stunnel TLS），方案 A/B/C 的自动化版本 |
| `src/proxy.js` | 隧道与 `egressFetch` |
| `src/secret.js` | 密码封存（DPAPI / AES-GCM） |
| `scripts/proxy-test.mjs` | 离线协议测试（31 项） |
| `scripts/proxy-host-test.mjs` | 路由级测试（34 项） |

---

## 10. 想更快？先读这两页

- **只想让功能跑起来** → 方案 D2（`ssh -D 127.0.0.1:1080` + 插件填 `socks5://127.0.0.1:1080`），三行命令，不装任何服务端软件。
- **有海外 VPS，想一次搞定** → `sudo bash scripts/deploy-proxy.sh`，它会装好、起好、自检好并打印该填什么。
- **已经在 Clash 上验证过** → 你已经证明了插件侧的隧道、鉴权、出口探测、重新归类整条链路都通。剩下的问题只是"出口从哪来"，选 A/B/C 换掉 `http://127.0.0.1:7890` 这个地址即可，插件侧不用改任何代码。

