import { requireValue } from "../domain.mjs";
import { publicFetch, validateLeaderboardUrl } from "./public-url.mjs";

// The booth's HTTP client for the event leaderboard service in
// leaderboard-service/. It owns its own timeout, because a booth queue must
// never wait on conference wifi: the drink is already durable locally, and a
// failed publish is retried on the next refresh.
//
// Two keys, two capabilities. The booth key can only publish. The staff key
// can only retract, and a booth machine that should not take drinks down is
// simply configured without one.

const MIN_KEY_LENGTH = 32;

export function validateLeaderboardApi(api) {
  requireValue(api !== null && typeof api === "object" && !Array.isArray(api),
    "invalid_config", "leaderboardApi must be an object with url and boothKey.", 400);
  const allowed = ["boothKey", "staffKey", "url"];
  const unknown = Object.keys(api).filter(key => !allowed.includes(key));
  requireValue(unknown.length === 0, "invalid_config", `Unknown leaderboardApi settings: ${unknown.join(", ")}.`, 400);
  // The same rule the QR destination uses: a genuinely public HTTPS address.
  try { validateLeaderboardUrl(api.url); }
  catch { requireValue(false, "invalid_config", "leaderboardApi.url must be a public HTTPS address.", 400); }
  // The service answers at its root. A path here would be silently dropped
  // or, worse, prefixed onto every route, and the booth would never sync.
  const parsed = new URL(api.url);
  requireValue(parsed.pathname === "/" && !parsed.search,
    "invalid_config", `leaderboardApi.url must be the service's origin only, such as ${parsed.origin}.`, 400);
  for (const name of ["boothKey", "staffKey"]) {
    if (name === "staffKey" && api.staffKey === undefined) continue;
    requireValue(typeof api[name] === "string" && api[name].length >= MIN_KEY_LENGTH,
      "invalid_config", `leaderboardApi.${name} must be at least ${MIN_KEY_LENGTH} characters.`, 400);
  }
  requireValue(api.staffKey === undefined || api.staffKey !== api.boothKey,
    "invalid_config", "leaderboardApi.boothKey and staffKey must differ.", 400);
  return api;
}

// Carries the service's error code, so the booth can tell a refusal that
// retrying cannot change from a transport failure that it can.
async function failure(response, verb) {
  let code = "unknown";
  try { code = (await response.json()).error ?? code; } catch { /* the status is enough */ }
  return Object.assign(new Error(`The leaderboard ${verb} failed: ${response.status} ${code}.`),
    { code, status: response.status });
}

export function createLeaderboardClient({ url, boothKey, staffKey = null, timeoutMs = 4000, fetchImpl = globalThis.fetch }) {
  // Routes are absolute from the origin, whatever path the URL carries.
  const endpoint = path => new URL(`/${path}`, new URL(url).origin).toString();
  const client = {
    // Which board the service is serving now, and how much is on it. A
    // rebuild records the ID with its takedown phase, so a later replacement
    // board is not mistaken for it.
    async board() {
      const response = await fetchImpl(endpoint("api/board"), { method: "GET", signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) throw await failure(response, "board read");
      const body = await response.json();
      if (typeof body?.boardId !== "string" || !/^[0-9a-f]{32}$/.test(body.boardId)) {
        throw Object.assign(new Error("The leaderboard did not say which board it is serving."), { code: "unexpected_response" });
      }
      const count = value => (Number.isSafeInteger(value) && value >= 0 ? value : null);
      return { boardId: body.boardId, captured: count(body.captured), rebuilding: body.rebuilding === true, total: count(body.total) };
    },
    async boardId() { return (await client.board()).boardId; },
    async publish(submission) {
      const response = await fetchImpl(endpoint("api/entries"), {
        body: JSON.stringify(submission),
        headers: { Authorization: `Bearer ${boothKey}`, "Content-Type": "application/json" },
        method: "POST", signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw await failure(response, "submission");
      return response.json();
    },
  };
  if (staffKey) {
    // "absent" is a success: the entry was never published, or an earlier
    // retract already took it down. Either way it is not on the public board.
    // The drink ID travels in the authenticated body on a fixed route, never
    // in the URL: web-server logs record request paths, and a removed name
    // must leave no readable trace on the service.
    client.retract = async id => {
      const response = await fetchImpl(endpoint("api/retractions"), {
        body: JSON.stringify({ id }),
        headers: { Authorization: `Bearer ${staffKey}`, "Content-Type": "application/json" },
        method: "POST", signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status === 204) return "retracted";
      // Only the service's own answer settles a takedown as absent. Any other
      // response, a 404 above all, proves nothing about the entry and is a
      // failure that is retried.
      if (response.status === 200) {
        let body = null;
        try { body = await response.json(); } catch { /* not the service's answer */ }
        if (body?.retraction === "absent") return "absent";
        throw Object.assign(new Error("The leaderboard retraction failed: 200 unexpected_response."),
          { code: "unexpected_response", status: 200 });
      }
      throw await failure(response, "retraction");
    };
    // Opens a board created closed for a rebuild. Only a staff machine can.
    client.openBoard = async () => {
      const response = await fetchImpl(endpoint("api/board/open"), {
        body: JSON.stringify({ open: true }),
        headers: { Authorization: `Bearer ${staffKey}`, "Content-Type": "application/json" },
        method: "POST", signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status !== 200) throw await failure(response, "opening");
    };
    // Empties the whole public board, for every booth. It names the board
    // staff checked; the service refuses any other with "board_changed".
    client.clearBoard = async boardId => {
      const response = await fetchImpl(endpoint("api/board/clear"), {
        body: JSON.stringify({ boardId }),
        headers: { Authorization: `Bearer ${staffKey}`, "Content-Type": "application/json" },
        method: "POST", signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status !== 200) throw await failure(response, "clear");
      const body = await response.json();
      if (typeof body?.boardId !== "string" || !/^[0-9a-f]{32}$/.test(body.boardId) || body.boardId === boardId) {
        throw Object.assign(new Error("The leaderboard did not confirm the clear."), { code: "unexpected_response", status: 200 });
      }
      return body;
    };
  }
  return client;
}

// Production traffic goes through publicFetch, which pins DNS to public
// addresses at socket creation, so a hostile or hijacked record cannot turn
// the configured service into a request against the booth's own network.
// Only an absent `leaderboardApi` means "not configured". A present but
// malformed value (null, "", false) is an error, not a quiet way to switch
// publishing off.
export function leaderboardClientFromConfig(config) {
  if (config?.leaderboardApi === undefined) return null;
  return createLeaderboardClient({ ...validateLeaderboardApi(config.leaderboardApi), fetchImpl: publicFetch });
}
