// Unit tests for the Private Sprint application helpers (Phase 2, PR-2.5).
// Run: `npm test` (node --test). Pure → no DB, no network.
import test from "node:test";
import assert from "node:assert/strict";
import {
  validateApplication,
  isValidAdminDecision,
  INITIAL_STATUS,
  ADMIN_DECISIONS,
} from "./_private-application.mjs";

const uuid = "11111111-2222-4333-8444-555555555555";

test("valid application normalizes + forces status=submitted", () => {
  const { ok, errors, value } = validateApplication({
    email: "Pro@Example.com",
    tiktok_handle: "@pro_seller",
    preferred_contact: "LINE",
    contact_value: "pro-line-id",
    submission_id: uuid,
    notes: "ready to scale",
  });
  assert.equal(ok, true);
  assert.deepEqual(errors, []);
  assert.equal(value.email, "pro@example.com");
  assert.equal(value.preferred_contact, "line");
  assert.equal(value.submission_id, uuid);
  assert.equal(value.status, INITIAL_STATUS);
  assert.equal(value.status, "submitted");
});

test("client cannot self-approve: status is ignored, always submitted", () => {
  const { value } = validateApplication({
    email: "x@y.com",
    tiktok_handle: "@x",
    status: "approved", // malicious/wrong input
  });
  assert.equal(value.status, "submitted");
});

test("missing email / handle → errors", () => {
  const r1 = validateApplication({ tiktok_handle: "@x" });
  assert.ok(r1.errors.includes("email"));
  const r2 = validateApplication({ email: "a@b.com" });
  assert.ok(r2.errors.includes("tiktok_handle"));
});

test("bad email / preferred_contact / submission_id → flagged", () => {
  const r = validateApplication({
    email: "not-an-email",
    tiktok_handle: "@x",
    preferred_contact: "carrier_pigeon",
    submission_id: "not-a-uuid",
  });
  assert.ok(r.errors.includes("email"));
  assert.ok(r.errors.includes("preferred_contact"));
  assert.ok(r.errors.includes("submission_id"));
  assert.equal(r.ok, false);
});

test("garbage body never throws", () => {
  for (const b of [null, undefined, "x", 42, []]) {
    const r = validateApplication(b);
    assert.equal(r.ok, false);
    assert.equal(r.value.status, "submitted");
  }
});

test("admin decisions: only under_review/approved/declined are valid", () => {
  assert.deepEqual(ADMIN_DECISIONS, ["under_review", "approved", "declined"]);
  assert.equal(isValidAdminDecision("approved"), true);
  assert.equal(isValidAdminDecision("declined"), true);
  assert.equal(isValidAdminDecision("submitted"), false); // not an admin decision
  assert.equal(isValidAdminDecision("auto_approve"), false);
  assert.equal(isValidAdminDecision(""), false);
});
