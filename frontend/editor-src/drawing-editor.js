// The drawing editor: Excalidraw (React) behind a small, framework-free handle. Bundled by scripts/build-drawing.js into
// src/vendor/drawing-editor.js (global ITADrawing). The rest of the app never touches React or Excalidraw directly.
//
//   const handle = ITADrawing.mount(element, { initialElements, initialFiles, viewOnly, userName, onChange, onPointer, onReady });
//   handle.getElements()  handle.getFiles()  handle.exportPng()  handle.exportSvg()
//   handle.updateElements(remoteElements)  handle.setCollaborators(list)  handle.setViewOnly(bool)  handle.destroy()
import React from 'react';
import { createRoot } from 'react-dom/client';
import {
  Excalidraw, exportToBlob, exportToSvg, reconcileElements, restoreElements,
} from '@excalidraw/excalidraw';

function mount(element, options = {}) {
  const root = createRoot(element);
  let api = null;
  let viewOnly = Boolean(options.viewOnly);
  let collaborators = new Map();

  const render = () => {
    root.render(React.createElement(Excalidraw, {
      excalidrawAPI: (instance) => { api = instance; if (options.onReady) options.onReady(); },
      initialData: {
        elements: restoreElements(options.initialElements || [], null),
        files: options.initialFiles || {},
        scrollToContent: true,
      },
      viewModeEnabled: viewOnly,
      isCollaborating: collaborators.size > 0,
      aiEnabled: false, // no text-to-diagram service
      validateEmbeddable: false, // no embedded web pages
      langCode: 'en',
      name: options.title || 'Drawing',
      UIOptions: { canvasActions: { loadScene: false, saveToActiveFile: false, export: false, saveAsImage: false } },
      onChange: (elements, appState, files) => { if (options.onChange) options.onChange(elements, files); },
      onPointerUpdate: (pointer) => { if (options.onPointer) options.onPointer(pointer); },
    }));
  };
  render();

  const need = () => { if (!api) throw new Error('The drawing editor is not ready yet'); return api; };

  return {
    getElements: () => need().getSceneElementsIncludingDeleted(),
    getFiles: () => need().getFiles(),
    exportPng: () => exportToBlob({
      elements: need().getSceneElements(), appState: { ...need().getAppState(), exportBackground: true }, files: need().getFiles(), mimeType: 'image/png',
    }),
    exportSvg: async () => {
      const svg = await exportToSvg({ elements: need().getSceneElements(), appState: { ...need().getAppState(), exportBackground: true }, files: need().getFiles() });
      return new XMLSerializer().serializeToString(svg);
    },
    // merges shapes from other people into the open drawing with Excalidraw's own rule (higher version wins)
    updateElements: (remote) => {
      const merged = reconcileElements(need().getSceneElementsIncludingDeleted(), restoreElements(remote, null), need().getAppState());
      need().updateScene({ elements: merged, captureUpdate: 'NEVER' });
    },
    setCollaborators: (list) => {
      collaborators = new Map(list.map((person) => [String(person.id), { pointer: person.pointer, username: person.username, color: { background: person.color, stroke: person.color }, selectedElementIds: person.selectedElementIds || {} }]));
      if (api) api.updateScene({ collaborators });
    },
    setViewOnly: (value) => { viewOnly = Boolean(value); render(); },
    destroy: () => { root.unmount(); api = null; },
  };
}

export { mount };
