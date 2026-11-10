/**
 * A CPU seen from above with a wire to each card around it. The markup contract:
 *
 * - `[data-wired-board]`: the root, `position: relative`; `data-wires-from` holds the media query
 *   from which wires are drawn. The root gets `data-wired` once the wires are drawn.
 * - `svg[data-wires]`: fills the root.
 * - `canvas[data-cpu-scene]` (from `CpuScene.astro`, `view="top"`).
 * - `[data-wire-side="left|right|bottom"]`: the cards. The active one gets `data-on`.
 *
 * The card under the pointer or in focus is active; when idle, one card after another. The
 * active card gets a pulse along its wire, and the chip leans toward it.
 */
import type { CpuHandle, ScreenTraceEnd } from './cpu';
import { pickTraceEnds, routeWires, type Side, type WireTarget } from './boardWires';

/** One pulse period in the CSS of the wires (`global.css`). */
const PULSE_MS = 1600;
/** Time between two idle pulses. */
const IDLE_MS = 4200;

export function startWiredBoard(board: HTMLElement): () => void {
  const svg = board.querySelector<SVGSVGElement>('svg[data-wires]')!;
  const canvas = board.querySelector<HTMLCanvasElement>('canvas[data-cpu-scene]')!;
  const cards = [...board.querySelectorAll<HTMLElement>('[data-wire-side]')];
  const sides = cards.map((card) => card.dataset.wireSide as Side);
  const wide = window.matchMedia(board.dataset.wiresFrom ?? '(min-width: 64rem)');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let targets: WireTarget[] = [];
  let chip = { x: 0, y: 0, width: 0, height: 0 };
  let cpu: CpuHandle | null = null;
  let picked: number[] | null = null;
  let ends: { x: number; y: number }[] = [];
  let groups: SVGGElement[] = [];

  // Cards move (scroll reveal, hover lift) without a resize, so this runs on every frame.
  const measure = () => {
    const box = board.getBoundingClientRect();
    svg.setAttribute('viewBox', `0 0 ${box.width} ${box.height}`);
    const c = canvas.getBoundingClientRect();
    chip = { x: c.left - box.left, y: c.top - box.top, width: c.width, height: c.height };
    targets = cards.map((card, i) => {
      const r = card.getBoundingClientRect();
      const side = sides[i];
      if (side === 'bottom') {
        return { side, x: r.left + r.width / 2 - box.left, y: r.top - box.top };
      }
      return {
        side,
        x: (side === 'left' ? r.right : r.left) - box.left,
        y: r.top + r.height / 2 - box.top,
      };
    });
  };

  const build = () => {
    svg.innerHTML = cards
      .map(
        (_, i) =>
          `<g data-item="${i}"><path class="wire"/><path class="pulse" pathLength="100"/>` +
          `<rect class="connector" rx="1"/></g>`,
      )
      .join('');
    groups = [...svg.querySelectorAll<SVGGElement>('g')];
  };

  const draw = () => {
    if (!wide.matches || !picked || ends.length === 0) {
      return;
    }
    const starts = picked.map((p) => ({
      x: chip.x + (ends[p]?.x ?? 0),
      y: chip.y + (ends[p]?.y ?? 0),
    }));
    routeWires(starts, targets).forEach((wire, i) => {
      const [path, pulse, connector] = groups[i].children;
      path.setAttribute('d', wire.d);
      pulse.setAttribute('d', wire.d);
      connector.setAttribute('x', `${wire.connector.x}`);
      connector.setAttribute('y', `${wire.connector.y}`);
      connector.setAttribute('width', `${wire.connector.width}`);
      connector.setAttribute('height', `${wire.connector.height}`);
    });
  };

  const onFrame = (screen: ScreenTraceEnd[]) => {
    measure();
    picked ??= pickTraceEnds(screen, targets);
    ends = screen.map(({ x, y }) => ({ x, y }));
    draw();
    board.dataset.wired = '';
  };

  /** Full lean toward the side of the card, and part of a lean along that side. */
  const leanToward = (t: WireTarget) => {
    const cx = chip.x + chip.width / 2;
    const cy = chip.y + chip.height / 2;
    if (t.side === 'bottom') {
      return { x: (t.x - cx) / chip.width, y: 1 };
    }
    return { x: t.side === 'left' ? -1 : 1, y: (t.y - cy) / (chip.height / 3) };
  };

  let hovered: number | null = null;
  let idle: number | null = null;
  const paint = () => {
    const active = hovered ?? idle;
    cards.forEach((card, i) => card.toggleAttribute('data-on', i === active));
    groups.forEach((g, i) => g.toggleAttribute('data-on', i === active));
    const target = active === null ? undefined : targets[active];
    cpu?.lean(target ? leanToward(target) : null);
  };

  let idleIndex = -1;
  let idleOff = 0;
  const idleTimer = reducedMotion
    ? 0
    : window.setInterval(() => {
        if (hovered !== null || document.hidden || board.dataset.wired === undefined) {
          return;
        }
        idleIndex = (idleIndex + 1) % cards.length;
        idle = idleIndex;
        paint();
        idleOff = window.setTimeout(() => {
          idle = null;
          paint();
        }, PULSE_MS);
      }, IDLE_MS);

  const listeners = cards.map((card, i) => {
    const enter = () => {
      hovered = i;
      paint();
    };
    const leave = () => {
      hovered = null;
      paint();
    };
    card.addEventListener('pointerenter', enter);
    card.addEventListener('pointerleave', leave);
    card.addEventListener('focusin', enter);
    card.addEventListener('focusout', leave);
    return () => {
      card.removeEventListener('pointerenter', enter);
      card.removeEventListener('pointerleave', leave);
      card.removeEventListener('focusin', enter);
      card.removeEventListener('focusout', leave);
    };
  });

  let unsubscribe: (() => void) | null = null;
  const onReady = (event: Event) => {
    build();
    measure();
    cpu = (event as CustomEvent<CpuHandle>).detail;
    unsubscribe = cpu.onFrameChange(onFrame);
  };
  canvas.addEventListener('cpu:ready', onReady, { once: true });

  // Without a render loop (reduced motion), only a resize moves the cards.
  const resize = new ResizeObserver(() => {
    measure();
    draw();
  });
  resize.observe(board);

  return () => {
    canvas.removeEventListener('cpu:ready', onReady);
    unsubscribe?.();
    cpu = null;
    resize.disconnect();
    window.clearInterval(idleTimer);
    window.clearTimeout(idleOff);
    listeners.forEach((remove) => remove());
  };
}
