import { Router } from "express";
import rateLimit from "express-rate-limit";
import { authenticateJWT } from "../middlewares/auth.middleware";
import {
  registerPatient,
  registerClinic,
  verifyOTP,
  resendOtp,
  login,
  logout,
  logoutAll,
  forgotPassword,
  resetPassword,
} from "../controllers/auth.controller";

const router = Router();

const otpLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please try again later." },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

router.post("/register-patient", authLimiter, registerPatient);
router.post("/register-clinic", authLimiter, registerClinic);
router.post("/verify-otp", otpLimiter, verifyOTP);
router.post("/resend-otp", otpLimiter, resendOtp);
router.post("/login", authLimiter, login);
router.post("/logout", logout); // this device only; no login needed to clear a cookie
router.post("/logout-all", authLimiter, authenticateJWT, logoutAll); // every device
router.post("/forgot-password", otpLimiter, forgotPassword);
router.post("/reset-password", otpLimiter, resetPassword);

export default router;
