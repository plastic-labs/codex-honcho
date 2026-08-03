import { expect, test } from "bun:test";
import {
  defaultDionePeerId,
  resolveDioneAlias,
  resolveDionePeerId,
  validateDionePeerRegistry,
} from "../src/dione-peers.ts";

const registry = {
  "101": { displayName: "Ari", aliases: ["ariadne"] },
  "202": { displayName: "Vesper", aliases: ["evening"] },
  "303": {
    displayName: "syn",
    aliases: ["Syne"],
    peerId: "syn",
    provenance: "existing intentional continuity mapping",
  },
};

test("two Discord ids route independently through the typed registry", () => {
  expect(resolveDionePeerId("101", {}, registry)).toBe("discord-101");
  expect(resolveDionePeerId("202", {}, registry)).toBe("discord-202");
});

test("display-name edits cannot change canonical storage identity", () => {
  const before = resolveDionePeerId("101", {}, registry);
  const renamed = { ...registry, "101": { ...registry["101"], displayName: "Ari (new)" } };
  expect(resolveDionePeerId("101", {}, renamed)).toBe(before);
});

test("ambiguous aliases fail closed instead of selecting a peer", () => {
  const ambiguous = {
    ...registry,
    "101": { ...registry["101"], aliases: ["shared"] },
    "202": { ...registry["202"], aliases: ["shared"] },
  };
  expect(resolveDioneAlias("shared", ambiguous)).toEqual({
    kind: "ambiguous",
    candidates: [
      { userId: "101", peerId: "discord-101" },
      { userId: "202", peerId: "discord-202" },
    ],
  });
});

test("syn's explicit continuity mapping joins the existing syn peer", () => {
  expect(resolveDionePeerId("303", {}, registry)).toBe("syn");
});

test("an unknown Discord id is isolated by default", () => {
  expect(resolveDionePeerId("404", {}, registry)).toBe(defaultDionePeerId("404"));
});

test("historical peer ids remain stable after later alias edits", () => {
  const historical = [
    resolveDionePeerId("101", {}, registry),
    resolveDionePeerId("303", {}, registry),
  ];
  const edited = {
    ...registry,
    "101": { ...registry["101"], aliases: ["new-alias"] },
    "303": { ...registry["303"], aliases: ["new-syn-alias"] },
  };
  expect([
    resolveDionePeerId("101", {}, edited),
    resolveDionePeerId("303", {}, edited),
  ]).toEqual(historical);
});

test("non-default storage identity requires an attributed provenance receipt", () => {
  expect(() => validateDionePeerRegistry({
    "101": { displayName: "Ari", peerId: "ari" },
  })).toThrow("non-default peerId provenance");
});

test("a typed binding cannot silently disagree with the legacy peer map", () => {
  expect(() => validateDionePeerRegistry({
    "303": {
      displayName: "syn",
      peerId: "different-peer",
      provenance: "test",
    },
  }, { "303": "syn" })).toThrow("conflicting storage identities");
});
