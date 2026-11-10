# akirathan.dev

Personal portfolio website of Pavel Marek, served at https://akirathan.dev.

The site exists to support a job search, so it should stand out: customized visuals, GPU-driven
animations (Three.js with WebGPU), and interactions that do not look like a template portfolio.
Visual ambition matters, but it must never cost content, accessibility, or first-load performance.

## Design direction

The reference for the _amount_ of motion is https://www.shopify.com/editions/fall2026. That is the
ceiling, not the floor. Game-like portfolios (3D worlds, corridors, loading screens) are explicitly
not wanted: text content must always be one click away and easy to read.

- Landing page: short texts with bullets, more effects than text. Long, article-like texts live on
  detail pages reached by click-through.
- One stable background. The background may react (pointer, scroll) and may shift colour between
  sections, but only subtly. No drastic per-section colour changes.
- Colours: subtle and elegant, dark base, never a clear white background, nothing that screams.
  No flashing or strobing of any kind.
- Fonts: "Baloo 2" for headings, Montserrat for body text (self-hosted via `@fontsource-variable`).
  Do not introduce other display fonts for running text.
- No audio. Never add sound effects, music, or autoplay media with sound.

## Stack

- **Astro 7**, static output only (`output: 'static'`, the default). No SSR, no server endpoints:
  the host is GitHub Pages.
- **TypeScript** in strict mode (`astro/tsconfigs/strict`).
- **Tailwind CSS v4** via `@tailwindcss/vite`. Theme tokens live in `src/styles/global.css`
  under `@theme`. There is no `tailwind.config.*` file.
- **@astrojs/sitemap** generates `sitemap-index.xml` from `site` in `astro.config.mjs`.
- **Three.js** (`three`, `@types/three`) for GPU visuals, loaded lazily on the client only.
- **Fonts:** `@fontsource-variable/baloo-2` and `@fontsource-variable/montserrat`, imported in
  `global.css`; exposed as `font-heading` and `font-sans` utilities through `@theme`.
- **Prettier** with `prettier-plugin-astro` and `prettier-plugin-tailwindcss` (sorts classes).
- Node.js 24 (`.nvmrc`). Astro 7 needs Node >= 22.23.4.

## Commands

Run `nvm use` first: the shell default Node may be too old for Astro.

```sh
npm run dev           # dev server on localhost:4321
npm run build         # static build to dist/
npm run preview       # serve dist/
npm run check         # astro check (type errors in .astro and .ts)
npm run format        # prettier --write .
npm run format:check
```

When starting the dev server as an agent, use background mode: `npx astro dev --background`,
then manage it with `npx astro dev stop | status | logs`.

Before considering a change done, run `npm run check` and `npm run build`. There is no CI, so
these local runs are the only check.

## Structure

```text
cad/                 FeatureScript sources of CAD models (Onshape); cad/export/ = raw exports
scripts/             build helpers run by hand (model:cpu)
public/              static files copied as-is (favicon, CNAME)
src/
  pages/             routes (file-based routing)
  layouts/           page shells; BaseLayout.astro holds <head>, meta, global CSS
  components/        Astro components (and framework islands, if one is added)
  styles/global.css  Tailwind import, @theme tokens, base layer
  assets/            images imported by components; assets/skills/<slug>.png = skill icons
  content/           MDX articles (experience/, topics/, skills/), validated by src/content.config.ts
  data/skills.ts     skills as keywords; experience tags must match a skill label exactly
  gfx/               Three.js / shader code, loaded lazily on the client
```

`/skills` lists every skill as a card (`SkillCard.astro`) grouped by category, with the work
entries that use it. Elsewhere a skill is a small chip (`SkillChip.astro`). Experience tags
render as chips that link to `/skills#<slug>`; an unknown tag fails the build (`skillByLabel`
throws). A skill gets a long-form note by adding
`src/content/skills/<slug>.mdx`: the chip then links to `/skills/<slug>` from everywhere. A
skill gets an icon by adding `src/assets/skills/<slug>.png` (256 px, transparent; official
logos only). A note whose file name matches no slug fails the build. A skill gets an expertise
meter in its card on `/skills` by setting `expertise` (integer 1-10) in `skills.ts`; the
segments fill with a CSS animation when the card comes into view (an `IntersectionObserver` in
`skills.astro` sets `data-inview` on the list item; the cards rise on the same signal).

Article pages with two or more `h2` headings get an outline in the left gutter from the `lg`
breakpoint (`Outline.astro`, drawn by `src/gfx/outline.ts`): an SVG chip with one wire per
heading, 45° turns. The item of the section in view, or under the pointer, gets `data-on`; CSS
lights its wire, runs the pulses, and plays the shared `trace-border` (also used by
`SkillCard.astro`, defined in `global.css`).

`cad/*.fs` is the source of truth for custom features in the owner's Onshape documents.
FeatureScript runs only on Onshape servers: compile it with the `onshape-fs` MCP server
(`test_feature`, one API call per run, from a yearly allocation of 2 500), then the owner pastes
the file into the Feature Studio by hand and exports glTF from the Part Studio. Do not spend
API calls on bookkeeping tools when a test is all that is needed.

CPU model pipeline: the owner exports the Part Studio as glTF to `cad/export/CPU.gltf`
(git-ignored, 13 MB). `npm run model:cpu` (`scripts/build-cpu-model.mjs`) drops the pins and the
`TraceEnd` marker parts, merges primitives, compresses with meshopt, and writes
`public/models/cpu.glb` (about 60 KB) plus `src/data/cpu-model.json` (trace end points, metres,
Z up). `src/gfx/cpu.ts` loads the GLB, assigns TSL materials by part name (Substrate, Lid,
Traces, Capacitors), projects the lid print and the substrate weave from position (CAD meshes
have no UVs), and draws
the pins as one instanced mesh. The `CAD` constant there mirrors the feature's defaults.

## Text content editing

This section documents how an agent should interact with the content (text) provided by Pavel.
Relevant files:
- Pretty much all `*.mdx` and `*.md` files.
  - With the obvious exception of `CLAUDE.md`.
- Other source files that contain text (not code) provided by Pavel.

One of the promises of this project is that **vast majority, if not all, text was created by Pavel
from his own experiences and opinions**.
Unless told otherwise, an agent can only:
- Fix typos and grammar.
- Reword sentences and paragraphs if the text retains its meaning.
- An agent can, for example, split a sentence into multiple sentences, or vice versa, if the underlying meaning is retained.

Whenever making changes to the text content, you can commit, but ensure that the commit contains
"Co-Authored by Claude". I want all the AI text changes to be traceable.


## Conventions

- Style with Tailwind utility classes in markup. Add custom CSS only for what utilities cannot
  express (keyframes, `@property`, scroll-driven animations, complex selectors), and keep it in
  `global.css` or a component `<style>` block.
- Prefer Astro components and zero client JavaScript. Add a UI framework island only when a
  component genuinely needs client state; discuss before adding one.
- Prefer CSS (transitions, `@keyframes`, `animation-timeline`, `@starting-style`) for UI motion.
  Use JavaScript only when CSS cannot do it.
- The site uses Astro's `<ClientRouter />` (client-side navigation). A component `<script>`
  therefore runs once per visit, not once per page: start work in an `astro:page-load` listener
  and dispose it in `astro:before-swap`. See `PhotoSwipe.astro`. `Background.astro` is the
  exception: its canvas has `transition:persist`, so the wires (`src/gfx/wires.ts`) run across
  navigations; `<body data-background="full|quiet">` picks the mode per page, and every
  navigation plays the wire burst (`astro:before-preparation`). Page content uses Astro's
  default cross-fade.
- Content (text, project entries, links) belongs in content collections, not hard-coded deep
  inside visual components. Articles are **MDX** files in `src/content/experience/` and
  `src/content/topics/`, validated by the schemas in `src/content.config.ts`. MDX lets an
  article import Astro components (for example from `src/components/mdx/`) for custom layout or
  effects inside the text. In MDX, `{`, `}` and `<` in prose must be escaped or put in code spans.

## Graphics and animation rules

Heavy visuals are progressive enhancement. The page must be complete and readable without them.

- Feature-detect before loading GPU code: WebGPU (`navigator.gpu`), then a WebGL2 fallback, then
  a static fallback (image, gradient, or nothing).
- Never put Three.js or shader code in the initial bundle. Load it with dynamic `import()` after
  the page is interactive (or when the element enters the viewport).
- Pause render loops when the canvas is off-screen (`IntersectionObserver`) and when the tab is
  hidden (`visibilitychange`).
- Respect `prefers-reduced-motion`: show a still frame or a calmer variant, never full motion.
- GPU canvases are decorative: `aria-hidden="true"`, `pointer-events: none` unless interactive,
  and never the only place important content appears.
- Cap device pixel ratio for full-screen canvases (around 2) and test on a mid-range phone.

## Deployment

- The site is not published yet, and GitHub Pages is off. Do not enable it until the owner asks.
- Do not add GitHub Actions workflows (no CI, no deploy workflow): the owner's Actions quota is
  limited. Deployment will be decided at launch.
- Custom domain `akirathan.dev` (registered at Cloudflare). `public/CNAME` must keep containing
  exactly `akirathan.dev`. DNS: apex `A` records to the GitHub Pages IPs (185.199.108.153,
  185.199.109.153, 185.199.110.153, 185.199.111.153), and `www` as a `CNAME` to
  `<user>.github.io`.
- The repository is public. Never commit secrets, `.env` files, or private personal data.

## Documentation

- Astro: https://docs.astro.build (routing, components, content collections, styling)
- Tailwind CSS v4: https://tailwindcss.com/docs
- Three.js WebGPU renderer and TSL: https://threejs.org/docs

```

```
