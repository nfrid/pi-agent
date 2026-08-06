# HFM-20260806: Redact secret-bearing tool output

- **Status:** parked
- **Approval:** not approved
- **Created:** 2026-08-06
- **Source reports:** [HF-20260806: Command output can expose secret-bearing process environments](../inbox/20260806T093756Z-tool-output-secret-redaction.md)
- **Decision:** Parked 2026-08-06 until a concrete accidental disclosure demonstrates that best-effort environment-name redaction is worth its incomplete coverage, false positives, and added complexity

<!-- Proposal and implementation approval are separate decisions. A proposed ticket does not authorize implementation. -->

## Problem

Diagnostic commands can unexpectedly return serialized process environments containing credentials. Verbatim tool results then expose those values to model context and session persistence even when the caller did not request secret files or intentionally print environment variables.

## Baseline

A bounded macOS `log show` query returned a RunningBoard job description containing values for environment keys matching `*_TOKEN` and `*_API_TOKEN`. The report states that those credential values entered model-visible Bash output. Current local background-terminal sanitization in `extensions/background-terminals/format.ts` removes terminal controls and bounds output but does not redact secrets; ordinary Bash results are supplied by the upstream tool. No existing feedback ticket covers output-boundary credential redaction. Delegate HOME and worktree-environment tickets concern which environment reaches child processes, not filtering returned tool output.

## Hypothesis

If environment-assignment values whose key names strongly indicate credentials are redacted at a common tool-result boundary before display, model exposure, artifacts, or session persistence, then routine process and log diagnostics will preserve useful structure without leaking those values. This is falsified if a seeded credential survives in any stored or displayed result representation, or ordinary non-secret output is materially altered.

## Guardrails

- Redact values while preserving key names, delimiters, and enough structure for diagnostics.
- Apply redaction before model exposure, tool details, artifact creation, and session persistence; post-display cleanup is insufficient.
- Cover ordinary Bash and background Bash consistently through a shared or equivalent policy.
- Match conservative environment-assignment structures and strong secret key markers; do not replace ordinary prose merely because it contains words such as `token` or `secret`.
- Handle case variants and common shell, JSON, plist, and RunningBoard-style representations without attempting to become a universal data-loss-prevention system.
- Preserve output caps, Unicode correctness, and terminal-control sanitization.
- Do not log, hash, summarize, or otherwise retain the removed value.
- Treat rotation of credentials exposed before this change as an operational action outside this ticket.

## Options considered

1. **Pre-persistence tool-result redaction for credential-like environment assignments:** Addresses unpredictable diagnostics at the containment boundary, but requires careful syntax coverage and false-positive tests.
2. **Require command-side filters:** Simple when output is predictable, but the reported system log unexpectedly embedded an inherited environment and had already exposed the values before a later filter could act.
3. **Redact arbitrary high-entropy strings or all values near secret words:** Broader coverage, but likely destroys legitimate logs and creates an unbounded DLP design.
4. **Document safer diagnostic commands only:** Useful defense in depth, but cannot prevent surprise environment serialization or protect persisted results.

## Recommendation

Implement option 1 narrowly at the earliest modifiable common tool-result boundary. Recognize bounded environment-assignment forms with key names containing strong markers such as token, password, secret, API key, credential, or private key, replace only the value with `[REDACTED]`, and apply the same tested policy to Bash and background Bash before any result representation is retained.

## Scope

- **In:** Credential-like environment-key matching; shell, JSON, plist, and RunningBoard-style assignment forms; ordinary and background Bash result paths; pre-persistence replacement; false-positive and representation tests; concise policy documentation.
- **Out:** Universal secret scanning; entropy detection; prompt/input redaction; file-at-rest scanning; credential rotation; arbitrary binary formats; provider-side retention guarantees; rewriting historical sessions.

## Acceptance criteria

- [ ] Values assigned to case-insensitive credential-like environment keys, including token, API key, password, secret, credential, and private-key variants, are replaced with `[REDACTED]` in supported shell, JSON, plist, and RunningBoard-style forms.
- [ ] The key name and surrounding diagnostic structure remain visible.
- [ ] Seeded raw values do not occur in model-visible content, tool-result details, artifacts, background completion output, or persisted session data.
- [ ] Ordinary Bash and background Bash apply equivalent redaction before truncation or storage.
- [ ] Quoted, escaped, multiline, Unicode, and mixed-case fixtures cannot bypass the supported assignment forms.
- [ ] Ordinary prose, non-secret identifiers, numeric counters, and words containing marker substrings without an assignment remain unchanged.
- [ ] Redaction remains correct at truncation boundaries and across parallel tool results.
- [ ] Unsupported or ambiguous structures are documented rather than claimed as universally protected.

## Validation

Use deterministic seeded canary values in shell exports, `KEY=value` listings, JSON objects, plist-like records, and captured RunningBoard-style job descriptions. Include quoted, escaped, multiline, Unicode, mixed-case, truncation-boundary, parallel-result, and false-positive fixtures. Search every returned content/details/artifact/session representation for each canary, verify preserved structure and unchanged normal output, then run focused Bash/background-output and session-persistence tests plus `npm run check`.

## Evaluation

- **Window:** After an approved merge, the first 20 process, crash, or system-log diagnostic commands likely to contain environment data, or 2026-10-15, whichever is later
- **Result:** pending (`keep` | `revise` | `revert` | `insufficient evidence`)

Compare with the baseline where one routine diagnostic exposed multiple credential values. Keep only if no seeded or known credential value reaches any harness result representation during the window, supported assignment forms retain useful structure, and false-positive redactions are recorded and remain rare enough not to impede diagnosis.

## Implementation and resolution

- **Approved implementation:** —
- **Merged change:** —
- **Resolution:** pending evaluation
