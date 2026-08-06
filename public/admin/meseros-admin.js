// PERSONAL_VISIBLE_NAMES_V1
(() => {
  'use strict';

  const section = document.getElementById('waiterAccessSection');
  const toggleBtn = document.getElementById('toggleWaiterAccessBtn');
  const content = document.getElementById('waiterAccessContent');
  const createForm = document.getElementById('createWaiterForm');
  const nameInput = document.getElementById('waiterNameInput');
  const userInput = document.getElementById('waiterUserInputAdmin');
  const pinInput = document.getElementById('waiterPinInputAdmin');
  const list = document.getElementById('waiterUsersList');
  const refreshBtn = document.getElementById('refreshWaitersBtn');
  const copyLinkBtn = document.getElementById('copyWaiterLinkBtn');
  const showQrBtn = document.getElementById('showWaiterQrBtn');
  const qrPanel = document.getElementById('waiterQrPanel');
  const qrImage = document.getElementById('waiterQrImage');
  const printQrBtn = document.getElementById('printWaiterQrBtn');

  if (!section) return;

  let loaded = false;
  let users = [];

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function waiterUrl() {
    return `${window.location.origin}/meseros/`;
  }

  function showMessage(message, isError = false) {
    if (typeof window.showToast === 'function') {
      window.showToast(message, isError);
      return;
    }

    const toast = document.getElementById('adminToast');
    if (!toast) return;

    toast.textContent = message;
    toast.style.background = isError
      ? 'rgba(167,51,25,.96)'
      : 'rgba(46,125,50,.96)';
    toast.classList.add('show');
    clearTimeout(showMessage.timer);
    showMessage.timer = setTimeout(() => {
      toast.classList.remove('show');
    }, 2600);
  }

  async function api(path, options = {}) {
    const response = await fetch(path, {
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {})
      },
      ...options
    });

    const data = await response.json().catch(() => null);

    if (!response.ok) {
      const error = new Error(
        data?.message || `Error ${response.status}`
      );
      error.status = response.status;
      throw error;
    }

    return data;
  }

  function setOpen(open) {
    const isOpen = Boolean(open);
    toggleBtn.setAttribute('aria-expanded', String(isOpen));
    content.hidden = !isOpen;

    const label = toggleBtn.querySelector('[data-role="waiter-toggle-label"]');
    if (label) {
      label.textContent = isOpen
        ? 'Ocultar accesos'
        : 'Mostrar accesos';
    }

    if (isOpen && !loaded) {
      loadUsers();
    }
  }

  function renderUsers() {
    if (!users.length) {
      list.innerHTML = `
        <div class="waiter-empty">
          Aún no has creado accesos para el personal.
        </div>
      `;
      return;
    }

    list.innerHTML = users.map(user => `
      <article class="waiter-user-card" data-waiter-id="${user.id}">
        <div class="waiter-user-grid">
          <label>
            Nombre
            <input data-field="nombre" value="${escapeHtml(user.nombre)}" maxlength="120" />
          </label>

          <label>
            Usuario
            <input data-field="usuario" value="${escapeHtml(user.usuario)}" maxlength="60" />
          </label>

          <label>
            Nuevo PIN
            <input data-field="pin" type="password" inputmode="numeric" pattern="[0-9]*" placeholder="Dejar vacío para conservar" />
          </label>

          <label class="waiter-active-label">
            <input data-field="activo" type="checkbox" ${user.activo ? 'checked' : ''} />
            Acceso activo
          </label>
        </div>

        <div class="waiter-user-actions">
          <button class="save-btn" type="button" data-action="save-waiter">Guardar</button>
          <button class="danger-btn" type="button" data-action="delete-waiter">Eliminar</button>
        </div>
      </article>
    `).join('');
  }

  async function loadUsers() {
    list.innerHTML = '<div class="waiter-empty">Cargando accesos...</div>';

    try {
      const result = await api('/api/meseros/admin/users');
      users = Array.isArray(result.users) ? result.users : [];
      loaded = true;
      renderUsers();
    } catch (error) {
      list.innerHTML = `
        <div class="waiter-empty">
          ${escapeHtml(error.message || 'No se pudieron cargar los accesos')}
        </div>
      `;
    }
  }

  async function createUser(event) {
    event.preventDefault();

    const payload = {
      nombre: nameInput.value.trim(),
      usuario: userInput.value.trim(),
      pin: pinInput.value.trim()
    };

    try {
      const result = await api('/api/meseros/admin/users', {
        method: 'POST',
        body: JSON.stringify(payload)
      });

      users.push(result.user);
      users.sort((a, b) =>
        String(a.nombre).localeCompare(String(b.nombre), 'es')
      );

      createForm.reset();
      renderUsers();
      showMessage('Acceso de personal creado');
    } catch (error) {
      showMessage(error.message || 'No se pudo crear el acceso', true);
    }
  }

  function readCard(card) {
    return {
      nombre: card.querySelector('[data-field="nombre"]').value.trim(),
      usuario: card.querySelector('[data-field="usuario"]').value.trim(),
      pin: card.querySelector('[data-field="pin"]').value.trim(),
      activo: card.querySelector('[data-field="activo"]').checked
    };
  }

  async function saveUser(card) {
    const id = Number(card.dataset.waiterId);

    try {
      const result = await api(`/api/meseros/admin/users/${id}`, {
        method: 'PUT',
        body: JSON.stringify(readCard(card))
      });

      users = users.map(user =>
        Number(user.id) === id ? result.user : user
      );

      renderUsers();
      showMessage('Acceso actualizado');
    } catch (error) {
      showMessage(error.message || 'No se pudo actualizar', true);
    }
  }

  async function deleteUser(card) {
    const id = Number(card.dataset.waiterId);
    const user = users.find(entry => Number(entry.id) === id);

    if (
      !window.confirm(
        `¿Eliminar el acceso de ${user?.nombre || 'este integrante del personal'}?`
      )
    ) {
      return;
    }

    try {
      await api(`/api/meseros/admin/users/${id}`, {
        method: 'DELETE'
      });

      users = users.filter(entry => Number(entry.id) !== id);
      renderUsers();
      showMessage('Acceso eliminado');
    } catch (error) {
      showMessage(error.message || 'No se pudo eliminar', true);
    }
  }

  function showQr() {
    const url = waiterUrl();

    qrImage.src =
      `https://api.qrserver.com/v1/create-qr-code/?size=320x320&margin=12&data=${encodeURIComponent(url)}`;

    qrPanel.hidden = !qrPanel.hidden;
  }

  async function copyLink() {
    const url = waiterUrl();

    try {
      await navigator.clipboard.writeText(url);
      showMessage('Enlace del personal copiado');
    } catch {
      window.prompt('Copia el enlace:', url);
    }
  }

  function printQr() {
    const url = waiterUrl();
    const qrUrl = qrImage.src || '';

    const popup = window.open('', '_blank', 'noopener,noreferrer');

    if (!popup) {
      showMessage('Permite ventanas emergentes para imprimir', true);
      return;
    }

    popup.document.write(`
      <!doctype html>
      <html lang="es">
        <head>
          <title>Acceso del personal</title>
          <style>
            body { font-family: system-ui; text-align:center; padding:40px; color:#4e342e; }
            img { width:320px; max-width:90vw; }
            h1 { color:#c73e1d; }
            p { font-size:18px; }
          </style>
        </head>
        <body>
          <h1>Acceso del personal</h1>
          <img src="${escapeHtml(qrUrl)}" alt="Código QR" />
          <p>${escapeHtml(url)}</p>
          <script>window.onload=()=>window.print();<\/script>
        </body>
      </html>
    `);

    popup.document.close();
  }

  toggleBtn.addEventListener('click', () => {
    setOpen(toggleBtn.getAttribute('aria-expanded') !== 'true');
  });

  createForm.addEventListener('submit', createUser);
  refreshBtn.addEventListener('click', loadUsers);
  copyLinkBtn.addEventListener('click', copyLink);
  showQrBtn.addEventListener('click', showQr);
  printQrBtn.addEventListener('click', printQr);

  list.addEventListener('click', event => {
    const button = event.target.closest('[data-action]');
    if (!button) return;

    const card = button.closest('[data-waiter-id]');
    if (!card) return;

    if (button.dataset.action === 'save-waiter') {
      saveUser(card);
    }

    if (button.dataset.action === 'delete-waiter') {
      deleteUser(card);
    }
  });

  setOpen(false);
})();
