import { DeleteObjectCommand, DeleteObjectsCommand, GetBucketVersioningCommand, GetObjectCommand,
  ListObjectVersionsCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

import type { ObjectStorage, PrivateObjectWrite } from "./port";

type S3CommandClient = {
  send(command: PutObjectCommand | GetObjectCommand | DeleteObjectCommand | DeleteObjectsCommand
    | GetBucketVersioningCommand | ListObjectVersionsCommand): Promise<unknown>;
};

export class S3BucketVersioningRequiredError extends Error {
  readonly code = "S3_BUCKET_VERSIONING_REQUIRED";

  constructor() {
    super("S3 bucket versioning is required for exact private-object compensation");
    this.name = "S3BucketVersioningRequiredError";
  }
}

export type S3ObjectStorageOptions = {
  bucket: string;
  client?: S3CommandClient;
  /** Use false only for local development without a KMS. */
  serverSideEncryption?: "AES256" | false;
};

export class S3ObjectStorage implements ObjectStorage {
  private readonly bucket: string;
  private readonly client: S3CommandClient;
  private readonly serverSideEncryption: "AES256" | undefined;

  constructor(options: S3ObjectStorageOptions) {
    this.bucket = options.bucket;
    this.client = options.client ?? new S3Client({
      ...(process.env.AWS_ENDPOINT_URL_S3?.trim() ? { forcePathStyle: true } : {}),
    });
    this.serverSideEncryption = options.serverSideEncryption === false
      ? undefined
      : options.serverSideEncryption ?? configuredServerSideEncryption();
  }

  async putPrivate(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    await this.put(key, bytes, contentType);
  }

  async putPrivateVersioned(key: string, bytes: Uint8Array,
    contentType: string): Promise<PrivateObjectWrite> {
    const versioning = await this.client.send(new GetBucketVersioningCommand({ Bucket: this.bucket })) as {
      Status?: string;
    };
    if (versioning.Status !== "Enabled") {
      throw new S3BucketVersioningRequiredError();
    }
    const response = await this.put(key, bytes, contentType, true);
    if (!isExactS3VersionId(response.VersionId)) {
      throw new S3BucketVersioningRequiredError();
    }
    return { versionToken: `s3-version:${encodeURIComponent(response.VersionId)}` };
  }

  private async put(key: string, bytes: Uint8Array, contentType: string,
    requireEmptyKey = false): Promise<{ VersionId?: string }> {
    return await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: bytes,
      ContentType: contentType,
      ACL: "private",
      ...(this.serverSideEncryption ? { ServerSideEncryption: this.serverSideEncryption } : {}),
      ...(requireEmptyKey ? { IfNoneMatch: "*" } : {}),
    })) as { VersionId?: string };
  }

  async getPrivate(key: string): Promise<Uint8Array> {
    return this.readObject(key);
  }

  async getPrivateVersion(key: string, versionToken: string): Promise<Uint8Array> {
    const versionId = versionIdFromToken(versionToken);
    if (!versionId) throw new Error("Private object version is invalid");
    return this.readObject(key, versionId);
  }

  private async readObject(key: string, versionId?: string): Promise<Uint8Array> {
    const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key,
      ...(versionId ? { VersionId: versionId } : {}) })) as {
      Body?: { transformToByteArray?: () => Promise<Uint8Array> };
    };
    if (!response.Body?.transformToByteArray) throw new Error("Private object body is unavailable");
    return response.Body.transformToByteArray();
  }

  async deletePrivate(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async purgePrivate(key: string): Promise<void> {
    let keyMarker: string | undefined;
    let versionIdMarker: string | undefined;
    for (;;) {
      const page = await this.client.send(new ListObjectVersionsCommand({ Bucket: this.bucket, Prefix: key,
        ...(keyMarker ? { KeyMarker: keyMarker } : {}),
        ...(versionIdMarker ? { VersionIdMarker: versionIdMarker } : {}),
      })) as {
        Versions?: Array<{ Key?: string; VersionId?: string }>;
        DeleteMarkers?: Array<{ Key?: string; VersionId?: string }>;
        IsTruncated?: boolean;
        NextKeyMarker?: string;
        NextVersionIdMarker?: string;
      };
      const versions = [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])]
        .filter((entry): entry is { Key: string; VersionId: string } => entry.Key === key
          && isExactS3VersionId(entry.VersionId));
      if (versions.length > 0) {
        const result = await this.client.send(new DeleteObjectsCommand({ Bucket: this.bucket,
          Delete: { Objects: versions.map(({ Key, VersionId }) => ({ Key, VersionId })), Quiet: true },
        })) as { Errors?: Array<{ Key?: string; VersionId?: string; Code?: string }> };
        if (result.Errors?.length) throw new Error("S3 private object purge failed");
      }
      if (!page.IsTruncated) return;
      if (!page.NextKeyMarker) throw new Error("S3 private object purge pagination is invalid");
      keyMarker = page.NextKeyMarker;
      versionIdMarker = page.NextVersionIdMarker;
    }
  }

  async deletePrivateVersion(key: string, versionToken: string): Promise<boolean> {
    const versionId = versionIdFromToken(versionToken);
    if (!versionId) return false;
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key, VersionId: versionId }));
      return true;
    } catch (error) {
      const response = error as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (response.name === "NoSuchVersion" || response.$metadata?.httpStatusCode === 404) return false;
      throw error;
    }
  }
}

function versionIdFromToken(versionToken: string): string | null {
  const prefix = "s3-version:";
  if (!versionToken.startsWith(prefix)) return null;
  try {
    const versionId = decodeURIComponent(versionToken.slice(prefix.length));
    return isExactS3VersionId(versionId) ? versionId : null;
  } catch {
    return null;
  }
}

function isExactS3VersionId(versionId: string | undefined): versionId is string {
  return versionId !== undefined && versionId !== "null" && versionId.length > 0 &&
    versionId.trim() === versionId && Array.from(versionId).every((character) => {
      const codePoint = character.codePointAt(0)!;
      return codePoint >= 32 && codePoint !== 127;
    });
}

function configuredServerSideEncryption(): "AES256" | undefined {
  const setting = process.env.S3_SERVER_SIDE_ENCRYPTION?.trim().toLowerCase();
  if (!setting || setting === "aes256") return "AES256";
  if (setting === "none") {
    if (process.env.NODE_ENV === "production") {
      throw new Error("S3_SERVER_SIDE_ENCRYPTION=none is not allowed in production");
    }
    return undefined;
  }
  throw new Error("S3_SERVER_SIDE_ENCRYPTION must be AES256 or none");
}
