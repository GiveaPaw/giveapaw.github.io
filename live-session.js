import { firebaseConfig } from './firebase-config.js?v=1';

// Live review sessions: one presenter, any number of followers. The presenter's current question,
// camera, slider value, section cut, layer visibility, and video position are broadcast; everyone can
// point (laser dot with name) and draw highlight strokes that fade; followers can raise a hand and
// leave/return to the presenter's view; everyone's notes are mirrored so the presenter can merge them.
//
// Transport: Firebase Realtime Database when firebase-config.js is filled in, otherwise a same-browser
// demo transport (BroadcastChannel + localStorage) so the feature can be tried across tabs.

const FIREBASE_CDN = 'https://www.gstatic.com/firebasejs/10.14.1/';

function el(tag, className, html) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (html !== undefined) node.innerHTML = html;
    return node;
}
const icon = name => `<i data-lucide="${String(name).replace(/[^a-z0-9-]/g, '')}" aria-hidden="true"></i>`;
function refreshIcons() { window.lucide?.createIcons({ attrs: { 'stroke-width': 1.8 } }); }
function escapeHTML(text) { return String(text ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function throttle(fn, ms) {
    let last = 0, timer = null, args = null;
    return (...next) => {
        args = next;
        const run = () => { last = Date.now(); timer = null; fn(...args); };
        const wait = ms - (Date.now() - last);
        if (wait <= 0) run();
        else if (!timer) timer = setTimeout(run, wait);
    };
}
const sanitize = value => JSON.parse(JSON.stringify(value ?? null));
const COLORS = ['#ff3fa4', '#2d9bf0', '#35c95d', '#ffb020', '#a259ff', '#ff5364', '#00b8a9'];
function colorFor(uid) { let h = 0; for (const c of String(uid)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return COLORS[h % COLORS.length]; }
// Codes are the only thing that lets someone into a session, so they are random and long enough
// (32^6, about a billion) that nobody can guess one. Look-alike characters (0/O, 1/I) are left out.
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const makeCode = () => 'PAW-' + [...crypto.getRandomValues(new Uint8Array(6))].map(b => CODE_CHARS[b % 32]).join('');
const CODE_PATTERN = /^PAW-[A-Z0-9]{4,12}$/;
const MAX_NAME = 60;
const cleanName = name => String(name || '').trim().slice(0, MAX_NAME);
const uid = () => Math.random().toString(36).slice(2, 9);

// ---- transports --------------------------------------------------------------------------------

class LocalTransport {
    async connect({ code }) {
        this.code = code;
        this.key = 'gap-live:' + code;
        this.listeners = [];
        this.cleanup = [];
        this.uid = 'local-' + uid();
        this.channel = new BroadcastChannel(this.key);
        this.channel.onmessage = () => this.notify();
        this.tree = this.read();
        this.onPageHide = () => this.disconnect();
        addEventListener('pagehide', this.onPageHide);
        return { uid: this.uid };
    }
    read() { try { return JSON.parse(localStorage.getItem(this.key)) || {}; } catch { return {}; } }
    write() { try { localStorage.setItem(this.key, JSON.stringify(this.tree)); } catch { /* full */ } }
    at(path) { return path.split('/').filter(Boolean).reduce((node, key) => (node == null ? undefined : node[key]), this.tree); }
    setAt(path, value) {
        const parts = path.split('/').filter(Boolean);
        let node = this.tree;
        for (let i = 0; i < parts.length - 1; i++) {
            if (typeof node[parts[i]] !== 'object' || node[parts[i]] === null) node[parts[i]] = {};
            node = node[parts[i]];
        }
        if (value === null || value === undefined) delete node[parts[parts.length - 1]];
        else node[parts[parts.length - 1]] = value;
    }
    commit(apply) {
        this.tree = this.read();
        apply();
        this.write();
        this.channel.postMessage('changed');
        this.notify();
    }
    set(path, value) { this.commit(() => this.setAt(path, sanitize(value))); }
    update(path, value) { this.commit(() => Object.entries(value).forEach(([k, v]) => this.setAt(path + '/' + k, sanitize(v)))); }
    remove(path) { this.commit(() => this.setAt(path, null)); }
    push(path, value) { const id = 'k' + Date.now().toString(36) + uid(); this.set(path + '/' + id, value); return id; }
    onValue(path, cb) {
        const listener = { path, cb, last: undefined };
        this.listeners.push(listener);
        this.fire(listener);
        return () => { this.listeners = this.listeners.filter(l => l !== listener); };
    }
    fire(listener) {
        const value = this.at(listener.path) ?? null;
        const json = JSON.stringify(value);
        if (json !== listener.last) { listener.last = json; listener.cb(value); }
    }
    notify() { this.tree = this.read(); this.listeners.slice().forEach(l => this.fire(l)); }
    onDisconnectRemove(path) { this.cleanup.push(path); }
    disconnect() {
        if (!this.channel) return;
        this.tree = this.read();
        this.cleanup.forEach(path => this.setAt(path, null));
        this.write();
        this.channel.postMessage('changed');
        this.channel.close();
        this.channel = null;
        this.listeners = [];
        removeEventListener('pagehide', this.onPageHide);
    }
}

class FirebaseTransport {
    async connect({ code }) {
        const [appModule, dbModule, authModule] = await Promise.all([
            import(FIREBASE_CDN + 'firebase-app.js'),
            import(FIREBASE_CDN + 'firebase-database.js'),
            import(FIREBASE_CDN + 'firebase-auth.js'),
        ]);
        this.fns = dbModule;
        this.app = appModule.getApps()[0] || appModule.initializeApp(firebaseConfig);
        this.db = dbModule.getDatabase(this.app);
        // Per-tab identity (sessionStorage): two tabs of one browser become two people, and a page
        // reload keeps the same person, so a presenter who refreshes stays the presenter.
        const auth = authModule.initializeAuth(this.app, { persistence: authModule.browserSessionPersistence });
        const credential = await authModule.signInAnonymously(auth);
        this.uid = credential.user.uid;
        this.code = code;
        this.unsubs = [];
        return { uid: this.uid };
    }
    ref(path) { return this.fns.ref(this.db, `sessions/${this.code}/${path}`.replace(/\/+$/, '')); }
    set(path, value) { return this.fns.set(this.ref(path), sanitize(value)); }
    update(path, value) { return this.fns.update(this.ref(path), sanitize(value)); }
    remove(path) { return this.fns.remove(this.ref(path)); }
    push(path, value) { const node = this.fns.push(this.ref(path)); this.fns.set(node, sanitize(value)); return node.key; }
    onValue(path, cb) { const off = this.fns.onValue(this.ref(path), snapshot => cb(snapshot.val())); this.unsubs.push(off); return off; }
    onDisconnectRemove(path) { this.fns.onDisconnect(this.ref(path)).remove(); }
    // Fires after a dropped connection comes back (not on the first connect).
    onReconnect(cb) {
        let seen = false;
        this.unsubs.push(this.fns.onValue(this.fns.ref(this.db, '.info/connected'), snapshot => {
            if (snapshot.val() !== true) return;
            if (seen) cb();
            seen = true;
        }));
    }
    disconnect() { this.unsubs.forEach(off => off()); this.unsubs = []; }
}

// ---- session -----------------------------------------------------------------------------------

export function createLiveSession({ entries, layout, store, button, toast, getName, getReviewId, getReviewTitle, autoJoinCode, autoPresent = false, policy = null, tools = [], onPolicy = () => {}, downloadHostFile = null }) {
    const configured = !!firebaseConfig.databaseURL;
    const S = {
        transport: null, code: null, uid: null, name: '', role: null, following: true, meta: null, shareCamera: true,
        members: {}, pointers: {}, strokes: {}, notes: {}, remoteState: null, highlight: false, locked: false, unsubs: [], loopId: 0, lastSummon: undefined,
    };
    let applyingRemote = false;
    const attached = new Map();

    // UI shells ---------------------------------------------------------------------------------
    const panel = el('div', 'rv-live-panel');
    panel.hidden = true;
    const returnBtn = el('button', 'rv-live-return', `${icon('locate-fixed')} Return to presenter`);
    returnBtn.type = 'button';
    returnBtn.hidden = true;
    const hint = el('div', 'rv-live-hint', `${icon('highlighter')} Highlight mode: draw on the model or video for everyone. Press <kbd>Esc</kbd> to stop.`);
    hint.hidden = true;
    document.body.append(panel, returnBtn, hint);
    button.addEventListener('click', () => { panel.hidden = !panel.hidden; if (!panel.hidden) render(); });
    document.addEventListener('pointerdown', event => { if (!panel.hidden && !panel.contains(event.target) && !button.contains(event.target)) panel.hidden = true; });
    document.addEventListener('keydown', event => { if (event.key === 'Escape' && S.highlight) setHighlight(false); });
    returnBtn.addEventListener('click', () => setFollowing(true));

    function others() { return Object.entries(S.members).filter(([id]) => id !== S.uid); }
    function leaderName() { return S.meta?.leaderName || 'the presenter'; }
    function leaderOnline() { return !!(S.meta && S.members[S.meta.leaderUid]); }
    function noteCount(uidKey) {
        const items = S.notes[uidKey]?.items || {};
        return Object.values(items).reduce((n, it) => n + (it.annotations?.length || 0) + (it.note ? 1 : 0) + (it.pick !== null && it.pick !== undefined ? 1 : 0) + Object.keys(it.tags || {}).length, 0);
    }
    function inviteLink() {
        const url = new URL(location.href);
        url.hash = '';
        url.searchParams.set('session', S.code);
        return url.toString();
    }

    function hostSectionHTML() {
        if (!policy) return '';
        const presenting = S.transport && S.role === 'leader';
        if (!presenting && !policy.isHost()) return '';
        const allowed = presenting ? new Set(String(S.meta?.tools ?? policy.defaults.join(' ')).split(' ').filter(Boolean)) : policy.allowed;
        return `
            <div class="rv-live-host">
                <h4>${icon('sliders-horizontal')} Host controls</h4>
                ${presenting ? `
                <button type="button" class="rv-btn rv-primary" data-summon title="Everyone who wandered off snaps back to your view">${icon('scan-eye')} Bring everyone to my view</button>
                <p class="rv-live-sub">What participants can use</p>
                <div class="rv-live-tools">${tools.map(([key, label]) => `<label><input type="checkbox" data-tool-key="${key}"${allowed.has(key) ? ' checked' : ''}> ${escapeHTML(label)}</label>`).join('')}</div>
                <div class="rv-live-presets"><button type="button" class="rv-btn rv-mini" data-preset="review">Reviewer default</button><button type="button" class="rv-btn rv-mini" data-preset="none">Watch only</button><button type="button" class="rv-btn rv-mini" data-preset="all">Everything</button></div>` : `<p class="rv-live-sub">Start a session to control what participants see and use.</p>`}
                ${downloadHostFile ? `<button type="button" class="rv-btn" data-host-download title="Save the review file with the stop points you added">${icon('file-down')} Download review file with my stop points</button>` : ''}
            </div>`;
    }
    function wireHostSection() {
        panel.querySelector('[data-summon]')?.addEventListener('click', () => { S.transport.update('meta', { summon: Date.now() }); toast('Everyone is back on your view'); });
        const setTools = list => S.transport.update('meta', { tools: list.join(' ') });
        panel.querySelectorAll('[data-tool-key]').forEach(box => box.addEventListener('change', () => {
            setTools([...panel.querySelectorAll('[data-tool-key]')].filter(b => b.checked).map(b => b.dataset.toolKey));
        }));
        panel.querySelectorAll('[data-preset]').forEach(b => b.addEventListener('click', () => {
            const preset = b.dataset.preset;
            setTools(preset === 'all' ? tools.map(([key]) => key) : preset === 'none' ? [] : policy.defaults);
        }));
        panel.querySelector('[data-host-download]')?.addEventListener('click', () => downloadHostFile());
    }
    function applyPolicy() {
        if (!policy) return;
        policy.liveHost = !!S.transport && S.role === 'leader';
        policy.allowed = new Set(S.transport && S.meta?.tools !== undefined ? String(S.meta.tools).split(' ').filter(Boolean) : policy.defaults);
        policy.apply();
        onPolicy();
    }

    function render() {
        if (panel.hidden) return;
        if (!S.transport) {
            panel.innerHTML = `
                <h3>${icon('radio')} Live session</h3>
                <p class="rv-live-mode ${configured ? '' : 'demo'}">${configured
                    ? 'Everyone who opens the invite link follows what the presenter shows, and can point and highlight for the group.'
                    : 'Demo mode: sessions work only between tabs of this browser. Add Firebase keys (LIVE-SESSION-SETUP.md) for real sessions.'}</p>
                <label>Your name<input type="text" data-name maxlength="${MAX_NAME}" value="${escapeHTML(S.name || getName() || '')}" placeholder="Your name"></label>
                <button type="button" class="rv-btn rv-primary" data-start>${icon('presentation')} Start a session (you present)</button>
                <div class="rv-live-join"><input type="text" data-code placeholder="PAW-K7Q3MX" autocapitalize="characters" spellcheck="false"><button type="button" class="rv-btn" data-join>Join</button></div>
                <p class="rv-live-error" data-error hidden></p>
                ${hostSectionHTML()}`;
            wireHostSection();
            panel.querySelector('[data-start]').addEventListener('click', () => start(true).catch(showError));
            panel.querySelector('[data-join]').addEventListener('click', () => start(false, panel.querySelector('[data-code]').value).catch(showError));
            panel.querySelector('[data-code]').addEventListener('keydown', event => { if (event.key === 'Enter') start(false, event.target.value).catch(showError); });
        } else {
            const isLeader = S.role === 'leader';
            const watching = others().length;
            const roleLine = isLeader
                ? `You are presenting · ${watching} ${watching === 1 ? 'person' : 'people'} watching${S.locked ? ' · viewers locked to your view' : ''}`
                : leaderOnline() ? (S.locked ? `Locked to ${escapeHTML(leaderName())}'s view` : S.following ? `Following ${escapeHTML(leaderName())}` : `Not following ${escapeHTML(leaderName())}`) : `${escapeHTML(leaderName())} is offline`;
            const me = S.members[S.uid] || {};
            panel.innerHTML = `
                <div class="rv-live-code"><span>Session</span><strong>${escapeHTML(S.code)}</strong><button type="button" class="rv-btn" data-copy>${icon('link')} Copy invite link</button></div>
                <p class="rv-live-role">${roleLine}</p>
                <div class="rv-live-actions">
                    ${isLeader ? `<button type="button" class="rv-btn ${S.shareCamera ? 'active' : ''}" data-camera title="Viewers see the model from your angle as you rotate, pan and zoom">${icon('video')} ${S.shareCamera ? 'Sharing my view' : 'Share my view'}</button>` : ''}
                    ${isLeader ? `<button type="button" class="rv-btn ${S.locked ? 'active' : ''}" data-lock title="Viewers cannot leave your view while this is on">${icon(S.locked ? 'lock' : 'lock-open')} ${S.locked ? 'Viewers locked' : 'Lock viewers'}</button>` : S.locked ? '' : `<button type="button" class="rv-btn ${S.following ? 'active' : ''}" data-follow>${icon('locate-fixed')} ${S.following ? 'Following' : 'Follow presenter'}</button>`}
                    ${isLeader ? '' : `<button type="button" class="rv-btn ${me.hand ? 'active' : ''}" data-hand>${icon('hand')} ${me.hand ? 'Hand raised' : 'Raise hand'}</button>`}
                    <button type="button" class="rv-btn ${S.highlight ? 'active' : ''}" data-highlight>${icon('highlighter')} Highlight</button>
                    ${isLeader ? `<button type="button" class="rv-btn" data-clear>${icon('eraser')} Clear highlights</button>` : ''}
                    ${!isLeader && !leaderOnline() ? `<button type="button" class="rv-btn rv-primary" data-takeover>${icon('presentation')} Take over presenting</button>` : ''}
                </div>
                <ul class="rv-live-members">
                    ${Object.entries(S.members).map(([id, member]) => `
                        <li>
                            <span class="rv-live-swatch" style="background:${colorFor(id)}"></span>
                            <span class="rv-live-member-name">${escapeHTML(member.name || 'Guest')}${id === S.uid ? ' (you)' : ''}</span>
                            ${id === S.meta?.leaderUid ? '<span class="rv-live-badge">Presenter</span>' : member.following === false ? '<span class="rv-live-badge off">Own view</span>' : ''}
                            ${member.hand ? '<span class="rv-live-hand" title="Hand raised">✋</span>' : ''}
                            <span class="rv-live-notes">${noteCount(id)} note${noteCount(id) === 1 ? '' : 's'}</span>
                            ${id !== S.uid && noteCount(id) ? `<button type="button" class="rv-btn rv-mini" data-merge="${escapeHTML(id)}" title="Copy their pins and notes into yours">Merge</button>` : ''}
                            ${isLeader && id !== S.uid ? `<button type="button" class="rv-btn rv-mini" data-promote="${escapeHTML(id)}" title="Hand presenting over">Present</button>` : ''}
                        </li>`).join('')}
                </ul>
                <button type="button" class="rv-btn rv-danger" data-leave>${icon('log-out')} Leave session</button>
                ${hostSectionHTML()}`;
            wireHostSection();
            panel.querySelector('[data-copy]').addEventListener('click', () => navigator.clipboard.writeText(inviteLink()).then(() => toast('Invite link copied')).catch(() => prompt('Invite link:', inviteLink())));
            panel.querySelector('[data-follow]')?.addEventListener('click', () => setFollowing(!S.following));
            panel.querySelector('[data-hand]')?.addEventListener('click', () => S.transport.update(`members/${S.uid}`, { hand: !me.hand }));
            panel.querySelector('[data-highlight]').addEventListener('click', () => setHighlight(!S.highlight));
            panel.querySelector('[data-clear]')?.addEventListener('click', () => S.transport.remove('strokes'));
            panel.querySelector('[data-takeover]')?.addEventListener('click', () => S.transport.update('meta', { leaderUid: S.uid, leaderName: S.name }));
            panel.querySelector('[data-camera]')?.addEventListener('click', () => { S.shareCamera = !S.shareCamera; render(); publishState(); toast(S.shareCamera ? 'Viewers now follow your rotation, pan and zoom' : 'Viewers keep their own camera angle'); });
            panel.querySelector('[data-lock]')?.addEventListener('click', () => S.transport.update('meta', { locked: !S.locked }));
            panel.querySelector('[data-leave]').addEventListener('click', leave);
            panel.querySelectorAll('[data-merge]').forEach(b => b.addEventListener('click', () => mergeNotes(b.dataset.merge)));
            panel.querySelectorAll('[data-promote]').forEach(b => b.addEventListener('click', () => S.transport.update('meta', { leaderUid: b.dataset.promote, leaderName: S.members[b.dataset.promote]?.name || 'Presenter' })));
        }
        refreshIcons();
    }
    function showError(error) {
        console.error(error);
        const node = panel.querySelector('[data-error]');
        if (node) { node.textContent = error.message || String(error); node.hidden = false; }
        else toast(error.message || String(error));
    }
    function updateButton() {
        const label = button.querySelector('span');
        button.classList.toggle('active', !!S.transport);
        if (S.transport) {
            const count = Object.keys(S.members).length;
            label.textContent = `LIVE · ${S.code} · ${count}`;
            button.title = S.role === 'leader' ? 'You are presenting' : `Following ${leaderName()}`;
        } else { label.textContent = 'Live session'; button.title = 'Present this review live to others'; }
    }

    // Connection --------------------------------------------------------------------------------
    function waitForValue(path, ms) {
        return new Promise(resolve => {
            let done = false;
            let off = null;
            const finish = value => { if (done) return; done = true; resolve(value); if (off) off(); };
            // The demo transport delivers the current value synchronously, before `off` exists.
            off = S.transport.onValue(path, value => { if (value) finish(value); });
            if (done) off();
            setTimeout(() => finish(null), ms);
        });
    }
    async function start(create, code) {
        const nameInput = panel.querySelector('[data-name]');
        S.name = cleanName(nameInput?.value || getName()) || 'Guest';
        code = (code || (create ? makeCode() : '')).trim().toUpperCase();
        if (!CODE_PATTERN.test(code)) throw new Error('Enter the code from the invite, like PAW-K7Q3MX.');
        const transport = configured ? new FirebaseTransport() : new LocalTransport();
        try {
            const { uid: myUid } = await transport.connect({ code });
            S.transport = transport;
            S.uid = myUid;
            S.code = code;
            if (create) {
                await transport.set('meta', { reviewId: getReviewId(), title: getReviewTitle(), leaderUid: myUid, leaderName: S.name, createdAt: Date.now(), tools: (policy?.defaults || []).join(' ') });
            } else if (!(await waitForValue('meta', 3000))) {
                throw new Error('No session with that code. Check it with the presenter.');
            }
            await transport.set(`members/${myUid}`, { name: S.name, joinedAt: Date.now(), following: true, hand: false });
            transport.onDisconnectRemove(`members/${myUid}`);
            transport.onDisconnectRemove(`pointers/${myUid}`);
            // A dropped connection removes us from the member list (so others don't see ghosts). When it
            // comes back, rejoin, so a presenter's Wi-Fi blip doesn't hand the session to someone else.
            transport.onReconnect?.(() => {
                if (S.transport !== transport) return;
                transport.set(`members/${myUid}`, { name: S.name, joinedAt: Date.now(), following: S.following, hand: false });
                transport.onDisconnectRemove(`members/${myUid}`);
                transport.onDisconnectRemove(`pointers/${myUid}`);
                publishNotes();
            });
        } catch (error) {
            transport.disconnect?.();
            S.transport = null;
            S.code = null;
            throw error;
        }
        S.following = true;
        subscribe();
        entries.forEach(attach);
        const url = new URL(location.href);
        url.searchParams.set('session', code);
        history.replaceState(null, '', url);
        publishNotes();
        loop();
        render();
        updateButton();
        toast(create ? `Session ${code} started. Copy the invite link from the Live panel.` : `Joined ${code}`);
    }
    function subscribe() {
        const t = S.transport;
        S.unsubs.push(t.onValue('meta', meta => {
            S.meta = meta;
            const wasLeader = S.role === 'leader';
            const wasLocked = S.locked;
            S.role = meta?.leaderUid === S.uid ? 'leader' : 'follower';
            S.locked = !!meta?.locked;
            if (S.role === 'leader' && !wasLeader) { publishState(); if (wasLeader === false && S.transport) toast('You are now presenting'); }
            if (S.role === 'follower' && wasLeader) toast(`${leaderName()} is now presenting`);
            const lockMe = S.locked && S.role === 'follower';
            entries.forEach(e => e.media.setLocked?.(lockMe));
            if (lockMe && !S.following) setFollowing(true);
            if (lockMe && !wasLocked) toast(`${leaderName()} locked everyone to their view`);
            if (!lockMe && wasLocked && S.role === 'follower') toast('You can look around on your own again');
            returnBtn.hidden = S.role !== 'follower' || S.following;
            if (S.role === 'follower' && meta?.summon && meta.summon !== S.lastSummon) {
                if (S.lastSummon !== undefined) {
                    setFollowing(true);
                    if (S.remoteState) applyRemote(S.remoteState);
                    toast(`${leaderName()} brought everyone to their view`);
                }
            }
            S.lastSummon = meta?.summon ?? null;
            applyPolicy();
            render();
            updateButton();
        }));
        S.unsubs.push(t.onValue('state', state => {
            S.remoteState = state;
            if (S.role === 'follower' && S.following && state) applyRemote(state);
        }));
        S.unsubs.push(t.onValue('members', members => {
            const previous = S.members;
            S.members = members || {};
            if (S.role === 'leader') Object.entries(S.members).forEach(([id, m]) => { if (m.hand && !previous[id]?.hand && id !== S.uid) toast(`${m.name} raised a hand`); });
            render();
            updateButton();
        }));
        S.unsubs.push(t.onValue('pointers', pointers => { S.pointers = pointers || {}; renderPointers(); }));
        S.unsubs.push(t.onValue('strokes', strokes => { S.strokes = strokes || {}; }));
        S.unsubs.push(t.onValue('notes', notes => { S.notes = notes || {}; render(); shareOthersMarks(); }));
    }
    function leave() {
        if (!S.transport) return;
        const t = S.transport;
        S.unsubs.forEach(off => off());
        S.unsubs = [];
        t.remove(`members/${S.uid}`);
        t.remove(`pointers/${S.uid}`);
        t.disconnect();
        Object.assign(S, { transport: null, code: null, uid: null, role: null, following: true, meta: null, members: {}, pointers: {}, strokes: {}, notes: {}, remoteState: null, locked: false, lastSummon: undefined });
        applyPolicy();
        entries.forEach(e => { e.media.setRemote?.(null); e.media.setOthers?.([]); e.media.setLocked?.(false); });
        setHighlight(false);
        attached.forEach(rec => { rec.dots.forEach(dot => dot.remove()); rec.dots.clear(); rec.ctx.clearRect(0, 0, rec.canvas.width, rec.canvas.height); });
        returnBtn.hidden = true;
        const url = new URL(location.href);
        url.searchParams.delete('session');
        history.replaceState(null, '', url);
        render();
        updateButton();
        toast('Left the session');
    }

    // Presenter → followers ----------------------------------------------------------------------
    const publishState = throttle(() => {
        if (S.role !== 'leader' || !S.transport) return;
        const index = layout.getIndex();
        const entry = entries[index];
        const media = entry?.media.getState?.() || null;
        if (media && !S.shareCamera) {
            const strip = node => { if (!node || typeof node !== 'object') return; delete node.camera; Object.values(node).forEach(child => { if (child && typeof child === 'object' && !Array.isArray(child)) strip(child); }); };
            strip(media);
        }
        S.transport.update('state', { index, itemId: entry?.item.id || null, media: sanitize(media), camera: S.shareCamera, at: Date.now() });
    }, 90);
    layout.listeners.add(index => {
        entries.forEach(attach);
        if (!S.transport) return;
        if (S.role === 'leader') publishState();
        else if (!applyingRemote && S.remoteState && index !== S.remoteState.index) {
            if (S.locked) applyRemote(S.remoteState);
            else if (S.following) setFollowing(false);
        }
    });
    function applyRemote(state) {
        applyingRemote = true;
        try {
            let index = state.index;
            if (state.itemId) { const found = entries.findIndex(e => e.item.id === state.itemId); if (found >= 0) index = found; }
            if (layout.getIndex() !== index) layout.show(index);
            const entry = entries[index];
            if (entry && state.media) {
                entry.media.applyState?.(state.media);
                entry.media.setRemote?.(state.media.annotations || [], leaderName());
            }
        } finally { applyingRemote = false; }
    }
    function setFollowing(value) {
        if (!value && S.locked && S.role === 'follower') { if (S.remoteState) applyRemote(S.remoteState); return; }
        S.following = value;
        if (!value) entries.forEach(e => e.media.setRemote?.(null));
        S.transport?.update(`members/${S.uid}`, { following: value });
        returnBtn.hidden = value || S.role !== 'follower';
        if (value && S.remoteState) applyRemote(S.remoteState);
        render();
    }

    // Notes mirror + merge ----------------------------------------------------------------------
    // Everyone's video marks for everyone (the presenter's also arrive faster through the shared state).
    function shareOthersMarks() {
        entries.forEach(entry => {
            const list = [];
            Object.entries(S.notes).forEach(([id, note]) => {
                if (id === S.uid || (S.role === 'follower' && id === S.meta?.leaderUid)) return;
                const annotations = note?.items?.[entry.item.id]?.annotations || [];
                annotations.filter(a => a.kind === 'mark').forEach(a => list.push({ ...a, who: { name: note.name || 'Guest', color: colorFor(id) } }));
            });
            entry.media.setOthers?.(list);
        });
    }
    const publishNotes = throttle(() => { if (S.transport) S.transport.set(`notes/${S.uid}`, { name: S.name, at: Date.now(), items: sanitize(store.data.items) }); }, 700);
    store.subscribe(() => { publishNotes(); if (S.role === 'leader') publishState(); });
    function mergeNotes(fromUid) {
        const theirs = S.notes[fromUid];
        if (!theirs) return;
        const name = theirs.name || 'them';
        let copied = 0;
        Object.entries(theirs.items || {}).forEach(([itemId, it]) => {
            store.update(itemId, mine => {
                (it.annotations || []).forEach(a => {
                    if (mine.annotations.some(existing => existing.mergedFrom === a.id)) return;
                    mine.annotations.push({ ...a, id: uid(), mergedFrom: a.id, label: `[${name}] ${a.label || ''}`.trim() });
                    copied++;
                });
                if ((mine.pick === null || mine.pick === undefined) && it.pick !== null && it.pick !== undefined) { mine.pick = it.pick; copied++; }
                Object.entries(it.tags || {}).forEach(([v, tag]) => { if (!mine.tags[v]) { mine.tags[v] = tag; copied++; } });
                if (it.note && !mine.note.includes(it.note)) { mine.note = (mine.note ? mine.note + '\n' : '') + `[${name}] ${it.note}`; copied++; }
            });
        });
        toast(copied ? `Merged ${copied} item(s) from ${name} into your notes` : `Nothing new from ${name}`);
    }

    // Overlays: pointers and highlight strokes -------------------------------------------------
    const publishPointer = throttle((entry, x, y) => {
        if (!S.transport) return;
        S.transport.set(`pointers/${S.uid}`, { x, y, itemId: entry.item.id, name: S.name, at: Date.now() });
    }, 60);
    const clearPointer = throttle(() => S.transport?.remove(`pointers/${S.uid}`), 60);
    function setHighlight(on) {
        S.highlight = on;
        attached.forEach(rec => rec.layer.classList.toggle('drawing', on));
        hint.hidden = !on;
        refreshIcons();
        render();
    }
    function sizeCanvas(rec) {
        const dpr = Math.min(devicePixelRatio || 1, 2);
        const w = rec.layer.clientWidth, h = rec.layer.clientHeight;
        if (!w || !h) return;
        rec.canvas.width = Math.round(w * dpr);
        rec.canvas.height = Math.round(h * dpr);
        rec.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    function attach(entry) {
        const mediaEl = entry.media?.mediaEl;
        if (!mediaEl || attached.has(entry)) return;
        const layer = el('div', 'rv-live-layer');
        const canvas = el('canvas');
        layer.append(canvas);
        mediaEl.append(layer);
        const rec = { entry, layer, canvas, ctx: canvas.getContext('2d'), dots: new Map(), drawing: null };
        attached.set(entry, rec);
        new ResizeObserver(() => sizeCanvas(rec)).observe(layer);
        sizeCanvas(rec);
        layer.classList.toggle('drawing', S.highlight);
        const norm = event => { const r = layer.getBoundingClientRect(); return [+((event.clientX - r.left) / r.width).toFixed(4), +((event.clientY - r.top) / r.height).toFixed(4)]; };
        mediaEl.addEventListener('pointermove', event => { if (S.transport) { const [x, y] = norm(event); publishPointer(entry, x, y); } });
        mediaEl.addEventListener('pointerleave', () => { if (S.transport) clearPointer(); });
        layer.addEventListener('pointerdown', event => {
            if (!S.highlight || event.button !== 0) return;
            event.preventDefault();
            event.stopPropagation();
            try { layer.setPointerCapture(event.pointerId); } catch { /* synthetic */ }
            rec.drawing = { pts: [norm(event)], color: colorFor(S.uid) };
        });
        layer.addEventListener('pointermove', event => {
            if (!rec.drawing) return;
            const p = norm(event);
            const last = rec.drawing.pts[rec.drawing.pts.length - 1];
            if (Math.hypot(p[0] - last[0], p[1] - last[1]) > 0.003) rec.drawing.pts.push(p);
        });
        const finish = () => {
            if (!rec.drawing) return;
            const d = rec.drawing;
            rec.drawing = null;
            if (d.pts.length < 2) d.pts.push([d.pts[0][0] + 0.001, d.pts[0][1]]);
            S.transport?.push('strokes', { uid: S.uid, name: S.name, color: d.color, itemId: entry.item.id, pts: d.pts, at: Date.now() });
        };
        layer.addEventListener('pointerup', finish);
        layer.addEventListener('pointercancel', finish);
        entry.media.onChange?.(() => { if (S.role === 'leader' && entries[layout.getIndex()] === entry) publishState(); });
        entry.media.onUserNav?.(() => { if (!applyingRemote && S.role === 'follower' && S.following) setFollowing(false); });
    }
    function renderPointers() {
        const now = Date.now();
        attached.forEach(rec => {
            const seen = new Set();
            Object.entries(S.pointers).forEach(([id, p]) => {
                if (id === S.uid || !p || p.itemId !== rec.entry.item.id || now - (p.at || 0) > 6000) return;
                seen.add(id);
                let dot = rec.dots.get(id);
                if (!dot) {
                    dot = el('div', 'rv-live-dot', `<span>${escapeHTML(p.name || 'Guest')}</span>`);
                    dot.style.color = colorFor(id);
                    rec.layer.append(dot);
                    rec.dots.set(id, dot);
                }
                dot.style.left = (p.x * 100) + '%';
                dot.style.top = (p.y * 100) + '%';
            });
            rec.dots.forEach((dot, id) => { if (!seen.has(id)) { dot.remove(); rec.dots.delete(id); } });
        });
    }
    function drawStrokes(rec, now) {
        const { ctx, canvas } = rec;
        const w = canvas.clientWidth, h = canvas.clientHeight;
        ctx.clearRect(0, 0, w, h);
        const paint = (pts, color, alpha) => {
            if (!pts?.length) return;
            ctx.globalAlpha = alpha;
            ctx.strokeStyle = color;
            ctx.lineWidth = 4;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            ctx.shadowColor = 'rgba(0,0,0,0.35)';
            ctx.shadowBlur = 4;
            ctx.beginPath();
            ctx.moveTo(pts[0][0] * w, pts[0][1] * h);
            pts.slice(1).forEach(p => ctx.lineTo(p[0] * w, p[1] * h));
            ctx.stroke();
        };
        Object.values(S.strokes).forEach(stroke => {
            if (!stroke || stroke.itemId !== rec.entry.item.id) return;
            const age = now - (stroke.at || 0);
            if (age > 12000) return;
            paint(stroke.pts, stroke.color || '#ff3fa4', age < 8000 ? 1 : 1 - (age - 8000) / 4000);
        });
        if (rec.drawing) paint(rec.drawing.pts, rec.drawing.color, 1);
        ctx.globalAlpha = 1;
    }
    let lastPrune = 0;
    function loop() {
        if (!S.transport) return;
        const now = Date.now();
        attached.forEach(rec => drawStrokes(rec, now));
        if (S.role === 'leader' && now - lastPrune > 15000) {
            lastPrune = now;
            Object.entries(S.strokes).forEach(([id, s]) => { if (now - (s?.at || 0) > 60000) S.transport.remove(`strokes/${id}`); });
        }
        requestAnimationFrame(loop);
    }

    // Auto-join from an invite link -------------------------------------------------------------
    if (autoJoinCode) {
        panel.hidden = false;
        render();
        const codeInput = panel.querySelector('[data-code]');
        if (codeInput) codeInput.value = autoJoinCode;
        // ?session=CODE joins; ?session=CODE&present=1 starts presenting under that code.
        start(autoPresent, autoJoinCode).catch(showError);
    }
    updateButton();
    function setName(name) {
        name = cleanName(name);
        if (!name || name === S.name) return;
        S.name = name;
        if (!S.transport) return;
        S.transport.update(`members/${S.uid}`, { name });
        if (S.role === 'leader') S.transport.update('meta', { leaderName: name });
        publishNotes();
    }
    return { isActive: () => !!S.transport, state: S, setName };
}
