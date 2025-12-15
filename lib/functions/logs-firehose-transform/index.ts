import { gunzipSync } from 'zlib';

interface FirehoseTransformationEventRecord {
  recordId: string;
  approximateArrivalTimestamp: number;
  data: string;
}

interface FirehoseTransformationEvent {
  invocationId: string;
  deliveryStreamArn: string;
  region: string;
  records: FirehoseTransformationEventRecord[];
}

type FirehoseRecordResult = 'Ok' | 'Dropped' | 'ProcessingFailed';

interface FirehoseTransformationResultRecord {
  recordId: string;
  result: FirehoseRecordResult;
  data: string;
}

interface FirehoseTransformationResult {
  records: FirehoseTransformationResultRecord[];
}

type FirehoseTransformationHandler = (event: FirehoseTransformationEvent) => Promise<FirehoseTransformationResult>;

type CloudWatchLogsMessageType = 'DATA_MESSAGE' | 'CONTROL_MESSAGE' | 'TEST_MESSAGE';

interface CloudWatchLogsFirehosePayload {
  messageType: CloudWatchLogsMessageType;
  owner: string;
  logGroup: string;
  logStream: string;
  subscriptionFilters?: string[];
  logEvents: Array<{
    id: string;
    timestamp: number;
    message: string;
  }>;
}

const encodeRecords = (values: Record<string, unknown>[]): string => {
  const text = `${values.map((value) => JSON.stringify(value)).join('\n')}\n`;
  return Buffer.from(text, 'utf-8').toString('base64');
};

const buildErrorRecord = (
  record: FirehoseTransformationEventRecord,
  result: FirehoseTransformationResultRecord['result'],
): FirehoseTransformationResultRecord => ({
  recordId: record.recordId,
  result,
  data: record.data,
});

const processRecord = (
  record: FirehoseTransformationEventRecord,
): FirehoseTransformationResultRecord[] => {
  try {
    const payload = Buffer.from(record.data, 'base64');
    const decompressed = gunzipSync(payload);
    const parsed = JSON.parse(decompressed.toString('utf-8')) as CloudWatchLogsFirehosePayload;

    if (parsed.messageType !== 'DATA_MESSAGE') {
      return [buildErrorRecord(record, 'Dropped')];
    }

    const enrichedMessages: Record<string, unknown>[] = [];
    for (const logEvent of parsed.logEvents ?? []) {
      const rawMessage = logEvent.message?.trim();
      if (!rawMessage) {
        continue;
      }

      let structured: unknown;
      try {
        structured = JSON.parse(rawMessage);
      } catch {
        continue;
      }

      if (!structured || typeof structured !== 'object') {
        continue;
      }

      const enriched = {
        ...(structured as Record<string, unknown>),
        log_group: parsed.logGroup,
        log_stream: parsed.logStream,
        ingestion_time_iso: new Date(logEvent.timestamp).toISOString(),
      };

      enrichedMessages.push(enriched);
    }

    if (enrichedMessages.length === 0) {
      return [buildErrorRecord(record, 'Dropped')];
    }

    return [{
      recordId: record.recordId,
      result: 'Ok',
      data: encodeRecords(enrichedMessages),
    }];
  } catch (error) {
    console.error('Firehose transform failed', error);
    return [buildErrorRecord(record, 'ProcessingFailed')];
  }
};

export const handler: FirehoseTransformationHandler = async (
  event: FirehoseTransformationEvent,
): Promise<FirehoseTransformationResult> => {
  const transformed: FirehoseTransformationResultRecord[] = [];

  for (const record of event.records) {
    transformed.push(...processRecord(record));
  }

  return { records: transformed };
};
