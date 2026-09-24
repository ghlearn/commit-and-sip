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

  function totals(state) {
    const list = $("admin-totals");
    list.replaceChildren();
    const s = state.summary;
    line(list, `Drinks invented: ${s.invented}`);
    line(list, `Attendees started: ${s.attendees}`);
    line(list, `Attendees finished: ${s.completed}`);
    line(list, `Drinks removed: ${s.removals}`);
    line(list, `House examples on the menu: ${s.examples}`);

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
      line(list, entry.example
        ? `${entry.name} - house example, not scored`
        : `${entry.name} - ${entry.score} points, barista ${entry.handle}`);
      if (entry.example) continue;
      const option = document.createElement("option");
      option.value = entry.id;
      option.textContent = `${entry.name} (${entry.handle})`;
      select.append(option);
    }
    if (chosen && invented.some(entry => entry.id === chosen)) select.value = chosen;
  }

  function removals(state) {
    const list = $("admin-removals");
    list.replaceChildren();
    $("admin-removals-empty").hidden = state.removals.length > 0;
    for (const record of state.removals) {
      line(list, `${record.name} - removed by ${record.removedBy} on ${new Date(record.removedAt).toLocaleString()} - ${record.reason}`);
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
    else if (state.notice.kind === "removed") box.textContent = `${state.notice.name} was removed from the house menu.`;
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
