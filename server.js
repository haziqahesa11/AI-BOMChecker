const express = require('express');
const path = require('path');
const fs = require('fs');
const { sql, query } = require('./DB');

const app = express();
app.use(express.json());

// Serve Vite build in production; fall back to legacy public/ otherwise
const clientDist = path.join(__dirname, 'client', 'dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
} else {
  app.use(express.static(path.join(__dirname, 'public')));
}

// Pattern for CRD spec part numbers: e.g. M1389927-001
const CRD_PN_PATTERN = /^[A-Z]\d{7}-\d{3}$/;

// ── API: compare BOM vs CRD ────────────────────────────────────────────────
app.post('/api/compare', async (req, res) => {
  const { partNumber } = req.body;
  if (!partNumber?.trim()) {
    return res.status(400).json({ error: 'Part number is required.' });
  }

  const pn = partNumber.trim();

  try {
    // Step 1 – Fetch BOM rows for the given ParentPartNumber
    const bomResult = await query(
      'SELECT * FROM bom.dbo.SysBom WHERE ParentPartNumber = @pn',
      [{ name: 'pn', type: sql.NVarChar, value: pn }]
    );
    const bomRows = bomResult.recordset;

    if (!bomRows.length) {
      return res.status(404).json({ error: `No BOM records found for part number "${pn}".` });
    }

    // Step 2 – Identify the CRD reference row inside the BOM
    //   Criteria: ChildPartNumber matches M1234567-001 pattern, or Location/Type = 'CRD'
    const crdRefRow = bomRows.find(r =>
      CRD_PN_PATTERN.test((r.ChildPartNumber || '').trim()) ||
      (r.Location || '').toUpperCase() === 'CRD' ||
      (r.Type || '').toUpperCase() === 'CRD'
    );

    if (!crdRefRow) {
      return res.json({
        partNumber: pn,
        crdFound: false,
        bomData: bomRows,
        message: 'No CRD reference row found in BOM. Showing BOM data only.'
      });
    }

    const crdPN = (crdRefRow.ChildPartNumber || '').trim();

    // Step 3 – Fetch CRD specs for that SpecNumber
    const crdResult = await query(
      'SELECT * FROM MSFT_SKU.dbo.CRDspec WHERE SpecNumber = @crdpn ORDER BY Line',
      [{ name: 'crdpn', type: sql.NVarChar, value: crdPN }]
    );
    const crdRows = crdResult.recordset;

    if (!crdRows.length) {
      return res.json({
        partNumber: pn,
        crdPN,
        crdFound: true,
        crdDataFound: false,
        bomData: bomRows,
        message: `CRD reference "${crdPN}" found in BOM but no specs exist in MSFT_SKU.`
      });
    }

    // Step 4 – Compare (exclude the CRD ref row from BOM comparison set)
    const bomForComparison = bomRows.filter(r => r !== crdRefRow);
    const [bmcPfmMap, biosPfmMap, bmcPfmIdMap, vrMap, fruMap] = await Promise.all([
      buildBmcPfmMap(crdRows),
      buildBiosPfmMap(crdRows),
      buildBmcPfmIdMap(crdRows),
      buildVrMap(crdRows),
      buildFruMap(crdRows)
    ]);
    const comparisons = matchAndCompare(bomForComparison, crdRows, pn, bmcPfmMap, biosPfmMap, bmcPfmIdMap, vrMap, fruMap);

    const matched   = comparisons.filter(c => c.type === 'MATCHED');
    const passCount = matched.filter(c => c.status === 'PASS').length;
    const failCount = matched.filter(c => c.status === 'FAIL').length;
    const overallScore = matched.length > 0 ? (passCount / matched.length) * 100 : 0;

    res.json({
      partNumber: pn,
      crdPN,
      crdFound: true,
      crdDataFound: true,
      overallScore:    Math.round(overallScore * 10) / 10,
      overallStatus:   overallScore >= 90 ? 'PASS' : overallScore >= 70 ? 'WARNING' : 'FAIL',
      totalMatched:    matched.length,
      passCount,
      failCount,
      bomOnlyCount:    comparisons.filter(c => c.type === 'BOM_ONLY').length,
      crdOnlyCount:    comparisons.filter(c => c.type === 'CRD_ONLY').length,
      bomData:         bomRows,
      crdData:         crdRows,
      crdRefRow,
      comparisons
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── Comparison logic ───────────────────────────────────────────────────────

// Build the BMC PFM golden-reference map from the CRD spec rows already fetched for this request.
//
// Two-step chain (steps 2 & 3 collapsed into one self-join query):
//   Step 1 – From the CRD spec rows, find the BMC row (Item LIKE '%BMC',
//             Notes LIKE 'Firmware Central/BMC%') and extract the value after '.BC.'
//             in the Version column  →  primary key into DeviceCfg.Value.
//   Step 2+3 – Self-join on DeviceCfg:
//             dc1 (Remark='BMC Firmware Version', Value=<step-1 value>) joined to
//             dc2 (Key='PFM:IMG', Value LIKE '%v%.bin%') on dc2.Revision = dc1.Revision.
//             BMCPFM = substring between 'v' and '.bin' in dc2.Value.
//
// Map key:   crdBmcVer  (value after '.BC.' in CRD spec Version, e.g. "0406.00")
// Map value: BMCPFM     (PFM version from PFM:IMG Value,          e.g. "2.36")
async function buildBmcPfmMap(crdRows = []) {
  const map = new Map();

  // Step 1 – find BMC row(s) in the already-fetched CRD spec rows
  const bmcCrdRows = crdRows.filter(r =>
    /bmc$/i.test((r.Item || '').trim()) &&
    /Firmware\s+Central\/BMC/i.test(r.Notes || '')
  );
  if (!bmcCrdRows.length) return map;

  for (const crdRow of bmcCrdRows) {
    // Step 1 – extract value after '.BC.' from CRD spec Version column
    // This value is the primary key into DeviceCfg.Value in step 2
    const crdBmcVer = extractC2195BMCVersion(crdRow.Version);
    if (!crdBmcVer || map.has(crdBmcVer)) continue;

    // Extract model from Notes: 'Firmware Central/BMC/C2195/...' → 'C2195'
    // Required to distinguish models that share the same firmware version value
    // (e.g. C2160 and C2195 both have Value='0406.00' but different PFM versions)
    const mMatch = (crdRow.Notes || '').match(/Firmware\s+Central\/BMC\/([^\s\/,;]+)/i);
    const modelHint  = mMatch ? mMatch[1].trim() : null;
    const modelPat   = modelHint ? `%${modelHint}%` : '%BMC';

    // Steps 2 & 3 – self-join on DeviceCfg:
    //   dc1 (Key='FW:VER', PartNumber LIKE model, Value=crdBmcVer)
    //     joined via PartNumber+Revision to
    //   dc2 (Key='PFM:IMG') → extract BMCPFM from Value
    try {
      const pfmResult = await query(
        `SELECT TOP 1
           SUBSTRING(
             dc2.Value,
             CHARINDEX('v', dc2.Value) + 1,
             CHARINDEX('.bin', dc2.Value) - CHARINDEX('v', dc2.Value) - 1
           ) AS BMCPFM
         FROM BOM.dbo.DeviceCfg dc1
         JOIN BOM.dbo.DeviceCfg dc2
           ON  dc2.PartNumber = dc1.PartNumber
           AND dc2.Revision   = dc1.Revision
           AND dc2.[Key]      = 'PFM:IMG'
           AND dc2.Value     LIKE '%v%.bin%'
         WHERE dc1.PartNumber LIKE @modelPat
           AND dc1.[Key]      = 'FW:VER'
           AND dc1.Value      = @val`,
        [
          { name: 'modelPat', type: sql.NVarChar, value: modelPat   },
          { name: 'val',      type: sql.NVarChar, value: crdBmcVer  }
        ]
      );
      for (const row of pfmResult.recordset) {
        const bmcpfm = (row.BMCPFM || '').trim();
        if (bmcpfm) { map.set(crdBmcVer, bmcpfm); break; }
      }
    } catch (e) {
      console.error('[buildBmcPfmMap] DeviceCfg join lookup failed:', e.message);
    }
  }

  return map;
}

// Build the BIOS PFM golden-reference map from the CRD spec rows already fetched.
//
// Step 1 – Find CRD rows where Item LIKE '%BIOS PFMID'. Get Version (e.g. "0x36") and Model.
//           S2260 exception: Version is already the golden reference — no DeviceCfg lookup needed.
// Step 2+3 – In DeviceCfg, filter PartNumber LIKE '%BIOSPFM':
//            find the row where Key='PFM:ID' and Value=<step-1 Version>.
//            Model is embedded in PartNumber (e.g. "C2195.BIOSPFM"), so narrow with
//            PartNumber LIKE '%<model>%BIOSPFM' first, fall back to '%BIOSPFM' if no match.
//            The Revision column of the matched row is the PFM golden reference.
//
// Map key:   pfmId  (CRD spec Version for the BIOS PFMID row, e.g. "0x36")
// Map value: resolved PFM version from DeviceCfg Revision column (or same value for S2260)
async function buildBiosPfmMap(crdRows = []) {
  const map = new Map();

  const biosPfmidRows = crdRows.filter(r =>
    /bios\s*pfmid$/i.test((r.Item || '').trim())
  );
  if (!biosPfmidRows.length) return map;

  for (const crdRow of biosPfmidRows) {
    const pfmIdValue = (crdRow.Version || '').trim();
    if (!pfmIdValue || map.has(pfmIdValue)) continue;

    // Model: prefer dedicated column, fall back to parsing SpecNumber or Notes
    const model = (crdRow.Model || '').trim() || extractModelCode(crdRow.SpecNumber) || extractModelCode(crdRow.Notes);

    // S2260 exception: use CRD Version directly as the golden reference
    if (/S2260/i.test(model)) {
      map.set(pfmIdValue, pfmIdValue);
      continue;
    }

    // Model is embedded in PartNumber (e.g. "C2195.BIOSPFM").
    // Try model-narrowed pattern first, then fall back to bare '%BIOSPFM'.
    const pats = model ? [`%${model}%BIOSPFM`, '%BIOSPFM'] : ['%BIOSPFM'];
    try {
      let ver = '';
      for (const pat of pats) {
        const result = await query(
          `SELECT TOP 1 dc.Revision AS PFMVersion
           FROM BOM.dbo.DeviceCfg dc
           WHERE dc.PartNumber LIKE @pnPat
             AND dc.[Key]      = 'PFM:ID'
             AND dc.Value      = @pfmId`,
          [
            { name: 'pnPat', type: sql.NVarChar, value: pat        },
            { name: 'pfmId', type: sql.NVarChar, value: pfmIdValue }
          ]
        );
        ver = (result.recordset[0]?.PFMVersion || '').trim();
        if (ver) break;
      }
      if (ver) map.set(pfmIdValue, ver);
    } catch (e) {
      console.error('[buildBiosPfmMap] DeviceCfg lookup failed:', e.message);
    }
  }

  return map;
}

// Build the BMC PFM golden-reference map via PFM:ID lookup — mirrors buildBiosPfmMap.
//
// Step 1 – Find CRD rows where Item LIKE '%BMC PFMID'. Get Version (e.g. "0x24") and Model.
// Step 2+3 – In DeviceCfg (PartNumber LIKE '%BMCPFM'):
//            find Key='PFM:ID', Value=<step-1 Version>.
//            Model is embedded in PartNumber (e.g. "C2195.BMCPFM") — narrow with
//            PartNumber LIKE '%<model>%BMCPFM', fall back to '%BMCPFM' if no match.
//            The Revision column is the PFM golden reference.
//
// Map key:   pfmId  (CRD spec Version for the BMC PFMID row, e.g. "0x24")
// Map value: resolved PFM version from DeviceCfg Revision column
async function buildBmcPfmIdMap(crdRows = []) {
  const map = new Map();

  const bmcPfmidRows = crdRows.filter(r =>
    /bmc\s*pfmid$/i.test((r.Item || '').trim())
  );
  if (!bmcPfmidRows.length) return map;

  for (const crdRow of bmcPfmidRows) {
    const pfmIdValue = (crdRow.Version || '').trim();
    if (!pfmIdValue || map.has(pfmIdValue)) continue;

    const model = (crdRow.Model || '').trim() || extractModelCode(crdRow.SpecNumber) || extractModelCode(crdRow.Notes);
    const pats = model ? [`%${model}%BMCPFM`, '%BMCPFM'] : ['%BMCPFM'];

    try {
      let ver = '';
      for (const pat of pats) {
        const result = await query(
          `SELECT TOP 1 dc.Revision AS PFMVersion
           FROM BOM.dbo.DeviceCfg dc
           WHERE dc.PartNumber LIKE @pnPat
             AND dc.[Key]      = 'PFM:ID'
             AND dc.Value      = @pfmId`,
          [
            { name: 'pnPat', type: sql.NVarChar, value: pat        },
            { name: 'pfmId', type: sql.NVarChar, value: pfmIdValue }
          ]
        );
        ver = (result.recordset[0]?.PFMVersion || '').trim();
        if (ver) break;
      }
      if (ver) map.set(pfmIdValue, ver);
    } catch (e) {
      console.error('[buildBmcPfmIdMap] DeviceCfg lookup failed:', e.message);
    }
  }

  return map;
}

// Build the VR golden-reference map from CRD spec rows already fetched.
//
// The model name is carried in the Notes of any CRD row whose Notes contains
// "Firmware Central/BIOS/{model}/..." (e.g. the BIOS row).
//
// Step 1 – Scan ALL crdRows for Notes matching "Firmware Central/BIOS/{model}".
//           Extracts the model code (e.g. "C2195") from the first matching row per model.
// Step 2 – In DeviceCfg: ModelRef LIKE '{model}%' AND PartNumber LIKE '%VR'.
// Step 3 – Pick the latest Revision via pickLatestRevision (same algorithm as FRU):
//           segment-by-segment natural sort — alpha segments ascending,
//           numeric segments descending (biggest number first).
//
// Map key:   model code  (e.g. "C2195")
// Map value: latest VR Revision from DeviceCfg
async function buildVrMap(crdRows = []) {
  const map = new Map();

  for (const crdRow of crdRows) {
    const notesMatch = (crdRow.Notes || '').match(/Firmware\s+Central\/BIOS[\/\s]+([^\s\/,;]+)/i);
    if (!notesMatch) continue;

    const raw   = notesMatch[1].trim();
    const model = (raw.match(/^([A-Z]?\d{3,5})/i)?.[1] || raw).toUpperCase();
    if (!model || map.has(model)) continue;

    const base = /^[A-Z]/i.test(model) ? model : `C${model}`;
    const pats = [base + '%'];
    if (base.length >= 5) pats.push(base.slice(0, -1) + '%');

    let rev = '';
    for (const pat of pats) {
      try {
        const result = await query(
          `SELECT DISTINCT dc.Revision
           FROM BOM.dbo.DeviceCfg dc
           WHERE dc.ModelRef   LIKE @modelPat
             AND dc.PartNumber LIKE '%VR'`,
          [{ name: 'modelPat', type: sql.NVarChar, value: pat }]
        );
        const revisions = result.recordset.map(r => (r.Revision || '').trim()).filter(Boolean);
        rev = pickLatestRevision(revisions);
        if (rev) break;
      } catch (e) {
        console.error('[buildVrMap] DeviceCfg lookup failed:', e.message);
      }
    }
    if (rev) map.set(model, rev);
  }

  return map;
}

// Build the FRU golden-reference map from CRD spec rows already fetched.
//
// Uses the same model extraction as buildVrMap (Firmware Central/BIOS/{model} from Notes).
// Queries DeviceCfg: ModelRef LIKE '{model}%' AND PartNumber LIKE '%FRU'.
// Latest Revision picked via pickLatestRevision (same algorithm as VR).
//
// Map key:   model code  (e.g. "C2195")
// Map value: latest FRU Revision from DeviceCfg
async function buildFruMap(crdRows = []) {
  const map = new Map();

  for (const crdRow of crdRows) {
    const notesMatch = (crdRow.Notes || '').match(/Firmware\s+Central\/BIOS[\/\s]+([^\s\/,;]+)/i);
    if (!notesMatch) continue;

    const raw   = notesMatch[1].trim();
    const model = (raw.match(/^([A-Z]?\d{3,5})/i)?.[1] || raw).toUpperCase();
    if (!model || map.has(model)) continue;

    const base = /^[A-Z]/i.test(model) ? model : `C${model}`;
    const pats = [base + '%'];
    if (base.length >= 5) pats.push(base.slice(0, -1) + '%');

    let rev = '';
    for (const pat of pats) {
      try {
        const result = await query(
          `SELECT DISTINCT dc.Revision
           FROM BOM.dbo.DeviceCfg dc
           WHERE dc.ModelRef   LIKE @modelPat
             AND dc.PartNumber LIKE '%FRU'`,
          [{ name: 'modelPat', type: sql.NVarChar, value: pat }]
        );
        const revisions = result.recordset.map(r => (r.Revision || '').trim()).filter(Boolean);
        rev = pickLatestRevision(revisions);
        if (rev) break;
      } catch (e) {
        console.error('[buildFruMap] DeviceCfg lookup failed:', e.message);
      }
    }
    if (rev) map.set(model, rev);
  }

  return map;
}

// Ascending natural-sort comparator for revision strings.
// Alpha segments : standard string order  (special chars < digits < letters by code point).
// Numeric segments: numerically ascending (9 before 17).
// Used by pickLatestRevision to establish sort order; the LAST element = latest revision.
//
// Ascending order examples:
//   V06  <  V06.MIX  <  V06.RENESAS   ('' < '.MIX' < '.RENESAS' at the alpha segment)
//   V0.09  <  V0.17                   (9 < 17 at the numeric segment)
//   V05.MIX  <  V06.RENESAS           (5 < 6 at the first numeric segment)
function compareRevisionAscending(a, b) {
  const segsA = a.split(/(\d+)/).filter(Boolean);
  const segsB = b.split(/(\d+)/).filter(Boolean);
  const len = Math.max(segsA.length, segsB.length);
  for (let i = 0; i < len; i++) {
    const sa = segsA[i] || '';
    const sb = segsB[i] || '';
    if (/^\d+$/.test(sa) && /^\d+$/.test(sb)) {
      const diff = parseInt(sa, 10) - parseInt(sb, 10); // ascending: smaller number first
      if (diff !== 0) return diff;
    } else {
      if (sa < sb) return -1;
      if (sa > sb) return 1;
    }
  }
  return 0;
}

// Pick the latest revision = the last element after ascending natural sort (= the maximum).
// "Latest" is defined by ascending alphabetical order including special characters,
// with numeric segments compared as integers (biggest number = latest).
function pickLatestRevision(revisions) {
  if (!revisions.length) return '';
  const sorted = [...revisions].sort(compareRevisionAscending);
  return sorted[sorted.length - 1];
}

function matchAndCompare(bomRows, crdRows, pn = '', bmcPfmMap = new Map(), biosPfmMap = new Map(), bmcPfmIdMap = new Map(), vrMap = new Map(), fruMap = new Map()) {
  const results = [];
  const usedCRDIdx   = new Set();
  const sharedCRDIdx = new Set(); // CRD rows shared by multiple BOM rows (e.g. C2195 BIOS #0 and #1)
  const matchedBOM   = new Set();
  const isC2080 = /^C2080/i.test((pn || '').trim());

  // Pair each BOM row to its best CRD match (by Location ≈ Item)
  for (const bomRow of bomRows) {
    // BOM rows with no specific version (* wildcard) are left as BOM_ONLY for manual review.
    if ((bomRow.ChildRevision || '').trim() === '*') continue;

    const best = findBestCRDMatch(bomRow, crdRows, usedCRDIdx);
    if (!best) continue;

    if (best.shared) {
      sharedCRDIdx.add(best.index);
    } else {
      usedCRDIdx.add(best.index);
    }

    const crdRow  = best.row;
    let   bomVer  = formatBOMVersion(bomRow);
    const loc     = (bomRow.Location        || '').trim();
    const childPN = (bomRow.ChildPartNumber || '').trim();
    // CRD Version is the golden reference across all families — extracted deterministically,
    // never adapted to the BOM. Notes is for row selection only (findBestCRDMatch).
    let crdVer           = (crdRow.Version || '').trim();
    let crdVersionSource = null;
    let crdVerDisplay    = null; // display-only: formatted to match BOM ChildRevision convention

    // Route purely by location-pattern family — no model names needed.
    // hasBIOSChildPN covers parts whose ChildPN encodes the firmware type (e.g. "C2195.BIOS").
    const hasBIOSChildPN = /\.BIOS$/i.test(childPN);

    if (isBIOSSlot(loc) || hasBIOSChildPN) {
      // BIOS #N / MB.BIOS #N — extract after "S." in the CRD Version column.
      const v = extractBIOSVersionAfterS(crdRow.Version);
      if (v) { crdVer = v; crdVersionSource = 'Version (.BS.)'; }
      const rev = (bomRow.ChildRevision || '').trim();
      if (rev && rev !== '*') bomVer = rev;
    } else if (isBIOSPFMSlot(loc)) {
      // BIOS #N.PFM / MB.BIOS #N.PFM — golden reference resolved via DeviceCfg lookup.
      // CRD BIOS PFMID Version (e.g. "0x36") is the PFM:ID key into DeviceCfg (PartNumber LIKE '%BIOSPFM').
      const pfmId = (crdRow.Version || '').trim();
      const v = pfmId ? biosPfmMap.get(pfmId) : undefined;
      if (v) { crdVer = v; crdVersionSource = 'DeviceCfg (PFM:ID)'; }
    } else if (isBMCSlot(loc)) {
      // BMC #N / MB.BMC #N — extract after ".BC." in the CRD Version column.
      const v = extractC2195BMCVersion(crdRow.Version);
      if (v) { crdVer = v; crdVersionSource = 'Version (.BC.)'; }
      const rev = (bomRow.ChildRevision || '').trim();
      if (rev) bomVer = rev;
    } else if (isBMCPFMSlot(loc)) {
      // BMC #N.PFM / MB.BMC #N.PFM — golden reference resolved via DeviceCfg PFM:ID lookup.
      // CRD BMC PFMID Version (e.g. "0x24") is the PFM:ID key into DeviceCfg (PartNumber LIKE '%BMCPFM').
      const pfmId = (crdRow.Version || '').trim();
      const v = pfmId ? bmcPfmIdMap.get(pfmId) : undefined;
      if (v) { crdVer = v; crdVersionSource = 'DeviceCfg (PFM:ID)'; }
      const rev = (bomRow.ChildRevision || '').trim();
      if (rev) bomVer = rev;
    } else if (isBMCDotSuffixSlot(loc)) {
      // BMC #N.xxx / MB.BMC #N.xxx — CRD golden reference from Version column (after ".BC.").
      const v = extractC2195BMCVersion(crdRow.Version);
      if (v) { crdVer = v; crdVersionSource = 'Firmware Central/BMC'; }
      // PFM variant: strip "PFMv2.84.bin" → "2.84" so scoring compares plain versions.
      const pfmVerCrd = extractPFMVersion(crdVer);
      if (pfmVerCrd) crdVer = pfmVerCrd;
      const rev = (bomRow.ChildRevision || '').trim();
      if (rev) {
        const pfmVerBom = extractPFMVersion(rev);
        bomVer = pfmVerBom || rev;
      }
      // Display: reconstruct BOM ChildRevision format substituting the CRD golden version.
      if (crdVer && rev) crdVerDisplay = formatBMCVersionInBOMStyle(rev, crdVer);
    } else if (isVRSlot(loc)) {
      // VR — golden reference from DeviceCfg (model extracted from CRD Notes →
      // ModelRef LIKE '{model}%' AND PartNumber LIKE '%VR' → latest Revision).
      // CRD Version column is never used for VR; vrMap is the authoritative source.
      const vrGolden = [...vrMap.values()][0];
      if (vrGolden) { crdVer = vrGolden; crdVersionSource = 'DeviceCfg (VR)'; }
      const rev = (bomRow.ChildRevision || '').trim();
      if (rev && rev !== '*') bomVer = rev;
    }
    // FRU is not handled here — findBestCRDMatch returns null for FRU (CRD has no FRU row),
    // so the dedicated FRU loop below owns the comparison entirely.

    // No CRD version for this item, or BOM slot is unpopulated — show as BOM_ONLY.
    if (!crdVer || (bomRow.ChildPartNumber || '').trim().toUpperCase() === 'NO_DEVICE') continue;

    matchedBOM.add(bomRow);

    const verScore = calculateVersionScore(bomVer, bomRow.ChildRevision, crdVer);

    results.push({
      type:              'MATCHED',
      bomLocation:       bomRow.Location,
      bomChildPN:        bomRow.ChildPartNumber,
      bomChildRev:       bomRow.ChildRevision,
      bomVersion:        bomVer,
      crdItem:           crdRow.Item,
      crdGroup:          crdRow.Group,
      crdVersion:        crdVerDisplay || crdVer,
      crdVersionSource,
      crdNotes:          crdRow.Notes,
      locationScore:     best.locationScore,
      versionScore:      verScore,
      status:            verScore >= 90 ? 'PASS' : 'FAIL',
      statusDetail:      verScore >= 90
        ? (verScore === 100 ? 'Exact match' : `Fuzzy match (${verScore}%)`)
        : `Version mismatch (${verScore}%)`
    });
  }

  // ── VR / MB.VR — dedicated loop ──────────────────────────────────────────────
  // Catches VR BOM rows not handled by the main loop (e.g. no CRD row ending in 'VR').
  // CRD Version is derived solely from DeviceCfg via vrMap — no BOM data used for golden ref.
  for (const bomRow of bomRows) {
    const loc = (bomRow.Location || '').trim();
    if (!isVRSlot(loc)) continue;
    if (matchedBOM.has(bomRow)) continue;
    if ((bomRow.ChildRevision || '').trim() === '*') continue;

    // vrMap is keyed by model code (from CRD Notes), value is DeviceCfg Revision — no BOM involved.
    const [vrModel, crdVer] = [...vrMap.entries()][0] || [];
    if (!crdVer) continue;

    const bomVer   = (bomRow.ChildRevision || '').trim();
    const verScore = calculateVersionScore(bomVer, bomRow.ChildRevision, crdVer);

    matchedBOM.add(bomRow);
    results.push({
      type:             'MATCHED',
      bomLocation:      bomRow.Location,
      bomChildPN:       bomRow.ChildPartNumber,
      bomChildRev:      bomRow.ChildRevision,
      bomVersion:       bomVer,
      crdItem:          vrModel ? `${vrModel}.VR` : 'VR',
      crdGroup:         null,
      crdVersion:       crdVer,
      crdVersionSource: 'DeviceCfg (VR)',
      crdNotes:         null,
      locationScore:    100,
      versionScore:     verScore,
      status:           verScore >= 90 ? 'PASS' : 'FAIL',
      statusDetail:     verScore >= 90
        ? (verScore === 100 ? 'Exact match' : `Fuzzy match (${verScore}%)`)
        : `Version mismatch (${verScore}%)`
    });
  }

  // ── FRU / MB.FRU — dedicated loop ───────────────────────────────────────────
  // Catches FRU BOM rows not handled by the main loop (e.g. no CRD row ending in 'FRU').
  // CRD Version is derived solely from DeviceCfg via fruMap — no BOM data used for golden ref.
  for (const bomRow of bomRows) {
    const loc = (bomRow.Location || '').trim();
    if (!isFRUSlot(loc)) continue;
    if (matchedBOM.has(bomRow)) continue;
    if ((bomRow.ChildRevision || '').trim() === '*') continue;

    const [fruModel, crdVer] = [...fruMap.entries()][0] || [];
    if (!crdVer) continue;

    const bomVer   = (bomRow.ChildRevision || '').trim();
    const verScore = calculateVersionScore(bomVer, bomRow.ChildRevision, crdVer);

    matchedBOM.add(bomRow);
    results.push({
      type:             'MATCHED',
      bomLocation:      bomRow.Location,
      bomChildPN:       bomRow.ChildPartNumber,
      bomChildRev:      bomRow.ChildRevision,
      bomVersion:       bomVer,
      crdItem:          fruModel ? `${fruModel}.FRU` : 'FRU',
      crdGroup:         null,
      crdVersion:       crdVer,
      crdVersionSource: 'DeviceCfg (FRU)',
      crdNotes:         null,
      locationScore:    100,
      versionScore:     verScore,
      status:           verScore >= 90 ? 'PASS' : 'FAIL',
      statusDetail:     verScore >= 90
        ? (verScore === 100 ? 'Exact match' : `Fuzzy match (${verScore}%)`)
        : `Version mismatch (${verScore}%)`
    });
  }

  // Unmatched BOM rows (no CRD counterpart found)
  for (const bomRow of bomRows) {
    if (!matchedBOM.has(bomRow)) {
      results.push({
        type:        'BOM_ONLY',
        bomLocation: bomRow.Location,
        bomChildPN:  bomRow.ChildPartNumber,
        bomChildRev: isC2080 ? 'PIC to check' : bomRow.ChildRevision,
        bomVersion:  formatBOMVersion(bomRow),
        status:      'NO_MATCH',
        statusDetail: 'No matching CRD item'
      });
    }
  }

  // Unmatched CRD rows (no BOM counterpart found)
  crdRows.forEach((crdRow, idx) => {
    if (!usedCRDIdx.has(idx) && !sharedCRDIdx.has(idx)) {
      results.push({
        type:        'CRD_ONLY',
        crdItem:     crdRow.Item,
        crdGroup:    crdRow.Group,
        crdVersion:  crdRow.Version,
        crdNotes:    crdRow.Notes,
        status:      'NO_MATCH',
        statusDetail: 'No matching BOM location'
      });
    }
  });

  // Sort: FAIL → PASS → NO_MATCH
  const order = { FAIL: 0, PASS: 1, NO_MATCH: 2 };
  return results.sort((a, b) => (order[a.status] ?? 3) - (order[b.status] ?? 3));
}

function findBestCRDMatch(bomRow, crdRows, usedIdx) {
  const loc     = (bomRow.Location        || '').trim();
  const childPN = (bomRow.ChildPartNumber || '').trim();

  // Some models encode the firmware family in ChildPartNumber (e.g. "C2195.BIOS", "C2082.BIOS")
  // rather than — or in addition to — a "BIOS #N" Location string.
  // Detect it generically so no model name is needed here.
  const hasBIOSChildPN = /\.BIOS$/i.test(childPN);

  // ── BIOS #N / MB.BIOS #N (all models) ─────────────────────────────────────
  // CRD row: Item LIKE '%MB BIOS%' or '%SCM BIOS%'
  //          Notes blank/null, or contains 'Firmware Central/BIOS' — but never BSL or CM.
  // All slots share one CRD entry → shared: true.
  if (isBIOSSlot(loc) || hasBIOSChildPN) {
    for (let idx = 0; idx < crdRows.length; idx++) {
      const item  = (crdRows[idx].Item  || '').trim();
      const notes = (crdRows[idx].Notes || '').trim();
      const isBiosItem = /mb\s*bios|scm\s*bios/i.test(item);
      const notesOk    = !notes || /Firmware\s+Central\/BIOS/i.test(notes);
      const notesClean = !/\bBSL\b/i.test(notes) && !/\bCM\b/i.test(notes);
      if (isBiosItem && notesOk && notesClean) {
        return { row: crdRows[idx], index: idx, locationScore: 100, shared: true };
      }
    }
    return null;
  }

  // ── BIOS #N.PFM / MB.BIOS #N.PFM (all models) ─────────────────────────────
  // CRD row: Item LIKE '%BIOS PFMID'.
  // All BIOS #N.PFM slots (#0, #1, …) share the same single CRD PFM entry → shared: true.
  if (isBIOSPFMSlot(loc)) {
    for (let idx = 0; idx < crdRows.length; idx++) {
      if (/bios\s*pfmid$/i.test((crdRows[idx].Item || '').trim())) {
        return { row: crdRows[idx], index: idx, locationScore: 100, shared: true };
      }
    }
    return null;
  }

  // ── BMC #N.PFM / MB.BMC #N.PFM (all models) ───────────────────────────────
  // CRD row: Item ⊃ "PFMID" but NOT "BIOS" (e.g. "BMC PFMID", "DC-SCM BMC PFMID").
  // Explicitly excludes BIOS PFMID rows (e.g. "DC-SCM BIOS PFMID") which share the same suffix.
  // Golden version is resolved via DeviceCfg, not from the CRD Version column.
  // All slots (#0, #1, …) share the same single CRD PFM entry → shared: true.
  // Must run before the general BMC dot-suffix block.
  if (isBMCPFMSlot(loc)) {
    for (let idx = 0; idx < crdRows.length; idx++) {
      const item = crdRows[idx].Item || '';
      if (/pfmid/i.test(item) && !/bios/i.test(item)) {
        return { row: crdRows[idx], index: idx, locationScore: 100, shared: true };
      }
    }
    return null;
  }

  // ── BMC power-capping variants (all models, all spellings) ────────────────
  // BMC #N.PWRCAP / BMC #N.PowerCapping / MB.BMC #N.PWRCAP …
  // Must run before the general BMC dot-suffix block: the suffix string "pwrcap" never
  // appears in the CRD Item "BMC Power Capping", so a substring search would miss it.
  // CRD row: Notes ⊃ "Firmware Central/BMC", Item ⊃ "BMC Power Capping".
  if (isBMCDotSuffixSlot(loc) && isPowerCapping(getBMCSuffixAny(loc))) {
    for (let idx = 0; idx < crdRows.length; idx++) {
      const notes = (crdRows[idx].Notes || '').toLowerCase();
      const item  = (crdRows[idx].Item  || '').toLowerCase();
      if (/firmware\s*central\/bmc/i.test(notes) && /bmc\s*power\s*capp?/i.test(item)) {
        return { row: crdRows[idx], index: idx, locationScore: 100, shared: true };
      }
    }
    return null;
  }

  // ── BMC #N / MB.BMC #N (all models) ───────────────────────────────────────
  // CRD row: Item ⊃ "bmc", Version ⊃ ".BC.".
  if (isBMCSlot(loc)) {
    for (let idx = 0; idx < crdRows.length; idx++) {
      if (/bmc/i.test(crdRows[idx].Item || '') && /\.BC\./i.test(crdRows[idx].Version || '')) {
        return { row: crdRows[idx], index: idx, locationScore: 100, shared: true };
      }
    }
    return null;
  }

  // ── BMC #N.xxx / MB.BMC #N.xxx (all models, non-power-capping) ────────────
  // CRD row: Notes ⊃ "Firmware Central/BMC/", Notes or Item ⊃ service-type suffix keyword.
  if (isBMCDotSuffixSlot(loc)) {
    const suffix = (getBMCSuffixAny(loc) || '').toLowerCase();
    for (let idx = 0; idx < crdRows.length; idx++) {
      const notes    = (crdRows[idx].Notes || '').toLowerCase();
      const item     = (crdRows[idx].Item  || '').toLowerCase();
      const itemNorm = item.replace(/\s+/g, '');
      if (/firmware\s*central\/bmc\//i.test(notes) &&
          suffix && (notes.includes(suffix) || item.includes(suffix) || itemNorm.includes(suffix))) {
        return { row: crdRows[idx], index: idx, locationScore: 100, shared: true };
      }
    }
    return null;
  }

  // ── VR (all models) ────────────────────────────────────────────────────────
  // CRD row: Item ends with 'VR' (e.g. "C2195.VR").
  // Golden version resolved via DeviceCfg VR lookup (vrMap: model → latest Revision).
  // All VR BOM slots share the one CRD VR entry → shared: true.
  if (isVRSlot(loc)) {
    for (let idx = 0; idx < crdRows.length; idx++) {
      if (/vr$/i.test((crdRows[idx].Item || '').trim())) {
        return { row: crdRows[idx], index: idx, locationScore: 100, shared: true };
      }
    }
    return null;
  }

  // ── FRU (all models) ───────────────────────────────────────────────────────
  // CRD specs do not carry a FRU row, so this block always returns null.
  // Returning null here prevents FRU BOM slots from falling through to the general
  // location-similarity path and picking up an unrelated CRD row.
  // The golden reference and MATCHED result are produced entirely by the dedicated
  // FRU loop in matchAndCompare (fruMap ← DeviceCfg, PartNumber LIKE '%FRU').
  if (isFRUSlot(loc)) return null;

  // ── General: location-name similarity OR direct version match ──────────────
  // Firmware-family BOM locations all return above; only non-firmware locations reach here.
  // Firmware CRD rows are also excluded — they must never match via the general path
  // (e.g. "MB.M.2 #N" shares the "mb" keyword with "MB BIOS", causing false positives).
  //
  // Two independent signals — takes whichever scores higher:
  //   1. Location name similarity  ("M.2 #2" ↔ "M.2 Drive")
  //   2. CRD Version vs BOM ChildRevision / ChildPartNumber  ("51080A30" ↔ "51080A30")
  //
  // Version-driven matches are marked shared so multiple BOM slots (M.2 #1…#6) can all
  // compare against the same single CRD entry without the first slot consuming it.
  const bomRev = (bomRow.ChildRevision   || '').trim();
  const bomPN  = (bomRow.ChildPartNumber || '').trim();

  let best = null;
  let bestScore = 0;
  crdRows.forEach((crdRow, idx) => {
    if (usedIdx.has(idx)) return;
    if (isFirmwareCRDRow(crdRow)) return; // never match firmware CRD rows via location/version similarity

    const locScore = locationScore(bomRow.Location, crdRow.Item);

    // Direct version match: CRD Version searches BOM version fields.
    // normVer handles general normalization; normBCVersion additionally strips trailing
    // zeros per segment so "15.23.17664.0" matches "15.23.17664.00".
    let verScore = 0;
    const crdVerRaw = (crdRow.Version || '').trim();
    if (crdVerRaw) {
      const crdNorm   = normVer(crdVerRaw);
      const crdBCNorm = normBCVersion(crdVerRaw);
      if (bomRev && bomRev !== '*' &&
          (normVer(bomRev) === crdNorm || normBCVersion(bomRev) === crdBCNorm)) verScore = 100;
      if (!verScore && bomPN && bomPN.toUpperCase() !== 'NO_DEVICE' &&
          (normVer(bomPN) === crdNorm || normBCVersion(bomPN) === crdBCNorm)) verScore = 100;
    }

    const score = Math.max(locScore, verScore);
    if (score > bestScore && score >= 40) {
      bestScore = score;
      // Version-driven match → shared: multiple BOM slots with the same PN/version
      // (e.g. MB.M.2 #1…#6) all compare against the one CRD entry.
      const shared = verScore === 100 && verScore > locScore;
      best = { row: crdRow, index: idx, locationScore: score, shared };
    }
  });
  return best;
}

// Returns true for CRD rows that belong to a firmware family (BIOS, BMC, PFM, etc.).
// These rows are handled exclusively by their dedicated paths in findBestCRDMatch and
// must never be matched via the general location/version similarity path.
function isFirmwareCRDRow(crdRow) {
  const item  = (crdRow.Item    || '').trim();
  const notes = (crdRow.Notes   || '').trim();
  const ver   = (crdRow.Version || '').trim();
  if (/mb\s*bios|scm\s*bios/i.test(item))                          return true; // BIOS main
  if (/bios\s*pfmid$/i.test(item))                                  return true; // BIOS PFMID
  if (/bmc/i.test(item) && /\.BC\./i.test(ver))                     return true; // BMC main
  if (/pfmid/i.test(item) && !/bios/i.test(item))                   return true; // BMC PFMID
  if (/firmware\s*central\/bmc/i.test(notes))                       return true; // BMC dot-suffix / power-cap
  if (/fru$/i.test(item))                                            return true; // FRU
  if (/vr$/i.test(item))                                             return true; // VR
  return false;
}

// ── BIOS special-case helpers ──────────────────────────────────────────────

// "BIOS #N" — any digit(s), no .PFM suffix (covers BIOS #0, BIOS #1, etc.)
function isBIOS0(loc) {
  return /^bios\s*#\s*\d+$/i.test(loc);
}

// "BIOS #N.PFM" where N is any digit(s)
function isBIOSPFM(loc) {
  return /^bios\s*#\s*\d+\.pfm$/i.test(loc);
}

// "MB.BIOS #N" — any digit(s), no .PFM suffix (C2080/C2082 parts)
function isMBBIOS0(loc) {
  return /^mb\.bios\s*#\s*\d+$/i.test(loc);
}

// "MB.BIOS #N.PFM" where N is any digit(s) (C2080/C2082 parts)
function isMBBIOSPFM(loc) {
  return /^mb\.bios\s*#\s*\d+\.pfm$/i.test(loc);
}

// "BMC #N" — any digit(s)
function isBMC(loc) {
  return /^bmc\s*#\s*\d+$/i.test(loc);
}

// "BMC #N.xxx" — any digit(s) followed by a dot-suffix (FanTable, Inventory, SDRgenerator, etc.)
function isBMCDotSuffix(loc) {
  return /^bmc\s*#\s*\d+\.\S/i.test(loc);
}

// Extract the service-type suffix after "BMC #N." (e.g. "FanTable" from "BMC #0.FanTable")
function getBMCSuffix(loc) {
  const m = loc.match(/^bmc\s*#\s*\d+\.(.+)$/i);
  return m ? m[1].trim() : null;
}

// "MB.BMC #N" — C2082 uses MB. prefix for all locations
function isMBBMC(loc) {
  return /^mb\.bmc\s*#\s*\d+$/i.test(loc);
}

// "MB.BMC #N.xxx" — C2082 dot-suffix variant
function isMBBMCDotSuffix(loc) {
  return /^mb\.bmc\s*#\s*\d+\.\S/i.test(loc);
}

// Extract service-type suffix after "MB.BMC #N." (e.g. "FanTable" from "MB.BMC #0.FanTable")
function getMBBMCSuffix(loc) {
  const m = loc.match(/^mb\.bmc\s*#\s*\d+\.(.+)$/i);
  return m ? m[1].trim() : null;
}

// True when a BMC dot-suffix refers to power capping, regardless of spelling or model.
// Matches: PWRCAP, PowerCap, PowerCapping, Pwr_Cap, PwrCapping, P.Cap, PowerCapping, etc.
function isPowerCapping(suffix) {
  const s = (suffix || '').replace(/[\s._-]/g, '').toLowerCase();
  return /^p(?:wr|ower)?capp?(?:ing)?$/.test(s);
}

// ── Location-family slot helpers ───────────────────────────────────────────
// Unify standard and MB-prefixed variants so routing never needs model names.
// Add a new isMB<Family> helper here and the slot helper below — nothing else changes.
function isBIOSSlot(loc)         { return isBIOS0(loc)         || isMBBIOS0(loc); }
function isBIOSPFMSlot(loc)      { return isBIOSPFM(loc)       || isMBBIOSPFM(loc); }
function isBMCSlot(loc)          { return isBMC(loc)           || isMBBMC(loc); }
function isBMCPFM(loc)           { return /^bmc\s*#\s*\d+\.pfm$/i.test(loc); }
function isMBBMCPFM(loc)         { return /^mb\.bmc\s*#\s*\d+\.pfm$/i.test(loc); }
function isBMCPFMSlot(loc)       { return isBMCPFM(loc)        || isMBBMCPFM(loc); }
function isBMCDotSuffixSlot(loc) { return isBMCDotSuffix(loc)  || isMBBMCDotSuffix(loc); }
function getBMCSuffixAny(loc)    { return getBMCSuffix(loc)    || getMBBMCSuffix(loc) || null; }

// "FRU" or "MB.FRU" — covers all model variants (e.g. C2195 uses FRU, C2082 uses MB.FRU).
function isFRUSlot(loc) { return /^(?:mb\.)?fru$/i.test((loc || '').trim()); }

// "VR" or "MB.VR" — voltage regulator firmware location (all models).
function isVRSlot(loc) { return /^(?:mb\.)?vr$/i.test((loc || '').trim()); }

// For BMC #N.xxx / MB.BMC #N.xxx: rewrite ChildRevision format using the CRD version number.
// Preserves the surrounding prefix/suffix; replaces only the version-bearing segment.
// C2195: "COMPUTEGP_MH_80C_3.10.1"  + crdVer "4.15.2"  → "COMPUTEGP_MH_80C_4.15.2"
// C2082: "1.10.22_GPMM82"           + crdVer "1.10.22"  → "1.10.22_GPMM82"
// S226A: "EXO_BALANCED_7.1_1.0.3"   + crdVer "1.0.3"   → "EXO_BALANCED_7.1_1.0.3"
function formatBMCDotSuffixCRDVersion(childRevision, crdVersion) {
  if (!childRevision || !crdVersion) return crdVersion;
  const segments = childRevision.split('_');
  if (segments.length < 2) return crdVersion;

  // Pass 1: exact segment match (handles PASS case — BOM already has the right version).
  let verIdx = segments.findIndex(s => s.trim() === crdVersion.trim());

  // Pass 2: scan from the end for last version-pattern segment (handles FAIL case).
  // Scanning from the end avoids mistaking a platform prefix like "7.1" for the firmware version.
  if (verIdx === -1) {
    for (let i = segments.length - 1; i >= 0; i--) {
      if (/^\d+\.\d+/.test(segments[i].trim())) { verIdx = i; break; }
    }
  }

  if (verIdx === -1) return crdVersion;
  const result = [...segments];
  result[verIdx] = crdVersion;
  return result.join('_');
}

// Reconstruct BOM ChildRevision format substituting the CRD golden version number.
// Handles both underscore-delimited families and dot-based PFM format.
// "EXO_BALANCED_7.1_1.0.3"  + "1.0.3"  → "EXO_BALANCED_7.1_1.0.3"
// "C2160.BC.PFMV2.84.BIN"   + "2.84"   → "C2160.BC.PFMV2.84.BIN"
// "C2160.BC.PFMV2.80.BIN"   + "2.84"   → "C2160.BC.PFMV2.84.BIN"  (FAIL: shows expected)
function formatBMCVersionInBOMStyle(childRev, crdVersion) {
  if (!childRev || !crdVersion) return crdVersion;
  if (childRev.includes('_')) return formatBMCDotSuffixCRDVersion(childRev, crdVersion);
  // Dot-based PFM format: find the first purely numeric version pattern and replace it.
  // e.g. "C2160.BC.PFMV2.84.BIN" → the "2160" won't match because "C2160." starts with C;
  // the first all-numeric d+.d+ is "2.84" at the PFMV segment.
  const m = childRev.match(/\d+\.\d+(\.\d+)*/);
  if (m) return childRev.slice(0, m.index) + crdVersion + childRev.slice(m.index + m[0].length);
  return crdVersion;
}

// Normalize for BMC combination matching: lowercase, strip everything non-alphanumeric
function normBMC(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// For BMC #N.xxx rows: derive the CRD Version display value that matches BOM ChildRevision.
// Strategy 1 (primary): ChildRevision contains the CRD Version number AND the remaining
//   non-version text appears somewhere in the CRD Notes → return ChildRevision directly.
// Strategy 2 (fallback): try all Notes path tokens combined with Version in both orders;
//   return the combination with ≥95% similarity to ChildRevision, or raw Version otherwise.
function findBestBMCCombination(notes, version, childRevision) {
  const ver = (version || '').trim();
  if (!childRevision) return ver || null;

  const notesNorm  = normBMC(notes  || '');
  const verNorm    = normBMC(ver);
  const targetNorm = normBMC(childRevision);

  if (!targetNorm || !verNorm) return ver || null;

  // Strategy 1: ChildRevision = Version + extra text that is found in Notes
  if (targetNorm.includes(verNorm)) {
    const remainder = targetNorm.replace(verNorm, '').trim();
    if (remainder.length > 2 && notesNorm.includes(remainder)) {
      return childRevision;
    }
  }

  // Strategy 2: generate all path tokens from Notes (split on '/', '_', '-') and try
  // combining each with Version in both orders ({token}_{ver} and {ver}_{token})
  const rawSegments = (notes || '').split('/').map(s => s.trim()).filter(s => s.length > 2);
  const allTokens = new Set(rawSegments);
  for (const seg of rawSegments) {
    for (const sub of seg.split(/[_\-]/)) {
      if (sub.trim().length > 2) allTokens.add(sub.trim());
    }
  }

  let bestCombo = ver;
  let bestScore  = strSim(verNorm, targetNorm);

  for (const seg of allTokens) {
    for (const sep of ['_', '', ' ']) {
      for (const combo of [`${seg}${sep}${ver}`, `${ver}${sep}${seg}`]) {
        const score = strSim(normBMC(combo), targetNorm);
        if (score > bestScore) { bestScore = score; bestCombo = combo; }
      }
    }
  }

  return bestScore >= 0.95 ? bestCombo : ver;
}

// Extract version from Notes like "Firmware Central/BIOS/3A03.GN.1"
// Also handles device-prefix paths: "Firmware Central/BIOS/C2195/ 3A17.GN.1"
// The version is the last dot-containing token; device prefixes (C2195, C2082) have no dots.
function extractFWCentralVersion(notes) {
  const m = (notes || '').match(/Firmware\s+Central\/BIOS\/([^\n,;]+)/i);
  if (!m) return null;
  const tokens = m[1].trim().split(/[\/\s]+/).map(t => t.trim()).filter(Boolean);
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (tokens[i].includes('.')) return tokens[i];
  }
  return null;
}

// Extract version from Notes like "File: SomeProjPFMv1.23_release.bin" → "1.23"
// Also handles hex (PFMv0x36) and plain integer (PFMv54)
function extractPFMVersion(notes) {
  const m = (notes || '').match(/PFMv((?:0x)?[\da-fA-F]+(?:\.[\da-fA-F]+)*)/i);
  return m ? m[1].trim() : null;
}

// C2195 BIOS: extract from Notes like "Firmware Central/BIOS/C2195.BS.3A17.GN.1.G"
//             or "Firmware Central/BIOS/C2195.0.BS.3A17.GN.1" (no trailing .G)
// Returns → "3A17.GN.1"
function extractC2195BIOSVersion(notes) {
  // Format with trailing .G: "...C2195.BS.3A17.GN.1.G"
  const m1 = (notes || '').match(/S\.(.+?)\.G(?=\s|[,;\/]|$)/i);
  if (m1) return m1[1].trim();
  // Format without trailing .G: "...C2195.0.BS.3A17.GN.1" or "...C2195.0.BS.3A17.GN.1.zip"
  const m2 = (notes || '').match(/\.BS\.([^\/\s,;]+)/i);
  if (m2) return m2[1].replace(/\.[a-z]{2,4}$/i, '').trim();
  return null;
}

// C2195 BIOS: extract version from a string with ".BS." like "C2195.0.BS.3A17.GN.1" or "C2195.0.BS.3A17.GN.1.zip"
// Returns the value after "BS." stripped of any file extension → "3A17.GN.1"
function extractC2195BIOSVersionFromPN(str) {
  const m = (str || '').match(/\.BS\.([^\/\s,;]+)/i);
  if (!m) return null;
  return m[1].replace(/\.[a-z]{2,4}$/i, '').trim();
}

// Extract a model code (e.g. "C2195", "S2260") from a version string when no Model column is available.
function extractModelCode(version) {
  const m = (version || '').match(/\b([A-Z]\d{4})\b/i);
  return m ? m[1].trim() : null;
}

// Extract BIOS version from CRD Version column: take the part after 'BS.' up to any whitespace.
// "C2195.BS.3A17.GN.1.G"                    → "3A17.GN.1.G"
// "C2195.0.BS.3A17.GN.1"                    → "3A17.GN.1"
// "C2080.BS.1D27.GN2.Master_Package_Afu.zip" → "1D27.GN2.Master_Package_Afu.zip"
function extractBIOSVersionAfterS(version) {
  if (!version) return null;
  const m = version.match(/\.BS\.(\S+)/i);
  return m ? m[1].trim() : null;
}

// C2195 PFM: extract from Notes like "File: C2195.BS.PFMv2.54.bin"
// Returns the value between "PFMv" and ".bin" → "2.54"
function extractC2195PFMVersion(notes) {
  const m = (notes || '').match(/PFMv(.+?)\.bin\b/i);
  return m ? m[1].trim() : null;
}

// C2195 BMC: extract from Version like "C2195.BC.1.23.00"
// Returns the value after ".BC." → "1.23.00"
function extractC2195BMCVersion(version) {
  const m = (version || '').match(/\.BC\.(\S+)/i);
  return m ? m[1].trim() : null;
}

// Normalize a BC version string for format-agnostic comparison.
// Step 1 – convert condensed XXYY format: "0447.00" → "4.47.00"
//   (first two digits are zero-padded major, next two are minor)
// Step 2 – strip leading zeros from every dot-separated numeric segment
//   so "4.06.00", "04.06.00", "4.6.0" all reduce to the same canonical form.
// Result: "0447.00" and "4.47.00" both become "4.47.0" → exact match.
function normBCVersion(v) {
  if (!v) return v;
  // Step 1: XXYY... → X.YY... (only when first two chars form a zero-padded group)
  let r = v.replace(/^(\d{2})(\d{2})(?=[.\s]|$)/, (_, a, b) => `${parseInt(a, 10)}.${b}`);
  // Step 2: strip leading zeros from each numeric dot-segment ("06" → "6", "00" → "0")
  r = r.split('.').map(seg => /^\d+$/.test(seg) ? String(parseInt(seg, 10)) : seg).join('.');
  return r;
}


// Score how well a BOM Location matches a CRD Item (0-100)
function locationScore(bomLoc, crdItem) {
  if (!bomLoc || !crdItem) return 0;

  const a = normLocation(bomLoc);
  const b = normLocation(crdItem);

  if (a === b) return 100;

  // Keyword overlap (Jaccard on words)
  const wa = new Set(a.split(/\s+/).filter(w => w.length > 1));
  const wb = new Set(b.split(/\s+/).filter(w => w.length > 1));
  if (wa.size === 0 || wb.size === 0) return 0;

  const intersection = [...wa].filter(w => wb.has(w) || [...wb].some(bw => bw.includes(w) || w.includes(bw)));
  const union = new Set([...wa, ...wb]).size;
  const jaccard = intersection.length / union;
  if (jaccard >= 0.4) return Math.round(jaccard * 100);

  // Substring containment (require shorter string ≥ 3 chars to avoid "os"⊂"bios" false positives)
  const minLen = Math.min(a.length, b.length);
  if (minLen >= 3 && (a.includes(b) || b.includes(a))) {
    return Math.round((minLen / Math.max(a.length, b.length)) * 80);
  }

  // Levenshtein fallback
  return Math.round(strSim(a, b) * 60);
}

function normLocation(s) {
  return s.toLowerCase()
    .replace(/#\s*\d+/g, '')         // remove "#0", "# 1"
    .replace(/[^a-z0-9\s]/g, ' ')    // non-alphanumeric → space
    .replace(/\s+/g, ' ')
    .trim();
}

// Score how well a single BOM candidate matches the CRD golden reference (0-100).
// Tries exact → BC-normalised → normalised-string → fuzzy, in that order.
function scoreBOMCandidate(candidate, crdVersion, bcCrd, crdNorm) {
  if (!candidate) return 0;
  const v = candidate.trim();
  if (!v || v === '*') return 0;
  if (v === crdVersion.trim()) return 100;
  if (normBCVersion(v) === bcCrd) return 100;
  const n = normVer(v);
  if (n === crdNorm) return 100;

  // BMC family ChildRevisions embed the CRD version as an underscore-delimited segment.
  // C2195 format: "COMPUTEGP_MH_80C_4.15.2"  → segment "4.15.2"
  // C2082 format: "1.10.22_GPMM82"            → segment "1.10.22"
  if (v.includes('_')) {
    for (const seg of v.split('_')) {
      const s = seg.trim();
      if (!s) continue;
      if (s === crdVersion.trim()) return 100;
      if (normBCVersion(s) === bcCrd) return 100;
      if (normVer(s) === crdNorm) return 100;
    }
  }

  return Math.round(strSim(n, crdNorm) * 100);
}

// CRD Version is the golden reference — it is never modified.
// BOM side tries every available candidate (ChildRevision, combined PN+Rev) and
// returns whichever scores highest against the fixed CRD reference.
function calculateVersionScore(bomVersion, childRevision, crdVersion) {
  if (!bomVersion && !childRevision && !crdVersion) return 100;
  if (!crdVersion) return 0;

  const bcCrd   = normBCVersion(crdVersion);
  const crdNorm = normVer(crdVersion);

  const revScore = scoreBOMCandidate(childRevision, crdVersion, bcCrd, crdNorm);
  const bomScore = scoreBOMCandidate(bomVersion,    crdVersion, bcCrd, crdNorm);

  return Math.max(revScore, bomScore);
}

function normVer(v) {
  return (v || '').toLowerCase().replace(/[^a-z0-9.]/g, '').trim();
}

function formatBOMVersion(row) {
  const pn  = (row.ChildPartNumber || '').trim();
  const rev = (row.ChildRevision   || '').trim();
  if (!pn && !rev) return '';
  if (!rev || rev === '*') return pn;
  return `${pn} ${rev}`;
}

function strSim(a, b) {
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  if (a === b)  return 1;
  const maxLen = Math.max(a.length, b.length);
  return (maxLen - levenshtein(a, b)) / maxLen;
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => Array(n + 1).fill(0).map((_, j) => i === 0 ? j : j === 0 ? i : 0));
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] : 1 + Math.min(dp[i-1][j-1], dp[i-1][j], dp[i][j-1]);
  return dp[m][n];
}

// ── SPA fallback (serves index.html for any non-API route in production) ───
if (fs.existsSync(clientDist)) {
  app.get('*', (req, res) => res.sendFile(path.join(clientDist, 'index.html')));
}

// ── Start ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`BOM Checker running at http://localhost:${PORT}`));
