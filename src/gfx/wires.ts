/**
 * Wire background for the landing page: thin grey traces that run across the screen like the
 * copper of a circuit board, each with a signal pulse now and then.
 *
 * Three.js WebGPURenderer: WebGPU where available, WebGL2 otherwise. The wires are laid out once
 * on the CPU as buses: a route of straight segments with 45° turns, copied into 2 to 8 parallel
 * lanes like the data bus of a CPU. Every segment, and every round pad at a lane end, is one
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
  /** Number of buses. */
  count?: number;
  /** Seed of the layout. The same seed gives the same wires on every load. */
  seed?: number;
}

export interface WiresHandle {
  dispose(): void;
}

// ---------------------------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------------------------

/** The field the wires are laid in, world units. The camera shows y in [-1, 1]. */
const FIELD = { x: 2.6, y: 1.1 };
/** A point far outside the field, used to park the spotlight when there is no pointer. */
const FAR = 100;
/** Core width of a wire, CSS pixels. */
const LINE_PX = 1.4;
/** Diameter of the pad at each end of a wire, CSS pixels. */
const PAD_PX = 4.5;
/** Half extent of the quad around a segment, CSS pixels: room for the glow of a pulse. */
const HALO_PX = 10;
/** Length of a pulse, world units. */
const TAIL = 0.07;
/** Speed of a pulse, world units per second. */
const SPEED = { min: 0.22, max: 0.3 };
/** Rest between two pulses on the same wire, seconds. */
const PAUSE = { min: 2, max: 7 };

/** Number of buses. */
const BUS_COUNT = 100;
/** Lanes per bus: parallel wires that share one route and one pulse rhythm. */
const LANES = { min: 1, max: 1 };
/** Distance between two lanes of a bus, world units (about 5 px at 1000 px height). */
const LANE_PITCH = 0.009;
/** Delay of the pulse from one lane to the next, as a fraction of the cycle. */
const LANE_STAGGER = 0.006;

/** Opacity of the three parts of a wire. Each is 0..1; the sum is clamped to 1 at the pulse head. */
const OPACITY = {
  /** The resting wire: a faint grey line. */
  wire: 0.07,
  /** How much brighter the line gets where a pulse passes. */
  pulseLine: 0.2,
  /** The soft glow around the line where a pulse passes; 0 removes the glow. */
  pulseGlow: 0.2,
};
/** The spotlight around the pointer: lanes inside the radius get brighter. */
const SPOTLIGHT = {
  /** Radius, world units (0.4 is about 180 px at 1000 px height). */
  radius: 0.4,
  /** Extra opacity of a lane right under the pointer. */
  opacity: 0.3,
};
/** Colour of the resting wire, linear RGB. */
const WIRE_GREY = { r: 0.3, g: 0.31, b: 0.35 };
/** How far the pulse colour is pushed from the accent towards white, 0..1. */
const PULSE_WHITENESS = 0.2;

interface Segment {
  a: THREE.Vector2;
  b: THREE.Vector2;
  /** Distance along the wire at `a`. */
  offset: number;
  widthPx: number;
}

interface Wire {
  segments: Segment[];
  /** How far the pulse head travels per cycle: the wire, the tail, and the rest. */
  span: number;
  /** Seconds per cycle. */
  period: number;
  /** Phase of the pulse cycle, so that the buses do not pulse together. */
  seed: number;
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

/** One lane of a bus as segments and pads. Returns the segments and the length of the lane. */
function laneSegments(points: THREE.Vector2[]): { segments: Segment[]; length: number } {
  const segments: Segment[] = [];
  let offset = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    segments.push({ a, b, offset, widthPx: LINE_PX });
    offset += a.distanceTo(b);
  }
  // Round pads at both ends, as zero-length segments.
  const first = points[0]!;
  const last = points[points.length - 1]!;
  segments.push({ a: first, b: first, offset: 0, widthPx: PAD_PX });
  segments.push({ a: last, b: last, offset, widthPx: PAD_PX });
  return { segments, length: offset };
}

/**
 * One bus: 2 to 8 parallel lanes on one route. The lanes share the speed and the rest period, so
 * a pulse runs down the whole bus, each lane a little after the one before it.
 */
function layBus(random: () => number): Wire[] {
  const route = layRoute(random);
  const lanes = LANES.min + Math.floor(random() * (LANES.max - LANES.min + 1));
  const speed = SPEED.min + random() * (SPEED.max - SPEED.min);
  const pause = PAUSE.min + random() * (PAUSE.max - PAUSE.min);
  const seed = random();
  const wires: Wire[] = [];
  for (let lane = 0; lane < lanes; lane++) {
    const points = offsetRoute(route, (lane - (lanes - 1) / 2) * LANE_PITCH);
    const { segments, length } = laneSegments(points);
    const span = length + TAIL * 2 + pause * speed;
    wires.push({ segments, span, period: span / speed, seed: seed + lane * LANE_STAGGER });
  }
  return wires;
}

interface WireAttributes {
  count: number;
  /** Per instance: a.x, a.y, b.x, b.y. */
  segment: THREE.InstancedBufferAttribute;
  /** Per instance: offset along the wire, period, span, seed. */
  wire: THREE.InstancedBufferAttribute;
  /** Per instance: core width in CSS pixels. */
  width: THREE.InstancedBufferAttribute;
}

function packWires(wires: Wire[]): WireAttributes {
  const count = wires.reduce((n, wire) => n + wire.segments.length, 0);
  const segment = new Float32Array(count * 4);
  const wireData = new Float32Array(count * 4);
  const width = new Float32Array(count);
  let i = 0;
  for (const wire of wires) {
    for (const s of wire.segments) {
      segment.set([s.a.x, s.a.y, s.b.x, s.b.y], i * 4);
      wireData.set([s.offset, wire.period, wire.span, wire.seed], i * 4);
      width[i] = s.widthPx;
      i++;
    }
  }
  return {
    count,
    segment: new THREE.InstancedBufferAttribute(segment, 4),
    wire: new THREE.InstancedBufferAttribute(wireData, 4),
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
}

function makeMaterial(attributes: WireAttributes, accent: THREE.Color, u: Uniforms) {
  const aSegment = instancedBufferAttribute<'vec4'>(attributes.segment, 'vec4');
  const aWire = instancedBufferAttribute<'vec4'>(attributes.wire, 'vec4');
  const aWidth = instancedBufferAttribute<'float'>(attributes.width, 'float');

  // The quad: the segment from a to b, extended by the halo at both ends and both sides.
  const a = aSegment.xy;
  const diff = aSegment.zw.sub(a);
  const len = length(diff);
  const dir = select(len.greaterThan(1e-5), diff.div(max(len, 1e-5)), vec2(1, 0));
  const normal = vec2(dir.y.negate(), dir.x);
  const ext = u.pxToWorld.mul(HALO_PX);
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
  const halo = smoothstep(0, HALO_PX, distancePx).oneMinus().pow(2);

  // The pulse: a head that runs along the wire with an exponential tail, then rests.
  const t = time.mul(u.motion);
  const alongWire = aWire.x.add(onSegment);
  const cycle = fract(t.div(aWire.y).add(aWire.w));
  const head = cycle.mul(aWire.z).sub(TAIL);
  const behind = head.sub(alongWire);
  const pulse = exp(max(behind, 0).div(-TAIL)).mul(step(0, behind)).mul(u.motion);

  const grey = vec3(WIRE_GREY.r, WIRE_GREY.g, WIRE_GREY.b);
  const glow = mix(vec3(accent.r, accent.g, accent.b), vec3(1), PULSE_WHITENESS);
  // The spotlight: 1 under the pointer, 0 at the radius, smooth in between.
  const nearPointer = smoothstep(0, SPOTLIGHT.radius, length(point.sub(u.spotlight))).oneMinus();

  const restingLine = core.mul(OPACITY.wire);
  const litLine = core.mul(nearPointer).mul(SPOTLIGHT.opacity);
  const pulseLine = core.mul(pulse).mul(OPACITY.pulseLine);
  const pulseGlow = halo.mul(pulse).mul(OPACITY.pulseGlow);
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
  };
  const random = seededRandom(options.seed ?? DEFAULT_SEED);
  const wires = Array.from({ length: options.count ?? BUS_COUNT }, () => layBus(random)).flat();
  const attributes = packWires(wires);
  const material = makeMaterial(attributes, new THREE.Color(options.accent), uniforms);
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
