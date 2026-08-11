import 'dotenv/config';
import { buildApp } from './app';
import { checkDatabaseConnection } from './db/database';

const start = async () => {
  try {
    const app = await buildApp();

    await checkDatabaseConnection();

    const port = parseInt(process.env.PORT || '8080');
    const host = '0.0.0.0';

    await app.listen({ port, host });
    
    console.log(`🚀 Server is running on http://localhost:${port}`);
    console.log(`📊 Health check: http://localhost:${port}/health`);
  } catch (err) {
    console.error('❌ Error starting server:', err);
    process.exit(1);
  }
};

start();

