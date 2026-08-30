/*
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: Apache-2.0
*/

/**
 * Unit tests for the shared structured log-entry parser/formatter used by the
 * L1 Automated Triage health canary (Tasks 1.2, 1.3).
 *
 * Covers Property 3 (structured log completeness): for any entry, the parser
 * extracts the available fields and reports which are missing, tolerating
 * absent fields rather than throwing. Also covers 2xx/non-2xx/timeout
 * classification (Requirements 1.4, 1.5, 1.6, 1.7, 3.5).
 *
 * The module under test is pure JS (no AWS SDK, no Synthetics runtime), so it
 * is required directly.
 *
 * @packageDocumentation
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const logEntry = require('../../applications/canaries/l1-health/nodejs/node_modules/log-entry');

const { STATUS, classifyStatusCode, truncateBody, formatLogEntry, extractFields, isHealthCheckEntry } = logEntry;

describe('log-entry classifyStatusCode', () => {
    test.each([200, 201, 204, 299])('classifies %i as SUCCESS', (code) => {
        expect(classifyStatusCode(code)).toBe(STATUS.SUCCESS);
    });

    test.each([100, 300, 301, 400, 404, 500, 503])('classifies %i as FAILED', (code) => {
        expect(classifyStatusCode(code)).toBe(STATUS.FAILED);
    });

    test('classifies a non-number as FAILED', () => {
        expect(classifyStatusCode(undefined)).toBe(STATUS.FAILED);
    });
});

describe('log-entry truncateBody', () => {
    test('returns null for missing body', () => {
        expect(truncateBody(undefined)).toBeNull();
        expect(truncateBody(null)).toBeNull();
    });

    test('truncates to 2048 characters', () => {
        const long = 'x'.repeat(5000);
        expect(truncateBody(long)).toHaveLength(2048);
    });

    test('leaves short bodies intact', () => {
        expect(truncateBody('ok')).toBe('ok');
    });
});

describe('log-entry formatLogEntry', () => {
    test('derives SUCCESS from a 2xx status code', () => {
        const entry = formatLogEntry({ url: 'https://a/health', statusCode: 200, responseBody: 'ok', latencyMs: 12 });
        expect(entry).toMatchObject({
            l1tHealthCheck: true,
            url: 'https://a/health',
            status: STATUS.SUCCESS,
            statusCode: 200,
            responseBody: 'ok',
            latencyMs: 12,
        });
        expect(typeof entry.timestamp).toBe('string');
    });

    test('derives FAILED from a non-2xx status code', () => {
        const entry = formatLogEntry({ url: 'https://a/health', statusCode: 503, responseBody: 'down' });
        expect(entry.status).toBe(STATUS.FAILED);
        expect(entry.statusCode).toBe(503);
    });

    test('defaults to TIMEOUT when no status and no status code', () => {
        const entry = formatLogEntry({ url: 'https://a/health' });
        expect(entry.status).toBe(STATUS.TIMEOUT);
        expect(entry.statusCode).toBeNull();
        expect(entry.responseBody).toBeNull();
    });

    test('honors an explicit CREDENTIAL_FAILURE status', () => {
        const entry = formatLogEntry({ url: 'N/A', status: STATUS.CREDENTIAL_FAILURE, responseBody: 'boom' });
        expect(entry.status).toBe(STATUS.CREDENTIAL_FAILURE);
    });

    test('emits null url when url missing', () => {
        const entry = formatLogEntry({ statusCode: 200 });
        expect(entry.url).toBeNull();
    });
});

describe('log-entry isHealthCheckEntry', () => {
    test('recognizes formatted entries', () => {
        expect(isHealthCheckEntry(formatLogEntry({ url: 'https://a', statusCode: 200 }))).toBe(true);
    });
    test('rejects non-entries', () => {
        expect(isHealthCheckEntry(null)).toBe(false);
        expect(isHealthCheckEntry({})).toBe(false);
        expect(isHealthCheckEntry('nope')).toBe(false);
    });
});

describe('log-entry extractFields — Property 3: structured log completeness', () => {
    test('extracts all fields from a complete success entry', () => {
        const entry = formatLogEntry({ url: 'https://a/health', statusCode: 200, responseBody: 'ok', latencyMs: 5 });
        const result = extractFields(entry);
        expect(result).toMatchObject({
            url: 'https://a/health',
            statusCode: 200,
            responseBody: 'ok',
            status: STATUS.SUCCESS,
            timedOut: false,
            missingFields: [],
        });
    });

    test('parses a JSON string entry', () => {
        const json = JSON.stringify(formatLogEntry({ url: 'https://a', statusCode: 404, responseBody: 'nf' }));
        const result = extractFields(json);
        expect(result.url).toBe('https://a');
        expect(result.statusCode).toBe(404);
    });

    test('does not flag statusCode/responseBody missing for a legitimate timeout', () => {
        const entry = formatLogEntry({ url: 'https://a', status: STATUS.TIMEOUT });
        const result = extractFields(entry);
        expect(result.timedOut).toBe(true);
        expect(result.missingFields).not.toContain('statusCode');
        expect(result.missingFields).not.toContain('responseBody');
    });

    test('reports missing fields without throwing (random omissions)', () => {
        // Property-style: iterate combinations of present/absent fields and
        // assert graceful extraction (no throw) and correct missing reporting.
        const fieldKeys = ['url', 'statusCode', 'responseBody', 'status'] as const;
        for (let mask = 0; mask < 1 << fieldKeys.length; mask++) {
            const input: Record<string, unknown> = {};
            if (mask & 1) input.url = 'https://a/health';
            if (mask & 2) input.statusCode = 200;
            if (mask & 4) input.responseBody = 'ok';
            if (mask & 8) input.status = STATUS.SUCCESS;

            let result: ReturnType<typeof extractFields>;
            expect(() => {
                result = extractFields(input);
            }).not.toThrow();
            result = extractFields(input);

            if (!(mask & 1)) expect(result.missingFields).toContain('url');
            // status present controls timeout detection; when absent it's not a timeout
            if (!(mask & 8)) expect(result.missingFields).toContain('status');
        }
    });

    test('handles unparseable JSON string gracefully', () => {
        const result = extractFields('{not json');
        expect(result.url).toBeNull();
        expect(result.missingFields).toEqual(expect.arrayContaining(['url', 'statusCode', 'responseBody', 'status']));
    });
});
