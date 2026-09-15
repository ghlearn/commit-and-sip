(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const ticket = new URLSearchParams(window.location.search).get("ticket");
  let suggestedRunId = "";
  let ready = false;
  let initialized = false;
  let busy = false;

  function controls() {
    $("setup").setAttribute("aria-busy", String(busy));
    $("setup-fields").disabled = busy || !ready;
    $("setup-retry").disabled = busy || !ticket;
  }

  function fail(error) {
    $("setup-error-message").textContent = error.message;
    $("setup-error").hidden = false;
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
      if (error.name === "AbortError") throw new Error("The booth took too long to respond. Refresh the connection before trying again; your selection may have been saved.");
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  function selection() {
    const resume = $("setup-operation").value === "resume";
    $("setup-order-field").hidden = resume;
    $("setup-order").disabled = resume;
    $("setup-order").required = !resume;
    $("setup-run").value = resume ? "" : suggestedRunId;
    $("setup-submit").textContent = resume ? "Resume saved rehearsal" : "Create new rehearsal";
  }

  async function load(explicit = true) {
    if (busy) return;
    busy = true;
    controls();
    try {
      if (!ticket) throw new Error("This panel has no local connection ticket. Reopen Commit & Sip from the App.");
      const state = await request("/api/state");
      if (state.runId) { window.location.reload(); return; }
      if (state.phase !== "setup" || !Array.isArray(state.orders) || !state.orders.length || typeof state.suggestedRunId !== "string") {
        throw new Error("The booth returned an invalid setup state. Ask staff to inspect the extension.");
      }
      if (!initialized) {
        for (const order of state.orders) {
          const option = document.createElement("option");
          option.value = order.id;
          option.textContent = order.name;
          $("setup-order").append(option);
        }
        suggestedRunId = state.suggestedRunId;
        selection();
        initialized = true;
      }
      ready = true;
      $("setup-status").textContent = "Ready. No run has been selected yet.";
      if (explicit) $("setup-error").hidden = true;
    } catch (error) {
      ready = false;
      fail(error);
    } finally {
      busy = false;
      controls();
    }
  }

  $("setup-operation").addEventListener("change", selection);
  $("setup-retry").addEventListener("click", () => void load());
  $("setup-form").addEventListener("submit", async event => {
    event.preventDefault();
    if (busy || !ready || !$("setup-form").reportValidity()) return;
    const operation = $("setup-operation").value;
    const input = {
      operation, runId: $("setup-run").value, mode: "rehearsal",
      ...(operation === "new" ? { orderId: $("setup-order").value } : {})
    };
    busy = true;
    controls();
    try {
      const state = await request("/api/action", { action: "select_run", input });
      if (state.runId !== input.runId || state.mode !== "rehearsal") throw new Error("The selected run was not confirmed. Refresh the connection before trying again.");
      window.location.reload();
    } catch (error) {
      fail(error);
    } finally {
      busy = false;
      controls();
    }
  });
  void load();
  window.setInterval(() => {
    if (ready && !document.hidden) void load(false);
  }, 3000);
})();
