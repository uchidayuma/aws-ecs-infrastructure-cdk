import { Duration, RemovalPolicy, Stack, aws_ec2 as ec2, aws_iam as iam, aws_rds as rds, aws_secretsmanager as secrets, aws_lambda as lambda, aws_lambda_nodejs as lambdaNode, custom_resources as cr, CustomResource, aws_scheduler as scheduler, aws_logs as logs, aws_route53 as route53, aws_ssm as ssm } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { BaseStack, BaseStackProps } from '../shared/base-stack';
import { rdsDbName } from '../shared/naming';
import { getRdsInstanceAttributes, getSecretArnByName } from '../shared/rds-lookups';
import { rdsSecurityGroupIdParameterName, rdsEndpointAddressParameterName, rdsEndpointPortParameterName, rdsInstanceIdentifierParameterName, bastionSecurityGroupIdParameterName } from '../shared/parameter-names';

export interface RdsStackProps extends BaseStackProps {
  config: any;
  vpc: ec2.IVpc;
  ecsSecurityGroup: ec2.ISecurityGroup;
  allowBastionAccess?: boolean;
}

export class RdsStack extends BaseStack {
  public readonly dbSecret: secrets.ISecret;
  public readonly dbInstance: rds.IDatabaseInstance;
  public readonly appUserSecret: secrets.ISecret;
  public readonly readOnlyUserSecret: secrets.ISecret;

  constructor(scope: Construct, id: string, props: RdsStackProps) {
    super(scope, id, props);
    const { vpc, ecsSecurityGroup, project, environment, config, allowBastionAccess } = props;
    const isDev = environment === 'dev';
    const retention = chooseRetention(config.logsRetentionDays);
    // Allow explicit override to destroy RDS in non-dev (use with caution)
    const allowProdDestroy = (this.node.tryGetContext('allowProdRdsDestroy') as string | undefined)?.toLowerCase() === 'true'
      || (process.env.ALLOW_PROD_RDS_DESTROY || '').toLowerCase() === 'true';

    // Optional: use existing RDS instead of creating new
    const useExistingRaw = (this.node.tryGetContext('useExistingRds') as string | undefined) || process.env.USE_EXISTING_RDS;
    const useExisting = (useExistingRaw || '').toLowerCase() === 'true';
    const existingIdentifier = (this.node.tryGetContext('existingRdsIdentifier') as string | undefined)
      || process.env.EXISTING_RDS_IDENTIFIER
      || `${project}-${environment}-db`;

    const dbIdSuffix = (this.node.tryGetContext('dbIdentifierSuffix') as string | undefined) || process.env.DB_IDENTIFIER_SUFFIX;
    const dbIdentifierBase = `${project}-${environment}-db`;
    const dbIdentifier = dbIdSuffix ? `${dbIdentifierBase}-${dbIdSuffix}` : dbIdentifierBase;

    let rdsSg: ec2.SecurityGroup | undefined;
    let importedSgs: ec2.ISecurityGroup[] | undefined;
    if (!useExisting) {
      rdsSg = new ec2.SecurityGroup(this, `${project}-${environment}-rds-sg`, {
        vpc,
        description: 'RDS Security Group',
        allowAllOutbound: false,
      });
      rdsSg.addIngressRule(ecsSecurityGroup, ec2.Port.tcp(3306), 'MySQL from ECS');
      // Allow outbound to VPC CIDR for response packets (stateful connections)
      rdsSg.addEgressRule(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.allTraffic(), 'Allow responses within VPC');
    }

    if (useExisting) {
      const attrs = getRdsInstanceAttributes(this, existingIdentifier);
      const endpoint = (this.node.tryGetContext('existingRdsEndpoint') as string | undefined)
        || process.env.EXISTING_RDS_ENDPOINT
        || attrs?.endpoint;
      const port = Number((this.node.tryGetContext('existingRdsPort') as string | undefined)
        || process.env.EXISTING_RDS_PORT
        || attrs?.port
        || 3306);
      const sgIdsRaw = (this.node.tryGetContext('existingRdsSecurityGroupIds') as string | undefined)
        || process.env.EXISTING_RDS_SG_IDS
        || (attrs?.securityGroupIds?.join(',') || '');
      const sgIds = sgIdsRaw.split(',').map(s => s.trim()).filter(Boolean);
      importedSgs = sgIds.map((id, i) => ec2.SecurityGroup.fromSecurityGroupId(this, `${project}-${environment}-rds-import-sg-${i}`, id));

      if (!endpoint || !importedSgs?.length) {
        throw new Error('useExistingRds=true が指定されていますが、RDSのエンドポイントまたはSGが解決できませんでした。context で existingRdsEndpoint と existingRdsSecurityGroupIds を指定してください。');
      }

      this.dbInstance = rds.DatabaseInstance.fromDatabaseInstanceAttributes(this, `${project}-${environment}-db-ref`, {
        instanceIdentifier: existingIdentifier,
        instanceEndpointAddress: endpoint,
        port,
        securityGroups: importedSgs,
      });

      const existingSecretArn = (this.node.tryGetContext('existingMasterSecretArn') as string | undefined) || process.env.EXISTING_MASTER_SECRET_ARN;
      const existingSecretName = (this.node.tryGetContext('existingMasterSecretName') as string | undefined) || process.env.EXISTING_MASTER_SECRET_NAME;
      let masterSecretArn = existingSecretArn;
      if (!masterSecretArn) {
        const nameToUse = existingSecretName || `${project}-${environment}-db-credentials`;
        masterSecretArn = getSecretArnByName(this, nameToUse);
        if (!masterSecretArn) {
          throw new Error('useExistingRds=true ですが、DBの管理者シークレットが見つかりません。-c existingMasterSecretArn=... もしくは -c existingMasterSecretName=... を指定してください。');
        }
      }
      this.dbSecret = secrets.Secret.fromSecretCompleteArn(this, `${project}-${environment}-db-credentials`, masterSecretArn);

      // Ensure ECS can reach DB
      this.dbInstance.connections.allowFrom(ecsSecurityGroup, ec2.Port.tcp(3306), 'MySQL from ECS');

      // Note: Bastion access (if desired) is handled in BastionStack via direct
      // reference to this rdsInstance to avoid cross-stack exports/imports.
    } else {
      // Credentials secret (admin): import if exists; otherwise create
      const adminSecretName = `${project}-${environment}-db-credentials`;
      const adminSecretArn = getSecretArnByName(this, adminSecretName);
      if (adminSecretArn) {
        this.dbSecret = secrets.Secret.fromSecretCompleteArn(this, `${project}-${environment}-db-credentials`, adminSecretArn);
      } else {
        const dbSecret = new rds.DatabaseSecret(this, `${project}-${environment}-db-credentials`, {
          secretName: adminSecretName,
          username: 'admin',
        });
        this.dbSecret = dbSecret;
      }

      const parameterGroup = new rds.ParameterGroup(this, `${project}-${environment}-mysql8-params`, {
        engine: rds.DatabaseInstanceEngine.mysql({ version: rds.MysqlEngineVersion.VER_8_0 }),
        parameters: {
          character_set_server: 'utf8mb4',
          collation_server: 'utf8mb4_unicode_ci',
        },
      });

      this.dbInstance = new rds.DatabaseInstance(this, `${project}-${environment}-db`, {
        engine: rds.DatabaseInstanceEngine.mysql({ version: rds.MysqlEngineVersion.VER_8_0 }),
        instanceIdentifier: dbIdentifier,
        vpc,
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
        securityGroups: [rdsSg!],
        multiAz: config.rds.multiAz,
        allocatedStorage: 20,
        storageType: rds.StorageType.GP3,
        instanceType: new ec2.InstanceType(config.rds.instanceClass),
        credentials: rds.Credentials.fromSecret(this.dbSecret as secrets.ISecret),
        databaseName: rdsDbName(project, environment),
        backupRetention: Duration.days(isDev ? 0 : config.rds.backupRetentionDays),
        parameterGroup,
        deletionProtection: isDev ? false : !allowProdDestroy,
        removalPolicy: (isDev || allowProdDestroy) ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN,
        publiclyAccessible: false,
        cloudwatchLogsExports: ['error'],
      });
    }

    if (allowBastionAccess) {
      const bastionSgParamName = bastionSecurityGroupIdParameterName(project, environment);
      const bastionSgId = ssm.StringParameter.valueForStringParameter(this, bastionSgParamName);
      const bastionSg = ec2.SecurityGroup.fromSecurityGroupId(this, `${project}-${environment}-bastion-sg-import`, bastionSgId);
      this.dbInstance.connections.allowFrom(bastionSg, ec2.Port.tcp(3306), 'MySQL from bastion');
    }

    // Secrets rotation: enable in non-dev by default (ap-northeast-1 supports SAR)
    const currentRegion = Stack.of(this).region;
    const enableRotationCtx = (this.node.tryGetContext('enableSecretRotation') as string | undefined)?.toLowerCase();
    const enableRotation = !isDev && (enableRotationCtx ? enableRotationCtx === 'true' : true);
    if (enableRotation && !useExisting) {
      (this.dbInstance as rds.DatabaseInstance).addRotationSingleUser({ automaticallyAfter: Duration.days(30) });
    }

    // Application users secrets (passwords pre-generated)
    // Import if they already exist; otherwise create new
    const appUserName = `${project}-${environment}-db-appuser`;
    const appUserArn = getSecretArnByName(this, appUserName);
    if (appUserArn) {
      this.appUserSecret = secrets.Secret.fromSecretCompleteArn(this, `${project}-${environment}-db-appuser`, appUserArn);
    } else {
      this.appUserSecret = new secrets.Secret(this, `${project}-${environment}-db-appuser`, {
        secretName: appUserName,
        generateSecretString: { secretStringTemplate: JSON.stringify({ username: 'appuser' }), generateStringKey: 'password' },
      });
    }

    const roUserName = `${project}-${environment}-db-readonlyuser`;
    const roUserArn = getSecretArnByName(this, roUserName);
    if (roUserArn) {
      this.readOnlyUserSecret = secrets.Secret.fromSecretCompleteArn(this, `${project}-${environment}-db-readonlyuser`, roUserArn);
    } else {
      this.readOnlyUserSecret = new secrets.Secret(this, `${project}-${environment}-db-readonlyuser`, {
        secretName: roUserName,
        generateSecretString: { secretStringTemplate: JSON.stringify({ username: 'readonlyuser' }), generateStringKey: 'password' },
      });
    }

    // Lambda SG for DB init
    const dbInitSg = new ec2.SecurityGroup(this, `${project}-${environment}-dbinit-sg`, { vpc, description: 'DB init Lambda SG', allowAllOutbound: true });
    // Allow Lambda to connect to RDS (created or existing)
    if (rdsSg) {
      rdsSg.addIngressRule(dbInitSg, ec2.Port.tcp(3306), 'MySQL from DB init Lambda');
    } else if (importedSgs && importedSgs.length > 0) {
      for (const [i, sg] of importedSgs.entries()) {
        // addIngressRule on imported SGs will create a CfnSecurityGroupIngress targeting the SG id
        sg.addIngressRule(dbInitSg, ec2.Port.tcp(3306), `MySQL from DB init Lambda (${i})`);
      }
    }

    // DB init Lambda to create users and grants (also run for existing instance)
    {
      const dbName = rdsDbName(project, environment);
      const dbInitFn = new lambdaNode.NodejsFunction(this, `${project}-${environment}-db-init-fn`, {
        entry: 'lib/functions/db-init/index.ts',
        handler: 'handler',
        runtime: lambda.Runtime.NODEJS_18_X,
        memorySize: 256,
        timeout: Duration.minutes(5),
        vpc,
        securityGroups: [dbInitSg],
        logRetention: retention,
        // In DEV, run in isolated subnets and use VPC endpoints (no NAT)
        vpcSubnets: isDev ? { subnetType: ec2.SubnetType.PRIVATE_ISOLATED } : { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        environment: {
          DB_HOST: this.dbInstance.instanceEndpoint.hostname,
          DB_PORT: this.dbInstance.instanceEndpoint.port.toString(),
          DB_NAME: dbName,
          MASTER_SECRET_ARN: this.dbSecret.secretArn,
          APPUSER_SECRET_ARN: this.appUserSecret.secretArn,
          READONLY_SECRET_ARN: this.readOnlyUserSecret.secretArn,
        },
      });
      // Allow Lambda to read secrets
      this.dbSecret.grantRead(dbInitFn);
      this.appUserSecret.grantRead(dbInitFn);
      this.readOnlyUserSecret.grantRead(dbInitFn);

      // Custom resource to invoke init on stack creation/update
      const provider = new cr.Provider(this, `${project}-${environment}-dbinit-provider`, {
        onEventHandler: dbInitFn,
      });
      const initResource = new CustomResource(this, `${project}-${environment}-dbinit`, {
        serviceToken: provider.serviceToken,
        properties: { ResourceVersion: '1.0.0' },
      });
      initResource.node.addDependency(this.dbInstance);
    }

    const rdsSecurityGroupIds = (rdsSg
      ? [rdsSg.securityGroupId]
      : importedSgs?.map((sg) => sg.securityGroupId) ?? []);
    if (rdsSecurityGroupIds.length > 0) {
      this.upsertSsmParameter(`${project}-${environment}-rds-primary-sg`, rdsSecurityGroupIdParameterName(project, environment), rdsSecurityGroupIds[0], 'Primary RDS security group ID exposed for cross-stack consumption.');
    }

    this.upsertSsmParameter(`${project}-${environment}-rds-endpoint-address`, rdsEndpointAddressParameterName(project, environment), this.dbInstance.instanceEndpoint.hostname, 'RDS endpoint address exposed for cross-stack consumption.');
    this.upsertSsmParameter(`${project}-${environment}-rds-endpoint-port`, rdsEndpointPortParameterName(project, environment), this.dbInstance.instanceEndpoint.port.toString(), 'RDS endpoint port exposed for cross-stack consumption.');
    this.upsertSsmParameter(`${project}-${environment}-rds-instance-identifier`, rdsInstanceIdentifierParameterName(project, environment), this.dbInstance.instanceIdentifier, 'RDS instance identifier exposed for cross-stack consumption.');

    // In DEV, schedule RDS start/stop at business hours using EventBridge Scheduler (JST timezone), holiday-aware via Lambda
    if (isDev) {
      const rdsHoursFn = new lambdaNode.NodejsFunction(this, `${project}-${environment}-rds-hours-fn`, {
        entry: 'lib/functions/rds-business-hours/index.ts',
        handler: 'handler',
        runtime: lambda.Runtime.NODEJS_18_X,
        memorySize: 256,
        timeout: Duration.minutes(2),
        logRetention: retention,
        environment: {
          DB_INSTANCE_IDENTIFIER: this.dbInstance.instanceIdentifier,
        },
        // Note: Do not associate VPC so it can call public AWS APIs without NAT in DEV
      });
      // Allow Lambda to start/stop the specific DB
      rdsHoursFn.addToRolePolicy(new iam.PolicyStatement({
        actions: ['rds:StartDBInstance', 'rds:StopDBInstance'],
        resources: [this.dbInstance.instanceArn],
      }));

      const schedRole = new iam.Role(this, `${project}-${environment}-rds-hours-scheduler-role`, {
        assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
      });
      schedRole.addToPolicy(new iam.PolicyStatement({ actions: ['lambda:InvokeFunction'], resources: [rdsHoursFn.functionArn] }));

      new scheduler.CfnSchedule(this, `${project}-${environment}-rds-start-0830-jst`, {
        flexibleTimeWindow: { mode: 'OFF' },
        scheduleExpression: 'cron(30 8 ? * MON-FRI *)',
        scheduleExpressionTimezone: 'Asia/Tokyo',
        target: {
          arn: rdsHoursFn.functionArn,
          roleArn: schedRole.roleArn,
          input: JSON.stringify({ action: 'start' }),
        },
        description: 'Start RDS at 08:30 JST for DEV (holiday-aware)',
      });

      new scheduler.CfnSchedule(this, `${project}-${environment}-rds-stop-1930-jst`, {
        flexibleTimeWindow: { mode: 'OFF' },
        scheduleExpression: 'cron(30 19 ? * MON-FRI *)',
        scheduleExpressionTimezone: 'Asia/Tokyo',
        target: {
          arn: rdsHoursFn.functionArn,
          roleArn: schedRole.roleArn,
          input: JSON.stringify({ action: 'stop' }),
        },
        description: 'Stop RDS at 19:30 JST for DEV',
      });

      // Adjust CloudWatch Logs retention for RDS error logs (DEV -> 1 day)
      new logs.LogRetention(this, `${project}-${environment}-rds-error-log-retention`, {
        logGroupName: `/aws/rds/instance/${this.dbInstance.instanceIdentifier}/error`,
        retention,
      });
    }

    // Optional: Stable DNS alias to the current RDS endpoint (CNAME)
    // Use when you want a fixed hostname across instance replacements.
    const dbHostedZoneId = this.node.tryGetContext('dbHostedZoneId') as string | undefined;
    const dbHostedZoneName = this.node.tryGetContext('dbHostedZoneName') as string | undefined; // e.g., example.com
    const dbRecordName = this.node.tryGetContext('dbRecordName') as string | undefined; // e.g., dev-db.example.com
    if (dbHostedZoneId && dbHostedZoneName && dbRecordName) {
      const zone = route53.HostedZone.fromHostedZoneAttributes(this, `${project}-${environment}-db-zone`, {
        hostedZoneId: dbHostedZoneId,
        zoneName: dbHostedZoneName,
      });
      new route53.CnameRecord(this, `${project}-${environment}-db-alias`, {
        zone,
        recordName: dbRecordName,
        domainName: this.dbInstance.instanceEndpoint.hostname,
        ttl: Duration.minutes(1),
        comment: 'Alias to current RDS instance endpoint',
      });
    }
  }

  private upsertSsmParameter(id: string, name: string, value: string, description: string): void {
    const stack = Stack.of(this);
    const parameterArn = `arn:aws:ssm:${stack.region}:${stack.account}:parameter${name}`;
    new cr.AwsCustomResource(this, id, {
      onCreate: {
        service: 'SSM',
        action: 'putParameter',
        parameters: { Name: name, Value: value, Type: 'String', Description: description, Overwrite: true },
        physicalResourceId: cr.PhysicalResourceId.of(`${id}-resource`),
      },
      onUpdate: {
        service: 'SSM',
        action: 'putParameter',
        parameters: { Name: name, Value: value, Type: 'String', Description: description, Overwrite: true },
        physicalResourceId: cr.PhysicalResourceId.of(`${id}-resource`),
      },
      onDelete: {
        service: 'SSM',
        action: 'deleteParameter',
        parameters: { Name: name },
        physicalResourceId: cr.PhysicalResourceId.of(`${id}-resource`),
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['ssm:PutParameter', 'ssm:DeleteParameter'],
          resources: [parameterArn],
        }),
      ]),
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
