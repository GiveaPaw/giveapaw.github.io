// Full-screen view of one team update on a case study: its photos, 3D models and videos, each with
// numbered pins, notes and drawings. Editors switch on "Annotate" to add media (upload, pick from
// Google Drive, or a model already on the site) and to pin, draw and write notes.
//
//   photo   pins and drawings sit on the picture (positions are 0..1 of the picture)
//   model   pins sit on the surface; drawings and notes belong to the camera angle they were made
//           from (shown only near that angle; clicking the note flies back), like the walkthrough notes
//   video   pins, drawings and notes belong to a moment; markers on the timeline jump to them
//
// A note can be a "decision point" (gold) and "team only" (stored under cases/team, which visitors
// cannot read). Everything else is public with the update. Opened by case-updates.js.
import { createViewer } from './iteration-viewer.js?v=4';
import { modelUrl } from './model-base.js?v=2';
import { driveReady, preloadDrive, thumbUrl, viewUrl, mediaUrl, driveIdFrom, isDriveId, uploadFile, downloadPublic, fileKind, demoPut, demoGet } from './drive-store.js?v=2';

export const PEN_COLORS = ['#ff3fa4', '#ffd400', '#00c2ff', '#3ddc84', '#1b2530'];
const LINE = 3;
const KIND_LABEL = { photo: 'Photo', model: '3D model', video: 'Video', file: 'Design file' };
const MODEL_EXT = /\.(stl|obj|3mf|glb|gltf)$/i;

const $ = (sel, root = document) => root.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = d => { const t = new Date(String(d) + 'T12:00:00'); return isNaN(t) ? String(d ?? '') : t.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); };
const fmtTime = s => { s = Math.max(0, s || 0); return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`; };
const first = name => String(name || '').split(' ')[0];
const linkify = text => esc(text).replace(/(https:\/\/[^\s<>"]+)/g, m => `<a href="${m}" target="_blank" rel="noopener noreferrer">${m}</a>`);
const paras = text => String(text || '').trim().split(/\n\s*\n/).map(p => `<p>${p.split('\n').map(linkify).join('<br>')}</p>`).join('');
// Update text with note links turned into buttons that show the note.
const parasWithNotes = text => paras(text).replace(/\[([^\]<\n]{1,80})\]\(note:([A-Za-z0-9_-]{1,40})\/([A-Za-z0-9_-]{1,40})\)/g, (all, label, m, k) => `<button type="button" class="us-notelink" data-us="notelink" data-m="${m}" data-k="${k}">${label}</button>`);
const randomKey = () => Date.now().toString(36) + '-' + crypto.getRandomValues(new Uint32Array(1))[0].toString(36);
const fitRect = (cw, ch, nw, nh) => { if (!nw || !nh) return { x: 0, y: 0, w: cw, h: ch }; const s = Math.min(cw / nw, ch / nh); return { x: (cw - nw * s) / 2, y: (ch - nh * s) / 2, w: nw * s, h: nh * s }; };

// Drawings are stored as one short string (rules allow 20,000 characters).
//   v2 (current): "v2|" + items joined by ";"
//       stroke  "#rrggbb:x,y x,y ..."
//       text    "T#rrggbb:x,y:<text, URI-encoded>"
//     Photos and videos: x, y are 0..1 of the picture. 3D models: view space, i.e. measured from the
//     centre of the view in units of the view's height, which is how a perspective camera scales,
//     so a drawing stays on the model whatever the window's shape.
//   v1 (first drawings): "#rrggbb:x,y ..." with x, y 0..1 of the whole drawing area.
export function encodeDrawing(items) {
    const enc = list => 'v2|' + list.map(it => it.type === 't'
        ? `T${it.c}:${it.x.toFixed(4)},${it.y.toFixed(4)}:${encodeURIComponent(it.s)}`
        : it.c + ':' + it.p.map(([x, y]) => `${x.toFixed(4)},${y.toFixed(4)}`).join(' ')).join(';');
    let list = items.filter(it => it.type === 't' ? it.s : it.p.length);
    let out = enc(list);
    // Very long drawings: keep every other point until they fit.
    while (out.length > 19500) {
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
const TEXT_FONT = '700 15px Inter, system-ui, sans-serif';
function paint(ctx, items, map, alpha = 1) {
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
// Note links in the update's text: [words](note:<media id>/<note id>).
export const NOTE_LINK = /\[([^\]\n]{1,80})\]\(note:([A-Za-z0-9_-]{1,40})\/([A-Za-z0-9_-]{1,40})\)/g;

// Where a media item's file is read from.
function srcOf(m, { width = 2000 } = {}) {
    if (!m) return '';
    if (m.file && demoGet(m.file)) return demoGet(m.file);
    if (m.path) return modelUrl(m.path);
    if (!isDriveId(m.file)) return '';
    return m.kind === 'photo' ? thumbUrl(m.file, width) : mediaUrl(m.file);
}
export function mediaThumb(m) {
    if (!m) return '';
    if (m.kind === 'photo') return m.file && demoGet(m.file) ? demoGet(m.file) : (isDriveId(m.file) ? thumbUrl(m.file, 400) : '');
    if (m.kind === 'video') return isDriveId(m.file) ? thumbUrl(m.file, 400) : '';
    return '';
}

export function openStudio(host, { updateId, mediaId = '', markId = '', edit = false } = {}) {
    document.querySelector('.us')?.remove();
    const A = host.animal;
    const root = document.createElement('div');
    root.className = 'us';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    document.body.append(root);
    document.body.classList.add('us-open');
    const lastFocus = document.activeElement;

    let editing = false;
    let current = mediaId;
    let tool = '';          // '', 'pin', 'draw', 'note'
    let pen = PEN_COLORS[0];
    let pending = null;     // geometry waiting for its note: { kind, x, y, t, pos, normal, view }
    // The drawing being made or edited: items in the current space, its note, and undo history.
    let drawing = null;     // { items, history, editId, view, t, note, decision, team }
    let brush = 'pen';      // 'pen' | 'text' | 'erase' while drawing
    let aboutOpen = true;   // "About this update" starts open
    let editingText = false;
    let focusAfterLoad = '';
    let selected = '';
    let stage = null;       // the active media renderer
    let busy = [];          // uploads / conversions in progress

    const U = () => host.getUpdate(updateId);
    const mediaList = () => Object.entries(U()?.media || {}).map(([id, m]) => ({ id, ...m })).sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || (a.at || 0) - (b.at || 0));
    const curMedia = () => mediaList().find(m => m.id === current) || null;
    const marksOf = m => {
        if (!m) return [];
        const pub = Object.entries(m.marks || {}).map(([id, k]) => ({ id, ...k, team: false }));
        const team = Object.entries(host.teamMarks(updateId, m.id) || {}).map(([id, k]) => ({ id, ...k, team: true }));
        const all = [...pub, ...team];
        return all.sort((a, b) => (m.kind === 'video' ? (a.t || 0) - (b.t || 0) : 0) || (a.at || 0) - (b.at || 0)).map((k, i) => ({ ...k, n: i + 1 }));
    };
    const markPath = (m, k) => (k.team ? `${host.teamPath(updateId)}/${m.id}/${k.id}` : `${host.updatePath(updateId)}/media/${m.id}/marks/${k.id}`);

    // ------------------------------------------------------------ frame
    function shell() {
        const u = U();
        if (!u) { close(); return; }
        root.setAttribute('aria-label', 'Update: ' + (u.title || ''));
        root.classList.toggle('is-editing', editing);
        root.innerHTML = `
            <header class="us-head">
                <button type="button" class="us-back" data-us="close" aria-label="Close and go back to ${esc(A.name)}'s page">← ${esc(A.name)}</button>
                <div class="us-title"><span>${esc(fmtDate(u.date))}${u.author ? ' · by ' + esc(host.nameOf ? host.nameOf(u.uid, u.author) : first(u.author)) : ''}</span><strong>${esc(u.title)}</strong></div>
                <div class="us-head-actions">
                    ${host.canEdit() ? `<button type="button" class="us-hbtn${editing ? ' is-on' : ''}" data-us="edit" aria-pressed="${editing}">${editing ? 'Done annotating' : 'Annotate'}</button>` : ''}
                    <button type="button" class="us-hbtn" data-us="fullscreen">${document.fullscreenElement ? 'Exit full screen' : 'Full screen'}</button>
                    <button type="button" class="us-x" data-us="close" aria-label="Close">×</button>
                </div>
            </header>
            <div class="us-body">
                <nav class="us-rail" aria-label="Photos, videos and 3D models in this update"></nav>
                <section class="us-stage" aria-live="polite"></section>
                <aside class="us-notes"></aside>
            </div>`;
        renderRail();
        mountStage();
    }

    function renderRail() {
        const rail = $('.us-rail', root);
        if (!rail) return;
        const list = mediaList();
        rail.innerHTML = `
            <button type="button" class="us-ritem us-ritem-text${!current ? ' is-on' : ''}" data-us="go" data-id=""><span class="us-ricon">¶</span><span>The update</span></button>
            ${list.map((m, i) => {
                const th = mediaThumb(m);
                const n = marksOf(m).length;
                return `<div class="us-rwrap"><button type="button" class="us-ritem${m.id === current ? ' is-on' : ''}" data-us="go" data-id="${esc(m.id)}" aria-current="${m.id === current}">
                    ${th ? `<img src="${esc(th)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'us-ricon',textContent:'${m.kind === 'model' ? '3D' : m.kind === 'video' ? '▶' : '🖼'}'}))">` : `<span class="us-ricon">${m.kind === 'model' ? '3D' : m.kind === 'video' ? '▶' : m.kind === 'file' ? '⬇' : '🖼'}</span>`}
                    <span>${esc(m.caption || m.name || KIND_LABEL[m.kind])}</span>${n ? `<span class="us-rcount">${n}</span>` : ''}${m.kind === 'video' ? '<span class="us-rkind">Video</span>' : m.kind === 'model' ? '<span class="us-rkind">3D</span>' : m.kind === 'file' ? '<span class="us-rkind">Download</span>' : ''}
                </button>${editing && host.canChange(m) ? `<span class="us-rtools"><button type="button" data-us="up" data-id="${esc(m.id)}" aria-label="Move up"${i === 0 ? ' disabled' : ''}>↑</button><button type="button" data-us="down" data-id="${esc(m.id)}" aria-label="Move down"${i === list.length - 1 ? ' disabled' : ''}>↓</button><button type="button" data-us="remove-media" data-id="${esc(m.id)}" aria-label="Remove from the update">✕</button></span>` : ''}</div>`;
            }).join('')}
            ${editing ? `<button type="button" class="us-add" data-us="add">+ Add photos, videos or 3D</button>` : ''}
            ${busy.map(b => `<div class="us-busy"><span>${esc(b.label)}</span><span class="us-bar"><i style="width:${Math.round(b.p * 100)}%"></i></span></div>`).join('')}`;
    }

    // ------------------------------------------------------------ stage
    function mountStage() {
        stage?.dispose?.();
        stage = null;
        tool = ''; pending = null; drawing = null; selected = '';
        const box = $('.us-stage', root);
        const m = curMedia();
        if (!m) { current = ''; box.innerHTML = textScreen(); renderNotes(); return; }
        box.innerHTML = `
            <div class="us-view" data-kind="${m.kind}"><div class="us-media"></div><canvas class="us-sketch"></canvas><div class="us-pins"></div><p class="us-msg" hidden></p></div>
            ${m.kind === 'video' ? '<div class="us-timeline" aria-label="Notes on this video"><div class="us-track"></div></div>' : ''}
            ${toolbarHTML(m)}
            ${editing && host.canChange(m) ? `<label class="us-caption-edit">Caption <input data-us="caption" maxlength="300" value="${esc(m.caption || '')}" placeholder="What this shows"></label>` : m.caption ? `<p class="us-caption">${esc(m.caption)}</p>` : ''}`;
        stage = ({ photo: photoStage, model: modelStage, video: videoStage, file: fileStage })[m.kind](m, $('.us-view', box));
        renderNotes();
    }

    function textScreen() {
        const u = U();
        const list = mediaList();
        return `<div class="us-textscreen">
            <span class="us-k">${esc(fmtDate(u.date))}</span>
            <h2>${esc(u.title)}</h2>
            ${paras(u.text)}
            ${list.length ? `<div class="us-grid">${list.map(m => { const th = mediaThumb(m); return `<button type="button" data-us="go" data-id="${esc(m.id)}">${th ? `<img src="${esc(th)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<span>${m.kind === 'model' ? '3D model' : 'Video'}</span>`}<em>${esc(m.caption || m.name || KIND_LABEL[m.kind])}</em></button>`; }).join('')}</div>` : ''}
            ${host.canEdit() && !list.length ? `<p class="us-hint">Switch on <strong>Annotate</strong> to add photos, videos and 3D models, then pin, draw and write notes on them.</p>` : ''}
        </div>`;
    }

    function toolbarHTML(m) {
        if (!editing || m.kind === 'file') return '';
        const where = m.kind === 'video' ? 'at this moment' : m.kind === 'model' ? 'from this angle' : '';
        const colors = `<span class="us-colors">${PEN_COLORS.map(c => `<button type="button" data-us="pen" data-c="${c}" style="--c:${c}" aria-label="Colour ${c}" aria-pressed="${c === pen}"></button>`).join('')}</span>`;
        if (tool === 'draw') {
            const hint = brush === 'text' ? 'Click where the words should go, type, then press Enter.' : brush === 'erase' ? 'Drag across a line or words to erase them.' : m.kind === 'model' ? 'Drawing from this angle; it shows whenever someone looks from here. Orbit is paused.' : m.kind === 'video' ? 'The video paused; draw on this frame.' : 'Draw on the picture.';
            return `<div class="us-tools is-drawing" role="toolbar" aria-label="Drawing tools">
                <span class="us-seg" role="group" aria-label="Brush">
                    <button type="button" data-us="brush" data-b="pen" aria-pressed="${brush === 'pen'}">✏️ Pen</button>
                    <button type="button" data-us="brush" data-b="text" aria-pressed="${brush === 'text'}">🔤 Text</button>
                    <button type="button" data-us="brush" data-b="erase" aria-pressed="${brush === 'erase'}">🧽 Eraser</button>
                </span>
                ${colors}
                <button type="button" data-us="undo"${drawing?.history.length ? '' : ' disabled'}>Undo</button>
                <button type="button" data-us="clear"${drawing?.items.length ? '' : ' disabled'}>Clear</button>
                <span class="us-toolhint">${hint}</span>
                <button type="button" data-us="cancel-draw">Cancel</button>
                <button type="button" class="us-primary" data-us="save-draw">Save drawing</button>
            </div>`;
        }
        return `<div class="us-tools" role="toolbar" aria-label="Annotation tools">
            <button type="button" data-us="tool" data-tool="pin" aria-pressed="${tool === 'pin'}">📍 Pin</button>
            <button type="button" data-us="tool" data-tool="draw" aria-pressed="false">✏️ Draw</button>
            <button type="button" data-us="tool" data-tool="note" aria-pressed="${tool === 'note'}">💬 Note ${where}</button>
            ${colors}
            <span class="us-toolhint">${tool === 'pin' ? (m.kind === 'model' ? 'Click the model where something should change.' : 'Click the spot to pin.') : ''}</span>
        </div>`;
    }
    const refreshTools = () => { const m = curMedia(); const t = $('.us-tools', root); if (t && m) t.outerHTML = toolbarHTML(m); stage?.setTool?.(tool); };

    // Shared overlay: drawing canvas + pin buttons. space 'rect' = 0..1 of the picture's rectangle;
    // 'view' = from the centre in units of the view height (3D models, see encodeDrawing).
    function overlay(view, getRect, space = 'rect') {
        const canvas = $('.us-sketch', view);
        const pinsEl = $('.us-pins', view);
        const ctx = canvas.getContext('2d');
        let rect = { x: 0, y: 0, w: 1, h: 1 }, W = 1, Hh = 1;
        let stroke = null, erasing = false;
        const size = () => {
            const r = view.getBoundingClientRect();
            const dpr = Math.min(devicePixelRatio || 1, 2);
            canvas.width = Math.round(r.width * dpr); canvas.height = Math.round(r.height * dpr);
            canvas.style.width = r.width + 'px'; canvas.style.height = r.height + 'px';
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            W = r.width || 1; Hh = r.height || 1;
            rect = getRect(W, Hh);
        };
        // Map stored coordinates to the screen. Old (v1) 3D drawings used 0..1 of the whole area.
        const mapFor = v2 => (space === 'view' && v2) ? (x, y) => [W / 2 + x * Hh, Hh / 2 + y * Hh] : (x, y) => [rect.x + x * rect.w, rect.y + y * rect.h];
        const toSpace = (sx, sy) => (space === 'view' ? [(sx - W / 2) / Hh, (sy - Hh / 2) / Hh] : [(sx - rect.x) / rect.w, (sy - rect.y) / rect.h]);
        const local = e => { const r = view.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
        const clamp = p => (space === 'rect' ? p.map(v => Math.min(1, Math.max(0, v))) : p);
        const snapshot = () => { drawing.history.push(JSON.stringify(drawing.items)); if (drawing.history.length > 60) drawing.history.shift(); };
        // Eraser: anything within 10 px of the pointer goes.
        const eraseAt = (sx, sy) => {
            const map = mapFor(true);
            const before = drawing.items.length;
            drawing.items = drawing.items.filter(it => {
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
            return drawing.items.length !== before;
        };
        canvas.addEventListener('pointerdown', e => {
            const [sx, sy] = local(e);
            if (tool === 'draw' && drawing) {
                e.preventDefault();
                if (brush === 'pen') {
                    snapshot();
                    stroke = { type: 's', c: pen, p: [clamp(toSpace(sx, sy))] };
                    drawing.items.push(stroke);
                    canvas.setPointerCapture(e.pointerId);
                } else if (brush === 'erase') {
                    snapshot();
                    erasing = true;
                    if (!eraseAt(sx, sy)) {} // nothing under the pointer yet
                    canvas.setPointerCapture(e.pointerId);
                    redraw(); refreshDrawingButtons();
                } else if (brush === 'text') {
                    placeText(view, sx, sy, text => { snapshot(); const [x, y] = clamp(toSpace(sx, sy - 0)); drawing.items.push({ type: 't', c: pen, x, y, s: text.slice(0, 120) }); redraw(); refreshDrawingButtons(); });
                }
            } else if (tool === 'pin' && stage?.pinAt) {
                const p = toSpace(sx, sy);
                if (space === 'rect' && p[0] >= 0 && p[0] <= 1 && p[1] >= 0 && p[1] <= 1) stage.pinAt(p);
            }
        });
        canvas.addEventListener('pointermove', e => {
            const [sx, sy] = local(e);
            if (erasing) { if (eraseAt(sx, sy)) { redraw(); refreshDrawingButtons(); } return; }
            if (!stroke) return;
            const last = mapFor(true)(...stroke.p.at(-1));
            if (Math.hypot(sx - last[0], sy - last[1]) < 3) return;
            stroke.p.push(clamp(toSpace(sx, sy)));
            redraw();
        });
        const end = () => { if (stroke || erasing) refreshDrawingButtons(); stroke = null; erasing = false; };
        canvas.addEventListener('pointerup', end);
        canvas.addEventListener('pointercancel', end);
        const ro = new ResizeObserver(() => { size(); redraw(); });
        ro.observe(view);
        size();
        function redraw() {
            ctx.clearRect(0, 0, W, Hh);
            const m = curMedia();
            const marks = marksOf(m);
            for (const k of marks) {
                if (k.kind !== 'sketch' || k.id === drawing?.editId || !stage?.visible(k)) continue;
                const d = decodeDrawing(k.strokes);
                paint(ctx, d.items, mapFor(d.v2), selected && selected !== k.id ? 0.45 : 1);
            }
            if (drawing) paint(ctx, drawing.items, mapFor(true));
            // Pins (photo and video; models draw their own on the surface).
            if (stage?.flatPins) {
                const pins = marks.filter(k => k.kind === 'pin' && stage.visible(k));
                if (pending?.kind === 'pin' && pending.x != null) pins.push({ id: '__new', n: '+', x: pending.x, y: pending.y, color: pen });
                pinsEl.innerHTML = pins.map(k => `<button type="button" class="us-pin${k.id === selected ? ' is-on' : ''}${k.decision ? ' is-decision' : ''}" data-us="mark" data-id="${esc(k.id)}" style="left:${rect.x + k.x * rect.w}px;top:${rect.y + k.y * rect.h}px;--c:${esc(k.color || PEN_COLORS[0])}" aria-label="Note ${k.n}">${k.n}</button>`).join('');
            }
        }
        // Old (v1) drawings converted to this space, so editing one keeps it where it was.
        const fromV1 = items => items.map(it => {
            if (space !== 'view') return it;
            const conv = (x, y) => [(x * W - W / 2) / Hh, (y * Hh - Hh / 2) / Hh];
            return it.type === 't' ? { ...it, ...Object.fromEntries(['x', 'y'].map((k, i) => [k, conv(it.x, it.y)[i]])) } : { ...it, p: it.p.map(([x, y]) => conv(x, y)) };
        });
        return { redraw, size, fromV1, setActive: on => { canvas.style.pointerEvents = on ? 'auto' : 'none'; view.classList.toggle('is-drawing', tool === 'draw'); canvas.style.cursor = tool === 'draw' ? (brush === 'text' ? 'text' : brush === 'erase' ? 'cell' : 'crosshair') : tool === 'pin' ? 'copy' : ''; }, dispose: () => ro.disconnect(), get rect() { return rect; } };
    }

    // A small text box on the drawing; Enter places the words, Escape cancels.
    function placeText(view, sx, sy, done) {
        view.querySelector('.us-textbox')?.remove();
        const input = document.createElement('input');
        input.className = 'us-textbox';
        input.maxLength = 120;
        input.placeholder = 'Type, then Enter';
        input.style.left = sx + 'px'; input.style.top = (sy - 14) + 'px'; input.style.color = pen;
        view.append(input);
        setTimeout(() => input.focus());
        let finished = false;
        const finish = keep => { if (finished) return; finished = true; const t = input.value.trim(); input.remove(); if (keep && t) done(t); };
        input.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); });
        input.addEventListener('blur', () => finish(true));
    }

    function photoStage(m, view) {
        const media = $('.us-media', view);
        const img = new Image();
        img.alt = m.caption || m.name || 'Photo';
        img.referrerPolicy = 'no-referrer';
        img.className = 'us-img';
        media.append(img);
        let ov = null;
        const api = {
            flatPins: true,
            visible: () => true,
            pinAt([x, y]) { pending = { kind: 'pin', x: +x.toFixed(4), y: +y.toFixed(4) }; tool = ''; refreshTools(); ov.redraw(); renderNotes(); },
            setTool(t) { ov?.setActive(t === 'pin' || t === 'draw'); },
            focus() { ov?.redraw(); },
            fromV1: items => items,
            redraw: () => ov?.redraw(),
            dispose: () => ov?.dispose(),
        };
        img.onload = () => { ov = overlay(view, (w, h) => fitRect(w, h, img.naturalWidth, img.naturalHeight)); api.setTool(tool); ov.redraw(); };
        img.onerror = () => message(view, 'This photo could not be loaded. Check that the Drive file is shared with anyone who has the link.');
        img.src = srcOf(m);
        return api;
    }

    function videoStage(m, view) {
        const media = $('.us-media', view);
        const src = srcOf(m);
        if (!src) { message(view, 'Videos show once the Google Drive setup is finished (see CASE-UPDATES-SETUP.md).'); return { visible: () => false, dispose() {} }; }
        const v = document.createElement('video');
        v.className = 'us-video';
        v.controls = true; v.playsInline = true; v.preload = 'metadata';
        if (isDriveId(m.file)) v.poster = thumbUrl(m.file, 1200);
        v.src = src;
        media.append(v);
        const ov = overlay(view, (w, h) => fitRect(w, h, v.videoWidth, v.videoHeight));
        let raf = 0;
        const loop = () => { ov.redraw(); renderTimelineNow(); raf = v.paused ? 0 : requestAnimationFrame(loop); };
        v.addEventListener('loadedmetadata', () => { ov.size(); ov.redraw(); renderTimeline(); });
        v.addEventListener('play', () => { if (tool === 'draw' || pending) { v.pause(); return; } raf ||= requestAnimationFrame(loop); });
        v.addEventListener('seeked', () => { ov.redraw(); renderTimelineNow(); });
        v.addEventListener('error', () => message(view, 'This video could not be loaded. Check that the Drive file is shared with anyone who has the link.'));
        const near = k => Math.abs(v.currentTime - (k.t || 0)) < (v.paused ? 0.08 : 0.75) || (k.id === selected && Math.abs(v.currentTime - (k.t || 0)) < 0.3);
        function renderTimeline() {
            const track = $('.us-track', root);
            if (!track) return;
            const d = v.duration || 0;
            track.innerHTML = (d ? marksOf(curMedia()).map(k => `<button type="button" class="us-tick${k.decision ? ' is-decision' : ''}${k.team ? ' is-team' : ''}" data-us="mark" data-id="${esc(k.id)}" style="left:${(100 * (k.t || 0) / d).toFixed(2)}%" title="${esc(fmtTime(k.t) + ' ' + (k.note || ''))}" aria-label="Note ${k.n} at ${fmtTime(k.t)}">${k.n}</button>`).join('') : '') + '<i class="us-now"></i>';
            renderTimelineNow();
        }
        function renderTimelineNow() { const now = $('.us-now', root); if (now && v.duration) now.style.left = (100 * v.currentTime / v.duration) + '%'; }
        return {
            flatPins: true,
            video: v,
            visible: near,
            pinAt([x, y]) { v.pause(); pending = { kind: 'pin', x: +x.toFixed(4), y: +y.toFixed(4), t: +v.currentTime.toFixed(2) }; tool = ''; refreshTools(); ov.redraw(); renderNotes(); },
            setTool(t) { if (t === 'draw' || t === 'pin') v.pause(); ov.setActive(t === 'pin' || t === 'draw'); },
            focus(k) { v.pause(); const go = () => { v.currentTime = k.t || 0; ov.redraw(); }; if (v.readyState >= 1) go(); else v.addEventListener('loadedmetadata', go, { once: true }); },
            time: () => +v.currentTime.toFixed(2),
            fromV1: items => items,
            redraw: () => { ov.redraw(); renderTimeline(); },
            dispose: () => { cancelAnimationFrame(raf); v.pause(); v.removeAttribute('src'); v.load(); ov.dispose(); },
        };
    }

    function modelStage(m, view) {
        const media = $('.us-media', view);
        media.classList.add('iv');
        const src = srcOf(m);
        if (!src) { message(view, '3D models from Drive show once the Google Drive setup is finished (see CASE-UPDATES-SETUP.md).'); return { visible: () => false, dispose() {} }; }
        const viewer = createViewer(media, { up: 'z', background: 0xf3f5f8 });
        let loaded = false;
        const ov = overlay(view, (w, h) => ({ x: 0, y: 0, w, h }), 'view');
        message(view, 'Loading the 3D model…');
        viewer.setModel('main', src).then(() => { viewer.frame('main'); message(view, ''); loaded = true; syncPins(); ov.redraw(); if (focusAfterLoad) { const id = focusAfterLoad; focusAfterLoad = ''; select(id); } })
            .catch(() => message(view, 'This 3D model could not be loaded. Check that the Drive file is shared with anyone who has the link.'));
        viewer.onChange(() => ov.redraw());
        const near = k => {
            if (!k.view) return true;
            const v = viewer.getView();
            const d = Math.hypot(...v.position.map((p, i) => p - k.view.position[i])) + Math.hypot(...v.target.map((p, i) => p - k.view.target[i]));
            const reach = Math.hypot(...k.view.position.map((p, i) => p - k.view.target[i])) || 1;
            return d < reach * 0.04;
        };
        function syncPins() {
            viewer.setPins(marksOf(curMedia()).filter(k => k.kind === 'pin' && k.pos).map(k => ({ ...k, active: k.id === selected })), k => select(k.id));
            if (pending?.pos) viewer.setPins([...marksOf(curMedia()).filter(k => k.kind === 'pin' && k.pos), { id: '__new', pos: pending.pos, n: '+', active: true }], k => k.id !== '__new' && select(k.id));
        }
        return {
            visible: near,
            setTool(t) {
                viewer.controls.enabled = t !== 'draw';
                viewer.setPickMode(t === 'pin' ? hit => { pending = { kind: 'pin', pos: hit.pos, normal: hit.normal, view: viewer.getView() }; tool = ''; refreshTools(); syncPins(); renderNotes(); } : null);
                ov.setActive(t === 'draw');
            },
            focus(k) { if (!loaded) { focusAfterLoad = k.id; return; } if (k.view) viewer.flyTo(k.view); syncPins(); },
            view: () => viewer.getView(),
            fromV1: items => ov.fromV1(items),
            redraw: () => { syncPins(); ov.redraw(); },
            dispose: () => { ov.dispose(); viewer.dispose(); },
        };
    }

    // Design files (.ntop and the like): a download card; there is nothing to look at in the browser.
    function fileStage(m, view) {
        const ext = ((String(m.name || '').match(/\.([a-z0-9]+)$/i) || [])[1] || 'file').toUpperCase();
        const what = { NTOP: 'an nTop notebook. Open it in nTop', STEP: 'a STEP model. Most CAD programs open it', STP: 'a STEP model. Most CAD programs open it', SLDPRT: 'a SolidWorks part', SLDASM: 'a SolidWorks assembly', F3D: 'a Fusion 360 design', MIX: 'a MeshMixer file', PDF: 'a PDF', ZIP: 'a zip of files' }[ext] || 'a design file';
        view.classList.add('is-file');
        $('.us-media', view).innerHTML = `<div class="us-filecard">
            <span class="us-fileext">${esc(ext.slice(0, 6))}</span>
            <strong>${esc(m.name || 'Design file')}</strong>
            <span>This is ${esc(what)}.${m.bytes ? ` ${esc(fmtSize(m.bytes))}.` : ''}</span>
            ${isDriveId(m.file) && !demoGet(m.file) ? `<a class="us-download" href="${esc(viewUrl(m.file))}" target="_blank" rel="noopener">⬇ Download from Google Drive</a>` : demoGet(m.file) ? `<a class="us-download" href="${esc(demoGet(m.file))}" download="${esc(m.name || 'design-file')}">⬇ Download</a>` : ''}
            ${m.bytes > 1e8 ? '<small>Google shows a “can’t scan this file for viruses” page for files this big; choose Download anyway.</small>' : ''}
        </div>`;
        return { visible: () => false, dispose() {} };
    }
    const fmtSize = b => (b >= 1e9 ? (b / 1e9).toFixed(1) + ' GB' : b >= 1e6 ? Math.round(b / 1e6) + ' MB' : Math.max(1, Math.round(b / 1e3)) + ' KB');

    function message(view, text) { const p = $('.us-msg', view); if (p) { p.textContent = text; p.hidden = !text; } }

    // ------------------------------------------------------------ notes column
    function renderNotes() {
        const aside = $('.us-notes', root);
        if (!aside) return;
        const u = U();
        const m = curMedia();
        const marks = marksOf(m);
        const what = m ? ({ photo: 'photo', model: '3D model', video: 'video' })[m.kind] : '';
        const canText = editing && host.canChange(u);
        const about = `<details class="us-about" data-us-about${aboutOpen ? ' open' : ''}>
                <summary>About this update</summary>
                ${editingText ? aboutEditor(u) : `<div class="us-about-text">${parasWithNotes(u.text) || '<p>No text yet.</p>'}</div>
                ${canText ? '<button type="button" class="us-linkbtn" data-us="about-edit">Edit text and link notes</button>' : ''}`}
            </details>`;
        aside.innerHTML = `
            ${m ? about : ''}
            ${m && tool === 'draw' && drawing ? drawPanel(m) : ''}
            ${m ? `<div class="us-notes-head"><h3>Notes on this ${what}</h3><span>${marks.length}</span></div>
            ${marks.length ? `<ol class="us-marks">${marks.map(k => markRow(m, k)).join('')}</ol>` : `<p class="us-empty">${editing ? `Use Pin, Draw or Note to mark ${m.kind === 'video' ? 'moments that' : 'what'} guided the design.` : 'No notes on this one yet.'}</p>`}
            ${editing && tool !== 'draw' ? noteForm(m) : ''}` : `<div class="us-notes-head"><h3>In this update</h3><span>${mediaList().length}</span></div>
            <p class="us-empty">${mediaList().length ? 'Pick a photo, video or 3D model on the left to see its notes.' : 'Nothing attached yet.'}</p>`}`;
        // Not the drawing's note box: you draw first, and on a phone focusing it would scroll the model away.
        (aside.querySelector('.us-form textarea') || (editingText ? aside.querySelector('.us-about textarea') : null))?.focus({ preventScroll: tool === 'draw' });
    }

    // Edit the update's words here, and turn chosen words into links to notes.
    function aboutEditor(u) {
        const options = mediaList().flatMap((mm, i) => marksOf(mm).filter(k => !k.team).map(k => `<option value="${esc(mm.id)}/${esc(k.id)}">${esc(`${i + 1}. ${mm.caption || mm.name || KIND_LABEL[mm.kind]} · note ${k.n}: ${(k.note || (k.kind === 'sketch' ? 'drawing' : 'pin')).slice(0, 40)}`)}</option>`)).join('');
        return `<form class="us-about-edit" data-us-form="about">
            <textarea name="text" rows="10" maxlength="4000">${esc(u.text || '')}</textarea>
            <label>Link a note <select data-us="link-note"><option value="">Select words above, then pick a note…</option>${options}</select></label>
            <p class="us-hint">The selected words become a link: readers click it to see that note${mediaList().some(mm => mm.kind === 'model') ? ' and the 3D view it was made from' : ''}. Team-only notes can't be linked.</p>
            <p class="us-error" role="alert"></p>
            <div class="us-form-actions"><button type="button" data-us="about-cancel">Cancel</button><button type="submit" class="us-primary">Save text</button></div>
        </form>`;
    }

    // While drawing: the note that goes with the drawing.
    function drawPanel(m) {
        const where = m.kind === 'model' ? 'It belongs to this angle: readers see it when they look from here, or when they click its number.' : m.kind === 'video' ? `It belongs to ${fmtTime(drawing.t)} in the video.` : '';
        return `<section class="us-drawpanel" aria-label="Drawing">
            <h3>✏️ ${drawing.editId ? 'Edit drawing' : 'New drawing'}</h3>
            ${where ? `<p class="us-hint">${where}</p>` : ''}
            <label>Note for this drawing<textarea data-us-draw="note" rows="4" maxlength="1000" placeholder="What the lines show, what should change, or why we decided this">${esc(drawing.note)}</textarea></label>
            <label class="us-check"><input type="checkbox" data-us-draw="decision"${drawing.decision ? ' checked' : ''}> Decision point <small>(gold)</small></label>
            <label class="us-check"><input type="checkbox" data-us-draw="team"${drawing.team ? ' checked' : ''}${drawing.editId ? ' disabled' : ''}> Team only <small>(hidden from visitors)</small></label>
            <p class="us-error" role="alert"></p>
            <div class="us-form-actions"><button type="button" data-us="cancel-draw">Cancel</button><button type="button" class="us-primary" data-us="save-draw">Save drawing</button></div>
        </section>`;
    }

    function markRow(m, k) {
        const where = m.kind === 'video' ? `<button type="button" class="us-time" data-us="mark" data-id="${esc(k.id)}">${fmtTime(k.t)}</button>` : '';
        const icon = k.kind === 'sketch' ? '✏️' : k.kind === 'pin' ? '' : '💬';
        return `<li class="us-mark${k.id === selected ? ' is-on' : ''}${k.decision ? ' is-decision' : ''}" data-id="${esc(k.id)}">
            <button type="button" class="us-num" data-us="mark" data-id="${esc(k.id)}" style="--c:${esc(k.color || '#003262')}" aria-label="Show note ${k.n}">${k.n}</button>
            <div class="us-mark-body">
                <div class="us-mark-meta">${where}${icon ? `<span>${icon}</span>` : ''}${k.decision ? '<span class="us-badge us-badge-gold">Decision</span>' : ''}${k.team ? '<span class="us-badge">Team only</span>' : ''}<span class="us-by">${esc(host.nameOf ? host.nameOf(k.uid, k.author) : first(k.author))}</span></div>
                ${k.note ? `<p>${linkify(k.note)}</p>` : `<p class="us-muted">${k.kind === 'sketch' ? 'Drawing' : 'Pin'}${m.kind === 'model' && k.view ? ' — click the number to see it from its angle' : ''}</p>`}
                ${editing && host.canChange(k) ? `<div class="us-mark-actions">${k.kind === 'sketch' ? `<button type="button" data-us="edit-drawing" data-id="${esc(k.id)}">Edit drawing</button>` : ''}<button type="button" data-us="edit-mark" data-id="${esc(k.id)}">${k.kind === 'sketch' ? 'Edit note' : 'Edit'}</button><button type="button" data-us="delete-mark" data-id="${esc(k.id)}">Delete</button></div>` : ''}
            </div></li>`;
    }

    function noteForm(m, k = null) {
        const geo = pending;
        if (!geo && !k) return '';
        const label = k ? 'Edit note' : geo.kind === 'pin' ? 'Note for the new pin' : geo.kind === 'sketch' ? 'Note for the drawing (optional)' : m.kind === 'video' ? `Note at ${fmtTime(geo.t)}` : m.kind === 'model' ? 'Note for this angle' : 'Note';
        return `<form class="us-form" data-us-form="mark" data-id="${esc(k?.id || '')}">
            <label>${esc(label)}<textarea name="note" rows="3" maxlength="1000" placeholder="What should change, or why we decided this">${esc(k?.note || '')}</textarea></label>
            <label class="us-check"><input type="checkbox" name="decision"${k?.decision ? ' checked' : ''}> Decision point <small>(shown in gold)</small></label>
            <label class="us-check"><input type="checkbox" name="team"${k?.team ? ' checked' : ''}${k ? ' disabled' : ''}> Team only <small>(hidden from visitors)</small></label>
            <p class="us-error" role="alert"></p>
            <div class="us-form-actions"><button type="button" data-us="cancel-note">Cancel</button><button type="submit" class="us-primary">Save note</button></div>
        </form>`;
    }

    function startDrawing(k = null) {
        const m = curMedia();
        if (!m || !stage) return;
        if (k) {
            const d = decodeDrawing(k.strokes);
            drawing = { items: d.v2 ? d.items : stage.fromV1(d.items), history: [], editId: k.id, view: k.view || null, t: k.t ?? null, note: k.note || '', decision: !!k.decision, team: !!k.team };
            selected = k.id;
            stage.focus?.(k);
        } else {
            const g = noteGeometry() || {};
            drawing = { items: [], history: [], editId: '', view: g.view || null, t: g.t ?? null, note: '', decision: false, team: false };
        }
        tool = 'draw'; brush = 'pen'; pending = null;
        refreshTools(); renderNotes(); stage.redraw?.();
    }
    function refreshDrawingButtons() {
        const t = $('.us-tools.is-drawing', root);
        if (!t || !drawing) return;
        t.querySelector('[data-us=undo]').disabled = !drawing.history.length;
        t.querySelector('[data-us=clear]').disabled = !drawing.items.length;
    }
    function endDrawing() { drawing = null; tool = ''; brush = 'pen'; refreshTools(); renderNotes(); stage?.redraw?.(); }
    async function saveDrawing() {
        const m = curMedia();
        const err = $('.us-drawpanel .us-error', root);
        const note = String(drawing.note || '').trim().slice(0, 1000);
        if (!drawing.items.length && !note) { if (err) err.textContent = 'Draw something or write a note first.'; return; }
        const strokes = encodeDrawing(drawing.items);
        const color = drawing.items[0]?.c || pen;
        let path, id;
        if (drawing.editId) {
            const k = marksOf(m).find(x => x.id === drawing.editId);
            if (!k) { endDrawing(); return; }
            const { id: kid, n, team, ...rest } = k;
            const value = { ...rest, strokes, color, edited: Date.now() };
            if (note) value.note = note; else delete value.note;
            if (drawing.decision) value.decision = true; else delete value.decision;
            id = kid; path = markPath(m, k);
            await host.set(path, value);
        } else {
            const user = host.user();
            const value = { kind: 'sketch', uid: user.uid, author: user.name, at: Date.now(), strokes, color,
                ...(note ? { note } : {}), ...(drawing.decision ? { decision: true } : {}),
                ...(drawing.view ? { view: drawing.view } : {}), ...(drawing.t != null ? { t: drawing.t } : {}) };
            id = host.newKey();
            path = drawing.team ? `${host.teamPath(updateId)}/${m.id}/${id}` : `${host.updatePath(updateId)}/media/${m.id}/marks/${id}`;
            await host.set(path, value);
        }
        selected = id;
        endDrawing();
        renderRail();
    }
    // A note link in the text: show that item and that note.
    function openNoteLink(mId, kId) {
        if (!mediaList().some(x => x.id === mId)) return;
        if (current !== mId) {
            current = mId;
            history.replaceState(null, '', `#update/${updateId}/${mId}`);
            mountStage(); renderRail();
        }
        select(kId);
    }

    function select(id) {
        selected = id;
        const k = marksOf(curMedia()).find(x => x.id === id);
        if (k) stage?.focus?.(k);
        stage?.redraw?.();
        root.querySelectorAll('.us-mark').forEach(li => li.classList.toggle('is-on', li.dataset.id === id));
        root.querySelector(`.us-mark[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }

    // ------------------------------------------------------------ adding media
    function addMenu() {
        const ready = driveReady() || host.demo;
        openDialog(`<div class="us-dlg">
            <h2>Add to this update</h2>
            ${ready ? '' : '<p class="us-warn">Uploading and picking from Drive turn on after the one-time Google Drive setup (CASE-UPDATES-SETUP.md). Until then you can paste a Drive link to a photo, or use a 3D model already on the site.</p>'}
            <div class="us-choices">
                <label class="us-choice${ready ? '' : ' is-off'}"><input type="file" accept="image/*,video/*" multiple data-us-file="media"${ready ? '' : ' disabled'}><strong>Upload photos or videos</strong><span>From this computer or phone. They go into ${esc(A.name)}’s “Website uploads” folder in Drive.</span></label>
                <label class="us-choice${ready ? '' : ' is-off'}"><input type="file" accept=".stl,.obj,.3mf,.glb,.gltf" data-us-file="model"${ready ? '' : ' disabled'}><strong>Upload a 3D model</strong><span>STL, OBJ, 3MF or GLB. Compressed here in the browser first (about a tenth of the size), then uploaded.</span></label>
                <label class="us-choice${ready ? '' : ' is-off'}"><input type="file" multiple accept=".ntop,.step,.stp,.iges,.igs,.sldprt,.sldasm,.f3d,.mix,.pdf,.zip" data-us-file="design"${ready ? '' : ' disabled'}><strong>Upload a design file to download</strong><span>.ntop, STEP, SolidWorks, Fusion, MeshMixer, PDF or zip. Visitors download it from Google Drive.</span></label>
                <button type="button" class="us-choice${driveReady() ? '' : ' is-off'}" data-us="pick"${driveReady() ? '' : ' disabled'}><strong>Google Drive</strong><span>Browse ${esc(A.name)}’s photos, videos, scans and design files. STLs are compressed first.</span></button>
                ${host.siteModels.length ? `<label class="us-choice"><strong>A 3D model already on the site</strong><select data-us="site-model"><option value="">Choose…</option>${host.siteModels.map(f => `<option value="${esc(f.path)}">${esc(f.label)}</option>`).join('')}</select></label>` : ''}
                <form class="us-choice" data-us-form="link"><strong>Paste a Google Drive link</strong><span>The file must be shared with anyone who has the link.</span>
                    <span class="us-row"><input name="link" placeholder="https://drive.google.com/file/d/…" required><select name="kind"><option value="photo">Photo</option><option value="video">Video</option><option value="model">3D model (GLB)</option></select><button type="submit">Add</button></span></form>
            </div>
            <p class="us-error" role="alert"></p>
            <div class="us-form-actions"><button type="button" data-us="close-dlg">Close</button></div>
        </div>`);
        preloadDrive().catch(() => {});
    }

    async function addMedia(item) {
        const list = mediaList();
        const id = host.newKey();
        const value = { kind: item.kind, name: String(item.name || KIND_LABEL[item.kind]).slice(0, 120), order: (list.at(-1)?.order ?? 0) + 1, uid: host.user().uid, at: Date.now(), ...(item.file ? { file: item.file } : {}), ...(item.path ? { path: item.path } : {}), ...(item.bytes ? { bytes: item.bytes } : {}) };
        await host.set(`${host.updatePath(updateId)}/media/${id}`, value);
        return id;
    }

    function track(label) { const b = { label, p: 0 }; busy.push(b); renderRail(); return { set(p, text) { b.p = p; if (text) b.label = text; renderRail(); }, done() { busy = busy.filter(x => x !== b); renderRail(); } }; }

    async function uploadBlob(blob, name, kind) {
        if (host.demo) return { id: demoPut(blob), name, bytes: blob.size };
        const t = track(`Uploading ${name}`);
        try {
            return await uploadFile(blob, { name, mimeType: blob.type || (kind === 'model' ? 'model/gltf-binary' : 'application/octet-stream'), folderId: A.uploadFolder, folderLabel: A.name, hint: host.user().email, onProgress: p => t.set(p, `Uploading ${name} · ${Math.round(p * 100)}%`) });
        } finally { t.done(); }
    }

    async function compress(source, name) {
        const t = track(`Compressing ${name}`);
        try {
            const mc = await import('./model-convert.js');
            const out = await mc.convert(source, name, {}, (text, p) => t.set(p, `${name}: ${text}`));
            out.geometry?.dispose?.();
            return { blob: out.glb, name: mc.outputName(name), stats: out.stats };
        } finally { t.done(); }
    }

    async function handleFiles(files, kindHint) {
        let lastId = '';
        for (const f of files) {
            if (fileKind({ name: f.name, mimeType: f.type }) === 'file') {
                const up = await uploadBlob(f, f.name, 'file');
                lastId = await addMedia({ kind: 'file', file: up.id, name: f.name, bytes: up.bytes });
                continue;
            }
            if (kindHint === 'model' || MODEL_EXT.test(f.name)) {
                const c = /\.glb$/i.test(f.name) ? { blob: f, name: f.name } : await compress(f, f.name);
                const up = await uploadBlob(c.blob, c.name, 'model');
                lastId = await addMedia({ kind: 'model', file: up.id, name: f.name.replace(/\.[^.]+$/, ''), bytes: up.bytes });
            } else {
                const kind = f.type.startsWith('video/') ? 'video' : 'photo';
                const up = await uploadBlob(f, f.name, kind);
                lastId = await addMedia({ kind, file: up.id, name: f.name.replace(/\.[^.]+$/, ''), bytes: up.bytes });
            }
        }
        if (lastId) { current = lastId; mountStage(); renderRail(); }
    }

    async function pickFromDrive() {
        const { openDriveGallery } = await import('./drive-gallery.js?v=2');
        const files = await openDriveGallery({ animal: A, title: U()?.title || '' });
        let lastId = '';
        for (const f of files) {
            const k = fileKind(f);
            if (k === 'mesh') {
                const t = track(`Downloading ${f.name}`);
                let blob;
                try { blob = await downloadPublic(f.id, p => t.set(p, `Downloading ${f.name} · ${Math.round(p * 100)}%`)); } finally { t.done(); }
                const c = await compress(new File([blob], f.name), f.name);
                const up = await uploadBlob(c.blob, c.name, 'model');
                lastId = await addMedia({ kind: 'model', file: up.id, name: f.name.replace(/\.[^.]+$/, ''), bytes: up.bytes });
            } else if (k) {
                lastId = await addMedia({ kind: k, file: f.id, name: f.name.replace(/\.[^.]+$/, ''), bytes: f.bytes });
            }
        }
        if (lastId) { current = lastId; mountStage(); renderRail(); }
    }

    // ------------------------------------------------------------ dialogs (inside the studio)
    const dlg = document.createElement('dialog');
    dlg.className = 'us-dialog';
    function openDialog(html) { dlg.innerHTML = html; if (!dlg.isConnected) root.append(dlg); dlg.showModal(); }
    const dlgError = (err) => { const p = $('.us-error', dlg.open ? dlg : root); if (p) p.textContent = err?.message || String(err); console.warn('Update studio:', err); };

    // ------------------------------------------------------------ events
    root.addEventListener('click', async e => {
        const b = e.target.closest('[data-us]');
        if (!b || b.tagName === 'INPUT' || b.tagName === 'SELECT') return;
        const act = b.dataset.us;
        try {
            if (act === 'close') close();
            else if (act === 'fullscreen') { if (document.fullscreenElement) await document.exitFullscreen(); else await root.requestFullscreen?.(); shellButtons(); }
            else if (act === 'edit') { editing = !editing; if (editing) preloadDrive().catch(() => {}); tool = ''; pending = null; drawing = null; editingText = false; shell(); }
            else if (act === 'go') { current = b.dataset.id; history.replaceState(null, '', `#update/${updateId}${current ? '/' + current : ''}`); mountStage(); renderRail(); }
            else if (act === 'mark') select(b.dataset.id);
            else if (act === 'tool') {
                const t = b.dataset.tool;
                if (t === 'note') { pending = noteGeometry(); tool = ''; refreshTools(); renderNotes(); return; }
                if (t === 'draw') { startDrawing(); return; }
                tool = tool === t ? '' : t;
                pending = null;
                refreshTools(); renderNotes(); stage?.redraw?.();
            } else if (act === 'pen') { pen = b.dataset.c; if (tool === 'draw' && brush === 'erase') brush = 'pen'; refreshTools(); }
            else if (act === 'brush') { brush = b.dataset.b; refreshTools(); }
            else if (act === 'undo') { if (drawing?.history.length) { drawing.items = JSON.parse(drawing.history.pop()); stage?.redraw?.(); refreshDrawingButtons(); } }
            else if (act === 'clear') { if (drawing?.items.length) { drawing.history.push(JSON.stringify(drawing.items)); drawing.items = []; stage?.redraw?.(); refreshDrawingButtons(); } }
            else if (act === 'cancel-draw') { if (!drawing?.items.length || drawing.editId || confirm('Throw away this drawing?')) endDrawing(); }
            else if (act === 'save-draw') await saveDrawing();
            else if (act === 'edit-drawing') { const k = marksOf(curMedia()).find(x => x.id === b.dataset.id); if (k) startDrawing(k); }
            else if (act === 'notelink') openNoteLink(b.dataset.m, b.dataset.k);
            else if (act === 'about-edit') { editingText = true; aboutOpen = true; renderNotes(); }
            else if (act === 'about-cancel') { editingText = false; renderNotes();
            } else if (act === 'cancel-note') { pending = null; renderNotes(); stage?.redraw?.(); }
            else if (act === 'edit-mark') {
                const k = marksOf(curMedia()).find(x => x.id === b.dataset.id);
                const li = b.closest('.us-mark');
                if (k && li) { li.querySelector('.us-mark-body').innerHTML = noteForm(curMedia(), k); li.querySelector('textarea')?.focus(); }
            } else if (act === 'delete-mark') {
                const m = curMedia();
                const k = marksOf(m).find(x => x.id === b.dataset.id);
                if (k && confirm(`Delete note ${k.n}?`)) await host.set(markPath(m, k), null);
            } else if (act === 'add') addMenu();
            else if (act === 'close-dlg') dlg.close();
            else if (act === 'pick') { dlg.close(); await leaveFullscreen(); await pickFromDrive(); }
            else if (act === 'up' || act === 'down') {
                const list = mediaList();
                const i = list.findIndex(m => m.id === b.dataset.id);
                const j = act === 'up' ? i - 1 : i + 1;
                if (list[i] && list[j]) {
                    const base = `${host.updatePath(updateId)}/media/`;
                    await host.set(base + list[i].id + '/order', list[j].order ?? j);
                    await host.set(base + list[j].id + '/order', list[i].order ?? i);
                }
            } else if (act === 'remove-media') {
                const m = mediaList().find(x => x.id === b.dataset.id);
                if (m && confirm(`Remove “${m.caption || m.name}” and its notes from this update? The file stays in Google Drive.`)) {
                    await host.set(`${host.updatePath(updateId)}/media/${m.id}`, null);
                    await host.set(`${host.teamPath(updateId)}/${m.id}`, null).catch(() => {});
                    if (current === m.id) { current = ''; mountStage(); }
                }
            }
        } catch (err) { dlgError(err); }
    });

    function noteGeometry() {
        const m = curMedia();
        if (!m) return null;
        if (m.kind === 'video') return { kind: 'note', t: stage?.time?.() ?? 0 };
        if (m.kind === 'model') return { kind: 'note', view: stage?.view?.() };
        return { kind: 'note' };
    }

    root.addEventListener('change', async e => {
        const t = e.target;
        try {
            if (t.dataset.usFile) { const files = [...t.files]; dlg.close(); await leaveFullscreen(); await handleFiles(files, t.dataset.usFile); }
            else if (t.dataset.us === 'site-model' && t.value) {
                const f = host.siteModels.find(x => x.path === t.value);
                dlg.close();
                const id = await addMedia({ kind: 'model', path: f.path, name: f.label });
                current = id; mountStage(); renderRail();
            } else if (t.dataset.us === 'link-note' && t.value) {
                const ta = t.closest('form').querySelector('textarea');
                const [mId, kId] = t.value.split('/');
                const k = marksOf(mediaList().find(x => x.id === mId)).find(x => x.id === kId);
                const a = ta.selectionStart, z = ta.selectionEnd;
                const words = ta.value.slice(a, z).replace(/[\[\]\n]/g, ' ').trim() || `note ${k?.n || ''}`.trim();
                const link = `[${words.slice(0, 80)}](note:${mId}/${kId})`;
                ta.setRangeText(link, a, z, 'end');
                ta.focus();
                t.value = '';
            } else if (t.dataset.usDraw && drawing) {
                drawing[t.dataset.usDraw] = t.type === 'checkbox' ? t.checked : t.value;
            } else if (t.dataset.us === 'caption') {
                const m = curMedia();
                await host.set(`${host.updatePath(updateId)}/media/${m.id}/caption`, t.value.trim().slice(0, 300) || null);
            }
        } catch (err) { dlgError(err); }
    });

    root.addEventListener('submit', async e => {
        const form = e.target;
        e.preventDefault();
        const err = $('.us-error', form);
        if (err) err.textContent = '';
        try {
            if (form.dataset.usForm === 'about') {
                const text = String(new FormData(form).get('text') || '').trim().slice(0, 4000);
                await host.set(`${host.updatePath(updateId)}/text`, text);
                await host.set(`${host.updatePath(updateId)}/edited`, Date.now());
                editingText = false;
                renderNotes();
                return;
            }
            if (form.dataset.usForm === 'link') {
                const f = Object.fromEntries(new FormData(form));
                const id = driveIdFrom(f.link);
                if (!id) throw new Error('That is not a Google Drive link.');
                dlg.close();
                const mid = await addMedia({ kind: f.kind, file: id, name: KIND_LABEL[f.kind] });
                current = mid; mountStage(); renderRail();
            } else if (form.dataset.usForm === 'mark') {
                const m = curMedia();
                const f = new FormData(form);
                const note = String(f.get('note') || '').trim().slice(0, 1000);
                const decision = f.get('decision') === 'on';
                const existing = form.dataset.id ? marksOf(m).find(x => x.id === form.dataset.id) : null;
                if (existing) {
                    const { id, n, team, ...rest } = existing;
                    await host.set(markPath(m, existing), { ...rest, note, ...(decision ? { decision: true } : { decision: null }), edited: Date.now() });
                    renderNotes(); stage?.redraw?.();
                    return;
                }
                const geo = pending;
                if (!geo) return;
                if (geo.kind !== 'sketch' && !note) throw new Error('Write a note first.');
                const user = host.user();
                const value = {
                    kind: geo.kind, uid: user.uid, author: user.name, at: Date.now(),
                    ...(note ? { note } : {}), ...(decision ? { decision: true } : {}),
                    color: geo.color || pen,
                    ...(geo.x != null ? { x: geo.x, y: geo.y } : {}),
                    ...(geo.t != null ? { t: geo.t } : {}),
                    ...(geo.pos ? { pos: geo.pos, normal: geo.normal } : {}),
                    ...(geo.view ? { view: geo.view } : {}),
                    ...(geo.strokes ? { strokes: geo.strokes } : {}),
                };
                const team = f.get('team') === 'on';
                const id = host.newKey();
                const path = team ? `${host.teamPath(updateId)}/${m.id}/${id}` : `${host.updatePath(updateId)}/media/${m.id}/marks/${id}`;
                await host.set(path, value);
                pending = null;
                selected = id;
                renderNotes(); renderRail(); stage?.redraw?.();
            }
        } catch (error) { if (err) err.textContent = /permission/i.test(error?.message || error?.code || '') ? 'You do not have permission to do that.' : (error?.message || String(error)); else dlgError(error); }
    });

    // Google's sign-in and file picker windows cannot show over a full-screen element.
    async function leaveFullscreen() { if (document.fullscreenElement && !host.demo) { await document.exitFullscreen().catch(() => {}); shellButtons(); } }
    root.addEventListener('input', e => { const t = e.target; if (t.dataset?.usDraw === 'note' && drawing) drawing.note = t.value; });
    root.addEventListener('toggle', e => { if (e.target.matches?.('[data-us-about]')) aboutOpen = e.target.open; }, true);
    function shellButtons() { const b = root.querySelector('[data-us=fullscreen]'); if (b) b.textContent = document.fullscreenElement ? 'Exit full screen' : 'Full screen'; }
    const onFs = () => shellButtons();
    document.addEventListener('fullscreenchange', onFs);
    const onKey = e => {
        if (e.key !== 'Escape' || dlg.open) return;
        if (e.target.closest?.('.us-textbox')) return;
        if (tool === 'draw' && drawing) { e.preventDefault(); if (!drawing.items.length || drawing.editId || confirm('Throw away this drawing?')) endDrawing(); return; }
        if (editingText) { e.preventDefault(); editingText = false; renderNotes(); return; }
        if (tool || pending) { tool = ''; pending = null; refreshTools(); renderNotes(); stage?.redraw?.(); e.preventDefault(); return; }
        if (!document.fullscreenElement) close();
    };
    document.addEventListener('keydown', onKey);

    function close() {
        stage?.dispose?.();
        document.removeEventListener('keydown', onKey);
        document.removeEventListener('fullscreenchange', onFs);
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
        root.remove();
        if (!document.querySelector('.ue')) document.body.classList.remove('us-open'); // the editor may still be open underneath
        host.onClose?.();
        lastFocus?.focus?.();
    }

    // Called by case-updates.js whenever the data changes.
    function refresh() {
        if (!root.isConnected) return;
        if (!U()) { close(); return; }
        const m = curMedia();
        if (current && !m) { current = ''; mountStage(); renderRail(); return; }
        renderRail();
        const typing = root.querySelector('.us-notes textarea:focus, .us-mark textarea:focus, .us-notes select:focus');
        if (!typing && !editingText && tool !== 'draw') renderNotes();
        stage?.redraw?.();
        const t = $('.us-title strong', root); if (t) t.textContent = U().title;
    }

    shell();
    if (edit && host.canEdit()) { editing = true; preloadDrive().catch(() => {}); shell(); }
    if (markId && current) select(markId);   // a link to one note: #update/<u>/<media>/<note>
    $('.us-back', root)?.focus();
    return { refresh, close, get updateId() { return updateId; } };
}
