import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown } from "../markdown.mjs";

test("renders basic markdown", () => {
  const html = renderMarkdown("**bold** and *italic* and `code`");
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<em>italic<\/em>/);
  assert.match(html, /<code>code<\/code>/);
});

test("escapes raw HTML (XSS-safe, html:false)", () => {
  const html = renderMarkdown('<script>alert(1)</script> <img src=x onerror=alert(2)>');
  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;script&gt;/);
});

test("preserves inline $...$ math verbatim (no emphasis mangling)", () => {
  const html = renderMarkdown("energy is $E = mc^2$ and state $a_1 + a_2$");
  assert.match(html, /\$E = mc\^2\$/);
  assert.match(html, /\$a_1 \+ a_2\$/);
  assert.doesNotMatch(html, /<em>/); // underscores/carets inside math must not italicize
});

test("preserves display $$...$$ across lines", () => {
  const html = renderMarkdown("Here:\n\n$$\n\\int_0^1 x^2 \\, dx = \\frac{1}{3}\n$$\n");
  assert.match(html, /\$\$/);
  assert.match(html, /\\int_0\^1 x\^2/);
  assert.match(html, /\\frac\{1\}\{3\}/);
});

test("preserves \\(...\\) and \\[...\\] delimiters", () => {
  const inline = renderMarkdown("inline \\(x^2\\) here");
  assert.match(inline, /\\\(x\^2\\\)/);
  const display = renderMarkdown("display \\[y = x^2\\] here");
  assert.match(display, /\\\[y = x\^2\\\]/);
});

test("math containing HTML-special chars is escaped as text", () => {
  const html = renderMarkdown("compare $a < b$ and $c > d$");
  // `<`/`>` inside math must be HTML-escaped so the markup stays valid;
  // MathJax reads the decoded text content.
  assert.match(html, /\$a &lt; b\$/);
  assert.match(html, /\$c &gt; d\$/);
});

test("currency is not mistaken for math", () => {
  const html = renderMarkdown("it costs $5 and then $10 total");
  assert.match(html, /\$5/);
  assert.match(html, /\$10/);
});

test("no placeholder sentinels leak into output", () => {
  const html = renderMarkdown("mix $x$ and $$y$$ and \\(z\\) and text");
  assert.doesNotMatch(html, /[]/);
});

test("empty / null input yields empty string", () => {
  assert.equal(renderMarkdown(""), "");
  assert.equal(renderMarkdown(null), "");
  assert.equal(renderMarkdown(undefined), "");
});

test("code fences render and their content is escaped", () => {
  const html = renderMarkdown("```js\nconst x = 1 < 2;\n```");
  assert.match(html, /<pre><code/);
  assert.match(html, /1 &lt; 2/);
});
