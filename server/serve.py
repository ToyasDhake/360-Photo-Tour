#!/usr/bin/env python3
"""Local server for a 360 photo tour.

From the project root:

    python3 server/serve.py

Then open http://127.0.0.1:8765
The editor is at http://127.0.0.1:8765/admin

HTTPS belongs in front of this process, for example on an nginx reverse proxy.
"""

import json
import logging
import os
import socket
import traceback
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlparse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB = os.path.join(ROOT, "web")
CONTENT = os.path.join(ROOT, "content")
PHOTOS = os.path.join(CONTENT, "photos")
THUMBS = os.path.join(CONTENT, "thumbs")
PLANS = os.path.join(CONTENT, "plans")
TOUR_PATH = os.path.join(CONTENT, "tour.json")
PORT = int(os.environ.get("PORT", "8765"))
HOST = os.environ.get("HOST", "0.0.0.0")
MAX_PLAN_BYTES = 30 * 1024 * 1024
PHOTO_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}
MEDIA_DIRS = {"photos": PHOTOS, "thumbs": THUMBS, "plans": PLANS}


class JsonFormatter(logging.Formatter):
    def format(self, record):
        payload = {
            "time": datetime.fromtimestamp(record.created, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            "level": record.levelname.lower(),
            "msg": record.getMessage(),
        }
        fields = getattr(record, "fields", None)
        if isinstance(fields, dict):
            payload.update(fields)
        if record.exc_info:
            payload["error"] = "".join(traceback.format_exception(*record.exc_info)).rstrip()
        return json.dumps(payload, ensure_ascii=False)


def setup_logging():
    handler = logging.StreamHandler()
    handler.setFormatter(JsonFormatter())
    logger = logging.getLogger("home_tour")
    logger.handlers.clear()
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)
    logger.propagate = False
    return logger


LOGGER = setup_logging()


def log_event(level, msg, exc=None, **fields):
    LOGGER.log(level, msg, extra={"fields": fields}, exc_info=exc)


def safe_filename(name):
    return bool(name) and name not in {".", ".."} and os.path.basename(name) == name and "/" not in name and "\\" not in name


def is_photo(name):
    if not safe_filename(name) or name.startswith("."):
        return False
    if os.path.splitext(name)[1].lower() not in PHOTO_EXTENSIONS:
        return False
    return os.path.isfile(os.path.join(PHOTOS, name))


def list_photos():
    if not os.path.isdir(PHOTOS):
        return []
    return sorted(name for name in os.listdir(PHOTOS) if is_photo(name))


def remove_floorplans():
    if not os.path.isdir(PLANS):
        return
    for old in os.listdir(PLANS):
        if old.startswith("floorplan."):
            os.remove(os.path.join(PLANS, old))


def media_path(url_path):
    parts = [part for part in url_path.split("/") if part]
    if len(parts) != 3 or parts[0] != "media":
        return None
    root = MEDIA_DIRS.get(parts[1])
    name = unquote(parts[2])
    if root is None or not safe_filename(name):
        return None
    root_real = os.path.realpath(root)
    full = os.path.realpath(os.path.join(root, name))
    if not full.startswith(root_real + os.sep):
        return None
    return full


def save_thumb(crop, dst, name):
    ext = os.path.splitext(name)[1].lower()
    if ext in {".jpg", ".jpeg", ".webp"}:
        crop.save(dst, quality=82, optimize=True)
    else:
        crop.save(dst, optimize=True)


def write_thumb(name, yaw_deg=0):
    from PIL import Image

    src = os.path.join(PHOTOS, name)
    dst = os.path.join(THUMBS, name)
    image = Image.open(src).convert("RGB")
    width, height = image.size
    crop_w = max(1, int(width * 90 / 360))
    crop_h = max(1, int(height * 58 / 180))
    top = max(0, (height - crop_h) // 2)
    center = width / 2 + (float(yaw_deg) / 360.0) * width
    left = int(round(center - crop_w / 2)) % width
    if left + crop_w <= width:
        crop = image.crop((left, top, left + crop_w, top + crop_h))
    else:
        first = width - left
        crop = Image.new("RGB", (crop_w, crop_h))
        crop.paste(image.crop((left, top, width, top + crop_h)), (0, 0))
        crop.paste(image.crop((0, top, crop_w - first, top + crop_h)), (first, 0))
    os.makedirs(THUMBS, exist_ok=True)
    crop.thumbnail((520, 340), Image.Resampling.LANCZOS)
    save_thumb(crop, dst, name)


def ensure_thumbs():
    try:
        from PIL import Image
    except ImportError:
        log_event(logging.WARNING, "pillow is not installed", detail="photo list will not have thumbnails")
        return

    os.makedirs(THUMBS, exist_ok=True)
    for name in list_photos():
        src = os.path.join(PHOTOS, name)
        dst = os.path.join(THUMBS, name)
        if os.path.exists(dst) and os.path.getmtime(dst) >= os.path.getmtime(src):
            continue
        write_thumb(name, 0)
        log_event(logging.INFO, "thumbnail written", file=name)


class TourServer(ThreadingHTTPServer):
    def handle_error(self, request, client_address):
        client = client_address[0] if client_address else ""
        log_event(logging.ERROR, "request crashed", client=client, exc=True)


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=WEB, **kwargs)

    def translate_path(self, path):
        media = media_path(urlparse(path).path)
        if media:
            return media
        return super().translate_path(path)

    def log_message(self, fmt, *args):
        log_event(logging.INFO, "server", detail=fmt % args, client=self.address_string())

    def log_error(self, fmt, *args):
        log_event(logging.ERROR, "server", detail=fmt % args, client=self.address_string())

    def log_request(self, code="-", size="-"):
        status = getattr(code, "value", code)
        try:
            status_num = int(status)
        except (TypeError, ValueError):
            status_num = 0
        if status_num >= 500:
            level = logging.ERROR
        elif status_num >= 400:
            level = logging.WARNING
        else:
            level = logging.INFO
        fields = {
            "client": self.address_string(),
            "method": self.command,
            "path": urlparse(self.path).path,
            "status": status_num or status,
        }
        if size not in ("-", None):
            fields["bytes"] = size
        log_event(level, "request", **fields)

    def _fail(self, code, error, **fields):
        level = logging.ERROR if code >= 500 else logging.WARNING
        log_event(level, error, path=urlparse(self.path).path, status=code, **fields)
        self._send_json(code, {"error": error})

    def end_headers(self):
        path = urlparse(self.path).path
        if path == "/" or path == "/admin" or path.startswith("/api/") or path.endswith((".html", ".js", ".css")):
            self.send_header("Cache-Control", "no-cache")
        self.send_header("Permissions-Policy", "xr-spatial-tracking=(self)")
        super().end_headers()

    def _send_json(self, code, payload):
        data = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/photos":
            ensure_thumbs()
            self._send_json(200, {"photos": list_photos()})
            return
        if path == "/api/tour":
            if os.path.exists(TOUR_PATH):
                with open(TOUR_PATH, "rb") as handle:
                    data = handle.read()
            else:
                data = b"null"
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        if path in ("/admin", "/admin/"):
            self.path = "/index.html"
        return super().do_GET()

    def do_POST(self):
        path = urlparse(self.path).path
        length = int(self.headers.get("Content-Length", "0") or 0)
        body = self.rfile.read(length) if length else b""

        if path == "/api/tour":
            try:
                tour = json.loads(body.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as error:
                self._fail(400, "invalid json", error=str(error))
                return
            if not isinstance(tour, dict) or not isinstance(tour.get("spots"), list):
                self._fail(400, "invalid tour")
                return
            temporary = TOUR_PATH + ".tmp"
            with open(temporary, "w", encoding="utf-8") as handle:
                json.dump(tour, handle, indent=2)
                handle.write("\n")
            os.replace(temporary, TOUR_PATH)
            log_event(logging.INFO, "tour saved", spots=len(tour["spots"]))
            self._send_json(200, {"ok": True})
            return

        if path == "/api/thumb":
            try:
                payload = json.loads(body.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as error:
                self._fail(400, "invalid json", error=str(error))
                return
            name = payload.get("file") if isinstance(payload, dict) else None
            if not isinstance(name, str) or "/" in name or "\\" in name or not is_photo(name):
                self._fail(400, "unknown photo", file=name if isinstance(name, str) else "")
                return
            try:
                yaw = float(payload.get("yaw"))
            except (TypeError, ValueError):
                self._fail(400, "invalid direction")
                return
            yaw = max(-180.0, min(180.0, yaw))
            try:
                write_thumb(name, yaw)
            except Exception as error:
                self._fail(500, "could not update thumbnail", file=name, exc=error)
                return
            log_event(logging.INFO, "thumbnail updated", file=name, yaw=yaw)
            self._send_json(200, {"ok": True})
            return

        if path == "/api/floorplan":
            if length > MAX_PLAN_BYTES:
                self._fail(400, "floor plan is larger than 30MB", bytes=length)
                return
            content_type = (self.headers.get("Content-Type") or "").lower()
            if "png" in content_type:
                extension = "png"
            elif "jpeg" in content_type or "jpg" in content_type:
                extension = "jpg"
            elif "webp" in content_type:
                extension = "webp"
            else:
                self._fail(400, "use a png, jpeg, or webp floor plan")
                return
            os.makedirs(PLANS, exist_ok=True)
            remove_floorplans()
            name = f"floorplan.{extension}"
            with open(os.path.join(PLANS, name), "wb") as handle:
                handle.write(body)
            log_event(logging.INFO, "floor plan saved", file=name, bytes=length)
            self._send_json(200, {"file": f"media/plans/{name}"})
            return

        self._fail(404, "not found")

    def do_DELETE(self):
        path = urlparse(self.path).path
        if path == "/api/floorplan":
            remove_floorplans()
            log_event(logging.INFO, "floor plan removed")
            self._send_json(200, {"ok": True})
            return
        self._fail(404, "not found")


def local_ips():
    ips = []
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.settimeout(0.2)
        sock.connect(("8.8.8.8", 80))
        ip = sock.getsockname()[0]
        if ip and not ip.startswith("127."):
            ips.append(ip)
    except OSError:
        pass
    finally:
        sock.close()
    return ips


def main():
    os.chdir(ROOT)
    ensure_thumbs()
    server = TourServer((HOST, PORT), Handler)
    log_event(logging.INFO, "home tour ready", url=f"http://127.0.0.1:{PORT}", editor=f"http://127.0.0.1:{PORT}/admin")
    for ip in local_ips():
        log_event(logging.INFO, "home tour on the network", url=f"http://{ip}:{PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log_event(logging.INFO, "stopped")


if __name__ == "__main__":
    main()
