import { Duration, aws_iam as iam, aws_kinesisfirehose as firehose, aws_logs as logs, aws_s3 as s3, aws_glue as glue, aws_athena as athena, aws_lambda as lambda, aws_lambda_nodejs as lambdaNode } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { BaseStack, BaseStackProps } from '../shared/base-stack';

export interface LogsAnalyticsStackProps extends BaseStackProps {
  bucket: s3.IBucket;
  backendLogGroupName: string; // e.g., /ecs/sample-app-dev/backend
  jobLogGroupName?: string; // optional job log group for batch worker
}

export class LogsAnalyticsStack extends BaseStack {
  public readonly deliveryStream: firehose.CfnDeliveryStream;
  public readonly opDeliveryStream: firehose.CfnDeliveryStream;

  constructor(scope: Construct, id: string, props: LogsAnalyticsStackProps) {
    super(scope, id, props);
    const { project, environment, bucket, backendLogGroupName, jobLogGroupName } = props;

    const transformFn = new lambdaNode.NodejsFunction(this, `${project}-${environment}-logs-firehose-transform`, {
      entry: 'lib/functions/logs-firehose-transform/index.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      memorySize: 128,
      timeout: Duration.seconds(30),
      logRetention: logs.RetentionDays.ONE_WEEK,
      description: 'Normalize CloudWatch Logs events for Firehose (removes message wrapper)',
    });

    // Allow Firehose role to invoke the transformation Lambda
    const firehoseRole = new iam.Role(this, `${project}-${environment}-firehose-s3-role`, {
      assumedBy: new iam.ServicePrincipal('firehose.amazonaws.com'),
    });
    // Allow Firehose to write to the target S3 bucket
    firehoseRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        's3:AbortMultipartUpload',
        's3:GetBucketLocation',
        's3:GetObject',
        's3:ListBucket',
        's3:ListBucketMultipartUploads',
        's3:PutObject',
      ],
      resources: [bucket.bucketArn, `${bucket.bucketArn}/*`],
    }));
    firehoseRole.addToPolicy(new iam.PolicyStatement({
      actions: ['lambda:InvokeFunction', 'lambda:GetFunctionConfiguration'],
      resources: [transformFn.functionArn],
    }));
    transformFn.grantInvoke(firehoseRole);

    const prefix = 'log-errors/year=!{timestamp:YYYY}/month=!{timestamp:MM}/day=!{timestamp:dd}/';

    this.deliveryStream = new firehose.CfnDeliveryStream(this, `${project}-${environment}-backend-5xx-to-s3`, {
      deliveryStreamName: `${project}-${environment}-backend-5xx-to-s3`,
      deliveryStreamType: 'DirectPut',
      extendedS3DestinationConfiguration: {
        bucketArn: bucket.bucketArn,
        roleArn: firehoseRole.roleArn,
        bufferingHints: { intervalInSeconds: 60, sizeInMBs: 5 },
        compressionFormat: 'GZIP',
        prefix,
        errorOutputPrefix: 'log-errors/error/!{firehose:error-output-type}/year=!{timestamp:YYYY}/month=!{timestamp:MM}/day=!{timestamp:dd}/',
        processingConfiguration: {
          enabled: true,
          processors: [{
            type: 'Lambda',
            parameters: [
              { parameterName: 'LambdaArn', parameterValue: transformFn.functionArn },
              { parameterName: 'NumberOfRetries', parameterValue: '3' },
            ],
          }],
        },
      },
    });

    // 1b) Firehose for operation logs -> S3 (GZIP) with date-based prefix
    const opPrefix = 'log-operations/year=!{timestamp:YYYY}/month=!{timestamp:MM}/day=!{timestamp:dd}/';
    this.opDeliveryStream = new firehose.CfnDeliveryStream(this, `${project}-${environment}-backend-operation-to-s3`, {
      deliveryStreamName: `${project}-${environment}-backend-operation-to-s3`,
      deliveryStreamType: 'DirectPut',
      extendedS3DestinationConfiguration: {
        bucketArn: bucket.bucketArn,
        roleArn: firehoseRole.roleArn,
        bufferingHints: { intervalInSeconds: 60, sizeInMBs: 5 },
        compressionFormat: 'GZIP',
        prefix: opPrefix,
        errorOutputPrefix: 'log-operations/error/!{firehose:error-output-type}/year=!{timestamp:YYYY}/month=!{timestamp:MM}/day=!{timestamp:dd}/',
        processingConfiguration: {
          enabled: true,
          processors: [{
            type: 'Lambda',
            parameters: [
              { parameterName: 'LambdaArn', parameterValue: transformFn.functionArn },
              { parameterName: 'NumberOfRetries', parameterValue: '3' },
            ],
          }],
        },
      },
    });

    // 2) CloudWatch Logs Subscription Filter -> Firehose (5xx only)
    // Role that CW Logs will assume to put records into Firehose.
    // Note: CloudWatch Logs uses regional service principal (logs.<region>.amazonaws.com)
    const logsToFirehoseRole = new iam.Role(this, `${project}-${environment}-logs-to-firehose-role`, {
      assumedBy: new iam.ServicePrincipal(`logs.${this.region}.amazonaws.com`),
      inlinePolicies: {
        FirehoseWriteAccess: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['firehose:PutRecord', 'firehose:PutRecordBatch'],
              resources: [this.deliveryStream.attrArn, this.opDeliveryStream.attrArn],
            }),
          ],
        }),
      },
    });

    // Ensure the log group exists or import by name; do not attempt to create (ECS stack manages it)
    const logGroup = logs.LogGroup.fromLogGroupName(this, `${project}-${environment}-backend-lg-import`, backendLogGroupName);

    // Filter pattern for 5xx in JSON logs (AND conditions are space-separated)
    const filterPattern = '{ $.http_status >= 500 && $.http_status < 600 }';

    new logs.CfnSubscriptionFilter(this, `${project}-${environment}-backend-5xx-subscription`, {
      destinationArn: this.deliveryStream.attrArn,
      filterPattern,
      logGroupName: logGroup.logGroupName,
      roleArn: logsToFirehoseRole.roleArn,
    });

    if (jobLogGroupName) {
      const jobLogGroup = logs.LogGroup.fromLogGroupName(this, `${project}-${environment}-job-lg-import`, jobLogGroupName);
      new logs.CfnSubscriptionFilter(this, `${project}-${environment}-job-5xx-subscription`, {
        destinationArn: this.deliveryStream.attrArn,
        filterPattern,
        logGroupName: jobLogGroup.logGroupName,
        roleArn: logsToFirehoseRole.roleArn,
      });
    }

    // Operation logs: type=operation and 2xx-3xx
    const opFilterPattern = '{ $.type = "operation" && $.http_status >= 200 && $.http_status < 400 }';
    new logs.CfnSubscriptionFilter(this, `${project}-${environment}-backend-operation-subscription`, {
      destinationArn: this.opDeliveryStream.attrArn,
      filterPattern: opFilterPattern,
      logGroupName: logGroup.logGroupName,
      roleArn: logsToFirehoseRole.roleArn,
    });

    // 3) Glue Database & Table for Athena (JSON + Partition Projection)
    const logsDbNameOverride = this.node.tryGetContext('logsDbName') as string | undefined;
    const safeProject = project.replace(/[^A-Za-z0-9_]/g, '_').toLowerCase();
    const dbName = logsDbNameOverride || `${safeProject}_${environment}_logs`;
    const glueDb = new glue.CfnDatabase(this, `${project}-${environment}-logs-db`, {
      catalogId: this.account,
      databaseInput: { name: dbName, description: 'Logs database for Athena queries' },
    });

    const tableParams: { [key: string]: string } = {
      'projection.enabled': 'true',
      'projection.year.type': 'integer',
      'projection.year.range': '2024,2032',
      'projection.month.type': 'integer',
      'projection.month.range': '1,12',
      'projection.month.digits': '2',
      'projection.day.type': 'integer',
      'projection.day.range': '1,31',
      'projection.day.digits': '2',
      'storage.location.template': `s3://${bucket.bucketName}/log-errors/year=\${year}/month=\${month}/day=\${day}/`,
      'classification': 'json',
      'compressionType': 'gzip',
    };

    new glue.CfnTable(this, `${project}-${environment}-backend-5xx-table`, {
      catalogId: this.account,
      databaseName: dbName,
      tableInput: {
        name: 'backend_error_5xx',
        tableType: 'EXTERNAL_TABLE',
        parameters: tableParams,
        storageDescriptor: {
          location: `s3://${bucket.bucketName}/log-errors/`,
          inputFormat: 'org.apache.hadoop.mapred.TextInputFormat',
          outputFormat: 'org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat',
          compressed: true,
          serdeInfo: {
            serializationLibrary: 'org.openx.data.jsonserde.JsonSerDe',
            parameters: { 'ignore.malformed.json': 'true' },
          },
          columns: [
            { name: 'timestamp', type: 'string' },
            { name: 'level', type: 'string' },
            { name: 'type', type: 'string' },
            { name: 'request_id', type: 'string' },
            { name: 'session_id', type: 'string' },
            { name: 'user_id', type: 'string' },
            { name: 'role', type: 'string' },
            { name: 'ip_address', type: 'string' },
            { name: 'method', type: 'string' },
            { name: 'url', type: 'string' },
            { name: 'query_params', type: 'string' },
            { name: 'request_body', type: 'string' },
            { name: 'user_agent', type: 'string' },
            { name: 'referer', type: 'string' },
            { name: 'http_status', type: 'int' },
            { name: 'response_time', type: 'double' },
            { name: 'message', type: 'string' },
            {
              name: 'context',
              type: 'struct<function_name:string,line_number:int,file_name:string,class_name:string,method_name:string>',
            },
            {
              name: 'error_details',
              type: 'struct<error_type:string,error_code:string,stack_trace:string,original_exception:string,inner_exceptions:array<string>>',
            },
          ],
        },
        partitionKeys: [
          { name: 'year', type: 'string' },
          { name: 'month', type: 'string' },
          { name: 'day', type: 'string' },
        ],
      },
    }).addDependency(glueDb);

    // Operation logs table
    const opTableParams: { [key: string]: string } = {
      ...tableParams,
      'storage.location.template': `s3://${bucket.bucketName}/log-operations/year=\${year}/month=\${month}/day=\${day}/`,
    };

    new glue.CfnTable(this, `${project}-${environment}-backend-operation-table`, {
      catalogId: this.account,
      databaseName: dbName,
      tableInput: {
        name: 'backend_operation',
        tableType: 'EXTERNAL_TABLE',
        parameters: opTableParams,
        storageDescriptor: {
          location: `s3://${bucket.bucketName}/log-operations/`,
          inputFormat: 'org.apache.hadoop.mapred.TextInputFormat',
          outputFormat: 'org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat',
          compressed: true,
          serdeInfo: {
            serializationLibrary: 'org.openx.data.jsonserde.JsonSerDe',
            parameters: { 'ignore.malformed.json': 'true' },
          },
          columns: [
            { name: 'timestamp', type: 'string' },
            { name: 'level', type: 'string' },
            { name: 'type', type: 'string' },
            { name: 'request_id', type: 'string' },
            { name: 'user_id', type: 'string' },
            { name: 'role', type: 'string' },
            { name: 'ip_address', type: 'string' },
            { name: 'method', type: 'string' },
            { name: 'url', type: 'string' },
            { name: 'http_status', type: 'int' },
            { name: 'response_time', type: 'double' },
            { name: 'action', type: 'string' },
            { name: 'resource', type: 'string' },
          ],
        },
        partitionKeys: [
          { name: 'year', type: 'string' },
          { name: 'month', type: 'string' },
          { name: 'day', type: 'string' },
        ],
      },
    }).addDependency(glueDb);

    // 4) Athena Named Queries (common queries)
    const workGroup = 'primary';
    const nqPrefix = `${project}-${environment}`;

    const nq1 = new athena.CfnNamedQuery(this, `${project}-${environment}-nq-errors-yesterday-jst`, {
      database: dbName,
      workGroup,
      name: `${nqPrefix}-errors-yesterday-jst`,
      description: '昨日(JST)の5xxエラー一覧（最新順）',
      queryString: `WITH d AS (
  SELECT
    date_format(at_timezone(current_timestamp, 'Asia/Tokyo') - INTERVAL '1' day, '%Y') AS y,
    date_format(at_timezone(current_timestamp, 'Asia/Tokyo') - INTERVAL '1' day, '%m') AS m,
    date_format(at_timezone(current_timestamp, 'Asia/Tokyo') - INTERVAL '1' day, '%d') AS d
)
SELECT timestamp, user_id, method, url, http_status, message
FROM backend_error_5xx
WHERE year = (SELECT y FROM d)
  AND month = (SELECT m FROM d)
  AND day = (SELECT d FROM d)
ORDER BY timestamp DESC;`,
    });
    // Ensure tables exist before saving queries
    nq1.addDependency(glueDb);

    const nq2 = new athena.CfnNamedQuery(this, `${project}-${environment}-nq-errors-day-template`, {
      database: dbName,
      workGroup,
      name: `${nqPrefix}-errors-day-template`,
      description: '特定日(YYYY-MM-DD)の5xxエラー（編集して使用）',
      queryString: `-- 例: 年月日を編集して使用
SELECT timestamp, user_id, method, url, http_status, message
FROM backend_error_5xx
WHERE year = '2025' AND month = '10' AND day = '01'
ORDER BY timestamp DESC;`,
    });
    nq2.addDependency(glueDb);

    const nq3 = new athena.CfnNamedQuery(this, `${project}-${environment}-nq-errors-top-endpoints`, {
      database: dbName,
      workGroup,
      name: `${nqPrefix}-errors-top-endpoints`,
      description: '特定日の5xx多発エンドポイント上位',
      queryString: `-- 年月日を編集
SELECT url, count(*) AS cnt
FROM backend_error_5xx
WHERE year = '2025' AND month = '10' AND day = '01'
GROUP BY url
ORDER BY cnt DESC
LIMIT 50;`,
    });
    nq3.addDependency(glueDb);

    const nq4 = new athena.CfnNamedQuery(this, `${project}-${environment}-nq-ops-slow-3s`, {
      database: dbName,
      workGroup,
      name: `${nqPrefix}-ops-slow-3s`,
      description: '特定日の3秒以上の遅延操作',
      queryString: `-- 年月日を編集
SELECT timestamp, user_id, method, url, http_status, response_time
FROM backend_operation
WHERE year = '2025' AND month = '10' AND day = '01'
  AND response_time >= 3.0
ORDER BY response_time DESC
LIMIT 200;`,
    });
    nq4.addDependency(glueDb);

    const nq5 = new athena.CfnNamedQuery(this, `${project}-${environment}-nq-ops-status-dist`, {
      database: dbName,
      workGroup,
      name: `${nqPrefix}-ops-status-dist`,
      description: '特定日の操作ログHTTPステータス分布',
      queryString: `-- 年月日を編集
SELECT http_status, count(*) AS cnt
FROM backend_operation
WHERE year = '2025' AND month = '10' AND day = '01'
GROUP BY http_status
ORDER BY http_status;`,
    });
    nq5.addDependency(glueDb);

    const nq6 = new athena.CfnNamedQuery(this, `${project}-${environment}-nq-user-activity-day`, {
      database: dbName,
      workGroup,
      name: `${nqPrefix}-user-activity-day`,
      description: '特定ユーザーの操作+エラーログ（特定日）',
      queryString: `-- 年月日と user_id を編集
SELECT 'operation' AS kind, timestamp, user_id, method, url, http_status, response_time, CAST(NULL AS varchar) AS message
FROM backend_operation
WHERE year = '2025' AND month = '10' AND day = '01' AND user_id = '123'
UNION ALL
SELECT 'error' AS kind, timestamp, user_id, method, url, http_status, response_time, message
FROM backend_error_5xx
WHERE year = '2025' AND month = '10' AND day = '01' AND user_id = '123'
ORDER BY timestamp DESC
LIMIT 500;`,
    });
    nq6.addDependency(glueDb);

    const nq7 = new athena.CfnNamedQuery(this, `${project}-${environment}-nq-errors-by-hour`, {
      database: dbName,
      workGroup,
      name: `${nqPrefix}-errors-by-hour`,
      description: '特定日の5xx件数(時間帯別)',
      queryString: `-- 年月日を編集
SELECT substr(timestamp, 12, 2) AS hour, count(*) AS cnt
FROM backend_error_5xx
WHERE year = '2025' AND month = '10' AND day = '01'
GROUP BY 1
ORDER BY 1;`,
    });
    nq7.addDependency(glueDb);
  }
}
