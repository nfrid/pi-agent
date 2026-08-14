export const MAX_ID = 256;
export const MAX_PATH = 4096;
export const MAX_TEXT = 100_000;
/** Aggregate cap for the authoritative lightweight shell query response. */
export const MAX_SHELL_SNAPSHOT_BYTES = 2 * 1024 * 1024;
export const SESSION_NAME_MAX_LENGTH = 512;
/** Maximum entries in one session-index delta record. */
export const MAX_SESSION_INDEX_DELTA_ITEMS = 4_096;
/** Maximum entries in one composer slash-command catalogue. */
export const MAX_COMPOSER_COMMANDS = 256;
export const MAX_COMPOSER_COMMAND_NAME = 128;
export const MAX_COMPOSER_COMMAND_DESCRIPTION = 1_024;
export const MAX_COMPOSER_COMMAND_ARGUMENT_HINT = 256;
/** Bounds for the durable delegate history query response. */
export const MAX_DELEGATE_HISTORY_SUMMARY_BYTES = 512 * 1024;
export const MAX_DELEGATE_HISTORY_GROUPS = 256;
export const MAX_DELEGATE_HISTORY_RUNS_PER_GROUP = 128;
export const MAX_DELEGATE_HISTORY_TOTAL_RUNS = 2_048;
export const MAX_DELEGATE_HISTORY_TASK = 20_000;
export const MAX_DELEGATE_HISTORY_DETAIL_TEXT = 8_000;
export const MAX_DELEGATE_HISTORY_DETAIL_ENTRIES = 128;
export const MAX_DELEGATE_HISTORY_DETAIL_BYTES = 512 * 1024;
