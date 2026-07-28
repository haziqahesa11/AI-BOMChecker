// Standalone indexer for the NPI Library feature — run manually with
// `node BackEnd/scripts/build-npi-index.js` whenever NPI Files/MSF changes.
// Walks <NPI_DATA_DIR>/MSF/Gen {8,9,10,11}/{Cross table|Documents} and writes
// MSF/NpiLibrary/index.json, which BackEnd/services/npiLibraryService.js and
// the NPI Library page read at request time. Never triggered automatically —
// same "external, on-demand build step" pattern as HQ Fetching/wts_dashboard/wts_fetch.py.

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

require('dotenv').config({ path: path.join(__dirname, '..', '..', 'config', 'credentials', 'npi.env') });

const NPI_DATA_DIR = (process.env.NPI_DATA_DIR || '').trim();
if (!NPI_DATA_DIR) {
  console.error('NPI_DATA_DIR is not set (config/credentials/npi.env). Copy npi.env.example and fill it in.');
  process.exit(1);
}
const MSF_ROOT = path.join(NPI_DATA_DIR, 'MSF');
const INDEX_DIR = path.join(MSF_ROOT, 'NpiLibrary');
const INDEX_PATH = path.join(INDEX_DIR, 'index.json');

const BUILD_PHASES = ['DPLY', 'PILOT', 'GROWTH', 'EOP', 'MP'];
// Prefer a fully-descriptive master filename over a terse alias (e.g.
// "id33380.M1203008-001_RASSY-...xlsx" with no _RevX) when the same
// itemNumber+revision shows up under two different filenames.
const DESCRIPTIVE_NAME_RE = /^M\d{7}-\d{3}_.+_Rev[A-Za-z0-9]+/i;

const warnings = [];
function warn(msg) {
  warnings.push(msg);
  console.warn('WARN:', msg);
}

function relPath(absPath) {
  return path.relative(MSF_ROOT, absPath).split(path.sep).join('/');
}

function findChildDir(parentAbs, pattern) {
  const hit = fs.readdirSync(parentAbs, { withFileTypes: true })
    .find(d => d.isDirectory() && pattern.test(d.name));
  return hit ? path.join(parentAbs, hit.name) : null;
}

function getGenDirs() {
  return fs.readdirSync(MSF_ROOT, { withFileTypes: true })
    .filter(d => d.isDirectory() && /^Gen\s*(8|9|10|11)$/i.test(d.name))
    .map(d => ({ abs: path.join(MSF_ROOT, d.name), genNumber: Number(d.name.match(/\d+/)[0]) }))
    .sort((a, b) => a.genNumber - b.genNumber);
}

// Recursively collects every .xlsx under dirAbs (order-folders can nest more
// than one level deep — confirmed real examples in Gen 8/9). Skips Excel
// lock files ("~$...").
function walkXlsxFiles(dirAbs, out = []) {
  for (const entry of fs.readdirSync(dirAbs, { withFileTypes: true })) {
    const abs = path.join(dirAbs, entry.name);
    if (entry.isDirectory()) {
      walkXlsxFiles(abs, out);
    } else if (entry.isFile() && /\.xlsx$/i.test(entry.name) && !entry.name.startsWith('~$')) {
      out.push(abs);
    }
  }
  return out;
}

function parseOrderFolderName(name) {
  const msf = name.match(/MSF-(\d{6})/);
  const dw = name.match(/_DW\s*\(\s*MSF-(\d{6})\s*\)/i);
  return {
    folderName: name,
    msfNumber: msf ? `MSF-${msf[1]}` : null,
    isDw: !!dw,
    dwOfMsfNumber: dw ? `MSF-${dw[1]}` : null,
  };
}

// Cheap classification: only reads the workbook's sheet-name list, not cell
// data. A real SKU BOM master always has both of these sheets; every cable
// labeling/SOP/CRD/SPEC ancillary workbook sampled has neither.
function getSheetNamesCheap(absPath) {
  const wb = XLSX.readFile(absPath, { bookSheets: true });
  return wb.SheetNames;
}

function isSkuBomMaster(sheetNames) {
  return sheetNames.includes('Part Properties') && sheetNames.includes('Bom Report');
}

// Generic Name/Value scan of the "Part Properties" sheet — immune to the
// row-count/field-set drift between Gen 8 and Gen 9-11 (missing keys just
// come back undefined, no Gen-conditional branching needed).
function parsePartPropertiesFlat(ws) {
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
  const flat = {};
  for (const r of rows) {
    const name = String(r[0] || '').trim();
    const value = String(r[1] ?? '').trim();
    if (!name) continue;
    if (name === 'Part Report' || name === 'Part Characteristics') continue;
    if (name === 'Name' && value === 'Value') continue;
    flat[name] = value;
  }
  return flat;
}

function countBomRows(ws) {
  if (!ws || !ws['!ref']) return null;
  // Header row is row 5 (0-based index 4), data starts row 6 (index 5).
  const range = XLSX.utils.decode_range(ws['!ref']);
  return Math.max(0, range.e.r - 4);
}

function parseBuildPhase(partDescription) {
  const m = String(partDescription || '').match(/^E?RASSY-([A-Z]+)-/);
  return (m && BUILD_PHASES.includes(m[1])) ? m[1] : null;
}

function parseSkuMaster(absPath, genNumber) {
  const wb = XLSX.readFile(absPath);
  const stat = fs.statSync(absPath);
  const flat = parsePartPropertiesFlat(wb.Sheets['Part Properties']);
  const itemNumber = flat['Item Number'];
  const revision = flat['Part Revision'];
  if (!itemNumber || !revision) {
    warn(`${relPath(absPath)}: missing Item Number/Part Revision in Part Properties, skipped.`);
    return null;
  }
  const genRaw = flat['Generation'] || null;
  const partDescription = flat['Part Description'] || '';
  return {
    itemNumber,
    revision,
    gen: genNumber,
    genRaw,
    partDescription,
    partClassPath: flat['Part Class Path'] || null,
    partMaturityLevel: flat['Part Maturity Level'] || null,
    buildPhase: parseBuildPhase(partDescription),
    businessGroup: flat['Business Group'] || null,
    role: flat['Role'] || null,
    subrole: flat['Subrole'] || null,
    processorType: flat['Processor Type'] || null,
    tier: flat['Tier'] || null,
    rackHeightU: flat['Rack Height (U)'] || null,
    rackSpaceUsed: flat['Rack Space Used'] || null,
    pduAmperage: flat['PDU Amperage'] || null,
    serverCount: flat['Server Count'] || null,
    systemIntegrator: flat['System Integrator'] || null,
    tamQuarter: flat['TAM Quarter'] || null,
    supportedTamQuarters: flat['Supported TAM Quarters'] || null,
    rackType: flat['Rack Type'] || null,
    deploymentType: flat['Deployment Type'] || null,
    dimensionGroup: flat['Dimension Group'] || null,
    bomRowCount: countBomRows(wb.Sheets['Bom Report']),
    partProperties: flat,
    relPath: relPath(absPath),
    fileName: path.basename(absPath),
    sizeBytes: stat.size,
    modifiedAt: stat.mtime.toISOString(),
  };
}

function indexGen({ abs: genAbs, genNumber }) {
  const skusByKey = new Map();     // "itemNumber::revision" -> sku record
  const ancillaryByFolder = new Map(); // orderFolderName -> [{fileName, relPath}]
  const crossTables = [];

  const docsDir = findChildDir(genAbs, /^documents?$/i);
  if (docsDir) {
    const files = walkXlsxFiles(docsDir);
    for (const absPath of files) {
      let sheetNames;
      try {
        sheetNames = getSheetNamesCheap(absPath);
      } catch (e) {
        warn(`${relPath(absPath)}: failed to open (${e.message}), skipped.`);
        continue;
      }
      const orderFolderName = path.basename(path.dirname(absPath));
      const orderInfo = parseOrderFolderName(orderFolderName);

      if (!isSkuBomMaster(sheetNames)) {
        if (!ancillaryByFolder.has(orderFolderName)) ancillaryByFolder.set(orderFolderName, []);
        ancillaryByFolder.get(orderFolderName).push({ fileName: path.basename(absPath), relPath: relPath(absPath) });
        continue;
      }

      let sku;
      try {
        sku = parseSkuMaster(absPath, genNumber);
      } catch (e) {
        warn(`${relPath(absPath)}: failed to parse Part Properties (${e.message}), skipped.`);
        continue;
      }
      if (!sku) continue;

      const key = `${sku.itemNumber}::${sku.revision}`;
      const existing = skusByKey.get(key);
      if (!existing) {
        sku.orders = [orderInfo];
        sku.ancillaryFiles = [];
        skusByKey.set(key, sku);
      } else {
        if (!existing.orders.some(o => o.folderName === orderInfo.folderName)) {
          existing.orders.push(orderInfo);
        }
        // Prefer the fully-descriptive filename if the first-seen copy wasn't one.
        if (!DESCRIPTIVE_NAME_RE.test(existing.fileName) && DESCRIPTIVE_NAME_RE.test(sku.fileName)) {
          existing.fileName = sku.fileName;
          existing.relPath = sku.relPath;
          existing.sizeBytes = sku.sizeBytes;
          existing.modifiedAt = sku.modifiedAt;
        }
        // Track the most recent modification across every copy of this SKU
        // (feeds the "Recently Updated" panel — a manual edit to any linked
        // order-folder's copy should surface as an update to the SKU).
        if (sku.modifiedAt > existing.modifiedAt) {
          existing.modifiedAt = sku.modifiedAt;
        }
      }
    }
  } else {
    warn(`Gen ${genNumber}: no Documents/Document folder found under ${genAbs}.`);
  }

  // Attach ancillary files to every SKU record that shares an order folder.
  // Captured now (per plan decision) but not yet surfaced in the v1 UI.
  for (const sku of skusByKey.values()) {
    for (const order of sku.orders) {
      const files = ancillaryByFolder.get(order.folderName);
      if (files) {
        sku.ancillaryFiles.push(...files.map(f => ({ folderName: order.folderName, ...f })));
      }
    }
  }

  const crossDir = findChildDir(genAbs, /^cross[ _]table$/i);
  if (crossDir) {
    const files = fs.readdirSync(crossDir, { withFileTypes: true })
      .filter(d => d.isFile() && /\.xlsx$/i.test(d.name) && !d.name.startsWith('~$'));
    for (const f of files) {
      const absPath = path.join(crossDir, f.name);
      try {
        const sheetNames = getSheetNamesCheap(absPath);
        const stat = fs.statSync(absPath);
        crossTables.push({
          gen: genNumber,
          fileName: f.name,
          relPath: relPath(absPath),
          sheetNames,
          sizeBytes: stat.size,
          modifiedAt: stat.mtime.toISOString(),
        });
      } catch (e) {
        warn(`${relPath(absPath)}: failed to open cross table (${e.message}), skipped.`);
      }
    }
  } else {
    warn(`Gen ${genNumber}: no Cross table/Cross Table folder found under ${genAbs}.`);
  }

  return { skus: [...skusByKey.values()], crossTables };
}

function main() {
  if (!fs.existsSync(MSF_ROOT)) {
    console.error(`MSF folder not found at ${MSF_ROOT} — check NPI_DATA_DIR.`);
    process.exit(1);
  }
  const genDirs = getGenDirs();
  if (genDirs.length === 0) {
    console.error(`No Gen 8/9/10/11 folders found under ${MSF_ROOT}.`);
    process.exit(1);
  }

  let allSkus = [];
  let allCrossTables = [];
  for (const genDir of genDirs) {
    const { skus, crossTables } = indexGen(genDir);
    console.log(`Gen ${genDir.genNumber}: ${skus.length} unique SKU(s), ${crossTables.length} cross table file(s).`);
    allSkus = allSkus.concat(skus);
    allCrossTables = allCrossTables.concat(crossTables);
  }

  fs.mkdirSync(INDEX_DIR, { recursive: true });
  fs.writeFileSync(INDEX_PATH, JSON.stringify({
    generatedAt: new Date().toISOString(),
    warnings,
    skus: allSkus,
    crossTables: allCrossTables,
  }, null, 2));

  console.log(`\nWrote ${allSkus.length} SKU(s) and ${allCrossTables.length} cross table file(s) to ${INDEX_PATH}`);
  if (warnings.length) console.log(`${warnings.length} warning(s) — see above.`);
}

main();
