import express, { Express } from "express";
import cors from "cors";
import { createProxyMiddleware } from "http-proxy-middleware";

export function setupMiddleware(app: Express) {
  app.use(cors());
  app.use(express.json({ limit: "10mb" }));

  // Preview Proxy per session
  app.use("/api/preview/:sessionId", createProxyMiddleware({
    target: "http://localhost:3001",
    changeOrigin: true,
    pathRewrite: (path) => path.replace(/^\/api\/preview\/[^/]+/, ""),
    ws: true,
    on: {
      error: (_err: any, _req: any, res: any) => {
        res.status(503).send("Preview server not running on port 3001. Start via terminal: npx http-server -p 3001");
      }
    }
  } as any));
}
