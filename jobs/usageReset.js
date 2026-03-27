import cron from "node-cron";

export function startUsageResetJob(userCollection) {
  // Runs at 00:00 on 1st of every month
  DEFAULT_USAGE_VALUE = {tavily: 0, elevenlabs: 0};
  cron.schedule("0 0 1 * *", async () => {
    console.log("🔄 Resetting usage for all users...");

    try {
      const res = await userCollection.updateMany(
        { 
          usage: { 
            $ne: DEFAULT_USAGE_VALUE 
          }
        },
        {
          $set: {
            usage: DEFAULT_USAGE_VALUE, // define this
          },
        }
      );
      console.log(`✅ Reset usage for ${res.modifiedCount} users`);
      console.log(`✅ Matched ${res.matchedCount} users in total`);
      console.log("✅ Usage reset complete");
    } catch (err) {
      console.error("❌ Usage reset failed:", err);
    }
  },{
    timezone: "Asia/Kolkata"
  });
}