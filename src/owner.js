// Owner check, kept separate so it can be tested without starting the bot.
// The bot ignores every update that does not come from the owner.

export function isOwner(senderId, ownerId) {
  // Fail closed: unknown sender, non-numeric id, or mismatch all mean "not owner".
  if (typeof senderId !== "number" || !Number.isSafeInteger(senderId)) return false;
  if (typeof ownerId !== "number" || !Number.isSafeInteger(ownerId)) return false;
  return senderId === ownerId;
}

export function parseOwnerId(raw) {
  // Returns a positive integer user id, or null if the value is unusable.
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const id = Number(trimmed);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return id;
}
