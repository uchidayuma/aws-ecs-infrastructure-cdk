#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { VpcStack } from '../lib/stacks/vpc-stack';
import { S3Stack } from '../lib/stacks/s3-stack';
import { RdsStack } from '../lib/stacks/rds-stack';
import { EcsStack } from '../lib/stacks/ecs-stack';
import { envConfigs, getEnvConfig } from '../lib/config';
import { WafV2Stack } from '../lib/stacks/wafv2-stack';
import { AlarmsStack } from '../lib/stacks/alarms-stack';
import { EcrStack } from '../lib/stacks/ecr-stack';
import { SesStack } from '../lib/stacks/ses-stack';
import { LogsAnalyticsStack } from '../lib/stacks/logs-analytics-stack';
import { BastionStack } from '../lib/stacks/bastion-stack';
import { GitHubActionsStack } from '../lib/stacks/github-actions-stack';

const app = new cdk.App();

const project = (app.node.tryGetContext('project') as string) || 'sample-app';
const environment = (app.node.tryGetContext('env') as string) || process.env.ENV || 'dev';
const region = (app.node.tryGetContext('region') as string) || process.env.CDK_DEFAULT_REGION || 'ap-northeast-3';
const account = (app.node.tryGetContext('account') as string) || process.env.CDK_DEFAULT_ACCOUNT || process.env.AWS_ACCOUNT_ID;

const config = getEnvConfig(environment);

const stackEnv: cdk.Environment = { account, region };

const vpc = new VpcStack(app, `${project}-${environment}-vpc`, {
  env: stackEnv,
  environment,
  project,
  config,
});

const storage = new S3Stack(app, `${project}-${environment}-s3`, {
  env: stackEnv,
  environment,
  project,
  config,
  // For production, reference the existing bucket to prevent replacement
  reuseExistingBucket: environment === 'prod',
});

const shouldDeployBastion = environment === 'dev' || environment === 'prod';
const enableBastionIntegration = shouldDeployBastion;

// Bastion EC2 for DB access via SSH (no SSM)
// Deploy BEFORE RDS to ensure SSM parameter is available
let bastionStack;
if (shouldDeployBastion) {
  bastionStack = new BastionStack(app, `${project}-${environment}-bastion`, {
    env: stackEnv,
    environment,
    project,
    config,
    vpc: vpc.vpc,
  });
}

const database = new RdsStack(app, `${project}-${environment}-rds`, {
  env: stackEnv,
  environment,
  project,
  config,
  vpc: vpc.vpc,
  ecsSecurityGroup: vpc.ecsSecurityGroup,
  allowBastionAccess: enableBastionIntegration,
});

// Ensure RDS is deployed after Bastion if Bastion access is enabled
if (bastionStack && enableBastionIntegration) {
  database.addDependency(bastionStack);
}

const ecr = new EcrStack(app, `${project}-${environment}-ecr`, {
  env: stackEnv,
  environment,
  project,
});

const ecs = new EcsStack(app, `${project}-${environment}-ecs`, {
  env: stackEnv,
  environment,
  project,
  config,
  vpc: vpc.vpc,
  albSecurityGroup: vpc.albSecurityGroup,
  ecsSecurityGroup: vpc.ecsSecurityGroup,
  bucket: storage.bucket,
  dbSecret: database.dbSecret,
  appUserSecret: database.appUserSecret,
  backendRepo: ecr.backendRepo,
  frontendRepo: ecr.frontendRepo,
});

// Logs analytics: CloudWatch Logs (5xx) -> Firehose -> S3 -> Athena (Glue)
// Keep it simple and low-cost: JSON GZIP to S3 with partition projection
new LogsAnalyticsStack(app, `${project}-${environment}-logs-analytics`, {
  env: stackEnv,
  environment,
  project,
  bucket: storage.bucket,
  backendLogGroupName: `/ecs/${project}-${environment}/backend`,
  jobLogGroupName: `/ecs/${project}-${environment}/jobs`,
}).addDependency(ecs);

// Optional: SES setup for dev if domain is hosted in Route53
const sesEnableCtx = app.node.tryGetContext('sesEnable') as string | undefined;
const sesDomainCtx = app.node.tryGetContext('sesDomain') as string | undefined;
const enableSes = sesEnableCtx ? sesEnableCtx.toLowerCase() === 'true' : false;
if (environment === 'dev' && enableSes && sesDomainCtx) {
  const sesMailFromCtx = (app.node.tryGetContext('sesMailFrom') as string | undefined) || 'ses';
  new SesStack(app, `${project}-${environment}-ses`, {
    env: stackEnv,
    environment,
    project,
    domainName: sesDomainCtx,
    mailFromSubdomain: sesMailFromCtx,
  });
}

// WAF for ALB (disable in dev to save cost)
if (environment !== 'dev') {
  new WafV2Stack(app, `${project}-${environment}-waf`, {
    env: stackEnv,
    environment,
    project,
    alb: ecs.alb,
  });
}

// CloudWatch Alarms (environment-aware)
const alarmsEnabledRaw = (app.node.tryGetContext('enableAlarms') as string | undefined) || process.env.ENABLE_ALARMS;
// Default: disable in dev to minimize cost; enable in staging/prod
const alarmsEnabled = alarmsEnabledRaw !== undefined
  ? alarmsEnabledRaw.toLowerCase() === 'true'
  : environment !== 'dev';

if (alarmsEnabled) {
  const alarmEmailsRaw = (app.node.tryGetContext('alarmEmails') as string | undefined) || process.env.ALARM_EMAILS;
  const alarmEmails = alarmEmailsRaw ? alarmEmailsRaw.split(',').map((s: string) => s.trim()).filter(Boolean) : undefined;
  const alarmTopicArn = (app.node.tryGetContext('alarmTopicArn') as string | undefined) || process.env.ALARM_TOPIC_ARN;
  const rdsConnectionsWarnThresholdRaw = (app.node.tryGetContext('rdsConnectionsWarnThreshold') as string | undefined) || process.env.RDS_CONNECTIONS_WARN_THRESHOLD;
  const rdsConnectionsWarnThreshold = rdsConnectionsWarnThresholdRaw ? Number(rdsConnectionsWarnThresholdRaw) : undefined;
  const slackWebhookSecretName = (app.node.tryGetContext('slackWebhookSecretName') as string | undefined) || `${project}-slack-webhook-url`;
  const enableAlb5xxAlarmRaw = (app.node.tryGetContext('enableAlb5xxAlarm') as string | undefined) || process.env.ENABLE_ALB_5XX_ALARM;
  const enableAlb5xxAlarm = enableAlb5xxAlarmRaw ? enableAlb5xxAlarmRaw.toLowerCase() === 'true' : true;

  new AlarmsStack(app, `${project}-${environment}-alarms`, {
    env: stackEnv,
    environment,
    project,
    alarmEmails,
    alarmTopicArn,
    rdsConnectionsWarnThreshold,
    slackWebhookSecretName,
    enableAlb5xxAlarm,
  });
}

// GitHub Actions OIDC setup
// Create once per AWS account (shared across environments)
const githubRepoCtx = (app.node.tryGetContext('githubRepo') as string | undefined) || process.env.GITHUB_REPOSITORY;
if (githubRepoCtx) {
  new GitHubActionsStack(app, `${project}-github-actions`, {
    env: stackEnv,
    environment: 'shared', // This is account-wide, not environment-specific
    project,
    githubRepository: githubRepoCtx,
    allowedBranches: ['main', 'develop'],
  });
}

// Note: Route53 stack intentionally omitted
