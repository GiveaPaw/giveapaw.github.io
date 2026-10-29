// Developer hub (dev.html): the tasks every visitor sees before anyone edits the board, and the sample board for
// ?demo=1. Tasks come from the snapshot (dev-content.js): one per "What's next" item of each project, plus one per
// owner-checklist item. A task written to devboard/tasks/<id> replaces its default; {deleted: true} hides it.
import { content } from './dev-content.js?v=2';

// Stable 6-character id part from an item's text, so a task keeps its id when other items change.
export function taskHash(text) {
    let h = 0x811c9dc5;
    for (const ch of String(text)) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193); }
    return (h >>> 0).toString(36).padStart(6, '0').slice(-6);
}
// A short title from the first sentence of an item; the whole item becomes the detail.
export function shortTitle(text) {
    const s = String(text).replace(/\s+/g, ' ').trim();
    const m = s.match(/^(.{18,96}?)[.;:!?](\s|$)/);
    let t = m ? m[1] : s;
    if (t.length > 96) t = t.slice(0, 92).replace(/\s+\S*$/, '') + '…';
    return t;
}
export function labelsFor(text, area) {
    const out = [];
    if (/\bTyler\b|owner/i.test(text)) out.push('owner-only');
    if (/decide|decision|choose|pick/i.test(text)) out.push('decision');
    if (/publish/i.test(text)) out.push('publish');
    if (/fix|bug|broken|wrong|fails?/i.test(text)) out.push('bug');
    if (/nTop|sweep|mesh|GLB|3D|model/i.test(text + ' ' + area)) out.push('3d');
    if (/document|write|README|guide|explain|docs?\b/i.test(text)) out.push('docs');
    return [...new Set(out)].slice(0, 3);
}
export const checklistDetail = c => (c.steps.map((s, n) => `${n + 1}. ${s}`).join('\n') + `\n\nDone when: ${c.doneWhen}`).slice(0, 4000);
export function defaultTasks() {
    const out = {};
    content.projects.forEach(p => p.next.forEach(text => {
        const title = shortTitle(text).slice(0, 140);
        out[`n-${p.id}-${taskHash(text)}`] = { title, projectId: p.id, state: /^Tyler\b/.test(text) ? 'waiting' : 'todo', assignee: '', due: '',
            labels: labelsFor(text, p.area), detail: title === text ? '' : text.slice(0, 4000), createdBy: 'Snapshot' };
    }));
    content.ownerChecklist.forEach(c => {
        out['cl-' + c.id] = { title: c.title.slice(0, 140), projectId: 'handoff', state: 'todo', assignee: '', due: '', labels: ['handoff'], detail: checklistDetail(c), createdBy: 'Snapshot' };
    });
    return out;
}

// ---- the demo board (?demo=1): SAMPLE data only ---------------------------------------------------------------
export const DEMO_USER = { uid: 'tyler', name: 'Tyler', email: '' };
const PEOPLE = { tyler: ['Tyler', 'Web lead · current owner'], sam: ['Sam (sample)', 'Next web lead'], priya: ['Priya (sample)', '3D and nTop'] };
const pad = n => String(n).padStart(2, '0');
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fromToday = n => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + n); return d; };
const ago = days => fromToday(-days).getTime();
const who = k => ({ uid: k, by: PEOPLE[k][0] });

export function buildSeed() {
    const people = Object.fromEntries(Object.entries(PEOPLE).map(([uid, [name, role]]) => [uid, { name, role, uid, at: ago(20) }]));
    const tasks = {};
    const DUE = [-1, 0, 1, 2, null, 3, 5, 0, 7, null, 9, 4, -2, 6, 1, 8];
    let i = 0;
    Object.entries(defaultTasks()).forEach(([id, t]) => {
        if (t.projectId === 'handoff') return;
        const ntop = /^n-ntop/.test(id);
        const tylers = t.state === 'waiting';
        const w = DUE[i % DUE.length];
        tasks[id] = { ...t, assignee: tylers ? 'tyler' : ntop ? 'priya' : ['sam', 'priya', 'tyler', '', 'sam'][i % 5],
            state: tylers ? 'waiting' : ['todo', 'doing', 'todo', 'todo', 'doing', 'done', 'todo', 'waiting'][i % 8],
            due: w == null ? '' : iso(fromToday(w * 7 + (i % 3))), ...who('tyler'), at: ago(18 - (i % 18)) };
        i++;
    });
    const clState = { 'team-lists': 'done', 'github-owner': 'waiting', 'board-review': 'doing', 'working-folder': 'doing' };
    content.ownerChecklist.forEach((c, k) => {
        tasks['cl-' + c.id] = { ...defaultTasks()['cl-' + c.id], state: clState[c.id] || 'todo', assignee: 'tyler', due: iso(fromToday(5 + k * 4)), ...who('tyler'), at: ago(8) };
    });
    const checklist = {
        'team-lists': { done: true, holder: 'Sam (sample)', note: 'Sam is on designlog/team and anatomy/editors (sample).', ...who('tyler'), at: ago(4) },
        'github-owner': { done: false, holder: 'Tyler', note: 'Invite sent to Sam (sample); waiting for them to accept.', ...who('tyler'), at: ago(2) },
    };
    const updates = {}, projects = {};
    const OLD = new Set(['ntop-sweeps', 'expert-judges', 'info-pages', 'sweep-studio', 'anatomy-quizzes']);
    const H2U = { good: 'on-track', 'needs-work': 'at-risk', blocked: 'off-track' };
    content.projects.forEach((p, k) => {
        const owner = /nTop/.test(p.area) ? 'priya' : k % 5 === 4 ? '' : k % 4 === 1 ? 'sam' : 'tyler';
        projects[p.id] = { status: p.status, health: p.health, progress: p.progress, ...(owner ? { owner } : {}),
            ...(k % 3 === 0 ? { verifiedAt: ago(k % 2 ? 75 : 12), verifiedBy: 'Tyler' } : {}), ...who('tyler'), at: ago(10) };
        if (p.id === 'prototype-pages' || p.id === 'ntop-blocks') return;
        const health = H2U[p.health] || 'on-track';
        const first = p.next[0] ? shortTitle(p.next[0]) : '';
        const text = health === 'off-track' ? `Blocked: ${p.owner_actions?.[0] || first}.` : health === 'at-risk' ? `Needs work. ${first ? 'Next: ' + first + '.' : ''}` : `On track. ${first ? 'Next: ' + first + '.' : 'Nothing planned.'}`;
        const when = OLD.has(p.id) ? 26 + (k % 6) : 2 + (k % 13);
        updates[p.id] = {
            u1: { health: 'on-track', text: 'Started tracking this project on the board (sample).', ...who('tyler'), at: ago(when + 14) },
            u2: { health, text: text.slice(0, 1000), ...who(k % 4 === 1 ? 'sam' : 'tyler'), at: ago(when) },
        };
    });
    const triage = {
        r1: { title: 'Billie case study: Design history tab shows an empty grid on iPad', page: 'billie-case-study.html', detail: 'Seen on an iPad in Safari; on a laptop it works. (sample report)', ...who('sam'), at: ago(1), state: 'new' },
        r2: { title: 'Materials page: two images have no alt text', page: 'materials.html', detail: 'The PLA and TPU photos are read as "image" by VoiceOver. (sample report)', ...who('priya'), at: ago(2), state: 'new' },
        r3: { title: 'Mesh Check freezes on a 1M-triangle socket', page: 'mesh-check.html', detail: 'Same as the open web-worker task. (sample report)', ...who('sam'), at: ago(6), state: 'duplicate' },
        r4: { title: 'Typo on Meet the team', page: 'meet-the-team.html', detail: '"Prosthetis" in the second paragraph. (sample report)', ...who('priya'), at: ago(9), state: 'new' },
    };
    const history = {
        h1: { project: 'handoff', name: 'Handoff', text: 'done: Add your successor to the team lists', ...who('tyler'), at: ago(4) },
        h2: { project: 'mesh-check', name: 'Mesh Check & Repair', text: 'posted an update: On track', ...who('tyler'), at: ago(3) },
        h3: { project: 'handoff', name: 'Handoff', text: 'moved “Make your successor an owner of the GiveaPaw GitHub organisation” to Waiting on someone', ...who('tyler'), at: ago(2) },
        h4: { project: 'inbox', name: 'Inbox', text: 'reported a problem: Billie case study: Design history tab shows an empty grid on iPad', ...who('sam'), at: ago(1) },
    };
    // 30 days of sample check history (today is written for real once the live checks finish).
    const checkhistory = {};
    ['pages', 'models', 'database', 'github', 'google', 'libraries'].forEach((k, j) => {
        checkhistory[k] = {};
        for (let d = 1; d <= 22 - j * 2; d++) {
            const s = k === 'database' && d < 9 ? 'warn' : k === 'models' && d === 11 ? 'bad' : k === 'github' && d === 5 ? 'warn' : 'ok';
            checkhistory[k][iso(fromToday(-d))] = { s, at: ago(d), uid: 'tyler' };
        }
    });
    const campaign = { date: '2026-12-15', target: 'silver', goal: 'Every project at Silver', ...who('tyler'), at: ago(7) };
    return { people, tasks, checklist, updates, projects, triage, history, checkhistory, campaign };
}
