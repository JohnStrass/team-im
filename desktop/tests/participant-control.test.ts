import { describe, expect, it } from "vitest";

import {
  baseParticipantState,
  isLoadedModel,
  participantDefinitions,
  type ParticipantControlConfig,
} from "../electron/participant-control";

const READY_CONFIG: ParticipantControlConfig = {
  serverUrl: "http://localhost:8765",
  bridgeScript: "C:\\team-im\\bridge.py",
  delegateDir: "C:\\local-agents",
  python: { command: "C:\\Python\\python.exe", args: [] },
  lmsPath: "C:\\LM Studio\\lms.exe",
};

describe("participant defaults", () => {
  it("keeps every managed model disabled on app launch", () => {
    const states = participantDefinitions().map((definition) =>
      baseParticipantState(definition, READY_CONFIG),
    );

    expect(states.filter((state) => state.controllable)).not.toHaveLength(0);
    expect(states.filter((state) => state.controllable).every((state) =>
      state.status === "disabled" && !state.active
    )).toBe(true);
  });

  it("marks external agent sessions honestly instead of pretending to load them", () => {
    const codex = participantDefinitions().find((definition) => definition.handle === "codex")!;
    const state = baseParticipantState(codex, READY_CONFIG);
    expect(state).toMatchObject({ kind: "session", status: "external", controllable: false });
  });

  it("reports missing provider plumbing without exposing credentials", () => {
    const kimi = participantDefinitions().find((definition) => definition.handle === "kimi")!;
    const state = baseParticipantState(kimi, {
      ...READY_CONFIG,
      delegateDir: null,
    });
    expect(state).toMatchObject({ status: "unavailable", controllable: false });
    expect(state.detail.toLowerCase()).not.toContain("api key");
  });
});

describe("LM Studio process parsing", () => {
  it("matches either an API identifier or a model key", () => {
    const loaded = [{ identifier: "gemma4-code-v2", modelKey: "publisher/model@q6_k" }];
    expect(isLoadedModel(loaded, ["gemma4-code-v2"])).toBe(true);
    expect(isLoadedModel(loaded, ["publisher/model@q6_k"])).toBe(true);
    expect(isLoadedModel(loaded, ["different-model"])).toBe(false);
  });

  it("rejects malformed process output", () => {
    expect(isLoadedModel(null, ["gemma4-code-v2"])).toBe(false);
    expect(isLoadedModel({ identifier: "gemma4-code-v2" }, ["gemma4-code-v2"])).toBe(false);
  });
});
