<p align="center">
  <img src="icon.svg" alt="Our Free Model — free model provider plugin for DeepSeek Harness" width="120">
</p>

<p align="center"><a href="README.md">简体中文</a> | <strong>English</strong></p>

<p align="center">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-263146?style=flat-square">
  <img alt="zero dependencies" src="https://img.shields.io/badge/dependencies-zero-4b6fff?style=flat-square">
  <img alt="build step" src="https://img.shields.io/badge/build%20step-none-7da1de?style=flat-square">
  <img alt="dsh kernels" src="https://img.shields.io/badge/dsh-0.1.5--0.1.7-2f6f4f?style=flat-square">
  <img alt="status" src="https://img.shields.io/badge/status-beta-f0a441?style=flat-square">
</p>

# dsh-our-free-model

> All you do is install this plugin in dsh — no login, no sign-up, no API key, no other
> step of any kind. The frontier models are simply there, Muse Spark 1.3 and MiMo V2.6
> among them. Completely free, with no usage cap.
>
> 你只需在 dsh 里装上这个插件，无需登录、注册、填 API Key 或任何其它操作，就能用上包括
> Muse Spark 1.3、MiMo V2.6 在内的前沿模型——完全免费，不限量。
>
> The roster follows upstream, availability is measured from **your own** network
> egress, the thinking-effort control sends a real budget instead of a prompt hint, and
> a local OpenAI-compatible forward port comes included.
>
> It mounts as a pure plugin: no core changes, no build step, zero dependencies.

---

## Highlights

- **Nothing to configure** — install, restart, pick a model. No account, no key, no quota dashboard to register on.
- **A roster that tracks upstream** — model set, context length and capabilities are re-fetched on every refresh rather than frozen into the plugin.
- **Every model stays reachable** — models a probe could not reach no longer vanish from the picker; only region-gated ones move to their own `region-limited` group.
- **Announcement center with live push** — the repository owner edits one JSON file and pushes; every installation receives it within one poll cycle. Bodies are HTML rendered through a strict allowlist; `urgent` items open a full-screen modal; optional OS-level notifications.
- **In-app upgrades** — one click in the settings page: download → SHA-256 verification → backup → atomic replace → read-back verification → hot reload, with automatic rollback if any step fails.
- **Hot reload** — upgrades and code changes take effect immediately, no app restart; also available as a manual button and an optional file watcher.
- **Region-aware, per egress** — models gated by geography are separated into their own `region-limited` group instead of failing mid-turn. Switch your network exit and the next probe reclassifies them automatically.
- **Thinking effort that actually binds** — `Light / Balanced / Deep` map to output-token budgets of 2 048 / 8 192 / the model's full capacity, and are recorded per call. This is not a `reasoning_effort` string thrown at an endpoint that ignores it (see [Why a budget](#why-a-budget-and-not-reasoning_effort)).
- **Usage dashboard, local only** — token heatmap, cumulative curve by total or per model, output speed and time-to-first-token sampled per call. Nothing is uploaded.
- **OpenAI-compatible forward port** — expose these models to any other local tool through a base URL plus a generated API key.
- **Clean names in the UI** — no mojibake, no upstream vendor strings leaking into your model picker.

## What you get

**Composer model picker**

| Group | Contents |
| --- | --- |
| `Our Free Model` | Models usable from your current network exit |
| `Our Free Model · region-limited` | Models the upstream refuses for this region, kept visible but separated |

**Settings page — `Settings → Our Free Model`**, six sections:

1. **Model roster** — per-model availability, vision vs text-only, context window, max output, measured time-to-first-token, and an on-demand single-call benchmark.
2. **Announcement center** — the owner-pushed feed: unread counter, urgency badges, mark-read (single/all), check-now button, OS-notification toggle. Bodies render HTML through the allowlist.
3. **Usage board** — headline counters, a 17-week token heatmap, a cumulative curve switchable between tokens and request counts and between total and any single model, speed sparklines, and a per-model table.
4. **Local forward** — enable/disable, bind host and port, copy base URL, show / copy / rotate the API key, and a ready-to-run `curl` example.
5. **Plugin settings** — master switch, whether region-limited models are exposed, probe interval, default output ceiling, plus the detected egress IP and country.
6. **Plugin upgrade** — installed/latest version, check for updates, one-click upgrade with progress and failure reasons, last-upgrade history, hot-reload button and file-watcher switch.

**First-run announcement** — a five-page walkthrough (preamble, model roster, how to use, what it does, news & upgrades) that acknowledges once and never reappears until the copy version is bumped.

## Install

### Command line (plain `dsh web`)

```bash
dsh plugin --profile web add /absolute/path/to/dsh-our-free-model
```

Restart the app once. `--profile` should name the profile you actually use.

### DSHEAC AIO / desktop builds — read this first

The desktop host runs a profile gate before it starts the web app. Its scanner
accepts **only** the symlinks dsh generates itself under
`.dsh-module-fallback`; **any other symlink or directory junction anywhere in the
profile makes the app refuse to boot**, reporting:

```text
PROFILE_UPGRADE_REQUIRED: offline dependency migration is not yet available
```

So on desktop builds: **do not install with a `link:` dependency and do not
create a junction.** Use the in-app plugin manager, or place a real directory.

To install manually as a real directory, in `<DSH_HOME>/profiles/<profile>/`:

1. Copy the published files into `node_modules/dsh-our-free-model/`
   (`index.js`, `client.js`, `src/`, `locale/`, `icon.svg`, `cordis.patch.yml`, `package.json`)
2. Add `"dsh-our-free-model": "1.1.2"` to `dependencies` — a version spec, not `link:`
3. Append `"dsh-our-free-model"` to `dsh.profile.bundles`

> Do **not** also add an entry to `cordis.patch.yml`. A bundle referenced from
> `dsh.profile.bundles` already applies its own patch layer, and registering it
> twice fails with `duplicate loader entry id: our-free-model`.

### Verify before launching the desktop app

Run the desktop host's own gate against your profile instead of blind-retrying:

```bash
node -e "
const g = require('<APP_ROOT>/sidecar/dist/lib/profile-upgrade.js');
const app = '<APP_ROOT>', profile = '<DSH_HOME>/profiles/<profile>';
console.log(g.planProfileUpgrade(app, profile));
g.assertProfileStartup(app, profile);
console.log('startup gate: PASS');
"
```

Expect `status: 'compatible'`, an empty `mismatches` array, then `PASS`.
To check bundle composition only, without booting:

```bash
DSH_HOME=<DSH_HOME> dsh --profile <profile> --dump-config | grep our-free-model
```

You should see exactly **one** `id: our-free-model` entry.

## Usage

**Pick a model.** Open the model selector in the composer and choose anything
under `Our Free Model`. The selection is durable per session.

**Change thinking depth.** The same menu exposes `Effort` with `Light`,
`Balanced` and `Deep`. Higher levels spend more of the output budget on
deliberation; the ceiling is enforced on the request, so the difference is
measurable rather than cosmetic.

**Serve other local tools.** `Settings → Our Free Model → Local forward`, enable
it, then copy the base URL and generate a key. Supported routes:

```text
GET  /v1/models
POST /v1/chat/completions     streaming and non-streaming
POST /v1/responses
```

**Re-check geography.** `重新探测可用性` (Reprobe) re-runs availability against
your current exit. Toggling a VPN and re-probing moves region-gated models
between the two groups on its own.

**Receive announcements.** Everything is automatic: after the owner pushes, a
running installation picks the item up within one poll cycle (30 minutes by
default, or immediately via *Check for new announcements*). Regular items raise
a toast, `urgent` items open a full-screen modal, and both land in the
announcement center with an unread marker. Enable *OS notifications* there to
also get system-level toasts.

**Upgrade the plugin.** `Settings → Our Free Model → Plugin upgrade` →
*Check for updates* → *Upgrade now*. The whole flow runs inside the app
(download → verify → backup → replace → hot reload); no reinstall, no restart.
A failed upgrade restores the previous version and reports why.

## For the repository owner: pushing announcements and releases

Everything lives in the repository's `feed/` directory — pushing is publishing:

**Push an announcement** by editing [`feed/announcements.json`](feed/announcements.json):

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

`urgent` opens a full-screen modal. Bodies are rendered by a client-side
allowlist parser — scripts, event handlers, `javascript:` URLs, iframes and
friends are all dropped (see `scripts/sanitize-test.mjs`), so a compromised
repository does not become code execution.

**Release a new version**:

```bash
# 1. bump `version` in package.json
# 2. regenerate the manifest (size + SHA-256 of every published file)
node scripts/build-manifest.mjs
# 3. commit and push
```

Installed plugins discover the new release automatically (every
`updateCheckHours`, 6 by default) and notify the user; the upgrade itself runs
in-app. The manifest re-verifies every file's SHA-256 and is re-fetched right
before installing, so a stale manifest can never vouch for different bytes.

## How it works

```text
index.js      host half: adapter registration, catalog + availability probes,
              settings/stats stores, webServer API routes, forward lifecycle,
              announcement / upgrade / hot-reload wiring
src/adapter.js  structural LlmAdapter: providerInfo, listModels, resolveModel,
                prepareCall, stream, providerRetryPolicy
src/upstream.js gateway identity: credentials, session/request id minting,
                tool fingerprint, endpoint selection per wire
src/stream.js   three wire decoders (chat / messages / responses) normalised to
                harness StreamChunks, with disjoint token accounting
src/messages.js harness messages -> wire shapes, plus tool-pairing repair
src/effort.js   effort level -> output budget
src/forward.js  standalone OpenAI-compatible listener
src/trust.js    request trust fence for the plugin's routes (connection bridge
                + structural fallback)
src/push.js     SSE push hub: arrivals, update availability, upgrade done
src/feed.js     remote announcement feed: multi-source fetch, validation, cache,
                arrival detection
src/updater.js  in-app upgrade: manifest validation, SHA-256 checks, backup,
                atomic replace, rollback
src/reload.js   self hot reload: mirrors the kernel HMR sequence (cache purge,
                re-import, re-register, rollback)
client.js       browser half: hand-written ModuleLoader bundle, no build step
```

Design decisions worth knowing:

- **One adapter, two provider routes.** The harness groups the model picker strictly by provider route, and the catalog wire has no group/tag/badge field. Publishing a second route is therefore the only way to render a separate `region-limited` heading — and because the client drops empty groups, the two collapse into one automatically once geography stops blocking.
- **Structural adapter, no `@deepseek-ai/dsh-llm` import.** The kernel never checks `instanceof`, so the adapter is duck-typed. This keeps the plugin from pinning itself to one kernel version and is what lets the same code run on both 0.1.5 and 0.1.7.
- **Own JSON store instead of the settings seam.** The settings registration API differs between kernels; a private JSON store under `DSH_HOME` behaves identically on both and keeps the forward key in a `0600` file that never enters any shared settings document.

### Why a budget, and not `reasoning_effort`

Passing a reasoning-effort string upstream was measured to be a no-op on this
lane: repeated samples at three different nominal effort levels produced
statistically indistinguishable reasoning tokens. Shipping a control that does
nothing is worse than shipping no control, so effort is implemented as a hard
output-token ceiling, which does bind — recorded reasoning tokens rise
monotonically with the level.

### Two kernel behaviours that cost real debugging time

Both are documented in [`docs/upstream-findings.md`](docs/upstream-findings.md);
they are recorded here because they will bite any provider plugin:

1. **`providerRetryPolicy()` is stored verbatim.** Neither kernel resolves it, and
   the backoff scheduler reads `initialDelayMs / maxDelayMs / jitterRatio` off the
   **top level**. Returning them nested under `backoff` yields `undefined * 2ⁿ =
   NaN`, and the durable session log rejects non-finite numbers — so a recoverable
   transient failure becomes an aborted turn. Return an already-resolved, flat policy.
2. **One interrupted tool call poisons the whole session.** A tool call with no
   matching result replays as `400 invalid_request_error`, after which *every*
   request in that session fails. The plugin repairs pairing before sending, on all
   three wires.

### Why the speed panel can say `—`

An early build published 2 941 tok/s for a lane really doing ~40. The gateway was
not at fault — a raw-read probe shows 64 frames spread over 5.6 s — but the
numerator and the denominator described different intervals: one call billed 422
output tokens of which 291 were reasoning that **never streamed a single frame**,
and the window began at the first visible token anyway. Dividing the whole
completion by the seconds the answer text took is not a decode rate.

So a rate is published only over a window that can carry it: `windowTokens()`
removes unstreamed reasoning tokens from the numerator, `decodeWindow()` rejects
windows too short to time and rates too fast to be real, and both the panel and
the per-model table sum tokens over sum seconds instead of averaging per-call
ratios — one 1 ms window was enough to move a 26-call average by three orders of
magnitude. A model whose answer lands in two frames therefore has no measurable
output speed, and says so.

## Verification

Tested on both kernels, on Windows, against the live upstream. Every v1.1.2
capability was **operated for real**, including click-through in a browser and
inside the DSHEAC AIO desktop window:

| Check | Result |
| --- | --- |
| `dsh` 0.1.7-rc.1 (source build) | Boots clean; picker shows both groups; multi-round tool calling completes |
| `dsh` 0.1.5-rc.2 (DSHEAC AIO 6.9.3 kernel) | Boots clean alongside the other installed third-party plugins |
| EAC startup gate | Run at install time **and after the in-app upgrade**: `compatible` / `PASS` |
| Model reachability | All 10 catalog models stay invocable (including probe-failed/unavailable ones); real chat, multi-round tools and vision input pass on both kernels |
| Real harness conversation | One real turn completed and answered in both dsh web and the AIO desktop window |
| Announcement feed | New items pushed on a local "repository server" arrived within one poll cycle on both surfaces |
| Announcement center UI | 4 items rendered (bold/code/links/lists), urgency badge, unread dots, mark-read single/all |
| Urgent announcement | An `urgent` push opened the full-screen modal; acknowledging persisted |
| Toast + OS notifications | Live toast on arrival; the desktop `window.Notification` channel exists (when the WebView2 permission policy denies the request, the UI says so) |
| In-app upgrade | 1.1.0 → 1.1.2 completed on both dsh web and AIO: 23 files downloaded, SHA-256 verified, backed up, replaced, hot-reloaded; `/meta` reported the new version immediately |
| Upgrade safety | A hash mismatch discards staging, leaves the installed package untouched and logs the failure; upgraded artifacts pass the EAC gate and a full restart |
| Hot reload | Button and API entry points; ESM cache purge + re-register + rollback sequence; `generation` increments, client notices once via localStorage |
| Client bundle hot swap | Replacing `client.js` reloaded the browser bundle automatically via the kernel's client-hmr (observed twice) |
| Trust fence | Non-loopback Host / cross-site `sec-fetch-site` / foreign `Origin` all 403; cookieless loopback requests 401 (same as the kernel's `/api`) |
| SSE push | `hello`/`announcements`/`update`/`upgraded` events verified; EventSource reconnects after a hot reload |
| Effort propagation | light/balanced/deep measured live: reasoning 2048 (budget-truncated) / 3386 / 3522, output rising monotonically |
| Region gating | Region-blocked model surfaces as `REGION_BLOCKED` and stays in its own group |
| Forward listener | `/v1/models`, streaming and non-streaming `/v1/chat/completions`, unauthenticated requests rejected `401` |
| UI strings | No mojibake; no upstream vendor name in any app-facing surface |

Not verified, so stated plainly: the **final OS-level notification rendering**
was not visually confirmed — the AIO build's WebView2 permission policy denies
`Notification.requestPermission()` (the plugin's Tauri notification channel is
present, the plain-browser path works, and the settings page says plainly that
permission was denied). The AIO guard also runs a report-only heuristic scan
that logs one finding for the `env`-adjacent-URL pattern in `src/upstream.js`;
it never touches files.

## Known limitations

- **"No usage cap" means no cap to buy.** There is no balance, no plan and no per-token billing; the lane is metered by session rate, though, and hammering it surfaces as `429`. The plugin marks the model *quota reached* rather than hiding it, and the next probe clears the state.
- **Some upstream models are slow.** `nemotron-3.5-lightning-free` measured over 30 s to first token in one run. That is upstream latency, and the dashboard reports it rather than hiding it.
- **Output speed is sometimes `—`.** A model that answers in one or two large frames, or whose thinking never streams, has no window worth dividing. The panel says so instead of publishing the model's thinking time as decoding speed.
- **Capabilities are what probes can confirm.** Anything the public listing and a live probe do not evidence is left unlabelled.
- **Source is plain JavaScript.** It has to be, to load as a local plugin. Anyone with the folder can read the gateway logic; treat that as an accepted property of this distribution form, not as something obfuscation would fix.
- **Desktop installs need a real directory**, for the reason given in [Install](#install).
- **Upgrade and hot-reload trust boundary**: the in-app upgrader trusts the plugin repository itself — whoever can push the repository can push code. That is the same trust model as installing a plugin update. File integrity is enforced by the SHA-256 manifest; content safety by the client-side allowlist renderer and the host's plugin isolation.
- **The AIO build's WebView2 permission policy may deny notification permission** (measured `denied` on this machine). The announcement center says so plainly; plain-browser access to dsh web is unaffected.
- **The plugin routes' auth depends on the composition**: with a connection service mounted (dsh web, the AIO desktop) it matches the kernel's `/api` (the app's own cookie/token); in minimal compositions without one, a structural fence applies (loopback + same-origin), and other local processes can still reach the routes — the same behaviour the kernel has in those compositions.

## Development

```bash
node scripts/client-lint.mjs        # browser half: copy/style key coverage, bundle executes
node scripts/sanitize-test.mjs      # announcement HTML allowlist renderer vs an XSS corpus
node scripts/trust-test.mjs         # request trust fence for the plugin's routes
node scripts/feed-test.mjs          # announcement feed: parsing, failover, cache, arrivals
node scripts/updater-test.mjs       # in-app upgrade: manifests, SHA-256, backup/rollback
node scripts/build-manifest.mjs     # release: regenerate feed/manifest.json
node scripts/retry-safety-test.mjs  # failures and retry policy are durable-log safe
node scripts/speed-stat-test.mjs    # no call can average its way into a fake tok/s
node scripts/host-selftest.mjs      # host half end to end against the live upstream
```

`scripts/probes/` holds the one-off evidence scripts behind the findings report —
capability matrix, region gate, the `reasoning_effort` no-op sampling, budget
dialects, dangling tool calls, tool-name charset rules, raw read timestamps
(`batch-delivery`), and per-frame arrival against final usage (`decode-window`).
Five of them exercise this plugin's own code and run from the repo root
(`node scripts/probes/pairing-repair.mjs`); the rest reach the upstream through a
third-party SSE client and assume that checkout's module paths, so they are
recorded as evidence rather than offered as a test suite. None of them is wired
into `npm test`, because there is no install step to wire them into.

Requires Node `^22.19.0 || >=24.0.0`. No install step, no dependencies.

## Security and privacy

- All state lives in `DSH_HOME/our-free-model/`; usage and settings stay local, nothing is uploaded.
- The forward listener binds `127.0.0.1` by default and rejects keyless requests. Changing the bind address is an explicit action.
- The forward key is generated by `crypto` at runtime, compared with `timingSafeEqual`, and stored in a `0600` file. This repository contains no hard-coded credentials.
- The plugin's HTTP routes carry a **request trust fence** (fixed in v1.1): the plugin's `/api/our-free-model` prefix outranks the kernel's `/api` in webServer's longest-prefix dispatch and used to bypass kernel auth. Every request now goes through the composition's `connection` admission first (exactly the kernel's `/api` check: cookie/token); compositions without a connection service fall back to a structural fence — loopback Host, cross-site `sec-fetch-site` refused, `Origin`/`Referer` must match the Host authority and port. Measured: foreign Host/Origin 403, cookieless loopback 401.
- **Announcement HTML renders through a strict client-side allowlist**: `scripts/sanitize-test.mjs` runs an XSS corpus (script injection, event handlers, `javascript:`/`data:` URLs, iframe/svg/form, style injection, mangled tags) and asserts all of it is dropped; nothing ever reaches an `innerHTML` sink. The feed URL is user-overridable, so the renderer treats feed content as untrusted.
- **The in-app upgrade integrity chain**: manifest validation (semver, path traversal, hash shape) → per-file SHA-256 + byte size on download → read-back verification of staging → read-back verification after install → backup restore on any failure. The manifest is re-fetched immediately before installing so a stale one can never vouch for different bytes. The upgrade's trust root is the plugin repository itself (same as installing an update); boundaries in [Known limitations](#known-limitations).
- Uninstalling removes the bundle entry; the plugin leaves no patches behind. Its data directory is plain JSON you can delete.

## License

MIT — see [LICENSE](LICENSE).

This project is an independent plugin and is not affiliated with, endorsed by, or
sponsored by any model provider. Using it to reach free tiers is subject to those
providers' own terms; check them before deploying anywhere beyond your own machine.
