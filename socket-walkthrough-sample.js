import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { createAttachmentHoles } from './attachment-holes.js?v=3';

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

const grid = new THREE.GridHelper(2.4, 24, 0xaeb8c4, 0xd8dee5);
grid.rotation.x = Math.PI / 2;
grid.material.transparent = true;
grid.material.opacity = 0.58;
grid.material.depthWrite = false;
scene.add(grid);

const importRoot = new THREE.Group();
const planeRoot = new THREE.Group();
const interfaceRoot = new THREE.Group();
const measurementRoot = new THREE.Group();
scene.add(importRoot, planeRoot, interfaceRoot, measurementRoot);

const layers = {
    solidAnimal: {
        label: 'Solid animal', color: '#496b94', group: new THREE.Group(), visible: true,
        file: 'sample-models/chihuahua-original.obj?v=4x', type: 'obj', opacity: 0.28, baseUnit: 'm', importUnit: 'm',
    },
    attachment: {
        label: 'Attachment mesh', color: '#169c8c', group: new THREE.Group(), visible: true,
        file: 'sample-models/chihuahua-farback-1.stl?v=4x', type: 'stl', opacity: 0.88, baseUnit: 'm', importUnit: 'm',
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

const modelCatalog = {
    chihuahua: {
        label: 'Chihuahua', slug: 'chihuahua',
        solid: { label: 'Chihuahua original', file: 'sample-models/chihuahua-original.obj?v=4x', type: 'obj', units: 'm' },
    },
    greyhound: {
        label: 'Greyhound', slug: 'greyhound',
        solid: { label: 'Greyhound original', file: 'sample-models/greyhound-solid.obj', type: 'obj', units: 'm' },
    },
    'german-shepherd': {
        label: 'German Shepherd', slug: 'german-shepherd',
        solid: { label: 'German Shepherd original', file: 'sample-models/german-shepherd-solid.obj', type: 'obj', units: 'm' },
    },
};

const attachmentCategoryLabels = {
    farback: 'Far back',
    forward: 'Forward',
    leghole: 'Leg hole',
    toolow: 'Too low',
};

const modelPickerState = { breed: 'chihuahua', category: 'farback', variation: 1 };

function attachmentCatalogEntry() {
    const breed = modelCatalog[modelPickerState.breed];
    const category = modelPickerState.category;
    const variation = modelPickerState.variation;
    return {
        label: `${breed.label} · ${attachmentCategoryLabels[category]} · ${variation}`,
        file: `sample-models/${breed.slug}-${category}-${variation}.stl${breed.slug === 'chihuahua' ? '?v=4x' : ''}`,
        type: 'stl',
    };
}

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
    triadX: new THREE.Group(),
    triadY: new THREE.Group(),
    triadZ: new THREE.Group(),
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
orientedAssembly.add(interfaceMechanical, interfaceSolid);
interfaceRoot.add(interfaceAnimal, interfaceReferenceMechanical, orientedAssembly, interfaceOverlayRoot);

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
    if (activeStep === '4') {
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

const loadGLB = file => new Promise((resolve, reject) => gltfLoader.load(file, resolve, undefined, reject));
const loadSTL = file => new Promise((resolve, reject) => stlLoader.load(file, resolve, undefined, reject));
const loadOBJ = file => new Promise((resolve, reject) => objLoader.load(file, resolve, undefined, reject));

function normalizeMillimeterExport(object) {
    const box = new THREE.Box3().setFromObject(object);
    if (box.getSize(new THREE.Vector3()).length() > 10) object.scale.setScalar(0.001);
}

const UNIT_TO_METERS = { m: 1, cm: 0.01, mm: 0.001, in: 0.0254 };

function applyImportUnitScale(layer) {
    const base = UNIT_TO_METERS[layer.baseUnit] || 1;
    const selected = UNIT_TO_METERS[layer.importUnit] || base;
    layer.group.scale.setScalar(selected / base);
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

const socketParameterState = {
    socketThickness: 10,
    boundaryThickness: 10,
    pointCount: 100,
    pelvicThickness: 0,
    pelvicDistance: 50,
};
const POINT_COUNT_VALUES = [10, 20, 40, 60, 80, 100, 120, 140, 160, 180,
    200, 220, 240, 260, 280, 300, 320, 340, 360, 380, 400];
const parameterValues = {
    socketThickness: Array.from({ length: 11 }, (_, index) => index * 2),
    boundaryThickness: Array.from({ length: 11 }, (_, index) => index * 2),
    pointCount: POINT_COUNT_VALUES,
    pelvicThickness: Array.from({ length: 16 }, (_, index) => index * 2),
    pelvicDistance: [1, 5, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100,
        110, 120, 130, 140, 150, 160, 170, 180, 190, 200],
};
const socketParameterDefaults = {
    socketThickness: 10,
    boundaryThickness: 10,
    pointCount: 100,
    pelvicThickness: 0,
    pelvicDistance: 50,
};
const socketParameterModelMeta = {
    socketThickness: { directory: 'socket-thickness', label: 'socket thickness', unit: ' mm' },
    boundaryThickness: { directory: 'boundary-thickness', label: 'boundary thickness', unit: ' mm' },
    pointCount: { label: 'lattice point count', unit: ' points' },
    pelvicThickness: { directory: 'pelvic-thickness', label: 'pelvic thickness', unit: ' mm' },
    pelvicDistance: { directory: 'pelvic-distance', label: 'pelvic fade distance', unit: ' mm' },
};
const socketModelPromises = new Map();
const pelvicPlaneModelPromises = new Map();
let socketModelRequest = 0;
let activeSocketParameter = 'pointCount';
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

function pointCountModelFile(value) {
    return `sample-models/point-count-test/point-count-${String(value).padStart(3, '0')}.glb?v=4x`;
}

function socketParameterModelFile(key, value) {
    if (key === 'pointCount') return pointCountModelFile(value);
    const directory = socketParameterModelMeta[key].directory;
    const fileValue = String(value).padStart(3, '0');
    return `sample-models/step-2b/${directory}/${directory}-${fileValue}.glb?v=${key === 'pelvicThickness' ? 'distance50' : 'step2b2'}`;
}

function pelvicPlaneModelFile(preset) {
    return `sample-models/pelvic-plane-test/pelvic-plane-${preset}.glb?v=90mm`;
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
    const cacheKey = `${key}:${value}`;
    if (!socketModelPromises.has(cacheKey)) {
        socketModelPromises.set(cacheKey, loadGLB(socketParameterModelFile(key, value)).then(gltf => {
            return prepareSocketPreviewObject(gltf.scene);
        }));
    }
    return socketModelPromises.get(cacheKey);
}

function pelvicPlaneModelPromise(preset) {
    if (!pelvicPlaneModelPromises.has(preset)) {
        pelvicPlaneModelPromises.set(preset, loadGLB(pelvicPlaneModelFile(preset)).then(gltf => {
            return prepareSocketPreviewObject(gltf.scene);
        }));
    }
    return pelvicPlaneModelPromises.get(preset);
}

function hasSocketModelLibrary() {
    return modelPickerState.breed === 'chihuahua' && modelPickerState.category === 'farback'
        && modelPickerState.variation === 1;
}

function showSourceModelsOnly(status) {
    if (hasSocketModelLibrary()) return false;
    socketPreviewRoot.clear();
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
        socketParameterState[key] = value;
        activeSocketParameter = key;
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

function loadSocketPreviewModel(value) {
    return loadSocketParameterModel('pointCount', value);
}

async function loadPelvicPlaneTestModel(preset) {
    const request = ++socketModelRequest;
    const config = PELVIC_PLANE_PRESETS[preset];
    const status = document.querySelector('[data-plane-test-status]');
    if (showSourceModelsOnly(status)) return;
    status.hidden = false;
    status.textContent = `Loading ${config.label} nTop mesh`;
    try {
        const object = await pelvicPlaneModelPromise(preset);
        if (request !== socketModelRequest) return;
        socketPreviewRoot.clear();
        socketPreviewRoot.add(object);
        status.textContent = '';
        status.hidden = true;
        applyPelvicStageVisibility();
    } catch (error) {
        if (request !== socketModelRequest) return;
        status.textContent = `Could not load the ${config.label} nTop mesh`;
        console.error(error);
    }
}

function buildSocketPreview() {
    loadSocketPreviewModel(socketParameterState.pointCount);
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
const interfacePlaneState = { pick: [1, 2, 1], normal: [0, -1, 0] };
const interfacePositionState = new THREE.Vector3();
const orientationState = {
    lateral: 180,
    medial: -179,
    rotation: 13,
    adjust: [0, 5, 0],
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
new ResizeObserver(resize).observe(stage);
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

renderer.setAnimationLoop(() => {
    controls.update();
    renderer.render(scene, camera);
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
    grid.position.set(center.x, center.y, box.min.z - size.z * 0.03);
    grid.scale.setScalar(Math.max(size.x, size.y, size.z, 0.2));
}

const measureRaycaster = new THREE.Raycaster();
const measurePointer = new THREE.Vector2();
const measurementPoints = [];
let measurementLine = null;
let measureMode = false;
let measurePointerDown = null;

function measurementRoots() {
    if (activeStep === '4') return attachmentHoles.measurementRoots();
    if (activeStep === '1') return Object.values(layers).filter(layer => layer.group.visible).map(layer => layer.group);
    if (activeStep.startsWith('2')) return [pelvicBody, pelvicAttach, socketPreviewRoot].filter(root => root.visible);
    if (activeStep.startsWith('3')) return [interfaceAnimal, interfaceReferenceMechanical, orientedAssembly, socketPreviewRoot].filter(root => root.visible);
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
    measurementRoots().forEach(root => box.expandByObject(root));
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

function pickMeasurementPoint(event) {
    const rect = canvas.getBoundingClientRect();
    measurePointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    measurePointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    measureRaycaster.setFromCamera(measurePointer, camera);
    const hit = measureRaycaster.intersectObjects(visibleMeasurementMeshes(), false)[0];
    if (hit) addMeasurementPoint(hit.point);
}

function setMeasureMode(enabled) {
    measureMode = enabled;
    measureButtonEl.classList.toggle('active', enabled);
    measureButtonEl.setAttribute('aria-label', enabled ? 'Close measurement tool' : 'Measure between two points');
    measurePanelEl.hidden = !enabled;
    stage.classList.toggle('is-measuring', enabled);
    if (!enabled) clearMeasurement();
    if (activeStep === '4') {
        if (enabled) attachmentHoles.cancelPicking();
        attachmentHoles.syncVisibility();
    }
}

canvas.addEventListener('pointerdown', event => {
    if (!measureMode || event.button !== 0) return;
    measurePointerDown = { x: event.clientX, y: event.clientY };
});

canvas.addEventListener('pointerup', event => {
    if (!measureMode || !measurePointerDown || event.button !== 0) return;
    const movement = Math.hypot(event.clientX - measurePointerDown.x, event.clientY - measurePointerDown.y);
    measurePointerDown = null;
    if (movement <= 5) pickMeasurementPoint(event);
});

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

    const triadOrigin = pelvicBounds.min.clone().addScalar(-diag * 0.06);
    const triadLength = Math.max(size.x, size.y, size.z) * 0.28;
    const triadColors = [NTOP_AXIS_COLORS.x, NTOP_AXIS_COLORS.y, NTOP_AXIS_COLORS.z];
    const triadLabels = ['X', 'Y', 'Z'];
    const triadDirections = [
        new THREE.Vector3(1, 0, 0),
        new THREE.Vector3(0, 1, 0),
        new THREE.Vector3(0, 0, 1),
    ];
    const triadTargets = [overlayGroups.triadX, overlayGroups.triadY, overlayGroups.triadZ];
    triadDirections.forEach((direction, index) => {
        const axis = new THREE.ArrowHelper(direction, triadOrigin, triadLength, triadColors[index], triadLength * 0.18, triadLength * 0.09);
        [axis.line, axis.cone].forEach(part => {
            part.material.transparent = true;
            part.material.opacity = 1;
            part.material.depthTest = false;
            part.material.depthWrite = false;
            part.material.toneMapped = false;
            part.renderOrder = 40;
        });
        triadTargets[index].add(axis);

        const labelCanvas = document.createElement('canvas');
        labelCanvas.width = 96;
        labelCanvas.height = 48;
        const context = labelCanvas.getContext('2d');
        context.font = '700 34px Inter, Arial, sans-serif';
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        context.fillStyle = '#' + triadColors[index].toString(16).padStart(6, '0');
        context.fillText(triadLabels[index], 48, 25);
        const texture = new THREE.CanvasTexture(labelCanvas);
        texture.colorSpace = THREE.SRGBColorSpace;
        const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false }));
        label.position.copy(triadOrigin).addScaledVector(direction, triadLength * 1.16);
        label.scale.set(diag * 0.052, diag * 0.026, 1);
        label.renderOrder = 41;
        triadTargets[index].add(label);
    });
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
    positionTransform.detach();
    [interfaceAnimal, interfaceReferenceMechanical, interfaceMechanical, interfaceSolid,
        ...Object.values(interfaceOverlayGroups)].forEach(group => group.clear());
    orientedAssembly.position.set(0, 0, 0);
    orientedAssembly.quaternion.identity();
    orientedAssembly.updateMatrixWorld(true);
    interfaceAnimal.add(cloneForInterface(layers.solidAnimal));
    interfaceReferenceMechanical.add(cloneForInterface(layers.mechanical));
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
    interfaceAxisTriad.position.copy(data.point);
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
    const lateral = new THREE.Quaternion().setFromAxisAngle(targetY, toRadians(orientationState.lateral - 180));
    const medial = new THREE.Quaternion().setFromAxisAngle(targetNormal, toRadians(orientationState.medial - 180));
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
    if (activeStep.startsWith('2')) renderLegend();
}

function applyPelvicStageVisibility() {
    if (!activeStep.startsWith('2')) return;
    overlayControlsEl.dataset.stage = activeStep;
    const isSocketStage = activeStep === '2b';
    Object.entries(planeLayerTargets).forEach(([key, target]) => {
        const stageAllows = key === 'box' ? !isSocketStage : true;
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
    interfaceOverlayControlsEl.querySelectorAll('.workflow-layer-menu').forEach(menu => {
        const inputs = Array.from(menu.querySelectorAll('input[data-interface-layer]'));
        menu.querySelector('summary').classList.toggle('active', inputs.some(input => interfaceLayerVisibility[input.dataset.interfaceLayer]));
    });
    setVisibilityButton(
        document.getElementById('interface-plane-visibility'),
        ['point', 'normal', 'plane'].some(key => interfaceLayerVisibility[key]),
    );
    setVisibilityButton(document.getElementById('interface-position-visibility'), interfaceLayerVisibility.target);
    document.querySelectorAll('[data-interface-group]').forEach(button => {
        const keys = interfaceLayerGroups[button.dataset.interfaceGroup] || [];
        setVisibilityButton(button, keys.some(key => interfaceLayerVisibility[key]));
    });
}

function syncInterfaceVisibility(key, visible) {
    const target = interfaceLayerTargets[key];
    if (!target) return;
    if (activeStep === '3a' && key === 'mechanical') positionMechanicalVisible = visible;
    else interfaceLayerVisibility[key] = visible;
    target.visible = visible;
    document.querySelectorAll('button[data-interface-layer="' + key + '"]').forEach(button => setVisibilityButton(button, visible));
    document.querySelectorAll('input[data-interface-layer="' + key + '"]').forEach(input => { input.checked = visible; });
    syncInterfaceLayerMenus();
    applyInterfaceStageVisibility();
    if (activeStep.startsWith('3')) renderLegend();
}

function syncInterfaceGroupVisibility(group, visible) {
    (interfaceLayerGroups[group] || []).forEach(key => {
        interfaceLayerVisibility[key] = visible;
        document.querySelectorAll('button[data-interface-layer="' + key + '"]').forEach(button => setVisibilityButton(button, visible));
        document.querySelectorAll('input[data-interface-layer="' + key + '"]').forEach(input => { input.checked = visible; });
    });
    syncInterfaceLayerMenus();
    applyInterfaceStageVisibility();
}

const interfaceAxisTriad = new THREE.Group();
[new THREE.Vector3(1,0,0), new THREE.Vector3(0,1,0), new THREE.Vector3(0,0,1)].forEach((axis, index) => {
    interfaceAxisTriad.add(new THREE.ArrowHelper(axis, new THREE.Vector3(), 0.04, [0xe65050,0x58b85a,0x398fe6][index], 0.008, 0.004));
});
keepOverlayVisible(interfaceAxisTriad, 130);
interfaceRoot.add(interfaceAxisTriad);

function applyInterfaceStageVisibility() {
    if (!activeStep.startsWith('3')) return;
    const isPlane = activeStep === '3b';
    const isPosition = activeStep === '3a';
    const isOrientation = activeStep === '3c';
    interfaceLayerTargets.reference.visible = isPlane && interfaceLayerVisibility.reference;
    interfaceLayerTargets.animal.visible = (isPosition || isOrientation) && interfaceLayerVisibility.animal;
    ['mechanical', 'solid', 'target'].forEach(key => {
        interfaceLayerTargets[key].visible = (isPosition || isOrientation) && interfaceLayerVisibility[key];
    });
    ['surfaceNormal', 'frame'].forEach(key => { interfaceLayerTargets[key].visible = false; });
    interfaceLayerTargets.box.visible = isPlane && interfaceLayerVisibility.box;
    ['point', 'normal', 'plane'].forEach(key => {
        interfaceLayerTargets[key].visible = isPlane && interfaceLayerVisibility[key];
    });
    if (isPosition) {
        interfaceLayerTargets.mechanical.visible = positionMechanicalVisible;
        interfaceLayerTargets.solid.visible = false;
    }
    document.querySelectorAll('button[data-interface-layer="mechanical"]').forEach(button => setVisibilityButton(button, isPosition ? positionMechanicalVisible : interfaceLayerVisibility.mechanical));
    interfaceLayerTargets.socket.visible = !isPlane && interfaceLayerVisibility.socket;
    interfaceAxisTriad.visible = isPlane;
    positionTransform.enabled = activeStep === '3a' && interfaceLayerVisibility.target;
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
    if (control.dataset.highlightPlaneGroup === 'triad') {
        return ['triadX', 'triadY', 'triadZ'].map(key => planeLayerTargets[key]);
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

function updateModelPickerUI() {
    const breed = modelCatalog[modelPickerState.breed];
    document.getElementById('animal-model').value = modelPickerState.breed;
    const attachment = attachmentCatalogEntry();
    document.querySelectorAll('[data-model-breed]').forEach(button => {
        button.classList.toggle('active', button.dataset.modelBreed === modelPickerState.breed);
    });
    document.querySelectorAll('[data-attachment-category]').forEach(button => {
        button.classList.toggle('active', button.dataset.attachmentCategory === modelPickerState.category);
    });
    document.querySelectorAll('[data-attachment-variation]').forEach(button => {
        button.classList.toggle('active', +button.dataset.attachmentVariation === modelPickerState.variation);
    });
    const solidPath = document.querySelector('[data-path-label="solidAnimal"]');
    const attachmentPath = document.querySelector('[data-path-label="attachment"]');
    solidPath.textContent = catalogFileName(breed.solid.file);
    solidPath.closest('button').title = breed.solid.file;
    attachmentPath.textContent = catalogFileName(attachment.file);
    attachmentPath.closest('button').title = attachment.file;
    document.querySelector('[data-solid-model-name]').textContent = breed.solid.label;
    document.querySelector('[data-attachment-model-name]').textContent = attachment.label;
    document.querySelector('[data-import-unit="solidAnimal"]').value = layers.solidAnimal.importUnit;
    document.querySelector('[data-import-unit="attachment"]').value = layers.attachment.importUnit;
}

async function refreshCatalogModels({ solid = false, attachment = false } = {}) {
    const breed = modelCatalog[modelPickerState.breed];
    const jobs = [];
    if (solid) jobs.push(replaceImportLayer('solidAnimal', breed.solid));
    if (attachment) jobs.push(replaceImportLayer('attachment', attachmentCatalogEntry()));
    if (!jobs.length) return;
    loaderEl.hidden = false;
    loaderEl.classList.remove('error');
    loaderEl.querySelector('p').textContent = 'Loading model preview…';
    try {
        await Promise.all(jobs);
        importBounds = new THREE.Box3().setFromObject(importRoot);
        rebuildPelvicScene();
        buildInterfaceScene();
        updateModelPickerUI();
        showStep(activeStep);
        loaderEl.hidden = true;
        requestAnimationFrame(() => frameObject(importRoot));
    } catch (error) {
        loaderEl.classList.add('error');
        loaderEl.querySelector('p').textContent = 'This model preview could not be loaded.';
        console.error(error);
    }
}

document.querySelectorAll('[data-model-picker]').forEach(trigger => {
    trigger.addEventListener('click', () => {
        const kind = trigger.dataset.modelPicker;
        const panel = document.querySelector('[data-picker-panel="' + kind + '"]');
        const shouldOpen = panel.hidden;
        document.querySelectorAll('[data-picker-panel]').forEach(other => { other.hidden = true; });
        document.querySelectorAll('[data-model-picker]').forEach(other => other.setAttribute('aria-expanded', 'false'));
        panel.hidden = !shouldOpen;
        trigger.setAttribute('aria-expanded', String(shouldOpen));
    });
});

document.getElementById('animal-model').addEventListener('change', event => {
    modelPickerState.breed = event.currentTarget.value;
    updateModelPickerUI();
    refreshCatalogModels({ solid: true, attachment: true });
});

document.querySelectorAll('[data-model-breed]').forEach(button => {
    button.addEventListener('click', () => {
        if (modelPickerState.breed === button.dataset.modelBreed) return;
        modelPickerState.breed = button.dataset.modelBreed;
        updateModelPickerUI();
        refreshCatalogModels({ solid: true, attachment: true });
    });
});

document.querySelectorAll('[data-attachment-category]').forEach(button => {
    button.addEventListener('click', () => {
        if (modelPickerState.category === button.dataset.attachmentCategory) return;
        modelPickerState.category = button.dataset.attachmentCategory;
        updateModelPickerUI();
        refreshCatalogModels({ attachment: true });
    });
});

document.querySelectorAll('[data-attachment-variation]').forEach(button => {
    button.addEventListener('click', () => {
        const variation = +button.dataset.attachmentVariation;
        if (modelPickerState.variation === variation) return;
        modelPickerState.variation = variation;
        updateModelPickerUI();
        refreshCatalogModels({ attachment: true });
    });
});


const interfaceCatalog = {
    large: {
        mechanical: { file: 'billie-mechanical-interface.glb', type: 'glb' },
        solidInterface: { file: 'billie-solid-interface.stl', type: 'stl' },
    },
    small: {
        mechanical: { file: 'sample-models/interfaces/small-mechanical.stl', type: 'stl' },
        solidInterface: { file: 'sample-models/interfaces/small-solid.stl', type: 'stl' },
    },
};
let selectedInterfaceSize = 'large';
document.getElementById('interface-size').addEventListener('change', async event => {
    const select = event.currentTarget;
    const nextSize = select.value;
    const status = document.getElementById('interface-size-status');
    select.disabled = true;
    status.hidden = false;
    status.textContent = 'Loading interface...';
    try {
        // Stage both files before replacing either half of the matched pair.
        const staged = await Promise.all(Object.entries(interfaceCatalog[nextSize]).map(async ([key, model]) => {
            const layer = { ...layers[key], ...model, group: new THREE.Group() };
            await loadImportLayer(layer);
            return [key, layer];
        }));
        for (const [key, stagedLayer] of staged) {
            const layer = layers[key];
            layer.group.clear();
            while (stagedLayer.group.children.length) layer.group.add(stagedLayer.group.children[0]);
            layer.file = stagedLayer.file;
            layer.type = stagedLayer.type;
            layer.baseUnit = layer.importUnit = 'mm';
            applyImportUnitScale(layer);
            document.querySelector('[data-import-unit="' + key + '"]').value = 'mm';
            const output = document.querySelector('[data-interface-path="' + key + '"]');
            output.textContent = catalogFileName(layer.file);
            output.title = layer.file;
        }
        syncImportVisibility('mechanical', true);
        syncImportVisibility('solidInterface', true);
        selectedInterfaceSize = nextSize;
        buildInterfaceScene();
        clearMeasurement();
        importBounds = new THREE.Box3().setFromObject(importRoot);
        showStep(activeStep);
        status.hidden = true;
    } catch (error) {
        select.value = selectedInterfaceSize;
        status.textContent = 'Could not load the interface. Please try again.';
        console.error(error);
    } finally {
        select.disabled = false;
    }
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
        if (activeStep.startsWith('2')) requestAnimationFrame(() => frameObject(planeRoot));
    });
});

updateModelPickerUI();

function showStep(step, shouldScroll = false) {
    clearViewerHighlight();
    clearMeasurement();
    activeStep = String(step);
    const isImport = activeStep === '1';
    const isPelvic = activeStep.startsWith('2');
    const isInterface = activeStep.startsWith('3');
    const isAttachment = activeStep === '4';
    const titles = {
        '1': 'Imported mesh assembly',
        '2a': 'Pelvic plane location',
        '2b': 'Socket lattice parameters',
        '3b': 'Interface plane location',
        '3a': 'Interface target position',
        '3c': 'Oriented mechanical interface',
        '4': 'Attachment Holes',
    };
    importRoot.visible = isImport;
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
    if (isPelvic) {
        applyPelvicStageVisibility();
        if (activeStep === '2a') {
            loadPelvicPlaneTestModel(activePelvicPlanePreset);
        } else {
            loadSocketParameterModel(activeSocketParameter, socketParameterState[activeSocketParameter]);
        }
    } else if (isInterface) {
        loadSocketParameterModel(activeSocketParameter, socketParameterState[activeSocketParameter]);
        if (targetHandle) positionTransform.attach(targetHandle);
        applyInterfaceStageVisibility();
        syncInterfaceLayerMenus();
    } else if (!isAttachment) {
        positionTransform.enabled = false;
        positionTransformHelper.visible = false;
    }
    viewerStepEl.textContent = 'Step ' + activeStep;
    viewerTitleEl.textContent = titles[activeStep];
    document.querySelectorAll('.workflow-step').forEach(section => section.classList.toggle('active', section.dataset.step === activeStep));
    const major = activeStep.charAt(0);
    document.querySelectorAll('.workflow-progress-step').forEach(button => button.classList.toggle('active', button.dataset.goStep.charAt(0) === major));
    renderLegend();
    const viewRoot = isAttachment ? attachmentHoles.root : isImport ? importRoot : isPelvic ? planeRoot : activeStep === '3b' ? interfaceReferenceMechanical : interfaceRoot;
    requestAnimationFrame(() => frameObject(viewRoot));
    if (shouldScroll) {
        const section = document.getElementById('workflow-step-' + activeStep);
        const scroll = document.getElementById('workflow-scroll');
        const top = section.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop;
        scroll.scrollTo({ top, behavior: 'smooth' });
    }
}

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
        const next = !keys.some(key => interfaceLayerVisibility[key]);
        syncInterfaceGroupVisibility(group, next);
        return;
    }
    const interfaceLayerButton = event.target.closest('button[data-interface-layer]');
    if (interfaceLayerButton) {
        const key = interfaceLayerButton.dataset.interfaceLayer;
        syncInterfaceVisibility(key, !(activeStep === '3a' && key === 'mechanical' ? positionMechanicalVisible : interfaceLayerVisibility[key]));
        return;
    }
    const stepButton = event.target.closest('[data-go-step]');
    if (stepButton) showStep(stepButton.dataset.goStep, true);
});

document.querySelectorAll('.workflow-node').forEach(node => {
    node.addEventListener('toggle', () => {
        if (!node.open) {
            node.querySelectorAll('[data-picker-panel]').forEach(panel => { panel.hidden = true; });
            node.querySelectorAll('[data-model-picker]').forEach(trigger => trigger.setAttribute('aria-expanded', 'false'));
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

const interfacePlaneBlock = document.querySelector('#workflow-step-3b .workflow-plane-block');
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

function resetSocketParametersForSweep(activeKey) {
    const values = { ...socketParameterDefaults };
    if (activeKey === 'pelvicDistance') values.pelvicThickness = 10;
    Object.entries(values).forEach(([key, value]) => {
        if (key !== activeKey) setSocketParameterControl(key, value);
    });
}

document.querySelectorAll('[data-socket-param]').forEach(input => {
    const updateParameter = () => {
        const key = input.dataset.socketParam;
        const index = +input.value;
        const value = parameterValues[key][index];
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
    if (!event.target.closest('.workflow-path-field')) {
        document.querySelectorAll('[data-picker-panel]').forEach(panel => { panel.hidden = true; });
        document.querySelectorAll('[data-model-picker]').forEach(trigger => trigger.setAttribute('aria-expanded', 'false'));
    }
});

document.getElementById('pelvic-plane-visibility').addEventListener('click', () => {
    const guideKeys = ['point', 'normal', 'plane'];
    const next = !guideKeys.some(key => planeLayerVisibility[key]);
    guideKeys.forEach(key => syncPlaneVisibility(key, next));
});
document.getElementById('interface-plane-visibility').addEventListener('click', () => {
    const guideKeys = ['point', 'normal', 'plane'];
    const next = !guideKeys.some(key => interfaceLayerVisibility[key]);
    guideKeys.forEach(key => syncInterfaceVisibility(key, next));
});
document.getElementById('interface-position-visibility').addEventListener('click', () => {
    syncInterfaceVisibility('target', !interfaceLayerVisibility.target);
});

document.getElementById('toggle-grid').addEventListener('click', event => {
    grid.visible = !grid.visible;
    event.currentTarget.classList.toggle('active', grid.visible);
    event.currentTarget.setAttribute('aria-label', grid.visible ? 'Hide grid' : 'Show grid');
});
document.getElementById('reset-view').addEventListener('click', () => {
    frameObject(activeStep === '4' ? attachmentHoles.root : activeStep === '1' ? importRoot : activeStep.startsWith('2') ? planeRoot : activeStep === '3b' ? interfaceReferenceMechanical : interfaceRoot);
});

const attachmentHoles = createAttachmentHoles({ scene, camera, canvas,
    transform: positionTransform, transformHelper: positionTransformHelper,
    loadGLB, collectSurfaceTriangles, closestSurfacePoint, keepOverlayVisible,
    isMeasuring: () => measureMode,
});

const stepObserver = new IntersectionObserver(entries => {
    const visible = entries.filter(entry => entry.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
    if (visible) showStep(visible.target.dataset.step);
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
    document.getElementById('interface-size').disabled = false;
    document.getElementById('animal-model').disabled = false;
}).catch(error => {
    loaderEl.classList.add('error');
    loaderEl.querySelector('p').textContent = 'A model could not be loaded. Refresh the page to try again.';
    console.error(error);
});

renderLegend();
window.lucide?.createIcons({ attrs: { 'stroke-width': 1.8 } });

// Typed values use the same update path as their paired slider.
for (const [outputAttr, sliderAttr] of [['param-output', 'socket-param'], ['orient-output', 'orient'], ['adjust-output', 'adjust']]) {
    document.querySelectorAll(`[data-${outputAttr}]`).forEach(field => {
        const key = field.getAttribute(`data-${outputAttr}`);
        const slider = document.querySelector(`[data-${sliderAttr}="${key}"]`);
        field.setAttribute('aria-label', slider.getAttribute('aria-label') + ' value');
        const commit = () => {
            const value = Number(field.value);
            if (field.value === '' || !Number.isFinite(value)) { slider.dispatchEvent(new Event('input')); return; }
            if (outputAttr === 'param-output') {
                const values = parameterValues[key];
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
