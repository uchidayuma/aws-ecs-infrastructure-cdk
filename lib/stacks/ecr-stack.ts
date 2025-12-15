import { RemovalPolicy, Duration, aws_ecr as ecr } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { BaseStack, BaseStackProps } from '../shared/base-stack';
import { ecrRepositoryExists } from '../shared/lookups';

export interface EcrStackProps extends BaseStackProps {}

export class EcrStack extends BaseStack {
  public readonly backendRepo: ecr.IRepository;
  public readonly frontendRepo: ecr.IRepository;

  constructor(scope: Construct, id: string, props: EcrStackProps) {
    super(scope, id, props);
    const { project, environment } = props;

    const backendName = `${project}-${environment}/backend`;
    const frontendName = `${project}-${environment}/frontend`;

    if (ecrRepositoryExists(this, backendName)) {
      this.backendRepo = ecr.Repository.fromRepositoryName(this, `${project}-${environment}-backend-repo`, backendName);
    } else {
      this.backendRepo = new ecr.Repository(this, `${project}-${environment}-backend-repo`, {
        repositoryName: backendName,
        imageScanOnPush: true,
        removalPolicy: RemovalPolicy.RETAIN,
        lifecycleRules: [
          // Retain plenty of untagged digests so long-lived task definitions (e.g., job service) don't break
          { tagStatus: ecr.TagStatus.UNTAGGED, maxImageCount: 200, maxImageAge: Duration.days(365) },
        ],
      });
    }

    if (ecrRepositoryExists(this, frontendName)) {
      this.frontendRepo = ecr.Repository.fromRepositoryName(this, `${project}-${environment}-frontend-repo`, frontendName);
    } else {
      this.frontendRepo = new ecr.Repository(this, `${project}-${environment}-frontend-repo`, {
        repositoryName: frontendName,
        imageScanOnPush: true,
        removalPolicy: RemovalPolicy.RETAIN,
        lifecycleRules: [
          // Retain plenty of untagged digests so long-lived task definitions (e.g., job service) don't break
          { tagStatus: ecr.TagStatus.UNTAGGED, maxImageCount: 200, maxImageAge: Duration.days(365) },
        ],
      });
    }
  }
}
