// ============================================================================
// MINERVA — BRANCH & SESSION CONTEXT  (one copy used by every page, step by step)
// ----------------------------------------------------------------------------
// Answers: which branch + academic session is selected, and which Firestore
// collection holds a given kind of data for it.
//
// Where data lives:
//   SHARED   (all branches, all sessions): staff, configs, branches ...   -> "staff_applications"
//   BRANCH   (one branch, every session):  rooms                          -> "<branch prefix>infrastructure_rooms"
//   SESSION  (one branch, one session):    everything else               -> "<session prefix>institute_structure"
//
// Prefixes are stored ONCE on the branch / session record (admin-branches.html) and never
// change, even if a branch or session is renamed:
//   Ghumarwin   2026-27  -> ""              (today's data, unchanged)
//   Dharamshala 2026-27  -> "dharamshala_"  (today's data, unchanged)
//   new sessions         -> "ghumarwin_2027_28_" ...
//
// Current session (from the dates on the branches page):
//   - sessions marked INACTIVE are ignored
//   - the session whose dates include today; if two overlap, the one that started later
//   - none covers today -> the most recent one that has started (with a warning)
//   - an original branch with no session saved yet -> today's data
// ============================================================================
(function (global) {
    "use strict";

    // Data of the two original branches before the first new session (2026-27)
    const LEGACY_PREFIX = { GHUMARWIN: "", DHARAMSHALA: "dharamshala_" };
    const LEGACY_SESSION_STARTS_BEFORE = "2027-01-01";

    const SHARED_COLLECTIONS = ["staff_applications", "configs", "system_metadata", "branches",
        "instant_alerts", "timetable_drafts", "staff_registration_form"];
    const BRANCH_COLLECTIONS = ["infrastructure_rooms"];

    const CACHE_KEY = "minervaContextBranches_v1";
    const ADMIN_SESSION_KEY = "minervaAdminSessionId";

    function todayIso() {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    }
    function branchCode(b) {
        return String((b && (b.code || b.name)) || "").toUpperCase().replace(/[^A-Z0-9_]/g, "_");
    }
    function isLegacyBranch(b) { return Object.prototype.hasOwnProperty.call(LEGACY_PREFIX, branchCode(b)); }

    // ---- prefixes --------------------------------------------------------------
    function branchDataPrefix(b) {
        if (b && typeof b.dataPrefix === "string") return b.dataPrefix;
        const code = branchCode(b);
        if (isLegacyBranch(b)) return LEGACY_PREFIX[code];
        return code.toLowerCase() + "_";
    }
    function isLegacySession(b, s) {
        return isLegacyBranch(b) && !!s && (!s.startDate || s.startDate < LEGACY_SESSION_STARTS_BEFORE);
    }
    function sessionDataPrefix(b, s) {
        if (s && typeof s.dataPrefix === "string") return s.dataPrefix;
        if (!s || isLegacySession(b, s)) return LEGACY_PREFIX[branchCode(b)] !== undefined ? LEGACY_PREFIX[branchCode(b)] : branchCode(b).toLowerCase() + "_";
        return proposeSessionPrefix(b, s, (b && b.sessions) || []);
    }
    // For a NEW session: "<branch>_<startYear>_<endYY>_" e.g. ghumarwin_2027_28_ (made unique in the branch)
    function proposeSessionPrefix(b, s, otherSessions) {
        if (isLegacySession(b, s)) return LEGACY_PREFIX[branchCode(b)];
        const code = branchCode(b).toLowerCase();
        const y1 = String(s.startDate || "").slice(0, 4) || "x";
        const y2 = String(s.endDate || "").slice(2, 4) || "x";
        const taken = new Set((otherSessions || []).filter(o => o && o.id !== s.id && typeof o.dataPrefix === "string").map(o => o.dataPrefix));
        Object.values(LEGACY_PREFIX).forEach(p => taken.add(p));
        let base = `${code}_${y1}_${y2}_`, candidate = base, n = 2;
        while (taken.has(candidate)) { candidate = `${base.slice(0, -1)}_${n}_`; n++; }
        return candidate;
    }

    // ---- which session is current --------------------------------------------
    function currentSession(b, onDate) {
        const day = onDate || todayIso();
        const usable = ((b && b.sessions) || []).filter(s => s && s.status !== "INACTIVE" && s.startDate && s.endDate);
        const covering = usable.filter(s => s.startDate <= day && s.endDate >= day)
            .sort((a, c) => c.startDate.localeCompare(a.startDate));
        if (covering.length) return { session: covering[0], warning: "" };
        const started = usable.filter(s => s.startDate <= day).sort((a, c) => c.startDate.localeCompare(a.startDate));
        if (started.length) return { session: started[0], warning: `No active session covers ${day}; showing ${started[0].name}. Please check the session dates.` };
        if (isLegacyBranch(b)) return { session: legacySessionStub(b), warning: "" };
        const upcoming = usable.slice().sort((a, c) => a.startDate.localeCompare(c.startDate));
        if (upcoming.length) return { session: upcoming[0], warning: `${upcoming[0].name} has not started yet.` };
        return { session: null, warning: "No session is set up for this branch yet." };
    }
    function legacySessionStub(b) {
        return { id: `legacy_${branchCode(b).toLowerCase()}`, name: "2026-27 (current data)", startDate: "", endDate: "",
                 status: "ACTIVE", dataPrefix: LEGACY_PREFIX[branchCode(b)], isStub: true };
    }
    // Sessions an admin can switch between (all of them, newest first; plus today's data if not listed)
    function sessionsForSwitcher(b) {
        const list = ((b && b.sessions) || []).filter(Boolean).slice()
            .sort((a, c) => String(c.startDate || "").localeCompare(String(a.startDate || "")));
        if (isLegacyBranch(b) && !list.some(s => isLegacySession(b, s))) list.push(legacySessionStub(b));
        return list;
    }

    // ---- collection names -------------------------------------------------------
    function scopeOf(name) {
        if (SHARED_COLLECTIONS.includes(name)) return "SHARED";
        if (BRANCH_COLLECTIONS.includes(name)) return "BRANCH";
        return "SESSION";
    }
    function collectionName(name, b, s) {
        const scope = scopeOf(name);
        if (scope === "SHARED") return name;
        if (scope === "BRANCH") return branchDataPrefix(b) + name;
        return sessionDataPrefix(b, s) + name;
    }

    // ---- loading branches -------------------------------------------------------
    function readCache() {
        try { const c = JSON.parse(localStorage.getItem(CACHE_KEY) || "null"); return Array.isArray(c) ? c : null; } catch (e) { return null; }
    }
    function writeCache(list) { try { localStorage.setItem(CACHE_KEY, JSON.stringify(list)); } catch (e) {} }

    async function loadBranches(db) {
        try {
            const snap = await db.collection("branches").get();
            const list = snap.docs.map(d => ({ id: d.id, ...d.data() }));
            writeCache(list);
            return list;
        } catch (e) {
            const cached = readCache();
            if (cached) return cached;
            throw e;
        }
    }
    function listenBranches(db, cb) {
        return db.collection("branches").onSnapshot(snap => {
            const list = snap.docs.map(d => ({ id: d.id, ...d.data() }));
            writeCache(list);
            cb(list);
        }, err => console.warn("Branches listener:", err));
    }
    function findBranch(list, codeOrId) {
        const key = String(codeOrId || "").toUpperCase();
        return (list || []).find(b => b.id === codeOrId || branchCode(b) === key) ||
               (LEGACY_PREFIX[key] !== undefined ? { id: `branch_${key.toLowerCase()}`, code: key, name: key, sessions: [] } : null);
    }

    // ---- admin's selected session ----------------------------------------------
    // Admins open on the current session; they may switch (kept for this browser tab).
    function adminSelectedSession(b) {
        let stored = null;
        try { stored = sessionStorage.getItem(ADMIN_SESSION_KEY); } catch (e) {}
        const all = sessionsForSwitcher(b);
        const picked = stored && all.find(s => s.id === stored);
        if (picked) return { session: picked, warning: "", isCurrent: picked.id === (currentSession(b).session || {}).id };
        const cur = currentSession(b);
        return { ...cur, isCurrent: true };
    }
    function setAdminSelectedSession(sessionId) {
        try {
            if (sessionId) sessionStorage.setItem(ADMIN_SESSION_KEY, sessionId);
            else sessionStorage.removeItem(ADMIN_SESSION_KEY);
        } catch (e) {}
    }

    global.MinervaContext = {
        LEGACY_PREFIX, SHARED_COLLECTIONS, BRANCH_COLLECTIONS,
        todayIso, branchCode, isLegacyBranch, isLegacySession,
        branchDataPrefix, sessionDataPrefix, proposeSessionPrefix,
        currentSession, sessionsForSwitcher, scopeOf, collectionName,
        loadBranches, listenBranches, findBranch,
        adminSelectedSession, setAdminSelectedSession,
        VERSION: 1
    };
})(typeof window !== "undefined" ? window : globalThis);
