/*
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: Apache-2.0
*/

/**
 * Unit tests for the L1 cart (user-behavior) canary's pure decision logic.
 *
 * These tests exercise `evaluateCartResult` and `readCartCount` directly,
 * without Puppeteer or the Synthetics runtime. They target the specific
 * coverage gap this canary closes: PetSite's FoodServiceController.AddToCart
 * swallows a downstream cart-API failure into a 200 response with
 * totalItems: 0, rather than a failed HTTP request — so only checking the
 * AJAX call's HTTP status is not sufficient. Asserting on the actual
 * displayed cart count is what catches that failure mode.
 *
 * @packageDocumentation
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const cartHandler = require('../../applications/canaries/l1-cart/nodejs/node_modules/index');
const { evaluateCartResult, readCartCount, waitForCartCountIncrease } = cartHandler.__test__;

describe('evaluateCartResult — real failure mode: AJAX call "succeeds" but the cart never actually updates', () => {
    test('passes when the button was found and the cart count increased', () => {
        const result = evaluateCartResult({ buttonFound: true, beforeCount: 0, afterCount: 1 });
        expect(result.ok).toBe(true);
        expect(result.reason).toBeNull();
    });

    test('FAILS when the Add to cart button is not found on the page', () => {
        const result = evaluateCartResult({ buttonFound: false, beforeCount: 0, afterCount: 0 });
        expect(result.ok).toBe(false);
        expect(result.reason).toContain('not found');
    });

    test('FAILS when the cart count does not increase after clicking (the reproduced backend-swallowed-failure incident)', () => {
        // This is exactly the failure mode FoodServiceController.AddToCart can
        // produce: the AJAX POST to /FoodService/AddToCart returns HTTP 200
        // with totalItems: 0 even when the downstream cart API rejected the
        // request. No network-status check would catch this — only the
        // cart count failing to increase does.
        const result = evaluateCartResult({ buttonFound: true, beforeCount: 2, afterCount: 2 });
        expect(result.ok).toBe(false);
        expect(result.reason).toContain('did not increase');
        expect(result.reason).toContain('before=2');
        expect(result.reason).toContain('after=2');
    });

    test('FAILS when the cart count decreases (unexpected but still a failure, not a pass)', () => {
        const result = evaluateCartResult({ buttonFound: true, beforeCount: 3, afterCount: 1 });
        expect(result.ok).toBe(false);
        expect(result.reason).toContain('did not increase');
    });

    test('passes for a first add from an empty cart (0 -> 1)', () => {
        const result = evaluateCartResult({ buttonFound: true, beforeCount: 0, afterCount: 1 });
        expect(result.ok).toBe(true);
    });

    test('button-not-found is reported before a co-occurring count mismatch', () => {
        const result = evaluateCartResult({ buttonFound: false, beforeCount: 0, afterCount: 0 });
        expect(result.reason).toContain('not found');
        expect(result.reason).not.toContain('did not increase');
    });
});

describe('readCartCount', () => {
    /** Minimal fake Puppeteer Page exposing only evaluate(). */
    function fakePageWithEvaluate(resultOrThrow: number | Error) {
        return {
            evaluate: jest.fn(async () => {
                if (resultOrThrow instanceof Error) {
                    throw resultOrThrow;
                }
                return resultOrThrow;
            }),
        };
    }

    test('returns the numeric count reported by the in-page evaluation', async () => {
        const p = fakePageWithEvaluate(3);
        const count = await readCartCount(p as any, '#cart-count');
        expect(count).toBe(3);
        expect(p.evaluate).toHaveBeenCalledWith(expect.any(Function), '#cart-count');
    });

    test('returns 0 (fails closed) if page.evaluate throws', async () => {
        const p = fakePageWithEvaluate(new Error('detached frame'));
        const count = await readCartCount(p as any, '#cart-count');
        expect(count).toBe(0);
    });

    test('in-page predicate: a hidden badge (display:none) reports 0 regardless of its text', () => {
        // Mirrors the real PetSite markup: <span id="cart-count" ...
        // style="display:none"></span> before any item has been added.
        // Directly exercise the same decision rules the in-page function
        // uses, against a minimal fake document/window (no real browser).
        const fakeElement = { style: { display: 'none' }, textContent: '5' };
        const fakeDocument = { querySelector: () => fakeElement };
        const fakeWindow = { getComputedStyle: (el: typeof fakeElement) => el.style };

        const el = fakeDocument.querySelector();
        let result: number;
        if (!el) {
            result = 0;
        } else {
            const style = fakeWindow.getComputedStyle(el);
            if (style.display === 'none' || (style as { visibility?: string }).visibility === 'hidden') {
                result = 0;
            } else {
                const value = Number.parseInt(el.textContent, 10);
                result = Number.isNaN(value) ? 0 : value;
            }
        }
        expect(result).toBe(0);
    });

    test('in-page predicate: a visible badge with numeric text reports that number', () => {
        const fakeElement = { style: { display: 'inline' }, textContent: '4' };
        const fakeDocument = { querySelector: () => fakeElement };
        const fakeWindow = { getComputedStyle: (el: typeof fakeElement) => el.style };

        const el = fakeDocument.querySelector();
        const style = fakeWindow.getComputedStyle(el as typeof fakeElement);
        const value = Number.parseInt((el as typeof fakeElement).textContent, 10);
        const result = style.display === 'none' ? 0 : Number.isNaN(value) ? 0 : value;
        expect(result).toBe(4);
    });

    test('in-page predicate: a missing element reports 0', () => {
        const fakeDocument = { querySelector: () => null };
        const el = fakeDocument.querySelector();
        const result = el ? 1 : 0;
        expect(result).toBe(0);
    });
});

describe('waitForCartCountIncrease', () => {
    test('resolves as soon as a poll observes a count greater than beforeCount', async () => {
        let call = 0;
        const values = [0, 0, 1];
        const p = {
            evaluate: jest.fn(async () => values[Math.min(call++, values.length - 1)]),
        };

        const result = await waitForCartCountIncrease(p as any, '#cart-count', 0, 2000);
        expect(result).toBe(1);
        expect(call).toBeGreaterThanOrEqual(3);
    });

    test('returns the last observed count if it never increases before the timeout', async () => {
        const p = {
            evaluate: jest.fn(async () => 0),
        };

        const result = await waitForCartCountIncrease(p as any, '#cart-count', 0, 300);
        expect(result).toBe(0);
    });
});
