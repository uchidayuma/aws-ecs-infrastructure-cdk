import { Duration, Size } from 'aws-cdk-lib';

export type EnvName = 'dev' | 'staging' | 'prod';

export interface EnvConfig {
  readonly ecs: {
    readonly frontend: { cpu: number; memoryMiB: number; desiredCount: number };
    readonly backend: { cpu: number; memoryMiB: number; desiredCount: number };
    readonly jobs: { cpu: number; memoryMiB: number; desiredCount: number };
    readonly min: { frontend: number; backend: number; jobs: number };
    readonly max: { frontend: number; backend: number; jobs: number };
    readonly healthCheckGraceSeconds: { frontend: number; backend: number };
  };
  readonly rds: {
    readonly instanceClass: string; // e.g., t3.micro, t3.small
    readonly multiAz: boolean;
    readonly backupRetentionDays: number;
  };
  readonly logsRetentionDays: number;
}

export const envConfigs: Record<EnvName, EnvConfig> = {
  dev: {
    ecs: {
      // Start with 1 task now that images are available
      frontend: { cpu: 256, memoryMiB: 512, desiredCount: 1 },
      backend: { cpu: 256, memoryMiB: 512, desiredCount: 1 },
      jobs: { cpu: 256, memoryMiB: 512, desiredCount: 1 },
      // Allow scaling to 0 in DEV (off-hours)
      min: { frontend: 0, backend: 0, jobs: 1 },
      max: { frontend: 2, backend: 2, jobs: 1 },
      healthCheckGraceSeconds: { frontend: 120, backend: 300 },
    },
    // DEV prioritizes lowest cost
    rds: { instanceClass: 't4g.micro', multiAz: false, backupRetentionDays: 0 },
    logsRetentionDays: 1,
  },
  staging: {
    ecs: {
      frontend: { cpu: 256, memoryMiB: 512, desiredCount: 1 },
      backend: { cpu: 512, memoryMiB: 1024, desiredCount: 2 },
      jobs: { cpu: 512, memoryMiB: 1024, desiredCount: 1 },
      min: { frontend: 1, backend: 2, jobs: 1 },
      max: { frontend: 3, backend: 4, jobs: 1 },
      healthCheckGraceSeconds: { frontend: 120, backend: 300 },
    },
    rds: { instanceClass: 't3.small', multiAz: true, backupRetentionDays: 3 },
    logsRetentionDays: 14,
  },
  prod: {
    ecs: {
      frontend: { cpu: 256, memoryMiB: 512, desiredCount: 1 },
      backend: { cpu: 512, memoryMiB: 1024, desiredCount: 2 },
      jobs: { cpu: 512, memoryMiB: 1024, desiredCount: 1 },
      min: { frontend: 1, backend: 2, jobs: 1 },
      max: { frontend: 6, backend: 10, jobs: 1 },
      healthCheckGraceSeconds: { frontend: 120, backend: 300 },
    },
    rds: { instanceClass: 't3.small', multiAz: true, backupRetentionDays: 7 },
    logsRetentionDays: 30,
  },
};

export function getEnvConfig(env: string): EnvConfig {
  if (envConfigs[env as EnvName]) return envConfigs[env as EnvName];
  return envConfigs.dev;
}
