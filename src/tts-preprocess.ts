/**
 * Markdown → speech-friendly text preprocessor.
 *
 * The `#reader` TTS hook previously passed `note.content` verbatim to the
 * provider, so Kokoro would literally read "hashtag hashtag Monthly Summary
 * asterisk asterisk Captured notes colon". This module strips markdown
 * syntax so the synthesizer sees only the words meant to be spoken.
 *
 * Design notes:
 *
 * - No full markdown parser. Real Reader notes are narrow in shape
 *   (headers, bold/italic emphasis, simple lists, the occasional link)
 *   so a dozen regex passes in a fixed order are sufficient. If we ever
 *   hit something regex can't handle cleanly, add a TODO and move on —
 *   do not reach for remark/marked.
 *
 * - Code blocks are **silently dropped**. Reader notes are primarily
 *   voice-captured summaries; fenced code is vanishingly rare and
 *   spoken fillers like "code block omitted" are more disruptive than
 *   helpful. If a future note type actually contains meaningful code,
 *   we can revisit and inject a spoken marker instead.
 *
 * - Pacing: headers and list items get a trailing period so Kokoro
 *   inserts a short pause before the next phrase. Paragraph breaks
 *   are preserved (collapsed to a single blank line) because the
 *   provider uses those for longer pauses.
 *
 * - Pure function, no I/O. Trivially unit-testable.
 */

/**
 * Convert markdown text into speech-friendly plain text.
 *
 * The transformations happen in a fixed order so later passes can
 * assume earlier markup is gone. Order matters — e.g. fenced code
 * blocks are stripped before inline backticks so we don't accidentally
 * mangle the inside of a multi-line block.
 */
export function markdownToSpeech(text: string): string {
  if (!text) return "";

  let out = text;

  // 1. Fenced code blocks (```lang\n...\n```) — silent drop.
  //    Non-greedy, multi-line. Matches opening fence, optional language
  //    tag, everything up to the closing fence.
  out = out.replace(/```[^\n]*\n[\s\S]*?\n?```/g, "");

  // 2. Indented code blocks (4+ spaces at start of line). Rare in
  //    Reader notes but worth handling since they'd otherwise be
  //    read as awkwardly spaced prose.
  //    We only drop blocks that are preceded by a blank line to avoid
  //    eating deeply-indented list continuations.
  out = out.replace(/(^|\n)\n((?: {4,}|\t)[^\n]*(?:\n(?: {4,}|\t)[^\n]*)*)/g, "$1");

  // 3. HTML tags — strip the tag, keep inner text. Self-closing and
  //    paired tags both handled by simply removing anything that
  //    looks like <...>. We don't try to decode entities.
  out = out.replace(/<\/?[a-zA-Z][^>]*>/g, "");

  // 4. Images: ![alt](src) → alt (or empty if alt is blank).
  //    Must run before the link pass so the leading `!` doesn't get
  //    left behind. URL match handles one level of balanced parens
  //    so things like ![diagram](path/to/(v2).png) work.
  out = out.replace(/!\[([^\]]*)\]\((?:[^()]|\([^)]*\))*\)/g, "$1");

  // 5. Links: [text](url) → text. Drop the URL entirely.
  //    URL match handles one level of balanced parens so Wikipedia
  //    and GitHub-style links like [Foo](https://en.wikipedia.org/wiki/Foo_(bar))
  //    don't leave a stray ")" in the output.
  out = out.replace(/\[([^\]]+)\]\((?:[^()]|\([^)]*\))*\)/g, "$1");

  // 6. Reference-style links [text][ref] → text. We don't resolve
  //    the reference definition; the `text` portion is what the
  //    author intended to be read.
  out = out.replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1");

  // 7. Inline code: `code` → code. Keep the inner text.
  out = out.replace(/`([^`]+)`/g, "$1");

  // 8. Headers: strip leading #s (up to 6) and ensure a trailing
  //    period for pacing, unless the header already ends in
  //    sentence-ending punctuation.
  out = out.replace(/^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/gm, (_m, body: string) => {
    const trimmed = body.trim();
    if (/[.!?:]$/.test(trimmed)) return trimmed;
    return `${trimmed}.`;
  });

  // 9. Blockquotes: drop the leading `>` markers, keep the text.
  //    Handle stacked quotes (`> > foo`) in the same pass.
  out = out.replace(/^\s{0,3}(?:>\s?)+/gm, "");

  // 10. Horizontal rules (---, ***, ___) — silent drop.
  out = out.replace(/^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/gm, "");

  // 11. List markers:
  //     - unordered: `-`, `*`, `+` at start of line (possibly indented)
  //     - ordered: `1.`, `2.` etc.
  //     Strip the marker and append a period if the item doesn't end
  //     in one already, so Kokoro paces between items.
  out = out.replace(/^[ \t]*(?:[-*+]|\d+[.)])\s+(.+?)\s*$/gm, (_m, body: string) => {
    const trimmed = body.trim();
    if (/[.!?:;,]$/.test(trimmed)) return trimmed;
    return `${trimmed}.`;
  });

  // 12. Strikethrough: ~~text~~ → text. Must run before single-char
  //     emphasis so the inner `~` doesn't leak through.
  out = out.replace(/~~([^~]+)~~/g, "$1");

  // 13. Bold: **text** or __text__ → text.
  out = out.replace(/\*\*([^*]+)\*\*/g, "$1");
  out = out.replace(/__([^_]+)__/g, "$1");

  // 14. Italic: *text* or _text_ → text. Careful: avoid matching the
  //     `*` inside mid-word like `foo*bar*baz` weirdly — but for
  //     Reader notes the simple pattern is good enough. The key
  //     guard is "don't match across newlines" so paragraphs don't
  //     collapse into each other.
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1$2");
  out = out.replace(/(^|[^_\w])_([^_\n]+)_/g, "$1$2");

  // 15. Collapse 3+ newlines to 2 (paragraph break preserved),
  //     then trim trailing whitespace on each line.
  out = out.replace(/[ \t]+$/gm, "");
  out = out.replace(/\n{3,}/g, "\n\n");

  // 16. Normalize runs of spaces/tabs within lines.
  out = out.replace(/[ \t]{2,}/g, " ");

  // 17. Final trim.
  return out.trim();
}
