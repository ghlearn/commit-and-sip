import test from 'node:test';
import assert from 'node:assert/strict';
import { validateLeaderboardUrl, verifyPublicUrl } from '../.github/extensions/commit-and-sip/services/public-url.mjs';

const url = 'https://leaderboard.cafe.dev/runs';

test('strict HTTPS URLs reject local, private, reserved, credentialed and fragmented targets', () => {
    for (const value of [
        undefined, 'http://cafe.dev', 'https://localhost', 'https://x.localhost', 'https://x.local',
        'https://127.0.0.1', 'https://127.1', 'https://2130706433', 'https://0x7f000001',
        'https://10.0.0.1', 'https://172.16.0.1', 'https://192.168.1.1', 'https://169.254.169.254',
        'https://100.64.0.1', 'https://[::1]', 'https://[::ffff:127.0.0.1]', 'https://[fc00::1]',
        'https://[2001:db8::1]', 'https://user:password@cafe.dev', 'https://cafe.dev/#fragment',
        'https://cafe.dev:8443', 'https://cafe.dev\\@localhost', ' https://cafe.dev', 'https://x.internal',
        'https://cafe.dev.', 'https://192.0.2.1', 'https://198.51.100.1',
        'https://cafe.dev/#', 'https://@cafe.dev', 'https://cafe..dev', 'https://[2001::1]',
    ]) assert.throws(() => validateLeaderboardUrl(value), { name: 'PublicUrlError' }, String(value));
    assert.equal(validateLeaderboardUrl(url), url);
    assert.equal(validateLeaderboardUrl('https://8.8.8.8'), 'https://8.8.8.8/');
});

test('public URL verification performs an unauthenticated HEAD without redirects', async () => {
    const calls = [];
    const target = 'https://leaderboard.cafe.dev/live';
    const result = await verifyPublicUrl(target, {
        resolvePublic: async (value) => calls.push(['dns', value]),
        fetch: async (value, init) => { calls.push(['head', value, init]); return { ok: true }; },
    });
    assert.equal(result, target);
    assert.deepEqual(calls[0], ['dns', target]);
    assert.equal(calls[1][2].method, 'HEAD');
    assert.equal(calls[1][2].redirect, 'error');
    assert.equal(calls[1][2].headers, undefined);
    assert.ok(calls[1][2].signal instanceof AbortSignal);
});

test('public URL verification rejects private URLs, DNS failures, non-2xx, redirects and timeouts', async () => {
    let fetched = false;
    await assert.rejects(verifyPublicUrl('https://127.0.0.1', { fetch: async () => { fetched = true; } }), { code: 'public_url_validation' });
    await assert.rejects(verifyPublicUrl(url, {
        resolvePublic: async () => { throw new Error('Private address with SECRET'); },
        fetch: async () => { fetched = true; },
    }), (error) => error.code === 'public_url_unreachable' && !error.message.includes('SECRET'));
    assert.equal(fetched, false);
    for (const status of [301, 401, 404, 500]) {
        await assert.rejects(verifyPublicUrl(url, {
            resolvePublic: async () => {},
            fetch: async () => ({ ok: false, status }),
        }), { code: 'public_url_unreachable' });
    }
    await assert.rejects(verifyPublicUrl(url, {
        timeoutMs: 5, resolvePublic: async () => {},
        fetch: () => new Promise(() => {}),
    }), { code: 'public_url_unreachable' });
});
