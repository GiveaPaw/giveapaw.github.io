// Storage for the design log (design-log.html).
//
// Both stores hold one tree per animal and expose the same calls, so the page
// does not care where the data lives:
//   subscribe(animal, cb)  cb(tree) now and after every change; returns unsubscribe
//   set(animal, path, value)   value null deletes; path is an array of keys
//   update(animal, path, obj)  shallow merge
//   newKey()
//
// Cloud store: Firebase Realtime Database `designlog/logs/<animal>`, readable and
// writable only by Google accounts listed under `designlog/team/<uid>` (see
// DESIGN-LOG-SETUP.md and database.rules.json).
// Demo store: localStorage in this browser, synced between its tabs.

const FIREBASE_CDN = 'https://www.gstatic.com/firebasejs/10.14.1/';
const DEMO_PREFIX = 'gap-designlog-v2:';

export function getAt(tree, path) {
    let node = tree;
    for (const k of path) { if (node == null) return undefined; node = node[k]; }
    return node;
}

// Set a value inside a plain object tree. Null deletes and prunes empty parents,
// the way the Realtime Database stores nothing for empty objects.
export function setAt(tree, path, value) {
    if (!path.length) return value ?? {};
    const parents = [];
    let node = tree;
    for (const k of path.slice(0, -1)) {
        if (node[k] == null || typeof node[k] !== 'object') node[k] = {};
        parents.push([node, k]);
        node = node[k];
    }
    const last = path.at(-1);
    if (value == null) delete node[last]; else node[last] = clean(value);
    for (let i = parents.length - 1; i >= 0; i--) {
        const [p, k] = parents[i];
        if (p[k] && typeof p[k] === 'object' && !Object.keys(p[k]).length) delete p[k];
    }
    return tree;
}

// Drop undefined and nulls, like the database does.
function clean(v) {
    if (Array.isArray(v)) return v.map(clean);
    if (v && typeof v === 'object') {
        const out = {};
        for (const [k, x] of Object.entries(v)) if (x != null) out[k] = clean(x);
        return out;
    }
    return v;
}

const randomKey = () => Date.now().toString(36) + '-' + crypto.getRandomValues(new Uint32Array(1))[0].toString(36);

// ------------------------------------------------------------------ demo store
export function createDemoStore({ seedFor }) {
    let uid;
    try {
        uid = localStorage.getItem('gap-designlog-demo-uid');
        if (!uid) { uid = 'demo-' + randomKey(); localStorage.setItem('gap-designlog-demo-uid', uid); }
    } catch { uid = 'demo-' + randomKey(); }
    let name = 'Tyler';
    try { name = localStorage.getItem('gap-designlog-me') || name; } catch {}

    const trees = new Map();
    const subs = new Map(); // animal -> Set(cb)
    const channel = 'BroadcastChannel' in window ? new BroadcastChannel('gap-designlog-v2') : null;
    channel?.addEventListener('message', e => {
        const { animal, tree } = e.data || {};
        if (!animal) return;
        trees.set(animal, tree);
        subs.get(animal)?.forEach(cb => cb(tree));
    });

    function load(animal) {
        if (trees.has(animal)) return trees.get(animal);
        let tree = null;
        try { tree = JSON.parse(localStorage.getItem(DEMO_PREFIX + animal)); } catch {}
        if (!tree) tree = seedFor(animal) || {};
        trees.set(animal, tree);
        return tree;
    }
    function save(animal, tree) {
        trees.set(animal, tree);
        try { localStorage.setItem(DEMO_PREFIX + animal, JSON.stringify(tree)); } catch { /* private window: memory only */ }
        channel?.postMessage({ animal, tree });
        subs.get(animal)?.forEach(cb => cb(tree));
    }

    return {
        kind: 'demo',
        get user() { return { uid, name }; },
        setName(n) { name = n.trim().slice(0, 60) || 'Someone'; try { localStorage.setItem('gap-designlog-me', name); } catch {} },
        subscribe(animal, cb) {
            if (!subs.has(animal)) subs.set(animal, new Set());
            subs.get(animal).add(cb);
            cb(load(animal));
            return () => subs.get(animal)?.delete(cb);
        },
        async set(animal, path, value) { save(animal, setAt(structuredClone(load(animal)), path, value)); },
        async update(animal, path, obj) {
            let tree = structuredClone(load(animal));
            for (const [k, v] of Object.entries(obj)) tree = setAt(tree, [...path, k], v);
            save(animal, tree);
        },
        newKey: randomKey,
        reset(animal) { try { localStorage.removeItem(DEMO_PREFIX + animal); } catch {} trees.delete(animal); save(animal, load(animal)); },
        onConnection(cb) { cb(true); return () => {}; },
    };
}

// ----------------------------------------------------------------- cloud store
let sdkPromise = null;
function loadSdk() {
    sdkPromise ||= Promise.all([
        import(FIREBASE_CDN + 'firebase-app.js'),
        import(FIREBASE_CDN + 'firebase-auth.js'),
        import(FIREBASE_CDN + 'firebase-database.js'),
        import(new URL('firebase-config.js?v=1', document.baseURI).href),
    ]).then(([app, auth, db, cfg]) => {
        if (!cfg.firebaseConfig?.databaseURL) throw new Error('firebase-config.js has no databaseURL.');
        const fbApp = app.getApps().find(a => a.name === 'designlog') || app.initializeApp(cfg.firebaseConfig, 'designlog');
        return { auth, db, a: auth.getAuth(fbApp), d: db.getDatabase(fbApp) };
    });
    sdkPromise.catch(() => { sdkPromise = null; });
    return sdkPromise;
}

export function createCloudStore() {
    let sdk = null;
    let state = { ready: false, user: null, member: false, error: '' };
    const authSubs = new Set();
    const emit = () => authSubs.forEach(cb => cb(state));
    const base = animal => 'designlog/logs/' + animal;
    const pathOf = (animal, path) => [base(animal), ...path].join('/');

    loadSdk().then(s => {
        sdk = s;
        s.auth.onAuthStateChanged(s.a, async user => {
            let member = false, error = '';
            if (user) {
                try { member = (await s.db.get(s.db.ref(s.d, 'designlog/team/' + user.uid))).val() === true; }
                catch (e) { error = 'Could not check team access (' + (e.code || e.message) + ').'; }
            }
            state = {
                ready: true, member, error,
                user: user ? { uid: user.uid, name: (user.displayName || user.email || 'Team member').slice(0, 60), email: user.email || '', photo: user.photoURL || '' } : null,
            };
            emit();
        });
    }).catch(err => {
        state = { ready: true, user: null, member: false, error: 'Could not reach the sign-in service (' + (err?.message || err) + ').' };
        emit();
    });

    return {
        kind: 'cloud',
        get user() { return state.user; },
        onAuth(cb) { authSubs.add(cb); cb(state); return () => authSubs.delete(cb); },
        // Called straight from a click with no await before the popup, or Safari blocks it.
        signIn() {
            if (!sdk) return Promise.reject(new Error('Sign-in is still loading. Try again in a moment.'));
            const provider = new sdk.auth.GoogleAuthProvider();
            provider.setCustomParameters({ prompt: 'select_account' });
            return sdk.auth.signInWithPopup(sdk.a, provider);
        },
        signOut() { return sdk ? sdk.auth.signOut(sdk.a) : Promise.resolve(); },
        subscribe(animal, cb, onError) {
            const r = sdk.db.ref(sdk.d, base(animal));
            return sdk.db.onValue(r, snap => cb(snap.val() || {}), err => onError?.(err));
        },
        set(animal, path, value) { return sdk.db.set(sdk.db.ref(sdk.d, pathOf(animal, path)), value == null ? null : clean(value)); },
        update(animal, path, obj) { return sdk.db.update(sdk.db.ref(sdk.d, pathOf(animal, path)), clean(obj)); },
        newKey() { return sdk ? sdk.db.push(sdk.db.ref(sdk.d, 'designlog/keys')).key : randomKey(); },
        onConnection(cb) {
            if (!sdk) { cb(false); return () => {}; }
            return sdk.db.onValue(sdk.db.ref(sdk.d, '.info/connected'), snap => cb(snap.val() === true));
        },
    };
}
