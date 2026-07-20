# web

A focused, locally maintained web extension for Pi. It was forked from
[`pi-web-access` v0.13.0](https://github.com/nicobailon/pi-web-access/tree/v0.13.0)
(commit `7bdc30a65cf77273eb9c0034647b373bda4060d7`) and retains its MIT license.

This fork intentionally supports only:

- **OpenAI web search** through `OPENAI_API_KEY`, `openaiApiKey` in config, or
  Pi's existing OpenAI/Codex login.
- **Exa search** through `EXA_API_KEY`, `exaApiKey` in config, or Exa's keyless
  hosted MCP endpoint.
- Readable HTTP(S) page extraction with Readability, Next.js RSC parsing, and a
  Jina Reader fallback.

It does not include the upstream curator UI, Gemini/browser-cookie access,
Brave, Parallel, Tavily, Perplexity, videos/YouTube, PDFs, or GitHub cloning.

## Tools

### `web_search`

Search one query or several queries. The extension uses an available
OpenAI/Codex login first and falls back to Exa automatically. Optional parameters
are `numResults` (1–20), `recencyFilter`, `domainFilter`, and `includeContent`.
Prefix excluded domains with `-`.

Provider selection is intentionally internal: callers ask for web results rather
than coupling themselves to provider availability or implementation details.

```ts
web_search({ query: 'Pi coding agent SDK' });
web_search({
  queries: ['TypeScript 5.8 release notes', 'TypeScript 5.8 migration issues'],
  includeContent: true,
});
```

### `fetch_content`

Fetch one URL or several URLs in parallel and extract readable Markdown.
Binary media and PDFs are deliberately unsupported.

```ts
fetch_content({ url: 'https://example.com/article' });
fetch_content({ urls: ['https://example.com/a', 'https://example.com/b'] });
```

### `get_search_content`

Results are stored for the current session and, when artifact persistence
succeeds, restored from the Pi session by the returned `responseId`. Retrieve
them by `responseId`, selecting a query/page by index or exact query/URL. Page
content from a search is available when that search used `includeContent: true`.

```ts
get_search_content({ responseId: 'abc123', view: 'summary', offset: 30000 });
get_search_content({ responseId: 'abc123', queryIndex: 0 });
get_search_content({ responseId: 'abc123', queryIndex: 0, urlIndex: 0 });
get_search_content({ responseId: 'abc123', urlIndex: 0, offset: 12000 });
get_search_content({ responseId: 'abc123', urlIndex: 0, heading: 'Details' });
get_search_content({ responseId: 'abc123', urlIndex: 0, literal: 'needle' });
```

Retrieval returns at most 12,000 characters by default. Its metadata includes a
SHA-256 hash, exact UTF-16 offsets, selected/remaining counts, and `nextOffset`
for lossless paging. Use `view: 'summary'` to continue the exact aggregate
`web_search` output or multi-URL `fetch_content` summary. `maxChars` can raise
the bound up to 100,000; heading and literal selectors narrow page text. Tool
responses inline at most 30,000 characters; stored content remains full and
unchanged.
In Pi's TUI, results are rendered as Markdown with a compact preview. Use the
normal tool-expansion keybinding to show the full rendered result.

## Authentication and configuration

Environment variables take precedence:

```sh
export OPENAI_API_KEY=sk-...
export EXA_API_KEY=exa-...
```

Alternatively create `~/.pi/web-search.json` (or `web-search.json` under
`PI_CODING_AGENT_DIR`; under `$XDG_CONFIG_HOME/pi` when set):

```json
{
  "openaiApiKey": "sk-...",
  "exaApiKey": "exa-...",
  "ssrf": {
    "allowRanges": ["198.18.0.0/15"]
  }
}
```

No key is needed for Exa MCP. OpenAI can reuse a Pi `/login` Codex session.
`ssrf.allowRanges` is optional and should only contain narrow CIDRs used by a
local fake-IP/TUN proxy. Private and reserved destinations remain blocked by
default, including across redirects.

## Maintenance

This is a local fork, not a drop-in copy of the upstream package. It is based
on [pi-web-access](https://github.com/nicobailon/pi-web-access) v0.13.0
(`7bdc30a`). See `LICENSE` for the retained MIT license.
