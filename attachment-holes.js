import * as THREE from 'three';

export function createAttachmentHoles({ scene, camera, canvas, transform, transformHelper,
    loadGLB, collectSurfaceTriangles, closestSurfacePoint, keepOverlayVisible, isMeasuring }) {
    const root = new THREE.Group();
    const surface = new THREE.Group();
    const animal = new THREE.Group();
    const handle = new THREE.Object3D();
    const points = [];
    const visibility = { surface: true, animal: true, capsule: true, attachment: true, points: true };
    // The status line under the block was removed; messages now only go to the console on failure.
    const status = { textContent: '' };
    const toolbar = document.getElementById('attachment-overlay-controls');
    const pickButton = document.getElementById('attachment-pick');
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let active = false;
    let selected = 0;
    let initialized = false;
    let editing = false;
    let picking = false;
    let preview = false;    // Steps 5 and 6: the placed parts show on the assembly, nothing else
    let bounds;
    let triangles = [];
    let sourceMesh = null;
    let sourceAnimal = null;
    let templates = null;   // { attachment, solid, capsule } for the current design
    let design = null;
    let index = null;       // which combinations nTop generated (sample-models/chi-attach/index.json)
    let designRequest = 0;
    let down;
    let dragFrame = null;
    const listeners = new Set();
    const emit = reason => listeners.forEach(fn => fn(reason));
    root.add(surface, animal, handle);
    root.visible = false;
    scene.add(root);

    // The parts come from the 10-13 notebook's attachment sweep (tools/convert_chi_attachments.py):
    // the printed attachment (cylinder around the screw, with its hole) and the capsule (the screw
    // shaft, which punches the hole). Both sit at the origin, base at z = 0, +Z out of the surface,
    // in millimetres. They are placed on the surface and move live; nothing is cut in the browser.
    const ASSET_DIR = 'sample-models/chi-attach/';
    // The 10-16 one-at-a-time sweep: one input varied, the others at the notebook's values (tools/convert_ollie_surface_sweeps.py).
    const ONE_DIR = 'sample-models/chi-attach-one/';
    let indexOne = null;
    const DEFAULT_DESIGN = { attachDiameter: 4, normalWallDistance: 4, screwHeadDiameter: 8, screwShaftDiameter: 4 };
    const templateCache = new Map();
    const pad = value => String(value).padStart(2, '0');
    function designFiles(d) {
        if (d.mode === 'one') {
            const code = `${d.param}-${pad(d.param === 'nozzle' ? Math.round(d.value * 10) : d.value)}`;
            return { attachment: `${ONE_DIR}${code}.glb`, capsule: `${ONE_DIR}${code}-cap.glb` };
        }
        const code = `a${pad(d.attachDiameter)}-w${pad(d.normalWallDistance)}-h${pad(d.screwHeadDiameter)}-s${pad(d.screwShaftDiameter)}`;
        return { attachment: `${ASSET_DIR}att-${code}.glb`, capsule: d.screwShaftDiameter > 0 ? `${ASSET_DIR}cap-s${pad(d.screwShaftDiameter)}.glb` : null };
    }
    function template(file) {
        if (!templateCache.has(file)) {
            const promise = loadGLB(file).then(gltf => {
                const model = gltf.scene;
                model.scale.setScalar(0.001);
                model.traverse(object => {
                    if (object.isMesh && !object.geometry.hasAttribute('normal')) object.geometry.computeVertexNormals();
                });
                return model;
            });
            promise.catch(() => templateCache.delete(file));
            templateCache.set(file, promise);
        }
        return templateCache.get(file);
    }
    function designExists(d) {
        if (d.mode === 'one') return !indexOne || (indexOne.attachment[d.param] || []).includes(d.value);
        if (!index) return true;
        const key = [d.attachDiameter, d.normalWallDistance, d.screwHeadDiameter, d.screwShaftDiameter].join(',');
        return index.attachment.some(combo => combo.join(',') === key);
    }
    async function setDesign(next) {
        design = { ...next };
        const files = designFiles(design);
        const request = ++designRequest;
        const [attachment, capsule] = await Promise.all([template(files.attachment), files.capsule ? template(files.capsule) : null]);
        if (request !== designRequest) return false;
        templates = { attachment, capsule };
        points.forEach(rebuildAssembly);
        syncVisibility();
        emit('design');
        return true;
    }
    const fetchIndex = url => fetch(url, { cache: 'no-cache' }).then(response => response.ok ? response.json() : null).catch(() => null);
    const ready = Promise.all([fetchIndex(ASSET_DIR + 'index.json'), fetchIndex(ONE_DIR + 'index.json')])
        .then(([grid, one]) => { index = grid; indexOne = one; return setDesign(DEFAULT_DESIGN); })
        .catch(error => { console.error('Attachment models could not be loaded.', error); });

    function styledClone(source, color, opacity = 1) {
        const clone = source.clone(true);
        clone.visible = true;
        clone.traverse(object => {
            if (!object.isMesh) return;
            object.material = new THREE.MeshStandardMaterial({ color, roughness: 0.7,
                transparent: opacity < 1, opacity, depthWrite: opacity === 1, side: THREE.DoubleSide });
            object.userData.measureSurface = true;
        });
        return clone;
    }

    function clearOwnedObjects(group) {
        group.traverse(object => {
            if (object.material) object.material.dispose();
        });
        group.clear();
    }

    const formatMm = meters => String(parseFloat((meters * 1000).toFixed(2)));

    function updateUI() {
        const point = points[selected];
        document.getElementById('attachment-point-count').textContent = points.length;
        document.querySelectorAll('[data-point-coordinate]').forEach(input => {
            const item = points[+input.dataset.pointIndex];
            if (item) input.value = formatMm(item.position[input.dataset.pointCoordinate]);
        });
        if (!point) return;
        document.querySelectorAll('[data-hole-select]').forEach(button => {
            button.classList.toggle('active', +button.dataset.holeSelect === selected);
            button.setAttribute('aria-pressed', String(+button.dataset.holeSelect === selected));
        });
        document.querySelectorAll('[data-hole-part]').forEach(button => {
            const part = button.dataset.holePart;
            button.classList.toggle('active', point[`${part}Visible`]);
            button.setAttribute('aria-label', `${point[`${part}Visible`] ? 'Hide' : 'Show'} selected ${part}`);
            button.setAttribute('aria-pressed', String(point[`${part}Visible`]));
        });
    }

    function syncVisibility() {
        surface.visible = visibility.surface && !preview;
        animal.visible = visibility.animal && !preview;
        points.forEach((point, index) => {
            point.capsule.visible = visibility.capsule && point.capsuleVisible && (!preview || point.placed);
            point.attachment.visible = visibility.attachment && point.attachmentVisible && (!preview || point.placed);
            point.marker.visible = visibility.points && !preview;
            point.arrow.visible = visibility.points && !preview && index === selected;
            point.marker.material.color.setHex(index === selected ? 0xfdb515 : 0x203951);
            point.marker.scale.setScalar(index === selected ? 1.3 : 1);
        });
        if (active) {
            transform.enabled = editing && !!points.length && !picking && !isMeasuring() && visibility.points;
            transformHelper.visible = transform.enabled;
        }
    }

    function place(index, position, normal, moveHandle = true) {
        const point = points[index];
        if (!point) return;
        point.position.copy(position);
        point.normal.copy(normal);
        point.assembly.position.copy(position);
        // The exported assets are centered without changing their original local axes.
        point.assembly.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
        point.marker.position.copy(position);
        point.arrow.position.copy(position);
        point.arrow.setDirection(normal);
        if (index === selected && moveHandle) handle.position.copy(position);
        if (index === selected) updateUI();
    }

    function snap(index, query, moveHandle = true) {
        const point = points[index];
        if (!point || !triangles.length) return;
        const nearest = closestSurfacePoint(query, triangles, bounds);
        point.placed = true;
        place(index, nearest.point, nearest.normal, moveHandle);
        status.textContent = `Point ${index} snapped to attachment surface`;
        if (moveHandle) emit('point'); // a drag reports once, from finishDrag
    }

    function select(index, showTriad = true) {
        editing = showTriad;
        if (!points[index]) return;
        selected = index;
        handle.position.copy(points[index].position);
        if (active) transform.attach(handle);
        updateUI();
        syncVisibility();
    }


    // The three parts of one attachment point, from the current design's templates.
    function partClone(kind) {
        const look = { capsule: [0xec9b45, 0.55], attachment: [0x2baca4, 1] }[kind];
        const source = templates?.[kind];
        const clone = source ? styledClone(source, look[0], look[1]) : new THREE.Group();
        clone.name = kind;
        return clone;
    }
    function rebuildAssembly(point) {
        clearOwnedObjects(point.assembly);
        point.capsule = partClone('capsule');
        point.attachment = partClone('attachment');
        point.assembly.add(point.capsule, point.attachment);
    }

    function createPoint() {
        const assembly = new THREE.Group();
        const marker = new THREE.Mesh(new THREE.SphereGeometry(0.0018, 16, 12),
            new THREE.MeshBasicMaterial({ color: 0xfdb515 }));
        marker.userData.measureSurface = false;
        marker.userData.attachmentIndex = points.length;
        const arrow = new THREE.ArrowHelper(new THREE.Vector3(0, 0, 1), new THREE.Vector3(), 0.019, 0x2d9bf0, 0.005, 0.003);
        keepOverlayVisible(marker, 125);
        keepOverlayVisible(arrow, 124);
        root.add(assembly, marker, arrow);
        const point = { assembly, capsule: null, attachment: null, marker, arrow, placed: false,
            position: new THREE.Vector3(), normal: new THREE.Vector3(0, 0, 1), capsuleVisible: true, attachmentVisible: true };
        rebuildAssembly(point);
        points.push(point);
        // New points sit at the world origin (0, 0, 0) until they are typed, dragged, or picked onto the surface.
        place(points.length - 1, new THREE.Vector3(), new THREE.Vector3(0, 0, 1), false);

    }
    function renderList() {
        const list = document.getElementById('attachment-point-list');
        list.replaceChildren();
        points.forEach((point, index) => {
            point.marker.userData.attachmentIndex = index;
            const row = document.createElement('div');
            row.className = 'attachment-point-row';
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'attachment-remove';
            remove.textContent = '−';
            remove.setAttribute('aria-label', `Remove point ${index}`);
            remove.addEventListener('click', () => {
                transform.detach();
                for (const object of [point.assembly, point.marker, point.arrow]) {
                    root.remove(object);
                    object.traverse(child => { child.material?.dispose(); });
                }
                point.marker.geometry.dispose();
                points.splice(index, 1);
                selected = Math.max(0, Math.min(selected > index ? selected - 1 : selected, points.length - 1));
                renderList();
                status.textContent = `${points.length} attachment points ready`;
                if (points.length) select(selected); else { editing = false; updateUI(); syncVisibility(); }
                emit('remove');
            });
            const label = document.createElement('button');
            label.type = 'button';
            label.dataset.holeSelect = index;
            label.innerHTML = `<svg class="ntop-point" aria-hidden="true"><use href="#ntop-point-icon"/></svg><span>${index}:</span>`;
            label.setAttribute('aria-label', `Select point ${index}`);
            label.addEventListener('click', () => select(index));
            row.append(remove, label);
            for (const axis of ['x', 'y', 'z']) {
                const input = document.createElement('input');
                input.type = 'number';
                input.step = 'any';
                input.dataset.pointIndex = index;
                input.dataset.pointCoordinate = axis;
                input.setAttribute('aria-label', `Point ${index} ${axis.toUpperCase()}`);
                input.value = formatMm(point.position[axis]);
                input.addEventListener('focus', () => select(index));
                const commit = () => {
                    if (input.value !== '' && Number.isFinite(+input.value)) {
                        const query = point.position.clone();
                        query[axis] = +input.value / 1000;
                        snap(index, query);
                    }
                    input.value = formatMm(point.position[axis]);
                };
                input.addEventListener('change', commit);
                input.addEventListener('keydown', event => { if (event.key === 'Enter') { commit(); input.blur(); } });
                row.append(input);
            }
            const units = document.createElement('small'); units.textContent = 'mm'; row.append(units);
            list.append(row);
        });
        updateUI();
    }
    document.getElementById('attachment-add').addEventListener('click', () => {
        if (!templates || !bounds) return;
        createPoint();
        renderList();
        select(points.length - 1);
        document.querySelector(`[data-point-index="${selected}"]`)?.focus();
    });

    function rebuild(surfaceSource, animalSource) {
        if (!templates || !surfaceSource.children.length) return;
        sourceMesh = surfaceSource;
        sourceAnimal = animalSource;
        clearOwnedObjects(surface);
        clearOwnedObjects(animal);
        surface.add(styledClone(surfaceSource, 0x8d98a7, 0.8));
        animal.add(styledClone(animalSource, 0xb99c75, 0.15));
        surface.updateMatrixWorld(true);
        bounds = new THREE.Box3().setFromObject(surface);
        triangles = collectSurfaceTriangles(surface);
        if (!initialized) {
            // Only point 0 exists to begin with; the student adds the rest with the + button.
            createPoint();
            initialized = true;
        }
        renderList();
        // Points already placed follow the new surface; unplaced ones stay at the origin.
        points.forEach((point, index) => { if (point.placed) snap(index, point.position.clone(), false); });
        select(selected, false);
        status.textContent = `${points.length} attachment points ready`;
        emit('rebuild');
    }

    function setPicking(value) {
        picking = value;
        pickButton.classList.toggle('active', value);
        pickButton.setAttribute('aria-pressed', String(value));
        canvas.style.cursor = value ? 'crosshair' : '';
        if (value) status.textContent = `Select a surface position for point ${selected}`;
        syncVisibility();
    }

    // Steps 5 and 6 show the placed attachments on the assembly without the surface, markers or tools.
    function setPreview(value) {
        preview = value;
        root.visible = active || preview;
        syncVisibility();
    }

    function setActive(value, surfaceSource, animalSource) {
        active = value;
        preview = false;
        root.visible = value;
        toolbar.hidden = !value;
        if (!value) {
            if (picking) setPicking(false);
            return;
        }
        if (sourceMesh !== surfaceSource || sourceAnimal !== animalSource || !initialized) rebuild(surfaceSource, animalSource);
        select(selected, false);
    }

    document.querySelectorAll('[data-hole-part]').forEach(button => {
        button.addEventListener('click', () => {
            if (!points.length) return;
            const key = `${button.dataset.holePart}Visible`;
            points[selected][key] = !points[selected][key];
            syncVisibility();
            updateUI();
        });
    });
    document.querySelectorAll('[data-hole-layer]').forEach(button => {
        button.setAttribute('aria-pressed', 'true');
        const highlight = enabled => {
            const key = button.dataset.holeLayer;
            const targets = key === 'surface' ? [surface] : key === 'animal' ? [animal]
                : key === 'points' ? [] : points.map(point => point[key]);
            targets.forEach(target => target.traverse(object => {
                if (!object.material?.emissive) return;
                object.material.emissive.setHex(enabled ? 0xfdb515 : 0x000000);
                object.material.emissiveIntensity = enabled ? 0.6 : 0;
            }));
        };
        button.addEventListener('pointerenter', () => highlight(true));
        button.addEventListener('pointerleave', () => highlight(false));
        button.addEventListener('focus', () => highlight(true));
        button.addEventListener('blur', () => highlight(false));
        button.addEventListener('click', () => {
            const key = button.dataset.holeLayer;
            visibility[key] = !visibility[key];
            button.classList.toggle('active', visibility[key]);
            button.setAttribute('aria-pressed', String(visibility[key]));
            button.setAttribute('aria-label', `${visibility[key] ? 'Hide' : 'Show'} ${button.textContent.trim().toLowerCase()}`);
            syncVisibility();
        });
    });
    pickButton.addEventListener('click', () => { if (active && points.length && !isMeasuring()) setPicking(!picking); });
    document.addEventListener('keydown', event => { if (event.key === 'Escape' && active) setPicking(false); });
    transform.addEventListener('objectChange', () => {
        if (!active || !transform.dragging || dragFrame) return;
        dragFrame = requestAnimationFrame(() => {
            dragFrame = null;
            if (active && transform.dragging) snap(selected, handle.position, false);
        });
    });
    canvas.addEventListener('pointerdown', event => {
        if (active && event.button === 0 && !isMeasuring()) down = { x: event.clientX, y: event.clientY, gizmo: !!transform.axis };
    });
    canvas.addEventListener('pointerup', event => {
        const start = down;
        down = null;
        if (!active || !start || start.gizmo || isMeasuring() || event.button !== 0 || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5) return;
        const rect = canvas.getBoundingClientRect();
        pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
        raycaster.setFromCamera(pointer, camera);
        if (picking) {
            if (!surface.visible) return;
            const hit = raycaster.intersectObject(surface, true)[0];
            if (hit) { snap(selected, hit.point); setPicking(false); }
        } else if (visibility.points) {
            const hit = raycaster.intersectObjects(points.map(point => point.marker))[0];
            if (hit) select(hit.object.userData.attachmentIndex);
        }
    });

    return { root, ready, rebuild, setActive, setPreview, syncVisibility, setDesign, designExists,
        get design() { return design; },
        // Where the student put the points, in millimetres, for the comparison in Step 6.
        getPoints: () => points.map(point => ({
            placed: point.placed,
            position: [point.position.x * 1000, point.position.y * 1000, point.position.z * 1000],
        })),
        finishDrag: () => { if (active) snap(selected, handle.position); },
        cancelPicking: () => setPicking(false),
        measurementRoots: () => [surface, animal, ...points.map(point => point.assembly)],
        onChange: fn => listeners.add(fn),
    };
}
