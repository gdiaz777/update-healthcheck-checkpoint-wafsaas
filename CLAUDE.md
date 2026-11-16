# loadbalancing/ — Claude context

Tooling that edits the **load-balancer health-check success codes** of an existing WAF Web Application asset in Check Point CloudGuard WAF SaaS / Infinity Next.

For the workspace-wide context (stack, shared API patterns, BYOC vs CPManaged, etc.) see [../CLAUDE.md](../CLAUDE.md). The full user-facing walkthrough is in [README.md](README.md).

---

## What is here

| File | Purpose |
|------|---------|
| `update-healthcheck-checkpoint-wafsaas.ts` | Deno/TS script that swaps `loadBalancerSetting.healthCheckSettings.successCodes` on an existing asset. Pre-flights `isLoadBalancer`, idempotent if the desired codes already match, full publish + enforce at the end. |
| `README.md` | User-facing docs (deps, env vars, CLI flags, run examples, fallback payload shapes). |
| `.env` | Secrets (`WAFAUTHURL` / `WAFKEY` / `WAFSECRET`). Gitignored. |
| `*_update-healthcheck_output.log` | Per-run append-only log. Gitignored. |

This folder **does not** create assets, change upstreams, or toggle the LB. Those should already be configured in the portal (or extend the script — see below).

---

## Invocation

```bash
# dry-run (no API write, no publish)
dotenvx run -- deno run -A update-healthcheck-checkpoint-wafsaas.ts \
    --asset <assetName> --code 303 --dry-run

# apply
dotenvx run -- deno run -A update-healthcheck-checkpoint-wafsaas.ts \
    --asset <assetName> --code 303

# multiple acceptable codes
dotenvx run -- deno run -A update-healthcheck-checkpoint-wafsaas.ts \
    --asset <assetName> --code 200,303
```

`--code` is a **full swap**: all current success codes are removed and the new list replaces them. There is no "append one code" mode by design — health-check semantics are clearer when the success set is declared explicitly.

---

## Script-specific notes

- **Input shape caveat**: the `addSuccessCodes / removeSuccessCodes / updateSuccessCodes` triplet was inferred from the parallel `upstreams` shape because the captured HAR did not include a request that actually wrote `successCodes` (the user kept the default `200`). If the API rejects it, the obvious fallbacks (in order) are:
  1. Wrap each value in an object: `addSuccessCodes: [{ LoadBalancerSuccessCode: 303 }]`.
  2. Full replace via a flat field: `successCodes: [303]`.
  3. Introspect the input type name and adjust:
     ```graphql
     { __type(name: "WebApplicationLoadBalancerHealthCheckUpdateInput") {
         inputFields { name type { name kind ofType { name kind } } } } }
     ```
- **Idempotency**: if `currentCodes == desiredCodes`, the script logs *"nothing to do"* and skips both the mutation and the publish/enforce.
- **Asset must already be a load balancer**: the script aborts with a clear error if `isLoadBalancer` is `false`. Enabling LB / configuring upstreams is out of scope here.
- **Logs**: appended to `./YYYY-MM-DD-HH-MM_update-healthcheck_output.log` in the current directory.

---

## Extending this folder

If a follow-up task needs to touch upstreams, the LB algorithm, the LB toggle, or other health-check fields (interval, path, port, thresholds), the same `updateWebApplicationAsset` mutation already covers them — see the `loadBalancerSetting` block in [`update-healthcheck-checkpoint-wafsaas.ts:getLoadBalancerState`](update-healthcheck-checkpoint-wafsaas.ts) for the full read shape. Mirror the existing add/remove/update triplet pattern.
