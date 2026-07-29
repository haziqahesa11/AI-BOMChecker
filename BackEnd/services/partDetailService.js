const { sql, query } = require('../DB');

// Pattern for CRD spec part numbers: e.g. M1389927-001
const CRD_PN_PATTERN = /^[A-Z]\d{7}-\d{3}$/;

// Identify the CRD reference row inside a SysBom row set.
//   Criteria: ChildPartNumber matches M1234567-001 pattern, or Location/Type = 'CRD'
// Shared by /api/compare and buildPartDetail (used by /api/part-detail and the
// Golden Template feature) — all three derive the same CRDspec/FRUspec lookup
// key (SpecNumber) from this one row.
function findCrdRefRow(bomRows) {
  return bomRows.find(r =>
    CRD_PN_PATTERN.test((r.ChildPartNumber || '').trim()) ||
    (r.Location || '').toUpperCase() === 'CRD' ||
    (r.Type || '').toUpperCase() === 'CRD'
  );
}

// Read-only part detail (Location / CRD Cfg / FRU Spec / Rack SKU).
//
// Reproduces what MonicaTPGenerator.exe's Test BOM tab shows, for laptops
// where TPG itself can't reach SQL (Windows-auth domain trust failure — see
// tools/monica-access/README.md's "Second blocker" section). Reads the exact
// same tables via this app's already-authorized SQL-auth connection.
//
// Shared by POST /api/part-detail and the Golden Template feature's
// resolveCpnDetail (which calls this once for the bare CPN, and again for a
// fallback variant if the bare CPN has no SysBom rows).
async function buildPartDetail(pn) {
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

  return {
    partNumber: pn,
    location: { rows: locationRows },
    crd,
    fru,
    rackSku: {
      itemNumber,
      found: skuResult.recordset.length > 0,
      row: skuResult.recordset[0] || null
    }
  };
}

module.exports = { CRD_PN_PATTERN, findCrdRefRow, buildPartDetail };
