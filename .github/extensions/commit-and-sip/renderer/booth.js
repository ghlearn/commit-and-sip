(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const ticket = new URLSearchParams(window.location.search).get("ticket");
  const VIEWS = ["idle", "naming", "served"];
  let busy = false;
  let phase = null;
  // The drink is published in the background, so the served screen keeps
  // checking until the event leaderboard has answered.
  let confirming = false;
  let populated = false;

  function fail(message) {
    $("booth-error-message").textContent = message;
    $("booth-error").hidden = false;
  }

  function controls() {
    $("booth").setAttribute("aria-busy", String(busy));
    $("begin").disabled = busy;
    $("name-fields").disabled = busy;
    $("finish").disabled = busy;
    $("booth-retry").disabled = busy || !ticket;
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
      catch { throw new Error(`The booth returned an unreadable response (HTTP ${response.status}). Refresh the connection.`); }
      if (!response.ok) throw new Error(data.error?.message || `The booth returned HTTP ${response.status}. Refresh the connection.`);
      return data;
    } catch (error) {
      if (error.name === "AbortError") throw new Error("The booth took too long to respond. Refresh the connection before trying again; your drink may already have been saved.");
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  function options(select, values, label) {
    for (const value of values) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label(value);
      select.append(option);
    }
  }

  const PLACEMENT_TEXT = {
    blend: "Blended into a word, like Monachino",
    end: "At the end, like Cold Brew Ducky",
    middle: "In the middle, like Iced Ducky Cup",
    start: "At the start, like Mona Mocha"
  };

  function fillMenu(state) {
    const menu = $("house-menu");
    menu.replaceChildren();
    for (const drink of state.houseMenu) {
      const item = document.createElement("li");
      const name = document.createElement("strong");
      name.textContent = drink.name;
      item.append(name, document.createTextNode(
        `${drink.example ? " - house example" : ""} - ${drink.serving}`));
      menu.append(item);
    }
    // Both lists are windowed by the engine. Say so where it is trimmed rather
    // than let the board imply the booth has served fewer people than it has.
    const shown = state.houseMenu.filter(drink => !drink.example).length;
    $("menu-note").textContent = shown < state.houseMenuTotal
      ? `The ${shown} most recent of ${state.houseMenuTotal} drinks invented at this booth.`
      : "Every drink invented at this booth.";
    const board = $("leaderboard");
    board.replaceChildren();
    $("board-empty").hidden = state.leaderboard.length > 0;
    const note = $("board-note");
    note.hidden = state.leaderboard.length >= state.leaderboardTotal;
    note.textContent = note.hidden ? ""
      : `Top ${state.leaderboard.length} of ${state.leaderboardTotal} scored drinks. Every drink is ranked against all of them.`;
    for (const row of state.leaderboard) {
      const item = document.createElement("li");
      const rank = document.createElement("span");
      rank.className = "entry-rank";
      rank.textContent = `#${row.rank}`;
      const main = document.createElement("span");
      main.className = "entry-main";
      const name = document.createElement("strong");
      name.textContent = row.name;
      const handle = document.createElement("small");
      handle.textContent = row.handle;
      main.append(name, handle);
      // Kept last so the scores form a column of their own to line up in. The
      // column has no header, so the word is carried for screen readers.
      const score = document.createElement("span");
      score.className = "entry-score";
      const unit = document.createElement("span");
      unit.className = "visually-hidden";
      unit.textContent = " points";
      score.append(String(row.score), unit);
      item.append(rank, main, score);
      board.append(item);
    }
  }

  function fillNaming(state) {
    if (!populated) {
      options($("pick-mascot"), state.mascots, value => value);
      options($("pick-placement"), state.placements, value => PLACEMENT_TEXT[value] ?? value);
      populated = true;
    }
    $("naming-handle").textContent = state.handle;
  }

  function fillServed(state) {
    // The heading is the largest text on the screen. Left alone it would
    // congratulate someone on being on a menu their drink was just taken off.
    $("served-heading").textContent = state.removed ? "This drink was removed." : "You're on the menu.";
    $("served-name").textContent = state.submission.name;
    $("served-score").textContent = String(state.submission.score);
    $("served-handle").textContent = state.handle;
    // Say "at this booth" explicitly. One booth cannot see what was invented
    // elsewhere, so an unqualified rank would read as an event-wide placing.
    $("served-standing").textContent = state.removed
      ? "removed from the menu by booth staff"
      : state.standing
        ? `rank ${state.standing.rank} of ${state.standing.entries} at this booth`
        : "rank pending";

    // The event standing is only ever what the leaderboard service confirmed.
    // A removed drink may still have a confirmed receipt from before staff
    // acted, and this booth cannot retract a published entry, so keep quiet
    // rather than keep advertising a rank the booth has repudiated. Getting it
    // out of the service is a staff job the takedown command spells out.
    const event = $("served-event");
    event.textContent = state.removed ? "" : state.sync?.message ?? "";
    event.hidden = !event.textContent;

    const list = $("served-breakdown");
    list.replaceChildren();
    for (const part of state.submission.breakdown) {
      const item = document.createElement("li");
      item.textContent = `${part.label}: ${part.points} of ${part.max}`
        + (part.detail?.length ? ` (${part.detail.join(", ")})` : "");
      list.append(item);
    }

    // A QR is shown only when the booth has a real configured destination and a
    // code was actually produced for it. Otherwise say so plainly.
    const holder = $("served-qr");
    holder.replaceChildren();
    if (state.qrDataUrl) {
      const image = document.createElement("img");
      image.src = state.qrDataUrl;
      // Intrinsic size of the encoded image; `.qr` scales it down for display.
      // Without that class the code renders at its full 320px and pushes the
      // hand-over button off a short booth panel.
      image.className = "qr";
      image.width = 320;
      image.height = 320;
      image.alt = `QR code linking to the leaderboard place for ${state.handle}`;
      holder.append(image);
    }
    $("served-qr-link").hidden = !state.attendeeUrl;
    if (state.attendeeUrl) {
      $("served-qr-anchor").href = state.attendeeUrl;
      $("served-qr-anchor").textContent = state.attendeeUrl;
    }
    // A removed drink has no leaderboard place, which is a different fact from
    // the event having no leaderboard at all. Do not let it read as the latter.
    $("served-qr-removed").hidden = !state.removed;
    $("served-qr-none").hidden = Boolean(state.attendeeUrl) || Boolean(state.removed);
  }

  function render(state) {
    phase = state.phase === "complete" ? "served" : state.phase;
    confirming = state.phase === "served" && state.sync?.state === "pending" && !state.removed;
    for (const view of VIEWS) $(`view-${view}`).hidden = view !== phase;
    fillMenu(state);
    if (phase === "naming") fillNaming(state);
    if (phase === "served") fillServed(state);
    if (phase === "idle") {
      $("idle-welcome").textContent = state.justCompleted
        ? `Thanks, ${state.justCompleted}. The counter is clear and ready for the next barista.`
        : "Step up and invent a coffee for the house menu.";
      $("name-problem").hidden = true;
      $("pick-name").value = "";
      $("name-form").reset();
    }
  }

  async function load(explicit = true) {
    if (busy) return;
    busy = true;
    controls();
    try {
      if (!ticket) throw new Error("This panel has no local connection ticket. Reopen Commit & Sip from the App.");
      render(await request("/api/state"));
      if (explicit) $("booth-error").hidden = true;
    } catch (error) {
      fail(error.message);
    } finally {
      busy = false;
      controls();
    }
  }

  async function act(action, input = {}) {
    if (busy) return;
    busy = true;
    controls();
    try {
      render(await request("/api/action", { action, input }));
      $("booth-error").hidden = true;
      return true;
    } catch (error) {
      fail(error.message);
      return false;
    } finally {
      busy = false;
      controls();
    }
  }

  $("booth-retry").addEventListener("click", () => void load());
  $("begin").addEventListener("click", () => void act("begin"));
  $("finish").addEventListener("click", () => void act("complete"));

  $("name-form").addEventListener("submit", async event => {
    event.preventDefault();
    if (busy || !$("name-form").reportValidity()) return;
    const mascot = $("pick-mascot").value;
    const placement = $("pick-placement").value;
    $("name-problem").hidden = true;
    busy = true;
    controls();
    try {
      render(await request("/api/action", {
        action: "submit_name",
        // Both pickers are claims the attendee opted into. Sending a default
      // would reject a typed ducky name for a mona the attendee never chose.
      input: {
        name: $("pick-name").value,
        ...(mascot ? { mascot } : {}),
        ...(placement ? { placement } : {})
      }
      }));
    } catch (error) {
      // A refused name costs the attendee nothing, so keep them on this screen
      // with what they typed rather than sending them back to the counter.
      $("name-problem").textContent = error.message;
      $("name-problem").hidden = false;
    } finally {
      busy = false;
      controls();
    }
  });

  void load();
  window.setInterval(() => {
    // Keep the menu and leaderboard current between attendees without
    // interrupting anyone mid-typing.
    if (!document.hidden && (phase === "idle" || confirming)) void load(false);
  }, 5000);
})();
