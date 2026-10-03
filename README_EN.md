<div align="center">
  <img src="icon.svg" alt="Our Free Model — free model provider plugin for DeepSeek Harness" width="120">

# dsh-our-free-model

[简体中文](README.md) | **English**

  <img alt="license" src="https://img.shields.io/badge/license-MIT-263146?style=flat-square">
  <img alt="zero dependencies" src="https://img.shields.io/badge/dependencies-zero-4b6fff?style=flat-square">
  <img alt="build step" src="https://img.shields.io/badge/build%20step-none-7da1de?style=flat-square">
  <img alt="dsh kernels" src="https://img.shields.io/badge/dsh-0.1.5--0.1.7--rc.2-2f6f4f?style=flat-square">
  <img alt="status" src="https://img.shields.io/badge/status-beta-f0a441?style=flat-square">

</div>

<div align="center">

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

</div>

---

## Highlights

- **Nothing to configure** — install, restart, pick a model. No account, no key, no quota dashboard to register on.
- **The upstream is named** — one source, nothing else: OpenCode's Zen gateway at `https://opencode.ai`, with no third party relaying your traffic. Who serves your requests, and where your data goes, is spelled out in [Where the models come from](#where-the-models-come-from).
- **A roster that tracks upstream** — model set, context length and capabilities are re-fetched on every refresh rather than frozen into the plugin.
- **The picker offers only what actually answers** — a model the upstream listing names but the gateway refuses to route outright (`Model is unavailable`, a 404 for that id) leaves the dropdown and stays visible in the settings page with its refusal recorded. Everything that is *not* a statement about the model keeps its model reachable: a 5xx from the gateway, a 429 quota window, a timeout or a dropped connection. Region-gated ones move to their own `region-limited` group. If a whole round refuses everything, nothing is hidden: the picker never goes empty.
- **Announcement center with live push** — the repository owner edits one JSON file and pushes; every installation receives it within one poll cycle. Bodies are HTML rendered through a strict allowlist; `urgent` items open a full-screen modal; optional OS-level notifications.
- **In-app upgrades** — one click in the settings page: download → SHA-256 verification → backup → atomic replace → read-back verification → hot reload, with automatic rollback if any step fails.
- **Hot reload** — upgrades and code changes take effect immediately, no app restart; also available as a manual button and an optional file watcher.
- **Region-aware, per egress** — models gated by geography are separated into their own `region-limited` group instead of failing mid-turn. Switch your network exit and the next probe reclassifies them automatically.
- **The body decides what it is, not the header** — under load this gateway answers 200 with a JSON `Content-Type` over a perfectly ordinary SSE frame stream. The plugin sniffs the first bytes and replays them into the stream, so the turn keeps streaming instead of being thrown away — and a working model is never demoted to `unavailable` because one header lied.
- **Thinking effort that actually binds** — `Light / Balanced / Deep` map to output-token budgets of 2 048 / 8 192 / the model's full capacity, and are recorded per call. A model that cannot switch thinking off (MiMo V2.6 among them) gets the whole ladder doubled to 4 096 / 16 384 / capacity, because there thinking and the visible answer compete for the one ceiling; every model card in the settings page prints the number it will actually send. This is not a `reasoning_effort` string thrown at an endpoint that ignores it (see [Why a budget](#why-a-budget-and-not-reasoning_effort)).
- **Works without a browser UI** — only `llm` is a hard dependency, so the plugin activates on a headless composition such as dsh-tui and still serves its models. The dashboard half lives on its own fiber and mounts itself when `webServer` appears, so a composition that loads plugins before its HTTP server exists still gets its settings page. Availability probing and the background loops run on plain timers.
- **Usage dashboard, local only** — token heatmap, cumulative curve by total or per model, output speed and time-to-first-token sampled per call. Nothing is uploaded.
- **OpenAI-compatible forward port** — expose these models to any other local tool through a base URL plus a generated API key.
- **Clean names in the UI** — no mojibake, no upstream vendor strings leaking into your model picker.

## What you get

**Composer model picker**

| Group | Contents |
| --- | --- |
| `Our Free Model` | Models usable from your current network exit |
| `Our Free Model · region-limited` | Models the upstream refuses for this region, kept visible but separated |

A model the gateway names but refuses to route appears in neither group. It stays listed under
**Not in the picker** in the settings page, with the refusal and the probe time, and returns to
the picker by itself as soon as a probe gets through.

**Settings page — `Settings → Our Free Model`**, six sections:

1. **Model roster** — per-model availability, vision vs text-only, context window, max output, the output ceiling each effort rung really sends, measured time-to-first-token, and an on-demand single-call benchmark.
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

#### Integration packs (managed installation)

When the plugin arrives through an integration pack (an EAC pack, Mojobox, …),
the *pack* owns update timing and bytes: install with the bundle config
`distribution: 'managed'` (or write the same field into settings.json), and the
in-app updater, the announcement feed and the hot reload all stand down — two
writers to one installed directory corrupt it; the model lane is unaffected.
Acceptance lives in `scripts/offline-test.mjs`; the catalog-ready records
(manifest 0.15 / provenance / license / integrity) are under `catalog/`.

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

### Install failure: `ERR_PNPM_VIRTUAL_STORE_DIR_MAX_LENGTH_DIFF`

This is a **pnpm state problem in the target profile, not the plugin repo** (it fires
before the plugin is even downloaded): the profile's existing `node_modules` was
created by an older pnpm, and after a dsh update the bundled pnpm refuses to keep
using it. Close dsh, delete the profile's `node_modules` and `pnpm-lock.yaml` to
let pnpm rebuild them, then install again:

```bash
rd /s /q "%DSH_HOME%\profiles\web\node_modules"
del "%DSH_HOME%\profiles\web\pnpm-lock.yaml"
```

The accompanying `Ignoring broken lockfile` warnings disappear with the rebuild.

## Usage

**Pick a model.** Open the model selector in the composer and choose anything
under `Our Free Model`. The selection is durable per session.

**Change thinking depth.** The same menu exposes `Effort` with `Light`,
`Balanced` and `Deep`. Higher levels spend more of the output budget on
deliberation; the ceiling is enforced on the request, so the difference is
measurable rather than cosmetic. It is **one** ceiling shared by deliberation and
the visible answer, which is why a model that cannot switch thinking off gets
the whole ladder doubled (the model cards in `Settings → Our Free Model` print the
number each rung will really send). If answers keep getting cut off, move to
`Deep`, or raise the per-call output ceiling in the settings.

**Serve other local tools.** `Settings → Our Free Model → Local forward`, enable
it, then copy the base URL and generate a key. Supported routes:

```text
GET  /v1/models
POST /v1/chat/completions     streaming and non-streaming
POST /v1/responses
```

If another program holds the port, the listener does not die: it retries the same
port for a few rounds (a listener that just closed, or a portproxy rule that was
just removed, frees its port within a few hundred milliseconds), then walks to the
next free port and says so on the settings page — *requested 18899 is not available,
listening on 18900* — and the port written back into the settings is the real one.
On Windows the most common owner is a `netsh interface portproxy` rule (served by IP
Helper): its listener on `0.0.0.0` makes the loopback bind fail with `EACCES` rather
than `EADDRINUSE`. `netsh interface portproxy show all` lists the rules and
`netsh interface portproxy reset` clears them.

The forward endpoint streams in full: besides the `data:` frames, a lane that is
thinking gets periodic SSE comment frames (a `:` line), so a client's idle
timeout cannot read "the upstream is still thinking" as "the socket is dead".
Thinking is recognised under `reasoning`, `reasoning_content` and
`reasoning_text` — a gateway that repeats one thought under two of them is
counted once — and the `reasoning_details` array as well. A model whose thinking
never streams upstream still sends no reasoning frames here; see
[Known limitations](#known-limitations).

**Serve other devices on your network.** The same panel carries a *Network
access* section. It is off by default; switched on, the relay binds a routable
address (`0.0.0.0` by default) and demands **a key of its own** — separate from
the local key, so a leak on either side costs a rotation on that side only and
the tools already wired to the local port never notice. The relay re-issues to
the local listener, so the model roster, streaming and error semantics are the
same ones the local port serves. A port of `0` means "pick one" (18899 is often
already taken on a machine that runs something else); the panel then shows the
port and the network address it settled on. While it is on, anyone who can reach
this machine can spend its free quota with that key — enable it only on a
network you trust, and narrow the sources with a firewall if you can.

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

## How it works

```text
index.js      host half: adapter registration, catalog + availability probes,
              settings/stats stores, webServer API routes, forward lifecycle,
              announcement / upgrade / hot-reload wiring
adapter/      kernel seam: the only module in the package allowed to import
              @deepseek-ai/* (kernel.js: attribution User-Agent with a literal fallback)
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

### Three kernel behaviours that cost real debugging time

These are recorded here because they will bite any provider plugin:

1. **`providerRetryPolicy()` is stored verbatim.** Neither kernel resolves it, and
   the backoff scheduler reads `initialDelayMs / maxDelayMs / jitterRatio` off the
   **top level**. Returning them nested under `backoff` yields `undefined * 2ⁿ =
   NaN`, and the durable session log rejects non-finite numbers — so a recoverable
   transient failure becomes an aborted turn. Return an already-resolved, flat policy.
2. **One interrupted tool call poisons the whole session.** A tool call with no
   matching result replays as `400 invalid_request_error`, after which *every*
   request in that session fails. The plugin repairs pairing before sending, on all
   three wires.
3. **A service you did not name in `inject` throws when read as a property, and
   `ctx.get()` answers `undefined` for one that is merely not provided yet.** Both
   bit this round: after `inject` was reduced to `['llm']`, `typeof ctx.interval ===
   'function'` threw `cannot get property "timer" without inject` (`ctx.interval` is
   a mixin over the `timer` service) and the plugin stopped activating on *every*
   composition. Switching that one to `ctx.get('webServer')` then answered
   `undefined` — not because the composition had no web server, but because plugins
   load before the browser half publishes it — so the settings routes were never
   registered and the dashboard had no data source behind a server that was busy
   serving the app. The shape that works is `ctx.inject(deps, callback)`: give the
   services you need their own fiber and let *it* wait, instead of guessing once at
   load time.

### Why the response is read by body shape, not by `Content-Type`

Under load this lane answers 200 with `application/json` over a normal SSE frame
stream. Trusting the header meant `await response.text()` swallowed the live stream,
`JSON.parse` failed, and the turn was lost — and because that error carried
`status: 200`, the availability probe read the perfectly working model as
unroutable and dropped it from the picker for a round. The first bytes (≤4 KB) are
now sniffed and classified, then replayed into the stream, so nothing is buffered and
no token arrives late; `sniffBody` in `src/http.js` is the only discriminator.

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

### Automatic recovery after a long reasoning stream is cut (issue #12)

Every model enables one bounded recovery attempt by default, across the Chat
Completions, Messages and Responses upstream protocols. It requires a first
stream that delivered nonempty reasoning, no answer text or tool call, and then
either reached EOF without a normal terminal frame, or received a normal `stop`
terminal carrying reasoning only with no answer text — a turn the host would
classify as an empty response. Cancellation, a normal ending that already
delivered answer text or a tool call, an output ceiling and an explicit upstream
error do not trigger recovery.

The plugin sends **one new request** containing the original input and the
received reasoning as a text checkpoint, asking for the answer directly. This is
not a native upstream resume, and already displayed reasoning is not replayed.
Tools are disabled for the recovery request. A cut after answer text or a tool
call has started is not recovered, to avoid duplicate content or execution.

To avoid another long reasoning pass, the continuation prompt asks for the
conclusion first and at most 800 words. This is a prompt instruction, not a hard
token limit, and the model may ignore it. Recovery is a degraded answer: an
original request for a long or step-by-step analysis may be shortened.

One logical turn makes at most two physical requests: the original and one
recovery. The default total deadline is 480 seconds; recovery gets at most 180
seconds, bounded by the remaining total time. Recovery output is capped at 8192
tokens and still respects the user's and model's ceilings. Known output tokens
from the first segment are subtracted from the original budget; recovery does
not start if fewer than 512 tokens remain. The checkpoint is limited to 131072
characters and must pass a conservative text-byte estimate of context capacity.
That estimate does not count image tokens and is not an exact tokenizer check.
Exceeding a limit stops recovery. Success requires a normal ending with answer
text that is not only whitespace. Recovery failure returns `STREAM_CUT`, which
the harness does not resend as a whole turn; user cancellation keeps
`aborted` / `ABORTED`.

Set `streamRecovery: false` in the local settings.json to disable it. An object
can also supply an `enabled` switch and lower numeric limits; limits cannot
exceed the defaults. There is no model allowlist.

The local dashboard keeps **physical requests** and **logical turns** separate.
Upstream requests and request failures count each HTTP request actually sent;
conversation turns, turn failures and recovered turns count one adapter
invocation by its final outcome. A first segment cut short and a successful
continuation therefore show 2 upstream requests and 1 request failure, while
remaining at 1 conversation turn with 0 turn failures and 1 recovered turn.
Each segment still has its own sample with recovery identity, attempt index and
`noUsage` markers. A shared `recoveryId` associates those markers to identify
missing usage. Final usage sent to the harness sums only counts the upstream
actually reported; if one segment has no usage report, this is not the full
turn's token total. Reasoning checkpoints are not written to the statistics
file.

Pre-upgrade history has only physical request records, so migrated turn and
failure counts are estimates and the dashboard labels them. Turns recorded
after the upgrade use the final outcome and are exact.
Requests, turns and token totals are lifetime values; speed, first-frame and
heatmap details use the locally retained history window.

One live MiMo V2.6 Flash · Deep request recovered successfully; an earlier
attempt failed at the 480-second deadline. This does not establish live coverage
of every model or guarantee completion of every long reasoning turn. The
v1.3.1 records below describe behaviour before recovery was added.

## Verification

Tested on Windows against the live upstream. The table is kept per release round,
and each row says which way it was checked — only the rows marked *live upstream*
or *hands-on* are behaviour a user sees in the interface.

### Issue #12: verification status

Implementation, offline regression and live results are tracked separately in
[`docs/issue-12-recovery.md`](docs/issue-12-recovery.md). Recovery 99/99,
truncation 35/35, 11 new fingerprint checks and typecheck have passed. Twelve
checks use the real plugin over local HTTP to verify forward success, failures,
client disconnection and stored statistics. The technical record carries the
final full-suite result. In a live MiMo Deep run, the first
stream reached natural EOF at 304.161 seconds; recovery took 32.777 seconds and
produced 4264 characters of answer text, ending with `stop`, usage and `[DONE]`.
There were two requests over 336.942 seconds. The first segment had no usage
report, so the summary contains only known counts. The earlier failed
480-second attempt remains in the technical record. Real dsh UI and other
models have not been individually accepted.

### Historical: v1.3.2 (issues #11, #13, #19, #20, #21)

| Item | Fix | Verification |
| --- | --- | --- |
| #19 self-update trust chain | Ed25519-signed manifests (public key pinned in the plugin, private key out of the repo), the update channel fully decoupled from `feedUrl`, manifest `base` restricted to relative paths | updater-test: four new cases (signature, tamper, foreign key, feedUrl not followed); release-e2e's negative control now refuses at the signature |
| #19 forward surface | `localhost` binds resolve first and require all-loopback answers; a 1 MB cap (413) on plugin API bodies; the forward endpoint answers 400 for a non-JSON body and 404 for an unknown model | forward-test `resolveLoopbackBind` cases; offline-test 404 case |
| #20/#21 tools unusable through the forward port (#21's `Unknown tool 'bash'/'read'/'grep'` is exactly the fingerprint decoy quartet: the lane forces those names to be declared, the model dials them, the forwarded client never registered them) | streaming `tool_calls[].index` renumbered from 0 (no longer shares the block counter with reasoning); fingerprint-decoy calls suppressed per block on the forward wire (unnamed blocks have their arguments held); a ceiling-cut turn finishes as `length` on the stream too | forward-test: four streaming/non-streaming cases against the real listener with a scripted lane |
| #20 dsh-side decoy hazard | `stream.js` keys parallel tool calls without an `index` by call id; bare argument continuations join the preceding call | existing truncation/fingerprint suites stay green |
| #13 quota experience | 429 removed from the retryable codes (no more three automatic retries of the same wall); a probe round answered by nothing but 429s backs the next periodic round off 30→120 minutes (manual reprobe, egress change and the boot round are exempt); the probe recognizes in-stream error frames inside a 200; the bench button uses the default effort and a realistic client timeout | retry-safety-test assertion updated; probe logic covered by the offline suites |
| #13 concentrated forward quota | 429 no longer auto-retried (above); the forward session key stays derived from `user`/`conversation` (deliberate: the lane accounts per session) | behavior unchanged, no new spend |
| #11 heatmap | cell gap removed and corners tightened for a GitHub contribution-graph ribbon; the layout was already column-major week-aligned | client-lint green |
| Other | per-route client timeouts (bench 240 s, upgrade 600 s — the 8 s guard now covers only fast routes); EventSource reconnects with backoff (30 s → 5 min) instead of closing forever; a completed upgrade clears the stale error banner; the speed-scope copy now says what the panel really averages (last 40 calls); a failed store flush is logged once | client-lint; speed-stat green |

All 20 offline suites (including the new `forward-test`) and `tsc --noEmit` pass; `host-selftest` costs real network and real free-lane quota, so it did not run with this round.

### Historical: v1.3.1 (issues #8, #9, #10)

| Item | How | Result |
| --- | --- | --- |
| Both tool-result vocabularies really reach the model | live upstream, `host-selftest.mjs` step 2 | Same model, same `get_weather` answer, sent once in the pre-V4 shape (`user` carrying a `tool-result` block) and once in the V4 shape (`role:'tool'`): both `finish=stop`, and both times the model repeated the `22°C / sunny` from the result. Before the fix the plugin did not recognise the first shape at all (`src/messages.js` never mentioned `tool-result`), so that request carried neither the call nor its answer |
| The shapes are taken from records, not imagined | every session root on this machine — 40 `session*.jsonl.zstd` across four homes (zstd, which needs splitting frame by frame) | `tool/result` events appear in exactly two shapes: **362** with `role:'user'` carrying a `tool-result` block (V1/V3 format — 336 written by AIO 6.9.3's v3 home, 26 by `~/.dsh`'s v1) and **27** V4 `role:'tool'` from the v4 session copies. Both generations are in live use and the plugin read only the latter — issue #9 was right, about a kernel older than the reporter's |
| Projection and pairing repair | offline `projection-test.mjs` (new, 40 assertions) | Three wires × two vocabularies: each call and its answer reach the wire, keyed by call id; three parallel calls each get their own answer, merged into one user turn on the Messages wire with `tool_result` first (the same rule the kernel's own adapter uses); images nested in a result survive instead of vanishing (Chat follows with a user turn, Messages nests them inside `tool_result`); **each answer appears exactly once on each wire** — counted in the bytes that go out, not by block type, because a block-type assertion cannot see a duplicate; answers with no call id, dangling calls and orphan results are still removed; already-valid history is returned byte for byte |
| `pwsh` filling the `bash` slot is accepted upstream | live upstream, `probes/shell-slot-promotion.mjs` (new) | Declares `bash, glob, grep, read`, where `bash` carries pwsh's real schema and no decoy is added: the gateway does not answer `FreeTierError`, the turn finishes `tool-calls`, and the call comes back renamed to **`pwsh`** (`{"command":"Get-Date"}`) — a tool the kernel can actually run. Offline, `fingerprint-test.mjs` (new, 20 assertions) pins no-duplicate declarations, a real `bash` winning over the donor, and the decoy surviving only when there is nothing to promote |
| A cut stream is no longer a completed turn | offline `truncation-test.mjs` (new, 22 assertions) | A local HTTP server really does `res.end()` a stream that never carries a finish token → `kind=error`, recorded `ok=false` and flagged `truncated`; checked on each of the three wires; genuine endings such as `message_stop` and `response.completed` are not caught; a turn that finishes without a usage frame is flagged `noUsage`, so `0/0` stops being indistinguishable from "produced nothing". **Re-sending now depends on what had already arrived**: a cut that delivered no token at all stays `TRANSPORT` (retryable), while one that had streamed content becomes `STREAM_CUT` (outside the retryable set, so the turn fails on the spot) — the reason is the next row |
| What retries cost, measured in a real kernel session | real `dsh` web kernel, one turn sent from the browser on MiMo V2.6 Flash · Deep | Taken event by event out of the durable session log: `llm/retry retry=1 delay=702ms code=TRANSPORT` at 304 s, `retry=2 delay=1124ms` at 608 s, `turn/end {kind:"error",code:"TRANSPORT"}` at 912 s; `stats.json` holds three `ok:false truncated:true` rows of 0/0, 304 s apart; the interface showed *turn failed* with the message and the code. The cut on this lane is a function of how long the turn thinks, so a retryable code only billed the same five minutes three times over — which is why content that already streamed is not re-sent |
| Re-reviewing this release found two defects in the above | offline `projection-test.mjs` section 7 and `truncation-test.mjs` section 12, plus one forwarded round trip in `tui-test.mjs` | (1) Once the Messages wire recognised V4's `role:'tool'`, it put the same answer inside `tool_result` *and* left it in the ordinary blocks after it — the text twice, and a returned image with its whole base64 payload twice. The message is now skipped once its result is emitted, and reverting that turns the assertion red. (2) `response.incomplete`, `response.failed` and `response.done` end that wire on purpose too; reading only `response.completed` as terminal turned a turn that hit its output ceiling into a cut stream and burned two retries on it. The status still decides the finish token, and a terminal frame naming no reason no longer erases one a previous frame gave. (3) The forwarded `/v1/responses` route had never been exercised with tool history; the outbound `messages` are now compared byte for byte against a stub gateway, call and result both present |
| What a normal ending looks like on this lane | live upstream, `probes/stream-terminal-frames.mjs` (new) | Raw SSE captured frame by frame: `finish_reason:"stop"` → the usage frame → `data: [DONE]` → `{"choices":[],"cost":"0"}`, identically on two models. So "no finish token ever arrived" is genuinely an anomaly rather than a second normal ending — which is the basis for #10's check |
| No false positives against the real lane | live upstream, `host-selftest.mjs`, full run | 11 models probed plus plain chat, two tool rounds, three effort rungs and vision input: every call landed on its own normal ending (`stop` / `tool-calls` / `max-tokens`), none read as truncated; the region-gated model still returns `REGION_BLOCKED` |
| The upstream is documented (#8) | every outbound destination in the code, checked one by one | New section [Where the models come from](#where-the-models-come-from): `opencode.ai/zen/v1/*` (inference and `/models`), this repository's `feed/*.json` (raw first, jsDelivr as fallback), and `api.ipify.org` / `ipinfo.io` / `ipapi.co` (only to read back this machine's egress IP and country code). No account pool, no relay |
| Offline suite | `npm test` (18 suites) | Green; `projection` and `fingerprint` added, still no network and no free-lane quota spent |

### v1.2.2 (issues #1–#4, #6)

Each row names how it was checked: *offline fake kernel* never leaves the machine,
*live upstream* means the plugin really calls the gateway but runs on a
hand-built cordis context, and *real kernel* means the plugin was installed and
started inside dsh. The distinction cost this round a ship-blocker — see the last
row.

| Check | How | Result |
| --- | --- | --- |
| Manifest describes the shipped files | offline, `build-manifest.mjs --check` + `release-e2e.mjs` | All 26 published files match. Before the fix, `main`'s published 1.2.1 manifest had drifted on **6** files (`index.js`, both READMEs, `src/catalog.js`, `src/store.js`, `src/upstream.js`) — one more recurrence than the 2 issue #1 reported, after the issue was filed. Regenerated with the version; `--check` and the new `release-e2e.mjs` (it installs the real release end to end, with a negative control proving a manifest that lies about one byte is refused) now run in `npm test` and in CI. This round closed two holes of the same family: digests are now computed over **LF-normalised** bytes (`.gitattributes` says `* text=auto eol=lf`, and an editor on Windows can leave the working tree CRLF while `git status` stays clean — which is exactly how issue #1 came back), and listed directories are walked **recursively** (the old one-level scan skipped `src/lib/x.js`: npm ships it, the manifest does not name it, and `installStaged` deletes whatever the manifest does not name from every installed copy). Both carry standing assertions, the first of which rewrites all 26 files to CRLF and runs `--check` |
| Offline suites | `npm test` (14 suites) | 14/14 pass; no network, no free-lane quota spent. Suite ports come from the ephemeral range (a hard-coded port loses a race with any other process: occupying the one `tui` used to write down made its own fetch hit somebody else's listener and hang to the runner's timeout, printing six `ok` lines as the "failure detail"), and the runner puts a 60 s deadline on every suite and says so when one hangs |
| The new tests actually bite | old behaviour patched back in, suite re-run | Reverting the `computeMembership` guard → picker fails with `Cannot read properties of undefined (reading 'state')` (2 checks); reverting the response sniff → sniff fails 7 checks. Restoring each fix turns both green again. Every assertion added this round went through the same treatment as a **mutation check**: 9 fixes reverted one at a time in throwaway copies, 9/9 turned their suite red |
| Probe verdicts → what the picker advertises | live upstream, `host-selftest.mjs` | 10 listed models → 7 on the main route plus 2 under `region-limited`, and the forward port's `/v1/models` follows at 9; `deepseek-v4-flash-free` (`Model is unavailable`) left the dropdown with its refusal recorded in the settings page. 5xx / 429 / dropped connections all keep their model |
| A model with no verdict is survivable | offline fake kernel, `picker-test.mjs` | With a newly listed model whose probe the test holds open, `listModels` and `/summary` both answer, the model is advertised and reads `availability=unknown` |
| Rungs still enforced | live upstream, MiMo V2.6 Flash | `light` now sends 4096 and the same prompt finished `stop` at 2 980 tokens; before the change `light` (2048) ended that same prompt with `length` |
| Long answers stop being cut | live upstream, `probes/long-answer.mjs` | `balanced` sent `max_tokens=16384`; the request produced **10 164** output tokens (19 914 characters, 194 s) and finished `stop`. The old 8192 ceiling cut the same turn with `length` — the symptom in issue #2. The model cards print each rung's real number (`默认档上限 16K`), read in the browser |
| The body decides, not the header (issue #6) | offline fake gateway, `sniff-test.mjs` | A 200 with `application/json` over SSE frames streams normally with no error; a Chinese character split across chunks, a 400-frame stream past the 4 K sniff window, a single JSON body, an empty body and an HTML junk body all route by shape. On the old code that same response also made the probe report a working model as `unavailable` |
| Composition with no web server | offline fake kernel, `scripts/tui-test.mjs` | With only `llm` mounted, `apply()` does not throw, both routes register, a full streamed turn completes, the forward port comes up and rejects keyless requests, and the background loops run on plain unref'd timers. The dashboard half waits, and mounts both routes the moment `webServer` appears. **Not yet verified on a real dsh-tui**: neither kernel on this machine (source build 0.1.7-rc.1, AIO 6.9.3) ships a tui profile |
| The plugin really installs and runs | **real kernel**, dsh 0.1.7-rc.1 web on port 3099 | No `did not activate` in the startup log; `/api/our-free-model/summary` 200 (10 models: 6 available, 2 region-blocked, 1 unknown, 1 unavailable), `/events` streams its hello; in the browser `Settings → Our Free Model` renders the 10 cards, the *Not in the picker* group, the `思考不可关` and `默认档上限 16K` tags, with an empty console. The first cut of this round **failed here**: with `inject` reduced to `['llm']`, reading `ctx.interval` threw `cannot get property "timer" without inject` and the plugin stopped activating on every composition |
| Two new problems the review itself caught | targeted repro + standing assertions | (1) Aborting during the head sniff threw the raw `AbortError` (numeric `code` 20), which `toFailure` cannot recognise and downgrades to `TRANSPORT` — a retryable code, i.e. a hole where a turn the user cancelled could be retried. All three read paths now share `classifyStreamFailure`, and sniff carries two abort assertions. (2) After committing, another `src/http.js` edit drifted the manifest, and `--check` plus the new `release-e2e.mjs` failed it on the spot - the gate works, and it is also the reminder that any edit means re-running it |
| This round, on the request path: two ways to lose or double-pay a turn | local fake gateway, targeted repro + standing assertions | (1) `readHead` filled its whole 4 KB window before deciding what the body was, so a **short answer the gateway had already finished typing** sat in the sniff until the deadline and was then discarded with the cancel — a completed turn reported as a retryable `TIMEOUT`, which the harness sends again and the lane pays for twice (the repro prints `frames delivered: 0`). The body is now allowed to declare itself a stream on the first frame, which also stops withholding the first 4 KB of every answer. (2) In-stream errors were classified into `llmCode`, and `toFailure` reads `code` — so every refusal inside a stream arrived as retryable `TRANSPORT` (re-sending a turn whose partial answer had already been forwarded), and a mid-turn `RegionError` could never reach the egress re-probe. In-stream errors now go through the same `classifyFailure` as an error envelope |
| This round, at the settings boundary | offline, `picker-test.mjs` + `effort-test.mjs` | `probeIntervalMinutes:'abc'` made `Math.max(1,'abc')` = NaN, and Node treats `setTimeout(fn, NaN)` as 1 ms — a full catalog probe every second. `defaultMaxTokens:0` (which is what clearing the settings-page field posts) became `min(capacity, 0)`, cutting every turn to the 512-token floor while the picker went on printing its 4 K/16 K/32 K ladder. Numbers are now coerced both where they are written and where they are read, and a non-positive value means "unset". The same assertions pin the forward listener to a loopback bind (`0.0.0.0` is refused with a 400 that says why) and pin that `connection` admission is read **per request**: patch the snapshot back in and the late-mount 401 check goes red on the spot |
| This round, three suites that only looked like tests | mutation check (revert one fix per throwaway copy) | `retry-safety-test.mjs`'s four cases all landed on the "model not on this route" early return — it passed `model:"our-free-model/test-model-free"`, and `baseModelId` strips a label, not a route — so the suite had never sent a request; against real calls its 7 cases now pin the code, whether it may be retried, and whether the region re-probe fired. `tui-test.mjs` compared the *counts* of two different populations, so deleting the 120 s loop's `unref()` stayed green; it now checks each period individually. And the hard-coded port in `tui` became an ephemeral one after it hung for 180 s against somebody else's listener |
| Usage accounting | offline, `retry-safety-test.mjs` | A `usage` object without `prompt_tokens_details` no longer computes `inputTokens: NaN`; the forward port answers in `prompt_tokens/completion_tokens` and reports a refused turn as an error instead of an empty 200. On the Messages wire `message_delta` carries only the output side, and the old whole-record overwrite zeroed the prompt tokens of every Claude turn; records are now merged field by field |
| This round: a 5xx reason phrase is no longer read as a verdict (the same regression issue #3 was about) | offline, `sniff-test.mjs` + revert check | `stateOf` matched its message fallback without regard for the status, and "Service Unavailable" is the reason phrase every reverse proxy answers a 503 with — so an overloaded gateway was read as the gateway naming each model refused, and those models left the picker one at a time (the cost issue #3 removed, back through the message fallback). The fallback now only speaks when the status has not already answered for the gateway; a body that names the model — including `type: ModelError` under a 5xx — is still a refusal. Four new assertions, two of which go red the moment the old implementation is restored |

### v1.1.2 (announcements, in-app upgrades, hot reload, trust fence)

Every v1.1.2 capability was **operated for real**, including click-through in a
browser and inside the DSHEAC AIO desktop window:

| Check | Result |
| --- | --- |
| `dsh` 0.1.7-rc.1 (source build) | Boots clean; picker shows both groups; multi-round tool calling completes |
| `dsh` 0.1.5-rc.2 (DSHEAC AIO 6.9.3 kernel) | Boots clean alongside the other installed third-party plugins |
| EAC startup gate | Run at install time **and after the in-app upgrade**: `compatible` / `PASS` |
| Model reachability | All 10 catalog models stayed invocable (behaviour at that round: even probe-failed ones remained in the picker; since v1.2.2 a model judged unroutable is not advertised); real chat, multi-round tools and vision input pass on both kernels |
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
| UI strings | No mojibake; the upstream vendor name appears in exactly two places — the repository docs and the announcement body, since #8's disclosure needs a place a user can actually see. The model picker, the settings page and error copy still never name it |
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
- **Thinking is a silent wait, and it shares the output budget.** `mimo-v2.6-flash-free` measured 60–70 s of silence while the lane billed 3024 reasoning tokens and streamed not one reasoning frame; such a turn ends as `stop` with nothing visible, which clients report as an empty response. The forward endpoint and the LAN relay keep the connection alive with heartbeats — but that protects the connection, not the timeout: the SSE parser skips comment frames, and pi-ai's idle watchdog (`streamIdleTimeoutMs`, default 300 s) resets only when real content frames arrive, so a stall past 300 s on the wire still fails (issue #34). Only the caller can give it **budget**: raise the per-call output ceiling past 16k, or use a model the catalogue marks `reasoning: false`.
- **Automatic recovery has request, time and context limits.** It handles only reasoning-only EOF and reasoning-only silent stops (a normal `stop` ending with no answer text) and adds at most one request. Answer text, tool calls, cancellation and explicit errors exclude recovery. A checkpoint request cannot preserve internal upstream state that was never sent, and success is not guaranteed. Usage with a missing report is only the known part.
- **Capabilities are what probes can confirm.** Anything the public listing and a live probe do not evidence is left unlabelled.
- **Source is plain JavaScript.** It has to be, to load as a local plugin. Anyone with the folder can read the gateway logic; treat that as an accepted property of this distribution form, not as something obfuscation would fix.
- **Desktop installs need a real directory**, for the reason given in [Install](#install).
- **Upgrade and hot-reload trust boundary**: as of v1.3.2 the in-app upgrader's trust root is the Ed25519 public key pinned inside the plugin, not "HTTPS to the repository" — a manifest must carry the release key's signature before anything is installed, so a poisoned mirror (jsDelivr included) fails the upgrade instead of executing code. Whoever holds the **release private key** can push arbitrary code, the same trust model as whoever can push the repository, but a repository account takeover is now a failed-upgrade outage for every user rather than a direct RCE. File integrity is enforced by signature + SHA-256 manifest; content safety by the client-side allowlist renderer and the host's plugin isolation.
- **The AIO build's WebView2 permission policy may deny notification permission** (measured `denied` on this machine). The announcement center says so plainly; plain-browser access to dsh web is unaffected.
- **The forward port is not required to be 18899.** When the port is taken the listener moves to the next free one and writes that port back into the settings (the settings page carries the note). That is deliberate: a port change beats a forward listener that silently stays down. Which process holds the port is the operating system's answer to give; the plugin only reports what it said.
- **The plugin routes' auth depends on the composition**: with a connection service mounted (dsh web, the AIO desktop) it matches the kernel's `/api` (the app's own cookie/token); in minimal compositions without one, a structural fence applies (loopback + same-origin), and other local processes can still reach the routes — the same behaviour the kernel has in those compositions.

## Development

```bash
npm test                            # every offline suite below, plus the manifest check
node scripts/client-lint.mjs        # browser half: copy/style key coverage, bundle executes
node scripts/sanitize-test.mjs      # announcement HTML allowlist renderer vs an XSS corpus
node scripts/trust-test.mjs         # request trust fence for the plugin's routes
node scripts/feed-test.mjs          # announcement feed: parsing, failover, cache, arrivals
node scripts/updater-test.mjs       # in-app upgrade: manifests, SHA-256, backup/rollback
node scripts/build-manifest.mjs     # release: regenerate feed/manifest.json
node scripts/retry-safety-test.mjs  # failures, retry policy and usage counts are durable-log safe
node scripts/speed-stat-test.mjs    # no call can average its way into a fake tok/s
node scripts/effort-test.mjs        # a rung is the max_tokens that goes out, and is recorded as itself
node scripts/sniff-test.mjs         # a 2xx body is read by shape: SSE frames, single JSON, empty, split mid-codepoint, abort
node scripts/release-e2e.mjs        # upgrade against the real manifest, and prove a lying one is refused
node scripts/picker-test.mjs        # only usable models are advertised, and the picker never goes empty
node scripts/tui-test.mjs           # the plugin activates and serves with no web server in the composition
node scripts/host-selftest.mjs      # host half end to end against the live upstream
```

Release manifests must be signed with the release private key (`--key <pem-path>`
or the `OFM_MANIFEST_KEY` environment variable); the builder refuses to write an
unsigned one — the in-app upgrader installs only manifests whose signature
matches the public key pinned in the plugin, as of v1.3.2. The private key lives
in neither the repository nor any artifact; rotating it means rotating the trust
root: change the pinned key in `src/updater.js` and cut a full release.

`scripts/probes/` holds the one-off evidence scripts behind the findings report —
capability matrix, region gate, the `reasoning_effort` no-op sampling, budget
dialects, dangling tool calls, tool-name charset rules, raw read timestamps
(`batch-delivery`), per-frame arrival against final usage (`decode-window`),
and whether a long answer survives its ceiling (`long-answer`). Six of them
exercise this plugin's own code and run from the repo root
(`node scripts/probes/pairing-repair.mjs`); the rest reach the upstream through a
third-party SSE client and assume that checkout's module paths, so they are
recorded as evidence rather than offered as a test suite. None of them is wired
into `npm test`, which runs the offline checks above — no network, no free-lane
quota spent.

Requires Node `^22.19.0 || >=24.0.0`. No install step, no dependencies.

## Where the models come from

There is exactly one upstream, and it is not a reseller: **OpenCode's Zen
gateway**, `https://opencode.ai/zen/v1/*`. Once the plugin is installed your
conversation goes from this machine straight there — no third party in the middle.

Every fact in that sentence lives in `src/upstream.js`, and each one was checked
by direct request against the live gateway on 2026-09-24:

| What | Where | Credentials sent |
| --- | --- | --- |
| Inference | `POST …/zen/v1/chat/completions`, `…/zen/v1/responses`, `…/zen/v1/messages` (per model, see `endpointFor`) | `Authorization: Bearer public` — this lane is a public, key-free allowance; the plugin holds no secret of yours |
| Model list | `GET …/zen/v1/models` | same |
| Announcements and the update manifest | this repository's `feed/*.json`: `raw.githubusercontent.com` first, `cdn.jsdelivr.net` as fallback | none |
| Egress region check | `api.ipify.org` / `ipinfo.io` / `ipapi.co`, only to read back your own public IP and country code | none |

On privacy and trust, plainly:

- **No account pool, no relay, no reseller.** There is no second lane in this
  version; the four rows above are the complete set of destinations the plugin
  can contact. `npm test` touches no network at all, and the only things that do
  are `scripts/host-selftest.mjs` and `scripts/probes/`, which you run by hand. If
  another source is ever added, this section is updated before the feature is.
- **Your prompts, tool results and any attached images go to that upstream as an
  ordinary inference request** — the same as calling any model API. Nothing else
  leaves the machine: the usage dashboard's data, settings and the forwarding key
  all stay in `DSH_HOME/our-free-model/`.
- **Key-free is not unmanaged.** The lane fingerprints clients through
  `x-opencode-*` headers, accounts free usage per session, answers 403 for a
  disallowed region and 429 once the allowance is spent. The model set and the
  quota policy belong to the upstream and can change at any time; all the plugin
  can do is withdraw an unavailable model from the picker and say why.
- This section is repository documentation. Inside the app — picker, settings
  page, error copy — the upstream's name still does not appear (the convention is
  recorded under [Verification](#verification)).

## Security and privacy

- All state lives in `DSH_HOME/our-free-model/`; usage and settings stay local, nothing is uploaded.
- The forward listener binds a **loopback address only**, `127.0.0.1` by default, and rejects keyless requests. Widening it to a routable interface is refused: `POST /settings` answers 400 with the reason, and on a composition with no web server a hand-written `settings.json` simply does not start the listener. That traffic is spent from this machine's free lane; one string in a settings file should not put a whole subnet on it.
- **Network access is a second door, not a relaxation of the rule above.** The local listener still binds loopback only and still refuses a routable address; reaching another machine takes an explicit switch, and then **every** request must carry the network key — `/` and `/health` included, unlike the local listener, because an unauthenticated liveness answer tells the whole subnet that this machine is here and proxying. The relay carries three whitelisted paths (`/v1/models`, `/v1/chat/completions`, `/v1/responses`) and is not a general proxy for whatever else answers on loopback; it swaps the network key for the local one at the door, so the two are never interchangeable; a request that already carries the relay's hop marker is refused with `508`, so a relay port equal to the local one cannot spin. The hop from the relay to the local listener opens with a `PROXY protocol v1` line naming the device that asked, so the listener logs the real requester instead of the relay's own loopback socket; the listener still binds loopback only, which means the claim can only have been made by the relay, and a truncated line, one past the protocol's 108-byte cap, or a malformed one is severed before the HTTP parser ever sees it — plain loopback traffic without a line passes through untouched. The network key is minted by `crypto`, compared with `timingSafeEqual`, stored in the same `0600` file, and rotated on its own from the panel.
- The forward key is minted at runtime by `crypto`, compared with `timingSafeEqual`, and stored in a `0600` file. No hardcoded credential ships in this repository. `/` and `/health` answer ahead of the key check because they are liveness probes — they answer only "is it there"; the model roster requires the key.
- The plugin's HTTP routes carry a **request trust fence** (fixed in v1.1): the plugin's `/api/our-free-model` prefix outranks the kernel's `/api` in webServer's longest-prefix dispatch and used to bypass kernel auth. Every request now goes through the composition's `connection` admission first (exactly the kernel's `/api` check: cookie/token); compositions without a connection service fall back to a structural fence — loopback Host, cross-site `sec-fetch-site` refused, `Origin`/`Referer` must match the Host authority and port, and a **missing or empty Host is refused too** (fail closed; there is no fallback to the socket's local address). Measured: foreign Host/Origin 403, cookieless loopback 401. `connection` is resolved per request, because the browser half provides it only after plugins load — reading it once at apply time silently degrades the fence to its structural layer for the life of the process.
- **Announcement HTML renders through a strict client-side allowlist**: `scripts/sanitize-test.mjs` runs an XSS corpus (script injection, event handlers, `javascript:`/`data:` URLs, iframe/svg/form, style injection, mangled tags) and asserts all of it is dropped; nothing ever reaches an `innerHTML` sink. The feed URL is user-overridable, so the renderer treats feed content as untrusted.
- **The in-app upgrade integrity chain (signed as of v1.3.2)**: manifest Ed25519 signature verification (public key pinned in `src/updater.js`; unsigned or unverified manifests are refused outright, so no mirror can serve an installable forgery) → manifest validation (semver, path traversal, hash shape, `base` restricted to manifest-relative paths) → per-file SHA-256 + byte size on download → read-back verification of staging → read-back verification after install → backup restore on any failure. The manifest is re-fetched immediately before installing so a stale one can never vouch for different bytes. Boundaries in [Known limitations](#known-limitations).
- **The update channel is fully decoupled from `feedUrl`** (v1.3.2): the setting redirects the announcement feed only, never the upgrade manifest — previously one settings value could point the update channel at any server with self-consistent hashes, turning "wrote a config field" into "executed arbitrary code in the host process". The announcement override itself is now restricted to https (loopback http excepted, so a locally-hosted mirror and the test suites still work) and may not carry credentials.
- **The forward listener binds loopback by resolution, not by spelling** (v1.3.2): a hostname such as `localhost` is resolved with `dns.lookup` first and every answer must be loopback; the listener binds the resolved IP — so a hosts file or enterprise DNS pointing `localhost` at a routable interface can no longer pass the check while the listener hands the lane to the subnet.
- Uninstalling removes the bundle entry; the plugin leaves no patches behind. Its data directory is plain JSON you can delete.

## License

MIT — see [LICENSE](LICENSE).

This project is an independent plugin and is not affiliated with, endorsed by, or
sponsored by any model provider. Using it to reach free tiers is subject to those
providers' own terms; check them before deploying anywhere beyond your own machine.
