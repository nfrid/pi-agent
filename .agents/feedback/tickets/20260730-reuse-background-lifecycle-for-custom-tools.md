# HFM-20260730: Reuse the background lifecycle for custom tools

- **Status:** parked
- **Approval:** not approved
- **Created:** 2026-07-30
- **Source reports:** [HF-20260730: Long-running custom tools lack a reusable background handoff](../inbox/20260730T092940Z-custom-tools-lack-background-handoff.md)
- **Decision:** Parked 2026-08-02 until a new typed custom tool has a concrete background-mode requirement; the current skill-driven background path is sufficient

<!-- Proposal and implementation approval are separate decisions. A proposed ticket does not authorize implementation. -->

## Problem

A custom tool's `execute` promise is foreground work from the agent loop's perspective. Slow integrations can honor the supplied abort signal and stream partial updates, but they cannot hand an operation to the harness's existing background-process lifecycle and immediately return a managed job ID. Each integration must therefore block the turn, build its own job registry and completion delivery, or give up its typed tool contract and instruct the model to invoke the generic background shell tool.

## Baseline

Pi 0.82.1 `docs/extensions.md` defines custom tools as async `execute` functions returning one final tool result. It documents cancellation through the supplied `AbortSignal`, progress through `onUpdate`, process execution through `pi.exec`, and message delivery through `pi.sendMessage`, but no deferred/background tool-result contract or reusable job service. The installed `ToolDefinition.execute` type likewise returns `Promise<AgentToolResult<TDetails>>` with no background handoff result.

This harness already has a mature background lifecycle in `extensions/background-terminals/`: `BackgroundManager` provides stable `bg-*` IDs, an eight-job active limit, bounded retained stdout/stderr, inspection, cancellation with process-tree cleanup, shutdown disposal, and settlement callbacks; `index.ts` delivers automatic completion messages. That manager is private to the background extension, and its public tool accepts shell command text rather than a structured executable/argument request from another custom extension.

The source report records one external-review integration whose calls took tens of seconds to over a minute. Foreground latency caused the typed custom-tool implementation to be removed after substantive cancellation and subprocess work; a skill using the generic background tool then supplied the missing job lifecycle. The recurrence rate beyond this integration is not yet measured.

## Hypothesis

If local custom tools can submit a structured executable request to the existing background manager and immediately return its stable job ID, then slow integrations will preserve typed validation without blocking the agent turn or implementing a second job registry, because inspection, cancellation, bounded output, shutdown cleanup, and completion delivery remain owned by one lifecycle.

## Guardrails

- Keep the generic `background` tool and its current shell-command behavior compatible.
- The reusable handoff must accept executable plus argument array and explicit cwd; do not force custom tools to interpolate untrusted values into shell text.
- Return only after the process is registered and a stable job ID exists; never claim the underlying operation completed.
- Preserve active-job limits, retained-output bounds, process-tree cancellation, shutdown disposal, and exactly-once completion delivery.
- A foreground tool abort after successful handoff must not ambiguously orphan or double-cancel the registered job; define the ownership transition explicitly.
- Do not add a second registry, external queue, daemon, transcript store, generic scheduler, or remote execution protocol.
- Treat extension callers as trusted code, as Pi extensions already run with user permissions; do not present the broker as an OS sandbox.

## Options considered

1. **Keep skill-driven calls to the generic background tool:** Reuses the lifecycle now, but loses the custom tool's typed executable-specific contract and requires model-authored shell commands.
2. **Let every custom extension own detached jobs:** Maximum flexibility, but duplicates IDs, limits, cancellation, output retention, completion delivery, and shutdown behavior.
3. **Expose a narrow local broker backed by `BackgroundManager`:** Smallest harness-owned reuse path; custom tools validate domain inputs, submit executable/args/cwd/title, and return the managed ID. It adds a shared contract and requires careful reload and ownership tests.
4. **Wait for a Pi-native deferred tool API:** Best long-term ownership, but no such public contract exists in 0.82.1 and there is no committed availability date.

## Recommendation

Keep option 1 and park the broker. Reconsider option 3 when a new typed custom tool has a concrete need to return before a long-running operation settles and the generic skill/background-command path would materially lose validation, safety, or usability. Use that real integration as the representative fixture and acceptance case rather than building a broker speculatively.

If reconsidered, retain the narrow structured executable/args/cwd/title contract, one `BackgroundManager`, and the ownership boundary described above. If the required coupling cannot survive extension reload and shutdown without duplicate managers or lost completions, stop and wait for a Pi-native API rather than broadening the local runtime architecture.

## Scope

- **In:** Internal structured process request; stable job ID response; shared manager ownership; existing inspect/stop/completion paths; reload/shutdown semantics; one representative custom-tool fixture.
- **Out:** Arbitrary promise/task backgrounding, remote queues, persistence across Pi shutdown, interactive subprocesses, stdin streaming, retries, scheduling, new analytics, or a general extension service container.

## Acceptance criteria

- [ ] A fixture custom tool validates typed domain input, submits executable/args/cwd/title without shell interpolation, and returns a stable `bg-*` ID before the process settles.
- [ ] The submitted job appears in existing list/peek output and can be stopped through the existing background tool and commands.
- [ ] Stdout/stderr retention and rendered completion use the existing bounds and expose no additional unbounded output.
- [ ] Natural settlement produces exactly one automatic completion through the existing delivery path.
- [ ] Pre-registration cancellation starts no process; post-registration caller cancellation follows the documented ownership rule without orphaning or double settlement.
- [ ] Active-job limits and process-tree termination apply equally to generic background-tool and custom-tool jobs.
- [ ] Session shutdown terminates all owned jobs, and reload cannot leave duplicate managers, duplicate listeners, or jobs owned by stale extension state.
- [ ] Existing background tool calls, commands, renderers, and focused tests remain unchanged in meaning.

## Validation

- Add manager/broker tests for structured spawn, invalid cwd/executable, active limit, pre- and post-registration abort ordering, natural settlement, stop, and shutdown.
- Use an argument containing spaces and shell metacharacters and assert it reaches the executable as one literal argv element.
- Register a fixture custom tool, start a slow process, confirm the tool returns a job ID while the process is running, then inspect and cancel it through the existing interface.
- Test a short process for one automatic completion and no duplicate registry entry or completion message.
- Exercise reload/shutdown with a running broker-submitted process and assert deterministic cleanup with no stale listeners.
- Run the focused background-extension tests and `npm run check`.
- During evaluation, compare foreground wait, duplicated lifecycle code, orphaned jobs, and completion/cancellation failures with the source integration baseline.

## Evaluation

- **Window:** not started. After approved implementation, 10 broker-submitted jobs across at least 2 typed custom integrations, including 3 cancellations and 2 reload/shutdown cases, or 2026-08-20, whichever is later
- **Result:** pending (`keep` | `revise` | `revert` | `insufficient evidence`)

## Implementation and resolution

- **Approved implementation:** —
- **Merged change:** —
- **Resolution:** pending evaluation
