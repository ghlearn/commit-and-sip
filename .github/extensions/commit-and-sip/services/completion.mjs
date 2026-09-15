import { BlockList, isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';

export class CompletionError extends Error {
    constructor(message, code = 'completion_validation') {
        super(message);
        this.name = 'CompletionError';
        this.code = code;
    }
}
const fail = (message, code) => { throw new CompletionError(message, code); };
const runIdOf = (value) => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value) ? value : fail('Invalid completion run ID.');
const handleOf = (value) => typeof value === 'string' && value.length <= 128 && /^[a-z]+-[a-z]+-[a-z]+(?:-[a-f0-9]{8})?$/.test(value) ? value : fail('Invalid persisted leaderboard handle.');
const rankOf = (value) => Number.isSafeInteger(value) && value > 0 ? value : fail('Invalid server-authoritative leaderboard rank.');
const verifiedQrUrls = new Map();

function publicAddress(address) {
    if (isIP(address) === 4) {
        const [a, b] = address.split('.').map(Number);
        return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || b === 2 || b === 88)) || (a === 198 && (b === 18 || b === 19 || b === 51)) || (a === 203 && b === 0));
    }
    if (isIP(address) === 6) {
        // Only global unicast; exclude documentation, transition and mapped ranges.
        const global = new BlockList();
        global.addSubnet('2000::', 3, 'ipv6');
        const reserved = new BlockList();
        for (const [network, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]]) reserved.addSubnet(network, prefix, 'ipv6');
        return global.check(address, 'ipv6') && !reserved.check(address, 'ipv6');
    }
    return false;
}

export function validateLeaderboardUrl(value) {
    let url;
    try {
        if (typeof value !== 'string' || value !== value.trim() || /[\\\s#]/.test(value) || !/^https:\/\//i.test(value) || value.split('/')[2]?.includes('@')) fail('Invalid URL.');
        url = new URL(value);
    } catch { fail('A public HTTPS leaderboard URL must be explicitly configured.'); }
    const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443') || !hostname || hostname.endsWith('.') ||
        (isIP(hostname) ? !publicAddress(hostname) : !hostname.includes('.') || hostname.split('.').some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) || /\.(localhost|local|internal|test|invalid|example)$/.test(hostname))) {
        fail('Only public HTTPS URLs without credentials, fragments, or nonstandard ports are allowed.');
    }
    return url.href;
}

async function validatePublicDns(url) {
    const hostname = new URL(url).hostname.replace(/^\[|\]$/g, '');
    const addresses = isIP(hostname) ? [{ address: hostname }] : await lookup(hostname, { all: true });
    if (!addresses.length || addresses.some(({ address }) => !publicAddress(address))) fail('The configured service does not resolve exclusively to public addresses.');
}

// The default transport pins the DNS result at socket creation, so a second
// DNS lookup cannot turn a previously public address into an internal target.
function publicFetch(url, { method, signal, headers, body }) {
    validateLeaderboardUrl(url);
    return new Promise((resolve, reject) => {
        const request = httpsRequest(url, {
            method, signal, headers, agent: false,
            lookup(hostname, options, callback) {
                lookup(hostname, { all: true }).then((addresses) => {
                    if (!addresses.length || addresses.some(({ address }) => !publicAddress(address))) return callback(new Error('Private network target rejected.'));
                    if (options.all) callback(null, addresses);
                    else callback(null, addresses[0].address, addresses[0].family);
                }, callback);
            },
        }, (response) => {
            const chunks = [];
            let size = 0;
            response.on('data', (chunk) => {
                size += chunk.length;
                if (size > 1024 * 1024) request.destroy(new Error('Service response is too large.'));
                else chunks.push(chunk);
            });
            response.on('error', reject);
            response.on('end', () => resolve({
                ok: response.statusCode >= 200 && response.statusCode < 300,
                headers: { get: (name) => response.headers[name.toLowerCase()] ?? null },
                json: async () => JSON.parse(Buffer.concat(chunks).toString('utf8')),
            }));
        });
        request.on('error', reject);
        request.end(body);
    });
}

// Returns the normalized URL only after an unauthenticated, non-redirecting HEAD
// succeeds. Override both fetch and resolvePublic for deterministic offline tests.
export async function verifyPublicUrl(value, {
    fetch: fetchTransport = publicFetch, resolvePublic = validatePublicDns,
    timeoutMs = 10_000, signal,
} = {}) {
    const url = validateLeaderboardUrl(value);
    if (typeof fetchTransport !== 'function' || typeof resolvePublic !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) fail('Invalid public URL verification configuration.');
    const controller = new AbortController();
    let timer;
    let onAbort;
    const interrupted = new Promise((_, reject) => {
        const stop = () => {
            controller.abort();
            reject(new CompletionError('The public HTTPS page could not be reached within the allowed time.', 'public_url_unreachable'));
        };
        timer = setTimeout(stop, timeoutMs);
        onAbort = stop;
        if (signal?.aborted) stop();
        else signal?.addEventListener('abort', onAbort, { once: true });
    });
    try {
        const verify = async () => {
            if (controller.signal.aborted) fail('Public HTTPS verification was cancelled.', 'public_url_unreachable');
            await resolvePublic(url);
            if (controller.signal.aborted) fail('Public HTTPS verification was cancelled.', 'public_url_unreachable');
            const response = await fetchTransport(url, { method: 'HEAD', redirect: 'error', signal: controller.signal });
            if (!response.ok) fail('The public HTTPS page must respond successfully without redirects.', 'public_url_unreachable');
            return url;
        };
        return await Promise.race([verify(), interrupted]);
    } catch (error) {
        if (error instanceof CompletionError) throw error;
        fail('The configured public HTTPS page could not be reached safely. Check its DNS and availability.', 'public_url_unreachable');
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
    }
}

function judgeOf(judge) {
    if (judge == null) return null;
    if (typeof judge !== 'object' || judge.source !== 'copilot' || judge.moderated !== true || typeof judge.text !== 'string' || !judge.text.trim() || judge.text.length > 1000) fail('The server returned invalid or unmoderated Copilot commentary.');
    return { source: 'copilot', moderated: true, text: judge.text };
}

const markdown = (value) => String(value).replace(/[\\`*_{}\[\]<>()!#|]/g, '\\$&').replace(/[\r\n]+/g, ' ');

function validateReceipt(receipt, { runId, handle, requireCommentId = false } = {}) {
    if (!receipt || receipt.score !== 1000 || (runId !== undefined && receipt.runId !== runId)) fail('The leaderboard receipt does not match the persisted run.');
    runIdOf(receipt.runId); handleOf(receipt.handle);
    if (handle !== undefined) {
        handleOf(handle);
        const phrase = handle.split('-').slice(0, 3).join('-');
        const acceptsCollision = !/-[a-f0-9]{8}$/.test(handle) &&
            receipt.handle.startsWith(`${phrase}-`) && /^-[a-f0-9]{8}$/.test(receipt.handle.slice(phrase.length));
        if (receipt.handle !== handle && !acceptsCollision) fail('The leaderboard receipt does not match the persisted handle phrase.');
    }
    rankOf(receipt.rank); rankOf(receipt.rankAtCompletion);
    if (typeof receipt.recordedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(receipt.recordedAt) || !Number.isFinite(Date.parse(receipt.recordedAt)) || new Date(receipt.recordedAt).toISOString().slice(0, 19) !== receipt.recordedAt.slice(0, 19)) fail('The leaderboard receipt requires a valid UTC record timestamp.');
    if ((requireCommentId || receipt.commentId != null) && (!Number.isSafeInteger(receipt.commentId) || receipt.commentId < 1)) fail('The leaderboard receipt must include the confirmed final issue comment ID.', 'comment_unconfirmed');
    return {
        runId: receipt.runId, handle: receipt.handle, score: 1000, rank: receipt.rank,
        rankAtCompletion: receipt.rankAtCompletion, recordedAt: receipt.recordedAt,
        judge: judgeOf(receipt.judge),
        ...(receipt.commentId == null ? {} : { commentId: receipt.commentId }),
    };
}

// Authority-side preparation before the sole writer publishes its reserved
// receipt. No commentId is required here: finalize must persist it after posting.
export async function prepareCompletionComment({
    receipt, leaderboardUrl, qrImageUrl, approvedQrOrigins = [],
}, network = {}) {
    const validated = validateReceipt(receipt);
    const leaderboard = validateLeaderboardUrl(leaderboardUrl);
    const qr = validateLeaderboardUrl(qrImageUrl);
    if (!Array.isArray(approvedQrOrigins) || !approvedQrOrigins.some((origin) => new URL(validateLeaderboardUrl(origin)).origin === new URL(qr).origin)) fail('The QR image must use an explicitly approved external origin.');
    await verifyPublicUrl(leaderboard, network);
    const fetchTransport = network.fetch ?? publicFetch;
    await verifyPublicUrl(qr, {
        ...network,
        fetch: async (url, options) => {
            const response = await fetchTransport(url, options);
            if (!response.ok || !/^image\/(png|jpeg|webp|gif)(?:;|$)/i.test(response.headers.get('content-type') || '')) fail('The approved external QR image is not reachable as an image.');
            return response;
        },
    });
    if (verifiedQrUrls.size >= 1000) verifiedQrUrls.clear();
    verifiedQrUrls.set(qr, Date.now());
    return completionComment({ ...validated, leaderboardUrl: leaderboard, qrImageUrl: qr });
}

// submit is a trusted server-side transport: submit({runId, handle}, {url, signal}).
// It must authenticate to a service that re-verifies the persisted run's GitHub
// facts, validates the persisted curated handle candidate, and atomically stores
// one immutable completion receipt per runId. Only that remote authority writes
// the final issue comment; it must confirm commentId before returning its receipt.
// It may resolve a handle collision using the same phrase plus eight hex digits.
// Return and persist its canonical handle. Never submit score or evidence.
export class CompletionClient {
    constructor({ url, leaderboardUrl = url, submit, fetch: fetchTransport = publicFetch, credential, timeoutMs = 10_000, qrImageUrl, approvedQrOrigins = [], resolvePublic = validatePublicDns } = {}) {
        this.url = validateLeaderboardUrl(url);
        this.leaderboardUrl = validateLeaderboardUrl(leaderboardUrl);
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) fail('Invalid completion timeout.');
        if (submit !== undefined && typeof submit !== 'function') fail('Invalid completion transport.');
        if (!submit && (typeof credential !== 'string' || !credential.trim() || /[\r\n]/.test(credential))) fail('Server-side leaderboard authentication is required.');
        if (typeof fetchTransport !== 'function' || typeof resolvePublic !== 'function') fail('Invalid completion network transport.');
        this.submit = submit;
        this.fetch = fetchTransport;
        this.credential = credential;
        this.timeoutMs = timeoutMs;
        this.resolvePublic = resolvePublic;
        this.qrImageUrl = qrImageUrl === undefined ? null : validateLeaderboardUrl(qrImageUrl);
        if (!Array.isArray(approvedQrOrigins) || (this.qrImageUrl && !approvedQrOrigins.some((origin) => new URL(validateLeaderboardUrl(origin)).origin === new URL(this.qrImageUrl).origin))) fail('The QR image must use an explicitly approved external origin.');
    }

    async submitResult({ runId, handle }) {
        runIdOf(runId); handleOf(handle);
        const controller = new AbortController();
        let timer;
        const timedOut = new Promise((_, reject) => {
            timer = setTimeout(() => { controller.abort(); reject(new Error('The leaderboard request timed out. Retry with the same run ID.')); }, this.timeoutMs);
        });
        try {
            const operation = async () => {
                let receipt;
                if (this.submit) receipt = await this.submit({ runId, handle }, { url: this.url, signal: controller.signal });
                else {
                    await this.resolvePublic(this.url);
                    const response = await this.fetch(this.url, {
                        method: 'POST', redirect: 'error', signal: controller.signal,
                        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.credential}`, 'Idempotency-Key': runId },
                        body: JSON.stringify({ runId, handle }),
                    });
                    if (!response.ok) fail('The authenticated leaderboard service rejected completion.');
                    receipt = await response.json();
                }
                const validated = validateReceipt(receipt, { runId, handle, requireCommentId: true });
                await verifyPublicUrl(this.leaderboardUrl, {
                    fetch: this.fetch, resolvePublic: this.resolvePublic, timeoutMs: this.timeoutMs, signal: controller.signal,
                });
                if (this.qrImageUrl) {
                    await this.resolvePublic(this.qrImageUrl);
                    const response = await this.fetch(this.qrImageUrl, { method: 'HEAD', redirect: 'error', signal: controller.signal });
                    if (!response.ok || !/^image\/(png|jpeg|webp|gif)(?:;|$)/i.test(response.headers.get('content-type') || '')) fail('The approved external QR image is not reachable as an image.');
                    if (verifiedQrUrls.size >= 1000) verifiedQrUrls.clear();
                    verifiedQrUrls.set(this.qrImageUrl, Date.now());
                }
                return { ...validated, leaderboardUrl: this.leaderboardUrl, qrImageUrl: this.qrImageUrl };
            };
            return await Promise.race([operation(), timedOut]);
        } catch (error) {
            if (error instanceof CompletionError) throw error;
            fail('Leaderboard completion could not be verified. Check server configuration and retry with the same run ID.', 'completion_unavailable');
        } finally { clearTimeout(timer); }
    }
}

// Use prepareCompletionComment for authority-side publication. A configured QR
// asset must have passed approval and reachability verification within 5 minutes.
export function completionComment({ runId, handle, score, rankAtCompletion, leaderboardUrl, qrImageUrl, judge }) {
    runIdOf(runId); handleOf(handle); rankOf(rankAtCompletion);
    if (score !== 1000) fail('Completion score must be the verified 1000-point award.');
    const url = validateLeaderboardUrl(leaderboardUrl);
    const qr = qrImageUrl == null ? null : validateLeaderboardUrl(qrImageUrl);
    if (qr && (!verifiedQrUrls.has(qr) || Date.now() - verifiedQrUrls.get(qr) > 5 * 60_000)) fail('The QR image must first pass the completion client approval and reachability check.');
    const commentary = judgeOf(judge);
    return [
        `<!-- commit-and-sip:${runId} -->`,
        '## Commit & Sip — order served!',
        '',
        `**${markdown(handle)}** earned **1000 points** for verified completion.`,
        `**Rank at completion: #${rankAtCompletion}** (snapshot, not live rank).`,
        '',
        `[View the live Commit & Sip leaderboard](<${url}>) — current rankings may change.`,
        ...(qr ? ['', `![QR code linking to the live Commit & Sip leaderboard](<${qr}>)`, `[Open the accessible leaderboard link instead of scanning the QR code](<${url}>).`] : ['', 'QR code unavailable: no approved, reachable external image is configured.']),
        '',
        commentary ? `**Copilot judge (moderated):** ${markdown(commentary.text)}` : '**Copilot judge unavailable.** No AI commentary was generated.',
    ].join('\n');
}
