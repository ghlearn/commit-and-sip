import test from 'node:test';
import assert from 'node:assert/strict';
import { CompletionClient, CompletionError, completionComment, prepareCompletionComment, validateLeaderboardUrl, verifyPublicUrl } from '../.github/extensions/commit-and-sip/services/completion.mjs';

const url = 'https://leaderboard.cafe.dev/runs';
const receipt = () => ({ runId: 'run-1', handle: 'brisk-brews-coffee', score: 1000, rank: 3, rankAtCompletion: 2, recordedAt: '2026-09-14T14:00:00.000Z', commentId: 42 });
const submission = { runId: 'run-1', handle: 'brisk-brews-coffee', score: 999999, rank: 1 };
const options = (changes = {}) => ({ url, submit: async () => receipt(), fetch: async () => ({ ok: true }), resolvePublic: async () => {}, ...changes });

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
    ]) assert.throws(() => validateLeaderboardUrl(value), { name: 'CompletionError' }, String(value));
    assert.equal(validateLeaderboardUrl(url), url);
    assert.equal(validateLeaderboardUrl('https://8.8.8.8'), 'https://8.8.8.8/');
});

test('trusted transport receives run reference and persisted handle only, never renderer score', async () => {
    let sent;
    const client = new CompletionClient(options({ submit: async (body, metadata) => { sent = { body, metadata }; return receipt(); } }));
    const result = await client.submitResult(submission);
    assert.deepEqual(sent.body, { runId: 'run-1', handle: 'brisk-brews-coffee' });
    assert.equal(sent.metadata.url, url);
    assert.equal(result.score, 1000);
    assert.equal(result.rank, 3);
    assert.equal(result.rankAtCompletion, 2);
    assert.equal(result.commentId, 42);
    assert.equal(result.judge, null);
    assert.equal(result.qrImageUrl, null);
});

test('rejects forged or malformed server receipts and unmoderated commentary', async () => {
    for (const change of [
        { runId: 'other' }, { handle: 'attacker' }, { score: 999999 }, { rank: 0 },
        { commentId: undefined }, { commentId: null }, { commentId: 0 }, { commentId: -1 }, { commentId: 1.5 }, { commentId: '42' },
        { rankAtCompletion: 0.5 }, { recordedAt: null }, { recordedAt: 'not a date' }, { recordedAt: '2026-02-31T14:00:00Z' },
        { judge: 'fake Copilot' }, { judge: { source: 'copilot', moderated: false, text: 'Bad' } },
        { judge: { source: 'other', moderated: true, text: 'Bad' } },
    ]) await assert.rejects(new CompletionClient(options({ submit: async () => ({ ...receipt(), ...change }) })).submitResult(submission));
});

test('default server transport authenticates, disables redirects, and uses idempotency', async () => {
    const calls = [];
    const client = new CompletionClient({
        url, credential: 'server-only-secret', resolvePublic: async (target) => assert.equal(target, url),
        fetch: async (target, init) => { calls.push({ target, init }); return { ok: true, json: async () => receipt() }; },
    });
    await client.submitResult(submission);
    await client.submitResult(submission);
    assert.equal(calls.length, 4);
    assert.deepEqual(JSON.parse(calls[0].init.body), { runId: 'run-1', handle: 'brisk-brews-coffee' });
    assert.equal(calls[0].init.redirect, 'error');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer server-only-secret');
    assert.equal(calls[0].init.headers['Idempotency-Key'], calls[2].init.headers['Idempotency-Key']);
    assert.equal(calls[1].init.method, 'HEAD');
    assert.equal(calls[1].init.headers, undefined);
    assert.throws(() => new CompletionClient({ url }), /authentication/);
});

test('timeouts and transport failures return safe errors', async () => {
    await assert.rejects(new CompletionClient(options({ timeoutMs: 5, submit: () => new Promise(() => {}) })).submitResult(submission), /could not be verified/);
    await assert.rejects(new CompletionClient(options({ submit: async () => { throw new Error('SECRET'); } })).submitResult(submission), (error) => error instanceof CompletionError && error.code === 'completion_unavailable' && !error.message.includes('SECRET'));
});

test('DNS policy rejects a service before invoking authenticated fetch', async () => {
    let fetched = false;
    await assert.rejects(new CompletionClient({
        url, credential: 'secret', resolvePublic: async () => { throw new Error('private DNS address'); },
        fetch: async () => { fetched = true; },
    }).submitResult(submission));
    assert.equal(fetched, false);
});

test('QR must be explicitly approved and remotely reachable as an image', async () => {
    const qrImageUrl = 'https://assets.cafe.dev/leaderboard-qr.png';
    assert.throws(() => new CompletionClient(options({ qrImageUrl })), /approved external origin/);
    const calls = [];
    const config = {
        qrImageUrl, approvedQrOrigins: ['https://assets.cafe.dev'],
        resolvePublic: async () => {},
        fetch: async (target, init) => { calls.push({ target, init }); return { ok: true, headers: new Headers({ 'content-type': 'image/png' }) }; },
    };
    const result = await new CompletionClient(options(config)).submitResult(submission);
    assert.equal(result.qrImageUrl, qrImageUrl);
    assert.equal(calls[0].init.method, 'HEAD');
    assert.equal(calls[0].init.redirect, 'error');
    assert.equal(calls[0].init.headers, undefined);
    await assert.rejects(new CompletionClient(options({ ...config, fetch: async (target) => ({ ok: target !== qrImageUrl }) })).submitResult(submission), /not reachable/);
});

test('comments distinguish snapshot/live ranks and use accessible links without fake judge', async () => {
    const qrImageUrl = 'https://assets.cafe.dev/comment-qr.png';
    assert.throws(() => completionComment({ ...receipt(), leaderboardUrl: url, qrImageUrl }), /must first pass/);
    const result = await new CompletionClient(options({
        qrImageUrl, approvedQrOrigins: ['https://assets.cafe.dev'],
        resolvePublic: async () => {},
        fetch: async () => ({ ok: true, headers: new Headers({ 'content-type': 'image/png' }) }),
    })).submitResult(submission);
    const comment = completionComment(result);
    assert.ok(comment.startsWith('<!-- commit-and-sip:run-1 -->'));
    assert.match(comment, /Rank at completion: #2/);
    assert.match(comment, /snapshot, not live rank/);
    assert.match(comment, /QR code linking to the live Commit & Sip leaderboard/);
    assert.match(comment, /accessible leaderboard link/);
    assert.match(comment, /Copilot judge unavailable/);
    assert.match(completionComment({ ...receipt(), leaderboardUrl: url }), /QR code unavailable/);
    assert.throws(() => completionComment({ ...receipt(), runId: '-->inject', leaderboardUrl: url }));
});

test('trusted moderated Copilot commentary is escaped rather than executable markdown', async () => {
    const judge = { source: 'copilot', moderated: true, text: '<script>bad</script> [click](https://evil.dev)' };
    const result = await new CompletionClient(options({ submit: async () => ({ ...receipt(), judge }) })).submitResult(submission);
    const comment = completionComment(result);
    assert.match(comment, /Copilot judge \(moderated\)/);
    assert.ok(!comment.includes('<script>'));
    assert.ok(!comment.includes('[click]('));
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
    await assert.rejects(verifyPublicUrl('https://127.0.0.1', { fetch: async () => { fetched = true; } }), { code: 'completion_validation' });
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

test('completion verifies the actual phone leaderboard, not merely its submission endpoint', async () => {
    const leaderboardUrl = 'https://leaderboard.cafe.dev/phone';
    const calls = [];
    const client = new CompletionClient(options({
        leaderboardUrl,
        fetch: async (target, init) => { calls.push({ target, init }); return { ok: false }; },
    }));
    await assert.rejects(client.submitResult(submission), { code: 'public_url_unreachable' });
    assert.equal(calls[0].target, leaderboardUrl);
    assert.equal(calls[0].init.method, 'HEAD');
});

test('authority prepares a reachable QR comment before a comment ID exists without submitting again', async () => {
    const qrImageUrl = 'https://assets.cafe.dev/authority-qr.png';
    const reserved = { ...receipt(), commentId: undefined };
    const calls = [];
    const body = await prepareCompletionComment({
        receipt: reserved, leaderboardUrl: url, qrImageUrl, approvedQrOrigins: ['https://assets.cafe.dev'],
    }, {
        resolvePublic: async () => {},
        fetch: async (target, init) => {
            calls.push({ target, init });
            return { ok: true, headers: new Headers({ 'content-type': target === qrImageUrl ? 'image/png' : 'text/html' }) };
        },
    });
    assert.equal(reserved.commentId, undefined);
    assert.ok(body.startsWith('<!-- commit-and-sip:run-1 -->'));
    assert.match(body, /Rank at completion: #2/);
    assert.deepEqual(calls.map(({ target }) => target), [url, qrImageUrl]);
    assert.ok(calls.every(({ init }) => init.method === 'HEAD' && init.headers === undefined));
    await assert.rejects(new CompletionClient(options({ submit: async () => reserved })).submitResult(submission), { code: 'comment_unconfirmed' });
});

test('authority comment preparation rejects unapproved, unreachable or non-image QR assets', async () => {
    const qrImageUrl = 'https://assets.cafe.dev/rejected-qr.png';
    const config = { receipt: { ...receipt(), commentId: undefined }, leaderboardUrl: url, qrImageUrl, approvedQrOrigins: ['https://assets.cafe.dev'] };
    const network = { resolvePublic: async () => {}, fetch: async () => ({ ok: true, headers: new Headers({ 'content-type': 'text/html' }) }) };
    await assert.rejects(prepareCompletionComment({ ...config, approvedQrOrigins: [] }, network), /approved external origin/);
    await assert.rejects(prepareCompletionComment(config, network), /not reachable as an image/);
    await assert.rejects(prepareCompletionComment(config, { ...network, fetch: async () => ({ ok: false }) }), { code: 'public_url_unreachable' });
    await assert.rejects(prepareCompletionComment({ ...config, receipt: { ...config.receipt, score: 99999 } }, network), /does not match/);
});

test('canonical collision suffix preserves the candidate phrase and is returned unchanged on retries', async () => {
    const canonical = 'brisk-brews-coffee-12abcdef';
    const requested = [];
    const client = new CompletionClient(options({
        submit: async ({ handle }) => {
            requested.push(handle);
            return { ...receipt(), handle: canonical };
        },
    }));
    assert.equal((await client.submitResult(submission)).handle, canonical);
    assert.equal((await client.submitResult(submission)).handle, canonical);
    assert.equal((await client.submitResult({ ...submission, handle: canonical })).handle, canonical);
    assert.deepEqual(requested, ['brisk-brews-coffee', 'brisk-brews-coffee', canonical]);
});

test('canonical receipts reject changed phrases and malformed collision suffixes', async () => {
    for (const handle of [
        'bright-brews-coffee', 'bright-brews-coffee-12abcdef',
        'brisk-brews-coffee-1234567', 'brisk-brews-coffee-123456789',
        'brisk-brews-coffee-12ABCDEF', 'brisk-brews-coffee-12abcdeg',
        'brisk-brews-coffee-12abcdef-extra', 'brisk_brews_coffee',
    ]) {
        await assert.rejects(new CompletionClient(options({
            submit: async () => ({ ...receipt(), handle }),
        })).submitResult(submission), { name: 'CompletionError' });
    }
});
