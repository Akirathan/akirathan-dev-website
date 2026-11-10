/**
 * Wires of the contact board: from trace ends at the edge of the CPU (top view) to a connector at
 * the near edge of each contact card. Wires run with 45° turns, like the article outline. All
 * sizes are CSS pixels in the coordinates of the board; the SVG fills the board 1:1.
 */
import type { ScreenTraceEnd } from './cpu';

/** Trace ends between two used ones, so that the pads do not crowd. */
const PAD_STEP = 2;
/** Gap from the chip edge to the first turn, and between two parallel turns. */
const LANE = { gap: 14, pitch: 8 };
const CHAMFER = 8;
const CONNECTOR = { width: 5, height: 14 };

export type Side = 'left' | 'right';

export interface WireTarget {
  side: Side;
  /** The edge of the card that faces the chip, and its vertical centre. */
  x: number;
  y: number;
}

/** Picks one trace end per target on each side, centred on that side and in top-down order. */
export function pickTraceEnds(ends: ScreenTraceEnd[], targets: WireTarget[]): number[] {
  const picked = new Array<number>(targets.length).fill(-1);
  for (const side of ['left', 'right'] as const) {
    const sign = side === 'left' ? -1 : 1;
    const candidates = ends
      .map((end, i) => ({ end, i }))
      .filter(({ end }) => end.dx * sign > 0.7)
      .sort((a, b) => a.end.y - b.end.y);
    const wanted = targets
      .map((t, i) => ({ t, i }))
      .filter(({ t }) => t.side === side)
      .sort((a, b) => a.t.y - b.t.y);
    const centre = (candidates.length - 1) / 2;
    wanted.forEach(({ i }, k) => {
      const at = Math.round(centre + (k - (wanted.length - 1) / 2) * PAD_STEP);
      picked[i] = candidates[Math.min(Math.max(at, 0), candidates.length - 1)]?.i ?? -1;
    });
  }
  return picked;
}

export interface Wire {
  d: string;
  connector: { x: number; y: number; width: number; height: number };
}

/**
 * Wires for all targets. `starts` are the trace ends in board coordinates, one per target.
 * Wires that go up turn in order from the top card, wires that go down from the bottom card,
 * so that no two wires on one side cross.
 */
export function routeWires(starts: { x: number; y: number }[], targets: WireTarget[]): Wire[] {
  const wires = new Array<Wire>(targets.length);
  for (const side of ['left', 'right'] as const) {
    const dir = side === 'left' ? -1 : 1;
    const order = targets
      .map((_, i) => i)
      .filter((i) => targets[i].side === side)
      .sort((a, b) => targets[a].y - targets[b].y);
    if (order.length === 0) {
      continue;
    }
    const edge = dir * Math.max(...order.map((i) => dir * starts[i].x));
    const n = order.length;
    order.forEach((i, k) => {
      const start = starts[i];
      const t = targets[i];
      const rank = t.y < start.y ? k : n - 1 - k;
      const turnX = edge + dir * (LANE.gap + rank * LANE.pitch);
      const end = t.x - dir * CONNECTOR.width;
      wires[i] = {
        d: wirePath(dir, start.x, start.y, turnX, end, t.y),
        connector: {
          x: dir > 0 ? end : t.x,
          y: t.y - CONNECTOR.height / 2,
          width: CONNECTOR.width,
          height: CONNECTOR.height,
        },
      };
    });
  }
  return wires;
}

/** Horizontal, a 45° turn, vertical, a 45° turn back, horizontal to the connector. */
function wirePath(dir: number, x0: number, y0: number, turnX: number, x1: number, y1: number) {
  const dy = y1 - y0;
  if (Math.abs(dy) < 0.5) {
    return `M${x0} ${y0}H${x1}`;
  }
  const s = Math.sign(dy);
  const c = Math.min(CHAMFER, Math.abs(dy) / 2);
  return (
    `M${x0} ${y0}H${turnX}` +
    `L${turnX + dir * c} ${y0 + s * c}` +
    `V${y1 - s * c}` +
    `L${turnX + dir * 2 * c} ${y1}` +
    `H${x1}`
  );
}
