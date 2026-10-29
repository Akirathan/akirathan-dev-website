import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const link = z.object({ label: z.string(), url: z.url() });

/** Work experience. One entry per employer; the body is the long-form detail page. */
const experience = defineCollection({
  loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/experience' }),
  schema: z.object({
    company: z.string(),
    role: z.string(),
    period: z.string(),
    location: z.string(),
    /** Lower comes first on the landing page. */
    order: z.number(),
    /** Short bullets shown on the landing-page card. Keep to three. */
    summary: z.array(z.string()).max(4),
    tags: z.array(z.string()).default([]),
    links: z.array(link).default([]),
    /** Minor entries are listed in one line under the main cards, without a card. */
    minor: z.boolean().default(false),
  }),
});

/** Non-work sections about me: values, AI & me, hobbies, opinions, ... */
const topics = defineCollection({
  loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/topics' }),
  schema: z.object({
    title: z.string(),
    tagline: z.string(),
    order: z.number(),
    /** Short bullets shown on the landing-page card. Keep to three. */
    summary: z.array(z.string()).max(4),
    draft: z.boolean().default(false),
  }),
});

export const collections = { experience, topics };
