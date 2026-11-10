import Slugger from 'github-slugger';
import type { HastPluginEntry } from 'satteri';

/**
 * Makes each `h2` a link to itself, so a click gives the permalink of the section.
 *
 * User hast plugins run before Astro's heading-ids plugin, so the ids do not exist yet. This
 * plugin gives every heading its id with the same slugger in the same order; Astro keeps an id
 * that is already set, so both agree.
 */
export const headingAnchors: HastPluginEntry = () => {
  const slugger = new Slugger();
  return {
    name: 'heading-anchors',
    element: {
      filter: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'],
      visit(node, ctx) {
        const existing = node.properties?.id;
        const id = typeof existing === 'string' ? existing : slugger.slug(ctx.textContent(node));
        const hasLink = node.children.some((c) => c.type === 'element' && c.tagName === 'a');
        if (node.tagName !== 'h2' || hasLink) {
          ctx.setProperty(node, 'id', id);
          return;
        }
        ctx.replaceNode(node, {
          ...node,
          properties: { ...node.properties, id },
          children: [
            {
              type: 'element',
              tagName: 'a',
              properties: { href: `#${id}`, className: ['heading-anchor'] },
              children: node.children,
            },
          ],
        });
      },
    },
  };
};
