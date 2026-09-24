---
trigger: always_on
---

Before implementing a non-trivial change, write the plan in `docs/plans/<topic>.md` and follow the `zenspec` skill. Never edit code outside `docs/plans/` until `zenspec review` returns `verdict: approved`. Run `zenspec review` as a background command and wait for it to finish.
