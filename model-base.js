// Where the big 3D sweep models are served from.
//
// GitHub Pages holds the pages and a few showcase models; the thousands of nTop sweep
// files live in a Cloudflare R2 bucket (see R2-SETUP.md). Set MODEL_BASE to the bucket's
// public URL and every sweep file is fetched from there, with a fallback to the copy next
// to the page if the bucket is unreachable. Leave it '' to serve everything from the site.
//
// Which files count as "sweep" files is decided by REMOTE_RULES below; tools/r2_upload.py
// uses the same rules, so keep the two lists the same.

export const MODEL_BASE = 'https://pub-a2549872ef534725a2ed07911261a9df.r2.dev';

// Testing a bucket before publishing: open a page with ?modelBase=https://pub-xxxx.r2.dev
const override = new URLSearchParams(location.search).get('modelBase');
const base = (override ?? MODEL_BASE).replace(/\/+$/, '');

const REMOTE_RULES = [
    /^sample-models\//,
    /^ollie-attach-r/,
    /^ollie-v3-/,
    /^ollie-paw-shape-/,
    /^ntop-chi-/,
    /^chi-top-/,
];

export function isRemoteModel(path) {
    const clean = String(path).split(/[?#]/)[0].replace(/^\.\//, '');
    return REMOTE_RULES.some(rule => rule.test(clean));
}

// The URL to fetch a model from: the bucket when one is configured and the file is a sweep
// file, otherwise the path as given. Absolute and blob: URLs pass through untouched.
export function modelUrl(path) {
    if (!base || /^(https?:|blob:|data:)/.test(path) || !isRemoteModel(path)) return path;
    return base + '/' + String(path).replace(/^\.\//, '');
}

// Wrap a loader (path -> Promise) so it tries the bucket first and the local copy second.
export function withModelFallback(load) {
    return path => {
        const remote = modelUrl(path);
        if (remote === path) return load(path);
        return load(remote).catch(error => {
            console.warn(`Model bucket failed for ${path}; using the site copy.`, error);
            return load(path);
        });
    };
}

export const modelBase = base;
