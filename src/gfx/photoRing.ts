/**
 * A ring of photos you can spin.
 *
 * Flat photo panels stand around a vertical axis, so a photo can never turn upside down. With
 * three photos it is a triangular prism; with more it becomes a carousel. Drag to spin (with
 * inertia), it snaps to the nearest photo, the pointer tilts it a little, and it turns slowly
 * by itself when left alone. Three.js WebGPURenderer with a WebGL2 fallback.
 */
import * as THREE from 'three/webgpu';

export interface PhotoRingOptions {
  /** Image URLs, at least two. */
  faces: string[];
  /** Width / height of the photos. All panels share it. */
  aspect: number;
  /** Turn slowly when nobody interacts. Off under reduced motion. */
  autoRotate: boolean;
}

export interface PhotoRingHandle {
  dispose(): void;
}

const PANEL_WIDTH = 1.6;
const DRAG_SPEED = 0.0065; // radians per CSS pixel
const DAMPING = 0.93; // inertia decay per frame
const SNAP_BELOW = 0.004; // inertia below this snaps to the nearest photo
const SNAP_RATE = 7; // how fast the snap eases, per second
const IDLE_DELAY_MS = 3500;
const IDLE_SPEED = 0.18; // radians per second
const TILT = 0.14; // max pointer tilt, radians

/** A plane with rounded corners and 0..1 UVs, centred at the origin. */
function roundedPlane(w: number, h: number, r: number): THREE.BufferGeometry {
  const x = -w / 2;
  const y = -h / 2;
  const shape = new THREE.Shape();
  shape.moveTo(x + r, y);
  shape.lineTo(x + w - r, y);
  shape.quadraticCurveTo(x + w, y, x + w, y + r);
  shape.lineTo(x + w, y + h - r);
  shape.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  shape.lineTo(x + r, y + h);
  shape.quadraticCurveTo(x, y + h, x, y + h - r);
  shape.lineTo(x, y + r);
  shape.quadraticCurveTo(x, y, x + r, y);

  const geometry = new THREE.ShapeGeometry(shape, 6);
  const position = geometry.getAttribute('position');
  const uv = geometry.getAttribute('uv');
  for (let i = 0; i < position.count; i++) {
    uv.setXY(i, position.getX(i) / w + 0.5, position.getY(i) / h + 0.5);
  }
  return geometry;
}

export async function startPhotoRing(
  canvas: HTMLCanvasElement,
  options: PhotoRingOptions,
): Promise<PhotoRingHandle> {
  const count = options.faces.length;
  if (count < 2) throw new Error('PhotoRing needs at least two photos.');

  const renderer = new THREE.WebGPURenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x000000, 0);
  await renderer.init();

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 30);

  scene.add(new THREE.AmbientLight(0xffffff, 1.5));
  const key = new THREE.DirectionalLight(0xffffff, 1.2);
  key.position.set(1.5, 3, 4);
  scene.add(key);

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

  // Geometry: panels on a circle, each facing outward. The radius keeps neighbours apart.
  const w = PANEL_WIDTH;
  const h = w / options.aspect;
  const step = (Math.PI * 2) / count;
  const radius = Math.max((w / (2 * Math.tan(Math.PI / count))) * 1.3, 0.6);
  // Slightly from above, so the ring reads as a shape and the side photos stay visible.
  camera.position.set(0, 0.75, radius + 2.9);
  camera.lookAt(0, -0.05, 0);

  const panelGeometry = roundedPlane(w, h, 0.06);
  const backMaterial = new THREE.MeshStandardMaterial({ color: 0x1c2030, roughness: 1 });
  const ring = new THREE.Group();
  const panels = textures.map((map, i) => {
    const material = new THREE.MeshStandardMaterial({ map, roughness: 0.9, metalness: 0 });
    const front = new THREE.Mesh(panelGeometry, material);
    const back = new THREE.Mesh(panelGeometry, backMaterial);
    back.rotation.y = Math.PI;
    back.position.z = -0.004;

    const panel = new THREE.Group();
    panel.add(front, back);
    const angle = i * step;
    panel.position.set(Math.sin(angle) * radius, 0, Math.cos(angle) * radius);
    panel.rotation.y = angle;
    ring.add(panel);
    return { angle, material };
  });
  scene.add(ring);

  // State. `theta` is the ring's turn; photo i faces the camera when theta == -i * step.
  let theta = 0;
  let velocity = 0;
  let dragging = false;
  let lastX = 0;
  let lastInteraction = -Infinity;
  let tiltTarget = 0;
  let tilt = 0;

  const onPointerDown = (e: PointerEvent) => {
    dragging = true;
    lastX = e.clientX;
    velocity = 0;
    canvas.setPointerCapture(e.pointerId);
    canvas.style.cursor = 'grabbing';
    lastInteraction = performance.now();
  };
  const onPointerMove = (e: PointerEvent) => {
    lastInteraction = performance.now();
    const rect = canvas.getBoundingClientRect();
    tiltTarget = -((e.clientY - rect.top) / rect.height - 0.5) * 2 * TILT;
    if (!dragging) return;
    const dx = e.clientX - lastX;
    lastX = e.clientX;
    velocity = dx * DRAG_SPEED;
    theta += velocity;
  };
  const onPointerUp = (e: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    canvas.style.cursor = 'grab';
    lastInteraction = performance.now();
  };
  const onPointerLeave = () => {
    tiltTarget = 0;
  };

  const resize = () => {
    const { clientWidth: cw, clientHeight: ch } = canvas;
    if (cw === 0 || ch === 0) return;
    renderer.setSize(cw, ch, false);
    camera.aspect = cw / ch;
    camera.updateProjectionMatrix();
  };
  resize();

  let previous = performance.now();
  const frame = (now: DOMHighResTimeStamp) => {
    const dt = Math.min((now - previous) / 1000, 0.05);
    previous = now;

    if (!dragging) {
      theta += velocity;
      velocity *= DAMPING;
      if (Math.abs(velocity) < SNAP_BELOW) {
        velocity = 0;
        const idle = now - lastInteraction > IDLE_DELAY_MS;
        if (options.autoRotate && idle) {
          theta += IDLE_SPEED * dt;
        } else {
          const target = Math.round(theta / step) * step;
          theta += (target - theta) * Math.min(1, SNAP_RATE * dt);
        }
      }
    }

    tilt += (tiltTarget - tilt) * Math.min(1, 6 * dt);
    ring.rotation.set(tilt, theta, 0);

    // Photos that face away are dimmed, so the front one reads as the current one.
    for (const { angle, material } of panels) {
      const facing = Math.cos(theta + angle);
      const brightness = 0.35 + 0.65 * THREE.MathUtils.clamp((facing + 0.25) / 1.25, 0, 1);
      material.color.setScalar(brightness);
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
  canvas.addEventListener('pointerleave', onPointerLeave);
  window.addEventListener('resize', resize);
  document.addEventListener('visibilitychange', onVisibility);
  visible.observe(canvas);

  frame(performance.now());
  start();

  return {
    dispose() {
      stop();
      visible.disconnect();
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      window.removeEventListener('resize', resize);
      document.removeEventListener('visibilitychange', onVisibility);
      panelGeometry.dispose();
      backMaterial.dispose();
      for (const { material } of panels) material.dispose();
      for (const t of textures) t.dispose();
      renderer.dispose();
    },
  };
}
