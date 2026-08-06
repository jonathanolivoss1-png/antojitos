'use strict';

(function () {
  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  async function api(path, options = {}) {
    const response = await fetch(path, {
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {})
      },
      ...options
    });

    const data =
      await response.json().catch(() => null);

    if (!response.ok) {
      throw new Error(
        data?.message ||
        `Error ${response.status}`
      );
    }

    return data;
  }

  function findInsertionPoint() {
    return (
      document.getElementById(
        'waiterAccessSection'
      ) ||
      document.getElementById(
        'businessProtectionSection'
      ) ||
      document.querySelector(
        'main section'
      )
    );
  }

  function injectTopButton() {
    if (
      document.querySelector(
        '[data-open-kitchen]'
      )
    ) {
      return;
    }

    const existing =
      document.querySelector(
        'a[href="/meseros/"]'
      );

    const link =
      document.createElement('a');

    link.href = '/cocina/';
    link.target = '_blank';
    link.rel = 'noopener';
    link.dataset.openKitchen = 'true';
    link.textContent = 'Abrir Cocina';
    link.className =
      existing?.className || 'btn secondary';

    if (existing?.parentElement) {
      existing.insertAdjacentElement(
        'afterend',
        link
      );

      return;
    }

    const header =
      document.querySelector(
        '.topbar-actions, .header-actions'
      );

    header?.appendChild(link);
  }

  function injectSection() {
    if (
      document.getElementById(
        'kitchenAccessSection'
      )
    ) {
      return;
    }

    const section =
      document.createElement('section');

    section.id =
      'kitchenAccessSection';

    section.className =
      'panel';

    section.innerHTML = `
      <details>
        <summary>
          <strong>Acceso de Cocina</strong>
          <span>
            Usuarios, PIN y enlace de la pantalla simplificada
          </span>
        </summary>

        <div class="kitchen-admin-grid">
          <div class="kitchen-admin-actions">
            <a
              class="btn secondary"
              href="/cocina/"
              target="_blank"
              rel="noopener"
            >
              Abrir Cocina
            </a>

            <button
              class="btn secondary"
              id="copyKitchenLinkBtn"
              type="button"
            >
              Copiar enlace
            </button>

            <button
              class="btn secondary"
              id="refreshKitchenUsersBtn"
              type="button"
            >
              Actualizar accesos
            </button>
          </div>

          <form
            class="kitchen-admin-form"
            id="createKitchenUserForm"
          >
            <label>
              Nombre
              <input
                id="newKitchenName"
                maxlength="120"
                required
              >
            </label>

            <label>
              Usuario
              <input
                id="newKitchenUsername"
                maxlength="60"
                autocomplete="off"
                required
              >
            </label>

            <label>
              PIN de 4 a 12 números
              <input
                id="newKitchenPin"
                type="password"
                inputmode="numeric"
                pattern="[0-9]{4,12}"
                autocomplete="new-password"
                required
              >
            </label>

            <div class="kitchen-admin-actions">
              <button
                class="btn primary"
                type="submit"
              >
                Crear acceso de Cocina
              </button>
            </div>
          </form>

          <p
            class="kitchen-admin-message"
            id="kitchenAdminMessage"
          ></p>

          <div
            class="kitchen-user-list"
            id="kitchenUserList"
          >
            Cargando accesos…
          </div>
        </div>
      </details>
    `;

    const insertionPoint =
      findInsertionPoint();

    if (insertionPoint) {
      insertionPoint.insertAdjacentElement(
        'afterend',
        section
      );
    } else {
      document.querySelector('main')
        ?.appendChild(section);
    }
  }

  let users = [];

  function elements() {
    return {
      form:
        document.getElementById(
          'createKitchenUserForm'
        ),

      name:
        document.getElementById(
          'newKitchenName'
        ),

      username:
        document.getElementById(
          'newKitchenUsername'
        ),

      pin:
        document.getElementById(
          'newKitchenPin'
        ),

      message:
        document.getElementById(
          'kitchenAdminMessage'
        ),

      list:
        document.getElementById(
          'kitchenUserList'
        ),

      copy:
        document.getElementById(
          'copyKitchenLinkBtn'
        ),

      refresh:
        document.getElementById(
          'refreshKitchenUsersBtn'
        )
    };
  }

  function message(value) {
    const target =
      elements().message;

    if (target) {
      target.textContent =
        String(value || '');
    }
  }

  function renderUsers() {
    const { list } = elements();

    if (!list) return;

    if (!users.length) {
      list.innerHTML = `
        <p>
          Aún no has creado accesos para Cocina.
        </p>
      `;

      return;
    }

    list.innerHTML =
      users
        .map(user => `
          <article
            class="kitchen-user-card"
            data-kitchen-user-id="${Number(user.id)}"
          >
            <div>
              <strong>
                ${escapeHtml(user.nombre)}
              </strong>

              <p>
                Usuario:
                ${escapeHtml(user.usuario)}
              </p>

              <span
                class="kitchen-user-status
                  ${user.activo
                    ? 'active'
                    : 'inactive'}"
              >
                ${user.activo
                  ? 'Activo'
                  : 'Desactivado'}
              </span>
            </div>

            <div class="kitchen-user-controls">
              <button
                class="btn secondary"
                type="button"
                data-kitchen-action="toggle"
              >
                ${user.activo
                  ? 'Desactivar'
                  : 'Activar'}
              </button>

              <button
                class="btn secondary"
                type="button"
                data-kitchen-action="pin"
              >
                Cambiar PIN
              </button>

              <button
                class="btn danger"
                type="button"
                data-kitchen-action="delete"
              >
                Eliminar
              </button>
            </div>
          </article>
        `)
        .join('');
  }

  async function loadUsers() {
    const { list } = elements();

    if (list) {
      list.textContent =
        'Cargando accesos…';
    }

    try {
      const result =
        await api(
          '/api/cocina/admin/users'
        );

      users =
        Array.isArray(result.usuarios)
          ? result.usuarios
          : [];

      renderUsers();
    } catch (error) {
      if (list) {
        list.textContent =
          error.message ||
          'No se pudieron cargar los accesos';
      }
    }
  }

  async function createUser(event) {
    event.preventDefault();

    const {
      form,
      name,
      username,
      pin
    } = elements();

    try {
      await api(
        '/api/cocina/admin/users',
        {
          method: 'POST',
          body: JSON.stringify({
            nombre:
              name.value.trim(),
            usuario:
              username.value.trim(),
            pin:
              pin.value.trim()
          })
        }
      );

      form.reset();
      message(
        'Acceso de Cocina creado'
      );

      await loadUsers();
    } catch (error) {
      message(
        error.message ||
        'No se pudo crear el acceso'
      );
    }
  }

  async function updateUser(
    user,
    changes
  ) {
    await api(
      `/api/cocina/admin/users/${user.id}`,
      {
        method: 'PUT',
        body: JSON.stringify(changes)
      }
    );

    await loadUsers();
  }

  async function handleUserAction(
    event
  ) {
    const button =
      event.target.closest(
        '[data-kitchen-action]'
      );

    if (!button) return;

    const card =
      button.closest(
        '[data-kitchen-user-id]'
      );

    const user =
      users.find(
        item =>
          Number(item.id) ===
          Number(
            card?.dataset
              .kitchenUserId
          )
      );

    if (!user) return;

    const action =
      button.dataset.kitchenAction;

    try {
      if (action === 'toggle') {
        await updateUser(
          user,
          {
            activo: !user.activo
          }
        );

        message(
          user.activo
            ? 'Acceso desactivado'
            : 'Acceso activado'
        );

        return;
      }

      if (action === 'pin') {
        const pin =
          window.prompt(
            `Nuevo PIN para ${user.nombre}:`
          );

        if (pin == null) return;

        if (!/^\d{4,12}$/.test(pin)) {
          message(
            'El PIN debe tener de 4 a 12 números'
          );

          return;
        }

        await updateUser(
          user,
          {
            pin
          }
        );

        message('PIN actualizado');
        return;
      }

      if (action === 'delete') {
        if (
          !window.confirm(
            `¿Eliminar el acceso de ${user.nombre}?`
          )
        ) {
          return;
        }

        await api(
          `/api/cocina/admin/users/${user.id}`,
          {
            method: 'DELETE'
          }
        );

        message('Acceso eliminado');
        await loadUsers();
      }
    } catch (error) {
      message(
        error.message ||
        'No se pudo completar la acción'
      );
    }
  }

  async function copyLink() {
    const url =
      new URL(
        '/cocina/',
        window.location.origin
      ).href;

    try {
      await navigator.clipboard.writeText(url);
      message(
        'Enlace de Cocina copiado'
      );
    } catch {
      window.prompt(
        'Copia el enlace:',
        url
      );
    }
  }

  function bind() {
    const {
      form,
      copy,
      refresh,
      list
    } = elements();

    form?.addEventListener(
      'submit',
      createUser
    );

    copy?.addEventListener(
      'click',
      copyLink
    );

    refresh?.addEventListener(
      'click',
      loadUsers
    );

    list?.addEventListener(
      'click',
      handleUserAction
    );
  }

  function initialize() {
    injectTopButton();
    injectSection();
    bind();
    void loadUsers();
  }

  if (
    document.readyState ===
    'loading'
  ) {
    document.addEventListener(
      'DOMContentLoaded',
      initialize,
      {
        once: true
      }
    );
  } else {
    initialize();
  }
})();
