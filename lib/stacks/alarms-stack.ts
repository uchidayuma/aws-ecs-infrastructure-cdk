
import { Duration, aws_cloudwatch as cw, aws_sns as sns, aws_lambda_nodejs as lambdaNode, aws_iam as iam, aws_secretsmanager as secrets, aws_lambda as lambda, aws_ssm as ssm } from 'aws-cdk-lib';
import { SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions';
import { EmailSubscription, LambdaSubscription } from 'aws-cdk-lib/aws-sns-subscriptions';
import { Construct } from 'constructs';
import { BaseStack, BaseStackProps } from '../shared/base-stack';
import {
  ecsClusterNameParameterName,
  ecsBackendServiceNameParameterName,
  ecsFrontendServiceNameParameterName,
  ecsJobServiceNameParameterName,
  albFullNameParameterName,
  rdsInstanceIdentifierParameterName,
} from '../shared/parameter-names';

export interface AlarmsStackProps extends BaseStackProps {
  alarmEmails?: string[];
  alarmTopicArn?: string; // if provided, reuse existing topic
  rdsConnectionsWarnThreshold?: number; // optional absolute threshold
  slackWebhookSecretName?: string;
  enableAlb5xxAlarm?: boolean;
}

export class AlarmsStack extends BaseStack {
  constructor(scope: Construct, id: string, props: AlarmsStackProps) {
    super(scope, id, props);
    const { project, environment, slackWebhookSecretName, enableAlb5xxAlarm } = props;
    const makeAlarmName = (suffix: string) => `${project}-${environment}-${suffix}`;

    const clusterName = ssm.StringParameter.fromStringParameterName(this, `${project}-${environment}-cluster-name-param`, ecsClusterNameParameterName(project, environment)).stringValue;
    const backendServiceName = ssm.StringParameter.fromStringParameterName(this, `${project}-${environment}-backend-service-name-param`, ecsBackendServiceNameParameterName(project, environment)).stringValue;
    const frontendServiceName = ssm.StringParameter.fromStringParameterName(this, `${project}-${environment}-frontend-service-name-param`, ecsFrontendServiceNameParameterName(project, environment)).stringValue;
    const jobServiceName = ssm.StringParameter.fromStringParameterName(this, `${project}-${environment}-job-service-name-param`, ecsJobServiceNameParameterName(project, environment)).stringValue;
    const albFullName = ssm.StringParameter.fromStringParameterName(this, `${project}-${environment}-alb-full-name-param`, albFullNameParameterName(project, environment)).stringValue;
    const rdsInstanceIdentifier = ssm.StringParameter.fromStringParameterName(this, `${project}-${environment}-rds-identifier-param`, rdsInstanceIdentifierParameterName(project, environment)).stringValue;

    // SNS Topic for email notifications
    const emailTopic = props.alarmTopicArn
      ? sns.Topic.fromTopicArn(this, 'AlarmTopic', props.alarmTopicArn)
      : new sns.Topic(this, `${project}-${environment}-alarms-topic`, { topicName: `${project}-${environment}-alarms` });
    if (!props.alarmTopicArn && props.alarmEmails && props.alarmEmails.length) {
      props.alarmEmails.forEach((email, idx) => {
        (emailTopic as sns.Topic).addSubscription(new EmailSubscription(email));
      });
    }

    // Slack notifications
    let slackTopic: sns.Topic | undefined;
    if (slackWebhookSecretName) {
      slackTopic = new sns.Topic(this, `${project}-${environment}-slack-alarms-topic`, {
        topicName: `${project}-${environment}-slack-alarms`,
      });

      const slackSecret = secrets.Secret.fromSecretNameV2(this, 'SlackWebhookSecret', slackWebhookSecretName);

      const slackNotifier = new lambdaNode.NodejsFunction(this, 'SlackNotifierLambda', {
        entry: 'lib/functions/slack-notifier/index.ts',
        handler: 'handler',
        runtime: lambda.Runtime.NODEJS_18_X,
        environment: {
          SLACK_WEBHOOK_SECRET_ARN: slackSecret.secretArn,
        },
      });

      slackSecret.grantRead(slackNotifier);
      slackTopic.addSubscription(new LambdaSubscription(slackNotifier));
    }

    const topics = [emailTopic, slackTopic].filter((t): t is sns.ITopic => !!t);

    const backendCpuMetric = new cw.Metric({
      namespace: 'AWS/ECS',
      metricName: 'CPUUtilization',
      dimensionsMap: { ClusterName: clusterName, ServiceName: backendServiceName },
      period: Duration.minutes(1),
      statistic: 'Average',
    });
    const backendMemMetric = new cw.Metric({
      namespace: 'AWS/ECS',
      metricName: 'MemoryUtilization',
      dimensionsMap: { ClusterName: clusterName, ServiceName: backendServiceName },
      period: Duration.minutes(1),
      statistic: 'Average',
    });
    const frontendCpuMetric = new cw.Metric({
      namespace: 'AWS/ECS',
      metricName: 'CPUUtilization',
      dimensionsMap: { ClusterName: clusterName, ServiceName: frontendServiceName },
      period: Duration.minutes(1),
      statistic: 'Average',
    });
    const frontendMemMetric = new cw.Metric({
      namespace: 'AWS/ECS',
      metricName: 'MemoryUtilization',
      dimensionsMap: { ClusterName: clusterName, ServiceName: frontendServiceName },
      period: Duration.minutes(1),
      statistic: 'Average',
    });
    const jobCpuMetric = new cw.Metric({
      namespace: 'AWS/ECS',
      metricName: 'CPUUtilization',
      dimensionsMap: { ClusterName: clusterName, ServiceName: jobServiceName },
      period: Duration.minutes(1),
      statistic: 'Average',
    });
    const jobMemMetric = new cw.Metric({
      namespace: 'AWS/ECS',
      metricName: 'MemoryUtilization',
      dimensionsMap: { ClusterName: clusterName, ServiceName: jobServiceName },
      period: Duration.minutes(1),
      statistic: 'Average',
    });
    const jobRunningTaskMetric = new cw.Metric({
      namespace: 'AWS/ECS',
      metricName: 'RunningTaskCount',
      dimensionsMap: { ClusterName: clusterName, ServiceName: jobServiceName },
      period: Duration.minutes(1),
      statistic: 'Minimum',
    });

    const backendCpuAlarmName = makeAlarmName('backend-cpu-critical');
    const backendCpuAlarm = new cw.Alarm(this, backendCpuAlarmName, {
      alarmName: backendCpuAlarmName,
      metric: backendCpuMetric,
      comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
      threshold: 80,
      evaluationPeriods: 5,
      treatMissingData: cw.TreatMissingData.IGNORE,
      alarmDescription: 'Backend ECS CPU > 80% for 5 minutes',
    });
    const backendMemAlarmName = makeAlarmName('backend-mem-critical');
    const backendMemAlarm = new cw.Alarm(this, backendMemAlarmName, {
      alarmName: backendMemAlarmName,
      metric: backendMemMetric,
      comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
      threshold: 90,
      evaluationPeriods: 5,
      treatMissingData: cw.TreatMissingData.IGNORE,
      alarmDescription: 'Backend ECS memory > 90% for 5 minutes',
    });
    const frontendCpuAlarmName = makeAlarmName('frontend-cpu-critical');
    const frontendCpuAlarm = new cw.Alarm(this, frontendCpuAlarmName, {
      alarmName: frontendCpuAlarmName,
      metric: frontendCpuMetric,
      comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
      threshold: 80,
      evaluationPeriods: 5,
      treatMissingData: cw.TreatMissingData.IGNORE,
      alarmDescription: 'Frontend ECS CPU > 80% for 5 minutes',
    });
    const frontendMemAlarmName = makeAlarmName('frontend-mem-critical');
    const frontendMemAlarm = new cw.Alarm(this, frontendMemAlarmName, {
      alarmName: frontendMemAlarmName,
      metric: frontendMemMetric,
      comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
      threshold: 90,
      evaluationPeriods: 5,
      treatMissingData: cw.TreatMissingData.IGNORE,
      alarmDescription: 'Frontend ECS memory > 90% for 5 minutes',
    });
    const jobCpuAlarmName = makeAlarmName('job-cpu-critical');
    const jobCpuAlarm = new cw.Alarm(this, jobCpuAlarmName, {
      alarmName: jobCpuAlarmName,
      metric: jobCpuMetric,
      comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
      threshold: 80,
      evaluationPeriods: 5,
      treatMissingData: cw.TreatMissingData.IGNORE,
      alarmDescription: 'Job ECS CPU > 80% for 5 minutes',
    });
    const jobMemAlarmName = makeAlarmName('job-mem-critical');
    const jobMemAlarm = new cw.Alarm(this, jobMemAlarmName, {
      alarmName: jobMemAlarmName,
      metric: jobMemMetric,
      comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
      threshold: 90,
      evaluationPeriods: 5,
      treatMissingData: cw.TreatMissingData.IGNORE,
      alarmDescription: 'Job ECS memory > 90% for 5 minutes',
    });
    const jobTaskCountAlarmName = makeAlarmName('job-running-count-critical');
    const jobTaskCountAlarm = new cw.Alarm(this, jobTaskCountAlarmName, {
      alarmName: jobTaskCountAlarmName,
      metric: jobRunningTaskMetric,
      comparisonOperator: cw.ComparisonOperator.LESS_THAN_THRESHOLD,
      threshold: 0.5,
      evaluationPeriods: 1,
      treatMissingData: cw.TreatMissingData.BREACHING,
      alarmDescription: 'Job ECS running task count dropped below 1',
    });

    [backendCpuAlarm, backendMemAlarm, frontendCpuAlarm, frontendMemAlarm, jobCpuAlarm, jobMemAlarm, jobTaskCountAlarm].forEach(alarm => {
      topics.forEach(topic => {
        alarm.addAlarmAction(new SnsAction(topic));
        alarm.addOkAction(new SnsAction(topic));
      });
    });

    if (enableAlb5xxAlarm ?? true) {
      // Application 5xx surfaced at ALB target > 0 in 1 minute
      const albTarget5xx = new cw.Metric({
        namespace: 'AWS/ApplicationELB',
        metricName: 'HTTPCode_Target_5XX_Count',
        dimensionsMap: { LoadBalancer: albFullName },
        period: Duration.minutes(1),
        statistic: 'Sum',
      });
      const alb5xxAlarmName = makeAlarmName('alb-5xx-critical');
      const alb5xxAlarm = new cw.Alarm(this, alb5xxAlarmName, {
        alarmName: alb5xxAlarmName,
        metric: albTarget5xx,
        comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
        threshold: 0,
        evaluationPeriods: 1,
        treatMissingData: cw.TreatMissingData.NOT_BREACHING,
        alarmDescription: 'Target 5xx errors reported by ALB > 0 in 1 minute',
      });
      topics.forEach(topic => {
        alb5xxAlarm.addAlarmAction(new SnsAction(topic));
        alb5xxAlarm.addOkAction(new SnsAction(topic));
      });
    }

    // RDS CPU > 80% for 10 minutes
    const rdsCpu = new cw.Metric({
      namespace: 'AWS/RDS',
      metricName: 'CPUUtilization',
      dimensionsMap: { DBInstanceIdentifier: rdsInstanceIdentifier },
      period: Duration.minutes(1),
      statistic: 'Average',
    });
    const rdsCpuAlarmName = makeAlarmName('rds-cpu-critical');
    const rdsCpuAlarm = new cw.Alarm(this, rdsCpuAlarmName, {
      alarmName: rdsCpuAlarmName,
      metric: rdsCpu,
      comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
      threshold: 80,
      evaluationPeriods: 10,
      treatMissingData: cw.TreatMissingData.IGNORE,
      alarmDescription: 'RDS CPU > 80% for 10 minutes',
    });
    topics.forEach(topic => {
      rdsCpuAlarm.addAlarmAction(new SnsAction(topic));
      rdsCpuAlarm.addOkAction(new SnsAction(topic));
    });

    // RDS CPU > 70% for 3 minutes (Warning)
    const rdsCpuWarning = rdsCpu;
    const rdsCpuWarningAlarmName = makeAlarmName('rds-cpu-warning');
    const rdsCpuWarningAlarm = new cw.Alarm(this, rdsCpuWarningAlarmName, {
      alarmName: rdsCpuWarningAlarmName,
      metric: rdsCpuWarning,
      comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
      threshold: 70,
      evaluationPeriods: 3,
      treatMissingData: cw.TreatMissingData.IGNORE,
      alarmDescription: 'RDS CPU > 70% for 3 minutes',
    });
    topics.forEach(topic => {
      rdsCpuWarningAlarm.addAlarmAction(new SnsAction(topic));
      rdsCpuWarningAlarm.addOkAction(new SnsAction(topic));
    });

    // Optional: ALB response time warning > 2s
    const albRt = new cw.Metric({
      namespace: 'AWS/ApplicationELB',
      metricName: 'TargetResponseTime',
      dimensionsMap: { LoadBalancer: albFullName },
      period: Duration.minutes(1),
      statistic: 'Average',
    });
    const albRtAlarmName = makeAlarmName('alb-rt-warning');
    const albRtAlarm = new cw.Alarm(this, albRtAlarmName, {
      alarmName: albRtAlarmName,
      metric: albRt,
      comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
      threshold: 2,
      evaluationPeriods: 5,
      treatMissingData: cw.TreatMissingData.IGNORE,
      alarmDescription: 'ALB target response time > 2 seconds',
    });
    topics.forEach(topic => {
      albRtAlarm.addAlarmAction(new SnsAction(topic));
      albRtAlarm.addOkAction(new SnsAction(topic));
    });

    // Optional: RDS connections warning using absolute threshold if provided
    if (props.rdsConnectionsWarnThreshold && props.rdsConnectionsWarnThreshold > 0) {
      const rdsConn = new cw.Metric({
        namespace: 'AWS/RDS',
        metricName: 'DatabaseConnections',
        dimensionsMap: { DBInstanceIdentifier: rdsInstanceIdentifier },
        period: Duration.minutes(1),
        statistic: 'Average',
      });
      const rdsConnAlarmName = makeAlarmName('rds-connections-warning');
      const rdsConnAlarm = new cw.Alarm(this, rdsConnAlarmName, {
        alarmName: rdsConnAlarmName,
        metric: rdsConn,
        comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
        threshold: props.rdsConnectionsWarnThreshold,
        evaluationPeriods: 5,
        treatMissingData: cw.TreatMissingData.IGNORE,
        alarmDescription: `RDS connections > ${props.rdsConnectionsWarnThreshold} (warning)`,
      });
      topics.forEach(topic => {
        rdsConnAlarm.addAlarmAction(new SnsAction(topic));
        rdsConnAlarm.addOkAction(new SnsAction(topic));
      });
    }
  }

}
