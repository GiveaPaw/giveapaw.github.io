"""Local preview server with HTTP Range support and the presentation editor's save endpoint.

Python's built-in http.server always sends whole files, so browsers cannot seek in <video>
(scrubbing, frame stepping and stop points snap back to 0:00). GitHub Pages supports ranges, so
this only matters for local previews.

    python tools/range_server.py [port] [directory]

Defaults: port 8131, the folder above this script (the site root).

Editor endpoints (review-editor.html), local only:
    GET  /__editor/files   site media files and review files, for the editor's pickers
    POST /__editor/save    {"path": "reviews/<name>.json", "review": {...}, "base": "<sha256>", "force": false}
                           writes the review file, after copying the previous version to reviews/_backups/.
                           "base" is the SHA-256 of the file as the editor loaded it; if the file changed
                           since (another editor tab, or an edit outside the editor) the save is refused
                           with 409 unless "force" is true.

Media gallery endpoints (see media_library.py):
    GET  /__editor/roots                       places to browse (the site, Google Drive, Downloads...)
    GET  /__editor/browse?root=&path=          folders, pictures and videos in one folder
    GET  /__editor/thumb?root=&path=&w=        cached JPEG thumbnail
    GET  /__editor/raw?root=&path=             the file itself, with Range support (previews)
    GET  /__editor/probe?root=&path=           size, dimensions, duration
    POST /__editor/import {"items": [{"root", "path"}], "folder": "media/<name>"}
                           queues web-ready copies into the site; returns jobs
    POST /__editor/upload?folder=&name=        raw file body (dragged in from the computer); returns a job
    POST /__editor/rename {"root", "path", "name"}  rename a picture or video (site files: presentations updated)
    GET  /__editor/jobs?ids=a,b                progress of queued imports
"""
import hashlib
import json
import mimetypes
import os
import re
import sys
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import media_library  # noqa: E402

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else int(os.environ.get('PORT', '8131'))
ROOT = os.path.abspath(sys.argv[2] if len(sys.argv) > 2 else os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

MEDIA_EXT = {'.glb', '.gltf', '.stl', '.obj', '.mp4', '.webm', '.mov', '.m4v', '.jpg', '.jpeg', '.png', '.webp', '.gif', '.svg'}
SKIP_DIRS = {'.git', '.claude', 'node_modules', 'tools', 'automation', '_backups', '__pycache__'}
REVIEW_PATH = re.compile(r'^reviews/[a-z0-9][a-z0-9-]{0,80}\.json$')
MAX_BODY = 8 * 1024 * 1024
MAX_UPLOAD = 4 * 1024 * 1024 * 1024
IMPORTER = media_library.Importer(ROOT)


class RangeHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        self.send_header('Accept-Ranges', 'bytes')
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    # ---- editor endpoints ------------------------------------------------------------------------
    def _json(self, status, payload):
        body = json.dumps(payload).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _local_request(self):
        # Only this computer, and only pages served by this server. Other websites open in the browser
        # cannot write files: they would send a different Origin, and a JSON body forces a CORS preflight
        # that this server never approves.
        if self.client_address[0] not in ('127.0.0.1', '::1'):
            return False
        # A page from another site cannot reach these either: browsers mark its requests cross-site,
        # and a rebound DNS name would arrive with the wrong Host.
        if self.headers.get('Sec-Fetch-Site', 'same-origin') not in ('same-origin', 'none'):
            return False
        host = (self.headers.get('Host') or '').rsplit(':', 1)[0].strip('[]')
        if host not in ('localhost', '127.0.0.1', '::1'):
            return False
        origin = self.headers.get('Origin')
        if origin is None:
            return True
        host = urlsplit(origin).hostname
        return host in ('localhost', '127.0.0.1') and urlsplit(origin).port == PORT

    def do_GET(self):
        if urlsplit(self.path).path == '/__editor/files':
            if not self._local_request():
                return self._json(403, {'error': 'local only'})
            media, reviews = [], []
            for folder, dirs, files in os.walk(ROOT):
                dirs[:] = sorted(d for d in dirs if d not in SKIP_DIRS and not d.startswith('.'))
                rel_folder = os.path.relpath(folder, ROOT).replace(os.sep, '/')
                for name in sorted(files):
                    rel = name if rel_folder == '.' else f'{rel_folder}/{name}'
                    if REVIEW_PATH.match(rel):
                        reviews.append(rel)
                    elif os.path.splitext(name)[1].lower() in MEDIA_EXT:
                        media.append(rel)
            return self._json(200, {'media': media, 'reviews': reviews})
        if urlsplit(self.path).path.startswith('/__editor/'):
            return self._media_get()
        return super().do_GET()

    # ---- media gallery ---------------------------------------------------------------------------------
    def _query(self):
        return {k: v[-1] for k, v in parse_qs(urlsplit(self.path).query).items()}

    def _media_get(self):
        if not self._local_request():
            return self._json(403, {'error': 'local only'})
        route = urlsplit(self.path).path[len('/__editor/'):]
        q = self._query()
        if route == 'roots':
            return self._json(200, {'roots': [{k: r[k] for k in ('id', 'label', 'kind')} for r in media_library.roots(ROOT)],
                                    'heif': media_library.HEIF, 'ffmpeg': bool(media_library.FFMPEG)})
        if route == 'jobs':
            return self._json(200, {'jobs': IMPORTER.status([i for i in q.get('ids', '').split(',') if i])})
        if route == 'browse':
            try:
                listing = media_library.browse(ROOT, q.get('root', ''), q.get('path', ''))
            except OSError as error:
                return self._json(502, {'error': f'That folder could not be read ({error.strerror or error}).'})
            return self._json(200, listing) if listing else self._json(404, {'error': 'Folder not found.'})
        if route not in ('thumb', 'raw', 'probe'):
            return self._json(404, {'error': 'Not found.'})
        _, full = media_library.resolve(ROOT, q.get('root', ''), q.get('path', ''))
        if not full or not os.path.isfile(full) or not media_library.media_kind(full):
            return self._json(404, {'error': 'File not found.'})
        if route == 'probe':
            return self._json(200, media_library.probe(full))
        if route == 'thumb':
            thumb = media_library.thumbnail(full, q.get('w', '360'))
            if not thumb:
                return self._json(415, {'error': 'No preview for this file.'})
            return self._send_file(thumb, 'image/jpeg', cache=True)
        ctype = 'video/mp4' if full.lower().endswith(('.mov', '.m4v')) else (mimetypes.guess_type(full)[0] or 'application/octet-stream')
        return self._send_file(full, ctype)

    def _send_file(self, full, ctype, cache=False):
        size = os.path.getsize(full)
        match = re.match(r'bytes=(\d*)-(\d*)$', self.headers.get('Range', '').strip())
        start, end = 0, size - 1
        if match and (match.group(1) or match.group(2)):
            start = int(match.group(1)) if match.group(1) else max(0, size - int(match.group(2)))
            end = min(int(match.group(2)) if match.group(1) and match.group(2) else size - 1, size - 1)
            if start > end:
                self.send_error(416, 'Requested range not satisfiable')
                return None
            self.send_response(206)
            self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
        else:
            self.send_response(200)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(end - start + 1))
        self.send_header('X-Content-Type-Options', 'nosniff')
        if cache:
            self.send_header('Cache-Control', 'private, max-age=86400')
        self.end_headers()
        with open(full, 'rb') as handle:
            handle.seek(start)
            self._range_left = end - start + 1
            self.copyfile(handle, self.wfile)

    def _media_post(self, route):
        if route == 'import':
            if not self.headers.get('Content-Type', '').startswith('application/json'):
                return self._json(415, {'error': 'Expected JSON.'})
            length = int(self.headers.get('Content-Length') or 0)
            if length <= 0 or length > MAX_BODY:
                return self._json(413, {'error': 'Request is empty or too large.'})
            try:
                payload = json.loads(self.rfile.read(length).decode('utf-8'))
            except ValueError:
                return self._json(400, {'error': 'Not valid JSON.'})
            jobs = []
            for entry in (payload.get('items') or [])[:200]:
                _, full = media_library.resolve(ROOT, entry.get('root', ''), entry.get('path', ''))
                if not full or not os.path.isfile(full):
                    jobs.append({'status': 'error', 'name': entry.get('path'), 'message': 'File not found.'})
                    continue
                try:
                    jobs.append(IMPORTER.submit(full, payload.get('folder', '')))
                except ValueError as error:
                    return self._json(400, {'error': str(error)})
            return self._json(200, {'jobs': jobs})
        if route == 'upload':
            if self.headers.get('Content-Type', '') != 'application/octet-stream':
                return self._json(415, {'error': 'Expected a file.'})
            q = self._query()
            name, folder = q.get('name', ''), q.get('folder', '')
            if not media_library.media_kind(name):
                return self._json(400, {'error': f'{name or "That file"} is not a picture or a video.'})
            if not media_library.MEDIA_FOLDER.match(folder):
                return self._json(400, {'error': 'Media goes in a folder like media/ollie-fitting.'})
            length = int(self.headers.get('Content-Length') or 0)
            if length <= 0 or length > MAX_UPLOAD:
                return self._json(413, {'error': 'File is empty or larger than 4 GB.'})
            staged = media_library.staging_path(name)
            with open(staged, 'wb') as handle:
                left = length
                while left > 0:
                    chunk = self.rfile.read(min(1 << 20, left))
                    if not chunk:
                        break
                    handle.write(chunk)
                    left -= len(chunk)
            if left:
                os.remove(staged)
                return self._json(400, {'error': 'The upload was cut short.'})
            return self._json(200, {'job': IMPORTER.submit(staged, folder, label=name, cleanup=True)})
        return self._json(404, {'error': 'Not found.'})

    def do_OPTIONS(self):
        self.send_error(405, 'Method not allowed')

    def do_POST(self):
        route = urlsplit(self.path).path
        if route == '/__editor/rename':
            if not self._local_request():
                return self._json(403, {'error': 'Only allowed from this computer.'})
            length = int(self.headers.get('Content-Length') or 0)
            if not self.headers.get('Content-Type', '').startswith('application/json') or length <= 0 or length > 10000:
                return self._json(400, {'error': 'Expected a small JSON request.'})
            try:
                payload = json.loads(self.rfile.read(length).decode('utf-8'))
                return self._json(200, media_library.rename(ROOT, payload.get('root', ''), payload.get('path', ''), payload.get('name', '')))
            except (ValueError, FileExistsError, PermissionError, FileNotFoundError) as error:
                return self._json(400, {'error': str(error)})
            except OSError as error:
                return self._json(500, {'error': f'Could not rename: {error.strerror or error}'})
        if route in ('/__editor/import', '/__editor/upload'):
            if not self._local_request():
                return self._json(403, {'error': 'Only allowed from this computer.'})
            return self._media_post(route.rsplit('/', 1)[1])
        if route != '/__editor/save':
            return self.send_error(404, 'Not found')
        if not self._local_request():
            return self._json(403, {'error': 'Saving is only allowed from this computer.'})
        if not self.headers.get('Content-Type', '').startswith('application/json'):
            return self._json(415, {'error': 'Expected JSON.'})
        length = int(self.headers.get('Content-Length') or 0)
        if length <= 0 or length > MAX_BODY:
            return self._json(413, {'error': 'Review is empty or too large.'})
        try:
            payload = json.loads(self.rfile.read(length).decode('utf-8'))
        except ValueError:
            return self._json(400, {'error': 'Not valid JSON.'})
        path, review = payload.get('path'), payload.get('review')
        if not isinstance(path, str) or not REVIEW_PATH.match(path):
            return self._json(400, {'error': 'Reviews can only be saved as reviews/<name>.json (lowercase letters, digits, dashes).'})
        if not isinstance(review, dict) or not isinstance(review.get('items'), list):
            return self._json(400, {'error': 'That does not look like a review.'})
        target = os.path.join(ROOT, *path.split('/'))
        base = payload.get('base')
        if isinstance(base, str) and base and not payload.get('force') and os.path.isfile(target):
            with open(target, 'rb') as handle:
                current = hashlib.sha256(handle.read()).hexdigest()
            if current != base:
                return self._json(409, {'conflict': True, 'error': f'{path} was changed after this editor opened it.'})
        backup = None
        if os.path.isfile(target):
            backup_dir = os.path.join(ROOT, 'reviews', '_backups')
            os.makedirs(backup_dir, exist_ok=True)
            stem = os.path.splitext(os.path.basename(target))[0]
            backup = f'reviews/_backups/{stem}-{time.strftime("%Y%m%d-%H%M%S")}.json'
            with open(target, 'rb') as src, open(os.path.join(ROOT, *backup.split('/')), 'wb') as dst:
                dst.write(src.read())
        text = json.dumps(review, indent=2, ensure_ascii=False) + '\n'
        tmp = target + '.tmp'
        with open(tmp, 'w', encoding='utf-8', newline='\n') as handle:
            handle.write(text)
        os.replace(tmp, target)
        return self._json(200, {'ok': True, 'path': path, 'backup': backup, 'bytes': len(text.encode('utf-8')),
                                'sha': hashlib.sha256(text.encode('utf-8')).hexdigest()})

    # ---- byte ranges for <video> -------------------------------------------------------------------
    def send_head(self):
        match = re.match(r'bytes=(\d*)-(\d*)$', self.headers.get('Range', '').strip())
        path = self.translate_path(self.path)
        if not match or not os.path.isfile(path):
            return super().send_head()
        size = os.path.getsize(path)
        start = int(match.group(1)) if match.group(1) else max(0, size - int(match.group(2) or 0))
        end = int(match.group(2)) if match.group(1) and match.group(2) else size - 1
        end = min(end, size - 1)
        if start > end or start >= size:
            self.send_error(416, 'Requested range not satisfiable')
            return None
        handle = open(path, 'rb')
        handle.seek(start)
        self.send_response(206)
        self.send_header('Content-Type', self.guess_type(path))
        self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
        self.send_header('Content-Length', str(end - start + 1))
        self.end_headers()
        self._range_left = end - start + 1
        return handle

    def copyfile(self, source, outputfile):
        left = getattr(self, '_range_left', None)
        if left is None:
            return super().copyfile(source, outputfile)
        try:
            while left > 0:
                chunk = source.read(min(65536, left))
                if not chunk:
                    break
                outputfile.write(chunk)
                left -= len(chunk)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass  # the browser cancelled the range request, which it does constantly while seeking
        finally:
            self._range_left = None


if __name__ == '__main__':
    print(f'serving {ROOT} on http://localhost:{PORT} (with Range support)', flush=True)
    # Localhost only: binding to all interfaces would serve this whole folder to anyone on the same Wi-Fi.
    ThreadingHTTPServer(('127.0.0.1', PORT), RangeHandler).serve_forever()
