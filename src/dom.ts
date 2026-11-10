/**
 * Attribute names that tie markup to client scripts. Markup sets them with `attr()`, scripts
 * find elements with `selector()` and read values with `getAttribute()`.
 *
 * `states` are set by scripts and read by styles. Tailwind variants (`data-ready:`,
 * `group-data-wired:`) and CSS cannot import these constants, so the same names also appear
 * literally in class names and in `global.css`.
 */
export const hooks = {
  /** The canvas of `CpuScene.astro`. */
  cpuScene: 'data-cpu-scene',
  /** Lid print of a CPU scene, as JSON. */
  cpuText: 'data-cpu-text',
  /** The root of a wired board (`src/gfx/wiredBoard.ts`). */
  wiredBoard: 'data-wired-board',
  /** Media query from which a wired board draws its wires. */
  wiresFrom: 'data-wires-from',
  /** The SVG that holds the wires of a board. */
  boardWires: 'data-board-wires',
  /** A card on a wired board: `left`, `right`, or `bottom` of the chip. */
  wireSide: 'data-wire-side',
} as const;

export const states = {
  /** A canvas has drawn its first frame. */
  ready: 'data-ready',
  /** A wired board has drawn its wires. */
  wired: 'data-wired',
  /** The active card of a wired board, and its wire. */
  on: 'data-on',
} as const;

type Hook = (typeof hooks)[keyof typeof hooks];

/** Spread into markup: `<div {...attr(hooks.wiredBoard)} />`. */
export function attr(name: Hook, value = ''): Record<string, string> {
  return { [name]: value };
}

export function selector(name: Hook | (typeof states)[keyof typeof states], tag = ''): string {
  return `${tag}[${name}]`;
}
