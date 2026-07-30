# HF-20260730: Bundled skill scripts require manual absolute-path construction

- **Status:** parked
- **Observed date:** 2026-07-30
- **Source cwd/repo:** `/Users/nfrid/.pi/agent`
- **Task shape:** Replace a rarely used extension with an explicitly invoked global skill that launches a bundled helper in the background.
- **Harness component:** Skill execution and bundled scripts
- **Route / attempt / outcome:** A `scripts/run.sh` helper was bundled beside `SKILL.md`; Pi disclosed the skill base directory, but the agent still had to construct and shell-quote its absolute path because background commands run from the project and skill scripts are not added to `PATH`.
- **Observed cost / rework:** The helper indirection added path-resolution instructions and invocation complexity, leading to a second redesign that considered inlining the full command in `SKILL.md`.
- **Recurrence / confidence:** Likely for any portable skill with executable helpers; high confidence from Pi's documented expansion behavior and the exercised background invocation.
- **Ticket:** [HFM-20260730: Support skill-relative helper execution](../tickets/20260730-support-skill-relative-helper-execution.md)

## Behavior

Pi expands an invoked skill with its absolute location and a note that references are relative to the skill directory. It does not provide a direct executable-entrypoint mechanism or place the skill's `scripts/` directory on the command search path. Tool commands retain the user's project as their working directory, so `./scripts/helper` is not usable without changing away from the project or constructing an absolute path.

## Impact

Bundled helpers are less ergonomic and portable than the skill format suggests. Skills must teach the model to recover, interpolate, and quote an installation-specific absolute path, or duplicate the helper command inline. This is particularly awkward for background commands that must keep the project as `cwd` so external analysis sees the correct repository.

## Evidence

- Pi's skill expansion states `References are relative to <skill base directory>` and includes the absolute `SKILL.md` location.
- `docs/skills.md` supports bundled `scripts/` and relative references but documents no PATH or executable-entrypoint behavior.
- The exercised `second-opinion` skill needed an absolute `scripts/run.sh` path in its background shell command even though the helper was packaged with the skill.

## Smallest improvement

Provide and document one stable way for an invoked skill to execute a bundled helper by relative name while preserving the user's project working directory, without requiring the model to construct an installation-specific absolute path.
