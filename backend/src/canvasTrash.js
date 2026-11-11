// Removes deleted personal canvases (and their pictures) once they have been in the trash longer than
// CANVAS_TRASH_DAYS. Runs at startup and a few times a day; a canvas can be restored until then.
const fs = require('fs');
const path = require('path');
const config = require('./config');

async function purgeExpiredCanvases(query, { days = config.CANVAS_TRASH_DAYS, uploadDir = config.UPLOAD_DIR } = {}) {
  const expired = await query(
    `SELECT id FROM canvases
     WHERE kind = 'standalone' AND deleted_at IS NOT NULL
       AND deleted_at <= NOW() - ($1::int * INTERVAL '1 day')`,
    [days]
  );
  let removed = 0;
  for (const { id } of expired.rows) {
    const images = await query('SELECT filename FROM files WHERE canvas_id = $1', [id]);
    await query('DELETE FROM canvases WHERE id = $1', [id]); // comments, history, shares and image rows cascade
    for (const row of images.rows) {
      fs.promises.unlink(path.join(uploadDir, row.filename)).catch(() => {});
    }
    removed += 1;
  }
  return removed;
}

function schedulePurge(query, everyMs = 6 * 60 * 60 * 1000) {
  const run = () => purgeExpiredCanvases(query)
    .then((n) => { if (n) console.log(`Removed ${n} expired deleted canvas(es)`); })
    .catch((err) => console.error('Canvas purge failed:', err.message));
  run();
  const timer = setInterval(run, everyMs);
  if (timer.unref) timer.unref();
  return timer;
}

module.exports = { purgeExpiredCanvases, schedulePurge };
