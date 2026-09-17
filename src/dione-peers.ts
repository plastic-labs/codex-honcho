export interface DionePeerEntry {
  displayName: string;
  aliases?: string[];
  // Omit this for the canonical `discord-<user id>` identity. A different
  // storage identity is an intentional merge and therefore needs provenance.
  peerId?: string;
  provenance?: string;
}

export type DionePeerRegistry = Record<string, DionePeerEntry>;

export type DioneAliasResolution =
  | { kind: "not_found" }
  | { kind: "unique"; userId: string; peerId: string; entry: DionePeerEntry }
  | { kind: "ambiguous"; candidates: Array<{ userId: string; peerId: string }> };

export function defaultDionePeerId(userId: string): string {
  return `discord-${userId}`;
}

function required(value: string | undefined, label: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`[codex-honcho] ${label} must be non-empty`);
  return normalized;
}

export function validateDionePeerRegistry(
  registry: DionePeerRegistry,
  legacyPeers: Record<string, string> = {},
): DionePeerRegistry {
  for (const [rawUserId, entry] of Object.entries(registry)) {
    const userId = required(rawUserId, "Dione peer user id");
    required(entry.displayName, `Dione peer ${userId} displayName`);
    for (const alias of entry.aliases ?? []) {
      required(alias, `Dione peer ${userId} alias`);
    }
    if (entry.peerId !== undefined) {
      const peerId = required(entry.peerId, `Dione peer ${userId} peerId`);
      if (peerId !== defaultDionePeerId(userId)) {
        required(
          entry.provenance,
          `Dione peer ${userId} non-default peerId provenance`,
        );
      }
      const legacy = legacyPeers[userId]?.trim();
      if (legacy && legacy !== peerId) {
        throw new Error(
          `[codex-honcho] Dione peer ${userId} has conflicting storage identities`,
        );
      }
    }
  }
  return registry;
}

export function resolveDionePeerId(
  userId: string,
  legacyPeers: Record<string, string> = {},
  registry: DionePeerRegistry = {},
): string {
  const entry = registry[userId];
  if (entry?.peerId?.trim()) return entry.peerId.trim();
  const legacy = legacyPeers[userId]?.trim();
  return legacy || defaultDionePeerId(userId);
}

export function resolveDioneAlias(
  alias: string,
  registry: DionePeerRegistry,
  legacyPeers: Record<string, string> = {},
): DioneAliasResolution {
  const needle = alias.trim().toLocaleLowerCase();
  if (!needle) return { kind: "not_found" };

  const candidates = Object.entries(registry).flatMap(([userId, entry]) => {
    const names = [entry.displayName, ...(entry.aliases ?? [])];
    if (!names.some((name) => name.trim().toLocaleLowerCase() === needle)) return [];
    return [{
      userId,
      peerId: resolveDionePeerId(userId, legacyPeers, registry),
      entry,
    }];
  });

  if (candidates.length === 0) return { kind: "not_found" };
  if (candidates.length === 1) return { kind: "unique", ...candidates[0] };
  return {
    kind: "ambiguous",
    candidates: candidates.map(({ userId, peerId }) => ({ userId, peerId })),
  };
}
