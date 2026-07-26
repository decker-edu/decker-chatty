// Render transcript text (student input, bot output) as sanitized HTML with
// markdown formatting and preserved math, for MathJax to typeset client-side.
//
// Security: markdown-it runs with html:false, so any raw HTML in the untrusted
// content is escaped, not emitted — no client-side sanitizer needed. Pure and
// unit-tested (mirrors the seal.mjs / logging.mjs discipline).
//
// Math survives markdown: TeX often contains characters markdown would mangle
// (`_`, `*`, `\`, backticks). So math spans are pulled out to inert placeholders
// BEFORE markdown runs and restored (HTML-escaped, delimiters intact) AFTER, so
// markdown never sees them and MathJax finds them verbatim in the final DOM.
import MarkdownIt from "markdown-it";

const md = new MarkdownIt({ html: false, linkify: true, breaks: true });

// Private-use chars: inert to markdown, will never occur in real text.
const OPEN = "";
const CLOSE = "";

// Display delimiters before inline; $$ before $. The inline-$ pattern is
// guarded so ordinary currency ("costs $5 and $10") is not mistaken for math:
// the opening $ may not be followed by whitespace, the closing $ may not be
// preceded by whitespace, and neither may be flanked by a word char or $.
const MATH_PATTERNS = [
  /\$\$[\s\S]+?\$\$/g, // $$...$$
  /\\\[[\s\S]+?\\\]/g, // \[...\]
  /\\\([\s\S]+?\\\)/g, // \(...\)
  /(?<![\w$])\$(?!\s)[^\n$]+?(?<!\s)\$(?![\w$])/g, // $...$
];

function escapeText(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function protectMath(text, store) {
  let out = text;
  for (const re of MATH_PATTERNS) {
    out = out.replace(re, (m) => {
      const i = store.length;
      store.push(m); // full match, delimiters included
      return `${OPEN}${i}${CLOSE}`;
    });
  }
  return out;
}

function restoreMath(html, store) {
  if (store.length === 0) return html;
  return html.replace(new RegExp(`${OPEN}(\\d+)${CLOSE}`, "g"), (_, i) =>
    escapeText(store[Number(i)])
  );
}

// Untrusted text -> safe HTML string. Math is left as escaped text with its
// delimiters (e.g. \(x^2\)) for MathJax to typeset; markdown handles the rest.
export function renderMarkdown(text) {
  if (text == null || text === "") return "";
  const store = [];
  const protectedText = protectMath(String(text), store);
  const html = md.render(protectedText);
  return restoreMath(html, store);
}
