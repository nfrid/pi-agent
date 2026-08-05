# HFM-20260805: Add crop controls to image reads

- **Status:** proposed
- **Approval:** approved 2026-08-05
- **Created:** 2026-08-05
- **Source reports:** [HF-20260805: Image reads need crop or region controls](../inbox/20260805T160611Z-image-read-needs-crop.md)

## Problem

The image form of `read` renders an entire image without a caller-selected region. Tall full-page screenshots are scaled down until local controls, alignment, and spacing are unreadable, even though the original file contains sufficient detail.

## Baseline

A `1440x14426` desktop screenshot rendered at approximately `200x2000`, and a `390x15529` mobile screenshot at approximately `50x2000`. Both required new viewport screenshots before visual QA could continue. The current tool contract accepts a path plus text-file line bounds but exposes no image crop coordinates; no extension-local wrapper supplies region selection.

## Hypothesis

If image reads accept validated pixel crop coordinates and return the selected region at useful resolution, then visual QA can inspect local UI evidence from existing full-page captures without recapturing the browser viewport.

## Guardrails

- Preserve whole-image reading as the default.
- Decode each source image once per call and enforce bounded source dimensions, crop area, and output size.
- Reject negative, non-integer, empty, or wholly out-of-bounds regions with clear errors.
- Define and test partial out-of-bounds behavior rather than silently shifting coordinates.
- Preserve image type support and avoid metadata or path leakage beyond current behavior.

## Options considered

1. **Pixel crop (`x`, `y`, `width`, `height`):** Deterministic and automation-friendly, but callers may need image dimensions first.
2. **Normalized coordinates or named regions:** Convenient across resolutions, but less exact and adds another coordinate contract.
3. **Automatic tiling:** Requires no coordinates, but can flood context and may still miss the region of interest.

## Recommendation

Add optional pixel crop parameters with explicit coordinate semantics and source-dimension metadata in the result. Keep whole-image behavior unchanged when no crop is supplied; consider tiling only after crop use is evaluated.

## Scope

- **In:** Raster image read schema; crop validation; bounded decoding/rendering; result dimensions; focused image fixtures.
- **Out:** OCR, object detection, semantic region selection, browser recapture, annotation, or video/PDF regions.

## Acceptance criteria

- [ ] A valid crop returns exactly the requested pixel region and reports source and returned dimensions.
- [ ] Omitting crop parameters preserves current whole-image behavior.
- [ ] Invalid, empty, and out-of-bounds crops fail deterministically without excessive allocation.
- [ ] Tall PNG, JPEG, GIF, WebP, and BMP inputs retain current support where applicable.
- [ ] Crop limits prevent decompression or response-size abuse and are documented in the tool schema.

## Validation

Use a synthetic grid image with known corner colors and labels to verify exact coordinates, edges, partial/out-of-bounds policy, large dimensions, formats, and unchanged default rendering. Run the owning harness tool tests and repository validation applicable to the implementation.

## Evaluation

- **Window:** After an approved merge, the first 10 visual-QA tasks that inspect screenshots taller than four viewports, or 2026-09-30, whichever is later
- **Result:** pending (`keep` | `revise` | `revert` | `insufficient evidence`)

Compare with the baseline of two required viewport recaptures. Keep only if at least 8 of 10 eligible tasks inspect the needed region from the original capture, crops remain within resource bounds, and whole-image reads do not regress.

## Implementation and resolution

- **Approved implementation:** Add validated pixel crop parameters and source/returned dimensions to raster image reads, preserve whole-image defaults and current format support, and enforce deterministic coordinate and resource bounds; approved by the user on 2026-08-05.
- **Merged change:** —
- **Resolution:** pending evaluation
