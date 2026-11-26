// ============================================================================
// MINERVA — SHARED CLASS-DAY RULES  (one copy used by every page)
// ----------------------------------------------------------------------------
// Answers, for a class + section + subject on a date:
//   - which timetable applied that day            -> scheduleFor(dateIso)
//   - is the day excluded, and why                -> exclusion(dateObj, cls, sec, sub)
//   - is the class in the timetable that day      -> workingDay(dateObj, cls, sec, sub)
//
// Used by: teacher-lesson-planner.html, admin-lesson-planner.html, teacher-portal.html
// Before, each page had its own copy and they disagreed in 4 places. Agreed rules:
//   1. A CANCELLED holiday is not a holiday.
//   2. A holiday for one section ("10|A") affects only that section; a whole-class
//      target ("10") or "ALL" affects every section.
//   3. A CANCELLED override day (or cancelled master copy) is ignored.
//   4. LIVE_MASTER_UPDATE, APPLIED_MASTER and FUTURE_MASTER copies all count as the
//      master timetable from their date onward.
//
// Answers are remembered per date & subject and forgotten automatically whenever a
// page reloads its holidays / history / timetable.
// ============================================================================
(function (global) {
    "use strict";

    const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const MASTER_TYPES = ["LIVE_MASTER_UPDATE", "APPLIED_MASTER", "FUTURE_MASTER"];
    const OVERRIDE_TYPES = ["DAILY_OVERRIDE", "EXAM_OVERRIDE"];
    const norm = (str) => (str || "").replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
    const EMPTY = Object.freeze([]); // stable "no data yet" value, so remembered answers are kept

    function localIso(dateObj) {
        const offset = dateObj.getTimezoneOffset() * 60000;
        return (new Date(dateObj.getTime() - offset)).toISOString().split("T")[0];
    }

    // Rule 2: does a holiday target this class + section?
    function holidayTargetsClass(h, className, sectionName) {
        const targetCls = `${norm(className)}|${norm(sectionName)}`;
        return (h.targetClasses || []).some(tc => {
            if (tc === "ALL") return true;
            const parts = String(tc).split("|");
            if (parts.length > 1) {
                const tcNorm = norm(parts[0]) + (parts[1] ? "|" + norm(parts[1]) : "");
                return tcNorm === targetCls;            // section-specific: exact section only
            }
            return norm(parts[0]) === norm(className);  // whole class
        });
    }

    // source: { history(): [...], holidays(): [...], live(): [...] }  (functions, read on every call)
    function create(source) {
        let memo = null;
        function getMemo() {
            const hist = source.history() || EMPTY, hol = source.holidays() || EMPTY, live = source.live() || EMPTY;
            if (!memo || memo.hist !== hist || memo.hol !== hol || memo.live !== live) {
                const usable = hist.filter(h => h && h.status !== "CANCELLED");             // Rule 3
                const overrideByDate = new Map();
                usable.forEach(h => {
                    if (OVERRIDE_TYPES.includes(h.type) && h.schedule && !overrideByDate.has(h.date)) overrideByDate.set(h.date, h);
                });
                const masters = usable.filter(h => MASTER_TYPES.includes(h.type) && h.schedule && typeof h.date === "string") // Rule 4
                                      .sort((a, b) => b.date.localeCompare(a.date));
                memo = { hist, hol, live, overrideByDate, masters, hasHistory: hist.length > 0,
                         snapshot: new Map(), exclusion: new Map(), working: new Map() };
            }
            return memo;
        }

        // Index per schedule array: "Day|class|section|subject" -> slots (original order kept)
        const slotIndexCache = new WeakMap();
        function findSlots(schedule, dayName, className, sectionName, subjectName) {
            if (!Array.isArray(schedule)) return [];
            let index = slotIndexCache.get(schedule);
            if (!index) {
                index = new Map();
                schedule.forEach(t => {
                    const key = `${t.day}|${norm(t.className)}|${norm(t.section)}|${norm(t.subject)}`;
                    if (!index.has(key)) index.set(key, []);
                    index.get(key).push(t);
                });
                slotIndexCache.set(schedule, index);
            }
            return index.get(`${dayName}|${norm(className)}|${norm(sectionName)}|${norm(subjectName)}`) || [];
        }

        function scheduleFor(dateIso) {
            const m = getMemo();
            if (!m.hasHistory) return m.live;
            if (m.snapshot.has(dateIso)) return m.snapshot.get(dateIso);
            let result = m.live;
            const override = m.overrideByDate.get(dateIso);
            if (override) result = override.schedule;
            else {
                const master = m.masters.find(h => h.date <= dateIso);
                if (master) result = master.schedule;
            }
            m.snapshot.set(dateIso, result);
            return result;
        }

        function exclusionRaw(dateObj, className, sectionName, subjectName) {
            if (dateObj.getDay() === 0) return { isExcluded: true, reason: "Sunday (Weekly Off)" };
            const m = getMemo();
            const curStr = localIso(dateObj);
            const checkDate = new Date(curStr); checkDate.setHours(0, 0, 0, 0);

            for (const h of m.hol) {
                if (!h.startDate || h.status === "CANCELLED" || h.suspendClasses === false) continue;   // Rule 1
                const hStart = new Date(h.startDate); hStart.setHours(0, 0, 0, 0);
                const hEnd = new Date(h.endDate || h.startDate); hEnd.setHours(23, 59, 59, 999);
                if (checkDate < hStart || checkDate > hEnd) continue;
                if (!holidayTargetsClass(h, className, sectionName)) continue;                         // Rule 2

                if (h.isFullDay) return { isExcluded: true, reason: h.reason };
                if (h.startTime && h.endTime) {
                    const dayName = DAYS[dateObj.getDay()];
                    let classSlots = findSlots(scheduleFor(curStr), dayName, className, sectionName, subjectName);
                    if (classSlots.length === 0) classSlots = findSlots(m.live, dayName, className, sectionName, subjectName);
                    if (classSlots.length > 0) {
                        const [hsh, hsm] = h.startTime.split(":").map(Number);
                        const [heh, hem] = h.endTime.split(":").map(Number);
                        const hStartMins = hsh * 60 + hsm, hEndMins = heh * 60 + hem;
                        const isOverlapping = classSlots.some(slot => {
                            if (!slot.start24 || !slot.end24) return false;
                            const [sh, sm] = slot.start24.split(":").map(Number);
                            const [eh, em] = slot.end24.split(":").map(Number);
                            return (sh * 60 + sm) < hEndMins && (eh * 60 + em) > hStartMins;
                        });
                        if (isOverlapping) return { isExcluded: true, reason: h.reason + " (Half Day)" };
                    }
                }
            }

            const masterSlot = findSlots(scheduleFor(curStr), DAYS[checkDate.getDay()], className, sectionName, subjectName)[0];
            if (!masterSlot) return { isExcluded: true, reason: "Class Not Scheduled" };
            if (masterSlot.remark && masterSlot.remark.toLowerCase().includes("doubt session")) return { isExcluded: true, reason: "Doubt Session" };
            return { isExcluded: false, reason: "" };
        }

        function exclusion(dateObj, className, sectionName, subjectName) {
            const m = getMemo();
            const key = `${localIso(dateObj)}|${className}|${sectionName}|${subjectName}`;
            if (!m.exclusion.has(key)) m.exclusion.set(key, exclusionRaw(dateObj, className, sectionName, subjectName));
            return { ...m.exclusion.get(key) };
        }

        function workingDay(dateObj, className, sectionName, subjectName) {
            if (dateObj.getDay() === 0) return false;
            const m = getMemo();
            const curStr = localIso(dateObj);
            const key = `${curStr}|${className}|${sectionName}|${subjectName}`;
            if (!m.working.has(key)) {
                m.working.set(key, findSlots(scheduleFor(curStr), DAYS[dateObj.getDay()], className, sectionName, subjectName).length > 0);
            }
            return m.working.get(key);
        }

        return { scheduleFor, exclusion, workingDay, findSlots };
    }

    global.MinervaDateRules = { create, norm, localIso, holidayTargetsClass, MASTER_TYPES, OVERRIDE_TYPES, DAYS, VERSION: 1 };
})(typeof window !== "undefined" ? window : globalThis);
