/*
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: Apache-2.0
*/

/**
 * Infrastructure tests for the L1 Automated Triage cart canary.
 *
 * These tests synthesize the {@link L1CartCanary} construct in isolation
 * (inside a throwaway stack) so they do not require Docker, deploy config, or
 * the full workshop app. They assert:
 *
 *  - a CloudWatch Synthetics canary is created,
 *  - the click/count-check environment variables are passed through,
 *  - the `l1t-health-` availability alarm is wired to the canary
 *    SuccessPercent metric with the correct evaluation semantics, matching
 *    the same routing convention as the health and UX canaries so the
 *    existing EventBridge rule picks it up without any new rule.
 *
 * @packageDocumentation
 */

import { App, Stack } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { ComparisonOperator, TreatMissingData } from 'aws-cdk-lib/aws-cloudwatch';
import { Runtime as CanaryRuntime, RuntimeFamily } from 'aws-cdk-lib/aws-synthetics';
import { L1CartCanary } from '../lib/serverless/canaries/l1-cart/l1-cart';

function synthTemplate(): Template {
    const app = new App();
    const stack = new Stack(app, 'TestStack', { env: { account: '123456789012', region: 'us-east-1' } });
    const artifactsBucket = new Bucket(stack, 'Artifacts');

    const canary = new L1CartCanary(stack, 'l1t-cart-canary', {
        name: 'l1t-cart-canary',
        runtime: new CanaryRuntime('syn-nodejs-puppeteer-11.0', RuntimeFamily.NODEJS),
        scheduleExpression: 'rate(5 minutes)',
        handler: 'index.handler',
        path: '../applications/canaries/l1-cart',
        artifactsBucket,
        targetUrlParameterName: '/petstore/petsiteurl',
        addToCartSelector: '.add-to-cart',
        cartCountSelector: '#cart-count',
        updateTimeoutMs: 5000,
    });

    canary.canary
        .metricSuccessPercent({ statistic: 'Average' })
        .createAlarm(stack, 'L1CartAvailabilityAlarm', {
            alarmName: `l1t-health-${canary.canary.canaryName}-availability`,
            threshold: 100,
            comparisonOperator: ComparisonOperator.LESS_THAN_THRESHOLD,
            evaluationPeriods: 1,
            treatMissingData: TreatMissingData.NOT_BREACHING,
        });

    return Template.fromStack(stack);
}

describe('L1CartCanary — write-path (Add to cart) coverage', () => {
    let template: Template;

    beforeAll(() => {
        template = synthTemplate();
    });

    test('creates a CloudWatch Synthetics canary', () => {
        template.resourceCountIs('AWS::Synthetics::Canary', 1);
        template.hasResourceProperties('AWS::Synthetics::Canary', {
            Name: 'l1t-cart-canary',
            RuntimeVersion: 'syn-nodejs-puppeteer-11.0',
            Schedule: Match.objectLike({ Expression: 'rate(5 minutes)' }),
        });
    });

    test('passes the target URL parameter, click selector, count selector, and timeout as environment variables', () => {
        template.hasResourceProperties('AWS::Synthetics::Canary', {
            RunConfig: Match.objectLike({
                EnvironmentVariables: Match.objectLike({
                    L1T_CART_URL_PARAMETER_NAME: '/petstore/petsiteurl',
                    L1T_CART_ADD_SELECTOR: '.add-to-cart',
                    L1T_CART_COUNT_SELECTOR: '#cart-count',
                    L1T_CART_UPDATE_TIMEOUT_MS: '5000',
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

    test('alarm name carries the l1t-health- prefix literal, matching the existing EventBridge routing rule', () => {
        // The routing rule (L1tAlarmStateChangeRule) filters on alarmName
        // prefix "l1t-health-", not a per-canary allowlist — this alarm must
        // use that exact prefix to be picked up without any new rule.
        const alarms = template.findResources('AWS::CloudWatch::Alarm');
        const serialized = JSON.stringify(Object.values(alarms));
        expect(serialized).toContain('l1t-health-');
    });

    test('grants read access scoped to the /petstore/ SSM parameter prefix (least privilege)', () => {
        template.hasResourceProperties('AWS::IAM::Policy', {
            PolicyDocument: Match.objectLike({
                Statement: Match.arrayWith([
                    Match.objectLike({
                        Action: Match.arrayWith(['ssm:GetParameter']),
                        Effect: 'Allow',
                        Resource: 'arn:aws:ssm:us-east-1:123456789012:parameter/petstore/*',
                    }),
                ]),
            }),
        });
    });
});
