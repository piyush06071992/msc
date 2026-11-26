// ============================================================================
// SLIM TIMETABLE HISTORY
// ----------------------------------------------------------------------------
// Every document in `timetable_history` (and `<branch>_timetable_history`) holds a
// FULL copy of the whole school timetable with ~20 fields per slot. Pages that need
// "what did the timetable look like on date X" (lesson planner tracker) had to
// download all of them: ~140 copies, several MB compressed / ~150 MB unpacked.
//
// This module builds a "slim" mirror document for each history document, keeping
// only the 12 slot fields the pages actually read, packed into ONE JSON string.
// Same document ID, stored in `<history collection>_slim`.
//
// Used by:
//   - functions/index.js               (trigger: keeps the mirror in sync on every write/delete)
//   - functions/tools/backfill-slim-history.js (one-time copy of the existing history)
// ============================================================================

// Branch history collections to mirror. ADD A LINE HERE WHEN A NEW BRANCH IS CREATED.
const HISTORY_COLLECTIONS = [
    "timetable_history",               // GHUMARWIN (no prefix)
    "dharamshala_timetable_history",   // DHARAMSHALA
];

// Only these history types are used by the lesson planner (same list it always loaded).
// Other types (FUTURE_MASTER, APPLIED_MASTER, ...) are not mirrored.
const SLIM_TYPES = ["EXAM_OVERRIDE", "SPECIFIC_DATES", "DAILY_OVERRIDE", "LIVE_MASTER_UPDATE"];

// PACKING: every distinct value is stored ONCE in `values` (e.g. "Wednesday", "Biology",
// "09:00"), and each slot is a list of numbers pointing into it. Both are stored as JSON
// strings, which is far smaller and faster to download/parse than Firestore maps.
// Decoding: slot[SLOT_FIELDS[i]] = values[row[i]]   (null values are left out).
// Order of the packed slot fields. NEVER reorder: pages decode by position.
// Append new fields at the end only, and bump SLIM_FORMAT_VERSION.
const SLOT_FIELDS = [
    "day", "className", "section", "subject", "start24", "end24",
    "duration", "remark", "teacher", "teacherName", "timeRange", "id",
];
const SLIM_FORMAT_VERSION = 1;

function slimCollectionName(historyCollection) {
    return `${historyCollection}_slim`;
}

// Returns the slim document for a history document, or null if it should not be mirrored.
function toSlim(historyData, docId) {
    if (!historyData || !SLIM_TYPES.includes(historyData.type)) return null;
    const schedule = Array.isArray(historyData.schedule) ? historyData.schedule : [];
    const values = [];
    const indexOf = new Map(); // JSON-encoded value -> index (keeps "45" and 45 distinct)
    const ref = (v) => {
        const val = (v === undefined) ? null : v;
        const key = JSON.stringify(val);
        if (!indexOf.has(key)) { indexOf.set(key, values.length); values.push(val); }
        return indexOf.get(key);
    };
    const rows = schedule.map(slot => SLOT_FIELDS.map(f => ref(slot ? slot[f] : null)));
    return {
        sourceId: docId,
        date: historyData.date !== undefined ? historyData.date : null,
        type: historyData.type,
        status: historyData.status !== undefined ? historyData.status : null,
        tag: historyData.tag !== undefined ? historyData.tag : null,
        sourceLastUpdated: historyData.lastUpdated !== undefined ? historyData.lastUpdated : null,
        slotCount: rows.length,
        format: SLIM_FORMAT_VERSION,
        values: JSON.stringify(values),
        rows: JSON.stringify(rows),
        mirroredAt: Date.now(),
    };
}

module.exports = { HISTORY_COLLECTIONS, SLIM_TYPES, SLOT_FIELDS, SLIM_FORMAT_VERSION, slimCollectionName, toSlim };
