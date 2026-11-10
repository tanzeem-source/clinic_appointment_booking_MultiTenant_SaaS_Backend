import { Response } from "express";
import { pool } from "../config/db";
import { env } from "../config/env";
import { AuthenticatedRequest } from "../middlewares/auth.middleware";
import { asyncHandler, AppError } from "../middlewares/error.middleware";
import { InvoiceIdParamSchema } from "../schemas/invoice.schemas";
import {
  streamReceiptPdf,
  formatPlainDate,
  ReceiptData,
  ReceiptStatus,
} from "../services/pdf.service";

// Derived from the payment's own id, so no extra column is needed. Unique and
// stable, but not sequential.
const subscriptionReceiptNumber = (id: string) =>
  `SUB-${id.slice(0, 8).toUpperCase()}`;
const bookingReceiptNumber = (id: string) =>
  `BKG-${id.slice(0, 8).toUpperCase()}`;

const GST_NOTE = "This is a payment receipt. It is not a GST tax invoice.";

// A booking payment gets a receipt once money has actually been taken: paid,
// being refunded, or refunded.
const BOOKING_RECEIPT_STATUSES = ["CONFIRMED", "REFUND_PENDING", "REFUNDED"];

const bookingStatusLabel = (status: string): ReceiptStatus => {
  if (status === "REFUNDED") return "REFUNDED";
  if (status === "REFUND_PENDING") return "REFUND IN PROGRESS";
  return "PAID";
};

// --- Clinic admin: subscription receipts ---

export const listSubscriptionInvoices = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    const tenantId = req.user?.tenantId;
    if (!tenantId)
      throw new AppError("No clinic associated with this account.", 400);

    const result = await pool.query(
      `SELECT id, amount, currency, "paidAt"
     FROM "Payment"
     WHERE "tenantId" = $1 AND purpose = 'SUBSCRIPTION' AND status = 'PAID'
     ORDER BY "paidAt" DESC
     LIMIT 100`,
      [tenantId],
    );

    return res.status(200).json({
      invoices: result.rows.map((r) => ({
        id: r.id,
        receiptNumber: subscriptionReceiptNumber(r.id),
        amountPaise: r.amount,
        currency: r.currency,
        paidAt: r.paidAt,
      })),
    });
  },
);

export const downloadSubscriptionInvoice = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    const tenantId = req.user?.tenantId;
    if (!tenantId)
      throw new AppError("No clinic associated with this account.", 400);

    const { id } = InvoiceIdParamSchema.parse(req.params);

    // Scoped to the clinic in the login token: another clinic's receipt looks
    // like it doesn't exist.
    const result = await pool.query(
      `SELECT p.id, p.amount, p.currency, p."paidAt", p."razorpayOrderId", p."razorpayPaymentId",
            t.name, t.address, t.city, t."contactInfo", t.email
     FROM "Payment" p
     JOIN "Tenant" t ON t.id = p."tenantId"
     WHERE p.id = $1 AND p."tenantId" = $2 AND p.purpose = 'SUBSCRIPTION' AND p.status = 'PAID'`,
      [id, tenantId],
    );
    const row = result.rows[0];
    if (!row) throw new AppError("Receipt not found.", 404);

    const data: ReceiptData = {
      receiptNumber: subscriptionReceiptNumber(row.id),
      status: "PAID",
      issuedAt: row.paidAt,
      billedTo: [
        row.name,
        row.address,
        row.city,
        `Phone: ${row.contactInfo}`,
        `Email: ${row.email}`,
      ].filter(Boolean),
      items: [
        {
          description: "Clinic subscription",
          detail: "Access to the clinic booking platform",
          amountPaise: row.amount,
        },
      ],
      totalPaise: row.amount,
      currency: row.currency,
      references: [
        { label: "Payment ID", value: row.razorpayPaymentId ?? "-" },
        { label: "Order ID", value: row.razorpayOrderId },
        { label: "Payment method", value: "Online (Razorpay)" },
      ],
      note: GST_NOTE,
    };

    streamReceiptPdf(res, data);
  },
);

// --- Patient: booking receipts ---

export const listBookingReceipts = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    const patientId = req.user?.userId;
    if (!patientId) throw new AppError("Not authenticated.", 401);

    // The slot comes from the payment record, not the booking row: if a payment
    // was refunded because its slot went to someone else, the booking row now
    // belongs to the other patient. The "BookingPayment" table has no currency
    // column; every booking payment is created in INR.
    const result = await pool.query(
      `SELECT bp.id, bp.amount, 'INR' AS currency, bp.status, bp."paidAt", bp."refundedAt",
            bp.date, bp."startTime", d.name AS "doctorName", t.name AS "clinicName"
     FROM "BookingPayment" bp
     JOIN "Doctor" d ON d.id = bp."doctorId"
     JOIN "Tenant" t ON t.id = d."tenantId"
     WHERE bp."patientId" = $1
       AND bp.status = ANY($2::text[])
       AND bp."razorpayPaymentId" IS NOT NULL
       AND bp."paidAt" IS NOT NULL
     ORDER BY bp."paidAt" DESC
     LIMIT 100`,
      [patientId, BOOKING_RECEIPT_STATUSES],
    );

    return res.status(200).json({
      receipts: result.rows.map((r) => ({
        id: r.id,
        receiptNumber: bookingReceiptNumber(r.id),
        status: bookingStatusLabel(r.status),
        amountPaise: r.amount,
        currency: r.currency,
        paidAt: r.paidAt,
        refundedAt: r.refundedAt,
        doctorName: r.doctorName,
        clinicName: r.clinicName,
        date: r.date,
        startTime: String(r.startTime).slice(0, 5),
      })),
    });
  },
);

export const downloadBookingReceipt = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    const patientId = req.user?.userId;
    if (!patientId) throw new AppError("Not authenticated.", 401);

    const { id } = InvoiceIdParamSchema.parse(req.params);

    // Scoped to the logged-in patient: someone else's receipt looks like it
    // doesn't exist.
    const result = await pool.query(
      `SELECT bp.id, bp.amount, 'INR' AS currency, bp.status, bp."paidAt", bp."refundedAt", bp."refundId",
            bp."razorpayOrderId", bp."razorpayPaymentId", bp.date, bp."startTime",
            d.name AS "doctorName", t.name AS "clinicName",
            u.name AS "patientName", u.email AS "patientEmail", u.phone AS "patientPhone"
     FROM "BookingPayment" bp
     JOIN "Doctor" d ON d.id = bp."doctorId"
     JOIN "Tenant" t ON t.id = d."tenantId"
     JOIN "User" u ON u.id = bp."patientId"
     WHERE bp.id = $1
       AND bp."patientId" = $2
       AND bp.status = ANY($3::text[])
       AND bp."razorpayPaymentId" IS NOT NULL
       AND bp."paidAt" IS NOT NULL`,
      [id, patientId, BOOKING_RECEIPT_STATUSES],
    );
    const row = result.rows[0];
    if (!row) throw new AppError("Receipt not found.", 404);

    const time = String(row.startTime).slice(0, 5);

    const references = [
      { label: "Payment ID", value: row.razorpayPaymentId },
      { label: "Order ID", value: row.razorpayOrderId },
      { label: "Payment method", value: "Online (Razorpay)" },
    ];
    if (row.refundId)
      references.push({ label: "Refund ID", value: row.refundId });
    if (row.refundedAt) {
      references.push({
        label: "Refunded on",
        value: new Date(row.refundedAt).toLocaleString("en-IN", {
          timeZone: "Asia/Kolkata",
          day: "2-digit",
          month: "short",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          hour12: true,
        }),
      });
    }

    const data: ReceiptData = {
      receiptNumber: bookingReceiptNumber(row.id),
      status: bookingStatusLabel(row.status),
      issuedAt: row.paidAt,
      billedTo: [
        row.patientName,
        `Email: ${row.patientEmail}`,
        row.patientPhone ? `Phone: ${row.patientPhone}` : "",
      ].filter(Boolean),
      items: [
        {
          description: `Consultation with ${row.doctorName}`,
          detail: `${row.clinicName}, ${formatPlainDate(row.date)} at ${time}`,
          amountPaise: row.amount,
        },
      ],
      totalPaise: row.amount,
      currency: row.currency,
      references,
      note: `Payment collected by ${env.PLATFORM_NAME} on behalf of ${row.clinicName}. ${GST_NOTE}`,
    };

    streamReceiptPdf(res, data);
  },
);
