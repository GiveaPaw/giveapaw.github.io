// Google Drive gallery for the update editor, laid out like the presentation editor's media gallery:
// places (the animal's Drive folders) on the left, a filtered grid of thumbnails in the middle, and the
// selected file's preview and details on the right. Browsing uses only the public browser key (the
// animals folder is shared "anyone with the link"); uploading uses the editor's Google sign-in.
//
// openDriveGallery({ animal, title, upload(files) -> Promise, onAdd(files) }) resolves when it closes.
import { listFolder, thumbUrl, viewUrl, mediaUrl, fileKind, driveReady } from './drive-store.js?v=2';

const ICON = {
    drive: '<path d="M8 3h8l6 10-4 7H6l-4-7z"/><path d="M8 3l6 10H2M16 3 10 13l-4 7M22 13H10"/>',
    folder: '<path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    upload: '<path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>',
    refresh: '<path d="M20 11a8 8 0 0 0-14.9-3M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14.9 3M20 20v-4h-4"/>',
    close: '<path d="M6 6l12 12M18 6 6 18"/>',
    ext: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/>',
    check: '<path d="M5 12l5 5 9-10"/>',
};
const svg = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name]}</svg>`;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtBytes = b => (!b ? '' : b >= 1e9 ? (b / 1e9).toFixed(1) + ' GB' : b >= 1e6 ? (b / 1e6).toFixed(b >= 1e7 ? 0 : 1) + ' MB' : Math.max(1, Math.round(b / 1e3)) + ' KB');
const fmtDate = s => (s ? new Date(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '');
const fmtDur = ms => { const s = Math.round((Number(ms) || 0) / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const KIND_LABEL = { photo: 'Picture', video: 'Video', model: '3D model', mesh: '3D mesh' };
// Folders a visitor-facing update should draw from. Documents (intake forms) is left out on purpose.
const PLACE_ORDER = ['Website uploads', 'Photos and videos', 'Scans', 'Design files', 'Print files'];

export function openDriveGallery({ animal, title = '', upload, onAdd }) {
    return new Promise(resolve => {
        // Not a modal <dialog>: Google's file picker (used the first time someone uploads) must be able to
        // show above it, and modal dialogs sit in a layer nothing else can cover.
        const shade = document.createElement('div');
        shade.className = 'dg-shade';
        const dlg = document.createElement('div');
        dlg.className = 'dg';
        dlg.setAttribute('role', 'dialog');
        dlg.setAttribute('aria-modal', 'true');
        dlg.setAttribute('aria-label', 'Google Drive gallery');
        document.body.append(shade, dlg);
        const lastFocus = document.activeElement;
        let places = [];          // [{ id, name }]
        let trail = [];           // breadcrumb: [{ id, name }]
        let items = [];           // current folder listing
        let filter = 'all', sort = 'new', query = '';
        const picked = new Map(); // id -> file
        let focus = null;
        let loading = false, error = '';

        dlg.innerHTML = `
            <header class="dg-head">
                <div><h2>${svg('drive')} Google Drive</h2><p>${esc(animal.name)}${title ? ` · for “${esc(title)}”` : ''}</p></div>
                <button type="button" class="dg-btn dg-icon" data-dg="close" aria-label="Close">${svg('close')}</button>
            </header>
            <div class="dg-body">
                <nav class="dg-places" aria-label="Folders"></nav>
                <section class="dg-main">
                    <div class="dg-tools">
                        <div class="dg-crumbs"></div>
                        <div class="dg-seg" role="group" aria-label="Show">${[['all', 'All'], ['photo', 'Pictures'], ['video', 'Videos'], ['model', '3D models']].map(([k, n]) => `<button type="button" data-dg="filter" data-k="${k}" aria-pressed="${k === 'all'}">${n}</button>`).join('')}</div>
                        <select data-dg="sort" aria-label="Sort"><option value="new">Newest first</option><option value="old">Oldest first</option><option value="name">Name</option></select>
                        <input type="search" data-dg="search" placeholder="Search this folder" aria-label="Search this folder">
                        <button type="button" class="dg-btn dg-icon" data-dg="refresh" aria-label="Refresh">${svg('refresh')}</button>
                    </div>
                    <div class="dg-grid" tabindex="-1"></div>
                    <div class="dg-drop" hidden>${svg('upload')}<strong>Drop to upload into “Website uploads”</strong></div>
                </section>
                <aside class="dg-detail" aria-live="polite"></aside>
            </div>
            <footer class="dg-foot">
                <label class="dg-btn dg-upload${upload ? '' : ' is-off'}">${svg('upload')} Upload from this computer<input type="file" multiple accept="image/*,video/*,.stl,.obj,.3mf,.glb" data-dg="upload"${upload ? '' : ' disabled'}></label>
                <span class="dg-count"></span>
                <button type="button" class="dg-btn" data-dg="close">Cancel</button>
                <button type="button" class="dg-btn dg-primary" data-dg="add" disabled>Add to update</button>
            </footer>`;
        const $ = s => dlg.querySelector(s);

        function close(result = []) { document.removeEventListener('keydown', onKey, true); dlg.remove(); shade.remove(); lastFocus?.focus?.(); resolve(result); }
        const onKey = e => { if (e.key === 'Escape' && !document.querySelector('.ds-connect, .picker-dialog')) { e.stopPropagation(); close(); } };
        document.addEventListener('keydown', onKey, true);
        shade.addEventListener('click', () => close());

        async function open(folder, { reset = false } = {}) {
            if (reset) trail = [folder]; else trail.push(folder);
            await load();
        }
        async function load() {
            const here = trail.at(-1);
            loading = true; error = ''; items = []; focus = null;
            render();
            try { items = await listFolder(here.id); } catch (e) { error = e.message; }
            loading = false;
            render();
        }

        function visible() {
            let list = items.filter(f => f.isFolder || fileKind(f));
            if (filter !== 'all') list = list.filter(f => f.isFolder || fileKind(f) === filter || (filter === 'model' && fileKind(f) === 'mesh'));
            if (query) list = list.filter(f => f.name.toLowerCase().includes(query));
            const by = { new: (a, b) => String(b.modifiedTime).localeCompare(String(a.modifiedTime)), old: (a, b) => String(a.modifiedTime).localeCompare(String(b.modifiedTime)), name: (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }) }[sort];
            return [...list.filter(f => f.isFolder).sort((a, b) => a.name.localeCompare(b.name)), ...list.filter(f => !f.isFolder).sort(by)];
        }

        function tile(f) {
            if (f.isFolder) return `<button type="button" class="dg-tile dg-folder" data-dg="folder" data-id="${esc(f.id)}"><span class="dg-thumb">${svg('folder')}</span><span class="dg-name">${esc(f.name)}</span></button>`;
            const k = fileKind(f);
            const th = k === 'photo' ? thumbUrl(f.id, 400) : f.hasThumbnail ? thumbUrl(f.id, 400) : '';
            const ext = (f.name.match(/\.([a-z0-9]+)$/i) || [])[1] || '';
            return `<button type="button" class="dg-tile${picked.has(f.id) ? ' is-picked' : ''}${focus?.id === f.id ? ' is-focus' : ''}" data-dg="file" data-id="${esc(f.id)}" aria-pressed="${picked.has(f.id)}">
                <span class="dg-thumb">${th ? `<img src="${esc(th)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}<em>${esc(ext.toUpperCase())}</em>${k === 'video' && f.videoMediaMetadata ? `<i>${fmtDur(f.videoMediaMetadata.durationMillis)}</i>` : ''}</span>
                <span class="dg-check">${svg('check')}</span>
                <span class="dg-name">${esc(f.name)}</span><span class="dg-meta">${esc([KIND_LABEL[k], fmtBytes(f.bytes)].filter(Boolean).join(' · '))}</span></button>`;
        }

        function render() {
            $('.dg-places').innerHTML = `<p class="dg-label">${esc(animal.name)}</p>` + places.map(p => `<button type="button" class="dg-place${trail[0]?.id === p.id ? ' is-on' : ''}" data-dg="place" data-id="${esc(p.id)}">${svg('folder')}<span>${esc(p.name)}</span></button>`).join('')
                + `<p class="dg-hint">Only files in these folders can go in an update. They are public, like the rest of the animals folder.</p>`;
            $('.dg-crumbs').innerHTML = trail.map((t, i) => i === trail.length - 1 ? `<strong>${esc(t.name)}</strong>` : `<button type="button" data-dg="crumb" data-i="${i}">${esc(t.name)}</button><span>/</span>`).join('');
            const list = visible();
            $('.dg-grid').innerHTML = loading ? '<p class="dg-empty">Loading…</p>'
                : error ? `<p class="dg-empty dg-err">${esc(error)}</p>`
                : list.length ? list.map(tile).join('')
                : `<p class="dg-empty">${items.length ? 'Nothing here matches.' : 'This folder is empty.'}${trail.at(-1)?.name === 'Website uploads' && upload ? ' Drop files here or use “Upload from this computer”.' : ''}</p>`;
            renderDetail();
            const n = picked.size;
            $('.dg-count').textContent = n ? `${n} selected` : 'Click files to select them';
            $('[data-dg=add]').disabled = !n;
            $('[data-dg=add]').textContent = n > 1 ? `Add ${n} to update` : 'Add to update';
        }

        function renderDetail() {
            const f = focus;
            const box = $('.dg-detail');
            if (!f) { box.innerHTML = '<p class="dg-empty">Select a file to see it here.</p>'; return; }
            const k = fileKind(f);
            const im = f.imageMediaMetadata, vm = f.videoMediaMetadata;
            const media = k === 'photo' ? `<img src="${esc(thumbUrl(f.id, 600))}" alt="" referrerpolicy="no-referrer">`
                : k === 'video' ? `<video src="${esc(mediaUrl(f.id))}" controls muted playsinline preload="metadata" poster="${esc(thumbUrl(f.id, 900))}"></video>`
                : `<div class="dg-big">${esc(((f.name.match(/\.([a-z0-9]+)$/i) || [])[1] || '').toUpperCase())}</div>`;
            box.innerHTML = `<div class="dg-preview">${media}</div>
                <h3>${esc(f.name)}</h3>
                <dl>
                    <dt>Type</dt><dd>${esc(KIND_LABEL[k] || f.mimeType)}</dd>
                    ${f.bytes ? `<dt>Size</dt><dd>${fmtBytes(f.bytes)}</dd>` : ''}
                    ${im?.width ? `<dt>Picture</dt><dd>${im.width} × ${im.height}</dd>` : ''}
                    ${vm?.durationMillis ? `<dt>Length</dt><dd>${fmtDur(vm.durationMillis)}${vm.width ? ` · ${vm.width} × ${vm.height}` : ''}</dd>` : ''}
                    <dt>Changed</dt><dd>${esc(fmtDate(f.modifiedTime))}</dd>
                </dl>
                ${k === 'mesh' ? '<p class="dg-note">This mesh is compressed into a web 3D model (about a tenth of the size) and saved in “Website uploads” when you add it.</p>' : ''}
                ${k === 'video' && /quicktime/.test(f.mimeType) ? '<p class="dg-note">iPhone videos (.MOV) play in Safari; Chrome on Windows may not play HEVC ones. If the preview stays black, convert it to MP4 first.</p>' : ''}
                <a class="dg-btn" href="${esc(viewUrl(f.id))}" target="_blank" rel="noopener">${svg('ext')} Open in Drive</a>`;
        }

        dlg.addEventListener('click', e => {
            const b = e.target.closest('[data-dg]');
            if (!b || b.tagName === 'INPUT' || b.tagName === 'SELECT') return;
            const act = b.dataset.dg;
            if (act === 'close') close();
            else if (act === 'add') close([...picked.values()]);
            else if (act === 'place') open(places.find(p => p.id === b.dataset.id), { reset: true });
            else if (act === 'crumb') { trail = trail.slice(0, Number(b.dataset.i) + 1); load(); }
            else if (act === 'folder') open({ id: b.dataset.id, name: items.find(f => f.id === b.dataset.id)?.name || 'Folder' });
            else if (act === 'file') {
                const f = items.find(x => x.id === b.dataset.id);
                if (!f) return;
                if (picked.has(f.id) && focus?.id === f.id) picked.delete(f.id); else picked.set(f.id, f);
                focus = f;
                render();
            } else if (act === 'filter') { filter = b.dataset.k; dlg.querySelectorAll('[data-dg=filter]').forEach(x => x.setAttribute('aria-pressed', String(x === b))); render(); }
            else if (act === 'refresh') load();
        });
        dlg.addEventListener('dblclick', e => { const b = e.target.closest('[data-dg=file]'); if (b) { const f = items.find(x => x.id === b.dataset.id); if (f) close([f]); } });
        dlg.addEventListener('input', e => { if (e.target.dataset.dg === 'search') { query = e.target.value.trim().toLowerCase(); render(); } });
        dlg.addEventListener('change', async e => {
            if (e.target.dataset.dg === 'sort') { sort = e.target.value; render(); }
            if (e.target.dataset.dg === 'upload') await doUpload([...e.target.files]);
        });

        // Drag files from the computer onto the gallery: they upload into "Website uploads".
        const drop = $('.dg-drop');
        dlg.addEventListener('dragover', e => { if (!upload || ![...e.dataTransfer.types].includes('Files')) return; e.preventDefault(); drop.hidden = false; });
        dlg.addEventListener('dragleave', e => { if (e.target === drop) drop.hidden = true; });
        dlg.addEventListener('drop', async e => { if (!upload) return; e.preventDefault(); drop.hidden = true; await doUpload([...e.dataTransfer.files]); });

        async function doUpload(files) {
            if (!files.length) return;
            const uploads = places.find(p => p.name === 'Website uploads');
            try {
                const added = await upload(files);
                if (uploads) { trail = [uploads]; await load(); }
                (added || []).forEach(f => { const hit = items.find(x => x.id === f.id); if (hit) { picked.set(hit.id, hit); focus = hit; } });
                render();
            } catch (err) { error = err.message || String(err); render(); }
        }

        render();
        $('[data-dg=close]').focus();
        if (!driveReady()) { error = 'Google Drive is not set up on this site yet.'; render(); return; }
        listFolder(animal.driveFolder).then(list => {
            places = list.filter(f => f.isFolder && PLACE_ORDER.includes(f.name)).sort((a, b) => PLACE_ORDER.indexOf(a.name) - PLACE_ORDER.indexOf(b.name)).map(f => ({ id: f.id, name: f.name }));
            const start = places.find(p => p.name === 'Photos and videos') || places[0];
            if (start) open(start, { reset: true }); else { error = 'No folders found for ' + animal.name + '.'; render(); }
        }).catch(err => { error = err.message; render(); });
    });
}
