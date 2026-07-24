const express = require('express');
const path = require('path');
const fs = require('fs');
const { sql, query, annonPool, annonWritePool } = require('./DB');
const { fetchMoItem } = require('./services/moApiClient');

require('dotenv').config({ path: path.join(__dirname, '..', 'config', 'credentials', 'automation.env') });

const app = express();
app.use(express.json());

// Serve the built Frontend (npm run build --prefix ../Frontend) when present.
// In development, the Vite dev server (npm run dev --prefix ../Frontend) serves the UI instead.
const clientDist = path.join(__dirname, '..', 'Frontend', 'dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
}

// Pattern for CRD spec part numbers: e.g. M1389927-001
const CRD_PN_PATTERN = /^[A-Z]\d{7}-\d{3}$/;

// Identify the CRD reference row inside a SysBom row set.
//   Criteria: ChildPartNumber matches M1234567-001 pattern, or Location/Type = 'CRD'
// Shared by /api/compare and /api/part-detail — both derive the same
// CRDspec/FRUspec lookup key (SpecNumber) from this one row.
function findCrdRefRow(bomRows) {
  return bomRows.find(r =>
    CRD_PN_PATTERN.test((r.ChildPartNumber || '').trim()) ||
    (r.Location || '').toUpperCase() === 'CRD' ||
    (r.Type || '').toUpperCase() === 'CRD'
  );
}

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
    const crdRefRow = findCrdRefRow(bomRows);

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

// MO Category → QVL Model Reference / Location, per MonicaTPGenerator.xml.
const MO_CATEGORY_TO_QVL = {
  L10: { modelRef: 'C2012_L10', location: 'L10' },
  L11: { modelRef: 'C2012_L11', location: 'L11' },
};

// Read-only: SP_QVL_Query_DESC(ModelRef, Location) → [{ModelRef, Location, PartNumber, Description}].
// Shared by /api/mo-lookup (fixed L10/L11 models) and /api/qvl-list (any model
// from /api/models) — same query, just not hardcoded to one model reference.
async function fetchQvlList(modelRef, location) {
  const qvlResult = await query(
    'EXEC BOM.dbo.SP_QVL_Query_DESC @ModelRef = @modelRef, @Location = @location',
    [
      { name: 'modelRef', type: sql.NVarChar, value: modelRef },
      { name: 'location', type: sql.NVarChar, value: location }
    ]
  );
  return qvlResult.recordset;
}

// ── API: MO lookup + QVL check ──────────────────────────────────────────────
app.post('/api/mo-lookup', async (req, res) => {
  const { moNumber, moCategory, partNumber } = req.body;
  if (!moNumber?.trim()) {
    return res.status(400).json({ error: 'MO Number is required.' });
  }

  try {
    const { params, xml } = await fetchMoItem(moNumber.trim());
    const response = {
      moNumber: moNumber.trim(),
      moCategory: moCategory || null,
      requestParams: params,
      rawResponse: xml
    };

    if (partNumber?.trim()) {
      const target = MO_CATEGORY_TO_QVL[moCategory];
      if (!target) {
        return res.status(400).json({ error: `Unknown MO Category "${moCategory}".` });
      }

      const qvlRows = await fetchQvlList(target.modelRef, target.location);
      const pn = partNumber.trim();
      const match = qvlRows.find(r => (r.PartNumber || '').trim().toUpperCase() === pn.toUpperCase());

      // Read-only: does this exact part number already have a BOM loaded?
      // Distinct from inQVL above — a part can be known to QVL before its BOM exists.
      const bomCheck = await query(
        'SELECT TOP 1 1 AS found FROM bom.dbo.SysBom WHERE ParentPartNumber = @pn',
        [{ name: 'pn', type: sql.NVarChar, value: pn }]
      );

      response.qvl = {
        modelRef: target.modelRef,
        location: target.location,
        partNumber: pn,
        inQVL: Boolean(match),
        description: match ? match.Description : null,
        qvlRowCount: qvlRows.length,
        qvlList: qvlRows.map(r => ({ partNumber: r.PartNumber, description: r.Description })),
        bomExists: bomCheck.recordset.length > 0
      };
    }

    res.json(response);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── API: full Model Reference list (for the TPG Check page's dropdown) ─────
//
// Read-only: SP_LocationTable_Model_Distinct → [{ModelRef, Level}]. The
// vendored MonicaTPGenerator.xml fixture only defines 9 of these — it's a
// stale snapshot — so this queries live instead of parsing that file.
app.get('/api/models', async (req, res) => {
  try {
    const result = await query('EXEC BOM.dbo.SP_LocationTable_Model_Distinct');
    res.json({
      models: result.recordset.map(r => ({ modelRef: r.ModelRef, location: r.Level }))
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── API: CRD Tracker — list, one row per L10 component (latest week only) ──
app.get('/api/crd-tracker/lines', async (req, res) => {
  try {
    const [linesResult, currentWeekResult] = await Promise.all([
      annonPool.query(`
        WITH latest_week AS (
          SELECT DISTINCT ON (line_id)
            line_id, week_label, crd_code, iso_year, work_week
          FROM tracking.crdbom_week_status
          ORDER BY line_id, iso_year DESC, work_week DESC
        )
        SELECT
          l.id                                  AS line_id,
          c.id                                  AS component_id,
          l.line_no                             AS no,
          l.gen                                 AS gen,
          l.l11_msf                             AS l11_msf,
          l.l11_sku                             AS l11_sku,
          l.crd_number                          AS crd_number,
          c.l10_msf                             AS l10_msf,
          c.l10_sku                             AS l10_sku,
          l.wts_ticket                          AS wts_ticket,
          l.wts_link                            AS wts_link,
          c.current_crd_te                      AS current_crd_te,
          to_char(c.date_update, 'YYYY-MM-DD')  AS date_update,
          lw.week_label                         AS latest_week_label,
          lw.crd_code                           AS latest_crd_code,
          lw.iso_year                           AS latest_iso_year,
          lw.work_week                          AS latest_work_week
        FROM tracking.crdbom_line l
        LEFT JOIN tracking.crdbom_component c ON c.line_id = l.id
        LEFT JOIN latest_week lw            ON lw.line_id = l.id
        ORDER BY l.line_no, c.id
      `),
      annonPool.query(`
        SELECT
          EXTRACT(isoyear FROM CURRENT_DATE)::int AS current_iso_year,
          EXTRACT(week     FROM CURRENT_DATE)::int AS current_work_week
      `),
    ]);
    const { current_iso_year, current_work_week } = currentWeekResult.rows[0];
    const rows = [
      ...linesResult.rows.map(r => ({
        lineId: r.line_id,
        componentId: r.component_id,
        no: r.no,
        gen: r.gen,
        l11Msf: r.l11_msf,
        l11Sku: r.l11_sku,
        crdNumber: r.crd_number,
        l10Msf: r.l10_msf,
        l10Sku: r.l10_sku,
        wtsTicket: r.wts_ticket,
        wtsLink: r.wts_link,
        currentCrdTe: r.current_crd_te,
        dateUpdate: r.date_update,
        latestWeekLabel: r.latest_week_label,
        latestCrdCode: r.latest_crd_code,
        latestIsoYear: r.latest_iso_year,
        latestWorkWeek: r.latest_work_week,
        isTest: false,
      })),
      ...[...crdTestLines.values()].map(({ testHistory, ...row }) => row),
    ].sort((a, b) => a.no - b.no);
    res.json({
      currentIsoYear: current_iso_year,
      currentWorkWeek: current_work_week,
      rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── API: CRD Tracker — full weekly history for one line (drill-down) ──────
app.get('/api/crd-tracker/lines/:lineId/history', async (req, res) => {
  const lineId = Number(req.params.lineId);
  if (!Number.isInteger(lineId) || lineId === 0) {
    return res.status(400).json({ error: 'lineId must be a non-zero integer.' });
  }
  // Negative lineId = synthetic id for an in-memory Test line — served from
  // its own local history, never queries Postgres.
  if (lineId < 0) {
    const testRow = crdTestLines.get(-lineId);
    if (!testRow) return res.status(404).json({ error: `Test line ${-lineId} not found.` });
    return res.json({ lineId, history: testRow.testHistory || [] });
  }
  try {
    const result = await annonPool.query(
      `SELECT
         week_label,
         iso_year,
         work_week,
         to_char(week_start_date, 'YYYY-MM-DD') AS week_start_date,
         crd_code
       FROM tracking.crdbom_week_status
       WHERE line_id = $1
       ORDER BY iso_year ASC, work_week ASC`,
      [lineId]
    );
    res.json({
      lineId,
      history: result.rows.map(r => ({
        weekLabel: r.week_label,
        isoYear: r.iso_year,
        workWeek: r.work_week,
        weekStartDate: r.week_start_date,
        crdCode: r.crd_code,
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── CRD Tracker: revision-code vocabulary ──────────────────────────────────
// Tries the live dimension table first; falls back to computing the same
// bijective base-26 sequence in JS if it's ever unreachable/empty. Verified
// against tracking.crdbom_revision_code's seed data: A=1..H=8, J=10..N=14,
// P=16, R=18, T=20..W=23, Y=25, then two-letter AA=27.., skipping I/O/Q/S/X/Z
// at each letter position. In the fallback case there's no DB-level FK
// validating crd_code/current_crd_te — only this app-level check does.
const REVISION_LETTERS = ['A','B','C','D','E','F','G','H','J','K','L','M','N','P','R','T','U','V','W','Y'];
const letterPos = ch => ch.charCodeAt(0) - 64; // 'A'->1 ... 'Z'->26

function computeFallbackRevisionCodes() {
  const codes = REVISION_LETTERS.map(l => ({ code: l, seq: letterPos(l) }));
  for (const l1 of REVISION_LETTERS)
    for (const l2 of REVISION_LETTERS)
      codes.push({ code: l1 + l2, seq: 26 * letterPos(l1) + letterPos(l2) });
  return codes.sort((a, b) => a.seq - b.seq);
}

let revisionCodeCache = null; // resolved once per process lifetime
async function getRevisionCodes() {
  if (revisionCodeCache) return revisionCodeCache;
  try {
    const r = await annonPool.query('SELECT code, seq FROM tracking.crdbom_revision_code ORDER BY seq');
    if (r.rows.length > 0) {
      revisionCodeCache = { source: 'db', codes: r.rows };
      return revisionCodeCache;
    }
  } catch (err) {
    console.warn('tracking.crdbom_revision_code unusable, using computed fallback:', err.message);
  }
  revisionCodeCache = { source: 'computed', codes: computeFallbackRevisionCodes() };
  return revisionCodeCache;
}

app.get('/api/crd-tracker/revision-codes', async (req, res) => {
  try {
    res.json(await getRevisionCodes());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── CRD Tracker: in-memory "Test" rows (New SKU > Test) ────────────────────
// Never touch Postgres — same ephemeral-Map convention as automationJobs
// below. Keyed by a synthetic negative id so it can never collide with a
// real Postgres serial id when merged into GET /api/crd-tracker/lines.
const crdTestLines = new Map(); // testId (number) -> row shaped like a /lines row
let nextCrdTestLineId = 1;

// Shared validation for the New SKU form, used by both the real and test
// creation endpoints below.
function validateNewSkuBody(body) {
  const { no, l11Msf, l11Sku, l10Msf, l10Sku } = body;
  if (!Number.isInteger(no) || no <= 0) return 'No must be a positive integer.';
  if (!l11Msf?.trim() || !l11Sku?.trim() || !l10Msf?.trim() || !l10Sku?.trim())
    return 'L11 MSF, L11 SKU, L10 MSF, and L10 SKU are required.';
  return null;
}

// ── API: CRD Tracker — create a new tracked line + L10 component (real) ────
app.post('/api/crd-tracker/lines', async (req, res) => {
  const { no, gen, l11Msf, l11Sku, crdNumber, l10Msf, l10Sku, wtsTicket, wtsLink, latestCrd } = req.body;
  const validationError = validateNewSkuBody(req.body);
  if (validationError) return res.status(400).json({ error: validationError });

  let crdCode = null;
  if (latestCrd?.trim()) {
    crdCode = latestCrd.trim().toUpperCase();
    const { codes } = await getRevisionCodes();
    if (!codes.some(c => c.code === crdCode)) {
      return res.status(400).json({ error: `"${crdCode}" is not a recognized CRD revision code.` });
    }
  }

  const client = await annonWritePool.connect();
  try {
    await client.query('BEGIN');
    const lineResult = await client.query(
      `INSERT INTO tracking.crdbom_line (line_no, gen, l11_msf, l11_sku, crd_number, wts_ticket, wts_link)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [no, gen ?? null, l11Msf.trim(), l11Sku.trim(), crdNumber?.trim() || null, wtsTicket?.trim() || null, wtsLink?.trim() || null]
    );
    const lineId = lineResult.rows[0].id;
    const compResult = await client.query(
      `INSERT INTO tracking.crdbom_component (line_id, l10_msf, l10_sku, current_crd_te, date_update)
       VALUES ($1,$2,$3,$4, CURRENT_DATE) RETURNING id`,
      [lineId, l10Msf.trim(), l10Sku.trim(), crdCode]
    );
    await client.query('COMMIT');
    res.json({ ok: true, lineId, componentId: compResult.rows[0].id });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(409).json({ error: `Line No ${no} already exists.` });
    console.error(err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ── API: CRD Tracker — create a Test-only line (never touches Postgres) ────
app.post('/api/crd-tracker/test-lines', async (req, res) => {
  const { no, gen, l11Msf, l11Sku, crdNumber, l10Msf, l10Sku, wtsTicket, wtsLink, latestCrd } = req.body;
  const validationError = validateNewSkuBody(req.body);
  if (validationError) return res.status(400).json({ error: validationError });

  let crdCode = null;
  if (latestCrd?.trim()) {
    crdCode = latestCrd.trim().toUpperCase();
    const { codes } = await getRevisionCodes();
    if (!codes.some(c => c.code === crdCode)) {
      return res.status(400).json({ error: `"${crdCode}" is not a recognized CRD revision code.` });
    }
  }

  const testId = nextCrdTestLineId++;
  const syntheticId = -testId;
  const row = {
    lineId: syntheticId,
    componentId: syntheticId,
    testId,
    no,
    gen: gen ?? null,
    l11Msf: l11Msf.trim(),
    l11Sku: l11Sku.trim(),
    crdNumber: crdNumber?.trim() || null,
    l10Msf: l10Msf.trim(),
    l10Sku: l10Sku.trim(),
    wtsTicket: wtsTicket?.trim() || null,
    wtsLink: wtsLink?.trim() || null,
    currentCrdTe: crdCode,
    dateUpdate: new Date().toISOString().slice(0, 10),
    latestWeekLabel: null,
    latestCrdCode: null,
    latestIsoYear: null,
    latestWorkWeek: null,
    isTest: true,
    testHistory: [], // populated by WW Rev Update; local-only weekly history
  };
  crdTestLines.set(testId, row);
  res.json({ ok: true, testId });
});

// Reads the current ISO year/work-week from Postgres (matches EXTRACT() used
// elsewhere in this feature) — a plain SELECT, safe on the read-only pool.
// Shared by both the real and Test branches of WW Rev Update so "this week"
// always means the same thing regardless of which branch handles the write.
async function getCurrentIsoWeek() {
  const r = await annonPool.query(
    `SELECT EXTRACT(isoyear FROM CURRENT_DATE)::int AS iso_year,
            EXTRACT(week FROM CURRENT_DATE)::int AS work_week`
  );
  return r.rows[0];
}

// Monday of the current ISO week, for Test rows' local history (mirrors
// Postgres's date_trunc('week', CURRENT_DATE) used on the real write path).
function currentIsoWeekMonday() {
  const d = new Date();
  const day = d.getDay() || 7; // Sunday=0 -> 7
  d.setDate(d.getDate() - day + 1);
  return d.toISOString().slice(0, 10);
}

// ── API: CRD Tracker — record this week's CRD revision for an existing line ─
app.post('/api/crd-tracker/ww-rev-update', async (req, res) => {
  const { lineId, crdCode } = req.body;
  if (!Number.isInteger(lineId) || lineId === 0) {
    return res.status(400).json({ error: 'lineId must resolve to an existing line.' });
  }
  if (!crdCode?.trim()) return res.status(400).json({ error: 'crdCode is required.' });
  const code = crdCode.trim().toUpperCase();
  try {
    const { codes } = await getRevisionCodes();
    const match = codes.find(c => c.code === code);
    if (!match) return res.status(400).json({ error: `"${code}" is not a recognized CRD revision code.` });

    const { iso_year, work_week } = await getCurrentIsoWeek();
    const weekLabel = `WW${work_week}`;

    // Negative lineId = synthetic id for an in-memory Test line — updates
    // that row's local history only, never touches Postgres.
    if (lineId < 0) {
      const testId = -lineId;
      const row = crdTestLines.get(testId);
      if (!row) return res.status(404).json({ error: `Test line ${testId} not found.` });
      row.latestWeekLabel = weekLabel;
      row.latestCrdCode = code;
      row.latestIsoYear = iso_year;
      row.latestWorkWeek = work_week;
      const entry = { weekLabel, isoYear: iso_year, workWeek: work_week, weekStartDate: currentIsoWeekMonday(), crdCode: code };
      const existingIdx = row.testHistory.findIndex(h => h.isoYear === iso_year && h.workWeek === work_week);
      if (existingIdx >= 0) row.testHistory[existingIdx] = entry;
      else row.testHistory.push(entry);
      return res.json({ ok: true, weekStatus: { week_label: weekLabel, crd_code: code } });
    }

    const upsert = await annonWritePool.query(
      `INSERT INTO tracking.crdbom_week_status
         (line_id, iso_year, work_week, week_label, week_start_date, crd_code, crd_seq)
       VALUES ($1, $2, $3, $4, (date_trunc('week', CURRENT_DATE))::date, $5, $6)
       ON CONFLICT (line_id, iso_year, work_week)
       DO UPDATE SET crd_code = EXCLUDED.crd_code, crd_seq = EXCLUDED.crd_seq
       RETURNING id, week_label, crd_code`,
      [lineId, iso_year, work_week, weekLabel, code, match.seq]
    );
    res.json({ ok: true, weekStatus: upsert.rows[0] });
  } catch (err) {
    if (err.code === '23503') return res.status(404).json({ error: `Line ${lineId} not found.` });
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── API: CRD Tracker — delete a whole tracked line (cascades) ──────────────
app.delete('/api/crd-tracker/lines/:lineId', async (req, res) => {
  const lineId = Number(req.params.lineId);
  if (!Number.isInteger(lineId) || lineId <= 0) {
    return res.status(400).json({ error: 'lineId must be a positive integer.' });
  }
  if (req.query.confirm !== 'true') {
    return res.status(400).json({ error: 'Delete requires confirm=true.' });
  }
  const client = await annonWritePool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM tracking.crdbom_week_status WHERE line_id = $1', [lineId]);
    await client.query('DELETE FROM tracking.crdbom_component WHERE line_id = $1', [lineId]);
    const result = await client.query('DELETE FROM tracking.crdbom_line WHERE id = $1 RETURNING id', [lineId]);
    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: `Line ${lineId} not found.` });
    }
    await client.query('COMMIT');
    res.json({ ok: true, deleted: { type: 'line', id: lineId } });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ── API: CRD Tracker — delete a single L10 component row ───────────────────
app.delete('/api/crd-tracker/components/:componentId', async (req, res) => {
  const componentId = Number(req.params.componentId);
  if (!Number.isInteger(componentId) || componentId <= 0) {
    return res.status(400).json({ error: 'componentId must be a positive integer.' });
  }
  if (req.query.confirm !== 'true') {
    return res.status(400).json({ error: 'Delete requires confirm=true.' });
  }
  try {
    const result = await annonWritePool.query('DELETE FROM tracking.crdbom_component WHERE id = $1 RETURNING id', [componentId]);
    if (result.rows.length === 0) return res.status(404).json({ error: `Component ${componentId} not found.` });
    res.json({ ok: true, deleted: { type: 'component', id: componentId } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── API: CRD Tracker — delete a Test-only line (never touched Postgres) ────
app.delete('/api/crd-tracker/test-lines/:testId', (req, res) => {
  const testId = Number(req.params.testId);
  if (!crdTestLines.has(testId)) return res.status(404).json({ error: 'Unknown test row.' });
  crdTestLines.delete(testId);
  res.json({ ok: true, deleted: { type: 'test', id: testId } });
});

// ── API: QVL part list for an arbitrary Model Reference ────────────────────
app.post('/api/qvl-list', async (req, res) => {
  const { modelRef, location } = req.body;
  if (!modelRef?.trim() || !location?.trim()) {
    return res.status(400).json({ error: 'modelRef and location are required.' });
  }
  try {
    const qvlRows = await fetchQvlList(modelRef.trim(), location.trim());
    res.json({
      qvlList: qvlRows.map(r => ({ partNumber: r.PartNumber, description: r.Description }))
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── API: read-only part detail (Location / CRD Cfg / FRU Spec / Rack SKU) ──
//
// Reproduces what MonicaTPGenerator.exe's Test BOM tab shows, for laptops
// where TPG itself can't reach SQL (Windows-auth domain trust failure — see
// tools/monica-access/README.md's "Second blocker" section). Reads the exact
// same tables via this app's already-authorized SQL-auth connection.
app.post('/api/part-detail', async (req, res) => {
  const { partNumber } = req.body;
  if (!partNumber?.trim()) {
    return res.status(400).json({ error: 'Part number is required.' });
  }

  const pn = partNumber.trim();

  try {
    const bomResult = await query(
      'SELECT * FROM bom.dbo.SysBom WHERE ParentPartNumber = @pn',
      [{ name: 'pn', type: sql.NVarChar, value: pn }]
    );
    const bomRows = bomResult.recordset;

    // Descriptions live in a separate table, keyed by ChildPartNumber (not a
    // column on SysBom itself) — batch-fetch the distinct set in one query
    // rather than one round-trip per row (TPG's own Test BOM grid shows this
    // per-row, e.g. "NO_DEVICE" -> "NO DEVICE WAS INSTALLED").
    const childPNs = [...new Set(bomRows.map(r => (r.ChildPartNumber || '').trim()).filter(Boolean))];
    const descMap = new Map();
    if (childPNs.length) {
      const params = childPNs.map((v, i) => ({ name: `pn${i}`, type: sql.NVarChar, value: v }));
      const placeholders = params.map(p => `@${p.name}`).join(', ');
      const descResult = await query(
        `SELECT PartNumber, Description FROM bom.dbo.PartDescription WHERE PartNumber IN (${placeholders})`,
        params
      );
      descResult.recordset.forEach(r => descMap.set(r.PartNumber, r.Description));
    }
    // ParentPartNumber is dropped here — it's always just the requested part
    // number, redundant on every single row of this view.
    const locationRows = bomRows.map(r => ({
      Location: r.Location,
      Type: r.Type,
      Quantity: r.Quantity,
      Level: r.Level,
      ChildPartNumber: r.ChildPartNumber,
      ChildRevision: r.ChildRevision,
      Remark: r.Remark,
      Description: descMap.get((r.ChildPartNumber || '').trim()) || null
    }));

    const crdRefRow = findCrdRefRow(bomRows);
    const crdPN = crdRefRow ? (crdRefRow.ChildPartNumber || '').trim() : null;

    let crd = { specNumber: crdPN, found: false, rows: [] };
    let fru = { specNumber: crdPN, found: false, rows: [] };

    if (crdPN) {
      const [crdResult, fruResult] = await Promise.all([
        query(
          'SELECT * FROM MSFT_SKU.dbo.CRDspec WHERE SpecNumber = @crdpn ORDER BY Line',
          [{ name: 'crdpn', type: sql.NVarChar, value: crdPN }]
        ),
        query(
          'SELECT * FROM MSFT_SKU.dbo.FRUspec WHERE SpecNumber = @crdpn ORDER BY Line',
          [{ name: 'crdpn', type: sql.NVarChar, value: crdPN }]
        )
      ]);
      crd = { specNumber: crdPN, found: crdResult.recordset.length > 0, rows: crdResult.recordset };
      fru = { specNumber: crdPN, found: fruResult.recordset.length > 0, rows: fruResult.recordset };
    }

    const itemNumber = pn.split('$')[0];
    const skuResult = await query(
      'SELECT TOP 1 * FROM MSFT_SKU.dbo.PartProperties WHERE ItemNumber = @itemNumber',
      [{ name: 'itemNumber', type: sql.NVarChar, value: itemNumber }]
    );

    res.json({
      partNumber: pn,
      location: { rows: locationRows },
      crd,
      fru,
      rackSku: {
        itemNumber,
        found: skuResult.recordset.length > 0,
        row: skuResult.recordset[0] || null
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── Automation: QVL autofill agent ───────────────────────────────────────────
//
// MonicaTPGenerator.exe only runs interactively (no API of its own), so the
// on-host agent (monica-automation/agent/qvl_autofill_agent.py) polls out for
// work instead of being called directly. 2026-07-14: this round runs the
// agent on the same laptop as this server — see monica-automation/config/
// settings.toml and monica-automation/PHASE_QVL_DISCOVERY_FINDINGS.md.
// Porting to a dedicated RDP-only host (no SSH/WinRM inbound path — see
// monica-automation/PHASE0_FINDINGS.md) is a separate later rollout step.
// This queue only ever asks the agent to *fill* fields (QVL tab, or the Test
// BOM tab via its own Save/Load CSV round-trip) for a human to review — it
// never submits (never clicks ADD/MODIFY or Submit), matching the write-gate
// discipline in monica-automation/CONTEXT.md. Two job types share this one
// queue and lifecycle (pending -> in_progress -> filled | error) since both
// carry the identical trust boundary — a second queue would just duplicate
// this file for no isolation benefit:
//   'qvl_autofill'      — fills Model Reference/Location/PN/Description.
//   'test_bom_autofill' — generates a CSV (monica/bom_builder.py) and Loads
//                         it into the Test BOM tab's grid.
const automationJobs = new Map(); // jobId -> job record
let nextAutomationJobId = 1;

function requireAgentToken(req, res, next) {
  const expected = process.env.AUTOMATION_AGENT_TOKEN;
  if (!expected) {
    return res.status(503).json({ error: 'AUTOMATION_AGENT_TOKEN is not configured on the server.' });
  }
  if (req.get('Authorization') !== `Bearer ${expected}`) {
    return res.status(401).json({ error: 'Unauthorized.' });
  }
  next();
}

// ── API: enqueue an automation job (called from the frontend) ──────────────
app.post('/api/automation/jobs', (req, res) => {
  const { jobType, moCategory, partNumber, description } = req.body;
  const type = jobType || 'qvl_autofill'; // default keeps existing QVL callers unchanged
  if (type !== 'qvl_autofill' && type !== 'test_bom_autofill') {
    return res.status(400).json({ error: `Unknown jobType "${type}".` });
  }

  const target = MO_CATEGORY_TO_QVL[moCategory];
  if (!target) {
    return res.status(400).json({ error: `Unknown MO Category "${moCategory}".` });
  }
  if (!partNumber?.trim()) {
    return res.status(400).json({ error: 'Part number is required.' });
  }

  const jobId = String(nextAutomationJobId++);
  const job = {
    jobId,
    jobType: type,
    modelRef: target.modelRef,
    partNumber: partNumber.trim(),
    status: 'pending', // pending -> in_progress -> filled | error
    createdAt: new Date().toISOString(),
    result: null,
  };
  if (type === 'qvl_autofill') {
    // Test BOM jobs cover every location for the model/PN (resolved by
    // bom_builder.py from live DB data) — 'location' and 'description' are
    // QVL-tab-specific fields, not applicable here.
    job.location = target.location;
    job.description = description || null;
  }
  automationJobs.set(jobId, job);

  res.json({ jobId });
});

// ── API: the on-host agent polls this for the next pending job ─────────────
// Must be registered before the generic '/:id' route below, or Express would
// match the literal segment "next" as an :id value instead.
app.get('/api/automation/jobs/next', requireAgentToken, (req, res) => {
  const job = [...automationJobs.values()].find(j => j.status === 'pending');
  if (!job) return res.status(204).end();
  job.status = 'in_progress';
  res.json(job);
});

// ── API: frontend polls this for job status ─────────────────────────────────
app.get('/api/automation/jobs/:id', (req, res) => {
  const job = automationJobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Unknown job id.' });
  res.json(job);
});

// ── API: the on-host agent reports back the outcome of a job ───────────────
app.post('/api/automation/jobs/:id/result', requireAgentToken, (req, res) => {
  const job = automationJobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Unknown job id.' });
  const { status, detail } = req.body;
  job.status = status === 'error' ? 'error' : 'filled';
  job.result = detail || null;
  res.json({ ok: true });
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
    } else if (isRackTORSwitchSlot(loc)) {
      // DATA_SW / BCK_SW — CRD golden reference is prefixed with the OS/family name
      // (e.g. "SONiC.20250510.16"); BOM ChildRevision stores only the build number.
      const v = extractRackSwitchOSVersion(crdRow.Version);
      if (v) { crdVer = v; crdVersionSource = 'Version (OS build)'; }
      const rev = (bomRow.ChildRevision || '').trim();
      if (rev && rev !== '*') bomVer = rev;
    } else if (isRackMgmtSwitchSlot(loc) || isRackManagerSlot(loc)) {
      // MGMT_SW / RM — CRD Version is the golden reference as-is, no extraction needed.
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

  // ── Rack: TOR Switch OS (DATA_SW / BCK_SW) ─────────────────────────────────
  // CRD row: Group ⊃ "Rack", Item ⊃ "TOR Switch".
  // Both physical ToR switches (data + backup) share the one CRD entry → shared: true.
  if (isRackTORSwitchSlot(loc)) {
    for (let idx = 0; idx < crdRows.length; idx++) {
      const group = (crdRows[idx].Group || '').trim();
      const item  = (crdRows[idx].Item  || '').trim();
      if (/rack/i.test(group) && /tor\s*switch/i.test(item)) {
        return { row: crdRows[idx], index: idx, locationScore: 100, shared: true };
      }
    }
    return null;
  }

  // ── Rack: Management switch (MGMT_SW / MGMT_SW_N) ──────────────────────────
  // CRD row: Group ⊃ "Rack", Item ⊃ "Management switch".
  if (isRackMgmtSwitchSlot(loc)) {
    for (let idx = 0; idx < crdRows.length; idx++) {
      const group = (crdRows[idx].Group || '').trim();
      const item  = (crdRows[idx].Item  || '').trim();
      if (/rack/i.test(group) && /management\s*switch/i.test(item)) {
        return { row: crdRows[idx], index: idx, locationScore: 100, shared: true };
      }
    }
    return null;
  }

  // ── Rack: Rack Manager (RM / RM_N) ──────────────────────────────────────────
  // CRD row: Group ⊃ "Rack", Item ⊃ "Rack Manager".
  if (isRackManagerSlot(loc)) {
    for (let idx = 0; idx < crdRows.length; idx++) {
      const group = (crdRows[idx].Group || '').trim();
      const item  = (crdRows[idx].Item  || '').trim();
      if (/rack/i.test(group) && /rack\s*manager/i.test(item)) {
        return { row: crdRows[idx], index: idx, locationScore: 100, shared: true };
      }
    }
    return null;
  }

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
    if (isRackCRDRow(crdRow)) return; // never match routed Rack CRD rows via location/version similarity

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

// Returns true for CRD rows that belong to a routed Rack family (TOR Switch, Management
// switch, Rack Manager). These rows are handled exclusively by their dedicated paths in
// findBestCRDMatch and must never be matched via the general location/version similarity path.
function isRackCRDRow(crdRow) {
  const group = (crdRow.Group || '').trim();
  const item  = (crdRow.Item  || '').trim();
  if (!/rack/i.test(group)) return false;
  return /tor\s*switch/i.test(item) || /management\s*switch/i.test(item) || /rack\s*manager/i.test(item);
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

// ── Rack-level location helpers ────────────────────────────────────────────
// Rack CRD rows are grouped under Group ⊃ "Rack", identified purely by BOM Location —
// no model names needed, same convention as the firmware slot helpers above.
function isRackTORSwitchSlot(loc)  { return /^(DATA_SW|BCK_SW)$/i.test((loc || '').trim()); }
function isRackMgmtSwitchSlot(loc) { return /^MGMT_SW(_\d+)?$/i.test((loc || '').trim()); }
function isRackManagerSlot(loc)    { return /^RM(_\d+)?$/i.test((loc || '').trim()); }

// TOR Switch OS golden reference is prefixed with the OS/family name in CRD Version
// (e.g. "SONiC.20250510.16"); BOM ChildRevision stores only the build number ("20250510.16").
// Strips a single leading alpha token + dot; returns the raw value unchanged if no such prefix.
function extractRackSwitchOSVersion(version) {
  const v = (version || '').trim();
  const m = v.match(/^[A-Za-z]+\.(.+)$/);
  return m ? m[1].trim() : v;
}

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

// True when a string is purely digits with only '.', '-', '_' as separators (no letters) —
// the shape numeric byte-pair equivalence (below) is safe to apply to.
function isPureNumericVersion(v) {
  return /^[0-9]+(?:[.\-_][0-9]+)*$/.test((v || '').trim());
}

// Numeric byte-pair equivalence for purely-numeric version strings whose format (grouping,
// zero-padding, separators) differs but whose underlying numeric value is the same.
// Digits are read in pairs left-to-right (hardware version bytes are conventionally 2 digits
// each), then trailing zero bytes are dropped so an extra zero-padded byte on one side doesn't
// block the match.
//   CPLD golden "030400" → bytes [3,4,0] → trailing zero dropped → [3,4]
//   CPLD BOM    "0304"   → bytes [3,4]                            → [3,4]  → equal
function normNumericBytes(v) {
  const digits = (v || '').replace(/\D/g, '');
  if (!digits) return null;
  const bytes = [];
  for (let i = 0; i < digits.length; i += 2) {
    bytes.push(parseInt(digits.slice(i, i + 2).padEnd(2, '0'), 10));
  }
  while (bytes.length > 1 && bytes[bytes.length - 1] === 0) bytes.pop();
  return bytes.join('.');
}

// Score how well a single BOM candidate matches the CRD golden reference (0-100).
// Tries exact → BC-normalised → normalised-string → numeric byte-pair → fuzzy, in that order.
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

  // Numeric byte-pair equivalence — catches formats like CPLD "0304" vs golden "030400"
  // that the exact/BC/normVer checks above don't reduce to the same string.
  if (isPureNumericVersion(v) && isPureNumericVersion(crdVersion) &&
      normNumericBytes(v) === normNumericBytes(crdVersion)) {
    return 100;
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
