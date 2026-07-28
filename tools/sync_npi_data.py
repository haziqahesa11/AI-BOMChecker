#!/usr/bin/env python3
"""Sync the local NPI Library data tree to the AI-BOMChecker "online" instance
at 10.251.231.79:8000.

Pushes the local NPI_DATA_DIR tree ("NPI Files/", ~6GB / ~300 files) to
~/AI_BOM/data/NPI_Files on the server, transferring only files that are new
or changed since the last run (no rsync on Windows, so this does its own
size/mtime diff against a remote listing instead of a full re-copy).

Run the index rebuild first so the freshly generated index.json rides along
in the synced tree -- the server never rebuilds it itself:
    node BackEnd/scripts/build-npi-index.js

Usage:
    python tools/sync_npi_data.py --dry-run   # show what would transfer + disk check, touch nothing
    python tools/sync_npi_data.py             # actually sync
    python tools/sync_npi_data.py --host engineer@10.251.231.79   # override the SSH target
"""

import argparse
import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import dir_sync

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SSH_HOST = "79"  # "Host 79" alias in ~/.ssh/config -> engineer@10.251.231.79
REMOTE_DIR = "~/AI_BOM"
REMOTE_NPI_DIR = f"{REMOTE_DIR}/data/NPI_Files"

LOCAL_NPI_DIR = REPO_ROOT / "NPI Files"


def print_remote_index_timestamp(ssh_host: str) -> None:
    result = subprocess.run(
        ["ssh", "-o", "BatchMode=yes", ssh_host, f"cat {REMOTE_NPI_DIR}/MSF/NpiLibrary/index.json"],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        return
    try:
        data = json.loads(result.stdout)
        print(f"Remote index.json generatedAt: {data.get('generatedAt')}")
    except ValueError:
        pass


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--host", default=DEFAULT_SSH_HOST, help=f"SSH target (default: {DEFAULT_SSH_HOST!r}, i.e. engineer@10.251.231.79)")
    parser.add_argument("--dry-run", action="store_true", help="show what would transfer and run the disk check, touch nothing")
    args = parser.parse_args()

    dir_sync.sync_dir(
        local_dir=LOCAL_NPI_DIR,
        remote_dir=REMOTE_NPI_DIR,
        staging_dir=f"{REMOTE_DIR}/.npi_sync_staging",
        inventory_script_path=f"{REMOTE_DIR}/.npi_sync_inventory.py",
        ssh_host=args.host,
        dry_run=args.dry_run,
    )
    if not args.dry_run:
        print_remote_index_timestamp(args.host)


if __name__ == "__main__":
    main()
