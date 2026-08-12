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

// One point per calendar day (from trndate) with >=1 measured PT duration, sorted
// ascending. Reports both mean and median per day — median is what trend/projection
// math should fit on: real PT durations are heavily right-skewed (confirmed live,
// e.g. one GEN9 sample: mean 04:29:42 vs. median 02:13:13, max 23:30:57), so a small
// day's sample mean is easily dragged around by a single long outlier in a way its
// median isn't. Days with zero qualifying rows are omitted rather than zero-filled —
// a 30-day window can have real gaps (weekends, low-volume days) that aren't "zero
// cycle time," they're "no data," and those are different things to plot.
function stageDailyTrend(rows, stage) {
  const byDay = new Map(); // "YYYY-MM-DD" -> seconds[]
  for (const r of rows) {
    if (r.stage !== stage || !r.prev_stage_trndate) continue;
    const seconds = parseDurationToSeconds(r.cycle_time);
    if (seconds === null) continue;
    const day = (r.trndate || '').slice(0, 10);
    if (!day) continue;
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(seconds);
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, seconds]) => {
      seconds.sort((a, b) => a - b);
      const avg = seconds.reduce((a, b) => a + b, 0) / seconds.length;
      const med = median(seconds);
      return {
        date,
        sampleCount: seconds.length,
        avgSeconds: avg,
        avgFormatted: formatSeconds(avg),
        medianSeconds: med,
        medianFormatted: formatSeconds(med),
      };
    });
}

// Fixed hour-wide buckets spanning the real observed PT range (minutes to 24h+) —
// a fixed scheme (vs. computing bucket width from the data) keeps bucket boundaries
// stable and comparable across separate requests/models rather than shifting with
// whatever happens to be in this particular result set.
const HISTOGRAM_BUCKET_EDGES_HOURS = [0, 1, 2, 4, 8, 16, 24, Infinity];

function stageHistogram(rows, stage) {
  const buckets = HISTOGRAM_BUCKET_EDGES_HOURS.slice(0, -1).map((lo, i) => {
    const hi = HISTOGRAM_BUCKET_EDGES_HOURS[i + 1];
    return {
      label: hi === Infinity ? `${lo}h+` : `${lo}-${hi}h`,
      loSeconds: lo * 3600,
      hiSeconds: hi * 3600,
      count: 0,
    };
  });
  for (const seconds of stageDurationsSeconds(rows, stage)) {
    const bucket = buckets.find((b) => seconds >= b.loSeconds && seconds < b.hiSeconds);
    if (bucket) bucket.count += 1;
  }
  return buckets.map(({ label, count }) => ({ label, count }));
}

module.exports = {
  parseDurationToSeconds,
  stageDurationsSeconds,
  stageStats,
  stageDailyTrend,
  stageHistogram,
  formatSeconds,
};
