import express, { Request, Response } from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import { env } from "./config/env";
import authRoutes from "./routes/auth.route";
import clinicRoutes from "./routes/clinic.route";
import paymentRoutes from "./routes/payment.route";
import devRoutes from "./dev/dev.route";
import { handleWebhook } from "./controllers/payment.controller";
import { errorHandler, notFoundHandler } from "./middlewares/error.middleware";

const app = express();

// Dev-only test page. Mounted BEFORE helmet on purpose: helmet's default
// Content-Security-Policy would block Razorpay's checkout script.
if (env.NODE_ENV !== "production") {
  app.use("/dev", devRoutes);
}

app.use(helmet());
app.use(cors({ origin: env.CLIENT_ORIGIN, credentials: true })); // credentials: true is required for the browser to send/accept the auth cookie cross-origin
app.use(cookieParser());

// Razorpay signs the exact bytes it sends, so the webhook needs the raw
// body. This MUST be registered before express.json(), which would parse
// (and thereby alter) it.
app.post(
  "/api/payments/webhook",
  express.raw({ type: "application/json" }),
  handleWebhook,
);

app.use(express.json());

app.get("/health", (req: Request, res: Response) => {
  res.status(200).json({ status: "OK", message: "Backend is up and running!" });
});

app.use("/api/auth", authRoutes);
app.use("/api/clinics", clinicRoutes);
app.use("/api/payments", paymentRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

app.listen(env.PORT, () => {
  console.log(`⚡️[server]: Server is running at http://localhost:${env.PORT}`);
});
