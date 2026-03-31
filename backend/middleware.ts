// Auth middleware
export function authMiddleware(req: any, next: any) {
  if (!req.headers.authorization) throw new Error("Unauthorized");
  next();
}
