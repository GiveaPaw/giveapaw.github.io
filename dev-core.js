// Shared core of the developer hub pages (dev.html and the dev-*.html design options): helpers, the status
// vocabulary, the board store (Firebase devboard/, or this browser in demo mode), merging the snapshot with the
// live board, the owner checklist, and the live checks. The pages only draw.
import { content } from './dev-content.js?v=3';
import { pages } from './dev-pages.js?v=1';
import { modelUrl, modelBase } from './model-base.js?v=2';

export { content, pages };
export const REPO = 'GiveaPaw/giveapaw.github.io';
export const GH = `https://github.com/${REPO}`;
const FIREBASE_CDN = 'https://www.gstatic.com/firebasejs/10.14.1/';

// ---- helpers ----------------------------------------------------------------------------------------------
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const icon = (name, cls = '') => `<i data-lucide="${esc(name)}" aria-hidden="true"${cls ? ` class="${cls}"` : ''}></i>`;
export const icons = () => window.lucide?.createIcons({ attrs: { 'stroke-width': 1.9 } });
export const fmtDate = t => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
export const fmtWhen = t => {
    const s = (Date.now() - t) / 1000;
    if (s < 90) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    if (s < 86400 * 14) return `${Math.round(s / 86400)} days ago`;
    return fmtDate(t);
};
// Light formatting in notes: web links, `code` and line breaks.
export const rich = text => String(text ?? '').split('`').map((part, i) => i % 2
        ? `<code>${esc(part)}</code>`                               // `code` spans first, so links inside them stay plain text
        : esc(part)
            .replace(/https:\/\/[^\s<]+[^\s<.,;:)!?]/g, u => `<a href="${u}" target="_blank" rel="noopener">${u.replace(/^https:\/\//, '')}</a>`)
            .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')).join('')
    .replace(/\n/g, '<br>');
export const slugify = t => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

// ---- vocabulary ----------------------------------------------------------------------------------------------
export const STATUS = {
    'live': { label: 'Live', icon: 'globe', hint: 'On the public site and up to date' },
    'live-with-local-changes': { label: 'Live, update waiting', icon: 'upload-cloud', hint: 'Live, with a newer version on a computer that has not been published yet' },
    'local-only': { label: 'Not published', icon: 'laptop', hint: 'Only on a team computer so far' },
    'paused': { label: 'Paused', icon: 'pause-circle', hint: 'Work stopped on purpose; can be picked up again' },
    'private': { label: 'Private', icon: 'lock', hint: 'Kept off the public site on purpose' },
    'retired': { label: 'Retired', icon: 'archive', hint: 'Replaced or no longer used' },
};
export const HEALTH = {
    'good': { label: 'On track', icon: 'check-circle-2' },
    'needs-work': { label: 'Needs work', icon: 'alert-triangle' },
    'blocked': { label: 'Blocked', icon: 'octagon-alert' },
};

// ---- the board store ---------------------------------------------------------------------------------------------
// Both stores share one interface. Paths are relative to devboard/ ("projects/mesh-check", "checklist/github").
//   onAuth(cb) -> off, signIn(), signOut(), subscribe(cb, onError) -> off (cb gets the whole devboard tree),
//   set(path, value|null), push(path, value) -> key, plus setProject / setNotice / addHistory / setCheck shortcuts.
export function demoStore({ key = 'gap-devboard-demo', seed = null, user = { uid: 'demo-user', name: 'You (demo)', email: '' } } = {}) {
    const subs = new Set();
    const load = () => {
        try { const raw = localStorage.getItem(key); if (raw) return JSON.parse(raw); } catch { /* blocked */ }
        return seed ? structuredClone(seed) : {};
    };
    const save = tree => { try { localStorage.setItem(key, JSON.stringify(tree)); } catch { /* storage blocked */ } subs.forEach(cb => cb(tree)); };
    window.addEventListener('storage', e => { if (e.key === key) subs.forEach(cb => cb(load())); });
    const setAt = (tree, path, value) => {
        const parts = path.split('/').filter(Boolean);
        let node = tree;
        parts.slice(0, -1).forEach(p => { node[p] = node[p] && typeof node[p] === 'object' ? node[p] : {}; node = node[p]; });
        if (value == null) delete node[parts.at(-1)]; else node[parts.at(-1)] = structuredClone(value);
        return tree;
    };
    let n = 0;
    const api = {
        kind: 'demo',
        onAuth(cb) { cb({ ready: true, user, member: true, error: '' }); return () => {}; },
        signIn: async () => {}, signOut: async () => {},
        subscribe(cb) { subs.add(cb); cb(load()); return () => subs.delete(cb); },
        async set(path, value) { save(setAt(load(), path, value)); },
        async push(path, value) { const k = `d${Date.now().toString(36)}${(n++).toString(36)}`; save(setAt(load(), `${path}/${k}`, value)); return k; },
        reset() { try { localStorage.removeItem(key); } catch { /* blocked */ } subs.forEach(cb => cb(load())); },
    };
    return withShortcuts(api);
}
let sdkPromise = null;
export function loadSdk() {
    sdkPromise ||= Promise.all([
        import(FIREBASE_CDN + 'firebase-app.js'), import(FIREBASE_CDN + 'firebase-auth.js'), import(FIREBASE_CDN + 'firebase-database.js'),
        import(new URL('firebase-config.js?v=1', document.baseURI).href),
    ]).then(([app, auth, db, cfg]) => {
        if (!cfg.firebaseConfig?.databaseURL) throw new Error('firebase-config.js has no databaseURL.');
        const fbApp = app.getApps().find(a => a.name === 'devboard') || app.initializeApp(cfg.firebaseConfig, 'devboard');
        return { auth, db, a: auth.getAuth(fbApp), d: db.getDatabase(fbApp), url: cfg.firebaseConfig.databaseURL };
    });
    sdkPromise.catch(() => { sdkPromise = null; });
    return sdkPromise;
}
export function cloudStore() {
    let sdk = null;
    let state = { ready: false, user: null, member: false, error: '' };
    const authSubs = new Set();
    const emit = () => authSubs.forEach(cb => cb(state));
    const ready = loadSdk().then(s => {
        sdk = s;
        s.auth.onAuthStateChanged(s.a, async user => {
            let member = false, error = '';
            if (user) {
                try { member = (await s.db.get(s.db.ref(s.d, 'designlog/team/' + user.uid))).val() === true; }
                catch (e) { error = 'Could not check the team list (' + (e.code || e.message) + ').'; }
            }
            state = { ready: true, member, error, user: user ? { uid: user.uid, name: (user.displayName || user.email || 'Team member').slice(0, 60), email: user.email || '', photo: user.photoURL || '' } : null };
            emit();
        });
        return s;
    }).catch(err => { state = { ready: true, user: null, member: false, error: 'Could not reach sign-in (' + (err?.message || err) + ').' }; emit(); throw err; });
    const ref = path => sdk.db.ref(sdk.d, 'devboard/' + path);
    const api = {
        kind: 'cloud',
        onAuth(cb) { authSubs.add(cb); cb(state); return () => authSubs.delete(cb); },
        // Called straight from the click (no await before the popup), or Safari blocks the window.
        signIn() {
            if (!sdk) return Promise.reject(new Error('Sign-in is still loading. Try again in a moment.'));
            const provider = new sdk.auth.GoogleAuthProvider();
            provider.setCustomParameters({ prompt: 'select_account' });
            return sdk.auth.signInWithPopup(sdk.a, provider);
        },
        signOut() { return sdk ? sdk.auth.signOut(sdk.a) : Promise.resolve(); },
        subscribe(cb, onError) {
            let off = () => {};
            ready.then(s => { off = s.db.onValue(s.db.ref(s.d, 'devboard'), snap => cb(snap.val() || {}), err => onError?.(err)); }).catch(err => onError?.(err));
            return () => off();
        },
        set: (path, value) => sdk.db.set(ref(path), value ?? null),
        async push(path, value) { const r = sdk.db.push(ref(path)); await sdk.db.set(r, value); return r.key; },
    };
    return withShortcuts(api);
}
function withShortcuts(api) {
    return Object.assign(api, {
        setProject: (id, data) => api.set('projects/' + id, data),
        setNotice: data => api.set('notice', data),
        addHistory: entry => api.push('history', entry),
        setCheck: (id, data) => api.set('checklist/' + id, data),
    });
}
export const saveError = e => /PERMISSION_DENIED|permission/i.test(e?.code || e?.message || '')
    ? 'Not saved: this account can’t change the board (team list or database rules).' : 'Not saved: ' + (e?.message || e);

// ---- the snapshot with the live board on top ----------------------------------------------------------------------
const lines = text => String(text || '').split('\n').map(x => x.trim()).filter(Boolean);
export function mergedProjects(board = {}) {
    const over = board.projects || {};
    const base = content.projects.map(p => {
        const o = over[p.id];
        if (!o) return { ...p, live: null };
        return { ...p, status: o.status || p.status, health: o.health || p.health, progress: o.progress ?? p.progress,
            next: o.next != null ? lines(o.next) : p.next, live: o };
    });
    const custom = Object.entries(over).filter(([id, o]) => o.custom && !content.projects.some(p => p.id === id)).map(([id, o]) => ({
        id, area: o.area || 'Other', name: o.name || id, pages: (o.pages || '').split(/[\s,]+/).filter(Boolean), status: o.status, health: o.health,
        progress: o.progress ?? 0, summary: o.summary || '', howItWorks: '', notes: [], next: lines(o.next), owner_actions: [], lastLive: null, live: o, custom: true,
    }));
    return [...base, ...custom];
}
// The owner's handoff checklist: steps from the snapshot, ticks and "who holds it" from the board.
export function checklist(board = {}) {
    const ticks = board.checklist || {};
    return content.ownerChecklist.map(item => ({ ...item, state: ticks[item.id] || null, done: !!ticks[item.id]?.done }));
}
export const pageInfo = file => pages.find(p => p.file === file) || null;

// ---- live checks ------------------------------------------------------------------------------------------------------
export const CHECKS = [
    ['pages', 'Every public page loads', 'Each page in the page list, fetched from this site.'],
    ['models', '3D model bucket (Cloudflare R2)', 'A sample model fetched from the bucket the sliders and walkthrough use.'],
    ['database', 'Live database (Firebase)', 'Live sessions, the design log, anatomy edits and this board.'],
    ['github', 'GitHub (latest published change)', 'The repository the site is published from.'],
    ['google', 'Google sign-in and Drive settings', 'drive-config.js and firebase-config.js have what sign-in and the Drive picker need.'],
    ['libraries', 'Outside libraries', 'three.js (3D), the Firebase SDK, Lucide icons and the Draco decoder, all loaded from CDNs.'],
];
async function headOk(url) {
    try { const r = await fetch(url, { method: 'HEAD', cache: 'no-store' }); return { ok: r.ok, code: r.status }; }
    catch { return { ok: false, code: 'network' }; }
}
async function reachable(url) {
    try { const r = await fetch(url, { method: 'HEAD', cache: 'no-store' }); return r.ok || r.type === 'opaque'; }
    catch { try { await fetch(url, { mode: 'no-cors', cache: 'no-store' }); return true; } catch { return false; } }
}
export async function loadCommits(n = 12) {
    const r = await fetch(`https://api.github.com/repos/${REPO}/commits?per_page=${n}`, { headers: { Accept: 'application/vnd.github+json' } });
    if (!r.ok) throw new Error(r.status === 403 ? 'GitHub rate limit; try again in an hour' : 'GitHub answered ' + r.status);
    return (await r.json()).map(c => ({ sha: c.sha, msg: c.commit.message.split('\n')[0], at: Date.parse(c.commit.author.date), who: c.commit.author.name }));
}
/**
 * Run every check. `onChange(results)` is called as results arrive; results = { checks: {key: {state, text, ms}},
 * pageChecks: {file: {state, code}}, commits: [..] | null, commitsError, checkedAt }. state: run | ok | warn | bad | skip.
 */
export async function runChecks(onChange = () => {}) {
    const R = { checks: { local: { state: 'skip', text: 'Runs on a team computer, so it is not checked from here.' } }, pageChecks: {}, commits: null, commitsError: '', checkedAt: 0 };
    const emit = () => onChange(R);
    const timed = async (key, fn) => {
        const t0 = performance.now();
        try { R.checks[key] = { ...(await fn()), ms: Math.round(performance.now() - t0) }; }
        catch (e) { R.checks[key] = { state: 'bad', text: 'The check itself failed (' + (e?.message || e) + ').', ms: Math.round(performance.now() - t0) }; }
        emit();
    };
    emit();
    await Promise.allSettled([
        timed('pages', async () => {
            const queue = [...pages];
            await Promise.all(Array.from({ length: 6 }, async () => {
                while (queue.length) {
                    const p = queue.shift();
                    const r = await headOk(p.file);
                    R.pageChecks[p.file] = { state: r.ok ? 'ok' : 'bad', code: r.code };
                    emit();
                }
            }));
            const bad = Object.values(R.pageChecks).filter(c => c.state === 'bad').length;
            return { state: bad ? 'bad' : 'ok', text: bad ? `${bad} of ${pages.length} pages did not load.` : `All ${pages.length} pages load.` };
        }),
        timed('models', async () => {
            if (!modelBase) return { state: 'warn', text: 'model-base.js has no bucket set, so models are served from the site itself.' };
            const r = await headOk(modelUrl(content.modelProbe));
            return r.ok ? { state: 'ok', text: `The bucket answers (${new URL(modelBase).host}).` }
                : { state: 'bad', text: `The bucket did not answer (${r.code}). Sliders fall back to copies on the site where there are any.` };
        }),
        timed('database', async () => {
            const sdk = await loadSdk();
            try { await sdk.db.get(sdk.db.ref(sdk.d, 'devboard/notice')); return { state: 'ok', text: 'The database answers, and the board can be read.' }; }
            catch (e) {
                if (/permission/i.test(e?.code || e?.message || '')) return { state: 'warn', text: 'The database answers, but the rules for the board are not published yet.' };
                return { state: 'bad', text: 'The database did not answer (' + (e?.message || e) + ').' };
            }
        }),
        timed('github', async () => {
            try {
                R.commits = await loadCommits();
                const last = R.commits[0];
                return { state: 'ok', text: `Last published ${fmtWhen(last.at)}: “${last.msg}”.` };
            } catch (e) { R.commitsError = e.message; return { state: 'warn', text: 'Could not read the latest changes (' + e.message + ').' }; }
        }),
        timed('google', async () => {
            const [drive, fb] = await Promise.all([import('./drive-config.js?v=1').catch(() => ({})), import(new URL('firebase-config.js?v=1', document.baseURI).href).catch(() => ({}))]);
            const d = drive.driveConfig || {}, f = fb.firebaseConfig || {};
            const missing = [!d.apiKey && 'Drive API key', !d.clientId && 'Google client ID', !f.authDomain && 'Firebase auth domain'].filter(Boolean);
            return missing.length ? { state: 'bad', text: 'Missing: ' + missing.join(', ') + '.' } : { state: 'ok', text: 'Both files have their settings. (Whether Google accepts them shows only when someone signs in.)' };
        }),
        timed('libraries', async () => {
            const res = await Promise.all(content.libraries.map(l => reachable(l.url)));
            const down = content.libraries.filter((_, i) => !res[i]).map(l => l.name);
            return down.length ? { state: 'bad', text: 'Not reachable: ' + down.join(', ') + '.' } : { state: 'ok', text: `All ${content.libraries.length} answer.` };
        }),
    ]);
    R.checkedAt = Date.now();
    emit();
    return R;
}
export const CHECK_LABEL = { run: ['loader', 'Checking…'], ok: ['check-circle-2', 'Working'], warn: ['alert-triangle', 'Partly working'], bad: ['x-circle', 'Not working'], skip: ['minus-circle', 'Not checked'] };
