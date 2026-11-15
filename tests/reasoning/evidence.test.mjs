import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function loadFixture(name) {
  const path = new URL(`./fixtures/${name}`, import.meta.url);
  return JSON.parse(readFileSync(path, "utf8"));
}

const input = loadFixture("left-defense.json");
const expected = loadFixture("left-defense.expected.json");

function validateEvidence(input, output) {
  const observationIds = new Set([
    ...input.conversationObservations.map(item => item.observationId),
    ...input.screenObservations.map(item => item.observationId)
  ]);

  function checkEvidence(ids) {
    assert.ok(Array.isArray(ids), "Evidence must be an array");
    assert.ok(ids.length > 0, "Evidence must not be empty");

    for (const id of ids) {
      assert.ok(observationIds.has(id), `Unknown observation: ${id}`);
    }
  }

  for (const update of output.contextUpdates) {
    checkEvidence(update.sourceObservationIds);
  }

  for (const candidate of output.recommendationCandidates) {
    checkEvidence(candidate.conditionObservationIds);
    checkEvidence(candidate.contextObservationIds);
  }
}

test("accepts evidence IDs present in the input", () => {
  validateEvidence(input, expected);
});

test("rejects an unknown condition evidence ID", () => {
  const invalidOutput = structuredClone(expected);

  invalidOutput.recommendationCandidates[0]
    .conditionObservationIds = ["screen-999"];

  assert.throws(
    () => validateEvidence(input, invalidOutput),
    /Unknown observation: screen-999/
  );
});