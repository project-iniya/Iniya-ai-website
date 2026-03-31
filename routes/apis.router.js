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

  router.post("/tts", verifyToken, async (req, res) => {
    const { text, voice } = req.body;
    
    if (!text)
      return res.status(400).json({ error: "Missing 'text' query parameter" });

    if (text.length > 500)
      return res.status(400).json({ error: "Text exceeds maximum length of 500 characters" });

    try {

      const user = await userCollection.findOne({ email: req.user.email });

      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      if (user.usage.elevenlabs_tts >= 10) {
        return res.status(403).json({ error: "ElevenLabs TTS usage limit reached" });
      }

      const audioStream = await elevenlabs.textToSpeech.convert(voice || "JBFqnCBsd6RMkjVDRZzb", {
        text,
        model_id: "eleven_flash_v2",
        output_format: "mp3_44100_128",
      });

      res.setHeader("Content-Type", "audio/mpeg");
      res.setHeader("Transfer-Encoding", "chunked");

      const nodeStream = Readable.fromWeb(audioStream);

      await userCollection.updateOne(
        { email: req.user.email },
        { $inc: { "usage.elevenlabs_tts": 1 } }
      );

      nodeStream.pipe(res);

      nodeStream.on("error", (err) => {
        console.error("Stream error:", err);
        if (!res.headersSent) res.status(500).json({ error: "Stream failed" });
      });

    } catch (error) {
      console.error("TTS error:", error);
      res.status(500).json({ error: "TTS conversion failed" });
    }
  });

  router.post("/stt", verifyToken, upload.single("audio"), async (req, res) => {
    if (!req.file)
      return res.status(400).json({ error: "No audio file provided" });

    const metadata = await mm.parseBuffer(req.file.buffer, req.file.mimetype);
    const duration = metadata.format.duration; // in seconds
  
    if (duration > 120) // 2 minutes
      return res.status(400).json({ error: "Audio duration exceeds maximum of 2 minutes" });

    try {
      const user = await userCollection.findOne({ email: req.user.email });
      if (!user) return res.status(404).json({ error: "User not found" });

      if (user.usage.hf_stt >= 10) {
        return res.status(403).json({ error: "Speech-to-text usage limit reached" });
      }

      data = req.file.buffer;
      const result = await hfClient.automaticSpeechRecognition({
        data,
        model: "openai/whisper-large-v3-turbo",
        provider: "hf-inference",
      })

      await userCollection.updateOne(
        { email: req.user.email },
        { $inc: { "usage.hf_stt": 1 } }
      );

      res.json({ text: result.text });

    } catch (error) {
      if (error.response) {
        console.error("HF error:", error.response.data);
        return res.status(502).json({ error: "HF inference failed", details: error.response.data });
      }
      res.status(500).json({ error: "STT failed" });
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

