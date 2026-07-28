const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

// Same cap as wtsService — BOM Report sheets can run 30k+ rows.
const MAX_SHEET_ROWS = 5000;

function getNpiDataDir() {
  const dir = (process.env.NPI_DATA_DIR || '').trim();
  return dir || null;
}

function getMsfRoot() {
  const dataDir = getNpiDataDir();
  return dataDir ? path.join(dataDir, 'MSF') : null;
}

function getIndexPath() {
  const msfRoot = getMsfRoot();
  return msfRoot ? path.join(msfRoot, 'NpiLibrary', 'index.json') : null;
}

// Reads MSF/NpiLibrary/index.json, written by build-npi-index.js. Mirrors
// wtsService.loadIndex()'s three-state distinction: dir not configured / dir
// configured but indexer hasn't run yet / has data.
function loadIndex() {
  const dataDir = getNpiDataDir();
  if (!dataDir) {
    return { dataDirConfigured: false, indexExists: false, generatedAt: null, warnings: [], skus: [], crossTables: [] };
  }
  const indexPath = getIndexPath();
  if (!fs.existsSync(indexPath)) {
    return { dataDirConfigured: true, indexExists: false, generatedAt: null, warnings: [], skus: [], crossTables: [] };
  }
  const raw = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  return {
    dataDirConfigured: true,
    indexExists: true,
    generatedAt: raw.generatedAt || null,
    warnings: raw.warnings || [],
    skus: raw.skus || [],
    crossTables: raw.crossTables || [],
  };
}

// relPath is always server-generated (written by build-npi-index.js into
// index.json, never client-supplied), so this join is safe by construction —
// the containment check is defense-in-depth in case index.json is ever hand-edited.
function resolveRelPath(relPath) {
  const msfRoot = getMsfRoot();
  if (!msfRoot) {
    throw Object.assign(new Error('NPI_DATA_DIR is not configured.'), { status: 400 });
  }
  const rootResolved = path.resolve(msfRoot);
  const absPath = path.resolve(msfRoot, relPath);
  if (absPath !== rootResolved && !absPath.startsWith(rootResolved + path.sep)) {
    throw Object.assign(new Error('Invalid file path.'), { status: 400 });
  }
  if (!fs.existsSync(absPath)) {
    throw Object.assign(new Error(`File not found: ${relPath}`), { status: 404 });
  }
  return absPath;
}

// Looked up by itemNumber+revision (not bare fileName) because two order
// folders can hold same-named files at different physical paths — see plan.
function resolveSkuFile(itemNumber, revision) {
  const { skus } = loadIndex();
  const rec = skus.find(s => s.itemNumber === itemNumber && s.revision === revision);
  if (!rec) {
    throw Object.assign(new Error(`SKU not found: ${itemNumber} Rev ${revision}`), { status: 404 });
  }
  return resolveRelPath(rec.relPath);
}

function resolveCrossTableFile(gen, fileName) {
  const { crossTables } = loadIndex();
  const rec = crossTables.find(c => String(c.gen) === String(gen) && c.fileName === fileName);
  if (!rec) {
    throw Object.assign(new Error(`Cross table file not found: Gen ${gen} / ${fileName}`), { status: 404 });
  }
  return resolveRelPath(rec.relPath);
}

function assertXlsx(absPath) {
  if (!absPath.toLowerCase().endsWith('.xlsx')) {
    throw Object.assign(new Error('Only .xlsx files have sheets.'), { status: 400 });
  }
}

function listSheetNames(absPath) {
  assertXlsx(absPath);
  const wb = XLSX.readFile(absPath);
  return wb.SheetNames;
}

function readSheet(absPath, sheetName) {
  assertXlsx(absPath);
  const wb = XLSX.readFile(absPath);
  const ws = wb.Sheets[sheetName];
  if (!ws) {
    throw Object.assign(new Error(`Sheet not found: ${sheetName}`), { status: 400 });
  }
  const allRows = XLSX.utils.sheet_to_json(ws, { defval: '', raw: false });
  const truncated = allRows.length > MAX_SHEET_ROWS;
  const rows = truncated ? allRows.slice(0, MAX_SHEET_ROWS) : allRows;
  const columns = allRows.length > 0
    ? Object.keys(allRows[0])
    : (XLSX.utils.sheet_to_json(ws, { header: 1 })[0] || []).map(String);
  return { columns, rows, rowCount: allRows.length, colCount: columns.length, truncated };
}

module.exports = {
  getNpiDataDir,
  getMsfRoot,
  getIndexPath,
  loadIndex,
  resolveSkuFile,
  resolveCrossTableFile,
  listSheetNames,
  readSheet,
};
