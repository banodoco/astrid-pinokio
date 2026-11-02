# R-24 M4-4a binding, pending runner materialization

The companion JSON is a non-executable binding template. It pins Pinokio
89ed7aacae72bb48eb97ff9ff95c222bdd7e71e4, Agent
dd6b48192c720c5346e6f140184e313b2cf84f31, Runtime
1e6d899efa77a2d6ec247c38250f9748330bb587, App
ae95eb455408b8c0e185bfded67798e2b307a6f6 and manifest SHA-256
15ea3a2e0a4067773b727635e4eaa4b894eceb10f73aaa88cd29896a2364bd77.
Source override is explicitly disabled (`source_override: false` and
`source_override_test_mode: false`). Retry steps follow the pinned builder;
the adoption command uses exactly argv, cwd and timeout_seconds.

Reserved path, executable, spec, Runtime identity and instance tokens are
unknown, not executable inputs or observations. The workflow must materialize
and validate real runner-local values and provider artifacts before execution.
No hosted lifecycle or qualification is asserted by this template.
