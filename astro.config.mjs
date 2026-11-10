// @ts-check
import { defineConfig } from 'astro/config';

import tailwindcss from '@tailwindcss/vite';
import sitemap from '@astrojs/sitemap';

import mdx from '@astrojs/mdx';
import { satteri } from '@astrojs/markdown-satteri';
import { headingAnchors } from './src/markdown/headingAnchors';

// https://astro.build/config
export default defineConfig({
  site: 'https://akirathan.dev',
  vite: {
    plugins: [tailwindcss()],
  },
  markdown: {
    processor: satteri({ hastPlugins: [headingAnchors] }),
  },
  integrations: [sitemap(), mdx()],
});
