// Host/public-address approval belongs to the server completion verifier, not the renderer.
function completionUrl(value) {
  if (typeof value !== "string" || value !== value.trim()) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.hash || (url.port && url.port !== "443")) return null;
    return url.href;
  } catch {
    return null;
  }
}

export function resultLinks(state) {
  if (state.mode !== "live" || state.phase !== "completed") return { leaderboardUrl: null, qrImageUrl: null };
  const leaderboardUrl = completionUrl(state.result?.leaderboardUrl);
  return { leaderboardUrl, qrImageUrl: leaderboardUrl ? completionUrl(state.result?.qrImageUrl) : null };
}
