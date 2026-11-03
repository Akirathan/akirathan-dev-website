/**
 * Builds the web model of the CPU from the Onshape export.
 *
 *   node scripts/build-cpu-model.mjs
 *
 * Input:  cad/export/CPU.gltf   (Onshape glTF export of the Part Studio, Draco compressed)
 * Output: public/models/cpu.glb (meshopt compressed, pins and markers removed)
 *         src/data/cpu-model.json (trace end points and the parts list, for the loader)
 *
 * The pins are left out: 656 CAD cylinders are 143k triangles, while the page draws them as
 * one instanced mesh. The TraceEnd markers are read for their positions and then dropped.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshoptCompression } from '@gltf-transform/extensions';
import { dedup, join, prune, weld } from '@gltf-transform/functions';
import draco3d from 'draco3dgltf';
import { MeshoptEncoder } from 'meshoptimizer';

const INPUT = 'cad/export/CPU.gltf';
const OUTPUT_GLB = 'public/models/cpu.glb';
const OUTPUT_JSON = 'src/data/cpu-model.json';

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.decoder': await draco3d.createDecoderModule(),
  'meshopt.encoder': MeshoptEncoder,
});
await MeshoptEncoder.ready;

const document = await io.read(INPUT);
const root = document.getRoot();

// Trace end markers: centre of each tiny cube, in the export's own frame (metres, Z up).
const traceEnds = [];
for (const node of root.listNodes()) {
  const match = /^TraceEnd (\d+) (\d+)$/.exec(node.getName());
  if (!match) continue;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const primitive of node.getMesh().listPrimitives()) {
    const position = primitive.getAttribute('POSITION');
    position.getMin(min.slice()).forEach((v, i) => (min[i] = Math.min(min[i], v)));
    position.getMax(max.slice()).forEach((v, i) => (max[i] = Math.max(max[i], v)));
  }
  traceEnds.push({
    side: Number(match[1]),
    index: Number(match[2]),
    position: min.map((v, i) => Number(((v + max[i]) / 2).toFixed(6))),
  });
  node.dispose();
}
traceEnds.sort((a, b) => a.side - b.side || a.index - b.index);

// Pins: drawn procedurally on the page.
for (const node of root.listNodes()) {
  if (node.getName() === 'Pins') node.dispose();
}

await document.transform(
  dedup(),
  prune(),
  weld(),
  // Merge the per-face primitives of each part, and the capacitors into one mesh.
  join({ keepNamed: false }),
);

// The input was Draco compressed; the output uses meshopt, whose decoder is a small module.
for (const extension of root.listExtensionsUsed()) {
  if (extension.extensionName === 'KHR_draco_mesh_compression') extension.dispose();
}
document.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({
  method: EXTMeshoptCompression.EncoderMethod.FILTER,
});

// join() merged the capacitors into one node; give it a stable name.
for (const node of root.listNodes()) {
  if (node.getName().startsWith('Capacitor ')) node.setName('Capacitors');
}

const parts = root
  .listNodes()
  .map((n) => n.getName())
  .filter(Boolean);
await mkdir('public/models', { recursive: true });
await io.write(OUTPUT_GLB, document);
await writeFile(
  OUTPUT_JSON,
  JSON.stringify({ units: 'metre', up: 'z', parts, traceEnds }, null, 2) + '\n',
);

const { size } = await import('node:fs').then((fs) => fs.statSync(OUTPUT_GLB));
console.log(`${OUTPUT_GLB}: ${(size / 1024).toFixed(0)} KB, parts: ${parts.join(', ')}`);
console.log(`${OUTPUT_JSON}: ${traceEnds.length} trace ends`);
