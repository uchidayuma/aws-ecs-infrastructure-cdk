
import { SNSEvent } from 'aws-lambda';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { IncomingWebhook } from '@slack/webhook';

const secretArn = process.env.SLACK_WEBHOOK_SECRET_ARN;
if (!secretArn) {
  throw new Error('SLACK_WEBHOOK_SECRET_ARN environment variable not set.');
}

const secrets = new SecretsManagerClient({});
let webhook: IncomingWebhook;

async function getWebhook(): Promise<IncomingWebhook> {
  if (webhook) {
    return webhook;
  }
  const secret = await secrets.send(new GetSecretValueCommand({ SecretId: secretArn }));
  const webhookUrl = JSON.parse(secret.SecretString ?? '{}').url;
  if (!webhookUrl) {
    throw new Error('Slack webhook URL not found in secret.');
  }
  webhook = new IncomingWebhook(webhookUrl);
  return webhook;
}

export const handler = async (event: SNSEvent): Promise<void> => {
  const webhook = await getWebhook();
  for (const record of event.Records) {
    const message = JSON.parse(record.Sns.Message);
    const { AlarmName, NewStateValue, NewStateReason, AlarmDescription, OldStateValue } = message;

    const isOk = NewStateValue === 'OK';
    const color = isOk ? 'good' : 'danger';
    const state = isOk ? 'OK' : 'ALARM';
    const emoji = isOk ? ':white_check_mark:' : ':warning:';

    await webhook.send({
      attachments: [
        {
          color,
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `${emoji} *${state}: ${AlarmName}*`,
              },
            },
            {
              type: 'section',
              fields: [
                { type: 'mrkdwn', text: `*Description:*
${AlarmDescription}` },
                { type: 'mrkdwn', text: `*State Change:*
${OldStateValue} -> ${NewStateValue}` },
              ],
            },
            {
              type: 'context',
              elements: [
                {
                  type: 'mrkdwn',
                  text: `*Reason:*
${NewStateReason}`,
                },
              ],
            },
          ],
        },
      ],
    });
  }
};
