/**
 * Wire background of every page: thin grey traces that run across the screen like the copper
 * of a circuit board, each with a signal pulse now and then. On navigation they play a burst:
 * long bright pulses that leave a circle at the centre of the screen.
 *
 * Three.js WebGPURenderer: WebGPU where available, WebGL2 otherwise. The wires are laid out once
 * on the CPU as buses: a route of straight segments with 45° turns, copied into 2 to 8 parallel
 * lanes like the data bus of a CPU. `WiresLook` holds every number of the look. Every segment, and every round pad at a lane end, is one
 * instance of a quad. The fragment shader draws the line as a signed distance field inside the
 * quad, so it stays about one and a half pixels wide at any resolution and the joins are round.
 * The pulses need only the time uniform: each bus has its own speed and rest period, and the
 * lanes fire one after the other.
 *
 * The instances blend with "max" instead of "add", so a wire that crosses another, or a quad
 * that overlaps its neighbour at a join, does not get brighter.
 */
import * as THREE from 'three/webgpu';
import {
  clamp,
  dot,
  exp,
  fract,
  instancedBufferAttribute,
  length,
  max,
  mix,
  select,
  smoothstep,
  step,
  time,
  uniform,
  uv,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';

export interface WiresOptions {
  /** Draw the wires once, without pulses. */
  reducedMotion: boolean;
  /** Colour of the pulses, hex. */
  accent: string;
  /** Seed of the layout. The same seed gives the same wires on every load. */
  seed?: number;
  /** Changes to the look. Give whole sub-objects, for example the whole `opacity`. */
  look?: Partial<WiresLook>;
  /** Run the signal pulses. Default true. With false the wires rest; the spotlight still works. */
  pulses?: boolean;
}

/** Everything that decides how the wires look and behave. See `BACKGROUND_LOOK` for values. */
export interface WiresLook {
  /** Number of buses. */
  buses: number;
  /** Lanes per bus: parallel wires that share one route and one pulse rhythm. */
  lanes: { min: number; max: number };
  /** Distance between two lanes of a bus, world units. The screen is 2 units high. */
  lanePitch: number;
  /** Core width of a wire, CSS pixels. */
  linePx: number;
  /** Diameter of the pad at each end of a wire, CSS pixels. */
  padPx: number;
  /** Half extent of the quad around a segment, CSS pixels: room for the glow of a pulse. */
  haloPx: number;
  /** Length of a pulse, world units. */
  tail: number;
  /** Speed of a pulse, world units per second. */
  speed: { min: number; max: number };
  /** Rest between two pulses on the same wire, seconds. */
  pause: { min: number; max: number };
  /** Delay of the pulse from one lane to the next, as a fraction of the cycle. */
  laneStagger: number;
  /** Opacity of the parts of a wire. Each is 0..1; the sum is clamped to 1 at a pulse head. */
  opacity: {
    /** The resting wire: a faint grey line. */
    wire: number;
    /** How much brighter the line gets where a pulse passes. */
    pulseLine: number;
    /** The soft glow around the line where a pulse passes; 0 removes the glow. */
    pulseGlow: number;
  };
  /** The spotlight around the pointer: lanes inside the radius get brighter. */
  spotlight: {
    /** Radius, world units. */
    radius: number;
    /** Extra opacity of a lane right under the pointer. */
    opacity: number;
  };
  /** Colour of the resting wire, linear RGB. */
  grey: { r: number; g: number; b: number };
  /** How far the pulse colour is pushed from the accent towards white, 0..1. */
  pulseWhiteness: number;
}

/** The look of the landing-page background. */
export const BACKGROUND_LOOK: WiresLook = {
  buses: 140,
  lanes: { min: 1, max: 1 },
  lanePitch: 0.009,
  linePx: 1.4,
  padPx: 4.5,
  haloPx: 10,
  tail: 0.07,
  speed: { min: 0.22, max: 0.3 },
  pause: { min: 2, max: 7 },
  laneStagger: 0.006,
  opacity: { wire: 0.07, pulseLine: 0.2, pulseGlow: 0.2 },
  spotlight: { radius: 0.4, opacity: 0.3 },
  grey: { r: 0.3, g: 0.31, b: 0.35 },
  pulseWhiteness: 0.2,
};

export interface WiresHandle {
  /** Switch the resting pulses on or off, for example when the page changes. */
  setPulses(enabled: boolean): void;
  /**
   * Play the navigation burst: the resting pulses fade out, and long bright pulses leave a
   * circle along every lane that crosses it. See `BURST`. `at` is the centre of the circle in
   * CSS pixels of the viewport, for example the last click; the default is the screen centre.
   */
  burst(at?: { x: number; y: number }): void;
  dispose(): void;
}

/** The navigation burst. Distances are world units; the screen is 2 units high. */
export const BURST = {
  /** Length of the whole burst, milliseconds. */
  ms: 1000,
  /** Radius of the circle at the centre of the screen where the pulses start. */
  radius: 0.22,
  /** How far a pulse travels from the circle before it vanishes, as at a lane end. */
  travel: 0.2,
  /** Length of a burst pulse. The resting pulses use `WiresLook.tail`. */
  tail: 0.2,
  /** Width of a burst pulse, as a multiple of the line width. */
  width: 1.3,
  /** Opacity of the line and of the glow under a burst pulse. */
  opacity: { line: 0.9, glow: 0.5 },
  /** How fast the resting pulses fade when the burst starts, per frame. */
  fade: 0.2,
};

// ---------------------------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------------------------

/** The field the wires are laid in, world units. The camera shows y in [-1, 1]. */
const FIELD = { x: 2.6, y: 1.1 };
/** A point far outside the field, used to park the spotlight when there is no pointer. */
const FAR = 100;

interface Segment {
  a: THREE.Vector2;
  b: THREE.Vector2;
  /** Distance along the wire at `a`. */
  offset: number;
  widthPx: number;
}

interface Wire {
  segments: Segment[];
  /** The lane as a polyline, kept to recompute the burst crossings for a new centre. */
  points: THREE.Vector2[];
  /** How far the pulse head travels per cycle: the wire, the tail, and the rest. */
  span: number;
  /** Seconds per cycle. */
  period: number;
  /** Phase of the pulse cycle, so that the buses do not pulse together. */
  seed: number;
  /**
   * The burst on this lane, distances along the lane, -1 = none. `out`: where the lane leaves
   * the circle; a pulse runs on from there, its tail reaching back to `outFrom` (where the lane
   * entered the circle, or the lane start). `in`: where the lane enters the circle; a pulse
   * runs back from there, its tail reaching on to `inTo` (where the lane leaves again, or the
   * lane end).
   */
  burst: { out: number; outFrom: number; in: number; inTo: number };
}

/** Layout seed used when the options give none. Change it to get a different set of wires. */
const DEFAULT_SEED = 20261104;

/** A small seeded generator (mulberry32), so that a layout can be reproduced. Returns [0, 1). */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The centre line of a bus: a random walk of 3 to 8 straight segments with 0° or ±45° turns. */
function layRoute(random: () => number): THREE.Vector2[] {
  let heading = Math.floor(random() * 8);
  const route = [new THREE.Vector2((random() * 2 - 1) * FIELD.x, (random() * 2 - 1) * FIELD.y)];
  const steps = 3 + Math.floor(random() * 6);
  for (let i = 0; i < steps; i++) {
    const len = 0.12 + random() * 0.55;
    const angle = (heading * Math.PI) / 4;
    const at = route[route.length - 1]!;
    route.push(new THREE.Vector2(at.x + Math.cos(angle) * len, at.y + Math.sin(angle) * len));
    const end = route[route.length - 1]!;
    if (Math.abs(end.x) > FIELD.x || Math.abs(end.y) > FIELD.y) break;
    const turn = random();
    heading = (heading + (turn < 0.3 ? 7 : turn < 0.6 ? 1 : 0)) % 8;
  }
  return route;
}

/** Left-hand unit normal of the segment from `a` to `b`. */
const normalOf = (a: THREE.Vector2, b: THREE.Vector2) =>
  new THREE.Vector2(a.y - b.y, b.x - a.x).normalize();

/**
 * The route shifted sideways by `distance`. Corners move along the mitre, so that the parallel
 * copy keeps the same turns and the lanes stay at a constant distance.
 */
function offsetRoute(route: THREE.Vector2[], distance: number): THREE.Vector2[] {
  return route.map((point, i) => {
    const before = i > 0 ? normalOf(route[i - 1]!, point) : null;
    const after = i < route.length - 1 ? normalOf(point, route[i + 1]!) : null;
    let shift: THREE.Vector2;
    if (before && after) {
      // Mitre: the sum of the two normals, scaled so that the distance to both segments is kept.
      shift = before
        .clone()
        .add(after)
        .multiplyScalar(1 / (1 + before.dot(after)));
    } else {
      shift = (before ?? after)!;
    }
    return point.clone().addScaledVector(shift, distance);
  });
}

/**
 * Where a lane crosses the burst circle, walking along the lane: the first point where it
 * leaves the circle and the first point where it enters it, each with the far end of the chord
 * inside the circle, so that a pulse tail can fill the chord. Distances along the lane; -1 = none.
 */
function burstCrossings(points: THREE.Vector2[], centre: THREE.Vector2): Wire['burst'] {
  const r2 = BURST.radius * BURST.radius;
  const result = { out: -1, outFrom: -1, in: -1, inTo: -1 };
  // Where the lane last entered the circle: the lane start if it begins inside.
  let lastEntry = points[0]!.distanceToSquared(centre) < r2 ? 0 : -1;
  let offset = 0;
  for (let i = 0; i < points.length - 1; i++) {
    // Relative to the centre, so that the circle is |p| = r.
    const a = points[i]!.clone().sub(centre);
    const d = points[i + 1]!.clone().sub(points[i]!);
    const len = d.length();
    // |a + t d|² = r²  ->  (d·d) t² + 2 (a·d) t + (a·a - r²) = 0
    const qa = d.dot(d);
    const qb = 2 * a.dot(d);
    const qc = a.dot(a) - r2;
    const disc = qb * qb - 4 * qa * qc;
    if (qa > 0 && disc >= 0) {
      const root = Math.sqrt(disc);
      for (const t of [(-qb - root) / (2 * qa), (-qb + root) / (2 * qa)]) {
        if (t < 0 || t > 1) continue;
        const hit = a.clone().addScaledVector(d, t);
        const s = offset + t * len;
        if (hit.dot(d) > 0) {
          // Leaving the circle.
          if (result.out < 0) {
            result.out = s;
            result.outFrom = Math.max(lastEntry, 0);
          }
          if (result.in >= 0 && result.inTo < 0) result.inTo = s;
        } else {
          // Entering the circle.
          if (result.in < 0) result.in = s;
          lastEntry = s;
        }
      }
    }
    offset += len;
  }
  // Entered and never left again: the tail may reach to the lane end.
  if (result.in >= 0 && result.inTo < 0) result.inTo = offset;
  return result;
}

/** One lane of a bus as segments and pads. Returns the segments and the length of the lane. */
function laneSegments(
  points: THREE.Vector2[],
  look: WiresLook,
): { segments: Segment[]; length: number } {
  const segments: Segment[] = [];
  let offset = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    segments.push({ a, b, offset, widthPx: look.linePx });
    offset += a.distanceTo(b);
  }
  // Round pads at both ends, as zero-length segments.
  const first = points[0]!;
  const last = points[points.length - 1]!;
  segments.push({ a: first, b: first, offset: 0, widthPx: look.padPx });
  segments.push({ a: last, b: last, offset, widthPx: look.padPx });
  return { segments, length: offset };
}

/**
 * One bus: parallel lanes on one route. The lanes share the speed and the rest period, so
 * a pulse runs down the whole bus, each lane a little after the one before it.
 */
function layBus(random: () => number, look: WiresLook): Wire[] {
  const route = layRoute(random);
  const lanes = look.lanes.min + Math.floor(random() * (look.lanes.max - look.lanes.min + 1));
  const speed = look.speed.min + random() * (look.speed.max - look.speed.min);
  const pause = look.pause.min + random() * (look.pause.max - look.pause.min);
  const seed = random();
  const wires: Wire[] = [];
  for (let lane = 0; lane < lanes; lane++) {
    const points = offsetRoute(route, (lane - (lanes - 1) / 2) * look.lanePitch);
    const { segments, length } = laneSegments(points, look);
    const span = length + look.tail * 2 + pause * speed;
    wires.push({
      segments,
      points,
      span,
      period: span / speed,
      seed: seed + lane * look.laneStagger,
      burst: burstCrossings(points, new THREE.Vector2()),
    });
  }
  return wires;
}

interface WireAttributes {
  count: number;
  /** Per instance: a.x, a.y, b.x, b.y. */
  segment: THREE.InstancedBufferAttribute;
  /** Per instance: offset along the wire, period, span, seed. */
  wire: THREE.InstancedBufferAttribute;
  /** Per instance: burst out, outFrom, in, inTo (see `Wire.burst`); -1 = none. */
  burst: THREE.InstancedBufferAttribute;
  /** Per instance: core width in CSS pixels. */
  width: THREE.InstancedBufferAttribute;
}

function packWires(wires: Wire[]): WireAttributes {
  const count = wires.reduce((n, wire) => n + wire.segments.length, 0);
  const segment = new Float32Array(count * 4);
  const wireData = new Float32Array(count * 4);
  const burst = new Float32Array(count * 4);
  const width = new Float32Array(count);
  let i = 0;
  for (const wire of wires) {
    for (const s of wire.segments) {
      segment.set([s.a.x, s.a.y, s.b.x, s.b.y], i * 4);
      wireData.set([s.offset, wire.period, wire.span, wire.seed], i * 4);
      burst.set([wire.burst.out, wire.burst.outFrom, wire.burst.in, wire.burst.inTo], i * 4);
      width[i] = s.widthPx;
      i++;
    }
  }
  return {
    count,
    segment: new THREE.InstancedBufferAttribute(segment, 4),
    wire: new THREE.InstancedBufferAttribute(wireData, 4),
    burst: new THREE.InstancedBufferAttribute(burst, 4),
    width: new THREE.InstancedBufferAttribute(width, 1),
  };
}

// ---------------------------------------------------------------------------------------------
// Material
// ---------------------------------------------------------------------------------------------

const floatUniform = (value: number) => uniform(value);
const vec2Uniform = (value: THREE.Vector2) => uniform(value);

interface Uniforms {
  /** World units per CSS pixel; depends on the canvas height. */
  pxToWorld: ReturnType<typeof floatUniform>;
  /** Smoothed pointer, -1..1 on both axes; drives the parallax. */
  pointer: ReturnType<typeof vec2Uniform>;
  /** Pointer in world units, quicker to follow; centre of the spotlight. Far away when absent. */
  spotlight: ReturnType<typeof vec2Uniform>;
  motion: ReturnType<typeof floatUniform>;
  /** Gain of the resting pulses: 1 with pulses, 0 without, in between while they fade. */
  pulses: ReturnType<typeof floatUniform>;
  /** Seconds since the burst started, or -1 when no burst runs. */
  burstTime: ReturnType<typeof floatUniform>;
}

function makeMaterial(
  attributes: WireAttributes,
  accent: THREE.Color,
  look: WiresLook,
  u: Uniforms,
) {
  const aSegment = instancedBufferAttribute<'vec4'>(attributes.segment, 'vec4');
  const aWire = instancedBufferAttribute<'vec4'>(attributes.wire, 'vec4');
  const aBurst = instancedBufferAttribute<'vec4'>(attributes.burst, 'vec4');
  const aWidth = instancedBufferAttribute<'float'>(attributes.width, 'float');

  // The quad: the segment from a to b, extended by the halo at both ends and both sides.
  const a = aSegment.xy;
  const diff = aSegment.zw.sub(a);
  const len = length(diff);
  const dir = select(len.greaterThan(1e-5), diff.div(max(len, 1e-5)), vec2(1, 0));
  const normal = vec2(dir.y.negate(), dir.x);
  const ext = u.pxToWorld.mul(look.haloPx);
  const along = uv()
    .x.mul(len.add(ext.mul(2)))
    .sub(ext);
  const across = uv().y.sub(0.5).mul(ext.mul(2));
  const point = varying(a.add(dir.mul(along)).add(normal.mul(across)));

  const material = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  material.positionNode = vec3(point.add(u.pointer.mul(0.012)), 0);

  // Distance from the fragment to the segment, in pixels, and its position along the wire.
  const rel = point.sub(a);
  const onSegment = clamp(dot(rel, dir), 0, len);
  const distancePx = length(rel.sub(dir.mul(onSegment))).div(u.pxToWorld);
  const halfCore = aWidth.mul(0.5);
  const core = smoothstep(halfCore.sub(0.4), halfCore.add(0.6), distancePx).oneMinus();
  const halo = smoothstep(0, look.haloPx, distancePx).oneMinus().pow(2);
  const wideHalf = halfCore.mul(BURST.width);
  const wideCore = smoothstep(wideHalf.sub(0.4), wideHalf.add(0.6), distancePx).oneMinus();

  // The pulse: a head that runs along the wire with an exponential tail, then rests.
  const t = time.mul(u.motion);
  const alongWire = aWire.x.add(onSegment);
  const cycle = fract(t.div(aWire.y).add(aWire.w));
  const head = cycle.mul(aWire.z).sub(look.tail);
  const behind = head.sub(alongWire);
  const resting = exp(max(behind, 0).div(-look.tail))
    .mul(step(0, behind))
    .mul(u.motion)
    .mul(u.pulses);

  // The burst: from where the lane leaves the circle a pulse runs on; from where it enters, a
  // pulse runs back. At the start the head sits on the circle and the tail fills the chord
  // inside it, so the first frame is a star. Each pulse lives only up to `travel` from the
  // circle and then vanishes, as at a lane end: the head passes the limit and the tail slides
  // out after it.
  const burstSpeed = (look.speed.min + look.speed.max) / 2;
  const burstHead = u.burstTime.mul(burstSpeed);
  const exists = (start: THREE.Node<'float'>) => step(0, start);
  const onward = aBurst.x;
  const behindOn = onward.add(burstHead).sub(alongWire);
  const withinOn = step(aBurst.y, alongWire).mul(step(alongWire, onward.add(BURST.travel)));
  const burstOn = exp(max(behindOn, 0).div(-BURST.tail))
    .mul(step(0, behindOn))
    .mul(withinOn)
    .mul(exists(onward));
  const backward = aBurst.z;
  const behindBack = alongWire.sub(backward.sub(burstHead));
  const withinBack = step(alongWire, aBurst.w).mul(step(backward.sub(BURST.travel), alongWire));
  const burstBack = exp(max(behindBack, 0).div(-BURST.tail))
    .mul(step(0, behindBack))
    .mul(withinBack)
    .mul(exists(backward));
  const burst = max(burstOn, burstBack).mul(step(0, u.burstTime));
  const pulse = max(resting, burst);

  const grey = vec3(look.grey.r, look.grey.g, look.grey.b);
  const glow = mix(vec3(accent.r, accent.g, accent.b), vec3(1), look.pulseWhiteness);
  // The spotlight: 1 under the pointer, 0 at the radius, smooth in between.
  const nearPointer = smoothstep(
    0,
    look.spotlight.radius,
    length(point.sub(u.spotlight)),
  ).oneMinus();

  const restingLine = core.mul(look.opacity.wire);
  const litLine = core.mul(nearPointer).mul(look.spotlight.opacity);
  const pulseLine = core
    .mul(resting)
    .mul(look.opacity.pulseLine)
    .add(wideCore.mul(burst).mul(BURST.opacity.line));
  const pulseGlow = halo
    .mul(resting)
    .mul(look.opacity.pulseGlow)
    .add(halo.mul(burst).mul(BURST.opacity.glow));
  const alpha = clamp(restingLine.add(litLine).add(pulseLine).add(pulseGlow), 0, 1);
  const rgb = mix(grey, glow, clamp(pulse.mul(1.5), 0, 1));
  // Premultiplied, for the max blending below.
  material.colorNode = vec4(rgb.mul(alpha), alpha);

  material.blending = THREE.CustomBlending;
  material.blendEquation = THREE.MaxEquation;
  material.blendSrc = THREE.OneFactor;
  material.blendDst = THREE.OneFactor;
  material.blendEquationAlpha = THREE.MaxEquation;
  material.blendSrcAlpha = THREE.OneFactor;
  material.blendDstAlpha = THREE.OneFactor;
  return material;
}

// ---------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------

export async function startWires(
  canvas: HTMLCanvasElement,
  options: WiresOptions,
): Promise<WiresHandle> {
  const look: WiresLook = { ...BACKGROUND_LOOK, ...options.look };

  const renderer = new THREE.WebGPURenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x000000, 0);
  await renderer.init();

  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  camera.position.z = 1;

  const uniforms: Uniforms = {
    pxToWorld: floatUniform(0.002),
    pointer: vec2Uniform(new THREE.Vector2()),
    spotlight: vec2Uniform(new THREE.Vector2(FAR, FAR)),
    motion: floatUniform(options.reducedMotion ? 0 : 1),
    pulses: floatUniform(options.pulses === false ? 0 : 1),
    burstTime: floatUniform(-1),
  };
  let pulsesEnabled = options.pulses !== false;
  /** `performance.now()` when the burst started, or -1. */
  let burstStart = -1;
  const random = seededRandom(options.seed ?? DEFAULT_SEED);
  const wires = Array.from({ length: look.buses }, () => layBus(random, look)).flat();
  const attributes = packWires(wires);
  const material = makeMaterial(attributes, new THREE.Color(options.accent), look, uniforms);
  const mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), material, attributes.count);
  mesh.frustumCulled = false;
  scene.add(mesh);

  // The pointer is smoothed on the CPU so that the wires follow with a little lag. The
  // spotlight follows faster, in world units: x spans ±aspect, y spans ±1.
  const targetPointer = new THREE.Vector2();
  const targetSpotlight = new THREE.Vector2(FAR, FAR);
  const onPointerMove = (e: PointerEvent) => {
    const x = (e.clientX / window.innerWidth) * 2 - 1;
    const y = -((e.clientY / window.innerHeight) * 2 - 1);
    targetPointer.set(x, y);
    targetSpotlight.set(x * (canvas.clientWidth / canvas.clientHeight), y);
  };
  const onPointerLeave = () => targetSpotlight.set(FAR, FAR);

  const resize = () => {
    const { clientWidth: w, clientHeight: h } = canvas;
    renderer.setSize(w, h, false);
    camera.left = -w / h;
    camera.right = w / h;
    camera.updateProjectionMatrix();
    uniforms.pxToWorld.value = 2 / h;
  };
  resize();

  const renderOnce = () => renderer.render(scene, camera);

  let running = false;
  const frame = () => {
    uniforms.pointer.value.lerp(targetPointer, 0.04);
    uniforms.spotlight.value.lerp(targetSpotlight, 0.2);
    const bursting = burstStart >= 0 && performance.now() - burstStart < BURST.ms;
    if (!bursting) burstStart = -1;
    uniforms.burstTime.value = bursting ? (performance.now() - burstStart) / 1000 : -1;
    // The resting pulses fade out for the burst and come back after it.
    const gainTarget = pulsesEnabled && !bursting ? 1 : 0;
    const gain = uniforms.pulses.value;
    uniforms.pulses.value = gain + (gainTarget - gain) * BURST.fade;
    renderOnce();
  };
  const start = () => {
    if (running || options.reducedMotion) return;
    running = true;
    void renderer.setAnimationLoop(frame);
  };
  const stop = () => {
    if (!running) return;
    running = false;
    void renderer.setAnimationLoop(null);
  };

  const onVisibility = () => (document.hidden ? stop() : start());
  const visible = new IntersectionObserver(([entry]) => (entry?.isIntersecting ? start() : stop()));

  window.addEventListener('resize', resize);
  window.addEventListener('pointermove', onPointerMove, { passive: true });
  document.addEventListener('pointerleave', onPointerLeave);
  document.addEventListener('visibilitychange', onVisibility);
  visible.observe(canvas);

  renderOnce();
  start();

  return {
    setPulses(enabled) {
      pulsesEnabled = enabled;
    },
    burst(at) {
      if (options.reducedMotion) return;
      // The centre in world units: x spans ±aspect, y spans ±1, the origin is the screen centre.
      const { clientWidth: w, clientHeight: h } = canvas;
      const centre = at
        ? new THREE.Vector2(((at.x / w) * 2 - 1) * (w / h), -((at.y / h) * 2 - 1))
        : new THREE.Vector2();
      // Recompute the crossings for every lane and upload them; the shader reads the attribute.
      const data = attributes.burst.array as Float32Array;
      let i = 0;
      for (const wire of wires) {
        const b = burstCrossings(wire.points, centre);
        for (let k = 0; k < wire.segments.length; k++) {
          data.set([b.out, b.outFrom, b.in, b.inTo], i * 4);
          i++;
        }
      }
      attributes.burst.needsUpdate = true;
      burstStart = performance.now();
    },
    dispose() {
      stop();
      visible.disconnect();
      window.removeEventListener('resize', resize);
      window.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerleave', onPointerLeave);
      document.removeEventListener('visibilitychange', onVisibility);
      mesh.geometry.dispose();
      material.dispose();
      renderer.dispose();
    },
  };
}
