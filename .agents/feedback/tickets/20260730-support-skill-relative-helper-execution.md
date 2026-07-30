# HFM-20260730: Support skill-relative helper execution

- **Status:** parked
- **Approval:** not approved
- **Decision:** Parked 2026-07-30; one exercised skill does not yet justify a new execution primitive while the disclosed absolute skill directory is a reliable workaround
- **Created:** 2026-07-30
- **Source reports:** [HF-20260730: Bundled skill scripts require manual absolute-path construction](../inbox/20260730T092939Z-skill-scripts-require-absolute-paths.md)

<!-- Proposal and implementation approval are separate decisions. A proposed ticket does not authorize implementation. -->

## Problem

Pi documents bundled skill scripts and skill-relative references, but execution tools retain the user's project as their working directory. An invoked skill must therefore tell the agent to recover its disclosed installation directory, construct an absolute helper path, and quote that path while separately preserving the project cwd. The documented `./scripts/...` examples are not directly executable from an unrelated project cwd.

## Baseline

Pi 0.82.1 `docs/skills.md` says agents follow skill instructions using relative paths and shows `./scripts/process.sh`, while skill expansion discloses the absolute `SKILL.md` location and says references are relative to its directory. Neither the skills documentation nor the public extension documentation defines a skill-scoped executable resolver, PATH entry, or helper-entrypoint contract.

The only source observation is the `second-opinion` skill. Its launcher instructions require the agent to derive the skill directory from the loaded `SKILL.md`, build an absolute `scripts/run.sh` path, shell-quote it, and pass the user's project separately as the background cwd. That workaround succeeded, but the skill was redesigned twice while deciding whether the helper indirection was worthwhile. No execution failure or second independent skill has been recorded.

## Hypothesis

If Pi provides one explicit skill-asset execution contract that resolves a helper relative to the invoked skill while leaving tool cwd unchanged, then helper-bearing skills will no longer need installation-specific path-construction instructions, because asset identity and process cwd will be separate structured inputs.

This remains an assumption until at least two additional helper-bearing skills show the same cost or an upstream primitive establishes the contract at low maintenance cost.

## Guardrails

- Preserve the user's project as the default process cwd; do not silently run the helper from the skill directory.
- Resolve only assets belonging to a discovered, loaded skill and reject missing, ambiguous, non-file, or escaping paths before execution.
- Do not add skill `scripts/` directories globally to `PATH` or mutate the session process environment.
- Preserve normal executable permissions, cancellation, output bounds, and tool rendering.
- Do not infer an active skill from prose or retain a global “current skill” across turns.
- Do not combine this with a package manager, dependency installer, general asset database, or automatic script execution.

## Options considered

1. **Keep the disclosed absolute-directory pattern:** Available and deterministic now, but leaves quoting and installation-path mechanics in every helper-bearing skill.
2. **Add skill script directories to `PATH` or expose a mutable environment variable:** Familiar shell behavior, but ambiguous with multiple skills and easy to leak across turns or collide by filename.
3. **Add a structured skill-asset resolver/execution input:** Keeps skill identity, asset path, and project cwd separate and validates traversal, but expands a public tool or extension contract for a single observed use case.
4. **Inline helper commands in `SKILL.md`:** Avoids path resolution for small helpers, but duplicates logic and does not scale to nontrivial scripts or assets.

## Recommendation

Keep option 1 and park the proposal. Reconsider option 3 after either three independent helper-bearing skills require the same absolute-path ceremony, including at least one observed retry or portability defect, or Pi exposes an upstream structured skill-asset primitive that can be adopted without a local tool override. If reconsidered, prefer explicit skill name plus relative asset path and a separate cwd over PATH mutation or an ambient “current skill” variable.

## Scope

- **In:** Evidence threshold; structured resolution of one loaded skill's executable asset; separate project cwd; traversal and ambiguity errors; focused documentation and tests.
- **Out:** Global PATH changes, ambient active-skill state, package installation, automatic helper invocation, arbitrary untrusted skill execution, or changes to background-job lifecycle.

## Acceptance criteria

- [ ] A helper is selected by discovered skill identity and relative asset path without the caller supplying an installation-specific absolute path.
- [ ] The helper executes with the explicitly supplied project cwd, or the session cwd when omitted, rather than the skill directory.
- [ ] Missing skills, duplicate skill identities, missing/non-file assets, `..` escapes, symlink escapes, and non-executable assets fail before process creation with actionable errors.
- [ ] Two skills with the same helper filename cannot resolve to each other's assets.
- [ ] Cancellation, output truncation, and rendering remain equivalent to the underlying execution tool.
- [ ] Skills that use no helpers and ordinary Bash/background commands remain unchanged.

## Validation

- Add resolver tests for unique, missing, duplicate, traversal, symlink, file-type, and executable-permission cases.
- Run a fixture skill from a project outside the skill tree and assert both the resolved executable and unchanged project cwd.
- Run two fixture skills with identical `scripts/run.sh` names and prove identity-based selection.
- Exercise cancellation and oversized stdout/stderr through the chosen execution backend.
- Update the skills documentation with the supported contract and a portable example.
- Run focused tests and `npm run check`.
- During evaluation, compare helper-path retries and per-skill path-construction instructions with this one-skill baseline.

## Evaluation

- **Window:** not started; no implementation while parked. If revived and approved, 10 helper launches across at least 3 skills, or 2026-08-20, whichever is later
- **Result:** pending (`keep` | `revise` | `revert` | `insufficient evidence`)

## Implementation and resolution

- **Approved implementation:** —
- **Merged change:** —
- **Resolution:** parked 2026-07-30 pending the evidence threshold or a low-cost upstream primitive
