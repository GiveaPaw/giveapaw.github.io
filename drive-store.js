// Google Drive for the case-study updates: upload photos, videos and 3D models into an animal's
// "Website uploads" folder, pick files already in Drive, and build public URLs to show them.
//
// Settings come from drive-config.js (API key, OAuth client id, project number; see
// CASE-UPDATES-SETUP.md). The app asks only for the `drive.file` scope, so it can touch nothing in
// Drive except files it uploaded or that the person picked with the Google Picker. The first upload
// for an animal opens the Picker on that animal's upload folder so the person can grant it.
//
// Reading needs no sign-in: photos come from Drive's thumbnail service, and models and videos from
// the Drive API with the public API key (the files sit inside the publicly shared animals folder).
import { driveConfig } from './drive-config.js?v=2';

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const GRANTED_PREFIX = 'gap-drive-folder-granted:';
const ID = /^[A-Za-z0-9_-]{20,80}$/;
const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} } };

export const driveReady = () => !!(driveConfig.apiKey && driveConfig.clientId);
export const isDriveId = id => ID.test(String(id || ''));

// ---------------------------------------------------------------- public URLs
export const thumbUrl = (id, width = 1600) => `https://drive.google.com/thumbnail?id=${encodeURIComponent(id)}&sz=w${width}`;
export const viewUrl = id => `https://drive.google.com/file/d/${encodeURIComponent(id)}/view`;
export const mediaUrl = id => (driveConfig.apiKey ? `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media&key=${encodeURIComponent(driveConfig.apiKey)}` : '');

// A share link, an ?id= link or a bare id -> the file id.
export function driveIdFrom(text) {
    const s = String(text || '').trim();
    const m = s.match(/\/d\/([A-Za-z0-9_-]{20,80})/) || s.match(/[?&]id=([A-Za-z0-9_-]{20,80})/) || s.match(/^([A-Za-z0-9_-]{20,80})$/);
    return m ? m[1] : null;
}

// ---------------------------------------------------------------- scripts
const scripts = new Map();
function script(src) {
    if (!scripts.has(src)) {
        scripts.set(src, new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = src; s.async = true; s.onload = resolve; s.onerror = () => { scripts.delete(src); reject(new Error('Could not load ' + src)); };
            document.head.append(s);
        }));
    }
    return scripts.get(src);
}
// Load both Google libraries early (when the editor opens) so the click that needs a popup
// can open it straight away.
export function preloadDrive() {
    if (!driveReady()) return Promise.resolve();
    return Promise.all([
        script('https://accounts.google.com/gsi/client'),
        script('https://apis.google.com/js/api.js').then(() => new Promise(r => window.gapi.load('picker', r))),
    ]);
}

// ---------------------------------------------------------------- access token
let token = null; // { value, expires }
let tokenClient = null;
let pending = null;
// Must be called from a click (it may open Google's consent popup).
export function getToken({ hint = '' } = {}) {
    if (token && token.expires > Date.now() + 60000) return Promise.resolve(token.value);
    if (!window.google?.accounts?.oauth2) return Promise.reject(new Error('Google sign-in is still loading. Try again in a moment.'));
    tokenClient ||= window.google.accounts.oauth2.initTokenClient({ client_id: driveConfig.clientId, scope: SCOPE, callback: () => {} });
    pending = new Promise((resolve, reject) => {
        tokenClient.callback = r => {
            if (r.error) { reject(new Error(r.error === 'access_denied' ? 'Google Drive access was not allowed.' : 'Google Drive sign-in failed (' + r.error + ').')); return; }
            token = { value: r.access_token, expires: Date.now() + (Number(r.expires_in) || 3600) * 1000 };
            resolve(token.value);
        };
        tokenClient.error_callback = e => reject(new Error(e?.type === 'popup_closed' ? 'The Google window was closed.' : 'Google Drive sign-in failed.'));
        tokenClient.requestAccessToken({ prompt: '', login_hint: hint || undefined });
    });
    return pending;
}

export const hasToken = () => !!(token && token.expires > Date.now() + 60000);

// Google's consent window only opens from a click. When an upload needs Drive access and there is no
// token yet, show a small prompt whose button makes that click.
export function ensureToken({ hint = '' } = {}) {
    if (hasToken()) return Promise.resolve(token.value);
    preloadDrive().catch(() => {}); // so Google's script is ready by the time the button is clicked
    return new Promise((resolve, reject) => {
        document.querySelector('.ds-connect')?.remove();
        const box = document.createElement('div');
        box.className = 'ds-connect';
        box.setAttribute('role', 'dialog');
        box.setAttribute('aria-label', 'Connect Google Drive');
        box.innerHTML = `<strong>Connect Google Drive</strong><p>To upload, Google asks once to let this site add files to Drive. It can only see files it adds or that you pick.</p>
            <p class="ds-err" role="alert"></p><div><button type="button" data-ds="no">Cancel</button><button type="button" data-ds="go">Connect Google Drive</button></div>`;
        document.body.append(box);
        box.querySelector('[data-ds=go]').focus();
        box.addEventListener('click', e => {
            const act = e.target.closest('[data-ds]')?.dataset.ds;
            if (act === 'no') { box.remove(); reject(new Error('Google Drive was not connected.')); }
            if (act === 'go') getToken({ hint }).then(t => { box.remove(); resolve(t); }, err => { box.querySelector('.ds-err').textContent = err.message; });
        });
    });
}

// ---------------------------------------------------------------- picker
async function picker(view, { title, multi = false } = {}) {
    await preloadDrive();
    return new Promise((resolve, reject) => {
        const P = window.google?.picker;
        if (!P) { reject(new Error('The Google Drive picker is still loading. Try again in a moment.')); return; }
        const b = new P.PickerBuilder()
            .setOAuthToken(token.value)
            .setDeveloperKey(driveConfig.apiKey)
            .setAppId(driveConfig.appId)
            .addView(view)
            .setTitle(title || 'Google Drive')
            .setOrigin(location.origin)
            .setCallback(data => {
                if (data.action === P.Action.PICKED) resolve(data.docs || []);
                else if (data.action === P.Action.CANCEL) resolve([]);
            });
        if (multi) b.enableFeature(P.Feature.MULTISELECT_ENABLED);
        b.build().setVisible(true);
    });
}

// The first upload for an animal: the person selects that animal's upload folder in the Picker,
// which lets this app put files in it. Remembered per browser.
async function grantFolder(folderId, label) {
    if (store.get(GRANTED_PREFIX + folderId)) return true;
    await preloadDrive();
    const P = window.google.picker;
    const view = new P.DocsView(P.ViewId.FOLDERS).setIncludeFolders(true).setSelectFolderEnabled(true).setFileIds(folderId);
    const docs = await picker(view, { title: `Click “Website uploads” for ${label}, then Select` });
    const ok = docs.some(d => d.id === folderId);
    if (ok) store.set(GRANTED_PREFIX + folderId, '1');
    return ok;
}

// Pick existing files (photos, videos, 3D files) from Drive, starting in a folder.
export async function pickFiles({ hint, folderId, title = 'Pick files from Google Drive' } = {}) {
    await ensureToken({ hint });
    await preloadDrive();
    const P = window.google.picker;
    const view = new P.DocsView(P.ViewId.DOCS).setIncludeFolders(true).setSelectFolderEnabled(false);
    if (folderId) view.setParent(folderId);
    const docs = await picker(view, { title, multi: true });
    return docs.map(d => ({ id: d.id, name: d.name, mimeType: d.mimeType, bytes: Number(d.sizeBytes) || 0 }));
}

// Download a picked file (e.g. an STL to compress). Needs the token: the app may read files picked with the Picker.
export async function downloadFile(id, { hint } = {}) {
    const t = await ensureToken({ hint });
    const r = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media`, { headers: { Authorization: 'Bearer ' + t } });
    if (!r.ok) throw new Error('Could not download that file from Drive (' + r.status + ').');
    return r.blob();
}

// ---------------------------------------------------------------- upload
// Resumable upload (any size), with progress. Returns { id, name, mimeType, bytes }.
export async function uploadFile(blob, { name, mimeType, folderId, folderLabel, hint, onProgress = () => {} }) {
    const t = await ensureToken({ hint });
    if (folderId && !(await grantFolder(folderId, folderLabel || 'this animal'))) throw new Error('Pick the “Website uploads” folder to upload there.');
    const start = async parents => fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true&fields=id,name,mimeType,size', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': mimeType || blob.type || 'application/octet-stream', 'X-Upload-Content-Length': String(blob.size) },
        body: JSON.stringify({ name, mimeType: mimeType || blob.type || undefined, ...(parents ? { parents } : {}) }),
    });
    let res = await start(folderId ? [folderId] : null);
    if (!res.ok && folderId && (res.status === 403 || res.status === 404)) {
        // The folder grant was lost (e.g. cleared in Google account settings): ask again once.
        store.set(GRANTED_PREFIX + folderId, '');
        if (await grantFolder(folderId, folderLabel)) res = await start([folderId]);
    }
    if (!res.ok) throw new Error('Google Drive refused the upload (' + res.status + ').');
    const session = res.headers.get('Location');
    if (!session) throw new Error('Google Drive did not start the upload.');
    const file = await new Promise((resolve, reject) => {
        const x = new XMLHttpRequest();
        x.open('PUT', session);
        x.upload.onprogress = e => e.lengthComputable && onProgress(e.loaded / e.total);
        x.onload = () => (x.status >= 200 && x.status < 300 ? resolve(JSON.parse(x.responseText)) : reject(new Error('Upload failed (' + x.status + ').')));
        x.onerror = () => reject(new Error('Upload failed: the connection dropped.'));
        x.send(blob);
    });
    return { id: file.id, name: file.name, mimeType: file.mimeType, bytes: Number(file.size) || blob.size };
}

// ---------------------------------------------------------------- browsing (no sign-in)
// Lists a publicly shared folder with the browser key: folders first, then files, newest first.
const LIST_FIELDS = 'nextPageToken,files(id,name,mimeType,size,modifiedTime,createdTime,hasThumbnail,thumbnailLink,imageMediaMetadata(width,height,rotation),videoMediaMetadata(width,height,durationMillis))';
export async function listFolder(folderId) {
    if (!driveConfig.apiKey) throw new Error('Google Drive is not set up on this site yet (drive-config.js has no API key).');
    const out = [];
    let page = '';
    do {
        const q = encodeURIComponent(`'${folderId}' in parents and trashed=false`);
        const r = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=${encodeURIComponent(LIST_FIELDS)}&pageSize=200&orderBy=folder,modifiedTime desc${page ? '&pageToken=' + encodeURIComponent(page) : ''}&key=${encodeURIComponent(driveConfig.apiKey)}`);
        const d = await r.json();
        if (!r.ok) throw new Error(d?.error?.message || 'Google Drive did not list that folder (' + r.status + ').');
        out.push(...(d.files || []));
        page = d.nextPageToken || '';
    } while (page && out.length < 2000);
    return out.map(f => ({ ...f, bytes: Number(f.size) || 0, isFolder: f.mimeType === 'application/vnd.google-apps.folder' }));
}

// Downloads a publicly shared file with the browser key (e.g. an STL to compress). No sign-in needed.
export async function downloadPublic(id, onProgress = () => {}) {
    const url = mediaUrl(id);
    if (!url) throw new Error('Google Drive is not set up on this site yet.');
    const r = await fetch(url);
    if (!r.ok) throw new Error('Could not download that file from Drive (' + r.status + ').');
    const total = Number(r.headers.get('Content-Length')) || 0;
    if (!r.body || !total) return r.blob();
    const reader = r.body.getReader();
    const parts = [];
    let got = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value); got += value.length; onProgress(got / total);
    }
    return new Blob(parts);
}

// Design files offered as downloads (not shown in a viewer): nTop notebooks, CAD, MeshMixer, PDFs, zips.
export const DESIGN_FILE = /\.(ntop|step|stp|iges|igs|sldprt|sldasm|f3d|mix|pdf|zip)$/i;
export const DESIGN_ACCEPT = '.ntop,.step,.stp,.iges,.igs,.sldprt,.sldasm,.f3d,.mix,.pdf,.zip';
export const fileKind = f => {
    const n = String(f.name || '').toLowerCase(), m = String(f.mimeType || '');
    if (m.startsWith('image/') || /\.(heic|heif|jpe?g|png|webp|gif)$/.test(n)) return 'photo';
    if (m.startsWith('video/') || /\.(mov|mp4|m4v|webm)$/.test(n)) return 'video';
    if (/\.glb$/.test(n)) return 'model';
    if (/\.(stl|obj|3mf)$/.test(n)) return 'mesh';
    if (DESIGN_FILE.test(n)) return 'file';
    return '';
};

// Demo mode (?casedemo=1): "uploads" stay in this tab as blob URLs, under ids shaped like Drive ids.
const demoFiles = new Map();
export const demoPut = blob => { const id = 'demo-' + Date.now().toString(36) + crypto.getRandomValues(new Uint32Array(2)).join('').slice(0, 16); demoFiles.set(id, URL.createObjectURL(blob)); return id; };
export const demoGet = id => demoFiles.get(id) || '';
