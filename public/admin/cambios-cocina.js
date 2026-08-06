// DELIVERED_PRODUCTS_NORMAL_STATUS_CHIP_V3
// KITCHEN_PRODUCT_CHANGE_MARKERS_V1
(function () {
  'use strict';

  const tableBody =
    document.getElementById('adminOrdersTableBody');

  const detailContent =
    document.getElementById('orderDetailContent');

  if (!tableBody) return;

  const summaries = new Map();
  let refreshTimer = null;
  let refreshController = null;

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function quantity(value) {
    const number = Number(value || 0);

    if (Number.isInteger(number)) {
      return String(number);
    }

    return number.toLocaleString(
      'es-MX',
      {
        maximumFractionDigits: 2
      }
    );
  }

  function formatDate(value) {
    try {
      return new Intl.DateTimeFormat(
        'es-MX',
        {
          dateStyle: 'short',
          timeStyle: 'short'
        }
      ).format(new Date(value));
    } catch {
      return '';
    }
  }

  function showKitchenToast(message, isError = false) {
    let toast =
      document.getElementById('kitchenChangesToast');

    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'kitchenChangesToast';
      toast.className = 'kitchen-changes-toast';
      document.body.appendChild(toast);
    }

    toast.textContent = message;
    toast.classList.toggle('is-error', isError);
    toast.classList.add('show');

    clearTimeout(showKitchenToast.timer);
    showKitchenToast.timer = setTimeout(
      () => toast.classList.remove('show'),
      2600
    );
  }

  function instructionHtml(value, label) {
    if (!value) return '';

    return `
      <small class="kitchen-instruction">
        ${escapeHtml(label)}:
        <strong>${escapeHtml(value)}</strong>
      </small>
    `;
  }

  function unchangedLine(item, pending) {
    return `
      <div class="kitchen-product-line is-original">
        <div>
          <strong>
            ${quantity(item.currentQty)}x
            ${escapeHtml(item.name)}
          </strong>
          ${instructionHtml(
            item.currentInstruction,
            'Indicación'
          )}
        </div>
        ${pending
          ? '<span class="kitchen-chip original">SIN CAMBIO</span>'
          : ''}
      </div>
    `;
  }

  function renderPendingItem(item) {
    const instructionChange =
      item.instructionChanged
        ? `
          <div class="kitchen-instruction-change">
            ${instructionHtml(
              item.previousInstruction || 'Sin indicación',
              'Antes'
            )}
            ${instructionHtml(
              item.currentInstruction || 'Sin indicación',
              'Ahora'
            )}
          </div>
        `
        : instructionHtml(
            item.currentInstruction,
            'Indicación actual'
          );

    if (item.kind === 'added') {
      return `
        <div class="kitchen-product-line is-pending">
          <div>
            <strong>
              +${quantity(item.currentQty)}x
              ${escapeHtml(item.name)}
            </strong>
            ${instructionHtml(
              item.currentInstruction,
              'Indicación'
            )}
          </div>
          <span class="kitchen-chip pending">
            PENDIENTE NUEVO
          </span>
        </div>
      `;
    }

    if (item.kind === 'increased') {
      return `
        <div class="kitchen-product-line is-original">
          <div>
            <strong>
              ${quantity(item.previousQty)}x
              ${escapeHtml(item.name)}
            </strong>
            <small>Ya estaban en la orden</small>
          </div>
          <span class="kitchen-chip original">
            ORIGINAL
          </span>
        </div>

        <div class="kitchen-product-line is-pending">
          <div>
            <strong>
              +${quantity(item.pendingQty)}x
              ${escapeHtml(item.name)}
            </strong>
            ${instructionChange}
          </div>
          <span class="kitchen-chip pending">
            PREPARAR EXTRA
          </span>
        </div>
      `;
    }

    if (item.kind === 'reduced') {
      return `
        ${item.currentQty > 0
          ? `
            <div class="kitchen-product-line is-warning">
              <div>
                <strong>
                  ${quantity(item.currentQty)}x
                  ${escapeHtml(item.name)}
                </strong>
                ${instructionChange}
              </div>
              <span class="kitchen-chip warning">
                PREPARAR SOLO ESTO
              </span>
            </div>
          `
          : ''}

        <div class="kitchen-product-line is-removed">
          <div>
            <strong>
              −${quantity(item.removedQty)}x
              ${escapeHtml(item.name)}
            </strong>
            <small>La cantidad fue reducida</small>
          </div>
          <span class="kitchen-chip removed">
            NO PREPARAR
          </span>
        </div>
      `;
    }

    if (item.kind === 'removed') {
      return `
        <div class="kitchen-product-line is-removed">
          <div>
            <strong>
              ${quantity(item.previousQty)}x
              ${escapeHtml(item.name)}
            </strong>
            ${instructionHtml(
              item.previousInstruction,
              'Indicación anterior'
            )}
          </div>
          <span class="kitchen-chip removed">
            RETIRADO · NO PREPARAR
          </span>
        </div>
      `;
    }

    if (item.kind === 'instruction_changed') {
      return `
        <div class="kitchen-product-line is-instruction">
          <div>
            <strong>
              ${quantity(item.currentQty)}x
              ${escapeHtml(item.name)}
            </strong>
            ${instructionChange}
          </div>
          <span class="kitchen-chip instruction">
            NUEVA INDICACIÓN
          </span>
        </div>
      `;
    }

    return unchangedLine(item, true);
  }

  function renderCurrentProducts(summary) {
    return (summary.currentProducts || [])
      .map(item => `
        <div class="kitchen-product-line is-attended">
          <div>
            <strong>
              ${quantity(item.qty)}x
              ${escapeHtml(item.name)}
            </strong>
            ${instructionHtml(
              item.instruction,
              'Indicación'
            )}
          </div>
          <span class="kitchen-chip attended">
            CAMBIO ATENDIDO
          </span>
        </div>
      `)
      .join('');
  }

  function renderKitchenProducts(summary, isArchived) {
    if (!summary) return '';

    const deliveryNotice =
      summary.deliveryChanged
        ? `
          <div class="kitchen-delivery-change">
            ⚠️ Tipo de entrega cambiado:
            <s>${escapeHtml(summary.previousDelivery || '-')}</s>
            →
            <strong>${escapeHtml(summary.currentDelivery || '-')}</strong>
          </div>
        `
        : '';

    if (!summary.pending) {
      return `
        <div class="kitchen-products-box is-attended-box">
          <div class="kitchen-box-heading">
            <strong>✓ Cambios atendidos por cocina</strong>
            <small>
              ${escapeHtml(formatDate(summary.latestCorrectionAt))}
            </small>
          </div>
          ${renderCurrentProducts(summary)}
          ${deliveryNotice}
        </div>
      `;
    }

    return `
      <div class="kitchen-products-box is-pending-box">
        <div class="kitchen-box-heading">
          <strong>⚠️ CAMBIO PENDIENTE</strong>
          <small>
            ${escapeHtml(summary.latestReason || 'Pedido modificado')}
          </small>
        </div>

        ${summary.items
          .map(renderPendingItem)
          .join('')}

        ${deliveryNotice}

        ${isArchived
          ? ''
          : `
            <button
              class="kitchen-ack-button"
              type="button"
              data-kitchen-action="acknowledge"
              data-order-id="${Number(summary.orderId)}"
              data-correction-id="${Number(summary.latestCorrectionId)}"
            >
              ✓ Marcar cambios atendidos
            </button>
          `}
      </div>
    `;
  }

  function applySummaryToRow(row, summary) {
    const productCell = row.cells?.[5];

    if (!productCell || !summary) return;

    const visibleStatus =
      String(
        row.dataset.orderStatus ||
        row
          .querySelector('.status-chip')
          ?.textContent ||
        ''
      )
        .trim()
        .toLowerCase();

    if (visibleStatus === 'entregado') {
      const products =
        Array.isArray(summary.currentProducts)
          ? summary.currentProducts
          : [];

      productCell.innerHTML = `
        <div class="admin-order-products">
          ${products
            .map(item => {
              const instruction =
                String(item?.instruction || '').trim();

              return `
                <span>
                  ${quantity(item?.qty || 1)}x
                  ${escapeHtml(item?.name || 'Producto')}
                  ${instruction
                    ? ` · ${escapeHtml(instruction)}`
                    : ''}
                </span>
              `;
            })
            .join('')}
        </div>
      `;

      row.classList.remove(
        'kitchen-row-pending',
        'kitchen-row-attended'
      );

      return;
    }

    const isArchived =
      row.dataset.orderArchived === 'true';

    productCell.innerHTML =
      renderKitchenProducts(summary, isArchived);

    row.classList.toggle(
      'kitchen-row-pending',
      Boolean(summary.pending)
    );

    row.classList.toggle(
      'kitchen-row-attended',
      !summary.pending
    );
  }

  function applySummaries() {
    tableBody
      .querySelectorAll('tr[data-order-id]')
      .forEach(row => {
        const id = String(
          Number(row.dataset.orderId || 0)
        );

        const summary = summaries.get(id);

        if (summary) {
          applySummaryToRow(row, summary);
        }
      });
  }

  function visibleOrderIds() {
    return Array.from(
      tableBody.querySelectorAll(
        'tr[data-order-id]'
      )
    )
      .filter(row => {
        const visibleStatus =
          String(
            row.dataset.orderStatus ||
            row
              .querySelector('.status-chip')
              ?.textContent ||
            ''
          )
            .trim()
            .toLowerCase();

        return visibleStatus !== 'entregado';
      })
      .map(
        row =>
          Number(row.dataset.orderId || 0)
      )
      .filter(
        id =>
          Number.isInteger(id) &&
          id > 0
      );
  }

  async function refreshKitchenChanges() {
    const ids = visibleOrderIds();

    if (!ids.length) {
      summaries.clear();
      return;
    }

    refreshController?.abort();
    refreshController = new AbortController();

    try {
      const response = await fetch(
        `/api/admin/cocina/cambios?ids=${encodeURIComponent(ids.join(','))}`,
        {
          credentials: 'same-origin',
          signal: refreshController.signal
        }
      );

      const data = await response.json().catch(() => null);

      if (!response.ok) {
        throw new Error(
          data?.message ||
          'No se pudieron cargar los cambios de cocina'
        );
      }

      summaries.clear();

      Object.entries(data?.changes || {})
        .forEach(([id, summary]) => {
          summaries.set(String(id), summary);
        });

      applySummaries();
    } catch (error) {
      if (error.name === 'AbortError') return;

      console.warn(
        'No se pudieron mostrar los cambios para cocina:',
        error
      );
    }
  }

  function scheduleRefresh() {
    clearTimeout(refreshTimer);

    refreshTimer = setTimeout(
      () => void refreshKitchenChanges(),
      80
    );
  }

  async function acknowledgeChanges(button) {
    const orderId = Number(button.dataset.orderId || 0);
    const correctionId = Number(
      button.dataset.correctionId || 0
    );

    if (!orderId || !correctionId) return;

    if (
      !window.confirm(
        '¿Cocina ya atendió todos los cambios señalados de este pedido?'
      )
    ) {
      return;
    }

    button.disabled = true;
    button.textContent = 'Guardando…';

    try {
      const response = await fetch(
        `/api/admin/cocina/pedidos/${orderId}/atender`,
        {
          method: 'POST',
          credentials: 'same-origin',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ correctionId })
        }
      );

      const data = await response.json().catch(() => null);

      if (!response.ok) {
        throw new Error(
          data?.message ||
          'No se pudieron marcar los cambios'
        );
      }

      showKitchenToast(
        `Cambios del pedido #${orderId} atendidos`
      );

      await refreshKitchenChanges();
    } catch (error) {
      showKitchenToast(
        error.message ||
        'No se pudieron marcar los cambios',
        true
      );

      button.disabled = false;
      button.textContent = '✓ Marcar cambios atendidos';
    }
  }

  function appendKitchenDetail(orderId) {
    if (!detailContent) return;

    detailContent
      .querySelector('.kitchen-detail-section')
      ?.remove();

    const row =
      Array.from(
        tableBody.querySelectorAll(
          'tr[data-order-id]'
        )
      ).find(
        item =>
          Number(item.dataset.orderId || 0) ===
          Number(orderId)
      );

    const visibleStatus =
      String(
        row?.dataset?.orderStatus ||
        row
          ?.querySelector('.status-chip')
          ?.textContent ||
        ''
      )
        .trim()
        .toLowerCase();

    if (visibleStatus === 'entregado') {
      return;
    }

    const summary =
      summaries.get(String(orderId));

    if (!summary) return;

    detailContent.insertAdjacentHTML(
      'beforeend',
      `
        <section class="kitchen-detail-section">
          <h4>Indicaciones actuales para cocina</h4>
          ${renderKitchenProducts(summary, true)}
        </section>
      `
    );
  }

  tableBody.addEventListener(
    'click',
    event => {
      const acknowledgeButton =
        event.target.closest(
          '[data-kitchen-action="acknowledge"]'
        );

      if (acknowledgeButton) {
        event.preventDefault();
        event.stopPropagation();
        void acknowledgeChanges(acknowledgeButton);
        return;
      }

      const viewButton =
        event.target.closest(
          'button[data-action="view"]'
        );

      if (!viewButton) return;

      const row =
        viewButton.closest('tr[data-order-id]');

      const orderId = Number(
        row?.dataset.orderId || 0
      );

      if (!orderId) return;

      setTimeout(
        () => appendKitchenDetail(orderId),
        0
      );
    }
  );

  const observer = new MutationObserver(
    mutations => {
      if (
        mutations.some(
          mutation => mutation.target === tableBody
        )
      ) {
        scheduleRefresh();
      }
    }
  );

  observer.observe(
    tableBody,
    {
      childList: true
    }
  );

  scheduleRefresh();
})();
