import express from 'express';
import jwt from 'jsonwebtoken';
import crypto from "crypto";
import axios from "axios";


export default function authRouter(redisClient, googleClient, astraDB) {
  const router = express.Router();
  const userCollection = astraDB.collection('users');

  // Step 1: Redirect to Google
  router.get("/google", (req, res) => {
    const redirect_uri = "http://localhost:5000/api/auth/google/callback";

    const url =
      "https://accounts.google.com/o/oauth2/v2/auth?" +
      `client_id=${process.env.GOOGLE_CLIENT_ID}` +
      `&redirect_uri=${redirect_uri}` +
      `&response_type=code` +
      `&scope=openid email profile`;

    res.redirect(url);
  });

  router.get("/google/callback", async (req, res) => {
    const code = req.query.code;

    try {
      const ipKey = `login_attempt:${req.ip}`;
      const attempts = await redisClient.incr(ipKey);

      if (attempts === 1) {
        await redisClient.expire(ipKey, 60); // 1 min window
      }

      if (attempts > 10) {
        return res.status(429).send("Too many login attempts");
      }

      const { data } = await axios.post(
        "https://oauth2.googleapis.com/token",
        {
          code,
          client_id: process.env.GOOGLE_CLIENT_ID,
          client_secret: process.env.GOOGLE_CLIENT_SECRET,
          redirect_uri: "http://localhost:5000/api/auth/google/callback",
          grant_type: "authorization_code",
        }
      );

      const { id_token } = data;

      // Verify ID token
      const ticket = await googleClient.verifyIdToken({
        idToken: id_token,
        audience: process.env.GOOGLE_CLIENT_ID,
      });

      const payload = ticket.getPayload();

      const user = {
        googleId: payload.sub,
        email: payload.email,
        name: payload.name,
      };

      const tempCode = crypto.randomBytes(32).toString("hex");

      await redisClient.set(
        `auth_code:${tempCode}`,
        JSON.stringify(user),
        { EX: 60 } // expires in 1 minute
      );

      res.redirect(`http://localhost:3001/?code=${tempCode}`);

    } catch (error) {
      console.error(error.response?.data || error.message);
      res.status(500).send("Authentication failed");
    }
  });

  router.post("/exchange-code", async (req, res) => {
    const { code } = req.body;
    try {
      const data = await redisClient.get(`auth_code:${code}`);

      if (!data) {
        return res.status(400).send("Invalid or expired code");
      }

      const user = JSON.parse(data);

      dbSearch = await userCollection.findOne({ googleId: user.googleId });

      if (!dbSearch) {
        await userCollection.insertOne({
          googleId: user.googleId,
          email: user.email,
          name: user.name,
          createdAt: new Date(),
          $vector: await inferenceAPI(user.name)
        })
      } else {
        await userCollection.updateOne(
          { googleId: user.googleId },
          { $set: { lastModified: new Date() } }
        );
      }
      

      // Create JWT
      const token = jwt.sign(user, process.env.JWT_SECRET, {
        expiresIn: "28d",
      });

      // ❌ Delete code (one-time use)
      await redisClient.del(`auth_code:${code}`);

      res.json({ token });
    } catch (error) {
      console.error(error);
      res.status(500).send("Server error");
    }
  });

  return router;
}

async function inferenceAPI(input) {
    const API_URL = "https://router.huggingface.co/hf-inference/models/intfloat/multilingual-e5-small/pipeline/feature-extraction";
    const HEADERS = {
        "Authorization": `Bearer ${process.env.HUGGINGFACE_API_KEY}`,
        "Content-Type": "application/json"
    };

    const body = JSON.stringify({ inputs: input });

    try {
        const res = await fetch(API_URL, {
            method: "POST",
            headers: HEADERS,
            body
        });

        if (!res.ok) {
            return {error: `API Error: ${res.statusText}`, status: res.status};;
        }

        const text = await res.text();
        const json = JSON.parse(text);
        return json;
    } catch (err) {
        return {error: err};
    }
}