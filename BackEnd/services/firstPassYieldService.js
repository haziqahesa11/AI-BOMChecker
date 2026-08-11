const { sfcsPool } = require('../DB');

const DEFAULT_RANGE_DAYS = 7;

function defaultFrom() {
  const d = new Date();
  d.setDate(d.getDate() - DEFAULT_RANGE_DAYS);
  return d.toISOString().slice(0, 10);
}
function defaultTo() {
  return new Date().toISOString().slice(0, 10);
}

// Blade (L10, usn like 'P%') First Pass Yield fail data — port of the
// hand-validated "--blade FPY" SQL script: every sfcusninfo row for a blade
// usn, joined to sfcusn for the blade's own upn/mo and to sfcmodel for the
// GEN model token. Three lookup modes, matching cycleTimeService.js's
// Date Range / Single USN / Model convention:
//   - Date Range: trndate window picks which rows come back, but an
//     infoname LIKE 'INFO_%' row (a fail record) is always included even
//     if its own trndate falls outside the window — the date filter should
//     narrow ordinary activity, never silently drop a fail. (The user's
//     script wrote this as `usn like 'P%' and trndate >= d or infoname like
//     'INFO_%'` with no parens; SQL's AND-before-OR precedence would parse
//     that as `(usn like 'P%' and trndate >= d) or infoname like 'INFO_%'`
//     — dropping the 'P%' scope entirely for every INFO_ row. Grouped here
//     as `usn like 'P%' and (trndate >= d or infoname like 'INFO_%')`,
//     which is what stays scoped to blade units.)
//   - Single USN: exact match, full history (no date bound).
//   - Model: every usn whose GEN model token contains the typed text, full
//     history each. Model can't be filtered inside the CTE (it's a joined,
//     computed column), so this mode wraps the base query and filters on
//     the outer "model" alias instead.
async function getFpyByRange(from, to) {
  const result = await sfcsPool.query(
    `with info_usn as (
      select
        s.*, s2.upn as blade_upn, s2.mo as blade_mo, s2.upn
      from wymysfcs.sfcusninfo s
      left join wymysfcs.sfcusn s2 on s.usn = s2.usn
      where s.usn like 'P%'
        and (
          (s.trndate >= $1::date and s.trndate < ($2::date + interval '1 day'))
          or s.infoname like 'INFO\\_%'
        )
      order by s.usn, s.trndate asc
    )
    select
      info_usn.*,
      substring(s3.description::text, '(?i)GEN\\d+\\.\\d+') as model
    from info_usn
    left join wymysfcs.sfcmodel s3 on info_usn.upn = s3.upn`,
    [from || defaultFrom(), to || defaultTo()]
  );
  return result.rows;
}

async function getFpyByUsn(usn) {
  const trimmed = (usn || '').trim();
  if (!trimmed) return [];
  const result = await sfcsPool.query(
    `with info_usn as (
      select
        s.*, s2.upn as blade_upn, s2.mo as blade_mo, s2.upn
      from wymysfcs.sfcusninfo s
      left join wymysfcs.sfcusn s2 on s.usn = s2.usn
      where s.usn = $1
      order by s.usn, s.trndate asc
    )
    select
      info_usn.*,
      substring(s3.description::text, '(?i)GEN\\d+\\.\\d+') as model
    from info_usn
    left join wymysfcs.sfcmodel s3 on info_usn.upn = s3.upn`,
    [trimmed]
  );
  return result.rows;
}

async function getFpyByModel(model) {
  const trimmed = (model || '').trim();
  if (!trimmed) return [];
  const result = await sfcsPool.query(
    `select * from (
      with info_usn as (
        select
          s.*, s2.upn as blade_upn, s2.mo as blade_mo, s2.upn
        from wymysfcs.sfcusninfo s
        left join wymysfcs.sfcusn s2 on s.usn = s2.usn
        where s.usn like 'P%'
        order by s.usn, s.trndate asc
      )
      select
        info_usn.*,
        substring(s3.description::text, '(?i)GEN\\d+\\.\\d+') as model
      from info_usn
      left join wymysfcs.sfcmodel s3 on info_usn.upn = s3.upn
    ) fpy
    where fpy.model ilike $1`,
    [`%${trimmed}%`]
  );
  return result.rows;
}

async function getBladeFpy({ from, to, usn, model } = {}) {
  if (usn?.trim()) return getFpyByUsn(usn);
  if (model?.trim()) return getFpyByModel(model);
  return getFpyByRange(from, to);
}

// ── FPY summary (blade, usn like 'P%') ──────────────────────────────────────
//
// Population for a given (model, week) is anchored to CLOSURE, not to fail
// date: every usn that reached sfcusn.stage 'SN' (or 'ZZ' — present in the
// user's spec but never actually observed as a sfcusn.stage value; kept for
// literal fidelity, costs nothing) within that Sunday-Saturday week. That
// population is fixed per (model, week) regardless of environment, so for
// each environment E, withFail(E) + withoutFail(E) == population size
// always — Total is identical across MFG/MDAAS/BSL by construction, per the
// user's explicit requirement, rather than by chance.
//
// A usn in that population is "with fail" for environment E if it has ANY
// wymysfcs.sfcusninfo row with infoname LIKE 'INFO\_%' (the literal filter
// the user specified) whose stage (first comma-separated field of
// infovalue) is one of E's stage codes — checked across the usn's whole
// history, not just the closure week, since the population itself is
// already one-usn-per-week (no double counting to guard against here; the
// "only count the first failure, not a same-week repeat" rule the user gave
// is automatically satisfied by this being an existence check, not an event
// count).
const MFG_STAGES = ['PT', 'TN', 'TO', 'TP', 'N1', 'N2', 'QN', 'RS'];
const MDAAS_STAGES = ['MG', 'MD', 'M1', 'MW', 'PI', 'SU'];
// BSL ('BS') intentionally left out — "leave BS FPY first" per spec.
const ENV_STAGES = { MFG: MFG_STAGES, MDAAS: MDAAS_STAGES };

// Default range when the caller omits from/to: WK1 (Jan 1) of the current
// year through the last FULLY COMPLETED week. The frontend always sends
// explicit dates built the same way (see FirstPassYieldPage.jsx), so this
// is only a fallback — but it stays consistent with that same "don't
// include the still-in-progress current week" rule.
function lastCompletedWeekEnd() {
  const today = new Date();
  const sunday = new Date(today);
  sunday.setDate(today.getDate() - today.getDay());
  const saturday = new Date(sunday);
  saturday.setDate(sunday.getDate() - 1);
  return saturday;
}
function summaryDefaultTo() {
  return lastCompletedWeekEnd().toISOString().slice(0, 10);
}
function summaryDefaultFrom() {
  const to = lastCompletedWeekEnd();
  return new Date(to.getFullYear(), 0, 1).toISOString().slice(0, 10);
}

// Parses a 'YYYY-MM-DD...' string into a UTC-midnight Date representing that
// calendar day only. Deliberately never goes through node-pg's own Date
// parsing (see cycleTimeService.js's comment on the same hazard) — the SQL
// side always sends plain YYYY-MM-DD text via to_char(), so this is just
// splitting digits, with no server-OS-timezone or forced-UTC step involved.
function parseDateOnly(text) {
  const [y, m, d] = text.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
function sundayOf(dateOnlyUtc) {
  const dow = dateOnlyUtc.getUTCDay(); // 0 = Sunday
  return new Date(dateOnlyUtc.getTime() - dow * 86400000);
}
function weekKeyOf(sunday) {
  return sunday.toISOString().slice(0, 10);
}
// Simple, deterministic Sunday-week numbering: week 1 is the week containing
// Jan 1 of that Sunday's year. Not a claim to match any specific existing
// report's numbering — a display label, not a value that feeds the FPY math.
function weekLabelOf(sunday) {
  const year = sunday.getUTCFullYear();
  const jan1 = Date.UTC(year, 0, 1);
  const diffDays = Math.round((sunday.getTime() - jan1) / 86400000);
  return `WK${Math.floor(diffDays / 7) + 1}`;
}

async function getFpySummary({ from, to, model, environment } = {}) {
  const stages = ENV_STAGES[environment];
  if (!stages) {
    throw new Error(`Unsupported environment "${environment}" — only MFG and MDAAS are available (BSL not yet supported)`);
  }

  const rangeFrom = from || summaryDefaultFrom();
  const rangeTo = to || summaryDefaultTo();
  const trimmedModel = (model || '').trim();

  const popParams = [rangeFrom, rangeTo];
  let modelFilter = '';
  if (trimmedModel) {
    popParams.push(trimmedModel);
    modelFilter = `and upper(substring(s3.description::text, '(?i)GEN\\d+')) = upper($3)`;
  }
  const popResult = await sfcsPool.query(
    `select
       s.usn,
       to_char(s.updatedate, 'YYYY-MM-DD') as closedate,
       substring(s3.description::text, '(?i)GEN\\d+') as model
     from wymysfcs.sfcusn s
     left join wymysfcs.sfcmodel s3 on s.upn = s3.upn
     where s.usn like 'P%'
       and s.stage in ('SN', 'ZZ')
       and s.updatedate >= $1::date and s.updatedate < ($2::date + interval '1 day')
       ${modelFilter}`,
    popParams
  );
  const population = popResult.rows.filter(r => r.model && r.closedate);

  if (!population.length) {
    return { weeks: [], totals: { withFail: 0, withoutFail: 0, total: 0, pctWithFail: 0, pctWithoutFail: 0 }, topFailures: [] };
  }

  const usns = population.map(r => r.usn);
  const failResult = await sfcsPool.query(
    `select usn, split_part(infovalue, ',', 1) as stage, split_part(infovalue, ',', 3) as station
     from wymysfcs.sfcusninfo
     where usn = ANY($1::text[]) and infoname like 'INFO\\_%'`,
    [usns]
  );

  const stageSet = new Set(stages);
  const failingUsnStations = new Map(); // usn -> Set(station names), for usns failing in this environment
  for (const row of failResult.rows) {
    const stage = (row.stage || '').trim().toUpperCase();
    if (!stageSet.has(stage)) continue;
    if (!failingUsnStations.has(row.usn)) failingUsnStations.set(row.usn, new Set());
    failingUsnStations.get(row.usn).add((row.station || '').trim() || 'UNKNOWN');
  }

  const weekMap = new Map(); // "model|weekKey" -> bucket
  for (const row of population) {
    const sunday = sundayOf(parseDateOnly(row.closedate));
    const weekKey = weekKeyOf(sunday);
    const key = `${row.model}|${weekKey}`;
    if (!weekMap.has(key)) {
      weekMap.set(key, {
        model: row.model,
        weekStart: weekKey,
        weekLabel: weekLabelOf(sunday),
        withFail: 0,
        withoutFail: 0,
      });
    }
    const bucket = weekMap.get(key);
    if (failingUsnStations.has(row.usn)) bucket.withFail++;
    else bucket.withoutFail++;
  }

  const weeks = [...weekMap.values()]
    .map(w => {
      const total = w.withFail + w.withoutFail;
      return {
        ...w,
        total,
        pctWithFail: total ? +(w.withFail / total * 100).toFixed(2) : 0,
        pctWithoutFail: total ? +(w.withoutFail / total * 100).toFixed(2) : 0,
      };
    })
    .sort((a, b) => a.weekStart.localeCompare(b.weekStart));

  const totals = weeks.reduce(
    (acc, w) => {
      acc.withFail += w.withFail;
      acc.withoutFail += w.withoutFail;
      acc.total += w.total;
      return acc;
    },
    { withFail: 0, withoutFail: 0, total: 0 }
  );
  totals.pctWithFail = totals.total ? +(totals.withFail / totals.total * 100).toFixed(2) : 0;
  totals.pctWithoutFail = totals.total ? +(totals.withoutFail / totals.total * 100).toFixed(2) : 0;

  // Top Failures: how many distinct failing usns hit each station, within
  // this environment's stages — a usn retried repeatedly at the same
  // station only counts once there (Set dedup above), consistent with the
  // "count the usn, not the retry" methodology used for withFail itself.
  const stationCounts = new Map();
  for (const stations of failingUsnStations.values()) {
    for (const station of stations) {
      stationCounts.set(station, (stationCounts.get(station) || 0) + 1);
    }
  }
  const topFailures = [...stationCounts.entries()]
    .map(([station, count]) => ({ station, count }))
    .sort((a, b) => b.count - a.count);

  return { weeks, totals, topFailures };
}

module.exports = { getBladeFpy, getFpySummary, MFG_STAGES, MDAAS_STAGES };
