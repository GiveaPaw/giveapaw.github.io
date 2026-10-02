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
    playlist: ['list-video', 'Videos'], image: ['image', 'Pictures'], pending: ['hourglass', 'Placeholder'],
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
    preview: innerWidth > 1250,
};
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
    if (isDirty) store('set', wipKey(), JSON.stringify({ at: Date.now(), text: docText() }));
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
}
async function loadReview() {
    const response = await fetch(S.path, { cache: 'no-cache' });
    if (!response.ok) throw new Error(`Could not open ${S.path} (${response.status}).`);
    S.doc = await response.json();
    S.doc.items ||= [];
    S.savedText = docText();
    S.sel = S.doc.items[0] || 'settings';
    const wip = (() => { try { return JSON.parse(store('get', wipKey())); } catch { return null; } })();
    if (wip?.text && wip.text !== S.savedText) {
        const banner = $('#ed-banner');
        banner.replaceChildren(
            h('span', {}, ic('history'), ` You have unsaved edits to this presentation from ${new Date(wip.at).toLocaleString()}.`),
            h('button', { type: 'button', class: 'ed-btn ed-primary ed-mini', onclick: () => { pushUndo(); restore(wip.text); banner.hidden = true; toast('Unsaved edits restored'); } }, 'Restore them'),
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
async function save(path = S.path) {
    if (!S.localServer) {
        download(path.split('/').pop());
        toast(`Downloaded ${path.split('/').pop()}. Saving straight into the site needs the local preview server; put the file in reviews/.`, { ms: 6000 });
        return false;
    }
    try {
        const response = await fetch('/__editor/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path, review: S.doc }) });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.error || `Save failed (${response.status}).`);
        S.path = path;
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
    if (!S.preview) return;
    const frame = $('#ed-frame');
    const next = previewUrl();
    if (frame.getAttribute('src') !== next) frame.setAttribute('src', next);
    else frame.contentWindow?.location.reload();
}
function schedulePreview() { clearTimeout(previewTimer); previewTimer = setTimeout(refreshPreview, 900); }
const PREVIEW_WIDTH = 1280;
function fitPreview() {
    const box = $('.ed-frame-box');
    const frame = $('#ed-frame');
    if (!box.clientWidth) return;
    const scale = Math.min(1, box.clientWidth / PREVIEW_WIDTH);
    frame.style.width = `${box.clientWidth / scale}px`;
    frame.style.height = `${box.clientHeight / scale}px`;
    frame.style.transform = `scale(${scale})`;
}
new ResizeObserver(fitPreview).observe($('.ed-frame-box'));
function setPreview(on) {
    S.preview = on;
    $('.ed-app').classList.toggle('no-preview', !on);
    $('#ed-toggle-preview').classList.toggle('active', on);
    if (on) { fitPreview(); refreshPreview(); }
    else $('#ed-frame').removeAttribute('src');
}

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
    video: { name: 'Videos', desc: 'One or more clips, with stop points and drawing', make: () => ({ sources: { video: { kind: 'playlist', label: 'Videos', caption: '', clips: [] } }, views: [{ key: 'video', label: 'Video', icon: 'film', panes: ['video'] }] }) },
    both: { name: 'Video + model', desc: 'Tabs for video, model, and both side by side', make: () => ({ sources: { video: { kind: 'playlist', label: 'Videos', caption: '', clips: [] }, model: assemblySource('3D model') }, views: [{ key: 'video', label: 'Video', icon: 'film', panes: ['video'] }, { key: 'both', label: 'Video + 3D', icon: 'columns-2', panes: ['video', 'model'] }, { key: 'model', label: '3D model', icon: 'box', panes: ['model'] }] }) },
    compare: { name: 'Current vs proposed', desc: 'Two models side by side with linked cameras', make: () => ({ sources: { current: assemblySource('Current'), proposed: { ...assemblySource('Proposed'), tone: 'proposed' } }, views: [{ key: 'split', label: 'Side by side', icon: 'columns-2', panes: ['current', 'proposed'] }, { key: 'current', label: 'Current', icon: 'box', panes: ['current'] }, { key: 'proposed', label: 'Proposed', icon: 'box', panes: ['proposed'] }] }) },
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
        const item = { id: uniqueKey('screen-' + key, new Set(S.doc.items.map(it => it.id))), kind: 'stage', title: `New screen: ${template.name}`, context: '', ...template.make() };
        const at = S.sel === 'settings' ? S.doc.items.length : S.doc.items.indexOf(S.sel) + 1;
        edit(() => S.doc.items.splice(at, 0, item), { structural: true });
        select(item);
    }
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
function cellInput(obj, key, { list = null, placeholder = '', type = 'text', number = false, width = null, step = null, min = null, max = null } = {}) {
    return h('input', { type, value: obj[key] ?? '', list, placeholder, step, min, max, style: width ? `width:${width}` : null,
        oninput: event => edit(() => {
            const raw = event.target.value;
            if (raw === '') delete obj[key];
            else obj[key] = number ? +raw : raw;
        }) });
}
function card(title, iconName, sub, ...body) {
    return h('section', { class: 'ed-card' }, h('h3', {}, iconName && ic(iconName), title), sub && h('p', { class: 'ed-sub' }, sub), ...body);
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
            h('button', { type: 'button', class: 'ed-btn ed-mini', onclick: () => duplicateScreen(item) }, ic('copy'), 'Duplicate'),
            h('button', { type: 'button', class: 'ed-btn ed-mini ed-danger', onclick: () => deleteScreen(item) }, ic('trash-2'), 'Delete'))));

    wrap.append(card('Words on the screen', 'type', null,
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
        const first = Object.keys(item.sources || {})[0];
        if (!first) { toast('Add a material first, then a tab to show it.', { error: true }); return; }
        edit(() => item.views.push({ key: uniqueKey('tab', new Set(item.views.map(v => v.key))), label: 'New tab', icon: 'box', panes: [first] }), { structural: true });
    };
    return card('Tabs', 'panels-top-left', 'Each tab shows one material, or two side by side. The presenter switches tabs; drag to set their order.',
        item.views.length ? h('div', { class: 'ed-table-wrap' }, h('table', { class: 'ed-table' }, h('thead', {}, h('tr', {}, h('th'), h('th', {}, 'Tab name'), h('th', {}, 'Icon'), h('th', {}, 'Shows'), h('th', {}, 'Beside it'), h('th', {}, 'Opens first'), h('th'))), tbody)) : h('p', { class: 'ed-note' }, 'No tabs yet.'),
        h('div', { class: 'ed-actions' }, h('button', { type: 'button', class: 'ed-btn', onclick: add }, ic('plus'), 'Add tab')));
}

function materialsCard(item) {
    item.sources ||= {};
    const body = h('div');
    Object.entries(item.sources).forEach(([key, src]) => body.append(materialEditor(item, key, src)));
    const library = S.doc.library || [];
    const addSource = (base, src) => {
        const key = uniqueKey(base, new Set(Object.keys(item.sources)));
        edit(() => {
            item.sources[key] = src;
            item.views ||= [];
            item.views.push({ key: uniqueKey(key, new Set(item.views.map(v => v.key))), label: src.label, icon: src.kind === 'image' ? 'image' : src.kind === 'assembly' ? 'box' : 'film', panes: [key] });
        }, { structural: true });
        toast(`Added "${src.label}" and a tab for it.`);
    };
    const libSelect = h('select', { onchange: event => {
        const entry = library.find(e => e.id === event.target.value);
        event.target.value = '';
        if (!entry) return;
        if (entry.kind === 'image') addSource(entry.id, { kind: 'image', label: entry.label, caption: entry.caption || '', images: [{ src: entry.src, caption: entry.caption || '' }] });
        else addSource(entry.id, { kind: 'video', label: entry.label, src: entry.src, poster: entry.poster, stops: [] });
    } }, h('option', { value: '' }, 'From the media library…'), library.map(entry => h('option', { value: entry.id }, entry.label)));
    return card('Materials', 'shapes', 'The models, videos and pictures this screen can show. Tabs pick from these.',
        body,
        h('div', { class: 'ed-actions' },
            h('button', { type: 'button', class: 'ed-btn', onclick: () => addSource('model', assemblySource('3D model')) }, ic('box'), '3D model'),
            h('button', { type: 'button', class: 'ed-btn', onclick: () => addSource('videos', { kind: 'playlist', label: 'Videos', caption: '', clips: [] }) }, ic('list-video'), 'Videos'),
            h('button', { type: 'button', class: 'ed-btn', onclick: () => addSource('pictures', { kind: 'image', label: 'Pictures', caption: '', images: [] }) }, ic('image'), 'Pictures'),
            h('button', { type: 'button', class: 'ed-btn', onclick: () => addSource('placeholder', { kind: 'pending', label: 'Coming soon', expects: '', note: '' }) }, ic('hourglass'), 'Placeholder'),
            library.length ? libSelect : null));
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
    const head = h('div', { class: 'ed-material-head' },
        ic(iconName),
        cellInput(src, 'label', { placeholder: kindLabel }),
        h('span', { class: 'ed-tag' + (src.kind === 'pending' ? ' pending' : '') }, kindLabel),
        src.tone === 'proposed' ? h('span', { class: 'ed-tag proposed' }, 'Proposed') : null,
        h('button', { type: 'button', class: 'ed-btn ed-mini ed-danger', title: 'Remove this material', onclick: remove }, ic('trash-2')));
    const body = h('div', { class: 'ed-material-body' },
        h('p', { class: 'ed-used' }, usedIn.length ? `Shown in: ${usedIn.join(', ')}` : 'Not shown in any tab yet.'),
        h('div', { class: 'ed-grid2' },
            field('Caption', src, 'caption', { placeholder: 'Short label shown on the view' }),
            h('div', {}, h('label', { class: 'ed-check' }, h('input', { type: 'checkbox', checked: src.tone === 'proposed', onchange: event => edit(() => { if (event.target.checked) src.tone = 'proposed'; else delete src.tone; }, { structural: true }) }), 'Mark as proposed (orange label)'))));
    if (src.kind === 'assembly') body.append(partsEditor(src));
    else if (src.kind === 'playlist') body.append(clipsEditor(src));
    else if (src.kind === 'video') body.append(h('div', { class: 'ed-grid2' }, field('Video file', src, 'src', { list: 'dl-videos' }), field('Poster image', src, 'poster', { list: 'dl-images' })), stopsNote(src.stops));
    else if (src.kind === 'image') body.append(imagesEditor(src));
    else if (src.kind === 'sweep') body.append(sweepEditor(src));
    else if (src.kind === 'pending') body.append(pendingEditor(item, key, src));
    return h('div', { class: 'ed-material' }, head, body);
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
        h('td', { class: 'ed-narrow' }, cellInput(layer, 'opacity', { type: 'number', number: true, step: 0.05, min: 0, max: 1, width: '64px' })),
        h('td', { class: 'ed-narrow', title: 'Visible when the screen opens' }, h('input', { type: 'checkbox', checked: layer.visible !== false, onchange: event => edit(() => { if (event.target.checked) delete layer.visible; else layer.visible = false; }) })),
        rowControls(src.layers, i, { removeTitle: 'Remove this part' }))));
    sortableTable(tbody, src.layers);
    const extras = [src.paint && 'Surface painting is on for this model', src.leg && 'The leg-length tool is on for this model'].filter(Boolean);
    return h('div', {},
        h('div', { class: 'ed-table-wrap' }, h('table', { class: 'ed-table' }, h('thead', {}, h('tr', {}, h('th'), h('th', {}, 'Part'), h('th', {}, 'File'), h('th', {}, 'Colour'), h('th', {}, 'Opacity'), h('th', {}, 'On'), h('th'))), tbody)),
        h('div', { class: 'ed-actions' }, h('button', { type: 'button', class: 'ed-btn ed-mini', onclick: () => edit(() => src.layers.push({ key: uniqueKey('part', new Set(src.layers.map(l => l.key))), label: 'Part', file: '', color: '#b9c2cc', opacity: 1 }), { structural: true }) }, ic('plus'), 'Add part')),
        extras.length ? h('p', { class: 'ed-note' }, extras.join('. ') + '. Its settings are kept as they are.') : null);
}
function clipsEditor(src) {
    src.clips ||= [];
    const tbody = h('tbody', {}, src.clips.map((clip, i) => h('tr', {},
        h('td', { class: 'ed-narrow' }, h('span', { class: 'ed-grip', title: 'Drag to reorder' }, ic('grip-vertical'))),
        h('td', {}, cellInput(clip, 'label', { placeholder: 'Clip name' })),
        h('td', {}, cellInput(clip, 'src', { list: 'dl-videos', placeholder: 'video.mp4' }), fileWarning(clip.src)),
        h('td', {}, cellInput(clip, 'poster', { list: 'dl-images', placeholder: 'poster.jpg (optional)' })),
        h('td', { class: 'ed-narrow' }, (clip.stops || []).length ? h('span', { class: 'ed-tag', title: 'Stop points' }, ic('octagon-pause'), clip.stops.length) : null),
        rowControls(src.clips, i, { removeTitle: 'Remove this clip' }))));
    sortableTable(tbody, src.clips);
    const folders = [...new Set(S.media.filter(f => /\.(mp4|webm|mov|m4v)$/i.test(f)).map(f => f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '.'))];
    const addFolder = h('select', { onchange: event => {
        const folder = event.target.value;
        event.target.value = '';
        if (!folder) return;
        const have = new Set(src.clips.map(c => c.src));
        const files = S.media.filter(f => /\.(mp4|webm|mov|m4v)$/i.test(f) && (folder === '.' ? !f.includes('/') : f.startsWith(folder + '/') && !f.slice(folder.length + 1).includes('/')) && !have.has(f));
        if (!files.length) { toast('Every video in that folder is already in the list.'); return; }
        edit(() => files.forEach(f => {
            const base = f.replace(/\.[^.]+$/, '');
            const poster = S.media.find(m => m === base + '.jpg' || m === base + '.png');
            src.clips.push({ id: uniqueKey(base.split('/').pop(), new Set(src.clips.map(c => c.id))), label: base.split('/').pop(), src: f, ...(poster ? { poster } : {}), stops: [] });
        }), { structural: true });
        toast(`Added ${files.length} clip${files.length === 1 ? '' : 's'}.`);
    } }, h('option', { value: '' }, 'Add every video in a folder…'), folders.map(f => h('option', { value: f }, f)));
    return h('div', {},
        src.clips.length ? h('div', { class: 'ed-table-wrap' }, h('table', { class: 'ed-table' }, h('thead', {}, h('tr', {}, h('th'), h('th', {}, 'Clip'), h('th', {}, 'Video file'), h('th', {}, 'Poster'), h('th', {}, 'Stops'), h('th'))), tbody)) : h('p', { class: 'ed-note' }, 'No clips yet.'),
        h('div', { class: 'ed-actions' },
            h('button', { type: 'button', class: 'ed-btn ed-mini', onclick: () => edit(() => src.clips.push({ id: uniqueKey('clip', new Set(src.clips.map(c => c.id))), label: `Clip ${src.clips.length + 1}`, src: '', stops: [] }), { structural: true }) }, ic('plus'), 'Add clip'),
            folders.length ? addFolder : null),
        h('p', { class: 'ed-note' }, 'Stop points are added while presenting (Add stop under the video), then saved with "Download review file with my stop points" in the Live panel.'));
}
function imagesEditor(src) {
    src.images ||= [];
    const tbody = h('tbody', {}, src.images.map((img, i) => h('tr', {},
        h('td', { class: 'ed-narrow' }, h('span', { class: 'ed-grip', title: 'Drag to reorder' }, ic('grip-vertical'))),
        h('td', {}, cellInput(img, 'src', { list: 'dl-images', placeholder: 'picture.jpg' }), fileWarning(img.src)),
        h('td', {}, cellInput(img, 'caption', { placeholder: 'Caption' })),
        rowControls(src.images, i, { removeTitle: 'Remove this picture' }))));
    sortableTable(tbody, src.images);
    return h('div', {},
        src.images.length ? h('div', { class: 'ed-table-wrap' }, h('table', { class: 'ed-table' }, h('thead', {}, h('tr', {}, h('th'), h('th', {}, 'Picture'), h('th', {}, 'Caption'), h('th'))), tbody)) : h('p', { class: 'ed-note' }, 'No pictures yet.'),
        h('div', { class: 'ed-actions' }, h('button', { type: 'button', class: 'ed-btn ed-mini', onclick: () => edit(() => src.images.push({ src: '', caption: '' }), { structural: true }) }, ic('plus'), 'Add picture')));
}
function sweepEditor(src) {
    if (Array.isArray(src.axes)) {
        // Two inputs swept together (e.g. pelvic thickness × thicken distance). Files are keyed "a|b".
        const combos = Object.keys(src.files || {});
        const starts = h('select', { onchange: event => edit(() => { src.defaultValue = event.target.value; }) },
            combos.map(key => h('option', { value: key, selected: String(src.defaultValue) === key }, key.split('|').map((v, i) => `${src.axes[i]?.short || src.axes[i]?.param} ${v}${src.axes[i]?.unit ? ' ' + src.axes[i].unit : ''}`).join(' · '))));
        return h('div', {},
            src.axes.map((axis, i) => h('div', { class: 'ed-grid2' },
                field(`Bar ${i + 1} name`, axis, 'param'),
                field('Short name (in the pick button)', axis, 'short'),
                field('Unit', axis, 'unit'))),
            h('label', { class: 'ed-field' }, h('span', {}, 'Starts at'), starts),
            h('p', { class: 'ed-note' }, `${combos.length} model files, one per combination (${src.axes.map(a => `${a.values.length} ${a.short || a.param}`).join(' × ')}). Combinations not generated yet show as striped.`));
    }
    const valuesInput = h('input', { value: (src.values || []).join(', '), placeholder: '2, 3, 4, 5',
        oninput: event => edit(() => { src.values = event.target.value.split(/[,\s]+/).filter(Boolean).map(Number).filter(Number.isFinite); }) });
    return h('div', {},
        h('div', { class: 'ed-grid2' },
            field('Slider name', src, 'param', { placeholder: 'Scan shrink' }),
            field('Unit', src, 'unit', { placeholder: '%, mm, …' }),
            field('Starts at', src, 'defaultValue', { type: 'number', number: true })),
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
        return card('Multiple-choice question', 'list-checks', 'Optional: buttons the reviewer clicks to answer (e.g. bumps vs a rubber pad).',
            h('div', { class: 'ed-actions' }, h('button', { type: 'button', class: 'ed-btn', onclick: () => edit(() => { item.choices = { ask: 'Which would you choose?', options: [{ key: 'option-1', label: 'Option 1' }, { key: 'option-2', label: 'Option 2' }] }; }, { structural: true }) }, ic('plus'), 'Add a question')));
    }
    const options = item.choices.options ||= [];
    const tbody = h('tbody', {}, options.map((option, i) => h('tr', {},
        h('td', { class: 'ed-narrow' }, h('span', { class: 'ed-grip', title: 'Drag to reorder' }, ic('grip-vertical'))),
        h('td', {}, cellInput(option, 'label', { placeholder: 'Answer' })),
        rowControls(options, i, { removeTitle: 'Remove this answer' }))));
    sortableTable(tbody, options);
    return card('Multiple-choice question', 'list-checks', 'Reviewers\' answers are stored per answer, so renaming an answer keeps them.',
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
        h('td', {}, cellInput(entry, 'src', { list: entry.kind === 'image' ? 'dl-images' : 'dl-videos' }), fileWarning(entry.src)),
        h('td', {}, entry.kind === 'image' ? cellInput(entry, 'caption', { placeholder: 'Caption' }) : cellInput(entry, 'poster', { list: 'dl-images', placeholder: 'Poster (optional)' })),
        rowControls(doc.library, i, { removeTitle: 'Remove from the library' }))));
    sortableTable(tbody, doc.library);
    return h('div', {},
        h('div', { class: 'ed-form-head' }, h('div', {}, h('h2', {}, 'Presentation settings'), h('span', { class: 'ed-id', title: 'Reviewers\' notes are stored under this id' }, `id: ${doc.id || '(none)'}`))),
        card('Title page', 'presentation', null,
            field('Title', doc, 'title'),
            field('Small line above the title', doc, 'subtitle', { placeholder: 'Give a Paw × Bionic Pets' }),
            field('Introduction', doc, 'intro', { multiline: true, rows: 4 }),
            h('div', { class: 'ed-grid2' },
                field('Reviewer name (filled in for them)', doc, 'reviewerDefault', { placeholder: 'Derrick Campana' }),
                field('Email for "send my review"', doc, 'returnEmail', { type: 'email', placeholder: 'optional' }))),
        card('What participants can use', 'sliders-horizontal', 'Where a live session starts. As presenter you can change this during the meeting in the Live panel.',
            h('div', {}, toolBoxes),
            h('div', { class: 'ed-actions' },
                h('button', { type: 'button', class: 'ed-btn ed-mini', onclick: () => edit(() => { doc.participantTools = DEFAULT_TOOLS.slice(); }, { structural: true }) }, 'Reviewer default'),
                h('button', { type: 'button', class: 'ed-btn ed-mini', onclick: () => edit(() => { doc.participantTools = []; }, { structural: true }) }, 'Watch only'))),
        card('Media library', 'library', 'Videos and pictures the presenter can drop onto any screen during the meeting with the Media button. They also appear under "From the media library" when adding materials.',
            doc.library.length ? h('div', { class: 'ed-table-wrap' }, h('table', { class: 'ed-table' }, h('thead', {}, h('tr', {}, h('th'), h('th', {}, 'Name'), h('th', {}, 'Type'), h('th', {}, 'File'), h('th', {}, 'Poster / caption'), h('th'))), tbody)) : null,
            h('div', { class: 'ed-actions' }, h('button', { type: 'button', class: 'ed-btn ed-mini', onclick: () => edit(() => doc.library.push({ id: uniqueKey('media', new Set(doc.library.map(e => e.id))), kind: 'video', label: 'New media', src: '' }), { structural: true }) }, ic('plus'), 'Add media'))));
}

// ---- wiring ------------------------------------------------------------------------------------------

function renderAll() { renderList(); renderForm(); }
$('#ed-undo').addEventListener('click', undo);
$('#ed-redo').addEventListener('click', redo);
$('#ed-save').addEventListener('click', () => save());
$('#ed-save-as').addEventListener('click', saveAs);
$('#ed-download').addEventListener('click', () => download());
$('#ed-add-screen').addEventListener('click', addScreen);
$('#ed-toggle-preview').addEventListener('click', () => setPreview(!S.preview));
$('#ed-reload-preview').addEventListener('click', refreshPreview);
$('#ed-present').addEventListener('click', async () => {
    if (dirty()) {
        if (!confirm('Save your changes first? The presentation opens from the saved file.')) return;
        if (!(await save())) return;
    }
    window.open(`design-review.html?review=${encodeURIComponent(S.path)}&host=1`, '_blank');
});
$('#ed-file').addEventListener('change', event => {
    if (dirty() && !confirm('You have unsaved changes. They are kept in this browser, but switch files anyway?')) { event.target.value = S.path; return; }
    location.search = `?file=${encodeURIComponent(event.target.value)}`;
});
document.addEventListener('keydown', event => {
    const mod = event.ctrlKey || event.metaKey;
    if (!mod) return;
    const key = event.key.toLowerCase();
    if (key === 's') { event.preventDefault(); save(); return; }
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
