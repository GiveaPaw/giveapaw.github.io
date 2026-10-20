// Team updates on the case-study pages.
//
// Visitors: one plain request reads `cases/pages/<animal>` from the Realtime Database (public read)
// and the page shows a "Latest update" banner, an Updates feed at the top of the Report tab, the
// team's "Where it stands" status in the overview, and the newest date in the numbers strip.
// The Firebase SDK is not loaded for visitors.
//
// Team: "Team sign in" (Google). Who may write is decided by the database rules, not this file:
//   cases/admins/<email key>          true   set by hand in the Firebase console
//   cases/editors/<email key>/<animal|all>  true   set by an admin from the page ("Editors")
// The email key is the lowercased address with every "." turned into "," (keys cannot hold dots).
// Editors post, edit and delete their own updates and set the status; admins can change anyone's.
// Update text is shown as plain text (links become links). Each update can hold media (photos,
// videos, 3D models: Google Drive file ids or a site model path) with pins, notes and drawings;
// update-studio.js shows them full screen. Team-only notes live under cases/team/<animal>.
//
// ?casedemo=1 runs everything against this browser's localStorage, signed in as an admin;
// ?casedemo=viewer signs in as someone who is not an editor. See CASE-UPDATES-SETUP.md.
import { thumbUrl, isDriveId, driveIdFrom, demoGet, demoPut } from './drive-store.js?v=2';

const FIREBASE_CDN = 'https://www.gstatic.com/firebasejs/10.14.1/';
const SIGNED_IN_FLAG = 'gap-cases-signed-in';
const DEMO_KEY = 'gap-cases-demo';

const $ = (sel, root = document) => root.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = (d, opts = { month: 'short', day: 'numeric', year: 'numeric' }) => { const t = new Date(String(d) + 'T12:00:00'); return isNaN(t) ? String(d ?? '') : t.toLocaleDateString('en-US', opts); };
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const randomKey = () => Date.now().toString(36) + '-' + crypto.getRandomValues(new Uint32Array(1))[0].toString(36);
const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} } };

export const emailKey = email => String(email || '').trim().toLowerCase().replace(/\./g, ',');
const keyToEmail = key => String(key).replace(/,/g, '.');

export const driveId = driveIdFrom;
const mediaOf = u => Object.entries(u?.media || {}).map(([id, m]) => ({ id, ...m })).sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || (a.at || 0) - (b.at || 0));
const mediaThumb = m => (m.kind === 'photo' && demoGet(m.file)) || ((m.kind === 'photo' || m.kind === 'video') && isDriveId(m.file) && !demoGet(m.file) ? thumbUrl(m.file, 600) : '');

// Plain text → paragraphs, line breaks and https links; everything else escaped.
// Note links written in the full-screen view: [words](note:<media id>/<note id>) open that note.
function textHTML(text, updateId = '') {
    const link = line => line.split(/(https:\/\/[^\s<>"]+)/g).map((p, i) => (i % 2 ? `<a href="${esc(p)}" target="_blank" rel="noopener noreferrer">${esc(p)}</a>` : esc(p))).join('');
    const html = String(text || '').trim().split(/\n\s*\n/).map(par => `<p>${par.split('\n').map(link).join('<br>')}</p>`).join('');
    return html.replace(/\[([^\]<\n]{1,80})\]\(note:([A-Za-z0-9_-]{1,40})\/([A-Za-z0-9_-]{1,40})\)/g, (all, words, m, k) => (updateId ? `<a class="cu-notelink" href="#update/${esc(updateId)}/${m}/${k}">${words}</a>` : `<span class="cu-notelink">${words}</span>`));
}
const plainText = text => String(text || '').replace(/\[([^\]<\n]{1,80})\]\(note:([A-Za-z0-9_-]{1,40})\/([A-Za-z0-9_-]{1,40})\)/g, '$1');

// ------------------------------------------------------------------ stores
function createCloud() {
    const cfgPromise = import(new URL('firebase-config.js?v=1', document.baseURI).href).then(m => m.firebaseConfig);
    let sdkPromise = null, sdk = null;
    const loadSdk = () => {
        sdkPromise ||= Promise.all([cfgPromise, import(FIREBASE_CDN + 'firebase-app.js'), import(FIREBASE_CDN + 'firebase-auth.js'), import(FIREBASE_CDN + 'firebase-database.js')])
            .then(([cfg, app, auth, db]) => {
                const fbApp = app.getApps().find(a => a.name === 'cases') || app.initializeApp(cfg, 'cases');
                sdk = { auth, db, a: auth.getAuth(fbApp), d: db.getDatabase(fbApp) };
                return sdk;
            });
        sdkPromise.catch(() => { sdkPromise = null; });
        return sdkPromise;
    };
    const role = async user => {
        const key = emailKey(user.email);
        if (!user.email || !user.emailVerified) return { admin: false, editor: {} };
        const [admin, editor] = await Promise.all(['admins', 'editors'].map(n => sdk.db.get(sdk.db.ref(sdk.d, `cases/${n}/${key}`)).then(s => s.val()).catch(() => null)));
        return { admin: admin === true, editor: editor || {} };
    };
    return {
        kind: 'cloud',
        async readPublic(animal) { return this.readPath(`cases/pages/${encodeURIComponent(animal)}`); },
        async readPath(path) {
            const cfg = await cfgPromise;
            if (!cfg?.databaseURL) return {};
            const r = await fetch(`${cfg.databaseURL}/${path}.json`, { cache: 'no-cache' });
            return r.ok ? (await r.json()) || {} : {};
        },
        loadSdk,
        onAuth(cb) {
            loadSdk().then(s => s.auth.onAuthStateChanged(s.a, async user => {
                if (!user) { cb(null, null); return; }
                cb({ uid: user.uid, name: (user.displayName || user.email || 'Team member').slice(0, 60), email: user.email || '', photo: user.photoURL || '' }, await role(user));
            })).catch(err => cb(null, null, err));
        },
        // Called straight from a click with sdk already loaded, or Safari blocks the popup.
        signIn() {
            const provider = new sdk.auth.GoogleAuthProvider();
            provider.setCustomParameters({ prompt: 'select_account' });
            return sdk.auth.signInWithPopup(sdk.a, provider);
        },
        signOut() { return sdk ? sdk.auth.signOut(sdk.a) : Promise.resolve(); },
        watch(path, cb, onError) { return sdk.db.onValue(sdk.db.ref(sdk.d, path), s => cb(s.val()), onError); },
        set(path, value) { return sdk.db.set(sdk.db.ref(sdk.d, path), value); },
        newKey() { return sdk.db.push(sdk.db.ref(sdk.d, 'cases/keys')).key; },
    };
}

function createDemo(mode) {
    const load = () => { try { return JSON.parse(store.get(DEMO_KEY)) || {}; } catch { return {}; } };
    const subs = new Set();
    const get = (tree, path) => path.split('/').reduce((n, k) => (n == null ? n : n[k]), tree);
    const put = (path, value) => {
        const tree = load();
        const keys = path.split('/');
        let node = tree;
        keys.slice(0, -1).forEach(k => { node = node[k] = node[k] && typeof node[k] === 'object' ? node[k] : {}; });
        if (value == null) delete node[keys.at(-1)]; else node[keys.at(-1)] = JSON.parse(JSON.stringify(value));
        store.set(DEMO_KEY, JSON.stringify(tree));
        subs.forEach(s => s());
    };
    const user = mode === 'viewer'
        ? { uid: 'demo-viewer', name: 'Visiting Student', email: 'visitor@example.com', photo: '' }
        : { uid: 'demo-admin', name: 'Demo Editor', email: 'demo.editor@example.com', photo: '' };
    const role = mode === 'viewer' ? { admin: false, editor: {} } : { admin: true, editor: { all: true } };
    let authCb = null;
    return {
        kind: 'demo',
        async readPublic(animal) { return get(load(), `cases/pages/${animal}`) || {}; },
        async readPath(path) { return get(load(), path) || {}; },
        loadSdk: () => Promise.resolve(),
        onAuth(cb) { authCb = cb; setTimeout(() => (store.get(SIGNED_IN_FLAG) ? cb(user, role) : cb(null, null))); },
        signIn() { store.set(SIGNED_IN_FLAG, '1'); authCb?.(user, role); return Promise.resolve(); },
        signOut() { store.set(SIGNED_IN_FLAG, null); authCb?.(null, null); return Promise.resolve(); },
        watch(path, cb) { const s = () => cb(get(load(), path) ?? null); subs.add(s); s(); return () => subs.delete(s); },
        set(path, value) { put(path, value); return Promise.resolve(); },
        newKey: randomKey,
    };
}

// ------------------------------------------------------------------ page
export async function initUpdates({ H, panels, show }, manifest) {
    const animal = H.A.id;
    const demo = new URLSearchParams(location.search).get('casedemo');
    const db = demo ? createDemo(demo) : createCloud();
    const animals = (manifest?.animals || []).map(a => ({ id: a.id, name: a.name }));
    let data = {};
    let user = null, role = null, unwatch = null;
    const canEdit = () => !!role && (role.admin || role.editor.all === true || role.editor[animal] === true);
    const canChange = u => canEdit() && (role.admin || u.uid === user?.uid);
    const pagePath = `cases/pages/${animal}`;
    const teamPath = `cases/team/${animal}`;
    let teamData = {};
    let people = {};          // uid -> { name }: display names chosen on the site
    const nameOf = (uid, fallback = '') => people?.[uid]?.name || fallback || '';
    let unwatchTeam = null;
    let unwatchPeople = null;
    let studio = null;

    // ---- full-screen view (update-studio.js, loaded on first use)
    const A = manifest?.animals?.find(a => a.id === animal) || { id: animal, name: H.name };
    const siteModels = [
        ...H.versions.filter(v => v.model).map(v => ({ path: v.model, label: `${v.label}: ${v.title}` })),
        ...(H.body?.file ? [{ path: H.body.file, label: H.body.label || `${H.name}'s body` }] : []),
        ...(A.models || []).slice(0, A.featuredCount || 0).map(p => ({ path: p, label: p.replace(/\.glb$/, '') })),
    ].filter((m, i, list) => list.findIndex(x => x.path === m.path) === i);
    const host = {
        animal: { id: animal, name: H.name, uploadFolder: A.uploadFolder || '' },
        demo: db.kind === 'demo',
        siteModels,
        getUpdate: id => { const u = data.updates?.[id]; return u ? { id, ...u } : null; },
        teamMarks: (u, m) => teamData?.[u]?.[m] || null,
        updatePath: u => `${pagePath}/updates/${u}`,
        teamPath: u => `${teamPath}/${u}`,
        // The signed-in person, with the display name they chose on the site.
        user: () => user && { ...user, name: nameOf(user.uid, user.name) },
        nameOf,
        canEdit: () => canEdit(),
        canChange: obj => canChange(obj),
        set: (path, value) => db.set(path, value),
        newKey: () => db.newKey(),
        onClose: () => { studio = null; if (/^#update\//.test(location.hash)) history.replaceState(null, '', '#updates'); },
    };
    // ---- update editor (update-editor.js), laid out like the presentation editor
    let editor = null;
    let justPublished = '';
    async function openEditor(id = '') {
        const mod = await import('./update-editor.js?v=3');
        editor = mod.openUpdateEditor({
            ...host,
            animal: { ...host.animal, driveFolder: A.driveFolder || '' },
            demoStore: blob => demoPut(blob),
            demoUrl: fid => demoGet(fid),
            renderFeedItem: u => updateHTML(u, { preview: true }),
            renderCardSnippet: u => cardSnippet(u),
            openPreview: async (u, mediaKey, onDone) => {
                const st = await import('./update-studio.js?v=4');
                st.openStudio({ ...host, getUpdate: () => u, canEdit: () => false, canChange: () => false, teamMarks: () => null, onClose: onDone }, { updateId: u.id, mediaId: mediaKey });
            },
            openStudio: (uid, mid, edit) => openUpdate(uid, mid, edit),
            onPublished: uid => { justPublished = uid; },
            // After publishing, closing the editor lands on the update in the Report tab.
            onClose: () => { editor = null; if (justPublished) { justPublished = ''; goUpdates(); } },
        }, { updateId: id });
    }
    async function openUpdate(id, mediaId = '', edit = false, markId = '') {
        if (!data.updates?.[id]) return;
        const mod = await import('./update-studio.js?v=4');
        studio = mod.openStudio(host, { updateId: id, mediaId, markId, edit });
        history.replaceState(null, '', `#update/${id}${mediaId ? '/' + mediaId : ''}`);
    }

    // ---- public rendering
    function updates() {
        return Object.entries(data.updates || {}).map(([id, u]) => ({ id, ...u }))
            .sort((a, b) => String(b.date).localeCompare(String(a.date)) || (b.at || 0) - (a.at || 0));
    }

    function render() {
        document.querySelectorAll('[data-cu]').forEach(n => n.remove());
        const list = updates();
        const latest = list[0];
        // In the three-step overview the latest update lives in step 2 ("What we are building");
        // other overviews get a banner above them.
        const card = $('.chv-step[data-go=report]');
        if (card) {
            const go = $('.chv-go', card);
            go.dataset.cuOriginal ??= go.textContent;
            go.textContent = latest ? 'Read the latest update →' : go.dataset.cuOriginal;
            card.dataset.cuUpdates = latest ? '1' : '';
            if (!card.dataset.cuWired) {
                card.dataset.cuWired = '1';
                card.addEventListener('click', e => { if (card.dataset.cuUpdates) { e.stopPropagation(); goUpdates(); } });
            }
        }
        if (latest && card) {
            const box = document.createElement('span');
            box.className = 'cu-card-update';
            box.dataset.cu = '';
            box.innerHTML = cardSnippet(latest);
            $('.chv-go', card).before(box);
        } else if (latest) {
            const banner = document.createElement('a');
            banner.className = 'cu-latest';
            banner.dataset.cu = '';
            banner.href = '#updates';
            banner.innerHTML = `<span class="cu-latest-k">Latest update</span><span class="cu-latest-d">${esc(fmtDate(latest.date))}</span><strong>${esc(latest.title)}</strong><span class="cu-latest-go" aria-hidden="true">→</span>`;
            banner.addEventListener('click', e => { e.preventDefault(); goUpdates(); });
            const anchor = $('.chv-overview') || $('.ch-hub') || $('.ch-tabs');
            anchor?.before(banner);
        }
        // Feed at the top of the Report tab.
        if (list.length || canEdit()) {
            const sec = document.createElement('section');
            sec.id = 'updates';
            sec.className = 'cu-feed';
            sec.dataset.cu = '';
            sec.innerHTML = `<div class="cu-feed-head"><h2>Updates from the team</h2>${canEdit() ? '<button type="button" class="cu-btn cu-primary" data-cu-act="new">Post an update</button>' : ''}</div>
                ${list.length ? `<ol class="cu-list">${list.map(updateHTML).join('')}</ol>` : `<p class="cu-empty">No updates yet. Post the first one to tell visitors how ${esc(H.name)} is doing.</p>`}`;
            panels.report.prepend(sec);
        }
        // Team status in the overview, and the newest date in the numbers strip.
        const big = $('.chv-step.is-now .chv-step-big') || $('.chv-headline') || $('.ch-hub .ch-now strong');
        if (big) {
            big.dataset.cuOriginal ??= big.textContent;
            big.textContent = data.overview?.status || big.dataset.cuOriginal;
        }
        const stamp = $('.chv-step-stats > span:nth-child(3) b');
        if (stamp) {
            stamp.dataset.cuOriginal ??= stamp.textContent;
            const newest = [latest?.date, H.latest].filter(Boolean).sort().at(-1);
            stamp.textContent = newest ? fmtDate(newest, { month: 'short', day: 'numeric' }) : stamp.dataset.cuOriginal;
        }
        renderTeamBar();
        studio?.refresh();
        editor?.refresh();
    }

    // The latest update inside step 2 of the overview.
    function cardSnippet(u) {
        const first = mediaOf(u).find(m => m.kind === 'photo');
        const photo = first && (demoGet(first.file) || (isDriveId(first.file) ? thumbUrl(first.file, 1000) : ''));
        const plain = plainText(u.text).replace(/\s+/g, ' ').trim();
        return `<span class="cu-latest-k">Latest update · ${esc(fmtDate(u.date, { month: 'short', day: 'numeric' }))}</span>
            <strong>${esc(u.title)}</strong>
            ${plain ? `<span class="cu-card-text">${esc(plain.length > 150 ? plain.slice(0, 147).replace(/\s+\S*$/, '') + '…' : plain)}</span>` : ''}
            ${photo ? `<img src="${esc(photo)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}`;
    }

    function updateHTML(u, { preview = false } = {}) {
        const media = mediaOf(u);
        const notes = media.reduce((n, m) => n + Object.keys(m.marks || {}).length, 0);
        const by = nameOf(u.uid, u.author);
        const tile = m => {
            const th = mediaThumb(m);
            const label = m.caption || m.name || ({ photo: 'Photo', video: 'Video', model: '3D model' })[m.kind];
            return `<button type="button" class="cu-tile" data-cu-act="open" data-id="${esc(u.id)}" data-m="${esc(m.id)}" aria-label="Open ${esc(label)} full screen">
                ${th ? `<img src="${esc(th)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}
                ${m.kind !== 'photo' ? `<span class="cu-tile-kind">${m.kind === 'model' ? '3D' : '▶'}</span>` : ''}
                ${Object.keys(m.marks || {}).length ? `<span class="cu-tile-n">${Object.keys(m.marks).length}</span>` : ''}</button>`;
        };
        return `<li class="cu-item" data-id="${esc(u.id)}">
            <div class="cu-meta"><time datetime="${esc(u.date)}">${esc(fmtDate(u.date))}</time>${by ? `<span>by ${esc(by)}</span>` : ''}${u.edited ? '<span>edited</span>' : ''}</div>
            <h3><button type="button" class="cu-title" data-cu-act="open" data-id="${esc(u.id)}">${esc(u.title)}</button></h3>
            <div class="cu-text">${textHTML(u.text, preview ? '' : u.id)}</div>
            ${media.some(m => m.kind !== 'file') ? `<div class="cu-photos">${media.filter(m => m.kind !== 'file').slice(0, 8).map(tile).join('')}</div>` : ''}
            ${media.some(m => m.kind === 'file') ? `<ul class="cu-files">${media.filter(m => m.kind === 'file').map(m => `<li><a href="${esc(isDriveId(m.file) && !demoGet(m.file) ? `https://drive.google.com/file/d/${m.file}/view` : demoGet(m.file) || '#')}" target="_blank" rel="noopener"><span class="cu-file-ext">${esc(((String(m.name || '').match(/\.([a-z0-9]+)$/i) || [])[1] || 'file').toUpperCase().slice(0, 6))}</span>${esc(m.name || 'Design file')}${m.bytes ? `<small>${esc(m.bytes >= 1e6 ? Math.round(m.bytes / 1e6) + ' MB' : Math.max(1, Math.round(m.bytes / 1e3)) + ' KB')}</small>` : ''}<span aria-hidden="true">⬇</span></a></li>`).join('')}</ul>` : ''}
            <div class="cu-item-actions">
                ${media.length ? `<button type="button" class="cu-btn cu-primary" data-cu-act="open" data-id="${esc(u.id)}">Open full screen${notes ? ` · ${notes} note${notes === 1 ? '' : 's'}` : ''}</button>` : ''}
                ${!preview && canChange(u) ? `<button type="button" class="cu-btn" data-cu-act="edit" data-id="${esc(u.id)}">Edit update</button>` : ''}
                ${!preview && canEdit() && media.length ? `<button type="button" class="cu-btn" data-cu-act="annotate" data-id="${esc(u.id)}">Pins &amp; notes</button>` : ''}
                ${!preview && canChange(u) ? `<button type="button" class="cu-btn cu-danger" data-cu-act="delete" data-id="${esc(u.id)}">Delete</button>` : ''}
            </div>
        </li>`;
    }

    function goUpdates() {
        show('report');
        history.replaceState(null, '', '#updates');
        $('#updates')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    // ---- team bar and sign-in link
    const teamLink = document.createElement('p');
    teamLink.className = 'cu-team-link';
    teamLink.innerHTML = '<button type="button" data-cu-act="signin">Team sign in</button><span> to post updates</span>';
    (panels.history?.parentNode || $('main') || document.body).append(teamLink);

    const bar = document.createElement('div');
    bar.className = 'cu-bar';
    bar.hidden = true;
    bar.setAttribute('role', 'region');
    bar.setAttribute('aria-label', 'Team editing');
    document.body.append(bar);

    function renderTeamBar() {
        teamLink.hidden = !!user;
        bar.hidden = !user;
        if (!user) return;
        const shown = nameOf(user.uid, user.name);
        const needsName = canEdit() && !people?.[user.uid]?.name && shown.replace(/[^A-Za-z]/g, '').length < 3;
        const who = canEdit()
            ? `<button type="button" class="cu-who" data-cu-act="name" title="Change the name shown on your updates and notes">${user.photo ? `<img src="${esc(user.photo)}" alt="" referrerpolicy="no-referrer">` : ''}${esc(shown)} <span aria-hidden="true">✎</span></button>${needsName ? '<button type="button" class="cu-setname" data-cu-act="name">Set your name</button>' : ''}`
            : `<span class="cu-who">${user.photo ? `<img src="${esc(user.photo)}" alt="" referrerpolicy="no-referrer">` : ''}${esc(shown)}</span>`;
        bar.innerHTML = canEdit()
            ? `${who}<span class="cu-role">${role.admin ? 'Admin' : 'Editor'}</span>
               <button type="button" data-cu-act="new">Post update</button>
               <button type="button" data-cu-act="status">Status</button>
               ${role.admin ? '<button type="button" data-cu-act="editors">Editors</button>' : ''}
               <button type="button" data-cu-act="signout">Sign out</button>`
            : `${who}<span class="cu-note">Not an editor for ${esc(H.name)} yet. Ask an admin to add ${esc(user.email)}.</span>
               <button type="button" data-cu-act="signout">Sign out</button>`;
    }

    // ---- dialogs
    const dialog = document.createElement('dialog');
    dialog.className = 'cu-dialog';
    document.body.append(dialog);
    dialog.addEventListener('click', e => { if (e.target === dialog) dialog.close(); });
    const openDialog = html => { dialog.innerHTML = html; dialog.showModal(); $('input, textarea, button.cu-primary', dialog)?.focus(); };
    const fail = (err, where) => {
        const msg = /permission/i.test(err?.code || err?.message || '') ? 'You do not have permission to do that.' : (err?.message || String(err));
        const out = $('.cu-error', dialog);
        if (out && dialog.open) out.textContent = msg; else alert(msg);
        console.warn('Case updates: ' + where, err);
    };

    function signInDialog() {
        openDialog(`<form method="dialog" class="cu-form">
            <h2>Team sign in</h2>
            <p>Team members sign in with Google to post updates on ${esc(H.name)}&rsquo;s page. Visitors don&rsquo;t need to sign in.</p>
            <button type="button" class="cu-btn cu-primary cu-google" data-cu-act="google" disabled>Loading…</button>
            <p class="cu-error" role="alert"></p>
            <div class="cu-form-actions"><button type="submit" class="cu-btn" value="cancel">Cancel</button></div>
        </form>`);
        db.loadSdk().then(() => { const b = $('[data-cu-act=google]', dialog); if (b) { b.disabled = false; b.textContent = 'Sign in with Google'; } })
            .catch(err => fail(new Error('Could not reach the sign-in service. Check your connection and try again.'), 'load'));
    }

    function nameDialog() {
        openDialog(`<form class="cu-form" data-cu-form="name">
            <h2>Your name on the website</h2>
            <p>Shown as “by …” on your updates, notes and drawings, on every animal’s page. Changing it updates the ones you already posted.</p>
            <label>Display name <input name="name" required maxlength="40" value="${esc(people?.[user.uid]?.name || (user.name.length > 2 ? user.name : ''))}" placeholder="e.g. Tyler Lai"></label>
            <p class="cu-hint">Signed in as ${esc(user.email)}. Your Google account name is not changed.</p>
            <p class="cu-error" role="alert"></p>
            <div class="cu-form-actions"><button type="button" class="cu-btn" data-cu-act="close">Cancel</button><button type="submit" class="cu-btn cu-primary">Save name</button></div>
        </form>`);
    }

    function statusDialog() {
        const o = data.overview || {};
        openDialog(`<form class="cu-form" data-cu-form="status">
            <h2>Where ${esc(H.name)}&rsquo;s prosthetic stands</h2>
            <p>Replaces the headline in step 3 of the overview. Leave it empty to show the design history&rsquo;s headline again.</p>
            <label>Status <input name="status" maxlength="140" value="${esc(o.status || '')}" placeholder="e.g. Printing the final socket"></label>
            ${o.at ? `<p class="cu-hint">Last set ${esc(new Date(o.at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }))}${o.byName ? ' by ' + esc(o.byName.split(' ')[0]) : ''}.</p>` : ''}
            <p class="cu-error" role="alert"></p>
            <div class="cu-form-actions"><button type="button" class="cu-btn" data-cu-act="close">Cancel</button><button type="submit" class="cu-btn cu-primary">Save</button></div>
        </form>`);
    }

    let unwatchEditors = null;
    function editorsDialog() {
        openDialog(`<div class="cu-form" data-cu-editors>
            <h2>Editors</h2>
            <p>People added here can sign in with that Google account and post updates. Admins are set in the Firebase console.</p>
            <ul class="cu-editors"><li class="cu-hint">Loading…</li></ul>
            <form class="cu-add" data-cu-form="editor">
                <label>Google account email <input type="email" name="email" required placeholder="name@berkeley.edu"></label>
                <label>Name (optional) <input name="name" maxlength="60"></label>
                <fieldset><legend>Can post on</legend>
                    <label class="cu-check"><input type="checkbox" name="animal" value="all"> All animals</label>
                    ${animals.map(a => `<label class="cu-check"><input type="checkbox" name="animal" value="${esc(a.id)}"${a.id === animal ? ' checked' : ''}> ${esc(a.name)}</label>`).join('')}
                </fieldset>
                <p class="cu-error" role="alert"></p>
                <div class="cu-form-actions"><button type="submit" class="cu-btn cu-primary">Add editor</button></div>
            </form>
            <div class="cu-form-actions"><button type="button" class="cu-btn" data-cu-act="close">Done</button></div>
        </div>`);
        unwatchEditors?.();
        unwatchEditors = db.watch('cases/editors', list => {
            const ul = $('.cu-editors', dialog);
            if (!ul) return;
            const rows = Object.entries(list || {}).sort(([a], [b]) => a.localeCompare(b));
            ul.innerHTML = rows.length ? rows.map(([k, v]) => {
                const where = v.all ? 'All animals' : animals.filter(a => v[a.id]).map(a => a.name).join(', ') || '—';
                return `<li><span><strong>${esc(v.name || keyToEmail(k))}</strong>${v.name ? `<small>${esc(keyToEmail(k))}</small>` : ''}<small>${esc(where)}</small></span><button type="button" class="cu-btn cu-danger" data-cu-act="remove-editor" data-key="${esc(k)}">Remove</button></li>`;
            }).join('') : '<li class="cu-hint">No editors yet.</li>';
        }, err => fail(err, 'editors'));
    }
    dialog.addEventListener('close', () => { unwatchEditors?.(); unwatchEditors = null; });

    // ---- actions
    document.addEventListener('click', async e => {
        const btn = e.target.closest('[data-cu-act]');
        if (!btn) return;
        const act = btn.dataset.cuAct;
        if (act === 'signin') signInDialog();
        else if (act === 'google') {
            db.signIn().then(() => { store.set(SIGNED_IN_FLAG, '1'); dialog.close(); })
                .catch(err => { if (!/popup-closed|cancelled-popup/.test(err?.code || '')) fail(err?.code === 'auth/popup-blocked' ? new Error('Your browser blocked the sign-in window. Allow pop-ups for this site and try again.') : err, 'sign in'); });
        } else if (act === 'signout') { store.set(SIGNED_IN_FLAG, null); db.signOut(); }
        else if (act === 'new') openEditor('');
        else if (act === 'edit') openEditor(btn.dataset.id);
        else if (act === 'status') statusDialog();
        else if (act === 'editors') editorsDialog();
        else if (act === 'name') nameDialog();
        else if (act === 'close') dialog.close();
        else if (act === 'delete') {
            const u = updates().find(x => x.id === btn.dataset.id);
            if (u && confirm(`Delete the update “${u.title}” and its notes? This cannot be undone. Files stay in Google Drive.`)) {
                db.set(`${pagePath}/updates/${u.id}`, null).then(() => db.set(`${teamPath}/${u.id}`, null).catch(() => {})).catch(err => fail(err, 'delete'));
            }
        } else if (act === 'open' || act === 'annotate') {
            openUpdate(btn.dataset.id, btn.dataset.m || '', act === 'annotate');
        } else if (act === 'remove-editor') {
            if (confirm(`Remove ${keyToEmail(btn.dataset.key)} as an editor?`)) db.set(`cases/editors/${btn.dataset.key}`, null).catch(err => fail(err, 'remove editor'));
        }
    });

    dialog.addEventListener('submit', async e => {
        const form = e.target.closest('form[data-cu-form]');
        if (!form) return;
        e.preventDefault();
        const f = Object.fromEntries(new FormData(form));
        const err = $('.cu-error', form);
        err.textContent = '';
        const submit = $('button[type=submit]', form);
        submit.disabled = true;
        try {
            if (form.dataset.cuForm === 'name') {
                const name = String(f.name || '').replace(/\s+/g, ' ').trim().slice(0, 40);
                if (!name) throw new Error('Type a name.');
                await db.set(`cases/people/${user.uid}`, { name, at: Date.now() });
                people = { ...people, [user.uid]: { name } };
                dialog.close();
                render();
                return;
            }
            if (form.dataset.cuForm === 'status') {
                const status = String(f.status || '').trim().slice(0, 140);
                await db.set(`${pagePath}/overview`, status ? { status, by: user.uid, byName: nameOf(user.uid, user.name).slice(0, 60), at: Date.now() } : null);
                dialog.close();
            } else if (form.dataset.cuForm === 'editor') {
                const email = String(f.email || '').trim().toLowerCase();
                if (!/^[^@\s,]+@[^@\s,]+\.[^@\s,]+$/.test(email)) throw new Error('Enter a full email address.');
                const picked = new FormData(form).getAll('animal');
                if (!picked.length) throw new Error('Pick at least one animal.');
                const entry = picked.includes('all') ? { all: true } : Object.fromEntries(picked.map(a => [a, true]));
                if (f.name?.trim()) entry.name = f.name.trim().slice(0, 60);
                await db.set(`cases/editors/${emailKey(email)}`, entry);
                form.reset();
                form.querySelector(`input[value="${CSS.escape(animal)}"]`).checked = true;
            }
        } catch (error) {
            fail(error, 'save');
        } finally {
            submit.disabled = false;
        }
    });

    // ---- start
    if (!document.querySelector('link[href^="update-studio.css"]')) document.head.insertAdjacentHTML('beforeend', '<link rel="stylesheet" href="update-studio.css?v=7"><link rel="stylesheet" href="update-editor.css?v=6">');
    [data, people] = await Promise.all([db.readPublic(animal).catch(() => ({})), db.readPath('cases/people').catch(() => ({}))]);
    render();
    if (location.hash === '#updates') goUpdates();
    // Links to one update (or one photo, video or model in it): #update/<id>[/<media id>].
    const openFromHash = () => {
        const deep = location.hash.match(/^#update\/([A-Za-z0-9_-]+)(?:\/([A-Za-z0-9_-]+))?(?:\/([A-Za-z0-9_-]+))?$/);
        if (deep && studio?.updateId !== deep[1]) { show('report'); openUpdate(deep[1], deep[2] || '', false, deep[3] || ''); }
    };
    window.addEventListener('hashchange', openFromHash);
    openFromHash();
    let authStarted = false;
    const startAuth = () => !authStarted && (authStarted = true) && db.onAuth((u, r, error) => {
        user = u; role = r;
        if (error) console.warn('Case updates: sign-in unavailable', error);
        unwatch?.(); unwatch = null;
        unwatchTeam?.(); unwatchTeam = null; teamData = {};
        unwatchPeople?.(); unwatchPeople = null;
        if (user && canEdit()) {
            unwatch = db.watch(pagePath, v => { data = v || {}; render(); }, err => console.warn('Case updates: live updates stopped', err));
            unwatchTeam = db.watch(teamPath, v => { teamData = v || {}; studio?.refresh(); }, err => console.warn('Case updates: team notes unavailable', err));
            unwatchPeople = db.watch('cases/people', v => { people = v || {}; render(); }, () => {});
        }
        if (!user) store.set(SIGNED_IN_FLAG, null);
        // Team-only links (the design log) show for signed-in editors only.
        document.documentElement.classList.toggle('is-team', !!(user && canEdit()));
        render();
    });
    // The SDK only loads for people who signed in on this browser before, or who open the sign-in dialog.
    if (db.kind === 'demo' || store.get(SIGNED_IN_FLAG)) startAuth();
    else document.addEventListener('click', e => { if (e.target.closest('[data-cu-act=signin]')) startAuth(); }, { capture: true });
}
