# L1 Automated Triage — Validation Results

Records live validation of the canary → alarm → EventBridge → webhook → AWS DevOps Agent
chain against real incidents in the `one-observability-demo` validation target (account
`937747800891`, `us-east-1`). Supersedes the commit-message-only record of these events
(`2d43a9eb`, `ae8048b6`, and the Slice 1/2 fix commits) with a single reviewable artifact.

## Summary

| Incident | Canary | Trigger | Chain result | RCA correct? |
|---|---|---|---|---|
| 1 | `l1t-ux-canary` | Real outage: `petlistadoptions-py` scaled to 0 | Detection gap found and fixed (see below) | N/A — detection-layer bug, not a triage run |
| 2 | `l1t-ux-canary` | Live re-validation (no outage) | 2 false positives found and fixed | N/A — false-positive fixes, not a triage run |
| 3 | `l1t-cart-canary` | Injected: `petfood-rs` `list_foods` forced 500 | Full chain fired end-to-end, DevOps Agent investigated autonomously | Yes — root cause and timeline matched independently-verified evidence |

Incident 3 is the only run that exercised the complete chain including a real DevOps Agent
investigation and RCA. Incidents 1–2 hardened the detection layer (Slice 1/2) that incident 3
then relied on.

---

## Incident 1 — UX canary missed a real outage (detection gap)

**What happened:** `petlistadoptions-py` was scaled to 0 as a Level 2 failure-injection test.
The app rendered the outage as an HTTP 200 page with an in-page error banner in place of the
adoption list — not a non-2xx status, not a timeout. The original UX canary design checked for
a single structural DOM selector's presence, which was unaffected by the outage, so the canary
(and the separate API health canary) both **passed throughout the outage**.

**Fix:** Redesigned the canary to assert real per-page content instead of DOM-selector presence
(commit `e4fb178f`). Added unit tests that explicitly reproduce this failure mode.

**Disposition:** Detection-layer bug, found and fixed before any triage/DevOps Agent involvement.
Not a chain-validation run — no incident reached the webhook or Agent.

## Incident 2 — Two false positives found via live re-validation

**What happened:** After the incident 1 fix, live re-validation against the real app surfaced
two false-positive classes:
- Adoption-list page: the `.pet-item` check failed whenever nobody had adopted anything yet,
  even though a correctly-rendered "No adoption data available" empty state is not an error.
- Buy Food page: PetSite's template always renders a hidden, empty `.alert-danger` placeholder
  (populated by client-side JS only on a real error). Checking for DOM *presence* of the error
  selector was a guaranteed false positive, since the node is always present, just hidden.

**Fix:** Added a configurable `emptyStateSelector` treated as OK, and changed the secondary
error-indicator check to require visibility (not just DOM presence) — commit `5a134fd7`.

**Disposition:** Detection-layer hardening. Not a chain-validation run.

## Incident 3 — Full chain validation via injected failure

**What happened:** A temporary bug was injected into `petfood-rs`'s `list_foods` handler
(commit `2d43a9eb`) forcing `GET /api/foods` to return HTTP 500. Purpose: prove the full
`canary → alarm → EventBridge → webhook Lambda → AWS DevOps Agent` chain fires end-to-end and
produces a correct investigation, not just that individual components work in isolation.

**What actually happened during the test (worth recording, not just the result):**
- A stale Rust container build issue (unrelated upstream `aws-smithy-json`/`aws-smithy-types`
  crates.io version-skew, exposed by a pre-existing `.dockerignore` gap) initially prevented the
  bug from even reaching a deployed container. Root-caused and fixed
  (`083ec48c`) before the injected bug ever went live — first attempt showed a "clean" pipeline
  that had not actually deployed the change.
- Once genuinely deployed, the webhook Lambda's DevOps Agent secret (`l1t-devops-agent-webhook`)
  was still its CDK-generated placeholder — every earlier alarm (including a stale UX-canary
  alarm from hours before) had silently no-opped at the webhook step with
  `"DevOps Agent webhook URL is a placeholder; skipping real invocation"`. The account already
  had a working DevOps Agent webhook secret (`DevOpsAgent`, agent space `DevOps2025`, created
  June, in active use for other use cases) — copied its real `webhookUrl`/`hmacSecret` into the
  L1 triage secret to fix.
- The alarm was manually reset to `OK` and allowed to re-fire naturally from the still-genuinely-failing
  canary, to get a clean, causally-correct `OK → ALARM` transition to test against (rather than reusing
  a stale alarm state).

**Chain evidence (all timestamps UTC, 2026-09-15):**

| Hop | Evidence | Timestamp |
|---|---|---|
| Canary fails | `l1t-cart-canary` run: `Add to cart button was not found on the page` | 15:51 run (recurring since ~12:08) |
| Alarm fires | `l1t-health-l1t-cart-canary-availability` → `ALARM` | 15:51:33.856 |
| Webhook Lambda invoked | CloudWatch Logs: alarm parsed, `agentInvocationId` generated | 15:51:34.788 (~1s later) |
| Webhook accepted | `"DevOps Agent webhook accepted","status":200,"attempt":1` | 15:51:36.957 |
| Dedup lock written | DynamoDB `l1t-investigation-locks` item for `l1t-cart-canary` | 15:51:36.090 |
| Agent picks up task | Backlog task `INVESTIGATION`, agent space `DevOps2025` | 15:51:37.145 |
| Agent completes investigation | Task status `COMPLETED`, findings generated | ~15:52 |

**Root cause identified by the DevOps Agent (independently, no hints given):**
A regressed `petfood-rs:latest` image (digest `sha256:87dd0a6c...`, pushed 12:00:51 UTC) was
activated by a manual `ecs update-service --force-new-deployment` at 12:08:27 UTC. The task
definition pinned the app container to the mutable `:latest` tag with no digest, so the routine
redeploy silently pulled the broken build. `GET /api/foods` faulted in `list_foods`
(`src/handlers/api.rs:81`), the FoodService page rendered zero products, and the canary's
"Add to cart" button never appeared.

**Verification against independently-known facts:** the Agent's timeline, root cause, and
contributing factor (`:latest` with no digest pin) exactly matched the operator's own
independently-derived understanding of the incident, obtained by direct AWS CLI investigation
before the Agent's report was read. No discrepancies.

**One correction the Agent made on its own:** it flagged that the 15:49 manual alarm reset and
15:51 re-alarm were "a DevOps-Agent-webhook test artifact" and that the real failure had been
continuous since ~12:08 UTC — it was not fooled by the artificial reset used to get a clean
test transition.

**Mitigation proposed by the Agent (validated, not auto-executed):** register a new ECS task
definition revision pinning the app container to the last known-good image by digest
(`sha256:18b63fe2...`), then update the service. This is the same fix independently applied
to restore the service (task-def revision `:3`, ECS `petfood-rs`).

**Resolution:** injected bug reverted in source (`ae8048b6`); ECS rolled back to the known-good
digest (task-def revision `:3`, pinned by digest instead of `:latest`); confirmed
`GET /api/foods` returns 200 with real data; `l1t-cart-canary` passing on 3 consecutive runs;
alarm self-healed to `OK`.

**Disposition: chain fully validated end-to-end against a real (injected) incident, with a
correct, independently-verified root cause.**

---

## Slices 3–4 (Dependency Resolver MCP + scripted 6-step triage skill) — not built

**Original design intent (see `design.md`):** a purpose-built Dependency Resolver MCP server
(CloudWatch Application Signals → X-Ray service graph → optional DynamoDB overlay fallback) and
a scripted 6-step investigation runbook, on the assumption the DevOps Agent would need hand-built
tooling to map service topology and follow a fixed process.

**Finding from Incident 3:** the DevOps Agent's investigation (see journal/backlog task
`5da3b85a-b6f5-4e28-b6f2-53a366c129bf`, execution `exe-ops1-745a5e98-1bf0-4c47-a600-50569d2462ad`)
performed the equivalent of Slices 3–4 using only its native reasoning and generic AWS read
access — no custom MCP server or fixed skill script was invoked or needed:
- Checked ECS service/task state and ALB target-group health directly.
- Pulled X-Ray traces to isolate the fault to the `list_foods` handler.
- Correlated CloudTrail history to find the exact `force-new-deployment` API call that
  activated the regressed image.
- Read ECR image push timestamps to identify the specific regressed digest.
- Cross-referenced DynamoDB table state and SSM parameter values.
- When it hit IAM permission gaps (see below), it adapted by itself — pivoted to CloudWatch
  Logs and X-Ray rather than stalling or reporting failure.

This is the job Slices 3–4 were designed to do, produced correctly without the extra
infrastructure, on a well-instrumented target (X-Ray, CloudTrail, and ECS all visible to the
Agent's role).

**Decision: skip building Slices 3–4 as separate infrastructure for this validation target.**
Recorded as a tested finding (native agent capability supersedes the custom resolver/skill for
this app), not as an untested gap. `tasks.md` should reflect this disposition rather than being
left as an open backlog item.

**Caveat for the app-agnostic sample repo** (`sample-synthetic-canary-devops-agent`): this
finding is specific to a well-instrumented target. An application with weaker observability
(no X-Ray, no CloudTrail visibility, un-instrumented services) may still need the declared-overlay
fallback described in Slice 3. Recommendation: keep the Dependency Resolver MCP / 6-step skill
in the sample repo's design as an **optional extension** for weakly-instrumented targets, not as
a required component.

## Follow-up: IAM permission gaps hit by the Agent during Incident 3

The Agent's own investigation gaps (worth closing — cheaper than building a resolver, and
strictly improves the Agent's existing native investigation quality):

1. `s3:GetObject` denied on the canary artifact bucket
   (`microservices-microservice-canaryartifacts...`) — the Agent's role can `List` but not
   `GetObject`, so failure screenshots and HAR/HttpRequestsReport JSON could not be read
   directly; investigation pivoted to CloudWatch Logs + X-Ray instead.
2. `ssm:GetParametersByPath` denied on `/petstore/` for role `DevOpsAgentRole-AgentSpace-on8z20ok`
   — could not confirm whether `petfood-rs` resolves real table/bus names from SSM at runtime
   vs. using literal env values directly. This left the Agent's placeholder-env observation
   (see below) as a hypothesis rather than a confirmed fact.

**Decision: skip.** Neither gap affected the correctness of the tested incident's RCA — the
Agent fully compensated for the S3 gap via CloudWatch Logs + X-Ray, and the resulting root
cause was independently verified as correct. Not actioning this IAM policy addition.

Note the two gaps are not equivalent in what skipping them costs: the S3 gap had no
downstream effect at all. The SSM gap means the placeholder-env side-finding below stays an
unconfirmed hypothesis rather than a checked fact — deliberately left unverified, not expected
to self-resolve.

## Side-finding from Incident 3 (unrelated to the injected bug, not yet verified)

The Agent independently flagged that the live `petfood-rs` task definition (revision `:2`, at
the time of investigation) carried literal placeholder environment variable values instead of
resolved resource names (e.g. `PETFOOD_FOODS_TABLE_NAME="foods_table_name"` rather than the real
DynamoDB table name). It could not fully confirm impact due to the SSM permission gap above. This
is a separate potential issue from the injected bug and root cause described in Incident 3.

**Deliberately left unverified.** Since the IAM gap that would let the Agent confirm this
(`ssm:GetParametersByPath` on `/petstore/*`) is not being fixed (see decision above), this
remains an open hypothesis rather than a checked fact — not because it's believed to be a
non-issue, but because closing it wasn't judged worth the IAM change for this validation cycle.
If `petfood-rs` env resolution is ever investigated by other means, revisit this finding.

## Slice 5 (Slack delivery) — not exercised

The webhook Lambda's Slack fallback path (`postSlackFallback`) exists in code but has not been
exercised by any real run: both real DevOps Agent invocations in this validation cycle (the two
UX-canary alarm events and the cart-canary event in Incident 3) received an HTTP 200 from the
Agent webhook on the first attempt, so retry exhaustion — the only path that triggers the Slack
fallback — never occurred. Slice 5 remains untested, not confirmed-working.
