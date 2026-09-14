#!/usr/bin/env python3
"""Static checks for the Android (Kotlin) sources.

There is no JVM available in this sandbox, so `kotlinc` cannot run. These checks
catch the failure modes that have actually broken the CI build:

  * unbalanced braces / parens / brackets
  * a known platform or androidx class referenced without an import
    (this is exactly what produced "Unresolved reference: Build" before)
  * R.string / R.xml references that do not exist in res/
  * cross-file method calls whose target does not exist
"""

from __future__ import annotations

import pathlib
import re
import sys

# Resolved relative to this file so the checker works from any checkout.
REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
APP = REPO_ROOT / "src-tauri/gen/android/app/src/main"
KT_DIR = APP / "java/com/jieqibox/lineconnect"

# Simple class name -> fully qualified name, for the APIs these files may use.
KNOWN_CLASSES = {
    # android.*
    "AccessibilityEvent": "android.view.accessibility.AccessibilityEvent",
    "AccessibilityService": "android.accessibilityservice.AccessibilityService",
    "Activity": "android.app.Activity",
    "Base64": "android.util.Base64",
    "Bitmap": "android.graphics.Bitmap",
    "Build": "android.os.Build",
    "Bundle": "android.os.Bundle",
    "ByteArrayOutputStream": "java.io.ByteArrayOutputStream",
    "Canvas": "android.graphics.Canvas",
    "Color": "android.graphics.Color",
    "ColorStateList": "android.content.res.ColorStateList",
    "Context": "android.content.Context",
    "DisplayManager": "android.hardware.display.DisplayManager",
    "DisplayMetrics": "android.util.DisplayMetrics",
    "DocumentsContract": "android.provider.DocumentsContract",
    "Drawable": "android.graphics.drawable.Drawable",
    "File": "java.io.File",
    "FileOutputStream": "java.io.FileOutputStream",
    "FrameLayout": "android.widget.FrameLayout",
    "GestureDescription": "android.accessibilityservice.GestureDescription",
    "GradientDrawable": "android.graphics.drawable.GradientDrawable",
    "Gravity": "android.view.Gravity",
    "Handler": "android.os.Handler",
    "HandlerThread": "android.os.HandlerThread",
    "IBinder": "android.os.IBinder",
    "Image": "android.media.Image",
    "ImageReader": "android.media.ImageReader",
    "InputStream": "java.io.InputStream",
    "Intent": "android.content.Intent",
    "JSONObject": "org.json.JSONObject",
    "JavascriptInterface": "android.webkit.JavascriptInterface",
    "LinearLayout": "android.widget.LinearLayout",
    "Looper": "android.os.Looper",
    "Log": "android.util.Log",
    "MediaProjection": "android.media.projection.MediaProjection",
    "MediaProjectionManager": "android.media.projection.MediaProjectionManager",
    "MotionEvent": "android.view.MotionEvent",
    "Notification": "android.app.Notification",
    "NotificationChannel": "android.app.NotificationChannel",
    "NotificationManager": "android.app.NotificationManager",
    "Paint": "android.graphics.Paint",
    "Path": "android.graphics.Path",
    "PendingIntent": "android.app.PendingIntent",
    "PixelFormat": "android.graphics.PixelFormat",
    "RectF": "android.graphics.RectF",
    "RippleDrawable": "android.graphics.drawable.RippleDrawable",
    "Service": "android.app.Service",
    "ServiceInfo": "android.content.pm.ServiceInfo",
    "Settings": "android.provider.Settings",
    "TextView": "android.widget.TextView",
    "Typeface": "android.graphics.Typeface",
    "TypedValue": "android.util.TypedValue",
    "Uri": "android.net.Uri",
    "View": "android.view.View",
    "VirtualDisplay": "android.hardware.display.VirtualDisplay",
    "WebView": "android.webkit.WebView",
    "WindowManager": "android.view.WindowManager",
    # androidx (only the two the project declares)
    "ActivityResultContracts": "androidx.activity.result.contract.ActivityResultContracts",
    "DocumentFile": "androidx.documentfile.provider.DocumentFile",
}

failures: list[str] = []


def strip_code(src: str) -> str:
    """Remove comments and string literals so brace counting is accurate."""
    out = []
    i, n = 0, len(src)
    while i < n:
        c = src[i]
        if c == "/" and i + 1 < n and src[i + 1] == "/":
            while i < n and src[i] != "\n":
                i += 1
            continue
        if c == "/" and i + 1 < n and src[i + 1] == "*":
            i += 2
            while i + 1 < n and not (src[i] == "*" and src[i + 1] == "/"):
                i += 1
            i += 2
            continue
        if src.startswith('"""', i):
            i += 3
            while i < n and not src.startswith('"""', i):
                i += 1
            i += 3
            continue
        if c == '"':
            i += 1
            while i < n and src[i] != '"':
                if src[i] == "\\":
                    i += 1
                i += 1
            i += 1
            continue
        if c == "'":
            i += 1
            while i < n and src[i] != "'":
                if src[i] == "\\":
                    i += 1
                i += 1
            i += 1
            continue
        out.append(c)
        i += 1
    return "".join(out)


def check_balanced(path: pathlib.Path, src: str) -> None:
    code = strip_code(src)
    for open_c, close_c, name in (("{", "}", "brace"), ("(", ")", "paren"), ("[", "]", "bracket")):
        depth = 0
        line = 1
        for ch in code:
            if ch == "\n":
                line += 1
            elif ch == open_c:
                depth += 1
            elif ch == close_c:
                depth -= 1
                if depth < 0:
                    failures.append(f"{path.name}: extra '{close_c}' at line {line}")
                    return
        if depth != 0:
            failures.append(f"{path.name}: {depth} unclosed '{open_c}'")


def strip_comments(src: str) -> str:
    """Remove comments only, leaving string literals intact."""
    out = []
    i, n = 0, len(src)
    while i < n:
        c = src[i]
        if c == "/" and i + 1 < n and src[i + 1] == "/":
            while i < n and src[i] != "\n":
                i += 1
            continue
        if c == "/" and i + 1 < n and src[i + 1] == "*":
            i += 2
            while i + 1 < n and not (src[i] == "*" and src[i + 1] == "/"):
                i += 1
            i += 2
            out.append(" ")
            continue
        if c == '"':
            out.append(c)
            i += 1
            while i < n and src[i] != '"':
                out.append(src[i])
                if src[i] == "\\":
                    i += 1
                    out.append(src[i] if i < n else "")
                i += 1
            out.append('"')
            i += 1
            continue
        out.append(c)
        i += 1
    return "".join(out)


def check_imports(path: pathlib.Path, src: str) -> None:
    imported = set(re.findall(r"^import\s+([\w.]+)", src, flags=re.M))
    simple = {i.rsplit(".", 1)[-1] for i in imported}
    # Comments are dropped, and fully qualified references such as
    # `android.content.Intent` are not matches (the negative lookbehind rejects
    # a preceding word character or dot).
    body = strip_comments(re.sub(r"^import[^\n]*\n", "", src, flags=re.M))
    for cls, fq in KNOWN_CLASSES.items():
        if cls in simple:
            continue
        if re.search(rf"(?<![\w.]){cls}\b", body):
            failures.append(f"{path.name}: uses {cls} without 'import {fq}'")


HEX_PATTERN = re.compile(r"0[xX]([0-9A-Fa-f_]+)(\.toInt\(\))?(L)?")


def check_int_literals(path: pathlib.Path, src: str) -> None:
    """Hex literals above 0x7FFFFFFF are Long in Kotlin, not Int.

    Writing `0xFF1A1A1A` where an Int is expected fails to compile, so every such
    literal needs an explicit `.toInt()`.
    """
    code = strip_comments(src)
    for lineno, line in enumerate(code.splitlines(), 1):
        for m in HEX_PATTERN.finditer(line):
            digits = m.group(1).replace("_", "")
            if len(digits) < 8 or m.group(2) or m.group(3):
                continue
            try:
                value = int(digits, 16)
            except ValueError:
                continue
            if value >= 0x80000000:
                failures.append(
                    f"{path.name}:{lineno}: {m.group(0)} is a Long literal, add .toInt()"
                )


def check_resources() -> None:
    strings = (APP / "res/values/strings.xml").read_text(encoding="utf-8")
    defined = set(re.findall(r'name="([^"]+)"', strings))
    xml_files = {p.stem for p in (APP / "res/xml").glob("*.xml")}
    for kt in KT_DIR.glob("*.kt"):
        src = kt.read_text(encoding="utf-8")
        for name in re.findall(r"R\.string\.([A-Za-z0-9_]+)", src):
            if name not in defined:
                failures.append(f"{kt.name}: R.string.{name} is not defined in strings.xml")
        for name in re.findall(r"R\.xml\.([A-Za-z0-9_]+)", src):
            if name not in xml_files:
                failures.append(f"{kt.name}: R.xml.{name} does not exist")


def check_cross_calls() -> None:
    """Ensure the members other files call on a class actually exist."""
    sources = {p.name: p.read_text(encoding="utf-8") for p in KT_DIR.glob("*.kt")}

    def has_member(file_and_class: str, member: str) -> bool:
        return re.search(rf"\bfun\s+{member}\b|\bval\s+{member}\b|\bvar\s+{member}\b", sources[file_and_class]) is not None

    expectations = [
        ("MainActivity.kt", "dispatchJs"),
        ("MainActivity.kt", "moveToFront"),
        ("MainActivity.kt", "canDrawOverlaysNow"),
        ("MainActivity.kt", "requestLegacyStoragePermission"),
        ("ScreenCaptureService.kt", "ensureOverlay"),
        ("ScreenCaptureService.kt", "updateOverlay"),
        ("ScreenCaptureService.kt", "startJsTick"),
        ("ScreenCaptureService.kt", "stopJsTick"),
        ("ScreenCaptureService.kt", "captureFrameCropBase64"),
        ("ScreenCaptureService.kt", "frameChangeRatio"),
        ("ScreenCaptureService.kt", "ensureChessboard"),
        ("ScreenCaptureService.kt", "setChessboardFen"),
        ("ScreenCaptureService.kt", "setChessboardMoves"),
        ("ScreenCaptureService.kt", "setWatchRegion"),
        ("ScreenCaptureService.kt", "startSampleRecording"),
        ("ScreenCaptureService.kt", "saveSample"),
        ("ScreenCaptureService.kt", "sampleCount"),
        ("ScreenCaptureService.kt", "samplePath"),
        ("LineConnectOverlay.kt", "update"),
        ("LineConnectOverlay.kt", "show"),
        ("LineConnectOverlay.kt", "hide"),
        ("ChessboardOverlay.kt", "show"),
        ("ChessboardOverlay.kt", "hide"),
        ("ChessboardOverlay.kt", "setFen"),
        ("ChessboardOverlay.kt", "setMoves"),
    ]
    for file_and_class, member in expectations:
        if file_and_class not in sources:
            failures.append(f"missing file {file_and_class}")
        elif not has_member(file_and_class, member):
            failures.append(f"{file_and_class}: expected member '{member}' not found")

    # The service calls overlay.update(...) with named arguments; every name has
    # to exist or the Kotlin build fails.
    overlay = sources["LineConnectOverlay.kt"]
    match = re.search(r"fun update\((.*?)\n    \) \{", overlay, re.S)
    if not match:
        failures.append("LineConnectOverlay.kt: could not locate update() signature")
    else:
        params = set(re.findall(r"(\w+):", match.group(1)))
        for name in ("turn", "status", "evaluation", "waiting", "connectRunning",
                     "autoPlay", "autoEnabled", "boardVisible"):
            if name not in params:
                failures.append(f"LineConnectOverlay.update(): missing parameter '{name}'")

    svc = sources["ScreenCaptureService.kt"]
    match = re.search(r"fun updateOverlay\((.*?)\n    \) \{", svc, re.S)
    if not match:
        failures.append("ScreenCaptureService.kt: could not locate updateOverlay() signature")
    else:
        params = set(re.findall(r"(\w+):", match.group(1)))
        for name in ("turn", "status", "evaluation", "waiting", "connectRunning",
                     "autoPlay", "autoEnabled", "boardVisible"):
            if name not in params:
                failures.append(f"ScreenCaptureService.updateOverlay(): missing parameter '{name}'")


def check_manifest() -> None:
    manifest = (APP / "AndroidManifest.xml").read_text(encoding="utf-8")
    for klass in ("ScreenCaptureService", "AutoPlayAccessibilityService"):
        if klass not in manifest:
            failures.append(f"AndroidManifest.xml does not declare {klass}")
    for perm in ("SYSTEM_ALERT_WINDOW", "FOREGROUND_SERVICE_MEDIA_PROJECTION"):
        if perm not in manifest:
            failures.append(f"AndroidManifest.xml is missing {perm}")


def main() -> int:
    for kt in sorted(KT_DIR.glob("*.kt")):
        src = kt.read_text(encoding="utf-8")
        check_balanced(kt, src)
        check_imports(kt, src)
        check_int_literals(kt, src)
        print(f"  checked {kt.name}")
    check_resources()
    check_cross_calls()
    check_manifest()

    print()
    if failures:
        for f in failures:
            print("FAIL:", f)
        return 1
    print("ALL KOTLIN STATIC CHECKS PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
