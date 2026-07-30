// Full TPA (MonicaTPApprover.exe) approval audit log, same 10 columns as
// the exe's own "Approve History" tab (ModelRef/PartNumber/Issuer.../Approver...).
// Previously this read bom.dbo.ReviewList directly, but that mirror lagged
// behind live approvals; it now goes through a small HTTP API someone stood
// up in front of the same table, which always reflects the current data.
async function fetchReviewHistory(from, to) {
  const baseUrl = process.env.TPA_HISTORY_URL;
  const key = process.env.TPA_HISTORY_KEY;
  if (!baseUrl || !key) {
    throw new Error('TPA_HISTORY_URL / TPA_HISTORY_KEY are not configured (config/credentials/tpa.env)');
  }

  const url = new URL(baseUrl);
  url.searchParams.set('from', from);
  url.searchParams.set('to', to);
  url.searchParams.set('key', key);

  const response = await fetch(url);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`TPA history API request failed (HTTP ${response.status}): ${text.slice(0, 300)}`);
  }

  const rows = JSON.parse(text);
  return rows.sort((a, b) => new Date(b.ApproveDate) - new Date(a.ApproveDate));
}

module.exports = { fetchReviewHistory };
