import type { ObjectStorage, PrivateObjectWrite } from "./port";

export class MemoryObjectStorage implements ObjectStorage {
  private readonly objects = new Map<string, Array<{
    bytes: Uint8Array;
    contentType: string;
    versionToken: string;
  }>>();
  private nextVersion = 1;

  async putPrivate(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    await this.putPrivateVersioned(key, bytes, contentType);
  }

  async putPrivateVersioned(key: string, bytes: Uint8Array,
    contentType: string): Promise<PrivateObjectWrite> {
    const versionToken = `memory:${this.nextVersion++}`;
    const versions = this.objects.get(key) ?? [];
    versions.push({ bytes: bytes.slice(), contentType, versionToken });
    this.objects.set(key, versions);
    return { versionToken };
  }

  async getPrivate(key: string): Promise<Uint8Array> {
    const versions = this.objects.get(key);
    const object = versions?.[versions.length - 1];
    if (!object) throw new Error("Private object not found");
    return object.bytes.slice();
  }

  async getPrivateVersion(key: string, versionToken: string): Promise<Uint8Array> {
    const object = this.objects.get(key)?.find((candidate) => candidate.versionToken === versionToken);
    if (!object) throw new Error("Private object version not found");
    return object.bytes.slice();
  }

  async deletePrivate(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async purgePrivate(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async deletePrivateVersion(key: string, versionToken: string): Promise<boolean> {
    const versions = this.objects.get(key);
    const index = versions?.findIndex((object) => object.versionToken === versionToken) ?? -1;
    if (!versions || index < 0) return false;
    versions.splice(index, 1);
    if (versions.length === 0) this.objects.delete(key);
    return true;
  }
}
