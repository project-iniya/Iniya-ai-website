import dotenv from "dotenv";
import { OAuth2Client } from "google-auth-library";
import { createClient } from 'redis';
import { DataAPIClient } from "@datastax/astra-db-ts";
import app from "./server.js";

dotenv.config();
const PORT = 5000;

try {
  const redisClient = createClient(
    {
      username: 'default',
      password: process.env.REDIS_PASSWORD,
      socket: {
        host: process.env.REDIS_HOST,
        port: process.env.REDIS_PORT
      }
    }
  );
  redisClient.on('error', (err) => console.log('Redis Client Error', err));
  await redisClient.connect();
  console.log('Connected to Redis');

  const astraDB = new DataAPIClient().db(
    process.env.ASTRA_DB_ENDPOINT, 
    { 
      token: process.env.ASTRA_DB_TOKEN 
    }
  );
  console.log('Astra DB Client initialized');

  const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
  console.log('Google OAuth2 Client initialized');

  const server = await app(redisClient, googleClient, astraDB);
  server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });

} catch (error) {
  console.error(error);
}