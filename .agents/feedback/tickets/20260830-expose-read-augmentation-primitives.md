# HFM-20260830: Expose reusable read augmentation primitives

- **Status:** proposed
- **Approval:** not approved
- **Created:** 2026-08-30
- **Source reports:** [HF-20260812: Read overrides cannot reuse built-in path and image semantics](../inbox/20260812T091526Z-read-override-cannot-reuse-image-semantics.md)

<!-- Proposal and implementation approval are separate decisions. A proposed ticket does not authorize implementation. -->

## Problem

An extension adding one image-specific `read` argument must fork built-in path and image behavior for that call path, because the SDK exports the complete read tool definition but not an augmentation point or its canonical path/image stages.

## Baseline

The crop extension delegates uncropped calls through `createReadToolDefinition()` but duplicates path normalization and filename variants in `extensions/image-read/index.ts`, plus EXIF orientation and raster processing in its own worker. The source report records independent reviews finding omitted EXIF, `file://`, and filename-normalization behavior before those copies were corrected. The installed SDK exposes `resolvePath` only from an internal utility declaration, not the public extension entrypoint, and exposes no composable built-in image-read pipeline.

## Hypothesis

If the SDK exposes one supported read augmentation hook that receives canonically resolved and normalized image input, then additive read features can preserve built-in semantics without duplicating internal path, orientation, decoding, and attachment-limit logic.

## Guardrails

- Keep the built-in implementation authoritative for path resolution and image normalization.
- Preserve existing text and whole-image read behavior and provider attachment bounds.
- Do not expose broad internal utility modules or freeze accidental implementation details as public API.
- Do not move crop policy into Pi unless Pi chooses to own that feature.
- Avoid a generic middleware framework when one typed image augmentation point suffices.

## Options considered

1. **Typed image-read augmentation hook:** Small public surface and one authoritative pipeline; requires a deliberate extension contract.
2. **Export individual path/image helpers:** Reusable but easier for extensions to compose incorrectly or omit a stage.
3. **Continue full overrides:** No SDK change, but preserves semantic drift and duplicated maintenance.

## Recommendation

Implement option 1. Let an extension add schema/description fields and handle a post-resolution image operation while Pi retains canonical path resolution, orientation, decoding, cancellation, and output-limit enforcement.

## Scope

- **In:** Public typed read/image augmentation contract; canonical path and image preprocessing reuse; migration of the crop extension; compatibility tests.
- **Out:** General tool middleware; arbitrary built-in overrides; adding crop as a core Pi feature; non-raster media pipelines.

## Acceptance criteria

- [ ] The crop extension removes its duplicated built-in path-normalization and EXIF-orientation behavior.
- [ ] Crop and uncropped calls share canonical `file://`, home, Unicode-space, macOS normalization, apostrophe, and relative-path semantics.
- [ ] Source-pixel coordinates are defined after canonical orientation and tested for all supported EXIF orientations.
- [ ] Cancellation, source limits, decode failures, event-loop bounds, and provider attachment bounds remain enforced once by an authoritative layer.
- [ ] Existing third-party full read overrides remain possible without being silently changed.

## Validation

Run shared conformance fixtures through built-in whole-image reads and the augmented crop path for path variants, malformed images, every EXIF orientation, oversized sources/outputs, cancellation, worker deadlines, and non-image models. Run focused upstream SDK tests, `bun x vitest run extensions/image-read/image-read.test.ts`, `bun run typecheck:extensions`, and focused Biome checks after migration.

## Evaluation

- **Window:** Not started; after an approved merge and crop migration, the first 20 image-read development or live calls including at least 5 path/orientation variants, or 2026-10-31, whichever is later
- **Result:** pending (`keep` | `revise` | `revert` | `insufficient evidence`)

Compare with the baseline of duplicated path/orientation code and multiple compatibility review cycles. Keep only if the extension no longer copies those semantics and no augmented call diverges from built-in path or orientation behavior.

## Implementation and resolution

- **Approved implementation:** —
- **Merged change:** —
- **Resolution:** pending evaluation
