// Presentation editor for design reviews (reviews/*.json, opened by design-review.html?review=…).
//
// It edits the review file in place and keeps every field it does not show (stop points, paint and leg
// settings, colours…), so a file can go back and forth between this editor, the presenter's
// "download with my stop points", and hand edits. Screen ids are never changed: the review page stores
// each reviewer's notes under them.
//
// Saving writes the file through the local preview server (tools/range_server.py, POST /__editor/save),
// which keeps the previous version in reviews/_backups/. Without that server (e.g. on the published
// site) Save falls back to downloading the file.

import { createGallery } from './review-gallery.js?v=6';

const TOOL_KEYS = [
    ['pin', 'Pin comments'], ['measure', 'Measure'], ['section', 'Section cut'],
    ['grid', 'Grid toggle'], ['cube', 'View cube toggle'], ['snapshot', 'Snapshot'], ['fit', 'Fit view'], ['help', 'Controls help'],
    ['layers', 'Show / hide parts'], ['alpha', 'See-through (T)'], ['tabs', 'View tabs'], ['draw', 'Draw on video'],
    ['paint', 'Paint the surface'], ['pipe', 'Change pipe length'],
];
const DEFAULT_TOOLS = ['pin', 'measure', 'section', 'layers', 'alpha', 'tabs', 'draw'];
const TAB_ICONS = [['box', '3D model'], ['film', 'Video'], ['columns-2', 'Side by side'], ['image', 'Picture'], ['paintbrush', 'Paint'], ['ruler', 'Ruler'], ['sliders-horizontal', 'Slider'], ['list-video', 'Playlist'], ['layers', 'Layers'], ['scan-eye', 'Look']];
const SOURCE_KIND = {
    assembly: ['box', '3D model'], sweep: ['sliders-horizontal', 'Slider of models'], video: ['film', 'Video'],
    playlist: ['list-video', 'Videos & pictures'], image: ['image', 'Pictures'], pending: ['hourglass', 'Placeholder'],
};
const DRAFT_KEY = 'editor-preview';
const DEFAULT_FILE = 'reviews/ollie-fit-review.json';

// ---- small helpers -------------------------------------------------------------------------------

const $ = sel => document.querySelector(sel);
function h(tag, props, ...kids) {
    const node = document.createElement(tag);
    Object.entries(props || {}).forEach(([key, value]) => {
        if (value === null || value === undefined || value === false) return;
        if (key === 'class') node.className = value;
        else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
        else if (key === 'dataset') Object.assign(node.dataset, value);
        else if (['value', 'checked', 'textContent', 'title', 'type', 'name', 'placeholder', 'disabled', 'rows', 'selected'].includes(key)) node[key] = value;
        else node.setAttribute(key, value === true ? '' : value);
    });
    kids.flat(Infinity).forEach(kid => { if (kid !== null && kid !== undefined && kid !== false) node.append(kid instanceof Node ? kid : document.createTextNode(String(kid))); });
    return node;
}
const ic = name => h('i', { 'data-lucide': name, 'aria-hidden': 'true' });
const icons = () => window.lucide?.createIcons({ attrs: { 'stroke-width': 1.8 } });
const slug = text => String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'item';
const move = (list, from, to) => list.splice(to, 0, list.splice(from, 1)[0]);
const clone = value => JSON.parse(JSON.stringify(value));
function uniqueKey(base, taken) {
    let key = slug(base), n = 2;
    while (taken.has(key)) key = `${slug(base)}-${n++}`;
    return key;
}
let toastTimer = 0;
function toast(message, { error = false, ms = 3200 } = {}) {
    const node = $('#ed-toast');
    node.textContent = message;
    node.classList.toggle('error', error);
    node.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { node.hidden = true; }, ms);
}
function store(action, key, value) {
    try {
        if (action === 'get') return localStorage.getItem(key);
        if (action === 'set') localStorage.setItem(key, value);
        if (action === 'del') localStorage.removeItem(key);
    } catch { /* private mode or full: the editor still works, just without crash recovery */ }
    return null;
}

// ---- state ----------------------------------------------------------------------------------------

const params = new URLSearchParams(location.search);
const S = {
    path: params.get('file') || DEFAULT_FILE,
    doc: null,
    savedText: '',
    sel: 'settings',          // 'settings' or a screen object in doc.items
    undo: [], redo: [],
    lastEdit: 0,
    media: [], reviews: [], localServer: false,
    preview: true,
    mode: 'edit',              // 'edit' or 'present'
    outline: true,
    previewW: null,            // px; null = 40 % of the window
};
// Layout choices (outline, preview, divider position) are remembered in this browser.
const LAYOUT_KEY = 'gap-review-editor-layout';
try { Object.assign(S, JSON.parse(localStorage.getItem(LAYOUT_KEY)) || {}); } catch { /* none saved */ }
S.mode = 'edit';
function saveLayout() { store('set', LAYOUT_KEY, JSON.stringify({ preview: S.preview, outline: S.outline, previewW: S.previewW })); }
const wipKey = () => 'gap-review-editor-wip:' + S.path;
const docText = () => JSON.stringify(S.doc);
const dirty = () => docText() !== S.savedText;

// Every change goes through edit(): it records undo history (typing is grouped into ~1 s bursts),
// remembers unsaved work in case the app is closed, and refreshes the preview.
function edit(fn, { structural = false } = {}) {
    const now = Date.now();
    if (structural || now - S.lastEdit > 1200) pushUndo();
    S.lastEdit = structural ? 0 : now;
    fn();
    changed();
    if (structural) renderAll();
}
function pushUndo() {
    const text = docText();
    if (S.undo[S.undo.length - 1] !== text) S.undo.push(text);
    if (S.undo.length > 150) S.undo.shift();
    S.redo = [];
}
function restore(text) {
    const selId = S.sel === 'settings' ? null : S.sel.id;
    S.doc = JSON.parse(text);
    S.sel = (selId && S.doc.items.find(it => it.id === selId)) || (selId ? S.doc.items[0] : 'settings') || 'settings';
    S.lastEdit = 0;
    changed();
    renderAll();
}
function undo() { if (!S.undo.length) return; S.redo.push(docText()); restore(S.undo.pop()); }
function redo() { if (!S.redo.length) return; S.undo.push(docText()); restore(S.redo.pop()); }

function changed() {
    const isDirty = dirty();
    const status = $('#ed-status');
    status.textContent = isDirty ? 'Unsaved changes' : 'Saved';
    status.className = 'ed-status ' + (isDirty ? 'dirty' : 'saved');
    $('#ed-undo').disabled = !S.undo.length;
    $('#ed-redo').disabled = !S.redo.length;
    if (isDirty) store('set', wipKey(), JSON.stringify({ at: Date.now(), text: docText(), base: S.fileSha }));
    else if ($('#ed-banner').hidden) store('del', wipKey()); // keep it while "Restore them?" is still on screen
    store('set', 'gap-review-draft:' + DRAFT_KEY, docText());
    schedulePreview();
    const row = S.sel !== 'settings' && document.querySelector(`.ed-row[data-index="${S.doc.items.indexOf(S.sel)}"]`);
    if (row) {
        row.querySelector('.ed-row-title').textContent = S.sel.title || 'Untitled screen';
        row.querySelector('.ed-row-sub').textContent = screenSummary(S.sel);
    }
}

// ---- loading and saving --------------------------------------------------------------------------

async function loadFileList() {
    try {
        const response = await fetch('/__editor/files', { cache: 'no-cache' });
        if (!response.ok) throw new Error(response.status);
        const data = await response.json();
        S.media = data.media || [];
        S.reviews = data.reviews || [];
        S.localServer = true;
    } catch {
        S.localServer = false;
        S.reviews = [S.path];
    }
    if (!S.reviews.includes(S.path)) S.reviews.unshift(S.path);
    const select = $('#ed-file');
    select.replaceChildren(...S.reviews.map(path => h('option', { value: path, selected: path === S.path }, path.replace(/^reviews\//, ''))));
    const fill = (id, pattern) => $(id).replaceChildren(...S.media.filter(f => pattern.test(f)).map(f => h('option', { value: f })));
    fill('#dl-models', /\.(glb|gltf|stl|obj)$/i);
    fill('#dl-videos', /\.(mp4|webm|mov|m4v)$/i);
    fill('#dl-images', /\.(jpe?g|png|webp|gif|svg)$/i);
    fill('#dl-clips', /\.(mp4|webm|mov|m4v|jpe?g|png|webp|gif|svg)$/i);
}
// SHA-256 of the file's bytes: the server refuses a save when the file changed since the editor read it.
async function sha256(buffer) {
    if (!crypto?.subtle) return '';
    return [...new Uint8Array(await crypto.subtle.digest('SHA-256', buffer))].map(b => b.toString(16).padStart(2, '0')).join('');
}
async function readFile() {
    const response = await fetch(S.path, { cache: 'no-cache' });
    if (!response.ok) throw new Error(`Could not open ${S.path} (${response.status}).`);
    const buffer = await response.arrayBuffer();
    return { sha: await sha256(buffer), doc: JSON.parse(new TextDecoder().decode(buffer)) };
}
// Coming back to the editor: if the file changed on disk (another tab, or edited outside the editor), pick
// up the newer version when nothing is unsaved here, or say so when there is.
let checkingDisk = false;
async function checkDisk() {
    if (checkingDisk || !S.localServer || !S.fileSha || !S.doc) return;
    checkingDisk = true;
    try {
        const { sha, doc } = await readFile();
        if (sha === S.fileSha) return;
        if (!dirty()) {
            S.doc = doc;
            S.doc.items ||= [];
            S.fileSha = sha;
            S.savedText = docText();
            S.sel = (S.sel !== 'settings' && S.doc.items.find(i => i.id === S.sel?.id)) || S.doc.items[0] || 'settings';
            S.undo = []; S.redo = [];
            renderAll();
            changed();
            refreshPreview();
            toast('This presentation was changed outside this tab; the newer version is loaded.', { ms: 5000 });
        } else {
            const banner = $('#ed-banner');
            banner.replaceChildren(
                h('span', {}, ic('triangle-alert'), ` ${S.path.split('/').pop()} was changed outside this tab, and you have unsaved edits here. Saving would replace the other changes.`),
                h('button', { type: 'button', class: 'ed-btn ed-primary ed-mini', onclick: () => { if (confirm('Load the newer file and drop the unsaved edits in this tab?')) { store('del', wipKey()); location.reload(); } } }, 'Load the newer file'),
                h('button', { type: 'button', class: 'ed-btn ed-mini', onclick: () => { banner.hidden = true; } }, 'Keep editing'));
            banner.hidden = false;
            icons();
        }
    } catch { /* offline or mid-write: try again next time */ } finally { checkingDisk = false; }
}
window.addEventListener('focus', checkDisk);
document.addEventListener('visibilitychange', () => { if (!document.hidden) checkDisk(); });
async function loadReview() {
    const file = await readFile();
    S.doc = file.doc;
    S.fileSha = file.sha;
    S.doc.items ||= [];
    S.savedText = docText();
    const wanted = new URLSearchParams(location.search).get('screen');
    S.sel = (wanted && S.doc.items.find(it => it.id === wanted)) || S.doc.items[0] || 'settings';
    const wip = (() => { try { return JSON.parse(store('get', wipKey())); } catch { return null; } })();
    if (wip?.text && wip.text !== S.savedText) {
        const banner = $('#ed-banner');
        // Edits made to an older version of the file would bring back that old version when saved.
        const stale = !wip.base || wip.base !== S.fileSha;
        banner.replaceChildren(
            h('span', {}, ic('history'), ` You have unsaved edits to this presentation from ${new Date(wip.at).toLocaleString()}.`,
                stale ? h('strong', {}, ' The file has changed since then: restoring them would undo those newer changes (screens or settings added since).') : null),
            h('button', { type: 'button', class: 'ed-btn ed-mini' + (stale ? '' : ' ed-primary'), onclick: () => {
                if (stale && !confirm('These edits were made to an older version of the file. Restoring them replaces the current file contents in this tab (screens or settings added since would be lost when you save). Restore anyway?')) return;
                pushUndo(); restore(wip.text); banner.hidden = true; toast('Unsaved edits restored');
            } }, 'Restore them'),
            h('button', { type: 'button', class: 'ed-btn ed-mini', onclick: () => { store('del', wipKey()); banner.hidden = true; } }, 'Discard'),
        );
        banner.hidden = false;
    }
}
function fileBlob() { return new Blob([JSON.stringify(S.doc, null, 2) + '\n'], { type: 'application/json' }); }
function download(name = S.path.split('/').pop()) {
    const url = URL.createObjectURL(fileBlob());
    const a = h('a', { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function save(path = S.path, { force = false } = {}) {
    if (!S.localServer) {
        download(path.split('/').pop());
        toast(`Downloaded ${path.split('/').pop()}. Saving straight into the site needs the local preview server; put the file in reviews/.`, { ms: 6000 });
        return false;
    }
    try {
        const base = path === S.path ? S.fileSha : '';
        const response = await fetch('/__editor/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path, review: S.doc, base, force }) });
        const result = await response.json().catch(() => ({}));
        if (response.status === 409 && result.conflict) {
            const overwrite = confirm(`${path.split('/').pop()} was changed after this tab opened it (in another editor tab, or outside the editor).\n\nOK: save anyway and replace those changes (the replaced version is kept in reviews/_backups).\nCancel: don't save. Reload this tab to get the newer file.`);
            return overwrite ? save(path, { force: true }) : false;
        }
        if (!response.ok) throw new Error(result.error || `Save failed (${response.status}).`);
        S.path = path;
        if (result.sha) S.fileSha = result.sha;
        S.savedText = docText();
        $('#ed-banner').hidden = true;
        changed();
        toast(result.backup ? `Saved. The previous version is in ${result.backup}.` : `Saved ${path}.`);
        return true;
    } catch (error) {
        toast(error.message, { error: true, ms: 6000 });
        return false;
    }
}
async function saveAs() {
    const name = prompt('Name for the new presentation file (lowercase, dashes):', slug((S.doc.title || 'review') + ' copy'));
    if (!name) return;
    const path = `reviews/${slug(name)}.json`;
    if (S.reviews.includes(path) && !confirm(`${path} already exists. Replace it?`)) return;
    pushUndo();
    // A new file is a new presentation: its own id keeps reviewers' notes separate from the original's.
    S.doc.id = slug(name);
    if (await save(path)) {
        store('del', 'gap-review-editor-wip:' + path);
        history.replaceState(null, '', `?file=${encodeURIComponent(path)}`);
        await loadFileList();
    }
}

// ---- preview -------------------------------------------------------------------------------------

let previewTimer = 0;
function previewUrl() {
    const url = new URL('design-review.html', location.href);
    url.searchParams.set('review', 'draft:' + DRAFT_KEY);
    url.searchParams.set('host', '1');
    if (S.sel !== 'settings' && !S.sel.hidden) url.searchParams.set('item', S.sel.id);
    return url.pathname + url.search;
}
function refreshPreview() {
    if (!S.preview && S.mode !== 'present') return;
    const frame = $('#ed-frame');
    const next = previewUrl();
    // Compare with what the frame has actually loaded: a reload issued right after a navigation would
    // otherwise cancel it and bring back the previous screen.
    let loaded = null;
    try { loaded = frame.contentWindow.location.pathname + frame.contentWindow.location.search; } catch { /* not loaded yet */ }
    frame.setAttribute('src', next);
    if (loaded === next) frame.contentWindow.location.reload();
    else if (loaded && loaded !== 'about:blank' && frame.contentWindow) frame.contentWindow.location.replace(next);
}
function schedulePreview() { clearTimeout(previewTimer); previewTimer = setTimeout(refreshPreview, 900); }
const PREVIEW_WIDTH = 1280;
function fitPreview() {
    const box = $('.ed-frame-box');
    const frame = $('#ed-frame');
    if (!box.clientWidth) return;
    // The side preview imitates a laptop-width window, scaled down; Present mode and full screen run at
    // true size, as the audience will see it.
    const actual = S.mode === 'present' || !!document.fullscreenElement;
    const scale = actual ? 1 : Math.min(1, box.clientWidth / PREVIEW_WIDTH);
    frame.style.width = `${box.clientWidth / scale}px`;
    frame.style.height = `${box.clientHeight / scale}px`;
    frame.style.transform = `scale(${scale})`;
}
new ResizeObserver(fitPreview).observe($('.ed-frame-box'));
// ---- layout: outline | form | divider | preview, Edit / Present, full screen ----------------------
const OUTLINE_W = 270;
const MIN_FORM = 360;
const MIN_PREVIEW = 320;
function layout() {
    const app = $('.ed-app');
    const width = app.clientWidth || innerWidth;
    const present = S.mode === 'present';
    const narrow = innerWidth < 900;
    app.classList.toggle('mode-present', present);
    app.classList.toggle('no-outline', !S.outline);
    app.classList.toggle('no-preview', !S.preview);
    app.classList.toggle('narrow', narrow);
    let cols;
    if (present) cols = ['minmax(0, 1fr)'];
    else if (innerWidth < 760) cols = ['minmax(0, 1fr)'];
    else {
        cols = [];
        if (S.outline) cols.push(`${OUTLINE_W}px`);
        cols.push('minmax(0, 1fr)');
        if (S.preview && !narrow) {
            const room = width - (S.outline ? OUTLINE_W : 0) - 6;
            const wanted = S.previewW ?? Math.round(width * 0.4);
            const previewW = Math.max(MIN_PREVIEW, Math.min(room - MIN_FORM, wanted));
            cols.push('6px', `${previewW}px`);
        }
    }
    app.style.gridTemplateColumns = cols.join(' ');
    $('#ed-toggle-preview').classList.toggle('active', S.preview);
    $('#ed-toggle-preview').disabled = present;
    $('#ed-toggle-outline').classList.toggle('active', S.outline && !present);
    $('#ed-toggle-outline').setAttribute('aria-pressed', String(S.outline));
    $('#ed-toggle-outline').disabled = present;
    document.querySelectorAll('.ed-mode [data-mode]').forEach(b => b.classList.toggle('active', b.dataset.mode === S.mode));
    $('#ed-preview-title').textContent = present ? 'Presenting' : 'Preview';
    $('#ed-preview-title').classList.toggle('ed-preview-title-present', present);
    $('#ed-preview-hint').textContent = present ? 'Your unsaved edits included · Edit (Ctrl+E) to go back' : 'Updates as you edit';
    fitPreview();
}
addEventListener('resize', layout);
function setPreview(on) {
    S.preview = on;
    saveLayout();
    layout();
    if (on || S.mode === 'present') refreshPreview();
    else $('#ed-frame').removeAttribute('src');
}
function setOutline(on) {
    S.outline = on;
    saveLayout();
    layout();
}
// The presentation's Edit button (Present mode / full screen): back to editing, on the screen it showed.
addEventListener('message', event => {
    if (event.origin !== location.origin || event.source !== $('#ed-frame')?.contentWindow || event.data?.type !== 'gap-edit-screen') return;
    if (document.fullscreenElement) document.exitFullscreen?.();
    setMode('edit');
    const item = S.doc?.items.find(it => it.id === event.data.id);
    if (item && item !== S.sel) select(item);
});
function setMode(mode) {
    if (mode === S.mode) return;
    S.mode = mode;
    layout();
    if (mode === 'present' || S.preview) refreshPreview();
    if (mode === 'present') $('#ed-frame').focus();
}
function toggleFullscreen() {
    const box = $('.ed-frame-box');
    if (document.fullscreenElement) { document.exitFullscreen?.(); return; }
    if (!box.requestFullscreen) { setMode('present'); toast('Full screen is not available in this browser, so the editor switched to Present mode.'); return; }
    // Some embedded windows neither grant nor refuse full screen; fall back to Present mode after a moment.
    let settled = false;
    const fallback = () => {
        if (settled || document.fullscreenElement) return;
        settled = true;
        setMode('present');
        toast('This window does not allow full screen, so the editor switched to Present mode instead.', { ms: 5000 });
    };
    box.requestFullscreen().then(() => { settled = true; $('#ed-frame').focus(); }).catch(fallback);
    setTimeout(fallback, 1000);
}
document.addEventListener('fullscreenchange', () => {
    const full = !!document.fullscreenElement;
    const button = $('#ed-fullscreen');
    button.replaceChildren(ic(full ? 'minimize' : 'maximize'));
    button.title = full ? 'Leave full screen (Esc)' : 'Full screen (Esc to leave)';
    icons();
    fitPreview();
});
(function wireSplitter() {
    const splitter = $('.ed-splitter');
    const app = $('.ed-app');
    splitter.addEventListener('pointerdown', event => {
        if (event.button !== 0) return;
        event.preventDefault();
        try { splitter.setPointerCapture(event.pointerId); } catch { /* synthetic */ }
        splitter.classList.add('dragging');
        app.classList.add('resizing');
        document.body.classList.add('resizing');
        const right = app.getBoundingClientRect().right;
        const move = ev => { S.previewW = Math.round(right - ev.clientX - 3); layout(); };
        const end = () => {
            splitter.removeEventListener('pointermove', move);
            splitter.classList.remove('dragging');
            app.classList.remove('resizing');
            document.body.classList.remove('resizing');
            // Keep the value the layout actually used, so the next drag starts where the divider is.
            S.previewW = Math.round($('.ed-preview').getBoundingClientRect().width);
            saveLayout();
        };
        splitter.addEventListener('pointermove', move);
        splitter.addEventListener('pointerup', end, { once: true });
        splitter.addEventListener('pointercancel', end, { once: true });
    });
    splitter.addEventListener('dblclick', () => { S.previewW = null; saveLayout(); layout(); toast('Preview width reset'); });
    splitter.addEventListener('keydown', event => {
        const step = event.shiftKey ? 80 : 24;
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        S.previewW = Math.round($('.ed-preview').getBoundingClientRect().width) + (event.key === 'ArrowLeft' ? step : -step);
        layout();
        S.previewW = Math.round($('.ed-preview').getBoundingClientRect().width);
        saveLayout();
    });
})();

// ---- screen list ---------------------------------------------------------------------------------

function screenSummary(item) {
    if (item.kind === 'stage') return (item.views || []).map(v => v.label).join(' · ') || 'No tabs yet';
    if (item.kind === 'compare') return 'Current vs proposed';
    return SOURCE_KIND[item.kind]?.[1] || item.kind;
}
function sortable(rows, onMove, { needsGrip = true } = {}) {
    let from = null;
    rows.forEach((row, index) => {
        const grip = row.querySelector('.ed-grip');
        if (needsGrip && grip) grip.addEventListener('pointerdown', () => { row.draggable = true; });
        else row.draggable = true;
        row.addEventListener('dragstart', event => {
            from = index;
            row.classList.add('dragging');
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', String(index));
        });
        row.addEventListener('dragend', () => {
            row.classList.remove('dragging');
            if (needsGrip && grip) row.draggable = false;
            rows.forEach(r => r.classList.remove('drop-before', 'drop-after'));
            from = null;
        });
        const after = event => { const r = row.getBoundingClientRect(); return event.clientY > r.top + r.height / 2; };
        row.addEventListener('dragover', event => {
            if (from === null) return;
            event.preventDefault();
            rows.forEach(r => r.classList.remove('drop-before', 'drop-after'));
            row.classList.add(after(event) ? 'drop-after' : 'drop-before');
        });
        row.addEventListener('drop', event => {
            if (from === null) return;
            event.preventDefault();
            let to = index + (after(event) ? 1 : 0);
            if (from < to) to--;
            const start = from;
            from = null;
            if (to !== start) onMove(start, to);
        });
    });
}
function renderList() {
    const list = $('#ed-list');
    const settingsRow = h('li', { class: 'ed-row settings' + (S.sel === 'settings' ? ' selected' : ''), tabindex: 0, onclick: () => select('settings') },
        h('span'), h('span', { class: 'ed-num' }, ic('settings-2')),
        h('span', { class: 'ed-row-text' }, h('span', { class: 'ed-row-title' }, 'Presentation settings'), h('span', { class: 'ed-row-sub' }, S.doc.title || 'Untitled')),
        h('span'));
    let shown = 0;
    const rows = S.doc.items.map((item, index) => {
        const number = item.hidden ? '–' : ++shown;
        const act = (iconName, title, fn) => h('button', { type: 'button', title, onclick: event => { event.stopPropagation(); fn(); } }, ic(iconName));
        return h('li', { class: `ed-row${item === S.sel ? ' selected' : ''}${item.hidden ? ' off' : ''}`, tabindex: 0, dataset: { index }, onclick: () => select(item),
            onkeydown: event => {
                if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
                    event.preventDefault();
                    const to = index + (event.key === 'ArrowUp' ? -1 : 1);
                    if (to >= 0 && to < S.doc.items.length) { edit(() => move(S.doc.items, index, to), { structural: true }); document.querySelector(`.ed-row[data-index="${to}"]`)?.focus(); }
                } else if (event.key === 'Enter') select(item);
            } },
            h('span', { class: 'ed-grip', title: 'Drag to reorder (or Alt+Up / Alt+Down)' }, ic('grip-vertical')),
            h('span', { class: 'ed-num' }, number),
            h('span', { class: 'ed-row-text' }, h('span', { class: 'ed-row-title' }, item.title || 'Untitled screen'), h('span', { class: 'ed-row-sub' }, screenSummary(item))),
            h('span', { class: 'ed-row-actions' },
                act(item.hidden ? 'eye-off' : 'eye', item.hidden ? 'Hidden: click to show this screen' : 'Shown: click to hide this screen', () => edit(() => { if (item.hidden) delete item.hidden; else item.hidden = true; }, { structural: true })),
                act('copy', 'Duplicate', () => duplicateScreen(item)),
                act('trash-2', 'Delete', () => deleteScreen(item))));
    });
    list.replaceChildren(settingsRow, ...rows);
    sortable(rows, (from, to) => edit(() => move(S.doc.items, from, to), { structural: true }), { needsGrip: false });
}
function select(target) {
    S.sel = target;
    renderList();
    renderForm();
    $('#ed-form').scrollTop = 0;
    refreshPreview();
}
function duplicateScreen(item) {
    const copy = clone(item);
    copy.id = uniqueKey(item.id + '-copy', new Set(S.doc.items.map(it => it.id)));
    copy.title = (item.title || 'Screen') + ' (copy)';
    edit(() => S.doc.items.splice(S.doc.items.indexOf(item) + 1, 0, copy), { structural: true });
    select(copy);
}
function deleteScreen(item) {
    if (!confirm(`Delete "${item.title || 'this screen'}"? (Undo brings it back. To keep it for later, hide it with the eye instead.)`)) return;
    const index = S.doc.items.indexOf(item);
    edit(() => S.doc.items.splice(index, 1), { structural: true });
    select(S.doc.items[Math.min(index, S.doc.items.length - 1)] || 'settings');
}

// ---- add screen ---------------------------------------------------------------------------------

const TEMPLATES = {
    model: { name: '3D model', desc: 'One model with parts you can show or hide', make: () => ({ sources: { model: assemblySource('3D model') }, views: [{ key: 'model', label: '3D model', icon: 'box', panes: ['model'] }] }) },
    video: { name: 'Videos & pictures', desc: 'Clips to flip through: videos with stop points, pictures, drawing on both', make: () => ({ sources: { video: { kind: 'playlist', label: 'Videos', caption: '', clips: [] } }, views: [{ key: 'video', label: 'Video', icon: 'film', panes: ['video'] }] }) },
    both: { name: 'Video + model', desc: 'Tabs for video, model, and both side by side', make: () => ({ sources: { video: { kind: 'playlist', label: 'Videos', caption: '', clips: [] }, model: assemblySource('3D model') }, views: [{ key: 'video', label: 'Video', icon: 'film', panes: ['video'] }, { key: 'both', label: 'Video + 3D', icon: 'columns-2', panes: ['video', 'model'] }, { key: 'model', label: '3D model', icon: 'box', panes: ['model'] }] }) },
    compare: { name: 'Current vs proposed', desc: 'Two models side by side with linked cameras', make: () => ({ sources: { current: assemblySource('Current'), proposed: { ...assemblySource('Proposed'), tone: 'proposed' } }, views: [{ key: 'split', label: 'Side by side', icon: 'columns-2', panes: ['current', 'proposed'] }, { key: 'current', label: 'Current', icon: 'box', panes: ['current'] }, { key: 'proposed', label: 'Proposed', icon: 'box', panes: ['proposed'] }] }) },
    paint: { name: 'Paint on a model', desc: 'Reviewers paint an area on the scan', make: item => { const src = { kind: 'assembly', label: 'Paint', tone: 'proposed', caption: 'paint where it should change', layers: partsFrom(firstAssembly(item)) }; src.paint = paintConfig(src, item); return { sources: { paint: src }, views: [{ key: 'paint', label: 'Paint', icon: 'paintbrush', panes: ['paint'] }] }; } },
    images: { name: 'Pictures', desc: 'Images or diagrams to flip through', make: () => ({ sources: { pictures: { kind: 'image', label: 'Pictures', caption: '', images: [] } }, views: [{ key: 'pictures', label: 'Pictures', icon: 'image', panes: ['pictures'] }] }) },
    blank: { name: 'Placeholder', desc: 'Holds a spot until the files exist', make: () => ({ sources: { soon: { kind: 'pending', label: 'Coming soon', expects: '', note: 'Files for this screen are not ready yet.' } }, views: [{ key: 'soon', label: 'Coming soon', icon: 'box', panes: ['soon'] }] }) },
};
function assemblySource(label) { return { kind: 'assembly', label, caption: '', layers: [{ key: 'part-1', label: 'Part', file: '', color: '#b9c2cc', opacity: 1 }] }; }
function addScreen() {
    const dialog = h('dialog', { class: 'ed-dialog' });
    const form = h('form', { method: 'dialog' },
        h('h3', {}, 'Add a screen'),
        h('div', { class: 'ed-choices' }, Object.entries(TEMPLATES).map(([key, t]) => h('button', { type: 'button', onclick: () => { dialog.close(); create(key); } }, h('strong', {}, t.name), h('span', {}, t.desc)))),
        h('div', { class: 'ed-actions' }, h('button', { type: 'submit', class: 'ed-btn' }, 'Cancel')));
    dialog.append(form);
    dialog.addEventListener('close', () => dialog.remove());
    document.body.append(dialog);
    dialog.showModal();
    function create(key) {
        const template = TEMPLATES[key];
        const id = uniqueKey('screen-' + key, new Set(S.doc.items.map(it => it.id)));
        const item = { id, kind: 'stage', title: `New screen: ${template.name}`, context: '', ...template.make({ id, sources: {} }) };
        const at = S.sel === 'settings' ? S.doc.items.length : S.doc.items.indexOf(S.sel) + 1;
        edit(() => S.doc.items.splice(at, 0, item), { structural: true });
        select(item);
    }
}

// ---- media gallery ---------------------------------------------------------------------------------

const PICTURE_FILE = /\.(jpe?g|png|webp|gif|svg|avif)$/i;
const VIDEO_FILE = /\.(mp4|webm|mov|m4v)$/i;
const isPictureClip = clip => clip.type === 'image' || PICTURE_FILE.test(clip.src || '');
// Every file path the presentation uses (for the gallery's "In use" badge).
function usedFiles() {
    const used = new Set();
    const walk = value => {
        if (typeof value === 'string') { if (/\.[a-z0-9]{2,4}$/i.test(value)) used.add(value); }
        else if (value && typeof value === 'object') Object.values(value).forEach(walk);
    };
    walk(S.doc);
    return used;
}
const openGallery = createGallery({ h, ic, icons, toast, getMedia: () => S.media, usedFiles, afterImport: () => loadFileList(), onRenamed: applyRename });
// A site file was renamed (the server already updated the saved presentations): follow it in the open
// presentation too, in the saved copy and in any unsaved edits, so nothing points at the old name.
function applyRename(pairs) {
    const map = new Map(pairs || []);
    const fix = value => Array.isArray(value) ? value.map(fix)
        : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fix(v)]))
            : typeof value === 'string' && map.has(value) ? map.get(value) : value;
    const selId = S.sel === 'settings' ? null : S.sel.id;
    S.doc = fix(S.doc);
    S.savedText = JSON.stringify(fix(JSON.parse(S.savedText)));
    S.undo = S.undo.map(text => JSON.stringify(fix(JSON.parse(text))));
    S.redo = S.redo.map(text => JSON.stringify(fix(JSON.parse(text))));
    S.sel = (selId && S.doc.items.find(it => it.id === selId)) || 'settings';
    changed();
    renderAll();
}
// Imports go next to the files this material already uses, else media/<presentation id>.
function mediaFolderFor(paths) {
    const counts = {};
    paths.filter(p => typeof p === 'string' && /^media\/[^/]+\//.test(p)).forEach(p => { const f = p.slice(0, p.lastIndexOf('/')); counts[f] = (counts[f] || 0) + 1; });
    const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0];
    return best || `media/${slug(S.doc.id || S.doc.title || 'presentation')}`;
}
const stemOf = name => String(name || '').split('/').pop().replace(/\.[^.]+$/, '');
function clipFrom(file, taken) {
    const clip = { id: uniqueKey(stemOf(file.name), taken), label: stemOf(file.name), src: file.src };
    taken.add(clip.id);
    if (file.poster) clip.poster = file.poster;
    if (file.kind === 'video') clip.stops = [];
    if (file.rotate) clip.rotate = file.rotate;
    return clip;
}
// Where the top bar's Media button can put files, for the selected screen.
function galleryTargets() {
    if (S.sel === 'settings') {
        S.doc.library ||= [];
        return [{ label: 'The media library', add: files => edit(() => files.forEach(f => S.doc.library.push({ id: uniqueKey(stemOf(f.name), new Set(S.doc.library.map(e => e.id))), kind: f.kind === 'image' ? 'image' : 'video', label: stemOf(f.name), src: f.src, ...(f.poster ? { poster: f.poster } : {}) })), { structural: true }) }];
    }
    const item = S.sel;
    if (item.kind !== 'stage') return [];
    item.sources ||= {};
    const list = [];
    Object.entries(item.sources).forEach(([key, src]) => {
        if (src.kind === 'playlist') list.push({ label: `${src.label || key} (clips)`, add: files => addClips(src, files) });
        else if (src.kind === 'image') list.push({ label: `${src.label || key} (pictures)`, add: files => edit(() => files.forEach(f => src.images.push({ src: f.src, caption: '' })), { structural: true }) });
    });
    list.push({ label: 'A new "Videos & pictures" material on this screen', add: files => {
        const key = uniqueKey('clips', new Set(Object.keys(item.sources)));
        const src = { kind: 'playlist', label: 'Videos & pictures', caption: '', clips: [] };
        edit(() => {
            item.sources[key] = src;
            item.views ||= [];
            item.views.push({ key: uniqueKey(key, new Set(item.views.map(v => v.key))), label: 'Clips', icon: 'list-video', panes: [key] });
        }, { structural: true });
        addClips(src, files);
    } });
    return list;
}
function addClips(src, files) {
    src.clips ||= [];
    const taken = new Set(src.clips.map(c => c.id));
    edit(() => files.forEach(f => src.clips.push(clipFrom(f, taken))), { structural: true });
    toast(`Added ${files.length} clip${files.length === 1 ? '' : 's'} to "${src.label || 'clips'}".`);
}
function browseMedia() {
    const targets = galleryTargets();
    if (!targets.length) { toast('Pick a screen with tabs (or Presentation settings) first.', { error: true }); return; }
    const item = S.sel === 'settings' ? null : S.sel;
    const paths = item ? Object.values(item.sources || {}).flatMap(src => [...(src.clips || []).map(c => c.src), ...(src.images || []).map(i => i.src), src.src]) : (S.doc.library || []).map(e => e.src);
    openGallery({ title: 'Media gallery', subtitle: item ? `For "${item.title || 'this screen'}"` : 'For the media library', targets, folder: mediaFolderFor(paths) });
}
// A small button next to a file box: pick that one file in the gallery.
function browseButton(accept, paths, onPick, title = 'Choose from the media gallery') {
    return h('button', { type: 'button', class: 'ed-btn ed-mini ed-icon ed-browse', title, onclick: () => openGallery({
        title: 'Choose a file', accept, multiple: false, folder: mediaFolderFor(paths), targets: [{ label: 'this', add: files => onPick(files[0]) }],
    }) }, ic('folder-open'));
}

// ---- form building blocks ------------------------------------------------------------------------

function field(label, obj, key, { multiline = false, placeholder = '', hint = '', list = null, type = 'text', rows = 3, number = false } = {}) {
    const input = h(multiline ? 'textarea' : 'input', { type: multiline ? null : type, value: obj[key] ?? '', placeholder, rows: multiline ? rows : null, list,
        oninput: event => edit(() => {
            const raw = event.target.value;
            if (raw === '') delete obj[key];
            else obj[key] = number ? +raw : raw;
        }) });
    return h('label', { class: 'ed-field' }, h('span', {}, label), input, hint && h('small', {}, hint));
}
function cellInput(obj, key, { list = null, placeholder = '', type = 'text', number = false, width = null, step = null, min = null, max = null, title = null } = {}) {
    return h('input', { type, value: obj[key] ?? '', list, placeholder, step, min, max, title: title || placeholder || null, style: width ? `width:${width}` : null,
        oninput: event => edit(() => {
            const raw = event.target.value;
            if (raw === '') delete obj[key];
            else obj[key] = number ? +raw : raw;
        }) });
}
// Cards and materials fold away. What is folded is remembered in this browser: a card by its title
// (fold "Words on the screen" once and it stays folded on every screen), a material per screen.
const COLLAPSE_KEY = 'gap-review-editor-collapsed';
const collapsed = new Set((() => { try { return JSON.parse(store('get', COLLAPSE_KEY)) || []; } catch { return []; } })());
function setCollapsed(key, on) {
    if (on) collapsed.add(key); else collapsed.delete(key);
    store('set', COLLAPSE_KEY, JSON.stringify([...collapsed]));
}
function foldable(node, key, toggle) {
    node.classList.add('ed-collapsible');
    node.dataset.ckey = key;
    const apply = on => {
        node.classList.toggle('collapsed', on);
        toggle.setAttribute('aria-expanded', String(!on));
        toggle.title = on ? 'Show' : 'Fold away';
    };
    apply(collapsed.has(key));
    node.foldTo = on => { apply(on); setCollapsed(key, on); };
    return node;
}
// card('Title', icon, sub, ...body) or card({ title, key, summary }, icon, sub, ...body)
function card(title, iconName, sub, ...body) {
    const opts = typeof title === 'object' ? title : { title };
    const chevron = h('button', { type: 'button', class: 'ed-fold', 'aria-label': `Fold ${opts.title}` }, ic('chevron-down'));
    const section = h('section', { class: 'ed-card' });
    const head = h('div', { class: 'ed-card-head', onclick: event => {
        if (event.target.closest('input, select, textarea, a') || (event.target.closest('button') && !event.target.closest('.ed-fold'))) return;
        section.foldTo(!section.classList.contains('collapsed'));
    } }, h('h3', {}, iconName && ic(iconName), opts.title), opts.summary ? h('span', { class: 'ed-card-summary' }, opts.summary) : h('span', { class: 'ed-card-summary' }), chevron);
    section.append(head, h('div', { class: 'ed-card-body' }, sub && h('p', { class: 'ed-sub' }, sub), ...body));
    return foldable(section, 'card:' + (opts.key || opts.title), chevron);
}
function foldAll(on) {
    document.querySelectorAll('#ed-form .ed-collapsible').forEach(node => node.foldTo?.(on));
}
const mediaSet = () => new Set(S.media);
function fileWarning(path) {
    if (!path || !S.localServer || /^(https?:|drive:)/.test(path) || mediaSet().has(path)) return null;
    return h('span', { class: 'ed-tag pending', title: 'This file is not in the site folder' }, ic('alert-triangle'), 'not found');
}
function rowControls(list, index, { onRemove, removeTitle = 'Remove' } = {}) {
    return h('td', { class: 'ed-narrow' },
        h('button', { type: 'button', class: 'ed-btn ed-mini ed-icon', title: 'Move up', disabled: index === 0, onclick: () => edit(() => move(list, index, index - 1), { structural: true }) }, ic('chevron-up')),
        h('button', { type: 'button', class: 'ed-btn ed-mini ed-icon', title: 'Move down', disabled: index === list.length - 1, onclick: () => edit(() => move(list, index, index + 1), { structural: true }) }, ic('chevron-down')),
        h('button', { type: 'button', class: 'ed-btn ed-mini ed-icon ed-danger', title: removeTitle, onclick: () => onRemove ? onRemove() : edit(() => list.splice(index, 1), { structural: true }) }, ic('x')));
}
function sortableTable(tbody, list) {
    sortable([...tbody.children], (from, to) => edit(() => move(list, from, to), { structural: true }));
}

// ---- screen form ---------------------------------------------------------------------------------

function renderForm() {
    const form = $('#ed-form');
    form.replaceChildren(S.sel === 'settings' ? settingsForm() : screenForm(S.sel));
    icons();
}
function screenForm(item) {
    const index = S.doc.items.indexOf(item);
    const wrap = h('div');
    wrap.append(h('div', { class: 'ed-form-head' },
        h('div', {}, h('h2', {}, item.hidden ? 'Hidden screen' : `Screen ${S.doc.items.slice(0, index + 1).filter(it => !it.hidden).length} of ${S.doc.items.filter(it => !it.hidden).length}`),
            h('span', { class: 'ed-id', title: 'Reviewers\' notes are stored under this id, so it never changes' }, `id: ${item.id}`)),
        h('div', { class: 'ed-actions' },
            h('label', { class: 'ed-check' }, h('input', { type: 'checkbox', checked: !item.hidden, onchange: event => edit(() => { if (event.target.checked) delete item.hidden; else item.hidden = true; }, { structural: true }) }), 'Show this screen'),
            h('label', { class: 'ed-check', title: 'The notes column starts hidden on this screen (the Notes button still shows it)' }, h('input', { type: 'checkbox', checked: !!item.notesHidden, onchange: event => edit(() => { if (event.target.checked) item.notesHidden = true; else delete item.notesHidden; }) }), 'Notes start hidden'),
            h('button', { type: 'button', class: 'ed-btn ed-mini ed-icon', title: 'Fold every section away', onclick: () => foldAll(true) }, ic('chevrons-down-up')),
            h('button', { type: 'button', class: 'ed-btn ed-mini ed-icon', title: 'Open every section', onclick: () => foldAll(false) }, ic('chevrons-up-down')),
            h('button', { type: 'button', class: 'ed-btn ed-mini', onclick: () => duplicateScreen(item) }, ic('copy'), 'Duplicate'),
            h('button', { type: 'button', class: 'ed-btn ed-mini ed-danger', onclick: () => deleteScreen(item) }, ic('trash-2'), 'Delete'))));

    wrap.append(presenterNotesCard(item));
    wrap.append(card({ title: 'Words on the screen', summary: item.title || '' }, 'type', null,
        field('Title', item, 'title', { placeholder: 'What this screen is about' }),
        field('Subtitle', item, 'context', { multiline: true, rows: 2, placeholder: 'One or two sentences under the title' }),
        h('div', { class: 'ed-grid2' },
            field('What went wrong', item, 'problem', { multiline: true }),
            field('What we would change', item, 'proposal', { multiline: true })),
        field('Our question for the reviewer', item, 'ask', { multiline: true, rows: 2 })));

    if (item.kind === 'compare') {
        wrap.append(card('Current vs proposed', 'columns-2', 'This screen uses the older two-sided format. It shows as Side by side / Current / Proposed tabs. Convert it to choose its tabs and materials here.',
            h('div', { class: 'ed-actions' }, h('button', { type: 'button', class: 'ed-btn ed-primary', onclick: () => convertCompare(item) }, ic('wand-2'), 'Convert to tabs and materials'))));
    } else if (item.kind === 'stage') {
        wrap.append(tabsCard(item), materialsCard(item));
    } else {
        wrap.append(card('Media', 'box', `This is a single "${item.kind}" screen. Its files are edited in the review file.`));
    }
    wrap.append(choicesCard(item));
    return wrap;
}
function convertCompare(item) {
    edit(() => {
        const sources = { current: { ...item.current, label: item.current?.label || 'Current' }, proposed: { ...item.proposed, label: item.proposed?.label || 'Proposed', tone: 'proposed' } };
        const views = [{ key: 'split', label: 'Side by side', icon: 'columns-2', panes: ['current', 'proposed'] }, { key: 'current', label: 'Current', icon: 'box', panes: ['current'] }, { key: 'proposed', label: 'Proposed', icon: 'box', panes: ['proposed'] }];
        if (item.video) { sources.video = { kind: 'video', ...item.video }; views.push({ key: 'video', label: `${item.video.label || 'Video'} + model`, icon: 'film', panes: ['video', 'current'] }); }
        delete item.current; delete item.proposed; delete item.video;
        item.kind = 'stage';
        item.sources = sources;
        item.views = views;
    }, { structural: true });
    toast('Converted. Same screen id, so notes stay attached.');
}

function sourceOptions(item, selected, { allowNone = false } = {}) {
    const opts = Object.entries(item.sources || {}).map(([key, src]) => h('option', { value: key, selected: key === selected }, `${src.label || key} (${SOURCE_KIND[src.kind]?.[1] || src.kind})`));
    if (allowNone) opts.unshift(h('option', { value: '', selected: !selected }, '— nothing —'));
    return opts;
}
function tabsCard(item) {
    item.views ||= [];
    const defaultKey = item.defaultView && item.views.some(v => v.key === item.defaultView) ? item.defaultView : item.views[0]?.key;
    const tbody = h('tbody', {}, item.views.map((view, i) => {
        const panes = view.panes || (view.panes = []);
        return h('tr', {},
            h('td', { class: 'ed-narrow' }, h('span', { class: 'ed-grip', title: 'Drag to reorder' }, ic('grip-vertical'))),
            h('td', {}, cellInput(view, 'label', { placeholder: 'Tab name' })),
            h('td', {}, h('select', { class: 'ed-icon-select', title: 'Tab icon', onchange: event => edit(() => { view.icon = event.target.value; }) }, TAB_ICONS.map(([name, label]) => h('option', { value: name, selected: (view.icon || 'box') === name }, label)))),
            h('td', {}, h('select', { onchange: event => edit(() => { panes[0] = event.target.value; }, { structural: true }) }, sourceOptions(item, panes[0]))),
            h('td', {}, h('select', { onchange: event => edit(() => { if (event.target.value) panes[1] = event.target.value; else panes.length = 1; }, { structural: true }) }, sourceOptions(item, panes[1], { allowNone: true }))),
            h('td', { class: 'ed-narrow', title: 'Opens on this tab' }, h('input', { type: 'radio', name: `default-${item.id}`, checked: view.key === defaultKey, onchange: () => edit(() => { item.defaultView = view.key; }) })),
            rowControls(item.views, i, { removeTitle: 'Remove this tab' }));
    }));
    sortableTable(tbody, item.views);
    const add = () => {
        const sources = Object.entries(item.sources || {});
        const addTab = (label, panes, icon) => edit(() => item.views.push({ key: uniqueKey(slug(label) || 'tab', new Set(item.views.map(v => v.key))), label, icon, panes }), { structural: true });
        const groups = [];
        if (sources.length) {
            groups.push({ heading: 'Show something already on this screen', options: sources.map(([key, src]) => ({
                icon: iconForSource(src), name: src.label || key, desc: SOURCE_KIND[src.kind]?.[1] || src.kind, onPick: () => addTab(src.label || key, [key], iconForSource(src)),
            })) });
            if (sources.length > 1) groups[0].options.push({ icon: 'columns-2', name: 'Two side by side', desc: `${sources[0][1].label} beside ${sources[1][1].label}; change either in the table`, onPick: () => addTab('Side by side', [sources[0][0], sources[1][0]], 'columns-2') });
        }
        groups.push({ heading: 'Add something new (it also appears under Materials)', options: newMaterialOptions(item) });
        chooser('Add a tab', groups);
    };
    return card({ title: 'Tabs', summary: `${item.views.length} tab${item.views.length === 1 ? '' : 's'}: ${item.views.map(v => v.label).join(' · ')}` }, 'panels-top-left', 'Each tab shows one material, or two side by side. The presenter switches tabs; drag to set their order.',
        item.views.length ? h('div', { class: 'ed-table-wrap' }, h('table', { class: 'ed-table' }, h('thead', {}, h('tr', {}, h('th'), h('th', {}, 'Tab name'), h('th', {}, 'Icon'), h('th', {}, 'Shows'), h('th', {}, 'Beside it'), h('th', { title: 'The tab the screen opens on' }, 'First'), h('th'))), tbody)) : h('p', { class: 'ed-note' }, 'No tabs yet.'),
        h('div', { class: 'ed-actions' }, h('button', { type: 'button', class: 'ed-btn', onclick: add }, ic('plus'), 'Add tab…')));
}

function iconForSource(src) {
    if (src.paint) return 'paintbrush';
    if (src.leg) return 'ruler';
    return { image: 'image', playlist: 'film', video: 'film', sweep: 'sliders-horizontal', pending: 'hourglass' }[src.kind] || 'box';
}
// Adds a material and a tab that shows it; returns its key.
function addMaterial(item, base, src, { quiet = false } = {}) {
    item.sources ||= {};
    const key = uniqueKey(base, new Set(Object.keys(item.sources)));
    edit(() => {
        item.sources[key] = src;
        item.views ||= [];
        item.views.push({ key: uniqueKey(key, new Set(item.views.map(v => v.key))), label: src.label, icon: iconForSource(src), panes: [key] });
    }, { structural: true });
    if (!quiet) toast(`Added "${src.label}" and a tab for it.`);
    return key;
}
// The first model with files (this screen first, then the rest of the presentation): new paint and
// model materials start from its parts so they line up with the scan.
function firstAssembly(item) {
    const usable = s => s && (s.kind === 'assembly' || (!s.kind && s.layers)) && (s.layers || []).some(l => l.file);
    const here = Object.values(item.sources || {}).find(usable);
    if (here) return here;
    for (const it of S.doc.items) {
        const found = [...Object.values(it.sources || {}), it.current, it.proposed].find(usable);
        if (found) return found;
    }
    return null;
}
function legTemplate() {
    for (const it of S.doc.items) for (const src of Object.values(it.sources || {})) if (src.leg) return src;
    return null;
}
function paintConfig(src, item) {
    const layer = (src.layers || []).find(l => l.key === 'animal') || (src.layers || [])[0];
    return { layer: layer?.key || 'part-1', color: '#169c8c', brush: 10, tolerance: 3, fileName: slug(`${item.id}-painted-surface`) };
}
function partsFrom(base) {
    return clone(base?.layers || [{ key: 'part-1', label: 'Part', file: '', color: '#b9c2cc', opacity: 1 }]);
}
// Everything a screen can show, for the "Add a tab" and "Add to this screen" choosers.
function newMaterialOptions(item) {
    const fill = (src, accept) => openGallery({ title: `Add to "${src.label}"`, accept, folder: mediaFolderFor([]), targets: [{ label: src.label, add: files => accept === 'image' ? edit(() => files.forEach(f => src.images.push({ src: f.src, caption: '' })), { structural: true }) : addClips(src, files) }] });
    const leg = legTemplate();
    return [
        { icon: 'box', name: '3D model', desc: 'Parts you can show, hide and colour', onPick: () => { const base = firstAssembly(item); addMaterial(item, 'model', { kind: 'assembly', label: '3D model', caption: '', layers: partsFrom(base) }); } },
        { icon: 'list-video', name: 'Videos & pictures', desc: 'Clips to flip through, with drawing and stop points', onPick: () => { const src = { kind: 'playlist', label: 'Videos & pictures', caption: '', clips: [] }; addMaterial(item, 'clips', src); fill(src, 'any'); } },
        { icon: 'image', name: 'Pictures', desc: 'Images or diagrams with captions', onPick: () => { const src = { kind: 'image', label: 'Pictures', caption: '', images: [] }; addMaterial(item, 'pictures', src); fill(src, 'image'); } },
        { icon: 'paintbrush', name: 'Paint on a model', desc: 'Paint an area on the scan (e.g. where the socket should reach) and save it as a file', onPick: () => {
            const src = { kind: 'assembly', label: 'Paint', tone: 'proposed', caption: 'paint where it should change', layers: partsFrom(firstAssembly(item)) };
            src.paint = paintConfig(src, item);
            addMaterial(item, 'paint', src);
        } },
        { icon: 'ruler', name: 'Leg-length tool', desc: leg ? 'Pipe and paw on the socket; drag to set the length' : 'Needs one screen that already has it set up (its mount point is measured on the scan)', disabled: !leg,
            onPick: () => addMaterial(item, 'leg', { ...clone(leg), label: 'Leg length' }) },
        { icon: 'copy-plus', name: 'Copy from another screen', desc: 'Any model, slider, video or picture set already in this presentation', onPick: () => copyFromScreen(item) },
        { icon: 'hourglass', name: 'Placeholder', desc: 'Holds a spot until the files exist', onPick: () => addMaterial(item, 'placeholder', { kind: 'pending', label: 'Coming soon', expects: '', note: '' }) },
    ];
}
function copyFromScreen(item) {
    const groups = [];
    S.doc.items.forEach(other => {
        if (other === item) return;
        const found = [];
        Object.entries(other.sources || {}).forEach(([key, src]) => found.push([key, src]));
        if (other.kind === 'compare') ['current', 'proposed'].forEach(k => { if (other[k]) found.push([k, { ...other[k], kind: other[k].kind || (other[k].layers ? 'assembly' : 'sweep') }]); });
        if (other.kind === 'compare' && other.video) found.push(['video', { kind: 'video', ...other.video }]);
        if (!found.length) return;
        groups.push({ heading: other.title || other.id, options: found.map(([key, src]) => ({
            icon: iconForSource(src), name: src.label || key, desc: SOURCE_KIND[src.kind]?.[1] || src.kind,
            onPick: () => addMaterial(item, key, clone(src)),
        })) });
    });
    if (!groups.length) { toast('No other screen has materials yet.', { error: true }); return; }
    chooser('Copy from another screen', groups, { wide: true });
}
// A dialog of big buttons in groups: [{ heading, options: [{ icon, name, desc, disabled, onPick }] }]
function chooser(title, groups, { wide = false } = {}) {
    const dialog = h('dialog', { class: 'ed-dialog ed-chooser' + (wide ? ' wide' : '') });
    const shut = () => { dialog.close(); dialog.remove(); };
    dialog.append(h('form', { method: 'dialog', onsubmit: event => { event.preventDefault(); shut(); } },
        h('h3', {}, title),
        groups.map(group => [h('h4', { class: 'ed-chooser-head' }, group.heading),
            h('div', { class: 'ed-choices' }, group.options.map(o => h('button', { type: 'button', disabled: o.disabled, title: o.disabled ? o.desc : null, onclick: () => { shut(); o.onPick(); } },
                h('strong', {}, ic(o.icon), o.name), h('span', {}, o.desc))))]),
        h('div', { class: 'ed-actions' }, h('button', { type: 'submit', class: 'ed-btn' }, 'Cancel'))));
    dialog.addEventListener('close', () => dialog.remove());
    document.body.append(dialog);
    dialog.showModal();
    icons();
}
function materialsCard(item) {
    item.sources ||= {};
    const body = h('div');
    Object.entries(item.sources).forEach(([key, src]) => body.append(materialEditor(item, key, src)));
    const library = S.doc.library || [];
    const libSelect = h('select', { onchange: event => {
        const entry = library.find(e => e.id === event.target.value);
        event.target.value = '';
        if (!entry) return;
        if (entry.kind === 'image') addMaterial(item, entry.id, { kind: 'image', label: entry.label, caption: entry.caption || '', images: [{ src: entry.src, caption: entry.caption || '' }] });
        else addMaterial(item, entry.id, { kind: 'video', label: entry.label, src: entry.src, poster: entry.poster, stops: [] });
    } }, h('option', { value: '' }, 'From the media library…'), library.map(entry => h('option', { value: entry.id }, entry.label)));
    const labels = Object.entries(item.sources).map(([key, src]) => src.label || key);
    return card({ title: 'Materials', summary: `${labels.length}: ${labels.join(' · ')}` }, 'shapes', 'The models, videos, pictures and tools this screen can show. Tabs pick from these.',
        body,
        h('div', { class: 'ed-actions' },
            h('button', { type: 'button', class: 'ed-btn ed-primary', onclick: () => chooser('Add to this screen', [{ heading: 'Each new material gets its own tab too', options: newMaterialOptions(item) }]) }, ic('plus'), 'Add to this screen…'),
            library.length ? libSelect : null));
}
// Paint and leg tools on a model.
function modelToolsEditor(item, src) {
    const leg = src.leg ? null : legTemplate();
    const toggles = h('div', { class: 'ed-tool-toggles' },
        h('label', { class: 'ed-check', title: 'People paint an area on the scan; you save it as a 3D file' },
            h('input', { type: 'checkbox', checked: !!src.paint, onchange: event => edit(() => { if (event.target.checked) src.paint = paintConfig(src, item); else delete src.paint; }, { structural: true }) }), ic('paintbrush'), 'Paint the surface'),
        h('label', { class: 'ed-check', title: src.leg || leg ? 'Pipe and paw on the socket; drag to set the length' : 'Needs one screen that already has the leg tool (its mount point is measured on the scan)' },
            h('input', { type: 'checkbox', checked: !!src.leg, disabled: !src.leg && !leg, onchange: event => edit(() => { if (event.target.checked) src.leg = clone(leg.leg); else delete src.leg; }, { structural: true }) }), ic('ruler'), 'Leg-length tool'));
    const parts = [h('h4', { class: 'ed-subhead' }, 'Tools on this model'), toggles];
    if (src.paint) {
        const p = src.paint;
        parts.push(h('div', { class: 'ed-grid2 ed-tool-settings' },
            h('label', { class: 'ed-field' }, h('span', {}, 'Paint on'), h('select', { onchange: event => edit(() => { p.layer = event.target.value; }) },
                (src.layers || []).map(l => h('option', { value: l.key, selected: l.key === p.layer }, l.label || l.key)))),
            field('Start from a surface (optional)', p, 'surface', { list: 'dl-models', placeholder: 'attachment-surface.glb' }),
            h('label', { class: 'ed-field' }, h('span', {}, 'Paint colour'), h('input', { type: 'color', value: p.color || '#169c8c', oninput: event => edit(() => { p.color = event.target.value; }) })),
            field('Brush size (mm)', p, 'brush', { type: 'number', number: true }),
            field('Saved file name', p, 'fileName', { placeholder: 'painted-surface' })));
    }
    if (src.leg) {
        const L = src.leg;
        L.length ||= {};
        L.paw ||= {};
        parts.push(h('div', { class: 'ed-grid2 ed-tool-settings' },
            field('Shortest leg (mm)', L.length, 'min', { type: 'number', number: true }),
            field('Longest leg (mm)', L.length, 'max', { type: 'number', number: true }),
            field('Starts at (mm)', L.length, 'value', { type: 'number', number: true }),
            field('Paw file', L.paw, 'file', { list: 'dl-models', placeholder: 'paw.glb' }),
            field('Paw turned (degrees)', L.paw, 'yaw', { type: 'number', number: true })),
            h('label', { class: 'ed-check', title: 'Adds the mechanical interface with Place on the body, tilt, twist and depth controls (like the walkthrough). It starts where the fitted socket had it.' },
                h('input', { type: 'checkbox', checked: !!L.place, onchange: event => edit(() => {
                    if (event.target.checked) {
                        L.place = { contact: 0, adjust: 50 };
                        if (!L.interface?.file) L.interface = { file: 'ollie-mechanical-interface.glb', bottom: -60.96, color: '#df7544' };
                    } else delete L.place;
                }, { structural: true }) }), ic('move-3d'), 'Viewers can move the mechanical interface'),
            L.place ? h('div', { class: 'ed-grid2 ed-tool-settings' },
                field('Interface file', L.interface, 'file', { list: 'dl-models', placeholder: 'ollie-mechanical-interface.glb' }),
                field('Adjust range (mm, each way)', L.place, 'adjust', { type: 'number', number: true }),
                h('label', { class: 'ed-check', title: 'Turns the interface model over (half turn about the lateral axis); the pipe and paw still hang below it' },
                    h('input', { type: 'checkbox', checked: !!L.interface?.flip, onchange: event => edit(() => { L.interface ||= {}; if (event.target.checked) L.interface.flip = true; else delete L.interface.flip; }) }), 'Interface flipped 180°')) : null,
            h('p', { class: 'ed-note' }, L.place ? 'It starts where the fitted socket had it (the mount point measured on the scan); viewers move it from there.' : 'The mount point on the socket is kept as it was measured.'));
    }
    return h('div', { class: 'ed-model-tools' }, parts);
}
function materialEditor(item, key, src) {
    const [iconName, kindLabel] = SOURCE_KIND[src.kind] || ['box', src.kind];
    const usedIn = (item.views || []).filter(v => (v.panes || []).includes(key)).map(v => v.label);
    const remove = () => {
        if (usedIn.length && !confirm(`"${src.label || key}" is shown in: ${usedIn.join(', ')}. Remove it and take it out of those tabs?`)) return;
        edit(() => {
            delete item.sources[key];
            item.views = (item.views || []).map(v => ({ ...v, panes: (v.panes || []).filter(p => p !== key) })).filter(v => v.panes.length);
        }, { structural: true });
    };
    const fold = h('button', { type: 'button', class: 'ed-fold', 'aria-label': `Fold ${src.label || key}` }, ic('chevron-down'));
    fold.addEventListener('click', () => wrapEl.foldTo(!wrapEl.classList.contains('collapsed')));
    const head = h('div', { class: 'ed-material-head' },
        fold,
        ic(iconForSource(src)),
        cellInput(src, 'label', { placeholder: kindLabel }),
        h('span', { class: 'ed-tag' + (src.kind === 'pending' ? ' pending' : '') }, kindLabel),
        src.tone === 'proposed' ? h('span', { class: 'ed-tag proposed' }, 'Proposed') : null,
        h('button', { type: 'button', class: 'ed-btn ed-mini ed-danger', title: 'Remove this material', onclick: remove }, ic('trash-2')));
    const body = h('div', { class: 'ed-material-body' },
        h('p', { class: 'ed-used' }, usedIn.length ? `Shown in: ${usedIn.join(', ')}` : 'Not shown in any tab yet.'),
        h('div', { class: 'ed-grid2' },
            field('Caption', src, 'caption', { placeholder: 'Short label shown on the view' }),
            h('div', {}, h('label', { class: 'ed-check' }, h('input', { type: 'checkbox', checked: src.tone === 'proposed', onchange: event => edit(() => { if (event.target.checked) src.tone = 'proposed'; else delete src.tone; }, { structural: true }) }), 'Mark as proposed (orange label)'))));
    if (src.kind === 'assembly') body.append(partsEditor(src), h('div', { class: 'ed-grid2' }, gridField(src)), modelToolsEditor(item, src));
    else if (src.kind === 'playlist') body.append(clipsEditor(src));
    else if (src.kind === 'video') body.append(h('div', { class: 'ed-actions' }, browseButton('any', [src.src], f => edit(() => { src.src = f.src; if (f.poster) src.poster = f.poster; else delete src.poster; if (f.rotate) src.rotate = f.rotate; }, { structural: true }), 'Choose the video or picture from the media gallery'), h('span', { class: 'ed-hint', style: 'margin:0' }, 'Choose from the media gallery')),
        h('div', { class: 'ed-grid2' }, field('Video or picture file', src, 'src', { list: 'dl-clips' }), field('Poster image', src, 'poster', { list: 'dl-images' }), h('label', { class: 'ed-field' }, h('span', {}, 'Turn the video'), rotationSelect(src)), h('div', { class: 'ed-field' }, h('span', {}, 'Start and end'), trimButton(src))), stopsNote(src.stops));
    else if (src.kind === 'image') body.append(imagesEditor(src));
    else if (src.kind === 'sweep') body.append(sweepEditor(src));
    else if (src.kind === 'pending') body.append(pendingEditor(item, key, src));
    const wrapEl = h('div', { class: 'ed-material' }, head, body);
    return foldable(wrapEl, `mat:${item.id}:${key}`, fold);
}
// Clips filmed sideways or upside down: a quarter-turn setting stored as "rotate" (degrees) on the clip.
// ---- trimming a clip ------------------------------------------------------------------------------
// "start" / "end" (seconds) on a clip: the presentation plays only that part; the video file is untouched.
const fmtClock = t => { t = Math.max(0, +t || 0); const m = Math.floor(t / 60); return `${m}:${(t - m * 60).toFixed(1).padStart(4, '0')}`; };
function parseClock(text) {
    const parts = String(text).trim().split(':').map(Number);
    if (!parts.length || parts.some(n => !Number.isFinite(n) || n < 0)) return null;
    return parts.reduce((total, n) => total * 60 + n, 0);
}
function trimButton(clip) {
    const label = clip.start || clip.end ? `${fmtClock(clip.start || 0)}–${clip.end ? fmtClock(clip.end) : 'end'}` : 'Whole';
    return h('button', { type: 'button', class: 'ed-btn ed-mini' + (clip.start || clip.end ? ' ed-trimmed' : ''), title: 'Choose where this clip starts and ends', disabled: !clip.src, onclick: () => openTrim(clip) }, ic('scissors'), label);
}
function openTrim(clip) {
    const dialog = h('dialog', { class: 'ed-dialog ed-trim' });
    const shut = () => { dialog.close(); dialog.remove(); };
    const video = h('video', { src: clip.src, preload: 'auto', playsinline: true, muted: true });
    video.muted = true;
    const track = h('div', { class: 'ed-trim-track' });
    const range = h('div', { class: 'ed-trim-range' });
    const head = h('div', { class: 'ed-trim-head' });
    const handleStart = h('button', { type: 'button', class: 'ed-trim-handle start', title: 'Drag to set the start', 'aria-label': 'Start' });
    const handleEnd = h('button', { type: 'button', class: 'ed-trim-handle end', title: 'Drag to set the end', 'aria-label': 'End' });
    track.append(range, head, handleStart, handleEnd);
    const startInput = h('input', { type: 'text', inputmode: 'decimal', 'aria-label': 'Start time' });
    const endInput = h('input', { type: 'text', inputmode: 'decimal', 'aria-label': 'End time' });
    const clock = h('span', { class: 'ed-trim-clock' }, '0:00.0');
    const info = h('p', { class: 'ed-note' });
    let duration = 0, start = +clip.start || 0, end = +clip.end || 0, previewing = false;
    const frac = t => duration ? Math.min(1, Math.max(0, t / duration)) * 100 + '%' : '0%';
    function draw() {
        range.style.left = frac(start);
        range.style.width = duration ? `${(end - start) / duration * 100}%` : '0';
        handleStart.style.left = frac(start);
        handleEnd.style.left = frac(end);
        head.style.left = frac(video.currentTime);
        if (document.activeElement !== startInput) startInput.value = fmtClock(start);
        if (document.activeElement !== endInput) endInput.value = fmtClock(end);
        clock.textContent = `${fmtClock(video.currentTime)} / ${fmtClock(duration)}`;
        info.textContent = duration ? `Plays ${fmtClock(end - start)} of ${fmtClock(duration)}. Marks and stop points outside this part are kept but not shown.` : 'Loading the video…';
    }
    function setStart(t) { start = Math.max(0, Math.min(t, end - 0.2)); draw(); }
    function setEnd(t) { end = Math.min(duration, Math.max(t, start + 0.2)); draw(); }
    video.addEventListener('loadedmetadata', () => {
        duration = video.duration || 0;
        if (!end || end > duration) end = duration;
        start = Math.min(start, Math.max(0, end - 0.2));
        video.currentTime = start;
        draw();
    });
    video.addEventListener('timeupdate', () => {
        if (previewing && video.currentTime >= end) { video.pause(); previewing = false; video.currentTime = end; }
        draw();
    });
    video.addEventListener('seeked', draw);
    const timeAt = event => { const r = track.getBoundingClientRect(); return Math.min(1, Math.max(0, (event.clientX - r.left) / r.width)) * duration; };
    function drag(handle, apply) {
        handle.addEventListener('pointerdown', event => {
            event.preventDefault();
            event.stopPropagation();
            try { handle.setPointerCapture(event.pointerId); } catch { /* not a real pointer */ }
            video.pause();
            const move = ev => { apply(timeAt(ev)); video.currentTime = handle === handleStart ? start : end; };
            const up = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); handle.removeEventListener('pointercancel', up); };
            handle.addEventListener('pointermove', move);
            handle.addEventListener('pointerup', up);
            handle.addEventListener('pointercancel', up);
        });
    }
    drag(handleStart, setStart);
    drag(handleEnd, setEnd);
    track.addEventListener('pointerdown', event => { if (event.target.closest('.ed-trim-handle')) return; video.pause(); video.currentTime = timeAt(event); });
    [[startInput, setStart], [endInput, setEnd]].forEach(([input, apply]) => input.addEventListener('change', () => {
        const t = parseClock(input.value);
        if (t === null) { draw(); return; }
        apply(t);
        video.currentTime = input === startInput ? start : end;
    }));
    const step = by => { video.pause(); video.currentTime = Math.max(0, Math.min(duration, video.currentTime + by)); };
    const save = () => {
        edit(() => {
            const s0 = +start.toFixed(2), e0 = +end.toFixed(2);
            if (s0 > 0.05) clip.start = s0; else delete clip.start;
            if (duration && e0 < duration - 0.05) clip.end = e0; else delete clip.end;
        }, { structural: true });
        toast(clip.start || clip.end ? `Clip trimmed to ${fmtClock(clip.start || 0)}–${clip.end ? fmtClock(clip.end) : 'end'}.` : 'Clip plays from start to end.');
        shut();
    };
    dialog.append(h('form', { method: 'dialog', onsubmit: event => { event.preventDefault(); shut(); } },
        h('h3', {}, ic('scissors'), `Trim "${clip.label || clip.src.split('/').pop()}"`),
        h('div', { class: 'ed-trim-stage' }, video),
        h('div', { class: 'ed-trim-controls' },
            h('button', { type: 'button', class: 'ed-btn ed-mini ed-icon', title: 'Back a little', onclick: () => step(-1 / 30) }, ic('chevron-left')),
            h('button', { type: 'button', class: 'ed-btn ed-mini', title: 'Play or pause', onclick: () => { previewing = false; if (video.paused) video.play(); else video.pause(); } }, ic('play'), 'Play / pause'),
            h('button', { type: 'button', class: 'ed-btn ed-mini ed-icon', title: 'Forward a little', onclick: () => step(1 / 30) }, ic('chevron-right')),
            clock,
            h('span', { class: 'eg-spacer' }),
            h('button', { type: 'button', class: 'ed-btn ed-mini ed-primary', onclick: () => { previewing = true; video.currentTime = start; video.play(); } }, ic('play'), 'Play the trimmed part')),
        track,
        h('div', { class: 'ed-trim-fields' },
            h('label', { class: 'ed-field' }, h('span', {}, 'Starts at'), startInput),
            h('button', { type: 'button', class: 'ed-btn ed-mini', onclick: () => setStart(video.currentTime) }, ic('arrow-right-to-line'), 'Start here'),
            h('label', { class: 'ed-field' }, h('span', {}, 'Ends at'), endInput),
            h('button', { type: 'button', class: 'ed-btn ed-mini', onclick: () => setEnd(video.currentTime) }, ic('arrow-left-to-line'), 'End here'),
            h('button', { type: 'button', class: 'ed-btn ed-mini', title: 'Play the whole video again', onclick: () => { start = 0; end = duration; draw(); } }, ic('rotate-ccw'), 'Whole video')),
        info,
        h('div', { class: 'ed-actions' },
            h('button', { type: 'submit', class: 'ed-btn' }, 'Cancel'),
            h('button', { type: 'button', class: 'ed-btn ed-primary', onclick: save }, ic('check'), 'Save trim'))));
    dialog.addEventListener('close', () => { video.pause(); dialog.remove(); });
    document.body.append(dialog);
    dialog.showModal();
    icons();
    draw();
}
function rotationSelect(target) {
    const current = ((Math.round(+(target.rotate || 0) / 90) * 90) % 360 + 360) % 360;
    return h('select', { title: 'Turn the video (for clips filmed sideways or upside down)', onchange: event => edit(() => {
        const deg = +event.target.value;
        if (deg) target.rotate = deg; else delete target.rotate;
    }) }, [[0, 'Upright'], [90, '90° right'], [180, 'Upside down'], [270, '90° left']].map(([deg, label]) => h('option', { value: deg, selected: deg === current }, label)));
}
function stopsNote(stops) {
    const count = (stops || []).length;
    return h('p', { class: 'ed-note' }, count ? `${count} stop point${count === 1 ? '' : 's'} set. ` : '', 'Stop points are added while presenting: open Present, pause where you want the video to stop, and press Add stop. Then use "Download review file with my stop points" in the Live panel.');
}
function partsEditor(src) {
    src.layers ||= [];
    const tbody = h('tbody', {}, src.layers.map((layer, i) => h('tr', {},
        h('td', { class: 'ed-narrow' }, h('span', { class: 'ed-grip', title: 'Drag to reorder' }, ic('grip-vertical'))),
        h('td', {}, cellInput(layer, 'label', { placeholder: 'Part name' })),
        h('td', {}, cellInput(layer, 'file', { list: 'dl-models', placeholder: 'file.glb' }), fileWarning(layer.file)),
        h('td', { class: 'ed-narrow' }, h('input', { type: 'color', value: layer.color || '#b9c2cc', title: 'Colour', oninput: event => edit(() => { layer.color = event.target.value; }) })),
        h('td', { class: 'ed-narrow' }, lookSelect(layer)),
        h('td', { class: 'ed-narrow', title: 'Visible when the screen opens' }, h('input', { type: 'checkbox', checked: layer.visible !== false, onchange: event => edit(() => { if (event.target.checked) delete layer.visible; else layer.visible = false; }) })),
        rowControls(src.layers, i, { removeTitle: 'Remove this part' }))));
    sortableTable(tbody, src.layers);
    return h('div', {},
        h('div', { class: 'ed-table-wrap' }, h('table', { class: 'ed-table' }, h('thead', {}, h('tr', {}, h('th'), h('th', {}, 'Part'), h('th', {}, 'File'), h('th', {}, 'Colour'), h('th', { title: 'How the part looks when the screen opens. Viewers can switch it with the half-circle button or T.' }, 'Starts'), h('th', {}, 'On'), h('th'))), tbody)),
        h('div', { class: 'ed-actions' },
            h('button', { type: 'button', class: 'ed-btn ed-mini', onclick: () => edit(() => src.layers.push({ key: uniqueKey('part', new Set(src.layers.map(l => l.key))), label: 'Part', file: '', color: '#b9c2cc', opacity: 1 }), { structural: true }) }, ic('plus'), 'Add part'),
            h('span', { class: 'ed-hint', style: 'margin:0 0 0 auto' }, 'Whole model starts:'),
            h('button', { type: 'button', class: 'ed-btn ed-mini', title: 'Every part starts solid', onclick: () => edit(() => src.layers.forEach(l => setLook(l, 'solid')), { structural: true }) }, ic('circle'), 'All solid'),
            h('button', { type: 'button', class: 'ed-btn ed-mini', title: 'Every part starts see-through', onclick: () => edit(() => src.layers.forEach(l => setLook(l, 'see')), { structural: true }) }, ic('contrast'), 'All see-through')));
}
function clipsEditor(src) {
    src.clips ||= [];
    const tbody = h('tbody', {}, src.clips.map((clip, i) => h('tr', {},
        h('td', { class: 'ed-narrow' }, h('span', { class: 'ed-grip', title: 'Drag to reorder' }, ic('grip-vertical'))),
        h('td', {}, cellInput(clip, 'label', { placeholder: 'Clip name' })),
        h('td', {}, h('div', { class: 'ed-file-cell' }, cellInput(clip, 'src', { list: 'dl-clips', placeholder: 'video.mp4 or picture.jpg', title: 'Video or picture file' }),
            browseButton('any', src.clips.map(c => c.src), f => edit(() => {
                if (!clip.label || /^Clip \d+$/.test(clip.label)) clip.label = stemOf(f.name);
                clip.src = f.src;
                if (f.poster) clip.poster = f.poster; else delete clip.poster;
                if (f.rotate) clip.rotate = f.rotate;
                if (f.kind === 'video') clip.stops ||= []; else if (!(clip.stops || []).length) delete clip.stops;
            }, { structural: true }), 'Choose this clip\'s file from the media gallery')), fileWarning(clip.src)),
        h('td', {}, isPictureClip(clip) ? h('span', { class: 'ed-muted', title: 'Pictures do not need a poster' }, 'Picture') : cellInput(clip, 'poster', { list: 'dl-images', placeholder: 'poster.jpg (optional)' })),
        h('td', { class: 'ed-narrow' }, rotationSelect(clip)),
        h('td', { class: 'ed-narrow' }, isPictureClip(clip) ? null : trimButton(clip)),
        h('td', { class: 'ed-narrow' }, (clip.stops || []).length ? h('span', { class: 'ed-tag', title: 'Stop points' }, ic('octagon-pause'), clip.stops.length) : null),
        rowControls(src.clips, i, { removeTitle: 'Remove this clip' }))));
    sortableTable(tbody, src.clips);
    const clipFile = f => VIDEO_FILE.test(f) || (PICTURE_FILE.test(f) && f.startsWith('media/'));
    const folders = [...new Set(S.media.filter(clipFile).map(f => f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '.'))];
    const addFolder = h('select', { onchange: event => {
        const folder = event.target.value;
        event.target.value = '';
        if (!folder) return;
        const have = new Set(src.clips.map(c => c.src));
        const inFolder = f => folder === '.' ? !f.includes('/') : f.startsWith(folder + '/') && !f.slice(folder.length + 1).includes('/');
        const videos = new Set(S.media.filter(f => VIDEO_FILE.test(f) && inFolder(f)).map(f => f.replace(/\.[^.]+$/, '')));
        // A picture with the same name as a video is that video's poster, not a clip of its own.
        const files = S.media.filter(f => clipFile(f) && inFolder(f) && !have.has(f) && !(PICTURE_FILE.test(f) && videos.has(f.replace(/\.[^.]+$/, ''))));
        if (!files.length) { toast('Everything in that folder is already in the list.'); return; }
        edit(() => files.forEach(f => {
            const base = f.replace(/\.[^.]+$/, '');
            const poster = VIDEO_FILE.test(f) && S.media.find(m => m === base + '.jpg' || m === base + '.png');
            src.clips.push({ id: uniqueKey(base.split('/').pop(), new Set(src.clips.map(c => c.id))), label: base.split('/').pop(), src: f, ...(poster ? { poster } : {}), ...(VIDEO_FILE.test(f) ? { stops: [] } : {}) });
        }), { structural: true });
        toast(`Added ${files.length} clip${files.length === 1 ? '' : 's'}.`);
    } }, h('option', { value: '' }, 'Add a whole folder…'), folders.map(f => h('option', { value: f }, f)));
    const browseAll = () => openGallery({ title: `Add to "${src.label || 'clips'}"`, subtitle: 'Videos and pictures both work: pictures get the drawing tools without the play bar.', folder: mediaFolderFor(src.clips.map(c => c.src)), targets: [{ label: src.label, add: files => addClips(src, files) }] });
    return h('div', {},
        src.clips.length ? h('div', { class: 'ed-table-wrap' }, h('table', { class: 'ed-table' }, h('thead', {}, h('tr', {}, h('th'), h('th', {}, 'Clip'), h('th', {}, 'File'), h('th', {}, 'Poster'), h('th', {}, 'Turn'), h('th', { title: 'Where the clip starts and ends' }, 'Trim'), h('th', {}, 'Stops'), h('th'))), tbody)) : h('p', { class: 'ed-note' }, 'No clips yet.'),
        h('div', { class: 'ed-actions' },
            h('button', { type: 'button', class: 'ed-btn ed-mini ed-primary', onclick: browseAll }, ic('images'), 'Browse media…'),
            h('button', { type: 'button', class: 'ed-btn ed-mini', onclick: () => edit(() => src.clips.push({ id: uniqueKey('clip', new Set(src.clips.map(c => c.id))), label: `Clip ${src.clips.length + 1}`, src: '', stops: [] }), { structural: true }) }, ic('plus'), 'Add clip'),
            folders.length ? addFolder : null),
        h('p', { class: 'ed-note' }, 'Clips can be videos or pictures. Stop points are added while presenting (Add stop under the video), then saved with "Download review file with my stop points" in the Live panel.'));
}
function imagesEditor(src) {
    src.images ||= [];
    const tbody = h('tbody', {}, src.images.map((img, i) => h('tr', {},
        h('td', { class: 'ed-narrow' }, h('span', { class: 'ed-grip', title: 'Drag to reorder' }, ic('grip-vertical'))),
        h('td', {}, h('div', { class: 'ed-file-cell' }, cellInput(img, 'src', { list: 'dl-images', placeholder: 'picture.jpg' }),
            browseButton('image', src.images.map(i => i.src), f => edit(() => { img.src = f.src; }, { structural: true }), 'Choose this picture from the media gallery')), fileWarning(img.src)),
        h('td', {}, cellInput(img, 'caption', { placeholder: 'Caption' })),
        rowControls(src.images, i, { removeTitle: 'Remove this picture' }))));
    sortableTable(tbody, src.images);
    return h('div', {},
        src.images.length ? h('div', { class: 'ed-table-wrap' }, h('table', { class: 'ed-table' }, h('thead', {}, h('tr', {}, h('th'), h('th', {}, 'Picture'), h('th', {}, 'Caption'), h('th'))), tbody)) : h('p', { class: 'ed-note' }, 'No pictures yet.'),
        h('div', { class: 'ed-actions' },
            h('button', { type: 'button', class: 'ed-btn ed-mini ed-primary', onclick: () => openGallery({ title: `Add to "${src.label || 'pictures'}"`, accept: 'image', folder: mediaFolderFor(src.images.map(i => i.src)), targets: [{ label: src.label, add: files => edit(() => files.forEach(f => src.images.push({ src: f.src, caption: '' })), { structural: true }) }] }) }, ic('images'), 'Browse pictures…'),
            h('button', { type: 'button', class: 'ed-btn ed-mini', onclick: () => edit(() => src.images.push({ src: '', caption: '' }), { structural: true }) }, ic('plus'), 'Add picture')));
}
// Solid or see-through when the screen opens ("opacity": 1 = solid, below 1 = see-through at that amount).
// Viewers can still switch each part with its half-circle button or T.
const SEE_THROUGH = 0.35;
function setLook(target, look) {
    if (look === 'solid') target.opacity = 1;
    else target.opacity = (+target.opacity > 0 && +target.opacity < 0.99) ? target.opacity : SEE_THROUGH;
}
function lookSelect(target, { allowHidden = false } = {}) {
    const see = +target.opacity > 0 && +target.opacity < 0.99;
    const current = allowHidden && target.visible === false ? 'hidden' : see ? 'see' : 'solid';
    return h('select', { title: 'How it looks when the screen opens (viewers can switch it)', onchange: event => edit(() => {
        if (allowHidden) target.visible = event.target.value !== 'hidden';
        if (event.target.value !== 'hidden') setLook(target, event.target.value);
    }, { structural: true }) },
        h('option', { value: 'solid', selected: current === 'solid' }, 'Solid'),
        h('option', { value: 'see', selected: current === 'see' }, see && Math.abs(+target.opacity - SEE_THROUGH) > 0.01 ? `See-through (${Math.round(+target.opacity * 100)}%)` : 'See-through'),
        allowHidden ? h('option', { value: 'hidden', selected: current === 'hidden' }, 'Hidden') : null);
}
function sweepLooks(src) {
    return h('div', { class: 'ed-grid2' },
        h('label', { class: 'ed-field' }, h('span', {}, `${src.label || 'Slider model'} starts`), lookSelect(src)),
        src.animal ? h('label', { class: 'ed-field' }, h('span', {}, `${src.animal.label || 'Solid animal'} starts`), lookSelect(src.animal, { allowHidden: true })) : null,
        gridField(src));
}
// The XY grid under a 3D model ("grid": false = starts hidden; viewers can still switch it in the toolbar).
function gridField(src) {
    return h('label', { class: 'ed-field' }, h('span', {}, 'XY grid (floor) starts'),
        h('select', { title: 'Whether the grid under the model shows when the screen opens', onchange: event => edit(() => { if (event.target.value === 'off') src.grid = false; else delete src.grid; }) },
            h('option', { value: 'on', selected: src.grid !== false }, 'Shown'),
            h('option', { value: 'off', selected: src.grid === false }, 'Hidden')));
}
// Mark one of the slider's own stops as the part that was really made (a flag under that stop).
function originalMarker(src) {
    const values = Object.keys(src.files || {}).map(Number).sort((a, b) => a - b);
    const at = src.original?.at;
    return h('div', { class: 'ed-grid2' },
        h('label', { class: 'ed-field' }, h('span', {}, 'Original part is at'),
            h('select', { title: 'Flags this stop on the slider as the part that was really made', onchange: event => edit(() => {
                if (event.target.value === '') delete src.original;
                else src.original = { ...(src.original || { label: 'Original socket' }), at: +event.target.value };
            }, { structural: true }) },
                h('option', { value: '', selected: at === undefined }, 'Not marked'),
                values.map(v => h('option', { value: v, selected: at !== undefined && +at === v }, `${v}${src.unit ? ' ' + src.unit : ''}`)))),
        src.original ? field('Flag text', src.original, 'label', { placeholder: 'Original socket' }) : null);
}
// ---- presenter notes ------------------------------------------------------------------------------
// Notes you place in the presentation (pins, video marks, the notes box) live only in that browser. Bringing
// them in writes them into the file as "presenterNotes", so everyone sees them, on any device.
const NOTES_PREFIX = 'gap-design-review:';
async function readNotesSource(kind) {
    if (kind === 'local') {
        let raw = null;
        try { raw = localStorage.getItem(NOTES_PREFIX + S.doc.id); } catch { /* storage off */ }
        if (!raw) throw new Error('No notes for this presentation in this browser yet. Place them in Present (or the presentation on localhost) first.');
        return JSON.parse(raw);
    }
    if (kind === 'file') {
        const input = h('input', { type: 'file', accept: '.json,application/json' });
        const file = await new Promise(resolve => { input.addEventListener('change', () => resolve(input.files[0])); input.click(); });
        if (!file) return null;
        return JSON.parse(await file.text());
    }
    const link = prompt('Paste the link from "Copy link with my notes" (it ends in #r=…):');
    if (!link) return null;
    const code = (link.split('#r=')[1] || '').trim();
    if (!code) throw new Error('That link has no notes in it (no #r= part).');
    const bytes = Uint8Array.from(atob(code.slice(1).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((code.length + 2) % 4)), c => c.charCodeAt(0));
    if (code[0] === 'j') return JSON.parse(new TextDecoder().decode(bytes));
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return JSON.parse(await new Response(stream).text());
}
async function bringInNotes(items, kind) {
    let data;
    try { data = await readNotesSource(kind); } catch (error) { toast(error.message, { error: true, ms: 6000 }); return; }
    if (!data?.items) { if (data !== null) toast('That does not look like presentation notes.', { error: true }); return; }
    const by = prompt('Show these notes under which name?', data.reviewer && data.reviewer !== 'Derrick Campana' ? data.reviewer : 'Presenter');
    if (by === null) return;
    let screens = 0, marks = 0;
    edit(() => items.forEach(item => {
        const entry = data.items[item.id];
        const annotations = (entry?.annotations || []).filter(a => a && (a.kind === 'pin' || a.kind === 'mark'));
        const note = String(entry?.note || '').trim();
        if (!annotations.length && !note) return;
        item.presenterNotes = { by: by.trim() || 'Presenter', note, annotations };
        screens++;
        marks += annotations.length;
    }), { structural: true });
    toast(screens ? `Brought in notes for ${screens} screen${screens === 1 ? '' : 's'} (${marks} pin${marks === 1 ? '' : 's'} and marks). Save to keep them.` : 'No notes found for these screens.', { ms: 5000 });
}
function notesSourceMenu(items) {
    return h('select', { class: 'ed-mini', title: 'Where your notes are', onchange: event => { const kind = event.target.value; event.target.value = ''; if (kind) bringInNotes(items, kind); } },
        h('option', { value: '' }, items.length > 1 ? 'Bring in my notes for every screen…' : 'Bring in my notes…'),
        h('option', { value: 'local' }, 'From this computer (notes placed on localhost)'),
        h('option', { value: 'file' }, 'From a notes file (Summary → Download .json)'),
        h('option', { value: 'link' }, 'From a link (Copy link with my notes)'));
}
function presenterNotesCard(item) {
    const pn = item.presenterNotes;
    const count = pn?.annotations?.length || 0;
    return card({ title: 'Presenter notes', summary: pn ? `${count} pin${count === 1 ? '' : 's'} / marks${pn.note ? ' + note' : ''}, by ${pn.by || 'Presenter'}` : 'none' }, 'presentation', null,
        h('p', { class: 'ed-note' }, 'Notes you place while presenting are kept only in that browser. Bring them in here and save: everyone then sees them (in gold, with your name) on every device.'),
        h('div', { class: 'ed-actions' }, notesSourceMenu([item]),
            pn ? h('button', { type: 'button', class: 'ed-btn ed-mini ed-danger', onclick: () => edit(() => { delete item.presenterNotes; }, { structural: true }) }, ic('trash-2'), 'Remove presenter notes') : null),
        pn ? h('div', { class: 'ed-grid2' },
            field('Shown as', pn, 'by', { placeholder: 'Presenter' }),
            field('Note (shown above the reviewer\'s notes)', pn, 'note', { multiline: true, rows: 3 })) : null);
}
function sweepEditor(src) {
    if (Array.isArray(src.axes)) {
        // Two inputs swept together (e.g. pelvic thickness × thicken distance). Files are keyed "a|b".
        const combos = [...(src.original?.file ? ['original'] : []), ...Object.keys(src.files || {})];
        const starts = h('select', { onchange: event => edit(() => { src.defaultValue = event.target.value; }) },
            combos.map(key => h('option', { value: key, selected: String(src.defaultValue) === key }, key === 'original' ? `${src.original.label || 'Original'} (the part that was made)` : key.split('|').map((v, i) => `${src.axes[i]?.short || src.axes[i]?.param} ${v}${src.axes[i]?.unit ? ' ' + src.axes[i].unit : ''}`).join(' · '))));
        return h('div', {},
            src.axes.map((axis, i) => h('div', { class: 'ed-grid2' },
                field(`Bar ${i + 1} name`, axis, 'param'),
                field('Short name (in the pick button)', axis, 'short'),
                field('Unit', axis, 'unit'))),
            h('label', { class: 'ed-field' }, h('span', {}, 'Starts at'), starts),
            src.original?.file ? null : h('div', { class: 'ed-grid2' },
                h('label', { class: 'ed-field' }, h('span', {}, 'Marked combination'),
                    h('select', { title: 'Outlines this combination on the bars and adds a button that goes to it', onchange: event => edit(() => {
                        if (event.target.value === '') delete src.original;
                        else src.original = { ...(src.original || { label: 'Proposed' }), at: event.target.value };
                    }, { structural: true }) },
                        h('option', { value: '', selected: src.original?.at === undefined }, 'Not marked'),
                        Object.keys(src.files || {}).map(key => h('option', { value: key, selected: String(src.original?.at) === key }, key.split('|').map((v, i) => `${src.axes[i]?.short || src.axes[i]?.param} ${v}${src.axes[i]?.unit ? ' ' + src.axes[i].unit : ''}`).join(' · '))))),
                src.original ? field('Marker text', src.original, 'label', { placeholder: 'Proposed' }) : null),
            sweepLooks(src),
            h('p', { class: 'ed-note' }, `${combos.length} model files, one per combination (${src.axes.map(a => `${a.values.length} ${a.short || a.param}`).join(' × ')}). Combinations not generated yet show as striped.`));
    }
    const valuesInput = h('input', { value: (src.values || []).join(', '), placeholder: '2, 3, 4, 5',
        oninput: event => edit(() => { src.values = event.target.value.split(/[,\s]+/).filter(Boolean).map(Number).filter(Number.isFinite); }) });
    // A slider with the real part as an extra stop ("original") starts at a menu choice, not a number.
    const startField = src.original?.file
        ? h('label', { class: 'ed-field' }, h('span', {}, 'Starts at'), h('select', { onchange: event => edit(() => { src.defaultValue = event.target.value === 'original' ? 'original' : +event.target.value; }) },
            ['original', ...Object.keys(src.files || {}).map(Number).sort((a, b) => a - b)].map(v => h('option', { value: v, selected: String(src.defaultValue) === String(v) }, v === 'original' ? (src.original.label || 'Original') : `${v}${src.unit ? ' ' + src.unit : ''}`))))
        : field('Starts at', src, 'defaultValue', { type: 'number', number: true });
    return h('div', {},
        h('div', { class: 'ed-grid2' },
            field('Slider name', src, 'param', { placeholder: 'Scan shrink' }),
            field('Unit', src, 'unit', { placeholder: '%, mm, …' }),
            startField),
        sweepLooks(src),
        src.original?.file || src.source ? null : originalMarker(src),
        src.original ? h('p', { class: 'ed-note' }, `Marked as the original: ${src.original.label || 'Original'}${src.original.file ? ` (${src.original.file}, its own stop on the slider)` : ` at ${src.original.at ?? 0}${src.unit ? ' ' + src.unit : ''}`}.`) : null,
        src.source ? h('label', { class: 'ed-field' }, h('span', {}, 'Slider values'), valuesInput, h('small', {}, `Preview made by scaling ${src.source}.`))
            : h('p', { class: 'ed-note' }, `${Object.keys(src.files || {}).length || (src.values || []).length} model files, one per slider value. Their file list is kept as it is.`));
}
function pendingEditor(item, key, src) {
    const turnInto = kind => edit(() => {
        const keep = { label: src.label, caption: src.caption, tone: src.tone };
        const firstFile = String(src.expects || '').split(/[,\s]+/).find(f => /\.(glb|stl|obj|mp4|webm|mov|jpe?g|png|gif)$/i.test(f)) || '';
        Object.keys(src).forEach(k => delete src[k]);
        Object.assign(src, Object.fromEntries(Object.entries(keep).filter(([, v]) => v !== undefined)));
        if (kind === 'assembly') Object.assign(src, { kind, layers: [{ key: 'part-1', label: keep.label || 'Part', file: /\.(glb|stl|obj)$/i.test(firstFile) ? firstFile : '', color: '#e0a100', opacity: 1 }] });
        else if (kind === 'video') Object.assign(src, { kind, src: /\.(mp4|webm|mov)$/i.test(firstFile) ? firstFile : '', stops: [] });
        else Object.assign(src, { kind: 'image', images: [{ src: /\.(jpe?g|png|gif)$/i.test(firstFile) ? firstFile : '', caption: '' }] });
    }, { structural: true });
    return h('div', {},
        h('div', { class: 'ed-grid2' },
            field('Waiting for (file names)', src, 'expects', { placeholder: 'ollie-socket-v2.glb' }),
            field('Note shown on the placeholder', src, 'note', { multiline: true, rows: 2 })),
        h('div', { class: 'ed-actions' }, h('span', { class: 'ed-hint', style: 'margin:0 4px 0 0' }, 'Files ready? Turn it into:'),
            h('button', { type: 'button', class: 'ed-btn ed-mini', onclick: () => turnInto('assembly') }, ic('box'), '3D model'),
            h('button', { type: 'button', class: 'ed-btn ed-mini', onclick: () => turnInto('video') }, ic('film'), 'Video'),
            h('button', { type: 'button', class: 'ed-btn ed-mini', onclick: () => turnInto('image') }, ic('image'), 'Pictures')));
}
function choicesCard(item) {
    if (!item.choices) {
        return card({ title: 'Multiple-choice question', summary: 'none' }, 'list-checks', 'Optional: buttons the reviewer clicks to answer (e.g. bumps vs a rubber pad).',
            h('div', { class: 'ed-actions' }, h('button', { type: 'button', class: 'ed-btn', onclick: () => edit(() => { item.choices = { ask: 'Which would you choose?', options: [{ key: 'option-1', label: 'Option 1' }, { key: 'option-2', label: 'Option 2' }] }; }, { structural: true }) }, ic('plus'), 'Add a question')));
    }
    const options = item.choices.options ||= [];
    const tbody = h('tbody', {}, options.map((option, i) => h('tr', {},
        h('td', { class: 'ed-narrow' }, h('span', { class: 'ed-grip', title: 'Drag to reorder' }, ic('grip-vertical'))),
        h('td', {}, cellInput(option, 'label', { placeholder: 'Answer' })),
        rowControls(options, i, { removeTitle: 'Remove this answer' }))));
    sortableTable(tbody, options);
    return card({ title: 'Multiple-choice question', summary: item.choices.ask || '' }, 'list-checks', 'Reviewers\' answers are stored per answer, so renaming an answer keeps them.',
        field('Question', item.choices, 'ask'),
        h('div', { class: 'ed-table-wrap' }, h('table', { class: 'ed-table' }, h('thead', {}, h('tr', {}, h('th'), h('th', {}, 'Answers'), h('th'))), tbody)),
        h('div', { class: 'ed-actions' },
            h('button', { type: 'button', class: 'ed-btn ed-mini', onclick: () => edit(() => options.push({ key: uniqueKey('option', new Set(options.map(o => o.key))), label: `Option ${options.length + 1}` }), { structural: true }) }, ic('plus'), 'Add answer'),
            h('button', { type: 'button', class: 'ed-btn ed-mini ed-danger', onclick: () => edit(() => { delete item.choices; }, { structural: true }) }, ic('trash-2'), 'Remove question')));
}

// ---- presentation settings -------------------------------------------------------------------------

function settingsForm() {
    const doc = S.doc;
    const tools = new Set(Array.isArray(doc.participantTools) ? doc.participantTools : DEFAULT_TOOLS);
    const toolBoxes = TOOL_KEYS.map(([key, label]) => h('label', { class: 'ed-check' }, h('input', { type: 'checkbox', checked: tools.has(key), onchange: event => edit(() => {
        const next = new Set(Array.isArray(doc.participantTools) ? doc.participantTools : DEFAULT_TOOLS);
        if (event.target.checked) next.add(key); else next.delete(key);
        doc.participantTools = TOOL_KEYS.map(([k]) => k).filter(k => next.has(k));
    }) }), label));
    doc.library ||= [];
    const tbody = h('tbody', {}, doc.library.map((entry, i) => h('tr', {},
        h('td', { class: 'ed-narrow' }, h('span', { class: 'ed-grip', title: 'Drag to reorder' }, ic('grip-vertical'))),
        h('td', {}, cellInput(entry, 'label', { placeholder: 'Name' })),
        h('td', { class: 'ed-narrow' }, h('select', { onchange: event => edit(() => { entry.kind = event.target.value; }, { structural: true }) }, h('option', { value: 'video', selected: entry.kind !== 'image' }, 'Video'), h('option', { value: 'image', selected: entry.kind === 'image' }, 'Picture'))),
        h('td', {}, h('div', { class: 'ed-file-cell' }, cellInput(entry, 'src', { list: entry.kind === 'image' ? 'dl-images' : 'dl-videos' }),
            browseButton(entry.kind === 'image' ? 'image' : 'video', doc.library.map(e => e.src), f => edit(() => { entry.src = f.src; if (f.poster) entry.poster = f.poster; }, { structural: true }))), fileWarning(entry.src)),
        h('td', {}, entry.kind === 'image' ? cellInput(entry, 'caption', { placeholder: 'Caption' }) : cellInput(entry, 'poster', { list: 'dl-images', placeholder: 'Poster (optional)' })),
        rowControls(doc.library, i, { removeTitle: 'Remove from the library' }))));
    sortableTable(tbody, doc.library);
    return h('div', {},
        h('div', { class: 'ed-form-head' }, h('div', {}, h('h2', {}, 'Presentation settings'), h('span', { class: 'ed-id', title: 'Reviewers\' notes are stored under this id' }, `id: ${doc.id || '(none)'}`))),
        card({ title: 'Presenter notes', summary: `${doc.items.filter(i => i.presenterNotes).length} screen(s) have them` }, 'presentation', null,
            h('p', { class: 'ed-note' }, 'Bring the notes you placed while presenting (pins, video marks, the notes box) into every screen at once. Save afterwards; everyone then sees them on any device.'),
            h('div', { class: 'ed-actions' }, notesSourceMenu(doc.items))),
        card({ title: 'Title page', summary: doc.title || '' }, 'presentation', null,
            field('Title', doc, 'title'),
            field('Small line above the title', doc, 'subtitle', { placeholder: 'Give a Paw × Bionic Pets' }),
            field('Introduction', doc, 'intro', { multiline: true, rows: 4 }),
            h('div', { class: 'ed-grid2' },
                field('Reviewer name (filled in for them)', doc, 'reviewerDefault', { placeholder: 'Derrick Campana' }),
                field('Email for "send my review"', doc, 'returnEmail', { type: 'email', placeholder: 'optional' }))),
        card({ title: 'What participants can use', summary: `${tools.size} tool${tools.size === 1 ? '' : 's'}` }, 'sliders-horizontal', 'Where a live session starts. As presenter you can change this during the meeting in the Live panel.',
            h('div', {}, toolBoxes),
            h('div', { class: 'ed-actions' },
                h('button', { type: 'button', class: 'ed-btn ed-mini', onclick: () => edit(() => { doc.participantTools = DEFAULT_TOOLS.slice(); }, { structural: true }) }, 'Reviewer default'),
                h('button', { type: 'button', class: 'ed-btn ed-mini', onclick: () => edit(() => { doc.participantTools = []; }, { structural: true }) }, 'Watch only'))),
        card({ title: 'Media library', summary: `${doc.library.length} item${doc.library.length === 1 ? '' : 's'}` }, 'library', 'Videos and pictures the presenter can drop onto any screen during the meeting with the Media button. They also appear under "From the media library" when adding materials.',
            doc.library.length ? h('div', { class: 'ed-table-wrap' }, h('table', { class: 'ed-table' }, h('thead', {}, h('tr', {}, h('th'), h('th', {}, 'Name'), h('th', {}, 'Type'), h('th', {}, 'File'), h('th', {}, 'Poster / caption'), h('th'))), tbody)) : null,
            h('div', { class: 'ed-actions' },
                h('button', { type: 'button', class: 'ed-btn ed-mini ed-primary', onclick: browseMedia }, ic('images'), 'Browse media…'),
                h('button', { type: 'button', class: 'ed-btn ed-mini', onclick: () => edit(() => doc.library.push({ id: uniqueKey('media', new Set(doc.library.map(e => e.id))), kind: 'video', label: 'New media', src: '' }), { structural: true }) }, ic('plus'), 'Add media'))));
}

// ---- wiring ------------------------------------------------------------------------------------------

function renderAll() { renderList(); renderForm(); }
$('#ed-undo').addEventListener('click', undo);
$('#ed-redo').addEventListener('click', redo);
$('#ed-save').addEventListener('click', () => save());
$('#ed-save-as').addEventListener('click', saveAs);
$('#ed-download').addEventListener('click', () => download());
$('#ed-add-screen').addEventListener('click', addScreen);
$('#ed-media').addEventListener('click', browseMedia);
$('#ed-toggle-preview').addEventListener('click', () => setPreview(!S.preview));
$('#ed-toggle-outline').addEventListener('click', () => setOutline(!S.outline));
document.querySelectorAll('.ed-mode [data-mode]').forEach(button => button.addEventListener('click', () => setMode(button.dataset.mode)));
$('#ed-fullscreen').addEventListener('click', toggleFullscreen);
$('#ed-reload-preview').addEventListener('click', refreshPreview);
// The real presentation (as viewers see it), in its own tab, on the screen being edited. Its Edit button
// comes back to this tab (named below) and selects the screen it showed, without reloading the editor.
async function openViewerView() {
    if (dirty()) {
        if (!confirm('Save your changes first? The presentation opens from the saved file.')) return;
        if (!(await save())) return;
    }
    const item = S.sel !== 'settings' && !S.sel?.hidden ? `&item=${encodeURIComponent(S.sel.id)}` : '';
    window.open(`design-review.html?review=${encodeURIComponent(S.path)}&host=1${item}`, 'gap-review-present');
}
$('#ed-present').addEventListener('click', openViewerView);
$('#ed-open-viewer').addEventListener('click', openViewerView);
window.name = 'gap-review-editor';
if ('BroadcastChannel' in window) {
    new BroadcastChannel('gap-review-editor').addEventListener('message', event => {
        if (event.data?.type !== 'edit-screen' || event.data.file !== S.path) return;
        if (document.fullscreenElement) document.exitFullscreen?.();
        setMode('edit');
        const item = S.doc?.items.find(it => it.id === event.data.id);
        if (item && item !== S.sel) select(item);
    });
}
$('#ed-file').addEventListener('change', event => {
    if (dirty() && !confirm('You have unsaved changes. They are kept in this browser, but switch files anyway?')) { event.target.value = S.path; return; }
    location.search = `?file=${encodeURIComponent(event.target.value)}`;
});
document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && S.mode === 'present' && !document.fullscreenElement) { setMode('edit'); return; }
    const mod = event.ctrlKey || event.metaKey;
    if (!mod) return;
    const key = event.key.toLowerCase();
    if (key === 's') { event.preventDefault(); save(); return; }
    if (key === 'e') { event.preventDefault(); setMode('edit'); return; }
    if (key === 'p') { event.preventDefault(); setMode('present'); return; }
    if (key === '\\') { event.preventDefault(); if (S.mode === 'edit') setOutline(!S.outline); return; }
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) && document.activeElement.type !== 'checkbox' && document.activeElement.type !== 'radio';
    if (typing) return; // the text box's own undo
    if (key === 'z' && !event.shiftKey) { event.preventDefault(); undo(); }
    else if (key === 'y' || (key === 'z' && event.shiftKey)) { event.preventDefault(); redo(); }
});
addEventListener('beforeunload', event => { if (S.doc && dirty()) event.preventDefault(); });

(async function boot() {
    try {
        await loadFileList();
        await loadReview();
        document.title = `${S.doc.title || 'Presentation'} - Presentation Editor`;
        renderAll();
        changed();
        setPreview(S.preview);
        if (!S.localServer) toast('Opened without the local preview server: Save will download the file instead.', { ms: 6000 });
    } catch (error) {
        console.error(error);
        $('#ed-form').replaceChildren(h('div', { class: 'ed-card' }, h('h3', {}, 'This presentation could not be opened'), h('p', {}, error.message)));
        $('#ed-status').textContent = 'Not loaded';
    }
    icons();
})();

window.edDebug = { S, save, undo, redo };
