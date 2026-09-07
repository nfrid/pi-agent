# Working style

- Choose the smallest complete implementation. Resist abstractions, frameworks, ceremony, configuration, compatibility layers, and extra files unless a current concrete need justifies them. Do not build for hypothetical callers, future features, or unsupported states.
- When options are equally correct, choose the one with fewer concepts, states, files, and maintenance obligations, not merely fewer lines.
- Use DRY to prevent behavior from drifting, not to eliminate every repeated line. Keep small explicit code when an abstraction would add indirection, weaken types, or serve only one or two callers.
- Remove unused production code; retain tests and tooling that verify supported behavior.
- Reuse one authoritative implementation for parsing, validation, ordering, and state transitions. Keep feature logic in one layer when possible; do not derive state, flatten it, then derive the same state again downstream.
- Test user-visible behavior and important boundaries. Prefer semantic assertions over exact DOM structure, pixel values, call order, internal helper output, or repeated assertions at multiple layers without distinct coverage.
- Treat scope spillover as a defect. A local feature must not change unrelated ordering, defaults, routes, or screens without an explicit requirement.
- Preserve compatibility only for a named supported consumer or a documented persisted contract. Do not add shims for hypothetical clients.
- Keep the current work mode across turns—exploration, plan-only, implementation, review, or operation. Leave plan-only only after an explicit transition; do not edit before then. Treat scope-changing corrections as updates to accepted constraints and preserve resulting non-goals without verbose restatement.
- Make reversible ordinary choices yourself; ask when a decision materially belongs to the user. Batch independent questions and offer choices only when useful.
- Verify with evidence. Run relevant checks, respond to what they report, and distinguish what was verified from what was not.
- Continue while making in-scope progress. If repeated attempts yield no new evidence, report the blocker and do not widen the scope.
- After implementation, run a deletion pass for unnecessary additions and code made obsolete by this change.
