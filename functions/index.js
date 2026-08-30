const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { PDFDocument, rgb, StandardFonts } = require("pdf-lib");

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
            
        // Apply flanked bottom footer watermark details safely in the bottom margin (y = 16)
            for (let pIdx = 0; pIdx < pages.length; pIdx++) {
                const page = pages[pIdx];
                const { width } = page.getSize();
                
                const leftText = `MINERVA STUDY CIRCLE  |  ${student.name.toUpperCase()}  (ROLL: #${student.rollNo || "—"})`;
                const rightText = `SEAT: ${seatId}   |   SEC: ${student.section}   |   ${assignedSeries}`;

                const size = 8.5;
                const color = rgb(0.2, 0.2, 0.2);
                const opacity = 0.7;

                const y = 16; // Lowered from 32 to 16 to sit cleanly below the question content
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
// --- SERVER-SIDE BLAZING-FAST FULLY PARALLEL ORCHESTRATOR ---
// =======================================================
// =======================================================
// --- ON-DEMAND SINGLE ROOM COMPILATION ENDPOINT ---
// =======================================================
// =======================================================
// --- ON-DEMAND SINGLE ROOM COMPILATION ENDPOINT ---
// =======================================================
exports.compileSingleRoomOnDemand = onRequest({
    region: "asia-south1",
    memory: "1GiB",
    timeoutSeconds: 300,
    cors: true
}, async (req, res) => {
    const { center, date, roomName } = req.body;
    if (!center || !date || !roomName) {
        res.status(400).send({ error: "Missing required parameters: center, date, roomName" });
        return;
    }

    try {
        const prefix = center === "DHARAMSHALA" ? "dharamshala_" : "";
        const allocDoc = await admin.firestore().collection(`${prefix}exam_seating_allocations`).doc(`${center}_${date}`).get();
        
        if (!allocDoc.exists) {
            res.status(404).send({ error: "Seating allocations not found for this date." });
            return;
        }

        const allocations = allocDoc.data().allocations || {};
        
        // Compile just this one room using our optimized engine with byte caching
        const success = await compileSingleRoomPackage(center, date, roomName, allocations);
        
        if (!success) {
            res.status(400).send({ error: "Room has no students allocated or failed to compile." });
            return;
        }

        // Generate a secure token and save it to file metadata to bypass SignBlob IAM restrictions
        const storagePath = `print_packages/${center}/${date}/${roomName}_print_package.pdf`;
        const fileRef = admin.storage().bucket().file(storagePath);
        
        const downloadToken = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2);
        
        // Update file metadata with the token so Firebase recognizes it as public-downloadable
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
