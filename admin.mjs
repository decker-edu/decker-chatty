// Admin UI router: sign-in with (promptId, deckConfigKey), then browse that
// prompt's logged sessions. Kept self-contained — no session-store or
// cookie-parser dependency; the login cookie is a short HMAC-signed token and
// cookies are parsed by hand.
//
// Auth model: the deckConfigKey is already a 32-byte shared secret the prompt's
// author holds, so it doubles as the password. It is compared in constant time
// against the configured key and every data route is scoped to the promptId in
// the verified cookie — an admin only ever sees their own prompt's traffic.
//
// Prefix handling: the router never needs to know its public path, so a
// reverse proxy can mount it anywhere (Caddy `handle_path` strips the prefix).
// Every page lives directly under the router root, so links, form actions and
// redirect Locations are all relative; the login cookie carries no Path and so
// defaults to the directory of the login URL, i.e. the public admin root.
import express from "express";
import crypto from "node:crypto";
import path from "node:path";
import { loginPage, listPage, sessionDetail } from "./views.mjs";

const COOKIE = "chatty_admin";
const MAX_AGE_SEC = 12 * 60 * 60; // 12h session
const MAX_AGE_MS = MAX_AGE_SEC * 1000;
const PAGE_SIZE = 50;

// Login throttle: after this many consecutive failures for a promptId, reject
// further attempts for the lockout window. In-memory is fine for a single
// proxy process; it resets on restart, which is acceptable for a brute-force
// speed bump on a high-entropy 32-byte key.
const MAX_FAILS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

export function createAdminRouter({ prompts, store, cookieSecret, cookieSecure = true }) {
  // The cookie secret signs the login token; without it we cannot issue or
  // verify sessions, so the admin UI stays off rather than running insecurely.
  if (!cookieSecret || typeof cookieSecret !== "string") return null;

  const router = express.Router();
  router.use(express.urlencoded({ extended: false }));
  // redirect:false — serve-static's directory redirect builds an absolute
  // Location that would lose the reverse proxy's prefix.
  router.use("/static", express.static(path.join(import.meta.dirname, "public"), { redirect: false }));

  // Relative links only resolve against the admin root when its URL ends in a
  // slash; send ".../admin" to ".../admin/" (relative, so the prefix survives).
  router.use((req, res, next) => {
    const [pathname, query] = req.originalUrl.split(/\?(.*)/s);
    if (req.method !== "GET" || req.path !== "/" || pathname.endsWith("/")) return next();
    res.redirect(`${path.posix.basename(pathname)}/${query ? `?${query}` : ""}`);
  });

  const fails = new Map(); // promptId -> { count, lockUntil }

  function throttled(promptId) {
    const f = fails.get(promptId);
    return f && f.lockUntil > Date.now();
  }
  function noteFailure(promptId) {
    const f = fails.get(promptId) || { count: 0, lockUntil: 0 };
    f.count += 1;
    if (f.count >= MAX_FAILS) f.lockUntil = Date.now() + LOCKOUT_MS;
    fails.set(promptId, f);
  }
  function clearFailures(promptId) {
    fails.delete(promptId);
  }

  // ---- auth helpers -------------------------------------------------------

  function sign(data) {
    return crypto.createHmac("sha256", cookieSecret).update(data).digest("base64url");
  }
  function makeToken(promptId) {
    const p = Buffer.from(promptId, "utf8").toString("base64url");
    const iat = Date.now();
    const data = `${p}.${iat}`;
    return `${data}.${sign(data)}`;
  }
  function readToken(value) {
    if (!value) return null;
    const parts = value.split(".");
    if (parts.length !== 3) return null;
    const [p, iat, sig] = parts;
    const expected = sign(`${p}.${iat}`);
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const t = Number(iat);
    if (!Number.isFinite(t) || Date.now() - t > MAX_AGE_MS) return null;
    return Buffer.from(p, "base64url").toString("utf8");
  }

  // Constant-time deck-config-key check. Unknown prompt ids are compared
  // against a random key so a missing prompt takes the same path as a wrong
  // key (no existence oracle). Key length (32 bytes) is not secret.
  function keyMatches(promptId, submittedB64) {
    const entry = prompts[promptId];
    const stored = entry ? entry.deckConfigKey : crypto.randomBytes(32);
    let buf;
    try {
      buf = Buffer.from(String(submittedB64 || ""), "base64");
    } catch {
      buf = Buffer.alloc(0);
    }
    if (buf.length !== stored.length) return false;
    const ok = crypto.timingSafeEqual(buf, stored);
    return ok && Boolean(entry);
  }

  // No Path attribute: login and logout are both posted to "<admin root>/…", so
  // the browser's default path is the public admin root, wherever that is. This
  // keeps the cookie away from the host's other apps without knowing the prefix.
  function setCookie(res, value, maxAgeSec) {
    const attrs = [`${COOKIE}=${value}`, "HttpOnly", "SameSite=Lax", `Max-Age=${maxAgeSec}`];
    if (cookieSecure) attrs.push("Secure");
    res.append("Set-Cookie", attrs.join("; "));
  }

  function parseCookies(header) {
    const out = {};
    if (!header) return out;
    for (const part of header.split(";")) {
      const i = part.indexOf("=");
      if (i < 0) continue;
      out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    }
    return out;
  }

  function requireAuth(req, res, next) {
    const cookies = parseCookies(req.headers.cookie);
    const promptId = readToken(cookies[COOKIE]);
    if (!promptId || !prompts[promptId]) {
      return res.redirect("login");
    }
    req.adminPromptId = promptId;
    // Re-derived live from config on every request (not baked into the
    // cookie), so flipping superAdmin off in config.json takes effect
    // immediately rather than waiting for the cookie to expire.
    req.isSuperAdmin = Boolean(prompts[promptId].superAdmin);
    next();
  }

  // ---- routes -------------------------------------------------------------

  router.get("/login", (_req, res) => {
    res.type("html").send(loginPage());
  });

  router.post("/login", (req, res) => {
    const promptId = String(req.body?.promptId || "").trim();
    const key = req.body?.deckConfigKey;

    if (throttled(promptId)) {
      return res
        .status(429)
        .type("html")
        .send(loginPage({ promptId, error: "Too many attempts. Try again later." }));
    }

    if (!keyMatches(promptId, key)) {
      noteFailure(promptId);
      // Deliberately generic: never reveal whether the prompt id exists.
      return res
        .status(401)
        .type("html")
        .send(loginPage({ promptId, error: "Invalid prompt id or key." }));
    }

    clearFailures(promptId);
    setCookie(res, makeToken(promptId), MAX_AGE_SEC);
    res.redirect("./");
  });

  router.post("/logout", (_req, res) => {
    setCookie(res, "", 0);
    res.redirect("login");
  });

  router.get("/", requireAuth, (req, res) => {
    const promptId = req.adminPromptId;
    const page = Math.max(0, parseInt(req.query.page, 10) || 0);

    // Super admins may filter down to one prompt (?prompt=…) or leave it
    // unset to see every prompt's sessions; anyone else is always scoped to
    // their own prompt id, filter or not.
    const requestedFilter = typeof req.query.prompt === "string" ? req.query.prompt : "";
    const promptFilter = req.isSuperAdmin && prompts[requestedFilter] ? requestedFilter : "";
    const scope = req.isSuperAdmin ? promptFilter || null : promptId;

    const sessions = store.listSessions(scope, { limit: PAGE_SIZE, offset: page * PAGE_SIZE });
    const total = store.countSessions(scope);
    const hasNext = (page + 1) * PAGE_SIZE < total;
    res.type("html").send(
      listPage({
        promptId,
        isSuperAdmin: req.isSuperAdmin,
        promptIds: req.isSuperAdmin ? Object.keys(prompts).sort() : [],
        promptFilter,
        sessions,
        page,
        hasNext,
      })
    );
  });

  // Flat route (session?prompt=…&id=…) so the transcript page sits at the
  // admin root like every other page and its relative links still resolve.
  router.get("/session", requireAuth, (req, res) => {
    const promptId = req.adminPromptId;
    const targetPromptId = String(req.query.prompt ?? "");
    // Non-super admins may only ever look at their own prompt's sessions;
    // reject a mismatched prompt id in the URL the same way a bad session id
    // would fail (no existence oracle for other prompts' logs).
    if (!req.isSuperAdmin && targetPromptId !== promptId) {
      return res.redirect("./");
    }
    const sessionId = String(req.query.id ?? "");
    const turns = store.getSessionTurns(targetPromptId, sessionId);
    const fragment = req.get("HX-Request") === "true";
    res.type("html").send(
      sessionDetail({
        promptId,
        isSuperAdmin: req.isSuperAdmin,
        sessionPromptId: targetPromptId,
        sessionId,
        turns,
        fragment,
      })
    );
  });

  return router;
}
