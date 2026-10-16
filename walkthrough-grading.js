// Comparing a student's socket design with the worked solution for this case, built into the walkthrough:
//   - the 3D viewer splits into "Yours" and "The experts'" with one linked camera (the experts' version is
//     copied from the walkthrough's own models into a ghost layer, and the canvas is drawn twice per frame);
//   - the feedback sits under the student's own controls in the step column: every graded control gets a
//     status, the selected one the full expert-spread picture; a banner at the top steps through the
//     differences and holds the report (a summary of every decision). The student can keep editing; the
//     feedback and their half of the viewer stay current.
// The experts' answers come from grading/<case>-answer-key.json; the student's answers, files and the show /
// ghost / render hooks from window.gapWalkthrough (socket-walkthrough-sample.js).

const params = new URLSearchParams(location.search);
const KEY_URL = params.get('answerKey') || 'grading/ollie-answer-key.json';
const AXES = ['X', 'Y', 'Z'];
const SPOTS = ['minimum', 'centroid', 'maximum'];
const ROLE_LABEL = { solidAnimal: 'Solid animal', attachment: 'Attachment surface', mechanical: 'Mechanical interface', solidInterface: 'Solid interface' };
const BREED_LABEL = { ollie: 'Ollie', 'chihuahua-1015': 'Chihuahua (10-15)', chihuahua: 'Chihuahua', greyhound: 'Greyhound', 'german-shepherd': 'German Shepherd' };
const PASSTHROUGH = ['imports', 'point3', 'points'];   // answers that are not one value on a track
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const CATEGORY_LABEL = { socket: 'Socket', farback: 'Far back', forward: 'Forward', leghole: 'Leg hole', toolow: 'Too low' };

const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = name => `<i data-lucide="${name}" aria-hidden="true"></i>`;
const refreshIcons = () => window.lucide?.createIcons({ attrs: { 'stroke-width': 1.8 } });
const fmt = n => String(+Number(n).toFixed(2));
const median = list => { const s = [...list].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
const mostCommon = list => { const m = new Map(); list.forEach(v => m.set(v, (m.get(v) || 0) + 1)); return [...m.entries()].sort((a, b) => b[1] - a[1])[0]; };
const wrapAngle = a => ((((a + 180) % 360) + 360) % 360) - 180;
const planeText = pick => String(pick).split(',').map((v, i) => `${AXES[i]} ${SPOTS[+v]}`).join(' · ');
const el = (tag, cls, html) => { const node = document.createElement(tag); if (cls) node.className = cls; if (html !== undefined) node.innerHTML = html; return node; };

let key = null;
let W = null;
let featured = null;   // the featured expert ({id, name, role}), if any is chosen and shown

// The answer key keeps each expert's answer and comment by expert id. Only experts marked "include" count; this
// turns a decision's answers into the list of values the comparison uses (and remembers where the featured
// expert's answer sits in it).
function prepareKey(raw) {
    const experts = (raw.experts || []).map((e, i) => typeof e === 'string' ? { id: `e${i + 1}`, name: e, include: true } : e);
    const shown = experts.filter(e => e.include !== false);
    raw.experts = experts;
    raw.shownExperts = shown;
    featured = shown.find(e => e.id === raw.featured) || null;
    raw.params.forEach(param => {
        if (PASSTHROUGH.includes(param.type)) return;
        const byId = Array.isArray(param.answers) ? Object.fromEntries(param.answers.map((v, i) => [experts[i]?.id, v])) : (param.answers || {});
        param.byExpert = byId;
        param.answerBy = shown.filter(e => byId[e.id] !== undefined && byId[e.id] !== null && byId[e.id] !== '').map(e => ({ expert: e, value: byId[e.id] }));
        param.answers = param.answerBy.map(a => a.value);
        param.featuredAt = featured ? param.answerBy.findIndex(a => a.expert.id === featured.id) : -1;
    });
    raw.params = raw.params.filter(param => PASSTHROUGH.includes(param.type) || param.answers.length);
    return raw;
}

// ---- one decision compared with the experts --------------------------------------------------------------
function wantText(want) {
    if (want.sizeClass) return `${want.sizeClass === 'large' ? 'large' : 'small'} interface`;
    return [want.breed && `${BREED_LABEL[want.breed] || want.breed} scan`, want.category && `${CATEGORY_LABEL[want.category] || want.category} surface`].filter(Boolean).join(', ');
}
function evaluate(param, answers, touched, imports) {
    if (param.type === 'imports') {
        const rows = Object.entries(param.expected).map(([role, want]) => {
            const got = imports.selection[role] || {};
            return { role, label: ROLE_LABEL[role] || role, got: got.label || got.name || 'Nothing', ok: Object.entries(want).every(([k, v]) => got[k] === v), want: wantText(want) };
        });
        const good = rows.filter(r => r.ok).length;
        return {
            param, status: good === rows.length && !imports.mismatches.length ? 'match' : 'off', touched: true, rows, mismatches: imports.mismatches,
            yours: `${good} of ${rows.length} files as expected`, expert: 'The files this case uses',
            agreeText: imports.mismatches.length ? `${imports.mismatches.length} of your files do not belong together` : `${good} of ${rows.length} files are the ones this case uses`,
        };
    }
    const value = answers[param.key];
    const base = { param, value, touched: param.step !== '3' || touched.has(param.key) };
    if (param.type === 'plane') {
        const mine = value.pick.join(',');
        const [top] = mostCommon(param.answers);
        const axesMatched = mine.split(',').filter((v, i) => v === top.split(',')[i]).length;
        const wantNormal = param.normal ? param.normal.split(',').map(Number) : null;
        const myNormal = (value.normal || [0, 0, 0]).map(Number);
        const normalOk = !wantNormal || wantNormal.every((n, i) => Math.abs(n - myNormal[i]) < 1e-6);
        const pickOk = mine === top;
        return {
            ...base, status: pickOk && normalOk ? 'match' : pickOk || axesMatched === 2 ? 'close' : 'off',
            yours: `${planeText(mine)} · normal ${myNormal.map(fmt).join(', ')}`,
            expert: `${planeText(top)}${wantNormal ? ` · normal ${wantNormal.map(fmt).join(', ')}` : ''}`,
            expertDetail: pickOk && !normalOk ? 'the right face, the other normal' : '',
            agreeText: pickOk && normalOk ? 'Exactly the plane the solution uses'
                : pickOk ? 'The right face, but the normal points the other way'
                : `${axesMatched} of 3 axes match the solution`,
            mine, top, normalOk, studentShow: { pick: value.pick, normal: value.normal }, expertShow: { pick: top.split(',').map(Number), normal: wantNormal },
        };
    }
    // One point in the scan frame, in millimetres.
    if (param.type === 'point3') {
        const mine = (value || [0, 0, 0]).map(Number);
        const want = param.answer.map(Number);
        const t = param.tolerance || 5;
        const d = distance(mine, want);
        return {
            ...base, status: d <= t ? 'match' : d <= t * 3 ? 'close' : 'off',
            yours: `${mine.map(fmt).join(', ')} mm`, expert: `${want.map(fmt).join(', ')} mm`,
            expertDetail: `within ${fmt(t)} mm counts as a match`,
            agreeText: `${fmt(d)} mm from the solution`,
            mine, want, t, d,
        };
    }
    // A list of points: each point of the solution is paired with the nearest point the student placed.
    if (param.type === 'points') {
        const mine = (value || []).map(point => point.position.map(Number));
        const want = param.answer.map(point => point.map(Number));
        const t = param.tolerance || 10;
        const pairs = want.map(target => {
            let at = -1;
            let best = Infinity;
            mine.forEach((point, index) => { const d = distance(point, target); if (d < best) { best = d; at = index; } });
            return { want: target, at, d: best };
        });
        const hit = pairs.filter(pair => pair.d <= t).length;
        const spare = mine.length - want.length;
        const found = pairs.filter(pair => Number.isFinite(pair.d));
        const mean = found.length ? found.reduce((sum, pair) => sum + pair.d, 0) / found.length : Infinity;
        return {
            ...base, status: hit === want.length && spare === 0 ? 'match' : hit >= Math.ceil(want.length / 2) ? 'close' : 'off',
            yours: `${mine.length} point${mine.length === 1 ? '' : 's'}${Number.isFinite(mean) ? `, ${fmt(mean)} mm out on average` : ''}`,
            expert: `${want.length} points`,
            expertDetail: `within ${fmt(t)} mm counts as a match`,
            agreeText: `${hit} of ${want.length} of the solution's points have one of yours within ${fmt(t)} mm${spare > 0 ? `, and you placed ${spare} more` : spare < 0 ? `, and you are ${-spare} short` : ''}`,
            mine, want, pairs, t, hit, spare, mean,
        };
    }
    if (param.type === 'angle') {
        const v = wrapAngle(Number(value) || 0);
        const ex = param.answers.map(Number);
        const lo = Math.min(...ex), hi = Math.max(...ex), t = param.tolerance || 10;
        const beyond = v < lo ? lo - v : v > hi ? v - hi : 0;
        const med = median(ex);
        return {
            ...base, status: beyond === 0 ? 'match' : beyond <= t ? 'close' : 'off',
            yours: `${fmt(v)}${param.unit}`, expert: `${fmt(med)}${param.unit}`, expertDetail: `within ${fmt(t)}${param.unit} counts as a match`,
            agreeText: `${fmt(Math.abs(wrapAngle(v - med)))}${param.unit} from the solution`,
            direction: v < lo ? 'low' : v > hi ? 'high' : 'in', v, lo, hi, t, ex, studentShow: v, expertShow: med,
        };
    }
    const values = W.parameterValues[param.key];
    const idx = x => values.reduce((best, val, i) => Math.abs(val - x) < Math.abs(values[best] - x) ? i : best, 0);
    const mineIdx = idx(Number(value));
    const exIdx = param.answers.map(a => idx(Number(a)));
    const lo = Math.min(...exIdx), hi = Math.max(...exIdx);
    const outside = mineIdx < lo ? lo - mineIdx : mineIdx > hi ? mineIdx - hi : 0;
    const unit = param.unit ? ' ' + param.unit : '';
    const expertValue = values[idx(median(param.answers.map(Number)))];
    return {
        ...base, status: outside === 0 ? 'match' : outside === 1 ? 'close' : 'off',
        yours: `${value}${unit}`, expert: `${expertValue}${unit}`, expertDetail: outside === 0 ? 'the value the solution uses' : `${outside} slider step${outside === 1 ? '' : 's'} away`,
        agreeText: outside === 0 ? 'The value the solution uses' : `${outside} slider step${outside === 1 ? '' : 's'} from the solution`,
        direction: mineIdx < lo ? 'low' : mineIdx > hi ? 'high' : 'in', values, mineIdx, exIdx, lo, hi,
        studentShow: values[mineIdx], expertShow: expertValue,
    };
}
function featuredFor(r) {
    const at = r.param.featuredAt;
    if (!featured || at === undefined || at < 0) return null;
    const raw = r.param.answers[at];
    const comment = r.param.comments?.[featured.id] || '';
    if (r.param.type === 'plane') {
        const pick = String(raw);
        return { label: planeText(pick), show: { pick: pick.split(',').map(Number), normal: null }, same: pick === r.mine, comment };
    }
    if (r.param.type === 'angle') {
        const v = wrapAngle(Number(raw));
        return { label: `${fmt(v)}${r.param.unit}`, show: v, same: Math.abs(v - r.v) <= (r.param.tolerance || 10), comment };
    }
    const value = r.values[r.exIdx[at]];
    return { label: `${value}${r.param.unit ? ' ' + r.param.unit : ''}`, show: value, same: r.exIdx[at] === r.mineIdx, comment };
}
const evaluateAll = () => { const answers = W.answers(), touched = W.touched(), imports = W.imports(); return key.params.map(p => evaluate(p, answers, touched, imports)); };
function feedbackText(r) {
    if (r.status === 'match') return r.param.type === 'imports' ? 'The right files, and they belong together.' : 'The same as the solution.';
    if (['plane', 'imports', 'point3', 'points'].includes(r.param.type)) return r.param.off || 'Different from the solution.';
    return (r.direction === 'low' ? r.param.low : r.param.high) || (r.direction === 'low' ? 'Lower than the solution.' : 'Higher than the solution.');
}
const STATUS = { match: { short: 'Match', icon: 'circle-check' }, close: { short: 'Close', icon: 'circle-dot' }, off: { short: 'Different', icon: 'circle-alert' } };
const chip = status => `<span class="grade-chip is-${status}">${icon(STATUS[status].icon)} ${STATUS[status].short}</span>`;
const untouched = r => r.touched ? '' : '<small class="grade-untouched">You kept the starting value.</small>';
const canShow = r => !PASSTHROUGH.includes(r.param.type);
function mixBar(results) {
    const n = { match: 0, close: 0, off: 0 };
    results.forEach(r => { n[r.status]++; });
    return { n, html: `<span class="grade-mix">${['match', 'close', 'off'].map(s => n[s] ? `<span class="is-${s}" style="flex:${n[s]}">${n[s]} ${STATUS[s].short.toLowerCase()}</span>` : '').join('')}</span>` };
}

// ---- pictures: the experts' answers and yours ---------------------------------------------------------------
function you(x, base) {
    return `<g class="grade-you"><line x1="${x}" x2="${x}" y1="${base - 44}" y2="${base + 12}"/><rect x="${x - 17}" y="${base - 62}" width="34" height="17" rx="8.5"/><text x="${x}" y="${base - 50}">You</text></g>`;
}
const expertsMarker = (x, base) => `<path class="grade-ex-marker" d="M${x} ${base + 11} l-5 8 h10 z"><title>The solution</title></path>`;
function trackSVG(r) {
    const W0 = 340, pad = 16, base = 70;
    const frame = inner => `<svg class="grade-track" viewBox="0 ${base - 70} ${W0} 104" role="img">${inner}</svg>`;
    if (r.param.type === 'angle') {
        const lo = Math.max(-180, Math.min(r.lo, r.v) - 2 * r.t), hi = Math.min(180, Math.max(r.hi, r.v) + 2 * r.t);
        const xOf = v => pad + (v - lo) / Math.max(1e-6, hi - lo) * (W0 - 2 * pad);
        const stack = {};
        const dots = r.ex.map((e, j) => { const k = Math.round(e); const lvl = (stack[k] = (stack[k] || 0) + 1) - 1; return `<circle class="grade-expert${j === r.param.featuredAt ? ' is-featured' : ''}" cx="${xOf(e)}" cy="${base - 10 - lvl * 13}" r="5.5"/>`; }).join('');
        const band = `<rect class="grade-band" x="${xOf(r.lo) - 5}" y="${base - 2}" width="${Math.max(10, xOf(r.hi) - xOf(r.lo) + 10)}" height="10" rx="5"/>`;
        return frame(`${band}<line class="grade-line" x1="${pad}" x2="${W0 - pad}" y1="${base + 3}" y2="${base + 3}"/>${you(xOf(r.v), base)}${dots}${expertsMarker(xOf(r.expertShow), base)}<text class="grade-label" x="${pad}" y="${base + 32}">${fmt(lo)}°</text><text class="grade-label" x="${W0 - pad}" y="${base + 32}" text-anchor="end">${fmt(hi)}°</text>`);
    }
    const n = r.values.length;
    const xOf = i => pad + i * (W0 - 2 * pad) / Math.max(1, n - 1);
    const stack = {};
    const dots = r.exIdx.map((i, j) => { const lvl = (stack[i] = (stack[i] || 0) + 1) - 1; return `<circle class="grade-expert${j === r.param.featuredAt ? ' is-featured' : ''}" cx="${xOf(i)}" cy="${base - 10 - lvl * 13}" r="5.5"/>`; }).join('');
    const ticks = r.values.map((v, i) => `<rect class="grade-tick" x="${xOf(i) - 1}" y="${base}" width="2" height="7"/>`).join('');
    const band = `<rect class="grade-band" x="${xOf(r.lo) - 6}" y="${base - 2}" width="${xOf(r.hi) - xOf(r.lo) + 12}" height="10" rx="5"/>`;
    const unit = r.param.unit ? ' ' + r.param.unit : '';
    return frame(`${band}<line class="grade-line" x1="${pad}" x2="${W0 - pad}" y1="${base + 3}" y2="${base + 3}"/>${ticks}${you(xOf(r.mineIdx), base)}${dots}${expertsMarker(xOf(r.values.indexOf(r.expertShow)), base)}<text class="grade-label" x="${pad}" y="${base + 32}">${escapeHTML(r.values[0] + unit)}</text><text class="grade-label" x="${W0 - pad}" y="${base + 32}" text-anchor="end">${escapeHTML(r.values[n - 1] + unit)}</text>`);
}
function planeGrid(r) {
    const counts = AXES.map((_, axis) => [0, 1, 2].map(spot => r.param.answers.filter(a => +a.split(',')[axis] === spot).length));
    const mine = r.mine.split(',').map(Number);
    const fav = r.param.featuredAt >= 0 ? String(r.param.answers[r.param.featuredAt]).split(',').map(Number) : null;
    return `<span class="grade-plane">${AXES.map((a, axis) => `<span class="grade-plane-row"><b>${a}</b>${[0, 1, 2].map(spot => `<span class="grade-plane-cell${mine[axis] === spot ? ' is-you' : ''}${counts[axis][spot] === Math.max(...counts[axis]) ? ' is-top' : ''}"><em>${SPOTS[spot]}</em><span class="grade-plane-dots">${'<i></i>'.repeat(counts[axis][spot])}${fav && fav[axis] === spot ? '<i class="is-featured" title="Featured expert"></i>' : ''}</span>${mine[axis] === spot ? '<strong>You</strong>' : ''}</span>`).join('')}</span>`).join('')}</span>`;
}
function importList(r) {
    return `<span class="grade-files">${r.rows.map(row => `<span class="grade-file ${row.ok ? 'is-ok' : 'is-bad'}">${icon(row.ok ? 'circle-check' : 'circle-x')}<span><b>${escapeHTML(row.label)}</b><small>Yours: ${escapeHTML(row.got)}${row.ok ? '' : ` · this case uses the ${escapeHTML(row.want)}`}</small></span></span>`).join('')}
        ${r.mismatches.map(m => `<span class="grade-file is-bad">${icon('triangle-alert')}<span><b>${escapeHTML(m.title)}</b><small>${escapeHTML(m.detail)}</small></span></span>`).join('')}</span>`;
}
function pointPicture(r) {
    return `<span class="grade-files">${['X', 'Y', 'Z'].map((axis, i) => {
        const off = r.mine[i] - r.want[i];
        const ok = Math.abs(off) <= r.t;
        return `<span class="grade-file ${ok ? 'is-ok' : 'is-bad'}">${icon(ok ? 'circle-check' : 'circle-x')}<span><b>${axis} ${fmt(r.mine[i])} mm</b><small>Solution ${fmt(r.want[i])} mm · ${off >= 0 ? '+' : ''}${fmt(off)} mm</small></span></span>`;
    }).join('')}</span>`;
}
function pointsPicture(r) {
    return `<span class="grade-files">${r.pairs.map((pair, i) => {
        const ok = pair.d <= r.t;
        return `<span class="grade-file ${ok ? 'is-ok' : 'is-bad'}">${icon(ok ? 'circle-check' : 'circle-x')}<span><b>Point ${i + 1} · ${pair.want.map(fmt).join(', ')} mm</b><small>${pair.at < 0 ? 'You have not placed a point near it' : `Your point ${pair.at} is ${fmt(pair.d)} mm away`}</small></span></span>`;
    }).join('')}</span>`;
}
const picture = r => r.param.type === 'imports' ? importList(r)
    : r.param.type === 'plane' ? planeGrid(r)
    : r.param.type === 'point3' ? pointPicture(r)
    : r.param.type === 'points' ? pointsPicture(r)
    : trackSVG(r);
function featuredHTML(r) {
    const f = featuredFor(r);
    if (!f) return '';
    const on = S.featured;
    return `<div class="cmp-featured${on ? ' is-on' : ''}">
        <button type="button" class="cmp-featured-btn" data-featured aria-pressed="${on}">${icon('star')} ${on ? `Showing ${escapeHTML(featured.name)}'s choice` : `See ${escapeHTML(featured.name)}'s take`}</button>
        ${on ? `<div class="cmp-featured-body"><p><b>${escapeHTML(featured.name)}</b>${featured.role ? ` <small>${escapeHTML(featured.role)}</small>` : ''} chose <b>${escapeHTML(f.label)}</b> <span class="grade-chip ${f.same ? 'is-match' : 'is-off'}">${f.same ? 'Same as yours' : 'Different from yours'}</span></p>${f.comment ? `<blockquote>${escapeHTML(f.comment)}</blockquote>` : ''}</div>` : ''}
    </div>`;
}
const detailHTML = r => `${picture(r)}<p class="cmp-agree">${icon('target')} ${escapeHTML(r.agreeText)}.</p><p class="cmp-text">${escapeHTML(feedbackText(r))}</p>${r.param.note ? `<p class="cmp-text">The solution: ${escapeHTML(r.param.note)}</p>` : ''}${featuredHTML(r)}${untouched(r)}`;

// ---- comparing ---------------------------------------------------------------------------------------------------
const S = { active: false, results: [], list: [], current: null, token: 0, featured: false };
const stageEl = () => document.getElementById('workflow-stage');
const railEl = () => document.querySelector('.workflow-rail');
let banner = null, tags = null, notes = [], onInput = null, inputTimer = null;

function start(atKey = null) {
    if (S.active) stop();
    S.results = evaluateAll();
    S.list = S.results.filter(r => r.status !== 'match');
    S.active = true;
    document.body.classList.add('cmp-active');
    banner = el('section', 'cmp-banner');
    document.getElementById('workflow-scroll').prepend(banner);
    tags = el('div', 'cmp-split-tags', '<span class="is-yours"></span><i></i><span class="is-experts"></span>');
    tags.hidden = true;
    stageEl().append(tags);
    banner.addEventListener('click', event => {
        const t = event.target;
        if (t.closest('[data-done]')) return stop();
        if (t.closest('[data-prev]')) return step(-1);
        if (t.closest('[data-next]')) return step(1);
        if (t.closest('[data-summary]')) return banner.classList.toggle('show-summary');
        const go = t.closest('[data-go]');
        if (go) { banner.classList.remove('show-summary'); select(S.results.find(r => r.param.key === go.dataset.go)); }
    });
    // The student can keep changing things while comparing; keep the feedback (and their half) current.
    onInput = () => { clearTimeout(inputTimer); inputTimer = setTimeout(refresh, 250); };
    railEl().addEventListener('input', onInput);
    railEl().addEventListener('change', onInput);
    const first = (atKey && S.results.find(r => r.param.key === atKey)) || S.list[0];
    if (first) select(first);
    else { select(S.results[0]); banner.classList.add('show-summary'); }
}
function stop() {
    if (!S.active) return;
    S.token++;
    endSplit();
    W.ghost.clear();
    S.featured = false;
    banner?.remove(); tags?.remove();
    clearNotes();
    railEl().removeEventListener('input', onInput);
    railEl().removeEventListener('change', onInput);
    document.body.classList.remove('cmp-active');
    S.active = false;
}
function step(delta) {
    const next = S.list[S.list.indexOf(S.current) + delta];
    if (next) select(next);
    else if (delta > 0) banner.classList.add('show-summary');
}
function refresh() {
    if (!S.active) return;
    S.results = evaluateAll();
    S.list = S.results.filter(r => r.status !== 'match');
    const same = S.results.find(r => r.param.key === S.current?.param.key);
    if (same) { S.current = same; renderNotes(same, false); renderBanner(same); setTags(same); }
}

// Go to one decision: open its step, put the experts' version in the right half of the viewer, show the feedback.
async function select(r) {
    S.current = r;
    const token = ++S.token;
    endSplit();
    W.ghost.clear();
    tags.hidden = true;
    W.goToStep(r.param.step);
    renderNotes(r);
    renderBanner(r);
    await new Promise(res => setTimeout(res, 160));
    if (token !== S.token || !canShow(r)) return;
    const f = S.featured ? featuredFor(r) : null;
    await W.ghost.capture(r.param.key, f ? f.show : r.expertShow, r.studentShow);
    if (token !== S.token) return;
    splitView(r);
}

// ---- the viewer: yours on the left, the experts' on the right, one camera -------------------------------------------
let activeHalf = 'left';
let halfListener = null;
function offsetCamera(camera, half, w, h) {
    // Same camera, slid a quarter width so the model sits in the middle of its half. The picking for orbit,
    // pan, zoom and measuring uses this camera, so it follows the half the student last pointed at.
    camera.setViewOffset(w, h, half === 'left' ? w / 4 : -w / 4, 0, w, h);
}
function splitView(r) {
    W.ghost.setLook('solid');
    const { renderer, scene, camera, canvas, THREE } = W.three;
    const targets = W.ghost.targets(r.param.key);
    const size = new THREE.Vector2();
    if (!halfListener) {
        halfListener = event => {
            if (event.type === 'pointermove' && event.buttons) return;
            const rect = canvas.getBoundingClientRect();
            activeHalf = event.clientX - rect.left < rect.width / 2 ? 'left' : 'right';
            renderer.getSize(size);
            offsetCamera(camera, activeHalf, size.x, size.y);
        };
        ['pointerdown', 'pointermove', 'wheel'].forEach(type => canvas.addEventListener(type, halfListener, { capture: true, passive: true }));
    }
    W.setRender(() => {
        renderer.getSize(size);
        const w = size.x, h = size.y, half = Math.floor(w / 2);
        renderer.setScissorTest(true);
        offsetCamera(camera, 'left', w, h);
        W.ghost.root.visible = false;
        renderer.setScissor(0, 0, half, h);
        renderer.render(scene, camera);
        const saved = targets.map(t => t.visible);
        targets.forEach(t => { t.visible = false; });
        W.ghost.root.visible = true;
        offsetCamera(camera, 'right', w, h);
        renderer.setScissor(half, 0, w - half, h);
        renderer.render(scene, camera);
        targets.forEach((t, k) => { t.visible = saved[k]; });
        renderer.setScissorTest(false);
        offsetCamera(camera, activeHalf, w, h);
    });
    setTags(r);
    tags.hidden = false;
}
function endSplit() {
    const { camera, canvas } = W.three;
    W.setRender(null);
    camera.clearViewOffset();
    if (halfListener) ['pointerdown', 'pointermove', 'wheel'].forEach(type => canvas.removeEventListener(type, halfListener, { capture: true }));
    halfListener = null;
}
function setTags(r) {
    if (!tags || !canShow(r)) return;
    tags.querySelector('.is-yours').innerHTML = `${icon('user')} Yours · ${escapeHTML(r.yours)}`;
    const f = S.featured ? featuredFor(r) : null;
    tags.querySelector('.is-experts').innerHTML = f ? `${icon('star')} ${escapeHTML(featured.name)}'s choice · ${escapeHTML(f.label)}` : `${icon('target')} Solution · ${escapeHTML(r.expert)}`;
    tags.querySelector('.is-experts').classList.toggle('is-featured', !!f);
    refreshIcons();
}

// ---- the step column: a note under every graded control, a banner at the top ------------------------------------------
function anchorFor(param) {
    if (param.type === 'imports') return document.querySelector('#workflow-step-1 .workflow-block');
    if (param.key === 'pelvicPlane') return document.querySelector('#workflow-step-2a .workflow-plane-block');
    if (param.key === 'interfacePlane') return document.querySelector('#workflow-step-2b .workflow-plane-block');
    if (param.key === 'interfacePosition') return document.querySelector('#workflow-step-2c .workflow-position-block');
    if (param.key === 'attachmentPoints') return document.querySelector('#workflow-step-4a .attachment-holes-block');
    if (param.type === 'angle') return document.querySelector(`[data-orient="${param.key}"]`)?.closest('label');
    return document.querySelector(`[data-socket-param="${param.key}"]`)?.closest('label');
}
function clearNotes() {
    notes.forEach(n => n.remove());
    notes = [];
    document.querySelectorAll('.cmp-row-flag').forEach(n => n.classList.remove('cmp-row-flag', 'is-match', 'is-close', 'is-off'));
}
function renderNotes(r, scroll = true) {
    clearNotes();
    S.results.forEach(x => {
        const anchor = anchorFor(x.param);
        if (!anchor) return;
        anchor.classList.add('cmp-row-flag', `is-${x.status}`);
        const note = el('div', `cmp-note is-${x.status}${x.param.key === r.param.key ? ' open' : ''}`);
        note.innerHTML = x.param.key === r.param.key
            ? `<div class="cmp-note-head">${chip(x.status)}<b>${escapeHTML(x.param.label)}</b><span>Solution: ${escapeHTML(x.expert)}</span></div>${detailHTML(x)}`
            : `<button type="button" class="cmp-note-head" data-note>${chip(x.status)}<b>${escapeHTML(x.param.label)}</b><span>Solution: ${escapeHTML(x.expert)}</span>${icon('chevron-down')}</button>`;
        note.querySelector('[data-note]')?.addEventListener('click', () => select(x));
        note.querySelector('[data-featured]')?.addEventListener('click', () => { S.featured = !S.featured; select(S.current); });
        anchor.after(note);
        notes.push(note);
    });
    refreshIcons();
    if (scroll) requestAnimationFrame(() => notes.find(n => n.classList.contains('open'))?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
}
function renderBanner(r) {
    const { n, html } = mixBar(S.results);
    const i = S.list.indexOf(r);
    const open = banner.classList.contains('show-summary');
    banner.innerHTML = `<div class="cmp-banner-top"><span class="cmp-kicker">${icon('award')} How close you got</span><button type="button" class="grade-btn" data-done>${icon('check')} Done</button></div>
        <div class="cmp-banner-row"><b>${n.match} of ${S.results.length} match the solution</b>${html}</div>
        <div class="cmp-banner-row"><button type="button" class="grade-btn" data-prev ${i <= 0 ? 'disabled' : ''} aria-label="Previous difference">${icon('arrow-left')}</button><span class="cmp-banner-now">${i >= 0 ? `Difference ${i + 1} of ${S.list.length}: ` : ''}<b>${escapeHTML(r.param.label)}</b></span><button type="button" class="grade-btn" data-next aria-label="Next difference">${icon('arrow-right')}</button><button type="button" class="grade-btn" data-summary>${icon('list-checks')} Report</button></div>
        <div class="cmp-banner-summary">${S.results.map(x => `<button type="button" class="cmp-sum is-${x.status}${x.param.key === r.param.key ? ' active' : ''}" data-go="${escapeHTML(x.param.key)}"><span class="grade-step">${escapeHTML(x.param.step)}</span><b>${escapeHTML(x.param.label)}</b><small>${escapeHTML(x.yours)}</small>${chip(x.status)}</button>`).join('')}</div>`;
    banner.classList.toggle('show-summary', open);
    refreshIcons();
}

// ---- start ---------------------------------------------------------------------------------------------------------
async function boot() {
    W = window.gapWalkthrough || await new Promise(resolve => window.addEventListener('gap-walkthrough-ready', () => resolve(window.gapWalkthrough), { once: true }));
    try {
        key = prepareKey(await fetch(KEY_URL, { cache: 'no-store' }).then(r => { if (!r.ok) throw new Error(r.status); return r.json(); }));
    } catch (error) {
        console.warn('Solution key not available:', KEY_URL, error);
        document.querySelectorAll('[data-grade-open]').forEach(b => { b.hidden = true; });
        return;
    }
    document.querySelectorAll('[data-grade-open]').forEach(b => b.addEventListener('click', () => start()));
    document.addEventListener('keydown', event => { if (event.key === 'Escape' && S.active && !event.target.closest('input, select, textarea')) stop(); });
    if (params.has('compare')) start();
}
boot();
