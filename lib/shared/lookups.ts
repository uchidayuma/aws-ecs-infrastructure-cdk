import { execSync } from 'node:child_process';
import { Stack } from 'aws-cdk-lib';

function runAwsCli(cmd: string, region: string): { ok: boolean; stdout?: string } {
  try {
    const env = { ...process.env, AWS_REGION: region, AWS_DEFAULT_REGION: region };
    const stdout = execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env });
    return { ok: true, stdout };
  } catch {
    return { ok: false };
  }
}

export function bucketExists(scope: any, bucketName: string): boolean {
  const region = Stack.of(scope).region || process.env.AWS_REGION || process.env.CDK_DEFAULT_REGION || 'us-east-1';
  // head-bucket returns 200 if the bucket is owned and reachable.
  const res = runAwsCli(`aws s3api head-bucket --bucket ${bucketName} --region ${region}`, region);
  return res.ok;
}

export function ecrRepositoryExists(scope: any, repoName: string): boolean {
  const region = Stack.of(scope).region || process.env.AWS_REGION || process.env.CDK_DEFAULT_REGION || 'us-east-1';
  const res = runAwsCli(`aws ecr describe-repositories --repository-names ${repoName} --region ${region}`, region);
  return res.ok;
}

export function logGroupExists(scope: any, logGroupName: string): boolean {
  const region = Stack.of(scope).region || process.env.AWS_REGION || process.env.CDK_DEFAULT_REGION || 'us-east-1';
  try {
    const env = { ...process.env, AWS_REGION: region, AWS_DEFAULT_REGION: region };
    const cmd = `aws logs describe-log-groups --log-group-name-prefix ${logGroupName} --query "length(logGroups[?logGroupName=='${logGroupName}'])" --output text --region ${region}`;
    const out = execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env }).trim();
    return out !== '' && out !== '0';
  } catch {
    return false;
  }
}
