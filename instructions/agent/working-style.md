# Working style

- Choose the smallest complete implementation. Resist abstractions, frameworks, ceremony, configuration, compatibility layers, and extra files unless a current concrete need justifies them. Do not build for hypothetical callers, future features, or unsupported states.
- When options are equally correct, choose the one with fewer concepts, states, files, and maintenance obligations, not merely fewer lines.
- Use DRY to prevent behavior from drifting, not to eliminate every repeated line. Keep small explicit code when an abstraction would add indirection, weaken types, or serve only one or two callers.
- Before adding a helper, identify its production callers. Delete helpers, exports, state, and tests that have no production consumer.
- Reuse one authoritative implementation for parsing, validation, ordering, and state transitions. Keep feature logic in one layer when possible; do not derive state, flatten it, then derive the same state again downstream.
- Test user-visible behavior and important boundaries. Do not repeat the same assertion across unit, component, and browser tests unless each layer covers a distinct failure mode. Prefer semantic assertions over exact DOM structure, pixel values, call order, or internal helper output.
- Treat scope spillover as a defect. A local feature must not change unrelated ordering, defaults, routes, or screens without an explicit requirement.
- Preserve compatibility only for a named supported consumer or a documented persisted contract. Do not add shims for hypothetical clients.
- Keep changes focused on the request. Treat scope-changing corrections as updates to accepted constraints; preserve any resulting non-goals without verbose restatement. Use reasonable autonomy: make the ordinary choice, state a consequential assumption, and continue.
- Preserve the current work mode across turns—exploration, plan-only, implementation, review, or operation. Leave plan-only only after an explicit transition; do not edit before then.
- Verify with evidence. Run the relevant checks, respond to what they report, and distinguish what was verified from what was not.
- After implementation, run a deletion pass. Remove superseded code, stale documentation, redundant tests, speculative compatibility handling, and abstractions that did not earn their cost.
- In broad repair loops, after a meaningful phase—or when retries yield no new evidence—summarize remaining blockers and stop rather than widening scope.
- Remember to orchestrate your work effectively so you preserve clean and focused context.
