/*
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: Apache-2.0
*/

/**
 * Infrastructure tests for L1 triage Slice 2 (Routing): the dedup locks table,
 * the Webhook Lambda, and the EventBridge rule on the default bus.
 *
 * Synthesizes the constructs in isolation (no Docker / deploy config).
 *
 * @packageDocumentation
 */

import { App, Stack } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { DynamoDatabase } from '../lib/constructs/dynamodb';

describe('Slice 2 — dedup locks table', () => {
    test('DynamoDatabase creates the l1t investigation locks table with TTL on expiresAt', () => {
        const app = new App();
        const stack = new Stack(app, 'DdbTestStack', { env: { account: '123456789012', region: 'us-east-1' } });
        new DynamoDatabase(stack, 'Ddb');
        const template = Template.fromStack(stack);

        template.hasResourceProperties('AWS::DynamoDB::Table', {
            KeySchema: Match.arrayWith([{ AttributeName: 'canaryName', KeyType: 'HASH' }]),
            TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
        });
    });
});

// NOTE: The L1WebhookFunction extends the workshop NodejsFunction base, which
// bundles the handler with esbuild-in-Docker at synth time. Neither esbuild nor
// Docker is available in this local test environment, so a Template.fromStack
// synth of that construct cannot run here (same constraint as the full-app
// synth). The webhook is therefore validated two ways instead:
//   1. Its handler logic — alarm parsing, HMAC signing, retry/backoff, payload —
//      is covered by test/l1-webhook-handler.test.ts (pure, no bundling).
//   2. Its infrastructure (Lambda, default-bus EventBridge rule, IAM, env) is
//      validated at deploy time by the CodeBuild pipeline (Docker available)
//      and by the live end-to-end alarm→Lambda validation in Slice 2's checkpoint.
// tsc type-checking confirms the construct wiring compiles.
