/**
 * L1 Automated Triage — Webhook Lambda construct (Slice 2, Routing).
 *
 * Receives `l1t-health-` CloudWatch alarm state-change events (routed by an
 * EventBridge rule on the default bus), deduplicates via a DynamoDB locks
 * table, and invokes the AWS DevOps Agent (DevOps2025 Agent Space) by POSTing
 * an HMAC-signed webhook. Publishes an SNS notification on retry exhaustion
 * (invocation failure only — routine findings/RCA are delivered separately by
 * the DevOps Agent's own native Slack integration, configured out-of-band in
 * the AWS DevOps Agent console; see VALIDATION.md).
 *
 * Extends {@link WokshopLambdaFunction} to inherit DLQ, structured logging,
 * X-Ray tracing, and Application Signals instrumentation.
 *
 * @packageDocumentation
 */
import { Stack } from 'aws-cdk-lib';
import { Rule } from 'aws-cdk-lib/aws-events';
import { LambdaFunction } from 'aws-cdk-lib/aws-events-targets';
import { EventBus } from 'aws-cdk-lib/aws-events';
import { Effect, Policy, PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { ILayerVersion, LayerVersion } from 'aws-cdk-lib/aws-lambda';
import { ITable } from 'aws-cdk-lib/aws-dynamodb';
import { ISecret } from 'aws-cdk-lib/aws-secretsmanager';
import { ITopic } from 'aws-cdk-lib/aws-sns';
import { Queue } from 'aws-cdk-lib/aws-sqs';
import { BundlingOptions } from 'aws-cdk-lib/aws-lambda-nodejs';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';
import {
    WokshopLambdaFunction,
    WorkshopLambdaFunctionProperties,
    getOpenTelemetryNodeJSLayerArn,
    getLambdaInsightsLayerArn,
} from '../../../constructs/lambda';

/** Properties for the L1 triage Webhook Lambda. */
export interface L1WebhookFunctionProperties extends WorkshopLambdaFunctionProperties {
    /** DynamoDB dedup/locks table (PK canaryName, TTL expiresAt). */
    locksTable: ITable;
    /** Secret holding { webhookUrl, hmacSecret } for the DevOps2025 Agent Space webhook. */
    devopsWebhookSecret: ISecret;
    /** SNS topic notified when all DevOps Agent invocation retries are exhausted (invocation-failure alert, not a findings channel). */
    invocationFailureTopic: ITopic;
    /** Dedup window in seconds (default 900). */
    dedupTtlSeconds?: number;
}

/**
 * Webhook Lambda that routes L1 health-check alarms to the DevOps Agent.
 */
export class L1WebhookFunction extends WokshopLambdaFunction {
    constructor(scope: Construct, id: string, properties: L1WebhookFunctionProperties) {
        super(scope, id, properties);

        // EventBridge rule on the DEFAULT bus — CloudWatch delivers alarm
        // state-change events to the account default bus, not custom buses.
        const defaultBus = EventBus.fromEventBusName(this, 'DefaultEventBus', 'default');

        const routingDlq = new Queue(this, 'AlarmRoutingDLQ', {
            queueName: `${properties.name}-routing-dlq`,
            enforceSSL: true,
        });

        new Rule(this, 'L1tAlarmStateChangeRule', {
            eventBus: defaultBus,
            description: 'Routes L1 Automated Triage alarm ALARM-state changes to the webhook Lambda',
            eventPattern: {
                source: ['aws.cloudwatch'],
                detailType: ['CloudWatch Alarm State Change'],
                detail: {
                    alarmName: [{ prefix: 'l1t-health-' }],
                    state: { value: ['ALARM'] },
                },
            },
            targets: [new LambdaFunction(this.function, { deadLetterQueue: routingDlq })],
        });

        NagSuppressions.addResourceSuppressions(
            routingDlq,
            [{ id: 'AwsSolutions-SQS3', reason: 'This queue is itself a dead-letter queue for EventBridge target failures' }],
            true,
        );
    }

    addFunctionPermissions(properties: WorkshopLambdaFunctionProperties): void {
        const props = properties as L1WebhookFunctionProperties;
        const policy = new Policy(this, 'L1WebhookPolicy', {
            roles: [this.function.role!],
            statements: [
                // Dedup table: conditional put.
                new PolicyStatement({
                    effect: Effect.ALLOW,
                    actions: ['dynamodb:PutItem', 'dynamodb:GetItem'],
                    resources: [props.locksTable.tableArn],
                }),
                // Read the DevOps Agent webhook secret (scoped to ARN).
                new PolicyStatement({
                    effect: Effect.ALLOW,
                    actions: ['secretsmanager:GetSecretValue'],
                    resources: [props.devopsWebhookSecret.secretArn],
                }),
                // Publish invocation-failure alerts (scoped to the topic ARN).
                new PolicyStatement({
                    effect: Effect.ALLOW,
                    actions: ['sns:Publish'],
                    resources: [props.invocationFailureTopic.topicArn],
                }),
                new PolicyStatement({
                    effect: Effect.ALLOW,
                    actions: ['xray:PutTraceSegments', 'xray:PutTelemetryRecords'],
                    resources: ['*'],
                }),
            ],
        });

        NagSuppressions.addResourceSuppressions(
            policy,
            [
                {
                    id: 'AwsSolutions-IAM5',
                    reason: 'X-Ray requires wildcard; Secrets Manager ARNs carry a required trailing suffix wildcard',
                },
            ],
            true,
        );
    }

    createOutputs(): void {}

    getEnvironmentVariables(properties: WorkshopLambdaFunctionProperties): { [key: string]: string } | undefined {
        const props = properties as L1WebhookFunctionProperties;
        return {
            L1T_LOCKS_TABLE_NAME: props.locksTable.tableName,
            L1T_DEVOPS_WEBHOOK_SECRET_ARN: props.devopsWebhookSecret.secretArn,
            L1T_INVOCATION_FAILURE_TOPIC_ARN: props.invocationFailureTopic.topicArn,
            L1T_DEDUP_TTL_SECONDS: String(props.dedupTtlSeconds ?? 900),
            AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1',
            OTEL_AWS_APPLICATION_SIGNALS_ENABLED: 'true',
            OTEL_SERVICE_NAME: properties.name,
        };
    }

    getLayers(_properties: WorkshopLambdaFunctionProperties): ILayerVersion[] {
        return [
            LayerVersion.fromLayerVersionArn(this, 'LambdaInsightsLayer', getLambdaInsightsLayerArn(Stack.of(this).region)),
            LayerVersion.fromLayerVersionArn(
                this,
                'OpenTelemetryLayer',
                getOpenTelemetryNodeJSLayerArn(Stack.of(this).region),
            ),
        ];
    }

    getBundling(_properties: WorkshopLambdaFunctionProperties): BundlingOptions {
        return {
            externalModules: [],
            nodeModules: [
                '@aws-sdk/client-dynamodb',
                '@aws-sdk/lib-dynamodb',
                '@aws-sdk/client-secrets-manager',
                '@aws-sdk/client-sns',
            ],
        };
    }
}
