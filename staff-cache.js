// =====================================================================================
// SHARED APPROVED-STAFF LIST (fewer Firestore reads, no delay)
// Pages used to read every approved staff record (~100+ reads) on every open.
// Now: read ONE small marker (system_metadata/staff_version). A server trigger
// (functions/index.js: staffListVersion) changes that marker within about a second of ANY
// change to an approved staff record. If the marker is the same as when this browser tab last
// read the list, the copy kept in this tab is used; otherwise the list is read again.
// So a change shows on the very next page open, and most opens cost 1 read.
// The copy is kept only in this tab (sessionStorage) and never contains passwords or
// login session ids.
// If the marker does not exist yet, the list is simply read as before.
// =====================================================================================
(function (global) {
    const KEY = "minervaStaffCacheV1";
    const DROP = ["password", "currentSessionId"];   // never kept in the browser copy

    function enc(v) {
        if (v === null || typeof v !== "object") return v;
        if (typeof v.toMillis === "function" && typeof v.seconds === "number") return { __ts: [v.seconds, v.nanoseconds || 0] };
        if (Array.isArray(v)) return v.map(enc);
        const o = {}; Object.keys(v).forEach(k => { o[k] = enc(v[k]); }); return o;
    }
    function dec(v) {
        if (v === null || typeof v !== "object") return v;
        if (Array.isArray(v)) return v.map(dec);
        if (v.__ts && Array.isArray(v.__ts) && Object.keys(v).length === 1) {
            try { return new firebase.firestore.Timestamp(v.__ts[0], v.__ts[1]); } catch (e) { return v; }
        }
        const o = {}; Object.keys(v).forEach(k => { o[k] = dec(v[k]); }); return o;
    }
    // A snapshot that behaves like Firestore's (docs, forEach, size, empty; doc.id/data()/get()/exists/ref)
    function makeSnap(coll, rows) {
        const docs = rows.map(r => {
            const data = dec(r.d);
            return { id: r.id, exists: true, ref: coll.doc(r.id), data: () => dec(r.d), get: (f) => String(f).split(".").reduce((x, k) => (x == null ? undefined : x[k]), data) };
        });
        return { docs, size: docs.length, empty: docs.length === 0, forEach: (fn) => docs.forEach(fn), fromCache: true };
    }
    function readStore() { try { return JSON.parse(sessionStorage.getItem(KEY) || "null"); } catch (e) { return null; } }
    function writeStore(v, rows) { try { sessionStorage.setItem(KEY, JSON.stringify({ v, rows })); } catch (e) { /* too big / private mode: just don't keep it */ } }

    let inFlight = null;   // several parts of one page asking at the same time -> one read
    async function getApproved(coll) {
        // only the shared staff_applications collection is handled; anything else reads as before
        if (!coll || coll.path !== "staff_applications") return coll.where("status", "==", "approved").get();
        if (inFlight) return inFlight;
        inFlight = (async () => {
            let version = null;
            try {
                const m = await coll.firestore.collection("system_metadata").doc("staff_version").get();
                if (m.exists && m.data() && m.data().v) version = String(m.data().v);
            } catch (e) { version = null; }
            const kept = readStore();
            if (version && kept && kept.v === version && Array.isArray(kept.rows)) return makeSnap(coll, kept.rows);
            const snap = await coll.where("status", "==", "approved").get();
            if (version) {
                const rows = snap.docs.map(d => { const x = { ...d.data() }; DROP.forEach(k => delete x[k]); return { id: d.id, d: enc(x) }; });
                writeStore(version, rows);
            }
            return snap;
        })();
        try { return await inFlight; } finally { setTimeout(() => { inFlight = null; }, 0); }
    }
    function invalidate() { try { sessionStorage.removeItem(KEY); } catch (e) {} }

    // Any save to a staff record from THIS tab drops the copy at once, so this tab never shows
    // an old list right after its own change (other tabs/users follow the server marker).
    function isStaffRef(ref) { return !!ref && typeof ref.path === "string" && /^staff_applications\//.test(ref.path); }
    function wrap(proto, names, refFromArgs) {
        if (!proto) return;
        names.forEach(n => {
            const orig = proto[n];
            if (typeof orig !== "function" || orig.__minervaStaffWrapped) return;
            const w = function (...args) { try { if (isStaffRef(refFromArgs ? args[0] : this)) invalidate(); } catch (e) {} return orig.apply(this, args); };
            w.__minervaStaffWrapped = true;
            proto[n] = w;
        });
    }
    try {
        const fs = global.firebase && global.firebase.firestore;
        if (fs) {
            wrap(fs.DocumentReference && fs.DocumentReference.prototype, ["set", "update", "delete"], false);
            wrap(fs.WriteBatch && fs.WriteBatch.prototype, ["set", "update", "delete"], true);
            wrap(fs.Transaction && fs.Transaction.prototype, ["set", "update", "delete"], true);
            const CR = fs.CollectionReference && fs.CollectionReference.prototype;
            if (CR && typeof CR.add === "function" && !CR.add.__minervaStaffWrapped) {
                const origAdd = CR.add;
                CR.add = function (...args) { try { if (this.path === "staff_applications") invalidate(); } catch (e) {} return origAdd.apply(this, args); };
                CR.add.__minervaStaffWrapped = true;
            }
        }
    } catch (e) { /* if this fails, the server marker still keeps the copy correct */ }

    global.MinervaStaffCache = { getApproved, invalidate, KEY };
})(typeof window !== "undefined" ? window : globalThis);
