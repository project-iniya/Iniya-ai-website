import express from 'express';
import jwt from 'jsonwebtoken';
import crypto from "crypto";
import axios from "axios";
import nodemailer from "nodemailer";


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
    if (!code) return res.status(400).send("No code provided");

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
      const devid = crypto.randomBytes(32).toString("hex");

      let dbSearch = await userCollection.findOne({ email: user.email });

      if (!dbSearch) {
        await userCollection.insertOne({
          providers: {[user.provider] : user.providerId},
          email: user.email,
          name: user.name,
          createdAt: new Date(),
          logoutAt: null,
          tokenIssuedAt: iat,
          devid,
          usage: {tavily: 0, elevenlabs_tts: 0, hf_stt: 0},
          $vectorize: user.email,
          markforDeletion: false,
          deletionReason: null,
          deletionRequestedAt: null,
        })

        const email = sendEmail(
          user.email,
          "Welcome to IniyaAI!",
          "",
          `
            <table width="100%" cellpadding="0" cellspacing="0" style="font-family: Arial, sans-serif; padding: 20px;">
              <tr>
                <td align="center">
                  <table width="500" cellpadding="0" cellspacing="0">
                    <tr>
                      <td align="center">
                        <h1 style="color: #333; margin-bottom: 10px;">
                          WELCOME ABOARD ${user.name},
                        </h1>
                      </td>
                    </tr>
                    <tr>
                      <td>
                        <p style="font-size: 16px; color: #555;">
                          Welcome to <b>IniyaAI</b>! We're excited to have you on board.
                          If you have any questions or need assistance, feel free to reach out.
                        </p>
                      </td>
                    </tr>
                    <tr>
                      <td>
                        <p style="font-size: 16px; color: #555;">
                          Best regards,<br>
                          Team Iniya
                        </p>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>
            </table>
          `
        );
        
        if (email) {
          console.log(`Welcome email sent to ${user.email}`);
        } else {
          console.error(`Failed to send welcome email to ${user.email}`);
        }

      } else {
        
        const email = sendEmail(
          user.email,
          "Welcome back to IniyaAI!",
          "",
          `
            <table width="100%" cellpadding="0" cellspacing="0" style="font-family: Arial, sans-serif; padding: 20px;">
            <tr>
              <td align="center">
                <table width="500" cellpadding="0" cellspacing="0">
                  
                  <tr>
                    <td align="center">
                      <h1 style="color: #333; margin-bottom: 10px;">
                        WELCOME BACK ${user.name},
                      </h1>
                    </td>
                  </tr>

                  <tr>
                    <td align="center" style="background-color: #f9f9f9; padding: 30px; border-radius: 6px;">
                      <p style="font-size: 16px; color: #555; margin: 0;">
                        New Login Detected.
                      </p>
                      <p style="font-size: 16px; color: #555; margin-top: 10px;">
                        If it was not you, please reach out to us.
                      </p>
                    </td>
                  </tr>

                  <tr>
                    <td>
                      <p style="font-size: 16px; color: #555; margin-top: 20px;">
                        Best regards,<br>
                        Team Iniya
                      </p>
                    </td>
                  </tr>

                </table>
              </td>
            </tr>
          </table>
        `
        );

        if(email) {
          console.log(`Login alert email sent to ${user.email}`);
        }
        else {
          console.error(`Failed to send login alert email to ${user.email}`);
        }

        let providers = dbSearch.providers || {};
        if (!providers[user.provider]) {
          providers[user.provider] = user.providerId;
        }
        await userCollection.updateOne(
          { _id: user._id},
          { $set: { lastModified: new Date(), tokenIssuedAt: iat, providers, devid, logoutAt: null, markforDeletion: false, deletionReason: null, deletionRequestedAt: null,} }
        );
      }


      // ❌ Delete code (one-time use)
      await redisClient.del(`auth_code:${code}`);

      res.json({ token, devid });
    } catch (error) {
      console.error(error);
      res.status(500).send("Server error");
    }
  });

  router.post("/verify-token", async (req, res) => {
    const { token, devid } = req.body;
    if (!token) {
      return res.status(400).json({ error: "Token is required", valid: false });
    }
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const user = await userCollection.findOne({ email: decoded.email });
      if (!user) {
        return res.status(404).json({ error: "User not found", valid: false });
      }
      if (user.tokenIssuedAt > decoded.iat) {
        return res.status(401).json({ error: "Token has been invalidated. Please log in again.", valid: false});
      }
      if (user.devid !== devid){
        return res.status(401).json({ error: "Device Id doesnt match. Please log in again.", valid: false});
      }
      res.json({ valid: true });
    } catch (error) {
      return res.status(401).json({ error: "Invalid or expired token", error, valid:false });
    }
  });

  router.post("/logout", async (req, res) => {
    const token = req.headers.authorization?.split(" ")[1];
    const { devid } = req.body;
    if (!token) {
      return res.status(400).json({ error: "Token is required", success: false });
    }
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      user = await userCollection.findOne({ email: decoded.email });
      if (!user) {
        return res.status(404).json({ error: "User not found", success: false });
      }
      if (user.tokenIssuedAt > decoded.iat) {
        return res.status(401).json({ error: "Token has been invalidated. Please log in again.", success: false });
      }
      if (user.devid !== devid){
        return res.status(401).json({ error: "Device Id doesnt match. Please log in again.", success: false });
      }

      await userCollection.updateOne(
        {email: decoded.email},
        { $set: { tokenIssuedAt: null, devid: null, logoutAt: new Date() } }
      );
      return res.status(200).json({success: true})
    
    } catch (error) {
      return res.status(401).json({ error: "Invalid or expired token", errorMsg: error });
    }
  });

  router.post("/delete-account", async (req, res) => {
    const {name, email, reason} = req.body;
    
    if (!name || !email) {
      return res.status(400).json({ error: "Name and email are required", success: false });
    }

    let user = await userCollection.findOne({ email });

    if (!user) {
      return res.status(404).json({ error: "User not found", success: false });
    }

    if (user.name !== name) {
      return res.status(400).json({ error: "Name does not match our records", success: false });
    }

    if (user.markforDeletion) {
      return res.status(400).json({ error: "Account deletion already requested", success: false });
    }

    try {
      const deleteCode = crypto.randomBytes(32).toString("hex");
      await redisClient.set(
        `delete_account:${deleteCode}`,
        JSON.stringify({name, email, reason}),
        { EX: 3600 } // expires in 1 hour
      );

      const emailSent = await sendEmail(
        email,
        "Confirm Your Account Deletion",
        "",
        `
          <table width="100%" cellpadding="0" cellspacing="0" style="font-family: Arial, sans-serif; padding: 20px;">
            <tr>
              <td align="center">
                <table width="500" cellpadding="0" cellspacing="0">

                  <tr>
                    <td align="center">
                      <h1 style="color: #333; margin-bottom: 10px;">
                        Confirm Account Deletion
                      </h1>
                    </td>
                  </tr>

                  <tr>
                    <td>
                      <p style="font-size: 16px; color: #555;">
                        Hi ${name},
                      </p>

                      <p style="font-size: 16px; color: #555;">
                        We received a request to delete your IniyaAI account. If you made this request, please click the button below to confirm:
                      </p>
                    </td>
                  </tr>

                  <tr>
                    <td align="center" style="padding: 20px 0;">
                      <a href="https://iniyaai-backend.onrender.com/api/auth/confirm-delete?code=${deleteCode}"
                        style="background-color: #270c70; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 5px; display: inline-block; font-size: 16px;">
                        Confirm Account Deletion
                      </a>
                    </td>
                  </tr>

                  <tr>
                    <td>
                      <p style="font-size: 16px; color: #555;">
                        If you did not request this, please ignore this email.
                      </p>

                      <p style="font-size: 16px; color: #555; margin-top: 20px;">
                        Best regards,<br>
                        Team Iniya
                      </p>
                    </td>
                  </tr>

                </table>
              </td>
            </tr>
          </table>
        `
      );

      if (emailSent) {
        console.log(`Account deletion confirmation email sent to ${email}`);
        return res.json({ success: true, message: "Confirmation email sent" });
      }
      else {
        console.error(`Failed to send account deletion confirmation email to ${email}`);
        return res.status(500).json({ success: false, message: "Failed to send confirmation email" });
      }
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: "Server error", success: false });
    }
  });

  router.get("/confirm-delete", async (req, res) => {
    const code = req.query.code;
    try {
      const data = await redisClient.get(`delete_account:${code}`);

      if (!data) {
        return res.status(400).send("Invalid or expired code");
      }

      const { name, email, reason } = JSON.parse(data);

      await userCollection.updateOne(
        { email },
        { $set: {markforDeletion: true, deletionReason: reason, deletionRequestedAt: new Date() } }
      );

      return res.redirect("https://iniya-ai.vercel.app/successConfDelete");
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: "Server error", success: false });
    }
  });

  router.get("/get-usage", async (req, res) => {
    const token = req.headers.authorization?.split(" ")[1];
    if (!token) {
      return res.status(400).json({ error: "Token is required" });
    }

    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const user = await userCollection.findOne({ email: decoded.email });

      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      res.json({ usage: user.usage || { tavily: 0, elevenlabs_tts: 0, hf_stt: 0 } });
    } catch (error) {
      console.error(error);
      return res.status(401).json({ error: "Invalid or expired token" });
    }
  });


  return router;
}

async function sendEmail(to, subject, text, html) {
  let transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: "project.iniya@gmail.com",
      pass: process.env.GOOGLE_APP_PASSWORD,
    },
  });

  const info = await transporter.sendMail({
    from: '"IniyaAI" <project.iniya@gmail.com>',
    to,
    subject,
    text,
    html,
  });

  return info;
}