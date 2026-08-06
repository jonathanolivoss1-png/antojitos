// FIX_KITCHEN_BADGE_VERTICAL_DRIFT_V2
'use strict';

(function () {
  const tableBody =
    document.getElementById(
      'adminOrdersTableBody'
    );

  if (!tableBody) {
    return;
  }

  let timer = null;
  let loading = false;

  function stateClass(value) {
    if (value === 'Preparando') {
      return 'preparing';
    }

    if (value === 'Listo') {
      return 'ready';
    }

    return 'pending';
  }

  function visibleRows() {
    return Array.from(
      tableBody.querySelectorAll(
        'tr[data-order-id]'
      )
    );
  }

  function generalStatus(row) {
    return String(
      row
        .querySelector('.status-chip')
        ?.textContent ||
      row.dataset.orderStatus ||
      ''
    )
      .trim()
      .toLowerCase();
  }

  function statusCellForRow(row) {
    return (
      row
        .querySelector('.status-chip')
        ?.parentElement ||
      row.cells?.[7] ||
      row.cells?.[row.cells.length - 2] ||
      null
    );
  }

  function removeChip(row) {
    const statusCell =
      statusCellForRow(row);

    if (!statusCell) return;

    statusCell
      .querySelectorAll(
        '.kitchen-preparation-slot, '
        + '.kitchen-preparation-chip, '
        + 'br[data-kitchen-preparation-break]'
      )
      .forEach(element => {
        element.remove();
      });

    const statusChip =
      row.querySelector('.status-chip');

    if (!statusChip) return;

    let sibling =
      statusChip.nextSibling;

    while (sibling) {
      const next =
        sibling.nextSibling;

      if (
        sibling.nodeType ===
          Node.TEXT_NODE &&
        !String(sibling.textContent || '').trim()
      ) {
        sibling.remove();
        sibling = next;
        continue;
      }

      if (
        sibling.nodeType ===
          Node.ELEMENT_NODE &&
        sibling.tagName === 'BR'
      ) {
        sibling.remove();
        sibling = next;
        continue;
      }

      break;
    }
  }

  function applyState(row, state) {
    removeChip(row);

    if (
      generalStatus(row) !==
      'confirmado'
    ) {
      return;
    }

    const statusCell =
      statusCellForRow(row);

    if (!statusCell) return;

    const slot =
      document.createElement('div');

    slot.className =
      'kitchen-preparation-slot';

    const chip =
      document.createElement('span');

    chip.className =
      `kitchen-preparation-chip `
      + stateClass(state);

    chip.textContent =
      `Cocina: ${state}`;

    slot.appendChild(chip);
    statusCell.appendChild(slot);
  }

  async function refresh() {
    if (loading) return;

    const rows =
      visibleRows();

    const ids =
      rows
        .filter(row =>
          generalStatus(row) ===
          'confirmado'
        )
        .map(row =>
          Number(row.dataset.orderId || 0)
        )
        .filter(id =>
          Number.isInteger(id) &&
          id > 0
        );

    rows
      .filter(row =>
        generalStatus(row) !==
        'confirmado'
      )
      .forEach(removeChip);

    if (!ids.length) {
      return;
    }

    loading = true;

    try {
      const response = await fetch(
        `/api/cocina/admin/preparation?ids=${ids.join(',')}`,
        {
          credentials: 'same-origin'
        }
      );

      const data =
        await response.json()
          .catch(() => null);

      if (!response.ok) {
        return;
      }

      const states =
        new Map(
          (data?.estados || [])
            .map(item => [
              Number(item.pedidoId),
              item.preparacion ||
                'Pendiente'
            ])
        );

      rows.forEach(row => {
        const id =
          Number(
            row.dataset.orderId || 0
          );

        if (
          generalStatus(row) ===
          'confirmado'
        ) {
          applyState(
            row,
            states.get(id) ||
            'Pendiente'
          );
        }
      });
    } finally {
      loading = false;
    }
  }

  function schedule() {
    clearTimeout(timer);

    timer = setTimeout(
      () => {
        void refresh();
      },
      150
    );
  }

  const observer =
    new MutationObserver(schedule);

  observer.observe(
    tableBody,
    {
      childList: true,
      subtree: true
    }
  );

  window.addEventListener(
    'admin-orders-updated',
    schedule
  );

  window.setInterval(
    () => {
      void refresh();
    },
    5000
  );

  schedule();
})();
