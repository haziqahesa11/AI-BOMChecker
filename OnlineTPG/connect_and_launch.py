"""Checks reachability to the Wiwynn BOM SQL Server (10.251.231.65:1435),
connects the "WYMY VPN" client if this laptop isn't already on the corporate
network, then launches MonicaTPGenerator.exe (TPG) or MonicaTPApprover.exe
(TPA) from this same folder.

This does NOT automate anything inside TPG/TPA - no fields are filled, no
data is submitted or approved. It only gets you a working, reachable copy of
the app open on your own laptop, in place of RDP-ing into 10.251.231.65. You
still create/approve everything yourself, exactly as before.

Usage:
    Double-click "PC BOM by Matias.exe" in this folder, and choose TPG or TPA
    when prompted. Or from a command line: "PC BOM by Matias.exe" --app tpg
"""
from __future__ import annotations

import argparse
import socket
import subprocess
import sys
import time
from pathlib import Path

SQL_HOST = "10.251.231.65"
SQL_PORT = 1435
VPN_NAME = "WYMY VPN"
VPN_SERVER_ADDRESS = "https://wymyvpn.wiwynn.com"

APPS = {
    "tpg": "MonicaTPGenerator.exe",
    "tpa": "MonicaTPApprover.exe",
}


def _here() -> Path:
    # When frozen by PyInstaller, __file__ points into a temp extraction dir,
    # not the real .exe's folder - sys.executable is the actual .exe path.
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


HERE = _here()


def sql_reachable(timeout: float = 3.0) -> bool:
    try:
        with socket.create_connection((SQL_HOST, SQL_PORT), timeout=timeout):
            return True
    except OSError:
        return False


def vpn_profile_exists() -> bool:
    result = subprocess.run(
        [
            "powershell", "-NoProfile", "-Command",
            f"(Get-VpnConnection -Name '{VPN_NAME}' -ErrorAction SilentlyContinue) -ne $null",
        ],
        capture_output=True, text=True,
    )
    return result.stdout.strip().lower() == "true"


def connect_vpn() -> None:
    print(f"Connecting VPN '{VPN_NAME}' (you may be prompted for your domain username/password)...")
    subprocess.run(["rasdial", VPN_NAME])


def ensure_reachable() -> bool:
    print(f"Checking reachability to {SQL_HOST}:{SQL_PORT} ...")
    if sql_reachable():
        print("Reachable directly - already on the corporate network, no VPN needed.")
        return True

    print("Not reachable directly.")
    if not vpn_profile_exists():
        print(
            f"VPN profile '{VPN_NAME}' was not found on this laptop.\n"
            "Set it up once: Settings > Network & Internet > VPN > Add a VPN connection\n"
            f"  Server address: {VPN_SERVER_ADDRESS}\n"
            "Then re-run this script."
        )
        return False

    connect_vpn()
    print("Waiting for the connection to settle...")
    time.sleep(3)

    if sql_reachable():
        print("Reachable via VPN.")
        return True

    print(f"Still cannot reach {SQL_HOST}:{SQL_PORT} after connecting the VPN.")
    return False


def launch(app: str) -> None:
    exe_name = APPS[app]
    exe_path = HERE / exe_name
    if not exe_path.exists():
        print(f"{exe_name} not found next to this script ({HERE}). Keep this folder intact.")
        sys.exit(1)
    print(f"Launching {exe_name} ...")
    subprocess.Popen([str(exe_path)], cwd=str(HERE))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--app", choices=sorted(APPS), help="Which app to launch: tpg or tpa")
    args = parser.parse_args()

    app = args.app
    if not app:
        choice = input("Launch (1) TPG or (2) TPA? [1/2]: ").strip()
        app = "tpa" if choice == "2" else "tpg"

    if not ensure_reachable():
        proceed = input("Launch anyway? The Model Reference dropdown will likely be empty. [y/N]: ").strip().lower()
        if proceed != "y":
            print("Aborted.")
            sys.exit(1)

    launch(app)


if __name__ == "__main__":
    main()
