// Developer hub (dev.html): where the next team picks up the site. One board of tasks inside projects, shown as a
// Board, a Table, a Timeline, My work, an Inbox for problem reports, and a Handbook (how the site works, the owner
// checklist, how-tos, rules, accounts, every page, team access). A strip under the views shows the live checks and
// the handoff campaign (Bronze / Silver / Gold handoff levels per project).
//
// Two layers: the snapshot written into the site (dev-content.js, dev-pages.js; tasks derived from it in
// dev-seed.js), with the live board in Firebase devboard/ on top. Anyone can read; people on designlog/team sign in
// with Google to change it. ?demo=1 uses a sample board kept in this browser.
//
// Board tree (devboard/...), every write carries uid, by (name) and at (ms) unless noted:
//   people/<uid>        {name, role, uid, at}                         (no "by")
//   tasks/<id>          {title, projectId, state, assignee, due, labels[], detail, createdBy, deleted?}
//   updates/<project>/<push>  {health: on-track|at-risk|off-track, text}
//   triage/<push>       {title, detail, page, state: new|accepted|declined|duplicate, taskId?}
//   projects/<id>       {status, health, progress, owner?, verifiedAt?, verifiedBy?, ...dev.html fields}
//   checklist/<id>      {done, holder, note}       notice {text}       history/<push> {project, name, text}
//   campaign            {date, target, goal}       checkhistory/<check>/<YYYY-MM-DD> {s, at, uid} (no "by")
import {
    content, pages, GH, $, $$, esc, icon, icons, fmtWhen, fmtDate, rich, slugify, STATUS, CHECKS, CHECK_LABEL,
    demoStore, cloudStore, saveError, mergedProjects, checklist, pageInfo, runChecks,
} from './dev-core.js?v=3';
import { defaultTasks, buildSeed, DEMO_USER } from './dev-seed.js?v=2';

const DEMO = new URLSearchParams(location.search).get('demo') === '1';
const store = DEMO ? demoStore({ key: 'gap-devboard-demo3', seed: buildSeed(), user: DEMO_USER }) : cloudStore();
const DEFAULTS = defaultTasks();
const DAY = 864e5;

// ---- vocabulary ------------------------------------------------------------------------------------------------
const STATES = [['todo', 'To do', 'circle'], ['doing', 'Doing', 'circle-dot'], ['waiting', 'Waiting on someone', 'hourglass'], ['done', 'Done', 'check-circle-2']];
const STATE = Object.fromEntries(STATES.map(([k, label, ic]) => [k, { label, icon: ic }]));
const UPD = {
    'on-track': { label: 'On track', icon: 'check-circle-2', hl: 'good' },
    'at-risk': { label: 'At risk', icon: 'alert-triangle', hl: 'needs-work' },
    'off-track': { label: 'Off track', icon: 'octagon-alert', hl: 'blocked' },
};
const H2U = { good: 'on-track', 'needs-work': 'at-risk', blocked: 'off-track' };
const U2H = { 'on-track': 'good', 'at-risk': 'needs-work', 'off-track': 'blocked' };
const VIEWS = [['board', 'Board', 'kanban-square'], ['table', 'Table', 'table'], ['timeline', 'Timeline', 'calendar-range'], ['mywork', 'My work', 'user-round-check'], ['inbox', 'Inbox', 'inbox'], ['handbook', 'Handbook', 'book-open']];
const HB = [['start', 'Start here', 'flag'], ['checklist', 'Owner checklist', 'clipboard-check'], ['how', 'How the site works', 'network'], ['checks', 'Live checks', 'activity'],
    ['changes', 'Recent changes', 'git-commit-horizontal'], ['manage', 'Manage the site', 'sliders-horizontal'], ['howto', 'How to…', 'list-checks'], ['rules', 'Rules & gotchas', 'shield-alert'],
    ['accounts', 'Accounts', 'key-round'], ['pages', 'Every page', 'files'], ['team', 'Team access', 'users']];
const HANDOFF = { id: 'handoff', name: 'Handoff (owner checklist)', area: 'Handoff', status: 'live', health: 'good', pages: [], next: [], notes: [], owner_actions: [], handoff: true };
const BASE_LABELS = ['bug', 'docs', 'decision', 'publish', '3d', 'owner-only', 'handoff', 'from-inbox'];
const TRIAGE = { new: ['New', 'circle-dot'], accepted: ['Accepted', 'check'], declined: ['Declined', 'x'], duplicate: ['Duplicate', 'copy'] };
const STALE_DAYS = 21;
// Handoff levels (as option A): Bronze = owner + how it works; Silver adds verified within 60 days + next steps (or
// retired); Gold adds every page loading + published (or private on purpose).
const CRITERIA = [
    { id: 'owner', label: 'Has an owner', short: 'Owner', icon: 'user-round', hint: 'Pick an owner under Project fields.' },
    { id: 'how', label: 'Has how-it-works notes', short: 'How it works', icon: 'book-open', hint: 'Add how-it-works notes to the snapshot (dev-content.js).' },
    { id: 'verified', label: 'Verified in the last 60 days', short: 'Verified', icon: 'badge-check', hint: 'Read the notes, fix anything out of date, then press “I verified this”.' },
    { id: 'next', label: 'Has next steps, or is retired', short: 'Next steps', icon: 'list-todo', hint: 'Add an open task, or set the status to Retired.' },
    { id: 'pages', label: 'Its pages load', short: 'Pages load', icon: 'file-check-2', hint: 'Fix the page that does not load, or take it off the project.' },
    { id: 'published', label: 'Published, or private on purpose', short: 'Published', icon: 'globe', hint: 'Publish it, or set the status to Private if it should stay off the site.' },
];
const LEVELS = [
    { id: 'none', label: 'No level', icon: 'circle-dashed', needs: [] },
    { id: 'bronze', label: 'Bronze', icon: 'medal', needs: ['owner', 'how'] },
    { id: 'silver', label: 'Silver', icon: 'medal', needs: ['owner', 'how', 'verified', 'next'] },
    { id: 'gold', label: 'Gold', icon: 'trophy', needs: CRITERIA.map(c => c.id) },
];
const LEVEL_IX = Object.fromEntries(LEVELS.map((l, i) => [l.id, i]));
const CAMPAIGN = { date: '2026-12-15', target: 'silver', goal: 'Every project at Silver' };
const HIST_KEYS = ['pages', 'models', 'database', 'github', 'google', 'libraries'];

// ---- small helpers ---------------------------------------------------------------------------------------------------
const pref = (k, d) => { try { const v = JSON.parse(localStorage.getItem('gap-dev-pref-' + k)); return v ?? d; } catch { return d; } };
const savePref = (k, v) => { try { localStorage.setItem('gap-dev-pref-' + k, JSON.stringify(v)); } catch { /* blocked */ } };
const pad = n => String(n).padStart(2, '0');
const isoOf = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = () => isoOf(new Date());
const dateOf = iso => new Date(iso + 'T12:00:00');
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const mondayOf = d => { const x = new Date(d); x.setHours(12, 0, 0, 0); return addDays(x, -((x.getDay() + 6) % 7)); };
const fmtDue = iso => dateOf(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const daysSince = t => Math.max(0, Math.floor((Date.now() - t) / DAY));
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
function ago(t) {
    const d = daysSince(t);
    if (d <= 0) return 'today';
    if (d === 1) return 'yesterday';
    if (d < 14) return `${d} days ago`;
    return `${Math.round(d / 7)} weeks ago`;
}
const initials = name => { const w = String(name || '').replace(/\(.*?\)/g, '').trim().split(/\s+/).filter(Boolean); return w.length ? (w.length > 1 ? w[0][0] + w[1][0] : w[0].slice(0, 2)).toUpperCase() : '?'; };
const AVATAR = ['#003262', '#1f5fa8', '#6a3fb0', '#1d7a3e', '#8a4b00', '#9c2a5c', '#34495e'];
const avatarColor = s => AVATAR[[...String(s)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % AVATAR.length];
const newId = () => 't-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const histId = id => /^[a-z0-9-]{1,48}$/.test(String(id)) ? id : 'board';
let toastTimer = 0;
function toast(msg, error = false) {
    const t = $('#b-toast');
    t.textContent = msg; t.classList.toggle('is-error', error); t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, error ? 7000 : 3000);
}
function announce(msg) { const l = $('#b-live'); l.textContent = ''; requestAnimationFrame(() => { l.textContent = msg; }); }
const fail = e => { console.warn(e); toast(saveError(e), true); };

// ---- state -----------------------------------------------------------------------------------------------------------
const S = {
    auth: { ready: false, user: null, member: false, error: '' },
    board: {}, boardState: 'loading', boardError: '',
    view: 'board', sub: '', q: '',
    f: { area: '', assignee: '', label: '', handoff: false, ...pref('filters', {}) },
    sort: pref('sort', { key: 'level', dir: 1 }), open: new Set(), col: 'todo', inboxTab: 'new', viewAs: null,
    laneClosed: pref('lanes', {}), hbQ: '', editNotice: false,
    checks: {}, pageChecks: {}, commits: null, commitsError: '', checkedAt: 0,
    projects: [], pm: new Map(), cl: [], tasks: [], people: {},
};
const me = () => DEMO ? DEMO_USER : (S.auth.user ? { uid: S.auth.user.uid, name: (S.auth.user.name || 'Team member').slice(0, 60) } : { uid: '', name: '' });
const canEdit = () => !!S.auth.member && S.boardState === 'live';
const canReport = () => !!S.auth.user && S.boardState === 'live';
const stamp = () => ({ uid: me().uid, by: me().name, at: Date.now() });

function effState(id, t) {
    if (!id.startsWith('cl-')) return STATE[t.state] ? t.state : 'todo';
    const done = !!S.board.checklist?.[id.slice(3)]?.done;
    return done ? 'done' : (t.state === 'done' || !STATE[t.state] ? 'todo' : t.state);
}
function derive() {
    S.projects = mergedProjects(S.board).map(p => ({ ...p, owner: p.live?.owner || '', verifiedAt: p.live?.verifiedAt || 0, verifiedBy: p.live?.verifiedBy || '' }));
    S.pm = new Map(S.projects.map(p => [p.id, p]));
    S.pm.set('handoff', HANDOFF);
    S.cl = checklist(S.board);
    S.people = S.board.people || {};
    const over = S.board.tasks || {};
    const list = [];
    Object.entries(DEFAULTS).forEach(([id, d]) => { const o = over[id]; if (o?.deleted) return; list.push({ ...(o || d), id, isDefault: true, live: !!o }); });
    Object.entries(over).forEach(([id, o]) => { if (!DEFAULTS[id] && o && !o.deleted) list.push({ ...o, id, isDefault: false, live: true }); });
    S.tasks = list.map(t => ({ ...t, labels: Array.isArray(t.labels) ? t.labels : Object.values(t.labels || {}), state: effState(t.id, t) }));
    if (S.viewAs == null || (S.viewAs && !S.people[S.viewAs])) S.viewAs = S.people[me().uid] ? me().uid : (Object.keys(S.people)[0] || '');
}
const personName = uid => uid ? (S.people[uid]?.name || 'Someone not on the team list') : 'Unassigned';
const clOrder = id => content.ownerChecklist.findIndex(c => 'cl-' + c.id === id);
const clFor = t => t.id.startsWith('cl-') ? S.cl.find(c => c.id === t.id.slice(3)) : null;
const isOverdue = t => t.due && t.state !== 'done' && t.due < today();
const updatesOf = pid => Object.entries(S.board.updates?.[pid] || {}).map(([k, u]) => ({ ...u, key: k })).sort((a, b) => b.at - a.at);
const healthOf = p => updatesOf(p.id)[0]?.health || H2U[p.health] || 'on-track';
const openCount = pid => S.tasks.filter(t => t.projectId === pid && t.state !== 'done').length;
const allLabels = () => [...new Set([...BASE_LABELS, ...S.tasks.flatMap(t => t.labels)])].sort();
const areas = () => [...new Set(S.projects.map(p => p.area))];
function byDue(a, b) {
    if (a.projectId === 'handoff' && b.projectId === 'handoff') return clOrder(a.id) - clOrder(b.id);
    return (a.due || '9999').localeCompare(b.due || '9999') || a.title.localeCompare(b.title);
}
function matchQ(hay) {
    const q = S.q.trim().toLowerCase();
    if (!q) return true;
    hay = hay.toLowerCase();
    return q.split(/\s+/).every(w => hay.includes(w));
}
function matchTask(t) {
    const f = S.f, p = S.pm.get(t.projectId);
    if (f.area && (p?.area || '') !== f.area) return false;
    if (f.assignee === '__none' ? !!t.assignee : (f.assignee && t.assignee !== f.assignee)) return false;
    if (f.label && !t.labels.includes(f.label)) return false;
    if (f.handoff && t.projectId !== 'handoff') return false;
    return matchQ([t.title, t.detail, t.labels.join(' '), p?.name, personName(t.assignee)].join(' '));
}
function matchProject(p) {
    const f = S.f;
    if (f.handoff) return false;
    if (f.area && p.area !== f.area) return false;
    if (f.assignee === '__none' && p.owner) return false;
    if (f.assignee && f.assignee !== '__none' && p.owner !== f.assignee && !S.tasks.some(t => t.projectId === p.id && t.assignee === f.assignee)) return false;
    if (f.label && !S.tasks.some(t => t.projectId === p.id && t.labels.includes(f.label))) return false;
    return matchQ([p.name, p.area, p.summary, p.howItWorks, ...(p.notes || []), ...(p.pages || []), ...S.tasks.filter(t => t.projectId === p.id).map(t => t.title)].join(' '));
}
const filtersOn = () => !!(S.f.area || S.f.assignee || S.f.label || S.f.handoff || S.q.trim());

// ---- handoff levels and the campaign ---------------------------------------------------------------------------------
function pageState(p) {
    const pub = (p.pages || []).filter(f => pageInfo(f));
    if (!pub.length) return null;
    const cs = pub.map(f => S.pageChecks[f]);
    if (cs.some(c => c?.state === 'bad')) return 'bad';
    return cs.every(c => c?.state === 'ok') ? 'ok' : 'run';
}
function score(p) {
    const ps = pageState(p);
    const r = {
        owner: !!p.owner,
        how: !!String(p.howItWorks || '').trim(),
        verified: !!p.verifiedAt && daysSince(p.verifiedAt) < 60,
        next: openCount(p.id) > 0 || p.status === 'retired',
        pages: ps === 'run' ? null : ps !== 'bad',
        published: p.status !== 'local-only',
    };
    let level = LEVELS[0];
    for (const L of LEVELS.slice(1)) { if (L.needs.every(k => r[k] !== false)) level = L; else break; }
    const next = LEVELS[LEVEL_IX[level.id] + 1] || null;
    const missing = next ? next.needs.filter(k => r[k] === false) : [];
    return { r, level, next, missing, passed: Object.values(r).filter(v => v !== false).length };
}
const criterion = id => CRITERIA.find(c => c.id === id);
const toReach = sc => sc.next ? `To reach ${sc.next.label}: ${sc.missing.map(k => criterion(k).label.toLowerCase()).join('; ') || 'waiting for the page checks'}.` : 'Top level reached.';
function verifyTone(p) {
    if (!p.verifiedAt) return { tone: 'never', text: 'Never verified', icon: 'badge-x' };
    const d = daysSince(p.verifiedAt);
    if (d < 60) return { tone: 'fresh', text: `Verified ${ago(p.verifiedAt)}`, icon: 'badge-check' };
    if (d < 120) return { tone: 'due', text: `Verified ${d} days ago · due`, icon: 'badge-alert' };
    return { tone: 'stale', text: `Verified ${d} days ago · stale`, icon: 'badge-x' };
}
const camp = () => ({ ...CAMPAIGN, ...(S.board.campaign || {}) });
function campaignStats() {
    const c = camp();
    const active = S.projects.filter(p => p.status !== 'retired');
    const target = LEVELS.find(l => l.id === c.target) || LEVELS[2];
    const at = active.filter(p => LEVEL_IX[score(p).level.id] >= LEVEL_IX[target.id]).length;
    const done = S.cl.filter(i => i.done).length;
    const left = Math.ceil((dateOf(c.date) - Date.now()) / DAY);
    return { c, active, target, at, pct: active.length ? Math.round(at / active.length * 100) : 0, done, n: S.cl.length, left };
}

// ---- shared markup ------------------------------------------------------------------------------------------------------
function avatar(uid, prefix = 'Assigned to') {
    if (!uid) return `<span class="b-av is-none" title="Unassigned">${icon('user-round')}<span class="b-sr">Unassigned</span></span>`;
    const name = personName(uid);
    return `<span class="b-av" style="background:${avatarColor(name)}" title="${esc(name)}"><span aria-hidden="true">${esc(initials(name))}</span><span class="b-sr">${esc(prefix)} ${esc(name)}</span></span>`;
}
function ownerChip(uid, short = false) {
    if (!uid) return `<span class="b-owner is-none"><span class="b-av is-none" aria-hidden="true">${icon('user-round')}</span><span><b>No owner</b>${short ? '' : '<small>Needed for Bronze</small>'}</span></span>`;
    const p = S.people[uid];
    const name = personName(uid);
    return `<span class="b-owner"><span class="b-av" style="background:${avatarColor(name)}" aria-hidden="true">${esc(initials(name))}</span><span><b>${esc(name)}</b><small>${esc(p?.role || 'No role set')}</small></span></span>`;
}
function projChip(p) {
    if (!p) return '<span class="b-proj">No project</span>';
    if (p.handoff) return `<span class="b-proj is-handoff">${icon('clipboard-check')}Handoff</span>`;
    const st = STATUS[p.status] || { label: p.status };
    return `<span class="b-proj" title="${esc(p.name)} · ${esc(st.label)}"><span class="b-dot st-${esc(p.status)}" aria-hidden="true"></span>${esc(p.name)}<span class="b-sr"> (project status: ${esc(st.label)})</span></span>`;
}
function dueBadge(t) {
    if (!t.due) return '';
    const od = isOverdue(t);
    return `<span class="b-due${od ? ' is-over' : ''}">${icon(od ? 'alert-circle' : 'calendar')}<span class="b-sr">Due </span>${od ? 'Overdue · ' : ''}${esc(fmtDue(t.due))}</span>`;
}
const labelChips = ls => ls.map(l => `<span class="b-label lc-${(l.length + l.charCodeAt(0)) % 6}">${esc(l)}</span>`).join('');
const statePill = s => { const v = STATE[s] || STATE.todo; return `<span class="b-state s-${esc(s)}">${icon(v.icon)}${esc(v.label)}</span>`; };
const statusPill = s => { const v = STATUS[s] || { label: s, icon: 'circle' }; return `<span class="b-pill st-${esc(s)}" title="${esc(v.hint || '')}">${icon(v.icon)}${esc(v.label)}</span>`; };
const healthBadge = h => { const v = UPD[h] || UPD['on-track']; return `<span class="b-health hl-${v.hl}">${icon(v.icon)}${esc(v.label)}</span>`; };
const levelBadge = (level, sr = '') => `<span class="b-level lv-${level.id}">${icon(level.icon)}<span>${sr}${esc(level.label)}</span></span>`;
function verifiedStamp(p) { const t = verifyTone(p); return `<span class="b-verified vf-${t.tone}" title="${p.verifiedAt ? `By ${esc(p.verifiedBy)}, ${esc(fmtDate(p.verifiedAt))}` : 'Nobody has confirmed these notes yet'}">${icon(t.icon)}<span>${esc(t.text)}</span></span>`; }
function progressBar(v, label = 'Progress', num = true) {
    v = Math.max(0, Math.min(100, Math.round(+v || 0)));
    return `<span class="b-prog"><span class="b-bar" role="progressbar" aria-valuenow="${v}" aria-valuemin="0" aria-valuemax="100" aria-label="${esc(label)}"><span style="width:${v}%"></span></span>${num ? `<span class="b-prog-n">${v}%</span>` : ''}</span>`;
}
function pageLink(f) {
    const known = pageInfo(f);
    if (!known) return `<span class="b-pagelink is-local" title="Only on a team computer, not on the public site">${icon('laptop')}${esc(f)}<span class="b-sr"> (not on the public site)</span></span>`;
    const c = S.pageChecks[f];
    return `<a href="${esc(f)}" class="b-pagelink is-${c ? c.state : 'run'}" data-file="${esc(f)}" title="${esc(f)}">${esc(known.title)}</a>`;
}
function checkDot(c) {
    const [ic, label] = CHECK_LABEL[c.state] || CHECK_LABEL.run;
    return `<span class="b-check is-${c.state}" title="${esc(c.text || label)}">${icon(ic, c.state === 'run' ? 'b-spin' : '')}<span>${esc(label)}</span></span>`;
}
function richDetail(text) {
    const out = [];
    let ol = [];
    const flush = () => { if (ol.length) { out.push(`<ol class="b-steps">${ol.map(x => `<li>${rich(x)}</li>`).join('')}</ol>`); ol = []; } };
    String(text || '').split('\n').forEach(line => {
        const m = line.match(/^\s*\d+\.\s+(.*)$/);
        if (m) { ol.push(m[1]); return; }
        flush();
        if (!line.trim()) return;
        const d = line.match(/^\s*Done when:\s*(.*)$/i);
        out.push(d ? `<p class="b-donewhen">${icon('flag')}<span><b>Done when:</b> ${rich(d[1])}</span></p>` : `<p>${rich(line)}</p>`);
    });
    flush();
    return out.join('');
}
const viewHead = (id, title, lead, extra = '') => `<div class="b-viewhead"><div><h2 id="h-${id}" tabindex="-1">${title}</h2>${lead ? `<p class="b-lead">${lead}</p>` : ''}</div>${extra}</div>`;
const BAR_TEXT = { ok: 'working', warn: 'partly working', bad: 'not working', none: 'no data' };
function bars(key) {
    const hist = S.board.checkhistory?.[key] || {};
    const t0 = today();
    const n = { ok: 0, warn: 0, bad: 0, none: 0 };
    const cells = Array.from({ length: 30 }, (_, i) => addDays(new Date(), i - 29)).map(d => {
        const k = isoOf(d);
        const live = k === t0 ? S.checks[key]?.state : null;
        const v = (['ok', 'warn', 'bad'].includes(live) ? live : hist[k]?.s) || 'none';
        n[v]++;
        return `<span class="b-hbar is-${v}" title="${esc(fmtDate(d))}: ${BAR_TEXT[v]}${k === t0 && live ? ' (live)' : ''}"></span>`;
    }).join('');
    const data = n.ok + n.warn + n.bad;
    return `<div class="b-hist"><div class="b-hbars" role="img" aria-label="${esc(`Last 30 days: ${n.ok} working, ${n.warn} partly working, ${n.bad} not working, ${n.none} with no data.`)}">${cells}</div>
        <div class="b-hist-scale" aria-hidden="true"><span>30 days ago</span><span>${data ? `${Math.round(n.ok / data * 100)}% working · ${plural(data, 'day')} of data` : 'No data yet'}</span><span>Today</span></div></div>`;
}

// ---- top bar, banners, view nav, strip, filters ----------------------------------------------------------------------
function renderAuth() {
    const a = S.auth;
    let html;
    if (DEMO) html = `<span class="b-chip is-demo">${icon('flask-conical')} Demo</span>`;
    else if (!a.ready) html = `<span class="b-chip">${icon('loader', 'b-spin')} Checking sign-in…</span>`;
    else if (!a.user) html = `<button type="button" class="b-btn b-btn-gold" data-act="signin">${icon('log-in')}<span class="b-hide-xs">Sign in to edit</span><span class="b-show-xs">Sign in</span></button>`;
    else html = `<span class="b-chip ${a.member ? 'is-ok' : 'is-warn'}" title="${esc(a.user.email || '')}">${icon(a.member ? 'user-check' : 'user-x')}<span class="b-chip-name">${esc(a.user.name)}</span>${a.member ? '' : '<span class="b-sr"> (not on the team list)</span>'}</span><button type="button" class="b-btn b-btn-ghost b-btn-sm" data-act="signout">Sign out</button>`;
    $('#b-auth').innerHTML = html;
    $('#b-newtask').innerHTML = canEdit() ? `<button type="button" class="b-btn b-btn-gold" data-act="new-task" aria-keyshortcuts="c">${icon('plus')}<span class="b-hide-xs">New task</span><span class="b-sr b-show-xs">New task</span></button>` : '';
}
function renderBanner() {
    const b = $('#b-banner');
    const parts = [];
    if (DEMO) parts.push(`<p>${icon('flask-conical')}<span><b>Demo:</b> sample data, changes stay in this browser. <a href="dev.html">Open the live board</a> · <button type="button" class="b-linkbtn" data-act="reset">Reset sample data</button></span></p>`);
    if (!DEMO && S.boardState === 'unset') parts.push(`<p>${icon('database')}<span><b>Live board not switched on yet:</b> the database rules need publishing (<a href="${GH}/blob/main/DEV-BOARD-SETUP.md" target="_blank" rel="noopener">DEV-BOARD-SETUP.md</a>). Showing the snapshot from ${esc(content.snapshotDate)}.</span></p>`);
    if (!DEMO && S.boardState === 'offline') parts.push(`<p>${icon('wifi-off')}<span><b>Can’t reach the live board</b> (${esc(S.boardError)}). Showing the snapshot from ${esc(content.snapshotDate)}.</span></p>`);
    if (!DEMO && S.auth.user && !S.auth.member) parts.push(`<p>${icon('user-x')}<span>You’re signed in as <b>${esc(S.auth.user.email || S.auth.user.name)}</b>, but this account isn’t on the team list, so you can read the board but not change it. <a href="#handbook/team">How to get added</a>.</span></p>`);
    if (!DEMO && S.auth.error) parts.push(`<p>${icon('alert-triangle')}<span>${esc(S.auth.error)}</span></p>`);
    b.innerHTML = parts.join('');
    b.hidden = !parts.length;
    b.classList.toggle('is-demo', DEMO);
}
function renderNav() {
    const nNew = Object.values(S.board.triage || {}).filter(r => r.state === 'new').length;
    $('#b-viewnav').innerHTML = VIEWS.map(([k, label, ic], i) => `<li><a href="#${k}" data-fk="nav:${k}"${S.view === k ? ' aria-current="page"' : ''} aria-keyshortcuts="${i + 1}">${icon(ic)}<span>${label}</span>${k === 'inbox' && nNew ? `<span class="b-count">${nNew}<span class="b-sr"> new</span></span>` : ''}</a></li>`).join('');
}
function renderStrip() {
    const list = CHECKS.map(([k, name]) => ({ k, name, c: S.checks[k] }));
    const probs = list.filter(x => ['warn', 'bad'].includes(x.c?.state));
    const doneN = list.filter(x => x.c && x.c.state !== 'run').length;
    let tone, ic, title, sub;
    if (!S.checkedAt) { tone = 'idle'; ic = 'loader'; title = 'Checking the site…'; sub = `${doneN} of ${list.length} live checks done`; }
    else if (!probs.length) { tone = 'good'; ic = 'check-circle-2'; title = 'All systems working'; sub = `All ${list.length} live checks pass · ${fmtWhen(S.checkedAt)}`; }
    else { tone = probs.some(x => x.c.state === 'bad') ? 'bad' : 'warn'; ic = tone === 'bad' ? 'x-circle' : 'alert-triangle'; title = `${probs.length} ${probs.length === 1 ? 'needs' : 'need'} attention`; sub = probs.map(x => x.name.replace(/ \(.*\)$/, '')).join(', '); }
    const s = campaignStats();
    const when = isNaN(s.left) ? 'No date set' : s.left > 0 ? plural(s.left, 'day') + ' left' : s.left === 0 ? 'Handoff today' : `${plural(-s.left, 'day')} past`;
    $('#b-strip').innerHTML = `<div class="b-strip-in">
        <a class="b-st b-overall tone-${tone}" href="#handbook/checks" data-fk="strip:checks"><span class="b-ov-icon">${icon(ic, tone === 'idle' ? 'b-spin' : '')}</span><span class="b-st-text"><b>${esc(title)}</b><small>${esc(sub)}</small></span></a>
        <div class="b-st b-camp-goal"><span class="b-camp-icon">${icon('target')}</span><span class="b-st-text"><b>${esc(when)}</b><small>${esc(s.c.goal)} · ${isNaN(s.left) ? '—' : esc(fmtDate(s.c.date + 'T12:00:00'))}</small></span>
            ${canEdit() ? `<button type="button" class="b-btn b-btn-quiet b-btn-sm b-icon-btn" data-act="edit-campaign" data-fk="strip:camp" title="Edit the handoff campaign">${icon('settings-2')}<span class="b-sr">Edit the handoff campaign</span></button>` : ''}</div>
        <a class="b-st b-st-bar" href="#table" data-act="sort-level" data-fk="strip:level"><span class="b-st-text"><b>${s.pct}% <span>at ${esc(s.target.label)} or better</span></b>${progressBar(s.pct, `Projects at ${s.target.label} or better`, false)}<small>${s.at} of ${s.active.length} active projects</small></span></a>
        <button type="button" class="b-st b-st-bar" data-act="show-handoff" data-fk="strip:cl"><span class="b-st-text"><b>${s.done}/${s.n} <span>owner checklist</span></b><span class="b-bar is-green" role="progressbar" aria-valuenow="${s.done}" aria-valuemin="0" aria-valuemax="${s.n}" aria-label="Owner checklist done"><span style="width:${Math.round(s.done / s.n * 100)}%"></span></span><small>Show the Handoff lane</small></span></button>
    </div>`;
}
function renderFilters() {
    const box = $('#b-filters');
    const on = ['board', 'table', 'timeline', 'mywork'].includes(S.view);
    box.hidden = !on;
    if (!on) return;
    const f = S.f;
    const opt = (v, label, cur) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(label)}</option>`;
    const isTable = S.view === 'table';
    const shown = isTable ? S.projects.filter(matchProject).length : S.tasks.filter(matchTask).length;
    const total = isTable ? S.projects.length : S.tasks.length;
    box.innerHTML = `
        <label class="b-fsel"><span>Area</span><select data-filter="area" data-fk="f:area">${opt('', 'All areas', f.area)}${opt('Handoff', 'Handoff', f.area)}${areas().map(a => opt(a, a, f.area)).join('')}</select></label>
        <label class="b-fsel"><span>${isTable ? 'Person' : 'Assignee'}</span><select data-filter="assignee" data-fk="f:assignee">${opt('', 'Anyone', f.assignee)}${opt('__none', 'Unassigned', f.assignee)}${Object.entries(S.people).map(([k, p]) => opt(k, p.name, f.assignee)).join('')}</select></label>
        <label class="b-fsel"><span>Label</span><select data-filter="label" data-fk="f:label">${opt('', 'Any label', f.label)}${allLabels().map(l => opt(l, l, f.label)).join('')}</select></label>
        <button type="button" class="b-chiptoggle" data-act="toggle-handoff" data-fk="f:handoff" aria-pressed="${!!f.handoff}">${icon('clipboard-check')} Handoff only <b>${S.cl.filter(c => c.done).length}/${S.cl.length}</b></button>
        <span class="b-fcount" aria-live="polite">${shown === total ? `${total} ${isTable ? 'projects' : 'tasks'}` : `Showing ${shown} of ${total} ${isTable ? 'projects' : 'tasks'}`}</span>
        ${filtersOn() ? `<button type="button" class="b-btn b-btn-sm b-btn-quiet" data-act="clear-filters" data-fk="f:clear">${icon('x')} Clear filters</button>` : ''}`;
}

// ---- Board ---------------------------------------------------------------------------------------------------------------
function renderBoard() {
    const list = S.tasks.filter(matchTask);
    const hand = list.filter(t => t.projectId === 'handoff');
    const work = list.filter(t => t.projectId !== 'handoff');
    const done = S.cl.filter(c => c.done).length, n = S.cl.length;
    const hist = Object.values(S.board.history || {}).sort((a, b) => b.at - a.at).slice(0, 14);
    const meter = `<div class="b-meter"><span><b>${done}</b> of ${n} checklist items done</span><span class="b-bar is-green" role="progressbar" aria-valuenow="${done}" aria-valuemin="0" aria-valuemax="${n}" aria-label="Owner checklist progress"><span style="width:${Math.round(done / n * 100)}%"></span></span><a href="#handbook/checklist">Full checklist</a></div>`;
    $('#v-board').innerHTML = viewHead('board', 'Board', canEdit() ? 'Every task by where it stands. Drag a card or use its <b>Move</b> menu (<kbd>[</kbd> <kbd>]</kbd> on a focused card); open a card to edit it.'
        : 'Every task by where it stands. Open a card for the details.' + (DEMO ? '' : ' Team members can change the board after signing in.'))
        + `<div class="b-coltabs" role="group" aria-label="Column to show">${STATES.map(([s, label, ic]) => `<button type="button" data-col="${s}" data-fk="col:${s}" aria-pressed="${S.col === s}">${icon(ic)}${label} <b>${list.filter(t => t.state === s).length}</b></button>`).join('')}</div>
        <div class="b-board-layout">
            <div class="b-board" data-col="${S.col}">
                ${hand.length || !filtersOn() ? lane('handoff', `${icon('clipboard-check')} Handoff: owner checklist`, hand, meter) : ''}
                ${!S.f.handoff ? lane('work', `${icon('folder-kanban')} Project work`, work, `<span class="b-lane-n">${plural(work.length, 'task')} across ${plural(new Set(work.map(t => t.projectId)).size, 'project')}</span>`) : ''}
                ${!list.length ? `<p class="b-empty-big">${icon('search-x')} No tasks match. <button type="button" class="b-linkbtn" data-act="clear-filters">Clear the filters</button></p>` : ''}
            </div>
            <aside class="b-activity" aria-labelledby="h-activity" tabindex="0">
                <h3 id="h-activity">${icon('history')} Activity</h3>
                ${hist.length ? `<ol class="b-feed">${hist.map(h => `<li><span class="b-av" style="background:${avatarColor(h.by)}" aria-hidden="true">${esc(initials(h.by))}</span><div><p><b>${esc(h.by)}</b> ${esc(h.text)}</p><small>${esc(h.name)} · <time datetime="${new Date(h.at).toISOString()}">${fmtWhen(h.at)}</time></small></div></li>`).join('')}</ol>`
                    : `<p class="b-muted">${S.boardState === 'live' ? 'No board changes yet.' : 'Board changes show here once the live board is on.'}</p>`}
            </aside>
        </div>`;
}
function lane(key, title, tasks, extra) {
    const closed = !!S.laneClosed[key];
    return `<section class="b-lane b-lane-${key}" aria-labelledby="lane-${key}">
        <header class="b-lane-head"><h3 id="lane-${key}"><button type="button" class="b-lane-toggle" data-act="lane" data-lane="${key}" data-fk="lane:${key}" aria-expanded="${!closed}"${closed ? '' : ` aria-controls="lane-body-${key}"`}>${icon('chevron-down', 'b-chev')}${title}</button></h3>${extra}</header>
        ${closed ? '' : `<div class="b-cols" id="lane-body-${key}">${STATES.map(([s, label, ic]) => column(key, s, label, ic, tasks.filter(t => t.state === s).sort(byDue))).join('')}</div>`}
    </section>`;
}
const LANE_CAP = 2;
function column(laneKey, s, label, ic, tasks) {
    // The Handoff lane shows its first few cards per column, so the project work stays in view.
    const capped = laneKey === 'handoff' && !S.laneAll && !S.f.handoff && tasks.length > LANE_CAP + 1;
    const shown = capped ? tasks.slice(0, LANE_CAP) : tasks;
    return `<div class="b-col" data-state="${s}" data-lane="${laneKey}">
        <h4 class="b-col-head s-${s}">${icon(ic)}<span>${label}</span><span class="b-col-n">${tasks.length}</span></h4>
        <ul class="b-cards" aria-label="${esc(label)}${laneKey === 'handoff' ? ', handoff' : ''}">${shown.map(card).join('') || '<li class="b-col-empty">Nothing here</li>'}</ul>
        ${capped ? `<button type="button" class="b-addtask b-more" data-act="lane-all" data-fk="more:${s}">${icon('chevrons-down')} Show ${tasks.length - LANE_CAP} more<span class="b-sr"> in ${esc(label)}, handoff</span></button>` : ''}
        ${laneKey === 'handoff' && S.laneAll && !S.f.handoff && s === 'todo' ? `<button type="button" class="b-addtask b-more" data-act="lane-all" data-fk="more:${s}">${icon('chevrons-up')} Show fewer</button>` : ''}
        ${laneKey === 'work' && canEdit() ? `<button type="button" class="b-addtask" data-act="new-task" data-state="${s}" data-fk="add:${s}">${icon('plus')} Add task<span class="b-sr"> to ${esc(label)}</span></button>` : ''}
    </div>`;
}
function card(t) {
    const p = S.pm.get(t.projectId);
    const cl = clFor(t);
    const edit = canEdit();
    return `<li class="b-card${t.state === 'done' ? ' is-done' : ''}${isOverdue(t) ? ' is-over' : ''}${edit ? ' is-movable' : ''}"${edit ? ' draggable="true"' : ''} data-task="${esc(t.id)}">
        <div class="b-card-top">${cl ? `<span class="b-proj is-handoff">${icon('clipboard-check')}Checklist ${clOrder(t.id) + 1}<span class="b-sr"> of ${S.cl.length}</span></span><span class="b-time">${icon('clock')}${esc(cl.time)}</span>` : projChip(p)}
            ${edit ? `<button type="button" class="b-move" data-act="move-menu" data-id="${esc(t.id)}" data-fk="move:${esc(t.id)}" aria-haspopup="menu" aria-expanded="false" title="Move to another column">${icon('arrow-right-left')}<span class="b-sr">Move “${esc(t.title)}”</span></button>` : ''}</div>
        <button type="button" class="b-card-title" data-open-task="${esc(t.id)}" data-fk="task:${esc(t.id)}"${edit ? ' aria-keyshortcuts="[ ]"' : ''}>${esc(t.title)}</button>
        <div class="b-card-meta">${cl ? `<span class="b-card-hold">${icon('hand')}<span>${cl.done ? `Done by <b>${esc(cl.state?.by || '')}</b>` : `Has it now: <b>${esc(cl.state?.holder || 'nobody yet')}</b>`}</span></span>` : ''}<span class="b-labels">${labelChips(t.labels.filter(l => l !== 'handoff' || !cl))}</span>${dueBadge(t)}${avatar(t.assignee)}</div>
    </li>`;
}

// ---- writes -------------------------------------------------------------------------------------------------------------------
const TASK_KEYS = ['title', 'projectId', 'state', 'assignee', 'due', 'labels', 'detail', 'createdBy'];
function taskRecord(t, patch = {}) {
    const r = {};
    TASK_KEYS.forEach(k => { r[k] = t[k]; });
    Object.assign(r, patch);
    return {
        title: String(r.title || '').trim().slice(0, 140), projectId: String(r.projectId || '').slice(0, 48), state: STATE[r.state] ? r.state : 'todo',
        assignee: String(r.assignee || '').slice(0, 128), due: /^\d{4}-\d{2}-\d{2}$/.test(r.due || '') ? r.due : '',
        labels: [...new Set((r.labels || []).map(l => String(l).slice(0, 24)).filter(Boolean))].slice(0, 8), detail: String(r.detail || '').slice(0, 4000),
        createdBy: String(r.createdBy || me().name).slice(0, 60), ...stamp(),
    };
}
// Projects are always written whole: the snapshot merged with what the board already has, plus the change.
const PROJECT_KEYS = ['note', 'next', 'custom', 'name', 'area', 'summary', 'pages', 'owner', 'verifiedAt', 'verifiedBy'];
function projectRecord(p, patch = {}) {
    const live = p.live || {};
    const r = { status: p.status, health: p.health, progress: Math.max(0, Math.min(100, Math.round(+p.progress || 0))) };
    PROJECT_KEYS.forEach(k => { if (live[k] != null && live[k] !== '') r[k] = live[k]; });
    Object.assign(r, patch);
    PROJECT_KEYS.forEach(k => { if (r[k] == null || r[k] === '') delete r[k]; });
    return { ...r, ...stamp() };
}
function log(project, text, name) {
    const p = S.pm.get(project);
    return store.addHistory({ project: histId(project), name: String(name || (p?.handoff ? 'Handoff' : p?.name) || project).slice(0, 80), text: String(text).slice(0, 300), ...stamp() });
}
async function syncCheck(clId, done, patch = {}) {
    const cur = S.board.checklist?.[clId] || {};
    await store.setCheck(clId, { done: !!done, holder: String(patch.holder ?? cur.holder ?? '').slice(0, 80), note: String(patch.note ?? cur.note ?? '').slice(0, 500), ...stamp() });
}
async function moveTask(id, state) {
    if (!canEdit()) return;
    const t = S.tasks.find(x => x.id === id);
    if (!t || t.state === state) return;
    try {
        await store.set('tasks/' + id, taskRecord(t, { state }));
        if (id.startsWith('cl-')) await syncCheck(id.slice(3), state === 'done');
        await log(t.projectId, `moved “${t.title}” to ${STATE[state].label}`);
        announce(`Moved “${t.title}” to ${STATE[state].label}.`);
    } catch (e) { fail(e); }
}
function openMoveMenu(btn) {
    closeMenus();
    const id = btn.dataset.id;
    const t = S.tasks.find(x => x.id === id);
    const menu = document.createElement('div');
    menu.className = 'b-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', 'Move to');
    menu.innerHTML = STATES.map(([s, label, ic]) => `<button type="button" role="menuitemradio" aria-checked="${t.state === s}" data-act="move" data-id="${esc(id)}" data-state="${s}" tabindex="-1">${icon(ic)}${esc(label)}</button>`).join('');
    btn.after(menu);
    btn.setAttribute('aria-expanded', 'true');
    icons();
    const items = $$('[role=menuitemradio]', menu);
    (items.find(i => i.getAttribute('aria-checked') === 'false') || items[0]).focus();
    menu.addEventListener('keydown', e => {
        const i = items.indexOf(document.activeElement);
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus(); }
        else if (e.key === 'Home') { e.preventDefault(); items[0].focus(); }
        else if (e.key === 'End') { e.preventDefault(); items.at(-1).focus(); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenus(); btn.focus(); }
        else if (e.key === 'Tab') closeMenus();
    });
}
function closeMenus() { $$('.b-menu').forEach(m => { m.previousElementSibling?.setAttribute('aria-expanded', 'false'); m.remove(); }); }

// ---- Table ------------------------------------------------------------------------------------------------------------------------
const COLS = [['name', 'Project'], ['level', 'Level'], ['status', 'Status'], ['health', 'Health'], ['progress', 'Progress'], ['owner', 'Owner'], ['open', 'Open tasks'], ['updated', 'Last update']];
const SORTV = {
    name: p => p.name.toLowerCase(), level: p => LEVEL_IX[score(p).level.id] * 10 + score(p).passed, status: p => Object.keys(STATUS).indexOf(p.status),
    health: p => ['off-track', 'at-risk', 'on-track'].indexOf(healthOf(p)), progress: p => +p.progress || 0, owner: p => p.owner ? personName(p.owner).toLowerCase() : '~',
    open: p => openCount(p.id), updated: p => updatesOf(p.id)[0]?.at || 0,
};
function renderTable() {
    const list = S.projects.filter(matchProject);
    const { key, dir } = S.sort;
    const sv = SORTV[key] || SORTV.level;
    list.sort((a, b) => { const x = sv(a), y = sv(b); return (x < y ? -1 : x > y ? 1 : 0) * dir || a.name.localeCompare(b.name); });
    const stale = S.projects.filter(p => { const u = updatesOf(p.id)[0]; return p.status !== 'retired' && u && daysSince(u.at) > STALE_DAYS; }).length;
    $('#v-table').innerHTML = viewHead('table', 'Projects', `Every part of the site as one row, with its handoff level. Open a row for how it works, notes, its tasks and what it needs for the next level${canEdit() ? ', and to post a status update' : ''}. ${stale ? `<span class="b-stale">${icon('clock-alert')} ${plural(stale, 'project')} without an update for over three weeks</span>` : ''}`)
        + `<div class="b-tablewrap"><table class="b-table b-ptable">
            <caption class="b-sr">Projects, sorted by ${esc((COLS.find(c => c[0] === key) || COLS[1])[1])} ${dir > 0 ? 'ascending' : 'descending'}</caption>
            <thead><tr>${COLS.map(([k, label]) => `<th scope="col"${k === key ? ` aria-sort="${dir > 0 ? 'ascending' : 'descending'}"` : ''} class="c-${k}"><button type="button" data-act="sort" data-key="${k}" data-fk="sort:${k}">${label}${icon(k === key ? (dir > 0 ? 'arrow-up' : 'arrow-down') : 'arrow-up-down', k === key ? '' : 'b-faint')}</button></th>`).join('')}</tr></thead>
            <tbody>${list.map(projectRow).join('') || `<tr><td colspan="8" class="b-muted">No projects match the filters.</td></tr>`}</tbody>
        </table></div>`;
}
function lastUpdateCell(p) {
    const u = updatesOf(p.id)[0];
    if (!u) return `<span class="b-muted">No update yet</span>`;
    return daysSince(u.at) > STALE_DAYS ? `<span class="b-stale" title="No update for more than three weeks">${icon('clock-alert')}${esc(ago(u.at))}<span class="b-sr"> (no update in over three weeks)</span></span>` : `<span>${esc(ago(u.at))}</span>`;
}
function projectRow(p) {
    const open = S.open.has(p.id);
    const sc = score(p);
    return `<tr class="b-prow${open ? ' is-open' : ''}" id="row-${esc(p.id)}">
        <th scope="row" class="c-name"><button type="button" class="b-expand" data-act="expand" data-id="${esc(p.id)}" data-fk="exp:${esc(p.id)}" aria-expanded="${open}"${open ? ` aria-controls="exp-${esc(p.id)}"` : ''}>${icon('chevron-right', 'b-chev')}<span>${esc(p.name)}</span></button><small>${esc(p.area)}</small></th>
        <td data-label="Level">${levelBadge(sc.level, '<span class="b-sr">Handoff level: </span>')}</td>
        <td data-label="Status">${statusPill(p.status)}</td>
        <td data-label="Health">${healthBadge(healthOf(p))}</td>
        <td data-label="Progress" class="c-progress">${progressBar(p.progress, `Progress of ${p.name}`)}</td>
        <td data-label="Owner">${ownerChip(p.owner, true)}</td>
        <td data-label="Open tasks" class="c-open">${openCount(p.id)}</td>
        <td data-label="Last update">${lastUpdateCell(p)}</td>
    </tr>${open ? `<tr class="b-exp" id="exp-${esc(p.id)}"><td colspan="8">${projectDetail(p)}</td></tr>` : ''}`;
}
function projectDetail(p) {
    const ups = updatesOf(p.id);
    const last = ups[0];
    const sc = score(p);
    const edit = canEdit();
    const tasks = S.tasks.filter(t => t.projectId === p.id).sort((a, b) => (a.state === 'done') - (b.state === 'done') || byDue(a, b));
    const sel = (name, entries, cur) => `<select name="${name}">${entries.map(([k, label]) => `<option value="${esc(k)}"${k === cur ? ' selected' : ''}>${esc(label)}</option>`).join('')}</select>`;
    const hid = esc(p.id);
    const ownerOpts = [['', 'No owner'], ...Object.entries(S.people).map(([k, v]) => [k, v.name + (v.role ? ` (${v.role})` : '')])];
    if (p.owner && !S.people[p.owner]) ownerOpts.push([p.owner, personName(p.owner)]);
    return `<div class="b-exp-grid">
        <div class="b-exp-main">
            <p class="b-summary">${rich(p.summary)}</p>
            ${p.live?.note ? `<div class="b-note">${icon('megaphone')}<div><p>${rich(p.live.note)}</p><small>${esc(p.live.by || '')}${p.live.at ? `, ${fmtWhen(p.live.at)}` : ''}</small></div></div>` : ''}
            ${p.howItWorks ? `<h4>How it works</h4><p>${rich(p.howItWorks)}</p>` : ''}
            ${p.notes?.length ? `<h4>Notes for whoever picks it up</h4><ul>${p.notes.map(n => `<li>${rich(n)}</li>`).join('')}</ul>` : ''}
            <h4>Tasks <span class="b-muted">${openCount(p.id)} open</span></h4>
            ${tasks.length ? `<ul class="b-tasklist">${tasks.map(t => `<li>${statePill(t.state)}<button type="button" class="b-linkbtn" data-open-task="${esc(t.id)}" data-fk="task:${esc(t.id)}">${esc(t.title)}</button>${dueBadge(t)}${avatar(t.assignee)}</li>`).join('')}</ul>` : '<p class="b-muted">No tasks.</p>'}
            ${edit ? `<button type="button" class="b-btn b-btn-sm" data-act="new-task" data-project="${hid}" data-fk="addp:${hid}">${icon('plus')} Add a task to this project</button>` : ''}
            ${p.owner_actions?.length ? `<h4>Only an account owner can</h4><ul>${p.owner_actions.map(n => `<li>${rich(n)}</li>`).join('')}</ul>` : ''}
            ${p.pages?.length ? `<h4>Pages</h4><p class="b-pages">${p.pages.map(pageLink).join('')}</p>` : ''}
            ${p.lastLive ? `<p class="b-meta">${icon('rocket')} Last published: ${esc(p.lastLive)}</p>` : ''}
        </div>
        <div class="b-exp-side">
            <div class="b-card-box b-levelbox">
                <h4>${icon('medal')} Handoff level</h4>
                <div class="b-row">${levelBadge(sc.level, '<span class="b-sr">Handoff level: </span>')}${verifiedStamp(p)}${edit ? `<button type="button" class="b-btn b-btn-sm" data-act="verify" data-id="${hid}" data-fk="verify:${hid}">${icon('badge-check')} I verified this</button>` : ''}</div>
                <div class="b-owner-line">${ownerChip(p.owner)}</div>
                <ul class="b-criteria">${CRITERIA.map(cr => { const v = sc.r[cr.id]; return `<li class="is-${v === null ? 'run' : v ? 'pass' : 'fail'}">${icon(v === null ? 'loader' : v ? 'check-circle-2' : 'x-circle', v === null ? 'b-spin' : '')}<span>${esc(cr.label)}<span class="b-sr"> ${v === null ? 'still checking' : v ? 'passes' : 'fails'}</span></span></li>`; }).join('')}</ul>
                <p class="b-reach">${icon(sc.next ? 'arrow-up-right' : 'trophy')} ${esc(toReach(sc))}</p>
            </div>
            <div class="b-card-box">
                <h4>${icon('megaphone')} Latest status update</h4>
                ${last ? `<p>${healthBadge(last.health)}</p><p>${rich(last.text)}</p><p class="b-meta">${esc(last.by)}, ${fmtWhen(last.at)}${daysSince(last.at) > STALE_DAYS ? ` · <span class="b-stale">${icon('clock-alert')}over three weeks old</span>` : ''}</p>` : '<p class="b-muted">No update yet.</p>'}
                ${ups.length > 1 ? `<details class="b-older"><summary>Earlier updates (${ups.length - 1})</summary><ol>${ups.slice(1).map(u => `<li>${healthBadge(u.health)} ${rich(u.text)} <span class="b-meta">${esc(u.by)}, ${fmtWhen(u.at)}</span></li>`).join('')}</ol></details>` : ''}
            </div>
            ${edit ? `<form class="b-form b-card-box" data-form="update" data-id="${hid}">
                <fieldset class="b-radios"><legend>Post an update: how is it going?</legend>
                    ${Object.entries(UPD).map(([k, v]) => `<label class="hl-${v.hl}"><input type="radio" name="health" value="${k}"${k === (last?.health || H2U[p.health]) ? ' checked' : ''}>${icon(v.icon)}${v.label}</label>`).join('')}
                </fieldset>
                <label class="b-field"><span>What changed (starts from the last update)</span><textarea name="text" rows="3" maxlength="1000" required>${esc(last?.text || '')}</textarea></label>
                <button class="b-btn b-btn-primary b-btn-sm" data-fk="post:${hid}">${icon('send')} Post update</button>
            </form>
            <form class="b-form b-card-box" data-form="fields" data-id="${hid}">
                <fieldset><legend>Project fields</legend>
                    <div class="b-grid2">
                        <label class="b-field"><span>Status</span>${sel('status', Object.entries(STATUS).map(([k, v]) => [k, v.label]), p.status)}</label>
                        <label class="b-field"><span>Owner</span>${sel('owner', ownerOpts, p.owner)}</label>
                    </div>
                    <label class="b-field"><span>Progress <output>${Math.round(+p.progress || 0)}%</output></span><input type="range" name="progress" min="0" max="100" step="5" value="${Math.round(+p.progress || 0)}"></label>
                    <button class="b-btn b-btn-sm" data-fk="fields:${hid}">${icon('save')} Save fields</button>
                </fieldset>
            </form>` : ''}
        </div>
    </div>`;
}
async function postUpdate(form) {
    const pid = form.dataset.id, p = S.pm.get(pid);
    const fd = new FormData(form);
    const health = String(fd.get('health')), text = String(fd.get('text') || '').trim().slice(0, 1000);
    if (!text || !UPD[health]) { form.reportValidity(); return; }
    try {
        await store.push('updates/' + pid, { health, text, ...stamp() });
        await store.setProject(pid, projectRecord(p, { health: U2H[health] }));
        await log(pid, `posted an update: ${UPD[health].label}`);
        toast('Update posted.');
    } catch (e) { fail(e); }
}
async function saveFields(form) {
    const pid = form.dataset.id, p = S.pm.get(pid);
    const fd = new FormData(form);
    const data = { status: String(fd.get('status')), owner: String(fd.get('owner') || ''), progress: Math.max(0, Math.min(100, +fd.get('progress') || 0)) };
    const ch = [];
    if (data.status !== p.status) ch.push(`status → ${STATUS[data.status].label}`);
    if (data.owner !== p.owner) ch.push(`owner → ${data.owner ? personName(data.owner) : 'nobody'}`);
    if (data.progress !== Math.round(+p.progress)) ch.push(`progress ${Math.round(+p.progress)}% → ${data.progress}%`);
    if (!ch.length) { toast('Nothing changed.'); return; }
    try {
        await store.setProject(pid, projectRecord({ ...p, status: data.status, progress: data.progress }, { owner: data.owner }));
        await log(pid, ch.join('; '));
        toast('Project saved.');
    } catch (e) { fail(e); }
}
async function verify(pid) {
    const p = S.pm.get(pid);
    try {
        await store.setProject(pid, projectRecord(p, { verifiedAt: Date.now(), verifiedBy: me().name }));
        await log(pid, 'verified the notes');
        toast('Marked as verified.');
    } catch (e) { fail(e); }
}

// ---- Timeline ---------------------------------------------------------------------------------------------------------------------------
const WEEKS = 10;
const narrow = matchMedia('(max-width: 760px)');
narrow.addEventListener('change', () => { if (S.view === 'timeline') renderView(); });
function renderTimeline() {
    const start = mondayOf(new Date());
    const cols = [{ key: 'early', label: 'Earlier', sub: 'overdue' }, ...Array.from({ length: WEEKS }, (_, i) => {
        const d = addDays(start, i * 7);
        return { key: isoOf(d), from: isoOf(d), to: isoOf(addDays(d, 6)), label: d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }), sub: i === 0 ? `this week · today ${new Date().toLocaleDateString(undefined, { weekday: 'short' })}` : i === 1 ? 'next week' : '' };
    })];
    const end = isoOf(addDays(start, WEEKS * 7 - 1));
    const all = S.tasks.filter(matchTask);
    const dated = all.filter(t => t.due && t.due <= end && (t.due >= cols[1].from || t.state !== 'done'));
    const colOf = t => t.due < cols[1].from ? 0 : cols.findIndex(c => c.from && t.due >= c.from && t.due <= c.to);
    const later = all.filter(t => t.due && t.due > end).length, undated = all.filter(t => !t.due && t.state !== 'done').length;
    const pids = [...new Set(dated.map(t => t.projectId))].sort((a, b) => (a === 'handoff' ? -1 : b === 'handoff' ? 1 : (S.pm.get(a)?.area + S.pm.get(a)?.name).localeCompare(S.pm.get(b)?.area + S.pm.get(b)?.name)));
    const chip = t => `<button type="button" class="b-tl-chip s-${t.state}${isOverdue(t) ? ' is-over' : ''}" data-open-task="${esc(t.id)}" data-fk="tl:${esc(t.id)}" title="${esc(t.title)} · ${esc(STATE[t.state].label)} · due ${esc(fmtDue(t.due))}">${icon(isOverdue(t) ? 'alert-circle' : STATE[t.state].icon)}<span class="b-tl-t">${esc(t.title)}</span><span class="b-sr">, ${esc(STATE[t.state].label)}, due ${esc(fmtDue(t.due))}${isOverdue(t) ? ', overdue' : ''}</span></button>`;
    const now = new Date();
    const x = (1 + ((now.getDay() + 6) % 7 + now.getHours() / 24) / 7) / cols.length;
    const note = `<p class="b-meta">${icon('info')} ${plural(dated.length, 'task')} with a due date in this window${later ? `, ${later} due later` : ''}${undated ? `; ${plural(undated, 'open task')} ${undated === 1 ? 'has' : 'have'} no due date (see the <a href="#board">Board</a>)` : ''}.</p>`;
    let body;
    if (!dated.length) body = `<p class="b-empty-big">${icon('calendar-x')} No tasks have a due date yet.${canEdit() ? ' Open a task and set one.' : ''}</p>`;
    else if (narrow.matches) {
        body = `<ol class="b-tl-list">${cols.map((c, i) => { const ts = dated.filter(t => colOf(t) === i).sort(byDue); return ts.length ? `<li><h3>${esc(c.label)}${c.sub ? ` <span>${c.sub}</span>` : ''}</h3><ul>${ts.map(t => `<li>${chip(t)}<span class="b-tl-proj">${projChip(S.pm.get(t.projectId))}</span></li>`).join('')}</ul></li>` : ''; }).join('')}</ol>`;
    } else {
        body = `<div class="b-tl" style="--cols:${cols.length}">
            <div class="b-tl-row b-tl-head" aria-hidden="true"><div class="b-tl-name">Project</div>${cols.map((c, i) => `<div class="b-tl-wk${i === 1 ? ' is-now' : ''}">${esc(c.label)}${c.sub ? `<small>${c.sub}</small>` : ''}</div>`).join('')}</div>
            ${pids.map(pid => `<div class="b-tl-row" role="group" aria-label="${esc(S.pm.get(pid)?.name || pid)}"><div class="b-tl-name">${projChip(S.pm.get(pid))}</div>${cols.map((c, i) => `<div class="b-tl-cell${i === 0 ? ' is-early' : ''}">${dated.filter(t => t.projectId === pid && colOf(t) === i).sort(byDue).map(chip).join('')}</div>`).join('')}</div>`).join('')}
            <div class="b-tl-today" style="--x:${x.toFixed(4)}" aria-hidden="true"></div>
        </div>`;
    }
    $('#v-timeline').innerHTML = viewHead('timeline', 'Timeline', `Tasks with a due date over the next ${WEEKS} weeks, one row per project. The gold line marks today; overdue tasks sit in the first column.`) + body + note;
}

// ---- My work ---------------------------------------------------------------------------------------------------------------------------
function renderMyWork() {
    const who = S.viewAs || '';
    const mine = S.tasks.filter(t => (t.assignee || '') === who && matchTask(t));
    const t0 = today(), wk = mondayOf(new Date()), nextWk = isoOf(addDays(wk, 7)), after = isoOf(addDays(wk, 14));
    const groups = [
        ['Overdue', 'alert-circle', t => t.state !== 'done' && t.due && t.due < t0],
        ['This week', 'calendar-check', t => t.state !== 'done' && t.due && t.due >= t0 && t.due < nextWk],
        ['Next week', 'calendar', t => t.state !== 'done' && t.due && t.due >= nextWk && t.due < after],
        ['Later', 'calendar-range', t => t.state !== 'done' && t.due && t.due >= after],
        ['No due date', 'calendar-off', t => t.state !== 'done' && !t.due],
    ];
    const edit = canEdit();
    const item = t => `<li class="b-mw-item${t.state === 'done' ? ' is-done' : ''}">
        ${edit ? `<input type="checkbox" class="b-mw-check" data-act="toggle-done" data-id="${esc(t.id)}" data-fk="done:${esc(t.id)}" aria-label="Done: ${esc(t.title)}"${t.state === 'done' ? ' checked' : ''}>` : `<span class="b-mw-dot s-${t.state}">${icon(STATE[t.state].icon)}</span>`}
        <div class="b-mw-main"><button type="button" class="b-mw-title" data-open-task="${esc(t.id)}" data-fk="task:${esc(t.id)}">${esc(t.title)}</button>
        <div class="b-mw-meta">${projChip(S.pm.get(t.projectId))}${statePill(t.state)}${dueBadge(t)}${labelChips(t.labels.filter(l => l !== 'handoff' || t.projectId !== 'handoff'))}</div></div></li>`;
    const open = mine.filter(t => t.state !== 'done').length;
    const done = mine.filter(t => t.state === 'done');
    const opts = [['', 'Unassigned tasks'], ...Object.entries(S.people).map(([k, p]) => [k, p.name + (k === me().uid ? ' (you)' : '')])];
    $('#v-mywork').innerHTML = viewHead('mywork', 'My work', who ? `${plural(open, 'open task')} assigned to ${esc(personName(who))}, by when they are due.${edit ? ' Tick one when it is done.' : ''}`
        : `${plural(open, 'open task')} nobody has picked up yet.${Object.keys(S.people).length ? '' : ' Team members appear here once they have signed in.'}`,
        `<label class="b-fsel"><span>Showing work for</span><select id="b-viewas" data-fk="viewas">${opts.map(([k, l]) => `<option value="${esc(k)}"${k === who ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`)
        + groups.map(([label, ic, fn]) => { const ts = mine.filter(fn).sort(byDue); return ts.length ? `<section class="b-mw-group" aria-labelledby="mw-${slugify(label)}"><h3 id="mw-${slugify(label)}" class="${label === 'Overdue' ? 'is-over' : ''}">${icon(ic)} ${label} <span class="b-col-n">${ts.length}</span></h3><ul class="b-mw">${ts.map(item).join('')}</ul></section>` : ''; }).join('')
        + (open ? '' : `<p class="b-empty-big">${icon('party-popper')} Nothing open here.</p>`)
        + (done.length ? `<details class="b-mw-done"><summary>${icon('check-circle-2')} Done (${done.length})</summary><ul class="b-mw">${done.map(item).join('')}</ul></details>` : '');
}

// ---- Inbox (triage) --------------------------------------------------------------------------------------------------------------------
function renderInbox() {
    const all = Object.entries(S.board.triage || {}).map(([key, r]) => ({ ...r, key })).sort((a, b) => b.at - a.at);
    const shown = all.filter(r => r.state === S.inboxTab);
    const count = s => all.filter(r => r.state === s).length;
    const edit = canEdit();
    const pageOpts = [...new Set(pages.map(p => p.group))].map(g => `<optgroup label="${esc(g)}">${pages.filter(p => p.group === g).map(p => `<option value="${esc(p.file)}">${esc(p.title)}</option>`).join('')}</optgroup>`).join('');
    const report = r => {
        const task = r.taskId && S.tasks.find(t => t.id === r.taskId);
        const st = TRIAGE[r.state] || TRIAGE.new;
        return `<li class="b-report" id="rep-${esc(r.key)}">
            <div class="b-report-head"><h4>${esc(r.title)}</h4><span class="b-tstate t-${esc(r.state)}">${icon(st[1])}${st[0]}</span></div>
            <p class="b-meta">${r.page ? `${icon('file')} ${pageLink(r.page)} · ` : ''}${esc(r.by)}, ${fmtWhen(r.at)}</p>
            ${r.detail ? `<p>${rich(r.detail)}</p>` : ''}
            <div class="b-row">${task ? `<button type="button" class="b-btn b-btn-sm" data-open-task="${esc(task.id)}">${icon('square-check')} Open its task</button>` : ''}
            ${edit ? (r.state === 'new' ? `
                <button type="button" class="b-btn b-btn-sm b-btn-primary" data-act="triage-accept" data-key="${esc(r.key)}" data-fk="acc:${esc(r.key)}">${icon('check')} Accept<span class="b-sr">: ${esc(r.title)}</span></button>
                <button type="button" class="b-btn b-btn-sm" data-act="triage" data-state="declined" data-key="${esc(r.key)}" data-fk="dec:${esc(r.key)}">${icon('x')} Decline<span class="b-sr">: ${esc(r.title)}</span></button>
                <button type="button" class="b-btn b-btn-sm" data-act="triage" data-state="duplicate" data-key="${esc(r.key)}" data-fk="dup:${esc(r.key)}">${icon('copy')} Mark duplicate<span class="b-sr">: ${esc(r.title)}</span></button>`
            : `<button type="button" class="b-btn b-btn-sm b-btn-quiet" data-act="triage" data-state="new" data-key="${esc(r.key)}" data-fk="reo:${esc(r.key)}">${icon('rotate-ccw')} Back to new<span class="b-sr">: ${esc(r.title)}</span></button>`) : ''}</div>
        </li>`;
    };
    const form = canReport() ? `<form class="b-panel b-form" data-form="report">
            <h3>${icon('bug')} Report a problem</h3>
            <label class="b-field"><span>What is wrong (short)</span><input name="title" required maxlength="140" placeholder="e.g. Kiki page: video does not play on Android"></label>
            <label class="b-field"><span>Page</span><select name="page"><option value="">Not sure / the whole site</option>${pageOpts}</select></label>
            <label class="b-field"><span>Details (what you did, what you saw, which device)</span><textarea name="detail" rows="4" maxlength="2000"></textarea></label>
            <button class="b-btn b-btn-primary" data-fk="report-send">${icon('send')} Send to the inbox</button>
            <p class="b-meta">${icon('eye')} Anyone with the link can read the board; leave out passwords and personal details.</p>
        </form>` : `<div class="b-panel"><h3>${icon('bug')} Report a problem</h3>
            <p class="b-muted">${S.boardState !== 'live' ? 'Reports open once the live board is on.' : 'Anyone with a Google account can report a problem after signing in.'}</p>
            ${!S.auth.user && !DEMO && S.boardState === 'live' ? `<button type="button" class="b-btn b-btn-primary" data-act="signin">${icon('log-in')} Sign in to report a problem</button>` : ''}</div>`;
    $('#v-inbox').innerHTML = viewHead('inbox', 'Inbox', 'Problems people report land here first. A team member accepts one to turn it into a task on the board, or declines it or marks it as a duplicate.')
        + `<div class="b-inbox">${form}
            <div class="b-panel">
                <div class="b-seg" role="group" aria-label="Show reports">${Object.entries(TRIAGE).map(([k, [label, ic]]) => `<button type="button" data-tab="${k}" data-fk="tab:${k}" aria-pressed="${S.inboxTab === k}">${icon(ic)}${label} <b>${count(k)}</b></button>`).join('')}</div>
                ${shown.length ? `<ul class="b-reports">${shown.map(report).join('')}</ul>` : `<p class="b-empty-big">${icon('inbox')} ${S.inboxTab === 'new' ? 'Nothing waiting for triage.' : 'Nothing here.'}</p>`}
            </div>
        </div>`;
}
const triageRecord = (r, patch) => ({ title: String(r.title || '').slice(0, 140), detail: String(r.detail || '').slice(0, 2000), page: String(r.page || '').slice(0, 80), state: r.state, ...(r.taskId ? { taskId: r.taskId } : {}), ...patch, ...stamp() });
async function acceptReport(key) {
    const r = S.board.triage[key];
    const proj = S.projects.find(p => p.pages?.includes(r.page) && p.status !== 'retired') || S.pm.get('site-infrastructure');
    const id = newId();
    try {
        await store.set('tasks/' + id, taskRecord({ title: r.title, projectId: proj.id, state: 'todo', assignee: '', due: '', labels: ['bug', 'from-inbox'], detail: `${r.detail || ''}\n\nReported by ${r.by}${r.page ? ' on ' + r.page : ''}.`.trim(), createdBy: me().name }));
        await store.set('triage/' + key, triageRecord(r, { state: 'accepted', taskId: id }));
        await log(proj.id, `accepted a report as a task: “${r.title}”`);
        toast(`Accepted: new task in ${proj.name}.`);
    } catch (e) { fail(e); }
}

// ---- Handbook ------------------------------------------------------------------------------------------------------------------------------
function renderHandbook() {
    const done = S.cl.filter(c => c.done).length;
    const notice = S.board.notice;
    const edit = canEdit();
    const a = S.auth;
    $('#v-handbook').innerHTML = viewHead('handbook', 'Handbook', 'How the site works, the owner checklist, how-tos, rules, accounts, every page and team access. The live checks run from this browser.')
        + `<div class="b-hb">
            <nav class="b-hb-toc" aria-label="Handbook contents"><ol>${HB.map(([k, label, ic]) => `<li><a href="#handbook/${k}"${S.sub === k ? ' aria-current="location"' : ''}>${icon(ic)}<span>${esc(label)}</span>${k === 'checklist' ? `<em>${done}/${S.cl.length}</em>` : k === 'pages' ? `<em>${pages.length}</em>` : ''}</a></li>`).join('')}</ol></nav>
            <div class="b-hb-body">
                <section id="hb-start" aria-labelledby="hbh-start" class="b-panel"><h3 id="hbh-start" tabindex="-1">${icon('flag')} Start here</h3>
                    <div class="b-notice">${icon('message-square-text')}<div class="b-notice-body"><div class="b-sechead"><h4>Handoff note</h4>${edit && !S.editNotice ? `<button type="button" class="b-btn b-btn-sm" data-act="edit-notice" data-fk="edit-notice">${icon('pencil')} Edit</button>` : ''}</div>
                        ${S.editNotice && edit ? `<form class="b-form" data-form="notice"><label class="b-field"><span>Note for whoever picks this up</span><textarea name="text" rows="6" maxlength="4000" data-fk="notice-text">${esc(notice?.text ?? content.notice)}</textarea></label>
                            <div class="b-row"><button class="b-btn b-btn-primary b-btn-sm">${icon('save')} Save</button><button type="button" class="b-btn b-btn-sm" data-act="cancel-notice">Cancel</button></div></form>`
                        : `<p>${rich(notice?.text ?? content.notice)}</p><p class="b-meta">${notice ? `Updated by ${esc(notice.by)}, ${fmtWhen(notice.at)}` : `From the ${esc(content.snapshotDate)} snapshot`}</p>`}</div></div>
                    <h4>Where to start</h4><ol class="b-steps">${content.startSteps.map(s => `<li>${rich(s)}</li>`).join('')}</ol></section>
                <section id="hb-checklist" aria-labelledby="hbh-checklist" class="b-panel">${checklistBlock()}</section>
                <section id="hb-how" aria-labelledby="hbh-how" class="b-panel"><h3 id="hbh-how" tabindex="-1">${icon('network')} How the site works</h3>
                    <p class="b-lead">No server and no build step: plain HTML, CSS and JavaScript published by GitHub Pages. Big files and live data live in other services. Each box shows whether that part answers right now, and its last 30 days (grey = no data).</p>
                    <div class="b-arch" id="hb-arch"></div></section>
                <section id="hb-checks" aria-labelledby="hbh-checks" class="b-panel"><div class="b-sechead"><h3 id="hbh-checks" tabindex="-1">${icon('activity')} Live checks</h3><button type="button" class="b-btn b-btn-sm" data-act="recheck" data-fk="recheck">${icon('refresh-cw')} Run again</button></div>
                    <p class="b-lead" id="hb-checktime"></p><ul class="b-checks" id="hb-checkrows"></ul></section>
                <section id="hb-changes" aria-labelledby="hbh-changes" class="b-panel"><h3 id="hbh-changes" tabindex="-1">${icon('git-commit-horizontal')} Recent changes</h3>
                    <div class="b-cols2"><div><h4>${icon('github')} Published to the site</h4><ul class="b-commits" id="hb-commits-list"></ul><a class="b-link" href="${GH}/commits/main" target="_blank" rel="noopener">${icon('external-link')} Full history on GitHub</a></div>
                    <div><h4>${icon('history')} Board activity</h4><ul class="b-commits b-hist-list">${Object.values(S.board.history || {}).sort((x, y) => y.at - x.at).slice(0, 15).map(h => `<li><b>${esc(h.name)}</b><span>${esc(h.text)}</span><small>${esc(h.by)}, ${fmtWhen(h.at)}</small></li>`).join('') || `<li class="b-muted">${S.boardState === 'live' ? 'No board changes yet.' : 'Board changes show here once the live board is on.'}</li>`}</ul></div></div></section>
                <section id="hb-manage" aria-labelledby="hbh-manage" class="b-panel"><h3 id="hbh-manage" tabindex="-1">${icon('sliders-horizontal')} Manage the site</h3>
                    <p class="b-lead">Small text fixes can be made right on GitHub (it publishes in about a minute). Bigger changes are made on a computer with the site folder and published with a script; see How to….</p>
                    <div class="b-cols2"><div class="b-card-box"><h4>${icon('file-pen-line')} Change a page on GitHub</h4>
                        <label class="b-field"><span>Page</span><select id="b-edit-page"><option value="">Choose a page…</option>${[...new Set(pages.map(p => p.group))].map(g => `<optgroup label="${esc(g)}">${pages.filter(p => p.group === g).map(p => `<option value="${esc(p.file)}">${esc(p.title)} (${esc(p.file)})</option>`).join('')}</optgroup>`).join('')}</select></label>
                        <div class="b-row"><button type="button" class="b-btn b-btn-primary b-btn-sm" data-act="open-edit">${icon('pencil')} Edit on GitHub</button><button type="button" class="b-btn b-btn-sm" data-act="open-history">${icon('history')} Its history</button></div>
                        <p class="b-meta">You need write access to the GiveaPaw organisation. Never edit the menu, footer or the block between <code>meta:start</code> and <code>meta:end</code> by hand; they are generated.</p></div>
                    <div class="b-card-box"><h4>${icon('link')} Shortcuts</h4><ul class="b-shortcuts">
                        <li><a href="${GH}" target="_blank" rel="noopener">${icon('github')} The repository</a></li>
                        <li><a href="${GH}/upload/main" target="_blank" rel="noopener">${icon('upload')} Upload a file (small images, PDFs)</a></li>
                        <li><a href="${GH}/actions" target="_blank" rel="noopener">${icon('rocket')} Publishing runs (did it go live?)</a></li>
                        <li><a href="${GH}/settings/pages" target="_blank" rel="noopener">${icon('settings')} GitHub Pages settings</a></li>
                        <li><a href="https://console.firebase.google.com/project/give-a-paw/database" target="_blank" rel="noopener">${icon('database')} Firebase database and rules</a></li>
                        <li><a href="design-log.html">${icon('notebook-pen')} Team design log</a></li></ul></div></div></section>
                <section id="hb-howto" aria-labelledby="hbh-howto" class="b-panel"><h3 id="hbh-howto" tabindex="-1">${icon('list-checks')} How to…</h3>
                    ${content.howTo.map(t => `<details class="b-howto"><summary>${icon(t.icon || 'list-checks')}<span>${esc(t.task)}</span></summary><ol>${t.steps.map(s => `<li>${rich(s)}</li>`).join('')}</ol></details>`).join('')}</section>
                <section id="hb-rules" aria-labelledby="hbh-rules" class="b-panel"><h3 id="hbh-rules" tabindex="-1">${icon('shield-alert')} Rules &amp; gotchas</h3>
                    <ul class="b-rules">${content.rules.map(r => `<li>${icon('alert-triangle')}<span>${rich(r)}</span></li>`).join('')}</ul></section>
                <section id="hb-accounts" aria-labelledby="hbh-accounts" class="b-panel"><h3 id="hbh-accounts" tabindex="-1">${icon('key-round')} Accounts and consoles</h3>
                    <ul class="b-accounts">${content.accounts.map(x => `<li><span class="b-ico">${icon(x.icon || 'key-round')}</span><div><b>${esc(x.name)}</b><p>${rich(x.what)}</p>${x.owner ? `<p class="b-meta">${icon('user-round')} ${esc(x.owner)}</p>` : ''}</div>${x.url ? `<a class="b-btn b-btn-sm" href="${esc(x.url)}" target="_blank" rel="noopener">${icon('external-link')} Open<span class="b-sr"> ${esc(x.name)}</span></a>` : ''}</li>`).join('')}</ul></section>
                <section id="hb-pages" aria-labelledby="hbh-pages" class="b-panel"><div class="b-sechead"><h3 id="hbh-pages" tabindex="-1">${icon('files')} Every page</h3>
                    <label class="b-search b-search-sm">${icon('search')}<span class="b-sr">Filter pages</span><input type="search" id="hb-pq" placeholder="Filter pages" value="${esc(S.hbQ)}" data-fk="hb-pq"></label></div>
                    <p class="b-lead">All ${pages.length} public pages, grouped as in the site menu. Pages marked “not in the menu” are still on the site and reachable by link. The list is made by <code>python tools/dev_pages.py</code>.</p>
                    <div class="b-tablewrap"><table class="b-table b-pages-table" id="hb-pages-table"></table></div></section>
                <section id="hb-team" aria-labelledby="hbh-team" class="b-panel"><h3 id="hbh-team" tabindex="-1">${icon('users')} Team access</h3>
                    <p class="b-lead">One team list covers this board and the design log. People on it sign in with Google and can change both; everyone else can read this page.</p>
                    <div class="b-cols2"><div class="b-card-box">${teamMe(a)}</div>
                        <div><h4>Add someone to the team</h4><ol class="b-steps">
                            <li>They open this page, press <b>Sign in to edit</b>, then <b>Copy account ID</b> here and send it to you.</li>
                            <li>In the <a href="https://console.firebase.google.com/project/give-a-paw/database" target="_blank" rel="noopener">Firebase console</a>, open <b>Realtime Database → Data</b> and go to <code>designlog → team</code>.</li>
                            <li>Press <b>+</b>, paste the ID as the name, set the value to <code>true</code> and press <b>Add</b>. They can edit after reloading.</li>
                            <li>To remove someone, delete their line. Only owners of the Firebase project can do this.</li></ol>
                            <p class="b-meta">First-time setup of the board’s database rules: <a href="${GH}/blob/main/DEV-BOARD-SETUP.md" target="_blank" rel="noopener">DEV-BOARD-SETUP.md</a>.</p></div></div>
                    <h4>On the board</h4>
                    ${Object.keys(S.people).length ? `<ul class="b-people">${Object.entries(S.people).map(([k, p]) => `<li>${avatar(k, '')}<div><b>${esc(p.name)}</b><small>${esc(p.role || 'No role set')}</small></div><span class="b-muted">${plural(S.tasks.filter(t => t.assignee === k && t.state !== 'done').length, 'open task')}</span></li>`).join('')}</ul>`
                        : '<p class="b-muted">Nobody yet. Team members are added here when they first sign in.</p>'}</section>
            </div>
        </div>`;
    renderPagesTable();
    renderCheckParts();
}
function teamMe(a) {
    if (DEMO) return `<h4>You</h4><p>In demo mode you are <b>${esc(DEMO_USER.name)}</b> and count as on the team. <a href="dev.html">Open the live board</a> to sign in for real.</p>${roleForm()}`;
    if (!a.user) return `<h4>You</h4><p>Sign in with Google to see your account ID.</p><button type="button" class="b-btn" data-act="signin">${icon('log-in')} Sign in</button>`;
    return `<h4>You</h4><p>Signed in as <b>${esc(a.user.email || a.user.name)}</b> · ${a.member ? `<span class="b-ok">${icon('check')} on the team list</span>` : `<span class="b-warnt">${icon('x')} not on the team list yet</span>`}</p>
        <div class="b-copy"><code id="b-uid">${esc(a.user.uid)}</code><button type="button" class="b-btn b-btn-sm" data-act="copy-uid">${icon('copy')} Copy account ID</button></div>${canEdit() ? roleForm() : ''}`;
}
function roleForm() {
    const p = S.people[me().uid];
    return `<form class="b-form b-roleform" data-form="role"><label class="b-field"><span>Your role on the team</span><input name="role" maxlength="60" value="${esc(p?.role || '')}" placeholder="e.g. Web lead, 3D lead, club officer" data-fk="role"></label><button class="b-btn b-btn-sm">${icon('save')} Save role</button></form>`;
}
function checklistBlock() {
    const done = S.cl.filter(c => c.done).length, n = S.cl.length;
    const edit = canEdit();
    return `<div class="b-sechead"><h3 id="hbh-checklist" tabindex="-1">${icon('clipboard-check')} Owner checklist: handing over the site</h3>
        <div class="b-meter"><span><b>${done}</b> of ${n} done</span><span class="b-bar is-green" role="progressbar" aria-valuenow="${done}" aria-valuemin="0" aria-valuemax="${n}" aria-label="Owner checklist progress"><span style="width:${Math.round(done / n * 100)}%"></span></span></div></div>
        <p class="b-lead">What the current owner (Tyler) does so the site does not depend on his accounts. Each item is also a task in the Handoff lane of the Board; ticking it here or moving the card to Done is the same thing.${edit ? '' : ' Team members can tick items after signing in.'}</p>
        <ol class="b-cl">${S.cl.map((c, i) => {
            const st = c.state || {};
            const t = S.tasks.find(x => x.id === 'cl-' + c.id);
            return `<li class="b-cl-item${c.done ? ' is-done' : ''}" id="cl-${esc(c.id)}"><details${S.open.has('cl:' + c.id) ? ' open' : ''} data-open-key="cl:${esc(c.id)}">
                <summary><span class="b-cl-box" aria-hidden="true">${c.done ? icon('check') : i + 1}</span><span class="b-cl-title"><b>${esc(c.title)}</b><small>${icon('clock')} ${esc(c.time)}${c.done ? ` · done by ${esc(st.by)}, ${fmtWhen(st.at)}` : ''}${st.holder ? ` · has it now: ${esc(st.holder)}` : ''}${t && !c.done ? ` · ${esc(STATE[t.state].label)}` : ''}</small></span><span class="b-sr">${c.done ? 'Done' : 'Not done'}</span></summary>
                <div class="b-cl-body">
                    <p class="b-why">${icon('info')}<span>${rich(c.why)}</span></p>
                    <ol class="b-steps">${c.steps.map(s => `<li>${rich(s)}</li>`).join('')}</ol>
                    <p class="b-donewhen">${icon('flag')}<span><b>Done when:</b> ${rich(c.doneWhen)}</span></p>
                    ${st.note ? `<div class="b-note">${icon('message-square')}<div><p>${rich(st.note)}</p><small>${esc(st.by)}, ${fmtWhen(st.at)}</small></div></div>` : ''}
                    ${edit ? `<form class="b-form b-cl-form" data-form="check" data-id="${esc(c.id)}">
                        <div class="b-grid2"><label class="b-field"><span>Who has it now</span><input name="holder" maxlength="80" value="${esc(st.holder || '')}" placeholder="e.g. Sam (web lead), club account"></label>
                        <label class="b-field"><span>Note</span><input name="note" maxlength="500" value="${esc(st.note || '')}" placeholder="Anything the next person should know"></label></div>
                        <div class="b-row"><button type="button" class="b-btn b-btn-sm ${c.done ? '' : 'b-btn-primary'}" data-act="tick" data-id="${esc(c.id)}" data-fk="tick:${esc(c.id)}">${icon(c.done ? 'rotate-ccw' : 'check')} ${c.done ? 'Mark not done' : 'Mark done'}</button>
                        <button class="b-btn b-btn-sm" data-fk="clsave:${esc(c.id)}">${icon('save')} Save who / note</button>
                        ${t ? `<button type="button" class="b-btn b-btn-sm b-btn-quiet" data-open-task="cl-${esc(c.id)}">${icon('square-arrow-out-up-right')} Open as task</button>` : ''}</div>
                    </form>` : ''}
                </div></details></li>`;
        }).join('')}</ol>`;
}
async function setChecklistDone(clId, done) {
    const c = S.cl.find(x => x.id === clId);
    try {
        await syncCheck(clId, done);
        const t = S.tasks.find(x => x.id === 'cl-' + clId);
        if (t) await store.set('tasks/cl-' + clId, taskRecord(t, { state: done ? 'done' : (t.state === 'done' ? 'todo' : t.state) }));
        await log('handoff', `${done ? 'done' : 'reopened'}: ${c.title}`);
        toast(done ? 'Ticked off.' : 'Reopened.');
    } catch (e) { fail(e); }
}
function renderPagesTable() {
    const tb = $('#hb-pages-table');
    if (!tb) return;
    const q = S.hbQ.toLowerCase();
    const list = pages.filter(p => !q || `${p.title} ${p.file} ${p.group}`.toLowerCase().includes(q));
    const groups = [...new Set(list.map(p => p.group))];
    tb.innerHTML = `<caption class="b-sr">Every public page with its live check</caption><thead><tr><th scope="col">Page</th><th scope="col" class="c-owner">Project</th><th scope="col">Check</th><th scope="col"><span class="b-sr">Actions</span></th></tr></thead>`
        + (groups.map(g => `<tbody><tr class="b-group"><th colspan="4" scope="colgroup">${esc(g)}</th></tr>${list.filter(p => p.group === g).map(p => {
            const c = S.pageChecks[p.file];
            const owners = content.projects.filter(x => x.pages?.includes(p.file)).map(x => x.name);
            return `<tr data-file="${esc(p.file)}"><td><a href="${esc(p.file)}">${esc(p.title)}</a><small><code>${esc(p.file)}</code>${p.inMenu ? '' : ' · not in the menu'}${p.generated ? ' · menu &amp; footer generated' : ''}</small></td>
                <td class="c-owner">${esc(owners.join(', ') || '—')}</td>
                <td data-pcheck="${esc(p.file)}">${checkDot(c ? (c.state === 'ok' ? { state: 'ok', text: 'Loads' } : { state: 'bad', text: 'Problem: ' + c.code }) : { state: 'run' })}</td>
                <td class="b-actions"><a class="b-btn b-btn-sm" href="${GH}/edit/main/${esc(p.file)}" target="_blank" rel="noopener">${icon('pencil')}<span class="b-hide-sm">Edit on GitHub</span><span class="b-sr"> ${esc(p.title)}</span></a><a class="b-btn b-btn-sm b-icon-btn" href="${GH}/commits/main/${esc(p.file)}" target="_blank" rel="noopener" title="History of ${esc(p.file)}">${icon('history')}<span class="b-sr">History of ${esc(p.title)}</span></a></td></tr>`;
        }).join('')}</tbody>`).join('') || '<tbody><tr><td colspan="4" class="b-muted">No pages match.</td></tr></tbody>');
    icons();
}
// Parts that change as the live checks come in (redrawn in place, so nothing loses focus).
let checkQueued = false;
function renderCheckParts() {
    if (checkQueued) return;
    checkQueued = true;
    requestAnimationFrame(() => {
        checkQueued = false;
        const a = document.activeElement;
        const fk = $('#b-strip').contains(a) ? a.closest('[data-fk]')?.dataset.fk : null;
        renderStrip();
        if (fk) $(`#b-strip [data-fk="${CSS.escape(fk)}"]`)?.focus();
        const arch = $('#hb-arch');
        if (arch) {
            arch.innerHTML = content.architecture.map(x => `<article class="b-arch-box"><header><span class="b-ico">${icon(x.icon)}</span><div><h4>${esc(x.name)}</h4><p>${esc(x.service)}</p></div>${checkDot(S.checks[x.check] || { state: 'run' })}</header>
                <p>${esc(x.what)}</p>${x.files?.length ? `<p class="b-files">${x.files.map(f => `<code>${esc(f)}</code>`).join(' ')}</p>` : ''}
                ${HIST_KEYS.includes(x.check) ? bars(x.check) : `<p class="b-meta">${icon('minus-circle')} Not monitored: runs on a team computer.</p>`}
                ${x.link ? `<a class="b-link" href="${esc(x.link)}" target="_blank" rel="noopener">${icon('external-link')} ${esc(x.linkLabel || 'Open')}<span class="b-sr"> (${esc(x.name)})</span></a>` : ''}</article>`).join('');
            const bad = Object.entries(S.pageChecks).filter(([, c]) => c.state === 'bad');
            $('#hb-checkrows').innerHTML = CHECKS.map(([key, name, what]) => { const c = S.checks[key] || { state: 'run' }; return `<li>${checkDot(c)}<div><b>${esc(name)}</b><p>${esc(c.text || what)}</p>${key === 'pages' && bad.length ? `<p class="b-bad">${bad.map(([f, x]) => `${esc(f)} (${esc(x.code)})`).join(', ')}</p>` : ''}</div>${c.ms != null ? `<span class="b-ms">${c.ms} ms</span>` : ''}</li>`; }).join('');
            const n = Object.keys(S.pageChecks).length;
            $('#hb-checktime').textContent = S.checkedAt ? `Checked ${fmtWhen(S.checkedAt)} from this browser.` : `Running… ${n} of ${pages.length} pages checked.`;
            $('#hb-commits-list').innerHTML = S.commits ? S.commits.map(x => `<li><a href="${GH}/commit/${x.sha}" target="_blank" rel="noopener"><code>${x.sha.slice(0, 7)}</code><span class="b-sr"> commit</span></a><span>${esc(x.msg)}</span><small>${esc(x.who)} · <time datetime="${new Date(x.at).toISOString()}">${fmtWhen(x.at)}</time></small></li>`).join('')
                : `<li class="b-muted">${S.commitsError ? esc(S.commitsError) : 'Loading…'}</li>`;
            $$('[data-pcheck]').forEach(td => { const c = S.pageChecks[td.dataset.pcheck]; td.innerHTML = checkDot(c ? (c.state === 'ok' ? { state: 'ok', text: 'Loads' } : { state: 'bad', text: 'Problem: ' + c.code }) : { state: 'run' }); });
        }
        $$('a.b-pagelink[data-file]').forEach(x => { const c = S.pageChecks[x.dataset.file]; x.className = `b-pagelink is-${c ? c.state : 'run'}`; });
        icons();
    });
}
async function checksRun() {
    Object.assign(S, { checks: {}, pageChecks: {}, commits: null, commitsError: '', checkedAt: 0 });
    renderCheckParts();
    await runChecks(R => { Object.assign(S, { checks: R.checks, pageChecks: R.pageChecks, commits: R.commits, commitsError: R.commitsError, checkedAt: R.checkedAt }); renderCheckParts(); });
    if (S.view === 'table' || S.view === 'handbook') renderView();      // levels depend on the page checks
    writeCheckHistory();
}
// Today's result per check, written by team members (once per day and state) so the 30-day bars fill in.
let histBusy = false;
async function writeCheckHistory() {
    if (!S.checkedAt || !canEdit() || histBusy) return;
    histBusy = true;
    const day = today();
    try {
        for (const k of HIST_KEYS) {
            const s = S.checks[k]?.state;
            if (!['ok', 'warn', 'bad'].includes(s) || S.board.checkhistory?.[k]?.[day]?.s === s) continue;
            await store.set(`checkhistory/${k}/${day}`, { s, at: Date.now(), uid: me().uid });
        }
    } catch (e) { console.warn('Check history not saved:', e?.message || e); }
    histBusy = false;
}
// A team member's own entry in people/ (name from Google), so they can be picked as assignee or owner.
let personBusy = false;
async function ensurePerson() {
    if (!canEdit() || personBusy) return;
    const u = me(), cur = S.people[u.uid];
    if (cur && cur.name === u.name) return;
    personBusy = true;
    try { await store.set('people/' + u.uid, { name: u.name, role: String(cur?.role || '').slice(0, 60), uid: u.uid, at: Date.now() }); }
    catch (e) { console.warn('Team entry not saved:', e?.message || e); }
}

// ---- the task drawer ------------------------------------------------------------------------------------------------------------------------
let drawerReturn = null;
function openTask(id, preset = {}) {
    closeMenus();
    const isNew = !id;
    if (isNew && !canEdit()) return;
    const t = isNew ? { title: '', projectId: '', state: 'todo', assignee: S.people[me().uid] ? me().uid : '', due: '', labels: [], detail: '', createdBy: me().name, ...preset } : S.tasks.find(x => x.id === id);
    if (!t) return;
    const cl = !isNew && clFor(t);
    const edit = canEdit();
    const dlg = $('#b-drawer');
    const a = document.activeElement;
    drawerReturn = { el: a, fk: a?.closest?.('[data-fk]')?.dataset.fk };
    const labels = [...new Set([...allLabels(), ...t.labels])];
    const projOpts = `<option value="">Choose a project…</option>` + areas().map(ar => `<optgroup label="${esc(ar)}">${S.projects.filter(p => p.area === ar).map(p => `<option value="${esc(p.id)}"${p.id === t.projectId ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</optgroup>`).join('');
    const people = Object.entries(S.people);
    if (t.assignee && !S.people[t.assignee]) people.push([t.assignee, { name: personName(t.assignee) }]);
    const head = `<header class="b-drawer-head">
            <div><span class="b-eyebrow-d">${cl ? `${icon('clipboard-check')} Owner checklist item` : isNew ? 'New task' : esc(S.pm.get(t.projectId)?.name || '')}</span><h2 id="b-drawer-h">${isNew ? 'New task' : edit ? 'Edit task' : esc(t.title)}</h2></div>
            <button type="button" class="b-btn b-btn-quiet b-icon-btn" data-act="close-drawer" title="Close (Esc)">${icon('x')}<span class="b-sr">Close</span></button>
        </header>`;
    const clPanel = ro => cl ? `<section class="b-cl-panel" aria-label="Owner checklist">
            <p class="b-why">${icon('info')}<span>${rich(cl.why)}</span></p>
            <div class="b-detail">${richDetail(t.detail)}</div>
            ${ro ? `<p class="b-meta">${icon('hand')} Has it now: <b>${esc(cl.state?.holder || 'nobody yet')}</b>${cl.state?.note ? ` · ${esc(cl.state.note)}` : ''}</p>`
                : `<div class="b-grid2"><label class="b-field"><span>Who has it now</span><input name="holder" maxlength="80" value="${esc(cl.state?.holder || '')}" placeholder="e.g. Sam (web lead), club account"></label>
                <label class="b-field"><span>Checklist note</span><input name="note" maxlength="500" value="${esc(cl.state?.note || '')}" placeholder="Anything the next person should know"></label></div>`}
            <p class="b-meta">${icon('clock')} About ${esc(cl.time)}.${ro ? '' : ' Setting the state to Done ticks the item in the owner checklist.'}</p>
            ${ro ? '' : `<details class="b-older"><summary>Edit the steps text</summary><label class="b-field"><span>Steps and done-when</span><textarea name="detail" rows="8" maxlength="4000">${esc(t.detail || '')}</textarea></label></details>`}
        </section>` : '';
    if (!edit) {
        dlg.innerHTML = `<div class="b-drawer-form">${head}<div class="b-drawer-body">
            <dl class="b-ro">
                <div><dt>Project</dt><dd>${projChip(S.pm.get(t.projectId))}</dd></div>
                <div><dt>State</dt><dd>${statePill(t.state)}</dd></div>
                <div><dt>Assignee</dt><dd>${esc(personName(t.assignee))}</dd></div>
                <div><dt>Due</dt><dd>${t.due ? dueBadge(t) : '—'}</dd></div>
                ${t.labels.length ? `<div><dt>Labels</dt><dd>${labelChips(t.labels)}</dd></div>` : ''}
            </dl>
            ${cl ? clPanel(true) : (t.detail ? `<div class="b-detail">${richDetail(t.detail)}</div>` : '')}
            <p class="b-meta">${t.live ? `${icon('history')} Last changed by ${esc(t.by || '—')}${t.at ? `, ${fmtWhen(t.at)}` : ''}` : `${icon('camera')} From the ${esc(content.snapshotDate)} snapshot`}</p>
            ${DEMO ? '' : `<p class="b-meta">${icon('lock')} Team members can change tasks after signing in.</p>`}
        </div></div>`;
    } else {
        dlg.innerHTML = `<form class="b-drawer-form" data-form="task" data-id="${esc(id || '')}">${head}
        <div class="b-drawer-body">
            <label class="b-field"><span>Title</span><input name="title" required maxlength="140" value="${esc(t.title)}"></label>
            <div class="b-grid2">
                ${cl || t.projectId === 'handoff' ? `<div class="b-field"><span>Project</span><p class="b-fixed">${projChip(HANDOFF)} Handoff (owner checklist)</p><input type="hidden" name="projectId" value="handoff"></div>`
                    : `<label class="b-field"><span>Project</span><select name="projectId" required>${projOpts}</select></label>`}
                <label class="b-field"><span>State</span><select name="state">${STATES.map(([k, label]) => `<option value="${k}"${k === t.state ? ' selected' : ''}>${label}</option>`).join('')}</select></label>
                <label class="b-field"><span>Assignee</span><select name="assignee"><option value="">Unassigned</option>${people.map(([k, p]) => `<option value="${esc(k)}"${k === t.assignee ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
                <label class="b-field"><span>Due date</span><input type="date" name="due" value="${esc(t.due || '')}"></label>
            </div>
            <fieldset class="b-labelpick"><legend>Labels (up to 8)</legend>
                ${labels.map(l => `<label><input type="checkbox" name="labels" value="${esc(l)}"${t.labels.includes(l) ? ' checked' : ''}><span>${esc(l)}</span></label>`).join('')}
                <label class="b-field b-newlabel"><span class="b-sr">New labels, separated by commas</span><input name="newlabel" maxlength="60" placeholder="+ new label"></label>
            </fieldset>
            ${cl ? clPanel(false) : `<label class="b-field"><span>Details</span><textarea name="detail" rows="7" maxlength="4000" placeholder="What needs doing, where, and anything the next person should know">${esc(t.detail || '')}</textarea></label>
            ${t.detail ? `<details class="b-older"><summary>Preview</summary><div class="b-detail">${richDetail(t.detail)}</div></details>` : ''}`}
            ${isNew ? '' : `<p class="b-meta">${t.live ? `${icon('history')} Last changed by ${esc(t.by || '—')}${t.at ? `, ${fmtWhen(t.at)}` : ''}` : `${icon('camera')} From the ${esc(content.snapshotDate)} snapshot (not changed on the board yet)`}</p>`}
        </div>
        <footer class="b-drawer-foot">
            <button class="b-btn b-btn-primary">${icon('save')} ${isNew ? 'Create task' : 'Save'}</button>
            <button type="button" class="b-btn" data-act="close-drawer">Cancel</button>
            ${!isNew && !cl ? `<button type="button" class="b-btn b-btn-danger" data-act="delete-task" data-id="${esc(id)}">${icon('trash-2')} Delete</button>` : ''}
        </footer></form>`;
    }
    icons();
    dlg.showModal();
    (dlg.querySelector('input[name=title]') || dlg.querySelector('[data-act=close-drawer]')).focus();
}
function closeDrawer() { const d = $('#b-drawer'); if (d.open) d.close(); }
$('#b-drawer').addEventListener('close', () => {
    const r = drawerReturn;
    drawerReturn = null;
    requestAnimationFrame(() => {
        if (r?.el?.isConnected && r.el !== document.body) r.el.focus();
        else if (r?.fk && $(`[data-fk="${CSS.escape(r.fk)}"]`)) $(`[data-fk="${CSS.escape(r.fk)}"]`).focus();
        else $(`#h-${S.view}`)?.focus();
    });
});
$('#b-drawer').addEventListener('click', e => { if (e.target === e.currentTarget) closeDrawer(); });
async function saveTask(form) {
    if (!form.reportValidity()) return;
    const fd = new FormData(form);
    const isNew = !form.dataset.id;
    const id = form.dataset.id || newId();
    const cur = isNew ? null : S.tasks.find(x => x.id === id);
    const labels = [...new Set([...fd.getAll('labels').map(String), ...String(fd.get('newlabel') || '').split(',').map(s => slugify(s).slice(0, 24)).filter(Boolean)])];
    if (labels.length > 8) { toast('A task can have up to 8 labels.', true); return; }
    const data = taskRecord(cur || { createdBy: me().name }, {
        title: String(fd.get('title')).trim(), projectId: String(fd.get('projectId')), state: String(fd.get('state')), assignee: String(fd.get('assignee') || ''),
        due: String(fd.get('due') || ''), labels, detail: String(fd.get('detail') ?? cur?.detail ?? '').trim(),
    });
    const ch = [];
    if (cur) {
        if (cur.state !== data.state) ch.push(`moved to ${STATE[data.state].label}`);
        if ((cur.assignee || '') !== data.assignee) ch.push(data.assignee ? `assigned to ${personName(data.assignee)}` : 'unassigned');
        if ((cur.due || '') !== data.due) ch.push(data.due ? `due ${fmtDue(data.due)}` : 'no due date');
        if (cur.title !== data.title) ch.push('renamed');
        if (cur.projectId !== data.projectId) ch.push(`moved to ${S.pm.get(data.projectId)?.name}`);
        if ((cur.detail || '') !== data.detail || cur.labels.join() !== data.labels.join()) ch.push('edited details');
    }
    try {
        await store.set('tasks/' + id, data);
        if (id.startsWith('cl-')) {
            const prev = S.board.checklist?.[id.slice(3)] || {};
            const holder = String(fd.get('holder') || '').trim().slice(0, 80), note = String(fd.get('note') || '').trim().slice(0, 500);
            if (!!prev.done !== (data.state === 'done') || (prev.holder || '') !== holder || (prev.note || '') !== note) {
                await syncCheck(id.slice(3), data.state === 'done', { holder, note });
                if ((prev.holder || '') !== holder) ch.push(`has it now: ${holder || 'nobody'}`);
            }
        }
        if (isNew) await log(data.projectId, `created “${data.title}”`);
        else if (ch.length) await log(data.projectId, `“${data.title}”: ${ch.join('; ')}`);
        drawerReturn = drawerReturn?.el?.isConnected ? drawerReturn : { fk: 'task:' + id, el: null };
        closeDrawer();
        toast(isNew ? 'Task created.' : 'Task saved.');
    } catch (e) { fail(e); }
}
async function deleteTask(id) {
    const t = S.tasks.find(x => x.id === id);
    if (!t || !confirm(`Delete the task “${t.title}”?`)) return;
    drawerReturn = { fk: `h-${S.view}`, el: $(`#h-${S.view}`) };
    try {
        // A snapshot task gets a tombstone (or it would come back from the snapshot); a board-only task is removed.
        await store.set('tasks/' + id, t.isDefault ? { ...taskRecord(t), deleted: true } : null);
        await log(t.projectId, `deleted “${t.title}”`);
        closeDrawer();
        toast('Task deleted.');
    } catch (e) { fail(e); }
}

// ---- campaign dialog ------------------------------------------------------------------------------------------------------------------------
function openCampaign() {
    if (!canEdit()) return;
    const c = camp();
    const dlg = $('#b-camp');
    const ret = document.activeElement;
    dlg.innerHTML = `<form class="b-modal-box b-form" data-form="campaign">
        <header class="b-drawer-head"><h2 id="b-camp-h">${icon('target')} Handoff campaign</h2><button type="button" class="b-btn b-btn-quiet b-icon-btn" data-act="close-camp">${icon('x')}<span class="b-sr">Close</span></button></header>
        <div class="b-modal-body">
            <p class="b-muted">A deadline everyone works toward. The strip under the views counts down to it and tracks how many active projects have reached the level.</p>
            <div class="b-grid2"><label class="b-field"><span>Handoff date</span><input type="date" name="date" required value="${esc(c.date)}"></label>
            <label class="b-field"><span>Target level</span><select name="target">${LEVELS.slice(1).map(l => `<option value="${l.id}"${l.id === c.target ? ' selected' : ''}>${esc(l.label)}</option>`).join('')}</select></label></div>
            <label class="b-field"><span>Goal</span><input name="goal" maxlength="120" required value="${esc(c.goal)}"></label>
            <p class="b-meta">${c.by ? `Last set by ${esc(c.by)}, ${fmtWhen(c.at)}` : 'Not set on the board yet (showing the default).'}</p>
        </div>
        <footer class="b-drawer-foot"><button class="b-btn b-btn-primary">${icon('save')} Save campaign</button><button type="button" class="b-btn" data-act="close-camp">Cancel</button></footer>
    </form>`;
    icons();
    dlg.addEventListener('close', () => { if (ret?.isConnected) ret.focus(); else $('[data-act=edit-campaign]')?.focus(); }, { once: true });
    dlg.showModal();
    dlg.querySelector('input[name=date]').focus();
}
$('#b-camp').addEventListener('click', e => { if (e.target === e.currentTarget) e.currentTarget.close(); });

// ---- command menu (Ctrl+K) and shortcuts ----------------------------------------------------------------------------------------------------
let cmdItems = [], cmdShown = [], cmdIndex = 0, cmdReturn = null;
function buildCmdItems() {
    return [
        ...(canEdit() ? [{ kind: 'Action', label: 'Create a task', icon: 'plus', run: () => openTask(null) }] : []),
        { kind: 'Action', label: 'Report a problem', icon: 'bug', run: () => { go('inbox'); setTimeout(() => $('#v-inbox input[name=title]')?.focus(), 30); } },
        { kind: 'Action', label: 'Run the live checks again', icon: 'refresh-cw', run: () => { checksRun(); go('handbook/checks'); } },
        ...(canEdit() ? [{ kind: 'Action', label: 'Edit the handoff campaign', icon: 'target', run: () => openCampaign() }] : []),
        { kind: 'Action', label: 'Show keyboard shortcuts', icon: 'keyboard', run: () => openKeys() },
        ...VIEWS.map(([k, label, ic]) => ({ kind: 'View', label: 'Go to ' + label, icon: ic, run: () => go(k, true) })),
        { kind: 'View', label: 'Handoff lane (owner checklist tasks)', icon: 'clipboard-check', run: () => showHandoff() },
        ...HB.map(([k, label, ic]) => ({ kind: 'Handbook', label, icon: ic, run: () => go('handbook/' + k) })),
        ...S.projects.map(p => ({ kind: 'Project', label: p.name, sub: p.area, icon: 'folder-kanban', run: () => openProject(p.id) })),
        ...S.tasks.map(t => ({ kind: 'Task', label: t.title, sub: `${S.pm.get(t.projectId)?.name || ''} · ${STATE[t.state].label}`, icon: 'square-check', run: () => openTask(t.id) })),
        ...pages.map(p => ({ kind: 'Page', label: p.title, sub: p.file, icon: 'file', run: () => { S.hbQ = p.file; go('handbook/pages'); } })),
    ];
}
function openCmd() {
    const dlg = $('#b-cmd');
    if (dlg.open) return;
    cmdReturn = document.activeElement;
    cmdItems = buildCmdItems();
    cmdIndex = 0;
    dlg.innerHTML = `<div class="b-cmd-box">
        <label class="b-cmd-input">${icon('search')}<span class="b-sr">Jump to</span><input id="b-cmd-q" type="text" role="combobox" aria-expanded="true" aria-controls="b-cmd-list" aria-autocomplete="list" autocomplete="off" spellcheck="false" placeholder="Jump to a view, project, task or page, or type a command…"></label>
        <ul id="b-cmd-list" role="listbox" aria-label="Results"></ul>
        <p class="b-cmd-foot"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>Enter</kbd> open</span><span><kbd>Esc</kbd> close</span></p>
    </div>`;
    dlg.showModal();
    const q = $('#b-cmd-q');
    q.addEventListener('input', () => { cmdIndex = 0; drawCmd(); });
    q.addEventListener('keydown', e => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); cmdIndex = (cmdIndex + (e.key === 'ArrowDown' ? 1 : cmdShown.length - 1)) % Math.max(1, cmdShown.length); drawCmd(false); }
        else if (e.key === 'Enter') { e.preventDefault(); runCmd(cmdIndex); }
    });
    drawCmd();
    q.focus();
}
function drawCmd(refilter = true) {
    const q = $('#b-cmd-q').value.trim().toLowerCase();
    if (refilter) {
        if (!q) cmdShown = cmdItems.filter(i => ['Action', 'View', 'Handbook'].includes(i.kind)).slice(0, 18);
        else {
            const words = q.split(/\s+/);
            cmdShown = cmdItems.map(i => { const hay = `${i.label} ${i.sub || ''} ${i.kind}`.toLowerCase(); if (!words.every(w => hay.includes(w))) return null; return { i, s: (i.label.toLowerCase().startsWith(q) ? 0 : 1) + (['Action', 'View'].includes(i.kind) ? 0 : 0.5) }; })
                .filter(Boolean).sort((a, b) => a.s - b.s).slice(0, 40).map(x => x.i);
        }
    }
    $('#b-cmd-list').innerHTML = cmdShown.length ? cmdShown.map((it, n) => `<li role="option" id="cmd-${n}" aria-selected="${n === cmdIndex}" data-cmd="${n}">${icon(it.icon)}<span class="b-cmd-l">${esc(it.label)}${it.sub ? `<small>${esc(it.sub)}</small>` : ''}</span><span class="b-cmd-k">${esc(it.kind)}</span></li>`).join('')
        : '<li class="b-cmd-none" role="presentation">No matches</li>';
    const input = $('#b-cmd-q');
    if (cmdShown.length) input.setAttribute('aria-activedescendant', 'cmd-' + cmdIndex); else input.removeAttribute('aria-activedescendant');
    $('#cmd-' + cmdIndex)?.scrollIntoView({ block: 'nearest' });
    icons();
}
function runCmd(n) {
    const it = cmdShown[n];
    if (!it) return;
    cmdReturn = null;
    $('#b-cmd').close();
    it.run();
}
$('#b-cmd').addEventListener('click', e => {
    if (e.target === e.currentTarget) { e.currentTarget.close(); return; }
    const li = e.target.closest('[data-cmd]');
    if (li) runCmd(+li.dataset.cmd);
});
$('#b-cmd').addEventListener('close', () => { const r = cmdReturn; cmdReturn = null; if (r?.isConnected) r.focus(); });
function openKeys() {
    const dlg = $('#b-keys');
    const rows = [['Ctrl K', 'Jump to anything (views, projects, tasks, pages)'], ['/', 'Search tasks and projects'], ['C', 'New task (team members)'], ['1 – 6', 'Switch view: Board, Table, Timeline, My work, Inbox, Handbook'],
        ['[ and ]', 'Move the focused card one column left or right (team members)'], ['Enter', 'Open the focused card'], ['?', 'This list'], ['Esc', 'Close a drawer, menu or dialog']];
    dlg.innerHTML = `<div class="b-modal-box"><header class="b-drawer-head"><h2 id="b-keys-h">${icon('keyboard')} Keyboard shortcuts</h2><button type="button" class="b-btn b-btn-quiet b-icon-btn" data-act="close-keys">${icon('x')}<span class="b-sr">Close</span></button></header>
        <dl class="b-keys">${rows.map(([k, v]) => `<div><dt>${k.split(' and ').map(x => `<kbd>${esc(x)}</kbd>`).join(' and ')}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>
        <p class="b-meta">Shortcuts are off while you type in a field.</p></div>`;
    icons();
    const ret = document.activeElement;
    dlg.addEventListener('close', () => { if (ret?.isConnected) ret.focus(); }, { once: true });
    dlg.showModal();
    dlg.querySelector('[data-act=close-keys]').focus();
}
$('#b-keys').addEventListener('click', e => { if (e.target === e.currentTarget) e.currentTarget.close(); });
function openProject(id) {
    S.open.add(id);
    S.q = ''; $('#b-q').value = '';
    S.f = { area: '', assignee: '', label: '', handoff: false };
    go('table', false);
    requestAnimationFrame(() => { const b = $(`#row-${CSS.escape(id)} .b-expand`); b?.scrollIntoView({ block: 'center' }); b?.focus({ preventScroll: true }); });
}
function showHandoff() {
    S.f = { area: '', assignee: '', label: '', handoff: true };
    S.laneClosed.handoff = false;
    S.laneAll = true;
    savePref('filters', S.f);
    go('board', true);
    renderAll();
}

// ---- routing and rendering -----------------------------------------------------------------------------------------------------------------
function go(hash, focusHead = false) {
    S.focusHead = focusHead;
    if (location.hash === '#' + hash) route(); else location.hash = hash;
}
function route() {
    const [v, sub] = decodeURIComponent(location.hash.slice(1)).split('/');
    if (v === 'main') return;
    const prev = S.view;
    S.view = VIEWS.some(x => x[0] === v) ? v : 'board';
    S.sub = S.view === 'handbook' ? (sub || '') : '';
    renderAll();
    if (S.view === 'handbook' && S.sub) {
        const sec = $('#hb-' + S.sub);
        if (sec) { sec.scrollIntoView(); sec.querySelector('h3')?.focus({ preventScroll: true }); }
    } else if (prev !== S.view) {
        window.scrollTo(0, 0);
        if (S.focusHead) $(`#h-${S.view}`)?.focus();
    }
    S.focusHead = false;
}
function renderView() {
    const a = document.activeElement;
    const fk = a?.closest?.('[data-fk]')?.dataset.fk;
    const sel = a && 'selectionStart' in a ? (() => { try { return [a.selectionStart, a.selectionEnd]; } catch { return null; } })() : null;
    VIEWS.forEach(([k]) => { $('#v-' + k).hidden = k !== S.view; });
    ({ board: renderBoard, table: renderTable, timeline: renderTimeline, mywork: renderMyWork, inbox: renderInbox, handbook: renderHandbook })[S.view]();
    icons();
    if (fk && (!document.activeElement || document.activeElement === document.body)) {
        const el = $(`[data-fk="${CSS.escape(fk)}"]`);
        if (el) { el.focus({ preventScroll: true }); if (sel) try { el.setSelectionRange(...sel); } catch { /* not text */ } }
    }
}
function renderAll() {
    derive();
    renderAuth();
    renderBanner();
    renderNav();
    renderStrip();
    renderFilters();
    renderView();
    icons();
}

// ---- events ---------------------------------------------------------------------------------------------------------------------------------
document.addEventListener('click', e => {
    if (!e.target.closest('.b-menu, [data-act=move-menu]')) closeMenus();
    const opener = e.target.closest('[data-open-task]');
    if (opener) { openTask(opener.dataset.openTask); return; }
    const t = e.target.closest('[data-act], [data-col], [data-tab]');
    if (!t) return;
    if (t.dataset.col) { S.col = t.dataset.col; renderView(); return; }
    if (t.dataset.tab) { S.inboxTab = t.dataset.tab; renderView(); return; }
    const act = t.dataset.act, id = t.dataset.id;
    // Sign-in opens a popup, so it is called straight from the click.
    if (act === 'signin') store.signIn().catch(err => { if (err?.code !== 'auth/popup-closed-by-user') toast('Sign-in failed: ' + (err?.message || err), true); });
    else if (act === 'signout') store.signOut();
    else if (act === 'reset') { if (DEMO && confirm('Reset the sample data? Every change you made in this demo is lost.')) { store.reset(); S.open.clear(); toast('Sample data reset.'); } }
    else if (act === 'cmd') openCmd();
    else if (act === 'keys') openKeys();
    else if (act === 'close-keys') $('#b-keys').close();
    else if (act === 'new-task') openTask(null, { state: t.dataset.state || 'todo', projectId: t.dataset.project || '' });
    else if (act === 'close-drawer') closeDrawer();
    else if (act === 'delete-task') deleteTask(id);
    else if (act === 'move-menu') { if (t.getAttribute('aria-expanded') === 'true') closeMenus(); else openMoveMenu(t); }
    else if (act === 'move') { const btn = $(`[data-act=move-menu][data-id="${CSS.escape(id)}"]`); closeMenus(); btn?.focus(); moveTask(id, t.dataset.state); }
    else if (act === 'lane') { S.laneClosed[t.dataset.lane] = !S.laneClosed[t.dataset.lane]; savePref('lanes', S.laneClosed); renderView(); }
    else if (act === 'toggle-handoff') { S.f.handoff = !S.f.handoff; savePref('filters', S.f); renderAll(); }
    else if (act === 'show-handoff') showHandoff();
    else if (act === 'lane-all') { S.laneAll = !S.laneAll; renderView(); }
    else if (act === 'sort-level') { S.sort = { key: 'level', dir: 1 }; savePref('sort', S.sort); }
    else if (act === 'clear-filters') { S.f = { area: '', assignee: '', label: '', handoff: false }; S.q = ''; $('#b-q').value = ''; savePref('filters', S.f); renderAll(); }
    else if (act === 'sort') { const k = t.dataset.key; S.sort = { key: k, dir: S.sort.key === k ? -S.sort.dir : 1 }; savePref('sort', S.sort); renderView(); }
    else if (act === 'expand') { if (S.open.has(id)) S.open.delete(id); else S.open.add(id); renderView(); }
    else if (act === 'verify') verify(id);
    else if (act === 'tick') { const c = S.cl.find(x => x.id === id); setChecklistDone(id, !c.done); }
    else if (act === 'recheck') checksRun();
    else if (act === 'edit-campaign') openCampaign();
    else if (act === 'close-camp') $('#b-camp').close();
    else if (act === 'edit-notice') { S.editNotice = true; renderView(); $('[data-fk=notice-text]')?.focus(); }
    else if (act === 'cancel-notice') { S.editNotice = false; renderView(); $('[data-fk=edit-notice]')?.focus(); }
    else if (act === 'copy-uid') navigator.clipboard.writeText($('#b-uid').textContent).then(() => toast('Account ID copied.')).catch(() => toast('Could not copy; select the ID and copy it by hand.', true));
    else if (act === 'open-edit' || act === 'open-history') {
        const f = $('#b-edit-page').value;
        if (!f) { toast('Choose a page first.', true); return; }
        window.open(`${GH}/${act === 'open-edit' ? 'edit' : 'commits'}/main/${f}`, '_blank', 'noopener');
    }
    else if (act === 'triage-accept') acceptReport(t.dataset.key);
    else if (act === 'triage') {
        const r = S.board.triage[t.dataset.key];
        const st = t.dataset.state;
        store.set('triage/' + t.dataset.key, triageRecord(r, { state: st })).then(() => log('inbox', `${st === 'new' ? 'moved back to new' : st === 'declined' ? 'declined' : 'marked as a duplicate'}: “${r.title}”`, 'Inbox'))
            .then(() => toast(st === 'new' ? 'Back in the inbox.' : st === 'declined' ? 'Declined.' : 'Marked as a duplicate.')).catch(fail);
    }
});
document.addEventListener('change', e => {
    const t = e.target;
    if (t.dataset.filter) { S.f[t.dataset.filter] = t.value; savePref('filters', S.f); renderAll(); }
    else if (t.id === 'b-viewas') { S.viewAs = t.value; renderView(); }
    else if (t.dataset.act === 'toggle-done') moveTask(t.dataset.id, t.checked ? 'done' : 'todo');
});
document.addEventListener('input', e => {
    const t = e.target;
    if (t.id === 'b-q') { S.q = t.value; renderFilters(); renderView(); }
    else if (t.id === 'hb-pq') { S.hbQ = t.value; renderPagesTable(); renderCheckParts(); }
    else if (t.name === 'progress') t.closest('label').querySelector('output').textContent = t.value + '%';
});
document.addEventListener('submit', e => {
    const f = e.target.closest('form[data-form]');
    if (!f) return;
    e.preventDefault();
    const kind = f.dataset.form;
    const fd = new FormData(f);
    if (kind === 'task') saveTask(f);
    else if (kind === 'update') postUpdate(f);
    else if (kind === 'fields') saveFields(f);
    else if (kind === 'check') {
        syncCheck(f.dataset.id, !!S.board.checklist?.[f.dataset.id]?.done, { holder: String(fd.get('holder')).trim(), note: String(fd.get('note')).trim() })
            .then(() => log('handoff', `updated who has “${S.cl.find(c => c.id === f.dataset.id).title}”`)).then(() => toast('Saved.')).catch(fail);
    } else if (kind === 'report') {
        const r = { title: String(fd.get('title')).trim().slice(0, 140), page: String(fd.get('page') || '').slice(0, 80), detail: String(fd.get('detail') || '').trim().slice(0, 2000), state: 'new', ...stamp() };
        if (!r.title) { f.reportValidity(); return; }
        store.push('triage', r).then(() => canEdit() ? log('inbox', `reported a problem: ${r.title}`, 'Inbox') : null)
            .then(() => { S.inboxTab = 'new'; f.reset(); renderView(); toast('Sent to the inbox.'); }).catch(fail);
    } else if (kind === 'notice') {
        const text = String(fd.get('text')).trim().slice(0, 4000);
        store.setNotice({ text, ...stamp() }).then(() => log('handoff-note', 'updated the handoff note', 'Handoff note'))
            .then(() => { S.editNotice = false; toast('Handoff note saved.'); renderView(); $('[data-fk=edit-notice]')?.focus(); }).catch(fail);
    } else if (kind === 'campaign') {
        const data = { date: String(fd.get('date')), target: String(fd.get('target')), goal: String(fd.get('goal')).trim().slice(0, 120) };
        if (!/^\d{4}-\d{2}-\d{2}$/.test(data.date) || !data.goal) { f.reportValidity(); return; }
        store.set('campaign', { ...data, ...stamp() }).then(() => log('campaign', `set the handoff campaign: ${data.goal}, ${fmtDate(data.date + 'T12:00:00')}`, 'Handoff campaign'))
            .then(() => { $('#b-camp').close(); toast('Campaign saved.'); }).catch(fail);
    } else if (kind === 'role') {
        const u = me();
        store.set('people/' + u.uid, { name: u.name, role: String(fd.get('role') || '').trim().slice(0, 60), uid: u.uid, at: Date.now() }).then(() => toast('Role saved.')).catch(fail);
    }
});
document.addEventListener('toggle', e => {
    const d = e.target;
    if (d.dataset?.openKey) { if (d.open) S.open.add(d.dataset.openKey); else S.open.delete(d.dataset.openKey); }
}, true);
document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); if ($$('dialog').some(d => d.open && d.id !== 'b-cmd')) return; openCmd(); return; }
    if ($$('dialog').some(d => d.open) || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'Escape' && $('.b-menu')) { closeMenus(); return; }
    if (e.target.closest('input, textarea, select, [contenteditable], .b-menu')) return;
    const k = e.key;
    if (k === '/') { e.preventDefault(); $('#b-q').focus(); }
    else if (k === '?') { e.preventDefault(); openKeys(); }
    else if ((k === 'c' || k === 'C') && canEdit()) { e.preventDefault(); openTask(null); }
    else if (/^[1-6]$/.test(k)) go(VIEWS[+k - 1][0]);
    else if ((k === '[' || k === ']') && canEdit() && e.target.dataset.openTask && e.target.closest('.b-card')) {
        e.preventDefault();
        const t = S.tasks.find(x => x.id === e.target.dataset.openTask);
        const i = STATES.findIndex(s => s[0] === t.state) + (k === ']' ? 1 : -1);
        if (i >= 0 && i < STATES.length) { if (narrow.matches) S.col = STATES[i][0]; moveTask(t.id, STATES[i][0]); }
    }
});
// drag and drop between columns (team members only: cards are draggable only then)
document.addEventListener('dragstart', e => {
    const c = e.target.closest?.('.b-card');
    if (!c || !canEdit()) return;
    e.dataTransfer.setData('text/plain', c.dataset.task);
    e.dataTransfer.effectAllowed = 'move';
    c.classList.add('is-dragging');
});
document.addEventListener('dragend', e => { e.target.closest?.('.b-card')?.classList.remove('is-dragging'); $$('.b-col.is-over').forEach(x => x.classList.remove('is-over')); });
document.addEventListener('dragover', e => {
    const col = e.target.closest?.('.b-col');
    if (!col || !canEdit()) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    $$('.b-col.is-over').forEach(x => { if (x !== col) x.classList.remove('is-over'); });
    col.classList.add('is-over');
});
document.addEventListener('drop', e => {
    const col = e.target.closest?.('.b-col');
    if (!col || !canEdit()) return;
    e.preventDefault();
    col.classList.remove('is-over');
    const id = e.dataTransfer.getData('text/plain');
    if (id) moveTask(id, col.dataset.state);
});

// ---- start -------------------------------------------------------------------------------------------------------------------------------------
window.addEventListener('hashchange', route);
store.onAuth(a => { S.auth = a; renderAll(); ensurePerson(); writeCheckHistory(); });
store.subscribe(tree => { S.board = tree || {}; S.boardState = 'live'; renderAll(); ensurePerson(); writeCheckHistory(); }, err => {
    S.boardState = /permission/i.test(err?.code || err?.message || '') ? 'unset' : 'offline';
    S.boardError = err?.message || String(err);
    renderAll();
});
route();
checksRun();
window.devDebug = { S, store, renderAll, moveTask, openTask, score, campaignStats, DEFAULTS };
