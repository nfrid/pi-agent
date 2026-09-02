export const MAX_ID = 256;
export const MAX_PATH = 4096;
export const MAX_TEXT = 100_000;
/** Bounds for provisional tool-call argument tracing. */
export const MAX_TOOL_ARGUMENT_DELTA = 4_096;
export const MAX_TOOL_ARGUMENT_PREVIEW = 12_000;
export const MAX_TOOL_ARGUMENT_CHARS = 10_000_000;
/** Bounds for server-persisted model display preferences. */
export const MAX_MODEL_DISPLAY_PREFERENCE_KEY = 512;
export const MAX_MODEL_DISPLAY_PREFERENCES = 512;
export const MAX_MODEL_DISPLAY_ALIAS = 80;
/** Aggregate cap for the authoritative lightweight shell query response. */
export const MAX_SHELL_SNAPSHOT_BYTES = 2 * 1024 * 1024;
export const SESSION_NAME_MAX_LENGTH = 512;
/** Maximum entries representable in one authoritative shell index. */
export const MAX_SHELL_INDEX_ITEMS = 4_096;
/** Keep delta payloads below the complete replacement representation. */
export const MAX_SESSION_INDEX_DELTA_ITEMS = MAX_SHELL_INDEX_ITEMS / 4;
/** Bounded read-only branch topology carried alongside a session snapshot. */
export const MAX_SESSION_BRANCH_POINTS = 4_096;
export const MAX_SESSION_BRANCH_PATHS = 256;
/** Aggregate branch-path cap keeps topology below snapshot transport budgets. */
export const MAX_SESSION_BRANCH_PATHS_TOTAL = 1_024;
/** Maximum compact prompt label retained for one branch path. */
export const MAX_SESSION_BRANCH_LABEL = 240;
/** Maximum entries in one composer slash-command catalogue. */
export const MAX_COMPOSER_COMMANDS = 256;
export const MAX_COMPOSER_COMMAND_NAME = 128;
export const MAX_COMPOSER_COMMAND_DESCRIPTION = 1_024;
export const MAX_COMPOSER_COMMAND_ARGUMENT_HINT = 256;
export const MAX_COMPOSER_FILE_SUGGESTIONS = 20;
export const MAX_COMPOSER_FILE_QUERY = 4_096;
/** Bounds for the durable delegate history query response. */
export const MAX_DELEGATE_HISTORY_SUMMARY_BYTES = 512 * 1024;
export const MAX_DELEGATE_HISTORY_GROUPS = 256;
export const MAX_DELEGATE_HISTORY_RUNS_PER_GROUP = 128;
export const MAX_DELEGATE_HISTORY_TOTAL_RUNS = 2_048;
export const MAX_DELEGATE_HISTORY_TASK = 32 * 1024;
export const MAX_DELEGATE_HISTORY_CONTEXT_NOTE = 64 * 1024;
export const MAX_DELEGATE_HISTORY_DETAIL_TEXT = 8_000;
export const MAX_DELEGATE_HISTORY_DETAIL_ENTRIES = 128;
/** One selected invocation may contain the complete scope and parent context. */
export const MAX_DELEGATE_HISTORY_DETAIL_BYTES = 3 * 1024 * 1024;
/** Exact prompt retained for one selected delegate invocation. */
export const MAX_DELEGATE_HISTORY_PROMPT = 640 * 1024;
/** Aggregate bounded upstream evidence retained for one selected invocation. */
export const MAX_DELEGATE_HISTORY_INPUT_EVIDENCE = 48 * 1024;
