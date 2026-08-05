# HF-20260805: Image reads need crop or region controls

- **Status:** new
- **Observed date:** 2026-08-05
- **Source cwd/repo:** `/Users/nfrid/.pi/agent`
- **Task shape:** Visually verify a responsive dashboard redesign using desktop and mobile screenshots.
- **Harness component:** `read` image rendering
- **Route / attempt / outcome:** Read tall full-page Playwright screenshots produced during a delegated visual audit; the images rendered successfully but were too compressed for UI inspection.
- **Observed cost / rework:** The parent had to recapture viewport-sized screenshots and inspect geometry separately because controls and spacing were unreadable in the full-page render.
- **Recurrence / confidence:** Likely recurring in browser/UI work that produces full-page screenshots; high confidence.
- **Ticket:** —

## Behavior

The image form of `read` renders an entire image but offers no crop or region selection. Very tall screenshots are scaled down to fit the response, preserving the whole page at the expense of local detail.

## Impact

For visual QA, the important evidence is often a composer, header, modal, or responsive breakpoint. Full-page scaling can make those regions too small to judge, forcing extra browser captures and repeated reads even when the original image already contains the needed pixels.

## Evidence

- A desktop screenshot measured `1440x14426` and was displayed at approximately `200x2000`.
- A mobile screenshot measured `390x15529` and was displayed at approximately `50x2000`.
- In both cases local button alignment and composer styling were unreadable.
- The parent recaptured viewport screenshots such as `/tmp/dashboard-polish-session-desktop.png` and `/tmp/dashboard-polish-final-mobile-session.png` to complete the review.

## Smallest improvement

Add optional pixel crop parameters (`x`, `y`, `width`, `height`) or a region-selection mode to image reads, while keeping the current whole-image behavior as the default.
