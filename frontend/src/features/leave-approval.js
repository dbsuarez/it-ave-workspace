// IT Avenue Workspace - Leave: the facts an approver needs on a request card: what the requester has left of each type of leave
// (before this request) and the last leave they took. Pure and tested; leave.js puts it on the card.

const approvalEscape = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// request: { balances: [{ name, entitled, remaining }], lastLeave: { typeName, startDate, endDate, days } | null } from GET /api/leave/approvals.
// fmt: { range(r) -> text for startDate..endDate, days(n) -> "2 days" }
function leaveApprovalFactsHtml(request, fmt) {
  if (!Array.isArray(request.balances) && request.lastLeave === undefined) return '';
  const balances = (request.balances || []).map((b) => `<span class="lv-fact-balance"><strong>${approvalEscape(b.name)}</strong> ${Number(b.remaining)} left of ${Number(b.entitled)}</span>`).join('');
  const last = request.lastLeave
    ? `${approvalEscape(request.lastLeave.typeName)}, ${approvalEscape(fmt.range(request.lastLeave))} · ${approvalEscape(fmt.days(request.lastLeave.days))}`
    : 'No leave taken yet';
  return `<div class="lv-facts">${balances ? `<div class="lv-fact-row"><span class="lv-fact-label">Balance before this request</span>${balances}</div>` : ''}<div class="lv-fact-row"><span class="lv-fact-label">Last leave</span><span>${last}</span></div></div>`;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { leaveApprovalFactsHtml };
}
