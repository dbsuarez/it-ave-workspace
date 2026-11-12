// People: search the directory, open someone's page (call, email, message), and see who they report to.
import { call } from '../api.js';
import { h, clear, put, avatar, emptyState } from '../ui.js';
import { personName } from '../format.js';

export async function render(root, parts, ctx) {
  if (parts[0]) return renderPerson(root, Number(parts[0]), ctx);
  const page = h('div', { class: 'page' });
  const search = h('input', { class: 'input', type: 'search', placeholder: 'Search name, title or department', 'aria-label': 'Search people' });
  const list = h('div', { class: 'list' });
  page.append(search, list);
  root.append(page);
  let everyone = [];
  try {
    everyone = (await call('/api/people')).people;
  } catch (err) {
    clear(list).append(emptyState('The directory is not available', err.message));
    return undefined;
  }
  const paint = () => {
    const q = search.value.trim().toLowerCase();
    const shown = everyone.filter((p) => !q || [p.username, personName(p), p.jobTitle, p.department].some((v) => String(v || '').toLowerCase().includes(q)))
      .sort((a, b) => personName(a).localeCompare(personName(b), undefined, { sensitivity: 'base' }));
    clear(list);
    if (!shown.length) { list.append(emptyState('No one matches', 'Try a different search.')); return; }
    shown.forEach((p) => list.append(h('a', { class: 'row', href: `#/people/${p.id}` }, avatar(p, 44),
      h('div', { class: 'row-main' }, h('strong', {}, personName(p)), h('div', { class: 'muted' }, [p.jobTitle, p.department].filter(Boolean).join(' · ') || `@${p.username}`)))));
  };
  search.addEventListener('input', paint);
  paint();
  return undefined;
}

async function renderPerson(root, id, ctx) {
  ctx.setBack(() => ctx.go('people'));
  const page = h('div', { class: 'page' });
  root.append(page);
  let data;
  try {
    data = await call(`/api/people/${id}`);
  } catch (err) {
    page.append(emptyState('Could not open this page', err.message));
    return undefined;
  }
  const p = data.person;
  ctx.setTitle(personName(p));
  const mine = ctx.user && Number(ctx.user.id) === Number(p.id);
  const link = (label, value, href) => (value ? h('div', { class: 'kv' }, h('span', {}, label), href ? h('a', { href }, value) : h('strong', {}, value)) : null);
  const miniList = (title, people) => (people.length ? h('div', {}, h('h3', {}, title), h('div', { class: 'list' }, people.map((x) => h('a', { class: 'row', href: `#/people/${x.id}` }, avatar(x, 36), h('div', { class: 'row-main' }, h('strong', {}, personName(x)), h('div', { class: 'muted' }, x.jobTitle || ''))))) ) : null);
  put(page,
    h('div', { class: 'card profile-head' }, avatar(p, 72), h('div', {}, h('strong', { class: 'big' }, personName(p)), h('div', { class: 'muted' }, p.jobTitle || ''), h('div', { class: 'muted' }, [p.department, p.location].filter(Boolean).join(' · ')))),
    mine ? null : h('div', { class: 'row-actions' }, h('button', { class: 'btn primary', type: 'button', onclick: () => ctx.go(`chat/d/${p.id}`) }, 'Message'),
      p.phone ? h('a', { class: 'btn', href: `tel:${p.phone}` }, 'Call') : null),
    p.about ? h('div', { class: 'card' }, h('h3', {}, 'About'), h('p', { class: 'pre' }, p.about)) : null,
    h('div', { class: 'card' }, h('h3', {}, 'Contact'), link('Email', p.email, p.email ? `mailto:${p.email}` : ''), link('Phone', p.phone, p.phone ? `tel:${p.phone}` : ''), link('Username', `@${p.username}`)),
    ...(p.sections || []).map((s) => h('div', { class: 'card' }, h('h3', {}, s.title), h('p', { class: 'pre' }, s.body))),
    data.manager ? miniList('Reports to', [data.manager]) : null,
    miniList('Also reports to', data.secondaryManagers || []),
    miniList('Direct reports', data.reports || []));
  return () => ctx.setBack(null);
}
