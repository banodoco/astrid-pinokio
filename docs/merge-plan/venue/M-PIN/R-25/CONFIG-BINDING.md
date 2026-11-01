# R-25 M4-4a journey config binding

This task materializes `M4_4A_EXECUTOR_CONFIGS` for the pinned Agent
`journey.yml`/`ci_journey.py` contract. The JSON root has exactly the three
keys `linux`, `macos`, and `windows`; each value is non-empty and contains the
validator fields for `candidate_checkouts`, `old_launcher`, `actions`,
`platform_adapter`, `runtime`, and `negative_controls`.

## Immutable binding

Every OS object binds the same current coherent tuple:

```text
Runtime  1e6d899efa77a2d6ec247c38250f9748330bb587
Agent    dd6b48192c720c5346e6f140184e313b2cf84f31
App      99144531aedab3ac8042b5d06f72bd5aaecf523f
Pinokio  89ed7aacae72bb48eb97ff9ff95c222bdd7e71e4
```

The file pins include the App `public/install-manifest.json`, the pinned
Agent journey sources, the Runtime probe sources, and the Pinokio launcher,
Stop, shell, and lifecycle sources. The approved historical launcher is
`bbba620e3d89eeff8021417f365e6ea584203105` with
`pinokio/update.js` SHA-256
`a0f998c03bbba57966c8863a3bd38411d7859d970ddc4c93af1e28b04a66291b`.
The Stop source is pinned to `pinokio/stop.js` SHA-256
`f9d62e4e6a826fccd9791ee211dae933f46c8f99019e145abb3db3bf9595fd48`.

The embedded `slot_mapping` preserves the accepted six-slot contract: each OS
has exactly one `pinokio-backend` and one `pinokio-fully-local` row. This bridge
does not change D9, add rows, or assert a terminal receipt. The fully-local
rows remain mapped for attribution; `journey.yml` consumes this bridge only for
the three M4-4a backend rows.

## Required runner-local materialization

The pinned validator requires real absolute paths and the pinned workflow
creates these checkouts only after the hosted runner starts. The JSON therefore
uses reserved, visibly invalid-until-bound tokens rather than guessed paths:

| Token | Replace with |
|---|---|
| `/__M4_4A_RUNNER_WORKSPACE__` or `C:/__M4_4A_RUNNER_WORKSPACE__` | The absolute `$GITHUB_WORKSPACE` for the current runner |
| `/__M4_4A_RUNNER_TEMP__` or `C:/__M4_4A_RUNNER_TEMP__` | The absolute `$RUNNER_TEMP` for the current runner |
| `__M4_4A_PINOKIO_CHECKOUT__` | The absolute checkout path `$GITHUB_WORKSPACE/pinokio` inside generated action-step messages |
| `.../__M4_4A_PROVIDER__` | A real, approved runner-local provider root, if one exists |
| `__M4_4A_PROVIDER_EXECUTABLE_SHA256__` | The measured SHA-256 of that provider executable |
| `__M4_4A_RUNTIME_IDENTITY_BOUND_BY_PROVIDER__` and instance tokens | Values returned by the bound real Runtime/provider contract |

The checkout mapping is fixed and must not be inferred:

```text
app            = $GITHUB_WORKSPACE/app
candidate-agent= $GITHUB_WORKSPACE/candidate-agent
runtime        = $GITHUB_WORKSPACE/runtime
pinokio        = $GITHUB_WORKSPACE/pinokio
```

After replacement, M-VENUE must verify each checkout is clean and that
`git -C <path> rev-parse HEAD` equals the tuple SHA. It must verify every
listed file hash before creating the per-job backend JSON. It must also
materialize `platform_adapter.spec` with the exact fields consumed by the
pinned `pinokio_platform_adapter.py`, including the actual Runtime executable,
loopback endpoints, state path, stop controls, and runner identity.

The action arrays are provenance-bound exports, not hand-editable strings.
M-VENUE must run the pinned `ci_journey.build_pinokio_action` for the approved
old launcher and current Pinokio ref on the runner, then compare the generated
arrays byte-for-byte with the bound config after path substitution. This is
especially required on Windows because the pinned builder emits a
PowerShell-5.1 command whose Node executable and quoting are runner-local.
Reject the packet if the comparison fails.

M-QUAL resolved the custom-step schema at
`banodoco/astrid-agent` `lane/M-QUAL/R-05-CUSTOM-STEP-SCHEMA-R1` commit
`258ccddc4fc02de864487518a45ca745e0a23855`. The pinned bridge contract for
every retry is exactly
`{"kind":"custom","bootstrap_action":"preflightStop"}`; the stale
`name` spelling is not accepted. This binding carries that resolved source
contract without changing an Agent-owned file or changing the tuple.

## Caller wiring

M-VENUE should consume this file from the immutable task-lane head, materialize
all tokens above, and serialize the resulting root object as the reusable
workflow input `m4_4a_executor_configs`. It must pass the frozen Release-1
candidate/manifest input separately: the App manifest path is
`public/install-manifest.json`, SHA-256
`15ea3a2e0a4067773b727635e4eaa4b894eceb10f73aaa88cd29896a2364bd77`, and its
Agent/Runtime entries must equal the tuple above. Preserve
`m4_4a_backend_only` as needed for the selected matrix, keep the pinned
workflow's `strategy.fail-fast: false`, and pass
`stopped_path_agent_ref` equal to the tuple Agent SHA.

For each backend matrix row, the caller must let the pinned workflow select
that row's OS object and write it to the runner-local
`--pinokio-backend-config` path. It must never pass `{}` or the unmaterialized
token template. A missing provider, missing spec, failed hash check, or failed
action-array comparison is a hard pre-dispatch failure.

## Limitations

No real Pinokio engine/adoption provider, provider executable identity, or
platform spec was available in the accepted six-slot packet or this task
workspace. The provider fields are therefore explicit binding tokens, not
fabricated identities. The pinned shared driver will fail closed until M-VENUE
binds an approved provider that can report adoption at the required stages and
exercise the live busy/unknown Stop controls. This task ran no hosted jobs and
claims no R-20, R-24, or R-25 acceptance.
