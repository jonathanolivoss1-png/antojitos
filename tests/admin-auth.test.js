const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const bcrypt = require('bcryptjs');

process.env.DB_FILE = path.join(os.tmpdir(), `antojitos-test-${Date.now()}.db`);
process.env.ADMIN_PASSWORD = 'TestPass123!';

const initDatabase = require('../database/init');
const db = require('../database/db');

test('initDatabase uses the configured admin password', () => {
  initDatabase();

  const row = db.prepare('SELECT password FROM usuarios WHERE usuario = ?').get('admin');
  assert.ok(row, 'The admin user should exist');
  assert.equal(bcrypt.compareSync('TestPass123!', row.password), true);
  assert.equal(bcrypt.compareSync('123456', row.password), false);
});
