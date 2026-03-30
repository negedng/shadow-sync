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
