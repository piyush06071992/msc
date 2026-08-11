const { onSchedule } = require("firebase-functions/v2/scheduler");
const admin = require("firebase-admin");

if (!admin.apps.length) {
    admin.initializeApp();
}

// --- 10-MINUTE PRE-CLASS REMINDER CRON JOB ---
exports.sendPreClassReminders = onSchedule({
    schedule: "every 5 minutes",
    timeZone: "Asia/Kolkata",
    region: "asia-south1" // Matches Mumbai
}, async (event) => {
    
    // 1. TIMEZONE SYNC: Force evaluation in IST
    const utcDate = new Date();
    const istString = utcDate.toLocaleString("en-US", { timeZone: "Asia/Kolkata" });
    const istDate = new Date(istString);
    
    const daysArr = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const currentDay = daysArr[istDate.getDay()];
    
    // Generate strict ISO Date for IST (e.g., "2026-08-11") to match history documents
    const year = istDate.getFullYear();
    const month = String(istDate.getMonth() + 1).padStart(2, '0');
    const day = String(istDate.getDate()).padStart(2, '0');
    const todayIso = `${year}-${month}-${day}`;
    
    // Calculate current time in total minutes since midnight in IST
    const currentMins = istDate.getHours() * 60 + istDate.getMinutes();
    const targetMins = currentMins + 10; // Target classes starting in 10 minutes

    const targetHour = Math.floor(targetMins / 60).toString().padStart(2, '0');
    const targetMinute = (targetMins % 60).toString().padStart(2, '0');
    const targetTimeStr = `${targetHour}:${targetMinute}`;

    console.log(`[Reminders] Checking Date: ${todayIso} (${currentDay}), Target: ${targetTimeStr}`);

    try {
        let notifications = [];
        
        // Define branch configurations
        const branches = [
            { prefix: "", name: "Ghumarwin" },
            { prefix: "dharamshala_", name: "Dharamshala" }
        ];

        // 2. CHECK EACH BRANCH FOR OVERRIDES VS LIVE MASTER
        for (const branch of branches) {
            const historyCol = `${branch.prefix}timetable_history`;
            const masterCol = `${branch.prefix}timetable`;
            
            let branchSchedule = [];
            let isOverride = false;

            // A. Check for Daily or Exam Overrides first
            const historyDoc = await admin.firestore().collection(historyCol).doc(todayIso).get();
            if (historyDoc.exists) {
                const hData = historyDoc.data();
                if (hData.type === "DAILY_OVERRIDE" || hData.type === "EXAM_OVERRIDE") {
                    isOverride = true;
                    branchSchedule = hData.schedule || [];
                    console.log(`[Reminders] Found active OVERRIDE for ${branch.name} on ${todayIso}.`);
                }
            }

            // B. Extract the target slots
            if (isOverride) {
                // Filter the JSON array from the override document
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
                // Query the standard live master collection
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

        if (notifications.length === 0) {
            console.log("[Reminders] No matching classes found for this window.");
            return null;
        }

        console.log(`[Reminders] Found ${notifications.length} classes. Processing push alerts...`);

        // 3. SEND FCM HIGH-PRIORITY PUSH NOTIFICATIONS
        for (let notif of notifications) {
            let staffSnap = null;
            
            // Try matching by exact email first
            if (notif.teacherEmail) {
                staffSnap = await admin.firestore().collection("staff_applications")
                    .where("email", "==", notif.teacherEmail)
                    .get();
            }

            // Fallback to searching all staff by name if email failed or was missing
            if ((!staffSnap || staffSnap.empty) && notif.teacherName) {
                staffSnap = await admin.firestore().collection("staff_applications").get();
            }

            let targetToken = null;
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
                            targetToken = staffData.fcmToken;
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
                        headers: {
                            Urgency: "high" // Forces Android wake up
                        },
                        notification: {
                            requireInteraction: true,
                            vibrate: [300, 100, 300, 100, 300, 100, 500] // Aggressive ringing pattern
                        }
                    }
                };
                await admin.messaging().send(message);
                console.log(`[Reminders] Successfully alerted ${notif.teacherName || notif.teacherEmail}`);
            }
        }
    } catch (error) {
        console.error("[Reminders] Error executing pre-class reminders:", error);
    }

    return null;
});
