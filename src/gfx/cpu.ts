/**
 * A procedural CPU package: substrate, pin grid, capacitors, and a heat spreader (the "lid")
 * with etched text. No downloaded model, so no licence and no download.
 *
 * When the canvas enters the viewport the package assembles: the pins rise into the substrate
 * from the centre outwards and the lid settles on top. Afterwards it turns slowly, tilts with
 * the pointer, and a signal pulse runs across the pins now and then.
 *
 * Three.js WebGPURenderer with a WebGL2 fallback. Per-pin motion and glow are TSL on the GPU;
 * the CPU side only updates a few uniforms per frame.
 *
 * Reading guide: `startCpu()` at the bottom wires everything. Each part of the chip has its
 * own `make*()` builder that returns a `Part`. The animation inputs that the shaders read are
 * in `Timeline`.
 */
import * as THREE from 'three/webgpu';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import {
  clamp,
  float,
  fract,
  instancedBufferAttribute,
  length,
  normalLocal,
  positionGeometry,
  select,
  smoothstep,
  texture,
  time,
  uniform,
  uv,
  vec2,
  vec3,
} from 'three/tsl';

// ---------------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------------

export interface CpuOptions {
  /** Freeze all motion and render one assembled frame only. */
  reducedMotion: boolean;
  /** Glow colour of the signal pulse, hex. */
  accent: string;
  /** CSS font-family for the etched text. */
  headingFont: string;
  /** Lines etched into the lid, large to small. */
  text: [string, string, string];
}

export interface CpuHandle {
  dispose(): void;
}

// ---------------------------------------------------------------------------------------------
// Dimensions, in scene units. The package is 2 units wide; the camera is set for that.
// ---------------------------------------------------------------------------------------------

/** The green board that carries everything. */
const SUBSTRATE = { size: 2.0, thickness: 0.08, cornerRadius: 0.015 };

/** Gold pins under the substrate: a square grid with an empty square in the middle. */
const PINS = { perSide: 26, pitch: 0.066, emptyCentre: 8, length: 0.26, radius: 0.015 };

/** The metal lid on top. */
const LID = { size: 1.42, height: 0.12, cornerRadius: 0.025 };

/** Small dark capacitors in a row along each edge of the lid. */
const CAPACITORS = { perEdge: 7, spacing: 0.13, gapToLid: 0.14, size: [0.1, 0.045, 0.055] };

/** Length of the assembly, from the first pin to the lid at rest. */
const ASSEMBLE_MS = 2200;

/** Where the lid rests: on the substrate. */
const LID_REST_Y = SUBSTRATE.thickness / 2 + LID.height / 2;

/** How far the pins and the lid start from their resting place. */
const PIN_DROP = 1.6;
const LID_DROP = 1.3;

// ---------------------------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------------------------

/** One part of the chip: something to add to the scene, and a way to free its GPU memory. */
interface Part {
  object: THREE.Object3D;
  dispose(): void;
}

/**
 * The animation inputs that the shaders read.
 *
 * - `assemble` goes 0 -> 1 once, while the package assembles.
 * - `motion` is 1 normally and 0 under reduced motion; it freezes the time-based effects.
 * - `seconds` is the shader clock, already multiplied by `motion`.
 */
const floatUniform = (value: number) => uniform(value);

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
  camera.position.set(2.9, 2.3, 3.6);
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

/**
 * Soft studio reflections for the metal. Lights alone look flat on a lid. Returns a dispose
 * function; on failure the scene keeps lights only.
 */
function addEnvironment(scene: THREE.Scene, renderer: THREE.WebGPURenderer) {
  // The renderer is initialised already, so the synchronous call is fine.
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
// Parts of the chip
// ---------------------------------------------------------------------------------------------

function makeSubstrate(): Part {
  const geometry = new RoundedBoxGeometry(
    SUBSTRATE.size,
    SUBSTRATE.thickness,
    SUBSTRATE.size,
    2,
    SUBSTRATE.cornerRadius,
  );
  const material = new THREE.MeshStandardNodeMaterial({
    color: 0x173029,
    roughness: 0.55,
    metalness: 0.05,
  });
  return {
    object: new THREE.Mesh(geometry, material),
    dispose: () => {
      geometry.dispose();
      material.dispose();
    },
  };
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
 * The pins are one instanced mesh. The shader places each pin from its grid position, lifts
 * it during assembly (centre pins first), and lights it when the signal pulse passes.
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
  const liftY = arrival
    .oneMinus()
    .mul(-PIN_DROP)
    .sub(SUBSTRATE.thickness / 2);
  material.positionNode = positionGeometry.add(vec3(gridXZ.x, liftY, gridXZ.y));

  // Signal pulse: a diagonal band that crosses the grid every few seconds.
  const diagonal = gridXZ.x
    .add(gridXZ.y)
    .div(reach * Math.SQRT2)
    .mul(0.5)
    .add(0.5); // 0 at one corner, 1 at the opposite corner
  const phase = fract(timeline.seconds.mul(0.11).sub(diagonal.mul(0.4)));
  const pulse = smoothstep(0, 0.05, phase).mul(smoothstep(0.32, 0.05, phase)); // sharp in, soft out
  const glow = vec3(accent.r, accent.g, accent.b);
  material.emissiveNode = glow.mul(pulse.mul(arrival).mul(1.4));

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

/** Rows of capacitors along the four edges of the lid, lying on the substrate. */
function makeCapacitors(): Part {
  const [w, h, d] = CAPACITORS.size as [number, number, number];
  const geometry = new THREE.BoxGeometry(w, h, d);
  const material = new THREE.MeshStandardNodeMaterial({
    color: 0x2a2d35,
    roughness: 0.45,
    metalness: 0.6,
  });

  const y = SUBSTRATE.thickness / 2 + h / 2;
  const edge = LID.size / 2 + CAPACITORS.gapToLid;
  const turned = new THREE.Matrix4().makeRotationY(Math.PI / 2);
  const placements: THREE.Matrix4[] = [];
  const first = -((CAPACITORS.perEdge - 1) / 2);
  for (let n = 0; n < CAPACITORS.perEdge; n++) {
    const along = (first + n) * CAPACITORS.spacing;
    placements.push(
      new THREE.Matrix4().makeTranslation(along, y, edge), // front edge
      new THREE.Matrix4().makeTranslation(along, y, -edge), // back edge
      turned.clone().setPosition(edge, y, along), // right edge
      turned.clone().setPosition(-edge, y, along), // left edge
    );
  }

  const mesh = new THREE.InstancedMesh(geometry, material, placements.length);
  placements.forEach((matrix, i) => mesh.setMatrixAt(i, matrix));

  return {
    object: mesh,
    dispose: () => {
      geometry.dispose();
      material.dispose();
    },
  };
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

/** The lid: brushed metal all over, the printed texture on the top face only. */
function makeLid(options: CpuOptions): Part & { mesh: THREE.Mesh } {
  const geometry = new RoundedBoxGeometry(LID.size, LID.height, LID.size, 3, LID.cornerRadius);
  const print = drawLidTexture(options);
  const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.3, metalness: 0.92 });

  const isTopFace = normalLocal.y.greaterThan(0.9);
  // The print is turned a quarter so that it reads left to right from the resting camera.
  const printUv = vec2(uv().y.oneMinus(), uv().x);
  const plainMetal = vec3(0.62, 0.66, 0.7);
  material.colorNode = select(isTopFace, texture(print, printUv).rgb, plainMetal);
  material.roughnessNode = select(isTopFace, float(0.28), float(0.4));

  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.y = LID_REST_Y;

  return {
    object: mesh,
    mesh,
    dispose: () => {
      geometry.dispose();
      material.dispose();
      print.dispose();
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
  rig.lid.position.y = LID_REST_Y + (1 - easeOutCubic(lidProgress)) * LID_DROP;

  rig.chip.rotation.y = 0.6 + seconds * 0.16 + pointer.x * 0.35;
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

  const renderer = await createRenderer(canvas);
  const camera = createCamera();
  const scene = new THREE.Scene();
  addLights(scene, accent);
  const disposeEnvironment = addEnvironment(scene, renderer);

  // Build the chip.
  const lid = makeLid(options);
  const shadow = makeContactShadow();
  const parts: Part[] = [makeSubstrate(), makePins(timeline, accent), makeCapacitors(), lid];
  const chip = new THREE.Group();
  for (const part of parts) chip.add(part.object);
  scene.add(chip, shadow.object);

  const rig: Rig = { chip, lid: lid.mesh, shadow: shadow.mesh, timeline };
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
    dispose() {
      stop();
      inView.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('resize', resize);
      pointer.dispose();
      for (const part of [...parts, shadow]) part.dispose();
      disposeEnvironment();
      renderer.dispose();
    },
  };
}
