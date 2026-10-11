export type PrivateObjectWrite = {
  /** Opaque conditional token identifying only the version written by this call. */
  versionToken: string;
};

export interface ObjectStorage {
  putPrivate(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  /** Writes an object and requires an exact provider version token for later compensation. */
  putPrivateVersioned(key: string, bytes: Uint8Array, contentType: string): Promise<PrivateObjectWrite>;
  getPrivate(key: string): Promise<Uint8Array>;
  /** Reads precisely a registered immutable version when the provider exposes versioned reads. */
  getPrivateVersion?(key: string, versionToken: string): Promise<Uint8Array>;
  deletePrivate(key: string): Promise<void>;
  /** Permanently removes every provider-retained version and delete marker for one private key. */
  purgePrivate(key: string): Promise<void>;
  /** Deletes exactly the identified version, returning false when it is absent or no longer matches. */
  deletePrivateVersion(key: string, versionToken: string): Promise<boolean>;
}
