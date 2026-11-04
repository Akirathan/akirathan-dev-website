/**
 * A full-screen curtain for page transitions, made of lanes.
 *
 * The screen is cut into many thin horizontal lanes, grouped into buses like the wires of the
 * background. On `cover()` the lanes sweep in from one edge, the lanes of a bus one after the
 * other and the buses in a random order, while an ink backdrop fades in behind them and a few
 * quick pulses race along random lanes. The page swap happens behind the cover. On `reveal()`
 * the lanes leave on the far side, with a few more pulses, and the backdrop fades out.
 *
 * Both phases together take about 1.2 s. Three.js WebGPURenderer with a WebGL2 fallback; the
 * shader is TSL on one full-screen quad.
 */
import * as THREE from 'three/webgpu';
import {
  clamp,
  exp,
  float,
  floor,
  fract,
  hash,
  max,
  mix,
  select,
  smoothstep,
  step,
  uniform,
  uv,
  vec3,
} from 'three/tsl';

export interface PageCurtainOptions {
  /** Colour of the backdrop that hides the page. */
  color: THREE.ColorRepresentation;
  /** Colour of the lanes. */
  lineColor: THREE.ColorRepresentation;
  /** Colour of the pulses. */
  pulseColor: THREE.ColorRepresentation;
  /** Length of one phase, cover or reveal. */
  durationMs?: number;
}

export interface PageCurtainHandle {
  /** Sweep in. +1 from the left, -1 from the right. Resolves when the page is fully covered. */
  cover(direction: 1 | -1): Promise<void>;
  /** Sweep out on the far side. Resolves when the page is fully visible again. */
  reveal(): Promise<void>;
  dispose(): void;
}

/** Height of one lane, CSS pixels. */
const LANE_PX = 9;
/** Thickness of the line in each lane, CSS pixels. */
const LINE_PX = 1;
/** Lanes per bus. The lanes of a bus start one after the other. */
const BUS = 6;
/** Delay from one lane of a bus to the next, as a share of the screen width. */
const STAGGER = 0.03;
/** Largest random delay of a whole bus, as a share of the screen width. */
const SCATTER = 0.3;
/** How far a lane front travels for progress 1: the full width plus every delay. */
const REACH = 1 + SCATTER + (BUS - 1) * STAGGER + 0.02;
/** Pulses per phase. */
const PULSES = 5;
/** Speed of a pulse, screen widths per phase. */
const PULSE_SPEED = 2.6;
/** Length of the tail behind a pulse head, as a share of the screen width. */
const PULSE_TAIL = 0.14;
/** Opacity of a lane line. */
const LINE_OPACITY = 0.5;

const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

export async function startPageCurtain(
  canvas: HTMLCanvasElement,
  options: PageCurtainOptions,
): Promise<PageCurtainHandle> {
  const duration = options.durationMs ?? 600;

  const renderer = new THREE.WebGPURenderer({ canvas, antialias: false, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x000000, 0);
  await renderer.init();

  // progress runs 0 -> 1 while covering and 1 -> 2 while revealing.
  const uProgress = uniform(0);
  const uDirection = uniform(1);
  const uSeed = uniform(0);
  const uLanes = uniform(80);
  /** The line as a share of the lane height. */
  const uLine = uniform(0.11);

  const revealing = uProgress.greaterThanEqual(1);
  const phase = select(revealing, uProgress.sub(1), uProgress);

  const base = uv();
  const along = select(uDirection.greaterThan(0), base.x, base.x.oneMinus());
  const lane = floor(base.y.mul(uLanes));
  const laneFrac = fract(base.y.mul(uLanes));
  const bus = floor(lane.div(BUS));
  const laneInBus = lane.sub(bus.mul(BUS));
  const delay = hash(bus.add(uSeed)).mul(SCATTER).add(laneInBus.mul(STAGGER));

  // The lane front: on cover the line exists behind it, on reveal in front of it, so that a
  // line enters from one edge and leaves at the other.
  const front = phase.mul(REACH).sub(delay);
  const laneOn = select(revealing, step(front, along), step(along, front));
  const line = step(laneFrac, uLine);

  // The backdrop fades in early on cover and out late on reveal, so the lanes lead both times.
  const backdrop = select(
    revealing,
    smoothstep(0.3, 0.85, phase).oneMinus(),
    smoothstep(0.0, 0.5, phase),
  );

  // A few quick pulses on random lanes, different ones in each phase.
  let pulse: THREE.Node<'float'> = float(0);
  for (let k = 0; k < PULSES; k++) {
    const pick = hash(uSeed.add(k * 7.31).add(select(revealing, 101, 0)));
    const pulseLane = floor(pick.mul(uLanes));
    const start = hash(uSeed.add(k * 3.17).add(select(revealing, 53, 0))).mul(0.35);
    const head = phase.sub(start).mul(PULSE_SPEED);
    const behind = head.sub(along);
    const shape = exp(max(behind, 0).div(-PULSE_TAIL)).mul(smoothstep(-0.004, 0, behind));
    pulse = pulse.add(select(lane.equal(pulseLane), shape, 0));
  }
  pulse = clamp(pulse, 0, 1);

  const toVec3 = (c: THREE.ColorRepresentation) => {
    const color = new THREE.Color(c);
    return vec3(color.r, color.g, color.b);
  };
  const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
  const lineHere = laneOn.mul(line);
  const withLines = mix(toVec3(options.color), toVec3(options.lineColor), lineHere.mul(0.8));
  material.colorNode = mix(
    withLines,
    toVec3(options.pulseColor),
    pulse.mul(line.mul(0.6).add(0.4)),
  );
  material.opacityNode = max(max(backdrop, lineHere.mul(LINE_OPACITY)), pulse.mul(0.9));

  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material));

  const resize = () => {
    const { clientWidth: w, clientHeight: h } = canvas;
    if (w === 0 || h === 0) return;
    renderer.setSize(w, h, false);
    const lanes = Math.max(12, Math.round(h / LANE_PX));
    uLanes.value = lanes;
    uLine.value = LINE_PX / (h / lanes);
  };
  window.addEventListener('resize', resize);

  const animate = (from: number, to: number) =>
    new Promise<void>((resolve) => {
      resize();
      canvas.style.visibility = 'visible';
      const start = performance.now();
      const tick = (now: number) => {
        const t = Math.min((now - start) / duration, 1);
        uProgress.value = from + (to - from) * easeInOutCubic(t);
        renderer.render(scene, camera);
        if (t < 1) requestAnimationFrame(tick);
        else resolve();
      };
      requestAnimationFrame(tick);
    });

  return {
    async cover(direction) {
      uDirection.value = direction;
      uSeed.value = Math.floor(Math.random() * 1000);
      await animate(0, 1);
    },
    async reveal() {
      await animate(1, 2);
      uProgress.value = 0;
      canvas.style.visibility = 'hidden';
    },
    dispose() {
      window.removeEventListener('resize', resize);
      material.dispose();
      renderer.dispose();
    },
  };
}
