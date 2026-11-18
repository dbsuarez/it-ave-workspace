// IT Avenue Workspace - drawings: saving a drawing to a .excalidraw file and reading one back.
//
// A .excalidraw file is plain JSON ({ type: "excalidraw", version: 2, elements, appState, files }); it opens in excalidraw.com and
// in any other Excalidraw, and files from those open here. Pure functions: nothing here touches the page or the network.

const DRAWING_FILE_MAX_BYTES = 20 * 1024 * 1024;
const NOT_A_DRAWING_FILE = 'That is not a drawing file. Choose a .excalidraw file.';

function drawingFileJson(elements, files) {
  const shapes = (elements || []).filter((shape) => shape && !shape.isDeleted);
  const used = new Set(shapes.map((shape) => shape.fileId).filter(Boolean));
  const pictures = {};
  for (const [key, picture] of Object.entries(files || {})) if (used.has(key)) pictures[key] = picture;
  return JSON.stringify({ type: 'excalidraw', version: 2, source: 'IT Avenue Workspace', elements: shapes, appState: { viewBackgroundColor: '#ffffff' }, files: pictures }, null, 2);
}

// Returns { elements, files } or throws an Error whose message can be shown to the person as it is.
function parseDrawingFile(text) {
  if (typeof text === 'string' && text.length > DRAWING_FILE_MAX_BYTES) throw new Error('That file is too large to open (the limit is 20 MB).');
  if (typeof text !== 'string' || !text.trim()) throw new Error(NOT_A_DRAWING_FILE);
  let data;
  try { data = JSON.parse(text); } catch (err) { throw new Error(NOT_A_DRAWING_FILE); }
  if (!data || data.type !== 'excalidraw' || !Array.isArray(data.elements)) throw new Error(NOT_A_DRAWING_FILE);
  const elements = data.elements.filter((shape) => shape && typeof shape === 'object' && shape.id && shape.type && !shape.isDeleted);
  if (!elements.length) throw new Error('There is nothing in it to open.');
  const files = data.files && typeof data.files === 'object' && !Array.isArray(data.files) ? data.files : {};
  return { elements, files };
}

function drawingFileBaseName(title) {
  const base = String(title || '').replace(/\.excalidraw$/i, '').replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80);
  return base || 'drawing';
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { drawingFileJson, parseDrawingFile, drawingFileBaseName, DRAWING_FILE_MAX_BYTES };
}
