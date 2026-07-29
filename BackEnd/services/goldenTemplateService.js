const { fetchAllModels, fetchQvlList } = require('./qvlService');
const { buildPartDetail } = require('./partDetailService');

// Half of mssql's default pool max (10, no override in DB.js) — a crawl over
// every Model Reference leaves headroom for concurrent /api/part-detail and
// /api/compare traffic sharing the same connection pool while it runs.
const CHUNK_SIZE = 5;

// Crawls every Model Reference's QVL list and groups the results by Customer
// Part Number (the part before the "$subPN" suffix, e.g. "M1100779-001" from
// "M1100779-001$GH09" — same split('$')[0] idiom buildPartDetail already uses
// to derive its Rack SKU itemNumber). One bad Model Reference is recorded and
// skipped rather than aborting the whole crawl (Promise.allSettled, not
// Promise.all — the first use of allSettled in this codebase).
async function buildCatalog() {
  const models = await fetchAllModels();
  const failedModels = [];
  const cpnMap = new Map(); // cpn -> { cpn, modelRefs: Set, variants: Set }

  for (let i = 0; i < models.length; i += CHUNK_SIZE) {
    const chunk = models.slice(i, i + CHUNK_SIZE);
    const results = await Promise.allSettled(
      chunk.map(m => fetchQvlList(m.modelRef, m.location))
    );
    results.forEach((r, idx) => {
      const model = chunk[idx];
      if (r.status === 'rejected') {
        failedModels.push({
          modelRef: model.modelRef,
          location: model.location,
          error: r.reason?.message || String(r.reason)
        });
        return;
      }
      for (const row of r.value) {
        const fullPn = (row.PartNumber || '').trim();
        if (!fullPn) continue;
        const cpn = fullPn.split('$')[0];
        const entry = cpnMap.get(cpn) || { cpn, modelRefs: new Set(), variants: new Set() };
        entry.modelRefs.add(model.modelRef);
        entry.variants.add(fullPn);
        cpnMap.set(cpn, entry);
      }
    });
  }

  const entries = [...cpnMap.values()]
    .map(e => ({
      cpn: e.cpn,
      modelRefs: [...e.modelRefs].sort(),
      variants: [...e.variants].sort(),
      variantCount: e.variants.size
    }))
    .sort((a, b) => a.cpn.localeCompare(b.cpn));

  return {
    builtAt: new Date().toISOString(),
    modelCount: models.length,
    cpnCount: entries.length,
    failedModelCount: failedModels.length,
    failedModels,
    entries
  };
}

// In-memory cache, lost on process restart — same tradeoff as the existing
// revisionCodeCache (server.js). buildInFlight de-dupes concurrent rebuilds
// so simultaneous refresh clicks/requests share one crawl instead of racing.
let catalogCache = null;
let buildInFlight = null;

async function refreshCatalog() {
  if (buildInFlight) return buildInFlight;
  buildInFlight = buildCatalog()
    .then(result => { catalogCache = result; return result; })
    .finally(() => { buildInFlight = null; });
  return buildInFlight;
}

// Serves the cached catalog; builds it once (blocking the first caller) if
// never built. A failed rebuild leaves any previous good cache untouched —
// this is a read-only, best-effort catalog, so stale-but-served beats empty.
async function getCatalog() {
  if (catalogCache) return catalogCache;
  return refreshCatalog();
}

// Resolves one CPN's Golden Template. SysBom/CRDspec/FRUspec are keyed by the
// full encoded part number, not the bare CPN — only Rack SKU (PartProperties)
// is confirmed bare-CPN-keyed (see buildPartDetail). So: try the bare CPN
// first; if it has no SysBom rows, fall back to the first known encoded
// variant and flag which one was used via resolvedFrom.
async function resolveCpnDetail(cpn, variants) {
  const bareDetail = await buildPartDetail(cpn);
  if (bareDetail.location.rows.length > 0) {
    return { ...bareDetail, resolvedFrom: null };
  }

  const fallback = Array.isArray(variants) && variants.length ? variants[0] : null;
  if (!fallback) {
    return { ...bareDetail, resolvedFrom: null };
  }

  const variantDetail = await buildPartDetail(fallback);
  return { ...variantDetail, resolvedFrom: fallback };
}

module.exports = { getCatalog, refreshCatalog, resolveCpnDetail };
