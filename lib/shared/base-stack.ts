import { Stack, StackProps, Tags } from 'aws-cdk-lib';
import { Construct } from 'constructs';

export interface BaseStackProps extends StackProps {
  environment: string;
  project: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  config?: any;
}

export class BaseStack extends Stack {
  constructor(scope: Construct, id: string, props: BaseStackProps) {
    super(scope, id, props);

    this.applyCommonTags(props.environment, props.project);
  }

  private applyCommonTags(environment: string, project: string): void {
    Tags.of(this).add('Project', `${project}-${environment}`);
    Tags.of(this).add('Environment', environment);
    Tags.of(this).add('Owner', 'development-team');
    Tags.of(this).add('CostCenter', 'engineering');
    Tags.of(this).add('ManagedBy', 'aws-cdk');
    Tags.of(this).add('CreatedDate', new Date().toISOString().split('T')[0]);
  }
}
