import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import mysql from 'mysql2/promise';

const sm = new SecretsManagerClient({});

type SecretJson = { username?: string; password?: string };

export const handler = async (event: any) => {
  // Only handle Create/Update; Ignore Delete
  const reqType = event?.RequestType || 'Create';
  if (reqType === 'Delete') {
    // Must return the SAME PhysicalResourceId that was used on Create/Update
    // to satisfy CloudFormation's contract during Delete.
    const existingId = event?.PhysicalResourceId;
    const fallbackId = process.env.DB_HOST && process.env.DB_NAME ? `${process.env.DB_HOST}:${process.env.DB_NAME}` : 'db-init';
    return { PhysicalResourceId: existingId || fallbackId };
  }

  const { DB_HOST, DB_PORT, DB_NAME, MASTER_SECRET_ARN, APPUSER_SECRET_ARN, READONLY_SECRET_ARN } = process.env;
  if (!DB_HOST || !DB_PORT || !DB_NAME || !MASTER_SECRET_ARN || !APPUSER_SECRET_ARN || !READONLY_SECRET_ARN) {
    throw new Error('Missing required environment variables');
  }

  const master = await getSecretJson(MASTER_SECRET_ARN);
  const appuser = await getSecretJson(APPUSER_SECRET_ARN);
  const readonly = await getSecretJson(READONLY_SECRET_ARN);

  if (!master.username || !master.password) throw new Error('Master secret missing username/password');
  if (!appuser.username || !appuser.password) throw new Error('AppUser secret missing username/password');
  if (!readonly.username || !readonly.password) throw new Error('ReadOnlyUser secret missing username/password');

  const conn = await connectWithRetry({
    host: DB_HOST,
    port: Number(DB_PORT),
    user: master.username!,
    password: master.password!,
    database: DB_NAME,
  });
  try {
    await ensureUser(conn, appuser.username!, appuser.password!, DB_NAME, true);
    await ensureUser(conn, readonly.username!, readonly.password!, DB_NAME, false);
  } finally {
    await conn.end();
  }

  return { PhysicalResourceId: `${DB_HOST}:${DB_NAME}` };
};

async function getSecretJson(arn: string): Promise<SecretJson> {
  const res = await sm.send(new GetSecretValueCommand({ SecretId: arn }));
  const str = res.SecretString || Buffer.from(res.SecretBinary as any).toString('utf-8');
  return JSON.parse(str);
}

async function ensureUser(conn: mysql.Connection, user: string, pass: string, dbName: string, isApp: boolean) {
  // Create user if not exists; then set password and grant privileges
  await conn.query(`CREATE USER IF NOT EXISTS \`${user}\`@'%' IDENTIFIED BY ?`, [pass]);
  await conn.query(`ALTER USER \`${user}\`@'%' IDENTIFIED BY ?`, [pass]);
  if (isApp) {
    await conn.query(`GRANT ALL PRIVILEGES ON \`${dbName}\`.* TO \`${user}\`@'%'`);
    // Explicitly remove DROP privilege to prevent destructive operations
    await conn.query(`REVOKE DROP ON \`${dbName}\`.* FROM \`${user}\`@'%'`);
  } else {
    await conn.query(`GRANT SELECT ON \`${dbName}\`.* TO \`${user}\`@'%'`);
  }
  await conn.query('FLUSH PRIVILEGES');
}

async function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function connectWithRetry(opts: { host: string; port: number; user: string; password: string; database: string }) {
  const max = 12;
  let lastErr: any;
  for (let i = 0; i < max; i++) {
    try {
      const conn = await mysql.createConnection({
        host: opts.host,
        port: opts.port,
        user: opts.user,
        password: opts.password,
        database: opts.database,
        ssl: { rejectUnauthorized: false },
      });
      return conn;
    } catch (e) {
      lastErr = e;
      await wait(10000);
    }
  }
  throw lastErr;
}
