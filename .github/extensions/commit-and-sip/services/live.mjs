import { DomainError, requireValue } from "../domain.mjs";
import { GithubAdapter, GithubError } from "./github.mjs";
import { CompletionClient, CompletionError } from "./completion.mjs";

export async function serviceCall(fn) {
  try { return await fn(); }
  catch (error) {
    if (error instanceof GithubError) throw new DomainError("github_verification", error.message);
    if (error instanceof CompletionError) throw new DomainError("completion_verification", error.message, 503);
    throw error;
  }
}

export function liveAdapters(config, credential) {
  const adapter = new GithubAdapter({ repo: config.repo });
  const github = Object.fromEntries(
    ["readIssue", "inspectPullRequest", "approve", "merge", "upsertCompletionComment"].map(method =>
      [method, (...args) => serviceCall(() => adapter[method](...args))])
  );
  return {
    github,
    completion: {
      finish: run => serviceCall(async () => {
        requireValue(config.completionEndpoint && config.leaderboardUrl && config.qrImageUrl &&
          Array.isArray(config.approvedQrOrigins) && config.approvedQrOrigins.length,
        "completion_unconfigured", "Staff must configure the authenticated completion endpoint, public leaderboard, QR URL and approved QR origin.");
        requireValue(credential, "completion_credentials", "The completion service credential has not been granted to this extension.");
        const client = new CompletionClient({
          url: config.completionEndpoint, leaderboardUrl: config.leaderboardUrl,
          qrImageUrl: config.qrImageUrl, approvedQrOrigins: config.approvedQrOrigins, credential
        });
        const result = await client.submitResult({ runId: run.runId, handle: run.handle });
        run.handle = result.handle;
        run.commentId = result.commentId;
        requireValue(Number.isSafeInteger(run.commentId) && run.commentId > 0,
          "comment_unverified", "The completion authority did not confirm the final issue comment. Retry the same run.");
        return result;
      })
    }
  };
}
