/**
 * Quick connectivity check for RDS Proxy.
 * Usage: node test-rds-proxy.js
 */
const { Client } = require("pg");
const { loadEnv } = require("./lib/env");

loadEnv();

function maskUrl(url) {
  try {
    const u = new URL(url);
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return "(invalid URL)";
  }
}

function buildConfig(connectionString) {
  const config = { connectionString, connectionTimeoutMillis: 15000 };
  const needsSsl =
    /sslmode=(require|verify-full|verify-ca)/i.test(connectionString) ||
    /\.rds\.amazonaws\.com/i.test(connectionString);
  if (needsSsl) {
    config.ssl = { rejectUnauthorized: false };
  }
  return config;
}

async function main() {
  const url = process.env.RDS_PROXY_URL;
  if (!url) {
    console.error("FAIL: RDS_PROXY_URL is not set in .env");
    process.exit(1);
  }

  console.log("Connecting via RDS Proxy…");
  console.log("URL:", maskUrl(url));

  const client = new Client(buildConfig(url));
  const started = Date.now();

  try {
    await client.connect();
    const { rows } = await client.query(`
      SELECT
        current_database() AS database,
        current_user AS user,
        inet_server_addr()::text AS server_addr,
        inet_server_port() AS server_port,
        version() AS version,
        NOW() AS now
    `);
    const info = rows[0];
    const ms = Date.now() - started;

    console.log("\nOK: connection successful");
    console.log(`  latency:     ${ms}ms`);
    console.log(`  database:    ${info.database}`);
    console.log(`  user:        ${info.user}`);
    console.log(`  server:      ${info.server_addr}:${info.server_port}`);
    console.log(`  server time: ${info.now}`);
    console.log(`  version:     ${info.version.split(",")[0]}`);
  } catch (err) {
    console.error("\nFAIL: could not connect");
    console.error(`  ${err.code || "ERROR"}: ${err.message}`);
    process.exitCode = 1;
  } finally {
    await client.end().catch(() => {});
  }
}

main();
