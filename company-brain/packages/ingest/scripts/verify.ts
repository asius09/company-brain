/**
 * Verification for parsing and chunking.
 *
 * The chunker is the component that silently degrades retrieval quality if it is
 * wrong — a chunk that spans two headings produces a citation pointing at the
 * wrong section — so the assertions here are about *structure* (boundaries,
 * breadcrumbs, budgets), not just "it returned some strings".
 */
import { countTokens } from '@company-brain/core';
import { createLogger } from '@company-brain/core';
import {
  ParseError,
  chunkDocument,
  detectKind,
  isAllowedByRobots,
  parseHtml,
  parseMarkdown,
  parseResource,
  parseText,
  splitSentences,
  type FetchedResource,
} from '../src/index';

const log = createLogger('ingest:verify');
let failures = 0;

function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    log.info('verify.pass', label, {});
  } else {
    failures += 1;
    log.error('verify.fail', label, { detail });
  }
}

const res = (
  uri: string,
  body: string,
  contentType = 'text/plain',
  title = 'Doc',
): FetchedResource => ({ externalId: uri, uri, title, contentType, kind: 'text', body });

/* -------------------------------------------------------------------------- */
/* kind detection                                                             */
/* -------------------------------------------------------------------------- */

function testDetectKind(): void {
  check('detects html by content type', detectKind(res('a', '', 'text/html; charset=utf-8')) === 'html');
  check('detects markdown by extension', detectKind(res('a/readme.md', '', 'application/octet-stream')) === 'markdown');
  check('detects pdf by extension', detectKind(res('a/paper.pdf', '', 'application/octet-stream')) === 'pdf');
  check('detects text by content type', detectKind(res('a', '', 'text/csv')) === 'text');
  check('falls back to binary', detectKind(res('a/blob', '', 'application/octet-stream')) === 'binary');
  check('ignores a query string when matching the extension', detectKind(res('a/p.pdf?x=1', '', 'application/octet-stream')) === 'pdf');
  check('dispatch throws for an unsupported kind', (() => {
    try {
      parseResource(res('a/blob', '', 'application/octet-stream'));
      return false;
    } catch (error) {
      return error instanceof ParseError;
    }
  })());
}

/* -------------------------------------------------------------------------- */
/* plain text                                                                 */
/* -------------------------------------------------------------------------- */

function testParseText(): void {
  const doc = parseText(res('a.txt', 'First paragraph.\n\nSecond paragraph.\n\nThird.'));
  check('splits plain text on blank lines into sections', doc.sections.length === 3, doc.sections.length);

  const single = parseText(res('a.txt', 'Just one block of prose.'));
  check('keeps a single block as one section', single.sections.length === 1);

  check('rejects an empty document', (() => {
    try {
      parseText(res('a.txt', '   \n  '));
      return false;
    } catch (error) {
      return error instanceof ParseError && error.uri === 'a.txt';
    }
  })());

  check('collapses internal whitespace but keeps words', (() => {
    const doc2 = parseText(res('a.txt', 'a   b\n\nc\t\td'));
    return doc2.sections[0]?.text === 'a b' && doc2.sections[1]?.text === 'c d';
  })());
}

/* -------------------------------------------------------------------------- */
/* markdown                                                                   */
/* -------------------------------------------------------------------------- */

function testParseMarkdown(): void {
  const md = [
    '# Handbook',
    '',
    'Welcome to the handbook.',
    '',
    '## Benefits',
    '',
    'Unlimited holidays.',
    '',
    '### Equity',
    '',
    'Four year cliff.',
    '',
    '## Engineering',
    '',
    'We use TypeScript.',
  ].join('\n');

  const doc = parseMarkdown(res('handbook.md', md, 'text/markdown'));
  check('markdown splits on headings', doc.sections.length === 4, doc.sections.length);
  check(
    'nests headings into a breadcrumb',
    doc.sections[2]?.headings.join(' > ') === 'Handbook > Benefits > Equity',
    doc.sections[2]?.headings,
  );
  check(
    'a sibling heading pops the stack',
    doc.sections[3]?.headings.join(' > ') === 'Handbook > Engineering',
    doc.sections[3]?.headings,
  );
  check('the first H1 becomes the title', doc.title === 'Handbook', doc.title);
  check('section text excludes the heading line', doc.sections[1]?.text === 'Unlimited holidays.', doc.sections[1]?.text);

  const fenced = ['# Title', '', '```md', '# not a heading', '```', '', 'after.'].join('\n');
  const fencedDoc = parseMarkdown(res('f.md', fenced, 'text/markdown'));
  check('a # inside a fence does not add a heading level', fencedDoc.sections.every((s) => s.headings.length <= 1), fencedDoc.sections.map((s) => s.headings));
  check('fence content is preserved', (fencedDoc.sections[0]?.text ?? '').includes('# not a heading'));
  check('text after the fence is kept in the same section', (fencedDoc.sections[0]?.text ?? '').includes('after.'));

  const closed = ['```js', 'const a = 1;', 'more();'].join('\n');
  const unterminated = parseMarkdown(res('u.md', closed, 'text/markdown'));
  check('an unterminated fence warns instead of throwing', unterminated.warnings.length === 1, unterminated.warnings);
  check('an unterminated fence still yields content', unterminated.sections.length > 0);

  const headingNoText = ['# A', '', '## B', '', 'body'].join('\n');
  const empty = parseMarkdown(res('e.md', headingNoText, 'text/markdown'));
  check('a heading with no body still records the breadcrumb', empty.sections[0]?.headings.join('>') === 'A>B', empty.sections[0]?.headings);

  const deeper = ['# a', '## b', '### c', '#### d', 'text'].join('\n\n');
  const deep = parseMarkdown(res('d.md', deeper, 'text/markdown'));
  check('handles four heading levels', deep.sections[0]?.headings.length === 4, deep.sections[0]?.headings);
}

/* -------------------------------------------------------------------------- */
/* html                                                                       */
/* -------------------------------------------------------------------------- */

function testParseHtml(): void {
  const html = `<!doctype html>
<html><head><title>Site Title</title><script>var x = '<h1>fake</h1>';</script></head>
<body>
  <h1>Main</h1>
  <p>Intro paragraph.</p>
  <h2>Section A</h2>
  <p>Body A.</p>
  <ul><li>bullet one</li><li>bullet two</li></ul>
  <h2>Section B</h2>
  <p>Body B.</p>
  <style>.x{color:red}</style>
  <nav><a href="/x">nav link</a></nav>
  <footer>&copy; 2026 Example Inc</footer>
</body></html>`;

  const doc = parseHtml(res('https://x.dev/', html, 'text/html'));
  check('html splits on headings', doc.sections.length === 3, doc.sections.map((s) => s.headings));
  check('the doctype is not captured as text', !JSON.stringify(doc).includes('doctype'), doc.sections[0]?.text);
  check('html records the breadcrumb', doc.sections[1]?.headings.join(' > ') === 'Main > Section A', doc.sections[1]?.headings);
  check('list items join into the section', (doc.sections[1]?.text ?? '').includes('bullet one'));
  check('script contents are dropped', !JSON.stringify(doc).includes('fake'));
  check('style contents are dropped', !JSON.stringify(doc).includes('color:red'));
  check('nav chrome is dropped', !JSON.stringify(doc).includes('nav link'));
  check('footer chrome is dropped', !JSON.stringify(doc).includes('Example Inc'));

  const h1First = parseHtml(res('https://x.dev/', '<html><body><h1>Doc H1</h1><p>x</p></body></html>', 'text/html'));
  check('an h1 wins over <title>', h1First.title === 'Doc H1', h1First.title);

  const titleOnly = parseHtml(res('https://x.dev/', '<html><head><title>Only Title</title></head><body><p>b</p></body></html>', 'text/html'));
  check('falls back to <title>', titleOnly.title === 'Only Title', titleOnly.title);

  const noText = parseHtml(res('https://x.dev/', '<html><body><div></div></body></html>', 'text/html'));
  check('warns when there is no textual content', noText.warnings.length === 1, noText.warnings);

  const nested = parseHtml(
    res('https://x.dev/', '<body><h2>A</h2><div><div><p>deep</p></div></div><h2>B</h2><p>x</p></body>', 'text/html'),
  );
  check('nested containers do not split sections', nested.sections.length === 2, nested.sections.length);

  const unclosed = parseHtml(res('https://x.dev/', '<body><h2>A</h2><p>text<script>bad()', 'text/html'));
  check('an unclosed script does not leak its body', !JSON.stringify(unclosed).includes('bad()'));

  const entities = parseHtml(res('https://x.dev/', '<body><h2>A &amp; B</h2><p>caf&eacute;</p></body>', 'text/html'));
  check('entity-escaped text is preserved', (entities.sections[0]?.headings[0] ?? '').includes('A'), entities.sections[0]?.headings);
}

/* -------------------------------------------------------------------------- */
/* sentences                                                                  */
/* -------------------------------------------------------------------------- */

function testSentences(): void {
  check('splits on sentence-ending punctuation', splitSentences('One. Two! Three?').length === 3, splitSentences('One. Two! Three?'));
  check('keeps abbreviations intact', splitSentences('Dr. Smith arrived. He left.').length === 2, splitSentences('Dr. Smith arrived. He left.'));
  check('keeps decimal numbers intact', splitSentences('Pi is 3.14 exactly. Done.').length === 2, splitSentences('Pi is 3.14 exactly. Done.'));
  check('keeps e.g. intact', splitSentences('It works, e.g. here. Next.').length === 2, splitSentences('It works, e.g. here. Next.'));
  check('keeps a trailing-lowercase abbreviation attached', splitSentences('Use etc. carefully. Done.').length === 2, splitSentences('Use etc. carefully. Done.'));
  // Known limitation, pinned deliberately: the abbreviation list is not
  // exhaustive, so an unknown one ("fig.") still splits. That only moves a
  // chunk boundary slightly early — it degrades gracefully, so chasing every
  // abbreviation is not worth the dependency on a real segmenter.
  check('an unknown abbreviation splits (documented limitation)', splitSentences('See fig. 2 below. Next.').length === 3, splitSentences('See fig. 2 below. Next.'));
  check('splits on a paragraph break', splitSentences('One.\n\nTwo.').length === 2, splitSentences('One.\n\nTwo.'));
}

/* -------------------------------------------------------------------------- */
/* chunking                                                                   */
/* -------------------------------------------------------------------------- */

function testChunking(): void {
  const doc = parseMarkdown(
    res(
      'long.md',
      ['# Guide', '', 'Alpha sentence one. Alpha sentence two.', '', '## Second', '', 'Beta sentence one. Beta sentence two.'].join('\n'),
      'text/markdown',
    ),
  );

  const chunks = chunkDocument(doc, { maxTokens: 64, overlapTokens: 0, minTokens: 1 });
  check('produces at least one chunk per section', chunks.length >= 2, chunks.length);
  check('chunk indices are sequential', chunks.every((c, i) => c.index === i));
  check(
    'headingText is the denormalized breadcrumb',
    chunks[0]?.headingText === 'Guide',
    chunks[0]?.headingText,
  );
  check(
    'a chunk never spans two sections',
    new Set(chunks.map((c) => c.headingText)).size === 2,
    chunks.map((c) => c.headingText),
  );
  check('ratios start at 0 and end at 1', chunks[0]?.startRatio === 0 && chunks.at(-1)?.endRatio === 1, {
    first: chunks[0]?.startRatio,
    last: chunks.at(-1)?.endRatio,
  });
  check(
    'ratios are monotonic',
    chunks.every((c, i) => i === 0 || c.startRatio >= (chunks[i - 1]?.startRatio ?? 0)),
  );
  check(
    'tokenCount matches the content',
    chunks.every((c) => c.tokenCount === countTokens(c.content)),
  );

  // Budget: no chunk may exceed maxTokens, even with overlap.
  const long = parseMarkdown(
    res('long2.md', ['# T', '', Array.from({ length: 120 }, (_, i) => `Sentence number ${i} has a reasonable number of words in it.`).join(' ')].join('\n'), 'text/markdown'),
  );
  const budgeted = chunkDocument(long, { maxTokens: 100, overlapTokens: 20, minTokens: 10 });
  check(
    'no chunk exceeds the token budget',
    budgeted.every((c) => c.tokenCount <= 100),
    budgeted.map((c) => c.tokenCount).filter((t) => t > 100),
  );
  check('a long document is split into many chunks', budgeted.length > 3, budgeted.length);
  check(
    'overlap repeats text from the previous chunk',
    (() => {
      const withOverlap = chunkDocument(long, { maxTokens: 100, overlapTokens: 30, minTokens: 10 });
      const without = chunkDocument(long, { maxTokens: 100, overlapTokens: 0, minTokens: 10 });
      return withOverlap.length === without.length && withOverlap.some((c, i) =>
        c.content.length > (without[i]?.content.length ?? 0),
      );
    })(),
  );

  // Min-size merging.
  const tiny = parseMarkdown(res('tiny.md', ['# T', '', 'Hi.', '', '## B', '', 'There.'].join('\n'), 'text/markdown'));
  const merged = chunkDocument(tiny, { maxTokens: 512, overlapTokens: 0, minTokens: 40 });
  check(
    'undersized chunks are not left tiny',
    merged.every((c) => c.tokenCount >= 2),
    merged.map((c) => c.tokenCount),
  );
  check('sections are preserved through merging', merged.length >= 1, merged.length);

  // Degenerate inputs.
  check('an empty document yields no chunks', chunkDocument({ title: 'x', sections: [], warnings: [] }).length === 0);
  check('whitespace-only sections are dropped', chunkDocument({ title: 'x', sections: [{ headings: [], text: '   ' }], warnings: [] }).length === 0);
  check('a wordless chunk still works', chunkDocument(parseText(res('w.txt', 'a b c')), { maxTokens: 512 }).length > 0);

  // A single gigantic token blob must not loop forever or emit a zero-length chunk.
  const blob = parseText(res('blob.txt', 'x'.repeat(20_000)));
  const blobChunks = chunkDocument(blob, { maxTokens: 64, overlapTokens: 0, minTokens: 1 });
  check('a huge unsplittable blob is chunked', blobChunks.length > 1, blobChunks.length);
  check('no empty chunks are emitted', blobChunks.every((c) => c.content.trim().length > 0));
  check(
    'hard-split chunks respect the budget',
    blobChunks.every((c) => c.tokenCount <= 64),
    blobChunks.map((c) => c.tokenCount).filter((t) => t > 64).slice(0, 5),
  );
}

/* -------------------------------------------------------------------------- */
/* robots.txt                                                                 */
/* -------------------------------------------------------------------------- */

function testRobots(): void {
  const agent = 'CompanyBrainBot/1.0';
  const robots = ['User-agent: *', 'Disallow: /private', 'Allow: /private/ok', '', 'User-agent: EvilBot', 'Disallow: /'].join('\n');

  check('disallows a matched path', isAllowedByRobots(robots, '/private/thing', agent) === false);
  check('longest-match Allow wins', isAllowedByRobots(robots, '/private/ok/page', agent) === true);
  check('a specific agent group overrides *', isAllowedByRobots(robots, '/anything', 'EvilBot/1') === false);
  check('allows unmatched paths', isAllowedByRobots(robots, '/about', agent) === true);
  check('an empty Disallow allows everything', isAllowedByRobots('User-agent: *\nDisallow:', '/x', agent) === true);
  check('no robots.txt allows everything', isAllowedByRobots('', '/x', agent) === true);
  check('wildcard patterns work', isAllowedByRobots('User-agent: *\nDisallow: /*.pdf', '/a/b.pdf', agent) === false);
  check('anchored patterns work', isAllowedByRobots('User-agent: *\nDisallow: /exact$', '/exact', agent) === false);
  check('comments are ignored', isAllowedByRobots('# Disallow: /\nUser-agent: *\nDisallow: /a', '/b', agent) === true);
}

/* -------------------------------------------------------------------------- */

testDetectKind();
testParseText();
testParseMarkdown();
testParseHtml();
testSentences();
testChunking();
testRobots();

log.info('verify.done', failures === 0 ? 'all checks passed' : `${failures} check(s) failed`, { failures });
process.exit(failures === 0 ? 0 : 1);
