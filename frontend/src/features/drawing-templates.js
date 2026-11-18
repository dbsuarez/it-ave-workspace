// IT Avenue Workspace - drawings: a gallery of ready-made examples inside Excalidraw's "Mermaid to Excalidraw" dialog.
//
// The dialog belongs to Excalidraw (it is not ours to change), so this adds a row of template buttons to it when it opens.
// Choosing one fills the Mermaid box and the preview updates; the text you had typed before is kept and can be put back.
// The editor turns three kinds of Mermaid diagram into shapes you can edit (flowchart, sequence, class), so those are the ones
// shown. The functions here are pure or take their dependencies as arguments; installMermaidTemplates() is the only part that
// touches the page.

const DRAWING_MERMAID_TEMPLATES = [
  {
    id: 'flow-steps', kind: 'Flowchart', name: 'Steps in order', hint: 'A process from start to finish, left to right',
    code: 'flowchart LR\n  A[Start] --> B[Do the work]\n  B --> C[Review]\n  C --> D[Done]',
  },
  {
    id: 'flow-decision', kind: 'Flowchart', name: 'Decision', hint: 'A question with a yes and a no path, like a ticket triage',
    code: 'flowchart TD\n  A[Ticket received] --> B{Urgent?}\n  B -->|Yes| C[Escalate to on-call]\n  B -->|No| D[Add to the queue]\n  C --> E[Resolve]\n  D --> E\n  E --> F[Close the ticket]',
  },
  {
    id: 'flow-network', kind: 'Flowchart', name: 'Network layout', hint: 'How equipment connects, from the internet down to the devices',
    code: 'flowchart TD\n  I((Internet)) --> F[Firewall]\n  F --> S[Core switch]\n  S --> W[Wi-Fi access points]\n  S --> V[Servers]\n  S --> P[Printers]',
  },
  {
    id: 'seq-request', kind: 'Sequence diagram', name: 'Request and reply', hint: 'Who talks to whom, in order, for one request',
    code: 'sequenceDiagram\n  participant U as User\n  participant A as App\n  participant D as Database\n  U->>A: Open the page\n  A->>D: Ask for the data\n  D-->>A: Return the data\n  A-->>U: Show the page',
  },
  {
    id: 'seq-signin', kind: 'Sequence diagram', name: 'Sign-in with a check', hint: 'A conversation with two outcomes (alt / else)',
    code: 'sequenceDiagram\n  participant U as User\n  participant S as Server\n  U->>S: Send username and password\n  S->>S: Check the details\n  alt Details are correct\n    S-->>U: Signed in\n  else Details are wrong\n    S-->>U: Try again\n  end',
  },
  {
    id: 'class-people', kind: 'Class diagram', name: 'People and roles', hint: 'Things with properties and actions, and how one extends another',
    code: 'classDiagram\n  class Employee {\n    +String name\n    +String department\n    +work()\n  }\n  class Manager {\n    +approve()\n  }\n  Employee <|-- Manager',
  },
  {
    id: 'class-assets', kind: 'Class diagram', name: 'Equipment and owners', hint: 'Kinds of equipment and who they are assigned to',
    code: 'classDiagram\n  class Asset {\n    +String tag\n    +assign()\n  }\n  class Laptop\n  class Printer\n  class Employee\n  Asset <|-- Laptop\n  Asset <|-- Printer\n  Employee "1" --> "many" Asset : uses',
  },
];

function templateEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// One labelled group per diagram type, one button per template (the hint shows as a tooltip).
function mermaidTemplatesHtml(templates = DRAWING_MERMAID_TEMPLATES) {
  const kinds = [...new Set(templates.map((template) => template.kind))];
  const groups = kinds.map((kind) => {
    const buttons = templates.filter((template) => template.kind === kind)
      .map((template) => `<button type="button" class="ttd-template" data-mermaid-template="${templateEscape(template.id)}" title="${templateEscape(template.hint)}">${templateEscape(template.name)}</button>`).join('');
    return `<div class="ttd-template-group"><span class="ttd-template-kind">${templateEscape(kind)}</span>${buttons}</div>`;
  }).join('');
  return `<div class="ttd-templates" role="group" aria-label="Templates"><span class="ttd-templates-title">Start from a template</span>${groups}<button type="button" class="ttd-template-restore" data-mermaid-restore hidden>Put back the previous text</button></div>`;
}

// Puts `code` in the box and tells the editor the text changed. Returns the text to restore: what the box held before the first
// template (pass the earlier `previous` back in so choosing several templates still remembers the original).
function applyMermaidTemplate(box, code, setValue, keepPrevious) {
  const previous = keepPrevious !== undefined && keepPrevious !== null ? keepPrevious : box.value;
  setValue(box, code);
  box.dispatchEvent(new Event('input', { bubbles: true }));
  return { previous };
}

// React keeps its own copy of a text box's value, so it has to be set through the browser's own setter to be noticed.
function setNativeValue(box, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(box, value);
}

function decorateMermaidDialog(dialog) {
  if (dialog.querySelector('.ttd-templates')) return;
  const panels = dialog.querySelector('.ttd-dialog-panels');
  const box = dialog.querySelector('textarea.ttd-dialog-input');
  if (!panels || !box) return;
  panels.insertAdjacentHTML('beforebegin', mermaidTemplatesHtml());
  const bar = dialog.querySelector('.ttd-templates');
  const restore = bar.querySelector('[data-mermaid-restore]');
  let kept = null;
  bar.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.hasAttribute('data-mermaid-restore')) {
      if (kept !== null) applyMermaidTemplate(box, kept, setNativeValue, kept);
      kept = null; restore.hidden = true;
      return;
    }
    const template = DRAWING_MERMAID_TEMPLATES.find((item) => item.id === button.getAttribute('data-mermaid-template'));
    if (!template) return;
    const { previous } = applyMermaidTemplate(box, template.code, setNativeValue, kept);
    if (kept === null) kept = previous;
    restore.hidden = !kept || kept === template.code;
    box.focus();
  });
}

// Watches for the Mermaid dialog opening anywhere in the page (Excalidraw draws it in its own layer) and adds the gallery.
function installMermaidTemplates() {
  const look = () => { for (const dialog of document.querySelectorAll('.ttd-dialog')) decorateMermaidDialog(dialog); };
  new MutationObserver(look).observe(document.body, { childList: true, subtree: true });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { DRAWING_MERMAID_TEMPLATES, mermaidTemplatesHtml, applyMermaidTemplate };
}
