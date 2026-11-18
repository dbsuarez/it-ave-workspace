// IT Avenue Workspace - drawings: the copy of each drawing kept on this computer.
//
// Every drawing that is opened or made is saved here as it is drawn, so losing the network never loses work and a drawing can be
// made with no connection at all. A record is { id, title, kind, channelId, topicId, elements, files, lastRevision, dirty, updatedAt }
// where `dirty` means there are changes the server has not confirmed. Ids are text here: a server id ("42") or a draft made
// offline ("local-..."), which is renamed to the real id when the server creates the drawing.
//
//   const store = createDrawingStore(indexedDbDrawingBackend());      // the app
//   const store = createDrawingStore(memoryDrawingBackend());         // tests

function drawingClone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function memoryDrawingBackend() {
  const records = new Map();
  return {
    async get(id) { return drawingClone(records.get(id)); },
    async put(id, record) { records.set(id, drawingClone(record)); },
    async delete(id) { records.delete(id); },
    async list() { return [...records.values()].map(drawingClone); },
  };
}

function indexedDbDrawingBackend(name = 'ita-drawings') {
  let opened = null;
  const open = () => {
    if (!opened) {
      opened = new Promise((resolve, reject) => {
        const request = indexedDB.open(name, 1);
        request.onupgradeneeded = () => request.result.createObjectStore('drawings', { keyPath: 'id' });
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }
    return opened;
  };
  const run = async (mode, action) => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('drawings', mode);
      const request = action(transaction.objectStore('drawings'));
      transaction.oncomplete = () => resolve(request ? request.result : undefined);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  };
  return {
    get: (id) => run('readonly', (store) => store.get(id)),
    put: (id, record) => run('readwrite', (store) => store.put(record)),
    delete: (id) => run('readwrite', (store) => store.delete(id)),
    list: () => run('readonly', (store) => store.getAll()),
  };
}

function createDrawingStore(backend) {
  const key = (id) => String(id);
  return {
    async save(id, record) {
      const full = { ...drawingClone(record), id: key(id), updatedAt: Date.now() };
      await backend.put(full.id, full);
      return full;
    },
    load: (id) => backend.get(key(id)),
    list: () => backend.list(),
    remove: (id) => backend.delete(key(id)),
    // a draft made offline becomes the real drawing (the server has created it)
    async rename(oldId, newId) {
      const record = await backend.get(key(oldId));
      if (!record) return;
      await backend.put(key(newId), { ...record, id: key(newId) });
      await backend.delete(key(oldId));
    },
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { createDrawingStore, memoryDrawingBackend, indexedDbDrawingBackend };
}
