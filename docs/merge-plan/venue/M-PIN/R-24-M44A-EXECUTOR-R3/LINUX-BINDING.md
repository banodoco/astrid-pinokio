# Linux M4-4a runner binding checkpoint

The Agent provider-side module `scripts/pinokio_linux_binding.py` verifies the
R2 template, explicitly disabled source overrides, four clean checkout HEADs
and file inventories, three App bootstrap hashes, the old launcher bytes, and
both action arrays against the pinned journey builder. Run it as a Python
module from the reviewed Agent checkout, supplying the absolute template and
four checkout paths. The old launcher commit must be present in the Pinokio
checkout. Its JSON output is a checkpoint with `dispatchable: false`, not an
executor config or hosted lifecycle evidence. Local output is not a runner
observation.

The existing Agent workflow writes its input JSON directly as the executor
config and then invokes the driver. It has no hook to check out this provider
lane or run a materializer, and its Pinokio checkout uses the default shallow
fetch. A venue-owned hook must supply the historical launcher object and invoke
runner-local materialization before the unchanged driver. Materialization also
needs a real executable and its measured digest, a runtime spec from the
actual runner and Runtime sessions, real engine/action settlement, and real
busy/unknown controls and recovery observations. The checkpoint does not supply
or infer any of these. R-06, R-15 and R-36 receipts are not prerequisites to
attempting the first row; they remain relevant to final qualification.

Do not dispatch the R2 template as a materialized config. Keep
`source_override` and `source_override_test_mode` explicitly false. The R3
checkpoint is partial work and makes no M4-4a, M4-4b, M4-5 or R-24 acceptance
claim.
