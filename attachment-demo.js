// The screw attachment explained in the walkthrough's own viewer (Step 4b): a copy of the part on its
// own, centred at the origin and stood head-up the way screw-attachment.html shows it, cut in half,
// with the screw drawn to fit the hole and a dimension label for each of the block's inputs.
//
// The copy is built from the attachment the block has loaded (attachment-holes.js keeps it as a
// template), so it is always the exported part for the values on the sliders. In the export's own
// frame the head recess runs from z = 0 (the end that sits on the socket) to Head Height, and the grip
// from there to Head Height + Grip Length. Here it is turned over so the screw goes in from the top:
// the grip runs from z = 0 to G, the head recess from G to G + HH, as on screw-attachment.html. The
// whole copy is then shifted down by half its height so its middle is at the origin.
import * as THREE from 'three';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

const COLOURS = { attachDiameter: '#2f6fb3', shankDiameter: '#d2603c', gripLength: '#2e8b6a', headDiameter: '#8e44ad', headHeight: '#b07a00' };
const SHORT = { attachDiameter: 'Attachment Ø', shankDiameter: 'Shank Ø', gripLength: 'Grip', headDiameter: 'Head Ø', headHeight: 'Head height' };
const TAIL = 5;   // how far the shaft reaches on past the part, into the prosthetic it is screwed to
const fmt = value => String(Math.round(value * 100) / 100);
// Looking at the cut face from the front, a little from above (the explainer's own view).
const VIEW = new THREE.Vector3(0.42, -1.6, 0.62).normalize();

export function createAttachmentDemo({ renderer, scene, camera, labelsEl }) {
    renderer.localClippingEnabled = true;
    const labelRenderer = new CSS2DRenderer({ element: labelsEl });
    const options = { cut: true, screw: true, dims: true };
    // The cut keeps y >= 0, so the camera on the -y side looks straight at the cut face.
    const cutPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const clip = () => (options.cut ? [cutPlane] : []);
    const partMaterial = new THREE.MeshStandardMaterial({ color: 0x2baca4, roughness: 0.7, metalness: 0, clippingPlanes: [cutPlane] });
    const cutMaterial = new THREE.MeshStandardMaterial({ color: 0x3f6f8c, roughness: 0.9, metalness: 0, side: THREE.BackSide, clippingPlanes: [cutPlane] });
    const screwMaterial = new THREE.MeshStandardMaterial({ color: 0xe3a43a, roughness: 0.5, metalness: 0.1, transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide, clippingPlanes: [cutPlane] });

    // root: metres, at the origin. Everything inside is in millimetres.
    const root = new THREE.Group();
    root.name = 'attachment-demo';
    root.scale.setScalar(0.001);
    root.visible = false;
    scene.add(root);
    const part = new THREE.Group();     // the exported part, turned head-up
    const screw = new THREE.Group();
    const dims = new THREE.Group();
    root.add(part, screw, dims);

    let design = null;
    let active = null;   // the input being moved: drawn in full while the others fade

    function disposeChildren(group) {
        group.traverse(child => {
            if (child.isCSS2DObject) child.element.remove();
            if (child !== group && child.geometry && !child.userData.sharedGeometry) child.geometry.dispose();
            if (child !== group && child.material && child.userData.ownMaterial) child.material.dispose();
        });
        group.clear();
    }

    // The part: the template's meshes, in millimetres, turned over about X and lifted by its height.
    function buildPart(template, p) {
        disposeChildren(part);
        if (!template) return;
        template.updateMatrixWorld(true);
        // Undoing the template's own transform (its 0.001 scale) leaves the mesh in the export's millimetres.
        const toTemplate = new THREE.Matrix4().copy(template.matrixWorld).invert();
        const H = p.gripLength + p.headHeight;
        const turn = new THREE.Matrix4().makeTranslation(0, 0, H).multiply(new THREE.Matrix4().makeRotationX(Math.PI));
        template.traverse(mesh => {
            if (!mesh.isMesh) return;
            // the mesh in the template's own frame, in millimetres, then turned head-up
            const matrix = turn.clone().multiply(toTemplate).multiply(mesh.matrixWorld);
            [partMaterial, cutMaterial].forEach(material => {
                const copy = new THREE.Mesh(mesh.geometry, material);
                copy.userData.sharedGeometry = true;
                copy.userData.measureSurface = true;
                copy.matrixAutoUpdate = false;
                copy.matrix.copy(matrix);
                part.add(copy);
            });
        });
        part.children.forEach(child => { if (child.material === cutMaterial) child.visible = options.cut; });
    }

    function cylinder(radius, z0, z1) {
        const geometry = new THREE.CylinderGeometry(radius, radius, Math.max(z1 - z0, 0.01), 48, 1, false);
        geometry.rotateX(Math.PI / 2);
        geometry.translate(0, 0, (z0 + z1) / 2);
        const mesh = new THREE.Mesh(geometry, screwMaterial);
        mesh.userData.measureSurface = false;
        return mesh;
    }

    // The screw, drawn to fit the hole: shaft through the grip and on below, head in the recess.
    function buildScrew(p) {
        disposeChildren(screw);
        const shaftR = Math.max(p.shankDiameter / 2 - 0.04, 0.2);
        const headR = Math.max(p.headDiameter / 2 - 0.04, 0.2);
        const headTop = p.headHeight > 0 ? p.gripLength + p.headHeight - 0.02 : p.gripLength + 1.6;   // no recess: the head sits on top
        screw.add(cylinder(shaftR, -TAIL, p.gripLength - 0.04));
        screw.add(cylinder(headR, p.gripLength + 0.04, headTop));
        screw.visible = options.screw;
    }

    function line(points, colour, muted) {
        const geometry = new THREE.BufferGeometry().setFromPoints(points.map(([x, z]) => new THREE.Vector3(x, -0.01, z)));
        const material = new THREE.LineBasicMaterial({ color: muted ? 0xa7b1bc : colour, depthTest: false, transparent: true, opacity: muted ? 0.8 : 1 });
        const segments = new THREE.LineSegments(geometry, material);
        segments.userData.ownMaterial = true;
        segments.renderOrder = 10;
        return segments;
    }

    function label(text, x, z, key, muted, cls) {
        const div = document.createElement('div');
        div.className = 'dim-label' + (muted ? ' muted' : '') + (cls ? ' ' + cls : '');
        div.style.color = COLOURS[key];
        div.textContent = text;
        const object = new CSS2DObject(div);
        object.position.set(x, -0.01, z);
        return object;
    }

    // Dimension lines in the cut plane, as on screw-attachment.html.
    function buildDims(p) {
        disposeChildren(dims);
        dims.visible = options.dims;
        if (!options.dims) return;
        const H = p.gripLength + p.headHeight, rA = p.attachDiameter / 2, t = 0.35;
        const xs = Math.max(rA, p.headDiameter / 2) + 1.4;   // vertical dimensions sit just outside the pad
        const muted = key => !!active && active !== key;
        const add = (key, segments, lab) => { dims.add(line(segments.flat(), new THREE.Color(COLOURS[key]), muted(key))); dims.add(lab); };
        const horizontal = (key, half, z, text, cls) => add(key,
            [[[-half, z], [half, z]], [[-half, z - t], [-half, z + t]], [[half, z - t], [half, z + t]]],
            label(text, 0, z, key, muted(key), cls));
        const vertical = (key, z0, z1, text) => add(key,
            [[[xs, z0], [xs, z1]], [[xs - t, z0], [xs + t, z0]], [[xs - t, z1], [xs + t, z1]]],
            label(text, xs, (z0 + z1) / 2, key, muted(key), 'side'));
        // Attachment diameter above the pad, with extension lines down to its top edge.
        const zA = H + 1.3;
        add('attachDiameter', [[[-rA, zA], [rA, zA]], [[-rA, H + 0.2], [-rA, zA + t]], [[rA, H + 0.2], [rA, zA + t]]],
            label(`${SHORT.attachDiameter} ${fmt(p.attachDiameter)} mm`, 0, zA, 'attachDiameter', muted('attachDiameter'), 'below'));
        if (p.headHeight > 0) horizontal('headDiameter', p.headDiameter / 2, p.gripLength + p.headHeight / 2, `${SHORT.headDiameter} ${fmt(p.headDiameter)} mm`);
        else dims.add(label(`${SHORT.headDiameter} ${fmt(p.headDiameter)} mm (no recess)`, 0, H + 3.6, 'headDiameter', muted('headDiameter')));
        if (p.gripLength > 0) horizontal('shankDiameter', p.shankDiameter / 2, p.gripLength / 2, `${SHORT.shankDiameter} ${fmt(p.shankDiameter)} mm`);
        else dims.add(label(`${SHORT.shankDiameter} ${fmt(p.shankDiameter)} mm`, 0, -1.2, 'shankDiameter', muted('shankDiameter')));
        if (p.gripLength > 0) vertical('gripLength', 0, p.gripLength, `${SHORT.gripLength} ${fmt(p.gripLength)} mm`);
        if (p.headHeight > 0) vertical('headHeight', p.gripLength, H, `${SHORT.headHeight} ${fmt(p.headHeight)} mm`);
    }

    function applyClipping() {
        [partMaterial, cutMaterial, screwMaterial].forEach(material => { material.clippingPlanes = clip(); material.needsUpdate = true; });
        part.children.forEach(child => { if (child.material === cutMaterial) child.visible = options.cut; });
    }

    return {
        // Build the copy for `template` (the loaded attachment) at `nextDesign` (the five values, mm) and show it.
        show(template, nextDesign) {
            design = { ...nextDesign };
            buildPart(template, design);
            buildScrew(design);
            buildDims(design);
            root.position.set(0, 0, -(design.gripLength + design.headHeight) / 2 * 0.001);   // its middle at the origin
            root.visible = true;
        },
        hide() {
            root.visible = false;
            disposeChildren(dims);   // the labels are DOM nodes, so they go rather than hide
            labelsEl.replaceChildren();
        },
        get on() { return root.visible; },
        get hasPart() { return part.children.length > 0; },
        root,
        setActive(key) { active = key || null; if (root.visible && design) buildDims(design); },
        setOptions(next) {
            Object.assign(options, next);
            applyClipping();
            screw.visible = options.screw;
            if (design) buildDims(design);
            if (!options.dims) labelsEl.replaceChildren();
        },
        get options() { return { ...options }; },
        viewDirection: () => VIEW.clone(),
        resize(width, height) { labelRenderer.setSize(width, height); },
        tick() { if (root.visible) labelRenderer.render(scene, camera); },
        clearLabels() { labelsEl.replaceChildren(); },
    };
}
