# R-PIN-MAC-ORIGIN-RESOLVE

This is diagnostic progress, not authentic R-25 acceptance. The cause is established, a minimal correction and focused tests are pushed, and no hosted rerun was dispatched.

## First-stop cause

Run `41562449901`, attempt `1`, stopped at `2026-11-03T01:55:59Z` with runner exit `1` and `producer job id was not independently resolved`. The runner had completed source materialization and validation; the first stop occurred before Pinokio engine actions. The error is in the captured log at lines 317–320 and in the retained failure JSON.

This was a job-name predicate mismatch, not a GitHub API permission failure. The jobs endpoint returned HTTP 200 and reported accepted permission `actions=read`. The workflow declares `actions: read` and `contents: read`. The response independently identified job ID `125675981941`, with run ID `41562449901`, attempt `1`, and head SHA `70275524f4b1c9501ed1ceda98d2c6f42064a89b`. Its name was:

`R-25 hosted macOS (pinokio-fully-local-macos) / macos-six-action`

`GITHUB_JOB` is the workflow job key `macos-six-action`. The old predicate accepted only an exact name or a name beginning with `macos-six-action` plus a space, so it rejected GitHub's caller-prefixed reusable-workflow name despite the returned ID and matching run metadata.

## Correction

The runner now resolves a unique job whose name ends in the exact ` / ${GITHUB_JOB}` component and whose slot marker, run ID, attempt, head SHA, and positive safe-integer job ID match the current run. Missing, ambiguous, or mismatched metadata still fails closed; API errors still throw. The hosted job includes its selected slot in its display name for direct and reusable workflow calls.

The legacy local-sequence test still asserts the same exact runner SHA and blob from its immutable `venue_ref`. It now reads those expected bytes from that pinned commit, instead of comparing the historical pin against the mutable working copy. The expected hash and blob assertions were not relaxed or changed.

Changed files are limited to `.github/venue/r25-snapshot-runner.cjs`, `.github/workflows/r25-snapshot-journey.yml`, and focused tests.

## Verification

- `node --test tests/r25-origin-resolution.test.cjs tests/r25-macos-sequence-binding.test.cjs` — 7 passed, 0 failed.
- `node --check .github/venue/r25-snapshot-runner.cjs` — passed.
- `git diff --check` — passed.

## Pushed state and next request

Both `lane/M-PIN/R-PIN-MAC-ORIGIN-RESOLVE` and `lane/M-PIN/R-PIN-MAC-ORIGIN-RESOLVE-wip` point to `ec6ec4b8aebf350ed1eb4639cc9dd5d6bc322156`. The branch is based on `70275524f4b1c9501ed1ceda98d2c6f42064a89b`, with the original base plus two task commits. Exact parents, API evidence, hashes, and the next hosted request inputs are in [canonical-receipt.json](canonical-receipt.json). The next request is a `CI` `workflow_dispatch` on `lane/M-PIN/R-PIN-MAC-ORIGIN-RESOLVE`, selecting `pinokio-fully-local-macos` and preserving the prior Agent ref and published candidate tuple.

The hosted request was not sent. A successful diagnostic run would still not constitute authentic R-25 acceptance.
