/**
 * A procedural CPU package: substrate, pin grid, capacitors, and a heat spreader with etched
 * text. No downloaded model, so no licence and no download.
 *
 * When the canvas enters the viewport the package assembles: the pins rise into the substrate
 * from the centre outwards and the heat spreader settles on top. Afterwards it turns slowly,
 * tilts with the pointer, and a signal pulse runs across the pins now and then.
 *
 * Three.js WebGPURenderer with a WebGL2 fallback. Per-pin motion and glow are TSL on the GPU;
 * the CPU side only updates a few uniforms per frame.
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

export interface CpuOptions {
  /** Freeze all motion and render one assembled frame only. */
  reducedMotion: boolean;
  /** Glow colour of the signal pulse, hex. */
  accent: string;
  /** CSS font-family for the etched text. */
  headingFont: string;
  /** Lines etched into the heat spreader, large to small. */
  text: [string, string, string];
}

export interface CpuHandle {
  dispose(): void;
}

const PINS = { grid: 26, pitch: 0.066, hole: 8, length: 0.26, radius: 0.015 };
const PACKAGE = { size: 2.0, thickness: 0.08 };
const LID = { size: 1.42, height: 0.12, radius: 0.025 };
const ASSEMBLE_MS = 2200;

const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;

/** Brushed metal with etched text, drawn once on a 2D canvas. */
function lidTexture(options: CpuOptions): THREE.CanvasTexture {
  const size = 1024;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  const base = ctx.createLinearGradient(0, 0, size, size);
  base.addColorStop(0, '#9aa3ab');
  base.addColorStop(0.5, '#b7bec5');
  base.addColorStop(1, '#8e969e');
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, size, size);

  // Brushed grain: many faint horizontal lines.
  for (let i = 0; i < 2200; i++) {
    const y = Math.random() * size;
    const w = 80 + Math.random() * 500;
    const x = Math.random() * (size - w);
    ctx.strokeStyle = Math.random() < 0.5 ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.07)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + w, y);
    ctx.stroke();
  }

  // Etched frame and pin-1 mark.
  ctx.strokeStyle = 'rgba(25,30,38,0.45)';
  ctx.lineWidth = 3;
  ctx.strokeRect(70, 70, size - 140, size - 140);
  ctx.fillStyle = 'rgba(25,30,38,0.6)';
  ctx.beginPath();
  ctx.moveTo(96, size - 96);
  ctx.lineTo(150, size - 96);
  ctx.lineTo(96, size - 150);
  ctx.closePath();
  ctx.fill();

  // Etched text.
  ctx.fillStyle = 'rgba(25,30,38,0.78)';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const [big, mid, small] = options.text;
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

export async function startCpu(canvas: HTMLCanvasElement, options: CpuOptions): Promise<CpuHandle> {
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x000000, 0);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  await renderer.init();

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 50);
  camera.position.set(2.9, 2.3, 3.6);
  camera.lookAt(0, -0.05, 0);

  // Soft studio reflections for the metal. Lights alone look flat on a heat spreader.
  const pmrem = new THREE.PMREMGenerator(renderer);
  try {
    const env = await pmrem.fromSceneAsync(new RoomEnvironment(), 0.04);
    scene.environment = env.texture;
    scene.environmentIntensity = 0.55;
  } catch {
    // Lights only.
  }
  scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x0b0e14, 0.5));
  const key = new THREE.DirectionalLight(0xfff4e6, 2.4);
  key.position.set(-3, 5, 2);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xcfe0ff, 1.0);
  rim.position.set(4, 2, -4);
  scene.add(rim);
  const accent = new THREE.Color(options.accent);
  const under = new THREE.PointLight(accent, 6, 4, 2);
  under.position.set(0, -0.9, 0);
  scene.add(under);

  const uAssemble = uniform(options.reducedMotion ? 1 : 0);
  const uMotion = uniform(options.reducedMotion ? 0 : 1);
  const t = time.mul(uMotion);

  const group = new THREE.Group();
  scene.add(group);

  // Substrate.
  const substrate = new THREE.Mesh(
    new RoundedBoxGeometry(PACKAGE.size, PACKAGE.thickness, PACKAGE.size, 2, 0.015),
    new THREE.MeshStandardNodeMaterial({ color: 0x173029, roughness: 0.55, metalness: 0.05 }),
  );
  group.add(substrate);

  // Pins: a grid with an empty centre, rising from below as the package assembles.
  const half = (PINS.grid - 1) / 2;
  const holeFrom = half - PINS.hole / 2 + 0.5;
  const cells: [number, number][] = [];
  for (let i = 0; i < PINS.grid; i++) {
    for (let j = 0; j < PINS.grid; j++) {
      const inHole = Math.abs(i - half) < holeFrom && Math.abs(j - half) < holeFrom;
      if (!inHole) cells.push([i, j]);
    }
  }
  const offsets = new Float32Array(cells.length * 2);
  cells.forEach(([i, j], n) => {
    offsets[n * 2] = (i - half) * PINS.pitch;
    offsets[n * 2 + 1] = (j - half) * PINS.pitch;
  });
  const aOffset = instancedBufferAttribute<'vec2'>(
    new THREE.InstancedBufferAttribute(offsets, 2),
    'vec2',
  );
  const pinGeometry = new THREE.CylinderGeometry(PINS.radius, PINS.radius * 0.7, PINS.length, 6);
  pinGeometry.translate(0, -PINS.length / 2, 0);
  const pinMaterial = new THREE.MeshStandardNodeMaterial({
    color: 0xd1a94f,
    roughness: 0.32,
    metalness: 0.95,
  });
  const reach = half * PINS.pitch * Math.SQRT2;
  const radial = length(aOffset).div(reach);
  // Centre pins arrive first; the edge pins last.
  const k = clamp(uAssemble.mul(1.6).sub(radial.mul(0.6)), 0, 1);
  const rise = k.mul(k).mul(float(3).sub(k.mul(2)));
  const drop = rise.oneMinus().mul(-1.6);
  pinMaterial.positionNode = positionGeometry.add(
    vec3(aOffset.x, drop.sub(PACKAGE.thickness / 2), aOffset.y),
  );
  // A diagonal signal pulse every few seconds.
  const along = aOffset.x
    .add(aOffset.y)
    .div(reach * Math.SQRT2)
    .mul(0.5)
    .add(0.5);
  const wave = fract(t.mul(0.11).sub(along.mul(0.4)));
  const band = smoothstep(0, 0.05, wave).mul(smoothstep(0.32, 0.05, wave));
  pinMaterial.emissiveNode = vec3(accent.r, accent.g, accent.b).mul(band.mul(rise).mul(1.4));
  const pins = new THREE.InstancedMesh(pinGeometry, pinMaterial, cells.length);
  pins.frustumCulled = false;
  group.add(pins);

  // Capacitors around the lid.
  const capGeometry = new THREE.BoxGeometry(0.1, 0.045, 0.055);
  const capMaterial = new THREE.MeshStandardNodeMaterial({
    color: 0x2a2d35,
    roughness: 0.45,
    metalness: 0.6,
  });
  const capSpots: THREE.Matrix4[] = [];
  const m = new THREE.Matrix4();
  const edge = LID.size / 2 + 0.14;
  for (let n = -3; n <= 3; n++) {
    const s = n * 0.13;
    capSpots.push(m.clone().makeTranslation(s, PACKAGE.thickness / 2 + 0.0225, edge));
    capSpots.push(m.clone().makeTranslation(s, PACKAGE.thickness / 2 + 0.0225, -edge));
    const r = new THREE.Matrix4().makeRotationY(Math.PI / 2);
    capSpots.push(r.clone().setPosition(edge, PACKAGE.thickness / 2 + 0.0225, s));
    capSpots.push(r.clone().setPosition(-edge, PACKAGE.thickness / 2 + 0.0225, s));
  }
  const caps = new THREE.InstancedMesh(capGeometry, capMaterial, capSpots.length);
  capSpots.forEach((mat, i) => caps.setMatrixAt(i, mat));
  group.add(caps);

  // Heat spreader: brushed metal, text on the top face only.
  const lidMap = lidTexture(options);
  const lidMaterial = new THREE.MeshStandardNodeMaterial({ roughness: 0.3, metalness: 0.92 });
  const top = normalLocal.y.greaterThan(0.9);
  // The print is turned a quarter so that it reads left to right from the resting camera.
  const lidUv = vec2(uv().y.oneMinus(), uv().x);
  lidMaterial.colorNode = select(top, texture(lidMap, lidUv).rgb, vec3(0.62, 0.66, 0.7));
  lidMaterial.roughnessNode = select(top, float(0.28), float(0.4));
  const lid = new THREE.Mesh(
    new RoundedBoxGeometry(LID.size, LID.height, LID.size, 3, LID.radius),
    lidMaterial,
  );
  const lidRest = PACKAGE.thickness / 2 + LID.height / 2;
  lid.position.y = lidRest;
  group.add(lid);

  // Contact shadow: a dark disc that fades out, so the package does not float in nothing.
  const shadowMaterial = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
  shadowMaterial.colorNode = vec3(0, 0, 0);
  shadowMaterial.opacityNode = smoothstep(0.5, 0.05, length(uv().sub(0.5))).mul(0.55);
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(3.6, 3.6), shadowMaterial);
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = -PINS.length - 0.3;
  scene.add(shadow);

  // Pointer tilt, smoothed on the CPU.
  const targetPointer = new THREE.Vector2();
  const pointer = new THREE.Vector2();
  const onPointerMove = (e: PointerEvent) => {
    targetPointer.set(
      (e.clientX / window.innerWidth) * 2 - 1,
      -((e.clientY / window.innerHeight) * 2 - 1),
    );
  };

  const resize = () => {
    const { clientWidth: w, clientHeight: h } = canvas;
    if (w === 0 || h === 0) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  resize();

  let assembleStart: number | null = null;
  const pose = (now: number) => {
    const progress = options.reducedMotion
      ? 1
      : assembleStart === null
        ? 0
        : Math.min((now - assembleStart) / ASSEMBLE_MS, 1);
    uAssemble.value = progress;
    const lidDrop = 1 - easeOutCubic(Math.max(0, (progress - 0.4) / 0.6));
    lid.position.y = lidRest + lidDrop * 1.3;
    lidMaterial.opacity = 1;

    pointer.lerp(targetPointer, 0.04);
    const seconds = (now / 1000) * uMotion.value;
    group.rotation.y = seconds * 0.16 + pointer.x * 0.35 + 0.6;
    group.rotation.x = -pointer.y * 0.18;
    group.position.y = Math.sin(seconds * 0.7) * 0.03;
    shadow.scale.setScalar(1 - group.position.y * 0.6);
  };

  const renderOnce = () => renderer.render(scene, camera);

  let running = false;
  const frame = (now: number) => {
    if (assembleStart === null) assembleStart = now;
    pose(now);
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
  const visible = new IntersectionObserver(
    ([entry]) => (entry?.isIntersecting ? start() : stop()),
    { threshold: 0.2 },
  );

  window.addEventListener('resize', resize);
  window.addEventListener('pointermove', onPointerMove, { passive: true });
  document.addEventListener('visibilitychange', onVisibility);
  visible.observe(canvas);

  pose(performance.now());
  renderOnce();

  return {
    dispose() {
      stop();
      visible.disconnect();
      window.removeEventListener('resize', resize);
      window.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('visibilitychange', onVisibility);
      for (const mesh of [substrate, pins, caps, lid, shadow]) mesh.geometry.dispose();
      for (const mat of [pinMaterial, capMaterial, lidMaterial, shadowMaterial]) mat.dispose();
      (substrate.material as THREE.Material).dispose();
      lidMap.dispose();
      scene.environment?.dispose();
      pmrem.dispose();
      renderer.dispose();
    },
  };
}
