const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onDocumentCreated, onDocumentWritten } = require("firebase-functions/v2/firestore");
const admin = require("firebase-admin");
const { PDFDocument, rgb, StandardFonts, degrees } = require("pdf-lib");

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

    // Fallback standard fetch with retries
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
// --- BACKGROUND SEATING PLAN & PDF COMPILATION ENGINE ---
// =======================================================
async function processPrintPackages(center, date, allocations) {
    if (!allocations || Object.keys(allocations).length === 0) return;

    const norm = (str) => String(str || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

    let roomBuckets = {};
    Object.keys(allocations).forEach(seatId => {
        const roomName = seatId.split("-R")[0].toUpperCase();
        if (!roomBuckets[roomName]) roomBuckets[roomName] = [];
        roomBuckets[roomName].push({ seatId, student: allocations[seatId] });
    });

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

    for (const roomName of Object.keys(roomBuckets)) {
        const occupants = roomBuckets[roomName];
        occupants.sort((a, b) => a.seatId.localeCompare(b.seatId, undefined, { numeric: true }));

        const mergedPdf = await PDFDocument.create();
        const font = await mergedPdf.embedFont(StandardFonts.HelveticaBold);
        const availableSeries = ["SERIES A", "SERIES B", "SERIES C", "SERIES D"];

        for (let i = 0; i < occupants.length; i++) {
            const { seatId, student } = occupants[i];
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
                const pdfBytes = await loadPdfBytes(pdfUrl);
                const studentPdf = await PDFDocument.load(pdfBytes);

                const pages = studentPdf.getPages();
                
                // Apply diagonal background watermark across every page of the student's booklet
                for (const page of pages) {
                    const { width, height } = page.getSize();
                    page.drawText(`${student.name.toUpperCase()}  |  ROLL: #${student.rollNo || "—"}  |  SEAT: ${seatId}  |  SERIES: ${assignedSeries}`, {
                        x: width / 7,
                        y: height / 2.2,
                        size: 16,
                        font: font,
                        color: rgb(0.6, 0.6, 0.7),
                        opacity: 0.18,
                        rotate: degrees(45),
                    });
                }

                const copiedPages = await mergedPdf.copyPages(studentPdf, studentPdf.getPageIndices());
                copiedPages.forEach(p => mergedPdf.addPage(p));

                const currentPagesCount = copiedPages.length;
                const remainder = currentPagesCount % 4;
                if (remainder !== 0) {
                    const pagesNeeded = 4 - remainder;
                    for (let p = 0; p < pagesNeeded; p++) {
                        const blankPage = mergedPdf.addPage();
                        const { width, height } = blankPage.getSize();
                        blankPage.drawText(`${student.name.toUpperCase()}  |  ROLL: #${student.rollNo || "—"}  |  SEAT: ${seatId}  |  SERIES: ${assignedSeries} (BLANK PAGE)`, {
                            x: width / 7,
                            y: height / 2.2,
                            size: 14,
                            font: font,
                            color: rgb(0.7, 0.7, 0.8),
                            opacity: 0.15,
                            rotate: degrees(45),
                        });
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
            console.log(`[PDF Engine] Compiled print package for Room: ${roomName} (${date})`);
        }
    }
}

// Trigger for Ghumarwin Seating Allocations (2 GiB RAM & 540s timeout for 1200+ students)
exports.compileGhumarwinPrintPackages = onDocumentWritten({
    document: "exam_seating_allocations/{docId}",
    region: "asia-south1",
    memory: "2GiB",
    timeoutSeconds: 540
}, async (event) => {
    const data = event.data.after.exists ? event.data.after.data() : null;
    if (!data) return null;
    await processPrintPackages("GHUMARWIN", data.date, data.allocations);
    return null;
});

// Trigger for Dharamshala Seating Allocations (2 GiB RAM & 540s timeout)
exports.compileDharamshalaPrintPackages = onDocumentWritten({
    document: "dharamshala_exam_seating_allocations/{docId}",
    region: "asia-south1",
    memory: "2GiB",
    timeoutSeconds: 540
}, async (event) => {
    const data = event.data.after.exists ? event.data.after.data() : null;
    if (!data) return null;
    await processPrintPackages("DHARAMSHALA", data.date, data.allocations);
    return null;
});

// Explicit Trigger when Ghumarwin question papers are uploaded
exports.recompileGhumarwinOnPaperUpload = onDocumentCreated({
    document: "question_papers/{docId}",
    region: "asia-south1",
    memory: "2GiB",
    timeoutSeconds: 540
}, async (event) => {
    const qp = event.data.data();
    if (!qp || !qp.date) return null;

    const center = "GHUMARWIN";
    const allocDoc = await admin.firestore().collection("exam_seating_allocations").doc(`${center}_${qp.date}`).get();
    if (allocDoc.exists) {
        const allocData = allocDoc.data();
        await processPrintPackages(center, qp.date, allocData.allocations);
    }
    return null;
});

// Explicit Trigger when Dharamshala question papers are uploaded
exports.recompileDharamshalaOnPaperUpload = onDocumentCreated({
    document: "dharamshala_question_papers/{docId}",
    region: "asia-south1",
    memory: "2GiB",
    timeoutSeconds: 540
}, async (event) => {
    const qp = event.data.data();
    if (!qp || !qp.date) return null;

    const center = "DHARAMSHALA";
    const allocDoc = await admin.firestore().collection("dharamshala_exam_seating_allocations").doc(`${center}_${qp.date}`).get();
    if (allocDoc.exists) {
        const allocData = allocDoc.data();
        await processPrintPackages(center, qp.date, allocData.allocations);
    }
    return null;
});
