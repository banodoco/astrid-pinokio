# Exact native requests — single slot, no unchanged rerun

Owner M-PIN; venue coordination M-VENUE. These are diagnostic requests, not proof. Use a new GitHub-hosted macos-15 worker and a unique job-owned home. Never reuse or signal the unresolved prior Mac worker. No hannah-mac job is required for these point-in-time observations.

First collect already-requested Mac artifacts/logs from 41627302288 and 41627323040. Metadata in the current evidence tree is stale (queued at 11:24Z); do not infer a current status or rerun those refs. This request changes materialization and journal retention, not merely the attempt number.

## Fully-local first-failure capture

After verifying the published lane head equals the canonical receipt, the manager can relay exactly:

```text
ACTIONS: astrid-pinokio r25-windows-setup-diagnostic.yml lane/M-PIN/R-PIN-C6-MAC-ROWS {}
```

The workflow contains one macOS job and no push trigger. Effective observation source is explicitly 95ef7e4201681f3d998744437b742e3b746e3b6d plus this packet's `setup-capture.patch`; product baseline is published 3a6a98ae251ca126505245286e2d3e760f4348e9 with only its shell helper replaced by the diagnostic source. That is an instrumented diagnostic product, not exact-tuple proof. Engine/collector pins, full tuple, source-check hash and artifact retention are in the workflow. The immutable helper's hash is 97a01eaa729d4e4896a1970f737a53c198f4da545f4b2b54cc62a821a5232818; baseline helper hash is d8c2dfa774c0bda07d29f923f8b84d06055e76a8f4c5b6192980be2dffa8a7e9.

Capture FIRST refusal. Retain `effective-inputs.json`, `setup-shell-overlay.json`, `setup-shell-diagnostics.jsonl`, `setup-shell-capture.json`, setup diagnostics/settlement, PTY JSONL, bounded PTerm/daemon output, final census and `daemon-cleanup.json`; hash the extracted artifacts. Correlate `shell-child-spawn.pid` with `shell-command-exit.pid` and helper PPID/time, index-2 result/index-3 start, the first marker, PTerm SIGTERM request and transport exit. Do not assign an exit to index 3 from an index-2 helper row.

Discriminator: a naturally returned inner 0 before the marker supports routine engine teardown triggering the observer refusal; a bound nonzero identifies the actual shell failure; no numeric sentinel preserves unknown natural exit and points to interruption or capture failure. A PTerm zero, PTY signal 9, disconnect, or absent service never fills the missing command exit. The current marker refusal stays a failed diagnostic even if an inner 0 is captured. Cleanup uncertainty remains a hold.

## Backend lifecycle observation — subsequent single slot

The source-supported daemon-aware fix already exists at 430de39610d5c0b239fcff2ea227e57b1d7767ff on lane/M-PIN/R-PIN-MAC-DAEMON-START. It requires engine Start status and all three independent readiness predicates, retains the PTerm client and then measures Stop. Before use, check that this exact candidate/slot/input has no live or already completed native attempt; fetch any existing result instead of replaying it. Then, when the first slot is released, relay:

```text
ACTIONS: astrid-pinokio r25-snapshot-journey.yml lane/M-PIN/R-PIN-MAC-DAEMON-START {"agent_ref":"a6b68d5b5478326a4db1971966d33a2cfe61d091","slot_id":"pinokio-backend-macos","candidate_tuple":"{\"app\":\"79f7e5397c044c4c97dc7e97b20ad96f787e5247\",\"agent\":\"ab43bad818ef65ca1e929b973a2f61cd9fc4bf61\",\"runtime\":\"2776ba973b6c8f3555b5629b0840d9691a98d3c2\",\"pinokio\":\"3a6a98ae251ca126505245286e2d3e760f4348e9\",\"manifest_sha256\":\"b2584f0bb5a949890364004572a0182f2b568adcdba061e73b739e1d3d2d623f\",\"artifacts\":{\"public/install\":\"100bab1deb15d620abd910c8fb0c9a6d77f4945428a3229dac6b506705e3fd0d\",\"public/install.sh\":\"591c4c51b148fccef2a7d1c45782d9ff949d5fd03d46cd82b5591e3a23d1b285\",\"public/install.ps1\":\"bba3f2edc41c047cb51475ceeac4489a04610af73a3af44bdc05287964d28258\"},\"published_at\":\"2026-11-02T17:55:27Z\"}"}
```

Keep the original timeouts and all six action/protected-state/cleanup assertions. Capture Start status, engine resources, Runtime health `workspace.v1`, application URL, owned client liveness, measured Stop packets and transport exit, all subsequent action records and final process census. No source or new native result in this packet establishes protected child task settlement; missing fields stay unknown. M4-4a executor config/native control seam remains a separate M-PIN/M-QUAL dependency.

Do not dispatch both requests together. If setup repeats without a new cause, stop and switch to a live venue with M-VENUE; do not add keep-going or relax predicates.
