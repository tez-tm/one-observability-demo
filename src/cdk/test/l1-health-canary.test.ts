/*
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: Apache-2.0
*/

/**
 * Infrastructure tests for the L1 Automated Triage health canary (Slice 1).
 *
 * These tests synthesize the {@link L1HealthCanary} construct in isolation
 * (inside a throwaway stack) so they do not require Docker, deploy config, or
 * the full workshop app. They assert:
 *
 *  - a CloudWatch Synthetics canary is created,
 *  - the `l1t-health-` availability alarm is wired to the canary
 *    SuccessPercent metric with the correct evaluation semantics, and
 *  - the credentials-secret grant is least-privilege (scoped to the ARN,
 *    no unscoped wildcards).
 *
 * @packageDocumentation
 */

import { App, Stack } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { ComparisonOperator, TreatMissingData } from 'aws-cdk-lib/aws-cloudwatch';
import { Runtime as CanaryRuntime, RuntimeFamily } from 'aws-cdk-lib/aws-synthetics';
import { L1HealthCanary } from '../lib/serverless/canaries/l1-health/l1-health';

function synthTemplate(): Template {
    const app = new App();
    const stack = new Stack(app, 'TestStack', { env: { account: '123456789012', region: 'us-east-1' } });
    const artifactsBucket = new Bucket(stack, 'Artifacts');

    const canary = new L1HealthCanary(stack, 'l1t-health-canary', {
        name: 'l1t-health-canary',
        runtime: new CanaryRuntime('syn-nodejs-puppeteer-11.0', RuntimeFamily.NODEJS),
        scheduleExpression: 'rate(5 minutes)',
        handler: 'index.handler',
        path: '../applications/canaries/l1-health',
        artifactsBucket,
        targetUrlsParameterName: '/petstore/petsiteurl',
        credentialsSecretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:l1t-canary-creds-AbCdEf',
        requestTimeoutMs: 30000,
    });

    canary.canary
        .metricSuccessPercent({ statistic: 'Average' })
        .createAlarm(stack, 'L1HealthAvailabilityAlarm', {
            alarmName: `l1t-health-${canary.canary.canaryName}-availability`,
            threshold: 100,
            comparisonOperator: ComparisonOperator.LESS_THAN_THRESHOLD,
            evaluationPeriods: 1,
            treatMissingData: TreatMissingData.NOT_BREACHING,
        });

    return Template.fromStack(stack);
}

describe('L1HealthCanary (Slice 1 — Detection)', () => {
    let template: Template;

    beforeAll(() => {
        template = synthTemplate();
    });

    test('creates a CloudWatch Synthetics canary', () => {
        template.resourceCountIs('AWS::Synthetics::Canary', 1);
        template.hasResourceProperties('AWS::Synthetics::Canary', {
            Name: 'l1t-health-canary',
            RuntimeVersion: 'syn-nodejs-puppeteer-11.0',
            Schedule: Match.objectLike({ Expression: 'rate(5 minutes)' }),
        });
    });

    test('passes target URLs, credentials ARN, and timeout as environment variables', () => {
        template.hasResourceProperties('AWS::Synthetics::Canary', {
            RunConfig: Match.objectLike({
                EnvironmentVariables: Match.objectLike({
                    L1T_TARGET_URLS_PARAMETER_NAME: '/petstore/petsiteurl',
                    L1T_CREDENTIALS_SECRET_ARN:
                        'arn:aws:secretsmanager:us-east-1:123456789012:secret:l1t-canary-creds-AbCdEf',
                    L1T_REQUEST_TIMEOUT_MS: '30000',
                }),
            }),
        });
    });

    test('creates the availability alarm on SuccessPercent, single evaluation period', () => {
        // AlarmName synthesizes as an Fn::Join (canary name is a token in the
        // isolated test stack), so match the metric/threshold semantics rather
        // than the literal name string.
        template.hasResourceProperties('AWS::CloudWatch::Alarm', {
            MetricName: 'SuccessPercent',
            Namespace: 'CloudWatchSynthetics',
            ComparisonOperator: 'LessThanThreshold',
            Threshold: 100,
            EvaluationPeriods: 1,
            TreatMissingData: 'notBreaching',
        });
    });

    test('alarm name carries the l1t-health- prefix literal', () => {
        const alarms = template.findResources('AWS::CloudWatch::Alarm');
        const serialized = JSON.stringify(Object.values(alarms));
        expect(serialized).toContain('l1t-health-');
    });

    test('grants read on exactly the credentials secret ARN (no unscoped wildcard)', () => {
        template.hasResourceProperties('AWS::IAM::Policy', {
            PolicyDocument: Match.objectLike({
                Statement: Match.arrayWith([
                    Match.objectLike({
                        Action: 'secretsmanager:GetSecretValue',
                        Effect: 'Allow',
                        Resource: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:l1t-canary-creds-AbCdEf',
                    }),
                ]),
            }),
        });
    });

    test('does not grant secretsmanager:GetSecretValue on a bare wildcard resource', () => {
        const policies = template.findResources('AWS::IAM::Policy');
        for (const key of Object.keys(policies)) {
            const statements = policies[key].Properties?.PolicyDocument?.Statement ?? [];
            for (const statement of statements) {
                const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
                if (actions.includes('secretsmanager:GetSecretValue')) {
                    expect(statement.Resource).not.toEqual('*');
                }
            }
        }
    });
});
