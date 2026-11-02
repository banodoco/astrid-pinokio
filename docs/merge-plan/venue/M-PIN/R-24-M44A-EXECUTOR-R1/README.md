# R-24 M4-4a tuple binding — dispatch blocked

`M4-4A-BINDING-TEMPLATE.json` is the accepted R-25 bridge with only its six
App ref occurrences replaced by `ae95eb455408b8c0e185bfded67798e2b307a6f6`.
The manifest digest was already the published `15ea3a2e0a4067773b727635e4eaa4b894eceb10f73aaa88cd29896a2364bd77`.
This is a **template, not an executor config**: its reserved runner/provider
paths and runtime identities remain unresolved. Do not dispatch it. The binding
policy is `source_override: false`. Every OS object explicitly has the
harness field `source_override_test_mode: false`; source override is also
forbidden in executable command inputs. The intended Linux candidate is:

- Pinokio `89ed7aacae72bb48eb97ff9ff95c222bdd7e71e4`
- Agent `dd6b48192c720c5346e6f140184e313b2cf84f31`
- Runtime `1e6d899efa77a2d6ec247c38250f9748330bb587`
- App `ae95eb455408b8c0e185bfded67798e2b307a6f6`

The request's 39-character Pinokio string omitted one `f`; the above full SHA
is both the accepted bridge's pin and published `int/r1` observed on 2026-11-02.

## Integration needed before dispatch

1. M-QUAL: align the pinned `ci_journey.build_pinokio_action` retry custom step
   with `pinokio_backend_executor._validate_action`. At Agent `dd6b4819`, the
   builder emits `{kind: custom, name: preflightStop}` while the executor
   requires `{kind: custom, bootstrap_action: preflightStop}` and the driver
   compares whole arrays. No single array passes both checks. The adoption
   command schema likewise accepts exactly `argv`, `cwd`, and `timeout_seconds`,
   whereas the accepted bridge carries additional command fields. Update the
   harness adapter/contract while retaining immutable source validation and
   fail-closed behavior; do not alter the product tuple.
2. M-VENUE: make the workflow check out this immutable lane separately from the
   frozen candidate and execute an approved Linux runner materializer after
   checkout, before `ci_journey.py`. The current `journey.yml` simply writes
   the input JSON to disk; it does not bind `$GITHUB_WORKSPACE`, `$RUNNER_TEMP`,
   the spec, executable, action arrays or observed sessions. Provide the actual
   invocation and an immutable Agent workflow ref with these changes, along
   with a Linux-only route or valid other-OS inputs. `m4_4a_backend_only` still
   selects all three OS rows. Supply the required candidate, approved old
   launcher and stopped-path inputs when dispatching.
3. Pinokio provider integration still needs a real engine action runner,
   adoption provider and observed Runtime/spec/Stop-control authority. They
   must be bound and measured on the runner, including the two actual distinct
   sessions. Unknown process identity and fault observations cannot be filled in
   ahead of execution. The accepted R-25 Agent adapter also hardcodes the old
   App tuple and template/binding digests; revise its pins before using it with
   this new template. No provider or hosted observations are claimed here.

The first journey is authorized without R-06, R-15 or R-36 receipts. These are
implementation and workflow contract dependencies, not qualification gates.
