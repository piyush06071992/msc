const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { PDFDocument, rgb, StandardFonts } = require("pdf-lib");
const crypto = require("crypto");
const puppeteer = require("puppeteer-core");
const chromium = require("@sparticuz/chromium");

if (!admin.apps.length) {
    admin.initializeApp();
}

// =======================================================
// --- 10-MINUTE PRE-CLASS REMINDER CRON JOB ---
// =======================================================
exports.sendPreClassReminders = onSchedule({
    schedule: "every 5 minutes",
    timeZone: "Asia/Kolkata",
    region: "asia-south1",
    memory: "512MB"
}, async (event) => {
    const utcDate = new Date();
    const istString = utcDate.toLocaleString("en-US", { timeZone: "Asia/Kolkata" });
    const istDate = new Date(istString);
    
    const daysArr = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const currentDay = daysArr[istDate.getDay()];
    
    const year = istDate.getFullYear();
    const month = String(istDate.getMonth() + 1).padStart(2, '0');
    const day = String(istDate.getDate()).padStart(2, '0');
    const todayIso = `${year}-${month}-${day}`;

    const currentHour = istDate.getHours();
    const currentDayNum = istDate.getDay();

    if (currentDayNum === 0) return null;
    if (currentHour < 8 || currentHour >= 17) return null;
    
    const actualMins = istDate.getHours() * 60 + istDate.getMinutes();
    const snappedCurrentMins = Math.floor(actualMins / 5) * 5; 
    const targetMins = snappedCurrentMins + 10; 

    const targetHour = Math.floor(targetMins / 60).toString().padStart(2, '0');
    const targetMinute = (targetMins % 60).toString().padStart(2, '0');
    const targetTimeStr = `${targetHour}:${targetMinute}`;

    try {
        let notifications = [];
        const branches = [
            { prefix: "", name: "Ghumarwin" },
            { prefix: "dharamshala_", name: "Dharamshala" }
        ];

        for (const branch of branches) {
            const historyCol = `${branch.prefix}timetable_history`;
            const masterCol = `${branch.prefix}timetable`;
            
            let branchSchedule = [];
            let isOverride = false;

            const historyDoc = await admin.firestore().collection(historyCol).doc(todayIso).get();
            if (historyDoc.exists) {
                const hData = historyDoc.data();
                if (hData.type === "DAILY_OVERRIDE" || hData.type === "EXAM_OVERRIDE") {
                    isOverride = true;
                    branchSchedule = hData.schedule || [];
                }
            }

            if (isOverride) {
                const targetSlots = branchSchedule.filter(slot => 
                    slot.day === currentDay && 
                    slot.start24 === targetTimeStr
                );
                
                targetSlots.forEach(slot => {
                    if ((slot.teacherEmail || slot.teacherName || slot.teacher) && slot.subject) {
                        notifications.push({
                            teacherEmail: slot.teacherEmail || "",
                            teacherName: slot.teacherName || slot.teacher || "",
                            subject: slot.subject,
                            className: slot.className,
                            section: slot.section,
                            timeRange: slot.timeRange || targetTimeStr,
                            branch: branch.name
                        });
                    }
                });
            } else {
                const ttSnap = await admin.firestore().collection(masterCol)
                    .where("day", "==", currentDay)
                    .where("start24", "==", targetTimeStr)
                    .get();

                ttSnap.forEach(doc => {
                    const slot = doc.data();
                    if ((slot.teacherEmail || slot.teacherName || slot.teacher) && slot.subject) {
                        notifications.push({
                            teacherEmail: slot.teacherEmail || "",
                            teacherName: slot.teacherName || slot.teacher || "",
                            subject: slot.subject,
                            className: slot.className,
                            section: slot.section,
                            timeRange: slot.timeRange || targetTimeStr,
                            branch: branch.name
                        });
                    }
                });
            }
        }

        if (notifications.length === 0) return null;

        for (let notif of notifications) {
            let staffSnap = null;
            if (notif.teacherEmail) {
                staffSnap = await admin.firestore().collection("staff_applications")
                    .where("email", "==", notif.teacherEmail)
                    .get();
            }
            if ((!staffSnap || staffSnap.empty) && notif.teacherName) {
                staffSnap = await admin.firestore().collection("staff_applications").get();
            }

            let targetToken = null;
            let latestTokenTime = 0;

            if (staffSnap && !staffSnap.empty) {
                staffSnap.forEach(staffDoc => {
                    const staffData = staffDoc.data();
                    const nameKey = Object.keys(staffData.details || {}).find(k => k.toLowerCase().includes('name'));
                    const staffFullName = nameKey ? staffData.details[nameKey] : (staffData.name || "");
                    
                    if (
                        (notif.teacherEmail && staffData.email === notif.teacherEmail) ||
                        (notif.teacherName && staffFullName.toLowerCase() === notif.teacherName.toLowerCase())
                    ) {
                        if (staffData.fcmToken) {
                            const tokenTime = staffData.tokenUpdatedAt || 0;
                            if (tokenTime >= latestTokenTime) {
                                targetToken = staffData.fcmToken;
                                latestTokenTime = tokenTime;
                            }
                        }
                    }
                });
            }

            if (targetToken) {
                const message = {
                    token: targetToken,
                    notification: {
                        title: "🔔 Class Starting in 10 Mins!",
                        body: `Your lecture for ${notif.subject} (Class ${notif.className} - Sec ${notif.section}) starts at ${notif.timeRange}.`
                    },
                    webpush: {
                        headers: { Urgency: "high" },
                        notification: { requireInteraction: true, vibrate: [300, 100, 300, 100, 300, 100, 500] },
                        fcmOptions: { link: "https://minervaacademy.web.app/teacher-portal.html" }
                    }
                };
                await admin.messaging().send(message);
            }
        }
    } catch (error) {
        console.error("[Reminders] Error:", error);
    }
    return null;
});

exports.sendInstantPushAlerts = onDocumentCreated({
    document: "instant_alerts/{docId}",
    region: "asia-south1",
    memory: "256MB"
}, async (event) => {
    const data = event.data.data();
    const teachers = data.teachers || [];
    if (teachers.length === 0) return null;

    let tokens = [];
    for (let t of teachers) {
        if (!t.name && !t.email) continue;
        let staffSnap;
        if (t.email) {
             staffSnap = await admin.firestore().collection("staff_applications").where("email", "==", t.email).get();
        } else if (t.name) {
             staffSnap = await admin.firestore().collection("staff_applications").get();
        }

        if (!staffSnap || staffSnap.empty) continue;

        let targetToken = null;
        let latestTokenTime = 0;

        staffSnap.forEach(doc => {
            const staffData = doc.data();
            const nameKey = Object.keys(staffData.details || {}).find(k => k.toLowerCase().includes('name'));
            const staffFullName = nameKey ? staffData.details[nameKey] : (staffData.name || "");
            
            if (
                (t.email && staffData.email === t.email) ||
                (t.name && staffFullName.toLowerCase() === t.name.toLowerCase())
            ) {
                if (staffData.fcmToken) {
                    const tokenTime = staffData.tokenUpdatedAt || 0;
                    if (tokenTime >= latestTokenTime) {
                        targetToken = staffData.fcmToken;
                        latestTokenTime = tokenTime;
                    }
                }
            }
        });
        
        if (targetToken && !tokens.includes(targetToken)) tokens.push(targetToken);
    }

    if (tokens.length === 0) return null;

    const message = {
        notification: {
            title: "🚨 Timetable Updated!",
            body: "The Admin has modified your upcoming schedule. Please tap to view your updated duties."
        },
        webpush: {
            headers: { Urgency: "high" },
            notification: { requireInteraction: true, vibrate: [300, 100, 300, 100, 300, 100, 500] },
            fcmOptions: { link: "https://minervaacademy.web.app/teacher-portal.html" }
        },
        tokens: tokens
    };

    try {
        await admin.messaging().sendEachForMulticast(message);
    } catch (error) {
        console.error("[Instant Alerts] Error sending multicast:", error);
    }
    return null;
});

async function loadPdfBytes(pdfUrl) {
    if (pdfUrl.includes("firebasestorage.googleapis.com")) {
        try {
            const match = pdfUrl.match(/\/o\/(.*?)\?/);
            if (match && match[1]) {
                const filePath = decodeURIComponent(match[1]);
                const [buffer] = await admin.storage().bucket().file(filePath).download();
                return buffer;
            }
        } catch (e) {
            console.warn("[PDF Engine] Admin SDK direct download failed:", e.message);
        }
    }

    for (let i = 0; i < 3; i++) {
        try {
            const res = await fetch(pdfUrl);
            if (res.ok) {
                const arrayBuf = await res.arrayBuffer();
                return Buffer.from(arrayBuf);
            }
        } catch (e) {
            if (i === 2) throw e;
        }
        await new Promise(resolve => setTimeout(resolve, 1500));
    }
    throw new Error(`Failed to download PDF from URL: ${pdfUrl}`);
}

async function compileSingleRoomPackage(center, date, roomName, allocations) {
    if (!allocations || Object.keys(allocations).length === 0) return false;

    const norm = (str) => String(str || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

    let roomOccupants = [];
    Object.keys(allocations).forEach(seatId => {
        if (seatId.toUpperCase().startsWith(`${roomName}-`.toUpperCase())) {
            roomOccupants.push({ seatId, student: allocations[seatId] });
        }
    });

    if (roomOccupants.length === 0) return false;
    roomOccupants.sort((a, b) => a.seatId.localeCompare(b.seatId, undefined, { numeric: true }));

    const prefix = center === "DHARAMSHALA" ? "dharamshala_" : "";
    const qpSnap = await admin.firestore().collection(`${prefix}question_papers`).where("date", "==", date).get();

    let papersBySection = {}; 
    qpSnap.forEach(doc => {
        const qp = doc.data();
        if (!qp.className || !qp.section || !qp.url) return;

        const secKey = `${norm(qp.className)}${norm(qp.section)}`;
        if (!papersBySection[secKey]) papersBySection[secKey] = {};
        
        const series = qp.series ? qp.series.toUpperCase() : "SERIES A";
        papersBySection[secKey][series] = qp.url;
    });

    const mergedPdf = await PDFDocument.create();
    const font = await mergedPdf.embedFont(StandardFonts.HelveticaBold);
    const availableSeries = ["SERIES A", "SERIES B", "SERIES C", "SERIES D"];

    let pdfBytesCache = {};

    for (let i = 0; i < roomOccupants.length; i++) {
        const { seatId, student } = roomOccupants[i];
        if (!student || !student.className || !student.section) continue;

        const secKey = `${norm(student.className)}${norm(student.section)}`;
        const sectionPapers = papersBySection[secKey] || {};
        const roomSeriesList = Object.keys(sectionPapers).length > 0 ? Object.keys(sectionPapers) : availableSeries;
        
        const assignedSeries = roomSeriesList[i % roomSeriesList.length];
        const pdfUrl = sectionPapers[assignedSeries] || Object.values(sectionPapers)[0];

        if (!pdfUrl) continue; 

        try {
            if (!pdfBytesCache[pdfUrl]) {
                pdfBytesCache[pdfUrl] = await loadPdfBytes(pdfUrl);
            }
            const pdfBytes = pdfBytesCache[pdfUrl];
            const studentPdf = await PDFDocument.load(pdfBytes);

            const pages = studentPdf.getPages();
            
            for (let pIdx = 0; pIdx < pages.length; pIdx++) {
                const page = pages[pIdx];
                const { width } = page.getSize();
                
                const leftText = `MINERVA STUDY CIRCLE  |  ${student.name.toUpperCase()}  (ROLL: #${student.rollNo || "—"})`;
                const rightText = `SEAT: ${seatId}    |    SEC: ${student.section}    |    ${assignedSeries}`;

                const size = 8.5;
                const color = rgb(0.2, 0.2, 0.2);
                const opacity = 0.7;

                const y = 6;
                const leftX = 36;
                const rightX = width - font.widthOfTextAtSize(rightText, size) - 36;

                page.drawText(leftText, { x: leftX, y, size, font, color, opacity });
                page.drawText(rightText, { x: rightX, y, size, font, color, opacity });
            }

            const copiedPages = await mergedPdf.copyPages(studentPdf, studentPdf.getPageIndices());
            copiedPages.forEach(p => mergedPdf.addPage(p));

            const currentPagesCount = copiedPages.length;
            const remainder = currentPagesCount % 4;
            if (remainder !== 0) {
                const pagesNeeded = 4 - remainder;
                for (let p = 0; p < pagesNeeded; p++) {
                    mergedPdf.addPage();
                }
            }
        } catch (err) {
            console.error(`[PDF Engine] Error processing paper for seat ${seatId}:`, err);
        }
    }

    if (mergedPdf.getPageCount() > 0) {
        const mergedPdfBytes = await mergedPdf.save();
        const storagePath = `print_packages/${center}/${date}/${roomName}_print_package.pdf`;
        const fileRef = admin.storage().bucket().file(storagePath);
        
        await fileRef.save(Buffer.from(mergedPdfBytes), {
            metadata: { contentType: "application/pdf" },
        });
        return true;
    }
    return false;
}

exports.compileSingleRoomOnDemand = onRequest({
    region: "asia-south1",
    memory: "2GiB",
    timeoutSeconds: 300,
    cors: true
}, async (req, res) => {
    const { center, date, roomName, type, seatId } = req.body;
    if (!center || !date || !roomName) {
        res.status(400).send({ error: "Missing required parameters: center, date, roomName" });
        return;
    }

    try {
        const prefix = center === "DHARAMSHALA" ? "dharamshala_" : "";

        if (type === 'omr') {
            const allocDoc = await admin.firestore().collection(`${prefix}exam_seating_allocations`).doc(`${center}_${date}`).get();
            if (!allocDoc.exists) {
                res.status(404).send({ error: "Seating allocations not found for this date." });
                return;
            }

            const allocations = allocDoc.data().allocations || {};
            let occupiedSeats = [];
            Object.keys(allocations).forEach(sId => {
                if (seatId ? (sId === seatId) : sId.startsWith(`${roomName}-`)) {
                    const stu = allocations[sId];
                    if (stu) occupiedSeats.push({ seatId: sId, stu });
                }
            });

            if (occupiedSeats.length === 0) {
                res.status(404).send({ error: `No students allocated in target scope.` });
                return;
            }

            occupiedSeats.sort((a, b) => a.seatId.localeCompare(b.seatId, undefined, { numeric: true }));

            let uniquePairs = new Set();
            occupiedSeats.forEach(item => uniquePairs.add(`${item.stu.className}|${item.stu.section}`));

            let structureMap = {};
            let examNameMap = {};
            
            for (const pair of uniquePairs) {
                const [className, sectionName] = pair.split('|');
                const groupSnap = await admin.firestore().collection("admin_paper_groups").where("date", "==", date).get();
                let targetGroupId = null;
                let fallbackSubjects = [];
                let currentExamName = "EXAMINATION OMR SHEET";

                groupSnap.forEach(doc => {
                    const data = doc.data();
                    const keys = data.sectionKeys || [];
                    const hasSec = keys.some(sk => {
                        const parts = sk.split('|');
                        return parts.length >= 3 && parts[1].trim().toUpperCase() === className.trim().toUpperCase() && parts[2].trim().toUpperCase() === sectionName.trim().toUpperCase();
                    });
                    if (hasSec) {
                        targetGroupId = doc.id;
                        fallbackSubjects = data.subjects || [];
                        currentExamName = data.combinedCode || "EXAMINATION OMR SHEET";
                    }
                });

                examNameMap[pair] = currentExamName;

                if (targetGroupId) {
                    const keyDoc = await admin.firestore().collection("exam_answer_keys").doc(targetGroupId).get();
                    if (keyDoc.exists && keyDoc.data().structure && keyDoc.data().structure.length > 0) {
                        structureMap[pair] = keyDoc.data().structure;
                        continue;
                    }
                }

                let defaultStruct = [];
                let startQ = 1;
                const subs = fallbackSubjects.length > 0 ? fallbackSubjects : ['PHYSICS', 'CHEMISTRY', 'MATHEMATICS'];
                subs.forEach(sub => {
                    defaultStruct.push({ subject: sub.toUpperCase(), start: startQ, end: startQ + 24, type: 'MCQ' });
                    startQ += 25;
                });
                structureMap[pair] = defaultStruct;
            }

            let fullPagesHtml = "";
            const prettyDate = new Date(date + 'T00:00:00').toLocaleDateString('en-GB');

            occupiedSeats.forEach(({ seatId: sId, stu }) => {
                const pairKey = `${stu.className}|${stu.section}`;
                const structure = structureMap[pairKey] || [{ subject: 'GENERAL', start: 1, end: 75, type: 'MCQ' }];
                const examName = examNameMap[pairKey] || "EXAMINATION OMR SHEET";
                
                const rawRoll = String(stu.rollNo || '').trim();
                const cleanRoll = rawRoll.replace(/\D/g, '') || '0000';
                const rollDigits = cleanRoll.split('');

                // DYNAMIC SECTION-BASED COLUMN CHUNKING
                let totalQs = structure.reduce((sum, sec) => sum + (sec.end - sec.start + 1), 0);

                let columnsHtml = "";
                structure.forEach(sec => {
                    let questions = [];
                    for (let q = sec.start; q <= sec.end; q++) questions.push(q);

                    // Dynamic column capacity: Allow 40 for huge tests, 25 for normal MCQ, 10 for Numerics to prevent vertical overflow
                    let MAX_PER_COL = 30; 
                    if (sec.type === 'MCQ') {
                        if (totalQs >= 150) {
                            MAX_PER_COL = 40; 
                        } else if (totalQs > 90) {
                            MAX_PER_COL = 30; 
                        } else {
                            MAX_PER_COL = 25; 
                        }
                    } else {
                        MAX_PER_COL = 10; 
                    }

                    for (let i = 0; i < questions.length; i += MAX_PER_COL) {
                        const chunk = questions.slice(i, i + MAX_PER_COL);
                        
                        columnsHtml += `<div style="flex:1; display:flex; flex-direction:column; min-width:0; justify-content:flex-start;">`;
                        
                        // Subject headers have been explicitly removed to ensure continuous uninterrupted flow
                        
                        chunk.forEach(q => {
                            if (sec.type === 'MCQ') {
                                let optsHtml = "";
                                for (let o = 1; o <= 4; o++) {
                                    optsHtml += `<div style="width:13px; height:13px; border-radius:50%; border:1px solid black; display:inline-flex; align-items:center; justify-content:center; font-size:5.5pt; font-weight:bold; color:black; background:white; margin:0 1px;">${o}</div>`;
                                }
                                columnsHtml += `<div style="display:flex; align-items:center; margin-bottom:5px;"><div style="width:18px; font-weight:bold; font-size:7.5pt; text-align:right; margin-right:4px; color:black;">${q}.</div><div style="display:flex;">${optsHtml}</div></div>`;
                            } else {
                                let numericGrid = `<div style="display:flex; gap:1.5px;">`;
                                for (let col = 0; col < 6; col++) {
                                    numericGrid += `<div style="display:flex; flex-direction:column; gap:0.5px; align-items:center;">`;
                                    numericGrid += `<div style="width:9px; height:9px; border:1px solid black; margin-bottom:1px; background:white;"></div>`; 
                                    for (let r = 0; r <= 9; r++) {
                                        numericGrid += `<div style="width:9px; height:9px; border-radius:50%; border:1px solid black; display:flex; align-items:center; justify-content:center; font-size:4.5pt; font-weight:bold; color:black; background:white; margin:0;">${r}</div>`;
                                    }
                                    numericGrid += `</div>`;
                                }
                                numericGrid += `</div>`;

                                columnsHtml += `
                                    <div style="display:flex; align-items:flex-start; margin-bottom:8px; break-inside:avoid;">
                                        <div style="width:18px; font-weight:bold; font-size:7.5pt; text-align:right; margin-right:4px; margin-top:8px; color:black;">${q}.</div>
                                        ${numericGrid}
                                    </div>
                                `;
                            }
                        });
                        columnsHtml += `</div>`;
                    }
                });

                fullPagesHtml += `
                    <div class="omr-print-page">
                        <div style="border:2px solid black; padding:8px; box-sizing:border-box; display:flex; flex-direction:column; background:white; width:100%; height:100%; font-family:Arial, sans-serif; justify-content:space-between;">
                            
                            <!-- TOP BLOCK: 3 Columns -> Left: Details, Center: Branding, Right: Roll Number -->
                            <div style="display:flex; justify-content:space-between; align-items:stretch; border-bottom:2px solid black; padding-bottom:4px; margin-bottom:12px; color:black; gap:8px;">
                                
                                <!-- Left: Candidate Details (Solid Unified Grid without gaps) -->
                                <div style="flex:1; display:flex; flex-direction:column; border:1.5px solid black; background:white; box-sizing:border-box;">
                                    <div style="font-weight:bold; font-size:8pt; padding:3px 4px; border-bottom:1.5px solid black;">${prettyDate}</div>
                                    
                                    <div style="padding:2px 4px; border-bottom:1.5px solid black;">
                                        <div style="font-size:6.5pt; font-weight:bold; text-transform:uppercase; color:#000;">Candidate Name</div>
                                        <div style="font-size:10pt; font-weight:900; text-transform:uppercase; color:black; line-height:1.2; min-height:14px;">${stu.name || ''}</div>
                                    </div>
                                    
                                    <div style="display:flex; border-bottom:1.5px solid black;">
                                        <div style="flex:1; border-right:1.5px solid black; padding:2px 4px;">
                                            <div style="font-size:6.5pt; font-weight:bold; text-transform:uppercase;">Class</div>
                                            <div style="font-size:8pt; font-weight:bold; min-height:12px;">${stu.className || ''}</div>
                                        </div>
                                        <div style="flex:1; padding:2px 4px;">
                                            <div style="font-size:6.5pt; font-weight:bold; text-transform:uppercase;">Section</div>
                                            <div style="font-size:8pt; font-weight:bold; min-height:12px;">${stu.section || ''}</div>
                                        </div>
                                    </div>
                                    
                                    <div style="display:flex; flex:1; min-height:28px;">
                                        <div style="flex:1; border-right:1.5px solid black; padding:2px 4px; display:flex; flex-direction:column;">
                                            <div style="font-size:6.5pt; font-weight:bold; text-transform:uppercase;">Student Sign</div>
                                        </div>
                                        <div style="flex:1; padding:2px 4px; display:flex; flex-direction:column;">
                                            <div style="font-size:6.5pt; font-weight:bold; text-transform:uppercase;">Invigilator Sign</div>
                                        </div>
                                    </div>
                                </div>
                                
                                <!-- Center: Barcode & Branding -->
                                <div style="flex:1.2; display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center;">
                                    <svg class="barcode-svg" jsbarcode-value="${cleanRoll}" jsbarcode-height="30" jsbarcode-width="1.8" jsbarcode-displayvalue="false" jsbarcode-margin="0" style="margin-bottom:4px;"></svg>
                                    <h1 style="font-size:16pt; font-weight:900; letter-spacing:1px; text-transform:uppercase; margin:0 0 4px 0; line-height:1; color:black;">MINERVA STUDY CIRCLE</h1>
                                    <div style="font-size:9pt; font-family:monospace; font-weight:bold; background:#eee; padding:2px 8px; border:1.5px solid black; text-transform:uppercase;">
                                        ${examName}
                                    </div>
                                </div>

                                <!-- Right: Roll Number Grid (Unmarked Bubbles) -->
                                <div style="border:1.5px solid black; padding:4px 6px; display:flex; flex-direction:column; align-items:center; background:white; flex-shrink:0;">
                                    <div style="font-size:7pt; font-weight:bold; text-transform:uppercase; margin-bottom:4px;">Roll Number</div>
                                    <div style="display:flex; gap:2px; justify-content:center;">
                                        ${rollDigits.map((digit) => `
                                            <div style="display:flex; flex-direction:column; gap:1.5px; align-items:center;">
                                                <div style="width:12px; height:12px; border:1px solid black; margin-bottom:2px; font-size:6pt; font-weight:900; display:flex; align-items:center; justify-content:center; background:#eee;">${digit}</div>
                                                ${[...Array(10)].map((_, r) => `
                                                    <div style="width:12px; height:12px; font-size:5pt; font-weight:bold; border:1px solid black; color:black; display:flex; align-items:center; justify-content:center; border-radius:50%;">${r}</div>
                                                `).join('')}
                                            </div>
                                        `).join('')}
                                    </div>
                                </div>
                            </div>

                            <!-- Questions Container -->
                            <div style="display:flex; flex-wrap:nowrap; gap:12px; width:100%; flex-grow:1; justify-content:space-between;">
                                ${columnsHtml}
                            </div>

                            <!-- Seat Number at Footer -->
                            <div style="border-top:1.5px solid black; padding-top:2px; margin-top:2px; display:flex; justify-content:center; align-items:center;">
                                <span style="font-family:monospace; background:black; color:white; padding:1px 12px; border-radius:3px; font-size:8pt; font-weight:900; letter-spacing:1px; text-transform:uppercase;">SEAT NUMBER: ${sId}</span>
                            </div>
                        </div>
                    </div>
                `;
            });

            const executablePath = await chromium.executablePath();
            const browser = await puppeteer.launch({
                args: chromium.args,
                defaultViewport: chromium.defaultViewport,
                executablePath: executablePath,
                headless: true,
            });
            const page = await browser.newPage();

            const fullHtml = `
                <!DOCTYPE html>
                <html>
                <head>
                    <script src="https://cdn.jsdelivr.net/npm/jsbarcode@3.11.5/dist/JsBarcode.all.min.js"></script>
                    <style>
                        @page { size: A4 portrait; margin: 6mm; }
                        body { background: white !important; margin: 0; padding: 0; font-family: Arial, sans-serif; }
                        .omr-print-page { width: 100%; height: 275mm; max-height: 275mm; page-break-after: always; page-break-inside: avoid; overflow: hidden; box-sizing: border-box; display: flex; flex-direction: column; justify-content: space-between; padding: 2px 6mm; background: white; }
                        .omr-print-page:last-child { page-break-after: avoid; }
                        .bubble-filled-black { background-color: black !important; color: transparent !important; border-color: black !important; }
                    </style>
                </head>
                <body>
                    ${fullPagesHtml}
                    <script>
                        JsBarcode(".barcode-svg").init();
                    </script>
                </body>
                </html>
            `;

            await page.setContent(fullHtml, { waitUntil: 'networkidle0' });
            const pdfBuffer = await page.pdf({ format: 'A4', printBackground: true });
            await browser.close();

            const filePrefix = seatId ? seatId : roomName;
            const storagePath = `print_packages/${center}/${date}/${filePrefix}_omr_package.pdf`;
            
            const fileRef = admin.storage().bucket().file(storagePath);
            await fileRef.save(Buffer.from(pdfBuffer), {
                metadata: { contentType: "application/pdf" },
            });

            const downloadToken = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2);
            await fileRef.setMetadata({
                metadata: {
                    firebaseStorageDownloadTokens: downloadToken
                }
            });

            const bucketName = admin.storage().bucket().name;
            const url = `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodeURIComponent(storagePath)}?alt=media&token=${downloadToken}`;

            res.status(200).send({ success: true, url });
            return;
        }

        const allocDoc = await admin.firestore().collection(`${prefix}exam_seating_allocations`).doc(`${center}_${date}`).get();
        if (!allocDoc.exists) {
            res.status(404).send({ error: "Seating allocations not found for this date." });
            return;
        }

        const allocations = allocDoc.data().allocations || {};
        
        let filteredAllocations = allocations;
        if (seatId && allocations[seatId]) {
            filteredAllocations = { [seatId]: allocations[seatId] };
        }
        
        const success = await compileSingleRoomPackage(center, date, roomName, filteredAllocations);
        
        if (!success) {
            res.status(400).send({ error: "Room has no students allocated or failed to compile." });
            return;
        }

        const filePrefix = seatId ? seatId : roomName;
        const storagePath = `print_packages/${center}/${date}/${filePrefix}_print_package.pdf`;
        const fileRef = admin.storage().bucket().file(storagePath);
        const downloadToken = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2);
        
        await fileRef.setMetadata({
            metadata: {
                firebaseStorageDownloadTokens: downloadToken
            }
        });

        const bucketName = admin.storage().bucket().name;
        const url = `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodeURIComponent(storagePath)}?alt=media&token=${downloadToken}`;

        res.status(200).send({ success: true, url });
    } catch (err) {
        console.error(`[On-Demand Error] ${roomName || seatId}:`, err);
        res.status(500).send({ error: err.message });
    }
});
