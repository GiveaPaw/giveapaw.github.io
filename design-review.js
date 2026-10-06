import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { createViewerControls } from './viewer-controls.js?v=9';
import { review as builtinReview } from './design-review-content.js?v=1';
import { driveConfig } from './drive-config.js?v=1';
import { createLiveSession } from './live-session.js?v=11';
import { createPaintTool, createLegTool, createGuide } from './review-tools.js?v=12';

// The active review: the built-in manifest, or one loaded from ?review=drive:<id> | draft:<key> | <same-site .json path>.
let review = builtinReview;

// Design review page: three layouts (scroll, studio, guided) built from the same media components
// (video annotator, sweep viewer, assembly viewer) and one shared review store.

// ---- helpers -----------------------------------------------------------------------------------

function el(tag, className, html) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (html !== undefined) node.innerHTML = html;
    return node;
}
const icon = name => `<i data-lucide="${String(name).replace(/[^a-z0-9-]/g, '')}" aria-hidden="true"></i>`;
function refreshIcons() { window.lucide?.createIcons({ attrs: { 'stroke-width': 1.8 } }); }
const uid = () => Math.random().toString(36).slice(2, 9);
function fmtTime(seconds) {
    if (!Number.isFinite(seconds)) return '0:00.0';
    const m = Math.floor(seconds / 60);
    const s = seconds - m * 60;
    return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}
function escapeHTML(text) {
    return String(text ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function download(name, blob) {
    const url = URL.createObjectURL(blob);
    const a = el('a');
    a.href = url;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
}
const toastEl = document.getElementById('rv-toast');
let toastTimer = null;
function toast(message, ms = 2800) {
    toastEl.textContent = message;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, ms);
}
const KIND_ICON = { video: 'video', sweep: 'sliders-horizontal', assembly: 'box', compare: 'columns-2' };
const KIND_LABEL = { video: 'Video', sweep: 'Model sweep', assembly: '3D assembly', compare: 'Current vs proposed' };
// What participants may use. The host (?host=1, or whoever presents a live session) always sees
// everything and decides, from the Live panel, which of these everyone else gets.
export const TOOL_KEYS = [
    ['pin', 'Pin comments'], ['measure', 'Measure'], ['section', 'Section cut'],
    ['grid', 'Grid toggle'], ['cube', 'View cube toggle'], ['snapshot', 'Snapshot'], ['fit', 'Fit view'], ['help', 'Controls help'],
    ['layers', 'Show / hide parts'], ['alpha', 'See-through (T)'], ['tabs', 'View tabs'], ['draw', 'Draw on video'],
    ['paint', 'Paint the surface'], ['pipe', 'Change pipe length'], ['iface', 'Move the interface'], ['demo', 'Slider demo'],
];
const pageParams = new URLSearchParams(location.search);
const policy = {
    host: pageParams.has('host') || pageParams.has('dev'),
    liveHost: false,
    defaults: ['pin', 'measure', 'section', 'layers', 'alpha', 'tabs', 'draw', 'demo', 'help'],
    allowed: null,
    isHost() { return this.host || this.liveHost; },
    allows(key) { return this.isHost() || this.allowed.has(key); },
    apply() {
        if (!this.allowed) this.allowed = new Set(this.defaults);
        const hide = this.isHost() ? [] : TOOL_KEYS.map(([key]) => key).filter(key => !this.allowed.has(key));
        document.body.dataset.hide = hide.join(' ');
        document.body.classList.toggle('rv-host', this.isHost());
    },
};
// Host-only edits that are not reviewer answers (stop points), kept per review in this browser.
const hostStore = {
    key: () => 'gap-review-host:' + review.id,
    data: null,
    load() { try { this.data = JSON.parse(localStorage.getItem(this.key()) || 'null'); } catch { this.data = null; } this.data ||= { stops: {} }; return this.data; },
    save() { try { localStorage.setItem(this.key(), JSON.stringify(this.data)); } catch { /* storage unavailable */ } },
    stops(key) { return (this.data || this.load()).stops[key]; },
    setStops(key, list) { (this.data || this.load()).stops[key] = list; this.save(); },
    // Video turned by the presenter (degrees), per clip; written into the file by "Download review file".
    rotation(key) { return ((this.data || this.load()).rotations || {})[key]; },
    setRotation(key, deg) { const data = this.data || this.load(); (data.rotations ||= {})[key] = deg; this.save(); },
};
const VERDICTS = [['yes', 'Worth trying', 'thumbs-up'], ['maybe', 'Not sure', 'circle-help'], ['no', 'Would not do this', 'thumbs-down']];
const VERDICT_LABEL = Object.fromEntries(VERDICTS.map(([key, label]) => [key, label]));
const TAG_LABEL = { low: 'Too open', good: 'About right', high: 'Too dense' };
const TAG_LABEL_BY_ITEM = {
    'wall-thickness': { low: 'Too thin', good: 'About right', high: 'Too thick' },
    'paw-cellsize': { low: 'Too fine', good: 'About right', high: 'Too coarse' },
};

// ---- share-link encoding -------------------------------------------------------------------------

function toBase64Url(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromBase64Url(text) {
    const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(binary, c => c.charCodeAt(0));
}
async function encodeShare(object) {
    const json = JSON.stringify(object);
    if (!('CompressionStream' in window)) return 'j' + toBase64Url(new TextEncoder().encode(json));
    const stream = new Blob([json]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    return 'z' + toBase64Url(new Uint8Array(await new Response(stream).arrayBuffer()));
}
async function decodeShare(text) {
    const bytes = fromBase64Url(text.slice(1));
    if (text[0] === 'j') return JSON.parse(new TextDecoder().decode(bytes));
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return JSON.parse(await new Response(stream).text());
}

// ---- review store ------------------------------------------------------------------------------

let STORAGE_KEY = 'gap-design-review:' + review.id;
function blankItem() { return { pick: null, tags: {}, note: '', annotations: [] }; }
const store = {
    data: null,
    listeners: new Set(),
    saveTimer: null,
    load() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (raw) this.data = JSON.parse(raw);
        } catch { /* storage unavailable or corrupt */ }
        if (!this.data || this.data.reviewId !== review.id) this.data = { version: 1, reviewId: review.id, reviewer: '', updatedAt: null, items: {} };
    },
    save() {
        clearTimeout(this.saveTimer);
        this.saveTimer = setTimeout(() => {
            try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.data)); } catch { /* storage unavailable */ }
        }, 250);
    },
    item(id) {
        if (!this.data.items[id]) this.data.items[id] = blankItem();
        const item = this.data.items[id];
        item.tags ||= {};
        item.annotations ||= [];
        return item;
    },
    update(id, mutate) { mutate(this.item(id)); this.commit(); },
    set(mutate) { mutate(this.data); this.commit(); },
    commit() {
        this.data.updatedAt = new Date().toISOString();
        this.save();
        this.listeners.forEach(listener => listener());
    },
    replace(data) {
        this.data = { version: 1, reviewId: review.id, reviewer: '', updatedAt: null, items: {}, ...data, reviewId: review.id };
        this.commit();
    },
    reset() { this.replace({}); },
    subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); },
    answered(id) {
        const item = this.data.items[id];
        if (!item) return false;
        return item.pick !== null || !!item.verdict || !!item.choice || !!item.surface || Number.isFinite(item.pipe) || item.note.trim() !== '' || item.annotations.length > 0 || Object.keys(item.tags).length > 0;
    },
    exportJSON() { return JSON.stringify({ ...this.data, title: review.title, exportedAt: new Date().toISOString() }, null, 2); },
};
function initStore() {
    STORAGE_KEY = 'gap-design-review:' + review.id;
    store.load();
}

function clipOf(item, annotation) {
    if (!annotation.clip || !item.sources) return null;
    // Pictures (an "image" material) are shown as picture clips "img-1", "img-2"...
    const own = annotation.source && item.sources[annotation.source];
    const picture = /^img-(\d+)$/.exec(annotation.clip);
    if (own?.kind === 'image' && picture) {
        const img = (own.images || []).filter(i => i.src)[+picture[1] - 1];
        if (img) return { id: annotation.clip, label: img.caption || decodeURIComponent(String(img.src).split('/').pop()), src: img.src };
    }
    for (const source of Object.values(item.sources)) {
        const clip = source.clips?.find(c => c.id === annotation.clip);
        if (clip) return clip;
    }
    return null;
}
function clipLabel(item, annotation) {
    const clip = clipOf(item, annotation);
    return clip ? `${clip.label} ` : '';
}
// "IMG_12 0:04.2" for a video mark; just the name for a mark on a picture clip.
function markWhen(item, a) {
    const clip = clipOf(item, a);
    if (clip && isPicture(clip)) return `${clip.label} (picture)`;
    const off = Math.max(0, +clip?.start || 0);
    return clipLabel(item, a) + fmtTime(Math.max(0, a.t - off)) + (a.t2 !== undefined ? `–${fmtTime(Math.max(0, a.t2 - off))}` : '');
}
function sweepUnitLabel(item, value) {
    // "original": the part that was actually made (e.g. the socket or paw used at the fitting).
    if (value === 'original') return item.original?.label || 'Original';
    const extra = (item.extras || []).find(x => String(x.value) === String(value));
    if (extra) return extra.label || String(value);
    // Two-input sweeps key each part as "a|b" (one value per axis).
    const marked = item.original && !item.original.file && item.original.at !== undefined && String(item.original.at) === String(value) ? ` · ${item.original.label || 'Original'}` : '';
    if (item.axes) return String(value).split('|').map((v, i) => `${item.axes[i].short || item.axes[i].param} ${v}${item.axes[i].unit ? ' ' + item.axes[i].unit : ''}`).join(' · ') + marked;
    const text = item.unit ? `${value} ${item.unit}` : String(value);
    // An existing stop marked as the original ("original": { "at": 50, "label": ... }, no file of its own).
    return item.original && !item.original.file && item.original.at !== undefined && Number(item.original.at) === Number(value) ? `${text} · ${item.original.label || 'Original'}` : text;
}
function buildSummary(items) {
    const data = store.data;
    const lines = [`# ${review.title}`, `Reviewer: ${data.reviewer || review.reviewerDefault || '(not given)'}`, `Updated: ${data.updatedAt ? new Date(data.updatedAt).toLocaleString() : 'never'}`, ''];
    items.forEach(item => {
        const entry = data.items[item.id];
        lines.push(`## ${item.title}`);
        if (!entry || !store.answered(item.id)) { lines.push('(no input yet)', ''); return; }
        if (item.kind === 'sweep') {
            lines.push(`- Pick: ${entry.pick !== null ? sweepUnitLabel(item, entry.pick) : 'none'}`);
            const labels = TAG_LABEL_BY_ITEM[item.id] || TAG_LABEL;
            ['low', 'good', 'high'].forEach(tag => {
                const values = item.values.filter(v => entry.tags[v] === tag);
                if (values.length) lines.push(`- ${labels[tag]}: ${values.map(v => sweepUnitLabel(item, v)).join(', ')}`);
            });
        }
        if (item.kind === 'stage') {
            if (entry.verdict) lines.push(`- Verdict: ${VERDICT_LABEL[entry.verdict] || entry.verdict}`);
            if (item.unit !== undefined && entry.pick !== null) lines.push(`- Preferred: ${sweepUnitLabel(item, entry.pick)}`);
            if (entry.choice && item.choices) lines.push(`- ${item.choices.ask}: ${item.choices.options.find(o => o.key === entry.choice)?.label || entry.choice}`);
            if (entry.surface && entry.surfaceArea) {
                const change = entry.surfaceOriginalArea ? ` (${entry.surfaceArea >= entry.surfaceOriginalArea ? '+' : ''}${Math.round((entry.surfaceArea / entry.surfaceOriginalArea - 1) * 100)}% vs original)` : '';
                lines.push(`- Proposed attachment surface: ${(entry.surfaceArea / 100).toFixed(0)} cm²${change}`);
            }
            if (Number.isFinite(entry.pawYaw) && entry.pawYaw !== 0) lines.push(`- Paw rotation: ${entry.pawYaw}°`);
            if (Number.isFinite(entry.pipe)) lines.push(`- Pipe length: ${entry.pipe} mm${Number.isFinite(entry.pipeFloorGap) ? `, paw ${entry.pipeFloorGap === 0 ? 'on the floor' : entry.pipeFloorGap > 0 ? `${entry.pipeFloorGap} mm above the floor` : `${-entry.pipeFloorGap} mm below the floor`}` : ''}`);
        }
        if (entry.note.trim()) lines.push(`- Notes: ${entry.note.trim().replace(/\s*\n\s*/g, ' / ')}`);
        entry.annotations.forEach((a, index) => {
            const where = a.kind === 'mark' ? `at ${markWhen(item, a)}` : a.kind === 'sketch' ? `drawing on the 3D view${a.value !== undefined ? `, ${sweepUnitLabel(item, a.value)}` : ''}` : `on model at (${(a.pos || []).map(v => v.toFixed(1)).join(', ')}) mm${a.value !== undefined ? `, ${sweepUnitLabel(item, a.value)}` : ''}`;
            lines.push(`- #${index + 1} ${a.label || '(no label)'} ${where}${a.note ? `: ${a.note.replace(/\s*\n\s*/g, ' / ')}` : ''}`);
        });
        lines.push('');
    });
    return lines.join('\n');
}

// ---- shared loaders ----------------------------------------------------------------------------

const draco = new DRACOLoader();
draco.setDecoderPath('https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/libs/draco/');
const gltfLoader = new GLTFLoader();
gltfLoader.setDRACOLoader(draco);
const stlLoader = new STLLoader();
const objLoader = new OBJLoader();
function fileType(name) {
    // Session files are blob: URLs with the real file name after '#', so the parser can be chosen.
    const clean = name.includes('#') ? name.split('#').pop() : name.split('?')[0];
    const ext = (clean.split('.').pop() || '').toLowerCase();
    return ext === 'stl' ? 'stl' : ext === 'obj' ? 'obj' : 'glb';
}
function loadMesh(file) {
    const type = fileType(file);
    return new Promise((resolve, reject) => {
        if (type === 'stl') stlLoader.load(file, geometry => resolve(new THREE.Mesh(geometry)), undefined, reject);
        else if (type === 'obj') objLoader.load(file, resolve, undefined, reject);
        else gltfLoader.load(file, gltf => resolve(gltf.scene), undefined, reject);
    });
}
// Wraps a mesh so it scales about its own centre instead of the world origin.
function scaledAboutCentre(object, factor) {
    const centre = new THREE.Box3().setFromObject(object).getCenter(new THREE.Vector3());
    const group = new THREE.Group();
    group.add(object);
    group.position.copy(centre).multiplyScalar(1 - factor);
    group.scale.setScalar(factor);
    return group;
}
function makeMaterial(color, opacity, clipPlanes) {
    return new THREE.MeshStandardMaterial({
        color, roughness: 0.72, metalness: 0, side: THREE.DoubleSide,
        transparent: opacity < 1, opacity, depthWrite: opacity >= 1, clippingPlanes: clipPlanes,
    });
}
// ---- review sources ------------------------------------------------------------------------------
// Media may be a site-relative path, an absolute URL, or "drive:<fileId>" for a Google Drive file that
// is shared as "anyone with the link". Drive files are read through the Drive API with the site's key.

export function driveMediaUrl(fileId) {
    if (!driveConfig.apiKey) throw new Error('Google Drive is not configured on this site (drive-config.js has no apiKey).');
    return `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&key=${encodeURIComponent(driveConfig.apiKey)}`;
}
function resolveSource(src) {
    if (typeof src !== 'string') return src;
    if (src.startsWith('drive:')) return driveMediaUrl(src.slice(6));
    const match = src.match(/^https?:\/\/drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?(?:export=\w+&)?id=)([\w-]+)/);
    return match ? driveMediaUrl(match[1]) : src;
}
function slugify(text) { return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'item'; }
function normalizeItem(item, index) {
    const it = { ...item };
    it.id = it.id || `${slugify(it.title)}-${index + 1}`;
    if (it.kind === 'video') it.src = resolveSource(it.src);
    else if (it.kind === 'assembly') it.layers = (it.layers || []).map((layer, i) => ({ key: layer.key || `layer-${i + 1}`, label: layer.label || `Layer ${i + 1}`, color: layer.color || '#b9c2cc', opacity: layer.opacity ?? 1, visible: layer.visible !== false, decal: !!layer.decal, file: resolveSource(layer.file) }));
    else if (it.kind === 'sweep') {
        if (it.source) {
            // One mesh shown at several sizes: a quick preview of "shrink the scan by N percent".
            const source = resolveSource(it.source);
            it.values = (it.values || []).map(Number);
            it.file = () => source;
            it.scaleFor = value => 1 - value / 100;
            // The unscaled mesh is the original: mark that stop ("original": { "at": 0, "label": ... }).
            if (it.original && it.original.at === undefined) it.original = { ...it.original, at: 0 };
        } else if (Array.isArray(it.axes) && it.axes.length === 2) {
            // Two inputs swept together: files is { "<a>|<b>": source }. Combinations that were not
            // exported yet are simply absent; the bars show them as not generated.
            const map = new Map(Object.entries(it.files || {}).map(([key, src]) => [key, resolveSource(src)]));
            it.axes = it.axes.map(axis => ({ ...axis, values: (axis.values || []).map(Number) }));
            it.values = [];
            it.axes[0].values.forEach(a => it.axes[1].values.forEach(b => { if (map.has(`${a}|${b}`)) it.values.push(`${a}|${b}`); }));
            // "original": { "file", "at": "<a>|<b>", "label" } adds the part that was really made as an extra stop.
            if (it.original?.file) { map.set('original', resolveSource(it.original.file)); it.values.push('original'); }
            it.file = value => map.get(value);
            it.param = it.axes.map(axis => axis.param).join(' × ');
            it.unit = '';
            if (it.defaultValue !== undefined) it.defaultValue = String(it.defaultValue);
        } else if (typeof it.file !== 'function') {
            // Serialized form: files is { "<value>": source } or [{ value, src }].
            const map = new Map();
            if (Array.isArray(it.files)) it.files.forEach(f => map.set(+f.value, resolveSource(f.src)));
            else Object.entries(it.files || {}).forEach(([v, src]) => map.set(+v, resolveSource(src)));
            it.values = [...map.keys()].sort((x, y) => x - y);
            // "original": { "file", "label", "short" } puts the part that was really made first on the bar.
            if (it.original?.file) { map.set('original', resolveSource(it.original.file)); it.values.unshift('original'); }
            // "extras": [{ "value", "file", "label", "short" }] adds named stops at the end (e.g. the solid socket).
            (it.extras || []).filter(x => x?.value && x.file).forEach(x => { map.set(String(x.value), resolveSource(x.file)); it.values.push(String(x.value)); });
            it.file = value => map.get(value);
        } else {
            const original = it.file;
            it.file = value => resolveSource(original(value));
        }
        it.values ||= [];
        if (!it.values.includes(it.defaultValue)) it.defaultValue = it.values[Math.floor(it.values.length / 2)];
        it.param ||= 'Variant';
        it.unit ||= '';
        if (it.animal?.file) it.animal = { ...it.animal, file: resolveSource(it.animal.file) };
    } else if (it.kind === 'compare') {
        // Older two-sided screens become a stage with Side by side / Current / Proposed (/ video) tabs.
        const sources = { current: { ...it.current, label: 'Current' }, proposed: { ...it.proposed, label: 'Proposed', tone: 'proposed' } };
        const views = [{ key: 'split', label: 'Side by side', icon: 'columns-2', panes: ['current', 'proposed'] }, { key: 'current', label: 'Current', panes: ['current'] }, { key: 'proposed', label: 'Proposed', panes: ['proposed'] }];
        if (it.video) { sources.video = { ...it.video }; views.push({ key: 'video', label: `${it.video.label || 'Video'} + model`, icon: 'video', panes: ['video', 'current'] }); }
        return normalizeItem({ ...it, kind: 'stage', sources, views, current: undefined, proposed: undefined, video: undefined }, index);
    } else if (it.kind === 'stage') {
        const sources = {};
        Object.entries(it.sources || {}).forEach(([key, src]) => { sources[key] = normalizeSource(src, key, it, index); });
        const firstModel = Object.values(sources).find(src => src.kind === 'assembly' || src.kind === 'sweep');
        if (firstModel) firstModel.isFirstModel = true;
        it.sources = sources;
        it.views = (it.views || []).filter(v => (v.panes || []).length);
        if (!it.views.length) it.views = Object.keys(sources).map(key => ({ key, label: sources[key].label || key, panes: [key] }));
        const sweepSource = Object.values(sources).find(src => src.kind === 'sweep');
        if (sweepSource) { it.unit = sweepSource.unit; it.param = sweepSource.param; it.values = sweepSource.values; it.axes = sweepSource.axes; }
    }
    return it;
}
function normalizeSource(src, key, parent, index) {
    const base = { ...src, sourceKey: key, label: src.label || key };
    const model = kind => normalizeItem({ ...base, kind, id: parent.id, title: `${parent.title} (${base.label})` }, index);
    if (src.kind === 'assembly') {
        const it = model('assembly');
        if (it.paint) it.paint = { ...it.paint, surface: it.paint.surface && resolveSource(it.paint.surface) };
        if (it.leg) it.leg = { ...it.leg, interface: it.leg.interface && { ...it.leg.interface, file: resolveSource(it.leg.interface.file) }, paw: it.leg.paw && { ...it.leg.paw, file: resolveSource(it.leg.paw.file) } };
        return it;
    }
    if (src.kind === 'sweep') return model('sweep');
    if (src.kind === 'video') return { ...base, id: parent.id, title: parent.title, src: resolveSource(src.src), poster: src.poster && resolveSource(src.poster), stops: src.stops || [] };
    if (src.kind === 'playlist') return { ...base, id: parent.id, title: parent.title, clips: (src.clips || []).map((clip, i) => ({ ...clip, id: clip.id || `clip-${i + 1}`, label: clip.label || `Clip ${i + 1}`, src: resolveSource(clip.src), poster: clip.poster && resolveSource(clip.poster), stops: clip.stops || [] })) };
    if (src.kind === 'image') return { ...base, images: (src.images || [{ src: src.src, caption: src.caption }]).map(img => ({ ...img, src: resolveSource(img.src) })) };
    return { ...base, kind: 'pending' };
}
export function normalizeReview(raw) {
    const out = { ...raw };
    out.id = out.id || slugify(out.title || 'review');
    out.title = out.title || 'Design review';
    out.library = (out.library || []).map((entry, i) => ({ ...entry, id: entry.id || `media-${i + 1}`, label: entry.label || entry.id || `Media ${i + 1}`, src: entry.src && resolveSource(entry.src), poster: entry.poster && resolveSource(entry.poster) }));
    // Screens switched off in the editor stay in the file but are not shown.
    out.items = (out.items || []).filter(item => !item.hidden).map(normalizeItem);
    return out;
}
export async function loadExternalReview(ref) {
    if (ref.startsWith('draft:')) {
        const raw = localStorage.getItem('gap-review-draft:' + ref.slice(6));
        if (!raw) throw new Error('That draft is not in this browser. Open the preview from the builder again.');
        return JSON.parse(raw);
    }
    // Only this site's own review files (or a Drive file id). A link must not be able to point the page
    // at a review file hosted somewhere else.
    let url;
    if (ref.startsWith('drive:')) {
        if (!/^[\w-]{10,}$/.test(ref.slice(6))) throw new Error('That Drive review id is not valid.');
        url = driveMediaUrl(ref.slice(6));
    } else {
        const target = new URL(ref, location.href);
        if (target.origin !== location.origin || !/\.json$/i.test(target.pathname)) throw new Error('Reviews can only be loaded from this site (for example ?review=reviews/ollie-fit-review.json).');
        url = target.href;
    }
    // Review files are edited between sessions; never show a stale copy.
    const response = await fetch(url, { cache: 'no-cache' });
    if (!response.ok) throw new Error(`Could not fetch the review (${response.status} ${response.statusText}).`);
    return response.json();
}

const NTOP_AXIS_COLORS = { x: 0xff5364, y: 0x35c95d, z: 0x2d9bf0 };
const AXIS_VECTORS = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) };
const UNIT_TO_MM = { mm: 1, cm: 10, m: 1000, in: 25.4 };

let firstViewer = true;
// A clip demo that runs first (on a playlist with "clipDemo": true) holds the 3D movement guide until it ends.
let introHold = null;
let clipDemoAutoStarted = false;

// ---- 3D viewer (sweep or assembly) -----------------------------------------------------------

// Slider labels: every n-th one plus the last, skipping any that would sit right next to the last.
function showLabel(i, count, every) {
    if (i === count - 1) return true;
    return i % every === 0 && (every === 1 || count - 1 - i >= every);
}

function createModelViewer(item) {
    const root = el('div', 'rv-viewer');
    const isSweep = item.kind === 'sweep';
    root.innerHTML = `
        <div class="rv-stage">
            <canvas class="rv-canvas" aria-label="3D view of ${escapeHTML(item.title)}"></canvas>
            <div class="view-cube-wrap">
                <button type="button" class="view-cube-spin" data-spin-view="90" aria-label="Rotate view left" title="Rotate view left">${icon('rotate-ccw')}</button>
                <button type="button" class="view-cube-spin" data-spin-view="-90" aria-label="Rotate view right" title="Rotate view right">${icon('rotate-cw')}</button>
                <canvas class="view-cube" aria-label="View cube. Click a face, edge, or corner for a standard view."></canvas>
            </div>
            <div class="rv-layers"></div>
            <div class="rv-toolbar" role="toolbar" aria-label="Viewer tools" aria-orientation="vertical">
                <button type="button" data-tool="pin" title="Pin a comment on the model">${icon('map-pin')}</button>
                <button type="button" data-tool="measure" title="Measure between two points">${icon('ruler')}</button>
                <button type="button" data-tool="draw" title="Draw on this view (a 2D sketch that stays with this camera angle)">${icon('pencil')}</button>
                <button type="button" data-tool="section" title="Section cut">${icon('scissors')}</button>
                <hr>
                <button type="button" data-tool="grid" class="active" title="Show or hide the grid">${icon('grid-3x3')}</button>
                <button type="button" data-tool="cube" class="active" title="Show or hide the view cube">${icon('axis-3d')}</button>
                <button type="button" data-tool="snapshot" title="Save a picture of this view">${icon('camera')}</button>
                <button type="button" data-tool="fit" title="Fit model in view (F)">${icon('focus')}</button>
                <button type="button" data-tool="help" title="How to move the 3D view">${icon('circle-help')}</button>
            </div>
            <div class="rv-panel rv-measure" hidden>
                <span class="rv-measure-status">Select point 1</span>
                <strong class="rv-measure-value">—</strong>
                <select class="rv-measure-unit" aria-label="Measurement units"><option value="mm" selected>mm</option><option value="cm">cm</option><option value="in">in</option></select>
                <button type="button" class="rv-measure-clear" title="Clear measurement">${icon('x')}</button>
            </div>
            <div class="rv-panel rv-section" hidden>
                <span>Cut along</span>
                <button type="button" class="rv-axis" data-axis="x">X</button>
                <button type="button" class="rv-axis" data-axis="y">Y</button>
                <button type="button" class="rv-axis active" data-axis="z">Z</button>
                <button type="button" class="rv-flip" title="Flip which side is removed">${icon('arrow-left-right')}</button>
                <input type="range" class="rv-section-offset" min="0" max="1000" value="500" aria-label="Section position">
                <label><input type="checkbox" class="rv-section-plane" checked> plane</label>
            </div>
            <div class="rv-pins"></div>
            <canvas class="rv-sketch"></canvas>
            <div class="rv-draw-panel" hidden>
                <span class="rv-swatches" role="group" aria-label="Pen colour">${PEN_COLORS.map((c, i) => `<button type="button" class="rv-swatch${i === 0 ? ' active' : ''}" data-color="${c}" style="--swatch:${c}" title="Pen colour"></button>`).join('')}</span>
                <button type="button" class="rv-draw-undo" title="Undo your last line on this view">${icon('undo-2')}</button>
                <button type="button" class="rv-draw-done" title="Stop drawing (Esc)">Done</button>
            </div>
            <button type="button" class="rv-sketch-chip" hidden></button>
            <div class="rv-loader"><span></span><p>Loading model…</p></div>
            <p class="rv-hint">Drag to orbit · Middle-drag or <kbd>Shift</kbd>+drag to pan · Scroll to zoom</p>
            <p class="rv-mode-hint" hidden></p>
        </div>
        ${isSweep && item.axes ? `
        <div class="rv-sweep rv-sweep-grid">
            ${item.axes.map((axis, i) => `<div class="rv-sweep-axis" data-axis="${i}"><span class="rv-sweep-axis-name">${escapeHTML(axis.param)}${axis.unit ? ` <small>(${escapeHTML(axis.unit)})</small>` : ''}<em class="rv-sweep-axis-idle" hidden></em></span><div class="rv-segs" role="group" aria-label="${escapeHTML(axis.param)}"></div></div>`).join('')}
            <div class="rv-sweep-actions">
                ${item.original?.file ? `<button type="button" class="rv-orig" title="Show the part that was actually made">${icon('history')} <span>${escapeHTML(item.original.label || 'Original')}</span></button>`
                    : item.original?.at !== undefined ? `<button type="button" class="rv-orig" title="Go to the marked combination">${icon('flag')} <span>${escapeHTML(item.original.label || 'Original')} · ${escapeHTML(String(item.original.at).split('|').map((v, i) => `${item.axes[i]?.short || item.axes[i]?.param} ${v}${item.axes[i]?.unit ? ' ' + item.axes[i].unit : ''}`).join(' · '))}</span></button>` : ''}
                <button type="button" class="rv-pick" title="Star this as the one you would choose"></button>
            </div>
        </div>` : isSweep ? `
        <div class="rv-sweep">
            <div class="rv-strip">
                <div class="rv-segs" role="group" aria-label="${escapeHTML(item.param)}"></div>
                <button type="button" class="rv-pick" title="Star this as the one you would choose"></button>
            </div>
        </div>` : ''}`;
    const stage = root.querySelector('.rv-stage');
    const canvas = root.querySelector('.rv-canvas');
    const loaderEl = root.querySelector('.rv-loader');
    const pinsEl = root.querySelector('.rv-pins');
    const modeHintEl = root.querySelector('.rv-mode-hint');
    const toolButtons = Object.fromEntries([...root.querySelectorAll('[data-tool]')].map(b => [b.dataset.tool, b]));

    // Scene ------------------------------------------------------------------------------------
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf2f5f7);
    const camera = new THREE.PerspectiveCamera(34, 1, 1, 100000);
    camera.up.set(0, 0, 1);
    camera.position.set(-300, -400, 200);
    let renderer;
    try {
        renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    } catch (error) {
        throw new Error('WebGL is not available in this browser (hardware acceleration may be off). ' + (error?.message || ''));
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.localClippingEnabled = true;
    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.screenSpacePanning = true;
    scene.add(new THREE.HemisphereLight(0xffffff, 0x6f7884, 1.55));
    const keyLight = new THREE.DirectionalLight(0xffffff, 2.2);
    keyLight.position.set(-2, -3, 4);
    scene.add(keyLight);
    const rimLight = new THREE.DirectionalLight(0xffe7bd, 0.85);
    rimLight.position.set(3, 1, 2);
    scene.add(rimLight);
    const grid = new THREE.GridHelper(1, 24, 0xaeb8c4, 0xd8dee5);
    grid.rotation.x = Math.PI / 2;
    grid.material.transparent = true;
    grid.material.opacity = 0.58;
    grid.material.depthWrite = false;
    // "grid": false on a model or slider starts with the XY grid (the floor) hidden; the toolbar still toggles it.
    grid.visible = item.grid !== false;
    scene.add(grid);

    const modelRoot = new THREE.Group();
    const pinRoot = new THREE.Group();
    const measureRoot = new THREE.Group();
    scene.add(modelRoot, pinRoot, measureRoot);
    const materials = new Set();
    const sectionPlane = new THREE.Plane(new THREE.Vector3(0, 0, -1), 0);
    const section = { enabled: false, axis: 'z', flip: false, t: 0.5, showPlane: true };
    const planeHelper = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: 0xfdb515, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false }));
    planeHelper.visible = false;
    planeHelper.renderOrder = 5;
    scene.add(planeHelper);
    let bounds = new THREE.Box3();
    let sceneRadius = 100;
    let framed = false;

    // Live-session hooks: what a presenter broadcasts and what a follower applies.
    let applying = false;
    const changeListeners = new Set();
    const navListeners = new Set();
    const emitChange = kind => { if (!applying) changeListeners.forEach(fn => fn(kind)); };
    const emitNav = () => { if (!applying) navListeners.forEach(fn => fn()); };
    const lastPublished = { p: new THREE.Vector3(), t: new THREE.Vector3() };
    const layerButtons = {};
    const layerAlpha = {};
    let selectedLayer = null;

    function prepare(object, color, opacity) {
        const box = new THREE.Box3().setFromObject(object);
        const size = box.getSize(new THREE.Vector3());
        // Exports arrive in millimetres; a metre-scale file is a few units across and gets scaled up.
        if (size.length() > 0 && size.length() < 5) object.scale.multiplyScalar(1000);
        object.traverse(child => {
            if (!child.isMesh) return;
            if (!child.geometry.attributes.normal) child.geometry.computeVertexNormals();
            child.material = makeMaterial(color, opacity, section.enabled ? [sectionPlane] : null);
            child.userData.pickable = true;
            materials.add(child.material);
        });
        return object;
    }
    function pickMeshes() {
        const meshes = [];
        modelRoot.traverse(o => { if (o.isMesh && o.visible && o.userData.pickable && o.parent.visible !== false) meshes.push(o); });
        return meshes.filter(m => { let p = m; while (p) { if (!p.visible) return false; p = p.parent; } return true; });
    }
    function frame(direction = new THREE.Vector3(-1.4, -1.8, 0.9)) {
        bounds = new THREE.Box3().setFromObject(modelRoot);
        if (bounds.isEmpty()) return;
        const center = bounds.getCenter(new THREE.Vector3());
        const size = bounds.getSize(new THREE.Vector3());
        sceneRadius = Math.max(size.length() / 2, 1);
        const vFov = THREE.MathUtils.degToRad(camera.fov);
        const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
        const distance = sceneRadius / Math.sin(Math.min(vFov, hFov) / 2) * 1.08;
        controls.target.copy(center);
        camera.position.copy(center).add(direction.clone().normalize().multiplyScalar(distance));
        camera.near = Math.max(sceneRadius / 100, 0.01);
        camera.far = Math.max(sceneRadius * 80, 1000);
        camera.updateProjectionMatrix();
        controls.update();
        grid.position.set(center.x, center.y, bounds.min.z - size.z * 0.03);
        grid.scale.setScalar(Math.max(size.x, size.y, size.z) * 1.6);
        planeHelper.scale.setScalar(size.length() * 1.05);
        updateSection();
        rebuildPinMarkers();
    }

    // Section cut --------------------------------------------------------------------------------
    function updateSection() {
        if (bounds.isEmpty()) return;
        const axis = AXIS_VECTORS[section.axis];
        const center = bounds.getCenter(new THREE.Vector3());
        const min = bounds.min[section.axis];
        const max = bounds.max[section.axis];
        const at = min + (max - min) * section.t;
        const point = center.clone().setComponent('xyz'.indexOf(section.axis), at);
        const normal = axis.clone().multiplyScalar(section.flip ? 1 : -1);
        sectionPlane.setFromNormalAndCoplanarPoint(normal, point);
        planeHelper.position.copy(point);
        planeHelper.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), axis);
        planeHelper.visible = section.enabled && section.showPlane;
        emitChange('section');
        materials.forEach(material => {
            if (!!material.clippingPlanes === section.enabled) return;
            material.clippingPlanes = section.enabled ? [sectionPlane] : null;
            material.needsUpdate = true;
        });
    }
    const sectionPanel = root.querySelector('.rv-section');
    sectionPanel.querySelectorAll('.rv-axis').forEach(button => button.addEventListener('click', () => {
        section.axis = button.dataset.axis;
        sectionPanel.querySelectorAll('.rv-axis').forEach(b => b.classList.toggle('active', b === button));
        updateSection();
    }));
    sectionPanel.querySelector('.rv-flip').addEventListener('click', () => { section.flip = !section.flip; updateSection(); });
    sectionPanel.querySelector('.rv-section-offset').addEventListener('input', event => { section.t = event.target.value / 1000; updateSection(); });
    sectionPanel.querySelector('.rv-section-plane').addEventListener('change', event => { section.showPlane = event.target.checked; updateSection(); });
    function setSection(enabled) {
        section.enabled = enabled;
        sectionPanel.hidden = !enabled;
        toolButtons.section.classList.toggle('active', enabled);
        if (enabled && mode === 'measure') setMode(null);
        updateSection();
    }

    // Measure ------------------------------------------------------------------------------------
    const measurePanel = root.querySelector('.rv-measure');
    const measureStatus = measurePanel.querySelector('.rv-measure-status');
    const measureValue = measurePanel.querySelector('.rv-measure-value');
    const measureUnit = measurePanel.querySelector('.rv-measure-unit');
    const measurePoints = [];
    function updateMeasure() {
        if (measurePoints.length < 2) {
            measureStatus.textContent = measurePoints.length ? 'Select point 2' : 'Select point 1';
            measureValue.textContent = '—';
            return;
        }
        const unit = measureUnit.value;
        const value = measurePoints[0].distanceTo(measurePoints[1]) / UNIT_TO_MM[unit];
        measureStatus.textContent = 'Distance';
        measureValue.textContent = value.toFixed(unit === 'mm' ? 1 : 2) + ' ' + unit;
    }
    function clearMeasure() { measurePoints.length = 0; measureRoot.clear(); updateMeasure(); }
    function addMeasurePoint(point) {
        if (measurePoints.length === 2) clearMeasure();
        measurePoints.push(point.clone());
        const marker = new THREE.Mesh(new THREE.SphereGeometry(sceneRadius * 0.01, 20, 16), new THREE.MeshBasicMaterial({ color: measurePoints.length === 1 ? 0x1f78b4 : 0xf2aa2a, depthTest: false }));
        marker.position.copy(point);
        marker.renderOrder = 210;
        measureRoot.add(marker);
        if (measurePoints.length === 2) {
            const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(measurePoints), new THREE.LineBasicMaterial({ color: 0x173958, depthTest: false }));
            line.renderOrder = 209;
            measureRoot.add(line);
        }
        updateMeasure();
    }
    measurePanel.querySelector('.rv-measure-clear').addEventListener('click', clearMeasure);
    measureUnit.addEventListener('change', updateMeasure);

    // Pins ---------------------------------------------------------------------------------------
    const pinMarkers = new Map();
    let selectedPin = null;
    // Pins and drawings belong to the model they were made on ("source": the screen's material key), so a pin
    // on Ollie does not show on the Chihuahua. Older notes without a source stay on the screen's first model.
    const mySource = item.sourceKey || '';
    const belongs = a => (a.source ? a.source === mySource : (!mySource || !!item.isFirstModel));
    function pinAnnotations() { return store.item(item.id).annotations.filter(a => a.kind === 'pin' && belongs(a)); }
    function rebuildPinMarkers() {
        const pins = pinAnnotations();
        const wanted = new Set(pins.map(p => p.id));
        [...pinMarkers.keys()].forEach(id => {
            if (wanted.has(id)) return;
            const marker = pinMarkers.get(id);
            pinRoot.remove(marker.mesh);
            marker.label.remove();
            pinMarkers.delete(id);
        });
        const radius = sceneRadius * 0.012;
        pins.forEach((pin, index) => {
            let marker = pinMarkers.get(pin.id);
            if (!marker) {
                const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 16), new THREE.MeshBasicMaterial({ color: 0xff3fa4 }));
                const label = el('button', 'rv-pin-label');
                label.type = 'button';
                label.addEventListener('click', () => { selectPin(pin.id); root.dispatchEvent(new CustomEvent('rv-focus-annotation', { detail: pin.id, bubbles: true })); });
                pinRoot.add(mesh);
                pinsEl.append(label);
                marker = { mesh, label };
                pinMarkers.set(pin.id, marker);
            }
            marker.mesh.position.fromArray(pin.pos);
            marker.mesh.scale.setScalar(radius);
            marker.mesh.material.color.setHex(pin.id === selectedPin ? 0xb1006b : 0xff3fa4);
            marker.label.innerHTML = `<span class="rv-anno-num">${index + 1}</span><span>${escapeHTML(pin.label || 'Pin ' + (index + 1))}</span>`;
            marker.label.classList.toggle('active', pin.id === selectedPin);
        });
    }
    // Pins broadcast by a live-session presenter, shown in gold and never editable here.
    const remoteMarkers = new Map();
    function setRemote(list, name) {
        remoteSketches = (list || []).filter(a => a.kind === 'sketch' && belongs(a)).map(a => ({ ...a, who: { name: a.by || name || 'Presenter', color: '#e0a020' } }));
        sketchDirty = true;
        const pins = (list || []).filter(a => a.kind === 'pin' && a.pos && belongs(a));
        const wanted = new Set(pins.map(p => p.id));
        [...remoteMarkers.keys()].forEach(id => {
            if (wanted.has(id)) return;
            const marker = remoteMarkers.get(id);
            pinRoot.remove(marker.mesh);
            marker.label.remove();
            remoteMarkers.delete(id);
        });
        pins.forEach((pin, index) => {
            let marker = remoteMarkers.get(pin.id);
            if (!marker) {
                const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 16), new THREE.MeshBasicMaterial({ color: 0xa86e00 }));
                const label = el('span', 'rv-pin-label remote');
                pinRoot.add(mesh);
                pinsEl.append(label);
                marker = { mesh, label };
                remoteMarkers.set(pin.id, marker);
            }
            marker.mesh.position.fromArray(pin.pos);
            marker.mesh.scale.setScalar(sceneRadius * 0.012);
            marker.label.innerHTML = `<span class="rv-anno-num">${index + 1}</span><span>${escapeHTML(pin.by || name || 'Presenter')}: ${escapeHTML(pin.label || 'Pin ' + (index + 1))}</span>`;
        });
    }
    // Pins and drawings by the other people in a live session, in each person's colour with their name.
    const othersMarkers = new Map();
    let othersSketches = [];
    function setOthers(list) {
        othersSketches = (list || []).filter(a => a.kind === 'sketch' && belongs(a));
        sketchDirty = true;
        const pins = (list || []).filter(a => a.kind === 'pin' && a.pos && belongs(a));
        const wanted = new Set(pins.map(p => `${p.who?.name}|${p.id}`));
        [...othersMarkers.keys()].forEach(id => {
            if (wanted.has(id)) return;
            const marker = othersMarkers.get(id);
            pinRoot.remove(marker.mesh);
            marker.label.remove();
            othersMarkers.delete(id);
        });
        pins.forEach(pin => {
            const id = `${pin.who?.name}|${pin.id}`;
            const color = pin.who?.color || '#7fd0ff';
            let marker = othersMarkers.get(id);
            if (!marker) {
                const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 16), new THREE.MeshBasicMaterial({ color }));
                const label = el('span', 'rv-pin-label remote other');
                pinRoot.add(mesh);
                pinsEl.append(label);
                marker = { mesh, label };
                othersMarkers.set(id, marker);
            }
            marker.mesh.material.color.set(color);
            marker.mesh.position.fromArray(pin.pos);
            marker.mesh.scale.setScalar(sceneRadius * 0.012);
            marker.label.style.borderColor = color;
            marker.label.innerHTML = `<span class="rv-anno-dot" style="background:${escapeHTML(color)}"></span><span>${escapeHTML(pin.who?.name || 'Guest')}: ${escapeHTML(pin.label || 'Pin')}</span>`;
        });
    }

    // Drawing on the 3D view: a flat sketch tied to the camera angle it was drawn from. It shows while the
    // view is (nearly) the same, and the notes list or the chip flies back to it. Stored as a "sketch" note.
    const sketchCanvas = root.querySelector('.rv-sketch');
    const sketchCtx = sketchCanvas.getContext('2d');
    const drawPanel = root.querySelector('.rv-draw-panel');
    const sketchChip = root.querySelector('.rv-sketch-chip');
    let sketching = false, stroke = null, sketchColor = PEN_COLORS[0], sketchDirty = true, sketchSig = '';
    let remoteSketches = [];
    const SKETCH_WIDTH = 2.5;
    function mySketches() { return store.item(item.id).annotations.filter(a => a.kind === 'sketch' && belongs(a)); }
    function viewMatches(sketch) {
        if (!sketch?.camera?.p || !sketch.camera.t) return false;
        if (isSweep && sketch.value !== undefined && sketch.value !== item.values[sweep.index]) return false;
        const p = new THREE.Vector3().fromArray(sketch.camera.p), t = new THREE.Vector3().fromArray(sketch.camera.t);
        const reach = Math.max(1e-6, p.distanceTo(t)) * 0.03;
        return camera.position.distanceTo(p) < reach && controls.target.distanceTo(t) < reach;
    }
    function setSketching(on) {
        sketching = !!on && !locked;
        if (sketching && mode) setMode(mode);
        stage.classList.toggle('mode-sketch', sketching);
        toolButtons.draw.classList.toggle('active', sketching);
        drawPanel.hidden = !sketching;
        controls.enabled = !sketching && !locked;
        modeHintEl.hidden = !sketching && mode === null;
        if (sketching) modeHintEl.textContent = 'Draw on this view (it stays with this camera angle)';
        sketchDirty = true;
    }
    function sketchPoint(event) {
        const rect = sketchCanvas.getBoundingClientRect();
        return [Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)), Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height))].map(v => +v.toFixed(4));
    }
    sketchCanvas.addEventListener('pointerdown', event => {
        if (!sketching || event.button !== 0) return;
        event.preventDefault();
        try { sketchCanvas.setPointerCapture(event.pointerId); } catch { /* synthetic */ }
        emitNav();
        stroke = { type: 'pen', pts: [sketchPoint(event)], color: sketchColor, width: SKETCH_WIDTH };
        sketchDirty = true;
    });
    sketchCanvas.addEventListener('pointermove', event => {
        if (!stroke) return;
        const p = sketchPoint(event), last = stroke.pts[stroke.pts.length - 1];
        if (Math.hypot(p[0] - last[0], p[1] - last[1]) > 0.003) { stroke.pts.push(p); sketchDirty = true; }
    });
    const endStroke = () => {
        if (!stroke) return;
        const shape = stroke;
        stroke = null;
        sketchDirty = true;
        if (shape.pts.length < 2) shape.pts.push([shape.pts[0][0] + 0.002, shape.pts[0][1]]);
        const here = mySketches().find(viewMatches);
        let id = here?.id;
        store.update(item.id, entry => {
            const target = id && entry.annotations.find(a => a.id === id);
            if (target) { target.shapes.push(shape); return; }
            id = uid();
            entry.annotations.push({
                id, kind: 'sketch', label: '', note: '',
                camera: { p: camera.position.toArray().map(v => +v.toFixed(3)), t: controls.target.toArray().map(v => +v.toFixed(3)) },
                shapes: [shape],
                ...(isSweep ? { value: item.values[sweep.index] } : {}),
                ...(mySource ? { source: mySource } : {}),
            });
        });
        emitChange('annotations');
        root.dispatchEvent(new CustomEvent('rv-focus-annotation', { detail: id, bubbles: true }));
    };
    sketchCanvas.addEventListener('pointerup', endStroke);
    sketchCanvas.addEventListener('pointercancel', endStroke);
    drawPanel.querySelectorAll('[data-color]').forEach(swatch => swatch.addEventListener('click', () => {
        sketchColor = swatch.dataset.color;
        drawPanel.querySelectorAll('[data-color]').forEach(b => b.classList.toggle('active', b === swatch));
    }));
    drawPanel.querySelector('.rv-draw-undo').addEventListener('click', () => {
        const here = mySketches().find(viewMatches);
        if (!here) return;
        store.update(item.id, entry => {
            const target = entry.annotations.find(a => a.id === here.id);
            target.shapes.pop();
            if (!target.shapes.length && !target.label && !target.note) entry.annotations.splice(entry.annotations.indexOf(target), 1);
        });
        sketchDirty = true;
    });
    drawPanel.querySelector('.rv-draw-done').addEventListener('click', () => setSketching(false));
    addEventListener('keydown', event => { if (event.key === 'Escape' && sketching && !event.target.closest?.('input, textarea')) setSketching(false); });
    let chipCycle = 0;
    sketchChip.addEventListener('click', () => {
        const away = [...mySketches(), ...remoteSketches, ...othersSketches].filter(k => !viewMatches(k));
        if (!away.length) return;
        const k = away[chipCycle++ % away.length];
        emitNav();
        if (isSweep && k.value !== undefined) showValue(item.values.indexOf(k.value));
        flyTo(k.camera.p, k.camera.t);
    });
    function drawSketches() {
        const w = sketchCanvas.clientWidth, h = sketchCanvas.clientHeight;
        if (!w || !h) return;
        const sig = `${w}x${h}|${camera.position.toArray().map(v => v.toFixed(2))}|${controls.target.toArray().map(v => v.toFixed(2))}|${isSweep ? sweep.index : ''}`;
        if (!sketchDirty && sig === sketchSig) return;
        sketchSig = sig;
        sketchDirty = false;
        const dpr = Math.min(window.devicePixelRatio, 2);
        if (sketchCanvas.width !== Math.round(w * dpr) || sketchCanvas.height !== Math.round(h * dpr)) {
            sketchCanvas.width = Math.round(w * dpr);
            sketchCanvas.height = Math.round(h * dpr);
        }
        sketchCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
        sketchCtx.clearRect(0, 0, w, h);
        const line = (shape, fallback) => {
            const pts = shape.pts || [];
            if (pts.length < 2) return;
            sketchCtx.strokeStyle = shape.color || fallback;
            sketchCtx.lineWidth = shape.width || SKETCH_WIDTH;
            sketchCtx.lineJoin = 'round';
            sketchCtx.lineCap = 'round';
            sketchCtx.shadowColor = 'rgba(0, 0, 0, 0.45)';
            sketchCtx.shadowBlur = 2;
            sketchCtx.beginPath();
            pts.forEach(([x, y], i) => (i ? sketchCtx.lineTo(x * w, y * h) : sketchCtx.moveTo(x * w, y * h)));
            sketchCtx.stroke();
            sketchCtx.shadowBlur = 0;
        };
        const tag = (k, text, color) => {
            const first = k.shapes?.[0]?.pts?.[0];
            if (!first) return;
            sketchCtx.font = '700 11px Inter, system-ui, sans-serif';
            const tw = sketchCtx.measureText(text).width;
            const x = Math.min(w - tw - 12, first[0] * w + 6), y = Math.max(14, first[1] * h - 10);
            sketchCtx.fillStyle = 'rgba(255, 255, 255, 0.92)';
            sketchCtx.fillRect(x - 4, y - 11, tw + 8, 16);
            sketchCtx.fillStyle = color;
            sketchCtx.fillText(text, x, y + 1);
        };
        let away = 0;
        const all = [
            ...mySketches().map(k => ({ k, who: null })),
            ...remoteSketches.map(k => ({ k, who: k.who })),
            ...othersSketches.map(k => ({ k, who: k.who })),
        ];
        all.forEach(({ k, who }) => {
            if (!viewMatches(k)) { away++; return; }
            (k.shapes || []).forEach(shape => line(shape, who?.color || PEN_COLORS[0]));
            if (who) tag(k, `${who.name}${k.label ? ': ' + k.label : ''}`, who.color || '#7a5000');
            else if (k.label) tag(k, k.label, '#7a0049');
        });
        if (stroke) line(stroke, sketchColor);
        sketchChip.hidden = !away;
        if (away) sketchChip.innerHTML = `${icon('pencil')} ${away} drawing${away === 1 ? '' : 's'} at another angle · show`;
        if (away) refreshIcons();
    }
    toolButtons.draw.addEventListener('click', () => setSketching(!sketching));

    const projected = new THREE.Vector3();
    function placePinLabels() {
        if (!pinMarkers.size && !remoteMarkers.size && !othersMarkers.size) return;
        const width = canvas.clientWidth;
        const height = canvas.clientHeight;
        const place = marker => {
            projected.copy(marker.mesh.position).project(camera);
            const visible = projected.z < 1 && Math.abs(projected.x) < 1.2 && Math.abs(projected.y) < 1.2;
            marker.label.style.display = visible ? '' : 'none';
            if (!visible) return;
            marker.label.style.left = ((projected.x + 1) / 2 * width) + 'px';
            marker.label.style.top = ((1 - projected.y) / 2 * height) + 'px';
        };
        pinMarkers.forEach(place);
        remoteMarkers.forEach(place);
        othersMarkers.forEach(place);
    }
    function selectPin(id) { selectedPin = id; rebuildPinMarkers(); }
    function addPin(point) {
        const annotation = {
            id: uid(), kind: 'pin', label: '', note: '', pos: point.toArray().map(v => +v.toFixed(2)),
            camera: { position: camera.position.toArray(), target: controls.target.toArray() },
        };
        if (isSweep) annotation.value = item.values[sweep.index];
        if (mySource) annotation.source = mySource;
        store.update(item.id, entry => entry.annotations.push(annotation));
        selectPin(annotation.id);
        setMode(null);
        root.dispatchEvent(new CustomEvent('rv-focus-annotation', { detail: annotation.id, bubbles: true }));
    }
    let flight = null;
    function flyTo(position, target) {
        flight = { start: performance.now(), fromP: camera.position.clone(), fromT: controls.target.clone(), toP: new THREE.Vector3().fromArray(position), toT: new THREE.Vector3().fromArray(target) };
    }
    // A pin that is not this browser's own (the presenter's, from the file): show its value, fly to its view.
    function flyToPin(pin) {
        if (isSweep && pin.value !== undefined && item.values.includes(pin.value)) showValue(item.values.indexOf(pin.value));
        if (pin.camera) flyTo(pin.camera.position, pin.camera.target);
    }
    function jumpTo(id) {
        const sketch = mySketches().find(a => a.id === id);
        if (sketch) {
            if (isSweep && sketch.value !== undefined) showValue(item.values.indexOf(sketch.value));
            flyTo(sketch.camera.p, sketch.camera.t);
            return;
        }
        const pin = pinAnnotations().find(a => a.id === id);
        if (!pin) return;
        selectPin(id);
        if (isSweep && pin.value !== undefined) showValue(item.values.indexOf(pin.value));
        if (pin.camera) flyTo(pin.camera.position, pin.camera.target);
    }

    // Modes and picking --------------------------------------------------------------------------
    let mode = null;
    function setMode(next) {
        mode = mode === next ? null : next;
        if (mode !== null && sketching) setSketching(false);
        stage.classList.toggle('mode-pin', mode === 'pin');
        stage.classList.toggle('mode-measure', mode === 'measure');
        toolButtons.pin.classList.toggle('active', mode === 'pin');
        toolButtons.measure.classList.toggle('active', mode === 'measure');
        measurePanel.hidden = mode !== 'measure';
        if (mode !== 'measure') clearMeasure();
        modeHintEl.hidden = mode === null;
        modeHintEl.textContent = mode === 'pin' ? `Click the model to place pin ${pinAnnotations().length + 1}` : 'Click two points on the model';
    }
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    function pickPoint(event) {
        const rect = canvas.getBoundingClientRect();
        pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
        raycaster.setFromCamera(pointer, camera);
        const hits = raycaster.intersectObjects(pickMeshes(), false);
        // With a section cut active, ignore hits on the removed side of the plane.
        const hit = hits.find(h => !section.enabled || sectionPlane.distanceToPoint(h.point) >= -1e-6);
        return hit ? hit.point.clone() : null;
    }
    let pressAt = null;
    canvas.addEventListener('pointerdown', event => { if (event.button === 0) pressAt = { x: event.clientX, y: event.clientY }; });
    canvas.addEventListener('pointerup', event => {
        if (event.button !== 0 || !pressAt) return;
        const moved = Math.hypot(event.clientX - pressAt.x, event.clientY - pressAt.y);
        pressAt = null;
        if (moved > 5) return;
        if (!mode) { selectLayerAt(event); return; }
        const point = pickPoint(event);
        if (!point) return;
        if (mode === 'pin') addPin(point);
        else addMeasurePoint(point);
    });

    // Toolbar ------------------------------------------------------------------------------------
    toolButtons.pin.addEventListener('click', () => setMode('pin'));
    toolButtons.measure.addEventListener('click', () => setMode('measure'));
    toolButtons.section.addEventListener('click', () => setSection(!section.enabled));
    toolButtons.grid.classList.toggle('active', grid.visible);
    toolButtons.grid.addEventListener('click', () => { grid.visible = !grid.visible; toolButtons.grid.classList.toggle('active', grid.visible); });
    toolButtons.cube.addEventListener('click', () => {
        const visible = !toolButtons.cube.classList.contains('active');
        toolButtons.cube.classList.toggle('active', visible);
        viewerControls.setCubeVisible(visible);
    });
    toolButtons.fit.addEventListener('click', () => frame());
    toolButtons.snapshot.addEventListener('click', () => {
        renderer.render(scene, camera);
        canvas.toBlob(blob => {
            if (!blob) return;
            const suffix = isSweep ? `-${String(item.values[sweep.index]).replace(/\|/g, '-')}` : '';
            download(`${item.id}${suffix}-view.png`, blob);
            toast('Snapshot saved to your downloads');
        }, 'image/png');
    });

    // "How to move": the movement guide shrinks into this button when it is put away; the button brings it back.
    const moveHelp = el('button', 'rv-move-help', `${icon('move')} <span>How to move</span>`);
    moveHelp.type = 'button';
    moveHelp.title = 'Show how to turn, move and zoom the 3D view';
    stage.append(moveHelp);
    const viewerControls = createViewerControls({
        camera, controls, canvas, stage,
        cubeWrap: root.querySelector('.view-cube-wrap'),
        cubeCanvas: root.querySelector('.view-cube'),
        helpButton: moveHelp,
        dismissible: true,
        closeOnLastGesture: true,
        // In the guided layout the button sits in the screen's header, next to Hide notes.
        collapseTarget: () => { const b = document.querySelector('.rv-guided .rv-move-toggle'); return b && !b.hidden && b.offsetParent ? b : null; },
        axisColors: NTOP_AXIS_COLORS,
        pickMeshes,
        isGizmoHovered: () => false,
        frameView: () => frame(),
    });
    // The walkthrough reserves left-drag; a reviewer on a laptop expects it to orbit. Shift/Alt + left
    // drag stay with the shared controls (pan/orbit-about-point), so OrbitControls must ignore those.
    controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
    canvas.addEventListener('pointerdown', event => {
        if (event.button !== 0) return;
        controls.mouseButtons.LEFT = (event.shiftKey || event.altKey) ? null : THREE.MOUSE.ROTATE;
    }, { capture: true });
    // OrbitControls owns the plain left-drag, so report it to the intro coach ourselves.
    let plainDrag = null;
    canvas.addEventListener('pointerdown', event => {
        if (event.button !== 0 || event.shiftKey || event.altKey || event.pointerType === 'touch' || !controls.enabled) return;
        plainDrag = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
    });
    canvas.addEventListener('pointermove', event => {
        if (!plainDrag || event.pointerId !== plainDrag.id) return;
        if (!plainDrag.moved && Math.hypot(event.clientX - plainDrag.x, event.clientY - plainDrag.y) < 3) return;
        plainDrag.moved = true;
        viewerControls.noteNavigation('orbit');
    });
    const endPlainDrag = event => {
        if (!plainDrag || event.pointerId !== plainDrag.id) return;
        const moved = plainDrag.moved;
        plainDrag = null;
        if (moved) viewerControls.noteGestureEnd('orbit');
    };
    canvas.addEventListener('pointerup', endPlainDrag);
    canvas.addEventListener('pointercancel', endPlainDrag);

    // Layers (assembly) --------------------------------------------------------------------------
    const layersEl = root.querySelector('.rv-layers');
    const layerGroups = {};
    if (isSweep) {
        layerGroups.sweep = modelRoot;
        layerChip({ key: 'sweep', label: item.label || 'Model', color: item.color || '#e0a100', opacity: item.opacity ?? 1 }, 'sweep', modelRoot);
    }
    if (item.kind === 'assembly') {
        item.layers.forEach(layer => {
            const group = new THREE.Group();
            group.visible = layer.visible !== false;
            modelRoot.add(group);
            layerGroups[layer.key] = group;
            layerChip(layer, layer.key, group);
        });
    }
    // A chip per part: click to show or hide; the half-circle (or T) makes it see-through or solid.
    function layerChip(layer, key, group) {
        const wrap = el('span', 'rv-layer');
        wrap.style.setProperty('--layer', layer.color || '#b9c2cc');
        wrap.innerHTML = `<button type="button" class="rv-layer-toggle" title="Show or hide: ${escapeHTML(layer.label)}"><span class="rv-dot"></span><span class="rv-layer-name">${escapeHTML(layer.label)}</span><span class="rv-layer-eye"></span></button><button type="button" class="rv-layer-alpha" title="See-through or solid (click the part, then press T)">${icon('contrast')}</button>`;
        const button = wrap.querySelector('.rv-layer-toggle');
        button.addEventListener('click', () => {
            group.visible = !group.visible;
            syncLayer(key);
            emitNav();
            emitChange('layers');
        });
        wrap.querySelector('.rv-layer-alpha').addEventListener('click', () => { emitNav(); toggleAlpha(key); });
        layersEl.append(wrap);
        layerButtons[key] = { button, wrap, layer };
        layerAlpha[key] = layer.opacity ?? 1;
        syncLayer(key);
        return button;
    }
    function syncLayer(key) {
        const entry = layerButtons[key];
        const group = layerGroups[key];
        if (!entry || !group) return;
        entry.wrap.classList.toggle('is-off', !group.visible);
        entry.wrap.classList.toggle('is-solid', (layerAlpha[key] ?? 1) >= 0.99);
        entry.wrap.classList.toggle('is-selected', selectedLayer === key);
        entry.button.setAttribute('aria-pressed', group.visible ? 'true' : 'false');
        entry.button.querySelector('.rv-layer-eye').innerHTML = icon(group.visible ? 'eye' : 'eye-off');
        refreshIcons();
    }
    function setAlpha(key, value) {
        layerAlpha[key] = value;
        layerGroups[key]?.traverse(o => {
            if (!o.isMesh || !o.material) return;
            o.material.opacity = value;
            o.material.transparent = value < 0.99;
            o.material.depthWrite = value >= 0.99;
            o.material.needsUpdate = true;
        });
        syncLayer(key);
    }
    function toggleAlpha(key) {
        if (!layerGroups[key] || !policy.allows('alpha')) return;
        const base = layerButtons[key]?.layer.opacity ?? 1;
        const now = layerAlpha[key] ?? base;
        const next = now >= 0.99 ? (base < 0.99 ? base : 0.35) : 1;
        setAlpha(key, next);
        toast(`${layerButtons[key]?.layer.label || key}: ${next >= 0.99 ? 'solid' : 'see-through'}`, 1600);
        emitChange('layers');
    }
    function selectLayerAt(event) {
        const rect = canvas.getBoundingClientRect();
        pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
        raycaster.setFromCamera(pointer, camera);
        const meshes = [];
        [modelRoot, extraRoot].forEach(rootNode => rootNode.traverse(o => { if (o.isMesh) { let p = o, shown = true; while (p) { if (!p.visible) shown = false; p = p.parent; } if (shown) meshes.push(o); } }));
        const hit = raycaster.intersectObjects(meshes, false)[0];
        let key = null;
        if (hit) for (const [k, group] of Object.entries(layerGroups)) { let p = hit.object; while (p) { if (p === group) key = k; p = p.parent; } }
        const before = selectedLayer;
        selectedLayer = key;
        Object.keys(layerButtons).forEach(syncLayer);
        if (key && key !== before && policy.allows('alpha')) toast(`${layerButtons[key]?.layer.label || key} selected. Press T to make it see-through or solid.`, 2200);
    }
    let hovered = false;
    stage.addEventListener('pointerenter', () => { hovered = true; });
    stage.addEventListener('pointerleave', () => { hovered = false; });
    function onKey(event) {
        if (!hovered || locked || event.ctrlKey || event.metaKey || event.altKey || event.target.closest?.('input, textarea, select')) return;
        if (event.key !== 't' && event.key !== 'T') return;
        const key = selectedLayer || (layerGroups.animal ? 'animal' : Object.keys(layerGroups)[0]);
        if (key) { event.preventDefault(); emitNav(); toggleAlpha(key); }
    }
    window.addEventListener('keydown', onKey);

    // Context mesh for a sweep (the animal the socket sits on): shares the section cut, toggles top-left,
    // but is not part of the framed or pickable geometry.
    const extraRoot = new THREE.Group();
    scene.add(extraRoot);
    async function loadExtraLayer(layer, key = 'animal') {
        const group = new THREE.Group();
        group.visible = layer.visible !== false;
        extraRoot.add(group);
        layerGroups[key] = group;
        const button = layerChip({ ...layer, label: layer.label || 'Solid animal' }, key, group);
        try {
            group.add(prepare(await loadMesh(layer.file), layer.color || '#496b94', layer.opacity ?? 0.35));
        } catch (error) {
            console.error(error);
            button.disabled = true;
            button.title = 'Could not load ' + layer.file;
            layerButtons[key].wrap.classList.add('is-broken');
        }
    }

    // Paint (attachment surface) and leg (pipe + paw) tools ------------------------------------------
    const toolCtx = {
        stage, scene, modelRoot, camera, canvas, controls, root, materials, store, itemId: item.id,
        sectionPlanes: () => (section.enabled ? [sectionPlane] : null),
        toast, emitChange, emitNav, refreshIcons, download, loadMesh, frame: () => frame(),
        pickMeshes, sectionCut: () => (section.enabled ? sectionPlane : null),
        makeMaterial: (color, opacity) => makeMaterial(color, opacity, section.enabled ? [sectionPlane] : null),
        findLayerMesh: key => { let found = null; layerGroups[key]?.traverse(o => { if (!found && o.isMesh) found = o; }); return found; },
        animalBounds: () => { const group = layerGroups.animal; if (!group) return null; const box = new THREE.Box3().setFromObject(group); return box.isEmpty() ? null : box; },
    };
    const paintTool = item.paint ? createPaintTool(toolCtx, item.paint) : null;
    const legTool = item.leg ? createLegTool(toolCtx, item.leg) : null;

    // Sweep --------------------------------------------------------------------------------------
    const sweep = { index: 0, cache: new Map(), loading: new Set(), pending: null, loaded: 0 };
    const partListeners = new Set();
    const sweepEls = isSweep ? {
        pick: root.querySelector('.rv-pick'), strip: root.querySelector('.rv-strip'), segs: root.querySelector('.rv-segs'),
    } : null;
    if (isSweep && item.axes) {
        sweep.index = Math.max(0, item.values.indexOf(item.defaultValue ?? item.values[0]));
        initGrid();
    } else if (isSweep) {
        sweep.index = Math.max(0, item.values.indexOf(item.defaultValue ?? item.values[0]));
        item.values.forEach((value, index) => {
            const seg = el('button', 'rv-seg');
            seg.type = 'button';
            seg.dataset.index = index;
            seg.title = sweepUnitLabel(item, value);
            seg.setAttribute('aria-label', sweepUnitLabel(item, value));
            const isOriginal = value === 'original' || (item.original && !item.original.file && Number(item.original.at) === value);
            if (isOriginal) seg.classList.add('is-original');
            const extraStop = (item.extras || []).find(x => String(x.value) === String(value));
            if (extraStop) seg.classList.add('is-extra');
            seg.innerHTML = `<span class="rv-seg-bar"></span><span class="rv-seg-label">${escapeHTML(value === 'original' ? (item.original.short || 'Orig.') : extraStop ? (extraStop.short || extraStop.label || String(value)) : String(value))}</span>`;
            sweepEls.segs.append(seg);
        });
        // One control: click a block or drag across the row to scrub.
        const indexAt = clientX => {
            const rect = sweepEls.segs.getBoundingClientRect();
            return Math.max(0, Math.min(item.values.length - 1, Math.floor((clientX - rect.left) / rect.width * item.values.length)));
        };
        let scrubbing = false;
        sweepEls.segs.addEventListener('pointerdown', event => {
            if (event.button !== 0) return;
            scrubbing = true;
            try { sweepEls.segs.setPointerCapture(event.pointerId); } catch { /* synthetic */ }
            sweepEls.segs.classList.add('scrubbing');
            showValue(indexAt(event.clientX));
        });
        sweepEls.segs.addEventListener('pointermove', event => { if (scrubbing) showValue(indexAt(event.clientX)); });
        const endScrub = () => { scrubbing = false; sweepEls.segs.classList.remove('scrubbing'); };
        sweepEls.segs.addEventListener('pointerup', endScrub);
        sweepEls.segs.addEventListener('pointercancel', endScrub);
        sweepEls.pick.addEventListener('click', () => {
            const value = item.values[sweep.index];
            store.update(item.id, entry => { entry.pick = entry.pick === value ? null : value; });
        });
        root.querySelector('.rv-sweep').addEventListener('keydown', event => {
            if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') { showValue(sweep.index - 1); event.preventDefault(); }
            if (event.key === 'ArrowRight' || event.key === 'ArrowUp') { showValue(sweep.index + 1); event.preventDefault(); }
            if (event.key === 'Home') { showValue(0); event.preventDefault(); }
            if (event.key === 'End') { showValue(item.values.length - 1); event.preventDefault(); }
        });
        // (A real part with its own file is already the first block, labelled with its short name.)
        const origIndex = item.original && !item.original.file ? item.values.findIndex(v => Number(item.original.at) === v) : -1;
        if (origIndex >= 0) {
            sweepEls.flag = el('button', 'rv-orig-flag');
            sweepEls.flag.type = 'button';
            sweepEls.flag.title = `Show ${item.original.label || 'the original'}`;
            sweepEls.flag.innerHTML = `${icon('history')}<span>${escapeHTML(item.original.label || 'Original')} · ${escapeHTML(sweepUnitLabel({ ...item, original: null }, item.values[origIndex]))}</span>`;
            sweepEls.flag.dataset.index = origIndex;
            sweepEls.flag.addEventListener('click', () => showValue(origIndex));
            sweepEls.strip.classList.add('has-orig');
            sweepEls.strip.append(sweepEls.flag);
        }
        new ResizeObserver(() => placePick()).observe(sweepEls.strip);
    }
    // Two-input sweep: one bar per input. Moving along one bar keeps the other input where it is.
    function gridCoords(value = item.values[sweep.index]) {
        if (value === 'original') return String(item.original?.at ?? item.values[0]).split('|');
        return String(value).split('|');
    }
    function gridGo(axis, axisValue) {
        const coords = gridCoords();
        coords[axis] = String(axisValue);
        const key = coords.join('|');
        if (item.values.includes(key)) showValue(item.values.indexOf(key));
    }
    function initGrid() {
        sweepEls.rows = [...root.querySelectorAll('.rv-sweep-axis')];
        sweepEls.rows.forEach((row, axis) => {
            const segs = row.querySelector('.rv-segs');
            const values = item.axes[axis].values;
            values.forEach(v => {
                const seg = el('button', 'rv-seg');
                seg.type = 'button';
                seg.dataset.value = v;
                seg.innerHTML = `<span class="rv-seg-bar"></span><span class="rv-seg-label">${escapeHTML(String(v))}</span>`;
                segs.append(seg);
            });
            const valueAt = clientX => { const rect = segs.getBoundingClientRect(); return values[Math.max(0, Math.min(values.length - 1, Math.floor((clientX - rect.left) / rect.width * values.length)))]; };
            let scrubbing = false;
            segs.addEventListener('pointerdown', event => {
                if (event.button !== 0) return;
                scrubbing = true;
                try { segs.setPointerCapture(event.pointerId); } catch { /* synthetic */ }
                segs.classList.add('scrubbing');
                gridGo(axis, valueAt(event.clientX));
            });
            segs.addEventListener('pointermove', event => { if (scrubbing) gridGo(axis, valueAt(event.clientX)); });
            const endScrub = () => { scrubbing = false; segs.classList.remove('scrubbing'); };
            segs.addEventListener('pointerup', endScrub);
            segs.addEventListener('pointercancel', endScrub);
            row.addEventListener('keydown', event => {
                const at = values.indexOf(Number(gridCoords()[axis]));
                const step = event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? -1 : event.key === 'ArrowRight' || event.key === 'ArrowUp' ? 1 : 0;
                if (!step) return;
                event.preventDefault();
                const next = values[at + step];
                if (next !== undefined) gridGo(axis, next);
            });
        });
        sweepEls.pick.addEventListener('click', () => {
            const value = item.values[sweep.index];
            store.update(item.id, entry => { entry.pick = entry.pick === value ? null : value; });
        });
        const markedValue = item.original?.file ? 'original' : String(item.original?.at);
        root.querySelector('.rv-orig')?.addEventListener('click', () => { const at = item.values.indexOf(markedValue); if (at >= 0) showValue(at); });
    }
    function syncGrid(entry) {
        const coords = gridCoords();
        const onOriginal = item.values[sweep.index] === 'original';
        const origCoords = item.original?.at !== undefined ? gridCoords('original') : null;
        root.querySelector('.rv-orig')?.classList.toggle('active', onOriginal || (!item.original?.file && item.original?.at !== undefined && String(item.values[sweep.index]) === String(item.original.at)));
        const pickCoords = entry.pick !== null && entry.pick !== undefined ? gridCoords(entry.pick) : null;
        sweepEls.rows.forEach((row, axis) => {
            const other = 1 - axis;
            [...row.querySelectorAll('.rv-seg')].forEach(seg => {
                const c = coords.slice();
                c[axis] = seg.dataset.value;
                const key = c.join('|');
                const exists = item.values.includes(key);
                seg.classList.toggle('missing', !exists);
                seg.title = exists ? sweepUnitLabel(item, key) : `${sweepUnitLabel(item, key)}: not generated yet`;
                seg.classList.toggle('loaded', sweep.cache.has(key));
                seg.classList.toggle('current', !onOriginal && seg.dataset.value === coords[axis]);
                seg.classList.toggle('is-original', !!origCoords && seg.dataset.value === origCoords[axis]);
                seg.classList.toggle('picked', !!pickCoords && entry.pick !== 'original' && pickCoords[axis] === seg.dataset.value && pickCoords[other] === coords[other]);
                seg.setAttribute('aria-pressed', seg.dataset.value === coords[axis] ? 'true' : 'false');
            });
            // An input can have no effect at some value of the other one (e.g. thicken distance while the
            // pelvic thickness is 0); the review file says so with "idleWhen".
            const idle = item.axes[axis].idleWhen;
            const idleEl = row.querySelector('.rv-sweep-axis-idle');
            const isIdle = !!idle && String(coords[idle.axis ?? other]) === String(idle.value);
            row.classList.toggle('idle', isIdle);
            const segs = [...row.querySelectorAll('.rv-seg')];
            const width = row.querySelector('.rv-segs').clientWidth / Math.max(1, segs.length);
            const every = !width || width >= 34 ? 1 : width >= 22 ? 2 : width >= 13 ? 4 : 8;
            segs.forEach((seg, i) => seg.classList.toggle('no-label', !showLabel(i, segs.length, every)));
            idleEl.hidden = !isIdle;
            idleEl.textContent = isIdle ? (idle.note || 'no effect here') : '';
        });
    }
    // The pick pill floats over the current block and follows it; labels thin out when blocks get narrow.
    function placePick() {
        if (!isSweep || item.axes) return;
        const n = item.values.length;
        const segWidth = sweepEls.segs.clientWidth / n;
        if (!segWidth) return;
        const every = segWidth >= 34 ? 1 : segWidth >= 22 ? 2 : segWidth >= 13 ? 4 : 8;
        [...sweepEls.segs.children].forEach((seg, index) => {
            seg.classList.toggle('no-label', !showLabel(index, n, every));
        });
        const stripWidth = sweepEls.strip.clientWidth;
        const pillWidth = sweepEls.pick.offsetWidth || 0;
        const center = (sweep.index + 0.5) * segWidth;
        const left = Math.max(pillWidth / 2, Math.min(stripWidth - pillWidth / 2, center));
        sweepEls.pick.style.left = `${left}px`;
        sweepEls.pick.style.setProperty('--arrow', `${Math.max(10, Math.min(pillWidth - 10, center - (left - pillWidth / 2)))}px`);
        if (sweepEls.flag) {
            const flagWidth = sweepEls.flag.offsetWidth || 0;
            const at = (+sweepEls.flag.dataset.index + 0.5) * segWidth;
            const flagLeft = Math.max(flagWidth / 2, Math.min(stripWidth - flagWidth / 2, at));
            sweepEls.flag.style.left = `${flagLeft}px`;
            sweepEls.flag.style.setProperty('--arrow', `${Math.max(8, Math.min(flagWidth - 8, at - (flagLeft - flagWidth / 2)))}px`);
            sweepEls.flag.classList.toggle('active', sweep.index === +sweepEls.flag.dataset.index);
        }
    }
    function syncSweepUI() {
        if (!isSweep) return;
        const entry = store.item(item.id);
        const value = item.values[sweep.index];
        const picked = entry.pick === value;
        sweepEls.pick.classList.toggle('active', picked);
        sweepEls.pick.innerHTML = picked
            ? `${icon('star')} <span>Your pick · <strong>${escapeHTML(sweepUnitLabel(item, value))}</strong></span>`
            : `${icon('star')} <span>Pick <strong>${escapeHTML(sweepUnitLabel(item, value))}</strong></span>`;
        sweepEls.pick.title = picked ? 'Remove your star' : 'Star this as the one you would choose';
        if (item.axes) { syncGrid(entry); refreshIcons(); return; }
        [...sweepEls.segs.children].forEach((seg, index) => {
            const v = item.values[index];
            seg.classList.toggle('loaded', sweep.cache.has(v));
            seg.classList.toggle('current', index === sweep.index);
            seg.classList.toggle('picked', entry.pick === v);
            seg.setAttribute('aria-pressed', index === sweep.index ? 'true' : 'false');
        });
        placePick();
        refreshIcons();
    }
    function ensureLoaded(value) {
        if (sweep.cache.has(value) || sweep.loading.has(value)) return sweep.cache.get(value);
        sweep.loading.add(value);
        return loadMesh(item.file(value)).then(object => {
            prepare(object, item.color || '#b9c2cc', layerAlpha.sweep ?? item.opacity ?? 1);
            if (item.scaleFor) object = scaledAboutCentre(object, item.scaleFor(value));
            sweep.cache.set(value, object);
            sweep.loading.delete(value);
            sweep.loaded += 1;
            if (item.values[sweep.index] === value) present(object);
            trimSweepCache();
            syncSweepUI();
            return object;
        }).catch(error => {
            sweep.loading.delete(value);
            console.error(error);
            if (item.values[sweep.index] === value) showLoader(`Could not load ${item.file(value)}`, true);
        });
    }
    function present(object) {
        modelRoot.clear();
        modelRoot.add(object);
        // Parts loaded earlier keep the look chosen since (solid or see-through).
        if (isSweep && layerAlpha.sweep !== undefined) setAlpha('sweep', layerAlpha.sweep);
        hideLoader();
        if (!framed) { frame(); framed = true; }
        else updateSection();
    }
    function showValue(index) {
        if (!isSweep) return;
        index = Math.max(0, Math.min(item.values.length - 1, index));
        sweep.index = index;
        const value = item.values[index];
        syncSweepUI();
        emitChange('sweep');
        partListeners.forEach(fn => fn());
        const object = sweep.cache.get(value);
        if (object) present(object);
        else {
            showLoader(`Loading ${sweepUnitLabel(item, value)}…`, false, true);
            ensureLoaded(value);
        }
        if (item.values.length > SWEEP_AHEAD) loadAround();
    }
    // Slider demo: a short guided run of the slider. It moves the bar(s) through the designs, points out the
    // preloading, the original / proposed marker, the part chips and Pick, then goes back to where it was.
    // Any click on the viewer (or Esc) stops it. In a live session the moves are shared like any slider
    // move, and the presenter's current tip ({ step }) goes out with the view, so followers see the same tips.
    let demo = null;
    let demoStep = null;          // the tip on screen now (shared with followers)
    let remoteTip = null;         // a tip shown because the presenter is running the demo
    const demoBtn = isSweep && item.values.length > 1 ? el('button', 'rv-demo-btn') : null;
    if (demoBtn) {
        demoBtn.type = 'button';
        demoBtn.title = 'Show how this slider works';
        demoBtn.innerHTML = `${icon('circle-play')} <span>Slider demo</span>`;
        stage.append(demoBtn);
        demoBtn.addEventListener('click', () => (demo ? stopDemo() : runDemo()));
    }
    const demoWait = ms => new Promise(resolve => setTimeout(resolve, ms));
    function demoTarget(step) {
        const bar = item.axes ? sweepEls?.rows?.[0]?.querySelector('.rv-segs') : sweepEls?.segs;
        if (step === 'axis0' || step === 'axis1') return sweepEls?.rows?.[+step.slice(4)]?.querySelector('.rv-segs');
        if (step === 'marker') return sweepEls?.flag || root.querySelector('.rv-orig');
        if (step === 'parts') return layersEl;
        if (step === 'pick') return sweepEls?.pick;
        return bar;
    }
    function demoText(step) {
        const unit = item.axes ? '' : (item.unit ? ` (${item.unit})` : '');
        if (step === 'intro') {
            const what = item.axes ? `combination of ${item.axes.map(axis => escapeHTML(axis.param.toLowerCase())).join(' and ')}` : `${escapeHTML((item.param || 'value').toLowerCase())}${escapeHTML(unit)}`;
            const made = item.source ? 'the same scan shown at a different size' : `exported from nTop with a different ${what}`;
            return `<b>Each block is one design</b>: ${made}. Click a block, or drag across the bar, to swap the 3D model.`;
        }
        if (step === 'axis0' || step === 'axis1') {
            const axis = item.axes[+step.slice(4)], other = item.axes[1 - +step.slice(4)];
            return `<b>${escapeHTML(axis.param)}</b>: this bar changes only this input. ${escapeHTML(other.short || other.param)} stays where it is.`;
        }
        if (step === 'preview') return '<b>Previews load ahead.</b> Darker blocks are already downloaded and switch instantly; the camera stays put, so you compare designs from the same angle.';
        if (step === 'marker') return `<b>${escapeHTML(item.original?.label || 'Original')}</b> is marked on the bar. Click this to jump straight back to it.`;
        if (step === 'parts') return '<b>Parts:</b> the eye hides a part; the half circle (or click the part and press <kbd>T</kbd>) makes it see-through.';
        if (step === 'pick') return '<b>Pick</b> stars the design you would choose. It goes into your notes and the summary.';
        if (step === 'end') return '<b>Your turn:</b> drag across the bar, or use the arrow keys on it.';
        return '';
    }
    function clearDemoTip() {
        root.querySelectorAll('.rv-demo-tip').forEach(node => node.remove());
        root.querySelectorAll('.rv-demo-focus').forEach(node => node.classList.remove('rv-demo-focus'));
    }
    function showDemoTip(step) {
        clearDemoTip();
        const target = step && demoTarget(step);
        if (!target || !target.offsetParent) return null;
        if (getComputedStyle(root).position === 'static') root.style.position = 'relative';
        target.classList.add('rv-demo-focus');
        const tip = el('div', 'rv-demo-tip', `<p>${demoText(step)}</p>`);
        root.append(tip);
        const box = root.getBoundingClientRect(), t = target.getBoundingClientRect();
        const w = tip.offsetWidth, h = tip.offsetHeight;
        const centre = t.left + t.width / 2 - box.left;
        const left = Math.max(8, Math.min(box.width - w - 8, centre - w / 2));
        tip.style.left = `${left}px`;
        tip.style.setProperty('--arrow', `${Math.max(14, Math.min(w - 14, centre - left))}px`);
        const above = t.top - box.top - h - 12;
        if (above >= 4) { tip.style.top = `${above}px`; tip.classList.add('above'); }
        else { tip.style.top = `${t.bottom - box.top + 12}px`; tip.classList.add('below'); }
        return tip;
    }
    function setDemoStep(step) {
        demoStep = step;
        showDemoTip(step);
        emitChange('demo');
    }
    function stopDemo() {
        if (!demo) return;
        demo.stopped = true;
        removeEventListener('pointerdown', demo.cancel, true);
        removeEventListener('keydown', demo.key, true);
        demo = null;
        setDemoStep(null);
        root.classList.remove('rv-demoing');
        demoBtn.innerHTML = `${icon('circle-play')} <span>Slider demo</span>`;
        refreshIcons();
    }
    async function runDemo() {
        const d = { stopped: false };
        demo = d;
        remoteTip = null;
        const alive = () => demo === d && !d.stopped && root.isConnected && root.offsetParent !== null;
        d.cancel = event => { if (!event.target.closest?.('.rv-demo-btn, .rv-demo-tip')) stopDemo(); };
        d.key = event => { if (event.key === 'Escape') stopDemo(); };
        addEventListener('pointerdown', d.cancel, true);
        addEventListener('keydown', d.key, true);
        root.classList.add('rv-demoing');
        demoBtn.innerHTML = `${icon('circle-stop')} <span>Stop demo</span>`;
        refreshIcons();
        const startIndex = sweep.index;
        const say = async (step, ms) => {
            if (!alive()) return false;
            setDemoStep(step);
            await demoWait(ms);
            return alive();
        };
        const along = (count, steps) => {
            // About `steps` evenly spread positions from 0 to count - 1.
            const n = Math.min(count, steps);
            return Array.from({ length: n }, (_, i) => Math.round(i * (count - 1) / Math.max(1, n - 1)));
        };
        try {
            if (!await say('intro', 4200)) return;
            if (!item.axes) {
                setDemoStep(null);   // the tip would cover the Pick label while the bar moves
                const path = along(item.values.length, 14);
                for (const i of [...path, ...path.slice().reverse()]) {
                    if (!alive()) return;
                    showValue(i);
                    await demoWait(300);
                }
            } else {
                for (let axis = 0; axis < item.axes.length; axis++) {
                    if (!await say(`axis${axis}`, 3200)) return;
                    setDemoStep(null);
                    const keep = gridCoords()[axis];
                    const values = item.axes[axis].values;
                    for (const i of along(values.length, 10)) {
                        if (!alive()) return;
                        gridGo(axis, values[i]);
                        await demoWait(320);
                    }
                    gridGo(axis, keep);
                    await demoWait(250);
                }
            }
            if (!await say('preview', 4200)) return;
            if (item.original) {
                const at = item.original.file ? item.values.indexOf('original') : item.values.findIndex(v => String(v) === String(item.original.at));
                if (at >= 0) showValue(at);
                if (!await say('marker', 3800)) return;
            }
            if (!await say('parts', 3800)) return;
            if (!await say('pick', 3600)) return;
            showValue(startIndex);
            await say('end', 3000);
        } finally {
            if (demo === d) stopDemo();
        }
    }
    // Followers: show (or clear) the tip the presenter is showing.
    function applyDemoTip(step) {
        if (demo) return;
        const next = step || null;
        if (next === remoteTip) return;
        remoteTip = next;
        if (next) showDemoTip(next); else clearDemoTip();
    }
    // Big sweeps (the pelvic grid has 336 parts) cannot all be downloaded and kept on the graphics card,
    // so only the parts nearest the current one are fetched ahead, and the furthest are freed again.
    const LOW_MEMORY = matchMedia('(pointer: coarse)').matches || (navigator.deviceMemory && navigator.deviceMemory <= 4);
    const SWEEP_AHEAD = LOW_MEMORY ? 10 : 30;   // phones and tablets: about 40 MB of parts instead of ~220 MB
    const SWEEP_KEEP = LOW_MEMORY ? 20 : 60;
    function sweepDistance(a, b) {
        if (!item.axes) return Math.abs(a - b);
        const ca = gridCoords(item.values[a]);
        const cb = gridCoords(item.values[b]);
        return item.axes.reduce((sum, axis, i) => sum + Math.abs(axis.values.indexOf(Number(ca[i])) - axis.values.indexOf(Number(cb[i]))), 0);
    }
    function nearestIndices(count) {
        return item.values.map((_, i) => i).sort((a, b) => sweepDistance(a, sweep.index) - sweepDistance(b, sweep.index)).slice(0, count);
    }
    function disposeObject(object) {
        object.traverse(child => {
            if (!child.isMesh) return;
            child.geometry.dispose();
            [].concat(child.material).forEach(material => { materials.delete(material); material.dispose(); });
        });
    }
    function trimSweepCache() {
        if (sweep.cache.size <= SWEEP_KEEP) return;
        const shown = item.values[sweep.index];
        const furthest = [...sweep.cache.keys()]
            .filter(value => value !== shown)
            .sort((a, b) => sweepDistance(item.values.indexOf(b), sweep.index) - sweepDistance(item.values.indexOf(a), sweep.index));
        while (sweep.cache.size > SWEEP_KEEP && furthest.length) {
            const value = furthest.shift();
            const object = sweep.cache.get(value);
            if (object.parent) continue;   // still on screen
            sweep.cache.delete(value);
            disposeObject(object);
        }
    }
    async function preloadSweep() {
        // Load the current value first, then spread outward so scrubbing near it stays smooth.
        const order = nearestIndices(SWEEP_AHEAD);
        await ensureLoaded(item.values[order[0]]);
        for (let i = 1; i < order.length; i += 2) await Promise.all(order.slice(i, i + 2).map(index => ensureLoaded(item.values[index])));
    }
    let aheadTimer = 0;
    function loadAround() {
        // After a jump, fetch the neighbours of the new value (a few at a time, nearest first).
        clearTimeout(aheadTimer);
        aheadTimer = setTimeout(async () => {
            const missing = nearestIndices(12).filter(index => !sweep.cache.has(item.values[index]));
            for (let i = 0; i < missing.length; i += 3) await Promise.all(missing.slice(i, i + 3).map(index => ensureLoaded(item.values[index])));
        }, 250);
    }

    function showLoader(message, error = false, soft = false) {
        loaderEl.hidden = false;
        loaderEl.classList.toggle('error', error);
        loaderEl.classList.toggle('soft', soft && !error);
        loaderEl.querySelector('p').textContent = message;
    }
    function hideLoader() { loaderEl.hidden = true; }

    let started = false;
    async function start() {
        if (started) return;
        started = true;
        try {
            if (isSweep) {
                // The animal comes in right after the first part, not after every preloaded part (30 on
                // some sliders), so it is there from the start on slow connections.
                await ensureLoaded(item.values[sweep.index]);
                if (item.animal) loadExtraLayer(item.animal);
                await preloadSweep();
            } else {
                await Promise.all(item.layers.map(async layer => {
                    const object = prepare(await loadMesh(layer.file), layer.color, layer.opacity ?? 1);
                    // A surface lying on the skin (decal) is drawn just in front of it instead of flickering.
                    if (layer.decal) object.traverse(o => { if (o.isMesh) Object.assign(o.material, { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }); });
                    layerGroups[layer.key].add(object);
                }));
                if (paintTool) await paintTool.init();
                if (legTool) await legTool.init();
                frame();
                framed = true;
                hideLoader();
            }
            if (firstViewer) { firstViewer = false; Promise.resolve(introHold).then(after => requestAnimationFrame(() => viewerControls.startIntro({ force: after === true }))); }
        } catch (error) {
            console.error(error);
            showLoader('A model could not be loaded. Refresh the page to try again.', true);
        }
    }

    // Loop, sizing, visibility -------------------------------------------------------------------
    let visible = false;
    function resize() {
        const width = stage.clientWidth;
        const height = stage.clientHeight;
        if (!width || !height) return;
        renderer.setSize(width, height, false);
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
    }
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(stage);
    const io = new IntersectionObserver(entries => {
        entries.forEach(entry => {
            visible = entry.isIntersecting;
            if (visible) { resize(); start(); }
        });
    }, { threshold: 0.05 });
    io.observe(stage);
    renderer.setAnimationLoop(now => {
        if (!visible || !canvas.isConnected) return;
        if (flight) {
            const t = Math.min((now - flight.start) / 520, 1);
            const eased = t * t * (3 - 2 * t);
            camera.position.lerpVectors(flight.fromP, flight.toP, eased);
            controls.target.lerpVectors(flight.fromT, flight.toT, eased);
            if (t >= 1) flight = null;
        }
        viewerControls.update(now);
        controls.update();
        if (changeListeners.size && !applying) {
            const eps = (sceneRadius * 0.002) ** 2;
            if (camera.position.distanceToSquared(lastPublished.p) > eps || controls.target.distanceToSquared(lastPublished.t) > eps) {
                lastPublished.p.copy(camera.position);
                lastPublished.t.copy(controls.target);
                emitChange('camera');
            }
        }
        renderer.render(scene, camera);
        placePinLabels();
        drawSketches();
    });

    const unsubscribeStore = store.subscribe(() => { rebuildPinMarkers(); syncSweepUI(); sketchDirty = true; });
    syncSweepUI();

    // State shared in a live session.
    function getState() {
        return {
            sweep: isSweep ? item.values[sweep.index] : undefined,
            camera: { p: camera.position.toArray(), t: controls.target.toArray() },
            section: { ...section },
            layers: Object.fromEntries(Object.entries(layerGroups).map(([key, group]) => [key, group.visible])),
            alpha: { ...layerAlpha },
            ...(paintTool?.getState() || {}),
            ...(legTool?.getState() || {}),
            ...(isSweep ? { demoStep: demoStep || '' } : {}),   // '' not null: the live database drops nulls
            annotations: [
                ...pinAnnotations().map(p => ({ id: p.id, kind: 'pin', label: p.label, pos: p.pos, ...(p.source ? { source: p.source } : {}) })),
                ...mySketches().map(k => ({ id: k.id, kind: 'sketch', label: k.label, camera: k.camera, shapes: k.shapes, ...(k.value !== undefined ? { value: k.value } : {}), ...(k.source ? { source: k.source } : {}) })),
            ],
        };
    }
    let locked = false;
    function setLocked(value) {
        locked = !!value;
        if (locked && sketching) setSketching(false);
        controls.enabled = !locked;
        root.classList.toggle('rv-locked', locked);
        if (locked && mode) setMode(null);
        paintTool?.setLocked(locked);
        legTool?.setLocked(locked);
    }
    function applyState(state) {
        if (!state) return;
        applying = true;
        try {
            if (isSweep && state.sweep !== undefined) {
                const index = item.values.indexOf(state.sweep);
                if (index >= 0 && index !== sweep.index) showValue(index);
            }
            if (isSweep && 'demoStep' in state) applyDemoTip(state.demoStep);
            if (state.camera) {
                flight = null;
                camera.position.fromArray(state.camera.p);
                controls.target.fromArray(state.camera.t);
                controls.update();
                lastPublished.p.copy(camera.position);
                lastPublished.t.copy(controls.target);
            }
            if (state.section) {
                Object.assign(section, state.section);
                sectionPanel.querySelectorAll('.rv-axis').forEach(b => b.classList.toggle('active', b.dataset.axis === section.axis));
                sectionPanel.querySelector('.rv-section-offset').value = Math.round(section.t * 1000);
                sectionPanel.querySelector('.rv-section-plane').checked = section.showPlane;
                sectionPanel.hidden = !section.enabled;
                toolButtons.section.classList.toggle('active', section.enabled);
                updateSection();
            }
            if (state.layers) Object.entries(state.layers).forEach(([key, visible]) => {
                const group = layerGroups[key];
                if (!group) return;
                group.visible = visible;
                syncLayer(key);
            });
            if (state.alpha) Object.entries(state.alpha).forEach(([key, value]) => { if (layerGroups[key] && Math.abs((layerAlpha[key] ?? 1) - value) > 0.01) setAlpha(key, value); });
            paintTool?.applyState(state);
            legTool?.applyState(state);
        } finally { applying = false; }
    }
    // Anything the user does to the view counts as leaving the presenter's view.
    ['pointerdown', 'wheel'].forEach(type => canvas.addEventListener(type, emitNav, { passive: true }));
    root.querySelector('.view-cube-wrap').addEventListener('pointerdown', emitNav);
    root.querySelector('.rv-segs')?.addEventListener('pointerdown', emitNav);
    root.querySelector('.rv-sweep')?.addEventListener('keydown', event => { if (/^(Arrow|Home|End)/.test(event.key)) emitNav(); });
    sectionPanel.addEventListener('input', emitNav);
    sectionPanel.addEventListener('click', event => { if (event.target.closest('button')) emitNav(); });
    toolButtons.section.addEventListener('click', emitNav);
    toolButtons.fit.addEventListener('click', emitNav);

    return {
        root, item,
        jumpTo, select: selectPin, jumpToPin: flyToPin,
        mediaEl: stage,
        getState, applyState, setLocked, setRemote, setOthers,
        onChange: cb => changeListeners.add(cb),
        onUserNav: cb => navListeners.add(cb),
        remount() {
            resize();
            // Layouts that swap items in and out re-attach the stage; do not wait for the observer.
            if (stage.isConnected && stage.clientWidth > 0) { visible = true; start(); }
        },
        tutorials() { return ['camera', ...(paintTool ? ['paint'] : []), ...(legTool ? ['leg'] : [])]; },
        // The part a slider is showing, and how a paw from it sits on the pipe ("pawFit").
        currentPart() {
            if (!isSweep) return null;
            const value = item.values[sweep.index];
            return { value, file: item.file(value), fit: value === 'original' ? item.original?.pawFit : item.pawFit };
        },
        onPart(fn) { partListeners.add(fn); },
        setLegPaw(spec) { return legTool?.setPaw(spec); },
        showTutorial(kind = 'camera') {
            if (kind === 'paint') return paintTool ? paintTool.showGuide() : false;
            if (kind === 'leg') return legTool ? legTool.showGuide() : false;
            viewerControls.startIntro({ force: true });
            return true;
        },
        // Frees both WebGL contexts (stage and view cube). The viewer cannot be used afterwards.
        destroy() {
            visible = false;
            renderer.setAnimationLoop(null);
            io.disconnect();
            resizeObserver.disconnect();
            unsubscribeStore();
            window.removeEventListener('keydown', onKey);
            viewerControls.dispose?.();
            scene.traverse(object => { if (object.isMesh) object.geometry.dispose(); });
            materials.forEach(material => material.dispose());
            renderer.dispose();
            renderer.forceContextLoss();
            root.remove();
        },
    };
}

// ---- stage: tabs of panes -------------------------------------------------------------------------
// A screen with named sources (3D models, videos, images) and tabs that show one or two of them side
// by side. Each model viewer owns two WebGL contexts (stage and view cube) and browsers allow about
// sixteen, so only the stage on screen keeps its model viewers; others are torn down and rebuilt.
let liveStage = null;
const MODEL_KINDS = new Set(['assembly', 'sweep']);

function pendingCard(part) {
    return el('div', 'rv-pending', `${icon('package-plus')}<strong>${escapeHTML(part.label || 'This view')} not added yet</strong>${part.expects ? `<span>Expected file: <code>${escapeHTML(part.expects)}</code></span>` : ''}${part.note ? `<span>${escapeHTML(part.note)}</span>` : ''}`);
}

function createImagePane(src) {
    const root = el('div', 'rv-image');
    const images = src.images || [];
    root.innerHTML = `<div class="rv-image-frame"><img alt=""></div>${images.length > 1 ? `<div class="rv-image-nav"><button type="button" data-step="-1" title="Previous image">${icon('chevron-left')}</button><span></span><button type="button" data-step="1" title="Next image">${icon('chevron-right')}</button></div>` : ''}<p class="rv-image-caption"></p>`;
    const img = root.querySelector('img');
    const frameEl = root.querySelector('.rv-image-frame');
    const caption = root.querySelector('.rv-image-caption');
    let index = 0, zoom = 1, x = 0, y = 0;
    const apply = () => { img.style.transform = `translate(${x}px, ${y}px) scale(${zoom})`; };
    function show(i) {
        index = (i + images.length) % images.length;
        img.src = images[index].src;
        caption.textContent = images[index].caption || '';
        caption.hidden = !images[index].caption;
        const counter = root.querySelector('.rv-image-nav span');
        if (counter) counter.textContent = `${index + 1} / ${images.length}`;
        zoom = 1; x = 0; y = 0; apply();
    }
    root.querySelectorAll('[data-step]').forEach(b => b.addEventListener('click', () => show(index + +b.dataset.step)));
    frameEl.addEventListener('wheel', event => { event.preventDefault(); zoom = Math.min(8, Math.max(1, zoom * (event.deltaY < 0 ? 1.15 : 1 / 1.15))); if (zoom === 1) { x = 0; y = 0; } apply(); }, { passive: false });
    let drag = null;
    frameEl.addEventListener('pointerdown', event => { if (zoom > 1) { drag = { x: event.clientX - x, y: event.clientY - y }; frameEl.setPointerCapture(event.pointerId); } });
    frameEl.addEventListener('pointermove', event => { if (drag) { x = event.clientX - drag.x; y = event.clientY - drag.y; apply(); } });
    frameEl.addEventListener('pointerup', () => { drag = null; });
    frameEl.addEventListener('dblclick', () => { zoom = 1; x = 0; y = 0; apply(); });
    if (images.length) show(0);
    return { root, getState: () => ({ image: index }), applyState: state => { if (Number.isFinite(state?.image) && state.image !== index) show(state.image); }, remount() {} };
}

function libraryEntry(key) {
    if (!key.startsWith('lib:')) return null;
    const entry = (review.library || []).find(l => l.id === key.slice(4));
    if (!entry) return null;
    if (entry.kind === 'image') return { kind: 'image', label: entry.label, images: entry.images ? entry.images.map(img => ({ ...img, src: resolveSource(img.src) })) : [{ src: entry.src, caption: entry.caption }] };
    return { kind: 'video', label: entry.label, src: entry.src, poster: entry.poster, stops: entry.stops || [], sourceKey: key };
}

function createStageViewer(item) {
    const root = el('div', 'rv-compare rv-stagev');
    const views = item.views.map(v => ({ ...v }));
    root.innerHTML = `
        <div class="rv-compare-bar">
            <div class="rv-stage-tabs" role="tablist" aria-label="Views"></div>
            <span class="rv-compare-link" title="Rotating, zooming or cutting one side moves the other" hidden>${icon('link-2')} Views linked</span>
            ${(review.library || []).length ? `<div class="rv-media-menu rv-host-only"><button type="button" class="rv-media-add" title="Show a video or picture from the media library on this screen">${icon('image-plus')} Media</button><div class="rv-media-list" hidden></div></div>` : ''}
        </div>
        <div class="rv-compare-stage"></div>`;
    const tabsEl = root.querySelector('.rv-stage-tabs');
    const linkEl = root.querySelector('.rv-compare-link');
    const stageEl = root.querySelector('.rv-compare-stage');
    const narrow = window.matchMedia('(max-width: 880px)');
    const changeListeners = new Set();
    const navListeners = new Set();
    let view = (views.find(v => v.key === item.defaultView) || views[0]).key;
    let built = null;         // srcKey -> model viewer, while this stage is live
    const kept = {};          // srcKey -> video / image pane (no WebGL), built once
    const paneEls = {};
    const linkedPairs = new Set();
    let locked = false;
    let remote = { list: [], name: '' };
    let others = [];
    let linking = false;
    const emit = kind => changeListeners.forEach(fn => fn(kind));

    const sourceOf = key => item.sources[key] || libraryEntry(key);
    const isModel = src => !!src && MODEL_KINDS.has(src.kind);
    function wire(child) {
        child.onChange?.(kind => emit(kind));
        child.onUserNav?.(() => navListeners.forEach(fn => fn()));
        child.setLocked?.(locked);
        child.setRemote?.(remote.list, remote.name);
        child.setOthers?.(others);
    }
    function paneFor(key) {
        if (paneEls[key]) return paneEls[key];
        const src = sourceOf(key) || {};
        const pane = el('section', 'rv-pane');
        pane.dataset.pane = key;
        pane.hidden = true;
        // "tag": false on a source leaves out the name banner at the top of its pane.
        pane.innerHTML = `${src.tag === false ? '' : `<p class="rv-pane-tag${src.tone === 'proposed' ? ' is-proposed' : ''}"><strong>${escapeHTML(src.label || key)}</strong><em>${escapeHTML(src.caption || '')}</em></p>`}<div class="rv-pane-body"></div>`;
        stageEl.append(pane);
        paneEls[key] = pane;
        return pane;
    }
    function buildPane(key) {
        const src = sourceOf(key);
        const body = paneFor(key).querySelector('.rv-pane-body');
        if (!src) { body.replaceChildren(pendingCard({ label: key })); return; }
        if (isModel(src)) {
            if (built[key]) return;
            try {
                const viewer = createModelViewer(src);
                body.replaceChildren(viewer.root);
                built[key] = viewer;
                wire(viewer);
                viewer.onPart(() => { pawParts[key] = viewer.currentPart(); syncLegs(); });
                syncLegs();
            } catch (error) {
                console.error(`Could not build "${key}" of "${item.title}"`, error);
                body.replaceChildren(createErrorMedia(src, error).root);
            }
            return;
        }
        if (kept[key]) return;
        // A video or picture slot with nothing in it yet (set up in the editor, files chosen later).
        const empty = src.kind === 'playlist' ? !(src.clips || []).length : src.kind === 'video' ? !src.src : src.kind === 'image' ? !(src.images || []).some(i => i.src) : false;
        if (empty) {
            kept[key] = { pending: true };
            body.replaceChildren(pendingCard({ label: src.label, note: src.kind === 'image' ? 'Choose pictures for it in the presentation editor (Browse pictures).' : 'Choose videos or pictures for it in the presentation editor (Browse media).' }));
            return;
        }
        if (src.kind === 'video' || src.kind === 'playlist') {
            const child = createVideoAnnotator({ ...src, id: item.id, sourceKey: key, title: item.title });
            body.replaceChildren(child.root);
            kept[key] = child;
            wire(child);
        } else if (src.kind === 'image') {
            // Pictures open in the same viewer as video clips: drawing, text, eraser, zoom and marks in the
            // notes, and the whole picture always fits (no cropping). Several pictures become a clip list.
            const clips = (src.images || []).filter(img => img.src).map((img, i) => ({ id: `img-${i + 1}`, label: img.caption || decodeURIComponent(String(img.src).split('/').pop()), src: img.src }));
            const child = createVideoAnnotator({ kind: 'playlist', label: src.label, clips, id: item.id, sourceKey: key, title: item.title });
            body.replaceChildren(child.root);
            kept[key] = child;
            wire(child);
        } else {
            kept[key] = { pending: true };
            body.replaceChildren(pendingCard(src));
        }
    }
    // Paw chosen on a slider -> the leg tool on the same screen (even when they are on different tabs).
    const pawParts = {};
    function defaultPart(key) {
        const src = sourceOf(key);
        if (!src || src.kind !== 'sweep') return null;
        const value = src.values.includes(src.defaultValue) ? src.defaultValue : src.values[0];
        return { value, file: src.file(value), fit: value === 'original' ? src.original?.pawFit : src.pawFit };
    }
    function syncLegs() {
        Object.keys(item.sources).forEach(key => {
            const follow = sourceOf(key)?.leg?.followPaw;
            if (!follow || !built?.[key]) return;
            const part = pawParts[follow] || defaultPart(follow);
            if (part?.file) built[key].setLegPaw({ file: part.file, ...(part.fit || {}), label: part.value });
        });
    }
    function linkModels() {
        const keys = Object.keys(built);
        keys.forEach(a => keys.forEach(b => {
            if (a === b || linkedPairs.has(a + '>' + b)) return;
            linkedPairs.add(a + '>' + b);
            built[a].onChange(kind => {
                if (linking || kind === 'sweep' || kind === 'surface' || kind === 'leg' || kind === 'demo' || !built?.[b]) return;
                if (paneEls[a]?.hidden || paneEls[b]?.hidden) return;
                const state = built[a].getState();
                linking = true;
                // Camera and section follow always; parts only when someone shows, hides or turns one
                // see-through, so each side keeps the look it was set to open with.
                const parts = kind === 'layers' ? { layers: state.layers, alpha: state.alpha } : {};
                try { built[b].applyState({ camera: state.camera, section: state.section, ...parts }); } finally { linking = false; }
            });
        }));
    }
    function renderTabs() {
        tabsEl.innerHTML = views.map(v => `<button type="button" role="tab" data-view="${escapeHTML(v.key)}"${v.key.startsWith('lib:') ? ' class="is-media"' : ''}>${v.icon ? icon(v.icon) + ' ' : ''}${escapeHTML(v.label)}${v.key.startsWith('lib:') ? `<span class="rv-tab-x rv-host-only" data-close="${escapeHTML(v.key)}" title="Remove this tab">×</span>` : ''}</button>`).join('');
        tabsEl.hidden = views.length < 2;
        tabsEl.querySelectorAll('[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === view));
        refreshIcons();
    }
    function equalizeBars(visible) {
        // A slider or pipe bar under one model makes that stage shorter; pad the others to match.
        const bars = visible.map(key => {
            const viewerRoot = paneEls[key]?.querySelector('.rv-viewer');
            return viewerRoot ? [...viewerRoot.children].filter(c => !c.classList.contains('rv-stage')).reduce((h, c) => h + c.offsetHeight, 0) : 0;
        });
        const max = Math.max(0, ...bars);
        visible.forEach((key, i) => { paneEls[key].querySelector('.rv-pane-body').style.paddingBottom = paneEls[key].querySelector('.rv-viewer') && bars[i] < max ? `${max - bars[i]}px` : ''; });
    }
    function ensureLive() {
        if (built) return;
        if (liveStage && liveStage !== api) liveStage.teardown();
        liveStage = api;
        built = {};
        linkedPairs.clear();
    }
    function showView(key, silent = false) {
        if (!views.some(v => v.key === key)) key = views[0].key;
        ensureLive();
        view = key;
        let panes = views.find(v => v.key === key).panes;
        // Phones and tablets held upright: the two halves of a split view go one above the other.
        const stacked = narrow.matches && panes.length > 1;
        panes.forEach(buildPane);
        // "linkCameras": false for screens whose models are in different frames (e.g. paw shapes vs the worn paw).
        if (item.linkCameras !== false) linkModels();
        Object.entries(paneEls).forEach(([k, pane]) => {
            const at = panes.indexOf(k);
            pane.hidden = at < 0;
            pane.style.order = at;
            pane.classList.toggle('is-secondary', at > 0);
            pane.classList.toggle('is-linked', item.linkCameras !== false);
            if (at < 0) pane.querySelector('video')?.pause();
        });
        root.dataset.view = key;
        root.dataset.panes = panes.length;
        root.dataset.stacked = stacked ? '1' : '';
        linkEl.hidden = item.linkCameras === false || panes.filter(k => isModel(sourceOf(k))).length < 2;
        renderTabs();
        const bars = () => { if (stacked) panes.forEach(k => { paneEls[k].querySelector('.rv-pane-body').style.paddingBottom = ''; }); else equalizeBars(panes); };
        const refresh = () => {
            panes.forEach(k => { built?.[k]?.remount(); kept[k]?.remount?.(); });
            bars();
        };
        refresh();
        requestAnimationFrame(refresh);
        setTimeout(bars, 600);
        if (!silent) emit('view');
    }
    function addLibraryView(key) {
        const src = libraryEntry(key);
        if (!src) return false;
        if (!views.some(v => v.key === key)) views.push({ key, label: src.label, icon: src.kind === 'image' ? 'image' : 'film', panes: [key] });
        return true;
    }
    tabsEl.addEventListener('click', event => {
        const close = event.target.closest('[data-close]');
        if (close) {
            event.stopPropagation();
            const at = views.findIndex(v => v.key === close.dataset.close);
            if (at >= 0) views.splice(at, 1);
            paneEls[close.dataset.close]?.querySelector('video')?.pause();
            navListeners.forEach(fn => fn());
            showView(view === close.dataset.close ? views[0].key : view);
            return;
        }
        const button = event.target.closest('[data-view]');
        if (!button) return;
        navListeners.forEach(fn => fn());
        showView(button.dataset.view);
    });
    const mediaMenu = root.querySelector('.rv-media-menu');
    if (mediaMenu) {
        const list = mediaMenu.querySelector('.rv-media-list');
        list.innerHTML = review.library.map(entry => `<button type="button" data-lib="${escapeHTML(entry.id)}">${icon(entry.kind === 'image' ? 'image' : 'film')} ${escapeHTML(entry.label)}</button>`).join('');
        mediaMenu.querySelector('.rv-media-add').addEventListener('click', () => { list.hidden = !list.hidden; refreshIcons(); });
        list.addEventListener('click', event => {
            const button = event.target.closest('[data-lib]');
            if (!button) return;
            list.hidden = true;
            const key = 'lib:' + button.dataset.lib;
            if (addLibraryView(key)) { navListeners.forEach(fn => fn()); showView(key); }
        });
        document.addEventListener('pointerdown', event => { if (!mediaMenu.contains(event.target)) list.hidden = true; });
    }
    narrow.addEventListener('change', () => { if (built) showView(view, true); });

    function teardown() {
        if (!built) return;
        Object.values(kept).forEach(child => child.root?.querySelector('video')?.pause());
        Object.entries(built).forEach(([key, viewer]) => { viewer.destroy(); paneEls[key]?.querySelector('.rv-pane-body').replaceChildren(); });
        built = null;
        if (liveStage === api) liveStage = null;
    }
    const annotation = id => store.item(item.id).annotations.find(a => a.id === id);
    const api = {
        root, item,
        mediaEl: stageEl,
        jumpTo(id) {
            const target = annotation(id);
            if (!target) return;
            if (target.kind === 'mark') {
                const key = target.source || Object.keys(item.sources).find(k => ['video', 'playlist'].includes(item.sources[k].kind));
                const v = views.find(x => x.key === view && x.panes.includes(key)) || views.find(x => x.panes.includes(key));
                if (v && v.key !== view) showView(v.key);
                kept[key]?.jumpTo?.(id);
                return;
            }
            const current = views.find(x => x.key === view);
            if (target.source && isModel(sourceOf(target.source)) && !current.panes.includes(target.source)) {
                const v = views.find(x => x.panes.includes(target.source));
                if (v) showView(v.key);
            } else if (!current.panes.some(k => isModel(sourceOf(k)))) {
                const withModel = views.find(x => x.panes.some(k => isModel(sourceOf(k))));
                if (withModel) showView(withModel.key);
            }
            Object.values(built || {}).forEach(viewer => viewer.jumpTo(id));
        },
        select(id) {
            Object.values(built || {}).forEach(viewer => viewer.select(id));
            Object.values(kept).forEach(child => child.select?.(id));
        },
        jumpToPin(pin) {
            const keys = Object.keys(item.sources);
            const key = (pin.source && isModel(sourceOf(pin.source))) ? pin.source : (keys.find(k => sourceOf(k)?.isFirstModel) || keys.find(k => isModel(sourceOf(k))));
            if (!key) return;
            const v = views.find(x => x.key === view && x.panes.includes(key)) || views.find(x => x.panes.includes(key));
            if (v && v.key !== view) showView(v.key);
            built?.[key]?.jumpToPin?.(pin);
        },
        jumpToMark(mark) {
            const key = mark.source || Object.keys(item.sources).find(k => ['video', 'playlist'].includes(item.sources[k].kind));
            const v = views.find(x => x.key === view && x.panes.includes(key)) || views.find(x => x.panes.includes(key));
            if (v && v.key !== view) showView(v.key);
            kept[key]?.jumpToMark?.(mark);
        },
        getState() {
            const panes = {};
            Object.entries(built || {}).forEach(([key, viewer]) => { panes[key] = viewer.getState(); });
            Object.entries(kept).forEach(([key, child]) => { if (child.getState) panes[key] = child.getState(); });
            const annotations = [];
            const seen = new Set();
            Object.values(panes).forEach(st => (st.annotations || []).forEach(a => { if (!seen.has(a.id)) { seen.add(a.id); annotations.push(a); } }));
            return { view, panes, media: views.filter(v => v.key.startsWith('lib:')).map(v => v.key), annotations };
        },
        applyState(state) {
            if (!state) return;
            (state.media || []).forEach(addLibraryView);
            if (state.view && state.view !== view) showView(state.view, true);
            else ensureLive();
            linking = true;
            try {
                Object.entries(state.panes || {}).forEach(([key, st]) => { (built?.[key] || kept[key])?.applyState?.(st); });
            } finally { linking = false; }
        },
        setLocked(value) {
            locked = !!value;
            root.classList.toggle('rv-locked', locked);
            Object.values(built || {}).forEach(viewer => viewer.setLocked(locked));
            Object.values(kept).forEach(child => child.setLocked?.(locked));
        },
        setRemote(list, name) {
            remote = { list: list || [], name };
            Object.values(built || {}).forEach(viewer => viewer.setRemote(remote.list, name));
            Object.values(kept).forEach(child => child.setRemote?.(remote.list, name));
        },
        setOthers(list) {
            others = list || [];
            Object.values(built || {}).forEach(viewer => viewer.setOthers?.(others));
            Object.values(kept).forEach(child => child.setOthers?.(others));
        },
        // The camera tutorial opens on the first 3D view showing on this screen.
        tutorials() {
            const visible = Object.keys(paneEls).filter(key => !paneEls[key]?.hidden).map(key => built?.[key] || kept[key]).filter(Boolean);
            return [...new Set(visible.flatMap(pane => pane.tutorials?.() || []))];
        },
        showTutorial(kind = 'camera') {
            const visible = Object.keys(paneEls).filter(key => !paneEls[key]?.hidden).map(key => built?.[key] || kept[key]).filter(Boolean);
            const pane = visible.find(p => (p.tutorials?.() || []).includes(kind));
            return pane ? pane.showTutorial(kind) : false;
        },
        onChange: cb => changeListeners.add(cb),
        onUserNav: cb => navListeners.add(cb),
        remount() { showView(view, true); },
        teardown,
    };
    renderTabs();
    return api;
}

// ---- video annotator ---------------------------------------------------------------------------

const PEN_COLORS = ['#ff3fa4', '#ffd400', '#00c2ff', '#3ddc84', '#ffffff'];
const GHOST_STEPS = [0, 2, 5, 10];
// A clip can be a picture as well as a video: it gets the same drawing tools, without the play bar.
const PICTURE_FILE = /\.(jpe?g|png|webp|gif|svg|avif)(?:[?#]|$)/i;
const isPicture = c => !!c && (c.type === 'image' || PICTURE_FILE.test(c.src || ''));
const LINE_WIDTH = 1.5;   // px, every drawn line (there is no thickness choice)
function createVideoAnnotator(item) {
    const root = el('div', 'rv-video');
    root.tabIndex = 0;
    const sourceKey = item.sourceKey || '';
    const clips = item.kind === 'playlist' ? item.clips : [{ id: '', label: item.label || item.title, src: item.src, poster: item.poster, stops: item.stops || [], rotate: item.rotate, start: item.start, end: item.end }];
    let clip = clips[0];
    // The strip of clip thumbnails is hidden until you open it (remembered in this browser);
    // "showClips": true on a playlist opens it unless this browser has closed it before.
    const CLIPS_KEY = 'gap-review-clips-shown';
    let clipsShown = (() => { try { const kept = localStorage.getItem(CLIPS_KEY); return kept === null ? !!item.showClips : kept === '1'; } catch { return !!item.showClips; } })();
    root.innerHTML = `
        ${clips.length > 1 ? `<div class="rv-clips" role="tablist" aria-label="Choose a clip"><span class="rv-clips-now"></span>${clips.map(c => { const thumb = c.poster || (isPicture(c) ? c.src : ''); return `<button type="button" role="tab" data-clip="${escapeHTML(c.id)}" title="${escapeHTML(c.label)}">${thumb ? `<img src="${escapeHTML(thumb)}" alt="" loading="lazy">` : icon(isPicture(c) ? 'image' : 'film')}<span>${escapeHTML(c.label)}</span></button>`; }).join('')}<button type="button" class="rv-clips-toggle" aria-expanded="${clipsShown}"></button></div>` : ''}
        <div class="rv-video-frame">
            <div class="rv-zoom-layer">
                <video preload="metadata" playsinline muted></video>
                <img class="rv-picture" alt="" hidden>
                <canvas class="rv-ghost"></canvas>
                <canvas class="rv-draw"></canvas>
                <div class="rv-mark-labels"></div>
            </div>
            <div class="rv-stop-banner" hidden>${icon('octagon-pause')}<span></span><button type="button" class="rv-stop-go">${icon('play')} Continue</button></div>
            <div class="rv-zoom-box" hidden></div>
            <button type="button" class="rv-zoom-reset" hidden title="Back to the whole picture (Esc, or double-click the video)">${icon('zoom-out')} <span></span></button>
            <div class="rv-video-tools" role="toolbar" aria-label="Annotation tools">
                <button type="button" class="rv-tools-toggle" title="Drawing tools" aria-expanded="false">${icon('pencil-line')}</button>
                <button type="button" data-tool="pen" title="Draw freehand">${icon('pencil')}</button>
                <button type="button" data-tool="text" title="Type a note on the frame">${icon('type')}</button>
                <button type="button" data-tool="erase" title="Eraser: drag over a drawing to remove it">${icon('eraser')}</button>
                <button type="button" data-action="undo" title="Undo the last line">${icon('undo-2')}</button>
                <button type="button" data-tool="zoom" title="Zoom: drag a box over the part to look at closely">${icon('zoom-in')}</button>
                <span class="rv-sep"></span>
                <span class="rv-swatches" role="group" aria-label="Pen colour">${PEN_COLORS.map((c, i) => `<button type="button" class="rv-swatch${i === 0 ? ' active' : ''}" data-color="${c}" style="--swatch:${c}" title="Pen colour"></button>`).join('')}</span>
            </div>
            <input type="text" class="rv-text-input" maxlength="80" placeholder="Type, then Enter" hidden>
            <p class="rv-mode-hint" hidden></p>
        </div>
        <div class="rv-timeline"><div class="rv-timeline-track"><div class="rv-timeline-fill"></div><div class="rv-timeline-head"></div></div></div>
        <div class="rv-video-bar">
            <button type="button" class="rv-play" title="Play or pause (space)">${icon('play')}</button>
            <span class="rv-time">0:00.0 <small>/ 0:00.0</small></span>
            <span class="rv-frame" title="Frame number">f 0</span>
            <span class="rv-range-btns" role="group" aria-label="Comment on a stretch of video">
                <button type="button" data-action="in" title="Start of a range (I)">${icon('arrow-right-to-line')}</button>
                <button type="button" data-action="out" title="End of a range (O)">${icon('arrow-left-to-line')}</button>
                <button type="button" data-action="loop" title="Loop the selected range">${icon('repeat')}</button>
            </span>
            <button type="button" data-action="mute" title="Unmute (videos start muted)">${icon('volume-x')}</button>
            <button type="button" class="rv-flag" title="Bookmark this moment without drawing">${icon('bookmark-plus')} Flag this moment</button>
            <button type="button" class="rv-autostop" title="Pause automatically at each stop point">${icon('octagon-pause')} Stops</button>
            <button type="button" class="rv-stop-edit rv-host-only" title="Add a stop point here, or remove the one you are on">${icon('map-pin-plus')} Add stop</button>
            <button type="button" class="rv-rotate rv-host-only" title="Turn this video a quarter turn (for clips filmed sideways or upside down)">${icon('rotate-cw')}</button>
        </div>`;
    const frameEl = root.querySelector('.rv-video-frame');
    const video = root.querySelector('video');
    const canvas = root.querySelector('.rv-draw');
    const ctx = canvas.getContext('2d');
    const labelsEl = root.querySelector('.rv-mark-labels');
    const toolsEl = root.querySelector('.rv-video-tools');
    const hintEl = root.querySelector('.rv-mode-hint');
    const timeline = root.querySelector('.rv-timeline');
    const track = root.querySelector('.rv-timeline-track');
    const fill = root.querySelector('.rv-timeline-fill');
    const head = root.querySelector('.rv-timeline-head');
    const timeEl = root.querySelector('.rv-time');
    const playBtn = root.querySelector('.rv-play');
    const frameEl2 = root.querySelector('.rv-frame');
    const ghostCanvas = root.querySelector('.rv-ghost');
    const ghostCtx = ghostCanvas.getContext('2d');
    video.muted = true;   // the attribute alone is not reliable once the element exists
    const picture = root.querySelector('.rv-picture');
    // Show the current clip: a video in <video>, a picture in <img> (same frame, same drawing layer).
    function loadMedia() {
        const pic = isPicture(clip);
        root.classList.toggle('is-picture', pic);
        picture.hidden = !pic;
        if (pic) {
            video.pause();
            video.removeAttribute('src');
            video.removeAttribute('poster');
            video.load();
            picture.src = clip.src;
        } else {
            picture.removeAttribute('src');
            video.src = clip.src;
            if (clip.poster) video.poster = clip.poster; else video.removeAttribute('poster');
        }
    }
    loadMedia();
    picture.addEventListener('load', () => { layout(); renderTimeline(); syncStopUI(); draw(); });

    let tool = null;
    let selected = null;
    let drawing = null;
    const content = { left: 0, top: 0, width: 1, height: 1 };
    // Zoom: a box on the picture ([x0, y0, x1, y1], 0..1 of the picture) fills the frame. The video, the
    // drawings and their labels zoom together; drawing while zoomed lands in the right place. zs = scale.
    let zoomRegion = null;
    let zs = 1;
    const zoomLayer = root.querySelector('.rv-zoom-layer');
    const zoomBox = root.querySelector('.rv-zoom-box');
    const zoomReset = root.querySelector('.rv-zoom-reset');
    // Live-session hooks.
    let applying = false;
    const changeListeners = new Set();
    const navListeners = new Set();
    const emitChange = () => { if (!applying) changeListeners.forEach(fn => fn('video')); };
    const emitNav = () => { if (!applying) navListeners.forEach(fn => fn()); };

    function marks() { return store.item(item.id).annotations.filter(a => a.kind === 'mark' && (a.source || '') === sourceKey && (a.clip || '') === (clip.id || '')); }
    function allMarks() { return store.item(item.id).annotations.filter(a => a.kind === 'mark' && (a.source || '') === sourceKey); }
    const markMeta = () => ({ ...(sourceKey ? { source: sourceKey } : {}), ...(clip.id ? { clip: clip.id } : {}) });
    const fps = () => clip.fps || item.fps || 30;
    let penColor = PEN_COLORS[0];
    const penWidth = 2.5;   // sets the size of typed notes; lines are always drawn at LINE_WIDTH
    let rangeIn = null;
    let looping = false;
    let ghostStep = 0;
    let othersMarks = [];
    let reverseTimer = null;

    // Stop points: the host's own list (this browser) wins, then the presenter's, then the review file.
    const stopKey = () => `${item.id}|${sourceKey}|${clip.id || ''}`;
    let remoteStops = null;
    let autoStop = true;
    const stopBanner = root.querySelector('.rv-stop-banner');
    const autoBtn = root.querySelector('.rv-autostop');
    const stopEditBtn = root.querySelector('.rv-stop-edit');
    function stops() { return (hostStore.stops(stopKey()) || remoteStops || clip.stops || []).slice().sort((x, y) => x - y); }
    // Trim: a clip can start and end inside its file ("start" / "end" in seconds, set in the editor). The
    // timeline covers only that part and the clock counts from its start; marks keep file times.
    const trimStart = () => Math.max(0, +clip.start || 0);
    const trimEnd = () => {
        const d = video.duration || 0;
        const e = +clip.end;
        return e > trimStart() ? (d ? Math.min(e, d) : e) : d;
    };
    const trimSpan = () => Math.max(trimEnd() - trimStart(), 0.001);
    const relTime = t => fmtTime(Math.max(0, Math.min(t, trimEnd() || t) - trimStart()));
    const trimFrac = t => (t - trimStart()) / trimSpan();
    const trimmed = () => trimStart() > 0 || +clip.end > 0;
    // Rotation: the presenter's turn in this browser, else the presenter's live state, else the review file.
    let remoteRotate = null;
    function rotation() {
        const deg = hostStore.rotation(stopKey()) ?? remoteRotate ?? clip.rotate ?? 0;
        return ((Math.round(+deg / 90) * 90) % 360 + 360) % 360;
    }
    const sideways = () => rotation() % 180 !== 0;
    function applyRotation() {
        const deg = rotation();
        const W = frameEl.clientWidth, H = frameEl.clientHeight;
        [video, picture].forEach(node => {
            if (deg % 180) {
                // Swap the element's width and height, then turn it: object-fit keeps the picture whole.
                Object.assign(node.style, { width: `${H}px`, height: `${W}px`, left: `${(W - H) / 2}px`, top: `${(H - W) / 2}px`, right: 'auto', bottom: 'auto', transform: `rotate(${deg}deg)` });
            } else {
                Object.assign(node.style, { width: '', height: '', left: '', top: '', right: '', bottom: '', transform: deg ? `rotate(${deg}deg)` : '' });
            }
        });
        clipsEl?.querySelectorAll('[data-clip]').forEach(button => {
            const c = clips.find(x => x.id === button.dataset.clip);
            const img = button.querySelector('img');
            if (!c || !img) return;
            const d = c === clip ? deg : ((Math.round(+(hostStore.rotation(`${item.id}|${sourceKey}|${c.id || ''}`) ?? c.rotate ?? 0) / 90) * 90) % 360 + 360) % 360;
            img.style.transform = d ? `rotate(${d}deg)${d % 180 ? ' scale(0.5625)' : ''}` : '';
        });
    }
    function drawRotated(ctx2, source, width, height) {
        const deg = rotation();
        if (!deg) { ctx2.drawImage(source, 0, 0, width, height); return; }
        ctx2.save();
        ctx2.translate(width / 2, height / 2);
        ctx2.rotate(deg * Math.PI / 180);
        if (deg % 180) ctx2.drawImage(source, -height / 2, -width / 2, height, width);
        else ctx2.drawImage(source, -width / 2, -height / 2, width, height);
        ctx2.restore();
    }
    function syncStopUI() {
        const list = stops();
        autoBtn.hidden = !list.length && !policy.isHost();
        autoBtn.classList.toggle('active', autoStop);
        const here = list.find(st => Math.abs(st - video.currentTime) < 0.06);
        stopEditBtn.innerHTML = here !== undefined ? `${icon('x')} Remove stop` : `${icon('map-pin-plus')} Add stop`;
        refreshIcons();
    }
    function showStopBanner(at) {
        stopBanner.hidden = false;
        stopBanner.querySelector('span').textContent = `Stop at ${relTime(at)}. Look, draw, discuss.`;
    }
    autoBtn.addEventListener('click', () => { autoStop = !autoStop; syncStopUI(); });
    root.querySelector('.rv-rotate').addEventListener('click', () => {
        const deg = (rotation() + 90) % 360;
        hostStore.setRotation(stopKey(), deg);
        layout();
        emitChange();
        toast(`Turned to ${deg}°, for everyone in a live session. To keep it in the review file, use "Download review file with my stop points" in the Live panel, or set Turn for this clip in the editor.`, 5000);
    });
    stopEditBtn.addEventListener('click', () => {
        const t = +video.currentTime.toFixed(2);
        const list = stops();
        const here = list.findIndex(st => Math.abs(st - t) < 0.06);
        if (here >= 0) list.splice(here, 1); else { list.push(t); guide.done('stop'); }
        hostStore.setStops(stopKey(), list.sort((x, y) => x - y));
        renderTimeline();
        syncStopUI();
        emitChange();
        toast(here >= 0 ? 'Stop point removed' : `Stop point added at ${relTime(t)}`);
    });
    stopBanner.querySelector('.rv-stop-go').addEventListener('click', () => { stopBanner.hidden = true; video.play(); });
    let lastT = 0;
    function watchStops(now, meta) {
        if (video.paused) return;
        const t = meta?.mediaTime ?? video.currentTime;
        if (autoStop && !applying) {
            const hit = stops().find(st => st > lastT + 0.001 && st <= t + 0.017 && st - lastT < 1.5);
            if (hit !== undefined) {
                video.pause();
                video.currentTime = hit;
                lastT = hit;
                showStopBanner(hit);
                return;
            }
        }
        if (+clip.end > 0 && t >= trimEnd() - 0.02) {
            video.pause();
            video.currentTime = trimEnd();
            lastT = trimEnd();
            return;
        }
        lastT = t;
        if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(watchStops);
    }
    video.addEventListener('play', () => {
        // Play from the trimmed start when outside the trimmed part (or at its end).
        if (trimmed() && !applying && (video.currentTime < trimStart() - 0.05 || video.currentTime >= trimEnd() - 0.05)) video.currentTime = trimStart();
        stopBanner.hidden = true;
        lastT = video.currentTime;
        if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(watchStops);
    });
    video.addEventListener('timeupdate', () => {
        if (!video.requestVideoFrameCallback) watchStops();
        // The end of a trimmed clip is also checked here (frame callbacks pause in background tabs).
        else if (+clip.end > 0 && !video.paused && video.currentTime >= trimEnd() - 0.02) { video.pause(); video.currentTime = trimEnd(); }
    });
    // A jump outside the trimmed part (e.g. from a live session) lands on its nearest end instead.
    video.addEventListener('seeked', () => {
        if (!video.duration || isPicture(clip)) return;
        if (+clip.end > 0 && video.currentTime > trimEnd() + 0.01) video.currentTime = trimEnd();
        else if (trimStart() && video.currentTime < trimStart() - 0.01) video.currentTime = trimStart();
    });
    video.addEventListener('seeked', () => { if (video.paused) lastT = video.currentTime; syncStopUI(); });

    // Clips -------------------------------------------------------------------------------------------
    const clipsEl = root.querySelector('.rv-clips');
    const clipsToggle = root.querySelector('.rv-clips-toggle');
    // The strip folds to one line (which clip is showing + "Show videos"); the button at its top right folds
    // and opens it.
    function syncClipsToggle() {
        if (!clipsToggle) return;
        root.classList.add('has-clips');
        clipsEl.classList.toggle('is-folded', !clipsShown);
        clipsToggle.setAttribute('aria-expanded', String(clipsShown));
        const noun = clips.every(isPicture) ? 'picture' : 'video';
        const n = clips.indexOf(clip) + 1;
        clipsEl.querySelector('.rv-clips-now').textContent = `${noun === 'picture' ? 'Picture' : 'Video'} ${n} of ${clips.length}${clip.label && !/^\d/.test(clip.label) ? ': ' + clip.label : ''}`;
        clipsToggle.innerHTML = clipsShown ? `${icon('chevron-up')} <span>Hide</span>` : `${icon('chevron-down')} <span>Show ${noun}s</span>`;
        clipsToggle.title = clipsShown ? `Fold the list of ${noun}s away` : `Show all ${clips.length} ${noun}s`;
        refreshIcons();
    }
    clipsToggle?.addEventListener('click', () => {
        clipsShown = !clipsShown;
        try { localStorage.setItem(CLIPS_KEY, clipsShown ? '1' : '0'); } catch { /* storage off */ }
        syncClipsToggle();
        if (clipsShown) clipsEl.querySelector('.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
    syncClipsToggle();
    function setClip(id, silent = false) {
        const next = clips.find(c => c.id === id);
        if (!next || next === clip) return Promise.resolve();
        clip = next;
        selected = null;
        rangeIn = null;
        zoomRegion = null;
        stopReverse();
        clearGhosts();
        stopBanner.hidden = true;
        remoteRotate = null;
        loadMedia();
        clipsEl?.querySelectorAll('[data-clip]').forEach(b => b.classList.toggle('active', b.dataset.clip === clip.id));
        syncClipsToggle();
        if (!silent) emitChange();
        if (isPicture(clip)) {
            return new Promise(resolve => {
                const done = () => { layout(); renderTimeline(); syncStopUI(); draw(); resolve(); };
                if (picture.complete && picture.naturalWidth) done();
                else { picture.addEventListener('load', done, { once: true }); picture.addEventListener('error', done, { once: true }); }
            });
        }
        return new Promise(resolve => video.addEventListener('loadedmetadata', () => { renderTimeline(); syncStopUI(); draw(); resolve(); }, { once: true }));
    }
    clipsEl?.querySelectorAll('[data-clip]').forEach(b => {
        b.classList.toggle('active', b.dataset.clip === clip.id);
        b.addEventListener('click', () => { emitNav(); setClip(b.dataset.clip); });
    });

    // Clip demo ("clipDemo": true on a playlist): a card like the 3D movement guide ("How to move") that walks
    // through the clip strip: pick the last video, go back to the first, fold the strip, open it again. Each
    // step ticks off ("You did it") once done and moves on; after the last one the card shrinks into the
    // header's "How to swap videos" button, which replays it. Plays on its own each time the page opens (the
    // 3D guide waits for it); "Got it, next" skips a step; x, Esc or the header button end it.
    const CLIP_DEMO_KEY = 'gap-review-clip-demo-seen';
    const swapButton = () => { const b = document.querySelector('.rv-guided .rv-swap-toggle'); return b && !b.hidden && b.offsetParent ? b : null; };
    const thumbEl = c => clipsEl.querySelector(`[data-clip="${CSS.escape(c.id)}"]`);
    let clipDemo = null;
    function clipSteps() {
        const verb = matchMedia('(pointer: coarse)').matches ? 'Tap' : 'Click';
        const first = clips[0], last = clips[clips.length - 1];
        const name = c => `<b>Video ${clips.indexOf(c) + 1}</b>${c.label && !/^\d/.test(c.label) ? ` (${escapeHTML(c.label)})` : ''}`;
        return [
            { title: 'Pick a video', text: `${verb} ${name(last)} in the strip above the video.`, art: clips.length - 1, target: () => thumbEl(last), done: () => clip === last },
            { title: 'Go back', text: `Now ${verb.toLowerCase()} ${name(first)}.`, art: 0, target: () => thumbEl(first), done: () => clip === first },
            { title: 'Fold the strip away', text: `${verb} <b>Hide</b> at the top right of the strip for a bigger video.`, art: 'hide', target: () => clipsToggle, done: () => !clipsShown },
            { title: 'Bring it back', text: `${verb} <b>Show videos</b> to open the strip again.`, art: 'show', target: () => clipsToggle, done: () => clipsShown },
        ];
    }
    // A small picture of the strip with a cursor tapping what the step asks for.
    function clipArtHTML(step) {
        const cursor = '<span class="rv-ca-cursor"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3l14 8-6 1.6L9.6 19z"/></svg></span>';
        if (step.art === 'show') return `<div class="rv-ca-strip is-folded"><span class="rv-ca-line"></span><span class="rv-ca-pill on">Show videos</span>${cursor}</div>`;
        const n = Math.min(clips.length, 5);
        const on = step.art === 'hide' ? -1 : Math.min(step.art, n - 1);
        return `<div class="rv-ca-strip">${Array.from({ length: n }, (_, i) => `<i${i === on ? ' class="on"' : ''}></i>`).join('')}<span class="rv-ca-pill${step.art === 'hide' ? ' on' : ''}">Hide</span>${cursor}</div>`;
    }
    function placeClipCard(d) {
        if (getComputedStyle(root).position === 'static') root.style.position = 'relative';
        const frame = frameEl.getBoundingClientRect(), box = root.getBoundingClientRect();
        d.card.style.top = `${Math.max(frame.top - box.top + 8, frame.bottom - box.top - d.card.offsetHeight - 12)}px`;
    }
    function showClipStep(d, index) {
        d.index = index;
        d.ticked = false;
        clearTimeout(d.timer);
        const step = d.steps[index];
        d.card.querySelector('[data-card]').innerHTML = `<div class="ctl-art"><figure><div class="ctl-art-frame">${clipArtHTML(step)}</div></figure></div><h3>${step.title}</h3><p class="ctl-note">${step.text}</p>`;
        const on = d.card.querySelector('.rv-ca-strip .on');
        const cursor = d.card.querySelector('.rv-ca-cursor');
        if (on && cursor) { cursor.style.left = `${on.offsetLeft + on.offsetWidth / 2}px`; cursor.style.top = `${on.offsetTop + on.offsetHeight / 2}px`; }
        d.card.querySelectorAll('[data-step]').forEach((dot, i) => dot.classList.toggle('active', i === index));
        d.card.querySelector('.controls-coach-done').textContent = index === d.steps.length - 1 ? 'Got it' : 'Got it, next';
        // The real thing gets a gold ring (and a clip scrolled out of the strip comes to the middle).
        root.querySelectorAll('.rv-demo-focus').forEach(node => node.classList.remove('rv-demo-focus'));
        const target = step.target();
        if (target) {
            if (target.matches('[data-clip]') && clipsEl.scrollWidth > clipsEl.clientWidth) clipsEl.scrollLeft = target.offsetLeft - (clipsEl.clientWidth - target.offsetWidth) / 2;
            target.classList.add('rv-demo-focus');
        }
        placeClipCard(d);
    }
    function collapseClipCard(card) {
        const into = swapButton();
        if (!into || matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
        // Lift the card out of the video (which clips its edges) and shrink it into the header button,
        // the way the 3D guide goes into "How to move".
        const from = card.getBoundingClientRect(), to = into.getBoundingClientRect();
        Object.assign(card.style, { position: 'fixed', left: `${from.left}px`, top: `${from.top}px`, bottom: 'auto', width: `${from.width}px`, margin: '0', zIndex: '200' });
        document.body.append(card);
        void card.offsetWidth;
        card.classList.add('is-collapsing');
        card.style.transform = `translate(${to.left + to.width / 2 - (from.left + from.width / 2)}px, ${to.top + to.height / 2 - (from.top + from.height / 2)}px) scale(0.05)`;
        const finish = () => {
            if (!card.isConnected) return;
            card.remove();
            into.classList.remove('is-pulsing');
            void into.offsetWidth;
            into.classList.add('is-pulsing');
            setTimeout(() => into.classList.remove('is-pulsing'), 2200);
        };
        card.addEventListener('transitionend', event => { if (event.propertyName === 'transform') finish(); });
        setTimeout(finish, 900);
        return true;
    }
    function stopClipDemo(animate = true) {
        const d = clipDemo;
        if (!d) return;
        clipDemo = null;
        clearInterval(d.watch);
        clearTimeout(d.timer);
        removeEventListener('keydown', d.key, true);
        removeEventListener('resize', d.place);
        root.querySelectorAll('.rv-demo-focus').forEach(node => node.classList.remove('rv-demo-focus'));
        if (!(animate && collapseClipCard(d.card))) d.card.remove();
        root.classList.remove('rv-demoing');
        document.querySelector('.rv-guided .rv-swap-toggle')?.classList.remove('active');
        try { localStorage.setItem(CLIP_DEMO_KEY, '1'); } catch { /* storage off */ }
        d.done();
    }
    function runClipDemo() {
        if (clipDemo) { stopClipDemo(); return Promise.resolve(); }
        const d = { steps: clipSteps(), index: 0, ticked: false };
        const finished = new Promise(resolve => { d.done = resolve; });
        clipDemo = d;
        d.key = event => { if (event.key === 'Escape') stopClipDemo(); };
        d.place = () => placeClipCard(d);
        addEventListener('keydown', d.key, true);
        addEventListener('resize', d.place);
        root.classList.add('rv-demoing');
        document.querySelector('.rv-guided .rv-swap-toggle')?.classList.add('active');
        if (!clipsShown) { clipsShown = true; syncClipsToggle(); }
        d.card = el('aside', 'controls-coach rv-clip-coach');
        d.card.setAttribute('aria-label', 'How to swap videos');
        d.card.innerHTML = `
            <button type="button" class="controls-coach-close" title="Hide (the How to swap videos button brings it back)" aria-label="Hide">&times;</button>
            <div class="ctl-card" data-card></div>
            <div class="controls-coach-foot">
                <div class="controls-coach-dots" role="group" aria-label="Choose a step">${d.steps.map((step, i) => `<button type="button" data-step="${i}" aria-label="${escapeHTML(step.title)}"></button>`).join('')}</div>
                <button type="button" class="controls-coach-done">Got it, next</button>
            </div>`;
        d.card.addEventListener('keydown', event => event.stopPropagation());
        d.card.querySelector('.controls-coach-close').addEventListener('click', () => stopClipDemo());
        d.card.querySelector('.controls-coach-done').addEventListener('click', () => { if (d.index < d.steps.length - 1) showClipStep(d, d.index + 1); else stopClipDemo(); });
        d.card.querySelectorAll('[data-step]').forEach(dot => dot.addEventListener('click', () => showClipStep(d, +dot.dataset.step)));
        root.append(d.card);
        const begin = () => {
            if (clipDemo !== d) return;
            showClipStep(d, 0);
            // A step done -> "You did it", then the next step; after the last, the card puts itself away.
            d.watch = setInterval(() => {
                if (clipDemo !== d) return;
                if (!root.isConnected || root.offsetParent === null) { stopClipDemo(false); return; }
                if (d.ticked || !d.steps[d.index].done()) return;
                d.ticked = true;
                d.card.querySelector('h3')?.classList.add('is-tried');
                root.querySelectorAll('.rv-demo-focus').forEach(node => node.classList.remove('rv-demo-focus'));
                const at = d.index;
                d.timer = setTimeout(() => {
                    if (clipDemo !== d || d.index !== at) return;
                    if (at < d.steps.length - 1) showClipStep(d, at + 1);
                    else stopClipDemo();
                }, at < d.steps.length - 1 ? 900 : 600);
            }, 150);
        };
        if (clip !== clips[0]) setClip(clips[0].id, true).then(begin);
        else begin();
        return finished;
    }
    if (item.clipDemo && clips.length > 1 && !clipDemoAutoStarted) {
        clipDemoAutoStarted = true;
        // Every time the page opens: wait until the video is on screen, play the demo, then the 3D movement guide.
        introHold = new Promise(resolve => {
            let tries = 0;
            const start = () => {
                // (and the tab is in front: a link opened in a background tab waits until it is looked at)
                if (root.offsetParent !== null && clipsEl.offsetWidth && document.visibilityState === 'visible') setTimeout(() => runClipDemo().then(() => setTimeout(() => resolve(true), 650)), 700);
                else if (document.visibilityState !== 'visible') document.addEventListener('visibilitychange', start, { once: true });
                else if (++tries < 600) setTimeout(start, 250);
                else resolve();
            };
            start();
        });
    }
    function layout() {
        applyRotation();
        // The picture's box on screen, after any quarter turn (marks are stored relative to it).
        const boxW = frameEl.clientWidth;
        const boxH = frameEl.clientHeight;
        const raw = isPicture(clip)
            ? (picture.naturalWidth && picture.naturalHeight ? picture.naturalWidth / picture.naturalHeight : 4 / 3)
            : (video.videoWidth && video.videoHeight) ? video.videoWidth / video.videoHeight : 16 / 9;
        const aspect = sideways() ? 1 / raw : raw;
        let w = boxW;
        let h = boxW / aspect;
        if (h > boxH) { h = boxH; w = boxH * aspect; }
        content.left = (boxW - w) / 2;
        content.top = (boxH - h) / 2;
        content.width = Math.max(w, 1);
        content.height = Math.max(h, 1);
        [canvas, ghostCanvas, labelsEl].forEach(node => {
            node.style.left = content.left + 'px';
            node.style.top = content.top + 'px';
            node.style.width = content.width + 'px';
            node.style.height = content.height + 'px';
        });
        applyZoom(boxW, boxH);
        const dpr = Math.min(window.devicePixelRatio, 2);
        const res = Math.min(dpr * zs, 4096 / Math.max(content.width, content.height));
        canvas.width = Math.round(content.width * res);
        canvas.height = Math.round(content.height * res);
        ghostCanvas.width = canvas.width;
        ghostCanvas.height = canvas.height;
        ctx.setTransform(res, 0, 0, res, 0, 0);
        draw();
    }
    function applyZoom(W = frameEl.clientWidth, H = frameEl.clientHeight) {
        if (!zoomRegion) {
            zs = 1;
            zoomLayer.style.transform = '';
            zoomLayer.style.removeProperty('--unzoom');
            zoomReset.hidden = true;
            frameEl.classList.remove('is-zoomed');
            return;
        }
        const [x0, y0, x1, y1] = zoomRegion;
        const cw = content.width, ch = content.height;
        zs = Math.max(1, Math.min(8, W / ((x1 - x0) * cw), H / ((y1 - y0) * ch)));
        // Centre the box, then keep the picture's edges from coming inside the frame.
        const fit = (size, offset, frame, centre) => {
            const scaled = zs * size;
            if (scaled <= frame) return (frame - scaled) / 2 - zs * offset;
            const t = frame / 2 - zs * (offset + centre * size);
            return Math.min(-zs * offset, Math.max(frame - scaled - zs * offset, t));
        };
        const tx = fit(cw, content.left, W, (x0 + x1) / 2);
        const ty = fit(ch, content.top, H, (y0 + y1) / 2);
        zoomLayer.style.transform = `translate(${tx}px, ${ty}px) scale(${zs})`;
        zoomLayer.style.setProperty('--unzoom', String(1 / zs));
        zoomReset.hidden = false;
        zoomReset.querySelector('span').textContent = `${zs.toFixed(1)}× · Reset zoom`;
        frameEl.classList.add('is-zoomed');
    }
    function setZoom(region) {
        zoomRegion = region;
        layout();
    }
    zoomReset.addEventListener('click', () => { emitNav(); setZoom(null); });
    canvas.addEventListener('dblclick', () => { if (zoomRegion && !tool) setZoom(null); });
    new ResizeObserver(layout).observe(frameEl);
    video.addEventListener('loadedmetadata', () => {
        if (trimStart() && video.currentTime < trimStart() - 0.01) video.currentTime = trimStart();
        layout(); renderTimeline(); updateTime();
    });

    // Drawing ------------------------------------------------------------------------------------
    const shownAt = (m, t) => t >= m.t - 0.12 && t <= (m.t2 !== undefined ? m.t2 + 0.12 : m.t + (m.hold || 1.6));
    function visibleMarks() {
        const t = video.currentTime;
        return marks().filter(m => (m.id === selected && video.paused && Math.abs(t - m.t) < 0.5) || shownAt(m, t));
    }
    function px(point) { return [point[0] * content.width, point[1] * content.height]; }
    function drawShape(shape, color, active) {
        color = shape.color || color;
        const width = shape.width || 2.5;
        ctx.lineWidth = (active ? LINE_WIDTH + 0.5 : LINE_WIDTH) / zs;
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        if (shape.type === 'text' && shape.pts.length) {
            const [x, y] = px(shape.pts[0]);
            ctx.font = `700 ${(13 + width * 2) / zs}px Inter, system-ui, sans-serif`;
            ctx.textBaseline = 'middle';
            ctx.lineWidth = 4 / zs;
            ctx.strokeStyle = 'rgba(0, 0, 0, 0.75)';
            ctx.strokeText(shape.text || '', x, y);
            ctx.fillText(shape.text || '', x, y);
            if (active) { const w = ctx.measureText(shape.text || '').width; ctx.lineWidth = 1.5 / zs; ctx.strokeStyle = color; ctx.strokeRect(x - 4 / zs, y - 14 / zs, w + 8 / zs, 28 / zs); }
            return;
        }
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.setLineDash([]);
        const pts = shape.pts.map(px);
        if (shape.type === 'rect' && pts.length >= 2) {
            const [a, b] = pts;
            ctx.shadowColor = 'rgba(0,0,0,0.45)'; ctx.shadowBlur = 2;
            ctx.strokeRect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
            ctx.shadowBlur = 0;
        } else if (shape.type === 'arrow' && pts.length >= 2) {
            const [a, b] = pts;
            const angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
            const size = 14;
            ctx.shadowColor = 'rgba(0,0,0,0.45)'; ctx.shadowBlur = 2;
            ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(b[0], b[1]);
            ctx.lineTo(b[0] - size * Math.cos(angle - 0.45), b[1] - size * Math.sin(angle - 0.45));
            ctx.lineTo(b[0] - size * Math.cos(angle + 0.45), b[1] - size * Math.sin(angle + 0.45));
            ctx.closePath(); ctx.fill();
            ctx.shadowBlur = 0;
        } else if (shape.type === 'pen' && pts.length) {
            ctx.shadowColor = 'rgba(0,0,0,0.45)'; ctx.shadowBlur = 2;
            ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
            pts.slice(1).forEach(p => ctx.lineTo(p[0], p[1]));
            ctx.stroke();
            ctx.shadowBlur = 0;
        } else if (shape.type === 'point' && pts.length) {
            const [a] = pts;
            ctx.beginPath(); ctx.arc(a[0], a[1], 9, 0, Math.PI * 2); ctx.stroke();
            ctx.beginPath(); ctx.arc(a[0], a[1], 3, 0, Math.PI * 2); ctx.fill();
        }
    }
    function draw() {
        ctx.clearRect(0, 0, content.width, content.height);
        const all = marks();
        const shown = visibleMarks();
        labelsEl.innerHTML = '';
        shown.forEach(mark => {
            const active = mark.id === selected;
            const color = active ? '#ff3fa4' : '#ff6fbd';
            mark.shapes.forEach(shape => drawShape(shape, color, active));
            const index = all.indexOf(mark) + 1;
            const label = el('button', 'rv-mark-label' + (active ? ' active' : ''), `<span class="rv-anno-num">${index}</span><span>${escapeHTML(mark.label || 'Mark ' + index)}</span>`);
            label.type = 'button';
            label.title = 'Click to select · drag to move this label';
            placeLabel(label, mark, mark.shapes[0]?.pts?.[0] || [0.04, 0.1], () => { select(mark.id); root.dispatchEvent(new CustomEvent('rv-focus-annotation', { detail: mark.id, bubbles: true })); });
            labelsEl.append(label);
        });
        // Marks broadcast by a live-session presenter, in gold.
        const t = video.currentTime;
        // Everyone else's marks in a live session, in their own colours with their names.
        othersMarks.filter(m => shownAt(m, t)).forEach(mark => {
            (mark.shapes || []).forEach(shape => drawShape(shape, mark.who?.color || '#7fd0ff', false));
            const label = el('span', 'rv-mark-label remote', `<span>${escapeHTML(mark.who?.name || 'Guest')}${mark.label ? ': ' + escapeHTML(mark.label) : ''}</span>`);
            label.title = 'Drag to move this label out of the way (only on your screen)';
            placeLabel(label, mark, mark.shapes?.[0]?.pts?.[0] || [0.04, 0.3], null);
            label.style.borderColor = mark.who?.color || '#7fd0ff';
            labelsEl.append(label);
        });
        remoteHere().filter(m => shownAt(m, t)).forEach((mark, index) => {
            (mark.shapes || []).forEach(shape => drawShape(shape, '#e0a020', false));
            const label = el('span', 'rv-mark-label remote', `<span class="rv-anno-num">${index + 1}</span><span>${escapeHTML(mark.by || remoteName)}: ${escapeHTML(mark.label || 'Mark ' + (index + 1))}</span>`);
            label.title = 'Drag to move this label out of the way (only on your screen)';
            placeLabel(label, mark, mark.shapes?.[0]?.pts?.[0] || [0.04, 0.2], null);
            label.style.borderColor = '#a86e00';
            label.style.color = '#5c3d00';
            labelsEl.append(label);
        });
        if (drawing) drawShape(drawing, '#ff3fa4', true);
    }
    // Mark labels can be dragged off whatever they cover. Your own label's spot is saved with the mark
    // ("labelAt", 0-1 across the picture) so everyone sees it there; other people's labels move only on
    // your screen. Labels are rebuilt on every draw, so the drag listens on the window.
    const labelSpots = new Map();   // mark id -> [x, y]: while dragging, and for other people's labels
    const clamp01 = v => Math.min(Math.max(v, 0), 1);
    function labelPoint(mark, fallback) { return labelSpots.get(mark.id) || mark.labelAt || fallback; }
    function placeLabel(label, mark, fallback, onTap) {
        const [x, y] = px(labelPoint(mark, fallback));
        label.style.left = Math.min(Math.max(x, 8), content.width - 30) + 'px';
        label.style.top = Math.max(y, 28) + 'px';
        label.classList.add('draggable');
        label.addEventListener('pointerdown', event => dragLabel(event, mark, fallback, onTap));
    }
    function dragLabel(event, mark, fallback, onTap) {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        const rect = canvas.getBoundingClientRect();
        const start = labelPoint(mark, fallback);
        const x0 = event.clientX, y0 = event.clientY;
        let moved = false;
        const move = ev => {
            if (!moved && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 4) return;
            moved = true;
            labelSpots.set(mark.id, [clamp01(start[0] + (ev.clientX - x0) / rect.width), clamp01(start[1] + (ev.clientY - y0) / rect.height)]);
            draw();
        };
        const up = () => {
            removeEventListener('pointermove', move);
            removeEventListener('pointerup', up);
            removeEventListener('pointercancel', up);
            if (!moved) { onTap?.(); return; }
            if (!onTap) return;   // someone else's label: keep the spot for this session only
            const at = labelSpots.get(mark.id).map(v => +v.toFixed(4));
            labelSpots.delete(mark.id);
            store.update(item.id, entry => { const target = entry.annotations.find(a => a.id === mark.id); if (target) target.labelAt = at; });
            emitChange();
        };
        addEventListener('pointermove', move);
        addEventListener('pointerup', up);
        addEventListener('pointercancel', up);
    }
    let remoteAll = [];
    let remoteName = 'Presenter';
    const remoteHere = () => remoteAll.filter(a => (a.clip || '') === (clip.id || ''));
    function setRemote(list, name) {
        remoteAll = (list || []).filter(a => a.kind === 'mark' && (a.source || '') === sourceKey);
        remoteName = name || 'Presenter';
        renderTimeline();
        draw();
    }
    // A presenter's (or live presenter's) mark: open its clip, stop at its moment so its label shows.
    async function jumpToMark(mark) {
        if ((mark.clip || '') !== (clip.id || '')) await setClip(mark.clip || '');
        stopReverse();
        video.pause();
        video.currentTime = mark.t;
        lastT = mark.t;
        renderTimeline();
        draw();
        root.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
    let locked = false;
    function setLocked(value) {
        locked = !!value;
        root.classList.toggle('rv-locked', locked);
        if (locked && tool) setTool(tool);
    }
    function normalized(event) {
        const rect = canvas.getBoundingClientRect();
        return [Math.min(Math.max((event.clientX - rect.left) / rect.width, 0), 1), Math.min(Math.max((event.clientY - rect.top) / rect.height, 0), 1)].map(v => +v.toFixed(4));
    }
    let tapAt = null;
    canvas.addEventListener('pointerdown', event => {
        if (event.button !== 0) return;
        if (!tool) { tapAt = { x: event.clientX, y: event.clientY }; return; }
        event.preventDefault();
        if (tool === 'zoom') { startZoomBox(event); return; }
        video.pause();
        try { canvas.setPointerCapture(event.pointerId); } catch { /* pointer already released */ }
        const p = normalized(event);
        if (tool === 'erase') { erasing = p; eraseAt(p, p); return; }
        if (tool === 'text') { openTextInput(p); return; }
        drawing = { type: tool, pts: tool === 'point' ? [p] : [p, p], color: penColor, width: penWidth };
        draw();
    });
    function startZoomBox(event) {
        const frame = frameEl.getBoundingClientRect();
        const x0 = event.clientX, y0 = event.clientY;
        const a = normalized(event);
        const show = ev => {
            const left = Math.min(x0, ev.clientX) - frame.left, top = Math.min(y0, ev.clientY) - frame.top;
            Object.assign(zoomBox.style, { left: left + 'px', top: top + 'px', width: Math.abs(ev.clientX - x0) + 'px', height: Math.abs(ev.clientY - y0) + 'px' });
            zoomBox.hidden = false;
        };
        const move = ev => show(ev);
        const up = ev => {
            removeEventListener('pointermove', move);
            removeEventListener('pointerup', up);
            removeEventListener('pointercancel', up);
            zoomBox.hidden = true;
            if (ev.type === 'pointercancel' || Math.abs(ev.clientX - x0) < 10 || Math.abs(ev.clientY - y0) < 10) return;
            const b = normalized(ev);
            const x = [Math.min(a[0], b[0]), Math.max(a[0], b[0])], y = [Math.min(a[1], b[1]), Math.max(a[1], b[1])];
            if (x[1] - x[0] < 0.01 || y[1] - y[0] < 0.01) return;
            emitNav();
            setTool('zoom');   // the tool turns off; clicks play and pause again
            setZoom([x[0], y[0], x[1], y[1]]);
        };
        addEventListener('pointermove', move);
        addEventListener('pointerup', up);
        addEventListener('pointercancel', up);
    }
    const textInput = root.querySelector('.rv-text-input');
    let textAt = null;
    function openTextInput(p) {
        textAt = p;
        textInput.hidden = false;
        textInput.value = '';
        const box = canvas.getBoundingClientRect(), frame = frameEl.getBoundingClientRect();
        textInput.style.left = (box.left - frame.left + p[0] * box.width) + 'px';
        textInput.style.top = (box.top - frame.top + p[1] * box.height - 14) + 'px';
        textInput.style.color = penColor;
        textInput.focus();
    }
    function closeTextInput(commit) {
        if (textInput.hidden) return;
        const text = textInput.value.trim();
        textInput.hidden = true;
        if (commit && text && textAt) commitShape({ type: 'text', pts: [textAt], text, color: penColor, width: penWidth });
        textAt = null;
    }
    textInput.addEventListener('keydown', event => {
        event.stopPropagation();
        if (event.key === 'Enter') closeTextInput(true);
        if (event.key === 'Escape') closeTextInput(false);
    });
    textInput.addEventListener('blur', () => closeTextInput(true));
    toolsEl.querySelectorAll('[data-color]').forEach(swatch => swatch.addEventListener('click', () => {
        penColor = swatch.dataset.color;
        toolsEl.querySelectorAll('[data-color]').forEach(b => b.classList.toggle('active', b === swatch));
    }));
    // The overlay sits above the video, so a plain click on the picture toggles playback here.
    canvas.addEventListener('pointerup', event => {
        if (!tapAt || event.button !== 0) return;
        const moved = Math.hypot(event.clientX - tapAt.x, event.clientY - tapAt.y);
        tapAt = null;
        if (moved <= 5 && !tool && !locked) togglePlay();
    });
    canvas.addEventListener('pointermove', event => {
        if (erasing) { const p = normalized(event); eraseAt(erasing, p); erasing = p; return; }
        if (!drawing) return;
        const p = normalized(event);
        if (drawing.type === 'pen') {
            const last = drawing.pts[drawing.pts.length - 1];
            if (Math.hypot(p[0] - last[0], p[1] - last[1]) > 0.004) drawing.pts.push(p);
        } else if (drawing.type !== 'point') drawing.pts[1] = p;
        draw();
    });
    function finishDrawing(event) {
        if (!drawing) return;
        const shape = drawing;
        drawing = null;
        if (shape.type !== 'point' && shape.type !== 'pen') {
            const [a, b] = shape.pts;
            if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 0.01) { draw(); return; }
        }
        commitShape(shape);
    }
    canvas.addEventListener('pointerup', finishDrawing);
    canvas.addEventListener('pointercancel', () => { drawing = null; erasing = false; draw(); });
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(type => canvas.addEventListener(type, () => { erasing = false; }));
    // Eraser: removes any of your own drawings within a few pixels of the pointer.
    let erasing = false;
    function shapeDistance(shape, x, y) {
        const pts = (shape.pts || []).map(px);
        if (!pts.length) return Infinity;
        if (shape.type === 'text') {
            ctx.font = `700 ${(13 + (shape.width || 2.5) * 2) / zs}px Inter, system-ui, sans-serif`;
            const w = ctx.measureText(shape.text || '').width;
            const [tx, ty] = pts[0];
            const dx = Math.max(tx - x, 0, x - (tx + w));
            const dy = Math.max(ty - 12 / zs - y, 0, y - (ty + 12 / zs));
            return Math.hypot(dx, dy);
        }
        if (shape.type === 'rect' && pts.length >= 2) {
            const [a, b] = pts;
            const c = [[a[0], a[1]], [b[0], a[1]], [b[0], b[1]], [a[0], b[1]], [a[0], a[1]]];
            return Math.min(...c.slice(1).map((q, i) => segDistance(c[i], q, x, y)));
        }
        if (pts.length === 1) return Math.hypot(pts[0][0] - x, pts[0][1] - y) - 9;
        return Math.min(...pts.slice(1).map((q, i) => segDistance(pts[i], q, x, y)));
    }
    function segDistance(a, b, x, y) {
        const vx = b[0] - a[0], vy = b[1] - a[1];
        const len = vx * vx + vy * vy;
        const t = len ? Math.max(0, Math.min(1, ((x - a[0]) * vx + (y - a[1]) * vy) / len)) : 0;
        return Math.hypot(a[0] + t * vx - x, a[1] + t * vy - y);
    }
    // Erases along the pointer's path from a to b, so a quick swipe catches everything it crosses.
    function eraseAt(a, b) {
        const [ax, ay] = px(a), [bx, by] = px(b);
        const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / (4 / zs)));
        const samples = Array.from({ length: steps + 1 }, (_, i) => [ax + (bx - ax) * i / steps, ay + (by - ay) * i / steps]);
        const hits = [];
        visibleMarks().forEach(mark => mark.shapes.forEach((shape, i) => { if (samples.some(([x, y]) => shapeDistance(shape, x, y) <= 12 / zs)) hits.push([mark.id, i]); }));
        if (!hits.length) return;
        store.update(item.id, entry => {
            hits.sort((a, b) => b[1] - a[1]).forEach(([id, i]) => {
                const mark = entry.annotations.find(a => a.id === id);
                if (mark) mark.shapes.splice(i, 1);
            });
            // A mark with nothing left on it and no words goes too.
            new Set(hits.map(h => h[0])).forEach(id => {
                const index = entry.annotations.findIndex(a => a.id === id);
                const mark = entry.annotations[index];
                if (mark && !mark.shapes.length && !mark.label && !mark.note && mark.t2 === undefined) entry.annotations.splice(index, 1);
            });
        });
        draw();
    }
    function commitShape(shape) {
        const t = +video.currentTime.toFixed(2);
        const existing = marks().find(m => m.id === selected && Math.abs(m.t - t) < 0.05);
        if (existing) {
            store.update(item.id, entry => { entry.annotations.find(a => a.id === existing.id).shapes.push(shape); });
        } else {
            const mark = { id: uid(), kind: 'mark', ...markMeta(), t, label: '', note: '', shapes: [shape] };
            store.update(item.id, entry => entry.annotations.push(mark));
            guide.done('draw');
            selected = mark.id;
            root.dispatchEvent(new CustomEvent('rv-focus-annotation', { detail: mark.id, bubbles: true }));
        }
        draw();
    }
    function setTool(next) {
        tool = tool === next ? null : next;
        toolsEl.querySelectorAll('[data-tool]').forEach(b => b.classList.toggle('active', b.dataset.tool === tool));
        frameEl.classList.toggle('mode-draw', !!tool && tool !== 'erase' && tool !== 'zoom');
        frameEl.classList.toggle('mode-erase', tool === 'erase');
        frameEl.classList.toggle('mode-zoom', tool === 'zoom');
        hintEl.hidden = !tool;
        hintEl.textContent = { pen: 'Draw on the frame', text: 'Click where the note should go, type, then Enter', erase: 'Drag over a drawing to erase it', zoom: 'Drag a box over the part to zoom into' }[tool] || '';
        if (tool && tool !== 'zoom') video.pause();
    }
    toolsEl.querySelectorAll('[data-tool]').forEach(button => button.addEventListener('click', () => setTool(button.dataset.tool)));
    // Small screens show only the pencil until it is tapped, so the tools do not cover the picture.
    const toolsToggle = toolsEl.querySelector('.rv-tools-toggle');
    toolsToggle.addEventListener('click', () => {
        const open = !toolsEl.classList.contains('open');
        toolsEl.classList.toggle('open', open);
        toolsToggle.setAttribute('aria-expanded', String(open));
        if (!open && tool) setTool(tool);   // folding the tools away stops drawing
    });
    toolsEl.querySelector('[data-action="undo"]').addEventListener('click', () => {
        const mark = marks().find(m => m.id === selected) || visibleMarks().slice(-1)[0];
        if (!mark) return;
        store.update(item.id, entry => {
            const target = entry.annotations.find(a => a.id === mark.id);
            target.shapes.pop();
            if (!target.shapes.length && !target.label && !target.note) entry.annotations.splice(entry.annotations.indexOf(target), 1);
        });
    });
    root.querySelector('.rv-flag').addEventListener('click', () => {
        video.pause();
        const mark = { id: uid(), kind: 'mark', ...markMeta(), t: +video.currentTime.toFixed(2), label: '', note: '', shapes: [] };
        store.update(item.id, entry => entry.annotations.push(mark));
        selected = mark.id;
        root.dispatchEvent(new CustomEvent('rv-focus-annotation', { detail: mark.id, bubbles: true }));
    });

    // Transport ----------------------------------------------------------------------------------
    function updateTime() {
        const duration = video.duration || 0;
        timeEl.innerHTML = `${relTime(video.currentTime)} <small>/ ${fmtTime(duration ? trimSpan() : 0)}</small>`;
        frameEl2.textContent = `f ${Math.round(video.currentTime * fps())}`;
        const fraction = duration ? Math.min(1, Math.max(0, trimFrac(video.currentTime))) : 0;
        fill.style.width = (fraction * 100) + '%';
        head.style.left = (fraction * 100) + '%';
    }
    function renderTimeline() {
        track.querySelectorAll('.rv-timeline-marker, .rv-timeline-stop, .rv-timeline-range, .rv-timeline-in').forEach(m => m.remove());
        const duration = video.duration || 0;
        if (!duration) return;
        const inside = t => t >= trimStart() - 0.01 && t <= trimEnd() + 0.01;
        const pos = t => (Math.min(1, Math.max(0, trimFrac(t))) * 100) + '%';
        stops().filter(inside).forEach(at => {
            const stopEl = el('button', 'rv-timeline-stop');
            stopEl.type = 'button';
            stopEl.title = `Stop point at ${relTime(at)}`;
            stopEl.style.left = pos(at);
            stopEl.addEventListener('click', event => { event.stopPropagation(); emitNav(); video.pause(); video.currentTime = at; lastT = at; showStopBanner(at); });
            track.append(stopEl);
        });
        marks().filter(m => m.t2 !== undefined && m.t2 >= trimStart() && m.t <= trimEnd()).forEach(mark => {
            const bar = el('span', 'rv-timeline-range' + (mark.id === selected ? ' active' : ''));
            bar.style.left = pos(mark.t);
            bar.style.width = (Math.max(Math.min(mark.t2, trimEnd()) - Math.max(mark.t, trimStart()), 0.05) / trimSpan() * 100) + '%';
            track.append(bar);
        });
        if (rangeIn !== null) {
            const pending = el('span', 'rv-timeline-in');
            pending.style.left = pos(rangeIn);
            pending.title = `Range starts at ${relTime(rangeIn)}. Press Out to finish it.`;
            track.append(pending);
        }
        remoteHere().forEach(mark => {
            if (!inside(mark.t)) return;
            const marker = el('button', 'rv-timeline-marker is-remote');
            marker.type = 'button';
            marker.title = `${mark.by || remoteName}: ${mark.label || 'Mark'} at ${relTime(mark.t)}`;
            marker.style.left = pos(mark.t);
            marker.addEventListener('click', event => { event.stopPropagation(); emitNav(); jumpToMark(mark); });
            track.append(marker);
        });
        marks().forEach((mark, index) => {
            if (!inside(mark.t)) return;
            const marker = el('button', 'rv-timeline-marker' + (mark.id === selected ? ' active' : ''), String(index + 1));
            marker.type = 'button';
            marker.title = `${mark.label || 'Mark ' + (index + 1)} at ${relTime(mark.t)}`;
            marker.style.left = pos(mark.t);
            marker.addEventListener('click', event => { event.stopPropagation(); jumpTo(mark.id); root.dispatchEvent(new CustomEvent('rv-focus-annotation', { detail: mark.id, bubbles: true })); });
            track.append(marker);
        });
    }
    function seekFraction(event) {
        const rect = track.getBoundingClientRect();
        const fraction = Math.min(Math.max((event.clientX - rect.left) / rect.width, 0), 1);
        if (video.duration) video.currentTime = trimStart() + fraction * trimSpan();
    }
    let scrubbing = false;
    track.addEventListener('pointerdown', event => { if (event.target.closest('.rv-timeline-marker, .rv-timeline-stop')) return; scrubbing = true; track.setPointerCapture(event.pointerId); video.pause(); seekFraction(event); });
    track.addEventListener('pointermove', event => { if (scrubbing) seekFraction(event); });
    track.addEventListener('pointerup', () => { scrubbing = false; });
    function togglePlay() { if (isPicture(clip)) return; if (video.paused) video.play(); else video.pause(); }
    playBtn.addEventListener('click', () => { stopReverse(); togglePlay(); });
    video.addEventListener('play', () => { guide.done('play'); playBtn.innerHTML = icon('pause'); refreshIcons(); if (tool) setTool(tool); tick(); });
    video.addEventListener('pause', () => { playBtn.innerHTML = icon('play'); refreshIcons(); updateTime(); draw(); });
    video.addEventListener('seeked', () => { updateTime(); draw(); });
    ['play', 'pause', 'seeked', 'ratechange'].forEach(type => video.addEventListener(type, emitChange));
    video.addEventListener('timeupdate', () => { if (!video.paused) emitChange(); });
    video.addEventListener('timeupdate', () => { if (video.paused) { updateTime(); draw(); } });
    function step(frames) { if (isPicture(clip)) return; stopReverse(); video.pause(); video.currentTime = Math.max(trimStart(), Math.min(trimEnd(), video.currentTime + frames / fps())); }

    // Ranges and looping ---------------------------------------------------------------------------
    const loopBtn = root.querySelector('[data-action="loop"]');
    function setIn() { rangeIn = +video.currentTime.toFixed(2); renderTimeline(); toast(`Range starts at ${relTime(rangeIn)}. Move on and press Out.`, 1800); }
    function setOut() {
        const t = +video.currentTime.toFixed(2);
        if (rangeIn === null) { toast('Press In at the start of the stretch first.', 1800); return; }
        const [a, b] = rangeIn < t ? [rangeIn, t] : [t, rangeIn];
        rangeIn = null;
        if (b - a < 0.05) { renderTimeline(); return; }
        video.pause();
        const mark = { id: uid(), kind: 'mark', ...markMeta(), t: a, t2: b, label: '', note: '', shapes: [] };
        store.update(item.id, entry => entry.annotations.push(mark));
        guide.done('range');
        selected = mark.id;
        root.dispatchEvent(new CustomEvent('rv-focus-annotation', { detail: mark.id, bubbles: true }));
    }
    function selectedRange() { const m = marks().find(x => x.id === selected); return m && m.t2 !== undefined ? m : null; }
    root.querySelector('[data-action="in"]').addEventListener('click', setIn);
    root.querySelector('[data-action="out"]').addEventListener('click', setOut);
    loopBtn.addEventListener('click', () => {
        looping = !looping;
        loopBtn.classList.toggle('active', looping);
        const range = selectedRange();
        if (looping && !range) toast('Select a range in the notes list (or make one with In and Out) to loop it.', 2400);
        if (looping && range && (video.currentTime < range.t || video.currentTime > range.t2)) video.currentTime = range.t;
    });
    function checkLoop() {
        const range = looping ? selectedRange() : null;
        if (range && !video.paused && video.currentTime >= range.t2) video.currentTime = range.t;
    }
    video.addEventListener('timeupdate', checkLoop);

    // Ghost frames: faint copies of the frames before (blue) and after (orange) the paused frame ------
    const ghostBtn = root.querySelector('[data-action="ghost"]');   // removed from the bar; kept for later
    const ghosts = [-1, 1].map(() => { const g = document.createElement('video'); g.muted = true; g.preload = 'auto'; g.playsInline = true; return g; });
    const ghostTmp = document.createElement('canvas');
    function ghostSources() { ghosts.forEach(g => { if (g.src !== video.currentSrc && video.currentSrc) g.src = video.currentSrc; }); }
    function clearGhosts() { ghostCtx.clearRect(0, 0, ghostCanvas.width, ghostCanvas.height); }
    let ghostToken = 0;
    async function renderGhosts() {
        clearGhosts();
        if (!ghostStep || !video.paused || !video.videoWidth) return;
        const token = ++ghostToken;
        ghostSources();
        const offsets = [-ghostStep, ghostStep];
        const tints = ['rgba(0, 150, 255, 0.45)', 'rgba(255, 140, 0, 0.45)'];
        await Promise.all(ghosts.map((g, i) => new Promise(resolve => {
            const target = Math.max(0, Math.min((video.duration || 0) - 0.01, video.currentTime + offsets[i] / fps()));
            const done = () => resolve();
            if (g.readyState >= 1 && Math.abs(g.currentTime - target) < 0.001) { done(); return; }
            g.addEventListener('seeked', done, { once: true });
            const go = () => { g.currentTime = target; };
            if (g.readyState >= 1) go(); else g.addEventListener('loadedmetadata', go, { once: true });
            setTimeout(done, 1500);
        })));
        if (token !== ghostToken || !video.paused) return;
        clearGhosts();
        ghostTmp.width = ghostCanvas.width;
        ghostTmp.height = ghostCanvas.height;
        const tctx = ghostTmp.getContext('2d');
        ghosts.forEach((g, i) => {
            if (g.readyState < 2) return;
            tctx.globalCompositeOperation = 'source-over';
            tctx.clearRect(0, 0, ghostTmp.width, ghostTmp.height);
            drawRotated(tctx, g, ghostTmp.width, ghostTmp.height);
            tctx.globalCompositeOperation = 'source-atop';
            tctx.fillStyle = tints[i];
            tctx.fillRect(0, 0, ghostTmp.width, ghostTmp.height);
            ghostCtx.globalAlpha = 0.42;
            ghostCtx.drawImage(ghostTmp, 0, 0);
            ghostCtx.globalAlpha = 1;
        });
    }
    ghostBtn?.addEventListener('click', () => {
        ghostStep = GHOST_STEPS[(GHOST_STEPS.indexOf(ghostStep) + 1) % GHOST_STEPS.length];
        ghostBtn.classList.toggle('active', ghostStep > 0);
        ghostBtn.querySelector('span').textContent = ghostStep ? `Ghost ±${ghostStep}f` : 'Ghost';
        if (ghostStep) toast(`Ghost frames: ${ghostStep} frames before (blue) and after (orange)`, 1800);
        renderGhosts();
    });
    video.addEventListener('seeked', () => renderGhosts());
    video.addEventListener('pause', () => renderGhosts());
    video.addEventListener('play', clearGhosts);

    // J / K / L: back, pause, forward (press again to go faster) ------------------------------------
    function stopReverse() { if (reverseTimer) { clearInterval(reverseTimer.id); reverseTimer = null; root.classList.remove('is-reversing'); } }
    function reverse() {
        video.pause();
        const speed = reverseTimer ? Math.min(reverseTimer.speed * 2, 8) : 1;
        stopReverse();
        root.classList.add('is-reversing');
        reverseTimer = { speed, id: setInterval(() => {
            if (video.currentTime <= 0) { stopReverse(); return; }
            video.currentTime = Math.max(0, video.currentTime - speed * 0.1);
        }, 100) };
        toast(`Playing backwards ×${speed}`, 1000);
    }
    function forward() {
        stopReverse();
        if (video.paused) { video.playbackRate = 1; video.play(); }
        else video.playbackRate = Math.min(video.playbackRate * 2, 4);
    }
    // Arrow keys step one frame even when the video does not have focus (not while typing, and not
    // when the 3D view or a slider has focus: those use the arrows themselves).
    function onPageKey(event) {
        if (!root.isConnected) { document.removeEventListener('keydown', onPageKey); return; }
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || root.contains(event.target)) return;
        if (event.target.closest?.('input, textarea, select, [contenteditable="true"], .rv-viewer, .rv-sweep, [role="slider"], dialog')) return;
        if (!root.offsetParent || locked || isPicture(clip)) return;
        event.preventDefault();
        emitNav();
        step(event.key === 'ArrowLeft' ? -1 : 1);
    }
    document.addEventListener('keydown', onPageKey);
    const muteBtn = root.querySelector('[data-action="mute"]');
    muteBtn.addEventListener('click', () => { video.muted = !video.muted; muteBtn.innerHTML = icon(video.muted ? 'volume-x' : 'volume-2'); refreshIcons(); });
    root.addEventListener('keydown', event => {
        if (event.key === 'Escape' && zoomRegion && !event.target.closest('input, textarea, select')) { setZoom(null); event.preventDefault(); return; }
        if (event.target.closest('input, textarea, select') || locked || isPicture(clip)) return;
        const key = event.key.toLowerCase();
        if (event.key === ' ') { stopReverse(); togglePlay(); event.preventDefault(); }
        else if (event.key === 'ArrowLeft' || event.key === ',') { step(-1); event.preventDefault(); }
        else if (event.key === 'ArrowRight' || event.key === '.') { step(1); event.preventDefault(); }
        else if (key === 'j') { reverse(); event.preventDefault(); }
        else if (key === 'k') { stopReverse(); video.pause(); event.preventDefault(); }
        else if (key === 'l') { forward(); event.preventDefault(); }
        else if (key === 'i') { setIn(); event.preventDefault(); }
        else if (key === 'o') { setOut(); event.preventDefault(); }
    });
    function tick() {
        if (video.paused || video.ended) return;
        updateTime();
        draw();
        requestAnimationFrame(tick);
    }
    function select(id) { selected = id; renderTimeline(); draw(); }
    async function jumpTo(id) {
        let mark = marks().find(m => m.id === id);
        if (!mark) {
            const other = allMarks().find(m => m.id === id);
            if (!other) return;
            await setClip(other.clip || '');
            mark = other;
        }
        video.pause();
        selected = id;
        video.currentTime = mark.t;
        renderTimeline();
        draw();
        root.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
    store.subscribe(() => { if (selected && !marks().some(m => m.id === selected)) selected = null; renderTimeline(); draw(); });
    updateTime();
    syncStopUI();

    function getState() {
        return {
            t: +video.currentTime.toFixed(2), paused: video.paused, rate: video.playbackRate, clip: clip.id, stops: stops(), rotate: rotation(),
            annotations: marks().map(m => ({ id: m.id, kind: 'mark', ...markMeta(), t: m.t, ...(m.t2 !== undefined ? { t2: m.t2 } : {}), ...(m.labelAt ? { labelAt: m.labelAt } : {}), label: m.label, shapes: m.shapes })),
        };
    }
    async function applyState(state) {
        if (!state) return;
        if (state.clip !== undefined && state.clip !== clip.id) { applying = true; try { await setClip(state.clip, true); } finally { applying = false; } }
        if (Array.isArray(state.stops) && JSON.stringify(state.stops) !== JSON.stringify(remoteStops)) { remoteStops = state.stops; renderTimeline(); syncStopUI(); }
        if (Number.isFinite(state.rotate) && state.rotate !== remoteRotate) { remoteRotate = state.rotate; layout(); }
        if (isPicture(clip)) return;   // nothing to play or seek
        applying = true;
        try {
            if (state.paused && Number.isFinite(state.t) && stops().some(st => Math.abs(st - state.t) < 0.06)) showStopBanner(state.t);
            else if (!state.paused) stopBanner.hidden = true;
            if (state.rate && video.playbackRate !== state.rate) video.playbackRate = state.rate;
            if (Number.isFinite(state.t) && Math.abs(video.currentTime - state.t) > 0.4) video.currentTime = state.t;
            if (state.paused && !video.paused) video.pause();
            else if (!state.paused && video.paused) {
                video.play().catch(() => {
                    // Autoplay without a gesture is only allowed muted.
                    video.muted = true;
                    muteBtn.innerHTML = icon('volume-x');
                    refreshIcons();
                    video.play().catch(() => {});
                });
            }
        } finally { applying = false; }
    }
    // Only playback counts as looking on your own: drawing, colours and labels keep a follower in step.
    root.addEventListener('pointerdown', event => { if (event.target.closest('.rv-video-bar, .rv-timeline, .rv-clips') && !event.target.closest('.rv-clips-toggle')) emitNav(); }, { capture: true, passive: true });
    root.addEventListener('keydown', event => {
        if (event.target.closest('input, textarea')) return;
        if ([' ', 'k', 'j', 'l', 'arrowleft', 'arrowright', ',', '.', 'home', 'end'].includes(event.key.toLowerCase())) emitNav();
    }, { capture: true });
    const guide = createGuide({
        host: frameEl, key: policy.isHost() ? 'video-host' : 'video', title: 'Video tools',
        steps: [
            { key: 'play', icon: 'play', title: 'Play and step', text: 'Click the picture or press <kbd>Space</kbd> to play or pause. <kbd>J</kbd> / <kbd>L</kbd> go back / forward, <kbd>,</kbd> and <kbd>.</kbd> step one frame, and the speed menu goes from 0.1× to 2×.', try: 'Play or pause the video' },
            { key: 'draw', icon: 'pencil', title: 'Draw on the frame', text: 'Pick a shape at the top right (box, arrow, pen, point or text) and a colour, then drag on the picture. Everyone in a live session sees it in your colour.', try: 'Draw something on the picture' },
            { key: 'range', icon: 'arrow-right-to-line', title: 'Mark a stretch', text: 'Press <b>In</b> (or <kbd>I</kbd>) where something starts and <b>Out</b> (<kbd>O</kbd>) where it ends. The stretch shows on the timeline and can loop.', try: 'Press In, play a little, press Out' },
            ...(policy.isHost() ? [{ key: 'stop', icon: 'octagon-pause', title: 'Stop points (presenter)', text: 'Pause where the video should stop for discussion and press <b>Add stop</b>. Playback pauses there for everyone. Save them with "Download review file with my stop points" in the Live panel.', try: 'Add a stop point' }] : []),
        ],
    });

    return {
        root, item, jumpTo, select,
        mediaEl: frameEl,
        getState, applyState, setLocked, setRemote,
        jumpToMark,
        // The video tutorial is switched off for now; "clips" is the clip demo (How to swap videos).
        tutorials: () => (item.clipDemo && clips.length > 1 ? ['clips'] : []),
        showTutorial: kind => { if (kind !== 'clips' || !item.clipDemo || clips.length < 2) return false; runClipDemo(); return true; },
        setOthers(list) {
            othersMarks = (list || []).filter(a => a.kind === 'mark' && (a.source || '') === sourceKey && (a.clip || '') === (clip.id || ''));
            draw();
        },
        onChange: cb => changeListeners.add(cb),
        onUserNav: cb => navListeners.add(cb),
        remount() { layout(); },
    };
}

// ---- notes panel -------------------------------------------------------------------------------

function createNotesPanel(item, media) {
    const root = el('div', 'rv-notes');
    root.innerHTML = `
        ${item.problem || item.proposal || item.ask ? `
        <div class="rv-brief">
            ${item.problem ? `<div><h4>What went wrong</h4><p>${escapeHTML(item.problem)}</p></div>` : ''}
            ${item.proposal ? `<div><h4>What we would change</h4><p>${escapeHTML(item.proposal)}</p></div>` : ''}
            ${item.ask ? `<div class="rv-brief-ask"><h4>Our question for you</h4><p>${escapeHTML(item.ask)}</p></div>` : ''}
        </div>
        </div>` : ''}
        ${item.choices ? `
        <div class="rv-choice" role="group" aria-label="${escapeHTML(item.choices.ask)}">
            <h4>${escapeHTML(item.choices.ask)}</h4>
            <div>${item.choices.options.map(o => `<button type="button" data-choice="${escapeHTML(o.key)}">${o.icon ? icon(o.icon) : ''} ${escapeHTML(o.label)}</button>`).join('')}</div>
        </div>` : ''}
        <div class="rv-presenter-slot"></div>
        <label>Your notes<textarea class="rv-note" placeholder="${item.kind === 'video' ? 'Anything you would tell us about this clip…' : 'Anything you would tell us about this design…'}"></textarea></label>
        <div class="rv-anno-head"><span>${item.kind === 'video' ? 'Marks on the video' : item.kind === 'stage' && Object.values(item.sources || {}).some(src => ['video', 'playlist', 'image'].includes(src.kind)) ? 'Pins, drawings and marks' : 'Pins and drawings on the model'} <small class="rv-anno-count"></small></span></div>
        <ol class="rv-anno-list"></ol>`;
    // The presenter's notes from the file. Whatever this browser already has as its own notes (the presenter's
    // own browser, where they were written) is left out, so the presenter does not see everything twice.
    const presenterSlot = root.querySelector('.rv-presenter-slot');
    let presenterKey = null;
    function renderPresenterNotes() {
        const own = store.item(item.id);
        const mine = { ids: new Set((own.annotations || []).map(a => a.id)), note: own.note || '' };
        const html = presenterNoteBlock(item, mine);
        if (html === presenterKey) return;
        presenterKey = html;
        presenterSlot.innerHTML = html;
        refreshIcons();
        presenterSlot.querySelectorAll('[data-mark]').forEach(button => button.addEventListener('click', () => {
            const note = (item.presenterNotes?.annotations || []).find(a => a.id === button.dataset.mark);
            if (!note) return;
            if (note.kind === 'mark') media.jumpToMark?.(note);
            else media.jumpToPin?.(note);
        }));
    }
    if (item.presenterNotes) onStore(renderPresenterNotes);
    const noteEl = root.querySelector('.rv-note');
    const listEl = root.querySelector('.rv-anno-list');
    const countEl = root.querySelector('.rv-anno-count');
    const rows = new Map();
    let activeId = null;

    noteEl.addEventListener('input', () => store.update(item.id, entry => { entry.note = noteEl.value; }));
    root.querySelector('.rv-choice')?.addEventListener('click', event => {
        const button = event.target.closest('[data-choice]');
        if (button) store.update(item.id, entry => { entry.choice = entry.choice === button.dataset.choice ? null : button.dataset.choice; });
    });

    function row(annotation) {
        const li = el('li', 'rv-anno-row');
        li.dataset.id = annotation.id;
        li.innerHTML = `
            <button type="button" class="rv-anno-jump"><span class="rv-anno-num"></span><span class="rv-anno-where"></span></button>
            <input type="text" class="rv-anno-label" placeholder="${annotation.kind === 'mark' ? 'What is happening here?' : 'What is this spot?'}" maxlength="80">
            <button type="button" class="rv-anno-del" title="Delete">${icon('trash-2')}</button>
            <textarea class="rv-anno-note" placeholder="Why does it matter? What would you change?"></textarea>`;
        li.querySelector('.rv-anno-jump').addEventListener('click', () => { media.jumpTo(annotation.id); setActive(annotation.id); });
        li.querySelector('.rv-anno-label').addEventListener('input', event => store.update(item.id, entry => { entry.annotations.find(a => a.id === annotation.id).label = event.target.value; }));
        li.querySelector('.rv-anno-note').addEventListener('input', event => store.update(item.id, entry => { entry.annotations.find(a => a.id === annotation.id).note = event.target.value; }));
        li.querySelector('.rv-anno-del').addEventListener('click', () => store.update(item.id, entry => { entry.annotations = entry.annotations.filter(a => a.id !== annotation.id); }));
        li.addEventListener('focusin', () => { if (activeId !== annotation.id) { media.select(annotation.id); setActive(annotation.id); } });
        return li;
    }
    function setActive(id) {
        activeId = id;
        rows.forEach((li, rowId) => li.classList.toggle('active', rowId === id));
    }
    function render() {
        const entry = store.item(item.id);
        if (document.activeElement !== noteEl) noteEl.value = entry.note;
        root.querySelectorAll('[data-choice]').forEach(button => button.classList.toggle('active', entry.choice === button.dataset.choice));
        const annotations = entry.annotations;
        const wanted = new Set(annotations.map(a => a.id));
        rows.forEach((li, id) => { if (!wanted.has(id)) { li.remove(); rows.delete(id); } });
        annotations.forEach((annotation, index) => {
            let li = rows.get(annotation.id);
            if (!li) { li = row(annotation); rows.set(annotation.id, li); }
            if (listEl.children[index] !== li) listEl.insertBefore(li, listEl.children[index] || null);
            li.querySelector('.rv-anno-num').textContent = index + 1;
            const onModel = annotation.source && item.sources?.[annotation.source] ? (item.sources[annotation.source].label || annotation.source) : 'model';
            let where = annotation.kind === 'mark' ? markWhen(item, annotation) : annotation.kind === 'sketch' ? `drawing on ${onModel}` : `on ${onModel}`;
            if (annotation.value !== undefined) where += ` · ${sweepUnitLabel(item, annotation.value)}`;
            li.querySelector('.rv-anno-where').textContent = where;
            const labelEl = li.querySelector('.rv-anno-label');
            const noteField = li.querySelector('.rv-anno-note');
            if (document.activeElement !== labelEl) labelEl.value = annotation.label || '';
            if (document.activeElement !== noteField) noteField.value = annotation.note || '';
        });
        countEl.textContent = annotations.length ? `(${annotations.length})` : '';
        let empty = listEl.querySelector('.rv-anno-empty');
        if (!annotations.length && !empty) {
            empty = el('li', 'rv-anno-empty', item.kind === 'video' ? 'Use the box, arrow, pen, or point tools on the video, or press "Flag this moment".' : item.kind === 'stage' && Object.values(item.sources || {}).some(src => ['video', 'playlist', 'image'].includes(src.kind)) ? 'Pin or draw on the model, draw on a picture or a paused video frame, or press In and Out to mark a stretch of video.' : 'Use the pin or pencil tool in the viewer.');
            listEl.append(empty);
        } else if (annotations.length && empty) empty.remove();
        refreshIcons();
    }
    store.subscribe(render);
    render();
    media.root.addEventListener('rv-focus-annotation', event => {
        render();
        setActive(event.detail);
        const li = rows.get(event.detail);
        if (!li) return;
        li.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        li.querySelector('.rv-anno-label').focus({ preventScroll: true });
    });
    return { root };
}

// ---- entries -----------------------------------------------------------------------------------

const host = document.getElementById('rv-host');
const entries = [];
function createErrorMedia(item, error) {
    const root = el('div', 'rv-error-media', `<strong>This item could not be shown.</strong><span>${escapeHTML(error?.message || String(error))}</span>`);
    return { root, item, jumpTo() {}, select() {}, remount() {} };
}
function addEntry(item) {
    let media;
    try {
        media = item.kind === 'video' ? createVideoAnnotator(item) : item.kind === 'stage' ? createStageViewer(item) : createModelViewer(item);
    } catch (error) {
        // One broken item (usually no WebGL) must not take the whole page down.
        console.error(`Could not build "${item.title}"`, error);
        media = createErrorMedia(item, error);
    }
    const notes = createNotesPanel(item, media);
    const entry = { item, media, notes };
    entries.push(entry);
    attachPresenterNotes(item, media);
    return entry;
}
// The presenter's notes at the top of the notes column: their note, their video marks (clip, time, label)
// and 3D pins, as buttons that jump there. `mine` = this browser's own notes on the screen, left out.
function presenterNoteBlock(item, mine = { ids: new Set(), note: '' }) {
    const pn = item.presenterNotes;
    if (!pn) return '';
    const clipLabel = mark => {
        const src = item.sources?.[mark.source] || (item.kind === 'playlist' || item.kind === 'video' ? item : null);
        const list = src?.clips || [];
        const at = list.findIndex((c, i) => (c.id || `clip-${i + 1}`) === mark.clip);
        return at >= 0 ? `Video ${at + 1}${list[at].label ? ': ' + list[at].label : ''}` : '';
    };
    const time = t => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
    const modelLabel = pin => {
        const key = pin.source || Object.keys(item.sources || {}).find(k => ['assembly', 'sweep'].includes(item.sources[k].kind));
        return key && item.sources?.[key] ? `3D view: ${item.sources[key].label || key}` : '3D view';
    };
    const all = (pn.annotations || []).filter(a => a.kind === 'mark' || (a.kind === 'pin' && a.camera));
    const shown = all.filter(a => !mine.ids.has(a.id));
    const note = String(pn.note || '').trim();
    const showNote = note && note !== String(mine.note || '').trim();
    if (!showNote && !shown.length) return '';
    let pinNo = 0;
    const row = a => a.kind === 'mark'
        ? `<li><button type="button" data-mark="${escapeHTML(a.id)}" title="Go to this moment"><span class="rv-pm-time">${time(a.t || 0)}</span><span class="rv-pm-text"><b>${escapeHTML(a.label || 'Mark')}</b>${a.note ? ` – ${escapeHTML(a.note)}` : ''}<small>${escapeHTML(clipLabel(a))}</small></span></button></li>`
        : `<li><button type="button" data-mark="${escapeHTML(a.id)}" title="Go to this pin"><span class="rv-pm-time">${icon('map-pin')}</span><span class="rv-pm-text"><b>${escapeHTML(a.label || `Pin ${++pinNo}`)}</b>${a.note ? ` – ${escapeHTML(a.note)}` : ''}<small>${escapeHTML(modelLabel(a))}</small></span></button></li>`;
    return `<div class="rv-presenter-note"><h4>${icon('presentation')} Notes from ${escapeHTML(pn.by || 'the presenter')}</h4>
        ${showNote ? `<p>${escapeHTML(note)}</p>` : ''}
        ${shown.length ? `<ol class="rv-presenter-marks">${shown.map(row).join('')}</ol>` : ''}
    </div>`;
}
// "presenterNotes": { "by", "note", "annotations": [pins and video marks] } on a screen (brought in from the
// presenter's own notes in the editor). Everyone sees them in gold with the presenter's name, on top of any
// live-session presenter marks; notes the presenter still has in this browser are not drawn twice.
function attachPresenterNotes(item, media) {
    const preset = item.presenterNotes;
    if (!preset?.annotations?.length || !media.setRemote) return;
    const by = preset.by || 'Presenter';
    const tagged = preset.annotations.map(a => ({ ...a, by: a.by || by }));
    const setLive = media.setRemote.bind(media);
    let live = { list: [], name: '' };
    const render = () => {
        const mine = new Set((store.item(item.id).annotations || []).map(a => a.id));
        const shown = tagged.filter(a => !mine.has(a.id));
        const ids = new Set(shown.map(a => a.id));
        setLive([...shown, ...live.list.filter(a => !ids.has(a.id))], live.name || by);
    };
    media.setRemote = (list, name) => { live = { list: list || [], name: name || '' }; render(); };
    onStore(render);
    render();
}
function detachAll() {
    entries.forEach(entry => { entry.media.root.remove(); entry.notes.root.remove(); });
    host.replaceChildren();
}
function cardHead(item) {
    return `<div class="rv-card-head"><span class="rv-kind">${icon(KIND_ICON[item.kind])} ${KIND_LABEL[item.kind]}</span><h2>${escapeHTML(item.title)}</h2>${item.context ? `<p>${escapeHTML(item.context)}</p>` : ''}</div>`;
}
// The active layout's navigation, exposed so a live session can drive followers to the presenter's item.
const layout = {
    show: () => {},
    getIndex: () => 0,
    listeners: new Set(),
    notify(index) { this.listeners.forEach(fn => fn(index)); },
};
const layoutSubscriptions = [];
function onStore(fn) { layoutSubscriptions.push(store.subscribe(fn)); fn(); }
function clearLayoutSubscriptions() { layoutSubscriptions.splice(0).forEach(unsubscribe => unsubscribe()); }

// ---- layout A: scroll --------------------------------------------------------------------------

function buildScroll() {
    const page = el('div', 'rv-scroll');
    page.append(el('section', 'rv-hero', `<h2>${escapeHTML(review.title)}</h2><p>${escapeHTML(review.intro)}</p>`));
    entries.forEach(entry => {
        const card = el('article', 'rv-card' + (entry.item.kind === 'video' ? ' is-video' : ''), cardHead(entry.item));
        card.id = 'item-' + entry.item.id;
        const media = el('div', 'rv-media');
        media.append(entry.media.root);
        card.append(media, entry.notes.root);
        page.append(card);
    });
    const bar = el('div', 'rv-progress-bar', `<span class="rv-progress-text"></span><span class="rv-progress-dots"></span>`);
    const share = el('button', 'rv-btn rv-primary', `${icon('link')} Copy link with my notes`);
    share.type = 'button';
    share.addEventListener('click', shareLink);
    bar.append(share);
    const dots = bar.querySelector('.rv-progress-dots');
    entries.forEach(entry => {
        const dot = el('button');
        dot.type = 'button';
        dot.title = entry.item.title;
        dot.addEventListener('click', () => document.getElementById('item-' + entry.item.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
        dots.append(dot);
    });
    page.append(bar);
    host.append(page);
    let scrollIndex = 0;
    layout.show = index => { scrollIndex = index; document.getElementById('item-' + entries[index]?.item.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); layout.notify(index); };
    layout.getIndex = () => scrollIndex;
    onStore(() => {
        const done = entries.filter(entry => store.answered(entry.item.id)).length;
        bar.querySelector('.rv-progress-text').innerHTML = `<strong>${done} of ${entries.length}</strong> items have your input`;
        [...dots.children].forEach((dot, index) => dot.classList.toggle('done', store.answered(entries[index].item.id)));
    });
}

// ---- layout B: studio --------------------------------------------------------------------------

let studioIndex = 0;
function buildStudio() {
    const page = el('div', 'rv-studio');
    page.innerHTML = `
        <aside class="rv-rail"><div class="rv-rail-head"><h2>${escapeHTML(review.title)}</h2><p>${escapeHTML(review.intro)}</p></div><ul class="rv-rail-list"></ul></aside>
        <section class="rv-studio-stage"><div class="rv-stage-bar"><span class="rv-kind"></span><h2></h2><div class="rv-nav"><button type="button" data-nav="-1" title="Previous item">${icon('chevron-left')}</button><button type="button" data-nav="1" title="Next item">${icon('chevron-right')}</button></div></div><div class="rv-studio-media"></div></section>
        <aside class="rv-studio-panel"><p class="rv-context"></p></aside>`;
    const list = page.querySelector('.rv-rail-list');
    const mediaHost = page.querySelector('.rv-studio-media');
    const panel = page.querySelector('.rv-studio-panel');
    entries.forEach((entry, index) => {
        const li = el('li');
        const button = el('button', 'rv-rail-item', `<span class="rv-rail-icon">${icon(KIND_ICON[entry.item.kind])}</span><span><strong>${escapeHTML(entry.item.title)}</strong><small>${KIND_LABEL[entry.item.kind]}</small></span><span class="rv-status"></span>`);
        button.type = 'button';
        button.addEventListener('click', () => show(index));
        li.append(button);
        list.append(li);
    });
    page.querySelectorAll('[data-nav]').forEach(button => button.addEventListener('click', () => show(studioIndex + +button.dataset.nav)));
    function show(index) {
        studioIndex = (index + entries.length) % entries.length;
        const entry = entries[studioIndex];
        entries.forEach(e => { if (e !== entry) { e.media.root.remove(); e.notes.root.remove(); } });
        mediaHost.replaceChildren(entry.media.root);
        panel.querySelector('.rv-context').textContent = entry.item.context || '';
        panel.querySelector('.rv-context').hidden = !entry.item.context;
        panel.append(entry.notes.root);
        page.querySelector('.rv-stage-bar h2').textContent = entry.item.title;
        page.querySelector('.rv-stage-bar .rv-kind').innerHTML = `${icon(KIND_ICON[entry.item.kind])} ${KIND_LABEL[entry.item.kind]}`;
        list.querySelectorAll('.rv-rail-item').forEach((b, i) => b.classList.toggle('active', i === studioIndex));
        entry.media.remount();
        refreshIcons();
        layout.notify(studioIndex);
    }
    layout.show = show;
    layout.getIndex = () => studioIndex;
    host.append(page);
    show(Math.min(studioIndex, entries.length - 1));
    onStore(() => list.querySelectorAll('.rv-status').forEach((dot, i) => dot.classList.toggle('done', store.answered(entries[i].item.id))));
}

// ---- layout C: guided --------------------------------------------------------------------------

let guidedIndex = 0;
function buildGuided() {
    const page = el('div', 'rv-guided');
    page.innerHTML = `
        <div class="rv-guided-head"><button type="button" class="rv-btn rv-toc-toggle" title="Show or hide the list of screens" aria-label="Screens">${icon('list')}</button><span class="rv-guided-step"></span><div><h2></h2><p></p></div>
            <div class="rv-screen-tools">
                <button type="button" class="rv-btn rv-left-toggle" title="Show or hide the interface column" hidden>${icon('panel-left')} <span>Interface</span></button>
                <button type="button" class="rv-btn rv-edit-toggle" title="Edit this screen in the presentation editor" hidden>${icon('pencil')} <span>Edit</span></button>
                <button type="button" class="rv-btn rv-swap-toggle" title="Show how to switch between the videos" hidden>${icon('list-video')} <span>How to swap videos</span></button>
                <button type="button" class="rv-btn rv-move-toggle" title="Show how to turn, move and zoom the 3D view" hidden>${icon('move')} <span>How to move</span></button>
                <button type="button" class="rv-btn rv-notes-toggle" title="Show or hide the notes column">${icon('panel-right')} <span>Notes</span></button>
                <button type="button" class="rv-btn rv-full-toggle" title="Full screen (Esc to leave)">${icon('maximize')} <span>Full screen</span></button>
            </div></div>
        <div class="rv-guided-slot"></div>
        <div class="rv-guided-foot"><button type="button" class="rv-btn rv-guided-back">${icon('chevron-left')} Back</button><div class="rv-guided-dots"></div><button type="button" class="rv-btn rv-primary rv-guided-next">Next ${icon('chevron-right')}</button></div>`;
    const slot = page.querySelector('.rv-guided-slot');
    const dots = page.querySelector('.rv-guided-dots');
    // Screen list on the left (like the editor's): jump to any screen; collapses to give the screen room.
    // Open on wide windows unless you closed it (remembered); a drawer over the page on phones.
    const shell = el('div', 'rv-guided-shell');
    const toc = el('aside', 'rv-toc', `<div class="rv-toc-head"><strong>Screens</strong><button type="button" class="rv-toc-close" title="Hide the list">${icon('panel-left-close')}</button></div><ol class="rv-toc-list"></ol>`);
    const tocList = toc.querySelector('.rv-toc-list');
    const TOC_KEY = 'gap-review-toc';
    const narrowToc = () => matchMedia('(max-width: 900px)').matches;
    function setToc(open, remember = true) {
        shell.classList.toggle('toc-open', open);
        page.querySelector('.rv-toc-toggle').classList.toggle('active', open);
        if (remember && !narrowToc()) { try { localStorage.setItem(TOC_KEY, open ? 'open' : 'closed'); } catch { /* storage off */ } }
    }
    entries.concat([null]).forEach((entry, i) => {
        const li = el('li');
        const button = el('button', 'rv-toc-item', entry
            ? `<span class="rv-toc-num">${i + 1}</span><span class="rv-toc-title">${escapeHTML(entry.item.title)}</span><span class="rv-toc-done" title="You have notes here"></span>`
            : `<span class="rv-toc-num">${icon('clipboard-list')}</span><span class="rv-toc-title">Summary</span>`);
        button.type = 'button';
        button.addEventListener('click', () => { show(i); if (narrowToc()) setToc(false, false); });
        li.append(button);
        tocList.append(li);
    });
    page.querySelector('.rv-toc-toggle').addEventListener('click', () => setToc(!shell.classList.contains('toc-open')));
    toc.querySelector('.rv-toc-close').addEventListener('click', () => setToc(false));
    setToc(!narrowToc() && policy.isHost() && review.screensList !== 'closed' && (() => { try { return localStorage.getItem(TOC_KEY) !== 'closed'; } catch { return true; } })(), false);
    const total = entries.length + 1;
    for (let i = 0; i < total; i++) {
        const dot = el('button');
        dot.type = 'button';
        dot.title = i < entries.length ? entries[i].item.title : 'Summary';
        dot.addEventListener('click', () => show(i));
        dots.append(dot);
    }
    // Notes column on or off (on unless you hid it; remembered in this browser).
    const NOTES_KEY = 'gap-review-notes-hidden';
    const notesBtn = page.querySelector('.rv-notes-toggle');
    function setNotes(shown, remember = true) {
        page.classList.toggle('notes-hidden', !shown);
        notesBtn.classList.toggle('active', shown);
        notesBtn.setAttribute('aria-pressed', String(shown));
        notesBtn.innerHTML = `${icon(shown ? 'panel-right-close' : 'panel-right-open')} <span>${shown ? 'Hide notes' : 'Show notes'}</span>`;
        refreshIcons();
        if (remember) { try { localStorage.setItem(NOTES_KEY, shown ? '0' : '1'); } catch { /* storage off */ } }
    }
    const notesPreferred = () => { try { return localStorage.getItem(NOTES_KEY) !== '1'; } catch { return true; } };
    const notesChosen = {};   // per screen that starts with notes hidden, this visit only
    const currentItem = () => entries[guidedIndex]?.item;
    function notesFor(item) { return item?.notesHidden ? (notesChosen[item.id] ?? false) : notesPreferred(); }
    setNotes(notesPreferred(), false);
    notesBtn.addEventListener('click', () => {
        const shown = page.classList.contains('notes-hidden');
        const item = currentItem();
        if (item?.notesHidden) { notesChosen[item.id] = shown; setNotes(shown, false); } else setNotes(shown);
    });
    // Left column: tool panels from the viewer (the mechanical interface panel) sit here, like the notes on
    // the right. They are moved in from their 3D view and back again when the screen changes.
    const leftBtn = page.querySelector('.rv-left-toggle');
    let left = null;
    const docked = new Set();
    const paneOpen = panel => !panel.rvPane || (!panel.rvPane.hidden && panel.rvPane.isConnected);
    let leftState = '';
    function syncLeft() {
        if (!left) { leftState = ''; page.classList.remove('left-open'); leftBtn.hidden = true; return; }
        // Participants without "Move the interface" do not get the column (the host can allow it live).
        const allowed = !(document.body.dataset.hide || '').split(' ').includes('iface');
        const usable = allowed ? [...docked].filter(paneOpen) : [];
        docked.forEach(panel => { panel.style.display = paneOpen(panel) ? '' : 'none'; });
        const open = usable.some(panel => !panel.hidden);
        const state = `${usable.length}|${open}`;
        if (state === leftState) return;
        leftState = state;
        page.classList.toggle('left-open', open);
        leftBtn.hidden = !usable.length;
        leftBtn.classList.toggle('active', open);
        leftBtn.setAttribute('aria-pressed', String(open));
        leftBtn.innerHTML = `${icon(open ? 'panel-left-close' : 'panel-left-open')} <span>${open ? 'Hide interface' : 'Interface'}</span>`;
        refreshIcons();
    }
    function dockPanels(media) {
        if (!left) return;
        media.querySelectorAll('.rv-iface-panel:not(.is-docked)').forEach(panel => {
            if (docked.has(panel)) return;
            panel.rvPane = panel.parentElement?.closest('.rv-pane') || null;
            panel.classList.add('is-docked');
            left.append(panel);
            docked.add(panel);
        });
        syncLeft();
    }
    function undockAll() {
        docked.forEach(panel => { panel.classList.remove('is-docked'); panel.style.display = ''; panel.rvHome?.append(panel); });
        docked.clear();
    }
    leftBtn.addEventListener('click', () => {
        const open = !page.classList.contains('left-open');
        [...docked].filter(paneOpen).forEach(panel => panel.rvSetOpen?.(open));
        syncLeft();
    });
    let dockWatch = null;
    // "Edit": back to the presentation editor on this screen (presenter link only, "&host"). Inside the
    // editor's Present mode it tells the editor (same site). Anywhere else, including the public site, it
    // opens the editor on this computer (the local preview server, localhost:8131) in a new tab, so a live
    // session in this tab keeps running.
    const editBtn = page.querySelector('.rv-edit-toggle');
    const reviewRef = pageParams.get('review') || '';
    const inEditor = reviewRef.startsWith('draft:') && window.parent !== window;
    const fileRef = /^reviews\/[a-z0-9-]+\.json$/.test(reviewRef);
    const onThisComputer = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
    function syncEditBtn() { editBtn.hidden = !(policy.host && (inEditor || fileRef)); }
    if (!inEditor && !onThisComputer) editBtn.title = 'Open this screen in the presentation editor on this computer (its local server must be running)';
    editBtn.addEventListener('click', () => {
        const id = entries[guidedIndex]?.item.id || '';
        if (document.body.classList.contains('rv-full')) setFull(false);
        if (inEditor) { try { window.parent.postMessage({ type: 'gap-edit-screen', id }, location.origin); return; } catch { /* fall through */ } }
        const base = onThisComputer ? new URL('review-editor.html', location.href).href : 'http://localhost:8131/review-editor.html';
        const url = `${base}?file=${encodeURIComponent(reviewRef)}${id ? `&screen=${encodeURIComponent(id)}` : ''}`;
        if (onThisComputer) {
            // An editor tab already open (it names itself): bring it forward and select this screen there,
            // without reloading it (it may hold unsaved edits). Otherwise open one.
            const tab = window.open('', 'gap-review-editor');
            let isEditor = false;
            try { isEditor = !!tab && /review-editor\.html$/.test(tab.location.pathname); } catch { /* not readable */ }
            if (isEditor) {
                try { new BroadcastChannel('gap-review-editor').postMessage({ type: 'edit-screen', file: reviewRef, id }); } catch { /* old browser */ }
                tab.focus();
            } else if (tab) tab.location.href = url;
            else window.open(url, 'gap-review-editor');
            return;
        }
        window.open(url, 'gap-review-editor');
    });
    syncEditBtn();
    // "How to move" (the 3D movement guide) shows when the tab on screen has a 3D view.
    const moveBtn = page.querySelector('.rv-move-toggle');
    const swapBtn = page.querySelector('.rv-swap-toggle');
    function syncMoveBtn() {
        const media = entries[guidedIndex]?.media;
        const kinds = guidedIndex < entries.length ? (media?.tutorials?.() || []) : [];
        moveBtn.hidden = !kinds.includes('camera');
        swapBtn.hidden = !kinds.includes('clips');
    }
    moveBtn.addEventListener('click', () => entries[guidedIndex]?.media.showTutorial?.('camera'));
    swapBtn.addEventListener('click', () => entries[guidedIndex]?.media.showTutorial?.('clips'));
    new MutationObserver(() => syncLeft()).observe(document.body, { attributes: true, attributeFilter: ['data-hide'] });
    // Full screen: the screen fills the window (and the display, where the browser allows it). Tabs,
    // side by side, drawing, pins and Back / Next all keep working; Esc or the button leaves.
    const fullBtn = page.querySelector('.rv-full-toggle');
    let realFull = false;
    function setFull(on) {
        document.body.classList.toggle('rv-full', on);
        fullBtn.classList.toggle('active', on);
        fullBtn.innerHTML = `${icon(on ? 'minimize' : 'maximize')} <span>${on ? 'Exit full screen' : 'Full screen'}</span>`;
        refreshIcons();
        if (on && !document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => { /* the window still fills */ });
        if (!on && document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    }
    fullBtn.addEventListener('click', () => setFull(!document.body.classList.contains('rv-full')));
    document.addEventListener('fullscreenchange', () => {
        if (document.fullscreenElement) realFull = true;
        else if (realFull) { realFull = false; if (document.body.classList.contains('rv-full')) setFull(false); }
    });
    document.addEventListener('keydown', event => {
        // Where the browser did not go full screen (e.g. inside another app), Esc still leaves.
        if (event.key !== 'Escape' || !document.body.classList.contains('rv-full') || document.fullscreenElement) return;
        if (event.defaultPrevented || event.target.closest?.('input, textarea, select, dialog') || document.querySelector('dialog[open]')) return;
        setFull(false);
    });
    page.querySelector('.rv-guided-back').addEventListener('click', () => show(guidedIndex - 1));
    page.querySelector('.rv-guided-next').addEventListener('click', () => show(guidedIndex + 1));
    let summaryPre = null;
    function show(index) {
        guidedIndex = Math.max(0, Math.min(total - 1, index));
        dockWatch?.disconnect();
        undockAll();
        left = null;
        entries.forEach(e => { e.media.root.remove(); e.notes.root.remove(); });
        slot.replaceChildren();
        summaryPre = null;
        const stepEl = page.querySelector('.rv-guided-step');
        const h2 = page.querySelector('.rv-guided-head h2');
        const p = page.querySelector('.rv-guided-head p');
        if (guidedIndex < entries.length) {
            const entry = entries[guidedIndex];
            stepEl.textContent = `Question ${guidedIndex + 1} of ${entries.length}`;
            h2.textContent = entry.item.title;
            p.textContent = entry.item.context || '';
            const body = el('div', 'rv-guided-body');
            const media = el('div', 'rv-media');
            left = el('aside', 'rv-guided-left');
            media.append(entry.media.root);
            body.append(left, media, entry.notes.root);
            slot.append(body);
            setNotes(notesFor(entry.item), false);
            entry.media.remount();
            // Panels appear when their 3D view is built (first visit to a tab); tabs hide and show panes.
            // (At most once a frame: the viewers change a lot of markup while they work.)
            let queued = false;
            dockWatch = new MutationObserver(() => { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; dockPanels(media); syncMoveBtn(); }); });
            dockWatch.observe(media, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
            new MutationObserver(() => syncLeft()).observe(left, { attributes: true, attributeFilter: ['hidden'], subtree: true });
            dockPanels(media);
            syncMoveBtn();
        } else {
            syncLeft();
            syncMoveBtn();
            stepEl.textContent = 'Done';
            h2.textContent = 'Thank you. Here is everything you marked.';
            p.textContent = 'Copy the link to send it back, or download the file. You can go back and change anything.';
            const summary = el('div', 'rv-guided-summary', `<h3>Review summary</h3><pre></pre><div class="rv-actions"></div>`);
            summaryPre = summary.querySelector('pre');
            summaryPre.textContent = buildSummary(entries.map(e => e.item));
            const actions = summary.querySelector('.rv-actions');
            const link = el('button', 'rv-btn rv-primary', `${icon('link')} Copy link with my notes`);
            link.type = 'button';
            link.addEventListener('click', shareLink);
            const file = el('button', 'rv-btn', `${icon('download')} Download .json`);
            file.type = 'button';
            file.addEventListener('click', downloadReview);
            const copy = el('button', 'rv-btn', `${icon('copy')} Copy text`);
            copy.type = 'button';
            copy.addEventListener('click', () => navigator.clipboard.writeText(summaryPre.textContent).then(() => toast('Summary copied')));
            actions.append(link, file, copy);
            if (review.returnEmail) {
                const mail = el('button', 'rv-btn', `${icon('mail')} Send by email`);
                mail.type = 'button';
                mail.addEventListener('click', emailLink);
                actions.append(mail);
            }
            slot.append(summary);
        }
        page.querySelector('.rv-guided-back').disabled = guidedIndex === 0;
        page.querySelector('.rv-guided-next').hidden = guidedIndex === total - 1;
        page.querySelector('.rv-guided-next').innerHTML = guidedIndex === total - 2 ? `Finish ${icon('check')}` : `Next ${icon('chevron-right')}`;
        [...dots.children].forEach((dot, i) => dot.classList.toggle('active', i === guidedIndex));
        [...tocList.children].forEach((li, i) => { li.firstChild.classList.toggle('active', i === guidedIndex); if (i === guidedIndex) li.firstChild.setAttribute('aria-current', 'step'); else li.firstChild.removeAttribute('aria-current'); });
        refreshIcons();
        layout.notify(guidedIndex);
    }
    layout.show = show;
    layout.getIndex = () => guidedIndex;
    shell.append(toc, page);
    host.append(shell);
    show(Math.min(guidedIndex, total - 1));
    onStore(() => {
        [...dots.children].forEach((dot, i) => dot.classList.toggle('done', i < entries.length && store.answered(entries[i].item.id)));
        [...tocList.children].forEach((li, i) => li.firstChild.classList.toggle('done', i < entries.length && store.answered(entries[i].item.id)));
        if (summaryPre) summaryPre.textContent = buildSummary(entries.map(e => e.item));
    });
}

// ---- mounting ----------------------------------------------------------------------------------

const layouts = { scroll: buildScroll, studio: buildStudio, guided: buildGuided };
let currentLayout = null;
function mount(name) {
    if (!layouts[name]) name = 'scroll';
    currentLayout = name;
    clearLayoutSubscriptions();
    detachAll();
    layouts[name]();
    document.querySelectorAll('#rv-variants [data-variant]').forEach(b => b.classList.toggle('active', b.dataset.variant === name));
    // Only record the layout in the URL while the A/B/C switcher is in use; plain links stay clean.
    const url = new URL(location.href);
    if (document.getElementById('rv-variants').hidden) url.searchParams.delete('layout');
    else url.searchParams.set('layout', name);
    history.replaceState(null, '', url);
    try { localStorage.setItem('gap-design-review-layout', name); } catch { /* ignore */ }
    refreshIcons();
    window.scrollTo(0, 0);
}
document.querySelectorAll('#rv-variants [data-variant]').forEach(button => button.addEventListener('click', () => mount(button.dataset.variant)));

// ---- header actions ----------------------------------------------------------------------------

const topBar = document.querySelector('.rv-top');
function syncTopHeight() { document.documentElement.style.setProperty('--top-h', topBar.offsetHeight + 'px'); }
new ResizeObserver(syncTopHeight).observe(topBar);
syncTopHeight();
const reviewerInput = document.getElementById('rv-reviewer');
reviewerInput.addEventListener('input', () => {
    store.set(data => { data.reviewer = reviewerInput.value; });
    liveSession?.setName(reviewerInput.value.trim() || reviewerInput.placeholder);
});
function wireReview() {
    document.getElementById('rv-title').textContent = review.title;
    document.getElementById('rv-title').classList.remove('rv-pending');
    document.getElementById('rv-subtitle').textContent = review.subtitle || 'Give a Paw';
    document.title = `${review.title} - Give a Paw`;
    // "reviewerName": the name box starts filled in (the reviewer can change it).
    if (!store.data.reviewer && review.reviewerName) store.set(data => { data.reviewer = review.reviewerName; });
    reviewerInput.value = store.data.reviewer || '';
    reviewerInput.placeholder = review.reviewerDefault || 'Your name';
    emailButton.hidden = !review.returnEmail;
}

async function shareLink() {
    const payload = { ...store.data, reviewer: store.data.reviewer || reviewerInput.placeholder };
    const code = await encodeShare(payload);
    const url = new URL(location.href);
    url.hash = 'r=' + code;
    try {
        await navigator.clipboard.writeText(url.toString());
        toast(`Link copied (${Math.round(url.toString().length / 1024 * 10) / 10} KB). Paste it into an email or message.`, 4000);
    } catch {
        prompt('Copy this link:', url.toString());
    }
}
function downloadReview() {
    const name = (store.data.reviewer || 'review').toLowerCase().replace(/[^a-z0-9]+/g, '-');
    download(`give-a-paw-review-${name}-${new Date().toISOString().slice(0, 10)}.json`, new Blob([store.exportJSON()], { type: 'application/json' }));
}
function emailLink() {
    encodeShare(store.data).then(code => {
        const url = new URL(location.href);
        url.hash = 'r=' + code;
        const subject = encodeURIComponent(`${review.title}: notes from ${store.data.reviewer || 'reviewer'}`);
        const body = encodeURIComponent(`My review notes are in this link:\n\n${url}\n`);
        location.href = `mailto:${review.returnEmail}?subject=${subject}&body=${body}`;
    });
}
document.getElementById('rv-share').addEventListener('click', shareLink);
const summaryDialog = document.getElementById('rv-summary-dialog');
const summaryText = document.getElementById('rv-summary-text');
document.getElementById('rv-summary').addEventListener('click', () => {
    summaryText.value = buildSummary(entries.map(e => e.item));
    summaryDialog.showModal();
});
summaryDialog.addEventListener('click', event => { if (event.target === summaryDialog) summaryDialog.close(); });
document.getElementById('rv-copy-summary').addEventListener('click', () => navigator.clipboard.writeText(summaryText.value).then(() => toast('Summary copied')));
document.getElementById('rv-download').addEventListener('click', downloadReview);
document.getElementById('rv-load').addEventListener('click', () => document.getElementById('rv-load-file').click());
document.getElementById('rv-load-file').addEventListener('change', async event => {
    const file = event.target.files[0];
    if (!file) return;
    try {
        const data = JSON.parse(await file.text());
        if (!data.items) throw new Error('Not a review file');
        store.replace(data);
        reviewerInput.value = store.data.reviewer || '';
        summaryText.value = buildSummary(entries.map(e => e.item));
        toast(`Loaded review by ${store.data.reviewer || 'unknown reviewer'}`);
    } catch (error) {
        toast('That file is not a review export.');
        console.error(error);
    }
    event.target.value = '';
});
const emailButton = document.getElementById('rv-email');
emailButton.addEventListener('click', emailLink);
document.getElementById('rv-reset').addEventListener('click', () => {
    if (!confirm('Clear every note, pin, and pick on this page? This cannot be undone.')) return;
    store.reset();
    reviewerInput.value = '';
    summaryDialog.close();
    toast('Review cleared');
});

// Session-only files: a quick way to try your own clips or meshes without editing the manifest.
document.getElementById('rv-add').addEventListener('click', () => document.getElementById('rv-file').click());
function naturalCompare(a, b) { return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }); }
document.getElementById('rv-file').addEventListener('change', event => {
    const files = [...event.target.files];
    event.target.value = '';
    if (!files.length) return;
    const videos = files.filter(f => /\.(mp4|webm|mov|m4v)$/i.test(f.name));
    const meshes = files.filter(f => /\.(glb|gltf|stl|obj)$/i.test(f.name)).sort((a, b) => naturalCompare(a.name, b.name));
    const stamp = Date.now().toString(36);
    videos.forEach((file, index) => addEntry({
        id: `local-video-${stamp}-${index}`, kind: 'video', title: file.name, src: URL.createObjectURL(file),
        context: 'Loaded from your computer for this session only.', question: 'What do you notice?',
    }));
    if (meshes.length === 1) {
        addEntry({
            id: `local-mesh-${stamp}`, kind: 'assembly', title: meshes[0].name,
            layers: [{ key: 'mesh', label: meshes[0].name, file: URL.createObjectURL(meshes[0]) + '#' + meshes[0].name, color: '#b9c2cc', opacity: 1 }],
            context: 'Loaded from your computer for this session only.', question: 'Pin anything you would change.',
        });
    } else if (meshes.length > 1) {
        const urls = new Map();
        let values = meshes.map((file, index) => {
            const match = file.name.match(/(\d+(?:\.\d+)?)(?!.*\d)/);
            return match ? +match[1] : index + 1;
        });
        if (new Set(values).size !== values.length) values = meshes.map((_, index) => index + 1);
        meshes.forEach((file, index) => urls.set(values[index], URL.createObjectURL(file) + '#' + file.name));
        const order = values.map((v, i) => i).sort((a, b) => values[a] - values[b]);
        addEntry({
            id: `local-sweep-${stamp}`, kind: 'sweep', title: `Your files (${meshes.length})`, param: 'Variant', unit: '',
            values: order.map(i => values[i]), file: value => urls.get(value), defaultValue: values[order[Math.floor(order.length / 2)]],
            context: 'Loaded from your computer for this session only. Files were ordered by the number in their names.', question: 'Which one would you choose?',
        });
    }
    if (!videos.length && !meshes.length) { toast('Add videos (.mp4, .webm, .mov) or meshes (.glb, .stl, .obj).'); return; }
    studioIndex = guidedIndex = entries.length - 1;
    mount(currentLayout);
    if (currentLayout === 'scroll') entries[entries.length - 1].media.root.scrollIntoView({ behavior: 'smooth', block: 'center' });
    toast(`Added ${videos.length + (meshes.length ? 1 : 0)} item(s) for this session. Notes on them will not survive a reload.`, 5000);
});
// ---- boot --------------------------------------------------------------------------------------

async function boot() {
    const banner = document.getElementById('rv-banner');
    const params = new URLSearchParams(location.search);
    const hash = new URLSearchParams(location.hash.slice(1));
    if (params.get('review')) {
        try {
            rawReview = await loadExternalReview(params.get('review'));
            review = normalizeReview(rawReview);
        } catch (error) {
            console.error(error);
            host.innerHTML = `<div class="rv-fatal"><h2>This review could not be loaded</h2><p>${escapeHTML(error.message || String(error))}</p><p>Check that the link is complete and, for a Drive review, that the file is shared as "anyone with the link".</p></div>`;
            window.rvDebug = { error };
            return;
        }
    } else {
        review = normalizeReview(review);
    }
    initStore();
    if (Array.isArray(review.participantTools)) policy.defaults = review.participantTools.slice();
    policy.allowed = new Set(policy.defaults);
    policy.apply();
    wireReview();
    review.items.forEach(addEntry);
    if (hash.get('r')) {
        try {
            const shared = await decodeShare(hash.get('r'));
            const mine = store.data;
            const mineHasInput = Object.values(mine.items || {}).some(entry => entry.pick !== null || entry.note || entry.annotations?.length || Object.keys(entry.tags || {}).length);
            const apply = () => {
                store.replace(shared);
                reviewerInput.value = store.data.reviewer || '';
                banner.hidden = true;
                toast(`Showing the review shared by ${store.data.reviewer || 'a reviewer'}`);
            };
            if (!mineHasInput) apply();
            else {
                banner.hidden = false;
                banner.innerHTML = `<strong>This link carries a review by ${escapeHTML(shared.reviewer || 'someone')}</strong> (${shared.updatedAt ? new Date(shared.updatedAt).toLocaleString() : 'no date'}). You already have notes on this page.`;
                const use = el('button', 'rv-btn rv-primary', 'Show theirs (replaces mine)');
                const keep = el('button', 'rv-btn', 'Keep mine');
                use.type = keep.type = 'button';
                use.addEventListener('click', apply);
                keep.addEventListener('click', () => { banner.hidden = true; });
                banner.append(use, keep);
            }
        } catch (error) {
            console.error(error);
            toast('That share link could not be read.');
        }
        history.replaceState(null, '', location.pathname + location.search);
    }
    // Guided is the chosen layout. The A/B/C switcher stays available with ?layouts=1 for comparison.
    const showSwitcher = params.has('layouts') || params.has('layout');
    document.getElementById('rv-variants').hidden = !showSwitcher;
    mount(params.get('layout') || 'guided');
    // ?item=<screen id> opens on that screen (the editor's preview uses it).
    if (params.get('item')) { const start = entries.findIndex(e => e.item.id === params.get('item')); if (start > 0) layout.show(start); }
    if (params.get('name')) { reviewerInput.value = params.get('name'); store.set(data => { data.reviewer = params.get('name'); }); }
    liveSession = createLiveSession({
        entries, layout, store, toast,
        button: document.getElementById('rv-live'),
        getName: () => reviewerInput.value.trim() || reviewerInput.placeholder || 'Guest',
        getReviewId: () => review.id,
        getReviewTitle: () => review.title,
        autoJoinCode: params.get('session'),
        autoPresent: params.has('present'),
        policy, tools: TOOL_KEYS,
        // Only the screen on view needs laying out again; others lay out when they are shown.
        onPolicy: () => entries[layout.getIndex()]?.media.remount?.(),
        pickLabel: (entry, value) => sweepUnitLabel(entry.item, value),
        downloadHostFile: rawReview ? downloadHostReview : null,
    });
}
// The review file as loaded, so the host can download it again with their stop points merged in.
let rawReview = null;
function downloadHostReview() {
    const copy = JSON.parse(JSON.stringify(rawReview));
    const data = hostStore.load();
    let merged = 0;
    Object.entries(data.stops || {}).forEach(([key, list]) => {
        const [itemId, sourceKey, clipId] = key.split('|');
        const target = copy.items?.find(it => it.id === itemId);
        const source = target?.sources?.[sourceKey];
        if (!source) return;
        if (source.kind === 'playlist') { const c = (source.clips || []).find((x, i) => (x.id || `clip-${i + 1}`) === clipId); if (c) { c.stops = list; merged++; } }
        else { source.stops = list; merged++; }
    });
    let turned = 0;
    Object.entries(data.rotations || {}).forEach(([key, deg]) => {
        const [itemId, sourceKey, clipId] = key.split('|');
        const source = copy.items?.find(it => it.id === itemId)?.sources?.[sourceKey];
        if (!source) return;
        const target = source.kind === 'playlist' ? (source.clips || []).find((x, i) => (x.id || `clip-${i + 1}`) === clipId) : source;
        if (!target) return;
        if (deg) target.rotate = deg; else delete target.rotate;
        turned++;
    });
    const name = (new URLSearchParams(location.search).get('review') || 'review.json').split('/').pop().replace(/^draft:|^drive:/, '') || 'review.json';
    download(name.endsWith('.json') ? name : name + '.json', new Blob([JSON.stringify(copy, null, 2) + '\n'], { type: 'application/json' }));
    const parts = [merged && `stop points for ${merged} video${merged === 1 ? '' : 's'}`, turned && `rotation for ${turned} video${turned === 1 ? '' : 's'}`].filter(Boolean);
    toast(parts.length ? `Review file downloaded with ${parts.join(' and ')}` : 'Review file downloaded (no stop points or rotations changed)');
}
let liveSession = null;
boot();

// Console access for testing: rvDebug.store, rvDebug.encodeShare(data), rvDebug.summary().
window.rvDebug = { policy, hostStore, store, encodeShare, decodeShare, summary: () => buildSummary(entries.map(e => e.item)), entries, mount, layout, get live() { return liveSession; } };
