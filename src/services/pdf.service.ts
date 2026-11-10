import PDFDocument from "pdfkit";
import { Response } from "express";
import { env } from "../config/env";

export type ReceiptStatus = "PAID" | "REFUND IN PROGRESS" | "REFUNDED";

export interface ReceiptData {
  receiptNumber: string;
  status: ReceiptStatus;
  issuedAt: Date | string;
  billedTo: string[]; // first line is the name
  items: Array<{ description: string; detail?: string; amountPaise: number }>;
  totalPaise: number;
  currency: string;
  references: Array<{ label: string; value: string }>;
  note: string;
}

const STATUS_COLOURS: Record<ReceiptStatus, string> = {
  PAID: "#1a7f37",
  "REFUND IN PROGRESS": "#b26a00",
  REFUNDED: "#555555",
};

// The built-in PDF fonts can't draw the rupee sign, so amounts are written as
// "INR 300.00". Names in non-Latin scripts (Devanagari, Bengali) also won't
// render with these fonts; that would need a bundled font such as Noto Sans.
export const formatMoney = (paise: number, currency: string): string =>
  `${currency} ${(paise / 100).toFixed(2)}`;

// Always India time, so a receipt looks the same wherever the server runs.
export const formatDateTimeIST = (d: Date | string): string =>
  new Date(d).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });

// "YYYY-MM-DD" to "Mon, 09 Nov 2026" with no timezone shifting.
export const formatPlainDate = (dateStr: string): string => {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-IN", {
    timeZone: "UTC",
    weekday: "short",
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
};

// Streams a one-page receipt straight to the response. Call it only after
// every check that might fail (lookups, permissions), because once the PDF
// starts streaming the status code can't be changed.
export const streamReceiptPdf = (res: Response, data: ReceiptData): void => {
  const doc = new PDFDocument({
    size: "A4",
    margin: 50,
    info: {
      Title: `Payment Receipt ${data.receiptNumber}`,
      Author: env.PLATFORM_NAME,
    },
  });

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${data.receiptNumber}.pdf"`,
  );
  res.setHeader("Cache-Control", "private, no-store");
  doc.pipe(res);

  const left = 50;
  const right = 545;
  const width = right - left;
  const amountX = 395; // item descriptions sit left of this, amounts right-aligned from here
  const amountWidth = right - amountX;
  const descWidth = amountX - left - 10;

  const rule = () => {
    doc
      .moveTo(left, doc.y)
      .lineTo(right, doc.y)
      .lineWidth(0.5)
      .strokeColor("#cccccc")
      .stroke();
    doc.moveDown(0.6);
  };

  // A label on the left and a bold value beside it.
  const field = (label: string, value: string, valueColour = "#000000") => {
    const y = doc.y;
    doc
      .font("Helvetica")
      .fontSize(10)
      .fillColor("#555555")
      .text(label, left, y, { width: 130 });
    const labelBottom = doc.y;
    doc
      .font("Helvetica-Bold")
      .fillColor(valueColour)
      .text(value, left + 140, y, { width: width - 140 });
    doc.y = Math.max(labelBottom, doc.y) + 3;
  };

  // Header
  doc
    .font("Helvetica-Bold")
    .fontSize(18)
    .fillColor("#000000")
    .text(env.PLATFORM_NAME, left, 50, { width });
  if (env.PLATFORM_ADDRESS) {
    doc
      .font("Helvetica")
      .fontSize(9)
      .fillColor("#555555")
      .text(env.PLATFORM_ADDRESS, left, doc.y, { width });
  }
  doc.moveDown(1.2);
  rule();

  doc
    .font("Helvetica-Bold")
    .fontSize(14)
    .fillColor("#000000")
    .text("PAYMENT RECEIPT", left, doc.y, { width });
  doc.moveDown(0.5);

  field("Receipt no.", data.receiptNumber);
  field("Date", `${formatDateTimeIST(data.issuedAt)} (IST)`);
  field("Status", data.status, STATUS_COLOURS[data.status]);
  doc.moveDown(0.6);
  rule();

  // Billed to
  doc
    .font("Helvetica-Bold")
    .fontSize(9)
    .fillColor("#555555")
    .text("BILLED TO", left, doc.y, { width });
  doc.moveDown(0.3);
  data.billedTo.forEach((line, i) => {
    doc
      .font(i === 0 ? "Helvetica-Bold" : "Helvetica")
      .fontSize(10)
      .fillColor("#000000")
      .text(line, left, doc.y, { width });
  });
  doc.moveDown(0.8);
  rule();

  // Items
  const headerY = doc.y;
  doc
    .font("Helvetica-Bold")
    .fontSize(9)
    .fillColor("#555555")
    .text("DESCRIPTION", left, headerY, { width: descWidth });
  doc.text("AMOUNT", amountX, headerY, { width: amountWidth, align: "right" });
  doc.y = headerY + 18;

  for (const item of data.items) {
    const y = doc.y;
    doc
      .font("Helvetica-Bold")
      .fontSize(10)
      .fillColor("#000000")
      .text(item.description, left, y, { width: descWidth });
    if (item.detail) {
      doc
        .font("Helvetica")
        .fontSize(9)
        .fillColor("#555555")
        .text(item.detail, left, doc.y, { width: descWidth });
    }
    const descBottom = doc.y;
    doc
      .font("Helvetica")
      .fontSize(10)
      .fillColor("#000000")
      .text(formatMoney(item.amountPaise, data.currency), amountX, y, {
        width: amountWidth,
        align: "right",
      });
    doc.y = Math.max(descBottom, doc.y) + 6;
  }
  rule();

  const totalY = doc.y;
  doc
    .font("Helvetica-Bold")
    .fontSize(11)
    .fillColor("#000000")
    .text("Total", left, totalY, { width: descWidth });
  doc.text(formatMoney(data.totalPaise, data.currency), amountX, totalY, {
    width: amountWidth,
    align: "right",
  });
  doc.y = totalY + 26;

  // Payment details
  rule();
  doc
    .font("Helvetica-Bold")
    .fontSize(9)
    .fillColor("#555555")
    .text("PAYMENT DETAILS", left, doc.y, { width });
  doc.moveDown(0.3);
  data.references.forEach((r) => field(r.label, r.value));

  doc.moveDown(1.5);
  doc
    .font("Helvetica")
    .fontSize(8)
    .fillColor("#555555")
    .text(data.note, left, doc.y, { width });

  doc.end();
};
