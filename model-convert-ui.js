// The converter's user interface, shared by convert.html and the editor's media gallery:
// settings (orientation, units, quality tier, colour), a 3D preview in the site's frame, the result's
// numbers, and "Compare quality levels" (the same model at several triangle budgets side by side,
// one camera for all of them). Pure DOM, no framework; icons are Lucide when window.lucide exists.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { ACCEPT, MATTE_GREY, PRESENTATION_FACES, TIERS, UNITS, UPS, convert, fmtBytes, fmtInt, loadMesh, outputName, prepare, simplify, sizeText, toGlb } from './model-convert.js';

export { ACCEPT };

export function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
        if (value == null || value === false) continue;
        if (key === 'class') node.className = value;
        else if (key === 'dataset') Object.assign(node.dataset, value);
        else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
        else if (key === 'html') node.innerHTML = value;
        else if (value === true) node.setAttribute(key, '');
        else node.setAttribute(key, value);
    }
    node.append(...children.flat().filter(c => c != null && c !== false).map(c => typeof c === 'string' ? document.createTextNode(c) : c));
    return node;
}
export const icon = name => el('i', { 'data-lucide': name, 'aria-hidden': 'true' });
export function icons(root = document) { window.lucide?.createIcons({ attrs: {}, nameAttr: 'data-lucide' }); void root; }

// ---- viewer ---------------------------------------------------------------------------------------

/**
 * One canvas, one camera, one or more "cells" each showing a different mesh (scissored). Z is up and
 * the grid lies in the XY plane at the model's lowest point, like the review page.
 */
export function createViewer(container) {
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
    let cells = [];
    let dirty = true;
    let frame = 0;
    const material = () => new THREE.MeshStandardMaterial({ color: new THREE.Color(MATTE_GREY[0] / 255, MATTE_GREY[1] / 255, MATTE_GREY[2] / 255), roughness: 0.85, metalness: 0 });

    function sceneFor(geometry, color) {
        const scene = new THREE.Scene();
        scene.add(new THREE.HemisphereLight(0xffffff, 0x94a3b3, 1.1));
        const sun = new THREE.DirectionalLight(0xffffff, 1.4);
        sun.position.set(1, -0.8, 1.6);
        scene.add(sun);
        const fill = new THREE.DirectionalLight(0xffffff, 0.5);
        fill.position.set(-1, 0.6, 0.4);
        scene.add(fill);
        const mesh = new THREE.Mesh(geometry, material());
        if (color) mesh.material.color.set(color);
        scene.add(mesh);
        const box = geometry.boundingBox || (geometry.computeBoundingBox(), geometry.boundingBox);
        const size = box.getSize(new THREE.Vector3());
        const span = Math.max(size.x, size.y) * 1.6 || 100;
        const grid = new THREE.GridHelper(span, 16, 0xaeb8c4, 0xd8dee5);
        grid.rotation.x = Math.PI / 2;
        grid.position.set((box.min.x + box.max.x) / 2, (box.min.y + box.max.y) / 2, box.min.z);
        scene.add(grid);
        return { scene, mesh, grid };
    }
    function layout(n) {
        const cols = n <= 1 ? 1 : n === 2 ? 2 : n <= 4 ? 2 : 3;
        return { cols, rows: Math.ceil(n / cols) };
    }
    function render() {
        frame = 0;
        const w = container.clientWidth, hgt = container.clientHeight;
        if (!w || !hgt) return;
        if (renderer.domElement.width !== Math.round(w * renderer.getPixelRatio()) || renderer.domElement.height !== Math.round(hgt * renderer.getPixelRatio())) renderer.setSize(w, hgt, false);
        renderer.domElement.style.width = `${w}px`;
        renderer.domElement.style.height = `${hgt}px`;
        const { cols, rows } = layout(cells.length);
        const cw = w / cols, ch = hgt / rows;
        camera.aspect = cw / ch;
        camera.updateProjectionMatrix();
        renderer.setScissorTest(cells.length > 1);
        cells.forEach((cell, i) => {
            const x = (i % cols) * cw, y = hgt - (Math.floor(i / cols) + 1) * ch;   // GL counts from the bottom
            renderer.setViewport(x, y, cw, ch);
            renderer.setScissor(x, y, cw, ch);
            renderer.render(cell.scene, camera);
        });
    }
    function loop() {
        frame = 0;
        const moved = controls.update();
        if (dirty || moved) { dirty = false; render(); }
        if (cells.length) frame = requestAnimationFrame(loop);
    }
    const invalidate = () => { dirty = true; if (!frame && cells.length) frame = requestAnimationFrame(loop); };
    controls.addEventListener('change', invalidate);
    const observer = new ResizeObserver(invalidate);
    observer.observe(container);

    function clear() {
        cells.forEach(c => { c.mesh.material.dispose(); c.grid.geometry.dispose(); c.grid.material.dispose(); });
        cells = [];
    }
    return {
        camera, controls, renderer,
        layout: () => layout(cells.length),
        /** cells: [{ geometry, color? }] -- the geometries are not disposed by the viewer. */
        setCells(list) {
            clear();
            cells = list.map(c => sceneFor(c.geometry, c.color));
            invalidate();
        },
        setColor(color) { cells.forEach(c => c.mesh.material.color.set(color)); invalidate(); },
        fit(box) {
            const size = box.getSize(new THREE.Vector3());
            const centre = box.getCenter(new THREE.Vector3());
            const radius = Math.max(size.length() / 2, 1);
            const distance = radius / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2)) * 1.15;
            const direction = new THREE.Vector3(0.55, -0.8, 0.5).normalize();
            camera.position.copy(centre).addScaledVector(direction, distance);
            camera.near = radius / 100;
            camera.far = radius * 100;
            camera.updateProjectionMatrix();
            controls.target.copy(centre);
            controls.update();
            invalidate();
        },
        invalidate,
        screenshot: () => renderer.domElement.toDataURL('image/png'),
        dispose() {
            cancelAnimationFrame(frame);
            frame = 0;
            observer.disconnect();
            controls.dispose();
            clear();
            renderer.dispose();
            renderer.domElement.remove();
        },
    };
}

// ---- the panel -------------------------------------------------------------------------------------

const COMPARE_BUDGETS = [50000, PRESENTATION_FACES, 500000];
const hexOf = rgb => '#' + rgb.map(v => v.toString(16).padStart(2, '0')).join('');
const rgbOf = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));

/**
 * Build the converter inside `root`.
 *   source: File | Blob | ArrayBuffer | same-origin URL;  name: the file's name (decides the parser)
 *   onResult(result | null): called with each finished conversion ({ glb, stats, name, options })
 *   actions: extra buttons (DOM nodes) shown under the settings, e.g. Download or Use this file
 * Returns { result, compare(), dispose() }.
 */
export function createConvertPanel(root, { source, name, onResult = () => {}, actions = [] }) {
    const kind = name.toLowerCase().split('.').pop();
    const state = { up: kind === 'glb' || kind === 'gltf' ? 'Z' : 'Z', unit: 'mm', tier: 'presentation', faces: PRESENTATION_FACES, color: hexOf(MATTE_GREY) };
    let raw = null, prepared = null, result = null, busy = false, pending = false, disposed = false;
    let compareBox = null;

    const viewHost = el('div', { class: 'mc-view' });
    const viewer = createViewer(viewHost);
    const badge = el('div', { class: 'mc-view-badge' }, icon('axis-3d'), ' Z up · millimetres · drag to turn, scroll to zoom');
    viewHost.append(badge);
    const compareHost = el('div', { class: 'mc-compare', hidden: true });

    const fileLine = el('p', { class: 'mc-file' });
    const sizeLine = el('p', { class: 'mc-size' });
    const hint = el('p', { class: 'mc-hint', hidden: true });
    const select = (key, options, onchange) => el('select', { onchange: e => { state[key] = e.target.value; onchange(); } },
        ...options.map(o => el('option', { value: o.key, selected: o.key === state[key] }, o.label)));
    const upSelect = select('up', UPS, () => reprepare());
    const unitSelect = select('unit', UNITS, () => reprepare());
    const customInput = el('input', { type: 'number', min: 1000, step: 1000, value: state.faces, oninput: e => { state.faces = +e.target.value; if (state.tier === 'custom') schedule(); } });
    const tierTiles = el('div', { class: 'mc-tiers' });
    function renderTiers() {
        tierTiles.replaceChildren(...TIERS.map(t => el('label', { class: 'mc-tier' + (state.tier === t.key ? ' active' : '') },
            el('input', { type: 'radio', name: 'mc-tier', value: t.key, checked: state.tier === t.key, onchange: () => { state.tier = t.key; renderTiers(); schedule(); } }),
            el('strong', {}, t.label, t.faces === Infinity ? '' : ` · ${fmtInt(t.faces)} triangles`),
            el('span', {}, t.blurb),
            raw && t.faces !== Infinity && raw.faces <= t.faces ? el('em', {}, 'This file is already under that, so it only gets compressed.') : null)),
            el('label', { class: 'mc-tier mc-tier-custom' + (state.tier === 'custom' ? ' active' : '') },
                el('input', { type: 'radio', name: 'mc-tier', value: 'custom', checked: state.tier === 'custom', onchange: () => { state.tier = 'custom'; renderTiers(); schedule(); } }),
                el('strong', {}, 'Custom'), el('span', {}, 'Triangles to keep: ', customInput)));
    }
    renderTiers();
    const colorInput = el('input', { type: 'color', value: state.color, oninput: e => { state.color = e.target.value; viewer.setColor(state.color); }, onchange: () => schedule() });
    const resetColor = el('button', { type: 'button', class: 'mc-link', onclick: () => { state.color = hexOf(MATTE_GREY); colorInput.value = state.color; viewer.setColor(state.color); schedule(); } }, 'site grey');

    const progressBar = el('div', { class: 'mc-progress' }, el('span'));
    const progressText = el('p', { class: 'mc-progress-text' }, 'Loading…');
    const stats = el('dl', { class: 'mc-stats' });
    const compareBtn = el('button', { type: 'button', class: 'mc-btn', disabled: true, onclick: () => compare() }, icon('columns-3'), ' Compare quality levels');
    const actionsRow = el('div', { class: 'mc-actions' }, compareBtn, ...actions);

    const side = el('div', { class: 'mc-side' },
        el('section', { class: 'mc-card' }, el('h3', {}, icon('file-box'), ' File'), fileLine, sizeLine, hint),
        el('section', { class: 'mc-card' }, el('h3', {}, icon('axis-3d'), ' Orientation and units'),
            el('label', { class: 'mc-field' }, el('span', {}, 'Which way is up in this file?'), upSelect),
            el('label', { class: 'mc-field' }, el('span', {}, 'Units the file was saved in'), unitSelect),
            el('small', {}, 'The site shows every model Z up in millimetres, like nTop. Check the preview: the grid is the floor.')),
        el('section', { class: 'mc-card' }, el('h3', {}, icon('gauge'), ' Quality'), tierTiles,
            el('label', { class: 'mc-field mc-inline' }, el('span', {}, 'Colour'), colorInput, resetColor)),
        el('section', { class: 'mc-card mc-result' }, el('h3', {}, icon('package-check'), ' Result'), progressBar, progressText, stats),
        actionsRow);
    root.classList.add('mc-panel');
    root.replaceChildren(side, el('div', { class: 'mc-stage' }, viewHost, compareHost));
    icons(root);

    function setProgress(message, fraction) {
        progressBar.firstChild.style.width = `${Math.round(fraction * 100)}%`;
        progressBar.classList.toggle('done', fraction >= 1);
        progressText.textContent = message;
    }
    function fail(error) {
        console.error(error);
        setProgress(error.message || String(error), 0);
        progressBar.classList.add('error');
        onResult(null);
    }
    function showStats(s) {
        const rows = [
            ['Triangles', s.facesOut < s.facesIn ? `${fmtInt(s.facesIn)} → ${fmtInt(s.facesOut)} (${Math.round(100 * s.facesOut / s.facesIn)}% kept)` : `${fmtInt(s.facesOut)} (all kept)`],
            ['File size', `${fmtBytes(s.bytesIn)} → ${fmtBytes(s.bytesOut)} for the website (Draco), ${fmtBytes(s.bytesPlain)} plain`],
            ['Took', `${(s.ms / 1000).toFixed(1)} s`],
            ['Model size', sizeText(s.bounds)],
        ];
        stats.replaceChildren(...rows.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v)]));
    }

    async function load() {
        try {
            setProgress('Reading the file', 0.1);
            raw = await loadMesh(source, name);
            fileLine.replaceChildren(el('strong', {}, name), ` · ${raw.kind.toUpperCase()} · ${fmtBytes(raw.bytes)} · ${fmtInt(raw.faces)} triangles${raw.parts > 1 ? ` in ${raw.parts} parts` : ''}`);
            renderTiers();
            reprepare();
        } catch (error) { fail(error); }
    }
    function reprepare() {
        if (!raw) return;
        prepared?.dispose();
        prepared = prepare(raw, state);
        const size = prepared.boundingBox.getSize(new THREE.Vector3());
        sizeLine.textContent = `Measures ${sizeText(prepared.boundingBox)} in these units.`;
        const biggest = Math.max(size.x, size.y, size.z);
        hint.hidden = true;
        if (biggest < 5 && state.unit === 'mm') { hint.hidden = false; hint.textContent = `Only ${biggest.toFixed(2)} mm across. If this is a real part, the file is probably in metres: change the units above.`; }
        else if (biggest > 3000 && state.unit !== 'mm') { hint.hidden = false; hint.textContent = `${fmtInt(biggest)} mm across is very large: check the units.`; }
        viewer.setCells([{ geometry: prepared, color: state.color }]);
        viewer.fit(prepared.boundingBox);
        closeCompare();
        schedule();
    }
    let timer = 0;
    function schedule() {
        clearTimeout(timer);
        timer = setTimeout(run, 250);
    }
    async function run() {
        if (!raw || disposed) return;
        if (busy) { pending = true; return; }
        busy = true;
        compareBtn.disabled = true;
        progressBar.classList.remove('error');
        try {
            const options = { ...state, color: rgbOf(state.color), name, prepared };
            const out = await convert(raw, name, options, setProgress);
            delete options.prepared;
            if (disposed) return;
            result?.geometry?.dispose();
            result = { ...out, name: outputName(name), options };
            showStats(out.stats);
            // Show the file as it will be seen: the decimated mesh.
            if (!compareBox) { viewer.setCells([{ geometry: out.geometry, color: state.color }]); }
            onResult(result);
        } catch (error) { fail(error); }
        busy = false;
        compareBtn.disabled = !raw;
        if (pending) { pending = false; run(); }
    }

    function closeCompare() {
        if (!compareBox) return;
        compareBox.geometries.forEach(g => { if (g !== prepared && g !== result?.geometry) g.dispose(); });
        compareBox = null;
        compareHost.hidden = true;
        compareHost.replaceChildren();
        viewHost.classList.remove('mc-grid');
        if (result) viewer.setCells([{ geometry: result.geometry, color: state.color }]);
        else if (prepared) viewer.setCells([{ geometry: prepared, color: state.color }]);
        if (prepared) viewer.fit(prepared.boundingBox);
    }
    /** The same model at several budgets, side by side with one camera. */
    async function compare() {
        if (!prepared || busy) return;
        if (compareBox) { closeCompare(); compareBtn.replaceChildren(icon('columns-3'), ' Compare quality levels'); icons(compareBtn); return; }
        busy = true;
        compareBtn.disabled = true;
        const budgets = COMPARE_BUDGETS.filter(b => b < prepared.index.count / 3);
        const cells = [];
        try {
            for (const faces of budgets) {
                setProgress(`Comparing: ${fmtInt(faces)} triangles`, 0.3);
                await new Promise(r => setTimeout(r, 0));
                const t0 = performance.now();
                const g = await simplify(prepared, faces);
                const bytes = await toGlb(g, { color: rgbOf(state.color), name });
                const plain = await toGlb(g, { color: rgbOf(state.color), name, draco: false });
                cells.push({ geometry: g, label: `${fmtInt(faces)} triangles`, faces: g.index.count / 3, bytes: bytes.byteLength, plain: plain.byteLength, ms: performance.now() - t0 });
            }
            setProgress('Comparing: every triangle', 0.8);
            await new Promise(r => setTimeout(r, 0));
            const t0 = performance.now();
            const fullBytes = await toGlb(prepared, { color: rgbOf(state.color), name });
            const fullPlain = await toGlb(prepared, { color: rgbOf(state.color), name, draco: false });
            cells.push({ geometry: prepared, label: 'Full (every triangle)', faces: prepared.index.count / 3, bytes: fullBytes.byteLength, plain: fullPlain.byteLength, ms: performance.now() - t0 });
            setProgress('Done', 1);
        } catch (error) { fail(error); busy = false; compareBtn.disabled = false; return; }
        compareBox = { geometries: cells.map(c => c.geometry) };
        viewer.setCells(cells.map(c => ({ geometry: c.geometry, color: state.color })));
        viewer.fit(prepared.boundingBox);   // the cells are smaller than the single view
        const { cols } = viewer.layout();
        compareHost.hidden = false;
        compareHost.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
        compareHost.replaceChildren(...cells.map(c => el('div', { class: 'mc-cell' + (c.faces === result?.stats.facesOut ? ' chosen' : '') },
            el('strong', {}, c.label, c.faces === result?.stats.facesOut ? ' · your choice' : ''),
            el('span', {}, `${fmtInt(c.faces)} triangles · ${fmtBytes(c.bytes)} on the website · ${fmtBytes(c.plain)} plain · ${(c.ms / 1000).toFixed(1)} s to make`))));
        viewHost.classList.add('mc-grid');
        compareBtn.replaceChildren(icon('x'), ' Close comparison');
        icons(compareBtn);
        busy = false;
        compareBtn.disabled = false;
    }

    load();
    return {
        get result() { return result; },
        get state() { return state; },
        compare,
        dispose() {
            disposed = true;
            clearTimeout(timer);
            closeCompare();
            viewer.dispose();
            prepared?.dispose();
            result?.geometry?.dispose();
            root.replaceChildren();
            root.classList.remove('mc-panel');
        },
    };
}

/**
 * The converter in a modal dialog (used by the editor's media gallery). Resolves with
 * { blob, name, stats } when "Use this file" is pressed, or null when cancelled.
 */
export function openConvertDialog({ source, name, h = el }) {
    return new Promise(resolve => {
        const dialog = h('dialog', { class: 'mc-dialog', 'aria-label': 'Convert a 3D model' });
        let panel = null, latest = null;
        const useBtn = h('button', { type: 'button', class: 'mc-btn mc-primary', disabled: true, onclick: () => finish(latest) }, icon('check'), ' Use this file');
        const cancelBtn = h('button', { type: 'button', class: 'mc-btn', onclick: () => finish(null) }, 'Cancel');
        const body = h('div', { class: 'mc-dialog-body' });
        dialog.append(
            h('div', { class: 'mc-dialog-head' }, h('h3', {}, icon('box'), ' Convert for the web'), h('p', {}, `${name}: it is converted in this browser to a compressed GLB, then copied into the site.`),
                h('button', { type: 'button', class: 'mc-btn mc-icon', title: 'Close', onclick: () => finish(null) }, icon('x'))),
            body);
        function finish(value) {
            if (!dialog.open) return;
            dialog.close();
            panel?.dispose();
            dialog.remove();
            resolve(value ? { blob: value.glb, name: value.name, stats: value.stats } : null);
        }
        dialog.addEventListener('cancel', event => { event.preventDefault(); finish(null); });
        document.body.append(dialog);
        dialog.showModal();
        panel = createConvertPanel(body, { source, name, actions: [useBtn, cancelBtn], onResult: r => { latest = r; useBtn.disabled = !r; } });
        icons(dialog);
    });
}
