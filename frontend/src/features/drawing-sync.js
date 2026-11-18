// IT Avenue Workspace - drawings: what to send to the server after working offline, how shapes merge, and the status line.
//
// Pure functions. The rule is Excalidraw's: every shape has a `version` and a random `versionNonce`; of two copies of a shape the
// higher version wins, on a tie the lower nonce wins, and a deleted shape is kept (isDeleted: true) so the deletion spreads.
// The live editor merges with Excalidraw's own reconcileElements; these functions plan what to send and are tested without a page.

// Does shape `a` win against shape `b`?
function drawingShapeWins(a, b) {
  if (a.version !== b.version) return a.version > b.version;
  if (a.versionNonce !== b.versionNonce) return a.versionNonce < b.versionNonce;
  return false;
}

// The local shapes the server should receive: ones it does not have, or where ours wins.
function elementsToSend(local, server) {
  const known = new Map(server.map((shape) => [shape.id, shape]));
  return local.filter((shape) => !known.has(shape.id) || drawingShapeWins(shape, known.get(shape.id)));
}

// Merges two copies of a drawing. The order of `a` is kept; shapes only in `b` go at the end. Neither list is modified.
function mergeElementsLocal(a, b) {
  const merged = [...a];
  const position = new Map(merged.map((shape, index) => [shape.id, index]));
  for (const shape of b) {
    if (!position.has(shape.id)) { position.set(shape.id, merged.length); merged.push(shape); }
    else if (drawingShapeWins(shape, merged[position.get(shape.id)])) merged[position.get(shape.id)] = shape;
  }
  return merged;
}

// Cuts shapes into batches whose JSON stays under maxBytes (the server refuses a bigger single update). Order is kept and a
// shape larger than the cap goes alone.
function chunkElements(shapes, maxBytes) {
  const batches = [];
  let batch = [];
  let size = 2; // the brackets
  for (const shape of shapes) {
    const length = JSON.stringify(shape).length + 1;
    if (batch.length && size + length > maxBytes) { batches.push(batch); batch = []; size = 2; }
    batch.push(shape);
    size += length;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

// 'saved' | 'saving' | 'offline' | 'cannot-sync'. Losing access beats everything; offline beats "saving".
function syncStatus({ online, dirty, saving, denied }) {
  if (denied) return 'cannot-sync';
  if (!online) return 'offline';
  return dirty || saving ? 'saving' : 'saved';
}

function syncStatusText(status) {
  return { saved: 'Saved', saving: 'Saving...', offline: 'Offline: will sync', 'cannot-sync': 'Cannot sync' }[status] || '';
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { elementsToSend, mergeElementsLocal, chunkElements, syncStatus, syncStatusText, drawingShapeWins };
}
