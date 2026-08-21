# T3-style thread sidebar

## Goal

Adapt the thread sidebar UX from T3 Code to the Pi dashboard without importing T3's application architecture or pretending unsupported lifecycle states exist.

The dashboard should have one consistent thread workspace for browsing, starting, and resuming work. A new thread should begin in the same main surface used by an existing thread instead of opening a separate onboarding-style screen.

## Current facts

### Session and thread identity

Normal historical sessions are not an unresolved compatibility problem.

At dashboard startup, `SessionIndex.list()` returns ordinary file-backed sessions and `ensureSessionThreadLinks()` creates a durable technical thread and exact `session_thread_link` for every session that does not already have one. Existing orchestration runs keep their exact thread identity. The migration and startup path therefore cover old and newly indexed ordinary sessions.

The remaining exceptions are deliberate:

- auxiliary sessions are excluded from the ordinary session list;
- a reused session ID whose source file changed is quarantined;
- ambiguous many-to-one run/session identities are not guessed;
- a just-connected runtime can appear before its session is indexed.

These cases should remain usable in the sidebar, but lifecycle actions may be absent until the identity is exact. We should not add another compatibility store for them.

### Dormant and settled are different

`dormant` describes current execution availability: the session is indexed but has no live runtime. `settled` is a user decision to park work while retaining it in the sidebar. A settled thread could still have runtime activity, and a dormant thread may still need attention.

Dormant sessions are unavailable runtimes, not a lifecycle decision. Every unarchived, unpinned, unsettled session—including dormant and offline sessions—renders in **Active**. No lifecycle state is inferred from runtime absence. Explicit settle and unsettle are implemented as durable lifecycle commands; settlement is independent of execution availability.

### Existing lifecycle coverage

Every exactly linked ordinary session can already use durable pin, unpin, archive, and restore commands. Pin ordering is newest-first because the model has `pinnedAt` but no explicit order key.

Session rename already exists in the transcript header. This project will not duplicate inline rename in the sidebar.

## Scope

### First implementation slice

1. Replace the floating card treatment with a full-height thread sidebar on desktop and the same content in the existing mobile drawer.
2. Add a compact fixed header with search and a prominent new-thread action.
3. Replace expanded workspace blocks with a workspace scope control. Keep an "All workspaces" option.
4. Render globally pinned threads first as full rows/cards.
5. Render active threads as full rows/cards with Pi's existing status vocabulary.
6. Render unpinned settled threads in a Settled shelf between Active and Archived; archived and pinned rows retain precedence.
7. Render dormant and offline threads in **Active**, retaining status ordering and the bounded Show-next disclosure for large lists.
8. Keep archived threads reachable in a compact collapsed shelf until a dedicated archived view exists.
9. Keep existing context-menu actions, unread state, runtime controls, timestamps, and keyboard search behavior.
10. Make the new-thread route look like an empty real thread: normal workspace header, blank transcript area, and the same composer at the bottom. Remove the centered onboarding illustration and copy.
11. Preserve existing server contracts while using the additive durable lifecycle contracts for pin, archive, settle, and restore. This slice is primarily component structure, presentation, and client-side grouping.

### Follow-up lifecycle work

Add only when requested or when the copied UX requires it:

- persisted pin ordering and drag reordering;
- snooze, wake, and a snoozed shelf;
- sidebar draft persistence and draft rows;
- multi-select and bulk actions;
- dedicated archived-thread management;
- complete deletion;
- generated titles;
- richer optional metadata such as branch or model details.

## Non-goals for the first slice

- No title regeneration.
- No sidebar rename control.
- No complete deletion.
- No inferred settlement; runtime absence only makes a thread dormant/offline.
- Settlement uses one nullable thread column and lifecycle events; no new lifecycle table or status enum member.
- No T3 dependency stack, Tailwind migration, or wholesale component copy.
- No project favicon, pull-request, terminal-process, or environment artwork work.
- No deployment until focused tests and browser checks pass and the branch is explicitly approved for production.

## Design rules

- Reuse `AgentThreadNav`, its existing queries, and its action wrappers.
- Keep row derivation in `agent-thread-nav/model.ts`; keep DOM and interaction state in `agent-thread-nav.tsx`.
- Use the dashboard's CSS tokens and CSS Modules. Recreate the T3 hierarchy, density, hover behavior, and responsive shell rather than importing its UI framework.
- The sidebar has separate **Pinned**, **Active**, **Settled**, and **Archived** sections. Pinned threads appear once above unpinned Active rows; dormant and offline rows remain in Active.
- Search ignores Archived collapse and searches every visible session identity.
- The selected thread remains reachable when it falls beyond the initial Active bound.
- Unsupported lifecycle actions stay hidden. The UI must not offer an action that will fail because the session lacks an exact durable link.
- Desktop and mobile render the same semantic sidebar content.

## Dormant active-thread slice

The accepted follow-up keeps the normal composer shell for dormant sessions and attaches a compact notice: **This session is dormant** / **Sending a message will resume Pi in this workspace.** Indexed sessions may expose optional last-known provider/model, thinking effort, and assistant context-token hints from the latest leaf ancestry. Runtime values remain authoritative; dormant rows prefer these hints, then the same configured/default model choices used by New Chat. Missing values remain honest (`? effort`, `? ctx`, or a resume fallback), and CWD is never restored.

A text submission starts the existing runtime with `workspaceId`, `sessionId`, and `initialPrompt` exactly once. For an explicitly image-capable indexed model, the dashboard starts without an initial prompt, waits for the connected runtime through `DashboardLiveStore`, verifies that runtime's image capability, and sends the prompt plus attachments once. Drafts and attachments stay intact on any failure and clear only after success. Image support fails closed unless the indexed model matches a current runtime model/catalog entry marked `supportsImages: true`. Missing workspace association remains a disabled error case. Image delivery intentionally uses the existing command transport; its pre-existing ACK-timeout retry limitation remains a residual exact-once risk and is not expanded with a new receipt endpoint. Explicit durable Settled state is now implemented through the additive lifecycle command, thread metadata, session-thread-link projection, and lifecycle event contracts; settlement remains independent of runtime availability and does not introduce a new status enum.

## First-slice acceptance checks

### Unit and component behavior

- Grouping produces Pinned, Active, Settled, and Archived sections without duplicates; dormant and offline rows are in Active.
- Workspace scope filters Pinned, Active, Settled, and Archived consistently.
- Search still supports clear, ArrowUp, ArrowDown, Enter, and Escape.
- Existing pin, archive, unread, stop, and restart actions remain wired.
- The selected deep-Active session remains rendered.
- New-thread submission still starts a runtime, supports model/thinking selection and images, and navigates to the created session.

### Browser behavior

- Desktop sidebar is full-height and no longer reads as a floating card.
- Mobile sidebar opens, traps focus, closes by backdrop/Escape/swipe, and exposes the same controls.
- Search, workspace scope, new thread, Active selection, collapsed Archived, and context menus work at desktop and mobile widths.
- The new-thread surface uses the normal thread workspace geometry and bottom composer.

### Validation

Run the narrow checks first:

```sh
pnpm --filter @pi-dashboard/web test
pnpm --filter @pi-dashboard/web typecheck
pnpm exec biome check apps/dashboard-web/src/features/agent-thread-nav.tsx \
  apps/dashboard-web/src/features/agent-thread-nav/model.ts \
  apps/dashboard-web/src/features/agent-thread-nav.module.css \
  apps/dashboard-web/src/features/new-chat.tsx \
  apps/dashboard-web/src/features/new-chat.module.css
```

Then run focused Playwright coverage using isolated ports as described in `docs/dashboard-deployment.md`.

## Licensing

T3 Code is MIT licensed. This implementation should recreate the UX in the Pi dashboard's existing components. If substantial T3 source is copied later, retain the T3 Tools Inc. copyright and MIT notice in an appropriate third-party notice.
