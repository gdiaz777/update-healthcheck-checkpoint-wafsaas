// ============================================================================
// update-healthcheck-checkpoint-wafsaas.ts
// ----------------------------------------------------------------------------
// Updates the load-balancer health-check expected response code(s) of an
// existing Web Application asset in Check Point CloudGuard WAF SaaS /
// Infinity Next.
//
// Why this exists: the portal wizard / load-balancer panel always seeds the
// health check with HTTP 200 as the only success code, and the captured HAR
// (loadbalancing/assets_upstream.har) confirms the portal does not send
// `successCodes` in the update mutation when the user keeps the default.
// This script lets you change that to any other code (e.g. 303 for a backend
// that redirects on healthy) without touching upstreams or algorithm.
//
// Usage (run from the repo root so dotenvx picks up the .env at the root):
//   dotenvx run -- deno run -A loadbalancing/update-healthcheck-checkpoint-wafsaas.ts \
//       --asset <assetName> [--code 303] [--dry-run]
//
//   --asset    name of the existing WAF asset (required)
//   --code     comma-separated list of HTTP success codes (default 303)
//   --dry-run  print the planned mutation but do not send it
//
// See loadbalancing/README.md for a full walkthrough and the fallback
// payload shapes if the API rejects the current one.
// ============================================================================

const WAF_GRAPHQL_URL = "https://cloudinfra-gw.portal.checkpoint.com/app/waf//graphql";

let wafSession: any = null;
let FILEPATH: string | null = null;

function parseArgs(argv: string[]): { asset: string; codes: number[]; dryRun: boolean } {
    let asset = "";
    let codesRaw = "303";
    let dryRun = false;
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--asset") asset = argv[++i];
        else if (a === "--code" || a === "--codes") codesRaw = argv[++i];
        else if (a === "--dry-run") dryRun = true;
    }
    if (!asset) {
        console.error("Missing --asset <name>");
        Deno.exit(2);
    }
    const codes = codesRaw.split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isFinite(n));
    if (codes.length === 0) {
        console.error("No valid HTTP codes parsed from", codesRaw);
        Deno.exit(2);
    }
    return { asset, codes, dryRun };
}

async function wafLogin(url: string, clientId: string, accessKey: string) {
    const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId, accessKey }),
    });
    if (r.ok) {
        console.log("Login successful");
        return await r.json();
    }
    console.error("Login failed:", r.status, await r.text());
    return null;
}

async function gql(operationName: string, query: string, variables: Record<string, unknown>) {
    const token = wafSession?.data?.token;
    const r = await fetch(WAF_GRAPHQL_URL, {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${token}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ operationName, variables, query }),
    });
    const data = await r.json();
    if (!r.ok || data?.errors) {
        console.error(`${operationName} failed:`, JSON.stringify(data, null, 2));
        return null;
    }
    return data?.data;
}

// Resolves an asset id by exact name. Reuses the same getWafAssets query the
// deploy-assets script uses (filter class=["workload"], partial match).
async function findAssetIdByName(name: string): Promise<string | null> {
    const data = await gql(
        "WafAssetsName",
        "query WafAssetsName($matchSearch: [String], $sortBy: SortBy, $globalObject: Boolean, $filters: AssetsFilter, $paging: Paging) {\n  getWafAssets(\n    matchSearch: $matchSearch\n    sortBy: $sortBy\n    globalObject: $globalObject\n    filters: $filters\n    paging: $paging\n  ) {\n    assets {\n      id\n      name\n      assetType\n      __typename\n    }\n    __typename\n  }\n}\n",
        {
            matchSearch: [name],
            globalObject: false,
            paging: { offset: 0, limit: 50 },
            filters: { class: ["workload"] },
        },
    );
    const list = data?.getWafAssets?.assets ?? [];
    const match = list.find((a: any) => a.name === name);
    return match?.id ?? null;
}

// Reads the asset and returns the loadBalancerSetting block, including the
// current healthCheckSettings.successCodes (each entry has its own id).
// Used to (a) confirm the asset has load balancer enabled and (b) collect
// the ids of the existing success codes so we can remove them before adding
// the new one(s).
async function getLoadBalancerState(id: string): Promise<any | null> {
    const data = await gql(
        "WafWebApplicationAsset",
        "query WafWebApplicationAsset($id: ID!) {\n  getWafWebApplicationAsset(id: $id) {\n    id\n    name\n    isLoadBalancer\n    loadBalancerSetting {\n      id\n      algorithm\n      upstreams { id LoadBalancerUpstream __typename }\n      healthCheckSettings {\n        id\n        interval\n        intervalUnits\n        path\n        port\n        successCodes { id LoadBalancerSuccessCode __typename }\n        timeout\n        timeoutUnits\n        unhealthyThreshold\n        healthyThreshold\n        __typename\n      }\n      __typename\n    }\n    __typename\n  }\n}\n",
        { id },
    );
    return data?.getWafWebApplicationAsset ?? null;
}

// Sends the actual updateWebApplicationAsset mutation.
//
// IMPORTANT: the HAR does not contain a captured request that sets
// successCodes (the user kept the default 200), so the exact input shape is
// inferred from the parallel `addUpstreams / removeUpstreams /
// updateUpstreams` pattern used for upstreams in the same mutation. If the
// API rejects the shape, the error will be printed by gql() and the obvious
// alternatives to try are (in order):
//   1. healthCheckSettings.addSuccessCodes: [Int],     removeSuccessCodes: [ID]   ← current
//   2. healthCheckSettings.addSuccessCodes: [{LoadBalancerSuccessCode: Int}]
//   3. healthCheckSettings.successCodes:   [Int]                                  ← full replace
async function updateHealthCheckCodes(
    assetId: string,
    removeIds: string[],
    addCodes: number[],
    dryRun: boolean,
): Promise<boolean> {
    const variables = {
        id: assetId,
        assetInput: {
            loadBalancerSetting: {
                healthCheckSettings: {
                    addSuccessCodes: addCodes,
                    removeSuccessCodes: removeIds,
                    updateSuccessCodes: [],
                },
            },
        },
    };
    const query = "mutation updateWebApplicationAsset($assetInput: WebApplicationAssetUpdateInput!, $id: ID!) {\n  updateWebApplicationAsset(assetInput: $assetInput, id: $id)\n}\n";

    console.log("updateWebApplicationAsset variables:", JSON.stringify(variables, null, 2));
    if (dryRun) {
        console.log("(--dry-run) skipping API call");
        return true;
    }
    const data = await gql("updateWebApplicationAsset", query, variables);
    return data !== null;
}

// --- Publish + enforce (identical semantics to deploy-assets script) -------

async function asyncPublishChanges() {
    return await gql(
        "asyncPublishChanges",
        "mutation asyncPublishChanges($profileTypes: [ProfileType!], $skipNginxValidation: Boolean) {\n  asyncPublishChanges(\n    profileTypes: $profileTypes\n    skipNginxValidation: $skipNginxValidation\n  )\n}\n",
        { profileTypes: ["Docker", "CloudGuardAppSecGateway", "Embedded", "Kubernetes", "AppSecSaaS"] },
    );
}

async function enforcePolicy() {
    const data = await gql(
        "enforcePolicy",
        "mutation enforcePolicy($profilesIds: [ID!], $profileTypes: [ProfileType!]) {\n  enforcePolicy(profilesIds: $profilesIds, profileTypes: $profileTypes) {\n    id\n    tenantId\n    type\n    status\n    startTime\n    endTime\n    message\n    errorCode\n    referenceId\n    __typename\n  }\n}\n",
        { profileTypes: ["Docker", "CloudGuardAppSecGateway", "Embedded", "Kubernetes", "AppSecSaaS"] },
    );
    return data?.enforcePolicy;
}

async function getTask(taskId: string) {
    const data = await gql(
        "getTask",
        "query getTask($id: ID!) {\n  getTask(id: $id) {\n    id\n    status\n    startTime\n    endTime\n    message\n    errorCode\n    referenceId\n    tenantId\n  }\n}\n",
        { id: taskId },
    );
    return data?.getTask;
}

async function waitForTask(taskId: string) {
    console.log("Waiting for taskId:", taskId);
    while (true) {
        const task = await getTask(taskId);
        const status = task?.status;
        console.log("Task status:", status);
        if (status !== "InProgress") break;
        await new Promise((r) => setTimeout(r, 2000));
    }
}

async function getUnenforcedPublishedSessions(): Promise<any[]> {
    const data = await gql(
        "getUnenforcedPublishedSessions",
        "query getUnenforcedPublishedSessions {\n  getUnenforcedPublishedSessions {\n    id\n    __typename\n  }\n}\n",
        {},
    );
    return data?.getUnenforcedPublishedSessions ?? [];
}

async function waitForPublishedSession(maxAttempts = 30, intervalMs = 2000): Promise<boolean> {
    for (let i = 0; i < maxAttempts; i++) {
        const sessions = await getUnenforcedPublishedSessions();
        if (sessions.length > 0) {
            console.log(`Published session ready after ${i * intervalMs / 1000}s (${sessions.length} pending)`);
            return true;
        }
        await new Promise((r) => setTimeout(r, intervalMs));
    }
    console.warn("waitForPublishedSession timed out — running enforce anyway");
    return false;
}

async function publishAndEnforce() {
    console.log("Publishing changes...");
    const publish = await asyncPublishChanges();
    console.log("Publish result:", publish);

    await waitForPublishedSession();

    console.log("Enforcing policy...");
    const enforce = await enforcePolicy();
    console.log("Enforce result:", enforce);

    if (enforce?.id) await waitForTask(enforce.id);
    return true;
}

async function writeToFile(filePath: string, input: string) {
    try {
        await Deno.writeTextFile(filePath, input, { append: true });
    } catch (_e) { /* ignore */ }
}

async function main() {
    const { asset: assetName, codes, dryRun } = parseArgs(Deno.args);

    const now = new Date();
    const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}-${String(now.getMinutes()).padStart(2, "0")}`;
    FILEPATH = `./${stamp}_update-healthcheck_output.log`;

    const url = Deno.env.get("WAFAUTHURL")!;
    const clientId = Deno.env.get("WAFKEY")!;
    const accessKey = Deno.env.get("WAFSECRET")!;

    wafSession = await wafLogin(url, clientId, accessKey);
    if (!wafSession) {
        console.error("Login failed");
        Deno.exit(1);
    }

    const assetId = await findAssetIdByName(assetName);
    if (!assetId) {
        console.error(`Asset "${assetName}" not found`);
        Deno.exit(1);
    }
    console.log(`Asset "${assetName}" → id ${assetId}`);

    const state = await getLoadBalancerState(assetId);
    if (!state) {
        console.error("Could not read asset state");
        Deno.exit(1);
    }
    if (!state.isLoadBalancer || !state.loadBalancerSetting) {
        console.error(`Asset "${assetName}" does not have load balancer enabled. Enable it from the portal (or extend this script) before changing health-check codes.`);
        Deno.exit(1);
    }

    const currentCodes: { id: string; LoadBalancerSuccessCode: number }[] =
        state.loadBalancerSetting.healthCheckSettings?.successCodes ?? [];
    console.log("Current success codes:", currentCodes.map((c) => `${c.LoadBalancerSuccessCode} (${c.id})`).join(", ") || "(none)");

    // Idempotency: skip if the configured codes already match exactly.
    const currentValues = currentCodes.map((c) => c.LoadBalancerSuccessCode).sort();
    const desired = [...codes].sort();
    if (currentValues.length === desired.length && currentValues.every((v, i) => v === desired[i])) {
        console.log(`Health-check codes already set to ${desired.join(",")}; nothing to do.`);
        await writeToFile(FILEPATH, `Asset ${assetName}: no change (codes already ${desired.join(",")})\n`);
        return;
    }

    const removeIds = currentCodes.map((c) => c.id);
    console.log(`Replacing codes [${currentValues.join(",")}] → [${desired.join(",")}]`);

    const ok = await updateHealthCheckCodes(assetId, removeIds, codes, dryRun);
    if (!ok) {
        await writeToFile(FILEPATH, `Asset ${assetName}: updateWebApplicationAsset FAILED\n`);
        Deno.exit(1);
    }

    if (dryRun) {
        console.log("--dry-run; skipping publish/enforce");
        return;
    }

    await writeToFile(FILEPATH, `Asset ${assetName}: codes set to ${desired.join(",")}\n`);
    await publishAndEnforce();
    await writeToFile(FILEPATH, `Asset ${assetName}: publish/enforce OK\n`);
}

main()
    .then(() => console.log("done"))
    .catch((e) => {
        console.error("Error:", e);
        Deno.exit(1);
    });
