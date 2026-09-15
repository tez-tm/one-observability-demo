/**
 * L1 Automated Triage — Cart (user-behavior) Canary construct.
 *
 * A Puppeteer Synthetics canary that exercises the actual "Add to cart"
 * write path on the Buy Food page: it clicks the Add to cart button and
 * verifies the cart count badge actually updates, rather than only
 * asserting that the catalog page rendered. This closes a coverage gap
 * left by the read-only page-load checks in L1UxCanary and L1HealthCanary,
 * neither of which exercises this write path — a bug in the downstream
 * cart API (e.g. CartService::add_item) could silently break "Add to
 * cart" for real users while both of those checks continue to pass.
 * Independently deployable and separable from the routing path; its
 * failure drives an `l1t-health-` alarm, same as the other canaries.
 *
 * @packageDocumentation
 */
import { Construct } from 'constructs';
import { WorkshopCanary, WorkshopCanaryProperties } from '../../../constructs/canary';

/** Properties for the L1 cart (user-behavior) canary. */
export interface L1CartCanaryProperties extends WorkshopCanaryProperties {
    /** Inline page URL (takes precedence over the SSM parameter). */
    targetUrl?: string;
    /** SSM parameter name holding the page URL. */
    targetUrlParameterName?: string;
    /** CSS selector of the "Add to cart" button (default: .add-to-cart). */
    addToCartSelector?: string;
    /** CSS selector of the cart count badge to assert on (default: #cart-count). */
    cartCountSelector?: string;
    /** userId query parameter appended to the page URL (default: user63606). */
    userId?: string;
    /** Max time to wait for the cart count to update after clicking, in ms (default: 5000). */
    updateTimeoutMs?: number;
}

/** Browser-based canary that validates the "Add to cart" write path end to end. */
export class L1CartCanary extends WorkshopCanary {
    constructor(scope: Construct, id: string, properties: L1CartCanaryProperties) {
        super(scope, id, properties);
    }

    createOutputs(): void {}

    getEnvironmentVariables(properties: L1CartCanaryProperties): { [key: string]: string } | undefined {
        const env: { [key: string]: string } = {};
        if (properties.targetUrl) {
            env.L1T_CART_URL = properties.targetUrl;
        }
        if (properties.targetUrlParameterName) {
            env.L1T_CART_URL_PARAMETER_NAME = properties.targetUrlParameterName;
        }
        if (properties.addToCartSelector) {
            env.L1T_CART_ADD_SELECTOR = properties.addToCartSelector;
        }
        if (properties.cartCountSelector) {
            env.L1T_CART_COUNT_SELECTOR = properties.cartCountSelector;
        }
        if (properties.userId) {
            env.L1T_CART_USER_ID = properties.userId;
        }
        env.L1T_CART_UPDATE_TIMEOUT_MS = String(properties.updateTimeoutMs ?? 5000);
        return env;
    }
}
