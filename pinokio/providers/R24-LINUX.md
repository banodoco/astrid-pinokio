# R-24 Linux binding diagnostic, v1

This executable materializes the observed local checkout roots and checks their
clean HEADs and specified source bytes against the Release-1 binding in
`r24-linux-binding.json`. It is a fail-closed diagnostic, not an Agent journey
config, live action executor, R-23 export, or R-24 qualification. Exit 0 means
binding checks ran; `admission` remains `closed`.

On a trusted Linux runner with Python 3.9+ and Git, independently check out the
four tuple repositories at the exact commits in the binding. They must be clean
(including untracked files). Supply their actual absolute roots in a UTF-8 JSON
file:

```json
{"checkouts":{"app":"/actual/app","agent":"/actual/agent","runtime":"/actual/runtime","pinokio":"/actual/pinokio"},"source_override_test_mode":false}
```

Invoke `python3 /immutable/provider/checkout/pinokio/providers/r24-linux.py REQUEST.json`.
Fetch the executable and adjacent binding JSON at the immutable provider commit
and verify both SHA-256 hashes before invocation. The provider checkout is
separate from the candidate Pinokio checkout, which must be the published base.
No source override or unmaterialized token is accepted. The harness Agent
checkout is separate from the installed-manifest Agent candidate.

Stdout is one JSON object. A checked binding returns `kind` =
`r24-linux-binding-diagnostic`, `version` = 1, `source_override_test_mode` =
false, `tuple`, `manifest_sha256`, `interface_sha256`, realpath `checkouts`,
`admission` = `closed`, and `action`, `busy`, `uncertainty`, `restoration`,
`engine`, and `reason`. Unperformed operations report `not-run` and unmeasured
results report `unknown`. Failure exits 1 with `kind` =
`r24-linux-binding-error`, `version` = 1, `admission` = `closed`, `status` =
`unknown`, and `error`. The request and outputs carry no authentication or
trusted provenance; the runner and collector must establish those independently.
Recheck identities at use; this diagnostic is not authority for mutation or an
R-30 binding.

Action, session, fault, restoration and fence observations are outputs of the
journey, not prerequisites for constructing a provider. This diagnostic does
not run the journey or implement those observations. No success, refusal,
restoration, or timeout observation is emitted. Missing source closure is not
settlement; no automatic retry or mutation is performed.

The supplied Agent adapter candidate pins earlier App and Pinokio commits. The
pinned journey builder's retry step (`name`) conflicts with the executor's
required `bootstrap_action`. The pinned driver's composition also unconditionally
raises after its Stop checks, and the old adoption command includes fields the
driver rejects. These Agent-owned interfaces require correction before an
executor config can be consumed. A venue hook must materialize that config on
the runner. This diagnostic cannot stand in for the missing executable journey
provider or the R-30 export.
