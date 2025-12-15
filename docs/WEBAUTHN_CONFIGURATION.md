# WebAuthn Environment Variables Management Guide

## Overview

Environment variables required for WebAuthn authentication (`WEBAUTHN_RP_ID`, `WEBAUTHN_ORIGIN`, `STRICT_WEBAUTHN_VERIFY`) are managed in AWS Systems Manager Parameter Store.

Benefits:

- ✅ Change environment variables without redeployment
- ✅ Flexible management of different values per environment
- ✅ Audit logs available
- ✅ Zero cost (standard Parameter Store)

## Parameter List

Three parameters are created for each environment:

| Parameter Name | Description | Example |
|----------------|-------------|---------|
| `/sample-app/{env}/webauthn/rp-id` | WebAuthn Relying Party ID | `dev.example.com` |
| `/sample-app/{env}/webauthn/origin` | WebAuthn Origin URL | `https://dev.example.com/` |
| `/sample-app/{env}/webauthn/strict-verify` | Enable strict verification | `true` or `false` |

## Management Script Usage

### 1. Check Current Settings

```bash
cd infrastructure-cdk/scripts
./manage-webauthn-params.sh get <environment>
```

**Example: Check production settings**
```bash
./manage-webauthn-params.sh get prod
```

### 2. Set or Update Parameters

```bash
./manage-webauthn-params.sh set <environment> \
  --rp-id <RP_ID> \
  --origin <ORIGIN_URL> \
  --strict-verify <true|false>
```

**Example 1: Set new production environment**
```bash
./manage-webauthn-params.sh set prod \
  --rp-id example.com \
  --origin https://example.com/ \
  --strict-verify true
```

**Example 2: Update only RP_ID for dev environment**
```bash
./manage-webauthn-params.sh set dev \
  --rp-id dev.example.com
```

**Example 3: Specify different AWS region**
```bash
./manage-webauthn-params.sh set prod \
  --rp-id example.com \
  --origin https://example.com/ \
  --region us-east-1
```

### 3. Delete Parameters

```bash
./manage-webauthn-params.sh delete <environment>
```

**Example: Delete dev environment settings**
```bash
./manage-webauthn-params.sh delete dev
```

## Applying Changes

Changing Parameter Store values does not automatically reflect in running ECS tasks.
To apply changes, you need to restart the ECS service.

### Restart Backend Service

```bash
aws ecs update-service \
  --cluster sample-app-<environment>-cluster \
  --service sample-app-<environment>-backend-svc \
  --force-new-deployment \
  --region {region}
```

### Restart Job Service

```bash
aws ecs update-service \
  --cluster sample-app-<environment>-cluster \
  --service sample-app-<environment>-job-svc \
  --force-new-deployment \
  --region {region}
```

**Example: Restart production environment**
```bash
aws ecs update-service \
  --cluster sample-app-prod-cluster \
  --service sample-app-prod-backend-svc \
  --force-new-deployment \
  --region {region}
```

## Default Values (CDK Deployment)

When deploying the ECS stack with CDK, parameters are created with the following default values:

### Dev Environment
```
WEBAUTHN_RP_ID = "dev.example.com"
WEBAUTHN_ORIGIN = "https://dev.example.com/"
STRICT_WEBAUTHN_VERIFY = "true"
```

### Prod Environment
```
WEBAUTHN_RP_ID = "example.com"
WEBAUTHN_ORIGIN = "https://example.com/"
STRICT_WEBAUTHN_VERIFY = "true"
```

### Staging Environment
```
WEBAUTHN_RP_ID = "staging.example.com"
WEBAUTHN_ORIGIN = "https://staging.example.com/"
STRICT_WEBAUTHN_VERIFY = "true"
```

## Troubleshooting

### Issue: WebAuthn authentication fails

**Cause 1: RP_ID and Origin don't match the domain**

According to WebAuthn specification, `WEBAUTHN_RP_ID` must match the accessed domain.

- ✅ Correct example:
  - Access URL: `https://example.com/`
  - RP_ID: `example.com`
  - Origin: `https://example.com/`

- ❌ Incorrect example:
  - Access URL: `https://example.com/`
  - RP_ID: `dev.example.com` (different domain)

**Solution:**
```bash
# Update to correct values
./manage-webauthn-params.sh set prod \
  --rp-id example.com \
  --origin https://example.com/

# Restart ECS service
aws ecs update-service \
  --cluster sample-app-prod-cluster \
  --service sample-app-prod-backend-svc \
  --force-new-deployment \
  --region {region}
```

**Cause 2: ECS service not restarted after parameter change**

Changing Parameter Store values doesn't reflect in running containers.

**Solution:**
Refer to "Applying Changes" section above to restart the ECS service.

### Issue: Parameters not found (unset)

**Cause: ECS stack not yet deployed with CDK**

WebAuthn parameters are automatically created when deploying the ECS stack.

**Solution:**
```bash
cd infrastructure-cdk
npm run cdk deploy sample-app-<environment>-ecs-stack
```

Or manually create parameters:
```bash
./scripts/manage-webauthn-params.sh set <environment> \
  --rp-id <your-domain> \
  --origin https://<your-domain>/ \
  --strict-verify true
```

### Issue: Running multiple production environments

**Solution:**

When running multiple production environments with different domains, set appropriate values for each environment.

Example:
- `prod` environment: `example.com`
- New production stack: `app.example.com`

When deploying a new stack:
1. Define a new environment (e.g., `prod2`) in CDK configuration
2. Set WebAuthn parameters

```bash
./manage-webauthn-params.sh set prod2 \
  --rp-id app.example.com \
  --origin https://app.example.com/ \
  --strict-verify true
```

## Verification via AWS Console

You can also verify and modify settings through the AWS Management Console:

1. Log in to AWS Console
2. Open **Systems Manager** service
3. Select **Parameter Store** from left menu
4. Search for `/sample-app/`
5. Select parameter to view or edit value

## Security Considerations

- WebAuthn settings are not sensitive information, so they're managed in standard Parameter Store (unencrypted)
- Zero cost (Standard tier)
- Parameter change history is auditable through CloudTrail

## References

- [WebAuthn Specification](https://www.w3.org/TR/webauthn/)
- [AWS Systems Manager Parameter Store](https://docs.aws.amazon.com/systems-manager/latest/userguide/systems-manager-parameter-store.html)
