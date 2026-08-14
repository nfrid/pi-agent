# Prompt Simplification Plan

## Goal

Make the effective prompt concise, truthful, and easy for a human to maintain.

Use this ownership rule throughout:

> Handwrite judgment and preferences in Markdown. Generate live capabilities from runtime data. Keep tool mechanics in schemas. Enforce invariants in code.

This is a cleanup, not a prompt-framework project. Prefer deletion and small conditional branches over new abstractions.

## Decisions

### Human-authored instructions

Use plainly named Markdown surfaces:

```text
instructions/
  agent/
    working-style.md
    interaction.md
    tool-use.md
extensions/
  delegate/
    instructions.md
    jobs-instructions.md
    branches-instructions.md
```

This repo is the global Pi agent configuration, so a separate `personal` category adds no useful meaning. `instructions/agent/` is the durable global agent policy. Extension-owned Markdown stays beside the extension that loads it.

Keep extension code and instruction files close in ownership. A short comment at the loading site should name the Markdown source. `/prompt-info` should report canonical agent instruction files; extension tool guidelines remain attached to their registered tools.

Rules:

- Each `.md` file is an independently editable instruction part with a narrow, obvious purpose.
- Files are loaded by explicit path, not discovered through a registry or recursive directory scan.
- Canonical agent Markdown is inserted verbatim after trimming outer whitespace. Extension-local guideline files contain only `- ` bullets, which `loadGuidelines` returns as individual prompt guidelines.
- No frontmatter, JSON, YAML, manifests, IDs, priorities, templating language, or token-budget configuration.
- Missing required instruction files should fail clearly rather than silently changing agent behavior.
- Do not add an extra content cache. Canonical agent-policy edits apply on the next turn; extension-owned tool-policy edits apply after Pi reloads the extension.
- `/prompt-info` reports canonical agent instruction sources; extension-local guidelines stay owned and tested with their tools.

Do not move every prompt-adjacent string into Markdown. Use Markdown for meaningful workflow preferences a human is expected to refine: working style, communication policy, delegation judgment, and tool-specific judgment. Keep completion contracts, route-selection policy, short tool descriptions, validation messages, labels, and generated capability facts in TypeScript when they are mechanical and coupled to extension behavior.

The canonical builder should continue to avoid arbitrary `customPrompt` and `appendSystemPrompt` strings for now. They create a second, less inspectable authority path. Replace the current implication that they are accidentally ignored with an explicit tested decision that human-authored global policy comes from `instructions/`.

### Prompt ownership

Each instruction should have one primary owner:

- `instructions/agent/*.md`: durable global judgment, working style, communication, autonomy, verification, and delegation preference.
- `extensions/<feature>/*instructions.md`: human-authored workflow preferences owned by that extension.
- `AGENTS.md`: repository-specific conventions and required checks.
- Tool description: detailed mechanics, lifecycle, side effects, and usage context that schemas cannot express cleanly.
- Tool schema: actions, parameters, defaults, limits, and combinations.
- Runtime code: hard invariants and safety boundaries.
- Generated prompt text: current tools, route catalog data, mode, branch/worktree facts, result schema, date, cwd, and other live capabilities.
- Skills: detailed conditional workflows loaded only when relevant.

Do not copy a rule into several layers for emphasis. If a schema or runtime error already communicates a mechanic, it normally does not also need a global guideline.

## Implementation sequence

### 1. Fix delegate completion and capability claims

Keep the existing delegate prompt builder unless a small internal helper materially improves readability. Do not create parallel prompt frameworks.

Change `extensions/delegate/prompt.ts` so its completion section is conditional:

- Prose delegates receive the compact `Outcome`/`Conclusion` report contract.
- Structured delegates receive only the `delegate_result` completion contract and no prose report format, word target, or prose final-response instruction.
- Keep retry limits and the result schema generated from the actual structured-result configuration.

Replace the writable-child isolation claim with truthful generated facts:

```text
Repository checkout: isolated Git worktree on branch <branch>.
Repository writes: allowed.
Shell and external side effects are shared and are not sandboxed.
Do not modify services, databases, global configuration, or paths outside the
checkout unless the task explicitly requires it.
```

Use similarly direct language for read-only shared and worktree delegates. State that writes are forbidden by policy and Bash is available for inspection, not that Bash is an enforced sandbox.

Tests must cover:

- writable prose delegate;
- read-only shared delegate;
- read-only worktree delegate;
- structured delegate;
- no prose report contract in a structured prompt;
- no claim that external or shell side effects are isolated.

### 2. Clarify background mechanics and waiting behavior

Keep one background tool with a provider-compatible root object schema. Describe every action in the action enum and mark action-specific fields as required in their descriptions; runtime validation remains the enforcement fallback.

Keep a detailed top-level TypeScript description for shell invocation, no-stdin behavior, session cleanup, bounded output, ordinary-bash usage, and automatic completion. Do not repeat the action catalog there.

Keep one extension-local workflow guideline: when a background process is the only remaining dependency, end the turn with one short waiting notice without a recap or polling. Completion already triggers the next turn; do not add `/wait`, hidden wait markers, or a manual waiting protocol.

### 3. Add the Markdown instruction surface

Add one small shared helper that accepts an explicit path under the agent directory, reads it, trims outer whitespace, and returns its source path plus exact content for composition and diagnostics. It does not discover files, interpret metadata, cache content, or manage precedence.

Load `instructions/agent/working-style.md`, `interaction.md`, and `tool-use.md` explicitly from `extensions/system-prompt/`.

Render the combined agent policy once in a clearly named section such as:

```text
<agent_instructions>
...
</agent_instructions>
```

Do not add per-file wrappers to the model-visible prompt. File paths belong in diagnostics, not in prompt prose.

Create the initial files by moving and simplifying the human judgment currently hardcoded in `composition.ts`:

- `working-style.md`: prefer the simplest correct implementation, resist abstractions and ceremony, keep changes focused, resolve ordinary ambiguity, verify consequential work, and delegate only when the benefit exceeds handoff cost.
- `interaction.md`: be concise and result-first, avoid over-explaining routine work, and announce only substantial changes of direction.

The working-style policy must explicitly counter the observed failure mode:

```text
Prefer the simplest correct implementation. Do not introduce abstractions,
frameworks, compatibility layers, configuration, or extra files unless they
solve a concrete current need. When two approaches are equally correct, choose
the smaller and clearer one.
```

The interaction policy must explicitly counter verbosity:

```text
Be concise and direct. Lead with the result. Do not restate the request,
narrate routine work, or explain obvious details. Add explanation only when it
changes a decision, exposes a material trade-off, or records a verification gap.
```

Keep each rule compact but descriptive enough to guide behavior. Prefer a few strong instructions over long catalogs of edge cases. Remove grammatical micromanagement such as mandatory English `-ing` forms and exact forbidden opening words.

Tests must cover:

- missing required file fails clearly;
- exact content included once;
- agent instructions appear in both interactive and headless prompts;
- diagnostics list each contributing source and its size;
- generic direct prompt inputs remain intentionally unsupported.

### 4. Move substantial extension policy to Markdown and trim it

Make focused moves and deletions; do not redesign tool registration or externalize trivial strings.

#### Delegate policy

Keep the concise parent workflow preferences in the bullet-only extension-local `extensions/delegate/instructions.md`, loaded with `loadGuidelines` into the delegate tool's parent prompt guidelines. Keep jobs and branches judgment in their focused extension-local `jobs-instructions.md` and `branches-instructions.md` files. Keep prose and structured child completion contracts in clearly named top-level TypeScript constants beside `buildDelegatePrompt`, and keep route-selection policy in a top-level TypeScript constant beside the generated route catalog. Keep task text, branch names, timeout, result schema, route rows, and capability facts generated in TypeScript; do not add a template engine.

Reduce the parent policy to the rules that require judgment:

1. Delegate when parallelism, specialization, latency hiding, or context isolation exceeds briefing and integration cost.
2. Give the child a concrete deliverable, relevant constraints/context, and a finish condition or verification command.
3. Parallelize only independent work; use background when parent work can continue.
4. Continue the same child for follow-up or blockers; use a fresh child for independent evidence.
5. The parent owns decisions, integration, and final verification.

Retain generated route rows. Replace the routing ontology essay with a short rule:

```text
Choose the cheapest route whose stated use fits the task. Prefer stronger
reasoning for ambiguous, cross-cutting, or consequential decisions. Prefer
cheaper routes for bounded work with an objective finish condition.
Continuations reuse the previous route unless explicitly overridden.
```

Keep parameter mechanics in the existing schemas and validation errors.

#### Other tools

Review todo, structured result, edit, branch, and background contributions using this test:

- Is this a cross-call judgment? Keep one concise guideline.
- Is this an action, parameter, default, limit, or invalid combination? Leave it to schema/runtime.
- Is the same instruction already present elsewhere? Keep only its clearest owner.

For structured result, the structured TypeScript contract plus terminating runtime behavior should own completion. Remove repeated global guidelines that add no judgment.

Use extension-local Markdown when a tool has genuine human workflow preferences, as todo, ask-user, background, and delegate do. Keep purely mechanical tools in TypeScript rather than creating empty or ceremonial instruction files.

Do not chase a numeric token target. The success criterion is removal of duplication and contradictions while retaining necessary judgment. Implementation code should also remain small: a direct file-read helper and straightforward composition are preferable to generic loaders, registries, or abstractions.

### 5. Suppress genuinely empty todo state

Change todo context injection so a fresh session with no todo history and no tasks contributes no snapshot message.

Preserve correctness when todo state previously existed:

- non-empty state must still be represented;
- clearing prior state must not leave a stale non-empty snapshot as the newest model-visible state;
- compaction/tree recovery must retain the current state when there is state to recover.

Use the smallest condition that satisfies those cases. Do not introduce a general runtime-state framework.

Tests must cover:

- fresh empty state injects nothing;
- active state injects a snapshot;
- previously used then cleared state does not expose stale tasks;
- recovery with active state still works.

### 6. Reassess the compiled prompt

After the preceding changes, inspect representative compiled prompts:

- TUI with normal tools;
- headless mode;
- prose read-only child;
- prose writable child;
- structured child;
- empty todo state;
- active todo state.

Compare before and after size, but judge the result primarily by:

- no contradictory completion contracts;
- no false isolation claims;
- no `/wait` command or manual waiting protocol;
- no empty todo noise;
- human preferences are editable as plain Markdown;
- generated facts still come from current runtime configuration;
- tool mechanics are not repeated as global prose.

Run focused tests during implementation, then finish with:

```bash
pnpm run check
```

## Delivery order

Use small reviewable commits:

1. `fix(delegate): clarify completion and isolation contracts`
2. `fix(background): clarify action mechanics and waiting guidance`
3. `feat(system-prompt): load human instructions from markdown`
4. `refactor(prompt): remove duplicated tool guidance`
5. `fix(tasks): omit unused empty todo context`

Commits may be combined when changes are inseparable, but do not combine this work with unrelated prompt, dashboard, or runtime redesigns.

## Explicit non-goals

Do not add any of the following unless the post-cleanup prompt demonstrates a concrete need:

- typed prompt-contribution registries;
- semantic directive graphs or conflict solvers;
- JSON/YAML prompt configuration;
- frontmatter or a prompt templating language;
- per-part priorities or token budgets;
- recursive prompt discovery or an instruction registry;
- file watchers or caches;
- structured phase metadata;
- a new compaction system;
- a new background waiting mechanism;
- broad skill restructuring;
- restoration of arbitrary append/replacement prompt strings.

## Definition of done

The work is complete when:

- delegate prompts are truthful and have exactly one completion contract;
- background completion is automatic and an idle parent emits only a short waiting notice;
- global agent policy lives under `instructions/agent/`, while extension workflow policy lives beside the owning extension;
- hardcoded human judgment moved into those files is concise and no longer duplicated in mechanical descriptions or schemas;
- the implementation uses direct composition rather than a generic prompt framework;
- the most repetitive tool guidance has been removed without losing required behavior;
- unused empty todo state is absent from model context;
- prompt diagnostics expose the human-authored instruction sources;
- representative prompt tests and `pnpm run check` pass.
