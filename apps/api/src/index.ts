import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { registerProtectedRoutes } from './routes/protected';
import { registerPublicRoutes } from './routes/public';
import { runD1Maintenance } from './services/dbMaintenance';
import { enqueueTopicSpecialGeneration } from './services/topicSpecialCoordinator';
import type { AppEnv } from './types';
export { UserAgentDO } from './durableObjects/userAgentDO';
export { TopicSpecialSqliteDO, TopicSpecialDO } from './durableObjects/topicSpecialDO';

const app = new Hono<AppEnv>();

app.use(
  '*',
  cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'X-Topic-Special-Admin-Token'],
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
    if (matchesCron(cron, '0 */6 * * *')) {
      try {
        await runD1Maintenance(env);
      } catch (error) {
        console.error('d1_maintenance_failed', {
          cron,
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }
    if (matchesCron(cron, '5 */4 * * *')) {
      try {
        await enqueueTopicSpecialGeneration(env, {
          trigger: 'cron',
        });
      } catch (error) {
        console.error('topic_special_scheduled_failed', {
          cron,
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }
  },
};
