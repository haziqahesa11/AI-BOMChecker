const { query } = require('../DB');

// Read-only: full TPA (MonicaTPApprover.exe) approval audit log, straight
// from bom.dbo.ReviewList — mirrors the exe's own "Approve History" tab
// (same 10 columns: ModelRef/PartNumber/Issuer.../Approver...). No stored
// proc involved (SP_ReviewList_History's definition isn't visible to this
// account, and a direct SELECT already matches the table 1:1, same pattern
// as partDetailService's SysBom/PartDescription reads).
async function fetchReviewHistory() {
  const result = await query(`
    SELECT ModelRef, PartNumber, Issuer, IssueDate, IssuerHost, IssuerReason,
           Approver, ApproveDate, ApproverHost, ApproverReason
    FROM bom.dbo.ReviewList
    ORDER BY ApproveDate DESC
  `);
  return result.recordset;
}

module.exports = { fetchReviewHistory };
