// Update editor for the case studies, laid out like the presentation editor (review-editor.html):
//   top bar   Edit / Present, undo / redo, Google Drive, Preview, Publish
//   outline   the update's words first, then its photos, videos and 3D models (drag to reorder)
//   form      cards for the selected row
//   preview   the update as it will look on the page, updating as you type
// Nothing is public until Publish. Unpublished work is kept in this browser and offered back if the
// tab closes. Pins, drawings and notes are added afterwards in the full-screen view (update-studio.js).
import { driveReady, isDriveId, thumbUrl, viewUrl, driveIdFrom, uploadFile, downloadPublic, fileKind, DESIGN_ACCEPT } from './drive-store.js?v=2';

const DRAFT_PREFIX = 'gap-update-draft:';
const LAYOUT_KEY = 'gap-update-editor-layout';
const KIND_LABEL = { photo: 'Photo', video: 'Video', model: '3D model', file: 'Design file' };
const ICON = {
    panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
    edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M14 6l4 4"/>',
    present: '<rect x="3" y="4" width="18" height="12" rx="1"/><path d="M8 20h8M12 16v4"/>',
    undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>',
    redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/>',
    drive: '<path d="M8 3h8l6 10-4 7H6l-4-7z"/><path d="M8 3l6 10H2M16 3 10 13l-4 7M22 13H10"/>',
    preview: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M14 4v16"/>',
    close: '<path d="M6 6l12 12M18 6 6 18"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
    grip: '<circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/>',
    text: '<path d="M5 6V4h14v2M12 4v16M9 20h6"/>',
    upload: '<path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>',
    cube: '<path d="M12 2 3 7v10l9 5 9-5V7z"/><path d="M3 7l9 5 9-5M12 12v10"/>',
    link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
    ext: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/>',
    pin: '<path d="M12 21s-6-6-6-11a6 6 0 0 1 12 0c0 5-6 11-6 11z"/><circle cx="12" cy="10" r="2"/>',
    full: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
    file: '<path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z"/><path d="M14 3v5h5M12 11v6M9 14l3 3 3-3"/>',
};
const svg = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name]}</svg>`;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} } };
const fmtBytes = b => (!b ? '' : b >= 1e6 ? (b / 1e6).toFixed(b >= 1e7 ? 0 : 1) + ' MB' : Math.max(1, Math.round(b / 1e3)) + ' KB');
const plain = o => JSON.parse(JSON.stringify(o));
const extOf = name => ((String(name || '').match(/\.([a-z0-9]+)$/i) || [])[1] || 'file').toUpperCase().slice(0, 6);

export function openUpdateEditor(host, { updateId = '' } = {}) {
    document.querySelector('.ue')?.remove();
    const A = host.animal;
    const user = host.user();
    const draftKey = `${DRAFT_PREFIX}${A.id}:${updateId || 'new'}`;
    const live = () => (updateId ? host.getUpdate(updateId) : null);
    const fromUpdate = u => ({
        date: u?.date || today(), title: u?.title || '', text: u?.text || '',
        media: Object.entries(u?.media || {}).map(([key, m]) => ({ key, ...m })).sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || (a.at || 0) - (b.at || 0)),
    });
    let draft = fromUpdate(live());
    const saved = () => JSON.stringify(fromUpdate(live()));
    let recovered = null;
    try { const r = JSON.parse(store.get(draftKey) || 'null'); if (r?.draft && JSON.stringify(r.draft) !== saved()) recovered = r; } catch {}
    const removed = new Set();      // media removed in this session (so a publish does not bring them back)
    let sel = 'words';
    let mode = 'edit';
    let busy = [];
    const undo = [], redo = [];
    let layout = { outline: true, preview: true };
    try { Object.assign(layout, JSON.parse(store.get(LAYOUT_KEY) || '{}')); } catch {}
    // Narrow screens: outline and preview slide over the form, so they start closed and open one at a time.
    const narrow = () => matchMedia('(max-width: 1000px)').matches;
    if (narrow()) layout = { outline: false, preview: false };

    const root = document.createElement('div');
    root.className = 'ue';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', 'Update editor');
    document.body.append(root);
    document.body.classList.add('us-open');
    const lastFocus = document.activeElement;

    const dirty = () => JSON.stringify(draft) !== saved();
    const asUpdate = () => ({
        id: updateId || 'preview', uid: live()?.uid || user.uid, author: live()?.author || user.name, at: live()?.at || Date.now(), date: draft.date, title: draft.title || 'Untitled update', text: draft.text,
        media: Object.fromEntries(draft.media.map((m, i) => [m.key, { ...stripKey(m), order: i + 1 }])),
    });
    const stripKey = m => { const { key, ...rest } = m; return rest; };

    // ------------------------------------------------------------ change tracking
    function change(fn, { snapshot = true } = {}) {
        if (snapshot) { undo.push(JSON.stringify(draft)); if (undo.length > 80) undo.shift(); redo.length = 0; }
        fn();
        store.set(draftKey, JSON.stringify({ draft, at: Date.now() }));
        renderTop(); renderOutline(); renderPreview();
    }
    let typingSnap = null;
    function typed(fn) {
        // One undo step per pause in typing.
        if (!typingSnap) { undo.push(JSON.stringify(draft)); redo.length = 0; }
        clearTimeout(typingSnap); typingSnap = setTimeout(() => { typingSnap = null; }, 800);
        fn();
        store.set(draftKey, JSON.stringify({ draft, at: Date.now() }));
        renderTop(); renderOutline(); renderPreview();
    }
    function step(from, to) {
        if (!from.length) return;
        to.push(JSON.stringify(draft));
        draft = JSON.parse(from.pop());
        if (sel !== 'words' && !draft.media.some(m => m.key === sel)) sel = 'words';
        store.set(draftKey, JSON.stringify({ draft, at: Date.now() }));
        renderAll();
    }

    // ------------------------------------------------------------ frame
    root.innerHTML = `
        <header class="ue-top">
            <div class="ue-top-title">
                <button type="button" class="ue-btn ue-icon${layout.outline ? ' active' : ''}" data-ue="outline" aria-label="Show or hide the outline" title="Outline">${svg('panel')}</button>
                <img class="ue-brand" src="logo.jpg" alt="">
                <div><span class="ue-eyebrow">Give a Paw · Update editor · ${esc(A.name)}</span><strong class="ue-name"></strong></div>
                <span class="ue-status"></span>
            </div>
            <div class="ue-mode" role="group" aria-label="Mode"><button type="button" data-ue="mode" data-m="edit">${svg('edit')} Edit</button><button type="button" data-ue="mode" data-m="present">${svg('present')} Present</button></div>
            <div class="ue-top-actions">
                <button type="button" class="ue-btn ue-icon" data-ue="undo" aria-label="Undo" title="Undo (Ctrl+Z)">${svg('undo')}</button>
                <button type="button" class="ue-btn ue-icon" data-ue="redo" aria-label="Redo" title="Redo (Ctrl+Y)">${svg('redo')}</button>
                <button type="button" class="ue-btn" data-ue="drive">${svg('drive')} Google Drive</button>
                <button type="button" class="ue-btn${layout.preview ? ' active' : ''}" data-ue="preview">${svg('preview')} Preview</button>
                <button type="button" class="ue-btn" data-ue="close">${svg('close')} Close</button>
                <button type="button" class="ue-btn ue-primary" data-ue="publish"></button>
            </div>
        </header>
        <div class="ue-banner" hidden></div>
        <div class="ue-app">
            <aside class="ue-list-col">
                <div class="ue-list-head"><h2>Update</h2><button type="button" class="ue-btn ue-mini" data-ue="add-menu">${svg('plus')} Add</button></div>
                <p class="ue-hint">Words first, then photos, videos and 3D models. Drag to reorder.</p>
                <ol class="ue-list" aria-label="Parts of the update"></ol>
            </aside>
            <main class="ue-form-col"></main>
            <section class="ue-preview" aria-label="Preview">
                <div class="ue-preview-head"><h2>Preview</h2><span>Updates as you edit · not public until you publish</span><button type="button" class="ue-btn ue-icon" data-ue="present-full" aria-label="Preview full screen" title="Preview full screen">${svg('full')}</button></div>
                <div class="ue-preview-body" inert></div>
            </section>
        </div>`;
    const $ = s => root.querySelector(s);

    function renderTop() {
        $('.ue-name').textContent = draft.title || (updateId ? 'Untitled update' : 'New update');
        const st = $('.ue-status');
        const d = dirty();
        st.className = 'ue-status' + (d ? ' dirty' : updateId ? ' saved' : '');
        st.textContent = d ? (updateId ? 'Unpublished changes' : 'Not published yet') : updateId ? 'Published' : 'Empty';
        const pub = $('[data-ue=publish]');
        pub.textContent = updateId ? 'Publish changes' : 'Publish update';
        pub.disabled = (updateId && !d) || !!busy.length;
        $('[data-ue=undo]').disabled = !undo.length;
        $('[data-ue=redo]').disabled = !redo.length;
        root.querySelectorAll('[data-ue=mode]').forEach(b => b.classList.toggle('active', b.dataset.m === mode));
        $('[data-ue=drive]').disabled = !driveReady() && !host.demo;
        const app = $('.ue-app');
        app.classList.toggle('no-outline', !layout.outline);
        app.classList.toggle('no-preview', !layout.preview);
        $('[data-ue=outline]').classList.toggle('active', layout.outline);
        $('[data-ue=preview]').classList.toggle('active', layout.preview);
    }

    function thumbFor(m) {
        if (m.file && host.demoUrl?.(m.file) && m.kind === 'photo') return host.demoUrl(m.file);
        return (m.kind === 'photo' || m.kind === 'video') && isDriveId(m.file) ? thumbUrl(m.file, 200) : '';
    }
    const notesOn = m => Object.keys(live()?.media?.[m.key]?.marks || m.marks || {}).length;

    function renderOutline() {
        const ol = $('.ue-list');
        ol.innerHTML = `<li class="ue-row settings${sel === 'words' ? ' selected' : ''}" data-ue="sel" data-k="words" tabindex="0">
                <span></span><span class="ue-num">${svg('text')}</span>
                <span class="ue-row-text"><span class="ue-row-title">Words</span><span class="ue-row-sub">${esc(draft.title || 'Title and what happened')}</span></span><span></span></li>`
            + draft.media.map((m, i) => {
                const th = thumbFor(m);
                const n = notesOn(m);
                return `<li class="ue-row${sel === m.key ? ' selected' : ''}" data-ue="sel" data-k="${esc(m.key)}" draggable="true" tabindex="0">
                    <span class="ue-grip" title="Drag to reorder">${svg('grip')}</span><span class="ue-num">${i + 1}</span>
                    <span class="ue-row-text">${th ? `<img class="ue-row-thumb" src="${esc(th)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : m.kind === 'file' ? `<span class="ue-row-thumb ue-ext">${esc(extOf(m.name))}</span>` : ''}<span class="ue-row-title">${esc(m.caption || m.name || KIND_LABEL[m.kind])}</span><span class="ue-row-sub">${esc(KIND_LABEL[m.kind])}${n ? ` · ${n} note${n === 1 ? '' : 's'}` : ''}</span></span>
                    <span class="ue-row-actions"><button type="button" data-ue="remove" data-k="${esc(m.key)}" aria-label="Remove ${esc(m.name || KIND_LABEL[m.kind])}" title="Remove">${svg('trash')}</button></span></li>`;
            }).join('')
            + busy.map(b => `<li class="ue-row ue-busy"><span></span><span class="ue-spin"></span><span class="ue-row-text"><span class="ue-row-title">${esc(b.label)}</span><span class="ue-bar"><i style="width:${Math.round(b.p * 100)}%"></i></span></span><span></span></li>`).join('');
    }

    function renderForm() {
        const col = $('.ue-form-col');
        if (sel === 'words') {
            col.innerHTML = `
                <div class="ue-form-head"><h2>Words</h2><span class="ue-id">${updateId ? 'id: ' + esc(updateId) : 'new update'}</span></div>
                <section class="ue-card">
                    <h3>${svg('text')} Words on the update</h3>
                    <p class="ue-sub">Shown in the Updates list on ${esc(A.name)}’s page and in step 2 of the overview. Plain text: a blank line starts a new paragraph, and links starting with https:// become clickable.</p>
                    <div class="ue-grid2">
                        <label class="ue-field"><span>Date</span><input type="date" data-f="date" value="${esc(draft.date)}"></label>
                        <label class="ue-field"><span>Title</span><input data-f="title" maxlength="100" value="${esc(draft.title)}" placeholder="e.g. Second fitting went well"><small class="ue-count" data-for="title"></small></label>
                    </div>
                    <label class="ue-field"><span>What happened</span><textarea data-f="text" rows="9" maxlength="4000" placeholder="What the team did, what we learned, what happens next.">${esc(draft.text)}</textarea><small class="ue-count" data-for="text"></small></label>
                    ${noteLinkPicker()}
                </section>
                ${addCard()}`;
            counts();
            return;
        }
        const i = draft.media.findIndex(m => m.key === sel);
        const m = draft.media[i];
        if (!m) { sel = 'words'; renderForm(); return; }
        const th = thumbFor(m) && thumbFor(m).replace(/sz=w\d+/, 'sz=w900');
        const published = !!live()?.media?.[m.key];
        const n = notesOn(m);
        col.innerHTML = `
            <div class="ue-form-head"><h2>Item ${i + 1} of ${draft.media.length} · ${KIND_LABEL[m.kind]}</h2>
                <div class="ue-actions"><button type="button" class="ue-btn ue-mini" data-ue="move" data-d="-1"${i === 0 ? ' disabled' : ''}>Move up</button><button type="button" class="ue-btn ue-mini" data-ue="move" data-d="1"${i === draft.media.length - 1 ? ' disabled' : ''}>Move down</button><button type="button" class="ue-btn ue-mini ue-danger" data-ue="remove" data-k="${esc(m.key)}">${svg('trash')} Remove</button></div></div>
            <section class="ue-card">
                <h3>${svg(m.kind === 'model' ? 'cube' : m.kind === 'file' ? 'file' : 'present')} ${KIND_LABEL[m.kind]}</h3>
                ${m.kind === 'file' ? `<div class="ue-filecard">${svg('file')}<div><strong>${esc(m.name)}</strong><span>${esc([extOf(m.name), fmtBytes(m.bytes)].filter(Boolean).join(' · '))} · visitors download it from Google Drive</span></div></div>` : ''}
                <div class="ue-media"${m.kind === 'file' ? ' hidden' : ''}>${th ? `<img src="${esc(th)}" alt="" referrerpolicy="no-referrer">` : `<div class="ue-media-ph">${svg(m.kind === 'model' ? 'cube' : 'present')}<span>${m.kind === 'model' ? '3D model' : 'Video'} · opens in Present</span></div>`}</div>
                <div class="ue-grid2">
                    <label class="ue-field"><span>Caption</span><input data-m="caption" maxlength="300" value="${esc(m.caption || '')}" placeholder="What this shows"><small>Shown under it in full screen and in the outline.</small></label>
                    <label class="ue-field"><span>Name</span><input data-m="name" maxlength="120" value="${esc(m.name || '')}"></label>
                </div>
                <div class="ue-source">
                    <span class="ue-source-k">Source</span>
                    ${m.path ? `<span>Site model <code>${esc(m.path)}</code></span>` : isDriveId(m.file) && !String(m.file).startsWith('demo-') ? `<a href="${esc(viewUrl(m.file))}" target="_blank" rel="noopener">${svg('ext')} Open in Google Drive</a>` : '<span>Uploaded in this demo</span>'}
                    ${m.bytes ? `<span class="ue-muted">${fmtBytes(m.bytes)}</span>` : ''}
                    <button type="button" class="ue-btn ue-mini" data-ue="replace">${svg('drive')} Replace from Google Drive…</button>
                </div>
            </section>
            <section class="ue-card"${m.kind === 'file' ? ' hidden' : ''}>
                <h3>${svg('pin')} Pins, drawings and notes</h3>
                <p class="ue-sub">${published ? `${n ? `${n} note${n === 1 ? '' : 's'} on this ${KIND_LABEL[m.kind].toLowerCase()}.` : 'No notes yet.'} Open it full screen to pin what should change, draw on it, and mark decision points.` : 'Publish the update first; then pin, draw and write notes on this in full screen.'}</p>
                <button type="button" class="ue-btn${published ? ' ue-primary' : ''}" data-ue="annotate"${published ? '' : ' disabled'}>${svg('pin')} Annotate in full screen</button>
            </section>`;
    }

    // Turn selected words into a link to a note (pins, drawings and notes are made in full screen).
    function noteLinkPicker() {
        const opts = draft.media.flatMap((m, i) => Object.entries(live()?.media?.[m.key]?.marks || {}).sort((a, b) => (a[1].at || 0) - (b[1].at || 0))
            .map(([k, mk], j) => `<option value="${esc(m.key)}/${esc(k)}">${esc(`${i + 1}. ${m.caption || m.name || KIND_LABEL[m.kind]} · note ${j + 1}: ${(mk.note || (mk.kind === 'sketch' ? 'drawing' : 'pin')).slice(0, 40)}`)}</option>`));
        return `<label class="ue-field"><span>Link a note</span><select data-ue="link-note"${opts.length ? '' : ' disabled'}><option value="">${opts.length ? 'Select words in the text, then pick a note…' : 'Publish, then add pins, drawings or notes in full screen to link them here'}</option>${opts.join('')}</select>
            <small>Readers click the linked words to open that note${draft.media.some(m => m.kind === 'model') ? ' and the 3D view it was drawn from' : ''}.</small></label>`;
    }

    function addCard() {
        const ready = driveReady() || host.demo;
        return `<section class="ue-card ue-add">
            <h3>${svg('plus')} Add photos, videos and 3D models</h3>
            <p class="ue-sub">From ${esc(A.name)}’s Google Drive folders, or upload new ones into “Website uploads”. STL, OBJ and 3MF files are compressed into a 3D view; .ntop and other design files are offered as downloads.</p>
            <div class="ue-choices">
                <button type="button" class="ue-choice" data-ue="drive"${ready ? '' : ' disabled'}>${svg('drive')}<strong>Google Drive</strong><span>Browse ${esc(A.name)}’s photos, videos, scans and design files.</span></button>
                <label class="ue-choice${ready ? '' : ' is-off'}">${svg('upload')}<strong>Upload from this computer</strong><span>Photos, videos, STL / OBJ / 3MF / GLB, or design files to download (.ntop, STEP, SolidWorks, Fusion, MeshMixer, PDF, zip).</span><input type="file" multiple accept="image/*,video/*,.stl,.obj,.3mf,.glb,${DESIGN_ACCEPT}" data-ue="upload"${ready ? '' : ' disabled'}></label>
                ${host.siteModels.length ? `<label class="ue-choice">${svg('cube')}<strong>A 3D model on the site</strong><select data-ue="site-model"><option value="">Choose…</option>${host.siteModels.map(f => `<option value="${esc(f.path)}">${esc(f.label)}</option>`).join('')}</select></label>` : ''}
                <form class="ue-choice" data-ue-form="link">${svg('link')}<strong>Paste a Google Drive link</strong><span class="ue-row2"><input name="link" placeholder="https://drive.google.com/file/d/…" required><select name="kind"><option value="photo">Photo</option><option value="video">Video</option><option value="model">3D model (GLB)</option><option value="file">Design file to download</option></select><button type="submit" class="ue-btn ue-mini">Add</button></span></form>
            </div>
        </section>`;
    }

    function counts() {
        root.querySelectorAll('.ue-count').forEach(c => { const f = c.dataset.for; const max = f === 'title' ? 100 : 4000; c.textContent = `${draft[f].length} / ${max}`; });
    }

    function renderPreview() {
        if (!layout.preview && mode !== 'present') return;
        $('.ue-preview-body').innerHTML = `<p class="ue-pv-k">In the Updates list</p><ol class="cu-list ue-pv-feed">${host.renderFeedItem(asUpdate())}</ol>
            <p class="ue-pv-k">In step 2 of the overview</p><div class="ue-pv-card"><span class="cu-card-update">${host.renderCardSnippet(asUpdate())}</span></div>`;
    }

    function renderBanner() {
        const b = $('.ue-banner');
        if (!recovered) { b.hidden = true; return; }
        b.hidden = false;
        b.innerHTML = `<span>Unpublished changes from ${esc(new Date(recovered.at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))} were kept in this browser.</span>
            <button type="button" class="ue-btn ue-mini ue-primary" data-ue="restore">Bring them back</button><button type="button" class="ue-btn ue-mini" data-ue="discard">Discard</button>`;
    }

    function renderAll() { renderTop(); renderBanner(); renderOutline(); renderForm(); renderPreview(); }

    // ------------------------------------------------------------ adding media
    function track(label) { const b = { label, p: 0 }; busy.push(b); renderOutline(); renderTop(); return { set(p, t) { b.p = p; if (t) b.label = t; renderOutline(); }, done() { busy = busy.filter(x => x !== b); renderOutline(); renderTop(); } }; }
    const newItem = item => ({ key: host.newKey(), uid: user.uid, at: Date.now(), ...item, name: String(item.name || KIND_LABEL[item.kind]).replace(item.kind === 'file' ? /$^/ : /\.[^.]+$/, '').slice(0, 120) });
    function addItems(items) {
        if (!items.length) return;
        change(() => { draft.media.push(...items); sel = items.at(-1).key; });
        renderForm();
    }
    async function upload(blob, name, kind) {
        if (host.demo) return { id: host.demoStore(blob), name, bytes: blob.size };
        const t = track(`Uploading ${name}`);
        try { return await uploadFile(blob, { name, mimeType: blob.type || (kind === 'model' ? 'model/gltf-binary' : 'application/octet-stream'), folderId: A.uploadFolder, folderLabel: A.name, hint: user.email, onProgress: p => t.set(p, `Uploading ${name} · ${Math.round(p * 100)}%`) }); }
        finally { t.done(); }
    }
    async function compress(source, name) {
        const t = track(`Compressing ${name}`);
        try {
            const mc = await import('./model-convert.js');
            const out = await mc.convert(source, name, {}, (text, p) => t.set(p, `${name}: ${text}`));
            out.geometry?.dispose?.();
            return { blob: out.glb, name: mc.outputName(name) };
        } finally { t.done(); }
    }
    // Files from this computer: uploaded (meshes compressed first). Returns the Drive files made.
    async function fromComputer(files) {
        const made = [], items = [];
        for (const f of files) {
            const k = fileKind({ name: f.name, mimeType: f.type });
            if (!k) continue;
            if (k === 'file') {
                const up = await upload(f, f.name, 'file');
                made.push(up); items.push(newItem({ kind: 'file', file: up.id, name: f.name, bytes: up.bytes }));
                continue;
            }
            if (k === 'mesh' || k === 'model') {
                const c = k === 'mesh' ? await compress(f, f.name) : { blob: f, name: f.name };
                const up = await upload(c.blob, c.name, 'model');
                made.push(up); items.push(newItem({ kind: 'model', file: up.id, name: f.name, bytes: up.bytes }));
            } else {
                const up = await upload(f, f.name, k);
                made.push(up); items.push(newItem({ kind: k, file: up.id, name: f.name, bytes: up.bytes }));
            }
        }
        return { made, items };
    }
    // Files picked in the Drive gallery: photos, videos and GLBs are used as they are; meshes are
    // downloaded, compressed and the GLB saved in "Website uploads".
    async function fromDrive(files) {
        const items = [];
        for (const f of files) {
            const k = fileKind(f);
            if (k === 'mesh') {
                const t = track(`Downloading ${f.name}`);
                let blob;
                try { blob = await downloadPublic(f.id, p => t.set(p, `Downloading ${f.name} · ${Math.round(p * 100)}%`)); } finally { t.done(); }
                const c = await compress(new File([blob], f.name), f.name);
                const up = await upload(c.blob, c.name, 'model');
                items.push(newItem({ kind: 'model', file: up.id, name: f.name, bytes: up.bytes }));
            } else if (k) {
                items.push(newItem({ kind: k, file: f.id, name: f.name, bytes: f.bytes }));
            }
        }
        return items;
    }
    async function openGallery({ replace = '' } = {}) {
        if (host.demo && !driveReady()) { toast('The Drive gallery needs the Google Drive setup.'); return; }
        const { openDriveGallery } = await import('./drive-gallery.js?v=2');
        let uploadedItems = [];
        const picked = await openDriveGallery({
            animal: A, title: draft.title,
            upload: host.canEdit() ? async files => { const r = await fromComputer(files); uploadedItems = r.items; return r.made; } : null,
        });
        const pickedIds = new Set(picked.map(f => f.id));
        // Files uploaded from inside the gallery and then picked are already converted; reuse them.
        const reuse = uploadedItems.filter(it => pickedIds.has(it.file));
        const rest = picked.filter(f => !reuse.some(it => it.file === f.id));
        try {
            const items = [...reuse, ...(await fromDrive(rest))];
            if (replace && items[0]) {
                change(() => { const m = draft.media.find(x => x.key === replace); Object.assign(m, { kind: items[0].kind, file: items[0].file, name: items[0].name, bytes: items[0].bytes }); delete m.path; });
                renderForm();
            } else addItems(items);
        } catch (err) { toast(err.message); }
    }

    // ------------------------------------------------------------ publish
    async function publish() {
        if (!draft.title.trim()) { sel = 'words'; renderAll(); toast('Add a title first.'); $('[data-f=title]')?.focus(); return; }
        if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.date)) { toast('Pick a date.'); return; }
        const id = updateId || host.newKey();
        const old = live();
        const now = Date.now();
        const media = {};
        draft.media.forEach((m, i) => {
            const liveM = old?.media?.[m.key];
            const v = { kind: m.kind, name: String(m.name || KIND_LABEL[m.kind]).slice(0, 120), order: i + 1, uid: liveM?.uid || m.uid || user.uid, at: liveM?.at || m.at || now };
            if (m.file) v.file = m.file;
            if (m.path) v.path = m.path;
            if (m.caption?.trim()) v.caption = m.caption.trim().slice(0, 300);
            if (m.bytes) v.bytes = m.bytes;
            const marks = liveM?.marks || m.marks;   // notes added in full screen meanwhile are kept
            if (marks && Object.keys(marks).length) v.marks = marks;
            media[m.key] = v;
        });
        // Media someone else added while this was open stays, unless it was removed here.
        Object.entries(old?.media || {}).forEach(([k, m]) => { if (!media[k] && !removed.has(k)) media[k] = { ...m, order: Object.keys(media).length + 1 }; });
        const value = {
            uid: old?.uid || user.uid, author: old?.author || user.name, at: old?.at || now,
            date: draft.date, title: draft.title.trim().slice(0, 100), text: draft.text.trim().slice(0, 4000),
            ...(Object.keys(media).length ? { media } : {}), ...(old ? { edited: now } : {}),
        };
        const btn = $('[data-ue=publish]');
        btn.disabled = true; btn.textContent = 'Publishing…';
        try {
            await host.set(host.updatePath(id), plain(value));
            for (const k of removed) await host.set(`${host.teamPath(id)}/${k}`, null).catch(() => {});
            store.set(draftKey, null);
            const wasNew = !updateId;
            updateId = id;
            removed.clear();
            draft = fromUpdate(live() || { ...value });
            recovered = null;
            renderAll();
            toast(wasNew ? 'Published. It is on the page now.' : 'Changes published.');
            host.onPublished?.(id);
        } catch (err) {
            toast(/permission/i.test(err?.code || err?.message || '') ? 'You do not have permission to publish this update.' : (err.message || String(err)));
            renderTop();
        }
    }

    // ------------------------------------------------------------ present
    function present(mediaKey = '') {
        mode = 'present'; renderTop();
        host.openPreview(asUpdate(), mediaKey, () => { mode = 'edit'; renderTop(); });
    }

    // ------------------------------------------------------------ events
    root.addEventListener('click', async e => {
        const b = e.target.closest('[data-ue]');
        if (!b || b.tagName === 'INPUT' || b.tagName === 'SELECT' || b.tagName === 'FORM') return;
        const act = b.dataset.ue;
        if (act === 'sel') { sel = b.dataset.k; if (narrow()) { layout.outline = false; renderTop(); } renderOutline(); renderForm(); }
        else if (act === 'outline') { layout.outline = !layout.outline; if (narrow() && layout.outline) layout.preview = false; saveLayout(); renderTop(); }
        else if (act === 'preview') { layout.preview = !layout.preview; if (narrow() && layout.preview) layout.outline = false; saveLayout(); renderTop(); renderPreview(); }
        else if (act === 'mode') { if (b.dataset.m === 'present') present(sel === 'words' ? '' : sel); }
        else if (act === 'present-full') present(sel === 'words' ? '' : sel);
        else if (act === 'undo') step(undo, redo);
        else if (act === 'redo') step(redo, undo);
        else if (act === 'drive' || act === 'add-menu') { if (act === 'add-menu') { sel = 'words'; renderOutline(); renderForm(); $('.ue-add')?.scrollIntoView({ behavior: 'smooth' }); return; } openGallery(); }
        else if (act === 'replace') openGallery({ replace: sel });
        else if (act === 'remove') {
            const m = draft.media.find(x => x.key === b.dataset.k);
            if (!m) return;
            const n = notesOn(m);
            if (n && !confirm(`Remove “${m.caption || m.name}”? Its ${n} note${n === 1 ? '' : 's'} go too when you publish. The file stays in Google Drive.`)) return;
            change(() => { draft.media = draft.media.filter(x => x !== m); removed.add(m.key); if (sel === m.key) sel = 'words'; });
            renderForm();
        } else if (act === 'move') {
            const i = draft.media.findIndex(x => x.key === sel), j = i + Number(b.dataset.d);
            if (draft.media[j]) { change(() => { const [x] = draft.media.splice(i, 1); draft.media.splice(j, 0, x); }); renderForm(); }
        } else if (act === 'annotate') { close(); host.openStudio(updateId, sel, true); }
        else if (act === 'publish') publish();
        else if (act === 'close') close();
        else if (act === 'restore') { change(() => { draft = recovered.draft; }); recovered = null; renderAll(); }
        else if (act === 'discard') { recovered = null; store.set(draftKey, null); renderBanner(); }
    });
    root.addEventListener('keydown', e => {
        if (e.target.closest?.('[data-ue=sel]') && e.key === 'Enter') { e.target.click(); return; }
        if (e.key === 'Escape' && !document.querySelector('.dg, .us, .ds-connect')) { e.preventDefault(); close(); }
        const field = e.target.matches?.('input, textarea, select');
        if ((e.ctrlKey || e.metaKey) && !field && e.key.toLowerCase() === 'z') { e.preventDefault(); step(e.shiftKey ? redo : undo, e.shiftKey ? undo : redo); }
        if ((e.ctrlKey || e.metaKey) && !field && e.key.toLowerCase() === 'y') { e.preventDefault(); step(redo, undo); }
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); publish(); }
    });
    root.addEventListener('input', e => {
        const t = e.target;
        if (t.dataset.f) { typed(() => { draft[t.dataset.f] = t.value; }); counts(); }
        else if (t.dataset.m) { const m = draft.media.find(x => x.key === sel); if (m) typed(() => { m[t.dataset.m] = t.value; }); }
    });
    root.addEventListener('change', async e => {
        const t = e.target;
        try {
            if (t.dataset.ue === 'upload') { const files = [...t.files]; t.value = ''; const { items } = await fromComputer(files); addItems(items); }
            else if (t.dataset.ue === 'link-note' && t.value) {
                const ta = $('[data-f=text]');
                const [mId, kId] = t.value.split('/');
                const a = ta.selectionStart, z = ta.selectionEnd;
                const label = t.selectedOptions[0].textContent.match(/note \d+/)?.[0] || 'this note';
                const words = ta.value.slice(a, z).replace(/[\[\]\n]/g, ' ').trim() || label;
                ta.setRangeText(`[${words.slice(0, 80)}](note:${mId}/${kId})`, a, z, 'end');
                typed(() => { draft.text = ta.value; });
                counts();
                t.value = '';
                ta.focus();
            }
            else if (t.dataset.ue === 'site-model' && t.value) { const f = host.siteModels.find(x => x.path === t.value); addItems([newItem({ kind: 'model', path: f.path, name: f.label })]); }
        } catch (err) { toast(err.message || String(err)); }
    });
    root.addEventListener('submit', e => {
        const form = e.target.closest('[data-ue-form=link]');
        if (!form) return;
        e.preventDefault();
        const f = Object.fromEntries(new FormData(form));
        const id = driveIdFrom(f.link);
        if (!id) { toast('That is not a Google Drive link.'); return; }
        addItems([newItem({ kind: f.kind, file: id, name: KIND_LABEL[f.kind] })]);
    });
    // Drag to reorder in the outline.
    let dragKey = '';
    root.addEventListener('dragstart', e => { const li = e.target.closest?.('.ue-row[draggable]'); if (!li) return; dragKey = li.dataset.k; li.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', dragKey); });
    root.addEventListener('dragend', () => { dragKey = ''; root.querySelectorAll('.ue-row').forEach(r => r.classList.remove('dragging', 'drop-before', 'drop-after')); });
    root.addEventListener('dragover', e => {
        const li = e.target.closest?.('.ue-row[draggable]');
        if (!dragKey || !li) return;
        e.preventDefault();
        const after = e.clientY > li.getBoundingClientRect().top + li.offsetHeight / 2;
        root.querySelectorAll('.ue-row').forEach(r => r.classList.remove('drop-before', 'drop-after'));
        li.classList.add(after ? 'drop-after' : 'drop-before');
    });
    root.addEventListener('drop', e => {
        const li = e.target.closest?.('.ue-row[draggable]');
        if (!dragKey || !li) return;
        e.preventDefault();
        const after = li.classList.contains('drop-after');
        const from = draft.media.findIndex(m => m.key === dragKey);
        let to = draft.media.findIndex(m => m.key === li.dataset.k) + (after ? 1 : 0);
        if (from < 0 || to < 0) return;
        if (from < to) to--;
        if (from !== to) change(() => { const [x] = draft.media.splice(from, 1); draft.media.splice(to, 0, x); });
        renderForm();
    });

    function saveLayout() { if (!narrow()) store.set(LAYOUT_KEY, JSON.stringify(layout)); }
    function toast(text) {
        root.querySelector('.ue-toast')?.remove();
        const t = document.createElement('div');
        t.className = 'ue-toast'; t.setAttribute('role', 'status'); t.textContent = text;
        root.append(t);
        setTimeout(() => t.remove(), 4500);
    }
    function close() {
        if (dirty() && !confirm('Close without publishing? Your changes stay in this browser and come back next time you open this update.')) return;
        root.remove();
        if (!document.querySelector('.us')) document.body.classList.remove('us-open');
        host.onClose?.();
        lastFocus?.focus?.();
    }
    // Called by case-updates.js when the published data changes (e.g. notes added in full screen).
    function refresh() { if (root.isConnected) { renderTop(); renderOutline(); if (sel !== 'words') renderForm(); renderPreview(); } }

    renderAll();
    (sel === 'words' ? $('[data-f=title]') : null)?.focus();
    return { refresh, close };
}
