// Shape editor for the anatomy quizzes: open any quiz page with ?dev=1.
// quiz-engine.js loads this file on demand (normal visitors never download
// it) and hands over its state. The editor edits window.QUIZ_CONFIG in place
// and writes it back out as a complete quiz-data-*.js file (Download data
// file), so building a quiz needs no hand-editing of code.
//
// Coordinates are percentages of the quiz image, exactly as the engine uses
// them. The image frame is zoomed with a CSS transform, so every percent
// computation below reads getBoundingClientRect(), which includes it.
window.QuizEditor = function (ctx) {
    'use strict';
    const { CONFIG, QUIZZES, app, imageEl, marker, tabs, smoothPath } = ctx;
    const SVGNS = 'http://www.w3.org/2000/svg';
    const frame = imageEl.parentElement;
    const viewport = frame.parentElement;
    const figure = viewport.parentElement;
    const overlay = document.getElementById('quiz-overlay');
    const devPolys = document.getElementById('quiz-dev-polys');
    const devMids = document.getElementById('quiz-dev-mids');
    const devVerts = document.getElementById('quiz-dev-verts');
    const devGuide = document.createElementNS(SVGNS, 'g');
    devGuide.id = 'quiz-dev-guide';
    overlay.insertBefore(devGuide, devMids);

    app.classList.add('dev');
    app.querySelector('.quiz-panel').hidden = true;
    marker.hidden = true;
    viewport.classList.add('quiz-zoomable');

    const round1 = n => Math.round(n * 10) / 10;
    const clamp = n => Math.min(99.5, Math.max(0.5, n));
    const hasShape = it => !!(it && it.points && it.points.length >= 3);
    // The builder parks new, unplaced items at x = 4 down the left edge.
    const isParked = it => !hasShape(it) && it.x === 4;

    // Touch screens (iPad) get bigger handles and wording for taps.
    const coarse = window.matchMedia('(any-pointer: coarse)').matches;
    const R = coarse ? 1.8 : 1;
    const tap = coarse ? 'Tap' : 'Click';
    const Cloud = window.AnatomyCloud || null;
    const PAGE = Cloud ? Cloud.pageId() : '';
    // Names deleted or renamed in the editor, so a cloud copy does not bring
    // them back from the data file (see anatomy-cloud.js applyTo).
    CONFIG.deleted = CONFIG.deleted || {};

    // ---------------------------------------------------------------- state
    const params = new URLSearchParams(location.search);
    let devKey = QUIZZES[params.get('quiz')] ? params.get('quiz')
        : (QUIZZES.bones ? 'bones' : Object.keys(QUIZZES)[0]);
    let selected = null, picked = null;
    let tracing = false, traceBackup = null, hoverPt = null;
    let zoom = 1, panX = 0, panY = 0, panMoved = false;
    const undoStack = [], redoStack = [];
    const markerEls = new Map();

    // Viewer conveniences only; the editor works the same without storage.
    const OPTS_KEY = 'quiz-editor-options';
    const opts = { others: true, labels: false, advance: true, studio: 'auto', floatRef: true };
    try { Object.assign(opts, JSON.parse(localStorage.getItem(OPTS_KEY)) || {}); } catch (e) {}
    const saveOpts = () => { try { localStorage.setItem(OPTS_KEY, JSON.stringify(opts)); } catch (e) {} };

    const items = () => QUIZZES[devKey].items;

    // ------------------------------------------------------------ side panel
    const side = document.createElement('aside');
    side.className = 'qe-side';
    side.setAttribute('aria-label', 'Shape editor');
    side.innerHTML =
        '<div class="qe-head"><strong>Shape editor</strong><span class="qe-progress"></span>' +
          '<button type="button" class="qe-btn qe-studio-on" data-act="studio-on" title="Fill the screen with the image and tools">Full screen</button>' +
          '<button type="button" class="qe-btn qe-icon qe-drawer-close" data-act="list" title="Close the list" aria-label="Close the list">&times;</button>' +
        '</div>' +
        '<div class="qe-cloud"></div>' +
        '<div class="qe-cloud-help" hidden></div>' +
        '<p class="qe-hint" aria-live="polite"></p>' +
        '<details class="qe-refbox" open><summary>Reference: where is it?</summary>' +
          '<button type="button" class="qe-ref" title="Click to enlarge">' +
            '<span class="qe-ref-frame"><img alt="Labelled reference drawing"><span class="qe-ref-pin" hidden></span></span>' +
          '</button>' +
          '<p class="qe-ref-desc"></p>' +
          '<p class="qe-ref-credit"></p>' +
        '</details>' +
        '<div class="qe-bar">' +
          '<button type="button" class="qe-btn qe-primary" data-act="trace">Trace <kbd>T</kbd></button>' +
          '<button type="button" class="qe-btn" data-act="finish">Finish <kbd>Enter</kbd></button>' +
          '<button type="button" class="qe-btn" data-act="undo-point" title="Remove the last point (Backspace)">Undo point</button>' +
          '<button type="button" class="qe-btn" data-act="cancel" title="Stop tracing and keep the old shape (Esc)">Cancel</button>' +
        '</div>' +
        '<div class="qe-bar">' +
          '<span class="qe-group">' +
            '<button type="button" class="qe-btn qe-icon" data-act="zoom-out" title="Zoom out (-)">&minus;</button>' +
            '<button type="button" class="qe-btn qe-zoomlabel" data-act="zoom-fit" title="Fit the whole image (0)">100%</button>' +
            '<button type="button" class="qe-btn qe-icon" data-act="zoom-in" title="Zoom in (+)">+</button>' +
          '</span>' +
          '<span class="qe-group">' +
            '<button type="button" class="qe-btn" data-act="undo" title="Undo (Ctrl+Z)">Undo</button>' +
            '<button type="button" class="qe-btn" data-act="redo" title="Redo (Ctrl+Y)">Redo</button>' +
          '</span>' +
        '</div>' +
        '<div class="qe-toggles">' +
          '<label><input type="checkbox" data-opt="others"> Show other shapes</label>' +
          '<label><input type="checkbox" data-opt="labels"> Show all labels</label>' +
          '<label><input type="checkbox" data-opt="advance"> After finishing, trace the next untraced item</label>' +
        '</div>' +
        '<ol class="qe-list"></ol>' +
        '<section class="qe-selected" hidden>' +
          '<label class="qe-field">Name <input type="text" class="qe-selname" spellcheck="false"></label>' +
          '<p class="qe-selmeta"></p>' +
          '<p class="qe-desc"></p>' +
          '<label class="qe-smooth">Smoothing <input type="range" min="0" max="100" step="5"><output></output></label>' +
          '<div class="qe-bar">' +
            '<button type="button" class="qe-btn" data-act="center" title="Move the quiz marker to the middle of the shape">Re-center marker</button>' +
            '<button type="button" class="qe-btn" data-act="del-point" title="Delete the point you last touched (Alt-click a point also works)">Delete point</button>' +
            '<button type="button" class="qe-btn" data-act="clear">Clear shape</button>' +
            '<button type="button" class="qe-btn qe-danger" data-act="delete">Delete item</button>' +
          '</div>' +
        '</section>' +
        '<div class="qe-add">' +
          '<input type="text" class="qe-newname" placeholder="New item name" aria-label="New item name">' +
          '<button type="button" class="qe-btn" data-act="add">Add</button>' +
        '</div>' +
        '<details class="qe-more"><summary>Add a list of items</summary>' +
          '<textarea class="qe-bulk" rows="5" placeholder="One name per line"></textarea>' +
          '<button type="button" class="qe-btn" data-act="add-list">Add all</button>' +
        '</details>' +
        '<div class="qe-save">' +
          '<p class="qe-draft"></p>' +
          '<button type="button" class="qe-btn" data-act="download">Download data file</button>' +
        '</div>' +
        '<details class="qe-more"><summary>Keyboard shortcuts</summary>' +
          '<dl class="qe-keys">' +
            '<dt>T</dt><dd>Trace the selected item (redraws an existing shape)</dd>' +
            '<dt>Click</dt><dd>Add a point while tracing; select a shape otherwise</dd>' +
            '<dt>Enter</dt><dd>Finish (or click the gold first point)</dd>' +
            '<dt>Backspace</dt><dd>Remove the last point while tracing</dd>' +
            '<dt>Esc</dt><dd>Cancel tracing, or deselect</dd>' +
            '<dt>Drag</dt><dd>Move a point or marker; drag empty image to pan</dd>' +
            '<dt>Blue dots</dt><dd>Drag one to add a point on that edge</dd>' +
            '<dt>Alt-click</dt><dd>Delete a point (or double-click it)</dd>' +
            '<dt>Wheel, + / -</dt><dd>Zoom; 0 fits the image</dd>' +
            '<dt>[ and ]</dt><dd>Previous / next item; N jumps to the next untraced one</dd>' +
            '<dt>L</dt><dd>Show or hide all labels</dd>' +
            '<dt>Ctrl+Z / Ctrl+Y</dt><dd>Undo / redo</dd>' +
          '</dl>' +
        '</details>' +
        '<details class="qe-more"><summary>Code for this set</summary>' +
          '<textarea class="qe-code" readonly spellcheck="false"></textarea>' +
          '<button type="button" class="qe-btn" data-act="copy">Copy</button>' +
        '</details>';
    app.appendChild(side);

    // Full-screen layout for tablets: a top bar (set, current item, save
    // status), the image in the middle, big buttons along the bottom, and
    // the item list as a drawer. Desktop keeps the two-column layout.
    const top = document.createElement('div');
    top.className = 'qe-top';
    top.innerHTML =
        '<a class="qe-btn qe-exit" href="anatomy-labelling.html" title="Back to the labelling hub">&lsaquo; Hub</a>' +
        '<select class="qe-setpick" aria-label="Quiz set"></select>' +
        '<button type="button" class="qe-now" data-act="list" title="Show the item list">' +
          '<span class="qe-dot" aria-hidden="true"></span><span class="qe-now-name"></span><span class="qe-progress"></span>' +
        '</button>' +
        '<div class="qe-cloud qe-cloud-chip"></div>' +
        '<button type="button" class="qe-btn qe-studio-off" data-act="studio-off" title="Back to the normal page layout">Exit full screen</button>';
    const dock = document.createElement('div');
    dock.className = 'qe-dock';
    dock.innerHTML =
        '<button type="button" class="qe-btn qe-list-btn" data-act="list">&#9776; List</button>' +
        '<span class="qe-group">' +
          '<button type="button" class="qe-btn qe-icon" data-act="prev" title="Previous item" aria-label="Previous item">&lsaquo;</button>' +
          '<button type="button" class="qe-btn qe-icon" data-act="next" title="Next item to trace" aria-label="Next item to trace">&rsaquo;</button>' +
        '</span>' +
        '<span class="qe-group">' +
          '<button type="button" class="qe-btn qe-primary" data-act="trace">Trace</button>' +
          '<button type="button" class="qe-btn" data-act="undo-point">Undo point</button>' +
          '<button type="button" class="qe-btn qe-go" data-act="finish">Finish</button>' +
          '<button type="button" class="qe-btn" data-act="cancel">Cancel</button>' +
          '<button type="button" class="qe-btn" data-act="del-point">Delete point</button>' +
        '</span>' +
        '<span class="qe-group">' +
          '<button type="button" class="qe-btn qe-icon" data-act="zoom-out" aria-label="Zoom out">&minus;</button>' +
          '<button type="button" class="qe-btn qe-zoomlabel" data-act="zoom-fit" title="Fit the whole image">100%</button>' +
          '<button type="button" class="qe-btn qe-icon" data-act="zoom-in" aria-label="Zoom in">+</button>' +
        '</span>' +
        '<span class="qe-group">' +
          '<button type="button" class="qe-btn" data-act="undo">Undo</button>' +
          '<button type="button" class="qe-btn" data-act="redo">Redo</button>' +
          '<button type="button" class="qe-btn" data-act="ref-toggle" title="Show or hide the labelled reference">Reference</button>' +
        '</span>';
    app.prepend(top);
    app.appendChild(dock);
    // Labelled reference floating over the image corner (full screen only).
    const floatRef = document.createElement('button');
    floatRef.type = 'button';
    floatRef.className = 'qe-float-ref';
    floatRef.title = 'Labelled reference: tap to enlarge';
    floatRef.innerHTML = '<span class="qe-ref-frame"><img alt="Labelled reference drawing"><span class="qe-ref-pin" hidden></span></span>';
    figure.appendChild(floatRef);

    const $ = sel => side.querySelector(sel);
    const $$ = sel => app.querySelectorAll(sel);
    const setDisabled = (act, off) => $$('[data-act="' + act + '"]').forEach(b => { b.disabled = off; });

    // A banner over the image, so the current task is visible where the
    // eyes are while tracing.
    const banner = document.createElement('div');
    banner.className = 'qe-banner';
    banner.hidden = true;
    figure.appendChild(banner);

    side.querySelectorAll('[data-opt]').forEach(box => {
        box.checked = !!opts[box.dataset.opt];
        box.addEventListener('change', () => {
            opts[box.dataset.opt] = box.checked;
            saveOpts();
            frame.classList.toggle('qe-all-labels', opts.labels);
            drawPaths();
        });
    });

    // ------------------------------------------------------- outline maths
    // Same Catmull-Rom sampling as the engine's hit test, so what the editor
    // measures is what the quiz will click-test.
    function sample(pts, smooth) {
        const s = Math.max(0, Math.min(1, smooth == null ? 0.6 : smooth)) / 6 * 4;
        const n = pts.length, at = i => pts[(i + n) % n], out = [];
        for (let i = 0; i < n; i++) {
            const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
            const c1x = p1[0] + (p2[0] - p0[0]) * s / 4, c1y = p1[1] + (p2[1] - p0[1]) * s / 4;
            const c2x = p2[0] - (p3[0] - p1[0]) * s / 4, c2y = p2[1] - (p3[1] - p1[1]) * s / 4;
            for (let k = 0; k < 8; k++) {
                const u = k / 8, v = 1 - u;
                out.push([
                    v * v * v * p1[0] + 3 * v * v * u * c1x + 3 * v * u * u * c2x + u * u * u * p2[0],
                    v * v * v * p1[1] + 3 * v * v * u * c1y + 3 * v * u * u * c2y + u * u * u * p2[1],
                ]);
            }
        }
        return out;
    }
    function inside(o, x, y) {
        let hit = false;
        for (let i = 0, j = o.length - 1; i < o.length; j = i++) {
            const [xi, yi] = o[i], [xj, yj] = o[j];
            if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) hit = !hit;
        }
        return hit;
    }
    function area(o) {
        let a = 0;
        for (let i = 0, j = o.length - 1; i < o.length; j = i++) a += (o[j][0] + o[i][0]) * (o[j][1] - o[i][1]);
        return Math.abs(a / 2);
    }
    const aspect = () => (imageEl.naturalWidth && imageEl.naturalHeight)
        ? imageEl.naturalWidth / imageEl.naturalHeight : 1;
    function edgeDist(o, x, y, a) {
        let best = Infinity;
        for (let i = 0, j = o.length - 1; i < o.length; j = i++) {
            const ax = o[j][0] * a, ay = o[j][1], bx = o[i][0] * a, by = o[i][1];
            const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
            const px = x * a, py = y;
            const t = L ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L)) : 0;
            best = Math.min(best, Math.hypot(px - ax - t * dx, py - ay - t * dy));
        }
        return best;
    }

    // Put the quiz marker (the matching-mode pin) at the point of the shape
    // farthest from any edge that still resolves to this item - i.e. not
    // inside a smaller sibling, which the engine's smallest-area-wins hit
    // test would give to the sibling instead.
    function placeMarker(it, list) {
        if (!hasShape(it)) return;
        const a = aspect();
        const own = sample(it.points, it.smooth), ownA = area(own);
        const rivals = (list || items()).filter(o => o !== it && hasShape(o))
            .map(o => sample(o.points, o.smooth)).filter(o => area(o) < ownA);
        const xs = own.map(p => p[0]), ys = own.map(p => p[1]);
        const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
        const N = 40;
        let best = null, bd = -1;
        for (let i = 0; i <= N; i++) {
            for (let j = 0; j <= N; j++) {
                const x = x0 + (x1 - x0) * i / N, y = y0 + (y1 - y0) * j / N;
                if (!inside(own, x, y) || rivals.some(o => inside(o, x, y))) continue;
                let d = edgeDist(own, x, y, a);
                rivals.forEach(o => { d = Math.min(d, edgeDist(o, x, y, a)); });
                if (d > bd) { bd = d; best = [x, y]; }
            }
        }
        if (!best) best = [xs.reduce((s, v) => s + v, 0) / xs.length, ys.reduce((s, v) => s + v, 0) / ys.length];
        it.x = round1(best[0]);
        it.y = round1(best[1]);
    }

    function hitTest(x, y) {
        let best = null, ba = Infinity;
        items().forEach(it => {
            if (!hasShape(it)) return;
            const o = sample(it.points, it.smooth);
            if (inside(o, x, y)) {
                const a = area(o);
                if (a < ba) { best = it; ba = a; }
            }
        });
        return best;
    }

    // ------------------------------------------------------------ geometry
    const frameRect = () => frame.getBoundingClientRect();
    function toPct(ev) {
        const r = frameRect();
        return [clamp((ev.clientX - r.left) / r.width * 100), clamp((ev.clientY - r.top) / r.height * 100)];
    }
    // Screen-pixel sizes expressed in the overlay's stretched 0-100 space,
    // so handles stay the same size on screen at any zoom and image shape.
    function pxScale() {
        const r = frameRect();
        return { kx: r.width ? 100 / r.width : 0.2, ky: r.height ? 100 / r.height : 0.2 };
    }
    function nearFirst(ev) {
        if (!tracing || !selected || selected.points.length < 3) return false;
        const r = frameRect(), p = selected.points[0];
        return Math.hypot(ev.clientX - (r.left + p[0] / 100 * r.width),
                          ev.clientY - (r.top + p[1] / 100 * r.height)) < 12 * R;
    }

    // ------------------------------------------------------------ drawing
    function addPath(d, cls) {
        const el = document.createElementNS(SVGNS, 'path');
        el.setAttribute('d', d);
        el.setAttribute('class', cls);
        devPolys.appendChild(el);
    }
    const openPath = pts => 'M ' + pts.map(p => p[0] + ' ' + p[1]).join(' L ');

    function drawPaths() {
        devPolys.innerHTML = '';
        // selected item last, so it draws on top
        const order = items().filter(it => it !== selected);
        if (selected) order.push(selected);
        order.forEach(it => {
            const pts = it.points;
            if (!pts || !pts.length) return;
            const sel = it === selected;
            if (!sel && !opts.others) return;
            if (sel && tracing) {
                if (pts.length >= 3) addPath(smoothPath(pts, it.smooth), 'qe-preview');
                if (pts.length >= 2) {
                    addPath(openPath(pts), 'qe-halo selected');
                    addPath(openPath(pts), 'qe-shape selected qe-open');
                }
                return;
            }
            if (pts.length < 3) return;
            const d = smoothPath(pts, it.smooth);
            addPath(d, 'qe-halo' + (sel ? ' selected' : ''));
            addPath(d, 'qe-shape' + (sel ? ' selected' : ''));
        });
    }

    function drawHandles() {
        devVerts.innerHTML = '';
        devMids.innerHTML = '';
        if (!selected || !selected.points || !selected.points.length) return;
        const { kx, ky } = pxScale();
        const pts = selected.points;
        const dot = (g, x, y, r, cls) => {
            const e = document.createElementNS(SVGNS, 'ellipse');
            e.setAttribute('cx', x);
            e.setAttribute('cy', y);
            e.setAttribute('rx', r * kx);
            e.setAttribute('ry', r * ky);
            if (cls) e.setAttribute('class', cls);
            g.appendChild(e);
            return e;
        };
        if (!tracing && pts.length >= 3) {
            pts.forEach((p, i) => {
                const q = pts[(i + 1) % pts.length];
                const m = dot(devMids, (p[0] + q[0]) / 2, (p[1] + q[1]) / 2, 4.5 * R);
                m.addEventListener('pointerdown', ev => {
                    ev.preventDefault();
                    ev.stopPropagation();
                    pushUndo();
                    pts.splice(i + 1, 0, [round1((p[0] + q[0]) / 2), round1((p[1] + q[1]) / 2)]);
                    drawPaths();
                    drawHandles();
                    startVertexDrag(ev, i + 1, true);
                });
            });
        }
        pts.forEach((p, i) => {
            const first = tracing && i === 0 && pts.length >= 3;
            const v = dot(devVerts, p[0], p[1], (first ? 8 : 6) * R, first ? 'first' : (i === picked ? 'picked' : ''));
            if (tracing) return;
            v.addEventListener('pointerdown', ev => {
                ev.preventDefault();
                ev.stopPropagation();
                if (ev.altKey) { deletePoint(i); return; }
                // the last point touched is the one "Delete point" removes
                picked = i;
                devVerts.querySelectorAll('.picked').forEach(e => e.classList.remove('picked'));
                v.classList.add('picked');
                renderTools();
                startVertexDrag(ev, i, false);
            });
            v.addEventListener('dblclick', ev => {
                ev.preventDefault();
                ev.stopPropagation();
                deletePoint(i);
            });
        });
    }

    function drawGuide() {
        devGuide.innerHTML = '';
        if (!tracing || !selected || !hoverPt || !selected.points.length) return;
        const pts = selected.points;
        const line = (a, b, cls) => {
            const l = document.createElementNS(SVGNS, 'line');
            l.setAttribute('x1', a[0]); l.setAttribute('y1', a[1]);
            l.setAttribute('x2', b[0]); l.setAttribute('y2', b[1]);
            l.setAttribute('class', cls);
            devGuide.appendChild(l);
        };
        line(pts[pts.length - 1], hoverPt, 'qe-rubber');
        if (pts.length >= 2) line(hoverPt, pts[0], 'qe-close');
    }

    function makeMarker(it) {
        const el = document.createElement('span');
        el.className = 'quiz-marker dev-marker';
        el.title = it.name;
        const label = document.createElement('span');
        label.className = 'dev-marker-label';
        label.textContent = it.name;
        const resize = document.createElement('span');
        resize.className = 'dev-handle dev-resize';
        resize.title = 'Drag to resize';
        const rotate = document.createElement('span');
        rotate.className = 'dev-handle dev-rotate';
        rotate.title = 'Drag to rotate';
        el.append(label, resize, rotate);

        const place = () => {
            el.style.left = it.x + '%';
            el.style.top = it.y + '%';
            el.style.width = it.w ? it.w + '%' : '';
            el.style.height = it.h ? it.h + '%' : '';
            el.style.setProperty('--marker-rot', (it.rot || 0) + 'deg');
            el.classList.toggle('qe-dot', !it.w);
        };
        const status = () => {
            el.classList.toggle('selected', it === selected);
            el.classList.toggle('qe-traced', hasShape(it));
            el.classList.toggle('qe-parked', isParked(it));
            el.style.display = hasShape(it) || isParked(it) ? 'none' : '';
        };
        place();
        status();
        el._qeStatus = status;

        const center = r => [r.left + it.x / 100 * r.width, r.top + it.y / 100 * r.height];
        const drag = (target, move) => {
            target.addEventListener('pointerdown', e => {
                if (tracing) return;
                if (target === el && e.target !== el && e.target !== label) return;
                e.preventDefault();
                e.stopPropagation();
                if (selected !== it) select(it);
                const r = frameRect();
                let moved = false;
                try { target.setPointerCapture(e.pointerId); } catch (err) {}
                const onMove = ev => {
                    if (!moved) { moved = true; pushUndo(); }
                    move(ev, r);
                    place();
                };
                const onUp = () => {
                    target.removeEventListener('pointermove', onMove);
                    target.removeEventListener('pointerup', onUp);
                    target.removeEventListener('pointercancel', onUp);
                    if (moved) changed({ markers: false });
                };
                target.addEventListener('pointermove', onMove);
                target.addEventListener('pointerup', onUp);
                target.addEventListener('pointercancel', onUp);
            });
        };
        drag(el, (ev, r) => {
            it.x = round1(clamp((ev.clientX - r.left) / r.width * 100));
            it.y = round1(clamp((ev.clientY - r.top) / r.height * 100));
        });
        // Resize and rotate only matter for marker-only items (joint sets):
        // an item with a traced shape is drawn as its shape in the quiz.
        drag(resize, (ev, r) => {
            const [cx, cy] = center(r);
            const rad = -(it.rot || 0) * Math.PI / 180;
            const dx = ev.clientX - cx, dy = ev.clientY - cy;
            const lx = dx * Math.cos(rad) - dy * Math.sin(rad);
            const ly = dx * Math.sin(rad) + dy * Math.cos(rad);
            it.w = round1(Math.min(90, Math.max(1, Math.abs(lx) * 2 / r.width * 100)));
            it.h = round1(Math.min(90, Math.max(1, Math.abs(ly) * 2 / r.height * 100)));
        });
        drag(rotate, (ev, r) => {
            const [cx, cy] = center(r);
            const ang = Math.atan2(ev.clientY - cy, ev.clientX - cx) * 180 / Math.PI + 90;
            it.rot = Math.round(((ang % 360) + 540) % 360 - 180);
            if (it.rot === -180) it.rot = 180;
        });
        el.addEventListener('dblclick', () => {
            if (!it.w && !it.rot) return;
            pushUndo();
            delete it.w; delete it.h; delete it.rot;
            place();
            changed({ markers: false });
        });
        return el;
    }

    function renderMarkers() {
        markerEls.forEach(el => el.remove());
        markerEls.clear();
        items().forEach(it => {
            const el = makeMarker(it);
            markerEls.set(it, el);
            frame.appendChild(el);
        });
    }
    const refreshMarkerStatus = () => markerEls.forEach(el => el._qeStatus());

    // --------------------------------------------------------- side panel
    const statusOf = it => hasShape(it) ? 'traced' : (isParked(it) ? 'parked' : 'placed');
    const STATUS_TEXT = { traced: 'traced', parked: 'not placed', placed: 'marker only' };

    function renderList() {
        const list = $('.qe-list');
        const its = items();
        const done = its.filter(hasShape).length;
        $$('.qe-progress').forEach(el => { el.textContent = done + ' / ' + its.length + ' traced'; });
        list.innerHTML = '';
        its.forEach(it => {
            const li = document.createElement('li');
            const b = document.createElement('button');
            b.type = 'button';
            const st = statusOf(it);
            b.className = 'qe-row qe-' + st;
            b.innerHTML = '<span class="qe-dot" aria-hidden="true"></span><span class="qe-name"></span><span class="qe-meta"></span>';
            b.querySelector('.qe-name').textContent = it.name;
            b.querySelector('.qe-meta').textContent = st === 'traced' ? it.points.length + ' pts' : STATUS_TEXT[st];
            b.title = coarse ? 'Tap to select' : 'Click to select, double-click to trace';
            b._qeItem = it;
            b.addEventListener('click', () => {
                select(it, { reveal: true });
                // on a narrow screen the drawer covers the image: get out of the way
                if (studio && !wideStudio()) setDrawer(false);
            });
            b.addEventListener('dblclick', () => { select(it); startTrace(); });
            // hover preview is for mice only; a tap would leave it stuck on
            b.addEventListener('pointerenter', e => { if (e.pointerType === 'mouse') { previewItem = it; renderReference(); } });
            b.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') { previewItem = null; renderReference(); } });
            li.appendChild(b);
            list.appendChild(li);
        });
        syncListSelection();
    }
    function syncListSelection() {
        let sel = null;
        side.querySelectorAll('.qe-row').forEach(b => {
            const on = b._qeItem === selected;
            b.classList.toggle('qe-sel', on);
            b.setAttribute('aria-current', on ? 'true' : 'false');
            if (on) sel = b;
        });
        if (sel) {
            // keep the row visible inside the scrolling panel only
            const list = $('.qe-list');
            const top = sel.offsetTop - list.offsetTop, bottom = top + sel.offsetHeight;
            if (top < list.scrollTop) list.scrollTop = top;
            else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
        }
    }

    function renderSelected() {
        const box = $('.qe-selected');
        box.hidden = !selected;
        if (!selected) return;
        const nameInput = $('.qe-selname');
        if (document.activeElement !== nameInput) nameInput.value = selected.name;
        const n = selected.points ? selected.points.length : 0;
        $('.qe-selmeta').textContent = tracing ? 'Tracing: ' + n + ' point' + (n === 1 ? '' : 's') + ' so far'
            : hasShape(selected) ? n + ' points'
            : isParked(selected) ? 'Not placed yet - trace it, or drag its marker from the left edge'
            : 'Marker only, no shape';
        const slider = $('.qe-smooth input');
        const on = hasShape(selected);
        slider.disabled = !on;
        const v = Math.round((selected.smooth == null ? 0.6 : selected.smooth) * 100);
        slider.value = v;
        $('.qe-smooth output').textContent = v;
    }

    function renderTools() {
        const n = selected && selected.points ? selected.points.length : 0;
        $$('[data-act="trace"]').forEach(b => {
            b.disabled = !selected || tracing;
            b.firstChild.textContent = hasShape(selected) && !tracing ? 'Redraw' + (b.children.length ? ' ' : '') : 'Trace' + (b.children.length ? ' ' : '');
        });
        if (picked != null && !(selected && selected.points && picked < selected.points.length)) picked = null;
        setDisabled('finish', !tracing || n < 3);
        setDisabled('undo-point', !tracing || n < 1);
        setDisabled('cancel', !tracing);
        setDisabled('del-point', tracing || picked == null || n <= 3);
        setDisabled('undo', !undoStack.length || tracing);
        setDisabled('redo', !redoStack.length || tracing);
        setDisabled('center', !hasShape(selected) || tracing);
        setDisabled('clear', !hasShape(selected) || tracing);
        setDisabled('delete', !selected || tracing);
        $$('.qe-zoomlabel').forEach(el => { el.textContent = Math.round(zoom * 100) + '%'; });
        // the dock shows only the buttons that make sense right now
        dock.classList.toggle('qe-is-tracing', tracing);
        dock.classList.toggle('qe-has-shape', hasShape(selected));
        floatRef.hidden = !opts.floatRef || !QUIZZES[devKey].reference;
        $$('[data-act="ref-toggle"]').forEach(b => b.classList.toggle('qe-on', !!opts.floatRef));
    }

    function renderHint() {
        let hint;
        if (tracing) {
            const n = selected.points.length;
            hint = n === 0 ? tap + ' on the edge of ' + selected.name + ' to place the first point.'
                : n < 3 ? 'Keep ' + (coarse ? 'tapping' : 'clicking') + ' along the edge (' + n + ' point' + (n === 1 ? '' : 's') + ').'
                : coarse ? 'Keep tapping along the edge. Tap the gold first point or Finish when it goes all the way round.'
                : 'Keep clicking along the edge. Enter or click the gold first point to finish; Backspace removes the last point; Esc cancels.';
            banner.hidden = false;
            banner.textContent = 'Tracing ' + selected.name + ' · ' + n + ' pts' +
                (n >= 3 ? (coarse ? ' · tap the gold point to finish' : ' · Enter to finish') : '');
        } else {
            banner.hidden = true;
            hint = !selected ? (coarse ? 'Pick an item from the List (or tap a shape on the image), then tap Trace.'
                    : 'Pick an item from the list below (or click a shape on the image). Press T to trace it.')
                : hasShape(selected) ? (coarse ? 'Drag points to adjust; drag a blue dot to add a point. Touch a point, then Delete point to remove it. Redraw starts over.'
                    : 'Drag points to adjust. Drag a blue dot to add a point; Alt-click or double-click a point to delete it. T redraws from scratch.')
                : coarse ? 'Tap Trace, then tap around the edge of ' + selected.name + '.'
                : 'Press T (or double-click it in the list), then click around the edge of ' + selected.name + '.';
        }
        $('.qe-hint').textContent = hint;
        // current item in the full-screen top bar
        const now = top.querySelector('.qe-now');
        now.className = 'qe-now' + (selected ? ' qe-' + statusOf(selected) : '');
        top.querySelector('.qe-now-name').textContent = selected ? selected.name : 'Choose an item';
    }

    let flashTimer = 0;
    function flash(msg) {
        const el = $('.qe-hint');
        el.textContent = msg;
        el.classList.add('qe-flash');
        clearTimeout(flashTimer);
        flashTimer = setTimeout(() => { el.classList.remove('qe-flash'); renderHint(); }, 3500);
    }

    // ---------------------------------------------------------- reference
    // A labelled plate beside the tools, with a pin on the selected (or
    // hovered) item, so each landmark can be found before it is traced.
    const descriptions = CONFIG.descriptions || {};
    const refBox = $('.qe-refbox');
    const refImg = $('.qe-ref img');
    const refPin = $('.qe-ref-pin');
    const floatImg = floatRef.querySelector('img');
    const floatPin = floatRef.querySelector('.qe-ref-pin');
    let previewItem = null;

    const lightbox = document.createElement('div');
    lightbox.className = 'qe-lightbox';
    lightbox.hidden = true;
    lightbox.innerHTML = '<figure><span class="qe-ref-frame"><img alt=""><span class="qe-ref-pin" hidden></span></span>' +
        '<figcaption></figcaption></figure>';
    document.body.appendChild(lightbox);
    lightbox.addEventListener('click', () => { lightbox.hidden = true; });

    function pinFor(it) {
        const ref = QUIZZES[devKey].reference;
        return (it && ref && ref.points && ref.points[it.name]) || null;
    }
    function placePin(pin, it) {
        const pt = pinFor(it);
        pin.hidden = !pt;
        if (pt) { pin.style.left = pt[0] + '%'; pin.style.top = pt[1] + '%'; }
    }
    function describe(el, it) {
        el.innerHTML = '';
        const b = document.createElement('strong');
        b.textContent = it.name;
        el.append(b, document.createTextNode(descriptions[it.name] ? ': ' + descriptions[it.name] : ''));
    }
    function renderReference() {
        const ref = QUIZZES[devKey].reference;
        refBox.hidden = !ref;
        const shown = previewItem || selected;
        if (ref) {
            if (refImg.getAttribute('src') !== ref.image) refImg.setAttribute('src', ref.image);
            if (floatImg.getAttribute('src') !== ref.image) floatImg.setAttribute('src', ref.image);
            $('.qe-ref-credit').textContent = ref.caption || '';
            placePin(refPin, shown);
            placePin(floatPin, shown);
            const d = $('.qe-ref-desc');
            if (shown) {
                describe(d, shown);
                if (ref.points && !pinFor(shown)) d.append(document.createTextNode(' (not marked on this plate)'));
                if (!ref.points) d.append(document.createTextNode(' Find its label on the figure above; ' + tap.toLowerCase() + ' it to enlarge.'));
            } else {
                d.textContent = 'Select an item (or hover one in the list) to see where it is.';
            }
        }
        // Without a plate, the description still helps in the selected card.
        $('.qe-desc').textContent = (!ref && selected && descriptions[selected.name]) || '';
        if (!lightbox.hidden) renderLightbox();
    }
    function renderLightbox() {
        const ref = QUIZZES[devKey].reference;
        if (!ref) { lightbox.hidden = true; return; }
        const img = lightbox.querySelector('img');
        if (img.getAttribute('src') !== ref.image) img.setAttribute('src', ref.image);
        placePin(lightbox.querySelector('.qe-ref-pin'), selected);
        // Fit the plate to the window whatever its shape, enlarging small
        // plates as well as shrinking big ones.
        const fit = () => {
            const w = img.naturalWidth, h = img.naturalHeight;
            if (!w || !h) return;
            const k = Math.min((window.innerWidth - 80) / w, (window.innerHeight - 170) / h, 3);
            img.style.width = Math.round(w * k) + 'px';
            img.style.height = Math.round(h * k) + 'px';
        };
        if (img.complete) fit(); else img.onload = fit;
        const cap = lightbox.querySelector('figcaption');
        if (selected) describe(cap, selected); else cap.textContent = '';
        cap.append(document.createTextNode(' (' + tap.toLowerCase() + ' anywhere to close)'));
    }
    const openLightbox = () => {
        lightbox.hidden = false;
        renderLightbox();
    };
    $('.qe-ref').addEventListener('click', openLightbox);
    floatRef.addEventListener('click', openLightbox);
    // the corner reference must not start a pan or add a tracing point
    floatRef.addEventListener('pointerdown', e => e.stopPropagation());

    // ------------------------------------------------------------ output
    const q = s => "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
    function itemLine(it) {
        let s = '                { name: ' + q(it.name) + ', x: ' + (+it.x).toFixed(1) + ', y: ' + (+it.y).toFixed(1);
        if (hasShape(it)) {
            s += ', smooth: ' + (it.smooth == null ? 0.6 : it.smooth) +
                ', points: [' + it.points.map(p => '[' + p[0] + ', ' + p[1] + ']').join(', ') + ']';
        } else {
            if (it.w && it.h) s += ', w: ' + (+it.w).toFixed(1) + ', h: ' + (+it.h).toFixed(1);
            if (it.rot) s += ', rot: ' + it.rot;
        }
        return s + ' },';
    }
    function renderCode() {
        $('.qe-code').value = "            // '" + devKey + "' items\n            items: [\n" +
            items().map(itemLine).join('\n') + '\n            ],';
    }
    function serializeConfig() {
        const lines = [
            '// Generated by the ?dev=1 quiz editor on ' + new Date().toISOString().slice(0, 10) + '.',
            'window.QUIZ_CONFIG = {',
            '    appId: ' + q(CONFIG.appId) + ',',
            // newer than any cloud copy saved so far, so the site plays this file
            '    savedAt: ' + Date.now() + ',',
        ];
        const aliases = CONFIG.aliases || {};
        const akeys = Object.keys(aliases);
        if (akeys.length) {
            lines.push('    aliases: {');
            akeys.forEach(k => lines.push('        ' + q(k) + ': [' + aliases[k].map(q).join(', ') + '],'));
            lines.push('    },');
        }
        const dkeys = Object.keys(CONFIG.descriptions || {});
        if (dkeys.length) {
            lines.push('    descriptions: {');
            dkeys.forEach(k => lines.push('        ' + q(k) + ': ' + q(CONFIG.descriptions[k]) + ','));
            lines.push('    },');
        }
        const gone = Object.keys(CONFIG.deleted || {}).filter(k => CONFIG.deleted[k].length);
        if (gone.length) {
            lines.push('    deleted: {');
            gone.forEach(k => lines.push('        ' + q(k) + ': [' + CONFIG.deleted[k].map(q).join(', ') + '],'));
            lines.push('    },');
        }
        lines.push('    quizzes: {');
        Object.keys(QUIZZES).forEach(key => {
            const cfg = QUIZZES[key];
            lines.push('        ' + q(key) + ': {');
            lines.push('            image: ' + q(cfg.image) + ', noun: ' + q(cfg.noun || 'part') + ',');
            if (cfg.reference) {
                const ref = cfg.reference;
                lines.push('            reference: {');
                lines.push('                image: ' + q(ref.image) + ',');
                if (ref.caption) lines.push('                caption: ' + q(ref.caption) + ',');
                if (ref.points) {
                    lines.push('                points: {');
                    Object.keys(ref.points).forEach(n => lines.push('                    ' + q(n) + ': [' +
                        ref.points[n][0] + ', ' + ref.points[n][1] + '],'));
                    lines.push('                },');
                }
                lines.push('            },');
            }
            lines.push('            items: [');
            cfg.items.forEach(it => lines.push(itemLine(it)));
            lines.push('            ],');
            lines.push('        },');
        });
        lines.push('    },', '};', '');
        return lines.join('\n');
    }

    // ------------------------------------------------ autosaved draft
    // Work survives a reload. A draft is only restored automatically when it
    // was made against the same data file the page has now; otherwise the
    // editor offers it instead of silently overriding newer data.
    const DRAFT_KEY = 'quiz-editor-draft:' + location.pathname;
    // An outline still being traced is saved as its previous shape, and
    // empty point lists are dropped, so a draft never holds half a trace.
    const snapshotAll = () => {
        const d = {};
        Object.keys(QUIZZES).forEach(k => {
            d[k] = QUIZZES[k].items.map(it => {
                let pts = it.points;
                if (tracing && it === selected) pts = traceBackup;
                if (pts === it.points && (!pts || pts.length)) return it;
                const c = Object.assign({}, it);
                if (pts && pts.length) c.points = pts; else delete c.points;
                return c;
            });
        });
        return JSON.stringify(d);
    };
    const hash = s => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return String(h >>> 0); };
    // "Shipped" = the last saved copy: the data file, the cloud copy when
    // that is newer, and after each cloud save the state just saved.
    let shippedJSON = snapshotAll();
    let shippedHash = hash(shippedJSON);
    let saveTimer = 0;
    const draftNote = html => { $('.qe-draft').innerHTML = html; };
    const timeText = t => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

    function saveDraft() {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(writeDraft, 300);
    }
    function writeDraft() {
        clearTimeout(saveTimer);
        saveTimer = 0;
        try {
            const now = snapshotAll();
            if (now === shippedJSON) {
                localStorage.removeItem(DRAFT_KEY);
                draftNote('No unsaved changes.');
                return;
            }
            localStorage.setItem(DRAFT_KEY, JSON.stringify({ savedAt: Date.now(), base: shippedHash, quizzes: JSON.parse(now) }));
            draftNote((cloudCanSave() ? 'Also kept on this device' : 'Autosaved on this device') + ' at ' + timeText(Date.now()) +
                '. <button type="button" class="qe-link" data-act="discard">Discard changes</button>');
        } catch (e) {
            draftNote(cloudCanSave() ? '' : 'Autosave is not available in this browser, so download the data file often.');
        }
    }

    // ------------------------------------------------------- cloud save
    // Signed in with an editor account, every change is saved to the cloud
    // a moment after it is made (anatomy-cloud.js), and the quiz pages play
    // the cloud copy. The save is refused if another device saved since this
    // page loaded, so an iPad and a laptop cannot overwrite each other.
    const cloud = {
        user: null, editor: false, ready: !Cloud, status: 'idle', msg: '',
        // cloud savedAt this page's data is based on (null: none / unknown)
        at: CONFIG.cloud ? CONFIG.cloud.savedAt : null,
        reachable: !!(Cloud && CONFIG.cloud),
        remoteAt: null, lastAt: null, own: new Set(),
    };
    let cloudTimer = 0, cloudBusy = false;
    function cloudCanSave() { return !!(Cloud && cloud.user && cloud.editor); }
    const unsaved = () => snapshotAll() !== shippedJSON;

    function cloudPayload(json) {
        const quizzes = {};
        const parsed = JSON.parse(json);
        Object.keys(parsed).forEach(k => {
            quizzes[k] = { items: parsed[k] };
            const ref = QUIZZES[k].reference;
            if (ref && ref.points) quizzes[k].refPoints = ref.points;
        });
        const out = { quizzes: quizzes, deleted: CONFIG.deleted || {} };
        if (CONFIG.descriptions) out.descriptions = CONFIG.descriptions;
        return out;
    }
    function scheduleCloud(delay) {
        if (!cloudCanSave() || cloud.status === 'conflict') return;
        clearTimeout(cloudTimer);
        cloudTimer = setTimeout(cloudSave, delay == null ? 1500 : delay);
        if (unsaved()) { cloud.status = 'pending'; renderCloud(); }
    }
    async function cloudSave() {
        clearTimeout(cloudTimer);
        cloudTimer = 0;
        if (!cloudCanSave() || cloud.status === 'conflict') return;
        if (cloudBusy) { cloudTimer = setTimeout(cloudSave, 700); return; }
        const json = snapshotAll();
        if (json === shippedJSON && cloud.at) { cloud.status = 'saved'; renderCloud(); return; }
        cloudBusy = true;
        cloud.status = 'saving';
        renderCloud();
        try {
            const res = await Cloud.save(PAGE, cloudPayload(json), cloud.at);
            if (res.conflict) {
                cloud.status = 'conflict';
                cloud.remoteAt = res.conflict.savedAt;
            } else {
                cloud.at = res.savedAt;
                cloud.lastAt = res.savedAt;
                cloud.own.add(res.savedAt);
                cloud.status = 'saved';
                shippedJSON = json;
                shippedHash = hash(json);
                writeDraft();
            }
        } catch (err) {
            cloud.status = 'error';
            cloud.msg = /permission/i.test(String(err && (err.code || err.message)))
                ? 'This account is not allowed to save.' : 'Could not reach the cloud; your work is kept on this device.';
            clearTimeout(cloudTimer);
            cloudTimer = setTimeout(cloudSave, 15000);
        }
        cloudBusy = false;
        renderCloud();
        if (cloud.status === 'saved' && unsaved()) scheduleCloud(400);
    }
    // Leaving the page: try to send the last change straight away.
    window.addEventListener('pagehide', () => { if (cloudTimer && cloudCanSave()) cloudSave(); });
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden' && cloudTimer && cloudCanSave()) cloudSave();
    });

    function renderCloud() {
        let html;
        const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
        if (!Cloud) {
            html = '<span class="qe-cloud-state">Cloud save unavailable: saving on this device only.</span>';
        } else if (!cloud.ready) {
            html = '<span class="qe-cloud-state">Connecting&hellip;</span>';
        } else if (!cloud.user) {
            html = '<button type="button" class="qe-btn qe-primary" data-act="signin">Sign in to save</button>' +
                (cloud.msg ? '<span class="qe-cloud-state qe-warn">' + esc(cloud.msg) + '</span>'
                    : '<span class="qe-cloud-state qe-quiet">Saved on this device only</span>');
        } else if (!cloud.editor) {
            html = '<span class="qe-cloud-state qe-warn">' + esc(cloud.user.name) + ' cannot save yet.</span>' +
                '<button type="button" class="qe-link" data-act="cloud-help">Why?</button>' +
                '<button type="button" class="qe-link" data-act="signout">Sign out</button>';
        } else {
            const st = cloud.status;
            const text = st === 'saving' ? 'Saving&hellip;'
                : st === 'pending' ? 'Unsaved changes&hellip;'
                : st === 'conflict' ? 'Changed on another device'
                : st === 'error' ? esc(cloud.msg)
                : cloud.remoteAt && cloud.remoteAt > (cloud.at || 0) ? 'Newer copy saved on another device.'
                : cloud.lastAt ? 'Saved to your account ' + timeText(cloud.lastAt)
                : 'Saving to your account';
            html = '<span class="qe-cloud-state qe-' + (st === 'saved' || st === 'idle' ? 'ok' : st) + '">' + text + '</span>';
            if (st === 'conflict' || (cloud.remoteAt && cloud.remoteAt > (cloud.at || 0))) {
                html += '<button type="button" class="qe-btn" data-act="cloud-reload">Load it</button>';
            } else if (st === 'error') {
                html += '<button type="button" class="qe-btn" data-act="cloud-retry">Retry</button>';
            }
            html += '<span class="qe-cloud-who" title="' + esc(cloud.user.email) + '">' + esc(cloud.user.name) +
                ' &middot; <button type="button" class="qe-link" data-act="signout">Sign out</button></span>';
        }
        $$('.qe-cloud').forEach(el => { el.innerHTML = html; });
    }
    function cloudHelp() {
        const box = $('.qe-cloud-help');
        box.hidden = false;
        box.innerHTML = '<p><strong>One-time setup.</strong> Saving is limited to accounts you approve. In the ' +
            '<a href="https://console.firebase.google.com/project/give-a-paw/database/give-a-paw-default-rtdb/data" target="_blank" rel="noopener">Firebase console</a> ' +
            '(Realtime Database &rarr; Data), add <code>anatomy/editors/</code> + this ID with the value <code>true</code>. ' +
            'Then reload this page. Full steps are in ANATOMY-CLOUD-SETUP.md.</p>' +
            '<label class="qe-field">ID <input type="text" readonly spellcheck="false"></label>' +
            '<button type="button" class="qe-btn" data-act="copy-uid">Copy ID</button>';
        box.querySelector('input').value = cloud.user ? cloud.user.uid : '';
        if (studio) setDrawer(true);
        box.scrollIntoView({ block: 'nearest' });
    }
    // Leaving the page must not lose the last few hundred milliseconds.
    window.addEventListener('pagehide', () => { if (saveTimer) writeDraft(); });
    function applyDraft(d) {
        Object.keys(d.quizzes || {}).forEach(k => {
            if (!QUIZZES[k] || !Array.isArray(d.quizzes[k])) return;
            const arr = QUIZZES[k].items;
            arr.length = 0;
            d.quizzes[k].forEach(x => arr.push(x));
        });
    }
    function loadDraft() {
        let d = null;
        try { d = JSON.parse(localStorage.getItem(DRAFT_KEY)); } catch (e) {}
        if (!d || !d.quizzes) { draftNote('No unsaved changes.'); return; }
        if (JSON.stringify(d.quizzes) === shippedJSON) {
            try { localStorage.removeItem(DRAFT_KEY); } catch (e) {}
            draftNote('No unsaved changes.');
            return;
        }
        if (d.base === shippedHash) {
            applyDraft(d);
            draftNote('Restored your unsaved work from ' + timeText(d.savedAt) +
                '. <button type="button" class="qe-link" data-act="discard">Discard changes</button>');
        } else {
            draftNote('There is an unsaved draft from ' + new Date(d.savedAt).toLocaleString() +
                ', made against an older version of this data file. ' +
                '<button type="button" class="qe-link" data-act="restore-old">Restore it</button> ' +
                '<button type="button" class="qe-link" data-act="discard">Discard it</button>');
            side._qeOldDraft = d;
        }
    }

    // ---------------------------------------------------------- undo
    const snapshot = () => ({ key: devKey, items: JSON.parse(JSON.stringify(items())), sel: selected ? items().indexOf(selected) : -1 });
    function pushUndo() {
        undoStack.push(snapshot());
        if (undoStack.length > 200) undoStack.shift();
        redoStack.length = 0;
        renderTools();
    }
    function restore(s) {
        if (s.key !== devKey) setSet(s.key);
        const arr = QUIZZES[s.key].items;
        arr.length = 0;
        s.items.forEach(x => arr.push(x));
        selected = arr[s.sel] || null;
        changed();
    }
    function undo() {
        if (tracing || !undoStack.length) return;
        redoStack.push(snapshot());
        restore(undoStack.pop());
        flash('Undone.');
    }
    function redo() {
        if (tracing || !redoStack.length) return;
        undoStack.push(snapshot());
        restore(redoStack.pop());
        flash('Redone.');
    }

    // After any edit: redraw what depends on the data and autosave.
    function changed(o) {
        if (!o || o.markers !== false) renderMarkers(); else refreshMarkerStatus();
        drawPaths();
        drawHandles();
        drawGuide();
        renderList();
        renderSelected();
        renderReference();
        renderTools();
        renderHint();
        renderCode();
        if (!o || o.save !== false) { saveDraft(); scheduleCloud(); }
    }

    // ------------------------------------------------------- selection
    function reveal(it) {
        if (zoom <= 1) return;
        const w = frame.offsetWidth, h = frame.offsetHeight;
        panX = viewport.clientWidth / 2 - it.x / 100 * w * zoom;
        panY = viewport.clientHeight / 2 - it.y / 100 * h * zoom;
        applyView();
    }
    function select(it, o) {
        if (tracing && it !== selected) {
            if (!finishTrace({ noAdvance: true, quiet: true })) cancelTrace({ quiet: true });
        }
        if (selected !== (it || null)) picked = null;
        selected = it || null;
        refreshMarkerStatus();
        drawPaths();
        drawHandles();
        drawGuide();
        syncListSelection();
        renderSelected();
        renderReference();
        renderTools();
        renderHint();
        if (selected && o && o.reveal) reveal(selected);
    }
    function step(dir, untracedOnly) {
        const its = items();
        if (!its.length) return null;
        const start = selected ? its.indexOf(selected) : (dir > 0 ? -1 : its.length);
        for (let k = 1; k <= its.length; k++) {
            const it = its[((start + dir * k) % its.length + its.length) % its.length];
            if (!untracedOnly || !hasShape(it)) return it;
        }
        return null;
    }

    // ------------------------------------------------------------ tracing
    function startTrace() {
        if (!selected) { flash('Pick an item from the list first.'); return; }
        if (tracing) return;
        pushUndo();
        traceBackup = selected.points ? selected.points.map(p => p.slice()) : null;
        selected.points = [];
        tracing = true;
        picked = null;
        hoverPt = null;
        frame.classList.add('quiz-tracing');
        refreshMarkerStatus();
        drawPaths();
        drawHandles();
        drawGuide();
        renderSelected();
        renderTools();
        renderHint();
    }
    function finishTrace(o) {
        if (!tracing) return false;
        if (selected.points.length < 3) {
            if (!(o && o.quiet)) flash('A shape needs at least 3 points. Keep clicking, or press Esc to cancel.');
            return false;
        }
        const done = selected;
        tracing = false;
        traceBackup = null;
        frame.classList.remove('quiz-tracing', 'qe-can-close');
        tidy(done);
        changed();
        if (!(o && o.quiet)) flash('Traced ' + done.name + ' (' + done.points.length + ' points).');
        if (opts.advance && !(o && o.noAdvance)) {
            const next = step(1, true);
            if (next) {
                select(next, { reveal: true });
                startTrace();
                $('.qe-hint').textContent = 'Traced ' + done.name + '. Now tracing ' + next.name + ': click on its edge.';
            } else {
                flash('Every item in this set has a shape. Download the data file to save it.');
            }
        }
        return true;
    }
    function cancelTrace(o) {
        if (!tracing) return;
        tracing = false;
        frame.classList.remove('quiz-tracing', 'qe-can-close');
        if (traceBackup) selected.points = traceBackup; else delete selected.points;
        traceBackup = null;
        undoStack.pop();
        changed();
        if (!(o && o.quiet)) flash('Tracing cancelled; the previous shape is kept.');
    }
    function undoPoint() {
        if (!tracing || !selected.points.length) return;
        selected.points.pop();
        drawPaths();
        drawHandles();
        drawGuide();
        renderSelected();
        renderTools();
        renderHint();
    }
    function deletePoint(i) {
        if (!selected || !selected.points) return;
        pushUndo();
        selected.points.splice(i, 1);
        if (!selected.points.length) delete selected.points;
        picked = null;
        if (hasShape(selected) && !inside(sample(selected.points, selected.smooth), selected.x, selected.y)) placeMarker(selected);
        changed();
    }

    function startVertexDrag(ev, i, pushed) {
        const el = devVerts.children[i];
        const it = selected, pts = it.points;
        if (!el) return;
        let moved = false;
        el.classList.add('active');
        try { el.setPointerCapture(ev.pointerId); } catch (e) {}
        const r = frameRect();
        const onMove = e => {
            if (!moved) { moved = true; if (!pushed) pushUndo(); }
            const np = [round1(clamp((e.clientX - r.left) / r.width * 100)),
                        round1(clamp((e.clientY - r.top) / r.height * 100))];
            pts[i] = np;
            el.setAttribute('cx', np[0]);
            el.setAttribute('cy', np[1]);
            drawPaths();
        };
        const onUp = () => {
            el.removeEventListener('pointermove', onMove);
            el.removeEventListener('pointerup', onUp);
            el.removeEventListener('pointercancel', onUp);
            el.classList.remove('active');
            if (moved || pushed) {
                // keep the quiz marker inside its own shape
                if (!inside(sample(pts, it.smooth), it.x, it.y)) placeMarker(it);
                changed({ markers: false });
                const m = markerEls.get(it);
                if (m) { m.style.left = it.x + '%'; m.style.top = it.y + '%'; }
            }
        };
        el.addEventListener('pointermove', onMove);
        el.addEventListener('pointerup', onUp);
        el.addEventListener('pointercancel', onUp);
    }

    // ------------------------------------------------------ zoom & pan
    // The frame (image + overlay + markers) is scaled with a CSS transform;
    // --qe-inv lets markers and labels counter-scale to a constant size.
    function applyView() {
        const vw = viewport.clientWidth, vh = viewport.clientHeight;
        panX = Math.min(0, Math.max(vw - vw * zoom, panX));
        panY = Math.min(0, Math.max(vh - vh * zoom, panY));
        frame.style.transform = 'translate(' + panX + 'px,' + panY + 'px) scale(' + zoom + ')';
        frame.style.setProperty('--qe-inv', String(1 / zoom));
        drawHandles();
        renderTools();
    }
    function zoomAt(f, mx, my) {
        const prev = zoom;
        zoom = Math.min(10, Math.max(1, zoom * f));
        if (zoom === prev) return;
        panX = mx - (mx - panX) * (zoom / prev);
        panY = my - (my - panY) * (zoom / prev);
        if (zoom === 1) { panX = 0; panY = 0; }
        applyView();
    }
    const zoomCenter = f => zoomAt(f, viewport.clientWidth / 2, viewport.clientHeight / 2);
    function zoomFit() { zoom = 1; panX = 0; panY = 0; applyView(); }

    viewport.addEventListener('wheel', e => {
        e.preventDefault();
        const r = viewport.getBoundingClientRect();
        zoomAt(e.deltaY < 0 ? 1.2 : 1 / 1.2, e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });

    // One pointer drags the view; two fingers pinch-zoom about their midpoint
    // and pan with it. Any drag or pinch swallows the click that follows, so
    // it never adds a tracing point.
    const touches = new Map();
    let drag = null, pinch = null;
    const vpPoint = (x, y) => { const r = viewport.getBoundingClientRect(); return [x - r.left, y - r.top]; };
    function startPinch() {
        const [a, b] = [...touches.values()];
        const [mx, my] = vpPoint((a.x + b.x) / 2, (a.y + b.y) / 2);
        pinch = { d: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), fx: (mx - panX) / zoom, fy: (my - panY) / zoom, z: zoom };
        drag = null;
        panMoved = true;
    }
    viewport.addEventListener('pointerdown', e => {
        // handles and markers stop propagation, so this is open canvas
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        if (!touches.size) panMoved = false;
        touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (touches.size === 2) startPinch();
        else if (touches.size === 1) drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, px: panX, py: panY, on: false };
    });
    viewport.addEventListener('pointermove', e => {
        const t = touches.get(e.pointerId);
        if (!t) return;
        t.x = e.clientX;
        t.y = e.clientY;
        if (pinch && touches.size >= 2) {
            const [a, b] = [...touches.values()];
            const [mx, my] = vpPoint((a.x + b.x) / 2, (a.y + b.y) / 2);
            zoom = Math.min(10, Math.max(1, pinch.z * Math.hypot(a.x - b.x, a.y - b.y) / pinch.d));
            panX = mx - pinch.fx * zoom;
            panY = my - pinch.fy * zoom;
            if (zoom === 1) { panX = 0; panY = 0; }
            applyView();
        } else if (drag && drag.id === e.pointerId) {
            const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
            if (!drag.on && Math.hypot(dx, dy) < (e.pointerType === 'mouse' ? 4 : 10)) return;
            if (!drag.on) {
                drag.on = true;
                try { viewport.setPointerCapture(e.pointerId); } catch (err) {}
            }
            panMoved = true;
            viewport.classList.add('panning');
            panX = drag.px + dx;
            panY = drag.py + dy;
            applyView();
        }
    });
    const endPointer = e => {
        if (!touches.delete(e.pointerId)) return;
        if (touches.size < 2) pinch = null;
        if (touches.size === 1) {
            // the finger left on the glass carries on panning from here
            const [id, t] = [...touches.entries()][0];
            drag = { id: id, sx: t.x, sy: t.y, px: panX, py: panY, on: true };
        } else if (!touches.size) {
            drag = null;
            viewport.classList.remove('panning');
        }
    };
    viewport.addEventListener('pointerup', endPointer);
    viewport.addEventListener('pointercancel', endPointer);

    // ------------------------------------------------------- canvas input
    frame.addEventListener('click', e => {
        if (panMoved) { panMoved = false; return; }
        if (e.target.closest('.dev-marker') || e.target.closest('#quiz-dev-verts') ||
            e.target.closest('#quiz-dev-mids')) return;
        if (tracing) {
            if (nearFirst(e)) { finishTrace(); return; }
            const p = toPct(e);
            selected.points.push([round1(p[0]), round1(p[1])]);
            drawPaths();
            drawHandles();
            drawGuide();
            renderSelected();
            renderTools();
            renderHint();
            return;
        }
        const p = toPct(e);
        const hit = hitTest(p[0], p[1]);
        if (hit) select(hit);
    });

    let moveRaf = 0, lastMove = null;
    frame.addEventListener('pointermove', e => {
        lastMove = e;
        if (moveRaf) return;
        moveRaf = requestAnimationFrame(() => {
            moveRaf = 0;
            const ev = lastMove;
            if (!tracing) return;
            hoverPt = toPct(ev);
            const close = nearFirst(ev);
            frame.classList.toggle('qe-can-close', close);
            const first = devVerts.querySelector('.first');
            if (first) first.classList.toggle('hot', close);
            drawGuide();
        });
    });
    frame.addEventListener('pointerleave', () => {
        hoverPt = null;
        drawGuide();
    });

    // ---------------------------------------------------------- buttons
    function addItem(name) {
        const cfg = QUIZZES[devKey];
        name = name.trim();
        if (!name) return null;
        if (cfg.items.some(it => it.name === name)) {
            flash('"' + name + '" is already in this set.');
            return null;
        }
        const parked = cfg.items.filter(isParked).length;
        const item = { name: name, x: 4, y: Math.min(96, 4 + (parked % 24) * 4) };
        cfg.items.push(item);
        const gone = CONFIG.deleted[devKey];
        if (gone && gone.includes(name)) gone.splice(gone.indexOf(name), 1);
        return item;
    }
    // Remember a deleted or renamed name for this set (see CONFIG.deleted).
    function forget(name) {
        const gone = CONFIG.deleted[devKey] || (CONFIG.deleted[devKey] = []);
        if (!gone.includes(name)) gone.push(name);
    }

    app.addEventListener('click', e => {
        const b = e.target.closest('[data-act]');
        if (!b || b.disabled) return;
        const act = b.dataset.act;
        if (act === 'list') setDrawer(!app.classList.contains('qe-drawer-open'));
        else if (act === 'prev' || act === 'next') {
            const it = act === 'next' ? (step(1, true) || step(1, false)) : step(-1, false);
            if (it) select(it, { reveal: true });
        } else if (act === 'del-point') {
            if (picked != null) deletePoint(picked);
        } else if (act === 'ref-toggle') {
            opts.floatRef = !opts.floatRef;
            saveOpts();
            renderTools();
        } else if (act === 'studio-on' || act === 'studio-off') {
            opts.studio = act === 'studio-on' ? 'on' : 'off';
            saveOpts();
            applyStudio();
        } else if (act === 'signin') {
            cloud.msg = '';
            Cloud.signIn().catch(err => {
                const code = String(err && (err.code || err.message) || err);
                cloud.msg = /popup-blocked/.test(code) ? 'The sign-in window was blocked: allow pop-ups for this site and try again.'
                    : /unauthorized-domain/.test(code) ? 'Sign-in is not enabled for this web address (see ANATOMY-CLOUD-SETUP.md).'
                    : /operation-not-allowed/.test(code) ? 'Google sign-in is not switched on yet (see ANATOMY-CLOUD-SETUP.md).'
                    : /popup-closed|cancelled-popup/.test(code) ? ''
                    : 'Sign-in failed: ' + code;
                renderCloud();
            });
        } else if (act === 'signout') {
            if (unsaved() && cloudCanSave() && !window.confirm('Some changes are not in the cloud yet. Sign out anyway? They stay on this device.')) return;
            Cloud.signOut();
        } else if (act === 'cloud-help') cloudHelp();
        else if (act === 'copy-uid') {
            const inp = $('.qe-cloud-help input');
            if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(inp.value).then(() => flash('ID copied.'));
            else { inp.select(); document.execCommand('copy'); flash('ID copied.'); }
        } else if (act === 'cloud-retry') {
            cloud.status = 'pending';
            cloudSave();
        } else if (act === 'cloud-reload') {
            // Reloading plays the newer cloud copy; work done here since the
            // last save stays in this device's draft and is offered back.
            if (unsaved()) writeDraft();
            location.reload();
        } else if (act === 'trace') startTrace();
        else if (act === 'finish') finishTrace();
        else if (act === 'undo-point') undoPoint();
        else if (act === 'cancel') cancelTrace();
        else if (act === 'zoom-in') zoomCenter(1.4);
        else if (act === 'zoom-out') zoomCenter(1 / 1.4);
        else if (act === 'zoom-fit') zoomFit();
        else if (act === 'undo') undo();
        else if (act === 'redo') redo();
        else if (act === 'center') {
            pushUndo();
            placeMarker(selected);
            changed();
            flash('Marker moved to the middle of ' + selected.name + '.');
        } else if (act === 'clear') {
            pushUndo();
            delete selected.points;
            delete selected.smooth;
            changed();
        } else if (act === 'delete') {
            if (!window.confirm('Delete "' + selected.name + '" from this set?')) return;
            pushUndo();
            const arr = items();
            arr.splice(arr.indexOf(selected), 1);
            forget(selected.name);
            selected = null;
            changed();
        } else if (act === 'add') {
            const input = $('.qe-newname');
            pushUndo();
            const it = addItem(input.value);
            if (!it) { undoStack.pop(); renderTools(); return; }
            input.value = '';
            selected = it;
            changed();
            flash('Added ' + it.name + '. Press T to trace it.');
        } else if (act === 'add-list') {
            const box = $('.qe-bulk');
            pushUndo();
            let added = 0, last = null;
            box.value.split('\n').forEach(line => {
                const it = addItem(line);
                if (it) { added++; last = it; }
            });
            if (!added) { undoStack.pop(); renderTools(); return; }
            box.value = '';
            selected = last;
            changed();
            flash('Added ' + added + ' item' + (added === 1 ? '' : 's') + '.');
        } else if (act === 'download') {
            const src = [...document.scripts].map(s => s.getAttribute('src') || '')
                .find(s => /quiz-data/.test(s));
            const fname = src ? src.split('?')[0].split('/').pop() : 'quiz-data.js';
            const blob = new Blob([serializeConfig()], { type: 'text/javascript' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = fname;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(a.href), 1000);
            flash('Downloaded ' + fname + '. Replace the copy in the site folder with it.');
        } else if (act === 'copy') {
            const box = $('.qe-code');
            const ok = () => flash('Code for this set copied.');
            if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(box.value).then(ok);
            else { box.select(); document.execCommand('copy'); ok(); }
        } else if (act === 'discard') {
            if (!window.confirm('Discard all unsaved changes on this page and reload the saved data file?')) return;
            try { localStorage.removeItem(DRAFT_KEY); } catch (err) {}
            location.reload();
        } else if (act === 'restore-old') {
            const d = side._qeOldDraft;
            if (!d) return;
            pushUndo();
            applyDraft(d);
            selected = null;
            changed();
            flash('Older draft restored. Undo puts the data file back.');
        }
    });

    $('.qe-newname').addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); $('[data-act="add"]').click(); }
    });

    $('.qe-selname').addEventListener('change', e => {
        if (!selected) return;
        const name = e.target.value.trim();
        if (!name || name === selected.name) { e.target.value = selected.name; return; }
        if (items().some(it => it !== selected && it.name === name)) {
            flash('"' + name + '" is already in this set.');
            e.target.value = selected.name;
            return;
        }
        pushUndo();
        const ref = QUIZZES[devKey].reference;
        if (ref && ref.points && ref.points[selected.name] && !ref.points[name]) {
            ref.points[name] = ref.points[selected.name];
            delete ref.points[selected.name];
        }
        if (CONFIG.descriptions && CONFIG.descriptions[selected.name] && !CONFIG.descriptions[name]) {
            CONFIG.descriptions[name] = CONFIG.descriptions[selected.name];
            delete CONFIG.descriptions[selected.name];
        }
        forget(selected.name);
        const gone = CONFIG.deleted[devKey];
        if (gone.includes(name)) gone.splice(gone.indexOf(name), 1);
        selected.name = name;
        changed();
    });
    $('.qe-selname').addEventListener('keydown', e => {
        if (e.key === 'Enter') e.target.blur();
        if (e.key === 'Escape') { e.target.value = selected ? selected.name : ''; e.target.blur(); }
    });

    const slider = $('.qe-smooth input');
    let sliderPushed = false;
    slider.addEventListener('input', () => {
        if (!hasShape(selected)) return;
        if (!sliderPushed) { pushUndo(); sliderPushed = true; }
        selected.smooth = Math.round(slider.value) / 100;
        $('.qe-smooth output').textContent = slider.value;
        drawPaths();
    });
    slider.addEventListener('change', () => {
        sliderPushed = false;
        if (hasShape(selected)) changed({ markers: false });
    });

    // --------------------------------------------------------- keyboard
    document.addEventListener('keydown', e => {
        const t = e.target;
        if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
        const mod = e.ctrlKey || e.metaKey;
        const k = e.key;
        let handled = true;
        if (mod && (k === 'z' || k === 'Z')) {
            if (tracing) undoPoint();
            else if (e.shiftKey) redo();
            else undo();
        } else if (mod && (k === 'y' || k === 'Y')) redo();
        else if (mod || e.altKey) handled = false;
        else if (k === 't' || k === 'T') startTrace();
        else if (k === 'Enter') { if (tracing) finishTrace(); else handled = false; }
        else if (k === 'Escape' && !lightbox.hidden) lightbox.hidden = true;
        else if (k === 'Escape' && studio && !wideStudio() && app.classList.contains('qe-drawer-open')) setDrawer(false);
        else if (k === 'Escape') { if (tracing) cancelTrace(); else if (selected) select(null); else handled = false; }
        else if (k === 'Backspace' || k === 'Delete') {
            if (tracing) undoPoint();
            else if (picked != null && hasShape(selected) && selected.points.length > 3) deletePoint(picked);
            else handled = false;
        }
        else if (k === '+' || k === '=') zoomCenter(1.4);
        else if (k === '-' || k === '_') zoomCenter(1 / 1.4);
        else if (k === '0') zoomFit();
        else if (k === ']') { const it = step(1, false); if (it) select(it, { reveal: true }); }
        else if (k === '[') { const it = step(-1, false); if (it) select(it, { reveal: true }); }
        else if (k === 'n' || k === 'N') {
            const it = step(1, true);
            if (it) select(it, { reveal: true }); else flash('Every item in this set has a shape.');
        } else if (k === 'l' || k === 'L') {
            opts.labels = !opts.labels;
            saveOpts();
            side.querySelector('[data-opt="labels"]').checked = opts.labels;
            frame.classList.toggle('qe-all-labels', opts.labels);
        } else handled = false;
        if (handled) e.preventDefault();
    });

    // ------------------------------------------------------------- sets
    function setSet(key) {
        if (tracing) cancelTrace({ quiet: true });
        devKey = key;
        tabs.forEach(t => t.classList.toggle('active', t.dataset.quiz === key));
        selected = null;
        zoom = 1; panX = 0; panY = 0;
        const cfg = QUIZZES[devKey];
        if (imageEl.getAttribute('src') !== cfg.image) imageEl.setAttribute('src', cfg.image);
        const p = new URLSearchParams(location.search);
        p.set('quiz', key);
        history.replaceState(null, '', location.pathname + '?' + p.toString() + location.hash);
        setPick.value = key;
        applyView();
        changed({ markers: true, save: false });
    }
    tabs.forEach(tab => tab.addEventListener('click', () => {
        if (QUIZZES[tab.dataset.quiz] && tab.dataset.quiz !== devKey) setSet(tab.dataset.quiz);
    }));
    // the same sets as the page's tabs, as a compact menu for the top bar
    const setPick = top.querySelector('.qe-setpick');
    tabs.filter(t => QUIZZES[t.dataset.quiz]).forEach(t => {
        const o = document.createElement('option');
        o.value = t.dataset.quiz;
        o.textContent = t.textContent.trim();
        setPick.appendChild(o);
    });
    setPick.addEventListener('change', () => { if (setPick.value !== devKey) setSet(setPick.value); });

    // ------------------------------------------------------- full screen
    // Automatic on touch screens and narrow windows (an iPad in either
    // orientation); "Full screen" / "Exit full screen" override it.
    const autoStudio = window.matchMedia('(any-pointer: coarse), (max-width: 1100px)');
    const narrowMQ = window.matchMedia('(max-width: 1100px)');
    const wideMQ = window.matchMedia('(min-width: 1000px)');
    const wideStudio = () => wideMQ.matches;
    let studio = false;
    function setDrawer(open) {
        app.classList.toggle('qe-drawer-open', open);
        fitStudio();
    }
    // The image is sized to the space between the bars, so measure it.
    function fitStudio() {
        if (!studio) {
            imageEl.style.maxWidth = '';
            imageEl.style.maxHeight = '';
            applyView();
            return;
        }
        const r = figure.getBoundingClientRect();
        imageEl.style.maxWidth = Math.max(100, r.width - 16) + 'px';
        imageEl.style.maxHeight = Math.max(100, r.height - 16) + 'px';
        applyView();
    }
    function applyStudio() {
        const on = opts.studio === 'on' || (opts.studio !== 'off' && autoStudio.matches);
        if (on !== studio) {
            studio = on;
            app.classList.toggle('qe-studio', on);
            document.body.classList.toggle('qe-studio-on', on);
            // the list starts open beside the image when there is room for it
            app.classList.toggle('qe-drawer-open', on && wideStudio());
            zoom = 1; panX = 0; panY = 0;
        }
        // "Exit full screen" only where full screen was asked for by hand
        app.classList.toggle('qe-studio-manual', !narrowMQ.matches);
        fitStudio();
    }
    // Turning an iPad: landscape docks the list beside the image, portrait
    // puts it away so it does not cover the picture.
    let wasWide = wideStudio();
    const onMQ = () => {
        applyStudio();
        if (studio && wideStudio() !== wasWide) setDrawer(wideStudio());
        wasWide = wideStudio();
    };
    [autoStudio, wideMQ].forEach(mq => (mq.addEventListener ? mq.addEventListener('change', onMQ) : mq.addListener(onMQ)));

    // Handle sizes depend on the rendered image size.
    imageEl.addEventListener('load', () => { drawHandles(); drawGuide(); });
    window.addEventListener('resize', onMQ);
    window.addEventListener('orientationchange', () => setTimeout(onMQ, 300));

    // An outlined item needs no circle size or angle, and its quiz pin (used
    // by the Matching mode) must sit inside its own outline.
    function tidy(it, list) {
        if (!hasShape(it)) return false;
        let fixed = false;
        ['w', 'h', 'rot'].forEach(k => { if (k in it) { delete it[k]; fixed = true; } });
        if (!inside(sample(it.points, it.smooth), it.x, it.y)) { placeMarker(it, list); fixed = true; }
        return fixed;
    }

    const touchCss = document.createElement('style');
    touchCss.textContent =
        // no "Save image" callout, text selection or magnifier on long presses
        '.anatomy-quiz.dev .quiz-viewport, .anatomy-quiz.dev .quiz-viewport * { -webkit-touch-callout: none; -webkit-user-select: none; user-select: none; }' +
        '.qe-studio .qe-top, .qe-studio .qe-dock, .qe-studio .qe-row { -webkit-user-select: none; user-select: none; }' +
        // markers are automatic now
        '.qe-selected [data-act="center"] { display: none; }' +
        // finished outlines in blue over a white halo: white-on-white vanished on line art
        '#quiz-dev-polys .qe-halo:not(.selected) { stroke: rgba(255, 255, 255, 0.9); stroke-width: 4; }' +
        '#quiz-dev-polys .qe-shape:not(.selected) { stroke: #1f5bd8; stroke-width: 1.75; fill: rgba(31, 91, 216, 0.12); }' +
        '#quiz-dev-polys .qe-halo.selected { stroke: rgba(0, 0, 0, 0.35); }';
    document.head.appendChild(touchCss);
    // Safari's own pinch gesture would zoom the whole page over the image
    ['gesturestart', 'gesturechange'].forEach(t => viewport.addEventListener(t, e => e.preventDefault(), { passive: false }));

    // ------------------------------------------------------------- boot
    loadDraft();
    let repaired = 0;
    Object.keys(QUIZZES).forEach(k => QUIZZES[k].items.forEach(it => { if (tidy(it, QUIZZES[k].items)) repaired++; }));
    frame.classList.toggle('qe-all-labels', opts.labels);
    applyStudio();
    setSet(devKey);
    if (!studio) {
        const bar = document.querySelector('.quiz-tabs');
        if (bar) bar.scrollIntoView({ block: 'start' });
    }
    if (repaired) { saveDraft(); flash('Tidied ' + repaired + ' saved outline' + (repaired === 1 ? '' : 's') + ': quiz pins moved inside their outlines.'); }
    renderCloud();
    if (Cloud) {
        Cloud.onUser(u => {
            const was = cloudCanSave();
            cloud.ready = u.ready;
            cloud.user = u.user;
            cloud.editor = u.editor;
            if (u.error) cloud.msg = u.error;
            if (!cloudCanSave()) { clearTimeout(cloudTimer); cloudTimer = 0; }
            renderCloud();
            // work restored from this device's draft goes up once signed in
            if (cloudCanSave() && !was && unsaved()) scheduleCloud(500);
        });
        Cloud.watch(PAGE, at => {
            if (!at || cloud.own.has(at) || at <= (cloud.at || 0)) return;
            cloud.remoteAt = at;
            renderCloud();
        });
    }
};
