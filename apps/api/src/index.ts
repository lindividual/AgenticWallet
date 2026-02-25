import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { registerProtectedRoutes } from './routes/protected';
import { registerPublicRoutes } from './routes/public';
import type { AppEnv } from './types';
import { ingestTokenLists } from './services/market';
export { UserAgentDO } from './durableObjects/userAgentDO';

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

function matchesCron(eventCron: string, target: string): boolean {
  return eventCron.trim() === target;
}

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: AppEnv['Bindings'], _ctx: ExecutionContext): Promise<void> {
    const cron = event.cron ?? '';
    if (matchesCron(cron, '0 0 * * *')) {
      await ingestTokenLists(env);
      return;
    }
  },
};
