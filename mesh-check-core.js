// Shared parts of the mesh check page and its redesign prototypes (mesh-check-a/b/c.html):
// the plain-English text for each check, the 3D viewer that highlights problems, and report helpers.
// The repair engine itself is mesh-repair.js.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { el } from './model-convert-ui.js';
import { fmtBytes, fmtInt } from './model-convert.js';
import { toObj, toStl } from './mesh-repair.js';

// What each check means, for students. `short` is one line; `what` explains the problem, `ntop` says what
// it does to you in nTop / printing and what to do if the tool could not fix it.
export const CATALOG = {
    numbers: { title: 'Corrupt coordinates', icon: 'hash', short: 'Points with impossible positions (NaN or infinite).',
        what: 'A vertex whose position is NaN or infinite, usually from a failed export or a unit conversion that divided by zero.',
        ntop: 'nTop refuses the whole file or places the vertex at the origin, which pulls a spike across the model. The affected triangles are dropped here.' },
    weld: { title: 'Split vertices', icon: 'git-merge', short: 'Corners stored twice a hair apart, leaving pinholes.',
        what: 'Two triangles that should share a corner store it twice, a hair apart. The surface looks closed but has a pinhole or a crack along the seam. STL always stores corners per triangle, so a little of this is normal; the check only flags corners that are close but not identical.',
        ntop: 'A pinhole makes the mesh "not closed", so Mesh to Implicit and Boolean operations fail, and remeshers produce zero-area triangles there. Merging the pairs closes them.' },
    degenerate: { title: 'Collapsed and duplicate triangles', icon: 'triangle-alert', short: 'Triangles with no area, or listed twice.',
        what: 'A triangle whose three corners are not three distinct points has no area; a duplicate is the same triangle listed twice (sometimes once facing each way, from a "double-sided" export).',
        ntop: 'Zero-area triangles break normal calculation and quad remeshing; duplicates create edges shared by four triangles, which is non-manifold. Both are simply removed.' },
    winding: { title: 'Flipped triangles', icon: 'flip-horizontal', short: 'Triangles facing the opposite way from their neighbours.',
        what: 'Each triangle has a front and a back decided by the order of its corners. A flipped triangle faces the opposite way from its neighbours, so its normal points into the solid while theirs point out.',
        ntop: 'Flipped patches render dark or see-through, confuse "inside / outside" tests and make implicit conversion produce holes or inverted pockets. They are turned round to match their neighbours.' },
    inverted: { title: 'Inside-out shell', icon: 'rotate-3d', short: 'A whole shell whose normals all point inward.',
        what: 'The whole closed shell is wound consistently but backwards: every normal points inward. Common after mirroring a part or scaling by a negative number.',
        ntop: 'nTop reads the body as negative volume: Boolean union subtracts it, thickening goes the wrong way, slicers print it hollow. The shell is flipped as a whole.' },
    debris: { title: 'Loose debris', icon: 'sparkles', short: 'Tiny separate pieces floating in the file.',
        what: 'Tiny separate pieces floating in the file: scanner noise, a leftover from a Boolean, or a fragment of a support structure.',
        ntop: 'Each piece becomes its own body; the slicer prints them as specks and the implicit field has blobs. Pieces much smaller than the model are removed.' },
    nonmanifold: { title: 'Non-manifold edges', icon: 'spline', short: 'Edges shared by three or more triangles (fins, internal walls).',
        what: 'An edge used by three or more triangles (a fin or an internal wall), or a vertex where two separate fans of triangles touch at one point (a bow tie). The surface no longer divides space into a clear inside and outside.',
        ntop: 'nTop reports "mesh is not manifold"; Remesh, Mesh to Implicit and Boolean operations refuse to run. This cannot be fixed without knowing which surface you meant. In nTop, rebuild the area implicitly (Boolean Union the overlapping bodies before meshing); in Meshmixer or Blender, select non-manifold and delete the fin or separate the shells.' },
    holes: { title: 'Small holes', icon: 'circle-dot', short: 'Small gaps in the surface.',
        what: 'A gap in the surface with a short boundary loop: missing triangles from a scan, a failed stitch, or a seam that did not quite meet.',
        ntop: 'Any hole makes the mesh "not closed", which stops Mesh to Implicit and Boolean operations. Holes much smaller than the model are filled with flat patches; check them in the 3D view.' },
    open: { title: 'Large open edges', icon: 'circle-dashed', short: 'Long boundaries where the surface simply stops.',
        what: 'A long boundary where the surface simply stops: the open end of a socket, the edge of a scan, or a surface that was never thickened into a solid.',
        ntop: 'Surfaces are fine for nTop as references (point and plane picks, thickening, offsets) but cannot be used as a body. If you meant a solid, go back to the modeller and close or thicken it; nTop\'s Thicken Mesh turns a surface into a printable shell.' },
    slivers: { title: 'Sliver triangles', icon: 'minus', short: 'Needle-thin triangles that break remeshing.',
        what: 'Needle triangles (two corners almost touching) and cap triangles (one corner sitting almost on the opposite edge, so the triangle is a flat line). They come from Boolean operations, STL exports with tight tolerances and decimation.',
        ntop: 'They make remeshing fail, give garbage normals and show as spikes after quad conversion. Needles are collapsed and caps re-split with their neighbour; the surface shape does not change.' },
    intersections: { title: 'Self-intersections', icon: 'git-fork', short: 'Triangles passing through other triangles.',
        what: 'Triangles that pass through other triangles. Usually two separate shells overlapping (a socket and an attachment exported together without a Boolean union), or a surface that folds through itself after a thickening or a sweep.',
        ntop: 'The most common reason an import "looks fine" but every downstream block fails. Overlapping closed shells are merged here with a Boolean union, the same operation as nTop\'s Boolean Union. A shell folding through itself cannot be repaired automatically: remesh the area with a coarser setting, reduce the thickening distance, or rebuild it as an implicit body.' },
    shells: { title: 'Several shells', icon: 'layers', short: 'More than one separate body in the file.',
        what: 'The file contains more than one separate closed surface. Expected for an assembly exported as one STL; not expected for a single socket.',
        ntop: 'nTop imports them as one mesh; parts that touch or overlap must be unioned before any offset or lattice step. If they are meant to be separate parts, export them as separate files.' },
};
export const STATUS = {
    fixed: { label: 'Fixed', icon: 'wrench' },
    ok: { label: 'OK', icon: 'check' },
    warn: { label: 'Note', icon: 'info' },
    fail: { label: 'Needs you', icon: 'alert-triangle' },
    skipped: { label: 'Skipped', icon: 'minus' },
};
export const COLORS = { weld: '#f59e0b', degenerate: '#a855f7', winding: '#f97316', inverted: '#ef4444', debris: '#64748b', nonmanifold: '#d946ef', holes: '#16a34a', open: '#dc2626', slivers: '#f59e0b', intersections: '#dc2626' };
// The order problems are listed in: what needs you first, then notes, then what was fixed.
const RANK = { fail: 0, warn: 1, fixed: 2, ok: 3, skipped: 4 };

export const hasHighlight = f => !!(f.highlight && (f.highlight.faces?.length || f.highlight.edges?.length || f.highlight.points?.length));

/** Everything a page needs to write the result in a few words. */
export function summarize(result) {
    const { findings, before, after } = result;
    const by = s => findings.filter(f => f.status === s);
    const fail = by('fail'), fixed = by('fixed'), warn = by('warn');
    const passed = findings.filter(f => f.status === 'ok' || f.status === 'skipped');
    const issues = findings.filter(f => f.status === 'fail' || f.status === 'fixed' || f.status === 'warn').sort((a, b) => RANK[a.status] - RANK[b.status]);
    const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
    const verdict = fail.length ? 'needs' : fixed.length ? 'fixed' : 'clean';
    const headline = fail.length ? `${plural(fail.length, 'problem')} need${fail.length === 1 ? 's' : ''} you`
        : fixed.length ? `Repaired: ${plural(fixed.length, 'problem')} fixed` : 'No problems found';
    const sub = fail.length ? `The tool fixed ${fixed.length ? plural(fixed.length, 'other problem') : 'what it could'}; the rest needs a change in your modeller.`
        : warn.length ? `${plural(warn.length, 'note')} worth reading before you use it.` : 'The file is ready to use in nTop.';
    const closed = after.closedShells === after.shells && after.shells > 0;
    const stats = [
        { label: 'Triangles', before: fmtInt(before.faces), after: fmtInt(after.faces), good: true },
        { label: 'Open edges', before: fmtInt(before.openEdges), after: fmtInt(after.openEdges), good: after.openEdges === 0 },
        { label: 'Non-manifold edges', before: fmtInt(before.nonManifoldEdges), after: fmtInt(after.nonManifoldEdges), good: after.nonManifoldEdges === 0 },
        { label: 'Shells', before: fmtInt(before.shells), after: fmtInt(after.shells), good: after.shells === 1 },
        { label: 'Closed solid', before: before.closedShells === before.shells && before.shells ? 'yes' : 'no', after: closed ? 'yes' : 'no', good: closed },
    ];
    return { verdict, headline, sub, fail, fixed, warn, passed, issues, stats, closed };
}

export function fmtSize(b) {
    const s = b.size;
    const f = v => v >= 100 ? v.toFixed(0) : v >= 1 ? v.toFixed(1) : v.toPrecision(3);
    let hint = '';
    if (b.diagonal < 5) hint = ' (tiny numbers: probably metres)';
    else if (b.diagonal > 20000) hint = ' (huge numbers: maybe microns)';
    return `${f(s[0])} × ${f(s[1])} × ${f(s[2])}${hint}`;
}

export function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
}
export const stlBytes = mesh => 84 + mesh.idx.length / 3 * 50;
export function saveStl(mesh, name) { const stem = name.replace(/\.[^.]+$/, ''); download(new Blob([toStl(mesh, `Give a Paw mesh check: ${stem}`)], { type: 'model/stl' }), `${stem}-repaired.stl`); }
export function saveObj(mesh, name) { const stem = name.replace(/\.[^.]+$/, ''); download(new Blob([toObj(mesh, stem)], { type: 'text/plain' }), `${stem}-repaired.obj`); }
export function reportText(name, result) {
    const { findings, before, after } = result;
    const lines = [`Mesh check: ${name}`, `${fmtInt(before.faces)} -> ${fmtInt(after.faces)} triangles, ${fmtInt(before.shells)} -> ${fmtInt(after.shells)} shells, ${fmtInt(before.openEdges)} -> ${fmtInt(after.openEdges)} open edges, ${fmtInt(before.nonManifoldEdges)} -> ${fmtInt(after.nonManifoldEdges)} non-manifold edges`, ''];
    for (const f of findings) lines.push(`[${(STATUS[f.status] || STATUS.warn).label}] ${(CATALOG[f.key] || {}).title || f.key}: ${f.summary}`);
    return lines.join('\n');
}
export const fileFacts = (raw, result) => `${fmtBytes(raw.bytes)} ${raw.kind.toUpperCase()} · ${fmtSize(result.before.bounds)} · checked in ${(result.ms / 1000).toFixed(1)} s`;

/* ---- viewer -------------------------------------------------------------------------------------- */
/** A three.js view of the mesh (front faces grey, back faces pink) with coloured overlays per finding.
 *  focus(key) flies to one finding and shows only it; showAll() brings the others back. */
export function createCheckViewer(container, { background = 0xeef2f5 } = {}) {
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(background, 1);
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
    const front = new THREE.MeshStandardMaterial({ color: new THREE.Color(185 / 255, 194 / 255, 204 / 255), roughness: 0.85, metalness: 0, side: THREE.FrontSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
    const back = new THREE.MeshStandardMaterial({ color: new THREE.Color('#e7a0b4'), roughness: 0.9, metalness: 0, side: THREE.BackSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
    const base = new THREE.Group(); scene.add(base);
    const overlays = new THREE.Group(); scene.add(overlays);
    let grid = null, dirty = true, frame = 0, baseGeom = null, flight = null;
    const hidden = new Set();
    let only = null;
    function render() {
        frame = 0;
        const w = container.clientWidth, h = container.clientHeight;
        if (!w || !h) return;
        if (renderer.domElement.width !== Math.round(w * renderer.getPixelRatio()) || renderer.domElement.height !== Math.round(h * renderer.getPixelRatio())) renderer.setSize(w, h, false);
        renderer.domElement.style.width = `${w}px`; renderer.domElement.style.height = `${h}px`;
        camera.aspect = w / h; camera.updateProjectionMatrix();
        renderer.render(scene, camera);
    }
    function loop(now) {
        frame = 0;
        if (flight) {
            const t = Math.min(1, (now - flight.t0) / flight.ms), k = t * t * (3 - 2 * t);
            camera.position.lerpVectors(flight.p0, flight.p1, k);
            controls.target.lerpVectors(flight.c0, flight.c1, k);
            if (t >= 1) flight = null;
            dirty = true;
        }
        const moved = controls.update();
        if (dirty || moved) { dirty = false; render(); }
        if (flight || moved) frame = requestAnimationFrame(loop);
    }
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
    function applyVisibility() { overlays.children.forEach(o => { o.visible = only ? o.userData.key === only : !hidden.has(o.userData.key); }); invalidate(); }
    function flyToBox(box, scale = 1.15) {
        const size = box.getSize(new THREE.Vector3()), centre = box.getCenter(new THREE.Vector3());
        const model = baseGeom.boundingBox.getSize(new THREE.Vector3()).length() / 2;
        const radius = Math.max(size.length() / 2, model * 0.12, 1e-6);
        const distance = radius / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2)) * scale;
        const dir = camera.position.clone().sub(controls.target).normalize();
        flight = { t0: performance.now(), ms: 650, p0: camera.position.clone(), c0: controls.target.clone(), p1: centre.clone().addScaledVector(dir, distance), c1: centre };
        camera.near = Math.max(model / 1000, 1e-4); camera.far = model * 200; camera.updateProjectionMatrix();
        invalidate();
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
            applyVisibility();
        },
        show(key, visible) { if (visible) hidden.delete(key); else hidden.add(key); applyVisibility(); },
        /** Show only this finding and fly to it. */
        focus(key) {
            only = key; applyVisibility();
            const box = new THREE.Box3();
            overlays.children.forEach(o => { if (o.userData.key === key) { o.geometry.computeBoundingBox(); box.union(o.geometry.boundingBox); } });
            if (!box.isEmpty() && baseGeom) flyToBox(box, 1.6);
        },
        showAll() { only = null; applyVisibility(); },
        fit() {
            if (!baseGeom) return;
            const box = baseGeom.boundingBox, size = box.getSize(new THREE.Vector3()), centre = box.getCenter(new THREE.Vector3());
            const radius = Math.max(size.length() / 2, 1e-6);
            const distance = radius / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2)) * 1.15;
            camera.position.copy(centre).addScaledVector(new THREE.Vector3(0.55, -0.8, 0.5).normalize(), distance);
            camera.near = radius / 100; camera.far = radius * 100; camera.updateProjectionMatrix();
            controls.target.copy(centre); controls.update(); invalidate();
        },
        /** Fly back to the whole model from the current direction. */
        reset() { if (baseGeom) flyToBox(baseGeom.boundingBox, 1.15); },
        invalidate,
        dispose() {
            cancelAnimationFrame(frame); frame = 0; observer.disconnect(); controls.dispose();
            overlays.children.forEach(o => { o.geometry.dispose(); o.material.dispose(); });
            baseGeom?.dispose(); front.dispose(); back.dispose(); renderer.dispose(); renderer.domElement.remove();
        },
    };
}
