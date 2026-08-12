// Pure helpers turning cycleTimeService.js's row shape into summary stats for one
// stage (e.g. 'PT') — no DB/network access, safe to unit-test in isolation.

// cycle_time is to_char(<interval>, 'HH24:MI:SS') for any row with a real
// prev_stage_trndate. Postgres does NOT cap an interval's hour field at 24 (a
// multi-day gap between stages prints as e.g. "100:15:33"), so this splits
// generically instead of assuming two-digit hours.
function parseDurationToSeconds(text) {
  if (!text) return null;
  const parts = text.trim().split(':').map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) return null;
  const [h, m, s] = parts;
  return h * 3600 + m * 60 + s;
}

// Rows with no prev_stage_trndate had cycle_time computed from
// to_char(trndate, 'HH24:MI:SS') instead (see cycleTimeService.js's own comment on
// this branch) — that's a clock-time-of-day, not an elapsed duration, and would
// corrupt an average if included. Only rows with a real prev_stage_trndate measure
// an actual stage duration.
function stageDurationsSeconds(rows, stage) {
  return rows
    .filter((r) => r.stage === stage && r.prev_stage_trndate)
    .map((r) => parseDurationToSeconds(r.cycle_time))
    .filter((v) => v !== null);
}

function median(sortedValues) {
  const n = sortedValues.length;
  if (n === 0) return null;
  const mid = Math.floor(n / 2);
  return n % 2 === 0 ? (sortedValues[mid - 1] + sortedValues[mid]) / 2 : sortedValues[mid];
}

function formatSeconds(totalSeconds) {
  if (totalSeconds === null || totalSeconds === undefined) return null;
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.round(totalSeconds % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// Summary stats (count/avg/min/max/median, each as raw seconds + "HH:MM:SS") for one
// stage's cycle time across a set of cycleTimeService.js rows.
function stageStats(rows, stage) {
  const durations = stageDurationsSeconds(rows, stage).sort((a, b) => a - b);
  if (!durations.length) {
    return {
      stage,
      sampleCount: 0,
      avgSeconds: null, minSeconds: null, maxSeconds: null, medianSeconds: null,
      avgFormatted: null, minFormatted: null, maxFormatted: null, medianFormatted: null,
    };
  }
  const sum = durations.reduce((a, b) => a + b, 0);
  const avg = sum / durations.length;
  const min = durations[0];
  const max = durations[durations.length - 1];
  const med = median(durations);
  return {
    stage,
    sampleCount: durations.length,
    avgSeconds: avg, minSeconds: min, maxSeconds: max, medianSeconds: med,
    avgFormatted: formatSeconds(avg), minFormatted: formatSeconds(min),
    maxFormatted: formatSeconds(max), medianFormatted: formatSeconds(med),
  };
}

module.exports = { parseDurationToSeconds, stageDurationsSeconds, stageStats, formatSeconds };
