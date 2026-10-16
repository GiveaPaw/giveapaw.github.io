import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { withModelFallback } from './model-base.js?v=2';
import { createAttachmentHoles } from './attachment-holes.js?v=9';
import { createViewerControls, createPaneView } from './viewer-controls.js?v=9';
import { ROLES as IMPORT_ROLES, BREEDS as IMPORT_BREEDS, filesForRole, folderEntries, startFolder, resolve as resolveImportPath, formatBytes } from './import-catalog.js?v=2';

const app = document.getElementById('workflow-app');
if (!app) throw new Error('Socket workflow container is missing.');

const stage = document.getElementById('workflow-stage');
const canvas = document.getElementById('workflow-canvas');
const loaderEl = document.getElementById('workflow-loader');
const overlayControlsEl = document.getElementById('workflow-overlay-controls');
const interfaceOverlayControlsEl = document.getElementById('interface-overlay-controls');
const viewerStepEl = document.getElementById('viewer-step');
const viewerTitleEl = document.getElementById('viewer-title');
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

const layers = {
    solidAnimal: {
        label: 'Solid animal', color: '#496b94', group: new THREE.Group(), visible: true,
        file: 'sample-models/chihuahua-1015-solid.glb', type: 'glb', opacity: 0.28, baseUnit: 'mm', importUnit: 'mm', scalable: true,
    },
    attachment: {
        label: 'Attachment mesh', color: '#169c8c', group: new THREE.Group(), visible: true,
        file: 'sample-models/chihuahua-1015-surface.glb', type: 'glb', opacity: 0.88, baseUnit: 'mm', importUnit: 'mm', scalable: true,
    },
    mechanical: {
        label: 'Mechanical interface', color: '#df7544', group: new THREE.Group(), visible: false,
        file: 'billie-mechanical-interface.glb', type: 'glb', opacity: 1, baseUnit: 'mm', importUnit: 'mm',
    },
    solidInterface: {
        label: 'Solid interface', color: '#6750a4', group: new THREE.Group(), visible: false,
        file: 'billie-solid-interface.stl', type: 'stl', opacity: 1, baseUnit: 'mm', importUnit: 'mm',
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
    solidAnimal: filesForRole('solidAnimal')[0],
    attachment: filesForRole('attachment')[0],
    mechanical: filesForRole('mechanical')[0],
    solidInterface: filesForRole('solidInterface')[0],
};

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
const finalSocketRoot = new THREE.Group(); // Step 5's blended socket (sample-models/chi-final)
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
const orientationLayerVisibility = { animal: false, mechanical: true, solid: false, socket: false, target: false };
// Steps 5 and 6 show the blended assembly: animal, socket and both oriented interfaces.
const blendLayerVisibility = { animal: true, mechanical: true, solid: true, socket: true, target: false };

function interfaceLayerVisibleIn(stage, key) {
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
    if (activeStep === '2c' && key === 'mechanical') positionMechanicalVisible = visible;
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
    const centerHandles = new Set(['XYZ', 'XY', 'YZ', 'XZ']);
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
    const color = axis === 'x' ? NTOP_AXIS_COLORS.x : axis === 'y' ? NTOP_AXIS_COLORS.y : axis === 'z' ? NTOP_AXIS_COLORS.z : null;
    if (color === null) return;
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

function applyImportUnitScale(layer) {
    const base = UNIT_TO_METERS[layer.baseUnit] || 1;
    const selected = UNIT_TO_METERS[layer.importUnit] || base;
    layer.group.scale.setScalar(selected / base * (layer.scalable ? scaleFactor : 1));
    layer.group.updateMatrixWorld(true);
}

function prepareObject(object, layer) {
    normalizeMillimeterExport(object);
    object.traverse(child => {
        if (!child.isMesh) return;
        child.geometry.computeVertexNormals();
        child.material = new THREE.MeshStandardMaterial({
            color: layer.color,
            roughness: 0.72,
            metalness: layer === layers.mechanical ? 0.15 : 0,
            transparent: layer.opacity < 1,
            opacity: layer.opacity,
            depthWrite: layer.opacity >= 1,
            side: THREE.DoubleSide,
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

const bodyLayer = { color: '#b99c75', opacity: 0.2 };
const attachLayer = { color: '#8d98a7', opacity: 1, bakedShading: true, forceTransparent: true, renderOrder: 10 };

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
            : new THREE.MeshStandardMaterial({ ...sharedOptions, roughness: 0.82 });
        child.renderOrder = materialConfig.renderOrder || 0;
    });
    target.add(object);
}

// Step 3 sockets come from two nTop sweeps on the 10-15 Chihuahua (tools/convert_chi_socket_sweeps.py):
// the thickness pair (min x max, 0..20 mm each) at weighting 0.6 / 35 points, and the density pair
// (weighting 0..1 x point density 1..60) at thickness 6 / 12. Moving a slider in one pair puts the other
// pair back at those baseline values, because that is the only combination that was generated.
const socketParameterState = { minThickness: 6, maxThickness: 12, spatialWeighting: 0.6, pointDensity: 35 };
const parameterValues = {
    minThickness: Array.from({ length: 21 }, (_, index) => index),
    maxThickness: Array.from({ length: 21 }, (_, index) => index),
    spatialWeighting: Array.from({ length: 11 }, (_, index) => index / 10),
    pointDensity: [1, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32, 34, 35, 36, 38, 40, 42, 44, 46, 48, 50, 52, 54, 56, 58, 60],
};
const socketParameterDefaults = { minThickness: 6, maxThickness: 12, spatialWeighting: 0.6, pointDensity: 35 };
const SWEEP_GROUPS = { thickness: ['minThickness', 'maxThickness'], density: ['spatialWeighting', 'pointDensity'] };
const sweepGroupOf = key => Object.keys(SWEEP_GROUPS).find(group => SWEEP_GROUPS[group].includes(key));
// The value the student last chose on each Step 3 slider and which ones they changed. Read by the expert grading panel.
const socketParameterChoices = { ...socketParameterDefaults };
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
    clone.traverse(child => {
        if (!child.isMesh) return;
        child.material = new THREE.MeshStandardMaterial({
            color: materialConfig.color,
            roughness: materialConfig.roughness ?? 0.78,
            metalness: 0,
            transparent: materialConfig.opacity < 1,
            opacity: materialConfig.opacity,
            depthWrite: materialConfig.opacity >= 0.72,
            side: THREE.DoubleSide,
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

// The density sweep runs the point density at 1, 2, 4, 6 ... 60; the 35 baseline exists only at
// weighting 0.6. Away from 0.6, 35 becomes 34 (the nearest generated value).
function resolveSweepState(state, group) {
    const resolved = { ...socketParameterDefaults, ...state };
    if (group === 'density' && resolved.pointDensity === 35 && Math.abs(resolved.spatialWeighting - 0.6) > 1e-9) resolved.pointDensity = 34;
    return resolved;
}

// The socket for the current pair of values; the other pair is at its baseline.
function socketModelFile(state = socketParameterState, group = sweepGroupOf(activeSocketParameter)) {
    const pad = value => String(value).padStart(2, '0');
    const s = resolveSweepState(state, group);
    if (group === 'thickness') return `sample-models/chi-socket/t${pad(s.minThickness)}-${pad(s.maxThickness)}.glb`;
    return `sample-models/chi-socket/w${pad(Math.round(s.spatialWeighting * 10))}-d${pad(s.pointDensity)}.glb`;
}

function socketParameterModelFile(key, value) {
    return socketModelFile({ ...socketParameterState, [key]: value }, sweepGroupOf(key));
}

function prepareSocketPreviewObject(object) {
    normalizeMillimeterExport(object);
    object.traverse(child => {
        if (!child.isMesh) return;
        child.geometry.computeVertexNormals();
        child.material = new THREE.MeshStandardMaterial({
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
    return importSelection.attachment.category === 'socket';
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
            if (next >= 0 && next < values.length) socketModelPromise(key, values[next]);
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
    cloneImportForPelvic('solidAnimal', pelvicBody, { color: 0xb99c75, opacity: 0.2, roughness: 0.82 });
    cloneImportForPelvic('attachment', pelvicAttach, { color: 0x8d98a7, opacity: 0.78, roughness: 0.66 });
    buildPlaneOverlays();
    buildSocketPreview();
    applyPelvicStageVisibility();
    attachmentHoles.rebuild(layers.attachment.group, layers.solidAnimal.group);
}

let activeStep = '1';
let importBounds = null;
let pelvicBounds = null;
const planeState = { pick: [1, 2, 1], normal: [0, -1, 0] };

function randomPlanePick() {
    const pick = [0, 0, 0];
    do {
        for (let axis = 0; axis < 3; axis++) pick[axis] = Math.floor(Math.random() * 3);
    } while (pick.every(value => value === 1) || (pick[0] === 1 && pick[1] === 2 && pick[2] === 1));
    return pick;
}

// Students start from a scrambled plane so they have to set it themselves, as they would in nTop.
function randomizePelvicPlane() {
    planeState.pick = randomPlanePick();
    const faceAxes = planeState.pick.map((value, axis) => axis).filter(axis => planeState.pick[axis] !== 1);
    activePelvicPlaneAxis = faceAxes[Math.floor(Math.random() * faceAxes.length)];
    const faceValue = planeState.pick[activePelvicPlaneAxis];
    planeState.normal = [0, 0, 0];
    planeState.normal[activePelvicPlaneAxis] = faceValue === 0 ? 1 : -1;
    activePelvicPlanePreset = `${'xyz'[activePelvicPlaneAxis]}-${faceValue === 0 ? 'min' : 'max'}`;
    document.querySelectorAll('[data-axis]').forEach(select => { select.value = String(planeState.pick[+select.dataset.axis]); });
    document.querySelectorAll('[data-pelvic-axis-slider]').forEach(slider => { slider.value = String(planeState.pick[+slider.dataset.pelvicAxisSlider]); });
    document.querySelectorAll('[data-normal]').forEach(input => { input.value = String(planeState.normal[+input.dataset.normal]); });
    const planeStatus = document.querySelector('[data-plane-test-status]');
}
randomizePelvicPlane();
const interfacePlaneState = { pick: randomPlanePick(), normal: [0, -1, 0] };
document.querySelectorAll('[data-interface-axis]').forEach(select => { select.value = String(interfacePlaneState.pick[+select.dataset.interfaceAxis]); });
document.querySelectorAll('[data-interface-axis-slider]').forEach(slider => { slider.value = String(interfacePlaneState.pick[+slider.dataset.interfaceAxisSlider]); });
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
renderer.setAnimationLoop(() => {
    viewerControls.update();
    controls.update();
    if (renderOverride) renderOverride();
    else renderer.render(scene, camera);
    renderSplitPane();
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

    updatePlane();
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
    // Step 1 visibility belongs to the import preview. Interface stages own
    // their visibility independently and must not inherit a hidden source root.
    clone.visible = true;
    return clone;
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
    interfaceReferenceMechanical.add(cloneForInterface(layers.solidInterface)); // Step 2b picks its plane on the solid interface
    interfaceMechanical.add(cloneForInterface(layers.mechanical));
    interfaceSolid.add(cloneForInterface(layers.solidInterface));
    interfaceRoot.updateMatrixWorld(true);
    interfaceBounds = new THREE.Box3().setFromObject(interfaceReferenceMechanical);
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

function updateInterfaceOrientation() {
    if (!interfaceBounds || !orientedAssembly.children.length) return;
    const interfacePlane = planeData(interfaceBounds, interfacePlaneState, new THREE.Vector3(0, -1, 0));
    const pelvicPlane = planeData(pelvicBounds, planeState, new THREE.Vector3(1, 0, 0));
    const targetNormal = interfaceSurfaceNormal.clone();

    const projectedTarget = interfacePositionState.clone().addScaledVector(
        pelvicPlane.normal,
        -interfacePositionState.clone().sub(pelvicPlane.point).dot(pelvicPlane.normal),
    );
    const targetX = tangentDirection(projectedTarget.sub(pelvicPlane.point), targetNormal);
    const targetY = targetNormal.clone().cross(targetX).normalize();
    const sourceX = tangentDirection(pelvicPlane.normal, interfacePlane.normal);
    const sourceY = interfacePlane.normal.clone().cross(sourceX).normalize();
    const base = basisQuaternion(targetX, targetY, targetNormal)
        .multiply(basisQuaternion(sourceX, sourceY, interfacePlane.normal).invert());

    const toRadians = THREE.MathUtils.degToRad;
    const lateral = new THREE.Quaternion().setFromAxisAngle(targetY, toRadians(orientationState.lateral));
    const medial = new THREE.Quaternion().setFromAxisAngle(targetNormal, toRadians(orientationState.medial));
    const preSpinQuaternion = medial.multiply(lateral).multiply(base).normalize();

    // A mesh surface normal is the discrete equivalent of the solid-interface field gradient.
    const sourceGradient = closestSurfacePoint(interfacePlane.point, solidInterfaceTriangles, solidInterfaceBounds).normal;
    const orientedGradient = sourceGradient.applyQuaternion(preSpinQuaternion).normalize();
    const interfaceSpin = new THREE.Quaternion().setFromAxisAngle(orientedGradient, toRadians(orientationState.rotation));
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

function applyPelvicStageVisibility() {
    if (!isPelvicStep(activeStep)) return;
    overlayControlsEl.dataset.stage = activeStep;
    const isSocketStage = activeStep === '3';
    Object.entries(planeLayerTargets).forEach(([key, target]) => {
        // Step 3's Socket block takes the attachment surface, not the pelvic plane, so the plane guides stay in 2b.
        const stageAllows = ['box', 'point', 'normal', 'plane'].includes(key) ? !isSocketStage : true;
        target.visible = planeLayerVisibility[key] && stageAllows;
    });
    pelvicAttach.traverse(child => {
        if (!child.isMesh || !child.material) return;
        child.material.opacity = isSocketStage ? 0.14 : 0.78;
        child.material.transparent = true;
        child.material.depthWrite = !isSocketStage;
        child.material.needsUpdate = true;
    });
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
    positionTransform.enabled = activeStep === '2c' && interfaceLayerVisible('target');
    positionTransformHelper.visible = positionTransform.enabled;
    interfaceOverlayControlsEl.dataset.stage = activeStep;
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
        output.textContent = entry.name;
        output.title = entry.pathLabel;
        const select = document.querySelector('[data-import-unit="' + role + '"]');
        if (select) select.value = layers[role].importUnit;
    });
    syncImportAlerts();
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
    if (mechanical.sizeClass !== solidInterface.sizeClass) {
        found.push({
            key: 'interface', chip: 'Interface mismatch', title: 'Interfaces do not match',
            detail: `Mechanical: ${mechanical.label} · Solid: ${solidInterface.label}`,
            notes: {
                mechanical: `Does not pair with ${solidInterface.name}.`,
                solidInterface: `Does not pair with ${mechanical.name}.`,
            },
        });
    }
    if (attachment.breed !== solidAnimal.breed) {
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
    const signature = JSON.stringify(mismatches);
    if (signature === importAlertSignature) return;
    const previousKeys = JSON.parse(importAlertSignature).map(item => item.key);
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
    importStatusEl.classList.toggle('is-warning', mismatches.length > 0);
    importStatusEl.innerHTML = mismatches.length ? IMPORT_WARN_ICON + ' Mismatch' : '<i data-lucide="circle-check" aria-hidden="true"></i> Ready';
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

importAlertChipEl.addEventListener('click', () => {
    const node = document.querySelector('.workflow-node.has-mismatch');
    if (node) node.open = true;
    showStep('1', true);
});

async function loadImportSelection(role, entry) {
    const layer = layers[role];
    const previous = importSelection[role];
    importSelection[role] = entry;
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
        rebuildPelvicScene();
        buildInterfaceScene();
        syncImportPathLabels();
        clearMeasurement();
        showStep(activeStep);
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
            child.material = new THREE.MeshStandardMaterial({
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
    const staged = importStage?.role === role ? importStage.entry : null;
    explorer.innerHTML = `
        <div class="import-crumbs">${current.path.map((name, index) => `${index ? '<i data-lucide="chevron-right" aria-hidden="true"></i>' : ''}<button type="button" data-crumb="${current.path.slice(0, index + 1).join('|')}">${name}</button>`).join('')}</div>
        <div class="import-entries" role="listbox" aria-label="${IMPORT_ROLES[role].short} files">${entries.map((entry, index) => entry.kind === 'folder'
            ? `<button type="button" class="import-entry folder" data-index="${index}"><i data-lucide="folder" aria-hidden="true"></i><strong>${entry.name}</strong><small>${entry.children.length} items</small></button>`
            : `<button type="button" class="import-entry ${entry.role === role ? '' : 'dim'} ${importSelection[role] === entry ? 'loaded' : ''} ${staged === entry ? 'staged' : ''}" data-index="${index}" role="option" aria-selected="${staged === entry}" title="${entry.role === role ? entry.label : 'This is a ' + IMPORT_ROLES[entry.role].short.toLowerCase() + ' mesh'}"><i data-lucide="box" aria-hidden="true"></i><strong>${entry.name}</strong><small>${formatBytes(entry.bytes)}</small></button>`).join('')}</div>
        ${staged ? `<div class="import-stage-bar"><span title="${staged.pathLabel}">${staged.label} · ${staged.ext} · ${formatBytes(staged.bytes)}</span><button type="button" class="import-load" data-stage-load ${staged.role === role ? '' : 'disabled'}>Load</button><button type="button" data-stage-cancel aria-label="Cancel preview">&times;</button></div>` : ''}`;
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
            if (importStage?.entry === entry) return;
            stageImport(role, entry);
        });
        row.addEventListener('dblclick', () => {
            if (entry.kind === 'file' && entry.role === role) loadImportSelection(role, entry);
        });
    });
    explorer.querySelector('[data-stage-load]')?.addEventListener('click', () => loadImportSelection(role, staged));
    explorer.querySelector('[data-stage-cancel]')?.addEventListener('click', clearImportStage);
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
        if (key === 'solidAnimal' || key === 'attachment') rebuildPelvicScene();
        buildInterfaceScene();
        clearMeasurement();
        if (activeStep === '1') requestAnimationFrame(() => frameObject(importRoot));
        if (isPelvicStep(activeStep)) requestAnimationFrame(() => frameObject(planeRoot));
    });
});

syncImportPathLabels();

// ---- Step 1 scale factor ----------------------------------------------------------------------
const scaleFactorInput = document.getElementById('scale-factor');
const scaleNoteEl = document.getElementById('scale-note');
function setScaleFactor(value) {
    scaleFactor = value;
    scaleFactorInput.value = String(value);
    Object.values(layers).forEach(applyImportUnitScale);
    importBounds = new THREE.Box3().setFromObject(importRoot);
    rebuildPelvicScene();
    buildInterfaceScene();
    clearMeasurement();
    scaleNoteEl.hidden = value === 1;
    scaleNoteEl.textContent = value === 1 ? '' : `Animal scan scaled by ${value}. The sample sockets were generated for the unscaled scan, so the socket preview stays at scale 1.`;
    if (activeStep === '1') requestAnimationFrame(() => frameObject(importRoot));
    if (isPelvicStep(activeStep)) requestAnimationFrame(() => frameObject(planeRoot));
}
{
    const commit = () => {
        const value = Number(scaleFactorInput.value);
        if (scaleFactorInput.value === '' || !Number.isFinite(value) || value < 0.5 || value > 2) { scaleFactorInput.value = String(scaleFactor); return; }
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
        const blob = await (await fetch(exportFile)).blob();
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
    planeRoot.visible = isPelvic;
    (isAttachment ? attachmentHoles.root : isInterface ? interfaceRoot : planeRoot).add(socketPreviewRoot);
    if (isAttachment) {
        socketPreviewRoot.visible = planeLayerVisibility.socket;
        loadSocketParameterModel(activeSocketParameter, socketParameterState[activeSocketParameter]);
    }
    interfaceRoot.visible = isInterface;
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
    viewerStepEl.textContent = paired ? 'Steps 2b + 2c' : 'Step ' + activeStep;
    viewerTitleEl.textContent = paired ? 'Interface position and plane' : titles[activeStep];
    document.querySelectorAll('.workflow-step').forEach(section => {
        section.classList.toggle('active', section.dataset.step === activeStep || (paired && SPLIT_STEPS.includes(section.dataset.step)));
    });
    const major = activeStep.charAt(0);
    document.querySelectorAll('.workflow-progress-step').forEach(button => button.classList.toggle('active', button.dataset.goStep.charAt(0) === major));
    renderLegend();
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
        const axis = +select.dataset.axis;
        const value = +select.value;
        const previousValue = planeState.pick[axis];
        planeState.pick[axis] = value;
        if (value === 1 && !planeState.pick.some((pick, index) => index !== axis && pick !== 1)) {
            planeState.pick[axis] = previousValue;
            select.value = String(previousValue);
            return;
        }
        if (value !== 1) {
            activePelvicPlaneAxis = axis;
        } else if (axis === activePelvicPlaneAxis) {
            activePelvicPlaneAxis = planeState.pick.findIndex(pick => pick !== 1);
        }
        const faceValue = planeState.pick[activePelvicPlaneAxis];
        const direction = faceValue === 0 ? 1 : -1;
        planeState.normal = [0, 0, 0];
        planeState.normal[activePelvicPlaneAxis] = direction;
        activePelvicPlanePreset = `${'xyz'[activePelvicPlaneAxis]}-${faceValue === 0 ? 'min' : 'max'}`;
        document.querySelectorAll('[data-normal]').forEach(input => {
            input.value = String(planeState.normal[+input.dataset.normal]);
        });
        updatePlane();
        loadPelvicPlaneTestModel(activePelvicPlanePreset);
    });
});
document.querySelectorAll('[data-normal]').forEach(input => {
    const commit = () => {
        const axis = +input.dataset.normal;
        const value = Number(input.value);
        if (input.value !== '' && Number.isFinite(value) && value !== 0) {
            planeState.pick = [1, 1, 1];
            document.querySelectorAll('[data-axis]').forEach(select => { select.value = '1'; });
            const select = document.querySelector(`[data-axis="${axis}"]`);
            select.value = value > 0 ? '0' : '2';
            select.dispatchEvent(new Event('change'));
        }
        document.querySelectorAll('[data-normal]').forEach(field => { field.value = planeState.normal[+field.dataset.normal]; });
        document.querySelectorAll('[data-pelvic-axis-slider]').forEach(slider => { slider.value = planeState.pick[+slider.dataset.pelvicAxisSlider]; });
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
        loadSocketParameterModel(key, value);
    };
    input.addEventListener('input', updateParameter);
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
document.getElementById('toggle-view-cube').addEventListener('click', event => {
    const visible = !event.currentTarget.classList.contains('active');
    viewerControls.setCubeVisible(visible);
    splitView?.setCubeVisible(visible);
    event.currentTarget.classList.toggle('active', visible);
    event.currentTarget.setAttribute('aria-pressed', String(visible));
    event.currentTarget.setAttribute('aria-label', (visible ? 'Hide' : 'Show') + ' view cube');
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
    splitView.setCubeVisible(document.getElementById('toggle-view-cube').classList.contains('active'));
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
    collapseTarget: () => { const b = document.getElementById('move-help'); return b && b.offsetParent ? b : null; },
    axisColors: NTOP_AXIS_COLORS,
    pickMeshes: navigationPickMeshes,
    isGizmoHovered: () => !!positionTransform.axis,
    frameView: fitViews,
});
document.getElementById('move-help').addEventListener('click', () => viewerControls.startIntro({ force: true }));

const attachmentHoles = createAttachmentHoles({ scene, camera, canvas,
    transform: positionTransform, transformHelper: positionTransformHelper,
    loadGLB, collectSurfaceTriangles, closestSurfacePoint, keepOverlayVisible,
    isMeasuring: () => measureMode,
});

// ---- Step 4b: the attachment sweep (10-15) ---------------------------------------------------------
// Four swept inputs; screw head height (5), nozzle (0.6) and hole depth (12) were fixed in the sweep.
const attachmentValues = { attachDiameter: [0, 4, 8, 12, 16], normalWallDistance: [0, 4, 8, 12], screwHeadDiameter: [0, 4, 8, 12], screwShaftDiameter: [0, 4, 8, 12] };
const attachmentDesign = { attachDiameter: 4, normalWallDistance: 4, screwHeadDiameter: 8, screwShaftDiameter: 4 };
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
    if (!attachmentHoles.designExists(attachmentDesign)) {
        attachmentStatus(`nTop did not generate attach ${attachmentDesign.attachDiameter} / wall ${attachmentDesign.normalWallDistance} / head ${attachmentDesign.screwHeadDiameter} / shaft ${attachmentDesign.screwShaftDiameter}; the last generated attachment stays in the view.`);
        return;
    }
    attachmentStatus('Loading nTop attachment…');
    try {
        const applied = await attachmentHoles.setDesign(attachmentDesign);
        if (request !== attachmentDesignRequest) return;
        if (applied) attachmentStatus('');
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
        const value = attachmentValues[key][+input.value];
        attachmentDesign[key] = value;
        setAttachmentControl(key, value);
        applyAttachmentDesign();
    });
});

// ---- Step 5: the blended-socket sweep (10-15, tools/convert_chi_final_sweeps.py) --------------------
// Min x Max Blend (0..60 by 5) at connector radius 5, and connector radius 0..15 at blend 0 / 20.
const blendValues = {
    minBlend: Array.from({ length: 13 }, (_, index) => index * 5),
    maxBlend: Array.from({ length: 13 }, (_, index) => index * 5),
    connectorRadius: Array.from({ length: 16 }, (_, index) => index),
};
const blendDefaults = { minBlend: 0, maxBlend: 20, connectorRadius: 5 };
const blendState = { ...blendDefaults };
const BLEND_GROUPS = { blend: ['minBlend', 'maxBlend'], connector: ['connectorRadius'] };
const blendGroupOf = key => Object.keys(BLEND_GROUPS).find(group => BLEND_GROUPS[group].includes(key));
let activeBlendParameter = 'maxBlend';
let currentFinalFile = null;
const finalModelPromises = new Map();
let finalModelRequest = 0;
function finalSocketFile(state, group) {
    const pad = value => String(value).padStart(2, '0');
    if (group === 'connector') return `sample-models/chi-final/c${pad(state.connectorRadius)}.glb`;
    return `sample-models/chi-final/b${pad(state.minBlend)}-${pad(state.maxBlend)}.glb`;
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
    const index = blendValues[key].indexOf(value);
    if (!input || index < 0) return;
    input.value = String(index);
    blendState[key] = value;
    document.querySelector('[data-blend-output="' + key + '"]').value = value;
    input.setAttribute('aria-valuetext', value + ' mm');
    const mirror = document.querySelector('[data-blend-mirror="' + key + '"]');
    if (mirror) mirror.textContent = `${mirror.textContent.split(' · ')[0]} · ${value} mm`;
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
    const state = { ...blendDefaults, [key]: value };
    BLEND_GROUPS[group].forEach(k => { state[k] = k === key ? value : blendState[k]; });
    const file = finalSocketFile(state, group);
    blendStatus(`Loading nTop blended socket · ${key === 'connectorRadius' ? 'connector radius' : key === 'minBlend' ? 'min blend' : 'max blend'} ${value} mm`);
    try {
        const object = await finalModelPromise(file);
        if (request !== finalModelRequest) return;
        finalSocketRoot.clear();
        finalSocketRoot.add(object);
        currentFinalFile = file;
        Object.entries(blendDefaults).forEach(([k, v]) => { if (blendGroupOf(k) !== group) setBlendControl(k, v); });
        BLEND_GROUPS[group].forEach(k => setBlendControl(k, state[k]));
        activeBlendParameter = key;
        blendStatus('');
        applyInterfaceStageVisibility();
        const values = blendValues[key];
        const index = values.indexOf(value);
        [index - 1, index + 1].forEach(next => {
            if (next >= 0 && next < values.length) finalModelPromise(finalSocketFile({ ...state, [key]: values[next] }, group)).catch(() => {});
        });
    } catch (error) {
        if (request !== finalModelRequest) return;
        blendStatus(`Could not load the blended socket for ${key === 'connectorRadius' ? 'connector radius' : key === 'minBlend' ? 'min blend' : 'max blend'} ${value} mm.`);
        console.error(error);
    }
}
const blendControlsEl = document.getElementById('blend-controls');
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
        const value = blendValues[key][+input.value];
        setBlendControl(key, value);
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

Promise.all([
    ...Object.values(layers).map(loadImportLayer),
    attachmentHoles.ready,
]).then(() => {
    Object.values(layers).forEach(applyImportUnitScale);
    importBounds = new THREE.Box3().setFromObject(importRoot);
    rebuildPelvicScene();
    buildInterfaceScene();
    Object.keys(layers).forEach(key => syncImportVisibility(key, layers[key].visible));
    loaderEl.hidden = true;
    showStep('1');
    // showStep frames the model on the next animation frame; the intro starts from that view.
    requestAnimationFrame(() => requestAnimationFrame(() => viewerControls.startIntro()));
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
                const values = outputAttr === 'param-output' ? parameterValues[key] : outputAttr === 'attach-output' ? attachmentValues[key] : blendValues[key];
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
        const select = document.querySelector(`[data-axis="${slider.dataset.pelvicAxisSlider}"]`);
        select.value = Math.round(+slider.value);
        select.dispatchEvent(new Event('change'));
        slider.value = select.value;
        slider.setAttribute('aria-valuetext', ['Min', 'Centroid', 'Max'][+slider.value]);
    });
    document.querySelector(`[data-axis="${slider.dataset.pelvicAxisSlider}"]`).addEventListener('change', event => { slider.value = event.target.value; });
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
    let axis = normal ? normal.findIndex(n => Number(n) !== 0) : -1;
    if (axis < 0 || planeState.pick[axis] === 1) axis = planeState.pick.findIndex(v => v !== 1);
    if (axis < 0) { planeState.pick[1] = 2; axis = 1; }
    activePelvicPlaneAxis = axis;
    const face = planeState.pick[axis];
    planeState.normal = [0, 0, 0];
    planeState.normal[axis] = face === 0 ? 1 : -1;
    activePelvicPlanePreset = `${'xyz'[axis]}-${face === 0 ? 'min' : 'max'}`;
    document.querySelectorAll('[data-axis]').forEach(select => { select.value = String(planeState.pick[+select.dataset.axis]); });
    document.querySelectorAll('[data-pelvic-axis-slider]').forEach(slider => { slider.value = String(planeState.pick[+slider.dataset.pelvicAxisSlider]); });
    document.querySelectorAll('[data-normal]').forEach(input => { input.value = String(planeState.normal[+input.dataset.normal]); });
    updatePlane();
    loadPelvicPlaneTestModel(activePelvicPlanePreset);
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

window.gapWalkthrough = {
    answers: () => ({
        pelvicPlane: { pick: [...planeState.pick], normal: [...planeState.normal] },
        interfacePlane: { pick: [...interfacePlaneState.pick], normal: [...interfacePlaneState.normal] },
        ...socketParameterChoices,
        lateral: orientationState.lateral,
        medial: orientationState.medial,
        rotation: orientationState.rotation,
    }),
    touched: () => new Set(socketParameterTouched),
    imports: () => ({ selection: Object.fromEntries(Object.entries(importSelection).map(([role, entry]) => [role, { ...entry }])), mismatches: importMismatches() }),
    parameterValues,
    design: designValues,
    attachment: attachmentDesign,
    blend: blendState,
    defaults: { ...socketParameterDefaults },
    goToStep: step => showStep(step, true),
    // Show a value on the model: 'pelvicPlane' / 'interfacePlane' take {pick, normal}, the angles a number,
    // the Step 3 sliders one of their values.
    show: showValue,
    ghost: { capture: captureGhost, clear: clearGhost, setLook: setGhostLook, targets: ghostTargets, root: ghostRoot },
    three: { THREE, scene, camera, renderer, canvas, controls },
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
