/**
 * A CPU seen from above with a wire to each card around it. The markup contract, with the
 * attribute names from `src/dom.ts`:
 *
 * - `hooks.wiredBoard`: the root, `position: relative`. `hooks.wiresFrom` holds the media query
 *   from which wires are drawn. The root gets `states.wired` once the wires are drawn.
 * - `hooks.boardWires`: an SVG that fills the root.
 * - A `CpuScene.astro` inside the root.
 * - `hooks.wireSide` (`left`, `right`, or `bottom`): the cards. The active one gets `states.on`.
 *
 * The card under the pointer or in focus is active; when idle, one card after another. The
 * active card gets a pulse along its wire, and the chip leans toward it.
 */
import type { CpuHandle, ScreenTraceEnd } from './cpu';
import { hooks, selector, states } from '../dom';
import { pickTraceEnds, routeWires, type Side, type WireTarget } from './boardWires';

/**
 * The pulse on a wire: a dash of `dash` px at `speed` px/s, so short wires get it sooner. After
 * each run the wire rests for `rest` ms, so that the connector of a short wire does not flash
 * fast. The connector flashes white when the head arrives: up in `flashIn`, down in `flashOut`.
 */
const PULSE = { dash: 42, speed: 410, rest: 600, flashIn: 50, flashOut: 350 };
/** How long the chip leans toward an idle card when the board has no wires. */
const IDLE_LEAN_MS = 1600;
/** Time between two idle pulses. */
const IDLE_MS = 4200;

export function startWiredBoard(board: HTMLElement): () => void {
  const svg = board.querySelector<SVGSVGElement>(selector(hooks.boardWires, 'svg'))!;
  const canvas = board.querySelector<HTMLCanvasElement>(selector(hooks.cpuScene, 'canvas'))!;
  const cards = [...board.querySelectorAll<HTMLElement>(selector(hooks.wireSide))];
  const sides = cards.map((card) => card.getAttribute(hooks.wireSide) as Side);
  const wide = window.matchMedia(board.getAttribute(hooks.wiresFrom) ?? '(min-width: 64rem)');
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
          `<g data-item="${i}"><path class="wire"/><path class="pulse"/>` +
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
    board.setAttribute(states.wired, '');
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

  let pulses: Animation[] = [];
  const stopPulse = () => {
    pulses.forEach((animation) => animation.cancel());
    pulses = [];
  };

  /** Starts the repeating pulse on wire `i`. Returns its period in ms, or 0 without wires. */
  const startPulse = (i: number): number => {
    stopPulse();
    const group = groups[i];
    if (reducedMotion || !group) {
      return 0;
    }
    const [, pulse, connector] = group.children as unknown as [
      SVGPathElement,
      SVGPathElement,
      SVGRectElement,
    ];
    const length = pulse.getTotalLength();
    if (length === 0) {
      return 0;
    }
    const { dash, speed, rest, flashIn, flashOut } = PULSE;
    const arrive = (length / speed) * 1000;
    const travel = ((length + dash) / speed) * 1000;
    const period = travel + rest;
    // One dash, and a gap longer than the wire, so that only one dash shows at a time.
    pulse.style.strokeDasharray = `${dash} ${length + dash}`;
    pulses.push(
      pulse.animate(
        [
          { strokeDashoffset: dash, offset: 0 },
          { strokeDashoffset: -length, offset: travel / period },
          { strokeDashoffset: -length, offset: 1 },
        ],
        { duration: period, iterations: Infinity },
      ),
    );
    // Not the computed fill of the connector: its CSS transition to the accent may still run.
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--color-accent');
    pulses.push(
      connector.animate(
        [
          { fill: accent, offset: 0 },
          { fill: accent, offset: arrive / period },
          { fill: 'white', offset: (arrive + flashIn) / period },
          { fill: accent, offset: (arrive + flashIn + flashOut) / period },
          { fill: accent, offset: 1 },
        ],
        { duration: period, iterations: Infinity },
      ),
    );
    return period;
  };

  let hovered: number | null = null;
  let idle: number | null = null;
  let lit: number | null = null;
  /** Lights the active card and its wire. Returns the pulse period of that wire in ms. */
  const paint = (): number => {
    const active = hovered ?? idle;
    cards.forEach((card, i) => card.toggleAttribute(states.on, i === active));
    groups.forEach((g, i) => g.toggleAttribute(states.on, i === active));
    const target = active === null ? undefined : targets[active];
    cpu?.lean(target ? leanToward(target) : null);
    if (active === lit) {
      return 0;
    }
    lit = active;
    if (active === null) {
      stopPulse();
      return 0;
    }
    return startPulse(active);
  };

  let idleIndex = -1;
  let idleOff = 0;
  const idleTimer = reducedMotion
    ? 0
    : window.setInterval(() => {
        if (hovered !== null || document.hidden || !board.hasAttribute(states.wired)) {
          return;
        }
        idleIndex = (idleIndex + 1) % cards.length;
        idle = idleIndex;
        // One run of the pulse. Without wires (narrow screens), only the lean shows.
        const period = paint();
        idleOff = window.setTimeout(() => {
          idle = null;
          paint();
        }, period || IDLE_LEAN_MS);
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
    stopPulse();
    listeners.forEach((remove) => remove());
  };
}
