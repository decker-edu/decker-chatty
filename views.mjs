// Server-rendered HTML for the admin UI. Plain template strings — no template
// engine, no build step (mirrors the repo's minimal-dependency ethos). Every
// piece of turn content (student input, bot output, error text) is escaped
// before it reaches the page; the only unescaped interpolation is our own
// trusted markup and values we control (ids, counts, timestamps).
//
// URLs are prefix-agnostic: a <base href="{mountPath}/"> is emitted and every
// link/form is relative to it, so the same pages work under any Caddy path
// prefix as long as the app's mountPath matches the public prefix.

import { renderMarkdown } from "./markdown.mjs";

export function escapeHtml(s) {
  if (s == null) return "";
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// mountPath like "/admin" -> base href "/admin/" (relative links resolve here).
function baseHref(mountPath) {
  return (mountPath.endsWith("/") ? mountPath : mountPath + "/");
}

function truncate(s, n = 120) {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

// MathJax configuration + loader. Delimiters match decker's decks ($…$ and
// \(…\) inline, $$…$$ and \[…\] display). SVG output is self-contained (no
// runtime font fetches), so the vendored tex-svg.js needs nothing external.
// The htmx:afterSwap listener re-typesets a transcript swapped into #detail.
const MATHJAX = `
<script>
window.MathJax = {
  tex: {
    inlineMath: [['$', '$'], ['\\\\(', '\\\\)']],
    displayMath: [['$$', '$$'], ['\\\\[', '\\\\]']]
  },
  svg: { fontCache: 'global' },
  options: { skipHtmlTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code'] }
};
</script>
<script src="static/vendor/mathjax/tex-svg.js" id="MathJax-script" async></script>
<script>
document.body.addEventListener('htmx:afterSwap', function (e) {
  if (window.MathJax && window.MathJax.typesetPromise) {
    window.MathJax.typesetPromise([e.target]);
  }
});
</script>`;

// Full HTML document shell. `body` is trusted markup already assembled by the
// callers below. loadHtmx/loadMath let the login page skip both.
function layout({ mountPath, title, body, loadHtmx = true, loadMath = true }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<base href="${escapeHtml(baseHref(mountPath))}">
<title>${escapeHtml(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Big+Shoulders:opsz,wght@10..72,300..900&family=Archivo:wght@100..900&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="static/styles.css">
${loadHtmx ? '<script src="static/htmx.min.js" defer></script>' : ""}
</head>
<body>
${body}
${loadMath ? MATHJAX : ""}
</body>
</html>`;
}

export function loginPage({ mountPath, promptId = "", error = "" }) {
  const body = `
<main class="wrap narrow">
  <h1 class="logo">Prof.&nbsp;Bot <span>logs</span></h1>
  <div class="card">
    <h2>Sign in</h2>
    <p class="muted">Enter a prompt id and its deck-config key to inspect that prompt's sessions.</p>
    ${error ? `<div class="alert">${escapeHtml(error)}</div>` : ""}
    <form method="post" action="login" class="stack">
      <label>Prompt id
        <input name="promptId" autocomplete="username" value="${escapeHtml(promptId)}" required>
      </label>
      <label>Deck-config key (base64)
        <input name="deckConfigKey" type="password" autocomplete="current-password" required>
      </label>
      <button type="submit">Enter</button>
    </form>
  </div>
</main>`;
  return layout({ mountPath, title: "Sign in — Prof. Bot logs", body, loadHtmx: false, loadMath: false });
}

function topbar(promptId, isSuperAdmin) {
  return `
<header class="topbar">
  <a class="logo sm" href="./">Prof.&nbsp;Bot <span>logs</span></a>
  <div class="spacer"></div>
  ${isSuperAdmin ? '<span class="pill accent">super admin</span>' : ""}
  <span class="pill">${escapeHtml(promptId)}</span>
  <form method="post" action="logout" class="inline"><button class="ghost" type="submit">Sign out</button></form>
</header>`;
}

function statusTag(s) {
  const cls =
    s === "completed" ? "ok" : s === "unknown" ? "warn" : "bad";
  return `<span class="tag ${cls}">${escapeHtml(s ?? "?")}</span>`;
}

export function listPage({
  mountPath,
  promptId,
  isSuperAdmin = false,
  promptIds = [],
  promptFilter = "",
  sessions,
  page,
  hasNext,
}) {
  const rows = sessions.length
    ? sessions
        .map((s) => {
          const href = `session/${encodeURIComponent(s.prompt_id)}/${encodeURIComponent(s.session_id)}`;
          return `
    <a class="row" href="${href}"
       hx-get="${href}"
       hx-target="#detail" hx-push-url="true">
      <div class="preview">${escapeHtml(truncate(s.preview)) || '<span class="muted">(no text)</span>'}</div>
      <div class="meta">
        ${isSuperAdmin ? `<span class="tag">${escapeHtml(s.prompt_id)}</span><span class="sep">·</span>` : ""}
        <span>${escapeHtml(s.turn_count)} turn${s.turn_count === 1 ? "" : "s"}</span>
        <span class="sep">·</span>
        <span class="model">${escapeHtml(s.model ?? "?")}</span>
        ${s.error_count ? `<span class="sep">·</span><span class="tag bad">${escapeHtml(s.error_count)} err</span>` : ""}
        <time datetime="${escapeHtml(s.last_at)}">${escapeHtml(fmtDate(s.last_at))}</time>
      </div>
    </a>`;
        })
        .join("")
    : '<p class="muted pad">No sessions logged yet.</p>';

  const filterQS = promptFilter ? `&prompt=${encodeURIComponent(promptFilter)}` : "";
  const pager = `
  <nav class="pager">
    ${page > 0 ? `<a class="btn" href="?page=${page - 1}${filterQS}">‹ Newer</a>` : `<span class="btn disabled">‹ Newer</span>`}
    <span class="muted">Page ${page + 1}</span>
    ${hasNext ? `<a class="btn" href="?page=${page + 1}${filterQS}">Older ›</a>` : `<span class="btn disabled">Older ›</span>`}
  </nav>`;

  const filterForm = isSuperAdmin
    ? `
  <form method="get" class="inline filter" onchange="this.submit()">
    <label>Prompt
      <select name="prompt">
        <option value=""${promptFilter ? "" : " selected"}>All prompts</option>
        ${promptIds
          .map(
            (id) =>
              `<option value="${escapeHtml(id)}"${id === promptFilter ? " selected" : ""}>${escapeHtml(id)}</option>`
          )
          .join("")}
      </select>
    </label>
    <noscript><button type="submit">Filter</button></noscript>
  </form>`
    : "";

  const heading = isSuperAdmin ? `Sessions — ${promptFilter || "all prompts"}` : `Sessions — ${promptId}`;

  const body = `
${topbar(promptId, isSuperAdmin)}
<main class="wrap split">
  <section class="list">
    <h2>Sessions</h2>
    ${filterForm}
    <div class="rows">${rows}</div>
    ${pager}
  </section>
  <section id="detail" class="detail">
    <div class="empty muted">Select a session to view its transcript.</div>
  </section>
</main>`;
  return layout({ mountPath, title: heading, body });
}

// The transcript for one session. Rendered as a full page on direct navigation
// and as a bare fragment when requested by htmx (partial swap into #detail).
export function sessionDetail({
  mountPath,
  promptId,
  isSuperAdmin = false,
  sessionPromptId = promptId,
  sessionId,
  turns,
  fragment,
}) {
  const turnsHtml = turns
    .map((t, i) => {
      const usage = t.usage_json ? safeUsage(t.usage_json) : "";
      return `
    <article class="turn">
      <div class="turn-head">
        <span class="n">#${i + 1}</span>
        ${statusTag(t.status)}
        <span class="muted">${escapeHtml(t.model ?? "")}</span>
        <span class="spacer"></span>
        <time>${escapeHtml(fmtDate(t.created_at))}</time>
      </div>
      ${t.input_text ? `<div class="bubble user"><span class="who">Student</span><div class="text md">${renderMarkdown(t.input_text)}</div></div>` : ""}
      ${t.output_text ? `<div class="bubble bot"><span class="who">Prof. Bot</span><div class="text md">${renderMarkdown(t.output_text)}</div></div>` : ""}
      ${t.error_message ? `<div class="alert">${escapeHtml(t.error_message)}</div>` : ""}
      ${usage ? `<div class="usage muted">${usage}</div>` : ""}
    </article>`;
    })
    .join("");

  const inner = `
  <div class="detail-head">
    <h2>Transcript</h2>
    ${isSuperAdmin ? `<span class="tag">${escapeHtml(sessionPromptId)}</span>` : ""}
    <code class="sid">${escapeHtml(sessionId)}</code>
  </div>
  <div class="turns">${turnsHtml || '<p class="muted">This session has no turns.</p>'}</div>`;

  if (fragment) return inner;

  const backHref = isSuperAdmin ? `./?prompt=${encodeURIComponent(sessionPromptId)}` : "./";
  const body = `
${topbar(promptId, isSuperAdmin)}
<main class="wrap">
  <p><a class="btn" href="${backHref}">‹ All sessions</a></p>
  <section class="detail solo">${inner}</section>
</main>`;
  return layout({ mountPath, title: `Session ${sessionId} — ${sessionPromptId}`, body });
}

function safeUsage(json) {
  try {
    const u = JSON.parse(json);
    const total = u.total_tokens ?? "?";
    const inp = u.input_tokens ?? "?";
    const out = u.output_tokens ?? "?";
    return `tokens: ${escapeHtml(inp)} in · ${escapeHtml(out)} out · ${escapeHtml(total)} total`;
  } catch {
    return "";
  }
}

// Compact, locale-stable timestamp. Inputs are ISO8601 UTC strings from the db.
function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
}
