import { BlockList, isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';

// Extracted verbatim from the retired completion service. The booth still
// promises attendees a scannable destination, so the rule that a leaderboard
// URL must be a genuinely public HTTPS address - and the SSRF protections that
// enforce it - outlive the pull-request flow that first needed them.
export class PublicUrlError extends Error {
    constructor(message, code = 'public_url_validation') {
        super(message);
        this.name = 'PublicUrlError';
        this.code = code;
    }
}

const fail = (message, code) => { throw new PublicUrlError(message, code); };

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
            reject(new PublicUrlError('The public HTTPS page could not be reached within the allowed time.', 'public_url_unreachable'));
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
        if (error instanceof PublicUrlError) throw error;
        fail('The configured public HTTPS page could not be reached safely. Check its DNS and availability.', 'public_url_unreachable');
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
    }
}
