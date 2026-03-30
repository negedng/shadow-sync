// Health check endpoint\nexport function healthCheck() {\n  return { status: "ok", timestamp: new Date().toISOString() };\n}
