# R-25 frozen-manifest input refresh receipt

Status: `INPUT_REFRESH_ONLY` / `NO_R-25_QUALIFICATION`

## Repository and lane

| Field | Value |
|---|---|
| Repository | `banodoco/astrid-pinokio` |
| Branch | `lane/M-PIN/R-25-FROZEN-MANIFEST-R1` |
| Base | `e6baa4700da35189053aecf3d414020f32ab8424` |
| Base parent | `58e7191d915777db86a8b597f01a98b687e02bb7` |
| Published head | Recorded in the companion task receipt at `queue/running/R-25-FROZEN-MANIFEST-R1/REPORT.md` |
| Scope | Journey config, binding, `SHA256SUMS`, and this report only |

## Frozen App source

Source: `banodoco/astrid-app@36ff224e3c9ad862e3f807e2548b997a36799543:public/install-manifest.json`.
The manifest declares `release: 1`, Agent
`020877f12ea490308a9e5f9564c8f4a4bf77ede1`, and Runtime
`47e5949465cb6f3afdfd1cb8a0e90009fd9d4020`. Its SHA-256 is
`b78ae7e74188f6e0bbf01950b0d388d4cf36ea990c9bb574fd8aef57a8782777`.

All three OS configs now bind App
`36ff224e3c9ad862e3f807e2548b997a36799543` and that exact manifest hash.
Agent, Runtime, and Pinokio remain pinned to
`020877f12ea490308a9e5f9564c8f4a4bf77ede1`,
`47e5949465cb6f3afdfd1cb8a0e90009fd9d4020`, and
`89ed7aacae72bb48eb97ff9ff95c222bdd7e71e4` respectively. All six unique D9
slots (backend and fully-local for Linux, macOS, and Windows) remain intact.
The provider-unavailable and platform/runtime seam tokens are unchanged.

## Generated files and hashes

| File | SHA-256 |
|---|---|
| `M4-4A-JOURNEY-CONFIGS.json` | `56fd24b416ac5d7ecd0bbb8e3aceb1167585f151ce7a9e4e92f3ca96801f0ac4` |
| `CONFIG-BINDING.md` | `0d28c6b885d08bc49a4da28262a9e0496367f3a39c10d21426efd049df0faad4` |
| `SHA256SUMS` | Listed in the companion task receipt after publication |

## Commands and results

| Command/check | Result |
|---|---|
| `/home/user/merge/kit/codex/task-clone.sh astrid-pinokio /tmp/R-25-FROZEN-MANIFEST-R1-pinokio e6baa4700da35189053aecf3d414020f32ab8424` | PASS; exact base and parent verified |
| `/home/user/merge/kit/codex/task-clone.sh astrid-app /tmp/R-25-FROZEN-MANIFEST-R1-app 36ff224e3c9ad862e3f807e2548b997a36799543` | Helper could not run: no local App repo/store. Fallback exact-origin clone and detached checkout at requested commit succeeded |
| `sha256sum /tmp/R-25-FROZEN-MANIFEST-R1-app/public/install-manifest.json` | PASS; `b78ae7e74188f6e0bbf01950b0d388d4cf36ea990c9bb574fd8aef57a8782777` |
| Standard-library Python manifest/config assertions | PASS; release and manifest tuple/hash; all three OS bindings; only four App-specific JSON leaves changed per OS; six unique slots; all non-App fields and unavailable seams preserved |
| `sha256sum -c SHA256SUMS` | PASS; all five retained packet/config/binding files verified |
| `git diff --check` | PASS |
| Exact changed-path audit | PASS; config, binding, checksum, and this report only |
| `/home/user/merge/kit/codex/env-safe.sh git push -u origin lane/M-PIN/R-25-FROZEN-MANIFEST-R1` | See companion task receipt for push and remote-head verification |

## Coverage inventory

The refreshed bundle includes the three-OS `M4-4A-JOURNEY-CONFIGS.json`,
`CONFIG-BINDING.md`, and `SHA256SUMS`. Existing source packet inputs
`RC-0-EXECUTOR-CONFIGS.json`, `SLOT-MAPPING.md`, and `R-21-R7-DISPATCH.md`
remain unchanged and remain inventoried in the checksum file.

## Limitations

This refresh binds a frozen Release-1 App manifest as journey input only. It
does not fill the unavailable real-engine/provider identity, runtime identity,
or platform spec; it does not alter slot mapping or acceptance semantics. No
hosted job ran and this receipt makes no R-25 qualification claim.
