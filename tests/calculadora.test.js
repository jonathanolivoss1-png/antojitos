const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const express = require('express');
const session = require('express-session');

process.env.DB_FILE = path.join(os.tmpdir(), `antojitos-calculator-test-${Date.now()}.db`);

const initDatabase = require('../database/init');
const adminRoutes = require('../routes/admin');

function startApp() {
  const app = express();
  app.use(express.json());
  app.use(session({
    secret: 'test-secret',
    resave: false,
    saveUninitialized: false
  }));
  app.use((req, res, next) => {
    req.session.user = { usuario: 'admin' };
    next();
  });
  app.use('/api/admin', adminRoutes);

  return new Promise(resolve => {
    const server = app.listen(0, () => resolve(server));
  });
}

test('POST /api/admin/calculadora normalizes totals and saldo restante', async () => {
  initDatabase();

  const server = await startApp();
  const address = server.address();

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/admin/calculadora`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        origen: 'manual',
        tipoCantidad: 'bruta',
        cantidadDisponible: 200,
        productos: [
          { name: 'Taco', qty: 2, costUnit: 20, priceUnit: 50 }
        ]
      })
    });

    const data = await response.json();

    assert.equal(response.status, 201);
    assert.equal(data.calculo.costoTotal, 40);
    assert.equal(data.calculo.ventaTotal, 100);
    assert.equal(data.calculo.gananciaEstimada, 60);
    assert.equal(data.calculo.saldoRestante, 160);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('PUT/GET /api/admin/calculadora/draft persists calculator draft', async () => {
  initDatabase();

  const server = await startApp();
  const address = server.address();

  try {
    const updatedAt = Date.now();
    const putResponse = await fetch(`http://127.0.0.1:${address.port}/api/admin/calculadora/draft`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        draft: {
          products: [
            { id: 'a1', name: 'Tortilla', qty: 2, price: 15 }
          ],
          manualIncomeValue: 200,
          useDashboardRevenue: false,
          updatedAt
        }
      })
    });

    const putData = await putResponse.json();
    assert.equal(putResponse.status, 200);
    assert.equal(putData.ok, true);
    assert.equal(putData.draft.products.length, 1);
    assert.equal(putData.draft.manualIncomeValue, 200);
    assert.equal(putData.draft.useDashboardRevenue, false);
    assert.equal(putData.draft.updatedAt, updatedAt);

    const getResponse = await fetch(`http://127.0.0.1:${address.port}/api/admin/calculadora/draft`);
    const getData = await getResponse.json();

    assert.equal(getResponse.status, 200);
    assert.equal(getData.ok, true);
    assert.equal(getData.draft.products[0].name, 'Tortilla');
    assert.equal(getData.draft.manualIncomeValue, 200);
    assert.equal(getData.draft.useDashboardRevenue, false);
    assert.equal(getData.draft.updatedAt, updatedAt);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('PUT /api/admin/calculadora/draft ignores stale updatedAt payloads', async () => {
  initDatabase();

  const server = await startApp();
  const address = server.address();

  try {
    const baseTs = Date.now() + 10000;

    const newerResponse = await fetch(`http://127.0.0.1:${address.port}/api/admin/calculadora/draft`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        draft: {
          products: [{ id: 'newer', name: 'Pollo', qty: 1, price: 100 }],
          manualIncomeValue: 900,
          useDashboardRevenue: false,
          updatedAt: baseTs
        }
      })
    });

    assert.equal(newerResponse.status, 200);

    const staleResponse = await fetch(`http://127.0.0.1:${address.port}/api/admin/calculadora/draft`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        draft: {
          products: [{ id: 'stale', name: 'Arroz', qty: 9, price: 1 }],
          manualIncomeValue: 10,
          useDashboardRevenue: true,
          updatedAt: baseTs - 1
        }
      })
    });

    const staleData = await staleResponse.json();
    assert.equal(staleResponse.status, 200);
    assert.equal(staleData.ignoredStaleDraft, true);
    assert.equal(staleData.draft.products[0].name, 'Pollo');
    assert.equal(staleData.draft.updatedAt, baseTs);

    const getResponse = await fetch(`http://127.0.0.1:${address.port}/api/admin/calculadora/draft`);
    const getData = await getResponse.json();
    assert.equal(getResponse.status, 200);
    assert.equal(getData.draft.products[0].name, 'Pollo');
    assert.equal(getData.draft.manualIncomeValue, 900);
    assert.equal(getData.draft.updatedAt, baseTs);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('PUT /api/admin/calculadora/draft ignores accidental empty draft without override', async () => {
  initDatabase();

  const server = await startApp();
  const address = server.address();

  try {
    const firstTs = Date.now() + 1000000000;
    const secondTs = firstTs + 1;

    const seedResponse = await fetch(`http://127.0.0.1:${address.port}/api/admin/calculadora/draft`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        draft: {
          products: [{ id: 'seed', name: 'Frijol', qty: 2, price: 20 }],
          manualIncomeValue: 300,
          useDashboardRevenue: false,
          updatedAt: firstTs
        }
      })
    });

    assert.equal(seedResponse.status, 200);

    const emptyResponse = await fetch(`http://127.0.0.1:${address.port}/api/admin/calculadora/draft`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        draft: {
          products: [],
          manualIncomeValue: 0,
          useDashboardRevenue: false,
          updatedAt: secondTs
        }
      })
    });

    const emptyData = await emptyResponse.json();
    assert.equal(emptyResponse.status, 200);
    assert.equal(emptyData.ignoredEmptyDraft, true);
    assert.equal(emptyData.draft.products[0].name, 'Frijol');

    const getResponse = await fetch(`http://127.0.0.1:${address.port}/api/admin/calculadora/draft`);
    const getData = await getResponse.json();
    assert.equal(getResponse.status, 200);
    assert.equal(getData.draft.products[0].name, 'Frijol');
    assert.equal(getData.draft.updatedAt, firstTs);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
