# Implementation Plan: L1 Automated Triage

## Overview

This plan implements L1 Automated Triage in **TypeScript/CDK** (matching the existing `src/cdk` codebase, Node.js canary/Lambda code, and fast-check for property-based tests). Work is decomposed into the five independently deployable slices defined in the design's "Incremental Deployment & Testing" section:

1. **Detection** — L1 Health Canary + availability alarm
2. **Routing** — EventBridge rule + Webhook Lambda + dedup
3. **Dependency resolution** — telemetry-first Dependency Resolver MCP (App Signals → X-Ray → optional overlay) + optional overlay table + weekly reconcile
4. **Investigation** — 6-step DevOps Agent triage skill
5. **Delivery** — Slack integration

Each slice ends with a deployability checkpoint (`cdk synth`/build + the slice's validation step) so the user can `cdk deploy` and test one capability at a time in an Isengard account. New constructs extend existing base classes (`WorkshopCanary`, `WorkshopLambdaFunction`), the `l1t-*` DynamoDB tables follow the existing storage-layer pattern, and the EventBridge rule attaches to the existing `workshop-eventbus`.

## Tasks

- [ ] 1. Slice 1 — Detection: L1 Health Canary and availability alarm
  - [ ] 1.1 Implement the L1 health-check canary script
    - Create Node.js canary under `src/applications/canaries/l1-health/` (runtime `syn-nodejs-puppeteer-9.1`)
    - Retrieve auth credentials from Secrets Manager before checks; on retrieval error, report a credential-failure status and skip all HTTP requests
    - Iterate every configured target URL, execute HTTP GET with a 30s timeout, and classify 2xx as success, non-2xx as failure, no-response as timeout
    - Emit structured JSON per URL `{ url, statusCode, responseBody, latencyMs, timestamp }` to `/aws/synthetics/{canary-name}`
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7_

  - [ ] 1.2 Implement the shared structured log entry parser/formatter module
    - Pure module (no AWS calls) that formats canary log entries and extracts `url`, `statusCode`/timeout indicator, and `responseBody`, tolerating missing fields
    - Reused later by the agent's log-extraction step
    - _Requirements: 1.7, 3.5_

  - [ ]* 1.3 Write property test for the log entry parser
    - **Property 3: Structured log completeness**
    - **Validates: Requirements 1.7, 3.5**
    - fast-check, min 100 iterations, tag `Feature: l1-automated-triage, Property 3: Structured log completeness`; generate log entries with random missing fields and assert graceful extraction

  - [ ] 1.4 Create the `L1HealthCanary` construct extending `WorkshopCanary`
    - Add construct under `src/cdk/lib/constructs/` following the `WorkshopCanary` pattern (reuse IAM role, S3 artifacts bucket, `rate(5 minutes)` schedule, X-Ray tracing); add Secrets Manager read access
    - Register the canary in the `applications` stage (`src/cdk/lib/stages/applications.ts`) alongside the existing canaries, reusing the existing `canaryArtifactBucket`
    - Parameterize target URLs, credentials secret ARN, and AWS account as deploy-time inputs
    - _Requirements: 1.1, 11.1, 11.2, 11.4_

  - [ ] 1.5 Add the availability CloudWatch Alarm on the canary `SuccessPercent` metric
    - Net-new alarm (evaluation period = 1, transitions to ALARM on any single failure), alarm name prefixed `l1t-health-`
    - _Requirements: 2.1, 11.1_

  - [ ]* 1.6 Write unit tests for the canary script logic
    - Cover credential-failure isolation, 2xx/non-2xx/timeout classification, and structured-log formatting
    - **Property 1: Health check execution completeness** and **Property 2: Credential retrieval failure isolation**
    - _Requirements: 1.1, 1.3, 1.4, 1.5, 1.6_

  - [ ]* 1.7 Write CDK snapshot/infrastructure test for the canary and alarm
    - Assert synthesized template contains the canary, the `l1t-health-` alarm on `SuccessPercent`, and least-privilege IAM (no unscoped wildcards beyond those the service requires)
    - _Requirements: 11.1, 11.4_

- [ ] 2. Checkpoint — Slice 1 deployable and testable
  - Run the CDK build and `cdk synth`; ensure all Slice 1 tests pass
  - Validation after `cdk deploy`: canary executes on schedule, failures appear in CloudWatch Synthetics, and the `l1t-health-` alarm transitions to ALARM
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 3. Slice 2 — Routing: EventBridge rule and Webhook Lambda
  - [ ] 3.1 Create the `l1t-investigation-locks` DynamoDB table
    - Add to the storage layer (`src/cdk/lib/stages/storage.ts` / DynamoDB construct pattern) with PK `canaryName` and TTL attribute enabled (15-min dedup window)
    - _Requirements: 2.6_

  - [ ] 3.2 Create the `L1WebhookLambda` construct extending `WorkshopLambdaFunction`
    - Node.js handler under `src/cdk/lib/serverless/functions/` (+ code under `src/applications/lambda/`), inheriting DLQ, structured logging, X-Ray, Application Signals
    - Parse the alarm event (canary name, alarm name, state-change timestamp, reason); perform a conditional put on the locks table for dedup; skip and log duplicates
    - Invoke the AWS DevOps Agent by POSTing an HMAC-signed webhook to the DevOps2025 Agent Space: build body `{eventType:"incident", incidentId, action:"created", priority, title, description, timestamp}`, sign per the DevOps Agent HMAC/Version 1 contract — `signature = base64(HMAC-SHA256(signingSecret, "<x-amzn-event-timestamp>:<body>"))` (timestamp and body colon-joined, base64 not hex), send headers `Content-Type`/`x-amzn-event-signature`/`x-amzn-event-timestamp`; read `{webhookUrl, hmacSecret}` from Secrets Manager; retry 3x exponential backoff (1s/2s/4s) on non-2xx/no-response
    - _Requirements: 2.3, 2.4, 2.6_

  - [ ] 3.3 Create the EventBridge rule on the **default event bus**
    - CloudWatch delivers alarm state-change events to the account default bus (NOT `workshop-eventbus`); reference it via `EventBus.fromEventBusName(this,'DefaultEventBus','default')`; rule pattern filters `aws.cloudwatch` "CloudWatch Alarm State Change", `alarmName` prefix `l1t-health-`, state `ALARM`; target the Webhook Lambda with an SQS DLQ
    - _Requirements: 2.2_

  - [ ] 3.4 Implement the Slack fallback notification on retry exhaustion
    - On exhaustion of all 3 agent-invocation retries, post a failure notification to `#l1-triage-alerts` (webhook URL from Secrets Manager) containing the canary name
    - _Requirements: 2.5_

  - [ ]* 3.5 Write unit tests for the Webhook Lambda
    - Cover dedup (conditional-put conflict skips invocation), retry/backoff behavior, and fallback trigger
    - **Property 5: Deduplication prevents concurrent investigations** and **Property 6: Retry exhaustion triggers Slack notification**; also assert the alarm→Lambda path meets **Property 4: Alarm-to-Lambda latency bound**
    - _Requirements: 2.4, 2.5, 2.6_

  - [ ]* 3.6 Write CDK infrastructure/snapshot test for rule, Lambda, and locks table
    - Assert the rule event pattern (default bus, `l1t-health-` prefix, ALARM), Lambda wiring, TTL-enabled table, and least-privilege IAM
    - _Requirements: 11.1, 11.4_

  - [ ] 3.7 Create the DevOps Agent webhook secret and Slack webhook secret (Secrets Manager)
    - Create a Secrets Manager secret holding `{webhookUrl, hmacSecret}` for the DevOps2025 Agent Space (placeholder value; operator populates post-deploy), and a Slack webhook secret; grant the Webhook Lambda `secretsmanager:GetSecretValue` scoped to each ARN
    - _Requirements: 2.3, 2.5, 11.4_

  - [ ] 3.8 Add the latency CloudWatch alarm on the L1 canary (Requirement 12.1)
    - Net-new alarm on the canary duration/latency metric, `l1t-health-` name prefix, threshold deploy-time configurable; enters the same routing path so slow-but-2xx also triggers triage
    - _Requirements: 12.1, 12.4_

  - [ ] 3.9 Scaffold the browser-based page-load/UI canary (Requirement 12.2/12.3)
    - New Synthetics Puppeteer canary construct + script: load the target page, measure page-load timing, verify a configured key UI element; add a `l1t-health-` prefixed availability alarm; keep independently deployable and separable from routing
    - _Requirements: 12.2, 12.3, 12.4_

- [ ] 4. Checkpoint — Slice 2 deployable and testable
  - Run the CDK build and `cdk synth`; ensure all Slice 2 tests pass
  - Validation after `cdk deploy`: force an `l1t-health-` alarm to ALARM and confirm EventBridge (default bus) routes to the Webhook Lambda, which dedups and attempts the DevOps Agent webhook (verify at log level while the HMAC secret is a placeholder), with Slack fallback on exhaustion
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 5. Slice 3 — Dependency resolution: telemetry-first Dependency Resolver MCP, optional overlay, and weekly reconcile
  - [ ] 5.1 Implement the Application Signals resolution source (primary)
    - Call `ListServiceDependencies` (downstream) and `ListServiceDependents` (upstream) on service `application-signals`; construct `KeyAttributes { Type: "Service", Name, Environment }` (max 4 entries); derive the `StartTime`/`EndTime` window (epoch seconds) from the failure timestamp, accounting for hour rounding; page via `NextToken` (MaxResults ≤ 100); normalize results into the `DependencyResolution` shape, carrying each dependency's `MetricReferences`
    - Handle `ThrottlingException` (retry 3x exponential backoff) and `ValidationException` (no retry)
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.7_

  - [ ] 5.2 Implement the X-Ray service-graph resolution source (fallback)
    - Call `GetServiceGraph` on service `xray` for the derived window; locate the target service node and read its downstream `Edges`; invert the graph to derive upstream dependents; normalize into the `DependencyResolution` shape
    - Handle `ThrottledException` (retry 3x backoff) and `InvalidRequestException` (no retry)
    - _Requirements: 5.2, 5.4, 5.7_

  - [ ] 5.3 Create the optional `l1t-service-dependencies` overlay table (last resort)
    - Add to the storage layer following the existing DynamoDB construct pattern; PK `serviceName`, attributes `dependencies` (List<Map>) and `lastRefreshedAt` (ISO 8601); the table is optional and its absence must not be an error
    - _Requirements: 6.1, 6.4_

  - [ ] 5.4 Author seed data for the validation target services (overlay gap-fill)
    - Define dependency records for the pet adoption services (RDS/Aurora + DynamoDB, per the real dependency map) matching the `ServiceDependencyOverlay`/`OverlayDependency`/`MetricDefinition` data models; used only to fill gaps telemetry does not cover
    - _Requirements: 6.1_

  - [ ] 5.5 Implement the weekly overlay reconcile Lambda
    - Scheduled via EventBridge `cron(0 2 ? * SUN *)`; reconciles operator-authored records from the seed source (committed file / SSM / ConfigMap) into the overlay table; updates `lastRefreshedAt`; retries up to 3 times and alerts on failure
    - _Requirements: 6.2, 6.3_

  - [ ] 5.6 Assemble the Dependency Resolver MCP server (telemetry-first)
    - Expose `resolve_service_dependencies(serviceName, environment, failureTimestamp)`; apply the resolution order App Signals → X-Ray → overlay; return downstream `dependencies` + upstream `dependents`; return an empty result gracefully; when served from the overlay, read a single item (target < 2s) and include a staleness warning when `lastRefreshedAt` > 14 days old
    - _Requirements: 5.1, 5.2, 5.5, 5.6, 6.1, 6.4, 6.5_

  - [ ]* 5.7 Write property test for the overlay staleness detector
    - **Property 9: Staleness warning on old data**
    - **Validates: Requirements 6.5**
    - fast-check, min 100 iterations, tag `Feature: l1-automated-triage, Property 9: Staleness warning on old data`; generate random `lastRefreshedAt` timestamps and assert the 14-day boundary

  - [ ]* 5.8 Write unit/integration tests for the resolver and reconcile
    - Cover the resolution order (App Signals available → downstream + upstream; App Signals empty → X-Ray fallback; both empty → overlay), `KeyAttributes` construction, hour-rounded window derivation, throttle retry/backoff, X-Ray upstream inversion, empty-result handling, and overlay-latency SLA; run the reconcile and verify table contents; **Property 8: Dependency resolution returns within SLA**
    - _Requirements: 5.1, 5.2, 5.5, 6.1, 6.4_

- [ ] 6. Checkpoint — Slice 3 deployable and testable
  - Run the CDK build and `cdk synth`; ensure all Slice 3 tests pass
  - Validation after `cdk deploy`: resolve a known service and confirm downstream dependencies + upstream dependents come back from Application Signals; verify the X-Ray fallback and the optional overlay both work when telemetry is empty
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 7. Slice 4 — Investigation: 6-step DevOps Agent triage skill
  - [ ] 7.1 Implement the URL parser / service-identification module (Step 2)
    - Pure module: map ALB DNS to service name, with path-segment fallback (e.g. `/{service}/health/status`); mark unrecognized URLs and preserve the raw URL
    - _Requirements: 4.1, 4.2, 4.3_

  - [ ]* 7.2 Write property test for the URL parser
    - **Property 7: URL parsing extracts service identity**
    - **Validates: Requirements 4.1, 4.2, 4.3**
    - fast-check, min 100 iterations, tag `Feature: l1-automated-triage, Property 7: URL parsing extracts service identity`

  - [ ] 7.3 Implement the canary log-extraction step (Step 1)
    - Query CloudWatch Logs Insights on `/aws/synthetics/{canary-name}` for the most recent failure in the last 60 min; extract URL, status code, error body (first 2048 chars) via the shared parser (Task 1.2); handle no-entries, inaccessible-log-group, and missing-field cases and terminate/annotate as specified
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5_

  - [ ] 7.4 Implement the dependency-resolution step (Step 3)
    - Call the Dependency Resolver MCP `resolve_service_dependencies(serviceName, environment, failureTimestamp)` within a 5s budget; consume both downstream `dependencies` and upstream `dependents`; on empty result or MCP failure/timeout, annotate the output and continue with deployment correlation only
    - _Requirements: 5.1, 5.5, 5.6_

  - [ ] 7.5 Implement the dependency-metrics query step (Step 4)
    - For each dependency, query CloudWatch `GetMetricData` over the exact 15-min window preceding the failure, 60s period, Average statistic; prefer the source-supplied `metricReferences` when present, otherwise fall back to per-type metric sets (RDS: CPUUtilization/DatabaseConnections/FreeableMemory; DynamoDB: ThrottledRequests/SystemErrors/ConsumedReadCapacityUnits; ElastiCache/MSK per design); skip unknown types with no metric references and warn; retry 3x with backoff then annotate the failed dependency
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7_

  - [ ]* 7.6 Write property test for the metrics time-window builder
    - **Property 10: Metric query covers correct time window**
    - **Validates: Requirements 7.1**
    - fast-check, min 100 iterations, tag `Feature: l1-automated-triage, Property 10: Metric query covers correct time window`

  - [ ] 7.7 Implement the deployment-correlation step (Step 5)
    - Query CodePipeline `ListPipelineExecutions` for the affected service's pipeline within the 60 min preceding the failure (up to 10); include execution id/start/status; mark "zero deployments" and, on API failure/timeout, "inconclusive"
    - _Requirements: 8.1, 8.2, 8.3, 8.4_

  - [ ] 7.8 Implement the confidence calculator and RCA + Runbook KB step (Step 6)
    - Correlate metric anomalies within the 15-min window to determine root cause; match against the Runbook KB (RDS CPU>90%, ElastiCache Evictions>1000/min, MSK UnderReplicatedPartitions>0); assign confidence High (3+ metrics) / Medium (2) / Low (≤1 or no match)
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7_

  - [ ]* 7.9 Write property test for the confidence calculator
    - **Property 11: Confidence level assignment is deterministic**
    - **Validates: Requirements 9.7**
    - fast-check, min 100 iterations, tag `Feature: l1-automated-triage, Property 11: Confidence level assignment is deterministic`; cover 0/1/2/3+ correlated-metric boundaries

  - [ ] 7.10 Assemble the "L1 Microservice Triage" skill and wire the steps together
    - Define the skill (steps 1–6 with their tools), produce a `TriageResult`, and replace the Slice 2 log-only agent stub so the Webhook Lambda invokes the real skill
    - _Requirements: 3.1, 4.1, 5.1, 7.1, 8.1, 9.1_

  - [ ]* 7.11 Write unit tests for the triage steps
    - Cover metrics retry/skip, deployment "inconclusive", and runbook no-match → Low confidence
    - _Requirements: 7.6, 8.4, 9.3_

- [ ] 8. Checkpoint — Slice 4 deployable and testable
  - Run the CDK build and `cdk synth`; ensure all Slice 4 tests pass
  - Validation after `cdk deploy`: run the full 6-step skill against a real failure and confirm metrics and deployment correlation produce a root cause
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 9. Slice 5 — Delivery: Slack integration
  - [ ] 9.1 Implement the Slack Block Kit message builder
    - Pure module: build a message with separately labeled sections for failed URL, service name, dependency issue, root cause, recommended fix, and confidence; render an "unavailable" indicator for missing values rather than omitting the field
    - _Requirements: 10.1, 10.2_

  - [ ]* 9.2 Write property test for the Slack message builder
    - **Property 12: Slack message contains all required fields**
    - **Validates: Requirements 10.1, 10.2**
    - fast-check, min 100 iterations, tag `Feature: l1-automated-triage, Property 12: Slack message contains all required fields`; generate `TriageResult` objects with null/present fields

  - [ ] 9.3 Implement partial-findings handling
    - When triage fails at step N (>1), build a message including all values gathered in steps 1..N-1 and naming the failed step
    - _Requirements: 10.3_

  - [ ]* 9.4 Write property test for partial findings
    - **Property 13: Partial findings on triage failure**
    - **Validates: Requirements 10.3**
    - fast-check, min 100 iterations, tag `Feature: l1-automated-triage, Property 13: Partial findings on triage failure`

  - [ ] 9.5 Implement Slack delivery with retry and undelivered-payload logging
    - Post to `#l1-triage-alerts` on triage completion; retry 3x with backoff; on failure, log the undelivered payload and Slack error response to CloudWatch for later retrieval; wire delivery into the skill completion path
    - _Requirements: 10.1, 10.4_

  - [ ]* 9.6 Write integration test for end-to-end delivery
    - Invoke with a mock `TriageResult` and verify the message arrives in a test channel; verify undelivered-payload logging on simulated failure
    - _Requirements: 10.1, 10.2, 10.3, 10.4_

- [ ] 10. Checkpoint — Slice 5 deployable and end-to-end
  - Run the CDK build and `cdk synth`; ensure all Slice 5 tests pass; confirm idempotent redeploy (`cdk synth` stable, no duplicate resources)
  - Validation after `cdk deploy`: run an end-to-end triage and confirm the findings message arrives in `#l1-triage-alerts`
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional test tasks and can be skipped for a faster MVP; core implementation tasks are never optional.
- Property-based tests use **fast-check** (min 100 iterations) and cover the pure-logic properties (3, 7, 9, 11, 12, 13). Properties 1, 2, 4, 5, 6, 8, 10 are validated via unit/integration tests as noted in their tasks.
- Each slice is additive and independently deployable; the checkpoint after each slice is the `cdk deploy` + validation gate before starting the next slice.
- New constructs extend existing base classes (`WorkshopCanary`, `WorkshopLambdaFunction`), reuse the existing `workshop-eventbus` and canary artifacts bucket, and add `l1t-*` tables via the established storage-layer DynamoDB pattern. The `l1t-service-dependencies` table is an **optional overlay**, not the primary dependency source.
- Dependency resolution is **telemetry-first**: the Dependency Resolver MCP queries CloudWatch Application Signals (`ListServiceDependencies` + `ListServiceDependents`) first, falls back to the X-Ray service graph (`GetServiceGraph`), and only then consults the optional DynamoDB overlay. This keeps the system application-agnostic. The resolver/agent role needs `application-signals:ListServiceDependencies`, `application-signals:ListServiceDependents`, `xray:GetServiceGraph`, and `dynamodb:GetItem` on the overlay table (least-privilege per Req 11.4).
- All resources deploy via `cdk deploy` to a deploy-time account parameter (Isengard-friendly) with no manual console steps.

## Candidate Follow-Ups (post Slices 2–5)

These extend detection coverage beyond backend/API availability once the detection → triage plumbing (Slices 2–5) exists. Not in scope for the current slices.

- **UI-glitch coverage via the browser canary.** The L1 API health canary is blind to browser-only failures (broken/missing buttons, JavaScript/rendering/styling errors, browser timing/race conditions) because it makes raw API requests and never renders a page. To triage these, extend Slice 2's EventBridge routing rule to also trigger off the existing browser canary's (`petsite-canary`) failure alarm, so UI-experience failures enter the same triage flow. Note the root-cause signal from a browser failure is messier (UI vs. timing vs. network vs. backend) and the triage skill would need a UI-oriented branch.
- **Latency/slowness alerting (not just availability).** The L1 canary already records per-request latency in its structured logs, but the Slice 1 alarm only fires on failure (non-2xx or timeout > 30s); a slow-but-successful response (e.g. 200 OK after 8s) is logged as success and does not alarm. Add a separate latency alarm (e.g. p90 response time > threshold) alongside the availability alarm to catch degradation before it becomes an outage. This measures API/backend response time, not full page-render time.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2"] },
    { "id": 1, "tasks": ["1.3", "1.4"] },
    { "id": 2, "tasks": ["1.5", "1.6"] },
    { "id": 3, "tasks": ["1.7", "3.1"] },
    { "id": 4, "tasks": ["3.2"] },
    { "id": 5, "tasks": ["3.3", "3.4"] },
    { "id": 6, "tasks": ["3.5", "3.6"] },
    { "id": 7, "tasks": ["5.1", "5.2", "5.3"] },
    { "id": 8, "tasks": ["5.4", "5.5"] },
    { "id": 9, "tasks": ["5.6"] },
    { "id": 10, "tasks": ["5.7", "5.8"] },
    { "id": 11, "tasks": ["7.1", "7.3"] },
    { "id": 12, "tasks": ["7.2", "7.4", "7.5"] },
    { "id": 13, "tasks": ["7.6", "7.7", "7.8"] },
    { "id": 14, "tasks": ["7.9", "7.10"] },
    { "id": 15, "tasks": ["7.11", "9.1"] },
    { "id": 16, "tasks": ["9.2", "9.3"] },
    { "id": 17, "tasks": ["9.4", "9.5"] },
    { "id": 18, "tasks": ["9.6"] }
  ]
}
```
