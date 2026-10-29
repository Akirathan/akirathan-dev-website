/**
 * A photo cube you can drag to turn.
 *
 * Three.js WebGPURenderer (WebGL2 fallback). Three photos on opposite face pairs, soft lighting,
 * drag with inertia, and a slow idle rotation that resumes a few seconds after the last touch.
 */
import * as THREE from 'three/webgpu';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

export interface PhotoCubeOptions {
  /** Three image URLs: front/back, right/left, top/bottom. */
  faces: [string, string, string];
  /** Turn slowly when nobody drags. Off under reduced motion. */
  autoRotate: boolean;
}

export interface PhotoCubeHandle {
  dispose(): void;
}

const IDLE_DELAY_MS = 3000;
const DRAG_SPEED = 0.0075; // radians per CSS pixel
const DAMPING = 0.92; // per frame, for the inertia after a drag
const IDLE_SPEED = 0.25; // radians per second

export async function startPhotoCube(
  canvas: HTMLCanvasElement,
  options: PhotoCubeOptions,
): Promise<PhotoCubeHandle> {
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x000000, 0);
  await renderer.init();

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 20);
  camera.position.set(0, 0, 3.4);

  scene.add(new THREE.AmbientLight(0xffffff, 1.6));
  const key = new THREE.DirectionalLight(0xffffff, 1.4);
  key.position.set(2, 3, 4);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xffffff, 0.5);
  fill.position.set(-3, -1, 2);
  scene.add(fill);

  const loader = new THREE.TextureLoader();
  const textures = await Promise.all(
    options.faces.map(
      (url) =>
        new Promise<THREE.Texture>((resolve, reject) => {
          loader.load(url, resolve, undefined, reject);
        }),
    ),
  );
  const maxAnisotropy = renderer.getMaxAnisotropy();
  for (const texture of textures) {
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = Math.min(8, maxAnisotropy);
  }

  // BoxGeometry material groups: +x, -x, +y, -y, +z, -z.
  const [a, b, c] = textures;
  const faceTextures = [b, b, c, c, a, a];
  const materials = faceTextures.map(
    (map) => new THREE.MeshStandardMaterial({ map, roughness: 0.9, metalness: 0 }),
  );
  const geometry = new RoundedBoxGeometry(1, 1, 1, 4, 0.04);
  const cube = new THREE.Mesh(geometry, materials);
  cube.rotation.set(-0.3, 0.55, 0);
  scene.add(cube);

  // Rotation is applied around world axes, so a horizontal drag always turns the cube left or
  // right on screen, whatever its current orientation.
  const yAxis = new THREE.Vector3(0, 1, 0);
  const xAxis = new THREE.Vector3(1, 0, 0);
  const rotateBy = (yaw: number, pitch: number) => {
    cube.rotateOnWorldAxis(yAxis, yaw);
    cube.rotateOnWorldAxis(xAxis, pitch);
  };

  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  let velocityX = 0;
  let velocityY = 0;
  let lastInteraction = -Infinity;

  const onPointerDown = (e: PointerEvent) => {
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    velocityX = velocityY = 0;
    canvas.setPointerCapture(e.pointerId);
    canvas.style.cursor = 'grabbing';
    lastInteraction = performance.now();
  };
  const onPointerMove = (e: PointerEvent) => {
    if (!dragging) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    velocityX = dx * DRAG_SPEED;
    velocityY = dy * DRAG_SPEED;
    rotateBy(velocityX, velocityY);
    lastInteraction = performance.now();
  };
  const onPointerUp = (e: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    canvas.style.cursor = 'grab';
    lastInteraction = performance.now();
  };

  const resize = () => {
    const { clientWidth: w, clientHeight: h } = canvas;
    if (w === 0 || h === 0) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  resize();

  let previous = performance.now();
  const frame = (now: DOMHighResTimeStamp) => {
    const dt = Math.min((now - previous) / 1000, 0.05);
    previous = now;

    if (!dragging) {
      // Inertia, then the idle turn once the inertia has died down and the user has been away.
      velocityX *= DAMPING;
      velocityY *= DAMPING;
      if (Math.abs(velocityX) < 1e-4) velocityX = 0;
      if (Math.abs(velocityY) < 1e-4) velocityY = 0;
      rotateBy(velocityX, velocityY);

      const idle = now - lastInteraction > IDLE_DELAY_MS;
      if (options.autoRotate && idle && velocityX === 0 && velocityY === 0) {
        cube.rotateOnWorldAxis(yAxis, IDLE_SPEED * dt);
      }
    }
    renderer.render(scene, camera);
  };

  let running = false;
  const start = () => {
    if (running) return;
    running = true;
    previous = performance.now();
    void renderer.setAnimationLoop(frame);
  };
  const stop = () => {
    if (!running) return;
    running = false;
    void renderer.setAnimationLoop(null);
  };

  const onVisibility = () => (document.hidden ? stop() : start());
  const visible = new IntersectionObserver(([entry]) => (entry?.isIntersecting ? start() : stop()));

  canvas.style.cursor = 'grab';
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  window.addEventListener('resize', resize);
  document.addEventListener('visibilitychange', onVisibility);
  visible.observe(canvas);

  renderer.render(scene, camera);
  start();

  return {
    dispose() {
      stop();
      visible.disconnect();
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      window.removeEventListener('resize', resize);
      document.removeEventListener('visibilitychange', onVisibility);
      geometry.dispose();
      for (const m of materials) m.dispose();
      for (const t of textures) t.dispose();
      renderer.dispose();
    },
  };
}
