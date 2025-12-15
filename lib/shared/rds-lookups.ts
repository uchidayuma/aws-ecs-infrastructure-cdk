import { execSync } from 'node:child_process';
import { Stack } from 'aws-cdk-lib';

export interface RdsInstanceAttrs {
  endpoint: string;
  port: number;
  securityGroupIds: string[];
  arn?: string;
}

export function getRdsInstanceAttributes(scope: any, identifier: string): RdsInstanceAttrs | undefined {
  try {
    const region = Stack.of(scope).region || process.env.AWS_REGION || process.env.CDK_DEFAULT_REGION || 'ap-northeast-3';
    const env = { ...process.env, AWS_REGION: region, AWS_DEFAULT_REGION: region };
    const query = "DBInstances[0].[Endpoint.Address,Endpoint.Port,VpcSecurityGroups[*].VpcSecurityGroupId,DBInstanceArn]";
    const cmd = `aws rds describe-db-instances --db-instance-identifier ${identifier} --query '${query}' --output json --region ${region}`;
    const out = execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env }).trim();
    if (!out) return undefined;
    const [endpoint, port, sgIds, arn] = JSON.parse(out);
    return { endpoint, port: Number(port), securityGroupIds: sgIds || [], arn };
  } catch {
    return undefined;
  }
}

export function getSecretArnByName(scope: any, secretName: string): string | undefined {
  try {
    const region = Stack.of(scope).region || process.env.AWS_REGION || process.env.CDK_DEFAULT_REGION || 'us-east-1';
    const env = { ...process.env, AWS_REGION: region, AWS_DEFAULT_REGION: region };
    const cmd = `aws secretsmanager describe-secret --secret-id ${secretName} --query 'ARN' --output text --region ${region}`;
    const out = execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env }).trim();
    return out && out !== 'None' ? out : undefined;
  } catch {
    return undefined;
  }
}
