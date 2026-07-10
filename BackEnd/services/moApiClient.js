const fs = require('fs');
const path = require('path');

const MO_API_CONFIG_PATH = path.join(__dirname, '..', 'API_Info_folder', 'MO_API.txt');

// Static query parameters for the "GETMOITEM" dynamic query (see MO_API.txt / GetDynamicData op).
const DYN_QUERY_ID = 'GETMOITEM';
const CRITERIA_NAME = 'MO';
const CRITERIA_VALUE_PREFIX = '0000';

// MO_API.txt holds the .asmx docs URL (e.g. ".../WebService.asmx?op=GetDynamicData").
// The ASMX "HTTP POST protocol" invoke URL for an operation is the base .asmx path
// with the operation name appended as a path segment (no query string).
function getOperationUrl(operation) {
  const raw = fs.readFileSync(MO_API_CONFIG_PATH, 'utf8').trim();
  const baseUrl = raw.split('?')[0];
  return `${baseUrl}/${operation}`;
}

// Builds the GetDynamicData request parameters for an MO Number lookup.
// CriteriaValue = static "0000" prefix + the MO Number entered by the user.
function buildMoLookupParams(moNumber) {
  const mo = String(moNumber).trim();
  return {
    DynQueryID: DYN_QUERY_ID,
    CriteriaName: CRITERIA_NAME,
    CriteriaValue: CRITERIA_VALUE_PREFIX + mo
  };
}

// Invokes the GetDynamicData operation via the ASMX HTTP POST protocol
// (application/x-www-form-urlencoded body, one field per parameter).
// Returns the raw XML response text — parsing it into structured item data is Phase 2,
// once the actual response schema has been observed.
async function fetchMoItem(moNumber) {
  const params = buildMoLookupParams(moNumber);
  const url = getOperationUrl('GetDynamicData');

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params)
  });

  const xmlText = await response.text();
  if (!response.ok) {
    throw new Error(`MO API request failed (HTTP ${response.status}): ${xmlText.slice(0, 300)}`);
  }

  return { params, xml: xmlText };
}

module.exports = { buildMoLookupParams, fetchMoItem, getOperationUrl };
