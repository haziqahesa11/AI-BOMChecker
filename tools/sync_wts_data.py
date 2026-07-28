#!/usr/bin/env python3
"""Sync the local WTS data tree to the AI-BOMChecker "online" instance at
10.251.231.79:8000.

Fetching only ever happens locally, from HQ Fetching/wts_dashboard -- the
Azure DevOps PAT wts_fetch.py needs stays in this repo's local, gitignored
config/credentials/wts.env and is never placed on the shared server. This
script pushes the resulting WTS/ folder (attachments + index.json) to
~/AI_BOM/data/wts/WTS, transferring only files new or changed since the last
run (no rsync on Windows, so this does its own size/mtime diff against a
remote listing instead of a full re-copy).

Usage:
    cd "HQ Fetching/wts_dashboard" && python wts_fetch.py   # 1. fetch locally first
    python tools/sync_wts_data.py --dry-run                 # 2. preview
    python tools/sync_wts_data.py                            # 3. actually sync
    python tools/sync_wts_data.py --host engineer@10.251.231.79   # override the SSH target
"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import dir_sync

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SSH_HOST = "79"  # "Host 79" alias in ~/.ssh/config -> engineer@10.251.231.79
REMOTE_DIR = "~/AI_BOM"
REMOTE_WTS_DIR = f"{REMOTE_DIR}/data/wts/WTS"  # matches wtsService.js: path.join(WTS_DATA_DIR, 'WTS')

LOCAL_WTS_DIR = REPO_ROOT / "HQ Fetching" / "wts_dashboard" / "WTS"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--host", default=DEFAULT_SSH_HOST, help=f"SSH target (default: {DEFAULT_SSH_HOST!r}, i.e. engineer@10.251.231.79)")
    parser.add_argument("--dry-run", action="store_true", help="show what would transfer and run the disk check, touch nothing")
    args = parser.parse_args()

    dir_sync.sync_dir(
        local_dir=LOCAL_WTS_DIR,
        remote_dir=REMOTE_WTS_DIR,
        staging_dir=f"{REMOTE_DIR}/.wts_sync_staging",
        inventory_script_path=f"{REMOTE_DIR}/.wts_sync_inventory.py",
        ssh_host=args.host,
        dry_run=args.dry_run,
    )


if __name__ == "__main__":
    main()
