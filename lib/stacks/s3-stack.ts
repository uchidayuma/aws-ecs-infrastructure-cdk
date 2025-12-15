import { RemovalPolicy, Duration, aws_s3 as s3 } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { BaseStack, BaseStackProps } from '../shared/base-stack';

export interface S3StackProps extends BaseStackProps {
  config: any;
  reuseExistingBucket?: boolean;
  existingBucketName?: string;
}

export class S3Stack extends BaseStack {
  public readonly bucket: s3.IBucket;

  constructor(scope: Construct, id: string, props: S3StackProps) {
    super(scope, id, props);
    const { project, environment, existingBucketName, reuseExistingBucket } = props;
    const isDev = environment === 'dev';
    const desiredBucketName = `${project}-files-${environment}`;
    const bucketName = existingBucketName || desiredBucketName;

    if (reuseExistingBucket) {
      // Reference an existing bucket instead of creating one (useful for prod re-deploys)
      this.bucket = s3.Bucket.fromBucketName(this, `${project}-${environment}-existing-bucket`, bucketName);
      return;
    }

    // Always define the bucket as a managed CFN resource.
    // If a bucket with the same name already exists, import it into this stack
    // using `cdk import` so that default encryption and other properties are applied.
    this.bucket = new s3.Bucket(this, `${project}-${environment}-files`, {
      bucketName,
      encryption: s3.BucketEncryption.S3_MANAGED, // SSE-S3 (AES256)
      // Disable versioning in dev to reduce storage cost
      versioned: !isDev,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      // Destroy bucket on stack delete in dev for zero-residual cost
      removalPolicy: isDev ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN,
      autoDeleteObjects: isDev,
      cors: [
        {
          allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.HEAD],
          allowedOrigins: ['*'],
          allowedHeaders: ['*'],
          exposedHeaders: ['ETag'],
          maxAge: 300,
        },
      ],
      lifecycleRules: [
        {
          // For dev, expire objects quickly; for others limit noncurrent versions
          expiration: isDev ? Duration.days(7) : undefined,
          noncurrentVersionExpiration: isDev ? undefined : Duration.days(props.config.logsRetentionDays >= 30 ? 30 : props.config.logsRetentionDays),
        },
      ],
    });
  }
}
