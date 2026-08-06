// REMOVE_LEGACY_BACKUP_AND_CASH_CLOSING_V1
(function () {
  const ESTADOS = ['Confirmado', 'Entregado', 'Cancelado'];
  // EDITABLE_ORDER_STATES_V1: el Dashboard solo permite estos tres estados.

  const loginWrap = document.getElementById('loginWrap');
  const adminApp = document.getElementById('adminApp');
  const loginBtn = document.getElementById('loginBtn');
  const logoutBtn = document.getElementById('logoutBtn');
  const orderAlertsToggleBtn =
    document.getElementById('orderAlertsToggleBtn');
  const orderAlertsTestBtn =
    document.getElementById('orderAlertsTestBtn');
  const orderAlertsVolumeWrap =
    document.getElementById('orderAlertsVolumeWrap');
  const orderAlertsVolumeInput =
    document.getElementById('orderAlertsVolumeInput');
  const orderAlertsStatus =
    document.getElementById('orderAlertsStatus');

  const adminPasswordInput = document.getElementById('adminPassword');
  const loginError = document.getElementById('loginError');
  const toast = document.getElementById('adminToast');
  const heroBadgeInput = document.getElementById('heroBadgeInput');
  const heroTitleInput = document.getElementById('heroTitleInput');
  const heroTextInput = document.getElementById('heroTextInput');
  const heroRecommendationsInput = document.getElementById('heroRecommendationsInput');
  const saveContentBtn = document.getElementById('saveContentBtn');
  const newPasswordInput = document.getElementById('newPasswordInput');
  const saveConfigBtn = document.getElementById('saveConfigBtn');

  const tableBody = document.getElementById('adminOrdersTableBody');
  const exportCsvBtn = document.getElementById('exportCsvBtn');
  const exportDayCsvBtn = document.getElementById('exportDayCsvBtn');
  const deleteDayBtn = document.getElementById('deleteDayBtn');
  const dayFilterInput = document.getElementById('dayFilterInput');

  // ADMIN_BUSINESS_TOOLS_V1: referencias
  const orderSearchInput = document.getElementById('orderSearchInput');
  const orderStatusFilter = document.getElementById('orderStatusFilter');
  const orderDeliveryFilter = document.getElementById('orderDeliveryFilter');
  const orderSortSelect = document.getElementById('orderSortSelect');
  const orderFiltersClearBtn = document.getElementById('orderFiltersClearBtn');
  const orderFilterCount = document.getElementById('orderFilterCount');

  const soldProductsTodayBtn = document.getElementById('soldProductsTodayBtn');
  const soldProductsStartDateInput = document.getElementById('soldProductsStartDate');
  const soldProductsEndDateInput = document.getElementById('soldProductsEndDate');
  const soldProductsApplyBtn = document.getElementById('soldProductsApplyBtn');
  const soldProductsResetBtn = document.getElementById('soldProductsResetBtn');
  const soldProductsRangeLabel = document.getElementById('soldProductsRangeLabel');
  const soldProductsTableBody = document.getElementById('soldProductsTableBody');
  const soldProductsSeparatedTableBody = document.getElementById('soldProductsSeparatedTableBody');
  const soldProductsDifferentCount = document.getElementById('soldProductsDifferentCount');
  const soldProductsUnitsCount = document.getElementById('soldProductsUnitsCount');
  const soldProductsRevenueTotal = document.getElementById('soldProductsRevenueTotal');
  const soldProductsSeparatedDifferentCount = document.getElementById('soldProductsSeparatedDifferentCount');
  const soldProductsSeparatedUnitsCount = document.getElementById('soldProductsSeparatedUnitsCount');
  const soldProductsSeparatedRevenueTotal = document.getElementById('soldProductsSeparatedRevenueTotal');
  const soldProductsClearSeparatedBtn = document.getElementById('soldProductsClearSeparatedBtn');

  const detailModal = document.getElementById('orderDetailModal');
  const detailContent = document.getElementById('orderDetailContent');
  const closeDetailModal = document.getElementById('closeDetailModal');

  const calculatorProductsRoot = document.getElementById('calculatorProducts');
  const calculatorAddProductBtn = document.getElementById('calculatorAddProductBtn');
  const calculatorClearBtn = document.getElementById('calculatorClearBtn');
  const calculatorUseDashboardToggle = document.getElementById('calculatorUseDashboardToggle');
  const calculatorSalesStartDateInput = document.getElementById('calculatorSalesStartDate');
  const calculatorSalesEndDateInput = document.getElementById('calculatorSalesEndDate');
  const calculatorLoadSalesRangeBtn = document.getElementById('calculatorLoadSalesRangeBtn');
  const calculatorSalesRangeLabel = document.getElementById('calculatorSalesRangeLabel');
  const calculatorIncomeInput = document.getElementById('calculatorIncomeInput');
  const calculatorExpensesTotal = document.getElementById('calculatorExpensesTotal');
  const calculatorIncomeTotal = document.getElementById('calculatorIncomeTotal');
  const calculatorFinalResult = document.getElementById('calculatorFinalResult');
  const calculatorResultState = document.getElementById('calculatorResultState');
  const calculatorResultMessage = document.getElementById('calculatorResultMessage');

  const statusModal = document.getElementById('orderStatusModal');
  const statusOrderIdInput = document.getElementById('statusOrderId');
  const statusSelect = document.getElementById('statusSelect');
  const saveStatusModalBtn = document.getElementById('saveStatusModal');
  const closeStatusModalBtn = document.getElementById('closeStatusModal');

  let currentOrders = [];

  let advancedAdminFeaturesBound = false;
  let calculatorProducts = [];
  let refreshTimer = null;
  let adminEventsStream = null;
  const ORDER_ALERTS_SETTINGS_KEY =
    'anafres_order_alerts_settings_v1';

  let orderAlertAudioContext = null;
  let orderAlertTitleTimer = null;
  let orderAlertOriginalTitle =
    document.title;

  let orderAlertsSettings =
    readOrderAlertsSettings();

  let soldProductsFilter = null;
  let dashboardRevenue = 0;
  let manualIncomeValue = 0;
  let calculatorSalesStartDate = '';
  let calculatorSalesEndDate = '';
  let calculatorSalesRangeLoaded = false;
  let calculatorDraftUpdatedAt = 0;
  let calculatorDraftSyncRetryNeeded = false;
  let allowEmptyDraftOverrideOnce = false;
  const ORDER_REFRESH_KEY = 'anafres_order_refresh_v1';
  const LEGACY_ORDERS_KEY = 'anafres_orders_v1';
  const CALCULATOR_DRAFT_KEY = 'anafres_calculator_draft_v1';
  const DASHBOARD_REFRESH_MS = 30000;
  let undoDeleteDayState = null;
  let undoDeleteDayTimer = null;
  let undoBanner = null;
  let soldProductsSeparatedNames = new Set();

  function normalizeSoldProductName(value) {
    return String(value || '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ');
  }

  function applySeparatedNamesFromServer(names) {
    const list = Array.isArray(names) ? names : [];
    soldProductsSeparatedNames = new Set(list.map(normalizeSoldProductName).filter(Boolean));
  }

  function summarizeSoldItems(items) {
    return (Array.isArray(items) ? items : []).reduce((acc, item) => {
      acc.differentProducts += 1;
      acc.totalUnits += Number(item?.quantitySold || 0);
      acc.totalRevenue += Number(item?.totalAmount || 0);
      return acc;
    }, {
      differentProducts: 0,
      totalUnits: 0,
      totalRevenue: 0
    });
  }

  function updateSoldProductsSummary(summary, prefix) {
    const differentEl = prefix === 'separated' ? soldProductsSeparatedDifferentCount : soldProductsDifferentCount;
    const unitsEl = prefix === 'separated' ? soldProductsSeparatedUnitsCount : soldProductsUnitsCount;
    const revenueEl = prefix === 'separated' ? soldProductsSeparatedRevenueTotal : soldProductsRevenueTotal;

    if (differentEl) differentEl.textContent = Number(summary?.differentProducts || 0);
    if (unitsEl) unitsEl.textContent = Number(summary?.totalUnits || 0);
    if (revenueEl) revenueEl.textContent = formatCurrency(summary?.totalRevenue || 0);
  }

  function renderSoldProductsRows(targetBody, items, mode) {
    if (!targetBody) return;
    const isSeparated = mode === 'separated';
    const emptyMessage = isSeparated
      ? 'Aún no hay productos separados para este periodo'
      : 'No se encontraron productos vendidos durante este periodo';

    if (!items.length) {
      targetBody.innerHTML = `<tr><td colspan="5">${emptyMessage}</td></tr>`;
      return;
    }

    targetBody.innerHTML = items.map(item => `
      <tr>
        <td>${escapeHtml(item.name || 'Producto')}</td>
        <td>${Number(item.quantitySold || 0)}</td>
        <td>${formatCurrency(item.unitPrice || 0)}</td>
        <td>${formatCurrency(item.totalAmount || 0)}</td>
        <td>
          <button
            class="sold-products-row-action"
            type="button"
            data-action="${isSeparated ? 'restore-sold-product' : 'separate-sold-product'}"
            data-product-name="${escapeHtml(item.name || '')}"
          >${isSeparated ? 'Regresar' : 'Separar'}</button>
        </td>
      </tr>
    `).join('');
  }

  function readLegacyOrders() {
    return [];
  }

  function writeLegacyOrders(orders) {
    return;
  }

  function buildCalculatorDraftPayload() {
    return {
      products: calculatorProducts
        .map(item => ({
          id: String(item?.id || ''),
          name: String(item?.name || ''),
          qty: Math.max(0, Number(item?.qty || 0)),
          price: Math.max(0, Number(item?.price || 0))
        }))
        .filter(item => String(item.name || '').trim() || Number(item.price || 0) > 0),
      manualIncomeValue: Math.max(0, Number(manualIncomeValue || 0)),
      useDashboardRevenue: isUsingDashboardRevenue(),
      salesStartDate: calculatorSalesStartDate,
      salesEndDate: calculatorSalesEndDate,
      updatedAt: Math.max(0, Number(calculatorDraftUpdatedAt || 0))
    };
  }

  function applyCalculatorDraft(draft) {
    const incomingProducts = Array.isArray(draft?.products)
      ? draft.products
          .map(item => ({
            id: String(item?.id || createCalculatorProduct().id),
            name: String(item?.name || ''),
            qty: Math.max(0, Number(item?.qty || 0)),
            price: Math.max(0, Number(item?.price || 0))
          }))
          .filter(item => String(item.name || '').trim() || Number(item.price || 0) > 0)
      : [];

    calculatorProducts = incomingProducts.length ? incomingProducts : [createCalculatorProduct()];
    manualIncomeValue = Math.max(0, Number(draft?.manualIncomeValue || 0));
    calculatorDraftUpdatedAt = Math.max(0, Number(draft?.updatedAt || 0));

    const calculatorToday =
      typeof getMexicoCityDateKey === 'function'
        ? getMexicoCityDateKey()
        : getTodayDateKey();

    calculatorSalesStartDate =
      isValidCalculatorDateKey(
        draft?.salesStartDate
      )
        ? draft.salesStartDate
        : calculatorToday;

    calculatorSalesEndDate =
      isValidCalculatorDateKey(
        draft?.salesEndDate
      )
        ? draft.salesEndDate
        : calculatorSalesStartDate;

    calculatorSalesRangeLoaded =
      false;

    ensureCalculatorSalesRangeDefaults();

    if (calculatorUseDashboardToggle) {
      calculatorUseDashboardToggle.checked = Boolean(draft?.useDashboardRevenue ?? true);
    }
  }

  async function pushCalculatorDraftToServer() {
    try {
      if (adminApp?.classList.contains('hidden')) return;
      await api('/api/admin/calculadora/draft', {
        method: 'PUT',
        body: JSON.stringify({
          draft: buildCalculatorDraftPayload(),
          allowEmptyOverride: allowEmptyDraftOverrideOnce
        })
      });
      calculatorDraftSyncRetryNeeded = false;
      allowEmptyDraftOverrideOnce = false;
    } catch (error) {
      calculatorDraftSyncRetryNeeded = true;
      if (error.status !== 401) {
        console.warn('No se pudo sincronizar el borrador de calculadora', error);
      }
    }
  }

  async function hydrateCalculatorDraftFromServer() {
    try {
      const result = await api('/api/admin/calculadora/draft');
      if (result?.draft) {
        const remoteUpdatedAt = Math.max(0, Number(result.draft.updatedAt || 0));
        const localUpdatedAt = Math.max(0, Number(calculatorDraftUpdatedAt || 0));

        if (remoteUpdatedAt > localUpdatedAt) {
          applyCalculatorDraft(result.draft);
          renderCalculatorProducts();
        } else {
          await pushCalculatorDraftToServer();
        }
        return;
      }

      await pushCalculatorDraftToServer();
    } catch (error) {
      calculatorDraftSyncRetryNeeded = true;
      if (error.status !== 401) {
        console.warn('No se pudo cargar el borrador remoto de calculadora', error);
      }
    }
  }

  function saveCalculatorDraft() {
    calculatorDraftUpdatedAt = Math.max(Date.now(), Number(calculatorDraftUpdatedAt || 0) + 1);
    void pushCalculatorDraftToServer();
  }

  function loadCalculatorDraft() {
    applyCalculatorDraft({ products: [createCalculatorProduct()], manualIncomeValue: 0, useDashboardRevenue: true, updatedAt: 0 });
    renderCalculatorProducts();
    void hydrateCalculatorDraftFromServer();
  }

  function removeLegacyOrderById(orderId) {
    const previous = readLegacyOrders();
    const next = previous.filter(item => String(item?.id) !== String(orderId));
    if (next.length !== previous.length) {
      writeLegacyOrders(next);
    }
  }

  function updateLegacyOrderStatus(orderId, estado) {
    return;
  }

  function mapStatusToLegacy(estado) {
    const value = String(estado || '').toLowerCase();
    if (value === 'entregado') return 'entregado';
    if (value === 'cancelado') return 'enviado';
    if (value === 'preparado') return 'preparado';
    return 'preparando';
  }

  function syncLegacyOrdersFromApiOrders(orders) {
    return;
  }

  // === NEW_ORDER_ALERTS_CLIENT_V1 ===
  function readOrderAlertsSettings() {
    const defaults = {
      enabled: false,
      volume: 0.75,
      lastEventKey: ''
    };

    try {
      const parsed = JSON.parse(
        localStorage.getItem(
          ORDER_ALERTS_SETTINGS_KEY
        ) || 'null'
      );

      if (
        !parsed ||
        typeof parsed !== 'object'
      ) {
        return defaults;
      }

      return {
        enabled:
          Boolean(parsed.enabled),

        volume:
          Math.min(
            1,
            Math.max(
              0,
              Number(parsed.volume ?? 0.75)
            )
          ),

        lastEventKey:
          String(
            parsed.lastEventKey || ''
          )
      };
    } catch {
      return defaults;
    }
  }

  function saveOrderAlertsSettings() {
    try {
      localStorage.setItem(
        ORDER_ALERTS_SETTINGS_KEY,
        JSON.stringify(
          orderAlertsSettings
        )
      );
    } catch {
      // El sonido puede seguir funcionando
      // aunque el almacenamiento esté bloqueado.
    }
  }

  function getNotificationPermissionState() {
    if (
      !('Notification' in window)
    ) {
      return 'unsupported';
    }

    return Notification.permission;
  }

  function updateOrderAlertsUi() {
    const enabled =
      Boolean(
        orderAlertsSettings.enabled
      );

    const permission =
      getNotificationPermissionState();

    if (orderAlertsToggleBtn) {
      orderAlertsToggleBtn.classList.toggle(
        'is-enabled',
        enabled
      );

      orderAlertsToggleBtn.setAttribute(
        'aria-pressed',
        String(enabled)
      );

      orderAlertsToggleBtn.textContent =
        enabled
          ? '🔕 Desactivar alertas'
          : '🔔 Activar alertas';
    }

    if (orderAlertsTestBtn) {
      orderAlertsTestBtn.classList.toggle(
        'hidden',
        !enabled
      );
    }

    if (orderAlertsVolumeWrap) {
      orderAlertsVolumeWrap.classList.toggle(
        'hidden',
        !enabled
      );
    }

    if (orderAlertsVolumeInput) {
      orderAlertsVolumeInput.value =
        String(
          orderAlertsSettings.volume
        );
    }

    if (!orderAlertsStatus) {
      return;
    }

    if (!enabled) {
      orderAlertsStatus.textContent =
        'Las alertas están desactivadas en este dispositivo.';

      return;
    }

    if (permission === 'granted') {
      orderAlertsStatus.textContent =
        'Sonido y notificaciones del sistema activos.';

      return;
    }

    if (permission === 'denied') {
      orderAlertsStatus.textContent =
        'Sonido activo. Las notificaciones están bloqueadas por el navegador.';

      return;
    }

    if (permission === 'unsupported') {
      orderAlertsStatus.textContent =
        'Sonido activo. Este navegador no admite notificaciones del sistema.';

      return;
    }

    orderAlertsStatus.textContent =
      'Sonido activo. Falta autorizar las notificaciones del sistema.';
  }

  async function ensureOrderAlertAudioContext() {
    const AudioContextClass =
      window.AudioContext ||
      window.webkitAudioContext;

    if (!AudioContextClass) {
      return null;
    }

    if (!orderAlertAudioContext) {
      orderAlertAudioContext =
        new AudioContextClass();
    }

    if (
      orderAlertAudioContext.state ===
      'suspended'
    ) {
      await orderAlertAudioContext
        .resume()
        .catch(() => {});
    }

    return orderAlertAudioContext;
  }

  async function playNewOrderSound() {
    if (
      !orderAlertsSettings.enabled
    ) {
      return;
    }

    const context =
      await ensureOrderAlertAudioContext();

    if (!context) {
      return;
    }

    const volume =
      Math.min(
        1,
        Math.max(
          0,
          Number(
            orderAlertsSettings.volume ||
            0
          )
        )
      );

    if (volume <= 0) {
      return;
    }

    const now = context.currentTime;

    [
      {
        frequency: 740,
        start: 0,
        duration: 0.16
      },
      {
        frequency: 988,
        start: 0.18,
        duration: 0.18
      },
      {
        frequency: 1318,
        start: 0.39,
        duration: 0.28
      }
    ].forEach(note => {
      const oscillator =
        context.createOscillator();

      const gain =
        context.createGain();

      oscillator.type = 'sine';

      oscillator.frequency.setValueAtTime(
        note.frequency,
        now + note.start
      );

      gain.gain.setValueAtTime(
        0.0001,
        now + note.start
      );

      gain.gain.exponentialRampToValueAtTime(
        Math.max(
          0.0001,
          volume * 0.28
        ),
        now + note.start + 0.025
      );

      gain.gain.exponentialRampToValueAtTime(
        0.0001,
        now +
          note.start +
          note.duration
      );

      oscillator.connect(gain);
      gain.connect(context.destination);

      oscillator.start(
        now + note.start
      );

      oscillator.stop(
        now +
          note.start +
          note.duration +
          0.03
      );
    });
  }

  async function requestOrderNotificationPermission() {
    if (
      !('Notification' in window)
    ) {
      return 'unsupported';
    }

    if (
      Notification.permission !==
      'default'
    ) {
      return Notification.permission;
    }

    try {
      return await Notification
        .requestPermission();
    } catch {
      return Notification.permission;
    }
  }

  async function ensureOrderAlertServiceWorker() {
    if (
      !('serviceWorker' in navigator) ||
      !window.isSecureContext
    ) {
      return null;
    }

    try {
      let registration =
        await navigator.serviceWorker
          .getRegistration('/');

      if (!registration) {
        registration =
          await navigator.serviceWorker
            .register(
              '/sw.js',
              {
                scope: '/'
              }
            );
      }

      return await navigator
        .serviceWorker
        .ready;
    } catch (error) {
      console.warn(
        'No se pudo preparar el service worker para alertas',
        error
      );

      return null;
    }
  }

  function flashNewOrderTitle(orderId) {
    if (orderAlertTitleTimer) {
      clearInterval(
        orderAlertTitleTimer
      );
    }

    orderAlertOriginalTitle =
      orderAlertOriginalTitle ||
      document.title;

    let showAlert = true;
    let repetitions = 0;

    document.title =
      `🔔 Nuevo pedido #${orderId}`;

    orderAlertTitleTimer =
      setInterval(
        () => {
          showAlert = !showAlert;

          document.title =
            showAlert
              ? `🔔 Nuevo pedido #${orderId}`
              : orderAlertOriginalTitle;

          repetitions += 1;

          if (repetitions >= 12) {
            clearInterval(
              orderAlertTitleTimer
            );

            orderAlertTitleTimer =
              null;

            document.title =
              orderAlertOriginalTitle;
          }
        },
        850
      );
  }

  function focusOrderFromNotification(
    orderId
  ) {
    window.focus();

    const row =
      document.querySelector(
        `tr[data-order-id="${CSS.escape(
          String(orderId || '')
        )}"]`
      );

    if (!row) {
      return;
    }

    row.scrollIntoView({
      behavior: 'smooth',
      block: 'center'
    });

    row.animate(
      [
        {
          outline:
            '4px solid rgba(249,168,37,0.9)',
          transform:
            'scale(1.01)'
        },
        {
          outline:
            '0 solid transparent',
          transform:
            'scale(1)'
        }
      ],
      {
        duration: 1800,
        easing: 'ease-out'
      }
    );
  }

  async function showOrderSystemNotification(
    order
  ) {
    if (
      getNotificationPermissionState() !==
      'granted'
    ) {
      return;
    }

    const orderId =
      String(
        order?.id || 'nuevo'
      );

    const title =
      `Nuevo pedido #${orderId}`;

    const customer =
      String(
        order?.cliente ||
        'Cliente sin nombre'
      );

    const delivery =
      String(
        order?.tipoEntrega ||
        'Pedido nuevo'
      );

    const total =
      formatMoney(
        Number(order?.total || 0)
      );

    const body =
      `${customer} · ${delivery} · ${total}`;

    const targetUrl =
      `/admin/index.html?pedido=${encodeURIComponent(
        orderId
      )}`;

    const options = {
      body,
      tag:
        `anafres-new-order-${orderId}`,
      renotify: true,
      data: {
        url: targetUrl,
        orderId
      }
    };

    const registration =
      await ensureOrderAlertServiceWorker();

    if (
      registration &&
      typeof registration.showNotification ===
      'function'
    ) {
      await registration
        .showNotification(
          title,
          options
        )
        .catch(error => {
          console.warn(
            'No se pudo mostrar la notificación mediante el service worker',
            error
          );
        });

      return;
    }

    try {
      const notification =
        new Notification(
          title,
          options
        );

      notification.onclick = () => {
        notification.close();

        focusOrderFromNotification(
          orderId
        );
      };
    } catch (error) {
      console.warn(
        'No se pudo mostrar la notificación del sistema',
        error
      );
    }
  }

  async function notifyNewOrder(
    order,
    options = {}
  ) {
    if (
      !orderAlertsSettings.enabled
    ) {
      return;
    }

    const orderId =
      String(
        order?.id ||
        'nuevo'
      );

    const eventKey =
      String(
        options.eventKey ||
        orderId
      );

    if (
      !options.isTest &&
      eventKey &&
      eventKey ===
        orderAlertsSettings.lastEventKey
    ) {
      return;
    }

    if (
      !options.isTest &&
      eventKey
    ) {
      orderAlertsSettings.lastEventKey =
        eventKey;

      saveOrderAlertsSettings();
    }

    await playNewOrderSound();

    flashNewOrderTitle(
      orderId
    );

    await showOrderSystemNotification(
      order
    );

    showToast(
      options.isTest
        ? 'Alerta de prueba reproducida'
        : `¡Nuevo pedido #${orderId}!`
    );
  }

  function parseAdminEventPayload(event) {
    try {
      return JSON.parse(
        event?.data || '{}'
      );
    } catch {
      return {};
    }
  }

  async function handleOrdersUpdatedEvent(
    event
  ) {
    const payload =
      parseAdminEventPayload(event);

    if (
      !adminApp.classList.contains(
        'hidden'
      )
    ) {
      await loadDashboardData();
      await loadSoldProductsData();
    }

    if (
      payload?.reason !==
      'created'
    ) {
      return;
    }

    const order =
      payload?.order &&
      typeof payload.order ===
        'object'
        ? payload.order
        : {};

    const eventKey =
      String(
        order.id ||
        payload.ts ||
        ''
      );

    await notifyNewOrder(
      order,
      {
        eventKey
      }
    );
  }

  async function toggleOrderAlerts() {
    if (
      orderAlertsSettings.enabled
    ) {
      orderAlertsSettings.enabled =
        false;

      saveOrderAlertsSettings();
      updateOrderAlertsUi();

      showToast(
        'Alertas de pedidos desactivadas'
      );

      return;
    }

    orderAlertsSettings.enabled =
      true;

    await ensureOrderAlertAudioContext();

    const permission =
      await requestOrderNotificationPermission();

    if (
      permission === 'granted'
    ) {
      await ensureOrderAlertServiceWorker();
    }

    saveOrderAlertsSettings();
    updateOrderAlertsUi();

    await playNewOrderSound();

    if (permission === 'granted') {
      showToast(
        'Sonido y notificaciones activados'
      );
    } else if (permission === 'denied') {
      showToast(
        'Sonido activado; el navegador bloqueó las notificaciones',
        true
      );
    } else {
      showToast(
        'Sonido de pedidos activado'
      );
    }
  }

  async function testOrderAlert() {
    await notifyNewOrder(
      {
        id: 'PRUEBA',
        cliente:
          'Cliente de prueba',
        tipoEntrega:
          'Entrega a domicilio',
        total: 125
      },
      {
        isTest: true,
        eventKey:
          `test-${Date.now()}`
      }
    );
  }

  function bindOrderAlertControls() {
    updateOrderAlertsUi();

    if (orderAlertsToggleBtn) {
      orderAlertsToggleBtn.addEventListener(
        'click',
        () => {
          void toggleOrderAlerts();
        }
      );
    }

    if (orderAlertsTestBtn) {
      orderAlertsTestBtn.addEventListener(
        'click',
        () => {
          void testOrderAlert();
        }
      );
    }

    if (orderAlertsVolumeInput) {
      orderAlertsVolumeInput.addEventListener(
        'input',
        () => {
          orderAlertsSettings.volume =
            Math.min(
              1,
              Math.max(
                0,
                Number(
                  orderAlertsVolumeInput.value ||
                  0
                )
              )
            );

          saveOrderAlertsSettings();
          updateOrderAlertsUi();
        }
      );

      orderAlertsVolumeInput.addEventListener(
        'change',
        () => {
          if (
            orderAlertsSettings.enabled
          ) {
            void playNewOrderSound();
          }
        }
      );
    }

    document.addEventListener(
      'pointerdown',
      () => {
        if (
          orderAlertsSettings.enabled
        ) {
          void ensureOrderAlertAudioContext();
        }
      },
      {
        once: true,
        passive: true
      }
    );
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

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatDate(value) {
    if (!value) return '-';

    const raw = String(value).trim();

    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      return formatDateKeyLabel(raw);
    }

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
      return '-';
    }

    return date.toLocaleString('es-MX', {
      timeZone: 'America/Mexico_City',
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  function statusClass(status) {
    return String(status || 'Pendiente')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'pendiente';
  }

  function mapProducts(items) {
    if (!Array.isArray(items) || !items.length) return 'Sin productos';
    return items.map(item => {
      const detail = String(item.choice || '').trim();
      return `${Number(item.qty || 1)}x ${item.name || 'Producto'}${detail ? ` (${detail})` : ''}`;
    }).join(' | ');
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

  function formatCurrency(value) {
    const amount = Number(value || 0);
    const formatted = new Intl.NumberFormat('es-MX', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(amount);
    return `$${formatted} MXN`;
  }

  function getMexicoCityDateKey(date = new Date()) {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Mexico_City',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    });
    const parts = formatter.formatToParts(date);
    const year = parts.find(part => part.type === 'year')?.value || '0000';
    const month = parts.find(part => part.type === 'month')?.value || '01';
    const day = parts.find(part => part.type === 'day')?.value || '01';
    return `${year}-${month}-${day}`;
  }

  function formatDateKeyLabel(dateKey) {
    const [year, month, day] = String(dateKey || '').split('-').map(Number);
    if (!year || !month || !day) return dateKey || '-';
    const utcDate = new Date(Date.UTC(year, month - 1, day, 12, 0, 0, 0));
    return utcDate.toLocaleDateString('es-MX', {
      timeZone: 'UTC',
      day: '2-digit',
      month: 'long',
      year: 'numeric'
    });
  }

  function ensureSoldProductsFilter() {
    const today = getMexicoCityDateKey();
    if (!soldProductsFilter) {
      soldProductsFilter = {
        startDate: today,
        endDate: today
      };
    }
    return soldProductsFilter;
  }

  function syncSoldProductsFilterInputs() {
    const filter = ensureSoldProductsFilter();
    if (soldProductsStartDateInput) soldProductsStartDateInput.value = filter.startDate;
    if (soldProductsEndDateInput) soldProductsEndDateInput.value = filter.endDate;
  }

  function renderSoldProducts(data) {
    if (!soldProductsTableBody) return;

    if (Array.isArray(data?.separatedNames)) {
      applySeparatedNamesFromServer(data.separatedNames);
    }

    const items = Array.isArray(data?.items) ? data.items : [];
    const period = data?.period || ensureSoldProductsFilter();
    const visibleItems = [];
    const separatedItems = [];

    items.forEach(item => {
      const key = normalizeSoldProductName(item?.name);
      if (key && soldProductsSeparatedNames.has(key)) {
        separatedItems.push(item);
      } else {
        visibleItems.push(item);
      }
    });

    if (soldProductsRangeLabel) {
      const sameDay = period.startDate === period.endDate;
      soldProductsRangeLabel.textContent = sameDay
        ? `Mostrando productos vendidos el ${formatDateKeyLabel(period.startDate)} en horario de Ciudad de México.`
        : `Mostrando productos vendidos del ${formatDateKeyLabel(period.startDate)} al ${formatDateKeyLabel(period.endDate)} en horario de Ciudad de México.`;
    }

    renderSoldProductsRows(soldProductsTableBody, visibleItems, 'default');
    renderSoldProductsRows(soldProductsSeparatedTableBody, separatedItems, 'separated');

    updateSoldProductsSummary(summarizeSoldItems(visibleItems), 'default');
    updateSoldProductsSummary(summarizeSoldItems(separatedItems), 'separated');
  }

  async function loadSoldProductsData() {
    if (!soldProductsTableBody) return;

    const filter = ensureSoldProductsFilter();
    syncSoldProductsFilterInputs();

    try {
      const result = await api(`/api/admin/sold-products?startDate=${encodeURIComponent(filter.startDate)}&endDate=${encodeURIComponent(filter.endDate)}`);
      renderSoldProducts(result);
      return result;
    } catch (error) {
      if (error.status === 401) {
        setAuthenticated(false);
        stopAdminEventsStream();
        stopRefresh();
        return;
      }

      soldProductsTableBody.innerHTML = '<tr><td colspan="5">No se pudieron cargar los productos vendidos</td></tr>';
      if (soldProductsSeparatedTableBody) {
        soldProductsSeparatedTableBody.innerHTML = '<tr><td colspan="5">No se pudieron cargar los productos separados</td></tr>';
      }
      updateSoldProductsSummary({ differentProducts: 0, totalUnits: 0, totalRevenue: 0 }, 'default');
      updateSoldProductsSummary({ differentProducts: 0, totalUnits: 0, totalRevenue: 0 }, 'separated');
      console.warn('No se pudieron cargar los productos vendidos', error);
      return null;
    }
  }

  function resetSoldProductsToToday() {
    const today = getMexicoCityDateKey();
    soldProductsFilter = {
      startDate: today,
      endDate: today
    };
    syncSoldProductsFilterInputs();
    loadSoldProductsData();
  }

  async function saveSoldProductsSeparatedToServer() {
    const result = await api('/api/admin/sold-products/separated', {
      method: 'PUT',
      body: JSON.stringify({ names: Array.from(soldProductsSeparatedNames.values()) })
    });
    applySeparatedNamesFromServer(result?.separatedNames || []);
    return result;
  }

  async function setSoldProductSeparated(productName, shouldSeparate) {
    const key = normalizeSoldProductName(productName);
    if (!key) return;

    if (shouldSeparate) {
      soldProductsSeparatedNames.add(key);
    } else {
      soldProductsSeparatedNames.delete(key);
    }

    await saveSoldProductsSeparatedToServer();
    await loadSoldProductsData();
  }

  function createCalculatorProduct() {
    return {
      id: (window.crypto && typeof window.crypto.randomUUID === 'function') ? window.crypto.randomUUID() : `calc-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      name: '',
      qty: 1,
      price: 0
    };
  }

  function isUsingDashboardRevenue() {
    return Boolean(calculatorUseDashboardToggle?.checked);
  }

  function parseMoneyFromText(text) {
    const cleaned = String(text || '').replace(/[^\d.,-]/g, '');
    if (!cleaned) return 0;

    const lastComma = cleaned.lastIndexOf(',');
    const lastDot = cleaned.lastIndexOf('.');

    let normalized = cleaned;
    if (lastComma >= 0 && lastDot >= 0) {
      if (lastComma > lastDot) {
        normalized = cleaned.replace(/\./g, '').replace(',', '.');
      } else {
        normalized = cleaned.replace(/,/g, '');
      }
    } else if (lastComma >= 0) {
      normalized = cleaned.replace(/\./g, '').replace(',', '.');
    } else {
      normalized = cleaned.replace(/,/g, '');
    }

    const value = Number(normalized);
    return Number.isFinite(value) ? value : 0;
  }

  // === CALCULATOR_SALES_RANGE_FRONTEND_V1 ===
  function isValidCalculatorDateKey(value) {
    return (
      typeof value === 'string' &&
      /^\d{4}-\d{2}-\d{2}$/.test(value)
    );
  }

  function ensureCalculatorSalesRangeDefaults() {
    const today =
      typeof getMexicoCityDateKey === 'function'
        ? getMexicoCityDateKey()
        : getTodayDateKey();

    if (
      !isValidCalculatorDateKey(
        calculatorSalesStartDate
      )
    ) {
      calculatorSalesStartDate =
        today;
    }

    if (
      !isValidCalculatorDateKey(
        calculatorSalesEndDate
      )
    ) {
      calculatorSalesEndDate =
        calculatorSalesStartDate;
    }

    if (calculatorSalesStartDateInput) {
      calculatorSalesStartDateInput.value =
        calculatorSalesStartDate;
    }

    if (calculatorSalesEndDateInput) {
      calculatorSalesEndDateInput.value =
        calculatorSalesEndDate;
    }
  }

  function updateCalculatorSalesRangeLabel(summary) {
    if (!calculatorSalesRangeLabel) {
      return;
    }

    const startDate =
      calculatorSalesStartDate;

    const endDate =
      calculatorSalesEndDate;

    const totalRevenue =
      Number(
        summary?.totalRevenue ??
        dashboardRevenue ??
        0
      );

    const orderCount =
      Number(
        summary?.orderCount ||
        0
      );

    const periodText =
      startDate === endDate
        ? `del ${formatDateKeyLabel(startDate)}`
        : `del ${formatDateKeyLabel(startDate)} al ${formatDateKeyLabel(endDate)}`;

    calculatorSalesRangeLabel.textContent =
      `Ventas ${periodText}: ${formatCurrency(totalRevenue)} en ${orderCount} pedido${orderCount === 1 ? '' : 's'}.`;
  }

  async function loadCalculatorSalesRange(
    options = {}
  ) {
    ensureCalculatorSalesRangeDefaults();

    const startDate = String(
      calculatorSalesStartDateInput?.value ||
      calculatorSalesStartDate ||
      ''
    ).trim();

    const endDate = String(
      calculatorSalesEndDateInput?.value ||
      calculatorSalesEndDate ||
      ''
    ).trim();

    if (
      !isValidCalculatorDateKey(startDate) ||
      !isValidCalculatorDateKey(endDate)
    ) {
      if (!options.silent) {
        showToast(
          'Selecciona una fecha inicial y una fecha final',
          true
        );
      }

      return null;
    }

    if (startDate > endDate) {
      if (!options.silent) {
        showToast(
          'La fecha inicial no puede ser posterior a la fecha final',
          true
        );
      }

      return null;
    }

    if (calculatorLoadSalesRangeBtn) {
      calculatorLoadSalesRangeBtn.disabled =
        true;
    }

    try {
      const result = await api(
        `/api/admin/calculator-sales-range?startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}`
      );

      const summary =
        result?.summary || {};

      calculatorSalesStartDate =
        startDate;

      calculatorSalesEndDate =
        endDate;

      dashboardRevenue =
        Math.max(
          0,
          Number(
            summary.totalRevenue ||
            0
          )
        );

      calculatorSalesRangeLoaded =
        true;

      if (
        calculatorUseDashboardToggle
      ) {
        calculatorUseDashboardToggle.checked =
          true;
      }

      updateCalculatorSalesRangeLabel(
        summary
      );

      saveCalculatorDraft();
      renderCalculatorSummary();

      if (!options.silent) {
        showToast(
          'Ventas del periodo cargadas en la calculadora'
        );
      }

      return result;
    } catch (error) {
      calculatorSalesRangeLoaded =
        false;

      if (!options.silent) {
        showToast(
          error.message ||
          'No se pudieron cargar las ventas del periodo',
          true
        );
      }

      return null;
    } finally {
      if (calculatorLoadSalesRangeBtn) {
        calculatorLoadSalesRangeBtn.disabled =
          false;
      }
    }
  }

  function syncDashboardRevenueFromKpi() {
    if (calculatorSalesRangeLoaded) {
      return;
    }

    const kpiEl =
      document.getElementById(
        'kpiVentasDia'
      );

    if (!kpiEl) return;

    const parsed =
      parseMoneyFromText(
        kpiEl.textContent
      );

    if (Number.isFinite(parsed)) {
      dashboardRevenue =
        Math.max(
          0,
          parsed
        );
    }
  }

  function getCalculatorProductsPayload() {
    return calculatorProducts
      .map(product => ({
        ...product,
        name: String(product?.name || '').trim(),
        qty: Math.max(0, Number(product?.qty || 0)),
        price: Math.max(0, Number(product?.price || 0))
      }))
      .filter(product => product.name || product.price > 0);
  }

  function calculateCalculatorTotals(products) {
    const gastos = products.reduce((sum, item) => sum + Number(item.qty || 0) * Number(item.price || 0), 0);
    const ganancias = isUsingDashboardRevenue() ? dashboardRevenue : Math.max(0, manualIncomeValue);
    const resultado = ganancias - gastos;

    let status = 'Ganancia restante';
    let message = 'Tus ingresos superan los gastos.';
    if (resultado < 0) {
      status = 'Déficit';
      message = 'Los gastos superan a las ganancias.';
    } else if (resultado === 0) {
      status = 'Gastos iguales a las ganancias';
      message = 'El resultado está en equilibrio.';
    }

    return {
      gastos: Math.round(gastos * 100) / 100,
      ganancias: Math.round(ganancias * 100) / 100,
      resultado: Math.round(resultado * 100) / 100,
      status,
      message
    };
  }

  function renderCalculatorSummary() {
    const useDashboardRevenue = isUsingDashboardRevenue();
    if (useDashboardRevenue) {
      syncDashboardRevenueFromKpi();
    }
    const payload = calculateCalculatorTotals(getCalculatorProductsPayload());
    if (calculatorExpensesTotal) calculatorExpensesTotal.textContent = formatCurrency(payload.gastos);
    if (calculatorIncomeTotal) calculatorIncomeTotal.textContent = formatCurrency(payload.ganancias);
    if (calculatorFinalResult) calculatorFinalResult.textContent = formatCurrency(payload.resultado);
    if (calculatorResultState) {
      calculatorResultState.textContent = payload.status;
      calculatorResultState.classList.remove('deficit', 'neutral');
      if (payload.status === 'Déficit') {
        calculatorResultState.classList.add('deficit');
      } else if (payload.status === 'Gastos iguales a las ganancias') {
        calculatorResultState.classList.add('neutral');
      }
    }
    if (calculatorResultMessage) calculatorResultMessage.textContent = payload.message;

    if (calculatorIncomeInput) {
      calculatorIncomeInput.disabled = useDashboardRevenue;
      calculatorIncomeInput.classList.toggle('disabled-input', useDashboardRevenue);
      if (useDashboardRevenue) {
        calculatorIncomeInput.value = String(dashboardRevenue.toFixed(2));
      } else {
        calculatorIncomeInput.value = String(manualIncomeValue.toFixed(2));
      }
    }
  }

  function renderCalculatorProducts() {
    if (!calculatorProductsRoot) return;

    if (!calculatorProducts.length) {
      calculatorProducts = [createCalculatorProduct()];
    }

    calculatorProductsRoot.innerHTML = calculatorProducts.map((product, index) => `
      <div class="calculator-product-row">
        <div class="form-group">
          <label>Producto o insumo</label>
          <input type="text" value="${escapeHtml(product.name)}" data-index="${index}" data-field="name" placeholder="Ej. Tortilla, aceite, etc." />
        </div>
        <div class="form-group">
          <label>Cantidad</label>
          <input type="number" min="0" step="1" value="${Number(product.qty || 0)}" data-index="${index}" data-field="qty" />
        </div>
        <div class="form-group">
          <label>Precio unitario</label>
          <input type="number" min="0" step="0.01" value="${Number(product.price || 0)}" data-index="${index}" data-field="price" />
        </div>
        <div class="form-group">
          <label>Total</label>
          <input type="text" value="${formatCurrency(Number(product.qty || 0) * Number(product.price || 0))}" readonly />
        </div>
        <div class="form-group">
          <label>Acción</label>
          <button class="danger-btn" type="button" data-action="remove-calculator-product" data-index="${index}">Eliminar</button>
        </div>
      </div>
    `).join('');

    calculatorProductsRoot.querySelectorAll('input[data-field]').forEach(input => {
      input.addEventListener('input', handleCalculatorInput);
      input.addEventListener('change', handleCalculatorInput);
    });

    renderCalculatorSummary();
  }

  function handleCalculatorInput(event) {
    const input = event.target;
    const index = Number(input.dataset.index);
    if (!Number.isInteger(index) || !calculatorProducts[index]) return;

    const field = input.dataset.field;
    if (field === 'name') {
      calculatorProducts[index].name = input.value;
      saveCalculatorDraft();
      renderCalculatorSummary();
      return;
    }

    if (field === 'qty') {
      const value = Math.max(0, Number(input.value || 0));
      calculatorProducts[index].qty = Number.isFinite(value) ? value : 0;
      input.value = calculatorProducts[index].qty;
    } else if (field === 'price') {
      const value = Math.max(0, Number(input.value || 0));
      calculatorProducts[index].price = Number.isFinite(value) ? value : 0;
      input.value = calculatorProducts[index].price;
    }

    const row = input.closest('.calculator-product-row');
    const totalInput = row?.querySelector('input[readonly]');
    if (totalInput) {
      totalInput.value = formatCurrency(Number(calculatorProducts[index].qty || 0) * Number(calculatorProducts[index].price || 0));
    }

    saveCalculatorDraft();
    renderCalculatorSummary();
  }

  function resetCalculatorSection() {
    calculatorProducts = [createCalculatorProduct()];
    manualIncomeValue = 0;
    if (!isUsingDashboardRevenue() && calculatorIncomeInput) {
      calculatorIncomeInput.value = '0.00';
    }
    allowEmptyDraftOverrideOnce = true;
    saveCalculatorDraft();
    renderCalculatorProducts();
  }

// === HISTORIAL_DIARIO_PATCH_V1: pedidos históricos de solo lectura ===

  // === ADMIN_BUSINESS_TOOLS_V1 ===
  function normalizeOrderFilterText(value) {
    return String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .trim()
      .replace(/\s+/g, ' ');
  }

  function getOrderProductSearchText(order) {
    const products = Array.isArray(order?.productos)
      ? order.productos
      : [];

    return products
      .map(item => (
        item?.name ||
        item?.nombre ||
        'Producto'
      ))
      .join(' ');
  }

  function matchesDeliveryFilter(order, filter) {
    if (!filter) return true;

    const delivery = normalizeOrderFilterText(
      order?.tipoEntrega
    );

    if (filter === 'delivery') {
      return (
        delivery.includes('domicilio') ||
        delivery.includes('envio')
      );
    }

    if (filter === 'pickup') {
      return (
        delivery.includes('recoleccion') ||
        delivery.includes('recoger')
      );
    }

    return true;
  }

  function getFilteredOrders() {
    const query = normalizeOrderFilterText(
      orderSearchInput?.value
    );

    const terms = query
      ? query.split(' ').filter(Boolean)
      : [];

    const status = String(
      orderStatusFilter?.value ||
      ''
    );

    const delivery = String(
      orderDeliveryFilter?.value ||
      ''
    );

    const sortMode = String(
      orderSortSelect?.value ||
      'recent'
    );

    const filtered = currentOrders.filter(order => {
      if (
        status &&
        String(order?.estado || '') !== status
      ) {
        return false;
      }

      if (!matchesDeliveryFilter(order, delivery)) {
        return false;
      }

      if (terms.length) {
        const haystack = normalizeOrderFilterText([
          order?.id,
          order?.pedidoOriginalId,
          order?.cliente,
          order?.telefono,
          order?.direccion,
          order?.tipoEntrega,
          order?.estado,
          getOrderProductSearchText(order)
        ].join(' '));

        if (
          !terms.every(term =>
            haystack.includes(term)
          )
        ) {
          return false;
        }
      }

      return true;
    });

    filtered.sort((a, b) => {
      if (sortMode === 'oldest') {
        return (
          new Date(a?.fecha || 0).getTime() -
          new Date(b?.fecha || 0).getTime()
        );
      }

      if (sortMode === 'total-desc') {
        return (
          Number(b?.total || 0) -
          Number(a?.total || 0)
        );
      }

      if (sortMode === 'total-asc') {
        return (
          Number(a?.total || 0) -
          Number(b?.total || 0)
        );
      }

      if (sortMode === 'client') {
        return String(a?.cliente || '').localeCompare(
          String(b?.cliente || ''),
          'es',
          { sensitivity: 'base' }
        );
      }

      return (
        new Date(b?.fecha || 0).getTime() -
        new Date(a?.fecha || 0).getTime()
      );
    });

    return filtered;
  }

  function renderFilteredOrders() {
    const filtered = getFilteredOrders();

    renderOrders(filtered);

    if (orderFilterCount) {
      const date = getSelectedDateKey();

      orderFilterCount.textContent =
        `Mostrando ${filtered.length} de ${currentOrders.length} pedido${currentOrders.length === 1 ? '' : 's'} del ${date}.`;
    }
  }

  function clearOrderFilters() {
    if (orderSearchInput) {
      orderSearchInput.value = '';
    }

    if (orderStatusFilter) {
      orderStatusFilter.value = '';
    }

    if (orderDeliveryFilter) {
      orderDeliveryFilter.value = '';
    }

    if (orderSortSelect) {
      orderSortSelect.value = 'recent';
    }

    renderFilteredOrders();
  }

  function bindAdvancedAdminFeatures() {
    if (advancedAdminFeaturesBound) {
      return;
    }

    advancedAdminFeaturesBound = true;

    [
      orderSearchInput,
      orderStatusFilter,
      orderDeliveryFilter,
      orderSortSelect
    ].forEach(element => {
      if (!element) return;

      const eventName =
        element.tagName === 'INPUT'
          ? 'input'
          : 'change';

      element.addEventListener(
        eventName,
        renderFilteredOrders
      );
    });

    orderFiltersClearBtn?.addEventListener(
      'click',
      clearOrderFilters
    );
  }

  function renderOrders(orders) {
    if (!tableBody) return;

    if (!orders.length) {
      tableBody.innerHTML =
        '<tr><td colspan="10">Todavía no hay pedidos registrados para este día.</td></tr>';
      return;
    }

    tableBody.innerHTML = orders.map((order, index) => {
      const estado = order.estado || 'Pendiente';
      const productos = Array.isArray(order.productos)
        ? order.productos
        : [];
      const isArchived = Boolean(order.archivado);

      const actions = isArchived
        ? `
            <button type="button" data-action="view">Ver</button>
            <span class="meta-note">Archivado</span>
          `
        : `
            <button type="button" data-action="view">Ver</button>
            <button type="button" data-action="status">Editar estado</button>
            <button type="button" data-action="delete">Eliminar</button>
          `;

      const productsHtml = productos.map(item => {
        const quantity = Number(item?.qty ?? item?.cantidad ?? 1);
        const name = item?.name || item?.nombre || 'Producto';
        return `<span>${quantity}x ${escapeHtml(name)}</span>`;
      }).join('');

      return `
        <tr
          data-order-id="${Number(order.id)}"
          data-order-archived="${isArchived ? 'true' : 'false'}"
        >
          <td>#${index + 1}</td>
          <td>${escapeHtml(order.cliente || '-')}</td>
          <td>${escapeHtml(order.telefono || '-')}</td>
          <td>${escapeHtml(order.direccion || '-')}</td>
          <td>${escapeHtml(order.tipoEntrega || '-')}</td>
          <td>
            <div class="admin-order-products">${productsHtml}</div>
          </td>
          <td>${formatMoney(order.total || 0)}</td>
          <td>
            <span class="status-chip ${statusClass(estado)}">
              ${escapeHtml(estado)}
            </span>
          </td>
          <td>${formatDate(order.fecha)}</td>
          <td>
            <div class="admin-row-actions">${actions}</div>
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

    detailContent.replaceChildren();
    rows.forEach(([label, value]) => {
      const row = document.createElement('div');
      row.className = 'admin-modal-row';
      const strong = document.createElement('strong');
      const span = document.createElement('span');
      strong.textContent = String(label);
      span.textContent = String(value);
      row.append(strong, span);
      detailContent.appendChild(row);
    });

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
      const date = getSelectedDateKey();
      const tzOffset = getMexicoCityOffsetMinutes();
      const [statsResult, pedidosResult] = await Promise.all([
        api(`/api/admin/stats?date=${encodeURIComponent(date)}&tzOffset=${encodeURIComponent(tzOffset)}`),
        api(`/api/pedidos/day?date=${encodeURIComponent(date)}&tzOffset=${encodeURIComponent(tzOffset)}`)
      ]);

      const stats = statsResult.stats || {};
      dashboardRevenue = Number(stats.ventasDia || 0);
      renderStats(stats);
      currentOrders = Array.isArray(pedidosResult.pedidos) ? pedidosResult.pedidos : [];
      renderOrders(currentOrders);
      syncLegacyOrdersFromApiOrders(currentOrders);

      if (typeof window.renderOrders === 'function') {
        window.renderOrders();
      }

      renderCalculatorSummary();
    } catch (error) {
      if (error.status === 401) {
        setAuthenticated(false);
        stopAdminEventsStream();
        stopRefresh();
        return;
      }

      console.warn('No se pudo actualizar el dashboard', error);
    }
  }

  function getTodayDateKey() {
    if (typeof getMexicoCityDateKey === 'function') {
      return getMexicoCityDateKey(new Date());
    }

    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Mexico_City',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    });

    const parts = formatter.formatToParts(new Date());
    const year =
      parts.find(part => part.type === 'year')?.value;
    const month =
      parts.find(part => part.type === 'month')?.value;
    const day =
      parts.find(part => part.type === 'day')?.value;

    return `${year}-${month}-${day}`;
  }

  function getMexicoCityOffsetMinutes() {
    return 360;
  }

  function getSelectedDateKey() {
    const fallback = getTodayDateKey();
    const value = String(dayFilterInput?.value || '').trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : fallback;
  }

  function requestDeleteDayConfirmation(date) {
    return new Promise(resolve => {
      const overlay = document.createElement('div');
      overlay.style.position = 'fixed';
      overlay.style.inset = '0';
      overlay.style.background = 'rgba(0, 0, 0, 0.45)';
      overlay.style.zIndex = '9999';
      overlay.style.display = 'flex';
      overlay.style.alignItems = 'center';
      overlay.style.justifyContent = 'center';
      overlay.style.padding = '1rem';

      const card = document.createElement('div');
      card.style.width = 'min(100%, 460px)';
      card.style.background = '#fff';
      card.style.borderRadius = '16px';
      card.style.padding = '1rem';
      card.style.boxShadow = '0 14px 30px rgba(0,0,0,0.18)';
      card.innerHTML = `
        <h3 style="margin:0 0 0.5rem 0;color:#a73319;">Confirmar eliminación del día</h3>
        <p style="margin:0 0 0.75rem 0;line-height:1.5;color:#5c4036;">Vas a eliminar TODOS los pedidos del día <strong>${escapeHtml(date)}</strong>.</p>
        <p style="margin:0 0 0.5rem 0;line-height:1.5;color:#5c4036;">Escribe <strong>ELIMINAR</strong> para continuar.</p>
        <input id="deleteDayConfirmInput" type="text" placeholder="ELIMINAR" style="width:100%;border:1px solid #dccfc4;border-radius:10px;padding:0.65rem 0.75rem;" />
        <p id="deleteDayConfirmError" style="min-height:1.1rem;margin:0.5rem 0 0 0;color:#a73319;font-weight:700;"></p>
        <div style="display:flex;gap:0.5rem;justify-content:flex-end;margin-top:0.75rem;">
          <button id="deleteDayCancelBtn" type="button" style="border:none;border-radius:999px;padding:0.6rem 0.9rem;background:#f1ece8;color:#4e342e;font-weight:800;cursor:pointer;">Cancelar</button>
          <button id="deleteDayConfirmBtn" type="button" style="border:none;border-radius:999px;padding:0.6rem 0.9rem;background:#a73319;color:#fff;font-weight:800;cursor:pointer;">Eliminar pedidos</button>
        </div>
      `;

      overlay.appendChild(card);
      document.body.appendChild(overlay);

      const input = card.querySelector('#deleteDayConfirmInput');
      const error = card.querySelector('#deleteDayConfirmError');
      const cancelBtn = card.querySelector('#deleteDayCancelBtn');
      const confirmBtn = card.querySelector('#deleteDayConfirmBtn');

      const cleanup = result => {
        if (overlay.parentElement) {
          overlay.parentElement.removeChild(overlay);
        }
        resolve(result);
      };

      const attemptConfirm = () => {
        const value = String(input?.value || '').trim().toUpperCase();
        if (value !== 'ELIMINAR') {
          if (error) error.textContent = 'Debes escribir ELIMINAR exactamente.';
          input?.focus();
          return;
        }
        cleanup(true);
      };

      cancelBtn?.addEventListener('click', () => cleanup(false));
      confirmBtn?.addEventListener('click', attemptConfirm);
      overlay.addEventListener('click', event => {
        if (event.target === overlay) cleanup(false);
      });
      input?.addEventListener('keydown', event => {
        if (event.key === 'Enter') {
          event.preventDefault();
          attemptConfirm();
        }
      });

      input?.focus();
    });
  }

// === HISTORIAL_DIARIO_PATCH_V1: no borrar historial archivado ===
// === ELIMINAR_CUALQUIER_DIA_FRONTEND_V1 ===
  async function deleteOrdersByDay() {
    const date = getSelectedDateKey();
    const tzOffset = getMexicoCityOffsetMinutes();

    const confirmed = await requestDeleteDayConfirmation(date);
    if (!confirmed) return;

    if (deleteDayBtn) {
      deleteDayBtn.disabled = true;
    }

    try {
      const result = await api(
        `/api/pedidos/day?date=${encodeURIComponent(date)}&tzOffset=${encodeURIComponent(tzOffset)}`,
        { method: 'DELETE' }
      );

      const total = Number(result.deletedCount || 0);
      const active = Number(result.activeDeletedCount || 0);
      const archived = Number(result.archivedDeletedCount || 0);

      if (total === 0) {
        showToast(`No había pedidos registrados el ${date}`, true);
      } else {
        showToast(
          `Se eliminaron ${total} pedidos: ${active} activos y ${archived} archivados`
        );
      }

      startUndoDeleteDay(
        result.date,
        Array.isArray(result.deletedOrders)
          ? result.deletedOrders
          : []
      );

      await Promise.all([
        loadDashboardData(),
        loadSoldProductsData()
      ]);
    } catch (error) {
      showToast(
        error.message ||
        'No se pudieron eliminar los pedidos del día',
        true
      );
    } finally {
      if (deleteDayBtn) {
        deleteDayBtn.disabled = false;
      }
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
        loadSoldProductsData();
      }
    }, DASHBOARD_REFRESH_MS);
  }

  function stopRefresh() {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
  }

  function startAdminEventsStream() {
    if (typeof window.EventSource !== 'function') return;

    if (adminEventsStream) {
      adminEventsStream.close();
    }

    adminEventsStream = new EventSource('/api/admin/events');
    adminEventsStream.addEventListener(
      'orders-updated',
      event => {
        void handleOrdersUpdatedEvent(
          event
        );
      }
    );
    adminEventsStream.addEventListener('sold-products-separation-updated', () => {
      if (!adminApp.classList.contains('hidden')) {
        loadSoldProductsData();
      }
    });
  }

  function stopAdminEventsStream() {
    if (!adminEventsStream) return;
    adminEventsStream.close();
    adminEventsStream = null;
  }

  async function checkSession() {
    try {
      const result = await api('/api/session', { method: 'GET' });
      const isAuthed = Boolean(result && result.authenticated);
      setAuthenticated(isAuthed);

      if (isAuthed) {
        await loadDashboardData();
        await loadSoldProductsData();
        await loadEditableSettings();
        await hydrateCalculatorDraftFromServer();
        await loadCalculatorSalesRange({ silent: true });
        startAdminEventsStream();
        startRefresh();
      } else {
        stopAdminEventsStream();
        stopRefresh();
      }
    } catch {
      stopAdminEventsStream();
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
      await loadSoldProductsData();
      await loadEditableSettings();
      await hydrateCalculatorDraftFromServer();
      startAdminEventsStream();
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
    stopAdminEventsStream();
    stopRefresh();
    showToast('Sesión cerrada');
  }

  async function loadEditableSettings() {
    try {
      const result = await api('/api/admin/content');
      const content = result?.content || {};
      if (heroBadgeInput) heroBadgeInput.value = String(content.heroBadge || '');
      if (heroTitleInput) heroTitleInput.value = String(content.heroTitle || '');
      if (heroTextInput) heroTextInput.value = String(content.heroText || '');
      if (heroRecommendationsInput) {
        heroRecommendationsInput.value = Array.isArray(content.recommendations)
          ? content.recommendations.join('\n')
          : '';
      }
    } catch (error) {
      if (error.status !== 401) {
        console.warn('No se pudieron cargar los textos editables:', error);
      }
    }
  }

  async function saveEditableContent() {
    const recommendations = String(heroRecommendationsInput?.value || '')
      .split(/\r?\n/)
      .map(item => item.trim())
      .filter(Boolean);

    try {
      const result = await api('/api/admin/content', {
        method: 'PUT',
        body: JSON.stringify({
          content: {
            heroBadge: String(heroBadgeInput?.value || '').trim(),
            heroTitle: String(heroTitleInput?.value || '').trim(),
            heroText: String(heroTextInput?.value || '').trim(),
            recommendations
          }
        })
      });

      const content = result?.content || {};
      if (heroBadgeInput) heroBadgeInput.value = String(content.heroBadge || '');
      if (heroTitleInput) heroTitleInput.value = String(content.heroTitle || '');
      if (heroTextInput) heroTextInput.value = String(content.heroText || '');
      if (heroRecommendationsInput) {
        heroRecommendationsInput.value = Array.isArray(content.recommendations)
          ? content.recommendations.join('\n')
          : '';
      }
      showToast('Textos guardados correctamente');
    } catch (error) {
      showToast(error.message || 'No se pudieron guardar los textos', true);
    }
  }

  async function saveAdminPassword() {
    const password = String(newPasswordInput?.value || '');
    if (password.length < 8) {
      showToast('La nueva contraseña debe tener al menos 8 caracteres', true);
      return;
    }

    try {
      await api('/api/admin/password', {
        method: 'PUT',
        body: JSON.stringify({ password })
      });
      if (newPasswordInput) newPasswordInput.value = '';
      showToast('Contraseña actualizada');
    } catch (error) {
      showToast(error.message || 'No se pudo actualizar la contraseña', true);
    }
  }

// === HISTORIAL_DIARIO_PATCH_V1: protección de registros archivados ===
  async function handleTableActions(event) {
    const button = event.target.closest('button[data-action]');
    if (!button) return;

    const row = button.closest('tr[data-order-id]');
    if (!row) return;

    const id = Number(row.dataset.orderId);
    const isArchived = row.dataset.orderArchived === 'true';

    const order = currentOrders.find(item =>
      Number(item.id) === id &&
      Boolean(item.archivado) === isArchived
    );

    if (!order) return;

    const action = button.dataset.action;

    if (action === 'view') {
      showOrderDetail(order);
      return;
    }

    if (isArchived) {
      showToast(
        'Los pedidos archivados son historial de solo lectura.',
        true
      );
      return;
    }

    if (action === 'status') {
      openStatusEditor(order);
      return;
    }

    if (action === 'delete') {
      const confirmed = window.confirm(
        `¿Eliminar el pedido #${order.id}?`
      );

      if (!confirmed) return;

      try {
        await api(`/api/pedidos/${order.id}`, {
          method: 'DELETE'
        });

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
    const estado = statusSelect?.value || 'Confirmado';
    if (!ESTADOS.includes(estado)) {
      showToast(
        'Solo puedes seleccionar Confirmado, Entregado o Cancelado',
        true
      );
      return;
    }


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
    bindOrderAlertControls();

    bindAdvancedAdminFeatures();
    if (dayFilterInput && !dayFilterInput.value) {
      dayFilterInput.value = getTodayDateKey();
    }

    if (dayFilterInput) {
      dayFilterInput.addEventListener('change', () => {
        loadDashboardData();
      });
    }

    soldProductsFilter = {
      startDate: getMexicoCityDateKey(),
      endDate: getMexicoCityDateKey()
    };
    syncSoldProductsFilterInputs();

    if (soldProductsTodayBtn) {
      soldProductsTodayBtn.addEventListener('click', resetSoldProductsToToday);
    }

    if (soldProductsResetBtn) {
      soldProductsResetBtn.addEventListener('click', resetSoldProductsToToday);
    }

    if (soldProductsApplyBtn) {
      soldProductsApplyBtn.addEventListener('click', () => {
        const startDate = String(soldProductsStartDateInput?.value || '').trim();
        const endDate = String(soldProductsEndDateInput?.value || '').trim();

        if (!startDate || !endDate) {
          showToast('Debes seleccionar fecha inicial y fecha final', true);
          return;
        }

        if (startDate > endDate) {
          showToast('La fecha inicial no puede ser posterior a la fecha final', true);
          return;
        }

        soldProductsFilter = { startDate, endDate };
        loadSoldProductsData();
      });
    }

    if (soldProductsTableBody) {
      soldProductsTableBody.addEventListener('click', event => {
        const button = event.target.closest('[data-action="separate-sold-product"]');
        if (!button) return;
        const name = String(button.dataset.productName || '');
        (async () => {
          try {
            await setSoldProductSeparated(name, true);
            showToast('Producto movido a la sección separada');
          } catch (error) {
            showToast(error.message || 'No se pudo separar el producto', true);
          }
        })();
      });
    }

    if (soldProductsSeparatedTableBody) {
      soldProductsSeparatedTableBody.addEventListener('click', event => {
        const button = event.target.closest('[data-action="restore-sold-product"]');
        if (!button) return;
        const name = String(button.dataset.productName || '');
        (async () => {
          try {
            await setSoldProductSeparated(name, false);
            showToast('Producto regresado a la tabla principal');
          } catch (error) {
            showToast(error.message || 'No se pudo regresar el producto', true);
          }
        })();
      });
    }

    if (soldProductsClearSeparatedBtn) {
      soldProductsClearSeparatedBtn.addEventListener('click', () => {
        (async () => {
          try {
            soldProductsSeparatedNames = new Set();
            await saveSoldProductsSeparatedToServer();
            await loadSoldProductsData();
            showToast('Se limpió la sección separada');
          } catch (error) {
            showToast(error.message || 'No se pudo limpiar la sección separada', true);
          }
        })();
      });
    }

    ensureCalculatorSalesRangeDefaults();

    if (calculatorSalesStartDateInput) {
      calculatorSalesStartDateInput.addEventListener(
        'change',
        () => {
          calculatorSalesStartDate =
            calculatorSalesStartDateInput.value;

          calculatorSalesRangeLoaded =
            false;

          saveCalculatorDraft();
        }
      );
    }

    if (calculatorSalesEndDateInput) {
      calculatorSalesEndDateInput.addEventListener(
        'change',
        () => {
          calculatorSalesEndDate =
            calculatorSalesEndDateInput.value;

          calculatorSalesRangeLoaded =
            false;

          saveCalculatorDraft();
        }
      );
    }

    if (calculatorLoadSalesRangeBtn) {
      calculatorLoadSalesRangeBtn.addEventListener(
        'click',
        () => {
          void loadCalculatorSalesRange();
        }
      );
    }

    if (calculatorAddProductBtn) {
      calculatorAddProductBtn.addEventListener('click', () => {
        calculatorProducts.push(createCalculatorProduct());
        saveCalculatorDraft();
        renderCalculatorProducts();
      });
    }

    if (calculatorClearBtn) {
      calculatorClearBtn.addEventListener('click', resetCalculatorSection);
    }

    if (calculatorUseDashboardToggle) {
      const handleRevenueToggle = () => {
        if (!calculatorUseDashboardToggle.checked && calculatorIncomeInput) {
          manualIncomeValue = 0;
          calculatorIncomeInput.value = '0.00';
        }
        if (calculatorUseDashboardToggle.checked) {
          void loadCalculatorSalesRange();
        }
        saveCalculatorDraft();
        renderCalculatorSummary();
      };

      calculatorUseDashboardToggle.addEventListener('change', handleRevenueToggle);
      calculatorUseDashboardToggle.addEventListener('input', handleRevenueToggle);
      calculatorUseDashboardToggle.addEventListener('click', handleRevenueToggle);
    }

    if (calculatorIncomeInput) {
      calculatorIncomeInput.addEventListener('input', () => {
        if (!isUsingDashboardRevenue()) {
          const parsed = Number(calculatorIncomeInput.value || 0);
          manualIncomeValue = Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
          saveCalculatorDraft();
          renderCalculatorSummary();
        }
      });
      calculatorIncomeInput.addEventListener('change', () => {
        if (!isUsingDashboardRevenue()) {
          const parsed = Number(calculatorIncomeInput.value || 0);
          manualIncomeValue = Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
          saveCalculatorDraft();
          renderCalculatorSummary();
        }
      });
    }

    if (calculatorProductsRoot) {
      calculatorProductsRoot.addEventListener('click', event => {
        const button = event.target.closest('button[data-action="remove-calculator-product"]');
        if (!button) return;
        const index = Number(button.dataset.index);
        if (!Number.isInteger(index)) return;
        calculatorProducts = calculatorProducts.filter((_, itemIndex) => itemIndex !== index);
        if (!calculatorProducts.length || !calculatorProducts.some(item => String(item?.name || '').trim() || Number(item?.price || 0) > 0)) {
          allowEmptyDraftOverrideOnce = true;
        }
        saveCalculatorDraft();
        renderCalculatorProducts();
      });
    }

    if (saveContentBtn) {
      saveContentBtn.addEventListener('click', saveEditableContent);
    }
    if (saveConfigBtn) {
      saveConfigBtn.addEventListener('click', saveAdminPassword);
    }
    if (newPasswordInput) {
      newPasswordInput.addEventListener('keydown', event => {
        if (event.key === 'Enter') saveAdminPassword();
      });
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
        const tzOffset = getMexicoCityOffsetMinutes();
        window.location.href = `/api/pedidos/day/export/csv?date=${encodeURIComponent(date)}&tzOffset=${encodeURIComponent(tzOffset)}`;
      });
    }

    if (deleteDayBtn) {
      deleteDayBtn.addEventListener('click', deleteOrdersByDay);
    }

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && !adminApp.classList.contains('hidden')) {
        loadDashboardData();
        loadSoldProductsData();
        startRefresh();
      } else if (document.visibilityState !== 'visible') {
        stopRefresh();
      }
    });

    window.addEventListener('focus', () => {
      if (!adminApp.classList.contains('hidden')) {
        loadDashboardData();
        loadSoldProductsData();
        if (calculatorDraftSyncRetryNeeded) {
          void pushCalculatorDraftToServer();
        }
      }
    });

    window.addEventListener('storage', event => {
      if (event.key === ORDER_REFRESH_KEY) {
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
  loadCalculatorDraft();
  checkSession();
})();
