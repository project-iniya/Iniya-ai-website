import express from "express";
import cors from "cors";
import { startUsageResetJob } from "./jobs/usageReset.js";
import { startUptimeKeeperJob } from "./jobs/uptimeKeeper.js";
import authRouter from "./routes/auth.router.js";
import apisRouter from "./routes/apis.router.js";
import connectRouter from "./routes/connect.js";
import cookieParser from "cookie-parser";


export default async function app(redisClient, googleClient, astraDB) {
  const app = express();

  app.use(cookieParser());
  app.use(cors());
  app.use(express.json());

  app.use("/api/auth",authRouter(redisClient, googleClient, astraDB));
  app.use("/api/apis", apisRouter(astraDB));
  app.use("/api/connect", connectRouter(redisClient))
  app.use("/health", (req, res) => {
    res.status(200).json({ status: "ok" });
  });

  startUsageResetJob(astraDB);
  startUptimeKeeperJob();

  return app;
}
