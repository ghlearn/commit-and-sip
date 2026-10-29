// Polls the board and renders it. Attendee text is only ever assigned through
// textContent: nothing here parses a string as HTML.
//
// The board is shown on a monitor all day over conference wifi. When a
// refresh fails it keeps the last good board and says how old it is, so a
// dropped connection produces a visibly stale board, never a silently wrong one.
//
// Each poll is bounded by a timeout and the next is scheduled only once it
// settles, so a stalled network cannot pile up requests for the rest of the day.
//
// Screen readers hear only transitions: the board loading, going stale,
// recovering, and the attendee's own place changing. The clock and the table
// update silently, or a screen reader would announce them every ten seconds.

const REFRESH_MS = 10_000;
const REQUEST_TIMEOUT_MS = 8_000;
const STALE_AFTER_MS = 30_000;

const params = new URLSearchParams(location.search);
// A handle identifies nobody on its own: another booth may have issued the
// same phrase, so the service never personalises on it alone. Only a link
// carrying the opaque publication reference as well is about one drink; a
// handle-only link (an old or hand-shared one) shows the plain board and
// makes no claim about anyone's drink.
const personal = params.get("handle") && params.get("ref")
  ? { handle: params.get("handle"), ref: params.get("ref") } : null;
const time = date => date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const $ = id => document.getElementById(id);

let lastGood = null;
let announced = null;

function cell(tag, text, className) {
  const element = document.createElement(tag);
  element.textContent = text;
  if (className) element.className = className;
  return element;
}

// Writes only when the text differs, so an unchanged value is not re-announced
// or re-laid-out on every poll.
function setText(element, text) {
  if (element.textContent !== text) element.textContent = text;
}

function announce(message) {
  if (message === announced) return;
  announced = message;
  $("announce").textContent = message;
}

// When the leader's drink reached the board, with the date as well if that was
// not today, so a monitor left on overnight never passes off yesterday's time
// as today's. Null for anything that is not a time.
function enteredText(value) {
  const date = new Date(value);
  if (typeof value !== "string" || Number.isNaN(date.getTime())) return null;
  const clock = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return date.toDateString() === new Date().toDateString()
    ? `Entered ${clock}`
    : `Entered ${date.toLocaleDateString([], { month: "short", day: "numeric" })}, ${clock}`;
}

function render(board) {
  const rows = board.entries.map(entry => {
    const row = document.createElement("tr");
    // Only the row the service identified, never every row sharing a phrase.
    const mine = board.you && entry.handle === board.you.handle && entry.name === board.you.name;
    // First place. No two drinks share a place, and a tied score goes to the
    // drink that reached the board first, so the leader carries its entry time.
    const leader = entry.rank === 1;
    const classes = [mine && "mine", leader && "leader"].filter(Boolean).join(" ");
    if (classes) row.className = classes;
    const rank = cell("th", String(entry.rank));
    rank.scope = "row";
    const drink = cell("td", entry.name, "drink");
    if (leader) {
      drink.append(" ", cell("span", "Leader", "leader-badge"));
      const entered = enteredText(board.leaderEnteredAt);
      if (entered) drink.append(" ", cell("span", entered, "entered"));
    }
    row.append(rank, drink, cell("td", entry.handle, "handle"), cell("td", entry.score.toLocaleString(), "num"));
    return row;
  });
  $("rows").replaceChildren(...rows);
  $("board").hidden = rows.length === 0;
  $("empty").hidden = rows.length !== 0;
  // An empty board being rebuilt is not inviting anyone: drinks are held.
  setText($("empty"), board.rebuilding
    ? "The board is being rebuilt. Drinks reappear as the booths send them again."
    : "No drinks yet. Be the first to name one at the booth.");
  // Drinks on the board now, so a takedown lowers it. The all-time captured
  // tally stays in the API for staff. Updated silently: it changes on every
  // new drink and is not news to a screen reader each time.
  if (Number.isSafeInteger(board.total)) {
    setText($("drink-count"), board.total.toLocaleString());
    setText($("drink-count-label"), board.total === 1 ? "drink name on the board" : "drink names on the board");
    $("drink-count").parentElement.hidden = false;
  }
  setText($("caption"), board.rebuilding
    ? "The board is being rebuilt. Drinks reappear as the booths send them again."
    : board.total > board.entries.length
    ? `Top ${board.entries.length} of ${board.total} drinks. A tied score goes to the drink that reached the board first.`
    : `${board.total} ${board.total === 1 ? "drink" : "drinks"}. A tied score goes to the drink that reached the board first.`);

  const you = $("you");
  if (personal && board.you) {
    const text = `Your drink, ${board.you.name}, is ranked ${board.you.rank} of ${board.total}.`;
    setText(you, text);
    you.hidden = false;
    announce(text);
  } else if (personal && board.you === null) {
    const text = "Your drink is not on the board. Booth staff may have removed it, or it has not arrived yet.";
    setText(you, text);
    you.hidden = false;
    announce(text);
  } else {
    you.hidden = true;
  }
}

function showStatus() {
  const status = $("status");
  if (!lastGood) {
    setText(status, "The board is not reachable yet. Retrying…");
    status.className = "status stale";
    announce("The board is not reachable yet.");
    return;
  }
  const stale = Date.now() - lastGood.getTime() > STALE_AFTER_MS;
  setText(status, stale ? `Offline. Showing the board as it was at ${time(lastGood)}.` : `Updated ${time(lastGood)}`);
  status.className = stale ? "status stale" : "status";
  if (stale) announce(`The board is offline. It was last updated at ${time(lastGood)}.`);
  else if (!personal) announce("The leaderboard is up to date.");
}

async function refresh() {
  try {
    const query = personal
      ? `?handle=${encodeURIComponent(personal.handle)}&ref=${encodeURIComponent(personal.ref)}`
      : "";
    const response = await fetch(`/api/board${query}`, { cache: "no-store", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!response.ok) throw new Error(String(response.status));
    render(await response.json());
    lastGood = new Date();
  } catch {
    // Keep whatever is on screen; showStatus says how old it is.
  }
  showStatus();
  setTimeout(refresh, REFRESH_MS);
}

refresh();
// Ticks the "offline" wording forward even while a request is outstanding.
setInterval(showStatus, 5_000);
