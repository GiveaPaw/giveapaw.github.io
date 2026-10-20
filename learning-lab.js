// Anatomy Learning Lab (anatomy-learning-lab.html): five study methods with
// research behind them, each running on the outlines traced for the quizzes.
//
//   spaced      retrieval practice + spaced repetition (Leitner boxes)
//   draw        draw a structure from memory, scored by overlap
//   confidence  answer, rate how sure you are, see your calibration
//   compare     dog vs human: find the same bone in the other species
//   steps       learner-paced, one structure at a time, with cumulative checks
//
// Sets come from the quiz data files plus their cloud copies (anatomy-cloud.js),
// so every set labelled in the editor joins in once it has enough outlines.
(() => {
    'use strict';
    const app = document.getElementById('ll-app');
    if (!app) return;
    const SVGNS = 'http://www.w3.org/2000/svg';
    const MIN = 60e3, DAY = 864e5;

    // ------------------------------------------------------------ sources
    const SOURCES = [
        { page: 'anatomy-quiz.html', data: 'quiz-data-canine.js', region: 'Dog', names: { bones: 'Dog skeleton', 'thoracic-bones': 'Dog front leg' } },
        { page: 'human-anatomy-quiz.html', data: 'quiz-data-human.js', region: 'Human', names: { bones: 'Human skeleton', 'upper-limb-bones': 'Human arm' } },
        { page: 'ear-anatomy-quiz.html', data: 'quiz-data-ear.js', region: 'Ear', names: { bones: 'Ear: outer ear landmarks', section: 'Ear: outer, middle and inner ear' } },
        { page: 'knee-anatomy-quiz.html', data: 'quiz-data-knee.js', region: 'Knee' },
        { page: 'heart-anatomy-quiz.html', data: 'quiz-data-heart.js', region: 'Heart' },
        { page: 'hand-anatomy-quiz.html', data: 'quiz-data-hand.js', region: 'Hand' },
        { page: 'arm-anatomy-quiz.html', data: 'quiz-data-arm.js', region: 'Arm' },
        { page: 'chest-anatomy-quiz.html', data: 'quiz-data-chest.js', region: 'Chest' },
        { page: 'organs-anatomy-quiz.html', data: 'quiz-data-organs.js', region: 'Organs' },
        { page: 'foot-anatomy-quiz.html', data: 'quiz-data-foot.js', region: 'Foot' },
        { page: 'head-anatomy-quiz.html', data: 'quiz-data-head.js', region: 'Head' },
        { page: 'spine-anatomy-quiz.html', data: 'quiz-data-spine.js', region: 'Spine' },
    ];
    const MIN_ITEMS = 4;           // a set needs this many outlines to be used

    const hasShape = it => !!(it.points && it.points.length >= 3);
    const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
    const pretty = k => k.replace(/-/g, ' ').replace(/^./, c => c.toUpperCase());
    const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
    const store = {
        get(k, d) { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } },
        set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
    };
    const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };

    async function loadSource(src) {
        const res = await fetch(src.data + '?t=' + Date.now());
        if (!res.ok) return [];
        const w = {};
        new Function('window', await res.text())(w);
        const cfg = w.QUIZ_CONFIG;
        if (window.AnatomyCloud) { try { await window.AnatomyCloud.syncConfig(cfg, src.page, 5000); } catch (e) {} }
        const titles = await tabTitles(src.page);
        return Object.keys(cfg.quizzes).map(key => {
            const q = cfg.quizzes[key];
            const items = q.items.filter(hasShape);
            return {
                id: src.page.replace('.html', '') + ':' + key,
                title: (src.names && src.names[key]) || (src.region + ': ' + (titles[key] || pretty(key))),
                region: src.region, key, page: src.page, image: q.image, noun: q.noun || 'structure',
                items, total: q.items.length, descriptions: cfg.descriptions || {},
            };
        });
    }
    // the set names shown on each quiz page's tabs
    async function tabTitles(page) {
        try {
            const html = await (await fetch(page)).text();
            const out = {};
            html.replace(/data-quiz="([^"]+)">([^<]+)</g, (m, k, t) => { out[k] = t.replace(/&amp;/g, '&').trim(); });
            return out;
        } catch (e) { return {}; }
    }

    // ------------------------------------------------------------ geometry
    // Same closed Catmull-Rom curve as quiz-engine.js, so outlines match the quizzes.
    function smoothPath(pts, smooth) {
        const s = Math.max(0, Math.min(1, smooth == null ? 0.6 : smooth)) / 6 * 4;
        const n = pts.length, at = i => pts[(i + n) % n];
        let d = 'M ' + at(0)[0] + ' ' + at(0)[1];
        for (let i = 0; i < n; i++) {
            const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
            d += ' C ' + (p1[0] + (p2[0] - p0[0]) * s / 4).toFixed(2) + ' ' + (p1[1] + (p2[1] - p0[1]) * s / 4).toFixed(2) +
                ', ' + (p2[0] - (p3[0] - p1[0]) * s / 4).toFixed(2) + ' ' + (p2[1] - (p3[1] - p1[1]) * s / 4).toFixed(2) +
                ', ' + p2[0] + ' ' + p2[1];
        }
        return d + ' Z';
    }
    const sampled = new WeakMap();
    function outline(it) {
        let o = sampled.get(it);
        if (o) return o;
        const s = Math.max(0, Math.min(1, it.smooth == null ? 0.6 : it.smooth)) / 6 * 4;
        const pts = it.points, n = pts.length, at = i => pts[(i + n) % n];
        o = [];
        for (let i = 0; i < n; i++) {
            const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
            const c1x = p1[0] + (p2[0] - p0[0]) * s / 4, c1y = p1[1] + (p2[1] - p0[1]) * s / 4;
            const c2x = p2[0] - (p3[0] - p1[0]) * s / 4, c2y = p2[1] - (p3[1] - p1[1]) * s / 4;
            for (let k = 0; k < 8; k++) {
                const u = k / 8, v = 1 - u;
                o.push([v * v * v * p1[0] + 3 * v * v * u * c1x + 3 * v * u * u * c2x + u * u * u * p2[0],
                        v * v * v * p1[1] + 3 * v * v * u * c1y + 3 * v * u * u * c2y + u * u * u * p2[1]]);
            }
        }
        sampled.set(it, o);
        return o;
    }
    function inside(o, x, y) {
        let hit = false;
        for (let i = 0, j = o.length - 1; i < o.length; j = i++) {
            const [xi, yi] = o[i], [xj, yj] = o[j];
            if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) hit = !hit;
        }
        return hit;
    }
    function area(o) {
        let a = 0;
        for (let i = 0, j = o.length - 1; i < o.length; j = i++) a += (o[j][0] + o[i][0]) * (o[j][1] - o[i][1]);
        return Math.abs(a / 2);
    }
    // smallest outline under the point wins, as in the quizzes
    function hitItem(items, x, y) {
        let best = null, ba = Infinity;
        items.forEach(it => { const o = outline(it); if (inside(o, x, y)) { const a = area(o); if (a < ba) { ba = a; best = it; } } });
        return best;
    }
    // a fingertip just outside a small outline still counts (within 14 px)
    function nearItem(items, x, y, rect) {
        const kx = rect.width / 100, ky = rect.height / 100;
        let best = null, bd = 14;
        items.forEach(it => {
            const o = outline(it);
            for (let i = 0, j = o.length - 1; i < o.length; j = i++) {
                const ax = o[j][0] * kx, ay = o[j][1] * ky, bx = o[i][0] * kx, by = o[i][1] * ky;
                const px = x * kx, py = y * ky, dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
                const t = L ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L)) : 0;
                const d = Math.hypot(px - ax - t * dx, py - ay - t * dy);
                if (d < bd) { bd = d; best = it; }
            }
        });
        return best;
    }
    function centroid(o) { let x = 0, y = 0; o.forEach(p => { x += p[0]; y += p[1]; }); return [x / o.length, y / o.length]; }

    // ------------------------------------------------------------ answers
    const norm = s => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
    const deplural = s => s.split(' ').map(w => (w.length > 3 ? w.replace(/s$/, '') : w)).join(' ');
    function editDistance(a, b) {
        if (Math.abs(a.length - b.length) > 2) return 99;
        const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
        for (let j = 1; j <= b.length; j++) dp[0][j] = j;
        for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
            dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        return dp[a.length][b.length];
    }
    function answerMatches(input, name) {
        const g = deplural(norm(input));
        if (!g) return false;
        const ok = [norm(name)];
        const par = name.match(/\(([^)]+)\)/);
        if (par) { ok.push(norm(name.replace(/\([^)]*\)/g, ''))); ok.push(norm(par[1])); }
        return ok.filter(Boolean).some(t => {
            t = deplural(t);
            if (g === t) return true;
            const tol = t.length >= 10 ? 2 : (t.length >= 6 ? 1 : 0);
            return tol > 0 && editDistance(g, t) <= tol;
        });
    }

    // ------------------------------------------------------------ figure
    // An image with an SVG overlay in percent coordinates, like the quizzes.
    function figure(host, set, opts) {
        opts = opts || {};
        const wrap = el('div', 'll-fig' + (opts.cls ? ' ' + opts.cls : ''));
        const frame = el('div', 'll-frame');
        const img = el('img');
        img.src = set.image;
        img.alt = set.title;
        img.draggable = false;
        const svg = document.createElementNS(SVGNS, 'svg');
        svg.setAttribute('viewBox', '0 0 100 100');
        svg.setAttribute('preserveAspectRatio', 'none');
        svg.setAttribute('class', 'll-overlay');
        const labels = el('div', 'll-labels');
        frame.append(img, svg, labels);
        wrap.append(frame);
        host.append(wrap);
        const api = {
            wrap, frame, img, svg,
            clear() { svg.innerHTML = ''; labels.innerHTML = ''; },
            shape(it, cls) {
                const p = document.createElementNS(SVGNS, 'path');
                p.setAttribute('d', smoothPath(it.points, it.smooth));
                p.setAttribute('class', 'll-shape ' + (cls || ''));
                svg.appendChild(p);
                return p;
            },
            poly(pts, cls, closed) {
                const p = document.createElementNS(SVGNS, 'path');
                p.setAttribute('d', 'M ' + pts.map(q => q[0].toFixed(2) + ' ' + q[1].toFixed(2)).join(' L ') + (closed ? ' Z' : ''));
                p.setAttribute('class', 'll-shape ' + (cls || ''));
                svg.appendChild(p);
                return p;
            },
            // a name right next to its structure (spatial contiguity)
            label(it, text, cls) {
                const t = el('span', 'll-label ' + (cls || ''));
                t.textContent = text;
                t.style.left = it.x + '%';
                t.style.top = it.y + '%';
                labels.appendChild(t);
                return t;
            },
            pct(ev) {
                const r = img.getBoundingClientRect();
                return [(ev.clientX - r.left) / r.width * 100, (ev.clientY - r.top) / r.height * 100];
            },
            onTap(cb) {
                frame.addEventListener('click', ev => {
                    const [x, y] = api.pct(ev);
                    if (x < 0 || x > 100 || y < 0 || y > 100) return;
                    cb(x, y, hitItem(set.items, x, y) || nearItem(set.items, x, y, img.getBoundingClientRect()));
                });
            },
        };
        return api;
    }

    // a one-line finding with the full summary and references one tap away
    function research(teaser, html) {
        return '<details class="ll-research"><summary><b>The research:</b> ' + teaser + ' <span class="ll-more">Read more</span></summary>' + html + '</details>';
    }
    function setPicker(sets, current, onPick) {
        const lab = el('label', 'll-picker', '<span>Set</span>');
        const sel = el('select');
        sets.forEach(s => { const o = el('option'); o.value = s.id; o.textContent = s.title + ' (' + s.items.length + ')'; sel.appendChild(o); });
        sel.value = current;
        sel.addEventListener('change', () => onPick(sel.value));
        lab.appendChild(sel);
        return lab;
    }

    // ================================================================ 1
    // Spaced review: recall the name, check, rate. A Leitner schedule brings a
    // card back sooner when it was hard and later each time it is remembered.
    const STEPS = [0, 10 * MIN, DAY, 3 * DAY, 7 * DAY, 16 * DAY, 35 * DAY];
    const NEW_PER_DAY = 6;
    function fmtInterval(ms) {
        if (ms < 2 * MIN) return '1 min';
        if (ms < 90 * MIN) return Math.round(ms / MIN) + ' min';
        if (ms < 0.9 * DAY) return Math.round(ms / 36e5) + ' h';
        const d = Math.round(ms / DAY);
        return d + (d === 1 ? ' day' : ' days');
    }
    function demoSpaced(host, sets) {
        let setId = store.get('ll-spaced-set', sets[0].id);
        if (!sets.some(s => s.id === setId)) setId = sets[0].id;
        const now = () => Date.now() + store.get('ll-spaced-offset', 0);
        const dayKey = t => new Date(t).toISOString().slice(0, 10);
        let set, deck, card, shown;

        host.innerHTML = '<div class="ll-demo-head"><h2>Spaced review</h2>' +
            '<p class="ll-lede">Look at the highlighted structure and <strong>recall its name before you check</strong>. Then rate yourself. Cards you find hard come back in minutes; cards you know come back after 1, 3, 7, 16 and 35 days.</p></div>' +
            research('recalling beats rereading, and spacing beats cramming.', '<p>Pulling an answer out of memory strengthens it far more than reading it again (the <em>testing effect</em>), and spreading the practice out beats cramming it into one sitting. In an anatomy and physiology course, students kept about 41% more of the material they had been quizzed on (Dobson, 2013). Spreading retrieval over several days gave better muscle-anatomy recall a week later than doing it all at once (Dobson, Perez &amp; Linderholm, 2017), and a gross anatomy course with about 248 students saw better final-exam performance from retrieval practice (Azzam &amp; Easteal, 2021).</p>' +
                '<ul class="ll-refs"><li><a href="https://scholars.georgiasouthern.edu/en/publications/retrieval-practice-is-an-efficient-method-of-enhancing-the-retent/" target="_blank" rel="noopener">Dobson (2013), Advances in Physiology Education</a></li>' +
                '<li><a href="https://scholars.georgiasouthern.edu/en/publications/distributed-retrieval-practice-promotes-superior-recall-of-anatom-3/" target="_blank" rel="noopener">Dobson, Perez &amp; Linderholm (2017), Anatomical Sciences Education</a></li>' +
                '<li><a href="https://www.ncbi.nlm.nih.gov/pmc/articles/PMC8368804/" target="_blank" rel="noopener">Azzam &amp; Easteal (2021), Medical Science Educator</a></li>' +
                '<li><a href="https://www.ncbi.nlm.nih.gov/pmc/articles/PMC9005759/" target="_blank" rel="noopener">Review: test-enhanced learning in medical education</a></li></ul>');
        const bar = el('div', 'll-toolbar');
        const stats = el('div', 'll-boxes');
        const stage = el('div', 'll-stage');
        const fig = el('div', 'll-figure-col');
        const panel = el('div', 'll-panel');
        stage.append(fig, panel);
        host.append(bar, stats, stage);

        function load(id) {
            setId = id;
            store.set('ll-spaced-set', id);
            set = sets.find(s => s.id === id);
            deck = store.get('ll-srs:' + id, {});
            set.items.forEach(it => { if (!deck[it.name]) deck[it.name] = { box: 0, due: 0 }; });
            bar.innerHTML = '';
            bar.appendChild(setPicker(sets, id, load));
            const skip = el('button', 'll-btn ll-ghost', 'Skip ahead 1 day');
            skip.title = 'See the schedule work without waiting a day';
            skip.addEventListener('click', () => { store.set('ll-spaced-offset', store.get('ll-spaced-offset', 0) + DAY); next(); });
            const reset = el('button', 'll-btn ll-ghost', 'Start this set over');
            reset.addEventListener('click', () => {
                if (!confirm('Forget your progress on this set?')) return;
                deck = {};
                set.items.forEach(it => { deck[it.name] = { box: 0, due: 0 }; });
                save();
                store.set('ll-spaced-offset', 0);
                store.set('ll-spaced-new', {});
                next();
            });
            bar.append(skip, reset);
            fig.innerHTML = '';
            card = figure(fig, set);
            next();
        }
        const save = () => store.set('ll-srs:' + setId, deck);
        function renderBoxes() {
            const counts = [0, 0, 0, 0, 0, 0, 0];
            let due = 0;
            set.items.forEach(it => { const c = deck[it.name]; counts[c.box]++; if (c.box > 0 && c.due <= now()) due++; });
            const label = ['New', 'Learning', '1 day', '3 days', '7 days', '16 days', '35 days'];
            stats.innerHTML = '<span class="ll-boxes-sum"><b>' + due + '</b> due now</span>' + counts.map((n, i) =>
                '<span class="ll-box' + (i === 0 ? ' ll-box-new' : '') + '" title="' + label[i] + '"><i style="--n:' + Math.min(1, n / Math.max(1, set.items.length)) + '"></i><b>' + n + '</b><small>' + label[i] + '</small></span>').join('');
        }
        function pick() {
            const t = now();
            const due = set.items.filter(it => deck[it.name].box > 0 && deck[it.name].due <= t)
                .sort((a, b) => deck[a.name].due - deck[b.name].due);
            if (due.length) return due[0];
            const newDay = store.get('ll-spaced-new', {});
            const done = newDay[setId + '|' + dayKey(t)] || 0;
            if (done < NEW_PER_DAY) return set.items.find(it => deck[it.name].box === 0) || null;
            return null;
        }
        function next() {
            renderBoxes();
            card.clear();
            shown = pick();
            panel.innerHTML = '';
            if (!shown) {
                const t = now();
                const upcoming = set.items.map(it => deck[it.name]).filter(c => c.box > 0).map(c => c.due).sort((a, b) => a - b)[0];
                const soon = upcoming && upcoming - t < 15 * MIN;
                panel.innerHTML = '<p class="ll-big">All caught up.</p><p>' + (upcoming ? 'Next card due in ' + fmtInterval(upcoming - t) + '.' : 'No cards scheduled.') +
                    ' New cards are limited to ' + NEW_PER_DAY + ' a day, so the reviews never pile up.</p>';
                if (soon) {
                    const b = el('button', 'll-btn', 'Review the next one now');
                    b.addEventListener('click', () => { const c = set.items.map(it => deck[it.name]).filter(c => c.box > 0).sort((a, b) => a.due - b.due)[0]; c.due = now(); save(); next(); });
                    panel.appendChild(b);
                }
                return;
            }
            card.shape(shown, 'll-target');
            const c = deck[shown.name];
            panel.innerHTML = '<p class="ll-kicker">' + (c.box === 0 ? 'New card' : 'Review') + '</p>' +
                '<p class="ll-big">What is the highlighted ' + esc(set.noun) + '?</p>' +
                '<p class="ll-muted">Say it to yourself, or type it. Then check.</p>';
            const form = el('form', 'll-answer');
            form.innerHTML = '<input type="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Name (optional)"><button class="ll-btn">Check</button>';
            form.addEventListener('submit', e => { e.preventDefault(); reveal(form.querySelector('input').value); });
            panel.appendChild(form);
        }
        function intervalFor(g, c) {
            if (g === 'again') return MIN;
            if (g === 'hard') return Math.max(5 * MIN, STEPS[Math.max(1, c.box)] * 0.5);
            return STEPS[Math.min(6, c.box + (g === 'easy' ? 2 : 1))];
        }
        function reveal(typed) {
            const c = deck[shown.name];
            card.label(shown, shown.name, 'll-label-answer');
            const typedOk = typed && typed.trim() ? answerMatches(typed, shown.name) : null;
            panel.innerHTML = '<p class="ll-kicker">Answer</p><p class="ll-big">' + esc(shown.name) + '</p>' +
                (typedOk === true ? '<p class="ll-good">You typed it correctly.</p>' : typedOk === false ? '<p class="ll-bad">You typed &ldquo;' + esc(typed) + '&rdquo;.</p>' : '') +
                (set.descriptions[shown.name] ? '<p class="ll-muted">' + esc(set.descriptions[shown.name]) + '</p>' : '') +
                '<p>How well did you remember it?</p>';
            const row = el('div', 'll-grades');
            [['again', 'Forgot'], ['hard', 'Hard'], ['good', 'Good'], ['easy', 'Easy']].forEach(([g, t]) => {
                const b = el('button', 'll-btn ll-grade ll-g-' + g, t + '<small>' + fmtInterval(intervalFor(g, c)) + '</small>');
                b.addEventListener('click', () => grade(g));
                row.appendChild(b);
            });
            panel.appendChild(row);
        }
        function grade(g) {
            const c = deck[shown.name];
            const wasNew = c.box === 0;
            const wait = intervalFor(g, c);
            if (g === 'again') { c.box = 1; c.lapses = (c.lapses || 0) + 1; }
            else if (g === 'good') c.box = Math.min(6, c.box + 1);
            else if (g === 'easy') c.box = Math.min(6, c.box + 2);
            else c.box = Math.max(1, c.box);
            c.due = now() + wait;
            c.reps = (c.reps || 0) + 1;
            if (wasNew) {
                const nd = store.get('ll-spaced-new', {});
                const k = setId + '|' + dayKey(now());
                nd[k] = (nd[k] || 0) + 1;
                store.set('ll-spaced-new', nd);
            }
            save();
            next();
        }
        load(setId);
    }

    // ================================================================ 2
    // Draw it from memory: sketch the outline, then compare with the real one.
    function demoDraw(host, sets) {
        let setId = store.get('ll-draw-set', sets[0].id);
        if (!sets.some(s => s.id === setId)) setId = sets[0].id;
        let set, fig, target, pts = [], drawing = false, checked = false, order = [], pool = [], faint = store.get('ll-draw-faint', true);
        // structures only a few pixels across cannot be drawn with a finger
        function drawablePool(st) {
            const big = st.items.filter(it => {
                const xs = it.points.map(p => p[0]), ys = it.points.map(p => p[1]);
                return Math.max(...xs) - Math.min(...xs) >= 2.5 && Math.max(...ys) - Math.min(...ys) >= 3;
            });
            return big.length >= MIN_ITEMS ? big : st.items;
        }
        host.innerHTML = '<div class="ll-demo-head"><h2>Draw it from memory</h2>' +
            '<p class="ll-lede">Draw the outline of the named structure with your finger or pencil, then check it against the real outline. The picture starts faint, so the shape has to come from memory; turn it up while you are learning.</p></div>' +
            research('drawing a structure fixes it in memory better than writing about it.', '<p>Drawing something makes you rebuild it: its shape, where it sits and what it touches. In memory experiments, people who drew words recalled them better than people who wrote them out, often about twice as many, and the quality of the drawing did not matter (Wammes, Meade &amp; Fernandes, 2016). In anatomy, a controlled comparison of drawing, clay modelling and a 3D app for spinal anatomy found drawing an effective way to learn it. Reviews add a caveat: drawing helps most when learners check their drawing against the correct one, which is what this demo does (Fiorella &amp; Zhang, 2018).</p>' +
                '<ul class="ll-refs"><li><a href="https://uwaterloo.ca/psychology/news/need-remember-something-better-draw-it-study-finds" target="_blank" rel="noopener">Wammes, Meade &amp; Fernandes (2016), Quarterly Journal of Experimental Psychology</a></li>' +
                '<li><a href="https://otl.uoguelph.ca/learning-drawing-can-improve-anatomical-knowledge-medical-students" target="_blank" rel="noopener">Learning by drawing can improve anatomical knowledge of medical students</a></li>' +
                '<li><a href="https://scholar.google.com/scholar?q=Fiorella+Zhang+2018+Drawing+boundary+conditions+for+learning+by+drawing" target="_blank" rel="noopener">Fiorella &amp; Zhang (2018), Drawing boundary conditions for learning by drawing</a></li></ul>');
        const bar = el('div', 'll-toolbar');
        const stage = el('div', 'll-stage');
        const col = el('div', 'll-figure-col');
        const panel = el('div', 'll-panel');
        stage.append(col, panel);
        host.append(bar, stage);

        function load(id) {
            setId = id;
            store.set('ll-draw-set', id);
            set = sets.find(s => s.id === id);
            pool = drawablePool(set);
            order = shuffle(pool);
            bar.innerHTML = '';
            bar.appendChild(setPicker(sets, id, load));
            const fb = el('label', 'll-check', '<input type="checkbox"> Faint picture (harder)');
            const cb = fb.querySelector('input');
            cb.checked = faint;
            cb.addEventListener('change', () => { faint = cb.checked; store.set('ll-draw-faint', faint); fig.wrap.classList.toggle('ll-faint', faint && !checked); });
            bar.appendChild(fb);
            col.innerHTML = '';
            fig = figure(col, set, { cls: 'll-drawable' });
            bindDrawing();
            nextTarget();
        }
        function nextTarget() {
            if (!order.length) order = shuffle(pool);
            target = order.pop();
            pts = [];
            checked = false;
            fig.clear();
            fig.wrap.classList.toggle('ll-faint', faint);
            const best = store.get('ll-draw-best:' + setId, {})[target.name];
            panel.innerHTML = '<p class="ll-kicker">Draw</p><p class="ll-big">' + esc(target.name) + '</p>' +
                '<p class="ll-muted">Draw one closed loop around it. Lift your finger to finish; drawing again starts over.</p>' +
                (best != null ? '<p class="ll-muted">Your best so far: ' + best + '%</p>' : '');
            const row = el('div', 'll-row');
            const check = el('button', 'll-btn', 'Check my drawing');
            check.disabled = true;
            check.addEventListener('click', score);
            const skip = el('button', 'll-btn ll-ghost', 'Skip');
            skip.addEventListener('click', nextTarget);
            row.append(check, skip);
            panel.appendChild(row);
            panel._check = check;
        }
        function bindDrawing() {
            const f = fig.frame;
            f.addEventListener('pointerdown', e => {
                if (checked) return;
                e.preventDefault();
                drawing = true;
                pts = [fig.pct(e)];
                try { f.setPointerCapture(e.pointerId); } catch (err) {}
                redraw();
            });
            f.addEventListener('pointermove', e => {
                if (!drawing) return;
                const p = fig.pct(e), q = pts[pts.length - 1];
                if (Math.hypot(p[0] - q[0], p[1] - q[1]) > 0.35) { pts.push(p); redraw(); }
            });
            const up = () => {
                if (!drawing) return;
                drawing = false;
                redraw(true);
                if (panel._check) panel._check.disabled = pts.length < 6;
            };
            f.addEventListener('pointerup', up);
            f.addEventListener('pointercancel', up);
        }
        function redraw(closed) {
            fig.clear();
            if (pts.length > 1) fig.poly(pts, 'll-mine', closed);
        }
        // overlap of the drawing and the true outline (intersection over union)
        function score() {
            const mine = pts.map(p => [Math.min(100, Math.max(0, p[0])), Math.min(100, Math.max(0, p[1]))]);
            const truth = outline(target);
            const all = mine.concat(truth);
            const x0 = Math.min(...all.map(p => p[0])), x1 = Math.max(...all.map(p => p[0]));
            const y0 = Math.min(...all.map(p => p[1])), y1 = Math.max(...all.map(p => p[1]));
            let a = 0, b = 0, both = 0;
            const N = 90;
            for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
                const x = x0 + (x1 - x0) * (i + 0.5) / N, y = y0 + (y1 - y0) * (j + 0.5) / N;
                const inA = inside(mine, x, y), inB = inside(truth, x, y);
                if (inA) a++; if (inB) b++; if (inA && inB) both++;
            }
            const iou = (a + b - both) ? both / (a + b - both) : 0;
            const pct = Math.round(iou * 100);
            checked = true;
            fig.wrap.classList.remove('ll-faint');
            fig.clear();
            fig.shape(target, 'll-truth');
            fig.poly(mine, 'll-mine', true);
            fig.label(target, target.name, 'll-label-answer');
            // drawn somewhere else entirely? say what is there
            const c = centroid(mine);
            const there = hitItem(set.items, c[0], c[1]);
            const best = store.get('ll-draw-best:' + setId, {});
            const prev = best[target.name];
            if (prev == null || pct > prev) { best[target.name] = pct; store.set('ll-draw-best:' + setId, best); }
            const verdict = pct >= 60 ? ['ll-good', 'Excellent match.'] : pct >= 35 ? ['ll-ok', 'Close: compare the edges.'] : pct > 5 ? ['ll-bad', 'Right area, wrong shape or size.'] : ['ll-bad', there && there !== target ? 'That is where the ' + esc(there.name) + ' is.' : 'Not quite there.'];
            panel.innerHTML = '<p class="ll-kicker">Overlap</p><p class="ll-score">' + pct + '%</p>' +
                '<p class="' + verdict[0] + '">' + verdict[1] + '</p>' +
                '<p class="ll-legend"><span class="ll-key ll-key-mine"></span>your drawing <span class="ll-key ll-key-truth"></span>the real outline</p>' +
                (prev != null ? '<p class="ll-muted">Previous best: ' + prev + '%</p>' : '');
            const row = el('div', 'll-row');
            const again = el('button', 'll-btn ll-ghost', 'Try this one again');
            again.addEventListener('click', () => { order.push(target); nextTarget(); });
            const nx = el('button', 'll-btn', 'Next structure');
            nx.addEventListener('click', nextTarget);
            row.append(nx, again);
            panel.appendChild(row);
        }
        load(setId);
    }

    // ================================================================ 3
    // How sure are you? Answer, rate your confidence, then see the answer.
    function demoConfidence(host, sets) {
        let setId = store.get('ll-conf-set', sets[0].id);
        if (!sets.some(s => s.id === setId)) setId = sets[0].id;
        const LEVELS = ['Guessing', 'Fairly sure', 'Certain'];
        let set, fig, queue, results, cur, picked;
        host.innerHTML = '<div class="ll-demo-head"><h2>How sure are you?</h2>' +
            '<p class="ll-lede">Pick an answer, then say how sure you are <strong>before</strong> you see if it is right. Answers you were certain about but got wrong come back at the end of the round, and the summary shows how well your confidence matches what you actually know.</p></div>' +
            research('confident mistakes, once corrected, are remembered best.', '<p>Knowing what you do not know is half of studying well. When people are confidently wrong and then see the correct answer, the surprise makes the correction stick unusually well: the <em>hypercorrection effect</em> (Butterfield &amp; Metcalfe, 2001). It lasts at least a week, but confident errors are also the ones most likely to creep back, so they need to be tested again later (Butler, Fazio &amp; Marsh, 2011), which is why they reappear at the end of the round. Students rarely judge their own confidence unless asked, so the demo asks every time.</p>' +
                '<ul class="ll-refs"><li><a href="https://scholar.google.com/scholar?q=Butterfield+Metcalfe+2001+Errors+committed+with+high+confidence+are+hypercorrected" target="_blank" rel="noopener">Butterfield &amp; Metcalfe (2001), Errors committed with high confidence are hypercorrected</a></li>' +
                '<li><a href="https://profiles.wustl.edu/en/publications/the-hypercorrection-effect-persists-over-a-week-but-high-confiden/" target="_blank" rel="noopener">Butler, Fazio &amp; Marsh (2011), The hypercorrection effect persists over a week</a></li></ul>');
        const bar = el('div', 'll-toolbar');
        const stage = el('div', 'll-stage');
        const col = el('div', 'll-figure-col');
        const panel = el('div', 'll-panel');
        stage.append(col, panel);
        host.append(bar, stage);

        function load(id) {
            setId = id;
            store.set('ll-conf-set', id);
            set = sets.find(s => s.id === id);
            bar.innerHTML = '';
            bar.appendChild(setPicker(sets, id, load));
            col.innerHTML = '';
            fig = figure(col, set);
            start();
        }
        function start() {
            queue = shuffle(set.items).slice(0, Math.min(10, set.items.length)).map(it => ({ it, retest: false }));
            results = [];
            ask();
        }
        function ask() {
            fig.clear();
            if (!queue.length) { summary(); return; }
            cur = queue.shift();
            picked = null;
            fig.shape(cur.it, 'll-target');
            const n = results.filter(r => !r.retest).length + (cur.retest ? 0 : 1);
            panel.innerHTML = '<p class="ll-kicker">' + (cur.retest ? 'Second chance' : 'Question ' + n) + '</p>' +
                '<p class="ll-big">Which ' + esc(set.noun) + ' is highlighted?</p>';
            const opts = el('div', 'll-options');
            const others = shuffle(set.items.filter(o => o !== cur.it)).slice(0, 3);
            shuffle([cur.it, ...others]).forEach(o => {
                const b = el('button', 'll-option');
                b.textContent = o.name;
                b.addEventListener('click', () => {
                    picked = o;
                    opts.querySelectorAll('.ll-option').forEach(x => x.classList.toggle('ll-picked', x === b));
                    conf.hidden = false;
                });
                opts.appendChild(b);
            });
            const conf = el('div', 'll-conf');
            conf.hidden = true;
            conf.innerHTML = '<p>How sure are you?</p>';
            const row = el('div', 'll-grades');
            LEVELS.forEach((t, i) => {
                const b = el('button', 'll-btn ll-conf-' + i, t);
                b.addEventListener('click', () => answer(i));
                row.appendChild(b);
            });
            conf.appendChild(row);
            panel.append(opts, conf);
        }
        function answer(level) {
            const ok = picked === cur.it;
            results.push({ name: cur.it.name, picked: picked.name, level, ok, retest: cur.retest });
            fig.clear();
            fig.shape(cur.it, ok ? 'll-right' : 'll-wrong');
            fig.label(cur.it, cur.it.name, 'll-label-answer');
            panel.querySelectorAll('.ll-option').forEach(b => {
                b.disabled = true;
                if (b.textContent === cur.it.name) b.classList.add('ll-correct');
                else if (b.classList.contains('ll-picked')) b.classList.add('ll-incorrect');
            });
            panel.querySelector('.ll-conf').remove();
            let msg;
            if (ok) msg = '<p class="ll-good">Correct' + (level === 0 ? ', and you thought you were guessing: you know more than you think.' : '.') + '</p>';
            else if (level === 2) {
                msg = '<p class="ll-surprise">Surprise: you were certain, but this is the <strong>' + esc(cur.it.name) + '</strong>, not the ' + esc(picked.name) + '. Take a good look; it comes back at the end of the round.</p>';
                if (!cur.retest) queue.push({ it: cur.it, retest: true });
            } else msg = '<p class="ll-bad">It is the ' + esc(cur.it.name) + '.</p>';
            panel.insertAdjacentHTML('beforeend', msg);
            const nx = el('button', 'll-btn', queue.length ? 'Next' : 'See my results');
            nx.addEventListener('click', ask);
            panel.appendChild(nx);
        }
        function summary() {
            const first = results.filter(r => !r.retest);
            const right = first.filter(r => r.ok).length;
            const rows = LEVELS.map((t, i) => {
                const rs = first.filter(r => r.level === i);
                const pct = rs.length ? Math.round(100 * rs.filter(r => r.ok).length / rs.length) : null;
                return '<tr><th>' + t + '</th><td>' + rs.length + '</td><td><span class="ll-meter"><i style="width:' + (pct || 0) + '%"></i></span> ' + (pct == null ? '&ndash;' : pct + '%') + '</td></tr>';
            }).join('');
            const certain = first.filter(r => r.level === 2);
            const certainPct = certain.length ? Math.round(100 * certain.filter(r => r.ok).length / certain.length) : null;
            const confident = first.filter(r => r.level === 2 && !r.ok);
            const fixed = results.filter(r => r.retest && r.ok).length;
            panel.innerHTML = '<p class="ll-kicker">Round finished</p><p class="ll-big">' + right + ' / ' + first.length + ' correct</p>' +
                '<table class="ll-calib"><thead><tr><th>You said</th><th>Answers</th><th>Actually right</th></tr></thead><tbody>' + rows + '</tbody></table>' +
                '<p>' + (certainPct == null ? 'You never said Certain this round.' : 'When you were certain you were right ' + certainPct + '% of the time' + (certainPct >= 90 ? ': well calibrated.' : ': worth slowing down on those.')) + '</p>' +
                (confident.length ? '<p class="ll-surprise">Confident mistakes: ' + confident.map(r => esc(r.name) + ' (you said ' + esc(r.picked) + ')').join(', ') + '. Fixed on the second try: ' + fixed + ' of ' + confident.length + '.</p>' : '');
            const again = el('button', 'll-btn', 'New round');
            again.addEventListener('click', start);
            panel.appendChild(again);
        }
        load(setId);
    }

    // ================================================================ 4
    // Dog vs human: the same bone in two species, mixed and in both directions.
    const PAIRS = [
        ['Cranium (skull)', 'Cranium (skull)', 'The same braincase; a dog\'s face and jaws are far longer.'],
        ['Cervical vertebrae', 'Cervical vertebrae', 'Both have 7 neck vertebrae, as nearly all mammals do.'],
        ['Scapula', 'Scapula', 'A dog\'s shoulder blade lies flat against the side of the chest, not across the back.'],
        ['Humerus', 'Humerus', 'Upper arm bone in both. In a dog it runs from the shoulder at the front of the chest down to the elbow.'],
        ['Radius', 'Radius', 'Forearm bone that carries most of the weight at the wrist in both.'],
        ['Ulna', 'Ulna', 'Its tip is the point of the elbow in both species.'],
        ['Carpal bones', 'Carpals', 'The dog\'s "wrist" halfway down the front leg really is its wrist: dogs stand on their fingers (digitigrade).'],
        ['Metacarpal bones', 'Metacarpals', 'Palm bones. A dog\'s first metacarpal is small and carries the dewclaw.'],
        ['Phalanges (front paw)', 'Phalanges (hand)', 'Finger bones. A dog walks on these; people walk on the whole sole of the foot.'],
        ['Ribs', 'Ribs', 'Dogs have 13 pairs of ribs; people usually have 12.'],
        ['Sternum', 'Sternum', 'A dog\'s breastbone is a chain of 8 sternebrae; a human\'s is manubrium, body and xiphoid.'],
        ['Lumbar vertebrae', 'Lumbar vertebrae', 'Dogs have 7 lumbar vertebrae; people have 5.'],
        ['Sacrum', 'Sacrum', 'Fused vertebrae joining the spine to the pelvis: 3 in a dog, 5 in a person.'],
        ['Pelvis', 'Pelvis (hip bone)', 'Ilium, ischium and pubis fused into one hip bone on each side, in both.'],
        ['Femur', 'Femur', 'Thigh bone. A dog\'s knee (the stifle) sits close to the belly, so the thigh looks short.'],
        ['Patella', 'Patella', 'The kneecap, in the tendon of the quadriceps, in both species.'],
        ['Tibia', 'Tibia', 'The shin bone and the main weight-bearer of the lower leg in both.'],
        ['Fibula', 'Fibula', 'Thin and carries little weight in both, mostly a site for muscles to attach.'],
        ['Tarsal bones', 'Tarsals', 'Ankle bones. The dog\'s hock is its ankle, held high off the ground.'],
        ['Calcaneus', 'Tarsals', 'The point of a dog\'s hock is the calcaneus, the same bone as your heel (counted with the tarsals here).'],
        ['Metatarsal bones', 'Metatarsals', 'Foot bones; in a dog they form the long part of the hind leg below the hock.'],
        ['Phalanges (hind paw)', 'Phalanges (foot)', 'Toe bones, which carry a dog\'s weight on its paw pads.'],
    ];
    const HUMAN_ONLY = [['Clavicle', 'Most dogs have no working collarbone, at most a tiny vestige in the muscle. The front leg is held on by muscle alone, which lets the shoulder slide and lengthens the stride.']];
    function demoCompare(host, dog, human) {
        host.innerHTML = '<div class="ll-demo-head"><h2>Dog vs human</h2>' +
            '<p class="ll-lede">One bone lights up on one skeleton; <strong>tap the same bone on the other</strong>. Questions mix front and hind legs and switch direction, so you have to tell similar bones apart rather than repeat one pattern.</p></div>' +
            research('mixing similar items trains you to tell them apart.', '<p>Mixing related topics in one practice session (<em>interleaving</em>) instead of practising one at a time is harder in the moment but better for telling look-alike categories apart. In a study of 40 medical students learning to read radiographs, interleaved practice scored 57% against 43% for blocked practice. Studies of ECG interpretation suggest it pays off most once the basics are known, which is why this demo uses the skeletons you have already met in the quizzes. Comparing two species side by side is how comparative anatomists are trained (for example Bristol\'s human-and-veterinary dissection course), and it is the everyday job of a team fitting prostheses to dogs.</p>' +
                '<ul class="ll-refs"><li><a href="https://radiologybusiness.com/topics/healthcare-management/leadership/med-students-respond-better-spaced-out-education-strategy" target="_blank" rel="noopener">Interleaved vs massed practice for radiograph interpretation (40 medical students)</a></li>' +
                '<li><a href="https://link.springer.com/article/10.1007/s40037-017-0365-x" target="_blank" rel="noopener">Instruction and practice schedule in ECG interpretation, Perspectives on Medical Education</a></li>' +
                '<li><a href="https://research-information.bris.ac.uk/en/publications/of-mice-dogs-horses-sheep-and-men-a-novel-comparative-anatomy-dis/" target="_blank" rel="noopener">Of mice, dogs, horses, sheep and men: a comparative anatomy dissection course</a></li></ul>');
        if (!dog || !human) {
            host.insertAdjacentHTML('beforeend', '<p class="ll-bad">The dog or human skeleton outlines could not be loaded.</p>');
            return;
        }
        const byName = (set, n) => set.items.find(it => it.name === n);
        const pairs = PAIRS.filter(p => byName(dog, p[0]) && byName(human, p[1]));
        const status = el('div', 'll-toolbar');
        const prompt = el('div', 'll-compare-prompt');
        const two = el('div', 'll-two');
        const colD = el('div', 'll-species'), colH = el('div', 'll-species');
        colD.innerHTML = '<h3>Dog</h3>';
        colH.innerHTML = '<h3>Human</h3>';
        two.append(colD, colH);
        const after = el('div', 'll-compare-after');
        host.append(status, prompt, two, after);
        const fd = figure(colD, dog), fh = figure(colH, human);
        let score = 0, asked = 0, q = null, deck = [];
        // a deck that mixes limbs and directions, with the odd one out in it
        function newDeck() {
            // the calcaneus is asked from the dog side only: from the human side
            // it would be the same question as the tarsals
            deck = shuffle(pairs.map(p => ({ from: p[0] === 'Calcaneus' ? 'dog' : Math.random() < 0.5 ? 'dog' : 'human', pair: p })))
                .concat(HUMAN_ONLY.map(h => ({ from: 'human', only: h })));
            deck = shuffle(deck);
        }
        function nextQ() {
            if (!deck.length) newDeck();
            q = deck.pop();
            fd.clear(); fh.clear();
            after.innerHTML = '';
            const src = q.from === 'dog' ? fd : fh, tgt = q.from === 'dog' ? fh : fd;
            const srcSet = q.from === 'dog' ? dog : human;
            const name = q.only ? q.only[0] : (q.from === 'dog' ? q.pair[0] : q.pair[1]);
            src.shape(byName(srcSet, name), 'll-target');
            src.wrap.classList.add('ll-source');
            tgt.wrap.classList.remove('ll-source');
            tgt.wrap.classList.add('ll-tappable');
            src.wrap.classList.remove('ll-tappable');
            prompt.innerHTML = '<span><b>' + esc(name) + '</b> (lit up on the ' + q.from + '): tap the same bone on the <b>' + (q.from === 'dog' ? 'human' : 'dog') + '</b>.</span>';
            const none = el('button', 'll-btn ll-ghost', 'The ' + (q.from === 'dog' ? 'human' : 'dog') + ' has no such bone');
            none.addEventListener('click', () => judge(null));
            prompt.appendChild(none);
            status.innerHTML = '<span class="ll-boxes-sum"><b>' + score + '</b> / ' + asked + ' right</span>';
        }
        function judge(hit) {
            if (!q) return;
            const toDog = q.from === 'human';
            const tgtSet = toDog ? dog : human, tgt = toDog ? fd : fh;
            let goal = [], note;
            if (q.only) note = q.only[1];
            else {
                note = q.pair[2];
                // Tarsals in the human match both the dog's tarsals and calcaneus
                goal = toDog ? pairs.filter(p => p[1] === q.pair[1]).map(p => p[0]) : [q.pair[1]];
            }
            const ok = q.only ? hit === null : !!hit && goal.includes(hit.name);
            asked++;
            if (ok) score++;
            goal.forEach(n => tgt.shape(byName(tgtSet, n), 'll-right'));
            if (hit && !ok) tgt.shape(hit, 'll-wrong');
            const answer = q.only ? 'No match: the dog has no clavicle.' : 'It is the ' + goal.join(' / ') + '.';
            after.innerHTML = '<p class="' + (ok ? 'll-good' : 'll-bad') + '">' + (ok ? 'Yes. ' : (hit ? 'That is the ' + esc(hit.name) + '. ' : 'There is a match. ')) + esc(ok ? '' : answer) + '</p>' +
                '<p class="ll-note">' + esc(note) + '</p>';
            const nx = el('button', 'll-btn', 'Next bone');
            nx.addEventListener('click', nextQ);
            after.appendChild(nx);
            status.innerHTML = '<span class="ll-boxes-sum"><b>' + score + '</b> / ' + asked + ' right</span>';
            q = null;
        }
        fd.onTap((x, y, hit) => { if (q && q.from === 'human') judge(hit); });
        fh.onTap((x, y, hit) => { if (q && q.from === 'dog') judge(hit); });
        nextQ();
    }

    // ================================================================ 5
    // One step at a time: meet structures one by one, at your own pace, with
    // the name beside each, and a quick recall of everything so far every few.
    function demoSteps(host, sets) {
        const pref = sets.find(s => s.id === 'ear-anatomy-quiz:section');
        let setId = store.get('ll-steps-set', pref ? pref.id : sets[0].id);
        if (!sets.some(s => s.id === setId)) setId = sets[0].id;
        const CHUNK = 4;
        let set, fig, i, phase, checkQueue, checkRight;
        host.innerHTML = '<div class="ll-demo-head"><h2>One step at a time</h2>' +
            '<p class="ll-lede">Instead of a diagram with every label at once, meet the structures <strong>one at a time, at your own pace</strong>, with each name right beside its structure. Every ' + CHUNK + ' structures there is a quick check of everything so far.</p></div>' +
            research('small learner-paced steps beat one crowded diagram.', '<p>A fully labelled diagram asks you to take in everything at once. Breaking a lesson into learner-paced pieces (the <em>segmenting principle</em>) improved learning in all 10 of Mayer\'s experimental tests, with a median effect size of 0.79. Putting each label next to the thing it names (<em>spatial contiguity</em>) saves the effort of matching names to parts across a legend. The quick checks add retrieval practice, and because each one covers everything learned so far, earlier structures keep getting revisited.</p>' +
                '<ul class="ll-refs"><li><a href="https://www.cambridge.org/core/books/multimedia-learning/segmenting-principle/37240877DDA0362355ADB39936027982" target="_blank" rel="noopener">Mayer, Multimedia Learning: the segmenting principle</a></li>' +
                '<li><a href="https://cambridge.org/core/books/cambridge-handbook-of-multimedia-learning/principles-for-managing-essential-processing-in-multimedia-learning-segmenting-pretraining-and-modality-principles/DD24C2F48B9B1277CE59F78276110258" target="_blank" rel="noopener">Cambridge Handbook of Multimedia Learning: segmenting, pre-training and modality</a></li></ul>');
        const bar = el('div', 'll-toolbar');
        const prog = el('div', 'll-progress');
        const stage = el('div', 'll-stage');
        const col = el('div', 'll-figure-col');
        const panel = el('div', 'll-panel');
        stage.append(col, panel);
        host.append(bar, prog, stage);

        function load(id) {
            setId = id;
            store.set('ll-steps-set', id);
            set = sets.find(s => s.id === id);
            bar.innerHTML = '';
            bar.appendChild(setPicker(sets, id, load));
            col.innerHTML = '';
            fig = figure(col, set);
            fig.onTap((x, y, hit) => { if (phase === 'final') finalTap(hit); });
            i = 0;
            phase = 'learn';
            show();
        }
        function renderProgress() {
            prog.innerHTML = set.items.map((it, k) => '<i class="' + (k < i ? 'done' : k === i && phase === 'learn' ? 'now' : '') + '" title="' + esc(it.name) + '"></i>').join('');
        }
        function show() {
            renderProgress();
            fig.clear();
            const it = set.items[i];
            set.items.slice(0, i).forEach(o => fig.shape(o, 'll-seen'));
            fig.shape(it, 'll-target');
            fig.label(it, it.name, 'll-label-answer');
            panel.innerHTML = '<p class="ll-kicker">' + (i + 1) + ' of ' + set.items.length + '</p><p class="ll-big">' + esc(it.name) + '</p>' +
                (set.descriptions[it.name] ? '<p>' + esc(set.descriptions[it.name]) + '</p>' : '') +
                '<p class="ll-muted">Faint outlines are the ones you have already met.</p>';
            const row = el('div', 'll-row');
            if (i > 0) {
                const back = el('button', 'll-btn ll-ghost', 'Back');
                back.addEventListener('click', () => { i--; show(); });
                row.appendChild(back);
            }
            const nx = el('button', 'll-btn', 'Next');
            nx.addEventListener('click', () => {
                i++;
                if (i === set.items.length) startCheck(true);
                else if (i % CHUNK === 0) startCheck(false);
                else show();
            });
            row.appendChild(nx);
            panel.appendChild(row);
        }
        // recall check over everything met so far (the newest always included)
        function startCheck(final) {
            phase = 'check';
            const met = set.items.slice(0, i);
            const recent = met.slice(-CHUNK), older = shuffle(met.slice(0, -CHUNK)).slice(0, 2);
            checkQueue = shuffle(recent.concat(older));
            checkRight = 0;
            checkQueue.total = checkQueue.length;
            checkQueue.final = final;
            askCheck();
        }
        function askCheck() {
            renderProgress();
            fig.clear();
            if (!checkQueue.length) {
                panel.innerHTML = '<p class="ll-kicker">Quick check</p><p class="ll-big">' + checkRight + ' / ' + checkQueue.total + '</p>';
                const nx = el('button', 'll-btn', checkQueue.final ? 'Final round: find them all' : 'Carry on');
                nx.addEventListener('click', () => { if (checkQueue.final) startFinal(); else { phase = 'learn'; show(); } });
                panel.appendChild(nx);
                return;
            }
            const it = checkQueue.shift();
            fig.shape(it, 'll-target');
            panel.innerHTML = '<p class="ll-kicker">Quick check</p><p class="ll-big">Which one is this?</p>';
            const opts = el('div', 'll-options');
            const met = set.items.slice(0, i);
            const choices = shuffle([it].concat(shuffle(met.filter(o => o !== it)).slice(0, 3)));
            choices.forEach(o => {
                const b = el('button', 'll-option');
                b.textContent = o.name;
                b.addEventListener('click', () => {
                    const ok = o === it;
                    if (ok) checkRight++;
                    opts.querySelectorAll('.ll-option').forEach(x => { x.disabled = true; if (x.textContent === it.name) x.classList.add('ll-correct'); else if (x === b) x.classList.add('ll-incorrect'); });
                    fig.label(it, it.name, 'll-label-answer');
                    const nx = el('button', 'll-btn', 'Next');
                    nx.addEventListener('click', askCheck);
                    panel.appendChild(nx);
                });
                opts.appendChild(b);
            });
            panel.appendChild(opts);
        }
        // final: names one by one, tap each on the picture
        let finalQ, finalRight;
        function startFinal() {
            phase = 'final';
            finalQ = shuffle(set.items);
            finalQ.total = finalQ.length;
            finalRight = 0;
            askFinal();
        }
        function askFinal() {
            fig.clear();
            renderProgress();
            if (!finalQ.length) {
                phase = 'done';
                panel.innerHTML = '<p class="ll-kicker">Finished</p><p class="ll-big">' + finalRight + ' / ' + finalQ.total + ' found</p><p>Come back tomorrow and try the final round again, or put this set into Spaced review.</p>';
                const again = el('button', 'll-btn', 'Start again');
                again.addEventListener('click', () => { i = 0; phase = 'learn'; show(); });
                panel.appendChild(again);
                return;
            }
            panel.innerHTML = '<p class="ll-kicker">Final round, ' + (finalQ.total - finalQ.length + 1) + ' of ' + finalQ.total + '</p><p class="ll-big">Tap the ' + esc(finalQ[finalQ.length - 1].name) + '</p>';
        }
        function finalTap(hit) {
            const want = finalQ[finalQ.length - 1];
            if (!want || phase !== 'final' || panel.querySelector('.ll-after')) return;
            const ok = hit === want;
            if (ok) finalRight++;
            fig.shape(want, ok ? 'll-right' : 'll-wrong');
            fig.label(want, want.name, 'll-label-answer');
            const p = el('p', 'll-after ' + (ok ? 'll-good' : 'll-bad'), ok ? 'Yes.' : (hit ? 'That is the ' + esc(hit.name) + '.' : 'Not quite.') + ' Here it is.');
            panel.appendChild(p);
            const nx = el('button', 'll-btn', 'Next');
            nx.addEventListener('click', () => { finalQ.pop(); askFinal(); });
            panel.appendChild(nx);
        }
        load(setId);
    }

    // ------------------------------------------------------------ boot
    const DEMOS = ['spaced', 'draw', 'confidence', 'compare', 'steps'];
    Promise.all(SOURCES.map(s => loadSource(s).catch(() => []))).then(lists => {
        const all = [].concat(...lists);
        const sets = all.filter(s => s.items.length >= MIN_ITEMS);
        const dog = all.find(s => s.id === 'anatomy-quiz:bones');
        const human = all.find(s => s.id === 'human-anatomy-quiz:bones');
        app.innerHTML = '';
        const panes = {};
        DEMOS.forEach(d => { panes[d] = el('section', 'll-demo'); panes[d].id = 'll-' + d; panes[d].hidden = true; app.appendChild(panes[d]); });
        const started = {};
        const tabs = [...document.querySelectorAll('.ll-tabs a')];
        function open(d) {
            if (!DEMOS.includes(d)) d = 'spaced';
            tabs.forEach(t => t.classList.toggle('active', t.dataset.demo === d));
            DEMOS.forEach(x => { panes[x].hidden = x !== d; });
            if (!started[d]) {
                started[d] = true;
                if (d === 'compare') demoCompare(panes[d], dog, human);
                else if (!sets.length) panes[d].innerHTML = '<p class="ll-bad">No outlined sets could be loaded.</p>';
                else ({ spaced: demoSpaced, draw: demoDraw, confidence: demoConfidence, steps: demoSteps })[d](panes[d], sets);
            }
        }
        tabs.forEach(t => t.addEventListener('click', e => {
            e.preventDefault();
            history.replaceState(null, '', '#' + t.dataset.demo);
            open(t.dataset.demo);
        }));
        window.addEventListener('hashchange', () => open(location.hash.slice(1)));
        open(location.hash.slice(1));
    });
})();
