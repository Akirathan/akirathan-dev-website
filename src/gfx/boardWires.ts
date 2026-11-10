/**
 * Wires of a wired board: from trace ends at the edge of the CPU (top view) to a connector at
 * the near edge of each card. Wires run with 45° turns, like the article outline. All sizes are
 * CSS pixels in the coordinates of the board; the SVG fills the board 1:1.
 *
 * Routing works in a frame turned to the side: `out` points away from the chip, `along` runs
 * parallel to the chip edge. That way one algorithm serves the left, right, and bottom sides.
 */
import type { ScreenTraceEnd } from './cpu';

/** Trace ends between two used ones, so that the pads do not crowd. */
const PAD_STEP = 2;
/** Gap from the chip edge to the first turn, and between two parallel turns. */
const LANE = { gap: 14, pitch: 8 };
const CHAMFER = 8;
const CONNECTOR = { depth: 5, length: 14 };

export type Side = 'left' | 'right' | 'bottom';

export interface WireTarget {
  side: Side;
  /** The middle of the card edge that faces the chip. */
  x: number;
  y: number;
}

export interface Wire {
  d: string;
  connector: { x: number; y: number; width: number; height: number };
}

interface Frame {
  /** Board point to (out, along). */
  to(p: { x: number; y: number }): { out: number; along: number };
  /** (out, along) to a board point. */
  from(out: number, along: number): { x: number; y: number };
  /** The screen direction away from the chip, to pick the trace ends of this side. */
  outward(end: ScreenTraceEnd): number;
}

const FRAMES: Record<Side, Frame> = {
  left: {
    to: ({ x, y }) => ({ out: -x, along: y }),
    from: (out, along) => ({ x: -out, y: along }),
    outward: (end) => -end.dx,
  },
  right: {
    to: ({ x, y }) => ({ out: x, along: y }),
    from: (out, along) => ({ x: out, y: along }),
    outward: (end) => end.dx,
  },
  bottom: {
    to: ({ x, y }) => ({ out: y, along: x }),
    from: (out, along) => ({ x: along, y: out }),
    outward: (end) => end.dy,
  },
};

const SIDES: Side[] = ['left', 'right', 'bottom'];

/** Picks one trace end per target on each side, centred on that side and in matching order. */
export function pickTraceEnds(ends: ScreenTraceEnd[], targets: WireTarget[]): number[] {
  const picked = new Array<number>(targets.length).fill(-1);
  for (const side of SIDES) {
    const frame = FRAMES[side];
    const candidates = ends
      .map((end, i) => ({ along: frame.to(end).along, outward: frame.outward(end), i }))
      .filter(({ outward }) => outward > 0.7)
      .sort((a, b) => a.along - b.along);
    const wanted = targets
      .map((t, i) => ({ along: frame.to(t).along, side: t.side, i }))
      .filter((t) => t.side === side)
      .sort((a, b) => a.along - b.along);
    const centre = (candidates.length - 1) / 2;
    wanted.forEach(({ i }, k) => {
      const at = Math.round(centre + (k - (wanted.length - 1) / 2) * PAD_STEP);
      picked[i] = candidates[Math.min(Math.max(at, 0), candidates.length - 1)]?.i ?? -1;
    });
  }
  return picked;
}

/**
 * Wires for all targets. `starts` are the trace ends in board coordinates, one per target.
 * Wires that turn one way are ranked from the first card, wires that turn the other way from
 * the last card, so that no two wires on one side cross.
 */
export function routeWires(starts: { x: number; y: number }[], targets: WireTarget[]): Wire[] {
  const wires = new Array<Wire>(targets.length);
  for (const side of SIDES) {
    const frame = FRAMES[side];
    const order = targets
      .map((_, i) => i)
      .filter((i) => targets[i].side === side)
      .sort((a, b) => frame.to(targets[a]).along - frame.to(targets[b]).along);
    if (order.length === 0) {
      continue;
    }
    const edge = Math.max(...order.map((i) => frame.to(starts[i]).out));
    const n = order.length;
    order.forEach((i, k) => {
      const start = frame.to(starts[i]);
      const target = frame.to(targets[i]);
      const rank = target.along < start.along ? k : n - 1 - k;
      const turn = edge + LANE.gap + rank * LANE.pitch;
      const end = target.out - CONNECTOR.depth;
      const points = wirePoints(start.out, start.along, turn, end, target.along);
      const d = points
        .map(([out, along], j) => {
          const p = frame.from(out, along);
          return `${j === 0 ? 'M' : 'L'}${p.x} ${p.y}`;
        })
        .join('');
      const a = frame.from(end, target.along - CONNECTOR.length / 2);
      const b = frame.from(target.out, target.along + CONNECTOR.length / 2);
      wires[i] = {
        d,
        connector: {
          x: Math.min(a.x, b.x),
          y: Math.min(a.y, b.y),
          width: Math.abs(b.x - a.x),
          height: Math.abs(b.y - a.y),
        },
      };
    });
  }
  return wires;
}

/** Out from the chip, a 45° turn, along the edge, a 45° turn back, out to the connector. */
function wirePoints(out0: number, along0: number, turn: number, out1: number, along1: number) {
  const delta = along1 - along0;
  if (Math.abs(delta) < 0.5) {
    return [
      [out0, along0],
      [out1, along0],
    ];
  }
  const s = Math.sign(delta);
  const c = Math.min(CHAMFER, Math.abs(delta) / 2);
  return [
    [out0, along0],
    [turn, along0],
    [turn + c, along0 + s * c],
    [turn + c, along1 - s * c],
    [turn + 2 * c, along1],
    [out1, along1],
  ];
}
