# HF-20260812: Read overrides cannot reuse built-in path and image semantics

- **Status:** new
- **Observed date:** 2026-08-12
- **Source cwd/repo:** `/Users/nfrid/.pi/agent`
- **Task shape:** Add approved pixel crop controls to image reads while preserving existing read behavior.
- **Harness component:** Pi extension SDK / built-in `read` tool override surface
- **Route / attempt / outcome:** The parent implemented the override; three independent Luna reviews found compatibility and resource issues, which were fixed before merge.
- **Observed cost / rework:** Required duplicating internal path normalization and EXIF-orientation logic, followed by multiple review/fix cycles to restore built-in semantics.
- **Recurrence / confidence:** Directly observed; high confidence for extensions that augment rather than fully replace built-in image reads.
- **Ticket:** —

## Behavior

`createReadToolDefinition()` is exported, but an extension adding one image-specific argument cannot reuse the built-in read path resolver or image normalization stages independently. The override can delegate unchanged calls to the built-in tool, but crop calls must recreate behaviors such as `file://` handling, Unicode/macOS filename variants, EXIF orientation, raster decoding, and provider attachment bounds.

## Impact

An additive read capability becomes a full behavioral fork for the affected call path. Small omissions create inconsistent semantics within the same `read` tool and can introduce incorrect crop coordinates, path failures, event-loop blocking, or oversized image attachments.

## Evidence

- The implementation delegated non-crop calls through `createReadToolDefinition()` but had to add its own crop path under `extensions/image-read/`.
- Independent review found that the first version omitted EXIF orientation and later found that crop paths did not support built-in `file://` and filename-normalization behavior.
- Fixing those findings required reproducing path variants and EXIF parsing/orientation that already exist inside Pi's non-exported read/image utilities.
- Focused tests were added for file URLs, EXIF-oriented coordinates, malformed containers, worker deadlines, and attachment bounds before the feature passed final review.

## Smallest improvement

Expose a supported augmentation point for built-in image reads—or public reusable path/image helpers—so an override can add crop selection while retaining Pi's canonical path resolution, orientation, decoding, and attachment-limit behavior without copying internal logic.
