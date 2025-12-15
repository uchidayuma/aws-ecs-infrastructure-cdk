# AWS Infrastructure with CDK (TypeScript)

## Overview

This project demonstrates a production-ready AWS infrastructure implementation using AWS CDK (Cloud Development Kit) with TypeScript. It showcases best practices for deploying containerized applications on AWS ECS Fargate with a complete supporting infrastructure.

## Architecture

### System Components

- **Frontend**: React application running in Docker containers
- **Backend**: Flask (Python) API running in Docker containers
- **Database**: Amazon RDS MySQL with Multi-AZ support
- **Storage**: Amazon S3 for file storage
- **Container Orchestration**: Amazon ECS Fargate
- **Infrastructure as Code**: AWS CDK (TypeScript)

### Infrastructure Design

![AWS Infrastructure Architecture](./setting.png)

The architecture diagram above illustrates the complete AWS infrastructure setup, including:

- **Internet Gateway & DNS**: Route 53 manages domain routing and SSL certificates
- **Load Balancing**: Application Load Balancer distributes traffic and terminates SSL
- **Container Services**: ECS Fargate hosts both React frontend (port 80) and Flask backend (port 8000)
- **Data Persistence**: RDS MySQL for relational data, S3 for file storage
- **Network Security**: Multi-layer VPC with public, private, and database subnets

<details>
<summary>Text-based Architecture Diagram</summary>

```
┌─────────────────────────────────────────────────────────────┐
│                         Internet                            │
└─────────────────────┬───────────────────────────────────────┘
                      │
┌─────────────────────┴───────────────────────────────────────┐
│                        Route 53                             │
│                       DNS Management                        │
└─────────────────────┬───────────────────────────────────────┘
                      │
┌─────────────────────┴───────────────────────────────────────┐
│                Application Load Balancer                    │
│                  SSL Termination & Routing                  │
└─────────────────────┬───────────────────────────────────────┘
                      │
┌─────────────────────┴───────────────────────────────────────┐
│                        ECS Fargate                          │
│   ┌─────────────────┐                       ┌──────────────┐│
│   │   Flask         │   /api/*              │    React     ││
│   │ Container(8000) │ <───────────────      │ Container(80)││
│   └─────────────────┘                       └──────────────┘│
└─────────────┬───────────────────────┬────────────────────────┘
              │                       │
    ┌─────────┴──────────────┐     ┌──┴──────────────────────┐
    │       Amazon RDS       │     │        Amazon S3         │
    │       MySQL 8.0        │     │       File Storage       │
    │       Multi-AZ         │     │   Images, PDFs, Uploads  │
    └────────────────────────┘     └─────────────────────────┘
```

</details>

### Network Configuration

#### VPC Design

- VPC CIDR (per environment):
  - dev: `172.20.0.0/16`
  - staging: `172.21.0.0/16`
  - prod: `172.22.0.0/16`
  - Region: `ap-northeast-3` (Osaka)
  - Availability Zones: 2 (for high availability)

#### Subnet Configuration

| Subnet Name       | CIDR           | AZ              | Purpose          |
| ----------------- | -------------- | --------------- | ---------------- |
| public-subnet-1a  | 172.20.1.0/24  | ap-northeast-3a | ALB, NAT Gateway |
| public-subnet-1c  | 172.20.2.0/24  | ap-northeast-3c | ALB, NAT Gateway |
| private-subnet-1a | 172.20.10.0/24 | ap-northeast-3a | ECS Fargate      |
| private-subnet-1c | 172.20.11.0/24 | ap-northeast-3c | ECS Fargate      |
| db-subnet-1a      | 172.20.20.0/24 | ap-northeast-3a | RDS              |
| db-subnet-1c      | 172.20.21.0/24 | ap-northeast-3c | RDS              |

#### Security Groups

- **ALB SG**
  - Inbound: HTTP(80), HTTPS(443) from 0.0.0.0/0
  - Outbound: 80/8000 to ECS containers
- **ECS SG**
  - Inbound: 80 (React), 8000 (Flask) from ALB SG
  - Outbound: 0.0.0.0/0 (for API calls, package downloads)
- **RDS SG**
  - Inbound: MySQL(3306) from ECS SG

## Stack Structure

### Core Stacks

1. **VPC Stack** (`vpc-stack.ts`)
   - VPC, subnets, NAT gateways
   - Security groups
   - Internet gateway

2. **ECR Stack** (`ecr-stack.ts`)
   - Container image repositories
   - Lifecycle policies

3. **ECS Stack** (`ecs-stack.ts`)
   - ECS Cluster
   - Fargate tasks and services
   - Application Load Balancer
   - Auto Scaling policies

4. **RDS Stack** (`rds-stack.ts`)
   - MySQL database instance
   - Automated backups
   - Multi-AZ configuration
   - Database users (via Lambda)

5. **S3 Stack** (`s3-stack.ts`)
   - Application file storage
   - Lifecycle policies
   - Versioning and encryption

### Optional Stacks

6. **WAF Stack** (`wafv2-stack.ts`)
   - AWS WAF rules
   - Rate limiting
   - IP reputation filtering

7. **Alarms Stack** (`alarms-stack.ts`)
   - CloudWatch alarms
   - SNS notifications
   - Slack integration

8. **Logs Analytics Stack** (`logs-analytics-stack.ts`)
   - CloudWatch Logs to S3
   - Firehose data delivery
   - Athena query setup

9. **Bastion Stack** (`bastion-stack.ts`)
   - EC2 bastion host for database access
   - SSH key management
   - Automated start/stop scheduling

10. **SES Stack** (`ses-stack.ts`)
    - Email sending configuration
    - Domain verification
    - DKIM setup

11. **GitHub Actions Stack** (`github-actions-stack.ts`)
    - OIDC provider for GitHub Actions
    - IAM roles for CI/CD

## Environment Configuration

### Development (dev)
- **ECS**: Minimal resources (256 CPU / 512 MB Memory)
- **RDS**: `t4g.micro`, Single-AZ
- **Auto Scaling**: Disabled or minimal
- **Backup**: 0-1 days
- **Logs**: 1 day retention

### Staging
- **ECS**: Medium resources (512 CPU / 1024 MB Memory)
- **RDS**: `t3.small`, Multi-AZ
- **Auto Scaling**: Enabled with moderate limits
- **Backup**: 3 days
- **Logs**: 14 days retention

### Production (prod)
- **ECS**: Optimized resources with high availability
- **RDS**: `t3.small` or larger, Multi-AZ
- **Auto Scaling**: Full scaling capability
- **Backup**: 7 days
- **Logs**: 30 days retention
- **WAF**: Enabled
- **Alarms**: Comprehensive monitoring

## Deployment

### Prerequisites

```bash
# Install dependencies
npm install

# Bootstrap CDK (first time only)
npx cdk bootstrap aws://{ACCOUNT}/{REGION}
```

### Deploy Infrastructure

```bash
# Deploy all stacks for an environment
npx cdk deploy sample-app-{env}-* -c env={env}

# Deploy specific stack
npx cdk deploy sample-app-{env}-vpc -c env={env}
npx cdk deploy sample-app-{env}-ecs -c env={env}
```

### Context Parameters

- `-c env={dev|staging|prod}`: Environment selection
- `-c region={region}`: AWS region (default: ap-northeast-3)
- `-c account={account-id}`: AWS account ID
- `-c certArn={arn}`: ACM certificate ARN for HTTPS
- `-c enableAlarms={true|false}`: Enable CloudWatch alarms
- `-c alarmEmails={email1,email2}`: Email addresses for alarm notifications

## Key Features

### Security
- **VPC Isolation**: Multi-tier network architecture
- **Encryption**: At-rest and in-transit encryption
- **Secrets Management**: AWS Secrets Manager for credentials
- **WAF Protection**: Rate limiting and IP filtering
- **IAM Roles**: Least privilege access policies

### High Availability
- **Multi-AZ**: RDS and ALB across multiple availability zones
- **Auto Scaling**: Dynamic scaling based on CPU/memory metrics
- **Health Checks**: Automated container health monitoring
- **Backup**: Automated RDS backups with point-in-time recovery

### Monitoring & Observability
- **CloudWatch Logs**: Centralized logging
- **CloudWatch Alarms**: Critical metric alerts
- **Container Insights**: ECS performance metrics
- **Log Analytics**: S3 + Athena for historical analysis

### Cost Optimization
- **Auto Scaling**: Scale down during low traffic
- **Business Hours Scheduling**: Automated start/stop for dev environments
- **Spot Instances**: Optional for non-production workloads
- **Lifecycle Policies**: Automated cleanup of old logs and backups

## Database Management

### Initial Setup

The RDS stack automatically creates:
- Admin user (stored in Secrets Manager)
- Application user with limited privileges
- Read-only user for analytics

### Database Access

- **Production**: Through application containers only
- **Development**: Via bastion host (SSH tunnel)

### Migrations

Database migrations are managed using Alembic and can be executed via ECS Exec:

```bash
aws ecs execute-command \
  --cluster sample-app-{env}-cluster \
  --task {task-arn} \
  --container backend \
  --interactive \
  --command "bash scripts/migrate.sh"
```

## Container Deployment

### Build and Push Images

```bash
# Login to ECR
aws ecr get-login-password --region {region} | \
  docker login --username AWS --password-stdin {account}.dkr.ecr.{region}.amazonaws.com

# Build and push backend
docker build --platform linux/amd64 -t backend:latest -f backend/Dockerfile.prod .
docker tag backend:latest {account}.dkr.ecr.{region}.amazonaws.com/sample-app-{env}/backend:latest
docker push {account}.dkr.ecr.{region}.amazonaws.com/sample-app-{env}/backend:latest

# Build and push frontend
docker build --platform linux/amd64 -t frontend:latest -f frontend/Dockerfile.prod .
docker tag frontend:latest {account}.dkr.ecr.{region}.amazonaws.com/sample-app-{env}/frontend:latest
docker push {account}.dkr.ecr.{region}.amazonaws.com/sample-app-{env}/frontend:latest
```

### Force Deployment

```bash
aws ecs update-service \
  --cluster sample-app-{env}-cluster \
  --service sample-app-{env}-backend-svc \
  --force-new-deployment
```

## File Structure

```
infrastructure-cdk/
├── bin/
│   └── app.ts                    # CDK app entry point
├── lib/
│   ├── stacks/
│   │   ├── vpc-stack.ts          # Network infrastructure
│   │   ├── ecr-stack.ts          # Container registries
│   │   ├── ecs-stack.ts          # Container orchestration
│   │   ├── rds-stack.ts          # Database
│   │   ├── s3-stack.ts           # Object storage
│   │   ├── wafv2-stack.ts        # Web application firewall
│   │   ├── alarms-stack.ts       # Monitoring and alerts
│   │   ├── bastion-stack.ts      # Database access
│   │   ├── ses-stack.ts          # Email service
│   │   ├── logs-analytics-stack.ts
│   │   └── github-actions-stack.ts
│   ├── shared/
│   │   ├── base-stack.ts         # Base stack with common tags
│   │   ├── naming.ts             # Naming conventions
│   │   └── lookups.ts            # Cross-stack lookups
│   ├── functions/                # Lambda functions
│   │   ├── db-init/              # Database initialization
│   │   ├── ec2-business-hours/   # EC2 scheduling
│   │   ├── ecs-business-hours/   # ECS scheduling
│   │   ├── rds-business-hours/   # RDS scheduling
│   │   └── slack-notifier/       # Slack notifications
│   └── config/
│       └── index.ts              # Environment configurations
├── docs/
│   └── WEBAUTHN_CONFIGURATION.md
├── scripts/
│   └── manage-webauthn-params.sh
├── package.json
├── tsconfig.json
└── cdk.json
```

## Best Practices Demonstrated

1. **Infrastructure as Code**: All infrastructure defined in TypeScript
2. **Environment Separation**: Isolated dev, staging, and prod environments
3. **Security First**: Encryption, secrets management, network isolation
4. **Cost Optimization**: Auto-scaling, scheduling, lifecycle policies
5. **Monitoring**: Comprehensive logging and alerting
6. **CI/CD Ready**: GitHub Actions OIDC integration
7. **Disaster Recovery**: Automated backups, multi-AZ deployment
8. **Maintainability**: Clear structure, reusable constructs, documentation

## Technologies Used

- **AWS CDK**: Infrastructure as Code
- **TypeScript**: Type-safe infrastructure definitions
- **Amazon ECS Fargate**: Serverless container orchestration
- **Amazon RDS**: Managed relational database
- **Amazon S3**: Object storage
- **Application Load Balancer**: HTTP/HTTPS load balancing
- **Amazon CloudWatch**: Monitoring and logging
- **AWS Secrets Manager**: Credential management
- **AWS WAF**: Web application firewall

## License

This project is provided as a portfolio example. Feel free to use it as a reference for your own infrastructure projects.

## Notes

- Replace `{account}`, `{region}`, and `{env}` with your actual values
- Ensure proper IAM permissions before deployment
- Review and adjust resource configurations based on your requirements
- Update security group rules according to your security policies
