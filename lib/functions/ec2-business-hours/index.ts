import { EC2Client, StartInstancesCommand, StopInstancesCommand, DescribeInstancesCommand } from '@aws-sdk/client-ec2';
import { Route53Client, ChangeResourceRecordSetsCommand } from '@aws-sdk/client-route-53';
import { isJapanHolidayJst } from '../shared/jp-holidays';

const ec2 = new EC2Client({});
const r53 = new Route53Client({});
const INSTANCE_ID = process.env.INSTANCE_ID!;
const HOSTED_ZONE_ID = process.env.HOSTED_ZONE_ID || '';
const RECORD_NAME = process.env.RECORD_NAME || '';

type Event = { action: 'start' | 'stop' };

export const handler = async (event: Event) => {
  const now = new Date();
  const isHoliday = isJapanHolidayJst(now);

  if (event.action === 'start') {
    // Describe current state
    const desc0 = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [INSTANCE_ID] }));
    const inst0 = desc0.Reservations?.[0]?.Instances?.[0];
    const state0 = inst0?.State?.Name;
    const ip0 = inst0?.PublicIpAddress;
    console.log(`Current state=${state0}, ip=${ip0}`);

    const isRunning = state0 === 'running';
    const isPending = state0 === 'pending';
    const skipStartDueToHoliday = isHoliday && !isRunning && !isPending;

    if (skipStartDueToHoliday) {
      console.log(`Holiday detected (JST). Instance state=${state0}; skipping StartInstances.`);
    }

    // Ensure instance is running (skip actual StartInstances on holidays when stopped)
    if (!skipStartDueToHoliday && !isRunning && !isPending) {
      try {
        await ec2.send(new StartInstancesCommand({ InstanceIds: [INSTANCE_ID] }));
        console.log('EC2 start initiated');
      } catch (e) {
        console.log('StartInstances error (possibly already running):', e);
      }
    }

    // Wait until instance has a public IP, then update DNS
    if (HOSTED_ZONE_ID && RECORD_NAME) {
      if (skipStartDueToHoliday && !isRunning && !isPending) {
        console.log('Skipping DNS update because instance remains stopped due to holiday policy.');
      } else {
        const maxAttempts = 20;
        for (let i = 0; i < maxAttempts; i++) {
          if (i > 0) await delay(15000); // 15s
          const desc = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [INSTANCE_ID] }));
          const res = desc.Reservations?.[0]?.Instances?.[0];
          const ip = res?.PublicIpAddress;
          const state = res?.State?.Name;
          console.log(`Check ${i + 1}/${maxAttempts}: state=${state}, ip=${ip}`);
          if (ip) {
            await r53.send(new ChangeResourceRecordSetsCommand({
              HostedZoneId: HOSTED_ZONE_ID,
              ChangeBatch: {
                Changes: [
                  {
                    Action: 'UPSERT',
                    ResourceRecordSet: {
                      Name: RECORD_NAME,
                      Type: 'A',
                      TTL: 60,
                      ResourceRecords: [{ Value: ip }],
                    },
                  },
                ],
                Comment: 'Updated by ec2-business-hours lambda',
              },
            }));
            console.log(`Route53 A record upserted: ${RECORD_NAME} -> ${ip}`);
            break;
          }
        }
      }
    }
    return skipStartDueToHoliday && !isRunning && !isPending ? { skipped: true } : { ok: true };
  }
  if (event.action === 'stop') {
    // Optional: ensure instance exists and is running/stopped as needed
    try {
      await ec2.send(new StopInstancesCommand({ InstanceIds: [INSTANCE_ID] }));
      console.log('EC2 stop initiated');
    } catch (e) {
      console.log('Stop error (might already be stopped)', e);
    }
    return { ok: true };
  }
  console.log('Unknown action', event);
  return { ok: false };
};

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
