import type { Pool } from "pg";
import type { ArtifactRef } from "@verified-action-protocol/protocol";
import { prepareArtifact } from "@verified-action-protocol/core";
import type { ArtifactStore } from "@verified-action-protocol/core";

/**
 * Bounded inline artifact store in the journal database, used when no private bucket is
 * configured (ephemeral demo, tests). Content is redacted and size-capped before storage.
 */
export class PgArtifactStore implements ArtifactStore {
  readonly kind = "postgres";
  constructor(private readonly pool: Pool) {}

  async put(content: string, mediaType: string, labels: Record<string, string>): Promise<ArtifactRef> {
    const a = prepareArtifact(content);
    const objectId = `pg:${a.digest.slice("sha256:".length)}`;
    await this.pool.query(
      "INSERT INTO artifacts (object_id, digest, media_type, bytes, content, labels) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (object_id) DO NOTHING",
      [objectId, a.digest, mediaType, a.bytes, a.body, JSON.stringify(labels)],
    );
    return { digest: a.digest, object_id: objectId, bytes: a.bytes };
  }

  async get(objectId: string): Promise<{ content: string; mediaType: string } | null> {
    const r = await this.pool.query<{ content: string; media_type: string }>("SELECT content, media_type FROM artifacts WHERE object_id = $1", [objectId]);
    const row = r.rows[0];
    return row ? { content: row.content, mediaType: row.media_type } : null;
  }
}
