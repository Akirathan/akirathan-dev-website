/**
 * Wire background for the landing page: thin grey traces that run across the screen like the
 * copper of a circuit board, each with a signal pulse now and then.
 *
 * Three.js WebGPURenderer: WebGPU where available, WebGL2 otherwise. The wires are laid out once
 * on the CPU as straight segments with 45° turns. Every segment, and every round pad at a wire
 * end, is one instance of a quad. The fragment shader draws the line as a signed distance field
 * inside the quad, so it stays about one and a half pixels wide at any resolution and the joins
 * are round. The pulses need only the time uniform: each wire has its own speed and rest period.
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
  /** Number of wires. */
  count?: number;
}

export interface WiresHandle {
  dispose(): void;
}

// ---------------------------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------------------------

/** The field the wires are laid in, world units. The camera shows y in [-1, 1]. */
const FIELD = { x: 2.6, y: 1.1 };
/** Core width of a wire, CSS pixels. */
const LINE_PX = 1.4;
/** Diameter of the pad at each end of a wire, CSS pixels. */
const PAD_PX = 4.5;
/** Half extent of the quad around a segment, CSS pixels: room for the glow of a pulse. */
const HALO_PX = 7;
/** Length of a pulse, world units. */
const TAIL = 0.14;
/** Speed of a pulse, world units per second. */
const SPEED = { min: 0.22, max: 0.42 };
/** Rest between two pulses on the same wire, seconds. */
const PAUSE = { min: 2, max: 7 };

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
  /** Phase, 0..1, so that the wires do not pulse together. */
  seed: number;
}

/** One wire: a random walk of 3 to 8 straight segments, turning by 0° or ±45° between them. */
function layWire(): Wire {
  let heading = Math.floor(Math.random() * 8);
  let at = new THREE.Vector2((Math.random() * 2 - 1) * FIELD.x, (Math.random() * 2 - 1) * FIELD.y);
  const segments: Segment[] = [];
  let offset = 0;
  const steps = 3 + Math.floor(Math.random() * 6);
  for (let i = 0; i < steps; i++) {
    const len = 0.12 + Math.random() * 0.55;
    const angle = (heading * Math.PI) / 4;
    const end = new THREE.Vector2(at.x + Math.cos(angle) * len, at.y + Math.sin(angle) * len);
    segments.push({ a: at, b: end, offset, widthPx: LINE_PX });
    offset += len;
    at = end;
    if (Math.abs(at.x) > FIELD.x || Math.abs(at.y) > FIELD.y) break;
    const turn = Math.random();
    heading = (heading + (turn < 0.3 ? 7 : turn < 0.6 ? 1 : 0)) % 8;
  }
  const wireLength = offset;
  // Round pads at both ends, as zero-length segments.
  segments.push({ a: segments[0]!.a, b: segments[0]!.a, offset: 0, widthPx: PAD_PX });
  segments.push({ a: at, b: at, offset: wireLength, widthPx: PAD_PX });

  const speed = SPEED.min + Math.random() * (SPEED.max - SPEED.min);
  const pause = PAUSE.min + Math.random() * (PAUSE.max - PAUSE.min);
  const span = wireLength + TAIL * 2 + pause * speed;
  return { segments, span, period: span / speed, seed: Math.random() };
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
  pointer: ReturnType<typeof vec2Uniform>;
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

  const grey = vec3(0.3, 0.31, 0.35);
  const glow = mix(vec3(accent.r, accent.g, accent.b), vec3(1), 0.3);
  const alpha = clamp(
    core.mul(0.16).add(core.mul(pulse).mul(0.8)).add(halo.mul(pulse).mul(0.3)),
    0,
    1,
  );
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
    motion: floatUniform(options.reducedMotion ? 0 : 1),
  };
  const wires = Array.from({ length: options.count ?? 34 }, layWire);
  const attributes = packWires(wires);
  const material = makeMaterial(attributes, new THREE.Color(options.accent), uniforms);
  const mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), material, attributes.count);
  mesh.frustumCulled = false;
  scene.add(mesh);

  // The pointer is smoothed on the CPU so that the wires follow with a little lag.
  const targetPointer = new THREE.Vector2();
  const onPointerMove = (e: PointerEvent) => {
    targetPointer.set(
      (e.clientX / window.innerWidth) * 2 - 1,
      -((e.clientY / window.innerHeight) * 2 - 1),
    );
  };

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
      document.removeEventListener('visibilitychange', onVisibility);
      mesh.geometry.dispose();
      material.dispose();
      renderer.dispose();
    },
  };
}
