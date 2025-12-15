import {
  Duration,
  Stack,
  aws_ec2 as ec2,
  aws_ecs as ecs,
  aws_ecs_patterns as ecsPatterns,
  aws_elasticloadbalancingv2 as elbv2,
  aws_iam as iam,
  aws_logs as logs,
  aws_s3 as s3,
  aws_secretsmanager as secrets,
  aws_certificatemanager as acm,
  aws_ecr as ecr,
  aws_applicationautoscaling as appscaling,
  aws_lambda as lambda,
  aws_lambda_nodejs as lambdaNode,
  aws_iam as iam2,
  aws_scheduler as scheduler,
  aws_ssm as ssm,
  aws_secretsmanager as secretsMgr,
  aws_route53 as route53,
  custom_resources as cr,
  CustomResource,
} from 'aws-cdk-lib';
import { aws_route53_targets as route53Targets } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { BaseStack, BaseStackProps } from '../shared/base-stack';
import { rdsDbName } from '../shared/naming';
import {
  rdsEndpointAddressParameterName,
  rdsEndpointPortParameterName,
  ecsClusterNameParameterName,
  ecsBackendServiceNameParameterName,
  ecsFrontendServiceNameParameterName,
  ecsJobServiceNameParameterName,
  albFullNameParameterName,
} from '../shared/parameter-names';
import { logGroupExists } from '../shared/lookups';

export interface EcsStackProps extends BaseStackProps {
  config: any;
  vpc: ec2.IVpc;
  albSecurityGroup: ec2.ISecurityGroup;
  ecsSecurityGroup: ec2.ISecurityGroup;
  bucket: s3.IBucket;
  dbSecret: secrets.ISecret; // admin (kept for ops)
  appUserSecret?: secrets.ISecret; // preferred for app
  backendRepo?: ecr.IRepository;
  frontendRepo?: ecr.IRepository;
}

export class EcsStack extends BaseStack {
  public readonly alb: elbv2.ApplicationLoadBalancer;
  public readonly backendService: ecs.FargateService;
  public readonly jobService: ecs.FargateService;
  public readonly frontendService: ecs.FargateService;
  public readonly backendTg: elbv2.ApplicationTargetGroup;
  public readonly frontendTg: elbv2.ApplicationTargetGroup;
  public readonly migrationTaskDef?: ecs.FargateTaskDefinition;

  constructor(scope: Construct, id: string, props: EcsStackProps) {
    super(scope, id, props);
    const { vpc, albSecurityGroup, ecsSecurityGroup, project, environment, config, dbSecret, appUserSecret, bucket, backendRepo, frontendRepo } = props;

    const isDev = environment === 'dev';
    const cluster = new ecs.Cluster(this, `${project}-${environment}-cluster`, {
      vpc,
      clusterName: `${project}-${environment}-cluster`,
      // Disable Container Insights in dev to save CW metrics cost
      containerInsights: !isDev,
      enableFargateCapacityProviders: true,
    });

    // In DEV, keep ECS tasks in one public subnet to reduce cost,
    // but ALB must span at least two AZs, so keep default public subnet selection for ALB.
    const devPublicSubnet = isDev ? vpc.selectSubnets({ subnetType: ec2.SubnetType.PUBLIC }).subnets[0] : undefined;
    const albSubnetSelection: ec2.SubnetSelection = { subnetType: ec2.SubnetType.PUBLIC };

    // Shared ALB
    this.alb = new elbv2.ApplicationLoadBalancer(this, `${project}-${environment}-alb`, {
      vpc,
      internetFacing: true,
      securityGroup: albSecurityGroup,
      loadBalancerName: `${project}-${environment}-alb`,
      vpcSubnets: albSubnetSelection,
    });
    const httpListener = this.alb.addListener('HttpListener', { port: 80, open: true });
    // Always enable HTTPS (443). Resolve certificate ARN from:
    // 1) CDK context `certArn`, 2) env var CERT_ARN, 3) SSM parameter (default path below).
    const certArnCtx = this.node.tryGetContext('certArn') as string | undefined;
    const certArnEnv = process.env.CERT_ARN;
    const certIdCtx = this.node.tryGetContext('certId') as string | undefined;
    const certIdEnv = process.env.CERT_ID;
    const certArnDevCtx = this.node.tryGetContext('certArnDev') as string | undefined;
    const certArnProdCtx = this.node.tryGetContext('certArnProd') as string | undefined;
    const certIdDevCtx = this.node.tryGetContext('certIdDev') as string | undefined;
    const certIdProdCtx = this.node.tryGetContext('certIdProd') as string | undefined;
    const envSpecificCertArn = environment === 'prod' ? certArnProdCtx : (environment === 'dev' ? certArnDevCtx : undefined);
    const envSpecificCertId = environment === 'prod' ? certIdProdCtx : (environment === 'dev' ? certIdDevCtx : undefined);
    const certArnParamPath = (this.node.tryGetContext('certArnParam') as string | undefined) || `/sample-app/${environment}/acm/cert-arn`;
    let certArn = certArnCtx ?? certArnEnv ?? envSpecificCertArn;
    if (!certArn) {
      const certId = certIdCtx ?? certIdEnv ?? envSpecificCertId;
      if (certId) {
        certArn = `arn:aws:acm:${this.region}:${this.account}:certificate/${certId}`;
      } else {
        // Fallback to SSM parameter which must contain a full ARN
        certArn = ssm.StringParameter.valueForStringParameter(this, certArnParamPath);
      }
    }
    const cert = acm.Certificate.fromCertificateArn(this, `${project}-${environment}-cert`, certArn);
    const httpsListener = this.alb.addListener('HttpsListener', { port: 443, certificates: [cert], open: true });

    // Logs
    const retention = chooseRetention(config.logsRetentionDays);
    let backendLogGroup: logs.ILogGroup;
    let frontendLogGroup: logs.ILogGroup;
    let jobLogGroup: logs.ILogGroup;
    if (isDev) {
      // Ensure log groups exist (create-if-not-exists) and set retention via custom resource
      new logs.LogRetention(this, `${project}-${environment}-backend-log-retention`, {
        logGroupName: `/ecs/${project}-${environment}/backend`,
        retention,
      });
      new logs.LogRetention(this, `${project}-${environment}-frontend-log-retention`, {
        logGroupName: `/ecs/${project}-${environment}/frontend`,
        retention,
      });
      new logs.LogRetention(this, `${project}-${environment}-job-log-retention`, {
        logGroupName: `/ecs/${project}-${environment}/jobs`,
        retention,
      });
      backendLogGroup = logs.LogGroup.fromLogGroupName(this, `${project}-${environment}-backend-logs`, `/ecs/${project}-${environment}/backend`);
      frontendLogGroup = logs.LogGroup.fromLogGroupName(this, `${project}-${environment}-frontend-logs`, `/ecs/${project}-${environment}/frontend`);
      jobLogGroup = logs.LogGroup.fromLogGroupName(this, `${project}-${environment}-job-logs`, `/ecs/${project}-${environment}/jobs`);
    } else {
      const backendLogName = `/ecs/${project}-${environment}/backend`;
      const frontendLogName = `/ecs/${project}-${environment}/frontend`;
      const jobLogName = `/ecs/${project}-${environment}/jobs`;
      backendLogGroup = logGroupExists(this, backendLogName)
        ? logs.LogGroup.fromLogGroupName(this, `${project}-${environment}-backend-logs`, backendLogName)
        : new logs.LogGroup(this, `${project}-${environment}-backend-logs`, { logGroupName: backendLogName, retention });
      frontendLogGroup = logGroupExists(this, frontendLogName)
        ? logs.LogGroup.fromLogGroupName(this, `${project}-${environment}-frontend-logs`, frontendLogName)
        : new logs.LogGroup(this, `${project}-${environment}-frontend-logs`, { logGroupName: frontendLogName, retention });
      jobLogGroup = logGroupExists(this, jobLogName)
        ? logs.LogGroup.fromLogGroupName(this, `${project}-${environment}-job-logs`, jobLogName)
        : new logs.LogGroup(this, `${project}-${environment}-job-logs`, { logGroupName: jobLogName, retention });
    }

    // Task roles
    const taskRole = new iam.Role(this, `${project}-${environment}-task-role`, {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    bucket.grantReadWrite(taskRole);
    dbSecret.grantRead(taskRole);
    const externalApiKeys = secrets.Secret.fromSecretNameV2(this, `${project}-${environment}-external-api-keys`, `${project}-${environment}-external-api-keys`);
    externalApiKeys.grantRead(taskRole);
    // Allow application to send emails via SES APIs (v1 RawEmail and v2 SendEmail)
    taskRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ses:SendRawEmail', 'ses:SendEmail'],
      resources: ['*'],
    }));

    // JWT secret for signing access tokens (stored in Secrets Manager)
    const jwtSecret = new secretsMgr.Secret(this, `${project}-${environment}-jwt-secret`, {
      secretName: `${project}-${environment}-jwt-secret`,
      generateSecretString: { secretStringTemplate: JSON.stringify({}), generateStringKey: 'JWT_SECRET_KEY' },
    });

    // App config via SSM Parameter Store (non-secret)
    const sesFromParam = new ssm.StringParameter(this, `${project}-${environment}-ses-from-address`, {
      parameterName: `/sample-app/${environment}/ses/from-address`,
      stringValue: 'noreply@example.com',
    });
    const sesSenderNameParam = new ssm.StringParameter(this, `${project}-${environment}-ses-sender-name`, {
      parameterName: `/sample-app/${environment}/ses/sender-name`,
      stringValue: 'Sample App',
    });
    const mailReplyToParam = new ssm.StringParameter(this, `${project}-${environment}-mail-reply-to`, {
      parameterName: `/sample-app/${environment}/mail/reply-to`,
      stringValue: 'support@example.com',
    });

    // Execution role gets typical ECR/Logs permissions automatically from pattern constructs

    // Backend service (Flask)
    const backendTaskDef = new ecs.FargateTaskDefinition(this, `${project}-${environment}-backend-taskdef`, {
      family: `${project}-${environment}-backend`,
      cpu: config.ecs.backend.cpu,
      memoryLimitMiB: config.ecs.backend.memoryMiB,
      // Unify on x86_64 across environments to match build process
      runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.X86_64 },
      taskRole,
    });
    const dbName = rdsDbName(project, environment);
    // Allow overriding image tags via context/env to avoid brittle latest-digest pinning
    const backendTagCtx = this.node.tryGetContext('backendTag') as string | undefined;
    const frontendTagCtx = this.node.tryGetContext('frontendTag') as string | undefined;
    const backendTag = backendTagCtx || process.env.BACKEND_TAG || 'latest';
    const frontendTag = frontendTagCtx || process.env.FRONTEND_TAG || 'latest';

    const backendImage = backendRepo
      ? ecs.ContainerImage.fromEcrRepository(backendRepo, backendTag)
      : ecs.ContainerImage.fromRegistry(`${this.account}.dkr.ecr.${this.region}.amazonaws.com/${project}-${environment}/backend:${backendTag}`);

    // SES も ap-northeast-1 を使用（必要に応じて -c sesRegion=... で上書き可）
    const sesRegionCtx = this.node.tryGetContext('sesRegion') as string | undefined;
    const sesRegion = sesRegionCtx || this.region;

    const dbUserKey = (this.node.tryGetContext('dbUsernameKey') as string | undefined) || process.env.DB_USERNAME_KEY || 'username';
    const dbPassKey = (this.node.tryGetContext('dbPasswordKey') as string | undefined) || process.env.DB_PASSWORD_KEY || 'password';

    const rdsEndpointParam = ssm.StringParameter.fromStringParameterName(this, `${project}-${environment}-rds-endpoint-param`, rdsEndpointAddressParameterName(project, environment));
    const rdsPortParam = ssm.StringParameter.fromStringParameterName(this, `${project}-${environment}-rds-port-param`, rdsEndpointPortParameterName(project, environment));

    // WebAuthn settings from SSM Parameter Store
    // These parameters must be created manually using the manage-webauthn-params.sh script
    // or via AWS CLI before deploying this stack
    const webauthnRpIdParam = ssm.StringParameter.fromStringParameterName(
      this,
      `${project}-${environment}-webauthn-rp-id`,
      `/sample-app/${environment}/webauthn/rp-id`
    );
    const webauthnOriginParam = ssm.StringParameter.fromStringParameterName(
      this,
      `${project}-${environment}-webauthn-origin`,
      `/sample-app/${environment}/webauthn/origin`
    );
    const webauthnStrictVerifyParam = ssm.StringParameter.fromStringParameterName(
      this,
      `${project}-${environment}-webauthn-strict-verify`,
      `/sample-app/${environment}/webauthn/strict-verify`
    );

    const sharedAppEnvironment = {
      DB_HOST: rdsEndpointParam.stringValue,
      DB_PORT: rdsPortParam.stringValue,
      DB_NAME: dbName,
      PYTHONPATH: '/app',
      // App default AWS region (S3 and most services)
      AWS_REGION: this.region,
      // Explicit SES region for email sending
      SES_REGION: sesRegion,
      // Enable APScheduler email queue worker in Flask app
      ENABLE_SES_EMAIL_JOB: 'true',
      // Background job feature flags (mirror backend .env defaults)
      ENABLE_BEDS24_JOB: 'true',
      ENABLE_TEMAIRAZU_JOB: 'true',
      ENABLE_NEPPAN_JOB: 'true',
      ENABLE_WAITING_SMS_JOB: 'true',
      ENABLE_CHECK_SMS_JOB: 'true',
      ENABLE_DAILY_EMAILS_JOB: 'true',
      DAILY_EMAILS_DEDUPE: 'true',
      ENABLE_AUTO_CHECKOUT_JOB: 'true',
      // S3 settings for backend uploads
      S3_BUCKET_NAME: bucket.bucketName,
      S3_FORCE_PATH_STYLE: 'false',
      // Keep frontend Nginx proxy path scheme
      MINIO_PATH: 'S3_URL',
      // Optional explicit S3 region (backend prefers S3_REGION if set)
      S3_REGION: this.region,
      PORT: '5000',
      // DATABASE_URL is templated and resolved in app.config via Python's Template against process env
      // Secrets for username/password are provided below and substituted at runtime
      DATABASE_URL: 'mysql+pymysql://${DB_USERNAME}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}?charset=utf8mb4',
      APP_ENV: environment,
      // WebAuthn settings from SSM Parameter Store
      WEBAUTHN_RP_ID: webauthnRpIdParam.stringValue,
      WEBAUTHN_ORIGIN: webauthnOriginParam.stringValue,
      STRICT_WEBAUTHN_VERIFY: webauthnStrictVerifyParam.stringValue,
    };

    const sharedAppSecrets = {
      DB_USERNAME: ecs.Secret.fromSecretsManager(appUserSecret ?? dbSecret, dbUserKey),
      DB_PASSWORD: ecs.Secret.fromSecretsManager(appUserSecret ?? dbSecret, dbPassKey),
      SES_FROM_ADDRESS: ecs.Secret.fromSsmParameter(sesFromParam),
      SES_SENDER_NAME: ecs.Secret.fromSsmParameter(sesSenderNameParam),
      MAIL_REPLY_TO_ADDRESS: ecs.Secret.fromSsmParameter(mailReplyToParam),
      JWT_SECRET_KEY: ecs.Secret.fromSecretsManager(jwtSecret, 'JWT_SECRET_KEY'),
    };

    backendTaskDef.addContainer('flask', {
      containerName: 'flask',
      image: backendImage,
      logging: ecs.LogDriver.awsLogs({ streamPrefix: 'ecs', logGroup: backendLogGroup }),
      portMappings: [{ containerPort: 5000 }],
      environment: { ...sharedAppEnvironment, ENABLE_SCHEDULER: 'false' },
      secrets: sharedAppSecrets,
      cpu: config.ecs.backend.cpu,
      memoryLimitMiB: config.ecs.backend.memoryMiB,
      essential: true,
    });

    this.backendService = new ecs.FargateService(this, `${project}-${environment}-backend-svc`, {
      cluster,
      serviceName: `${project}-${environment}-backend-svc`,
      taskDefinition: backendTaskDef,
      desiredCount: config.ecs.backend.desiredCount,
      securityGroups: [ecsSecurityGroup],
      circuitBreaker: { rollback: true },
      enableExecuteCommand: true,
      assignPublicIp: isDev ? true : false,
      // Keep at least 1 running task during rolling updates to avoid brief downtime
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      healthCheckGracePeriod: Duration.seconds(config.ecs.healthCheckGraceSeconds.backend),
      vpcSubnets: isDev && devPublicSubnet ? { subnets: [devPublicSubnet] } : { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      // Use Fargate Spot in dev for cheaper compute
      capacityProviderStrategies: isDev
        ? [{ capacityProvider: 'FARGATE_SPOT', weight: 1 }]
        : [{ capacityProvider: 'FARGATE', weight: 1 }],
    });

    const jobTaskDef = new ecs.FargateTaskDefinition(this, `${project}-${environment}-job-taskdef`, {
      family: `${project}-${environment}-job`,
      cpu: config.ecs.jobs.cpu,
      memoryLimitMiB: config.ecs.jobs.memoryMiB,
      runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.X86_64 },
      taskRole,
    });

    const jobWorkerCommand = [
      'python',
      '-c',
      [
        'import importlib',
        'import os',
        'import signal',
        'import time',
        'import sys',
        '',
        'if "/app" not in sys.path:',
        '    sys.path.insert(0, "/app")',
        'os.environ.setdefault("PYTHONPATH", "/app")',
        '',
        'try:',
        '    import importlib.util',
        '    worker_spec = importlib.util.find_spec("app.jobs.worker")',
        'except Exception:',
        '    worker_spec = None',
        '',
        'if worker_spec is not None:',
        '    module = importlib.import_module("app.jobs.worker")',
        '    module.main()',
        'else:',
        '    from app import create_app',
        '    from app.extensions import scheduler',
        '    try:',
        '        from app.jobs import scheduler_jobs',
        '    except Exception:',
        '        scheduler_jobs = None',
        '',
        '    _shutdown = False',
        '',
        '    def _handle_signal(signum, frame):',
        '        global _shutdown',
        '        _shutdown = True',
        '',
        '    app = create_app()',
        '    logger = app.logger',
        '    logger.info("Background job worker started (fallback path).")',
        '',
        '    signal.signal(signal.SIGTERM, _handle_signal)',
        '    signal.signal(signal.SIGINT, _handle_signal)',
        '',
        '    if getattr(scheduler, "state", 0) != 1:',
        '        try:',
        '            scheduler.init_app(app)',
        '            if scheduler_jobs is not None:',
        '                scheduler_jobs(scheduler, app)',
        '            scheduler.start()',
        '            logger.info("Scheduler initialized by fallback bootstrap.")',
        '        except Exception as exc:',
        '            logger.error("Failed to initialize scheduler in fallback bootstrap: %s", exc)',
        '    else:',
        '        logger.info("Scheduler already running (state=%s).", getattr(scheduler, "state", "unknown"))',
        '',
        '    try:',
        '        while not _shutdown:',
        '            time.sleep(1)',
        '    finally:',
        '        logger.info("Background job worker stopping; shutting down scheduler.")',
        '        try:',
        '            scheduler.shutdown(wait=False)',
        '        except Exception as exc:',
        '            logger.error("Failed to shut down scheduler cleanly: %s", exc)',
      ].join('\n'),
    ];

    jobTaskDef.addContainer('worker', {
      containerName: 'worker',
      image: backendImage,
      logging: ecs.LogDriver.awsLogs({ streamPrefix: 'jobs', logGroup: jobLogGroup }),
      command: jobWorkerCommand,
      environment: { ...sharedAppEnvironment, ENABLE_SCHEDULER: 'true' },
      secrets: sharedAppSecrets,
      cpu: config.ecs.jobs.cpu,
      memoryLimitMiB: config.ecs.jobs.memoryMiB,
      essential: true,
    });

    this.jobService = new ecs.FargateService(this, `${project}-${environment}-job-svc`, {
      cluster,
      serviceName: `${project}-${environment}-job-svc`,
      taskDefinition: jobTaskDef,
      desiredCount: config.ecs.jobs.desiredCount,
      securityGroups: [ecsSecurityGroup],
      circuitBreaker: { rollback: true },
      enableExecuteCommand: true,
      assignPublicIp: isDev ? true : false,
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      vpcSubnets: isDev && devPublicSubnet ? { subnets: [devPublicSubnet] } : { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      capacityProviderStrategies: [{ capacityProvider: 'FARGATE', weight: 1 }],
    });

    // Migration task definition (for running database migrations)
    // This task is not a service - it's run on-demand via ECS RunTask
    // IMPORTANT: Only create migration task definition for DEV environment
    // For production, run migrations manually via ECS Exec to avoid accidental schema changes
    if (isDev) {
      this.migrationTaskDef = new ecs.FargateTaskDefinition(this, `${project}-${environment}-migration-taskdef`, {
        family: `${project}-${environment}-migration`,
        cpu: 256, // Small CPU is sufficient for migrations
        memoryLimitMiB: 512,
        runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.X86_64 },
        taskRole,
      });

      this.migrationTaskDef.addContainer('migrate', {
        containerName: 'migrate',
        image: backendImage, // Same image as backend
        logging: ecs.LogDriver.awsLogs({ streamPrefix: 'migration', logGroup: backendLogGroup }),
        command: ['sh', 'scripts/migrate.sh'], // Run migration script
        environment: {
          DB_HOST: rdsEndpointParam.stringValue,
          DB_PORT: rdsPortParam.stringValue,
          DB_NAME: dbName,
          AWS_REGION: this.region,
          // DATABASE_URL is templated and resolved in migrate.sh via Python
          DATABASE_URL: 'mysql+pymysql://${DB_USERNAME}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}?charset=utf8mb4',
        },
        secrets: {
          DB_USERNAME: ecs.Secret.fromSecretsManager(appUserSecret ?? dbSecret, dbUserKey),
          DB_PASSWORD: ecs.Secret.fromSecretsManager(appUserSecret ?? dbSecret, dbPassKey),
        },
        cpu: 256,
        memoryLimitMiB: 512,
        essential: true,
      });
    }
    // For production: Run migrations manually using ECS Exec into the backend service:
    // aws ecs execute-command --cluster sample-app-prod-cluster \
    //   --task <task-id> --container flask \
    //   --interactive --command "sh -lc 'sh scripts/migrate.sh'" \
    //   --region ap-northeast-1

    // Frontend service (React)
    const frontendTaskDef = new ecs.FargateTaskDefinition(this, `${project}-${environment}-frontend-taskdef`, {
      family: `${project}-${environment}-frontend`,
      cpu: config.ecs.frontend.cpu,
      memoryLimitMiB: config.ecs.frontend.memoryMiB,
      // Unify on x86_64 across environments to match build process
      runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.X86_64 },
      taskRole,
    });
    const frontendImage = frontendRepo
      ? ecs.ContainerImage.fromEcrRepository(frontendRepo, frontendTag)
      : ecs.ContainerImage.fromRegistry(`${this.account}.dkr.ecr.${this.region}.amazonaws.com/${project}-${environment}/frontend:${frontendTag}`);

    // Enforce single-arch images: validate that referenced tags are not manifest lists (image index)
    {
      const validateFn = new lambdaNode.NodejsFunction(this, `${project}-${environment}-ecr-validate-singlearch-fn`, {
        entry: 'lib/functions/ecr-validate-single-arch/index.ts',
        handler: 'handler',
        runtime: lambda.Runtime.NODEJS_18_X,
        memorySize: 128,
        timeout: Duration.minutes(1),
        logRetention: retention,
      });
      // Allow DescribeImages for target repositories
      const backendRepoArn = backendRepo?.repositoryArn ?? `arn:aws:ecr:${this.region}:${this.account}:repository/${project}-${environment}/backend`;
      const frontendRepoArn = frontendRepo?.repositoryArn ?? `arn:aws:ecr:${this.region}:${this.account}:repository/${project}-${environment}/frontend`;
      validateFn.addToRolePolicy(new iam.PolicyStatement({ actions: ['ecr:DescribeImages'], resources: [backendRepoArn, frontendRepoArn] }));

      const provider = new cr.Provider(this, `${project}-${environment}-ecr-validate-singlearch-provider`, { onEventHandler: validateFn });
      new CustomResource(this, `${project}-${environment}-ecr-validate-frontend`, {
        serviceToken: provider.serviceToken,
        properties: { RepositoryName: frontendRepo ? (frontendRepo as ecr.IRepository).repositoryName : `${project}-${environment}/frontend`, ImageTag: frontendTag, ResourceVersion: '1.0.0' },
      });
      new CustomResource(this, `${project}-${environment}-ecr-validate-backend`, {
        serviceToken: provider.serviceToken,
        properties: { RepositoryName: backendRepo ? (backendRepo as ecr.IRepository).repositoryName : `${project}-${environment}/backend`, ImageTag: backendTag, ResourceVersion: '1.0.0' },
      });
    }

    frontendTaskDef.addContainer('react', {
      containerName: 'react',
      image: frontendImage,
      logging: ecs.LogDriver.awsLogs({ streamPrefix: 'ecs', logGroup: frontendLogGroup }),
      portMappings: [{ containerPort: 80 }],
      cpu: config.ecs.frontend.cpu,
      memoryLimitMiB: config.ecs.frontend.memoryMiB,
      essential: true,
    });

    this.frontendService = new ecs.FargateService(this, `${project}-${environment}-frontend-svc`, {
      cluster,
      serviceName: `${project}-${environment}-frontend-svc`,
      taskDefinition: frontendTaskDef,
      desiredCount: config.ecs.frontend.desiredCount,
      securityGroups: [ecsSecurityGroup],
      circuitBreaker: { rollback: true },
      enableExecuteCommand: true,
      assignPublicIp: isDev ? true : false,
      // Keep at least 1 running task during rolling updates to avoid brief downtime
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      healthCheckGracePeriod: Duration.seconds(config.ecs.healthCheckGraceSeconds.frontend),
      vpcSubnets: isDev && devPublicSubnet ? { subnets: [devPublicSubnet] } : { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      capacityProviderStrategies: isDev
        ? [{ capacityProvider: 'FARGATE_SPOT', weight: 1 }]
        : [{ capacityProvider: 'FARGATE', weight: 1 }],
    });

    // Target groups and listener rules
    this.backendTg = new elbv2.ApplicationTargetGroup(this, `${project}-${environment}-backend-tg`, {
      vpc,
      port: 5000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      healthCheck: { path: '/ping', interval: Duration.seconds(30), healthyThresholdCount: 2, unhealthyThresholdCount: 5 },
      // Do not set targetGroupName so CFN can replace on immutable changes without name collision
    });
    this.frontendTg = new elbv2.ApplicationTargetGroup(this, `${project}-${environment}-frontend-tg`, {
      vpc,
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      healthCheck: { path: '/', interval: Duration.seconds(30), healthyThresholdCount: 2, unhealthyThresholdCount: 5 },
      // No explicit name to allow safe replacement
    });

    this.backendService.attachToApplicationTargetGroup(this.backendTg);
    this.frontendService.attachToApplicationTargetGroup(this.frontendTg);

    // Redirect all HTTP to HTTPS and route on HTTPS
    httpListener.addAction('RedirectToHttps', {
      action: elbv2.ListenerAction.redirect({ protocol: 'HTTPS', port: '443', permanent: true }),
    });
    httpsListener.addTargetGroups('DefaultFrontendHttps', { targetGroups: [this.frontendTg] });
    httpsListener.addTargetGroups('BackendRuleHttps', {
      priority: 10,
      conditions: [elbv2.ListenerCondition.pathPatterns(['/api/*'])],
      targetGroups: [this.backendTg],
    });

    // Optional: create Route53 A record for the ALB (app domain)
    const appHostedZoneId = this.node.tryGetContext('appHostedZoneId') as string | undefined;
    const appHostedZoneName = this.node.tryGetContext('appHostedZoneName') as string | undefined; // e.g., example.com
    const appRecordNameEnv = this.node.tryGetContext(`appRecordName${environment.charAt(0).toUpperCase()}${environment.slice(1)}`) as string | undefined;
    const appRecordName = appRecordNameEnv || (this.node.tryGetContext('appRecordName') as string | undefined);
    if (appHostedZoneId && appHostedZoneName && appRecordName) {
      const zone = route53.HostedZone.fromHostedZoneAttributes(this, `${project}-${environment}-app-zone`, {
        hostedZoneId: appHostedZoneId,
        zoneName: appHostedZoneName,
      });
      new route53.ARecord(this, `${project}-${environment}-app-record`, {
        zone,
        recordName: appRecordName,
        target: route53.RecordTarget.fromAlias(new route53Targets.LoadBalancerTarget(this.alb)),
      });
    }

    // AutoScaling policies
    const backendScaling = this.backendService.autoScaleTaskCount({ minCapacity: isDev ? 0 : config.ecs.min.backend, maxCapacity: config.ecs.max.backend });
    backendScaling.scaleOnCpuUtilization('Cpu70', { targetUtilizationPercent: 70, scaleInCooldown: Duration.seconds(300), scaleOutCooldown: Duration.seconds(300) });
    backendScaling.scaleOnMemoryUtilization('Mem80', { targetUtilizationPercent: 80, scaleInCooldown: Duration.seconds(300), scaleOutCooldown: Duration.seconds(300) });
    // Remove in-code scheduled scaling for DEV; we'll use EventBridge Scheduler + Lambda with holiday-aware logic

    const frontendScaling = this.frontendService.autoScaleTaskCount({ minCapacity: isDev ? 0 : config.ecs.min.frontend, maxCapacity: config.ecs.max.frontend });
    frontendScaling.scaleOnCpuUtilization('Cpu70', { targetUtilizationPercent: 70, scaleInCooldown: Duration.seconds(300), scaleOutCooldown: Duration.seconds(180) });
    // DEV holiday-aware scheduling via EventBridge Scheduler + Lambda (below)

    if (isDev) {
      const schedulerFn = new lambdaNode.NodejsFunction(this, `${project}-${environment}-ecs-hours-fn`, {
        entry: 'lib/functions/ecs-business-hours/index.ts',
        handler: 'handler',
        runtime: lambda.Runtime.NODEJS_18_X,
        memorySize: 256,
        timeout: Duration.minutes(2),
        logRetention: retention,
        environment: {
          CLUSTER_NAME: cluster.clusterName,
          FRONTEND_SERVICE_NAME: this.frontendService.serviceName,
          BACKEND_SERVICE_NAME: this.backendService.serviceName,
          JOB_SERVICE_NAME: this.jobService.serviceName,
          DESIRED_UP_COUNT: '1',
        },
      });
      // Allow function to update ECS services
      schedulerFn.addToRolePolicy(new iam2.PolicyStatement({
        actions: ['ecs:UpdateService'],
        resources: [this.frontendService.serviceArn, this.backendService.serviceArn, this.jobService.serviceArn],
      }));

      // EventBridge Scheduler -> Lambda invoke role
      const schedRole = new iam2.Role(this, `${project}-${environment}-ecs-hours-scheduler-role`, {
        assumedBy: new iam2.ServicePrincipal('scheduler.amazonaws.com'),
      });
      schedRole.addToPolicy(new iam2.PolicyStatement({
        actions: ['lambda:InvokeFunction'],
        resources: [schedulerFn.functionArn],
      }));

      new scheduler.CfnSchedule(this, `${project}-${environment}-ecs-up-0830-jst`, {
        flexibleTimeWindow: { mode: 'OFF' },
        scheduleExpression: 'cron(30 8 ? * MON-FRI *)',
        scheduleExpressionTimezone: 'Asia/Tokyo',
        target: {
          arn: schedulerFn.functionArn,
          roleArn: schedRole.roleArn,
          input: JSON.stringify({ action: 'up' }),
        },
        description: 'Scale up ECS services at 08:30 JST on weekdays (holiday-aware)',
      });

      new scheduler.CfnSchedule(this, `${project}-${environment}-ecs-down-1930-jst`, {
        flexibleTimeWindow: { mode: 'OFF' },
        scheduleExpression: 'cron(30 19 ? * MON-FRI *)',
        scheduleExpressionTimezone: 'Asia/Tokyo',
        target: {
          arn: schedulerFn.functionArn,
          roleArn: schedRole.roleArn,
          input: JSON.stringify({ action: 'down' }),
        },
        description: 'Scale down ECS services at 19:30 JST on weekdays',
      });
    }

    this.upsertSsmParameter(`${project}-${environment}-ecs-cluster-name`, ecsClusterNameParameterName(project, environment), cluster.clusterName, 'ECS cluster name exposed for cross-stack consumption.');
    this.upsertSsmParameter(`${project}-${environment}-ecs-backend-service-name`, ecsBackendServiceNameParameterName(project, environment), this.backendService.serviceName, 'Backend ECS service name exposed for cross-stack consumption.');
    this.upsertSsmParameter(`${project}-${environment}-ecs-job-service-name`, ecsJobServiceNameParameterName(project, environment), this.jobService.serviceName, 'Background job ECS service name exposed for cross-stack consumption.');
    this.upsertSsmParameter(`${project}-${environment}-ecs-frontend-service-name`, ecsFrontendServiceNameParameterName(project, environment), this.frontendService.serviceName, 'Frontend ECS service name exposed for cross-stack consumption.');
    this.upsertSsmParameter(`${project}-${environment}-alb-full-name`, albFullNameParameterName(project, environment), this.alb.loadBalancerFullName, 'ALB full name exposed for cross-stack consumption.');
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
