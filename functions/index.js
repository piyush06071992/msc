const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { PDFDocument, rgb, StandardFonts } = require("pdf-lib");
const crypto = require("crypto");

if (!admin.apps.length) {
    admin.initializeApp();
}

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

    let seatSpecificTasks = [];
    let bulkSplitCounts = {}; 
    let subjectCounters = {};

    // PASS 1: Map Subjects and Build Processing Tasks
    for (let i = 0; i < roomOccupants.length; i++) {
        const { seatId, student } = roomOccupants[i];
        if (!student || !student.className || !student.section) continue;

        const secKey = `${norm(student.className)}${norm(student.section)}`;
        const studentOpt = norm(student.optionalSubject || "");
        
        const availableSubjects = papersBySection[secKey] ? Object.keys(papersBySection[secKey]) : [];
        let matchedSubKey = null;

        // Pure Database-Driven Optional Subject Matching
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
        let roomSeriesList = Object.keys(sectionPapers).length > 0 ? Object.keys(sectionPapers).sort() : availableSeries;
        
        // FIX: Force OMRs to always remain standard A4, regardless of the Question Paper layout
        const layout = docType === 'omr' ? 'A4_STANDARD' : ((layoutBySection[secKey] && layoutBySection[secKey][matchedSubKey]) ? layoutBySection[secKey][matchedSubKey] : 'A4_STANDARD');
        
        const basePaperLinks = sectionPapers["SERIES A"] || Object.values(sectionPapers)[0] || {};
        const basePdfUrl = docType === 'omr' ? basePaperLinks.omr : basePaperLinks.qp;
        if (!basePdfUrl) continue; 

        if (layout === 'A4_HALF_SPLIT' && docType !== 'omr') {
            // BULK COUNTING MODE FOR SPLIT PDFS (No personalized seats)
            const bufferKey = basePdfUrl;
            if (!bulkSplitCounts[bufferKey]) {
                bulkSplitCounts[bufferKey] = { pdfUrl: basePdfUrl, layout, count: 0, matchedSubKey };
            }
            bulkSplitCounts[bufferKey].count++;

       } else {
            // SEAT SPECIFIC MODE (Standard, Booklet, and all OMRs)
            // Track by basePdfUrl so combined sections sharing the same paper alternate series correctly
            const trackerKey = basePdfUrl;
            if (subjectCounters[trackerKey] === undefined) {
                subjectCounters[trackerKey] = 0;
            }
            
            const sIndex = subjectCounters[trackerKey];
            const assignedSeries = roomSeriesList[sIndex % roomSeriesList.length];
            subjectCounters[trackerKey]++;
            
            const paperLinks = sectionPapers[assignedSeries] || sectionPapers["SERIES A"] || Object.values(sectionPapers)[0] || {};
            const pdfUrl = docType === 'omr' ? paperLinks.omr : paperLinks.qp;

            if (!pdfUrl) continue; 
            
            seatSpecificTasks.push({ seatId, student, assignedSeries, pdfUrl, layout, matchedSubKey });
        }
    }

 // PASS 2: Render Bulk Split Tasks First
    for (const key in bulkSplitCounts) {
        const bulkData = bulkSplitCounts[key];
        const copiesNeeded = Math.ceil(bulkData.count / 2); // 1 copy = 2 halves = 2 students
        
        try {
            if (!pdfBytesCache[bulkData.pdfUrl]) {
                pdfBytesCache[bulkData.pdfUrl] = await loadPdfBytes(bulkData.pdfUrl);
            }
            const originalBytes = pdfBytesCache[bulkData.pdfUrl];
            const pdfDoc = await PDFDocument.load(originalBytes);
            
            for (let c = 0; c < copiesNeeded; c++) {
                const copiedPages = await mergedPdf.copyPages(pdfDoc, pdfDoc.getPageIndices());
                
                copiedPages.forEach(p => {
                    const page = mergedPdf.addPage(p);
                    const { width, height } = page.getSize();
                    const size = 9;
                    const color = rgb(0.2, 0.2, 0.2);
                    const opacity = 0.9;
                    
                    const subLabel = (bulkData.matchedSubKey && bulkData.matchedSubKey !== "FULL PAPER" && bulkData.matchedSubKey !== "UNMAPPED EXAM") ? `[${bulkData.matchedSubKey}] ` : "";
                    const leftText = `ROOM: ${roomName}`;
                    const rightText = `${subLabel}COPY ${c+1}/${copiesNeeded}`;
                    
             const topY = height - 25;
                    const bottomY = 12; 

                    // Shifted Y to 12 for the footer to print strictly below the black OMR corner dots
                    page.drawText(leftText, { x: 45, y: topY, size, font, color, opacity });
                    page.drawText(rightText, { x: width - font.widthOfTextAtSize(rightText, size) - 45, y: topY, size, font, color, opacity });
                    
                    page.drawText(leftText, { x: 45, y: bottomY, size, font, color, opacity });
                    page.drawText(rightText, { x: width - font.widthOfTextAtSize(rightText, size) - 45, y: bottomY, size, font, color, opacity });
                });
            }
        } catch (err) {
            console.error(`[PDF Engine] Error processing bulk task for ${bulkData.pdfUrl}:`, err);
        }
    }

// PASS 3: Render Seat Specific Tasks
    for (const task of seatSpecificTasks) {
        try {
            if (!pdfBytesCache[task.pdfUrl]) {
                pdfBytesCache[task.pdfUrl] = await loadPdfBytes(task.pdfUrl);
            }
            const originalBytes = pdfBytesCache[task.pdfUrl];
            const pdfDoc = await PDFDocument.load(originalBytes);
            
            const copiedPages = await mergedPdf.copyPages(pdfDoc, pdfDoc.getPageIndices());
            
            copiedPages.forEach((page, pageIdx) => {
                mergedPdf.addPage(page);
                
                const { width, height } = page.getSize();
                const size = 9;
                const color = rgb(0.2, 0.2, 0.2);
                const opacity = 0.9;
                const { degrees } = require("pdf-lib");

                const stu = task.student;
                
                // Formatted exactly to your new requirements
                const topLeftText = `SEAT: ${task.seatId}`;
                const topRightText = `ROLL: ${stu.rollNo || "—"}`;
                const bottomLeftText = `${stu.name.toUpperCase()}`;
                const bottomRightText = `CLASS ${stu.className} - SEC ${stu.section}`;
                
            // Shifted Y to 12 for the footer to print strictly below the black OMR corner dots
                const topY = height - 25;
                const bottomY = 12; 

                if (task.layout === 'A3_BOOKLET' || task.layout === 'A5_BOOKLET') {
                    const halfWidth = width / 2;
                    
                    if (pageIdx % 2 === 0) {
                        // FRONT PAGE (Upright)
                        // -- LEFT PAGE STAMPS --
                        page.drawText(topLeftText, { x: 45, y: topY, size, font, color, opacity });
                        page.drawText(topRightText, { x: halfWidth - font.widthOfTextAtSize(topRightText, size) - 45, y: topY, size, font, color, opacity });
                        
                        page.drawText(bottomLeftText, { x: 45, y: bottomY, size, font, color, opacity });
                        page.drawText(bottomRightText, { x: halfWidth - font.widthOfTextAtSize(bottomRightText, size) - 45, y: bottomY, size, font, color, opacity });

                        // -- RIGHT PAGE STAMPS --
                        page.drawText(topLeftText, { x: halfWidth + 45, y: topY, size, font, color, opacity });
                        page.drawText(topRightText, { x: width - font.widthOfTextAtSize(topRightText, size) - 45, y: topY, size, font, color, opacity });
                        
                        page.drawText(bottomLeftText, { x: halfWidth + 45, y: bottomY, size, font, color, opacity });
                        page.drawText(bottomRightText, { x: width - font.widthOfTextAtSize(bottomRightText, size) - 45, y: bottomY, size, font, color, opacity });
                } else {
                        // BACK PAGE (Inverted / Rotated 180 degrees)
                        const invTopY = 25; 
                        const invBottomY = height - 12;
                        
                        // -- LEFT PAGE STAMPS (Physical left half) --
                        page.drawText(topLeftText, { x: halfWidth - 45, y: invTopY, size, font, color, opacity, rotate: degrees(180) });
                        page.drawText(topRightText, { x: 45 + font.widthOfTextAtSize(topRightText, size), y: invTopY, size, font, color, opacity, rotate: degrees(180) });
                        
                        page.drawText(bottomLeftText, { x: halfWidth - 45, y: invBottomY, size, font, color, opacity, rotate: degrees(180) });
                        page.drawText(bottomRightText, { x: 45 + font.widthOfTextAtSize(bottomRightText, size), y: invBottomY, size, font, color, opacity, rotate: degrees(180) });

                        // -- RIGHT PAGE STAMPS (Physical right half) --
                        page.drawText(topLeftText, { x: width - 45, y: invTopY, size, font, color, opacity, rotate: degrees(180) });
                        page.drawText(topRightText, { x: halfWidth + 45 + font.widthOfTextAtSize(topRightText, size), y: invTopY, size, font, color, opacity, rotate: degrees(180) });
                        
                        page.drawText(bottomLeftText, { x: width - 45, y: invBottomY, size, font, color, opacity, rotate: degrees(180) });
                        page.drawText(bottomRightText, { x: halfWidth + 45 + font.widthOfTextAtSize(bottomRightText, size), y: invBottomY, size, font, color, opacity, rotate: degrees(180) });
                    }
                } else {
                    // Standard Portrait Layouts
                    page.drawText(topLeftText, { x: 45, y: topY, size, font, color, opacity });
                    page.drawText(topRightText, { x: width - font.widthOfTextAtSize(topRightText, size) - 45, y: topY, size, font, color, opacity });
                    
                    page.drawText(bottomLeftText, { x: 45, y: bottomY, size, font, color, opacity });
                    page.drawText(bottomRightText, { x: width - font.widthOfTextAtSize(bottomRightText, size) - 45, y: bottomY, size, font, color, opacity });
                }
            });
        } catch (err) {
            console.error(`[PDF Engine] Error processing specific task for ${task.pdfUrl}:`, err);
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
    memory: "4GiB", // ⬆️ Increased to handle massive rooms like LH 13 without crashing
    timeoutSeconds: 300,
    cors: true
}, async (req, res) => {
    const { center, date, roomName, type, seatId, skipSeatIds } = req.body;
    if (!center || !date || !roomName) {
        res.status(400).send({ error: "Missing required parameters: center, date, roomName" });
        return;
    }

  try {
        const safeRoomName = roomName.replace(/[^a-zA-Z0-9]/g, '_');
        const docId = `${center}_${date}_${safeRoomName}`;

        let allocDoc = await admin.firestore().collection(`exam_seating_rooms`).doc(docId).get();
        let allocations = {};
        
      if (allocDoc.exists) {
                    allocations = allocDoc.data().allocations || {};
                } else {
                    // Case-Insensitive & Base Name Fallback Lookup
                    const snap = await admin.firestore().collection(`exam_seating_rooms`)
                        .where("date", "==", date)
                        .where("center", "==", center)
                        .get();
                    
                    const baseRoomName = roomName.split(' [')[0].toUpperCase();
                    
                    const match = snap.docs.find(d => {
                        const dbRoom = (d.data().roomName || "").toUpperCase();
                        return dbRoom === roomName.toUpperCase() || dbRoom === baseRoomName;
                    });
                    
                    if (match) {
                        const dbAllocations = match.data().allocations || {};
                        const dbRoom = match.data().roomName || "";
                        
                        // Auto-migrate keys if matched on base name (un-shifted legacy format)
                        if (dbRoom.toUpperCase() !== roomName.toUpperCase() && roomName.includes('[')) {
                            Object.keys(dbAllocations).forEach(k => {
                                if (k.includes('-R')) {
                                    const rest = k.substring(k.indexOf('-R'));
                                    allocations[`${roomName}${rest}`] = dbAllocations[k];
                                }
                            });
                        } else {
                            allocations = dbAllocations;
                        }
                    } else {
                        // Legacy Monolithic Fallback
                        const oldDocId = `${center}_${date}`;
                        const oldDoc = await admin.firestore().collection(`exam_seating_allocations`).doc(oldDocId).get();
                        
                        if (oldDoc.exists) {
                            const data = oldDoc.data();
                            const allAllocations = (typeof data.allocations === 'string') ? JSON.parse(data.allocations) : (data.allocations || {});
                            
                            Object.keys(allAllocations).forEach(key => {
                                if (key.toUpperCase().startsWith(`${roomName}-`.toUpperCase())) {
                                    allocations[key] = allAllocations[key];
                                } else if (roomName.includes('[') && key.toUpperCase().startsWith(`${baseRoomName}-`.toUpperCase())) {
                                    if (key.includes('-R')) {
                                        const rest = key.substring(key.indexOf('-R'));
                                        allocations[`${roomName}${rest}`] = allAllocations[key];
                                    }
                                }
                            });
                        }
                    }
                }

   if (Object.keys(allocations).length === 0) {
            res.status(404).send({ error: `Seating allocations not found for room: ${roomName} on ${date}.` });
            return;
        }

        let filteredAllocations = allocations;
        if (seatId && allocations[seatId]) {
            filteredAllocations = { [seatId]: allocations[seatId] };
        } else if (skipSeatIds && Array.isArray(skipSeatIds) && skipSeatIds.length > 0) {
            filteredAllocations = {};
            Object.keys(allocations).forEach(k => {
                // Ignore the seats belonging to students taking Online exams
                if (!skipSeatIds.includes(k)) {
                    filteredAllocations[k] = allocations[k];
                }
            });
        }

        const docType = type === 'omr' ? 'omr' : 'qp';
        
        const mergedPdfBytes = await compileSingleRoomPackage(center, date, roomName, filteredAllocations, docType);
        
        if (!mergedPdfBytes) {
            res.status(400).send({ error: `Room has no students allocated, or the requested PDF (${docType.toUpperCase()}) was not uploaded for these sections.` });
            return;
        }

        const filePrefix = seatId ? seatId : roomName;
        const timestamp = Date.now(); // FORCES FRESH GENERATION EVERY TIME
        const suffix = docType === 'omr' ? `_omr_package_${timestamp}.pdf` : `_print_package_${timestamp}.pdf`;
        const storagePath = `print_packages/${center}/${date}/${filePrefix}${suffix}`;
        
        // Clean up older PDFs for this specific room
        try {
            const bucket = admin.storage().bucket();
            const [files] = await bucket.getFiles({ prefix: `print_packages/${center}/${date}/` });
            const filesToDelete = files.filter(f => 
                f.name.includes(`/${filePrefix}_print_package`) || 
                f.name.includes(`/${filePrefix}_omr_package`)
            );
            await Promise.all(filesToDelete.map(f => f.delete()));
        } catch(e) {
            console.error("Cleanup error:", e);
        }

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
