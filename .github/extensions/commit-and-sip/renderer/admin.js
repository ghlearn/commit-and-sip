(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const ticket = new URLSearchParams(window.location.search).get("ticket");
  let busy = false;

  function fail(message) {
    $("admin-error-message").textContent = message;
    $("admin-error").hidden = false;
  }

  function controls() {
    $("admin").setAttribute("aria-busy", String(busy));
    for (const id of ["export-fields", "takedown-fields", "wipe-fields", "close-fields"]) $(id).disabled = busy;
    $("admin-retry").disabled = busy || !ticket;
  }

  async function request(path, body) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(path, {
        method: body ? "POST" : "GET",
        headers: { Authorization: `Bearer ${ticket}`, ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        credentials: "omit", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer", signal: controller.signal
      });
      let data;
      try { data = await response.json(); }
      catch { throw new Error(`The booth returned an unreadable response (HTTP ${response.status}).`); }
      if (!response.ok) throw new Error(data.error?.message || `The booth returned HTTP ${response.status}.`);
      return data;
    } catch (error) {
      if (error.name === "AbortError") throw new Error("The booth took too long to respond. Refresh and check what actually happened before retrying.");
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  function line(list, text) {
    const item = document.createElement("li");
    item.textContent = text;
    list.append(item);
    return item;
  }

  function stat(list, label, value) {
    const item = document.createElement("li");
    const text = document.createElement("span");
    text.textContent = label;
    const figure = document.createElement("span");
    figure.className = "total-value";
    figure.textContent = value;
    item.append(text, figure);
    list.append(item);
    return item;
  }

  // A house example has no score. The dash keeps the column from looking like
  // missing data, and is hidden from assistive technology because "house
  // example, not scored" already says it in the note, where it reads as a
  // sentence rather than a stray punctuation mark.
  function drink(list, entry) {
    const item = document.createElement("li");
    const main = document.createElement("span");
    main.className = "entry-main";
    const name = document.createElement("strong");
    name.textContent = entry.name;
    const note = document.createElement("small");
    note.textContent = entry.example ? "house example, not scored" : `barista ${entry.handle}`;
    main.append(name, note);
    const score = document.createElement("span");
    score.className = "entry-score";
    if (entry.example) {
      score.textContent = "\u2014";
      score.setAttribute("aria-hidden", "true");
    } else {
      score.append(String(entry.score), unit(" points"));
    }
    item.append(main, score);
    list.append(item);
    return item;
  }

  // The column has no header, so sighted staff read "points" from context. Carry
  // the word for screen readers rather than dropping it from the row text.
  function unit(text) {
    const span = document.createElement("span");
    span.className = "visually-hidden";
    span.textContent = text;
    return span;
  }

  function totals(state) {
    const list = $("admin-totals");
    list.replaceChildren();
    const s = state.summary;
    stat(list, "Drinks invented", s.invented);
    stat(list, "Attendees started", s.attendees);
    stat(list, "Attendees finished", s.completed);
    stat(list, "Drinks removed", s.removals);
    stat(list, "House examples on the menu", s.examples);

    // Wiping under an attendee would delete the drink on the screen in front of
    // them, so say who is still mid-order rather than only failing later.
    const active = $("admin-active");
    if (s.active.length) {
      active.textContent = s.active.length === 1
        ? `One station still has an attendee (${s.active[0].handle}). The event cannot be archived until every order is finished or handed over.`
        : `${s.active.length} stations still have an attendee. The event cannot be archived until every order is finished or handed over.`;
      active.hidden = false;
    } else {
      active.hidden = true;
    }
  }

  function stations(state) {
    const list = $("admin-stations");
    const select = $("close-run");
    const chosen = select.value;
    list.replaceChildren();
    select.replaceChildren();
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Choose a station";
    select.append(placeholder);
    const open = state.summary.active;
    $("stations-section").hidden = open.length === 0;
    for (const run of open) {
      line(list, `${run.handle} - ${run.phase === "naming" ? "still inventing a drink" : "served, not handed over"}`);
      const option = document.createElement("option");
      option.value = run.runId;
      option.textContent = `${run.handle} (${run.phase})`;
      select.append(option);
    }
    if (chosen && open.some(run => run.runId === chosen)) select.value = chosen;
  }

  function health(state) {
    const list = $("admin-health");
    list.replaceChildren();
    // The blocklist warning is repeated here because the extension log it is
    // otherwise reported in is not something staff watch during an event.
    line(list, state.blocklist.ready
      ? "Moderation blocklist: reviewed and ready."
      : `Moderation blocklist: NOT event-ready. ${state.blocklist.reason}`);
    line(list, state.leaderboardUrl
      ? `Event leaderboard: configured (${state.leaderboardUrl}).`
      : "Event leaderboard: not configured. Attendees are told there is nothing to scan.");
  }

  function menu(state) {
    const list = $("admin-menu");
    const select = $("takedown-id");
    const chosen = select.value;
    list.replaceChildren();
    select.replaceChildren();
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Choose a drink";
    select.append(placeholder);

    const invented = state.houseMenu.filter(entry => !entry.example);
    $("admin-menu-empty").hidden = invented.length > 0;
    for (const entry of state.houseMenu) {
      drink(list, entry);
      if (entry.example) continue;
      const option = document.createElement("option");
      option.value = entry.id;
      option.textContent = `${entry.name} (${entry.handle})`;
      select.append(option);
    }
    if (chosen && invented.some(entry => entry.id === chosen)) select.value = chosen;
  }

  // A takedown that did not reach the public board must not read as done.
  const PUBLIC_BOARD = {
    absent: "was not on the public leaderboard",
    failed: "is NOT yet off the public leaderboard. Refresh to retry",
    "in-doubt": "may still be on the public leaderboard: it was still being published when it was taken down. Refresh to retry",
    "not-configured": "is NOT off the public leaderboard: this booth has no staff key. To finish it, copy the deployed keys to this machine with npm run leaderboard:configure -- --url <url> --from <an owner-only (chmod 600) copy of a staff machine's booth/local-config.json>, then delete that copy, then retry with Refresh",
    retracted: "was taken off the public leaderboard",
    unrecorded: "may still be on the public leaderboard: the removal stopped before it reached the board. Refresh to retry",
  };

  // Settled outcomes are always shown. An unsettled one is a warning only when
  // the drink may be public (`owed`, decided by the booth); a drink that was
  // never published owes nothing and gets no false alarm. A removal whose
  // outcome was never recorded is unresolved, not fine.
  function boardStatus({ owed, published }) {
    if (published === "retracted" || published === "absent") return PUBLIC_BOARD[published];
    if (!owed) return "";
    return PUBLIC_BOARD[published] ?? PUBLIC_BOARD.unrecorded;
  }

  function removals(state) {
    const list = $("admin-removals");
    list.replaceChildren();
    $("admin-removals-empty").hidden = state.removals.length > 0;
    for (const record of state.removals) {
      const board = boardStatus(record);
      line(list, `${record.name} - removed by ${record.removedBy} on ${new Date(record.removedAt).toLocaleString()} - ${record.reason}${board ? ` - ${board}` : ""}`);
    }
  }

  function archives(state) {
    const list = $("admin-archives");
    list.replaceChildren();
    $("admin-archives-empty").hidden = state.archives.length > 0;
    $("admin-directory").textContent = `Saved under ${state.dataDirectory}/exports`;
    for (const name of state.archives) line(list, name);
  }

  function notice(state) {
    const box = $("admin-notice");
    if (!state.notice) { box.hidden = true; return; }
    if (state.notice.kind === "closed") box.textContent = `Station ${state.notice.handle} was closed.`;
    else if (state.notice.kind === "exported") box.textContent = `Results exported to ${state.notice.path}`;
    else if (state.notice.kind === "removed") {
      const board = boardStatus(state.notice);
      box.textContent = `${state.notice.name} was removed from the house menu${board ? ` and ${board}` : ""}.`;
    }
    else if (state.notice.kind === "wiped") {
      box.textContent = `Event archived to ${state.notice.archive} and the booth was reset. ${state.notice.was.invented} drink(s) and ${state.notice.was.removals} removal(s) are in that file and nowhere else. Copy it off this machine.`;
    }
    box.hidden = false;
  }

  function render(state) {
    totals(state);
    stations(state);
    health(state);
    menu(state);
    removals(state);
    archives(state);
    notice(state);
  }

  async function load() {
    busy = true; controls();
    try {
      render(await request("/api/state"));
      $("admin-error").hidden = true;
    } catch (error) {
      fail(error.message);
    } finally {
      busy = false; controls();
    }
  }

  async function act(action, input, problemId) {
    const problem = problemId ? $(problemId) : null;
    if (problem) problem.hidden = true;
    busy = true; controls();
    try {
      render(await request("/api/action", { action, input }));
      $("admin-error").hidden = true;
      return true;
    } catch (error) {
      if (problem) { problem.textContent = error.message; problem.hidden = false; }
      else fail(error.message);
      return false;
    } finally {
      busy = false; controls();
    }
  }

  $("admin-retry").addEventListener("click", load);

  $("export-form").addEventListener("submit", async event => {
    event.preventDefault();
    const exportedBy = $("export-by").value.trim();
    if (!exportedBy) return;
    await act("export_results", { exportedBy });
  });

  $("takedown-form").addEventListener("submit", async event => {
    event.preventDefault();
    const id = $("takedown-id").value;
    const removedBy = $("takedown-by").value.trim();
    const reason = $("takedown-reason").value.trim();
    if (!id) {
      const problem = $("takedown-problem");
      problem.textContent = "Choose which drink to remove.";
      problem.hidden = false;
      return;
    }
    if (!removedBy || !reason) return;
    if (await act("remove_drink", { id, reason, removedBy }, "takedown-problem")) {
      $("takedown-reason").value = "";
    }
  });

  $("close-form").addEventListener("submit", async event => {
    event.preventDefault();
    const runId = $("close-run").value;
    const closedBy = $("close-by").value.trim();
    if (!runId) {
      const problem = $("close-problem");
      problem.textContent = "Choose which station to close.";
      problem.hidden = false;
      return;
    }
    if (!closedBy) return;
    await act("close_station", { runId, closedBy }, "close-problem");
  });

  $("wipe-form").addEventListener("submit", async event => {
    event.preventDefault();
    const archivedBy = $("wipe-by").value.trim();
    const confirm = $("wipe-confirm").value.trim();
    if (!archivedBy || !confirm) return;
    if (await act("archive_and_wipe", { archivedBy, confirm }, "wipe-problem")) {
      $("wipe-confirm").value = "";
    }
  });

  if (!ticket) fail("This dashboard lost its local connection. Reopen it from the Copilot App.");
  else load();
})();
