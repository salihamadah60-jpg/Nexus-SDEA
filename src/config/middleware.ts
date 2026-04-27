import express, { Express } from "express";
import cors from "cors";

export function setupMiddleware(app: Express) {
  app.use(cors());
  app.use(express.json({ limit: "10mb" }));
}
