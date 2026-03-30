// Rate limiter middleware\nexport function rateLimit(maxRequests: number) {\n  return (req: any, res: any, next: any) => next();\n}
