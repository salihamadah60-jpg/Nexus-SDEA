import dotenv from "dotenv";
import mongoose from "mongoose";
import OpenAI from "openai";
import { HfInference } from "@huggingface/inference";
import { GoogleGenerativeAI } from "@google/generative-ai";

dotenv.config({ override: true });

function mask(str: string | undefined) {
  if (!str) return "MISSING";
  if (str.length < 8) return "***";
  if (str.startsWith("AQ.")) return str.slice(0, 4) + "..." + str.slice(-4) + " (Access Token)";
  return str.slice(0, 4) + "..." + str.slice(-4);
}

const MONGODB_URI = process.env.MONGODB_URI;
const GEMINI_API_KEY = (process.env.NEXUS_AI_KEY || process.env.NEXUS_SECRET_KEY || process.env.NEXUS_KEY || process.env.GEMINI_API_KEY)?.trim();
const ALT_GEMINI_KEY = process.env.ALT_GEMINI_KEY?.trim();
const GITHUB_TOKEN = (process.env.GITHUB_GPT || process.env.GITHUB_TOKEN || "").trim();
const HUGGINGFACE_TOKEN = process.env.HUGGINGFACE_TOKEN?.trim();
const GROQ_API_KEY = process.env.GROQ_API_KEY?.trim();

async function verify() {
  console.log("--- Nexus AI Neural Audit ---");
  console.log(`GEMINI_API_KEY: ${mask(GEMINI_API_KEY)}`);
  console.log(`ALT_GEMINI_KEY: ${mask(ALT_GEMINI_KEY)}`);
  console.log(`GITHUB_TOKEN: ${mask(GITHUB_TOKEN)}`);
  console.log(`MONGODB_URI: ${mask(MONGODB_URI)}`);
  console.log(`GROQ_API_KEY: ${mask(GROQ_API_KEY)}`);
  console.log(`HUGGINGFACE_TOKEN: ${mask(HUGGINGFACE_TOKEN)}`);

  if (MONGODB_URI) {
    try {
      await mongoose.connect(MONGODB_URI);
      console.log("✅ Neural Memory Connected");
      await mongoose.disconnect();
    } catch (err: any) {
      console.error("❌ Neural Memory Failed:", err.message);
    }
  }

  const geminiKeys = [GEMINI_API_KEY, ALT_GEMINI_KEY].filter(Boolean) as string[];
  let geminiSuccess = false;

  for (const key of geminiKeys) {
    if (geminiSuccess) break;
    try {
      const client = new GoogleGenerativeAI(key);
      const model = client.getGenerativeModel({ model: "gemini-1.5-flash" });
      const result = await model.generateContent("echo OK");
      const response = await result.response;
      if (response.text()) {
        console.log("✅ Gemini Active");
        geminiSuccess = true;
      }
    } catch (err: any) {
      console.log("⚠️ Gemini key failed:", mask(key), err.message);
    }
  }
  if (!geminiSuccess) console.error("❌ Gemini Total Blockade.");

  if (GITHUB_TOKEN) {
    try {
      const client = new OpenAI({ apiKey: GITHUB_TOKEN, baseURL: "https://models.inference.ai.azure.com" });
      await client.chat.completions.create({ messages: [{ role: "user", content: "hi" }], model: "gpt-4o" });
      console.log("✅ GitHub (gpt-4o) Active");
    } catch (err: any) {
      console.error("❌ GitHub Failed:", err.message);
    }
  }

  if (HUGGINGFACE_TOKEN) {
    try {
      const hf = new HfInference(HUGGINGFACE_TOKEN);
      await hf.chatCompletion({ model: "meta-llama/Meta-Llama-3-8B-Instruct", messages: [{ role: "user", content: "hi" }], max_tokens: 10 });
      console.log("✅ HuggingFace Active");
    } catch (err: any) {
      console.error("❌ HuggingFace Failed:", err.message);
    }
  }

  if (GROQ_API_KEY) {
    try {
      const groq = new OpenAI({ apiKey: GROQ_API_KEY, baseURL: "https://api.groq.com/openai/v1" });
      await groq.chat.completions.create({ messages: [{ role: "user", content: "hi" }], model: "llama-3.3-70b-versatile" });
      console.log("✅ Groq Active");
    } catch (err: any) {
      console.error("❌ Groq Failed:", err.message);
    }
  }

  console.log("\n--- Audit Complete ---");
  process.exit(0);
}

verify();
