import { requireValue } from "../domain.mjs";
import { prepareCompletionComment } from "./completion.mjs";

export class IssueCompletionWriter {
  constructor({ github, leaderboardUrl, qrImageUrl, approvedQrOrigins, network }) {
    Object.assign(this, { github, leaderboardUrl, qrImageUrl, approvedQrOrigins, network });
  }

  async write(issueNumber, receipt) {
    const body = await prepareCompletionComment({
      receipt, leaderboardUrl: this.leaderboardUrl,
      qrImageUrl: this.qrImageUrl, approvedQrOrigins: this.approvedQrOrigins
    }, this.network);
    const comment = await this.github.upsertCompletionComment(issueNumber, receipt.runId, body, receipt.commentId);
    requireValue(comment && Number.isSafeInteger(comment.id) && comment.id > 0 && comment.body === body,
      "comment_unverified", "GitHub did not confirm the exact final exercise-issue comment. Retry the same run.");
    return comment.id;
  }
}
