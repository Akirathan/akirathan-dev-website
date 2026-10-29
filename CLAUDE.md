# akirathan.dev

Personal portfolio website of Pavel Marek, served at https://akirathan.dev.

The site exists to support a job search, so it should stand out: heavily customized visuals,
GPU-driven animations (WebGPU, likely via Three.js), and interactions that do not look like a
template portfolio. Visual ambition is the point, but it must never cost content, accessibility,
or first-load performance.

## Stack

- **Astro 7**, static output only (`output: 'static'`, the default). No SSR, no server endpoints:
  the host is GitHub Pages.
- **TypeScript** in strict mode (`astro/tsconfigs/strict`).
- **Tailwind CSS v4** via `@tailwindcss/vite`. Theme tokens live in `src/styles/global.css`
  under `@theme`. There is no `tailwind.config.*` file.
- **@astrojs/sitemap** generates `sitemap-index.xml` from `site` in `astro.config.mjs`.
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
public/              static files copied as-is (favicon, CNAME)
src/
  pages/             routes (file-based routing)
  layouts/           page shells; BaseLayout.astro holds <head>, meta, global CSS
  components/        Astro components (and framework islands, if one is added)
  styles/global.css  Tailwind import, @theme tokens, base layer
```

Add new top-level folders under `src/` only with a clear purpose, for example `src/gfx/` for
GPU/shader code and `src/content/` for content collections (projects, posts).

## Conventions

- Style with Tailwind utility classes in markup. Add custom CSS only for what utilities cannot
  express (keyframes, `@property`, scroll-driven animations, complex selectors), and keep it in
  `global.css` or a component `<style>` block.
- Prefer Astro components and zero client JavaScript. Add a UI framework island only when a
  component genuinely needs client state; discuss before adding one.
- Prefer CSS (transitions, `@keyframes`, `animation-timeline`, `@starting-style`) for UI motion.
  Use JavaScript only when CSS cannot do it.
- Content (text, project entries, links) belongs in data or content collections, not hard-coded
  deep inside visual components.

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
