import { readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { REPOSITORY, escapeAttribute, escapeText, page } from './layout.ts';

/**
 * The documents, rendered.
 *
 * Three pages of this service are prose: what you are agreeing to, what the
 * money is, and what answering a call involves. They are written as Markdown in
 * the repository, because that is where they are read and reviewed, and they are
 * rendered here because a disclaimer a visitor has to leave the site to read is
 * a disclaimer that does not get read.
 *
 * The renderer below is deliberately small and deliberately not general. It
 * handles exactly the constructs these documents use — headings, paragraphs,
 * bullet and numbered lists, blockquotes, fenced code, rules, and the inline
 * forms (code, bold, italic, links) — and anything else survives as its own
 * text. That is the failure mode chosen on purpose: an unsupported construct
 * looks visibly wrong on the page, where a cleverer renderer would be quietly
 * wrong in a rule. The alternative, a Markdown library, is a dependency and a
 * parser far larger than three files that are edited by hand and rarely.
 *
 * Emphasis is `*` and `**` only. Underscores are not emphasis here, because the
 * documents are full of identifiers like `HUMANS_GUARANTEE_SATS`, and a renderer
 * that treats `_` as italics turns them into prose.
 */

export interface DocumentSource {
  /** Where the page is served. */
  route: string;
  /** The Markdown file, relative to the repository root: the source of truth. */
  file: string;
  /** What the page is called, in the tab and in the navigation. */
  title: string;
  /** One line for search results and link previews. */
  description: string;
}

/** Every document this service serves, and the only ones. */
export const SOURCES: readonly DocumentSource[] = [
  {
    route: '/disclaimer',
    file: 'DISCLAIMER.md',
    title: 'Disclaimer',
    description:
      'What this service is, what it is not, and what a person reading your request means for your privacy.',
  },
  {
    route: '/money',
    file: 'docs/the-money.md',
    title: 'The money',
    description: 'What the satoshis are, why the unit is one answer and never one hour, and what they are not.',
  },
  {
    route: '/answering',
    file: 'docs/answering.md',
    title: 'Answering calls',
    description: 'For the person at the console: what you see, what not to do, and why you are under no obligation.',
  },
];

export interface RenderedDocument extends DocumentSource {
  /** The whole page, ready to send. */
  html: string;
}

// ---- links -----------------------------------------------------------------

/**
 * Where a link in a document points.
 *
 * Links in the Markdown are written for a reader browsing the repository
 * (`docs/the-money.md`, `../DISCLAIMER.md`, `LICENSE`), and a reader on the site
 * should not be sent to a code host for a document the site is already serving.
 * So a relative target is resolved against the file it was written in: if it
 * names a document we serve it becomes that page's route, and otherwise it
 * becomes its place in the repository. Absolute links are left alone.
 */
export function resolveLink(href: string, fromFile: string): string {
  if (/^(?:[a-z][a-z0-9+.-]*:|#|\/)/i.test(href)) return href;
  const [pathPart = '', fragment = ''] = href.split('#', 2);
  const resolved = normalize(join(dirname(fromFile), pathPart)).replace(/^\.\//, '');
  const source = SOURCES.find((candidate) => candidate.file === resolved);
  const target = source ? source.route : `${REPOSITORY}/blob/master/${resolved}`;
  return fragment === '' ? target : `${target}#${fragment}`;
}

// ---- inline ----------------------------------------------------------------

/**
 * Inline markup, applied to already-escaped text.
 *
 * Code spans are pulled out first, because everything inside one is literal:
 * a document that writes `` `**not bold**` `` means those asterisks. Links are
 * pulled out next, for the same reason applied to their label.
 */
function inline(text: string, fromFile: string): string {
  const held: string[] = [];
  const hold = (html: string): string => {
    held.push(html);
    return `\u0000${held.length - 1}\u0000`;
  };

  let work = text.replace(/`([^`]+)`/g, (_match, code: string) => hold(`<code>${escapeText(code)}</code>`));

  work = work.replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, (_match, label: string, href: string) => {
    const resolved = resolveLink(href, fromFile);
    // A relative link is ours and cannot be a scheme; an absolute one is checked,
    // so that a document cannot smuggle a `javascript:` URL onto the page.
    if (!/^[a-z][a-z0-9+.-]*:/i.test(resolved)) return hold(`<a href="${escapeAttribute(resolved)}">${escapeText(label)}</a>`);
    if (!/^(?:https?:|mailto:)/i.test(resolved)) return escapeText(label);
    const external = /^https?:/i.test(resolved) && !resolved.startsWith(REPOSITORY) ? ' rel="noreferrer noopener"' : '';
    return hold(`<a href="${escapeAttribute(resolved)}"${external}>${escapeText(label)}</a>`);
  });

  work = escapeText(work);
  work = work.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  work = work.replace(/\*([^*]+)\*/g, '<em>$1</em>');

  return work.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => held[Number(index)] ?? '');
}

// ---- blocks ----------------------------------------------------------------

const BLOCK_START = /^(?:#{1,6}\s|>\s?|```|(?:[-*+]|\d+\.)\s+|-{3,}$|\*{3,}$|_{3,}$)/;

function listItem(line: string): { ordered: boolean; text: string } | null {
  const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
  if (bullet) return { ordered: false, text: bullet[1] ?? '' };
  const numbered = /^\s*\d+\.\s+(.*)$/.exec(line);
  if (numbered) return { ordered: true, text: numbered[1] ?? '' };
  return null;
}

/**
 * Markdown to HTML for the subset described at the top of this file.
 *
 * Line-based rather than a real parse: each block is recognised by its opening
 * line and consumed until the shape stops holding. A list item continues while
 * its following lines are indented; nested lists are not supported and show up
 * as their own text inside the item above them.
 */
export function renderMarkdown(source: string, fromFile: string): string {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let index = 0;
  // Indexing past the end is a case this loop tests for, so it is the one place
  // an empty string stands in for "no such line" rather than an assertion.
  const at = (position: number): string => lines[position] ?? '';

  const paragraph = (): string => {
    const collected: string[] = [];
    while (index < lines.length && at(index).trim() !== '' && !BLOCK_START.test(at(index))) {
      collected.push(at(index).trim());
      index += 1;
    }
    return `<p>${inline(collected.join(' '), fromFile)}</p>`;
  };

  while (index < lines.length) {
    const line = at(index);

    if (line.trim() === '') {
      index += 1;
      continue;
    }

    const fence = /^```(\S*)\s*$/.exec(line);
    if (fence) {
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(at(index))) {
        body.push(at(index));
        index += 1;
      }
      index += 1; // the closing fence, or the end of the file
      const language = fence[1] ? ` class="language-${escapeAttribute(fence[1])}"` : '';
      out.push(`<pre><code${language}>${escapeText(body.join('\n'))}</code></pre>`);
      continue;
    }

    const heading = /^(#{1,6})\s+(.*?)\s*$/.exec(line);
    if (heading) {
      const level = (heading[1] ?? '#').length;
      out.push(`<h${level}>${inline(heading[2] ?? '', fromFile)}</h${level}>`);
      index += 1;
      continue;
    }

    if (/^(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push('<hr />');
      index += 1;
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quoted: string[] = [];
      while (index < lines.length && /^>\s?/.test(at(index))) {
        quoted.push(at(index).replace(/^>\s?/, ''));
        index += 1;
      }
      out.push(`<blockquote>${renderMarkdown(quoted.join('\n'), fromFile)}</blockquote>`);
      continue;
    }

    const item = listItem(line);
    if (item) {
      const items: string[] = [];
      const ordered = item.ordered;
      while (index < lines.length) {
        const current = listItem(at(index));
        if (!current || current.ordered !== ordered) break;
        const parts = [current.text];
        index += 1;
        while (index < lines.length && at(index).trim() !== '' && /^\s{2,}/.test(at(index))) {
          parts.push(at(index).trim());
          index += 1;
        }
        items.push(`<li>${inline(parts.join(' '), fromFile)}</li>`);
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>${items.join('')}</${tag}>`);
      continue;
    }

    out.push(paragraph());
  }

  return out.join('\n');
}

// ---- pages -----------------------------------------------------------------

/**
 * The shell around a document: the same header, navigation and footer as every
 * other page of this service, and the prose stylesheet that gives a document a
 * measure instead of a layout.
 */
function documentPage(document: RenderedDocument): string {
  return page({
    title: document.title,
    description: document.description,
    styles: ['/shell.css', '/docs.css'],
    current: document.route,
    mainId: 'doc',
    body: `      <article class="prose">\n${document.html}\n      </article>`,
  });
}

/**
 * Reads and renders every document, once, at boot.
 *
 * A missing file is a hard failure rather than a 404: the disclaimer is not an
 * optional page, and a service that cannot show you what it is should not be
 * answering your calls. Failing here means a broken image never starts.
 */
export function loadDocuments(rootDir = join(import.meta.dirname, '..')): RenderedDocument[] {
  return SOURCES.map((source) => {
    const path = join(rootDir, source.file);
    let markdown: string;
    try {
      markdown = readFileSync(path, 'utf8');
    } catch (error) {
      throw new Error(`humans: cannot read ${source.file}: ${(error as Error).message}`);
    }
    return { ...source, html: documentPage({ ...source, html: renderMarkdown(markdown, source.file) }) };
  });
}
