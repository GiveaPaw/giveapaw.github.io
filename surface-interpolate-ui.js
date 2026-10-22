// Surface interpolator panel: drop zones for a solid and an ordered set of painted surfaces, a three.js
// view with a blend slider, and export of the in-betweens as STL. The page (surface-interpolator.html)
// mounts it full-width; the presentation editor can mount the same panel in a dialog and take the
// files through onOutput instead of downloads. Pure DOM, like model-convert-ui.js.
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { zipSync } from 'three/addons/libs/fflate.module.js';
import { el, icon, icons } from './model-convert-ui.js';
import { fileKind, loadMesh, fmtInt } from './model-convert.js';
import { THREE, blend, cut, loadSolid, membership, signedDistance, sortByNumber, toStl } from './surface-interpolate.js';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/**
 * Mount the panel in `root`.
 * options.sample: { solid, surfaces: [] } site paths for a "Try a sample" button (omit for none).
 * options.onOutput(files, kind): called with [{ name, blob }] instead of downloading when given.
 * options.notify(message, { error }): where to show short messages (default: a toast inside the panel).
 * options.steps: default steps between neighbouring surfaces (9).
 * Returns { load(solid, surfaces), reset(), dispose(), get solid, get surfaces }.
 */
export function createInterpolatorPanel(root, options = {}) {
    const notify = options.notify || toastIn(root);
    let solid = null;           // from loadSolid
    let surfaces = [];          // { name, raw, phi, count, fraction, pieces, error }
    let viewer = null;
    let busyDepth = 0;
    let disposed = false;

    // ----- DOM
    const solidInfo = el('p', { class: 'si-loaded', hidden: true });
    const solidInput = el('input', { type: 'file', accept: '.stl,.obj,.3mf,.glb,.gltf', hidden: true });
    const sampleBtn = options.sample ? el('button', { type: 'button', class: 'mc-btn', title: 'Load a worked example: a scanned body and three surfaces on it',
        onclick: event => { event.stopPropagation(); loadSample(); } }, icon('sparkles'), ' Try a sample') : null;
    const solidZone = el('section', { class: 'cv-drop si-drop', tabindex: '0', 'aria-label': 'Choose the solid animal' },
        icon('box'), el('h2', {}, '1. The solid animal'),
        el('p', {}, 'The body mesh the surfaces were painted on (STL, OBJ, 3MF or GLB). Units and orientation are kept as they are.'),
        el('div', { class: 'cv-drop-actions' },
            el('button', { type: 'button', class: 'mc-btn mc-primary', onclick: event => { event.stopPropagation(); solidInput.click(); } }, icon('folder-open'), ' Choose the solid'),
            sampleBtn),
        solidInput, solidInfo);

    const list = el('ol', { class: 'si-list', onclick: event => event.stopPropagation() });
    const surfaceInput = el('input', { type: 'file', accept: '.stl,.obj,.3mf,.glb,.gltf', multiple: true, hidden: true });
    const surfaceZone = el('section', { class: 'cv-drop si-drop', tabindex: '0', 'aria-label': 'Choose the painted surfaces' },
        icon('layers'), el('h2', {}, '2. The painted surfaces, in order'),
        el('p', {}, 'Two or more, exported from the same solid. Name them with a number (surface-1, surface-2, …) and they are sorted by it; you can reorder them below. In-betweens are made between each neighbouring pair.'),
        el('div', { class: 'cv-drop-actions' },
            el('button', { type: 'button', class: 'mc-btn mc-primary', onclick: event => { event.stopPropagation(); surfaceInput.click(); } }, icon('folder-open'), ' Choose surfaces')),
        surfaceInput, list);

    const pos = el('output', {});
    const posNote = el('span', {});
    const slider = el('input', { type: 'range', class: 'si-slider', min: 0, max: 1, step: 0.01, value: 0, 'aria-label': 'Position between the surfaces', oninput: () => update() });
    const ticks = el('div', { class: 'si-ticks' });
    const measure = el('small', {});
    const stepsInput = el('input', { type: 'number', min: 0, max: 500, value: options.steps ?? 9, oninput: () => updateCount() });
    const countLine = el('small', {});
    const zipBtn = el('button', { type: 'button', class: 'mc-btn mc-gold', onclick: () => exportAll() }, icon('package'), options.onOutput ? ' Make all of them' : ' Download all as a zip');
    const oneBtn = el('button', { type: 'button', class: 'mc-btn', title: 'Just the surface at the slider position', onclick: () => exportOne() }, icon('file-down'), options.onOutput ? ' Make this one' : ' Download this one');
    const progress = el('div', { class: 'mc-progress', hidden: true }, el('span'));
    const progressText = el('p', { class: 'mc-progress-text' });
    const onlyBtn = el('button', { type: 'button', class: 'mc-btn', 'aria-pressed': 'false', onclick: () => { const on = onlyBtn.getAttribute('aria-pressed') !== 'true'; onlyBtn.setAttribute('aria-pressed', String(on)); viewer?.setOnly(on); } }, 'Surface only');
    const upBtn = el('button', { type: 'button', class: 'mc-btn', title: 'Swap which axis points up in the view', onclick: () => { if (viewer) upBtn.textContent = `Up: ${viewer.toggleUp()}`; } }, 'Up: Z');
    const fitBtn = el('button', { type: 'button', class: 'mc-btn', onclick: () => viewer?.fit() }, 'Fit view');
    const canvas = el('canvas', { 'aria-label': '3D view of the solid with the blended surface in gold' });
    const busyBox = el('div', { class: 'si-busy', hidden: true });
    const stage = el('div', { class: 'si-stage' }, canvas, busyBox);
    const restartBtn = el('button', { type: 'button', class: 'mc-btn', onclick: () => reset() }, icon('rotate-ccw'), ' Start over');
    const work = el('section', { class: 'cv-work', hidden: true },
        el('div', { class: 'cv-work-head' }, el('h2', {}, 'Scrub between the surfaces'), restartBtn),
        el('div', { class: 'si-panel' },
            el('div', { class: 'si-side' },
                el('div', { class: 'mc-card' }, el('h3', {}, icon('sliders-horizontal'), ' Position'),
                    el('div', { class: 'si-readout' }, pos, posNote), slider, ticks, measure),
                el('div', { class: 'mc-card' }, el('h3', {}, icon('download'), ' Make the in-betweens'),
                    el('label', { class: 'mc-field' }, el('span', {}, 'Steps between each pair of surfaces'), stepsInput),
                    countLine, el('div', { class: 'si-actions' }, zipBtn, oneBtn), progress, progressText),
                el('div', { class: 'mc-card' }, el('h3', {}, icon('eye'), ' View'),
                    el('div', { class: 'si-actions' }, onlyBtn, upBtn, fitBtn),
                    el('small', {}, 'Drag to turn, scroll to zoom, right-drag to pan. The gold patch is the surface at the slider position; its edge is drawn in blue.'))),
            stage));
    const steps = el('div', { class: 'si-steps' }, solidZone, surfaceZone);
    root.replaceChildren(steps, work);
    icons();

    dropZone(solidZone, solidInput, files => setSolid(files[0], files[0].name));
    dropZone(surfaceZone, surfaceInput, files => addSurfaces(files.map(f => ({ source: f, name: f.name }))));

    // ----- loading
    function busy(text) {
        if (text) { busyDepth++; busyBox.textContent = text; busyBox.hidden = false; }
        else if (--busyDepth <= 0) { busyDepth = 0; busyBox.hidden = true; }
    }

    async function setSolid(source, name) {
        if (!fileKind(name)) { notify('The solid must be an STL, OBJ, 3MF or GLB file.', { error: true }); return; }
        solidInfo.hidden = false;
        solidInfo.textContent = `Reading ${name}…`;
        await tick();
        try {
            const loaded = await loadSolid(source, name);
            if (disposed) return;
            solid = loaded;
        } catch (err) {
            solidInfo.textContent = '';
            solidInfo.hidden = true;
            notify(err.message || String(err), { error: true });
            return;
        }
        const size = solid.bounds.getSize(new THREE.Vector3());
        const dim = v => v.toFixed(v > 10 ? 0 : 3);
        solidInfo.textContent = `${name}: ${fmtInt(solid.nv)} vertices, ${fmtInt(solid.nf)} triangles, ${dim(size.x)} × ${dim(size.y)} × ${dim(size.z)} units`;
        solidZone.classList.add('done');
        for (const s of surfaces) { s.phi = null; s.error = ''; }
        work.hidden = true;
        await prepareAll();
    }

    async function addSurfaces(items) {
        for (const { source, name } of items) {
            if (!fileKind(name)) { notify(`${name} is not an STL, OBJ, 3MF or GLB file.`, { error: true }); continue; }
            if (surfaces.some(s => s.name === name)) { notify(`${name} is already in the list.`); continue; }
            try {
                const raw = await loadMesh(source, name);
                if (disposed) return;
                surfaces.push({ name, raw, phi: null, error: '' });
            } catch (err) {
                notify(`${name}: ${err.message || err}`, { error: true });
            }
        }
        surfaces = sortByNumber(surfaces);
        renderList();
        await prepareAll();
    }

    async function prepareAll() {
        renderList();
        if (!solid) return;
        for (const s of surfaces) {
            if (s.phi || s.error) continue;
            busy(`Measuring ${s.name}…`);
            await tick();
            try {
                const m = membership(solid, s.raw);
                s.count = m.count;
                s.pieces = m.pieces;
                s.fraction = m.count / solid.nv;
                if (m.count > 50) s.phi = signedDistance(solid, m.member);
                else s.error = 'does not sit on this solid';
            } catch (err) {
                s.error = err.message || String(err);
            } finally {
                busy();
            }
            if (disposed) return;
            renderList();
        }
        if (readySurfaces().length >= 2) showViewer();
        else if (surfaces.length >= 2) notify('Fewer than two surfaces match this solid. Check that they were painted on it.', { error: true });
    }

    function renderList() {
        list.replaceChildren(...surfaces.map((s, i) => {
            const meta = s.error ? s.error
                : s.phi ? `covers ${(100 * s.fraction).toFixed(1)}% of the solid` + (s.pieces > 2 ? ` · leaves ${s.pieces - 1} unpainted islands` : '')
                : solid ? 'measuring…' : `${fmtInt(s.raw.faces)} triangles`;
            return el('li', {},
                el('span', { class: 'name', title: s.name }, s.name),
                el('span', { class: 'meta' + (s.error ? ' bad' : '') }, meta),
                el('button', { type: 'button', title: 'Move up', 'aria-label': `Move ${s.name} up`, disabled: i === 0, onclick: () => move(i, -1) }, '↑'),
                el('button', { type: 'button', title: 'Move down', 'aria-label': `Move ${s.name} down`, disabled: i === surfaces.length - 1, onclick: () => move(i, 1) }, '↓'),
                el('button', { type: 'button', title: 'Remove', 'aria-label': `Remove ${s.name}`, onclick: () => { surfaces.splice(i, 1); renderList(); refreshViewer(); } }, '×'));
        }));
        surfaceZone.classList.toggle('done', readySurfaces().length >= 2);
    }

    function move(i, by) {
        const j = i + by;
        [surfaces[i], surfaces[j]] = [surfaces[j], surfaces[i]];
        renderList();
        refreshViewer();
    }

    async function loadSample() {
        const { solid: s, surfaces: list } = options.sample;
        await setSolid(s, s.split('/').pop());
        if (!disposed) await addSurfaces(list.map(p => ({ source: p, name: p.split('/').pop() })));
    }

    // ----- viewer
    function readySurfaces() { return surfaces.filter(s => s.phi); }

    function showViewer() {
        work.hidden = false;
        if (!viewer) viewer = createViewer(stage, canvas);
        refreshViewer();
        work.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    function refreshViewer() {
        const ready = readySurfaces();
        if (!viewer || ready.length < 2) { work.hidden = true; return; }
        work.hidden = false;
        viewer.setSolid(solid);
        slider.max = ready.length - 1;
        if (+slider.value > ready.length - 1) slider.value = 0;
        ticks.replaceChildren(...ready.map((s, i) => el('button', { type: 'button', title: s.name, 'aria-label': `Jump to surface ${i + 1}, ${s.name}`,
            style: `--p: ${i / (ready.length - 1)}`, class: i === 0 ? 'start' : i === ready.length - 1 ? 'end' : '',
            onclick: () => { slider.value = i; update(); } }, String(i + 1))));
        update();
        updateCount();
    }

    function position() {
        const ready = readySurfaces();
        const s = Math.min(+slider.value, ready.length - 1);
        const k = Math.min(Math.floor(s), ready.length - 2);
        return { ready, k, t: s - k, s };
    }

    function update() {
        const { ready, k, t, s } = position();
        if (ready.length < 2) return;
        viewer.setPair(ready[k].phi, ready[k + 1].phi, t);
        const atKey = Math.abs(t) < 0.005 || Math.abs(t - 1) < 0.005;
        pos.textContent = atKey ? `Surface ${Math.round(s) + 1}` : `${Math.round(t * 100)}% from ${k + 1} to ${k + 2}`;
        posNote.textContent = atKey ? ready[Math.round(s)].name : `between ${ready[k].name} and ${ready[k + 1].name}`;
        measure.textContent = '';
    }

    function stepCount() { return Math.min(500, Math.max(0, Math.round(+stepsInput.value || 0))); }
    function updateCount() {
        const n = readySurfaces().length, steps = stepCount();
        countLine.textContent = n >= 2 ? `${n + (n - 1) * steps} files: the ${n} surfaces you loaded plus ${steps} between each neighbouring pair.` : '';
    }

    // ----- output
    const stlName = index => `surface_${String(index).padStart(2, '0')}.stl`;

    async function exportAll() {
        const ready = readySurfaces();
        if (ready.length < 2) return;
        const steps = stepCount();
        const files = {}, out = [];
        const rows = ['file,from_surface,to_surface,position,triangles,boundary_loops,area'];
        const total = ready.length + (ready.length - 1) * steps;
        progress.hidden = false;
        progress.classList.remove('done', 'error');
        zipBtn.disabled = oneBtn.disabled = true;
        let index = 0;
        const field = new Float32Array(solid.nv);
        try {
            for (let k = 0; k < ready.length; k++) {
                const count = k < ready.length - 1 ? steps + 1 : 1;
                for (let j = 0; j < count; j++) {
                    if (disposed) return;
                    const t = j / (steps + 1);
                    const phi = k < ready.length - 1 ? blend(ready[k].phi, ready[k + 1].phi, t, field) : ready[k].phi;
                    const result = cut(solid, phi);
                    index++;
                    const name = stlName(index);
                    const blob = toStl(result.positions, name);
                    out.push({ name, blob, from: ready[k].name, to: ready[Math.min(k + 1, ready.length - 1)].name, t, faces: result.faces, loops: result.loops });
                    if (!options.onOutput) files[name] = new Uint8Array(await blob.arrayBuffer());
                    rows.push(`${name},${ready[k].name},${ready[Math.min(k + 1, ready.length - 1)].name},${t.toFixed(3)},${result.faces},${result.loops},${result.area.toPrecision(6)}`);
                    progress.querySelector('span').style.width = `${(index / total) * 100}%`;
                    progressText.textContent = `${index} of ${total}: ${name} (${fmtInt(result.faces)} triangles, ${result.loops} edge loop${result.loops === 1 ? '' : 's'})`;
                    await tick();
                }
            }
            const manifest = new Blob([rows.join('\n') + '\n'], { type: 'text/csv' });
            if (options.onOutput) {
                await options.onOutput([...out, { name: 'manifest.csv', blob: manifest }], 'all');
                progressText.textContent = `${total} surfaces made.`;
            } else {
                files['manifest.csv'] = new Uint8Array(await manifest.arrayBuffer());
                download(new Blob([zipSync(files, { level: 1 })], { type: 'application/zip' }), 'surfaces.zip');
                progressText.textContent = `${total} surfaces written to surfaces.zip.`;
            }
            progress.classList.add('done');
        } catch (err) {
            progress.classList.add('error');
            progressText.textContent = err.message || String(err);
        } finally {
            zipBtn.disabled = oneBtn.disabled = false;
        }
    }

    async function exportOne() {
        const { ready, k, t } = position();
        if (ready.length < 2) return;
        const result = cut(solid, blend(ready[k].phi, ready[k + 1].phi, t));
        const name = `surface_${k + 1}-${k + 2}_${Math.round(t * 100)}pct.stl`;
        const blob = toStl(result.positions, name);
        if (options.onOutput) await options.onOutput([{ name, blob, from: ready[k].name, to: ready[k + 1].name, t, faces: result.faces, loops: result.loops }], 'one');
        else download(blob, name);
        measure.textContent = `${name}: ${fmtInt(result.faces)} triangles, ${result.loops} edge loop${result.loops === 1 ? '' : 's'}`;
    }

    // ----- lifecycle
    function reset() {
        solid = null; surfaces = [];
        work.hidden = true;
        solidInfo.hidden = true;
        solidZone.classList.remove('done');
        solidInput.value = surfaceInput.value = '';
        progress.hidden = true;
        progressText.textContent = '';
        renderList();
        steps.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    return {
        get solid() { return solid; },
        get surfaces() { return surfaces; },
        get viewer() { return viewer; },
        async load(solidSource, solidName, items = []) {
            await setSolid(solidSource, solidName);
            if (items.length && !disposed) await addSurfaces(items);
        },
        reset,
        dispose() { disposed = true; viewer?.dispose(); viewer = null; root.replaceChildren(); },
    };
}

function toastIn(root) {
    const box = el('div', { class: 'cv-toast', role: 'status', hidden: true });
    root.append(box);
    let timer = 0;
    return (message, { error = false, ms = 4500 } = {}) => {
        box.textContent = message;
        box.classList.toggle('error', error);
        box.hidden = false;
        clearTimeout(timer);
        timer = setTimeout(() => { box.hidden = true; }, ms);
    };
}

function dropZone(zone, input, onFiles) {
    zone.addEventListener('click', () => input.click());
    zone.addEventListener('keydown', event => { if ((event.key === 'Enter' || event.key === ' ') && event.target === zone) { event.preventDefault(); input.click(); } });
    input.addEventListener('change', () => { const files = [...(input.files || [])]; if (files.length) onFiles(files); input.value = ''; });
    zone.addEventListener('dragover', event => { if (event.dataTransfer?.types?.includes('Files')) { event.preventDefault(); zone.classList.add('over'); } });
    zone.addEventListener('dragleave', () => zone.classList.remove('over'));
    zone.addEventListener('drop', event => {
        if (!event.dataTransfer?.files?.length) return;
        event.preventDefault();
        zone.classList.remove('over');
        onFiles([...event.dataTransfer.files]);
    });
}

function createViewer(stage, canvas) {
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0xe6eaf0);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(30, 1, 0.001, 1e6);
    scene.add(camera);
    const hemi = new THREE.HemisphereLight(0xffffff, 0x66707f, 0.9);
    scene.add(hemi);
    const head = new THREE.DirectionalLight(0xffffff, 1.2);
    head.position.set(-0.4, 0.6, 1);
    camera.add(head);
    const controls = new OrbitControls(camera, canvas);
    const U = { uT: { value: 0 }, uOnly: { value: 0 }, uSurf: { value: new THREE.Color('#fdb515') }, uEdge: { value: new THREE.Color('#003262') }, uH: { value: 1 } };
    let mesh = null, geometry = null, up = 'Z', fieldA = null, fieldB = null, srcA = null, srcB = null;

    const material = new THREE.MeshStandardMaterial({ color: 0xb4bcc8, roughness: 0.8, metalness: 0, side: THREE.DoubleSide });
    material.onBeforeCompile = sh => {
        Object.assign(sh.uniforms, U);
        sh.vertexShader = 'attribute float fa;\nattribute float fb;\nvarying float vPhi;\nuniform float uT;\n' +
            sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvPhi = mix(fa, fb, uT);');
        sh.fragmentShader = 'varying float vPhi;\nuniform float uOnly;\nuniform vec3 uSurf;\nuniform vec3 uEdge;\nuniform float uH;\n' +
            sh.fragmentShader.replace('#include <color_fragment>', [
                '#include <color_fragment>',
                'float aa = max(fwidth(vPhi), 1e-6);',
                'if (uOnly > 0.5 && vPhi > aa) discard;',
                'float inside = 1.0 - smoothstep(-aa, aa, vPhi);',
                'diffuseColor.rgb = mix(diffuseColor.rgb, uSurf, inside);',
                'float w = max(0.25 * uH, 0.75 * aa);',
                'diffuseColor.rgb = mix(diffuseColor.rgb, uEdge, 1.0 - smoothstep(w, w + aa, abs(vPhi)));',
            ].join('\n'));
    };

    let queued = false;
    const draw = () => { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; renderer.render(scene, camera); }); };
    controls.addEventListener('change', draw);
    const size = () => {
        const w = stage.clientWidth, h = stage.clientHeight;
        if (!w || !h) return;
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        draw();
    };
    const observer = new ResizeObserver(size);
    observer.observe(stage);

    const fit = () => {
        if (!geometry) return;
        const box = geometry.boundingBox, centre = box.getCenter(new THREE.Vector3()), ext = box.getSize(new THREE.Vector3()), radius = ext.length() / 2;
        camera.up.set(0, up === 'Z' ? 0 : 1, up === 'Z' ? 1 : 0);
        camera.near = radius / 100; camera.far = radius * 100;
        camera.updateProjectionMatrix();
        const d = radius / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2)) * 0.9;
        // look at the long side of the animal from a little above
        const dir = up === 'Z' ? (ext.x >= ext.y ? new THREE.Vector3(0.25, -1, 0.35) : new THREE.Vector3(-1, 0.25, 0.35))
            : (ext.x >= ext.z ? new THREE.Vector3(0.25, 0.35, 1) : new THREE.Vector3(-1, 0.35, 0.25));
        camera.position.copy(centre).add(dir.normalize().multiplyScalar(d));
        controls.target.copy(centre);
        controls.minDistance = radius * 0.1; controls.maxDistance = radius * 20;
        controls.update();
        draw();
    };

    return {
        setSolid(s) {
            if (mesh && geometry.userData.solid === s) return;
            if (mesh) { scene.remove(mesh); geometry.dispose(); }
            geometry = new THREE.BufferGeometry();
            geometry.setAttribute('position', new THREE.BufferAttribute(s.V, 3));
            geometry.setIndex(new THREE.BufferAttribute(s.F, 1));
            geometry.computeVertexNormals();
            geometry.computeBoundingBox();
            geometry.userData.solid = s;
            fieldA = new THREE.BufferAttribute(new Float32Array(s.nv), 1);
            fieldB = new THREE.BufferAttribute(new Float32Array(s.nv), 1);
            geometry.setAttribute('fa', fieldA);
            geometry.setAttribute('fb', fieldB);
            srcA = srcB = null;
            U.uH.value = s.h;
            mesh = new THREE.Mesh(geometry, material);
            scene.add(mesh);
            size();
            fit();
        },
        setPair(a, b, t) {
            if (srcA !== a) { fieldA.array.set(a); fieldA.needsUpdate = true; srcA = a; }
            if (srcB !== b) { fieldB.array.set(b); fieldB.needsUpdate = true; srcB = b; }
            U.uT.value = t;
            draw();
        },
        setOnly(on) { U.uOnly.value = on ? 1 : 0; draw(); },
        toggleUp() { up = up === 'Z' ? 'Y' : 'Z'; fit(); return up; },
        fit,
        dispose() {
            observer.disconnect();
            controls.dispose();
            if (mesh) { scene.remove(mesh); geometry.dispose(); }
            material.dispose();
            renderer.dispose();
        },
    };
}
