/**
 * Draws the SVG of the article outline: a small CPU package and one wire from a pad on its right
 * edge to the connector in front of each item. Wires run with 45° turns, like the background
 * traces. All sizes are CSS pixels; the SVG fills the outline `nav` with a 1:1 view box.
 */

const CHIP = { x: 0, width: 36, minHeight: 40, inset: 7 };
/** Vertical distance between two pads, and horizontal distance between two parallel turns. */
const PITCH = 6;
/** Size of the 45° chamfer at each turn. */
const CHAMFER = 6;
const CONNECTOR = { width: 5, height: 12 };

export function drawOutline(svg: SVGSVGElement, nav: HTMLElement, items: HTMLElement[]): void {
  const box = nav.getBoundingClientRect();
  svg.setAttribute('viewBox', `0 0 ${box.width} ${box.height}`);
  if (items.length === 0) {
    svg.replaceChildren();
    return;
  }

  const targets = items.map((li) => {
    const r = (li.querySelector('a') ?? li).getBoundingClientRect();
    return { x: r.left - box.left, y: r.top - box.top + r.height / 2 };
  });

  const n = targets.length;
  const centreY = (targets[0].y + targets[n - 1].y) / 2;
  const chipHeight = Math.max(CHIP.minHeight, n * PITCH + 2 * CHIP.inset + 6);
  const chipTop = centreY - chipHeight / 2;
  const padYs = targets.map((_, i) => centreY + (i - (n - 1) / 2) * PITCH);
  const wireStart = CHIP.x + CHIP.width;

  // Wires that go up turn in order from the top item, wires that go down from the bottom item.
  // The outermost wire turns first, so no two wires cross.
  const upCount = targets.filter((t, i) => t.y < padYs[i] - 0.5).length;
  const lanes = Math.max(upCount, n - upCount, 1);
  const free = Math.min(...targets.map((t) => t.x)) - CONNECTOR.width - wireStart - 2 * CHAMFER - 8;
  const pitch = Math.max(2, Math.min(PITCH, free / lanes));

  const parts: string[] = [chipMarkup(chipTop, chipHeight)];
  targets.forEach((t, i) => {
    const y0 = padYs[i];
    const end = t.x - CONNECTOR.width;
    const rank = t.y < y0 ? i : n - 1 - i;
    const d = wirePath(wireStart, y0, wireStart + 6 + rank * pitch, end, t.y);
    parts.push(
      `<g data-item="${i}">` +
        `<path class="wire" d="${d}"/>` +
        `<path class="pulse" pathLength="100" d="${d}"/>` +
        `<rect class="pad" x="${wireStart - 3}" y="${y0 - 1}" width="3" height="2" rx="0.5"/>` +
        `<rect class="connector" x="${end}" y="${t.y - CONNECTOR.height / 2}" width="${CONNECTOR.width}" height="${CONNECTOR.height}" rx="1"/>` +
        `</g>`,
    );
  });

  // innerHTML on an SVG element parses the markup in the SVG namespace.
  svg.innerHTML = parts.join('');
}

/** Horizontal, a 45° turn, vertical, a 45° turn back, horizontal to the connector. */
function wirePath(x0: number, y0: number, turnX: number, x1: number, y1: number): string {
  const dy = y1 - y0;
  if (Math.abs(dy) < 0.5) {
    return `M${x0} ${y0}H${x1}`;
  }
  const s = Math.sign(dy);
  const c = Math.min(CHAMFER, Math.abs(dy) / 2);
  return (
    `M${x0} ${y0}H${turnX}` +
    `L${turnX + c} ${y0 + s * c}` +
    `V${y1 - s * c}` +
    `L${turnX + 2 * c} ${y1}` +
    `H${x1}`
  );
}

/** A package seen from above: green substrate, metal lid, and a few capacitors at the edges. */
function chipMarkup(top: number, height: number): string {
  const { x, width, inset } = CHIP;
  const lid = { x: x + inset, y: top + inset, w: width - 2 * inset, h: height - 2 * inset };
  const capacitor = (cx: number, cy: number) =>
    `<rect x="${cx - 2}" y="${cy - 1}" width="4" height="2" fill="#2a2d35"/>` +
    `<rect x="${cx - 2}" y="${cy - 1}" width="1" height="2" fill="#d9b25a" opacity="0.8"/>` +
    `<rect x="${cx + 1}" y="${cy - 1}" width="1" height="2" fill="#d9b25a" opacity="0.8"/>`;
  const capY = [top + inset / 2, top + height - inset / 2];
  const capX = [x + width * 0.3, x + width * 0.7];

  return (
    `<defs>` +
    `<pattern id="outline-weave" width="3" height="3" patternUnits="userSpaceOnUse">` +
    `<path d="M0 3L3 0" stroke="#2b5246" stroke-width="0.6"/>` +
    `</pattern>` +
    `<linearGradient id="outline-lid" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="#9aa2aa"/><stop offset="1" stop-color="#5b6168"/>` +
    `</linearGradient>` +
    `</defs>` +
    `<rect x="${x}" y="${top}" width="${width}" height="${height}" rx="3" fill="#17302a" stroke="#a89b7c" stroke-opacity="0.35" stroke-width="0.75"/>` +
    `<rect x="${x}" y="${top}" width="${width}" height="${height}" rx="3" fill="url(#outline-weave)" opacity="0.6"/>` +
    capY.flatMap((cy) => capX.map((cx) => capacitor(cx, cy))).join('') +
    `<rect x="${lid.x}" y="${lid.y}" width="${lid.w}" height="${lid.h}" rx="2" fill="url(#outline-lid)" opacity="0.8" stroke="white" stroke-opacity="0.25" stroke-width="0.5"/>` +
    `<circle cx="${lid.x + 3}" cy="${lid.y + 3}" r="1" fill="#3d4248"/>`
  );
}
