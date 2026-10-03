"""Media gallery back end for the presentation editor (used by range_server.py, local only).

Browses folders on this computer that hold photos and videos: Google Drive for desktop (every
"X:\\My Drive" and "X:\\Shared drives" it finds), Downloads, Desktop, Pictures, Videos, and the site
itself. Anything outside the site is read-only here: adding it to a presentation imports a web-ready
copy into the site's media/ folder, because the published site can only show files it contains.

    videos   -> H.264 MP4, long edge at most 1280 px, 30 fps at most, AAC audio, fast start,
                plus a poster JPEG next to it (same name). Phone rotation is applied.
    pictures -> JPEG, long edge at most 2400 px, EXIF orientation applied. HEIC (iPhone) needs
                pillow-heif (pip install pillow-heif); ffmpeg decodes iPhone HEIC grids wrongly.

Thumbnails and conversions are cached in %LOCALAPPDATA%\\give-a-paw-editor.
"""
import hashlib
import json
import os
import re
import shutil
import string
import subprocess
import tempfile
import threading
import time
import uuid

try:
    from PIL import Image, ImageOps
except ImportError:  # thumbnails of pictures then fall back to ffmpeg
    Image = None
try:
    import pillow_heif
    pillow_heif.register_heif_opener()
    HEIF = True
except ImportError:
    HEIF = False

VIDEO_EXT = {'.mp4', '.mov', '.m4v', '.webm', '.avi', '.mkv', '.3gp'}
IMAGE_EXT = {'.jpg', '.jpeg', '.png', '.webp', '.gif', '.heic', '.heif', '.avif', '.bmp', '.tif', '.tiff'}
WEB_VIDEO = {'.mp4', '.m4v', '.webm', '.mov'}      # often plays straight from the folder for previewing
WEB_IMAGE = {'.jpg', '.jpeg', '.png', '.webp', '.gif'}
SKIP_NAMES = {'desktop.ini', 'thumbs.db', '.ds_store'}
SITE_SKIP = {'.git', '.claude', 'node_modules', 'tools', 'automation', 'reviews', '__pycache__', 'sample-models'}
MEDIA_FOLDER = re.compile(r'^media(/[a-z0-9][a-z0-9._-]{0,60}){1,3}$')
MAX_VIDEO_EDGE = 1280
MAX_IMAGE_EDGE = 2400
CREATE_NO_WINDOW = 0x08000000 if os.name == 'nt' else 0

CACHE = os.path.join(os.environ.get('LOCALAPPDATA') or tempfile.gettempdir(), 'give-a-paw-editor')
FFMPEG = shutil.which('ffmpeg')
FFPROBE = shutil.which('ffprobe')
_thumb_slots = threading.BoundedSemaphore(3)


def media_kind(name):
    ext = os.path.splitext(name)[1].lower()
    return 'video' if ext in VIDEO_EXT else 'image' if ext in IMAGE_EXT else None


def _run(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, creationflags=CREATE_NO_WINDOW, **kw)


# ---- places to browse ------------------------------------------------------------------------------

_roots_cache = {'at': 0, 'list': []}


def _volume_account(base):
    """The account email in a Drive for desktop volume label, or None."""
    if os.name != 'nt':
        return None
    try:
        import ctypes
        buf = ctypes.create_unicode_buffer(261)
        if not ctypes.windll.kernel32.GetVolumeInformationW(base, buf, 261, None, None, None, None, 0):
            return None
        match = re.match(r'\s*([^\s@]+@[^\s]+?)\s+-\s', buf.value)
        return match.group(1) if match else None
    except Exception:
        return None


def roots(site_root):
    """[{id, label, kind, path}] -- refreshed every 20 s so a newly mounted drive shows up."""
    if time.time() - _roots_cache['at'] < 20:
        return _roots_cache['list']
    found = [{'id': 'site', 'label': 'This website', 'kind': 'site', 'path': site_root}]
    for letter in string.ascii_uppercase[3:]:
        base = f'{letter}:\\'
        my = base + 'My Drive'
        if os.path.isdir(my):
            # Drive for desktop names each volume "<account> - Google Drive": show whose Drive it is.
            account = _volume_account(base)
            label = f'{account} ({letter}:)' if account else f'Google Drive ({letter}:)'
            found.append({'id': f'drive-{letter}', 'label': label, 'kind': 'drive', 'path': my})
            shared = base + 'Shared drives'
            try:
                if any(n.lower() not in SKIP_NAMES for n in os.listdir(shared)):
                    found.append({'id': f'shared-{letter}', 'label': f'Shared drives ({letter}:)', 'kind': 'drive', 'path': shared})
            except OSError:
                pass
            found.extend(_shortcut_roots(base, letter))
    home = os.path.expanduser('~')
    for rid, label, options in [
        ('downloads', 'Downloads', ['Downloads']),
        ('desktop', 'Desktop', [os.path.join('OneDrive', 'Desktop'), 'Desktop']),
        ('pictures', 'Pictures', [os.path.join('OneDrive', 'Pictures'), 'Pictures']),
        ('videos', 'Videos', ['Videos']),
    ]:
        path = next((os.path.join(home, o) for o in options if os.path.isdir(os.path.join(home, o))), None)
        if path:
            found.append({'id': rid, 'label': label, 'kind': 'folder', 'path': path})
    for i, extra in enumerate(p for p in os.environ.get('GAP_MEDIA_ROOTS', '').split(';') if p.strip()):
        if os.path.isdir(extra):
            found.append({'id': f'extra-{i}', 'label': os.path.basename(extra.rstrip('\\/')) or extra, 'kind': 'folder', 'path': extra})
    _roots_cache.update(at=time.time(), list=found)
    return found


SHORTCUT_TARGET = re.compile(r'^([A-Za-z]):\\\.shortcut-targets-by-id\\([^\\]+)\\([^\\]+)')
_lock = threading.Lock()


def _load_json(name, default):
    try:
        with open(os.path.join(CACHE, name), encoding='utf-8') as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return default


def _save_json(name, data):
    os.makedirs(CACHE, exist_ok=True)
    tmp = os.path.join(CACHE, name + '.tmp')
    with open(tmp, 'w', encoding='utf-8') as handle:
        json.dump(data, handle, indent=1)
    os.replace(tmp, os.path.join(CACHE, name))


def _resolve_lnks(paths):
    """{lnk path: target path} via the Windows shell (Drive for desktop's .lnk files cannot be read as
    files). Cached by path, size and time, so PowerShell only runs for new or changed shortcuts."""
    if os.name != 'nt' or not paths:
        return {}
    cache = _load_json('lnk-targets.json', {})
    def key(path):
        try:
            st = os.stat(path)
            return f'{path}|{st.st_size}|{int(st.st_mtime)}'
        except OSError:
            return None
    todo = [p for p in paths if key(p) and key(p) not in cache]
    if todo:
        script = ("$s = New-Object -ComObject WScript.Shell; $paths = ConvertFrom-Json '" + json.dumps(todo).replace("'", "''") + "'; "
                  "foreach ($p in $paths) { try { $t = $s.CreateShortcut($p).TargetPath } catch { $t = '' }; Write-Output ('>' + $t) }")
        try:
            result = _run(['powershell', '-NoProfile', '-NonInteractive', '-Command', script], timeout=60)
            lines = [line[1:] for line in (result.stdout or b'').decode('utf-8', 'replace').splitlines() if line.startswith('>')]
        except Exception:
            lines = []
        for path, target in zip(todo, lines):
            cache[key(path)] = target.strip()
        with _lock:
            _save_json('lnk-targets.json', cache)
    return {p: cache.get(key(p) or '', '') for p in paths}


def _shortcut_entry(letter, drive_id, name, path):
    return {'id': f'link-{letter}-{drive_id}', 'label': f'{name} (shared, {letter}:)', 'kind': 'shortcut',
            'path': path, 'name': name, 'letter': letter}


def _remember_shortcuts(entries):
    known = _load_json('shortcuts.json', {})
    changed = False
    for e in entries:
        if known.get(e['id']) != {'letter': e['letter'], 'name': e['name'], 'path': e['path']}:
            known[e['id']] = {'letter': e['letter'], 'name': e['name'], 'path': e['path']}
            changed = True
    if changed:
        with _lock:
            _save_json('shortcuts.json', known)


def shortcut_for_lnk(lnk_path):
    """The place a Drive shortcut (.lnk) opens, or None."""
    target = _resolve_lnks([lnk_path]).get(lnk_path, '')
    match = SHORTCUT_TARGET.match(target or '')
    if not match:
        return None
    letter, drive_id, name = match.group(1).upper(), match.group(2), match.group(3)
    path = f'{letter}:\\.shortcut-targets-by-id\\{drive_id}\\{name}'
    if not os.path.isdir(path):   # asking for it by id makes Drive for desktop open it
        return None
    entry = _shortcut_entry(letter, drive_id, name, path)
    _remember_shortcuts([entry])
    return entry


def _shortcut_roots(base, letter):
    """Folders shared with this account and added to My Drive as shortcuts. Drive for desktop shows them as
    .lnk files and keeps the real folder under X:\\.shortcut-targets-by-id\\<drive id>\\<name>, but it only
    lists a target there once something has opened it (after a restart that folder is empty), so the
    .lnk files are resolved, and shortcuts seen before are remembered."""
    found = {}
    targets = base + '.shortcut-targets-by-id'
    try:
        for drive_id in os.listdir(targets):
            holder = os.path.join(targets, drive_id)
            for name in os.listdir(holder) if os.path.isdir(holder) else []:
                if name.lower() not in SKIP_NAMES and os.path.isdir(os.path.join(holder, name)):
                    entry = _shortcut_entry(letter, drive_id, name, os.path.join(holder, name))
                    found[entry['id']] = entry
    except OSError:
        pass
    try:
        lnks = [os.path.join(base + 'My Drive', n) for n in os.listdir(base + 'My Drive') if n.lower().endswith('.lnk')]
    except OSError:
        lnks = []
    for lnk in lnks:
        entry = shortcut_for_lnk(lnk)
        if entry:
            found[entry['id']] = entry
    for sid, info in _load_json('shortcuts.json', {}).items():
        if sid not in found and info.get('letter') == letter and os.path.isdir(info.get('path', '')):
            found[sid] = _shortcut_entry(letter, sid.split('-', 2)[2], info['name'], info['path'])
    _remember_shortcuts(found.values())
    return sorted(found.values(), key=lambda e: e['name'].lower())


def resolve(site_root, root_id, rel):
    """Absolute path of rel inside the root, or None if it would leave the root."""
    root = next((r for r in roots(site_root) if r['id'] == root_id), None)
    if not root and root_id.startswith('link-'):
        info = _load_json('shortcuts.json', {}).get(root_id)
        if info and os.path.isdir(info.get('path', '')):
            root = _shortcut_entry(info['letter'], root_id.split('-', 2)[2], info['name'], info['path'])
    if not root or not isinstance(rel, str) or '\0' in rel:
        return None, None
    base = os.path.realpath(root['path'])
    full = os.path.realpath(os.path.join(base, *[p for p in rel.replace('\\', '/').split('/') if p not in ('', '.')]))
    if os.path.normcase(full) != os.path.normcase(base) and not os.path.normcase(full).startswith(os.path.normcase(base) + os.sep):
        return None, None
    if root_id == 'site':
        first = os.path.relpath(full, base).split(os.sep)[0]
        if first in SITE_SKIP or first.startswith('.'):
            return None, None
    return root, full


def browse(site_root, root_id, rel):
    root, full = resolve(site_root, root_id, rel or '')
    if not root or not os.path.isdir(full):
        return None
    folders, files = [], []
    registry = ImportRegistry(site_root) if root_id != 'site' else None
    with os.scandir(full) as entries:
        for entry in entries:
            name = entry.name
            if name.startswith(('.', '~$')) or name.lower() in SKIP_NAMES:
                continue
            if name.lower().endswith('.lnk'):
                # A shortcut to a shared folder opens that folder.
                target = shortcut_for_lnk(entry.path)
                if target:
                    folders.append({'name': name[:-4], 'path': '', 'root': target['id'], 'shortcut': True})
                continue
            rel_path = os.path.relpath(entry.path, os.path.realpath(root['path'])).replace(os.sep, '/')
            try:
                if entry.is_dir():
                    if root_id == 'site' and rel_path.split('/')[0] in SITE_SKIP:
                        continue
                    folders.append({'name': name, 'path': rel_path})
                    continue
                kind = media_kind(name)
                if not kind:
                    continue
                stat = entry.stat()
            except OSError:
                continue
            ext = os.path.splitext(name)[1].lower()
            item = {'name': name, 'path': rel_path, 'kind': kind, 'size': stat.st_size, 'mtime': int(stat.st_mtime),
                    'web': ext in (WEB_VIDEO if kind == 'video' else WEB_IMAGE), 'renamable': True}
            hit = registry.lookup(entry.path, stat) if registry else None
            if hit:
                item['inSite'] = hit['dest']
            files.append(item)
    folders.sort(key=lambda f: f['name'].lower())
    files.sort(key=lambda f: f['name'].lower())
    rel_norm = '' if os.path.normcase(full) == os.path.normcase(os.path.realpath(root['path'])) else os.path.relpath(full, os.path.realpath(root['path'])).replace(os.sep, '/')
    return {'root': root_id, 'label': root['label'], 'path': rel_norm, 'folders': folders, 'files': files,
            'heif': HEIF, 'ffmpeg': bool(FFMPEG)}


# ---- thumbnails and file details -------------------------------------------------------------------

def _cache_key(full, *extra):
    stat = os.stat(full)
    return hashlib.sha1(f'{os.path.normcase(full)}|{stat.st_size}|{int(stat.st_mtime)}|{extra}'.encode()).hexdigest()


def _open_picture(full):
    image = Image.open(full)
    image = ImageOps.exif_transpose(image)
    return image


def thumbnail(full, width):
    """Path of a cached JPEG thumbnail (width px wide at most), or None."""
    width = max(64, min(int(width or 360), 2000))
    out = os.path.join(CACHE, 'thumbs', _cache_key(full, width) + '.jpg')
    if os.path.isfile(out):
        return out
    os.makedirs(os.path.dirname(out), exist_ok=True)
    tmp = out + f'.{uuid.uuid4().hex[:6]}.jpg'
    with _thumb_slots:
        kind = media_kind(full)
        try:
            if kind == 'image' and Image is not None and (HEIF or not full.lower().endswith(('.heic', '.heif'))):
                image = _open_picture(full)
                image.thumbnail((width, width * 2))
                image.convert('RGB').save(tmp, 'JPEG', quality=82)
            elif FFMPEG:
                for seek in (['-ss', '1'], []):
                    _run([FFMPEG, '-v', 'error', '-y', *seek, '-i', full, '-frames:v', '1',
                          '-vf', f"scale='min({width},iw)':-2", '-q:v', '5', tmp], timeout=90)
                    if os.path.isfile(tmp) and os.path.getsize(tmp):
                        break
            if os.path.isfile(tmp) and os.path.getsize(tmp):
                os.replace(tmp, out)
                return out
        except Exception:
            pass
        finally:
            if os.path.exists(tmp):
                os.remove(tmp)
    return None


def probe(full):
    """Size, dimensions (as shown, after rotation) and, for videos, duration / frame rate / codec."""
    info = {'name': os.path.basename(full), 'size': os.path.getsize(full), 'kind': media_kind(full)}
    if info['kind'] == 'image':
        try:
            image = _open_picture(full)
            info.update(width=image.width, height=image.height, format=(image.format or os.path.splitext(full)[1][1:]).upper())
        except Exception:
            pass
        return info
    if not FFPROBE:
        return info
    result = _run([FFPROBE, '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', full], timeout=60)
    try:
        data = json.loads(result.stdout or b'{}')
    except ValueError:
        return info
    video = next((s for s in data.get('streams', []) if s.get('codec_type') == 'video' and s.get('disposition', {}).get('attached_pic') != 1), None)
    if video:
        rotation = 0
        for side in video.get('side_data_list', []) or []:
            if 'rotation' in side:
                rotation = int(float(side['rotation']))
        rotation = int(video.get('tags', {}).get('rotate', rotation) or 0)
        w, h = video.get('width'), video.get('height')
        if rotation % 180:
            w, h = h, w
        try:
            num, den = (video.get('avg_frame_rate') or '0/1').split('/')
            fps = round(float(num) / float(den), 2) if float(den) else None
        except ValueError:
            fps = None
        info.update(width=w, height=h, codec=video.get('codec_name'), fps=fps, rotation=rotation,
                    hdr=video.get('color_transfer') in ('arib-std-b67', 'smpte2084'))
    info['audio'] = any(s.get('codec_type') == 'audio' for s in data.get('streams', []))
    try:
        info['duration'] = round(float(data.get('format', {}).get('duration')), 2)
    except (TypeError, ValueError):
        pass
    return info


# ---- importing into the site -----------------------------------------------------------------------

class ImportRegistry:
    """Which outside file became which file in the site. Matched by path, then by size + time + type, so a
    file renamed in Drive (in the gallery or elsewhere) still finds the copy made before, instead of being
    copied again under its new name."""

    def __init__(self, site_root):
        self.site_root = site_root
        self.entries = _load_json('imports.json', [])

    def _alive(self, entry):
        return entry and os.path.isfile(os.path.join(self.site_root, *entry['dest'].split('/')))

    def lookup(self, full, stat=None):
        try:
            stat = stat or os.stat(full)
        except OSError:
            return None
        norm = os.path.normcase(full)
        ext = os.path.splitext(full)[1].lower()
        for entry in self.entries:
            if os.path.normcase(entry['src']) == norm and entry['size'] == stat.st_size and self._alive(entry):
                return entry
        for entry in self.entries:
            if entry['size'] == stat.st_size and entry['mtime'] == int(stat.st_mtime) and entry['ext'] == ext and self._alive(entry):
                return entry
        return None

    def add(self, full, dest, poster=None):
        stat = os.stat(full)
        norm = os.path.normcase(full)
        self.entries = [e for e in self.entries if os.path.normcase(e['src']) != norm]
        self.entries.append({'src': full, 'size': stat.st_size, 'mtime': int(stat.st_mtime), 'ext': os.path.splitext(full)[1].lower(),
                             'dest': dest, 'poster': poster})
        with _lock:
            _save_json('imports.json', self.entries)

    def moved(self, old, new):
        norm = os.path.normcase(old)
        for entry in self.entries:
            if os.path.normcase(entry['src']) == norm:
                entry['src'] = new
        with _lock:
            _save_json('imports.json', self.entries)


BAD_NAME = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
TEXT_EXT = {'.html', '.js', '.css', '.json', '.md'}


def _site_copy_by_name(site_root, full):
    """A copy made before the registry existed: same name (made web-safe) somewhere under media/."""
    stem = safe_stem(os.path.basename(full))
    want = {stem + e for e in (('.mp4',) if media_kind(full) == 'video' else ('.jpg', '.jpeg', '.png', '.webp', '.gif'))}
    for folder, _, files in os.walk(os.path.join(site_root, 'media')):
        for name in files:
            if name in want:
                rel = os.path.relpath(os.path.join(folder, name), site_root).replace(os.sep, '/')
                poster = rel.rsplit('.', 1)[0] + '.jpg'
                return rel, poster if media_kind(full) == 'video' and os.path.isfile(os.path.join(site_root, *poster.split('/'))) else None
    return None, None


def rename(site_root, root_id, rel, new_name):
    """Rename a picture or video. Returns {path, name, updated, renamed}. The extension is kept.
    Outside the site: the file is renamed where it is (Drive syncs it); copies already in the site are
    untouched, and the registry keeps them linked to the renamed file.
    In the site: every presentation (reviews/*.json) that uses the file is updated, and a video's poster
    is renamed with it; a file that other pages use is not renamed."""
    root, full = resolve(site_root, root_id, rel)
    if not root or not os.path.isfile(full) or not media_kind(full):
        raise FileNotFoundError('File not found.')
    ext = os.path.splitext(full)[1]
    stem = str(new_name or '').strip()
    if stem.lower().endswith(ext.lower()):
        stem = stem[:-len(ext)]
    stem = stem.strip().rstrip('.')
    if root_id == 'site':
        stem = re.sub(r'\s+', '-', stem)
        stem = re.sub(r'[^A-Za-z0-9._-]+', '', stem).strip('-.')
    if not stem or BAD_NAME.search(stem) or stem in ('.', '..') or len(stem) > 150:
        raise ValueError('That name cannot be used. Avoid  < > : " / \\ | ? *' + ('; in the site only letters, digits, - _ and . are kept.' if root_id == 'site' else '.'))
    target = os.path.join(os.path.dirname(full), stem + ext)
    if os.path.normcase(target) != os.path.normcase(full) and os.path.exists(target):
        raise FileExistsError(f'A file called {stem + ext} is already in that folder.')
    if target == full:
        return {'path': rel, 'name': os.path.basename(full), 'updated': [], 'renamed': []}
    base = os.path.realpath(root['path'])
    new_rel = os.path.relpath(target, base).replace(os.sep, '/')

    if root_id != 'site':
        registry = ImportRegistry(site_root)
        if not registry.lookup(full):
            dest, poster = _site_copy_by_name(site_root, full)
            if dest:
                registry.add(full, dest, poster)
        os.rename(full, target)
        registry.moved(full, target)
        return {'path': new_rel, 'name': stem + ext, 'updated': [], 'renamed': [[rel, new_rel]]}

    # In the site: what else uses it?
    moves = [(rel, new_rel)]
    if media_kind(full) == 'video':
        for poster_ext in ('.jpg', '.png'):
            old_poster = full[:-len(ext)] + poster_ext
            if os.path.isfile(old_poster):
                new_poster = target[:-len(ext)] + poster_ext
                if os.path.exists(new_poster):
                    raise FileExistsError(f'{os.path.basename(new_poster)} is already in that folder.')
                moves.append((rel[:-len(ext)] + poster_ext, new_rel[:-len(ext)] + poster_ext))
    reviews_dir = os.path.join(site_root, 'reviews')
    review_files = [os.path.join(reviews_dir, n) for n in os.listdir(reviews_dir) if n.endswith('.json')] if os.path.isdir(reviews_dir) else []
    blockers = []
    for folder, dirs, files in os.walk(site_root):
        dirs[:] = [d for d in dirs if d not in SITE_SKIP and not d.startswith('.') and d != '_backups' and d != 'media']
        for name in files:
            path = os.path.join(folder, name)
            if os.path.splitext(name)[1].lower() not in TEXT_EXT or os.path.dirname(path) == reviews_dir:
                continue
            try:
                text = open(path, encoding='utf-8', errors='ignore').read()
            except OSError:
                continue
            if any(old in text or old.rsplit('/', 1)[-1] in text for old, _ in moves):
                blockers.append(os.path.relpath(path, site_root).replace(os.sep, '/'))
    if blockers:
        raise PermissionError('Not renamed: ' + ', '.join(blockers[:4]) + (' and others' if len(blockers) > 4 else '') + ' also use this file.')
    for old, new in moves:
        os.rename(os.path.join(site_root, *old.split('/')), os.path.join(site_root, *new.split('/')))
    updated = []
    for path in review_files:
        text = open(path, encoding='utf-8').read()
        data = json.loads(text)
        count = 0

        def walk(value):
            nonlocal count
            if isinstance(value, dict):
                return {k: walk(v) for k, v in value.items()}
            if isinstance(value, list):
                return [walk(v) for v in value]
            for old, new in moves:
                if value == old:
                    count += 1
                    return new
            return value
        data = walk(data)
        if count:
            backups = os.path.join(reviews_dir, '_backups')
            os.makedirs(backups, exist_ok=True)
            stem_name = os.path.splitext(os.path.basename(path))[0]
            shutil.copyfile(path, os.path.join(backups, f'{stem_name}-{time.strftime("%Y%m%d-%H%M%S")}-before-rename.json'))
            tmp = path + '.tmp'
            with open(tmp, 'w', encoding='utf-8', newline='\n') as handle:
                handle.write(json.dumps(data, indent=2, ensure_ascii=False) + '\n')
            os.replace(tmp, path)
            updated.append(f'reviews/{os.path.basename(path)}')
    return {'path': new_rel, 'name': stem + ext, 'updated': updated, 'renamed': [list(m) for m in moves]}


def safe_stem(name):
    stem = re.sub(r'[^A-Za-z0-9._-]+', '-', os.path.splitext(os.path.basename(name))[0]).strip('-.') or 'media'
    return stem[:80]


class Importer:
    """One background worker: conversions run one at a time so the laptop stays usable."""

    def __init__(self, site_root):
        self.site_root = site_root
        self.jobs = {}
        self.lock = threading.Lock()
        self.queue = []
        self.wake = threading.Event()
        threading.Thread(target=self._work, daemon=True).start()

    def submit(self, full, folder, *, label=None, cleanup=False):
        if not MEDIA_FOLDER.match(folder or ''):
            raise ValueError('Media goes in a folder like media/ollie-fitting (lowercase letters, digits, dashes).')
        kind = media_kind(full)
        if not kind:
            raise ValueError(f'{os.path.basename(full)} is not a picture or a video.')
        job = {'id': uuid.uuid4().hex[:12], 'name': label or os.path.basename(full), 'kind': kind, 'status': 'queued',
               'progress': 0.0, 'message': 'Waiting', 'folder': folder, '_full': full, '_cleanup': cleanup, 'at': time.time()}
        with self.lock:
            self.jobs[job['id']] = job
            self.queue.append(job['id'])
            # Forget finished jobs after an hour.
            for jid in [j for j, v in self.jobs.items() if v['status'] in ('done', 'error') and time.time() - v['at'] > 3600]:
                del self.jobs[jid]
        self.wake.set()
        return self.public(job)

    @staticmethod
    def public(job):
        return {k: v for k, v in job.items() if not k.startswith('_')}

    def status(self, ids):
        with self.lock:
            return [self.public(self.jobs[i]) for i in ids if i in self.jobs]

    def _work(self):
        while True:
            self.wake.wait()
            with self.lock:
                job_id = self.queue.pop(0) if self.queue else None
                if not self.queue:
                    self.wake.clear()
            if not job_id:
                continue
            job = self.jobs[job_id]
            job['status'] = 'working'
            try:
                result = self._import(job)
                job.update(status='done', progress=1.0, result=result,
                           message='Already in the site' if result.get('reused') else 'Added to the site')
            except Exception as error:  # report it on the tile rather than killing the worker
                job.update(status='error', message=str(error)[:300])
            finally:
                job['at'] = time.time()
                if job['_cleanup'] and os.path.exists(job['_full']):
                    try:
                        os.remove(job['_full'])
                    except OSError:
                        pass

    def _target(self, folder, stem, ext):
        return f'{folder}/{stem}{ext}', os.path.join(self.site_root, *folder.split('/'), stem + ext)

    def _import(self, job):
        full, folder, kind = job['_full'], job['folder'], job['kind']
        stem = safe_stem(job['name'])
        os.makedirs(os.path.join(self.site_root, *folder.split('/')), exist_ok=True)
        registry = None if job['_cleanup'] else ImportRegistry(self.site_root)
        hit = registry.lookup(full) if registry else None
        if hit:   # copied before (perhaps under an older name)
            return {'src': hit['dest'], 'poster': hit.get('poster'), 'reused': True}
        result = self._import_picture(job, full, folder, stem) if kind == 'image' else self._import_video(job, full, folder, stem)
        if registry:
            registry.add(full, result['src'], result.get('poster'))
        return result

    def _import_picture(self, job, full, folder, stem):
        ext = os.path.splitext(full)[1].lower()
        keep = ext in WEB_IMAGE and os.path.getsize(full) <= 3 * 1024 * 1024
        rel, out = self._target(folder, stem, ext if keep else '.jpg')
        if os.path.isfile(out):
            return {'src': rel, 'reused': True}
        job['message'] = 'Converting picture'
        if keep:
            shutil.copyfile(full, out + '.part')
        else:
            if Image is None:
                raise RuntimeError('Pillow is not installed (pip install pillow pillow-heif).')
            if ext in ('.heic', '.heif') and not HEIF:
                raise RuntimeError('iPhone HEIC pictures need pillow-heif: run  pip install pillow-heif  and restart the preview server.')
            image = _open_picture(full)
            image.thumbnail((MAX_IMAGE_EDGE, MAX_IMAGE_EDGE))
            image.convert('RGB').save(out + '.part', 'JPEG', quality=85, optimize=True, progressive=True)
        os.replace(out + '.part', out)
        return {'src': rel, 'width': None, 'height': None}

    def _import_video(self, job, full, folder, stem):
        rel, out = self._target(folder, stem, '.mp4')
        poster_rel, poster = self._target(folder, stem, '.jpg')
        if os.path.isfile(out):
            return {'src': rel, 'poster': poster_rel if os.path.isfile(poster) else None, 'reused': True}
        if not FFMPEG:
            raise RuntimeError('ffmpeg is not installed, so videos cannot be converted.')
        job['message'] = 'Reading video'
        info = probe(full)
        duration = info.get('duration') or 0
        fps = info.get('fps') or 30
        filters = [f"scale='min({MAX_VIDEO_EDGE},iw)':'min({MAX_VIDEO_EDGE},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2"]
        if fps > 31:
            filters.append('fps=30')
        filters.append('format=yuv420p')
        part = out[:-4] + '.part.mp4'
        cmd = [FFMPEG, '-hide_banner', '-nostdin', '-y', '-i', full, '-map', '0:v:0', '-map', '0:a:0?',
               '-vf', ','.join(filters), '-c:v', 'libx264', '-preset', 'medium', '-crf', '24',
               '-maxrate', '2500k', '-bufsize', '5000k', '-c:a', 'aac', '-b:a', '96k', '-ac', '2',
               '-movflags', '+faststart', '-map_metadata', '-1', '-progress', 'pipe:1', '-nostats', part]
        job['message'] = 'Converting video'
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, creationflags=CREATE_NO_WINDOW, text=True)
        tail = []
        reader = threading.Thread(target=lambda: tail.extend(proc.stderr.read().splitlines()[-6:]), daemon=True)
        reader.start()
        for line in proc.stdout:
            if line.startswith('out_time_us=') and duration:
                try:
                    job['progress'] = max(0.0, min(0.97, int(line.split('=')[1]) / 1e6 / duration))
                except ValueError:
                    pass
        proc.wait()
        reader.join(timeout=5)
        if proc.returncode != 0 or not os.path.isfile(part):
            if os.path.exists(part):
                os.remove(part)
            raise RuntimeError('Video conversion failed: ' + (' '.join(tail[-2:]) or f'ffmpeg exit {proc.returncode}'))
        os.replace(part, out)
        job['message'] = 'Making poster'
        _run([FFMPEG, '-v', 'error', '-y', '-ss', str(min(0.5, duration / 2) if duration else 0), '-i', out,
              '-frames:v', '1', '-vf', "scale='min(640,iw)':-2", '-q:v', '4', poster], timeout=60)
        result = {'src': rel, 'poster': poster_rel if os.path.isfile(poster) else None, 'duration': duration}
        if info.get('hdr'):
            result['note'] = 'This was an HDR (Dolby Vision / HLG) video; colours may look a little flat after conversion.'
        return result


def staging_path(name):
    folder = os.path.join(CACHE, 'uploads')
    os.makedirs(folder, exist_ok=True)
    return os.path.join(folder, f'{uuid.uuid4().hex[:8]}-{safe_stem(name)}{os.path.splitext(name)[1].lower()[:6]}')
