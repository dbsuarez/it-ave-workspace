// Leave: my balances, asking for time off, my requests, and requests waiting for me to approve.
import { call } from '../api.js';
import { h, clear, put, toast, chip, sheet, emptyState, busy, askText } from '../ui.js';
import { rangeLabel, personName, plural, workingDays } from '../format.js';
import { on } from '../socket.js';

const STATUS = { pending: ['Waiting', 'warn'], approved: ['Approved', 'ok'], rejected: ['Declined', 'bad'], cancelled: ['Cancelled', ''] };

export async function render(root, parts, ctx) {
  const state = { me: null, approvals: [], error: '' };
  const page = h('div', { class: 'page' });
  root.append(page);

  async function load() {
    try {
      state.me = await call('/api/leave/me');
      state.approvals = state.me.approvalsWaiting ? (await call('/api/leave/approvals')).requests : [];
      ctx.setBadge('leave', state.me.approvalsWaiting || 0);
      state.error = '';
    } catch (err) {
      state.error = err.message || 'Leave is not available.';
    }
    paint();
  }

  function openRequest() {
    const me = state.me;
    sheet('Request leave', (body, close) => {
      const today = new Date().toISOString().slice(0, 10);
      const type = h('select', { class: 'input' }, me.balances.map((b) => h('option', { value: b.typeId }, `${b.name}${b.capped ? ` (${b.remaining} left)` : ''}`)));
      const start = h('input', { class: 'input', type: 'date', value: today, min: today });
      const end = h('input', { class: 'input', type: 'date', value: today, min: today });
      const half = h('input', { type: 'checkbox' });
      const reason = h('textarea', { class: 'input', rows: 3, maxlength: 500, placeholder: 'Reason (optional)' });
      const preview = h('p', { class: 'muted', 'aria-live': 'polite' });
      const update = () => {
        if (end.value < start.value) end.value = start.value;
        half.disabled = start.value !== end.value;
        if (half.disabled) half.checked = false;
        const days = workingDays(start.value, end.value, half.checked, me.holidays);
        preview.textContent = days ? `That is ${plural(days, 'day')} of leave.` : 'There are no working days in that range.';
      };
      [start, end, half].forEach((el) => el.addEventListener('change', update));
      update();
      const send = h('button', { class: 'btn primary', type: 'button', onclick: () => busy(send, async () => {
        await call('/api/leave/requests', { method: 'POST', body: { typeId: Number(type.value), startDate: start.value, endDate: end.value, halfDay: half.checked, reason: reason.value } });
        toast('Leave requested.', 'success');
        close();
        await load();
      }) }, 'Send request');
      body.append(h('label', {}, 'Type', type), h('label', {}, 'From', start), h('label', {}, 'To', end),
        h('label', { class: 'check' }, half, ' Half day (a single day only)'), reason, preview,
        h('p', { class: 'muted small' }, me.hasManager ? 'Your manager and HR are told.' : 'You have no manager set, so HR approves this.'), send);
    });
  }

  function balances() {
    return h('div', { class: 'stats' }, state.me.balances.map((b) => h('div', { class: 'stat' },
      h('strong', {}, b.capped ? String(b.remaining) : '∞'), h('span', {}, b.name), h('span', { class: 'small' }, b.capped ? `of ${b.entitled}${b.pending ? ` · ${b.pending} waiting` : ''}` : 'no limit'))));
  }

  function mine() {
    const list = state.me.requests;
    if (!list.length) return emptyState('No leave requests yet', 'Tap "Request leave" to ask for time off.');
    return h('div', { class: 'list' }, list.map((r) => {
      const [label, kind] = STATUS[r.status];
      const cancellable = r.status === 'pending' || (r.status === 'approved' && r.endDate >= new Date().toISOString().slice(0, 10));
      return h('div', { class: 'row static' },
        h('div', { class: 'row-main' }, h('strong', {}, rangeLabel(r.startDate, r.endDate)), h('div', { class: 'muted' }, `${r.typeName} · ${plural(r.days, 'day')}${r.halfDay ? ' (half)' : ''}`),
          r.decidedBy && r.status !== 'cancelled' ? h('div', { class: 'muted small' }, `by ${r.decidedBy}${r.decisionNote ? `: “${r.decisionNote}”` : ''}`) : null),
        h('div', {}, chip(label, kind), cancellable ? h('button', { class: 'btn small', type: 'button', onclick: async () => {
          try { await call(`/api/leave/requests/${r.id}/cancel`, { method: 'POST', body: {} }); toast('Request cancelled.', 'success'); await load(); } catch (err) { toast(err.message, 'error'); }
        } }, 'Cancel') : null));
    }));
  }

  function approvals() {
    if (!state.approvals.length) return null;
    return h('div', {}, h('h3', {}, `Waiting for you (${state.approvals.length})`), h('div', { class: 'list' }, state.approvals.map((r) => h('div', { class: 'card' },
      h('div', { class: 'row-split' }, h('strong', {}, personName(r)), chip(r.typeName, 'warn')),
      h('div', {}, `${rangeLabel(r.startDate, r.endDate)} · ${plural(r.days, 'day')}${r.halfDay ? ' (half day)' : ''}`),
      r.reason ? h('p', { class: 'muted' }, r.reason) : null,
      h('div', { class: 'row-actions' },
        h('button', { class: 'btn primary', type: 'button', onclick: async (e) => { await busy(e.target, async () => { await call(`/api/leave/requests/${r.id}/decision`, { method: 'PUT', body: { status: 'approved' } }); toast('Approved.', 'success'); await load(); }); } }, 'Approve'),
        h('button', { class: 'btn', type: 'button', onclick: async () => {
          const note = await askText('Tell them why (optional)');
          if (note === null) return;
          try { await call(`/api/leave/requests/${r.id}/decision`, { method: 'PUT', body: { status: 'rejected', note } }); toast('Declined.', 'success'); await load(); } catch (err) { toast(err.message, 'error'); }
        } }, 'Decline'))))));
  }

  function paint() {
    clear(page);
    if (state.error) { page.append(emptyState('Leave is not available', state.error)); return; }
    put(page, h('div', { class: 'row-split' }, h('h3', {}, `My leave ${state.me.year}`), h('button', { class: 'btn primary', type: 'button', onclick: openRequest }, 'Request leave')),
      balances(), approvals(), h('h3', {}, 'My requests'), mine());
  }

  const off = on('leave_updated', () => load());
  await load();
  return () => off();
}
