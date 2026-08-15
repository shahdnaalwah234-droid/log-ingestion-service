import Fastify from 'fastify';
import cors from '@fastify/cors';
import { pool } from './db/database';

const ALLOWED_LEVELS = ['debug', 'info', 'warn', 'error'];
const ALLOWED_GROUP_BY = ['service', 'level'];

const AUTH_ENABLED = process.env.AUTH_ENABLED === 'true';
const API_KEY = process.env.LOADGEN_API_KEY || '';

function parseBucket(raw: string | undefined): number | null {
  const match = /^(\d+)(s|m|h)$/.exec(raw ?? '1m');
  if (!match) return null;
  const unitSeconds: Record<string, number> = { s: 1, m: 60, h: 3600 };
  const seconds = parseInt(match[1], 10) * unitSeconds[match[2]];
  return seconds > 0 ? seconds : null;
}

function encodeCursor(ts: Date, id: string): string {
  return Buffer.from(JSON.stringify({ ts: ts.toISOString(), id })).toString('base64');
}

function decodeCursor(raw: string): { ts: Date; id: string } | null {
  try {
    const decoded = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
    if (typeof decoded.ts !== 'string' || typeof decoded.id !== 'string') return null;
    const ts = new Date(decoded.ts);
    if (Number.isNaN(ts.getTime())) return null;
    return { ts, id: decoded.id };
  } catch {
    return null;
  }
}

export async function buildApp() {
  const app = Fastify({
    logger: true,
  });

  await app.register(cors);

  // ---------- auth ----------
  app.addHook('onRequest', async (request, reply) => {
    if (!AUTH_ENABLED) return;
    if (request.url === '/health' || request.url.startsWith('/health?')) return;

    const header = request.headers['authorization'];
    if (!header || header !== `Bearer ${API_KEY}`) {
      reply.code(401).send({ error: 'unauthorized' });
    }
  });

  // ---------- health ----------
  app.get('/health', async () => {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
    };
  });

  // Root endpoint
  app.get('/', async () => {
    return {
      message: 'Log Ingestion Service is running!',
    };
  });

  // ---------- ingest (batch) ----------
  app.post('/logs', async (request, reply) => {
    const body = request.body as { logs?: unknown };

    if (!body || !Array.isArray(body.logs)) {
      return reply.code(400).send({ error: 'logs must be an array' });
    }
    if (body.logs.length === 0) {
      return reply.code(400).send({ error: 'logs array must not be empty' });
    }

    const valid: { timestamp: string; level: string; service: string; message: string; attributes: unknown }[] = [];
    const rejected: { index: number; reason: string }[] = [];

    body.logs.forEach((entry, index) => {
      if (!entry || typeof entry !== 'object') {
        rejected.push({ index, reason: 'log entry must be an object' });
        return;
      }
      const { timestamp, level, service, message, attributes } = entry as Record<string, unknown>;

      if (!timestamp || !level || !service || !message) {
        rejected.push({ index, reason: 'timestamp, level, service, and message are required' });
        return;
      }
      if (typeof level !== 'string' || !ALLOWED_LEVELS.includes(level)) {
        rejected.push({ index, reason: `level must be one of ${ALLOWED_LEVELS.join(', ')}` });
        return;
      }
      const parsedTs = new Date(timestamp as string);
      if (Number.isNaN(parsedTs.getTime())) {
        rejected.push({ index, reason: 'timestamp must be a valid ISO 8601 date' });
        return;
      }

      valid.push({
        timestamp: timestamp as string,
        level,
        service: service as string,
        message: message as string,
        attributes: attributes && typeof attributes === 'object' ? attributes : {},
      });
    });

    if (valid.length > 0) {
      const values: unknown[] = [];
      const placeholders: string[] = [];
      valid.forEach((row, i) => {
        const base = i * 5;
        placeholders.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`);
        values.push(row.timestamp, row.level, row.service, row.message, row.attributes);
      });

      await pool.query(
        `INSERT INTO logs (timestamp, level, service, message, attributes)
         VALUES ${placeholders.join(', ')}`,
        values
      );
    }

    return reply.code(200).send({ accepted: valid.length, rejected });
  });

  // ---------- query logs ----------
  app.get('/logs', async (request, reply) => {
    const query = request.query as Record<string, string>;
    const limit = Math.min(Math.max(parseInt(query.limit || '50', 10) || 50, 1), 500);

    const conditions: string[] = [];
    const values: unknown[] = [];

    if (query.since) {
      const since = new Date(query.since);
      if (Number.isNaN(since.getTime())) {
        return reply.code(400).send({ error: 'since must be a valid ISO 8601 date' });
      }
      values.push(since);
      conditions.push(`timestamp >= $${values.length}`);
    }

    if (query.until) {
      const until = new Date(query.until);
      if (Number.isNaN(until.getTime())) {
        return reply.code(400).send({ error: 'until must be a valid ISO 8601 date' });
      }
      values.push(until);
      conditions.push(`timestamp <= $${values.length}`);
    }

    if (query.level) {
      values.push(query.level);
      conditions.push(`level = $${values.length}`);
    }

    if (query.service) {
      values.push(query.service);
      conditions.push(`service = $${values.length}`);
    }

    if (query.q) {
      values.push(`%${query.q}%`);
      conditions.push(`message ILIKE $${values.length}`);
    }

    for (const [key, value] of Object.entries(query)) {
      if (key.startsWith('attr.') && key.length > 5) {
        const attrKey = key.slice(5);
        values.push(attrKey);
        const keyPos = values.length;
        values.push(value);
        conditions.push(`attributes ->> $${keyPos} = $${values.length}`);
      }
    }

    if (query.cursor) {
      const decoded = decodeCursor(query.cursor);
      if (!decoded) {
        return reply.code(400).send({ error: 'cursor is invalid' });
      }
      values.push(decoded.ts);
      const tsPos = values.length;
      values.push(decoded.id);
      const idPos = values.length;
      conditions.push(`(timestamp < $${tsPos} OR (timestamp = $${tsPos} AND id < $${idPos}))`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    values.push(limit);
    const limitPos = values.length;

    const result = await pool.query(
      `SELECT * FROM logs ${whereClause} ORDER BY timestamp DESC, id DESC LIMIT $${limitPos}`,
      values
    );

    let next_cursor: string | null = null;
    if (result.rows.length === limit) {
      const last = result.rows[result.rows.length - 1];
      next_cursor = encodeCursor(new Date(last.timestamp), last.id);
    }

    return {
      logs: result.rows,
      next_cursor,
    };
  });

  // ---------- aggregate ----------
  app.get('/logs/aggregate', async (request, reply) => {
    const query = request.query as Record<string, string>;

    if (!query.since || !query.until) {
      return reply.code(400).send({ error: 'since and until are required' });
    }

    const since = new Date(query.since);
    const until = new Date(query.until);
    if (Number.isNaN(since.getTime()) || Number.isNaN(until.getTime())) {
      return reply.code(400).send({ error: 'since and until must be valid ISO 8601 dates' });
    }

    const bucketSeconds = parseBucket(query.bucket);
    if (bucketSeconds === null) {
      return reply.code(400).send({ error: 'bucket must look like 30s, 1m, or 1h' });
    }

    let groupBy: string | null = null;
    if (query.group_by) {
      if (!ALLOWED_GROUP_BY.includes(query.group_by)) {
        return reply.code(400).send({ error: `group_by must be one of ${ALLOWED_GROUP_BY.join(', ')}` });
      }
      groupBy = query.group_by;
    }

    const groupSelect = groupBy ? `, ${groupBy} AS grp` : '';
    const groupClause = groupBy ? `, ${groupBy}` : '';

    const result = await pool.query(
      `SELECT to_timestamp(floor(extract(epoch FROM timestamp) / $3) * $3) AS bucket_start,
              COUNT(*)::int AS count
              ${groupSelect}
       FROM logs
       WHERE timestamp >= $1 AND timestamp <= $2
       GROUP BY bucket_start ${groupClause}
       ORDER BY bucket_start ASC`,
      [since, until, bucketSeconds]
    );

    const buckets = result.rows.map((row) => ({
      start: new Date(row.bucket_start).toISOString(),
      count: row.count,
      group: groupBy ? row.grp : null,
    }));

    return { buckets };
  });

  // ---------- stats (kept from original) ----------
  app.get('/logs/stats', async () => {
    const totalResult = await pool.query(`SELECT COUNT(*)::int AS total FROM logs`);

    const levelResult = await pool.query(
      `SELECT level, COUNT(*)::int AS count FROM logs GROUP BY level ORDER BY level`
    );

    const serviceResult = await pool.query(
      `SELECT service, COUNT(*)::int AS count FROM logs GROUP BY service ORDER BY service`
    );

    const byLevel: Record<string, number> = {};
    for (const row of levelResult.rows) byLevel[row.level] = row.count;

    const byService: Record<string, number> = {};
    for (const row of serviceResult.rows) byService[row.service] = row.count;

    return {
      total: totalResult.rows[0].total,
      byLevel,
      byService,
    };
  });

  // ---------- error handler ----------
  app.setErrorHandler((error, request, reply) => {
    request.log.error(error);

    const err = error as Error & { code?: string; statusCode?: number };

    if (err.code === '22007') {
      return reply.code(400).send({ error: 'Invalid date or timestamp format' });
    }

    if (typeof err.statusCode === 'number' && err.statusCode < 500) {
      return reply.code(err.statusCode).send({ error: err.message || 'Bad request' });
    }

    return reply.code(500).send({ error: 'Internal server error' });
  });

  return app;
}
