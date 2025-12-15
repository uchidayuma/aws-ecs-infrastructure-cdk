import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { BaseStack, BaseStackProps } from '../shared/base-stack';

export interface GitHubActionsStackProps extends BaseStackProps {
  /**
   * GitHub repository in the format: owner/repo
   * Example: "your-org/sample-app"
   */
  readonly githubRepository: string;

  /**
   * Branches that are allowed to assume the role.
   * Example: ["main", "develop"]
   */
  readonly allowedBranches?: string[];
}

/**
 * Stack that creates IAM roles for GitHub Actions OIDC authentication.
 * This allows GitHub Actions workflows to deploy to AWS without long-term credentials.
 */
export class GitHubActionsStack extends BaseStack {
  public readonly deployRole: iam.Role;
  public readonly oidcProvider: iam.OpenIdConnectProvider;

  constructor(scope: Construct, id: string, props: GitHubActionsStackProps) {
    super(scope, id, props);

    const { githubRepository, allowedBranches = ['main', 'develop'] } = props;

    // Create GitHub OIDC Provider
    // GitHub's OIDC provider URL and thumbprint are standard
    this.oidcProvider = new iam.OpenIdConnectProvider(this, 'GitHubOidcProvider', {
      url: 'https://token.actions.githubusercontent.com',
      clientIds: ['sts.amazonaws.com'],
      // GitHub's OIDC thumbprint (standard, doesn't change)
      thumbprints: ['6938fd4d98bab03faadb97b34396831e3780aea1'],
    });

    // Create conditions for assuming the role
    // Only allow specific branches from the specified repository
    const conditions: { [key: string]: any } = {
      StringEquals: {
        'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
      },
      StringLike: {
        'token.actions.githubusercontent.com:sub': allowedBranches.map(
          branch => `repo:${githubRepository}:ref:refs/heads/${branch}`
        ),
      },
    };

    // Create IAM role for GitHub Actions
    this.deployRole = new iam.Role(this, 'GitHubActionsDeployRole', {
      roleName: `${props.project}-github-actions-deploy-role`,
      assumedBy: new iam.FederatedPrincipal(
        this.oidcProvider.openIdConnectProviderArn,
        conditions,
        'sts:AssumeRoleWithWebIdentity'
      ),
      description: 'Role used by GitHub Actions to deploy to ECS',
      maxSessionDuration: cdk.Duration.hours(1),
    });

    // Add permissions for ECR
    this.deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ECRAuthAndPush',
        effect: iam.Effect.ALLOW,
        actions: [
          'ecr:GetAuthorizationToken',
          'ecr:BatchCheckLayerAvailability',
          'ecr:GetDownloadUrlForLayer',
          'ecr:BatchGetImage',
          'ecr:PutImage',
          'ecr:InitiateLayerUpload',
          'ecr:UploadLayerPart',
          'ecr:CompleteLayerUpload',
        ],
        resources: ['*'],
      })
    );

    // Add permissions for ECS deployments
    // Allow updating services and waiting for stability
    this.deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ECSDeployment',
        effect: iam.Effect.ALLOW,
        actions: [
          'ecs:UpdateService',
          'ecs:DescribeServices',
          'ecs:DescribeTasks',
          'ecs:ListTasks',
          'ecs:RunTask', // Allow running migration tasks
        ],
        resources: [
          // Allow access to all ECS resources for this project
          `arn:aws:ecs:${this.region}:${this.account}:service/${props.project}-*`,
          `arn:aws:ecs:${this.region}:${this.account}:task-definition/${props.project}-*`,
          `arn:aws:ecs:${this.region}:${this.account}:task/${props.project}-*`,
        ],
      })
    );

    // Add permissions to describe task definitions (required for migrations)
    // DescribeTaskDefinition requires wildcard resource when called by name
    this.deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ECSDescribeTaskDefinitions',
        effect: iam.Effect.ALLOW,
        actions: ['ecs:DescribeTaskDefinition'],
        resources: ['*'],
      })
    );

    // Add permissions to pass ECS task execution and task roles
    // This is required when running tasks (migrations) that need specific IAM roles
    this.deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'PassECSRoles',
        effect: iam.Effect.ALLOW,
        actions: ['iam:PassRole'],
        resources: [
          // Allow passing any role for this project to ECS tasks
          `arn:aws:iam::${this.account}:role/${props.project}-*`,
        ],
        conditions: {
          StringEquals: {
            'iam:PassedToService': 'ecs-tasks.amazonaws.com',
          },
        },
      })
    );

    // Add permissions to describe clusters (needed for ECS wait commands)
    this.deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ECSDescribeClusters',
        effect: iam.Effect.ALLOW,
        actions: [
          'ecs:DescribeClusters',
          'ecs:ListClusters',
        ],
        resources: ['*'],
      })
    );

    // Add permissions to describe VPC resources (needed for migration tasks)
    this.deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'EC2DescribeVPCResources',
        effect: iam.Effect.ALLOW,
        actions: [
          'ec2:DescribeSubnets',
          'ec2:DescribeSecurityGroups',
          'ec2:DescribeVpcs',
        ],
        resources: ['*'],
      })
    );

    // Add permission to get caller identity (used by deploy scripts)
    this.deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'STSGetCallerIdentity',
        effect: iam.Effect.ALLOW,
        actions: ['sts:GetCallerIdentity'],
        resources: ['*'],
      })
    );

    // Outputs
    new cdk.CfnOutput(this, 'GitHubActionsRoleArn', {
      value: this.deployRole.roleArn,
      description: 'ARN of the IAM role for GitHub Actions',
      exportName: `${props.project}-${props.environment}-github-actions-role-arn`,
    });

    new cdk.CfnOutput(this, 'OIDCProviderArn', {
      value: this.oidcProvider.openIdConnectProviderArn,
      description: 'ARN of the GitHub OIDC provider',
      exportName: `${props.project}-${props.environment}-github-oidc-provider-arn`,
    });
  }
}
