import * as THREE from 'three';

// nTop-style viewer navigation: orbit about the picked point, view cube, and the intro coach.

const ACTIONS = [
    {
        key: 'orbit', title: 'Orbit',
        mouse: 'Right-click and drag',
        pad: '<kbd>Alt</kbd> + click and drag',
        touch: 'Drag with one finger',
        note: 'A pink dot marks the spot you clicked. The view turns around that spot.',
        touchNote: 'The view turns around the model.',
    },
    {
        key: 'pan', title: 'Pan',
        mouse: 'Press the wheel (middle-click) and drag',
        pad: '<kbd>Shift</kbd> + click and drag',
        touch: 'Drag with two fingers',
        note: 'Slides the view without turning it.',
        touchNote: 'Slides the view without turning it.',
    },
    {
        key: 'zoom', title: 'Zoom',
        mouse: 'Scroll the wheel',
        pad: 'Two-finger scroll or pinch',
        touch: 'Pinch with two fingers',
        note: 'Zooms toward the pointer.',
        touchNote: 'Spread to zoom in, pinch to zoom out.',
    },
];

const COACH_SEEN_KEY = 'gap-viewer-coach-seen';
const COACH_WAVE_MS = 4200;

const MOUSE_SVG = `
<svg class="ctl-mouse" viewBox="0 0 60 90" aria-hidden="true">
    <rect class="ctl-mouse-body" x="6" y="4" width="48" height="82" rx="24"/>
    <path class="ctl-mouse-left" d="M30 4 A24 24 0 0 0 6 28 V38 H30 Z"/>
    <path class="ctl-mouse-right" d="M30 4 A24 24 0 0 1 54 28 V38 H30 Z"/>
    <rect class="ctl-mouse-wheel" x="26" y="13" width="8" height="18" rx="4"/>
</svg>`;

const TRACKPAD_SVG = `
<svg class="ctl-pad" viewBox="0 0 96 66" aria-hidden="true">
    <rect class="ctl-pad-body" x="3" y="3" width="90" height="60" rx="8"/>
    <circle class="ctl-pad-finger ctl-pad-finger-a" cx="48" cy="33" r="7"/>
    <circle class="ctl-pad-finger ctl-pad-finger-b" cx="48" cy="33" r="7"/>
</svg>`;

const TOUCH_SVG = `
<svg class="ctl-touch" viewBox="0 0 64 96" aria-hidden="true">
    <rect class="ctl-touch-body" x="3" y="3" width="58" height="90" rx="9"/>
    <rect class="ctl-touch-screen" x="8" y="12" width="48" height="70" rx="3"/>
    <circle class="ctl-pad-finger ctl-pad-finger-a" cx="32" cy="47" r="7"/>
    <circle class="ctl-pad-finger ctl-pad-finger-b" cx="32" cy="47" r="7"/>
</svg>`;

function element(tag, className, html) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (html !== undefined) node.innerHTML = html;
    return node;
}

function isTouchDevice() {
    return window.matchMedia('(pointer: coarse)').matches && !window.matchMedia('(hover: hover)').matches;
}

function actionCardHTML(action, touch) {
    if (touch) {
        return `
            <div class="ctl-art" data-action="${action.key}" data-input="touch">
                <figure><div class="ctl-art-frame">${TOUCH_SVG}</div><figcaption>Touch screen</figcaption></figure>
            </div>
            <h3>${action.title}</h3>`;
    }
    const padKey = action.key === 'orbit' ? '<kbd>Alt</kbd>' : action.key === 'pan' ? '<kbd>Shift</kbd>' : '';
    return `
        <div class="ctl-art" data-action="${action.key}">
            <figure><div class="ctl-art-frame">${MOUSE_SVG}</div><figcaption>Mouse</figcaption></figure>
            <figure><div class="ctl-art-frame">${TRACKPAD_SVG}${padKey}</div><figcaption>Trackpad</figcaption></figure>
        </div>
        <h3>${action.title}</h3>`;
}

function readSeen() {
    try { return localStorage.getItem(COACH_SEEN_KEY) === '1'; } catch { return false; }
}

function writeSeen() {
    try { localStorage.setItem(COACH_SEEN_KEY, '1'); } catch { /* storage unavailable */ }
}

// One pane's nTop-style navigation and view cube, without the intro coach. The walkthrough's split
// view makes a second one of these for its right-hand pane. `hooks` lets a host follow the gestures.
export function createPaneView({ camera, controls, canvas, stage, cubeWrap, cubeCanvas, axisColors, pickMeshes, isGizmoHovered = () => false, hooks = {} }) {
    const host = { pauseDemo() {}, userNavigated() {}, gestureEnded() {}, currentKey: () => 'pan', ...hooks };
    controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.PAN, RIGHT: null };
    controls.zoomToCursor = true;

    // ---- Camera moves -------------------------------------------------------------------------

    function orbitAround(pivot, dx, dy) {
        const speed = (2 * Math.PI) / Math.max(canvas.clientHeight, 1);
        const offset = camera.position.clone().sub(controls.target);
        const polar = offset.angleTo(camera.up);
        const nextPolar = THREE.MathUtils.clamp(polar - dy * speed, 0.01, Math.PI - 0.01);
        const right = new THREE.Vector3().crossVectors(camera.up, offset).normalize();
        const rotation = new THREE.Quaternion().setFromAxisAngle(camera.up, -dx * speed)
            .multiply(new THREE.Quaternion().setFromAxisAngle(right, nextPolar - polar));
        camera.position.sub(pivot).applyQuaternion(rotation).add(pivot);
        controls.target.sub(pivot).applyQuaternion(rotation).add(pivot);
        camera.lookAt(controls.target);
    }

    function panBy(dx, dy) {
        const distance = camera.position.distanceTo(controls.target);
        const worldPerPixel = 2 * distance * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) / Math.max(canvas.clientHeight, 1);
        const move = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 0).multiplyScalar(-dx * worldPerPixel)
            .addScaledVector(new THREE.Vector3().setFromMatrixColumn(camera.matrix, 1), dy * worldPerPixel);
        camera.position.add(move);
        controls.target.add(move);
    }

    function dollyBy(scale) {
        camera.position.sub(controls.target).multiplyScalar(scale).add(controls.target);
    }

    // ---- Pointer navigation -------------------------------------------------------------------

    const pivotEl = element('span', 'orbit-pivot');
    pivotEl.hidden = true;
    stage.append(pivotEl);
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let drag = null;
    let snap = null;

    function stagePoint(clientX, clientY) {
        const rect = stage.getBoundingClientRect();
        return { x: clientX - rect.left, y: clientY - rect.top };
    }

    function showPivotAt(x, y) {
        pivotEl.style.left = x + 'px';
        pivotEl.style.top = y + 'px';
        pivotEl.hidden = false;
    }

    function pickPivot(event) {
        const rect = canvas.getBoundingClientRect();
        pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
        raycaster.setFromCamera(pointer, camera);
        const hit = raycaster.intersectObjects(pickMeshes(), false)[0];
        if (hit) return hit.point.clone();
        // Nothing under the pointer: use the point on the pick ray nearest the current view target.
        return raycaster.ray.closestPointToPoint(controls.target, new THREE.Vector3());
    }

    canvas.addEventListener('mousedown', event => {
        // Stops the browser's middle-click autoscroll from taking over the pan drag.
        if (event.button === 1) event.preventDefault();
    });
    canvas.addEventListener('pointerdown', event => {
        host.pauseDemo();
        if (event.pointerType === 'touch' || !controls.enabled) return;
        const modified = event.button === 0 && (event.shiftKey || event.altKey);
        if (modified && isGizmoHovered()) return;
        const mode = event.button === 2 ? 'orbit' : !modified ? null : event.shiftKey ? 'pan' : 'orbit';
        if (event.button === 1) host.userNavigated('pan');
        if (!mode) return;
        event.preventDefault();
        snap = null;
        drag = { mode, id: event.pointerId, x: event.clientX, y: event.clientY, pivot: null };
        if (mode === 'orbit') {
            drag.pivot = pickPivot(event);
            const point = stagePoint(event.clientX, event.clientY);
            showPivotAt(point.x, point.y);
        }
        try { canvas.setPointerCapture(event.pointerId); } catch { /* pointer already released */ }
        stage.classList.add('is-navigating');
    });
    canvas.addEventListener('pointermove', event => {
        if (!drag || event.pointerId !== drag.id) return;
        const dx = event.clientX - drag.x;
        const dy = event.clientY - drag.y;
        drag.x = event.clientX;
        drag.y = event.clientY;
        if (!dx && !dy) return;
        if (drag.mode === 'orbit') orbitAround(drag.pivot, dx, dy);
        else panBy(dx, dy);
        host.userNavigated(drag.mode);
    });
    function endDrag(event) {
        if (event.pointerType === 'touch') { endTouch(event); return; }
        if (event.button === 1 && event.type === 'pointerup') host.gestureEnded('pan');
        if (!drag || event.pointerId !== drag.id) return;
        const mode = drag.mode;
        drag = null;
        pivotEl.hidden = true;
        stage.classList.remove('is-navigating');
        host.gestureEnded(mode);
    }
    // Touch gestures are handled by OrbitControls; count fingers to tell the coach what was tried.
    const touchPointers = new Set();
    let maxTouches = 0;
    canvas.addEventListener('pointerdown', event => {
        if (event.pointerType !== 'touch') return;
        touchPointers.add(event.pointerId);
        maxTouches = Math.max(maxTouches, touchPointers.size);
        if (touchPointers.size >= 2) host.userNavigated(host.currentKey() === 'zoom' ? 'zoom' : 'pan');
        else host.userNavigated('orbit');
    });
    function endTouch(event) {
        touchPointers.delete(event.pointerId);
        if (touchPointers.size) return;
        const fingers = maxTouches;
        maxTouches = 0;
        host.gestureEnded(fingers >= 2 ? (host.currentKey() === 'zoom' ? 'zoom' : 'pan') : 'orbit');
    }
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);
    let wheelTimer = null;
    canvas.addEventListener('wheel', () => {
        host.pauseDemo();
        host.userNavigated('zoom');
        clearTimeout(wheelTimer);
        wheelTimer = setTimeout(() => host.gestureEnded('zoom'), 450);
    }, { passive: true });

    // ---- View cube ----------------------------------------------------------------------------

    const cubeRenderer = new THREE.WebGLRenderer({ canvas: cubeCanvas, antialias: true, alpha: true });
    cubeRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    cubeRenderer.setSize(cubeCanvas.clientWidth || 128, cubeCanvas.clientHeight || 128, false);
    cubeRenderer.outputColorSpace = THREE.SRGBColorSpace;
    const cubeScene = new THREE.Scene();
    const cubeCamera = new THREE.OrthographicCamera(-1.5, 1.5, 1.5, -1.5, 0.1, 50);
    const cubeCenter = new THREE.Vector3(0.22, 0.22, 0.22);
    const cubeTargets = []; // faces, edges, and corners, each with a snap direction

    function faceTexture(label) {
        const faceCanvas = document.createElement('canvas');
        faceCanvas.width = faceCanvas.height = 192;
        const context = faceCanvas.getContext('2d');
        context.fillStyle = '#56626f';
        context.fillRect(0, 0, 192, 192);
        context.strokeStyle = '#8b97a4';
        context.lineWidth = 8;
        context.strokeRect(4, 4, 184, 184);
        context.fillStyle = '#ffffff';
        context.font = '700 ' + (label.length > 5 ? 36 : 42) + 'px Inter, Arial, sans-serif';
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        context.fillText(label, 96, 100);
        const texture = new THREE.CanvasTexture(faceCanvas);
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.anisotropy = 4;
        return texture;
    }

    // nTop naming: +X right, +Y back, +Z top.
    [
        ['RIGHT', [1, 0, 0], [0, 0, 1]], ['LEFT', [-1, 0, 0], [0, 0, 1]],
        ['BACK', [0, 1, 0], [0, 0, 1]], ['FRONT', [0, -1, 0], [0, 0, 1]],
        ['TOP', [0, 0, 1], [0, 1, 0]], ['BOTTOM', [0, 0, -1], [0, -1, 0]],
    ].forEach(([label, normalValues, upValues]) => {
        const normal = new THREE.Vector3(...normalValues);
        const up = new THREE.Vector3(...upValues);
        const face = new THREE.Mesh(
            new THREE.PlaneGeometry(1, 1),
            new THREE.MeshBasicMaterial({ map: faceTexture(label), toneMapped: false }),
        );
        face.position.copy(normal).multiplyScalar(0.5);
        face.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3().crossVectors(up, normal), up, normal));
        face.userData = { kind: 'face', label, direction: normal.clone(), up };
        cubeTargets.push(face);
        cubeScene.add(face);
    });

    // Edge and corner hit zones sit just proud of the cube and light up on hover, like nTop's cube.
    const zoneMaterial = () => new THREE.MeshBasicMaterial({ color: 0xffc95c, transparent: true, opacity: 0, toneMapped: false, depthWrite: false });
    const zoneThickness = 0.17;
    const signs = [-1, 1];
    for (let axis = 0; axis < 3; axis++) {
        const [a, b] = [(axis + 1) % 3, (axis + 2) % 3];
        signs.forEach(sa => signs.forEach(sb => {
            const size = [0, 0, 0];
            size[axis] = 1 - zoneThickness * 2;
            size[a] = size[b] = zoneThickness;
            const edge = new THREE.Mesh(new THREE.BoxGeometry(...size), zoneMaterial());
            edge.position.setComponent(a, sa * 0.5).setComponent(b, sb * 0.5);
            const direction = new THREE.Vector3().setComponent(a, sa).setComponent(b, sb).normalize();
            edge.userData = { kind: 'edge', label: 'edge', direction };
            cubeTargets.push(edge);
            cubeScene.add(edge);
        }));
    }
    signs.forEach(sx => signs.forEach(sy => signs.forEach(sz => {
        const corner = new THREE.Mesh(new THREE.BoxGeometry(zoneThickness, zoneThickness, zoneThickness), zoneMaterial());
        corner.position.set(sx * 0.5, sy * 0.5, sz * 0.5);
        corner.userData = { kind: 'corner', label: 'corner', direction: new THREE.Vector3(sx, sy, sz).normalize() };
        cubeTargets.push(corner);
        cubeScene.add(corner);
    })));

    ['x', 'y', 'z'].forEach((key, index) => {
        const direction = new THREE.Vector3().setComponent(index, 1);
        const corner = new THREE.Vector3(-0.5, -0.5, -0.5);
        const axis = new THREE.Mesh(
            new THREE.CylinderGeometry(0.028, 0.028, 1.5, 12),
            new THREE.MeshBasicMaterial({ color: axisColors[key], toneMapped: false }),
        );
        axis.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
        axis.position.copy(corner).addScaledVector(direction, 0.75);
        const labelCanvas = document.createElement('canvas');
        labelCanvas.width = labelCanvas.height = 64;
        const context = labelCanvas.getContext('2d');
        context.font = '700 46px Inter, Arial, sans-serif';
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        context.fillStyle = '#' + axisColors[key].toString(16).padStart(6, '0');
        context.fillText(key.toUpperCase(), 32, 35);
        const texture = new THREE.CanvasTexture(labelCanvas);
        texture.colorSpace = THREE.SRGBColorSpace;
        const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false }));
        label.position.copy(corner).addScaledVector(direction, 1.74);
        label.scale.setScalar(0.5);
        cubeScene.add(axis, label);
    });

    const cubeRaycaster = new THREE.Raycaster();
    let hoveredTarget = null;
    let cubeDrag = null;
    let cubeDirty = true;
    const lastCameraQuaternion = new THREE.Quaternion();

    function cubeTargetAt(event) {
        const rect = cubeCanvas.getBoundingClientRect();
        pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
        cubeRaycaster.setFromCamera(pointer, cubeCamera);
        return cubeRaycaster.intersectObjects(cubeTargets, false)[0]?.object || null;
    }

    function setHoveredTarget(target) {
        if (target === hoveredTarget) return;
        if (hoveredTarget) {
            if (hoveredTarget.userData.kind === 'face') hoveredTarget.material.color.setHex(0xffffff);
            else hoveredTarget.material.opacity = 0;
        }
        hoveredTarget = target;
        if (hoveredTarget) {
            if (hoveredTarget.userData.kind === 'face') hoveredTarget.material.color.setHex(0xffc95c);
            else hoveredTarget.material.opacity = 0.9;
        }
        cubeCanvas.style.cursor = target ? 'pointer' : 'grab';
        cubeCanvas.title = target ? (target.userData.kind === 'face' ? target.userData.label + ' view' : 'Look along this ' + target.userData.kind) : '';
        cubeDirty = true;
    }

    function startSnap(rotation) {
        snap = { start: performance.now(), from: camera.position.clone().sub(controls.target), rotation };
    }

    function snapToDirection(direction, up) {
        const from = camera.position.clone().sub(controls.target).normalize();
        // A slight tilt keeps the top and bottom views from lining up exactly with the up axis.
        const to = direction.clone();
        if (up && Math.abs(direction.z) > 0.999) to.addScaledVector(up, -1e-4);
        startSnap(new THREE.Quaternion().setFromUnitVectors(from, to.normalize()));
    }

    function spinView(angle) {
        startSnap(new THREE.Quaternion().setFromAxisAngle(camera.up, angle));
    }

    cubeCanvas.addEventListener('pointerdown', event => {
        if (event.button !== 0) return;
        host.pauseDemo();
        cubeDrag = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
        try { cubeCanvas.setPointerCapture(event.pointerId); } catch { /* pointer already released */ }
    });
    cubeCanvas.addEventListener('pointermove', event => {
        if (!cubeDrag) {
            setHoveredTarget(cubeTargetAt(event));
            return;
        }
        if (event.pointerId !== cubeDrag.id) return;
        const dx = event.clientX - cubeDrag.x;
        const dy = event.clientY - cubeDrag.y;
        if (!cubeDrag.moved && Math.hypot(dx, dy) < 4) return;
        cubeDrag.moved = true;
        cubeDrag.x = event.clientX;
        cubeDrag.y = event.clientY;
        snap = null;
        orbitAround(controls.target.clone(), dx * 2.5, dy * 2.5);
        host.userNavigated('orbit');
    });
    cubeCanvas.addEventListener('pointerup', event => {
        if (!cubeDrag || event.pointerId !== cubeDrag.id) return;
        const wasClick = !cubeDrag.moved;
        if (!wasClick) host.gestureEnded('orbit');
        cubeDrag = null;
        const target = wasClick && cubeTargetAt(event);
        if (target) snapToDirection(target.userData.direction, target.userData.up);
    });
    cubeCanvas.addEventListener('pointercancel', () => { cubeDrag = null; });
    cubeCanvas.addEventListener('pointerleave', () => { if (!cubeDrag) setHoveredTarget(null); });
    cubeCanvas.addEventListener('contextmenu', event => event.preventDefault());
    cubeWrap.querySelectorAll('[data-spin-view]').forEach(button => {
        button.addEventListener('click', () => spinView(THREE.MathUtils.degToRad(+button.dataset.spinView)));
    });

    function updateCube(now) {
        if (snap) {
            const t = Math.min((now - snap.start) / 380, 1);
            const eased = t * t * (3 - 2 * t);
            const rotation = new THREE.Quaternion().slerp(snap.rotation, eased);
            camera.position.copy(snap.from).applyQuaternion(rotation).add(controls.target);
            camera.lookAt(controls.target);
            if (t >= 1) snap = null;
        }
        if (cubeWrap.hidden) return;
        if (!cubeDirty && lastCameraQuaternion.equals(camera.quaternion)) return;
        lastCameraQuaternion.copy(camera.quaternion);
        cubeDirty = false;
        cubeCamera.quaternion.copy(camera.quaternion);
        cubeCamera.position.set(0, 0, 10).applyQuaternion(camera.quaternion).add(cubeCenter);
        cubeCamera.updateMatrixWorld(true);
        cubeRenderer.render(cubeScene, cubeCamera);
    }

    function setCubeVisible(visible) {
        cubeWrap.hidden = !visible;
        cubeDirty = true;
    }

    return {
        orbitAround, panBy, dollyBy, showPivotAt,
        hidePivot() { pivotEl.hidden = true; },
        update: updateCube,
        setCubeVisible,
        dispose() { cubeRenderer.dispose(); cubeRenderer.forceContextLoss(); },
    };
}

export function createViewerControls({ camera, controls, canvas, stage, cubeWrap, cubeCanvas, helpButton, axisColors, pickMeshes, isGizmoHovered, frameView, dismissible = false, collapseTarget = null }) {
    let coach = null;
    const pane = createPaneView({
        camera, controls, canvas, stage, cubeWrap, cubeCanvas, axisColors, pickMeshes, isGizmoHovered,
        hooks: {
            pauseDemo: () => coach.pauseDemo(),
            userNavigated: kind => coach.userNavigated(kind),
            gestureEnded: kind => coach.gestureEnded(kind),
            currentKey: () => coach.currentKey(),
        },
    });
    const { orbitAround, panBy, dollyBy, showPivotAt } = pane;

    document.addEventListener('keydown', event => {
        if (event.key.toLowerCase() !== 'f' || event.ctrlKey || event.metaKey || event.altKey) return;
        if (event.target.closest('input, select, textarea, [contenteditable], dialog')) return;
        frameView();
    });

    // ---- Intro coach --------------------------------------------------------------------------

    const coachEl = element('aside', 'controls-coach');
    coachEl.hidden = true;
    coachEl.setAttribute('aria-label', 'How to move the 3D view');
    coachEl.innerHTML = `
        ${dismissible ? '<button type="button" class="controls-coach-close" title="Hide (the How to move button brings it back)" aria-label="Hide">&times;</button>' : ''}
        <div class="ctl-card" data-coach-card></div>
        <div class="controls-coach-foot">
            <div class="controls-coach-dots" role="group" aria-label="Choose a control">
                ${ACTIONS.map((action, index) => `<button type="button" data-coach-slide="${index}" aria-label="Show ${action.title.toLowerCase()}"></button>`).join('')}
            </div>
            <button type="button" class="controls-coach-done">Got it</button>
        </div>`;
    const cursorEl = element('span', 'controls-coach-cursor', '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3l14 8-6 1.6L9.6 19z"/></svg>');
    cursorEl.hidden = true;
    stage.append(coachEl, cursorEl);

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    coach = {
        active: false, demo: false, moved: false, slide: 0, slideStart: 0, previous: 0, touch: false, tried: new Set(), advanceTimer: null,
        currentKey() { return ACTIONS[coach.slide].key; },
        start() {
            clearTimeout(coach.advanceTimer);
            coachEl.classList.remove('is-collapsing');
            coachEl.style.transform = '';
            coach.active = true;
            coach.touch = isTouchDevice();
            coach.demo = !reducedMotion.matches;
            coach.moved = false;
            coach.tried.clear();
            coachEl.hidden = false;
            coach.show(0);
        },
        show(index) {
            clearTimeout(coach.advanceTimer);
            coach.slide = index;
            coach.slideStart = performance.now();
            coach.previous = 0;
            coach.demo = !reducedMotion.matches;
            coachEl.querySelector('[data-coach-card]').innerHTML = actionCardHTML(ACTIONS[index], coach.touch);
            coachEl.querySelectorAll('[data-coach-slide]').forEach((dot, dotIndex) => dot.classList.toggle('active', dotIndex === index));
            coachEl.querySelector('.controls-coach-done').textContent = index === ACTIONS.length - 1 ? 'Got it' : 'Got it, next';
            coach.markTried();
            pane.hidePivot();
        },
        markTried() {
            const title = coachEl.querySelector('h3');
            if (title) title.classList.toggle('is-tried', coach.tried.has(ACTIONS[coach.slide].key));
        },
        pauseDemo() {
            if (!coach.demo) return;
            coach.demo = false;
            cursorEl.hidden = true;
            pane.hidePivot();
        },
        userNavigated(kind) {
            coach.moved = false;
            if (!coach.active) return;
            coach.tried.add(kind);
            coach.markTried();
        },
        // Releasing the gesture the current slide teaches moves on to the next slide.
        gestureEnded(kind) {
            if (!coach.active || kind !== coach.currentKey() || coach.slide >= ACTIONS.length - 1) return;
            coach.tried.add(kind);
            coach.markTried();
            clearTimeout(coach.advanceTimer);
            const slide = coach.slide;
            coach.advanceTimer = setTimeout(() => { if (coach.active && coach.slide === slide) coach.show(slide + 1); }, 1400);
        },
        next() {
            if (coach.slide < ACTIONS.length - 1) coach.show(coach.slide + 1);
            else coach.close(true, { collapse: true });
        },
        close(restoreView, { collapse = false } = {}) {
            if (!coach.active) return;
            clearTimeout(coach.advanceTimer);
            const demoMoved = coach.moved;
            coach.pauseDemo();
            coach.active = false;
            writeSeen();
            if (restoreView && demoMoved) frameView();
            if (!collapse || reducedMotion.matches) { coachEl.hidden = true; return; }
            // Shrink the card into the controls button so the student knows where the intro lives.
            const card = coachEl.getBoundingClientRect();
            // The guide shrinks into the button that brings it back (a page can supply its own).
            const into = collapseTarget?.() || helpButton;
            const target = into.getBoundingClientRect();
            const dx = (target.left + target.width / 2) - (card.left + card.width / 2);
            const dy = (target.top + target.height / 2) - (card.top + card.height / 2);
            coachEl.classList.add('is-collapsing');
            void coachEl.offsetWidth; // commit the starting frame before the transform changes
            coachEl.style.transform = `translate(${dx}px, ${dy}px) scale(0.05)`;
            const finish = () => {
                coachEl.removeEventListener('transitionend', finish);
                coachEl.hidden = true;
                coachEl.classList.remove('is-collapsing');
                coachEl.style.transform = '';
                into.classList.remove('is-pulsing');
                void into.offsetWidth;
                into.classList.add('is-pulsing');
                setTimeout(() => into.classList.remove('is-pulsing'), 2200);
            };
            coachEl.addEventListener('transitionend', finish);
            setTimeout(() => { if (coachEl.classList.contains('is-collapsing')) finish(); }, 900);
        },
        update(now) {
            if (!coach.active || !coach.demo) return;
            // The demo loops one full wave per cycle, so the view returns to where it started.
            let t = (now - coach.slideStart) / COACH_WAVE_MS;
            if (t >= 1) {
                coach.slideStart = now;
                t = 0;
            }
            const wave = Math.sin(t * 2 * Math.PI);
            const delta = wave - coach.previous;
            coach.previous = wave;
            coach.moved = true;
            const center = { x: stage.clientWidth / 2, y: stage.clientHeight / 2 };
            const action = ACTIONS[coach.slide].key;
            let cursor = center;
            if (action === 'orbit') {
                orbitAround(controls.target.clone(), delta * 110, 0);
                if (!coach.touch) showPivotAt(center.x, center.y);
                cursor = { x: center.x + wave * 110, y: center.y };
            } else if (action === 'pan') {
                panBy(delta * 70, delta * 30);
                cursor = { x: center.x + wave * 70, y: center.y + wave * 30 };
            } else {
                dollyBy(Math.exp(delta * 0.22));
                cursor = { x: center.x, y: center.y + wave * 26 };
            }
            cursorEl.dataset.action = action;
            cursorEl.classList.toggle('is-touch', coach.touch);
            cursorEl.style.left = cursor.x + 'px';
            cursorEl.style.top = cursor.y + 'px';
            cursorEl.hidden = false;
        },
    };
    coachEl.querySelector('.controls-coach-done').addEventListener('click', () => coach.next());
    coachEl.querySelector('.controls-coach-close')?.addEventListener('click', () => coach.close(true, { collapse: true }));
    coachEl.querySelectorAll('[data-coach-slide]').forEach(dot => {
        dot.addEventListener('click', () => coach.show(+dot.dataset.coachSlide));
    });
    helpButton.addEventListener('click', () => {
        if (coach.active) coach.show(0);
        else coach.start();
    });

    return {
        update(now = performance.now()) {
            coach.update(now);
            pane.update(now);
        },
        setCubeVisible: pane.setCubeVisible,
        startIntro({ force = false } = {}) {
            if (force || !readSeen()) coach.start();
        },
        // For hosts that let another controller own a gesture (the review page orbits on plain
        // left-drag through OrbitControls): tell the coach the student did it.
        noteNavigation(kind) { coach.userNavigated(kind); },
        noteGestureEnd(kind) { coach.gestureEnded(kind); },
        // Frees the view cube's WebGL context when a host tears its viewer down.
        dispose() { pane.dispose(); },
    };
}
