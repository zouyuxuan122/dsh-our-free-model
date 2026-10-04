#!/usr/bin/env bash
#
# deploy-proxy.sh —— 在一台远程 Linux 服务器上一键部署 HTTP(S) 代理，
#                    供 dsh-our-free-model 插件的「代理出口」使用。
#
# 做了什么：
#   1. 装 tinyproxy（默认）或 3proxy
#   2. 生成带 user:pass 的配置文件与 systemd 单元
#   3. 启动服务，用 curl 真的走一遍代理去访问 opencode.ai
#   4. 打印插件里该填的地址、密码和验证要点
#
# 用法：
#   sudo bash deploy-proxy.sh                       # 默认 tinyproxy，8888 端口
#   sudo bash deploy-proxy.sh --engine 3proxy       # 额外给一个 SOCKS5 端口
#   sudo bash deploy-proxy.sh --tls                 # 额外用 stunnel 包一层 TLS
#   sudo bash deploy-proxy.sh --dry-run             # 只打印要做的事，不改任何东西
#   sudo bash deploy-proxy.sh --uninstall           # 停掉并删除本脚本部署的东西
#
set -euo pipefail

# ---------------------------------------------------------------- 默认参数 --
ENGINE=tinyproxy
HTTP_PORT=8888
SOCKS_PORT=1080
TLS_PORT=8443
PROXY_USER=ofm
PROXY_PASS=
LISTEN=0.0.0.0
ALLOW_CIDR=0.0.0.0/0
TLS=0
DRY=0
UNINSTALL=0
FAIL=0

CONF_TP=/etc/tinyproxy/tinyproxy.conf
UNIT_TP=/etc/systemd/system/tinyproxy.service
CONF_3P=/etc/3proxy/3proxy.cfg
UNIT_3P=/etc/systemd/system/ofm-3proxy.service
STUN_CONF=/etc/stunnel/ofm-proxy.conf
STUN_UNIT=/etc/systemd/system/ofm-proxy-tls.service
CRED_FILE=/root/ofm-proxy-credentials.txt

# ------------------------------------------------------------------ 输出层 --
if [ -t 1 ]; then
  C_OK=$'\033[32m'; C_WARN=$'\033[33m'; C_ERR=$'\033[31m'; C_HEAD=$'\033[36m'; C_OFF=$'\033[0m'
else
  C_OK=''; C_WARN=''; C_ERR=''; C_HEAD=''; C_OFF=''
fi
say()   { printf '%s\n' "$*"; }
head2() { printf '\n%s== %s ==%s\n' "$C_HEAD" "$*" "$C_OFF"; }
ok()    { printf '%s  [OK] %s%s\n' "$C_OK" "$*" "$C_OFF"; }
warn()  { printf '%s  [!]  %s%s\n' "$C_WARN" "$*" "$C_OFF"; }
die()   { printf '%s  [X]  %s%s\n' "$C_ERR" "$*" "$C_OFF" >&2; exit 1; }

run() {
  if [ "$DRY" = 1 ]; then
    printf '%s+ %s%s\n' "$C_HEAD" "$*" "$C_OFF"
  else
    "$@"
  fi
}

# 从 stdin 写文件；dry-run 时只把内容打印出来
write_file() {
  local path=$1
  if [ "$DRY" = 1 ]; then
    printf '%s--- 将写入 %s ---%s\n' "$C_HEAD" "$path" "$C_OFF"
    cat
    printf '%s--- 文件结束 ---%s\n' "$C_HEAD" "$C_OFF"
  else
    mkdir -p "$(dirname "$path")"
    cat > "$path"
  fi
}

have() { command -v "$1" >/dev/null 2>&1; }

usage() {
  cat <<'USAGE'
用法: sudo bash deploy-proxy.sh [选项]

选项:
  --engine tinyproxy|3proxy  代理软件。默认 tinyproxy（只提供 HTTP CONNECT，插件够用）
                              3proxy 会同时开 HTTP 与 SOCKS5 两个端口
  --port N                   HTTP 代理端口（默认 8888）
  --socks-port N             SOCKS5 端口，仅 3proxy 有效（默认 1080）
  --tls-port N               TLS 包装端口，仅 --tls 有效（默认 8443）
  --user NAME                代理用户名（默认 ofm）
  --pass PASS                代理密码（默认自动生成 16 位随机十六进制）
  --listen ADDR              监听地址（默认 0.0.0.0，即公网可达）
  --allow-cidr CIDR          允许连接代理的来源网段（默认 0.0.0.0/0）
                              建议在云厂商安全组里再加一层限制
  --tls                      额外用 stunnel 把 HTTP 端口包一层 TLS，
                              插件里就可以填 https:// 开头的地址
  --uninstall                停止并删除本脚本部署的服务与配置
  --dry-run                  只打印将要执行的命令和配置内容，不做任何改动
  -h, --help                 显示本帮助

说明:
  * 不带 --pass 时脚本会生成随机密码，写入 /root/ofm-proxy-credentials.txt（权限 600）。
    下次不带 --pass 重复执行会复用原密码，不会把插件里已保存的密码顶掉。
  * 密码只接受 a-z A-Z 0-9 . _ - 且至少 8 位：tinyproxy 的 BasicAuth 解析器
    只认 [-a-z0-9._]+，脚本提前拦截并给出说明。
USAGE
}

# -------------------------------------------------------------- 参数解析 --
while [ $# -gt 0 ]; do
  case "$1" in
    --engine)     ENGINE=${2:?--engine 需要参数}; shift 2 ;;
    --port)       HTTP_PORT=${2:?--port 需要参数}; shift 2 ;;
    --socks-port) SOCKS_PORT=${2:?--socks-port 需要参数}; shift 2 ;;
    --tls-port)   TLS_PORT=${2:?--tls-port 需要参数}; shift 2 ;;
    --user)       PROXY_USER=${2:?--user 需要参数}; shift 2 ;;
    --pass)       PROXY_PASS=${2:?--pass 需要参数}; shift 2 ;;
    --listen)     LISTEN=${2:?--listen 需要参数}; shift 2 ;;
    --allow-cidr) ALLOW_CIDR=${2:?--allow-cidr 需要参数}; shift 2 ;;
    --tls)        TLS=1; shift ;;
    --uninstall)  UNINSTALL=1; shift ;;
    --dry-run)    DRY=1; shift ;;
    -h|--help)    usage; exit 0 ;;
    *) usage >&2; die "无法识别的参数：$1" ;;
  esac
done

case "$ENGINE" in
  tinyproxy|3proxy) ;;
  *) die "--engine 只能是 tinyproxy 或 3proxy（收到：$ENGINE）" ;;
esac

is_port() {
  case "$1" in
    ''|*[!0-9]*) return 1 ;;
  esac
  [ "$1" -ge 1 ] && [ "$1" -le 65535 ]
}
is_port "$HTTP_PORT" || die "--port 不是合法端口：$HTTP_PORT"
if [ "$ENGINE" = 3proxy ]; then
  is_port "$SOCKS_PORT" || die "--socks-port 不是合法端口：$SOCKS_PORT"
  if [ "$SOCKS_PORT" = "$HTTP_PORT" ]; then die "--port 与 --socks-port 不能相同"; fi
fi
if [ "$TLS" = 1 ]; then
  is_port "$TLS_PORT" || die "--tls-port 不是合法端口：$TLS_PORT"
  if [ "$TLS_PORT" = "$HTTP_PORT" ]; then die "--tls-port 不能与 --port 相同"; fi
fi
case "$PROXY_USER" in
  ''|*[[:space:]]*) die "--user 不能为空或含空格" ;;
esac

base_unit() {
  if [ "$ENGINE" = tinyproxy ]; then say tinyproxy; else say ofm-3proxy; fi
}

# ------------------------------------------------------------ 基础环境 --
if [ "$DRY" != 1 ]; then
  [ "$(id -u)" = 0 ] || die '需要 root（装包、写 /etc、起 systemd 都要 root）。请用 sudo bash deploy-proxy.sh 重跑。'
  [ "$(uname -s)" = Linux ] || die "本脚本只在 Linux 上运行（当前系统：$(uname -s)）"
fi

PKG=''
detect_pkg_mgr() {
  if   have apt-get; then PKG=apt
  elif have dnf;     then PKG=dnf
  elif have yum;     then PKG=yum
  elif have apk;     then PKG=apk
  elif have zypper;  then PKG=zypper
  else die '没有找到 apt/dnf/yum/apk/zypper，无法自动装包'
  fi
  ok "包管理器：$PKG"
}

install_pkg() {
  local pkg=$1
  case "$PKG" in
    apt)    run env DEBIAN_FRONTEND=noninteractive apt-get update -qq
            run env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "$pkg" ;;
    dnf)    run dnf install -y "$pkg" ;;
    yum)    run yum install -y "$pkg" ;;
    apk)    run apk add --no-cache "$pkg" ;;
    zypper) run zypper --non-interactive install -y "$pkg" ;;
  esac
}

pkg_installed() {
  case "$PKG" in
    apt)    have dpkg-query && dpkg-query -W -f='${Status}' "$1" 2>/dev/null | grep -q 'ok installed' ;;
    dnf|yum|zypper) have rpm && rpm -q "$1" >/dev/null 2>&1 ;;
    apk)    apk info -e "$1" >/dev/null 2>&1 ;;
    *)      return 1 ;;
  esac
}

has_systemd() { have systemctl && [ -d /run/systemd/system ]; }

# ------------------------------------------------------ 凭据生成与校验 --
gen_pass() {
  if have openssl; then
    openssl rand -hex 8
  else
    od -An -tx1 -N8 /dev/urandom | tr -d ' \n'
  fi
}

pass_chars_ok() {
  case "$1" in
    *[![:alnum:]._-]*) return 1 ;;
  esac
  return 0
}

reuse_password() {
  # 复用已有配置里的凭据，避免把插件里已经保存的密码顶掉
  local found=''
  if [ "$ENGINE" = tinyproxy ] && [ -r "$CONF_TP" ]; then
    found=$(sed -n 's/^[[:space:]]*BasicAuth[[:space:]]\+\([^[:space:]]\+\)[[:space:]]\+\([^[:space:]]\+\).*/\1|\2/p' "$CONF_TP" | head -n1) || true
  elif [ "$ENGINE" = 3proxy ] && [ -r "$CONF_3P" ]; then
    found=$(sed -n 's/^[[:space:]]*users[[:space:]]\+\([A-Za-z0-9_.-]\+\):CL\+\:\([^[:space:]]\+\).*/\1|\2/p' "$CONF_3P" | head -n1) || true
  fi
  if [ -n "$found" ]; then
    PROXY_USER=${found%%|*}
    PROXY_PASS=${found##*|}
    ok "复用已有凭据，用户名 $PROXY_USER"
  fi
}

prepare_credentials() {
  if [ -z "$PROXY_PASS" ]; then
    reuse_password
  fi
  if [ -z "$PROXY_PASS" ]; then
    PROXY_PASS=$(gen_pass)
    ok "已生成随机密码"
  fi
  if ! pass_chars_ok "$PROXY_PASS"; then
    die "密码里出现了非法字符。tinyproxy 的 BasicAuth 解析器只接受 a-z0-9._（源码 conf-tokens.c 里的 ALNUM 宏），3proxy 也不能带空白、引号或 \$。请换一个，例如：--pass a1b2c3d4e5f6g7h8"
  fi
  if [ "${#PROXY_PASS}" -lt 8 ]; then
    die "密码太短（至少 8 位）。当前 ${#PROXY_PASS} 位。"
  fi
}

# ---------------------------------------------------------------- 卸载 --
do_uninstall() {
  head2 '卸载'
  if has_systemd; then
    if [ "$ENGINE" = tinyproxy ]; then
      run systemctl disable --now tinyproxy || true
      run rm -f "$UNIT_TP"
    else
      run systemctl disable --now ofm-3proxy || true
      run rm -f "$UNIT_3P"
    fi
    if [ -f "$STUN_UNIT" ]; then
      run systemctl disable --now ofm-proxy-tls || true
      run rm -f "$STUN_UNIT" "$STUN_CONF"
    fi
    run systemctl daemon-reload || true
  else
    warn '未检测到 systemd，请自行 pkill 掉 tinyproxy / 3proxy / stunnel'
  fi
  if [ "$ENGINE" = tinyproxy ]; then
    run rm -f "$CONF_TP"
  else
    run rm -f "$CONF_3P"
  fi
  run rm -f /etc/stunnel/ofm-proxy.key /etc/stunnel/ofm-proxy.crt
  run rm -f "$CRED_FILE"
  say ''
  say '已删除本脚本写入的配置、单元与凭据文件。'
  say '软件包本身没卸：需要的话手动 apt remove tinyproxy 或 dnf remove tinyproxy。'
  exit 0
}

# ------------------------------------------------------------ 自检工具 --
detect_public_ip() {
  local ip=''
  if have curl; then
    ip=$(curl -fsS --max-time 10 https://ipinfo.io/json 2>/dev/null \
         | sed -n 's/.*"ip"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)
    if [ -z "$ip" ]; then
      ip=$(curl -fsS --max-time 10 https://api.ipify.org 2>/dev/null | tr -d '[:space:]')
    fi
  fi
  if [ -z "$ip" ] && have ip; then
    ip=$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.*src \([0-9.]*\).*/\1/p' | head -n1)
  fi
  # 只接受长得像 IP 的结果，避免把别的输出当成地址
  if [ -n "$ip" ]; then
    case "$ip" in
      *[!0-9A-Fa-f:.]*) ip='' ;;
    esac
    case "$ip" in
      *:*) : ;;                 # IPv6
      *.*) : ;;                 # IPv4
      *) ip='' ;;
    esac
  fi
  if [ -z "$ip" ] && have hostname; then
    ip=$(hostname -I 2>/dev/null | awk '{print $1}')
    case "$ip" in
      *[!0-9A-Fa-f:.]*) ip='' ;;
    esac
  fi
  printf '%s' "${ip:-}"
}

# IPv6 写进 URL 必须加方括号
bracket_ip() {
  case "$1" in
    *:*) printf '[%s]' "$1" ;;
    *)   printf '%s' "$1" ;;
  esac
}

# $1 代理 URL，$2 标签，$3 额外的 curl 参数
self_test_http() {
  local proxy_url=$1 label=$2 extra=${3:-} out
  if ! have curl; then
    warn '没有 curl，跳过自检'
    return 0
  fi
  printf '  %s ... ' "$label"
  if out=$(curl -fsS --max-time 25 $extra -x "$proxy_url" -o /dev/null -w '%{http_code}' \
           https://opencode.ai/ 2>&1); then
    printf '%s[OK] HTTP %s%s\n' "$C_OK" "$out" "$C_OFF"
    return 0
  fi
  printf '%s[X] %s%s\n' "$C_ERR" "$(printf '%s' "$out" | tr '\n' ' ' | cut -c1-200)" "$C_OFF"
  return 1
}

self_test_socks5() {
  printf '  SOCKS5 代理 ... '
  if curl -fsS --max-time 25 --socks5-hostname "127.0.0.1:$SOCKS_PORT" \
       --proxy-user "$PROXY_USER:$PROXY_PASS" -o /dev/null -w '%{http_code}' \
       https://opencode.ai/ >/dev/null 2>&1; then
    printf '%s[OK]%s\n' "$C_OK" "$C_OFF"
  else
    printf '%s[X]%s\n' "$C_ERR" "$C_OFF"
    FAIL=1
  fi
}

start_unit() {
  local unit=$1
  if ! has_systemd; then
    warn "没有 systemd，无法托管 $unit。请自行用 nohup 启动对应程序，日志会打到 stdout。"
    return 0
  fi
  if [ "$DRY" = 1 ]; then
    printf '%s+ systemctl daemon-reload%s\n' "$C_HEAD" "$C_OFF"
    printf '%s+ systemctl enable %s%s\n' "$C_HEAD" "$unit" "$C_OFF"
    printf '%s+ systemctl restart %s%s\n' "$C_HEAD" "$unit" "$C_OFF"
    return 0
  fi
  run systemctl daemon-reload
  run systemctl enable "$unit"
  run systemctl restart "$unit"
  # 有些发行版的 tinyproxy/3proxy 起来要一会儿，轮询几次再判定失败
  local n waited=0
  for n in 1 2 3 4 5 6 7 8 9 10; do
    if systemctl is-active --quiet "$unit"; then
      waited=$n
      break
    fi
    sleep 1
  done
  if [ "$waited" -gt 0 ]; then
    ok "$unit 运行中"
  else
    systemctl status "$unit" --no-pager -l || true
    die "$unit 没能启动，看上面的日志"
  fi
}

# ============================================================ tinyproxy --
deploy_tinyproxy() {
  head2 '1/4 安装 tinyproxy'
  if have tinyproxy; then
    ok "已安装：$(command -v tinyproxy)"
  else
    install_pkg tinyproxy
    have tinyproxy || die 'tinyproxy 安装后仍找不到可执行文件'
    ok "已安装：$(command -v tinyproxy)"
  fi

  head2 "2/4 写入配置 $CONF_TP"
  local group=nogroup bin
  if ! getent group nogroup >/dev/null 2>&1; then group=nobody; fi
  bin=$(command -v tinyproxy)
  [ "$DRY" != 1 ] && [ -f "$CONF_TP" ] && cp -a "$CONF_TP" "$CONF_TP.bak" && say "  已备份原配置到 $CONF_TP.bak"

  write_file "$CONF_TP" <<EOF
# 由 deploy-proxy.sh 生成于 $(date -u '+%Y-%m-%dT%H:%M:%SZ')
# 供 dsh-our-free-model 的「代理出口」使用。改完请 systemctl restart tinyproxy
User nobody
Group $group
Port $HTTP_PORT
Listen $LISTEN
Timeout 600
LogLevel Info
LogFile /var/log/tinyproxy/tinyproxy.log
MaxClients 100
ViaProxyName "tinyproxy"
DisableViaHeader Yes
# 访问控制：只要写了 ACL，未命中任何条目就默认拒绝，
# 所以这里必须显式放行来源网段。ALLOW_CIDR 可以改窄。
Allow $ALLOW_CIDR
# 用户名/密码认证。tinyproxy 的 BasicAuth 只接受 a-z0-9._ 组成的用户名和密码
BasicAuth $PROXY_USER $PROXY_PASS
EOF

  if [ "$DRY" = 1 ]; then
    printf '%s+ install -d -o nobody -g %s /var/log/tinyproxy%s\n' "$C_HEAD" "$group" "$C_OFF"
  else
    install -d -o nobody -g "$group" /var/log/tinyproxy
    ok '日志目录已准备好'
  fi

  head2 "3/4 写入 systemd 单元 $UNIT_TP"
  write_file "$UNIT_TP" <<EOF
[Unit]
Description=tinyproxy (deployed for dsh-our-free-model)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$bin -d -c $CONF_TP
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
  start_unit tinyproxy
}

# ============================================================== 3proxy --
deploy_3proxy() {
  head2 '1/4 安装 3proxy'
  if have 3proxy; then
    ok "已安装：$(command -v 3proxy)"
  else
    local ok_installed=0
    if pkg_installed 3proxy || install_pkg 3proxy; then
      have 3proxy && ok_installed=1
    fi
    if [ "$ok_installed" != 1 ]; then
      warn '软件源里没有 3proxy，改为源码编译（需要 gcc/make 和外网）'
      install_pkg build-essential
      local tmp
      tmp=$(mktemp -d)
      run curl -fsSL -o "$tmp/3proxy.tar.gz" https://github.com/3proxy/3proxy/archive/refs/tags/0.9.1.tar.gz
      run tar -xzf "$tmp/3proxy.tar.gz" -C "$tmp"
      run make -C "$tmp/3proxy-0.9.1" -f Makefile.Linux
      run make -C "$tmp/3proxy-0.9.1" -f Makefile.Linux install
      run rm -rf "$tmp"
      have 3proxy || die '3proxy 编译安装后仍找不到可执行文件'
    fi
    ok "已安装：$(command -v 3proxy)"
  fi

  head2 "2/4 写入配置 $CONF_3P"
  local bin
  bin=$(command -v 3proxy)
  [ "$DRY" != 1 ] && [ -f "$CONF_3P" ] && cp -a "$CONF_3P" "$CONF_3P.bak" && say "  已备份原配置到 $CONF_3P.bak"

  write_file "$CONF_3P" <<EOF
# 由 deploy-proxy.sh 生成于 $(date -u '+%Y-%m-%dT%H:%M:%SZ')
# 供 dsh-our-free-model 的「代理出口」使用。改完请 systemctl restart ofm-3proxy
nserver 1.1.1.1
nserver 8.8.8.8
nscache 65536
timeouts 1 5 30 60 180 1800 15 60
# users <名字>:CL:<明文密码>，CL = cleartext（没有用 crypt，所以不需要 -n 开关）
users $PROXY_USER:CL:$PROXY_PASS
maxconn 200

# 访问列表：列表非空时未命中任何条目即拒绝。
# 末尾的 deny * 很关键，否则 HTTP 代理会反过来向客户端索要密码。
auth strong
flush
allow $PROXY_USER
deny *
proxy -p$HTTP_PORT

flush
allow $PROXY_USER
deny *
socks -p$SOCKS_PORT
EOF

  head2 "3/4 写入 systemd 单元 $UNIT_3P"
  write_file "$UNIT_3P" <<EOF
[Unit]
Description=3proxy (deployed for dsh-our-free-model)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$bin $CONF_3P
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
  start_unit ofm-3proxy
}

# ================================================= TLS 包装（stunnel） --
deploy_tls() {
  head2 'TLS 包装（可选）'
  local bin=''
  if have stunnel;   then bin=$(command -v stunnel)
  elif have stunnel5; then bin=$(command -v stunnel5)
  elif have stunnel4; then bin=$(command -v stunnel4)
  else
    case "$PKG" in
      apt) install_pkg stunnel5 || install_pkg stunnel4 || install_pkg stunnel ;;
      *)   install_pkg stunnel ;;
    esac
    if   have stunnel;   then bin=$(command -v stunnel)
    elif have stunnel5; then bin=$(command -v stunnel5)
    elif have stunnel4; then bin=$(command -v stunnel4)
    fi
  fi
  [ -n "$bin" ] || die 'stunnel 安装后仍找不到可执行文件'
  ok "stunnel：$bin"

  say '生成自签证书：插件对「代理这一跳」不做证书校验，自签即可；到目标站的 TLS 仍然严格校验。'
  run openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
    -subj '/CN=ofm-proxy' \
    -keyout /etc/stunnel/ofm-proxy.key \
    -out /etc/stunnel/ofm-proxy.crt
  run chmod 600 /etc/stunnel/ofm-proxy.key

  local base; base=$(base_unit)
  write_file "$STUN_CONF" <<EOF
# 由 deploy-proxy.sh 生成：把明文 HTTP 代理包一层 TLS
# 插件里填 https://$PROXY_USER@<服务器IP>:$TLS_PORT
foreground = yes
socket = l:TCP_NODELAY=1
socket = r:TCP_NODELAY=1

[ofm-proxy]
accept = $TLS_PORT
connect = 127.0.0.1:$HTTP_PORT
cert = /etc/stunnel/ofm-proxy.crt
key = /etc/stunnel/ofm-proxy.key
EOF

  write_file "$STUN_UNIT" <<EOF
[Unit]
Description=TLS wrapper for the dsh-our-free-model proxy
After=network-online.target $base.service
Wants=$base.service

[Service]
Type=simple
ExecStart=$bin $STUN_CONF
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
  start_unit ofm-proxy-tls
}

# ============================================================== 主流程 --
say 'dsh-our-free-model 代理部署脚本'
say "引擎 $ENGINE    监听 $LISTEN:$HTTP_PORT"
if [ "$ENGINE" = 3proxy ]; then say "SOCKS5 $LISTEN:$SOCKS_PORT"; fi
if [ "$TLS" = 1 ]; then say "TLS 包装 $LISTEN:$TLS_PORT"; fi

if [ "$UNINSTALL" = 1 ]; then
  do_uninstall
fi

detect_pkg_mgr
prepare_credentials

case "$ENGINE" in
  tinyproxy) deploy_tinyproxy ;;
  3proxy)    deploy_3proxy ;;
esac

if [ "$TLS" = 1 ]; then
  deploy_tls
fi

# ---------------------------------------------------------- 防火墙提示 --
head2 '防火墙与安全组'
if have ufw && ufw status 2>/dev/null | grep -q 'Status: active'; then
  run ufw allow "$HTTP_PORT"/tcp
  if [ "$ENGINE" = 3proxy ]; then run ufw allow "$SOCKS_PORT"/tcp; fi
  if [ "$TLS" = 1 ]; then run ufw allow "$TLS_PORT"/tcp; fi
  ok '已尝试用 ufw 放行端口'
else
  say '  · ufw 未启用。若服务器用 firewalld/iptables，请手动放行对应端口。'
fi
if have firewall-cmd && firewall-cmd --state >/dev/null 2>&1; then
  run firewall-cmd --permanent --add-port="$HTTP_PORT"/tcp
  if [ "$ENGINE" = 3proxy ]; then run firewall-cmd --permanent --add-port="$SOCKS_PORT"/tcp; fi
  if [ "$TLS" = 1 ]; then run firewall-cmd --permanent --add-port="$TLS_PORT"/tcp; fi
  run firewall-cmd --reload
fi
say '  · 云厂商安全组也要放行同样的端口，否则从外面连不上。'

# --------------------------------------------------------------- 自检 --
if [ "$DRY" = 1 ]; then
  head2 '自检（dry-run 跳过）'
  say '以上都是预演，系统没有被改动。去掉 --dry-run 就会真正部署。'
else
  head2 '自检'
  self_test_http "http://$PROXY_USER:$PROXY_PASS@127.0.0.1:$HTTP_PORT" 'HTTP 代理 → opencode.ai' || FAIL=1
  if [ "$ENGINE" = 3proxy ]; then
    self_test_socks5
  fi
  if [ "$TLS" = 1 ]; then
    # 自签证书，curl 需要 --proxy-insecure；插件本身对代理这一跳不校验证书
    self_test_http "https://$PROXY_USER:$PROXY_PASS@127.0.0.1:$TLS_PORT" \
      'TLS 包装代理 → opencode.ai' '--proxy-insecure' || FAIL=1
  fi
  if has_systemd; then
    say ''
    say "排错：journalctl -u $(base_unit) -n 50 --no-pager"
    say "      tail -f /var/log/tinyproxy/tinyproxy.log   # tinyproxy 引擎"
  fi
fi

# --------------------------------------------------------------- 凭据落盘 --
if [ "$DRY" != 1 ]; then
  umask 077
  {
    printf '# dsh-our-free-model 代理凭据，生成于 %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    printf 'PROXY_USER=%s\n' "$PROXY_USER"
    printf 'PROXY_PASS=%s\n' "$PROXY_PASS"
  } > "$CRED_FILE"
  ok "凭据已写入 $CRED_FILE（权限 600）"
fi

# --------------------------------------------------------------- 总结 --
IP=$(detect_public_ip)
if [ -z "$IP" ]; then IP='<你的服务器公网IP>'; fi
HOST=$(bracket_ip "$IP")

head2 '在插件里这样填（DSH 设置 → Our Free Model → 代理出口）'
say ''
say '  启用         打开'
say "  代理地址     http://$PROXY_USER@$HOST:$HTTP_PORT        <- 不要把密码写进地址"
say "  密码         $PROXY_PASS"
if [ "$ENGINE" = 3proxy ]; then
  say "  SOCKS5 备选  socks5://$PROXY_USER@$HOST:$SOCKS_PORT"
fi
if [ "$TLS" = 1 ]; then
  say "  TLS 备选     https://$PROXY_USER@$HOST:$TLS_PORT"
fi
say '  直连例外     localhost, 127.0.0.1, ::1                 <- 保持默认即可'
say ''
say '填完点「应用」：插件会先测一次连通性，再自动重新探测地区可用性。'
say '预期结果：'
say '  · 设置页「当前出口」变成上面这台服务器的 IP 和国家'
say '  · 之前因为地区被限制的 muse-spark-* 模型自动回到普通分组'
say '  · 聊天能正常流式输出'
say ''
say "服务器自检到的出口 IP：$IP"
if [ "$DRY" = 1 ]; then
  say ''
  say '（dry-run 预演结束，没有改动系统）'
elif [ "$FAIL" = 1 ]; then
  say ''
  warn '自检没过。先看上面的报错：最常见原因是云安全组没放行端口，或者服务器自己出不了网。'
  warn '想先在本机确认代理是否工作，可以跑：'
  warn "  curl -x http://$PROXY_USER:$PROXY_PASS@127.0.0.1:$HTTP_PORT https://opencode.ai/ -o /dev/null -w '%{http_code}\\n'"
fi
