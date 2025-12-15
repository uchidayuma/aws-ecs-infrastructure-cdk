# GitHub Actions CI/CD Setup Guide

This guide explains how to set up automated deployments to ECS using GitHub Actions.

## Overview

- **develop** branch merge → Automatic deployment to DEV environment
- **main** branch merge → Automatic deployment to Production environment
- Parallel deployment of frontend and backend
- **Automatic database migration on backend deployment**
- Secure AWS authentication using OIDC (no long-term access keys)

## Setup Instructions

### 1. Configure GitHub Repository Information

Verify your GitHub repository information in the format: `owner/repository-name`

Example: `your-org/your-repo`

### 2. Deploy CDK Stack

Create IAM roles and OIDC provider for GitHub Actions:

```bash
cd infrastructure-cdk

# Deploy with GitHub repository specified
npx cdk deploy sample-app-github-actions \
  -c githubRepo="your-org/your-repo"

# Or specify via environment variable
export GITHUB_REPOSITORY="your-org/your-repo"
npx cdk deploy sample-app-github-actions
```

After deployment, the following outputs will be displayed:

- `GitHubActionsRoleArn`: IAM role ARN used by GitHub Actions
- `OIDCProviderArn`: GitHub OIDC provider ARN

### 3. Verify Workflow Files

The following workflow files should be created:

- `.github/workflows/deploy-to-dev.yml` - Deployment to DEV environment
- `.github/workflows/deploy-to-prod.yml` - Deployment to Production environment

These files are automatically triggered on pushes to the specified branches.

### 4. Verify in GitHub Repository

Confirm the following in your GitHub repository:

1. Workflow files are committed
2. Workflows appear in the Actions tab
3. Workflows execute when merging to the specified branches

## Deployment Mechanism

### Deployment to DEV Environment (develop branch)

```
Merge to develop branch
  ↓
GitHub Actions trigger
  ↓
AWS authentication (OIDC)
  ↓
Docker image build (frontend & backend)
  ↓
Push to ECR
  ↓
[Backend only] Execute database migration
  ├─ Run migration task using ECS Run Task
  ├─ Wait for migration completion
  └─ Cancel deployment if failed
  ↓
Update ECS service (force-new-deployment)
  ↓
Wait for deployment completion
```

### Deployment to Production Environment (main branch)

```
Merge to main branch
  ↓
GitHub Actions trigger
  ↓
AWS authentication (OIDC)
  ↓
Docker image build (frontend & backend)
  ↓
Push to ECR
  ↓
[Backend only] Execute database migration
  ├─ Run migration task using ECS Run Task
  ├─ Wait for migration completion
  └─ Cancel deployment if failed
  ↓
Update ECS service (force-new-deployment)
  ↓
Wait for deployment completion
```

## IAM Role Permissions

The GitHub Actions role has the following permissions:

### ECR Permissions

- `ecr:GetAuthorizationToken` - ECR login
- `ecr:BatchCheckLayerAvailability` - Layer verification
- `ecr:PutImage` - Image push
- `ecr:InitiateLayerUpload` - Start layer upload
- `ecr:UploadLayerPart` - Layer upload
- `ecr:CompleteLayerUpload` - Complete layer upload

### ECS Permissions

- `ecs:UpdateService` - Service update
- `ecs:DescribeServices` - Get service information
- `ecs:DescribeTasks` - Get task information
- `ecs:DescribeTaskDefinition` - Get task definition
- `ecs:ListTasks` - List tasks
- `ecs:DescribeClusters` - Get cluster information
- `ecs:RunTask` - Execute migration tasks

### IAM Permissions

- `iam:PassRole` - Pass role when executing ECS tasks

### Other

- `sts:GetCallerIdentity` - Get AWS account information

## Database Migration

Database migrations are automatically executed during backend deployment.

### Migration Mechanism

1. **Dedicated Migration Task Definition**
   - Uses the same Docker image as backend
   - Command: `sh scripts/migrate.sh`
   - DB migration using Alembic (`alembic upgrade head`)

2. **Execution Timing**
   - After backend image build and push
   - Before ECS service update

3. **Behavior on Failure**
   - Deployment is cancelled if migration fails
   - Service is not updated (no rollback needed)

### Manual Migration Execution

For emergencies or specific migration execution:

```bash
# Connect to backend container using ECS Exec
aws ecs execute-command \
  --cluster sample-app-{env}-cluster \
  --task {TASK_ID} \
  --container backend \
  --interactive \
  --command "/bin/sh"

# Execute migration inside container
sh scripts/migrate.sh
```

## Security Best Practices

1. **Use OIDC Authentication**
   - No long-term access keys
   - Uses temporary authentication tokens from GitHub

2. **Branch Restrictions**
   - Only executable from `main` and `develop` branches
   - Cannot be executed from other branches

3. **Principle of Least Privilege**
   - Only minimum necessary permissions for deployment

4. **Concurrent Execution Control**
   - Multiple deployments to the same branch are automatically cancelled
   - Only the latest commit is deployed

5. **Migration Safety**
   - Deployment is automatically cancelled on migration failure
   - Executed before service update, so no rollback needed

## Troubleshooting

### When Deployment Fails

1. **Verify IAM Role**
   ```bash
   aws iam get-role --role-name sample-app-github-actions-deploy-role
   ```

2. **Verify OIDC Provider**
   ```bash
   aws iam list-open-id-connect-providers
   ```

3. **Check GitHub Actions Logs**
   - Check error logs in GitHub Actions tab

4. **Verify ECR Repository**
   ```bash
   aws ecr describe-repositories --region {region}
   ```

5. **Verify ECS Service**
   ```bash
   aws ecs describe-services \
     --cluster sample-app-{env}-cluster \
     --services sample-app-{env}-frontend-svc \
     --region {region}
   ```

### Common Errors

**Error: "Not authorized to perform sts:AssumeRoleWithWebIdentity"**
- Cause: OIDC provider not correctly configured
- Solution: Redeploy CDK stack

**Error: "Repository does not exist"**
- Cause: ECR repository doesn't exist
- Solution: Deploy ECR stack

**Error: "Service does not exist"**
- Cause: ECS service doesn't exist
- Solution: Deploy ECS stack

## Deployment Scripts

### For DEV Environment
- `frontend/deploy-to-dev-ecs.sh`
- `backend/deploy-to-dev-ecs.sh`

### For Production Environment
- `frontend/deploy-to-prod-ecs.sh`
- `backend/deploy-to-prod-ecs.sh`

These scripts automatically execute Docker image build, ECR push, and ECS service update.

## Change History

- Initial version created
