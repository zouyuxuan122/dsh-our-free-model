# 发布与公告（仓库主人）

这份文档面向维护者，不属于发布内容：`package.json` 的 `files` 不含 `docs/`，所以它
不会被安装到用户机器上，也不出现在 [`README.md`](../README.md) 里——README 只讲使用者
需要知道的事。

一切通过插件仓库根目录下的 `feed/` 目录完成，**推送即发布**。

## 推送公告

编辑 [`feed/announcements.json`](../feed/announcements.json)，往 `announcements`
数组加一条：

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

## 发布新版本

改完代码后——

```bash
# 1. 修改 package.json 的 version 与 feed/announcements.json（版本说明）
# 2. 重新生成清单（把每个发布文件的字节数与 SHA-256 写进 feed/manifest.json）
node scripts/build-manifest.mjs
# 3. 确认清单与实物一致（不一致就非零退出；已接进 npm test）
node scripts/build-manifest.mjs --check
# 4. 提交并推送，再打 tag 并创建 Release
git tag -a v1.2.3 -m "…" && git push origin v1.2.3
gh release create v1.2.3 --title "…" --notes-file …
```

第 2 步不是可选项：清单是发布者对每个文件的**字节数与 SHA-256 的承诺**，改了发布文
件却没重跑，客户端就会下到新文件、拿旧哈希去校验，校验机制会（正确地）拒绝安装——于
是这一版的一键升级对所有旧版本用户都失败。`--check` 就是让这种事在提交前失败。

摘要按 **LF 归一化后的字节**计算，不是工作区字节：`.gitattributes` 是
`* text=auto eol=lf`，用户下载到的是 blob，而编辑器可以把工作区改成 CRLF 且
`git status` 依然干净。`scripts/release-e2e.mjs` 会把全部发布文件改写成 CRLF 再跑一次
`--check`，旧算法在这一步直接失败。

已安装的插件会按 `updateCheckHours`（默认 6 小时）自动发现新版本并推送通知；
用户确认后下载、校验、备份、替换、热重载全部在应用内完成。清单会校验每个文件的
SHA-256，并在安装前重新拉取一次，避免用陈旧清单校验新文件。

## 关于源顺序与网络现实

插件按 `jsDelivr → raw.githubusercontent(main) → (master)` 的顺序拉取，全部失败时降级
到上一次的缓存并如实标注错误。jsDelivr 优先是因为 raw.githubusercontent 在部分网络
（实测本机 CN 出口 + Watt Toolkit 类加速工具）会被本地反代劫持——git push 正常但 raw
对新文件返回假 404；jsDelivr 的边缘节点直连可达，请求自动附带分钟级 cache-buster，
不会被 CDN 长缓存拖住新鲜度。

两个发布者须知：

1. **jsDelivr 对新仓库的首次收录有延迟**（几分钟到数小时不等，创建 Release 会触发
   收录）；收录完成前，新推送的公告/更新会暂时拉取不到（客户端显示缓存并标注
   源不可达）。收录只发生一次，之后 `@main` 的更新经由 cache-buster 准实时可达。
2. 可用 `https://purge.jsdelivr.net/gh/<仓库>@main/<路径>` 手动刷新 jsDelivr 缓存。
   用 `feedUrl` 设置可把源指向任意 URL（含 `{repo}` 占位符），本地测试时指向一个
   静态文件服务器即可。

---

# Releasing and announcements (repository owner)

This document is for maintainers and is not part of the release: `package.json`'s
`files` does not include `docs/`, so it never reaches an installed copy and never
appears in [`README_EN.md`](../README_EN.md). Everything lives in the repository's
`feed/` directory — **pushing is publishing**.

## Push an announcement

Edit [`feed/announcements.json`](../feed/announcements.json) and add one entry:

```json
{
  "id": "2026-10-01-something",        // unique; a seen id never re-alerts
  "title": "One-line title",
  "level": "info",                     // info | update | warn | urgent
  "pinned": false,                     // optional
  "createdAt": "2026-10-01T00:00:00Z",
  "expiresAt": "2026-10-15T00:00:00Z", // optional
  "link": { "url": "https://…", "label": "Read more" },
  "html": "<p>Body with <strong>allowlisted HTML</strong></p>"
}
```

`urgent` opens a full-screen modal. Bodies are rendered by a client-side allowlist
parser — scripts, event handlers, `javascript:` URLs, iframes and friends are all
dropped (see `scripts/sanitize-test.mjs`), so a compromised repository does not
become code execution.

## Release a new version

```bash
# 1. bump `version` in package.json, and the release note in feed/announcements.json
# 2. regenerate the manifest (size + SHA-256 of every published file)
node scripts/build-manifest.mjs
# 3. confirm the manifest matches the tree (non-zero exit otherwise; part of npm test)
node scripts/build-manifest.mjs --check
# 4. commit and push, then tag and create the release
git tag -a v1.2.3 -m "…" && git push origin v1.2.3
gh release create v1.2.3 --title "…" --notes-file …
```

Step 2 is not optional. The manifest is the publisher's promise about every file's
byte count and SHA-256: edit a published file and skip the rebuild, and a client
downloads the *new* file while verifying it against the *old* hash — verification
then correctly refuses to install, and the one-click upgrade is broken for every
user on an older version. `--check` is what makes that fail before a commit
instead of in the field.

Digests are computed over **LF-normalised** bytes, not working-tree bytes:
`.gitattributes` says `* text=auto eol=lf`, so users download the blob while an
editor can leave the tree CRLF with `git status` clean. `scripts/release-e2e.mjs`
rewrites every published file to CRLF and re-runs `--check`; the old builder fails
there.

Installed plugins discover the new release automatically (every
`updateCheckHours`, 6 by default) and notify the user; the upgrade itself runs
in-app, and the manifest is re-fetched right before installing so a document
fetched hours earlier cannot be used to vouch for bytes that changed since.

## Source order and network reality

Sources are tried `jsDelivr → raw.githubusercontent(main) → (master)`, falling
back to the last cached copy with the error reported honestly when all fail.
jsDelivr leads because raw.githubusercontent is hijacked by a local reverse proxy
on some networks (measured: a CN egress with a Watt Toolkit-style accelerator) —
`git push` works while raw answers a false 404 for a new file. jsDelivr's edge is
reachable directly and every request carries a minute-resolution cache-buster, so
CDN long-caching cannot hold freshness back.

Two things a publisher should know:

1. **jsDelivr's first index of a new repository lags** (minutes to hours; creating
   a Release triggers it). Until it lands, freshly pushed announcements/updates
   are briefly unfetchable (the client shows its cache and names the source as
   unreachable). Indexing happens once; after that `@main` updates are
   near-real-time through the cache-buster.
2. `https://purge.jsdelivr.net/gh/<repo>@main/<path>` purges the jsDelivr cache by
   hand. The `feedUrl` setting can point the source at any URL (with a `{repo}`
   placeholder) — point it at a static file server for local testing.
