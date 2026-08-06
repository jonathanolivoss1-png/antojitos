const fs = require('fs');
const { spawnSync } = require('child_process');

const files = [
  'server.js',
  'routes/auth.js',
  'routes/pedidos.js',
  'routes/admin.js',
  'database/init.js',
  'public/admin/admin.js',
  'public/admin/catalog-admin.js',
  'routes/proteccion-negocio.js',
  'public/admin/proteccion-negocio.js',
].filter(file => fs.existsSync(file));

let failed = false;

for (const file of files) {
  const result = spawnSync(
    process.execPath,
    ['--check', file],
    { encoding: 'utf8' }
  );

  if (result.status !== 0) {
    failed = true;
    console.error(`\n✗ ${file}`);
    console.error(result.stderr || result.stdout);
  } else {
    console.log(`✓ ${file}`);
  }
}

if (failed) {
  process.exit(1);
}

console.log('\nPruebas básicas de sintaxis completadas.');
