// Mobile sidebar toggle
const mobileToggle = document.getElementById('mobile-toggle');
const sidebar = document.querySelector('.sidebar');

if (mobileToggle) {
    mobileToggle.addEventListener('click', () => {
        sidebar.classList.toggle('active');
        mobileToggle.classList.toggle('active');
    });
}

// Close sidebar when clicking outside it
document.addEventListener('click', (e) => {
    if (!e.target.closest('.sidebar') && !e.target.closest('.mobile-toggle')) {
        sidebar.classList.remove('active');
        mobileToggle.classList.remove('active');
    }
});

// Close sidebar when clicking a navigation link
const sidebarLinks = document.querySelectorAll('.sidebar a');
sidebarLinks.forEach(link => {
    link.addEventListener('click', () => {
        sidebar.classList.remove('active');
        mobileToggle.classList.remove('active');
    });
});

// Highlight current page in sidebar
const currentPath = window.location.pathname.split('/').pop() || 'index.html';
document.querySelectorAll('.sidebar a').forEach(link => {
    const linkPath = link.getAttribute('href');
    if (linkPath === currentPath) {
        link.parentElement.classList.add('active');
    }
});

// Smooth scroll for anchor links
document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function (e) {
        const href = this.getAttribute('href');
        if (href !== '#') {
            e.preventDefault();
            const target = document.querySelector(href);
            if (target) {
                target.scrollIntoView({
                    behavior: 'smooth',
                    block: 'start'
                });
            }
        }
    });
});

// Media carousel
document.querySelectorAll('.carousel').forEach(carousel => {
    const track = carousel.querySelector('.carousel-track');
    const slides = [...carousel.querySelectorAll('.carousel-slide')];
    const dotsWrap = carousel.querySelector('.carousel-dots');
    const prev = carousel.querySelector('.carousel-prev');
    const next = carousel.querySelector('.carousel-next');
    if (!track || slides.length === 0) return;

    let current = 0;

    slides.forEach((_, i) => {
        const dot = document.createElement('button');
        dot.className = 'carousel-dot';
        dot.type = 'button';
        dot.setAttribute('aria-label', 'Go to slide ' + (i + 1));
        dot.addEventListener('click', () => goTo(i));
        dotsWrap.appendChild(dot);
    });
    const dots = [...dotsWrap.children];

    function goTo(i) {
        current = (i + slides.length) % slides.length;
        track.style.transform = 'translateX(-' + (current * 100) + '%)';
        dots.forEach((d, di) => d.classList.toggle('active', di === current));

        // Pause every video; play the one on the active slide only
        carousel.querySelectorAll('video').forEach(v => v.pause());
        const activeVideo = slides[current].querySelector('video');
        if (activeVideo) {
            activeVideo.play().catch(() => {});
        }
    }

    if (prev) prev.addEventListener('click', () => goTo(current - 1));
    if (next) next.addEventListener('click', () => goTo(current + 1));
    goTo(0);
});

// 3D model variant toggle.
// Component GLBs are exported per animal over the course of a build, so a
// case study routinely lists components whose mesh has not been converted
// yet. Rather than render a dead viewer, each button's file is HEAD-checked
// once on load: unavailable components are removed from the tab strip, the
// viewer opens on the first component that does exist, and a figure with
// nothing available collapses to a short note. New GLBs therefore light up
// their tabs the moment they are committed, with no HTML edit.
document.querySelectorAll('.model-toggle').forEach(toggle => {
    const figure = toggle.closest('.model-viewer-figure');
    const viewer = figure && figure.querySelector('model-viewer');
    if (!viewer) return;
    const buttons = [...toggle.querySelectorAll('.model-toggle-btn')];

    buttons.forEach(btn => {
        btn.addEventListener('click', () => {
            const src = btn.getAttribute('data-model');
            if (!src || src === viewer.getAttribute('src')) return;
            viewer.setAttribute('src', src);
            buttons.forEach(b => b.classList.toggle('active', b === btn));
        });
    });

    const exists = url => fetch(url, { method: 'HEAD' })
        .then(r => r.ok).catch(() => false);

    Promise.all(buttons.map(btn => exists(btn.getAttribute('data-model'))))
        .then(results => {
            const available = buttons.filter((btn, i) => results[i]);
            buttons.forEach((btn, i) => {
                if (!results[i]) btn.remove();
            });
            if (!available.length) {
                // Nothing to show: drop the viewer rather than leave an
                // empty canvas, and say plainly what is missing.
                const note = document.createElement('p');
                note.className = 'model-pending-note';
                note.textContent = 'Interactive models for this build are ' +
                    'still being prepared and will appear here once they ' +
                    'are exported.';
                figure.replaceChildren(note);
                return;
            }
            if (available.length === 1) toggle.hidden = true;
            const currentSrc = viewer.getAttribute('src');
            if (!available.some(b => b.getAttribute('data-model') === currentSrc)) {
                const first = available[0];
                viewer.setAttribute('src', first.getAttribute('data-model'));
                available.forEach(b => b.classList.toggle('active', b === first));
            }
        });
});

// Interactive nTop block accordions (socket creation and paw pages): the
// block sits centered and clicking an input row expands a dropdown inside
// the block with that input's description, controls, overlay toggles, and
// a 3D viewer with an orientation gizmo. One row is open at a time. Model
// filenames are generated per value; steps whose GLB has not been uploaded
// yet show a note instead of a model. Each page provides a config; the
// engine (initBlock) is shared.
(() => {
    const referencedUrls = new Set();

    const pad2 = n => String(n).padStart(2, '0');
    const pad3 = n => String(n).padStart(3, '0');

    // ---- Animal selector ----
    // The socket-creation demos are per-animal: the same parameter value
    // produces very different geometry on a Chihuahua vs a German Shepherd,
    // so each animal has its own GLB namespace. Every file fn below calls
    // AP() at build time, so switching animals redirects the whole page to
    // that animal's library. Animals without exported sweeps degrade to the
    // per-step "not uploaded yet" note automatically. When the Golden
    // Hound / German Shepherd sweeps land, their anatomy-anchored sliders
    // (TLP, interface position, blend points, attach drop) will also need
    // per-animal ranges - the current ranges are the Chihuahua's.
    const ANIMALS = {
        chi: { label: 'Small Dog', sub: 'Chihuahua', prefix: 'ntop-chi-', ready: true },
        gh: { label: 'Medium Dog', sub: 'Golden Hound', prefix: 'ntop-gh-', ready: false },
        gs: { label: 'Large Dog', sub: 'German Shepherd', prefix: 'ntop-gs-', ready: false },
    };
    let activeAnimal = 'chi';
    const AP = () => ANIMALS[activeAnimal].prefix;

    // ---- Background model warmer ----
    // One hidden viewer walks a queue of GLB urls, warming model-viewer's
    // parsed-model cache so slider scrubbing is instant. Each opened
    // dropdown queues its full sweep (nearest-to-current values first);
    // starting a new walk cancels the previous one. Missing files (HEAD
    // failure) are skipped and remembered.
    const warmedUrls = new Set();
    let warmToken = 0;
    let warmViewer = null;
    const cancelWarm = () => { warmToken++; };
    const warmModels = async urls => {
        const token = ++warmToken;
        const MV = customElements.get('model-viewer');
        if (!MV) return;
        MV.modelCacheSize = Math.max(MV.modelCacheSize || 0, 600);
        if (!warmViewer) {
            warmViewer = document.createElement('model-viewer');
            warmViewer.setAttribute('loading', 'eager');
            warmViewer.setAttribute('aria-hidden', 'true');
            warmViewer.inert = true; // off-screen, so keep it out of the tab order
            warmViewer.style.cssText = 'position:fixed;left:-9999px;top:0;' +
                'width:2px;height:2px;pointer-events:none;';
            document.body.appendChild(warmViewer);
        }
        for (const url of urls) {
            if (token !== warmToken) return;
            if (warmedUrls.has(url)) continue;
            try {
                const r = await fetch(url, { method: 'HEAD' });
                if (!r.ok) { warmedUrls.add(url); continue; }
            } catch (e) { continue; }
            if (token !== warmToken) return;
            warmViewer.setAttribute('src', url);
            const t0 = Date.now();
            // `load` never fires for offscreen viewers; poll `loaded`.
            await new Promise(r => setTimeout(r, 150));
            while (!warmViewer.loaded && Date.now() - t0 < 20000) {
                if (token !== warmToken) return;
                await new Promise(r => setTimeout(r, 100));
            }
            warmedUrls.add(url);
        }
    };
    // Signed mm values (adjust sliders): n50..n05, 000, p05..p50 keeps
    // filenames fixed-width where a bare minus sign could not.
    const signed2 = v => v < 0 ? 'n' + pad2(-v) : v > 0 ? 'p' + pad2(v) : '000';
    const POINT_COUNTS = [10, 20, 40, 60, 80, 100, 120, 140, 160, 180,
        200, 220, 240, 260, 280, 300, 320, 340, 360, 380, 400];

    // Thickest Lattice Point sweep (Chihuahua): X and Z are fixed at
    // -58.106 / 155.02 mm; the slider moves Y. -113.08 is the design
    // baseline and sits off the 10 mm grid, so it is spliced into the
    // values array.
    const TLP_YS = [-200, -190, -180, -170, -160, -150, -140, -130, -120,
        -113.08, -110, -100, -90, -80, -70, -60, -50, -40, -30, -20, -10, 0];

    const SOCKET_VARS = {
        'thickest-point': {
            title: 'Thickest Lattice Point',
            type: 'slider',
            values: TLP_YS, def: -113.08, unit: 'mm',
            file: v => AP() + 'tlp-y-' + (Number.isInteger(v)
                ? pad3(Math.abs(v)) : String(Math.abs(v))) + '.glb',
            desc: 'Sets the location where the socket wall is at its thickest. X and Z are fixed at -58.106 and 155.02 mm; the slider moves the Y coordinate. Toggle the Lattice Point Sphere to see the point itself.',
        },
        'max-thickness': {
            title: 'Max Socket Thickness',
            type: 'slider',
            min: 0, max: 20, step: 2, def: 8, unit: 'mm',
            file: v => AP() + 'maxthick-' + pad2(v) + '.glb',
            desc: 'Sets the upper limit on the socket wall thickness.',
        },
        'min-thickness': {
            title: 'Min Socket Thickness',
            type: 'slider',
            // This sweep was intentionally run at Max 12 / Bdry 12 (not the
            // 8/6/8 baseline the other sliders share) to make the min-wall
            // effect easier to see.
            min: 0, max: 20, step: 1, def: 8, unit: 'mm',
            file: v => AP() + 'minthick-' + pad2(v) + '.glb',
            desc: 'Sets the lower limit on the socket wall thickness.',
        },
        'pelvic-thickness': {
            title: 'Pelvic Thickness',
            type: 'slider',
            min: 0, max: 30, step: 2, def: 0, unit: 'mm',
            file: v => AP() + 'pelvic-' + pad2(v) + '.glb',
            desc: 'Sets the lattice thickness in the pelvic region of the socket.',
        },
        'pelvic-distance': {
            title: 'Pelvic Thicken Distance',
            type: 'slider',
            values: [1, 5, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100,
                110, 120, 130, 140, 150, 160, 170, 180, 190, 200],
            def: 50, unit: 'mm',
            file: v => AP() + 'pelvicdist-' + String(v).padStart(3, '0') + '.glb',
            desc: 'Sets how far the pelvic thickening extends from the pelvic plane into the socket.',
        },
        'boundary-thickness': {
            title: 'Boundary Lattice Thickness',
            type: 'slider',
            min: 0, max: 20, step: 2, def: 8, unit: 'mm',
            file: v => AP() + 'boundary-' + pad2(v) + '.glb',
            desc: 'Controls how thick the strands are along the outer edge of the lattice. Thicker boundaries give a more rigid rim and a defined silhouette; thinner boundaries blend into the surface lattice and flex more.',
        },
        'point-count': {
            title: 'Lattice Point Count',
            type: 'slider',
            values: POINT_COUNTS, def: 100, unit: '',
            file: v => AP() + 'pointcount-' + String(v).padStart(3, '0') + '.glb',
            desc: 'Controls how densely the lattice is sampled across the surface: a low count yields a sparse, open structure that flexes more freely; a high count yields a finer, denser mesh that is stiffer and distributes load over more contact area.',
        },
    };
    const SOCKET_MESH_VARS = {
        'solid-animal': {
            title: 'Solid Animal',
            desc: 'The cleaned, watertight mesh of the animal\'s residual limb. The lattice socket is grown around this shape. Pick an animal below.',
            options: [
                { label: 'Billie', file: 'billie-solid-animal.glb' },
                { label: 'Max', file: null },
                { label: 'Yana', file: null },
            ],
        },
        'attachment-surface': {
            title: 'Socket Attachment Surface',
            desc: 'The region of the limb the socket grips, exported as a separate surface. It defines where the lattice sits on the limb. Pick an animal below.',
            options: [
                { label: 'Billie', file: 'billie-attachment-surface.glb' },
                { label: 'Max', file: null },
                { label: 'Yana', file: null },
            ],
        },
    };

    // Default camera view per variable key, captured with the ?dev=1 panel.
    // '*' is the fallback for keys without a captured view. Views are in
    // the CENTERED model space (origin = model center, since commit
    // 470e4bf) - captures made before that are invalid. All Chihuahua
    // models share that space, so one captured view works for every demo
    // in the socket, interface, and attachment blocks; capture a per-key
    // view to override an individual row.
    const CHI_VIEW = { orbit: '-90.4deg 90.0deg 418.3m', target: '0.0m 0.0m 0.0m', fov: '30.0deg', orient: '-90.00deg -89.56deg 89.56deg' };
    const DEFAULT_VIEWS = { '*': CHI_VIEW };
    // Default color of the Thickest Lattice Point sphere overlay (hex),
    // set with the ?dev=1 panel.
    const SPHERE_COLOR = '#ff3b30';

    const SOCKET_OVERLAYS = [
        { name: 'overlay-dog', label: 'Full Dog' },
        { name: 'overlay-surface', label: 'Attachment Surface' },
        { name: 'overlay-sphere', label: 'Lattice Point Sphere',
          onlyFor: ['thickest-point', 'min-thickness', 'max-thickness'],
          defaultOn: ['thickest-point'] },
    ];

    // ---- Quaternion helpers ----
    // The 90-degree rotate arrows compose quaternion rotations about the
    // current screen axes and drive model-viewer's `orientation` attribute
    // (the orbit camera itself cannot roll). Quaternions make the steps
    // compose correctly at any orientation with no gimbal trouble; Euler
    // angles only appear at the output boundary because that is the format
    // the attribute takes. Quaternions are [w, x, y, z]. model-viewer
    // applies orientation as Euler YXZ (yaw about Y, then pitch about X,
    // then roll about Z) and the attribute string is "<roll> <pitch> <yaw>".
    const QID = [1, 0, 0, 0];
    const qMul = (a, b) => [
        a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
        a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
        a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
        a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
    ];
    const qAxisAngle = (axis, deg) => {
        const h = deg * Math.PI / 360;
        const s = Math.sin(h);
        return [Math.cos(h), axis[0] * s, axis[1] * s, axis[2] * s];
    };
    const qRotate = (q, v) => {
        const w = q[0], x = q[1], y = q[2], z = q[3];
        const tx = 2 * (y * v[2] - z * v[1]);
        const ty = 2 * (z * v[0] - x * v[2]);
        const tz = 2 * (x * v[1] - y * v[0]);
        return [
            v[0] + w * tx + (y * tz - z * ty),
            v[1] + w * ty + (z * tx - x * tz),
            v[2] + w * tz + (x * ty - y * tx),
        ];
    };
    const qSlerp = (a, b, t) => {
        let cosom = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
        const bb = cosom < 0 ? b.map(v => -v) : b;
        cosom = Math.abs(cosom);
        let s0, s1;
        if (cosom > 0.9995) {
            s0 = 1 - t;
            s1 = t;
        } else {
            const om = Math.acos(cosom);
            const so = Math.sin(om);
            s0 = Math.sin((1 - t) * om) / so;
            s1 = Math.sin(t * om) / so;
        }
        const out = [
            s0 * a[0] + s1 * bb[0], s0 * a[1] + s1 * bb[1],
            s0 * a[2] + s1 * bb[2], s0 * a[3] + s1 * bb[3],
        ];
        const len = Math.hypot(out[0], out[1], out[2], out[3]) || 1;
        return out.map(v => v / len);
    };
    const qToOrientation = q => {
        const w = q[0], x = q[1], y = q[2], z = q[3];
        const m00 = 1 - 2 * (y * y + z * z);
        const m02 = 2 * (x * z + w * y);
        const m10 = 2 * (x * y + w * z);
        const m11 = 1 - 2 * (x * x + z * z);
        const m12 = 2 * (y * z - w * x);
        const m20 = 2 * (x * z - w * y);
        const m22 = 1 - 2 * (x * x + y * y);
        const pitch = Math.asin(Math.min(1, Math.max(-1, -m12)));
        let yaw, roll;
        if (Math.abs(m12) < 0.9999999) {
            yaw = Math.atan2(m02, m22);
            roll = Math.atan2(m10, m11);
        } else {
            yaw = Math.atan2(-m20, m00);
            roll = 0;
        }
        const d = 180 / Math.PI;
        return (roll * d).toFixed(2) + 'deg ' + (pitch * d).toFixed(2) +
            'deg ' + (yaw * d).toFixed(2) + 'deg';
    };
    const qFromOrientation = str => {
        const p = (str || '').trim().split(/\s+/).map(s => parseFloat(s) || 0);
        const qy = qAxisAngle([0, 1, 0], p[2]);
        const qx = qAxisAngle([1, 0, 0], p[1]);
        const qz = qAxisAngle([0, 0, 1], p[0]);
        return qMul(qy, qMul(qx, qz));
    };

    // ---- Orientation gizmo: SolidWorks-style view cube, triad, and
    // rotate arrows, attached per expansion viewer ----
    const GIZMO_SVG =
        '<svg viewBox="0 0 120 190" xmlns="http://www.w3.org/2000/svg">' +
        '<g class="gizmo-arrows">' +
        '<polygon class="gizmo-arrow" data-rot="up" points="60,2 52,12 68,12">' +
        '<title>Rotate up 90°</title></polygon>' +
        '<polygon class="gizmo-arrow" data-rot="down" points="60,118 52,108 68,108">' +
        '<title>Rotate down 90°</title></polygon>' +
        '<polygon class="gizmo-arrow" data-rot="left" points="2,60 12,52 12,68">' +
        '<title>Rotate left 90°</title></polygon>' +
        '<polygon class="gizmo-arrow" data-rot="right" points="118,60 108,52 108,68">' +
        '<title>Rotate right 90°</title></polygon>' +
        '<g class="gizmo-roll" data-rot="ccw"><title>Roll counterclockwise 90°</title>' +
        '<path d="M 8 28 A 19 19 0 0 1 25 9" /><polygon points="25,3 25,15 33,9" /></g>' +
        '<g class="gizmo-roll" data-rot="cw"><title>Roll clockwise 90°</title>' +
        '<path d="M 112 28 A 19 19 0 0 0 95 9" /><polygon points="95,3 95,15 87,9" /></g>' +
        '</g>' +
        '<g class="gizmo-cube"></g>' +
        '<g class="gizmo-triad" transform="translate(60, 162)"></g>' +
        '</svg>';
    const SVG_NS = 'http://www.w3.org/2000/svg';
    const CUBE_FACES = [
        { axis: '+x', normal: [1, 0, 0],
          corners: [[1, -1, -1], [1, 1, -1], [1, 1, 1], [1, -1, 1]] },
        { axis: '-x', normal: [-1, 0, 0],
          corners: [[-1, -1, -1], [-1, 1, -1], [-1, 1, 1], [-1, -1, 1]] },
        { axis: '+y', normal: [0, 1, 0],
          corners: [[-1, 1, -1], [1, 1, -1], [1, 1, 1], [-1, 1, 1]] },
        { axis: '-y', normal: [0, -1, 0],
          corners: [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]] },
        { axis: '+z', normal: [0, 0, 1],
          corners: [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]] },
        { axis: '-z', normal: [0, 0, -1],
          corners: [[-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1]] },
    ];
    const TRIAD_AXES = [
        { label: 'X', v: [1, 0, 0], color: '#d64541' },
        { label: 'Y', v: [0, 1, 0], color: '#2e7d46' },
        { label: 'Z', v: [0, 0, 1], color: '#2465c2' },
    ];
    const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

    const attachGizmo = (viewer, wrapEl, initialOrient, onOrientation) => {
        let qModel = initialOrient ? qFromOrientation(initialOrient) : QID.slice();
        let orientTimer = null;
        const holder = document.createElement('div');
        holder.className = 'view-gizmo';
        holder.setAttribute('aria-hidden', 'true');
        holder.innerHTML = GIZMO_SVG;
        wrapEl.appendChild(holder);
        const cubeG = holder.querySelector('.gizmo-cube');
        const triadG = holder.querySelector('.gizmo-triad');

        const cameraBasis = () => {
            const orbit = viewer.getCameraOrbit();
            const phi = Math.min(Math.max(orbit.phi, 0.002), Math.PI - 0.002);
            const theta = orbit.theta;
            const zc = [Math.sin(phi) * Math.sin(theta), Math.cos(phi),
                Math.sin(phi) * Math.cos(theta)];
            let xc = [zc[2], 0, -zc[0]];
            const xl = Math.hypot(xc[0], xc[1], xc[2]) || 1;
            xc = xc.map(v => v / xl);
            const yc = [
                zc[1] * xc[2] - zc[2] * xc[1],
                zc[2] * xc[0] - zc[0] * xc[2],
                zc[0] * xc[1] - zc[1] * xc[0],
            ];
            return { xc, yc, zc, orbit };
        };

        const renderGizmo = () => {
            if (typeof viewer.getCameraOrbit !== 'function') return;
            const { xc, yc, zc } = cameraBasis();
            const proj = (p, scale, cx, cy) => {
                const r = qRotate(qModel, p);
                return [cx + scale * dot3(r, xc), cy - scale * dot3(r, yc)];
            };
            cubeG.innerHTML = '';
            CUBE_FACES
                .map(f => ({ f, depth: dot3(qRotate(qModel, f.normal), zc) }))
                .filter(e => e.depth > 0.02)
                .sort((a, b) => a.depth - b.depth)
                .forEach(({ f }) => {
                    const pts = f.corners.map(c => proj(c, 21, 60, 60));
                    const poly = document.createElementNS(SVG_NS, 'polygon');
                    poly.setAttribute('points',
                        pts.map(p => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' '));
                    poly.setAttribute('class', 'gizmo-face');
                    poly.setAttribute('data-axis', f.axis);
                    cubeG.appendChild(poly);
                    const cx = pts.reduce((a, p) => a + p[0], 0) / 4;
                    const cy = pts.reduce((a, p) => a + p[1], 0) / 4;
                    const text = document.createElementNS(SVG_NS, 'text');
                    text.setAttribute('x', cx.toFixed(1));
                    text.setAttribute('y', (cy + 3).toFixed(1));
                    text.setAttribute('class', 'gizmo-face-label');
                    text.setAttribute('text-anchor', 'middle');
                    text.textContent = f.axis.replace('x', 'X')
                        .replace('y', 'Y').replace('z', 'Z');
                    cubeG.appendChild(text);
                });
            triadG.innerHTML = '';
            TRIAD_AXES.forEach(axis => {
                const rot = qRotate(qModel, axis.v);
                const end = [18 * dot3(rot, xc), -18 * dot3(rot, yc)];
                const line = document.createElementNS(SVG_NS, 'line');
                line.setAttribute('x1', '0');
                line.setAttribute('y1', '0');
                line.setAttribute('x2', end[0].toFixed(1));
                line.setAttribute('y2', end[1].toFixed(1));
                line.setAttribute('stroke', axis.color);
                triadG.appendChild(line);
                const text = document.createElementNS(SVG_NS, 'text');
                text.setAttribute('x', (end[0] * 25 / 18).toFixed(1));
                text.setAttribute('y', (end[1] * 25 / 18 + 3).toFixed(1));
                text.setAttribute('fill', axis.color);
                text.setAttribute('text-anchor', 'middle');
                text.textContent = axis.label;
                triadG.appendChild(text);
            });
        };

        // Throttle with a timeout, not requestAnimationFrame: rAF can be
        // suspended in background tabs, which would wedge the queue flag.
        let gizmoQueued = false;
        const queueGizmo = () => {
            if (gizmoQueued) return;
            gizmoQueued = true;
            setTimeout(() => {
                gizmoQueued = false;
                renderGizmo();
            }, 50);
        };

        const setOrbit = (thetaDeg, phiDeg, radius) => {
            const value =
                thetaDeg.toFixed(1) + 'deg ' + phiDeg.toFixed(1) + 'deg ' +
                radius.toFixed(1) + 'm';
            // Re-setting an identical attribute value is a no-op, which
            // would break repeating the same snap after the user orbits
            // away - remove first ONLY in that case. Removing
            // unconditionally would kill model-viewer's smooth
            // interpolation and make every snap a hard jump.
            if (viewer.getAttribute('camera-orbit') === value) {
                // Two ticks: LitElement drops a same-tick remove+set of an
                // identical value as a no-op, so the repeated snap would
                // never reach the camera.
                viewer.removeAttribute('camera-orbit');
                setTimeout(() => viewer.setAttribute('camera-orbit', value), 50);
                return;
            }
            viewer.setAttribute('camera-orbit', value);
        };

        const setOrientation = (q, animate) => {
            if (orientTimer) {
                clearInterval(orientTimer);
                orientTimer = null;
            }
            const from = qModel.slice();
            qModel = q.slice();
            const write = qq => {
                viewer.setAttribute('orientation', qToOrientation(qq));
                if (onOrientation) onOrientation(qq);
                queueGizmo();
            };
            if (!animate) {
                write(qModel);
                return;
            }
            const t0 = Date.now();
            const DURATION = 350;
            orientTimer = setInterval(() => {
                const t = Math.min(1, (Date.now() - t0) / DURATION);
                write(qSlerp(from, qModel, t * (2 - t)));
                if (t >= 1) {
                    clearInterval(orientTimer);
                    orientTimer = null;
                }
            }, 16);
        };

        const FACE_NORMALS = {};
        CUBE_FACES.forEach(f => { FACE_NORMALS[f.axis] = f.normal; });

        holder.addEventListener('click', e => {
            const target = e.target.closest
                ? e.target.closest('[data-axis], [data-rot]') : null;
            if (!target) return;
            const { xc, yc, zc, orbit } = cameraBasis();
            const axis = target.getAttribute('data-axis');
            if (axis) {
                // Point the camera at the face, wherever the model's
                // orientation has taken that axis in world space.
                const d = qRotate(qModel, FACE_NORMALS[axis]);
                const phiDeg = Math.acos(Math.min(1, Math.max(-1, d[1]))) *
                    180 / Math.PI;
                const thetaDeg = Math.abs(d[1]) > 0.999
                    ? orbit.theta * 180 / Math.PI
                    : Math.atan2(d[0], d[2]) * 180 / Math.PI;
                setOrbit(thetaDeg,
                    Math.min(179.9, Math.max(0.1, phiDeg)), orbit.radius);
                return;
            }
            // 90-degree rotate arrows: compose a quaternion step about the
            // current screen axis onto the model orientation.
            const rot = target.getAttribute('data-rot');
            const STEPS = {
                left: [yc, 90], right: [yc, -90],
                up: [xc, 90], down: [xc, -90],
                ccw: [zc, 90], cw: [zc, -90],
            };
            const st = STEPS[rot];
            if (!st) return;
            setOrientation(qMul(qAxisAngle(st[0], st[1]), qModel), true);
        });

        viewer.addEventListener('camera-change', queueGizmo);
        viewer.addEventListener('load', queueGizmo);
        customElements.whenDefined('model-viewer').then(queueGizmo);

        return { orient: () => qToOrientation(qModel) };
    };

    // ---- Shared accordion engine ----
    // opts: { blockId, vars, meshVars, overlays, defaultViews, sphereColor,
    //         autoOpen, preloadUrls }
    const initBlock = opts => {
        const block = document.getElementById(opts.blockId);
        if (!block) return false;
        const VARS = opts.vars;
        const MESH_VARS = opts.meshVars || {};
        const OVERLAYS = opts.overlays || [];
        const rows = [...block.querySelectorAll('.ntop-block-row')];
        const views = Object.assign({}, opts.defaultViews || {});
        const overlayState = {};
        let sphereColor = opts.sphereColor || '#ff3b30';
        let openKey = null;
        let current = null; // { key, viewer, bar, missing, gizmo }
        let loadPollToken = 0;

        (opts.preloadUrls || []).forEach(u => referencedUrls.add(u));

        const hexToRgb = hex => {
            const h = hex.replace('#', '');
            return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255);
        };
        // model-viewer computes camera framing (minimum orbit radius, max
        // field of view) from EVERY mesh in the scene, visible or not. The
        // bundled full-dog overlay is ~3x the socket, so with it counted
        // the camera can never get near the socket and captured views
        // silently fail to apply. Fix: mirror overlay on/off state onto
        // the three.js meshes' `visible` flag (which updateFraming DOES
        // respect) and reframe against only what is shown. The scene is
        // reached through model-viewer's internal symbol - if a future
        // library update renames it, everything still works minus the
        // reframe.
        const getThreeScene = viewer => {
            try {
                const sym = Object.getOwnPropertySymbols(viewer)
                    .find(s => String(s.description || '') === 'scene');
                return sym ? viewer[sym] : null;
            } catch (e) { return null; }
        };
        // The dog and surface overlays are identical in every GLB, so they
        // are rendered from ONE persistent clone parented to the scene's
        // Target container, which survives model swaps - the per-file
        // copies stay hidden forever. This is what stops the overlay from
        // blinking during slider scrubs: there is nothing to re-show after
        // a swap. The Target does not receive the `orientation` attribute
        // (the swapped model Group does), so the gizmo mirrors its
        // quaternion onto the clones (syncPersistentOrientation).
        const PERSIST_OVERLAYS = ['overlay-dog', 'overlay-surface'];
        const ensurePersistentOverlays = () => {
            if (!current) return;
            const scene = getThreeScene(current.viewer);
            if (!scene) return;
            const target = scene.getObjectByName('Target');
            if (!target) return;
            if (!current.persist) current.persist = {};
            PERSIST_OVERLAYS.forEach(name => {
                let src = null;
                scene.traverse(o => { if (o.isMesh && o.name === name) src = o; });
                if (current.persist[name]) {
                    // keep tracking the live model's orientation
                    if (src && src.parent && src.parent.parent) {
                        current.persist[name].quaternion.copy(
                            src.parent.parent.quaternion);
                    }
                    return;
                }
                if (!src) return;
                const clone = src.clone();
                clone.name = 'persist-' + name;
                clone.material = src.material.clone();
                clone.material.transparent = false;
                clone.material.opacity = 1;
                clone.material.depthWrite = true;
                if (name === 'overlay-surface') {
                    // The surface is an open sheet lying directly on the
                    // dog's skin: render both faces (visible from inside
                    // the socket too) and pull it slightly toward the
                    // camera in depth so it wins cleanly over the
                    // coplanar dog instead of z-fighting (gray/blue
                    // shimmer). side 2 = THREE.DoubleSide.
                    clone.material.side = 2;
                    clone.material.polygonOffset = true;
                    clone.material.polygonOffsetFactor = -2;
                    clone.material.polygonOffsetUnits = -2;
                }
                clone.scale.setScalar(1);
                if (src.parent && src.parent.parent) {
                    clone.quaternion.copy(src.parent.parent.quaternion);
                }
                clone.visible = false;
                target.add(clone);
                current.persist[name] = clone;
            });
        };
        const syncPersistentOrientation = q => {
            // q is [w, x, y, z] (the gizmo's model quaternion)
            if (!current || !current.persist) return;
            PERSIST_OVERLAYS.forEach(name => {
                const c = current.persist[name];
                if (c) c.quaternion.set(q[1], q[2], q[3], q[0]);
            });
        };
        const setPersistentVisibility = hidden => {
            if (!current || !current.persist) return {};
            const prev = {};
            PERSIST_OVERLAYS.forEach(name => {
                const c = current.persist[name];
                if (c) { prev[name] = c.visible; if (hidden) c.visible = false; }
            });
            return prev;
        };
        const syncOverlayMeshVisibility = () => {
            if (!current) return;
            const scene = getThreeScene(current.viewer);
            if (!scene) return;
            scene.traverse(o => {
                if (!o.isMesh) return;
                if (o.name.indexOf('persist-overlay-') === 0) {
                    const name = o.name.replace('persist-', '');
                    const cfg = OVERLAYS.find(c => c.name === name);
                    const allowed = !cfg || !cfg.onlyFor ||
                        cfg.onlyFor.indexOf(openKey) !== -1;
                    o.visible = allowed && !!overlayState[name];
                    return;
                }
                if (o.name.indexOf('overlay-') !== 0) return;
                if (PERSIST_OVERLAYS.indexOf(o.name) !== -1) {
                    // rendered via the persistent clone; the file copy
                    // stays hidden and tiny so framing ignores it
                    o.visible = false;
                    o.scale.setScalar(1e-6);
                    return;
                }
                const cfg = OVERLAYS.find(c => c.name === o.name);
                const allowed = !cfg || !cfg.onlyFor ||
                    cfg.onlyFor.indexOf(openKey) !== -1;
                o.visible = allowed && !!overlayState[o.name];
            });
            // The contact shadow's ground plane sits at the bottom of the
            // LOADED model (the socket), so with the full dog shown it
            // hovers mid-air halfway up the dog - fade it out while the
            // dog overlay is visible.
            current.viewer.setAttribute('shadow-intensity',
                overlayState['overlay-dog'] ? '0' : '1');
        };
        const reframeAndApplyView = (key, token) => {
            if (!current || typeof current.viewer.updateFraming !== 'function') return;
            // Only on the dropdown's first load. Re-running per slider step
            // rescales fov/limits against each step's bounds, which shows
            // up as a zoom shift on sweeps whose geometry changes size
            // (e.g. Pelvic Thickness).
            if (current.viewApplied) return;
            const viewer = current.viewer;
            current.viewApplied = true;
            // The captured view is set as attributes at viewer creation and
            // applies cleanly at load now that overlay meshes no longer
            // inflate the file's framing bounds - re-applying it here (the
            // old remove-then-set dance) showed the default camera for a
            // visible instant on every dropdown open. Only refresh the
            // framing itself, with the persistent overlay clones hidden so
            // they never enter the bounds.
            const prevVis = setPersistentVisibility(true);
            viewer.updateFraming().then(() => {
                Object.keys(prevVis).forEach(n => {
                    if (current && current.persist && current.persist[n]) {
                        current.persist[n].visible = prevVis[n];
                    }
                });
            }).catch(() => {});
        };
        // Matte plus overlay visibility for the current viewer. The global
        // matte pass only sees viewers that exist at page load, so the
        // dynamically created expansion viewers are handled here.
        const applyMatteAndOverlays = () => {
            if (!current || !current.viewer.model) return;
            current.viewer.model.materials.forEach(m => {
                try {
                    const pbr = m.pbrMetallicRoughness;
                    pbr.setRoughnessFactor(1.0);
                    pbr.setMetallicFactor(0.0);
                    const isOverlay = m.name && m.name.indexOf('overlay-') === 0;
                    if (!isOverlay) {
                        pbr.setBaseColorFactor([0.9, 0.9, 0.9, 1.0]);
                        return;
                    }
                    const cfg = OVERLAYS.find(o => o.name === m.name);
                    const allowed = !cfg || !cfg.onlyFor ||
                        cfg.onlyFor.indexOf(openKey) !== -1;
                    const on = allowed && !!overlayState[m.name];
                    const rgb = m.name === 'overlay-sphere'
                        ? hexToRgb(sphereColor)
                        : pbr.baseColorFactor.slice(0, 3);
                    m.setAlphaMode(on ? 'OPAQUE' : 'BLEND');
                    pbr.setBaseColorFactor([rgb[0], rgb[1], rgb[2], on ? 1 : 0]);
                } catch (e) {}
            });
            syncOverlayMeshVisibility();
        };
        const updateToggleBar = () => {
            if (!current || !current.bar) return;
            const mats = current.viewer.model
                ? current.viewer.model.materials.map(m => m.name) : [];
            [...current.bar.querySelectorAll('button')].forEach(btn => {
                btn.disabled = mats.indexOf(btn.dataset.overlay) === -1;
            });
        };
        const setSrc = src => {
            if (!current) return;
            const viewer = current.viewer;
            if (current.missing) current.missing.hidden = true;
            // model-viewer re-evaluates the camera ATTRIBUTES on every
            // model load, but interactive orbit/zoom lives only in internal
            // state - so a swap would snap the camera back to the stale
            // attribute values. Write the live camera into the attributes
            // first, so the re-application lands exactly where the user is.
            if (viewer.loaded && current.viewApplied &&
                typeof viewer.getCameraOrbit === 'function') {
                try {
                    // Prefer the camera GOAL over the rendered position:
                    // the rendered camera lags the goal while easing, so
                    // snapshotting it mid-animation would freeze the view
                    // a few mm short of where the user is headed.
                    let o = viewer.getCameraOrbit();
                    let ctrls = null;
                    try {
                        const sym = Object.getOwnPropertySymbols(viewer)
                            .find(x => String(x.description || '') === 'controls');
                        ctrls = sym && viewer[sym];
                        if (ctrls && ctrls.goalSpherical) o = ctrls.goalSpherical;
                    } catch (e2) {}
                    const t = viewer.getCameraTarget();
                    const deg = r => r * 180 / Math.PI;
                    viewer.setAttribute('camera-orbit',
                        deg(o.theta).toFixed(2) + 'deg ' +
                        deg(o.phi).toFixed(2) + 'deg ' +
                        o.radius.toFixed(1) + 'm');
                    viewer.setAttribute('camera-target',
                        t.x.toFixed(2) + 'm ' + t.y.toFixed(2) + 'm ' +
                        t.z.toFixed(2) + 'm');
                    // Wheel zoom changes radius AND field-of-view together
                    // (SmoothControls.adjustOrbit), so the fov must be
                    // snapshotted too or a swap re-applies the default fov
                    // and the view blows back out after zooming in. The
                    // attribute holds the FRAMING fov; the live goal is the
                    // aspect-ADJUSTED fov, so invert the adjustment.
                    try {
                        const goalFov = Math.exp(ctrls.goalLogFov);
                        const sc = ctrls.scene;
                        const k = Math.max(1, sc.idealAspect / sc.aspect);
                        const D = Math.PI / 180;
                        const framed = 2 * Math.atan(
                            Math.tan(goalFov * D / 2) / k) / D;
                        if (isFinite(framed) && framed > 1) {
                            viewer.setAttribute('field-of-view',
                                framed.toFixed(2) + 'deg');
                        }
                    } catch (e3) {}
                } catch (e) {}
            }
            if (viewer.getAttribute('src') !== src) viewer.setAttribute('src', src);
            // Two-phase wait: `loaded` can still be true for the OLD model
            // right after a src change, so wait to observe it drop before
            // trusting it again (with a time fallback for instant cache
            // swaps the poll interval might miss).
            const token = ++loadPollToken;
            const t0 = Date.now();
            let sawUnloaded = false;
            const poll = () => {
                if (token !== loadPollToken) return;
                if (!viewer.loaded) sawUnloaded = true;
                if (viewer.loaded && viewer.model &&
                    (sawUnloaded || Date.now() - t0 > 450)) {
                    ensurePersistentOverlays();
                    applyMatteAndOverlays();
                    updateToggleBar();
                    reframeAndApplyView(current ? current.key : null, token);
                    return;
                }
                setTimeout(poll, 100);
            };
            setTimeout(poll, 100);
        };

        const makeViewer = key => {
            const mv = document.createElement('model-viewer');
            mv.setAttribute('alt', 'Interactive 3D model for the selected block input');
            mv.setAttribute('loading', 'eager');
            mv.setAttribute('camera-controls', '');
            mv.setAttribute('touch-action', 'pan-y');
            mv.setAttribute('shadow-intensity', '1');
            mv.setAttribute('shadow-softness', '0.7');
            mv.setAttribute('exposure', '0.85');
            mv.setAttribute('tone-mapping', 'neutral');
            mv.setAttribute('environment-image', 'model-env.png');
            mv.setAttribute('ar', '');
            // Allow zooming out well past the auto-framed distance
            // (model-viewer's default max radius clamps close to it).
            // MUST be an absolute length: a percentage here fails to parse
            // and WEDGES the camera - orbit writes, captured views, fov,
            // and wheel zoom all silently stop applying.
            mv.setAttribute('max-camera-orbit', 'auto auto 1600m');
            // Explicit small minimum radius. The 'auto' minimum is
            // recomputed from each loaded model's bounds, so scrubbing a
            // slider while zoomed in close could clamp the camera outward
            // on bigger-bounded steps (an intermittent zoom jump), and
            // hitting the auto minimum engages fov-zoom, which swaps
            // reset. Both are absolute-length format; percentages wedge
            // the camera (see max-camera-orbit note).
            mv.setAttribute('min-camera-orbit', 'auto auto 20m');
            // Halve wheel/pinch zoom speed (default sensitivity is 1).
            mv.setAttribute('zoom-sensitivity', '0.5');
            // Without this, every quick click re-targets the camera to the
            // clicked surface point (and a click on the background resets
            // the target and zooms fully out) - which makes the rotation
            // pivot wander and fights shift-drag panning.
            mv.setAttribute('disable-tap', '');
            // Sync overlay state the moment each model finishes loading -
            // the 'load' event fires before the new model's first paint,
            // so a toggled-on overlay (e.g. the full dog) carries across
            // slider swaps without blinking off while the slower fallback
            // poll catches up.
            mv.addEventListener('load', () => {
                if (current && current.viewer === mv) {
                    ensurePersistentOverlays();
                    applyMatteAndOverlays();
                    updateToggleBar();
                }
            });
            const view = views[key] || (VARS[key] ? views['*'] : null);
            if (view) {
                mv.setAttribute('camera-orbit', view.orbit);
                mv.setAttribute('camera-target', view.target);
                if (view.fov) mv.setAttribute('field-of-view', view.fov);
                if (view.orient) mv.setAttribute('orientation', view.orient);
            }
            return mv;
        };

        const makeSlider = (labelText, min, max, step, value, unit, ticks) => {
            const wrap = document.createElement('div');
            wrap.className = 'point-slider';
            const label = document.createElement('label');
            label.className = 'point-slider-label';
            label.textContent = labelText + ': ';
            const readout = document.createElement('span');
            readout.textContent = value;
            label.appendChild(readout);
            if (unit) label.appendChild(document.createTextNode(' ' + unit));
            const input = document.createElement('input');
            input.type = 'range';
            input.min = min;
            input.max = max;
            input.step = step;
            input.value = value;
            const tickRow = document.createElement('div');
            tickRow.className = 'point-slider-ticks';
            tickRow.setAttribute('aria-hidden', 'true');
            ticks.forEach(t => {
                const s = document.createElement('span');
                s.textContent = t;
                tickRow.appendChild(s);
            });
            wrap.append(label, input, tickRow);
            return { wrap, input, readout };
        };

        const makeToggleBar = key => {
            const bar = document.createElement('div');
            bar.className = 'overlay-toggles';
            OVERLAYS.forEach(o => {
                // Overlays with a defaultOn list reset to their per-row
                // default each time a dropdown opens (on for listed keys,
                // off elsewhere). Overlays without one keep whatever the
                // user last toggled.
                if (o.defaultOn) {
                    overlayState[o.name] = o.defaultOn.indexOf(key) !== -1;
                }
            });
            OVERLAYS.forEach(o => {
                if (o.onlyFor && o.onlyFor.indexOf(key) === -1) return;
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'model-toggle-btn' +
                    (overlayState[o.name] ? ' active' : '');
                btn.textContent = o.label;
                btn.dataset.overlay = o.name;
                btn.disabled = true;
                btn.addEventListener('click', () => {
                    overlayState[o.name] = !overlayState[o.name];
                    btn.classList.toggle('active', !!overlayState[o.name]);
                    applyMatteAndOverlays();
                    // The full-dog mesh is ~3x taller than the socket the
                    // default views frame, so at socket-framing distance it
                    // fills the frustum as a featureless wall. Zoom out to
                    // fit the dog when shown; restore the prior distance
                    // when hidden.
                    if (o.name === 'overlay-dog' && current) {
                        const viewer = current.viewer;
                        const orbit = viewer.getCameraOrbit();
                        const DOG_RADIUS = 1100; // dog bound ~280mm / sin(fov/2)
                        const deg = r => r * 180 / Math.PI;
                        if (overlayState[o.name]) {
                            if (orbit.radius < DOG_RADIUS) {
                                current.preDogRadius = orbit.radius;
                                viewer.setAttribute('camera-orbit',
                                    deg(orbit.theta).toFixed(1) + 'deg ' +
                                    deg(orbit.phi).toFixed(1) + 'deg ' +
                                    DOG_RADIUS + 'm');
                            }
                        } else if (current.preDogRadius) {
                            viewer.setAttribute('camera-orbit',
                                deg(orbit.theta).toFixed(1) + 'deg ' +
                                deg(orbit.phi).toFixed(1) + 'deg ' +
                                current.preDogRadius.toFixed(1) + 'm');
                            current.preDogRadius = null;
                        }
                    }
                });
                bar.appendChild(btn);
            });
            return bar;
        };

        const closeAll = () => {
            loadPollToken++;
            cancelWarm();
            block.querySelectorAll('.ntop-expand.open').forEach(p =>
                p.classList.remove('open'));
            rows.forEach(r => r.classList.remove('open', 'active'));
            block.querySelectorAll('.ntop-expand-body').forEach(b => {
                b.innerHTML = '';
            });
            current = null;
            openKey = null;
        };

        const buildExpansion = key => {
            const body = block.querySelector(
                '[data-expand="' + key + '"] .ntop-expand-body');
            const row = rows.find(r => r.dataset.key === key);
            if (!body || !row) return;
            const rowValueEl = row.querySelector('[data-value]');
            const cfg = VARS[key] || MESH_VARS[key];
            openKey = key;

            const desc = document.createElement('p');
            desc.className = 'ntop-expand-desc';
            desc.textContent = cfg.desc;
            body.appendChild(desc);

            const viewer = makeViewer(key);
            current = { key, viewer, bar: null, missing: null, gizmo: null, viewApplied: false };

            if (MESH_VARS[key]) {
                const choices = document.createElement('div');
                choices.className = 'ntop-mesh-choices';
                cfg.options.forEach(opt => {
                    const btn = document.createElement('button');
                    btn.type = 'button';
                    btn.className = 'model-toggle-btn' +
                        (opt.label === rowValueEl.textContent ? ' active' : '');
                    btn.textContent = opt.label + (opt.file ? '' : ' (coming soon)');
                    btn.disabled = !opt.file;
                    btn.addEventListener('click', () => {
                        choices.querySelectorAll('button').forEach(b =>
                            b.classList.toggle('active', b === btn));
                        rowValueEl.textContent = opt.label;
                        setSrc(opt.file);
                    });
                    choices.appendChild(btn);
                });
                body.appendChild(choices);
                warmModels(cfg.options.filter(o => o.file).map(o => o.file));
            } else if (cfg.type === 'grid') {
                const state = {};
                cfg.axes.forEach(axis => {
                    state[axis.key] = axis.def;
                    const ticks = [];
                    for (let t = axis.min; t <= axis.max; t += axis.step) ticks.push(t);
                    const s = makeSlider(axis.label || axis.key, axis.min, axis.max,
                        axis.step, axis.def, axis.unit, ticks);
                    s.input.addEventListener('input', () => {
                        state[axis.key] = parseInt(s.input.value, 10);
                        s.readout.textContent = state[axis.key];
                        rowValueEl.textContent = cfg.rowValue(state.Y, state.Z);
                        setSrc(cfg.file(state.Y, state.Z));
                    });
                    body.appendChild(s.wrap);
                });
            } else {
                const values = cfg.values ||
                    Array.from({ length: (cfg.max - cfg.min) / cfg.step + 1 },
                        (_, i) => cfg.min + i * cfg.step);
                const defIdx = Math.max(0, values.indexOf(cfg.def));
                // Load this dropdown's whole sweep in the background,
                // nearest values first, so scrubbing is instant.
                const warmStart = values[defIdx];
                warmModels(values.slice()
                    .sort((x, y) => Math.abs(x - warmStart) - Math.abs(y - warmStart))
                    .map(cfg.file));
                const s = makeSlider(cfg.title, 0, values.length - 1, 1,
                    defIdx, cfg.unit, values);
                const cur = parseInt(rowValueEl.textContent, 10);
                const curIdx = values.indexOf(cur);
                if (curIdx !== -1) {
                    s.input.value = curIdx;
                    s.readout.textContent = values[curIdx];
                } else {
                    s.readout.textContent = values[defIdx];
                }
                s.input.addEventListener('input', () => {
                    const v = values[parseInt(s.input.value, 10)];
                    s.readout.textContent = v;
                    rowValueEl.textContent = v;
                    setSrc(cfg.file(v));
                });
                body.appendChild(s.wrap);
            }

            const bar = makeToggleBar(key);
            body.appendChild(bar);
            current.bar = bar;

            const wrap = document.createElement('div');
            wrap.className = 'viewer-wrap';
            wrap.appendChild(viewer);
            body.appendChild(wrap);
            const view = views[key] || (VARS[key] ? views['*'] : null);
            current.gizmo = attachGizmo(viewer, wrap, view && view.orient,
                syncPersistentOrientation);

            const missing = document.createElement('p');
            missing.className = 'ntop-demo-missing';
            missing.textContent = 'The model for this value has not been uploaded yet.';
            missing.hidden = true;
            body.appendChild(missing);
            current.missing = missing;
            viewer.addEventListener('error', () => { missing.hidden = false; });
            // Backup for the poll in setSrc: when the load event does fire,
            // reapply overlay state to the new model immediately.
            viewer.addEventListener('load', () => {
                applyMatteAndOverlays();
                updateToggleBar();
            });

            // Initial model
            if (MESH_VARS[key]) {
                const sel = cfg.options.find(o =>
                    o.label === rowValueEl.textContent) || cfg.options[0];
                if (sel.file) setSrc(sel.file);
            } else if (cfg.type === 'grid') {
                setSrc(cfg.file(...cfg.axes.map(a => a.def)));
            } else {
                const values = cfg.values ||
                    Array.from({ length: (cfg.max - cfg.min) / cfg.step + 1 },
                        (_, i) => cfg.min + i * cfg.step);
                const cur = parseInt(rowValueEl.textContent, 10);
                const v = values.indexOf(cur) !== -1 ? cur : cfg.def;
                setSrc(cfg.file(v));
            }

            block.querySelector('[data-expand="' + key + '"]').classList.add('open');
            row.classList.add('open', 'active');
        };

        rows.forEach(row => {
            row.addEventListener('click', () => {
                const key = row.dataset.key;
                const wasOpen = openKey === key;
                closeAll();
                if (!wasOpen) buildExpansion(key);
            });
        });

        // ---- View editor: open ntop-socket-creation.html?dev=1, open an
        // input, orbit the model, capture the view, pick the sphere color,
        // then paste the generated block over DEFAULT_VIEWS / SPHERE_COLOR.
        if (new URLSearchParams(window.location.search).has('dev')) {
            const panel = document.createElement('div');
            panel.className = 'quiz-dev-panel';
            panel.innerHTML =
                '<p class="quiz-dev-help">View editor: open an input on the block, ' +
                'orbit and zoom the model to the view you want, then press ' +
                '<strong>Capture view</strong>. "Capture as fallback" sets the view ' +
                'used by inputs without their own. Pick the sphere color with the ' +
                'swatch. Copy the code below and paste it over the ' +
                '<code>DEFAULT_VIEWS</code> / <code>SPHERE_COLOR</code> block in ' +
                '<code>script.js</code>.</p>' +
                '<p class="quiz-dev-actions">' +
                '<button type="button" class="quiz-dev-copy" data-capture>Capture view for open input</button> ' +
                '<button type="button" class="quiz-dev-copy" data-capture-all>Capture as fallback (*)</button> ' +
                '<label class="dev-sphere-label">Sphere color: ' +
                '<input type="color" data-sphere-color></label></p>' +
                '<textarea class="quiz-dev-output" readonly spellcheck="false"></textarea>' +
                '<button type="button" class="quiz-dev-copy" data-copy>Copy code</button>' +
                '<span class="quiz-dev-copied" hidden>Copied!</span>';
            block.closest('.accordion-wrap').after(panel);
            const output = panel.querySelector('.quiz-dev-output');
            const colorInput = panel.querySelector('[data-sphere-color]');
            colorInput.value = sphereColor;

            const serialize = () => {
                const keys = Object.keys(views);
                const lines = keys.map(k =>
                    "        '" + k + "': { orbit: '" + views[k].orbit +
                    "', target: '" + views[k].target +
                    "', fov: '" + views[k].fov + "'" +
                    (views[k].orient ? ", orient: '" + views[k].orient + "'" : '') +
                    ' },');
                output.value =
                    '    const DEFAULT_VIEWS = {\n' + lines.join('\n') +
                    (lines.length ? '\n' : '') + '    };\n' +
                    "    const SPHERE_COLOR = '" + sphereColor + "';";
            };

            const capture = key => {
                if (!current) return;
                const viewer = current.viewer;
                const orbit = viewer.getCameraOrbit();
                const target = viewer.getCameraTarget();
                views[key] = {
                    orbit: (orbit.theta * 180 / Math.PI).toFixed(1) + 'deg ' +
                        (orbit.phi * 180 / Math.PI).toFixed(1) + 'deg ' +
                        orbit.radius.toFixed(1) + 'm',
                    target: target.x.toFixed(1) + 'm ' + target.y.toFixed(1) +
                        'm ' + target.z.toFixed(1) + 'm',
                    fov: viewer.getFieldOfView().toFixed(1) + 'deg',
                    orient: current.gizmo ? current.gizmo.orient() : undefined,
                };
                serialize();
            };

            panel.querySelector('[data-capture]').addEventListener('click',
                () => { if (openKey) capture(openKey); });
            panel.querySelector('[data-capture-all]').addEventListener('click',
                () => capture('*'));
            colorInput.addEventListener('input', () => {
                sphereColor = colorInput.value;
                applyMatteAndOverlays();
                serialize();
            });
            panel.querySelector('[data-copy]').addEventListener('click', () => {
                const note = panel.querySelector('.quiz-dev-copied');
                const show = () => {
                    note.hidden = false;
                    setTimeout(() => { note.hidden = true; }, 1500);
                };
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(output.value).then(show);
                } else {
                    output.select();
                    document.execCommand('copy');
                    show();
                }
            });
            serialize();
        }

        if (opts.autoOpen) buildExpansion(opts.autoOpen);
        // Handle for page-level controls (the animal selector closes all
        // dropdowns so the next open rebuilds against the new namespace).
        return { closeAll };
    };

    // ---- Page configs ----
    // Preload only each row's default model; every other step loads on
    // demand the first time its slider reaches it. With ~500 GLBs on this
    // page, preloading the full library (~200 MB) is no longer viable.
    const socketPreload =
        Object.values(SOCKET_VARS).map(cfg => cfg.file(cfg.def));
    // The Solid Animal and Socket Attachment Surface rows are removed from
    // the block, so SOCKET_MESH_VARS is not passed and the Billie meshes
    // are not preloaded. Restore by passing meshVars: SOCKET_MESH_VARS and
    // re-adding the rows in ntop-socket-creation.html.
    const socketBlockHandle = initBlock({
        blockId: 'socket-lattice-block',
        vars: SOCKET_VARS,
        overlays: SOCKET_OVERLAYS,
        defaultViews: DEFAULT_VIEWS,
        sphereColor: SPHERE_COLOR,
        preloadUrls: socketPreload,
    });

    // ---- Socket & Interface Cap block ----
    // The Interface Cap joins the lattice socket to the mechanical socket.
    // Chihuahua sweep exports (July 19). Non-swept inputs sit at the
    // notebook baseline: IntPos (-49.9, -110, 165), Lateral -152, Medial 2,
    // Rotation -15, Adjust (0, 0, 20), blend radii 12/6. The blend point
    // sweeps were run at Max Blend Radius 20 / Min Blend Radius 5 so the
    // moving blend is easier to see. Angle sweeps cover the full circle,
    // so their 0deg default differs from the baseline angles.
    const INTERFACE_VARS = {
        'lateral-angle': {
            title: 'Lateral Angle',
            type: 'slider',
            min: 0, max: 360, step: 10, def: 0, unit: 'deg',
            file: v => AP() + 'lateralangle-' + pad3(v) + '.glb',
            desc: 'Rotates the interface cap about the lateral rotation axis. The full sweep runs 0-360 degrees; the design baseline is -152 (equivalently 208) degrees.',
        },
        'medial-angle': {
            title: 'Medial Angle',
            type: 'slider',
            min: 0, max: 360, step: 10, def: 0, unit: 'deg',
            file: v => AP() + 'medialangle-' + pad3(v) + '.glb',
            desc: 'Rotates the interface cap about the medial direction. The design baseline is 2 degrees.',
        },
        'interface-rotation': {
            title: 'Interface Rotation',
            type: 'slider',
            min: 0, max: 360, step: 10, def: 0, unit: 'deg',
            file: v => AP() + 'ifacerot-' + pad3(v) + '.glb',
            desc: 'Spins the interface cap about its own axis. The design baseline is -15 (equivalently 345) degrees.',
        },
        'interface-position-y': {
            title: 'Interface Position Y',
            type: 'slider',
            min: -200, max: 0, step: 10, def: -110, unit: 'mm',
            file: v => AP() + 'ifacepos-y-' + pad3(Math.abs(v)) + '.glb',
            desc: 'Moves the whole interface along the Y axis. X and Z are fixed at -49.9 and 165 mm.',
        },
        'interface-position-z': {
            title: 'Interface Position Z',
            type: 'slider',
            min: 165, max: 355, step: 10, def: 165, unit: 'mm',
            file: v => AP() + 'ifacepos-z-' + pad3(v) + '.glb',
            desc: 'Moves the whole interface along the Z axis. X and Y are fixed at -49.9 and -110 mm.',
        },
        'interface-x': {
            title: 'Interface X Adjust',
            type: 'slider',
            min: -50, max: 50, step: 5, def: 0, unit: 'mm',
            file: v => AP() + 'ifacexadj-' + signed2(v) + '.glb',
            desc: 'Shifts the interface cap along the X axis.',
        },
        'interface-y': {
            title: 'Interface Y Adjust',
            type: 'slider',
            min: -50, max: 50, step: 5, def: 0, unit: 'mm',
            file: v => AP() + 'ifaceyadj-' + signed2(v) + '.glb',
            desc: 'Shifts the interface cap along the Y axis.',
        },
        'interface-z': {
            title: 'Interface Z Adjust',
            type: 'slider',
            min: -50, max: 50, step: 5, def: 20, unit: 'mm',
            file: v => AP() + 'ifacezadj-' + signed2(v) + '.glb',
            desc: 'Shifts the interface cap along the Z axis. The design baseline is 20 mm.',
        },
        'max-blend-radius': {
            title: 'Max Blend Radius',
            type: 'slider',
            min: 0, max: 30, step: 2, def: 12, unit: 'mm',
            file: v => AP() + 'maxblendrad-' + pad2(v) + '.glb',
            desc: 'Sets the largest fillet radius where the cap meets the socket.',
        },
        'min-blend-radius': {
            title: 'Min Blend Radius',
            type: 'slider',
            min: 0, max: 30, step: 2, def: 6, unit: 'mm',
            file: v => AP() + 'minblendrad-' + pad2(v) + '.glb',
            desc: 'Sets the smallest fillet radius where the cap meets the socket.',
        },
        'max-blend-point-y': {
            title: 'Max Blend Point Y',
            type: 'slider',
            min: -100, max: -50, step: 10, def: -100, unit: 'mm',
            file: v => AP() + 'maxblendpt-y-' + pad3(Math.abs(v)) + '.glb',
            desc: 'Moves the point of maximum blend along the Y axis (X and Z fixed at -60.1 and 183 mm). Shown with blend radii fixed at 20 / 5 mm.',
        },
        'max-blend-point-z': {
            title: 'Max Blend Point Z',
            type: 'slider',
            min: 130, max: 230, step: 10, def: 180, unit: 'mm',
            file: v => AP() + 'maxblendpt-z-' + pad3(v) + '.glb',
            desc: 'Moves the point of maximum blend along the Z axis (X and Y fixed at -60.1 and -122 mm). Shown with blend radii fixed at 20 / 5 mm.',
        },
        'min-blend-point-y': {
            title: 'Min Blend Point Y',
            type: 'slider',
            min: -100, max: -50, step: 10, def: -100, unit: 'mm',
            file: v => AP() + 'minblendpt-y-' + pad3(Math.abs(v)) + '.glb',
            desc: 'Moves the point of minimum blend along the Y axis (X and Z fixed at -50.9 and 145 mm). Shown with blend radii fixed at 20 / 5 mm.',
        },
        'min-blend-point-z': {
            title: 'Min Blend Point Z',
            type: 'slider',
            min: 90, max: 190, step: 10, def: 140, unit: 'mm',
            file: v => AP() + 'minblendpt-z-' + pad3(v) + '.glb',
            desc: 'Moves the point of minimum blend along the Z axis (X and Y fixed at -50.9 and -113 mm). Shown with blend radii fixed at 20 / 5 mm.',
        },
    };
    const interfacePreload =
        Object.values(INTERFACE_VARS).map(cfg => cfg.file(cfg.def));
    const interfaceBlockHandle = initBlock({
        blockId: 'interface-cap-block',
        vars: INTERFACE_VARS,
        overlays: [
            { name: 'overlay-dog', label: 'Full Dog' },
            { name: 'overlay-surface', label: 'Attachment Surface' },
        ],
        defaultViews: { '*': CHI_VIEW },
        preloadUrls: interfacePreload,
    });

    // ---- Attachment block ----
    // Screws the finished socket to the animal. Chihuahua sweep exports
    // (July 19); non-swept inputs sit at the notebook baseline (Attach Dia
    // 5, Wall 3, Head Dia 7, Head Height 4, Shaft 4, Hole Blend 3). Every
    // GLB bundles an overlay-sphere mesh marking the six attachment points.
    // Nozzle Diameter and Hole Cut Depth have no sweep yet and keep the
    // not-uploaded note. ntop-screw-00..06.glb (ISO 4762 M1.6-M6 ladder)
    // are exported and committed but wait on the button-group control.
    const ATTACH_VARS = {
        'attach-points-drop': {
            title: 'Attachment Points Drop',
            type: 'slider',
            min: 0, max: 100, step: 5, def: 0, unit: 'mm',
            file: v => AP() + 'attachptsdrop-' + pad3(v) + '.glb',
            desc: 'Lowers all six attachment points together along Z, keeping their X and Y positions. Toggle the Attachment Point Spheres to see the points themselves.',
        },
        'attach-diameter': {
            title: 'Attach Diameter',
            type: 'slider',
            min: 1, max: 29, step: 2, def: 5, unit: 'mm',
            file: v => AP() + 'attachdia-' + pad2(v) + '.glb',
            desc: 'Sets the diameter of each attachment pad.',
        },
        'normal-wall': {
            title: 'Normal Wall Distance',
            type: 'slider',
            min: 1, max: 15, step: 1, def: 3, unit: 'mm',
            file: v => AP() + 'wallthick-' + pad2(v) + '.glb',
            desc: 'Sets how far the attachment wall extends along the surface normal.',
        },
        'screw-head-diameter': {
            title: 'Screw Head Diameter',
            type: 'slider',
            min: 1, max: 15, step: 1, def: 7, unit: 'mm',
            file: v => AP() + 'headdia-' + pad2(v) + '.glb',
            desc: 'Sets the countersink diameter for the screw head.',
        },
        'screw-head-height': {
            title: 'Screw Head Height',
            type: 'slider',
            min: 1, max: 15, step: 1, def: 4, unit: 'mm',
            file: v => AP() + 'headheight-' + pad2(v) + '.glb',
            desc: 'Sets the countersink depth for the screw head.',
        },
        'screw-shaft-diameter': {
            title: 'Screw Shaft Diameter',
            type: 'slider',
            min: 1, max: 15, step: 1, def: 4, unit: 'mm',
            file: v => AP() + 'shaftdia-' + pad2(v) + '.glb',
            desc: 'Sets the clearance hole diameter for the screw shaft.',
        },
        'hole-blend-radius': {
            title: 'Hole Blend Radius',
            type: 'slider',
            // baseline is 3 mm but the sweep grid is even, so default to 4
            min: 0, max: 30, step: 2, def: 4, unit: 'mm',
            file: v => AP() + 'holeblend-' + pad2(v) + '.glb',
            desc: 'Sets the fillet radius around each screw hole.',
        },
        'nozzle-diameter': {
            title: 'Nozzle Diameter',
            type: 'slider',
            min: 0, max: 20, step: 2, def: 10, unit: 'mm',
            file: v => AP() + 'attach-nozzle-' + pad2(v) + '.glb',
            desc: 'Sets the nozzle diameter used for the attachment geometry.',
        },
        'hole-cut-depth': {
            title: 'Hole Cut Depth',
            type: 'slider',
            min: 0, max: 20, step: 2, def: 10, unit: 'mm',
            file: v => AP() + 'attach-holecut-' + pad2(v) + '.glb',
            desc: 'Sets how deep each screw hole is cut into the socket.',
        },
    };
    const attachPreload =
        Object.values(ATTACH_VARS).map(cfg => cfg.file(cfg.def));
    const attachBlockHandle = initBlock({
        blockId: 'attachment-block',
        vars: ATTACH_VARS,
        overlays: [
            { name: 'overlay-dog', label: 'Full Dog' },
            { name: 'overlay-surface', label: 'Attachment Surface' },
            { name: 'overlay-sphere', label: 'Attachment Point Spheres',
              defaultOn: ['attach-points-drop'] },
        ],
        defaultViews: { '*': CHI_VIEW },
        preloadUrls: attachPreload,
    });

    // Paw lattice page. Sweeps from the July 9 exports; the baseline is
    // Curve Depth -35 / Bottom Length 120 / Cell Size 8 / Hexagonal.
    const PAW_VARS = {
        'cell-size': {
            title: 'Cell Size',
            type: 'slider',
            min: 5, max: 15, step: 1, def: 8, unit: 'mm',
            file: v => 'ntop-paw-cellsize-' + pad2(v) + '.glb',
            desc: 'Sets the size of each honeycomb cell across the paw. Smaller cells give a denser, stiffer tread; larger cells are more open and compliant.',
        },
        'curve-depth': {
            title: 'Curve Depth',
            type: 'slider',
            min: -35, max: -14, step: 1, def: -35, unit: 'mm',
            file: v => 'ntop-paw-curvedepth-' + pad2(Math.abs(v)) + '.glb',
            desc: 'Sets how deeply the bottom surface of the paw curves.',
        },
        'bottom-length': {
            title: 'Bottom Length',
            type: 'slider',
            min: 30, max: 120, step: 5, def: 120, unit: 'mm',
            file: v => 'ntop-paw-bottomlength-' + String(v).padStart(3, '0') + '.glb',
            desc: 'Sets the length of the flat bottom section of the paw.',
        },
    };
    const PAW_MESH_VARS = {
        'unit-cell': {
            title: 'Unit Cell',
            desc: 'Chooses the lattice pattern the paw is built from. Pick a unit cell to compare the two structures (the square honeycomb is shown at its 12 mm cell size).',
            options: [
                { label: 'Square Honey Comb', file: 'ntop-paw-unitcell-square.glb' },
                { label: 'Hexagonal Honey Comb', file: 'ntop-paw-unitcell-hex.glb' },
            ],
        },
    };
    // Default camera view for the paw demos, captured with the ?dev=1
    // panel. The unit-cell models share the paw coordinate space, so the
    // view applies to the chooser too.
    const PAW_VIEW = {
        orbit: '97.4deg 89.1deg 275.3m',
        target: '0.4m 16.3m -4.2m',
        fov: '30.0deg',
        orient: '89.91deg -81.68deg -83.34deg',
    };
    const pawPreload =
        Object.values(PAW_VARS).map(cfg => cfg.file(cfg.def));
    PAW_MESH_VARS['unit-cell'].options.forEach(o => pawPreload.push(o.file));
    initBlock({
        blockId: 'paw-lattice-block',
        vars: PAW_VARS,
        meshVars: PAW_MESH_VARS,
        overlays: [],
        defaultViews: {
            'unit-cell': PAW_VIEW,
            'cell-size': PAW_VIEW,
            'curve-depth': PAW_VIEW,
            'bottom-length': PAW_VIEW,
        },
        preloadUrls: pawPreload,
    });

    // ---- Ollie progress block (ollie-case-study.html) ----
    // Single bundled model: the socket as the base mesh with the solid
    // animal scan and attachment area as overlays, so they can be layered
    // together like the socket-creation demos. Capture a default view with
    // ollie-case-study.html?dev=1 and paste it into defaultViews here.
    const OLLIE_MESH_VARS = {
        'ollie-progress': {
            title: 'Current Design',
            desc: 'The July 2026 state of the design: the generated socket, with toggles to layer the cleaned solid scan and the mapped attachment area.',
            options: [
                { label: 'Prosthetic Socket', file: 'ollie-progress.glb' },
            ],
        },
        'ollie-paw': {
            title: 'Paw Lattice',
            desc: 'The hexagonal honeycomb paw generated for Ollie (July 4 export), preserved at a higher face budget so the fine lattice detail survives.',
            options: [
                { label: 'Hexagonal Honeycomb', file: 'ollie-paw.glb' },
            ],
        },
    };
    initBlock({
        blockId: 'ollie-progress-block',
        vars: {},
        meshVars: OLLIE_MESH_VARS,
        overlays: [
            { name: 'overlay-socket', label: 'Prosthetic Socket',
              onlyFor: ['ollie-progress'], defaultOn: ['ollie-progress'] },
            { name: 'overlay-dog', label: 'Solid Animal',
              onlyFor: ['ollie-progress'] },
            { name: 'overlay-surface', label: 'Attachment Area',
              onlyFor: ['ollie-progress'] },
        ],
        defaultViews: {
            'ollie-progress': { orbit: '2.6deg 177.4deg 491.9m', target: '0.0m -0.0m 0.0m', fov: '30.0deg', orient: '179.99deg -0.23deg 2.60deg' },
        },
        autoOpen: 'ollie-progress',
        preloadUrls: ['ollie-progress.glb'],
    });

    // ---- Home page teaser block (index.html) ----
    // A two-row taste of the socket-creation page. Deliberately pinned to
    // the Chihuahua namespace rather than AP(): the home page has no animal
    // selector, so the filenames must not depend on selector state. Nothing
    // is preloaded beyond the auto-opened row's default model - the home
    // page budget is the hero viewer plus this one.
    const HOME_VARS = {
        'home-point-count': {
            title: 'Lattice Point Count',
            type: 'slider',
            values: POINT_COUNTS, def: 100, unit: '',
            file: v => 'ntop-chi-pointcount-' + pad3(v) + '.glb',
            desc: 'Controls how densely the lattice is sampled across the socket. A low count gives a sparse, open structure that flexes freely; a high count gives a finer, stiffer mesh that spreads load over more contact area.',
        },
        'home-max-thickness': {
            title: 'Max Socket Thickness',
            type: 'slider',
            min: 0, max: 20, step: 2, def: 8, unit: 'mm',
            file: v => 'ntop-chi-maxthick-' + pad2(v) + '.glb',
            desc: 'Sets the upper limit on the socket wall thickness. Thicker walls are stronger and heavier; the design balances the two against the weight of the animal.',
        },
    };
    initBlock({
        blockId: 'home-demo-block',
        vars: HOME_VARS,
        overlays: [],
        defaultViews: { '*': CHI_VIEW },
        autoOpen: 'home-point-count',
        preloadUrls: [],
    });

    // ---- Animal selector wiring ----
    // Buttons live in #animal-select on the socket-creation page. Switching
    // animals closes every open dropdown (so the next open rebuilds its
    // viewer against the new namespace) and flips the active button. Blocks
    // whose libraries are not exported yet degrade to the not-uploaded note.
    const animalSelect = document.getElementById('animal-select');
    if (animalSelect) {
        const note = document.getElementById('animal-select-note');
        Object.keys(ANIMALS).forEach(key => {
            const a = ANIMALS[key];
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'model-toggle-btn animal-btn' +
                (key === activeAnimal ? ' active' : '');
            btn.innerHTML = a.label + '<span class="animal-btn-sub">' +
                a.sub + '</span>';
            btn.addEventListener('click', () => {
                if (activeAnimal === key) return;
                activeAnimal = key;
                [socketBlockHandle, interfaceBlockHandle, attachBlockHandle]
                    .forEach(h => { if (h && h.closeAll) h.closeAll(); });
                [...animalSelect.querySelectorAll('.animal-btn')].forEach(
                    b => b.classList.toggle('active', b === btn));
                if (note) {
                    note.hidden = a.ready;
                    note.textContent = a.ready ? '' : 'The ' + a.sub +
                        ' model library has not been generated yet - every ' +
                        'demo will show a "not uploaded yet" note until its ' +
                        'sweeps are exported and converted.';
                }
            });
            animalSelect.appendChild(btn);
        });
    }

    // Warm the cache with each block's default models only (plus any
    // statically referenced viewers); the rest of the library loads on
    // demand as sliders move. A hidden viewer walks each GLB once, warming
    // model-viewer's parsed-model cache. Files that don't exist yet are
    // skipped via a HEAD check.
    document.querySelectorAll('.model-toggle-btn[data-model]').forEach(btn => {
        referencedUrls.add(btn.getAttribute('data-model'));
    });
    document.querySelectorAll('model-viewer[src]').forEach(mv => {
        mv.setAttribute('loading', 'eager');
        referencedUrls.add(mv.getAttribute('src'));
    });
    if (referencedUrls.size < 2) return;
    // Warm the per-block default models through the shared warmer; an
    // opened dropdown's sweep walk supersedes (cancels) this initial pass.
    customElements.whenDefined('model-viewer').then(() => {
        warmModels([...referencedUrls]);
    });
})();

// Force matte material on all model-viewer instances so lighting is purely
// diffuse (avoids one-side-blown-out highlights on white meshes). Materials
// named overlay-* keep their baked color and alpha; the socket-lattice
// block manages those (toggles and sphere color).
document.querySelectorAll('model-viewer').forEach(mv => {
    const applyMatte = () => {
        if (!mv.model) return;
        mv.model.materials.forEach(material => {
            try {
                const pbr = material.pbrMetallicRoughness;
                pbr.setRoughnessFactor(1.0);
                pbr.setMetallicFactor(0.0);
                if (!material.name || material.name.indexOf('overlay-') !== 0) {
                    pbr.setBaseColorFactor([0.9, 0.9, 0.9, 1.0]);
                }
            } catch (e) {}
        });
    };
    mv.addEventListener('load', applyMatte);
});

// ---- Home page hero: model switcher + camera positioner ----
// The hero shows one model at a time from HERO_MODELS. Adding a model is one
// entry here and nothing else: the buttons are generated, each file is
// HEAD-checked so an entry whose GLB is not committed yet simply does not
// appear, and per-model camera framing lives in HERO_VIEWS.
//
// Capture those views by opening index.html?dev=1, orbiting each model into
// place, and pasting the generated block over HERO_VIEWS below. A model with
// no entry there just uses model-viewer's automatic framing.
(() => {
    const viewer = document.getElementById('hero-viewer');
    const bar = document.getElementById('hero-toggle');
    if (!viewer || !bar) return;

    const HERO_MODELS = [
        { label: 'Finished prosthetic', file: 'billie-full-prosthetic.glb',
          alt: 'A finished 3D-printed prosthetic leg for a dog' },
        { label: 'Generated socket', file: 'ollie-progress.glb',
          alt: 'A socket generated around a scan of a residual limb' },
        { label: 'Paw lattice', file: 'ntop-paw-unitcell-hex.glb',
          alt: 'A honeycomb lattice paw that cushions each step' },
        { label: 'Socket lattice', file: 'ntop-chi-maxthick-08.glb',
          alt: 'A lattice socket generated from a Chihuahua scan' },
    ];

    // Paste captured views here (index.html?dev=1 generates the block).
    const HERO_VIEWS = {
    };

    const deg = r => r * 180 / Math.PI;

    // model-viewer re-reads the camera attributes on every model load, so a
    // view is applied by writing the attributes. Rewriting an attribute with
    // an identical value is a no-op in LitElement, hence clear-then-set
    // across two ticks (the same fix the socket-creation viewers need).
    function applyView(file) {
        const v = HERO_VIEWS[file];
        ['camera-orbit', 'camera-target', 'field-of-view'].forEach(
            a => viewer.removeAttribute(a));
        if (!v) return;
        // Deliberately setTimeout and not requestAnimationFrame: rAF does not
        // fire while the tab is in the background, which would leave the hero
        // on model-viewer's automatic framing instead of the captured view
        // for anyone who opens the page in a background tab.
        setTimeout(() => {
            // a later swap may have won the race
            if (viewer.getAttribute('src') !== file) return;
            if (v.orbit) viewer.setAttribute('camera-orbit', v.orbit);
            if (v.target) viewer.setAttribute('camera-target', v.target);
            if (v.fov) viewer.setAttribute('field-of-view', v.fov);
        }, 0);
    }

    // model-viewer re-frames the camera from scratch every time a model
    // finishes loading, so the view has to be re-asserted then, not only at
    // swap time.
    viewer.addEventListener('load',
        () => applyView(viewer.getAttribute('src')));

    function show(model, btn) {
        if (viewer.getAttribute('src') === model.file) return;
        viewer.setAttribute('src', model.file);
        viewer.setAttribute('alt', model.alt);
        applyView(model.file);
        [...bar.querySelectorAll('.hero-model-btn')].forEach(
            b => b.classList.toggle('active', b === btn));
    }

    const exists = url => fetch(url, { method: 'HEAD' })
        .then(r => r.ok).catch(() => false);

    Promise.all(HERO_MODELS.map(m => exists(m.file))).then(ok => {
        const available = HERO_MODELS.filter((m, i) => ok[i]);
        if (available.length < 2) return;   // nothing to switch between
        available.forEach((m, i) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'hero-model-btn' + (i === 0 ? ' active' : '');
            btn.textContent = m.label;
            btn.addEventListener('click', () => show(m, btn));
            bar.appendChild(btn);
        });
        bar.hidden = false;
        const first = available[0];
        if (viewer.getAttribute('src') !== first.file) {
            viewer.setAttribute('src', first.file);
            viewer.setAttribute('alt', first.alt);
        }
        applyView(first.file);
        if (new URLSearchParams(location.search).has('dev')) {
            buildDevPanel(available);
        }
    });

    // ---- ?dev=1 camera positioner ----
    function buildDevPanel(models) {
        viewer.removeAttribute('auto-rotate');
        const views = Object.assign({}, HERO_VIEWS);
        const panel = document.createElement('div');
        panel.className = 'hero-dev-panel';
        panel.innerHTML =
            '<p class="hero-dev-help"><strong>Hero camera positioner.</strong> ' +
            'Pick a model in the hero, then drag to orbit and scroll to zoom ' +
            'until it looks right. Press <em>Capture this view</em> for each ' +
            'model, then paste the block below over <code>HERO_VIEWS</code> in ' +
            '<code>script.js</code>. Auto-rotate is off here so the camera ' +
            'holds still; visitors still get it.</p>' +
            '<p class="hero-dev-actions">' +
              '<button type="button" class="quiz-next" data-capture>Capture this view</button> ' +
              '<button type="button" class="quiz-next" data-clear>Forget this model</button> ' +
              '<button type="button" class="quiz-next" data-spin>Preview auto-rotate</button>' +
            '</p>' +
            '<p class="hero-dev-status"></p>' +
            '<textarea class="quiz-dev-output" readonly spellcheck="false" rows="8"></textarea>' +
            '<button type="button" class="quiz-dev-copy" data-copy>Copy code</button>' +
            '<span class="quiz-dev-copied" hidden>Copied!</span>';
        document.querySelector('.hero').after(panel);
        const out = panel.querySelector('.quiz-dev-output');
        const status = panel.querySelector('.hero-dev-status');

        const serialize = () => {
            const lines = Object.keys(views).sort().map(f =>
                "        '" + f + "': { orbit: '" + views[f].orbit +
                "', target: '" + views[f].target +
                "', fov: '" + views[f].fov + "' },");
            out.value = '    const HERO_VIEWS = {\n' + lines.join('\n') +
                (lines.length ? '\n' : '') + '    };';
            const cur = viewer.getAttribute('src');
            const done = models.filter(m => views[m.file]).length;
            status.textContent = 'Showing ' + cur + ' - ' + done + ' of ' +
                models.length + ' models captured' +
                (views[cur] ? '' : ' (this one not captured yet)');
        };

        panel.querySelector('[data-capture]').addEventListener('click', () => {
            if (typeof viewer.getCameraOrbit !== 'function') return;
            // Prefer the controls' goal over the rendered camera: mid-ease the
            // rendered position lags where the user actually stopped dragging.
            // The same applies to zoom, and more sharply - getFieldOfView()
            // reports the FRAMING fov and never moves, while the fov the user
            // is actually looking at lives in the controls as a natural log.
            let o = viewer.getCameraOrbit();
            let fov = viewer.getFieldOfView();
            try {
                const sym = Object.getOwnPropertySymbols(viewer)
                    .find(x => String(x.description || '') === 'controls');
                const ctrls = sym && viewer[sym];
                if (ctrls && ctrls.goalSpherical) o = ctrls.goalSpherical;
                if (ctrls && typeof ctrls.goalLogFov === 'number') {
                    fov = Math.exp(ctrls.goalLogFov);
                }
            } catch (e) {}
            const t = viewer.getCameraTarget();
            views[viewer.getAttribute('src')] = {
                orbit: deg(o.theta).toFixed(1) + 'deg ' +
                    deg(o.phi).toFixed(1) + 'deg ' + o.radius.toFixed(1) + 'm',
                target: t.x.toFixed(1) + 'm ' + t.y.toFixed(1) + 'm ' +
                    t.z.toFixed(1) + 'm',
                fov: fov.toFixed(1) + 'deg',
            };
            serialize();
        });

        panel.querySelector('[data-clear]').addEventListener('click', () => {
            delete views[viewer.getAttribute('src')];
            serialize();
        });

        panel.querySelector('[data-spin]').addEventListener('click', e => {
            const on = viewer.hasAttribute('auto-rotate');
            if (on) viewer.removeAttribute('auto-rotate');
            else viewer.setAttribute('auto-rotate', '');
            e.target.textContent = on ? 'Preview auto-rotate' : 'Stop auto-rotate';
        });

        panel.querySelector('[data-copy]').addEventListener('click', () => {
            const note = panel.querySelector('.quiz-dev-copied');
            const flash = () => {
                note.hidden = false;
                setTimeout(() => { note.hidden = true; }, 1500);
            };
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(out.value).then(flash);
            } else {
                out.select();
                document.execCommand('copy');
                flash();
            }
        });

        bar.addEventListener('click', () => setTimeout(serialize, 0));
        serialize();
    }
})();
