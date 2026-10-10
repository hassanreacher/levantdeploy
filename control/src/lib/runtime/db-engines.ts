import type { DatabaseEngine } from "@prisma/client";

/** Credentials stored encrypted in Database.credentialsEnc. */
export type DbCredentials = { user: string; password: string; database: string; rootPassword?: string };

export type EngineSpec = {
  label: string;
  image: string;
  defaultVersion: string;
  versions: string[];
  port: number;
  dataDir: string;
  env: (c: DbCredentials) => string[];
  cmd?: (c: DbCredentials) => string[];
  /** command that exits 0 when the server accepts connections */
  ready: (c: DbCredentials) => string[];
  url: (c: DbCredentials, host: string, port: number) => string;
  /** env var names injected into connected projects (first one = primary) */
  envNames: string[];
  backup: { ext: string; cmd: (c: DbCredentials) => string[]; gzip: boolean };
  /** restore reads the (decompressed unless gzip=false) dump on stdin */
  restore: { cmd: (c: DbCredentials) => string[]; gunzip: boolean };
};

const sh = (s: string) => ["sh", "-c", s];

export const ENGINES: Record<DatabaseEngine, EngineSpec> = {
  POSTGRES: {
    label: "PostgreSQL",
    image: "postgres",
    defaultVersion: "16-alpine",
    versions: ["17-alpine", "16-alpine", "15-alpine"],
    port: 5432,
    dataDir: "/var/lib/postgresql/data",
    env: (c) => [`POSTGRES_USER=${c.user}`, `POSTGRES_PASSWORD=${c.password}`, `POSTGRES_DB=${c.database}`],
    ready: (c) => ["pg_isready", "-U", c.user, "-d", c.database, "-h", "127.0.0.1"],
    url: (c, h, p) => `postgresql://${enc(c.user)}:${enc(c.password)}@${h}:${p}/${enc(c.database)}`,
    envNames: ["DATABASE_URL", "POSTGRES_URL"],
    backup: { ext: "sql.gz", gzip: true, cmd: (c) => ["pg_dump", "-U", c.user, "-d", c.database, "--clean", "--if-exists", "--no-owner"] },
    restore: { gunzip: true, cmd: (c) => ["psql", "-q", "-U", c.user, "-d", c.database, "-v", "ON_ERROR_STOP=0"] },
  },
  MYSQL: {
    label: "MySQL",
    image: "mysql",
    defaultVersion: "8.4",
    versions: ["8.4", "8.0"],
    port: 3306,
    dataDir: "/var/lib/mysql",
    env: (c) => [`MYSQL_ROOT_PASSWORD=${c.rootPassword ?? c.password}`, `MYSQL_USER=${c.user}`, `MYSQL_PASSWORD=${c.password}`, `MYSQL_DATABASE=${c.database}`],
    // the official image starts a temporary server on a socket first; require TCP to be up
    ready: (c) => sh(`mysqladmin ping -h 127.0.0.1 -P 3306 -u root -p"$MYSQL_ROOT_PASSWORD" --silent && mysql -h 127.0.0.1 -u ${c.user} -p"$MYSQL_PASSWORD" -e "SELECT 1" ${c.database} >/dev/null`),
    url: (c, h, p) => `mysql://${enc(c.user)}:${enc(c.password)}@${h}:${p}/${enc(c.database)}`,
    envNames: ["DATABASE_URL", "MYSQL_URL"],
    backup: { ext: "sql.gz", gzip: true, cmd: (c) => sh(`mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" --single-transaction --routines --triggers ${c.database} 2>/dev/null`) },
    restore: { gunzip: true, cmd: (c) => sh(`mysql -uroot -p"$MYSQL_ROOT_PASSWORD" ${c.database} 2>/dev/null`) },
  },
  REDIS: {
    label: "Redis",
    image: "redis",
    defaultVersion: "7-alpine",
    versions: ["7-alpine", "6-alpine"],
    port: 6379,
    dataDir: "/data",
    env: (c) => [`REDIS_PASSWORD=${c.password}`],
    cmd: (c) => ["redis-server", "--requirepass", c.password, "--save", "60", "1", "--appendonly", "no", "--dir", "/data"],
    ready: () => sh(`redis-cli -a "$REDIS_PASSWORD" --no-auth-warning ping | grep -q PONG`),
    url: (c, h, p) => `redis://default:${enc(c.password)}@${h}:${p}`,
    envNames: ["REDIS_URL"],
    backup: {
      ext: "rdb.gz",
      gzip: true,
      cmd: () => sh(`redis-cli -a "$REDIS_PASSWORD" --no-auth-warning --rdb /tmp/levant-backup.rdb >/dev/null 2>&1 && cat /tmp/levant-backup.rdb && rm -f /tmp/levant-backup.rdb`),
    },
    // RDB restore is done by stopping the server and replacing /data/dump.rdb (see databases.ts)
    restore: { gunzip: true, cmd: () => [] },
  },
  MONGO: {
    label: "MongoDB",
    image: "mongo",
    defaultVersion: "7",
    versions: ["8", "7", "6"],
    port: 27017,
    dataDir: "/data/db",
    env: (c) => [`MONGO_INITDB_ROOT_USERNAME=${c.user}`, `MONGO_INITDB_ROOT_PASSWORD=${c.password}`, `MONGO_INITDB_DATABASE=${c.database}`],
    ready: (c) => sh(`mongosh --quiet -u ${c.user} -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --eval "db.adminCommand('ping').ok" | grep -q 1`),
    url: (c, h, p) => `mongodb://${enc(c.user)}:${enc(c.password)}@${h}:${p}/${enc(c.database)}?authSource=admin`,
    envNames: ["MONGODB_URL", "MONGO_URL"],
    backup: { ext: "archive.gz", gzip: false, cmd: (c) => sh(`mongodump --quiet -u ${c.user} -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --archive --gzip`) },
    restore: { gunzip: false, cmd: (c) => sh(`mongorestore --quiet -u ${c.user} -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --archive --gzip --drop`) },
  },
};

function enc(s: string) {
  return encodeURIComponent(s);
}

/** Env var names for a database connected to a project. Extra databases of the same engine get `<NAME>_URL`. */
export function connectionEnvNames(engine: DatabaseEngine, name: string, isFirstOfEngine: boolean): string[] {
  const spec = ENGINES[engine];
  if (isFirstOfEngine) return spec.envNames;
  const prefix = name.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "DB";
  return [`${/^[0-9]/.test(prefix) ? `DB_${prefix}` : prefix}_URL`];
}
