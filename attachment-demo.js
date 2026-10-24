// The screw attachment explained in the walkthrough's own viewer, on the part Step 4b shows by itself:
// cut in half, the screw drawn to fit the hole, and a dimension label for each of the block's inputs.
// It is the same picture as screw-attachment.html, drawn on the part where it sits on the socket.
//
// The part's own frame (the nTop export, in millimetres inside a group scaled to metres): the head
// recess runs from z = 0 at the socket surface to z = Head Height, the grip from there out to
// Head Height + Grip Length. The cut keeps the part's local y >= 0, so the camera looks at the cut
// face from the local -y side.
import * as THREE from 'three';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

const COLOURS = { attachDiameter: '#2f6fb3', shankDiameter: '#d2603c', gripLength: '#2e8b6a', headDiameter: '#8e44ad', headHeight: '#b07a00' };
const SHORT = { attachDiameter: 'Attachment Ø', shankDiameter: 'Shank Ø', gripLength: 'Grip', headDiameter: 'Head Ø', headHeight: 'Head height' };
const TAIL = 5;   // how far the shaft reaches on past the part, into the prosthetic it is screwed to
const fmt = value => String(Math.round(value * 100) / 100);

export function createAttachmentDemo({ renderer, scene, camera, labelsEl }) {
    renderer.localClippingEnabled = true;
    const labelRenderer = new CSS2DRenderer({ element: labelsEl });
    const options = { cut: true, screw: true, dims: true };
    const cutPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const cutMaterial = new THREE.MeshStandardMaterial({ color: 0x3f6f8c, roughness: 0.9, metalness: 0, side: THREE.BackSide, clippingPlanes: [cutPlane] });
    const screwMaterial = new THREE.MeshStandardMaterial({ color: 0xe3a43a, roughness: 0.5, metalness: 0.1, transparent: true, opacity: 0.55, depthWrite: false, clippingPlanes: [cutPlane], side: THREE.DoubleSide });
    const extras = new THREE.Group();   // the cut face, the screw and the dimensions, in the part's frame
    extras.name = 'attachment-demo';
    let host = null;          // the 'attachment' group the extras live in (mm units)
    let partMeshes = [];      // the exported part's meshes, clipped while the demo is on
    let design = null;
    let active = null;        // the input being moved, drawn in full while the others fade

    function dispose(object) {
        object.traverse(child => {
            if (child.isCSS2DObject) child.element.remove();
            if (child.geometry && child !== object) child.geometry.dispose();
        });
    }

    function cylinder(radius, z0, z1) {
        const geometry = new THREE.CylinderGeometry(radius, radius, Math.max(z1 - z0, 0.01), 48, 1, false);
        geometry.rotateX(Math.PI / 2);
        geometry.translate(0, 0, (z0 + z1) / 2);
        const mesh = new THREE.Mesh(geometry, screwMaterial);
        mesh.userData.measureSurface = false;
        return mesh;
    }

    function line(points, colour, muted) {
        const geometry = new THREE.BufferGeometry().setFromPoints(points.map(([x, z]) => new THREE.Vector3(x, -0.01, z)));
        const material = new THREE.LineBasicMaterial({ color: muted ? 0xa7b1bc : colour, depthTest: false, transparent: true, opacity: muted ? 0.8 : 1 });
        const segments = new THREE.LineSegments(geometry, material);
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

    function build() {
        dispose(extras);
        extras.clear();
        if (!host || !design) return;
        const p = design;
        const H = p.headHeight + p.gripLength;
        // the cut face: the same geometry drawn back-face only in a flat colour, so the cut reads as solid
        partMeshes.forEach(mesh => {
            const face = new THREE.Mesh(mesh.geometry, cutMaterial);
            face.userData.measureSurface = false;
            face.visible = options.cut;
            mesh.getWorldPosition(new THREE.Vector3());
            face.matrixAutoUpdate = false;
            face.matrix.copy(hostLocalMatrix(mesh));
            extras.add(face);
        });
        // the screw: head in the recess at the surface, shaft on through the grip and out the far side
        const screw = new THREE.Group();
        screw.visible = options.screw;
        const shaftR = Math.max(p.shankDiameter / 2 - 0.04, 0.2);
        const headR = Math.max(p.headDiameter / 2 - 0.04, 0.2);
        if (p.headHeight > 0) screw.add(cylinder(headR, 0.02, p.headHeight - 0.04));
        else screw.add(cylinder(headR, -1.6, -0.02));   // no recess: the head sits against the surface
        screw.add(cylinder(shaftR, p.headHeight + 0.04, H + TAIL));
        extras.add(screw);
        // the dimensions, in the cut plane
        const dims = new THREE.Group();
        dims.visible = options.dims;
        const rA = p.attachDiameter / 2, t = 0.35;
        const xs = Math.max(rA, p.headDiameter / 2) + 1.4;
        const muted = key => active && active !== key;
        const add = (key, segments, lab) => { dims.add(line(segments.flat(), new THREE.Color(COLOURS[key]), muted(key))); dims.add(lab); };
        const horizontal = (key, half, z, text, cls) => add(key,
            [[[-half, z], [half, z]], [[-half, z - t], [-half, z + t]], [[half, z - t], [half, z + t]]],
            label(text, 0, z, key, muted(key), cls));
        const vertical = (key, z0, z1, text) => add(key,
            [[[xs, z0], [xs, z1]], [[xs - t, z0], [xs + t, z0]], [[xs - t, z1], [xs + t, z1]]],
            label(text, xs, (z0 + z1) / 2, key, muted(key), 'side'));
        const zA = H + 1.3;   // the pad's width, just past its outer face
        add('attachDiameter', [[[-rA, zA], [rA, zA]], [[-rA, H + 0.2], [-rA, zA + t]], [[rA, H + 0.2], [rA, zA + t]]],
            label(`${SHORT.attachDiameter} ${fmt(p.attachDiameter)} mm`, 0, zA, 'attachDiameter', muted('attachDiameter'), 'below'));
        if (p.headHeight > 0) horizontal('headDiameter', p.headDiameter / 2, p.headHeight / 2, `${SHORT.headDiameter} ${fmt(p.headDiameter)} mm`);
        else dims.add(label(`${SHORT.headDiameter} ${fmt(p.headDiameter)} mm (no recess)`, 0, -1.2, 'headDiameter', muted('headDiameter')));
        if (p.gripLength > 0) horizontal('shankDiameter', p.shankDiameter / 2, p.headHeight + p.gripLength / 2, `${SHORT.shankDiameter} ${fmt(p.shankDiameter)} mm`);
        else dims.add(label(`${SHORT.shankDiameter} ${fmt(p.shankDiameter)} mm`, 0, H + 3.6, 'shankDiameter', muted('shankDiameter')));
        if (p.headHeight > 0) vertical('headHeight', 0, p.headHeight, `${SHORT.headHeight} ${fmt(p.headHeight)} mm`);
        if (p.gripLength > 0) vertical('gripLength', p.headHeight, H, `${SHORT.gripLength} ${fmt(p.gripLength)} mm`);
        extras.add(dims);
    }

    // A mesh's matrix relative to the host group, so the cut face sits exactly on the part.
    function hostLocalMatrix(mesh) {
        host.updateWorldMatrix(true, false);
        mesh.updateWorldMatrix(true, false);
        return new THREE.Matrix4().copy(host.matrixWorld).invert().multiply(mesh.matrixWorld);
    }

    function applyClipping(on) {
        partMeshes.forEach(mesh => {
            mesh.material.clippingPlanes = on ? [cutPlane] : [];
            mesh.material.side = on ? THREE.FrontSide : THREE.DoubleSide;
            mesh.material.needsUpdate = true;
        });
    }

    // The cut plane in world space: the host's local y = 0, facing +y.
    function updateCutPlane() {
        if (!host) return;
        host.updateWorldMatrix(true, false);
        cutPlane.set(new THREE.Vector3(0, 1, 0), 0).applyMatrix4(host.matrixWorld);
    }

    return {
        // Draw the demo on `assembly` (a point's assembly group) for `nextDesign` (the block's five values, mm).
        show(assembly, nextDesign) {
            this.hide();
            host = assembly?.getObjectByName('attachment') || null;
            if (!host) return;
            design = { ...nextDesign };
            partMeshes = [];
            host.traverse(object => { if (object.isMesh && object !== extras && !extras.getObjectById(object.id)) partMeshes.push(object); });
            applyClipping(options.cut);
            updateCutPlane();
            host.add(extras);
            build();
        },
        hide() {
            if (!host) return;
            applyClipping(false);
            host.remove(extras);
            dispose(extras);
            extras.clear();
            host = null;
            partMeshes = [];
        },
        get on() { return !!host; },
        setDesign(nextDesign) { if (host) { design = { ...nextDesign }; build(); } },
        setActive(key) { active = key || null; if (host) build(); },
        setOptions(next) {
            Object.assign(options, next);
            applyClipping(host ? options.cut : false);
            [cutMaterial, screwMaterial].forEach(material => { material.clippingPlanes = options.cut ? [cutPlane] : []; material.needsUpdate = true; });
            extras.children.forEach(child => {
                if (child.isGroup) child.visible = child.children[0]?.isCSS2DObject || child.children[0]?.isLineSegments ? options.dims : options.screw;
                else child.visible = options.cut;
            });
        },
        get options() { return { ...options }; },
        // Where to look from, in world space: the part's local (0.42, -1.6, 0.62), onto the cut face.
        viewDirection() {
            const direction = new THREE.Vector3(0.42, -1.6, 0.62);
            if (host) { host.updateWorldMatrix(true, false); direction.transformDirection(host.matrixWorld); }
            return direction.normalize();
        },
        resize(width, height) { labelRenderer.setSize(width, height); },
        tick() {
            if (!host) return;
            updateCutPlane();
            labelRenderer.render(scene, camera);
        },
        clearLabels() { labelsEl.replaceChildren(); },
    };
}
