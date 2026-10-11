import { GetObjectCommand } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";

import { S3PrivateSourceLoader } from "./private-source";

describe("private worker source loading", () => {
  it("loads bytes from the configured private bucket without exposing a URL", async () => {
    const commands: GetObjectCommand[] = [];
    const loader = new S3PrivateSourceLoader({
      bucket: "private-scripts",
      client: {
        async send(command) {
          commands.push(command);
          return { Body: { transformToByteArray: async () => new Uint8Array([4, 5, 6]) } };
        },
      },
    });

    await expect(loader.load("users/u/plays/p/source/f")).resolves.toEqual(new Uint8Array([4, 5, 6]));
    expect(commands[0]!.input).toEqual({ Bucket: "private-scripts", Key: "users/u/plays/p/source/f" });
  });
});
