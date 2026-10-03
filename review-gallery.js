// Media gallery for the presentation editor: browse pictures and videos in the site, Google Drive for
// desktop, Downloads and other folders on this computer, preview them, turn them upright, and add them
// to a presentation. Files from outside the site are imported first (tools/media_library.py makes a
// web-ready copy in the site's media/ folder), because the published site can only show its own files.
// Files can also be dragged in from the computer. Needs the local preview server (tools/range_server.py).

const VIDEO = /\.(mp4|mov|m4v|webm|avi|mkv|3gp)$/i;
const SITE_WEB_IMAGE = /\.(jpe?g|png|webp|gif|svg)$/i;
const PLACE_ICONS = { site: 'globe', downloads: 'download', desktop: 'monitor', pictures: 'image', videos: 'film' };
const PLACE_KEY = 'gap-gallery-place';
const SORT_KEY = 'gap-gallery-sort';
const api = (route, params) => `/__editor/${route}?${new URLSearchParams(params)}`;
const fmtSize = bytes => bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : bytes >= 1e6 ? `${Math.round(bytes / 1e6)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`;
const fmtDuration = s => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
const norm = deg => ((Math.round(+deg / 90) * 90) % 360 + 360) % 360;
function remember(key, value) { try { if (value === undefined) return JSON.parse(localStorage.getItem(key)); localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage off */ } return null; }

export function createGallery({ h, ic, icons, toast, getMedia, usedFiles, afterImport, onRenamed }) {
    let rootsCache = null;
    async function getJSON(url, options) {
        const response = await fetch(url, { cache: 'no-cache', ...options });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || `The preview server answered ${response.status}.`);
        return data;
    }

    /**
     * @param {object} o
     *   title, subtitle      header text
     *   accept               'any' | 'video' | 'image'
     *   multiple             false: picking one file replaces something
     *   folder               default media/ folder for imports
     *   targets              [{ label, add(items) }]: where "Add" puts the files (a choice when several)
     * Items handed to add(): { src, poster?, kind: 'video' | 'image', name, rotate? }
     */
    return async function openGallery(o) {
        const accept = o.accept || 'any';
        const multiple = o.multiple !== false;
        const st = {
            place: null, listing: null, filter: accept === 'any' ? 'all' : accept, query: '', sort: remember(SORT_KEY) || 'newest',
            selected: new Map(), current: null, turns: new Map(), busy: false, uploads: [], folder: o.folder || 'media/uploads', target: 0,
        };
        const keyOf = f => `${f.root}|${f.path}`;
        const dialog = h('dialog', { class: 'ed-gallery', 'aria-label': 'Media gallery' });
        const placesEl = h('nav', { class: 'eg-places', 'aria-label': 'Places' });
        const crumbsEl = h('div', { class: 'eg-crumbs' });
        const gridEl = h('div', { class: 'eg-grid', tabindex: -1 });
        const uploadsEl = h('div', { class: 'eg-uploads', hidden: true });
        const previewEl = h('aside', { class: 'eg-preview' });
        const countEl = h('span', { class: 'eg-count' });
        const folderSelect = h('select', { title: 'Folder in the site that imported copies go into' });
        const folderWrap = h('label', { class: 'eg-pick' }, h('span', {}, 'Copy into'), folderSelect);
        const targetSelect = h('select', { title: 'Where the files go' });
        const targetWrap = h('label', { class: 'eg-pick' }, h('span', {}, 'Add to'), targetSelect);
        const addBtn = h('button', { type: 'button', class: 'ed-btn ed-primary' });
        const closeBtn = h('button', { type: 'button', class: 'ed-btn ed-icon', title: 'Close (Esc)', onclick: () => close() }, ic('x'));
        const search = h('input', { type: 'search', placeholder: 'Search this folder', oninput: e => { st.query = e.target.value.trim().toLowerCase(); renderGrid(); } });
        const filterEl = h('div', { class: 'eg-seg', role: 'group', 'aria-label': 'Show' },
            [['all', 'All'], ['video', 'Videos'], ['image', 'Pictures']].filter(([k]) => accept === 'any' || k === accept)
                .map(([k, label]) => h('button', { type: 'button', dataset: { filter: k }, onclick: () => { st.filter = k; renderGrid(); } }, label)));
        const sortSelect = h('select', { title: 'Order', onchange: e => { st.sort = e.target.value; remember(SORT_KEY, st.sort); renderGrid(); } },
            h('option', { value: 'newest', selected: st.sort === 'newest' }, 'Newest first'), h('option', { value: 'name', selected: st.sort === 'name' }, 'By name'));

        dialog.append(
            h('div', { class: 'eg-head' },
                h('div', {}, h('h3', {}, ic('images'), o.title || 'Media gallery'), o.subtitle ? h('p', {}, o.subtitle) : null),
                closeBtn),
            h('div', { class: 'eg-body' },
                placesEl,
                h('section', { class: 'eg-main' },
                    h('div', { class: 'eg-bar' }, crumbsEl, h('span', { class: 'eg-spacer' }), filterEl, sortSelect, search,
                        h('button', { type: 'button', class: 'ed-btn ed-icon', title: 'Refresh this folder', onclick: () => go(st.place) }, ic('refresh-cw'))),
                    uploadsEl,
                    gridEl),
                previewEl),
            h('div', { class: 'eg-foot' }, countEl, h('span', { class: 'eg-spacer' }), targetWrap, folderWrap,
                h('button', { type: 'button', class: 'ed-btn', onclick: () => close() }, 'Cancel'), addBtn));
        document.body.append(dialog);
        dialog.addEventListener('cancel', event => { if (st.busy) { event.preventDefault(); toast('Still copying files into the site. Wait for it to finish.'); } });
        dialog.addEventListener('close', () => dialog.remove());
        dialog.showModal();
        icons();

        function close() {
            if (st.busy) { toast('Still copying files into the site. Wait for it to finish.'); return; }
            shut();
        }
        // Remove it straight away: the close event can be held back while the window is not drawing.
        function shut() { dialog.close(); dialog.remove(); }

        // ---- places, folders, and the grid ---------------------------------------------------------------
        let roots = [];
        try {
            rootsCache ||= await getJSON('/__editor/roots');
            roots = rootsCache.roots || [];
        } catch (error) {
            gridEl.replaceChildren(h('div', { class: 'eg-empty' }, ic('plug-zap'), h('strong', {}, 'The media gallery needs the local preview server.'),
                h('span', {}, 'Open the editor from tools/range_server.py (the give-a-paw-review preview), then try again.')));
            icons();
            return;
        }
        placesEl.replaceChildren(
            ...roots.map(r => h('button', { type: 'button', dataset: { root: r.id }, onclick: () => go({ root: r.id, path: r.id === 'site' ? 'media' : '' }) },
                ic(PLACE_ICONS[r.id] || (r.kind === 'drive' ? 'cloud' : r.kind === 'shortcut' ? 'folder-symlink' : 'folder')), h('span', {}, r.label))),
            h('p', { class: 'eg-tip' }, ic('info'), h('span', {}, roots.some(r => r.kind === 'drive')
                ? 'Upload to Google Drive from your phone; files show up here once Drive for desktop has synced. Files from outside the site are copied in (videos converted to MP4) when you add them.'
                : 'Google Drive for desktop is not installed, so Drive is not listed. You can still drag files in from your computer.')),
            roots.some(r => r.kind === 'drive') ? h('p', { class: 'eg-tip' }, ic('folder-symlink'), h('span', {}, 'A folder someone shared with you is not listed until you add it to My Drive: on drive.google.com, right-click it in "Shared with me" > Organize > Add shortcut > My Drive.')) : null,
            h('p', { class: 'eg-tip' }, ic('upload'), h('span', {}, 'Or drag pictures and videos from your computer onto the gallery.')));

        function folderOptions() {
            const media = getMedia();
            const folders = new Set(media.filter(f => f.startsWith('media/') && f.lastIndexOf('/') > 5).map(f => f.slice(0, f.lastIndexOf('/'))));
            folders.add(st.folder);
            folderSelect.replaceChildren(...[...folders].sort().map(f => h('option', { value: f, selected: f === st.folder }, f)),
                h('option', { value: '__new' }, 'New folder…'));
        }
        folderSelect.addEventListener('change', () => {
            if (folderSelect.value === '__new') {
                const name = prompt('Name for the new folder (inside media/):', st.folder.replace(/^media\//, '') + '-2');
                const clean = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);
                if (clean) st.folder = `media/${clean}`;
            } else st.folder = folderSelect.value;
            folderOptions();
            renderGrid();
        });
        folderOptions();
        const targets = o.targets || [];
        targetSelect.replaceChildren(...targets.map((t, i) => h('option', { value: i }, t.label)));
        targetSelect.addEventListener('change', () => { st.target = +targetSelect.value; });
        targetWrap.hidden = targets.length < 2;

        async function go(place) {
            if (!place) return;
            st.place = place;
            remember(PLACE_KEY, place);
            placesEl.querySelectorAll('[data-root]').forEach(b => b.classList.toggle('active', b.dataset.root === place.root));
            gridEl.replaceChildren(h('div', { class: 'eg-empty' }, h('span', { class: 'eg-spin' }), h('span', {}, 'Opening folder…')));
            try {
                st.listing = await getJSON(api('browse', place));
            } catch (error) {
                if (place.path) { go({ root: place.root, path: '' }); return; }   // a remembered folder that has gone
                st.listing = null;
                gridEl.replaceChildren(h('div', { class: 'eg-empty' }, ic('folder-x'), h('span', {}, error.message)));
                crumbsEl.replaceChildren();
                icons();
                return;
            }
            if (st.place !== place) return;
            renderCrumbs();
            renderGrid();
        }
        function renderCrumbs() {
            const L = st.listing;
            const parts = L.path ? L.path.split('/') : [];
            crumbsEl.replaceChildren(
                h('button', { type: 'button', onclick: () => go({ root: L.root, path: '' }) }, L.label),
                ...parts.flatMap((part, i) => [h('span', { class: 'eg-crumb-sep' }, '/'),
                    h('button', { type: 'button', onclick: () => go({ root: L.root, path: parts.slice(0, i + 1).join('/') }) }, part)]));
            crumbsEl.scrollLeft = crumbsEl.scrollWidth;
        }
        const thumbUrl = (f, w = 320) => f.root === 'site' && SITE_WEB_IMAGE.test(f.path) ? encodeURI(f.path) : api('thumb', { root: f.root, path: f.path, w });
        function visibleFiles() {
            const L = st.listing;
            if (!L) return [];
            let files = L.files.map(f => ({ ...f, root: L.root }));
            if (st.filter !== 'all') files = files.filter(f => f.kind === st.filter);
            if (st.query) files = files.filter(f => f.name.toLowerCase().includes(st.query));
            if (st.sort === 'newest') files.sort((a, b) => b.mtime - a.mtime);
            return files;
        }
        function renderGrid() {
            filterEl.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.filter === st.filter));
            const L = st.listing;
            if (!L) return;
            const used = usedFiles();
            const folders = L.folders.filter(f => !st.query || f.name.toLowerCase().includes(st.query));
            const files = visibleFiles();
            const tiles = [
                ...(L.path ? [h('button', { type: 'button', class: 'eg-tile eg-folder eg-up', title: 'Up one folder', onclick: () => go({ root: L.root, path: L.path.split('/').slice(0, -1).join('/') }) }, ic('corner-left-up'), h('span', { class: 'eg-name' }, 'Up'))] : []),
                ...folders.map(f => h('button', { type: 'button', class: 'eg-tile eg-folder', title: f.shortcut ? `${f.name} (shared folder)` : f.name, onclick: () => go({ root: f.root || L.root, path: f.path }) }, ic(f.shortcut ? 'folder-symlink' : 'folder'), h('span', { class: 'eg-name' }, f.name))),
                ...files.map(f => fileTile(f, used)),
            ];
            if (!tiles.length) tiles.push(h('div', { class: 'eg-empty' }, ic('image-off'), h('span', {}, st.query || st.filter !== 'all' ? 'Nothing here matches.' : 'No pictures or videos in this folder.')));
            gridEl.replaceChildren(...tiles);
            icons();
            renderFoot();
        }
        // A file from outside the site whose web copy is already in the chosen folder (adding it reuses that).
        function copied(f) {
            if (f.root === 'site') return false;
            if (f.inSite) return true;   // the server remembers copies, also after the original was renamed
            const stem = f.name.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
            const media = new Set(getMedia());
            const exts = f.kind === 'video' ? ['.mp4'] : ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
            return exts.some(ext => media.has(`${st.folder}/${stem}${ext}`));
        }
        function fileTile(f, used) {
            const key = keyOf(f);
            const inUse = f.root === 'site' && used.has(f.path);
            const turn = st.turns.get(key) || 0;
            const img = h('img', { alt: '', loading: 'lazy', src: thumbUrl(f), style: turn ? `transform: rotate(${turn}deg)` : null });
            img.addEventListener('error', () => img.replaceWith(h('span', { class: 'eg-noimg' }, ic(f.kind === 'video' ? 'film' : 'image'))), { once: true });
            const tile = h('button', { type: 'button', class: 'eg-tile' + (st.selected.has(key) ? ' selected' : '') + (st.current && keyOf(st.current) === key ? ' current' : ''), title: f.name, dataset: { key },
                onclick: event => pick(f, event), ondblclick: () => { if (!multiple) add(); } },
                h('span', { class: 'eg-thumb' }, img,
                    h('span', { class: 'eg-badge' }, ic(f.kind === 'video' ? 'film' : 'image'), fmtSize(f.size)),
                    inUse ? h('span', { class: 'eg-used', title: 'Already used in this presentation' }, ic('check-check'), 'In use')
                        : copied(f) ? h('span', { class: 'eg-added', title: `Already copied into ${st.folder}: adding it again reuses that copy` }, ic('check'), 'In site') : null,
                    h('span', { class: 'eg-check', 'aria-hidden': 'true' }, ic('check'))),
                h('span', { class: 'eg-name' }, f.name));
            return tile;
        }
        function pick(f, event) {
            const key = keyOf(f);
            if (!multiple) st.selected.clear();
            if (multiple && event?.shiftKey && st.current) {
                const files = visibleFiles();
                const a = files.findIndex(x => keyOf(x) === keyOf(st.current));
                const b = files.findIndex(x => keyOf(x) === key);
                if (a >= 0 && b >= 0) files.slice(Math.min(a, b), Math.max(a, b) + 1).forEach(x => st.selected.set(keyOf(x), x));
            } else if (st.selected.has(key) && multiple) st.selected.delete(key);
            else st.selected.set(key, f);
            st.current = f;
            gridEl.querySelectorAll('.eg-tile[data-key]').forEach(t => {
                t.classList.toggle('selected', st.selected.has(t.dataset.key));
                t.classList.toggle('current', t.dataset.key === key);
            });
            renderPreview();
            renderFoot();
        }

        // ---- preview -------------------------------------------------------------------------------------
        function renderPreview() {
            const f = st.current;
            if (!f) {
                previewEl.replaceChildren(h('div', { class: 'eg-empty' }, ic('mouse-pointer-click'), h('span', {}, multiple ? 'Click pictures and videos to choose them (Shift+click for a run). The last one you click plays here.' : 'Click a file to see it here.')));
                icons();
                return;
            }
            const key = keyOf(f);
            const stage = h('div', { class: 'eg-stage' });
            const site = f.root === 'site';
            let media;
            if (f.kind === 'video') {
                media = h('video', { controls: true, preload: 'metadata', playsinline: true, src: site ? encodeURI(f.path) : api('raw', { root: f.root, path: f.path }) });
                media.addEventListener('error', () => {
                    const still = h('img', { alt: '', src: api('thumb', { root: f.root, path: f.path, w: 900 }) });
                    media.replaceWith(still);
                    media = still;
                    still.addEventListener('load', applyTurn, { once: true });
                    stage.append(h('p', { class: 'eg-stage-note' }, 'This video format does not play in the browser. It plays normally once added: it is converted to MP4.'));
                }, { once: true });
                media.addEventListener('loadedmetadata', applyTurn);
            } else {
                media = h('img', { alt: '', src: site && SITE_WEB_IMAGE.test(f.path) ? encodeURI(f.path) : api('thumb', { root: f.root, path: f.path, w: 1400 }) });
                media.addEventListener('load', applyTurn, { once: true });
            }
            stage.append(media);
            function applyTurn() {
                const deg = st.turns.get(key) || 0;
                const W = stage.clientWidth, H = stage.clientHeight;
                const nw = media.videoWidth || media.naturalWidth, nh = media.videoHeight || media.naturalHeight;
                let scale = 1;
                if (deg % 180 && nw && nh && W && H) {
                    const a = nw / nh;
                    const fw = Math.min(W, H * a);                // fitted width, upright
                    const rh = Math.min(H, W * a);                // the same edge once turned upright
                    scale = rh / fw;
                }
                media.style.transform = deg ? `rotate(${deg}deg) scale(${scale.toFixed(4)})` : '';
                gridEl.querySelector(`.eg-tile[data-key="${CSS.escape(key)}"] img`)?.style.setProperty('transform', deg ? `rotate(${deg}deg)` : '');
                turnLabel.textContent = ['Upright', 'Turned right', 'Upside down', 'Turned left'][deg / 90];
            }
            const turn = by => { st.turns.set(key, norm((st.turns.get(key) || 0) + by)); if (!st.selected.has(key)) pick(f); applyTurn(); };
            const turnLabel = h('span', { class: 'eg-turn-label' });
            const details = h('dl', { class: 'eg-details' }, h('dt', {}, 'Size'), h('dd', {}, fmtSize(f.size)));
            previewEl.replaceChildren(
                stage,
                h('div', { class: 'eg-turn' },
                    h('button', { type: 'button', class: 'ed-btn ed-mini ed-icon', title: 'Turn left', onclick: () => turn(-90) }, ic('rotate-ccw')),
                    h('button', { type: 'button', class: 'ed-btn ed-mini ed-icon', title: 'Turn right', onclick: () => turn(90) }, ic('rotate-cw')),
                    turnLabel,
                    h('small', {}, 'Filmed sideways? Turn it here; the turn is saved with the clip.')),
                renameRow(f),
                details,
                site ? h('p', { class: 'eg-where' }, ic('globe'), f.path) : h('p', { class: 'eg-where' }, ic('copy'), `Copied into the site when added (${f.kind === 'video' ? 'converted to MP4, 1280 px' : 'as a JPEG'}).`));
            applyTurn();
            icons();
            getJSON(api('probe', { root: f.root, path: f.path })).then(info => {
                if (st.current !== f) return;
                const rows = [];
                if (info.width) rows.push(['Picture', `${info.width} × ${info.height}`]);
                if (info.duration) rows.push(['Length', fmtDuration(info.duration)]);
                if (info.fps) rows.push(['Frame rate', `${Math.round(info.fps)} fps`]);
                if (info.codec) rows.push(['Format', `${info.codec.toUpperCase()}${info.hdr ? ' (HDR)' : ''}${info.audio === false ? ', no sound' : ''}`]);
                rows.forEach(([k, v]) => details.append(h('dt', {}, k), h('dd', {}, v)));
            }).catch(() => { /* details are optional */ });
        }

        // ---- renaming --------------------------------------------------------------------------------------
        // Outside the site the file is renamed where it is (Drive syncs it) and copies already in the site keep
        // working. In the site every presentation using it is updated, and a video's poster is renamed too.
        function renameRow(f) {
            const row = h('div', { class: 'eg-file-row' });
            const showName = () => {
                row.replaceChildren(h('h4', { class: 'eg-file' }, f.name),
                    f.renamable ? h('button', { type: 'button', class: 'ed-btn ed-mini ed-icon', title: 'Rename this file', onclick: edit }, ic('pencil')) : null);
                icons();
            };
            const edit = () => {
                const ext = f.name.slice(f.name.lastIndexOf('.'));
                const input = h('input', { type: 'text', value: f.name.slice(0, -ext.length), 'aria-label': 'New name', maxlength: 150 });
                const save = async () => {
                    const name = input.value.trim();
                    if (!name || name + ext === f.name) { showName(); return; }
                    input.disabled = true;
                    try {
                        const data = await getJSON('/__editor/rename', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ root: f.root, path: f.path, name }) });
                        const oldKey = keyOf(f);
                        const turn = st.turns.get(oldKey);
                        const wasPicked = st.selected.has(oldKey);
                        Object.assign(f, { path: data.path, name: data.name });
                        st.turns.delete(oldKey);
                        if (turn) st.turns.set(keyOf(f), turn);
                        if (wasPicked) { st.selected.delete(oldKey); st.selected.set(keyOf(f), f); }
                        if (f.root === 'site') { await afterImport(); onRenamed?.(data.renamed); }
                        toast(f.root === 'site'
                            ? `Renamed to ${data.name}${data.updated.length ? `; updated ${data.updated.length} presentation${data.updated.length === 1 ? '' : 's'}` : ''}.`
                            : `Renamed to ${data.name}. Copies already in the site keep working.`, { ms: 5000 });
                        await go(st.place);
                        st.current = f;
                        renderPreview();
                    } catch (error) {
                        toast(error.message, { error: true, ms: 7000 });
                        input.disabled = false;
                        input.focus();
                    }
                };
                input.addEventListener('keydown', event => {
                    if (event.key === 'Enter') { event.preventDefault(); save(); }
                    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); showName(); }
                });
                row.replaceChildren(input, h('span', { class: 'eg-ext' }, ext),
                    h('button', { type: 'button', class: 'ed-btn ed-mini ed-primary', onclick: save }, 'Rename'),
                    h('button', { type: 'button', class: 'ed-btn ed-mini', onclick: showName }, 'Cancel'));
                input.focus();
                input.select();
            };
            showName();
            return row;
        }

        // ---- footer, adding, importing -------------------------------------------------------------------
        function renderFoot() {
            const picks = [...st.selected.values()];
            const outside = picks.filter(f => f.root !== 'site').length;
            countEl.textContent = picks.length ? `${picks.length} chosen${outside ? ` · ${outside} to copy into the site` : ''}` : (multiple ? 'Nothing chosen yet' : 'Choose a file');
            folderWrap.hidden = !outside && !st.uploads.length;
            const verb = o.actionLabel || (multiple ? 'Add' : 'Use this file');
            addBtn.replaceChildren(ic(outside ? 'download' : 'plus'), multiple && picks.length ? `${verb} ${picks.length}` : verb);
            addBtn.disabled = !picks.length || st.busy;
            icons();
        }
        addBtn.addEventListener('click', () => add());
        function tileFor(f) { return gridEl.querySelector(`.eg-tile[data-key="${CSS.escape(keyOf(f))}"]`); }
        function showProgress(f, job) {
            const tile = tileFor(f);
            if (!tile) return;
            let bar = tile.querySelector('.eg-job');
            if (!bar) { bar = h('span', { class: 'eg-job' }, h('span', { class: 'eg-job-fill' }), h('span', { class: 'eg-job-text' })); tile.querySelector('.eg-thumb').append(bar); }
            bar.classList.toggle('error', job.status === 'error');
            bar.querySelector('.eg-job-fill').style.width = `${Math.round((job.status === 'done' ? 1 : job.progress || 0) * 100)}%`;
            bar.querySelector('.eg-job-text').textContent = job.status === 'error' ? job.message : job.status === 'queued' ? 'Waiting…' : job.status === 'done' ? (job.result?.reused ? 'Already in the site' : 'Copied') : `${job.message} ${Math.round((job.progress || 0) * 100)}%`;
            bar.title = job.message || '';
        }
        async function waitForJobs(entries, onUpdate) {
            // entries: [{ job }] -- polls until every job has finished or failed.
            for (;;) {
                const open = entries.filter(e => e.job && !['done', 'error'].includes(e.job.status));
                if (!open.length) return;
                await new Promise(r => setTimeout(r, 700));
                const data = await getJSON(api('jobs', { ids: open.map(e => e.job.id).join(',') })).catch(() => ({ jobs: [] }));
                data.jobs.forEach(job => { const e = entries.find(x => x.job?.id === job.id); if (e) { e.job = job; onUpdate(e); } });
            }
        }
        async function add() {
            const picks = [...st.selected.values()];
            if (!picks.length || st.busy) return;
            st.busy = true;
            renderFoot();
            const entries = picks.map(f => ({ f }));
            const outside = entries.filter(e => e.f.root !== 'site');
            try {
                if (outside.length) {
                    countEl.textContent = `Copying ${outside.length} file${outside.length === 1 ? '' : 's'} into ${st.folder}…`;
                    const data = await getJSON('/__editor/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folder: st.folder, items: outside.map(e => ({ root: e.f.root, path: e.f.path })) }) });
                    outside.forEach((e, i) => { e.job = data.jobs[i]; showProgress(e.f, e.job); });
                    await waitForJobs(outside, e => showProgress(e.f, e.job));
                }
            } catch (error) {
                toast(error.message, { error: true, ms: 6000 });
                st.busy = false;
                renderFoot();
                return;
            }
            st.busy = false;
            const media = new Set(getMedia());
            const items = [];
            const failed = [];
            entries.forEach(e => {
                const turn = st.turns.get(keyOf(e.f)) || 0;
                if (e.f.root === 'site') {
                    const base = e.f.path.replace(/\.[^.]+$/, '');
                    const poster = e.f.kind === 'video' ? [base + '.jpg', base + '.png'].find(p => media.has(p)) : null;
                    items.push({ src: e.f.path, poster, kind: e.f.kind, name: e.f.name, rotate: turn });
                } else if (e.job?.status === 'done') {
                    items.push({ src: e.job.result.src, poster: e.job.result.poster || null, kind: e.f.kind, name: e.f.name, rotate: turn });
                    if (e.job.result.note) toast(e.job.result.note, { ms: 6000 });
                } else failed.push(e);
            });
            if (outside.length) await afterImport();
            if (items.length) {
                (targets[st.target] || targets[0]).add(items);
            }
            if (failed.length) {
                toast(`${failed.length} file${failed.length === 1 ? '' : 's'} could not be copied: ${failed[0].job?.message || 'unknown error'}`, { error: true, ms: 8000 });
                // The rest were added; leave only the failures chosen so they can be retried.
                [...st.selected.keys()].forEach(k => { if (!failed.some(e => keyOf(e.f) === k)) st.selected.delete(k); });
                renderFoot();
                return;
            }
            shut();
        }

        // ---- dragging files in from the computer ---------------------------------------------------------
        const body = dialog.querySelector('.eg-main');
        let dragDepth = 0;
        body.addEventListener('dragenter', event => { if (event.dataTransfer?.types?.includes('Files')) { dragDepth++; body.classList.add('eg-dropping'); } });
        body.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; body.classList.remove('eg-dropping'); } });
        body.addEventListener('dragover', event => { if (event.dataTransfer?.types?.includes('Files')) event.preventDefault(); });
        body.addEventListener('drop', event => {
            event.preventDefault();
            dragDepth = 0;
            body.classList.remove('eg-dropping');
            const files = [...(event.dataTransfer?.files || [])].filter(file => /^(image|video)\//.test(file.type) || /\.(heic|heif|mov|mkv)$/i.test(file.name));
            if (!files.length) { toast('Only pictures and videos can be added here.', { error: true }); return; }
            upload(files);
        });
        function renderUploads() {
            uploadsEl.hidden = !st.uploads.length;
            uploadsEl.replaceChildren(h('strong', {}, ic('upload'), `From your computer → ${st.folder}`), ...st.uploads.map(u => h('div', { class: 'eg-upload' + (u.job?.status === 'error' || u.error ? ' error' : '') },
                h('span', { class: 'eg-name' }, u.file.name),
                h('span', { class: 'eg-upload-bar' }, h('span', { style: `width:${Math.round(u.pct * 100)}%` })),
                h('span', { class: 'eg-upload-state' }, u.error || (u.job ? (u.job.status === 'done' ? 'Ready, chosen' : u.job.status === 'error' ? u.job.message : `${u.job.message || 'Waiting'}…`) : `Uploading ${Math.round(u.pct * 100)}%`)))));
            icons();
            renderFoot();
        }
        function sendFile(u) {
            return new Promise(resolve => {
                const xhr = new XMLHttpRequest();
                xhr.open('POST', api('upload', { folder: st.folder, name: u.file.name }));
                xhr.setRequestHeader('Content-Type', 'application/octet-stream');
                xhr.upload.onprogress = event => { if (event.lengthComputable) { u.pct = event.loaded / event.total * 0.5; renderUploads(); } };
                xhr.onload = () => {
                    let data = {};
                    try { data = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
                    if (xhr.status === 200 && data.job) u.job = data.job; else u.error = data.error || `Upload failed (${xhr.status})`;
                    resolve();
                };
                xhr.onerror = () => { u.error = 'Upload failed'; resolve(); };
                xhr.send(u.file);
            });
        }
        async function upload(files) {
            const batch = files.map(file => ({ file, pct: 0 }));
            st.uploads.push(...batch);
            st.busy = true;
            renderUploads();
            for (const u of batch) { await sendFile(u); renderUploads(); }
            await waitForJobs(batch, u => { u.pct = u.job.status === 'done' ? 1 : 0.5 + (u.job.progress || 0) * 0.5; renderUploads(); });
            st.busy = false;
            await afterImport();
            // Uploaded files are in the site now: choose them, and show their folder.
            batch.filter(u => u.job?.status === 'done').forEach(u => {
                const f = { root: 'site', path: u.job.result.src, name: u.job.result.src.split('/').pop(), kind: u.job.kind, size: u.file.size, mtime: Date.now() / 1000 };
                if (!multiple) st.selected.clear();
                st.selected.set(keyOf(f), f);
                st.current = f;
            });
            renderUploads();
            await go({ root: 'site', path: st.folder });
            renderPreview();
        }

        renderPreview();
        renderFoot();
        const last = remember(PLACE_KEY);
        const firstDrive = roots.find(r => r.kind === 'drive');
        await go(last && roots.some(r => r.id === last.root) ? last : firstDrive ? { root: firstDrive.id, path: '' } : { root: 'site', path: 'media' });
    };
}
