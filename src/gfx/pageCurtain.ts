/**
 * The page transition: the wires of `wires.ts` in a denser, brighter look, drawn and erased lane
 * by lane over an ink backdrop.
 *
 * `cover()` draws every lane from its start, the lanes of a bus one after the other and the
 * buses in a random order, while the backdrop fades in and a few quick pulses run. The page swap
 * happens behind the cover. `reveal()` erases the lanes in the same order while the backdrop
 * fades out. For a backward navigation the lanes run from their other end.
 *
 * Both phases together take about 1.3 s.
 */
import { startWires, type WiresLook } from './wires';

export interface PageCurtainOptions {
  /** CSS colour of the backdrop that hides the page. */
  backdrop: string;
  /** Colour of the pulses, hex. */
  accent: string;
  /** Length of one phase, cover or reveal, in milliseconds. */
  durationMs?: number;
}

export interface PageCurtainHandle {
  /** Sweep in. +1 forward, -1 backward. Resolves when the page is fully covered. */
  cover(direction: 1 | -1): Promise<void>;
  /** Sweep out. Resolves when the page is fully visible again. */
  reveal(): Promise<void>;
  dispose(): void;
}

/** What differs from the background: buses of many lanes, a stronger line, quick rare pulses. */
const CURTAIN_LOOK: Partial<WiresLook> = {
  buses: 70,
  lanes: { min: 3, max: 8 },
  lanePitch: 0.009,
  tail: 0.1,
  speed: { min: 3, max: 5 },
  pause: { min: 6, max: 16 },
  laneStagger: 0.004,
  opacity: { wire: 0.35, pulseLine: 0.6, pulseGlow: 0.3 },
};
const CURTAIN_SEED = 7;

const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

export async function startPageCurtain(
  canvas: HTMLCanvasElement,
  options: PageCurtainOptions,
): Promise<PageCurtainHandle> {
  const duration = options.durationMs ?? 650;
  const wires = await startWires(canvas, {
    reducedMotion: false,
    accent: options.accent,
    seed: CURTAIN_SEED,
    look: CURTAIN_LOOK,
    interactive: false,
    loop: false,
  });
  wires.setDraw(0);
  wires.setErase(0);

  // The backdrop is a CSS transition on the canvas itself, under the wires.
  const fade = (to: 'in' | 'out') => {
    canvas.style.transition =
      to === 'in'
        ? `background-color ${duration * 0.8}ms ease-in`
        : `background-color ${duration * 0.7}ms ease-out ${duration * 0.25}ms`;
    canvas.style.backgroundColor = to === 'in' ? options.backdrop : 'transparent';
  };

  const animate = (apply: (progress: number) => void) =>
    new Promise<void>((resolve) => {
      const start = performance.now();
      const tick = (now: number) => {
        const t = Math.min((now - start) / duration, 1);
        apply(easeInOutCubic(t));
        wires.render();
        if (t < 1) requestAnimationFrame(tick);
        else resolve();
      };
      requestAnimationFrame(tick);
    });

  return {
    async cover(direction) {
      wires.setFlip(direction < 0);
      wires.setDraw(0);
      wires.setErase(0);
      canvas.style.visibility = 'visible';
      fade('in');
      await animate((p) => wires.setDraw(p));
    },
    async reveal() {
      fade('out');
      await animate((p) => wires.setErase(p));
      canvas.style.visibility = 'hidden';
      canvas.style.transition = '';
      canvas.style.backgroundColor = 'transparent';
    },
    dispose() {
      wires.dispose();
    },
  };
}
