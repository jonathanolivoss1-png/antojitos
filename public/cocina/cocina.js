// KITCHEN_DETAILED_ORDER_CHANGES_V1
'use strict';

(function () {
  const loginView =
    document.getElementById('loginView');

  const appView =
    document.getElementById('appView');

  const loginForm =
    document.getElementById('loginForm');

  const loginUser =
    document.getElementById('loginUser');

  const loginPin =
    document.getElementById('loginPin');

  const loginButton =
    document.getElementById('loginButton');

  const loginMessage =
    document.getElementById('loginMessage');

  const kitchenUserLabel =
    document.getElementById('kitchenUserLabel');

  const refreshButton =
    document.getElementById('refreshButton');

  const logoutButton =
    document.getElementById('logoutButton');

  const installButton =
    document.getElementById('installButton');

  const ordersGrid =
    document.getElementById('ordersGrid');

  const pendingCount =
    document.getElementById('pendingCount');

  const preparingCount =
    document.getElementById('preparingCount');

  const readyCount =
    document.getElementById('readyCount');

  const toast =
    document.getElementById('toast');

  const tabs =
    Array.from(
      document.querySelectorAll('.tab')
    );

  let kitchenUser = null;
  let orders = [];
  let filter = 'Todos';
  let pollingTimer = null;
  let deferredPrompt = null;
  let knownOrderIds = new Set();
  let firstLoad = true;
  let toastTimer = null;

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
      const error = new Error(
        data?.message ||
        `Error ${response.status}`
      );

      error.status = response.status;
      error.data = data;

      throw error;
    }

    return data;
  }

  function showToast(message) {
    clearTimeout(toastTimer);
    toast.textContent = message;
    toast.classList.remove('hidden');

    toastTimer = setTimeout(() => {
      toast.classList.add('hidden');
    }, 3200);
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function money(value) {
    return new Intl.NumberFormat(
      'es-MX',
      {
        style: 'currency',
        currency: 'MXN'
      }
    ).format(Number(value || 0));
  }

  function time(value) {
    try {
      return new Intl.DateTimeFormat(
        'es-MX',
        {
          hour: 'numeric',
          minute: '2-digit'
        }
      ).format(new Date(value));
    } catch {
      return '';
    }
  }

  function stateClass(state) {
    if (state === 'Preparando') {
      return 'preparing';
    }

    if (state === 'Listo') {
      return 'ready';
    }

    return 'pending';
  }

  function parseInstruction(value) {
    return String(value || '').trim();
  }

  function playNewOrderSound() {
    try {
      const AudioContext =
        window.AudioContext ||
        window.webkitAudioContext;

      if (!AudioContext) return;

      const context = new AudioContext();
      const oscillator =
        context.createOscillator();

      const gain =
        context.createGain();

      oscillator.frequency.value = 880;
      oscillator.type = 'sine';

      gain.gain.setValueAtTime(
        0.0001,
        context.currentTime
      );

      gain.gain.exponentialRampToValueAtTime(
        0.2,
        context.currentTime + 0.02
      );

      gain.gain.exponentialRampToValueAtTime(
        0.0001,
        context.currentTime + 0.45
      );

      oscillator.connect(gain);
      gain.connect(context.destination);

      oscillator.start();
      oscillator.stop(
        context.currentTime + 0.46
      );

      oscillator.addEventListener(
        'ended',
        () => context.close()
      );
    } catch {
      // El sonido es complementario.
    }
  }

  function setAuthenticated(
    authenticated,
    user = null
  ) {
    kitchenUser =
      authenticated
        ? user
        : null;

    loginView.classList.toggle(
      'hidden',
      authenticated
    );

    appView.classList.toggle(
      'hidden',
      !authenticated
    );

    if (authenticated) {
      kitchenUserLabel.textContent =
        user?.nombre ||
        user?.usuario ||
        'Cocina';

      startPolling();
    } else {
      stopPolling();
      orders = [];
      knownOrderIds = new Set();
      firstLoad = true;
      renderOrders();
    }
  }

  function counts() {
    return {
      pending:
        orders.filter(
          order =>
            order.preparacion ===
            'Pendiente'
        ).length,

      preparing:
        orders.filter(
          order =>
            order.preparacion ===
            'Preparando'
        ).length,

      ready:
        orders.filter(
          order =>
            order.preparacion ===
            'Listo'
        ).length
    };
  }

  function updateCounts() {
    const value = counts();

    pendingCount.textContent =
      String(value.pending);

    preparingCount.textContent =
      String(value.preparing);

    readyCount.textContent =
      String(value.ready);
  }

  function renderProducts(products) {
    const list =
      Array.isArray(products)
        ? products
        : [];

    return list
      .map(item => {
        const qty =
          Number(item.qty || item.cantidad || 1);

        const name =
          item.name ||
          item.nombre ||
          'Producto';

        const instruction =
          parseInstruction(
            item.choice ||
            item.opcion ||
            item.observaciones
          );

        return `
          <div class="product-row">
            <span class="product-qty">
              ${escapeHtml(qty)}x
            </span>

            <div>
              <div class="product-name">
                ${escapeHtml(name)}
              </div>

              ${instruction
                ? `
                  <p class="product-note">
                    ${escapeHtml(instruction)}
                  </p>
                `
                : ''}
            </div>
          </div>
        `;
      })
      .join('');
  }

  function correctionDate(value) {
    try {
      return new Intl.DateTimeFormat(
        'es-MX',
        {
          day: 'numeric',
          month: 'short',
          hour: 'numeric',
          minute: '2-digit'
        }
      ).format(new Date(value));
    } catch {
      return '';
    }
  }

  function changeLabel(change) {
    const labels = {
      agregado: 'AGREGADO',
      aumentado: 'PREPARAR EXTRA',
      reducido: 'CANTIDAD REDUCIDA',
      eliminado: 'NO PREPARAR',
      indicacion: 'NUEVA INDICACIÓN',
      entrega: 'TIPO DE ENTREGA',
      actualizacion: 'PEDIDO ACTUALIZADO'
    };

    return (
      change?.etiqueta ||
      labels[change?.tipo] ||
      'CAMBIO'
    );
  }

  function renderChangeItem(change) {
    const type =
      String(change?.tipo || 'actualizacion');

    const before =
      String(change?.antes || '').trim();

    const after =
      String(change?.ahora || '').trim();

    return `
      <li class="change-item ${escapeHtml(type)}">
        <span class="change-type">
          ${escapeHtml(changeLabel(change))}
        </span>

        <strong class="change-text">
          ${escapeHtml(
            change?.texto ||
            change?.nombre ||
            'Pedido actualizado'
          )}
        </strong>

        ${change?.detalle
          ? `
            <small class="change-action">
              ${escapeHtml(change.detalle)}
            </small>
          `
          : ''}

        ${before || after
          ? `
            <div class="change-before-after">
              ${before
                ? `
                  <span class="change-before">
                    Antes: ${escapeHtml(before)}
                  </span>
                `
                : ''}

              ${after
                ? `
                  <span class="change-after">
                    Ahora: ${escapeHtml(after)}
                  </span>
                `
                : ''}
            </div>
          `
          : ''}
      </li>
    `;
  }

  function correctionAlert(order) {
    const corrections =
      Array.isArray(order.cambiosDetalle)
        ? order.cambiosDetalle
        : [];

    if (!corrections.length) {
      if (!order.cambiosPendientes) {
        return '';
      }

      const correction =
        order.ultimaCorreccion;

      return `
        <div class="change-alert">
          <strong>
            ⚠️ Pedido corregido · revisar cambios
          </strong>
          ${correction?.motivo
            ? `
              <p>
                Motivo:
                ${escapeHtml(correction.motivo)}
              </p>
            `
            : ''}
        </div>
      `;
    }

    const pending =
      corrections.some(
        correction =>
          correction.pendiente
      );

    const visible =
      corrections
        .slice(-3)
        .reverse();

    return `
      <section
        class="change-details
          ${pending ? 'pending' : 'reviewed'}"
      >
        <header class="change-details-head">
          <div>
            <strong>
              ${pending
                ? '⚠️ Cambios pendientes para Cocina'
                : '✓ Cambios revisados por Cocina'}
            </strong>
            <p>
              Se muestran las últimas correcciones del pedido.
            </p>
          </div>

          <span class="change-count">
            ${corrections.length}
          </span>
        </header>

        <div class="correction-list">
          ${visible
            .map(correction => `
              <article
                class="correction-entry
                  ${correction.pendiente
                    ? 'pending'
                    : 'reviewed'}"
              >
                <div class="correction-meta">
                  <strong>
                    ${correction.pendiente
                      ? 'PENDIENTE DE REVISAR'
                      : 'REVISADO'}
                  </strong>

                  <time>
                    ${escapeHtml(
                      correctionDate(
                        correction.fecha
                      )
                    )}
                  </time>
                </div>

                ${correction.motivo
                  ? `
                    <p class="correction-reason">
                      Motivo:
                      <strong>
                        ${escapeHtml(
                          correction.motivo
                        )}
                      </strong>
                    </p>
                  `
                  : ''}

                <ul class="change-list">
                  ${(Array.isArray(correction.cambios)
                    ? correction.cambios
                    : [])
                    .map(renderChangeItem)
                    .join('')}
                </ul>
              </article>
            `)
            .join('')}
        </div>
      </section>
    `;
  }

  function stateButtons(order) {
    return [
      'Pendiente',
      'Preparando',
      'Listo'
    ]
      .map(state => `
        <button
          class="state-button
            ${order.preparacion === state
              ? 'active'
              : ''}"
          type="button"
          data-order-id="${Number(order.id)}"
          data-preparation-state="${state}"
        >
          ${state}
        </button>
      `)
      .join('');
  }

  function orderCard(order) {
    return `
      <article
        class="order-card"
        data-order-id="${Number(order.id)}"
        data-state="${escapeHtml(order.preparacion)}"
      >
        <header class="card-head">
          <div>
            <h2 class="order-number">
              Pedido #${Number(order.id)}
            </h2>

            <p class="order-meta">
              ${escapeHtml(order.tipoEntrega || '-')}
              · ${escapeHtml(time(order.fecha))}
              · ${escapeHtml(money(order.total))}
            </p>
          </div>

          <span
            class="prep-badge
              ${stateClass(order.preparacion)}"
          >
            ${escapeHtml(order.preparacion)}
          </span>
        </header>

        ${correctionAlert(order)}

        <div class="products-list">
          ${renderProducts(order.productos)}
        </div>

        <footer class="card-actions">
          ${stateButtons(order)}

          ${order.cambiosPendientes
            ? `
              <button
                class="ack-button"
                type="button"
                data-acknowledge-order="${Number(order.id)}"
              >
                ✓ Ya revisé los cambios
              </button>
            `
            : ''}
        </footer>
      </article>
    `;
  }

  function renderOrders() {
    updateCounts();

    const visible =
      orders.filter(order =>
        filter === 'Todos' ||
        order.preparacion === filter
      );

    if (!visible.length) {
      ordersGrid.innerHTML = `
        <div class="empty-state">
          ${
            orders.length
              ? 'No hay pedidos en este estado.'
              : 'No hay pedidos Confirmados para Cocina.'
          }
        </div>
      `;

      return;
    }

    ordersGrid.innerHTML =
      visible.map(orderCard).join('');
  }

  async function loadOrders(options = {}) {
    if (!kitchenUser) return;

    if (options.manual) {
      refreshButton.disabled = true;
      refreshButton.textContent =
        'Actualizando…';
    }

    try {
      const result =
        await api('/api/cocina/orders');

      const nextOrders =
        Array.isArray(result.pedidos)
          ? result.pedidos
          : [];

      const nextIds =
        new Set(
          nextOrders.map(
            order => Number(order.id)
          )
        );

      if (!firstLoad) {
        const hasNewOrder =
          Array.from(nextIds).some(
            id => !knownOrderIds.has(id)
          );

        if (hasNewOrder) {
          playNewOrderSound();
          showToast(
            'Llegó un nuevo pedido a Cocina'
          );
        }
      }

      knownOrderIds = nextIds;
      firstLoad = false;
      orders = nextOrders;
      renderOrders();
    } catch (error) {
      if (error.status === 401) {
        setAuthenticated(false);
        loginMessage.textContent =
          'Tu sesión terminó. Vuelve a entrar.';
        return;
      }

      showToast(
        error.message ||
        'No se pudieron cargar los pedidos'
      );
    } finally {
      if (options.manual) {
        refreshButton.disabled = false;
        refreshButton.textContent =
          'Actualizar';
      }
    }
  }

  async function updatePreparation(
    orderId,
    state
  ) {
    const button =
      document.querySelector(
        `[data-order-id="${orderId}"] `
        + `[data-preparation-state="${state}"]`
      );

    if (button) {
      button.disabled = true;
    }

    try {
      await api(
        `/api/cocina/orders/${orderId}/preparation`,
        {
          method: 'PUT',
          body: JSON.stringify({
            estado: state
          })
        }
      );

      const order =
        orders.find(
          item =>
            Number(item.id) ===
            Number(orderId)
        );

      if (order) {
        order.preparacion = state;
      }

      renderOrders();
    } catch (error) {
      showToast(
        error.message ||
        'No se pudo actualizar la preparación'
      );

      await loadOrders();
    }
  }

  async function acknowledgeChanges(
    orderId
  ) {
    try {
      await api(
        `/api/cocina/orders/${orderId}/acknowledge-changes`,
        {
          method: 'POST',
          body: '{}'
        }
      );

      const order =
        orders.find(
          item =>
            Number(item.id) ===
            Number(orderId)
        );

      if (order) {
        order.cambiosPendientes = false;

        if (
          Array.isArray(
            order.cambiosDetalle
          )
        ) {
          order.cambiosDetalle.forEach(
            correction => {
              correction.pendiente = false;
            }
          );
        }
      }

      showToast(
        'Cambios revisados por Cocina'
      );

      renderOrders();
    } catch (error) {
      showToast(
        error.message ||
        'No se pudieron confirmar los cambios'
      );
    }
  }

  function startPolling() {
    stopPolling();

    void loadOrders();

    pollingTimer = window.setInterval(
      () => {
        void loadOrders();
      },
      4000
    );
  }

  function stopPolling() {
    if (pollingTimer) {
      clearInterval(pollingTimer);
      pollingTimer = null;
    }
  }

  async function restoreSession() {
    try {
      const result =
        await api('/api/cocina/session');

      setAuthenticated(
        Boolean(result.authenticated),
        result.cocina
      );
    } catch {
      setAuthenticated(false);
    }
  }

  async function login(event) {
    event.preventDefault();

    loginButton.disabled = true;
    loginButton.textContent =
      'Entrando…';

    loginMessage.textContent = '';

    try {
      const result =
        await api(
          '/api/cocina/login',
          {
            method: 'POST',
            body: JSON.stringify({
              usuario:
                loginUser.value.trim(),
              pin:
                loginPin.value.trim()
            })
          }
        );

      loginPin.value = '';

      setAuthenticated(
        true,
        result.cocina
      );
    } catch (error) {
      loginMessage.textContent =
        error.message ||
        'No se pudo iniciar sesión';
    } finally {
      loginButton.disabled = false;
      loginButton.textContent =
        'Entrar a Cocina';
    }
  }

  async function logout() {
    try {
      await api(
        '/api/cocina/logout',
        {
          method: 'POST',
          body: '{}'
        }
      );
    } catch {
      // La vista se cierra aunque falle la red.
    }

    setAuthenticated(false);
  }

  function setupInstall() {
    const standalone =
      window.matchMedia(
        '(display-mode: standalone)'
      ).matches ||
      window.navigator.standalone === true;

    if (standalone) {
      return;
    }

    const ios =
      /iphone|ipad|ipod/i.test(
        navigator.userAgent
      );

    if (ios) {
      installButton.classList.remove('hidden');
    }

    window.addEventListener(
      'beforeinstallprompt',
      event => {
        event.preventDefault();
        deferredPrompt = event;
        installButton.classList.remove('hidden');
      }
    );

    window.addEventListener(
      'appinstalled',
      () => {
        deferredPrompt = null;
        installButton.classList.add('hidden');
      }
    );
  }

  async function installApp() {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      await deferredPrompt.userChoice
        .catch(() => null);

      deferredPrompt = null;
      installButton.classList.add('hidden');
      return;
    }

    if (
      /iphone|ipad|ipod/i.test(
        navigator.userAgent
      )
    ) {
      window.alert(
        'En iPhone abre esta página en Safari y toca: '
        + 'Compartir → Agregar a pantalla de inicio.'
      );

      return;
    }

    window.alert(
      'Abre el menú del navegador y selecciona '
      + 'Instalar aplicación o Agregar a pantalla de inicio.'
    );
  }

  loginForm.addEventListener(
    'submit',
    login
  );

  refreshButton.addEventListener(
    'click',
    () => {
      void loadOrders({
        manual: true
      });
    }
  );

  logoutButton.addEventListener(
    'click',
    logout
  );

  installButton.addEventListener(
    'click',
    () => {
      void installApp();
    }
  );

  tabs.forEach(tab => {
    tab.addEventListener(
      'click',
      () => {
        filter =
          tab.dataset.filter ||
          'Todos';

        tabs.forEach(item =>
          item.classList.toggle(
            'active',
            item === tab
          )
        );

        renderOrders();
      }
    );
  });

  ordersGrid.addEventListener(
    'click',
    event => {
      const stateButton =
        event.target.closest(
          '[data-preparation-state]'
        );

      if (stateButton) {
        void updatePreparation(
          Number(
            stateButton.dataset.orderId
          ),
          stateButton.dataset.preparationState
        );

        return;
      }

      const acknowledgeButton =
        event.target.closest(
          '[data-acknowledge-order]'
        );

      if (acknowledgeButton) {
        void acknowledgeChanges(
          Number(
            acknowledgeButton.dataset
              .acknowledgeOrder
          )
        );
      }
    }
  );

  document.addEventListener(
    'visibilitychange',
    () => {
      if (
        document.visibilityState ===
        'visible'
      ) {
        void loadOrders();
      }
    }
  );

  if ('serviceWorker' in navigator) {
    window.addEventListener(
      'load',
      () => {
        navigator.serviceWorker
          .register(
            './sw.js',
            {
              scope: '/cocina/',
              updateViaCache: 'none'
            }
          )
          .then(registration => {
            void registration.update();
          })
          .catch(error => {
            console.warn(
              'No se pudo registrar la app de Cocina:',
              error
            );
          });
      }
    );
  }

  setupInstall();
  void restoreSession();
})();
