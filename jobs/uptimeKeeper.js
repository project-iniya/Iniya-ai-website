import cron from "node-cron";

export function startUptimeKeeperJob() {
  // Runs every 14 minutes
  cron.schedule("*/14 * * * *", async () => {
    console.log("⏱️  Uptime Keeper: Sending keep-alive ping...");
    try {
      const response = await fetch("https://iniyaai-backend.onrender.com/health", {
        method: "GET",
      });
      if (!response.ok) {
        console.error(`❌ Uptime Keeper: Ping failed with status ${response.status}`);
      }
    } catch (error) {
      console.error("❌ Uptime Keeper: Ping failed with error", error);
    }
  },{
    timezone: "Asia/Kolkata"
  });
}