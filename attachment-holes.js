import * as THREE from 'three';

export function createAttachmentHoles({ scene, camera, canvas, transform, transformHelper,
    loadGLB, collectSurfaceTriangles, closestSurfacePoint, keepOverlayVisible, isMeasuring }) {
    const root = new THREE.Group();
    const surface = new THREE.Group();
    const animal = new THREE.Group();
    const handle = new THREE.Object3D();
    const points = [];
    const visibility = { surface: true, animal: true, capsule: true, boundary: true, points: true };
    const status = document.getElementById('attachment-hole-status');
    const toolbar = document.getElementById('attachment-overlay-controls');
    const pickButton = document.getElementById('attachment-pick');
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let active = false;
    let selected = 0;
    let picking = false;
    let bounds;
    let triangles = [];
    let sourceMesh = null;
    let sourceAnimal = null;
    let templates;
    let down;
    let dragFrame = null;
    root.add(surface, animal, handle);
    root.visible = false;
    scene.add(root);

    const assetVersions = { Capsule: 2, AttachBdry: 1 };
    const ready = Promise.all(['Capsule', 'AttachBdry'].map(name =>
        loadGLB(`sample-models/attachment-holes/${name}.glb?v=${assetVersions[name]}`))).then(models => {
        templates = models.map(model => model.scene);
        templates.forEach(template => template.traverse(object => {
            if (object.isMesh && !object.geometry.hasAttribute('normal')) object.geometry.computeVertexNormals();
        }));
        status.textContent = 'Attachment models ready';
    }).catch(error => {
        status.textContent = 'Attachment models could not be loaded. Refresh to retry.';
        console.error(error);
    });

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

    function updateUI() {
        const point = points[selected];
        if (!point) return;
        document.getElementById('attachment-point-title').textContent = `Point ${selected + 1}`;
        document.querySelectorAll('[data-hole-coordinate]').forEach(input => {
            input.value = (point.position[input.dataset.holeCoordinate] * 1000).toFixed(2);
        });
        document.getElementById('attachment-normal').textContent = point.normal.toArray().map(v => v.toFixed(3)).join(', ');
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
        surface.visible = visibility.surface;
        animal.visible = visibility.animal;
        points.forEach((point, index) => {
            point.capsule.visible = visibility.capsule && point.capsuleVisible;
            point.boundary.visible = visibility.boundary && point.boundaryVisible;
            point.marker.visible = visibility.points;
            point.arrow.visible = visibility.points && index === selected;
            point.marker.material.color.setHex(index === selected ? 0xfdb515 : 0x203951);
            point.marker.scale.setScalar(index === selected ? 1.3 : 1);
        });
        if (active) {
            transform.enabled = !!points.length && !picking && !isMeasuring() && visibility.points;
            transformHelper.visible = transform.enabled;
        }
    }

    function snap(index, query, moveHandle = true) {
        const point = points[index];
        if (!point || !triangles.length) return;
        const nearest = closestSurfacePoint(query, triangles, bounds);
        point.position.copy(nearest.point);
        point.normal.copy(nearest.normal);
        point.assembly.position.copy(nearest.point);
        // The exported assets are centered without changing their original local axes.
        point.assembly.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), nearest.normal);
        point.marker.position.copy(nearest.point);
        point.arrow.position.copy(nearest.point);
        point.arrow.setDirection(nearest.normal);
        if (index === selected && moveHandle) handle.position.copy(nearest.point);
        if (index === selected) updateUI();
        status.textContent = `Point ${index + 1} snapped to attachment surface`;
    }

    function select(index) {
        if (!points[index]) return;
        selected = index;
        handle.position.copy(points[index].position);
        if (active) transform.attach(handle);
        updateUI();
        syncVisibility();
    }

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
        const center = bounds.getCenter(new THREE.Vector3());
        const size = bounds.getSize(new THREE.Vector3());
        if (!points.length) {
            const list = document.getElementById('attachment-point-list');
            for (let index = 0; index < 6; index++) {
                const capsule = styledClone(templates[0], 0xec9b45);
                const boundary = styledClone(templates[1], 0x2baca4);
                const assembly = new THREE.Group();
                assembly.add(capsule, boundary);
                const marker = new THREE.Mesh(new THREE.SphereGeometry(0.0018, 16, 12),
                    new THREE.MeshBasicMaterial({ color: 0xfdb515 }));
                marker.userData.measureSurface = false;
                marker.userData.attachmentIndex = index;
                const arrow = new THREE.ArrowHelper(new THREE.Vector3(0, 0, 1), new THREE.Vector3(), 0.019, 0x2d9bf0, 0.005, 0.003);
                keepOverlayVisible(marker, 125);
                keepOverlayVisible(arrow, 124);
                root.add(assembly, marker, arrow);
                points.push({ assembly, capsule, boundary, marker, arrow,
                    position: new THREE.Vector3(), normal: new THREE.Vector3(), capsuleVisible: true, boundaryVisible: true });
                const button = document.createElement('button');
                button.type = 'button';
                button.dataset.holeSelect = String(index);
                button.textContent = String(index + 1);
                button.setAttribute('aria-label', `Select attachment point ${index + 1}`);
                button.addEventListener('click', () => select(index));
                list.append(button);
            }
        }
        points.forEach((point, index) => {
            // Six editable starting positions around the upper attachment surface.
            const angle = index * Math.PI / 3 + Math.PI / 6;
            snap(index, new THREE.Vector3(center.x + Math.cos(angle) * size.x * 0.65,
                center.y + Math.sin(angle) * size.y * 0.65, bounds.min.z + size.z * 0.72));
        });
        select(selected);
        status.textContent = '6 attachment points ready';
    }

    function setPicking(value) {
        picking = value;
        pickButton.classList.toggle('active', value);
        pickButton.setAttribute('aria-pressed', String(value));
        canvas.style.cursor = value ? 'crosshair' : '';
        if (value) status.textContent = `Select a surface position for point ${selected + 1}`;
        syncVisibility();
    }

    function setActive(value, surfaceSource, animalSource) {
        active = value;
        root.visible = value;
        toolbar.hidden = !value;
        if (!value) {
            if (picking) setPicking(false);
            return;
        }
        if (sourceMesh !== surfaceSource || sourceAnimal !== animalSource || !points.length) rebuild(surfaceSource, animalSource);
        select(selected);
    }

    document.querySelectorAll('[data-hole-coordinate]').forEach(input => {
        let pending;
        const commit = (index = selected, value = input.value) => {
            clearTimeout(pending);
            if (!points[index] || !value || !Number.isFinite(Number(value))) { updateUI(); return; }
            const query = points[index].position.clone();
            query[input.dataset.holeCoordinate] = Number(value) / 1000;
            snap(index, query);
        };
        input.addEventListener('input', () => {
            clearTimeout(pending);
            const index = selected;
            const value = input.value;
            pending = setTimeout(() => commit(index, value), 500);
        });
        input.addEventListener('change', () => commit());
        input.addEventListener('keydown', event => { if (event.key === 'Enter') commit(); });
    });
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

    return { root, ready, rebuild, setActive, syncVisibility,
        finishDrag: () => { if (active) snap(selected, handle.position); },
        cancelPicking: () => setPicking(false),
        measurementRoots: () => [surface, animal, ...points.map(point => point.assembly)],
    };
}
