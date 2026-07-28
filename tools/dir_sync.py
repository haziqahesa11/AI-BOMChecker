"""Shared incremental directory-sync helpers for pushing local data trees to
the AI-BOMChecker "online" instance over SSH.

Used by sync_npi_data.py and sync_wts_data.py. There's no rsync on Windows,
so this does its own size/mtime diff against a remote listing and only
transfers new/changed files, instead of a full re-copy every run.
"""

import json
import os
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

# Some filenames in these data trees contain characters (e.g. CJK) outside
# Windows' default console codepage (cp1252/cp950/etc) -- reconfigure so
# printing a relpath never crashes the whole run over a cosmetic
# console-encoding mismatch.
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

MTIME_TOLERANCE_SECONDS = 2  # tar extraction truncates to whole seconds
DISK_SAFETY_MULTIPLIER = 3  # covers incoming tar + staging extract + final copy coexisting transiently

# Shipped to the server once per run and executed there with python3 (already
# required for wts_fetch.py) -- avoids embedding Python source inside an ssh
# command string, and avoids any local shell parsing of remote filenames
# (some contain spaces/parentheses).
_REMOTE_INVENTORY_CODE = '''
import sys, os, json
root = sys.argv[1]
if not os.path.isdir(root):
    print(json.dumps({"exists": False, "files": {}}))
    sys.exit(0)
files = {}
for dirpath, _dirnames, filenames in os.walk(root):
    for fname in filenames:
        fpath = os.path.join(dirpath, fname)
        relpath = os.path.relpath(fpath, root).replace(os.sep, "/")
        st = os.stat(fpath)
        files[relpath] = [st.st_size, int(st.st_mtime)]
print(json.dumps({"exists": True, "files": files}))
'''


def run(cmd, **kwargs):
    print(f"$ {' '.join(cmd)}")
    result = subprocess.run(cmd, **kwargs)
    if result.returncode != 0:
        print(f"Command failed with exit code {result.returncode}", file=sys.stderr)
        sys.exit(result.returncode)
    return result


def _winlong(path: Path) -> str:
    # Some data-tree paths exceed Windows' 260-char MAX_PATH (deeply nested
    # folders with long filenames). The \\?\ extended-length prefix bypasses
    # that limit for os.stat()/open() without needing a long-paths policy
    # change on the machine.
    if os.name != "nt":
        return str(path)
    s = str(path.resolve())
    return s if s.startswith("\\\\?\\") else "\\\\?\\" + s


def local_inventory(root: Path) -> dict:
    files = {}
    for dirpath, _dirnames, filenames in os.walk(root):
        for fname in filenames:
            fpath = Path(dirpath) / fname
            relpath = fpath.relative_to(root).as_posix()
            st = os.stat(_winlong(fpath))
            files[relpath] = (st.st_size, int(st.st_mtime))
    return files


def remote_inventory(ssh_host: str, remote_dir: str, inventory_script_path: str) -> dict:
    fd, local_script_path = tempfile.mkstemp(suffix=".py")
    with os.fdopen(fd, "w") as f:
        f.write(_REMOTE_INVENTORY_CODE)
    try:
        run(["scp", "-o", "BatchMode=yes", local_script_path, f"{ssh_host}:{inventory_script_path}"])
        result = subprocess.run(
            ["ssh", "-o", "BatchMode=yes", ssh_host, f"python3 {inventory_script_path} {remote_dir}"],
            capture_output=True, text=True,
        )
    finally:
        os.unlink(local_script_path)
    if result.returncode != 0:
        print(result.stderr, file=sys.stderr)
        print("Failed to read remote inventory", file=sys.stderr)
        sys.exit(1)
    data = json.loads(result.stdout)
    return {relpath: tuple(v) for relpath, v in data["files"].items()}


def diff_inventories(local: dict, remote: dict) -> list:
    changed = []
    for relpath, (size, mtime) in local.items():
        r = remote.get(relpath)
        if r is None or r[0] != size or abs(r[1] - mtime) > MTIME_TOLERANCE_SECONDS:
            changed.append(relpath)
    return changed


def remote_avail_bytes(ssh_host: str) -> int:
    result = subprocess.run(
        ["ssh", "-o", "BatchMode=yes", ssh_host, "df --output=avail -B1 ~ | tail -1"],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        print(result.stderr, file=sys.stderr)
        print("Failed to check remote disk space", file=sys.stderr)
        sys.exit(1)
    return int(result.stdout.strip())


def build_tar_to_tempfile(local_dir: Path, changed_relpaths: list) -> tuple:
    # A temp file on disk, not an in-memory buffer -- these trees can run
    # into the gigabytes. No gzip: the data is almost entirely
    # already-compressed formats (xlsx/pptx/docx/pdf/zip), so compression
    # would spend real CPU for little size benefit.
    fd, tar_path = tempfile.mkstemp(suffix=".tar")
    os.close(fd)
    skipped = []
    with tarfile.open(tar_path, mode="w") as tar:
        for relpath in changed_relpaths:
            try:
                tar.add(_winlong(local_dir / relpath), arcname=relpath)
            except (PermissionError, OSError) as exc:
                # e.g. a file open in Excel right now, or a OneDrive placeholder
                # mid-hydration. Skip it rather than abort the whole sync --
                # this script is meant to be re-run, so it'll pick the file up
                # once it's no longer locked.
                print(f"  SKIP (locked/unreadable): {relpath} -- {exc}", file=sys.stderr)
                skipped.append(relpath)
    return tar_path, skipped


def transfer_and_promote(ssh_host: str, staging_dir: str, remote_dir: str, tar_path: str) -> None:
    # Staging + additive `cp -a` merge, same pattern as deploy_ai_bom_online.py:
    # nothing touches the live remote_dir until the whole tar has landed and
    # extracted successfully into an isolated staging dir first.
    run(["ssh", "-o", "BatchMode=yes", ssh_host, f"rm -rf {staging_dir} && mkdir -p {staging_dir}"])
    run(["scp", "-o", "BatchMode=yes", tar_path, f"{ssh_host}:{staging_dir}/payload.tar"])
    run(["ssh", "-o", "BatchMode=yes", ssh_host,
         f"tar -xf {staging_dir}/payload.tar -C {staging_dir} && rm -f {staging_dir}/payload.tar"])
    run(["ssh", "-o", "BatchMode=yes", ssh_host,
         f"mkdir -p {remote_dir} && cp -a {staging_dir}/. {remote_dir}/ && rm -rf {staging_dir}"])


def sync_dir(*, local_dir: Path, remote_dir: str, staging_dir: str,
             inventory_script_path: str, ssh_host: str, dry_run: bool) -> None:
    if not local_dir.is_dir():
        print(f"Local data dir not found: {local_dir}", file=sys.stderr)
        sys.exit(1)

    print("-- Building local inventory --")
    local = local_inventory(local_dir)
    print(f"  {len(local)} local files under {local_dir}")

    print("-- Fetching remote inventory --")
    remote = remote_inventory(ssh_host, remote_dir, inventory_script_path)
    print(f"  {len(remote)} files currently on remote")

    changed = diff_inventories(local, remote)
    changed_bytes = sum(local[r][0] for r in changed)
    print(f"-- {len(changed)} file(s) new or changed, {changed_bytes / 1_000_000_000:.2f} GB --")

    if not changed:
        print("Nothing to sync.")
        return

    print("-- Checking remote disk space --")
    avail = remote_avail_bytes(ssh_host)
    required = changed_bytes * DISK_SAFETY_MULTIPLIER
    print(f"  remote avail: {avail / 1_000_000_000:.2f} GB, required (with {DISK_SAFETY_MULTIPLIER}x safety margin): {required / 1_000_000_000:.2f} GB")
    if avail < required:
        print("Not enough remote disk space -- aborting.", file=sys.stderr)
        sys.exit(1)

    if dry_run:
        print("[dry-run] would transfer the files listed above; stopping here.")
        return

    print("-- Building tar of changed files --")
    tar_path, skipped = build_tar_to_tempfile(local_dir, changed)
    try:
        print("-- Transferring and promoting on remote --")
        transfer_and_promote(ssh_host, staging_dir, remote_dir, tar_path)
    finally:
        os.unlink(tar_path)

    synced_count = len(changed) - len(skipped)
    print(f"\nDone. Synced {synced_count} file(s) to {ssh_host}:{remote_dir}")
    if skipped:
        print(f"{len(skipped)} file(s) skipped (locked/unreadable) -- re-run this script once they're closed:")
        for relpath in skipped:
            print(f"  {relpath}")
