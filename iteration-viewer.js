// Shared 3D viewer for the iteration-history prototypes (iteration-a/b/c.html).
// Loads Ollie's socket versions (Draco GLBs, millimetres, Z up, one shared scan frame),
// draws numbered pins, flies between saved views, links two viewers' cameras, colours
// one version by how far its surface moved from another, and wipes between two versions.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { MeshBVH } from 'three-mesh-bvh';

const draco = new DRACOLoader();
draco.setDecoderPath('https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/libs/draco/');
const loader = new GLTFLoader();
loader.setDRACOLoader(draco);

// One merged geometry per file, shared by every viewer on the page.
const geometryCache = new Map();
export function loadGeometry(file) {
    if (!geometryCache.has(file)) {
        geometryCache.set(file, new Promise((resolve, reject) => loader.load(file, gltf => {
            gltf.scene.updateMatrixWorld(true);
            const parts = [];
            gltf.scene.traverse(o => {
                if (!o.isMesh) return;
                const g = o.geometry.clone();
                g.applyMatrix4(o.matrixWorld);
                for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
                if (!g.index) g.setIndex([...Array(g.attributes.position.count).keys()]);
                parts.push(g);
            });
            const merged = parts.length === 1 ? parts[0] : mergeGeometries(parts);
            if (!merged.attributes.normal) merged.computeVertexNormals();
            merged.computeBoundingBox();
            resolve(merged);
        }, undefined, reject)));
        geometryCache.get(file).catch(() => geometryCache.delete(file)); // let a failed file be retried
    }
    return geometryCache.get(file);
}

const SOCKET_GREY = 0xc9d0d8;
const THRESH_GREY = new THREE.Color(SOCKET_GREY);

export function createViewer(container, { background = 0xf3f5f8, up = 'z' } = {}) {
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.localClippingEnabled = true;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(renderer.domElement);
    renderer.domElement.classList.add('iv-canvas');

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(background);
    const camera = new THREE.PerspectiveCamera(35, 1, 1, 10000);
    if (up === 'y') camera.up.set(0, 1, 0); else camera.up.set(0, 0, 1);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x8792a0, 1.6));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    camera.add(key);
    key.position.set(1, 2, 3);
    scene.add(camera);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.1;
    controls.screenSpacePanning = true;

    const pinLayer = document.createElement('div');
    pinLayer.className = 'iv-pins';
    container.appendChild(pinLayer);

    const meshes = new Map(); // slot -> mesh
    let pins = [];
    let pinClick = null;
    let pickHandler = null;
    let flight = null;
    const listeners = new Set();
    const raycaster = new THREE.Raycaster();

    function resize() {
        const w = container.clientWidth, h = container.clientHeight;
        if (!w || !h) return;
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
    }
    const sizer = new ResizeObserver(resize);
    sizer.observe(container);
    resize();

    async function setModel(slot, file, { color = SOCKET_GREY, opacity = 1, visible = true } = {}) {
        const old = meshes.get(slot);
        if (old) { scene.remove(old); old.material.dispose(); meshes.delete(slot); }
        if (!file) return null;
        const geometry = await loadGeometry(file);
        const material = new THREE.MeshStandardMaterial({
            color, roughness: 0.75, metalness: 0, side: THREE.DoubleSide,
            transparent: opacity < 1, opacity, depthWrite: opacity >= 1,
        });
        // A per-viewer copy of the colour attribute lets two viewers colour the same file differently.
        const mesh = new THREE.Mesh(geometry, material);
        mesh.userData.file = file;
        mesh.visible = visible;
        mesh.renderOrder = opacity < 1 ? 2 : 1;
        scene.add(mesh);
        meshes.set(slot, mesh);
        return mesh;
    }

    function setVisible(slot, visible) { const m = meshes.get(slot); if (m) m.visible = visible; }

    function frame(slot = 'main', direction = up === 'y' ? new THREE.Vector3(0.2, 0.35, 1) : new THREE.Vector3(0.2, -1, 0.35)) {
        const m = meshes.get(slot);
        if (!m) return;
        const box = m.geometry.boundingBox;
        const center = box.getCenter(new THREE.Vector3());
        const radius = box.getSize(new THREE.Vector3()).length() / 2;
        // Fit the bounding sphere in whichever of the two fields of view is narrower.
        const vFov = THREE.MathUtils.degToRad(camera.fov);
        const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
        const dist = radius / Math.sin(Math.min(vFov, hFov) / 2) * 0.9;
        controls.target.copy(center);
        camera.position.copy(center).addScaledVector(direction.clone().normalize(), dist);
        camera.near = dist / 50; camera.far = dist * 20; camera.updateProjectionMatrix();
        controls.update();
    }

    function getView() {
        return { position: camera.position.toArray().map(v => +v.toFixed(1)), target: controls.target.toArray().map(v => +v.toFixed(1)) };
    }

    function flyTo(view, ms = 700) {
        flight = { t0: performance.now(), ms, p0: camera.position.clone(), t0v: controls.target.clone(),
            p1: new THREE.Vector3(...view.position), t1: new THREE.Vector3(...view.target) };
    }

    // Pins: HTML markers projected every frame; dimmed when the model hides them.
    function setPins(list, onClick) {
        pins = list.map((p, i) => ({ ...p, n: p.n ?? i + 1 }));
        pinClick = onClick;
        pinLayer.replaceChildren(...pins.map(p => {
            const el = document.createElement('button');
            el.type = 'button';
            el.className = 'iv-pin' + (p.active ? ' active' : '') + (p.resolved ? ' resolved' : '');
            el.textContent = p.n;
            el.title = p.note || '';
            el.setAttribute('aria-label', 'Pin ' + p.n + (p.note ? ': ' + p.note : ''));
            el.addEventListener('click', e => { e.stopPropagation(); pinClick?.(p); });
            p.el = el;
            return el;
        }));
    }

    let occlusionTick = 0;
    function placePins(now) {
        const w = container.clientWidth, h = container.clientHeight;
        const checkOcclusion = now - occlusionTick > 250;
        if (checkOcclusion) occlusionTick = now;
        const solids = [...meshes.values()].filter(m => m.visible && m.material.opacity >= 1);
        for (const p of pins) {
            const v = new THREE.Vector3(...p.pos);
            const s = v.clone().project(camera);
            const onScreen = s.z < 1 && Math.abs(s.x) <= 1.05 && Math.abs(s.y) <= 1.05;
            p.el.hidden = !onScreen;
            if (!onScreen) continue;
            p.el.style.transform = `translate(${(s.x + 1) / 2 * w}px, ${(1 - s.y) / 2 * h}px)`;
            if (checkOcclusion && solids.length) {
                const dir = v.clone().sub(camera.position);
                const len = dir.length();
                raycaster.set(camera.position, dir.normalize());
                raycaster.far = len - 1.5;
                p.el.classList.toggle('behind', raycaster.intersectObjects(solids, false).length > 0);
            }
        }
    }

    // Click-to-pick (dropping pins). Drags still orbit.
    let down = null;
    renderer.domElement.addEventListener('pointerdown', e => { down = { x: e.clientX, y: e.clientY }; });
    // Picks on `click`, the last event of a tap, so a touch's follow-up click cannot land on
    // whatever the page shows in response.
    renderer.domElement.addEventListener('click', e => {
        if (!pickHandler || !down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 8) return;
        const hit = pickAt(e.clientX, e.clientY);
        if (hit) pickHandler(hit);
    });

    // The point on the main model under a screen position, or null.
    function pickAt(clientX, clientY) {
        const r = renderer.domElement.getBoundingClientRect();
        const ndc = new THREE.Vector2((clientX - r.left) / r.width * 2 - 1, -(clientY - r.top) / r.height * 2 + 1);
        raycaster.setFromCamera(ndc, camera);
        raycaster.far = Infinity;
        const target = meshes.get('main');
        const hit = target && raycaster.intersectObject(target, false)[0];
        if (!hit) return null;
        const n = hit.face.normal.clone().transformDirection(target.matrixWorld);
        return { pos: hit.point.toArray().map(v => +v.toFixed(2)), normal: n.toArray().map(v => +v.toFixed(3)) };
    }

    function setPickMode(handler) {
        pickHandler = handler;
        container.classList.toggle('iv-picking', !!handler);
    }

    // Colour `slot` by its signed distance from another file's surface (outward = red, inward = blue).
    async function colorByChange(slot, baseFile, { range = 10, deadband = 1, onProgress } = {}) {
        const mesh = meshes.get(slot);
        const base = await loadGeometry(baseFile);
        base.boundsTree ||= new MeshBVH(base);
        const geo = mesh.geometry.clone(); // own colour attribute, shared positions
        mesh.geometry = geo;
        const pos = geo.attributes.position;
        const n = pos.count;
        const values = new Float32Array(n);
        const colors = new Float32Array(n * 3);
        const p = new THREE.Vector3(), a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
        const tri = new THREE.Triangle(), normal = new THREE.Vector3(), hit = {};
        const bIndex = base.index.array, bPos = base.attributes.position;
        const chunk = 6000;
        for (let start = 0; start < n; start += chunk) {
            const end = Math.min(n, start + chunk);
            for (let i = start; i < end; i++) {
                p.fromBufferAttribute(pos, i);
                base.boundsTree.closestPointToPoint(p, hit);
                const f = hit.faceIndex * 3;
                a.fromBufferAttribute(bPos, bIndex[f]); b.fromBufferAttribute(bPos, bIndex[f + 1]); c.fromBufferAttribute(bPos, bIndex[f + 2]);
                tri.set(a, b, c).getNormal(normal);
                const sign = p.clone().sub(hit.point).dot(normal) >= 0 ? 1 : -1;
                values[i] = hit.distance * sign;
            }
            onProgress?.(end / n);
            await new Promise(r => setTimeout(r, 0));
        }
        applyColors(geo, values, range, deadband, colors);
        mesh.material.vertexColors = true;
        mesh.material.color.set(0xffffff);
        mesh.material.needsUpdate = true;
        mesh.userData.change = { values, baseFile };
        return values;
    }

    // Reuse change values computed elsewhere (another viewer showing the same file).
    function useChange(slot, values, baseFile, { range = 10, deadband = 1 } = {}) {
        const mesh = meshes.get(slot);
        if (!mesh) return;
        const geo = mesh.geometry.clone();
        mesh.geometry = geo;
        applyColors(geo, values, range, deadband, new Float32Array(values.length * 3));
        mesh.material.vertexColors = true;
        mesh.material.color.set(0xffffff);
        mesh.material.needsUpdate = true;
        mesh.userData.change = { values, baseFile };
    }

    function recolor(slot, range, deadband) {
        const mesh = meshes.get(slot);
        const change = mesh?.userData.change;
        if (!change) return;
        applyColors(mesh.geometry, change.values, range, deadband, new Float32Array(change.values.length * 3));
    }

    function clearColors(slot) {
        const mesh = meshes.get(slot);
        if (!mesh || !mesh.userData.change) return;
        mesh.material.vertexColors = false;
        mesh.material.color.set(SOCKET_GREY);
        mesh.material.needsUpdate = true;
    }

    // Wipe: show `left` on one side of a vertical screen-aligned plane and `right` on the other.
    function setWipe(leftSlot, rightSlot, fraction) {
        const l = meshes.get(leftSlot), r = meshes.get(rightSlot);
        if (!l || !r) return;
        if (fraction === null) {
            l.material.clippingPlanes = r.material.clippingPlanes = null;
            l.material.needsUpdate = r.material.needsUpdate = true;
            return;
        }
        l.userData.wipe = r.userData.wipe = fraction;
        const planeL = new THREE.Plane(), planeR = new THREE.Plane();
        l.material.clippingPlanes = [planeL];
        r.material.clippingPlanes = [planeR];
        l.material.needsUpdate = r.material.needsUpdate = true;
        wipe = { planeL, planeR, fraction };
    }
    let wipe = null;
    function updateWipe() {
        if (!wipe) return;
        // Screen-space vertical line at `fraction`, unprojected onto the target depth.
        const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0).normalize();
        const ndcX = wipe.fraction * 2 - 1;
        const depth = controls.target.clone().project(camera).z;
        const point = new THREE.Vector3(ndcX, 0, depth).unproject(camera);
        const toPoint = point.clone().sub(camera.position);
        const normal = new THREE.Vector3().crossVectors(toPoint, new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1)).normalize();
        if (normal.dot(right) < 0) normal.negate();
        wipe.planeL.setFromNormalAndCoplanarPoint(normal.clone().negate(), point);
        wipe.planeR.setFromNormalAndCoplanarPoint(normal, point);
    }
    function clearWipe(leftSlot, rightSlot) { wipe = null; setWipe(leftSlot, rightSlot, null); }

    // Camera linking: viewers that share a view follow each other.
    let linked = [];
    let echo = false;
    controls.addEventListener('change', () => {
        listeners.forEach(fn => fn());
        if (echo) return;
        linked.forEach(other => other._follow(camera.position, controls.target));
    });
    function _follow(position, target) {
        echo = true;
        camera.position.copy(position);
        controls.target.copy(target);
        controls.update();
        echo = false;
    }
    function link(other) { linked.push(other); other._linkBack(api); }
    function _linkBack(other) { linked.push(other); }

    renderer.setAnimationLoop(now => {
        if (flight) {
            const t = Math.min((now - flight.t0) / flight.ms, 1);
            const k = t * t * (3 - 2 * t);
            camera.position.lerpVectors(flight.p0, flight.p1, k);
            controls.target.lerpVectors(flight.t0v, flight.t1, k);
            controls.update();
            listeners.forEach(fn => fn());
            linked.forEach(other => other._follow(camera.position, controls.target));
            if (t >= 1) flight = null;
        }
        controls.update();
        updateWipe();
        renderer.render(scene, camera);
        placePins(now);
    });

    const api = {
        setModel, setVisible, frame, getView, flyTo, setPins, setPickMode, pickAt, colorByChange, useChange, recolor, clearColors,
        setWipe, clearWipe, link, _follow, _linkBack, onChange: fn => listeners.add(fn),
        get meshes() { return meshes; }, renderer, camera, controls,
        dispose() { sizer.disconnect(); controls.dispose(); renderer.setAnimationLoop(null); renderer.dispose(); renderer.forceContextLoss(); container.replaceChildren(); },
    };
    return api;
}

function applyColors(geo, values, range, deadband, colors) {
    const red = new THREE.Color(0xd8452f), blue = new THREE.Color(0x2f6fd8), c = new THREE.Color();
    for (let i = 0; i < values.length; i++) {
        const v = values[i];
        if (Math.abs(v) <= deadband) c.copy(THRESH_GREY);
        else {
            const t = Math.min((Math.abs(v) - deadband) / Math.max(range - deadband, 0.1), 1);
            c.copy(THRESH_GREY).lerp(v > 0 ? red : blue, 0.25 + 0.75 * t);
        }
        colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

// Change statistics for a coloured mesh: how much moved, where the biggest regions are.
export function changeSummary(geometry, values, deadband = 1) {
    const pos = geometry.attributes.position;
    let out = 0, inn = 0, moved = 0;
    for (const v of values) { if (v > out) out = v; if (v < inn) inn = v; if (Math.abs(v) > deadband) moved++; }
    // Regions come only from substantial changes, so the small scatter of a
    // regenerated lattice does not merge everything into one region.
    const significant = Math.max(deadband, 3, 0.35 * Math.max(out, -inn));
    const cells = new Map();
    const p = new THREE.Vector3();
    for (let i = 0; i < values.length; i++) {
        const v = values[i];
        if (Math.abs(v) <= significant) continue;
        p.fromBufferAttribute(pos, i);
        const k = `${Math.floor(p.x / 25)},${Math.floor(p.y / 25)},${Math.floor(p.z / 25)}`;
        const cell = cells.get(k) || { count: 0, peak: 0, pos: null, sum: new THREE.Vector3() };
        cell.count++;
        cell.sum.add(p);
        if (Math.abs(v) > Math.abs(cell.peak)) { cell.peak = v; cell.pos = p.toArray(); }
        cells.set(k, cell);
    }
    // Merge neighbouring 25 mm cells into regions, then rank them by size.
    const keys = [...cells.keys()];
    const seen = new Set();
    const regions = [];
    for (const k of keys) {
        if (seen.has(k)) continue;
        const stack = [k];
        seen.add(k);
        const region = { count: 0, peak: 0, pos: null, sum: new THREE.Vector3() };
        while (stack.length) {
            const cur = stack.pop();
            const cell = cells.get(cur);
            region.count += cell.count;
            region.sum.add(cell.sum);
            if (Math.abs(cell.peak) > Math.abs(region.peak)) { region.peak = cell.peak; region.pos = cell.pos; }
            const [x, y, z] = cur.split(',').map(Number);
            for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
                const nk = `${x + dx},${y + dy},${z + dz}`;
                if (cells.has(nk) && !seen.has(nk)) { seen.add(nk); stack.push(nk); }
            }
        }
        regions.push({ count: region.count, peak: region.peak, pos: region.pos, centroid: region.sum.divideScalar(region.count).toArray() });
    }
    regions.sort((a, b) => b.count - a.count);
    return { maxOut: out, maxIn: inn, movedPct: 100 * moved / values.length, significant, regions: regions.filter(r => r.count >= 30).slice(0, 4) };
}

export function geometryStats(geometry) {
    const pos = geometry.attributes.position, idx = geometry.index.array;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), cross = new THREE.Vector3();
    let volume = 0, area = 0;
    for (let i = 0; i < idx.length; i += 3) {
        a.fromBufferAttribute(pos, idx[i]); b.fromBufferAttribute(pos, idx[i + 1]); c.fromBufferAttribute(pos, idx[i + 2]);
        volume += a.dot(cross.crossVectors(b, c)) / 6;
        area += cross.crossVectors(b.clone().sub(a), c.clone().sub(a)).length() / 2;
    }
    const size = geometry.boundingBox.getSize(new THREE.Vector3());
    return { volumeCm3: Math.abs(volume) / 1000, areaCm2: area / 100, size: size.toArray() };
}

export async function loadHistory(url = 'iterations/ollie.json') {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error('Could not load ' + url);
    return res.json();
}
