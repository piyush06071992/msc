const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { PDFDocument, rgb, StandardFonts } = require("pdf-lib");
const crypto = require("crypto");

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

         let targetTokens = [];

            if (staffSnap && !staffSnap.empty) {
                staffSnap.forEach(staffDoc => {
                    const staffData = staffDoc.data();
                    const nameKey = Object.keys(staffData.details || {}).find(k => k.toLowerCase().includes('name'));
                    const staffFullName = nameKey ? staffData.details[nameKey] : (staffData.name || "");
                    
                    if (
                        (notif.teacherEmail && staffData.email === notif.teacherEmail) ||
                        (notif.teacherName && staffFullName.toLowerCase() === notif.teacherName.toLowerCase())
                    ) {
                        if (staffData.fcmTokens && Array.isArray(staffData.fcmTokens)) {
                            staffData.fcmTokens.forEach(t => { if (!targetTokens.includes(t)) targetTokens.push(t); });
                        } else if (staffData.fcmToken && !targetTokens.includes(staffData.fcmToken)) {
                            targetTokens.push(staffData.fcmToken);
                        }
                    }
                });
            }

            if (targetTokens.length > 0) {
                const message = {
                    tokens: targetTokens,
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
                await admin.messaging().sendEachForMulticast(message);
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

staffSnap.forEach(doc => {
            const staffData = doc.data();
            const nameKey = Object.keys(staffData.details || {}).find(k => k.toLowerCase().includes('name'));
            const staffFullName = nameKey ? staffData.details[nameKey] : (staffData.name || "");
            
            if (
                (t.email && staffData.email === t.email) ||
                (t.name && staffFullName.toLowerCase() === t.name.toLowerCase())
            ) {
                if (staffData.fcmTokens && Array.isArray(staffData.fcmTokens)) {
                    staffData.fcmTokens.forEach(token => {
                        if (!tokens.includes(token)) tokens.push(token);
                    });
                } else if (staffData.fcmToken && !tokens.includes(staffData.fcmToken)) {
                    tokens.push(staffData.fcmToken);
                }
            }
        });
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
// --- PDF & HTML GENERATOR UTILITIES ---
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

async function compileSingleRoomPackage(center, date, roomName, allocations, docType = 'qp') {
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
    
    let permanentOmrs = {};
    if (docType === 'omr') {
        const omrSnap = await admin.firestore().collection(`${prefix}section_omr_templates`).get();
        omrSnap.forEach(doc => {
            const data = doc.data();
            if (data.className && data.section && data.url) {
                const secKey = `${norm(data.className)}${norm(data.section)}`;
                permanentOmrs[secKey] = data.url;
            }
        });
    }

   const qpSnap = await admin.firestore().collection(`${prefix}question_papers`).where("date", "==", date).get();

    let papersBySection = {}; 
    let layoutBySection = {};

    qpSnap.forEach(doc => {
        const qp = doc.data();
        if (!qp.className || !qp.section) return;

        const secKey = `${norm(qp.className)}${norm(qp.section)}`;
        const subKey = norm(qp.subject || "FULL PAPER");

        if (!papersBySection[secKey]) papersBySection[secKey] = {};
        if (!papersBySection[secKey][subKey]) papersBySection[secKey][subKey] = {};
        
        if (qp.layout) {
            if (!layoutBySection[secKey]) layoutBySection[secKey] = {};
            layoutBySection[secKey][subKey] = qp.layout;
        }

        const series = qp.series ? qp.series.toUpperCase() : "SERIES A";
        papersBySection[secKey][subKey][series] = {
            qp: qp.url,
            omr: permanentOmrs[secKey] || qp.omrUrl
        };
    });

    if (docType === 'omr') {
        Object.keys(permanentOmrs).forEach(secKey => {
            if (!papersBySection[secKey]) papersBySection[secKey] = { "FULL PAPER": {} };
            Object.keys(papersBySection[secKey]).forEach(subKey => {
                if (!papersBySection[secKey][subKey]["SERIES A"]) {
                    papersBySection[secKey][subKey]["SERIES A"] = { omr: permanentOmrs[secKey] };
                }
            });
        });
    }

    const mergedPdf = await PDFDocument.create();
    const font = await mergedPdf.embedFont(StandardFonts.HelveticaBold);
    const availableSeries = ["SERIES A", "SERIES B", "SERIES C", "SERIES D"];

    let pdfBytesCache = {};

    // PASS 1: Generate Checkerboard Series, Map Optional Subjects, and Buffer A4 Half-Splits 
    let pagesToRender = [];
    let splitBuffers = {}; 

    for (let i = 0; i < roomOccupants.length; i++) {
        const { seatId, student } = roomOccupants[i];
        if (!student || !student.className || !student.section) continue;

        const secKey = `${norm(student.className)}${norm(student.section)}`;
        const studentOpt = norm(student.optionalSubject || "");
        
        const availableSubjects = papersBySection[secKey] ? Object.keys(papersBySection[secKey]) : [];
        let matchedSubKey = null;

      // Database-Driven Optional Subject Matching (Mirrors Frontend)
        if (availableSubjects.length === 1) {
            matchedSubKey = availableSubjects[0];
        } else if (availableSubjects.length > 1) {
            if (studentOpt) {
                matchedSubKey = availableSubjects.find(sub => {
                    const subNorm = String(sub).toUpperCase().trim();
                    return subNorm === studentOpt || subNorm.includes(studentOpt) || studentOpt.includes(subNorm);
                });
            }
            if (!matchedSubKey) {
                matchedSubKey = availableSubjects.find(sub => sub === "FULL PAPER" || sub === "UNMAPPED EXAM") || availableSubjects[0];
            }
        }

        const sectionPapers = matchedSubKey ? papersBySection[secKey][matchedSubKey] : {};
        const roomSeriesList = Object.keys(sectionPapers).length > 0 ? Object.keys(sectionPapers).sort() : availableSeries;
        
        // Dynamic 2D Checkerboard Logic (Alternating Left/Right & Front/Back)
        const rMatch = seatId.match(/-R(\d+)-S(\d+)/);
        const rNum = rMatch ? parseInt(rMatch[1]) : 0;
        const sNum = rMatch ? parseInt(rMatch[2]) : 0;
        
        const sIndex = (rNum + sNum) % roomSeriesList.length;
        const assignedSeries = roomSeriesList[sIndex];
        
        const paperLinks = sectionPapers[assignedSeries] || Object.values(sectionPapers)[0] || {};
        const pdfUrl = docType === 'omr' ? paperLinks.omr : paperLinks.qp;
        const layout = layoutBySection[secKey] || 'A4_STANDARD';

        if (!pdfUrl) continue; 
        
        const item = { seatId, student, assignedSeries, pdfUrl, layout, secKey };

        if (layout === 'A4_HALF_SPLIT' && docType !== 'omr') {
            const availableForThisSec = Object.keys(sectionPapers).sort();
            let seriesIdx = availableForThisSec.indexOf(assignedSeries);
            if (seriesIdx === -1) seriesIdx = 0;
            const isTop = (seriesIdx % 2 === 0);
            
            if (!splitBuffers[pdfUrl]) splitBuffers[pdfUrl] = { top: null, bottom: null };
            
            if (isTop) {
                if (splitBuffers[pdfUrl].top) {
                    pagesToRender.push({ type: 'split', pdfUrl, layout, ...splitBuffers[pdfUrl] });
                    splitBuffers[pdfUrl] = { top: null, bottom: null };
                }
                splitBuffers[pdfUrl].top = item;
            } else {
                if (splitBuffers[pdfUrl].bottom) {
                    pagesToRender.push({ type: 'split', pdfUrl, layout, ...splitBuffers[pdfUrl] });
                    splitBuffers[pdfUrl] = { top: null, bottom: null };
                }
                splitBuffers[pdfUrl].bottom = item;
            }
            
            if (splitBuffers[pdfUrl].top && splitBuffers[pdfUrl].bottom) {
                pagesToRender.push({ type: 'split', pdfUrl, layout, ...splitBuffers[pdfUrl] });
                splitBuffers[pdfUrl] = { top: null, bottom: null };
            }
        } else {
            pagesToRender.push({ type: 'standard', pdfUrl, layout, stuItem: item });
        }
    }

    // Flush remaining half-empty buffers
    Object.keys(splitBuffers).forEach(url => {
        const buf = splitBuffers[url];
        if (buf.top || buf.bottom) {
            const layoutItem = buf.top ? buf.top.layout : (buf.bottom ? buf.bottom.layout : 'A4_HALF_SPLIT');
            pagesToRender.push({ type: 'split', pdfUrl: url, layout: layoutItem, ...buf });
        }
    });

    // PASS 2: Stamping and Final Padding
    for (const pageTask of pagesToRender) {
        try {
            if (!pdfBytesCache[pageTask.pdfUrl]) {
                pdfBytesCache[pageTask.pdfUrl] = await loadPdfBytes(pageTask.pdfUrl);
            }
            const pdfBytes = pdfBytesCache[pageTask.pdfUrl];
            const studentPdf = await PDFDocument.load(pdfBytes);
            const pages = studentPdf.getPages();
            
            for (let pIdx = 0; pIdx < pages.length; pIdx++) {
                const page = pages[pIdx];
                const { width, height } = page.getSize();
                const size = 8.5;
                const color = rgb(0.2, 0.2, 0.2);
                const opacity = 0.8;

               if (pageTask.type === 'split') {
                    if (pageTask.top) {
                        const tStu = pageTask.top.student;
                        const tSub = (pageTask.top.matchedSubKey && pageTask.top.matchedSubKey !== "FULL PAPER") ? `[${pageTask.top.matchedSubKey.substring(0,8)}] ` : "";
                        const leftText = `MINERVA STUDY CIRCLE  |  ${tStu.name.toUpperCase()}  (ROLL: #${tStu.rollNo || "—"})`;
                        const rightText = `SEAT: ${pageTask.top.seatId}    |    SEC: ${tStu.section}    |    ${tSub}${pageTask.top.assignedSeries}`;
                        const yTop = height - 15;
                        page.drawText(leftText, { x: 36, y: yTop, size, font, color, opacity });
                        page.drawText(rightText, { x: width - font.widthOfTextAtSize(rightText, size) - 36, y: yTop, size, font, color, opacity });
                    }
                    if (pageTask.bottom) {
                        const bStu = pageTask.bottom.student;
                        const bSub = (pageTask.bottom.matchedSubKey && pageTask.bottom.matchedSubKey !== "FULL PAPER") ? `[${pageTask.bottom.matchedSubKey.substring(0,8)}] ` : "";
                        const leftText = `MINERVA STUDY CIRCLE  |  ${bStu.name.toUpperCase()}  (ROLL: #${bStu.rollNo || "—"})`;
                        const rightText = `SEAT: ${pageTask.bottom.seatId}    |    SEC: ${bStu.section}    |    ${bSub}${pageTask.bottom.assignedSeries}`;
                        const yBottom = (height / 2) - 15;
                        page.drawText(leftText, { x: 36, y: yBottom, size, font, color, opacity });
                        page.drawText(rightText, { x: width - font.widthOfTextAtSize(rightText, size) - 36, y: yBottom, size, font, color, opacity });
                    }
                } else {
                    const stu = pageTask.stuItem.student;
                    const subLabel = (pageTask.stuItem.matchedSubKey && pageTask.stuItem.matchedSubKey !== "FULL PAPER") ? `[${pageTask.stuItem.matchedSubKey.substring(0,8)}] ` : "";
                    const leftText = `MINERVA STUDY CIRCLE  |  ${stu.name.toUpperCase()}  (ROLL: #${stu.rollNo || "—"})`;
                    const rightText = `SEAT: ${pageTask.stuItem.seatId}    |    SEC: ${stu.section}    |    ${subLabel}${pageTask.stuItem.assignedSeries}`;
                    const y = height - 15;
                    page.drawText(leftText, { x: 36, y, size, font, color, opacity });
                    page.drawText(rightText, { x: width - font.widthOfTextAtSize(rightText, size) - 36, y, size, font, color, opacity });
                }
            }

            const copiedPages = await mergedPdf.copyPages(studentPdf, studentPdf.getPageIndices());
            copiedPages.forEach(p => mergedPdf.addPage(p));

            if (docType !== 'omr') {
                const currentPagesCount = copiedPages.length;
                if (pageTask.layout === 'A3_BOOKLET') {
                    const remainder = currentPagesCount % 4;
                    if (remainder !== 0) {
                        for (let p = 0; p < (4 - remainder); p++) mergedPdf.addPage();
                    }
                } else {
                    const remainder = currentPagesCount % 2;
                    if (remainder !== 0) mergedPdf.addPage();
                }
            }
        } catch (err) {
            console.error(`[PDF Engine] Error processing task for ${pageTask.pdfUrl}:`, err);
        }
    }

    if (mergedPdf.getPageCount() > 0) {
        const mergedPdfBytes = await mergedPdf.save();
        return mergedPdfBytes;
    }
    return null;
}
exports.compileSingleRoomOnDemand = onRequest({
    region: "asia-south1",
    memory: "1GiB", // Memory drastically reduced since headless chrome is removed
    timeoutSeconds: 300,
    cors: true
}, async (req, res) => {
    const { center, date, roomName, type, seatId } = req.body;
    if (!center || !date || !roomName) {
        res.status(400).send({ error: "Missing required parameters: center, date, roomName" });
        return;
    }

    try {
        // Build the safe document ID exactly as the frontend creates it
        const safeRoomName = roomName.replace(/[^a-zA-Z0-9]/g, '_');
        const docId = `${center}_${date}_${safeRoomName}`;

        const allocDoc = await admin.firestore().collection(`exam_seating_rooms`).doc(docId).get();
        
        if (!allocDoc.exists) {
            res.status(404).send({ error: `Seating allocations not found for room: ${roomName} on ${date}.` });
            return;
        }

        const allocations = allocDoc.data().allocations || {};
        
        let filteredAllocations = allocations;
        if (seatId && allocations[seatId]) {
            filteredAllocations = { [seatId]: allocations[seatId] };
        }

        const docType = type === 'omr' ? 'omr' : 'qp';
        
        const mergedPdfBytes = await compileSingleRoomPackage(center, date, roomName, filteredAllocations, docType);
        
        if (!mergedPdfBytes) {
            res.status(400).send({ error: `Room has no students allocated, or the requested PDF (${docType.toUpperCase()}) was not uploaded for these sections.` });
            return;
        }

        const filePrefix = seatId ? seatId : roomName;
        const suffix = docType === 'omr' ? '_omr_package.pdf' : '_print_package.pdf';
        const storagePath = `print_packages/${center}/${date}/${filePrefix}${suffix}`;
        
        const fileRef = admin.storage().bucket().file(storagePath);
        await fileRef.save(Buffer.from(mergedPdfBytes), {
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
    } catch (err) {
        console.error(`[On-Demand Error] ${roomName || seatId}:`, err);
        res.status(500).send({ error: err.message });
    }
});
