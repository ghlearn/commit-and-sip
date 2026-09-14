import test from 'node:test';
import assert from 'node:assert/strict';
import { GithubAdapter, GithubAdapterError, GithubError } from '../.github/extensions/commit-and-sip/services/github.mjs';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const MERGE = 'c'.repeat(40);
const order = { id: 'mocha', name: 'Mocha', description: 'Chocolate coffee', price: 5, serving: 'hot', artwork: 'original-cortado-cup' };
const base = [{ id: 'tea', name: 'Tea', description: 'Green tea', price: 3, serving: 'hot', artwork: 'original-latte-cup' }];
const root = '/repos/cafe/menu';
const menuPath = 'src/data/specials.json';
const encode = (menu) => ({ type: 'file', encoding: 'base64', content: Buffer.from(JSON.stringify(menu)).toString('base64') });
const pr = () => ({ number: 2, title: 'Actual PR title', body: 'Actual PR description', user: { login: 'author' }, head: { sha: HEAD, repo: { full_name: 'cafe/menu' } }, base: { sha: BASE, repo: { full_name: 'cafe/menu' } }, state: 'open', draft: false, mergeable: true, mergeable_state: 'clean', merged: false, merge_commit_sha: null });
const approval = (id = 1) => ({ id, user: { login: 'reviewer' }, state: 'APPROVED', commit_id: HEAD });
const check = (id = 1) => ({ id, name: 'menu-validation', app: { id: 15368, slug: 'github-actions' }, head_sha: HEAD, status: 'completed', conclusion: 'success' });
const issue = { number: 1, title: 'Order', user: { login: 'author' } };

function fixture(overrides = {}, adapterOptions = {}) {
    const calls = [];
    const responses = {
        [`${root}/pulls/2`]: pr(),
        [`${root}/pulls/2/files?per_page=100&page=1`]: [{ filename: menuPath, status: 'modified' }],
        [`${root}/pulls/2/reviews?per_page=100&page=1`]: [approval()],
        [`${root}/commits/${HEAD}/check-runs?filter=all&per_page=100&page=1`]: { check_runs: [check()] },
        [`${root}/commits/${HEAD}/statuses?per_page=100&page=1`]: [],
        [`${root}/contents/${menuPath}?ref=${BASE}`]: encode(base),
        [`${root}/contents/${menuPath}?ref=${HEAD}`]: encode([...base, order]),
        [`${root}/contents/${menuPath}?ref=${MERGE}`]: encode([...base, order]),
        [`${root}/issues/1`]: issue,
        [`${root}/issues/1/comments?per_page=100&page=1`]: [],
        '/user': { login: 'reviewer' },
        ...overrides,
    };
    const adapter = new GithubAdapter({ repo: 'cafe/menu', requiredCheckAppIds: { 'menu-validation': 15368 }, ...adapterOptions, request: async (method, path, body) => {
        calls.push({ method, path, body });
        if (Object.hasOwn(responses, `${method} ${path}`)) return responses[`${method} ${path}`];
        if (!Object.hasOwn(responses, path)) throw new Error('Unexpected path');
        return typeof responses[path] === 'function' ? responses[path]() : responses[path];
    } });
    return { adapter, calls };
}
const inspect = (adapter, options = {}) => adapter.inspectPullRequest(2, { expectedHeadSha: HEAD, reviewer: 'reviewer', order, ...options });

test('validates exact appended menu and pinned effective approval', async () => {
    const result = await inspect(fixture().adapter);
    assert.equal(result.approved, true);
    assert.equal(result.checksPassed, true);
    assert.deepEqual(result.menu, [...base, order]);
    assert.equal(result.merged, false);
    assert.equal(result.summary, 'Actual PR title\n\nActual PR description');
    assert.equal(result.checks[0].conclusion, 'success');
});

test('paginates reviews, checks, statuses, and changed files', async () => {
    const reviews = Array.from({ length: 100 }, (_, id) => ({ ...approval(id), state: 'COMMENTED' }));
    const statuses = Array.from({ length: 100 }, (_, id) => ({ id, context: `extra-${id}`, state: 'success' }));
    const runs = Array.from({ length: 100 }, (_, id) => ({ ...check(id), name: `extra-${id}` }));
    const { adapter, calls } = fixture({
        [`${root}/pulls/2/reviews?per_page=100&page=1`]: reviews,
        [`${root}/pulls/2/reviews?per_page=100&page=2`]: [approval(101)],
        [`${root}/commits/${HEAD}/statuses?per_page=100&page=1`]: statuses,
        [`${root}/commits/${HEAD}/statuses?per_page=100&page=2`]: [],
        [`${root}/commits/${HEAD}/check-runs?filter=all&per_page=100&page=1`]: { check_runs: runs },
        [`${root}/commits/${HEAD}/check-runs?filter=all&per_page=100&page=2`]: { check_runs: [check(101)] },
    });
    assert.equal((await inspect(adapter)).approved, true);
    assert.equal(calls.filter(({ path }) => path.includes('page=2')).length, 3);
    const { adapter: filesAdapter, calls: fileCalls } = fixture({
        [`${root}/pulls/2/files?per_page=100&page=1`]: Array.from({ length: 100 }, () => ({ filename: menuPath, status: 'modified' })),
        [`${root}/pulls/2/files?per_page=100&page=2`]: [{ filename: '.github/workflows/ci.yml', status: 'modified' }],
    });
    await assert.rejects(inspect(filesAdapter), /Only the existing menu/);
    assert.ok(fileCalls.some(({ path }) => path.includes('/files?per_page=100&page=2')));
});

test('rejects head changes, self review, forks, drafts, and unknown mergeability', async () => {
    for (const change of [
        { head: { sha: MERGE, repo: { full_name: 'cafe/menu' } } },
        { user: { login: 'REVIEWER' } },
        { head: { sha: HEAD, repo: { full_name: 'attacker/menu' } } },
        { draft: true }, { mergeable: null },
    ]) {
        await assert.rejects(inspect(fixture({ [`${root}/pulls/2`]: { ...pr(), ...change } }).adapter));
    }
    let reads = 0;
    await assert.rejects(inspect(fixture({
        [`${root}/pulls/2`]: () => ++reads === 1 ? pr() : { ...pr(), head: { sha: MERGE, repo: { full_name: 'cafe/menu' } } },
    }).adapter), /head changed/);
});

test('requires latest matching reviewer approval pinned to the head', async () => {
    for (const review of [
        { ...approval(2), state: 'CHANGES_REQUESTED' },
        { ...approval(2), state: 'DISMISSED' },
        { ...approval(2), commit_id: BASE },
    ]) {
        const result = await inspect(fixture({ [`${root}/pulls/2/reviews?per_page=100&page=1`]: [approval(), review] }).adapter);
        assert.equal(result.approved, false);
    }
    assert.equal((await inspect(fixture({ [`${root}/pulls/2/reviews?per_page=100&page=1`]: [approval(), { ...approval(2), state: 'COMMENTED' }] }).adapter)).approved, true);
});

test('rejects missing, pending, failed, stale, or shadowed required checks', async () => {
    for (const runs of [[], [{ ...check(), status: 'in_progress' }], [{ ...check(), conclusion: 'neutral' }], [{ ...check(), head_sha: BASE }], [check(), { ...check(2), conclusion: 'failure' }]]) {
        await assert.rejects(inspect(fixture({ [`${root}/commits/${HEAD}/check-runs?filter=all&per_page=100&page=1`]: { check_runs: runs } }).adapter));
    }
    await assert.rejects(inspect(fixture().adapter, { requiredChecks: [] }), /required check/);
    const withUntrustedStatus = await inspect(fixture({
        [`${root}/commits/${HEAD}/statuses?per_page=100&page=1`]: [{ id: 2, context: 'menu-validation', state: 'pending' }, { id: 1, context: 'menu-validation', state: 'success' }],
    }).adapter);
    assert.equal(withUntrustedStatus.checks.find((item) => item.kind === 'status').conclusion, 'pending');
});

test('rejects unrelated file changes, schema changes, base edits, reorder, and duplicate IDs', async () => {
    const other = { id: 'latte', name: 'Latte', description: 'Milky', serving: 'hot', artwork: 'original-latte-cup', price: 4 };
    for (const menu of [
        [...base, { ...order, extra: true }],
        [...base, { ...order, artwork: 'unknown-cup' }],
        [{ ...base[0], price: 7 }, order],
        [order, ...base],
        [...base, order, other],
        [...base, { ...order, id: 'tea' }],
        { drinks: [...base, order] },
    ]) await assert.rejects(inspect(fixture({ [`${root}/contents/${menuPath}?ref=${HEAD}`]: encode(menu) }).adapter));
    await assert.rejects(inspect(fixture({ [`${root}/pulls/2/files?per_page=100&page=1`]: [{ filename: menuPath, status: 'renamed', previous_filename: 'old.json' }] }).adapter));
});

test('merged evidence requires the exact intended menu at the actual merge SHA', async () => {
    const merged = { ...pr(), merged: true, state: 'closed', mergeable: null, merge_commit_sha: MERGE };
    assert.equal((await inspect(fixture({ [`${root}/pulls/2`]: merged }).adapter)).mergeCommitSha, MERGE);
    await assert.rejects(inspect(fixture({
        [`${root}/pulls/2`]: merged,
        [`${root}/contents/${menuPath}?ref=${MERGE}`]: encode(base),
    }).adapter), /merged commit/);
});

test('approval verifies identity and creates only a commit-pinned review', async () => {
    const { adapter, calls } = fixture({ [`POST ${root}/pulls/2/reviews`]: approval() });
    await adapter.approve(2, { headSha: HEAD, reviewer: 'reviewer' });
    assert.deepEqual(calls.filter(({ method }) => method !== 'GET'), [{ method: 'POST', path: `${root}/pulls/2/reviews`, body: { commit_id: HEAD, event: 'APPROVE' } }]);
    const denied = fixture({ '/user': { login: 'someoneelse' } });
    await assert.rejects(denied.adapter.approve(2, { headSha: HEAD, reviewer: 'reviewer' }), /authenticated/);
    assert.ok(denied.calls.every(({ method }) => method === 'GET'));
});

test('merge uses GitHub SHA guard and requires confirmed success', async () => {
    const { adapter, calls } = fixture({ [`PUT ${root}/pulls/2/merge`]: { merged: true, sha: MERGE } });
    await adapter.merge(2, { headSha: HEAD });
    assert.deepEqual(calls.at(-1).body, { sha: HEAD });
    await assert.rejects(fixture({ [`PUT ${root}/pulls/2/merge`]: { merged: false } }).adapter.merge(2, { headSha: HEAD }), /did not confirm/);
});

test('readIssue rejects pull requests and invalid issue numbers', async () => {
    await assert.rejects(fixture({ [`${root}/issues/1`]: { ...issue, pull_request: {} } }).adapter.readIssue(1), /not a valid/);
    await assert.rejects(fixture().adapter.readIssue('../2'), /number/);
});

test('completion comment retries reuse owned markers and reject collisions', async () => {
    const body = '<!-- commit-and-sip:run-1 -->\nComplete';
    const comment = { id: 42, body, user: { login: 'reviewer' } };
    const path = `${root}/issues/1/comments?per_page=100&page=1`;
    const { adapter, calls } = fixture({ [path]: [comment] });
    assert.deepEqual(await adapter.upsertCompletionComment(1, 'run-1', body), comment);
    assert.ok(calls.every(({ method }) => method === 'GET'));
    const updated = fixture({ [path]: [comment], [`PATCH ${root}/issues/comments/42`]: { ...comment, body: `${body}!` } });
    await updated.adapter.upsertCompletionComment(1, 'run-1', `${body}!`, 42);
    assert.equal(updated.calls.at(-1).method, 'PATCH');
    const created = fixture({ [`POST ${root}/issues/1/comments`]: comment });
    await created.adapter.upsertCompletionComment(1, 'run-1', body);
    assert.equal(created.calls.at(-1).method, 'POST');
    for (const comments of [[{ ...comment, user: { login: 'attacker' } }], [comment, comment]]) {
        const collision = fixture({ [path]: comments });
        await assert.rejects(collision.adapter.upsertCompletionComment(1, 'run-1', body), /collision/);
        assert.ok(collision.calls.every(({ method }) => method === 'GET'));
    }
    await assert.rejects(adapter.upsertCompletionComment(1, 'run-1', body, 43), /persisted/);
});

test('completion marker lookup paginates before creating', async () => {
    const body = '<!-- commit-and-sip:run-1 -->';
    const comment = { id: 101, body, user: { login: 'reviewer' } };
    const { adapter, calls } = fixture({
        [`${root}/issues/1/comments?per_page=100&page=1`]: Array.from({ length: 100 }, (_, id) => ({ id: id + 1, body: 'other', user: { login: 'reviewer' } })),
        [`${root}/issues/1/comments?per_page=100&page=2`]: [comment],
    });
    assert.equal((await adapter.upsertCompletionComment(1, 'run-1', body)).id, 101);
    assert.ok(calls.every(({ method }) => method === 'GET'));
});

test('transport errors never expose upstream credentials or response bodies', async () => {
    const adapter = new GithubAdapter({ repo: 'cafe/menu', request: async () => { throw new Error('SECRET-TOKEN'); } });
    await assert.rejects(adapter.readIssue(1), (error) => error instanceof GithubAdapterError && error.code === 'github_request_failed' && !error.message.includes('SECRET-TOKEN'));
});

test('head and check failures expose stable safe error codes', async () => {
    assert.equal(GithubError, GithubAdapterError);
    await assert.rejects(inspect(fixture().adapter, { expectedHeadSha: BASE }), { name: 'GithubAdapterError', code: 'head_changed' });
    await assert.rejects(inspect(fixture().adapter, { requiredChecks: [] }), { name: 'GithubAdapterError', code: 'invalid_checks' });
    await assert.rejects(inspect(fixture({
        [`${root}/commits/${HEAD}/check-runs?filter=all&per_page=100&page=1`]: { check_runs: [{ ...check(), status: 'queued' }] },
    }).adapter), { name: 'GithubAdapterError', code: 'checks_not_passed' });
    await assert.rejects(inspect(fixture({
        [`${root}/commits/${HEAD}/check-runs?filter=all&per_page=100&page=1`]: { check_runs: [{ ...check(), head_sha: BASE }] },
    }).adapter), { name: 'GithubAdapterError', code: 'check_head_mismatch' });
});

test('required check names cannot be spoofed by statuses or an untrusted publisher', async () => {
    assert.equal((await inspect(fixture({}, { requiredCheckAppIds: {} }).adapter)).checksPassed, true);
    for (const runs of [[], [{ ...check(), app: { id: 666, slug: 'untrusted-app' } }], [{ ...check(), app: undefined }]]) {
        await assert.rejects(inspect(fixture({
            [`${root}/commits/${HEAD}/check-runs?filter=all&per_page=100&page=1`]: { check_runs: runs },
            [`${root}/commits/${HEAD}/statuses?per_page=100&page=1`]: [{ id: 999, context: 'menu-validation', state: 'success' }],
        }, { requiredCheckAppIds: {} }).adapter), { code: 'checks_not_passed' });
    }
    assert.equal((await inspect(fixture({
        [`${root}/commits/${HEAD}/check-runs?filter=all&per_page=100&page=1`]: { check_runs: [
            check(), { ...check(999), app: { id: 666, slug: 'untrusted-app' }, conclusion: 'failure' },
            { ...check(1000), name: 'unrelated', status: 'queued', conclusion: null },
        ] },
    }).adapter)).checksPassed, true);
});

test('staff can override trusted publisher slug and additionally pin its ID', async () => {
    const responses = {
        [`${root}/commits/${HEAD}/check-runs?filter=all&per_page=100&page=1`]: { check_runs: [{ ...check(), app: { id: 12, slug: 'trusted-ci' } }] },
    };
    assert.equal((await inspect(fixture(responses, {
        requiredCheckAppIds: { 'menu-validation': 12 }, requiredCheckAppSlugs: { 'menu-validation': 'trusted-ci' },
    }).adapter)).checksPassed, true);
    await assert.rejects(inspect(fixture(responses, {
        requiredCheckAppIds: { 'menu-validation': 13 }, requiredCheckAppSlugs: { 'menu-validation': 'trusted-ci' },
    }).adapter), { code: 'checks_not_passed' });
});
