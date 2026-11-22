(function attachMinervaSupabaseBridge() {
    const SUPABASE_URL = "https://lpccpiozrqgxgusculbs.supabase.co";
    const SUPABASE_ANON_KEY = "sb_publishable_1q3Xilxs8lSK_dyWwbfvzQ_7zJOQV6v";

    if (!window.supabase || typeof window.supabase.createClient !== "function") {
        console.error("Supabase JS SDK not loaded before supabase-attendance-bridge.js");
        return;
    }

    const sbClient = window.sb || window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    window.sb = sbClient;

    window.allBranchesList = window.allBranchesList || [];
    window.allSessionsList = window.allSessionsList || [];
    window.activeBranchId = window.activeBranchId || null;
    window.activeSessionId = window.activeSessionId || null;
    window.activeSessionName = window.activeSessionName || "2026 - 2027";

    const TABLES_WITH_FIRESTORE_ID = new Set([
        "attendance_records",
        "students",
        "remedial_classes",
        "exam_seating_rooms",
        "duty_rosters"
    ]);

    const GLOBAL_OR_NON_BRANCH_TABLES = new Set([
        "staff_applications",
        "branches",
        "branch_sessions",
        "attendance_edit_requests",
        "attendance_corrections",
        "attendance_remarks",
        "exam_incident_reports"
    ]);

    function parseJson(val) {
        if (!val) return {};
        if (typeof val === "object" && !Array.isArray(val)) return val;
        if (typeof val === "string") {
            try { return JSON.parse(val); } catch (_) { return {}; }
        }
        return {};
    }

    function normSession(lbl) {
        return String(lbl || "").replace(/\s+/g, "").replace(/[–—−]/g, "-");
    }

    function cleanTableName(rawName) {
        return String(rawName || "")
            .replace(/^ghumarwin_/i, "")
            .replace(/^dharamshala_/i, "");
    }

    function mapCol(table, field) {
        const map = {
            monthKey: "month_key",
            className: "class_name",
            sectionName: "section_name",
            roomName: "room_name",
            studentId: "student_id",
            studentName: "student_name",
            rollNo: "roll_no",
            admNo: "adm_no",
            teacherEmail: "teacher_email",
            teacherName: "teacher_name",
            startDate: "start_date",
            endDate: "end_date",
            admissionStatus: "admission_status",
            isActive: "is_active",
            isFullDay: "is_full_day",
            suspendClasses: "suspend_classes",
            startTime: "start_time",
            endTime: "end_time",
            targetClasses: "target_classes",
            targetStaff: "target_staff",
            authorizerName: "authorizer_name",
            authorizerDept: "authorizer_dept",
            authorizerEmail: "authorizer_email",
            requestType: "request_type",
            teacherAcknowledged: "teacher_acknowledged",
            approvedAt: "approved_at_ms",
            rejectedAt: "rejected_at_ms",
            usedAt: "used_at_ms",
            acknowledgedAt: "acknowledged_at_ms",
            lastUpdated: "last_updated_ms",
            aggregatedStats: "aggregated_stats",
            oldStatus: "old_status",
            newStatus: "new_status",
            invigilatorName: "invigilator_name",
            invigilatorEmail: "invigilator_email",
            attendancePermission: "attendance_permission"
        };
        if (["attendance_remarks", "attendance_edit_requests", "special_leaves", "exam_incident_reports", "attendance_corrections", "school_holidays"].includes(table) && field === "timestamp") {
            return "timestamp_ms";
        }
        return map[field] || field;
    }

    function mapPayloadColumns(table, payload) {
        const out = {};
        Object.entries(payload || {}).forEach(([k, v]) => {
            out[mapCol(table, k)] = v;
        });
        return out;
    }

    function normalizeRowForApp(table, row) {
        const raw = parseJson(row.raw_data);
        const det = parseJson(row.details);
        const base = {
            ...raw,
            ...row,
            id: row.firestore_id || row.id,
            _uuid: row.id
        };

        if (table === "staff_applications") {
            return {
                ...base,
                details: det,
                attendancePermission: row.attendance_permission ?? row.attendancePermission ?? det.attendancePermission ?? null
            };
        }

        if (table === "students") {
            const rawAddl = row.additional_sections ?? raw.additionalSections ?? [];
            return {
                ...base,
                className: row.class_name ?? raw.className ?? "",
                section: row.section ?? raw.section ?? "",
                additionalSections: Array.isArray(rawAddl) ? rawAddl : [],
                optionalSubject: row.optional_subject ?? raw.optionalSubject ?? "",
                optSubEffectiveDate: row.opt_sub_effective_date ?? raw.optSubEffectiveDate ?? "",
                rollNo: row.roll_no ?? raw.rollNo ?? "",
                admNo: row.adm_no ?? raw.admNo ?? "",
                addDate: row.add_date ?? raw.addDate ?? "",
                fMobile: row.f_mobile ?? raw.fMobile ?? "",
                mMobile: row.m_mobile ?? raw.mMobile ?? "",
                admissionStatus: row.admission_status ?? raw.admissionStatus ?? "APPROVED",
                isActive: row.is_active !== false,
                statusChangeDate: row.status_change_date ?? raw.statusChangeDate ?? "",
                statusRemark: row.status_remark ?? raw.statusRemark ?? "",
                prevClass: row.prev_class ?? raw.prevClass ?? "",
                prevSection: row.prev_section ?? raw.prevSection ?? "",
                transferDate: row.transfer_date ?? raw.transferDate ?? ""
            };
        }

        if (table === "institute_structure") {
            return {
                ...base,
                className: row.class_name ?? raw.className ?? "",
                sectionName: row.section_name ?? raw.sectionName ?? "",
                subjects: Array.isArray(row.subjects) ? row.subjects : (raw.subjects || []),
                optionalSubjects: Array.isArray(row.optional_subjects) ? row.optional_subjects : (raw.optionalSubjects || []),
                secInchargeName: row.sec_incharge_name ?? raw.secInchargeName ?? "",
                classInchargeName: row.class_incharge_name ?? raw.classInchargeName ?? "",
                registerHeader: row.register_header ?? raw.registerHeader ?? "",
                registerName: row.register_name ?? raw.registerName ?? ""
            };
        }

        if (table === "timetable") {
            return {
                ...base,
                className: row.class_name ?? raw.className ?? "",
                section: row.section ?? raw.section ?? "",
                sectionName: row.section ?? raw.sectionName ?? "",
                teacher: row.teacher ?? row.teacher_name ?? raw.teacher ?? "NONE",
                teacherName: row.teacher_name ?? row.teacher ?? raw.teacherName ?? "NONE",
                timeRange: row.time_range ?? raw.timeRange ?? ""
            };
        }

        if (table === "school_holidays") {
            return {
                ...base,
                startDate: row.start_date ?? raw.startDate,
                endDate: row.end_date ?? raw.endDate ?? row.start_date,
                isFullDay: row.is_full_day !== false,
                suspendClasses: row.suspend_classes !== false,
                startTime: row.start_time ?? raw.startTime ?? "",
                endTime: row.end_time ?? raw.endTime ?? "",
                targetClasses: Array.isArray(row.target_classes) ? row.target_classes : (raw.targetClasses || ["ALL"])
            };
        }

        if (table === "timetable_history") {
            return {
                ...base,
                type: row.entry_type ?? row.type ?? raw.type ?? "",
                schedule: Array.isArray(row.schedule) ? row.schedule : (raw.schedule || [])
            };
        }

        if (table === "attendance_records") {
            return {
                ...base,
                className: row.class_name ?? raw.className ?? "",
                section: row.section ?? raw.section ?? "",
                monthKey: row.month_key ?? raw.monthKey ?? "",
                records: parseJson(row.records),
                aggregatedStats: parseJson(row.aggregated_stats ?? row.aggregatedStats),
                lastUpdated: row.last_updated_ms ?? row.lastUpdated ?? 0
            };
        }

        if (table === "special_leaves") {
            return {
                ...base,
                studentId: row.student_id ?? raw.studentId ?? "",
                className: row.class_name ?? raw.className ?? "",
                section: row.section ?? raw.section ?? "",
                startTime: row.start_time ?? raw.startTime ?? "",
                endTime: row.end_time ?? raw.endTime ?? "",
                authorizerName: row.authorizer_name ?? raw.authorizerName ?? "Admin",
                authorizerDept: row.authorizer_dept ?? raw.authorizerDept ?? "Admin Office",
                timestamp: row.timestamp_ms ?? row.timestamp ?? 0
            };
        }

        if (table === "attendance_edit_requests") {
            return {
                ...base,
                className: row.class_name ?? raw.className ?? "",
                section: row.section ?? raw.section ?? "",
                teacherEmail: row.teacher_email ?? raw.teacherEmail ?? "",
                teacherName: row.teacher_name ?? raw.teacherName ?? "",
                requestType: row.request_type ?? raw.requestType ?? "EDIT",
                teacherAcknowledged: Boolean(row.teacher_acknowledged ?? raw.teacherAcknowledged),
                timestamp: row.timestamp_ms ?? row.timestamp ?? 0
            };
        }

        if (table === "attendance_remarks") {
            return {
                ...base,
                studentId: row.student_id ?? raw.studentId ?? "",
                timestamp: row.timestamp_ms ?? row.timestamp ?? 0
            };
        }

        if (table === "exam_seating_rooms" || table === "exam_seating_allocations") {
            return {
                ...base,
                roomName: row.room_name ?? raw.roomName ?? "",
                allocations: parseJson(row.allocations)
            };
        }

        if (table === "duty_rosters") {
            return {
                ...base,
                rosterData: parseJson(row.roster_data ?? row.rosterData)
            };
        }

        return base;
    }

    async function ensureContext() {
        if (window.activeBranchId) return;
        const [bRes, sRes] = await Promise.all([
            sbClient.from("branches").select("*").order("created_at", { ascending: true }),
            sbClient.from("branch_sessions").select("*").order("start_date", { ascending: false })
        ]);
        window.allBranchesList = (bRes.data || []).filter(b => b.is_active !== false);
        window.allSessionsList = sRes.data || [];

        const targetName = String(window.activeCenter || sessionStorage.getItem("minervaAdminCenter") || "GHUMARWIN").trim().toUpperCase();
        const branch = window.allBranchesList.find(b => String(b.name || "").trim().toUpperCase().includes(targetName)) || window.allBranchesList[0];
        if (branch) {
            window.activeBranchId = branch.id;
            window.activeCenter = String(branch.name || targetName).trim().toUpperCase();
            const bSess = window.allSessionsList.filter(s => s.branch_id === branch.id && s.is_active !== false);
            const savedSess = sessionStorage.getItem(`minerva_att_session_${branch.id}`) || sessionStorage.getItem(`minerva_session_${branch.id}`);
            const chosen = bSess.find(s => s.id === savedSess) || bSess.find(s => normSession(s.session_name) === "2026-2027") || bSess[0];
            window.activeSessionId = chosen ? chosen.id : null;
            window.activeSessionName = chosen ? chosen.session_name : "2026 - 2027";
        }
    }

    function makeCollectionRef(rawName) {
        const table = cleanTableName(rawName);
        const filters = [];
        let orderSpec = null;
        let limitN = null;

        const execSelect = async () => {
            await ensureContext();
            let q = sbClient.from(table).select("*");
            if (!GLOBAL_OR_NON_BRANCH_TABLES.has(table) && window.activeBranchId) {
                q = q.eq("branch_id", window.activeBranchId);
                if (window.activeSessionId) q = q.eq("session_id", window.activeSessionId);
            }
            for (const f of filters) {
                if (table === "exam_seating_rooms" && f.field === "center") continue;
                const col = mapCol(table, f.field);
                if (f.op === "==") q = q.eq(col, f.val);
                else if (f.op === "!=") q = q.neq(col, f.val);
                else if (f.op === ">=") q = q.gte(col, f.val);
                else if (f.op === "<=") q = q.lte(col, f.val);
                else if (f.op === "in" && Array.isArray(f.val)) q = q.in(col, f.val);
            }
            if (orderSpec) {
                q = q.order(mapCol(table, orderSpec.field), { ascending: orderSpec.dir !== "desc" });
            }
            if (limitN) q = q.limit(limitN);

            const { data, error } = await q;
            if (error) throw error;
            const docs = (data || []).map(r => {
                const norm = normalizeRowForApp(table, r);
                return { id: norm.id, _uuid: r.id, data: () => norm };
            });
            return { empty: docs.length === 0, size: docs.length, docs, forEach: (fn) => docs.forEach(fn) };
        };

        const chain = {
            where: (field, op, val) => { filters.push({ field, op, val }); return chain; },
            orderBy: (field, dir = "asc") => { orderSpec = { field, dir }; return chain; },
            limit: (n) => { limitN = n; return chain; },
            get: execSelect,
            onSnapshot: (cb) => { execSelect().then(cb).catch(err => console.error(err)); return () => {}; },
            add: async (payload) => {
                await ensureContext();
                const row = mapPayloadColumns(table, payload);
                if (!GLOBAL_OR_NON_BRANCH_TABLES.has(table)) {
                    if (!row.branch_id && window.activeBranchId) row.branch_id = window.activeBranchId;
                    if (!row.session_id && window.activeSessionId) row.session_id = window.activeSessionId;
                }
                const { data, error } = await sbClient.from(table).insert([row]).select().single();
                if (error) throw error;
                return { id: data.id, data: () => normalizeRowForApp(table, data) };
            },
            doc: (docId) => {
                const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(docId || ""));
                const hasFsCol = TABLES_WITH_FIRESTORE_ID.has(table);

                const applyKeyFilter = (query) => {
                    if (isUuid && hasFsCol) return query.or(`id.eq.${docId},firestore_id.eq.${docId}`);
                    if (isUuid) return query.eq("id", docId);
                    if (hasFsCol) return query.eq("firestore_id", docId);
                    return query.eq("id", docId);
                };

                return {
                    id: docId,
                    get: async () => {
                        await ensureContext();
                        let q = sbClient.from(table).select("*");
                        if (!GLOBAL_OR_NON_BRANCH_TABLES.has(table) && window.activeBranchId) {
                            q = q.eq("branch_id", window.activeBranchId);
                            if (window.activeSessionId) q = q.eq("session_id", window.activeSessionId);
                        }
                        const { data, error } = await applyKeyFilter(q).limit(1);
                        if (error) throw error;
                        const found = data && data[0];
                        return {
                            exists: Boolean(found),
                            id: found ? (found.firestore_id || found.id) : docId,
                            data: () => (found ? normalizeRowForApp(table, found) : {})
                        };
                    },
                    set: async (payload) => {
                        await ensureContext();
                        const mapped = mapPayloadColumns(table, payload);
                        if (!GLOBAL_OR_NON_BRANCH_TABLES.has(table)) {
                            if (!mapped.branch_id && window.activeBranchId) mapped.branch_id = window.activeBranchId;
                            if (!mapped.session_id && window.activeSessionId) mapped.session_id = window.activeSessionId;
                        }

                        if (hasFsCol) {
                            if (!mapped.firestore_id) mapped.firestore_id = docId;
                            if (table === "attendance_records" && mapped.records && typeof mapped.records === "object") {
                                let existingQ = sbClient.from(table).select("id, records").eq("firestore_id", mapped.firestore_id);
                                if (mapped.branch_id) existingQ = existingQ.eq("branch_id", mapped.branch_id);
                                if (mapped.session_id) existingQ = existingQ.eq("session_id", mapped.session_id);
                                const { data: existingRows, error: selErr } = await existingQ.limit(1);
                                if (selErr) throw selErr;
                                if (existingRows && existingRows[0]) {
                                    const prevRecs = parseJson(existingRows[0].records);
                                    mapped.records = { ...prevRecs, ...mapped.records };
                                    const { error: updErr } = await sbClient
                                        .from(table)
                                        .update(mapped)
                                        .eq("id", existingRows[0].id);
                                    if (updErr) throw updErr;
                                    return;
                                }
                            }
                            const { error } = await sbClient.from(table).upsert([mapped], { onConflict: "firestore_id" });
                            if (error) throw error;
                        }
                            if (isUuid && !mapped.id) mapped.id = docId;
                            const { error } = isUuid
                                ? await sbClient.from(table).upsert([mapped], { onConflict: "id" })
                                : await sbClient.from(table).insert([mapped]);
                            if (error) throw error;
                        }
                    },
                    update: async (payload) => {
                        const mapped = mapPayloadColumns(table, payload);
                        const { error } = await applyKeyFilter(sbClient.from(table).update(mapped));
                        if (error) throw error;
                    },
                    delete: async () => {
                        const { error } = await applyKeyFilter(sbClient.from(table).delete());
                        if (error) throw error;
                    }
                };
            }
        };
        return chain;
    }

    window.getCollection = makeCollectionRef;
    window.db = {
        collection: makeCollectionRef,
        batch: () => {
            const ops = [];
            return {
                set: (ref, data) => ops.push(() => ref.set(data)),
                update: (ref, data) => ops.push(() => ref.update(data)),
                delete: (ref) => ops.push(() => ref.delete()),
                commit: async () => { for (const fn of ops) await fn(); }
            };
        }
    };

    window.fetchMonthAttendanceDocs = async function(monthKey, className = null, sectionName = null) {
        await ensureContext();
        let q = sbClient.from("attendance_records").select("*").eq("branch_id", window.activeBranchId).eq("month_key", monthKey);
        if (window.activeSessionId) q = q.eq("session_id", window.activeSessionId);
        if (className) q = q.eq("class_name", className);
        if (sectionName) q = q.eq("section", sectionName);
        const { data, error } = await q;
        if (error) throw error;
        return (data || []).map(r => {
            const norm = normalizeRowForApp("attendance_records", r);
            return { id: norm.id, _uuid: r.id, data: norm };
        });
    };

    window.getStudentsRoster = async function() {
        await ensureContext();
        let q = sbClient.from("students").select("*").eq("branch_id", window.activeBranchId);
        if (window.activeSessionId) q = q.eq("session_id", window.activeSessionId);
        const { data, error } = await q;
        if (error) throw error;
        return (data || []).map(r => normalizeRowForApp("students", r)).filter(s => s.admissionStatus !== "PENDING");
    };

    window.getCachedMonthAttendanceDocs = window.fetchMonthAttendanceDocs;
    window.getCachedStudentsRoster = window.getStudentsRoster;
    window.bumpAttendanceMetadata = async () => {};
})();
