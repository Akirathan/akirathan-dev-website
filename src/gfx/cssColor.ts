/**
 * Resolves a CSS colour to a hex string through a 2D canvas. The theme uses oklch(), which
 * THREE.Color cannot parse.
 */
export function cssColorToHex(cssColor: string, fallback: string): string {
  try {
    const ctx = document.createElement('canvas').getContext('2d');
    if (!ctx) return fallback;
    ctx.fillStyle = cssColor;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return `#${[r, g, b].map((c) => c!.toString(16).padStart(2, '0')).join('')}`;
  } catch {
    return fallback;
  }
}

/** Reads a custom property from `:root` and resolves it to hex. */
export function themeColorHex(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value ? cssColorToHex(value, fallback) : fallback;
}
