# HF-20260809: Delegate handoff rejects a parent-visible delegate artifact

- **Status:** duplicate
- **Observed date:** 2026-08-09
- **Source cwd/repo:** `/Users/nfrid/.pi/agent`
- **Task shape:** Continue a writable implementation delegate with findings from an independent read-only review delegate.
- **Harness component:** `delegate` continuation and `handoffFrom`
- **Route / attempt / outcome:** A `luna-xhigh` writable continuation used `handoffFrom` with the review delegate's artifact handle; setup failed before launch because the artifact "was not found in the current session." Retrying without `handoffFrom` succeeded.
- **Observed cost / rework:** One failed delegate lifecycle attempt and manual restatement of the review findings in `contextNote`.
- **Recurrence / confidence:** Observed once with high confidence; likely whenever sibling delegate evidence must be forwarded to another child and artifact ownership is narrower than the parent session.
- **Ticket:** [HFM-20260805: Add schema-driven delegate outputs](../tickets/20260805-add-schema-driven-delegate-outputs.md)

## Behavior

An artifact returned to and retrievable by the parent session could not be forwarded through `handoffFrom` to a continuation of another delegate. The rejection occurred during delegate setup, not after the child began.

## Impact

Cross-review workflows cannot reliably pass exact bounded evidence between sibling delegates. The parent must retrieve and paraphrase the artifact, consuming context and risking loss of detail, or incur a failed setup attempt before discovering the scope restriction.

## Evidence

- The parent successfully retrieved the review artifact with `artifact_retrieve`.
- `delegate` continuation setup then reported: `Invalid handoffFrom artifact ...: it was not found in the current session`.
- The same continuation launched successfully after removing `handoffFrom` and copying the findings into `contextNote`.

## Smallest improvement

Allow artifacts visible to the parent owner session to be forwarded to any child launched by that parent, including continuations of sibling delegates. If isolation intentionally forbids this, validate and document the ownership boundary explicitly in the tool contract before an attempted launch.
