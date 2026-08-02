const publicSettingsClients = new Set();
const adminEventClients = new Set();

function sendSseEvent(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function broadcastToClients(clients, event, payload) {
  for (const client of clients) {
    try {
      sendSseEvent(client, event, payload);
    } catch {
      clients.delete(client);
    }
  }
}

function attachClient(clients, req, res, initialEvent = 'connected') {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders();
  }

  clients.add(res);
  sendSseEvent(res, initialEvent, { ok: true, ts: Date.now() });

  const keepAliveTimer = setInterval(() => {
    try {
      res.write(': keep-alive\n\n');
    } catch {
      clearInterval(keepAliveTimer);
      clients.delete(res);
    }
  }, 25000);

  req.on('close', () => {
    clearInterval(keepAliveTimer);
    clients.delete(res);
  });
}

function attachPublicSettingsClient(req, res) {
  attachClient(publicSettingsClients, req, res, 'connected');
}

function attachAdminEventClient(req, res) {
  attachClient(adminEventClients, req, res, 'connected');
}

function broadcastPublicSettingsEvent(event, payload) {
  broadcastToClients(publicSettingsClients, event, payload);
}

function broadcastAdminEvent(event, payload) {
  broadcastToClients(adminEventClients, event, payload);
}

module.exports = {
  attachAdminEventClient,
  attachPublicSettingsClient,
  broadcastAdminEvent,
  broadcastPublicSettingsEvent
};
