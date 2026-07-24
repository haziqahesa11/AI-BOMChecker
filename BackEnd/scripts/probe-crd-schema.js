const { annonPool } = require('../DB');

async function main() {
  console.log('Tables:', (await annonPool.query(`
    SELECT table_schema, table_name FROM information_schema.tables
    WHERE table_name ILIKE 'crdbom%' OR table_name ILIKE '%revision_code%'
    ORDER BY table_schema, table_name`)).rows);

  console.log('Columns:', (await annonPool.query(`
    SELECT table_name, column_name, data_type, character_maximum_length, is_nullable
    FROM information_schema.columns WHERE table_schema = 'tracking'
    ORDER BY table_name, ordinal_position`)).rows);

  console.log('FKs:', (await annonPool.query(`
    SELECT conname, conrelid::regclass::text AS child, confrelid::regclass::text AS parent,
           pg_get_constraintdef(oid) AS def
    FROM pg_constraint WHERE connamespace = 'tracking'::regnamespace AND contype = 'f'`)).rows);

  // If empty, te_admin lacks write grants — an infra blocker, independent of
  // removing the app-level read-only session guard.
  console.log('te_admin write grants:', (await annonPool.query(`
    SELECT table_name, privilege_type FROM information_schema.role_table_grants
    WHERE grantee = 'te_admin' AND table_schema = 'tracking'
    AND privilege_type IN ('INSERT','UPDATE','DELETE')`)).rows);

  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
