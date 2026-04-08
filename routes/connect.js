import express from 'express';
import crypto  from 'crypto';
import QRCode  from 'qrcode';
import dotenv from 'dotenv';

dotenv.config();

export default function connectRouter(redisClient) {
  const router = express.Router();

  router.post("/create", async (req, res) => {
    try{
      const sessionId = crypto.randomUUID();
      const hexCode    = crypto.randomBytes(8).toString('hex');
      const sessionConnectLink = `${process.env.FRONTEND_URL}/connect?code=${hexCode}&connect=false`;

      await redisClient.set(`session:${sessionId}`, JSON.stringify({ sessionId, hexCode }), { EX: 600 });
      await redisClient.set(`hex:${hexCode}`, sessionId, { EX: 600 });

      res.json({ sessionId, sessionConnectLink });
    } catch (error) {
      console.error("Error creating connect session:", error);
      res.status(500).json({ error: "Failed to create connect session" });
    }
  });

  router.get("/qr", async (req, res) => {
    const { code } = req.query;
    if (!code) return res.status(400).json({ error: "Missing 'code' query parameter" });

    try {
      const connectLink = `${process.env.FRONTEND_URL}/connect?code=${code}&connect=true`
      const qrBase64 = await QRCode.toDataURL(connectLink, {
        width: 400,
        margin: 2,
        errorCorrectionLevel: 'H'
      });
      res.json({ qrBase64, connectLink });
    } catch (error) {
      console.error("Error generating QR code:", error);
      res.status(500).json({ error: "Failed to generate QR code" });
    }
  });

  router.post("/exchange", async (req, res) => {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: "Missing 'code' in request body" });

    try {
      const sessionId = await redisClient.get(`hex:${code}`);
      if (!sessionId) return res.status(404).json({ error: "Invalid or expired code" });

      // Optionally, you can delete the session after exchange to prevent reuse
      await redisClient.del(`hex:${code}`);
      await redisClient.del(`session:${sessionId}`);

      res.json({ sessionId });
    } catch (error) {
      console.error("Error exchanging code:", error);
      res.status(500).json({ error: "Failed to exchange code" });
    }
  });

  return router;
}