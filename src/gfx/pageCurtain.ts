/**
 * A full-screen curtain for page transitions.
 *
 * The same liquid wipe as the photo gallery, on a coloured surface: `cover()` sweeps it over
 * the page, `reveal()` sweeps it away on the far side. The page swap happens in between.
 * Three.js WebGPURenderer with a WebGL2 fallback; the shader is TSL.
 */
import * as THREE from 'three/webgpu';
import { abs, mix, mx_noise_float, select, smoothstep, uniform, uv, vec2, vec3 } from 'three/tsl';

export interface PageCurtainOptions {
  /** Curtain colour. */
  color: THREE.ColorRepresentation;
  /** Colour of the band along the moving front. */
  frontColor: THREE.ColorRepresentation;
  durationMs?: number;
}

export interface PageCurtainHandle {
  /** Sweep in. +1 from the left, -1 from the right. Resolves when the page is fully covered. */
  cover(direction: 1 | -1): Promise<void>;
  /** Sweep out on the far side. Resolves when the page is fully visible again. */
  reveal(): Promise<void>;
  dispose(): void;
}

const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

export async function startPageCurtain(
  canvas: HTMLCanvasElement,
  options: PageCurtainOptions,
): Promise<PageCurtainHandle> {
  const duration = options.durationMs ?? 650;

  const renderer = new THREE.WebGPURenderer({ canvas, antialias: false, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x000000, 0);
  await renderer.init();

  // progress runs 0 -> 1 while covering and 1 -> 2 while revealing.
  const uProgress = uniform(0);
  const uDirection = uniform(1);
  const uSeed = uniform(0);
  const uAspect = uniform(1);

  const base = uv();
  const along = select(uDirection.greaterThan(0), base.x, base.x.oneMinus());
  const noise = mx_noise_float(vec3(base.mul(vec2(uAspect.mul(1.6), 1.6)), uSeed));
  const edge = along.mul(0.62).add(noise.mul(0.5).add(0.5).mul(0.38));
  const soft = 0.09;
  const sweep = (p: THREE.Node<'float'>) =>
    smoothstep(edge.sub(soft), edge.add(soft), p.mul(1.36).sub(0.18));
  const front1 = sweep(uProgress);
  const front2 = sweep(uProgress.sub(1));
  const covered = front1.sub(front2);
  const band = smoothstep(0.5, 0.0, abs(front1.sub(0.5))).add(
    smoothstep(0.5, 0.0, abs(front2.sub(0.5))),
  );

  const color = new THREE.Color(options.color);
  const frontColor = new THREE.Color(options.frontColor);
  const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
  material.colorNode = mix(
    vec3(color.r, color.g, color.b),
    vec3(frontColor.r, frontColor.g, frontColor.b),
    band.mul(0.55),
  );
  material.opacityNode = covered;

  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material));

  const resize = () => {
    const { clientWidth: w, clientHeight: h } = canvas;
    if (w === 0 || h === 0) return;
    renderer.setSize(w, h, false);
    uAspect.value = w / h;
  };
  window.addEventListener('resize', resize);

  const animate = (from: number, to: number) =>
    new Promise<void>((resolve) => {
      resize();
      canvas.style.visibility = 'visible';
      const start = performance.now();
      const tick = (now: number) => {
        const t = Math.min((now - start) / duration, 1);
        uProgress.value = from + (to - from) * easeInOutCubic(t);
        renderer.render(scene, camera);
        if (t < 1) requestAnimationFrame(tick);
        else resolve();
      };
      requestAnimationFrame(tick);
    });

  return {
    async cover(direction) {
      uDirection.value = direction;
      uSeed.value = Math.random() * 100;
      await animate(0, 1);
    },
    async reveal() {
      await animate(1, 2);
      uProgress.value = 0;
      canvas.style.visibility = 'hidden';
    },
    dispose() {
      window.removeEventListener('resize', resize);
      material.dispose();
      renderer.dispose();
    },
  };
}
