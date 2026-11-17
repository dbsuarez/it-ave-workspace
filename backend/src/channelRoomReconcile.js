// Revalidate sockets before channel broadcasts and after membership policy changes.
// A failed authorization lookup must fail closed: never keep an unverified subscriber.
const { ensureChannelMembership } = require('./security');

async function reconcileChannelRoom(io, query, channelId, options = {}) {
  if (!io || !Number.isSafeInteger(Number(channelId)) || Number(channelId) <= 0) return { checked: 0, evicted: 0 };
  const room = `channel_${channelId}`;
  const sockets = await io.in(room).fetchSockets();
  let evicted = 0;
  for (const socket of sockets) {
    const userId = Number(socket.data?.watching || socket.data?.userId);
    let allowed = Number.isSafeInteger(userId) && userId > 0;
    if (allowed) {
      try { await ensureChannelMembership(query, userId, channelId); }
      catch (_error) { allowed = false; }
    }
    if (!allowed) {
      await socket.leave(room);
      socket.emit('channel_access_revoked', { channelId: Number(channelId) });
      evicted++;
    }
  }
  return { checked: sockets.length, evicted };
}

// One timer per Socket.IO server. Use an unref'ed interval so isolated tests
// and graceful shutdown are not held open by the sweep. Recheck joined rooms,
// rather than trusting the previously assigned socket room or a cached expiry.
const expirationSweepTimers = new WeakMap();
function startChannelExpirySweep(io, query, intervalMs = 30000) {
  if (!io || expirationSweepTimers.has(io)) return;
  const timer = setInterval(async () => {
    try {
      const result = await query(`SELECT DISTINCT channel_id FROM channel_direct_grants
        WHERE expires_at IS NOT NULL AND expires_at <= NOW()`);
      for (const row of result.rows) {
        await reconcileChannelRoom(io, query, row.channel_id);
      }
    } catch (err) {
      console.error('Channel expiration sweep failed:', err);
    }
  }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  expirationSweepTimers.set(io, timer);
}

module.exports = { reconcileChannelRoom, startChannelExpirySweep };
