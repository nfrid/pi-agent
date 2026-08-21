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

For the first UI pass, dormant sessions continue to populate a compact **History** shelf. We must not rename that shelf to **Settled** or persist settlement inferred from runtime absence. Explicit settle and unsettle can be added later as durable lifecycle commands.

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
6. Render dormant threads as compact rows in a collapsible **History** shelf.
7. Keep archived threads reachable in a compact collapsed shelf until a dedicated archived view exists.
8. Keep existing context-menu actions, unread state, runtime controls, timestamps, and keyboard search behavior.
9. Make the new-thread route look like an empty real thread: normal workspace header, blank transcript area, and the same composer at the bottom. Remove the centered onboarding illustration and copy.
10. Preserve the current server contracts. This slice is primarily component structure, presentation, and client-side grouping.

### Follow-up lifecycle work

Add only when requested or when the copied UX requires it:

- persisted pin ordering and drag reordering;
- explicit settle and unsettle;
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
- No inferred settlement.
- No new lifecycle database tables or protocol commands.
- No T3 dependency stack, Tailwind migration, or wholesale component copy.
- No project favicon, pull-request, terminal-process, or environment artwork work.
- No deployment until focused tests and browser checks pass and the branch is explicitly approved for production.

## Design rules

- Reuse `AgentThreadNav`, its existing queries, and its action wrappers.
- Keep row derivation in `agent-thread-nav/model.ts`; keep DOM and interaction state in `agent-thread-nav.tsx`.
- Use the dashboard's CSS tokens and CSS Modules. Recreate the T3 hierarchy, density, hover behavior, and responsive shell rather than importing its UI framework.
- A pinned thread appears once, above unpinned active and history rows.
- Search ignores shelf collapse and searches every visible session identity.
- The selected thread remains reachable when it falls beyond the initial history page.
- Unsupported lifecycle actions stay hidden. The UI must not offer an action that will fail because the session lacks an exact durable link.
- Desktop and mobile render the same semantic sidebar content.

## First-slice acceptance checks

### Unit and component behavior

- Grouping produces pinned, active, history, and archived sections without duplicates.
- Workspace scope filters all sections consistently.
- Search still supports clear, ArrowUp, ArrowDown, Enter, and Escape.
- Existing pin, archive, unread, stop, and restart actions remain wired.
- The selected deep-history session remains rendered.
- New-thread submission still starts a runtime, supports model/thinking selection and images, and navigates to the created session.

### Browser behavior

- Desktop sidebar is full-height and no longer reads as a floating card.
- Mobile sidebar opens, traps focus, closes by backdrop/Escape/swipe, and exposes the same controls.
- Search, workspace scope, new thread, active selection, collapsed history, and context menus work at desktop and mobile widths.
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
