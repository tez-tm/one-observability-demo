/*
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: Apache-2.0
*/

/**
 * Unit tests for the L1 UX (browser) canary's pure decision logic (Slice 2
 * detection fix).
 *
 * These tests exercise `evaluatePageResult` and `attachFailureListeners`
 * directly, without Puppeteer or the Synthetics runtime, matching the real
 * incident this canary is designed to catch: PetSite's adoption-list page
 * returns HTTP 200 with a server-rendered error banner in place of the real
 * content when its backend dependency is down. No HTTP-status check can see
 * this — only a positive content assertion can.
 *
 * @packageDocumentation
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const handler = require('../../applications/canaries/l1-ux/nodejs/node_modules/index');
const { evaluatePageResult, attachFailureListeners, JOURNEY_PAGES } = handler.__test__;

function page(overrides: Partial<{ name: string; url: string; contentSelector: string; errorSelector: string }> = {}) {
    return {
        name: 'adoption-list',
        url: 'https://example.cloudfront.net/PetListAdoptions?userId=u1',
        contentSelector: '.pet-item',
        errorSelector: '.alert-danger',
        ...overrides,
    };
}

function signals(
    overrides: Partial<{
        contentPresent: boolean;
        dangerPresent: boolean;
        failedResponses: Array<{ url: string; status: number }>;
        pageErrors: string[];
    }> = {},
) {
    return {
        contentPresent: true,
        dangerPresent: false,
        failedResponses: [],
        pageErrors: [],
        ...overrides,
    };
}

describe('evaluatePageResult — real incident: 200 OK page rendering a server-side error', () => {
    test('passes when real content is present and no error signals are observed', () => {
        const result = evaluatePageResult(page(), signals());
        expect(result.ok).toBe(true);
        expect(result.reason).toBeNull();
    });

    test('FAILS when expected content is missing, even though the page returned 200 (the reproduced incident)', () => {
        // This is exactly what happened live: PetListAdoptions returned HTTP 200
        // with an "Oops! Something went wrong... 503" banner instead of pet
        // cards. No network-response or top-level status check would catch
        // this — only the missing `.pet-item` content does.
        const result = evaluatePageResult(page(), signals({ contentPresent: false }));
        expect(result.ok).toBe(false);
        expect(result.reason).toContain('did not render its expected content');
        expect(result.reason).toContain('.pet-item');
    });

    test('FAILS when a generic error indicator is present, even if content happens to also match', () => {
        // Guards pages like housekeeping whose healthy selector is
        // `.alert-success, .alert-danger` — content-present alone is not
        // enough if the danger variant specifically is what rendered.
        const result = evaluatePageResult(page({ name: 'housekeeping', contentSelector: '.alert-success, .alert-danger' }), signals({ dangerPresent: true }));
        expect(result.ok).toBe(false);
        expect(result.reason).toContain('generic error indicator');
    });

    test('FAILS on a failed network response (>=400) even when content and no danger banner are present', () => {
        const result = evaluatePageResult(
            page(),
            signals({ failedResponses: [{ url: 'https://example.cloudfront.net/api/pets', status: 503 }] }),
        );
        expect(result.ok).toBe(false);
        expect(result.reason).toContain('503');
        expect(result.reason).toContain('/api/pets');
    });

    test('FAILS on an uncaught page-level JS error', () => {
        const result = evaluatePageResult(page(), signals({ pageErrors: ['TypeError: cannot read properties of undefined'] }));
        expect(result.ok).toBe(false);
        expect(result.reason).toContain('uncaught error');
        expect(result.reason).toContain('TypeError');
    });

    test('does not depend on any specific error text — a completely different message still fails via content/danger/network signals', () => {
        // The whole point of the redesign: no string-matching on app-specific
        // error copy. Verify a page with unrelated made-up error text/markup
        // still fails purely through the generic signals.
        const madeUpFailureSignals = signals({ contentPresent: false });
        const result = evaluatePageResult(page({ url: 'https://example.cloudfront.net/PetListAdoptions' }), madeUpFailureSignals);
        expect(result.ok).toBe(false);
        // No assertion on any literal error string — only on the generic reason shape.
        expect(typeof result.reason).toBe('string');
    });

    test('evaluation order: missing content is reported before a co-occurring failed network response', () => {
        const result = evaluatePageResult(
            page(),
            signals({ contentPresent: false, failedResponses: [{ url: 'https://x/api', status: 500 }] }),
        );
        expect(result.reason).toContain('did not render its expected content');
    });
});

describe('attachFailureListeners', () => {
    /** Minimal fake Puppeteer Page: just enough of the EventEmitter surface. */
    function fakePage() {
        const handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
        return {
            on(event: string, fn: (...args: unknown[]) => void) {
                handlers[event] = handlers[event] || [];
                handlers[event].push(fn);
            },
            off(event: string, fn: (...args: unknown[]) => void) {
                handlers[event] = (handlers[event] || []).filter((h) => h !== fn);
            },
            emit(event: string, ...args: unknown[]) {
                (handlers[event] || []).forEach((h) => h(...args));
            },
        };
    }

    test('records responses with status >= 400 and ignores 2xx/3xx responses', () => {
        const p = fakePage();
        const listeners = attachFailureListeners(p as any);

        p.emit('response', { status: () => 200, url: () => 'https://x/ok' });
        p.emit('response', { status: () => 302, url: () => 'https://x/redirect' });
        p.emit('response', { status: () => 503, url: () => 'https://x/api/pets' });
        p.emit('response', { status: () => 404, url: () => 'https://x/missing' });

        expect(listeners.failedResponses).toEqual([
            { url: 'https://x/api/pets', status: 503 },
            { url: 'https://x/missing', status: 404 },
        ]);
    });

    test('records uncaught page errors', () => {
        const p = fakePage();
        const listeners = attachFailureListeners(p as any);

        p.emit('pageerror', new Error('boom'));

        expect(listeners.pageErrors).toEqual(['boom']);
    });

    test('detach stops further events from being recorded', () => {
        const p = fakePage();
        const listeners = attachFailureListeners(p as any);
        listeners.detach();

        p.emit('response', { status: () => 500, url: () => 'https://x/late' });
        p.emit('pageerror', new Error('late error'));

        expect(listeners.failedResponses).toEqual([]);
        expect(listeners.pageErrors).toEqual([]);
    });
});

describe('JOURNEY_PAGES', () => {
    test('covers the four PetSite nav pages with the selectors observed on the live site', () => {
        const names = JOURNEY_PAGES.map((p: { name: string }) => p.name);
        expect(names).toEqual(['adoption-list', 'buy-food', 'waggle-ai', 'housekeeping']);

        const byName = Object.fromEntries(JOURNEY_PAGES.map((p: { name: string; path: string; contentSelector: string }) => [p.name, p]));
        expect(byName['adoption-list'].path).toBe('/PetListAdoptions');
        expect(byName['adoption-list'].contentSelector).toBe('.pet-item');
        expect(byName['buy-food'].path).toBe('/FoodService');
        expect(byName['waggle-ai'].contentSelector).toBe('#chat-messages');
        expect(byName['housekeeping'].contentSelector).toBe('.alert-success, .alert-danger');
    });
});
