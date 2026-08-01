const path = require('path');
const Database = require('better-sqlite3');

const dbFile = process.env.DB_FILE || 'database.db';
const dbPath = path.resolve(process.cwd(), dbFile);

const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

module.exports = db;
