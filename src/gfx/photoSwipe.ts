/**
 * A photo gallery that changes photos with a GPU transition.
 *
 * One full-size plane shows the current photo. A change to the next photo is a wipe that noise
 * guides, with a liquid displacement along its front and a slight zoom on both photos. Drag to
 * pull the next photo in, click or press the arrow keys to switch, or wait: it advances by
 * itself when left alone. Three.js WebGPURenderer with a WebGL2 fallback; the shader is TSL.
 */
import * as THREE from 'three/webgpu';
import {
  abs,
  mix,
  mx_noise_float,
  select,
  max,
  sin,
  smoothstep,
  step,
  texture,
  uniform,
  uv,
  vec2,
  vec3,
  PI,
} from 'three/tsl';

export interface PhotoSwipeOptions {
  /** Image URLs, at least two. */
  faces: string[];
  /** Advance by itself when idle. Off under reduced motion. */
  autoAdvance: boolean;
  /** Called after a transition completes, with the new index. */
  onChange?: (index: number) => void;
}

export interface PhotoSwipeHandle {
  next(): void;
  prev(): void;
  goTo(index: number): void;
  dispose(): void;
}

const TRANSITION_MS = 1100;
const AUTO_ADVANCE_MS = 6000;
const DRAG_DISTANCE = 0.6; // fraction of the canvas width for a full transition by drag
const COMMIT_AT = 0.3; // progress beyond which a released drag completes

const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

export async function startPhotoSwipe(
  canvas: HTMLCanvasElement,
  options: PhotoSwipeOptions,
): Promise<PhotoSwipeHandle> {
  const count = options.faces.length;
  if (count < 2) throw new Error('PhotoSwipe needs at least two photos.');

  const renderer = new THREE.WebGPURenderer({ canvas, antialias: false, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x000000, 0);
  await renderer.init();

  const loader = new THREE.TextureLoader();
  const textures = await Promise.all(
    options.faces.map(
      (url) =>
        new Promise<THREE.Texture>((resolve, reject) => {
          loader.load(url, resolve, undefined, reject);
        }),
    ),
  );
  for (const t of textures) {
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  }

  // Uniforms the CPU drives.
  const uProgress = uniform(0); // 0: the current photo, 1: the next photo
  const uDirection = uniform(1); // +1: wipe left to right, -1: right to left
  const uTime = uniform(0);
  // uv scale that fits each photo whole into the canvas, by its own aspect
  const uFitFrom = uniform(new THREE.Vector2(1, 1));
  const uFitTo = uniform(new THREE.Vector2(1, 1));
  const fromTexture = texture(textures[0]!);
  const toTexture = texture(textures[1]!);

  // The shader.
  const base = uv();
  const wave = sin(uProgress.mul(PI)); // 0 at both ends, 1 in the middle
  const noise = mx_noise_float(vec3(base.mul(3.2), uTime.mul(0.12))); // about -1..1
  const along = select(uDirection.greaterThan(0), base.x, base.x.oneMinus());
  // Where the wipe front passes each pixel: mostly its position, partly the noise.
  const edge = along.mul(0.62).add(noise.mul(0.5).add(0.5).mul(0.38));
  const reveal = smoothstep(edge.sub(0.1), edge.add(0.1), uProgress.mul(1.2).sub(0.1));

  const displacement = vec2(
    noise.mul(0.06).add(0.05).mul(wave).mul(uDirection),
    noise.mul(0.025).mul(wave),
  );
  const zoom = (p: typeof uProgress, from: number, to: number) =>
    base
      .sub(0.5)
      .div(mix(from, to, p))
      .add(0.5);
  const fromUv = zoom(uProgress, 1.0, 1.07).add(displacement.mul(reveal));
  const toUv = zoom(uProgress, 1.09, 1.0).sub(displacement.mul(reveal.oneMinus()));

  const fit = (p: typeof fromUv, scale: typeof uFitFrom) => p.sub(0.5).mul(scale).add(0.5);
  const inside = (p: typeof fromUv) =>
    step(0, p.x).mul(step(p.x, 1)).mul(step(0, p.y)).mul(step(p.y, 1));
  const fromFit = fit(fromUv, uFitFrom);
  const toFit = fit(toUv, uFitTo);
  const fromMask = inside(fromFit);
  const toMask = inside(toFit);
  const fromColor = fromTexture.sample(fromFit).rgb.mul(fromMask);
  const toColor = toTexture.sample(toFit).rgb.mul(toMask);
  const alpha = mix(fromMask, toMask, reveal);
  // A soft shadow along the front gives the wipe a liquid thickness.
  const front = smoothstep(0.5, 0.0, abs(reveal.sub(0.5)))
    .mul(wave)
    .mul(0.35);
  const color = mix(fromColor, toColor, reveal).div(max(alpha, 0.001)).mul(front.oneMinus());

  const material = new THREE.MeshBasicNodeMaterial({ transparent: true });
  material.colorNode = color;
  material.opacityNode = alpha;

  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material));

  // State.
  let index = 0;
  let target = 1;
  let progress = 0;
  let direction = 1;
  let animation: { from: number; to: number; start: number; commit: boolean } | null = null;
  let dragging = false;
  let dragStartX = 0;
  let dragLocked = false;
  let hovering = false;
  let lastChange = performance.now();

  const wrap = (i: number) => ((i % count) + count) % count;

  const fitScale = (out: THREE.Vector2, photo: THREE.Texture) => {
    const { clientWidth: w, clientHeight: h } = canvas;
    const image = photo.image as { width: number; height: number };
    if (w === 0 || h === 0 || image.height === 0) {
      return;
    }
    const canvasAspect = w / h;
    const photoAspect = image.width / image.height;
    if (canvasAspect > photoAspect) {
      out.set(canvasAspect / photoAspect, 1);
    } else {
      out.set(1, photoAspect / canvasAspect);
    }
  };

  const setTarget = (i: number, dir: number) => {
    target = wrap(i);
    direction = dir;
    toTexture.value = textures[target]!;
    fitScale(uFitTo.value, textures[target]!);
    uDirection.value = dir;
  };

  const finish = () => {
    index = target;
    fromTexture.value = textures[index]!;
    fitScale(uFitFrom.value, textures[index]!);
    progress = 0;
    uProgress.value = 0;
    lastChange = performance.now();
    options.onChange?.(index);
  };

  const animateTo = (to: number, commit: boolean) => {
    animation = { from: progress, to, start: performance.now(), commit };
  };

  const go = (i: number, dir: number) => {
    if (animation || dragging) return;
    if (wrap(i) === index) return;
    setTarget(i, dir);
    animateTo(1, true);
  };

  const onPointerDown = (e: PointerEvent) => {
    if (animation) return;
    dragging = true;
    dragLocked = false;
    dragStartX = e.clientX;
    canvas.setPointerCapture(e.pointerId);
    canvas.style.cursor = 'grabbing';
  };
  const onPointerMove = (e: PointerEvent) => {
    hovering = true;
    if (!dragging) return;
    const dx = e.clientX - dragStartX;
    if (!dragLocked) {
      if (Math.abs(dx) < 4) return;
      dragLocked = true;
      // Drag left pulls the next photo in from the right.
      setTarget(dx < 0 ? index + 1 : index - 1, dx < 0 ? -1 : 1);
    }
    const sameWay = Math.sign(dx) === -direction;
    progress = sameWay
      ? THREE.MathUtils.clamp(Math.abs(dx) / (canvas.clientWidth * DRAG_DISTANCE), 0, 1)
      : 0;
    uProgress.value = progress;
  };
  const onPointerUp = (e: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    canvas.style.cursor = 'grab';
    if (!dragLocked) return;
    if (progress >= COMMIT_AT) animateTo(1, true);
    else animateTo(0, false);
  };
  const onPointerLeave = () => {
    hovering = false;
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      go(index + 1, -1);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      go(index - 1, 1);
    }
  };

  const resize = () => {
    const { clientWidth: w, clientHeight: h } = canvas;
    if (w === 0 || h === 0) return;
    renderer.setSize(w, h, false);
    fitScale(uFitFrom.value, textures[index]!);
    fitScale(uFitTo.value, textures[target]!);
  };
  resize();

  const frame = (now: DOMHighResTimeStamp) => {
    uTime.value = now / 1000;

    if (animation) {
      const t = Math.min((now - animation.start) / TRANSITION_MS, 1);
      const k = easeInOutCubic(t);
      progress = animation.from + (animation.to - animation.from) * k;
      uProgress.value = progress;
      if (t >= 1) {
        const { commit } = animation;
        animation = null;
        if (commit) finish();
        else lastChange = now;
      }
    } else if (
      options.autoAdvance &&
      !dragging &&
      !hovering &&
      now - lastChange > AUTO_ADVANCE_MS
    ) {
      go(index + 1, -1);
    }

    renderer.render(scene, camera);
  };

  let running = false;
  const start = () => {
    if (running) return;
    running = true;
    lastChange = performance.now();
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
  canvas.addEventListener('keydown', onKeyDown);
  window.addEventListener('resize', resize);
  document.addEventListener('visibilitychange', onVisibility);
  visible.observe(canvas);

  frame(performance.now());
  start();

  return {
    next: () => go(index + 1, -1),
    prev: () => go(index - 1, 1),
    goTo: (i) => go(i, wrap(i) > index ? -1 : 1),
    dispose() {
      stop();
      visible.disconnect();
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      canvas.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', resize);
      document.removeEventListener('visibilitychange', onVisibility);
      material.dispose();
      for (const t of textures) t.dispose();
      renderer.dispose();
    },
  };
}
