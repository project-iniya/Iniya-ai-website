import express from 'express';
import jwt from 'jsonwebtoken';
import crypto from "crypto";
import axios from "axios";


export default function authRouter(redisClient, googleClient, astraDB) {
  const router = express.Router();
  const userCollection = astraDB.collection('users');

  // Step 1: Redirect to Google
  router.get("/google", (req, res) => {
    const redirect_uri = "https://iniyaai-backend.onrender.com/api/auth/google/callback";

    const url =
      "https://accounts.google.com/o/oauth2/v2/auth?" +
      `client_id=${process.env.GOOGLE_CLIENT_ID}` +
      `&redirect_uri=${redirect_uri}` +
      `&response_type=code` +
      `&scope=openid email profile`;

    res.redirect(url);
  });

  router.get("/github", (req, res) => {
  const redirect_uri = "https://iniyaai-backend.onrender.com/api/auth/github/callback";

  const url =
    "https://github.com/login/oauth/authorize?" +
    `client_id=${process.env.GITHUB_CLIENT_ID}` +
    `&redirect_uri=${redirect_uri}` +
    `&scope=user:email`;

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
          redirect_uri: "https://iniyaai-backend.onrender.com/api/auth/google/callback",
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
        provider: "google",
        providerId: payload.sub,
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

  router.get("/github/callback", async (req, res) => {
  const code = req.query.code;

  try {
    // 🔒 Rate limit (same as Google)
    const ipKey = `login_attempt:${req.ip}`;
    const attempts = await redisClient.incr(ipKey);

    if (attempts === 1) {
      await redisClient.expire(ipKey, 60);
    }

    if (attempts > 10) {
      return res.status(429).send("Too many login attempts");
    }

    // 🔑 Exchange code for access token
    const { data } = await axios.post(
      "https://github.com/login/oauth/access_token",
      {
        client_id: process.env.GITHUB_CLIENT_ID,
        client_secret: process.env.GITHUB_CLIENT_SECRET,
        code,
        redirect_uri: "https://iniyaai-backend.onrender.com/api/auth/github/callback",
      },
      {
        headers: {
          Accept: "application/json",
        },
      }
    );

    const accessToken = data.access_token;

    // 👤 Get user profile
    const userRes = await axios.get("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    const profile = userRes.data;

    // 📧 Get email (GitHub may not return it directly)
    const emailRes = await axios.get("https://api.github.com/user/emails", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    const primaryEmail = emailRes.data.find(e => e.primary)?.email;

    const user = {
      provider: "github",
      providerId: profile.id,
      email: primaryEmail,
      name: profile.name || profile.login,
    };

    // 🔐 Same temp code flow
    const tempCode = crypto.randomBytes(32).toString("hex");

    await redisClient.set(
      `auth_code:${tempCode}`,
      JSON.stringify(user),
      { EX: 60 }
    );

    res.redirect(`http://localhost:3001/?code=${tempCode}`);

  } catch (error) {
    console.error(error.response?.data || error.message);
    res.status(500).send("GitHub authentication failed");
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
      
      // Create JWT
      const token = jwt.sign(user, process.env.JWT_SECRET, {
        expiresIn: "28d",
      });

      let iat = jwt.decode(token).iat;

      let dbSearch = await userCollection.findOne({ email: user.email });

      if (!dbSearch) {
        await userCollection.insertOne({
          providers: {[user.provider] : user.providerId},
          email: user.email,
          name: user.name,
          createdAt: new Date(),
          tokenIssuedAt: iat,
          usage: {tavily: 0, elevenlabs: 0},
          $vector: await inferenceAPI(user.email)
        })
      } else {
        providers = dbSearch.providers || {};
        if (!providers[user.provider]) {
          providers[user.provider] = user.providerId;
        }
        await userCollection.updateOne(
          { _id: user._id},
          { $set: { lastModified: new Date(), tokenIssuedAt: iat, providers } }
        );
      }


      // ❌ Delete code (one-time use)
      await redisClient.del(`auth_code:${code}`);

      res.json({ token });
    } catch (error) {
      console.error(error);
      res.status(500).send("Server error");
    }
  });

  router.post("/verify-token", (req, res) => {
    const { token } = req.body;
    if (!token) {
      return res.status(400).json({ error: "Token is required" });
    }
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      user = userCollection.findOne({ email: decoded.email });
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }
      if (user.tokenIssuedAt > decoded.iat) {
        return res.status(401).json({ error: "Token has been invalidated. Please log in again.", logout: true });
      }
      res.json({ valid: true });
    } catch (error) {
      return res.status(401).json({ error: "Invalid or expired token" });
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