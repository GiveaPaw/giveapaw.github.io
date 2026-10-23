import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { withModelFallback, modelUrl } from './model-base.js?v=2';
import { createAttachmentHoles } from './attachment-holes.js?v=19';
import { createViewerControls, createPaneView } from './viewer-controls.js?v=9';
import { createWalkthroughNotes } from './walkthrough-notes.js?v=5';
import { ROLES as IMPORT_ROLES, BREEDS as IMPORT_BREEDS, filesForRole, folderEntries, startFolder, resolve as resolveImportPath, formatBytes } from './import-catalog.js?v=10';

const app = document.getElementById('workflow-app');
if (!app) throw new Error('Socket workflow container is missing.');

const stage = document.getElementById('workflow-stage');
const canvas = document.getElementById('workflow-canvas');
const loaderEl = document.getElementById('workflow-loader');
const overlayControlsEl = document.getElementById('workflow-overlay-controls');
const interfaceOverlayControlsEl = document.getElementById('interface-overlay-controls');
const viewerStepEl = document.getElementById('viewer-step');
const viewerTitleEl = document.getElementById('viewer-title');

// ---- views that are not the step's own ---------------------------------------------------------
// The scale comparison, an answer plane, one attachment on its own: each replaces what the step
// would normally show, and each used to be left a different way. They now share one look, so a
// student who learns to leave one has learned to leave all of them: the viewer is framed in amber,
// a card in the free corner names the mode, and Done (or Esc) puts the step back.
const viewerModeFrame = document.getElementById('viewer-mode-frame');
const viewerModeCard = document.getElementById('viewer-mode-card');
const viewerModeName = document.getElementById('viewer-mode-name');
const viewerModeText = document.getElementById('viewer-mode-text');
const viewerModeDoneButton = document.getElementById('viewer-mode-done');
const viewerModes = new Map();

function setViewerMode(key, info) {
    if (info) viewerModes.set(key, info);
    else viewerModes.delete(key);
    renderViewerMode();
}

// The viewer is its own stacking context and the notes sheet is fixed above it, so while that sheet
// is up the card cannot be lifted over it from inside the viewer: it moves out to the page column,
// where its z-index counts against the sheet, and goes back to the corner of the view afterwards.
const viewerModeNarrow = matchMedia('(max-width: 880px)');
const workflowAppEl = document.getElementById('workflow-app');
const viewerModeHome = document.getElementById('workflow-stage');

function placeViewerModeCard() {
    const notesOpen = !workflowAppEl.classList.contains('notes-hidden');
    const parent = viewerModeNarrow.matches && notesOpen ? workflowAppEl : viewerModeHome;
    if (viewerModeCard.parentElement !== parent) parent.appendChild(viewerModeCard);
}

viewerModeNarrow.addEventListener('change', placeViewerModeCard);
new MutationObserver(placeViewerModeCard).observe(workflowAppEl, { attributeFilter: ['class'] });

function renderViewerMode() {
    const [mode] = [...viewerModes.values()];
    placeViewerModeCard();
    viewerModeFrame.hidden = viewerModeCard.hidden = !mode;
    if (!mode) return;
    viewerModeName.textContent = mode.name;
    viewerModeText.textContent = mode.text;
    viewerModeDoneButton.title = `Leave ${mode.name.toLowerCase()} and go back to the step`;
}

function leaveViewerMode() {
    const [mode] = [...viewerModes.values()];
    if (mode) mode.done();
}

viewerModeDoneButton.addEventListener('click', leaveViewerMode);
document.addEventListener('keydown', event => {
    // Esc belongs to the pen while it is drawing; the mode takes it the rest of the time.
    if (event.key !== 'Escape' || !viewerModes.size) return;
    if (walkthroughNotes?.isDrawing?.()) return;
    leaveViewerMode();
});
const resizerEl = document.getElementById('workflow-resizer');
const measureButtonEl = document.getElementById('measure-tool');
const measurePanelEl = document.getElementById('measure-panel');
const measureStatusEl = document.getElementById('measure-status');
const measureValueEl = document.getElementById('measure-value');
const measureUnitEl = document.getElementById('measure-unit');

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xf2f5f7);

const NTOP_AXIS_COLORS = {
    x: 0xff5364,
    y: 0x35c95d,
    z: 0x2d9bf0,
};

const camera = new THREE.PerspectiveCamera(34, 1, 0.001, 10000);
camera.up.set(0, 0, 1);
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.07;
controls.screenSpacePanning = true;

scene.add(new THREE.HemisphereLight(0xffffff, 0x6f7884, 1.55));
const keyLight = new THREE.DirectionalLight(0xffffff, 2.2);
keyLight.position.set(-2, -3, 4);
keyLight.castShadow = true;
scene.add(keyLight);
const rimLight = new THREE.DirectionalLight(0xffe7bd, 0.85);
rimLight.position.set(3, 1, 2);
scene.add(rimLight);

// GridHelper lies in XZ by default; rotate it into the other two world planes.
const gridPlanes = { xy: [Math.PI / 2, 0, 0], xz: [0, 0, 0], yz: [0, 0, Math.PI / 2] };
Object.entries(gridPlanes).forEach(([key, rotation]) => {
    const plane = new THREE.GridHelper(2.4, 24, 0xaeb8c4, 0xd8dee5);
    plane.rotation.set(...rotation);
    plane.material.transparent = true;
    plane.material.opacity = 0.58;
    plane.material.depthWrite = false;
    plane.visible = key === 'xy';
    scene.add(plane);
    gridPlanes[key] = plane;
});

const importRoot = new THREE.Group();
const planeRoot = new THREE.Group();
const interfaceRoot = new THREE.Group();
const measurementRoot = new THREE.Group();
scene.add(importRoot, planeRoot, interfaceRoot, measurementRoot);

// Every Import Mesh node starts empty: the student browses to the file, as they would in nTop.
// The colours here are the same four in PART_COLOR below, which every other stage reads from.
const layers = {
    solidAnimal: {
        role: 'solidAnimal', label: 'Solid animal', color: '#496b94', group: new THREE.Group(), visible: true,
        file: null, type: null, opacity: 1, baseUnit: 'm', importUnit: 'm', scalable: true,
    },
    attachment: {
        role: 'attachment', label: 'Attachment mesh', color: '#169c8c', group: new THREE.Group(), visible: true,
        file: null, type: null, opacity: 0.88, baseUnit: 'm', importUnit: 'm', scalable: true,
    },
    mechanical: {
        role: 'mechanical', label: 'Mechanical interface', color: '#df7544', group: new THREE.Group(), visible: false,
        file: null, type: null, opacity: 1, baseUnit: 'mm', importUnit: 'mm',
    },
    solidInterface: {
        role: 'solidInterface', label: 'Solid interface', color: '#6750a4', group: new THREE.Group(), visible: false,
        file: null, type: null, opacity: 1, baseUnit: 'mm', importUnit: 'mm',
    },
};
Object.values(layers).forEach(layer => {
    layer.group.visible = layer.visible;
    importRoot.add(layer.group);
});

// Step ids follow the nTop notebook (10-13): 1 import and scale; 2a interface position, 2b pelvic
// plane, 2c interface plane, 2d position interface; 3 socket latticing; 4a attachment points,
// 4b hole parameters; 5 blending; 6 export. The 3D stages are shared: 2b and 3 draw the pelvic
// scene, 2a / 2c / 2d / 5 / 6 the interface scene, and 4a / 4b the attachment holes.
const PELVIC_STEPS = ['2a', '3'];
const INTERFACE_STEPS = ['2c', '2b', '2d', '5', '6'];
const ATTACHMENT_STEPS = ['4a', '4b'];
const BLEND_STEPS = ['5', '6'];
const isPelvicStep = step => PELVIC_STEPS.includes(step);
const isInterfaceStep = step => INTERFACE_STEPS.includes(step);
const isAttachmentStep = step => ATTACHMENT_STEPS.includes(step);

// Each Import Mesh node points at one catalog entry; see import-catalog.js for the folder layout.
const importSelection = {
    solidAnimal: null,
    attachment: null,
    mechanical: null,
    solidInterface: null,
};
const IMPORT_ROLE_KEYS = ['solidAnimal', 'attachment', 'mechanical', 'solidInterface'];
const importedCount = () => IMPORT_ROLE_KEYS.filter(role => importSelection[role]).length;
const importsReady = () => importedCount() === IMPORT_ROLE_KEYS.length;
// Which case was imported decides where the sockets come from (socketSetDir, blendSetDir): Ollie's 10-22
// sets were generated on the Low surface; the wheelchair case has its own.

const pelvicBody = new THREE.Group();
const pelvicAttach = new THREE.Group();
const socketPreviewRoot = new THREE.Group();
const overlayRoot = new THREE.Group();
planeRoot.add(pelvicBody, pelvicAttach, socketPreviewRoot, overlayRoot);

const overlayGroups = {
    box: new THREE.Group(),
    point: new THREE.Group(),
    normal: new THREE.Group(),
    plane: new THREE.Group(),
};
Object.values(overlayGroups).forEach(group => overlayRoot.add(group));

const planeLayerTargets = {
    attach: pelvicAttach,
    body: pelvicBody,
    socket: socketPreviewRoot,
    ...overlayGroups,
};
const planeLayerVisibility = Object.fromEntries(Object.keys(planeLayerTargets).map(key => [key, true]));

const interfaceAnimal = new THREE.Group();
const interfaceReferenceMechanical = new THREE.Group();
const orientedAssembly = new THREE.Group();
const interfaceMechanical = new THREE.Group();
const interfaceSolid = new THREE.Group();
const interfaceOverlayRoot = new THREE.Group();
const finalSocketRoot = new THREE.Group(); // Step 5's blended socket (see blendSetDir)
finalSocketRoot.name = 'final-socket';
orientedAssembly.add(interfaceMechanical, interfaceSolid);
interfaceRoot.add(interfaceAnimal, interfaceReferenceMechanical, orientedAssembly, interfaceOverlayRoot, finalSocketRoot);

const interfaceOverlayGroups = {
    box: new THREE.Group(),
    point: new THREE.Group(),
    normal: new THREE.Group(),
    plane: new THREE.Group(),
    target: new THREE.Group(),
    surfaceNormal: new THREE.Group(),
    frame: new THREE.Group(),
};
Object.values(interfaceOverlayGroups).forEach(group => interfaceOverlayRoot.add(group));

const interfaceLayerTargets = {
    reference: interfaceReferenceMechanical,
    animal: interfaceAnimal,
    mechanical: interfaceMechanical,
    solid: interfaceSolid,
    ...interfaceOverlayGroups,
};
interfaceLayerTargets.socket = socketPreviewRoot;
let positionMechanicalVisible = false;
const interfaceLayerVisibility = Object.fromEntries(Object.keys(interfaceLayerTargets).map(key => [key, true]));
// Step 2d keeps its own visibility so it can open on the mechanical interface alone.
const orientationLayerVisibility = { animal: true, mechanical: true, solid: false, socket: false, target: false };
// Steps 5 and 6 show the blended assembly: animal, socket and both oriented interfaces.
const blendLayerVisibility = { animal: true, mechanical: true, solid: true, socket: true, target: false };
// Step 3 is a pelvic stage, but the lattice is easier to judge with the interface it meets, so it
// borrows the oriented mechanical interface from the interface scene.
const socketStepLayerVisibility = { mechanical: true };

function interfaceLayerVisibleIn(stage, key) {
    if (stage === '3') return key === 'mechanical' ? socketStepLayerVisibility.mechanical : false;
    // The socket is built in Step 3, so Step 2 does not show it.
    if (key === 'socket' && (stage === '2b' || stage === '2c' || stage === '2d')) return false;
    if (stage === '2c' && key === 'mechanical') return positionMechanicalVisible;
    if (stage === '2d' && key in orientationLayerVisibility) return orientationLayerVisibility[key];
    if (BLEND_STEPS.includes(stage) && key in blendLayerVisibility) return blendLayerVisibility[key];
    return interfaceLayerVisibility[key];
}

function interfaceLayerVisible(key) {
    return interfaceLayerVisibleIn(activeStep, key);
}

// Split view shows Step 2c (left, main canvas) beside Step 2b (right, second canvas). The second
// pane is created the first time it is used.
const SPLIT_STEPS = ['2c', '2b'];
const splitNarrow = window.matchMedia('(max-width: 880px)');
let splitEnabled = false;
let splitFramed = false;
let splitReturnStep = '2c';

function splitPaired(step) {
    return splitEnabled && !splitNarrow.matches && SPLIT_STEPS.includes(step);
}

function setInterfaceLayerVisible(key, visible) {
    if (activeStep === '3' && key in socketStepLayerVisibility) socketStepLayerVisibility[key] = visible;
    else if (activeStep === '2c' && key === 'mechanical') positionMechanicalVisible = visible;
    else if (activeStep === '2d' && key in orientationLayerVisibility) orientationLayerVisibility[key] = visible;
    else if (BLEND_STEPS.includes(activeStep) && key in blendLayerVisibility) blendLayerVisibility[key] = visible;
    else interfaceLayerVisibility[key] = visible;
}
const interfaceLayerGroups = {
    mechSolid: ['mechanical', 'solid'],
    interfacePlane: ['point', 'normal', 'plane'],
};

const positionTransform = new TransformControls(camera, canvas);
positionTransform.setMode('translate');
positionTransform.setSpace('world');
positionTransform.setSize(0.82);
const positionTransformHelper = positionTransform.getHelper();
scene.add(positionTransformHelper);

function simplifyPositionTransformGizmo() {
    const transformGizmo = positionTransform._gizmo;
    if (!transformGizmo) return;
    const centerHandles = new Set(['XYZ']);
    const axisComponents = { X: 'x', Y: 'y', Z: 'z' };
    [transformGizmo.gizmo.translate, transformGizmo.picker.translate].forEach(group => {
        [...group.children].forEach(handle => {
            if (centerHandles.has(handle.name)) {
                group.remove(handle);
                return;
            }
            const component = axisComponents[handle.name];
            if (!component || !handle.geometry) return;
            handle.geometry.computeBoundingBox();
            const center = handle.geometry.boundingBox.getCenter(new THREE.Vector3());
            if (center[component] < -0.05) group.remove(handle);
        });
    });
}
simplifyPositionTransformGizmo();

positionTransformHelper.traverse(object => {
    if (!object.material) return;
    const axis = object.name.toLowerCase();
    const color = { x: NTOP_AXIS_COLORS.x, y: NTOP_AXIS_COLORS.y, z: NTOP_AXIS_COLORS.z,
        xy: NTOP_AXIS_COLORS.z, yz: NTOP_AXIS_COLORS.x, xz: NTOP_AXIS_COLORS.y }[axis];
    if (color === undefined) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    materials.forEach(material => {
        if (!material.color) return;
        material.color.setHex(color);
        if (material._color) material._color.setHex(color);
        material.depthTest = false;
        material.depthWrite = false;
        material.transparent = true;
        material.needsUpdate = true;
    });
    object.renderOrder = 120;
});
positionTransform.addEventListener('dragging-changed', event => {
    controls.enabled = !event.value;
    if (isAttachmentStep(activeStep)) {
        if (!event.value) attachmentHoles.finishDrag();
        return;
    }
    if (!event.value && targetHandle) {
        interfacePositionFollowsPlane = false;
        setInterfacePositionFromQuery(targetHandle.position);
    }
});


const draco = new DRACOLoader();
draco.setDecoderPath('https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/libs/draco/');
const gltfLoader = new GLTFLoader();
gltfLoader.setDRACOLoader(draco);
const stlLoader = new STLLoader();
const objLoader = new OBJLoader();

// Sweep files come from the model bucket when model-base.js names one, else from the site.
const loadGLB = withModelFallback(file => new Promise((resolve, reject) => gltfLoader.load(file, resolve, undefined, reject)));
const loadSTL = withModelFallback(file => new Promise((resolve, reject) => stlLoader.load(file, resolve, undefined, reject)));
const loadOBJ = withModelFallback(file => new Promise((resolve, reject) => objLoader.load(file, resolve, undefined, reject)));

function normalizeMillimeterExport(object) {
    const box = new THREE.Box3().setFromObject(object);
    if (box.getSize(new THREE.Vector3()).length() > 10) object.scale.setScalar(0.001);
}

const UNIT_TO_METERS = { m: 1, cm: 0.01, mm: 0.001, in: 0.0254 };

// Step 1 "Scale Factor": the nTop Imports block scales the animal scan (not the interfaces) by it.
let scaleFactor = 0.95; // the 10-13 notebook's value; the 10-15 socket sweeps were run at it

// Step 1 only. The interfaces are modelled about the origin, which sits inside the animal, so on
// their own they would be hidden inside it the moment they were switched on. Both are moved clear of
// the animal by the same amount, which keeps them on top of each other exactly as they are modelled:
// the solid interface is the mechanical one's solid, so toggling between the two has to compare like
// with like. Moving them apart would make that comparison meaningless.
const PREVIEW_INTERFACES = ['mechanical', 'solidInterface'];

function layoutImportPreview() {
    const animal = layers.solidAnimal;
    PREVIEW_INTERFACES.forEach(key => layers[key].group.position.set(0, 0, 0));
    if (!animal.group.children.length) return;
    animal.group.updateMatrixWorld(true);
    const animalBox = new THREE.Box3().setFromObject(animal.group);
    if (animalBox.isEmpty()) return;

    // One box around both interfaces as they sit, so the shift that clears the animal is the same
    // for each and whatever offset they have from one another is kept.
    const together = new THREE.Box3();
    PREVIEW_INTERFACES.forEach(key => {
        const group = layers[key].group;
        if (!group.children.length) return;
        group.updateMatrixWorld(true);
        together.union(new THREE.Box3().setFromObject(group));
    });
    if (together.isEmpty()) return;

    const gap = Math.max(animalBox.getSize(new THREE.Vector3()).x * 0.08, 0.02);
    const shift = new THREE.Vector3(
        animalBox.max.x + gap - together.min.x,
        animalBox.getCenter(new THREE.Vector3()).y - together.getCenter(new THREE.Vector3()).y,
        animalBox.min.z - together.min.z,           // standing on the same ground as the animal
    );
    PREVIEW_INTERFACES.forEach(key => {
        const group = layers[key].group;
        if (!group.children.length) return;
        group.position.copy(shift);
        group.updateMatrixWorld(true);
    });
}

function applyImportUnitScale(layer) {
    const base = UNIT_TO_METERS[layer.baseUnit] || 1;
    const selected = UNIT_TO_METERS[layer.importUnit] || base;
    layer.group.scale.setScalar(selected / base * (layer.scalable ? scaleFactor : 1));
    layer.group.updateMatrixWorld(true);
}

// The attachment surface is cut from the scan, so the two meshes sit on exactly the same skin and
// the depth buffer cannot choose between them: that is the speckled mess. Pushing the solid animal
// a touch further away in depth settles every one of those ties in the surface's favour.
// The surface is a decimated cut of the scan, so it does not merely touch the skin, it weaves
// through it; a small bias is not enough. The surface is pulled well forward and the animal pushed
// back, which is enough to cover the decimation error.
const BEHIND = { polygonOffset: true, polygonOffsetFactor: 4, polygonOffsetUnits: 8 };
const IN_FRONT = { polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -12 };

// The attachment surface is a decimated cut of the scan, so it does not merely touch the skin, it
// weaves through it by a few tenths of a millimetre. A depth bias cannot cover that, so the surface
// is lifted off the skin along its own normals once, when it loads. Every later clone shares this
// geometry, so one lift serves the whole walkthrough. Half a millimetre on a 180 mm dog.
// Drawn late, after the plane and its outline, so only the overlays come after it; they do not
// depth test anyway. SURFACE_ORDER - 1 is where the depth buffer is cleared.
const SURFACE_ORDER = 25;

// A mesh that draws nothing and clears the depth buffer when its turn comes. three.js has no
// per-object way to say "ignore that one object", so this marks a point in the render order
// instead: everything already drawn stops occluding, everything after it carries on normally.
function depthClearer(renderOrder) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
    // transparent on purpose. three.js draws every opaque object before any transparent one, so an
    // opaque clearer would fire at the end of the opaque pass and wipe the body's depth before the
    // grid and the plane are drawn: they would then show straight through the animal. In the
    // transparent pass it fires after them and before the surface, which is the only gap wanted.
    const clearer = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
        colorWrite: false, depthWrite: false, depthTest: false, transparent: true, opacity: 0,
    }));
    clearer.frustumCulled = false;
    clearer.renderOrder = renderOrder;
    // A depth clear is masked by the depth-write mask, and three.js only resets that mask at the
    // start of a frame. onBeforeRender runs before the clearer's own material state is applied, so
    // the mask is whatever the previous transparent object left: with depthWrite off it is false,
    // and the clear silently does nothing. That is what made the surface look right from most
    // angles and ragged from the rest. The mask is switched on here first.
    clearer.onBeforeRender = renderer => {
        renderer.state.buffers.depth.setMask(true);
        renderer.clearDepth();
    };
    return clearer;
}

// Put a surface over whatever has been drawn so far, keeping its own shading.
function showOverTheBody(group, renderOrder = SURFACE_ORDER) {
    group.traverse(child => {
        if (!child.isMesh || child.userData.depthClearer) return;
        child.renderOrder = renderOrder;
        // It has to write depth even though it is see-through. Once the buffer is cleared there is
        // nothing left to sort these triangles against each other, and a surface that curves right
        // round, as the wheelchair cut does, draws its near and far faces in whatever order they
        // happen to come in: the speckled mess. The flatter cuts barely show it, which is why this
        // only looked broken on one case.
        //
        // The flag is what makes it stick. applyLayerAlphas rewrites depthWrite from the opacity on
        // every step change and every see-through toggle, and it undid this the moment a student
        // left Step 1; it now leaves these meshes' depth alone.
        child.userData.overTheBody = true;
        if (child.material) {
            child.material.depthWrite = true;
            // And it has to stay in the transparent pass whatever its opacity. The clearer lives
            // there; an opaque surface is drawn in the opaque pass before the clearer runs, and is
            // back to losing to the body. The see-through button sets the surface to 1, which is
            // exactly how that happened.
            child.material.transparent = true;
        }
    });
    if (!group.children.some(child => child.userData.depthClearer)) {
        const clearer = depthClearer(renderOrder - 1);
        clearer.userData.depthClearer = true;
        clearer.userData.fixedAlpha = true;   // the alpha pass must not touch it either
        group.add(clearer);
    }
}

function liftOffTheSkin(geometry, millimetres) {
    const position = geometry.attributes.position;
    const normal = geometry.attributes.normal;
    if (!position || !normal) return;
    for (let i = 0; i < position.count; i++) {
        position.setXYZ(i,
            position.getX(i) + normal.getX(i) * millimetres,
            position.getY(i) + normal.getY(i) * millimetres,
            position.getZ(i) + normal.getZ(i) * millimetres);
    }
    position.needsUpdate = true;
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
}

function prepareObject(object, layer) {
    normalizeMillimeterExport(object);
    object.traverse(child => {
        if (!child.isMesh) return;
        child.geometry.computeVertexNormals();
        if (layer.role === 'attachment') liftOffTheSkin(child.geometry, 0.5);
        child.material = new THREE.MeshStandardMaterial({ dithering: true,
            color: layer.color,
            roughness: 0.72,
            metalness: layer.role === 'mechanical' ? 0.15 : 0,
            transparent: layer.opacity < 1,
            opacity: layer.opacity,
            depthWrite: layer.opacity >= 1,
            side: THREE.DoubleSide,
            // The solid interface is the mechanical one's solid, so the two share faces wherever they
            // are both shown. Settling that tie behind the mechanical part keeps the detailed one
            // readable instead of the pair speckling against each other.
            ...(layer.role === 'solidAnimal' || layer.role === 'solidInterface' ? BEHIND
                : layer.role === 'attachment' ? IN_FRONT : {}),
        });
        child.castShadow = layer.opacity >= 0.8;
        child.receiveShadow = true;
        child.userData.measureSurface = true;
    });
    layer.group.add(object);
}

async function loadImportLayer(layer) {
    if (layer.type === 'stl') {
        const geometry = await loadSTL(layer.file);
        prepareObject(new THREE.Mesh(geometry), layer);
        return;
    }
    if (layer.type === 'obj') {
        const object = await loadOBJ(layer.file);
        prepareObject(object, layer);
        return;
    }
    const gltf = await loadGLB(layer.file);
    prepareObject(gltf.scene, layer);
}

async function replaceImportLayer(key, model) {
    const layer = layers[key];
    if (!layer) return;
    const requestId = (layer.requestId || 0) + 1;
    layer.requestId = requestId;
    const temporaryLayer = { ...layer, file: model.file, type: model.type, group: new THREE.Group() };
    await loadImportLayer(temporaryLayer);
    if (layer.requestId !== requestId) return;
    layer.group.clear();
    while (temporaryLayer.group.children.length) layer.group.add(temporaryLayer.group.children[0]);
    layer.file = model.file;
    layer.type = model.type;
    applyImportUnitScale(layer);
    layer.group.visible = layer.visible && activeStep === '1';
    const select = document.querySelector('[data-import-unit="' + key + '"]');
    if (select) select.value = layer.importUnit;
}

// One colour per part, used in every stage. The import layers above take theirs from here too.
const PART_COLOR = {
    solidAnimal: 0x496b94,   // the scan
    attachment: 0x169c8c,    // the socket surface cut from it
    mechanical: 0xdf7544,    // the mechanical interface
    solidInterface: 0x6750a4, // the solid interface
};

function applyBakedShading(geometry, baseColor) {
    const normals = geometry.getAttribute('normal');
    const keyDirection = new THREE.Vector3(0.35, -0.55, 0.76).normalize();
    const fillDirection = new THREE.Vector3(-0.72, 0.28, 0.63).normalize();
    const base = new THREE.Color(baseColor);
    const colors = new Float32Array(normals.count * 3);
    const normal = new THREE.Vector3();

    for (let i = 0; i < normals.count; i++) {
        normal.fromBufferAttribute(normals, i).normalize();
        const shade = 0.67
            + 0.24 * Math.max(0, normal.dot(keyDirection))
            + 0.09 * Math.max(0, normal.dot(fillDirection));
        colors[i * 3] = base.r * shade;
        colors[i * 3 + 1] = base.g * shade;
        colors[i * 3 + 2] = base.b * shade;
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

function preparePelvic(gltf, target, materialConfig) {
    const object = gltf.scene;
    normalizeMillimeterExport(object);
    object.traverse(child => {
        if (!child.isMesh) return;
        child.geometry.computeVertexNormals();
        if (materialConfig.bakedShading) applyBakedShading(child.geometry, materialConfig.color);
        const sharedOptions = {
            color: materialConfig.bakedShading ? 0xffffff : materialConfig.color,
            transparent: materialConfig.forceTransparent || materialConfig.opacity < 1,
            opacity: materialConfig.opacity,
            depthWrite: materialConfig.opacity >= 1,
            side: THREE.DoubleSide,
        };
        child.material = materialConfig.bakedShading
            ? new THREE.MeshBasicMaterial({ ...sharedOptions, vertexColors: true, toneMapped: false })
            : materialConfig.unlit
                ? new THREE.MeshBasicMaterial({ ...sharedOptions, toneMapped: false })
            : new THREE.MeshStandardMaterial({ dithering: true, ...sharedOptions, roughness: 0.82 });
        child.renderOrder = materialConfig.renderOrder || 0;
    });
    target.add(object);
}

// Step 3 sockets come from the 10-22 nTop sweeps (tools/convert_1022_sweeps.py), one set per case and
// Spatial Weight Type: the thickness pair (Min <= Max, 0..20 mm each) at weighting 0.6 / 32 points, and
// the density pair (weighting 0..1 x point density 1, 5..100) at thickness 6 / 12. Moving a slider in one
// pair puts the other pair back at those baseline values, because that is the only combination that was
// generated. 32 is the notebook's own density, so it is on the slider even though the density sweep
// steps by 5: at weighting 0.6 it is the thickness sweep's 6 / 12 socket, elsewhere it falls to 30.
const socketParameterState = { minThickness: 6, maxThickness: 12, spatialWeighting: 0.6, pointDensity: 32 };
const parameterValues = {
    minThickness: Array.from({ length: 21 }, (_, index) => index),
    maxThickness: Array.from({ length: 21 }, (_, index) => index),
    spatialWeighting: Array.from({ length: 11 }, (_, index) => index / 10),
    pointDensity: [1, 5, 10, 15, 20, 25, 30, 32, ...Array.from({ length: 14 }, (_, index) => 35 + index * 5)],
};
const socketParameterDefaults = { minThickness: 6, maxThickness: 12, spatialWeighting: 0.6, pointDensity: 32 };
const SWEEP_GROUPS = { thickness: ['minThickness', 'maxThickness'], density: ['spatialWeighting', 'pointDensity'] };
const sweepGroupOf = key => Object.keys(SWEEP_GROUPS).find(group => SWEEP_GROUPS[group].includes(key));
// The value the student last chose on each Step 3 slider and which ones they changed. Read by the expert grading panel.
const socketParameterChoices = { ...socketParameterDefaults };

// CB - Socket Lattice v1.0.11 added two menus. Spatial Weight Type was swept: Ollie in both types, the
// wheelchair case in Point & Curve only (its notebook errors on 2 Curves). Continuity was only run at
// Geometric (G0), so other continuities are recorded for grading while the preview stays on G0.
// Each case starts on the type its notebook was saved with.
const socketChoiceDefaults = { spatialWeightType: '2-curves', continuity: 'g0' };
const socketChoiceState = { ...socketChoiceDefaults };
const SOCKET_CHOICE_LABEL = {
    spatialWeightType: { '2-curves': '2 Curves', 'point-curve': 'Point & Curve' },
    continuity: { g0: 'Geometric (G0)', g1: 'Tangent (G1)', g2: 'Curvature (G2)' },
};
const isWheelchairCase = () => importSelection.solidAnimal?.blendSet === 'wheelchair'
    || importSelection.attachment?.blendSet === 'wheelchair';
const caseSpatialWeightTypes = () => (isWheelchairCase() ? ['point-curve'] : ['2-curves', 'point-curve']);
const caseSpatialWeightDefault = () => (isWheelchairCase() ? 'point-curve' : '2-curves');
// The folder of Step 3 sockets for the case and the chosen Spatial Weight Type.
function socketSetDir() {
    const type = socketChoiceState.spatialWeightType === 'point-curve' ? 'pc' : '2c';
    return isWheelchairCase() ? 'sample-models/chi-wc-socket-1022/pc' : `sample-models/ollie-socket-1022/${type}`;
}

function syncSocketChoiceNote() {
    const note = document.getElementById('socket-choice-note');
    if (!note) return;
    const off = socketChoiceState.continuity !== socketChoiceDefaults.continuity;
    note.hidden = !off;
    if (!off) return;
    note.textContent = `The socket on screen is the generated sweep, which was run with Geometric (G0) continuity. ${SOCKET_CHOICE_LABEL.continuity[socketChoiceState.continuity]} is recorded, but no mesh for it is on the site yet.`;
}

// Offer only the types the case was generated in, and move to the case's own type when the case changes.
function syncSpatialWeightTypeChoices({ resetToDefault = false } = {}) {
    const select = document.querySelector('[data-socket-choice="spatialWeightType"]');
    if (!select) return;
    const allowed = caseSpatialWeightTypes();
    [...select.options].forEach(option => {
        option.disabled = !allowed.includes(option.value);
        option.title = option.disabled ? 'Not generated for this case: its notebook errors on 2 Curves.' : '';
    });
    if (resetToDefault || !allowed.includes(socketChoiceState.spatialWeightType)) socketChoiceState.spatialWeightType = caseSpatialWeightDefault();
    select.value = socketChoiceState.spatialWeightType;
}

document.querySelectorAll('[data-socket-choice]').forEach(select => {
    select.addEventListener('change', () => {
        socketChoiceState[select.dataset.socketChoice] = select.value;
        syncSocketChoiceNote();
        // Spatial Weight Type picks a different generated set, so the socket in view changes with it.
        if (select.dataset.socketChoice === 'spatialWeightType') loadSocketParameterModel(activeSocketParameter, socketParameterState[activeSocketParameter]);
    });
});
syncSpatialWeightTypeChoices({ resetToDefault: true });
const socketParameterTouched = new Set();
const socketParameterModelMeta = {
    minThickness: { label: 'min lattice thickness', unit: ' mm' },
    maxThickness: { label: 'max lattice thickness', unit: ' mm' },
    spatialWeighting: { label: 'spatial weighting', unit: '' },
    pointDensity: { label: 'lattice point density', unit: '' },
};
const socketModelPromises = new Map();
let socketModelRequest = 0;
let activeSocketParameter = 'pointDensity';
let currentSocketFile = null; // the nTop mesh in the viewer; Step 6 exports it
const PELVIC_PLANE_PRESETS = {
    'x-min': { label: 'X minimum face', pick: [0, 1, 1], normal: [1, 0, 0] },
    'x-max': { label: 'X maximum face', pick: [2, 1, 1], normal: [-1, 0, 0] },
    'y-min': { label: 'Y minimum face', pick: [1, 0, 1], normal: [0, 1, 0] },
    'y-max': { label: 'Y maximum face', pick: [1, 2, 1], normal: [0, -1, 0] },
    'z-min': { label: 'Z minimum face', pick: [1, 1, 0], normal: [0, 0, 1] },
    'z-max': { label: 'Z maximum face', pick: [1, 1, 2], normal: [0, 0, -1] },
};
let activePelvicPlanePreset = 'y-max';
let activePelvicPlaneAxis = 1;

function cloneImportForPelvic(key, target, materialConfig) {
    const clone = layers[key].group.clone(true);
    clone.position.set(0, 0, 0);   // see cloneForInterface
    clone.traverse(child => {
        if (!child.isMesh) return;
        child.material = new THREE.MeshStandardMaterial({ dithering: true,
            color: materialConfig.color,
            roughness: materialConfig.roughness ?? 0.78,
            metalness: 0,
            transparent: materialConfig.opacity < 1,
            opacity: materialConfig.opacity,
            depthWrite: materialConfig.opacity >= 0.72,
            side: THREE.DoubleSide,
            ...(key === 'solidAnimal' ? BEHIND : key === 'attachment' ? IN_FRONT : {}),
        });
        child.castShadow = materialConfig.opacity >= 0.7;
        child.receiveShadow = true;
        child.userData.measureSurface = true;
    });
    target.add(clone);
}

function clearPelvicOverlays() {
    Object.values(overlayGroups).forEach(group => group.clear());
    pointMesh = null;
    planeMesh = null;
    planeOutline = null;
    normalArrow = null;
    boundsLines = null;
}

// The density sweep runs the point density at 1, 5, 10 ... 100; the notebook's 32 only exists as the
// thickness sweep's 6 / 12 socket at weighting 0.6. Away from 0.6, 32 becomes 30 (the nearest generated value).
const isBaselineDensity = s => s.pointDensity === 32 && Math.abs(s.spatialWeighting - 0.6) < 1e-9;
function resolveSweepState(state, group) {
    const resolved = { ...socketParameterDefaults, ...state };
    if (group === 'density' && resolved.pointDensity === 32 && !isBaselineDensity(resolved)) resolved.pointDensity = 30;
    return resolved;
}

// The socket for the current pair of values; the other pair is at its baseline.
function socketModelFile(state = socketParameterState, group = sweepGroupOf(activeSocketParameter)) {
    const pad = (value, width = 2) => String(value).padStart(width, '0');
    const s = resolveSweepState(state, group);
    const dir = socketSetDir();
    if (group === 'thickness') return `${dir}/t${pad(s.minThickness)}-${pad(s.maxThickness)}.glb`;
    if (isBaselineDensity(s)) return `${dir}/t06-12.glb`;
    return `${dir}/w${pad(Math.round(s.spatialWeighting * 10))}-d${pad(s.pointDensity, 3)}.glb`;
}

function socketParameterModelFile(key, value) {
    return socketModelFile({ ...socketParameterState, [key]: value }, sweepGroupOf(key));
}

function prepareSocketPreviewObject(object) {
    normalizeMillimeterExport(object);
    object.traverse(child => {
        if (!child.isMesh) return;
        child.geometry.computeVertexNormals();
        child.material = new THREE.MeshStandardMaterial({ dithering: true,
            color: 0x4e8f91,
            roughness: 0.7,
            metalness: 0,
            side: THREE.DoubleSide,
        });
        child.castShadow = true;
        child.receiveShadow = true;
        child.userData.measureSurface = true;
    });
    return object;
}

function socketModelPromise(key, value) {
    const file = socketParameterModelFile(key, value);
    if (!socketModelPromises.has(file)) {
        const promise = loadGLB(file).then(gltf => prepareSocketPreviewObject(gltf.scene));
        promise.catch(() => socketModelPromises.delete(file)); // a failed download can be retried
        socketModelPromises.set(file, promise);
    }
    return socketModelPromises.get(file);
}

function hasSocketModelLibrary() {
    return importSelection.attachment?.category === 'socket';
}

function showSourceModelsOnly(status) {
    if (hasSocketModelLibrary()) return false;
    socketPreviewRoot.clear();
    currentSocketFile = null;
    status.hidden = false;
    status.textContent = 'Source models only. Socket results are not generated for this selection yet.';
    return true;
}

async function loadSocketParameterModel(key, value) {
    const request = ++socketModelRequest;
    const status = document.querySelector('[data-slot-status]');
    if (showSourceModelsOnly(status)) return;
    const meta = socketParameterModelMeta[key];
    status.hidden = false;
    status.textContent = `Loading nTop mesh · ${meta.label} ${value}${meta.unit}`;
    try {
        const object = await socketModelPromise(key, value);
        if (request !== socketModelRequest) return;
        socketPreviewRoot.clear();
        socketPreviewRoot.add(object);
        currentSocketFile = socketParameterModelFile(key, value);
        // The other pair is at its baseline in this file; keep the sliders honest about that.
        resetSocketParametersForSweep(key);
        socketParameterState[key] = value;
        activeSocketParameter = key;
        const resolved = resolveSweepState(socketParameterState, sweepGroupOf(key));
        if (resolved.pointDensity !== socketParameterState.pointDensity) setSocketParameterControl('pointDensity', resolved.pointDensity);
        status.textContent = '';
        status.hidden = true;
        applyPelvicStageVisibility();
        applyInterfaceStageVisibility();
        const values = parameterValues[key];
        const index = values.indexOf(value);
        [index - 1, index + 1].forEach(next => {
            if (next < 0 || next >= values.length) return;
            const candidate = { ...socketParameterState, [key]: values[next] };
            if (candidate.minThickness > candidate.maxThickness) return;   // only Min <= Max was generated
            socketModelPromise(key, values[next]).catch(() => {});
        });
    } catch (error) {
        if (request !== socketModelRequest) return;
        status.textContent = `Could not load ${meta.label} ${value}${meta.unit}`;
        console.error(error);
    }
}

// Step 2a used to swap demo sockets per pelvic-plane face; the 10-13 socket block does not take the
// plane, so the current socket is shown there instead.
function loadPelvicPlaneTestModel() {
    return loadSocketParameterModel(activeSocketParameter, socketParameterState[activeSocketParameter]);
}

function buildSocketPreview() {
    loadSocketParameterModel(activeSocketParameter, socketParameterState[activeSocketParameter]);
}

function rebuildPelvicScene() {
    if (!layers.solidAnimal.group.children.length || !layers.attachment.group.children.length) return;
    pelvicBody.clear();
    pelvicAttach.clear();
    socketPreviewRoot.clear();
    clearPelvicOverlays();
    cloneImportForPelvic('solidAnimal', pelvicBody, { color: PART_COLOR.solidAnimal, opacity: 1, roughness: 0.82 });
    cloneImportForPelvic('attachment', pelvicAttach, { color: PART_COLOR.attachment, opacity: 0.78, roughness: 0.66 });
    showOverTheBody(pelvicAttach);
    buildPlaneOverlays();
    buildSocketPreview();
    applyPelvicStageVisibility();
    attachmentHoles.rebuild(layers.attachment.group, layers.solidAnimal.group);
}

let activeStep = '1';
let introShown = false;   // the movement guide opens once, after the scan is imported
let importBounds = null;
let pelvicBounds = null;
const planeState = { pick: [1, 2, 1], normal: [0, -1, 0] };

// Ollie's answers. Both planes start scrambled away from these, every time the page loads, so the
// student always has to find them; the comparison in Step 6 measures against them.
const SOLUTION = {
    pelvicPlane: { pick: [1, 2, 1], normal: [0, -1, 0] },
    interfacePlane: { pick: [1, 1, 2], normal: [0, 0, -1] },
    interfacePosition: [-161.21, 146.38, 138.71],
    orientation: { lateral: -70, medial: -61, rotation: -180 },
    socket: { minThickness: 6, maxThickness: 12, spatialWeighting: 0.6, pointDensity: 32 },
    attachmentPoints: [
        [-64.15, 36.85, 199.5],
        [-128.84, 27.5, 199.4],
        [-186.9, 30.27, 200.48],
        [-78.75, 142.82, 193.28],
        [-135.49, 144.62, 198.44],
        [-184.69, 148.02, 200.8],
    ],
};

// ---- practice mode -------------------------------------------------------------------------
// The same two planes, on a body that has been turned. One problem turns the scan and its surface
// one way and the interfaces another, independently, and the answer for that problem is the
// recorded answer carried through the same turn.
//
// Only quarter turns, the 24 ways a cube can sit. The task is to name a face of the axis-aligned
// bounding box, and a mesh tilted by anything else has no face that answers it: the box stops
// touching the body where the plane should go, so the question would have no right answer.

const QUARTER_TURNS = (() => {
    const out = [];
    for (const perm of [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]) {
        for (let bits = 0; bits < 8; bits++) {
            const sign = [bits & 1 ? -1 : 1, bits & 2 ? -1 : 1, bits & 4 ? -1 : 1];
            // The body's own axis i ends up along world axis perm[i], pointing that way.
            const m = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
            for (let i = 0; i < 3; i++) m[perm[i]][i] = sign[i];
            const det = m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
                - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
                + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
            if (det > 0) out.push({ axis: [...perm], sign, m });   // a turn, not a mirror
        }
    }
    return out;
})();

function practiceIcon(name) { return `<i data-lucide="${name}" aria-hidden="true"></i>`; }

function turnQuaternion(turn) {
    const m = turn.m;
    return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().set(
        m[0][0], m[0][1], m[0][2], 0,
        m[1][0], m[1][1], m[1][2], 0,
        m[2][0], m[2][1], m[2][2], 0,
        0, 0, 0, 1));
}

// The recorded answer seen from the turned body: the face it names moves to another world axis and
// swaps end if that axis now points the other way. Centroid stays centroid either way.
const OTHER_END = [2, 1, 0];
function turnAnswer(answer, turn) {
    const pick = [1, 1, 1];
    const normal = [0, 0, 0];
    for (let i = 0; i < 3; i++) {
        const axis = turn.axis[i];
        pick[axis] = turn.sign[i] > 0 ? answer.pick[i] : OTHER_END[answer.pick[i]];
        normal[axis] = turn.sign[i] * answer.normal[i];
    }
    return { pick, normal };
}

const practice = {
    on: false,
    problem: 0,
    attempted: 0,       // problems that have been checked at least once
    firstTry: 0,        // of those, the ones right the first time
    checked: false,     // this problem has had its first check
    result: null,
    answer: { pelvic: SOLUTION.pelvicPlane, interface: SOLUTION.interfacePlane },
    saved: null,        // the student's real answers, parked while practice runs
};

// The turn goes on the copies in the two scenes, never on the imported meshes, so leaving practice
// is only a matter of putting the copies back upright.
const practiceBodyRoots = () => [pelvicBody, pelvicAttach, socketPreviewRoot, interfaceAnimal];
const practiceInterfaceRoots = () => [interfaceReferenceMechanical, interfaceMechanical, interfaceSolid];

function applyPracticeTurns(bodyTurn, interfaceTurn) {
    const body = bodyTurn ? turnQuaternion(bodyTurn) : new THREE.Quaternion();
    const iface = interfaceTurn ? turnQuaternion(interfaceTurn) : new THREE.Quaternion();
    practiceBodyRoots().forEach(root => root.quaternion.copy(body));
    practiceInterfaceRoots().forEach(root => root.quaternion.copy(iface));
    // Both scenes measure their own bounding box as they are rebuilt, so this is what makes the
    // box, the plane and the answer agree about where the body now is.
    rebuildPelvicScene();
    buildInterfaceScene();
    updatePlane();
}

function sameAnswer(a, b) {
    return !!a && !!b && a.pick.join() === b.pick.join() && a.normal.join() === b.normal.join();
}

function newPracticeProblem() {
    const roll = () => QUARTER_TURNS[Math.floor(Math.random() * QUARTER_TURNS.length)];
    const previous = practice.answer.pelvic;
    let bodyTurn = roll();
    // Two problems in a row with the same pelvic answer would read as nothing having changed.
    for (let guard = 0; guard < 40 && sameAnswer(turnAnswer(SOLUTION.pelvicPlane, bodyTurn), previous); guard++) {
        bodyTurn = roll();
    }
    const interfaceTurn = roll();
    practice.problem += 1;
    practice.checked = false;
    practice.result = null;
    practice.bodyTurn = bodyTurn;
    practice.interfaceTurn = interfaceTurn;
    practice.answer = {
        pelvic: turnAnswer(SOLUTION.pelvicPlane, bodyTurn),
        interface: turnAnswer(SOLUTION.interfacePlane, interfaceTurn),
    };
    applyPracticeTurns(bodyTurn, interfaceTurn);
    // Start scrambled away from this problem's answer, as the walkthrough itself does.
    randomizePelvicPlane();
    randomizeInterfacePlane();
    closePlaneHelp();
    updatePlane();
    updateInterfacePlane();
    renderPractice();
    frameActiveStep();
}

// Showing the previous problem's answer over this one would be nonsense, so the help closes with it.
function closePlaneHelp() {
    stopPlaneGuide();
    if (pelvicAnswerShown) { pelvicAnswerShown = false; toggleHelpCard(pelvicAnswerHelpButton, pelvicHelpCard); }
    if (interfaceAnswerShown) { interfaceAnswerShown = false; toggleHelpCard(interfacePlaneHelpButton, interfaceHelpCard); }
    pelvicAnswerRoot.clear();
    interfaceAnswerRoot.clear();
    syncPelvicAnswer();
    syncInterfaceAnswer();
}

function setPractice(on) {
    if (on === practice.on) return;
    if (on && !importsReady()) {
        practice.result = { blocked: true };
        renderPractice();
        return;
    }
    practice.on = on;
    if (on) {
        practice.saved = {
            pelvic: { pick: [...planeState.pick], normal: [...planeState.normal] },
            interface: { pick: [...interfacePlaneState.pick], normal: [...interfacePlaneState.normal] },
        };
        practice.problem = 0;
        practice.attempted = 0;
        practice.firstTry = 0;
        practice.answer = { pelvic: SOLUTION.pelvicPlane, interface: SOLUTION.interfacePlane };
        newPracticeProblem();
        return;
    }
    practice.answer = { pelvic: SOLUTION.pelvicPlane, interface: SOLUTION.interfacePlane };
    practice.result = null;
    applyPracticeTurns(null, null);
    if (practice.saved) {
        showPelvicPlane(practice.saved.pelvic);
        showInterfacePlane(practice.saved.interface);
    }
    closePlaneHelp();
    updatePlane();
    updateInterfacePlane();
    renderPractice();
    frameActiveStep();
}

function practiceKind() {
    return activeStep === '2b' ? 'interface' : 'pelvic';
}

function checkPractice() {
    if (!practice.on) return;
    const kind = practiceKind();
    const state = kind === 'pelvic' ? planeState : interfacePlaneState;
    const answer = practice.answer[kind];
    const right = state.pick.join() === answer.pick.join()
        && answer.normal.every((n, i) => Math.abs(state.normal[i] - n) < 1e-6);
    // Only the first check on a problem counts, so a student can fix it and see it go green
    // without that reading as a score they did not earn.
    if (!practice.checked) {
        practice.checked = true;
        practice.attempted += 1;
        if (right) practice.firstTry += 1;
    }
    practice.result = { right, kind, wrongPick: state.pick.join() !== answer.pick.join() };
    renderPractice();
}

function renderPractice() {
    document.querySelectorAll('[data-practice-bar]').forEach(bar => {
        const on = practice.on;
        bar.classList.toggle('is-on', on);
        const toggle = bar.querySelector('[data-practice-toggle]');
        toggle.setAttribute('aria-pressed', String(on));
        // Not span:last-child: the switch has a knob span of its own inside it.
        toggle.querySelector('[data-practice-label]').textContent = on ? 'Practice mode on' : 'Practice mode';
        const count = bar.querySelector('[data-practice-count]');
        count.hidden = !on;
        count.textContent = `Problem ${practice.problem}`;
        const score = bar.querySelector('[data-practice-score]');
        score.hidden = !on || !practice.attempted;
        score.textContent = `${practice.firstTry}/${practice.attempted} first try`;
        bar.querySelector('[data-practice-check]').hidden = !on;
        bar.querySelector('[data-practice-next]').hidden = !on;

        const note = bar.querySelector('[data-practice-note]');
        const result = practice.result;
        note.className = 'practice-note';
        if (!on && !result) { note.hidden = true; note.textContent = ''; return; }
        if (result?.blocked) {
            note.hidden = false;
            note.classList.add('is-wrong');
            note.innerHTML = `${practiceIcon('triangle-alert')}<span>Import all four meshes first, then practice can turn them.</span>`;
        } else if (result?.right) {
            note.hidden = false;
            note.classList.add('is-right');
            note.innerHTML = `${practiceIcon('circle-check')}<span>That is the ${result.kind === 'pelvic' ? 'pelvic' : 'interface'} plane for this one. Press Next problem for another.</span>`;
        } else if (result) {
            note.hidden = false;
            note.classList.add('is-wrong');
            note.innerHTML = `${practiceIcon('circle-alert')}<span>Not yet &mdash; the ${result.wrongPick ? 'bounding box pick' : 'normal'} is off. The <strong>?</strong> will show you the answer, or walk you to it.</span>`;
        } else {
            note.hidden = false;
            note.innerHTML = `${practiceIcon('shuffle')}<span>The body has been turned. Find the ${practiceKind() === 'pelvic' ? 'pelvic' : 'interface'} plane on it, then press Check.</span>`;
        }
    });
    window.lucide?.createIcons({ attrs: { 'stroke-width': 1.8 } });
}


document.addEventListener('click', event => {
    if (event.target.closest('[data-practice-toggle]')) { setPractice(!practice.on); return; }
    if (event.target.closest('[data-practice-check]')) { checkPractice(); return; }
    if (event.target.closest('[data-practice-next]')) { if (practice.on) newPracticeProblem(); }
});

renderPractice();

// The answer being worked towards: Ollie's own, or, in practice mode, the one for the problem on
// screen. Everything that shows, checks or walks the student to an answer goes through this.
function planeAnswer(kind) {
    if (practice.on) return practice.answer[kind];
    return kind === 'pelvic' ? SOLUTION.pelvicPlane : SOLUTION.interfacePlane;
}

// One scrambled plane: a bounding-box pick that is not all-centroid, plus the outward normal of one
// of the faces it names. Never the answer, so no one starts on it by luck.
function randomPlaneChoice(answer) {
    for (;;) {
        const pick = [0, 0, 0];
        for (let axis = 0; axis < 3; axis++) pick[axis] = Math.floor(Math.random() * 3);
        if (pick.join() === answer.pick.join()) continue;
        const axis = Math.floor(Math.random() * 3);
        const normal = [0, 0, 0];
        normal[axis] = Math.random() < 0.5 ? 1 : -1;
        if (normal.join() === answer.normal.join()) continue;
        return { pick, normal, axis };
    }
}

function randomizePelvicPlane() {
    const choice = randomPlaneChoice(planeAnswer('pelvic'));
    planeState.pick = choice.pick;
    planeState.normal = choice.normal;
    activePelvicPlaneAxis = choice.axis;
    activePelvicPlanePreset = `${'xyz'[choice.axis]}-${choice.pick[choice.axis] === 0 ? 'min' : 'max'}`;
    document.querySelectorAll('[data-axis]').forEach(select => { select.value = String(planeState.pick[+select.dataset.axis]); });
    document.querySelectorAll('[data-pelvic-axis-slider]').forEach(slider => { slider.value = String(planeState.pick[+slider.dataset.pelvicAxisSlider]); });
    document.querySelectorAll('[data-normal]').forEach(input => { input.value = String(planeState.normal[+input.dataset.normal]); });
}
randomizePelvicPlane();

const interfacePlaneState = { pick: [1, 1, 1], normal: [0, 0, 0] };

// The same for the interface plane, and the way its boxes are filled in from a plane either way.
function showInterfacePlane(state) {
    interfacePlaneState.pick = [...state.pick];
    interfacePlaneState.normal = [...state.normal];
    document.querySelectorAll('[data-interface-axis]').forEach(select => { select.value = String(interfacePlaneState.pick[+select.dataset.interfaceAxis]); });
    document.querySelectorAll('[data-interface-axis-slider]').forEach(slider => { slider.value = String(interfacePlaneState.pick[+slider.dataset.interfaceAxisSlider]); });
    document.querySelectorAll('[data-interface-normal]').forEach(input => { input.value = String(interfacePlaneState.normal[+input.dataset.interfaceNormal]); });
}

function showPelvicPlane(state) {
    planeState.pick = [...state.pick];
    planeState.normal = [...state.normal];
    document.querySelectorAll('[data-axis]').forEach(select => { select.value = String(planeState.pick[+select.dataset.axis]); });
    document.querySelectorAll('[data-pelvic-axis-slider]').forEach(slider => { slider.value = String(planeState.pick[+slider.dataset.pelvicAxisSlider]); });
    document.querySelectorAll('[data-normal]').forEach(input => { input.value = String(planeState.normal[+input.dataset.normal]); });
}

function randomizeInterfacePlane() {
    showInterfacePlane(randomPlaneChoice(planeAnswer('interface')));
}
randomizeInterfacePlane();
const interfacePositionState = new THREE.Vector3();
const orientationState = {
    lateral: 0,
    medial: 0,
    rotation: 0,
    adjust: [0, 0, 0],
};
let interfacePositionFollowsPlane = true;
let interfaceBounds = null;
let interfaceAnimalBounds = null;
let solidInterfaceBounds = null;
let surfaceTriangles = [];
let solidInterfaceTriangles = [];
const interfaceSurfaceNormal = new THREE.Vector3(0, 1, 0);
let pointMesh = null;
let planeMesh = null;
let planeOutline = null;
let normalArrow = null;
let boundsLines = null;
let interfacePointMesh = null;
let interfacePlaneMesh = null;
let interfacePlaneOutline = null;
let interfaceNormalArrow = null;
let targetPointMesh = null;
let targetHandle = null;

function resize() {
    const width = stage.clientWidth;
    const height = stage.clientHeight;
    if (!width || !height) return;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
}
new ResizeObserver(() => {
    resize();
    // Draw straight away so dragging a divider does not flash an empty canvas.
    renderer.render(scene, camera);
}).observe(stage);
resize();

function setRailWidth(clientX) {
    const bounds = app.getBoundingClientRect();
    const dividerWidth = resizerEl.offsetWidth || 9;
    const minimum = Math.min(360, bounds.width * 0.42);
    const maximum = Math.max(minimum, bounds.width - dividerWidth - Math.min(420, bounds.width * 0.48));
    const width = THREE.MathUtils.clamp(clientX - bounds.left, minimum, maximum);
    app.style.setProperty('--workflow-rail-width', width + 'px');
    resizerEl.setAttribute('aria-valuenow', Math.round(width / bounds.width * 100));
}

resizerEl.addEventListener('pointerdown', event => {
    if (window.matchMedia('(max-width: 880px)').matches) return;
    app.classList.add('is-resizing');
    resizerEl.setPointerCapture(event.pointerId);
    setRailWidth(event.clientX);
});
resizerEl.addEventListener('pointermove', event => {
    if (!app.classList.contains('is-resizing')) return;
    setRailWidth(event.clientX);
});
resizerEl.addEventListener('pointerup', event => {
    app.classList.remove('is-resizing');
    if (resizerEl.hasPointerCapture(event.pointerId)) resizerEl.releasePointerCapture(event.pointerId);
});
resizerEl.addEventListener('pointercancel', () => app.classList.remove('is-resizing'));
resizerEl.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    const railWidth = app.querySelector('.workflow-rail').getBoundingClientRect().width;
    setRailWidth(app.getBoundingClientRect().left + railWidth + (event.key === 'ArrowLeft' ? -24 : 24));
});

// The expert comparison can take over drawing the main view (e.g. "yours" and "the experts'" side by side).
let renderOverride = null;
let walkthroughNotes = null;   // set once the viewer is built; draws the notes layer each frame
renderer.setAnimationLoop(() => {
    viewerControls.update();
    controls.update();
    if (renderOverride) renderOverride();
    else renderer.render(scene, camera);
    renderSplitPane();
    walkthroughNotes?.tick();
});

function frameObject(root, direction = new THREE.Vector3(-1.4, -1.8, 0.9)) {
    const box = new THREE.Box3().setFromObject(root);
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const radius = Math.max(size.length() / 2, 0.01);
    const verticalFov = THREE.MathUtils.degToRad(camera.fov);
    const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * camera.aspect);
    const fitDistance = radius / Math.sin(Math.min(verticalFov, horizontalFov) / 2) * 1.08;
    controls.target.copy(center);
    camera.position.copy(center).add(direction.normalize().multiplyScalar(fitDistance));
    camera.near = Math.max(radius / 100, 0.0001);
    camera.far = Math.max(radius * 80, 100);
    camera.updateProjectionMatrix();
    controls.update();
    const span = Math.max(size.x, size.y, size.z, 0.2);
    gridPlanes.xy.position.set(center.x, center.y, box.min.z - size.z * 0.03);
    gridPlanes.xz.position.set(center.x, 0, center.z);
    gridPlanes.yz.position.set(0, center.y, center.z);
    Object.values(gridPlanes).forEach(plane => plane.scale.setScalar(span));
}

const measureRaycaster = new THREE.Raycaster();
const measurePointer = new THREE.Vector2();
const measurementPoints = [];
let measurementLine = null;
let measureMode = false;
let measurePane = 'main'; // the pane the current measurement was made in

function measurementRoots() {
    if (isAttachmentStep(activeStep)) return attachmentHoles.measurementRoots();
    if (activeStep === '1') return Object.values(layers).filter(layer => layer.group.visible).map(layer => layer.group);
    if (isPelvicStep(activeStep)) return [pelvicBody, pelvicAttach, socketPreviewRoot].filter(root => root.visible);
    if (isInterfaceStep(activeStep)) return [interfaceAnimal, interfaceReferenceMechanical, orientedAssembly, socketPreviewRoot].filter(root => root.visible);
    return [];
}

function visibleMeasurementMeshes() {
    const meshes = [];
    measurementRoots().forEach(root => {
        root.traverse(object => {
            if (!object.isMesh || object.userData.measureSurface === false) return;
            let current = object;
            while (current && current !== scene) {
                if (!current.visible) return;
                current = current.parent;
            }
            meshes.push(object);
        });
    });
    return meshes;
}

function measurementMarkerRadius() {
    const box = new THREE.Box3();
    (measurePane === 'split' ? [interfaceReferenceMechanical] : measurementRoots()).forEach(root => box.expandByObject(root));
    if (box.isEmpty()) return 0.004;
    return THREE.MathUtils.clamp(box.getSize(new THREE.Vector3()).length() * 0.012, 0.0008, 0.02);
}

function updateMeasurementReadout() {
    if (measurementPoints.length < 2) {
        measureStatusEl.textContent = measurementPoints.length ? 'Select point 2' : 'Select point 1';
        measureValueEl.textContent = '—';
        return;
    }
    const unit = measureUnitEl.value;
    const value = measurementPoints[0].distanceTo(measurementPoints[1]) / UNIT_TO_METERS[unit];
    const decimals = value >= 100 ? 1 : value >= 10 ? 2 : 3;
    measureStatusEl.textContent = 'Distance';
    measureValueEl.textContent = value.toFixed(decimals) + ' ' + unit;
}

function clearMeasurement() {
    measurementPoints.length = 0;
    measurementRoot.clear();
    measurementRoot.visible = true;
    measurePane = 'main';
    measurementLine = null;
    updateMeasurementReadout();
}

function addMeasurementPoint(point) {
    if (measurementPoints.length === 2) clearMeasurement();
    measurementPoints.push(point.clone());
    const radius = measurementMarkerRadius();
    const marker = new THREE.Mesh(
        new THREE.SphereGeometry(radius, 22, 16),
        new THREE.MeshBasicMaterial({
            color: measurementPoints.length === 1 ? 0x1f78b4 : 0xf2aa2a,
            depthTest: false,
            depthWrite: false,
            toneMapped: false,
        }),
    );
    marker.position.copy(point);
    marker.renderOrder = 210;
    marker.userData.measureSurface = false;
    measurementRoot.add(marker);

    if (measurementPoints.length === 2) {
        const geometry = new THREE.BufferGeometry().setFromPoints(measurementPoints);
        measurementLine = new THREE.Line(geometry, new THREE.LineBasicMaterial({
            color: 0x173f63,
            depthTest: false,
            depthWrite: false,
            toneMapped: false,
        }));
        measurementLine.renderOrder = 209;
        measurementRoot.add(measurementLine);
    }
    updateMeasurementReadout();
}

function pickMeasurementPoint(event, pane) {
    const split = pane === 'split';
    const rect = (split ? splitCanvas : canvas).getBoundingClientRect();
    measurePointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    measurePointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    measureRaycaster.setFromCamera(measurePointer, split ? splitCamera : camera);
    const hit = measureRaycaster.intersectObjects(split ? splitPickMeshes() : visibleMeasurementMeshes(), false)[0];
    if (!hit) return;
    // The two panes show different things, so a measurement stays in the pane it was started in.
    if (measurePane !== pane) clearMeasurement();
    measurePane = pane;
    measurementRoot.visible = !split;
    addMeasurementPoint(hit.point);
}

function setMeasureMode(enabled) {
    measureMode = enabled;
    measureButtonEl.classList.toggle('active', enabled);
    measureButtonEl.setAttribute('aria-label', enabled ? 'Close measurement tool' : 'Measure between two points');
    measurePanelEl.hidden = !enabled;
    stage.classList.toggle('is-measuring', enabled);
    splitPaneEl.classList.toggle('is-measuring', enabled);
    if (!enabled) clearMeasurement();
    if (isAttachmentStep(activeStep)) {
        if (enabled) attachmentHoles.cancelPicking();
        attachmentHoles.syncVisibility();
    }
}

function bindMeasureClicks(target, pane) {
    let pointerDown = null;
    target.addEventListener('pointerdown', event => {
        if (!measureMode || event.button !== 0) return;
        pointerDown = { x: event.clientX, y: event.clientY };
    });
    target.addEventListener('pointerup', event => {
        if (!measureMode || !pointerDown || event.button !== 0) return;
        const movement = Math.hypot(event.clientX - pointerDown.x, event.clientY - pointerDown.y);
        pointerDown = null;
        if (movement <= 5) pickMeasurementPoint(event, pane);
    });
}
bindMeasureClicks(canvas, 'main');

measureButtonEl.addEventListener('click', () => setMeasureMode(!measureMode));
document.getElementById('clear-measurement').addEventListener('click', clearMeasurement);
measureUnitEl.addEventListener('change', updateMeasurementReadout);

function coord(axis, choice) {
    const key = ['x', 'y', 'z'][axis];
    if (choice === 0) return pelvicBounds.min[key];
    if (choice === 2) return pelvicBounds.max[key];
    return (pelvicBounds.min[key] + pelvicBounds.max[key]) / 2;
}


// ---- The ? on the Pelvic Plane block: the answer, drawn beside the student's own plane ---------
const pelvicAnswerRoot = new THREE.Group();
pelvicAnswerRoot.visible = false;
planeRoot.add(pelvicAnswerRoot);
let pelvicAnswerShown = false;

const SPOT_WORD = ['minimum', 'centroid', 'maximum'];

function buildAnswerPlane(group, bounds, answer) {
    group.clear();
    if (!bounds || bounds.isEmpty()) return false;
    const size = bounds.getSize(new THREE.Vector3());
    const diag = size.length();
    const data = planeData(bounds, answer, new THREE.Vector3(...answer.normal));
    const side = Math.max(size.x, size.y, size.z) * 1.24;

    const quad = new THREE.Mesh(new THREE.PlaneGeometry(side, side), new THREE.MeshBasicMaterial({
        color: 0x1f9d55, transparent: true, opacity: 0.2, side: THREE.DoubleSide, depthWrite: false,
    }));
    quad.renderOrder = 4;
    const outline = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.PlaneGeometry(side, side)),
        new THREE.LineBasicMaterial({ color: 0x1f9d55, depthTest: false }),
    );
    outline.renderOrder = 8;
    quad.position.copy(data.point);
    outline.position.copy(data.point);
    quad.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), data.normal);
    outline.quaternion.copy(quad.quaternion);

    const dot = new THREE.Mesh(
        new THREE.SphereGeometry(diag * 0.022, 24, 18),
        new THREE.MeshBasicMaterial({ color: 0x1f9d55, depthTest: false, depthWrite: false, toneMapped: false }),
    );
    dot.position.copy(data.point);
    dot.renderOrder = 31;

    const arrow = new THREE.ArrowHelper(data.normal, data.point, diag * 0.34, 0x1f9d55, diag * 0.09, diag * 0.05);
    [arrow.line, arrow.cone].forEach(part => {
        part.material.transparent = true;
        part.material.depthTest = false;
        part.material.depthWrite = false;
        part.material.toneMapped = false;
        part.renderOrder = 30;
    });

    group.add(quad, outline, dot, arrow);
    return true;
}

const buildPelvicAnswer = () => buildAnswerPlane(pelvicAnswerRoot, pelvicBounds, planeAnswer('pelvic'));
const buildInterfaceAnswer = () => buildAnswerPlane(interfaceAnswerRoot, interfaceBounds, planeAnswer('interface'));

// The same green answer, on the mechanical interface, for Step 2b.
const interfaceAnswerRoot = new THREE.Group();
interfaceAnswerRoot.visible = false;
interfaceRoot.add(interfaceAnswerRoot);
let interfaceAnswerShown = false;

function syncInterfaceAnswer() {
    const on = interfaceAnswerShown && activeStep === '2b' && !!interfaceBounds;
    if (on && !interfaceAnswerRoot.children.length) buildInterfaceAnswer();
    interfaceAnswerRoot.visible = on;
    setViewerMode('interfaceAnswer', on ? {
        name: 'Answer shown',
        text: 'The answer plane is the green one. Yours is blue.',
        done: () => interfacePlaneHelpButton.click(),
    } : null);
    syncPlaneMarks('interface');
    syncPlaneGuideButtons();
    updateInterfaceHelpNote();
}

function updateInterfaceHelpNote() {
    if (!interfacePlaneHelpNote) return;
    if (splitNarrow.matches && splitEnabled) {
        interfacePlaneHelpNote.hidden = false;
        interfacePlaneHelpNote.textContent = 'The side-by-side view needs a wider window.';
        return;
    }
    const lines = [];
    if (interfaceAnswerShown) {
        lines.push(interfaceBounds
            ? `The answer is in green: X ${SPOT_WORD[planeAnswer('interface').pick[0]]}, Y ${SPOT_WORD[planeAnswer('interface').pick[1]]}, Z ${SPOT_WORD[planeAnswer('interface').pick[2]]}, normal ${planeAnswer('interface').normal.join(', ')}. Yours is the blue one.`
            : 'Import the meshes first, then this shows the answer in the viewer.');
    }
    if (splitEnabled && !splitNarrow.matches) {
        lines.push('Left: the plane on the mechanical interface. Right: the interface sitting on the animal, oriented by that plane. Move X, Y or Z and both follow.');
    }
    interfacePlaneHelpNote.hidden = !lines.length;
    interfacePlaneHelpNote.textContent = lines.join(' ');
}

function syncPelvicAnswer() {
    const on = pelvicAnswerShown && activeStep === '2a' && !!pelvicBounds;
    if (on && !pelvicAnswerRoot.children.length) buildPelvicAnswer();
    pelvicAnswerRoot.visible = on;
    setViewerMode('pelvicAnswer', on ? {
        name: 'Answer shown',
        text: 'The answer plane is the green one. Yours is blue.',
        done: () => pelvicAnswerHelpButton.click(),
    } : null);
    syncPlaneMarks('pelvic');
    syncPlaneGuideButtons();
    if (!pelvicAnswerShown) { pelvicAnswerNote.hidden = true; return; }
    pelvicAnswerNote.hidden = false;
    pelvicAnswerNote.textContent = pelvicBounds
        ? `The answer is in green: X ${SPOT_WORD[planeAnswer('pelvic').pick[0]]}, Y ${SPOT_WORD[planeAnswer('pelvic').pick[1]]}, Z ${SPOT_WORD[planeAnswer('pelvic').pick[2]]}, normal ${planeAnswer('pelvic').normal.join(', ')}. Yours is the blue one.`
        : 'Import the meshes first, then this shows the answer in the viewer.';
}


// ---- Walking the student to the answer, one field at a time ------------------------------------
// The same shape as the movement guide in the viewer: say the one thing to change, confirm it the
// moment it is right, then move straight on to the next.
const PLANE_GUIDE_HOME = { pelvic: '#workflow-step-2a', interface: '#workflow-step-2b' };
let planeGuide = null;

function planeGuideSteps(kind) {
    const answer = planeAnswer(kind);
    const axisAttr = kind === 'pelvic' ? 'data-axis' : 'data-interface-axis';
    const home = PLANE_GUIDE_HOME[kind];
    const steps = [0, 1, 2].map(axis => ({
        label: 'XYZ'[axis],
        text: `Set ${'XYZ'[axis]} to ${SPOT_WORD[answer.pick[axis]]}.`,
        target: () => document.querySelector(`${home} [${axisAttr}="${axis}"]`)?.closest('label'),
        done: state => state.pick[axis] === answer.pick[axis],
        // Which way the slider has to travel from where it is now.
        way: state => (answer.pick[axis] > state.pick[axis] ? 'right' : answer.pick[axis] < state.pick[axis] ? 'left' : ''),
    }));
    steps.push({
        label: 'Normal',
        text: `Type the normal: ${answer.normal.join(', ')}.`,
        target: () => document.querySelector(`${home} .workflow-normal-row`),
        done: state => answer.normal.every((n, i) => Math.abs(Number(state.normal[i]) - n) < 1e-6),
    });
    return steps;
}

const planeGuideState = () => (planeGuide?.kind === 'pelvic' ? planeState : interfacePlaneState);
const planeGuideBlock = kind => document.querySelector(`${PLANE_GUIDE_HOME[kind]} .workflow-plane-block`);

function clearPlaneGuideHighlight() {
    document.querySelectorAll('.is-guided').forEach(el => {
        el.classList.remove('is-guided');
        delete el.dataset.guideWay;
    });
    document.querySelectorAll('.plane-guide-cue, .plane-guide-bar').forEach(el => el.remove());
}

// Amber on a field that is wrong, green once it is right. This belongs to the ? on the block, so a
// student who only wants to see where they stand gets it without starting the walk-through.
function syncPlaneMarks(kind) {
    const home = PLANE_GUIDE_HOME[kind];
    document.querySelectorAll(`${home} .is-guide-wrong, ${home} .is-guide-right`)
        .forEach(el => el.classList.remove('is-guide-wrong', 'is-guide-right'));
    const showing = kind === 'pelvic' ? pelvicAnswerShown : interfaceAnswerShown;
    if (!showing && planeGuide?.kind !== kind) return;
    const state = kind === 'pelvic' ? planeState : interfacePlaneState;
    planeGuideSteps(kind).forEach(step => {
        const row = step.target();
        if (row) row.classList.add(step.done(state) ? 'is-guide-right' : 'is-guide-wrong');
    });
}

function stopPlaneGuide() {
    if (!planeGuide) return;
    planeGuide = null;
    clearPlaneGuideHighlight();
    syncPlaneGuideButtons();
}

function startPlaneGuide(kind) {
    stopPlaneGuide();
    planeGuide = { kind, steps: planeGuideSteps(kind), index: 0, cheering: false };
    // Anything already right is skipped, so the guide starts on the first thing to change.
    settlePlaneGuide();
    renderPlaneGuide();
    syncPlaneGuideButtons();
}

function renderPlaneGuide() {
    if (!planeGuide) return;
    const block = planeGuideBlock(planeGuide.kind);
    if (!block) return;
    const { steps, index, cheering } = planeGuide;
    const finished = index >= steps.length;
    const step = steps[index];
    clearPlaneGuideHighlight();
    syncPlaneMarks(planeGuide.kind);

    // How far along, across the head of the block.
    const bar = document.createElement('div');
    bar.className = 'plane-guide-bar';
    bar.innerHTML = `<span style="width:${Math.round((index / steps.length) * 100)}%"></span>`;
    block.querySelector('.workflow-block-title').after(bar);

    // The instruction goes above the row it is about, never over it.
    const cue = document.createElement('p');
    cue.className = 'plane-guide-cue' + (finished || cheering ? ' is-done' : '');
    cue.innerHTML = finished
        ? `<i data-lucide="circle-check" aria-hidden="true"></i><strong>That is the plane.</strong>`
        : cheering
            ? `<i data-lucide="circle-check" aria-hidden="true"></i><strong>${escapeForGuide(step.label)} is right.</strong>`
            : `<i data-lucide="arrow-right" aria-hidden="true"></i><strong>${escapeForGuide(step.text)}</strong>`;

    // The words always sit in the same place, above the sliders, so the eye knows where to find them.
    const fields = block.querySelector('.workflow-plane-fields');
    const firstRow = fields.querySelector('label.workflow-select-row') || fields.firstElementChild;
    fields.insertBefore(cue, firstRow);
    const target = finished ? null : step.target();
    if (target && !cheering) {
        target.classList.add('is-guided');
        const way = step.way ? step.way(planeGuideState()) : '';
        if (way) target.dataset.guideWay = way;
    }
    window.lucide?.createIcons({ attrs: { 'stroke-width': 1.8 } });
}

const escapeForGuide = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Point the cue at the first field that is not right yet, so it never asks for one that already is,
// and comes back if an earlier field is undone.
function settlePlaneGuide() {
    if (!planeGuide) return;
    const state = planeGuideState();
    const firstWrong = planeGuide.steps.findIndex(step => !step.done(state));
    planeGuide.index = firstWrong === -1 ? planeGuide.steps.length : firstWrong;
}

function checkPlaneGuide() {
    if (!planeGuide || planeGuide.cheering) return;
    const step = planeGuide.steps[planeGuide.index];
    if (!step || !step.done(planeGuideState())) { settlePlaneGuide(); renderPlaneGuide(); return; }
    planeGuide.cheering = true;
    renderPlaneGuide();
    setTimeout(() => {
        if (!planeGuide) return;
        planeGuide.cheering = false;
        planeGuide.index += 1;
        settlePlaneGuide();
        renderPlaneGuide();
    }, 650);
}

function syncPlaneGuideButtons() {
    [['pelvic', pelvicAnswerButton], ['interface', interfaceAnswerButton]].forEach(([kind, button]) => {
        if (!button) return;
        const on = planeGuide?.kind === kind;
        button.setAttribute('aria-pressed', String(on));
        button.classList.toggle('is-on', on);
        button.querySelector('span').textContent = on ? 'Stop walking me through' : 'Walk me through it';
    });
}

const pelvicAnswerHelpButton = document.getElementById('pelvic-plane-help');
// The cards say it with the viewer and the walk-through now, not with a line of text.
const pelvicAnswerNote = { hidden: true, textContent: '' };
const pelvicHelpCard = document.getElementById('pelvic-help-card');
const pelvicAnswerButton = document.getElementById('pelvic-answer-btn');

function toggleHelpCard(button, card) {
    const open = card.hidden;
    card.hidden = !open;
    button.setAttribute('aria-pressed', String(open));
    button.classList.toggle('is-on', open);
    if (open) requestAnimationFrame(() => card.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
}

// Pressing ? puts the answer plane in the viewer at once, and opens the card under the block.
pelvicAnswerHelpButton.addEventListener('click', () => {
    const opening = pelvicHelpCard.hidden;
    toggleHelpCard(pelvicAnswerHelpButton, pelvicHelpCard);
    pelvicAnswerShown = opening;
    if (opening) buildPelvicAnswer(); else stopPlaneGuide();
    syncPelvicAnswer();
});
pelvicAnswerButton.addEventListener('click', () => {
    if (planeGuide?.kind === 'pelvic') stopPlaneGuide(); else startPlaneGuide('pelvic');
});

function buildPlaneOverlays() {
    pelvicBounds = new THREE.Box3().setFromObject(pelvicAttach);
    const size = pelvicBounds.getSize(new THREE.Vector3());
    const center = pelvicBounds.getCenter(new THREE.Vector3());
    const diag = size.length();

    const boxGeometry = new THREE.EdgesGeometry(new THREE.BoxGeometry(size.x, size.y, size.z));
    boundsLines = new THREE.LineSegments(boxGeometry, new THREE.LineBasicMaterial({ color: 0x003262, transparent: true, opacity: 0.65 }));
    boundsLines.position.copy(center);
    overlayGroups.box.add(boundsLines);

    pointMesh = new THREE.Mesh(
        new THREE.SphereGeometry(diag * 0.024, 24, 18),
        new THREE.MeshBasicMaterial({ color: 0xfdb515, transparent: true, opacity: 1, depthTest: false, depthWrite: false, toneMapped: false }),
    );
    pointMesh.renderOrder = 30;
    overlayGroups.point.add(pointMesh);

    const planeSide = Math.max(size.x, size.y, size.z) * 1.18;
    const planeGeometry = new THREE.PlaneGeometry(planeSide, planeSide);
    planeMesh = new THREE.Mesh(planeGeometry, new THREE.MeshBasicMaterial({
        color: 0x315f93, transparent: true, opacity: 0.24, side: THREE.DoubleSide, depthWrite: false,
    }));
    planeMesh.renderOrder = 3;
    planeOutline = new THREE.LineSegments(
        new THREE.EdgesGeometry(planeGeometry),
        new THREE.LineBasicMaterial({ color: 0x003262, depthTest: false }),
    );
    planeOutline.renderOrder = 7;
    overlayGroups.plane.add(planeMesh, planeOutline);

    normalArrow = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(), diag * 0.38, 0xdf7544, diag * 0.1, diag * 0.055);
    [normalArrow.line, normalArrow.cone].forEach(part => {
        part.material.transparent = true;
        part.material.opacity = 1;
        part.material.depthTest = false;
        part.material.depthWrite = false;
        part.material.toneMapped = false;
        part.renderOrder = 29;
    });
    overlayGroups.normal.add(normalArrow);

    pelvicAnswerRoot.clear();
    updatePlane();
    syncPelvicAnswer();
}

function updatePlane() {
    if (!pelvicBounds || !pointMesh) return;
    const point = new THREE.Vector3(
        coord(0, planeState.pick[0]),
        coord(1, planeState.pick[1]),
        coord(2, planeState.pick[2]),
    );
    const rawNormal = new THREE.Vector3(...planeState.normal);
    const valid = rawNormal.lengthSq() > 1e-10;
    const normal = valid ? rawNormal.normalize() : new THREE.Vector3(1, 0, 0);

    pointMesh.position.copy(point);
    planeMesh.position.copy(point);
    planeOutline.position.copy(point);
    normalArrow.position.copy(point);
    planeMesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
    planeOutline.quaternion.copy(planeMesh.quaternion);
    normalArrow.setDirection(normal);
    planeMesh.visible = planeOutline.visible = normalArrow.visible = valid;
    syncPlaneMarks('pelvic');
    if (planeGuide?.kind === 'pelvic') checkPlaneGuide();
}

function coordFromBounds(bounds, axis, choice) {
    const key = ['x', 'y', 'z'][axis];
    return THREE.MathUtils.lerp(bounds.min[key], bounds.max[key], THREE.MathUtils.clamp(choice / 2, 0, 1));
}

function planeData(bounds, state, fallback = new THREE.Vector3(1, 0, 0)) {
    const point = new THREE.Vector3(
        coordFromBounds(bounds, 0, state.pick[0]),
        coordFromBounds(bounds, 1, state.pick[1]),
        coordFromBounds(bounds, 2, state.pick[2]),
    );
    const rawNormal = new THREE.Vector3(...state.normal);
    return {
        point,
        normal: rawNormal.lengthSq() > 1e-10 ? rawNormal.normalize() : fallback.clone(),
        valid: rawNormal.lengthSq() > 1e-10,
    };
}

function keepOverlayVisible(object, renderOrder = 30) {
    object.traverse(part => {
        if (!part.material) return;
        part.material.transparent = true;
        part.material.opacity = 1;
        part.material.depthTest = false;
        part.material.depthWrite = false;
        part.material.toneMapped = false;
        part.renderOrder = renderOrder;
    });
}

function cloneForInterface(layer) {
    const clone = layer.group.clone(true);
    clone.position.set(0, 0, 0);   // the import preview stands it aside; here it belongs at its origin
    // Step 1 visibility belongs to the import preview. Interface stages own
    // their visibility independently and must not inherit a hidden source root.
    clone.visible = true;
    return clone;
}

// Attaching TransformControls makes it visible, so anything that rebuilds the interface scene
// would put the position gizmo back whatever step is open and whatever the viewer is showing.
// This is the only place that decides whether it belongs, and every attach is followed by it.
function syncPositionGizmo() {
    const belongs = activeStep === '2c' && interfaceLayerVisible('target') && !scaleDemoOn;
    positionTransform.enabled = belongs;
    positionTransformHelper.visible = belongs;
}

function buildInterfaceScene() {
    splitFramed = false;
    positionTransform.detach();
    [interfaceAnimal, interfaceReferenceMechanical, interfaceMechanical, interfaceSolid,
        ...Object.values(interfaceOverlayGroups)].forEach(group => group.clear());
    orientedAssembly.position.set(0, 0, 0);
    orientedAssembly.quaternion.identity();
    orientedAssembly.updateMatrixWorld(true);
    interfaceAnimal.add(cloneForInterface(layers.solidAnimal));
    // Step 2b shows the mechanical interface. Both interfaces share a bounding box in every pair on
    // the site, so which one is on screen does not move the plane or change its answer.
    interfaceReferenceMechanical.add(cloneForInterface(layers.mechanical));
    interfaceMechanical.add(cloneForInterface(layers.mechanical));
    interfaceSolid.add(cloneForInterface(layers.solidInterface));
    interfaceRoot.updateMatrixWorld(true);
    interfaceBounds = new THREE.Box3().setFromObject(interfaceReferenceMechanical);
    interfaceAnswerRoot.clear();
    interfaceAnimalBounds = new THREE.Box3().setFromObject(interfaceAnimal);
    solidInterfaceBounds = new THREE.Box3().setFromObject(interfaceSolid);
    const size = interfaceBounds.getSize(new THREE.Vector3());
    const center = interfaceBounds.getCenter(new THREE.Vector3());
    const diag = size.length();

    const boxGeometry = new THREE.EdgesGeometry(new THREE.BoxGeometry(size.x, size.y, size.z));
    const boxLines = new THREE.LineSegments(boxGeometry, new THREE.LineBasicMaterial({ color: 0x003262, transparent: true, opacity: 0.65 }));
    boxLines.position.copy(center);
    interfaceOverlayGroups.box.add(boxLines);

    interfacePointMesh = new THREE.Mesh(
        new THREE.SphereGeometry(diag * 0.022, 24, 18),
        new THREE.MeshBasicMaterial({ color: 0xfdb515, toneMapped: false }),
    );
    keepOverlayVisible(interfacePointMesh, 31);
    interfaceOverlayGroups.point.add(interfacePointMesh);

    const planeSide = Math.max(size.x, size.y, size.z) * 1.16;
    const planeGeometry = new THREE.PlaneGeometry(planeSide, planeSide);
    interfacePlaneMesh = new THREE.Mesh(planeGeometry, new THREE.MeshBasicMaterial({
        color: 0x315f93, transparent: true, opacity: 0.2, side: THREE.DoubleSide, depthWrite: false,
    }));
    interfacePlaneMesh.renderOrder = 3;
    interfacePlaneOutline = new THREE.LineSegments(
        new THREE.EdgesGeometry(planeGeometry),
        new THREE.LineBasicMaterial({ color: 0x003262, depthTest: false }),
    );
    interfacePlaneOutline.renderOrder = 7;
    interfaceOverlayGroups.plane.add(interfacePlaneMesh, interfacePlaneOutline);

    interfaceNormalArrow = new THREE.ArrowHelper(new THREE.Vector3(0, -1, 0), new THREE.Vector3(), diag * 0.32, 0xdf7544, diag * 0.085, diag * 0.05);
    keepOverlayVisible(interfaceNormalArrow, 30);
    interfaceOverlayGroups.normal.add(interfaceNormalArrow);

    targetPointMesh = new THREE.Mesh(
        new THREE.SphereGeometry(diag * 0.025, 24, 18),
        new THREE.MeshBasicMaterial({ color: 0x2bb8a0, toneMapped: false }),
    );
    keepOverlayVisible(targetPointMesh, 33);
    targetHandle = new THREE.Group();
    targetHandle.add(targetPointMesh);
    interfaceOverlayGroups.target.add(targetHandle);
    positionTransform.attach(targetHandle);

    surfaceTriangles = collectSurfaceTriangles(interfaceAnimal);
    solidInterfaceTriangles = collectSurfaceTriangles(interfaceSolid);
    updateInterfacePlane();
    syncPositionGizmo();
}

function collectSurfaceTriangles(root) {
    const triangles = [];
    root.updateMatrixWorld(true);
    root.traverse(mesh => {
        if (!mesh.isMesh) return;
        const positions = mesh.geometry.getAttribute('position');
        const normals = mesh.geometry.getAttribute('normal');
        if (!positions || !normals) return;
        const index = mesh.geometry.getIndex();
        const normalMatrix = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
        const triangleCount = index ? index.count / 3 : positions.count / 3;
        for (let triangleIndex = 0; triangleIndex < triangleCount; triangleIndex++) {
            const offset = triangleIndex * 3;
            const ia = index ? index.getX(offset) : offset;
            const ib = index ? index.getX(offset + 1) : offset + 1;
            const ic = index ? index.getX(offset + 2) : offset + 2;
            const a = new THREE.Vector3().fromBufferAttribute(positions, ia).applyMatrix4(mesh.matrixWorld);
            const b = new THREE.Vector3().fromBufferAttribute(positions, ib).applyMatrix4(mesh.matrixWorld);
            const c = new THREE.Vector3().fromBufferAttribute(positions, ic).applyMatrix4(mesh.matrixWorld);
            triangles.push({
                triangle: new THREE.Triangle(a, b, c),
                normals: [
                    new THREE.Vector3().fromBufferAttribute(normals, ia).applyMatrix3(normalMatrix).normalize(),
                    new THREE.Vector3().fromBufferAttribute(normals, ib).applyMatrix3(normalMatrix).normalize(),
                    new THREE.Vector3().fromBufferAttribute(normals, ic).applyMatrix3(normalMatrix).normalize(),
                ],
            });
        }
    });
    return triangles;
}

function closestSurfacePoint(point, triangles = surfaceTriangles, bounds = interfaceAnimalBounds) {
    let bestTriangle = null;
    const bestPoint = new THREE.Vector3();
    const candidate = new THREE.Vector3();
    let bestDistance = Infinity;
    triangles.forEach(surfaceTriangle => {
        surfaceTriangle.triangle.closestPointToPoint(point, candidate);
        const distance = candidate.distanceToSquared(point);
        if (distance < bestDistance) {
            bestDistance = distance;
            bestTriangle = surfaceTriangle;
            bestPoint.copy(candidate);
        }
    });
    if (!bestTriangle) {
        const fallback = new THREE.Vector3(...interfacePlaneState.normal).normalize();
        return { point: point.clone(), normal: fallback.lengthSq() ? fallback : new THREE.Vector3(0, -1, 0) };
    }
    const barycentric = bestTriangle.triangle.getBarycoord(bestPoint, new THREE.Vector3());
    const normal = bestTriangle.normals[0].clone().multiplyScalar(barycentric.x)
        .addScaledVector(bestTriangle.normals[1], barycentric.y)
        .addScaledVector(bestTriangle.normals[2], barycentric.z)
        .normalize();
    const outward = bestPoint.clone().sub(bounds.getCenter(new THREE.Vector3()));
    if (normal.dot(outward) < 0) normal.negate();
    return { point: bestPoint, normal };
}

function setInterfacePositionFromQuery(queryPoint) {
    const closest = closestSurfacePoint(queryPoint);
    interfacePositionState.copy(closest.point);
    interfaceSurfaceNormal.copy(closest.normal);
    if (targetHandle) targetHandle.position.copy(interfacePositionState);
    syncInterfacePositionInputs();
    updateInterfaceOrientation();
}

function tangentDirection(direction, normal) {
    const tangent = direction.clone().addScaledVector(normal, -direction.dot(normal));
    if (tangent.lengthSq() > 1e-10) return tangent.normalize();
    const fallback = Math.abs(normal.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
    return fallback.addScaledVector(normal, -fallback.dot(normal)).normalize();
}

function basisQuaternion(x, y, z) {
    return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
}

function updateInterfacePlane() {
    if (!interfaceBounds || !interfacePointMesh) return;
    const data = planeData(interfaceBounds, interfacePlaneState, new THREE.Vector3(0, -1, 0));
    interfacePointMesh.position.copy(data.point);
    interfacePlaneMesh.position.copy(data.point);
    interfacePlaneOutline.position.copy(data.point);
    interfaceNormalArrow.position.copy(data.point);
    interfacePlaneMesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), data.normal);
    interfacePlaneOutline.quaternion.copy(interfacePlaneMesh.quaternion);
    interfaceNormalArrow.setDirection(data.normal);
    interfacePlaneMesh.visible = interfacePlaneOutline.visible = interfaceNormalArrow.visible = data.valid;
    syncPlaneMarks('interface');
    if (planeGuide?.kind === 'interface') checkPlaneGuide();
    if (interfacePositionFollowsPlane) {
        setInterfacePositionFromQuery(data.point);
    } else {
        updateInterfaceOrientation();
    }
}

function syncInterfacePositionInputs() {
    document.querySelectorAll('[data-interface-position]').forEach(output => {
        const axis = +output.dataset.interfacePosition;
        output.value = (interfacePositionState.getComponent(axis) * 1000).toFixed(2);
    });
}

// Interface Cap 10-17 added a Tripod/Wheelchair input. The walkthrough is Ollie's prosthetic, so
// it opens on Tripod, which is the behaviour every recorded answer was taken under.
let interfaceType = 'tripod';
let lastInterfaceAxes = null;   // what the angles turned about last time, for tests
const interfaceTypeSelect = document.getElementById('interface-type');
if (interfaceTypeSelect) {
    interfaceTypeSelect.addEventListener('change', () => {
        interfaceType = interfaceTypeSelect.value;
        updateInterfaceOrientation();
    });
}

function updateInterfaceOrientation() {
    if (!interfaceBounds || !orientedAssembly.children.length) return;
    const interfacePlane = planeData(interfaceBounds, interfacePlaneState, new THREE.Vector3(0, -1, 0));
    const pelvicPlane = planeData(pelvicBounds, planeState, new THREE.Vector3(1, 0, 0));
    const targetNormal = interfaceSurfaceNormal.clone();

    const projectedTarget = interfacePositionState.clone().addScaledVector(
        pelvicPlane.normal,
        -interfacePositionState.clone().sub(pelvicPlane.point).dot(pelvicPlane.normal),
    );
    // Where the interface position lands on the pelvic plane, as a direction from the plane's own
    // point. It lies in the plane, and the wheelchair type turns lateral about it.
    const towardProjected = projectedTarget.clone().sub(pelvicPlane.point).normalize();
    const targetX = tangentDirection(projectedTarget.sub(pelvicPlane.point), targetNormal);
    const targetY = targetNormal.clone().cross(targetX).normalize();
    const sourceX = tangentDirection(pelvicPlane.normal, interfacePlane.normal);
    const sourceY = interfacePlane.normal.clone().cross(sourceX).normalize();
    const base = basisQuaternion(targetX, targetY, targetNormal)
        .multiply(basisQuaternion(sourceX, sourceY, interfacePlane.normal).invert());

    const toRadians = THREE.MathUtils.degToRad;
    // The interface rotation turns about the solid interface's own field gradient in both types; a
    // mesh surface normal is the discrete equivalent of that gradient.
    const sourceGradient = closestSurfacePoint(interfacePlane.point, solidInterfaceTriangles, solidInterfaceBounds).normal;
    const wheelchair = interfaceType === 'wheelchair';

    // Tripod: lateral about the in-plane axis across the body, medial about the surface normal.
    // Wheelchair: lateral about the interface position projected onto the pelvic plane, and medial
    // about that crossed with the rotation axis.
    //
    // The rotation axis used for that cross product is the gradient carried through the base
    // orientation only. Carrying it through lateral and medial as well, which is what the final
    // spin axis uses, would need the medial axis before it could be worked out: medial would depend
    // on itself. Taking it from the base settles it and leaves the spin itself unchanged.
    const lateralAxis = wheelchair ? towardProjected : targetY;
    const baseRotationAxis = sourceGradient.clone().applyQuaternion(base).normalize();
    const medialAxis = wheelchair
        ? baseRotationAxis.clone().cross(lateralAxis).normalize()
        : targetNormal;
    const lateral = new THREE.Quaternion().setFromAxisAngle(lateralAxis, toRadians(orientationState.lateral));
    const medial = new THREE.Quaternion().setFromAxisAngle(medialAxis, toRadians(orientationState.medial));
    const preSpinQuaternion = medial.multiply(lateral).multiply(base).normalize();

    const spinAxis = sourceGradient.clone().applyQuaternion(preSpinQuaternion).normalize();
    const interfaceSpin = new THREE.Quaternion().setFromAxisAngle(spinAxis, toRadians(orientationState.rotation));
    lastInterfaceAxes = { type: interfaceType, lateral: lateralAxis.toArray(), medial: medialAxis.toArray(),
                          spin: spinAxis.toArray(), normal: targetNormal.toArray(),
                          projected: towardProjected.toArray(), rotation: baseRotationAxis.toArray() };
    const finalQuaternion = interfaceSpin.multiply(preSpinQuaternion).normalize();
    const adjustedTarget = interfacePositionState.clone().add(new THREE.Vector3(...orientationState.adjust).multiplyScalar(0.001));

    orientedAssembly.quaternion.copy(finalQuaternion);
    orientedAssembly.position.copy(adjustedTarget).sub(interfacePlane.point.clone().applyQuaternion(finalQuaternion));
    targetHandle.position.copy(interfacePositionState);
    const readout = document.getElementById('interface-position-readout');
    if (readout) {
        readout.textContent = [interfacePositionState.x, interfacePositionState.y, interfacePositionState.z]
            .map(value => (value * 1000).toFixed(2)).join(', ') + ' mm';
    }
}

function setVisibilityButton(button, visible) {
    if (!button) return;
    button.classList.toggle('active', visible);
    button.setAttribute('aria-label', (visible ? 'Hide ' : 'Show ') + button.getAttribute('aria-label').replace(/^(Hide|Show) /, ''));
}

function syncLayerMenus() {
    overlayControlsEl.querySelectorAll('.workflow-layer-menu').forEach(menu => {
        const inputs = Array.from(menu.querySelectorAll('input[data-view-layer]'));
        menu.querySelector('summary').classList.toggle('active', inputs.some(input => planeLayerVisibility[input.dataset.viewLayer]));
    });
    const guideKeys = ['point', 'normal', 'plane'];
    const guideButton = document.getElementById('pelvic-plane-visibility');
    setVisibilityButton(guideButton, guideKeys.some(key => planeLayerVisibility[key]));
}

function syncPlaneVisibility(key, visible) {
    const target = planeLayerTargets[key];
    if (!target) return;
    planeLayerVisibility[key] = visible;
    target.visible = visible;
    document.querySelectorAll('button[data-view-layer="' + key + '"]').forEach(button => setVisibilityButton(button, visible));
    document.querySelectorAll('input[data-view-layer="' + key + '"]').forEach(input => { input.checked = visible; });
    syncLayerMenus();
    applyPelvicStageVisibility();
    if (isPelvicStep(activeStep)) renderLegend();
}


// ---- Solid or see-through, the switch the design review page uses --------------------------------
// Each overlay chip has a second button that flips its layer between solid and see-through. The
// values below are where a layer sits until someone presses it.
const SEE_THROUGH = 0.3;
const ALPHA_LAYERS = { pelvic: ['attach', 'body', 'socket'], interface: ['reference', 'animal', 'mechanical', 'socket'] };
const layerAlphaChoice = {};   // 'pelvic:body' -> the alpha the student asked for

// Everything starts solid. The switch beside each layer in the viewer is how a layer is made
// see-through, and that choice then sticks across steps.
function defaultLayerAlpha(scope, key, stage) {
    if (scope === 'pelvic' && key === 'attach') return stage === '3' ? 0.14 : 0.78;
    return 1;
}

function layerAlphaTargets(scope, key) {
    if (scope === 'pelvic') return [planeLayerTargets[key]].filter(Boolean);
    if (key === 'socket') return [socketPreviewRoot, finalSocketRoot];
    return [interfaceLayerTargets[key]].filter(Boolean);
}

function layerAlphaValue(scope, key, stage) {
    return layerAlphaChoice[scope + ':' + key] ?? defaultLayerAlpha(scope, key, stage);
}

function applyLayerAlphas(scope, stage) {
    ALPHA_LAYERS[scope].forEach(key => {
        const value = layerAlphaValue(scope, key, stage);
        layerAlphaTargets(scope, key).forEach(target => target.traverse(object => {
            if (!object.isMesh || !object.material || object.userData.fixedAlpha) return;
            object.material.opacity = value;
            // A surface drawn over the body stays in the transparent pass and keeps writing depth
            // whatever its opacity: see showOverTheBody.
            object.material.transparent = value < 0.99 || !!object.userData.overTheBody;
            object.material.depthWrite = value >= 0.99 || !!object.userData.overTheBody;
            object.material.needsUpdate = true;
        }));
        const attribute = scope === 'pelvic' ? 'data-view-alpha' : 'data-interface-alpha';
        document.querySelectorAll('[' + attribute + '="' + key + '"]').forEach(button => {
            button.classList.toggle('is-see-through', value < 0.99);
            button.setAttribute('aria-pressed', String(value < 0.99));
        });
    });
}

function toggleLayerAlpha(scope, key) {
    const stage = activeStep;
    const now = layerAlphaValue(scope, key, stage);
    layerAlphaChoice[scope + ':' + key] = now >= 0.99 ? SEE_THROUGH : 1;
    applyLayerAlphas(scope, stage);
}

document.querySelectorAll('[data-view-alpha]').forEach(button => {
    button.addEventListener('click', () => toggleLayerAlpha('pelvic', button.dataset.viewAlpha));
});
document.querySelectorAll('[data-interface-alpha]').forEach(button => {
    button.addEventListener('click', () => toggleLayerAlpha('interface', button.dataset.interfaceAlpha));
});

function applyPelvicStageVisibility() {
    if (!isPelvicStep(activeStep)) return;
    overlayControlsEl.dataset.stage = activeStep;
    const isSocketStage = activeStep === '3';
    Object.entries(planeLayerTargets).forEach(([key, target]) => {
        // Step 3's Socket block takes the attachment surface, not the pelvic plane, so the plane guides stay in 2b.
        const stageAllows = ['box', 'point', 'normal', 'plane'].includes(key) ? !isSocketStage
            : key === 'socket' ? isSocketStage : true;
        target.visible = planeLayerVisibility[key] && stageAllows;
    });
    applyLayerAlphas('pelvic', activeStep);
}

function syncInterfaceLayerMenus() {
    document.querySelectorAll('[data-layer-menu="interface-plane"]').forEach(menu => {
        const inputs = Array.from(menu.querySelectorAll('input[data-interface-layer]'));
        menu.querySelector('summary').classList.toggle('active', inputs.some(input => interfaceLayerVisible(input.dataset.interfaceLayer)));
    });
    setVisibilityButton(
        document.getElementById('interface-plane-visibility'),
        ['point', 'normal', 'plane'].some(key => interfaceLayerVisible(key)),
    );
    setVisibilityButton(document.getElementById('interface-position-visibility'), interfaceLayerVisible('target'));
    document.querySelectorAll('[data-interface-group]').forEach(button => {
        const keys = interfaceLayerGroups[button.dataset.interfaceGroup] || [];
        setVisibilityButton(button, keys.some(key => interfaceLayerVisible(key)));
    });
}

function syncInterfaceVisibility(key, visible) {
    const target = interfaceLayerTargets[key];
    if (!target) return;
    setInterfaceLayerVisible(key, visible);
    target.visible = visible;
    document.querySelectorAll('button[data-interface-layer="' + key + '"]').forEach(button => setVisibilityButton(button, visible));
    document.querySelectorAll('input[data-interface-layer="' + key + '"]').forEach(input => { input.checked = visible; });
    syncInterfaceLayerMenus();
    applyInterfaceStageVisibility();
    if (isInterfaceStep(activeStep)) renderLegend();
}

function syncInterfaceGroupVisibility(group, visible) {
    (interfaceLayerGroups[group] || []).forEach(key => {
        setInterfaceLayerVisible(key, visible);
        document.querySelectorAll('button[data-interface-layer="' + key + '"]').forEach(button => setVisibilityButton(button, visible));
        document.querySelectorAll('input[data-interface-layer="' + key + '"]').forEach(input => { input.checked = visible; });
    });
    syncInterfaceLayerMenus();
    applyInterfaceStageVisibility();
}

// Scene-only visibility for one interface stage; the split pane calls this for the stage it previews.
function applyInterfaceSceneVisibility(stage) {
    // Step 3 only wants the oriented mechanical interface. The socket group belongs to the pelvic
    // stage there, so this leaves it alone.
    if (stage === '3') {
        ['animal', 'solid', 'target', 'reference', 'box', 'point', 'normal', 'plane', 'surfaceNormal', 'frame']
            .forEach(key => { interfaceLayerTargets[key].visible = false; });
        interfaceLayerTargets.mechanical.visible = socketStepLayerVisibility.mechanical;
        finalSocketRoot.visible = false;
        document.querySelectorAll('button[data-interface-layer="mechanical"]')
            .forEach(button => setVisibilityButton(button, socketStepLayerVisibility.mechanical));
        applyLayerAlphas('interface', '3');
        return;
    }
    const isPlane = stage === '2b';
    interfaceLayerTargets.reference.visible = isPlane && interfaceLayerVisibility.reference;
    ['animal', 'mechanical', 'solid', 'target'].forEach(key => {
        interfaceLayerTargets[key].visible = !isPlane && interfaceLayerVisibleIn(stage, key);
    });
    ['surfaceNormal', 'frame'].forEach(key => { interfaceLayerTargets[key].visible = false; });
    interfaceLayerTargets.box.visible = isPlane && interfaceLayerVisibility.box;
    ['point', 'normal', 'plane'].forEach(key => {
        interfaceLayerTargets[key].visible = isPlane && interfaceLayerVisibility[key];
    });
    if (stage === '2c') interfaceLayerTargets.solid.visible = false;
    interfaceLayerTargets.socket.visible = !isPlane && interfaceLayerVisibleIn(stage, 'socket');
    // Steps 5 and 6 show nTop's final socket (lattice blended into the interface) in place of the
    // Step 3 socket and the oriented interfaces.
    const blended = BLEND_STEPS.includes(stage) && finalSocketRoot.children.length > 0;
    finalSocketRoot.visible = blended && interfaceLayerVisibleIn(stage, 'socket');
    if (blended) {
        interfaceLayerTargets.socket.visible = false;
        interfaceLayerTargets.mechanical.visible = false;
        interfaceLayerTargets.solid.visible = false;
    }
}

function applyInterfaceStageVisibility() {
    if (!isInterfaceStep(activeStep)) return;
    applyInterfaceSceneVisibility(activeStep);
    ['animal', 'mechanical', 'solid', 'target', 'socket'].forEach(key => {
        document.querySelectorAll('button[data-interface-layer="' + key + '"]').forEach(button => setVisibilityButton(button, interfaceLayerVisible(key)));
    });
    syncPositionGizmo();
    interfaceOverlayControlsEl.dataset.stage = activeStep;
    applyLayerAlphas('interface', activeStep);
}

function renderLegend() {
    // Layer controls live over the viewer; the former bottom legend is intentionally removed.
}

const highlightedMaterials = new Map();
let highlightedControl = null;

function highlightTargetsForControl(control) {
    if (!control) return [];
    if (control.dataset.toggleModel) return [layers[control.dataset.toggleModel]?.group].filter(Boolean);
    if (control.dataset.viewLayer) return [planeLayerTargets[control.dataset.viewLayer]].filter(Boolean);
    if (control.dataset.interfaceLayer) return [interfaceLayerTargets[control.dataset.interfaceLayer]].filter(Boolean);
    if (control.dataset.interfaceGroup) {
        return (interfaceLayerGroups[control.dataset.interfaceGroup] || []).map(key => interfaceLayerTargets[key]).filter(Boolean);
    }
    if (control.dataset.highlightInterfaceGroup) {
        return (interfaceLayerGroups[control.dataset.highlightInterfaceGroup] || []).map(key => interfaceLayerTargets[key]).filter(Boolean);
    }
    if (control.dataset.highlightPlaneGroup === 'plane') {
        return ['point', 'normal', 'plane'].map(key => planeLayerTargets[key]);
    }
    return [];
}

function clearViewerHighlight() {
    highlightedMaterials.forEach((state, material) => {
        if (state.color && material.color) material.color.copy(state.color);
        if (state.emissive && material.emissive) material.emissive.copy(state.emissive);
        if (state.emissiveIntensity !== undefined) material.emissiveIntensity = state.emissiveIntensity;
        material.needsUpdate = true;
    });
    highlightedMaterials.clear();
    highlightedControl = null;
}

function showViewerHighlight(control) {
    if (control === highlightedControl) return;
    clearViewerHighlight();
    const targets = highlightTargetsForControl(control);
    if (!targets.length) return;
    targets.forEach(target => {
        target.updateMatrixWorld(true);
        target.traverse(object => {
            if (!object.material) return;
            const materials = Array.isArray(object.material) ? object.material : [object.material];
            materials.forEach(material => {
                if (highlightedMaterials.has(material)) return;
                highlightedMaterials.set(material, {
                    color: material.color?.clone(),
                    emissive: material.emissive?.clone(),
                    emissiveIntensity: material.emissiveIntensity,
                });
                if (material.emissive) {
                    material.emissive.setHex(0xfdb515);
                    material.emissiveIntensity = 0.7;
                } else if (material.color) {
                    material.color.setHex(0xfdb515);
                }
                material.needsUpdate = true;
            });
        });
    });
    highlightedControl = control;
}

const highlightSelector = '[data-toggle-model], [data-view-layer], [data-interface-layer], [data-interface-group], [data-highlight-plane-group], [data-highlight-interface-group]';
document.addEventListener('pointerover', event => {
    const control = event.target.closest(highlightSelector);
    if (control) showViewerHighlight(control);
});
document.addEventListener('pointerout', event => {
    if (!highlightedControl || highlightedControl.contains(event.relatedTarget)) return;
    clearViewerHighlight();
});
document.addEventListener('focusin', event => {
    const control = event.target.closest(highlightSelector);
    if (control) showViewerHighlight(control);
});
document.addEventListener('focusout', event => {
    if (!highlightedControl || highlightedControl.contains(event.relatedTarget)) return;
    clearViewerHighlight();
});

function syncImportVisibility(key, visible) {
    const layer = layers[key];
    if (!layer) return;
    layer.visible = visible;
    layer.group.visible = visible && activeStep === '1';
    document.querySelectorAll('[data-toggle-model="' + key + '"]').forEach(button => setVisibilityButton(button, visible));
    renderLegend();
}

function catalogFileName(file) {
    return file.split('/').pop().split('?')[0];
}

function syncImportPathLabels() {
    Object.entries(importSelection).forEach(([role, entry]) => {
        const output = document.querySelector('[data-path-label="' + role + '"]');
        if (!output) return;
        output.textContent = entry ? entry.name : 'Browse for a file';
        output.title = entry ? entry.pathLabel : 'No file chosen';
        output.classList.toggle('is-empty', !entry);
        const select = document.querySelector('[data-import-unit="' + role + '"]');
        if (select) select.value = layers[role].importUnit;
    });
    syncImportAlerts();
    syncImportGate();
}

// Steps 2a onward need all four meshes, so they stay out of the way until the imports are in.
function syncImportGate() {
    const ready = importsReady();
    document.body.classList.toggle('imports-pending', !ready);
    document.querySelectorAll('[data-go-step]').forEach(button => {
        const target = button.dataset.goStep;
        button.disabled = !ready && target !== '1';
    });
    const note = document.getElementById('import-gate-note');
    if (note) {
        note.hidden = ready;
        const missing = IMPORT_ROLE_KEYS.filter(role => !importSelection[role]).map(role => IMPORT_ROLES[role].name);
        note.textContent = missing.length
            ? 'Still to import: ' + missing.join(', ') + '. The rest of the workflow opens once all four meshes are in.'
            : '';
    }
}

const importStatusEl = document.getElementById('import-status');
const importAlertsEl = document.getElementById('import-alerts');
const importAlertChipEl = document.getElementById('import-alert-chip');
const IMPORT_WARN_ICON = '<svg class="import-warn-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5 22 20.5H2Z"/><path d="M12 10v5"/><circle cx="12" cy="17.6" r="0.6"/></svg>';
let importAlertSignature = '[]';

// Files that only work as a set: both interfaces come from one dog, and an attachment surface
// is cut from one scan.
function importMismatches() {
    const { solidAnimal, attachment, mechanical, solidInterface } = importSelection;
    const breedLabel = slug => IMPORT_BREEDS.find(breed => breed.slug === slug)?.label || slug;
    const found = [];
    if (mechanical && solidInterface && mechanical.sizeClass !== solidInterface.sizeClass) {
        found.push({
            key: 'interface', chip: 'Interface mismatch', title: 'Interfaces do not match',
            detail: `Mechanical: ${mechanical.label} · Solid: ${solidInterface.label}`,
            notes: {
                mechanical: `Does not pair with ${solidInterface.name}.`,
                solidInterface: `Does not pair with ${mechanical.name}.`,
            },
        });
    }
    if (attachment && solidAnimal && attachment.breed !== solidAnimal.breed) {
        found.push({
            key: 'scan', chip: 'Scan mismatch', title: 'Scan and attachment surface do not match',
            detail: `Solid animal: ${breedLabel(solidAnimal.breed)} · Attachment surface: ${breedLabel(attachment.breed)}`,
            notes: {
                solidAnimal: `${attachment.name} was cut from a different scan.`,
                attachment: `Cut from the ${breedLabel(attachment.breed)} scan. Pick one from the ${breedLabel(solidAnimal.breed)} folder.`,
            },
        });
    }
    return found;
}

function syncImportAlerts() {
    const mismatches = importMismatches();
    const signature = JSON.stringify(mismatches) + '|' + importedCount();
    if (signature === importAlertSignature) return;
    const previousKeys = JSON.parse(importAlertSignature.split('|')[0]).map(item => item.key);
    importAlertSignature = signature;
    const notes = Object.assign({}, ...mismatches.map(item => item.notes));
    Object.keys(importSelection).forEach(role => {
        const node = document.querySelector('.workflow-node[data-model="' + role + '"]');
        const note = node.querySelector('[data-import-note]');
        node.classList.toggle('has-mismatch', role in notes);
        node.querySelector('.workflow-node-type').textContent = role in notes ? 'Mismatch' : 'Import Mesh';
        note.hidden = !(role in notes);
        note.textContent = notes[role] || '';
    });
    const count = importedCount();
    importStatusEl.classList.toggle('is-warning', mismatches.length > 0 || count < 4);
    importStatusEl.innerHTML = mismatches.length ? IMPORT_WARN_ICON + ' Mismatch'
        : count < 4 ? '<i data-lucide="circle-dashed" aria-hidden="true"></i> ' + count + ' of 4'
        : '<i data-lucide="circle-check" aria-hidden="true"></i> Ready';
    importStatusEl.dataset.count = String(count);
    importAlertsEl.hidden = !mismatches.length;
    importAlertsEl.innerHTML = mismatches.map(item => `<p>${IMPORT_WARN_ICON}<strong>${item.title}</strong><span>${item.detail}</span></p>`).join('');
    importAlertChipEl.hidden = !mismatches.length;
    importAlertChipEl.querySelector('span').textContent = mismatches.length > 1 ? mismatches.length + ' import mismatches' : mismatches[0]?.chip || '';
    importAlertChipEl.title = mismatches.map(item => item.title + ' (' + item.detail + ')').join('\n');
    // Pulse the chip when a new mismatch appears, not when one is fixed.
    if (mismatches.some(item => !previousKeys.includes(item.key))) {
        importAlertChipEl.classList.remove('is-pulsing');
        void importAlertChipEl.offsetWidth;
        importAlertChipEl.classList.add('is-pulsing');
    }
    window.lucide?.createIcons({ attrs: { 'stroke-width': 1.8 } });
}

importAlertChipEl?.addEventListener('click', () => {
    const node = document.querySelector('.workflow-node.has-mismatch');
    if (node) node.open = true;
    showStep('1', true);
});

async function loadImportSelection(role, entry) {
    const layer = layers[role];
    const previous = importSelection[role];
    importSelection[role] = entry;
    // A different case has its own Spatial Weight Types (the wheelchair one only Point & Curve) and starts on its own.
    if (role === 'solidAnimal' || role === 'attachment') syncSpatialWeightTypeChoices({ resetToDefault: previous?.breed !== entry?.breed });
    clearImportStage();
    syncImportPathLabels();
    loaderEl.hidden = false;
    loaderEl.classList.remove('error');
    loaderEl.querySelector('p').textContent = 'Importing ' + entry.name + '…';
    try {
        layer.baseUnit = layer.importUnit = entry.units;
        await replaceImportLayer(role, entry);
        syncImportVisibility(role, true);
        importBounds = new THREE.Box3().setFromObject(importRoot);
        if (importsReady()) {
            rebuildPelvicScene();
            buildInterfaceScene();
        }
        if (role === 'attachment' && importsReady() && hasSocketModelLibrary()) {
            // A different surface means a different sweep set: refresh the socket and blended socket in view.
            loadSocketParameterModel(activeSocketParameter, socketParameterState[activeSocketParameter]);
            loadFinalSocket(activeBlendParameter, blendState[activeBlendParameter]);
        }
        syncImportPathLabels();
        clearMeasurement();
        showStep(activeStep);
        // The interfaces are a few centimetres across and sit at the world origin, a long way from the
        // scan, so framing the whole assembly would lose them. Go to the mesh that was just imported.
        if (activeStep === '1') requestAnimationFrame(() => frameObject(layer.group));
        // A different case can mean a different blend sweep, with its own steps.
        if (role === 'solidAnimal' || role === 'attachment') syncBlendSliderRanges();
        if (role === 'attachment') showOverTheBody(layer.group);
        layoutImportPreview();
        // There is nothing to turn around until a mesh is in, so the movement guide waits for the scan.
        // Not on requestAnimationFrame: a window that is not painting (another tab in front, a
        // phone with the page in the background) never runs those callbacks, and the guide would
        // simply never appear. force, because someone who dismissed it on an earlier visit should
        // still get it when the scan finally shows up; introShown keeps it to once a visit.
        if (role === 'solidAnimal' && !introShown) {
            introShown = true;
            setTimeout(() => viewerControls.startIntro({ force: true }), 450);
        }
        loaderEl.hidden = true;
    } catch (error) {
        importSelection[role] = previous;
        syncImportPathLabels();
        loaderEl.classList.add('error');
        loaderEl.querySelector('p').textContent = 'This model could not be loaded.';
        console.error(error);
    }
}

// ---- Import explorer: nTop-style folder dropdown under each Path field ----------------------

const importExplorerFolders = Object.fromEntries(Object.keys(importSelection).map(role => [role, startFolder(role)]));
const importGhost = new THREE.Group();
importGhost.visible = false;
scene.add(importGhost);
const importGhostHint = document.getElementById('import-preview-hint');
let importStage = null; // { role, entry }
let importGhostToken = 0;

function clearImportStage() {
    importStage = null;
    importGhostToken++;
    importGhost.clear();
    importGhost.visible = false;
    importGhostHint.hidden = true;
    document.querySelectorAll('[data-import-explorer]:not([hidden])').forEach(renderImportExplorer);
}

async function stageImport(role, entry) {
    importStage = { role, entry };
    const token = ++importGhostToken;
    importGhostHint.hidden = false;
    importGhostHint.innerHTML = '<strong>Previewing</strong> ' + entry.name + ' <span>double-click it or press Load to import</span>';
    document.querySelectorAll('[data-import-explorer]:not([hidden])').forEach(renderImportExplorer);
    try {
        const gltf = await loadGLB(entry.preview);
        if (token !== importGhostToken) return;
        const object = gltf.scene;
        normalizeMillimeterExport(object);
        object.traverse(child => {
            if (!child.isMesh) return;
            child.material = new THREE.MeshStandardMaterial({ dithering: true,
                color: 0xff3fa4, transparent: true, opacity: 0.55, roughness: 0.5, depthWrite: false, side: THREE.DoubleSide,
            });
            child.userData.measureSurface = false;
        });
        importGhost.clear();
        importGhost.add(object);
        importGhost.visible = activeStep === '1';
    } catch (error) {
        console.error(error);
    }
}

function renderImportExplorer(explorer) {
    const role = explorer.dataset.importExplorer;
    const current = importExplorerFolders[role];
    const entries = folderEntries(current);
    explorer.innerHTML = `
        <div class="import-crumbs">${current.path.map((name, index) => `${index ? '<i data-lucide="chevron-right" aria-hidden="true"></i>' : ''}<button type="button" data-crumb="${current.path.slice(0, index + 1).join('|')}">${name}</button>`).join('')}</div>
        <div class="import-entries" role="listbox" aria-label="${IMPORT_ROLES[role].short} files">${entries.map((entry, index) => entry.kind === 'folder'
            ? `<button type="button" class="import-entry folder" data-index="${index}"><i data-lucide="folder" aria-hidden="true"></i><strong>${entry.name}</strong><small>${entry.children.length} items</small></button>`
            : `<button type="button" class="import-entry ${entry.role === role ? '' : 'dim'} ${importSelection[role] === entry ? 'loaded' : ''}" data-index="${index}" role="option" aria-selected="${importSelection[role] === entry}" title="${entry.role === role ? 'Import ' + entry.label : 'This is a ' + IMPORT_ROLES[entry.role].short.toLowerCase() + ' mesh'}"><i data-lucide="box" aria-hidden="true"></i><strong>${entry.name}</strong><small>${formatBytes(entry.bytes)}</small></button>`).join('')}</div>
        `;
    explorer.querySelectorAll('[data-crumb]').forEach(button => button.addEventListener('click', () => {
        importExplorerFolders[role] = resolveImportPath(button.dataset.crumb.split('|'));
        renderImportExplorer(explorer);
    }));
    explorer.querySelectorAll('.import-entry').forEach(row => {
        const entry = entries[+row.dataset.index];
        row.addEventListener('click', () => {
            if (entry.kind === 'folder') {
                importExplorerFolders[role] = entry;
                renderImportExplorer(explorer);
                return;
            }
            // Clicking a file imports it; the other roles' meshes are greyed out and do nothing.
            if (entry.role !== role || importSelection[role] === entry) return;
            loadImportSelection(role, entry).then(() => toggleImportExplorer(role, false));
        });
    });
    window.lucide?.createIcons({ attrs: { 'stroke-width': 1.8 } });
}

function toggleImportExplorer(role, open) {
    document.querySelectorAll('[data-import-explorer]').forEach(explorer => {
        const isTarget = explorer.dataset.importExplorer === role;
        const show = isTarget ? open : false;
        explorer.hidden = !show;
        document.querySelector('[data-import-browse="' + explorer.dataset.importExplorer + '"]').setAttribute('aria-expanded', String(show));
        if (show) renderImportExplorer(explorer);
    });
    if (!open || importStage?.role !== role) clearImportStage();
}

document.querySelectorAll('[data-import-browse]').forEach(button => {
    button.addEventListener('click', () => {
        toggleImportExplorer(button.dataset.importBrowse, button.getAttribute('aria-expanded') !== 'true');
    });
});
document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && importStage) clearImportStage();
});

document.querySelectorAll('[data-import-unit]').forEach(select => {
    select.addEventListener('change', () => {
        const key = select.dataset.importUnit;
        const layer = layers[key];
        if (!layer || !UNIT_TO_METERS[select.value]) return;
        layer.importUnit = select.value;
        applyImportUnitScale(layer);
        importBounds = new THREE.Box3().setFromObject(importRoot);
        if (importsReady()) {
            if (key === 'solidAnimal' || key === 'attachment') rebuildPelvicScene();
            buildInterfaceScene();
        }
        clearMeasurement();
        if (activeStep === '1') requestAnimationFrame(() => frameObject(importRoot));
        if (isPelvicStep(activeStep)) requestAnimationFrame(() => frameObject(planeRoot));
    });
});

syncImportPathLabels();

// ---- Step 1 scale factor ----------------------------------------------------------------------
const scaleFactorInput = document.getElementById('scale-factor');
const scaleFactorSlider = document.getElementById('scale-factor-slider');
// The note under the block was removed; what the explainer is showing is said in the viewer title.
const scaleNoteEl = { hidden: true, textContent: '' };
const scaleHelpButton = document.getElementById('scale-help');

// The ? beside Scale Factor: the scan as imported, as a ghost, with the scaled scan solid inside it.
// The solid one is scaled about the scan's own centroid, so the difference reads as growth or
// shrinkage in place rather than a slide across the scene.
const scaleDemoRoot = new THREE.Group();
scaleDemoRoot.visible = false;
scene.add(scaleDemoRoot);
let scaleDemoOn = false;
let scaleDemoPivot = null;

function styleScaleDemo(object, color, opacity) {
    object.traverse(child => {
        if (!child.isMesh) return;
        child.material = new THREE.MeshStandardMaterial({ dithering: true,
            color, roughness: 0.78, metalness: 0,
            transparent: opacity < 1, opacity,
            depthWrite: opacity >= 1, side: THREE.DoubleSide,
        });
        child.castShadow = false;
        child.receiveShadow = false;
        child.userData.measureSurface = false;
    });
}

function buildScaleDemo() {
    scaleDemoRoot.clear();
    scaleDemoPivot = null;
    const layer = layers.solidAnimal;
    if (!layer.group.children.length) return false;
    const unit = (UNIT_TO_METERS[layer.importUnit] || 1) / (UNIT_TO_METERS[layer.baseUnit] || 1);

    const ghost = layer.group.clone(true);
    ghost.scale.setScalar(unit);
    ghost.updateMatrixWorld(true);
    styleScaleDemo(ghost, 0x8d98a7, 0.22);
    ghost.traverse(child => { if (child.isMesh) child.renderOrder = 4; });
    scaleDemoRoot.add(ghost);

    const centre = new THREE.Box3().setFromObject(ghost).getCenter(new THREE.Vector3());
    const inner = layer.group.clone(true);
    inner.scale.setScalar(unit);
    inner.position.set(-centre.x, -centre.y, -centre.z);
    styleScaleDemo(inner, PART_COLOR.solidAnimal, 1);
    const pivot = new THREE.Group();
    pivot.position.copy(centre);
    pivot.add(inner);
    scaleDemoRoot.add(pivot);
    scaleDemoPivot = pivot;
    pivot.scale.setScalar(scaleFactor);
    return true;
}

function scaleDemoText() {
    return `Ghost: Ollie's scan as imported (1.00). Solid: the same scan at ${scaleFactor.toFixed(2)}, scaled about its centroid. nTop scales the scan this way before the socket is built; Ollie uses 0.95.`;
}

function syncScaleNote() {
    if (scaleDemoOn) {
        scaleNoteEl.hidden = false;
        scaleNoteEl.textContent = scaleDemoText();
        return;
    }
    scaleNoteEl.hidden = scaleFactor === 1;
    scaleNoteEl.textContent = scaleFactor === 1 ? '' : `Animal scan scaled by ${scaleFactor}. The sample sockets were generated for the unscaled scan, so the socket preview stays at scale 1.`;
}

function setScaleDemo(on) {
    const ready = on ? buildScaleDemo() : false;
    scaleDemoOn = ready;
    scaleDemoRoot.visible = scaleDemoOn;
    if (on && !ready) {
        scaleNoteEl.hidden = false;
        scaleNoteEl.textContent = 'Import Ollie\u2019s scan first, then this shows what the scale factor does to it.';
    } else {
        syncScaleNote();
    }
    scaleHelpButton.setAttribute('aria-pressed', String(scaleDemoOn));
    scaleHelpButton.classList.toggle('is-on', scaleDemoOn);
    scaleHelpButton.title = scaleDemoOn ? 'Hide the scale factor comparison' : 'Show the scan at 1.0 against the scaled scan';
    syncScaleDemoMode();
    importRoot.visible = !scaleDemoOn && activeStep === '1';
    importGhost.visible = !scaleDemoOn && activeStep === '1' && importGhost.children.length > 0;
    syncPositionGizmo();   // nothing from the interface steps belongs in this view
    viewerTitleEl.textContent = !scaleDemoOn ? 'Imported mesh assembly'
        : ready ? `Scale factor: ghost at 1.00, solid at ${scaleFactor.toFixed(2)}, scaled about its centroid`
        : 'Import Ollie\u2019s scan first to see what the scale factor does';
    requestAnimationFrame(() => frameObject(scaleDemoOn ? scaleDemoRoot : importRoot));
}

// The ? alone is easy to miss, so the framed view says what it is showing and how to leave it.
function syncScaleDemoMode() {
    setViewerMode('scale', scaleDemoOn ? {
        name: 'Compare mode',
        text: `The scan as imported (ghost) against the same scan at ${scaleFactor.toFixed(2)}.`,
        done: () => setScaleDemo(false),
    } : null);
}

scaleHelpButton.addEventListener('click', () => setScaleDemo(!scaleDemoOn));

function setScaleFactor(value, reframe = true) {
    scaleFactor = value;
    scaleFactorInput.value = String(value);
    scaleFactorSlider.value = String(value);
    Object.values(layers).forEach(applyImportUnitScale);
    importBounds = new THREE.Box3().setFromObject(importRoot);
    if (importsReady()) {
        rebuildPelvicScene();
        buildInterfaceScene();
    }
    clearMeasurement();
    if (scaleDemoPivot) scaleDemoPivot.scale.setScalar(scaleFactor);
    layoutImportPreview();   // the animal just changed size, so the row beside it moves
    syncPositionGizmo();
    syncScaleNote();
    if (scaleDemoOn) {
        viewerTitleEl.textContent = `Scale factor: ghost at 1.00, solid at ${scaleFactor.toFixed(2)}, scaled about its centroid`;
        syncScaleDemoMode();
        return;
    }
    if (!reframe) return;
    if (activeStep === '1') requestAnimationFrame(() => frameObject(importRoot));
    if (isPelvicStep(activeStep)) requestAnimationFrame(() => frameObject(planeRoot));
}

scaleFactorSlider.addEventListener('input', () => {
    const value = Math.round(Number(scaleFactorSlider.value) * 100) / 100;
    if (value !== scaleFactor) setScaleFactor(value, false);
});
{
    const commit = () => {
        const value = Number(scaleFactorInput.value);
        if (scaleFactorInput.value === '' || !Number.isFinite(value) || value < 0.5 || value > 1.5) { scaleFactorInput.value = String(scaleFactor); return; }
        if (value !== scaleFactor) setScaleFactor(Math.round(value * 1000) / 1000);
    };
    scaleFactorInput.addEventListener('change', commit);
    scaleFactorInput.addEventListener('keydown', event => { if (event.key === 'Enter') { commit(); scaleFactorInput.blur(); } });
}

// ---- Design values without nTop sweeps yet (Steps 3, 4b, 5, 6) ---------------------------------
// They are recorded and shown, and a note says the preview mesh does not change for them.
const designValues = { socket: {}, attachment: {}, blend: {}, export: {} };
function designFieldValue(input) {
    if (input.type === 'checkbox') return input.checked;
    if (input.tagName === 'SELECT' || input.type === 'text') return input.value;
    const value = Number(input.value);
    return Number.isFinite(value) ? value : null;
}
function formatDesignValue(value, unit) {
    if (typeof value === 'boolean') return value ? 'on' : 'off';
    return `${value}${unit ? ' ' + unit : ''}`;
}
function syncDesignMirrors(path) {
    const [group, key] = path.split('.');
    document.querySelectorAll(`[data-mirror-output="${path}"]`).forEach(output => {
        const unit = output.closest('.workflow-source-row')?.querySelector('small')?.textContent || 'mm';
        output.textContent = `${output.textContent.split(' · ')[0]} · ${formatDesignValue(designValues[group][key], unit)}`;
    });
}
document.querySelectorAll('[data-design-field]').forEach(input => {
    const [group, key] = input.dataset.designField.split('.');
    designValues[group][key] = designFieldValue(input);
    const unit = input.parentElement.querySelector('small')?.textContent || '';
    const commit = () => {
        const value = designFieldValue(input);
        if (value === null) { input.value = String(designValues[group][key]); return; }
        if (value === designValues[group][key]) return;
        designValues[group][key] = value;
        if (input.dataset.mirror) syncDesignMirrors(input.dataset.mirror);
        const note = input.closest('.workflow-step')?.querySelector('[data-pending-note]');
        if (note && 'pending' in input.dataset) {
            note.hidden = false;
            note.textContent = `${input.dataset.designLabel} set to ${formatDesignValue(value, unit)}. nTop meshes for this value are not generated yet, so the preview does not change.`;
        }
    };
    input.addEventListener('change', commit);
    input.addEventListener('keydown', event => { if (event.key === 'Enter' && input.type !== 'checkbox') { commit(); input.blur(); } });
});

// ---- Step 6 export: download the nTop socket mesh shown in the viewer ---------------------------
const exportPathInput = document.getElementById('export-path');
const exportRunButton = document.getElementById('export-run');
document.getElementById('export-browse').addEventListener('click', () => { exportPathInput.focus(); exportPathInput.select(); });
exportRunButton.addEventListener('click', async () => {
    const note = document.querySelector('#workflow-step-6 [data-pending-note]');
    note.hidden = false;
    const exportFile = currentFinalFile || currentSocketFile;
    if (!exportFile) {
        note.textContent = 'No socket mesh is loaded for this selection, so there is nothing to export yet.';
        return;
    }
    const base = (exportPathInput.value.trim().split(/[\\/]/).pop() || '').replace(/\.[a-z0-9]+$/i, '').replace(/[^\w.-]+/g, '_') || 'socket';
    exportRunButton.disabled = true;
    note.textContent = 'Preparing the mesh…';
    try {
        // Sweep files live in the model bucket; fall back to the site copy if it is unreachable.
        const fetchModel = async url => { const response = await fetch(url); if (!response.ok) throw new Error(response.status); return response.blob(); };
        const blob = await fetchModel(modelUrl(exportFile)).catch(() => fetchModel(exportFile));
        const url = URL.createObjectURL(blob);
        const link = Object.assign(document.createElement('a'), { href: url, download: `${base}.glb` });
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
        note.textContent = `Exported ${base}.glb: ${currentFinalFile ? 'the blended socket from Step 5' : 'the nTop socket mesh shown in the viewer'} (${designValues.export.units}). Tolerance, sharpen and remesh are applied when nTop meshes the implicit, not here.`;
    } catch (error) {
        note.textContent = 'The mesh could not be downloaded. Try again.';
        console.error(error);
    }
    exportRunButton.disabled = false;
});

function showStep(step, shouldScroll = false) {
    clearViewerHighlight();
    clearMeasurement();
    const requested = String(step);
    // In split view Step 2c keeps the main canvas (it owns the drag handle) and Step 2b is drawn
    // in the second pane, so either step lands on the same paired layout.
    const paired = splitPaired(requested);
    if (paired && shouldScroll) splitReturnStep = requested;
    activeStep = paired ? '2c' : requested;
    const isImport = activeStep === '1';
    const isPelvic = isPelvicStep(activeStep);
    const isInterface = isInterfaceStep(activeStep);
    const isAttachment = isAttachmentStep(activeStep);
    const titles = {
        '1': 'Imported mesh assembly',
        '2a': 'Pelvic plane location',
        '3': 'Socket lattice parameters',
        '2b': 'Interface plane location',
        '2c': 'Interface target position',
        '2d': 'Oriented interface',
        '4a': 'Attachment points',
        '4b': 'Attachment holes',
        '5': 'Blended socket assembly',
        '6': 'Mesh for export',
    };
    importRoot.visible = isImport;
    importGhost.visible = isImport && importGhost.children.length > 0;
    // The Scale Factor explainer owns the viewer while it is open, and only in Step 1.
    if (scaleDemoOn && !isImport) setScaleDemo(false);
    else if (scaleDemoOn) { importRoot.visible = false; importGhost.visible = false; }
    planeRoot.visible = isPelvic;
    (isAttachment ? attachmentHoles.root : isInterface ? interfaceRoot : planeRoot).add(socketPreviewRoot);
    if (isAttachment) {
        socketPreviewRoot.visible = planeLayerVisibility.socket;
        loadSocketParameterModel(activeSocketParameter, socketParameterState[activeSocketParameter]);
    }
    interfaceRoot.visible = isInterface || activeStep === '3';
    overlayControlsEl.hidden = !isPelvic;
    interfaceOverlayControlsEl.hidden = !isInterface;
    positionTransform.enabled = false;
    positionTransformHelper.visible = false;
    attachmentHoles.setActive(isAttachment, layers.attachment.group, layers.solidAnimal.group);
    attachmentHoles.setPreview(BLEND_STEPS.includes(activeStep));
    if (isPelvic) {
        applyPelvicStageVisibility();
        if (activeStep === '2a') {
            loadPelvicPlaneTestModel(activePelvicPlanePreset);
        } else {
            loadSocketParameterModel(activeSocketParameter, socketParameterState[activeSocketParameter]);
            applyInterfaceSceneVisibility('3');
        }
    } else if (isInterface) {
        loadSocketParameterModel(activeSocketParameter, socketParameterState[activeSocketParameter]);
        if (BLEND_STEPS.includes(activeStep)) loadFinalSocket(activeBlendParameter, blendState[activeBlendParameter]);
        if (targetHandle) positionTransform.attach(targetHandle);
        applyInterfaceStageVisibility();
        syncInterfaceLayerMenus();
    } else if (!isAttachment) {
        positionTransform.enabled = false;
        positionTransformHelper.visible = false;
    }
    if (practice.on && activeStep !== '2a' && activeStep !== '2b') setPractice(false);
    renderPractice();
    viewerStepEl.textContent = paired ? 'Steps 2b + 2c' : 'Step ' + activeStep;
    viewerTitleEl.textContent = paired ? 'Interface position and plane' : titles[activeStep];
    document.querySelectorAll('.workflow-step').forEach(section => {
        section.classList.toggle('active', section.dataset.step === activeStep || (paired && SPLIT_STEPS.includes(section.dataset.step)));
    });
    const major = activeStep.charAt(0);
    document.querySelectorAll('.workflow-progress-step').forEach(button => button.classList.toggle('active', button.dataset.goStep.charAt(0) === major));
    renderLegend();
    syncPelvicAnswer();
    syncInterfaceAnswer();
    if (planeGuide && activeStep !== (planeGuide.kind === 'pelvic' ? '2a' : '2b')) stopPlaneGuide();
    syncAttachmentSolo();
    walkthroughNotes?.setStep();
    syncSplitLayout();
    requestAnimationFrame(frameActiveStep);
    if (shouldScroll) {
        // The pair scrolls to its first section (the interface plane, Step 2b).
        const section = document.getElementById('workflow-step-' + (paired ? '2b' : activeStep));
        const offset = () => section.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top;
        scrollEl.scrollTo({ top: offset() + scrollEl.scrollTop, behavior: 'smooth' });
        // The socket loading note above can show for a moment and shift the layout mid-scroll;
        // settle on the heading once it has gone.
        const settledStep = activeStep;
        clearTimeout(stepScrollTimer);
        stepScrollTimer = setTimeout(() => {
            const drift = offset();
            if (activeStep === settledStep && drift && Math.abs(drift) < 60) scrollEl.scrollTo({ top: drift + scrollEl.scrollTop, behavior: 'smooth' });
        }, 700);
    }
}
let stepScrollTimer = null;

document.addEventListener('click', event => {
    const eye = event.target.closest('[data-toggle-model]');
    if (eye) {
        event.preventDefault();
        event.stopPropagation();
        const key = eye.dataset.toggleModel;
        syncImportVisibility(key, !layers[key].visible);
        return;
    }
    const legendButton = event.target.closest('[data-legend-model]');
    if (legendButton) {
        const key = legendButton.dataset.legendModel;
        syncImportVisibility(key, !layers[key].visible);
        return;
    }
    const layerButton = event.target.closest('button[data-view-layer]');
    if (layerButton) {
        const key = layerButton.dataset.viewLayer;
        syncPlaneVisibility(key, !planeLayerVisibility[key]);
        return;
    }
    const interfaceGroupButton = event.target.closest('button[data-interface-group]');
    if (interfaceGroupButton) {
        event.preventDefault();
        event.stopPropagation();
        const group = interfaceGroupButton.dataset.interfaceGroup;
        const keys = interfaceLayerGroups[group] || [];
        const next = !keys.some(key => interfaceLayerVisible(key));
        syncInterfaceGroupVisibility(group, next);
        return;
    }
    const interfaceLayerButton = event.target.closest('button[data-interface-layer]');
    if (interfaceLayerButton) {
        const key = interfaceLayerButton.dataset.interfaceLayer;
        syncInterfaceVisibility(key, !interfaceLayerVisible(key));
        return;
    }
    const stepButton = event.target.closest('[data-go-step]');
    if (stepButton) showStep(stepButton.dataset.goStep, true);
});

document.querySelectorAll('.workflow-node').forEach(node => {
    node.addEventListener('toggle', () => {
        if (!node.open) {
            const role = node.dataset.model;
            if (role && !node.querySelector('[data-import-explorer]')?.hidden) toggleImportExplorer(role, false);
            return;
        }
        document.querySelectorAll('.workflow-node[open]').forEach(other => {
            if (other !== node) other.open = false;
        });
    });
});

document.querySelectorAll('[data-axis]').forEach(select => {
    select.addEventListener('change', () => {
        planeState.pick[+select.dataset.axis] = +select.value;
        const slider = document.querySelector(`[data-pelvic-axis-slider="${select.dataset.axis}"]`);
        if (slider) slider.value = select.value;
        updatePlane();
    });
});
document.querySelectorAll('[data-normal]').forEach(input => {
    const commit = () => {
        const value = Number(input.value);
        planeState.normal[+input.dataset.normal] = input.value !== '' && Number.isFinite(value) ? value : 0;
        input.value = String(planeState.normal[+input.dataset.normal]);
        updatePlane();
    };
    input.addEventListener('change', commit);
    input.addEventListener('keydown', event => { if (event.key === 'Enter') { commit(); input.blur(); } });
});

document.querySelectorAll('[data-interface-axis]').forEach(select => {
    select.addEventListener('change', () => {
        interfacePlaneState.pick[+select.dataset.interfaceAxis] = +select.value;
        const slider = document.querySelector('[data-interface-axis-slider="' + select.dataset.interfaceAxis + '"]');
        if (slider) slider.value = select.value;
        updateInterfacePlane();
    });
});
document.querySelectorAll('[data-interface-axis-slider]').forEach(slider => {
    slider.addEventListener('input', () => {
        slider.value = Math.round(+slider.value);
        interfacePlaneState.pick[+slider.dataset.interfaceAxisSlider] = +slider.value;
        document.querySelector('[data-interface-axis="' + slider.dataset.interfaceAxisSlider + '"]').value = slider.value;
        slider.setAttribute('aria-valuetext', ['Min', 'Centroid', 'Max'][+slider.value]);
        updateInterfacePlane();
    });
});

const interfacePlaneBlock = document.querySelector('#workflow-step-2b .workflow-plane-block');
const interfacePlaneModeButton = document.getElementById('interface-plane-control-mode');
interfacePlaneModeButton.addEventListener('click', () => {
    const sliderMode = !interfacePlaneBlock.classList.contains('slider-mode');
    interfacePlaneBlock.classList.toggle('slider-mode', sliderMode);
    interfacePlaneModeButton.setAttribute('aria-pressed', sliderMode);
    interfacePlaneModeButton.setAttribute('aria-label', sliderMode ? 'Use nTop menu controls' : 'Use slider controls');
    interfacePlaneModeButton.title = sliderMode ? 'Switch to nTop min, centroid and max menus' : 'Switch to min, centroid and max sliders';
    if (!sliderMode) {
        interfacePlaneState.pick = interfacePlaneState.pick.map(value => Math.round(value));
        document.querySelectorAll('[data-interface-axis]').forEach(select => {
            const value = interfacePlaneState.pick[+select.dataset.interfaceAxis];
            select.value = value;
            document.querySelector('[data-interface-axis-slider="' + select.dataset.interfaceAxis + '"]').value = value;
        });
        updateInterfacePlane();
    }
});
document.querySelectorAll('[data-interface-normal]').forEach(input => {
    input.addEventListener('input', () => {
        const value = parseFloat(input.value);
        interfacePlaneState.normal[+input.dataset.interfaceNormal] = Number.isFinite(value) ? value : 0;
        updateInterfacePlane();
    });
});
document.querySelectorAll('[data-orient]').forEach(input => {
    input.value = orientationState[input.dataset.orient];
    document.querySelector('[data-orient-output="' + input.dataset.orient + '"]').value = input.value;
    input.setAttribute('aria-valuetext', input.value + ' degrees');
    input.addEventListener('input', () => {
        const value = parseFloat(input.value);
        if (!Number.isFinite(value)) return;
        orientationState[input.dataset.orient] = value;
        document.querySelector('[data-orient-output="' + input.dataset.orient + '"]').value = value;
        input.setAttribute('aria-valuetext', value + ' degrees');
        updateInterfaceOrientation();
    });
});
document.querySelectorAll('[data-adjust]').forEach(input => {
    input.value = orientationState.adjust[+input.dataset.adjust];
    document.querySelector('[data-adjust-output="' + input.dataset.adjust + '"]').value = input.value;
    input.setAttribute('aria-valuetext', input.value + ' millimeters');
    input.addEventListener('input', () => {
        const value = parseFloat(input.value);
        if (!Number.isFinite(value)) return;
        orientationState.adjust[+input.dataset.adjust] = value;
        document.querySelector('[data-adjust-output="' + input.dataset.adjust + '"]').value = value;
        input.setAttribute('aria-valuetext', value + ' millimeters');
        updateInterfaceOrientation();
    });
});

function setSocketParameterControl(key, value) {
    const input = document.querySelector('[data-socket-param="' + key + '"]');
    const index = parameterValues[key].indexOf(value);
    if (!input || index < 0) return;
    input.value = String(index);
    socketParameterState[key] = value;
    document.querySelector('[data-param-output="' + key + '"]').value = value;
    input.setAttribute('aria-valuetext', value + ', model slot ' + (index + 1) + ' of ' + parameterValues[key].length);
}

// Moving one pair puts the other pair back at the baseline the sweep was run at.
function resetSocketParametersForSweep(activeKey) {
    const group = sweepGroupOf(activeKey);
    Object.entries(socketParameterDefaults).forEach(([key, value]) => {
        if (sweepGroupOf(key) !== group) setSocketParameterControl(key, value);
    });
}

// Sliders by default; the switch shows typed values, which snap to the nearest generated socket.
const socketBlockEl = document.querySelector('#workflow-step-3 .workflow-parameter-block');
const socketModeButton = document.getElementById('socket-control-mode');
socketBlockEl.classList.add('slider-mode');
socketModeButton.addEventListener('click', () => {
    const sliderMode = !socketBlockEl.classList.contains('slider-mode');
    socketBlockEl.classList.toggle('slider-mode', sliderMode);
    socketModeButton.setAttribute('aria-pressed', String(sliderMode));
    socketModeButton.setAttribute('aria-label', sliderMode ? 'Use typed values' : 'Use sliders');
    socketModeButton.title = sliderMode ? 'Switch to typed values (snaps to the nearest generated socket)' : 'Switch to sliders';
});


document.querySelectorAll('[data-socket-param]').forEach(input => {
    const updateParameter = () => {
        const key = input.dataset.socketParam;
        const index = +input.value;
        const value = parameterValues[key][index];
        socketParameterChoices[key] = value;
        socketParameterTouched.add(key);
        resetSocketParametersForSweep(key);
        setSocketParameterControl(key, value);
        // Only Min <= Max was generated: dragging one thickness past the other drags the other along.
        if (key === 'minThickness' && value > socketParameterState.maxThickness) { setSocketParameterControl('maxThickness', value); socketParameterChoices.maxThickness = value; }
        if (key === 'maxThickness' && value < socketParameterState.minThickness) { setSocketParameterControl('minThickness', value); socketParameterChoices.minThickness = value; }
        loadSocketParameterModel(key, value);
    };
    input.addEventListener('input', updateParameter);
    input.max = String(parameterValues[input.dataset.socketParam].length - 1);
    setSocketParameterControl(input.dataset.socketParam, socketParameterDefaults[input.dataset.socketParam]);
});

document.querySelectorAll('.workflow-layer-menu input[data-view-layer]').forEach(input => {
    input.addEventListener('change', () => syncPlaneVisibility(input.dataset.viewLayer, input.checked));
});
document.querySelectorAll('.workflow-layer-menu input[data-interface-layer]').forEach(input => {
    input.addEventListener('change', () => syncInterfaceVisibility(input.dataset.interfaceLayer, input.checked));
});

document.addEventListener('click', event => {
    document.querySelectorAll('.workflow-layer-menu[open]').forEach(menu => {
        if (!menu.contains(event.target)) menu.removeAttribute('open');
    });
});

document.getElementById('pelvic-plane-visibility').addEventListener('click', () => {
    const guideKeys = ['point', 'normal', 'plane'];
    const next = !guideKeys.some(key => planeLayerVisibility[key]);
    guideKeys.forEach(key => syncPlaneVisibility(key, next));
});
document.getElementById('interface-plane-visibility').addEventListener('click', () => {
    const guideKeys = ['point', 'normal', 'plane'];
    const next = !guideKeys.some(key => interfaceLayerVisible(key));
    guideKeys.forEach(key => syncInterfaceVisibility(key, next));
});
document.getElementById('interface-position-visibility').addEventListener('click', () => {
    syncInterfaceVisibility('target', !interfaceLayerVisible('target'));
});

document.querySelectorAll('[data-grid-plane]').forEach(input => {
    input.addEventListener('change', () => {
        gridPlanes[input.dataset.gridPlane].visible = input.checked;
        const anyVisible = Object.values(gridPlanes).some(plane => plane.visible);
        document.querySelector('#grid-menu > summary').classList.toggle('active', anyVisible);
    });
});

function viewRootForStep() {
    if (isAttachmentStep(activeStep)) return attachmentHoles.root;
    if (activeStep === '1') return importRoot;
    if (isPelvicStep(activeStep)) return planeRoot;
    if (activeStep === '2b') return interfaceReferenceMechanical;
    // Step 2d opens on the interface alone, so frame it rather than the hidden animal.
    if (activeStep === '2d' && !interfaceLayerVisible('animal')) return orientedAssembly;
    return interfaceRoot;
}

function frameActiveStep() {
    frameObject(viewRootForStep());
}

// Fit (the toolbar button or F) refits every pane that is showing.
function fitViews() {
    frameActiveStep();
    if (splitPaired(activeStep)) frameSplitPane();
}
document.getElementById('reset-view').addEventListener('click', fitViews);

// Orbit picks land on real model surfaces, not on guides, gizmos, or measurement markers.
function navigationPickMeshes() {
    const excluded = new Set([positionTransformHelper, measurementRoot, importGhost, planeMesh, interfacePlaneMesh]);
    const meshes = [];
    (function visit(object) {
        if (!object.visible || excluded.has(object)) return;
        if (object.isMesh && object.material?.depthTest !== false) meshes.push(object);
        object.children.forEach(visit);
    })(scene);
    return meshes;
}

// ---- Split view: Step 2c and Step 2b side by side --------------------------------------------
// Step 2c keeps the main canvas on the left, with its drag handle. A second canvas on the right
// renders the same scene with Step 2b's visibility, so plane edits show up on the animal as they
// happen. Each pane has its own camera, view cube, and layer toggles.

const viewerEl = document.querySelector('.workflow-viewer');
const scrollEl = document.getElementById('workflow-scroll');
const splitPaneEl = document.getElementById('split-pane');
const splitCanvas = document.getElementById('split-canvas');
const splitDividerEl = document.getElementById('split-divider');
const splitToggleEl = document.getElementById('toggle-split');
const splitMainTagEl = document.getElementById('split-main-tag');
const viewerToolbarEl = document.querySelector('.viewer-toolbar');
const splitGrid = { position: new THREE.Vector3(), scale: 1 };
let splitRenderer = null;
let splitCamera = null;
let splitControls = null;
let splitView = null;
let splitRatio = 0.5;

function resizeSplitPane() {
    if (!splitRenderer) return;
    const width = splitPaneEl.clientWidth;
    const height = splitPaneEl.clientHeight;
    if (!width || !height) return;
    splitRenderer.setSize(width, height, false);
    splitCamera.aspect = width / height;
    splitCamera.updateProjectionMatrix();
}

// Orbit and measure picks in the second pane land on the reference interface. It is hidden in
// the shared scene between this pane's renders, so it is collected without a visibility check.
function splitPickMeshes() {
    const meshes = [];
    if (!interfaceLayerVisibility.reference) return meshes;
    interfaceReferenceMechanical.traverse(object => { if (object.isMesh) meshes.push(object); });
    return meshes;
}

function ensureSplitRenderer() {
    if (splitRenderer) return;
    splitRenderer = new THREE.WebGLRenderer({ canvas: splitCanvas, antialias: true });
    splitRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    splitRenderer.outputColorSpace = THREE.SRGBColorSpace;
    splitCamera = new THREE.PerspectiveCamera(34, 1, 0.001, 10000);
    splitCamera.up.set(0, 0, 1);
    splitControls = new OrbitControls(splitCamera, splitCanvas);
    splitControls.enableDamping = true;
    splitControls.dampingFactor = 0.07;
    splitControls.screenSpacePanning = true;
    // Same nTop navigation and view cube as the main pane.
    splitView = createPaneView({
        camera: splitCamera, controls: splitControls, canvas: splitCanvas, stage: splitPaneEl,
        cubeWrap: document.getElementById('split-cube-wrap'),
        cubeCanvas: document.getElementById('split-cube'),
        axisColors: NTOP_AXIS_COLORS,
        pickMeshes: splitPickMeshes,
    });
    splitView.setCubeVisible(true);   // the view cube is always on; its toggle was removed
    bindMeasureClicks(splitCanvas, 'split');
    new ResizeObserver(() => {
        resizeSplitPane();
        renderSplitPane();
    }).observe(splitPaneEl);
}

function frameSplitPane() {
    if (!splitCamera) return;
    const box = new THREE.Box3().setFromObject(interfaceReferenceMechanical);
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const radius = Math.max(size.length() / 2, 0.01);
    const verticalFov = THREE.MathUtils.degToRad(splitCamera.fov);
    const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * splitCamera.aspect);
    const distance = radius / Math.sin(Math.min(verticalFov, horizontalFov) / 2) * 1.08;
    splitControls.target.copy(center);
    splitCamera.position.copy(center).add(new THREE.Vector3(-1.4, -1.8, 0.9).normalize().multiplyScalar(distance));
    splitCamera.near = Math.max(radius / 100, 0.0001);
    splitCamera.far = Math.max(radius * 80, 100);
    splitCamera.updateProjectionMatrix();
    splitControls.update();
    splitGrid.position.set(center.x, center.y, box.min.z - size.z * 0.03);
    splitGrid.scale = Math.max(size.x, size.y, size.z, 0.2);
    splitFramed = true;
}

function syncSplitLayout() {
    const paired = splitPaired(activeStep);
    const pairOn = splitEnabled && !splitNarrow.matches;
    splitToggleEl.hidden = !SPLIT_STEPS.includes(activeStep) || splitNarrow.matches;
    splitToggleEl.classList.toggle('active', splitEnabled);
    splitToggleEl.setAttribute('aria-pressed', String(splitEnabled));
    viewerEl.classList.toggle('is-split', paired);
    // Both steps stay compact in the sidebar for as long as split view is on, so they fit together.
    scrollEl.classList.toggle('is-split-pair', pairOn);
    splitPaneEl.hidden = splitDividerEl.hidden = splitMainTagEl.hidden = !paired;
    syncInterfacePlaneHelp();
    // The main stage is the right-hand pane in split view, so the tools stay on the outer right edge.
    const toolbarHome = stage;
    if (viewerToolbarEl.parentElement !== toolbarHome) {
        const focused = viewerToolbarEl.contains(document.activeElement) ? document.activeElement : null;
        toolbarHome.append(viewerToolbarEl);
        focused?.focus();
    }
    // The stage just changed width; size the main view now so the next framing uses the right aspect.
    resize();
    if (!paired) return;
    ensureSplitRenderer();
    resizeSplitPane();
    if (!splitFramed) requestAnimationFrame(() => { resizeSplitPane(); frameSplitPane(); });
}

function renderSplitPane() {
    if (!splitRenderer || !splitPaired(activeStep)) return;
    if (!splitFramed) frameSplitPane();
    splitView.update(performance.now());
    splitControls.update();
    // Borrow the shared scene: show Step 2b, draw it, then put the main stage back.
    const touched = [...new Set(Object.values(interfaceLayerTargets)), positionTransformHelper, measurementRoot, gridPlanes.xz, gridPlanes.yz];
    const savedVisibility = touched.map(object => object.visible);
    const savedGridPosition = gridPlanes.xy.position.clone();
    const savedGridScale = gridPlanes.xy.scale.x;
    applyInterfaceSceneVisibility('2b');
    positionTransformHelper.visible = gridPlanes.xz.visible = gridPlanes.yz.visible = false;
    measurementRoot.visible = measurePane === 'split';
    gridPlanes.xy.position.copy(splitGrid.position);
    gridPlanes.xy.scale.setScalar(splitGrid.scale);
    splitRenderer.render(scene, splitCamera);
    touched.forEach((object, index) => { object.visible = savedVisibility[index]; });
    gridPlanes.xy.position.copy(savedGridPosition);
    gridPlanes.xy.scale.setScalar(savedGridScale);
}

// The ? on the Interface Plane block: the plane on the left, the interface it orients on Ollie on
// the right, with the same X / Y / Z controls driving both.
const interfacePlaneHelpButton = document.getElementById('interface-plane-help');
const interfacePlaneHelpNote = { hidden: true, textContent: '' };

function syncInterfacePlaneHelp() {
    const on = splitEnabled && !splitNarrow.matches;
    interfacePairButton?.setAttribute('aria-pressed', String(on));
    interfacePairButton?.classList.toggle('is-on', on);
    if (interfacePairButton) interfacePairButton.querySelector('span').textContent = on ? 'Close the side by side' : 'Side by side';
    updateInterfaceHelpNote();
}

function setInterfacePlanePair(on) {
    if (splitNarrow.matches) { syncInterfacePlaneHelp(); return; }
    splitEnabled = on;
    if (on) {
        // The right-hand view needs the interface on the animal for plane changes to show.
        positionMechanicalVisible = true;
        splitReturnStep = '2b';
        showStep('2c', true);
    } else {
        showStep('2b', true);
    }
}

const interfaceHelpCard = document.getElementById('interface-help-card');
const interfaceAnswerButton = document.getElementById('interface-answer-btn');
const interfacePairButton = document.getElementById('interface-pair-btn');
interfacePlaneHelpButton.addEventListener('click', () => {
    const opening = interfaceHelpCard.hidden;
    toggleHelpCard(interfacePlaneHelpButton, interfaceHelpCard);
    interfaceAnswerShown = opening;
    if (opening) buildInterfaceAnswer(); else stopPlaneGuide();
    syncInterfaceAnswer();
});
interfacePairButton.addEventListener('click', () => setInterfacePlanePair(!splitEnabled));
interfaceAnswerButton.addEventListener('click', () => {
    if (planeGuide?.kind === 'interface') stopPlaneGuide(); else startPlaneGuide('interface');
});

splitToggleEl.addEventListener('click', () => {
    splitEnabled = !splitEnabled;
    if (splitEnabled) {
        const enteredFrom = activeStep;
        // The position view needs the interface on the animal for plane changes to be visible.
        positionMechanicalVisible = true;
        showStep('2c', true);
        splitReturnStep = enteredFrom;
    } else {
        showStep(splitReturnStep, true);
    }
});
splitNarrow.addEventListener('change', () => showStep(activeStep));

// Dragging the divider resizes both panes; double-click evens them out again.
function setSplitRatio(ratio) {
    splitRatio = THREE.MathUtils.clamp(ratio, 0.25, 0.75);
    viewerEl.style.setProperty('--split-left', splitRatio + 'fr');
    viewerEl.style.setProperty('--split-right', (1 - splitRatio) + 'fr');
    splitDividerEl.setAttribute('aria-valuenow', Math.round(splitRatio * 100));
}

splitDividerEl.addEventListener('pointerdown', event => {
    event.preventDefault();
    viewerEl.classList.add('is-split-resizing');
    splitDividerEl.setPointerCapture(event.pointerId);
});
splitDividerEl.addEventListener('pointermove', event => {
    if (!viewerEl.classList.contains('is-split-resizing')) return;
    const bounds = viewerEl.getBoundingClientRect();
    setSplitRatio((event.clientX - bounds.left) / bounds.width);
});
splitDividerEl.addEventListener('pointerup', event => {
    viewerEl.classList.remove('is-split-resizing');
    if (splitDividerEl.hasPointerCapture(event.pointerId)) splitDividerEl.releasePointerCapture(event.pointerId);
});
splitDividerEl.addEventListener('pointercancel', () => viewerEl.classList.remove('is-split-resizing'));
splitDividerEl.addEventListener('dblclick', () => setSplitRatio(0.5));
splitDividerEl.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    setSplitRatio(splitRatio + (event.key === 'ArrowLeft' ? -0.03 : 0.03));
});

const viewerControls = createViewerControls({
    camera, controls, canvas, stage,
    cubeWrap: document.getElementById('view-cube-wrap'),
    cubeCanvas: document.getElementById('view-cube'),
    helpButton: document.getElementById('viewer-help'),
    // Same guide as the design review page: a close button, it puts itself away after the last
    // gesture, and it shrinks into the "How to move" button at the bottom left of the view.
    dismissible: true,
    closeOnLastGesture: true,
    collapseTarget: () => document.getElementById('viewer-help'),
    axisColors: NTOP_AXIS_COLORS,
    pickMeshes: navigationPickMeshes,
    isGizmoHovered: () => !!positionTransform.axis,
    frameView: fitViews,
});

const attachmentHoles = createAttachmentHoles({ scene, camera, canvas,
    transform: positionTransform, transformHelper: positionTransformHelper,
    loadGLB, collectSurfaceTriangles, closestSurfacePoint, keepOverlayVisible,
    isMeasuring: () => measureMode,
});

// ---- Step 4b: the screw attachment sweep (10-23, tools/convert_attachment_1023.py) -----------------
// CB - Attachment takes Solid Animal, Attachment Point and five numbers. The defaults are the notebook's
// screw, a McMaster-Carr low-profile socket head M4 (head 7 mm across, 2.8 mm tall). nTop exported
// every value on each input's own sweep with the other four at those defaults, nine standard screws,
// and a coarse grid of all five (the same set screw-attachment.html shows), so a change snaps to the
// nearest exported attachment and the other inputs move only when they have to.
const ATTACH_KEYS = ['attachDiameter', 'shankDiameter', 'gripLength', 'headDiameter', 'headHeight'];
const ATTACH_LABELS = { attachDiameter: 'attachment diameter', shankDiameter: 'shank diameter', gripLength: 'grip length', headDiameter: 'head diameter', headHeight: 'head height' };
const attachmentDefaults = { attachDiameter: 15, shankDiameter: 4, gripLength: 2.8, headDiameter: 7, headHeight: 2.8 };
const attachmentCombos = (() => {
    const r2 = value => Math.round(value * 100) / 100;
    const range = (start, end, step) => Array.from({ length: Math.round((end - start) / step) + 1 }, (_, i) => r2(start + i * step));
    const combos = new Map();
    const add = combo => combos.set(ATTACH_KEYS.map(k => combo[k]).join(','), combo);
    // Each input on its own, the other four at the defaults.
    const single = { attachDiameter: range(6, 24, 0.5), shankDiameter: range(1, 7.5, 0.25), gripLength: range(0, 8, 0.2), headDiameter: range(3, 16, 0.25), headHeight: range(0, 6, 0.2) };
    for (const [key, values] of Object.entries(single)) values.forEach(value => add({ ...attachmentDefaults, [key]: value }));
    // Socket head ISO 4762 M2-M6 and button head ISO 7380 M3-M5, at attachment 15 / grip 2.8.
    [[2, 3.8, 2], [2.5, 4.5, 2.5], [3, 5.5, 3], [4, 7, 4], [5, 8.5, 5], [6, 10, 6], [3, 5.7, 1.65], [4, 7.6, 2.2], [5, 9.5, 2.75]]
        .forEach(([s, hd, hh]) => add({ attachDiameter: 15, shankDiameter: s, gripLength: 2.8, headDiameter: hd, headHeight: hh }));
    // The coarse grid: head wider than the shank, attachment at least 2 mm wider than the head. nTop could
    // not mesh attachment 10 / grip 5 / head 8 / head height 5 at any shank, so those five are missing.
    for (const a of [10, 15, 20]) for (const s of range(2, 6, 1)) for (const g of range(1, 5, 1)) for (const hd of range(4, 10, 1)) for (const hh of range(0, 5, 1)) {
        if (hd <= s || a < hd + 2 || (a === 10 && g === 5 && hd === 8 && hh === 5)) continue;
        add({ attachDiameter: a, shankDiameter: s, gripLength: g, headDiameter: hd, headHeight: hh });
    }
    return [...combos.values()];
})();
const attachmentValues = Object.fromEntries(ATTACH_KEYS.map(key => [key, [...new Set(attachmentCombos.map(c => c[key]))].sort((a, b) => a - b)]));
const attachmentSpan = Object.fromEntries(ATTACH_KEYS.map(key => [key, attachmentValues[key].at(-1) - attachmentValues[key][0]]));
const attachmentDesign = { ...attachmentDefaults };
// The exported attachment closest to what was asked for. Only combinations that move the input the way
// it was pushed count (so a slider is never ignored); among those, keeping the other inputs where they
// are matters ten times more than landing exactly on the moved one, so a step on the coarse grid goes
// to the next grid value rather than back to the fine sweep.
function nearestAttachment(request, movedKey) {
    const current = attachmentDesign[movedKey], target = request[movedKey];
    let best = null, bestScore = Infinity;
    for (const combo of attachmentCombos) {
        if (target !== current && Math.sign(combo[movedKey] - current) !== Math.sign(target - current)) continue;
        let score = 0;
        for (const key of ATTACH_KEYS) score += Math.abs(combo[key] - request[key]) / attachmentSpan[key] * (key === movedKey ? 1 : 10);
        if (score < bestScore) { bestScore = score; best = combo; }
    }
    return best || { ...attachmentDesign };
}
const attachmentBlockEl = document.getElementById('attachment-block');
const attachmentModeButton = document.getElementById('attachment-control-mode');
attachmentBlockEl.classList.add('slider-mode');
attachmentModeButton.addEventListener('click', () => {
    const sliderMode = !attachmentBlockEl.classList.contains('slider-mode');
    attachmentBlockEl.classList.toggle('slider-mode', sliderMode);
    attachmentModeButton.setAttribute('aria-pressed', String(sliderMode));
    attachmentModeButton.setAttribute('aria-label', sliderMode ? 'Use typed values' : 'Use sliders');
    attachmentModeButton.title = sliderMode ? 'Switch to typed values (snaps to the nearest generated attachment)' : 'Switch to sliders';
});
function setAttachmentControl(key, value) {
    const input = document.querySelector('[data-attach-param="' + key + '"]');
    const index = attachmentValues[key].indexOf(value);
    if (!input || index < 0) return;
    input.max = String(attachmentValues[key].length - 1);
    input.value = String(index);
    document.querySelector('[data-attach-output="' + key + '"]').value = value;
    input.setAttribute('aria-valuetext', value + ' mm');
}
function attachmentStatus(text) {
    const el = document.querySelector('[data-attach-status]');
    el.textContent = text;
    el.hidden = !text;
}
let attachmentDesignRequest = 0;
async function applyAttachmentDesign() {
    const request = ++attachmentDesignRequest;
    try {
        const applied = await attachmentHoles.setDesign(attachmentDesign);
        if (request !== attachmentDesignRequest) return;
        if (!applied) return;
    } catch (error) {
        if (request !== attachmentDesignRequest) return;
        attachmentStatus('Could not load that attachment.');
        console.error(error);
    }
}
document.querySelectorAll('[data-attach-param]').forEach(input => {
    setAttachmentControl(input.dataset.attachParam, attachmentDesign[input.dataset.attachParam]);
    input.addEventListener('input', () => {
        const key = input.dataset.attachParam;
        const request = { ...attachmentDesign, [key]: attachmentValues[key][+input.value] };
        const chosen = nearestAttachment(request, key);
        const moved = ATTACH_KEYS.filter(k => k !== key && chosen[k] !== attachmentDesign[k]);
        Object.assign(attachmentDesign, chosen);
        ATTACH_KEYS.forEach(k => setAttachmentControl(k, attachmentDesign[k]));
        attachmentStatus(moved.length
            ? `nTop exported ${ATTACH_LABELS[key]} ${chosen[key]} only with ${moved.map(k => `${ATTACH_LABELS[k]} ${chosen[k]}`).join(', ')}, so ${moved.length > 1 ? 'those moved' : 'that moved'} too.`
            : '');
        applyAttachmentDesign();
    });
});

// ---- Step 5: the blended-socket sweep (10-22, tools/convert_1022_sweeps.py) --------------------------
// Both cases ran the same blend sweep on their own blend notebook: Min x Max Blend (0..60 by 5, only
// Min <= Max) at connector blend 8, and connector blend 0..30 by 1 at min 5 / max 45, each in a
// four-connector and a six-connector version. Which one is shown follows the number of attachment
// points the student placed, because that is what feeds Attachments in the block. The blend notebooks
// build on their own saved socket (6 / 12 / 0.6 / 32; Ollie 2 Curves, the wheelchair Point & Curve).
const blendValues = {
    minBlend: Array.from({ length: 13 }, (_, index) => index * 5),
    maxBlend: Array.from({ length: 13 }, (_, index) => index * 5),
    connectorRadius: Array.from({ length: 31 }, (_, index) => index),
};
const blendDefaults = { minBlend: 5, maxBlend: 45, connectorRadius: 8 };
const isWheelchairBlend = isWheelchairCase;
const blendSetDir = () => (isWheelchairBlend() ? 'sample-models/chi-wc-blend-1022' : 'sample-models/ollie-blend-1022');
const blendSetValues = () => blendValues;
const blendSetDefaults = () => blendDefaults;
// Four or six connectors, from the points placed in Step 4a; anything above four reads as six.
const blendConnectorCount = () => (attachmentHoles.getPoints().length > 4 ? 6 : 4);

const blendState = { ...blendDefaults };
const BLEND_GROUPS = { blend: ['minBlend', 'maxBlend'], connector: ['connectorRadius'] };
const blendGroupOf = key => Object.keys(BLEND_GROUPS).find(group => BLEND_GROUPS[group].includes(key));
let activeBlendParameter = 'maxBlend';
let currentFinalFile = null;
const finalModelPromises = new Map();
let finalModelRequest = 0;
function finalSocketFile(state) {
    const pad = value => String(value).padStart(2, '0');
    return `${blendSetDir()}/c${blendConnectorCount()}`
        + `-lo${pad(state.minBlend)}-hi${pad(state.maxBlend)}-cb${pad(state.connectorRadius)}.glb`;
}
function finalModelPromise(file) {
    if (!finalModelPromises.has(file)) {
        const promise = loadGLB(file).then(gltf => prepareSocketPreviewObject(gltf.scene));
        promise.catch(() => finalModelPromises.delete(file));
        finalModelPromises.set(file, promise);
    }
    return finalModelPromises.get(file);
}
function setBlendControl(key, value) {
    const input = document.querySelector('[data-blend-param="' + key + '"]');
    const index = blendSetValues()[key].indexOf(value);
    if (!input || index < 0) return;
    input.value = String(index);
    blendState[key] = value;
    document.querySelector('[data-blend-output="' + key + '"]').value = value;
    input.setAttribute('aria-valuetext', value + ' mm');
}
function blendStatus(text) {
    const el = document.querySelector('[data-blend-status]');
    el.textContent = text;
    el.hidden = !text;
}
async function loadFinalSocket(key, value) {
    const request = ++finalModelRequest;
    if (!hasSocketModelLibrary()) { finalSocketRoot.clear(); currentFinalFile = null; blendStatus('Source models only. Blended sockets are not generated for this selection yet.'); return; }
    const group = blendGroupOf(key);
    const state = { ...blendSetDefaults(), [key]: value };
    BLEND_GROUPS[group].forEach(k => { state[k] = k === key ? value : blendState[k]; });
    const file = finalSocketFile(state, group);
    blendStatus(`Loading nTop blended socket · ${key === 'connectorRadius' ? 'connector radius' : key === 'minBlend' ? 'min blend' : 'max blend'} ${value} mm`);
    try {
        const object = await finalModelPromise(file);
        if (request !== finalModelRequest) return;
        finalSocketRoot.clear();
        finalSocketRoot.add(object);
        currentFinalFile = file;
        Object.entries(blendSetDefaults()).forEach(([k, v]) => { if (blendGroupOf(k) !== group) setBlendControl(k, v); });
        BLEND_GROUPS[group].forEach(k => setBlendControl(k, state[k]));
        activeBlendParameter = key;
        blendStatus('');
        applyInterfaceStageVisibility();
        const values = blendSetValues()[key];
        const index = values.indexOf(value);
        [index - 1, index + 1].forEach(next => {
            if (next < 0 || next >= values.length) return;
            const candidate = { ...state, [key]: values[next] };
            if (candidate.minBlend > candidate.maxBlend) return;   // never generated
            finalModelPromise(finalSocketFile(candidate, group)).catch(() => {});
        });
    } catch (error) {
        if (request !== finalModelRequest) return;
        blendStatus(`Could not load the blended socket for ${key === 'connectorRadius' ? 'connector radius' : key === 'minBlend' ? 'min blend' : 'max blend'} ${value} mm.`);
        console.error(error);
    }
}
// Each set has its own number of steps, so the sliders are re-ranged whenever the case changes.
function syncBlendSliderRanges() {
    const values = blendSetValues();
    const defaults = blendSetDefaults();
    document.querySelectorAll('[data-blend-param]').forEach(input => {
        const key = input.dataset.blendParam;
        input.max = String(values[key].length - 1);
        const current = values[key].indexOf(blendState[key]);
        setBlendControl(key, current < 0 ? defaults[key] : blendState[key]);
    });
}

const blendControlsEl = document.getElementById('blend-block');
const blendModeButton = document.getElementById('blend-control-mode');
blendModeButton.addEventListener('click', () => {
    const sliderMode = !blendControlsEl.classList.contains('slider-mode');
    blendControlsEl.classList.toggle('slider-mode', sliderMode);
    blendModeButton.setAttribute('aria-pressed', String(sliderMode));
    blendModeButton.setAttribute('aria-label', sliderMode ? 'Use typed values' : 'Use sliders');
    blendModeButton.title = sliderMode ? 'Switch to typed values (snaps to the nearest generated socket)' : 'Switch to sliders';
});
document.querySelectorAll('[data-blend-param]').forEach(input => {
    setBlendControl(input.dataset.blendParam, blendState[input.dataset.blendParam]);
    input.addEventListener('input', () => {
        const key = input.dataset.blendParam;
        const value = blendSetValues()[key][+input.value];
        setBlendControl(key, value);
        // Only Min <= Max was generated: dragging one blend past the other drags the other along.
        if (key === 'minBlend' && value > blendState.maxBlend) setBlendControl('maxBlend', value);
        if (key === 'maxBlend' && value < blendState.minBlend) setBlendControl('minBlend', value);
        loadFinalSocket(key, value);
    });
});


const stepObserver = new IntersectionObserver(entries => {
    const visible = entries.filter(entry => entry.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
    if (!visible) return;
    const step = visible.target.dataset.step;
    // Scrolling within the step already shown, or within the split pair, must not reset the view.
    if (step === activeStep || (splitPaired(step) && splitPaired(activeStep))) return;
    showStep(step);
}, { root: document.getElementById('workflow-scroll'), threshold: [0.35, 0.6] });
document.querySelectorAll('.workflow-step').forEach(step => stepObserver.observe(step));

attachmentHoles.ready.then(() => {
    Object.keys(layers).forEach(key => syncImportVisibility(key, layers[key].visible));
    syncImportPathLabels();
    loaderEl.hidden = true;
    showStep('1');
}).catch(error => {
    loaderEl.classList.add('error');
    loaderEl.querySelector('p').textContent = 'A model could not be loaded. Refresh the page to try again.';
    console.error(error);
});

renderLegend();
window.lucide?.createIcons({ attrs: { 'stroke-width': 1.8 } });

// Typed values use the same update path as their paired slider.
for (const [outputAttr, sliderAttr] of [['param-output', 'socket-param'], ['attach-output', 'attach-param'], ['blend-output', 'blend-param'], ['orient-output', 'orient'], ['adjust-output', 'adjust']]) {
    document.querySelectorAll(`[data-${outputAttr}]`).forEach(field => {
        const key = field.getAttribute(`data-${outputAttr}`);
        const slider = document.querySelector(`[data-${sliderAttr}="${key}"]`);
        field.setAttribute('aria-label', slider.getAttribute('aria-label') + ' value');
        const commit = () => {
            const value = Number(field.value);
            if (field.value === '' || !Number.isFinite(value)) { slider.dispatchEvent(new Event('input')); return; }
            if (outputAttr === 'param-output' || outputAttr === 'attach-output' || outputAttr === 'blend-output') {
                const values = outputAttr === 'param-output' ? parameterValues[key] : outputAttr === 'attach-output' ? attachmentValues[key] : blendSetValues()[key];
                slider.value = values.reduce((best, v, i) => Math.abs(v-value) < Math.abs(values[best]-value) ? i : best, 0);
            } else slider.value = Math.round(Math.max(+slider.min, Math.min(+slider.max, value)));
            slider.dispatchEvent(new Event('input'));
        };
        field.addEventListener('change', commit);
        field.addEventListener('keydown', event => { if (event.key === 'Enter') { commit(); field.blur(); } });
    });
}
document.querySelectorAll('[data-interface-position]').forEach(field => {
    const commit = () => {
        if (field.value !== '' && Number.isFinite(+field.value)) {
            const query = interfacePositionState.clone();
            query.setComponent(+field.dataset.interfacePosition, +field.value / 1000);
            interfacePositionFollowsPlane = false;
            setInterfacePositionFromQuery(query);
        } else syncInterfacePositionInputs();
    };
    field.addEventListener('change', commit);
    field.addEventListener('keydown', event => { if (event.key === 'Enter') { commit(); field.blur(); } });
});
document.querySelectorAll('[data-pelvic-axis-slider]').forEach(slider => {
    slider.addEventListener('input', () => {
        const axis = +slider.dataset.pelvicAxisSlider;
        const value = Math.round(+slider.value);
        slider.value = String(value);
        planeState.pick[axis] = value;
        document.querySelector(`[data-axis="${axis}"]`).value = String(value);
        slider.setAttribute('aria-valuetext', ['Min', 'Centroid', 'Max'][value]);
        updatePlane();
    });
});
document.getElementById('pelvic-plane-control-mode').addEventListener('click', event => {
    const enabled = document.querySelector('#workflow-step-2a .workflow-plane-block').classList.toggle('slider-mode');
    event.currentTarget.setAttribute('aria-pressed', enabled);
    event.currentTarget.setAttribute('aria-label', enabled ? 'Use nTop menu controls' : 'Use slider controls');
});

// For the expert comparison (walkthrough-grading.js): the student's answers, the files they imported, and a way
// to show any value on the model (the experts' choice or the student's) and then put the student's work back.
function applyPelvicPlane(pick, normal) {
    planeState.pick = pick.map(Number);
    if (normal) planeState.normal = normal.map(Number);
    document.querySelectorAll('[data-axis]').forEach(select => { select.value = String(planeState.pick[+select.dataset.axis]); });
    document.querySelectorAll('[data-pelvic-axis-slider]').forEach(slider => { slider.value = String(planeState.pick[+slider.dataset.pelvicAxisSlider]); });
    document.querySelectorAll('[data-normal]').forEach(input => { input.value = String(planeState.normal[+input.dataset.normal]); });
    updatePlane();
}
function applyInterfacePlane(pick, normal) {
    interfacePlaneState.pick = pick.map(Number);
    if (normal) interfacePlaneState.normal = normal.map(Number);
    document.querySelectorAll('[data-interface-axis]').forEach(select => { select.value = String(interfacePlaneState.pick[+select.dataset.interfaceAxis]); });
    document.querySelectorAll('[data-interface-axis-slider]').forEach(slider => { slider.value = String(interfacePlaneState.pick[+slider.dataset.interfaceAxisSlider]); });
    document.querySelectorAll('[data-interface-normal]').forEach(input => { input.value = String(interfacePlaneState.normal[+input.dataset.interfaceNormal]); });
    updateInterfacePlane();
}
function applyOrientation(values) {
    Object.entries(values).forEach(([key, value]) => {
        if (!(key in orientationState) || key === 'adjust') return;
        orientationState[key] = Number(value);
        const input = document.querySelector(`[data-orient="${key}"]`);
        if (input) input.value = String(value);
        const output = document.querySelector(`[data-orient-output="${key}"]`);
        if (output) output.value = String(value);
    });
    updateInterfaceOrientation();
}
function showSocketValue(key, value) {
    resetSocketParametersForSweep(key);
    setSocketParameterControl(key, value);
    return loadSocketParameterModel(key, value);
}
// Show a value on the model; resolves once the model for it is in the scene.
function showValue(key, value) {
    if (key === 'pelvicPlane') applyPelvicPlane(value.pick, value.normal);
    else if (key === 'interfacePlane') applyInterfacePlane(value.pick, value.normal);
    else if (key === 'lateral' || key === 'medial' || key === 'rotation') applyOrientation({ [key]: value });
    else if (key in parameterValues) return showSocketValue(key, value);
    return Promise.resolve();
}

// The experts' version as a "ghost": show their value, copy what it draws (in world space), then show the
// student's value again. Both are then in the scene at once; the ghost can be see-through blue (overlay) or
// keep the model's own look (side by side, where the student's part is hidden in the experts' half).
const ghostRoot = new THREE.Group();
ghostRoot.name = 'expert-ghost';
scene.add(ghostRoot);
let ghostParts = [];
const GHOST_COLOR = new THREE.Color(0x2463b5);
function ghostTargets(key) {
    if (key === 'pelvicPlane') return [planeMesh, planeOutline, normalArrow].filter(Boolean);
    if (key === 'interfacePlane') return [interfacePlaneMesh, interfacePlaneOutline, interfaceNormalArrow].filter(Boolean);
    if (key === 'lateral' || key === 'medial' || key === 'rotation') return [orientedAssembly];
    if (key in parameterValues) return [socketPreviewRoot];
    return [];
}
function shownInScene(object) {
    for (let node = object; node; node = node.parent) if (!node.visible) return false;
    return true;
}
function clearGhost() {
    ghostRoot.clear();
    ghostParts = [];
}
function setGhostLook(look, opacity = 0.42) {
    ghostParts.forEach(({ part, solid, ghost }) => {
        part.material = look === 'solid' ? solid : ghost;
        if (look !== 'solid') ghost.opacity = opacity;
    });
}
async function captureGhost(key, expertValue, studentValue) {
    clearGhost();
    await showValue(key, expertValue);
    ghostTargets(key).forEach(object => {
        if (!shownInScene(object)) return;
        object.updateWorldMatrix(true, true);
        const copy = object.clone(true);
        object.matrixWorld.decompose(copy.position, copy.quaternion, copy.scale);
        copy.visible = true;
        copy.traverse(part => {
            if (!part.material) return;
            const solid = part.material;
            const ghost = (Array.isArray(solid) ? solid[0] : solid).clone();
            ghost.transparent = true;
            ghost.opacity = 0.42;
            ghost.depthWrite = false;
            if (ghost.color) ghost.color.copy(GHOST_COLOR);
            if ('vertexColors' in ghost) ghost.vertexColors = false;
            if (ghost.emissive) ghost.emissive.setHex(0x0b2a55);
            ghost.needsUpdate = true;
            ghostParts.push({ part, solid, ghost });
            part.material = ghost;
            part.renderOrder = Math.max(part.renderOrder || 0, 35);
        });
        ghostRoot.add(copy);
    });
    await showValue(key, studentValue);
}

// The interface position the student ended on, in millimetres, with the Step 2d X/Y/Z adjustments
// folded in: that is where the interface actually sits, so that is what the solution is measured against.
function effectiveInterfacePosition() {
    return [0, 1, 2].map(axis => interfacePositionState.getComponent(axis) * 1000 + orientationState.adjust[axis]);
}

// Notes and drawings on the viewer, kept in this browser.
walkthroughNotes = createWalkthroughNotes({
    THREE, camera, controls, stage,
    currentStep: () => activeStep,
    goToStep: step => showStep(step, true),
    onDrawingChange: drawing => { if (drawing && measureMode) setMeasureMode(false); },
});

// Step 4b's ?: the attachment on its own, big, with nothing else in the way, so one input at a time
// can be watched.
const attachmentHelpButton = document.getElementById('attachment-help');
const attachmentHelpCard = document.getElementById('attachment-help-card');
const attachmentSoloButton = document.getElementById('attachment-solo-btn');
const attachmentHelpNote = document.getElementById('attachment-help-note');
let attachmentSolo = false;

function syncAttachmentSolo() {
    if (!attachmentSoloButton) return;
    const on = attachmentSolo && activeStep === '4b';
    attachmentHoles.setSolo(on);
    attachmentSoloButton.setAttribute('aria-pressed', String(on));
    attachmentSoloButton.classList.toggle('is-on', on);
    attachmentSoloButton.querySelector('span').textContent = on ? 'Back to the whole socket' : 'Show the part on its own';
    setViewerMode('attachmentSolo', on ? {
        name: 'One part only',
        text: 'The attachment on its own, with the socket out of the way.',
        done: () => { attachmentSolo = false; syncAttachmentSolo(); },
    } : null);
    attachmentHelpNote.hidden = !attachmentSolo;
    attachmentHelpNote.textContent = attachmentSolo
        ? 'The attachment on its own. Move one slider and watch what it changes; from the starting screw, every input has its own fine sweep, so the others stay put.'
        : '';
    if (on) {
        const object = attachmentHoles.soloObject();
        if (object) requestAnimationFrame(() => frameObject(object));
    } else if (activeStep === '4b') {
        requestAnimationFrame(() => frameObject(attachmentHoles.root));
    }
}

attachmentHelpButton.addEventListener('click', () => toggleHelpCard(attachmentHelpButton, attachmentHelpCard));
attachmentSoloButton.addEventListener('click', () => {
    attachmentSolo = !attachmentSolo;
    syncAttachmentSolo();
});

window.gapWalkthrough = {
    notes: walkthroughNotes,
    attachmentSolo: () => attachmentSolo,
    solution: SOLUTION,
    practice: {
        on: () => practice.on,
        state: () => ({ problem: practice.problem, attempted: practice.attempted,
                        firstTry: practice.firstTry, checked: practice.checked,
                        result: practice.result && { ...practice.result } }),
        answer: kind => ({ ...planeAnswer(kind) }),
        turns: () => QUARTER_TURNS.length,
        set: on => setPractice(on),
        next: () => newPracticeProblem(),
        check: () => checkPractice(),
        // For tests: answer the problem on screen outright.
        solve: kind => { const a = planeAnswer(kind);
            if (kind === 'pelvic') showPelvicPlane(a); else showInterfacePlane(a);
            updatePlane(); updateInterfacePlane(); },
    },
    // For scripted tests: import a catalog file by role and name, as the explorer would.
    importFile: (role, name) => { const entry = filesForRole(role).find(e => e.name === name); if (!entry) throw new Error(`No ${role} file named ${name}`); return loadImportSelection(role, entry); },
    answers: () => ({
        // Practice runs on the same controls, so while it is on the saved answers are the real ones.
        pelvicPlane: practice.on ? { ...practice.saved.pelvic } : { pick: [...planeState.pick], normal: [...planeState.normal] },
        interfacePlane: practice.on ? { ...practice.saved.interface } : { pick: [...interfacePlaneState.pick], normal: [...interfacePlaneState.normal] },
        ...socketParameterChoices,
        ...socketChoiceState,
        lateral: orientationState.lateral,
        medial: orientationState.medial,
        rotation: orientationState.rotation,
        interfacePosition: effectiveInterfacePosition(),
        interfacePositionRaw: [0, 1, 2].map(axis => interfacePositionState.getComponent(axis) * 1000),
        interfaceAdjust: [...orientationState.adjust],
        attachmentPoints: attachmentHoles.getPoints(),
    }),
    touched: () => new Set(socketParameterTouched),
    imports: () => ({ selection: Object.fromEntries(Object.entries(importSelection).map(([role, entry]) => [role, { ...entry }])), mismatches: importMismatches() }),
    parameterValues,
    design: designValues,
    attachment: attachmentDesign,
    interfaceAxes: () => lastInterfaceAxes && { ...lastInterfaceAxes },
    interfaceType: () => interfaceType,
    blend: blendState,
    defaults: { ...socketParameterDefaults },
    goToStep: step => showStep(step, true),
    // Show a value on the model: 'pelvicPlane' / 'interfacePlane' take {pick, normal}, the angles a number,
    // the Step 3 sliders one of their values.
    show: showValue,
    ghost: { capture: captureGhost, clear: clearGhost, setLook: setGhostLook, targets: ghostTargets, root: ghostRoot },
    three: { THREE, scene, camera, renderer, canvas, controls },
    // The groups the viewer's layer switches act on, for tests.
    layerRoots: () => ({ ...planeLayerTargets, socketPreview: socketPreviewRoot, finalSocket: finalSocketRoot,
        interfaceAnimal, interfaceMechanical, interfaceReference: interfaceReferenceMechanical }),
    setRender(fn) { renderOverride = fn || null; },
    snapshot: () => ({
        pelvicPlane: { pick: [...planeState.pick], normal: [...planeState.normal] },
        interfacePlane: { pick: [...interfacePlaneState.pick], normal: [...interfacePlaneState.normal] },
        orientation: { lateral: orientationState.lateral, medial: orientationState.medial, rotation: orientationState.rotation },
        sliders: { ...socketParameterState },
        activeSocket: activeSocketParameter,
        step: activeStep,
    }),
    restore(snap) {
        clearGhost();
        renderOverride = null;
        applyPelvicPlane(snap.pelvicPlane.pick, snap.pelvicPlane.normal);
        applyInterfacePlane(snap.interfacePlane.pick, snap.interfacePlane.normal);
        applyOrientation(snap.orientation);
        Object.entries(snap.sliders).forEach(([key, value]) => setSocketParameterControl(key, value));
        showStep(snap.step, true);
        if (snap.activeSocket in parameterValues) loadSocketParameterModel(snap.activeSocket, snap.sliders[snap.activeSocket]);
    },
};
window.dispatchEvent(new Event('gap-walkthrough-ready'));
