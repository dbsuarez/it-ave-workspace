// Drawings: what a drawing may contain, and how shapes from several people are merged.
//
// The merge rule is Excalidraw's own: every shape carries a `version` (raised on each change) and a random `versionNonce`.
// When two copies of one shape meet, the higher version wins; on equal versions the lower nonce wins; identical copies change
// nothing. A deleted shape stays in the list (`isDeleted: true`) so the deletion reaches everyone. No shape is ever dropped.
// Pure functions with no dependencies, so they are cheap to test thoroughly.

const MAX_ELEMENTS = 20000; // shapes in one drawing
const MAX_SCENE_BYTES = 10 * 1024 * 1024; // the saved scene as JSON
const MAX_IMAGE_BYTES = 2 * 1024 * 1024; // one inserted image
const MAX_DRAWING_FILE_BYTES = 20 * 1024 * 1024; // all images of one drawing
const MAX_ID_LENGTH = 64;

const fail = (message) => Object.assign(new Error(message), { status: 400 });

// Returns the list if every shape is well formed; otherwise throws an error with status 400.
function validateElements(list) {
  if (!Array.isArray(list)) throw fail('A drawing is a list of shapes');
  if (list.length > MAX_ELEMENTS) throw fail(`Too many shapes: a drawing can hold at most ${MAX_ELEMENTS}`);
  for (const shape of list) {
    if (!shape || typeof shape !== 'object' || Array.isArray(shape)) throw fail('Every shape must be an object');
    if (typeof shape.id !== 'string' || !shape.id || shape.id.length > MAX_ID_LENGTH) throw fail('Every shape needs an id of 1 to 64 characters');
    if (!Number.isInteger(shape.version) || shape.version < 0) throw fail('Every shape needs a whole-number version of 0 or more');
    if (!Number.isInteger(shape.versionNonce)) throw fail('Every shape needs a whole-number versionNonce');
    if (typeof shape.type !== 'string' || !shape.type || shape.type.length > 40) throw fail('Every shape needs a type');
    if (shape.isDeleted !== undefined && typeof shape.isDeleted !== 'boolean') throw fail('isDeleted must be true or false');
  }
  return list;
}

// The small set of view settings that are kept with a drawing; anything else is dropped.
function cleanAppState(appState) {
  const kept = {};
  if (appState === undefined || appState === null) return kept;
  if (typeof appState !== 'object' || Array.isArray(appState)) throw fail('appState must be an object');
  if (appState.viewBackgroundColor !== undefined) {
    if (typeof appState.viewBackgroundColor !== 'string' || appState.viewBackgroundColor.length > 40) throw fail('viewBackgroundColor must be a short text');
    kept.viewBackgroundColor = appState.viewBackgroundColor;
  }
  if (appState.gridSize !== undefined && appState.gridSize !== null) {
    if (!Number.isInteger(appState.gridSize) || appState.gridSize < 1 || appState.gridSize > 200) throw fail('gridSize must be a whole number from 1 to 200');
    kept.gridSize = appState.gridSize;
  }
  return kept;
}

// -> { elements, appState } cleaned; throws status 400 for anything not allowed, including a scene over 10 MB.
function validateScene(scene) {
  if (!scene || typeof scene !== 'object' || Array.isArray(scene)) throw fail('A drawing needs a scene');
  const elements = validateElements(scene.elements === undefined ? [] : scene.elements);
  const cleaned = { elements, appState: cleanAppState(scene.appState) };
  if (Buffer.byteLength(JSON.stringify(cleaned)) > MAX_SCENE_BYTES) throw fail('This drawing is too large to save (the limit is 10 MB)');
  return cleaned;
}

// Does `incoming` replace `current`? (Excalidraw's reconcile rule)
function incomingWins(current, incoming) {
  if (incoming.version !== current.version) return incoming.version > current.version;
  if (incoming.versionNonce !== current.versionNonce) return incoming.versionNonce < current.versionNonce;
  // Same version and nonce means the same change in practice (the nonce is random). If the content still differs, the smaller
  // text wins, so every server and client picks the same copy whatever order the updates arrive in.
  const a = JSON.stringify(incoming);
  const b = JSON.stringify(current);
  return a !== b && a < b;
}

// Merges `incoming` shapes into `current`. -> { elements: the merged list (existing order kept, new shapes at the end),
// changed: the incoming shapes that won }. Neither argument is modified.
function mergeElements(current, incoming) {
  const elements = [...current];
  const position = new Map(elements.map((shape, index) => [shape.id, index]));
  const changed = [];
  for (const shape of incoming) {
    if (!position.has(shape.id)) {
      position.set(shape.id, elements.length);
      elements.push(shape);
      changed.push(shape);
    } else if (incomingWins(elements[position.get(shape.id)], shape)) {
      elements[position.get(shape.id)] = shape;
      changed.push(shape);
    }
  }
  return { elements, changed };
}

module.exports = {
  MAX_ELEMENTS, MAX_SCENE_BYTES, MAX_IMAGE_BYTES, MAX_DRAWING_FILE_BYTES, MAX_ID_LENGTH,
  validateElements, validateScene, mergeElements,
};
