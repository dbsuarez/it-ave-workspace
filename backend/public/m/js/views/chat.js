// Chat: channels, direct messages and group conversations. Read, send, and see new messages as they arrive.
// Photos and files in a message show up; sending them from the phone, calls, canvases and lists are in the desktop app.
import { call, blobUrl } from '../api.js';
import { h, clear, put, avatar, emptyState, toast, icon } from '../ui.js';
import { personName, whenLabel, groupMessages } from '../format.js';
import { on, emit } from '../socket.js';

export async function render(root, parts, ctx) {
  if (parts[0] === 'c' || parts[0] === 'd' || parts[0] === 'g') return renderConversation(root, parts[0], Number(parts[1]), ctx);
  return renderList(root, ctx);
}

// ---- the list ----

async function renderList(root, ctx) {
  const page = h('div', { class: 'page' });
  const search = h('input', { class: 'input', type: 'search', placeholder: 'Search channels and people', 'aria-label': 'Search' });
  const body = h('div', {});
  page.append(search, body);
  root.append(page);
  let channels = [];
  let people = [];
  let groups = [];
  const load = async () => {
    [channels, people, groups] = await Promise.all([
      call('/api/channels/my').then((r) => r.channels).catch(() => []),
      call('/api/users').then((r) => r.users).catch(() => []),
      call('/api/conversations').then((r) => r.conversations).catch(() => []),
    ]);
    ctx.setBadge('chat', channels.reduce((sum, c) => sum + (c.unreadCount || 0), 0));
    paint();
  };
  const section = (title, rows) => (rows.length ? h('div', {}, h('h3', {}, title), h('div', { class: 'list' }, rows)) : null);
  const paint = () => {
    const q = search.value.trim().toLowerCase();
    const match = (...values) => !q || values.some((v) => String(v || '').toLowerCase().includes(q));
    const myId = ctx.user && ctx.user.id;
    put(clear(body),
      section('Channels', channels.filter((c) => match(c.name, c.topic)).map((c) => h('a', { class: 'row', href: `#/chat/c/${c.id}` },
        h('span', { class: 'hash' }, c.isPrivate ? '🔒' : '#'), h('div', { class: 'row-main' }, h('strong', {}, c.name), c.topic ? h('div', { class: 'muted small' }, c.topic) : null),
        c.unreadCount ? h('span', { class: 'badge' }, String(c.unreadCount)) : null))),
      section('Groups', groups.filter((g) => match(groupTitle(g, myId))).map((g) => h('a', { class: 'row', href: `#/chat/g/${g.id}` },
        h('span', { class: 'hash' }, '👥'), h('div', { class: 'row-main' }, h('strong', {}, groupTitle(g, myId))), g.unreadCount ? h('span', { class: 'badge' }, String(g.unreadCount)) : null))),
      section('Direct messages', people.filter((u) => match(u.username, personName(u))).map((u) => h('a', { class: 'row', href: `#/chat/d/${u.id}` },
        avatar(u, 40), h('div', { class: 'row-main' }, h('strong', {}, personName(u)), h('div', { class: 'muted small' }, u.statusText || (u.status === 'online' ? 'Online' : ''))),
        u.status === 'online' ? h('span', { class: 'online' }) : null))));
    if (!body.children.length) body.append(emptyState('Nothing matches', 'Try a different search.'));
  };
  search.addEventListener('input', paint);
  await load();
  const offs = ['channel_activity', 'new_direct_message', 'new_group_message'].map((event) => on(event, () => load()));
  return () => offs.forEach((off) => off());
}

function groupTitle(group, myId) {
  if (group.name) return group.name;
  return (group.members || []).filter((m) => Number(m.id) !== Number(myId)).map((m) => m.username).join(', ') || 'Group';
}

// ---- one conversation ----

async function renderConversation(root, kind, id, ctx) {
  ctx.setBack(() => ctx.go('chat'));
  const me = ctx.user;
  const page = h('div', { class: 'convo' });
  const scroller = h('div', { class: 'messages' });
  const input = h('textarea', { class: 'input composer-input', rows: 1, placeholder: 'Message', 'aria-label': 'Message' });
  const sendButton = h('button', { class: 'btn primary send-btn', type: 'button', 'aria-label': 'Send' }, icon('send'));
  const privateResponses = h('div', { class: 'command-private-responses', 'aria-live': 'polite' });
  const commandMenu = h('div', { class: 'command-menu', hidden: true, role: 'listbox', 'aria-label': 'Available commands' });
  put(page, scroller, privateResponses, commandMenu, h('div', { class: 'composer' }, input, sendButton));
  root.append(page);

  let messages = [];
  let title = '';
  let canSend = true;
  const pending = new Map(); // clientMessageId -> element
  let commands = [];
  let commandIndex = 0;

  try {
    if (kind === 'c') {
      const info = (await call('/api/channels/my')).channels.find((c) => Number(c.id) === id);
      title = info ? `#${info.name}` : 'Channel';
      messages = (await call(`/api/messages/${id}?limit=60`)).messages.map((m) => ({ id: m.id, senderId: m.userId, name: m.username, color: m.avatarColor, content: m.content, createdAt: m.createdAt, attachments: m.attachments || [], reply: m.replyToMessage }));
      emit('join_channel', id);
      call(`/api/channels/${id}/read`, { method: 'POST' }).catch(() => {});
    } else if (kind === 'd') {
      const person = await call(`/api/people/${id}`).then((r) => r.person)
        .catch(() => call(`/api/users/${id}`).then((r) => r.user || r)).catch(() => ({ username: 'Direct message' }));
      title = personName(person);
      messages = (await call(`/api/users/${id}/direct-messages?limit=60`)).messages.map((m) => ({ id: m.id, senderId: m.senderId, name: m.senderUsername, color: m.senderAvatarColor, content: m.content, createdAt: m.createdAt, attachments: m.attachments || [] }));
    } else {
      const group = (await call('/api/conversations')).conversations.find((g) => Number(g.id) === id);
      title = group ? groupTitle(group, me && me.id) : 'Group';
      messages = (await call(`/api/conversations/${id}/messages?limit=100`)).messages.map((m) => ({ id: m.id, senderId: m.senderId, name: m.senderUsername, color: m.senderAvatarColor, content: m.content, createdAt: m.createdAt, attachments: [] }));
      call(`/api/conversations/${id}/read`, { method: 'POST' }).catch(() => {});
    }
  } catch (err) {
    clear(scroller).append(emptyState('Could not open this conversation', err.message));
    canSend = false;
  }
  ctx.setTitle(title || 'Chat');

  function attachmentEl(file) {
    if (/^image\//.test(file.mimeType || '')) {
      const img = h('img', { class: 'attach-img', alt: file.filename || 'Picture' });
      blobUrl(`/api/files/${file.id}/download`).then((url) => { if (url) img.src = url; });
      return img;
    }
    return h('a', { class: 'attach-file', href: '#', onclick: async (e) => {
      e.preventDefault();
      const url = await blobUrl(`/api/files/${file.id}/download`);
      if (url) { const a = document.createElement('a'); a.href = url; a.download = file.filename || 'file'; a.click(); } else toast('Could not open the file.', 'error');
    } }, `📎 ${file.filename || 'File'}`);
  }

  function paint() {
    clear(scroller);
    if (!messages.length && canSend) { scroller.append(emptyState('No messages yet', 'Say hello.')); return; }
    for (const group of groupMessages(messages, (m) => m.senderId, (m) => m.createdAt)) {
      const mine = me && Number(group.sender) === Number(me.id);
      const first = group.items[0];
      scroller.append(h('div', { class: `msg-group ${mine ? 'mine' : 'theirs'}` },
        mine ? null : avatar({ id: first.senderId, username: first.name, avatarColor: first.color }, 32),
        h('div', { class: 'msg-col' },
          mine ? null : h('div', { class: 'msg-name' }, first.name),
          group.items.map((m) => h('div', { class: 'bubble' },
            m.reply ? h('div', { class: 'reply' }, `${m.reply.username}: ${m.reply.content}`) : null,
            m.content ? h('div', { class: 'pre' }, m.content) : null,
            (m.attachments || []).map(attachmentEl))),
          h('div', { class: 'msg-time' }, whenLabel(group.items[group.items.length - 1].createdAt)))));
    }
    scroller.scrollTop = scroller.scrollHeight;
  }
  paint();

  function add(message) {
    if (messages.some((m) => m.id === message.id)) return;
    // our own message coming back replaces its "sending" placeholder
    if (message.clientMessageId && pending.has(message.clientMessageId)) { pending.get(message.clientMessageId).remove(); pending.delete(message.clientMessageId); }
    else if (me && Number(message.senderId) === Number(me.id)) { const first = pending.keys().next().value; if (first) { pending.get(first).remove(); pending.delete(first); } }
    messages.push(message);
    paint();
  }

  function hideCommandMenu() { commandMenu.hidden = true; clear(commandMenu); commandIndex = 0; }

  async function loadCommands() {
    if (kind !== 'c' || commands.length) return;
    commands = await call(`/api/commands?channelId=${id}`).then((data) => data.commands || []).catch(() => []);
  }

  async function updateCommandMenu() {
    const value = input.value;
    if (kind !== 'c' || !value.startsWith('/') || value.startsWith('//') || /\s/.test(value)) { hideCommandMenu(); return; }
    await loadCommands();
    const prefix = value.slice(1).toLowerCase();
    const matches = commands.filter((item) => item.name.startsWith(prefix) || item.description.toLowerCase().includes(prefix));
    if (!matches.length) { hideCommandMenu(); return; }
    commandIndex = Math.min(commandIndex, matches.length - 1);
    put(clear(commandMenu), matches.map((item, index) => h('button', {
      class: `command-option${index === commandIndex ? ' active' : ''}`, type: 'button', role: 'option',
      'aria-selected': String(index === commandIndex), onclick: () => { input.value = `/${item.name} `; hideCommandMenu(); input.focus(); },
    }, h('strong', {}, `/${item.name}`), h('span', {}, item.description))));
    commandMenu.hidden = false;
  }

  function renderCommandResponse(response, commandText) {
    const data = response.data || {};
    const card = h('section', { class: 'command-private-card' },
      h('div', { class: 'command-private-head' }, h('strong', {}, 'HR Assistant'), h('span', { class: 'command-private-label' }, 'Only visible to you'),
        h('button', { class: 'command-dismiss', type: 'button', 'aria-label': 'Dismiss', onclick: () => card.remove() }, '×')),
      h('div', { class: 'muted small' }, `You: ${commandText}`), h('h3', {}, response.title || 'HR response'),
      response.period ? h('div', { class: 'muted small' }, `Period: ${response.period}`) : null,
      data.message ? h('p', {}, data.message) : null,
      ...(data.leaveTypes || []).map((row) => h('div', { class: 'command-balance' }, h('strong', {}, row.name),
        h('span', {}, row.remaining === null ? `${row.used} days used · no limit` : `${row.remaining} available · ${row.used} used · ${row.pending} pending`))),
      ...(data.requests || []).map((row) => h('div', { class: 'command-record' }, h('strong', {}, row.typeName),
        h('span', {}, `${row.startDate}${row.endDate !== row.startDate ? ` – ${row.endDate}` : ''} · ${row.days} day${Number(row.days) === 1 ? '' : 's'} · ${row.status}`))),
      ...(data.commands || []).map((row) => h('div', { class: 'command-record' }, h('strong', {}, `/${row.name}`), h('span', {}, row.description))),
      data.note ? h('p', { class: 'muted small' }, data.note) : null,
      (response.actions || []).some((action) => action.type === 'open-route' && action.route === 'leave')
        ? h('a', { class: 'btn', href: '#/leave' }, 'Open Leave') : null,
      ...((response.actions || []).filter((action) => action.type === 'cancel-leave' && Number.isSafeInteger(Number(action.requestId))).map((action) =>
        h('button', { class: 'btn bad', type: 'button', onclick: async () => {
          if (!confirm('Cancel this leave request?')) return;
          try { await call(`/api/leave/requests/${Number(action.requestId)}/cancel`, { method: 'POST', body: {} }); card.remove(); toast('Leave request cancelled.', 'success'); }
          catch (err) { toast(err.message || 'Could not cancel the request.', 'error'); }
        } }, 'Cancel request'))));
    privateResponses.prepend(card);
  }

  async function executeCommand(commandText) {
    sendButton.disabled = true;
    hideCommandMenu();
    try {
      const response = await call('/api/commands/execute', { method: 'POST', body: { channelId: id, command: commandText, requestId: `m-${Date.now()}` } });
      input.value = '';
      renderCommandResponse(response, commandText);
    } catch (err) { toast(err.message || 'Could not run that command.', 'error'); }
    finally { sendButton.disabled = false; input.focus(); }
  }

  async function send() {
    let content = input.value.trim();
    if (!content || !canSend) return;
    if (kind === 'c' && content.startsWith('/') && !content.startsWith('//')) { await executeCommand(content); return; }
    if (content.startsWith('//')) content = content.slice(1);
    const clientMessageId = `m-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    if (kind === 'c') emit('send_message', { channelId: id, content, clientMessageId });
    else if (kind === 'd') emit('send_direct_message', { receiverId: id, content, clientMessageId });
    else emit('send_group_message', { conversationId: id, content, clientMessageId });
    const bubble = h('div', { class: 'msg-group mine pending' }, h('div', { class: 'msg-col' }, h('div', { class: 'bubble' }, h('div', { class: 'pre' }, content)), h('div', { class: 'msg-time' }, 'Sending…')));
    pending.set(clientMessageId, bubble);
    scroller.append(bubble);
    scroller.scrollTop = scroller.scrollHeight;
    input.value = '';
    input.style.height = '';
    setTimeout(() => { if (pending.has(clientMessageId)) { bubble.querySelector('.msg-time').textContent = 'Not sent. Check your connection.'; bubble.classList.add('failed'); } }, 10000);
  }
  sendButton.addEventListener('click', send);
  input.addEventListener('keydown', (e) => {
    const options = [...commandMenu.querySelectorAll('.command-option')];
    if (!commandMenu.hidden && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault(); commandIndex = (commandIndex + (e.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length; updateCommandMenu(); return;
    }
    if (!commandMenu.hidden && e.key === 'Escape') { e.preventDefault(); hideCommandMenu(); return; }
    if (!commandMenu.hidden && e.key === 'Enter' && options.length) { e.preventDefault(); options[commandIndex].click(); return; }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && window.matchMedia('(hover: hover)').matches) { e.preventDefault(); send(); }
  });
  input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 120)}px`; updateCommandMenu(); });

  const offs = [
    on('new_message', (m) => { if (kind === 'c' && Number(m.channelId) === id) { add({ id: m.id, senderId: m.userId, name: m.username, color: m.avatarColor, content: m.content, createdAt: m.createdAt, attachments: m.attachments || [], reply: m.replyToMessage, clientMessageId: m.clientMessageId }); call(`/api/channels/${id}/read`, { method: 'POST' }).catch(() => {}); } }),
    on('new_direct_message', (m) => { if (kind === 'd' && (Number(m.senderId) === id || Number(m.receiverId) === id)) add({ id: m.id, senderId: m.senderId, name: m.senderUsername, color: m.senderAvatarColor, content: m.content, createdAt: m.createdAt, attachments: m.attachments || [], clientMessageId: m.clientMessageId }); }),
    on('new_group_message', (m) => { if (kind === 'g' && Number(m.conversationId) === id) add({ id: m.id, senderId: m.senderId, name: m.senderUsername, color: m.senderAvatarColor, content: m.content, createdAt: m.createdAt, attachments: [], clientMessageId: m.clientMessageId }); }),
    on('message_error', ({ error }) => toast(error || 'Message could not be sent.', 'error')),
  ];
  return () => {
    offs.forEach((off) => off());
    if (kind === 'c') emit('leave_channel', id);
    ctx.setBack(null);
    ctx.refreshBadges();
  };
}
