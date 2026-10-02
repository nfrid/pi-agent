# Computer use: findings and deferred experiments

Recorded 2026-10-02. This is a source/user-report review, not a performance benchmark. No desktop package was installed, no macOS permissions were changed, and no live desktop action was tested.

## Current decision

- For authenticated websites, use separate persistent Playwright Chromium profiles for the personal agent in `~/admin` and the work agent in `~/job`. Each workspace owns `.playwright/cli.config.json`; profile data stays outside the repositories under `~/.local/share/pi/browser-profiles/{admin,job}`. Initial sign-in/MFA is manual in a headed browser; ordinary launches are headless.
- Do not restart Arc or expose its live profile through CDP for this setup. The read-only probe found no Arc-owned TCP listener and nothing on port 9222; no tabs, authentication data, or settings were accessed. Arc 1.162.0 / macOS 15.7.9 browser automation remains untested.
- Defer desktop computer use. When returning, evaluate the Codex local backend and `@injaneity/pi-computer-use` on the same apps and Pi model. Keep `axcli` as a simpler CLI alternative. No winner has been established.
- Child usage/cost instrumentation is not a current priority. Existing task notes/snapshots are sufficient for short working constraints; pass relevant constraints explicitly into delegate briefs rather than adding a memory subsystem. Snapshot text is bounded and completed tasks are not automatically shown.

## Browser control and authentication

CDP is a debugging protocol also used for browser automation. Playwright supports Chromium attachment through `connectOverCDP`, with lower fidelity than its native connection protocol. Our installed `playwright-cli` 0.1.17 supports `attach --cdp`, but ordinary `open` creates an isolated in-memory session. `--profile` or `browser.isolated: false` plus `browser.userDataDir` enables persistence. One user-data directory must not be shared by simultaneous browser processes.

A separate profile keeps the user's tabs untouched, but does not reduce the authority of an authenticated account. Sessions can expire or require renewed SSO/MFA. Copying cookies is not universal: localStorage/IndexedDB may also participate, and sessionStorage is not included in ordinary Playwright storage state. Do not copy Arc's raw cookie database or send cookies/storage-state contents into model context or ordinary logs.

If reusing existing Arc sign-ins becomes essential, test a small companion extension with explicit per-site export through `chrome.cookies` and a local secret-state loader. Chrome's API can access HttpOnly cookies with `cookies` and host permissions; Arc documents Chrome extension installation, not guaranteed compatibility of this API. This path is untested and not implemented.

### Pi browser packages worth borrowing from

- [longweekendprojects/pi-browser-use](https://github.com/longweekendprojects/pi-browser-use): one Pi `browser` tool, raw CDP over Node's WebSocket, no runtime npm dependencies. Explicit Arc support, per-session owned tabs, intentional adoption of user tabs, and confirmation before browser relaunch. Useful target-scoped transport and ownership ideas. Its README still mentions a Playwright dependency, but the inspected manifest/helper use raw CDP. Real-session support on our Arc version is not verified.
- [pi-chrome](https://github.com/tianrendong/pi-chrome): Pi tools plus a browser companion extension for an existing Chrome profile. Useful local-bridge and connection UX ideas. Arc compatibility was not established; browser permission scope needs source review before use.
- [pi-agent-browser-native](https://github.com/fitchmultz/pi-agent-browser-native): native Pi browser tool, compact snapshots, artifact handling, and lifecycle integration around agent-browser. Useful integration reference, but not demonstrated necessary for our existing Playwright CLI workflow.

A permanently open CDP port on a real authenticated browser grants broad browser control to reachable local processes. Chrome 136 restricts remote debugging of its default data directory. Do not assume Arc has identical restrictions, or promise that its current profile will expose the port without testing.

## Desktop candidates

| Candidate | Architecture / useful properties | Trade-offs and unverified points |
| --- | --- | --- |
| [pi-codex-computer-use](https://github.com/danecando/pi-codex-computer-use) | Pi tools proxy to Codex app-server and the local Computer Use MCP/plugin service. AX tree plus screenshots; element-index and coordinate actions; serialized calls and permission prompts bridged to Pi. | Requires Codex CLI, app and plugin. Backend is not open in the wrapper repository; APIs can drift. Exact local plugin minimum OS/CPU/plan eligibility was not publicly established, so macOS 15.7.9 compatibility is unconfirmed. |
| [@injaneity/pi-computer-use](https://github.com/injaneity/pi-computer-use) | Pi-native tools and an open Swift helper; immutable state-scoped refs, verification/diffs, desktop and CDP roots, explicit Arc handling, background-first semantic actions. | Separate helper and permissions, substantial state/resource machinery. Documented macOS helper minimum14; build script has arm64/x64 targets. Our OS meets the documented minimum, but no live test was run. |
| [axcli](https://github.com/andelf/axcli) | macOS Rust CLI, AX selectors, screenshots/OCR, background-targeted actions and raw input fallback. | No dedicated Arc/CDP path in inspected docs. Verification orchestration stays with us; applications may still raise themselves despite background delivery. |
| [agent-cu](https://github.com/kortix-ai/agent-computer-use) | Accessibility CLI with snapshot refs and a dedicated Electron/CDP backend. | macOS marked Preview in inspected docs. Electron setup can relaunch apps; Retina/multi-monitor behavior and comparative reliability remain unverified. |
| [computer-use-mcp](https://github.com/onixhdz/computer-use-mcp) | Local Node/stdio MCP, snapshot-scoped refs, AX before/after diffs and coordinate fallback; background-first actions documented. | Sparse matching public user evidence. Includes broad JXA execution, unnecessary for a first experiment. |
| [Peekaboo](https://github.com/openclaw/Peekaboo) | CLI/app/MCP toolkit with screen/AX inspection and automation. | Larger surface than needed for the initial experiment. Permission-host and capture-path complexity matters for background Pi runtimes. |

The Codex Pi wrapper calls `thread/start` and `mcpServer/tool/call`, not `turn/start`: using its backend does **not** require switching Pi to a Codex model or invoking a second LLM loop. Conversely, success of the full Codex agent is not proof that the local backend alone is better. Anthropic-specific native computer-tool extensions are not a general backend for our Luna/Sol/Astra routes.

## What real users reported

No controlled head-to-head test of these local backends was found. The following are specific observations, not a reliability ranking; versions/OS differ from our machine.

- [Codex #21668](https://github.com/openai/codex/issues/21668): a user on macOS26.4.1 reports screenshots of the active Space/Codex instead of the intended app on another Space. Reproduction provided, but no verified common root cause in the reviewed material. This concerns Codex desktop, not a proven Pi-wrapper failure.
- [Codex #37115](https://github.com/openai/codex/issues/37115): Stage Manager/PiP refresh and unexpected foreground focus, with a reported workaround. May concern desktop-app lifecycle rather than the backend exposed to Pi.
- [axcli PR #4](https://github.com/andelf/axcli/pull/4): background Teams clicks/scroll silently failed because AX helper-process window IDs did not match the target process. Contributor describes a fix and live verification; Teams clicks still raise the app, whereas scrolling does not. PR evidence is not a cross-project benchmark.
- [Peekaboo #75](https://github.com/openclaw/Peekaboo/issues/75): Screen Recording check failed under a Node child process while the same operation worked via Terminal; old beta on macOS26.3. Important process/permission-path example, not proof about current releases.
- [Peekaboo #128](https://github.com/openclaw/Peekaboo/issues/128) and [#121](https://github.com/openclaw/Peekaboo/issues/121): different capture commands had different timeout/display-enumeration behavior. Do not generalize a working command to all capture paths.
- [agent-cu #30](https://github.com/kortix-ai/agent-computer-use/issues/30): stale refs and wrong Electron input reports are on Windows, not evidence of macOS failure.
- [Independent pi-computer-use review](https://panzhixiang.com/2026/pi-computer-use-open-source/): source inspection and Windows checks; a preference for Codex is the author's judgment, not a macOS head-to-head trial.

Sparse issue history is not proof of reliability. OpenAI's public computer-use API/model benchmarks are not measurements of the local Codex plugin backend.

## Resume checklist

1. Verify actual Codex plugin availability/compatibility before installation; do not infer it from generic app requirements.
2. Try Codex and the Pi helper with the same current Pi model on three neutral fixtures: an intended window on another Space, input in an Electron app after rerender, and a file-open dialog.
3. Record separately: correct target capture, actual action delivery, stale-ref recovery, focus/cursor interference and setup/permission behavior from our real Pi runtime.
4. Compare observed results before choosing a default. No new desktop integration, extra model or long-running service is approved by these notes.

## Authoritative references

- [Playwright authentication](https://playwright.dev/docs/auth) and [persistent contexts / CDP](https://playwright.dev/docs/api/class-browsertype).
- [Chrome cookies API](https://developer.chrome.com/docs/extensions/reference/cookies).
- [Chrome remote debugging changes](https://developer.chrome.com/blog/remote-debugging-port).
- [Arc Chrome-extension support](https://resources.arc.net/hc/en-us/articles/19434259167767-Extensions-in-Arc-How-to-Import-Add-Open).
- [OpenAI local Computer Use documentation](https://developers.openai.com/codex/app/computer-use): describes background use on macOS and application permissions; does not establish our local plugin compatibility. Distinguish this from the separate hosted computer-use API.
