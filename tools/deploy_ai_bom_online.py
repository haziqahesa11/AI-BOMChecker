#!/usr/bin/env python3
"""Deploy/update the AI-BOMChecker "online" instance at 10.251.231.79:8000.

Packages the current local BackEnd/ + Frontend/ + root package.json
(excluding node_modules, Frontend/dist, and the dev-only BackEnd/scripts/),
streams them over SSH into ~/AI_BOM on the server, reinstalls dependencies,
rebuilds the frontend, and restarts the PM2 process "ai-bom-online".

Never touches anything else on that server (e.g. the unrelated "testsite"
process on port 80, or any other PM2 process/port).

Requires the SSH key access already set up for host "79" in ~/.ssh/config
(engineer@10.251.231.79, IdentityFile ~/.ssh/id_ed25519).

Usage:
    python tools/deploy_ai_bom_online.py
    python tools/deploy_ai_bom_online.py --skip-install   # faster: only if package.json unchanged
    python tools/deploy_ai_bom_online.py --with-creds     # also re-sync config/credentials/{sql,automation}.env
    python tools/deploy_ai_bom_online.py --dry-run        # print what would happen, touch nothing
    python tools/deploy_ai_bom_online.py --host engineer@10.251.231.79   # override the SSH target
"""

import argparse
import io
import os
import subprocess
import sys
import tarfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SSH_HOST = "79"  # "Host 79" alias in ~/.ssh/config -> engineer@10.251.231.79
REMOTE_DIR = "~/AI_BOM"
PM2_PROCESS = "ai-bom-online"
PORT = 8000

EXCLUDE_DIRS = [
    Path("BackEnd") / "node_modules",
    Path("BackEnd") / "scripts",
    Path("Frontend") / "node_modules",
    Path("Frontend") / "dist",
]
INCLUDE_PATHS = ["BackEnd", "Frontend", "package.json"]
# wts.env / npi.env are deliberately NOT in CRED_FILES: their values pair a
# credential with a host-specific absolute path (Windows locally, Linux on
# the server). A blind scp would silently overwrite the server's correct
# WTS_DATA_DIR/NPI_DATA_DIR with a local Windows path. Those two files are
# hand-created once directly on the server instead (see deploy runbook).
CRED_FILES = ["sql.env", "automation.env"]


def build_tar_bytes() -> bytes:
    """Build the deploy tarball with Python's own tarfile module instead of
    shelling out to a system `tar`. Different tar implementations (GNU tar
    vs Windows' built-in bsdtar) write incompatible extended headers (e.g.
    bsdtar's SCHILY.fflags), which the target's GNU tar silently mishandles
    on extraction -- and which one a bare `tar` resolves to isn't consistent
    across shells (Git Bash vs plain PowerShell). Building the archive in
    Python sidesteps that entirely, on any OS.
    """
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz", format=tarfile.GNU_FORMAT) as tar:
        for rel in INCLUDE_PATHS:
            path = REPO_ROOT / rel
            if path.is_file():
                tar.add(path, arcname=rel)
                continue
            for root, dirs, files in os.walk(path):
                root_path = Path(root)
                root_rel = root_path.relative_to(REPO_ROOT)
                dirs[:] = [d for d in dirs if (root_rel / d) not in EXCLUDE_DIRS]
                for fname in files:
                    fpath = root_path / fname
                    tar.add(fpath, arcname=str(fpath.relative_to(REPO_ROOT)))
    return buf.getvalue()


def run(cmd, **kwargs):
    print(f"$ {' '.join(cmd)}")
    result = subprocess.run(cmd, **kwargs)
    if result.returncode != 0:
        print(f"Command failed with exit code {result.returncode}", file=sys.stderr)
        sys.exit(result.returncode)
    return result


STAGING_DIR = f"{REMOTE_DIR}/.deploy_staging"


def ship_code(ssh_host: str, dry_run: bool) -> None:
    print("-- Packaging and transferring code --")
    # Extract into a clean staging dir, then `cp` over the live tree, so a
    # stray leftover file from a previous run can never conflict with
    # extraction, and node_modules (untracked, not in the archive) is never
    # touched.
    prep_cmd = ["ssh", "-o", "BatchMode=yes", ssh_host, f"rm -rf {STAGING_DIR} && mkdir -p {STAGING_DIR}"]
    extract_cmd = ["ssh", "-o", "BatchMode=yes", ssh_host, f"tar -xzf - -C {STAGING_DIR}"]
    promote_cmd = ["ssh", "-o", "BatchMode=yes", ssh_host, f"cp -a {STAGING_DIR}/. {REMOTE_DIR}/ && rm -rf {STAGING_DIR}"]

    if dry_run:
        print(f"[dry-run] would run: {' '.join(prep_cmd)}")
        print(f"[dry-run] would build tarball in-process (Python tarfile) and pipe to: {' '.join(extract_cmd)}")
        print(f"[dry-run] would run: {' '.join(promote_cmd)}")
        return

    run(prep_cmd)
    payload = build_tar_bytes()
    ssh_proc = subprocess.run(extract_cmd, input=payload)
    if ssh_proc.returncode != 0:
        print("Transfer failed", file=sys.stderr)
        sys.exit(1)
    run(promote_cmd)


def sync_creds(ssh_host: str, dry_run: bool) -> None:
    print("-- Syncing credentials --")
    for fname in CRED_FILES:
        local_path = REPO_ROOT / "config" / "credentials" / fname
        if not local_path.exists():
            print(f"  (skipping {fname}, not found locally)")
            continue
        cmd = ["scp", "-o", "BatchMode=yes", str(local_path), f"{ssh_host}:{REMOTE_DIR}/config/credentials/"]
        if dry_run:
            print(f"[dry-run] would run: {' '.join(cmd)}")
        else:
            run(cmd)


def install_build_restart(ssh_host: str, skip_install: bool, dry_run: bool) -> None:
    print("-- Installing / building / restarting on server --")
    steps = []
    if not skip_install:
        steps.append(f"cd {REMOTE_DIR}/BackEnd && npm install --no-audit --no-fund")
        steps.append(f"cd {REMOTE_DIR}/Frontend && npm install --no-audit --no-fund")
    steps.append(f"cd {REMOTE_DIR}/Frontend && npm run build")
    # Restart if the process already exists, otherwise (re)create it. PORT is
    # passed explicitly every time so a bare `pm2 restart` can never silently
    # fall back to server.js's default port 3000.
    steps.append(
        f"(PORT={PORT} pm2 restart {PM2_PROCESS} --update-env) || "
        f"(cd {REMOTE_DIR}/BackEnd && PORT={PORT} pm2 start server.js "
        f"--name {PM2_PROCESS} --cwd {REMOTE_DIR}/BackEnd --update-env)"
    )
    steps.append("pm2 save")
    steps.append(
        f"sleep 1 && curl -s -o /dev/null -w 'local curl: HTTP %{{http_code}}\\n' http://localhost:{PORT}/"
    )
    steps.append("pm2 list")
    remote_cmd = " && ".join(steps)

    cmd = ["ssh", "-o", "BatchMode=yes", ssh_host, remote_cmd]
    if dry_run:
        print(f"[dry-run] would run: {' '.join(cmd)}")
        return
    run(cmd)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--host", default=DEFAULT_SSH_HOST, help=f"SSH target (default: {DEFAULT_SSH_HOST!r}, i.e. engineer@10.251.231.79)")
    parser.add_argument("--skip-install", action="store_true", help="skip npm install on server (faster if dependencies unchanged)")
    parser.add_argument("--with-creds", action="store_true", help="also re-sync config/credentials/{sql,automation}.env to the server")
    parser.add_argument("--dry-run", action="store_true", help="print what would happen without touching the server")
    args = parser.parse_args()

    print(f"== Deploying AI-BOMChecker to {args.host}:{REMOTE_DIR} ==")

    ship_code(args.host, args.dry_run)
    if args.with_creds:
        sync_creds(args.host, args.dry_run)
    install_build_restart(args.host, args.skip_install, args.dry_run)

    print(f"\n== Done. Live at http://10.251.231.79:{PORT} ==")


if __name__ == "__main__":
    main()
