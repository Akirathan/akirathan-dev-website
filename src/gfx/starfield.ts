/**
 * Calm, star-like particle field for the landing-page background.
 *
 * Three.js WebGPURenderer: WebGPU where available, WebGL2 otherwise. Each star is an instanced
 * sprite whose position, size, and brightness are computed on the GPU with TSL. Only two things
 * come from the CPU each frame: time and the smoothed pointer position.
 */
import * as THREE from 'three/webgpu';
import {
  float,
  hash,
  instancedBufferAttribute,
  length,
  mix,
  sin,
  smoothstep,
  time,
  uniform,
  uv,
  vec3,
  vec4,
} from 'three/tsl';

export interface StarfieldOptions {
  /** Freeze all motion and render one frame only. */
  reducedMotion: boolean;
  count?: number;
}

export interface StarfieldHandle {
  dispose(): void;
}

const FIELD = { x: 16, y: 10, zNear: 4, zFar: -8 };

export async function startStarfield(
  canvas: HTMLCanvasElement,
  options: StarfieldOptions,
): Promise<StarfieldHandle> {
  const count = options.count ?? 1600;

  const renderer = new THREE.WebGPURenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x000000, 0);
  await renderer.init();

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.z = 10;

  // Per-star data: position and a seed in [0, 1).
  const positions = new Float32Array(count * 3);
  const seeds = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    positions[i * 3] = (Math.random() * 2 - 1) * FIELD.x;
    positions[i * 3 + 1] = (Math.random() * 2 - 1) * FIELD.y;
    positions[i * 3 + 2] = FIELD.zFar + Math.random() * (FIELD.zNear - FIELD.zFar);
    seeds[i] = Math.random();
  }
  // The explicit generic keeps the node type literal ('vec3', not string), which enables
  // swizzles and operators on the node.
  const aPosition = instancedBufferAttribute<'vec3'>(
    new THREE.InstancedBufferAttribute(positions, 3),
    'vec3',
  );
  const aSeed = instancedBufferAttribute<'float'>(
    new THREE.InstancedBufferAttribute(seeds, 1),
    'float',
  );

  const uPointer = uniform(new THREE.Vector2(0, 0));
  const uMotion = uniform(options.reducedMotion ? 0 : 1);

  const t = time.mul(uMotion);
  // 0 for the farthest stars, 1 for the nearest.
  const depth = aPosition.z.sub(FIELD.zFar).div(FIELD.zNear - FIELD.zFar);

  const drift = vec3(
    sin(t.mul(0.12).add(aSeed.mul(6.2832))).mul(0.18),
    sin(t.mul(0.09).add(aSeed.mul(9.1))).mul(0.14),
    0,
  );
  const parallax = vec3(uPointer.x, uPointer.y, 0).mul(depth.mul(0.5).add(0.1));

  const material = new THREE.SpriteNodeMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  material.positionNode = aPosition.add(drift).add(parallax);

  // Slow twinkle, different phase and speed per star.
  const twinkle = sin(t.mul(aSeed.mul(0.6).add(0.4)).add(aSeed.mul(40)))
    .mul(0.5)
    .add(0.5);
  material.scaleNode = float(0.05)
    .add(aSeed.mul(0.09))
    .mul(depth.mul(0.6).add(0.5))
    .mul(twinkle.mul(0.35).add(0.8));

  // Soft round sprite with a brighter core.
  const d = length(uv().sub(0.5)).mul(2);
  const glow = smoothstep(1, 0, d).pow(3);
  const warm = vec3(1.0, 0.93, 0.82);
  const cool = vec3(0.78, 0.9, 0.96);
  const tint = mix(cool, warm, hash(aSeed.mul(97)));
  const alpha = glow.mul(twinkle.mul(0.5).add(0.3)).mul(depth.mul(0.6).add(0.35));
  material.colorNode = vec4(tint, alpha);

  const stars = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), material, count);
  stars.frustumCulled = false;
  scene.add(stars);

  // Pointer is smoothed on the CPU so that the field follows with a little lag.
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
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  resize();

  const renderOnce = () => renderer.render(scene, camera);

  let running = false;
  const frame = () => {
    uPointer.value.lerp(targetPointer, 0.04);
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
      stars.geometry.dispose();
      material.dispose();
      renderer.dispose();
    },
  };
}
