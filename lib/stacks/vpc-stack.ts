import { aws_ec2 as ec2, CfnOutput, Tags } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { BaseStack, BaseStackProps } from '../shared/base-stack';

export interface VpcStackProps extends BaseStackProps {
  config: any;
}

export class VpcStack extends BaseStack {
  public readonly vpc: ec2.Vpc;
  public readonly albSecurityGroup: ec2.SecurityGroup;
  public readonly ecsSecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: VpcStackProps) {
    super(scope, id, props);

    const { project, environment } = props;
    const isDev = environment === 'dev';

    const environmentCidrs: Record<string, string> = {
      dev: '172.20.0.0/16',
      staging: '172.21.0.0/16',
      prod: '172.22.0.0/16',
    };
    const vpcCidr = environmentCidrs[environment] ?? environmentCidrs.dev;

    // Allow override via context to avoid disruptive updates on existing VPCs
    const natGatewaysCtx = this.node.tryGetContext('natGateways');
    const natGateways = natGatewaysCtx !== undefined ? Number(natGatewaysCtx) : (isDev ? 0 : 2);
    const maxAzsCtx = this.node.tryGetContext('maxAzs');
    const maxAzs = maxAzsCtx !== undefined ? Number(maxAzsCtx) : 2;

    this.vpc = new ec2.Vpc(this, `${project}-${environment}-vpc`, {
      vpcName: `${project}-${environment}-vpc`,
      ipAddresses: ec2.IpAddresses.cidr(vpcCidr),
      // Default: DEV=0 to save cost, but can be overridden with -c natGateways
      natGateways,
      maxAzs,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        // Keep a private-with-egress tier for non-dev; in DEV it will have no NAT route (acceptable)
        { name: 'private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
        { name: 'db', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });

    // Note: Cross-stack references to subnets (including publicSubnet2) are auto-exported
    // by CDK when other stacks import them (e.g., ECS/ALB). No manual compatibility export needed.

    // Add minimal VPC Endpoints when NAT is 0 so Lambda in isolated subnets can call AWS APIs.
    // Specifically needed for RDS init Lambda to fetch Secrets Manager values in DEV.
    if (isDev && natGateways === 0) {
      this.vpc.addInterfaceEndpoint(`${project}-${environment}-secretsmanager-vpce`, {
        service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
        subnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      });
    }

    // Security Groups
    this.albSecurityGroup = new ec2.SecurityGroup(this, `${project}-${environment}-alb-sg`, {
      vpc: this.vpc,
      description: 'ALB Security Group',
      allowAllOutbound: false,
    });
    Tags.of(this.albSecurityGroup).add('Name', `${project}-${environment}-alb-sg`);
    Tags.of(this.albSecurityGroup).add('Environment', environment);
    Tags.of(this.albSecurityGroup).add('Type', 'alb');

    this.albSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'HTTP');
    this.albSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS');
    // You can enable HTTPS via context cert later
    this.albSecurityGroup.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'To ECS frontend');
    this.albSecurityGroup.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(5000), 'To ECS backend');

    this.ecsSecurityGroup = new ec2.SecurityGroup(this, `${project}-${environment}-ecs-sg`, {
      vpc: this.vpc,
      description: 'ECS Security Group',
      allowAllOutbound: true,
    });
    // Add tags for easier discovery in GitHub Actions (without changing the group name)
    Tags.of(this.ecsSecurityGroup).add('Name', `${project}-${environment}-ecs-sg`);
    Tags.of(this.ecsSecurityGroup).add('Environment', environment);
    Tags.of(this.ecsSecurityGroup).add('Type', 'ecs');

    // Inbound from ALB
    this.ecsSecurityGroup.addIngressRule(this.albSecurityGroup, ec2.Port.tcp(80), 'React HTTP from ALB');
    this.ecsSecurityGroup.addIngressRule(this.albSecurityGroup, ec2.Port.tcp(5000), 'Flask HTTP from ALB');
  }
}
