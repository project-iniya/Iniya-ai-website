import express from "express";
import cors from "cors";
import authRouter from "./routes/auth.router.js";
import cookieParser from "cookie-parser";


export default async function app(redisClient, googleClient, astraDB) {
  const app = express();

  app.use(cookieParser());
  app.use(cors());
  app.use(express.json());

  app.use("/api/auth",authRouter(redisClient, googleClient, astraDB));

  return app;
}
