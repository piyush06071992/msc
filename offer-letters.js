// ============================================================================
// MINERVA — OFFER LETTERS (shared by staff-pending.html and the applicant portal)
// ----------------------------------------------------------------------------
// Admin writes offer letter templates in the portal (Recruitment → 📝 Offer Settings).
// A template is plain text with blanks like {{name}}; the system fills them in.
//   {{name}} {{cvId}} {{post}} {{branch}} {{monthlySalary}} {{annualPackage}}
//   {{joiningDate}} {{date}} {{breakupTable}}
// Salary: admin enters the MONTHLY salary; annual package = monthly × 12.
// Breakup: admin sets parts in % (e.g. Basic 50, HRA 20, Allowance 30); amounts are
// calculated from the monthly salary (rounded to rupees; the last part takes the
// rounding difference so the parts always add up to the monthly salary).
// ============================================================================
(function (global) {
    "use strict";

    const PLACEHOLDERS = [
        ["name", "Candidate name"], ["cvId", "CV ID"], ["post", "Post / designation"], ["branch", "Branch"],
        ["monthlySalary", "Monthly salary (₹)"], ["annualPackage", "Annual package (₹)"],
        ["joiningDate", "Date of joining"], ["date", "Today's date"], ["breakupTable", "Salary breakup table"]
    ];

    const DEFAULT_TEMPLATE = {
        id: "tpl_default",
        name: "Standard Offer Letter",
        body:
`Date: {{date}}

To,
{{name}}
Application / CV ID: {{cvId}}

Subject: Offer of Appointment – {{post}}

Dear {{name}},

We are pleased to offer you the position of {{post}} at Minerva Study Circle, {{branch}}.

Your monthly salary will be ₹ {{monthlySalary}} (annual package ₹ {{annualPackage}}), as per the breakup below:

{{breakupTable}}

Your date of joining will be {{joiningDate}}. Please bring your original certificates and a government ID on the day of joining.

This offer is subject to verification of your documents and the rules of the institute. Please confirm your acceptance by signing this letter.

We look forward to having you with us.

For Minerva Study Circle

Authorised Signatory`
    };

    const DEFAULT_BREAKUP = [
        { name: "Basic Salary", percent: 50 },
        { name: "House Rent Allowance", percent: 20 },
        { name: "Special Allowance", percent: 30 }
    ];

    function esc(v) {
        return String(v === undefined || v === null ? "" : v)
            .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    }

    // 1234567 -> "12,34,567" (Indian grouping)
    function formatINR(n) {
        const num = Math.round(Number(n) || 0);
        return num.toLocaleString("en-IN");
    }

    function annualFromMonthly(monthly) { return Math.round(Number(monthly) || 0) * 12; }

    // [{name, percent}] + monthly -> [{name, percent, amount}] (amounts add up to the monthly salary)
    function calcBreakup(monthly, parts) {
        const m = Math.round(Number(monthly) || 0);
        const list = (parts || []).filter(p => p && p.name && Number(p.percent) > 0);
        let used = 0;
        return list.map((p, i) => {
            let amount = Math.round(m * Number(p.percent) / 100);
            if (i === list.length - 1) amount = m - used;   // last part takes the rounding difference
            used += amount;
            return { name: String(p.name), percent: Number(p.percent), amount };
        });
    }
    function breakupTotalPercent(parts) {
        return Math.round((parts || []).reduce((a, p) => a + (Number(p.percent) || 0), 0) * 100) / 100;
    }

    function prettyDate(iso) {
        if (!iso) return "—";
        const d = new Date(String(iso).slice(0, 10) + "T12:00:00");
        if (isNaN(d)) return esc(iso);
        return d.toLocaleDateString("en-GB", { day: "2-digit", month: "long", year: "numeric" });
    }

    function breakupTableHtml(breakup, monthly) {
        if (!breakup || !breakup.length) return "";
        const rows = breakup.map(b =>
            `<tr><td style="padding:6px 10px;border:1px solid #cbd5e1;">${esc(b.name)}</td>` +
            `<td style="padding:6px 10px;border:1px solid #cbd5e1;text-align:right;">${esc(b.percent)}%</td>` +
            `<td style="padding:6px 10px;border:1px solid #cbd5e1;text-align:right;">₹ ${formatINR(b.amount)}</td></tr>`).join("");
        return `<table style="border-collapse:collapse;margin:6px 0;font-size:13px;min-width:320px;">` +
            `<tr style="background:#f1f5f9;"><th style="padding:6px 10px;border:1px solid #cbd5e1;text-align:left;">Component</th><th style="padding:6px 10px;border:1px solid #cbd5e1;">%</th><th style="padding:6px 10px;border:1px solid #cbd5e1;text-align:right;">Monthly</th></tr>` +
            rows +
            `<tr style="font-weight:bold;"><td style="padding:6px 10px;border:1px solid #cbd5e1;">Total (monthly)</td><td style="padding:6px 10px;border:1px solid #cbd5e1;text-align:right;">100%</td><td style="padding:6px 10px;border:1px solid #cbd5e1;text-align:right;">₹ ${formatINR(monthly)}</td></tr></table>`;
    }

    // offer: {name, cvId, post, branch, monthlySalary, joiningDate, breakup, showBreakup}
    // Returns HTML for the letter body (text is escaped; blank lines become paragraphs).
    function renderLetterHtml(templateBody, offer) {
        const o = offer || {};
        const monthly = Math.round(Number(o.monthlySalary) || 0);
        const values = {
            name: esc(o.name || ""), cvId: esc(o.cvId || ""), post: esc(o.post || ""), branch: esc(o.branch || ""),
            monthlySalary: formatINR(monthly), annualPackage: formatINR(annualFromMonthly(monthly)),
            joiningDate: prettyDate(o.joiningDate), date: prettyDate(o.letterDate || new Date().toISOString().slice(0, 10)),
            breakupTable: o.showBreakup === false ? "" : breakupTableHtml(o.breakup || [], monthly)
        };
        const TABLE_MARK = "\u0000BREAKUP\u0000";
        let text = String(templateBody || DEFAULT_TEMPLATE.body).replace(/\{\{\s*breakupTable\s*\}\}/g, TABLE_MARK);
        text = esc(text).replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => Object.prototype.hasOwnProperty.call(values, k) ? values[k] : m);
        const html = text.split(/\n{2,}/).map(par => {
            if (par.trim() === TABLE_MARK) return values.breakupTable;
            return `<p style="margin:0 0 12px;">${par.replace(TABLE_MARK, values.breakupTable).replace(/\n/g, "<br>")}</p>`;
        }).join("");
        return html;
    }

    // Full printable page (A4) with letterhead
    function renderLetterPage(templateBody, offer, opts) {
        const o = opts || {};
        const head = esc(o.schoolTitle || "MINERVA STUDY CIRCLE");
        const sub = esc(o.schoolSub || "");
        return `<div style="font-family:Georgia,'Times New Roman',serif;color:#0f172a;width:210mm;box-sizing:border-box;padding:14mm 18mm;font-size:13.5px;line-height:1.55;background:#fff;">
            <div style="text-align:center;border-bottom:2px solid #1e1b4b;padding-bottom:8px;margin-bottom:18px;">
                <div style="font-size:20px;font-weight:bold;letter-spacing:1px;color:#1e1b4b;">${head}</div>
                ${sub ? `<div style="font-size:11px;color:#475569;">${sub}</div>` : ""}
            </div>
            ${renderLetterHtml(templateBody, offer)}
            ${o.signatureHtml || ""}
        </div>`;
    }

    global.MinervaOffer = {
        PLACEHOLDERS, DEFAULT_TEMPLATE, DEFAULT_BREAKUP,
        esc, formatINR, annualFromMonthly, calcBreakup, breakupTotalPercent, prettyDate,
        breakupTableHtml, renderLetterHtml, renderLetterPage,
        VERSION: 1
    };
})(typeof window !== "undefined" ? window : globalThis);
