from __future__ import annotations

import ctypes
import json
import os
import re
import sys
import threading
import time
import uuid
import webbrowser
from ctypes import wintypes
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

HOST = "127.0.0.1"
PORT = 8765
ROOT = Path(__file__).resolve().parent
RECORDINGS_DIR = (Path.home() / "Videos" / "Kanrecode")
RECORDINGS_DIR.mkdir(parents=True, exist_ok=True)

EVENT_LOCK = threading.Lock()
EVENTS: list[dict] = []
EVENT_ID = 0
CAPTURE_STATE = {"keys": False, "pointer": True}
ACTIVE_RECORDINGS: dict[str, dict] = {}

SAFE_FILENAME = re.compile(r"[^\w\-. ()]+", re.UNICODE)


def push_event(event_type: str, **payload):
    global EVENT_ID
    with EVENT_LOCK:
        EVENT_ID += 1
        item = {"id": EVENT_ID, "type": event_type, "ts": time.time(), **payload}
        EVENTS.append(item)
        if len(EVENTS) > 800:
            del EVENTS[:-500]


def get_events(since: int):
    with EVENT_LOCK:
        return [e for e in EVENTS if e["id"] > since]


def sanitize_filename(name: str) -> str:
    clean = SAFE_FILENAME.sub("_", (name or "Kanrecode-recording").strip())
    clean = clean.strip(" ._")[:120]
    return clean or "Kanrecode-recording"


def unique_path(base: str, extension: str) -> Path:
    stamp = time.strftime("%Y-%m-%d_%H-%M-%S")
    candidate = RECORDINGS_DIR / f"{base}_{stamp}.{extension}"
    index = 2
    while candidate.exists() or candidate.with_name(candidate.stem + ".partial" + candidate.suffix).exists():
        candidate = RECORDINGS_DIR / f"{base}_{stamp}_{index}.{extension}"
        index += 1
    return candidate


def list_recovery_files():
    items = []
    for p in sorted(RECORDINGS_DIR.glob("*.partial.*"), key=lambda x: x.stat().st_mtime, reverse=True):
        try:
            items.append({
                "name": p.name,
                "size": p.stat().st_size,
                "modified": p.stat().st_mtime,
            })
        except OSError:
            pass
    return items[:20]


def close_all_recordings():
    for session in list(ACTIVE_RECORDINGS.values()):
        try:
            session["file"].flush()
            os.fsync(session["file"].fileno())
            session["file"].close()
        except Exception:
            pass


# -------------------------
# Optional Windows desktop hooks
# -------------------------
IS_WINDOWS = os.name == "nt"
HOOK_THREAD = None

if IS_WINDOWS:
    user32 = ctypes.windll.user32
    kernel32 = ctypes.windll.kernel32

    WH_KEYBOARD_LL = 13
    WH_MOUSE_LL = 14

    WM_KEYDOWN = 0x0100
    WM_SYSKEYDOWN = 0x0104
    WM_KEYUP = 0x0101
    WM_SYSKEYUP = 0x0105

    WM_MOUSEMOVE = 0x0200
    WM_LBUTTONDOWN = 0x0201
    WM_RBUTTONDOWN = 0x0204
    WM_MBUTTONDOWN = 0x0207

    VK_SHIFT = 0x10
    VK_CONTROL = 0x11
    VK_MENU = 0x12
    VK_LWIN = 0x5B
    VK_RWIN = 0x5C

    SM_XVIRTUALSCREEN = 76
    SM_YVIRTUALSCREEN = 77
    SM_CXVIRTUALSCREEN = 78
    SM_CYVIRTUALSCREEN = 79

    class KBDLLHOOKSTRUCT(ctypes.Structure):
        _fields_ = [
            ("vkCode", wintypes.DWORD),
            ("scanCode", wintypes.DWORD),
            ("flags", wintypes.DWORD),
            ("time", wintypes.DWORD),
            ("dwExtraInfo", ctypes.POINTER(ctypes.c_ulong)),
        ]

    class MSLLHOOKSTRUCT(ctypes.Structure):
        _fields_ = [
            ("pt", wintypes.POINT),
            ("mouseData", wintypes.DWORD),
            ("flags", wintypes.DWORD),
            ("time", wintypes.DWORD),
            ("dwExtraInfo", ctypes.POINTER(ctypes.c_ulong)),
        ]

    LOWLEVELPROC = ctypes.WINFUNCTYPE(ctypes.c_long, ctypes.c_int, wintypes.WPARAM, wintypes.LPARAM)

    MODIFIER_VKS = {VK_CONTROL: "Ctrl", VK_SHIFT: "Shift", VK_MENU: "Alt", VK_LWIN: "Win", VK_RWIN: "Win"}
    modifiers = {"Ctrl": False, "Shift": False, "Alt": False, "Win": False}
    pressed = set()
    last_move_emit = 0.0

    SPECIAL_KEYS = {
        0x08: "Backspace", 0x09: "Tab", 0x0D: "Enter", 0x1B: "Esc", 0x20: "Space",
        0x21: "PageUp", 0x22: "PageDown", 0x23: "End", 0x24: "Home",
        0x25: "←", 0x26: "↑", 0x27: "→", 0x28: "↓",
        0x2D: "Insert", 0x2E: "Delete",
    }
    for i in range(1, 13):
        SPECIAL_KEYS[0x6F + i] = f"F{i}"

    RESERVED = {
        "F9": "record-toggle",
        "F10": "pause-toggle",
        "Ctrl+Shift+K": "keys-toggle",
        "Ctrl+Shift+D": "draw-toggle",
        "Ctrl+Shift+R": "crop",
        "Ctrl+Shift+J": "zoom-toggle",
    }

    def key_name(vk: int):
        if vk in MODIFIER_VKS:
            return MODIFIER_VKS[vk]
        if vk in SPECIAL_KEYS:
            return SPECIAL_KEYS[vk]
        if 0x30 <= vk <= 0x39:
            return chr(vk)
        if 0x41 <= vk <= 0x5A:
            return chr(vk)
        if 0x60 <= vk <= 0x69:
            return f"Num{vk - 0x60}"
        return None

    def combo_for(key: str):
        parts = []
        for name in ("Ctrl", "Shift", "Alt", "Win"):
            if modifiers[name] and key != name:
                parts.append(name)
        parts.append(key)
        return "+".join(parts)

    def keyboard_proc(nCode, wParam, lParam):
        if nCode >= 0:
            info = ctypes.cast(lParam, ctypes.POINTER(KBDLLHOOKSTRUCT)).contents
            vk = int(info.vkCode)
            is_down = wParam in (WM_KEYDOWN, WM_SYSKEYDOWN)
            is_up = wParam in (WM_KEYUP, WM_SYSKEYUP)

            if is_down:
                if vk in MODIFIER_VKS:
                    modifiers[MODIFIER_VKS[vk]] = True

                if vk not in pressed:
                    pressed.add(vk)
                    key = key_name(vk)
                    if key:
                        combo = combo_for(key)
                        action = RESERVED.get(combo)
                        if action:
                            push_event("shortcut", action=action, text=combo)

                        if CAPTURE_STATE.get("keys"):
                            has_strong_modifier = modifiers["Ctrl"] or modifiers["Alt"] or modifiers["Win"]
                            is_special = key in SPECIAL_KEYS.values() or key in ("Ctrl", "Shift", "Alt", "Win")
                            # Privacy rule: never forward plain typed letters/numbers.
                            # Only shortcuts/navigation/function keys are exposed.
                            if is_special or has_strong_modifier:
                                push_event("key", text=combo)

            if is_up:
                pressed.discard(vk)
                if vk in MODIFIER_VKS:
                    modifiers[MODIFIER_VKS[vk]] = False

        return user32.CallNextHookEx(None, nCode, wParam, lParam)

    def pointer_normalized(x: int, y: int):
        vx = user32.GetSystemMetrics(SM_XVIRTUALSCREEN)
        vy = user32.GetSystemMetrics(SM_YVIRTUALSCREEN)
        vw = max(1, user32.GetSystemMetrics(SM_CXVIRTUALSCREEN))
        vh = max(1, user32.GetSystemMetrics(SM_CYVIRTUALSCREEN))
        return (x - vx) / vw, (y - vy) / vh

    def mouse_proc(nCode, wParam, lParam):
        global last_move_emit
        if nCode >= 0 and CAPTURE_STATE.get("pointer"):
            info = ctypes.cast(lParam, ctypes.POINTER(MSLLHOOKSTRUCT)).contents
            x, y = int(info.pt.x), int(info.pt.y)
            xn, yn = pointer_normalized(x, y)
            now = time.time()

            if wParam == WM_MOUSEMOVE:
                if now - last_move_emit >= 0.045:
                    last_move_emit = now
                    push_event("pointer", x=xn, y=yn)
            elif wParam in (WM_LBUTTONDOWN, WM_RBUTTONDOWN, WM_MBUTTONDOWN):
                button = "left" if wParam == WM_LBUTTONDOWN else "right" if wParam == WM_RBUTTONDOWN else "middle"
                push_event("click", x=xn, y=yn, button=button)

        return user32.CallNextHookEx(None, nCode, wParam, lParam)

    KEYBOARD_PROC = LOWLEVELPROC(keyboard_proc)
    MOUSE_PROC = LOWLEVELPROC(mouse_proc)

    def hook_loop():
        keyboard_hook = user32.SetWindowsHookExW(WH_KEYBOARD_LL, KEYBOARD_PROC, kernel32.GetModuleHandleW(None), 0)
        mouse_hook = user32.SetWindowsHookExW(WH_MOUSE_LL, MOUSE_PROC, kernel32.GetModuleHandleW(None), 0)

        if not keyboard_hook or not mouse_hook:
            push_event("helper-warning", message="Không thể bật hook bàn phím/chuột Windows.")
            return

        msg = wintypes.MSG()
        while user32.GetMessageW(ctypes.byref(msg), None, 0, 0) != 0:
            user32.TranslateMessage(ctypes.byref(msg))
            user32.DispatchMessageW(ctypes.byref(msg))

        user32.UnhookWindowsHookEx(keyboard_hook)
        user32.UnhookWindowsHookEx(mouse_hook)


class Handler(SimpleHTTPRequestHandler):
    server_version = "KanrecodeHelper/1.1"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, format, *args):
        if not self.path.startswith("/api/"):
            super().log_message(format, *args)

    def send_json(self, obj, status=HTTPStatus.OK):
        raw = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(raw)

    def read_json(self):
        length = int(self.headers.get("Content-Length", "0") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:
            return {}

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/health":
            self.send_json({
                "ok": True,
                "helper": True,
                "windowsHooks": bool(IS_WINDOWS),
                "recordingsDir": str(RECORDINGS_DIR),
                "recovery": list_recovery_files(),
            })
            return

        if parsed.path == "/api/events":
            query = parse_qs(parsed.query)
            try:
                since = int(query.get("since", ["0"])[0])
            except ValueError:
                since = 0
            events = get_events(since)
            self.send_json({"ok": True, "events": events, "lastId": events[-1]["id"] if events else since})
            return

        if parsed.path == "/api/recovery":
            self.send_json({"ok": True, "items": list_recovery_files()})
            return

        super().do_GET()

    def do_POST(self):
        parsed = urlparse(self.path)

        if parsed.path == "/api/state":
            body = self.read_json()
            CAPTURE_STATE["keys"] = bool(body.get("keys"))
            CAPTURE_STATE["pointer"] = bool(body.get("pointer", True))
            self.send_json({"ok": True, "state": CAPTURE_STATE})
            return

        if parsed.path == "/api/open-recordings":
            try:
                if IS_WINDOWS:
                    os.startfile(str(RECORDINGS_DIR))
                else:
                    import subprocess
                    subprocess.Popen(["xdg-open", str(RECORDINGS_DIR)])
                self.send_json({"ok": True})
            except Exception as exc:
                self.send_json({"ok": False, "error": str(exc)}, HTTPStatus.INTERNAL_SERVER_ERROR)
            return

        if parsed.path == "/api/recording/start":
            body = self.read_json()
            extension = str(body.get("extension", "webm")).lower()
            if extension not in {"webm", "mp4"}:
                extension = "webm"
            base = sanitize_filename(str(body.get("filename", "Kanrecode-recording")))
            final_path = unique_path(base, extension)
            partial_path = final_path.with_name(final_path.stem + ".partial" + final_path.suffix)

            try:
                file_obj = open(partial_path, "wb", buffering=0)
                session_id = uuid.uuid4().hex
                ACTIVE_RECORDINGS[session_id] = {
                    "file": file_obj,
                    "partial": partial_path,
                    "final": final_path,
                    "bytes": 0,
                    "lastSync": time.time(),
                }
                self.send_json({
                    "ok": True,
                    "id": session_id,
                    "partialPath": str(partial_path),
                    "finalPath": str(final_path),
                })
            except Exception as exc:
                self.send_json({"ok": False, "error": str(exc)}, HTTPStatus.INTERNAL_SERVER_ERROR)
            return

        if parsed.path == "/api/recording/chunk":
            query = parse_qs(parsed.query)
            session_id = query.get("id", [""])[0]
            session = ACTIVE_RECORDINGS.get(session_id)
            if not session:
                self.send_json({"ok": False, "error": "Recording session not found."}, HTTPStatus.NOT_FOUND)
                return

            length = int(self.headers.get("Content-Length", "0") or 0)
            data = self.rfile.read(length) if length else b""

            try:
                session["file"].write(data)
                session["bytes"] += len(data)
                now = time.time()
                if now - session["lastSync"] >= 4:
                    session["file"].flush()
                    os.fsync(session["file"].fileno())
                    session["lastSync"] = now
                self.send_json({"ok": True, "bytes": session["bytes"]})
            except Exception as exc:
                self.send_json({"ok": False, "error": str(exc)}, HTTPStatus.INTERNAL_SERVER_ERROR)
            return

        if parsed.path == "/api/recording/finish":
            body = self.read_json()
            session_id = str(body.get("id", ""))
            session = ACTIVE_RECORDINGS.pop(session_id, None)
            if not session:
                self.send_json({"ok": False, "error": "Recording session not found."}, HTTPStatus.NOT_FOUND)
                return

            try:
                session["file"].flush()
                os.fsync(session["file"].fileno())
                session["file"].close()
                os.replace(session["partial"], session["final"])
                self.send_json({
                    "ok": True,
                    "path": str(session["final"]),
                    "bytes": session["bytes"],
                })
            except Exception as exc:
                try:
                    session["file"].close()
                except Exception:
                    pass
                self.send_json({
                    "ok": False,
                    "error": str(exc),
                    "partialPath": str(session["partial"]),
                }, HTTPStatus.INTERNAL_SERVER_ERROR)
            return

        self.send_json({"ok": False, "error": "Unknown API endpoint."}, HTTPStatus.NOT_FOUND)


def main():
    global HOOK_THREAD

    if IS_WINDOWS:
        HOOK_THREAD = threading.Thread(target=hook_loop, daemon=True, name="KanrecodeWindowsHooks")
        HOOK_THREAD.start()

    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print("=" * 52)
    print("KANRECODE DESKTOP HELPER")
    print(f"Web: http://{HOST}:{PORT}")
    print(f"Video dai: {RECORDINGS_DIR}")
    print("Phim chu don le KHONG duoc ghi/luu; chi phim chuc nang va shortcut.")
    print("Dong cua so nay de tat Kanrecode Helper.")
    print("=" * 52)

    threading.Timer(0.8, lambda: webbrowser.open(f"http://{HOST}:{PORT}")).start()

    try:
        server.serve_forever(poll_interval=0.3)
    except KeyboardInterrupt:
        pass
    finally:
        close_all_recordings()
        server.server_close()


if __name__ == "__main__":
    main()
