"""Build the Chrome Web Store zip from extension/.

    python tools/package.py [--skip-tests]

Writes fifa-ticket-scout-<manifest version>.zip in the repo root, with the
contents of extension/ at the ZIP ROOT — not nested under an extension/ folder.
Chrome rejects a zip whose manifest.json is not at the top level, and the
existing 2.1.1 zip is laid out the same way.

Refuses to build if the version strings disagree. manifest.json is what Chrome
installs, version.json is what the popup's update banner compares against, and
the README badge is what people read; a mismatch means one of them is a lie.

Runs tests/run.py first — a parse error in background.js stops the service
worker from starting, and that is not something to discover after uploading.
"""

import io
import json
import os
import re
import subprocess
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SOURCE = os.path.join(ROOT, "extension")

# Everything Chrome needs and nothing else. Anything not matching is left out,
# so a stray note or backup in extension/ cannot reach the store.
INCLUDE_SUFFIXES = (".js", ".json", ".html", ".css", ".png")

# Belt and braces against shipping something private or irrelevant.
EXCLUDE_NAMES = {"desktop.ini", "Thumbs.db", ".DS_Store"}
EXCLUDE_PATTERNS = (
    re.compile(r"\.bak$", re.I),
    re.compile(r"\.orig$", re.I),
    re.compile(r"~$"),
    re.compile(r"^\."),
)


def manifest_version():
    with io.open(os.path.join(SOURCE, "manifest.json"), encoding="utf-8") as fh:
        return json.load(fh)["version"]


def check_versions(version):
    """manifest.json, version.json, and the README badge must agree."""
    problems = []

    vj = os.path.join(ROOT, "version.json")
    with io.open(vj, encoding="utf-8") as fh:
        latest = json.load(fh).get("latest")
    if latest != version:
        problems.append("version.json says %r, manifest says %r" % (latest, version))

    readme = os.path.join(ROOT, "README.md")
    with io.open(readme, encoding="utf-8") as fh:
        text = fh.read()
    badge = re.search(r"badge/version-([0-9.]+)-", text)
    if not badge:
        problems.append("README.md has no version badge to check")
    elif badge.group(1) != version:
        problems.append("README badge says %r, manifest says %r" % (badge.group(1), version))

    changelog = os.path.join(ROOT, "CHANGELOG.md")
    with io.open(changelog, encoding="utf-8") as fh:
        head = fh.read()
    if re.search(r"^## Unreleased", head, re.M):
        problems.append("CHANGELOG.md still has an 'Unreleased' heading")
    if ("v" + version) not in head:
        problems.append("CHANGELOG.md has no entry for v%s" % version)

    return problems


def wanted(name):
    if name in EXCLUDE_NAMES:
        return False
    if any(p.search(name) for p in EXCLUDE_PATTERNS):
        return False
    return name.lower().endswith(INCLUDE_SUFFIXES)


def collect():
    """(absolute path, archive name) for every file to ship, sorted."""
    found = []
    for dirpath, dirnames, filenames in os.walk(SOURCE):
        dirnames[:] = sorted(d for d in dirnames if not d.startswith("."))
        for name in sorted(filenames):
            if not wanted(name):
                continue
            full = os.path.join(dirpath, name)
            arc = os.path.relpath(full, SOURCE).replace("\\", "/")
            found.append((full, arc))
    return sorted(found, key=lambda pair: pair[1])


def main():
    skip_tests = "--skip-tests" in sys.argv[1:]

    version = manifest_version()

    problems = check_versions(version)
    if problems:
        print("Version strings disagree — not building:")
        for p in problems:
            print("  - " + p)
        return 2

    if not skip_tests:
        print("Running tests...")
        code = subprocess.call([sys.executable, os.path.join(ROOT, "tests", "run.py")])
        if code != 0:
            print("\nTests failed — not building.")
            return code
        print("")

    files = collect()
    if not any(arc == "manifest.json" for _, arc in files):
        print("No manifest.json at the root of extension/ — not building.")
        return 2

    out = os.path.join(ROOT, "fifa-ticket-scout-%s.zip" % version)
    if os.path.exists(out):
        print("Overwriting existing %s" % os.path.basename(out))

    # Deterministic: fixed timestamps and sorted entries, so rebuilding the same
    # source produces a byte-identical zip.
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for full, arc in files:
            info = zipfile.ZipInfo(arc, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            with io.open(full, "rb") as fh:
                z.writestr(info, fh.read())

    size = os.path.getsize(out)
    print("Built %s  (%d files, %.0f KB)" % (os.path.basename(out), len(files), size / 1024.0))
    for _, arc in files:
        print("   " + arc)

    if size > 10 * 1024 * 1024:
        print("\nWarning: over the Chrome Web Store's practical size comfort zone.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
