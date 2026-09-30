// Polls the board and renders it. Attendee text is only ever assigned through
// textContent: nothing here parses a string as HTML.
//
// The board is shown on a monitor all day over conference wifi. When a
// refresh fails it keeps the last good board and says how old it is, so a
// dropped connection produces a visibly stale board, never a silently wrong one.

const REFRESH_MS = 10_000;
const STALE_AFTER_MS = 30_000;

const params = new URLSearchParams(location.search);
const handle = params.get("handle");
const drink = params.get("drink");
const time = date => date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const $ = id => document.getElementById(id);

let lastGood = null;

function cell(tag, text, className) {
  const element = document.createElement(tag);
  element.textContent = text;
  if (className) element.className = className;
  return element;
}

function render(board) {
  const rows = board.entries.map(entry => {
    const row = document.createElement("tr");
    // Only the row the service identified, never every row sharing a phrase.
    if (board.you && entry.handle === board.you.handle && entry.name === board.you.name) row.className = "mine";
    const rank = cell("th", String(entry.rank));
    rank.scope = "row";
    row.append(rank, cell("td", entry.name, "drink"), cell("td", entry.handle, "handle"),
      cell("td", entry.score.toLocaleString(), "num"));
    return row;
  });
  $("rows").replaceChildren(...rows);
  $("board").hidden = rows.length === 0;
  $("empty").hidden = rows.length !== 0;
  $("caption").textContent = board.total > board.entries.length
    ? `Top ${board.entries.length} of ${board.total} drinks. Equal scores share a rank.`
    : `${board.total} ${board.total === 1 ? "drink" : "drinks"}. Equal scores share a rank.`;

  const you = $("you");
  if (handle && board.you) {
    you.textContent = `Your drink, ${board.you.name}, is ranked ${board.you.rank} of ${board.total}.`;
    you.hidden = false;
  } else if (handle && board.you === null) {
    you.textContent = "Your drink is not on the board. Booth staff may have removed it, or it has not arrived yet.";
    you.hidden = false;
  } else {
    you.hidden = true;
  }
}

function showStatus() {
  const status = $("status");
  if (!lastGood) {
    status.textContent = "The board is not reachable yet. Retrying…";
    status.className = "status stale";
    return;
  }
  const age = Date.now() - lastGood.getTime();
  const stale = age > STALE_AFTER_MS;
  status.textContent = stale
    ? `Offline. Showing the board as it was at ${time(lastGood)}.`
    : `Updated ${time(lastGood)}`;
  status.className = stale ? "status stale" : "status";
}

async function refresh() {
  try {
    const query = handle
      ? `?handle=${encodeURIComponent(handle)}${drink ? `&drink=${encodeURIComponent(drink)}` : ""}`
      : "";
    const response = await fetch(`/api/board${query}`, { cache: "no-store" });
    if (!response.ok) throw new Error(String(response.status));
    render(await response.json());
    lastGood = new Date();
  } catch {
    // Keep whatever is on screen; showStatus says how old it is.
  }
  showStatus();
}

refresh();
setInterval(refresh, REFRESH_MS);
// Ticks the "offline" wording forward even when no request is completing.
setInterval(showStatus, 5_000);
