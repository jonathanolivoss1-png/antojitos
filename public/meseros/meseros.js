(() => {
  'use strict';

  const loginScreen = document.getElementById('loginScreen');
  const loginForm = document.getElementById('loginForm');
  const loginError = document.getElementById('loginError');
  const waiterUserInput = document.getElementById('waiterUserInput');
  const waiterPinInput = document.getElementById('waiterPinInput');
  const waiterApp = document.getElementById('waiterApp');
  const waiterNameLabel = document.getElementById('waiterNameLabel');
  const logoutWaiterBtn = document.getElementById('logoutWaiterBtn');
  const installAppBtn = document.getElementById('installAppBtn');

  const catalogSearchInput = document.getElementById('catalogSearchInput');
  const categoryList = document.getElementById('categoryList');
  const catalogStatus = document.getElementById('catalogStatus');
  const catalogGrid = document.getElementById('catalogGrid');

  const openCartBtn = document.getElementById('openCartBtn');
  const cartCountLabel = document.getElementById('cartCountLabel');
  const cartTotalLabel = document.getElementById('cartTotalLabel');
  const cartOverlay = document.getElementById('cartOverlay');
  const closeCartBtn = document.getElementById('closeCartBtn');
  const cartItems = document.getElementById('cartItems');
  const cartSheetTotal = document.getElementById('cartSheetTotal');
  const cartDeliveryLabel = document.getElementById('cartDeliveryLabel');
  const clearCartBtn = document.getElementById('clearCartBtn');
  const sendOrderBtn = document.getElementById('sendOrderBtn');

  const itemOverlay = document.getElementById('itemOverlay');
  const closeItemSheetBtn = document.getElementById('closeItemSheetBtn');
  const itemSheetTitle = document.getElementById('itemSheetTitle');
  const itemSheetDescription = document.getElementById('itemSheetDescription');
  const itemOptionList = document.getElementById('itemOptionList');
  const choiceField = document.getElementById('choiceField');
  const itemChoiceSelect = document.getElementById('itemChoiceSelect');
  const itemQtyMinusBtn = document.getElementById('itemQtyMinusBtn');
  const itemQtyPlusBtn = document.getElementById('itemQtyPlusBtn');
  const itemQtyLabel = document.getElementById('itemQtyLabel');
  const addSelectedItemBtn = document.getElementById('addSelectedItemBtn');

  const confirmOverlay = document.getElementById('confirmOverlay');
  const confirmSummary = document.getElementById('confirmSummary');
  const cancelConfirmBtn = document.getElementById('cancelConfirmBtn');
  const confirmSendBtn = document.getElementById('confirmSendBtn');

  const successOverlay = document.getElementById('successOverlay');
  const successTitle = document.getElementById('successTitle');
  const successText = document.getElementById('successText');
  const newOrderBtn = document.getElementById('newOrderBtn');
  const toast = document.getElementById('toast');

  const CART_KEY = 'anafres_waiter_cart_v1';
  const TYPE_KEY = 'anafres_waiter_delivery_type_v1';

  let waiter = null;
  let products = [];
  let promotions = [];
  let currentCategory = 'Todos';
  let currentSearch = '';
  let deliveryType =
    localStorage.getItem(TYPE_KEY) === 'Para llevar'
      ? 'Para llevar'
      : 'Comer aquí';
  let cart = loadCart();
  let selectedEntry = null;
  let selectedOptionId = '';
  let selectedQty = 1;
  let settingsStream = null;
  let deferredInstallPrompt = null;
  let sending = false;

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function normalizeText(value) {
    return String(value || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
  }

  function formatMoney(value) {
    return new Intl.NumberFormat('es-MX', {
      style: 'currency',
      currency: 'MXN',
      maximumFractionDigits: 2
    }).format(Number(value || 0));
  }

  function showToast(message) {
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => {
      toast.classList.remove('show');
    }, 2400);
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

  function loadCart() {
    try {
      const value = JSON.parse(
        localStorage.getItem(CART_KEY) || '[]'
      );

      return Array.isArray(value)
        ? value
            .filter(item => item && Number(item.qty) > 0)
            .slice(0, 100)
        : [];
    } catch {
      return [];
    }
  }

  function saveCart() {
    localStorage.setItem(
      CART_KEY,
      JSON.stringify(cart)
    );
  }

  function cartTotals() {
    return cart.reduce(
      (acc, item) => {
        const qty = Number(item.qty || 0);
        acc.units += qty;
        acc.total += Number(item.price || 0) * qty;
        return acc;
      },
      { units: 0, total: 0 }
    );
  }

  function updateCartBar() {
    const totals = cartTotals();
    cartCountLabel.textContent =
      `${totals.units} artículo${totals.units === 1 ? '' : 's'}`;
    cartTotalLabel.textContent =
      formatMoney(totals.total);
    openCartBtn.disabled =
      totals.units <= 0;
    cartSheetTotal.textContent =
      formatMoney(totals.total);
    cartDeliveryLabel.textContent =
      deliveryType;
  }

  function setDeliveryType(nextType) {
    deliveryType =
      nextType === 'Para llevar'
        ? 'Para llevar'
        : 'Comer aquí';

    localStorage.setItem(
      TYPE_KEY,
      deliveryType
    );

    document
      .querySelectorAll('[data-delivery-type]')
      .forEach(button => {
        button.classList.toggle(
          'active',
          button.dataset.deliveryType === deliveryType
        );
      });

    updateCartBar();
  }

  function setAuthenticated(authenticated, user = null) {
    waiter = authenticated ? user : null;
    loginScreen.classList.toggle('hidden', authenticated);
    waiterApp.classList.toggle('hidden', !authenticated);

    if (authenticated) {
      waiterNameLabel.textContent =
        `${user?.nombre || user?.usuario || 'Mesero'} · Los Anafres`;
      loadCatalog();
      startSettingsStream();
    } else {
      stopSettingsStream();
    }
  }

  async function checkSession() {
    try {
      const result = await api('/api/meseros/session');

      setAuthenticated(
        Boolean(result.authenticated),
        result.mesero || null
      );
    } catch {
      setAuthenticated(false);
    }
  }

  async function handleLogin(event) {
    event.preventDefault();
    loginError.textContent = '';

    const usuario = waiterUserInput.value.trim();
    const pin = waiterPinInput.value.trim();

    try {
      const result = await api('/api/meseros/login', {
        method: 'POST',
        body: JSON.stringify({ usuario, pin })
      });

      waiterPinInput.value = '';
      setAuthenticated(true, result.mesero);
      showToast('Acceso correcto');
    } catch (error) {
      loginError.textContent =
        error.message || 'No se pudo iniciar sesión';
    }
  }

  async function logout() {
    await api('/api/meseros/logout', {
      method: 'POST',
      body: '{}'
    }).catch(() => {});

    setAuthenticated(false);
    waiterPinInput.value = '';
  }

  function normalizeProduct(product = {}) {
    return {
      id: String(product.id || ''),
      name: String(product.name || ''),
      description: String(product.description || ''),
      image: String(product.image || ''),
      category: String(product.category || 'General'),
      tag: String(product.tag || ''),
      note: String(product.note || ''),
      active: product.active !== false,
      available: product.available !== false,
      choices: Array.isArray(product.choices)
        ? product.choices.map(String)
        : [],
      options: Array.isArray(product.options)
        ? product.options
            .map(option => ({
              id: String(option?.id || ''),
              name: String(option?.name || ''),
              price: Number(option?.price || 0)
            }))
            .filter(option => option.id && option.name)
        : []
    };
  }

  function normalizePromotion(promo = {}) {
    return {
      id: String(promo.id || ''),
      title: String(promo.title || ''),
      text: String(promo.text || ''),
      chip: String(promo.chip || 'Promo'),
      active: promo.active !== false,
      prices: Array.isArray(promo.prices)
        ? promo.prices
            .map(price => ({
              id: String(price?.id || ''),
              label: String(price?.label || price?.name || ''),
              price: Number(price?.price || 0)
            }))
            .filter(price => price.id && price.label)
        : []
    };
  }

  async function loadCatalog() {
    catalogStatus.textContent = 'Actualizando catálogo...';

    try {
      const result = await api('/api/admin/public-settings');
      const settings = result.settings || {};

      products = Array.isArray(settings.products)
        ? settings.products
            .map(normalizeProduct)
            .filter(product =>
              product.id &&
              product.name &&
              product.active &&
              product.available &&
              product.options.length
            )
        : [];

      promotions = Array.isArray(settings.promotions)
        ? settings.promotions
            .map(normalizePromotion)
            .filter(promo =>
              promo.id &&
              promo.title &&
              promo.active &&
              promo.prices.length
            )
        : [];

      renderCategories();
      renderCatalog();
      catalogStatus.textContent =
        'Catálogo sincronizado con Admin';
    } catch (error) {
      catalogStatus.textContent =
        'No se pudo actualizar el catálogo';
      showToast(error.message || 'Error de catálogo');
    }
  }

  function startSettingsStream() {
    stopSettingsStream();

    if (typeof EventSource !== 'function') return;

    settingsStream = new EventSource(
      '/api/admin/public-settings/stream'
    );

    ['products-updated', 'promotions-updated'].forEach(eventName => {
      settingsStream.addEventListener(eventName, () => {
        loadCatalog();
        showToast('Catálogo actualizado');
      });
    });

    settingsStream.onerror = () => {
      setTimeout(() => {
        if (waiter && !settingsStream) {
          startSettingsStream();
        }
      }, 5000);
    };
  }

  function stopSettingsStream() {
    settingsStream?.close();
    settingsStream = null;
  }

  function categories() {
    const values = new Set(['Todos', 'Promociones']);

    products.forEach(product => {
      if (product.category) {
        values.add(product.category);
      }
    });

    return Array.from(values);
  }

  function renderCategories() {
    const available = categories();

    if (!available.includes(currentCategory)) {
      currentCategory = 'Todos';
    }

    categoryList.innerHTML = available
      .map(category => `
        <button
          class="category-chip ${category === currentCategory ? 'active' : ''}"
          type="button"
          data-category="${escapeHtml(category)}"
        >
          ${escapeHtml(category)}
        </button>
      `)
      .join('');
  }

  function productMinPrice(product) {
    return Math.min(
      ...product.options.map(option => Number(option.price || 0))
    );
  }

  function promoMinPrice(promo) {
    return Math.min(
      ...promo.prices.map(price => Number(price.price || 0))
    );
  }

  function matchesSearch(entry) {
    if (!currentSearch) return true;
    return normalizeText(
      [
        entry.name,
        entry.description,
        entry.category,
        entry.tag
      ].join(' ')
    ).includes(currentSearch);
  }

  function renderCatalog() {
    const productEntries = products
      .map(product => ({
        kind: 'product',
        id: product.id,
        name: product.name,
        description: product.description,
        category: product.category,
        tag: product.tag || product.category,
        image: product.image,
        price: productMinPrice(product)
      }))
      .filter(entry =>
        (currentCategory === 'Todos' ||
          currentCategory === entry.category) &&
        matchesSearch(entry)
      );

    const promoEntries = promotions
      .map(promo => ({
        kind: 'promotion',
        id: promo.id,
        name: promo.title,
        description: promo.text,
        category: 'Promociones',
        tag: promo.chip || 'Promo',
        image: '',
        price: promoMinPrice(promo)
      }))
      .filter(entry =>
        (currentCategory === 'Todos' ||
          currentCategory === 'Promociones') &&
        matchesSearch(entry)
      );

    const entries = [...promoEntries, ...productEntries];

    if (!entries.length) {
      catalogGrid.innerHTML = `
        <div class="empty">
          No hay productos que coincidan con la búsqueda.
        </div>
      `;
      return;
    }

    catalogGrid.innerHTML = entries
      .map(entry => `
        <article class="catalog-card">
          ${
            entry.image
              ? `<img class="catalog-image" src="${escapeHtml(entry.image)}" alt="" loading="lazy" />`
              : `<div class="catalog-placeholder">${entry.kind === 'promotion' ? '🎉' : '🌮'}</div>`
          }
          <div class="catalog-body">
            <span class="catalog-tag">${escapeHtml(entry.tag)}</span>
            <h3>${escapeHtml(entry.name)}</h3>
            <span class="catalog-price">Desde ${formatMoney(entry.price)}</span>
            <button
              type="button"
              data-open-kind="${entry.kind}"
              data-open-id="${escapeHtml(entry.id)}"
            >
              Agregar
            </button>
          </div>
        </article>
      `)
      .join('');
  }

  function openOverlay(element) {
    element.classList.remove('hidden');
    element.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
  }

  function closeOverlay(element) {
    element.classList.add('hidden');
    element.setAttribute('aria-hidden', 'true');

    if (
      itemOverlay.classList.contains('hidden') &&
      cartOverlay.classList.contains('hidden') &&
      confirmOverlay.classList.contains('hidden') &&
      successOverlay.classList.contains('hidden')
    ) {
      document.body.style.overflow = '';
    }
  }

  function selectedOptions() {
    if (!selectedEntry) return [];

    return selectedEntry.kind === 'promotion'
      ? selectedEntry.data.prices.map(price => ({
          id: price.id,
          name: price.label,
          price: price.price
        }))
      : selectedEntry.data.options;
  }

  function renderItemSheet() {
    if (!selectedEntry) return;

    const data = selectedEntry.data;
    const options = selectedOptions();
    const current =
      options.find(option => option.id === selectedOptionId) ||
      options[0];

    selectedOptionId = current?.id || '';

    itemSheetTitle.textContent =
      selectedEntry.kind === 'promotion'
        ? `Promoción: ${data.title}`
        : data.name;

    itemSheetDescription.textContent =
      selectedEntry.kind === 'promotion'
        ? data.text
        : data.description || data.note || '';

    itemOptionList.innerHTML = options
      .map(option => `
        <button
          class="option-button ${option.id === selectedOptionId ? 'active' : ''}"
          type="button"
          data-select-option="${escapeHtml(option.id)}"
        >
          <span>${escapeHtml(option.name)}</span>
          <strong>${formatMoney(option.price)}</strong>
        </button>
      `)
      .join('');

    const choices =
      selectedEntry.kind === 'product'
        ? data.choices
        : [];

    choiceField.classList.toggle(
      'hidden',
      choices.length === 0
    );

    itemChoiceSelect.innerHTML = choices
      .map(choice => `
        <option value="${escapeHtml(choice)}">${escapeHtml(choice)}</option>
      `)
      .join('');

    itemQtyLabel.textContent = String(selectedQty);
    addSelectedItemBtn.textContent =
      `Agregar · ${formatMoney((current?.price || 0) * selectedQty)}`;
  }

  function openItem(kind, id) {
    const data =
      kind === 'promotion'
        ? promotions.find(promo => promo.id === id)
        : products.find(product => product.id === id);

    if (!data) {
      showToast('El artículo ya no está disponible');
      return;
    }

    selectedEntry = { kind, data };
    selectedQty = 1;

    const options =
      kind === 'promotion'
        ? data.prices
        : data.options;

    selectedOptionId =
      String(options[0]?.id || '');

    renderItemSheet();
    openOverlay(itemOverlay);
  }

  function addSelectedItem() {
    if (!selectedEntry || !selectedOptionId) return;

    const options = selectedOptions();
    const option = options.find(
      item => item.id === selectedOptionId
    );

    if (!option) return;

    const choice =
      selectedEntry.kind === 'product'
        ? String(itemChoiceSelect.value || '')
        : '';

    const productId =
      selectedEntry.kind === 'promotion'
        ? `promo::${selectedEntry.data.id}`
        : selectedEntry.data.id;

    const name =
      selectedEntry.kind === 'promotion'
        ? `Promoción: ${selectedEntry.data.title} - ${option.name}`
        : `${selectedEntry.data.name} - ${option.name}`;

    const key = [
      selectedEntry.kind,
      productId,
      option.id,
      choice || 'base'
    ].join('::');

    const existing = cart.find(item => item.key === key);

    if (existing) {
      existing.qty = Math.min(
        99,
        Number(existing.qty || 0) + selectedQty
      );
    } else {
      cart.push({
        key,
        kind: selectedEntry.kind,
        productId,
        optionId: option.id,
        choice,
        name,
        price: Number(option.price || 0),
        qty: selectedQty,
        notes: ''
      });
    }

    saveCart();
    renderCart();
    updateCartBar();
    closeOverlay(itemOverlay);
    showToast('Agregado a la orden');
  }

  function renderCart() {
    if (!cart.length) {
      cartItems.innerHTML = `
        <div class="empty">
          Todavía no has agregado productos.
        </div>
      `;
      updateCartBar();
      return;
    }

    cartItems.innerHTML = cart
      .map((item, index) => `
        <article class="cart-item" data-cart-index="${index}">
          <div class="cart-item-top">
            <div>
              <strong>${escapeHtml(item.name)}</strong>
              ${
                item.choice
                  ? `<p class="muted">${escapeHtml(item.choice)}</p>`
                  : ''
              }
            </div>
            <span class="cart-item-price">
              ${formatMoney(Number(item.price || 0) * Number(item.qty || 0))}
            </span>
          </div>

          <div class="cart-item-actions">
            <button type="button" data-cart-action="minus">−</button>
            <button type="button" aria-label="Cantidad">${Number(item.qty || 1)}</button>
            <button type="button" data-cart-action="plus">+</button>
            <button class="remove-btn" type="button" data-cart-action="remove">Eliminar</button>
          </div>

          <textarea
            class="cart-note"
            data-cart-note
            maxlength="160"
            placeholder="Observaciones: sin cebolla, salsa aparte..."
          >${escapeHtml(item.notes || '')}</textarea>
        </article>
      `)
      .join('');

    updateCartBar();
  }

  function updateCartItem(index, delta) {
    const item = cart[index];
    if (!item) return;

    item.qty = Math.max(
      0,
      Math.min(99, Number(item.qty || 0) + delta)
    );

    if (item.qty <= 0) {
      cart.splice(index, 1);
    }

    saveCart();
    renderCart();
  }

  function clearCart() {
    if (cart.length && !window.confirm('¿Vaciar toda la orden?')) {
      return;
    }

    cart = [];
    saveCart();
    renderCart();
    updateCartBar();
    closeOverlay(cartOverlay);
  }

  function openCart() {
    if (!cart.length) return;
    renderCart();
    openOverlay(cartOverlay);
  }

  function showConfirmation() {
    if (!cart.length) {
      showToast('Agrega productos antes de enviar');
      return;
    }

    const totals = cartTotals();
    confirmSummary.textContent =
      `${deliveryType} · ${totals.units} artículo${totals.units === 1 ? '' : 's'} · ${formatMoney(totals.total)}`;

    closeOverlay(cartOverlay);
    openOverlay(confirmOverlay);
  }

  async function sendOrder() {
    if (sending || !cart.length) return;

    sending = true;
    confirmSendBtn.disabled = true;
    confirmSendBtn.textContent = 'Enviando...';

    try {
      const result = await api('/api/meseros/orders', {
        method: 'POST',
        body: JSON.stringify({
          tipoEntrega: deliveryType,
          items: cart.map(item => ({
            kind: item.kind,
            productId: item.productId,
            optionId: item.optionId,
            choice: item.choice || '',
            notes: item.notes || '',
            qty: item.qty
          }))
        })
      });

      const order = result.pedido || {};

      cart = [];
      saveCart();
      renderCart();
      updateCartBar();
      closeOverlay(confirmOverlay);

      successTitle.textContent =
        `Orden #${order.id || ''} enviada`;
      successText.textContent =
        `${order.tipoEntrega || deliveryType} · ${formatMoney(order.total || 0)} · Estado Confirmado`;

      openOverlay(successOverlay);
    } catch (error) {
      if (error.status === 401) {
        closeOverlay(confirmOverlay);
        setAuthenticated(false);
        showToast('Tu sesión terminó. Vuelve a entrar.');
        return;
      }

      showToast(error.message || 'No se pudo enviar la orden');
    } finally {
      sending = false;
      confirmSendBtn.disabled = false;
      confirmSendBtn.textContent = 'Confirmar y enviar';
    }
  }

  function newOrder() {
    closeOverlay(successOverlay);
    catalogSearchInput.value = '';
    currentSearch = '';
    currentCategory = 'Todos';
    renderCategories();
    renderCatalog();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function setupInstall() {
    window.addEventListener('beforeinstallprompt', event => {
      event.preventDefault();
      deferredInstallPrompt = event;
      installAppBtn.classList.remove('hidden');
    });

    window.addEventListener('appinstalled', () => {
      deferredInstallPrompt = null;
      installAppBtn.classList.add('hidden');
      showToast('Aplicación instalada');
    });

    const isIos =
      /iphone|ipad|ipod/i.test(navigator.userAgent);

    const standalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      window.navigator.standalone === true;

    if (isIos && !standalone) {
      installAppBtn.classList.remove('hidden');
    }

    installAppBtn.addEventListener('click', async () => {
      if (deferredInstallPrompt) {
        deferredInstallPrompt.prompt();
        await deferredInstallPrompt.userChoice.catch(() => {});
        deferredInstallPrompt = null;
        installAppBtn.classList.add('hidden');
        return;
      }

      showToast(
        'En iPhone: Compartir → Agregar a pantalla de inicio'
      );
    });

    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker
          .register('./sw.js', { scope: './' })
          .catch(error => {
            console.warn('No se pudo registrar la app de meseros', error);
          });
      });
    }
  }

  loginForm.addEventListener('submit', handleLogin);
  logoutWaiterBtn.addEventListener('click', logout);

  document
    .querySelectorAll('[data-delivery-type]')
    .forEach(button => {
      button.addEventListener('click', () => {
        setDeliveryType(button.dataset.deliveryType);
      });
    });

  catalogSearchInput.addEventListener('input', () => {
    currentSearch = normalizeText(
      catalogSearchInput.value
    );
    renderCatalog();
  });

  categoryList.addEventListener('click', event => {
    const button = event.target.closest('[data-category]');
    if (!button) return;

    currentCategory = button.dataset.category;
    renderCategories();
    renderCatalog();
  });

  catalogGrid.addEventListener('click', event => {
    const button = event.target.closest('[data-open-kind]');
    if (!button) return;

    openItem(
      button.dataset.openKind,
      button.dataset.openId
    );
  });

  itemOptionList.addEventListener('click', event => {
    const button = event.target.closest('[data-select-option]');
    if (!button) return;

    selectedOptionId = button.dataset.selectOption;
    renderItemSheet();
  });

  itemQtyMinusBtn.addEventListener('click', () => {
    selectedQty = Math.max(1, selectedQty - 1);
    renderItemSheet();
  });

  itemQtyPlusBtn.addEventListener('click', () => {
    selectedQty = Math.min(99, selectedQty + 1);
    renderItemSheet();
  });

  closeItemSheetBtn.addEventListener('click', () => {
    closeOverlay(itemOverlay);
  });

  addSelectedItemBtn.addEventListener('click', addSelectedItem);
  openCartBtn.addEventListener('click', openCart);
  closeCartBtn.addEventListener('click', () => closeOverlay(cartOverlay));
  clearCartBtn.addEventListener('click', clearCart);
  sendOrderBtn.addEventListener('click', showConfirmation);
  cancelConfirmBtn.addEventListener('click', () => {
    closeOverlay(confirmOverlay);
    openOverlay(cartOverlay);
  });
  confirmSendBtn.addEventListener('click', sendOrder);
  newOrderBtn.addEventListener('click', newOrder);

  cartItems.addEventListener('click', event => {
    const action = event.target.closest('[data-cart-action]');
    if (!action) return;

    const row = action.closest('[data-cart-index]');
    const index = Number(row?.dataset.cartIndex);

    if (!Number.isInteger(index)) return;

    if (action.dataset.cartAction === 'plus') {
      updateCartItem(index, 1);
    }

    if (action.dataset.cartAction === 'minus') {
      updateCartItem(index, -1);
    }

    if (action.dataset.cartAction === 'remove') {
      cart.splice(index, 1);
      saveCart();
      renderCart();
    }
  });

  cartItems.addEventListener('input', event => {
    const input = event.target.closest('[data-cart-note]');
    if (!input) return;

    const row = input.closest('[data-cart-index]');
    const index = Number(row?.dataset.cartIndex);

    if (!cart[index]) return;

    cart[index].notes = input.value.slice(0, 160);
    saveCart();
  });

  [itemOverlay, cartOverlay, confirmOverlay].forEach(overlay => {
    overlay.addEventListener('click', event => {
      if (event.target === overlay) {
        closeOverlay(overlay);
      }
    });
  });

  window.addEventListener('focus', () => {
    if (waiter) loadCatalog();
  });

  setDeliveryType(deliveryType);
  renderCart();
  updateCartBar();
  setupInstall();
  checkSession();
})();
