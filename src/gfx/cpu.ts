/**
 * The CPU package on the landing page.
 *
 * The body comes from CAD: `public/models/cpu.glb`, built by `scripts/build-cpu-model.mjs`
 * from the Onshape export of `cad/cpu-package.fs`. It holds the substrate, the lid, the gold
 * traces, and the capacitors, each as a named mesh. The 656 pins are not in the file: they
 * are one instanced mesh drawn here, so that the GPU can move and light every pin on its own.
 *
 * When the canvas enters the viewport the package assembles: the pins rise into the substrate
 * from the centre outwards and the lid settles on top. Afterwards it turns slowly, tilts with
 * the pointer, a signal pulse runs across the pins, and another runs out along the traces.
 *
 * Three.js WebGPURenderer with a WebGL2 fallback; materials are TSL node materials. The CAD
 * meshes have no usable UVs, so textures are projected from local position.
 *
 * Reading guide: `startCpu()` at the bottom wires everything. Materials for the CAD parts are
 * in `dressModel()` and the `*Dressing()` functions above it, the pins in `makePins()`, and the animation inputs in `Timeline`.
 */
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import {
  abs,
  bumpMap,
  clamp,
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
  /** Freeze all motion and render one assembled frame only. */
  reducedMotion: boolean;
  /** Glow colour of the signal pulses, hex. */
  accent: string;
  /** CSS font-family for the etched text. */
  headingFont: string;
  /** Lines etched into the lid, large to small. */
  text: [string, string, string];
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

export interface CpuHandle {
  /** The 56 trace ends, for paths that continue outside the chip. */
  traceEnds: TraceEnd[];
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

/** Length of the assembly, from the first pin to the lid at rest. */
const ASSEMBLE_MS = 2200;
/** How far the pins and the lid start from their resting place, scene units. */
const PIN_DROP = 1.6;
const LID_DROP = 1.3;
/** Yaw at the start, so that the lid print reads left to right from the camera. */
const REST_YAW = 0.6 - Math.PI / 2;

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
 * - `assemble` goes 0 -> 1 once, while the package assembles.
 * - `motion` is 1 normally and 0 under reduced motion; it freezes the time-based effects.
 * - `seconds` is the shader clock, already multiplied by `motion`.
 */
interface Timeline {
  assemble: ReturnType<typeof floatUniform>;
  motion: ReturnType<typeof floatUniform>;
  seconds: THREE.Node<'float'>;
}

function createTimeline(reducedMotion: boolean): Timeline {
  const assemble = floatUniform(reducedMotion ? 1 : 0);
  const motion = floatUniform(reducedMotion ? 0 : 1);
  return { assemble, motion, seconds: time.mul(motion) };
}

const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;

/** Hermite ease, 0..1 -> 0..1, as a TSL node. */
const smooth = (k: THREE.Node<'float'>) => k.mul(k).mul(float(3).sub(k.mul(2)));

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

/** A three-quarter view from above, as in a product photo. */
function createCamera(): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 50);
  camera.position.set(2.5, 2.0, 3.1);
  camera.lookAt(0, -0.05, 0);
  return camera;
}

/** A warm key light, a cool rim light, and the accent colour glowing up from under the pins. */
function addLights(scene: THREE.Scene, accent: THREE.Color): void {
  scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x0b0e14, 0.5));

  const key = new THREE.DirectionalLight(0xfff4e6, 2.4);
  key.position.set(-3, 5, 2);
  scene.add(key);

  const rim = new THREE.DirectionalLight(0xcfe0ff, 1.0);
  rim.position.set(4, 2, -4);
  scene.add(rim);

  const under = new THREE.PointLight(accent, 6, 4, 2);
  under.position.set(0, -0.9, 0);
  scene.add(under);
}

/** Soft studio reflections for the metal. Returns a dispose function. */
function addEnvironment(scene: THREE.Scene, renderer: THREE.WebGPURenderer) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  try {
    const env = pmrem.fromScene(new RoomEnvironment(), 0.04);
    scene.environment = env.texture;
    scene.environmentIntensity = 0.55;
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

  // Etched text, three lines.
  const [big, mid, small] = options.text;
  ctx.fillStyle = `${etch}0.78)`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `800 118px ${options.headingFont}`;
  ctx.fillText(big.toUpperCase(), size / 2, 400);
  ctx.font = `600 78px ${options.headingFont}`;
  ctx.fillText(mid, size / 2, 530);
  ctx.font = `600 40px ${options.headingFont}`;
  ctx.letterSpacing = '10px';
  ctx.fillText(small.toUpperCase(), size / 2, 640);

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
  material.roughnessNode = select(isSide, float(0.7), weaveSample.sub(0.5).mul(0.25).add(0.55));
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
  lid: THREE.Mesh;
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
  const lidMesh = partOf(model, 'Lid');
  const dressings: Record<string, Dressing> = {
    Substrate: substrateDressing(),
    Lid: lidDressing(lidMesh, options),
    Traces: tracesDressing(timeline, accent),
    Capacitors: capacitorsDressing(),
  };
  for (const [name, dressing] of Object.entries(dressings)) {
    partOf(model, name).material = dressing.material;
  }

  return {
    lid: lidMesh,
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

  // Assembly: 0 = still far below, 1 = in place. Centre pins arrive first, corners last.
  const distanceFromCentre = length(gridXZ).div(reach);
  const arrival = smooth(clamp(timeline.assemble.mul(1.6).sub(distanceFromCentre.mul(0.6)), 0, 1));
  const substrateBottom = -CAD.packageThickness * MODEL_SCALE;
  const liftY = arrival.oneMinus().mul(-PIN_DROP).add(substrateBottom);
  material.positionNode = positionGeometry.add(vec3(gridXZ.x, liftY, gridXZ.y));

  // Signal pulse: a diagonal band that crosses the grid every few seconds.
  const diagonal = gridXZ.x
    .add(gridXZ.y)
    .div(reach * Math.SQRT2)
    .mul(0.5)
    .add(0.5); // 0 at one corner, 1 at the opposite corner
  const phase = fract(timeline.seconds.mul(0.11).sub(diagonal.mul(0.4)));
  const glow = vec3(accent.r, accent.g, accent.b);
  material.emissiveNode = glow.mul(pulseBand(phase).mul(arrival).mul(1.4));

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
// Per-frame motion on the CPU side: assembly progress, slow turn, pointer tilt
// ---------------------------------------------------------------------------------------------

interface Rig {
  /** Everything that turns together. */
  chip: THREE.Group;
  /** The lid mesh inside the CAD model; its local Z is up and in metres. */
  lid: THREE.Mesh;
  shadow: THREE.Mesh;
  timeline: Timeline;
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

/** Sets the pose for one moment in time. `assembled` is 0..1; `seconds` is the clock. */
function pose(rig: Rig, pointer: THREE.Vector2, assembled: number, seconds: number): void {
  rig.timeline.assemble.value = assembled;

  // The lid starts to settle when the pins are mostly in place.
  const lidProgress = Math.max(0, (assembled - 0.4) / 0.6);
  rig.lid.position.z = ((1 - easeOutCubic(lidProgress)) * LID_DROP) / MODEL_SCALE;

  rig.chip.rotation.y = REST_YAW + seconds * 0.16 + pointer.x * 0.35;
  rig.chip.rotation.x = -pointer.y * 0.18;
  rig.chip.position.y = Math.sin(seconds * 0.7) * 0.03;
  rig.shadow.scale.setScalar(1 - rig.chip.position.y * 0.6);
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
  addLights(scene, accent);
  const disposeEnvironment = addEnvironment(scene, renderer);

  // Build the chip: the CAD body plus the instanced pins.
  const dressed = dressModel(model, timeline, accent, options);
  const pins = makePins(timeline, accent);
  const shadow = makeContactShadow();
  const chip = new THREE.Group();
  chip.add(model, pins.object);
  scene.add(chip, shadow.object);

  const rig: Rig = { chip, lid: dressed.lid, shadow: shadow.mesh, timeline };
  const pointer = createPointer();

  // Sizing.
  const resize = () => {
    const { clientWidth: w, clientHeight: h } = canvas;
    if (w === 0 || h === 0) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  window.addEventListener('resize', resize);
  resize();

  // The render loop. Assembly starts with the first animated frame, which is the first frame
  // after the canvas scrolls into view.
  let assembleStart: number | null = null;
  const frame = (now: number) => {
    assembleStart ??= now;
    const assembled = Math.min((now - assembleStart) / ASSEMBLE_MS, 1);
    pointer.update();
    pose(rig, pointer.smoothed, assembled, now / 1000);
    renderer.render(scene, camera);
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

  // First frame: not yet assembled, or fully assembled under reduced motion.
  pose(rig, pointer.smoothed, options.reducedMotion ? 1 : 0, 0);
  renderer.render(scene, camera);

  return {
    traceEnds: traceEndsOf(model),
    dispose() {
      stop();
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
