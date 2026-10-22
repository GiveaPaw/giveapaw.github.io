import { driveConfig } from './drive-config.js?v=1';

// Review builder: compose a guided design review (videos, model sweeps, 3D assemblies) from files in
// Google Drive or by URL, preview it, and save it as a JSON file the review page loads by link.
// Drive access uses Google Identity Services (token client, scope drive.file) + the Picker + Drive REST.

// ---- helpers -----------------------------------------------------------------------------------

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const icon = name => `<i data-lucide="${name}" aria-hidden="true"></i>`;
function refreshIcons() { window.lucide?.createIcons({ attrs: { 'stroke-width': 1.8 } }); }
function escapeHTML(text) { return String(text ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
const uid = () => Math.random().toString(36).slice(2, 8);
function slugify(text) { return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); }
function numberIn(name) { const m = String(name).match(/(\d+(?:\.\d+)?)(?!.*\d)/); return m ? +m[1] : null; }
function baseName(src) { return decodeURIComponent(String(src).split('#')[0].split('?')[0].split('/').pop() || src); }
function isMeshName(name) { return /\.(glb|gltf|stl|obj)$/i.test(name); }
function isVideoName(name) { return /\.(mp4|webm|mov|m4v)$/i.test(name); }
const toastEl = $('#rb-toast');
let toastTimer = null;
function toast(message, { error = false, ms = 3200 } = {}) {
    toastEl.textContent = message;
    toastEl.classList.toggle('error', error);
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, ms);
}
function loadScript(src) {
    return new Promise((resolve, reject) => {
        if ($(`script[src="${src}"]`)) return resolve();
        const script = document.createElement('script');
        script.src = src;
        script.async = true;
        script.onload = resolve;
        script.onerror = () => reject(new Error(`Could not load ${src}`));
        document.head.append(script);
    });
}
const KIND_ICON = { video: 'video', sweep: 'sliders-horizontal', assembly: 'box' };
const KIND_LABEL = { video: 'Video', sweep: 'Model sweep', assembly: '3D assembly' };
const LAYER_COLORS = ['#496b94', '#b9c2cc', '#169c8c', '#df7544', '#6750a4'];

// ---- draft state -------------------------------------------------------------------------------

const DRAFT_KEY = 'gap-review-builder-draft';
function blankDraft() {
    return {
        id: '', title: '', subtitle: 'Give a Paw', intro: '', reviewerDefault: '', returnEmail: '',
        items: [], driveFileId: null, makePublic: true,
    };
}
let draft = blankDraft();
try { const raw = localStorage.getItem(DRAFT_KEY); if (raw) draft = { ...blankDraft(), ...JSON.parse(raw) }; } catch { /* ignore */ }
let saveTimer = null;
function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { try { localStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); } catch { /* ignore */ } }, 200);
}
function ensureId() {
    if (!draft.id) draft.id = (slugify(draft.title) || 'review') + '-' + new Date().toISOString().slice(0, 10);
    return draft.id;
}
function newItem(kind) {
    const base = { uid: uid(), kind, title: '', context: '', question: '' };
    if (kind === 'video') return { ...base, src: '', srcName: '', question: 'Pause and mark anything that tells you the fit or alignment is off.' };
    if (kind === 'sweep') return { ...base, param: 'Variant', unit: '', files: [], defaultValue: null, question: 'Scrub through the variants, tag each one you stop on, and star the one you would choose.' };
    return { ...base, layers: [], question: 'Drop pins where you would expect pressure or rubbing, or where you would move the trim line.' };
}

// Serialized review: what the review page consumes (design-review.js normalizeReview).
function toReview() {
    ensureId();
    return {
        id: draft.id, title: draft.title || 'Design review', subtitle: draft.subtitle, intro: draft.intro,
        reviewerDefault: draft.reviewerDefault, returnEmail: draft.returnEmail,
        items: draft.items.map((item, index) => {
            const id = `${slugify(item.title) || item.kind}-${index + 1}`;
            const common = { id, kind: item.kind, title: item.title || `${KIND_LABEL[item.kind]} ${index + 1}`, context: item.context, question: item.question };
            if (item.kind === 'video') return { ...common, src: item.src, srcName: item.srcName };
            if (item.kind === 'sweep') {
                const files = [...item.files].sort((a, b) => a.value - b.value).map(f => ({ value: f.value, src: f.src, name: f.name }));
                return { ...common, param: item.param, unit: item.unit, files, defaultValue: item.defaultValue };
            }
            return { ...common, layers: item.layers.map((layer, i) => ({ key: `layer-${i + 1}`, label: layer.label, file: layer.file, fileName: layer.fileName, color: layer.color, opacity: layer.opacity, visible: layer.visible })) };
        }),
    };
}
function fromReview(json, driveFileId = null) {
    draft = { ...blankDraft(), id: json.id || '', title: json.title || '', subtitle: json.subtitle || '', intro: json.intro || '', reviewerDefault: json.reviewerDefault || '', returnEmail: json.returnEmail || '', driveFileId };
    draft.items = (json.items || []).map(item => {
        const it = { ...newItem(item.kind), title: item.title || '', context: item.context || '', question: item.question || '' };
        if (item.kind === 'video') { it.src = item.src || ''; it.srcName = item.srcName || baseName(item.src || ''); }
        else if (item.kind === 'sweep') {
            it.param = item.param || 'Variant'; it.unit = item.unit || ''; it.defaultValue = item.defaultValue ?? null;
            const files = Array.isArray(item.files) ? item.files : Object.entries(item.files || {}).map(([value, src]) => ({ value: +value, src }));
            it.files = files.map(f => ({ id: uid(), value: +f.value, src: f.src, name: f.name || baseName(f.src) }));
        } else it.layers = (item.layers || []).map((layer, i) => ({ id: uid(), label: layer.label || `Layer ${i + 1}`, file: layer.file || '', fileName: layer.fileName || baseName(layer.file || ''), color: layer.color || LAYER_COLORS[i % LAYER_COLORS.length], opacity: layer.opacity ?? 1, visible: layer.visible !== false }));
        return it;
    });
    persist();
    renderAll();
}
function validate() {
    const problems = [];
    if (!draft.title.trim()) problems.push('Give the review a title.');
    draft.items.forEach((item, index) => {
        const label = item.title || `${KIND_LABEL[item.kind]} ${index + 1}`;
        if (item.kind === 'video' && !item.src) problems.push(`"${label}" has no video.`);
        if (item.kind === 'sweep') {
            if (item.files.length < 2) problems.push(`"${label}" needs at least two files.`);
            const values = item.files.map(f => f.value);
            if (values.some(v => !Number.isFinite(v))) problems.push(`"${label}" has a file without a numeric value.`);
            if (new Set(values).size !== values.length) problems.push(`"${label}" has two files with the same value.`);
        }
        if (item.kind === 'assembly' && !item.layers.some(l => l.file)) problems.push(`"${label}" has no mesh.`);
    });
    if (!draft.items.length) problems.push('Add at least one question.');
    return problems;
}

// ---- Google: sign-in, picker, Drive REST -------------------------------------------------------

const google = {
    configured: !!(driveConfig.apiKey && driveConfig.clientId),
    token: null,
    tokenExpires: 0,
    user: null,
    tokenClient: null,
    pickerReady: false,
};
async function ensureToken({ interactive = true } = {}) {
    if (!google.configured) throw new Error('Google Drive is not configured. See REVIEW-BUILDER-SETUP.md.');
    if (google.token && Date.now() < google.tokenExpires - 60_000) return google.token;
    await loadScript('https://accounts.google.com/gsi/client');
    return new Promise((resolve, reject) => {
        google.tokenClient = window.google.accounts.oauth2.initTokenClient({
            client_id: driveConfig.clientId,
            scope: 'https://www.googleapis.com/auth/drive.file',
            callback: response => {
                if (response.error) { reject(new Error(response.error_description || response.error)); return; }
                google.token = response.access_token;
                google.tokenExpires = Date.now() + (response.expires_in || 3600) * 1000;
                resolve(google.token);
            },
            error_callback: error => reject(new Error(error?.message || 'Sign-in was cancelled.')),
        });
        google.tokenClient.requestAccessToken({ prompt: interactive && !google.token ? 'consent' : '' });
    });
}
async function driveFetch(path, { method = 'GET', headers = {}, body, raw = false } = {}) {
    const token = await ensureToken();
    const response = await fetch(path.startsWith('http') ? path : 'https://www.googleapis.com/drive/v3/' + path, {
        method, body, headers: { Authorization: 'Bearer ' + token, ...headers },
    });
    if (!response.ok) {
        let detail = '';
        try { detail = (await response.json()).error?.message || ''; } catch { /* no body */ }
        throw new Error(`Drive ${method} ${path.split('?')[0]} failed (${response.status}). ${detail}`);
    }
    return raw ? response : response.json();
}
async function signIn() {
    await ensureToken();
    try {
        const about = await driveFetch('about?fields=user(displayName,emailAddress)');
        google.user = about.user;
    } catch { google.user = { displayName: 'Signed in' }; }
    renderSetup();
    toast(`Signed in as ${google.user.emailAddress || google.user.displayName}`);
}
async function ensureFolder() {
    const name = driveConfig.folderName || 'Give a Paw Reviews';
    const q = encodeURIComponent(`name = '${name.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`);
    const found = await driveFetch(`files?q=${q}&fields=files(id,name)&spaces=drive`);
    if (found.files?.length) return found.files[0].id;
    const created = await driveFetch('files?fields=id', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder' }) });
    return created.id;
}
async function makePublic(fileId) {
    try {
        await driveFetch(`files/${fileId}/permissions?fields=id`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role: 'reader', type: 'anyone' }) });
        return true;
    } catch (error) {
        console.warn('Could not share', fileId, error);
        return false;
    }
}
function driveIdsInDraft() {
    const ids = new Set();
    const collect = src => { const m = String(src || '').match(/^drive:([\w-]+)/); if (m) ids.add(m[1]); };
    draft.items.forEach(item => {
        if (item.kind === 'video') collect(item.src);
        if (item.kind === 'sweep') item.files.forEach(f => collect(f.src));
        if (item.kind === 'assembly') item.layers.forEach(l => collect(l.file));
    });
    return [...ids];
}
async function saveToDrive() {
    const problems = validate();
    if (problems.length) { toast(problems[0], { error: true }); renderItems(); return; }
    const status = $('#rb-save-status');
    const button = $('#rb-save');
    button.disabled = true;
    try {
        status.textContent = 'Signing in…';
        await ensureToken();
        const review = toReview();
        const metadata = { name: `${review.title}.review.json`, mimeType: 'application/json', appProperties: { gapReview: '1', reviewId: review.id } };
        const boundary = 'gap' + uid();
        const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(draft.driveFileId ? { name: metadata.name, appProperties: metadata.appProperties } : { ...metadata, parents: [await ensureFolder()] })}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(review, null, 2)}\r\n--${boundary}--`;
        status.textContent = draft.driveFileId ? 'Updating the review file…' : 'Creating the review file…';
        const result = await driveFetch(
            `https://www.googleapis.com/upload/drive/v3/files${draft.driveFileId ? '/' + draft.driveFileId : ''}?uploadType=multipart&fields=id,name`,
            { method: draft.driveFileId ? 'PATCH' : 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body },
        );
        draft.driveFileId = result.id;
        persist();
        if ($('#rb-make-public').checked) {
            const targets = [result.id, ...driveIdsInDraft()];
            status.textContent = `Sharing ${targets.length} file(s) as "anyone with the link"…`;
            const outcomes = await Promise.all(targets.map(makePublic));
            const failed = outcomes.filter(ok => !ok).length;
            status.textContent = failed ? `Saved. ${failed} file(s) could not be shared; share them in Drive by hand.` : `Saved and shared ${targets.length} file(s).`;
        } else status.textContent = 'Saved. Files were not shared; the reviewer must have Drive access to them.';
        renderShare();
        toast('Saved to Google Drive');
    } catch (error) {
        console.error(error);
        status.textContent = '';
        toast(error.message, { error: true, ms: 6000 });
    } finally { button.disabled = false; }
}
async function listDriveReviews() {
    const q = encodeURIComponent("appProperties has { key='gapReview' and value='1' } and trashed = false");
    const result = await driveFetch(`files?q=${q}&fields=files(id,name,modifiedTime)&orderBy=modifiedTime desc&pageSize=50`);
    return result.files || [];
}
async function openDriveReview(fileId) {
    const response = await driveFetch(`files/${fileId}?alt=media`, { raw: true });
    fromReview(await response.json(), fileId);
    renderShare();
    toast('Review loaded from Drive');
}
async function pickFromDrive({ multiple = false, kind = 'mesh' } = {}) {
    await ensureToken();
    await loadScript('https://apis.google.com/js/api.js');
    await new Promise(resolve => window.gapi.load('picker', resolve));
    return new Promise(resolve => {
        const view = new window.google.picker.DocsView(window.google.picker.ViewId.DOCS);
        view.setIncludeFolders(true).setParent('root');
        if (kind === 'video') view.setMimeTypes('video/mp4,video/webm,video/quicktime,video/x-m4v');
        else view.setQuery('glb OR stl OR obj');
        const builder = new window.google.picker.PickerBuilder()
            .setOAuthToken(google.token)
            .setDeveloperKey(driveConfig.apiKey)
            .setTitle(kind === 'video' ? 'Choose a video' : multiple ? 'Choose mesh files (.glb, .stl, .obj)' : 'Choose a mesh file')
            .addView(view)
            .addView(new window.google.picker.DocsView(window.google.picker.ViewId.DOCS).setOwnedByMe(false))
            .setCallback(data => {
                if (data.action === window.google.picker.Action.PICKED) resolve(data.docs.map(doc => ({ id: doc.id, name: doc.name, mimeType: doc.mimeType })));
                else if (data.action === window.google.picker.Action.CANCEL) resolve([]);
            });
        if (driveConfig.appId) builder.setAppId(driveConfig.appId);
        if (multiple) builder.enableFeature(window.google.picker.Feature.MULTISELECT_ENABLED);
        builder.build().setVisible(true);
    });
}

// ---- rendering ---------------------------------------------------------------------------------

function renderSetup() {
    const config = $('[data-setup="config"]');
    const auth = $('[data-setup="auth"]');
    if (google.configured) {
        config.className = 'rb-setup-line ok';
        config.textContent = 'Drive is configured for this site.';
    } else {
        config.className = 'rb-setup-line warn';
        config.innerHTML = 'Drive is not set up yet: <code>drive-config.js</code> needs an API key and client ID. <a href="REVIEW-BUILDER-SETUP.md">Setup steps</a>.';
    }
    auth.className = 'rb-setup-line ' + (google.user ? 'ok' : '');
    auth.textContent = google.user ? `Signed in as ${google.user.emailAddress || google.user.displayName}.` : 'Not signed in. Sign in to pick Drive files and to save.';
    const button = $('#rb-google');
    button.classList.toggle('rb-signed', !!google.user);
    button.querySelector('span').textContent = google.user ? (google.user.displayName || 'Signed in') : 'Sign in with Google';
    button.disabled = !google.configured;
    button.title = google.configured ? button.title : 'Configure drive-config.js first';
}
function renderDetails() {
    $$('[data-field]').forEach(input => { input.value = draft[input.dataset.field] ?? ''; });
}
function renderShare() {
    const panel = $('#rb-share');
    panel.hidden = !draft.driveFileId;
    if (!draft.driveFileId) return;
    $('#rb-share-link').value = new URL(`design-review.html?review=drive:${draft.driveFileId}`, location.href).toString();
}
function sourceField(value, name, { path, kind, placeholder }) {
    const isDrive = String(value).startsWith('drive:');
    return `
        <div class="rb-source">
            <input type="text" data-path="${path}" value="${escapeHTML(value)}" placeholder="${escapeHTML(placeholder)}" spellcheck="false">
            <button type="button" class="rb-btn" data-action="pick" data-kind="${kind}" data-path="${path}" ${google.configured ? '' : 'disabled title="Configure Google Drive to browse"'}>${icon('cloud')} Drive</button>
        </div>
        ${name ? `<span class="rb-source-name">${isDrive ? '<span class="rb-drive-pill">Drive</span> ' : ''}${escapeHTML(name)}</span>` : ''}`;
}
function itemCard(item, index) {
    const problems = validate().filter(p => p.includes(`"${item.title || `${KIND_LABEL[item.kind]} ${index + 1}`}"`));
    let media = '';
    if (item.kind === 'video') {
        media = `<label class="rb-full">Video file${sourceField(item.src, item.srcName, { path: `items.${index}.src`, kind: 'video', placeholder: 'yana-video-1.mp4, https://…, or drive:<fileId>' })}</label>`;
    } else if (item.kind === 'sweep') {
        const rows = [...item.files].sort((a, b) => a.value - b.value).map(file => `
            <tr>
                <td class="rb-value"><input type="number" step="any" data-file="${file.id}" data-prop="value" value="${escapeHTML(file.value ?? '')}" aria-label="Slider value"></td>
                <td class="rb-name" title="${escapeHTML(file.name)}">${String(file.src).startsWith('drive:') ? '<span class="rb-drive-pill">Drive</span> ' : ''}${escapeHTML(file.name)}</td>
                <td class="rb-src" title="${escapeHTML(file.src)}">${escapeHTML(file.src)}</td>
                <td class="rb-del"><button type="button" class="rb-btn rb-icon rb-danger" data-action="remove-file" data-file="${file.id}" title="Remove">${icon('x')}</button></td>
            </tr>`).join('');
        media = `
            <div class="rb-inline rb-full">
                <label>Slider label<input type="text" data-path="items.${index}.param" value="${escapeHTML(item.param)}" placeholder="Attachment point count"></label>
                <label>Unit<input type="text" data-path="items.${index}.unit" value="${escapeHTML(item.unit)}" placeholder="mm, points…"></label>
                <label>Starts at<select data-path="items.${index}.defaultValue" data-number="1">${[...item.files].sort((a, b) => a.value - b.value).map(f => `<option value="${f.value}" ${f.value === item.defaultValue ? 'selected' : ''}>${f.value}${item.unit ? ' ' + escapeHTML(item.unit) : ''}</option>`).join('') || '<option value="">(add files)</option>'}</select></label>
            </div>
            <div class="rb-files">
                <div class="rb-files-head"><strong>${item.files.length} file${item.files.length === 1 ? '' : 's'}</strong><span class="rb-muted" style="margin:0">one model per slider value, ordered by value</span>
                    <div class="rb-files-actions">
                        <button type="button" class="rb-btn" data-action="pick-files" ${google.configured ? '' : 'disabled title="Configure Google Drive to browse"'}>${icon('cloud')} Add from Drive</button>
                        <button type="button" class="rb-btn" data-action="add-urls">${icon('link')} Add by link</button>
                    </div>
                </div>
                ${rows ? `<table><thead><tr><th>Value</th><th>File</th><th>Source</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="rb-files-empty">No files yet. Pick 10 to 40 exports of the same part with one parameter changing.</p>'}
            </div>`;
    } else {
        const rows = item.layers.map((layer, i) => `
            <tr>
                <td><input type="text" data-layer="${layer.id}" data-prop="label" value="${escapeHTML(layer.label)}" aria-label="Layer name" style="width:140px"></td>
                <td class="rb-name">${sourceField(layer.file, layer.fileName, { path: `items.${index}.layers.${i}.file`, kind: 'mesh', placeholder: 'ollie-socket.glb, https://…, or drive:<fileId>' })}</td>
                <td class="rb-color"><input type="color" data-layer="${layer.id}" data-prop="color" value="${escapeHTML(layer.color)}" aria-label="Colour"></td>
                <td class="rb-opacity"><input type="number" min="0.05" max="1" step="0.05" data-layer="${layer.id}" data-prop="opacity" value="${layer.opacity}" aria-label="Opacity"></td>
                <td class="rb-vis"><input type="checkbox" data-layer="${layer.id}" data-prop="visible" ${layer.visible ? 'checked' : ''} aria-label="Visible at start"></td>
                <td class="rb-del"><button type="button" class="rb-btn rb-icon rb-danger" data-action="remove-layer" data-layer="${layer.id}" title="Remove">${icon('x')}</button></td>
            </tr>`).join('');
        media = `
            <div class="rb-files rb-full">
                <div class="rb-files-head"><strong>${item.layers.length} mesh${item.layers.length === 1 ? '' : 'es'}</strong><span class="rb-muted" style="margin:0">all exported from the same nTop frame so they overlay</span>
                    <div class="rb-files-actions"><button type="button" class="rb-btn" data-action="add-layer">${icon('plus')} Add mesh</button></div>
                </div>
                ${rows ? `<table><thead><tr><th>Name</th><th>File</th><th>Colour</th><th>Opacity</th><th>Shown</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="rb-files-empty">No meshes yet. Typical set: solid animal (translucent), socket, attachment surface.</p>'}
            </div>`;
    }
    return `
        <li class="rb-item ${problems.length ? 'invalid' : ''}" data-uid="${item.uid}">
            <div class="rb-item-head">
                <span class="rb-item-num">${index + 1}</span>
                <span class="rb-kind">${icon(KIND_ICON[item.kind])} ${KIND_LABEL[item.kind]}</span>
                <strong>${escapeHTML(item.title) || '<em>Untitled</em>'}</strong>
                <div class="rb-item-tools">
                    <button type="button" class="rb-btn rb-icon" data-action="up" title="Move up" ${index === 0 ? 'disabled' : ''}>${icon('arrow-up')}</button>
                    <button type="button" class="rb-btn rb-icon" data-action="down" title="Move down" ${index === draft.items.length - 1 ? 'disabled' : ''}>${icon('arrow-down')}</button>
                    <button type="button" class="rb-btn rb-icon rb-danger" data-action="remove" title="Remove question">${icon('trash-2')}</button>
                </div>
            </div>
            <div class="rb-item-body">
                <label>Title<input type="text" data-path="items.${index}.title" value="${escapeHTML(item.title)}" placeholder="${item.kind === 'video' ? 'Yana: fitting video 1' : item.kind === 'sweep' ? 'Socket lattice density' : 'Ollie: socket on the scan'}"></label>
                <label>Context (what they are looking at)<input type="text" data-path="items.${index}.context" value="${escapeHTML(item.context)}" placeholder="One sentence of background."></label>
                <label class="rb-full">Question for the reviewer<textarea data-path="items.${index}.question" rows="2">${escapeHTML(item.question)}</textarea></label>
                ${media}
                ${problems.length ? `<p class="rb-muted rb-full" style="color:#b3261e">${escapeHTML(problems[0])}</p>` : ''}
            </div>
        </li>`;
}
function renderItems() {
    const list = $('#rb-items');
    const focused = document.activeElement;
    const focusKey = focused?.dataset?.path || (focused?.dataset?.file && focused.dataset.file + ':' + focused.dataset.prop) || (focused?.dataset?.layer && focused.dataset.layer + ':' + focused.dataset.prop);
    const selection = focused?.selectionStart;
    list.innerHTML = draft.items.map(itemCard).join('');
    $('#rb-empty').hidden = draft.items.length > 0;
    $('#rb-count').textContent = draft.items.length ? `${draft.items.length}` : '';
    refreshIcons();
    if (focusKey) {
        const again = $(`[data-path="${focusKey}"]`) || $$('[data-file],[data-layer]').find(e => (e.dataset.file || e.dataset.layer) + ':' + e.dataset.prop === focusKey);
        if (again) { again.focus({ preventScroll: true }); try { if (selection !== undefined && again.setSelectionRange) again.setSelectionRange(selection, selection); } catch { /* not a text field */ } }
    }
}
function renderAll() { renderSetup(); renderDetails(); renderShare(); renderItems(); }

// ---- editing -----------------------------------------------------------------------------------

function setPath(path, value) {
    const parts = path.split('.');
    let node = draft;
    for (let i = 0; i < parts.length - 1; i++) node = node[parts[i]];
    node[parts[parts.length - 1]] = value;
    persist();
}
function itemByUid(uid) { return draft.items.find(i => i.uid === uid); }
let rerenderTimer = null;
function scheduleRerender() { clearTimeout(rerenderTimer); rerenderTimer = setTimeout(renderItems, 400); }

$$('[data-field]').forEach(input => input.addEventListener('input', () => { draft[input.dataset.field] = input.value; persist(); }));
$$('[data-add]').forEach(button => button.addEventListener('click', () => {
    draft.items.push(newItem(button.dataset.add));
    persist();
    renderItems();
    const card = $(`.rb-item[data-uid="${draft.items[draft.items.length - 1].uid}"]`);
    card?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    card?.querySelector('input')?.focus({ preventScroll: true });
}));

const itemsEl = $('#rb-items');
itemsEl.addEventListener('input', event => {
    const target = event.target;
    const card = target.closest('.rb-item');
    const item = itemByUid(card?.dataset.uid);
    if (!item) return;
    if (target.dataset.path) {
        setPath(target.dataset.path, target.dataset.number ? +target.value : target.value);
        if (target.dataset.path.endsWith('.title') || target.dataset.path.endsWith('.src') || target.dataset.path.endsWith('.file')) {
            if (target.dataset.path.endsWith('.src')) item.srcName = baseName(target.value);
            if (target.dataset.path.endsWith('.file')) { const i = +target.dataset.path.split('.')[3]; item.layers[i].fileName = baseName(target.value); }
            scheduleRerender();
        }
    } else if (target.dataset.file) {
        const file = item.files.find(f => f.id === target.dataset.file);
        if (file) { file.value = target.value === '' ? NaN : +target.value; persist(); scheduleRerender(); }
    } else if (target.dataset.layer) {
        const layer = item.layers.find(l => l.id === target.dataset.layer);
        if (!layer) return;
        const prop = target.dataset.prop;
        layer[prop] = prop === 'visible' ? target.checked : prop === 'opacity' ? Math.min(1, Math.max(0.05, +target.value || 1)) : target.value;
        persist();
    }
});
let urlDialogTarget = null;
itemsEl.addEventListener('click', async event => {
    const button = event.target.closest('[data-action]');
    if (!button) return;
    const card = button.closest('.rb-item');
    const item = itemByUid(card?.dataset.uid);
    const index = draft.items.indexOf(item);
    const action = button.dataset.action;
    try {
        if (action === 'remove') { if (confirm('Remove this question?')) { draft.items.splice(index, 1); } }
        else if (action === 'up' && index > 0) { [draft.items[index - 1], draft.items[index]] = [draft.items[index], draft.items[index - 1]]; }
        else if (action === 'down' && index < draft.items.length - 1) { [draft.items[index + 1], draft.items[index]] = [draft.items[index], draft.items[index + 1]]; }
        else if (action === 'remove-file') { item.files = item.files.filter(f => f.id !== button.dataset.file); if (!item.files.some(f => f.value === item.defaultValue)) item.defaultValue = item.files[0]?.value ?? null; }
        else if (action === 'add-layer') { item.layers.push({ id: uid(), label: `Layer ${item.layers.length + 1}`, file: '', fileName: '', color: LAYER_COLORS[item.layers.length % LAYER_COLORS.length], opacity: item.layers.length === 0 ? 0.38 : 1, visible: true }); }
        else if (action === 'remove-layer') { item.layers = item.layers.filter(l => l.id !== button.dataset.layer); }
        else if (action === 'add-urls') { urlDialogTarget = item; $('#rb-urls-text').value = ''; $('#rb-urls-dialog').showModal(); return; }
        else if (action === 'pick') {
            const docs = await pickFromDrive({ kind: button.dataset.kind });
            if (!docs.length) return;
            const doc = docs[0];
            if (button.dataset.kind === 'mesh' && !isMeshName(doc.name)) { toast(`${doc.name} is not a .glb, .stl, or .obj file.`, { error: true }); return; }
            setPath(button.dataset.path, 'drive:' + doc.id);
            if (item.kind === 'video') item.srcName = doc.name;
            else { const i = +button.dataset.path.split('.')[3]; item.layers[i].fileName = doc.name; if (!item.layers[i].label || /^Layer \d+$/.test(item.layers[i].label)) item.layers[i].label = doc.name.replace(/\.[^.]+$/, ''); }
        }
        else if (action === 'pick-files') {
            const docs = await pickFromDrive({ multiple: true, kind: 'mesh' });
            const meshes = docs.filter(d => isMeshName(d.name));
            if (docs.length && !meshes.length) { toast('None of those are .glb, .stl, or .obj files.', { error: true }); return; }
            addSweepFiles(item, meshes.map(d => ({ src: 'drive:' + d.id, name: d.name })));
            if (meshes.length) toast(`Added ${meshes.length} file(s). Check the slider values.`);
        }
        persist();
        renderItems();
    } catch (error) {
        console.error(error);
        toast(error.message, { error: true, ms: 6000 });
    }
});
function addSweepFiles(item, sources) {
    sources.forEach(({ src, name }) => {
        if (item.files.some(f => f.src === src)) return;
        let value = numberIn(name);
        if (value === null || item.files.some(f => f.value === value)) value = (Math.max(-1, ...item.files.map(f => f.value).filter(Number.isFinite)) + 1);
        item.files.push({ id: uid(), value, src, name });
    });
    if (!item.files.some(f => f.value === item.defaultValue)) {
        const sorted = [...item.files].sort((a, b) => a.value - b.value);
        item.defaultValue = sorted[Math.floor(sorted.length / 2)]?.value ?? null;
    }
}
$('#rb-urls-add').addEventListener('click', () => {
    if (!urlDialogTarget) return;
    const lines = $('#rb-urls-text').value.split('\n').map(l => l.trim()).filter(Boolean);
    const sources = lines.map(line => {
        const m = line.match(/^https?:\/\/drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?(?:export=\w+&)?id=)([\w-]+)/);
        const src = m ? 'drive:' + m[1] : line;
        return { src, name: m ? `Drive file ${m[1].slice(0, 6)}…` : baseName(line) };
    });
    addSweepFiles(urlDialogTarget, sources);
    persist();
    renderItems();
    $('#rb-urls-dialog').close();
    toast(`Added ${sources.length} file(s). Check the slider values.`);
});

// ---- header actions ----------------------------------------------------------------------------

$('#rb-google').addEventListener('click', () => signIn().catch(error => toast(error.message, { error: true, ms: 6000 })));
$('#rb-save').addEventListener('click', saveToDrive);
$('#rb-preview').addEventListener('click', () => {
    const problems = validate();
    if (problems.length) { toast(problems[0], { error: true }); renderItems(); return; }
    const review = toReview();
    try { localStorage.setItem('gap-review-draft:' + review.id, JSON.stringify(review)); } catch { toast('Could not store the preview draft.', { error: true }); return; }
    window.open(`design-review.html?review=draft:${encodeURIComponent(review.id)}`, 'gap-review-preview');
});
$('#rb-download').addEventListener('click', () => {
    const problems = validate();
    if (problems.length) { toast(problems[0], { error: true }); renderItems(); return; }
    const review = toReview();
    const blob = new Blob([JSON.stringify(review, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${review.id}.json`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast(`Downloaded ${review.id}.json. Put it in the site's reviews/ folder and link design-review.html?review=reviews/${review.id}.json`, { ms: 6000 });
});
$('#rb-copy-link').addEventListener('click', () => navigator.clipboard.writeText($('#rb-share-link').value).then(() => toast('Link copied')));
$('#rb-make-public').addEventListener('change', event => { draft.makePublic = event.target.checked; persist(); });

const openDialog = $('#rb-open-dialog');
$('#rb-open').addEventListener('click', async () => {
    openDialog.showModal();
    const list = $('#rb-open-list');
    if (!google.configured) { list.innerHTML = '<li class="rb-muted">Google Drive is not configured on this site.</li>'; return; }
    list.innerHTML = '<li class="rb-muted">Loading…</li>';
    try {
        const files = await listDriveReviews();
        list.innerHTML = files.length ? '' : '<li class="rb-muted">No saved reviews yet.</li>';
        files.forEach(file => {
            const li = document.createElement('li');
            const button = document.createElement('button');
            button.type = 'button';
            button.innerHTML = `<strong>${escapeHTML(file.name.replace(/\.review\.json$/, ''))}</strong><small>${new Date(file.modifiedTime).toLocaleString()}</small>`;
            button.addEventListener('click', () => { openDialog.close(); openDriveReview(file.id).catch(error => toast(error.message, { error: true, ms: 6000 })); });
            li.append(button);
            list.append(li);
        });
    } catch (error) {
        list.innerHTML = `<li class="rb-muted">${escapeHTML(error.message)}</li>`;
    }
});
$('#rb-open-file').addEventListener('click', () => $('#rb-json-file').click());
$('#rb-json-file').addEventListener('change', async event => {
    const file = event.target.files[0];
    event.target.value = '';
    if (!file) return;
    try { fromReview(JSON.parse(await file.text())); openDialog.close(); toast(`Loaded ${file.name}`); }
    catch (error) { toast('That file is not a review definition.', { error: true }); console.error(error); }
});
$('#rb-open-url-btn').addEventListener('click', async () => {
    const url = $('#rb-open-url').value.trim();
    if (!url) return;
    try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        fromReview(await response.json());
        openDialog.close();
        toast('Review imported');
    } catch (error) { toast(`Could not import: ${error.message}`, { error: true, ms: 6000 }); }
});
[openDialog, $('#rb-urls-dialog')].forEach(dialog => dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); }));

// Starter content: the first visit opens with the Derrick review as an editable example.
if (!draft.items.length && !draft.title) {
    import('./design-review-content.js?v=1').then(({ review }) => {
        const serial = { ...review, items: review.items.map(item => item.kind === 'sweep'
            ? { ...item, files: item.values.map(v => ({ value: v, src: item.file(v), name: item.file(v) })) }
            : item) };
        fromReview(serial);
        draft.id = '';
        persist();
        renderDetails();
    }).catch(() => renderAll());
}
$('#rb-make-public').checked = draft.makePublic !== false;
renderAll();
window.rbDebug = { get draft() { return draft; }, toReview, validate, google };
