// Clock: clock in and out (as many times a day as you leave and come back), today's status, my month, a way to ask
// for a correction, and corrections waiting for me when I am a manager or HR. Times are the company's.
import { call, deviceHeaders } from '../api.js';
import { h, clear, put, toast, chip, sheet, emptyState, busy, askText } from '../ui.js';
import { dayLabel, punchLine, hoursText, personName, plural } from '../format.js';
import { on } from '../socket.js';

const STATUS = {
  present: ['Present', 'ok'], working: ['Working', 'info'], absent: ['Absent', 'bad'], leave: ['On leave', 'warn'], holiday: ['Holiday', ''],
  rest: ['Rest day', ''], incomplete: ['No clock-out', 'bad'], upcoming: ['', ''],
};
const CORRECTION = { pending: ['Waiting', 'warn'], approved: ['Approved', 'ok'], rejected: ['Declined', 'bad'], cancelled: ['Cancelled', ''] };

export async function render(root, parts, ctx) {
  const state = { today: null, sheet: null, mine: [], queue: [], month: new Date().toISOString().slice(0, 7), error: '' };
  const page = h('div', { class: 'page' });
  root.append(page);

  async function load() {
    try {
      state.today = await call('/api/attendance/today');
      state.sheet = await call(`/api/attendance/timesheet?month=${state.month}`);
      state.mine = (await call('/api/attendance/corrections/mine')).corrections;
      state.queue = state.today.correctionsWaiting ? (await call('/api/attendance/corrections/queue')).corrections : [];
      ctx.setBadge('clock', state.today.correctionsWaiting || 0);
      state.error = '';
    } catch (err) {
      state.error = err.message || 'Attendance is not available.';
    }
    paint();
  }

  function clockCard() {
    const t = state.today;
    const punches = t.day ? t.day.punches : [];
    let status;
    if (t.clockedIn) status = `Clocked in since ${t.openSince}${t.day && t.day.lateMinutes ? ` (${t.day.lateMinutes} min late)` : ''}.`;
    else if (punches.length) status = `Clocked out at ${punches[punches.length - 1].out}. Worked ${hoursText(t.day.workedMinutes) || '0'} hours so far.`;
    else if (t.day && t.day.status === 'holiday') status = 'Today is a company holiday.';
    else if (t.day && t.day.status === 'rest') status = 'Today is a rest day.';
    else if (t.day && t.day.status === 'leave') status = 'You are on approved leave today.';
    else status = 'You have not clocked in yet.';
    const blocked = t.network.enforced && !t.network.allowed;
    const button = h('button', { class: 'btn primary clock-btn', type: 'button', disabled: blocked, onclick: () => busy(button, async () => {
      try {
        await call(`/api/attendance/clock-${t.clockedIn ? 'out' : 'in'}`, { method: 'POST', body: {}, headers: deviceHeaders() });
        toast(t.clockedIn ? 'Clocked out.' : 'Clocked in.', 'success');
      } finally {
        await load();
      }
    }) }, t.clockedIn ? 'Clock out' : 'Clock in');
    return h('div', { class: 'card clock-card' },
      h('div', { class: 'muted' }, dayLabel(t.today, true)),
      h('p', { class: 'clock-status' }, status),
      punches.length ? h('div', { class: 'chips' }, punches.map((p) => chip(`${p.in}–${p.out || '…'}`))) : null,
      blocked ? h('p', { class: 'warn-box' }, 'You are not on the office network, so you cannot clock in or out. If you work remotely, ask HR.') : null,
      button,
      h('p', { class: 'muted small' }, `Schedule: ${t.schedule.name} · ${t.schedule.start}–${t.schedule.end} · ${t.timezone.replace('_', ' ')} time`));
  }

  function openCorrection(day) {
    sheet(`Correct ${dayLabel(day.date)}`, (body, close) => {
      const rows = h('div', {});
      const addRow = (p = {}) => rows.append(h('div', { class: 'punch-row' },
        h('label', {}, 'In', h('input', { class: 'input', type: 'time', value: p.in || '', required: true, dataset: { punch: 'in' } })),
        h('label', {}, 'Out', h('input', { class: 'input', type: 'time', value: p.out || '', dataset: { punch: 'out' } })),
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Remove', onclick: (e) => { if (rows.children.length > 1) e.target.closest('.punch-row').remove(); } }, '×')));
      (day.punches.length ? day.punches : [{}]).forEach(addRow);
      const reason = h('input', { class: 'input', type: 'text', maxlength: 300, placeholder: 'Reason (for example: forgot to clock out)' });
      const send = h('button', { class: 'btn primary', type: 'button', onclick: () => busy(send, async () => {
        const punches = Array.from(rows.children).map((row) => ({ in: row.querySelector('[data-punch="in"]').value, out: row.querySelector('[data-punch="out"]').value || null })).filter((p) => p.in);
        await call('/api/attendance/corrections', { method: 'POST', body: { date: day.date, punches, reason: reason.value } });
        toast('Correction requested.', 'success');
        close();
        await load();
      }) }, 'Send request');
      body.append(h('p', { class: 'muted' }, 'Each row is one stretch of work, for example in 08:00 out 12:00, then in 13:00 out 17:00. Your manager or HR approves it.'),
        rows, h('button', { class: 'btn', type: 'button', onclick: () => addRow({}) }, '+ Add a clock-in'), reason, send);
    });
  }

  function sheetCard() {
    const s = state.sheet;
    const t = s.totals;
    const today = state.today.today;
    const [y, m] = state.month.split('-').map(Number);
    const title = new Date(y, m - 1, 1).toLocaleDateString([], { month: 'long', year: 'numeric' });
    const move = (step) => {
      const [yy, mm] = state.month.split('-').map(Number);
      state.month = step === 0 ? new Date().toISOString().slice(0, 7) : new Date(Date.UTC(yy, mm - 1 + step, 1)).toISOString().slice(0, 7);
      load();
    };
    const days = s.days.filter((d) => d.status !== 'n/a' && !(['rest', 'holiday', 'upcoming'].includes(d.status) && !d.punches.length)).reverse();
    return h('div', {},
      h('div', { class: 'month-bar' }, h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Previous month', onclick: () => move(-1) }, '‹'),
        h('strong', {}, title), h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Next month', onclick: () => move(1) }, '›'),
        h('button', { class: 'btn small', type: 'button', onclick: () => move(0) }, 'Today')),
      h('div', { class: 'stats' }, [['Present', `${t.presentDays}/${t.scheduledDays}`], ['Absent', t.absentDays], ['Late', `${t.lateMinutes}m`], ['Hours', t.workedHours], ['Overtime', `${t.overtimeHours}h`]]
        .map(([label, value]) => h('div', { class: 'stat' }, h('strong', {}, String(value)), h('span', {}, label)))),
      days.length ? h('div', { class: 'list' }, days.map((d) => {
        const [label, kind] = STATUS[d.status] || ['', ''];
        const extras = [d.lateMinutes ? `${d.lateMinutes}m late` : '', d.overBreakMinutes ? `${d.overBreakMinutes}m over break` : '', d.undertimeMinutes ? `${d.undertimeMinutes}m short` : '',
          d.overtimeMinutes ? `${hoursText(d.overtimeMinutes)}h overtime` : '', hoursText(d.workedMinutes) ? `${hoursText(d.workedMinutes)}h worked` : ''].filter(Boolean).join(' · ');
        const clickable = d.date < today;
        return h('button', { class: 'row', type: 'button', disabled: !clickable, onclick: () => openCorrection(d) },
          h('div', { class: 'row-main' }, h('strong', {}, dayLabel(d.date)), h('div', { class: 'muted' }, punchLine(d.punches) || (label || '')), extras ? h('div', { class: 'muted small' }, extras) : null),
          h('div', {}, label ? chip(label, kind) : null, d.source === 'correction' ? chip('Corrected') : null));
      })) : emptyState('Nothing to show for this month yet.'),
      h('p', { class: 'muted small' }, 'Tap a past day to ask for a correction.'));
  }

  function requestsCard() {
    if (!state.mine.length) return null;
    return h('div', {}, h('h3', {}, 'My correction requests'), h('div', { class: 'list' }, state.mine.map((c) => {
      const [label, kind] = CORRECTION[c.status];
      return h('div', { class: 'row static' },
        h('div', { class: 'row-main' }, h('strong', {}, dayLabel(c.date)), h('div', { class: 'muted' }, c.punches.map((p) => `${p.in}–${p.out || '…'}`).join(' · ')),
          h('div', { class: 'muted small' }, c.reason), c.decisionNote ? h('div', { class: 'muted small' }, `“${c.decisionNote}”`) : null),
        h('div', {}, chip(label, kind), c.status === 'pending' ? h('button', { class: 'btn small', type: 'button', onclick: async () => { try { await call(`/api/attendance/corrections/${c.id}/cancel`, { method: 'POST', body: {} }); await load(); } catch (err) { toast(err.message, 'error'); } } }, 'Cancel') : null));
    })));
  }

  function queueCard() {
    if (!state.queue.length) return null;
    return h('div', {}, h('h3', {}, `Corrections to approve (${state.queue.length})`), h('div', { class: 'list' }, state.queue.map((c) => h('div', { class: 'card' },
      h('strong', {}, personName(c)), h('div', { class: 'muted' }, dayLabel(c.date)),
      h('div', {}, `Asks for: ${c.punches.map((p) => `${p.in}–${p.out || '…'}`).join(' · ')}`), h('p', { class: 'muted' }, c.reason),
      h('div', { class: 'row-actions' },
        h('button', { class: 'btn primary', type: 'button', onclick: async (e) => { await busy(e.target, async () => { await call(`/api/attendance/corrections/${c.id}/decision`, { method: 'PUT', body: { status: 'approved' } }); toast('Approved.', 'success'); await load(); }); } }, 'Approve'),
        h('button', { class: 'btn', type: 'button', onclick: async () => {
          const note = await askText('Why are you declining? (optional)');
          if (note === null) return;
          try { await call(`/api/attendance/corrections/${c.id}/decision`, { method: 'PUT', body: { status: 'rejected', note } }); toast('Declined.', 'success'); await load(); } catch (err) { toast(err.message, 'error'); }
        } }, 'Decline'))))));
  }

  function paint() {
    clear(page);
    if (state.error) { page.append(emptyState('Attendance is not available', state.error)); return; }
    put(page, clockCard(), queueCard(), sheetCard(), requestsCard());
  }

  const off = on('attendance_updated', () => load());
  await load();
  return () => off();
}
