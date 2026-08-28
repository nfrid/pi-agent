# Dashboard command palette implementation note

Accepted direction as of 2026-08-28:

- Refactor the command palette and the existing new-thread project chooser to use the dashboard `DashboardSurface` controller and shared `SurfaceStack` shell before adding transcript search.
- Opening `New thread` from the palette replaces the palette surface with the project chooser, even when only one project exists. It is a handoff, not a nested palette submenu. Agent navigation uses the same chooser for multiple projects but retains its one-project direct-launch fast path.
- Keep the centered desktop palette and adaptive mobile utility-surface behavior. Dracula is the only supported theme; do not add light-theme or multi-theme accommodations.
- Keep focus in the palette search input. Track the active result by stable item ID and move through the rendered group order. Support Arrow Up/Down, Home/End, Page Up/Down, Enter, and Ctrl+J/Ctrl+K; outside the open surfaces, Ctrl/Cmd+K toggles the palette. Async result insertion must not silently move selection to another item.
- Escape clears a non-empty palette or project query first. A second Escape closes the surface; backdrop clicks always close it immediately.
- Search inputs expose one explicit gray clear button rather than the browser-native search cancel control.
- Use one client-side fuzzy-search implementation for commands, all ordinary thread metadata, projects, and other local catalogue items. Preserve explicit keywords and category grouping. Keep the queryless palette compact, but never cap the thread search index. Order matching threads as active, settled, archived; then by last activity and creation time. Use returned match ranges to highlight matched title and descriptive text.
- Do not run client-side fuzzy search over every transcript. Later message-content search belongs behind a bounded server API. Global results should include session identity, role, snippet, timestamp, entry identity, and ordinal so selection can jump to the exact transcript location. Current-transcript search should use the same exact-jump machinery and search the complete selected branch, including unloaded history.
- Keep the sidebar thread search as a fast metadata filter. The palette is global search; a session search bar will be current-transcript search.

Relevant implementation areas:

- `apps/dashboard-web/src/features/dashboard-surface-context.tsx`
- `apps/dashboard-web/src/app/route-shell.tsx`
- `apps/dashboard-web/src/features/surface-stack.tsx`
- `apps/dashboard-web/src/features/command-palette/`
- `apps/dashboard-web/src/features/agent-thread-nav.tsx`
- `apps/dashboard-web/src/entities/transcript/view/`
- `apps/dashboard-web/src/features/session/history.ts`
- `apps/dashboard-server/src/session-index.ts`
