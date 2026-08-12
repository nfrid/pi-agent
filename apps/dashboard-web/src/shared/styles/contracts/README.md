# Dashboard global style contracts

`styles.css` is the ordered entrypoint for these sheets. The numeric prefixes are
intentional: the old cascade had later workspace/session refinements and
responsive overrides, so changing import order can change geometry.

These files remain global only for selectors that cross component boundaries:

- shell and typography primitives shared by routes and overlays;
- transcript/Markdown, activity, and virtual-row semantic classes;
- runtime state vocabularies (`status-*`, `context-*`, `priority-*`, and queue
  mode classes) emitted from data;
- extension contribution and dialog contracts shared by generic renderers;
- responsive, safe-area, visualViewport, minimap, and virtual transcript
  geometry contracts; and
- MDX editor theme overrides, which target third-party DOM.

Feature-owned presentation is colocated as CSS Modules. Semantic kebab-case
classes remain on those elements when they are runtime or browser-test
locators; module classes provide the local ownership without renaming those
contracts.
