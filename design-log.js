// Design log: one page per animal listing every prosthetic version, what changed and why,
// pins with reply threads on the 3D model, saved views, discussion, and Drive links.
// Team log = Firebase (Google sign-in, team list); ?demo=1 = this browser only.
import { createViewer } from './iteration-viewer.js?v=4';
import { createDemoStore, createCloudStore } from './design-log-store.js?v=1';

const $ = (sel, root = document) => root.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const STATUSES = [
    ['Idea (not modelled)', 'idea'], ['Candidate (not printed)', 'candidate'], ['Printed', 'printed'],
    ['Printed and fitted', 'fitted'], ['Retired', 'retired'],
];
const statusKey = s => (STATUSES.find(x => x[0] === s) || [, 'other'])[1];
const TAGS = ['Fit', 'Strength', 'Comfort', 'Print', 'Baseline', 'Other'];
const narrow = window.matchMedia('(max-width: 760px)');
const coarse = window.matchMedia('(pointer: coarse)');

// ------------------------------------------------------------------ boot data
const manifest = await fetch('iterations/animals.json', { cache: 'no-cache' }).then(r => r.json());
const ANIMALS = manifest.animals;
const samples = {};
await Promise.all(ANIMALS.filter(a => a.sample).map(async a => {
    samples[a.id] = await fetch(a.sample, { cache: 'no-cache' }).then(r => r.ok ? r.json() : null).catch(() => null);
}));

const params = new URLSearchParams(location.search);
let savedMode = null;
try { savedMode = localStorage.getItem('gap-designlog-mode'); } catch {}
const MODE = params.get('demo') === '1' ? 'demo' : params.get('demo') === '0' ? 'cloud' : (savedMode || 'cloud');
try { localStorage.setItem('gap-designlog-mode', MODE); } catch {}

// Sample history -> log tree. Demo gets the example notes too; the team log gets only the real versions.
function sampleToTree(sample, { uid, withNotes }) {
    const tree = { iterations: {} };
    sample.iterations.forEach((s, i) => {
        const at = Date.parse(s.date + 'T17:00:00Z') + i * 60000;
        const author = s.author || 'Give a Paw team';
        const it = {
            uid, author, createdAt: at, label: s.label, parent: s.parent || '', date: s.date, title: s.title,
            status: s.status || STATUSES[1][0], model: s.model || '', summary: s.summary || '', outcome: s.outcome || '',
            changes: {}, views: {},
        };
        (s.changes || []).forEach((c, j) => { it.changes['c' + (j + 1)] = { uid, author, at: at + j, tag: c.tag, text: c.text, why: c.why || '' }; });
        (s.views || []).forEach((v, j) => { it.views[v.id] = { uid, author, at: at + j, name: v.name, camera: v.camera }; });
        if (withNotes) {
            it.pins = {};
            (s.pins || []).forEach((p, j) => {
                const pat = Date.parse(p.date + 'T18:00:00Z') + j * 60000;
                it.pins[p.id] = { uid, author: p.author, at: pat, pos: p.pos, normal: p.normal, camera: p.camera,
                    thread: { m1: { uid, author: p.author, at: pat, text: p.note } } };
            });
        }
        tree.iterations[s.id] = it;
    });
    return tree;
}
function demoSeed(animalId) {
    const sample = samples[animalId];
    if (!sample) return {};
    const tree = sampleToTree(sample, { uid: 'sample', withNotes: true });
    // Example notes only belong to the Ollie sample history, not to real logs like Billie's.
    const v1 = sample.sample ? tree.iterations.v1 : null;
    if (v1) {
        v1.comments = { k1: { uid: 'sample', author: 'Derrick (example)', at: Date.parse('2026-10-01T18:20:00Z'), text: 'Example comment: from the videos the socket rides forward when he loads the leg.' } };
        const p1 = v1.pins && Object.values(v1.pins)[0];
        if (p1) p1.thread.m2 = { uid: 'sample', author: 'Sreshta (example)', at: Date.parse('2026-10-01T19:05:00Z'), text: 'Example reply: could we keep the struts but narrow the opening by 30 mm?' };
    }
    return tree;
}

const store = MODE === 'demo' ? createDemoStore({ seedFor: demoSeed }) : createCloudStore();

// ------------------------------------------------------------------ page state
let A = null;              // animal entry from the manifest
let tree = {};             // the animal's log
let unsubscribe = null;
let currentId = null, openPin = null, compareId = '';
let showBody = false, showResolved = false, picking = false;
// Compare layout: two panes side by side, or both versions in one view in different colours.
let compareMode = 'side';
try { compareMode = localStorage.getItem('gap-designlog-compare-mode') === 'overlay' ? 'overlay' : 'side'; } catch {}
const OVERLAY_COLORS = { current: 0x2f7fc1, other: 0xe8893a }; // this version blue, the compared one orange
let adding = null;         // 'change' | 'link' | 'view'
let editing = null;        // path key of the item being edited
let expandResolved = false;
let pendingFocus = null, pendingFly = null;
const drafts = new Map();

const me = () => store.user || { uid: '', name: 'Someone' };
const its = () => tree.iterations || {};
const byId = id => (id && its()[id] ? { id, ...its()[id] } : null);
const sortedEntries = obj => Object.entries(obj || {}).sort((a, b) => (a[1].at || 0) - (b[1].at || 0) || a[0].localeCompare(b[0]));

// Versions in tree order: roots by date, then each one's children by date.
function orderedVersions() {
    const list = Object.entries(its()).map(([id, it]) => ({ id, ...it }));
    const cmp = (a, b) => String(a.date).localeCompare(String(b.date)) || (a.createdAt || 0) - (b.createdAt || 0);
    const ids = new Set(list.map(v => v.id));
    const kids = new Map();
    for (const v of list) {
        const p = v.parent && ids.has(v.parent) && v.parent !== v.id ? v.parent : '';
        if (!kids.has(p)) kids.set(p, []);
        kids.get(p).push(v);
    }
    const out = [];
    const seen = new Set();
    const walk = (p, depth) => (kids.get(p) || []).sort(cmp).forEach(v => {
        if (seen.has(v.id)) return;
        seen.add(v.id);
        out.push({ ...v, depth });
        walk(v.id, depth + 1);
    });
    walk('', 0);
    list.filter(v => !seen.has(v.id)).sort(cmp).forEach(v => out.push({ ...v, depth: 0 })); // parent loops
    return out;
}
const current = () => byId(currentId) || (orderedVersions()[0] ?? null);
const pinsOf = v => sortedEntries(v?.pins).map(([id, p], i) => ({ id, n: i + 1, ...p, thread: sortedEntries(p.thread) }));
const descendants = id => {
    const out = new Set([id]);
    let grew = true;
    while (grew) { grew = false; for (const [k, v] of Object.entries(its())) if (!out.has(k) && out.has(v.parent)) { out.add(k); grew = true; } }
    return out;
};

// ------------------------------------------------------------------ formatting
function fmtDate(d) {
    if (!d) return '';
    const t = new Date(String(d).length === 10 ? d + 'T12:00:00' : d);
    return isNaN(t) ? String(d) : t.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
function fmtWhen(ms) {
    if (!ms) return '';
    const diff = Date.now() - ms;
    if (diff < 60000 && diff > -60000) return 'just now';
    if (diff < 3600000 && diff > 0) return Math.round(diff / 60000) + ' min ago';
    const t = new Date(ms);
    const sameYear = t.getFullYear() === new Date().getFullYear();
    return t.toLocaleString('en-US', { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }), hour: 'numeric', minute: '2-digit' });
}
// Escape text and turn web links into anchors.
function rich(text) {
    return String(text ?? '').split(/(https?:\/\/[^\s<>"]+)/g).map((part, i) => i % 2
        ? `<a href="${esc(part)}" target="_blank" rel="noopener noreferrer">${esc(part.length > 60 ? part.slice(0, 57) + '…' : part)}</a>`
        : esc(part)).join('');
}
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

// ------------------------------------------------------------------ writes
async function write(fn, okMsg) {
    try { await fn(); if (okMsg) toast(okMsg); return true; }
    catch (e) {
        console.error(e);
        const denied = /permission/i.test(e?.code || e?.message || '');
        toast(denied ? 'Not saved: this account cannot make that change.' : 'Not saved: ' + (e?.message || e), true);
        return false;
    }
}
const put = (path, value) => store.set(A.id, path, value);
const stamp = () => ({ uid: me().uid, author: me().name, at: Date.now() });
const pathKey = path => path.join('/');
const keyPath = key => key.split('/');

let toastTimer = 0;
function toast(msg, error = false) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.toggle('error', error);
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, error ? 6000 : 2600);
}

function confirmBox(text, okLabel = 'Delete') {
    const dlg = $('#dlg-confirm');
    $('#dc-text').textContent = text;
    $('#dc-ok').textContent = okLabel;
    dlg.returnValue = '';
    dlg.showModal();
    return new Promise(resolve => dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true }));
}

// ------------------------------------------------------------------ header
const animalSelect = $('#animal');
animalSelect.innerHTML = ANIMALS.map(a => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('');
animalSelect.addEventListener('change', () => openAnimal(animalSelect.value, null));

function renderAccount() {
    const box = $('#account');
    if (store.kind === 'demo') {
        box.innerHTML = `<label><span class="name">You are</span> <input id="me" maxlength="60" autocomplete="name" aria-label="Your name" placeholder="Your name"></label>`;
        const input = $('#me');
        input.value = me().name;
        input.addEventListener('change', () => { store.setName(input.value); input.value = me().name; renderSide(); });
        return;
    }
    const u = store.user;
    box.innerHTML = u ? `<span class="dl-avatar" title="${esc(u.email || u.name)}">${u.photo ? `<img src="${esc(u.photo)}" alt="" referrerpolicy="no-referrer">` : esc(u.name[0] || '?')}</span><span class="name">${esc(u.name)}</span>` : '';
}

function setConn(state, text) {
    const c = $('#conn');
    c.dataset.state = state;
    c.querySelector('span').textContent = text;
    c.title = text;
}

const menuBtn = $('#menu-btn'), menu = $('#menu');
function renderMenu() {
    const items = [];
    if (A?.caseStudy) items.push(`<a role="menuitem" href="${esc(A.caseStudy)}">${esc(A.name)}’s case study</a>`);
    if (A?.designFiles) items.push(`<a role="menuitem" href="${esc(A.designFiles)}" target="_blank" rel="noopener noreferrer">Design files on Google Drive ↗</a>`);
    if (items.length) items.push('<hr>');
    const canUse = store.kind === 'demo' || store.user && memberOk;
    if (canUse) {
        items.push(`<button type="button" role="menuitem" data-menu="export">Export ${esc(A?.name || '')}’s log (JSON)</button>`);
        items.push(`<button type="button" role="menuitem" data-menu="import">Import versions from JSON…</button>`);
        items.push('<hr>');
    }
    if (store.kind === 'demo') {
        items.push(`<button type="button" role="menuitem" data-menu="reset" class="danger">Reset the demo for ${esc(A?.name || '')}</button>`);
        items.push(`<button type="button" role="menuitem" data-menu="cloud">Open the team log</button>`);
        items.push('<small>Demo: saved in this browser only.</small>');
    } else {
        items.push(`<button type="button" role="menuitem" data-menu="demo">Try the demo</button>`);
        if (store.user) {
            items.push(`<button type="button" role="menuitem" data-menu="signout">Sign out</button>`);
            items.push(`<small>Signed in as ${esc(store.user.email || store.user.name)}</small>`);
        }
    }
    menu.innerHTML = items.join('');
}
function setMenu(open) {
    if (open) renderMenu();
    menu.hidden = !open;
    menuBtn.setAttribute('aria-expanded', String(open));
    if (open) menu.querySelector('a, button')?.focus();
}
menuBtn.addEventListener('click', e => { e.stopPropagation(); setMenu(menu.hidden); });
document.addEventListener('click', e => { if (!menu.hidden && !menu.contains(e.target)) setMenu(false); });
menu.addEventListener('keydown', e => {
    const items = [...menu.querySelectorAll('a, button')];
    const i = items.indexOf(document.activeElement);
    if (e.key === 'Escape') { setMenu(false); menuBtn.focus(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
});
menu.addEventListener('click', async e => {
    const act = e.target.closest('[data-menu]')?.dataset.menu;
    if (!act) return;
    setMenu(false);
    if (act === 'export') exportLog();
    else if (act === 'import') $('#import-file').click();
    else if (act === 'reset' && await confirmBox(`Reset the demo log for ${A.name}? Everything added in this browser is removed.`, 'Reset')) {
        store.reset(A.id); currentId = null; openPin = null; builtKey = null; render();
    }
    else if (act === 'cloud') location.href = location.pathname + '?demo=0' + location.hash;
    else if (act === 'demo') location.href = location.pathname + '?demo=1' + location.hash;
    else if (act === 'signout') store.signOut();
});

function renderBanner() {
    const b = $('#banner');
    if (store.kind === 'demo') {
        b.hidden = false;
        b.innerHTML = `<span><b>Demo:</b> saved in this browser only.<span class="long"> Open a second tab to watch it sync live.</span></span><button type="button" data-banner="cloud">Open the team log</button>`;
    } else b.hidden = true;
    sizeTop();
}
$('#banner').addEventListener('click', e => { if (e.target.closest('[data-banner="cloud"]')) location.href = location.pathname + '?demo=0' + location.hash; });

function sizeTop() {
    const h = $('.dl-top').offsetHeight + ($('#banner').hidden ? 0 : $('#banner').offsetHeight);
    document.documentElement.style.setProperty('--top-h', h + 'px');
}
new ResizeObserver(sizeTop).observe($('.dl-top'));

// ------------------------------------------------------------------ gate (team log only)
let memberOk = store.kind === 'demo';
const GOOGLE = '<svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>';
function showGate(html) {
    $('#app').hidden = true;
    const g = $('#gate');
    g.hidden = false;
    g.innerHTML = `<div class="card">${html}</div>`;
}
$('#gate').addEventListener('click', async e => {
    const act = e.target.closest('[data-gate]')?.dataset.gate;
    if (act === 'signin') {
        store.signIn().catch(err => {
            if (err?.code === 'auth/popup-closed-by-user' || err?.code === 'auth/cancelled-popup-request') return;
            toast('Sign-in failed: ' + (err?.message || err), true);
        });
    } else if (act === 'demo') location.href = location.pathname + '?demo=1' + location.hash;
    else if (act === 'signout') store.signOut();
    else if (act === 'reload') location.reload();
    else if (act === 'copy') {
        try { await navigator.clipboard.writeText(store.user.uid); toast('ID copied'); } catch { toast('Select the ID and copy it.'); }
    }
});


// ------------------------------------------------------------------ routing
function parseHash() {
    const [a, v, p] = decodeURIComponent(location.hash.slice(1)).split('/');
    return { animal: ANIMALS.some(x => x.id === a) ? a : null, version: v || null, pin: p || null };
}
function syncHash() {
    const cur = current();
    const h = '#' + [A.id, cur?.id, openPin].filter(Boolean).join('/');
    if (location.hash !== h) history.replaceState(null, '', h);
}
let started = false;
function start() {
    if (started) { if (A) openAnimal(A.id, currentId); return; }
    started = true;
    const h = parseHash();
    let last = null;
    try { last = localStorage.getItem('gap-designlog-animal'); } catch {}
    openAnimal(h.animal || (ANIMALS.some(a => a.id === last) ? last : ANIMALS[0].id), h.version, h.pin);
}
window.addEventListener('hashchange', () => {
    const h = parseHash();
    if (!h.animal) return;
    if (h.animal !== A?.id) openAnimal(h.animal, h.version, h.pin);
    else if (h.version !== currentId || h.pin !== openPin) { selectVersion(h.version, h.pin); }
});

function openAnimal(id, versionId, pinId = null) {
    A = ANIMALS.find(a => a.id === id) || ANIMALS[0];
    try { localStorage.setItem('gap-designlog-animal', A.id); } catch {}
    animalSelect.value = A.id;
    $('#animal-title').textContent = `${A.name}’s versions`;
    document.title = `${A.name} · Design Log - Give a Paw`;
    currentId = versionId; openPin = pinId; compareId = ''; adding = null; editing = null; builtKey = null; lastView = null;
    pendingFly = pinId;
    $('#t-body').hidden = !A.body;
    $('#t-body-label').textContent = A.body?.label || 'Body';
    $('#model-list').innerHTML = (A.models || []).map(m => `<option value="${esc(m)}">`).join('');
    unsubscribe?.();
    tree = {};
    unsubscribe = store.subscribe(A.id, t => { tree = t || {}; render(); }, err => {
        toast('Could not load the log: ' + (err?.code || err?.message || err), true);
    });
    render();
}

function selectVersion(id, pin = null) {
    currentId = id; openPin = pin; adding = null; editing = null; pendingFly = pin;
    if (compareId === id) compareId = '';
    render();
}

// ------------------------------------------------------------------ rendering
function render() {
    if (!A) return;
    const cur = current();
    if (cur && currentId !== cur.id) currentId = cur.id;
    if (openPin && !cur?.pins?.[openPin]) openPin = null;
    if (compareId && (!its()[compareId] || compareId === currentId)) compareId = '';
    renderList();
    renderTools();
    renderSide();
    renderViewbar();
    buildViewers();
    syncHash();
}

function renderList() {
    const list = $('#list');
    const vs = orderedVersions();
    if (!vs.length) { list.innerHTML = '<li class="dl-empty-rail">No versions yet.</li>'; return; }
    list.innerHTML = vs.map(v => {
        const pins = pinsOf(v);
        const open = pins.filter(p => !p.resolved).length;
        const talk = Object.keys(v.comments || {}).length + pins.reduce((n, p) => n + Math.max(0, p.thread.length - 1), 0);
        const parent = v.parent && its()[v.parent];
        return `<li class="${v.depth ? 'child' : ''}" style="--depth:${Math.min(v.depth, 4)}"><button type="button" class="dl-ver" data-ver="${esc(v.id)}" aria-current="${v.id === currentId}">
            <span class="top">${esc(v.label)} <span class="date">${esc(fmtDate(v.date))}</span></span>
            <strong>${esc(v.title)}</strong>
            <span class="based">${parent ? 'Based on ' + esc(parent.label) : 'First version'}</span>
            <span class="counts"><span class="dl-status" data-s="${statusKey(v.status)}">${esc(v.status || 'No status')}</span>${open ? `<b>${plural(open, 'open pin')}</b>` : ''}${talk ? `<span>${plural(talk, 'reply', 'replies')}</span>` : ''}</span>
        </button></li>`;
    }).join('');
    // Keep the selected card visible in the horizontal strip.
    const sel = list.querySelector('[aria-current="true"]');
    if (sel && getComputedStyle(list).display === 'flex') {
        const l = sel.offsetLeft - list.offsetLeft, r = l + sel.offsetWidth;
        if (l < list.scrollLeft || r > list.scrollLeft + list.clientWidth) list.scrollLeft = l - 8;
    }
}
$('#list').addEventListener('click', e => {
    const b = e.target.closest('[data-ver]');
    if (b) selectVersion(b.dataset.ver);
});
$('#list').addEventListener('keydown', e => {
    if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    const btns = [...$('#list').querySelectorAll('[data-ver]')];
    const i = btns.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    const next = btns[i + (e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : -1)];
    if (next) { selectVersion(next.dataset.ver); $(`[data-ver="${CSS.escape(next.dataset.ver)}"]`)?.focus(); }
});

function renderTools() {
    const cur = current();
    const hasModel = !!cur?.model;
    $('#t-pin').disabled = !hasModel;
    $('#t-fit').disabled = !hasModel;
    $('#t-resolved').setAttribute('aria-pressed', String(showResolved));
    $('#t-body').setAttribute('aria-pressed', String(showBody));
    const sel = $('#t-compare');
    const others = orderedVersions().filter(v => v.id !== cur?.id);
    sel.innerHTML = `<option value="">${narrow.matches ? 'Compare: off' : 'Off'}</option>` + others.map(v =>
        `<option value="${esc(v.id)}" ${v.id === compareId ? 'selected' : ''}>${esc(v.label)}${v.id === cur?.parent ? ' (based on)' : ''}: ${esc(v.title)}</option>`).join('');
    sel.disabled = !cur || !others.length;
    const modeBox = $('#t-compare-mode');
    modeBox.hidden = !compareId;
    modeBox.querySelectorAll('[data-mode]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mode === compareMode)));
    if (!hasModel && picking) setPicking(false);
}
$('#t-compare-mode').addEventListener('click', e => {
    const mode = e.target.closest('[data-mode]')?.dataset.mode;
    if (!mode || mode === compareMode) return;
    compareMode = mode;
    try { localStorage.setItem('gap-designlog-compare-mode', mode); } catch {}
    render();
});

// Side panel: rebuilt on every change, keeping typed drafts, focus and scroll.
function renderSide() {
    const side = $('#side');
    const active = document.activeElement;
    const focusKey = side.contains(active) ? active.dataset.draft : null;
    let sel = null;
    try { sel = focusKey && active.selectionStart != null ? [active.selectionStart, active.selectionEnd] : null; } catch {}
    const scroll = side.scrollTop;
    side.innerHTML = sideHtml();
    side.querySelectorAll('[data-draft]').forEach(el => { if (drafts.has(el.dataset.draft)) el.value = drafts.get(el.dataset.draft); });
    side.scrollTop = scroll;
    const want = pendingFocus || focusKey;
    pendingFocus = null;
    if (want) {
        const el = side.querySelector(`[data-draft="${CSS.escape(want)}"]`);
        if (el) {
            el.focus({ preventScroll: !coarse.matches && want === focusKey });
            if (want === focusKey && sel) try { el.setSelectionRange(...sel); } catch {}
            if (want !== focusKey) el.scrollIntoView({ block: 'nearest' });
        }
    }
}

function itemActions(item, key, what) {
    if (item.uid !== me().uid) return '';
    return `<button type="button" class="dl-link" data-act="edit" data-path="${esc(key)}">Edit</button><button type="button" class="dl-link danger" data-act="del" data-path="${esc(key)}" data-what="${esc(what)}">Delete</button>`;
}

function msgHtml(m, key) {
    if (editing === key) {
        return `<form novalidate class="dl-inline-form" data-form="edit-msg" data-path="${esc(key)}"><textarea data-draft="edit:${esc(key)}" name="text" rows="2" maxlength="2000" required>${esc(m.text)}</textarea>
            <div class="acts"><button type="button" class="dl-btn dl-btn-sm" data-act="cancel-edit">Cancel</button><button class="dl-btn dl-btn-sm dl-btn-primary">Save</button></div></form>`;
    }
    return `<div class="dl-msg"><span class="who">${esc(m.author)}</span> <span class="when">${esc(fmtWhen(m.at))}${m.edited ? ' · edited' : ''}</span>
        <span class="acts">${itemActions(m, key, 'this message')}</span><div class="body">${rich(m.text)}</div></div>`;
}

function sideHtml() {
    const v = current();
    if (!v) {
        const sample = samples[A.id];
        return `<div class="dl-hello"><h2>No versions logged for ${esc(A.name)} yet</h2>
            <p>Add the first version: the socket or part that was printed or fitted, with its model file and notes.</p>
            <div class="dl-actions"><button type="button" class="dl-btn dl-btn-primary" data-act="new">Add the first version</button>
            ${sample && store.kind === 'cloud' ? `<button type="button" class="dl-btn" data-act="seed">Start with ${esc(A.name)}’s ${plural(sample.iterations.length, 'real version')}</button>` : ''}
            ${sample && store.kind === 'demo' ? `<button type="button" class="dl-btn" data-act="reset-demo">Load the sample</button>` : ''}</div></div>`;
    }
    const parent = v.parent && byId(v.parent);
    const kids = orderedVersions().filter(x => x.parent === v.id);
    const changes = sortedEntries(v.changes);
    const pins = pinsOf(v);
    const openPins = pins.filter(p => !p.resolved), resolved = pins.filter(p => p.resolved);
    const comments = sortedEntries(v.comments);
    const links = sortedEntries(v.links);
    const base = ['iterations', v.id];

    const changeHtml = ([id, c]) => {
        const key = pathKey([...base, 'changes', id]);
        if (editing === key) return changeForm(key, c);
        return `<div class="dl-chg"><span class="dl-tag" data-tag="${esc(c.tag)}">${esc(c.tag)}</span>${rich(c.text)}${c.why ? `<span class="why">Why: ${rich(c.why)}</span>` : ''}
            <span class="dl-by">${esc(c.author)} · ${esc(fmtWhen(c.at))}${c.edited ? ' · edited' : ''} ${itemActions(c, key, 'this change')}</span></div>`;
    };
    const pinHtml = p => {
        const key = pathKey([...base, 'pins', p.id]);
        const isOpen = openPin === p.id;
        const first = p.thread[0];
        const replies = p.thread.slice(1);
        const note = first ? rich(first[1].text) : '<em>New pin: add a note</em>';
        return `<div class="dl-pin ${isOpen ? 'open' : ''} ${p.resolved ? 'resolved' : ''}" data-pin="${esc(p.id)}" id="pin-${esc(p.id)}">
            <button type="button" class="dl-pin-head" data-act="pin" data-pin="${esc(p.id)}" aria-expanded="${isOpen}"><span class="n">${p.n}</span>
                <span class="txt">${isOpen ? `<b>Pin ${p.n}</b> <small style="display:inline">dropped by ${esc(p.author)} · ${esc(fmtWhen(p.at))}</small>` : note}
                <small>${isOpen ? '' : `${esc(first?.[1].author || p.author)} · ${plural(replies.length, 'reply', 'replies')}`}${p.resolved ? `${isOpen ? '' : ' · '}<span class="dl-resolved-note">Resolved by ${esc(p.resolved.by)}</span>` : ''}</small></span></button>
            ${isOpen ? `<div class="dl-thread">
                ${first ? msgHtml(first[1], pathKey([...base, 'pins', p.id, 'thread', first[0]])).replace('class="dl-msg"', 'class="dl-msg" style="border-top:0;padding-top:0"') : ''}
                ${replies.map(([mid, m]) => msgHtml(m, pathKey([...base, 'pins', p.id, 'thread', mid]))).join('')}
                <form novalidate class="dl-compose" data-form="reply" data-pin="${esc(p.id)}"><textarea name="text" rows="1" maxlength="2000" data-draft="pin:${esc(p.id)}" placeholder="${first ? 'Reply' : 'What should the team know about this spot?'}" aria-label="${first ? 'Reply to pin ' + p.n : 'Note for pin ' + p.n}"></textarea><button class="dl-btn dl-btn-primary dl-btn-sm">${first ? 'Reply' : 'Save'}</button></form>
                <div class="dl-pin-acts">
                    <button type="button" class="dl-link" data-act="resolve" data-pin="${esc(p.id)}">${p.resolved ? 'Reopen' : 'Mark resolved'}</button>
                    <button type="button" class="dl-link" data-act="copy-pin" data-pin="${esc(p.id)}">Copy link</button>
                    ${p.camera ? `<button type="button" class="dl-link" data-act="fly-pin" data-pin="${esc(p.id)}">Go to view</button>` : ''}
                    ${p.uid === me().uid ? `<button type="button" class="dl-link danger" data-act="del" data-path="${esc(key)}" data-what="pin ${p.n} and its replies">Delete pin</button>` : ''}
                </div></div>` : ''}
        </div>`;
    };

    return `
    <div class="dl-vhead"><h2><span class="dl-label">${esc(v.label)}</span>${esc(v.title)}</h2><button type="button" class="dl-btn dl-btn-sm" data-act="edit-version">Edit</button></div>
    <div class="dl-meta"><span>${esc(fmtDate(v.date))}</span><span class="sep">·</span><span class="dl-status" data-s="${statusKey(v.status)}">${esc(v.status || 'No status')}</span>
        ${parent ? `<span class="sep">·</span><span>based on <button type="button" class="dl-link" data-act="goto" data-ver="${esc(parent.id)}">${esc(parent.label)}</button></span>` : ''}
        ${kids.length ? `<span class="sep">·</span><span>led to ${kids.map(k => `<button type="button" class="dl-link" data-act="goto" data-ver="${esc(k.id)}">${esc(k.label)}</button>`).join(' ')}</span>` : ''}</div>
    <p class="dl-model">${v.model ? `Model <code>${esc(v.model)}</code>` : 'No 3D model yet'} · added by ${esc(v.author)}</p>
    ${v.summary ? `<p class="dl-summary">${rich(v.summary)}</p>` : ''}
    ${v.outcome ? `<p class="dl-outcome"><b>Result</b>${rich(v.outcome)}</p>` : ''}

    <section class="dl-sec"><h3>What changed <span class="n">${changes.length || ''}</span> <span class="dl-spacer"></span>${adding === 'change' ? '' : '<button type="button" class="dl-link" data-act="add-change">+ Add</button>'}</h3>
        ${changes.map(changeHtml).join('') || (adding === 'change' ? '' : '<p class="dl-empty">Nothing logged yet.</p>')}
        ${adding === 'change' ? changeForm(null, null) : ''}</section>

    <section class="dl-sec"><h3>Pins <span class="n">${openPins.length || ''}</span><span class="dl-spacer"></span>${v.model ? '<button type="button" class="dl-link" data-act="drop-pin">+ Drop pin</button>' : ''}</h3>
        ${openPins.map(pinHtml).join('') || `<p class="dl-empty">${v.model ? (coarse.matches ? 'Tap “Drop pin”, then tap the model.' : 'Press “Drop pin”, then click the model.') : 'Pins need a 3D model.'}</p>`}
        ${resolved.length ? `<button type="button" class="dl-more" data-act="toggle-resolved-list" aria-expanded="${expandResolved}">${expandResolved ? '▾' : '▸'} ${plural(resolved.length, 'resolved pin')}</button>${expandResolved ? resolved.map(pinHtml).join('') : ''}` : ''}</section>

    <section class="dl-sec"><h3>Discussion <span class="n">${comments.length || ''}</span></h3>
        ${comments.map(([id, m]) => msgHtml(m, pathKey([...base, 'comments', id]))).join('') || '<p class="dl-empty">No comments yet.</p>'}
        <form novalidate class="dl-compose" data-form="comment"><textarea name="text" rows="2" maxlength="2000" data-draft="comment:${esc(v.id)}" placeholder="Comment on ${esc(v.label)}" aria-label="Comment on ${esc(v.label)}"></textarea><button class="dl-btn dl-btn-primary dl-btn-sm">Send</button></form></section>

    <section class="dl-sec"><h3>Files &amp; links <span class="n">${links.length || ''}</span><span class="dl-spacer"></span>${adding === 'link' ? '' : '<button type="button" class="dl-link" data-act="add-link">+ Add</button>'}</h3>
        ${links.length ? `<ul class="dl-links">${links.map(([id, l]) => {
            const key = pathKey([...base, 'links', id]);
            if (editing === key) return `<li style="display:block">${linkForm(key, l)}</li>`;
            let host = '';
            try { host = new URL(l.url).hostname.replace(/^www\./, ''); } catch {}
            const drive = /(^|\.)google\.com$/.test(host) && /drive|docs/.test(host + l.url);
            return `<li><span class="ico ${drive ? 'drive' : ''}" aria-hidden="true">${drive ? 'D' : '↗'}</span><a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">${esc(l.label || host || l.url)}<span class="host">${esc(drive ? 'Google Drive' : host)} · ${esc(l.author)}</span></a>${itemActions(l, key, 'this link')}</li>`;
        }).join('')}</ul>` : (adding === 'link' ? '' : `<p class="dl-empty">Link the nTop file, STL, fitting video or photos${A.designFiles ? ` (they live in <a href="${esc(A.designFiles)}" target="_blank" rel="noopener noreferrer">${esc(A.name)}’s Design files</a>)` : ''}.</p>`)}
        ${adding === 'link' ? linkForm(null, null) : ''}</section>`;
}

function changeForm(key, c) {
    const d = key ? 'chg:' + key : 'chg:new';
    return `<form novalidate class="dl-inline-form" data-form="change" ${key ? `data-path="${esc(key)}"` : ''}>
        <div class="row"><select name="tag" aria-label="Type of change" style="flex:0 1 120px">${TAGS.map(t => `<option ${t === (c?.tag || 'Fit') ? 'selected' : ''}>${t}</option>`).join('')}</select>
        <input name="text" required maxlength="300" placeholder="What changed, e.g. Leg hole 147.5 → 107.5 mm" aria-label="What changed" data-draft="${esc(d)}:text" value="${esc(c?.text || '')}"></div>
        <input name="why" maxlength="400" placeholder="Why (optional)" aria-label="Why" data-draft="${esc(d)}:why" value="${esc(c?.why || '')}">
        <p class="dl-err" hidden></p>
        <div class="acts"><button type="button" class="dl-btn dl-btn-sm" data-act="cancel-edit">Cancel</button><button class="dl-btn dl-btn-sm dl-btn-primary">${key ? 'Save' : 'Add change'}</button></div></form>`;
}
function linkForm(key, l) {
    const d = key ? 'link:' + key : 'link:new';
    return `<form novalidate class="dl-inline-form" data-form="link" ${key ? `data-path="${esc(key)}"` : ''}>
        <input name="url" type="url" required maxlength="500" placeholder="https://drive.google.com/…" aria-label="Link address" data-draft="${esc(d)}:url" value="${esc(l?.url || '')}" inputmode="url" spellcheck="false">
        <input name="label" maxlength="80" placeholder="Name, e.g. nTop file v2a" aria-label="Link name" data-draft="${esc(d)}:label" value="${esc(l?.label || '')}">
        <p class="dl-err" hidden></p>
        <div class="acts"><button type="button" class="dl-btn dl-btn-sm" data-act="cancel-edit">Cancel</button><button class="dl-btn dl-btn-sm dl-btn-primary">${key ? 'Save' : 'Add link'}</button></div></form>`;
}

// Side panel actions
const side = $('#side');
const onDraftInput = e => { const k = e.target.dataset?.draft; if (k) drafts.set(k, e.target.value); };
const onFormKey = e => {
    const t = e.target;
    if (t.tagName === 'TEXTAREA' && e.key === 'Enter' && !e.shiftKey && !e.isComposing && !coarse.matches) {
        e.preventDefault();
        t.form?.requestSubmit();
    }
    if (e.key === 'Escape' && (adding || editing) && t.closest('.dl-inline-form')) { adding = null; editing = null; renderSide(); }
};
for (const el of [side, $('#views')]) { el.addEventListener('input', onDraftInput); el.addEventListener('keydown', onFormKey); el.addEventListener('submit', onFormSubmit); }
side.addEventListener('click', async e => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    const v = current();
    const base = v ? ['iterations', v.id] : [];
    if (act === 'new') openVersionDialog(null);
    else if (act === 'seed') seedCloud();
    else if (act === 'reset-demo') { store.reset(A.id); }
    else if (act === 'edit-version') openVersionDialog(v);
    else if (act === 'goto') selectVersion(b.dataset.ver);
    else if (act === 'add-change' || act === 'add-link') {
        adding = act.slice(4); editing = null;
        pendingFocus = adding === 'change' ? 'chg:new:text' : 'link:new:url';
        renderSide();
    } else if (act === 'cancel-edit') { adding = null; editing = null; renderSide(); }
    else if (act === 'edit') {
        editing = b.dataset.path; adding = null;
        const parts = keyPath(editing);
        const kind = parts.at(-2);
        pendingFocus = kind === 'changes' ? `chg:${editing}:text` : kind === 'links' ? `link:${editing}:url` : `edit:${editing}`;
        drafts.delete(pendingFocus);
        renderSide();
    } else if (act === 'del') {
        if (!await confirmBox(`Delete ${b.dataset.what}? This can’t be undone.`)) return;
        const path = keyPath(b.dataset.path);
        if (path.at(-2) === 'pins' && openPin === path.at(-1)) openPin = null;
        write(() => put(path, null), 'Deleted');
    } else if (act === 'pin') {
        const id = b.dataset.pin;
        openPin = openPin === id ? null : id;
        if (openPin) flyToPin(id);
        render();
        if (openPin) pendingScrollPin(id);
    } else if (act === 'fly-pin') flyToPin(b.dataset.pin);
    else if (act === 'drop-pin') setPicking(true);
    else if (act === 'resolve') {
        const p = v.pins?.[b.dataset.pin];
        if (!p) return;
        write(() => put([...base, 'pins', b.dataset.pin, 'resolved'], p.resolved ? null : { by: me().name, at: Date.now() }), p.resolved ? 'Reopened' : 'Marked resolved');
    } else if (act === 'copy-pin') {
        const url = location.origin + location.pathname + (store.kind === 'demo' ? '?demo=1' : '') + '#' + [A.id, v.id, b.dataset.pin].join('/');
        try { await navigator.clipboard.writeText(url); toast('Link to this pin copied'); }
        catch { window.prompt('Copy this link:', url); }
    } else if (act === 'toggle-resolved-list') { expandResolved = !expandResolved; renderSide(); }
});
function onFormSubmit(e) {
    e.preventDefault();
    const f = e.target;
    const v = current();
    if (!v) return;
    const base = ['iterations', v.id];
    const err = msg => { const p = f.querySelector('.dl-err'); if (p) { p.textContent = msg; p.hidden = false; } else toast(msg, true); };
    const clearDrafts = prefix => [...drafts.keys()].forEach(k => { if (k.startsWith(prefix)) drafts.delete(k); });
    const kind = f.dataset.form;
    if (kind === 'comment' || kind === 'reply') {
        const text = f.text.value.trim();
        if (!text) { f.text.focus(); return; }
        const path = kind === 'comment' ? [...base, 'comments', store.newKey()] : [...base, 'pins', f.dataset.pin, 'thread', store.newKey()];
        drafts.delete(f.text.dataset.draft);
        f.text.value = '';
        if (side.contains(f)) pendingFocus = f.text.dataset.draft;
        write(() => put(path, { ...stamp(), text })).then(ok => { if (!ok) { drafts.set(f.text.dataset.draft, text); renderSide(); } });
    } else if (kind === 'edit-msg') {
        const text = f.text.value.trim();
        if (!text) { f.text.focus(); return; }
        const path = keyPath(f.dataset.path);
        const old = path.reduce((o, k) => o?.[k], tree);
        editing = null;
        drafts.delete('edit:' + f.dataset.path);
        write(() => put(path, { ...old, text, edited: Date.now() }));
    } else if (kind === 'change') {
        const text = f.text.value.trim();
        if (!text) { err('Describe the change.'); f.text.focus(); return; }
        const key = f.dataset.path;
        const old = key ? keyPath(key).reduce((o, k) => o?.[k], tree) : null;
        const path = key ? keyPath(key) : [...base, 'changes', store.newKey()];
        const value = old ? { ...old, tag: f.tag.value, text, why: f.why.value.trim(), edited: Date.now() } : { ...stamp(), tag: f.tag.value, text, why: f.why.value.trim() };
        adding = null; editing = null;
        clearDrafts('chg:' + (key || 'new'));
        write(() => put(path, value));
    } else if (kind === 'link') {
        let url = f.url.value.trim();
        if (url && !/^https?:\/\//i.test(url)) url = 'https://' + url;
        let ok = false;
        try { const u = new URL(url); ok = u.protocol === 'https:' && !!u.hostname.includes('.'); } catch {}
        if (!ok) { err('Paste a full https:// link.'); f.url.focus(); return; }
        const key = f.dataset.path;
        const old = key ? keyPath(key).reduce((o, k) => o?.[k], tree) : null;
        const path = key ? keyPath(key) : [...base, 'links', store.newKey()];
        const label = f.label.value.trim();
        const value = old ? { ...old, url, label, edited: Date.now() } : { ...stamp(), url, label };
        adding = null; editing = null;
        clearDrafts('link:' + (key || 'new'));
        write(() => put(path, value));
    }
}

function pendingScrollPin(id) {
    if (narrow.matches) return; // the pin card in the viewer shows it on phones
    requestAnimationFrame(() => $('#pin-' + CSS.escape(id))?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
}

// ------------------------------------------------------------------ saved views bar
function renderViewbar() {
    const bar = $('#viewbar');
    const v = current();
    if (!v || !v.model) { bar.hidden = true; return; }
    bar.hidden = false;
    const views = sortedEntries(v.views);
    const form = adding === 'view'
        ? `<form novalidate data-form="view"><input name="name" maxlength="40" placeholder="Name this view" aria-label="View name" required><button class="dl-btn dl-btn-sm dl-btn-primary">Save</button><button type="button" class="dl-btn dl-btn-sm" data-vact="cancel">Cancel</button></form>`
        : `<span class="dl-chip add"><button type="button" data-vact="add">+ Save this view</button></span>`;
    bar.innerHTML = `<span class="lbl">Views</span>` + views.map(([id, w]) => `<span class="dl-chip"><button type="button" data-view="${esc(id)}" title="Saved by ${esc(w.author)}">${esc(w.name)}</button>${w.uid === me().uid ? `<button type="button" class="x" data-vdel="${esc(id)}" aria-label="Delete view ${esc(w.name)}">×</button>` : ''}</span>`).join('') + form;
    if (adding === 'view') bar.querySelector('input').focus();
}
$('#viewbar').addEventListener('click', async e => {
    const v = current();
    const view = e.target.closest('[data-view]')?.dataset.view;
    const del = e.target.closest('[data-vdel]')?.dataset.vdel;
    const vact = e.target.closest('[data-vact]')?.dataset.vact;
    if (view) mainViewer()?.flyTo(v.views[view].camera);
    else if (del) {
        if (await confirmBox(`Delete the saved view “${v.views[del].name}”?`)) write(() => put(['iterations', v.id, 'views', del], null), 'View deleted');
    } else if (vact === 'add') { adding = 'view'; renderViewbar(); }
    else if (vact === 'cancel') { adding = null; renderViewbar(); }
});
$('#viewbar').addEventListener('submit', e => {
    e.preventDefault();
    const name = e.target.name.value.trim();
    const viewer = mainViewer();
    if (!name || !viewer) return;
    adding = null;
    write(() => put(['iterations', currentId, 'views', store.newKey()], { ...stamp(), name, camera: viewer.getView() }), 'View saved');
});
$('#viewbar').addEventListener('keydown', e => { if (e.key === 'Escape' && adding === 'view') { adding = null; renderViewbar(); } });

// ------------------------------------------------------------------ 3D viewers
let viewers = [];          // [{ id, api, box }]
let builtKey = null, buildToken = 0, lastView = null;
const mainViewer = () => viewers.find(w => w.id === currentId)?.api || null;

function buildViewers() {
    const holder = $('#views');
    const cur = current();
    const other = compareId ? byId(compareId) : null;
    const overlay = !!other && compareMode === 'overlay' && !!other.model && !!cur?.model;
    const shown = cur ? (other && !overlay ? [other, cur] : [cur]) : [];
    const key = A.id + '|' + (overlay ? 'overlay:' + other.id + ':' + other.model + '|' : '') + shown.map(v => v.id + ':' + v.model).join('|');
    if (key === builtKey) { refreshPins(); applyPicking(); return; }
    // Same scan frame: keep the camera when switching versions.
    const prev = mainViewer();
    if (prev && A.sameFrame) lastView = { view: prev.getView(), panes: viewers.length };
    builtKey = key;
    const token = ++buildToken;
    viewers.forEach(w => w.api?.dispose());
    viewers = [];
    holder.className = 'dl-views' + (other && !overlay ? ' compare' : '');
    holder.replaceChildren();
    if (!cur) {
        holder.innerHTML = `<div class="iv"><div class="iv-empty"><div><strong>Nothing to show yet</strong>Versions you add appear here in 3D.</div></div></div>`;
        return;
    }
    for (const v of shown) {
        const box = document.createElement('div');
        box.className = 'iv' + (v.id === cur.id ? ' is-current' : '');
        box.innerHTML = overlay
            ? `<span class="iv-badge iv-legend"><i style="--c:#2f7fc1"></i>${esc(v.label)} · ${esc(v.title)}<i style="--c:#e8893a"></i>${esc(other.label)} · ${esc(other.title)}</span>`
            : `<span class="iv-badge">${esc(v.label)} · ${esc(v.title)}</span>`;
        holder.appendChild(box);
        if (!v.model) {
            box.insertAdjacentHTML('beforeend', `<div class="iv-empty"><div><strong>No 3D model yet</strong>Use Edit to add this version’s GLB file.</div></div>`);
            viewers.push({ id: v.id, api: null, box });
            continue;
        }
        box.insertAdjacentHTML('beforeend', '<div class="iv-loading">Loading model…</div>');
        viewers.push({ id: v.id, api: createViewer(box, { up: A.up || 'z' }), box });
    }
    Promise.all(viewers.map(async w => {
        if (!w.api) return;
        const v = byId(w.id);
        try {
            if (overlay) {
                await w.api.setModel('main', v.model, { color: OVERLAY_COLORS.current });
                const o = await w.api.setModel('other', other.model, { color: OVERLAY_COLORS.other, opacity: 0.6 });
                // Pushed slightly back so coincident surfaces show this version; orange marks real differences.
                if (o) Object.assign(o.material, { polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 4, needsUpdate: true });
            } else await w.api.setModel('main', v.model);
            if (A.body) await w.api.setModel('body', A.body.file, { color: 0x6f8fb5, opacity: 0.28, visible: showBody }).catch(() => {});
            if (token !== buildToken) return;
            w.box.querySelector('.iv-loading')?.remove();
            w.api.frame('main');
        } catch (e) {
            if (token !== buildToken) return;
            const l = w.box.querySelector('.iv-loading');
            if (l) { l.classList.add('iv-error'); l.textContent = `Could not load ${v.model}. Check the file name with Edit.`; }
            w.failed = true;
        }
    })).then(() => {
        if (token !== buildToken) return;
        const apis = viewers.filter(w => w.api && !w.failed);
        if (apis.length === 2 && A.sameFrame) apis[0].api.link(apis[1].api);
        const main = mainViewer();
        const pin = pendingFly && current()?.pins?.[pendingFly];
        if (main && pin?.camera) main.flyTo(pin.camera, 1);
        else if (main && lastView && lastView.panes === viewers.length) main.flyTo(lastView.view, 1);
        pendingFly = null;
        refreshPins();
        applyPicking();
    });
}

function refreshPins() {
    for (const w of viewers) {
        if (!w.api) continue;
        const v = byId(w.id);
        const list = pinsOf(v).filter(p => !p.resolved || showResolved || p.id === openPin).map(p => ({
            id: p.id, pos: p.pos, n: p.n, note: p.thread[0]?.[1].text || 'New pin', resolved: !!p.resolved, active: w.id === currentId && p.id === openPin,
        }));
        w.api.setPins(list, pin => {
            if (w.id !== currentId) { compareId = ''; selectVersion(w.id, pin.id); return; }
            openPin = pin.id;
            flyToPin(pin.id);
            render();
            pendingScrollPin(pin.id);
        });
    }
    renderPinCard();
}

// On phones the notes are below the viewer, so an opened pin also shows as a card inside it.
let pendingCardFocus = null, cardFocus = null;
function renderPinCard() {
    const a = document.activeElement;
    cardFocus = a?.closest?.('.iv-pincard') && a.dataset.draft ? { id: a.dataset.draft.slice(5), sel: [a.selectionStart, a.selectionEnd] } : null;
    viewers.forEach(w => w.box.querySelector('.iv-pincard')?.remove());
    const w = viewers.find(x => x.id === currentId && x.api);
    if (!w || !openPin || !narrow.matches) return;
    const p = pinsOf(current()).find(x => x.id === openPin);
    if (!p) return;
    const first = p.thread[0]?.[1];
    const card = document.createElement('div');
    card.className = 'iv-pincard';
    card.innerHTML = `<span class="n">${p.n}</span><div><p>${first ? rich(first.text) : '<em>New pin</em>'}</p><small>${esc(first?.author || p.author)} · ${plural(Math.max(0, p.thread.length - 1), 'reply', 'replies')}</small></div>
        <div class="acts">${first ? '<button type="button" class="dl-link" data-card="thread">Thread ↓</button>' : ''}<button type="button" class="dl-link" data-card="close" aria-label="Close pin">Close</button></div>
        ${first ? '' : `<form novalidate class="dl-compose" data-form="reply" data-pin="${esc(p.id)}"><textarea name="text" rows="1" maxlength="2000" data-draft="card:${esc(p.id)}" placeholder="What should the team know about this spot?" aria-label="Note for pin ${p.n}"></textarea><button class="dl-btn dl-btn-primary dl-btn-sm">Save</button></form>`}`;
    const ta = card.querySelector('textarea');
    if (ta && drafts.has(ta.dataset.draft)) ta.value = drafts.get(ta.dataset.draft);
    card.addEventListener('click', e => {
        const act = e.target.closest('[data-card]')?.dataset.card;
        if (act === 'close') { openPin = null; render(); }
        if (act === 'thread') $('#pin-' + CSS.escape(p.id))?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
    const keep = cardFocus && cardFocus.id === p.id ? cardFocus : null;
    w.box.appendChild(card);
    if (ta && (pendingCardFocus === p.id || keep)) {
        ta.focus({ preventScroll: true });
        if (keep) try { ta.setSelectionRange(keep.sel[0], keep.sel[1]); } catch {}
    }
    pendingCardFocus = null;
}
narrow.addEventListener('change', () => { renderPinCard(); renderList(); renderTools(); });

function flyToPin(id) {
    const p = current()?.pins?.[id];
    if (p?.camera) mainViewer()?.flyTo(p.camera);
}

// ------------------------------------------------------------------ tools
function setPicking(on) {
    picking = on && !!mainViewer();
    $('#t-pin').setAttribute('aria-pressed', String(picking));
    const cur = current();
    $('#hint').textContent = !picking ? '' : coarse.matches ? `Tap ${compareId ? cur.label + ' (right)' : 'the model'} to drop a pin`
        : `Click ${compareId ? cur.label + ' (right)' : 'the model'} to drop a pin · Esc to cancel`;
    applyPicking();
}
function applyPicking() {
    for (const w of viewers) {
        if (!w.api) continue;
        w.api.setPickMode(picking && w.id === currentId ? hit => {
            const key = store.newKey();
            const cam = w.api.getView();
            openPin = key;
            if (narrow.matches) pendingCardFocus = key; else pendingFocus = 'pin:' + key;
            setPicking(false);
            write(() => put(['iterations', currentId, 'pins', key], { ...stamp(), pos: hit.pos, normal: hit.normal, camera: cam }));
        } : null);
    }
}
$('#t-pin').addEventListener('click', () => setPicking(!picking));
$('#t-compare').addEventListener('change', e => { compareId = e.target.value; render(); });
$('#t-body').addEventListener('click', () => {
    showBody = !showBody;
    $('#t-body').setAttribute('aria-pressed', String(showBody));
    viewers.forEach(w => w.api?.setVisible('body', showBody));
});
$('#t-resolved').addEventListener('click', () => { showResolved = !showResolved; renderTools(); refreshPins(); });
$('#t-fit').addEventListener('click', () => viewers.forEach(w => w.api?.frame('main')));
$('#new').addEventListener('click', () => openVersionDialog(null));

document.addEventListener('keydown', e => {
    if (e.target.closest('input, textarea, select, [contenteditable]') || e.ctrlKey || e.metaKey || e.altKey || document.querySelector('dialog[open]')) return;
    if (e.key === 'Escape') {
        if (picking) setPicking(false);
        else if (openPin) { openPin = null; render(); }
    } else if (e.key === 'p' || e.key === 'P') { if (!$('#t-pin').disabled) setPicking(!picking); }
    else if (e.key === 'f' || e.key === 'F') { viewers.forEach(w => w.api?.frame('main')); }
});

// ------------------------------------------------------------------ version dialog
const dlg = $('#dlg-version'), form = $('#version-form');
form.status.innerHTML = STATUSES.map(([s]) => `<option>${esc(s)}</option>`).join('');
form.tag.innerHTML = TAGS.map(t => `<option>${t}</option>`).join('');
let editingVersion = null, labelTouched = false;

function suggestLabel(parentId) {
    const vs = Object.entries(its());
    const depthOf = id => { let d = 0, x = its()[id]; const seen = new Set(); while (x && !seen.has(x)) { seen.add(x); d++; x = x.parent && its()[x.parent]; } return d; };
    const n = parentId ? depthOf(parentId) + 1 : 1;
    const taken = new Set(vs.map(([, v]) => v.label));
    if (!taken.has('v' + n)) return 'v' + n;
    for (let i = 0; i < 26; i++) { const l = 'v' + n + String.fromCharCode(97 + i); if (!taken.has(l)) return l; }
    return 'v' + n + '-' + vs.length;
}
function openVersionDialog(v) {
    editingVersion = v;
    form.reset();
    labelTouched = !!v;
    form.querySelectorAll('[aria-invalid]').forEach(x => x.removeAttribute('aria-invalid'));
    $('#form-err').hidden = true;
    $('#dv-title').textContent = v ? `Edit ${v.label}` : `New version for ${A.name}`;
    $('#save-version').textContent = v ? 'Save' : 'Add version';
    $('#first-change').hidden = !!v;
    $('#outcome-field').hidden = !v;
    $('#delete-version').hidden = !v || v.uid !== me().uid;
    const banned = v ? descendants(v.id) : new Set();
    form.parent.innerHTML = `<option value="">None (first version)</option>` + orderedVersions().filter(x => !banned.has(x.id))
        .map(x => `<option value="${esc(x.id)}">${esc(x.label)}: ${esc(x.title)}</option>`).join('');
    if (v) {
        form.title.value = v.title || '';
        form.parent.value = v.parent || '';
        form.label.value = v.label || '';
        form.model.value = v.model || '';
        form.date.value = v.date || '';
        form.status.value = v.status || STATUSES[1][0];
        form.summary.value = v.summary || '';
        form.outcome.value = v.outcome || '';
    } else {
        const cur = current();
        form.parent.value = cur?.id || '';
        form.label.value = suggestLabel(form.parent.value);
        form.date.value = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
        form.status.value = STATUSES[1][0];
        form.tag.value = cur ? 'Fit' : 'Baseline';
    }
    dlg.showModal();
    if (!coarse.matches) form.title.focus();
}
form.label.addEventListener('input', () => { labelTouched = true; });
form.parent.addEventListener('change', () => { if (!labelTouched) form.label.value = suggestLabel(form.parent.value); });
$('#cancel-version').addEventListener('click', () => dlg.close());
$('#delete-version').addEventListener('click', async () => {
    const v = editingVersion;
    const kids = orderedVersions().filter(x => x.parent === v.id);
    if (kids.length) {
        $('#form-err').textContent = `${kids.map(k => k.label).join(' and ')} ${kids.length === 1 ? 'is' : 'are'} based on ${v.label}. Change what ${kids.length === 1 ? 'it is' : 'they are'} based on first.`;
        $('#form-err').hidden = false;
        return;
    }
    dlg.close();
    if (!await confirmBox(`Delete ${v.label} “${v.title}” with all its pins, comments and links? This can’t be undone.`)) return;
    if (await write(() => put(['iterations', v.id], null), `${v.label} deleted`)) { currentId = v.parent || null; openPin = null; render(); }
});

async function modelExists(file) {
    try {
        const r = await fetch(file, { method: 'HEAD', cache: 'no-cache' });
        return r.ok;
    } catch { return false; }
}
form.addEventListener('submit', async e => {
    e.preventDefault();
    const errBox = $('#form-err');
    const fail = (field, msg) => {
        errBox.textContent = msg; errBox.hidden = false;
        if (field) { field.setAttribute('aria-invalid', 'true'); field.focus(); }
    };
    form.querySelectorAll('[aria-invalid]').forEach(x => x.removeAttribute('aria-invalid'));
    errBox.hidden = true;
    const v = editingVersion;
    const title = form.title.value.trim(), label = form.label.value.trim(), model = form.model.value.trim();
    if (!title) return fail(form.title, 'Give the version a title.');
    if (!label) return fail(form.label, 'Give the version a short label, like v3.');
    if (Object.entries(its()).some(([id, x]) => x.label === label && id !== v?.id)) return fail(form.label, `${label} is already used. Pick another label.`);
    if (!form.date.value) return fail(form.date, 'Pick a date.');
    if (model) {
        if (!/^[\w\-./]+\.glb$/i.test(model) || model.includes('..') || model.startsWith('/')) return fail(form.model, 'The model must be a .glb file in the site folder, e.g. ollie-socket.glb.');
        if (model !== v?.model) {
            $('#save-version').disabled = true;
            const ok = await modelExists(model);
            $('#save-version').disabled = false;
            if (!ok) return fail(form.model, `Can’t find ${model} on the site. Check the name, or leave it empty until the file is published.`);
        }
    }
    const fields = { label, parent: form.parent.value, date: form.date.value, title, status: form.status.value, model, summary: form.summary.value.trim() };
    if (v) {
        fields.outcome = form.outcome.value.trim();
        dlg.close();
        write(() => store.update(A.id, ['iterations', v.id], fields), 'Saved');
        return;
    }
    const change = form.change.value.trim();
    if (fields.parent && !change) return fail(form.change, 'Say what changed from the version it is based on.');
    const key = store.newKey();
    const s = stamp();
    const it = { uid: s.uid, author: s.author, createdAt: s.at, ...fields, outcome: '' };
    if (change) it.changes = { [store.newKey()]: { ...s, tag: form.tag.value, text: change, why: form.why.value.trim() } };
    dlg.close();
    if (await write(() => put(['iterations', key], it), `${label} added`)) { currentId = key; openPin = null; compareId = ''; render(); }
});

// ------------------------------------------------------------------ import / export / seed
function exportLog() {
    const data = { format: 'gap-design-log', version: 1, animal: A.id, exportedAt: new Date().toISOString(), iterations: its() };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `${A.id}-design-log-${new Date().toISOString().slice(0, 10)}.json` });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
// The team log only accepts items carrying the writer's own account ID.
function adopt(node, uid) {
    if (Array.isArray(node) || !node || typeof node !== 'object') return node;
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = k === 'uid' ? uid : adopt(v, uid);
    return out;
}
async function importVersions(incoming, what) {
    const fresh = Object.entries(incoming).filter(([id]) => !its()[id]);
    const skipped = Object.keys(incoming).length - fresh.length;
    if (!fresh.length) { toast(skipped ? 'Those versions are already in the log.' : 'No versions found in that file.', true); return; }
    if (!await confirmBox(`Add ${plural(fresh.length, 'version')} from ${what} to ${A.name}’s log?${skipped ? ` ${skipped} already in the log will be skipped.` : ''}`, 'Import')) return;
    let n = 0;
    for (const [id, it] of fresh) if (await write(() => put(['iterations', id], adopt(it, me().uid)))) n++;
    if (n) toast(`Imported ${plural(n, 'version')}`);
}
$('#import-file').addEventListener('change', async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    let data;
    try { data = JSON.parse(await file.text()); } catch { toast('That file is not valid JSON.', true); return; }
    let incoming = null;
    if (data?.format === 'gap-design-log' && data.iterations && typeof data.iterations === 'object') {
        if (data.animal && data.animal !== A.id && !await confirmBox(`That file is ${data.animal}’s log, but you are looking at ${A.name}. Import it into ${A.name} anyway?`, 'Continue')) return;
        incoming = data.iterations;
    } else if (Array.isArray(data?.iterations)) incoming = sampleToTree(data, { uid: me().uid, withNotes: true }).iterations;
    if (!incoming) { toast('That file is not a design log export.', true); return; }
    for (const it of Object.values(incoming)) if (!it || typeof it.title !== 'string' || typeof it.label !== 'string') { toast('That file has a version without a title or label.', true); return; }
    importVersions(incoming, file.name);
});
function seedCloud() {
    const sample = samples[A.id];
    if (sample) importVersions(sampleToTree(sample, { uid: me().uid, withNotes: false }).iterations, 'the sample (versions, changes and views; no example notes)');
}

// For testing from the console or a test runner.
window.dlDebug = { get viewers() { return viewers; }, get tree() { return tree; }, get state() { return { animal: A?.id, currentId, openPin, compareId, picking }; }, store };

// ------------------------------------------------------------------ start
if (store.kind === 'cloud') {
    setConn('', 'Connecting');
    showGate('<p>Connecting…</p>');
    let unConn = null;
    store.onAuth(s => {
        renderAccount();
        if (!s.ready) return;
        memberOk = !!(s.user && s.member);
        if (s.error && !s.user) {
            setConn('offline', 'Offline');
            showGate(`<h2>Can’t reach the team log</h2><p>${esc(s.error)}</p><div class="dl-actions"><button type="button" class="dl-btn dl-btn-primary" data-gate="reload">Try again</button><button type="button" class="dl-btn" data-gate="demo">Try the demo</button></div>`);
            return;
        }
        if (!s.user) {
            setConn('', 'Signed out');
            unsubscribe?.(); unsubscribe = null;
            showGate(`<h2>Team design log</h2><p>Every version of each animal’s prosthetic: what changed and why, pins and threads on the 3D model, saved views, and links to the design files.</p><p>Sign in with the Google account the team approved.</p>
                <div class="dl-actions"><button type="button" class="dl-btn dl-btn-primary dl-google" data-gate="signin">${GOOGLE}<span>Sign in with Google</span></button><button type="button" class="dl-btn" data-gate="demo">Try the demo</button></div>`);
            return;
        }
        if (!s.member) {
            setConn('', 'Not on the team list');
            showGate(`<h2>Almost there</h2><p>You’re signed in as <b>${esc(s.user.email || s.user.name)}</b>, but this account isn’t on the design log’s team list yet.</p>
                <p>Send this ID to Tyler so he can add you:</p><div class="uid"><code>${esc(s.user.uid)}</code><button type="button" class="dl-btn dl-btn-sm" data-gate="copy">Copy</button></div>
                ${s.error ? `<p class="dl-err">${esc(s.error)}</p>` : ''}
                <div class="dl-actions"><button type="button" class="dl-btn dl-btn-primary" data-gate="reload">I’ve been added</button><button type="button" class="dl-btn" data-gate="signout">Use another account</button><button type="button" class="dl-btn" data-gate="demo">Try the demo</button></div>`);
            return;
        }
        $('#gate').hidden = true;
        $('#app').hidden = false;
        unConn?.();
        unConn = store.onConnection(ok => setConn(ok ? 'live' : 'offline', ok ? 'Live' : 'Offline: changes will sync when you reconnect'));
        start();
    });
} else {
    setConn('demo', 'Demo');
    renderAccount();
    $('#app').hidden = false;
    start();
}
renderBanner();
