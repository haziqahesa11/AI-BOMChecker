const { sql, query } = require('../DB');

// Read-only: SP_LocationTable_Model_Distinct → [{ModelRef, Level}].
// Extracted from GET /api/models — also the source list the Golden Template
// catalog crawl iterates over.
async function fetchAllModels() {
  const result = await query('EXEC BOM.dbo.SP_LocationTable_Model_Distinct');
  return result.recordset.map(r => ({ modelRef: r.ModelRef, location: r.Level }));
}

// Read-only: SP_QVL_Query_DESC(ModelRef, Location) → [{ModelRef, Location, PartNumber, Description}].
// Shared by /api/mo-lookup (fixed L10/L11 models), /api/qvl-list (any model
// from /api/models), and the Golden Template catalog crawl (every model).
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

module.exports = { fetchAllModels, fetchQvlList };
