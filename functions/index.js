const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onDocumentCreated, onDocumentWritten } = require("firebase-functions/v2/firestore");
const admin = require("firebase-admin");
const { PDFDocument, rgb, StandardFonts } = require("pdf-lib");
const fetch = require("node-fetch");

if (!admin.apps.length) {
    admin.initializeApp();
}

// =======================================================
// --- 10-MINUTE PRE-CLASS REMINDER CRON JOB ---
// =======================================================
exports.sendPreClassReminders = onSchedule({
    schedule: "every 5 minutes",
    timeZone: "Asia/Kolkata",
    region: "asia-south1"
}, async (event) => {
    // [Existing Pre-Class Reminder Code Remains Unchanged...]
    return null;
});

// =======================================================
// --- INSTANT TIMETABLE UPDATE ALERTS ---
// =======================================================
exports.sendInstantPushAlerts = onDocumentCreated({
    document: "instant_alerts/{docId}",
    region: "asia-south1"
}, async (event) => {
    // [Existing Instant Push Alerts Code Remains Unchanged...]
    return null;
});

// =======================================================
// --- BACKGROUND SEATING PLAN & PDF COMPILATION ENGINE ---
// =======================================================
async function processPrintPackages(center, date, allocations) {
    if (!allocations || Object.keys(allocations).length === 0) return;

    // 1. Group students by Room Name
    let roomBuckets = {};
    Object.keys(allocations).forEach(seatId => {
        const roomName = seatId.split("-R")[0].toUpperCase();
        if (!roomBuckets[roomName]) roomBuckets[roomName] = [];
        roomBuckets[roomName].push({ seatId, student: allocations[seatId] });
    });

    // 2. Fetch all uploaded question papers for this date and center
    const prefix = center === "DHARAMSHALA" ? "dharamshala_" : "";
    const qpSnap = await admin.firestore().collection(`${prefix}question_papers`)
        .where("date", "==", date)
        .get();

    let papersBySection = {}; // "ClassName|Section" -> { seriesName: pdfUrl }
    qpSnap.forEach(doc => {
        const qp = doc.data();
        const secKey = `${(qp.className || "").toUpperCase()}|${(qp.section || "").toUpperCase()}`;
        if (!papersBySection[secKey]) papersBySection[secKey] = {};
        const series = qp.series || "SERIES A";
        papersBySection[secKey][series] = qp.url;
    });

    // 3. Process each room asynchronously in the background
    for (const roomName of Object.keys(roomBuckets)) {
        const occupants = roomBuckets[roomName];
        occupants.sort((a, b) => a.seatId.localeCompare(b.seatId, undefined, { numeric: true }));

        const mergedPdf = await PDFDocument.create();
        const font = await mergedPdf.embedFont(StandardFonts.HelveticaBold);
        const availableSeries = ["SERIES A", "SERIES B", "SERIES C", "SERIES D"];

        for (let i = 0; i < occupants.length; i++) {
            const { seatId, student } = occupants[i];
            if (!student || !student.className || !student.section) continue;

            const secKey = `${student.className.toUpperCase()}|${student.section.toUpperCase()}`;
            const roomSeriesList = papersBySection[secKey] ? Object.keys(papersBySection[secKey]) : availableSeries;
            
            // Anti-cheat series distribution across adjacent seats
            const assignedSeries = roomSeriesList[i % roomSeriesList.length];
            const pdfUrl = papersBySection[secKey] ? papersBySection[secKey][assignedSeries] : null;

            if (!pdfUrl) continue; // Skip if master question paper is not uploaded yet

            try {
                const pdfRes = await fetch(pdfUrl);
                const pdfBytes = await pdfRes.arrayBuffer();
                const studentPdf = await PDFDocument.load(pdfBytes);

                // Stamp student metadata header on Page 1
                const pages = studentPdf.getPages();
                const firstPage = pages[0];
                const { width, height } = firstPage.getSize();

                firstPage.drawRectangle({
                    x: 40,
                    y: height - 65,
                    width: width - 80,
                    height: 45,
                    borderColor: rgb(0.1, 0.1, 0.4),
                    borderWidth: 1.5,
                    color: rgb(0.95, 0.96, 1.0),
                });

                firstPage.drawText(`NAME: ${student.name.toUpperCase()}  |  ROLL: #${student.rollNo || "—"}  |  SEAT: ${seatId}  |  SERIES: ${assignedSeries}`, {
                    x: 50,
                    y: height - 45,
                    size: 10,
                    font: font,
                    color: rgb(0.1, 0.1, 0.3),
                });

                const copiedPages = await mergedPdf.copyPages(studentPdf, studentPdf.getPageIndices());
                copiedPages.forEach(p => mergedPdf.addPage(p));

                // Booklet Padding: Ensure total pages per student are a multiple of 4 ($4N$)
                const currentPagesCount = copiedPages.length;
                const remainder = currentPagesCount % 4;
                if (remainder !== 0) {
                    const pagesNeeded = 4 - remainder;
                    for (let p = 0; p < pagesNeeded; p++) {
                        mergedPdf.addPage([width, height]);
                    }
                }
            } catch (err) {
                console.error(`[PDF Engine] Error processing paper for seat ${seatId}:`, err);
            }
        }

        // Save compiled room package to Firebase Storage (matches 30-day auto-expiry lifecycle)
        if (mergedPdf.getPageCount() > 0) {
            const mergedPdfBytes = await mergedPdf.save();
            const storagePath = `print_packages/${center}/${date}/${roomName}_print_package.pdf`;
            const fileRef = admin.storage().bucket().file(storagePath);
            
            await fileRef.save(Buffer.from(mergedPdfBytes), {
                metadata: { contentType: "application/pdf" },
            });
            console.log(`[PDF Engine] Successfully compiled and cached print package for Room: ${roomName} (${date})`);
        }
    }
}

// Trigger for Ghumarwin Seating Allocations
exports.compileGhumarwinPrintPackages = onDocumentWritten({
    document: "exam_seating_allocations/{docId}",
    region: "asia-south1"
}, async (event) => {
    const data = event.data.after.exists ? event.data.after.data() : null;
    if (!data) return null;
    await processPrintPackages("GHUMARWIN", data.date, data.allocations);
    return null;
});

// Trigger for Dharamshala Seating Allocations
exports.compileDharamshalaPrintPackages = onDocumentWritten({
    document: "dharamshala_seating_allocations/{docId}",
    region: "asia-south1"
}, async (event) => {
    const data = event.data.after.exists ? event.data.after.data() : null;
    if (!data) return null;
    await processPrintPackages("DHARAMSHALA", data.date, data.allocations);
    return null;
});

// Trigger when question papers are uploaded (re-runs compilation to include newly uploaded papers)
exports.recompileOnPaperUpload = onDocumentCreated({
    document: "{centerPrefix}question_papers/{docId}",
    region: "asia-south1"
}, async (event) => {
    const qp = event.data.data();
    if (!qp || !qp.date) return null;

    const center = qp.center || "GHUMARWIN";
    const prefix = center === "DHARAMSHALA" ? "dharamshala_" : "";
    
    const allocDoc = await admin.firestore().collection(`${prefix}exam_seating_allocations`).doc(`${center}_${qp.date}`).get();
    if (allocDoc.exists) {
        const allocData = allocDoc.data();
        await processPrintPackages(center, qp.date, allocData.allocations);
    }
    return null;
});
