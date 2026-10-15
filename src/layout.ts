import { config } from './config.ts';

/**
 * The frame every page of this service is served in.
 *
 * There is more than one page family now — the console, the prose documents,
 * and the landing pages — and they share a header, a footer and an escaper.
 * A second copy of a stylesheet drifts visibly; a second copy of an escaper
 * drifts silently and only in the case nobody thought to test, which is exactly
 * the case an escaper exists for. So both live here once.
 *
 * Nothing in this file knows what a page says.
 */

export const REPOSITORY = 'https://github.com/lxg2it/humans';

// ---- escaping --------------------------------------------------------------

/**
 * Escaping is not optional and it is not conditional: every value interpolated
 * into a page goes through one of these two, including values that "cannot"
 * contain markup. A responder key name arrives from a form, a caller's model id
 * arrives from the wire, and both of them are somebody else's string.
 */
export function escapeText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function escapeAttribute(text: string): string {
  return escapeText(text).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ---- navigation ------------------------------------------------------------

export interface NavEntry {
  href: string;
  label: string;
}

/**
 * The chrome's navigation, on every page.
 *
 * It is written down rather than derived from the served documents, because the
 * console and the landing pages are not documents and would have to be bolted
 * on anyway. The cost is that a new document can be added without appearing
 * here, which is a thing that only ever causes mild annoyance — so a test
 * asserts the two sets agree rather than the code enforcing it.
 */
export const NAV: readonly NavEntry[] = [
  { href: '/signup', label: 'get a key' },
  { href: '/console', label: 'console' },
  { href: '/disclaimer', label: 'disclaimer' },
  { href: '/money', label: 'the money' },
  { href: '/pool', label: 'the fund' },
  { href: '/answering', label: 'answering' },
];

// ---- the page --------------------------------------------------------------

export interface PageInput {
  /** The document title, without the site name, which is appended here. */
  title: string;
  /** One line for search results and link previews. */
  description: string;
  /** Stylesheets after tokens.css, which is always loaded first. */
  styles: readonly string[];
  /** The route this page answers on, for `aria-current` in the navigation. */
  current: string;
  /** The `id` of `<main>`, so each page family can style its own container. */
  mainId: string;
  /** Everything inside `<main>`. Rendered and escaped by the caller. */
  body: string;
}

export function page(input: PageInput): string {
  const name = escapeText(config.publicName);
  const nav = NAV.map(({ href, label }) => {
    const current = href === input.current ? ' aria-current="page"' : '';
    return `<a href="${escapeAttribute(href)}"${current}>${escapeText(label)}</a>`;
  }).join('');
  const styles = ['/tokens.css', ...input.styles]
    .map((href) => `\n    <link rel="stylesheet" href="${escapeAttribute(href)}" />`)
    .join('');

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeText(input.title)} · ${name}</title>
    <meta name="description" content="${escapeAttribute(input.description)}" />${styles}
    <link rel="icon" href="data:," />
  </head>
  <body>
    <header id="bar">
      <div class="brand"><a href="/"><strong>${name}</strong></a></div>
      <nav class="nav">${nav}</nav>
    </header>
    <main id="${escapeAttribute(input.mainId)}">
${input.body}
    </main>
    <footer id="foot">
      <span class="muted">An experiment, not a product.</span>
      <span class="sep">·</span>
      <a href="${REPOSITORY}">source</a>
      <span class="sep">·</span>
      <a href="${REPOSITORY}/blob/master/LICENSE">MIT</a>
    </footer>
  </body>
</html>
`;
}
