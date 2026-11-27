// ============================================================================
// MINERVA — LEAVE PAGES: LOAD ONLY THE DATES NEEDED
// ----------------------------------------------------------------------------
// Used by: teacher-leave.html, admin-staff-leaves.html
//
// Before, both leave pages downloaded the WHOLE live timetable and the WHOLE
// timetable history (every saved copy of the school timetable, 100+ MB) on every
// open. A leave only needs the timetable of the dates in that leave, so this
// loads, per date:
//   - that date's override / exam day (if any)               -> 1-2 small reads
//   - otherwise a FUTURE master that starts by then (rare)    -> few small reads
//   - otherwise the live timetable rows for that weekday      -> rows of 1 weekday
//   - for past dates: the master that applied on that date
//   - exam duty charts of that date, lunch duty chart of that week
//
// Which timetable applies (same as the old leave page):
//   1. An override / exam day saved for that exact date (not cancelled)
//   2. Today or later: the latest FUTURE master starting after today and by that date,
//      else the live timetable
//   3. Before today: the latest master copy dated on or before that date, else live
//
// Usage:
//   const sched = MinervaLeaveSchedule.create({ db, prefix });
//   await sched.ensureDates(["2026-11-27", ...]);   // throws if loading fails
//   sched.dayRows("2026-11-27")                     // copy of that day's rows
//   sched.dutyRosters(["2026-11-27"])               // roster docs { id, ...data }
// ============================================================================
(function (global) {
    "use strict";

    const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const MASTER_TYPES = ["FUTURE_MASTER", "LIVE_MASTER_UPDATE", "APPLIED_MASTER"];
    const OVERRIDE_TYPES = ["DAILY_OVERRIDE", "EXAM_OVERRIDE"];
    // Order of fields in the slim history copies (functions/slim-history.js, format 2)
    const SLIM_SLOT_FIELDS = ["day", "className", "section", "subject", "start24", "end24",
                              "duration", "remark", "teacher", "teacherName", "timeRange", "id", "teacherEmail"];

    function localIso(d) {
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    }
    function parseIso(iso) {
        const [y, m, d] = iso.split("-").map(Number);
        return new Date(y, m - 1, d);
    }
    function dayNameOf(iso) { return DAYS[parseIso(iso).getDay()]; }
    function addDays(iso, n) { const d = parseIso(iso); d.setDate(d.getDate() + n); return localIso(d); }
    function mondayOf(iso) {
        const day = parseIso(iso).getDay();
        return addDays(iso, day === 0 ? -6 : 1 - day);
    }
    function forDay(schedule, dayName) {
        return (schedule || []).filter(t => (t.day || "").trim() === dayName);
    }

    function expandSlim(s) {
        if (!s) return null;
        let rows = [], values = [];
        try { rows = JSON.parse(s.rows || "[]"); values = JSON.parse(s.values || "[]"); } catch (e) { rows = []; values = []; }
        const schedule = rows.map(r => {
            const slot = {};
            SLIM_SLOT_FIELDS.forEach((f, i) => { const v = values[r[i]]; if (v !== null && v !== undefined) slot[f] = v; });
            return slot;
        });
        const h = { type: s.type, schedule };
        if (s.date !== null && s.date !== undefined) h.date = s.date;
        if (s.status !== null && s.status !== undefined) h.status = s.status;
        return h;
    }

    function create(opts) {
        const db = opts.db;
        const prefix = opts.prefix || "";
        const col = (name) => db.collection(prefix + name);
        const docIdField = () => global.firebase.firestore.FieldPath.documentId();

        const dayRowsByDate = new Map();      // dateIso -> rows for that weekday
        const datePromises = new Map();       // dateIso -> loading promise
        const liveByDay = new Map();          // dayName -> promise of live rows
        const rosterById = new Map();         // roster doc id -> { id, ...data }
        const rosterPromises = new Map();     // key -> promise
        let sourcePromise = null;
        let futureMastersPromise = null;
        let fullLivePromise = null;

        // History source: the small "slim" copies when they are complete (format 2), else full history
        function historySource() {
            if (!sourcePromise) {
                sourcePromise = col("timetable_history_slim").doc("__status").get()
                    .then(doc => doc.exists && doc.data().ready === true && (doc.data().format || 1) >= 2)
                    .catch(() => false)
                    .then(slim => slim
                        ? { col: col("timetable_history_slim"), toHistory: d => expandSlim(d.data()) }
                        : { col: col("timetable_history"), toHistory: d => d.data() });
            }
            return sourcePromise;
        }

        function fullLive() {
            if (!fullLivePromise) {
                fullLivePromise = col("timetable").get().then(s => s.docs.map(d => d.data()));
                fullLivePromise.catch(() => { fullLivePromise = null; });
            }
            return fullLivePromise;
        }
        function liveRows(dayName) {
            if (!liveByDay.has(dayName)) {
                const p = col("timetable").where("day", "==", dayName).get().then(async snap => {
                    if (!snap.empty) return snap.docs.map(d => d.data());
                    // Nothing stored under the exact name (e.g. "Monday " with a space): check the whole timetable
                    return forDay(await fullLive(), dayName);
                });
                p.catch(() => liveByDay.delete(dayName));
                liveByDay.set(dayName, p);
            }
            return liveByDay.get(dayName);
        }

        function futureMasters() {
            if (!futureMastersPromise) {
                futureMastersPromise = historySource().then(src =>
                    src.col.where("type", "==", "FUTURE_MASTER").get()
                        .then(snap => snap.docs.map(src.toHistory).filter(h => h && h.status !== "CANCELLED" && typeof h.date === "string")));
                futureMastersPromise.catch(() => { futureMastersPromise = null; });
            }
            return futureMastersPromise;
        }

        async function pastMaster(dateIso) {
            const src = await historySource();
            let cursor = null;
            for (let page = 0; page < 30; page++) {
                let q = src.col.where("date", "<=", dateIso).orderBy("date", "desc").limit(10);
                if (cursor) q = q.startAfter(cursor);
                const snap = await q.get();
                if (snap.empty) return null;
                const found = snap.docs.map(src.toHistory)
                    .find(h => h && h.status !== "CANCELLED" && MASTER_TYPES.includes(h.type) && h.schedule);
                if (found) return found;
                cursor = snap.docs[snap.docs.length - 1];
            }
            return null;
        }

        async function loadDate(dateIso) {
            const dayName = dayNameOf(dateIso);
            const todayIso = localIso(new Date());
            const src = await historySource();

            // 1. Override / exam day saved for this exact date
            const sameDay = await src.col.where("date", "==", dateIso).get();
            const override = sameDay.docs.map(src.toHistory)
                .find(h => h && h.status !== "CANCELLED" && OVERRIDE_TYPES.includes(h.type) && h.schedule);
            if (override) return forDay(override.schedule, dayName);

            if (dateIso >= todayIso) {
                // 2. Future master starting after today and by this date, else the live timetable
                const fm = (await futureMasters())
                    .filter(h => h.date > todayIso && h.date <= dateIso)
                    .sort((a, b) => b.date.localeCompare(a.date))[0];
                if (fm) return forDay(fm.schedule, dayName);
                return liveRows(dayName);
            }
            // 3. Past date: the master that applied then
            const master = await pastMaster(dateIso);
            if (master) return forDay(master.schedule, dayName);
            return liveRows(dayName);
        }

        function loadRosters(dateIso) {
            const key = "d|" + dateIso;
            if (!rosterPromises.has(key)) {
                const rosters = col("duty_rosters");
                const examStart = "exam_duty_" + dateIso;
                const monday = mondayOf(dateIso);
                const lunchIds = ["lunch_duty_" + monday, "lunch_duty_" + addDays(monday, -1)]; // older saves may be dated the Sunday before
                const p = Promise.all([
                    // every exam duty chart of that date, including shift charts like exam_duty_<date>_9AM
                    rosters.where(docIdField(), ">=", examStart).where(docIdField(), "<", examStart + "").get()
                        .then(s => s.docs.forEach(d => rosterById.set(d.id, { id: d.id, ...d.data() }))),
                    ...lunchIds.map(id => rosters.doc(id).get().then(d => { if (d.exists) rosterById.set(d.id, { id: d.id, ...d.data() }); }))
                ]);
                p.catch(() => rosterPromises.delete(key));
                rosterPromises.set(key, p);
            }
            return rosterPromises.get(key);
        }

        // Loads everything needed for these dates. Safe to call again: loaded dates are skipped.
        async function ensureDates(dates, options) {
            const withRosters = !options || options.rosters !== false;
            const unique = [...new Set((dates || []).filter(Boolean))];
            await Promise.all(unique.map(dateIso => {
                if (!datePromises.has(dateIso)) {
                    const p = loadDate(dateIso).then(rows => { dayRowsByDate.set(dateIso, rows); });
                    p.catch(() => datePromises.delete(dateIso)); // allow a retry after a failure
                    datePromises.set(dateIso, p);
                }
                return Promise.all([datePromises.get(dateIso), withRosters ? loadRosters(dateIso) : null]);
            }));
        }

        function isLoaded(dateIso) { return dayRowsByDate.has(dateIso); }

        // Copy of the rows for that date's weekday (callers may add to it)
        function dayRows(dateIso) {
            const rows = dayRowsByDate.get(dateIso);
            if (!rows) throw new Error("Timetable for " + dateIso + " is not loaded yet.");
            return rows.slice();
        }

        // Duty charts that cover these dates
        function dutyRosters(dates) {
            const want = new Set(dates || []);
            return [...rosterById.values()].filter(r => {
                if (r.id.startsWith("exam_duty_")) return want.has(r.id.substr("exam_duty_".length, 10));
                if (r.id.startsWith("lunch_duty_")) {
                    const week = mondayOf(r.id.substr("lunch_duty_".length, 10));
                    return [...want].some(d => mondayOf(d) === week);
                }
                return false;
            });
        }

        // Date (YYYY-MM-DD) of a duty shift: exam charts are for one date; lunch charts for one week (column = weekday)
        function dutyDateOf(roster, colKey) {
            if (roster.id.startsWith("exam_duty_")) return roster.id.substr("exam_duty_".length, 10);
            if (roster.id.startsWith("lunch_duty_")) {
                const offsets = { Monday: 0, Tuesday: 1, Wednesday: 2, Thursday: 3, Friday: 4, Saturday: 5 };
                if (offsets[colKey] === undefined) return "";
                return addDays(mondayOf(roster.id.substr("lunch_duty_".length, 10)), offsets[colKey]);
            }
            return "";
        }

        return { ensureDates, isLoaded, dayRows, dutyRosters, dutyDateOf };
    }

    // ------------------------------------------------------------------------
    // SUBSTITUTION ENTRIES (leave_requests.adjustments) — shared rules
    //   assignedBy: "APPLICANT" | "INCHARGE" | "ADMIN"  (+ assignedByName)
    //   Incharge / admin assignments are orders: saved as ACCEPTED.
    //   Assigning again for the same class REPLACES the old entry (kept in adjustmentHistory).
    // ------------------------------------------------------------------------
    const normTxt = (s) => String(s || "").replace(/[^a-zA-Z0-9]/g, "").toLowerCase();

    // "10 | A", "10 | Sec A" -> { cls: "10", sec: "A" }
    function adjClass(adj) {
        const parts = String((adj && adj.sub) || "").split("|");
        return { cls: (parts[0] || "").trim(), sec: (parts[1] || "").trim().replace(/^sec(tion)?\s*/i, "") };
    }
    // A class substitution (not an exam/lunch duty or an extra responsibility)
    function isClassAdj(adj) {
        if (!adj) return false;
        if (adj.type === "CLASS") return true;
        if (adj.type) return false;
        return String(adj.sub || "").includes("|") && adj.title !== "Extra Duty";
    }
    // Same date, same class + section, overlapping time
    function adjMatchesClass(adj, dateIso, className, section, startMins, endMins) {
        if (!isClassAdj(adj) || adj.date !== dateIso) return false;
        const c = adjClass(adj);
        if (normTxt(c.cls) !== normTxt(className) || normTxt(c.sec) !== normTxt(section)) return false;
        return adj.start < endMins && adj.end > startMins;
    }
    function isWaitingForIncharge(adj) {
        return adj.adjustedTo === "INCHARGE" && adj.substituteResponse !== "ACCEPTED";
    }
    // Does this entry cover the class? Accepted or still waiting for the substitute's answer.
    function adjCovers(adj) {
        if (isWaitingForIncharge(adj)) return false;
        const r = adj.substituteResponse;
        return r === "ACCEPTED" || !r || r === "PENDING";
    }
    function adjStatusText(adj) {
        if (isWaitingForIncharge(adj)) return "🚨 Waiting for Incharge";
        const r = adj.substituteResponse;
        if (r === "ACCEPTED") return "✅ Accepted";
        if (r === "DECLINED") return "❌ Declined";
        if (r === "BROKEN_BY_ADMIN") return "⚠️ Needs Re-Assign";
        return "⏳ Pending";
    }
    function assignedByOf(adj) {
        if (adj.assignedBy) return adj.assignedBy;
        const m = String(adj.substituteMessage || "");
        if (/Force Assigned by Leave Incharge/i.test(m)) return "INCHARGE";
        if (/Force Assigned/i.test(m)) return "ADMIN";
        return "APPLICANT";
    }
    function assignedByText(adj) {
        if (isWaitingForIncharge(adj)) return "🙋 Applicant asked Incharge";
        const who = assignedByOf(adj);
        const name = adj.assignedByName ? ` (${adj.assignedByName})` : "";
        if (who === "INCHARGE") return `👤 By Leave Incharge${name}`;
        if (who === "ADMIN") return `🛡️ By Admin${name}`;
        return "🙋 By Applicant";
    }
    // One line for WhatsApp:  Rohit Sharma (Maths) [✅ Accepted | 👤 By Leave Incharge (Name) | 🔁 replaced X]
    function subLine(adj, deptOf) {
        const dept = (adj.adjustedEmail && adj.adjustedEmail !== "ADMIN" && deptOf) ? deptOf(adj.adjustedEmail) : "";
        const name = isWaitingForIncharge(adj) ? "Not assigned yet" : (adj.adjustedTo || "-");
        const parts = [adjStatusText(adj), assignedByText(adj)];
        if (adj.replacedFrom) parts.push(`🔁 replaced ${adj.replacedFrom}`);
        return `${name}${dept ? ` (${dept})` : ""} [${parts.join(" | ")}]`;
    }

    global.MinervaLeaveSchedule = { create, localIso, dayNameOf, mondayOf, addDays,
        adjClass, isClassAdj, adjMatchesClass, adjCovers, isWaitingForIncharge, adjStatusText, assignedByOf, assignedByText, subLine,
        VERSION: 2 };
})(typeof window !== "undefined" ? window : globalThis);
