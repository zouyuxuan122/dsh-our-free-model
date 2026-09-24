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
- **Honest capability claims** — anything a probe cannot confirm stays hidden. A model is never advertised as vision-capable because a table once said so.
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

**Settings page — `Settings → Our Free Model`**, four sections:

1. **Model roster** — per-model availability, vision vs text-only, context window, max output, measured time-to-first-token, and an on-demand single-call benchmark.
2. **Usage board** — headline counters, a 17-week token heatmap, a cumulative curve switchable between tokens and request counts and between total and any single model, speed sparklines, and a per-model table.
3. **Local forward** — enable/disable, bind host and port, copy base URL, show / copy / rotate the API key, and a ready-to-run `curl` example.
4. **Plugin settings** — master switch, whether region-limited models are exposed, probe interval, default output ceiling, plus the detected egress IP and country.

**First-run announcement** — a four-page walkthrough (preamble, model roster, how to use, what it does) that acknowledges once and never reappears until the copy version is bumped.

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
2. Add `"dsh-our-free-model": "1.0.0"` to `dependencies` — a version spec, not `link:`
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

## How it works

```text
index.js      host half: adapter registration, catalog + availability probes,
              settings/stats stores, webServer API routes, forward lifecycle
src/adapter.js  structural LlmAdapter: providerInfo, listModels, resolveModel,
                prepareCall, stream, providerRetryPolicy
src/upstream.js gateway identity: credentials, session/request id minting,
                tool fingerprint, endpoint selection per wire
src/stream.js   three wire decoders (chat / messages / responses) normalised to
                harness StreamChunks, with disjoint token accounting
src/messages.js harness messages -> wire shapes, plus tool-pairing repair
src/effort.js   effort level -> output budget
src/forward.js  standalone OpenAI-compatible listener
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

Tested on both kernels, on Windows, against the live upstream:

| Check | Result |
| --- | --- |
| `dsh` 0.1.7-rc.1 (source build) | Boots clean; picker shows both groups; multi-round tool calling completes |
| DSHEAC AIO 6.9.3 (`dsh` 0.1.5-rc.2) | Profile gate `compatible` / `PASS`; app boots alongside 13 other third-party plugins |
| Real conversation on 0.1.5-rc.2 | Turn completed; plugin's own ledger records `origin=harness`, `effort=deep`, 146 output tokens |
| Effort propagation | Served calls carry the resolved level (`deep` and `balanced` recorded in the same session) |
| Region gating | Region-blocked model surfaces as `REGION_BLOCKED` and stays in its own group |
| Vision input | Image block accepted, model describes it correctly |
| Forward listener | `/v1/models`, streaming and non-streaming `/v1/chat/completions`, unauthenticated requests rejected `401` |
| Announcement | Shows once, four pages, and does **not** reappear across a full app restart |
| Speed measurement | Live probe recorded `output=802 / reasoning=675` with **zero** reasoning frames in a 189 ms window: raw division says 4 243 tok/s, the plugin reports nothing, while a streamed-reasoning call's 68 tok/s passes through unchanged |
| UI strings | No mojibake; no upstream vendor name in any app-facing surface |

Not verified, so stated plainly: **visual layout was not eyeballed in pixels.**
The browser surface available during testing reported a zero-sized viewport, so
screenshots were impossible. Layout was checked structurally — DOM content,
computed CSS rules, theme-variable usage and a responsive grid — not visually.

## Known limitations

- **"No usage cap" means no cap to buy.** There is no balance, no plan and no per-token billing; the lane is metered by session rate, though, and hammering it surfaces as `429`. The plugin marks the model *quota reached* rather than hiding it, and the next probe clears the state.
- **Some upstream models are slow.** `nemotron-3.5-lightning-free` measured over 30 s to first token in one run. That is upstream latency, and the dashboard reports it rather than hiding it.
- **Output speed is sometimes `—`.** A model that answers in one or two large frames, or whose thinking never streams, has no window worth dividing. The panel says so instead of publishing the model's thinking time as decoding speed.
- **Capabilities are what probes can confirm.** Anything the public listing and a live probe do not evidence is left unlabelled.
- **Source is plain JavaScript.** It has to be, to load as a local plugin. Anyone with the folder can read the gateway logic; treat that as an accepted property of this distribution form, not as something obfuscation would fix.
- **Desktop installs need a real directory**, for the reason given in [Install](#install).

## Development

```bash
node scripts/client-lint.mjs        # browser half: copy/style key coverage, bundle executes
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

- All state lives in `DSH_HOME/our-free-model/`; usage stats and settings are written locally and uploaded nowhere.
- The forward listener binds `127.0.0.1` by default and rejects requests without a key. Changing the bind host is an explicit action.
- Forward keys are generated at runtime with `crypto`, compared with `timingSafeEqual`, and stored in a `0600` file. No credential is hardcoded in this repository.
- The settings page talks to routes mounted on the app's own HTTP server under this plugin's namespace; they do not extend any shared settings surface. Stating the boundary honestly: **these routes have no authentication and no origin fence.** Measured on the running app, a loopback request with no token returns `200`, `Origin: http://example.com` passes through unchanged, and a bare `curl -X POST /forward/rotate` succeeds. So any local process can read and write them; a cross-origin web page cannot read the response (these routes send no CORS headers) but *can* fire a state-changing POST, which is a CSRF surface. The forward listener is a different story: it requires a key, generated with `crypto`, compared with `timingSafeEqual`, stored in a `0600` file, and unauthenticated requests to it get `401`. On a fresh install the key field is empty — one exists only after you click generate or rotate.
- Uninstalling removes the bundle entry; the plugin leaves no patches behind. Its data directory is plain JSON you can delete.

## License

MIT — see [LICENSE](LICENSE).

This project is an independent plugin and is not affiliated with, endorsed by, or
sponsored by any model provider. Using it to reach free tiers is subject to those
providers' own terms; check them before deploying anywhere beyond your own machine.
