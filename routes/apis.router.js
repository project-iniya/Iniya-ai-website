import express from 'express';
import dotenv from 'dotenv';
import { tavily } from '@tavily/core';
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { InferenceClient } from "@huggingface/inference";
import jwt from 'jsonwebtoken';
import { Readable } from "stream";
import multer from 'multer';
import * as mm from 'music-metadata';

dotenv.config();

export default function apisRouter(astraDB) {
  const router = express.Router();
  const userCollection = astraDB.collection('users');
  const tvly = tavily({ apiKey: process.env.TAVILY_API_KEY });
  const elevenlabs = new ElevenLabsClient({ apiKey: process.env.ELEVEN_API_KEY });
  const hfClient = new InferenceClient({ apiKey: process.env.HUGGINGFACE_API_KEY });
  const upload = multer({ storage: multer.memoryStorage() });
  
  router.post("/tavily", verifyToken, async (req, res) => {
    const {text, func, options} = req.body;

    const dbUser = await userCollection.findOne({ email: req.user.email });

    if (!dbUser) {
      return res.status(404).json({ error: "User not found" });
    }

    if (dbUser.tokenIssuedAt > req.user.iat) {
      return res.status(401).json({ error: "Token has been invalidated. Please log in again.", logout: true });
    }

    if (dbUser.usage?.tavily >= 10 ) {
      return res.status(403).json({ error: "Tavily API usage limit reached" });
    }

    if (!text || !func) {
      return res.status(400).json({ error: "Missing 'text' or 'function' query parameters" });
    }

    try {
      if (func === "search") {
        const result = await tvly.search(text, options);
        await userCollection.updateOne(
          { email: req.user.email },
          { $inc: { "usage.tavily": 1 } }
        );
        res.json(result);
      }
      else if (func === "extract") {
        const result = await tvly.extract(text, options);
        await userCollection.updateOne(
          { email: req.user.email },
          { $inc: { "usage.tavily": 1 } }
        );
        res.json(result);
      }
      else if (func === "crawl") {
        const result = await tvly.crawl(text, options);
        await userCollection.updateOne(
          { email: req.user.email },
          { $inc: { "usage.tavily": 1 } }
        );
        res.json(result);
      }
      else if (func === "map") {
        const result = await tvly.map(text, options);
        await userCollection.updateOne(
          { email: req.user.email },
          { $inc: { "usage.tavily": 1 } }
        );
        res.json(result);
      }
      else if (func === "research") {
        const result = await tvly.research(text, options);
        await userCollection.updateOne(
          { email: req.user.email },
          { $inc: { "usage.tavily": 1 } }
        );
        res.json(result);
      }
      else {
        res.status(400).json({ error: "Invalid function specified" });
      }
    } catch (error) {
      console.error("Error occurred:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });
    
  async function verifyToken(req, res, next) {
    const token = req.headers.authorization?.split(" ")[1];

    if (!token) {
      return res.status(401).json({ error: "No token provided" });
    }

    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      req.user = decoded;

      const user = await userCollection.findOne({ email: req.user.email });

      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      if (user.tokenIssuedAt > req.user.iat) {
        return res.status(401).json({ error: "Token has been invalidated. Please log in again.", logout: true });
      }

      next();
    } catch (err) {
      return res.status(401).json({
        error: "Invalid or expired token",
        details: err.message
      });
    }
  }

  return router;
}

