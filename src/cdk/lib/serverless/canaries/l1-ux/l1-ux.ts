/**
 * L1 Automated Triage — Browser (UX) Canary construct (Slice 2 detection add).
 *
 * A Puppeteer Synthetics canary that loads the target page, measures page-load
 * timing, and verifies a configured key UI element. Complements the API health
 * canary by catching browser-only failures. Independently deployable and
 * separable from the routing path; its failure drives an `l1t-health-` alarm.
 *
 * @packageDocumentation
 */
import { Construct } from 'constructs';
import { WorkshopCanary, WorkshopCanaryProperties } from '../../../constructs/canary';

/** Properties for the L1 UX (browser) canary. */
export interface L1UxCanaryProperties extends WorkshopCanaryProperties {
    /** Inline page URL (takes precedence over the SSM parameter). */
    targetUrl?: string;
    /** SSM parameter name holding the page URL. */
    targetUrlParameterName?: string;
    /** CSS selector of a key UI element to verify (default: body). */
    keySelector?: string;
    /** Soft page-load budget in ms (logged; default 10000). */
    maxLoadMs?: number;
}

/** Browser-based canary for page-load/UI health. */
export class L1UxCanary extends WorkshopCanary {
    constructor(scope: Construct, id: string, properties: L1UxCanaryProperties) {
        super(scope, id, properties);
    }

    createOutputs(): void {}

    getEnvironmentVariables(properties: L1UxCanaryProperties): { [key: string]: string } | undefined {
        const env: { [key: string]: string } = {};
        if (properties.targetUrl) {
            env.L1T_UX_URL = properties.targetUrl;
        }
        if (properties.targetUrlParameterName) {
            env.L1T_UX_URL_PARAMETER_NAME = properties.targetUrlParameterName;
        }
        if (properties.keySelector) {
            env.L1T_UX_KEY_SELECTOR = properties.keySelector;
        }
        env.L1T_UX_MAX_LOAD_MS = String(properties.maxLoadMs ?? 10000);
        return env;
    }
}
