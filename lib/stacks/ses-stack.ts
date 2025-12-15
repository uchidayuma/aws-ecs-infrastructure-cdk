import { aws_ses as ses, aws_route53 as route53 } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { BaseStack, BaseStackProps } from '../shared/base-stack';

export interface SesStackProps extends BaseStackProps {
  domainName: string; // e.g., example.com (must be hosted in Route53 in this account)
  mailFromSubdomain?: string; // e.g., 'mail' -> mail.example.com
}

// Provisions SES domain identity with DKIM by attaching records to Route53 hosted zone.
export class SesStack extends BaseStack {
  constructor(scope: Construct, id: string, props: SesStackProps) {
    super(scope, id, props);
    const { domainName, mailFromSubdomain = 'mail' } = props;

    // Look up the public hosted zone for the domain
    const hostedZone = route53.HostedZone.fromLookup(this, `${id}-zone`, {
      domainName,
    });

    new ses.EmailIdentity(this, `${id}-identity`, {
      identity: ses.Identity.publicHostedZone(hostedZone),
      mailFromDomain: `${mailFromSubdomain}.${domainName}`,
    });
  }
}

