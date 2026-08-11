const { onSchedule } = require("firebase-functions/v2/scheduler");
const admin = require("firebase-admin");

if (!admin.apps.length) {
    admin.initializeApp();
}

// --- 10-MINUTE PRE-CLASS REMINDER CRON JOB ---
exports.sendPreClassReminders = onSchedule({
    schedule: "every 5 minutes",
    timeZone: "Asia/Kolkata"
}, async (event) => {
    const now = new Date();
    const daysArr = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const currentDay = daysArr[now.getDay()];
    
    // Calculate current time in total minutes since midnight in IST
    const currentMins = now.getHours() * 60 + now.getMinutes();
    const targetMins = currentMins + 10; // Target classes starting in 10 minutes

    const targetHour = Math.floor(targetMins / 60).toString().padStart(2, '0');
    const targetMinute = (targetMins % 60).toString().padStart(2, '0');
    const targetTimeStr = `${targetHour}:${targetMinute}`;

    console.log(`[Reminders] Checking for day: ${currentDay}, target start time: ${targetTimeStr}`);

    try {
        // Query timetable slots across branch collections matching today and the target start time
        const collectionsToCheck = ["timetable", "dharamshala_timetable"];
        let notifications = [];

        for (const colName of collectionsToCheck) {
            const ttSnap = await admin.firestore().collection(colName)
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
                        timeRange: slot.timeRange || targetTimeStr
                    });
                }
            });
        }

        if (notifications.length === 0) {
            console.log("[Reminders] No matching classes found for this window.");
            return null;
        }

        console.log(`[Reminders] Found ${notifications.length} classes starting soon. Processing notifications...`);

        // Send free FCM push notification to each matching teacher
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
                    }
                };
                await admin.messaging().send(message);
                console.log(`[Reminders] Successfully sent notification to ${notif.teacherName || notif.teacherEmail}`);
            }
        }
    } catch (error) {
        console.error("[Reminders] Error executing pre-class reminders:", error);
    }

    return null;
});
