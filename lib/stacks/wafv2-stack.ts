import { aws_wafv2 as wafv2 } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { BaseStack, BaseStackProps } from '../shared/base-stack';
import { aws_elasticloadbalancingv2 as elbv2 } from 'aws-cdk-lib';

export interface WafV2StackProps extends BaseStackProps {
  alb: elbv2.IApplicationLoadBalancer;
}

export class WafV2Stack extends BaseStack {
  constructor(scope: Construct, id: string, props: WafV2StackProps) {
    super(scope, id, props);
    const { project, environment, alb } = props;

    const webAcl = new wafv2.CfnWebACL(this, `${project}-${environment}-waf`, {
      name: `${project}-${environment}-waf`,
      scope: 'REGIONAL',
      defaultAction: { allow: {} },
      visibilityConfig: { cloudWatchMetricsEnabled: true, sampledRequestsEnabled: true, metricName: `${project}-${environment}-waf` },
      rules: [
        // AWS Managed rule sets
        // Note: All managed rule sets are in count mode to allow file uploads
        // File size validation is handled at the application level (5MB max)
        {
          name: 'AWS-AWSManagedRulesCommonRuleSet',
          priority: 10,
          overrideAction: { count: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesCommonRuleSet',
            },
          },
          visibilityConfig: { cloudWatchMetricsEnabled: true, sampledRequestsEnabled: true, metricName: 'Common' },
        },
        {
          name: 'AWS-AWSManagedRulesKnownBadInputsRuleSet',
          priority: 20,
          overrideAction: { count: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesKnownBadInputsRuleSet',
            },
          },
          visibilityConfig: { cloudWatchMetricsEnabled: true, sampledRequestsEnabled: true, metricName: 'KnownBadInputs' },
        },
        {
          name: 'AWS-AWSManagedRulesAmazonIpReputationList',
          priority: 30,
          overrideAction: { count: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesAmazonIpReputationList',
            },
          },
          visibilityConfig: { cloudWatchMetricsEnabled: true, sampledRequestsEnabled: true, metricName: 'IpReputation' },
        },
        // Optional simple rate limit
        {
          name: 'RateLimit',
          priority: 40,
          action: { block: {} },
          statement: { rateBasedStatement: { limit: 2000, aggregateKeyType: 'IP' } },
          visibilityConfig: { cloudWatchMetricsEnabled: true, sampledRequestsEnabled: true, metricName: 'RateLimit' },
        },
      ],
    });

    new wafv2.CfnWebACLAssociation(this, `${project}-${environment}-waf-assoc`, {
      resourceArn: alb.loadBalancerArn,
      webAclArn: webAcl.attrArn,
    });
  }
}

