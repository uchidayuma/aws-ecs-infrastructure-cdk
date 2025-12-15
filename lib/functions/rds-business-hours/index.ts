import { RDSClient, StartDBInstanceCommand, StopDBInstanceCommand } from '@aws-sdk/client-rds';
import { isJapanHolidayJst } from '../shared/jp-holidays';

const rds = new RDSClient({});
const DB_INSTANCE_IDENTIFIER = process.env.DB_INSTANCE_IDENTIFIER!;

type Event = { action: 'start' | 'stop' };

export const handler = async (event: Event) => {
  const now = new Date();
  const isHoliday = isJapanHolidayJst(now);

  if (event.action === 'start') {
    if (isHoliday) {
      console.log('Holiday detected (JST). Skipping RDS start.');
      return { skipped: true };
    }
    await rds.send(new StartDBInstanceCommand({ DBInstanceIdentifier: DB_INSTANCE_IDENTIFIER }));
    console.log('RDS start initiated');
    return { ok: true };
  }
  if (event.action === 'stop') {
    await rds.send(new StopDBInstanceCommand({ DBInstanceIdentifier: DB_INSTANCE_IDENTIFIER }));
    console.log('RDS stop initiated');
    return { ok: true };
  }
  console.log('Unknown action', event);
  return { ok: false };
};

