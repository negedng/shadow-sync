// Backend API server
import express from "express";

const app = express();

app.get("/api/health", (req, res) => {
  res.json({ status: "ok" });
});

export default app;

// Graceful shutdown handler
export function gracefulShutdown() {
  console.log("Shutting down gracefully...");
  process.exit(0);
}

// Auto-shadow test: backend version endpoint
app.get("/api/version", (req, res) => {
  res.json({ version: "1.0.0" });
});

// Local: add /api/ping endpoint
app.get("/api/ping", (req, res) => res.json({ pong: true }));
