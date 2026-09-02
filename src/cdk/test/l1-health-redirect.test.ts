/*
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: Apache-2.0
*/

/**
 * Behavioral tests for the L1 health canary's redirect-following logic
 * (Task 1 of the redirect fix).
 *
 * These run the real `checkUrl` against a local HTTP server that issues
 * redirect chains, loops, and terminal statuses — the class of behavior that
 * a synthesized-template or isolated-props test cannot catch, and which is why
 * the original 2xx-only logic falsely failed a healthy CloudFront 302.
 *
 * AWS-aligned expectation: a bare 3xx is neither pass nor fail; the client
 * follows the redirect chain and the FINAL status decides:
 *   - 302 -> 200  => SUCCESS
 *   - 302 -> 500  => FAILED
 *   - redirect loop / exceeding MAX_REDIRECTS => FAILED
 *
 * @packageDocumentation
 */

import * as http from 'node:http';
import { AddressInfo } from 'node:net';

// The canary script lives outside the CDK package; require it directly. Its
// Synthetics-runtime requires are guarded, so it imports cleanly under jest.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const canary = require('../../applications/canaries/l1-health/nodejs/node_modules/index');
const { checkUrl, isRedirectStatus, MAX_REDIRECTS } = canary.__test__;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { STATUS } = require('../../applications/canaries/l1-health/nodejs/node_modules/log-entry');

/**
 * A tiny configurable HTTP server. Routes map a path to either a redirect
 * (`{ redirectTo }`) or a terminal status (`{ status, body }`).
 */
function startServer(
    routes: Record<string, { status: number; location?: string; body?: string }>,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            const route = routes[req.url || '/'] || { status: 404, body: 'not found' };
            const headers: Record<string, string> = {};
            if (route.location) {
                headers['location'] = route.location;
            }
            res.writeHead(route.status, headers);
            res.end(route.body ?? '');
        });
        server.listen(0, '127.0.0.1', () => {
            const port = (server.address() as AddressInfo).port;
            resolve({
                baseUrl: `http://127.0.0.1:${port}`,
                close: () => new Promise((r) => server.close(() => r())),
            });
        });
    });
}

describe('L1 canary isRedirectStatus', () => {
    test.each([301, 302, 303, 307, 308])('treats %i as a redirect', (code) => {
        expect(isRedirectStatus(code)).toBe(true);
    });
    test.each([200, 204, 400, 404, 500])('treats %i as non-redirect', (code) => {
        expect(isRedirectStatus(code)).toBe(false);
    });
});

describe('L1 canary checkUrl — redirect following (AWS-aligned)', () => {
    test('direct 200 is SUCCESS with no redirects', async () => {
        const srv = await startServer({ '/': { status: 200, body: 'ok' } });
        try {
            const entry = await checkUrl(`${srv.baseUrl}/`, {}, 5000);
            expect(entry.status).toBe(STATUS.SUCCESS);
            expect(entry.statusCode).toBe(200);
            expect(entry.redirectCount).toBe(0);
        } finally {
            await srv.close();
        }
    });

    test('302 -> 200 follows the redirect and is SUCCESS (the CloudFront case)', async () => {
        const srv = await startServer({
            '/': { status: 302, location: '/home' },
            '/home': { status: 200, body: 'home' },
        });
        try {
            const entry = await checkUrl(`${srv.baseUrl}/`, {}, 5000);
            expect(entry.status).toBe(STATUS.SUCCESS);
            expect(entry.statusCode).toBe(200);
            expect(entry.redirectCount).toBe(1);
            expect(entry.finalUrl).toContain('/home');
            expect(entry.redirectChain[0]).toMatchObject({ statusCode: 302, location: '/home' });
        } finally {
            await srv.close();
        }
    });

    test('302 -> 500 follows the redirect and is FAILED', async () => {
        const srv = await startServer({
            '/': { status: 302, location: '/broken' },
            '/broken': { status: 500, body: 'boom' },
        });
        try {
            const entry = await checkUrl(`${srv.baseUrl}/`, {}, 5000);
            expect(entry.status).toBe(STATUS.FAILED);
            expect(entry.statusCode).toBe(500);
            expect(entry.redirectCount).toBe(1);
        } finally {
            await srv.close();
        }
    });

    test('multi-hop 302 -> 302 -> 200 is SUCCESS', async () => {
        const srv = await startServer({
            '/': { status: 302, location: '/a' },
            '/a': { status: 302, location: '/b' },
            '/b': { status: 200, body: 'done' },
        });
        try {
            const entry = await checkUrl(`${srv.baseUrl}/`, {}, 5000);
            expect(entry.status).toBe(STATUS.SUCCESS);
            expect(entry.redirectCount).toBe(2);
        } finally {
            await srv.close();
        }
    });

    test('redirect loop is FAILED (not infinite)', async () => {
        const srv = await startServer({
            '/loop': { status: 302, location: '/loop' },
        });
        try {
            const entry = await checkUrl(`${srv.baseUrl}/loop`, {}, 5000);
            expect(entry.status).toBe(STATUS.FAILED);
            expect(String(entry.responseBody)).toMatch(/loop|Exceeded/i);
        } finally {
            await srv.close();
        }
    });

    test('exceeding MAX_REDIRECTS is FAILED', async () => {
        // Build a chain longer than MAX_REDIRECTS that never terminates in 2xx.
        const routes: Record<string, { status: number; location?: string; body?: string }> = {};
        const hops = MAX_REDIRECTS + 2;
        for (let i = 0; i < hops; i++) {
            routes[`/r${i}`] = { status: 302, location: `/r${i + 1}` };
        }
        const srv = await startServer(routes);
        try {
            const entry = await checkUrl(`${srv.baseUrl}/r0`, {}, 5000);
            expect(entry.status).toBe(STATUS.FAILED);
            expect(String(entry.responseBody)).toMatch(/Exceeded/i);
        } finally {
            await srv.close();
        }
    });

    test('non-2xx terminal (404) is FAILED', async () => {
        const srv = await startServer({ '/missing': { status: 404, body: 'nope' } });
        try {
            const entry = await checkUrl(`${srv.baseUrl}/missing`, {}, 5000);
            expect(entry.status).toBe(STATUS.FAILED);
            expect(entry.statusCode).toBe(404);
        } finally {
            await srv.close();
        }
    });
});
