import { execFile } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { validBaseRef } from '../domain.mjs';

export class GithubAdapterError extends Error {
    constructor(message, code = 'github_validation') {
        super(message);
        this.name = 'GithubAdapterError';
        this.code = code;
    }
}
export { GithubAdapterError as GithubError };

const fail = (message, code) => { throw new GithubAdapterError(message, code); };
const approvalMarker = id => {
    if (typeof id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)) fail('Invalid approval attempt ID.');
    return `<!-- commit-and-sip-approval:${id} -->`;
};
const sameLogin = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const number = (value) => Number.isSafeInteger(value) && value > 0 ? value : fail('Invalid GitHub issue or pull request number.');
const sha = (value) => typeof value === 'string' && /^[a-f0-9]{40}$/i.test(value) ? value : fail('A full Git commit SHA is required.', 'invalid_sha');
const login = (value) => typeof value === 'string' && /^[a-z0-9](?:[a-z0-9-]{0,38})$/i.test(value) ? value : fail('A valid GitHub reviewer is required.');
const markerFor = (runId) => typeof runId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(runId) ? `<!-- commit-and-sip:${runId} -->` : fail('Invalid completion run ID.');

function ghRequest(method, path, body) {
    return new Promise((resolve, reject) => {
        const args = ['api', '--method', method, path, '-H', 'Accept: application/vnd.github+json'];
        if (body !== undefined) args.push('--input', '-');
        const child = execFile('gh', args, { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
            if (error) return reject(new Error('GitHub request failed. Check server-side authentication, permissions, and connectivity.'));
            try { resolve(JSON.parse(stdout)); }
            catch { reject(new Error('GitHub returned an invalid JSON response.')); }
        });
        child.stdin.once('error', () => {
            child.kill();
            reject(new GithubAdapterError('GitHub request input could not be written safely.', 'github_request_failed'));
        });
        child.stdin.end(body === undefined ? undefined : JSON.stringify(body));
    });
}

function validateDrink(drink) {
    const keys = ['artwork', 'description', 'id', 'name', 'price', 'serving'];
    if (!drink || typeof drink !== 'object' || Array.isArray(drink) || !isDeepStrictEqual(Object.keys(drink).sort(), keys)) fail('Menu drinks must use the exact drink schema.');
    for (const key of ['id', 'name', 'description', 'artwork']) {
        if (typeof drink[key] !== 'string' || !drink[key].trim() || drink[key].length > 500) fail('Menu drink text is invalid.');
    }
    if (!['hot', 'cold'].includes(drink.serving) || !['original-latte-cup', 'original-cortado-cup', 'original-cold-brew-glass'].includes(drink.artwork) || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(drink.id) || !Number.isFinite(drink.price) || drink.price <= 0 || drink.price > 1000) fail('Menu drink ID, artwork, serving, or price is invalid.');
    return drink;
}

function validateMenu(menu) {
    if (!Array.isArray(menu) || menu.length > 1000) fail('The menu must be a JSON array.');
    menu.forEach(validateDrink);
    if (new Set(menu.map((item) => item.id)).size !== menu.length) fail('Menu drink IDs must be unique.');
    return menu;
}

export class GithubAdapter {
    // This repository's checks are published by the official GitHub Actions app.
    // Staff may override slugs or additionally pin IDs; statuses never attest CI.
    constructor({ repo, request = ghRequest, requiredCheckAppIds = {}, requiredCheckAppSlugs = {} }) {
        if (typeof repo !== 'string' || !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repo) || repo.split('/').some((part) => part === '.' || part === '..')) fail('A valid owner/repository is required.');
        if (typeof request !== 'function') fail('A GitHub transport is required.');
        this.repo = repo;
        if (!requiredCheckAppIds || typeof requiredCheckAppIds !== 'object' || Array.isArray(requiredCheckAppIds) || Object.values(requiredCheckAppIds).some((id) => !Number.isSafeInteger(id) || id < 1)) fail('Trusted check publisher IDs must be configured by staff.', 'check_publisher_unconfigured');
        this.requiredCheckAppIds = { ...requiredCheckAppIds };
        if (!requiredCheckAppSlugs || typeof requiredCheckAppSlugs !== 'object' || Array.isArray(requiredCheckAppSlugs) || Object.values(requiredCheckAppSlugs).some((slug) => typeof slug !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{0,99})$/.test(slug))) fail('Trusted check publisher slugs must be configured by staff.', 'check_publisher_unconfigured');
        this.requiredCheckAppSlugs = { ...requiredCheckAppSlugs };
        this.request = async (method, path, body) => {
            try { return await request(method, path, body); }
            catch { fail('GitHub request failed. Check server-side authentication, permissions, and connectivity.', 'github_request_failed'); }
        };
        this.root = `/repos/${repo}`;
    }

    async pages(path, field) {
        const rows = [];
        for (let page = 1; page <= 100; page++) {
            const response = await this.request('GET', `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
            const batch = field ? response?.[field] : response;
            if (!Array.isArray(batch)) fail('GitHub returned an invalid paginated response.');
            rows.push(...batch);
            if (batch.length < 100) return rows;
        }
        fail('GitHub pagination exceeded the safe limit.');
    }

    async readIssue(issueNumber) {
        const issue = await this.request('GET', `${this.root}/issues/${number(issueNumber)}`);
        if (!issue || issue.number !== issueNumber || issue.pull_request || typeof issue.title !== 'string' || !issue.user?.login) fail('The selected item is not a valid GitHub issue.');
        return issue;
    }

    async menuAt(path, ref) {
        const encodedPath = path.split('/').map(encodeURIComponent).join('/');
        const content = await this.request('GET', `${this.root}/contents/${encodedPath}?ref=${sha(ref)}`);
        if (content?.type !== 'file' || content.encoding !== 'base64' || typeof content.content !== 'string') fail('The menu file is missing or unreadable.');
        let menu;
        try { menu = JSON.parse(Buffer.from(content.content, 'base64').toString('utf8')); }
        catch { fail('The menu is not valid JSON.'); }
        return validateMenu(menu);
    }

    validatePr(pr, expectedHeadSha, reviewer, expectedBaseRef) {
        if (!pr || !pr.user?.login || !pr.head || !pr.base) fail('GitHub returned an invalid pull request.');
        sha(pr.head.sha);
        sha(pr.base.sha);
        if (expectedHeadSha && pr.head.sha !== sha(expectedHeadSha)) fail('The pull request head changed. Inspect the new commit before continuing.', 'head_changed');
        if (!validBaseRef(expectedBaseRef)) fail('An explicit application base branch is required.', 'invalid_base_ref');
        if (pr.base.ref !== expectedBaseRef) fail('The pull request targets a different application branch.', 'base_ref_mismatch');
        if (!sameLogin(pr.head.repo?.full_name, this.repo) || !sameLogin(pr.base.repo?.full_name, this.repo)) fail('Fork pull requests are not supported.');
        if (pr.draft) fail('Draft pull requests cannot complete this activity.');
        if (reviewer && sameLogin(pr.user.login, reviewer)) fail('The reviewer must not be the pull request author.');
        if (!pr.merged && (pr.state !== 'open' || pr.mergeable !== true || ['dirty', 'unknown'].includes(pr.mergeable_state))) fail('The pull request is not confirmed mergeable. Try again after GitHub finishes checking it.');
    }

    async inspectPullRequest(prNumber, { expectedHeadSha, expectedBaseRef, reviewer, order, baseMenuPath = 'src/data/specials.json', requiredChecks = ['menu-validation'], approvalAttemptId }) {
        number(prNumber);
        if (!validBaseRef(expectedBaseRef)) fail('An explicit application base branch is required.', 'invalid_base_ref');
        const marker = approvalAttemptId === undefined ? null : approvalMarker(approvalAttemptId);
        login(reviewer);
        validateDrink(order);
        if (!/^[a-zA-Z0-9_./-]+$/.test(baseMenuPath) || baseMenuPath.startsWith('/') || baseMenuPath.split('/').some((part) => !part || part === '.' || part === '..')) fail('Invalid menu path.');
        if (!Array.isArray(requiredChecks) || !requiredChecks.length || requiredChecks.some((name) => typeof name !== 'string' || !name.trim()) || new Set(requiredChecks).size !== requiredChecks.length) fail('At least one unique required check name is required.', 'invalid_checks');
        const path = `${this.root}/pulls/${prNumber}`;
        const pr = await this.request('GET', path);
        if (pr?.number !== prNumber) fail('GitHub returned the wrong pull request.');
        this.validatePr(pr, expectedHeadSha, reviewer, expectedBaseRef);
        const headSha = pr.head.sha;
        const baseSha = pr.base.sha;
        const [files, reviews, runs, statuses, baseMenu, menu] = await Promise.all([
            this.pages(`${path}/files`),
            this.pages(`${path}/reviews`),
            this.pages(`${this.root}/commits/${headSha}/check-runs?filter=all`, 'check_runs'),
            this.pages(`${this.root}/commits/${headSha}/statuses`),
            this.menuAt(baseMenuPath, baseSha),
            this.menuAt(baseMenuPath, headSha),
        ]);
        if (files.length !== 1 || files[0].filename !== baseMenuPath || files[0].status !== 'modified' || files[0].previous_filename) fail('Only the existing menu file may change.');
        if (baseMenu.some((item) => item.id === order.id) || !isDeepStrictEqual(menu, [...baseMenu, order])) fail('The menu must preserve every base item and append only the intended drink.');
        const latest = new Map();
        for (const run of runs) {
            if (run.head_sha !== headSha) fail('A check run does not match the inspected head.', 'check_head_mismatch');
            if (typeof run.name !== 'string' || !Number.isSafeInteger(run.id)) fail('GitHub returned an invalid check run.', 'invalid_checks');
            const key = `check:${run.app?.id}:${run.app?.slug}:${run.name}`;
            const passed = run.status === 'completed' && run.conclusion === 'success';
            if (!latest.has(key) || latest.get(key).id < run.id) latest.set(key, {
                id: run.id, name: run.name, appId: run.app?.id ?? null, appSlug: run.app?.slug ?? null, kind: 'check', passed,
                conclusion: run.status !== 'completed' ? 'pending' : passed ? 'success' : 'failure',
            });
        }
        for (const status of statuses) {
            if (typeof status.context !== 'string' || !Number.isSafeInteger(status.id)) fail('GitHub returned an invalid status context.', 'invalid_checks');
            const key = `status:${status.context}`;
            if (!latest.has(key) || latest.get(key).id < status.id) latest.set(key, {
                id: status.id, name: status.context, kind: 'status', passed: status.state === 'success',
                conclusion: status.state === 'pending' ? 'pending' : status.state === 'success' ? 'success' : 'failure',
            });
        }
        const checks = [...latest.values()];
        if (requiredChecks.some((name) => !checks.some((check) =>
            check.name === name && check.kind === 'check' &&
            check.appSlug === (this.requiredCheckAppSlugs[name] ?? 'github-actions') &&
            (!Object.hasOwn(this.requiredCheckAppIds, name) || check.appId === this.requiredCheckAppIds[name]) &&
            check.passed
        ))) fail('Required checks from trusted publishers are missing, pending, or unsuccessful on the inspected head.', 'checks_not_passed');
        const effective = reviews.filter((review) => sameLogin(review.user?.login, reviewer) && ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review.state)).sort((a, b) => b.id - a.id)[0];
        const approved = effective?.state === 'APPROVED' && effective.commit_id === headSha;
        const merged = pr.merged === true;
        const mergeCommitSha = merged ? sha(pr.merge_commit_sha) : null;
        if (merged && !isDeepStrictEqual(await this.menuAt(baseMenuPath, mergeCommitSha), menu)) fail('The merged commit does not contain the exact inspected menu.');
        const current = await this.request('GET', path);
        this.validatePr(current, headSha, reviewer, expectedBaseRef);
        if (current.base.sha !== baseSha || current.merged !== pr.merged || current.merge_commit_sha !== pr.merge_commit_sha) fail('The pull request changed during verification. Inspect it again.', 'pr_changed');
        return {
            headSha, baseSha, baseRef: pr.base.ref, author: pr.user.login, reviewer, approved: !!approved, merged, mergeCommitSha,
            approvedForAttempt: !!(approved && marker && effective.body === marker),
            approvedAt: approved ? effective.submitted_at ?? null : null,
            checksPassed: true, menu, summary: [pr.title, pr.body].filter((text) => typeof text === 'string' && text.length).join('\n\n'), files, checks,
        };
    }

    async approve(prNumber, { headSha, expectedBaseRef, reviewer, approvalAttemptId }) {
        number(prNumber); sha(headSha); login(reviewer);
        if (!validBaseRef(expectedBaseRef)) fail('An explicit application base branch is required.', 'invalid_base_ref');
        const marker = approvalAttemptId === undefined ? null : approvalMarker(approvalAttemptId);
        const user = await this.request('GET', '/user');
        if (!sameLogin(user?.login, reviewer)) fail('The authenticated GitHub user must be the configured reviewer.');
        const path = `${this.root}/pulls/${prNumber}`;
        const pr = await this.request('GET', path);
        this.validatePr(pr, headSha, reviewer, expectedBaseRef);
        if (pr.merged) fail('The pull request is already merged.');
        const review = await this.request('POST', `${path}/reviews`, { commit_id: headSha, event: 'APPROVE', ...(marker ? { body: marker } : {}) });
        if (review?.state !== 'APPROVED' || review.commit_id !== headSha || !sameLogin(review.user?.login, reviewer) || (marker && review.body !== marker)) fail('GitHub did not confirm the pinned approval.');
        return review;
    }

    async merge(prNumber, { headSha, expectedBaseRef }) {
        number(prNumber); sha(headSha);
        if (!validBaseRef(expectedBaseRef)) fail('An explicit application base branch is required.', 'invalid_base_ref');
        const path = `${this.root}/pulls/${prNumber}`;
        const pr = await this.request('GET', path);
        this.validatePr(pr, headSha, undefined, expectedBaseRef);
        if (pr.merged) fail('The pull request is already merged.');
        const result = await this.request('PUT', `${path}/merge`, { sha: headSha });
        if (result?.merged !== true) fail('GitHub did not confirm the merge.');
        sha(result.sha);
        return result;
    }

    async upsertCompletionComment(issueNumber, runId, body, existingCommentId) {
        const marker = markerFor(runId);
        number(issueNumber);
        if (typeof body !== 'string' || !body.includes(marker) || body.split(marker).length !== 2 || body.length > 60_000) fail('The completion comment must contain its unique run marker.');
        if (existingCommentId !== undefined && existingCommentId !== null) number(existingCommentId);
        await this.readIssue(issueNumber);
        const user = await this.request('GET', '/user');
        login(user?.login);
        const comments = await this.pages(`${this.root}/issues/${issueNumber}/comments`);
        const matches = comments.filter((comment) => typeof comment.body === 'string' && comment.body.includes(marker));
        if (matches.some((comment) => !sameLogin(comment.user?.login, user.login)) || matches.length > 1) fail('Completion comment marker collision. No comment was changed.');
        const existing = matches[0];
        if (existingCommentId != null && existing?.id !== existingCommentId) fail('The persisted completion comment does not match the owned run marker.');
        if (existing?.body === body) return existing;
        return existing
            ? this.request('PATCH', `${this.root}/issues/comments/${number(existing.id)}`, { body })
            : this.request('POST', `${this.root}/issues/${issueNumber}/comments`, { body });
    }
}
