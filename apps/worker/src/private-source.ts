import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";

type PrivateSourceBody = {
  transformToByteArray(): Promise<Uint8Array>;
};

type GetObjectClient = {
  send(command: GetObjectCommand): Promise<{ Body?: PrivateSourceBody }>;
};

export class S3PrivateSourceLoader {
  private readonly client: GetObjectClient;

  constructor(private readonly options: { bucket: string; client?: GetObjectClient }) {
    this.client = options.client ?? new S3Client({
      ...(process.env.AWS_ENDPOINT_URL_S3?.trim() ? { forcePathStyle: true } : {}),
    });
  }

  async load(objectKey: string): Promise<Uint8Array> {
    const result = await this.client.send(new GetObjectCommand({
      Bucket: this.options.bucket,
      Key: objectKey,
    }));
    if (!result.Body) throw new Error("Private source object has no body");
    return result.Body.transformToByteArray();
  }
}
