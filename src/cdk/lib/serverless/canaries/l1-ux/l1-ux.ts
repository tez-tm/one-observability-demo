/**
 * L1 Automated Triage — Browser (UX) Canary construct (Slice 2 detection add).
 *
 * A Puppeteer Synthetics canary that visits the home page plus the PetSite
 * nav journey (adoption list, buy food, Waggle AI, housekeeping). For each
 * page it watches network responses (>=400) and uncaught JS errors, and
 * asserts that the page's real content rendered (not just that the page
 * shell/structural chrome loaded) — catching failures that are rendered
 * server-side as a normal 200 page with an error message in place of real
 * content, which no HTTP-status check alone can detect. A secondary,
 * non-authoritative generic error-indicator check (Bootstrap's
 * `.alert-danger` convention) adds corroborating evidence without depending
 * on any application-specific error text. Independently deployable and
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
    /** CSS selector of a key UI element to verify on the home page (default: body). */
    keySelector?: string;
    /** Soft page-load budget in ms (logged; default 10000). */
    maxLoadMs?: number;
    /** userId query parameter appended to journey page URLs (default: user63606). */
    userId?: string;
    /** Secondary generic error-indicator CSS selector (default: .alert-danger). */
    errorSelector?: string;
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
        if (properties.userId) {
            env.L1T_UX_USER_ID = properties.userId;
        }
        if (properties.errorSelector) {
            env.L1T_UX_ERROR_SELECTOR = properties.errorSelector;
        }
        env.L1T_UX_MAX_LOAD_MS = String(properties.maxLoadMs ?? 10000);
        return env;
    }
}
