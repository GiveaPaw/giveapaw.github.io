// Shared 3D model converter for the Give a Paw site: STL, OBJ, 3MF or GLB in, a compressed GLB out
// that the review page, the walkthroughs, the editor's media gallery and PowerPoint can open.
// Everything runs in the browser: three.js loaders read the file, meshoptimizer decimates it,
// gltf-transform writes the GLB and Draco-compresses it. Nothing is uploaded anywhere.
//
// Conventions match tools/convert_ollie_v3_sweeps.py (the Python pipeline used for the sweeps):
// Z-up millimetres (nTop's frame, which every model on the site shares), one merged mesh with smooth
// vertex normals, the matte grey material written as the same linear base colour the Python exports
// use, the "Presentation" tier at about 150,000 triangles, and gltf-transform's default Draco settings.
//
// Used by convert.html (the public page for students) and review-gallery.js (the editor's gallery).

import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { ThreeMFLoader } from 'three/addons/loaders/3MFLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import * as fflate from 'three/addons/libs/fflate.module.js';

const DRACO_LIBS = 'https://unpkg.com/three@0.170.0/examples/jsm/libs/draco/';   // decoder, as the review page uses
const DRACO3D = 'https://cdn.jsdelivr.net/npm/draco3d@1.5.7/';                      // WebAssembly encoder
const MESHOPT_URL = 'https://cdn.jsdelivr.net/npm/meshoptimizer@0.22.0/meshopt_simplifier.module.js';
// All three at the same version: the functions bundle imports core and extensions by exact version,
// so importing a different version here would give two copies of the classes.
const GLTF_CORE = 'https://cdn.jsdelivr.net/npm/@gltf-transform/core@4.5.1/+esm';
const GLTF_EXT = 'https://cdn.jsdelivr.net/npm/@gltf-transform/extensions@4.5.1/+esm';
const GLTF_FN = 'https://cdn.jsdelivr.net/npm/@gltf-transform/functions@4.5.1/+esm';

export const PRESENTATION_FACES = 150000;
export const TIERS = [
    { key: 'presentation', label: 'Presentation', faces: PRESENTATION_FACES,
      blurb: 'About 150,000 triangles. Opens in a second or two, also on phones. The setting every model on the site uses.' },
    { key: 'full', label: 'Full', faces: Infinity,
      blurb: 'Every triangle kept, only compressed. The biggest file. For close-ups where Presentation loses detail you need.' },
];
export const UNITS = [
    { key: 'mm', label: 'Millimetres (nTop, SolidWorks, most CAD)', factor: 1 },
    { key: 'cm', label: 'Centimetres', factor: 10 },
    { key: 'm', label: 'Metres (some scanners, Blender)', factor: 1000 },
    { key: 'in', label: 'Inches', factor: 25.4 },
];
export const UPS = [
    { key: 'Z', label: 'Z is up (nTop, SolidWorks, CAD exports, files from this site)' },
    { key: 'Y', label: 'Y is up (Blender, Maya, most GLB files)' },
];
// The Python pipeline writes baseColorFactor [185, 194, 204] / 255 straight into the GLB (a linear
// value), so the same numbers are written here and the result matches the sweeps exactly.
export const MATTE_GREY = [185, 194, 204];
export const ACCEPT = '.stl,.obj,.3mf,.glb,.gltf';

export function fileKind(name) {
    const ext = String(name || '').split('?')[0].split('.').pop().toLowerCase();
    return ext === 'stl' ? 'stl' : ext === 'obj' ? 'obj' : ext === '3mf' ? '3mf' : ext === 'glb' || ext === 'gltf' ? 'glb' : null;
}
export const fmtInt = n => Math.round(n).toLocaleString('en-US');
export const fmtBytes = b => b >= 1e6 ? `${(b / 1e6).toFixed(b >= 1e7 ? 0 : 1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`;
export const fmtMm = v => v >= 1000 ? `${(v / 1000).toFixed(2)} m` : v >= 10 ? `${Math.round(v)} mm` : `${v.toFixed(1)} mm`;
export function sizeText(box) {
    const s = new THREE.Vector3();
    box.getSize(s);
    return `${fmtMm(s.x)} × ${fmtMm(s.y)} × ${fmtMm(s.z)} (X × Y × Z)`;
}

let gltfLoader;
function loaderForGlb() {
    if (!gltfLoader) {
        const draco = new DRACOLoader();
        draco.setDecoderPath(DRACO_LIBS);
        gltfLoader = new GLTFLoader();
        gltfLoader.setDRACOLoader(draco);
    }
    return gltfLoader;
}

async function bytesOf(source) {
    if (source instanceof ArrayBuffer) return source;
    if (typeof source === 'string') {
        const response = await fetch(source);
        if (!response.ok) throw new Error(`Could not load ${source} (${response.status}).`);
        return response.arrayBuffer();
    }
    return source.arrayBuffer();
}

// Every mesh of a loaded object, in world space, as one flat non-indexed position array.
function collectPositions(root) {
    root.updateMatrixWorld(true);
    const chunks = [];
    let parts = 0;
    const v = new THREE.Vector3();
    root.traverse(object => {
        if (!object.isMesh || !object.geometry?.attributes?.position) return;
        let geometry = object.geometry;
        if (geometry.index) geometry = geometry.toNonIndexed();
        const position = geometry.attributes.position;
        const count = position.count - (position.count % 3);
        const out = new Float32Array(count * 3);
        for (let i = 0; i < count; i++) {
            v.fromBufferAttribute(position, i).applyMatrix4(object.matrixWorld);
            out[i * 3] = v.x; out[i * 3 + 1] = v.y; out[i * 3 + 2] = v.z;
        }
        chunks.push(out);
        parts++;
    });
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const positions = new Float32Array(total);
    let offset = 0;
    chunks.forEach(c => { positions.set(c, offset); offset += c.length; });
    return { positions, parts };
}

/**
 * A direct reader for the 3MF files nTop exports: unzip, find the model XML, scan its vertices and
 * triangles with regular expressions. three's ThreeMFLoader parses the same XML as a DOM, which for a
 * million-triangle export is tens of megabytes of markup and takes far longer. Returns null for files
 * that use components, materials or several models, so the full loader handles those.
 */
function read3mf(buffer) {
    let files;
    try { files = fflate.unzipSync(new Uint8Array(buffer)); } catch { return null; }
    const names = Object.keys(files).filter(n => /\.model$/i.test(n) && !/^\[|rels/i.test(n));
    if (names.length !== 1) return null;
    const xml = new TextDecoder().decode(files[names[0]]);
    if (/<components>|<component\b/.test(xml)) return null;
    const unitScale = { micron: 0.001, millimeter: 1, centimeter: 10, inch: 25.4, foot: 304.8, meter: 1000 }[(xml.match(/<model\b[^>]*\bunit="([a-z]+)"/i) || [])[1] || 'millimeter'];
    if (!unitScale) return null;
    const objects = new Map();
    const objectRe = /<object\b([^>]*)>([\s\S]*?)<\/object>/g;
    let match;
    while ((match = objectRe.exec(xml))) {
        const id = (match[1].match(/\bid="(\d+)"/) || [])[1];
        const body = match[2];
        const vertexText = (body.match(/<vertices>([\s\S]*?)<\/vertices>/) || [])[1];
        const triangleText = (body.match(/<triangles>([\s\S]*?)<\/triangles>/) || [])[1];
        if (!id || !vertexText || !triangleText) continue;
        const vertices = [];
        const vertexRe = /<vertex\b[^>]*\bx="([^"]+)"[^>]*\by="([^"]+)"[^>]*\bz="([^"]+)"/g;
        while ((match = vertexRe.exec(vertexText))) vertices.push(+match[1], +match[2], +match[3]);
        const triangles = [];
        const triangleRe = /<triangle\b[^>]*\bv1="(\d+)"[^>]*\bv2="(\d+)"[^>]*\bv3="(\d+)"/g;
        while ((match = triangleRe.exec(triangleText))) triangles.push(+match[1], +match[2], +match[3]);
        objects.set(id, { vertices: Float64Array.from(vertices), triangles: Uint32Array.from(triangles) });
    }
    if (!objects.size) return null;
    const items = [];
    const itemRe = /<item\b([^>]*)\/?>/g;
    while ((match = itemRe.exec(xml))) {
        const id = (match[1].match(/\bobjectid="(\d+)"/) || [])[1];
        const t = (match[1].match(/\btransform="([^"]+)"/) || [])[1];
        if (id && objects.has(id)) items.push({ id, transform: t ? t.trim().split(/\s+/).map(Number) : null });
    }
    if (!items.length) items.push(...[...objects.keys()].map(id => ({ id, transform: null })));
    let total = 0;
    items.forEach(it => { total += objects.get(it.id).triangles.length * 3; });
    const positions = new Float32Array(total);
    let offset = 0;
    for (const it of items) {
        const { vertices, triangles } = objects.get(it.id);
        const m = it.transform && it.transform.length === 12 ? it.transform : null;
        for (let k = 0; k < triangles.length; k++) {
            const v = triangles[k] * 3;
            let x = vertices[v] * unitScale, y = vertices[v + 1] * unitScale, z = vertices[v + 2] * unitScale;
            if (m) {   // 3MF transforms are row-major 4x3: [m00 m01 m02 m10 m11 m12 m20 m21 m22 m30 m31 m32]
                const tx = x * m[0] + y * m[3] + z * m[6] + m[9] * unitScale;
                const ty = x * m[1] + y * m[4] + z * m[7] + m[10] * unitScale;
                const tz = x * m[2] + y * m[5] + z * m[8] + m[11] * unitScale;
                x = tx; y = ty; z = tz;
            }
            positions[offset++] = x; positions[offset++] = y; positions[offset++] = z;
        }
    }
    return { positions, parts: items.length };
}

/**
 * Read a model file. `source` is a File, Blob, ArrayBuffer or a same-origin URL; `name` decides the
 * parser. Returns the raw triangles exactly as stored in the file (no orientation or unit change).
 */
export async function loadMesh(source, name) {
    const kind = fileKind(name);
    if (!kind) throw new Error('Choose an STL, OBJ, 3MF or GLB file.');
    const buffer = await bytesOf(source);
    if (!buffer.byteLength) throw new Error('The file is empty.');
    let positions, parts = 1;
    if (kind === 'stl') {
        const geometry = new STLLoader().parse(buffer);
        positions = geometry.attributes.position.array;
        if (positions.length % 9) positions = positions.subarray(0, positions.length - (positions.length % 9));
    } else if (kind === 'obj') {
        ({ positions, parts } = collectPositions(new OBJLoader().parse(new TextDecoder().decode(buffer))));
    } else if (kind === '3mf') {
        const fast = read3mf(buffer);
        ({ positions, parts } = fast || collectPositions(new ThreeMFLoader().parse(buffer)));
    } else {
        const gltf = await new Promise((resolve, reject) => loaderForGlb().parse(buffer, '', resolve, reject));
        ({ positions, parts } = collectPositions(gltf.scene));
    }
    const faces = positions.length / 9;
    if (!faces) throw new Error('No triangles were found in that file.');
    return { kind, name, bytes: buffer.byteLength, positions, faces, parts, bounds: boundsOf(positions) };
}

function boundsOf(positions) {
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let i = 0; i < positions.length; i += 3) {
        const x = positions[i], y = positions[i + 1], z = positions[i + 2];
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
        if (z < z0) z0 = z; if (z > z1) z1 = z;
    }
    return new THREE.Box3(new THREE.Vector3(x0, y0, z0), new THREE.Vector3(x1, y1, z1));
}

/**
 * Put the raw triangles into the site's frame (Z up, millimetres), weld shared vertices and compute
 * smooth normals. Returns an indexed BufferGeometry.
 */
export function prepare(raw, { up = 'Z', unit = 'mm' } = {}) {
    const factor = (UNITS.find(u => u.key === unit) || UNITS[0]).factor;
    const src = raw.positions;
    const positions = new Float32Array(src.length);
    for (let i = 0; i < src.length; i += 3) {
        const x = src[i] * factor, y = src[i + 1] * factor, z = src[i + 2] * factor;
        if (up === 'Y') { positions[i] = x; positions[i + 1] = -z; positions[i + 2] = y; }   // +90° about X: Y becomes Z
        else { positions[i] = x; positions[i + 1] = y; positions[i + 2] = z; }
    }
    const geometry = weld(positions);
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    return geometry;
}

/**
 * Index a triangle soup, merging vertices that sit on the same spot (within `tolerance`, default a
 * millionth of the model's size). BufferGeometryUtils.mergeVertices does the same with one string
 * key per vertex, which takes tens of seconds for a million-triangle nTop export; this sorts numeric
 * hashes in typed arrays instead and takes well under a second.
 */
export function weld(positions, tolerance) {
    const count = positions.length / 3;
    const diagonal = boundsOf(positions).getSize(new THREE.Vector3()).length() || 1;
    const tol = tolerance || Math.max(1e-5, diagonal * 1e-6);
    const inv = 1 / tol;
    // One number per vertex from its quantised coordinates, looked up in a Map (numeric keys are
    // fast). Two different spots with the same hash are told apart by comparing coordinates; the
    // second one is filed under a nudged key.
    const seen = new Map();
    const remap = new Uint32Array(count);
    const unique = [];
    for (let i = 0; i < count; i++) {
        const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
        let key = (Math.round(x * inv) * 73856093 + Math.round(y * inv) * 19349663 + Math.round(z * inv) * 83492791) % 4503599627370496;   // 2^52 keeps it exact
        for (;;) {
            const n = seen.get(key);
            if (n === undefined) { seen.set(key, unique.length); remap[i] = unique.length; unique.push(i); break; }
            const j = unique[n] * 3;
            if (Math.abs(positions[j] - x) <= tol && Math.abs(positions[j + 1] - y) <= tol && Math.abs(positions[j + 2] - z) <= tol) { remap[i] = n; break; }
            key += 0.5;
        }
    }
    const out = new Float32Array(unique.length * 3);
    for (let n = 0; n < unique.length; n++) { const i = unique[n] * 3; out[n * 3] = positions[i]; out[n * 3 + 1] = positions[i + 1]; out[n * 3 + 2] = positions[i + 2]; }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(out, 3));
    geometry.setIndex(new THREE.BufferAttribute(remap, 1));
    return geometry;
}

let simplifierPromise;
async function simplifier() {
    simplifierPromise ||= import(MESHOPT_URL).then(async m => { await m.MeshoptSimplifier.ready; return m.MeshoptSimplifier; });
    return simplifierPromise;
}

/** Decimate to about `targetFaces` triangles (meshoptimizer). Returns a new geometry, or the same one if already small enough. */
export async function simplify(geometry, targetFaces, { lockBorder = true } = {}) {
    const faces = geometry.index.count / 3;
    if (!(targetFaces < faces)) return geometry;
    const ms = await simplifier();
    const index = geometry.index.array instanceof Uint32Array ? geometry.index.array : new Uint32Array(geometry.index.array);
    const positions = geometry.attributes.position.array;
    const flags = lockBorder ? ['LockBorder'] : [];
    const target = Math.max(1, Math.floor(targetFaces)) * 3;
    // The error bound is relative to the model's extent. Start tight; if the mesh will not shrink
    // that far within it, allow more so the requested budget is reached.
    let [result] = ms.simplify(index, positions, 3, target, 0.02, flags);
    if (result.length > target * 1.2) [result] = ms.simplify(index, positions, 3, target, 1, flags);
    // Drop the vertices nothing references any more.
    const remap = new Uint32Array(positions.length / 3).fill(0xffffffff);
    let unique = 0;
    for (let i = 0; i < result.length; i++) if (remap[result[i]] === 0xffffffff) remap[result[i]] = unique++;
    const outPositions = new Float32Array(unique * 3);
    for (let old = 0; old < remap.length; old++) {
        const n = remap[old];
        if (n !== 0xffffffff) { outPositions[n * 3] = positions[old * 3]; outPositions[n * 3 + 1] = positions[old * 3 + 1]; outPositions[n * 3 + 2] = positions[old * 3 + 2]; }
    }
    const outIndex = new Uint32Array(result.length);
    for (let i = 0; i < result.length; i++) outIndex[i] = remap[result[i]];
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.BufferAttribute(outPositions, 3));
    out.setIndex(new THREE.BufferAttribute(outIndex, 1));
    out.computeVertexNormals();
    out.computeBoundingBox();
    return out;
}

let gltfModules, encoderPromise;
async function gltf() {
    gltfModules ||= Promise.all([import(GLTF_CORE), import(GLTF_EXT), import(GLTF_FN)]).then(([core, ext, fn]) => ({ core, ext, fn }));
    return gltfModules;
}
function dracoEncoder() {
    // The WebAssembly encoder from Google's draco3d package. (three.js only bundles the asm.js
    // encoder, draco_encoder.js, which took over a minute for a 150,000-triangle socket here.) The
    // package's "nodejs" wrapper is a CommonJS emscripten module that also runs in a browser; it is
    // evaluated by hand because a CommonJS file cannot be imported as a module, and told where the
    // .wasm lives.
    encoderPromise ||= (async () => {
        const response = await fetch(DRACO3D + 'draco_encoder_nodejs.js');
        if (!response.ok) throw new Error('Could not load the Draco encoder (check the internet connection).');
        const cjs = { exports: {} };
        new Function('module', 'exports', 'require', await response.text())(cjs, cjs.exports, () => { throw new Error('Node only'); });
        const factory = typeof cjs.exports === 'function' ? cjs.exports : cjs.exports.default;
        const module = await factory({ locateFile: file => DRACO3D + file });
        if (!module?.Encoder) throw new Error('The Draco encoder did not start.');
        return module;
    })();
    encoderPromise.catch(() => { encoderPromise = null; });   // let a failed download be retried
    return encoderPromise;
}

/** Write the geometry as a GLB (Draco-compressed unless `draco: false`). Returns the file's bytes. */
export async function toGlb(geometry, { color = MATTE_GREY, roughness = 0.85, name = 'model', draco = true } = {}) {
    const { core, ext, fn } = await gltf();
    const doc = new core.Document();
    const buffer = doc.createBuffer();
    const position = doc.createAccessor('POSITION').setType('VEC3').setArray(new Float32Array(geometry.attributes.position.array)).setBuffer(buffer);
    const normal = doc.createAccessor('NORMAL').setType('VEC3').setArray(new Float32Array(geometry.attributes.normal.array)).setBuffer(buffer);
    const indexArray = geometry.attributes.position.count <= 65535 ? new Uint16Array(geometry.index.array) : new Uint32Array(geometry.index.array);
    const indices = doc.createAccessor('INDEX').setType('SCALAR').setArray(indexArray).setBuffer(buffer);
    const material = doc.createMaterial('matte').setBaseColorFactor([color[0] / 255, color[1] / 255, color[2] / 255, 1]).setMetallicFactor(0).setRoughnessFactor(roughness);
    const primitive = doc.createPrimitive().setAttribute('POSITION', position).setAttribute('NORMAL', normal).setIndices(indices).setMaterial(material);
    const mesh = doc.createMesh(name).addPrimitive(primitive);
    const node = doc.createNode(name).setMesh(mesh);
    doc.createScene(name).addChild(node);
    const io = new core.WebIO().registerExtensions([ext.KHRDracoMeshCompression]);
    if (draco) {
        io.registerDependencies({ 'draco3d.encoder': await dracoEncoder() });
        await doc.transform(fn.draco({ method: 'edgebreaker' }));
    }
    return io.writeBinary(doc);
}

export function tierFaces(tier, custom) {
    if (tier === 'custom') return Math.max(1000, Math.round(+custom || PRESENTATION_FACES));
    return (TIERS.find(t => t.key === tier) || TIERS[0]).faces;
}

/**
 * The whole pipeline for one file: load, orient, decimate, write.
 *   options: { up, unit, tier: 'presentation' | 'full' | 'custom', faces (custom), color, name }
 *   progress(message, fraction) is called between steps.
 * Returns { glb: Blob, geometry (as written), stats: { facesIn, facesOut, bytesIn, bytesOut, ms, bounds, parts, kind } }.
 */
export async function convert(source, name, options = {}, progress = () => {}) {
    const started = performance.now();
    progress('Reading the file', 0.05);
    await tick();
    const raw = source.positions ? source : await loadMesh(source, name);
    progress('Lining it up and smoothing', 0.25);
    await tick();
    // options.prepared: a geometry the caller already made with prepare() for these options (kept, not disposed).
    const geometry = options.prepared || prepare(raw, options);
    const target = tierFaces(options.tier || 'presentation', options.faces);
    progress(target < raw.faces ? `Simplifying to ${fmtInt(target)} triangles` : 'Keeping every triangle', 0.45);
    await tick();
    const reduced = await simplify(geometry, target);
    if (reduced !== geometry && !options.prepared) geometry.dispose();
    progress('Writing the plain GLB', 0.7);
    await tick();
    const stem = (options.name || name || 'model').replace(/\.[^.]+$/, '');
    // Two files: a plain GLB (PowerPoint and most tools; Office does not read Draco) and the
    // Draco-compressed one the site's viewers use, a tenth of the size.
    const plain = await toGlb(reduced, { color: options.color || MATTE_GREY, name: stem, draco: false });
    progress('Compressing for the website', 0.8);
    await tick();
    const bytes = await toGlb(reduced, { color: options.color || MATTE_GREY, name: stem });
    progress('Done', 1);
    return {
        glb: new Blob([bytes], { type: 'model/gltf-binary' }),
        plain: new Blob([plain], { type: 'model/gltf-binary' }),
        geometry: reduced,
        stats: { facesIn: raw.faces, facesOut: reduced.index.count / 3, bytesIn: raw.bytes, bytesOut: bytes.byteLength, bytesPlain: plain.byteLength,
                 ms: performance.now() - started, bounds: reduced.boundingBox.clone(), parts: raw.parts, kind: raw.kind },
    };
}

// Let the page draw the progress text between steps. A MessageChannel hop is not slowed down in a
// background tab the way setTimeout is.
const tick = () => new Promise(resolve => { const channel = new MessageChannel(); channel.port1.onmessage = () => resolve(); channel.port2.postMessage(0); });

/** A safe, site-style file name for the output: lowercase, dashes, .glb. */
export function outputName(name) {
    const stem = String(name || 'model').split(/[\\/]/).pop().replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
    return `${stem || 'model'}.glb`;
}

/** A one-screen presentation (review file) that shows the converted model, for design-review.html. */
export function deckFor(glbName, title) {
    const stem = glbName.replace(/\.glb$/i, '');
    return {
        id: stem,
        title: title || stem,
        subtitle: 'Give a Paw',
        intro: '',
        reviewerDefault: '',
        returnEmail: '',
        items: [{
            id: 'model',
            kind: 'stage',
            title: title || stem,
            context: '',
            sources: { model: { kind: 'assembly', label: '3D model', caption: '', layers: [{ key: 'part-1', label: title || stem, file: glbName, color: '#b9c2cc', opacity: 1 }] } },
            views: [{ key: 'model', label: '3D model', icon: 'box', panes: ['model'] }],
        }],
    };
}
