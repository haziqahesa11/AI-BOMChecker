// Orchestrates one AI Dashboard prediction: pulls real Cycle Time (PT stage) and
// First Pass Yield (MFG + MDAAS) numbers for a GEN-token Model (e.g. "GEN9"), pulls
// part info for a free-text Part Number, and asks Ollama for a narrative grounded in
// those real numbers. See the "Key design decision" note in the AI Dashboard plan for
// why Model here is the GEN token cycleTimeService.js/firstPassYieldService.js use —
// not the QVL Model Reference /api/models returns — and why Part Number's role is
// informational context rather than a numeric join into the Cycle Time/FPY stats (no
// such per-component join exists in the underlying data).
//
// READ-ONLY, by construction, not just convention: every DB access here goes through
// existing service functions that only ever SELECT — cycleTimeService.js/
// firstPassYieldService.js query sfcsPool, which DB.js opens with
// `default_transaction_read_only=on` as a Postgres session parameter (the DB itself
// rejects a write on that connection, not just this code); partDetailService.js's
// buildPartDetail() only issues SELECTs against BOM/MSFT_SKU. This module never
// imports annonWritePool or any write-capable pool/function, and adds no SQL of its
// own — it only calls the read functions above and formats their results.
const cycleTimeService = require('./cycleTimeService');
const firstPassYieldService = require('./firstPassYieldService');
const { buildPartDetail } = require('./partDetailService');
const { stageStats, stageDailyTrend, stageHistogram } = require('./cycleTimeStats');
const ollamaClient = require('./ollamaClient');

const PT_STAGE = 'PT';
const ENVIRONMENTS = ['MFG', 'MDAAS'];

// Cycle Time's model-only mode (getL11CycleTime({ model })) has NO date bound at all
// — it matches every USN of that GEN token across the DB's ENTIRE history. Confirmed
// live (2026-08-12) that this genuinely times out (30s+, no response) against the
// real SFCS DB, independent of anything in this file — the SAME hang reproduces on
// the plain /api/cycle-time/l11?model=GEN9 route. The date-range mode
// (getL11CycleTime({ from, to })), by contrast, answered in ~11s for a 30-day window
// with a healthy few hundred PT-stage samples for a single GEN token. So this pulls a
// bounded recent window across ALL models via the fast range path, then filters to
// the requested GEN token in JS (mirroring the model-mode SQL's own `ILIKE
// '%<model>%'` substring match on model_describe) — recent performance is also the
// more relevant signal for a forward-looking prediction anyway.
const CYCLE_TIME_LOOKBACK_DAYS = 30;

// buildPartDetail() goes through the separate MSSQL `BOM`/`MSFT_SKU` connection
// (services/partDetailService.js -> DB.js's mssql pool), not the SFCS Postgres pool
// Cycle Time/FPY use — a distinct dependency with its own reachability/latency
// profile. It's decoupled from the Promise.all below and given its own timeout so a
// slow/unreachable BOM DB degrades to "part info unavailable" instead of blocking
// the Cycle Time + FPY numbers (which come from an entirely different DB) from ever
// reaching the user — same non-blocking philosophy as the Ollama call.
const PART_DETAIL_TIMEOUT_MS = 10_000;

// Cycle Time/FPY (sfcsPool) are otherwise unbounded — confirmed live this session
// that even the "fast" date-range path can intermittently take 60s+ against the real
// DB with no request-level timeout anywhere in this stack (Express/Node set none by
// default). Without a cap here, a slow DB moment leaves the user's browser spinning
// forever with zero feedback. This is generous (these are the two data sources the
// whole prediction is actually about, unlike part-detail/Ollama above), but finite.
const CORE_DATA_TIMEOUT_MS = 45_000;

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function lookbackWindow(days) {
  const to = new Date();
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
  const toISODate = (d) => d.toISOString().slice(0, 10);
  return { from: toISODate(from), to: toISODate(to) };
}

function summarizePartDetail(partDetail) {
  if (!partDetail) return null;
  return {
    locationRowCount: partDetail.location.rows.length,
    crdFound: partDetail.crd.found,
    fruFound: partDetail.fru.found,
    rackSkuFound: partDetail.rackSku.found,
  };
}

function buildPrompt({ model, partNumber, cycleTimePt, fpy, partDetailSummary }) {
  const fpyLines = ENVIRONMENTS.map((env) => {
    const t = fpy[env].totals;
    return `- ${env}: ${t.total} unit(s) closed, ${t.withoutFail} without fail (${t.pctWithoutFail}% first-pass yield), ${t.withFail} with a fail.`;
  }).join('\n');

  const topFailureLines = ENVIRONMENTS.map((env) => {
    const top = fpy[env].topFailures.slice(0, 3);
    if (!top.length) return `- ${env}: no failures recorded.`;
    return `- ${env}: ${top.map((f) => `${f.station} (${f.count})`).join(', ')}`;
  }).join('\n');

  const partInfoLine = partDetailSummary
    ? `Part info: ${partDetailSummary.locationRowCount} BOM location row(s) on record; CRD spec ${partDetailSummary.crdFound ? 'found' : 'not found'}; FRU spec ${partDetailSummary.fruFound ? 'found' : 'not found'}; Rack SKU properties ${partDetailSummary.rackSkuFound ? 'found' : 'not found'}.`
    : 'Part info: unavailable right now (lookup failed or timed out) — do not assume anything about this part\'s BOM/CRD/FRU/Rack SKU status.';

  return `You are a manufacturing quality/reliability analyst for Wiwynn server production.
Give a short, honest risk assessment for the part below, grounded ONLY in the numbers
provided — do not invent data. If a sample size is small, say so explicitly instead of
projecting false confidence. Keep it to 3-5 sentences.

Model (GEN generation): ${model}
Part Number: ${partNumber}
${partInfoLine}

Cycle Time — PT stage (Power On Test, L11/rack test), ${model} units, last ${CYCLE_TIME_LOOKBACK_DAYS} days:
- Sample size: ${cycleTimePt.sampleCount} measured stage-duration(s).
- Average: ${cycleTimePt.avgFormatted ?? 'n/a'} | Median: ${cycleTimePt.medianFormatted ?? 'n/a'} | Min: ${cycleTimePt.minFormatted ?? 'n/a'} | Max: ${cycleTimePt.maxFormatted ?? 'n/a'}

First Pass Yield, ${model} units, current reporting period:
${fpyLines}

Top failing stations:
${topFailureLines}

Based only on the above, assess the expected PT cycle time and first-pass yield risk for this part number/model, and note any data-quality caveats (e.g. small sample size, missing part info).`;
}

async function predict({ model, partNumber }) {
  const trimmedModel = (model || '').trim();
  const trimmedPn = (partNumber || '').trim();
  if (!trimmedModel) throw new Error('model is required.');
  if (!trimmedPn) throw new Error('partNumber is required.');

  const { from, to } = lookbackWindow(CYCLE_TIME_LOOKBACK_DAYS);
  const [recentRows, fpyMfg, fpyMdaas] = await withTimeout(
    Promise.all([
      cycleTimeService.getL11CycleTime({ from, to }),
      firstPassYieldService.getFpySummary({ model: trimmedModel, environment: 'MFG' }),
      firstPassYieldService.getFpySummary({ model: trimmedModel, environment: 'MDAAS' }),
    ]),
    CORE_DATA_TIMEOUT_MS,
    `Cycle Time / First Pass Yield lookup timed out after ${CORE_DATA_TIMEOUT_MS / 1000}s — the SFCS database may be slow or unreachable right now. Try again shortly.`
  );
  const modelRows = recentRows.filter((r) =>
    (r.model_describe || '').toUpperCase().includes(trimmedModel.toUpperCase())
  );
  const cycleTimePt = {
    ...stageStats(modelRows, PT_STAGE),
    dailyTrend: stageDailyTrend(modelRows, PT_STAGE),
    histogram: stageHistogram(modelRows, PT_STAGE),
  };
  const fpy = { MFG: fpyMfg, MDAAS: fpyMdaas };

  let partDetail = null;
  let partDetailError = null;
  try {
    partDetail = await withTimeout(
      buildPartDetail(trimmedPn),
      PART_DETAIL_TIMEOUT_MS,
      `Part detail lookup timed out after ${PART_DETAIL_TIMEOUT_MS / 1000}s.`
    );
  } catch (err) {
    partDetailError = err.message;
  }
  const partDetailSummary = summarizePartDetail(partDetail);

  let prediction;
  try {
    const narrative = await ollamaClient.generate(
      buildPrompt({ model: trimmedModel, partNumber: trimmedPn, cycleTimePt, fpy, partDetailSummary })
    );
    prediction = { available: true, narrative };
  } catch (err) {
    if (!(err instanceof ollamaClient.OllamaUnavailableError)) throw err;
    prediction = { available: false, reason: err.message };
  }

  return {
    model: trimmedModel,
    partNumber: trimmedPn,
    cycleTimePt,
    fpy,
    partDetail,
    partDetailError,
    prediction,
  };
}

module.exports = { predict, PT_STAGE, ENVIRONMENTS, CYCLE_TIME_LOOKBACK_DAYS };
