"""Run the extension's test pages in headless Chrome; exit non-zero on failure.

There is no node on the machines this was built on, but Chrome is always there —
it is what the extension targets anyway, so this is the more faithful harness.

    python tests/run.py

Runs two pages, each by dumping the rendered DOM and reading a result marker
out of <pre id="out">:

    tests/syntax.html   parse-checks every extension script
    tests/runner.html   the tiers.js unit tests

The syntax page goes first. A parse error in background.js stops the service
worker from starting at all, and one in popup.js leaves the popup blank — both
look exactly like "my changes did not apply", and neither is visible until you
load the extension in Chrome.
"""

import os
import re
import shutil
import subprocess
import sys
import tempfile

CHROME_CANDIDATES = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    os.path.expandvars(r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"),
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
]

PAGES = [
    ("syntax.html", "SYNTAX-RESULT"),
    ("runner.html", "TIERS-RESULT"),
]


def find_browser():
    for path in CHROME_CANDIDATES:
        if path and os.path.exists(path):
            return path
    return (shutil.which("chrome") or shutil.which("chromium")
            or shutil.which("msedge"))


def run_page(browser, page, marker):
    """Load one test page headlessly. Returns (exit_code, printable_output)."""
    if not os.path.exists(page):
        return 2, "Missing " + page

    # A throwaway profile: without it Chrome attaches to the user's running
    # instance and --dump-dom prints nothing.
    profile = tempfile.mkdtemp(prefix="tiers-test-")
    try:
        proc = subprocess.run(
            [
                browser,
                "--headless=new",
                "--disable-gpu",
                "--no-first-run",
                "--no-default-browser-check",
                "--allow-file-access-from-files",
                "--user-data-dir=" + profile,
                "--virtual-time-budget=5000",
                "--dump-dom",
                "file:///" + page.replace("\\", "/"),
            ],
            capture_output=True,
            text=True,
            timeout=120,
        )
    except subprocess.TimeoutExpired:
        return 2, "Browser timed out on " + os.path.basename(page)
    finally:
        shutil.rmtree(profile, ignore_errors=True)

    dom = proc.stdout or ""
    match = re.search(marker + r": (PASS|FAIL) (\d+)/(\d+)", dom)
    if not match:
        detail = [
            "%s did not report a result. Browser exited %s."
            % (os.path.basename(page), proc.returncode),
            "--- stdout ---",
            dom[:4000] or "(empty)",
            "--- stderr ---",
            (proc.stderr or "(empty)")[:2000],
        ]
        return 2, "\n".join(detail)

    body = re.search(r'<pre id="out">(.*?)</pre>', dom, re.S)
    if body:
        text = body.group(1)
        text = text.replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&")
        text = text.strip()
    else:
        text = match.group(0)

    return (0 if match.group(1) == "PASS" else 1), text


def main():
    browser = find_browser()
    if not browser:
        print("No Chrome/Chromium/Edge found. Tried:")
        for path in CHROME_CANDIDATES:
            print("  " + path)
        return 2

    here = os.path.dirname(os.path.abspath(__file__))

    worst = 0
    for name, marker in PAGES:
        code, text = run_page(browser, os.path.join(here, name), marker)
        print(text)
        worst = max(worst, code)
        # A parse error makes the unit tests meaningless — stop and say so.
        if code and marker == "SYNTAX-RESULT":
            print("\nSkipping the unit tests: fix the parse error first.")
            return code

    return worst


if __name__ == "__main__":
    sys.exit(main())
