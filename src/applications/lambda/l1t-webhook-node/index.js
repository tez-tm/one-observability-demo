/*
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: Apache-2.0
*/

/**
 * L1 Automated Triage — Webhook Lambda (Slice 2, Routing).
 *
 * Triggered by an EventBridge rule (on the account default bus) when an
 * `l1t-health-` CloudWatch alarm transitions to ALARM. It:
 *
 *   1. Parses the alarm event (canary name, alarm name, state-change time, reason).
 *   2. Deduplicates: conditional-put on the locks DynamoDB table keyed by
 *      canaryName; if an investigation is already in progress (item exists and
 *      not expired), the event is logged and skipped.
 *   3. Invokes the AWS DevOps Agent by POSTing an HMAC-signed webhook to the
 *      DevOps2025 Agent Space generic webhook. Retries 3x with exponential
 *      backoff (1s/2s/4s) on non-2xx / no response.
 *   4. On retry exhaustion (the Agent could not be invoked at all), publishes
 *      an invocation-failure alert to an SNS topic. This is distinct from
 *      routine findings/RCA delivery: those are posted by the DevOps Agent's
 *      own native Slack integration (configured out-of-band in the AWS
 *      DevOps Agent console, not by this Lambda) whenever an investigation
 *      actually runs. SNS only fires when the Agent never ran at all.
 *
 * DevOps Agent webhook contract (HMAC / Version 1):
 *   POST <webhookUrl>
 *   headers:
 *     Content-Type: application/json
 *     x-amzn-event-timestamp: <ISO 8601 UTC, e.g. 2025-11-23T18:00:00.000Z>
 *     x-amzn-event-signature: base64( HMAC-SHA256(secret, `${timestamp}:${body}`) )
 *   body: { eventType, incidentId, action, priority, title, description, timestamp[, service, data] }
 *
 * Configuration (environment variables set by the CDK construct):
 *   L1T_LOCKS_TABLE_NAME              DynamoDB dedup table
 *   L1T_DEVOPS_WEBHOOK_SECRET_ARN     Secrets Manager ARN -> { webhookUrl, hmacSecret }
 *   L1T_INVOCATION_FAILURE_TOPIC_ARN  SNS topic ARN, notified only on retry exhaustion
 *   L1T_DEDUP_TTL_SECONDS             dedup window (default 900)
 */

'use strict';

const crypto = require('node:crypto');
const https = require('node:https');
const { URL } = require('node:url');

// AWS SDK clients are loaded lazily so the pure helper functions can be
// unit-tested without the SDK present in the test environment. In the Lambda
// runtime these modules are bundled and available.
let _ddb;
let _PutCommand;
let _secrets;
let _GetSecretValueCommand;
let _sns;
let _PublishCommand;

function ddbClient() {
    if (!_ddb) {
        const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
        const { DynamoDBDocumentClient, PutCommand } = require('@aws-sdk/lib-dynamodb');
        _PutCommand = PutCommand;
        _ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
    }
    return _ddb;
}

function secretsClient() {
    if (!_secrets) {
        const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
        _GetSecretValueCommand = GetSecretValueCommand;
        _secrets = new SecretsManagerClient({});
    }
    return _secrets;
}

function snsClient() {
    if (!_sns) {
        const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');
        _PublishCommand = PublishCommand;
        _sns = new SNSClient({});
    }
    return _sns;
}

const DEDUP_TTL_SECONDS = Number(process.env.L1T_DEDUP_TTL_SECONDS) || 900;
const MAX_ATTEMPTS = 3;

/** Simple structured logger. */
function log(level, message, extra) {
    console.log(JSON.stringify({ level, message, ...extra }));
}

/**
 * Parse the CloudWatch Alarm State Change EventBridge event into the fields we
 * need. Tolerant of missing fields.
 *
 * @param {object} event EventBridge event
 * @returns {{alarmName: (string|null), canaryName: (string|null), stateValue: (string|null), stateTimestamp: (string|null), reason: (string|null)}}
 */
function parseAlarmEvent(event) {
    const detail = (event && event.detail) || {};
    const alarmName = typeof detail.alarmName === 'string' ? detail.alarmName : null;
    const state = detail.state || {};
    const stateValue = typeof state.value === 'string' ? state.value : null;
    const stateTimestamp = typeof state.timestamp === 'string' ? state.timestamp : (event && event.time) || null;
    const reason = typeof state.reason === 'string' ? state.reason : null;

    // Derive a canary name from the alarm name. Our alarms are named
    // `l1t-health-<canary>-availability` (or `-latency`); fall back to the
    // whole alarm name if the pattern does not match.
    let canaryName = alarmName;
    if (alarmName) {
        const m = alarmName.match(/^l1t-health-(.+?)-(availability|latency)$/);
        if (m) {
            canaryName = m[1];
        }
    }

    return { alarmName, canaryName, stateValue, stateTimestamp, reason };
}

/**
 * Read and JSON-parse a Secrets Manager secret.
 *
 * @param {string} secretArn
 * @returns {Promise<object>}
 */
async function readSecretJson(secretArn) {
    const client = secretsClient();
    const resp = await client.send(new _GetSecretValueCommand({ SecretId: secretArn }));
    const raw = resp.SecretString || '{}';
    try {
        return JSON.parse(raw);
    } catch (e) {
        return { raw };
    }
}

/**
 * Attempt to acquire the dedup lock for a canary via a conditional put.
 *
 * @param {string} canaryName
 * @param {string} agentInvocationId
 * @returns {Promise<boolean>} true if acquired, false if an investigation is already in progress
 */
async function acquireLock(canaryName, agentInvocationId) {
    const nowSec = Math.floor(Date.now() / 1000);
    const client = ddbClient();
    try {
        await client.send(
            new _PutCommand({
                TableName: process.env.L1T_LOCKS_TABLE_NAME,
                Item: {
                    canaryName,
                    startedAt: new Date().toISOString(),
                    agentInvocationId,
                    expiresAt: nowSec + DEDUP_TTL_SECONDS,
                },
                // Only succeed if there's no live lock. A DynamoDB item whose
                // TTL has passed may still be present until reaping, so also
                // allow overwrite when the stored expiresAt is in the past.
                ConditionExpression: 'attribute_not_exists(canaryName) OR expiresAt < :now',
                ExpressionAttributeValues: { ':now': nowSec },
            }),
        );
        return true;
    } catch (e) {
        if (e.name === 'ConditionalCheckFailedException') {
            return false;
        }
        throw e;
    }
}

/**
 * Build the DevOps Agent incident payload from the parsed alarm.
 *
 * @param {object} parsed
 * @param {string} incidentId
 * @returns {object}
 */
function buildIncidentPayload(parsed, incidentId) {
    return {
        eventType: 'incident',
        incidentId,
        action: 'created',
        priority: 'HIGH',
        title: `L1 triage: ${parsed.canaryName || parsed.alarmName || 'unknown'} health check failing`,
        description:
            `CloudWatch alarm ${parsed.alarmName} entered ${parsed.stateValue} at ${parsed.stateTimestamp}. ` +
            `Reason: ${parsed.reason || 'n/a'}. Canary: ${parsed.canaryName}. ` +
            `Investigate the affected microservice and its infrastructure dependencies.`,
        timestamp: new Date().toISOString(),
    };
}

/**
 * Compute the HMAC-SHA256 signature per the AWS DevOps Agent webhook contract
 * (HMAC / Version 1): sign the string `${timestamp}:${payload}` (timestamp and
 * body joined by a colon) with the secret, and base64-encode the digest.
 *
 * Ref: AWS DevOps Agent User Guide — "Invoking DevOps Agent through Webhook",
 * Example code (Version 1, HMAC): hmac.update(`${timestamp}:${payload}`);
 * signature = hmac.digest("base64").
 *
 * @param {string} hmacSecret
 * @param {string} timestamp ISO 8601 UTC used verbatim in the x-amzn-event-timestamp header
 * @param {string} body serialized JSON request body (signed verbatim)
 * @returns {string} base64 signature
 */
function computeSignature(hmacSecret, timestamp, body) {
    return crypto.createHmac('sha256', hmacSecret).update(`${timestamp}:${body}`, 'utf8').digest('base64');
}

/**
 * POST the signed payload to the DevOps Agent webhook. Resolves with the
 * status code; rejects on transport error/timeout.
 *
 * @param {string} webhookUrl
 * @param {string} hmacSecret
 * @param {object} payload
 * @returns {Promise<number>} HTTP status code
 */
function postWebhook(webhookUrl, hmacSecret, payload) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify(payload);
        const timestamp = new Date().toISOString().replace(/\.\d+Z$/, '.000Z');
        const signature = computeSignature(hmacSecret, timestamp, body);

        let parsed;
        try {
            parsed = new URL(webhookUrl);
        } catch (e) {
            reject(new Error(`Invalid webhook URL: ${e.message}`));
            return;
        }

        const options = {
            method: 'POST',
            hostname: parsed.hostname,
            port: parsed.port || 443,
            path: `${parsed.pathname}${parsed.search}`,
            timeout: 10000,
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
                'x-amzn-event-timestamp': timestamp,
                'x-amzn-event-signature': signature,
            },
        };

        const req = https.request(options, (res) => {
            let respBody = '';
            res.on('data', (c) => {
                respBody += c.toString();
            });
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode <= 299) {
                    resolve(res.statusCode);
                } else {
                    reject(new Error(`Webhook returned ${res.statusCode}: ${respBody.slice(0, 512)}`));
                }
            });
        });
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Webhook request timed out'));
        });
        req.on('error', (err) => reject(err));
        req.write(body);
        req.end();
    });
}

/** Sleep helper. */
function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

/**
 * Invoke the DevOps Agent webhook with retry + exponential backoff.
 *
 * @param {object} webhookConfig { webhookUrl, hmacSecret }
 * @param {object} payload
 * @returns {Promise<{ok: boolean, lastError: (string|null)}>}
 */
async function invokeWithRetry(webhookConfig, payload) {
    let lastError = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
            const status = await postWebhook(webhookConfig.webhookUrl, webhookConfig.hmacSecret, payload);
            log('info', 'DevOps Agent webhook accepted', { status, attempt });
            return { ok: true, lastError: null };
        } catch (e) {
            lastError = e.message;
            log('warn', 'DevOps Agent webhook attempt failed', { attempt, error: e.message });
            if (attempt < MAX_ATTEMPTS) {
                await sleep(1000 * Math.pow(2, attempt - 1)); // 1s, 2s, 4s
            }
        }
    }
    return { ok: false, lastError };
}

/**
 * Publish an invocation-failure alert to SNS. Fired only when all DevOps
 * Agent webhook retries are exhausted (the Agent never ran) — a distinct
 * failure mode from a completed investigation's findings, which the DevOps
 * Agent delivers itself via its native Slack integration when it does run.
 *
 * @param {string} topicArn
 * @param {string} canaryName
 * @param {string|null} lastError
 */
async function publishInvocationFailure(topicArn, canaryName, lastError) {
    if (!topicArn) {
        log('warn', 'No invocation-failure SNS topic configured; logging undelivered alert', { canaryName });
        return;
    }
    try {
        const client = snsClient();
        await client.send(
            new _PublishCommand({
                TopicArn: topicArn,
                Subject: `L1 triage: DevOps Agent unreachable for ${canaryName}`,
                Message:
                    `L1 automated triage could not invoke the AWS DevOps Agent for canary "${canaryName}" ` +
                    `after ${MAX_ATTEMPTS} attempts. The Agent did not run and no investigation was started. ` +
                    `Last error: ${lastError || 'unknown'}.`,
            }),
        );
        log('info', 'Invocation-failure alert published to SNS', { canaryName });
    } catch (e) {
        log('error', 'Failed to publish invocation-failure alert', { canaryName, error: e.message });
    }
}

/**
 * Lambda entry point.
 */
exports.handler = async (event) => {
    const parsed = parseAlarmEvent(event);
    log('info', 'Received alarm event', { parsed });

    if (parsed.stateValue && parsed.stateValue !== 'ALARM') {
        log('info', 'Ignoring non-ALARM state', { stateValue: parsed.stateValue });
        return { skipped: true, reason: 'not-alarm' };
    }
    if (!parsed.canaryName) {
        log('error', 'Could not determine canary name from event; nothing to do', {});
        return { skipped: true, reason: 'no-canary' };
    }

    const agentInvocationId = `l1t-${parsed.canaryName}-${Date.now()}`;

    // Dedup
    let acquired;
    try {
        acquired = await acquireLock(parsed.canaryName, agentInvocationId);
    } catch (e) {
        log('error', 'Dedup lock error; proceeding without dedup guarantee', { error: e.message });
        acquired = true;
    }
    if (!acquired) {
        log('info', 'Investigation already in progress; skipping duplicate', { canaryName: parsed.canaryName });
        return { skipped: true, reason: 'duplicate' };
    }

    // Invoke DevOps Agent webhook
    const webhookConfig = await readSecretJson(process.env.L1T_DEVOPS_WEBHOOK_SECRET_ARN);
    if (!webhookConfig.webhookUrl || String(webhookConfig.webhookUrl).includes('PLACEHOLDER')) {
        log('warn', 'DevOps Agent webhook URL is a placeholder; skipping real invocation (populate the secret to enable).', {
            canaryName: parsed.canaryName,
            agentInvocationId,
        });
        return { invoked: false, reason: 'placeholder-secret', agentInvocationId };
    }

    const payload = buildIncidentPayload(parsed, agentInvocationId);
    const result = await invokeWithRetry(webhookConfig, payload);

    if (!result.ok) {
        log('error', 'DevOps Agent invocation failed after retries; publishing invocation-failure alert', {
            canaryName: parsed.canaryName,
            lastError: result.lastError,
        });
        await publishInvocationFailure(process.env.L1T_INVOCATION_FAILURE_TOPIC_ARN, parsed.canaryName, result.lastError);
        return { invoked: false, reason: 'retries-exhausted', lastError: result.lastError };
    }

    return { invoked: true, agentInvocationId };
};

// Exported for unit testing.
exports.__test__ = {
    parseAlarmEvent,
    buildIncidentPayload,
    computeSignature,
    invokeWithRetry,
    acquireLock,
    postWebhook,
    publishInvocationFailure,
};
