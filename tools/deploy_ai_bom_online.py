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
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SSH_HOST = "79"  # "Host 79" alias in ~/.ssh/config -> engineer@10.251.231.79
REMOTE_DIR = "~/AI_BOM"
PM2_PROCESS = "ai-bom-online"
PORT = 8000

EXCLUDES = [
    "--exclude=BackEnd/node_modules",
    "--exclude=BackEnd/scripts",
    "--exclude=Frontend/node_modules",
    "--exclude=Frontend/dist",
]
INCLUDE_PATHS = ["BackEnd", "Frontend", "package.json"]
CRED_FILES = ["sql.env", "automation.env"]


def run(cmd, **kwargs):
    print(f"$ {' '.join(cmd)}")
    result = subprocess.run(cmd, **kwargs)
    if result.returncode != 0:
        print(f"Command failed with exit code {result.returncode}", file=sys.stderr)
        sys.exit(result.returncode)
    return result


def ship_code(ssh_host: str, dry_run: bool) -> None:
    print("-- Packaging and transferring code --")
    tar_cmd = ["tar", "-czf", "-", *EXCLUDES, *INCLUDE_PATHS]
    extract_cmd = ["ssh", "-o", "BatchMode=yes", ssh_host, f"tar -xzf - -C {REMOTE_DIR}"]

    if dry_run:
        print(f"[dry-run] would run: {' '.join(tar_cmd)} | {' '.join(extract_cmd)}")
        return

    tar_proc = subprocess.Popen(tar_cmd, cwd=REPO_ROOT, stdout=subprocess.PIPE)
    ssh_proc = subprocess.run(extract_cmd, stdin=tar_proc.stdout)
    tar_proc.stdout.close()
    tar_proc.wait()
    if tar_proc.returncode != 0 or ssh_proc.returncode != 0:
        print("Transfer failed", file=sys.stderr)
        sys.exit(1)


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
