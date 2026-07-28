const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

// BOM sheet sizes vary widely and aren't known upfront — cap what's sent to
// the browser so one huge attachment can't stall the viewer; the response
// flags `truncated` so the UI can say so.
const MAX_SHEET_ROWS = 5000;

function getWtsDataDir() {
  const dir = (process.env.WTS_DATA_DIR || '').trim();
  return dir || null;
}

function getWtsFilesDir() {
  const dataDir = getWtsDataDir();
  return dataDir ? path.join(dataDir, 'WTS') : null;
}

function getIndexPath() {
  const filesDir = getWtsFilesDir();
  return filesDir ? path.join(filesDir, 'index.json') : null;
}

// file_path is written by wts_fetch.py wherever it's run (typically a
// Windows machine, since fetching stays local while this app serves from
// Linux) -- path.basename() alone is platform-specific and won't split a
// backslash path on a POSIX runtime, so strip on either separator explicitly.
function basenameAnyOs(p) {
  return p.split(/[\\/]/).pop();
}

// Reshapes one raw WTS/index.json record (snake_case, written by wts_fetch.py)
// into the camelCase shape the frontend consumes. file_path (a fetch-machine-
// local absolute path) is deliberately dropped — only fileName (its basename)
// is exposed, so the client can never see or submit an absolute path.
function toClientItem(raw) {
  const fileName = raw.file_path ? basenameAnyOs(raw.file_path) : (raw.attachment_name || null);
  return {
    workItemId: raw.work_item_id,
    project: raw.project,
    projectCode: raw.project_code,
    model: raw.model,
    title: raw.title,
    state: raw.state,
    keyword: raw.keyword,
    sequence: raw.sequence,
    revision: raw.revision,
    changedDate: raw.changed_date,
    attachmentName: raw.attachment_name,
    attachmentModified: raw.attachment_modified,
    fileName,
    fileType: raw.file_type,
    downloadedAt: raw.downloaded_at,
  };
}

// Reads <WTS_DATA_DIR>/WTS/index.json. "No data yet" is a legitimate state,
// not an error — dataDirConfigured/indexExists let the caller tell apart
// "WTS_DATA_DIR isn't set" from "it's set but wts_fetch.py hasn't run yet".
// A malformed index.json (JSON.parse failure) is left to throw — that's a
// genuine 500, not an empty state.
function loadIndex() {
  const dataDir = getWtsDataDir();
  if (!dataDir) {
    return { dataDirConfigured: false, indexExists: false, lastFetchedAt: null, items: [] };
  }
  const indexPath = getIndexPath();
  if (!fs.existsSync(indexPath)) {
    return { dataDirConfigured: true, indexExists: false, lastFetchedAt: null, items: [] };
  }
  const rawItems = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  const items = rawItems.map(toClientItem);
  const lastFetchedAt = items.reduce(
    (max, it) => (it.downloadedAt && (!max || it.downloadedAt > max)) ? it.downloadedAt : max,
    null
  );
  return { dataDirConfigured: true, indexExists: true, lastFetchedAt, items };
}

// Validates a client-supplied fileName stays a bare basename inside
// WTS_DATA_DIR/WTS (path-traversal guard) and exists on disk. Throws an
// Error with a `status` property for the route handler to translate into
// a response — the client only ever gets/sends a basename, never a path.
function resolveWtsFile(fileName) {
  const filesDir = getWtsFilesDir();
  if (!filesDir) {
    throw Object.assign(new Error('WTS_DATA_DIR is not configured.'), { status: 400 });
  }
  if (!fileName || path.basename(fileName) !== fileName) {
    throw Object.assign(new Error('Invalid file name.'), { status: 400 });
  }
  const rootResolved = path.resolve(filesDir);
  const absPath = path.resolve(filesDir, fileName);
  if (absPath !== rootResolved && !absPath.startsWith(rootResolved + path.sep)) {
    throw Object.assign(new Error('Invalid file name.'), { status: 400 });
  }
  if (!fs.existsSync(absPath)) {
    throw Object.assign(new Error(`File not found: ${fileName}`), { status: 404 });
  }
  return absPath;
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

module.exports = { getWtsDataDir, getWtsFilesDir, loadIndex, resolveWtsFile, listSheetNames, readSheet };
