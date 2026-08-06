// BUSINESS_PROTECTION_V1
(function () {
  'use strict';

  const $ = selector => document.querySelector(selector);

  const elements = {
    summary: $('#businessProtectionSummary'),
    backupStatus: $('#backupRestoreStatus'),
    downloadBackup: $('#downloadCompleteBackupBtn'),
    backupFile: $('#completeBackupFile'),
    chosenFile: $('#chosenBackupFile'),
    testRestore: $('#testCompleteRestoreBtn'),
    restore: $('#restoreCompleteBackupBtn'),
    confirmation: $('#restoreConfirmation'),
    refreshCopies: $('#refreshAutomaticCopiesBtn'),
    automaticCopies: $('#automaticCopiesList'),
    refreshOrders: $('#refreshCorrectableOrdersBtn'),
    orderSelect: $('#correctableOrderSelect'),
    form: $('#controlledCorrectionForm'),
    products: $('#correctionProducts'),
    addProduct: $('#addCorrectionProductBtn'),
    total: $('#correctionTotal'),
    history: $('#correctionHistory'),
    correctionStatus: $('#correctionStatus'),
    section: $('#businessProtectionSection'),
    adminApp: $('#adminApp')
  };

  if (!elements.summary) return;

  let selectedBackup = null;
  let orders = [];
  let selectedOrder = null;

  function money(value) {
    return new Intl.NumberFormat('es-MX', {
      style: 'currency',
      currency: 'MXN'
    }).format(Number(value || 0));
  }

  function dateTime(value) {
    try {
      return new Intl.DateTimeFormat('es-MX', {
        dateStyle: 'medium',
        timeStyle: 'short'
      }).format(new Date(value));
    } catch {
      return String(value || '');
    }
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  async function api(url, options = {}) {
    const response = await fetch(url, {
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {})
      },
      ...options
    });

    const type = response.headers.get('content-type') || '';
    const data = type.includes('application/json')
      ? await response.json()
      : await response.text();

    if (!response.ok) {
      throw new Error(
        typeof data === 'object'
          ? data.message || 'La operación falló'
          : data || 'La operación falló'
      );
    }

    return data;
  }

  function setStatus(element, message, type = '') {
    element.textContent = message;
    element.classList.remove('success', 'error');
    if (type) element.classList.add(type);
  }

  function setBusy(button, busy, busyText = 'Procesando…') {
    if (!button) return;
    if (!button.dataset.originalText) {
      button.dataset.originalText = button.textContent;
    }
    button.disabled = busy;
    button.textContent = busy
      ? busyText
      : button.dataset.originalText;
  }

  async function loadSummary() {
    try {
      const data = await api('/api/admin/proteccion/resumen');
      const migration = data.calculator?.migration || {};
      const message = [
        `Calculadora en ${data.database}: ${data.calculator?.calculations || 0} cálculos`,
        `Productos guardados: ${data.calculator?.products || 0}`,
        `Correcciones registradas: ${data.corrections || 0}`,
        migration.migratedCalculations
          ? `Migrados desde SQLite: ${migration.migratedCalculations} cálculos`
          : 'Migración SQLite: sin registros nuevos'
      ].join('\n');
      setStatus(elements.summary, message, 'success');
    } catch (error) {
      setStatus(elements.summary, error.message, 'error');
    }
  }

  async function downloadBackup() {
    setBusy(elements.downloadBackup, true, 'Generando…');
    try {
      const response = await fetch('/api/admin/proteccion/respaldo', {
        credentials: 'same-origin'
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.message || 'No se pudo generar el respaldo');
      }
      const blob = await response.blob();
      const disposition = response.headers.get('content-disposition') || '';
      const filenameMatch = disposition.match(/filename="([^"]+)"/);
      const filename = filenameMatch?.[1] || 'respaldo-antojitos.json';
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      setStatus(
        elements.backupStatus,
        'Respaldo completo descargado correctamente.',
        'success'
      );
    } catch (error) {
      setStatus(elements.backupStatus, error.message, 'error');
    } finally {
      setBusy(elements.downloadBackup, false);
    }
  }

  async function readBackupFile(file) {
    const text = await file.text();
    const parsed = JSON.parse(text);
    selectedBackup = parsed;
    elements.chosenFile.textContent = file.name;
    setStatus(
      elements.backupStatus,
      'Archivo cargado. Pulsa “Probar restauración” antes de restaurar.',
      'success'
    );
  }

  async function testRestore() {
    if (!selectedBackup) {
      setStatus(
        elements.backupStatus,
        'Selecciona primero un archivo de respaldo.',
        'error'
      );
      return;
    }

    setBusy(elements.testRestore, true, 'Probando…');
    try {
      const data = await api(
        '/api/admin/proteccion/probar-restauracion',
        {
          method: 'POST',
          body: JSON.stringify({ backup: selectedBackup })
        }
      );
      const counts = Object.entries(data.testedCounts || {})
        .map(([table, count]) => `${table}: ${count}`)
        .join('\n');
      setStatus(
        elements.backupStatus,
        `${data.message}\n\n${counts}`,
        'success'
      );
    } catch (error) {
      setStatus(elements.backupStatus, error.message, 'error');
    } finally {
      setBusy(elements.testRestore, false);
    }
  }

  async function restoreBackup() {
    if (!selectedBackup) {
      setStatus(
        elements.backupStatus,
        'Selecciona primero un respaldo.',
        'error'
      );
      return;
    }

    if (elements.confirmation.value.trim() !== 'RESTAURAR') {
      setStatus(
        elements.backupStatus,
        'Escribe RESTAURAR exactamente para confirmar.',
        'error'
      );
      return;
    }

    const accepted = window.confirm(
      'Se reemplazarán los datos actuales. Antes se creará una copia automática. ¿Continuar?'
    );
    if (!accepted) return;

    setBusy(elements.restore, true, 'Restaurando…');
    try {
      const data = await api('/api/admin/proteccion/restaurar', {
        method: 'POST',
        body: JSON.stringify({
          backup: selectedBackup,
          confirmation: 'RESTAURAR',
          reason: 'Restauración desde archivo del administrador'
        })
      });
      setStatus(
        elements.backupStatus,
        `${data.message}\nCopia automática previa: #${data.automaticSnapshot?.id}`,
        'success'
      );
      elements.confirmation.value = '';
      await Promise.all([
        loadSummary(),
        loadOrders(),
        loadAutomaticCopies()
      ]);
    } catch (error) {
      setStatus(elements.backupStatus, error.message, 'error');
    } finally {
      setBusy(elements.restore, false);
    }
  }

  async function loadAutomaticCopies() {
    try {
      const data = await api(
        '/api/admin/proteccion/copias-automaticas'
      );
      const copies = data.copies || [];
      if (!copies.length) {
        elements.automaticCopies.innerHTML =
          '<p>No hay copias automáticas todavía.</p>';
        return;
      }
      elements.automaticCopies.innerHTML = copies
        .map(copy => `
          <div class="automatic-copy">
            <div>
              <strong>Copia #${copy.id}</strong><br>
              <small>${escapeHtml(dateTime(copy.fecha))} · ${escapeHtml(copy.motivo)}</small>
            </div>
            <button type="button" data-restore-copy="${copy.id}">
              Restaurar
            </button>
          </div>
        `)
        .join('');
    } catch (error) {
      elements.automaticCopies.innerHTML =
        `<p>${escapeHtml(error.message)}</p>`;
    }
  }

  async function restoreAutomaticCopy(id) {
    const confirmation = window.prompt(
      `Para restaurar la copia automática #${id}, escribe RESTAURAR`
    );
    if (confirmation !== 'RESTAURAR') return;

    const accepted = window.confirm(
      'Se creará otra copia automática antes de restaurar. ¿Continuar?'
    );
    if (!accepted) return;

    try {
      const data = await api(
        `/api/admin/proteccion/copias-automaticas/${id}/restaurar`,
        {
          method: 'POST',
          body: JSON.stringify({ confirmation: 'RESTAURAR' })
        }
      );
      setStatus(elements.backupStatus, data.message, 'success');
      await Promise.all([
        loadSummary(),
        loadOrders(),
        loadAutomaticCopies()
      ]);
    } catch (error) {
      setStatus(elements.backupStatus, error.message, 'error');
    }
  }

  function productRow(product = {}) {
    const wrapper = document.createElement('div');
    wrapper.className = 'correction-product';
    wrapper.dataset.productId = String(product.productId || '');
    wrapper.dataset.optionId = String(product.optionId || '');
    wrapper.innerHTML = `
      <label>
        Producto
        <input
          class="product-name"
          type="text"
          maxlength="180"
          value="${escapeHtml(product.name || product.nombre || '')}"
          required
        >
      </label>
      <label>
        Cant.
        <input
          class="product-qty"
          type="number"
          min="1"
          max="999"
          step="1"
          value="${Number(product.qty || product.cantidad || 1)}"
          required
        >
      </label>
      <label>
        Precio
        <input
          class="product-price"
          type="number"
          min="0"
          step="0.01"
          value="${Number(product.price || product.precio || 0)}"
          required
        >
      </label>
      <label class="product-choice">
        Opción o nota
        <input
          class="product-choice-input"
          type="text"
          maxlength="240"
          value="${escapeHtml(product.choice || '')}"
        >
      </label>
      <button class="remove-correction-product" type="button" aria-label="Eliminar producto">
        ✕
      </button>
    `;
    return wrapper;
  }

  function calculateCorrectionTotal() {
    const subtotal = [...elements.products.querySelectorAll('.correction-product')]
      .reduce((sum, row) => {
        const qty = Number(row.querySelector('.product-qty').value || 0);
        const price = Number(row.querySelector('.product-price').value || 0);
        return sum + qty * price;
      }, 0);
    const shipping = Number($('#correctionShipping').value || 0);
    elements.total.textContent =
      `Subtotal: ${money(subtotal)} · Total: ${money(subtotal + shipping)}`;
  }

  function collectProducts() {
    return [...elements.products.querySelectorAll('.correction-product')]
      .map(row => ({
        name: row.querySelector('.product-name').value.trim(),
        qty: Number(row.querySelector('.product-qty').value),
        price: Number(row.querySelector('.product-price').value),
        choice: row.querySelector('.product-choice-input').value.trim(),
        productId: row.dataset.productId || '',
        optionId: row.dataset.optionId || ''
      }));
  }

  async function loadOrders() {
    setBusy(elements.refreshOrders, true, 'Actualizando…');
    try {
      const data = await api('/api/admin/pedidos-corregibles');
      orders = data.pedidos || [];
      elements.orderSelect.innerHTML = [
        '<option value="">Selecciona un pedido</option>',
        ...orders.map(order => `
          <option value="${order.id}">
            #${order.id} · ${escapeHtml(order.cliente)} · ${money(order.total)} · ${escapeHtml(order.estado)}
          </option>
        `)
      ].join('');

      if (selectedOrder) {
        const refreshed = orders.find(order => order.id === selectedOrder.id);
        if (refreshed) {
          elements.orderSelect.value = String(refreshed.id);
          showOrder(refreshed);
        }
      }
    } catch (error) {
      setStatus(elements.correctionStatus, error.message, 'error');
    } finally {
      setBusy(elements.refreshOrders, false);
    }
  }

  function showOrder(order) {
    selectedOrder = order;
    $('#correctionCustomer').value = order.cliente || '';
    $('#correctionPhone').value = order.telefono || '';
    $('#correctionAddress').value = order.direccion || '';
    $('#correctionDelivery').value = order.tipoEntrega || '';
    $('#correctionShipping').value = Number(order.envio || 0).toFixed(2);
    $('#correctionState').value =
      ['Confirmado', 'Entregado', 'Cancelado'].includes(order.estado)
        ? order.estado
        : 'Confirmado';
    $('#correctionReason').value = '';

    elements.products.innerHTML = '';
    (order.productos || []).forEach(product => {
      elements.products.appendChild(productRow(product));
    });
    if (!elements.products.children.length) {
      elements.products.appendChild(productRow());
    }
    elements.form.hidden = false;
    calculateCorrectionTotal();
    void loadHistory(order.id);
  }

  async function loadHistory(orderId) {
    elements.history.innerHTML = '<p>Cargando historial…</p>';
    try {
      const data = await api(
        `/api/admin/pedidos/${orderId}/historial-correcciones`
      );
      const corrections = data.corrections || [];
      if (!corrections.length) {
        elements.history.innerHTML =
          '<p>Este pedido todavía no tiene correcciones registradas.</p>';
        return;
      }
      elements.history.innerHTML = corrections
        .map(item => `
          <article>
            <strong>${escapeHtml(dateTime(item.fecha))}</strong>
            <div>${escapeHtml(item.usuario)} · ${escapeHtml(item.motivo)}</div>
            <small>Campos: ${escapeHtml((item.camposModificados || []).join(', '))}</small>
          </article>
        `)
        .join('');
    } catch (error) {
      elements.history.innerHTML =
        `<p>${escapeHtml(error.message)}</p>`;
    }
  }

  async function submitCorrection(event) {
    event.preventDefault();
    if (!selectedOrder) return;

    const submit = elements.form.querySelector('[type="submit"]');
    setBusy(submit, true, 'Guardando…');

    try {
      const data = await api(
        `/api/admin/pedidos/${selectedOrder.id}/correccion`,
        {
          method: 'PUT',
          body: JSON.stringify({
            cliente: $('#correctionCustomer').value,
            telefono: $('#correctionPhone').value,
            direccion: $('#correctionAddress').value,
            tipoEntrega: $('#correctionDelivery').value,
            envio: Number($('#correctionShipping').value || 0),
            estado: $('#correctionState').value,
            motivo: $('#correctionReason').value,
            productos: collectProducts()
          })
        }
      );

      setStatus(elements.correctionStatus, data.message, 'success');
      selectedOrder = data.pedido;
      await loadOrders();
      await loadHistory(data.pedido.id);

      window.dispatchEvent(
        new CustomEvent('anafres:orders-updated', {
          detail: { reason: 'controlled-correction' }
        })
      );
    } catch (error) {
      setStatus(elements.correctionStatus, error.message, 'error');
    } finally {
      setBusy(submit, false);
    }
  }

  elements.downloadBackup.addEventListener('click', downloadBackup);

  elements.backupFile.addEventListener('change', event => {
    const file = event.target.files?.[0];
    if (!file) return;
    readBackupFile(file).catch(error => {
      selectedBackup = null;
      setStatus(elements.backupStatus, error.message, 'error');
    });
  });

  elements.testRestore.addEventListener('click', testRestore);
  elements.restore.addEventListener('click', restoreBackup);
  elements.refreshCopies.addEventListener('click', loadAutomaticCopies);
  elements.refreshOrders.addEventListener('click', loadOrders);

  elements.automaticCopies.addEventListener('click', event => {
    const button = event.target.closest('[data-restore-copy]');
    if (!button) return;
    void restoreAutomaticCopy(Number(button.dataset.restoreCopy));
  });

  elements.orderSelect.addEventListener('change', () => {
    const id = Number(elements.orderSelect.value);
    const order = orders.find(item => item.id === id);
    if (order) showOrder(order);
    else elements.form.hidden = true;
  });

  elements.addProduct.addEventListener('click', () => {
    elements.products.appendChild(productRow());
    calculateCorrectionTotal();
  });

  elements.products.addEventListener('click', event => {
    const button = event.target.closest('.remove-correction-product');
    if (!button) return;
    if (elements.products.children.length <= 1) {
      setStatus(
        elements.correctionStatus,
        'El pedido debe conservar al menos un producto.',
        'error'
      );
      return;
    }
    button.closest('.correction-product').remove();
    calculateCorrectionTotal();
  });

  elements.products.addEventListener('input', calculateCorrectionTotal);
  $('#correctionShipping').addEventListener('input', calculateCorrectionTotal);
  elements.form.addEventListener('submit', submitCorrection);

  let refreshPromise = null;

  function refreshProtectionData() {
    if (refreshPromise) return refreshPromise;

    refreshPromise = Promise.all([
      loadSummary(),
      loadOrders(),
      loadAutomaticCopies()
    ]).finally(() => {
      refreshPromise = null;
    });

    return refreshPromise;
  }

  elements.section?.addEventListener('toggle', () => {
    if (elements.section.open) {
      void refreshProtectionData();
    }
  });

  if (elements.adminApp) {
    const observer = new MutationObserver(() => {
      if (!elements.adminApp.classList.contains('hidden')) {
        void refreshProtectionData();
      }
    });

    observer.observe(elements.adminApp, {
      attributes: true,
      attributeFilter: ['class']
    });

    if (!elements.adminApp.classList.contains('hidden')) {
      void refreshProtectionData();
    }
  } else {
    void refreshProtectionData();
  }
})();
