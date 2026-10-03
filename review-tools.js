// Extra 3D tools for the design review page (design-review.js).
//
//   createPaintTool  - paint an attachment surface onto the animal, Meshmixer style: brush to add or
//                      erase, smooth the edge, grow or shrink it, export it as STL for nTop.
//   createLegTool    - mechanical interface on the socket, a pipe of adjustable length, and the paw on
//                      the end, with the gap to the floor.
//
// Both receive a small context object from the model viewer instead of reaching into it.

import * as THREE from 'three';

const icon = name => `<i data-lucide="${String(name).replace(/[^a-z0-9-]/g, '')}" aria-hidden="true"></i>`;
function el(tag, className, html) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (html !== undefined) node.innerHTML = html;
    return node;
}
const fmtArea = mm2 => mm2 >= 1000 ? `${(mm2 / 100).toFixed(0)} cm²` : `${mm2.toFixed(0)} mm²`;

// ---- run-length encoding of a face mask ----------------------------------------------------------
// "start.length" pairs in base 36, so a painted region costs a few hundred bytes in a share link.
export function encodeMask(mask) {
    const runs = [];
    let i = 0;
    while (i < mask.length) {
        if (!mask[i]) { i++; continue; }
        const start = i;
        while (i < mask.length && mask[i]) i++;
        runs.push(start.toString(36) + '.' + (i - start).toString(36));
    }
    return runs.join(',');
}
export function decodeMask(text, length) {
    const mask = new Uint8Array(length);
    if (!text) return mask;
    text.split(',').forEach(run => {
        const [a, b] = run.split('.');
        const start = parseInt(a, 36);
        const count = parseInt(b, 36);
        if (Number.isFinite(start) && Number.isFinite(count)) mask.fill(1, start, Math.min(length, start + count));
    });
    return mask;
}

// ---- mesh topology helpers -------------------------------------------------------------------------

// World-space triangle data for one mesh, with vertices welded by position so seams do not split
// neighbourhoods.
function buildTopology(mesh) {
    mesh.updateWorldMatrix(true, false);
    const geometry = mesh.geometry;
    const pos = geometry.attributes.position;
    const index = geometry.index ? geometry.index.array : null;
    const faceCount = index ? index.length / 3 : pos.count / 3;
    const vertexOf = (f, k) => index ? index[f * 3 + k] : f * 3 + k;
    const world = new Float32Array(pos.count * 3);
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
        world[i * 3] = v.x; world[i * 3 + 1] = v.y; world[i * 3 + 2] = v.z;
    }
    // Weld.
    const weldOf = new Int32Array(pos.count);
    const keys = new Map();
    let welded = 0;
    for (let i = 0; i < pos.count; i++) {
        const key = `${Math.round(world[i * 3] * 1000)},${Math.round(world[i * 3 + 1] * 1000)},${Math.round(world[i * 3 + 2] * 1000)}`;
        let id = keys.get(key);
        if (id === undefined) { id = welded++; keys.set(key, id); }
        weldOf[i] = id;
    }
    const centroid = new Float32Array(faceCount * 3);
    const normal = new Float32Array(faceCount * 3);
    const area = new Float32Array(faceCount);
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
    const faceWeld = new Int32Array(faceCount * 3);
    for (let f = 0; f < faceCount; f++) {
        const ia = vertexOf(f, 0), ib = vertexOf(f, 1), ic = vertexOf(f, 2);
        a.fromArray(world, ia * 3); b.fromArray(world, ib * 3); c.fromArray(world, ic * 3);
        centroid[f * 3] = (a.x + b.x + c.x) / 3;
        centroid[f * 3 + 1] = (a.y + b.y + c.y) / 3;
        centroid[f * 3 + 2] = (a.z + b.z + c.z) / 3;
        n.subVectors(c, b).cross(a.clone().sub(b));
        const len = n.length();
        area[f] = len / 2;
        if (len > 0) n.divideScalar(len);
        normal[f * 3] = -n.x; normal[f * 3 + 1] = -n.y; normal[f * 3 + 2] = -n.z;
        faceWeld[f * 3] = weldOf[ia]; faceWeld[f * 3 + 1] = weldOf[ib]; faceWeld[f * 3 + 2] = weldOf[ic];
    }
    // Welded vertex -> faces (CSR).
    const counts = new Int32Array(welded + 1);
    for (let i = 0; i < faceWeld.length; i++) counts[faceWeld[i] + 1]++;
    for (let i = 0; i < welded; i++) counts[i + 1] += counts[i];
    const fill = counts.slice(0, welded);
    const vertFaces = new Int32Array(faceWeld.length);
    for (let f = 0; f < faceCount; f++) for (let k = 0; k < 3; k++) vertFaces[fill[faceWeld[f * 3 + k]]++] = f;
    // Spatial hash of centroids.
    const cell = 6;
    const grid = new Map();
    for (let f = 0; f < faceCount; f++) {
        const key = `${Math.floor(centroid[f * 3] / cell)},${Math.floor(centroid[f * 3 + 1] / cell)},${Math.floor(centroid[f * 3 + 2] / cell)}`;
        let list = grid.get(key);
        if (!list) grid.set(key, list = []);
        list.push(f);
    }
    let edgeSum = 0;
    for (let f = 0; f < Math.min(faceCount, 5000); f++) edgeSum += Math.sqrt(area[f] * 2.3);
    return { mesh, world, weldOf, faceWeld, faceCount, vertexOf, centroid, normal, area, vertStart: counts, vertFaces, grid, cell, meanEdge: edgeSum / Math.min(faceCount, 5000) };
}
function facesNear(topo, point, radius, visit) {
    const { cell, grid, centroid } = topo;
    const r2 = radius * radius;
    const x0 = Math.floor((point.x - radius) / cell), x1 = Math.floor((point.x + radius) / cell);
    const y0 = Math.floor((point.y - radius) / cell), y1 = Math.floor((point.y + radius) / cell);
    const z0 = Math.floor((point.z - radius) / cell), z1 = Math.floor((point.z + radius) / cell);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) {
        const list = grid.get(`${x},${y},${z}`);
        if (!list) continue;
        for (const f of list) {
            const dx = centroid[f * 3] - point.x, dy = centroid[f * 3 + 1] - point.y, dz = centroid[f * 3 + 2] - point.z;
            if (dx * dx + dy * dy + dz * dz <= r2) visit(f);
        }
    }
}
function forNeighbours(topo, f, visit) {
    const { faceWeld, vertStart, vertFaces } = topo;
    for (let k = 0; k < 3; k++) {
        const w = faceWeld[f * 3 + k];
        for (let i = vertStart[w]; i < vertStart[w + 1]; i++) if (vertFaces[i] !== f) visit(vertFaces[i]);
    }
}
function closestOnTriangle(p, a, b, c, out) {
    // Ericson, Real-Time Collision Detection 5.1.5.
    const ab = b.clone().sub(a), ac = c.clone().sub(a), ap = p.clone().sub(a);
    const d1 = ab.dot(ap), d2 = ac.dot(ap);
    if (d1 <= 0 && d2 <= 0) return out.copy(a);
    const bp = p.clone().sub(b);
    const d3 = ab.dot(bp), d4 = ac.dot(bp);
    if (d3 >= 0 && d4 <= d3) return out.copy(b);
    const vc = d1 * d4 - d3 * d2;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) return out.copy(a).addScaledVector(ab, d1 / (d1 - d3));
    const cp = p.clone().sub(c);
    const d5 = ab.dot(cp), d6 = ac.dot(cp);
    if (d6 >= 0 && d5 <= d6) return out.copy(c);
    const vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0) return out.copy(a).addScaledVector(ac, d2 / (d2 - d6));
    const va = d3 * d6 - d5 * d4;
    if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) return out.copy(b).addScaledVector(c.clone().sub(b), (d4 - d3) / ((d4 - d3) + (d5 - d6)));
    const denom = 1 / (va + vb + vc);
    return out.copy(a).addScaledVector(ab, vb * denom).addScaledVector(ac, vc * denom);
}

// ---- step-by-step tool guides ------------------------------------------------------------------------
// A small card that walks through a tool one step at a time, like the camera tutorial: each step ticks
// itself off ("You did it") when the person actually does it, then moves on. Opens by itself the first
// time a tool is used in this browser, from a "?" button, or for everyone from the presenter's Live panel.
export function createGuide({ host, key, title, steps }) {
    const seenKey = 'gap-guide-seen:' + key;
    const card = el('aside', 'rv-guide');
    card.hidden = true;
    card.setAttribute('aria-label', title);
    host.append(card);
    const done = new Set();
    let index = 0;
    let advanceTimer = 0;
    const seen = () => { try { return localStorage.getItem(seenKey) === '1'; } catch { return false; } };
    const markSeen = () => { try { localStorage.setItem(seenKey, '1'); } catch { /* storage off */ } };
    function render() {
        const step = steps[index];
        const ok = done.has(step.key);
        card.innerHTML = `
            <div class="rv-guide-head">${icon(step.icon || 'sparkles')}<strong>${title}</strong><span>${index + 1} / ${steps.length}</span><button type="button" class="rv-guide-x" data-guide="close" title="Close the guide">${icon('x')}</button></div>
            <h5>${step.title}</h5>
            <p>${step.text}</p>
            ${ok ? `<p class="rv-guide-ok">${icon('circle-check')} You did it</p>` : step.try ? `<p class="rv-guide-try">${icon('mouse-pointer-click')} ${step.try}</p>` : ''}
            <div class="rv-guide-foot">
                <div class="rv-guide-dots">${steps.map((s, i) => `<button type="button" data-guide-step="${i}" class="${i === index ? 'current' : ''}${done.has(s.key) ? ' done' : ''}" aria-label="${s.title}"></button>`).join('')}</div>
                ${index > 0 ? '<button type="button" class="rv-btn rv-mini" data-guide="back">Back</button>' : ''}
                <button type="button" class="rv-btn rv-mini rv-primary" data-guide="next">${index === steps.length - 1 ? 'Got it' : ok ? 'Next' : 'Skip'}</button>
            </div>`;
        card.classList.toggle('is-done', ok);
        window.lucide?.createIcons({ attrs: { 'stroke-width': 1.8 } });
    }
    card.addEventListener('click', event => {
        const step = event.target.closest('[data-guide-step]');
        if (step) { show(+step.dataset.guideStep); return; }
        const action = event.target.closest('[data-guide]')?.dataset.guide;
        if (action === 'close') close();
        else if (action === 'back') show(index - 1);
        else if (action === 'next') { if (index === steps.length - 1) close(); else show(index + 1); }
    });
    // Clicks on the card must not paint, orbit or draw underneath it.
    card.addEventListener('pointerdown', event => event.stopPropagation());
    function show(i) {
        clearTimeout(advanceTimer);
        index = Math.max(0, Math.min(steps.length - 1, i));
        render();
    }
    function open({ force = false } = {}) {
        if (!force && seen()) return false;
        done.clear();
        card.hidden = false;
        show(0);
        return true;
    }
    function close() {
        clearTimeout(advanceTimer);
        card.hidden = true;
        markSeen();
    }
    return {
        open,
        close,
        isOpen: () => !card.hidden,
        // Called by the tool when the person does a step; on the step being shown it moves on by itself.
        done(stepKey) {
            if (done.has(stepKey)) return;
            done.add(stepKey);
            if (card.hidden) return;
            render();
            if (steps[index].key === stepKey && index < steps.length - 1) advanceTimer = setTimeout(() => show(index + 1), 1500);
        },
    };
}

// ---- paint tool --------------------------------------------------------------------------------------

export function createPaintTool(ctx, cfg) {
    const { stage, scene, camera, canvas, controls, materials, sectionPlanes, store, itemId, toast, emitChange, emitNav, refreshIcons, download, findLayerMesh, loadMesh } = ctx;
    const color = cfg.color || '#169c8c';
    const panel = el('div', 'rv-paint');
    panel.innerHTML = `
        <div class="rv-paint-row">
            <button type="button" data-paint="add" title="Paint to add to the attachment surface">${icon('paintbrush')} Paint</button>
            <button type="button" data-paint="erase" title="Paint to remove from the attachment surface">${icon('eraser')} Erase</button>
            <label class="rv-paint-size" title="Brush size">${icon('circle-dashed')}<input type="range" min="2" max="40" step="1" value="${cfg.brush || 10}"><output>${cfg.brush || 10} mm</output></label>
        </div>
        <div class="rv-paint-row">
            <button type="button" data-op="smooth" title="Smooth the edge of the surface">${icon('waves')} Smooth edge</button>
            <button type="button" data-op="grow" title="Make the surface larger all round">${icon('maximize-2')} Grow</button>
            <button type="button" data-op="shrink" title="Make the surface smaller all round">${icon('minimize-2')} Shrink</button>
            <button type="button" data-op="reset" title="Go back to the original surface">${icon('rotate-ccw')}</button>
            <button type="button" data-op="stl" title="Download this surface as an STL for nTop">${icon('download')} STL</button>
            <button type="button" data-op="guide" title="How to paint the surface">${icon('circle-help')}</button>
        </div>
        <p class="rv-paint-readout">Loading surface…</p>`;
    stage.append(panel);
    const sizeInput = panel.querySelector('input[type="range"]');
    const sizeOut = panel.querySelector('output');
    const readout = panel.querySelector('.rv-paint-readout');
    const guide = createGuide({
        host: stage, key: 'paint', title: 'Painting the surface',
        steps: [
            { key: 'paint', icon: 'paintbrush', title: 'Paint to add', text: 'Press <b>Paint</b>, then hold the left mouse button and drag over the body. Teal is the attachment surface.', try: 'Paint a stroke on the body' },
            { key: 'turn', icon: 'rotate-3d', title: 'Turn the model while painting', text: 'With a brush on, left-drag always paints. <b>Right-drag</b> (or <kbd>Alt</kbd> + drag) turns the view; scroll to zoom.', try: 'Right-drag to turn the model' },
            { key: 'erase', icon: 'eraser', title: 'Erase', text: 'Press <b>Erase</b> and drag to remove surface. The slider next to it sets the brush size.', try: 'Erase a little' },
            { key: 'tidy', icon: 'waves', title: 'Tidy the edge', text: '<b>Smooth edge</b> cleans a ragged border. <b>Grow</b> and <b>Shrink</b> move the whole edge out or in. The dashed orange line is where the surface started; ↺ goes back to it.', try: 'Press Smooth edge, Grow or Shrink' },
            { key: 'stl', icon: 'download', title: 'Keep the result', text: 'Your surface is saved with your notes and, in a live session, everyone sees it as you paint. <b>STL</b> downloads it for nTop.' },
        ],
    });

    let topo = null;
    let mask = null;
    let original = null;
    let originalArea = 0;
    let encoded = '';
    let brushMode = null;
    let painting = false;
    let locked = false;
    let overlay = null;
    let edgeLines = null;
    let originalLines = null;
    const material = new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, clippingPlanes: sectionPlanes() });
    materials.add(material);
    const edgeMaterial = new THREE.LineBasicMaterial({ color: 0x0b4f47, clippingPlanes: sectionPlanes() });
    const originalMaterial = new THREE.LineDashedMaterial({ color: 0xd99a00, dashSize: 3, gapSize: 2, clippingPlanes: sectionPlanes() });
    materials.add(edgeMaterial);
    materials.add(originalMaterial);
    const cursor = new THREE.Mesh(new THREE.RingGeometry(0.92, 1, 48), new THREE.MeshBasicMaterial({ color: 0x0b4f47, side: THREE.DoubleSide, depthTest: false, transparent: true, opacity: 0.9 }));
    cursor.renderOrder = 10;
    cursor.visible = false;
    scene.add(cursor);

    async function init() {
        const mesh = findLayerMesh(cfg.layer || 'animal');
        if (!mesh) { readout.textContent = 'No animal mesh to paint on.'; return; }
        topo = buildTopology(mesh);
        original = new Uint8Array(topo.faceCount);
        if (cfg.surface) {
            try { markFromSurface(await loadMesh(cfg.surface), original, cfg.tolerance ?? 3); } catch (error) { console.error(error); }
            for (let i = 0; i < 2; i++) majority(original);
        }
        originalArea = areaOf(original);
        const saved = store.item(itemId).surface;
        mask = saved ? decodeMask(saved, topo.faceCount) : original.slice();
        encoded = encodeMask(mask);
        overlay = new THREE.Mesh(new THREE.BufferGeometry(), material);
        overlay.geometry.setAttribute('position', new THREE.BufferAttribute(topo.world, 3));
        overlay.renderOrder = 2;
        edgeLines = new THREE.LineSegments(new THREE.BufferGeometry(), edgeMaterial);
        originalLines = new THREE.LineSegments(boundaryGeometry(original), originalMaterial);
        originalLines.computeLineDistances();
        scene.add(overlay, edgeLines, originalLines);
        rebuild();
    }
    function markFromSurface(object, target, tolerance) {
        const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), p = new THREE.Vector3(), q = new THREE.Vector3();
        object.updateWorldMatrix(true, true);
        object.traverse(child => {
            if (!child.isMesh) return;
            const pos = child.geometry.attributes.position;
            const idx = child.geometry.index ? child.geometry.index.array : null;
            const triCount = idx ? idx.length / 3 : pos.count / 3;
            for (let t = 0; t < triCount; t++) {
                const vi = k => idx ? idx[t * 3 + k] : t * 3 + k;
                a.fromBufferAttribute(pos, vi(0)).applyMatrix4(child.matrixWorld);
                b.fromBufferAttribute(pos, vi(1)).applyMatrix4(child.matrixWorld);
                c.fromBufferAttribute(pos, vi(2)).applyMatrix4(child.matrixWorld);
                const centre = a.clone().add(b).add(c).divideScalar(3);
                const reach = Math.max(centre.distanceTo(a), centre.distanceTo(b), centre.distanceTo(c)) + tolerance;
                facesNear(topo, centre, reach, f => {
                    if (target[f]) return;
                    p.fromArray(topo.centroid, f * 3);
                    if (closestOnTriangle(p, a, b, c, q).distanceTo(p) <= tolerance) target[f] = 1;
                });
            }
        });
    }
    function areaOf(m) { let s = 0; for (let f = 0; f < m.length; f++) if (m[f]) s += topo.area[f]; return s; }
    function majority(m) {
        const next = m.slice();
        for (let f = 0; f < topo.faceCount; f++) {
            let on = 0, all = 0;
            forNeighbours(topo, f, g => { all++; if (m[g]) on++; });
            if (all) next[f] = on * 2 > all ? 1 : on * 2 < all ? 0 : m[f];
        }
        m.set(next);
    }
    function dropSmallPieces(m, minFaces) {
        // Removes islands of paint and fills holes smaller than minFaces.
        for (const value of [1, 0]) {
            const seen = new Uint8Array(m.length);
            for (let f = 0; f < m.length; f++) {
                if (seen[f] || m[f] !== value) continue;
                const piece = [f];
                seen[f] = 1;
                for (let i = 0; i < piece.length && piece.length <= minFaces; i++) forNeighbours(topo, piece[i], g => { if (!seen[g] && m[g] === value) { seen[g] = 1; piece.push(g); } });
                if (piece.length < minFaces && (value === 1 || touchesSelection(m, piece))) piece.forEach(g => { m[g] = value ? 0 : 1; });
            }
        }
    }
    function touchesSelection(m, piece) { return piece.some(f => { let hit = false; forNeighbours(topo, f, g => { if (m[g]) hit = true; }); return hit; }); }
    function ring(m, grow) {
        const next = m.slice();
        for (let f = 0; f < topo.faceCount; f++) {
            if (grow && !m[f]) { forNeighbours(topo, f, g => { if (m[g]) next[f] = 1; }); }
            if (!grow && m[f]) { forNeighbours(topo, f, g => { if (!m[g]) next[f] = 0; }); }
        }
        m.set(next);
    }
    function boundaryGeometry(m) {
        const { faceWeld, faceCount, world, vertexOf } = topo;
        const edges = new Map();
        for (let f = 0; f < faceCount; f++) {
            if (!m[f]) continue;
            for (let k = 0; k < 3; k++) {
                const wa = faceWeld[f * 3 + k], wb = faceWeld[f * 3 + (k + 1) % 3];
                const key = wa < wb ? wa * 4194304 + wb : wb * 4194304 + wa;
                const hit = edges.get(key);
                if (hit) hit.n++;
                else edges.set(key, { n: 1, a: vertexOf(f, k), b: vertexOf(f, (k + 1) % 3) });
            }
        }
        const out = [];
        edges.forEach(e => { if (e.n === 1) out.push(world[e.a * 3], world[e.a * 3 + 1], world[e.a * 3 + 2], world[e.b * 3], world[e.b * 3 + 1], world[e.b * 3 + 2]); });
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(out, 3));
        return geometry;
    }
    let rebuildQueued = false;
    function rebuild() {
        if (!topo) return;
        const indices = [];
        for (let f = 0; f < topo.faceCount; f++) if (mask[f]) indices.push(topo.vertexOf(f, 0), topo.vertexOf(f, 1), topo.vertexOf(f, 2));
        overlay.geometry.setIndex(indices);
        overlay.geometry.computeVertexNormals();
        edgeLines.geometry.dispose();
        edgeLines.geometry = boundaryGeometry(mask);
        const area = areaOf(mask);
        const change = originalArea ? (area / originalArea - 1) * 100 : 0;
        readout.innerHTML = `<strong>${fmtArea(area)}</strong> ${originalArea ? `<span class="${change >= 0 ? 'up' : 'down'}">${change >= 0 ? '+' : ''}${change.toFixed(0)}% vs original</span>` : ''}<span class="rv-paint-legend"><i></i>original edge</span>`;
    }
    function queueRebuild() {
        if (rebuildQueued) return;
        rebuildQueued = true;
        requestAnimationFrame(() => { rebuildQueued = false; rebuild(); });
    }
    function commit(message) {
        encoded = encodeMask(mask);
        store.update(itemId, entry => { entry.surface = encoded; entry.surfaceArea = Math.round(areaOf(mask)); entry.surfaceOriginalArea = Math.round(originalArea); });
        emitChange('surface');
        if (message) toast(message);
    }

    // Brush ---------------------------------------------------------------------------------------
    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    function hitAt(event) {
        if (!topo) return null;
        const rect = canvas.getBoundingClientRect();
        ndc.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
        raycaster.setFromCamera(ndc, camera);
        const planes = sectionPlanes() || [];
        const hits = raycaster.intersectObject(topo.mesh, false).filter(h => planes.every(pl => pl.distanceToPoint(h.point) >= -1e-6));
        if (!hits.length) return null;
        const hit = hits[0];
        const raw = hit.face ? hit.face.normal.clone().transformDirection(topo.mesh.matrixWorld) : new THREE.Vector3(0, 0, 1);
        // `normal` faces the camera (for the brush ring); `raw` keeps the mesh's own winding, which is what
        // the per-face normals are compared with. Ollie's scan is wound inward, so comparing the
        // camera-facing normal rejected every face and the brush painted nothing.
        const n = raw.dot(raycaster.ray.direction) > 0 ? raw.clone().negate() : raw;
        return { point: hit.point, normal: n, raw };
    }
    function stamp(hit) {
        const radius = +sizeInput.value;
        const value = brushMode === 'add' ? 1 : 0;
        const nx = hit.raw.x, ny = hit.raw.y, nz = hit.raw.z;
        facesNear(topo, hit.point, radius, f => {
            // Only the side of the body under the brush, not the far side of a thin part.
            if (topo.normal[f * 3] * nx + topo.normal[f * 3 + 1] * ny + topo.normal[f * 3 + 2] * nz > -0.2) mask[f] = value;
        });
        queueRebuild();
    }
    function placeCursor(hit) {
        if (!hit) { cursor.visible = false; return; }
        cursor.visible = true;
        cursor.position.copy(hit.point).addScaledVector(hit.normal, 0.3);
        cursor.lookAt(hit.point.clone().add(hit.normal));
        cursor.scale.setScalar(+sizeInput.value);
        cursor.material.color.set(brushMode === 'erase' ? 0xb3261e : 0x0b4f47);
    }
    canvas.addEventListener('pointerdown', event => {
        if (brushMode && !locked && (event.button === 2 || (event.button === 0 && event.altKey))) guide.done('turn');
        if (!brushMode || locked || event.button !== 0 || event.shiftKey || event.altKey) return;
        // With a brush on, a left-drag always paints (starting off the body no longer spins the view);
        // right-drag or Alt+drag turns it.
        event.preventDefault();
        event.stopImmediatePropagation();
        painting = true;
        controls.enabled = false;
        try { canvas.setPointerCapture(event.pointerId); } catch { /* synthetic */ }
        emitNav();
        const hit = hitAt(event);
        if (hit) stamp(hit);
    }, { capture: true });
    canvas.addEventListener('pointermove', event => {
        if (!brushMode) return;
        const hit = hitAt(event);
        placeCursor(hit);
        if (painting && hit) { stamp(hit); stroked = true; }
    });
    let stroked = false;
    const endStroke = () => {
        if (!painting) return;
        painting = false;
        controls.enabled = !locked;
        commit();
        if (brushMode) guide.done(brushMode === 'add' ? 'paint' : 'erase');
        stroked = false;
    };
    canvas.addEventListener('pointerup', endStroke);
    canvas.addEventListener('pointercancel', endStroke);
    canvas.addEventListener('pointerleave', () => { cursor.visible = false; });

    function setBrush(next) {
        brushMode = brushMode === next ? null : next;
        panel.querySelectorAll('[data-paint]').forEach(b => b.classList.toggle('active', b.dataset.paint === brushMode));
        stage.classList.toggle('mode-paint', !!brushMode);
        if (!brushMode) cursor.visible = false;
    }
    panel.querySelectorAll('[data-paint]').forEach(button => button.addEventListener('click', () => { emitNav(); setBrush(button.dataset.paint); if (brushMode) guide.open(); }));
    panel.querySelector('[data-op="guide"]').addEventListener('click', () => guide.open({ force: true }));
    sizeInput.addEventListener('input', () => { sizeOut.textContent = `${sizeInput.value} mm`; });
    panel.querySelector('[data-op="smooth"]').addEventListener('click', () => {
        if (!topo) return;
        emitNav();
        for (let i = 0; i < 3; i++) majority(mask);
        dropSmallPieces(mask, 40);
        rebuild();
        commit('Edge smoothed');
        guide.done('tidy');
    });
    panel.querySelector('[data-op="grow"]').addEventListener('click', () => { if (!topo) return; emitNav(); ring(mask, true); rebuild(); commit(`Grown by about ${topo.meanEdge.toFixed(1)} mm`); guide.done('tidy'); });
    panel.querySelector('[data-op="shrink"]').addEventListener('click', () => { if (!topo) return; emitNav(); ring(mask, false); rebuild(); commit(`Shrunk by about ${topo.meanEdge.toFixed(1)} mm`); guide.done('tidy'); });
    panel.querySelector('[data-op="reset"]').addEventListener('click', () => {
        if (!topo || !confirm('Go back to the original attachment surface? Your painting on this surface will be lost.')) return;
        emitNav();
        mask.set(original);
        rebuild();
        commit('Back to the original surface');
    });
    panel.querySelector('[data-op="stl"]').addEventListener('click', () => {
        if (!topo) return;
        const faces = [];
        for (let f = 0; f < topo.faceCount; f++) if (mask[f]) faces.push(f);
        const buffer = new ArrayBuffer(84 + faces.length * 50);
        const view = new DataView(buffer);
        view.setUint32(80, faces.length, true);
        faces.forEach((f, i) => {
            const o = 84 + i * 50;
            for (let k = 0; k < 3; k++) view.setFloat32(o + k * 4, topo.normal[f * 3 + k], true);
            for (let v = 0; v < 3; v++) {
                const vi = topo.vertexOf(f, v);
                for (let k = 0; k < 3; k++) view.setFloat32(o + 12 + v * 12 + k * 4, topo.world[vi * 3 + k], true);
            }
        });
        download(`${cfg.fileName || 'proposed-attachment-surface'}.stl`, new Blob([buffer], { type: 'model/stl' }));
        toast('Surface saved as STL (millimetres, scan frame)');
        guide.done('stl');
    });
    refreshIcons();

    return {
        init,
        getState() { return topo ? { surface: encoded } : {}; },
        applyState(state) {
            if (!topo || state?.surface === undefined || state.surface === encoded) return;
            mask = decodeMask(state.surface, topo.faceCount);
            encoded = state.surface;
            rebuild();
        },
        setLocked(value) { locked = !!value; if (locked) setBrush(null); panel.classList.toggle('is-locked', locked); },
        showGuide() { return guide.open({ force: true }); },
        summary() { return topo ? { area: areaOf(mask), original: originalArea } : null; },
    };
}

// ---- leg tool ------------------------------------------------------------------------------------------

export function createLegTool(ctx, cfg) {
    const { scene, modelRoot, root, materials, sectionPlanes, store, itemId, emitChange, emitNav, refreshIcons, loadMesh, makeMaterial, animalBounds } = ctx;
    const mount = cfg.mount;
    const down = new THREE.Vector3().fromArray(mount.down).normalize();
    const zAxis = down.clone().negate();
    const xAxis = new THREE.Vector3().fromArray(mount.side || [1, 0, 0]);
    xAxis.addScaledVector(zAxis, -xAxis.dot(zAxis)).normalize();
    const yAxis = new THREE.Vector3().crossVectors(zAxis, xAxis);
    const basis = new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis).setPosition(new THREE.Vector3().fromArray(mount.origin));
    const rig = new THREE.Group();
    rig.matrixAutoUpdate = false;
    rig.matrix.copy(basis);
    (modelRoot || scene).add(rig);

    const pipe = cfg.pipe || {};
    const radius = (pipe.od || 15.875) / 2;
    const interfaceBottom = cfg.interface?.bottom ?? -61;

    // Interface placement ("place": { "contact": 0, "adjust": 50 }), after the walkthrough's step 3 (Interface
    // Position, Lateral / Medial Angle, Interface Rotation, Interface X / Y / Z Adjust). The mechanical interface,
    // pipe and paw move together. "contact" is the height in the interface's own file that sits on the
    // Interface Position. Angles start from the fitted direction ("mount"), so 0 / 0 / 0 is how it was at the
    // fitting: Lateral Angle tilts it about the mount's Y axis (the leg leans along X), Medial Angle tilts it
    // about the mount's X axis (the leg leans along Y), Interface Rotation spins it about its own axis. (A turn
    // about the fitted pipe axis, as the walkthrough's medial angle does, only duplicated the rotation here.)
    // Adjust moves it in world X / Y / Z (mm), as in the walkthrough.
    const placeCfg = cfg.place || null;
    const contactZ = placeCfg?.contact ?? 0;
    const adjustMax = placeCfg?.adjust ?? 50;
    const fittedPoint = new THREE.Vector3().fromArray(mount.origin).addScaledVector(zAxis, contactZ - interfaceBottom);
    const pose = { point: fittedPoint.clone(), lateral: 0, medial: 0, rotation: 0, adjust: [0, 0, 0] };
    function loadPose(p) {
        if (!p) return;
        if (Array.isArray(p.point) && p.point.length === 3 && p.point.every(Number.isFinite)) pose.point.fromArray(p.point);
        const pick = (...values) => values.find(Number.isFinite);
        pose.lateral = pick(p.lateral, p.side, pose.lateral);
        pose.medial = pick(p.medial, pose.medial);
        pose.rotation = pick(p.rotation, p.twist, pose.rotation);
        if (Array.isArray(p.adjust) && p.adjust.length === 3 && p.adjust.every(Number.isFinite)) pose.adjust = p.adjust.slice();
    }
    if (placeCfg) loadPose(store.item(itemId).iface);
    const poseAxis = new THREE.Vector3();
    const fittedQuaternion = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis));
    function poseMatrix() {
        const deg = THREE.MathUtils.degToRad;
        const q = new THREE.Quaternion().setFromAxisAngle(xAxis, deg(pose.medial))
            .multiply(new THREE.Quaternion().setFromAxisAngle(yAxis, deg(pose.lateral)))
            .multiply(fittedQuaternion)
            .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), deg(pose.rotation)));
        poseAxis.set(0, 0, 1).applyQuaternion(q);
        const position = pose.point.clone().add(new THREE.Vector3().fromArray(pose.adjust)).addScaledVector(poseAxis, -contactZ);
        return new THREE.Matrix4().compose(position, q, new THREE.Vector3(1, 1, 1));
    }
    if (placeCfg) rig.matrix.copy(poseMatrix());
    else poseAxis.copy(zAxis);
    const insertTop = pipe.insertInterface ?? 40;
    let pawTop = cfg.paw?.top ?? 53;
    let pawDepth = cfg.paw?.socketDepth ?? 21;
    let pawFile = cfg.paw?.file || null;   // can be swapped for another paw (setPaw)
    let pawToken = 0;
    const lengthCfg = { min: 30, max: 300, step: 1, value: 120, ...(cfg.length || {}) };
    const saved = store.item(itemId).pipe;
    let length = Number.isFinite(saved) ? saved : lengthCfg.value;
    // Paw rotation about the pipe axis, in degrees (the paw's toes may need turning to face forward).
    const savedYaw = store.item(itemId).pawYaw;
    let yaw = Number.isFinite(savedYaw) ? savedYaw : (cfg.paw?.yaw ?? 0);

    const pipeMaterial = new THREE.MeshStandardMaterial({ color: 0x8f9aa5, roughness: 0.35, metalness: 0.6, clippingPlanes: sectionPlanes() });
    materials.add(pipeMaterial);
    const pipeMesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, 1, 40, 1, false), pipeMaterial);
    pipeMesh.rotation.x = Math.PI / 2;      // cylinder axis Y -> rig Z
    pipeMesh.userData.pickable = true;
    rig.add(pipeMesh);
    const interfaceGroup = new THREE.Group();
    const pawGroup = new THREE.Group();
    pawGroup.rotation.z = THREE.MathUtils.degToRad(yaw);
    rig.add(interfaceGroup, pawGroup);
    const pawHolder = new THREE.Group();
    pawGroup.add(pawHolder);

    // The floor: a soft disc at the lowest point of the scan.
    const floorMaterial = new THREE.MeshBasicMaterial({ color: 0x1d8a6a, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false });
    const floor = new THREE.Mesh(new THREE.CircleGeometry(1, 64), floorMaterial);
    scene.add(floor);

    const bar = el('div', 'rv-leg');
    let panel = null, panelOpen = null;
    if (placeCfg) {
        const row = (key, label, min, max, unit, title, value) => `
            <label class="rv-iface-row" data-pose="${key}" title="${title}"><span>${label}</span>
                <input type="range" min="${min}" max="${max}" step="1" value="${value}">
                <input type="number" step="any" value="${value}"><small>${unit}</small></label>`;
        panel = el('aside', 'rv-iface-panel');
        panel.innerHTML = `
            <div class="rv-iface-title">${icon('axis-3d')}<strong>Interface Position</strong><span>World Frame</span>
                <button type="button" class="rv-iface-hide" title="Hide this panel" aria-label="Hide the interface panel">${icon('panel-left-close')}</button></div>
            <div class="rv-iface-pos">
                ${['X', 'Y', 'Z'].map((axis, i) => `<label><span>${axis}</span><input type="number" step="any" data-pos="${i}" aria-label="Interface position ${axis}"><small>mm</small></label>`).join('')}
            </div>
            <div class="rv-iface-actions">
                <button type="button" data-place-click title="Then click the body where the interface should go">${icon('crosshair')} Place on the body</button>
                <button type="button" data-place-reset title="Back to where it was on the fitted socket">${icon('rotate-ccw')} Fitted</button>
            </div>
            <div class="rv-iface-sub">${icon('rotate-3d')}<strong>Orient the interface</strong><span>Interface Cap</span></div>
            <div class="rv-iface-rows">
                ${row('lateral', 'Lateral Angle', -180, 180, 'deg', 'Tilts the interface about the Y axis (the leg leans along X)', pose.lateral)}
                ${row('medial', 'Medial Angle', -180, 180, 'deg', 'Tilts the interface about the X axis (the leg leans along Y)', pose.medial)}
                ${row('rotation', 'Interface Rotation', -180, 180, 'deg', 'Spins the interface about its own axis', pose.rotation)}
                ${['X', 'Y', 'Z'].map((axis, i) => row('adjust' + i, `Interface ${axis} Adjust`, -adjustMax, adjustMax, 'mm', `Moves the interface along world ${axis}`, pose.adjust[i])).join('')}
            </div>`;
        const opener = el('button', 'rv-iface-open');
        opener.type = 'button';
        opener.title = 'Show the interface panel';
        opener.innerHTML = `${icon('axis-3d')}<span>Interface</span>`;
        (ctx.stage || root).append(panel, opener);
        const KEY = 'gap-review-iface-panel';
        const remembered = (() => { try { return localStorage.getItem(KEY); } catch { return null; } })();
        panelOpen = open => {
            panel.hidden = !open;
            opener.hidden = open;
            try { localStorage.setItem(KEY, open ? 'open' : 'closed'); } catch { /* private window */ }
        };
        panelOpen(remembered ? remembered === 'open' : !matchMedia('(max-width: 640px)').matches);
        panel.rvSetOpen = panelOpen;
        panel.rvHome = ctx.stage || root;
        panel.rvOpener = opener;
        panel.querySelector('.rv-iface-hide').addEventListener('click', () => panelOpen(false));
        opener.addEventListener('click', () => panelOpen(true));
        // Sit under the part chips (they can wrap to two rows).
        const chips = ctx.stage?.querySelector('.rv-layers');
        const fitTop = () => { const top = chips && !chips.hidden ? chips.offsetTop + chips.offsetHeight + 8 : 12; panel.style.top = opener.style.top = `${Math.max(12, top)}px`; };
        if (chips) new ResizeObserver(fitTop).observe(chips);
        fitTop();
    }
    bar.innerHTML = `
        <label class="rv-leg-length"><span>Pipe length</span>
            <input type="range" min="${lengthCfg.min}" max="${lengthCfg.max}" step="${lengthCfg.step}" value="${length}">
            <input type="number" min="${lengthCfg.min}" max="${lengthCfg.max}" step="${lengthCfg.step}" value="${length}"> <small>mm</small></label>
        <button type="button" class="rv-btn" data-fit-floor title="Pick the length that puts the paw on the floor">${icon('arrow-down-to-line')} Touch the floor</button>
        <label class="rv-leg-length rv-leg-yaw"><span>Paw rotation</span>
            <input type="range" min="-180" max="180" step="1" value="${yaw}">
            <input type="number" min="-180" max="180" step="1" value="${yaw}"> <small>°</small></label>
        <button type="button" class="rv-btn rv-icon-btn" data-leg-guide title="How to set the leg">${icon('circle-help')}</button>
        <p class="rv-leg-readout"></p>`;
    root.append(bar);
    const guide = createGuide({
        host: ctx.stage, key: 'leg', title: 'Setting the leg',
        steps: [
            { key: 'length', icon: 'ruler', title: 'Pipe length', text: 'Drag <b>Pipe length</b> (or type a number). The pipe slides 40 mm into the socket and the paw moves with it.', try: 'Change the pipe length' },
            { key: 'floor', icon: 'arrow-down-to-line', title: 'Find the floor', text: 'The green disc is the floor under his scan. <b>Touch the floor</b> picks the length that puts the paw on it; the line under the bar says how far off it is.', try: 'Press Touch the floor' },
            { key: 'rotate', icon: 'rotate-cw', title: 'Turn the paw', text: '<b>Paw rotation</b> turns the paw around the pipe so the toes face forward.', try: 'Change the paw rotation' },
            ...(placeCfg ? [
                { key: 'place', icon: 'crosshair', title: 'Interface Position', text: 'In the panel on the left, press <b>Place on the body</b> and click the body (or type X, Y, Z): the mechanical interface, pipe and paw move there. <b>Fitted</b> puts it back where it was on the fitted socket.', try: 'Place the interface somewhere else' },
                { key: 'angle', icon: 'rotate-3d', title: 'Orient the interface', text: '<b>Lateral Angle</b>, <b>Medial Angle</b> and <b>Interface Rotation</b> turn it (0 = the fitted direction); <b>Interface X / Y / Z Adjust</b> nudge it. The panel hides with the button at its top right.', try: 'Change the lateral angle' },
            ] : []),
        ],
    });
    bar.querySelector('[data-leg-guide]').addEventListener('click', () => guide.open({ force: true }));
    const range = bar.querySelector('.rv-leg-length:not(.rv-leg-yaw) input[type="range"]');
    const number = bar.querySelector('.rv-leg-length:not(.rv-leg-yaw) input[type="number"]');
    const yawRange = bar.querySelector('.rv-leg-yaw input[type="range"]');
    const yawNumber = bar.querySelector('.rv-leg-yaw input[type="number"]');
    const readout = bar.querySelector('.rv-leg-readout');
    let floorZ = cfg.floor ?? null;
    let pawLoaded = false;
    let locked = false;

    function place() {
        if (placeCfg) {
            rig.matrix.copy(poseMatrix());
            posInputs.forEach((input, i) => { if (document.activeElement !== input) input.value = pose.point.getComponent(i).toFixed(2); });
            poseInputs.forEach(({ key, range: r, number: n }) => { const v = poseValue(key); r.value = v; if (document.activeElement !== n) n.value = v; });
            placeBtn?.classList.toggle('is-on', placing);
        }
        const top = interfaceBottom + insertTop;      // top end of the pipe, inside the interface bore
        const bottom = top - length;                  // bottom end, inside the paw bore
        pipeMesh.scale.set(1, length, 1);
        pipeMesh.position.set(0, 0, (top + bottom) / 2);
        pawGroup.position.set(0, 0, bottom + pawDepth - pawTop);
        rig.updateMatrixWorld(true);
        updateReadout();
    }
    function pawLowestZ() {
        if (!pawLoaded) return null;
        const box = new THREE.Box3().setFromObject(pawGroup);
        return box.isEmpty() ? null : box.min.z;
    }
    function updateReadout() {
        const low = pawLowestZ();
        const exposed = Math.max(0, length - insertTop - pawDepth);
        let gapText = '';
        if (low !== null && floorZ !== null) {
            const gap = low - floorZ;
            gapText = Math.abs(gap) < 1 ? '<strong class="ok">Paw is on the floor</strong>'
                : gap > 0 ? `<strong class="up">Paw is ${gap.toFixed(0)} mm above the floor</strong>`
                    : `<strong class="down">Paw is ${(-gap).toFixed(0)} mm below the floor</strong>`;
        }
        readout.innerHTML = `${gapText}<span>${exposed.toFixed(0)} mm of pipe showing · ${insertTop} mm in the interface · ${pawDepth} mm in the paw</span>`;
    }
    function setLength(value, fromUser) {
        length = Math.min(lengthCfg.max, Math.max(lengthCfg.min, Math.round(+value)));
        range.value = length;
        if (document.activeElement !== number) number.value = length;
        place();
        if (fromUser) {
            emitNav();
            store.update(itemId, entry => { entry.pipe = length; const low = pawLowestZ(); entry.pipeFloorGap = low !== null && floorZ !== null ? Math.round(low - floorZ) : null; });
            emitChange('leg');
            guide.done('length');
        }
    }
    function setYaw(value, fromUser) {
        yaw = Math.max(-180, Math.min(180, Math.round(+value || 0)));
        yawRange.value = yaw;
        if (document.activeElement !== yawNumber) yawNumber.value = yaw;
        pawGroup.rotation.z = THREE.MathUtils.degToRad(yaw);
        place();
        if (fromUser) {
            emitNav();
            store.update(itemId, entry => { entry.pawYaw = yaw; });
            emitChange('leg');
            guide.done('rotate');
        }
    }
    yawRange.addEventListener('input', () => setYaw(yawRange.value, true));
    yawNumber.addEventListener('change', () => setYaw(yawNumber.value, true));
    range.addEventListener('input', () => setLength(range.value, true));
    number.addEventListener('change', () => setLength(number.value, true));
    bar.querySelector('[data-fit-floor]').addEventListener('click', () => {
        const low = pawLowestZ();
        if (low === null || floorZ === null) return;
        // The paw moves along the pipe axis; its height changes by down.z per millimetre of pipe.
        const perMm = -poseAxis.z;
        if (Math.abs(perMm) < 0.2) return;
        setLength(length + (low - floorZ) / -perMm, true);
        guide.done('floor');
    });

    // ---- interface placement controls ----
    const posInputs = panel ? [...panel.querySelectorAll('[data-pos]')] : [];
    const placeBtn = panel?.querySelector('[data-place-click]');
    let placing = false;
    const poseValue = key => key.startsWith('adjust') ? pose.adjust[+key.slice(6)] : pose[key];
    const poseInputs = panel ? [...panel.querySelectorAll('[data-pose]')].map(label => ({ key: label.dataset.pose, range: label.querySelector('input[type="range"]'), number: label.querySelector('input[type="number"]') })) : [];
    function savePose(guideKey) {
        emitNav();
        store.update(itemId, entry => { entry.iface = { point: pose.point.toArray().map(v => +v.toFixed(2)), lateral: pose.lateral, medial: pose.medial, rotation: pose.rotation, adjust: pose.adjust.slice() }; const low = pawLowestZ(); entry.pipeFloorGap = low !== null && floorZ !== null ? Math.round(low - floorZ) : null; });
        emitChange('leg');
        if (guideKey) guide.done(guideKey);
    }
    poseInputs.forEach(({ key, range: r, number: n }) => {
        const limit = key.startsWith('adjust') ? adjustMax : 180;
        const set = value => {
            const v = Math.max(-limit, Math.min(limit, Math.round((+value || 0) * 10) / 10));
            if (key.startsWith('adjust')) pose.adjust[+key.slice(6)] = v; else pose[key] = v;
            place();
            savePose('angle');
        };
        r.addEventListener('input', () => set(r.value));
        n.addEventListener('change', () => set(n.value));
    });
    posInputs.forEach((input, i) => input.addEventListener('change', () => {
        if (!Number.isFinite(+input.value) || input.value === '') { place(); return; }
        pose.point.setComponent(i, +input.value);
        place();
        savePose('place');
    }));
    function setPlacing(on) {
        placing = !!on && !locked;
        placeBtn?.classList.toggle('is-on', placing);
        if (ctx.canvas) ctx.canvas.style.cursor = placing ? 'crosshair' : '';
        if (placing) ctx.toast?.('Click the body where the interface should go', 2200);
    }
    placeBtn?.addEventListener('click', () => setPlacing(!placing));
    panel?.querySelector('[data-place-reset]').addEventListener('click', () => {
        pose.point.copy(fittedPoint);
        pose.lateral = pose.medial = pose.rotation = 0;
        pose.adjust = [0, 0, 0];
        setPlacing(false);
        place();
        savePose();
    });
    if (placeCfg && ctx.canvas && ctx.camera) {
        // Click (not drag) on the body while placing: the contact point moves to the clicked spot. Runs in the
        // capture phase so the click does not also select a layer chip.
        const caster = new THREE.Raycaster();
        let press = null;
        ctx.canvas.addEventListener('pointerdown', event => { press = placing && event.button === 0 ? { x: event.clientX, y: event.clientY } : null; }, true);
        ctx.canvas.addEventListener('pointerup', event => {
            if (!placing || !press) return;
            const moved = Math.hypot(event.clientX - press.x, event.clientY - press.y);
            press = null;
            if (moved > 5) return;
            event.stopImmediatePropagation();
            const rect = ctx.canvas.getBoundingClientRect();
            caster.setFromCamera(new THREE.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1), ctx.camera);
            const inRig = o => { for (let p = o; p; p = p.parent) if (p === rig) return true; return false; };
            const targets = (ctx.pickMeshes?.() || []).filter(m => !inRig(m));
            const cut = ctx.sectionCut?.();
            const hit = caster.intersectObjects(targets, false).find(h => !cut || cut.distanceToPoint(h.point) >= -1e-6);
            if (!hit) { ctx.toast?.('Click on the body itself', 1600); return; }
            pose.point.copy(hit.point);
            pose.adjust = [0, 0, 0];
            setPlacing(false);
            place();
            savePose('place');
        }, true);
    }

    async function init() {
        const tasks = [];
        if (cfg.interface?.file) tasks.push(loadMesh(cfg.interface.file).then(object => { object.traverse(o => { if (o.isMesh) { if (!o.geometry.getAttribute('normal')) { if (o.geometry.index) o.geometry = o.geometry.toNonIndexed(); o.geometry.computeVertexNormals(); } o.material = makeMaterial(cfg.interface.color || '#5d6b78', 1); o.userData.pickable = true; materials.add(o.material); } });
            if (cfg.interface.flip) {
                // Half turn about the lateral (rig Y) axis, then back into the same bounding box.
                const box = new THREE.Box3().setFromObject(object);
                object.rotation.y = Math.PI;
                object.position.set(box.min.x + box.max.x, 0, box.min.z + box.max.z);
            }
            interfaceGroup.add(object); }));
        if (cfg.paw?.file) tasks.push(loadMesh(cfg.paw.file).then(object => { if (pawFile !== cfg.paw.file) return; object.traverse(o => { if (o.isMesh) { o.material = makeMaterial(cfg.paw.color || '#c9a76b', 1); o.userData.pickable = true; materials.add(o.material); } }); pawHolder.add(object); pawLoaded = true; }));
        await Promise.all(tasks);
        if (floorZ === null) floorZ = animalBounds()?.min.z ?? 0;
        const bounds = animalBounds();
        const size = bounds ? Math.max(bounds.max.x - bounds.min.x, bounds.max.y - bounds.min.y) : 400;
        floor.scale.setScalar(size * 0.7);
        floor.position.set(bounds ? (bounds.min.x + bounds.max.x) / 2 : 0, bounds ? (bounds.min.y + bounds.max.y) / 2 : 0, floorZ - 0.2);
        place();
    }
    place();
    refreshIcons();
    return {
        init,
        objects: [rig],
        getState() { return { pipe: length, pawYaw: yaw, ...(placeCfg ? { iface: { point: pose.point.toArray(), lateral: pose.lateral, medial: pose.medial, rotation: pose.rotation, adjust: pose.adjust.slice() } } : {}) }; },
        applyState(state) {
            if (Number.isFinite(state?.pipe) && state.pipe !== length) setLength(state.pipe, false);
            if (Number.isFinite(state?.pawYaw) && state.pawYaw !== yaw) setYaw(state.pawYaw, false);
            if (placeCfg && state?.iface) { loadPose(state.iface); place(); }
        },
        setLocked(value) { locked = !!value; if (locked) setPlacing(false); bar.classList.toggle('is-locked', locked); panel?.classList.toggle('is-locked', locked); },
        showGuide() { return guide.open({ force: true }); },
        // Mount another paw: { file, top, socketDepth } (top = height of the paw's top in its own file,
        // socketDepth = how far the pipe goes into it; 0 for a paw with a flat top).
        async setPaw(spec) {
            if (!spec?.file) return;
            const fitChanged = (Number.isFinite(spec.top) && spec.top !== pawTop) || (Number.isFinite(spec.socketDepth) && spec.socketDepth !== pawDepth);
            if (spec.file === pawFile && !fitChanged) return;
            if (Number.isFinite(spec.top)) pawTop = spec.top;
            if (Number.isFinite(spec.socketDepth)) pawDepth = spec.socketDepth;
            if (spec.file === pawFile) { place(); return; }
            pawFile = spec.file;
            const token = ++pawToken;
            const object = await loadMesh(spec.file);
            if (token !== pawToken) return;
            pawHolder.children.slice().forEach(child => {
                pawHolder.remove(child);
                child.traverse(o => { if (o.isMesh) { o.geometry.dispose(); materials.delete(o.material); o.material.dispose(); } });
            });
            object.traverse(o => { if (o.isMesh) { o.material = makeMaterial(cfg.paw?.color || '#c9a76b', 1); o.userData.pickable = true; materials.add(o.material); } });
            pawHolder.add(object);
            pawLoaded = true;
            place();
        },
    };
}
