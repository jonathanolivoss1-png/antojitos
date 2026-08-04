(function () {
  'use strict';

  const adminApp = document.getElementById('adminApp');
  const toast = document.getElementById('adminToast');

  const promoList = document.getElementById('promoList');
  const productList = document.getElementById('productList');

  const addPromoBtn = document.getElementById('addPromoBtn');
  const savePromosBtn = document.getElementById('savePromosBtn');
  const addProductBtn = document.getElementById('addProductBtn');
  const saveProductsBtn = document.getElementById('saveProductsBtn');

  const togglePromosPanelBtn =
    document.getElementById('togglePromosPanelBtn');

  const promosPanelContent =
    document.getElementById('promosPanelContent');

  const toggleProductsPanelBtn =
    document.getElementById('toggleProductsPanelBtn');

  const productsPanelContent =
    document.getElementById('productsPanelContent');

  let promotions = [];
  let products = [];
  let loadedForCurrentSession = false;

  // === ADMIN_CATALOG_COLLAPSIBLE_V1 ===
  function setCatalogPanelState(
    toggle,
    content,
    isOpen
  ) {
    if (!toggle || !content) return;

    const open = Boolean(isOpen);
    const label = toggle.querySelector(
      '[data-role="toggle-label"]'
    );

    toggle.setAttribute(
      'aria-expanded',
      String(open)
    );

    content.hidden = !open;

    if (label) {
      label.textContent = open
        ? toggle.dataset.openLabel
        : toggle.dataset.closedLabel;
    }
  }

  function openPromotionsPanel() {
    setCatalogPanelState(
      togglePromosPanelBtn,
      promosPanelContent,
      true
    );
  }

  function openProductsPanel() {
    setCatalogPanelState(
      toggleProductsPanelBtn,
      productsPanelContent,
      true
    );
  }

  function initCatalogPanels() {
    setCatalogPanelState(
      togglePromosPanelBtn,
      promosPanelContent,
      false
    );

    setCatalogPanelState(
      toggleProductsPanelBtn,
      productsPanelContent,
      false
    );

    togglePromosPanelBtn?.addEventListener(
      'click',
      () => {
        const isOpen =
          togglePromosPanelBtn.getAttribute(
            'aria-expanded'
          ) === 'true';

        setCatalogPanelState(
          togglePromosPanelBtn,
          promosPanelContent,
          !isOpen
        );
      }
    );

    toggleProductsPanelBtn?.addEventListener(
      'click',
      () => {
        const isOpen =
          toggleProductsPanelBtn.getAttribute(
            'aria-expanded'
          ) === 'true';

        setCatalogPanelState(
          toggleProductsPanelBtn,
          productsPanelContent,
          !isOpen
        );
      }
    );
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function createId(prefix) {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return `${prefix}-${window.crypto.randomUUID()}`;
    }

    return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function showToast(message, isError = false) {
    if (!toast) return;

    toast.textContent = message;
    toast.style.background = isError
      ? 'rgba(167,51,25,0.96)'
      : 'rgba(46,125,50,0.96)';
    toast.classList.add('show');

    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => {
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
      const error = new Error(data?.message || `Error ${response.status}`);
      error.status = response.status;
      throw error;
    }

    return data;
  }

  function normalizePromo(promo = {}) {
    return {
      id: String(promo.id || createId('promo')),
      title: String(promo.title || ''),
      text: String(promo.text || ''),
      chip: String(promo.chip || 'Promo'),
      active: promo.active !== false,
      prices: Array.isArray(promo.prices)
        ? promo.prices.map(price => ({
            id: String(price?.id || createId('promo-price')),
            label: String(price?.label || price?.name || ''),
            price: Number(price?.price || 0)
          }))
        : []
    };
  }

  function normalizeProduct(product = {}) {
    return {
      id: String(product.id || createId('product')),
      name: String(product.name || ''),
      description: String(product.description || ''),
      image: String(product.image || ''),
      category: String(product.category || 'antojitos'),
      tag: String(product.tag || ''),
      note: String(product.note || ''),
      priceLabel: String(product.priceLabel || ''),
      active: product.active !== false,
      available: product.available !== false,
      choices: Array.isArray(product.choices)
        ? product.choices.map(String)
        : [],
      options: Array.isArray(product.options) && product.options.length
        ? product.options.map(option => ({
            id: String(option?.id || createId('option')),
            name: String(option?.name || ''),
            price: Number(option?.price || 0)
          }))
        : [
            {
              id: createId('option'),
              name: '',
              price: 0
            }
          ]
    };
  }

  function renderPromotions() {
    if (!promoList) return;

    if (!promotions.length) {
      promoList.innerHTML =
        '<p class="meta-note">No hay promociones. Presiona “Nueva promoción”.</p>';
      return;
    }

    promoList.innerHTML = promotions
      .map(
        (promo, promoIndex) => `
          <article class="promo-card" data-promo-index="${promoIndex}">
            <div class="promo-top">
              <div>
                <span class="tag">Promoción ${promoIndex + 1}</span>
                <h3>${escapeHtml(promo.title || 'Nueva promoción')}</h3>
              </div>

              <div class="switches">
                <label class="switch">
                  <input
                    type="checkbox"
                    data-promo-field="active"
                    ${promo.active ? 'checked' : ''}
                  />
                  Activa
                </label>

                <button
                  class="danger-btn"
                  type="button"
                  data-catalog-action="remove-promo"
                  data-promo-index="${promoIndex}"
                >
                  Eliminar
                </button>
              </div>
            </div>

            <div class="form-grid">
              <div class="form-group">
                <label>Título</label>
                <input
                  type="text"
                  data-promo-field="title"
                  value="${escapeHtml(promo.title)}"
                  placeholder="Ej. Combo de fin de semana"
                />
              </div>

              <div class="form-group">
                <label>Etiqueta</label>
                <input
                  type="text"
                  data-promo-field="chip"
                  value="${escapeHtml(promo.chip)}"
                  placeholder="Ej. Oferta"
                />
              </div>

              <div class="form-group full">
                <label>Descripción</label>
                <textarea
                  data-promo-field="text"
                  placeholder="Describe la promoción"
                >${escapeHtml(promo.text)}</textarea>
              </div>
            </div>

            <div class="promo-prices">
              <div class="product-top">
                <strong>Precios opcionales</strong>
                <button
                  class="ghost-btn"
                  type="button"
                  data-catalog-action="add-promo-price"
                  data-promo-index="${promoIndex}"
                >
                  Agregar precio
                </button>
              </div>

              ${(promo.prices || [])
                .map(
                  (price, priceIndex) => `
                    <div
                      class="promo-price-row"
                      data-promo-price-index="${priceIndex}"
                    >
                      <div class="form-group">
                        <label>Concepto</label>
                        <input
                          type="text"
                          data-promo-price-field="label"
                          value="${escapeHtml(price.label)}"
                          placeholder="Ej. Combo para dos"
                        />
                      </div>

                      <div class="form-group">
                        <label>Precio</label>
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          data-promo-price-field="price"
                          value="${Number(price.price || 0)}"
                        />
                      </div>

                      <button
                        class="danger-btn"
                        type="button"
                        data-catalog-action="remove-promo-price"
                        data-promo-index="${promoIndex}"
                        data-price-index="${priceIndex}"
                      >
                        Quitar
                      </button>
                    </div>
                  `
                )
                .join('')}
            </div>
          </article>
        `
      )
      .join('');
  }

  function renderProducts() {
    if (!productList) return;

    if (!products.length) {
      productList.innerHTML =
        '<p class="meta-note">No hay productos. Presiona “Nuevo producto”.</p>';
      return;
    }

    productList.innerHTML = products
      .map(
        (product, productIndex) => `
          <article class="product-card" data-product-index="${productIndex}">
            <div class="product-top">
              <div>
                <span class="tag">Producto ${productIndex + 1}</span>
                <h3>${escapeHtml(product.name || 'Nuevo producto')}</h3>
              </div>

              <div class="switches">
                <label class="switch">
                  <input
                    type="checkbox"
                    data-product-field="active"
                    ${product.active ? 'checked' : ''}
                  />
                  Visible
                </label>

                <label class="switch">
                  <input
                    type="checkbox"
                    data-product-field="available"
                    ${product.available ? 'checked' : ''}
                  />
                  Disponible
                </label>

                <button
                  class="danger-btn"
                  type="button"
                  data-catalog-action="remove-product"
                  data-product-index="${productIndex}"
                >
                  Eliminar
                </button>
              </div>
            </div>

            <div class="form-grid">
              <div class="form-group">
                <label>Nombre</label>
                <input
                  type="text"
                  data-product-field="name"
                  value="${escapeHtml(product.name)}"
                  placeholder="Ej. Tacos de cecina"
                />
              </div>

              <div class="form-group">
                <label>Categoría</label>
                <input
                  type="text"
                  data-product-field="category"
                  value="${escapeHtml(product.category)}"
                  placeholder="Ej. tacos"
                />
              </div>

              <div class="form-group full">
                <label>Descripción</label>
                <textarea
                  data-product-field="description"
                  placeholder="Describe el producto"
                >${escapeHtml(product.description)}</textarea>
              </div>

              <div class="form-group full">
                <label>URL de imagen</label>
                <input
                  type="url"
                  data-product-field="image"
                  value="${escapeHtml(product.image)}"
                  placeholder="https://..."
                />
              </div>

              <div class="form-group">
                <label>Etiqueta</label>
                <input
                  type="text"
                  data-product-field="tag"
                  value="${escapeHtml(product.tag)}"
                  placeholder="Ej. Más pedido"
                />
              </div>

              <div class="form-group">
                <label>Precio mostrado</label>
                <input
                  type="text"
                  data-product-field="priceLabel"
                  value="${escapeHtml(product.priceLabel)}"
                  placeholder="Ej. $25 / $30"
                />
              </div>

              <div class="form-group full">
                <label>Nota</label>
                <input
                  type="text"
                  data-product-field="note"
                  value="${escapeHtml(product.note)}"
                  placeholder="Ej. Incluye guarniciones"
                />
              </div>

              <div class="form-group full">
                <label>Formas de preparación, separadas por coma</label>
                <input
                  type="text"
                  data-product-field="choices"
                  value="${escapeHtml((product.choices || []).join(', '))}"
                  placeholder="Ej. Frita, Comal"
                />
              </div>
            </div>

            <div class="options-editor">
              <div class="product-top">
                <strong>Opciones y precios</strong>
                <button
                  class="ghost-btn"
                  type="button"
                  data-catalog-action="add-product-option"
                  data-product-index="${productIndex}"
                >
                  Agregar opción
                </button>
              </div>

              ${(product.options || [])
                .map(
                  (option, optionIndex) => `
                    <div
                      class="option-row"
                      data-product-option-index="${optionIndex}"
                    >
                      <input
                        type="text"
                        data-product-option-field="name"
                        value="${escapeHtml(option.name)}"
                        placeholder="Nombre de opción"
                      />

                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        data-product-option-field="price"
                        value="${Number(option.price || 0)}"
                        placeholder="Precio"
                      />

                      <button
                        class="danger-btn"
                        type="button"
                        data-catalog-action="remove-product-option"
                        data-product-index="${productIndex}"
                        data-option-index="${optionIndex}"
                      >
                        Quitar
                      </button>
                    </div>
                  `
                )
                .join('')}
            </div>
          </article>
        `
      )
      .join('');
  }

  function readPromotionsFromDom() {
    if (!promoList) return [];

    return Array.from(promoList.querySelectorAll('.promo-card[data-promo-index]')).map(
      card => {
        const promoIndex = Number(card.dataset.promoIndex);
        const original = promotions[promoIndex] || normalizePromo();

        const read = field =>
          card.querySelector(`[data-promo-field="${field}"]`);

        const prices = Array.from(
          card.querySelectorAll('[data-promo-price-index]')
        )
          .map((row, priceIndex) => {
            const originalPrice =
              original.prices?.[priceIndex] || {
                id: createId('promo-price')
              };

            return {
              id: originalPrice.id,
              label:
                row
                  .querySelector('[data-promo-price-field="label"]')
                  ?.value.trim() || '',
              price: Number(
                row.querySelector('[data-promo-price-field="price"]')?.value ||
                  0
              )
            };
          })
          .filter(item => item.label && Number.isFinite(item.price));

        return {
          id: original.id,
          title: read('title')?.value.trim() || '',
          text: read('text')?.value.trim() || '',
          chip: read('chip')?.value.trim() || 'Promo',
          active: Boolean(read('active')?.checked),
          ...(prices.length ? { prices } : {})
        };
      }
    );
  }

  function readProductsFromDom() {
    if (!productList) return [];

    return Array.from(productList.querySelectorAll('.product-card[data-product-index]')).map(
      card => {
        const productIndex = Number(card.dataset.productIndex);
        const original = products[productIndex] || normalizeProduct();

        const read = field =>
          card.querySelector(`[data-product-field="${field}"]`);

        const options = Array.from(
          card.querySelectorAll('[data-product-option-index]')
        )
          .map((row, optionIndex) => {
            const originalOption =
              original.options?.[optionIndex] || {
                id: createId('option')
              };

            return {
              id: originalOption.id,
              name:
                row
                  .querySelector('[data-product-option-field="name"]')
                  ?.value.trim() || '',
              price: Number(
                row.querySelector('[data-product-option-field="price"]')
                  ?.value || 0
              )
            };
          })
          .filter(
            option =>
              option.name &&
              Number.isFinite(option.price) &&
              option.price >= 0
          );

        const choices = String(read('choices')?.value || '')
          .split(',')
          .map(item => item.trim())
          .filter(Boolean);

        return {
          id: original.id,
          name: read('name')?.value.trim() || '',
          description: read('description')?.value.trim() || '',
          image: read('image')?.value.trim() || '',
          category: read('category')?.value.trim() || 'general',
          tag: read('tag')?.value.trim() || '',
          note: read('note')?.value.trim() || '',
          priceLabel: read('priceLabel')?.value.trim() || '',
          active: Boolean(read('active')?.checked),
          available: Boolean(read('available')?.checked),
          options,
          ...(choices.length ? { choices } : {})
        };
      }
    );
  }

  function validatePromotions(items) {
    const invalidIndex = items.findIndex(item => !item.title || !item.text);

    if (invalidIndex >= 0) {
      throw new Error(
        `La promoción ${invalidIndex + 1} necesita título y descripción.`
      );
    }
  }

  function validateProducts(items) {
    const invalidIndex = items.findIndex(
      item => !item.name || !item.description || !item.options.length
    );

    if (invalidIndex >= 0) {
      throw new Error(
        `El producto ${invalidIndex + 1} necesita nombre, descripción y al menos una opción con precio.`
      );
    }
  }

  async function loadCatalogAdmin() {
    try {
      const [promoResult, productResult] = await Promise.all([
        api('/api/admin/promotions'),
        api('/api/admin/products')
      ]);

      promotions = Array.isArray(promoResult?.promotions)
        ? promoResult.promotions.map(normalizePromo)
        : [];

      products = Array.isArray(productResult?.products)
        ? productResult.products.map(normalizeProduct)
        : [];

      renderPromotions();
      renderProducts();
      loadedForCurrentSession = true;
    } catch (error) {
      if (error.status !== 401) {
        console.error('No se pudo cargar productos/promociones:', error);
        showToast(error.message || 'No se pudo cargar el catálogo', true);
      }
    }
  }

  async function savePromotions() {
    try {
      const next = readPromotionsFromDom();
      validatePromotions(next);

      const result = await api('/api/admin/promotions', {
        method: 'PUT',
        body: JSON.stringify({ promotions: next })
      });

      promotions = Array.isArray(result?.promotions)
        ? result.promotions.map(normalizePromo)
        : next.map(normalizePromo);

      renderPromotions();
      showToast('Promociones guardadas');
    } catch (error) {
      console.error('No se pudieron guardar promociones:', error);
      showToast(error.message || 'No se pudieron guardar promociones', true);
    }
  }

  async function saveProducts() {
    try {
      const next = readProductsFromDom();
      validateProducts(next);

      const result = await api('/api/admin/products', {
        method: 'PUT',
        body: JSON.stringify({ products: next })
      });

      products = Array.isArray(result?.products)
        ? result.products.map(normalizeProduct)
        : next.map(normalizeProduct);

      renderProducts();
      showToast('Productos guardados');
    } catch (error) {
      console.error('No se pudieron guardar productos:', error);
      showToast(error.message || 'No se pudieron guardar productos', true);
    }
  }

  function handlePromoClick(event) {
    const button = event.target.closest('[data-catalog-action]');
    if (!button) return;

    const action = button.dataset.catalogAction;
    const promoIndex = Number(button.dataset.promoIndex);

    promotions = readPromotionsFromDom().map(normalizePromo);

    if (action === 'remove-promo') {
      promotions.splice(promoIndex, 1);
      renderPromotions();
      return;
    }

    if (action === 'add-promo-price') {
      promotions[promoIndex].prices =
        promotions[promoIndex].prices || [];
      promotions[promoIndex].prices.push({
        id: createId('promo-price'),
        label: '',
        price: 0
      });
      renderPromotions();
      return;
    }

    if (action === 'remove-promo-price') {
      const priceIndex = Number(button.dataset.priceIndex);
      promotions[promoIndex].prices.splice(priceIndex, 1);
      renderPromotions();
    }
  }

  function handleProductClick(event) {
    const button = event.target.closest('[data-catalog-action]');
    if (!button) return;

    const action = button.dataset.catalogAction;
    const productIndex = Number(button.dataset.productIndex);

    products = readProductsFromDom().map(normalizeProduct);

    if (action === 'remove-product') {
      products.splice(productIndex, 1);
      renderProducts();
      return;
    }

    if (action === 'add-product-option') {
      products[productIndex].options =
        products[productIndex].options || [];
      products[productIndex].options.push({
        id: createId('option'),
        name: '',
        price: 0
      });
      renderProducts();
      return;
    }

    if (action === 'remove-product-option') {
      const optionIndex = Number(button.dataset.optionIndex);
      products[productIndex].options.splice(optionIndex, 1);

      if (!products[productIndex].options.length) {
        products[productIndex].options.push({
          id: createId('option'),
          name: '',
          price: 0
        });
      }

      renderProducts();
    }
  }

  function bindCatalogEvents() {
    addPromoBtn?.addEventListener('click', () => {
      openPromotionsPanel();
      promotions = readPromotionsFromDom().map(normalizePromo);
      promotions.push(
        normalizePromo({
          title: '',
          text: '',
          chip: 'Promo',
          active: true
        })
      );
      renderPromotions();
    });

    addProductBtn?.addEventListener('click', () => {
      openProductsPanel();
      products = readProductsFromDom().map(normalizeProduct);
      products.push(normalizeProduct());
      renderProducts();
    });

    savePromosBtn?.addEventListener('click', savePromotions);
    saveProductsBtn?.addEventListener('click', saveProducts);

    promoList?.addEventListener('click', handlePromoClick);
    productList?.addEventListener('click', handleProductClick);
  }

  function watchAuthentication() {
    if (!adminApp) return;

    const tryLoad = () => {
      const isVisible = !adminApp.classList.contains('hidden');

      if (isVisible && !loadedForCurrentSession) {
        void loadCatalogAdmin();
      }

      if (!isVisible) {
        loadedForCurrentSession = false;
      }
    };

    const observer = new MutationObserver(tryLoad);
    observer.observe(adminApp, {
      attributes: true,
      attributeFilter: ['class']
    });

    tryLoad();
  }

  initCatalogPanels();
  bindCatalogEvents();
  watchAuthentication();
})();
