const { sfcsPool } = require('../DB');

// Stage-order vocabularies, verbatim from the two hand-validated SQL scripts
// this service is a port of ("L11 cycle time" / "blade cycle time").
// array_position() against this list is what turns a stage code into a
// sortable/lag-able step number — order here IS the process flow order.
const L11_STAGE_ORDER = [
  'WA','AI','AO','H1','IN','WT','PT','TN','TO','TP','N1','N2','QN','RS',
  'WL','MG','MD','M1','MW','PI','SU','WB','BO','CS','H2','PO','IO','IP','SN',
];
const L10_STAGE_ORDER = [
  'AO','V1','FN','PT','TR','TN','TO','TP','N1','N2','QN','RS',
  'MG','MD','M1','MW','PI','SU','BS','PO','SN',
];

const DEFAULT_RANGE_DAYS = 365; // matches the original scripts' hardcoded "NOW() - '1year'::interval"

function defaultFrom() {
  const d = new Date();
  d.setDate(d.getDate() - DEFAULT_RANGE_DAYS);
  return d.toISOString().slice(0, 10);
}
function defaultTo() {
  return new Date().toISOString().slice(0, 10);
}

// Which USNs to include for a date-range (browse) query: any unit of the
// right family with at least one transaction inside the window. This is the
// ONLY place the date range is applied — deliberately not on the cycle-time
// computation itself, so a narrow range picks units without truncating any
// of their stage history (see runCycleTimeForUsns below for why that matters:
// clipping transactions by date silently drops early stages like WA/AI and
// turns the first surviving stage's cycle_time into a clock-time, not a
// duration).
async function findUsnsInRange(usnPrefix, from, to) {
  const result = await sfcsPool.query(
    `select distinct s.usn
     from wymysfcs.sfctransaction s
     left join wymysfcs.sfcmodel s2 on s.upn = s2.upn
     where s.usn like $1
       and s2.description ~* 'GEN\\d+\\.\\d+'
       and s.trndate >= $2::date and s.trndate < ($3::date + interval '1 day')`,
    [usnPrefix, from, to]
  );
  return result.rows.map(r => r.usn);
}

// Which USNs to include for a model (e.g. "GEN9.0") query: any unit of the
// right family whose sfcmodel description's GEN token contains the typed
// text — same "pick usns, then compute full history" split as
// findUsnsInRange, just scoped by model instead of by date.
async function findUsnsByModel(usnPrefix, model) {
  const result = await sfcsPool.query(
    `select distinct s.usn
     from wymysfcs.sfctransaction s
     left join wymysfcs.sfcmodel s2 on s.upn = s2.upn
     where s.usn like $1
       and s2.description ~* 'GEN\\d+\\.\\d+'
       and substring(s2.description from '(?i)GEN\\d+\\.\\d+') ilike $2`,
    [usnPrefix, `%${model}%`]
  );
  return result.rows.map(r => r.usn);
}

// Rework exclusion, stage dedup, and lag-based cycle time — run over each
// usn's COMPLETE transaction history (no date bound at all here). Every usn
// passed in always gets its whole stage sequence (WA -> ... -> SN) with
// correct cycle times, regardless of how the caller decided which usns to
// include (a date-range scope, or a single exact usn lookup).
async function runCycleTimeForUsns(usns, stageOrder, { includeModel = true } = {}) {
  if (!usns.length) return [];
  // model_describe is always computed in the CTE (cheap, keeps the query
  // body identical either way) — includeModel only controls whether it
  // reaches the final result set, per each stage's own reference script
  // (L11's includes it, L10's latest script does not).
  const finalCols = includeModel
    ? 'usn, upn, stage, model_describe, trndate, prev_stage_trndate'
    : 'usn, upn, stage, trndate, prev_stage_trndate';
  const sqlText = `
    with FirstRework as (
      select s.usn, min(s.trndate) as rework_time
      from wymysfcs.sfctransaction s
      left join wymysfcs.sfcmodel s2 on s.upn = s2.upn
      where (s.stage ilike '%EN%') and s2.description ~* 'GEN\\d+\\.\\d+' and s.usn = ANY($1::text[])
      group by s.usn
    ),
    PreReworkStages as (
      select s.*, substring(s2.description from '(?i)GEN\\d+\\.\\d+') AS "model_describe",
        array_position($2::text[], s.stage::text) as stage_order,
        row_number() over (
          partition by s.usn, s.stage
          order by s.trndate asc
        ) as ss
      from wymysfcs.sfctransaction s
        left join wymysfcs.sfcmodel s2 on s.upn = s2.upn
        left join FirstRework fr on s.usn = fr.usn
      where s2.description ~* 'GEN\\d+\\.\\d+' and s.usn = ANY($1::text[])
        and (fr.rework_time is null or s.trndate < fr.rework_time)
        and s.stage not ilike '%EN%'
        and s.stage <> 'RN'
    ),
    DeduplicatedStages as (
      select * from PreReworkStages where ss = 1 and stage_order is not null
    ),
    CycleTimes as (
      select ds.*,
        lag(ds.trndate) over (
          partition by ds.usn
          order by ds.stage_order asc
        ) as prev_stage_trndate
      from DeduplicatedStages ds
    )
    select ${finalCols},
      case
        when prev_stage_trndate is null then to_char(trndate, 'HH24:MI:SS')
        else to_char(trndate - prev_stage_trndate, 'HH24:MI:SS')
      end as cycle_time
    from CycleTimes
    order by usn, stage_order asc
  `;
  const result = await sfcsPool.query(sqlText, [usns, stageOrder]);
  return result.rows;
}

async function getCycleTimeByRange(usnPrefix, stageOrder, from, to, options) {
  const usns = await findUsnsInRange(usnPrefix, from || defaultFrom(), to || defaultTo());
  return runCycleTimeForUsns(usns, stageOrder, options);
}

async function getCycleTimeByModel(usnPrefix, stageOrder, model, options) {
  const trimmed = (model || '').trim();
  if (!trimmed) return [];
  const usns = await findUsnsByModel(usnPrefix, trimmed);
  return runCycleTimeForUsns(usns, stageOrder, options);
}

// usnPrefix is 'R%'/'P%' — a cheap family guard so an L10 usn typed on the
// L11 tab (or vice versa) comes back empty instead of silently cross-matching.
async function getCycleTimeByUsn(usnPrefix, stageOrder, usn, options) {
  const trimmed = (usn || '').trim();
  if (!trimmed) return [];
  if (trimmed[0].toUpperCase() !== usnPrefix[0]) return [];
  return runCycleTimeForUsns([trimmed], stageOrder, options);
}

async function getL11CycleTime({ from, to, usn, model } = {}) {
  if (usn?.trim()) return getCycleTimeByUsn('R%', L11_STAGE_ORDER, usn);
  if (model?.trim()) return getCycleTimeByModel('R%', L11_STAGE_ORDER, model);
  return getCycleTimeByRange('R%', L11_STAGE_ORDER, from, to);
}

async function getL10CycleTime({ from, to, usn, model } = {}) {
  if (usn?.trim()) return getCycleTimeByUsn('P%', L10_STAGE_ORDER, usn);
  if (model?.trim()) return getCycleTimeByModel('P%', L10_STAGE_ORDER, model);
  return getCycleTimeByRange('P%', L10_STAGE_ORDER, from, to);
}

module.exports = { L11_STAGE_ORDER, L10_STAGE_ORDER, getL11CycleTime, getL10CycleTime };
