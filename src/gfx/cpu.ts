/**
 * The CPU package, seen from straight above (the Work section and the contact page).
 *
 * The body comes from CAD: `public/models/cpu.glb`, built by `scripts/build-cpu-model.mjs`
 * from the Onshape export of `cad/cpu-package.fs`. It holds the substrate, the lid, the gold
 * traces, and the capacitors, each as a named mesh. The 656 pins are not in the file: they
 * are one instanced mesh drawn here, so that the GPU can move and light every pin on its own.
 *
 * It tilts with the pointer and leans toward the active card of its board (`lean()`). A warm
 * light drifts over the lid, and a signal pulse runs out along the traces now and then.
 *
 * Three.js WebGPURenderer with a WebGL2 fallback; materials are TSL node materials. The CAD
 * meshes have no usable UVs, so textures are projected from local position.
 *
 * Reading guide: `startCpu()` at the bottom wires everything. Materials for the CAD parts are
 * in `dressModel()` and the `*Dressing()` functions above it, the pins in `makePins()`, and the
 * animation inputs in `Timeline`.
 */
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import {
  abs,
  bumpMap,
  color,
  float,
  fract,
  instancedBufferAttribute,
  length,
  max,
  mix,
  normalLocal,
  positionGeometry,
  positionLocal,
  select,
  smoothstep,
  texture,
  time,
  uniform,
  uv,
  vec3,
} from 'three/tsl';
import modelInfo from '../data/cpu-model.json';

// ---------------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------------

export interface CpuOptions {
  /** Freeze all motion and render one frame only. */
  reducedMotion: boolean;
  /** Glow colour of the signal pulses, hex. */
  accent: string;
  /** CSS font-family for the etched text. */
  headingFont: string;
  /** Etched into the lid: one large word, or three lines from large to small. */
  text: [string] | [string, string, string];
}

/** Where a trace meets the substrate edge, in the chip's frame (scene units, Y up). */
export interface TraceEnd {
  /** 0 = +X, 1 = +Z, 2 = -X, 3 = -Z side of the chip, in scene axes. */
  side: number;
  index: number;
  position: THREE.Vector3;
  /** Unit vector pointing away from the chip. */
  outward: THREE.Vector3;
}

/** A trace end as it appears on the canvas in the current frame. */
export interface ScreenTraceEnd {
  end: TraceEnd;
  /** CSS pixels from the top-left corner of the canvas. */
  x: number;
  y: number;
  /** `outward` on the screen, unit length. */
  dx: number;
  dy: number;
}

/** Gets one array that is reused for every call: copy what must outlive the call. */
export type FrameListener = (ends: ScreenTraceEnd[]) => void;

/** How far to lean on each screen axis, -1..1 (Y down); 1 is the full `LEAN`. */
export interface LeanTarget {
  x: number;
  y: number;
}

export interface CpuHandle {
  /** The 56 trace ends, for paths that continue outside the chip. */
  traceEnds: TraceEnd[];
  /** Calls `listener` after each rendered frame and after a resize. Returns the unsubscribe. */
  onFrameChange(listener: FrameListener): () => void;
  /** Tilts the chip toward a direction on the screen; `null` returns it to rest. */
  lean(toward: LeanTarget | null): void;
  dispose(): void;
}

// ---------------------------------------------------------------------------------------------
// Dimensions
// ---------------------------------------------------------------------------------------------

/** The CAD model is in metres with Z up. One metre becomes this many scene units. */
const MODEL_SCALE = 50;

/** CAD dimensions the page needs, in metres. They mirror the defaults in cad/cpu-package.fs. */
const CAD = {
  packageSize: 0.04,
  packageThickness: 0.0016,
  lidSize: 0.028,
  pinsPerSide: 26,
  emptyCentre: 8,
  pinPitch: 0.00127,
  pinLength: 0.003,
};

/** Pins in scene units. Slightly thicker than the CAD 0.35 mm, so that they read on screen. */
const PINS = {
  perSide: CAD.pinsPerSide,
  emptyCentre: CAD.emptyCentre,
  pitch: CAD.pinPitch * MODEL_SCALE,
  length: CAD.pinLength * MODEL_SCALE,
  radius: 0.011,
};

/** Camera height for a square canvas; the package fills about 70 % of it. */
const CAMERA_DISTANCE = 5.4;
/** Largest tilt toward the pointer, radians (about 6°). */
const POINTER_TILT = 0.1;
/** Largest tilt toward the active card, per axis, radians (about 10°). */
const LEAN = 0.17;
const LIGHT = { key: 1.4, glint: 2.5, environment: 0.3 };
/** The moving light: height above the lid, and its reach to the sides. */
const GLINT = { height: 1.6, drift: 1.1, follow: 1.8 };

const MODEL_URL = `${import.meta.env.BASE_URL}models/cpu.glb`;
/** Size of one repeat of the weave tile on the substrate, metres (8 cells of 0.4 mm). */
const WEAVE_TILE = 0.0032;
/** Copper layers that show as lines on the side faces of the substrate. */
const LAMINATE_LAYERS = 4;

// ---------------------------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------------------------

const floatUniform = (value: number) => uniform(value);

/**
 * The animation inputs that the shaders read.
 *
 * - `motion` is 1 normally and 0 under reduced motion; it freezes the time-based effects.
 * - `seconds` is the shader clock, already multiplied by `motion`.
 */
interface Timeline {
  motion: ReturnType<typeof floatUniform>;
  seconds: THREE.Node<'float'>;
}

function createTimeline(reducedMotion: boolean): Timeline {
  const motion = floatUniform(reducedMotion ? 0 : 1);
  return { motion, seconds: time.mul(motion) };
}

/** A short bright front with a soft tail, as a function of a phase in 0..1. */
const pulseBand = (phase: THREE.Node<'float'>) =>
  smoothstep(0, 0.05, phase).mul(smoothstep(0.32, 0.05, phase));

// ---------------------------------------------------------------------------------------------
// Renderer, camera, and light
// ---------------------------------------------------------------------------------------------

async function createRenderer(canvas: HTMLCanvasElement): Promise<THREE.WebGPURenderer> {
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x000000, 0);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  await renderer.init();
  return renderer;
}

function createCamera(): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 50);
  // Up must be set before lookAt; the camera looks along it otherwise.
  camera.up.set(0, 0, -1);
  camera.position.set(0, CAMERA_DISTANCE, 0);
  camera.lookAt(0, -0.05, 0);
  return camera;
}

/** Keeps the whole package in view on a canvas that is taller than wide. */
function fitCamera(camera: THREE.PerspectiveCamera): void {
  camera.position.y = CAMERA_DISTANCE * Math.max(1, 1 / camera.aspect);
}

/** A warm key light, a cool rim light, and the accent colour glowing up from under the pins. */
function addLights(scene: THREE.Scene, accent: THREE.Color): THREE.DirectionalLight {
  scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x0b0e14, 0.5));

  const key = new THREE.DirectionalLight(0xfff4e6, LIGHT.key);
  key.position.set(-3, 5, 2);
  scene.add(key);

  const rim = new THREE.DirectionalLight(0xcfe0ff, 1.0);
  rim.position.set(4, 2, -4);
  scene.add(rim);

  const under = new THREE.PointLight(accent, 6, 4, 2);
  under.position.set(0, -0.9, 0);
  scene.add(under);
  return key;
}

/** A warm point light close above the chip. Its highlight moves across the brushed lid. */
function addGlint(scene: THREE.Scene): THREE.PointLight {
  const glint = new THREE.PointLight(0xfff4e6, LIGHT.glint, 8, 2);
  glint.position.set(0, GLINT.height, 0);
  scene.add(glint);
  return glint;
}

/** Soft studio reflections for the metal. Returns a dispose function. */
function addEnvironment(scene: THREE.Scene, renderer: THREE.WebGPURenderer) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  try {
    const env = pmrem.fromScene(new RoomEnvironment(), 0.04);
    scene.environment = env.texture;
    scene.environmentIntensity = LIGHT.environment;
  } catch {
    // Lights only.
  }
  return () => {
    scene.environment?.dispose();
    pmrem.dispose();
  };
}

// ---------------------------------------------------------------------------------------------
// The CAD model: load, place, and give each part its material
// ---------------------------------------------------------------------------------------------

/** Loads the GLB. Meshopt is the compression used by scripts/build-cpu-model.mjs. */
async function loadModel(): Promise<THREE.Group> {
  await MeshoptDecoder.ready;
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const gltf = await loader.loadAsync(MODEL_URL);
  const model = gltf.scene;
  // Metres and Z up in the file; scene units and Y up here.
  model.rotation.x = -Math.PI / 2;
  model.scale.setScalar(MODEL_SCALE);
  model.updateMatrix();
  return model;
}

function partOf(model: THREE.Object3D, name: string): THREE.Mesh {
  const part = model.getObjectByName(name);
  if (!(part instanceof THREE.Mesh)) throw new Error(`CPU model has no mesh "${name}"`);
  return part;
}

/** Brushed metal with etched text, drawn once on a 2D canvas. */
function drawLidTexture(options: CpuOptions): THREE.CanvasTexture {
  const size = 1024;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  // Base metal.
  const base = ctx.createLinearGradient(0, 0, size, size);
  base.addColorStop(0, '#9aa3ab');
  base.addColorStop(0.5, '#b7bec5');
  base.addColorStop(1, '#8e969e');
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, size, size);

  // Brushed grain: many faint horizontal lines.
  ctx.lineWidth = 1;
  for (let i = 0; i < 2200; i++) {
    const y = Math.random() * size;
    const w = 80 + Math.random() * 500;
    const x = Math.random() * (size - w);
    ctx.strokeStyle = Math.random() < 0.5 ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.07)';
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + w, y);
    ctx.stroke();
  }

  // Etched frame and pin-1 mark in a corner.
  const etch = 'rgba(25,30,38,';
  ctx.strokeStyle = `${etch}0.45)`;
  ctx.lineWidth = 3;
  ctx.strokeRect(70, 70, size - 140, size - 140);
  ctx.fillStyle = `${etch}0.6)`;
  ctx.beginPath();
  ctx.moveTo(96, size - 96);
  ctx.lineTo(150, size - 96);
  ctx.lineTo(96, size - 150);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = `${etch}0.78)`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (options.text.length === 1) {
    ctx.font = `800 260px ${options.headingFont}`;
    ctx.fillText(options.text[0], size / 2, size / 2 + 20);
    return lidTexture(canvas);
  }
  const [big, mid, small] = options.text;
  ctx.font = `800 118px ${options.headingFont}`;
  ctx.fillText(big.toUpperCase(), size / 2, 400);
  ctx.font = `600 78px ${options.headingFont}`;
  ctx.fillText(mid, size / 2, 530);
  ctx.font = `600 40px ${options.headingFont}`;
  ctx.letterSpacing = '10px';
  ctx.fillText(small.toUpperCase(), size / 2, 640);
  return lidTexture(canvas);
}

function lidTexture(canvas: HTMLCanvasElement): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/**
 * One repeating tile of the fibreglass weave under the solder mask: a plain weave of light
 * and dark bundles plus a fine speckle. Grey only; it drives roughness and bump, not colour.
 */
function drawWeaveTexture(): THREE.CanvasTexture {
  const size = 256;
  const cells = 8;
  const cell = size / cells;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const image = ctx.createImageData(size, size);
  const data = image.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = Math.floor(x / cell);
      const j = Math.floor(y / cell);
      // Alternate cells carry a horizontal or a vertical bundle; each bundle is rounded,
      // so its brightness falls off towards the two long edges.
      const across = (i + j) % 2 === 0 ? (y % cell) / cell : (x % cell) / cell;
      const bundle = Math.sin(across * Math.PI);
      const speckle = (Math.random() - 0.5) * 0.18;
      const value = 0.5 + (bundle - 0.6) * 0.35 + speckle;
      const byte = Math.round(Math.min(1, Math.max(0, value)) * 255);
      const k = (y * size + x) * 4;
      data[k] = data[k + 1] = data[k + 2] = byte;
      data[k + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
}

/** A UV set from local X and Y, 0..1 across `size`. For CAD meshes, which ship without UVs. */
function planarUv(geometry: THREE.BufferGeometry, size: number): THREE.BufferAttribute {
  const position = geometry.getAttribute('position');
  const uvs = new Float32Array(position.count * 2);
  for (let i = 0; i < position.count; i++) {
    uvs[i * 2] = position.getX(i) / size + 0.5;
    uvs[i * 2 + 1] = position.getY(i) / size + 0.5;
  }
  return new THREE.BufferAttribute(uvs, 2);
}

/** A material for one CAD part, together with the textures that only it uses. */
interface Dressing {
  material: THREE.Material;
  dispose(): void;
}

const disposeAll =
  (...items: { dispose(): void }[]) =>
  () =>
    items.forEach((item) => item.dispose());

/**
 * Substrate: a fibreglass laminate under a matte green solder mask. The weave shows through
 * the mask as grain in the roughness and as a faint bump. The side faces show the laminate
 * itself: cream glass cloth with the dark lines of the inner copper layers.
 */
function substrateDressing(): Dressing {
  const weave = drawWeaveTexture();
  const weaveUv = positionLocal.xy.div(WEAVE_TILE);
  const weaveSample = texture(weave, weaveUv).r; // 0..1, 0.5 = flat
  const isSide = abs(normalLocal.z).lessThan(0.3);

  const maskColor = mix(color(0x142a24), color(0x1b3a30), weaveSample);
  const layer = fract(positionLocal.z.div(CAD.packageThickness / LAMINATE_LAYERS));
  const copperLine = smoothstep(0.4, 0.46, abs(layer.sub(0.5))); // thin band at each layer boundary
  const sideColor = mix(color(0xa89b7c), color(0x55391f), copperLine);

  const material = new THREE.MeshStandardNodeMaterial({ metalness: 0.05 });
  material.colorNode = select(isSide, sideColor, maskColor);
  material.roughnessNode = select(isSide, float(0.7), weaveSample.sub(5));
  material.normalNode = bumpMap(texture(weave, weaveUv), select(isSide, float(0), float(0.004)));
  return { material, dispose: disposeAll(material, weave) };
}

/** Lid: brushed metal, with the printed texture projected on the top face only. */
function lidDressing(lidMesh: THREE.Mesh, options: CpuOptions): Dressing {
  const print = drawLidTexture(options);
  const isTopFace = normalLocal.z.greaterThan(0.9);
  const printUv = positionLocal.xy.div(CAD.lidSize).add(0.5);

  const material = new THREE.MeshPhysicalNodeMaterial({ roughness: 0.3, metalness: 0.92 });
  material.colorNode = select(isTopFace, texture(print, printUv).rgb, vec3(0.62, 0.66, 0.7));
  material.roughnessNode = select(isTopFace, float(0.28), float(0.4));
  // Brushed steel: the highlight stretches along the grain. Anisotropy needs a tangent frame,
  // which Three.js derives from UVs; the CAD mesh has none, so project a planar one.
  lidMesh.geometry.setAttribute('uv', planarUv(lidMesh.geometry, CAD.lidSize));
  material.anisotropy = 0.6;
  return { material, dispose: disposeAll(material, print) };
}

/** Traces: gold, with a pulse that runs from the lid out to the edge now and then. */
function tracesDressing(timeline: Timeline, accent: THREE.Color): Dressing {
  const material = new THREE.MeshStandardNodeMaterial({
    color: 0xd9b25a,
    roughness: 0.38,
    metalness: 0.9,
  });
  const outwards = max(abs(positionLocal.x), abs(positionLocal.y))
    .sub(CAD.lidSize / 2)
    .div(CAD.packageSize / 2 - CAD.lidSize / 2); // 0 at the lid, 1 at the edge
  const phase = fract(timeline.seconds.mul(0.17).sub(outwards.mul(0.45)).add(0.5));
  const glow = vec3(accent.r, accent.g, accent.b);
  material.emissiveNode = glow.mul(pulseBand(phase).mul(1.2));
  return { material, dispose: disposeAll(material) };
}

/** Capacitors: dark ceramic. */
function capacitorsDressing(): Dressing {
  const material = new THREE.MeshStandardNodeMaterial({
    color: 0x2a2d35,
    roughness: 0.45,
    metalness: 0.6,
  });
  return { material, dispose: disposeAll(material) };
}

interface DressedModel {
  dispose(): void;
}

/**
 * Replaces the flat CAD colours with the page's materials, one dressing per named part. All
 * position-based inputs in the dressings are in the model's own frame: metres, Z up, origin at
 * the centre of the substrate's top face.
 */
function dressModel(
  model: THREE.Group,
  timeline: Timeline,
  accent: THREE.Color,
  options: CpuOptions,
): DressedModel {
  const dressings: Record<string, Dressing> = {
    Substrate: substrateDressing(),
    Lid: lidDressing(partOf(model, 'Lid'), options),
    Traces: tracesDressing(timeline, accent),
    Capacitors: capacitorsDressing(),
  };
  for (const [name, dressing] of Object.entries(dressings)) {
    partOf(model, name).material = dressing.material;
  }

  return {
    dispose: () => {
      for (const dressing of Object.values(dressings)) dressing.dispose();
      model.traverse((object) => {
        if (object instanceof THREE.Mesh) object.geometry.dispose();
      });
    },
  };
}

/** Trace ends from the build step, converted to the chip's frame. */
function traceEndsOf(model: THREE.Group): TraceEnd[] {
  model.updateMatrix();
  return modelInfo.traceEnds.map(({ side, index, position: [x, y, z] }) => {
    const position = new THREE.Vector3(x, y, z).applyMatrix4(model.matrix);
    const outward = new THREE.Vector3(
      side === 0 ? 1 : side === 2 ? -1 : 0,
      0,
      // CAD +Y becomes scene -Z after the quarter turn about X.
      side === 1 ? -1 : side === 3 ? 1 : 0,
    );
    return { side, index, position, outward };
  });
}

// ---------------------------------------------------------------------------------------------
// Pins: one instanced mesh, placed and animated on the GPU
// ---------------------------------------------------------------------------------------------

interface Part {
  object: THREE.Object3D;
  dispose(): void;
}

/** Grid positions (x, z) of the pins, with the central square left empty. */
function pinPositions(): Float32Array {
  const half = (PINS.perSide - 1) / 2;
  const emptyHalf = PINS.emptyCentre / 2;
  const positions: number[] = [];
  for (let column = 0; column < PINS.perSide; column++) {
    for (let row = 0; row < PINS.perSide; row++) {
      const x = column - half;
      const z = row - half;
      const inEmptyCentre = Math.abs(x) < emptyHalf && Math.abs(z) < emptyHalf;
      if (!inEmptyCentre) positions.push(x * PINS.pitch, z * PINS.pitch);
    }
  }
  return new Float32Array(positions);
}

/**
 * The shader places each pin from its grid position, lifts it during assembly (centre pins
 * first), and lights it when the signal pulse passes.
 */
function makePins(timeline: Timeline, accent: THREE.Color): Part {
  const positions = pinPositions();
  const count = positions.length / 2;

  const geometry = new THREE.CylinderGeometry(PINS.radius, PINS.radius * 0.7, PINS.length, 6);
  // Hang the pin from its top, so y = 0 is where it meets the substrate.
  geometry.translate(0, -PINS.length / 2, 0);

  const material = new THREE.MeshStandardNodeMaterial({
    color: 0xd1a94f,
    roughness: 0.32,
    metalness: 0.95,
  });

  // Per-pin input: its (x, z) on the grid. The explicit generic keeps the node typed as vec2.
  const gridXZ = instancedBufferAttribute<'vec2'>(
    new THREE.InstancedBufferAttribute(positions, 2),
    'vec2',
  );
  const reach = ((PINS.perSide - 1) / 2) * PINS.pitch * Math.SQRT2; // centre to corner

  const substrateBottom = -CAD.packageThickness * MODEL_SCALE;
  material.positionNode = positionGeometry.add(vec3(gridXZ.x, substrateBottom, gridXZ.y));

  // Signal pulse: a diagonal band that crosses the grid every few seconds.
  const diagonal = gridXZ.x
    .add(gridXZ.y)
    .div(reach * Math.SQRT2)
    .mul(0.5)
    .add(0.5); // 0 at one corner, 1 at the opposite corner
  const phase = fract(timeline.seconds.mul(0.11).sub(diagonal.mul(0.4)));
  const glow = vec3(accent.r, accent.g, accent.b);
  material.emissiveNode = glow.mul(pulseBand(phase).mul(1.4));

  const mesh = new THREE.InstancedMesh(geometry, material, count);
  // The shader moves the pins, so their bounding box is not meaningful.
  mesh.frustumCulled = false;

  return {
    object: mesh,
    dispose: () => {
      geometry.dispose();
      material.dispose();
    },
  };
}

/** A dark disc under the chip that fades out, so the package does not float in nothing. */
function makeContactShadow(): Part & { mesh: THREE.Mesh } {
  const geometry = new THREE.PlaneGeometry(3.6, 3.6);
  const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
  material.colorNode = vec3(0, 0, 0);
  material.opacityNode = smoothstep(0.5, 0.05, length(uv().sub(0.5))).mul(0.55);

  const mesh = new THREE.Mesh(geometry, material);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = -PINS.length - 0.3;

  return {
    object: mesh,
    mesh,
    dispose: () => {
      geometry.dispose();
      material.dispose();
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Per-frame motion on the CPU side: pointer tilt, lean, moving light
// ---------------------------------------------------------------------------------------------

interface Rig {
  /** Everything that tilts together. */
  chip: THREE.Group;
  key: THREE.DirectionalLight;
  glint: THREE.PointLight;
  /** The smoothed lean, -1..1 per screen axis. */
  lean: THREE.Vector2;
}

/** Reads the pointer in clip space (-1..1) and smooths it, so the tilt lags a little. */
function createPointer() {
  const target = new THREE.Vector2();
  const smoothed = new THREE.Vector2();
  const onMove = (e: PointerEvent) => {
    target.set(
      (e.clientX / window.innerWidth) * 2 - 1,
      -((e.clientY / window.innerHeight) * 2 - 1),
    );
  };
  window.addEventListener('pointermove', onMove, { passive: true });
  return {
    smoothed,
    update: () => smoothed.lerp(target, 0.04),
    dispose: () => window.removeEventListener('pointermove', onMove),
  };
}

/** Sets the pose for one moment in time; `seconds` is the clock. */
function pose(rig: Rig, pointer: THREE.Vector2, seconds: number): void {
  // The edge toward the pointer or the active card dips, as if the chip faces it.
  rig.chip.rotation.set(
    -pointer.y * POINTER_TILT + rig.lean.y * LEAN,
    0,
    -pointer.x * POINTER_TILT - rig.lean.x * LEAN,
    'XZY',
  );
  // The light follows the pointer and drifts on its own, so the lid never looks printed.
  const driftX = Math.sin(seconds * 0.31) * GLINT.drift;
  const driftZ = Math.cos(seconds * 0.23) * GLINT.drift;
  const x = driftX + pointer.x * GLINT.follow;
  const z = driftZ - pointer.y * GLINT.follow;
  rig.glint.position.set(x, GLINT.height, z);
  rig.key.position.set(x * 2, 5, z * 2);
}

// ---------------------------------------------------------------------------------------------
// Trace ends on the screen, for DOM or SVG paths that continue outside the canvas
// ---------------------------------------------------------------------------------------------

function createProjector(traceEnds: TraceEnd[]) {
  const screen: ScreenTraceEnd[] = traceEnds.map((end) => ({ end, x: 0, y: 0, dx: 0, dy: 0 }));
  const base = new THREE.Vector3();
  const tip = new THREE.Vector3();
  const listeners = new Set<FrameListener>();

  const notify = (chip: THREE.Object3D, camera: THREE.Camera, canvas: HTMLCanvasElement) => {
    if (listeners.size === 0) {
      return;
    }
    const { clientWidth: w, clientHeight: h } = canvas;
    chip.updateMatrixWorld();
    for (const item of screen) {
      base.copy(item.end.position).applyMatrix4(chip.matrixWorld).project(camera);
      tip
        .copy(item.end.position)
        .add(item.end.outward)
        .applyMatrix4(chip.matrixWorld)
        .project(camera);
      item.x = ((base.x + 1) / 2) * w;
      item.y = ((1 - base.y) / 2) * h;
      // Clip space Y points up, the screen Y points down.
      const dx = (tip.x - base.x) * w;
      const dy = (base.y - tip.y) * h;
      const len = Math.hypot(dx, dy) || 1;
      item.dx = dx / len;
      item.dy = dy / len;
    }
    for (const listener of listeners) {
      listener(screen);
    }
  };

  const subscribe = (listener: FrameListener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  return { notify, subscribe, clear: () => listeners.clear() };
}

// ---------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------

export async function startCpu(canvas: HTMLCanvasElement, options: CpuOptions): Promise<CpuHandle> {
  const accent = new THREE.Color(options.accent);
  const timeline = createTimeline(options.reducedMotion);

  const [renderer, model] = await Promise.all([createRenderer(canvas), loadModel()]);
  const camera = createCamera();
  const scene = new THREE.Scene();
  const key = addLights(scene, accent);
  const glint = addGlint(scene);
  const disposeEnvironment = addEnvironment(scene, renderer);

  // Build the chip: the CAD body plus the instanced pins.
  const dressed = dressModel(model, timeline, accent, options);
  const pins = makePins(timeline, accent);
  const shadow = makeContactShadow();
  const chip = new THREE.Group();
  chip.add(model, pins.object);
  scene.add(chip, shadow.object);

  const rig: Rig = { chip, key, glint, lean: new THREE.Vector2() };
  const leanTarget = new THREE.Vector2();
  const pointer = createPointer();
  const traceEnds = traceEndsOf(model);
  const projector = createProjector(traceEnds);
  const notify = () => projector.notify(chip, camera, canvas);

  // Sizing.
  const resize = () => {
    const { clientWidth: w, clientHeight: h } = canvas;
    if (w === 0 || h === 0) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    fitCamera(camera);
    camera.updateProjectionMatrix();
    notify();
  };
  window.addEventListener('resize', resize);
  resize();

  const frame = (now: number) => {
    pointer.update();
    rig.lean.lerp(leanTarget, 0.06);
    pose(rig, pointer.smoothed, now / 1000);
    renderer.render(scene, camera);
    notify();
  };

  let running = false;
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

  // Run only while visible: in the viewport and in a visible tab.
  const onVisibility = () => (document.hidden ? stop() : start());
  document.addEventListener('visibilitychange', onVisibility);
  const inView = new IntersectionObserver(([entry]) => (entry?.isIntersecting ? start() : stop()), {
    threshold: 0.2,
  });
  inView.observe(canvas);

  pose(rig, pointer.smoothed, 0);
  renderer.render(scene, camera);

  return {
    traceEnds,
    lean(toward) {
      if (toward === null) {
        leanTarget.set(0, 0);
        return;
      }
      leanTarget.set(
        THREE.MathUtils.clamp(toward.x, -1, 1),
        THREE.MathUtils.clamp(toward.y, -1, 1),
      );
    },
    onFrameChange(listener) {
      const unsubscribe = projector.subscribe(listener);
      notify();
      return unsubscribe;
    },
    dispose() {
      stop();
      projector.clear();
      inView.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('resize', resize);
      pointer.dispose();
      dressed.dispose();
      pins.dispose();
      shadow.dispose();
      disposeEnvironment();
      renderer.dispose();
    },
  };
}
