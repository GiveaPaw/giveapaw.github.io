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
import { driveReady, preloadDrive, thumbUrl, mediaUrl, driveIdFrom, isDriveId, uploadFile, downloadPublic, fileKind, demoPut, demoGet } from './drive-store.js?v=2';

export const PEN_COLORS = ['#ff3fa4', '#ffd400', '#00c2ff', '#3ddc84', '#1b2530'];
const LINE = 3;
const KIND_LABEL = { photo: 'Photo', model: '3D model', video: 'Video' };
const MODEL_EXT = /\.(stl|obj|3mf|glb|gltf)$/i;

const $ = (sel, root = document) => root.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = d => { const t = new Date(String(d) + 'T12:00:00'); return isNaN(t) ? String(d ?? '') : t.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); };
const fmtTime = s => { s = Math.max(0, s || 0); return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`; };
const first = name => String(name || '').split(' ')[0];
const linkify = text => esc(text).replace(/(https:\/\/[^\s<>"]+)/g, m => `<a href="${m}" target="_blank" rel="noopener noreferrer">${m}</a>`);
const paras = text => String(text || '').trim().split(/\n\s*\n/).map(p => `<p>${p.split('\n').map(linkify).join('<br>')}</p>`).join('');
const randomKey = () => Date.now().toString(36) + '-' + crypto.getRandomValues(new Uint32Array(1))[0].toString(36);
const fitRect = (cw, ch, nw, nh) => { if (!nw || !nh) return { x: 0, y: 0, w: cw, h: ch }; const s = Math.min(cw / nw, ch / nh); return { x: (cw - nw * s) / 2, y: (ch - nh * s) / 2, w: nw * s, h: nh * s }; };

// Drawings are stored as one short string: "#rrggbb:x,y x,y;#rrggbb:x,y ..." (0..1 of the picture or view).
export function encodeStrokes(list) {
    let out = list.filter(s => s.p.length).map(s => s.c + ':' + s.p.map(([x, y]) => `${x.toFixed(4)},${y.toFixed(4)}`).join(' ')).join(';');
    // Very long drawings: keep every other point until they fit the 20,000-character limit.
    while (out.length > 19500) {
        list = list.map(s => ({ c: s.c, p: s.p.filter((_, i) => i % 2 === 0 || i === s.p.length - 1) }));
        out = list.map(s => s.c + ':' + s.p.map(([x, y]) => `${x.toFixed(4)},${y.toFixed(4)}`).join(' ')).join(';');
    }
    return out;
}
export function decodeStrokes(str) {
    return String(str || '').split(';').filter(Boolean).map(part => {
        const i = part.indexOf(':');
        const c = part.slice(0, i);
        const p = part.slice(i + 1).split(' ').map(q => q.split(',').map(Number)).filter(a => a.length === 2 && a.every(Number.isFinite));
        return { c: /^#[0-9a-f]{6}$/i.test(c) ? c : PEN_COLORS[0], p };
    });
}
function paint(ctx, strokes, rect, alpha = 1) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.lineWidth = LINE;
    ctx.shadowColor = 'rgba(0,0,0,0.35)'; ctx.shadowBlur = 2;
    for (const s of strokes) {
        ctx.strokeStyle = s.c;
        ctx.beginPath();
        s.p.forEach(([x, y], i) => { const X = rect.x + x * rect.w, Y = rect.y + y * rect.h; if (i) ctx.lineTo(X, Y); else ctx.moveTo(X, Y); });
        if (s.p.length === 1) ctx.lineTo(rect.x + s.p[0][0] * rect.w + 0.5, rect.y + s.p[0][1] * rect.h);
        ctx.stroke();
    }
    ctx.restore();
}

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

export function openStudio(host, { updateId, mediaId = '', edit = false } = {}) {
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
    let pending = null;     // geometry waiting for its note: { kind, x, y, t, pos, normal, view, strokes }
    let drawingStrokes = [];
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
                <div class="us-title"><span>${esc(fmtDate(u.date))}${u.author ? ' · by ' + esc(first(u.author)) : ''}</span><strong>${esc(u.title)}</strong></div>
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
                    ${th ? `<img src="${esc(th)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'us-ricon',textContent:'${m.kind === 'model' ? '3D' : m.kind === 'video' ? '▶' : '🖼'}'}))">` : `<span class="us-ricon">${m.kind === 'model' ? '3D' : m.kind === 'video' ? '▶' : '🖼'}</span>`}
                    <span>${esc(m.caption || m.name || KIND_LABEL[m.kind])}</span>${n ? `<span class="us-rcount">${n}</span>` : ''}${m.kind === 'video' ? '<span class="us-rkind">Video</span>' : m.kind === 'model' ? '<span class="us-rkind">3D</span>' : ''}
                </button>${editing && host.canChange(m) ? `<span class="us-rtools"><button type="button" data-us="up" data-id="${esc(m.id)}" aria-label="Move up"${i === 0 ? ' disabled' : ''}>↑</button><button type="button" data-us="down" data-id="${esc(m.id)}" aria-label="Move down"${i === list.length - 1 ? ' disabled' : ''}>↓</button><button type="button" data-us="remove-media" data-id="${esc(m.id)}" aria-label="Remove from the update">✕</button></span>` : ''}</div>`;
            }).join('')}
            ${editing ? `<button type="button" class="us-add" data-us="add">+ Add photos, videos or 3D</button>` : ''}
            ${busy.map(b => `<div class="us-busy"><span>${esc(b.label)}</span><span class="us-bar"><i style="width:${Math.round(b.p * 100)}%"></i></span></div>`).join('')}`;
    }

    // ------------------------------------------------------------ stage
    function mountStage() {
        stage?.dispose?.();
        stage = null;
        tool = ''; pending = null; drawingStrokes = []; selected = '';
        const box = $('.us-stage', root);
        const m = curMedia();
        if (!m) { current = ''; box.innerHTML = textScreen(); renderNotes(); return; }
        box.innerHTML = `
            <div class="us-view" data-kind="${m.kind}"><div class="us-media"></div><canvas class="us-sketch"></canvas><div class="us-pins"></div><p class="us-msg" hidden></p></div>
            ${m.kind === 'video' ? '<div class="us-timeline" aria-label="Notes on this video"><div class="us-track"></div></div>' : ''}
            ${toolbarHTML(m)}
            ${editing && host.canChange(m) ? `<label class="us-caption-edit">Caption <input data-us="caption" maxlength="300" value="${esc(m.caption || '')}" placeholder="What this shows"></label>` : m.caption ? `<p class="us-caption">${esc(m.caption)}</p>` : ''}`;
        stage = ({ photo: photoStage, model: modelStage, video: videoStage })[m.kind](m, $('.us-view', box));
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
        if (!editing) return '';
        const where = m.kind === 'video' ? 'at this moment' : m.kind === 'model' ? 'from this angle' : '';
        return `<div class="us-tools" role="toolbar" aria-label="Annotation tools">
            <button type="button" data-us="tool" data-tool="pin" aria-pressed="${tool === 'pin'}">📍 Pin</button>
            <button type="button" data-us="tool" data-tool="draw" aria-pressed="${tool === 'draw'}">✏️ Draw</button>
            <button type="button" data-us="tool" data-tool="note" aria-pressed="${tool === 'note'}">💬 Note ${where}</button>
            <span class="us-colors">${PEN_COLORS.map(c => `<button type="button" data-us="pen" data-c="${c}" style="--c:${c}" aria-label="Pen colour" aria-pressed="${c === pen}"></button>`).join('')}</span>
            ${tool === 'draw' ? '<button type="button" data-us="undo">Undo</button><button type="button" class="us-primary" data-us="done-draw">Done drawing</button>' : ''}
            <span class="us-toolhint">${tool === 'pin' ? (m.kind === 'model' ? 'Click the model where something should change.' : 'Click the spot to pin.') : tool === 'draw' ? (m.kind === 'model' ? 'Draw over this view. It shows again whenever someone looks from this angle.' : m.kind === 'video' ? 'The video paused; draw on this frame.' : 'Draw on the picture.') : ''}</span>
        </div>`;
    }
    const refreshTools = () => { const m = curMedia(); const t = $('.us-tools', root); if (t && m) t.outerHTML = toolbarHTML(m); stage?.setTool?.(tool); };

    // Shared overlay: sketch canvas + pin buttons over the media's content rectangle.
    function overlay(view, getRect) {
        const canvas = $('.us-sketch', view);
        const pinsEl = $('.us-pins', view);
        const ctx = canvas.getContext('2d');
        let rect = { x: 0, y: 0, w: 1, h: 1 };
        let stroke = null;
        const size = () => {
            const r = view.getBoundingClientRect();
            const dpr = Math.min(devicePixelRatio || 1, 2);
            canvas.width = Math.round(r.width * dpr); canvas.height = Math.round(r.height * dpr);
            canvas.style.width = r.width + 'px'; canvas.style.height = r.height + 'px';
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            rect = getRect(r.width, r.height);
        };
        const pointAt = e => { const r = view.getBoundingClientRect(); return [(e.clientX - r.left - rect.x) / rect.w, (e.clientY - r.top - rect.y) / rect.h]; };
        const inside = ([x, y]) => x >= 0 && x <= 1 && y >= 0 && y <= 1;
        canvas.addEventListener('pointerdown', e => {
            if (tool === 'draw') {
                const p = pointAt(e);
                stroke = { c: pen, p: [p.map(v => Math.min(1, Math.max(0, v)))] };
                drawingStrokes.push(stroke);
                canvas.setPointerCapture(e.pointerId);
                e.preventDefault();
            } else if (tool === 'pin' && stage?.pinAt) {
                const p = pointAt(e);
                if (inside(p)) stage.pinAt(p);
            }
        });
        canvas.addEventListener('pointermove', e => {
            if (!stroke) return;
            const p = pointAt(e).map(v => Math.min(1, Math.max(0, v)));
            const last = stroke.p.at(-1);
            if (Math.hypot((p[0] - last[0]) * rect.w, (p[1] - last[1]) * rect.h) < 3) return;
            stroke.p.push(p);
            redraw();
        });
        const end = () => { stroke = null; };
        canvas.addEventListener('pointerup', end);
        canvas.addEventListener('pointercancel', end);
        const ro = new ResizeObserver(() => { size(); redraw(); });
        ro.observe(view);
        size();
        function redraw() {
            const r = view.getBoundingClientRect();
            ctx.clearRect(0, 0, r.width, r.height);
            const m = curMedia();
            const marks = marksOf(m);
            for (const k of marks) if (k.kind === 'sketch' && stage?.visible(k)) paint(ctx, decodeStrokes(k.strokes), rect, selected && selected !== k.id ? 0.45 : 1);
            if (pending?.strokes) paint(ctx, decodeStrokes(pending.strokes), rect);
            if (drawingStrokes.length) paint(ctx, drawingStrokes, rect);
            // Pins (photo and video; models draw their own on the surface).
            if (stage?.flatPins) {
                const pins = marks.filter(k => k.kind === 'pin' && stage.visible(k));
                if (pending?.kind === 'pin' && pending.x != null) pins.push({ id: '__new', n: '+', x: pending.x, y: pending.y, color: pen });
                pinsEl.innerHTML = pins.map(k => `<button type="button" class="us-pin${k.id === selected ? ' is-on' : ''}${k.decision ? ' is-decision' : ''}" data-us="mark" data-id="${esc(k.id)}" style="left:${rect.x + k.x * rect.w}px;top:${rect.y + k.y * rect.h}px;--c:${esc(k.color || PEN_COLORS[0])}" aria-label="Note ${k.n}">${k.n}</button>`).join('');
            }
        }
        return { redraw, size, setActive: on => { canvas.style.pointerEvents = on ? 'auto' : 'none'; canvas.style.cursor = tool === 'draw' ? 'crosshair' : tool === 'pin' ? 'copy' : ''; }, dispose: () => ro.disconnect(), get rect() { return rect; } };
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
            focus(k) { v.pause(); v.currentTime = k.t || 0; ov.redraw(); },
            time: () => +v.currentTime.toFixed(2),
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
        const ov = overlay(view, (w, h) => ({ x: 0, y: 0, w, h }));
        message(view, 'Loading the 3D model…');
        viewer.setModel('main', src).then(() => { viewer.frame('main'); message(view, ''); syncPins(); ov.redraw(); })
            .catch(() => message(view, 'This 3D model could not be loaded. Check that the Drive file is shared with anyone who has the link.'));
        viewer.onChange(() => ov.redraw());
        const near = k => {
            if (!k.view) return true;
            const v = viewer.getView();
            const d = Math.hypot(...v.position.map((p, i) => p - k.view.position[i])) + Math.hypot(...v.target.map((p, i) => p - k.view.target[i]));
            const reach = Math.hypot(...k.view.position.map((p, i) => p - k.view.target[i])) || 1;
            return d < reach * 0.06;
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
            focus(k) { if (k.view) viewer.flyTo(k.view); syncPins(); },
            view: () => viewer.getView(),
            redraw: () => { syncPins(); ov.redraw(); },
            dispose: () => { ov.dispose(); viewer.dispose(); },
        };
    }

    function message(view, text) { const p = $('.us-msg', view); if (p) { p.textContent = text; p.hidden = !text; } }

    // ------------------------------------------------------------ notes column
    function renderNotes() {
        const aside = $('.us-notes', root);
        if (!aside) return;
        const u = U();
        const m = curMedia();
        const marks = marksOf(m);
        const what = m ? ({ photo: 'photo', model: '3D model', video: 'video' })[m.kind] : '';
        aside.innerHTML = `
            ${m ? `<details class="us-about"><summary>About this update</summary><div>${paras(u.text) || '<p>No text.</p>'}</div></details>` : ''}
            ${m ? `<div class="us-notes-head"><h3>Notes on this ${what}</h3><span>${marks.length}</span></div>
            ${marks.length ? `<ol class="us-marks">${marks.map(k => markRow(m, k)).join('')}</ol>` : `<p class="us-empty">${editing ? `Use Pin, Draw or Note to mark ${m.kind === 'video' ? 'moments that' : 'what'} guided the design.` : 'No notes on this one yet.'}</p>`}
            ${editing ? noteForm(m) : ''}` : `<div class="us-notes-head"><h3>In this update</h3><span>${mediaList().length}</span></div>
            <p class="us-empty">${mediaList().length ? 'Pick a photo, video or 3D model on the left to see its notes.' : 'Nothing attached yet.'}</p>`}`;
        $('.us-form textarea', aside)?.focus();
    }

    function markRow(m, k) {
        const where = m.kind === 'video' ? `<button type="button" class="us-time" data-us="mark" data-id="${esc(k.id)}">${fmtTime(k.t)}</button>` : '';
        const icon = k.kind === 'sketch' ? '✏️' : k.kind === 'pin' ? '' : '💬';
        return `<li class="us-mark${k.id === selected ? ' is-on' : ''}${k.decision ? ' is-decision' : ''}" data-id="${esc(k.id)}">
            <button type="button" class="us-num" data-us="mark" data-id="${esc(k.id)}" style="--c:${esc(k.color || '#003262')}" aria-label="Show note ${k.n}">${k.n}</button>
            <div class="us-mark-body">
                <div class="us-mark-meta">${where}${icon ? `<span>${icon}</span>` : ''}${k.decision ? '<span class="us-badge us-badge-gold">Decision</span>' : ''}${k.team ? '<span class="us-badge">Team only</span>' : ''}<span class="us-by">${esc(first(k.author))}</span></div>
                ${k.note ? `<p>${linkify(k.note)}</p>` : `<p class="us-muted">${k.kind === 'sketch' ? 'Drawing' : 'Pin'}${m.kind === 'model' && k.view ? ' — click the number to see it from its angle' : ''}</p>`}
                ${editing && host.canChange(k) ? `<div class="us-mark-actions"><button type="button" data-us="edit-mark" data-id="${esc(k.id)}">Edit</button><button type="button" data-us="delete-mark" data-id="${esc(k.id)}">Delete</button></div>` : ''}
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
            return await uploadFile(blob, { name, mimeType: blob.type || (kind === 'model' ? 'model/gltf-binary' : undefined), folderId: A.uploadFolder, folderLabel: A.name, hint: host.user().email, onProgress: p => t.set(p, `Uploading ${name} · ${Math.round(p * 100)}%`) });
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
        const { openDriveGallery } = await import('./drive-gallery.js?v=1');
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
            else if (act === 'edit') { editing = !editing; if (editing) preloadDrive().catch(() => {}); tool = ''; pending = null; drawingStrokes = []; shell(); }
            else if (act === 'go') { current = b.dataset.id; history.replaceState(null, '', `#update/${updateId}${current ? '/' + current : ''}`); mountStage(); renderRail(); }
            else if (act === 'mark') select(b.dataset.id);
            else if (act === 'tool') {
                const t = b.dataset.tool;
                if (t === 'note') { pending = noteGeometry(); tool = ''; refreshTools(); renderNotes(); return; }
                tool = tool === t ? '' : t;
                if (tool !== 'draw') drawingStrokes = [];
                pending = null;
                refreshTools(); renderNotes(); stage?.redraw?.();
            } else if (act === 'pen') { pen = b.dataset.c; refreshTools(); }
            else if (act === 'undo') { drawingStrokes.pop(); stage?.redraw?.(); }
            else if (act === 'done-draw') {
                if (!drawingStrokes.length) { tool = ''; refreshTools(); return; }
                pending = { ...noteGeometry(), kind: 'sketch', strokes: encodeStrokes(drawingStrokes), color: drawingStrokes[0].c };
                drawingStrokes = []; tool = ''; refreshTools(); renderNotes(); stage?.redraw?.();
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
    function shellButtons() { const b = root.querySelector('[data-us=fullscreen]'); if (b) b.textContent = document.fullscreenElement ? 'Exit full screen' : 'Full screen'; }
    const onFs = () => shellButtons();
    document.addEventListener('fullscreenchange', onFs);
    const onKey = e => {
        if (e.key !== 'Escape' || dlg.open) return;
        if (tool || pending) { tool = ''; pending = null; drawingStrokes = []; refreshTools(); renderNotes(); stage?.redraw?.(); e.preventDefault(); return; }
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
        const typing = root.querySelector('.us-notes textarea:focus, .us-mark textarea:focus');
        if (!typing) renderNotes();
        stage?.redraw?.();
        const t = $('.us-title strong', root); if (t) t.textContent = U().title;
    }

    shell();
    if (edit && host.canEdit()) { editing = true; preloadDrive().catch(() => {}); shell(); }
    $('.us-back', root)?.focus();
    return { refresh, close, get updateId() { return updateId; } };
}
