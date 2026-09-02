# Requirements Document

## Introduction

L1 Automated Triage is a reusable, application-agnostic automated microservice health monitoring and root cause analysis system. Any application can adopt the system to detect API failures via CloudWatch Synthetics Canaries, investigate root causes through the DevOps Agent's 6-step triage skill, and deliver actionable findings to the operations team via Slack. The architecture consists of three phases: Detection (canary health checks), Investigation (DevOps Agent orchestration), and Delivery (Slack notification).

The system is designed to maximize reuse of existing detection infrastructure. The one-observability-demo stack already provides the CloudWatch Synthetics canary base class, a custom EventBridge bus, and Lambda base patterns; L1 Automated Triage builds on these primitives and adds only the missing investigation and delivery capabilities. The one-observability-demo pet adoption application is the initial validation target for the system, not a limit on its scope — the same triage system can be pointed at any application that exposes monitorable endpoints and infrastructure dependencies.

**Application-agnostic dependency resolution:** To remain applicable to any containerized application rather than a single hardcoded topology, the system resolves microservice-to-dependency relationships from observability telemetry rather than from a hand-maintained mapping. The primary source is CloudWatch Application Signals, which auto-discovers a service's downstream dependencies (databases, caches, queues, peer services) and its upstream dependents (callers, including CloudWatch Synthetics canaries) from OpenTelemetry data. AWS X-Ray's service graph is the fallback when Application Signals returns nothing, and an optional operator-authored declared overlay (a store such as DynamoDB, SSM, or a deliberately populated Kubernetes ConfigMap) is the last resort for gaps or un-instrumented applications. This telemetry-first model is what makes the triage reusable across applications: any instrumented app yields its dependency graph automatically, with no per-app authoring required.

**Reuse boundary:** The detection primitives — the CloudWatch Synthetics canary framework, the custom EventBridge bus, and the Lambda base patterns — are reused from the existing one-observability-demo infrastructure. The net-new components built by this feature are the alarm-to-agent routing (EventBridge rule plus Webhook Lambda), the dependency resolution MCP server, the 6-step investigation triage skill, and the Slack delivery integration.

## Glossary

- **Canary**: A CloudWatch Synthetics canary that performs periodic API health checks against non-production test URLs
- **DevOps_Agent**: The AI-powered DevOps Agent that orchestrates investigation workflows using skills and MCP tools
- **Triage_Skill**: The "L1 Microservice Triage" skill — a 6-step investigation runbook executed by the DevOps Agent
- **Dependency_Resolver_MCP**: A custom MCP server that resolves a microservice to its infrastructure dependencies and dependents, telemetry-first — querying CloudWatch Application Signals as the primary source, falling back to the AWS X-Ray service graph, and finally to an optional operator-authored declared overlay
- **Application_Signals**: CloudWatch Application Signals — the OpenTelemetry-based capability that auto-discovers services, their downstream dependencies, and their upstream dependents. Exposes `ListServiceDependencies` (downstream) and `ListServiceDependents` (upstream, including canaries)
- **Declared_Overlay**: An optional operator-authored dependency store (DynamoDB, SSM, or a deliberately populated Kubernetes ConfigMap) used only to fill gaps telemetry does not cover or to support un-instrumented applications
- **Webhook_Lambda**: An AWS Lambda function triggered by EventBridge that invokes the DevOps Agent with canary failure context
- **Service_Group**: A logical grouping of microservices identified by the first path segment after `/api-wg/` in the URL
- **Dependency**: An infrastructure component (AWS service, AWS resource, or third-party service) that an operation of a microservice connects with, as discovered from telemetry or a declared overlay
- **Dependent**: An entity that invokes a microservice (a peer service, a CloudWatch Synthetics canary, or a client), used to reason about the upstream blast radius of a failure
- **Runbook_KB**: A knowledge base of known failure patterns and their corresponding remediation steps
- **RCA**: Root Cause Analysis — the determination of why a microservice API failure occurred
- **Confidence_Level**: A qualitative indicator (High, Medium, Low) of certainty in the root cause determination

## Requirements

### Requirement 1: Canary Health Check Execution

**User Story:** As an operations engineer, I want automated API health checks running every 5 minutes against all monitored microservices, so that failures are detected promptly without manual intervention.

#### Acceptance Criteria

1. THE Canary SHALL execute an HTTP GET request against each configured non-production test URL every 5 minutes
2. THE Canary SHALL retrieve authentication credentials from AWS Secrets Manager before each execution
3. IF the Canary fails to retrieve credentials from AWS Secrets Manager, THEN THE Canary SHALL report a credential retrieval failure status to CloudWatch and skip the health check execution
4. WHEN the Canary receives an HTTP redirect (3xx) response with a Location header, THE Canary SHALL follow the redirect and evaluate the final response, following up to 5 redirect hops. A bare 3xx SHALL be treated as neither success nor failure on its own — only the final response after following the chain determines the outcome. (Rationale: a CDN such as CloudFront does not follow redirects itself; per AWS's documented behavior it relays the 3xx to the client, which is expected to follow it. See [How CloudFront processes HTTP 3xx status codes](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/http-3xx-status-codes.html).)
5. IF following redirects reaches a redirect loop, or exceeds 5 hops, or a redirect Location is invalid, THEN THE Canary SHALL report a failure status to CloudWatch
6. WHEN the final HTTP response (after following any redirects) has a status code outside the 2xx range, THE Canary SHALL report a failure status to CloudWatch
7. WHEN the Canary receives no HTTP response within 30 seconds, THE Canary SHALL report a timeout failure status to CloudWatch
8. WHEN the final HTTP response (after following any redirects) has a status code in the 2xx range, THE Canary SHALL report a success status to CloudWatch
9. THE Canary SHALL log the originally requested URL, the final URL after redirects, the redirect chain (each hop's status code and Location), the final response status code, response body (or absence of response in timeout cases), and latency in milliseconds to the CloudWatch Log Group `/aws/synthetics/{canary-name}`

### Requirement 2: Failure Detection and Agent Invocation

**User Story:** As an operations engineer, I want canary failures to automatically trigger the DevOps Agent investigation workflow, so that root cause analysis begins immediately without human initiation.

#### Acceptance Criteria

1. WHEN a Canary reports a failure status (execution result of "FAILED" or "TIMEOUT"), THE CloudWatch Alarm SHALL transition to ALARM state within 60 seconds of the failure being recorded
2. WHEN the CloudWatch Alarm transitions to ALARM state, THE EventBridge Rule (on the account default event bus, where CloudWatch delivers alarm state-change events) SHALL route the alarm event to the Webhook Lambda within 30 seconds
3. WHEN the Webhook_Lambda receives an alarm event, THE Webhook_Lambda SHALL invoke the DevOps_Agent by sending an HMAC-authenticated HTTP POST to the DevOps2025 Agent Space webhook (headers `Content-Type`, `x-amzn-event-signature` = base64-encoded HMAC-SHA256 of the string `<x-amzn-event-timestamp>:<body>` (timestamp and body joined by a colon), `x-amzn-event-timestamp` = ISO 8601 UTC; body containing eventType, incidentId, action, priority, title, description carrying the canary name, alarm name, alarm state change timestamp, and alarm reason) within 30 seconds of receiving the event, per the AWS DevOps Agent "Invoking DevOps Agent through Webhook" (HMAC / Version 1) contract
4. IF the Webhook_Lambda fails to invoke the DevOps_Agent (webhook returns a non-2xx response or no response is received within the request timeout), THEN THE Webhook_Lambda SHALL retry the invocation up to 3 times with exponential backoff starting at a 1-second base delay and doubling on each subsequent attempt
5. IF all retry attempts fail, THEN THE Webhook_Lambda SHALL publish a failure notification to the #l1-triage-alerts Slack channel within 60 seconds of the final retry failure, indicating the canary name and that triage could not be initiated
6. IF the Webhook_Lambda receives an alarm event for a canary that already has a DevOps_Agent invocation in progress, THEN THE Webhook_Lambda SHALL skip the duplicate invocation and log the event without triggering a new investigation

### Requirement 3: Canary Log Extraction

**User Story:** As the DevOps Agent, I want to extract failure details from canary logs, so that I can identify which API endpoint failed and how.

#### Acceptance Criteria

1. WHEN the Triage_Skill executes step 1, THE DevOps_Agent SHALL read the most recent failure log entry from CloudWatch Log Group `/aws/synthetics/{canary-name}` within the last 60 minutes
2. THE DevOps_Agent SHALL extract the failed request URL, HTTP status code, and error response body (up to the first 2048 characters) from the log entry
3. IF the canary log group contains no failure entries within the last 60 minutes, THEN THE DevOps_Agent SHALL report a message indicating the canary name and that no failure entries were found within the lookback window, and terminate the triage
4. IF the CloudWatch Log Group `/aws/synthetics/{canary-name}` does not exist or is not accessible, THEN THE DevOps_Agent SHALL report an error message indicating the log group name and the access failure reason, and terminate the triage
5. IF the failure log entry does not contain one or more of the expected fields (request URL, HTTP status code, or error response body), THEN THE DevOps_Agent SHALL extract the available fields and indicate which fields are missing in the triage output

### Requirement 4: Microservice Identification from URL

**User Story:** As the DevOps Agent, I want to identify the affected microservice from the failed URL path, so that I can look up its dependencies for investigation.

#### Acceptance Criteria

1. WHEN the Triage_Skill executes step 2, THE DevOps_Agent SHALL parse the URL path using the pattern `/api-wg/{service-group}/{service-name}/{endpoint}`, where `{endpoint}` captures all remaining path segments after `{service-name}` and any query parameters or fragments are ignored during parsing
2. WHEN the URL path is successfully parsed, THE DevOps_Agent SHALL extract the service-group and service-name segments and include both values in the triage output as the identified microservice
3. IF the URL path does not match the expected pattern (including cases where fewer than 3 segments follow `/api-wg/`), THEN THE DevOps_Agent SHALL mark the URL as unrecognized and include the raw URL in the triage output so that downstream steps can still reference the original path

### Requirement 5: Telemetry-First Dependency Resolution

**User Story:** As the DevOps Agent, I want to resolve the identified microservice to its infrastructure dependencies and its upstream dependents from observability telemetry, so that I can check the health of the services it relies on and reason about the blast radius of a failure without a hand-maintained topology.

#### Acceptance Criteria

1. WHEN the Triage_Skill executes step 3, THE DevOps_Agent SHALL call the Dependency_Resolver_MCP with the identified service-name, its environment, and the canary failure timestamp within 5 seconds
2. THE Dependency_Resolver_MCP SHALL resolve dependencies telemetry-first, in the following order: (a) query Application_Signals `ListServiceDependencies` and `ListServiceDependents` for the service; (b) IF Application_Signals returns no results or is unavailable, query the AWS X-Ray service graph for the service's downstream edges; (c) IF both telemetry sources return no results, consult the optional Declared_Overlay
3. WHEN resolving via Application_Signals, THE Dependency_Resolver_MCP SHALL construct the `KeyAttributes` map with at least `Type`, `Name`, and `Environment`, and SHALL supply a time window derived from the failure timestamp (noting that Application_Signals rounds the window to the nearest hour)
4. THE Dependency_Resolver_MCP SHALL return, for the requested microservice, a list of downstream dependencies and a list of upstream dependents, where each dependency entry includes the resource type, a resource identifier sufficient to perform a health check, and any metric references (namespace, metric name, dimensions) provided by the source
5. IF all resolution sources return no dependencies for the service, THEN THE DevOps_Agent SHALL include in the triage output that no known dependencies were found for the service and continue the triage with deployment correlation only
6. IF the Dependency_Resolver_MCP call fails or does not respond within 5 seconds, THEN THE DevOps_Agent SHALL include an error indication in the triage output stating that dependency resolution was unavailable and continue the triage with deployment correlation only
7. WHEN a source returns a throttling response (Application_Signals `ThrottlingException` or X-Ray `ThrottledException`), THE Dependency_Resolver_MCP SHALL retry that source up to 3 times with exponential backoff starting at 1 second before falling through to the next source in the resolution order

### Requirement 6: Declared Overlay and Resolution SLA

**User Story:** As a platform engineer, I want an optional declared dependency overlay that is refreshed on a schedule and served quickly, so that dependencies telemetry cannot see (or dependencies of un-instrumented applications) are still available to the resolver, and so that stale overlay data is flagged.

#### Acceptance Criteria

1. THE Declared_Overlay SHALL be optional: WHEN no overlay data exists for a service, THE Dependency_Resolver_MCP SHALL rely solely on telemetry sources and SHALL NOT treat the absence of overlay data as an error
2. THE Declared_Overlay refresh job SHALL execute once per week on a configured day and time, complete within 30 minutes, reconcile the operator-authored dependency records (from a seed source such as a committed file, an SSM parameter, or a Kubernetes ConfigMap) into the overlay data store, and update a last-refreshed timestamp in ISO 8601 UTC format
3. IF the refresh fails to complete within 30 minutes or encounters an unrecoverable error after up to 3 retry attempts, THEN THE refresh job SHALL send an alert notification to the operations team indicating the failure reason and the timestamp of the last successful refresh
4. WHEN the Dependency_Resolver_MCP serves a result that includes Declared_Overlay data, THE Dependency_Resolver_MCP SHALL return within 2 seconds for the overlay lookup portion
5. IF the Declared_Overlay contributes to a result and its last-refreshed timestamp is older than 14 days, THEN THE Dependency_Resolver_MCP SHALL include a staleness warning indicator in the response

### Requirement 7: Dependency Health Metrics Query

**User Story:** As the DevOps Agent, I want to query CloudWatch metrics for each dependency, so that I can identify which dependency is exhibiting anomalous behavior.

#### Acceptance Criteria

1. WHEN the Triage_Skill executes step 4, THE DevOps_Agent SHALL query CloudWatch metrics for each dependency returned by the Dependency_Resolver_MCP using a period of 60 seconds and the Average statistic for the 15-minute window preceding the canary failure timestamp. WHERE a dependency carries metric references supplied by the resolution source, THE DevOps_Agent SHALL prefer those metric references over the type-based defaults below
2. IF a dependency returned by the Dependency_Resolver_MCP is of type RDS, THEN THE DevOps_Agent SHALL query CPUUtilization, DatabaseConnections, and FreeableMemory metrics for that dependency
3. IF a dependency returned by the Dependency_Resolver_MCP is of type DynamoDB, THEN THE DevOps_Agent SHALL query ThrottledRequests, SystemErrors, and ConsumedReadCapacityUnits metrics for that dependency
4. IF a dependency returned by the Dependency_Resolver_MCP is of type ElastiCache, THEN THE DevOps_Agent SHALL query CurrConnections, CPUUtilization, and Evictions metrics for that dependency
5. IF a dependency returned by the Dependency_Resolver_MCP is of type MSK, THEN THE DevOps_Agent SHALL query UnderReplicatedPartitions and ActiveControllerCount metrics for that dependency
6. IF a dependency type returned by the Dependency_Resolver_MCP does not match any known type (RDS, DynamoDB, ElastiCache, MSK) and the dependency carries no metric references, THEN THE DevOps_Agent SHALL skip metric querying for that dependency and log a warning indicating the unrecognized dependency type
7. IF the CloudWatch metrics query fails for a dependency due to throttling, timeout, or service unavailability, THEN THE DevOps_Agent SHALL retry the query up to 3 times with exponential backoff starting at 1 second, and if all retries fail, proceed to the next dependency and include an error indication for the failed dependency in the output

### Requirement 8: Deployment Correlation

**User Story:** As the DevOps Agent, I want to correlate the failure with recent deployments, so that I can determine whether a code change caused the issue.

#### Acceptance Criteria

1. WHEN the Triage_Skill executes step 5, THE DevOps_Agent SHALL query GitHub for all deployments to the affected microservice within the 60 minutes preceding the failure and include all matching deployments (up to a maximum of 10) in the correlation data
2. WHEN one or more deployments are found within the 60-minute window, THE DevOps_Agent SHALL include for each deployment the full commit SHA, author identifier, and deployment timestamp in the correlation data
3. IF no deployments are found within the 60-minute window, THEN THE DevOps_Agent SHALL include a structured field in the triage output indicating that zero deployments were detected in the correlation window
4. IF the GitHub API request fails or does not respond within 30 seconds, THEN THE DevOps_Agent SHALL record the deployment correlation as inconclusive with an error indication in the triage output and continue the triage process

### Requirement 9: Root Cause Analysis and Fix Recommendation

**User Story:** As the DevOps Agent, I want to generate a root cause analysis with a recommended fix from the runbook knowledge base, so that the operations team receives actionable guidance.

#### Acceptance Criteria

1. WHEN the Triage_Skill executes step 6, THE DevOps_Agent SHALL correlate the dependency metrics, deployment data, and failure details to determine a root cause by identifying at least one metric anomaly that coincides with the reported failure within a 15-minute time window
2. WHEN a root cause is identified, THE DevOps_Agent SHALL match the identified root cause against patterns in the Runbook_KB to generate a fix recommendation within 30 seconds of root cause determination
3. IF the identified root cause does not match any pattern in the Runbook_KB, THEN THE DevOps_Agent SHALL return a response indicating no matching runbook entry was found, include the raw root cause analysis, and assign a Confidence_Level of Low
4. WHEN ElastiCache Evictions exceed 1000 evictions per minute, THE DevOps_Agent SHALL recommend scaling the node type
5. WHEN RDS CPUUtilization exceeds 90%, THE DevOps_Agent SHALL recommend adding a read replica or upsizing the instance
6. WHEN MSK UnderReplicatedPartitions is greater than zero, THE DevOps_Agent SHALL recommend scaling the consumer group
7. THE DevOps_Agent SHALL assign a Confidence_Level of High when 3 or more correlated metrics support the root cause, Medium when 2 correlated metrics support the root cause, and Low when only 1 metric or no Runbook_KB match supports the root cause

### Requirement 10: Slack Notification Delivery

**User Story:** As an operations engineer, I want triage findings delivered to Slack, so that the team is immediately informed of the root cause and recommended fix.

#### Acceptance Criteria

1. WHEN the Triage_Skill completes, THE DevOps_Agent SHALL post a message to the #l1-triage-alerts Slack channel within 30 seconds of completion containing separately labeled sections for each required field
2. THE Slack message SHALL include: the failed API URL, the identified microservice name, the dependency issue detected, the root cause determination, the recommended fix, and the Confidence_Level. IF any field value is unavailable from the triage output, THEN THE DevOps_Agent SHALL display that field with an indication that the value could not be determined
3. IF the Triage_Skill fails to complete, THEN THE DevOps_Agent SHALL post a partial findings message to the #l1-triage-alerts Slack channel within 30 seconds of the failure, indicating the name of the step that failed and the field values gathered before the failure
4. IF the DevOps_Agent fails to deliver a message to Slack after 3 retry attempts, THEN THE DevOps_Agent SHALL log the undelivered message payload and the Slack error response for later retrieval

### Requirement 11: Infrastructure as Code Deployment

**User Story:** As a platform engineer, I want all triage infrastructure defined as code, so that the system can be reliably deployed and version-controlled.

#### Acceptance Criteria

1. THE Infrastructure_Code SHALL define CloudWatch Synthetics Canaries, CloudWatch Alarms, EventBridge Rules, and the Webhook Lambda as deployable resources within a single infrastructure stack
2. THE Infrastructure_Code SHALL parameterize the AWS account ID, canary target URLs, Secrets Manager ARN, and Slack channel configuration as stack input parameters that can be supplied at deploy time without modifying template source
3. THE Infrastructure_Code SHALL deploy all resources to the PPCAWS232 account using a single deployment command with no manual resource creation required in the AWS Console
4. WHEN the infrastructure stack is deployed, THE stack SHALL create IAM roles for each component scoped to only the permissions required by that component, with no wildcard (*) resource ARNs except where the AWS service requires them
5. IF a stack deployment fails, THEN THE Infrastructure_Code SHALL roll back all resources to their prior state and report the failure reason in the deployment output
6. WHEN the infrastructure stack is redeployed with no parameter or template changes, THE stack SHALL complete successfully without creating duplicate resources or failing due to existing resource conflicts


### Requirement 12: Extended Detection (Latency and User-Experience)

**User Story:** As an operations engineer, I want the system to also detect slow-but-successful responses and browser-level (page-load / UI) problems, so that degradation and front-end failures trigger triage, not just hard API failures.

#### Acceptance Criteria

1. THE system SHALL define a latency CloudWatch Alarm on the L1 health canary's duration/latency metric that transitions to ALARM when the observed latency exceeds a configured threshold, even when the health check returns a 2xx status. This alarm SHALL use the `l1t-health-` name prefix so it enters the same routing path as the availability alarm.
2. THE system SHALL provide a browser-based (CloudWatch Synthetics Puppeteer) canary that visits the home page plus the application's key nav-journey pages, and on each page: (a) asserts that the page's real content rendered (a positive, page-specific selector — e.g. at least one list item), which is the primary signal because some application failures are rendered server-side as a normal 200-status page with an error message in place of the real content, undetectable by any HTTP-status or top-level navigation check; (b) as a secondary, non-authoritative signal, checks for a generic error indicator without depending on any application-specific error text, since error copy is application-defined and can change; and (c) watches for network responses >=400 and uncaught page-level JS errors during the visit. This canary SHALL be independently deployable and separable from the API health canary and the routing path. (Validated against a real reproduced incident: a backend dependency outage that PetSite's adoption-list page rendered as an HTTP 200 page with an error banner — undetectable by status-code checks alone, caught by the content assertion.)
3. WHEN the browser-based canary fails, THE system SHALL surface the failure via a CloudWatch Alarm using the `l1t-health-` name prefix so it can trigger the same routing → DevOps Agent flow.
4. THE latency threshold and the key UI element selector SHALL be deploy-time configurable inputs, so the extended detection is application-agnostic.
