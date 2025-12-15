import { Construct } from 'constructs';
import { CfnOutput, Duration, Tags, aws_ec2 as ec2, aws_iam as iam, aws_lambda as lambda, aws_lambda_nodejs as lambdaNode, aws_logs as logs, aws_route53 as route53, aws_ssm as ssm } from 'aws-cdk-lib';
import { aws_events as events } from 'aws-cdk-lib';
import { aws_events_targets as eventsTargets } from 'aws-cdk-lib';
import { BaseStack, BaseStackProps } from '../shared/base-stack';
import { aws_scheduler as scheduler } from 'aws-cdk-lib';
import { bastionSecurityGroupIdParameterName } from '../shared/parameter-names';

export interface BastionStackProps extends BaseStackProps {
  vpc: ec2.IVpc;
}

export class BastionStack extends BaseStack {
  public readonly securityGroup: ec2.SecurityGroup;
  public readonly instance: ec2.Instance;

  constructor(scope: Construct, id: string, props: BastionStackProps) {
    super(scope, id, props);

    const { project, environment, vpc, config } = props as BastionStackProps & { config?: any };
    const isDev = environment === 'dev';
    // Context-driven settings with safe defaults
    // DEV 環境ではキーペア名を固定: sample-app-dev-bastion
    const keyName = (this.node.tryGetContext('bastionKeyName') as string | undefined)
      || process.env.BASTION_KEY_NAME
      || (isDev ? 'sample-app-dev-bastion' : undefined);
    const instanceTypeRaw = (this.node.tryGetContext('bastionInstanceType') as string | undefined) || process.env.BASTION_INSTANCE_TYPE || 't4g.nano';
    const hostedZoneId = (this.node.tryGetContext('bastionHostedZoneId') as string | undefined) || process.env.BASTION_HOSTED_ZONE_ID;
    const recordNameEnvSpecific = (this.node.tryGetContext(`bastionRecordName${environment.charAt(0).toUpperCase()}${environment.slice(1)}`) as string | undefined);
    const recordNameGeneric = (this.node.tryGetContext('bastionRecordName') as string | undefined) || process.env.BASTION_RECORD_NAME;
    const recordName = recordNameEnvSpecific || recordNameGeneric; // e.g., dev-bastion.example.com
    const manageDnsInStack = Boolean(hostedZoneId && recordName);

    // Security Group for bastion
    this.securityGroup = new ec2.SecurityGroup(this, `${project}-${environment}-bastion-sg`, {
      vpc,
      description: 'Bastion host SG (SSH in, allow outbound)',
      allowAllOutbound: true,
    });

    // SSH ingress: allow from anywhere per request (no IP restriction)
    this.securityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(22), 'SSH from anywhere');

    new ssm.StringParameter(this, `${project}-${environment}-bastion-sg-param`, {
      parameterName: bastionSecurityGroupIdParameterName(project, environment),
      stringValue: this.securityGroup.securityGroupId,
      description: 'Bastion security group ID exposed for cross-stack consumption.',
    });

    // Instance AMI/Type (default: Graviton nano)
    const instanceType = new ec2.InstanceType(instanceTypeRaw);
    const ami = instanceTypeRaw.startsWith('t4g') || instanceTypeRaw.includes('g.')
      ? ec2.MachineImage.latestAmazonLinux2023({ cpuType: ec2.AmazonLinuxCpuType.ARM_64 })
      : ec2.MachineImage.latestAmazonLinux2023({ cpuType: ec2.AmazonLinuxCpuType.X86_64 });

    // Place instance in public subnets and attach a static EIP for stable access
    this.instance = new ec2.Instance(this, `${project}-${environment}-bastion`, {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      instanceType,
      machineImage: ami,
      securityGroup: this.securityGroup,
      keyName: keyName, // Require a pre-created EC2 KeyPair to SSH
      ssmSessionPermissions: true, // Allow Session Manager (port forwarding etc.)
    });
    Tags.of(this.instance).add('Role', 'Bastion');


    // Persist SSH host key via Secrets Manager to avoid known_hosts churn
    const hostKeySecretName = `${project}-${environment}-bastion-ssh-hostkey`;
    // Grant the instance permission to Create/Get/Put the specific secret
    this.instance.role.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:CreateSecret', 'secretsmanager:GetSecretValue', 'secretsmanager:PutSecretValue'],
      resources: [
        `arn:aws:secretsmanager:${this.region}:${this.account}:secret:${hostKeySecretName}-*`,
      ],
    }));

    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      'set -euo pipefail',
      'AZ=$(curl -s http://169.254.169.254/latest/meta-data/placement/availability-zone || true)',
      'REGION=${AZ::-1}',
      `SECRET_ID=${hostKeySecretName}`,
      'if ! command -v aws >/dev/null 2>&1; then sudo dnf install -y awscli || true; fi',
      // Try fetch existing secret string (capture exit code)
      'EXISTING=$(aws secretsmanager get-secret-value --secret-id "$SECRET_ID" --query SecretString --output text --region "$REGION" 2>/dev/null || echo "__NO_SECRET__")',
      'mkdir -p /etc/ssh',
      // If not initialized, generate and store; otherwise restore
      'if [ "$EXISTING" = "__NO_SECRET__" ] || [ -z "$EXISTING" ] || [ "$EXISTING" = "None" ] || [ "$EXISTING" = "null" ]; then',
      '  echo "Generating new ed25519 host key and creating Secrets Manager secret"',
      '  ssh-keygen -t ed25519 -f /etc/ssh/ssh_host_ed25519_key -N "" -q',
      '  chmod 600 /etc/ssh/ssh_host_ed25519_key && chown root:root /etc/ssh/ssh_host_ed25519_key',
      '  KEY=$(cat /etc/ssh/ssh_host_ed25519_key)',
      '  # Try to create; if it already exists due to race, fall back to put-secret-value',
      '  if ! aws secretsmanager create-secret --name "$SECRET_ID" --secret-string "$KEY" --region "$REGION" >/dev/null 2>&1; then',
      '    aws secretsmanager put-secret-value --secret-id "$SECRET_ID" --secret-string "$KEY" --region "$REGION" >/dev/null || true',
      '  fi',
      'else',
      '  echo "Restoring ed25519 host key from Secrets Manager"',
      '  printf "%s" "$EXISTING" > /etc/ssh/ssh_host_ed25519_key',
      '  chmod 600 /etc/ssh/ssh_host_ed25519_key && chown root:root /etc/ssh/ssh_host_ed25519_key',
      '  ssh-keygen -y -f /etc/ssh/ssh_host_ed25519_key > /etc/ssh/ssh_host_ed25519_key.pub || true',
      'fi',
      // Ensure sshd picks up the key and reload
      'grep -q "HostKey /etc/ssh/ssh_host_ed25519_key" /etc/ssh/sshd_config || echo "HostKey /etc/ssh/ssh_host_ed25519_key" >> /etc/ssh/sshd_config',
      'systemctl restart sshd || systemctl reload sshd || true',
    );
    this.instance.addUserData(userData.render());

    const bastionEip = new ec2.CfnEIP(this, `${project}-${environment}-bastion-eip`, {
      domain: 'vpc',
      tags: [
        { key: 'Name', value: `${project}-${environment}-bastion-eip` },
        { key: 'Environment', value: environment },
        { key: 'Project', value: project },
      ],
    });
    new ec2.CfnEIPAssociation(this, `${project}-${environment}-bastion-eip-association`, {
      instanceId: this.instance.instanceId,
      allocationId: bastionEip.attrAllocationId,
    });

    if (manageDnsInStack && hostedZoneId && recordName) {
      new route53.CfnRecordSet(this, `${project}-${environment}-bastion-a-record`, {
        hostedZoneId,
        name: recordName,
        type: 'A',
        ttl: '300',
        resourceRecords: [bastionEip.attrPublicIp],
        comment: 'Managed by CDK for bastion host',
      });
    }

    new CfnOutput(this, `${project}-${environment}-bastion-id`, {
      value: this.instance.instanceId,
      exportName: `${project}-${environment}-bastion-id`,
    });
    new CfnOutput(this, `${project}-${environment}-bastion-public-ip`, {
      value: bastionEip.attrPublicIp,
      exportName: `${project}-${environment}-bastion-public-ip`,
    });
    new CfnOutput(this, `${project}-${environment}-bastion-public-dns`, {
      value: this.instance.instancePublicDnsName,
      exportName: `${project}-${environment}-bastion-public-dns`,
    });
    if (recordName) {
      new CfnOutput(this, `${project}-${environment}-bastion-record`, { value: recordName, exportName: `${project}-${environment}-bastion-record` });
    }
    new CfnOutput(this, `${project}-${environment}-bastion-sg-id`, {
      value: this.securityGroup.securityGroupId,
      exportName: `${project}-${environment}-bastion-sg-id`,
    });

    // Weekday start/stop schedule aligned with DEV RDS schedule (JST, holiday-aware on start)
    const retention = chooseRetention(config?.logsRetentionDays ?? 1);
    const ec2HoursFn = new lambdaNode.NodejsFunction(this, `${project}-${environment}-ec2-hours-fn`, {
      entry: 'lib/functions/ec2-business-hours/index.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_18_X,
      memorySize: 256,
      timeout: Duration.minutes(2),
      logRetention: retention,
      environment: {
        INSTANCE_ID: this.instance.instanceId,
        HOSTED_ZONE_ID: manageDnsInStack ? '' : (hostedZoneId ?? ''),
        RECORD_NAME: manageDnsInStack ? '' : (recordName ?? ''),
      },
    });
    ec2HoursFn.addToRolePolicy(new iam.PolicyStatement({ actions: ['ec2:StartInstances', 'ec2:StopInstances', 'ec2:DescribeInstances'], resources: ['*'] }));
    if (!manageDnsInStack && hostedZoneId && recordName) {
      ec2HoursFn.addToRolePolicy(new iam.PolicyStatement({ actions: ['route53:ChangeResourceRecordSets'], resources: [`arn:aws:route53:::hostedzone/${hostedZoneId}`] }));
      ec2HoursFn.addToRolePolicy(new iam.PolicyStatement({ actions: ['route53:ListResourceRecordSets'], resources: [`arn:aws:route53:::hostedzone/${hostedZoneId}`] }));
    }

    if (isDev) {
      const schedRole = new iam.Role(this, `${project}-${environment}-ec2-hours-scheduler-role`, {
        assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
      });
      schedRole.addToPolicy(new iam.PolicyStatement({ actions: ['lambda:InvokeFunction'], resources: [ec2HoursFn.functionArn] }));

      new scheduler.CfnSchedule(this, `${project}-${environment}-bastion-start-0830-jst`, {
        flexibleTimeWindow: { mode: 'OFF' },
        scheduleExpression: 'cron(30 8 ? * MON-FRI *)',
        scheduleExpressionTimezone: 'Asia/Tokyo',
        target: { arn: ec2HoursFn.functionArn, roleArn: schedRole.roleArn, input: JSON.stringify({ action: 'start' }) },
        description: 'Start bastion at 08:30 JST for DEV (holiday-aware)',
      });

      new scheduler.CfnSchedule(this, `${project}-${environment}-bastion-stop-1930-jst`, {
        flexibleTimeWindow: { mode: 'OFF' },
        scheduleExpression: 'cron(30 19 ? * MON-FRI *)',
        scheduleExpressionTimezone: 'Asia/Tokyo',
        target: { arn: ec2HoursFn.functionArn, roleArn: schedRole.roleArn, input: JSON.stringify({ action: 'stop' }) },
        description: 'Stop bastion at 19:30 JST for DEV',
      });
    }

    // Additionally, update DNS when the instance enters 'running' regardless of schedule
    new events.Rule(this, `${project}-${environment}-bastion-ec2-running`, {
      eventPattern: {
        source: ['aws.ec2'],
        detailType: ['EC2 Instance State-change Notification'],
        detail: {
          state: ['running'],
          'instance-id': [this.instance.instanceId],
        },
      },
      targets: [new eventsTargets.LambdaFunction(ec2HoursFn, {
        event: events.RuleTargetInput.fromObject({ action: 'start' }),
      })],
    });
  }
}

function chooseRetention(days: number): logs.RetentionDays {
  if (days <= 1) return logs.RetentionDays.ONE_DAY;
  if (days <= 7) return logs.RetentionDays.ONE_WEEK;
  if (days <= 14) return logs.RetentionDays.TWO_WEEKS;
  if (days <= 30) return logs.RetentionDays.ONE_MONTH;
  return logs.RetentionDays.ONE_MONTH;
}
