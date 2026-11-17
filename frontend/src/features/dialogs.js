// IT Avenue Workspace - in-app dialogs. The ONLY place dialogs come from: native confirm(), alert() and
// prompt() are not used anywhere in the client (scripts/check.js fails the build if they appear).
//
//   await confirmAction({ title, message, confirmLabel, cancelLabel, danger })  -> true / false
//   await askText(message, { placeholder, maxLength, required })                -> text, or null when cancelled
//   await showMessage(message, { title, okLabel })                              -> resolves when dismissed
//
// Loaded before renderer.js and by the login page; defines functions only and depends on nothing else.

function dialogEscape(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Reusable confirmation dialog (replaces native window.confirm).
// Resolves with true if the user confirms, false on cancel / Escape / backdrop click.
function confirmAction({ title = '', message = '', confirmLabel = 'Delete', cancelLabel = 'Cancel', danger = true } = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay open';
    const modal = document.createElement('div');
    modal.className = 'modal confirm-modal open';
    modal.setAttribute('role', 'alertdialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', title || message || 'Confirm action');
    modal.innerHTML = `
      <div class="modal-body">
        ${title ? `<h3 class="confirm-title">${dialogEscape(title)}</h3>` : ''}
        ${message ? `<p class="confirm-message">${dialogEscape(message)}</p>` : ''}
      </div>
      <div class="modal-footer">
        <button class="btn" type="button" data-confirm-cancel>${dialogEscape(cancelLabel)}</button>
        <button class="btn ${danger ? 'danger' : 'primary'}" type="button" data-confirm-ok>${dialogEscape(confirmLabel)}</button>
      </div>`;
    const finish = (value) => {
      document.removeEventListener('keydown', onKeydown, true);
      overlay.remove();
      modal.remove();
      resolve(value);
    };
    const onKeydown = (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      finish(false);
    };
    modal.querySelector('[data-confirm-ok]').addEventListener('click', () => finish(true));
    modal.querySelectorAll('[data-confirm-cancel]').forEach((btn) => btn.addEventListener('click', () => finish(false)));
    overlay.addEventListener('click', () => finish(false));
    document.addEventListener('keydown', onKeydown, true);
    document.body.append(overlay, modal);
    // Focus the Cancel button so Enter does not accidentally confirm a destructive action
    modal.querySelector('[data-confirm-cancel]')?.focus();
  });
}

// Electron does not implement window.prompt(), so text input uses an in-app dialog.
// Resolves with the entered text, or null when the dialog is cancelled.
function askText(message, { placeholder = '', maxLength = 500, required = false } = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay open';
    const modal = document.createElement('form');
    modal.className = 'modal open';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.innerHTML = `
      <div class="modal-body">
        <div class="form-group">
          <label for="ask-text-input">${dialogEscape(message)}</label>
          <input id="ask-text-input" type="text" autocomplete="off" maxlength="${Number(maxLength)}" placeholder="${dialogEscape(placeholder)}"${required ? ' required' : ''}>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn" type="button" data-ask-cancel>Cancel</button>
        <button class="btn primary" type="submit">OK</button>
      </div>`;
    const input = modal.querySelector('input');
    const finish = (value) => {
      document.removeEventListener('keydown', onKeydown, true);
      overlay.remove();
      modal.remove();
      resolve(value);
    };
    const onKeydown = (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      finish(null);
    };
    modal.addEventListener('submit', (event) => {
      event.preventDefault();
      if (required && !input.value.trim()) return;
      finish(input.value);
    });
    modal.querySelector('[data-ask-cancel]').addEventListener('click', () => finish(null));
    overlay.addEventListener('click', () => finish(null));
    document.addEventListener('keydown', onKeydown, true);
    document.body.append(overlay, modal);
    input.focus();
  });
}

// Replaces native alert(): a message the person has to dismiss. Resolves when closed (OK, Escape or click away).
function showMessage(message, { title = '', okLabel = 'OK' } = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay open';
    const modal = document.createElement('div');
    modal.className = 'modal confirm-modal open';
    modal.setAttribute('role', 'alertdialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', title || message || 'Message');
    modal.innerHTML = `
      <div class="modal-body">
        ${title ? `<h3 class="confirm-title">${dialogEscape(title)}</h3>` : ''}
        ${message ? `<p class="confirm-message">${dialogEscape(message)}</p>` : ''}
      </div>
      <div class="modal-footer">
        <button class="btn primary" type="button" data-message-ok>${dialogEscape(okLabel)}</button>
      </div>`;
    const finish = () => {
      document.removeEventListener('keydown', onKeydown, true);
      overlay.remove();
      modal.remove();
      resolve();
    };
    const onKeydown = (event) => {
      if (event.key !== 'Escape' && event.key !== 'Enter') return;
      event.preventDefault();
      event.stopPropagation();
      finish();
    };
    modal.querySelector('[data-message-ok]').addEventListener('click', finish);
    overlay.addEventListener('click', finish);
    document.addEventListener('keydown', onKeydown, true);
    document.body.append(overlay, modal);
    modal.querySelector('[data-message-ok]').focus();
  });
}
