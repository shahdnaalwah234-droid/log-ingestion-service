import Fastify from 'fastify';
import cors from '@fastify/cors';
import { pool } from './db/database';

export async function buildApp() {
  const app = Fastify({
    logger: true,
  });

  await app.register(cors);

  // Health check
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

  // Create a new log
  app.post('/logs', async (request, reply) => {
    const body = request.body as {
      timestamp: string;
      level: string;
      service: string;
      message: string;
      attributes?: Record<string, unknown>;
    };

    const {
      timestamp,
      level,
      service,
      message,
      attributes = {},
    } = body;
    const allowedLevels = ['DEBUG', 'INFO', 'WARN', 'ERROR'];

if (!allowedLevels.includes(level)) {
  return reply.code(400).send({
    error: 'level must be one of DEBUG, INFO, WARN, ERROR',
  });
}

    if (!timestamp || !level || !service || !message) {
      return reply.code(400).send({
        error: 'timestamp, level, service, and message are required',
      });
    }
    const parsedTimestamp = new Date(timestamp);

if (Number.isNaN(parsedTimestamp.getTime())) {
  return reply.code(400).send({
    error: 'timestamp must be a valid ISO 8601 date',
  });
}

    const result = await pool.query(
      `INSERT INTO logs
        (timestamp, level, service, message, attributes)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [timestamp, level, service, message, attributes]
    );

    return reply.code(201).send(result.rows[0]);
  });

  // Get logs with filtering and pagination
  app.get('/logs', async (request, reply) => {
 const query = request.query as {
  level?: string;
  service?: string;
  search?: string;
  from?: string;
  to?: string;
  limit?: string;
  offset?: string;
};

    const {
      level,
      service,
      limit: limitParam,
      offset: offsetParam,
    } = query;

    const limit = Math.min(
      Math.max(parseInt(limitParam || '50', 10) || 50, 1),
      100
    );

    const offset = Math.max(
      parseInt(offsetParam || '0', 10) || 0,
      0
    );

    const conditions: string[] = [];
    const values: unknown[] = [];
    if (query.search) {
      values.push(`%${query.search}%`);
      conditions.push(`message ILIKE $${values.length}`);
}
if (query.from) {
  const fromDate = new Date(query.from);

  if (Number.isNaN(fromDate.getTime())) {
    return reply.code(400).send({
      error: 'from must be a valid ISO 8601 date',
    });
  }

  values.push(fromDate);
  conditions.push(`timestamp >= $${values.length}`);
}

if (query.to) {
  const toDate = new Date(query.to);

  if (Number.isNaN(toDate.getTime())) {
    return reply.code(400).send({
      error: 'to must be a valid ISO 8601 date',
    });
  }

  values.push(toDate);
  conditions.push(`timestamp <= $${values.length}`);
}
    if (level) {
      values.push(level);
      conditions.push(`level = $${values.length}`);
    }

    if (service) {
      values.push(service);
      conditions.push(`service = $${values.length}`);
    }

    const whereClause =
      conditions.length > 0
        ? `WHERE ${conditions.join(' AND ')}`
        : '';

    values.push(limit);
    const limitPosition = values.length;

    values.push(offset);
    const offsetPosition = values.length;

    const result = await pool.query(
      `SELECT *
       FROM logs
       ${whereClause}
       ORDER BY timestamp DESC, id DESC
       LIMIT $${limitPosition}
       OFFSET $${offsetPosition}`,
      values
    );

    return {
      logs: result.rows,
      count: result.rows.length,
      limit,
      offset,
    };
  });
  // Get log statistics
app.get('/logs/stats', async () => {
  const totalResult = await pool.query(
    `SELECT COUNT(*)::int AS total FROM logs`
  );

  const levelResult = await pool.query(
    `SELECT level, COUNT(*)::int AS count
     FROM logs
     GROUP BY level
     ORDER BY level`
  );

  const serviceResult = await pool.query(
    `SELECT service, COUNT(*)::int AS count
     FROM logs
     GROUP BY service
     ORDER BY service`
  );

  const byLevel: Record<string, number> = {};
  for (const row of levelResult.rows) {
    byLevel[row.level] = row.count;
  }

  const byService: Record<string, number> = {};
  for (const row of serviceResult.rows) {
    byService[row.service] = row.count;
  }

  return {
    total: totalResult.rows[0].total,
    byLevel,
    byService,
  };
});
  // Global error handler
  app.setErrorHandler((error, request, reply) => {
    request.log.error(error);

 app.setErrorHandler((error, request, reply) => {
  request.log.error(error);

  const dbError = error as Error & { code?: string };

  if (dbError.code === '22007') {
    return reply.code(400).send({
      error: 'Invalid date or timestamp format',
    });
  }

  return reply.code(500).send({
    error: 'Internal server error',
  });
});

    return reply.code(500).send({
      error: 'Internal server error',
    });
  });
  return app;
}