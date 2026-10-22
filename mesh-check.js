// mesh-check.html: pick a file (drop, choose, ?src=<site path>, or the sample), run the repair sweep
// from mesh-repair.js, show what was found and fixed next to a 3D view that highlights each problem,
// and offer the repaired mesh as STL or OBJ.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { el, icon, icons } from './model-convert-ui.js';
import { fileKind, fmtBytes, fmtInt, loadMesh } from './model-convert.js';
import { DEFAULTS, repairMesh, toObj, toStl } from './mesh-repair.js';

const $ = s => document.querySelector(s);
const SAMPLE = 'mesh-check-sample.obj';

// What each check means, for students. `what` explains the problem, `ntop` says what it does to you
// in nTop / printing and what to do if the tool could not fix it.
const CATALOG = {
    numbers: { title: 'Corrupt coordinates', icon: 'hash',
        what: 'A vertex whose position is NaN or infinite, usually from a failed export or a unit conversion that divided by zero.',
        ntop: 'nTop refuses the whole file or places the vertex at the origin, which pulls a spike across the model. The affected triangles are dropped here.' },
    weld: { title: 'Split vertices', icon: 'git-merge',
        what: 'Two triangles that should share a corner store it twice, a hair apart. The surface looks closed but has a pinhole or a crack along the seam. STL always stores corners per triangle, so a little of this is normal; the check only flags corners that are close but not identical.',
        ntop: 'A pinhole makes the mesh "not closed", so Mesh to Implicit and Boolean operations fail, and remeshers produce zero-area triangles there. Merging the pairs closes them.' },
    degenerate: { title: 'Collapsed and duplicate triangles', icon: 'triangle-alert',
        what: 'A triangle whose three corners are not three distinct points has no area; a duplicate is the same triangle listed twice (sometimes once facing each way, from a "double-sided" export).',
        ntop: 'Zero-area triangles break normal calculation and quad remeshing; duplicates create edges shared by four triangles, which is non-manifold. Both are simply removed.' },
    winding: { title: 'Flipped triangles', icon: 'flip-horizontal',
        what: 'Each triangle has a front and a back decided by the order of its corners. A flipped triangle faces the opposite way from its neighbours, so its normal points into the solid while theirs point out.',
        ntop: 'Flipped patches render dark or see-through, confuse "inside / outside" tests and make implicit conversion produce holes or inverted pockets. They are turned round to match their neighbours.' },
    inverted: { title: 'Inside-out shell', icon: 'rotate-3d',
        what: 'The whole closed shell is wound consistently but backwards: every normal points inward. Common after mirroring a part or scaling by a negative number.',
        ntop: 'nTop reads the body as negative volume: Boolean union subtracts it, thickening goes the wrong way, slicers print it hollow. The shell is flipped as a whole.' },
    debris: { title: 'Loose debris', icon: 'sparkles',
        what: 'Tiny separate pieces floating in the file: scanner noise, a leftover from a Boolean, or a fragment of a support structure.',
        ntop: 'Each piece becomes its own body; the slicer prints them as specks and the implicit field has blobs. Pieces much smaller than the model are removed.' },
    nonmanifold: { title: 'Non-manifold edges', icon: 'spline',
        what: 'An edge used by three or more triangles (a fin or an internal wall), or a vertex where two separate fans of triangles touch at one point (a bow tie). The surface no longer divides space into a clear inside and outside.',
        ntop: 'nTop reports "mesh is not manifold"; Remesh, Mesh to Implicit and Boolean operations refuse to run. This cannot be fixed without knowing which surface you meant. In nTop, rebuild the area implicitly (Boolean Union the overlapping bodies before meshing); in Meshmixer or Blender, select non-manifold and delete the fin or separate the shells.' },
    holes: { title: 'Small holes', icon: 'circle-dot',
        what: 'A gap in the surface with a short boundary loop: missing triangles from a scan, a failed stitch, or a seam that did not quite meet.',
        ntop: 'Any hole makes the mesh "not closed", which stops Mesh to Implicit and Boolean operations. Holes much smaller than the model are filled with flat patches; check them in the 3D view.' },
    open: { title: 'Large open edges', icon: 'circle-dashed',
        what: 'A long boundary where the surface simply stops: the open end of a socket, the edge of a scan, or a surface that was never thickened into a solid.',
        ntop: 'Surfaces are fine for nTop as references (point and plane picks, thickening, offsets) but cannot be used as a body. If you meant a solid, go back to the modeller and close or thicken it; nTop\'s Thicken Mesh turns a surface into a printable shell.' },
    slivers: { title: 'Sliver triangles', icon: 'minus',
        what: 'Needle triangles (two corners almost touching) and cap triangles (one corner sitting almost on the opposite edge, so the triangle is a flat line). They come from Boolean operations, STL exports with tight tolerances and decimation.',
        ntop: 'They make remeshing fail, give garbage normals and show as spikes after quad conversion. Needles are collapsed and caps re-split with their neighbour; the surface shape does not change.' },
    intersections: { title: 'Self-intersections', icon: 'git-fork',
        what: 'Triangles that pass through other triangles. Usually two separate shells overlapping (a socket and an attachment exported together without a Boolean union), or a surface that folds through itself after a thickening or a sweep.',
        ntop: 'The most common reason an import "looks fine" but every downstream block fails. Overlapping closed shells are merged here with a Boolean union, the same operation as nTop\'s Boolean Union. A shell folding through itself cannot be repaired automatically: remesh the area with a coarser setting, reduce the thickening distance, or rebuild it as an implicit body.' },
    shells: { title: 'Several shells', icon: 'layers',
        what: 'The file contains more than one separate closed surface. Expected for an assembly exported as one STL; not expected for a single socket.',
        ntop: 'nTop imports them as one mesh; parts that touch or overlap must be unioned before any offset or lattice step. If they are meant to be separate parts, export them as separate files.' },
};
const STATUS = {
    fixed: { label: 'Fixed', icon: 'wrench' },
    ok: { label: 'OK', icon: 'check' },
    warn: { label: 'Note', icon: 'info' },
    fail: { label: 'Needs you', icon: 'alert-triangle' },
    skipped: { label: 'Skipped', icon: 'minus' },
};
const COLORS = { weld: '#f59e0b', degenerate: '#a855f7', winding: '#f97316', inverted: '#ef4444', debris: '#64748b', nonmanifold: '#d946ef', holes: '#16a34a', open: '#dc2626', slivers: '#f59e0b', intersections: '#dc2626' };

let viewer = null;
let toastTimer = 0;
let current = null;   // { source, name, raw, result }
let running = false;

function toast(message, { error = false, ms = 4000 } = {}) {
    const box = $('#mk-toast');
    box.textContent = message;
    box.classList.toggle('error', error);
    box.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { box.hidden = true; }, ms);
}
function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/* ---- viewer -------------------------------------------------------------------------------------- */
function createCheckViewer(container) {
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0xeef2f5, 1);
    container.append(renderer.domElement);
    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100000);
    camera.up.set(0, 0, 1);
    camera.position.set(300, -400, 250);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.12;
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xffffff, 0x94a3b3, 1.1));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4); sun.position.set(1, -0.8, 1.6); scene.add(sun);
    const fill = new THREE.DirectionalLight(0xffffff, 0.5); fill.position.set(-1, 0.6, 0.4); scene.add(fill);
    // Front faces grey, back faces pink: anything pink is a triangle facing the wrong way or a view into an open surface.
    const front = new THREE.MeshStandardMaterial({ color: new THREE.Color(185 / 255, 194 / 255, 204 / 255), roughness: 0.85, metalness: 0, side: THREE.FrontSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
    const back = new THREE.MeshStandardMaterial({ color: new THREE.Color('#e7a0b4'), roughness: 0.9, metalness: 0, side: THREE.BackSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
    const base = new THREE.Group(); scene.add(base);
    const overlays = new THREE.Group(); scene.add(overlays);
    let grid = null, dirty = true, frame = 0, baseGeom = null;
    function render() {
        frame = 0;
        const w = container.clientWidth, h = container.clientHeight;
        if (!w || !h) return;
        if (renderer.domElement.width !== Math.round(w * renderer.getPixelRatio()) || renderer.domElement.height !== Math.round(h * renderer.getPixelRatio())) renderer.setSize(w, h, false);
        renderer.domElement.style.width = `${w}px`; renderer.domElement.style.height = `${h}px`;
        camera.aspect = w / h; camera.updateProjectionMatrix();
        renderer.render(scene, camera);
    }
    function loop() { frame = 0; const moved = controls.update(); if (dirty || moved) { dirty = false; render(); } frame = requestAnimationFrame(loop); }
    const invalidate = () => { dirty = true; if (!frame) frame = requestAnimationFrame(loop); };
    controls.addEventListener('change', invalidate);
    const observer = new ResizeObserver(invalidate); observer.observe(container);
    function geometryOf(mesh) {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(mesh.pos), 3));
        g.setIndex(new THREE.BufferAttribute(mesh.idx.slice(), 1));
        g.computeVertexNormals(); g.computeBoundingBox();
        return g;
    }
    return {
        setBase(mesh) {
            base.clear();
            baseGeom?.dispose();
            baseGeom = geometryOf(mesh);
            base.add(new THREE.Mesh(baseGeom, front), new THREE.Mesh(baseGeom, back));
            if (!grid) {
                const box = baseGeom.boundingBox, size = box.getSize(new THREE.Vector3());
                const span = Math.max(size.x, size.y) * 1.6 || 100;
                grid = new THREE.GridHelper(span, 16, 0xaeb8c4, 0xd8dee5);
                grid.rotation.x = Math.PI / 2;
                grid.position.set((box.min.x + box.max.x) / 2, (box.min.y + box.max.y) / 2, box.min.z);
                scene.add(grid);
            }
            invalidate();
        },
        /** overlays: [{ key, color, faces?: Float32Array, edges?: Float32Array, points?: Float32Array }] */
        setOverlays(list) {
            overlays.children.forEach(o => { o.geometry.dispose(); o.material.dispose(); });
            overlays.clear();
            for (const o of list) {
                const color = new THREE.Color(o.color);
                if (o.faces?.length) {
                    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(o.faces, 3)); g.computeVertexNormals();
                    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, transparent: true, opacity: 0.9, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
                    m.userData.key = o.key; overlays.add(m);
                }
                if (o.edges?.length) {
                    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(o.edges, 3));
                    const m = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, depthTest: false }));
                    m.userData.key = o.key; m.renderOrder = 2; overlays.add(m);
                }
                if (o.points?.length) {
                    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(o.points, 3));
                    const m = new THREE.Points(g, new THREE.PointsMaterial({ color, size: 9, sizeAttenuation: false, depthTest: false }));
                    m.userData.key = o.key; m.renderOrder = 3; overlays.add(m);
                }
            }
            invalidate();
        },
        show(key, visible) { overlays.children.forEach(o => { if (o.userData.key === key) o.visible = visible; }); invalidate(); },
        fit() {
            if (!baseGeom) return;
            const box = baseGeom.boundingBox, size = box.getSize(new THREE.Vector3()), centre = box.getCenter(new THREE.Vector3());
            const radius = Math.max(size.length() / 2, 1e-6);
            const distance = radius / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2)) * 1.15;
            camera.position.copy(centre).addScaledVector(new THREE.Vector3(0.55, -0.8, 0.5).normalize(), distance);
            camera.near = radius / 100; camera.far = radius * 100; camera.updateProjectionMatrix();
            controls.target.copy(centre); controls.update(); invalidate();
        },
        invalidate,
        dispose() {
            cancelAnimationFrame(frame); frame = 0; observer.disconnect(); controls.dispose();
            overlays.children.forEach(o => { o.geometry.dispose(); o.material.dispose(); });
            baseGeom?.dispose(); front.dispose(); back.dispose(); renderer.dispose(); renderer.domElement.remove();
        },
    };
}

/* ---- running --------------------------------------------------------------------------------------- */
function options() {
    return {
        fillHoles: $('#opt-holes').checked,
        removeDebris: $('#opt-debris').checked,
        mergeShells: $('#opt-union').checked,
        checkIntersections: $('#opt-intersect').value !== 'off',
        intersectionBudgetMs: $('#opt-intersect').value === 'off' ? 0 : +$('#opt-intersect').value * 1000,
    };
}

async function start(source, name) {
    if (!fileKind(name)) { toast('Choose an STL, OBJ, 3MF or GLB file.', { error: true }); return; }
    if (running) return;
    $('#mk-drop').hidden = true;
    $('#mk-work').hidden = false;
    $('#mk-work-title').textContent = name;
    current = { source, name, raw: null, result: null };
    window.scrollTo({ top: $('#mk-work').offsetTop - 12, behavior: 'smooth' });
    await run();
}

async function run() {
    if (!current || running) return;
    running = true;
    const report = $('#mk-report');
    const progress = $('#mk-progress'), bar = $('#mk-bar'), msg = $('#mk-msg');
    progress.hidden = false; report.hidden = true; $('#mk-actions').hidden = true;
    $('#mk-rerun').disabled = true;
    const update = (text, frac) => { msg.textContent = text; bar.style.width = `${Math.round(100 * Math.max(0, Math.min(1, frac)))}%`; };
    try {
        if (!current.raw) {
            update('Reading the file', 0.01);
            current.raw = await loadMesh(current.source, current.name);
        }
        const result = await repairMesh(current.raw, options(), update);
        current.result = result;
        progress.hidden = true;
        renderReport(result);
        showInViewer(result);
        report.hidden = false; $('#mk-actions').hidden = false;
        icons();
    } catch (error) {
        console.error(error);
        progress.hidden = true;
        report.hidden = false;
        report.replaceChildren(el('div', { class: 'mk-error' }, icon('alert-triangle'), ` ${error?.message || error}`));
        icons();
    } finally {
        running = false;
        $('#mk-rerun').disabled = false;
    }
}

function fmtSize(b) {
    const s = b.size;
    const f = v => v >= 100 ? v.toFixed(0) : v >= 1 ? v.toFixed(1) : v.toPrecision(3);
    let hint = '';
    if (b.diagonal < 5) hint = ' — tiny numbers: this file is probably in metres';
    else if (b.diagonal > 20000) hint = ' — huge numbers: this file may be in microns';
    return `${f(s[0])} × ${f(s[1])} × ${f(s[2])} in the file’s own units (X × Y × Z)${hint}`;
}

function renderReport(result) {
    const { findings, before, after, mesh } = result;
    const fixed = findings.filter(f => f.status === 'fixed'), fail = findings.filter(f => f.status === 'fail'), warn = findings.filter(f => f.status === 'warn');
    const report = $('#mk-report');
    const verdict = fail.length ? 'needs' : fixed.length ? 'fixed' : 'clean';
    const headline = fail.length
        ? `${fail.length} problem${fail.length === 1 ? '' : 's'} need${fail.length === 1 ? 's' : ''} your attention${fixed.length ? `, ${fixed.length} fixed` : ''}`
        : fixed.length ? `${fixed.length} problem${fixed.length === 1 ? '' : 's'} found and fixed` : 'No problems found';
    const sub = warn.length ? `${warn.length} note${warn.length === 1 ? '' : 's'} worth reading below.` : fail.length ? '' : 'The repaired file below is safe to use in nTop.';
    const summary = el('div', { class: `mk-verdict mk-${verdict}` }, icon(fail.length ? 'alert-triangle' : fixed.length ? 'wrench' : 'check-circle-2'), el('div', {}, el('strong', {}, headline), sub ? el('span', {}, sub) : null));

    const row = (label, a, b, good) => el('tr', {}, el('th', {}, label), el('td', {}, a), el('td', { class: b !== a ? 'mk-changed' : '' }, b), el('td', { class: `mk-tick ${good ? 'good' : 'bad'}` }, good ? '✓' : '!'));
    const table = el('table', { class: 'mk-numbers' },
        el('thead', {}, el('tr', {}, el('th', {}, ''), el('th', {}, 'In your file'), el('th', {}, 'Repaired'), el('th', {}, ''))),
        el('tbody', {},
            row('Triangles', fmtInt(before.faces), fmtInt(after.faces), true),
            row('Vertices', fmtInt(before.vertices), fmtInt(after.vertices), true),
            row('Shells', fmtInt(before.shells), fmtInt(after.shells), after.shells === 1),
            row('Open edges', fmtInt(before.openEdges), fmtInt(after.openEdges), after.openEdges === 0),
            row('Non-manifold edges', fmtInt(before.nonManifoldEdges), fmtInt(after.nonManifoldEdges), after.nonManifoldEdges === 0),
            row('Closed solid', before.closedShells === before.shells && before.shells ? 'yes' : 'no', after.closedShells === after.shells && after.shells ? 'yes' : 'no', after.closedShells === after.shells && after.shells > 0),
        ));
    const facts = el('p', { class: 'mk-facts' }, `${fmtBytes(current.raw.bytes)} ${current.raw.kind.toUpperCase()}, ${fmtSize(before.bounds)}. Checked in ${(result.ms / 1000).toFixed(1)} s.`);

    const list = el('div', { class: 'mk-findings' });
    for (const f of findings) {
        const cat = CATALOG[f.key] || { title: f.key, icon: 'circle' };
        const st = STATUS[f.status] || STATUS.warn;
        const hasHighlight = f.highlight && (f.highlight.faces?.length || f.highlight.edges?.length || f.highlight.points?.length);
        const toggle = hasHighlight ? el('label', { class: 'mk-show', onclick: e => e.stopPropagation() },
            el('input', { type: 'checkbox', checked: true, onchange: e => viewer?.show(f.key, e.target.checked) }),
            el('span', { class: 'mk-swatch', style: `background:${COLORS[f.key] || '#999'}` }), 'Show in 3D') : null;
        const details = el('details', { class: `mk-finding mk-${f.status}`, open: f.status !== 'ok' && f.status !== 'skipped' },
            el('summary', {},
                el('span', { class: 'mk-status' }, icon(st.icon), st.label),
                el('span', { class: 'mk-title' }, cat.title),
                f.count ? el('span', { class: 'mk-count' }, fmtInt(f.count)) : null),
            // Outside the summary: a checkbox inside a <summary> is a control inside a control.
            toggle ? el('div', { class: 'mk-showrow' }, toggle) : null,
            el('p', { class: 'mk-summary' }, f.summary),
            cat.what ? el('p', { class: 'mk-what' }, el('strong', {}, 'What it is. '), cat.what) : null,
            cat.ntop ? el('p', { class: 'mk-ntop' }, el('strong', {}, 'Why it matters. '), cat.ntop) : null);
        list.append(details);
    }
    report.replaceChildren(summary, facts, table, list);

    const stem = current.name.replace(/\.[^.]+$/, '');
    $('#mk-stl').onclick = () => download(new Blob([toStl(mesh, `Give a Paw mesh check: ${stem}`)], { type: 'model/stl' }), `${stem}-repaired.stl`);
    $('#mk-obj').onclick = () => download(new Blob([toObj(mesh, stem)], { type: 'text/plain' }), `${stem}-repaired.obj`);
    $('#mk-copy').onclick = async () => {
        const lines = [`Mesh check: ${current.name}`, `${fmtInt(before.faces)} -> ${fmtInt(after.faces)} triangles, ${fmtInt(before.shells)} -> ${fmtInt(after.shells)} shells, ${fmtInt(before.openEdges)} -> ${fmtInt(after.openEdges)} open edges, ${fmtInt(before.nonManifoldEdges)} -> ${fmtInt(after.nonManifoldEdges)} non-manifold edges`, ''];
        for (const f of findings) lines.push(`[${(STATUS[f.status] || STATUS.warn).label}] ${(CATALOG[f.key] || {}).title || f.key}: ${f.summary}`);
        try { await navigator.clipboard.writeText(lines.join('\n')); toast('Report copied.'); } catch { toast('Could not copy; select the text instead.', { error: true }); }
    };
    $('#mk-stl').textContent = '';
    $('#mk-stl').append(icon('download'), ` Download repaired STL (${fmtBytes(84 + mesh.idx.length / 3 * 50)})`);
}

function showInViewer(result) {
    if (!viewer) viewer = createCheckViewer($('#mk-stage'));
    const which = $('#mk-view-after').classList.contains('active') ? 'after' : 'before';
    viewer.setBase(which === 'after' ? result.mesh : result.original);
    viewer.setOverlays(result.findings.filter(f => f.highlight).map(f => ({ key: f.key, color: COLORS[f.key] || '#999', ...f.highlight })));
    viewer.fit();
}

function restart() {
    current = null;
    $('#mk-work').hidden = true;
    $('#mk-drop').hidden = false;
    $('#mk-file').value = '';
    history.replaceState(null, '', location.pathname);
}

/* ---- wiring ------------------------------------------------------------------------------------- */
const drop = $('#mk-drop');
const fileInput = $('#mk-file');
$('#mk-choose').addEventListener('click', event => { event.stopPropagation(); fileInput.click(); });
drop.addEventListener('click', () => fileInput.click());
drop.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); fileInput.click(); } });
fileInput.addEventListener('change', () => { const file = fileInput.files?.[0]; if (file) start(file, file.name); });
$('#mk-sample').addEventListener('click', event => { event.stopPropagation(); start(SAMPLE, SAMPLE); });
$('#mk-restart').addEventListener('click', restart);
$('#mk-rerun').addEventListener('click', run);
for (const id of ['#mk-view-before', '#mk-view-after']) {
    $(id).addEventListener('click', () => {
        $('#mk-view-before').classList.toggle('active', id === '#mk-view-before');
        $('#mk-view-after').classList.toggle('active', id === '#mk-view-after');
        if (current?.result && viewer) viewer.setBase(id === '#mk-view-after' ? current.result.mesh : current.result.original);
    });
}
for (const target of [drop, document.body]) {
    target.addEventListener('dragover', event => { if (event.dataTransfer?.types?.includes('Files')) { event.preventDefault(); drop.classList.add('over'); } });
    target.addEventListener('dragleave', () => drop.classList.remove('over'));
    target.addEventListener('drop', event => {
        if (!event.dataTransfer?.files?.length) return;
        event.preventDefault();
        drop.classList.remove('over');
        const file = event.dataTransfer.files[0];
        start(file, file.name);
    });
}
// ?src=<same-origin path> opens a file from the site (testing, or linking straight to a model).
const src = new URLSearchParams(location.search).get('src');
if (src && !/^[a-z]+:|^\/\//i.test(src) && fileKind(src)) start(src, src.split('/').pop());
icons();
export { DEFAULTS };
