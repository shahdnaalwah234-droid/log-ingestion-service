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

    if (!timestamp || !level || !service || !message) {
      return reply.code(400).send({
        error: 'timestamp, level, service, and message are required',
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

  // Get all logs
  app.get('/logs', async () => {
    const result = await pool.query(
      `SELECT *
       FROM logs
       ORDER BY timestamp DESC, id DESC`
    );

    return {
      logs: result.rows,
      count: result.rows.length,
    };
  });

  return app;
}
