export function rdsSecurityGroupIdParameterName(project: string, environment: string): string {
  return `/${project}/${environment}/rds/security-group-id`;
}

export function rdsEndpointAddressParameterName(project: string, environment: string): string {
  return `/${project}/${environment}/rds/endpoint-address`;
}

export function rdsEndpointPortParameterName(project: string, environment: string): string {
  return `/${project}/${environment}/rds/endpoint-port`;
}

export function ecsClusterNameParameterName(project: string, environment: string): string {
  return `/${project}/${environment}/ecs/cluster-name`;
}

export function ecsBackendServiceNameParameterName(project: string, environment: string): string {
  return `/${project}/${environment}/ecs/backend-service-name`;
}

export function ecsFrontendServiceNameParameterName(project: string, environment: string): string {
  return `/${project}/${environment}/ecs/frontend-service-name`;
}

export function ecsJobServiceNameParameterName(project: string, environment: string): string {
  return `/${project}/${environment}/ecs/job-service-name`;
}

export function albFullNameParameterName(project: string, environment: string): string {
  return `/${project}/${environment}/alb/load-balancer-full-name`;
}

export function rdsInstanceIdentifierParameterName(project: string, environment: string): string {
  return `/${project}/${environment}/rds/instance-identifier`;
}

export function bastionSecurityGroupIdParameterName(project: string, environment: string): string {
  return `/${project}/${environment}/bastion/security-group-id`;
}
