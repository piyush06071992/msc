// =====================================================================================
// MINERVA ERP — EMAIL BOT (Google Apps Script)
// - All earlier emails unchanged (application received, interview room, leave, adjustment,
//   attendance edit request, attendance discrepancy, timetable / duty chart).
// - New: offer letter, offer response alert, password reset code, CV ID reminder.
// - NO COPIES ARE KEPT: every email is sent from a draft and the sent copy is deleted at once
//   (permanently if the Gmail advanced service is on, otherwise moved to Trash, which Gmail
//   empties after 30 days). An hourly clean-up catches anything missed (run setupCleanupTrigger once).
// =====================================================================================

// Who gets offer responses (accepted / declined / change requested)
const OFFER_NOTIFY_EMAILS = [
  "rana.rpiyush.piyush826@gmail.com",
  "rakeshchandel1@gmail.com",
  "chandel_14@rediffmail.com"
];
// Word placed in every bot email so the clean-up finds only bot emails (never your own mail)
const BOT_MARK = "mscerpbot";
// Applicants check their application here (button in the "application received" email)
const STATUS_PAGE = "https://minervaacademy.web.app/application-status.html";

// THIS FILE IS DEPLOYED AUTOMATICALLY from the GitHub repository (apps-script/ folder,
// workflow "Deploy Email Bot (Apps Script)"). Edit it there, not in the Apps Script editor —
// changes made only in the editor are overwritten by the next deploy.

function doPost(e) {
  try {
    // 1. Read the data sent from your Portal
    let data = JSON.parse(e.postData.contents);
    let type = data.type;
    console.log("Email bot request: " + (type || (data.teachersAffected ? "TIMETABLE/DUTY" : "unknown")));

    // =================================================================
    // STAFF APPLICATION CONFIRMATION EMAIL (CV ID)
    // =================================================================
    if (type === "STAFF_APPLICATION_SUBMITTED") {
      let applicantEmail = String(data.email || "").trim();
      let cvId = esc(String(data.cvId || "").trim());
      let branch = esc(String(data.branch || "Minerva Study Circle").trim());
      let details = data.details || {};
      let applicantName = esc(details["Full Name"] || details["Name"] || "Applicant");

      if (applicantEmail && applicantEmail.includes("@")) {
        let htmlBody = `
          <div style="font-family: Arial, sans-serif; color: #0f172a; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden;">
            <div style="background-color: #1e1b4b; color: #ffffff; padding: 20px; text-align: center;">
              <h2 style="margin: 0; text-transform: uppercase; letter-spacing: 1px;">Application Received</h2>
            </div>
            <div style="padding: 24px;">
              <p>Dear <strong>${applicantName}</strong>,</p>
              <p>Thank you for applying at <strong>Minerva Study Circle</strong>. Your application has been received and is currently under review.</p>
              <div style="background:#f8fafc; border-left:4px solid #2563eb; padding:14px; margin:18px 0;">
                <strong>Application / CV ID:</strong> <span style="font-size: 16px; color: #1d4ed8;">${cvId}</span><br>
                <strong>Preferred Branch:</strong> ${branch}<br>
                <strong>Status:</strong> Pending Review
              </div>
              <p>Please save your <strong>CV ID (${cvId})</strong> for future reference and interview tracking.</p>
              <p style="text-align:center; margin:20px 0;"><a href="${STATUS_PAGE}?id=${encodeURIComponent(data.cvId || "")}" target="_blank" style="background-color:#2563eb; color:#ffffff; text-decoration:none; padding:12px 24px; border-radius:8px; font-weight:bold; display:inline-block;">Check Application Status</a></p>
              <p style="margin-top:20px; font-size:12px; color:#64748b; text-align:center;">This is an automated confirmation from Minerva Study Circle.</p>
            </div>
          </div>
        `;

        sendBotEmailNoSentClutter(
          applicantEmail,
          `Minerva Study Circle: Application Confirmed (${data.cvId || ""})`,
          `Dear ${details["Full Name"] || details["Name"] || "Applicant"}, your application has been received. Your CV ID is ${data.cvId || ""}.`,
          { htmlBody: htmlBody }
        );
      }

      return ok({ cvId: data.cvId || "" });
    }

    // =================================================================
    // LIVE DEMO / INTERVIEW ROOM INVITE EMAIL
    // =================================================================
    if (type === "INTERVIEW_ROOM_INVITE") {
      let applicantEmail = String(data.email || "").trim();
      let cvId = esc(String(data.cvId || "").trim());
      let applicantName = esc(String(data.applicantName || "Applicant").trim());
      let interviewerName = esc(String(data.interviewerName || "Minerva Faculty").trim());
      let roomLink = safeLink(data.roomLink);

      if (applicantEmail && applicantEmail.includes("@") && roomLink) {
        let htmlBody = `
          <div style="font-family: Arial, sans-serif; color: #0f172a; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden;">
            <div style="background-color: #1e1b4b; color: #ffffff; padding: 20px; text-align: center;">
              <h2 style="margin: 0; text-transform: uppercase; letter-spacing: 1px;">Live Demo Interview Invitation</h2>
            </div>
            <div style="padding: 24px;">
              <p>Dear <strong>${applicantName}</strong>,</p>
              <p>Your live demo &amp; interview session with <strong>${interviewerName}</strong> at <strong>Minerva Study Circle</strong> is ready.</p>
              <div style="background:#f8fafc; border-left:4px solid #4f46e5; padding:14px; margin:18px 0;">
                <strong>Application / CV ID:</strong> ${cvId || "—"}<br>
                <strong>Interviewer:</strong> ${interviewerName}
              </div>
              <p style="text-align:center; margin:24px 0;">
                <a href="${roomLink}" target="_blank" style="background-color:#2563eb; color:#ffffff; text-decoration:none; padding:12px 24px; border-radius:8px; font-weight:bold; display:inline-block;">
                  Join Live Demo Room
                </a>
              </p>
              <p style="font-size:12px; color:#475569; word-break:break-all;">Direct Link: <a href="${roomLink}" target="_blank">${roomLink}</a></p>
              <p style="margin-top:20px; font-size:12px; color:#64748b; text-align:center;">This is an automated notification from Minerva Study Circle.</p>
            </div>
          </div>
        `;

        sendBotEmailNoSentClutter(
          applicantEmail,
          `Minerva Study Circle: Live Demo Room Link (${data.cvId || data.applicantName || "Applicant"})`,
          `Dear ${data.applicantName || "Applicant"}, join your live demo room with ${data.interviewerName || "Minerva Faculty"} here: ${roomLink}`,
          { htmlBody: htmlBody }
        );
      }

      return ok({ cvId: data.cvId || "" });
    }

    // =================================================================
    // TEACHER LEAVE APPLICATION NOTIFICATIONS
    // =================================================================
    if (type === "TEACHER_LEAVE_APPLICATION") {
      let center = esc(data.center || "GHUMARWIN");
      let teacherName = esc(data.teacherName || "");
      let teacherDept = esc(data.teacherDept || "General");
      let teacherEmail = esc(data.teacherEmail || "");
      let leaveType = esc(data.leaveType || "");
      let startDate = formatCustomDate(data.startDate || "");
      let endDate = formatCustomDate(data.endDate || data.startDate || "");

      function format12H(tStr) {
        if (!tStr || !tStr.includes(':')) return tStr;
        let p = tStr.split(':');
        let h = parseInt(p[0], 10);
        let m = p[1];
        let mod = h >= 12 ? 'PM' : 'AM';
        h = h % 12 || 12;
        return `${h.toString().padStart(2, '0')}:${m} ${mod}`;
      }

      let startTime = esc(format12H(data.startTime || ""));
      let endTime = esc(format12H(data.endTime || ""));
      let reason = esc(data.reason || "");

      let timingHtml = "";
      if (startTime && endTime) {
        timingHtml = `<strong>Timings:</strong> ${startTime} to ${endTime} <br>`;
      }

      let targetEmails = [
        "rana.rpiyush.piyush826@gmail.com",
        "rakeshchandel1@gmail.com",
        "chandel_14@rediffmail.com"
      ];
      if (data.center === "DHARAMSHALA") {
        targetEmails.push("shubhamchoudhary899@gmail.com");
      } else {
        targetEmails.push("ravindermaths2021@gmail.com", "reetikasharma11june@gmail.com");
      }

      let htmlBody = `
        <div style="font-family: Arial, sans-serif; color: #0f172a; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden;">
          <div style="background-color: #1e1b4b; color: #ffffff; padding: 20px; text-align: center;">
            <h2 style="margin: 0; text-transform: uppercase; letter-spacing: 1px;">New Leave Application</h2>
          </div>
          <div style="padding: 20px;">
            <p>A new leave application has been submitted by a staff member and is pending review.</p>
            <div style="background:#f8fafc; border-left:4px solid #1e1b4b; padding:12px; margin-bottom:15px;">
              <strong>Branch / Center:</strong> ${center} <br>
              <strong>Applicant:</strong> ${teacherName} (${teacherDept}) - ${teacherEmail} <br>
              <strong>Leave Type:</strong> ${leaveType} <br>
              <strong>From:</strong> ${startDate} <br>
              <strong>To:</strong> ${endDate} <br>
              ${timingHtml}
              <strong>Reason:</strong> ${reason}
            </div>
            <p>Please log in to the Minerva Admin Portal to review and approve/reject this request.</p>
            <p style="margin-top:20px; font-size:12px; color:#64748b; text-align:center;">This is an automated notification from the Minerva ERP System.</p>
          </div>
        </div>
      `;

      targetEmails.forEach(adminEmail => {
        sendBotEmailNoSentClutter(
          adminEmail,
          "Minerva ERP: New Leave Application (" + (data.teacherName || "") + ")",
          "Please open this email in an HTML compatible client.",
          { htmlBody: htmlBody }
        );
      });

      return ok();
    }

    // =================================================================
    // TEACHER ADJUSTMENT NOTIFICATIONS (HTML FORMAT)
    // =================================================================
    if (type === "TEACHER_ADJUSTMENT_NOTIFY") {
      let requesterName = esc(data.requester);
      let adjustments = data.list || [];

      // Group adjustments by the teacher who is being asked to substitute
      let groupedByTeacher = {};
      adjustments.forEach(adj => {
        if (!groupedByTeacher[adj.email]) {
          groupedByTeacher[adj.email] = { name: adj.name, classes: [] };
        }
        groupedByTeacher[adj.email].classes.push(adj);
      });

      // Send one consolidated email to each substitute teacher
      for (let email in groupedByTeacher) {
        if (email && email.includes("@")) {
          let teacherData = groupedByTeacher[email];
          let classListHtml = "";

          teacherData.classes.forEach(c => {
            let formattedDate = formatCustomDate(c.date);
            classListHtml += `
              <div style="background:#f8fafc; border-left:4px solid #4f46e5; padding:10px; margin-bottom:10px;">
                <strong>Date:</strong> ${formattedDate} <br>
                <strong>Time:</strong> ${esc(c.time)} <br>
                <strong>Class:</strong> ${esc(c.section)} <br>
                <strong>Subject:</strong> ${esc(c.subject)}
              </div>
            `;
          });

          let htmlBody = `
            <div style="font-family: Arial, sans-serif; color: #0f172a; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden;">
              <div style="background-color: #1e1b4b; color: #ffffff; padding: 20px; text-align: center;">
                <h2 style="margin: 0; text-transform: uppercase; letter-spacing: 1px;">Class Adjustment Notice</h2>
              </div>
              <div style="padding: 20px;">
                <p>Dear <strong>${esc(teacherData.name)}</strong>,</p>
                <p>You have been assigned as a substitute by <strong>${requesterName} (${esc(data.requesterDept || 'Staff')})</strong> for the following classes due to an approved leave:</p>
                ${classListHtml}
                <p style="margin-top:20px; font-size:12px; color:#64748b; text-align:center;">This is an automated notification from the Minerva ERP System.</p>
              </div>
            </div>
          `;

          sendBotEmailNoSentClutter(
            email,
            "Minerva ERP: Class Adjustment (" + (data.requester || "") + ")",
            "Please open this email in an HTML compatible client.",
            { htmlBody: htmlBody }
          );
        }
      }

      return ok();
    }

    // =================================================================
    // ATTENDANCE EDIT & CORRECTION REQUEST NOTIFICATIONS
    // =================================================================
    if (type === "ATTENDANCE_EDIT_REQUEST") {
      let center = esc(data.center || "GHUMARWIN");
      let className = esc(data.className || "");
      let section = esc(data.section || "");
      let subject = esc(data.subject || "");
      let date = esc(data.date || "");
      let teacherEmail = esc(data.teacherEmail || "");
      let teacherName = esc(data.teacherName || data.teacherEmail || "");
      let reason = esc(data.reason || "");

      let targetEmails = ["rakeshchandel1@gmail.com", "chandel_14@rediffmail.com"];

      let htmlBody = `
        <div style="font-family: Arial, sans-serif; color: #0f172a; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden;">
          <div style="background-color: #800000; color: #ffffff; padding: 20px; text-align: center;">
            <h2 style="margin: 0; text-transform: uppercase; letter-spacing: 1px;">Attendance Edit Request</h2>
          </div>
          <div style="padding: 20px;">
            <p>A new request to edit or correct past attendance has been submitted and requires your review.</p>
            <div style="background:#f8fafc; border-left:4px solid #800000; padding:12px; margin-bottom:15px;">
              <strong>Branch / Center:</strong> ${center} <br>
              <strong>Class & Section:</strong> Class ${className} - Sec ${section} <br>
              <strong>Subject:</strong> ${subject} <br>
              <strong>Target Date:</strong> ${date} <br>
              <strong>Requested By:</strong> ${teacherName} (${teacherEmail}) <br>
              <strong>Reason:</strong> ${reason}
            </div>
            <p>Please log in to the Minerva Admin Portal to approve or reject this request.</p>
            <p style="margin-top:20px; font-size:12px; color:#64748b; text-align:center;">This is an automated notification from the Minerva ERP System.</p>
          </div>
        </div>
      `;

      targetEmails.forEach(adminEmail => {
        sendBotEmailNoSentClutter(
          adminEmail,
          "Minerva ERP: Attendance Edit Request (Class " + (data.className || "") + " Sec " + (data.section || "") + ")",
          "Please open this email in an HTML compatible client.",
          { htmlBody: htmlBody }
        );
      });

      return ok();
    }

    // =================================================================
    // ATTENDANCE DISCREPANCY / PROXY ALERT NOTIFICATIONS
    // =================================================================
    if (type === "ATTENDANCE_DISCREPANCY_NOTIFY") {
      let date = esc(data.date || "");
      let className = esc(data.className || "");
      let teacherName = esc(data.teacherName || "Teacher");
      let teacherEmail = esc(data.teacherEmail || "");
      let discrepancies = data.discrepancies || [];

      let targetEmails = ["rakeshchandel1@gmail.com", "chandel_14@rediffmail.com"];

      let listHtml = "";
      discrepancies.forEach(d => {
        let getFullStatus = (code) => code === 'P' ? 'Present' : 'Leave';
        listHtml += `
          <div style="background:#f8fafc; border-left:4px solid #dc2626; padding:10px; margin-bottom:10px;">
            <strong>Student:</strong> #${esc(d.rollNo)} ${esc(d.studentName)} (Sec ${esc(d.section)})<br>
            <strong>Marked Here (${esc(d.currentSubject)}):</strong> ${getFullStatus(d.currentStatus)}<br>
            <strong>Conflicting Subject (${esc(d.otherSubject)}):</strong> ${getFullStatus(d.otherStatus)}
          </div>
        `;
      });

      let htmlBody = `
        <div style="font-family: Arial, sans-serif; color: #0f172a; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden;">
          <div style="background-color: #dc2626; color: #ffffff; padding: 20px; text-align: center;">
            <h2 style="margin: 0; text-transform: uppercase; letter-spacing: 1px;">⚠️ Attendance Discrepancy Alert</h2>
          </div>
          <div style="padding: 20px;">
            <p>Cross-subject attendance discrepancies (potential proxies) were detected and bypassed by <strong>${teacherName}</strong> (${teacherEmail}) for Class ${className} on <strong>${date}</strong>.</p>
            <div style="margin-top:15px; margin-bottom:15px;">
              ${listHtml}
            </div>
            <p>Please log in to the Minerva Admin Portal to audit the logs.</p>
            <p style="margin-top:20px; font-size:12px; color:#64748b; text-align:center;">This is an automated notification from the Minerva ERP System.</p>
          </div>
        </div>
      `;

      targetEmails.forEach(adminEmail => {
        sendBotEmailNoSentClutter(
          adminEmail,
          "🚨 Minerva ERP: Attendance Discrepancy Alert (Class " + (data.className || "") + " - " + (data.date || "") + ")",
          "Please open this email in an HTML compatible client.",
          { htmlBody: htmlBody }
        );
      });

      return ok();
    }

    // =================================================================
    // NEW: OFFER LETTER TO A SELECTED CANDIDATE
    // data: email, applicantName, cvId, post, branch, monthlySalary, annualPackage, joiningDate,
    //       breakup [{name, percent, amount}], portalLink, pdfUrl (optional: attached as PDF)
    // =================================================================
    if (type === "OFFER_LETTER") {
      let to = String(data.email || "").trim();
      if (!to.includes("@")) return ok({ skipped: "no email" });
      let portalLink = safeLink(data.portalLink);
      let breakupRows = (data.breakup || []).map(b =>
        `<tr><td style="padding:6px 10px;border-bottom:1px solid #e2e8f0;">${esc(b.name)}</td>
             <td style="padding:6px 10px;border-bottom:1px solid #e2e8f0;text-align:right;">${esc(b.percent)}%</td>
             <td style="padding:6px 10px;border-bottom:1px solid #e2e8f0;text-align:right;">₹ ${esc(b.amount)}</td></tr>`).join("");
      let htmlBody = `
        <div style="font-family: Arial, sans-serif; color: #0f172a; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden;">
          <div style="background-color: #065f46; color: #ffffff; padding: 20px; text-align: center;">
            <h2 style="margin: 0; text-transform: uppercase; letter-spacing: 1px;">Offer of Appointment</h2>
          </div>
          <div style="padding: 24px;">
            <p>Dear <strong>${esc(data.applicantName || "Candidate")}</strong>,</p>
            <p>Congratulations! We are pleased to offer you the position of <strong>${esc(data.post || "Faculty")}</strong> at <strong>Minerva Study Circle${data.branch ? ", " + esc(data.branch) : ""}</strong>.</p>
            <div style="background:#f0fdf4; border-left:4px solid #059669; padding:14px; margin:18px 0;">
              <strong>Application / CV ID:</strong> ${esc(data.cvId || "—")}<br>
              <strong>Monthly Salary:</strong> ₹ ${esc(data.monthlySalary || "—")}<br>
              <strong>Annual Package:</strong> ₹ ${esc(data.annualPackage || "—")}<br>
              <strong>Date of Joining:</strong> ${formatCustomDate(data.joiningDate || "") || "—"}
            </div>
            ${breakupRows ? `<p style="margin-bottom:6px;"><strong>Monthly salary breakup</strong></p><table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:16px;">${breakupRows}</table>` : ""}
            ${portalLink ? `<p style="text-align:center; margin:24px 0;"><a href="${portalLink}" target="_blank" style="background-color:#059669; color:#ffffff; text-decoration:none; padding:12px 24px; border-radius:8px; font-weight:bold; display:inline-block;">View, Sign &amp; Accept Offer</a></p>
            <p style="font-size:12px; color:#475569; word-break:break-all;">Direct Link: <a href="${portalLink}" target="_blank">${portalLink}</a></p>` : ""}
            <p>Please log in with your email, CV ID or mobile number and your password to view the full offer letter, sign it and confirm your date of joining.</p>
            <p style="margin-top:20px; font-size:12px; color:#64748b; text-align:center;">This is an automated message from Minerva Study Circle.</p>
          </div>
        </div>
      `;
      let opts = { htmlBody: htmlBody };
      let pdf = fetchPdf(data.pdfUrl, `Offer_Letter_${data.cvId || "Minerva"}.pdf`);
      if (pdf) opts.attachments = [pdf];
      sendBotEmailNoSentClutter(to, `Minerva Study Circle: Offer of Appointment (${data.cvId || data.applicantName || ""})`,
        `Dear ${data.applicantName || "Candidate"}, congratulations! Your offer letter from Minerva Study Circle is ready. Monthly salary: Rs ${data.monthlySalary || "-"}, date of joining: ${data.joiningDate || "-"}. View and accept it here: ${portalLink}`, opts);
      return ok();
    }

    // =================================================================
    // NEW: CANDIDATE ANSWERED THE OFFER -> tell management
    // data: applicantName, cvId, response (ACCEPTED / DECLINED / CHANGE_REQUESTED), comment, joiningDate, branch
    // =================================================================
    if (type === "OFFER_RESPONSE") {
      let label = { ACCEPTED: "✅ Accepted", DECLINED: "❌ Declined", CHANGE_REQUESTED: "✏️ Requested a change" }[data.response] || esc(data.response || "Updated");
      let htmlBody = `
        <div style="font-family: Arial, sans-serif; color: #0f172a; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden;">
          <div style="background-color: #1e1b4b; color: #ffffff; padding: 20px; text-align: center;">
            <h2 style="margin: 0; text-transform: uppercase; letter-spacing: 1px;">Offer Response</h2>
          </div>
          <div style="padding: 20px;">
            <div style="background:#f8fafc; border-left:4px solid #1e1b4b; padding:12px; margin-bottom:15px;">
              <strong>Candidate:</strong> ${esc(data.applicantName || "")} (${esc(data.cvId || "")})<br>
              <strong>Branch:</strong> ${esc(data.branch || "—")}<br>
              <strong>Response:</strong> ${label}<br>
              <strong>Date of Joining:</strong> ${formatCustomDate(data.joiningDate || "") || "—"}<br>
              ${data.comment ? `<strong>Comment:</strong> ${esc(data.comment)}` : ""}
            </div>
            <p>Please open Recruitment &amp; Pending Staff in the Minerva portal for details.</p>
            <p style="margin-top:20px; font-size:12px; color:#64748b; text-align:center;">This is an automated notification from the Minerva ERP System.</p>
          </div>
        </div>
      `;
      OFFER_NOTIFY_EMAILS.forEach(adminEmail => {
        sendBotEmailNoSentClutter(adminEmail, `Minerva ERP: Offer ${String(data.response || "").replace(/_/g, " ").toLowerCase()} — ${data.applicantName || ""} (${data.cvId || ""})`,
          "Please open this email in an HTML compatible client.", { htmlBody: htmlBody });
      });
      return ok();
    }

    // =================================================================
    // NEW: PASSWORD RESET CODE (one-time code typed on the login page)
    // data: email, applicantName, code, minutes (validity)
    // =================================================================
    if (type === "APPLICANT_OTP") {
      let to = String(data.email || "").trim();
      let code = String(data.code || "").replace(/[^0-9]/g, "").slice(0, 8);
      if (!to.includes("@") || !code) return ok({ skipped: "missing email or code" });
      let mins = parseInt(data.minutes, 10) || 10;
      let htmlBody = `
        <div style="font-family: Arial, sans-serif; color: #0f172a; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden;">
          <div style="background-color: #1e1b4b; color: #ffffff; padding: 20px; text-align: center;">
            <h2 style="margin: 0; text-transform: uppercase; letter-spacing: 1px;">Password Reset Code</h2>
          </div>
          <div style="padding: 24px; text-align:center;">
            <p style="text-align:left;">Dear <strong>${esc(data.applicantName || "User")}</strong>,</p>
            <p style="text-align:left;">Use this code on the Minerva login page to set a new password. It is valid for ${mins} minutes.</p>
            <p style="font-size:32px; letter-spacing:8px; font-weight:bold; color:#1d4ed8; margin:20px 0;">${code}</p>
            <p style="text-align:left; font-size:12px; color:#64748b;">If you did not ask for this, ignore this email — your password stays the same. Never share this code with anyone.</p>
          </div>
        </div>
      `;
      sendBotEmailNoSentClutter(to, "Minerva Study Circle: Password Reset Code",
        `Your Minerva password reset code is ${code}. It is valid for ${mins} minutes. If you did not ask for it, ignore this email.`, { htmlBody: htmlBody });
      return ok();
    }

    // =================================================================
    // NEW: FORGOTTEN CV ID (sent only to the registered email)
    // data: email, applicantName, cvId, portalLink
    // =================================================================
    if (type === "APPLICANT_CVID_REMINDER") {
      let to = String(data.email || "").trim();
      if (!to.includes("@") || !data.cvId) return ok({ skipped: "missing email or CV ID" });
      let portalLink = safeLink(data.portalLink);
      let htmlBody = `
        <div style="font-family: Arial, sans-serif; color: #0f172a; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden;">
          <div style="background-color: #1e1b4b; color: #ffffff; padding: 20px; text-align: center;">
            <h2 style="margin: 0; text-transform: uppercase; letter-spacing: 1px;">Your CV ID</h2>
          </div>
          <div style="padding: 24px;">
            <p>Dear <strong>${esc(data.applicantName || "Applicant")}</strong>,</p>
            <p>Your Minerva Study Circle Application / CV ID is:</p>
            <p style="font-size:24px; font-weight:bold; color:#1d4ed8; text-align:center; margin:18px 0;">${esc(data.cvId)}</p>
            <p>You can log in with your CV ID, email or mobile number and your password.</p>
            ${portalLink ? `<p style="text-align:center;"><a href="${portalLink}" target="_blank" style="background-color:#2563eb; color:#ffffff; text-decoration:none; padding:10px 20px; border-radius:8px; font-weight:bold; display:inline-block;">Open Login Page</a></p>` : ""}
            <p style="margin-top:20px; font-size:12px; color:#64748b; text-align:center;">If you did not ask for this, ignore this email.</p>
          </div>
        </div>
      `;
      sendBotEmailNoSentClutter(to, "Minerva Study Circle: Your CV ID",
        `Your Minerva Study Circle CV ID is ${data.cvId}.`, { htmlBody: htmlBody });
      return ok();
    }

    // =================================================================
    // TIMETABLE & DUTY CHART NOTIFICATIONS (PLAIN TEXT)
    // =================================================================
    if (data.teachersAffected) {
      let teachers = data.teachersAffected;

      // Loop through every affected teacher and send an email
      for (let i = 0; i < teachers.length; i++) {
        let email = teachers[i].email;
        let name = teachers[i].name;

        if (email && email.includes("@")) {
          let subject = "";
          let body = "";

          // Decide which email to send based on the type
          if (type === "DUTY_CHART_UPDATE") {
            subject = "📋 NEW: Duty Chart Assignment";
            body = "Hello " + name + ",\n\nA new Weekly Duty Chart has been generated. You have been assigned duties for this week.\n\nPlease log in to the Minerva Staff Portal and check the 'Duties' tab for your specific timings and locations.\n\nThank you,\nMinerva Study Circle";
          } else {
            // Default to the original Timetable email
            subject = "🚨 URGENT: Timetable Update";
            body = "Hello " + name + ",\n\nYour timetable has just been updated by the Administration. Please log in to the Minerva Staff Portal to check your new schedule immediately.\n\nThank you,\nMinerva Study Circle";
          }

          sendBotEmailNoSentClutter(email, subject, body);
        }
      }
    }

    // Tell the portal it was a success
    return ok();

  } catch (error) {
    return ContentService.createTextOutput(JSON.stringify({ status: "error", message: error.message })).setMimeType(ContentService.MimeType.JSON);
  }
}

// =====================================================================================
// SENDING WITHOUT KEEPING COPIES
// The email is sent from a draft, so we get the exact sent message back and delete it at once:
//  - permanently, if the Gmail advanced service is added (Services -> Gmail API), or
//  - by moving it to Trash (Gmail empties Trash after 30 days).
// =====================================================================================
function sendBotEmailNoSentClutter(recipient, subject, plainBody, options) {
  options = options || {};
  const mark = `\n\n— ${BOT_MARK}`;
  const opts = Object.assign({}, options);
  if (opts.htmlBody) opts.htmlBody = opts.htmlBody + `<p style="font-size:9px;color:#cbd5e1;text-align:center;margin:6px 0 0;">${BOT_MARK}</p>`;
  // Email to this account itself: the sent and received copy are the SAME message,
  // so it must not be deleted (otherwise it disappears from the inbox too).
  const me = String(Session.getEffectiveUser().getEmail() || "").toLowerCase();
  const toSelf = String(recipient || "").toLowerCase().split(",").some(r => r.trim() === me);
  let sent = null;
  try {
    sent = GmailApp.createDraft(recipient, subject, String(plainBody || "") + mark, opts).send();
  } catch (e) {
    console.error("createDraft/send failed, using sendEmail: " + e.message);
    GmailApp.sendEmail(recipient, subject, String(plainBody || "") + mark, opts);
    return;
  }
  if (!toSelf) deleteBotMessage(sent);
}

function deleteBotMessage(msg) {
  if (!msg) return;
  try {
    if (typeof Gmail !== "undefined" && Gmail.Users && Gmail.Users.Messages) {
      Gmail.Users.Messages.remove("me", msg.getId());   // permanent delete
      return;
    }
  } catch (e) { /* no permission for permanent delete -> use Trash */ }
  try { msg.moveToTrash(); } catch (e) {}
}

// Hourly safety net: removes any bot email copy that is still in the mailbox.
// Only messages sent BY this account AND containing the bot word are touched.
function cleanupBotSentMail() {
  const me = Session.getEffectiveUser().getEmail().toLowerCase();
  let threads = GmailApp.search(`from:me "${BOT_MARK}" -in:trash -to:me`, 0, 200);
  threads.forEach(t => t.getMessages().forEach(m => {
    const toMe = String(m.getTo() || "").toLowerCase().includes(me);
    if (!toMe && String(m.getFrom()).toLowerCase().includes(me) && String(m.getPlainBody()).includes(BOT_MARK)) deleteBotMessage(m);
  }));
}

// ONE-TIME: remove old bot copies sent before this version (they have no bot word).
// Deletes only messages sent by this account whose subject STARTS with one of the bot subjects
// (replies like "Re: ..." and any mail from other people are never touched). Run it a few times
// from the editor until it reports 0.
function cleanupOldBotMailOnce() {
  const me = Session.getEffectiveUser().getEmail().toLowerCase();
  const subjects = [
    "Minerva Study Circle: Application Confirmed", "Minerva Study Circle: Live Demo Room Link",
    "Minerva ERP: New Leave Application", "Minerva ERP: Class Adjustment", "Minerva ERP: Attendance Edit Request",
    "🚨 Minerva ERP: Attendance Discrepancy Alert", "🚨 URGENT: Timetable Update", "📋 NEW: Duty Chart Assignment"
  ];
  let removed = 0;
  subjects.forEach(s => {
    const words = s.replace(/[^A-Za-z0-9 :]/g, " ").replace(/\s+/g, " ").trim();
    GmailApp.search(`from:me subject:(${words}) -in:trash`, 0, 200).forEach(t => t.getMessages().forEach(m => {
      if (String(m.getFrom()).toLowerCase().includes(me) && String(m.getSubject()).indexOf(s) === 0) { deleteBotMessage(m); removed++; }
    }));
  });
  Logger.log("Old bot emails removed: " + removed);
}

// Run ONCE from the editor to switch on the hourly clean-up.
function setupCleanupTrigger() {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === "cleanupBotSentMail").forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger("cleanupBotSentMail").timeBased().everyHours(1).create();
  Logger.log("Hourly clean-up switched on.");
}

// =====================================================================================
// HELPERS
// =====================================================================================
function ok(extra) {
  return ContentService.createTextOutput(JSON.stringify(Object.assign({ status: "success" }, extra || {}))).setMimeType(ContentService.MimeType.JSON);
}

// Text from the portal is shown as text, never as HTML
function esc(v) {
  return String(v === undefined || v === null ? "" : v)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// Only our own web addresses become buttons/links in emails
function safeLink(url) {
  url = String(url || "").trim();
  if (/^https:\/\/(minervaacademy\.web\.app|minervaacademy\.firebaseapp\.com|mp\.minerva\.academy|[a-z0-9-]+\.minerva\.academy)(\/|$)/i.test(url)) return esc(url);
  return "";
}

// Offer letter PDF from Firebase Storage (only from our storage bucket), max ~8 MB
function fetchPdf(url, name) {
  url = String(url || "");
  if (!/^https:\/\/firebasestorage\.googleapis\.com\/v0\/b\/shop-portal-bbbbb\./i.test(url)) return null;
  try {
    const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) return null;
    const blob = res.getBlob();
    if (blob.getBytes().length > 8 * 1024 * 1024) return null;
    return blob.setName(name).setContentType("application/pdf");
  } catch (e) { return null; }
}

function formatCustomDate(dateStr) {
  if (!dateStr) return "";
  let parts = String(dateStr).split('-');
  if (parts.length !== 3) return esc(dateStr);
  let year = parseInt(parts[0], 10);
  let monthIndex = parseInt(parts[1], 10) - 1;
  let day = parts[2];
  let months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  if (monthIndex >= 0 && monthIndex < 12) {
    return `${esc(day)} ${months[monthIndex]} ${year}`;
  }
  return esc(dateStr);
}
