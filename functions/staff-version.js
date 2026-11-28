// Does this change to a staff_applications document change the approved staff list that pages use?
// Logins (currentSessionId), password changes and phone notification tokens alone do not count:
// pages never read them from the staff list.
const STAFF_IGNORED_FIELDS = new Set(["currentSessionId", "password", "fcmTokens", "tokenUpdatedAt", "platform", "lastSeenAt"]);

function staffChangeMatters(before, after) {
    const wasApproved = !!before && String(before.status || "").toLowerCase() === "approved";
    const isApproved = !!after && String(after.status || "").toLowerCase() === "approved";
    if (!wasApproved && !isApproved) return false;            // not in the approved list before or after
    if (!before || !after) return true;                        // created or deleted
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const k of keys) {
        if (STAFF_IGNORED_FIELDS.has(k)) continue;
        if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) return true;
    }
    return false;
}

module.exports = { staffChangeMatters, STAFF_IGNORED_FIELDS };
