// ============================================================================
// APPLICANT PORTAL (server side) — used by application-status.html
// ----------------------------------------------------------------------------
// Applicants log in with email / CV ID / mobile + password. Everything runs here on the
// server, so the browser only ever receives THIS applicant's safe information:
// stage, interview link, offer (salary, joining date, letter). Scores, remarks, interviewer
// notes, history and other applicants' data never leave the server.
//
// Actions (POST JSON { action, ... }):
//   login        { identifier, password }            -> { token, view }
//   status       { token }                           -> { view }
//   requestReset { identifier }                      -> emails a 6-digit code (10 min)
//   confirmReset { identifier, code, newPassword }   -> sets the new password
//   forgotCvId   { identifier (email or mobile) }    -> emails the CV ID to the registered email
//   respondOffer { token, kind, comment, agree, signName, signImage, signedCopyUrl }
//   changePassword { token, oldPassword, newPassword }
//   logout       { token }
// Data: staff_applications (existing), applicant_sessions/{sha256(token)} (new).
// Passwords stay in the existing `password` field so staff login keeps working
// (moving every page to scrambled passwords is a separate step).
// ============================================================================
const crypto = require("crypto");

const EMAIL_BOT_URL = "https://script.google.com/macros/s/AKfycbyWUqGV1jd73NK_3zOU2Sy6wXCwcrjCG0ErqyRHM41f7qzcsNwxwjXfUlk2ZjFVeUmcdQ/exec";
const STATUS_PAGE = "https://minervaacademy.web.app/application-status.html";
const SESSION_HOURS = 12;
const OTP_MINUTES = 10;
const MAX_LOGIN_FAILS = 8;          // then locked for 15 minutes
const MAX_OTP_TRIES = 5;

const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const clean = (s, n) => String(s === undefined || s === null ? "" : s).trim().slice(0, n || 500);
function sameText(a, b) {
    const x = Buffer.from(sha(a)), y = Buffer.from(sha(b));
    return crypto.timingSafeEqual(x, y);
}

function nameOf(app) {
    const d = app.details || {};
    const k = Object.keys(d).find(k => k.toLowerCase().includes("name") && !/father|mother|husband|guardian/i.test(k));
    return (k && d[k]) ? String(d[k]).trim() : (app.email || "Applicant");
}
function branchOf(app) {
    const d = app.details || {};
    const k = Object.keys(d).find(k => /branch|cent/i.test(k));
    return (k && d[k]) ? String(d[k]) : "";
}

// Stage shown to the applicant (no scores, no internal notes)
function stageOf(app) {
    const st = String(app.status || "").toLowerCase();
    const stage = String(app.stage || "");
    if (st === "approved") return { step: 5, key: "JOINED", title: "Welcome to Minerva!", note: "You have joined. Please use Staff Login from now on." };
    if (st === "rejected") return { step: -1, key: "CLOSED", title: "Thank you for applying", note: "We are unable to take your application further at this time. We will contact you if a suitable position opens." };
    if (st.indexOf("offer_") === 0) {
        const note = { offer_sent: "Your offer letter is ready. Please read it below and respond.", offer_accepted: "You have accepted the offer. See you on your date of joining!", offer_change: "Your request for a change has been sent to HR. They will contact you.", offer_declined: "You have declined the offer." }[st] || "";
        return { step: 4, key: "OFFER", title: "Offer", note };
    }
    if (st === "hr_round" || (stage === "HR")) return { step: 3, key: "HR", title: "HR round", note: "Your application is with HR. You will be contacted soon." };
    if (["interview_assigned", "reassigned", "demo_scheduled", "sent_to_admin", "on_hold"].includes(st)) {
        return { step: 2, key: "INTERVIEW", title: "Interview", note: st === "demo_scheduled" ? "Your interview / demo is scheduled. Please check your email for the details." : "Your application is being reviewed by our faculty." };
    }
    return { step: 1, key: "APPLIED", title: "Application received", note: "Your application has been received and is waiting for review." };
}

// What the applicant may see
function viewOf(id, app) {
    const st = String(app.status || "").toLowerCase();
    const o = app.offer || null;
    const details = {};
    Object.entries(app.details || {}).forEach(([k, v]) => {
        if (/password/i.test(k)) return;
        details[k] = (v && typeof v === "object" && !Array.isArray(v)) ? { file: v.fileName || "file", url: v.url || "" } : v;
    });
    const interview = (app.demoMode === "Online" && app.meetLink && app.roomActive !== false && ["interview_assigned", "reassigned", "demo_scheduled"].includes(st))
        ? { link: String(app.meetLink) } : null;
    const offer = (o && o.status && ["offer_sent", "offer_accepted", "offer_change", "offer_declined", "approved"].includes(st)) ? {
        status: o.status, post: o.post || "", branch: o.branch || "", monthlySalary: o.monthlySalary || 0, annualPackage: o.annualPackage || 0,
        breakup: o.showBreakup === false ? [] : (o.breakup || []), joiningDate: o.joiningDate || "", letterHtml: o.letterHtml || "",
        pdfUrl: o.pdfUrl || "", sentAt: o.sentAt || "", letterDate: o.letterDate || "",
        response: o.response ? { kind: o.response.kind, comment: o.response.comment || "", at: o.response.at || "", via: o.response.via || "" } : null,
        signature: o.signature ? { name: o.signature.name, image: o.signature.image, at: o.signature.at } : null,
        signedCopyUrl: o.signedCopyUrl || ""
    } : null;
    return {
        id, cvId: app.cvId || id, name: nameOf(app), email: app.email || "", mobile: app.mobile || "",
        branch: branchOf(app), appliedOn: app.appliedOn && app.appliedOn.toDate ? app.appliedOn.toDate().toISOString() : (app.createdAtMs ? new Date(app.createdAtMs).toISOString() : ""),
        stage: stageOf(app), interview, offer, details
    };
}

function createPortal({ db, FieldValue, sendEmail, now }) {
    const clock = now || (() => Date.now());
    const apps = () => db.collection("staff_applications");

    // email / CV ID / mobile -> matching applications (newest, non-rejected first)
    async function findApplications(identifier) {
        const raw = clean(identifier, 120);
        if (!raw) return [];
        let snap;
        if (raw.includes("@")) snap = await apps().where("email", "==", raw.toLowerCase()).limit(10).get();
        else if (/^(cv)?[-\s]?\d{6}$/i.test(raw)) {
            const id = "CV-" + raw.replace(/\D/g, "");
            const one = await apps().doc(id).get();
            if (one.exists) return [{ id: one.id, data: one.data() }];
            snap = await apps().where("cvId", "==", id).limit(5).get();
        } else {
            const digits = raw.replace(/\D/g, "").slice(-10);
            if (digits.length !== 10) return [];
            snap = await apps().where("mobile", "==", digits).limit(10).get();
        }
        const list = snap.docs.map(d => ({ id: d.id, data: d.data() }));
        const rank = (a) => (String(a.data.status) === "rejected" ? 1 : 0);
        const t = (a) => (a.data.appliedOn && a.data.appliedOn.toMillis ? a.data.appliedOn.toMillis() : (a.data.createdAtMs || 0));
        return list.sort((a, b) => rank(a) - rank(b) || t(b) - t(a));
    }

    async function newSession(appId) {
        const token = crypto.randomBytes(24).toString("hex");
        await db.collection("applicant_sessions").doc(sha(token)).set({ appId, exp: clock() + SESSION_HOURS * 3600 * 1000, createdAt: clock() });
        return token;
    }
    async function sessionApp(token) {
        if (!/^[a-f0-9]{48}$/.test(String(token || ""))) return null;
        const s = await db.collection("applicant_sessions").doc(sha(token)).get();
        if (!s.exists || (s.data().exp || 0) < clock()) return null;
        const d = await apps().doc(s.data().appId).get();
        return d.exists ? { id: d.id, ref: d.ref || apps().doc(d.id), data: d.data() } : null;
    }
    const fail = (code, message, status) => ({ status: status || 400, json: { ok: false, code, message } });
    const ok = (extra) => ({ status: 200, json: { ok: true, ...(extra || {}) } });
    // first time the applicant sees a sent offer -> HR sees "opened"
    async function markOfferViewed(id, data) {
        if (data.offer && data.offer.status === "SENT" && !data.offer.viewedAt) {
            const at = new Date(clock()).toISOString();
            await apps().doc(id).update({ "offer.viewedAt": at, offerTimeline: FieldValue.arrayUnion(entry(data, "Candidate opened the offer in the status portal", "VIEWED")) });
        }
    }
    const entry = (app, text, kind) => ({ at: new Date(clock()).toISOString(), by: nameOf(app) + " (candidate)", byEmail: app.email || "", kind, text });

    const actions = {
        async login(b) {
            const list = await findApplications(b.identifier);
            const pass = String(b.password || "");
            if (!list.length || !pass) return fail("BAD_LOGIN", "Wrong email / CV ID / mobile or password.", 401);
            for (const a of list) {
                const d = a.data;
                if ((d.portalLockUntil || 0) > clock()) return fail("LOCKED", "Too many wrong attempts. Please try again after 15 minutes or reset your password.", 429);
                if (d.password && sameText(d.password, pass)) {
                    if (String(d.status) === "approved") return fail("STAFF", "You are already part of Minerva staff. Please use Staff Login.", 403);
                    await apps().doc(a.id).update({ portalLoginFails: 0, portalLastLogin: new Date(clock()).toISOString() });
                    await markOfferViewed(a.id, d);
                    return ok({ token: await newSession(a.id), view: viewOf(a.id, d) });
                }
            }
            const a = list[0];
            const fails = (a.data.portalLoginFails || 0) + 1;
            await apps().doc(a.id).update(fails >= MAX_LOGIN_FAILS ? { portalLoginFails: 0, portalLockUntil: clock() + 15 * 60000 } : { portalLoginFails: fails });
            return fail("BAD_LOGIN", "Wrong email / CV ID / mobile or password.", 401);
        },

        async status(b) {
            const a = await sessionApp(b.token);
            if (!a) return fail("SESSION", "Please log in again.", 401);
            await markOfferViewed(a.id, a.data);
            return ok({ view: viewOf(a.id, a.data) });
        },

        async logout(b) {
            if (/^[a-f0-9]{48}$/.test(String(b.token || ""))) await db.collection("applicant_sessions").doc(sha(b.token)).delete().catch(() => {});
            return ok();
        },

        async requestReset(b) {
            const list = (await findApplications(b.identifier)).filter(a => String(a.data.status) !== "approved" && a.data.email);
            const a = list[0];
            if (a) {
                const last = (a.data.resetOtp && a.data.resetOtp.sentAt) || 0;
                if (clock() - last > 60000) {   // at most one code per minute
                    const code = String(crypto.randomInt(100000, 1000000));
                    await apps().doc(a.id).update({ resetOtp: { hash: sha(a.id + ":" + code), exp: clock() + OTP_MINUTES * 60000, tries: 0, sentAt: clock() } });
                    await sendEmail({ type: "APPLICANT_OTP", email: a.data.email, applicantName: nameOf(a.data), code, minutes: OTP_MINUTES });
                }
            }
            // same answer whether or not the account exists (nobody can probe for accounts)
            return ok({ message: "If this account exists, a 6-digit code has been sent to its registered email." });
        },

        async confirmReset(b) {
            const list = (await findApplications(b.identifier)).filter(a => String(a.data.status) !== "approved");
            const a = list.find(x => x.data.resetOtp);
            const newPass = String(b.newPassword || "");
            if (newPass.length < 6) return fail("WEAK", "The new password must have at least 6 characters.");
            if (!a) return fail("BAD_CODE", "Wrong or expired code. Please ask for a new one.");
            const otp = a.data.resetOtp;
            if (otp.exp < clock() || otp.tries >= MAX_OTP_TRIES) {
                await apps().doc(a.id).update({ resetOtp: FieldValue.delete() });
                return fail("BAD_CODE", "This code has expired. Please ask for a new one.");
            }
            if (!sameText(otp.hash, sha(a.id + ":" + clean(b.code, 10)))) {
                await apps().doc(a.id).update({ "resetOtp.tries": (otp.tries || 0) + 1 });
                return fail("BAD_CODE", "Wrong code. Please check the email and try again.");
            }
            await apps().doc(a.id).update({ password: newPass, resetOtp: FieldValue.delete(), portalLoginFails: 0, portalLockUntil: 0, passwordChangedAt: new Date(clock()).toISOString() });
            return ok({ message: "Password changed. You can log in now." });
        },

        async forgotCvId(b) {
            const raw = clean(b.identifier, 120);
            if (raw && !/^(cv)?[-\s]?\d{6}$/i.test(raw)) {
                const a = (await findApplications(raw)).filter(x => x.data.email)[0];
                const last = a && a.data.cvIdReminderAt || 0;
                if (a && clock() - last > 60000) {
                    await apps().doc(a.id).update({ cvIdReminderAt: clock() });
                    await sendEmail({ type: "APPLICANT_CVID_REMINDER", email: a.data.email, applicantName: nameOf(a.data), cvId: a.data.cvId || a.id, portalLink: STATUS_PAGE });
                }
            }
            return ok({ message: "If this email or mobile number is registered, the CV ID has been sent to the registered email." });
        },

        async changePassword(b) {
            const a = await sessionApp(b.token);
            if (!a) return fail("SESSION", "Please log in again.", 401);
            if (!a.data.password || !sameText(a.data.password, String(b.oldPassword || ""))) return fail("BAD_PASSWORD", "The current password is wrong.");
            if (String(b.newPassword || "").length < 6) return fail("WEAK", "The new password must have at least 6 characters.");
            await apps().doc(a.id).update({ password: String(b.newPassword), passwordChangedAt: new Date(clock()).toISOString() });
            return ok({ message: "Password changed." });
        },

        async respondOffer(b) {
            const a = await sessionApp(b.token);
            if (!a) return fail("SESSION", "Please log in again.", 401);
            const o = a.data.offer;
            const kind = String(b.kind || "");
            if (!o || !["SENT", "CHANGE_REQUESTED", "ACCEPTED", "DECLINED"].includes(o.status)) return fail("NO_OFFER", "There is no open offer to respond to.");
            if (!["ACCEPTED", "CHANGE_REQUESTED", "DECLINED"].includes(kind)) return fail("BAD", "Unknown response.");
            if (o.status === "ACCEPTED" && kind === "ACCEPTED") return fail("DONE", "You have already accepted this offer.");
            const comment = clean(b.comment, 1000);
            if (kind !== "ACCEPTED" && !comment) return fail("COMMENT", "Please write a short message for HR.");
            const at = new Date(clock()).toISOString();
            const upd = {
                status: { ACCEPTED: "offer_accepted", CHANGE_REQUESTED: "offer_change", DECLINED: "offer_declined" }[kind],
                "offer.status": kind,
                "offer.response": { kind, comment, at, via: "CANDIDATE" }
            };
            let how = "";
            if (kind === "ACCEPTED") {
                if (b.agree !== true) return fail("AGREE", "Please tick \"I accept the terms of this offer\".");
                const signName = clean(b.signName, 80);
                const img = String(b.signImage || "");
                const copy = clean(b.signedCopyUrl, 600);
                const okImg = /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(img) && img.length < 250000;
                const okCopy = /^https:\/\/firebasestorage\.googleapis\.com\/v0\/b\/shop-portal-bbbbb\./.test(copy);
                if (!okImg && !okCopy) return fail("SIGN", "Please sign on the screen or upload the signed letter.");
                if (okImg) {
                    if (signName.length < 3) return fail("SIGN_NAME", "Please type your full name under the signature.");
                    upd["offer.signature"] = { name: signName, image: img, at };
                    how = "signed on screen";
                }
                if (okCopy) { upd["offer.signedCopyUrl"] = copy; how = how ? how + " + uploaded signed copy" : "uploaded signed copy"; }
            }
            const label = { ACCEPTED: `accepted the offer (${how})`, CHANGE_REQUESTED: "asked for a change", DECLINED: "declined the offer" }[kind];
            upd.offerTimeline = FieldValue.arrayUnion(entry(a.data, `Candidate ${label}${comment ? ': "' + comment + '"' : ""}`, kind));
            upd.history = FieldValue.arrayUnion({ at, actor: nameOf(a.data), actorEmail: a.data.email || "", role: "Candidate", action: `Offer → ${label}`, remarks: comment });
            await apps().doc(a.id).update(upd);
            await sendEmail({ type: "OFFER_RESPONSE", applicantName: nameOf(a.data), cvId: a.data.cvId || a.id, response: kind, comment, joiningDate: o.joiningDate || "", branch: o.branch || "" });
            const fresh = await apps().doc(a.id).get();
            return ok({ view: viewOf(a.id, fresh.data()) });
        }
    };

    return async function handle(body) {
        const b = body || {};
        const fn = actions[b.action];
        if (!fn) return fail("BAD", "Unknown request.");
        try { return await fn(b); }
        catch (e) { console.error("applicantPortal", b.action, e); return fail("ERROR", "Something went wrong. Please try again.", 500); }
    };
}

async function sendEmailViaBot(payload) {
    try {
        await fetch(EMAIL_BOT_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), redirect: "follow" });
    } catch (e) { console.error("Email bot error:", e.message); }
}

module.exports = { createPortal, sendEmailViaBot, viewOf, stageOf };
