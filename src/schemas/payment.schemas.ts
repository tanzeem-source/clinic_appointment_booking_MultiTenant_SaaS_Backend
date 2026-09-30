import { z } from 'zod';

// Field names match what Razorpay Checkout hands back to the browser.
export const VerifyPaymentSchema = z.object({
  razorpay_order_id: z.string().min(1),
  razorpay_payment_id: z.string().min(1),
  razorpay_signature: z.string().min(1)
});