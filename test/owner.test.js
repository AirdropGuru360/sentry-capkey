import test from "node:test";
import assert from "node:assert/strict";
import { isOwner, parseOwnerId } from "../src/owner.js";

const OWNER = 123456789;

test("isOwner accepts the owner", () => {
  assert.equal(isOwner(OWNER, OWNER), true);
});

test("isOwner rejects another user", () => {
  assert.equal(isOwner(987654321, OWNER), false);
});

test("isOwner fails closed on missing or malformed sender id", () => {
  assert.equal(isOwner(undefined, OWNER), false);
  assert.equal(isOwner(null, OWNER), false);
  assert.equal(isOwner("123456789", OWNER), false);
  assert.equal(isOwner(1.5, OWNER), false);
});

test("isOwner fails closed on a bad owner id", () => {
  assert.equal(isOwner(OWNER, undefined), false);
  assert.equal(isOwner(OWNER, NaN), false);
});

test("parseOwnerId accepts a plain numeric id", () => {
  assert.equal(parseOwnerId("123456789"), 123456789);
  assert.equal(parseOwnerId("  123456789  "), 123456789);
});

test("parseOwnerId rejects empty, negative, decimal and text values", () => {
  assert.equal(parseOwnerId(""), null);
  assert.equal(parseOwnerId("   "), null);
  assert.equal(parseOwnerId("-5"), null);
  assert.equal(parseOwnerId("1.5"), null);
  assert.equal(parseOwnerId("abc"), null);
  assert.equal(parseOwnerId("123456789:abc"), null);
});
