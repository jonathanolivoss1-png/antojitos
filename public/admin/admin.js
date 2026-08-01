(function () {
  const ESTADOS = ['Pendiente', 'Confirmado', 'Preparando', 'En camino', 'Entregado', 'Cancelado'];

  const loginWrap = document.getElementById('loginWrap');
  const adminApp = document.getElementById('adminApp');
  const loginBtn = document.getElementById('loginBtn');
  const logoutBtn = document.getElementById('logoutBtn');
  const adminPasswordInput = document.getElementById('adminPassword');
  const loginError = document.getElementById('loginError');
  const toast = document.getElementById('adminToast');

  const tableBody = document.getElementById('adminOrdersTableBody');
  const exportCsvBtn = document.getElementById('exportCsvBtn');
  const exportDayCsvBtn = document.getElementById('exportDayCsvBtn');
  const deleteDayBtn = document.getElementById('deleteDayBtn');
  const dayFilterInput = document.getElementById('dayFilterInput');

  const detailModal = document.getElementById('orderDetailModal');
  const detailContent = document.getElementById('orderDetailContent');
  const closeDetailModal = document.getElementById('closeDetailModal');

  const statusModal = document.getElementById('orderStatusModal');
  const statusOrderIdInput = document.getElementById('statusOrderId');
  const statusSelect = document.getElementById('statusSelect');
  const saveStatusModalBtn = document.getElementById('saveStatusModal');
  const closeStatusModalBtn = document.getElementById('closeStatusModal');

  let currentOrders = [];
  let refreshTimer = null;
  const LEGACY_ORDERS_KEY = 'anafres_orders_v1';
  const DASHBOARD_REFRESH_MS = 6000;
  let undoDeleteDayState = null;
  let undoDeleteDayTimer = null;
  let undoBanner = null;

  function readLegacyOrders() {
    try {
      const raw = localStorage.getItem(LEGACY_ORDERS_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function writeLegacyOrders(orders) {
    localStorage.setItem(LEGACY_ORDERS_KEY, JSON.stringify(orders));
    if (typeof window.renderOrders === 'function') {
      window.renderOrders();
    }
  }

  function removeLegacyOrderById(orderId) {
    const previous = readLegacyOrders();
    const next = previous.filter(item => String(item?.id) !== String(orderId));
    if (next.length !== previous.length) {
      writeLegacyOrders(next);
    }
  }

  function updateLegacyOrderStatus(orderId, estado) {
    const previous = readLegacyOrders();
    const mappedStatus = estado === 'Entregado' ? 'entregado' : 'preparando';
    let changed = false;
    const next = previous.map(item => {
      if (String(item?.id) !== String(orderId)) return item;
      changed = true;
      return {
        ...item,
        status: mappedStatus
      };
    });

    if (changed) {
      writeLegacyOrders(next);
    }
  }

  function mapStatusToLegacy(estado) {
    const value = String(estado || '').toLowerCase();
    if (value === 'entregado') return 'entregado';
    if (value === 'cancelado') return 'enviado';
    if (value === 'preparado') return 'preparado';
    return 'preparando';
  }

  function syncLegacyOrdersFromApiOrders(orders) {
    const mapped = (orders || []).map(order => ({
      id: String(order.id),
      createdAt: order.fecha || new Date().toISOString(),
      deliveryType: order.tipoEntrega || '-',
      total: Number(order.total || 0),
      status: mapStatusToLegacy(order.estado),
      items: Array.isArray(order.productos)
        ? order.productos.map(item => ({
            qty: Number(item.qty || 1),
            name: item.name || 'Producto'
          }))
        : []
    }));

    writeLegacyOrders(mapped);
  }

  function showToast(message, isError) {
    if (!toast) return;
    toast.textContent = message;
    toast.style.background = isError ? 'rgba(167,51,25,0.96)' : 'rgba(46,125,50,0.96)';
    toast.classList.add('show');
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => toast.classList.remove('show'), 2200);
  }

  async function api(path, options) {
    const response = await fetch(path, {
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...(options && options.headers ? options.headers : {})
      },
      ...options
    });

    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(data?.message || 'Error de API');
      error.status = response.status;
      throw error;
    }

    return data;
  }

  function setAuthenticated(isAuthed) {
    if (!loginWrap || !adminApp) return;
    loginWrap.classList.toggle('hidden', isAuthed);
    adminApp.classList.toggle('hidden', !isAuthed);
  }

  function formatMoney(value) {
    return new Intl.NumberFormat('es-MX', {
      style: 'currency',
      currency: 'MXN',
      maximumFractionDigits: 2
    }).format(Number(value || 0));
  }

  function formatDate(value) {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '-';
    return d.toLocaleString('es-MX', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  function statusClass(status) {
    return String(status || 'Pendiente')
      .toLowerCase()
      .replace(/\s+/g, '-');
  }

  function mapProducts(items) {
    if (!Array.isArray(items) || !items.length) return 'Sin productos';
    return items.map(item => `${Number(item.qty || 1)}x ${item.name || 'Producto'}`).join(' | ');
  }

  function renderStats(stats) {
    const safe = stats || {};
    document.getElementById('kpiTotalPedidos').textContent = Number(safe.totalPedidos || 0);
    document.getElementById('kpiPendientes').textContent = Number(safe.pedidosPendientes || 0);
    document.getElementById('kpiEntregados').textContent = Number(safe.pedidosEntregados || 0);
    document.getElementById('kpiVentasDia').textContent = formatMoney(safe.ventasDia || 0);
    document.getElementById('kpiVentasMes').textContent = formatMoney(safe.ventasMes || 0);
    document.getElementById('kpiTotalVendido').textContent = formatMoney(safe.totalVendido || 0);
    document.getElementById('kpiPromedio').textContent = formatMoney(safe.promedioPorPedido || 0);

    const producto = safe.productoMasVendido || 'Sin datos';
    const cantidad = Number(safe.productoMasVendidoCantidad || 0);
    document.getElementById('kpiProductoTop').textContent = cantidad > 0 ? `${producto} (${cantidad})` : producto;
  }

  function renderOrders(orders) {
    if (!tableBody) return;

    if (!orders.length) {
      tableBody.innerHTML = '<tr><td colspan="10">Todavía no hay pedidos registrados.</td></tr>';
      return;
    }

    tableBody.innerHTML = orders.map(order => {
      const estado = order.estado || 'Pendiente';
      const productos = Array.isArray(order.productos) ? order.productos : [];

      return `
        <tr data-order-id="${order.id}">
          <td>#${order.id}</td>
          <td>${order.cliente || '-'}</td>
          <td>${order.telefono || '-'}</td>
          <td>${order.direccion || '-'}</td>
          <td>${order.tipoEntrega || '-'}</td>
          <td><div class="admin-order-products">${productos.map(item => `<span>${Number(item.qty || 1)}x ${item.name || 'Producto'}</span>`).join('')}</div></td>
          <td>${formatMoney(order.total || 0)}</td>
          <td><span class="status-chip ${statusClass(estado)}">${estado}</span></td>
          <td>${formatDate(order.fecha)}</td>
          <td>
            <div class="admin-row-actions">
              <button type="button" data-action="view">Ver</button>
              <button type="button" data-action="status">Editar estado</button>
              <button type="button" data-action="delete">Eliminar</button>
            </div>
          </td>
        </tr>
      `;
    }).join('');
  }

  function openModal(modal) {
    if (!modal) return;
    modal.classList.add('open');
    modal.setAttribute('aria-hidden', 'false');
  }

  function closeModal(modal) {
    if (!modal) return;
    modal.classList.remove('open');
    modal.setAttribute('aria-hidden', 'true');
  }

  function showOrderDetail(order) {
    if (!detailContent) return;

    const rows = [
      ['Cliente', order.cliente || '-'],
      ['Teléfono', order.telefono || '-'],
      ['Dirección', order.direccion || '-'],
      ['Tipo de entrega', order.tipoEntrega || '-'],
      ['Productos', mapProducts(order.productos)],
      ['Subtotal', formatMoney(order.subtotal || 0)],
      ['Costo de envío', formatMoney(order.envio || 0)],
      ['Total', formatMoney(order.total || 0)],
      ['Hora', formatDate(order.fecha)],
      ['Estado', order.estado || 'Pendiente']
    ];

    detailContent.innerHTML = rows.map(([label, value]) => `
      <div class="admin-modal-row">
        <strong>${label}</strong>
        <span>${value}</span>
      </div>
    `).join('');

    openModal(detailModal);
  }

  function openStatusEditor(order) {
    if (!statusOrderIdInput || !statusSelect) return;
    statusOrderIdInput.value = String(order.id);
    statusSelect.innerHTML = ESTADOS.map(status => `<option value="${status}" ${status === order.estado ? 'selected' : ''}>${status}</option>`).join('');
    openModal(statusModal);
  }

  async function loadDashboardData() {
    try {
      const [statsResult, pedidosResult] = await Promise.all([
        api('/api/admin/stats'),
        api('/api/pedidos')
      ]);

      renderStats(statsResult.stats || {});
      currentOrders = Array.isArray(pedidosResult.pedidos) ? pedidosResult.pedidos : [];
      renderOrders(currentOrders);
      syncLegacyOrdersFromApiOrders(currentOrders);

      if (typeof window.renderOrders === 'function') {
        window.renderOrders();
      }
    } catch (error) {
      if (error.status === 401) {
        setAuthenticated(false);
        stopRefresh();
        return;
      }
      showToast('No se pudo actualizar el dashboard', true);
    }
  }

  function getTodayDateKey() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function getSelectedDateKey() {
    const fallback = getTodayDateKey();
    const value = String(dayFilterInput?.value || '').trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : fallback;
  }

  async function deleteOrdersByDay() {
    const date = getSelectedDateKey();
    const confirmed = window.confirm(`¿Eliminar todos los pedidos del día ${date}?`);
    if (!confirmed) return;

    try {
      const result = await api(`/api/pedidos/day?date=${encodeURIComponent(date)}`, {
        method: 'DELETE'
      });
      showToast(`Se eliminaron ${Number(result.deletedCount || 0)} pedidos del día`);
      startUndoDeleteDay(result.date, Array.isArray(result.deletedOrders) ? result.deletedOrders : []);
      await loadDashboardData();
    } catch (error) {
      showToast(error.message || 'No se pudieron eliminar pedidos del día', true);
    }
  }

  function removeUndoBanner() {
    if (undoBanner && undoBanner.parentElement) {
      undoBanner.parentElement.removeChild(undoBanner);
    }
    undoBanner = null;
  }

  function clearUndoDeleteDay() {
    undoDeleteDayState = null;
    if (undoDeleteDayTimer) {
      clearTimeout(undoDeleteDayTimer);
      undoDeleteDayTimer = null;
    }
    removeUndoBanner();
  }

  function startUndoDeleteDay(date, orders) {
    clearUndoDeleteDay();

    if (!orders.length) return;

    undoDeleteDayState = { date, orders };

    undoBanner = document.createElement('div');
    undoBanner.className = 'undo-banner';
    undoBanner.innerHTML = `
      <span>Pedidos del ${date} eliminados.</span>
      <button type="button" class="undo-banner-btn" data-action="undo-day-delete">Deshacer</button>
    `;

    const undoBtn = undoBanner.querySelector('[data-action="undo-day-delete"]');
    if (undoBtn) {
      undoBtn.addEventListener('click', undoDeleteDay);
    }

    document.body.appendChild(undoBanner);

    undoDeleteDayTimer = setTimeout(() => {
      clearUndoDeleteDay();
    }, 10000);
  }

  async function undoDeleteDay() {
    if (!undoDeleteDayState) return;

    const payload = undoDeleteDayState;
    clearUndoDeleteDay();

    try {
      const result = await api('/api/pedidos/day/restore', {
        method: 'POST',
        body: JSON.stringify({ orders: payload.orders })
      });
      showToast(`Se restauraron ${Number(result.restoredCount || 0)} pedidos`);
      await loadDashboardData();
    } catch (error) {
      showToast(error.message || 'No se pudieron restaurar pedidos', true);
    }
  }

  function startRefresh() {
    stopRefresh();
    refreshTimer = setInterval(() => {
      if (document.visibilityState === 'visible') {
        loadDashboardData();
      }
    }, DASHBOARD_REFRESH_MS);
  }

  function stopRefresh() {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
  }

  async function checkSession() {
    try {
      const result = await api('/api/session', { method: 'GET' });
      const isAuthed = Boolean(result && result.authenticated);
      setAuthenticated(isAuthed);

      if (isAuthed) {
        await loadDashboardData();
        startRefresh();
      } else {
        stopRefresh();
      }
    } catch {
      setAuthenticated(false);
      stopRefresh();
    }
  }

  async function handleLogin(event) {
    event.preventDefault();
    event.stopImmediatePropagation();

    const password = String(adminPasswordInput?.value || '');
    if (!password) {
      loginError.textContent = 'Escribe la contraseña.';
      return;
    }

    try {
      await api('/api/login', {
        method: 'POST',
        body: JSON.stringify({
          usuario: 'admin',
          password
        })
      });

      loginError.textContent = '';
      if (adminPasswordInput) adminPasswordInput.value = '';
      setAuthenticated(true);
      await loadDashboardData();
      startRefresh();
      showToast('Sesión iniciada');
    } catch {
      loginError.textContent = 'Contraseña incorrecta.';
    }
  }

  async function handleLogout(event) {
    event.preventDefault();
    event.stopImmediatePropagation();

    try {
      await api('/api/logout', { method: 'POST' });
    } catch {
      // no-op
    }

    setAuthenticated(false);
    stopRefresh();
    showToast('Sesión cerrada');
  }

  async function handleTableActions(event) {
    const button = event.target.closest('button[data-action]');
    if (!button) return;

    const row = button.closest('tr[data-order-id]');
    if (!row) return;

    const id = Number(row.dataset.orderId);
    const order = currentOrders.find(item => Number(item.id) === id);
    if (!order) return;

    const action = button.dataset.action;
    if (action === 'view') {
      showOrderDetail(order);
      return;
    }

    if (action === 'status') {
      openStatusEditor(order);
      return;
    }

    if (action === 'delete') {
      const confirmed = window.confirm(`¿Eliminar el pedido #${order.id}?`);
      if (!confirmed) return;

      try {
        await api(`/api/pedidos/${order.id}`, { method: 'DELETE' });
        removeLegacyOrderById(order.id);
        showToast('Pedido eliminado');
        await loadDashboardData();
      } catch {
        showToast('No se pudo eliminar el pedido', true);
      }
    }
  }

  async function saveStatusChange() {
    const orderId = Number(statusOrderIdInput?.value || 0);
    const estado = statusSelect?.value || 'Pendiente';

    if (!orderId) return;

    try {
      await api(`/api/pedidos/${orderId}`, {
        method: 'PUT',
        body: JSON.stringify({ estado })
      });
      updateLegacyOrderStatus(orderId, estado);
      closeModal(statusModal);
      showToast('Estado actualizado');
      await loadDashboardData();
    } catch {
      showToast('No se pudo actualizar el estado', true);
    }
  }

  function bindEvents() {
    if (dayFilterInput && !dayFilterInput.value) {
      dayFilterInput.value = getTodayDateKey();
    }

    if (loginBtn) {
      loginBtn.addEventListener('click', handleLogin, true);
    }

    if (adminPasswordInput) {
      adminPasswordInput.addEventListener('keydown', event => {
        if (event.key === 'Enter') {
          handleLogin(event);
        }
      });
    }

    if (logoutBtn) {
      logoutBtn.addEventListener('click', handleLogout, true);
    }

    if (tableBody) {
      tableBody.addEventListener('click', handleTableActions);
    }

    if (exportCsvBtn) {
      exportCsvBtn.addEventListener('click', () => {
        window.location.href = '/api/pedidos/export/csv/all';
      });
    }

    if (exportDayCsvBtn) {
      exportDayCsvBtn.addEventListener('click', () => {
        const date = getSelectedDateKey();
        window.location.href = `/api/pedidos/day/export/csv?date=${encodeURIComponent(date)}`;
      });
    }

    if (deleteDayBtn) {
      deleteDayBtn.addEventListener('click', deleteOrdersByDay);
    }

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && !adminApp.classList.contains('hidden')) {
        loadDashboardData();
        startRefresh();
      } else if (document.visibilityState !== 'visible') {
        stopRefresh();
      }
    });

    window.addEventListener('focus', () => {
      if (!adminApp.classList.contains('hidden')) {
        loadDashboardData();
      }
    });

    if (closeDetailModal) {
      closeDetailModal.addEventListener('click', () => closeModal(detailModal));
    }

    if (closeStatusModalBtn) {
      closeStatusModalBtn.addEventListener('click', () => closeModal(statusModal));
    }

    if (saveStatusModalBtn) {
      saveStatusModalBtn.addEventListener('click', saveStatusChange);
    }

    [detailModal, statusModal].forEach(modal => {
      if (!modal) return;
      modal.addEventListener('click', event => {
        if (event.target === modal) {
          closeModal(modal);
        }
      });
    });
  }

  bindEvents();
  checkSession();
})();
