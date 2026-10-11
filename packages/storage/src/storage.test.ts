import { describe, expect, it, vi } from "vitest";
import { DeleteObjectsCommand, GetBucketVersioningCommand, ListObjectVersionsCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import type { DeleteObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";

import { MemoryObjectStorage } from "./memory-storage";
import { S3ObjectStorage } from "./s3-storage";

describe("private object storage adapters", () => {
  it("uses a private encrypted S3 put without producing a provider URL", async () => {
    const commands: PutObjectCommand[] = [];
    const storage = new S3ObjectStorage({
      bucket: "private-scripts",
      serverSideEncryption: "AES256",
      client: {
        async send(command) {
          commands.push(command as PutObjectCommand);
          return { VersionId: "s3-version-1" };
        },
      },
    });

    const result = await storage.putPrivate(
      "users/u/plays/p/source/f",
      new Uint8Array([4, 5, 6]),
      "application/pdf",
    );

    expect(result).toBeUndefined();
    expect(commands).toHaveLength(1);
    expect(commands[0]!.input).toMatchObject({
      Bucket: "private-scripts",
      Key: "users/u/plays/p/source/f",
      ContentType: "application/pdf",
      ACL: "private",
      ServerSideEncryption: "AES256",
    });
  });

  it("omits the encryption request only when local storage is explicitly configured without KMS", async () => {
    const commands: PutObjectCommand[] = [];
    const previous = process.env.S3_SERVER_SIDE_ENCRYPTION;
    process.env.S3_SERVER_SIDE_ENCRYPTION = "none";
    try {
      const storage = new S3ObjectStorage({ bucket: "private-scripts", client: {
        async send(command) {
          commands.push(command as PutObjectCommand);
          return {};
        },
      } });
      await storage.putPrivate("users/u/plays/p/source/f", new Uint8Array([1]), "application/pdf");
    } finally {
      if (previous === undefined) delete process.env.S3_SERVER_SIDE_ENCRYPTION;
      else process.env.S3_SERVER_SIDE_ENCRYPTION = previous;
    }
    expect(commands[0]!.input).not.toHaveProperty("ServerSideEncryption");
  });

  it("refuses the unencrypted local-storage setting in production", () => {
    vi.stubEnv("S3_SERVER_SIDE_ENCRYPTION", "none");
    vi.stubEnv("NODE_ENV", "production");
    try {
      expect(() => new S3ObjectStorage({ bucket: "private-scripts", client: { async send() { return {}; } } }))
        .toThrow("S3_SERVER_SIDE_ENCRYPTION=none is not allowed in production");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("loads private S3 bytes without exposing a provider URL", async () => {
    const commands: GetObjectCommand[] = [];
    const storage = new S3ObjectStorage({ bucket: "private-scripts", client: {
      async send(command) {
        commands.push(command as GetObjectCommand);
        return { Body: { async transformToByteArray() { return new Uint8Array([7, 8, 9]); } } };
      },
    } });

    await expect(storage.getPrivate("users/u/plays/p/source/f")).resolves.toEqual(new Uint8Array([7, 8, 9]));
    expect(commands[0]!.input).toMatchObject({ Bucket: "private-scripts", Key: "users/u/plays/p/source/f" });
  });

  it("loads the exact S3 version registered for a measurement artifact", async () => {
    // Break caught: omitting VersionId from a read allows newer bytes at the same key to replace registered audio.
    const commands: GetObjectCommand[] = [];
    const storage = new S3ObjectStorage({ bucket: "private-scripts", client: {
      async send(command) {
        commands.push(command as GetObjectCommand);
        return { Body: { async transformToByteArray() { return new Uint8Array([7, 8, 9]); } } };
      },
    } });

    await expect(storage.getPrivateVersion("users/u/plays/p/source/f", "s3-version:registered%2Fversion"))
      .resolves.toEqual(new Uint8Array([7, 8, 9]));

    expect(commands[0]!.input).toMatchObject({ Bucket: "private-scripts", Key: "users/u/plays/p/source/f",
      VersionId: "registered/version" });
  });

  it("deletes a private S3 object for failed-write compensation", async () => {
    const commands: DeleteObjectCommand[] = [];
    const storage = new S3ObjectStorage({ bucket: "private-scripts", client: {
      async send(command) {
        commands.push(command as DeleteObjectCommand);
        return {};
      },
    } });

    await expect(storage.deletePrivate("users/u/plays/p/takes/t")).resolves.toBeUndefined();

    expect(commands[0]!.input).toEqual({ Bucket: "private-scripts", Key: "users/u/plays/p/takes/t" });
  });

  it("permanently deletes every retained S3 version and delete marker for account deletion", async () => {
    const commands: Array<ListObjectVersionsCommand | DeleteObjectsCommand> = [];
    const storage = new S3ObjectStorage({ bucket: "private-scripts", client: {
      async send(command) {
        commands.push(command as ListObjectVersionsCommand | DeleteObjectsCommand);
        if (command instanceof ListObjectVersionsCommand) return {
          Versions: [{ Key: "users/u/plays/p/source/original", VersionId: "prior-version" }],
          DeleteMarkers: [{ Key: "users/u/plays/p/source/original", VersionId: "delete-marker" }],
        };
        return {};
      },
    } });

    await expect(storage.purgePrivate("users/u/plays/p/source/original")).resolves.toBeUndefined();
    expect(commands[0]!.input).toEqual({ Bucket: "private-scripts", Prefix: "users/u/plays/p/source/original" });
    expect(commands[1]).toBeInstanceOf(DeleteObjectsCommand);
    expect((commands[1] as DeleteObjectsCommand).input).toEqual({ Bucket: "private-scripts", Delete: {
      Objects: [
        { Key: "users/u/plays/p/source/original", VersionId: "prior-version" },
        { Key: "users/u/plays/p/source/original", VersionId: "delete-marker" },
      ], Quiet: true,
    } });
  });

  it("conditionally deletes only the exact S3 version written by an attempt", async () => {
    const commands: DeleteObjectCommand[] = [];
    const storage = new S3ObjectStorage({ bucket: "private-scripts", client: {
      async send(command) {
        commands.push(command as DeleteObjectCommand);
        return {};
      },
    } });

    await expect(storage.deletePrivateVersion(
      "users/u/plays/p/takes/t/normalized.wav", "s3-version:written-version",
    )).resolves.toBe(true);
    expect(commands[0]!.input).toEqual({
      Bucket: "private-scripts",
      Key: "users/u/plays/p/takes/t/normalized.wav",
      VersionId: "written-version",
    });
    await expect(storage.deletePrivateVersion(
      "users/u/plays/p/takes/t/normalized.wav", "s3-version:%not-encoded",
    )).resolves.toBe(false);
    await expect(storage.deletePrivateVersion(
      "users/u/plays/p/takes/t/normalized.wav", "s3-version:null",
    )).resolves.toBe(false);
    await expect(storage.deletePrivateVersion(
      "users/u/plays/p/takes/t/normalized.wav", "s3-version:",
    )).resolves.toBe(false);
    expect(commands).toHaveLength(1);
  });

  it("returns the exact S3 object version required for conditional compensation", async () => {
    const commands: Array<GetBucketVersioningCommand | PutObjectCommand> = [];
    const storage = new S3ObjectStorage({ bucket: "private-scripts", client: {
      async send(command) {
        commands.push(command as GetBucketVersioningCommand | PutObjectCommand);
        return command instanceof GetBucketVersioningCommand
          ? { Status: "Enabled" }
          : { VersionId: "write/with+symbols=" };
      },
    } });

    await expect(storage.putPrivateVersioned(
      "users/u/plays/p/takes/t/normalized.wav", new Uint8Array([1]), "audio/wav",
    )).resolves.toEqual({ versionToken: "s3-version:write%2Fwith%2Bsymbols%3D" });
    expect(commands[1]).toBeInstanceOf(PutObjectCommand);
    expect((commands[1] as PutObjectCommand).input.IfNoneMatch).toBe("*");
  });

  it("does not delete a newer memory object through an older attempt token", async () => {
    const storage = new MemoryObjectStorage();
    const first = await storage.putPrivateVersioned(
      "canonical/normalized.wav", new Uint8Array([1]), "audio/wav");
    const newer = await storage.putPrivateVersioned(
      "canonical/normalized.wav", new Uint8Array([2]), "audio/wav");

    await expect(storage.deletePrivateVersion("canonical/normalized.wav", first.versionToken))
      .resolves.toBe(true);
    await expect(storage.getPrivate("canonical/normalized.wav")).resolves.toEqual(new Uint8Array([2]));
    await expect(storage.deletePrivateVersion("canonical/normalized.wav", "memory:not-a-version"))
      .resolves.toBe(false);
    await expect(storage.deletePrivateVersion("canonical/normalized.wav", newer.versionToken))
      .resolves.toBe(true);
    await expect(storage.getPrivate("canonical/normalized.wav")).rejects.toThrow("Private object not found");
  });

  it("loads only the registered memory version when a canonical key has newer bytes", async () => {
    // Break caught: a measurement worker reading the latest key version can analyze bytes different from its registered artifact.
    const storage = new MemoryObjectStorage();
    const first = await storage.putPrivateVersioned("canonical/normalized.wav", new Uint8Array([1]), "audio/wav");
    await storage.putPrivateVersioned("canonical/normalized.wav", new Uint8Array([2]), "audio/wav");

    await expect(storage.getPrivateVersion("canonical/normalized.wav", first.versionToken))
      .resolves.toEqual(new Uint8Array([1]));
  });

  it("rejects a versioned S3 write when bucket versioning does not return an exact token", async () => {
    const storage = new S3ObjectStorage({ bucket: "private-scripts", client: {
      async send(command) {
        return command instanceof GetBucketVersioningCommand ? { Status: "Enabled" } : { ETag: "content-only-etag" };
      },
    } });

    await expect(storage.putPrivateVersioned(
      "canonical/normalized.wav", new Uint8Array([1]), "audio/wav"))
      .rejects.toThrow("S3 bucket versioning is required");
  });

  it("rejects the S3 null-version sentinel returned by a suspended versioning bucket", async () => {
    const storage = new S3ObjectStorage({ bucket: "private-scripts", client: {
      async send(command) {
        return command instanceof GetBucketVersioningCommand ? { Status: "Enabled" } : { VersionId: "null" };
      },
    } });

    await expect(storage.putPrivateVersioned(
      "canonical/normalized.wav", new Uint8Array([1]), "audio/wav"))
      .rejects.toThrow("S3 bucket versioning is required");
  });

  it("proves bucket versioning before any canonical versioned write", async () => {
    // Break caught: putting canonical bytes before confirming versioning can overwrite an object that exact cleanup cannot target.
    const commands: Array<GetBucketVersioningCommand | PutObjectCommand> = [];
    const storage = new S3ObjectStorage({ bucket: "private-scripts", client: {
      async send(command) {
        commands.push(command as GetBucketVersioningCommand | PutObjectCommand);
        return { Status: "Suspended" };
      },
    } });

    await expect(storage.putPrivateVersioned(
      "users/u/plays/p/takes/t/transcripts/x/normalized.wav", new Uint8Array([1]), "audio/wav",
    )).rejects.toMatchObject({ code: "S3_BUCKET_VERSIONING_REQUIRED" });
    expect(commands).toHaveLength(1);
    expect(commands[0]).toBeInstanceOf(GetBucketVersioningCommand);
  });
});
