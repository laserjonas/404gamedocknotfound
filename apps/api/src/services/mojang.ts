import { badRequest } from '../errors.js';

/**
 * Resolves a user-chosen Minecraft version string to a concrete server.jar
 * download URL via Mojang's official version manifest, so templates can
 * offer a version picker instead of hardcoding one download URL.
 */

const MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';

interface VersionManifest {
  latest: { release: string; snapshot: string };
  versions: { id: string; url: string }[];
}

interface VersionMetadata {
  downloads?: { server?: { url: string } };
  javaVersion?: { majorVersion: number };
}

export interface ResolvedMinecraftVersion {
  version: string;
  url: string;
  /** JDK major version this build needs to run (e.g. 21). */
  javaMajorVersion: number;
}

/**
 * Fallback when a version's metadata predates the "javaVersion" field
 * (introduced around 1.18). Only reached for old releases, which all run
 * fine on Java 8.
 */
const DEFAULT_JAVA_MAJOR_VERSION = 8;

export async function resolveMinecraftServerJarUrl(
  versionSelector: string,
): Promise<ResolvedMinecraftVersion> {
  const manifestRes = await fetch(MANIFEST_URL);
  if (!manifestRes.ok) {
    throw new Error(
      `Failed to fetch Minecraft version manifest: HTTP ${manifestRes.status} ${manifestRes.statusText}`,
    );
  }
  const manifest = (await manifestRes.json()) as VersionManifest;

  const selector = versionSelector.trim().toLowerCase();
  let versionId = versionSelector.trim();
  if (selector === '' || selector === 'latest-release') {
    versionId = manifest.latest.release;
  } else if (selector === 'latest-snapshot') {
    versionId = manifest.latest.snapshot;
  }

  const entry = manifest.versions.find((v) => v.id === versionId);
  if (!entry) {
    throw badRequest(
      `Unknown Minecraft version "${versionSelector}". Use an exact version id ` +
        '(e.g. "1.21.4"), "latest-release", or "latest-snapshot".',
    );
  }

  const versionRes = await fetch(entry.url);
  if (!versionRes.ok) {
    throw new Error(
      `Failed to fetch metadata for Minecraft ${versionId}: HTTP ${versionRes.status} ${versionRes.statusText}`,
    );
  }
  const metadata = (await versionRes.json()) as VersionMetadata;
  const serverUrl = metadata.downloads?.server?.url;
  if (!serverUrl) {
    throw badRequest(
      `Minecraft version "${versionId}" does not provide a server download (too old). ` +
        'Choose a newer version - server downloads are available starting around 1.2.5.',
    );
  }

  return {
    version: versionId,
    url: serverUrl,
    javaMajorVersion: metadata.javaVersion?.majorVersion ?? DEFAULT_JAVA_MAJOR_VERSION,
  };
}
