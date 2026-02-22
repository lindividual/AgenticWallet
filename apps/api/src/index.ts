import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { registerProtectedRoutes } from './routes/protected';
import { registerPublicRoutes } from './routes/public';
import type { AppEnv } from './types';

const app = new Hono<AppEnv>();

app.use(
  '*',
  cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
  }),
);

registerPublicRoutes(app);
registerProtectedRoutes(app);

export default app;
