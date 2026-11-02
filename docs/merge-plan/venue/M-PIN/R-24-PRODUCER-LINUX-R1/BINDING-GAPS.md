# Linux M4-4a producer binding: awaiting evidence

This is a non-dispatchable handoff, not a platform spec or qualification
receipt. No hosted invocation or scenario was run. Do not replace missing
values with fixture values. R-06, R-15, R-36 and authentic journey evidence
remain unaccepted.

## Exact input identity

| Input | Commit or SHA-256 |
|---|---|
| Pinokio execution | `89ed7aacae72bb48eb97ff9ff95c222bdd7e71e4` |
| Agent execution | `dd6b48192c720c5346e6f140184e313b2cf84f31` |
| Runtime execution | `1e6d899efa77a2d6ec247c38250f9748330bb587` |
| App execution | `ae95eb455408b8c0e185bfded67798e2b307a6f6` |
| App `public/install-manifest.json` | `15ea3a2e0a4067773b727635e4eaa4b894eceb10f73aaa88cd29896a2364bd77` |
| R-25 template | `37c2c7f06712eb8e7fad9c9a0ca7371a301ee4ee7da5995d326e1f42ee9b87f4` |
| R-25 binding | `1f075dc352b2ac8fce4c3ed3a2820be9c35cfbc218222295517f796ece01c9b5` |
| Agent `scripts/pinokio_platform_adapter.py` | `7b8409897ebc2888fd0f5688b4ab7459c3b4411f6683e0cba558ceeace5f715d` |
| Agent `scripts/shared_journey_driver.py` | `a304ed209863593b3b8ffc79e6a339fd18d5263c831cbdc9165d650547a942e6` |
| R-24 diagnostic `pinokio/providers/linux-provider.mjs` at `603298861a359a04642143aea11e60dbd030505e` | `917037e87b0fdbba97113c5e3053b5e7f837b70f24b6faf73767b6e5ce49493a` |

The App manifest declares Release 1 and the Agent and Runtime commits above.
The listed source files in the Linux template were checked against both each
exact Git object and clean checkout bytes. The template's App ref is the
older `99144531aedab3ac8042b5d06f72bd5aaecf523f`; unchanged manifest bytes do
not make that ref equivalent. Its pinned adapter constants also bind the old
App and immutable template/binding hashes. A newly accepted coherent template,
binding and compatible adapter are necessary before dispatch.

## Missing materialization

* No approved runner-local adoption executable is supplied. The pinned
  Pinokio tree has no `pinokio/providers` directory. The later R-24 module is
  a JavaScript diagnostic facade with no adoption-executable protocol; its
  settlement, fault and custody surfaces explicitly remain unknown or
  diagnostic-only. It cannot be relabelled as the executable requested by
  `platform_adapter.adoption`. Thus executable path, digest, argv and cwd are
  unknown. No executable/spec hash or hosted invocation can yet be verified.
* The pinned Agent driver requires adoption `command` to contain exactly
  `argv`, `cwd`, `timeout_seconds`; it invokes with `env={}`, sends one JSON
  line `{"stage": ...}` and requires the six exact response fields `status`,
  `pid`, `identity`, `instance_id`, `controller_token_digest`, `start_count`.
  Stages are `pre-execution`, `after-first-action`, `after-retry-action`.
  It checks executable/artifact hashes again before invocation. The R-25
  template instead includes extra command keys including `env`, so it is
  rejected by this exact-field contract even after its paths are filled.
* `platform_adapter.spec` path and bytes are unavailable. The requested
  platform may be declared `os=linux`, `runner=ubuntu-24.04`, `hosted=true`,
  but runner provenance is observed independently at execution from `RUNNER_OS`,
  `ImageOS`, `ImageVersion` and the actual platform. Workspace, temp, provider
  and checkout absolute roots are runner-local and currently unknown.
* Runtime identity, distinct post-update and restart instance IDs, executable,
  argv, cwd, env, loopback port, status/health/menu and mismatch paths, state
  path, guard paths and authentic identity/instance controls are unknown. The
  adapter requires a live process-group leader, matching executable, birth and
  listener, and endpoint responses. These values cannot be derived from the
  source checkout alone.
* Busy and unknown control argv/cwd/env, nonzero exit, reason and stage, along
  with refusal, recovery and unchanged-state results, are unknown. The R-24
  fault seam and local fixtures do not prove a real busy Runtime or a trusted
  transport-unknown/restoration boundary. R-15 acceptance remains open.
* Local regeneration with the exact Agent builder and source commits matches
  the template's first action after checkout-path substitution. Retry does not:
  the template uses `{"kind":"custom","bootstrap_action":"preflightStop"}`
  while the pinned builder emits `{"kind":"custom","name":"preflightStop"}`;
  the remaining two steps match. The pinned journey checks exact equality.
  M-QUAL must reconcile the builder/schema and approve the resulting immutable
  input; neither spelling can safely be substituted here as accepted evidence.

## Required hosted route

An authorized owner must first provide an executable meeting the adoption
protocol and authentic installed Runtime/fault boundaries, a coherent accepted
template/binding, and a scoped Linux hosted diagnostic workflow that invokes
and retains them. On `ubuntu-24.04`, bind the actual clean tuple checkouts,
verify their exact refs and every immutable file digest, regenerate and compare
both action arrays, measure the executable and spec hashes, and record each
inner exit, observed runner provenance and bounded results. Bind the resulting
runner-local paths only in that run. Fail before action dispatch on every
missing or mismatched input. Record the run ID/ref and all inner exits; a run
alone is not acceptance.

The existing pinned `pinokio-venue.yml` executes an empty-state Reset and native
probes, not this producer or the required busy/unknown journey. The Agent
journey workflow requires already-materialized config and is a matrix workflow,
not a safe discovery route. No exact Actions request for the missing diagnostic
exists yet; dispatching either existing workflow would not answer the request.
