# Load-Balancer Health-Check Updater

`update-healthcheck-checkpoint-wafsaas.ts` is a Deno/TypeScript helper that changes the **HTTP success code(s)** expected by the load-balancer health check of an existing Web Application asset in **Check Point CloudGuard WAF SaaS / Infinity Next**.

It does **not** create assets, does **not** change upstreams, and does **not** change the LB algorithm. Those should already be configured in the portal before running this. The script only edits `loadBalancerSetting.healthCheckSettings.successCodes`.

A typical use case: the portal wizard always seeds the health check with `200` as the only success code, but your backend answers `303` (or `301`, `302`, etc.) on a healthy probe. Without this fix all upstreams are marked unhealthy and the LB stops sending traffic to them.

---

## Repository layout

```
update-healthcheck-checkpoint-wafsaas/
├── README.md                                  # this file
├── .env                                       # secrets (gitignored, you create this)
└── update-healthcheck-checkpoint-wafsaas.ts   # the script
```

---

## Dependencies

```bash
# Deno — https://docs.deno.com/runtime/getting_started/installation/
curl -fsSL https://deno.land/install.sh | sh

# dotenvx — https://dotenvx.com/
curl -fsS https://dotenvx.sh | sudo sh

# verify
deno --version
dotenvx --version
```

---

## Environment variables

The script reads its credentials from an `.env` file at the repo root. Create it next to `update-healthcheck-checkpoint-wafsaas.ts` and run `dotenvx` from that directory.

| Variable     | Required | Description                                                                            |
|--------------|----------|----------------------------------------------------------------------------------------|
| `WAFAUTHURL` | yes      | Infinity Portal authentication endpoint (e.g. `https://cloudinfra-gw.portal.checkpoint.com/auth/external`). |
| `WAFKEY`     | yes      | API key `clientId` — the `Client ID` shown when the API key was created in the Infinity Portal under service `Web Application & API Protection`. |
| `WAFSECRET`  | yes      | API key `accessKey` — the `Access Key` (secret) shown only once at creation time.      |

Example `.env`:

```dotenv
WAFAUTHURL=https://cloudinfra-gw.portal.checkpoint.com/auth/external
WAFKEY=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
WAFSECRET=YourLongRandomAccessKeyValue
```

> Add `.env*` to your `.gitignore` so secrets are not committed by accident.

---

## CLI flags

| Flag        | Required | Default | Description |
|-------------|----------|---------|-------------|
| `--asset`   | yes      | —       | Exact name of the existing WAF Web Application asset. Same name shown in the portal under **Web Applications**. |
| `--code`    | no       | `303`   | Comma-separated list of HTTP success codes (integers). Examples: `--code 303`, `--code 200,303`. |
| `--codes`   | no       | —       | Alias of `--code`. |
| `--dry-run` | no       | off     | Print the mutation that would be sent and skip the actual API write + publish/enforce. |

The replacement is a **full swap**: all current success codes are removed and the codes passed via `--code` are added. There is no incremental "append one code" mode by design — health-check semantics are clearer when the success set is declared explicitly.

---

## Run it

From the directory that contains `.env` and the script:

```bash
# 1. Dry-run first — prints the planned mutation, makes no changes
dotenvx run -- deno run -A update-healthcheck-checkpoint-wafsaas.ts \
    --asset my-app-prod --code 303 --dry-run

# 2. Apply for real — updates the asset, publishes, and enforces the policy
dotenvx run -- deno run -A update-healthcheck-checkpoint-wafsaas.ts \
    --asset my-app-prod --code 303

# Multiple acceptable codes
dotenvx run -- deno run -A update-healthcheck-checkpoint-wafsaas.ts \
    --asset my-app-prod --code 200,303
```

---

## What the script does, step by step

1. **Login** to the Infinity Portal with `WAFKEY`/`WAFSECRET` against `WAFAUTHURL`, storing the JWT for the rest of the run.
2. **Resolve asset id** by exact name via `getWafAssets` (filter `class:["workload"]`).
3. **Read current state** with `getWafWebApplicationAsset` to fetch `loadBalancerSetting.healthCheckSettings.successCodes` (each entry has its own `id`).
4. **Pre-flight checks**:
   - Aborts if the asset does not have `isLoadBalancer: true` — enable the LB first (from the portal or by extending the script).
   - Skips the API write if the current success codes already equal the desired set (idempotent).
5. **Update** with a single `updateWebApplicationAsset` mutation carrying:
   ```graphql
   assetInput.loadBalancerSetting.healthCheckSettings = {
     addSuccessCodes:    [303],
     removeSuccessCodes: [<ids of current codes>],
     updateSuccessCodes: []
   }
   ```
6. **Publish + enforce**:
   - `asyncPublishChanges` (async — returns immediately, validation runs in the background).
   - `getUnenforcedPublishedSessions` polled for up to ~60s to give the publish a chance to settle.
   - `enforcePolicy` — always called, even if the wait above timed out (cert/asset changes can sit in a state the session query does not surface).
   - `getTask` polled every 2s until status leaves `InProgress`.
7. **Run log** is appended to `./<YYYY-MM-DD-HH-MM>_update-healthcheck_output.log` in the current working directory.

---

## Known caveat: input shape is inferred

The input shape used by this script was reverse-engineered from a portal HAR capture that did **not** contain a request actually writing `successCodes` (the user kept the default `200`, so the portal never sent the field).

The script therefore uses the input shape that mirrors the well-captured `upstreams` triplet (`addUpstreams: [String]`, `removeUpstreams: [ID]`, `updateUpstreams: [{id, LoadBalancerUpstream}]`) and applies it to `successCodes`:

```jsonc
"healthCheckSettings": {
  "addSuccessCodes":    [303],          // [Int]
  "removeSuccessCodes": ["<id>", ...],  // [ID]
  "updateSuccessCodes": []
}
```

If the GraphQL endpoint rejects this shape, the run will fail with a schema error printed by the `gql()` helper. The likely fallbacks, in order of probability, are:

1. **Object form** — wrap each value in an object:
   ```jsonc
   "addSuccessCodes": [{ "LoadBalancerSuccessCode": 303 }]
   ```
2. **Full replace** — declare the full set instead of add/remove:
   ```jsonc
   "successCodes": [303]
   ```
3. **Introspect** the live schema for the real input type name (likely `WebApplicationLoadBalancerHealthCheckUpdateInput` or similar) and adjust the script accordingly:
   ```graphql
   { __type(name: "WebApplicationLoadBalancerHealthCheckUpdateInput") { inputFields { name type { name kind ofType { name kind } } } } }
   ```

Once a shape is confirmed against the live API, update `updateHealthCheckCodes()` in the script and this README accordingly.

---

## Related API operations (for reference)

The building blocks the portal uses for the LB panel:

| Operation                       | Purpose                                                                                          |
|---------------------------------|--------------------------------------------------------------------------------------------------|
| `updateWebApplicationAsset`     | Single mutation reused for all LB edits — `isLoadBalancer` toggle, upstreams, algorithm, healthcheck. |
| `WafWebApplicationAsset` query  | Reads the full asset including `loadBalancerSetting { upstreams, healthCheckSettings { successCodes { id, LoadBalancerSuccessCode } } }`. |
| `asyncPublishChanges` mutation  | Replaces the legacy synchronous `publishChanges`. Returns immediately; validation is async.       |
| `getUnenforcedPublishedSessions`| Lists sessions ready to be enforced. Useful as a settle-hint between publish and enforce.        |
| `enforcePolicy` mutation        | Pushes the published policy to the data plane. Returns an async task id.                         |
| `getTask` query                 | Polls the status of an async task by id.                                                         |

The double slash in the GraphQL URL (`/app/waf//graphql`) is intentional — that is the actual path the portal hits.
