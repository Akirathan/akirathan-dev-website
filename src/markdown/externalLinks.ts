import type { Element, ElementContent } from 'hast';
import type { HastPluginEntry } from 'satteri';

/** Id of the generated section; `ArticleLayout.astro` keeps its heading out of the outline. */
export const REFERENCES_ID = 'references';

const SITE_HOST = 'akirathan.dev';

const NEW_TAB = { target: '_blank', rel: 'noreferrer' };

interface Reference {
  url: string;
  name: string;
}

function externalUrl(href: unknown): URL | undefined {
  if (typeof href !== 'string' || !/^https?:\/\//.test(href)) {
    return undefined;
  }
  const url = URL.parse(href);
  if (!url || url.hostname === SITE_HOST || url.hostname.endsWith(`.${SITE_HOST}`)) {
    return undefined;
  }
  return url;
}

function text(value: string): ElementContent {
  return { type: 'text', value };
}

function el(tagName: string, className: string, children: ElementContent[], props = {}): Element {
  return {
    type: 'element',
    tagName,
    properties: { className: className.split(' '), ...props },
    children,
  };
}

function referencesSection(references: Reference[]): Element {
  const items = references.map(({ url, name }) =>
    el('li', 'my-0 pl-1', [
      el('a', 'external-link text-muted hover:text-paper', [text(name)], { href: url, ...NEW_TAB }),
      el('span', 'block truncate text-xs text-muted/70', [text(url.replace(/^https?:\/\//, ''))]),
    ]),
  );
  return el('section', 'not-prose mt-16 text-sm text-muted', [
    el('hr', 'mb-8 border-muted/25', []),
    el(
      'h2',
      'mb-4 font-heading text-lg font-semibold tracking-tight text-muted',
      [text('References')],
      {
        id: REFERENCES_ID,
      },
    ),
    el('ol', 'list-decimal space-y-3 pl-5 marker:text-muted/70', items),
  ]);
}

/**
 * Marks links that leave the site with `external-link` (an arrow, styled in `global.css`) and
 * lists them in a References section at the end of the document.
 */
export const externalLinks: HastPluginEntry = () => {
  const references = new Map<string, Reference>();
  return {
    name: 'external-links',
    element: {
      filter: ['a'],
      visit(node, ctx) {
        const url = externalUrl(node.properties?.href);
        if (!url) {
          return;
        }
        const existing = node.properties?.className;
        const classes = Array.isArray(existing) ? existing : [];
        ctx.setProperty(node, 'className', [...classes, 'external-link']);
        ctx.setProperty(node, 'target', NEW_TAB.target);
        ctx.setProperty(node, 'rel', NEW_TAB.rel);
        if (!references.has(url.href)) {
          const name = ctx.textContent(node).trim() || url.hostname;
          references.set(url.href, { url: url.href, name });
        }
      },
    },
    after(root, ctx) {
      if (references.size > 0) {
        ctx.appendChild(root, referencesSection([...references.values()]));
      }
    },
  };
};
