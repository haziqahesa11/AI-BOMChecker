# QVL + Test BOM Control Discovery Findings

Date: 2026-07-14. Captured read-only via `pywinauto`'s `print_control_identifiers()`
against a freshly-launched, empty MonicaTPGenerator.exe instance (PID tracked
explicitly, never by window title/path — a second, real, in-use instance
(`C:\Tools\MonicaTPGenerator\MonicaTPGenerator.exe`, started 3:52 PM) was
already running on this machine and was never touched, clicked, typed into,
or screenshotted). No `ADD / MODIFY` or `Submit` was ever clicked.

Raw dumps: `qvl_discovery.txt` (QVL tab active) and `testbom_discovery.txt`
(Test BOM tab active, reached via a single non-destructive tab-switch click)
were captured in the session scratchpad and are summarized below. The exe
path used was the real install: `C:\Tools\MonicaTPGenerator\MonicaTPGenerator.exe`
(confirmed via `Win32_Process` — this is the actual everyday-use install on
this laptop, not the repo-vendored copy under `@BOM-Based-APP\`).

Note: `pywinauto`'s `print_control_identifiers(filename=...)` opens the file
with `locale.getpreferredencoding()` (cp1252 on this machine), which crashes
on the up-arrow glyph (`↑ Remove`). Worked around in the discovery script by
monkeypatching `locale.getpreferredencoding` to return `"utf-8"` before the
call — a real gotcha for anyone re-running discovery here.

## QVL tab — confirmed selectors

All are `child_window(auto_id=..., control_type=...)` under the main window
(`auto_id="MonicaTPGenerator"`) → `tabCtl` (top-level TabControl) → `tabQVL`
(TabPage) → `tabCTLQVL` (inner TabControl) → `tabQVLchk` ("QVL Checking" page).

| Field (screenshot label) | Real `auto_id` | `control_type` |
|---|---|---|
| QVL tab item | `tabQVL` | `System.Windows.Forms.TabPage` (title="QVL") |
| Model Reference (dropdown) | `cmBoxQvlModelReferenceList` | `System.Windows.Forms.ComboBox` |
| Location (dropdown) | `cmBoxQvlLocation` | `System.Windows.Forms.ComboBox` |
| PN (text) | `txtBoxQvlPN` | `System.Windows.Forms.TextBox` |
| Description (text) | `txtBoxQvlDescription` | `System.Windows.Forms.TextBox` |
| ADD / MODIFY button | `btnQvlAddModifyPn` | `System.Windows.Forms.Button` — **never click** |
| DELETE button | `btnQvlDelRemovePn` | `System.Windows.Forms.Button` — never click |
| FROM PLM button | `btnQvlPnPLM` | `System.Windows.Forms.Button` |
| QVL Checking grid | `dgvQvlList` | `System.Windows.Forms.DataGridView` |
| "↓ Add" / "↑ Remove" (location list) | `btnQvlLocAdd` / `btnQvlSelLocDel` | `System.Windows.Forms.Button` |
| location list boxes | `lBoxQvlAllLoc` / `lBoxQvlSelLoc` | `System.Windows.Forms.ListBox` |

**All four of the agent's previously-guessed selectors were wrong** —
`cboModelReference`/`cboLocation`/`txtPN`/`txtDescription` never existed;
real IDs are `cmBoxQvlModelReferenceList`/`cmBoxQvlLocation`/`txtBoxQvlPN`/
`txtBoxQvlDescription`. The guessed QVL tab selector (`control_type="TabItem"`)
was also wrong — the real control type string exposed by this app's win32
backend is `System.Windows.Forms.TabPage`.

## Test BOM tab — confirmed selectors

Reached via `tabCtl.select("Test BOM")` (a non-destructive tab switch).

| Field (screenshot label) | Real `auto_id` | `control_type` |
|---|---|---|
| Model Reference (dropdown) | `cmBoxTestbomModelReferenceList` | `ComboBox` |
| Part Number (dropdown) | `cmBoxTestbomPNList` | `ComboBox` |
| Reference Part Number (dropdown) | `cmBoxTestbomRfPNList` | `ComboBox` |
| Change button | `btnTestbomChgCfg` (title `"Change "` — trailing space) | `Button` |
| Save button | `btnTestbomSaveXml` | `Button` |
| Load button | `btnTestbomLoadXml` | `Button` |
| Submit button | `btnTestbomSubmit` | `Button` — **never click** |
| Current Site label | `SiteCheck` | `Label` (e.g. "Current Site : WYMY") |
| Data sub-tab | `tabTestBOMdata` | `TabPage` (title "Data") |
| Test BOM grid | `tgvTestbomList` | `AdvancedDataGridView.TreeGridView` — **not** a plain `DataGridView`, a third-party tree-grid control. Matters for any later attempt to read cell colors (red/green) or values directly instead of via Save/Load CSV. |
| (unlabeled in screenshot) change-reason text box | `txtBoxL10bomChgReason` | `TextBox` |

The Save/Load buttons' internal names (`btnTestbomSaveXml`/`btnTestbomLoadXml`)
suggest the underlying save format may default to XML rather than plain CSV
internally — worth confirming directly against the actual bytes in Part 2.1
rather than assuming from the button name.

## Process/topology note carried forward

The real, everyday-use MonicaTPGenerator.exe install is at
`C:\Tools\MonicaTPGenerator\MonicaTPGenerator.exe`, not the repo-vendored
copy — `monica-automation/config/settings.toml`'s `tpg_exe_path` has been
updated to point there.
