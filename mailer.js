import Mailjet from "node-mailjet";

const mailjet = Mailjet.apiConnect(
  process.env.MJ_APIKEY_PUBLIC,
  process.env.MJ_APIKEY_PRIVATE
);

const FROM_EMAIL = process.env.MAIL_FROM_EMAIL || "dheerajthalor2021@gmail.com";
const FROM_NAME = process.env.MAIL_FROM_NAME || "Civic Complaint System";
const FRONTEND_URL = (process.env.FRONTEND_URL || process.env.CORS_ORIGIN || "https://civic-help-proj.vercel.app").replace(/\/+$/, "");

function getTrackUrl(complaintId) {
  return `${FRONTEND_URL}/track?q=${encodeURIComponent(complaintId)}`;
}

async function sendEmail(toEmail, toName, subject, textPart, htmlPart) {
  if (!process.env.MJ_APIKEY_PUBLIC || !process.env.MJ_APIKEY_PRIVATE) {
    console.log("[Mail] Mailjet not configured — skipping");
    return false;
  }
  try {
    await mailjet.post("send", { version: "v3.1" }).request({
      Messages: [
        {
          From: { Email: FROM_EMAIL, Name: FROM_NAME },
          To: [{ Email: toEmail, Name: toName || toEmail }],
          Subject: subject,
          TextPart: textPart,
          HTMLPart: htmlPart,
        },
      ],
    });
    return true;
  } catch (err) {
    console.error("[Mail] Send failed:", err.message);
    return false;
  }
}

/**
 * Report received — when user submits a complaint
 */
export async function sendReportReceivedEmail(complaint) {
  const trackUrl = getTrackUrl(complaint.id);
  const subject = `Complaint Received — ${complaint.id}`;
  const textPart = `Your report has been received and will be checked by the authority promptly.\n\nComplaint ID: ${complaint.id}\n\nTrack your complaint: ${trackUrl}`;
  const htmlPart = `
    <p>Your report has been received and will be checked by the authority promptly.</p>
    <p><strong>Complaint ID: ${complaint.id}</strong></p>
    <p><a href="${trackUrl}">Track your complaint</a></p>
  `;
  return sendEmail(complaint.email, complaint.name, subject, textPart, htmlPart);
}

/**
 * In Progress — when authority marks as in progress
 */
export async function sendInProgressEmail(complaint) {
  const trackUrl = getTrackUrl(complaint.id);
  const subject = `Complaint In Progress — ${complaint.id}`;
  const textPart = `Your report is being verified and our team will reach your location within WORKING DAYS.\n\nTrack your complaint: ${trackUrl}`;
  const htmlPart = `
    <p>Your report is being verified and our team will reach your location within 2-3 days.</p>
    <p><a href="${trackUrl}">Track your complaint</a></p>
  `;
  return sendEmail(complaint.email, complaint.name, subject, textPart, htmlPart);
}

/**
 * Rejected — when authority marks as fake
 */
export async function sendRejectedEmail(complaint) {
  const subject = `Report Verified False — ${complaint.id}`;
  const textPart = `Your report has been verified as false and no action will be taken on that.\n\nWe do not encourage false reporting as it may waste resources. Further false reporting can lead to official complaint.`;
  const htmlPart = `
    <p>Your report has been verified as false and no action will be taken on that.</p>
    <p>We do not encourage false reporting as it may waste resources. Further false reporting can lead to official complaint.</p>
  `;
  return sendEmail(complaint.email, complaint.name, subject, textPart, htmlPart);
}

/**
 * Resolved — when authority marks as resolved with proof link
 */
export async function sendResolvedEmail(complaint) {
  const trackUrl = getTrackUrl(complaint.id);
  const proofLink = complaint.proof ? `<p><a href="${complaint.proof}">View proof</a></p>` : "";
  const subject = `Issue Resolved — ${complaint.id}`;
  const textPart = `Your issue has been solved.${complaint.proof ? ` For proofs visit: ${complaint.proof}` : ""}\n\nTrack your complaint: ${trackUrl}`;
  const htmlPart = `
    <p>Your issue has been solved.</p>
    ${proofLink}
    <p><a href="${trackUrl}">View on website</a></p>
  `;
  return sendEmail(complaint.email, complaint.name, subject, textPart, htmlPart);
}
