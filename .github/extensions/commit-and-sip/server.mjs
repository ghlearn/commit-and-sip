import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { DomainError, exactInput, requireValue } from "./domain.mjs";
import { PanelRun } from "./panel.mjs";

const assets = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/launcher.js", ["launcher.js", "text/javascript; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/result-links.mjs", ["result-links.mjs", "text/javascript; charset=utf-8"]],
  ["/style.css", ["style.css", "text/css; charset=utf-8"]]
]);

function authorized(request, ticket) {
  const value = Buffer.from(request.headers.authorization ?? "");
  const expected = Buffer.from(`Bearer ${ticket}`);
  return value.length === expected.length && timingSafeEqual(value, expected);
}

async function bodyJSON(request) {
  requireValue(request.headers["content-type"] === "application/json",
    "content_type", "Actions require application/json.", 415);
  let body = "";
  for await (const chunk of request) {
    body += chunk.toString("utf8");
    requireValue(Buffer.byteLength(body) <= 8192, "body_too_large", "Action input is too large.", 413);
  }
  try { return JSON.parse(body); }
  catch { throw new DomainError("invalid_json", "Action input must be valid JSON.", 400); }
}

export async function startServer({ engine, runId, reportError = () => {} }) {
  const panel = new PanelRun(engine, runId);
  const ticket = randomBytes(32).toString("hex");
  let origin;
  const server = createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Content-Security-Policy",
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: https:; connect-src 'self'; base-uri 'none'; form-action 'none'");
    const json = (status, value) => {
      response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(value));
    };
    try {
      requireValue(request.headers.host === new URL(origin).host,
        "host_rejected", "Unrecognized loopback host.", 403);
      const url = new URL(request.url, origin);
      if (request.method === "GET" && assets.has(url.pathname)) {
        let [file, type] = assets.get(url.pathname);
        if (url.pathname === "/" && !panel.runId) file = "launcher.html";
        const bytes = await readFile(new URL(`renderer/${file}`, import.meta.url));
        response.writeHead(200, { "Content-Type": type });
        response.end(bytes);
        return;
      }
      requireValue(authorized(request, ticket), "unauthorized", "Reopen this canvas to restore its local connection.", 401);
      requireValue(!request.headers.origin || request.headers.origin === origin,
        "origin_rejected", "Cross-origin access is not allowed.", 403);
      if (url.pathname === "/api/state" && request.method === "GET") {
        json(200, await panel.get());
      } else if (url.pathname === "/api/action" && request.method === "POST") {
        requireValue(request.headers.origin === origin, "origin_required", "Actions require a same-origin request.", 403);
        const body = await bodyJSON(request);
        exactInput(body, ["action", "input"]);
        requireValue(typeof body.action === "string", "invalid_action", "Choose a supported action.", 400);
        json(200, await panel.dispatch(body.action, body.input ?? {}));
      } else {
        throw new DomainError("not_found", "This canvas endpoint does not exist.", 404);
      }
    } catch (error) {
      const known = error instanceof DomainError;
      if (!known) reportError(error);
      if (!response.headersSent) json(known ? error.status : 503, {
        error: { code: known ? error.code : "service_unavailable", message: known ? error.message :
          "A required service is unavailable. Your saved progress is preserved. Ask booth staff to inspect extension logs." }
      });
      else response.destroy();
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  return {
    get runId() { return panel.runId; },
    get: () => panel.get(),
    dispatch: (action, input) => panel.dispatch(action, input),
    server, url: `${origin}/?ticket=${ticket}`,
    close: () => new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeIdleConnections();
    })
  };
}
