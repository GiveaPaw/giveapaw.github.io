// Freehand drawings over a 3D view (design-log.html). The same storage format as the case
// update studio's drawings (update-studio.js), so a drawing from either page reads on the other:
//   "v2|" + items joined by ";"
//       stroke  "#rrggbb:x,y x,y ..."
//       text    "T#rrggbb:x,y:<text, URI-encoded>"
//   x, y are measured from the centre of the view in units of the view's height, which is how a
//   perspective camera scales, so a drawing made from a saved camera angle lands on the same spot of
//   the model whatever the window's shape.
export const PEN_COLORS = ['#ff3fa4', '#ffd400', '#00c2ff', '#3ddc84', '#1b2530'];
const LINE = 3;
const TEXT_FONT = '700 15px Inter, system-ui, sans-serif';
export const MAX_STROKES = 20000;

export function encodeDrawing(items) {
    const enc = list => 'v2|' + list.map(it => it.type === 't'
        ? `T${it.c}:${it.x.toFixed(4)},${it.y.toFixed(4)}:${encodeURIComponent(it.s)}`
        : it.c + ':' + it.p.map(([x, y]) => `${x.toFixed(4)},${y.toFixed(4)}`).join(' ')).join(';');
    let list = items.filter(it => it.type === 't' ? it.s : it.p.length);
    let out = enc(list);
    // Very long drawings: keep every other point until they fit.
    while (out.length > MAX_STROKES - 500) {
        list = list.map(it => it.type === 't' ? it : { ...it, p: it.p.filter((_, i) => i % 2 === 0 || i === it.p.length - 1) });
        out = enc(list);
    }
    return out;
}
export function decodeDrawing(str) {
    let text = String(str || '');
    const v2 = text.startsWith('v2|');
    if (v2) text = text.slice(3);
    const color = c => (/^#[0-9a-f]{6}$/i.test(c) ? c : PEN_COLORS[0]);
    const items = text.split(';').filter(Boolean).map(part => {
        if (part[0] === 'T') {
            const m = part.match(/^T(#[0-9a-fA-F]{6}):(-?[\d.]+),(-?[\d.]+):(.*)$/);
            if (!m) return null;
            let s = '';
            try { s = decodeURIComponent(m[4]); } catch { s = m[4]; }
            return { type: 't', c: color(m[1]), x: +m[2], y: +m[3], s };
        }
        const i = part.indexOf(':');
        const p = part.slice(i + 1).split(' ').map(q => q.split(',').map(Number)).filter(a => a.length === 2 && a.every(Number.isFinite));
        return { type: 's', c: color(part.slice(0, i)), p };
    }).filter(Boolean);
    return { items, v2 };
}
// Colours used in a drawing, in order of first use.
export function drawingColors(str) {
    return [...new Set(decodeDrawing(str).items.map(it => it.c))];
}

export function paint(ctx, items, map, alpha = 1) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const it of items) {
        if (it.type === 't') {
            const [X, Y] = map(it.x, it.y);
            ctx.font = TEXT_FONT; ctx.textBaseline = 'middle';
            ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(255,255,255,0.92)'; ctx.shadowBlur = 0;
            ctx.strokeText(it.s, X, Y);
            ctx.fillStyle = it.c; ctx.fillText(it.s, X, Y);
            continue;
        }
        ctx.lineWidth = LINE; ctx.strokeStyle = it.c;
        ctx.shadowColor = 'rgba(0,0,0,0.35)'; ctx.shadowBlur = 2;
        ctx.beginPath();
        it.p.forEach(([x, y], i) => { const [X, Y] = map(x, y); if (i) ctx.lineTo(X, Y); else ctx.moveTo(X, Y); });
        if (it.p.length === 1) { const [X, Y] = map(it.p[0][0], it.p[0][1]); ctx.lineTo(X + 0.5, Y); }
        ctx.stroke();
    }
    ctx.restore();
}

// A camera is "near" a saved one when the view would line up closely enough for the ink to sit on
// the same part of the model.
export function nearView(view, saved, tolerance = 0.04) {
    if (!saved?.position || !saved?.target || !view) return false;
    const d = Math.hypot(...view.position.map((p, i) => p - saved.position[i])) + Math.hypot(...view.target.map((p, i) => p - saved.target[i]));
    const reach = Math.hypot(...saved.position.map((p, i) => p - saved.target[i])) || 1;
    return d < reach * tolerance;
}

// A canvas over `view` (the viewer's box). show(layers) paints saved drawings; startEditing(state)
// takes pointer input for a drawing in the making: state = { items, history, pen, brush, onChange }
// with brush 'pen' | 'text' | 'erase'.
export function createSketchOverlay(view) {
    const canvas = document.createElement('canvas');
    canvas.className = 'iv-sketch';
    view.appendChild(canvas);
    const ctx = canvas.getContext('2d');
    let W = 1, H = 1;
    let shown = [];
    let live = null;
    let stroke = null, erasing = false;
    const map = (x, y) => [W / 2 + x * H, H / 2 + y * H];
    const toSpace = (sx, sy) => [(sx - W / 2) / H, (sy - H / 2) / H];
    const local = e => { const r = view.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };

    function size() {
        const r = view.getBoundingClientRect();
        const dpr = Math.min(devicePixelRatio || 1, 2);
        canvas.width = Math.round(r.width * dpr); canvas.height = Math.round(r.height * dpr);
        canvas.style.width = r.width + 'px'; canvas.style.height = r.height + 'px';
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        W = r.width || 1; H = r.height || 1;
    }
    function redraw() {
        ctx.clearRect(0, 0, W, H);
        for (const layer of shown) paint(ctx, layer.items, map, layer.alpha ?? 1);
        if (live) paint(ctx, live.items, map, 1);
    }
    function show(layers) { shown = layers || []; redraw(); }
    const snapshot = () => { live.history.push(JSON.stringify(live.items)); if (live.history.length > 60) live.history.shift(); };
    // Eraser: anything within 10 px of the pointer goes.
    function eraseAt(sx, sy) {
        const before = live.items.length;
        live.items = live.items.filter(it => {
            if (it.type === 't') {
                const [X, Y] = map(it.x, it.y);
                ctx.font = TEXT_FONT;
                const w = ctx.measureText(it.s).width;
                return !(sx >= X - 6 && sx <= X + w + 6 && sy >= Y - 12 && sy <= Y + 12);
            }
            const pts = it.p.map(([x, y]) => map(x, y));
            for (let i = 0; i < pts.length; i++) {
                const a = pts[i], b = pts[i + 1] || a;
                const dx = b[0] - a[0], dy = b[1] - a[1];
                const t = dx || dy ? Math.max(0, Math.min(1, ((sx - a[0]) * dx + (sy - a[1]) * dy) / (dx * dx + dy * dy))) : 0;
                if (Math.hypot(sx - (a[0] + t * dx), sy - (a[1] + t * dy)) < 10) return false;
            }
            return true;
        });
        return live.items.length !== before;
    }
    // A small text box on the drawing; Enter places the words, Escape cancels.
    function placeText(sx, sy, done) {
        view.querySelector('.iv-textbox')?.remove();
        const input = document.createElement('input');
        input.className = 'iv-textbox';
        input.maxLength = 120;
        input.placeholder = 'Type, then Enter';
        input.setAttribute('aria-label', 'Words to place on the drawing');
        input.style.left = Math.min(sx, Math.max(0, W - 170)) + 'px'; input.style.top = (sy - 14) + 'px'; input.style.color = live.pen;
        view.append(input);
        setTimeout(() => input.focus());
        let finished = false;
        const finish = keep => { if (finished) return; finished = true; const t = input.value.trim(); input.remove(); if (keep && t) done(t); };
        input.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); });
        input.addEventListener('blur', () => finish(true));
    }
    canvas.addEventListener('pointerdown', e => {
        if (!live || e.button > 0) return;
        const [sx, sy] = local(e);
        e.preventDefault();
        if (live.brush === 'pen') {
            snapshot();
            stroke = { type: 's', c: live.pen, p: [toSpace(sx, sy)] };
            live.items.push(stroke);
            canvas.setPointerCapture(e.pointerId);
            redraw();
        } else if (live.brush === 'erase') {
            snapshot();
            erasing = true;
            canvas.setPointerCapture(e.pointerId);
            if (eraseAt(sx, sy)) redraw();
            live.onChange?.();
        } else if (live.brush === 'text') {
            placeText(sx, sy, text => { snapshot(); const [x, y] = toSpace(sx, sy); live.items.push({ type: 't', c: live.pen, x, y, s: text.slice(0, 120) }); redraw(); live.onChange?.(); });
        }
    });
    canvas.addEventListener('pointermove', e => {
        if (!live) return;
        const [sx, sy] = local(e);
        if (erasing) { if (eraseAt(sx, sy)) { redraw(); live.onChange?.(); } return; }
        if (!stroke) return;
        const last = map(...stroke.p.at(-1));
        if (Math.hypot(sx - last[0], sy - last[1]) < 3) return;
        stroke.p.push(toSpace(sx, sy));
        redraw();
    });
    const end = () => { const changed = !!(stroke || erasing); stroke = null; erasing = false; if (changed) live?.onChange?.(); };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    const ro = new ResizeObserver(() => { size(); redraw(); });
    ro.observe(view);
    size();

    function setCursor() {
        canvas.style.cursor = !live ? '' : live.brush === 'text' ? 'text' : live.brush === 'erase' ? 'cell' : 'crosshair';
    }
    return {
        redraw, show, size, toSpace, map,
        get live() { return live; },
        startEditing(state) { live = state; canvas.style.pointerEvents = 'auto'; view.classList.add('is-drawing'); setCursor(); redraw(); },
        stopEditing() { live = null; stroke = null; erasing = false; view.querySelector('.iv-textbox')?.remove(); canvas.style.pointerEvents = 'none'; view.classList.remove('is-drawing'); setCursor(); redraw(); },
        setCursor,
        undo() { if (!live?.history.length) return false; live.items = JSON.parse(live.history.pop()); redraw(); live.onChange?.(); return true; },
        clear() { if (!live?.items.length) return false; snapshot(); live.items = []; redraw(); live.onChange?.(); return true; },
        dispose() { ro.disconnect(); canvas.remove(); },
    };
}
