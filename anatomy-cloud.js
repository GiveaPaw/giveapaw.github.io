// Cloud copy of the anatomy quiz labelling (Firebase Realtime Database).
//
// Reading is public and needs no SDK: every quiz page fetches
//   anatomy/pages/<page>  ->  { json, savedAt, by }
// over REST and, when that copy is newer than the page's quiz-data-*.js,
// plays the quiz from it. Writing needs Google sign-in with an account
// listed under anatomy/editors/<uid> (see ANATOMY-CLOUD-SETUP.md); the
// Firebase SDK is only downloaded by the ?dev=1 editor and the hub.
//
// `json` is a string so item names never have to be valid database keys:
//   { v: 1, quizzes: { <set>: { items: [...], refPoints: {name: [x, y]} } },
//     descriptions: {name: text}, deleted: { <set>: [names] } }
window.AnatomyCloud = (() => {
    'use strict';
    const DB = 'https://give-a-paw-default-rtdb.firebaseio.com';
    const CDN = 'https://www.gstatic.com/firebasejs/10.14.1/';
    const isParked = it => !(it.points && it.points.length >= 3) && it.x === 4;

    // Page id from the file name: hand-anatomy-quiz.html -> hand-anatomy-quiz
    const pageId = path => ((path || location.pathname).split('/').pop() || 'index')
        .replace(/\.html?$/, '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 64);

    // ---------------------------------------------------------- reading
    async function fetchPage(id, timeoutMs) {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), timeoutMs || 5000);
        try {
            const res = await fetch(DB + '/anatomy/pages/' + encodeURIComponent(id) + '.json', { signal: ctl.signal, cache: 'no-store' });
            if (!res.ok) return null;
            const rec = await res.json();
            if (!rec || typeof rec.json !== 'string') return null;
            return { savedAt: rec.savedAt || 0, by: rec.by || '', data: JSON.parse(rec.json) };
        } catch (e) {
            return null;
        } finally {
            clearTimeout(timer);
        }
    }

    // Put a cloud copy into a QUIZ_CONFIG in place. Items the data file has
    // but the cloud copy lacks (names added to the manifest after the last
    // cloud save) are kept as unplaced items unless they were deleted or
    // renamed in the editor.
    function applyTo(config, rec) {
        const d = rec && rec.data;
        if (!d || !d.quizzes) return false;
        Object.keys(d.quizzes).forEach(key => {
            const cfg = config.quizzes[key], src = d.quizzes[key];
            if (!cfg || !src || !Array.isArray(src.items)) return;
            const have = new Set(src.items.map(it => it.name));
            const gone = new Set((d.deleted && d.deleted[key]) || []);
            const extra = cfg.items.filter(it => !have.has(it.name) && !gone.has(it.name));
            let y = 4 + 4 * src.items.filter(isParked).length;
            extra.forEach(it => {
                const c = { name: it.name, x: 4, y: Math.min(96, y) };
                y += 4;
                src.items.push(isParked(it) ? c : it);
            });
            cfg.items.length = 0;
            src.items.forEach(it => cfg.items.push(it));
            if (src.refPoints && cfg.reference) cfg.reference.points = src.refPoints;
        });
        if (d.descriptions) config.descriptions = d.descriptions;
        config.deleted = d.deleted || {};
        return true;
    }

    // Engine/hub entry: load the cloud copy for a page and apply it when it
    // is newer than the data file. Records what it found on config.cloud.
    async function syncConfig(config, path, timeoutMs) {
        const rec = await fetchPage(pageId(path), timeoutMs);
        const fileAt = config.savedAt || 0;
        const applied = !!rec && rec.savedAt > fileAt && applyTo(config, rec);
        config.cloud = { savedAt: rec ? rec.savedAt : null, applied: applied };
        return config.cloud;
    }

    // --------------------------------------------------------- the SDK
    let sdkPromise = null, loaded = null;
    function sdk() {
        if (!sdkPromise) {
            sdkPromise = Promise.all([
                import(CDN + 'firebase-app.js'),
                import(CDN + 'firebase-auth.js'),
                import(CDN + 'firebase-database.js'),
                import(new URL('firebase-config.js?v=1', document.baseURI).href),
            ]).then(([app, auth, db, cfg]) => {
                const fbApp = app.getApps().find(a => a.name === 'anatomy') || app.initializeApp(cfg.firebaseConfig, 'anatomy');
                // Default persistence (IndexedDB): stay signed in on this device.
                const a = auth.getAuth(fbApp);
                loaded = { auth, db, a, d: db.getDatabase(fbApp) };
                return loaded;
            });
            sdkPromise.catch(() => { sdkPromise = null; });
        }
        return sdkPromise;
    }

    let current = { user: null, editor: false, ready: false };
    const listeners = new Set();
    let watching = false;
    function emit() { listeners.forEach(cb => { try { cb(current); } catch (e) { console.error(e); } }); }

    // cb({user, editor, ready}); fires now and on every change.
    function onUser(cb) {
        listeners.add(cb);
        cb(current);
        if (!watching) {
            watching = true;
            sdk().then(s => {
                s.auth.onAuthStateChanged(s.a, async user => {
                    let editor = false;
                    if (user) {
                        try {
                            const snap = await s.db.get(s.db.ref(s.d, 'anatomy/editors/' + user.uid));
                            editor = snap.val() === true;
                        } catch (e) { editor = false; }
                    }
                    current = { user: user ? { uid: user.uid, name: user.displayName || user.email || 'Signed in', email: user.email || '' } : null, editor, ready: true };
                    emit();
                });
            }).catch(err => {
                current = { user: null, editor: false, ready: true, error: 'Could not reach the sign-in service (' + (err && err.message || err) + ').' };
                emit();
            });
        }
        return () => listeners.delete(cb);
    }

    // Must run inside the click handler with no await before the popup, or
    // Safari blocks it; so the SDK is warmed up by onUser() beforehand.
    function signIn() {
        const s = loaded;
        if (!s) { sdk(); return Promise.reject(new Error('Sign-in is still loading. Try again in a moment.')); }
        const provider = new s.auth.GoogleAuthProvider();
        provider.setCustomParameters({ prompt: 'select_account' });
        return s.auth.signInWithPopup(s.a, provider);
    }
    function signOut() { return sdk().then(s => s.auth.signOut(s.a)); }

    // Save a page. `baseAt` is the cloud savedAt this copy was built on; the
    // write is refused (resolves {conflict}) if someone saved since then.
    async function save(id, data, baseAt) {
        const s = await sdk();
        const user = s.a.currentUser;
        if (!user) throw new Error('Not signed in.');
        const ref = s.db.ref(s.d, 'anatomy/pages/' + id);
        const json = JSON.stringify(Object.assign({ v: 1 }, data));
        const at = Date.now();
        let prev = null, conflict = null;
        const res = await s.db.runTransaction(ref, cur => {
            prev = cur;
            if (cur && (cur.savedAt || null) !== (baseAt || null)) { conflict = cur; return; }
            return { json: json, savedAt: at, by: user.uid };
        }, { applyLocally: false });
        if (!res.committed) return { conflict: conflict ? { savedAt: conflict.savedAt } : { savedAt: null } };
        // One restore point per page per day: the copy as it was before
        // that day's first save. Already-taken days are refused by the rules.
        if (prev && prev.json) {
            const day = new Date(at).toISOString().slice(0, 10);
            s.db.set(s.db.ref(s.d, 'anatomy/backups/' + id + '/' + day), { json: prev.json, savedAt: prev.savedAt || 0 }).catch(() => {});
        }
        return { savedAt: at };
    }

    // cb(savedAt) whenever the page's cloud copy changes (any device).
    function watch(id, cb) {
        let off = () => {};
        sdk().then(s => { off = s.db.onValue(s.db.ref(s.d, 'anatomy/pages/' + id + '/savedAt'), snap => cb(snap.val())); }).catch(() => {});
        return () => off();
    }

    // Testing only: pretend a sign-in state, e.g. _setUser({ user: {...}, editor: true, ready: true }).
    const _setUser = state => { current = state; emit(); };

    return { pageId, fetchPage, applyTo, syncConfig, onUser, signIn, signOut, save, watch, _setUser };
})();
