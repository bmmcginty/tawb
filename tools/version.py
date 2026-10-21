#!/usr/bin/env python3
"""Keep the release version in one place and make a release commit and tag.

The version belongs to version.yml. package.json, package-lock.json and
shard.yml carry copies because their tools require them, and this program is
the only thing that writes those copies. A version command refuses to start
if any tracked file is modified or if crystal/ or src/ holds an untracked
file, then commits exactly those four files and tags the commit vX.Y.Z.

Run through the Makefile in normal use:

    make show-version
    make version
    make version 1.2.3
    make release
"""

from __future__ import annotations

import argparse
import json
import platform
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VERSION_FILES = ("version.yml", "package.json", "package-lock.json", "shard.yml")
SEMVER = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$")
VERSION_LINE = re.compile(r"(?m)^version:\s*(\S*)\s*$")


class VersionError(Exception):
    """An expected refusal, printed without a traceback."""


def read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except OSError as error:
        raise VersionError(f"cannot read {path}: {error}") from error


def write_text(path: Path, text: str) -> None:
    try:
        path.write_text(text, encoding="utf-8")
    except OSError as error:
        raise VersionError(f"cannot write {path}: {error}") from error


def parse_version(value: str) -> str:
    text = str(value).strip()
    if not SEMVER.fullmatch(text):
        raise VersionError(f"version must be three numbers such as 1.2.3, not {value!r}")
    return text


def read_version(root: Path = ROOT) -> str:
    path = root / "version.yml"
    text = read_text(path)
    found = VERSION_LINE.findall(text)
    if len(found) != 1:
        raise VersionError(f"{path} must contain exactly one version: line")
    return parse_version(found[0])


def replace_version_line(path: Path, version: str) -> None:
    text = read_text(path)
    replaced, count = VERSION_LINE.subn(f"version: {version}", text)
    if count != 1:
        raise VersionError(f"{path} must contain exactly one version: line")
    write_text(path, replaced)


def read_json(path: Path) -> dict:
    try:
        parsed = json.loads(read_text(path))
    except json.JSONDecodeError as error:
        raise VersionError(f"{path} is not valid JSON: {error}") from error
    if not isinstance(parsed, dict):
        raise VersionError(f"{path} must contain a JSON object")
    return parsed


def write_json(path: Path, value: dict) -> None:
    write_text(path, json.dumps(value, indent=2, ensure_ascii=False) + "\n")


def manifest_versions(root: Path = ROOT) -> dict[str, list[str]]:
    """Every version a manifest currently declares, keyed by file name."""
    package = read_json(root / "package.json")
    lock = read_json(root / "package-lock.json")
    shard_text = read_text(root / "shard.yml")
    shard_matches = VERSION_LINE.findall(shard_text)
    if len(shard_matches) != 1:
        raise VersionError(f"{root / 'shard.yml'} must contain exactly one version: line")

    packages = lock.get("packages")
    if not isinstance(packages, dict):
        raise VersionError(f"{root / 'package-lock.json'} has no packages object")
    lock_root = packages.get("")
    if not isinstance(lock_root, dict):
        raise VersionError(f"{root / 'package-lock.json'} has no packages[''] entry")
    return {
        "package.json": [str(package.get("version", ""))],
        "package-lock.json": [
            str(lock.get("version", "")),
            str(lock_root.get("version", "")),
        ],
        "shard.yml": [shard_matches[0]],
    }


def check_versions(root: Path = ROOT) -> None:
    version = read_version(root)
    problems = []
    for name, values in manifest_versions(root).items():
        for value in values:
            if value != version:
                problems.append(f"{name} says {value or '(missing)'}, expected {version}")
    if problems:
        raise VersionError(
            f"version.yml says {version}, but the manifests disagree:\n  "
            + "\n  ".join(problems)
        )


def write_version(root: Path, version: str) -> None:
    version = parse_version(version)

    # Read and validate every destination before writing any of them, so a
    # malformed manifest cannot leave the tree half-versioned.
    package_path = root / "package.json"
    package = read_json(package_path)
    lock_path = root / "package-lock.json"
    lock = read_json(lock_path)
    packages = lock.get("packages")
    if not isinstance(packages, dict) or not isinstance(packages.get(""), dict):
        raise VersionError(f"{lock_path} has no packages[''] entry to version")
    read_version(root)
    shard_text = read_text(root / "shard.yml")
    if len(VERSION_LINE.findall(shard_text)) != 1:
        raise VersionError(f"{root / 'shard.yml'} must contain exactly one version: line")

    replace_version_line(root / "version.yml", version)
    package["version"] = version
    write_json(package_path, package)
    lock["version"] = version
    packages[""]["version"] = version
    write_json(lock_path, lock)
    replace_version_line(root / "shard.yml", version)
    check_versions(root)


def run_git(root: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess:
    result = subprocess.run(
        ["git", *args],
        cwd=root,
        text=True,
        capture_output=True,
    )
    if check and result.returncode != 0:
        detail = (result.stderr or result.stdout or "").strip()
        raise VersionError(f"git {' '.join(args)} failed: {detail}")
    return result


def ensure_repository(root: Path) -> None:
    result = run_git(root, "rev-parse", "--show-toplevel")
    top = Path(result.stdout.strip()).resolve()
    if top != root.resolve():
        raise VersionError(f"{root} is not the root of a Git repository")


def ensure_clean(root: Path) -> None:
    # "Clean" here has a precise meaning. A tracked file must not be modified
    # anywhere, because committing the version files would otherwise leave a
    # release commit carrying somebody else's unfinished work. An untracked
    # file is different: scratch files at the top of the checkout are common,
    # but a new file under crystal/ or src/ is program source that the release
    # would not contain.
    modified = run_git(
        root, "status", "--porcelain", "--untracked-files=no"
    ).stdout.rstrip("\n")
    new_source = run_git(
        root, "ls-files", "--others", "--exclude-standard", "--", "crystal", "src"
    ).stdout.rstrip("\n")
    if not modified and not new_source:
        return

    details = ["the working tree has changes a version bump must not absorb"]
    if modified:
        details.append("Modified or staged tracked files:\n" + modified)
    if new_source:
        details.append("Untracked files under crystal/ or src/:\n" + new_source)
    details.append("Commit, remove or ignore them before changing the version.")
    raise VersionError("\n".join(details))


def tag_name(version: str) -> str:
    return f"v{version}"


def ensure_tag_absent(root: Path, version: str) -> None:
    name = tag_name(version)
    result = run_git(root, "rev-parse", "--verify", "--quiet", f"refs/tags/{name}", check=False)
    if result.returncode == 0:
        raise VersionError(f"tag {name} already exists")


def bump_patch(version: str) -> str:
    major, minor, patch = (int(part) for part in parse_version(version).split("."))
    return f"{major}.{minor}.{patch + 1}"


def commit_and_tag(root: Path, version: str) -> None:
    run_git(root, "add", "--", *VERSION_FILES)
    staged = set(run_git(root, "diff", "--cached", "--name-only").stdout.splitlines())
    expected = set(VERSION_FILES)
    if staged != expected:
        unexpected = sorted(staged - expected)
        missing = sorted(expected - staged)
        detail = []
        if unexpected:
            detail.append("unexpected: " + ", ".join(unexpected))
        if missing:
            detail.append("missing: " + ", ".join(missing))
        raise VersionError("the staged change is not exactly the version files: " + "; ".join(detail))

    run_git(root, "commit", "-m", f"Release {tag_name(version)}")
    run_git(root, "tag", "-a", tag_name(version), "-m", f"Release {tag_name(version)}")


def change_version(root: Path, version: str) -> None:
    version = parse_version(version)
    ensure_repository(root)
    ensure_clean(root)
    ensure_tag_absent(root, version)
    current = read_version(root)
    if current == version:
        raise VersionError(f"the current version is already {version}")
    write_version(root, version)
    commit_and_tag(root, version)
    print(tag_name(version))


def show(root: Path) -> None:
    print(read_version(root))


def check(root: Path) -> None:
    check_versions(root)


def release(root: Path) -> None:
    version = read_version(root)
    name = tag_name(version)
    ensure_repository(root)
    ensure_clean(root)

    tags = set(run_git(root, "tag", "--points-at", "HEAD").stdout.splitlines())
    if name not in tags:
        raise VersionError(f"HEAD is not pointed to by {name}; make version first")

    gh = shutil.which("gh")
    if not gh:
        raise VersionError("gh is not installed; install the GitHub CLI to publish a release")

    auth = subprocess.run([gh, "auth", "status"], capture_output=True, text=True)
    if auth.returncode != 0:
        detail = (auth.stderr or auth.stdout or "").strip()
        raise VersionError(f"gh is not authenticated: {detail}")

    remote = run_git(root, "remote", "get-url", "origin", check=False)
    if remote.returncode != 0:
        raise VersionError("there is no origin remote to publish the release to")

    remote_tag = run_git(
        root, "ls-remote", "--exit-code", "--tags", "origin", f"refs/tags/{name}", check=False
    )
    if remote_tag.returncode != 0:
        raise VersionError(
            f"tag {name} is not on origin; push it first with: git push origin {name}"
        )

    existing = subprocess.run(
        [gh, "release", "view", name],
        cwd=root,
        text=True,
        capture_output=True,
    )
    if existing.returncode == 0:
        raise VersionError(f"GitHub release {name} already exists")

    with tempfile.TemporaryDirectory(prefix="tawb-release-") as temporary:
        machine = platform.machine() or "unknown"
        asset = Path(temporary) / f"tawb-{name}-linux-{machine}"
        build = subprocess.run(
            [str(root / "tools" / "build_crystal.sh"), str(asset)],
            cwd=root,
            text=True,
        )
        if build.returncode != 0:
            raise VersionError("building the release binary failed")

        created = subprocess.run(
            [
                gh,
                "release",
                "create",
                name,
                "--verify-tag",
                "--title",
                name,
                "--generate-notes",
                str(asset),
            ],
            cwd=root,
            text=True,
        )
        if created.returncode != 0:
            raise VersionError(f"gh release create {name} failed")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="tools/version.py",
        description="Read, change and release the version recorded in version.yml.",
    )
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("show", help="print the current version")
    commands.add_parser("bump", help="increase the patch version, commit and tag")
    set_parser = commands.add_parser("set", help="set an explicit version, commit and tag")
    set_parser.add_argument("version", metavar="X.Y.Z")
    commands.add_parser("check", help="verify that every manifest agrees with version.yml")
    commands.add_parser("release", help="create the GitHub release for the tagged HEAD")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "show":
            show(ROOT)
        elif args.command == "bump":
            change_version(ROOT, bump_patch(read_version(ROOT)))
        elif args.command == "set":
            change_version(ROOT, args.version)
        elif args.command == "check":
            check(ROOT)
        elif args.command == "release":
            release(ROOT)
        else:
            raise VersionError(f"unknown command {args.command}")
    except VersionError as error:
        print(f"version: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
