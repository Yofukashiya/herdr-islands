"""Prepares a release: sets `version` in every mod.json and turns CHANGELOG.md's [Unreleased]
section into this version's. Then commit, tag and publish (the commands are printed at the end).

The Mods panel offers an update when GitHub's latest release is newer than the installed
mod.json version, so both have to move together: that's what this script is for.

    python tools/release.py 1.2.0
"""
import datetime
import glob
import json
import os
import re
import sys

REPO = "Yofukashiya/herdr-islands"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def main(version):
    if not re.fullmatch(r"\d+\.\d+\.\d+", version):
        sys.exit("Version must look like 1.2.0")

    for path in sorted(glob.glob(os.path.join(ROOT, "mods", "*", "mod.json"))):
        meta = json.load(open(path, encoding="utf-8"))
        meta["version"] = version
        open(path, "w", encoding="utf-8", newline="\n").write(json.dumps(meta, indent=2, ensure_ascii=False) + "\n")
    print("mod.json version ->", version)

    path = os.path.join(ROOT, "CHANGELOG.md")
    text = open(path, encoding="utf-8").read()
    if f"## [{version}]" in text:
        sys.exit(f"CHANGELOG.md already has {version}")
    head, sep, rest = text.partition("## [Unreleased]\n")
    if not sep:
        sys.exit("CHANGELOG.md has no ## [Unreleased] section")
    body, nxt, tail = rest.partition("\n## [")
    if not body.strip():
        sys.exit("Nothing under [Unreleased]: write the changes first")
    today = datetime.date.today().isoformat()
    prev = re.match(r"([^\]]+)\]", tail).group(1) if nxt else None
    text = f"{head}## [Unreleased]\n\n## [{version}] - {today}\n{body.rstrip()}\n" + (f"\n## [{tail}" if nxt else "")
    text = re.sub(r"^\[Unreleased\]: .*$", f"[Unreleased]: https://github.com/{REPO}/compare/v{version}...HEAD", text, flags=re.M)
    link = f"[{version}]: https://github.com/{REPO}/" + (f"compare/v{prev}...v{version}" if prev else f"releases/tag/v{version}")
    text = re.sub(r"^(\[Unreleased\]: .*)$", lambda m: m.group(1) + "\n" + link, text, count=1, flags=re.M)
    open(path, "w", encoding="utf-8", newline="\n").write(text)
    print(f"CHANGELOG.md: [Unreleased] -> [{version}] - {today}")

    print(f"""
Next:
  git add -A && git commit -m "Release {version}"
  git tag -a v{version} -m "Herdr Islands {version}" && git push && git push origin v{version}
  gh release create v{version} --repo {REPO} --title "Herdr Islands {version}" --notes "<the {version} section of CHANGELOG.md>"
""")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "")
