import { sha256Bytes } from "@verified-action-protocol/protocol";
import type { ArtifactRef } from "@verified-action-protocol/protocol";
import { redactString } from "./redact.js";

/**
 * Private evidence artifact storage. Artifacts are redacted before storage, addressed by
 * digest and an authorized object id, and never exposed through public URLs.
 */
export interface ArtifactStore {
  readonly kind: string;
  put(content: string, mediaType: string, labels: Record<string, string>): Promise<ArtifactRef>;
  get(objectId: string): Promise<{ content: string; mediaType: string } | null>;
}

export const MAX_ARTIFACT_BYTES = 1024 * 1024;

export function prepareArtifact(content: string): { body: string; digest: string; bytes: number } {
  let body = redactString(content, MAX_ARTIFACT_BYTES);
  if (Buffer.byteLength(body) > MAX_ARTIFACT_BYTES) body = body.slice(0, MAX_ARTIFACT_BYTES / 2);
  return { body, digest: sha256Bytes(body), bytes: Buffer.byteLength(body) };
}

/**
 * Google Cloud Storage implementation using the JSON API and the workload identity
 * token from the metadata server. The bucket must be private (uniform bucket-level
 * access, public access prevention enforced); see infra/gcp.
 */
export class GcsArtifactStore implements ArtifactStore {
  readonly kind = "gcs";
  constructor(
    private readonly bucket: string,
    private readonly tokenProvider: () => Promise<string>,
    private readonly prefix = "evidence/",
  ) {}

  async put(content: string, mediaType: string, labels: Record<string, string>): Promise<ArtifactRef> {
    const a = prepareArtifact(content);
    const name = `${this.prefix}${a.digest.slice("sha256:".length)}`;
    const url = `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(this.bucket)}/o?uploadType=media&name=${encodeURIComponent(name)}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${await this.tokenProvider()}`, "content-type": mediaType, "x-goog-meta-vap-labels": JSON.stringify(labels).slice(0, 1024) },
      body: a.body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`artifact upload failed with HTTP ${res.status}`);
    return { digest: a.digest, object_id: `gcs:${name}`, bytes: a.bytes };
  }

  async get(objectId: string): Promise<{ content: string; mediaType: string } | null> {
    if (!objectId.startsWith("gcs:")) return null;
    const name = objectId.slice(4);
    const url = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(this.bucket)}/o/${encodeURIComponent(name)}?alt=media`;
    const res = await fetch(url, { headers: { authorization: `Bearer ${await this.tokenProvider()}` }, signal: AbortSignal.timeout(10_000) });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`artifact read failed with HTTP ${res.status}`);
    return { content: await res.text(), mediaType: res.headers.get("content-type") ?? "application/octet-stream" };
  }
}

/** Fetches an access token for the workload's service account from the GCE/Cloud Run metadata server. */
export async function metadataAccessToken(): Promise<string> {
  const res = await fetch("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token", {
    headers: { "metadata-flavor": "Google" },
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) throw new Error(`metadata token request failed with HTTP ${res.status}`);
  const body = (await res.json()) as { access_token?: string };
  if (!body.access_token) throw new Error("metadata server returned no access token");
  return body.access_token;
}

/** Fetches an OIDC identity token for the given audience from the metadata server. */
export async function metadataIdentityToken(audience: string): Promise<string> {
  const url = `http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=${encodeURIComponent(audience)}&format=full`;
  const res = await fetch(url, { headers: { "metadata-flavor": "Google" }, signal: AbortSignal.timeout(5_000) });
  if (!res.ok) throw new Error(`metadata identity request failed with HTTP ${res.status}`);
  return (await res.text()).trim();
}
