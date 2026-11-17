require('dotenv').config();
const { MongoClient } = require('mongodb');
const { initDb } = require('./db');
const { createApp } = require('./app');

function configFromEnv() {
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT invalide.');
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) throw new Error('Renseignez MONGODB_URI dans le fichier .env.');
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret || jwtSecret.length < 32) throw new Error('Renseignez JWT_SECRET avec au moins 32 caractères.');
  const dbName = process.env.DB_NAME || 'my_social_networks';
  const publicBaseUrl = (process.env.PUBLIC_BASE_URL || 'http://localhost:' + port).replace(/\/+$/, '');
  const url = new URL(publicBaseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('PUBLIC_BASE_URL doit être une URL HTTP(S) sans identifiants, paramètres ni fragment.');
  }
  return { port, mongoUri, dbName, jwtSecret, publicBaseUrl };
}

async function main(config) {
  const client = new MongoClient(config.mongoUri, { serverSelectionTimeoutMS: 8000 });
  try {
    await client.connect();
    const hello = await client.db('admin').command({ hello: 1 });
    if (!hello.setName && hello.msg !== 'isdbgrid') {
      console.error('Un replica set MongoDB est requis pour les transactions. Consultez le README.');
      process.exitCode = 1;
      await client.close();
      return;
    }
    const db = client.db(config.dbName);
    await initDb(db);

    const server = createApp(client, db, config).listen(config.port);
    server.once('listening', () => console.log('API disponible sur http://localhost:' + config.port + '/api/v1'));
    server.once('error', async error => {
      console.error('Impossible de démarrer le serveur HTTP.', error.code || error.name);
      process.exitCode = 1;
      await client.close();
    });

    const shutdown = () => server.close(async () => client.close());
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  } catch (error) {
    await client.close();
    console.error('Connexion ou initialisation MongoDB impossible.', error.code || error.name);
    process.exitCode = 1;
  }
}

try {
  const config = configFromEnv();
  main(config);
} catch (error) {
  console.error(error instanceof TypeError ? 'PUBLIC_BASE_URL est invalide.' : error.message);
  process.exitCode = 1;
}
