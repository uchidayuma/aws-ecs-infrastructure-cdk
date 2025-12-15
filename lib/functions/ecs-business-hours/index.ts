import { ECSClient, UpdateServiceCommand } from '@aws-sdk/client-ecs';
import { isJapanHolidayJst } from '../shared/jp-holidays';

const ecs = new ECSClient({});

const CLUSTER = process.env.CLUSTER_NAME!;
const FRONTEND_SERVICE = process.env.FRONTEND_SERVICE_NAME!;
const BACKEND_SERVICE = process.env.BACKEND_SERVICE_NAME!;
const JOB_SERVICE = process.env.JOB_SERVICE_NAME!;
const DESIRED_UP = Number(process.env.DESIRED_UP_COUNT || '1');

type Event = { action: 'up' | 'down' };

export const handler = async (event: Event) => {
  const now = new Date();
  const isHoliday = isJapanHolidayJst(now);

  if (event.action === 'up') {
    if (isHoliday) {
      console.log('Holiday detected (JST). Skipping scale up.');
      return { skipped: true };
    }
    await Promise.all([
      ecs.send(new UpdateServiceCommand({ cluster: CLUSTER, service: FRONTEND_SERVICE, desiredCount: DESIRED_UP })),
      ecs.send(new UpdateServiceCommand({ cluster: CLUSTER, service: BACKEND_SERVICE, desiredCount: DESIRED_UP })),
      ecs.send(new UpdateServiceCommand({ cluster: CLUSTER, service: JOB_SERVICE, desiredCount: DESIRED_UP })),
    ]);
    console.log(`Scaled up services to ${DESIRED_UP}`);
    return { ok: true };
  }
  if (event.action === 'down') {
    // Outside business hours: stop all services in DEV
    await Promise.all([
      ecs.send(new UpdateServiceCommand({ cluster: CLUSTER, service: FRONTEND_SERVICE, desiredCount: 0 })),
      ecs.send(new UpdateServiceCommand({ cluster: CLUSTER, service: BACKEND_SERVICE, desiredCount: 0 })),
      ecs.send(new UpdateServiceCommand({ cluster: CLUSTER, service: JOB_SERVICE, desiredCount: 0 })),
    ]);
    console.log('Scaled down: frontend=0, backend=0, job=0');
    return { ok: true };
  }
  console.log('Unknown action', event);
  return { ok: false };
};
