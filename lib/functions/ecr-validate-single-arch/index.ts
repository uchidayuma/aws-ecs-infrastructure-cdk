import { ECRClient, DescribeImagesCommand } from '@aws-sdk/client-ecr';

type Event = {
  RequestType: 'Create' | 'Update' | 'Delete';
  ResourceProperties: {
    RepositoryName: string;
    ImageTag: string;
    ResourceVersion?: string;
  };
};

export const handler = async (event: Event) => {
  if (event.RequestType === 'Delete') return { PhysicalResourceId: 'ecr-validate-single-arch' };

  const repo = event.ResourceProperties.RepositoryName;
  const tag = event.ResourceProperties.ImageTag || 'latest';

  const client = new ECRClient({});
  const res = await client.send(
    new DescribeImagesCommand({ repositoryName: repo, imageIds: [{ imageTag: tag }] })
  );

  const details = res.imageDetails?.[0];
  if (!details) {
    throw new Error(`ECR tag not found: ${repo}:${tag}. Push the image before deploy.`);
  }

  const artifactType = (details as any).artifactMediaType as string | undefined;
  const manifestType = (details as any).imageManifestMediaType as string | undefined;

  const isIndex = (v?: string) =>
    !!v && (v.includes('manifest.list') || v.includes('image.index'));

  if (isIndex(artifactType) || isIndex(manifestType)) {
    throw new Error(
      `Repository '${repo}' tag '${tag}' is a multi-arch Image Index (${artifactType || manifestType}). Please push a single-arch (linux/amd64) image.`
    );
  }

  return { PhysicalResourceId: 'ecr-validate-single-arch' };
};

