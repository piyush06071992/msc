const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { PDFDocument, rgb, StandardFonts } = require("pdf-lib");
const crypto = require("crypto");
const puppeteer = require("puppeteer");

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

// =======================================================
// --- INSTANT TIMETABLE UPDATE ALERTS ---
// =======================================================
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

// =======================================================
// --- ROBUST PDF LOADER (ADMIN SDK + FETCH FALLBACK) ---
// =======================================================
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
            console.warn("[PDF Engine] Admin SDK direct download failed, falling back to fetch:", e.message);
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

// =======================================================
// --- OPTIMIZED SINGLE ROOM COMPILATION ENGINE ---
// =======================================================
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
    const qpSnap = await admin.firestore().collection(`${prefix}question_papers`)
        .where("date", "==", date)
        .get();

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

        if (!pdfUrl) {
            console.log(`[PDF Engine] Skipping seat ${seatId}: No question paper found for section ${student.className} Sec ${student.section}`);
            continue; 
        }

        try {
            if (!pdfBytesCache[pdfUrl]) {
                pdfBytesCache[pdfUrl] = await loadPdfBytes(pdfUrl);
            }
            const pdfBytes = pdfBytesCache[pdfUrl];
            const studentPdf = await PDFDocument.load(pdfBytes);

            const pages = studentPdf.getPages();
            
            // Apply flanked bottom footer watermark details just below the border line (y = 6)
            for (let pIdx = 0; pIdx < pages.length; pIdx++) {
                const page = pages[pIdx];
                const { width } = page.getSize();
                
                const leftText = `MINERVA STUDY CIRCLE  |  ${student.name.toUpperCase()}  (ROLL: #${student.rollNo || "—"})`;
                const rightText = `SEAT: ${seatId}    |    SEC: ${student.section}    |    ${assignedSeries}`;

                const size = 8.5;
                const color = rgb(0.2, 0.2, 0.2);
                const opacity = 0.7;

                const y = 6; // Positioned lower, just below the bottom border line in the margin
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
        console.log(`[PDF Engine] Successfully compiled room batch: ${roomName} (${date})`);
        return true;
    }
    return false;
}

// =======================================================
// --- ON-DEMAND SINGLE ROOM COMPILATION ENDPOINT ---
// =======================================================
exports.compileSingleRoomOnDemand = onRequest({
    region: "asia-south1",
    memory: "1GiB",
    timeoutSeconds: 300,
    cors: true
}, async (req, res) => {
    const { center, date, roomName, type } = req.body;
    if (!center || !date || !roomName) {
        res.status(400).send({ error: "Missing required parameters: center, date, roomName" });
        return;
    }

    try {
        const prefix = center === "DHARAMSHALA" ? "dharamshala_" : "";

        // If type is 'omr', handle server-side Puppeteer pre-filled OMR generation
        if (type === 'omr') {
            const allocDoc = await admin.firestore().collection(`${prefix}exam_seating_allocations`).doc(`${center}_${date}`).get();
            if (!allocDoc.exists) {
                res.status(404).send({ error: "Seating allocations not found for this date." });
                return;
            }

            const allocations = allocDoc.data().allocations || {};
            let occupiedSeats = [];
            Object.keys(allocations).forEach(seatId => {
                if (seatId.startsWith(`${roomName}-`)) {
                    const stu = allocations[seatId];
                    if (stu) occupiedSeats.push({ seatId, stu });
                }
            });

            if (occupiedSeats.length === 0) {
                res.status(404).send({ error: `No students allocated in room ${roomName}.` });
                return;
            }

            occupiedSeats.sort((a, b) => a.seatId.localeCompare(b.seatId, undefined, { numeric: true }));

            // Fetch structures for unique section pairs
            let uniquePairs = new Set();
            occupiedSeats.forEach(item => uniquePairs.add(`${item.stu.className}|${item.stu.section}`));

            let structureMap = {};
            for (const pair of uniquePairs) {
                const [className, sectionName] = pair.split('|');
                const groupSnap = await admin.firestore().collection("admin_paper_groups").where("date", "==", date).get();
                let targetGroupId = null;
                let fallbackSubjects = [];

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
                    }
                });

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
            const normSec = (str) => (str || "").replace(/\s+/g, " ").trim().toUpperCase();

            occupiedSeats.forEach(({ seatId, stu }) => {
                const pairKey = `${stu.className}|${stu.section}`;
                const structure = structureMap[pairKey] || [{ subject: 'GENERAL', start: 1, end: 75, type: 'MCQ' }];
                
                const rawRoll = String(stu.rollNo || '').trim();
                const cleanRoll = rawRoll.replace(/\D/g, '') || '0000';
                const rollDigits = cleanRoll.split('');

                let totalQs = structure.reduce((sum, sec) => sum + (sec.end - sec.start + 1), 0);
                let numCols = totalQs > 135 ? 5 : (totalQs > 90 ? 4 : 3);
                const MAX_PER_COL = Math.ceil(totalQs / numCols);

                let columnsHtml = "";
                structure.forEach(sec => {
                    let questions = [];
                    for (let q = sec.start; q <= sec.end; q++) questions.push(q);

                    for (let i = 0; i < questions.length; i += MAX_PER_COL) {
                        const chunk = questions.slice(i, i + MAX_PER_COL);
                        columnsHtml += `<div style="flex:1; display:flex; flex-direction:column; min-width:0;">`;
                        columnsHtml += `<div style="font-weight:900; font-size:8pt; text-transform:uppercase; border-bottom:1.5px solid black; margin:0 0 2px 0; text-align:center; background:#f8f8f8; padding:2px; color:black;">${sec.subject}</div>`;
                        
                        chunk.forEach(q => {
                            if (sec.type === 'MCQ') {
                                let optsHtml = "";
                                for (let o = 1; o <= 4; o++) {
                                    optsHtml += `<div style="width:12px; height:12px; border-radius:50%; border:1px solid black; display:inline-flex; align-items:center; justify-content:center; font-size:5pt; font-weight:bold; color:black; background:white; margin:0 1px;">${o}</div>`;
                                }
                                columnsHtml += `<div style="display:flex; align-items:center; margin-bottom:1px;"><div style="width:18px; font-weight:bold; font-size:7pt; text-align:right; margin-right:3px; color:black;">${q}.</div><div style="display:flex;">${optsHtml}</div></div>`;
                            } else {
                                columnsHtml += `<div style="display:flex; align-items:center; margin-bottom:1px;"><div style="width:18px; font-weight:bold; font-size:7pt; text-align:right; margin-right:3px; color:black;">${q}.</div><div style="display:inline-block; width:40px; height:13px; border:1px solid black;"></div></div>`;
                            }
                        });
                        columnsHtml += `</div>`;
                    }
                });

                fullPagesHtml += `
                    <div class="omr-print-page">
                        <div style="border:2px solid black; padding:6px 10px; box-sizing:border-box; display:flex; flex-direction:column; background:white; width:100%; height:100%; font-family:Arial, sans-serif; justify-content:space-between;">
                            <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:2px solid black; padding-bottom:4px; margin-bottom:4px; color:black;">
                                <div style="font-weight:bold; font-size:8.5pt; width:100px; text-align:left;">${prettyDate}</div>
                                <div style="flex:1; display:flex; flex-direction:column; align-items:center; text-align:center;">
                                    <div style="border:1.5px dashed #888; width:120px; height:20px; display:flex; align-items:center; justify-content:center; font-size:7pt; color:#888; font-weight:bold; background:#fafafa; margin-bottom:2px;">BARCODE AREA</div>
                                    <h1 style="font-size:16pt; font-weight:900; letter-spacing:1px; text-transform:uppercase; margin:0 0 2px 0; line-height:1; color:black;">MINERVA STUDY CIRCLE</h1>
                                    <div style="font-size:8.5pt; font-family:monospace; font-weight:bold; background:#eee; padding:1px 6px; border:1.5px solid black; text-transform:uppercase;">EXAMINATION OMR SHEET</div>
                                </div>
                                <div style="font-weight:bold; font-size:9pt; width:100px; text-align:right; font-family:monospace; color:#0d9488;">SEC: ${stu.section || ''}</div>
                            </div>
                            <div style="display:flex; gap:10px; border-bottom:2px solid black; padding-bottom:6px; margin-bottom:6px; color:black; align-items:stretch;">
                                <div style="flex:1; display:grid; grid-template-columns:1fr 1fr; gap:4px; align-content:start;">
                                    <div style="grid-column:span 2; border:1.5px solid black; padding:4px 6px; min-height:32px; display:flex; flex-direction:column; justify-content:space-between; background:white;">
                                        <div style="font-size:7pt; font-weight:bold; text-transform:uppercase; color:#000;">Candidate Name</div>
                                        <div style="font-size:10.5pt; font-weight:900; text-transform:uppercase; color:black; letter-spacing:0.5px;">${stu.name || ''}</div>
                                    </div>
                                    <div style="border:1.5px solid black; padding:4px 6px; background:white; min-height:30px;"><div style="font-size:7pt; font-weight:bold; text-transform:uppercase;">Class</div><div style="font-size:9pt; font-weight:bold;">${stu.className || ''}</div></div>
                                    <div style="border:1.5px solid black; padding:4px 6px; background:white; min-height:30px;"><div style="font-size:7pt; font-weight:bold; text-transform:uppercase;">Section</div><div style="font-size:9pt; font-weight:bold;">${stu.section || ''}</div></div>
                                    <div style="border:1.5px solid black; padding:4px 6px; min-height:28px; background:white;"><div style="font-size:7pt; font-weight:bold; text-transform:uppercase;">Student Sign</div></div>
                                    <div style="border:1.5px solid black; padding:4px 6px; min-height:28px; background:white;"><div style="font-size:7pt; font-weight:bold; text-transform:uppercase;">Invigilator Sign</div></div>
                                </div>
                                <div style="border:1.5px solid black; padding:4px 8px; display:flex; flex-direction:column; align-items:center; background:white;">
                                    <div style="font-size:7.5pt; font-weight:bold; text-transform:uppercase; margin-bottom:3px;">Roll Number</div>
                                    <div style="display:flex; gap:4px; justify-content:center;">
                                        ${rollDigits.map((digit) => `
                                            <div style="display:flex; flex-direction:column; gap:2px; align-items:center;">
                                                <div style="width:13px; height:13px; border:1.5px solid black; margin-bottom:1px; font-size:7.5pt; font-weight:900; display:flex; align-items:center; justify-content:center; background:#eee;">${digit}</div>
                                                ${[...Array(10)].map((_, r) => `
                                                    <div class="${String(r) === String(digit) ? 'bubble-filled-black' : ''}" style="width:12px; height:12px; border-radius:50%; border:1px solid black; display:flex; align-items:center; justify-content:center; font-size:5.5pt; font-weight:bold;">${r}</div>
                                                `).join('')}
                                            </div>
                                        `).join('')}
                                    </div>
                                </div>
                            </div>
                            <div style="display:flex; flex-wrap:nowrap; gap:8px; width:100%; flex-grow:1; justify-content:space-between;">
                                ${columnsHtml}
                            </div>
                            <div style="border-top:1.5px solid black; padding-top:3px; margin-top:4px; display:flex; justify-content:center; align-items:center;">
                                <span style="font-family:monospace; background:black; color:white; padding:2px 12px; border-radius:3px; font-size:9pt; font-weight:900; letter-spacing:1px; text-transform:uppercase;">SEAT NUMBER: ${seatId}</span>
                            </div>
                        </div>
                    </div>
                `;
            });

            const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
            const page = await browser.newPage();

            const fullHtml = `
                <!DOCTYPE html>
                <html>
                <head>
                    <style>
                        @page { size: A4 portrait; margin: 6mm; }
                        body { background: white !important; margin: 0; padding: 0; font-family: Arial, sans-serif; }
                        .omr-print-page { width: 100%; height: 275mm; max-height: 275mm; page-break-after: always; page-break-inside: avoid; overflow: hidden; box-sizing: border-box; display: flex; flex-direction: column; justify-content: space-between; padding: 2px 6mm; background: white; }
                        .omr-print-page:last-child { page-break-after: avoid; }
                        .bubble-filled-black { background-color: black !important; color: white !important; border-color: black !important; }
                    </style>
                </head>
                <body>${fullPagesHtml}</body>
                </html>
            `;

            await page.setContent(fullHtml, { waitUntil: 'networkidle0' });
            const pdfBuffer = await page.pdf({ format: 'A4', printBackground: true });
            await browser.close();

            const storagePath = `print_packages/${center}/${date}/${roomName}_omr_package.pdf`;
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

        // Default behavior: Question paper package
        const allocDoc = await admin.firestore().collection(`${prefix}exam_seating_allocations`).doc(`${center}_${date}`).get();
        
        if (!allocDoc.exists) {
            res.status(404).send({ error: "Seating allocations not found for this date." });
            return;
        }

        const allocations = allocDoc.data().allocations || {};
        
        const success = await compileSingleRoomPackage(center, date, roomName, allocations);
        
        if (!success) {
            res.status(400).send({ error: "Room has no students allocated or failed to compile." });
            return;
        }

        const storagePath = `print_packages/${center}/${date}/${roomName}_print_package.pdf`;
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
        console.error(`[On-Demand Error] ${roomName}:`, err);
        res.status(500).send({ error: err.message });
    }
});
