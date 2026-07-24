# OnlineTPG

Run MonicaTPGenerator (TPG) or MonicaTPApprover (TPA) directly from your own
laptop, with live data from the real SQL Server, no RDP to `10.251.231.65`
required.

## What's in this folder

- `MonicaTPGenerator.exe` + `MonicaTPGenerator.xml`
- `MonicaTPApprover.exe` + `MonicaTPApprover.xml`
- **`PC BOM by Matias.exe`** - double-click this. Checks network
  connectivity and opens whichever of the two apps you choose. No Python
  install needed on the recipient's laptop - it's a self-contained exe.
- `connect_and_launch.py` - the source for `PC BOM by Matias.exe` (kept for
  reference/rebuilding; not needed to run the tool)

Both `.xml` files already point at the correct SQL address
(`10.251.231.65`), not the old `MonicaMTE.wiwynn.com` name that no longer
resolves to a working server. Keep every file in this folder together - the
`.exe`s read their `.xml` from the same directory they're launched from.

## Prerequisites (one-time, per laptop)

1. **.NET Framework 4.8+** (TPG/TPA's runtime). Most Windows 10/11 corporate
   images already have this. Check with:
   ```
   (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full' -Name Release).Release -ge 528040
   ```
2. Network path to `10.251.231.65:1435` - either:
   - Already on the Wiwynn corporate Wi-Fi/LAN, or
   - The **"WYMY VPN"** connection profile set up in Windows Settings >
     Network & Internet > VPN (server `https://wymyvpn.wiwynn.com`), ask IT
     if you don't have this yet.

## Usage

Double-click **`PC BOM by Matias.exe`**, then choose `1` for TPG or `2` for TPA
when prompted.

It will:
1. Test if `10.251.231.65:1435` is reachable.
2. If not, connect the "WYMY VPN" profile (you may get a domain
   username/password prompt) and re-test.
3. Launch the app once reachable.

If the Model Reference dropdown populates with real models
(`C1042_L10`, `C2012_L11`, ...) once the app opens, the connection is
working. If it's empty, the SQL round-trip isn't there yet - re-check the
network/VPN step above before assuming the app itself is broken.

## What this does *not* do

This only gets TPG/TPA open and connected. It does not fill in any fields,
submit anything, or approve anything - you use the app exactly as you
always have, just from your own laptop instead of over RDP.
